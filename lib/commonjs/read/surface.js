"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createReadSurface = createReadSurface;
exports.useResult = useResult;
var _react = require("react");
var _args_key = require("../args_key.js");
var _collections = require("../collections.js");
var _partition_fields = require("./partition_fields.js");
var _caches = require("../caches.js");
var _version_atom = require("../reactivity/version_atom.js");
var _once_guard = require("../diagnostics/once_guard.js");
var _log_level = require("../diagnostics/log_level.js");
var _prime_state = require("../prime_state.js");
var _store_result = require("../store_result.js");
var _tracking = require("../reactivity/tracking.js");
var _tracked_value = require("../reactivity/tracked_value.js");
var _read_coverage = require("../table/read_coverage.js");
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

/**
 * The parts of a store's fetch ingest that its reads use: the hooks that fetch partitions, and imperative fetch starts.
 */

/**
 * What a store's reads need from the store: its version atom, how a partition key becomes its version key, whether a
 * partition has rows or has been fetched, and the fetch ingest. {@linkcode definePartitions} builds this for each
 * store.
 */

/**
 * A read's {@linkcode CommonDef.varyBy | varyBy}: the args, beyond the partition, that its value depends on. Either a
 * list of args field names, such as `['playerId']`, or a function that computes the values from the args.
 */

/**
 * The args a read's {@linkcode ReadDef.select | select} receives: only the fields its
 * {@linkcode CommonDef.varyBy | varyBy} lists, each typed as non-null, since {@linkcode ReadDef.select | select} only
 * runs once all of them have values. Reading any other arg in {@linkcode ReadDef.select | select} is a type error,
 * because a hook runs {@linkcode ReadDef.select | select} again only when its partition or its
 * {@linkcode CommonDef.varyBy | varyBy} values change; a value computed from an unlisted arg would go stale when that
 * arg changed. A read whose {@linkcode CommonDef.varyBy | varyBy} is a function lists no fields, so its
 * {@linkcode ReadDef.select | select} receives the whole args.
 */

/**
 * Hands `select` the whole args object, which carries the fields it declared and others it cannot see. Sound because
 * the narrowing exists to stop a store *writing* a reach into an undeclared arg, not to hide anything at runtime.
 */
function overArgs(select) {
  return select;
}

/**
 * The fields every kind of read definition shares ({@linkcode Partitions.defineRead | defineRead},
 * {@linkcode Partitions.defineReadMany | defineReadMany} and
 * {@linkcode Partitions.defineReadGrouped | defineReadGrouped}).
 */

/**
 * The definition of a read of one partition. The args name one partition (through
 * {@linkcode ReadDef.partition | partition}, or the store's key fields by default); the read fetches it if it has never
 * been fetched, and {@linkcode ReadDef.select | select} computes the value from its rows. Nearly every read is this
 * kind. For a read across several partitions, use {@linkcode ReadManyDef}; for several lookups at once, each with its
 * own candidate partitions, use {@linkcode ReadGroupedDef}.
 */

/**
 * The definition of a read across several partitions, fetched and subscribed to together and computed into one value,
 * such as one player's stat rows across several weeks, one partition per week. {@linkcode ReadManyDef.select | select}
 * gets the partition keys as one flat list. For several lookups at once, each with its own candidate partitions, use
 * {@linkcode ReadGroupedDef}.
 */

/**
 * The definition of a read that answers several lookups at once, where each lookup's rows could be in any of several
 * candidate partitions, such as a stat row for each of several stat keys, where each key could be in more than one
 * partition. {@linkcode ReadGroupedDef.groups | groups} gives each lookup's candidate partitions; all of them are
 * fetched and subscribed to; {@linkcode ReadGroupedDef.select | select} gets the groups back in the same order, so it
 * can answer each lookup from its own candidates.
 */

/**
 * Options one caller passes to a read's {@linkcode Read.useValue | useValue} hook, on top of what the read's definition
 * fixes. They apply to that call only.
 */

