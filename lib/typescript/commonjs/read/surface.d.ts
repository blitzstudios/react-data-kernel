/**
 * Reads: how a store turns a read definition into a hook ({@linkcode Read.useValue | useValue}) and a getter
 * ({@linkcode Read.getValue | getValue}).
 *
 * A read names a partition with its args (a partition is the set of rows one fetch returns and replaces), fetches the
 * partition if it has never been fetched, and runs the read's {@linkcode ReadDef.select | select} over the partition's
 * rows to compute its value. A read caches nothing itself: {@linkcode ReadDef.select | select} returns values from the
 * store's caches (declared in {@linkcode Partitions.defineCaches | defineCaches}), the hook runs it again only when
 * something it read changes, and re-renders its component only when the new value differs.
 */
import { VaryValue } from '../args_key';
import { PartitionField, VaryField } from './partition_fields';
import { shallowEqualValue } from '../caches';
import { VersionAtom } from '../reactivity/version_atom';
import { type PrimeState } from '../prime_state';
import { DataResult, DataStatus } from '../store_result';
import type { PartitionLifecycle, Partitions, definePartitions } from '../define_partitions';
import type { pairRead } from './facade';
import type { shallowEqualStruct } from '../caches';
import type { byEntity } from './derived_values';
import type { StoreSurface } from '../define_sqlite_store';
/**
 * The parts of a store's fetch ingest that its reads use: the hooks that fetch partitions, and imperative fetch starts.
 */
export interface FetchOwner<Key> {
    /** A hook that fetches one partition if it isn't fresh, and returns the fetch's state. */
    usePrime: (key: Key | undefined, enabled: boolean, opts?: {
        slice?: boolean;
    }) => PrimeState;
    /** A hook that fetches each of several partitions that isn't fresh, and returns their combined state. */
    usePrimeMany: (keys: readonly Key[], enabled: boolean, opts?: {
        slice?: boolean;
    }) => PrimeState;
    /**
     * Starts fetching a partition, outside a component; used by {@linkcode Read.getValue | getValue} for a partition that
     * has never been fetched.
     */
    ensure: (key: Key) => void;
    /** Fetches a partition again now, however recently it was fetched. */
    refetch: (key: Key) => void;
}
/**
 * What a store's reads need from the store: its version atom, how a partition key becomes its version key, whether a
 * partition has rows or has been fetched, and the fetch ingest. {@linkcode definePartitions} builds this for each
 * store.
 */
export interface ReadSurfaceKernel<Key> {
    /** The store's version atom: the per-partition and per-entity version numbers reads depend on and re-render from. */
    version: VersionAtom;
    /** The store's name, used in the dev warning about a screen making too many separate reads. */
    name?: string;
    /** A partition key's parts: its values as a list of strings, which identify the partition in the version atom. */
    toParts: (key: Key) => readonly string[];
    /**
     * Whether a partition holds any rows. A read runs its {@linkcode ReadDef.select | select} only when the partition has
     * rows.
     */
    has: (key: Key) => boolean;
    /**
     * Whether a partition has been written by a fetch this session. Having rows doesn't answer that: a socket push can
     * write a row into a partition that was never fetched, and that partition still needs fetching.
     */
    hasFetched?: (key: Key) => boolean;
    /**
     * How a read that declares no {@linkcode ReadDef.partition | partition} gets its partition from its args: the store's
     * key fields, or a function for a store whose key is computed from the args.
     */
    defaultPartition?: readonly string[] | ((args: never) => Key);
    /**
     * The store's fetch ingest. A store fed only by pushes has none, and its reads report `success` even with no rows.
     */
    ingest?: FetchOwner<Key>;
}
/**
 * A read's {@linkcode CommonDef.varyBy | varyBy}: the args, beyond the partition, that its value depends on. Either a
 * list of args field names, such as `['playerId']`, or a function that computes the values from the args.
 */
