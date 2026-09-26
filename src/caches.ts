/**
 * Caches for values a store computes from its table rows, each holding a fixed number of entries.
 *
 * A store's rows live in SQLite, and every query returns new objects, so anything computed from them (a view model, a
 * ranking, a lookup map) would be rebuilt on every read without a cache. A cache keeps each computed value together
 * with the version of the rows it was computed from, and returns it until those rows change: a {@linkcode byPartition}
 * cache until any write to its partition (the set of rows one fetch returns and replaces), a {@linkcode byEntity} cache
 * until a write changes its entity's rows (an entity is the thing a row belongs to, such as one player, named by the
 * table's `entityId` column). When a value is rebuilt and `isEqual` finds it equal to the previous one, the previous
 * object is kept, so readers don't re-render. Stores declare their caches in one block,
 * {@linkcode Partitions.defineCaches | defineCaches}.
 *
 * The per-partition machinery underneath is a memo: {@linkcode byPartition}'s entries, and {@linkcode entityMemo},
 * which holds a {@linkcode byEntity} cache's values.
 */

import { identityOf, KEY_SEP, cacheKeyOf } from './args_key';
import { reportStoreDegradation } from './diagnostics/telemetry';
import { covered } from './table/read_coverage';
import type { CommonDef, ReadDef } from './read/surface';
import type { Partitions } from './define_partitions';
import type { byEntity } from './read/derived_values';

const EVICTION_GHOSTS = 256;
const UNDERSIZED_REPORT_AT = 256;
const NEVER_HIT_REPORT_AT = 512;

/** How a memo is described in its dev reports (a memo too small for what it's asked to hold, or one never used). */
export interface MemoDiagnostics {
  /** The memo's name, as `store.memo`, such as `player.byTeam`. */
  name: string;
  /** What the memo's entries are keyed by, for the report's text, such as `partition + entity + scope`. */
  keyedBy: string;
}

/**
 * The watch a declared memo carries in dev. It reports one too small for its working set — a key evicted for capacity,
 * then asked for again — and one that has never once answered from its entry, which is heap held for nothing.
 */
function createMemoWatch({ name, keyedBy }: MemoDiagnostics, maxEntries: number) {
  const ghosts = new Set<string>();
  let returned = 0;
  let missed = 0;
  let earned = false;
  return {
    onEvict: (key: string): void => {
      ghosts.add(key);
      if (ghosts.size > EVICTION_GHOSTS) ghosts.delete(ghosts.values().next().value as string);
    },
    /** Call on a lookup that answered from the entry, which is how a memo shows it is earning its heap. */
    noteHit: (): void => {
      earned = true;
    },
    /** Call on a lookup that did not; `absent` separates an evicted key from an entry held at another version. */
    noteMiss: (key: string, absent: boolean): void => {
      if (!earned) {
        missed += 1;
        if (missed === NEVER_HIT_REPORT_AT)
          reportStoreDegradation({
            scope: `memo.never_hit.${name}`,
            context: `${NEVER_HIT_REPORT_AT} lookups keyed by ${keyedBy} never answered from the entry, so whatever calls this already holds the value`,
            extra: { maxEntries },
          });
      }
      if (!absent || !ghosts.delete(key)) return;
      returned += 1;
      if (returned !== UNDERSIZED_REPORT_AT) return;
      reportStoreDegradation({
        scope: `memo.undersized.${name}`,
        context: `${UNDERSIZED_REPORT_AT} keys evicted for capacity were read again, so values keyed by ${keyedBy} are being rebuilt and their readers repainted`,
        extra: { maxEntries },
      });
    },
  };
}

/**
 * A map with string keys that holds at most a fixed number of entries: when a new key would exceed the limit, the
 * least recently used entry (the one read or written longest ago) is removed. Every cache in Cellar is built on
 * one, and a store can use one for a lookup table of its own that shouldn't grow without limit.
 */
export interface BoundedLru<V> {
  /**
   * The value stored under `key`, which also marks it as recently used. Returns `undefined` both for a key that isn't
   * stored and for a stored `undefined`; store values wrapped in an object if the two must be told apart.
   */
  get(key: string): V | undefined;
  /**
   * Stores `value` under `key` and marks it as recently used. If that makes the map exceed its limit, removes the least
   * recently used entry.
   */
  set(key: string, value: V): void;
  /** Every stored key, from least to most recently used. */
  keys(): IterableIterator<string>;
}