/**
 * A declared read, as a store's {@linkcode StoreSurface.reads | reads} hold it: a hook
 * ({@linkcode Read.useValue | useValue}) and a getter ({@linkcode Read.getValue | getValue}) that return the same
 * value. Both take the read's args, or `undefined` when the caller doesn't have them yet, which returns
 * {@linkcode CommonDef.empty | empty}.
 */

/** Stable identities so a disabled read's hooks keep the same deps across renders. */
const NO_KEYS = Object.freeze([]);
const NO_GROUPS = Object.freeze([]);
const NO_PARTITIONS = Object.freeze([]);
const NO_ARGS_KEY = `${_args_key.KEY_SEP}disabled`;

/** Above one viewport's worth of rows: a virtualized list self-limits around 20-30. */
const FANOUT_WARN_THRESHOLD = 48;

/** Entries in a surface's presence cache, which is keyed by partition and so bounds live partitions. */
const PRESENCE_CACHE_MAX = 512;
const fanoutWarned = (0, _once_guard.createOnceGuard)();
let fanoutTick = null;
(0, _once_guard.onGuardReset)(() => {
  fanoutTick = null;
});
function flushFanout() {
  const tick = fanoutTick;
  fanoutTick = null;
  if (!(0, _log_level.shouldLog)('warn')) return;
  tick?.forEach((entry, store) => {
    if (entry.keys.size <= FANOUT_WARN_THRESHOLD || fanoutWarned.seen(store)) return;
    const sample = [...entry.keys].slice(0, 3).join(', ');
    // Already-batched callers need the opposite advice from per-row ones: telling a list that reads five ids a row
    // to "use a plural read" describes what it is doing, and it stops reading the warning.
    const remedy = entry.batched ? 'These reads are already plural, so the fix is not a plural read but one read higher up: lift it to the ' + "parent over the union of what its rows ask for, and let each row index into that result. If the rows' " + 'sets come from a list the parent already holds, `createWindowedList` resolves them against it.' : 'A list is reading per row, which puts one subscription and one hydration on the heap per row. Read the ' + "set once in the parent — a plural `*ByIds` read, or `createWindowedList` so rows resolve against the " + "parent's list — and let each row index into that.";
    // eslint-disable-next-line no-console
    console.warn(`[${store}_store] ${entry.keys.size} separate reads in one tick (e.g. ${sample}). ${remedy} Note that a ` + 'plural read still primes by PARTITION, not by the ids it asks for, so if this partition is coarse the ' + 'parent read fetches all of it either way and this is about subscriptions rather than fetching; where the ' + 'rows are already to hand from the payload that listed them, prefer rendering from those and declaring ' + '`prime: false`.');
  });
}

/**
 * `batchSize` is the widest array a read varies by, so a caller already asking for a set can be told something else.
 */
function noteRead(store, argsKey, batchSize) {
  if (fanoutWarned.has(store)) return;
  if (!fanoutTick) {
    fanoutTick = new Map();
    setTimeout(flushFanout, 0);
  }
  const entry = (0, _collections.getOrCreate)(fanoutTick, store, () => ({
    keys: new Set(),
    batched: false
  }));
  entry.keys.add(argsKey);
  if (batchSize > 1) entry.batched = true;
}

/** The widest set a read is varying by: 1 when it names one thing, which is the per-row shape the warning is for. */
function batchSizeOf(vary) {
  let widest = 1;
  for (const value of vary) if (Array.isArray(value) && value.length > widest) widest = value.length;
  return widest;
}

/** Returns a {@linkcode DataResult} whose identity is stable across renders while its parts hold. */
function useResult(data, status, isFetching, doRefetch) {
  return (0, _react.useMemo)(() => (0, _store_result.makeResult)(data, status, {
    isFetching,
    refetch: doRefetch
  }), [data, status, isFetching, doRefetch]);
}