export type VarySpec<Args> = readonly VaryField<Args>[] | ((args: Args) => readonly VaryValue[]);
/**
 * The args a read's {@linkcode ReadDef.select | select} receives: only the fields its
 * {@linkcode CommonDef.varyBy | varyBy} lists, each typed as non-null, since {@linkcode ReadDef.select | select} only
 * runs once all of them have values. Reading any other arg in {@linkcode ReadDef.select | select} is a type error,
 * because a hook runs {@linkcode ReadDef.select | select} again only when its partition or its
 * {@linkcode CommonDef.varyBy | varyBy} values change; a value computed from an unlisted arg would go stale when that
 * arg changed. A read whose {@linkcode CommonDef.varyBy | varyBy} is a function lists no fields, so its
 * {@linkcode ReadDef.select | select} receives the whole args.
 */
export type SelectArgs<Args, V> = V extends readonly (keyof Args)[] ? {
    [K in V[number]]: NonNullable<Args[K & keyof Args]>;
} : Args;
/**
 * The fields every kind of read definition shares ({@linkcode Partitions.defineRead | defineRead},
 * {@linkcode Partitions.defineReadMany | defineReadMany} and
 * {@linkcode Partitions.defineReadGrouped | defineReadGrouped}).
 */
export interface CommonDef<Args, T, V extends VarySpec<Args>> {
    /**
     * Turns the read off for some args: while it returns false, the read returns {@linkcode CommonDef.empty | empty} and
     * doesn't run {@linkcode ReadDef.select | select}. For args that name something that can't exist, such as a
     * placeholder id. It doesn't stop the fetch; use {@linkcode CommonDef.prime | prime} or the caller's
     * {@linkcode CommonDef.enabled | enabled} option for that.
     */
    enabled?: (args: Args) => boolean;
    /**
     * The args, beyond the ones that name the partition, that the read's value depends on, such as `['playerId']` for a
     * read of one player out of a league's partition. Either a list of args field names, or a function computing values
     * from the args.
     *
     * These values, with the partition, are what a hook runs {@linkcode ReadDef.select | select} again for when they
     * change. So list every arg {@linkcode ReadDef.select | select} uses; {@linkcode ReadDef.select | select} can only see
     * the listed ones (a type error otherwise). While any of them is
     * missing (`undefined`, `null`, `''` or an empty array; `0` and `false` count as values), the read returns
     * {@linkcode CommonDef.empty | empty} without running {@linkcode ReadDef.select | select}, but still fetches the
     * partition, so the rows are there when the value arrives. Arrays and objects are compared by content, so a caller
     * that rebuilds one each render doesn't run {@linkcode ReadDef.select | select} again.
     */
    varyBy?: V;
    /**
     * The args fields a caller must have before the read runs, for a read whose partition or
     * {@linkcode CommonDef.varyBy | varyBy} is a function (a field list is read off automatically). It becomes the read's
     * {@linkcode Read.requires}, which {@linkcode pairRead} needs to publish the read: the published hook and getter
     * return {@linkcode CommonDef.empty | empty} until every one of these fields has a value.
     */
    requires?: readonly string[];
    /**
     * What the read returns when it has no value: while its partition has no rows yet, while it is disabled, and while
     * its args are missing a value. Use a constant (such as a frozen empty array), not a new object each time, since
     * returning a different object would re-render the caller.
     */
    empty: T;
    /**
     * Compares the read's previous value with a newly computed one. When they're equal, the read keeps returning the
     * previous object, so callers don't re-render. Defaults to {@linkcode shallowEqualValue}, which compares arrays by
     * their elements and plain objects by their values, one level deep; pass one built with
     * {@linkcode shallowEqualStruct} when equality depends on a level deeper.
     */
    isEqual?: (left: T, right: T) => boolean;
    /**
     * Whether reading a partition that has never been fetched fetches it; true by default. Set false for a read that
     * should only use rows something else fetched, such as one that looks in partitions a value might be in without
     * wanting to fetch them all.
     *
     * A fetch loads the whole partition, not just what the read selects, so a read of one row in a large partition pays
     * for all of it. A partition fetch large enough to matter is reported once per session (as an info notice).
     */
    prime?: boolean;
}
/**
 * The definition of a read of one partition. The args name one partition (through
 * {@linkcode ReadDef.partition | partition}, or the store's key fields by default); the read fetches it if it has never
 * been fetched, and {@linkcode ReadDef.select | select} computes the value from its rows. Nearly every read is this
 * kind. For a read across several partitions, use {@linkcode ReadManyDef}; for several lookups at once, each with its
 * own candidate partitions, use {@linkcode ReadGroupedDef}.
 */
