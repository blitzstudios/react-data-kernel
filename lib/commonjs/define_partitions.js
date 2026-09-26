"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.definePartitions = definePartitions;
var _react = require("react");
var _args_key = require("./args_key.js");
var _fetch_ingest = require("./write/fetch_ingest.js");
var _surface = require("./read/surface.js");
var _caches = require("./caches.js");
var _cache_block = require("./cache_block.js");
var _version_atom = require("./reactivity/version_atom.js");
var _partition_fields = require("./read/partition_fields.js");
var _prime_state = require("./prime_state.js");
var _store_result = require("./store_result.js");
var _telemetry = require("./diagnostics/telemetry.js");
var _tracking = require("./reactivity/tracking.js");
var _change_set = require("./table/change_set.js");
/**
 * Divides a store's table into partitions and builds the store's fetching and reads on them.
 *
 * A partition is the set of rows one fetch returns and replaces, such as every player in one league, or one week of one
 * sport's stats. It is picked out by column values (its {@linkcode PartitionKeySpec.where | where}, such as `{ league:
 * 'nfl' }`), and it is the entity of everything fetch-related: one React Query query per partition, one ETag per
 * partition, one version number per partition that re-renders its readers. A read names the partition it reads with its
 * args, and reading a partition that has never been fetched fetches it.
 */

/** No partition: args still being filled in, or a slot a caller left empty, which keeps its index in the result. */

/**
 * How a store gets from a read's args to the partition they name, and from the partition to its rows.
 *
 * A partition is the set of rows one fetch returns and replaces. Each has a key, which identifies it everywhere: its
 * React Query query key, its version, its ETag and its fetch state all derive from the key. There are two ways to make
 * the key from a read's args:
 *
 * - {@linkcode PartitionKeySpec.fields | fields}: the key is those args fields, such as `['league']`, and two args with
 *   the same values in them name the same partition. Use this whenever the fields are small values.
 * - {@linkcode PartitionKeySpec.of | of} and {@linkcode PartitionKeySpec.id | id}: {@linkcode PartitionKeySpec.of | of}
 *   turns the args into a partition record (an object describing what to fetch), and
 *   {@linkcode PartitionKeySpec.id | id} turns the record into a string key. For a partition described by more than a
 *   few small fields. Cellar remembers each record by its key, so the fetch can get the record back from the key.
 *
 * Either way, {@linkcode PartitionKeySpec.where | where} turns the key into the column values that pick out the
 * partition's rows in the table.
 */

/**
 * How a store fetches one partition: the request to make, and how the response becomes the partition's rows. A fetch
 * replaces the partition: afterwards the rows matching its {@linkcode PartitionKeySpec.where | where} are exactly the
 * response's rows. Omit it for a store fed only by socket pushes.
 */

/**
 * The configuration of a store's partitions: the table they divide, the version they bump, how read args name a
 * partition and which rows it holds, and how a partition is fetched. A partition is the set of rows one fetch returns
 * and replaces.
 */

/**
 * Options for a store's {@linkcode PartitionLifecycle.usePrime | usePrime} and
 * {@linkcode PartitionLifecycle.usePrimeMany | usePrimeMany} hooks, which start fetching partitions without reading
 * them.
 */

/**
 * Options for a store's {@linkcode PartitionLifecycle.usePrimeAndVersion | usePrimeAndVersion} hook, which fetches a
 * partition and re-renders when it changes.
 */

/** Options for a store's imperative {@linkcode PartitionLifecycle.fetch | fetch}. */

/**
 * The partition operations a store publishes for code outside its reads, grouped as
 * {@linkcode Partitions.lifecycle | lifecycle}: starting fetches, checking whether a partition has rows, and refetching
 * or discarding it. A partition is the set of rows one fetch returns and replaces. Every member takes the same args a
 * read does, and works out the partition from them.
 */

/**
 * Args that carry the read's partitions in the field of that name, where
 * {@linkcode Partitions.defineReadMany | defineReadMany} looks by default.
 */

/** Where a read's partitions come from; `null` and `undefined` both stand for an empty set. */

/**
 * {@linkcode Partitions.defineReadMany | defineReadMany}, naming its partitions as the records a caller holds. Optional
 * when the args already carry them.
 */

/**
 * {@linkcode Partitions.defineReadGrouped | defineReadGrouped}, likewise: one group of candidate records per thing the
 * caller is asking about.
 */

/**
 * What {@linkcode definePartitions} returns to a store's {@linkcode SqliteStoreConfig.build | build}: the functions
 * that declare the store's reads and caches, lower-level access to its partitions for the store's own code,
 * and the {@linkcode Partitions.lifecycle | lifecycle} group to publish. A partition is the set of rows one fetch
 * returns and replaces.
 */

const INTERN_MAX = 512;
const NO_INTERNED = Object.freeze([]);
/** The empty descriptor list {@linkcode Partitions.defineReadMany | defineReadMany} falls back on when args name no partitions. */
const NO_DESCRIPTORS = Object.freeze([]);