/**
 * One entry's place in the recency list: {@linkcode LruNode.older | older} runs toward the coldest end,
 * {@linkcode LruNode.newer | newer} toward the hottest.
 */
type LruNode<V> = { key: string; value: V; older: LruNode<V> | undefined; newer: LruNode<V> | undefined };

/**
 * Creates a {@linkcode BoundedLru}: a map with string keys that holds at most `max` entries, removing the least
 * recently used one to make room. `onEvict` is called with the key of each entry removed that way.
 */
export function createBoundedLru<V>(max: number, onEvict?: (key: string) => void): BoundedLru<V> {
  const map = new Map<string, LruNode<V>>();
  // Recency rides a linked list rather than `Map` insertion order: reordering by re-inserting
  // allocates a fresh entry on every hit, and hits are the hot path. Relinking mutates nodes.
  let oldest: LruNode<V> | undefined;
  let newest: LruNode<V> | undefined;

  const unlink = (node: LruNode<V>): void => {
    if (node.older) node.older.newer = node.newer;
    else oldest = node.newer;
    if (node.newer) node.newer.older = node.older;
    else newest = node.older;
    node.older = undefined;
    node.newer = undefined;
  };

  const linkNewest = (node: LruNode<V>): void => {
    node.older = newest;
    if (newest) newest.newer = node;
    else oldest = node;
    newest = node;
  };

  const touch = (node: LruNode<V>): void => {
    if (node === newest) return;
    unlink(node);
    linkNewest(node);
  };

  return {
    *keys() {
      for (let node = oldest; node !== undefined; node = node.newer) yield node.key;
    },
    get(key) {
      // A present key always has a node, so a stored `undefined` still reads as a hit.
      const node = map.get(key);
      if (node === undefined) return undefined;
      touch(node);
      return node.value;
    },
    set(key, value) {
      const existing = map.get(key);
      if (existing !== undefined) {
        existing.value = value;
        touch(existing);
        return;
      }
      const node: LruNode<V> = { key, value, older: undefined, newer: undefined };
      map.set(key, node);
      linkNewest(node);
      if (map.size > max && oldest !== undefined && oldest !== node) {
        const evicted = oldest;
        unlink(evicted);
        map.delete(evicted.key);
        onEvict?.(evicted.key);
      }
    },
  };
}

/**
 * A cache whose entries each remember the version number they were computed at (typically a partition's version,
 * which goes up on every write that changes it). A lookup passes the current version, and an entry from any other
 * version counts as missing, so each value is recomputed once after each write and served from the cache in between.
 * When a recomputed value is equal to the previous one by `isEqual`, the previous object is kept.
 */
export interface VersionedCache<V> {
  /**
   * The value stored for `key` at `version`. On a miss (no entry, or one from another version), runs `compute`,
   * stores its result at `version`, and returns it (or the previous object, if `isEqual` finds them equal).
   */
  read(key: string, version: number, compute: () => V): V;
  /**
   * The value stored for `key` at `version`, without computing anything: `{ value }` on a hit, `undefined` on a miss.
   * Wrapped so that a stored `undefined` can be told apart from a miss.
   */
  peek(key: string, version: number): { value: V } | undefined;
  /**
   * Stores `value` for `key` at `version`, and returns the object to use from now on: the previous value's object if
   * `isEqual` finds the two equal, otherwise `value`.
   */
  set(key: string, version: number, value: V): V;
}

/**
 * Creates a {@linkcode VersionedCache} holding at most `maxEntries` values, removing the least recently used to make
 * room. Stores declare theirs through {@linkcode createMemos} rather than calling this.
 */
