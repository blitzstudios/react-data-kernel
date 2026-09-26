/**
 * {@linkcode byEntity} caches: a value derived from each entity's rows, usually a view model, cached per entity.
 *
 * An entity is the thing a row belongs to, such as one player, named by the table's `entityId` column. Derived values
 * turn an entity's rows into a value (typically the object a screen renders), keep it, and return the same object until
 * a write changes that entity's rows. Rows come out of SQLite as new objects on every query, so without this, every
 * read after every write would build new values and re-render every component showing one, changed or not.
 *
 * Every write reports which entities it changed, so only those entities' values are rebuilt. A read that asks for
 * particular entities ({@linkcode DerivedValues.at | at}, {@linkcode DerivedValues.atEach | atEach}) depends on just
 * those entities, so a write to other entities doesn't re-run it. A store declares one set of derived values per shape,
 * and every read of that shape shares it, so each entity's value is built once however many reads ask for it.
 *
 * Every method's answer is cached, lists included: asked again, a method returns the same array or object for as long
 * as what it holds is unchanged, and {@linkcode DerivedValues.where | where} and {@linkcode DerivedValues.all | all}
 * keep which entities matched until the partition changes, so asking again runs no query.
 */
import { BoundEntityMemo, Memo, MemoDeclaration } from '../caches';
import { RowShape, RowTable } from '../table/types';
import type { ReadDef } from './surface';
import type { Partitions } from '../define_partitions';
import type { byPartition } from '../caches';
/**
 * The definition of a {@linkcode byEntity} cache: how to build one entity's value from its rows (usually a view model),
 * and how many built values to keep. An entity is the thing a row belongs to, such as one player, named by the table's
 * `entityId` column. The cache's name, shown in warnings, is its key in the
 * {@linkcode Partitions.defineCaches | defineCaches} block.
 */
export interface DerivedValuesDef<Row extends RowShape, V> {
    /**
     * How many built values to keep, across all partitions; beyond that, the least recently used are discarded and
     * rebuilt when asked for again. Set it above the most entities one screen reads at once: a read asking for more than
     * {@linkcode DerivedValuesDef.max | max} entities discards what it just built, rebuilding every one after every
     * write, and warns in dev.
     */
    max: number;
    /**
     * Builds one entity's value from its rows (all rows in the partition with that entity id, in storage order), usually
     * a view model, or returns `undefined` for an entity that shouldn't have one. It runs once per entity, and again only
     * after a write changes that entity's rows. In a table with one row per entity, it gets a one-row list:
     * `fromRows: ([row]) => …`.
     */
    fromRows: (rows: readonly Row[]) => V | undefined;
    /**
     * Text added to the dev warning shown when a read asks for more entities than {@linkcode DerivedValuesDef.max | max},
     * where raising {@linkcode DerivedValuesDef.max | max} is the wrong fix, such as a detailed shape meant for one
     * entity at a time, which should point to the lean one.
     */
    advice?: string;
}
/**
 * A {@linkcode byEntity} cache as a store's {@linkcode Partitions.defineCaches | defineCaches} block returns it: one
 * value per entity, built from the entity's rows (usually a view model), cached, and returned as the same object until
 * a write changes that entity's rows. An entity is the thing a row belongs to, such as one player, named by the table's
 * `entityId` column.
 *
 * Each value's address is a partition key plus an entity id (a partition is the set of rows one fetch returns and
 * replaces), so every method takes the key first and reads only that partition's rows. Reads call these methods in
 * their {@linkcode ReadDef.select | select}. Name a set after what it holds and the entity it is keyed by, such as
 * `cardsByPlayer`.
 */
