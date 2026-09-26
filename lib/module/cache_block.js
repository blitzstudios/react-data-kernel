"use strict";

/**
 * A store's cache block: every value the store keeps on the heap beyond its rows, declared together through its
 * partitions ({@linkcode Partitions.defineCaches | defineCaches}). Each entry is one of two kinds, named for what a
 * write discards: a {@linkcode byEntity} cache holds one value per entity and rebuilds only the entities a write
 * changed, and a {@linkcode byPartition} cache holds values computed from a whole partition and discards them on any
 * write to it. Nothing here fetches: every value is built from rows already in the table.
 */

import { createMemos } from "./caches.js";
import { createDerivedValues, derivedValueMemo, isEntityCacheDeclaration } from "./read/derived_values.js";

/**
 * One entry of a store's {@linkcode Partitions.defineCaches | defineCaches} block: a {@linkcode byPartition} cache, or,
 * where the rows are known, a {@linkcode byEntity} cache.
 */

/**
 * What a {@linkcode Partitions.defineCaches | defineCaches} block returns: one cache per entry, under the entry's key.
 * A {@linkcode byEntity} entry becomes {@linkcode DerivedValues}; a {@linkcode byPartition} entry becomes a cache read
 * through `.for(key)`.
 */

/**
 * A store's {@linkcode Partitions.defineCaches | defineCaches} function, which attaches a block of cache declarations
 * to the store's partitions. A store passes it to modules that declare their own caches, such as a ranker, so every
 * cache the store holds is attached the same way. Without the store's row type, it takes only {@linkcode byPartition}
 * caches.
 */

/** What a {@linkcode byEntity} cache reads its rows through: the store's table, and how a partition key addresses it. */

/**
 * Attaches a cache block to a store: each {@linkcode byPartition} entry to the partitions' versions, and each
 * {@linkcode byEntity} entry to the rows `source` reads as well. Without a `source`, a {@linkcode byEntity} entry
 * throws.
 */
export function bindCaches(store, binding, decls, source) {
  const out = {};
  for (const name of Object.keys(decls)) {
    const decl = decls[name];
    if (isEntityCacheDeclaration(decl)) {
      if (!source) throw new Error(`[${store}] '${name}' is a byEntity cache, which reads a store's rows; declare it in the store's partitions.defineCaches block`);
      const memo = createMemos(store, binding, {
        [name]: derivedValueMemo(decl.def.max)
      })[name];
      out[name] = createDerivedValues({
        store,
        name,
        table: source.table,
        filter: source.filter,
        memo,
        parts: binding.parts,
        version: binding.version
      }, decl.def);
    } else {
      out[name] = createMemos(store, binding, {
        [name]: decl
      })[name];
    }
  }
  return out;
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=cache_block.js.map