/** What a read's value depends on beyond its partitions, resolved once per read. */
function varyResolver(def) {
  return def.varyBy ? (0, _partition_fields.varyValuesOf)(def.varyBy) : () => _args_key.EMPTY_VARY;
}

/**
 * What a read wants of the partitions it primes. A {@linkcode CommonDef.varyBy | varyBy} is the read saying it selects
 * part of one, which is the only shape where an oversized ingest is worth reporting; a read without one is asking for
 * the partition.
 */
function intentOf(def) {
  return def.varyBy ? SELECTS_SLICE : undefined;
}
const SELECTS_SLICE = {
  slice: true
};

/**
 * Whether a read may prime its partitions and whether its {@linkcode ReadDef.select | select} may run. Priming asks
 * strictly less: a read still waiting on a vary value primes anyway, so the rows are there when the value arrives.
 */
function readGates(def, args, addressable, vary, primeWanted) {
  return {
    // Both the declaration and the call site can veto priming, and neither can override the other: a read that
    // declares `prime: false` never fetches, and a caller passing `prime: false` never fetches, whoever else does.
    prime: addressable && primeWanted && (def.prime ?? true),
    read: addressable && vary.every(_args_key.isVaryPresent) && (def.enabled?.(args) ?? true)
  };
}

/**
 * The status and {@linkcode DataResult} every read ends with; `hasData` is a thunk, called once the read is known
 * enabled.
 */
function useReadTail(data, enabled, hasData, prime, doRefetch) {
  const status = (0, _tracking.runSubscribed)(() => (0, _store_result.offHeapStatus)(enabled, enabled && hasData(), prime));
  return useResult(data, status, prime.isFetching, doRefetch);
}

/**
 * Builds the read engine over one store's partitions: {@linkcode Partitions.defineRead | defineRead} /
 * {@linkcode Partitions.defineReadMany | defineReadMany} / {@linkcode Partitions.defineReadGrouped | defineReadGrouped}
 * each take a descriptor and hand back its {@linkcode Read.useValue | useValue} / {@linkcode Read.getValue | getValue}
 * pair, with the priming, the version subscription and the presence gate already wrapped around
 * {@linkcode ReadDef.select | select}. {@linkcode definePartitions} builds one per store, so stores declare reads.
 */