export interface DerivedValues<Key, Row extends RowShape, V> {
    /**
     * The value for entity `id` (an entity id, such as a `player_id`), or `undefined` if the partition has no rows for
     * it. A read that calls it depends on that entity only: it re-runs when a write changes that entity's rows, and not
     * for writes to other entities.
     */
    at(key: Key, id: string): V | undefined;
    /**
     * The values at each of `ids` (entity ids), in the order of `ids`; an id with no rows in the partition is left out.
     * Builds every missing one with a single query. A read that calls it depends on those entities only. Asked again for
     * the same ids, it returns the same array while none of their values has changed.
     */
    atEach(key: Key, ids: readonly string[]): V[];
    /**
     * The same values as {@linkcode DerivedValues.atEach | atEach}, as an object keyed by id instead of a list, for a
     * caller that looks them up. An id with no rows in the partition is left out. A read that calls it depends on those
     * entities only. Asked again for the same ids, it returns the same object while none of their values has changed.
     */
    pick(key: Key, ids: readonly string[]): Record<string, V>;
    /**
     * The values for every entity that has rows matching `filter` (column values, on top of the partition's), such as
     * `{ team: 'KC' }`, in storage order. Where an entity has several rows, its value is built from just the rows that
     * match. A read that calls it depends on the whole partition, since any write can change which entities match.
     *
     * Which entities match is kept until the partition changes, so asking again runs no query; after a write, the query
     * runs once, and the same array comes back if the matching values are unchanged.
     */
    where(key: Key, filter?: Partial<Row>): V[];
    /**
     * The values for every entity in the partition, in storage order. A read that calls it depends on the whole
     * partition, since any write can add or remove entities. Kept like {@linkcode DerivedValues.where | where}'s.
     */
    all(key: Key): V[];
}
/**
 * A {@linkcode byEntity} cache's definition, as {@linkcode byEntity} returns it, before a store's
 * {@linkcode Partitions.defineCaches | defineCaches} block attaches it to the store's partitions.
 */
export interface EntityCacheDeclaration<Row extends RowShape, V> {
    readonly kind: 'byEntity';
    readonly def: DerivedValuesDef<Row, V>;
}
/**
 * Declares a cache of values derived from each entity's rows, usually view models, for a store's
 * {@linkcode Partitions.defineCaches | defineCaches} block: one value per entity (an entity is the thing a row belongs
 * to, such as one player, named by the table's `entityId` column), built from that entity's rows by `fromRows` on first
 * use and kept, as the same object, until a write changes that entity's rows. Reads look values up by partition key and
 * entity id through the {@linkcode DerivedValues} methods, such as {@linkcode DerivedValues.at | at}.
 *
 * `byEntity({ max: 2048, fromRows: rowsToTeamGames })`: the row type comes from the store and the value type is what
 * `fromRows` returns, so neither is written.
 */
export declare function byEntity<Row extends RowShape, V>(def: DerivedValuesDef<Row, V>): EntityCacheDeclaration<Row, V>;
/** Whether a {@linkcode Partitions.defineCaches | defineCaches} block entry is a {@linkcode byEntity} cache. */
export declare function isEntityCacheDeclaration(decl: unknown): decl is EntityCacheDeclaration<RowShape, unknown>;
/**
 * The memo a {@linkcode byEntity} cache keeps its values in: one per entity, and per filter where a filter can cut an
 * entity's rows.
 */
export type DerivedValueMemo<Key, V> = Memo<Key, BoundEntityMemo<V | undefined, readonly ['scope']>>;
/** The declaration a {@linkcode byEntity} cache's memo is built from. */
export declare function derivedValueMemo<V>(max: number): MemoDeclaration;
/**
 * What a {@linkcode byEntity} cache needs from the store around it: its name, the rows, how a key addresses them, the
 * memo its values live in, and the partition's version, which a lookup over the whole partition depends on.
 */
export interface DerivedValuesContext<Row extends RowShape, Key, V> {
    store: string;
    /** The cache's key in the store's {@linkcode Partitions.defineCaches | defineCaches} block, shown in warnings. */
    name: string;
    table: RowTable<Row>;
    filter: (key: Key) => Partial<Row>;
    memo: DerivedValueMemo<Key, V>;
    /** A partition key's parts, which identify the partition in the lists the cache keeps. */
    parts: (key: Key) => readonly string[];
    /** The partition's version. Tracked: the calling read comes to depend on the whole partition. */
    version: (key: Key) => number;
}
export declare function createDerivedValues<Row extends RowShape, Key, V>(ctx: DerivedValuesContext<Row, Key, V>, def: DerivedValuesDef<Row, V>): DerivedValues<Key, Row, V>;
export type { Partitions, ReadDef, byPartition };
//# sourceMappingURL=derived_values.d.ts.map