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

import { useCallback, useMemo } from 'react';

import { cacheKey, EMPTY_VARY, isVaryPresent, KEY_SEP, partitionsKey, VaryValue, varyKey, cacheKeyOf } from '../args_key';
import { getOrCreate } from '../collections';
import { PartitionField, partitionKeyOf, requiredFieldsOf, VaryField, varyValuesOf } from './partition_fields';
import { createVersionedCache, shallowEqualValue } from '../caches';
import { addressesPartition, NO_PARTS, PartitionEntry, partitionEntries, VersionAtom } from '../reactivity/version_atom';
import { createOnceGuard, onGuardReset } from '../diagnostics/once_guard';
import { shouldLog } from '../diagnostics/log_level';
import { NO_PRIMING, type PrimeState } from '../prime_state';
import { DataResult, DataStatus, makeResult, offHeapStatus } from '../store_result';
import { runSubscribed, runTracked, trackDependency } from '../reactivity/tracking';
import { useTrackedValue } from '../reactivity/tracked_value';
import { covered, uncoveredReads } from '../table/read_coverage';
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
  usePrime: (key: Key | undefined, enabled: boolean, opts?: { slice?: boolean }) => PrimeState;
  /** A hook that fetches each of several partitions that isn't fresh, and returns their combined state. */
  usePrimeMany: (keys: readonly Key[], enabled: boolean, opts?: { slice?: boolean }) => PrimeState;
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
export type SelectArgs<Args, V> = V extends readonly (keyof Args)[] ? { [K in V[number]]: NonNullable<Args[K & keyof Args]> } : Args;

/**
 * Hands `select` the whole args object, which carries the fields it declared and others it cannot see. Sound because
 * the narrowing exists to stop a store *writing* a reach into an undeclared arg, not to hide anything at runtime.
 */
function overArgs<Args, Named, T, V>(select: (args: SelectArgs<Args, V>, named: Named) => T): (args: Args, named: Named) => T {
  return select as unknown as (args: Args, named: Named) => T;
}

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

/** Stable identities so a disabled read's hooks keep the same deps across renders. */
const NO_KEYS: readonly never[] = Object.freeze([]);
const NO_GROUPS: readonly (readonly never[])[] = Object.freeze([]);
const NO_PARTITIONS: readonly (readonly string[])[] = Object.freeze([]);
const NO_ARGS_KEY = `${KEY_SEP}disabled`;

/** Above one viewport's worth of rows: a virtualized list self-limits around 20-30. */
const FANOUT_WARN_THRESHOLD = 48;

/** Entries in a surface's presence cache, which is keyed by partition and so bounds live partitions. */
const PRESENCE_CACHE_MAX = 512;
const fanoutWarned = createOnceGuard();
let fanoutTick: Map<string, { keys: Set<string>; batched: boolean }> | null = null;
onGuardReset(() => {
  fanoutTick = null;
});

function flushFanout(): void {
  const tick = fanoutTick;
  fanoutTick = null;
  if (!shouldLog('warn')) return;
  tick?.forEach((entry, store) => {
    if (entry.keys.size <= FANOUT_WARN_THRESHOLD || fanoutWarned.seen(store)) return;
    const sample = [...entry.keys].slice(0, 3).join(', ');
    // Already-batched callers need the opposite advice from per-row ones: telling a list that reads five ids a row
    // to "use a plural read" describes what it is doing, and it stops reading the warning.
    const remedy = entry.batched
      ? 'These reads are already plural, so the fix is not a plural read but one read higher up: lift it to the ' +
        "parent over the union of what its rows ask for, and let each row index into that result. If the rows' " +
        'sets come from a list the parent already holds, `createWindowedList` resolves them against it.'
      : 'A list is reading per row, which puts one subscription and one hydration on the heap per row. Read the ' +
        "set once in the parent — a plural `*ByIds` read, or `createWindowedList` so rows resolve against the " +
        "parent's list — and let each row index into that.";
    // eslint-disable-next-line no-console
    console.warn(
      `[${store}_store] ${entry.keys.size} separate reads in one tick (e.g. ${sample}). ${remedy} Note that a ` +
        'plural read still primes by PARTITION, not by the ids it asks for, so if this partition is coarse the ' +
        'parent read fetches all of it either way and this is about subscriptions rather than fetching; where the ' +
        'rows are already to hand from the payload that listed them, prefer rendering from those and declaring ' +
        '`prime: false`.',
    );
  });
}

