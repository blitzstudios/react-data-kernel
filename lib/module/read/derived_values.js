"use strict";

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

import { createBoundedLru, entityMemo, shallowEqualArray, shallowEqualRecord } from "../caches.js";
import { cacheKeyOf, KEY_SEP, stableKey } from "../args_key.js";
import { createOnceGuard } from "../diagnostics/once_guard.js";
import { covered } from "../table/read_coverage.js";

/**
 * The definition of a {@linkcode byEntity} cache: how to build one entity's value from its rows (usually a view model),
 * and how many built values to keep. An entity is the thing a row belongs to, such as one player, named by the table's
 * `entityId` column. The cache's name, shown in warnings, is its key in the
 * {@linkcode Partitions.defineCaches | defineCaches} block.
 */

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

/**
 * A {@linkcode byEntity} cache's definition, as {@linkcode byEntity} returns it, before a store's
 * {@linkcode Partitions.defineCaches | defineCaches} block attaches it to the store's partitions.
 */

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
export function byEntity(def) {
  return {
    kind: 'byEntity',
    def
  };
}

/** Whether a {@linkcode Partitions.defineCaches | defineCaches} block entry is a {@linkcode byEntity} cache. */
export function isEntityCacheDeclaration(decl) {
  return typeof decl === 'object' && decl !== null && decl.kind === 'byEntity';
}
const thrashWarned = createOnceGuard();

/**
 * The memo a {@linkcode byEntity} cache keeps its values in: one per entity, and per filter where a filter can cut an
 * entity's rows.
 */

/** The declaration a {@linkcode byEntity} cache's memo is built from. */
export function derivedValueMemo(max) {
  return entityMemo()({
    max,
    by: ['scope']
  });
}

/**
 * What a {@linkcode byEntity} cache needs from the store around it: its name, the rows, how a key addresses them, the
 * memo its values live in, and the partition's version, which a lookup over the whole partition depends on.
 */

/** The scope of a read no filter narrows: the entity's whole rows, which every such read shares. */
const WHOLE_ENTITY = '';

/**
 * How many lists one {@linkcode byEntity} cache keeps (the answers of {@linkcode DerivedValues.atEach | atEach},
 * {@linkcode DerivedValues.pick | pick}, {@linkcode DerivedValues.where | where} and {@linkcode DerivedValues.all | all}):
 * a screen's lists and those of the screens behind it. Each holds references to values the cache already built.
 */
const LISTS_MAX = 64;
const NO_VALUES = Object.freeze([]);
const NO_PICKED = Object.freeze({});
export function createDerivedValues(ctx, def) {
  const {
    store,
    name,
    table,
    filter,
    memo,
    parts,
    version
  } = ctx;
  const idColumn = table.entityId;
  // `version` is the partition's, for a list of whoever matched a filter; a list of named ids is checked by its values.
  const lists = createBoundedLru(LISTS_MAX);

  /** The list held under `listKey` if it holds the same values as `value`, otherwise `value`, now held. */
  const keep = (listKey, value, same, version) => {
    const held = lists.get(listKey);
    const kept = held && same(held.value, value) ? held.value : value;
    lists.set(listKey, {
      version,
      value: kept
    });
    return kept;
  };
  const listKeyOf = (key, method, of) => `${cacheKeyOf(parts(key))}${KEY_SEP}${method}${KEY_SEP}${stableKey(of)}`;

  /**
   * Whether an entity has one row, which is what decides if a filtered read can share its view model with an unfiltered
   * one. With one row per entity, a filter either includes the entity's row or not, so every read builds the same view
   * model from it. With several, a filter can include some of an entity's rows — a traded player's games for one team —
   * and the view model built from those is a different one, held under the filter. Worked out from the first key, since
   * the partition's filter is a function of one; the same for every key of a store.
   */
  let singleRow;
  const isSingleRow = key => {
    if (singleRow === undefined) {
      const fixed = new Set(Object.keys(filter(key)));
      const rest = table.primaryKey.filter(column => !fixed.has(column));
      singleRow = rest.length === 1 && rest[0] === idColumn;
    }
    return singleRow;
  };
  const scopeOf = (key, extra) => !extra || isSingleRow(key) || !Object.keys(extra).length ? WHOLE_ENTITY : stableKey(extra);
  const warnOnThrash = count => {
    if (!__DEV__ || count <= def.max || thrashWarned.seen(store, name)) return;
    // eslint-disable-next-line no-console
    console.warn(`[${store}_store] the '${name}' cache was asked for ${count} entities but holds ${def.max}, so this read ` + 'evicts what it just built and rebuilds every value on every change. Raise `max` past the largest read, ' + `or read a narrower slice.${def.advice ? ` ${def.advice}` : ''}`);
  };

  /** Builds the view models for `entities` from one query, grouped by entity in storage order. */
  const buildMany = (scope, entityIds) => {
    const grouped = new Map();
    for (const row of table.findIn(scope, idColumn, entityIds)) {
      const id = String(row[idColumn]);
      const list = grouped.get(id);
      if (list) list.push(row);else grouped.set(id, [row]);
    }
    const out = new Map();
    for (const id of entityIds) {
      const rows = grouped.get(id);
      out.set(id, rows ? def.fromRows(rows) : undefined);
    }
    return out;
  };
  function resolve(key, ids, extra) {
    warnOnThrash(ids.length);
    const scope = extra ? {
      ...filter(key),
      ...extra
    } : filter(key);
    return memo.for(key).readMany(ids, scopeOf(key, extra), missing => buildMany(scope, missing));
  }
  const listed = (resolved, order) => {
    const out = [];
    for (const id of order) {
      const vm = resolved.get(id);
      if (vm !== undefined) out.push(vm);
    }
    return out;
  };
  const overFilter = (key, extra) => {
    // Which entities the filter holds can change with any write to the partition, so this depends on all of it.
    const at = version(key);
    const listKey = listKeyOf(key, 'where', extra && Object.keys(extra).length ? extra : null);
    const held = lists.get(listKey);
    if (held && held.version === at) return held.value;
    const scope = extra ? {
      ...filter(key),
      ...extra
    } : filter(key);
    const members = covered(() => table.entityIdsWhere(scope));
    return keep(listKey, listed(resolve(key, members, extra), members), shallowEqualArray, at);
  };
  return {
    at: (key, id) => memo.for(key).read(id, WHOLE_ENTITY, () => {
      const rows = table.find({
        ...filter(key),
        [idColumn]: id
      });
      return rows.length ? def.fromRows(rows) : undefined;
    }),
    atEach: (key, ids) => ids.length ? keep(listKeyOf(key, 'atEach', ids), listed(resolve(key, ids), ids), shallowEqualArray) : NO_VALUES,
    pick: (key, ids) => {
      if (!ids.length) return NO_PICKED;
      const out = {};
      const resolved = resolve(key, ids);
      for (const id of ids) {
        const vm = resolved.get(id);
        if (vm !== undefined) out[id] = vm;
      }
      return keep(listKeyOf(key, 'pick', ids), out, shallowEqualRecord);
    },
    where: (key, extra) => overFilter(key, extra),
    all: key => overFilter(key)
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=derived_values.js.map