export interface ReadDef<Args, Key, T, V extends VarySpec<Args> = readonly []> extends CommonDef<Args, T, V> {
    /**
     * How the args name the partition to read: a list of args field names (each holding a string) that make its key,
     * such as `['sport', 'season', 'week']`, or a function returning the key. Defaults to the store's key fields. While a
     * listed field is missing, the read reads and fetches nothing.
     */
    partition?: readonly PartitionField<Args>[] | ((args: Args) => Key);
    /**
     * Computes the read's value from the partition's rows. `args` holds only the fields listed in
     * {@linkcode CommonDef.varyBy | varyBy}, and `key` is the partition's key. It runs only when the partition has rows
     * and every {@linkcode CommonDef.varyBy | varyBy} value is present; otherwise the read returns
     * {@linkcode CommonDef.empty | empty}.
     *
     * The read doesn't cache the result: a hook runs {@linkcode ReadDef.select | select} again when something it read
     * changes, and {@linkcode Read.getValue | getValue} runs it on every call. So it should return values from the
     * store's caches, and build anything expensive inside one. If it reads through a {@linkcode byEntity} cache, it
     * depends on just the entities (such as the players) it read, and a write to other entities doesn't re-run it. If it
     * reads the table directly, it depends on the whole partition and runs again after any write to it.
     */
    select: (args: SelectArgs<Args, V>, key: Key) => T;
}
/**
 * The definition of a read across several partitions, fetched and subscribed to together and computed into one value,
 * such as one player's stat rows across several weeks, one partition per week. {@linkcode ReadManyDef.select | select}
 * gets the partition keys as one flat list. For several lookups at once, each with its own candidate partitions, use
 * {@linkcode ReadGroupedDef}.
 */
export interface ReadManyDef<Args, Key, T, V extends VarySpec<Args> = readonly []> extends CommonDef<Args, T, V> {
    /**
     * The keys of the partitions the args name. Every one is fetched if it has never been fetched, and the read
     * re-renders when any of them changes. A key that names no partition (from a missing value) keeps its place in the
     * list, so positions line up with the caller's list.
     */
    partitions: (args: Args) => readonly Key[];
    /**
     * Computes the read's value from the partitions' rows, given their keys in the order
     * {@linkcode ReadManyDef.partitions | partitions} returned them. `args` holds only the fields listed in
     * {@linkcode CommonDef.varyBy | varyBy}. Runs once at least one of the partitions has rows.
     */
    select: (args: SelectArgs<Args, V>, keys: readonly Key[]) => T;
}
/**
 * The definition of a read that answers several lookups at once, where each lookup's rows could be in any of several
 * candidate partitions, such as a stat row for each of several stat keys, where each key could be in more than one
 * partition. {@linkcode ReadGroupedDef.groups | groups} gives each lookup's candidate partitions; all of them are
 * fetched and subscribed to; {@linkcode ReadGroupedDef.select | select} gets the groups back in the same order, so it
 * can answer each lookup from its own candidates.
 */
export interface ReadGroupedDef<Args, Key, T, V extends VarySpec<Args> = readonly []> extends CommonDef<Args, T, V> {
    /**
     * The candidate partitions for each lookup, one group per lookup. Every partition in every group is fetched if it has
     * never been fetched, and the read re-renders when any of them changes.
     */
    groups: (args: Args) => readonly (readonly Key[])[];
    /**
     * Computes the read's value, given the groups of partition keys in the order `groups` returned them. `args` holds
     * only the fields listed in {@linkcode CommonDef.varyBy | varyBy}. Runs once at least one of the partitions has rows.
     */
    select: (args: SelectArgs<Args, V>, groups: readonly (readonly Key[])[]) => T;
}
/**
 * Options one caller passes to a read's {@linkcode Read.useValue | useValue} hook, on top of what the read's definition
 * fixes. They apply to that call only.
 */