/**
 * `batchSize` is the widest array a read varies by, so a caller already asking for a set can be told something else.
 */
function noteRead(store: string, argsKey: string, batchSize: number): void {
  if (fanoutWarned.has(store)) return;
  if (!fanoutTick) {
    fanoutTick = new Map();
    setTimeout(flushFanout, 0);
  }
  const entry = getOrCreate(fanoutTick, store, () => ({ keys: new Set<string>(), batched: false }));
  entry.keys.add(argsKey);
  if (batchSize > 1) entry.batched = true;
}

/** The widest set a read is varying by: 1 when it names one thing, which is the per-row shape the warning is for. */
function batchSizeOf(vary: readonly VaryValue[]): number {
  let widest = 1;
  for (const value of vary) if (Array.isArray(value) && value.length > widest) widest = value.length;
  return widest;
}

/** Returns a {@linkcode DataResult} whose identity is stable across renders while its parts hold. */
export function useResult<T>(data: T, status: DataStatus, isFetching: boolean, doRefetch: () => void): DataResult<T> {
  return useMemo(() => makeResult(data, status, { isFetching, refetch: doRefetch }), [data, status, isFetching, doRefetch]);
}

/** What a read's value depends on beyond its partitions, resolved once per read. */
function varyResolver<Args>(def: { varyBy?: VarySpec<Args> }): (args: Args) => readonly VaryValue[] {
  return def.varyBy ? varyValuesOf(def.varyBy) : () => EMPTY_VARY;
}

/**
 * What a read wants of the partitions it primes. A {@linkcode CommonDef.varyBy | varyBy} is the read saying it selects
 * part of one, which is the only shape where an oversized ingest is worth reporting; a read without one is asking for
 * the partition.
 */
function intentOf(def: { varyBy?: unknown }): { slice: boolean } | undefined {
  return def.varyBy ? SELECTS_SLICE : undefined;
}

const SELECTS_SLICE = { slice: true } as const;

/**
 * Whether a read may prime its partitions and whether its {@linkcode ReadDef.select | select} may run. Priming asks
 * strictly less: a read still waiting on a vary value primes anyway, so the rows are there when the value arrives.
 */
function readGates<Args>(
  def: { enabled?: (args: Args) => boolean; prime?: boolean },
  args: Args,
  addressable: boolean,
  vary: readonly VaryValue[],
  primeWanted: boolean,
): { prime: boolean; read: boolean } {
  return {
    // Both the declaration and the call site can veto priming, and neither can override the other: a read that
    // declares `prime: false` never fetches, and a caller passing `prime: false` never fetches, whoever else does.
    prime: addressable && primeWanted && (def.prime ?? true),
    read: addressable && vary.every(isVaryPresent) && (def.enabled?.(args) ?? true),
  };
}

/**
 * The status and {@linkcode DataResult} every read ends with; `hasData` is a thunk, called once the read is known
 * enabled.
 */
function useReadTail<T>(data: T, enabled: boolean, hasData: () => boolean, prime: PrimeState, doRefetch: () => void): DataResult<T> {
  const status = runSubscribed(() => offHeapStatus(enabled, enabled && hasData(), prime));
  return useResult(data, status, prime.isFetching, doRefetch);
}