export function createVersionedCache<V>(maxEntries: number, isEqual?: (prev: V, next: V) => boolean, diagnostics?: MemoDiagnostics): VersionedCache<V> {
  const watch = __DEV__ && diagnostics ? createMemoWatch(diagnostics, maxEntries) : undefined;
  const lru = createBoundedLru<{ version: number; value: V }>(maxEntries, watch?.onEvict);
  const cache: VersionedCache<V> = {
    read(key, version, compute) {
      const hit = cache.peek(key, version);
      return hit ? hit.value : cache.set(key, version, compute());
    },
    peek(key, version) {
      const hit = lru.get(key);
      const found = hit && hit.version === version ? hit : undefined;
      if (watch) {
        if (found) watch.noteHit();
        else watch.noteMiss(key, !hit);
      }
      return found;
    },
    set(key, version, value) {
      // Read by key alone: reference reuse has to survive the bump that triggered the recompute.
      const prior = lru.get(key);
      const stored = prior && isEqual && isEqual(prior.value, value) ? prior.value : value;
      lru.set(key, { version, value: stored });
      return stored;
    },
  };
  return cache;
}

/**
 * One part of a cache entry's key, beyond the partition (and entity): a string, number, boolean, null or undefined, or
 * an object or array, such as a scoring config. Objects and arrays are compared by content, and each distinct content
 * is replaced in the key by a short id, so a large object doesn't make every key long.
 */
export type CacheKeyPart = string | number | boolean | null | undefined | readonly unknown[] | Record<string, unknown>;

/** One {@linkcode CacheKeyPart} per name the cache declared in {@linkcode MemoDecl.by | by}, in that order. */
type PartsOf<By extends readonly string[]> = { -readonly [Index in keyof By]: CacheKeyPart };

/**
 * A {@linkcode byPartition} cache's entries for one partition, as `.for(key)` returns them. A partition is the set of
 * rows one fetch returns and replaces. Entries are keyed by the parts the cache's second type argument lists, passed in
 * that order, and every entry counts as missing after any write that changes the partition.
 *
 * `.for(key)` reads the partition's version when it is called, so call it where the value is needed rather than
 * keeping its result. It is tracked: a read whose {@linkcode ReadDef.select | select} calls it depends on the whole
 * partition, and re-runs after any write that changes it.
 */
export interface BoundVersionMemo<V, Parts extends readonly CacheKeyPart[]> {
  /**
   * The value stored for these key parts. On a miss (never computed, or computed before the partition's last write),
   * runs `build`, stores its result, and returns it (or the previous object, if `isEqual` finds them equal).
   */
  read(...args: [...Parts, build: () => V]): V;
  /**
   * The value stored for these key parts, without building anything: `{ value }` on a hit, `undefined` on a miss.
   * Wrapped so that a stored `undefined` can be told apart from a miss.
   */
  peek(...parts: Parts): { value: V } | undefined;
  /**
   * Stores a value for these key parts (the value comes last), and returns the object to use from now on: the previous
   * value's object if `isEqual` finds the two equal, otherwise the new one.
   */
  set(...args: [...Parts, value: V]): V;
}

/**
 * A {@linkcode entityMemo} for one partition, as `.for(key)` returns it: where a {@linkcode byEntity} cache keeps its
 * values. An entity is the thing a row belongs to, such as one player, named by the table's `entityId` column. Each
 * entry belongs to one entity and is kept until a write changes that entity's rows.
 *
 * Every lookup is tracked per entity: a read whose {@linkcode ReadDef.select | select} looks up entities here depends
 * on just those entities, and doesn't re-run for writes to other entities. Table reads inside `build` count as reads of
 * that entity, not of the whole partition.
 */
export interface BoundEntityMemo<V, By extends readonly string[]> {
  /**
   * The value stored for `entity` (an entity id, such as a `player_id`) and these key parts. On a miss (never built, or
   * built before the entity's last change), runs `build`, stores its result, and returns it.
   */
  read(entityId: string, ...args: [...PartsOf<By>, build: () => V]): V;
  /**
   * The values stored for each of `entities` (entity ids, such as player ids) and these key parts, as a map by entity.
   * Every entity that misses is built in one `build` call, so a roster read costs one query for the players that
   * changed rather than one query per player. `build` gets the missing entities and returns a map of their values; an
   * entity it leaves out is stored as `undefined`.
   */
  readMany(entityIds: readonly string[], ...args: [...PartsOf<By>, build: (missing: readonly string[]) => ReadonlyMap<string, V>]): Map<string, V>;
}

/**
 * A {@linkcode byPartition} cache as a store's {@linkcode Partitions.defineCaches | defineCaches} block returns it: one
 * cache for the whole store, with entries kept per partition. A partition is the set of rows one fetch returns and
 * replaces.
 */