export interface ReadCallOptions {
    /**
     * Set false to turn this call off: it returns {@linkcode CommonDef.empty | empty}, fetches nothing, and doesn't
     * subscribe, while the hook stays in place among the component's hooks. True by default. For a component holding args
     * it shouldn't read with yet.
     */
    enabled?: boolean;
    /**
     * Set false to read without fetching, for a component whose parent already fetches the partition. The read still
     * subscribes, and re-renders when the parent's fetch writes the rows.
     *
     * A fetch loads the whole partition, which can be far larger than what one read selects: a read of one player fetches
     * that player's whole league, since `/players/{sport}` is the only endpoint. A list of fifty such reads, each
     * fetching, would be fifty calls for one league. Only `false` is accepted: a caller can decline to fetch, but can't
     * make a read fetch when its definition says `prime: false`.
     */
    prime?: false;
}
/**
 * A declared read, as a store's {@linkcode StoreSurface.reads | reads} hold it: a hook
 * ({@linkcode Read.useValue | useValue}) and a getter ({@linkcode Read.getValue | getValue}) that return the same
 * value. Both take the read's args, or `undefined` when the caller doesn't have them yet, which returns
 * {@linkcode CommonDef.empty | empty}.
 */
export interface Read<Args, T> {
    /**
     * The read's current value, for code outside a component. Starts a fetch if the partition has never been fetched (but
     * doesn't refetch a stale one), and returns {@linkcode CommonDef.empty | empty} until it has rows. Tracked: inside a
     * tracking scope (a {@linkcode Read.useValue | useValue} read, `useTrackedStores`, a tracked selector), the scope
     * re-runs when the value changes.
     */
    getValue: (args: Args | undefined) => T;
    /**
     * The read as a hook: fetches the partition if it hasn't been fetched or is stale, returns the value with the
     * fetch's state as a {@linkcode DataResult}, and re-renders the component when the value changes.
     */
    useValue: (args: Args | undefined, options?: ReadCallOptions) => DataResult<T>;
    /**
     * The args fields a caller must have before the read runs: the partition's fields, then its
     * {@linkcode CommonDef.varyBy | varyBy} fields. Present when both are field lists, or when the definition gives
     * {@linkcode Read.requires | requires}. {@linkcode pairRead} uses it to publish the read: the published hook and
     * getter return {@linkcode CommonDef.empty | empty} until every one of these fields has a value.
     */
    requires?: readonly string[];
}
/** Returns a {@linkcode DataResult} whose identity is stable across renders while its parts hold. */
export declare function useResult<T>(data: T, status: DataStatus, isFetching: boolean, doRefetch: () => void): DataResult<T>;
/**
 * Builds the read engine over one store's partitions: {@linkcode Partitions.defineRead | defineRead} /
 * {@linkcode Partitions.defineReadMany | defineReadMany} / {@linkcode Partitions.defineReadGrouped | defineReadGrouped}
 * each take a descriptor and hand back its {@linkcode Read.useValue | useValue} / {@linkcode Read.getValue | getValue}
 * pair, with the priming, the version subscription and the presence gate already wrapped around
 * {@linkcode ReadDef.select | select}. {@linkcode definePartitions} builds one per store, so stores declare reads.
 */
export declare function createReadSurface<Key>(kernel: ReadSurfaceKernel<Key>): {
    /**
     * Declares a read, in two calls: `read<Args, Value>()({ … })`. The first names what the read takes and returns, the
     * second takes the read itself — separately, because that is what leaves TypeScript free to infer
     * {@linkcode CommonDef.varyBy | varyBy} from the list a read spells, which is how
     * {@linkcode ReadDef.select | select} comes to see those fields and no others.
     */
    read: <Args, T>() => <const V extends VarySpec<Args> = readonly []>(def: ReadDef<Args, Key, T, V>) => Read<Args, T>;
    readMany: <Args, T>() => <const V extends VarySpec<Args> = readonly []>(def: ReadManyDef<Args, Key, T, V>) => Read<Args, T>;
    readGrouped: <Args, T>() => <const V extends VarySpec<Args> = readonly []>(def: ReadGroupedDef<Args, Key, T, V>) => Read<Args, T>;
    has: (key: Key) => boolean;
};
export type { DataResult, PartitionLifecycle, Partitions, StoreSurface, byEntity, definePartitions, pairRead, shallowEqualStruct, shallowEqualValue };
//# sourceMappingURL=surface.d.ts.map