/**
 * Divides a store's table into partitions and builds the store's fetching and reads on them. A partition is the set of
 * rows one fetch returns and replaces, picked out by column values (its {@linkcode PartitionKeySpec.where | where}),
 * such as every player in one league.
 *
 * From the config it builds one React Query query per partition that fetches the partition (sending its stored ETag,
 * and writing the response with the native shredder or {@linkcode PartitionFetchSpec.parse | parse}), and bumps the
 * partition's version with the entities the write changed, which re-renders the readers of those entities. It returns
 * the functions that declare the store's reads and caches on those partitions, and the
 * {@linkcode Partitions.lifecycle | lifecycle} operations to publish. Call it from a store's
 * {@linkcode SqliteStoreConfig.build | build}, after {@linkcode RowTable.init | table.init()}.
 */
function definePartitions(config) {
  const {
    name,
    table,
    version,
    key: keySpec,
    fetch: fetchSpec
  } = config;
  const where = keySpec.where;

  /** A key's parts: its positional form, which reaches only as far as the version and query keys. */
  const fields = keySpec.fields;
  const toParts = !fields ? key => [key ?? ''] : fields.length === 1 ? key => [key[fields[0]] ?? ''] : key => fields.map(field => key[field] ?? '');

  /** The record⇄key mapping. Bounded; every path to a key re-registers, so a live partition's entry stays warm. */
  const toId = keySpec.id;
  const interned = toId ? (0, _caches.createBoundedLru)(config.internMax ?? INTERN_MAX) : undefined;
  const keyOf = partition => {
    if (!toId || !interned) return partition;
    const key = toId(partition);
    interned.set(key, partition);
    return key;
  };
  /**
   * The key an absent partition maps to: all-empty parts, which {@linkcode addressesPartition} rejects, so nothing is
   * read or primed.
   */
  const GAP_KEY = fields ? Object.freeze({}) : '';
  const keyOfMaybe = partition => partition == null ? GAP_KEY : keyOf(partition);
  const describe = key => {
    if (!interned) return key;
    const partition = interned.get(key);
    if (partition) return partition;

    // Evicted, so re-derive it if the store can. Re-interned on the way past, since something is asking about
    // this partition again and the next ask should be a hit.
    const reparsed = keySpec.from?.(key);
    if (reparsed != null) {
      interned.set(key, reparsed);
      return reparsed;
    }

    // Nothing else in Cellar fails a read outright, and this is the one bound that can. A store whose keys
    // are parseable should declare `from`; one whose keys are not needs a larger `internMax`.
    (0, _telemetry.reportStoreDegradation)({
      scope: `partitions.intern_evicted.${name}`,
      context: `${name}_store: partition ${String(key)} left the key table, so it cannot be addressed again`,
      extra: {
        internMax: config.internMax ?? INTERN_MAX
      }
    });
    throw new Error(`${name}_store: unknown partition ${String(key)}`);
  };

  /**
   * How a read and every {@linkcode Partitions.lifecycle | lifecycle} member gets from args to the key;
   * {@linkcode PartitionKeySpec.of | key.of} reads them at their loosest.
   */
  const keyOfArgs = keySpec.of ? args => keyOfMaybe(keySpec.of(args)) : !fields ? args => args :
  // The fields are named against `Key` and here pick out of `Args`, which `defaultPartition` already requires.
  (0, _partition_fields.partitionKeyOf)(fields);
  const bump = (key, changes = _change_set.ALL_ENTITIES) => {
    const parts = toParts(key);
    if ((0, _change_set.isUnchanged)(changes)) return version.get(parts);
    const next = version.bump(parts, changes);
    config.onChanged?.(key, next, changes);
    return next;
  };

  /** When each partition's rows last landed. Bounded, and a forgotten timestamp reads as never-fetched. */
  const fetchedAt = (0, _caches.createBoundedLru)(config.internMax ?? INTERN_MAX);

  /** Replaces the partition's rows, through the native shred where the body allows it and JS parsing otherwise. */
  async function ingestRaw(key, rawJson) {
    const spec = fetchSpec;
    const partition = describe(key);
    const rowsWhere = where(key);
    const parse = raw => spec.parse(partition, raw, key);
    const inJs = () => table.overwrite(rowsWhere, parse(rawJson));
    let result;
    if (spec.canShredNatively?.(partition) === false) {
      result = inJs();
    } else {
      try {
        result = await table.shred(rowsWhere, rawJson, parse);
      } catch (error) {
        (0, _telemetry.reportStoreDegradation)({
          scope: `${name}_store.raw_ingest`,
          context: 'async raw ingest failed; re-parsed and retried through the synchronous path',
          error,
          extra: {
            store: name,
            partition: (0, _args_key.partitionLabel)(toParts(key))
          }
        });
        result = inJs();
      }
    }
    fetchedAt.set((0, _args_key.cacheKeyOf)(toParts(key)), Date.now());
    return result;
  }
  const ingest = fetchSpec ? (0, _fetch_ingest.createFetchIngest)({
    ingestKeyRoot: `${name}_store_ingest`,
    version,
    toParts,
    rawQuery: interned ? (key, etag) => fetchSpec.query(describe(key), etag) : fetchSpec.query,
    getEtag: key => table.getMeta(where(key)),
    setEtag: (key, etag) => table.setMeta(where(key), etag),
    ingestRaw,
    bump,
    holdWrites: fetchSpec.holdWrites
  }) : undefined;
  const surface = (0, _surface.createReadSurface)({
    name,
    version,
    toParts,
    has: key => table.has(where(key)),
    hasFetched: key => fetchedAt.get((0, _args_key.cacheKeyOf)(toParts(key))) !== undefined,
    defaultPartition: keySpec.of ? keyOfArgs : fields,
    ingest
  });

  /** Whether the partition holds rows. Tracks, since the surface's probe takes the version on every call. */
  const has = key => surface.has(key);
  const versionOf = key => version.get(toParts(key));
  /** What every memo this store declares is bound by: a partition's version, and each entity's. */
  const memoBinding = {
    parts: toParts,
    version: versionOf,
    entityVersion: (key, entityId) => version.getEntity(toParts(key), entityId)
  };

  // Bound once, so the hook a component calls is the same one on every render.
  const usePriming = ingest?.usePrime ?? _prime_state.NO_PRIMING;
  const usePrimingAll = ingest?.usePrimeMany ?? _prime_state.NO_PRIMING;

  /**
   * The key a priming hook's args address. Args short of a value are `keyOfArgs`' business as usual: a missing field
   * becomes an empty part and {@linkcode PartitionKeySpec.of | key.of} answers `null`, and either way
   * {@linkcode addressesPartition} rejects the key, so nothing is primed.
   */
  const keyOfHookArgs = args => keyOfArgs(args);
  function usePrimeAndVersion(args, options) {
    const key = args === undefined ? undefined : keyOfHookArgs(args);
    const parts = key === undefined ? _version_atom.NO_PARTS : toParts(key);
    const isEnabled = (options?.enabled ?? true) && key !== undefined && (0, _version_atom.addressesPartition)(parts);
    // `prime: false` keeps the version subscription and drops only the fetch, the same split `ReadCallOptions` makes.
    const prime = usePriming(key, isEnabled && options?.prime !== false);
    const ver = version.useVersion(parts, isEnabled);
    const partsKey = (0, _args_key.cacheKeyOf)(parts);
    const status = (0, _tracking.runSubscribed)(() => (0, _store_result.offHeapStatus)(isEnabled, isEnabled && surface.has(key), prime));
    const doRefetch = (0, _react.useCallback)(() => {
      if (key !== undefined) ingest?.refetch(key);
    }, [partsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `partsKey` covers `key`
    return (0, _surface.useResult)(ver, status, prime.isFetching, doRefetch);
  }

  /** Both set reads name their partitions as records; the keys they address are this layer's to resolve. */
  function readManyOf() {
    return def => {
      const named = def.partitions ?? (args => args.partitions);
      return surface.readMany()({
        ...def,
        partitions: args => (named(args) ?? NO_DESCRIPTORS).map(keyOfMaybe)
      });
    };
  }
  function readGroupedOf() {
    return def => {
      const groups = args => def.groups(args).map(group => group.map(keyOfMaybe));
      return surface.readGrouped()({
        ...def,
        groups
      });
    };
  }
  return {
    defineRead: surface.read,
    defineReadMany: readManyOf,
    defineReadGrouped: readGroupedOf,
    defineCaches: decls => (0, _cache_block.bindCaches)(name, memoBinding, decls, {
      table,
      filter: where
    }),
    where,
    keyOf,
    internedKeys: () => interned ? interned.keys() : NO_INTERNED[Symbol.iterator](),
    has,
    versionOf,
    bump,
    clearEtag: key => table.setMeta(where(key), undefined),
    lifecycle: {
      usePrime: (args, options) => usePriming(args === undefined ? undefined : keyOfHookArgs(args), options?.enabled ?? true),
      usePrimeMany: (args, options) => usePrimingAll(args.map(keyOfArgs), options?.enabled ?? true),
      usePrimeAndVersion,
      has: args => has(keyOfArgs(args)),
      getVersion: args => versionOf(keyOfArgs(args)),
      getFetchedAt: args => {
        const parts = toParts(keyOfArgs(args));
        // Read for its tracking side effect, so a derivation gating on this getter hears about the change.
        version.get(parts);
        return fetchedAt.get((0, _args_key.cacheKeyOf)(parts)) ?? 0;
      },
      fetch: (args, options) => ingest ? ingest.prefetch(keyOfArgs(args), options).then(() => undefined) : Promise.resolve(),
      refetch: args => ingest?.refetch(keyOfArgs(args)),
      invalidate: args => ingest?.invalidate(keyOfArgs(args)),
      forget: () => ingest?.forget()
    }
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=define_partitions.js.map