/**
 * Builds the read engine over one store's partitions: {@linkcode Partitions.defineRead | defineRead} /
 * {@linkcode Partitions.defineReadMany | defineReadMany} / {@linkcode Partitions.defineReadGrouped | defineReadGrouped}
 * each take a descriptor and hand back its {@linkcode Read.useValue | useValue} / {@linkcode Read.getValue | getValue}
 * pair, with the priming, the version subscription and the presence gate already wrapped around
 * {@linkcode ReadDef.select | select}. {@linkcode definePartitions} builds one per store, so stores declare reads.
 */
export function createReadSurface<Key>(kernel: ReadSurfaceKernel<Key>) {
  const { ingest, toParts } = kernel;


  const usePriming = ingest?.usePrime ?? NO_PRIMING;
  const usePrimingAll = ingest?.usePrimeMany ?? NO_PRIMING;

  /** Whether each partition holds rows, keyed by partition and shared by every read on this surface. */
  const presenceByVersion = createVersionedCache<boolean>(PRESENCE_CACHE_MAX);
  // Held against the presence version, which moves only on a write that could have emptied or filled the partition,
  // and tracks presence alone: a read of one entity must not come to depend on the whole partition by asking this.
  const hasOne = (key: Key, parts: readonly string[]): boolean =>
    presenceByVersion.read(cacheKeyOf(parts), kernel.version.getPresence(parts), () => covered(() => kernel.has(key)));
  const hasAny = (entries: readonly PartitionEntry<Key>[]): boolean => entries.some((entry) => addressesPartition(entry.parts) && hasOne(entry.key, entry.parts));

  /**
   * Starts an unfetched partition's fetch. Only {@linkcode Read.getValue | getValue} needs it; a reactive read primes
   * through {@linkcode PartitionLifecycle.usePrime | usePrime}. Cold means never fetched, not empty: a partition
   * holding rows a socket pushed into it has never had its body, and gating on rows would leave it on that one row for
   * the session.
   */
  const primeIfCold = (key: Key, parts: readonly string[]): void => {
    if (!ingest) return;
    const fetched = kernel.hasFetched ? kernel.hasFetched(key) : hasOne(key, parts);
    if (!fetched) ingest.ensure(key);
  };

  /**
   * Runs a read's `select` and makes sure the result depends on enough. A `select` built from `byEntity` caches reports
   * the entities it read and depends on those alone. One that read rows straight off the table, or reported
   * nothing at all, is made to depend on every partition it named: it could have read anything in them.
   */
  const selectTracked = <T>(partitions: readonly (readonly string[])[], select: () => T): T => {
    const before = uncoveredReads();
    const { value, deps } = runTracked(select);
    for (const dep of deps) trackDependency(dep);
    if (!deps.length || uncoveredReads() !== before) for (const parts of partitions) if (addressesPartition(parts)) kernel.version.get(parts);
    return value;
  };

  function defineRead<Args, T, const V extends VarySpec<Args>>(def: ReadDef<Args, Key, T, V>): Read<Args, T> {
    const spec = def.partition ?? (kernel.defaultPartition as readonly PartitionField<Args>[] | ((args: Args) => Key) | undefined);
    if (!spec)
      throw new Error(`${kernel.name ?? 'off_heap'}_store: this read needs a \`partition\`, since the store's key declares no \`fields\` to default to`);
    const keyOf = partitionKeyOf<Args, Key>(spec);
    const varyOf = varyResolver<Args>(def);
    const primeIntent = intentOf(def);
    const select = overArgs<Args, Key, T, V>(def.select);
    const gatesFor = (args: Args, parts: readonly string[], vary: readonly VaryValue[], wanted: boolean, primeWanted = true) =>
      readGates(def, args, wanted && addressesPartition(parts), vary, primeWanted);

    const run = (args: Args, key: Key, parts: readonly string[]): T => selectTracked([parts], () => select(args, key));

    function getValue(args: Args | undefined): T {
      if (args === undefined) return def.empty;
      const key = keyOf(args);
      const parts = toParts(key);
      if (!addressesPartition(parts)) return def.empty;
      const vary = varyOf(args);
      const gates = gatesFor(args, parts, vary, true);
      if (gates.prime) primeIfCold(key, parts);
      // Every path reports something to the scope above it, so a derivation that got `empty` here still hears when
      // the partition lands: presence for a disabled or cold read, and whatever `select` read otherwise.
      if (!gates.read) {
        kernel.version.getPresence(parts);
        return def.empty;
      }
      if (!hasOne(key, parts)) return def.empty;
      return run(args, key, parts);
    }

    function useValue(args: Args | undefined, options?: ReadCallOptions): DataResult<T> {
      // `partition`, `varyBy` and `select` assume a real partition; the hooks below still run, reading nothing.
      const key = args === undefined ? undefined : keyOf(args);
      const parts = key === undefined ? NO_PARTS : toParts(key);
      const vary = args === undefined ? EMPTY_VARY : varyOf(args);
      const gates = gatesFor(args as Args, parts, vary, (options?.enabled ?? true) && args !== undefined, options?.prime ?? true);
      const prime = usePriming(key, gates.prime, primeIntent);
      const argsKey = args === undefined ? NO_ARGS_KEY : varyKey(parts, vary);
      if (__DEV__ && gates.read) noteRead(kernel.name ?? 'off_heap', argsKey, batchSizeOf(vary));
      const data = useTrackedValue<T>(() => (hasOne(key as Key, parts) ? run(args as Args, key as Key, parts) : def.empty), [argsKey], {
        enabled: gates.read,
        isEqual: def.isEqual ?? shallowEqualValue,
        empty: def.empty,
      });
      const doRefetch = useCallback(() => {
        if (key !== undefined) ingest?.refetch(key);
      }, [argsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `argsKey` covers `key`
      return useReadTail(data, gates.read, () => addressesPartition(parts) && hasOne(key as Key, parts), prime, doRefetch);
    }

    return { getValue, useValue, requires: def.requires ?? requiredFieldsOf<Args, Key>(spec, def.varyBy) };
  }

  /**
   * The engine behind {@linkcode Partitions.defineReadMany | defineReadMany} and
   * {@linkcode Partitions.defineReadGrouped | defineReadGrouped}, which differ only in what `select` is handed back:
   * the flat keys, or the groups they were named in. `resolve` runs once per call because naming a partition may intern
   * it.
   */
  function manyRead<Args, T, Named>(
    def: CommonDef<Args, T, VarySpec<Args>>,
    resolve: (args: Args) => { keys: readonly Key[]; named: Named },
    select: (args: Args, named: Named) => T,
    noneNamed: Named,
  ): Read<Args, T> {
    const varyOf = varyResolver<Args>(def);
    const primeIntent = intentOf(def);
    const argsKeyOf = (partitions: readonly (readonly string[])[], vary: readonly VaryValue[]): string => varyKey([partitionsKey(partitions)], vary);
    const resolveOr = (args: Args | undefined) => (args === undefined ? { keys: NO_KEYS as readonly Key[], named: noneNamed } : resolve(args));

    /**
     * {@linkcode Partitions.defineRead | defineRead}'s gates over a set: addressable when at least one partition is,
     * since the rest are gaps.
     */
    const gatesFor = (args: Args, partitions: readonly (readonly string[])[], vary: readonly VaryValue[], wanted: boolean, primeWanted = true) =>
      readGates(def, args, wanted && partitions.some(addressesPartition), vary, primeWanted);

    const run = (args: Args, named: Named, partitions: readonly (readonly string[])[]): T => selectTracked(partitions, () => select(args, named));

    /** Presence of every partition named, which is what a read reports when it has nothing else to depend on. */
    const trackPresence = (partitions: readonly (readonly string[])[]): void => {
      for (const parts of partitions) if (addressesPartition(parts)) kernel.version.getPresence(parts);
    };

    function getValue(args: Args | undefined): T {
      if (args === undefined) return def.empty;
      const { keys, named } = resolve(args);
      const entries = partitionEntries(keys, toParts);
      const partitions = entries.map((entry) => entry.parts);
      const vary = varyOf(args);
      const gates = gatesFor(args, partitions, vary, true);
      if (gates.prime) for (const entry of entries) if (addressesPartition(entry.parts)) primeIfCold(entry.key, entry.parts);
      // `hasAny` stops at the first partition holding rows, so the rest are reported here for a read that lands later.
      trackPresence(partitions);
      if (!gates.read || !hasAny(entries)) return def.empty;
      return run(args, named, partitions);
    }

    function useValue(args: Args | undefined, options?: ReadCallOptions): DataResult<T> {
      const { keys, named } = resolveOr(args);
      const entries = args === undefined ? [] : partitionEntries(keys, toParts);
      const partitions = args === undefined ? NO_PARTITIONS : entries.map((entry) => entry.parts);
      const vary = args === undefined ? EMPTY_VARY : varyOf(args);
      const gates = gatesFor(args as Args, partitions, vary, (options?.enabled ?? true) && args !== undefined, options?.prime ?? true);
      const prime = usePrimingAll(keys, gates.prime, primeIntent);
      const argsKey = args === undefined ? NO_ARGS_KEY : argsKeyOf(partitions, vary);
      const data = useTrackedValue<T>(
        () => {
          trackPresence(partitions);
          return hasAny(entries) ? run(args as Args, named, partitions) : def.empty;
        },
        [argsKey],
        { enabled: gates.read, isEqual: def.isEqual ?? shallowEqualValue, empty: def.empty },
      );
      const doRefetch = useCallback(() => {
        for (const key of keys) ingest?.refetch(key);
      }, [argsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `argsKey` covers `keys`
      return useReadTail(data, gates.read, () => hasAny(entries), prime, doRefetch);
    }

    return { getValue, useValue, requires: def.requires };
  }

  function defineReadMany<Args, T, const V extends VarySpec<Args>>(def: ReadManyDef<Args, Key, T, V>): Read<Args, T> {
    const resolve = (args: Args) => {
      const keys = def.partitions(args);
      return { keys, named: keys };
    };
    return manyRead<Args, T, readonly Key[]>(def, resolve, overArgs<Args, readonly Key[], T, V>(def.select), NO_KEYS);
  }

  function defineReadGrouped<Args, T, const V extends VarySpec<Args>>(def: ReadGroupedDef<Args, Key, T, V>): Read<Args, T> {
    const resolve = (args: Args) => {
      const named = def.groups(args);
      const keys: Key[] = [];
      for (const group of named) for (const key of group) keys.push(key);
      return { keys, named };
    };
    return manyRead<Args, T, readonly (readonly Key[])[]>(def, resolve, overArgs<Args, readonly (readonly Key[])[], T, V>(def.select), NO_GROUPS);
  }

  /** The surface's cached presence probe, so a store asks the same question the reads gate on. */
  const has = (key: Key): boolean => hasOne(key, toParts(key));

  return {
    /**
     * Declares a read, in two calls: `read<Args, Value>()({ … })`. The first names what the read takes and returns, the
     * second takes the read itself — separately, because that is what leaves TypeScript free to infer
     * {@linkcode CommonDef.varyBy | varyBy} from the list a read spells, which is how
     * {@linkcode ReadDef.select | select} comes to see those fields and no others.
     */
    read: <Args, T>() => defineRead as <const V extends VarySpec<Args> = readonly []>(def: ReadDef<Args, Key, T, V>) => Read<Args, T>,
    readMany: <Args, T>() => defineReadMany as <const V extends VarySpec<Args> = readonly []>(def: ReadManyDef<Args, Key, T, V>) => Read<Args, T>,
    readGrouped: <Args, T>() => defineReadGrouped as <const V extends VarySpec<Args> = readonly []>(def: ReadGroupedDef<Args, Key, T, V>) => Read<Args, T>,
    has,
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { DataResult, PartitionLifecycle, Partitions, StoreSurface, byEntity, definePartitions, pairRead, shallowEqualStruct, shallowEqualValue };
