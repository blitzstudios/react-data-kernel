/**
 * A store's cache block: every value the store keeps on the heap beyond its rows, declared together through its
 * partitions ({@linkcode Partitions.defineCaches | defineCaches}). Each entry is one of two kinds, named for what a
 * write discards: a {@linkcode byEntity} cache holds one value per entity and rebuilds only the entities a write
 * changed, and a {@linkcode byPartition} cache holds values computed from a whole partition and discards them on any
 * write to it. Nothing here fetches: every value is built from rows already in the table.
 */

import { createMemos, Memo, MemoDecl, PartitionBinding } from './caches';
import { createDerivedValues, DerivedValueMemo, DerivedValues, derivedValueMemo, isEntityCacheDeclaration, EntityCacheDeclaration } from './read/derived_values';
import { RowShape, RowTable } from './table/types';
import type { byEntity } from './read/derived_values';
import type { byPartition } from './caches';
import type { Partitions } from './define_partitions';

/**
 * One entry of a store's {@linkcode Partitions.defineCaches | defineCaches} block: a {@linkcode byPartition} cache, or,
 * where the rows are known, a {@linkcode byEntity} cache.
 */
export type CacheDeclaration<Row extends RowShape = never> = MemoDecl<unknown> | ([Row] extends [never] ? never : EntityCacheDeclaration<Row, any>);

/**
 * What a {@linkcode Partitions.defineCaches | defineCaches} block returns: one cache per entry, under the entry's key.
 * A {@linkcode byEntity} entry becomes {@linkcode DerivedValues}; a {@linkcode byPartition} entry becomes a cache read
 * through `.for(key)`.
 */
export type BoundCaches<Key, Row extends RowShape, D> = {
  [K in keyof D]: D[K] extends EntityCacheDeclaration<any, infer V> ? DerivedValues<Key, Row, V> : D[K] extends MemoDecl<infer Bound> ? Memo<Key, Bound> : never;
};

/**
 * A store's {@linkcode Partitions.defineCaches | defineCaches} function, which attaches a block of cache declarations
 * to the store's partitions. A store passes it to modules that declare their own caches, such as a ranker, so every
 * cache the store holds is attached the same way. Without the store's row type, it takes only {@linkcode byPartition}
 * caches.
 */
export type CacheFactory<Key, Row extends RowShape = never> = <D extends Record<string, CacheDeclaration<Row>>>(decls: D) => BoundCaches<Key, Row, D>;

/** What a {@linkcode byEntity} cache reads its rows through: the store's table, and how a partition key addresses it. */
export interface EntityCacheSource<Row extends RowShape, Key> {
  table: RowTable<Row>;
  /** The column values that pick out a partition's rows. */
  filter: (key: Key) => Partial<Row>;
}

/**
 * Attaches a cache block to a store: each {@linkcode byPartition} entry to the partitions' versions, and each
 * {@linkcode byEntity} entry to the rows `source` reads as well. Without a `source`, a {@linkcode byEntity} entry
 * throws.
 */
export function bindCaches<Key, Row extends RowShape, D extends Record<string, CacheDeclaration<Row>>>(
  store: string,
  binding: PartitionBinding<Key>,
  decls: D,
  source?: EntityCacheSource<Row, Key>,
): BoundCaches<Key, Row, D> {
  const out = {} as Record<string, unknown>;
  for (const name of Object.keys(decls)) {
    const decl: unknown = decls[name];
    if (isEntityCacheDeclaration(decl)) {
      if (!source) throw new Error(`[${store}] '${name}' is a byEntity cache, which reads a store's rows; declare it in the store's partitions.defineCaches block`);
      const memo = createMemos(store, binding, { [name]: derivedValueMemo(decl.def.max) })[name] as DerivedValueMemo<Key, unknown>;
      out[name] = createDerivedValues<Row, Key, unknown>(
        { store, name, table: source.table, filter: source.filter, memo, parts: binding.parts, version: binding.version },
        decl.def as EntityCacheDeclaration<Row, unknown>['def'],
      );
    } else {
      out[name] = createMemos(store, binding, { [name]: decl as MemoDecl<unknown> })[name];
    }
  }
  return out as BoundCaches<Key, Row, D>;
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { Partitions, byEntity, byPartition };