export interface Memo<Key, Bound> {
  /**
   * The cache's entries for one partition, to read and write. Reads the partition's current version, so call it where
   * the value is needed rather than keeping its result.
   */
  for(key: Key): Bound;
}

/**
 * A memo definition, before {@linkcode createMemos} attaches it to a store: a {@linkcode byPartition} cache, or the
 * {@linkcode entityMemo} under a {@linkcode byEntity} cache.
 */
export interface MemoDecl<Bound> {
  /** The names of the memo's key parts beyond the partition (and entity), in the order a lookup passes them. */
  by: readonly string[];
  /** Attaches the memo to a store's partitions, which supply each partition's key and versions. */
  bind(store: PartitionBinding<unknown>, diagnostics: MemoDiagnostics): Memo<unknown, Bound>;
}

/** A memo definition of any kind, before {@linkcode createMemos} attaches it to a store. */
export type MemoDeclaration = MemoDecl<unknown>;

/**
 * What a store's partitions give its caches: how to turn a partition key into its key parts, and how to read the
 * partition's version and each entity's. A partition is the set of rows one fetch returns and replaces; an entity is
 * the thing a row belongs to, such as one player, named by the table's `entityId` column.
 */
export interface PartitionBinding<Key> {
  /** A partition key's parts: its values as a list of strings, which prefix every memo entry's key. */
  parts: (key: Key) => readonly string[];
  /**
   * The partition's version number, which goes up on every write that changes it. Tracked: inside a tracking scope, the
   * scope re-runs after any such write.
   */
  version: (key: Key) => number;
  /**
   * The version at which one entity last changed. Tracked: inside a tracking scope, the scope re-runs only after a
   * write that changes that entity's rows.
   */
  entityVersion: (key: Key, entityId: string) => number;
}

const INTERNED_PARTS_MAX = 256;

/**
 * Turns a memo's parts into one key. A structured part is interned rather than spelled out: two lookups passing equal
 * content get the same id, and a memo of thousands of entries holds ids instead of repeated JSON. An id evicted for
 * capacity costs a rebuild, never a wrong answer.
 */
function createPartKeyer(): (prefix: string, parts: readonly CacheKeyPart[]) => string {
  const ids = createBoundedLru<string>(INTERNED_PARTS_MAX);
  let nextId = 0;
  const idFor = (part: object): string => {
    const identity = identityOf(part);
    const held = ids.get(identity);
    if (held) return held;
    nextId += 1;
    const id = `#${nextId}`;
    ids.set(identity, id);
    return id;
  };
  return (prefix, parts) => {
    if (!parts.length) return prefix;
    let key = prefix;
    for (const part of parts) key += KEY_SEP + (part !== null && typeof part === 'object' ? idFor(part) : String(part ?? ''));
    return key;
  };
}

/** The last argument of a variadic memo call, and the parts before it. */
function splitArgs<T>(args: readonly unknown[]): { parts: readonly CacheKeyPart[]; last: T } {
  return { parts: args.slice(0, -1) as readonly CacheKeyPart[], last: args[args.length - 1] as T };
}

/**
 * Declares a cache of values computed from a whole partition (the set of rows one fetch returns and replaces), such as
 * a map of a league's players by team, for a store's {@linkcode Partitions.defineCaches | defineCaches} block. Every
 * entry counts as missing after any write that changes its partition, and the value is computed again at the next
 * lookup, by the `build` that lookup passes. A read that uses it depends on the whole partition.
 *
 * Use it for whatever a read's {@linkcode ReadDef.select | select} builds that is expensive and asked for again: a value
 * several reads share, one a read looks up once per item in a list, or one read's own result when building it runs a
 * query. A read caches nothing itself, so without a cache, every subscriber and every call builds it again.
 *
 * The first type argument is the value; one value per partition is `byPartition<Map<string, Player[]>>({ max: 8 })`.
 * For values keyed by more than the partition, the second lists the key's other parts, named, in the order a lookup
 * passes them: `byPartition<RankedRow, [shape: RowShape, playerId: string]>({ max: 16384 })`. A lookup that passes a
 * part of the wrong type, or the wrong number of them, doesn't compile.
 */