function createReadSurface(kernel) {
  const {
    ingest,
    toParts
  } = kernel;
  const usePriming = ingest?.usePrime ?? _prime_state.NO_PRIMING;
  const usePrimingAll = ingest?.usePrimeMany ?? _prime_state.NO_PRIMING;

  /** Whether each partition holds rows, keyed by partition and shared by every read on this surface. */
  const presenceByVersion = (0, _caches.createVersionedCache)(PRESENCE_CACHE_MAX);
  // Held against the presence version, which moves only on a write that could have emptied or filled the partition,
  // and tracks presence alone: a read of one entity must not come to depend on the whole partition by asking this.
  const hasOne = (key, parts) => presenceByVersion.read((0, _args_key.cacheKeyOf)(parts), kernel.version.getPresence(parts), () => (0, _read_coverage.covered)(() => kernel.has(key)));
  const hasAny = entries => entries.some(entry => (0, _version_atom.addressesPartition)(entry.parts) && hasOne(entry.key, entry.parts));

  /**
   * Starts an unfetched partition's fetch. Only {@linkcode Read.getValue | getValue} needs it; a reactive read primes
   * through {@linkcode PartitionLifecycle.usePrime | usePrime}. Cold means never fetched, not empty: a partition
   * holding rows a socket pushed into it has never had its body, and gating on rows would leave it on that one row for
   * the session.
   */
  const primeIfCold = (key, parts) => {
    if (!ingest) return;
    const fetched = kernel.hasFetched ? kernel.hasFetched(key) : hasOne(key, parts);
    if (!fetched) ingest.ensure(key);
  };

  /**
   * Runs a read's `select` and makes sure the result depends on enough. A `select` built from `byEntity` caches reports
   * the entities it read and depends on those alone. One that read rows straight off the table, or reported
   * nothing at all, is made to depend on every partition it named: it could have read anything in them.
   */
  const selectTracked = (partitions, select) => {
    const before = (0, _read_coverage.uncoveredReads)();
    const {
      value,
      deps
    } = (0, _tracking.runTracked)(select);
    for (const dep of deps) (0, _tracking.trackDependency)(dep);
    if (!deps.length || (0, _read_coverage.uncoveredReads)() !== before) for (const parts of partitions) if ((0, _version_atom.addressesPartition)(parts)) kernel.version.get(parts);
    return value;
  };
  function defineRead(def) {
    const spec = def.partition ?? kernel.defaultPartition;
    if (!spec) throw new Error(`${kernel.name ?? 'off_heap'}_store: this read needs a \`partition\`, since the store's key declares no \`fields\` to default to`);
    const keyOf = (0, _partition_fields.partitionKeyOf)(spec);
    const varyOf = varyResolver(def);
    const primeIntent = intentOf(def);
    const select = overArgs(def.select);
    const gatesFor = (args, parts, vary, wanted, primeWanted = true) => readGates(def, args, wanted && (0, _version_atom.addressesPartition)(parts), vary, primeWanted);
    const run = (args, key, parts) => selectTracked([parts], () => select(args, key));
    function getValue(args) {
      if (args === undefined) return def.empty;
      const key = keyOf(args);
      const parts = toParts(key);
      if (!(0, _version_atom.addressesPartition)(parts)) return def.empty;
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
    function useValue(args, options) {
      // `partition`, `varyBy` and `select` assume a real partition; the hooks below still run, reading nothing.
      const key = args === undefined ? undefined : keyOf(args);
      const parts = key === undefined ? _version_atom.NO_PARTS : toParts(key);
      const vary = args === undefined ? _args_key.EMPTY_VARY : varyOf(args);
      const gates = gatesFor(args, parts, vary, (options?.enabled ?? true) && args !== undefined, options?.prime ?? true);
      const prime = usePriming(key, gates.prime, primeIntent);
      const argsKey = args === undefined ? NO_ARGS_KEY : (0, _args_key.varyKey)(parts, vary);
      if (__DEV__ && gates.read) noteRead(kernel.name ?? 'off_heap', argsKey, batchSizeOf(vary));
      const data = (0, _tracked_value.useTrackedValue)(() => hasOne(key, parts) ? run(args, key, parts) : def.empty, [argsKey], {
        enabled: gates.read,
        isEqual: def.isEqual ?? _caches.shallowEqualValue,
        empty: def.empty
      });
      const doRefetch = (0, _react.useCallback)(() => {
        if (key !== undefined) ingest?.refetch(key);
      }, [argsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `argsKey` covers `key`
      return useReadTail(data, gates.read, () => (0, _version_atom.addressesPartition)(parts) && hasOne(key, parts), prime, doRefetch);
    }
    return {
      getValue,
      useValue,
      requires: def.requires ?? (0, _partition_fields.requiredFieldsOf)(spec, def.varyBy)
    };
  }

  /**
   * The engine behind {@linkcode Partitions.defineReadMany | defineReadMany} and
   * {@linkcode Partitions.defineReadGrouped | defineReadGrouped}, which differ only in what `select` is handed back:
   * the flat keys, or the groups they were named in. `resolve` runs once per call because naming a partition may intern
   * it.
   */
  function manyRead(def, resolve, select, noneNamed) {
    const varyOf = varyResolver(def);
    const primeIntent = intentOf(def);
    const argsKeyOf = (partitions, vary) => (0, _args_key.varyKey)([(0, _args_key.partitionsKey)(partitions)], vary);
    const resolveOr = args => args === undefined ? {
      keys: NO_KEYS,
      named: noneNamed
    } : resolve(args);

    /**
     * {@linkcode Partitions.defineRead | defineRead}'s gates over a set: addressable when at least one partition is,
     * since the rest are gaps.
     */
    const gatesFor = (args, partitions, vary, wanted, primeWanted = true) => readGates(def, args, wanted && partitions.some(_version_atom.addressesPartition), vary, primeWanted);
    const run = (args, named, partitions) => selectTracked(partitions, () => select(args, named));

    /** Presence of every partition named, which is what a read reports when it has nothing else to depend on. */
    const trackPresence = partitions => {
      for (const parts of partitions) if ((0, _version_atom.addressesPartition)(parts)) kernel.version.getPresence(parts);
    };
    function getValue(args) {
      if (args === undefined) return def.empty;
      const {
        keys,
        named
      } = resolve(args);
      const entries = (0, _version_atom.partitionEntries)(keys, toParts);
      const partitions = entries.map(entry => entry.parts);
      const vary = varyOf(args);
      const gates = gatesFor(args, partitions, vary, true);
      if (gates.prime) for (const entry of entries) if ((0, _version_atom.addressesPartition)(entry.parts)) primeIfCold(entry.key, entry.parts);
      // `hasAny` stops at the first partition holding rows, so the rest are reported here for a read that lands later.
      trackPresence(partitions);
      if (!gates.read || !hasAny(entries)) return def.empty;
      return run(args, named, partitions);
    }
    function useValue(args, options) {
      const {
        keys,
        named
      } = resolveOr(args);
      const entries = args === undefined ? [] : (0, _version_atom.partitionEntries)(keys, toParts);
      const partitions = args === undefined ? NO_PARTITIONS : entries.map(entry => entry.parts);
      const vary = args === undefined ? _args_key.EMPTY_VARY : varyOf(args);
      const gates = gatesFor(args, partitions, vary, (options?.enabled ?? true) && args !== undefined, options?.prime ?? true);
      const prime = usePrimingAll(keys, gates.prime, primeIntent);
      const argsKey = args === undefined ? NO_ARGS_KEY : argsKeyOf(partitions, vary);
      const data = (0, _tracked_value.useTrackedValue)(() => {
        trackPresence(partitions);
        return hasAny(entries) ? run(args, named, partitions) : def.empty;
      }, [argsKey], {
        enabled: gates.read,
        isEqual: def.isEqual ?? _caches.shallowEqualValue,
        empty: def.empty
      });
      const doRefetch = (0, _react.useCallback)(() => {
        for (const key of keys) ingest?.refetch(key);
      }, [argsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `argsKey` covers `keys`
      return useReadTail(data, gates.read, () => hasAny(entries), prime, doRefetch);
    }
    return {
      getValue,
      useValue,
      requires: def.requires
    };
  }
  function defineReadMany(def) {
    const resolve = args => {
      const keys = def.partitions(args);
      return {
        keys,
        named: keys
      };
    };
    return manyRead(def, resolve, overArgs(def.select), NO_KEYS);
  }
  function defineReadGrouped(def) {
    const resolve = args => {
      const named = def.groups(args);
      const keys = [];
      for (const group of named) for (const key of group) keys.push(key);
      return {
        keys,
        named
      };
    };
    return manyRead(def, resolve, overArgs(def.select), NO_GROUPS);
  }

  /** The surface's cached presence probe, so a store asks the same question the reads gate on. */
  const has = key => hasOne(key, toParts(key));
  return {
    /**
     * Declares a read, in two calls: `read<Args, Value>()({ … })`. The first names what the read takes and returns, the
     * second takes the read itself — separately, because that is what leaves TypeScript free to infer
     * {@linkcode CommonDef.varyBy | varyBy} from the list a read spells, which is how
     * {@linkcode ReadDef.select | select} comes to see those fields and no others.
     */
    read: () => defineRead,
    readMany: () => defineReadMany,
    readGrouped: () => defineReadGrouped,
    has
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=surface.js.map