export function byPartition<V, Parts extends readonly CacheKeyPart[] = []>(spec: {
  /** How many values to keep, across all partitions; beyond that, the least recently used are discarded. */
  max: number;
  /**
   * Compares a rebuilt value with the previous one; when they're equal, the previous object is kept, so readers
   * comparing by reference don't re-render.
   */
  isEqual?: (prev: V, next: V) => boolean;
}): MemoDecl<BoundVersionMemo<V, Parts>> {
  return {
    by: ['key parts'],
    bind: (store, diagnostics) => {
      const cache = createVersionedCache<V>(spec.max, spec.isEqual, diagnostics);
      const keyer = createPartKeyer();
      return {
        for: (key) => {
          const prefix = cacheKeyOf(store.parts(key));
          const version = store.version(key);
          return {
            read: (...args) => {
              const { parts, last } = splitArgs<() => V>(args);
              return cache.read(keyer(prefix, parts), version, last);
            },
            peek: (...parts) => cache.peek(keyer(prefix, parts), version),
            set: (...args) => {
              const { parts, last } = splitArgs<V>(args);
              return cache.set(keyer(prefix, parts), version, last);
            },
          };
        },
      } as Memo<unknown, BoundVersionMemo<V, Parts>>;
    },
  };
}

/**
 * Declares a memo of values built from one entity's rows: where a {@linkcode byEntity} cache keeps its values, which a
 * store declares instead. An entity is the thing a row belongs to, such as one player, named by the table's `entityId`
 * column. Each entry is kept until a write changes that entity's rows.
 *
 * A read that looks entities up here depends on just those entities, so it re-runs only when one of them changes. Table
 * reads inside `build` count as reads of that entity, not of the whole partition. Called in two steps, so the value
 * type can be given while {@linkcode MemoDecl.by | by} is inferred: `entityMemo<SeasonTotals>()({ max: 512 })`.
 */
export function entityMemo<V>() {
  return <const By extends readonly string[] = readonly []>(spec: {
    /** How many values to keep, across all partitions and entities; beyond that, the least recently used are discarded. */
    max: number;
    /**
     * Names for the key's parts beyond the partition and entity, in the order a lookup passes them, such as
     * `['scoring']`. Leave it out for a memo with one value per entity.
     */
    by?: By;
    /**
     * Compares a rebuilt value with the previous one; when they're equal, the previous object is kept, so readers
     * comparing by reference don't re-render.
     */
    isEqual?: (prev: V, next: V) => boolean;
  }): MemoDecl<BoundEntityMemo<V, By>> => ({
    by: spec.by ?? [],
    bind: (store, diagnostics) => {
      const watch = __DEV__ ? createMemoWatch(diagnostics, spec.max) : undefined;
      const lru = createBoundedLru<{ version: number; value: V }>(spec.max, watch?.onEvict);
      const keyer = createPartKeyer();
      /** The entry for this key if it was built at the entity's current version; noted as a hit or a miss. */
      const current = (key: string, version: number): { value: V } | undefined => {
        const hit = lru.get(key);
        const found = hit && hit.version === version ? hit : undefined;
        if (watch) {
          if (found) watch.noteHit();
          else watch.noteMiss(key, !hit);
        }
        return found;
      };
      const store_ = (key: string, version: number, value: V): V => {
        const prior = lru.get(key);
        const kept = prior && spec.isEqual && spec.isEqual(prior.value, value) ? prior.value : value;
        lru.set(key, { version, value: kept });
        return kept;
      };
      return {
        for: (key) => {
          const prefix = cacheKeyOf(store.parts(key));
          const entryKey = (entityId: string, parts: readonly CacheKeyPart[]): string => keyer(`${prefix}${KEY_SEP}${entityId}`, parts);
          return {
            read: (entityId, ...args) => {
              const { parts, last: build } = splitArgs<() => V>(args);
              const version = store.entityVersion(key, entityId);
              const at = entryKey(entityId, parts);
              const hit = current(at, version);
              return hit ? hit.value : store_(at, version, covered(build));
            },
            readMany: (entityIds, ...args) => {
              const { parts, last: build } = splitArgs<(missing: readonly string[]) => ReadonlyMap<string, V>>(args);
              const out = new Map<string, V>();
              const missing: Array<{ entityId: string; at: string; version: number }> = [];
              for (const entityId of entityIds) {
                const version = store.entityVersion(key, entityId);
                const at = entryKey(entityId, parts);
                const hit = current(at, version);
                if (hit) out.set(entityId, hit.value);
                else missing.push({ entityId, at, version });
              }
              if (!missing.length) return out;
              const built = covered(() => build(missing.map((entry) => entry.entityId)));
              for (const { entityId, at, version } of missing) out.set(entityId, store_(at, version, built.get(entityId) as V));
              return out;
            },
          };
        },
      };
    },
  });
}

/**
 * The memos {@linkcode createMemos} returns: one per entry of the block it was given, each attached to the store's
 * partitions.
 */
export type BoundMemos<Key, D> = { [K in keyof D]: D[K] extends MemoDecl<infer Bound> ? Memo<Key, Bound> : never };

/**
 * Attaches memo definitions (a {@linkcode byPartition} cache, or a {@linkcode entityMemo}) to a store's partitions,
 * returning one usable memo per entry. Each memo gets its partition's key parts and versions from `binding`, so a
 * lookup passes only the parts named in {@linkcode MemoDecl.by | by}.
 */
export function createMemos<Key, D extends Record<string, MemoDeclaration>>(
  store: string,
  binding: PartitionBinding<Key>,
  decls: D,
): BoundMemos<Key, D> {
  const out = {} as Record<string, unknown>;
  for (const memo of Object.keys(decls)) {
    const keyedBy = ['partition', ...decls[memo].by].join(' + ');
    out[memo] = decls[memo].bind(binding as PartitionBinding<unknown>, { name: `${store}.${memo}`, keyedBy });
  }
  return out as BoundMemos<Key, D>;
}

/**
 * Whether two objects have the same keys with identical values (`Object.is`), one level deep, such as two maps of view
 * models by id. For use as a read's {@linkcode CommonDef.isEqual | isEqual}.
 */
export function shallowEqualRecord<V>(left: Record<string, V>, right: Record<string, V>): boolean {
  if (left === right) return true;
  const aKeys = Object.keys(left);
  if (aKeys.length !== Object.keys(right).length) return false;
  for (const key of aKeys) {
    if (!Object.is(left[key], right[key])) return false;
  }
  return true;
}

/**
 * Builds an {@linkcode CommonDef.isEqual | isEqual} for an object value, for a read's
 * {@linkcode CommonDef.isEqual | isEqual}: the two objects are equal when they have the same keys, each field named in
 * `deep` is equal by the comparison given for it, and every other field is identical (`Object.is`). Name the fields
 * that hold newly built lists or objects; one left out compares unequal whenever it's rebuilt, which costs a re-render
 * rather than showing a stale value.
 */
export function shallowEqualStruct<T extends object>(deep: { [K in keyof T]?: (left: T[K], right: T[K]) => boolean }): (left: T, right: T) => boolean {
  return (left, right) => {
    if (left === right) return true;
    const keys = Object.keys(left) as (keyof T)[];
    if (keys.length !== Object.keys(right).length) return false;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const same = deep[key];
      if (same ? !same(left[key], right[key]) : !Object.is(left[key], right[key])) return false;
    }
    return true;
  };
}

/**
 * A `{}` and nothing else: a `Map` would answer `Object.keys` with `[]`, and two different ones would compare alike.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Whether two values are equal one level deep: arrays when their elements are identical in order, plain objects when
 * they have the same keys with identical values, and anything else when it is the same value (`Object.is`). It is the
 * default {@linkcode CommonDef.isEqual | isEqual} for reads, so a read that rebuilds a list or map of unchanged items
 * doesn't re-render. For a value that needs a deeper comparison, see {@linkcode shallowEqualStruct}.
 */
export function shallowEqualValue<T>(left: T, right: T): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left)) return Array.isArray(right) && shallowEqualArray(left, right);
  if (isPlainRecord(left) && isPlainRecord(right)) return shallowEqualRecord(left, right);
  return false;
}

/** Whether two arrays have the same length and identical elements (`Object.is`) in the same order. */
export function shallowEqualArray<V>(left: readonly V[], right: readonly V[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { CommonDef, Partitions, ReadDef, byEntity };
