# Internals

The long-form reference behind [the README](../README.md): every piece Cellar exports, the rules it imposes,
and why each one is shaped the way it is. The README is enough to write a store; this is what to read when you
need to know *why* a piece behaves as it does, or when you are changing Cellar itself.

---

## What Cellar gives you (the reusable half)

Everything in this package is shared and already tested. You compose these; you don't reimplement them.

A note on reach: `index.ts` exports what a store, a service or a screen writes against. The pieces `definePartitions`
and `defineSqliteStore` are themselves built out of — the spine, the read surface, the fetch ingest, the SQL batch and
migration helpers — are described below but deliberately absent from it. Wanting one of them by name usually means a
store is reaching past its entry point; import it from its own module only if you are working on Cellar itself.

- **`defineSqliteStore`** — a store's whole spine in one descriptor: the version atom, the one slot holding the
  active backend, the in-memory default for web and tests, the SQLite builder startup binds, and the degrade
  path back to that default when a statement fails mid-session.
- **`createRowTable` (`createSqliteRowTable` / `createMemoryRowTable`)** — the off-heap row engine from a
  schema: `find` / `findIn` (indexed slice reads), `has`, `getMeta` / `setMeta` (ETags), and three writes.
  SQLite on mobile, in-memory on web/test — same interface.

  **The three writes.** `upsert(rows)` merges by primary key and removes nothing, chunked off-thread — what a
  socket delta wants. `overwrite(where, rows)` makes the slice matching `where` be exactly `rows`, deleting first
  in one transaction. `shred(where, rawJson, parse)` is that same replacement from an undecoded body, shredded in
  C++ so the payload never becomes a JS object graph. Only `overwrite` and `shred` name a slice, because only they
  delete; and in DEV every row they write is checked against the filter it was written under.

  **Changing a schema.** Edit the schema and ship it; there is no migration to write. `init` stamps a fingerprint
  of everything it builds — columns, primary key, indexes, the ETag side-table, the shred spec — into
  `PRAGMA user_version`, and a database whose stamp doesn't match is migrated on the spot. There are two ways that
  can go, and which one you get is worth knowing before you edit:

  - **A widening**, where the declaration only *added* columns. The table is kept and each new column arrives by
    `ALTER TABLE ADD COLUMN`, so not one row is lost. This is the case worth having: a schema whose columns are
    generated from a catalog — the metric keys a category publishes — gains a column every time the catalog does, and
    dropping a user's whole table to add one costs them a refetch for nothing. The added columns are `NULL` in every
    row that predates them, so the ETags go even though the rows stay: keeping one would answer the fetch that fills
    them with a 304.
  - **A rebuild**, for everything else — a changed key, a changed index, a renamed ETag table, a shred op that now
    fills a column it already had from a different path. Each of those restates rows already on disk, and no
    `ALTER TABLE` can restate them, so the table is dropped and refilled from the next fetch. A half-migrated table
    fails silently instead (a stale primary key turns ingest's `INSERT OR REPLACE` back into `INSERT`).

  Telling those apart takes two stamps, because a fingerprint that no longer matches can't say *what* moved:
  `PRAGMA user_version` holds the whole declaration's, and `PRAGMA application_id` holds the same hash with the
  columns left out — the table's, and the shred spec's `columns`/`ops` with them, since a spec is index-aligned with
  the table and a generated column arrives together with the op that fills it. Structure stamp equal and columns only
  added ⇒ widen; anything else ⇒ rebuild. A database built before the second stamp existed reads it as `0`, so its
  next schema change is one last rebuild, and every widening after that is free. The stamps are also what make an
  index edit take effect at all: `CREATE INDEX IF NOT EXISTS` is a no-op against an index of the same name over
  different columns, and `PRAGMA table_info` doesn't report indexes. Two fields on the schema go with them:

  - `pushFed: true` — for a store fed by socket as well as fetch. A rebuild there loses whatever arrived by push
    since the last fetch, so one files a sampled `info` notice naming the table. It does **not** throw, in `__DEV__`
    or anywhere else: `init` stamps the schema last, so refusing the rebuild would leave the stale stamp on disk and
    bind the in-memory backend on every launch after — permanently slower than the heap it replaced, over a change
    someone shipped on purpose. Catch the edit where the edit happens, by pinning the store's column set in a test.
  - `rebuildVersion` — bump to force a rebuild for something the stamps can't see, and it is part of the structure
    stamp, so bumping it is never mistaken for a widening. Two things need it. One is a row builder written in JS
    with no shred spec beside it: a change there leaves rows stale rather than malformed, and the stored ETag will
    304 the correction away. The other is repointing a shred op on a column that already exists *in the same release
    that adds a column* — alone that rebuilds (a plan with nothing to add is a rebuild), but alongside an addition it
    reads as a widening and the old values under the repointed column stay. Bumping this drops the ETags with the
    rows, which makes the next fetch a real one.

  **The shred spec is part of the fingerprint, which is why `NativeShredSpec` holds a `specs` map keyed by
  variant.** The fingerprint has to hash every spec a store can shred through, so the specs have to be
  enumerable. If your spec varies — different columns per category, say — enumerate the variants and give
  `variant(scope)` the job of picking one. Naming a variant that isn't in the map falls back to the JS parse path
  rather than shredding through `undefined`.
- **`definePartitions`** — **how your rows are divided into partitions you can fetch, and the thing you actually
  write.** It asks one question — *where does one partition's rows live?* — and derives the rest of the plumbing from
  the answer:

  ```ts
  const partitions = definePartitions<MyRow, MyKey>({
    name: 'my_store',
    table,
    version,
    key: {
      fields: ['groupId', 'itemType'],
      where: ({ groupId, itemType }) => ({ group_id: groupId, item_type: itemType }),
    },
    fetch: {
      query: (key, etag) => buildMyRawQuery(key, etag),
      parse: (key, rawJson) => buildMyRows(key, JSON.parse(rawJson)),
    },
  });
  ```

  `key.where` is a `WHERE` over your table — the same shape `table.find` takes — and it locates the partition for
  every operation Cellar runs on your behalf: reading and writing its ETag (`table.getMeta`/`setMeta`),
  testing whether it holds rows yet (`table.has`), replacing its rows on ingest, and bumping its version on a
  write.

  `key.fields` names the key's fields in the order they are spelled into the version and query keys, and that
  ordering is the only place a partition is ever positional. Everything you write — every `fetch` callback, every
  read's `select` — is handed the **key**, your own type.

  Use `key.of` + `key.id` instead of `fields` when your partition is a **record** too big to be a key: the record
  addresses its rows by the string it hashes to, while the fetch needs the whole record back to build a request
  from. `of` says how a read's args reach the record, `id` says
  what it hashes to, and declaring them hands the record⇄key table to this module. Every path that names a
  partition files it away on the way through, so the entry backing anything on screen stays warm, and your
  `fetch` callbacks are handed the record itself. The interning is this module's. `of` may answer `null` for args
  that address no partition — a locator a screen is still filling in — and such a read is off, primes nothing, and
  returns its `empty`, the same as a field that has not arrived.

  `fetch` is the store's real fetch behaviour and nothing else: the request, and how a body becomes rows.
  Everything mechanical around it belongs here — trying the native shred, falling back to a JS parse and
  reporting the degradation when it can't run, holding the ETag, recording when rows landed, bumping. Two
  optional members cover the cases that vary: `canShredNatively` for a body the native pass can't iterate, and
  `holdWrites` for a store that also takes socket writes. Leave `fetch` off entirely for a push-fed store.
  `onChanged` sits beside it, for a store holding a derived rollup that a partition's new rows invalidate.

  Back you get the read surface (`read`, `readMany`, `readGrouped`), the row-filter primitives your hydration and
  writes need (`where`, `keyOf`, `has`, `versionOf`, `bump`, `clearEtag`), and a ready-made **`lifecycle`**
  group — `usePrime`, `usePrimeMany`, `usePrimeAndVersion`, `has`, `getVersion`, `getFetchedAt`, `fetch`,
  `refetch`, `invalidate`, `forget`. Every member takes the same **args** a read does, in the `(args, options?)`
  call shape a backend publishes, so a backend hands the group straight out
  (`lifecycle: partitions.lifecycle`) rather than restating it. `usePrime` and `usePrimeAndVersion` take those args
  loosely, so a screen calls them with what it has, exactly as it calls a read: a field that has not arrived leaves
  the key unaddressable, and `key.of` answers `null` for args that name no partition, so neither primes anything.
- **`createFetchIngest`** — the fetch engine `definePartitions` composes: React Query orchestrates a raw-text fetch
  (ETag-conditional), `ingestRaw` shreds it into the row table, the version bumps. Gives you `usePrime` /
  `usePrimeMany` (reactive, one partition or a variable set) and `ensure` (imperative self-heal). Generic over
  your key, with `toParts` the one place it is spelled positionally. You should not need to call this directly.
- **`createPushIngest`** — the same job for rows that arrive by socket rather than by fetch. Pushes come in far
  faster than they need to be persisted, one item at a time rather than one partition, and they can land on a
  partition a fetch is midway through deleting and rewriting — so this buffers per partition, dedupes by
  `idOf`, writes in bounded chunks off the render path, requeues a failed chunk without overwriting anything
  newer, and lets a partition be **held** for the length of a fetch. Give it `idOf`, `toRows`, `bump` and
  `onWrite`; you get `queue` and `hold`. The `hold` is what `definePartitions`'s
  `fetch.holdWrites` wants. What it does inside, and why each part of it is load-bearing, is
  [below](#the-buffered-flush-behind-createpushingest).
- **`rowsOf(table)`** (`row_shaping.ts`) — a hydration's whole read side: ask it for rows, then say what shape you
  want them in. `rows.where(filter, opts)` and `rows.in(filter, column, values)` are the two queries, `.given(rows)`
  wraps rows you already hold, and each hands back something with `.rows`, `.map(fn, empty)`, `.indexed(column)`,
  `.grouped(column)` and — for `.in` — `.ordered(mapper, empty)`. Every shape returns the caller's **stable empty**
  when nothing survives. `ordered` is for an index-parallel result: SQL `IN` does not preserve argument order and
  `findIn` chunks on top of that, so a caller treating rows as parallel to the ids it asked for needs them reordered
  — which is why it hangs off `.in` alone and cannot be reached from a query that has no ids.
- **`partitionLabel(parts)`** (`args_key.ts`) — a partition's parts joined on `:` for a log line or a telemetry
  field. Never a key: `:` occurs inside a part (`region:us-west`), which is why keys don't use it. Keys themselves
  are not the caller's to build — a read's is the engine's, and a memo's comes from the partition it is bound to.
- **`chunkList` / `getOrCreate`** (`collections.ts`) — bounded batches, and the `Map` entry that may not exist
  yet.
- **`createVersionAtom`** — per-partition integer reactivity (a module-level `useSyncExternalStore`). `bump`
  on write; `useVersion` to subscribe; `useSelect` to subscribe + read a value with a bail-out; `get` for
  imperative reads.
- **`createReadSurface`** — **the read engine, reached through `definePartitions`'s `read` / `readMany`.** A read is
  one identical five-part shape — locate the partition, prime it, subscribe its version, select a bounded
  subset, wrap in an envelope. You declare it once as a `read<Args, Value>()({ partition, varyBy, select, empty })`
  descriptor — two calls, the first naming what the read takes and returns and the second taking the read, which is
  what leaves TypeScript free to infer `varyBy` from the list itself — and
  the engine generates both halves: `read.getValue` (imperative, self-priming, reference-stable) and
  `read.useValue` (reactive `DataResult<T>`; named `useValue` so React Compiler treats it as a normal hook,
  not React's `use()` API). Your
  only job is `select(args, key)` — the SQL subset → VM — everything mechanical is the engine, including skipping
  `select` entirely while the partition is still empty. A store's read surface becomes a small table of
  `read` descriptors.

  `partition` **defaults to the store's `key.fields`, or to `key.of` for a record partition**, so a read
  declares no partition at all, which is the common case.
  Give it explicitly only for an address one read computes differently from its siblings. `readMany` always names
  its own `partitions`, since the set is the read's. `varyBy` is everything else `select` reads — named as args
  fields (`varyBy: ['itemId']`) or computed — and it is both what a hook runs `select` again for and the read's gate:
  the read is off while any of those values is absent. A read caches nothing itself. A hook runs `select` when what it
  read changes and keeps its last object while the new value is equal; `getValue` runs `select` on every call. So
  `select` returns values out of the store's caches, and whatever it builds that costs anything, it builds inside one.

  Prefer the field names, which is the form that carries its own guarantee: `select` is handed those fields and
  nothing else, each non-null, so a cast at the call is unnecessary and reaching an arg the read never declared —
  the mistake that would leave a hook's value stale when that arg changed — does not compile. A computed `varyBy` names no
  fields to narrow to, so such a read is handed the whole args and answers for them itself;
  `no_undeclared_select_arg`, a lint rule in the consuming app, is what holds it to the same rule.

  Three variations cover the rest: `readMany({ partitions, … })` for a read spanning a variable set
  of partitions (it observes the same fetches through `usePrimeMany`, so it reports loading like any other read);
  `readGrouped({ groups, … })` when the caller is asking about several things at once and each has its own
  candidate partitions — `select` gets the groups back in the order it named them, so a read never flattens a list
  and then re-slices it by index; and, for a push-fed table, leaving `fetch` off, so its reads report `success`
  over an empty value. Cellar takes the fetch half as one value: the priming hooks and the refetch that goes
  with them are supplied together or not at all.
- **`partitions.defineCaches`** — every value a store keeps on the heap beyond its rows, in one block, and the only way
  it caches one:

  ```ts
  const { gamesByTeam, summaryMap } = partitions.defineCaches({
    gamesByTeam: byEntity({ max: 2048, fromRows: rowsToTeamGames }),
    summaryMap: byPartition<MySummaryMap>({ max: 2048 }),
  });

  gamesByTeam.at(key, team);
  summaryMap.for(key).read(() => deriveSummaryMap(rows.where(where(key)).rows));
  ```

  The block is reached off the store's partitions, which is what makes both kinds possible: a cache takes the
  partition's key parts, its version and each entity's version from there, so **no store builds a cache key or looks up
  a version**. What a store still names is `max`, which bounds what it keeps on the heap, and, for `byPartition`, its
  key parts, the second type argument: what the key holds beyond the partition, one argument to `.for(…)`'s methods per
  part, in order, each either a scalar or a structured value Cellar interns. So the block stays a complete, reviewable
  account of the store's heap. Each cache carries a dev-time watch that reports itself too small for the keys it keeps
  being asked for again, and reports itself if it has never once answered from its entry; the report names it by its
  key. A module that declares its own caches, such as a ranker, takes the store's `defineCaches` function as a
  `CacheFactory`, and a suite testing that module alone builds one with `testCache` from `./testing`, which takes
  `byPartition` caches only.
- **`byEntity`** — one value per entity, built from that entity's rows by `fromRows` and kept until a write changes
  them. A lookup (`at`, `atEach`, `pick`) depends on the entities it names, so a write to other entities neither
  rebuilds their values nor re-runs the read; `where` and `all` depend on the partition. Every miss in one `atEach` or
  `pick` is built from one query. Underneath, the values sit in an entity memo (`entityMemo` in `caches.ts`), keyed by
  entity and, where a filter can cut an entity's rows, by the filter. Its lists are cached too, in a bounded map of the
  last 64 it answered: each method hands back the list it gave last time for the same ids or filter when that list
  holds the same values, and `where` and `all` keep which entities matched until the partition's version moves, so a
  repeat runs no query.
- **`byPartition`** — a cache dropped by every write to its partition, with optional content-stable reference reuse: on
  a bump that didn't change an entry, hand back the _same reference_ so downstream shallow-equal bails.
  `read(…parts, compute)` is the whole cache in one call; `peek`/`set` are its batched half, for a caller that
  gathers its misses and computes them in one round-trip.

  Reach for it for whatever a `select` builds that is expensive and asked for again: a value **several reads** derive
  from a partition's rows, one **a read consults per item**, or **one read's own result** when building it runs a
  query or a ranking. A read keeps nothing between calls, so without one, every subscriber and every `getValue` call
  builds it again. What a `select` assembles cheaply out of cached values, such as a map over a `byEntity` list, needs
  no cache of its own.
- **`offHeapStatus`** — the loading-status rule (`loading` while a cold fetch is in flight, else `success`).
  The engine calls this for you; bespoke batch reads call it directly.
- **`shallowEqualValue`, `shallowEqualRecord`, `shallowEqualArray`, `shallowEqualStruct`** — the `isEqual` family. A
  read that names none gets `shallowEqualValue`, which is one level the way a store would have written it by hand: a
  list by its elements, a record by its values, anything else by identity — so a hydration rebuilding a list or a map
  out of unchanged parts bails its readers out without being asked to. Name one only where a level is not enough,
  which in practice means `shallowEqualStruct` for a struct: it takes a check per field for the fields holding a
  record or a list and compares the rest with `Object.is`, so a scalar field added later is covered without touching
  the call. `shallowEqualRecord` and `shallowEqualArray` are the two it composes, for a memo handing one over.

**Declare reads through the engine; no store here hand-writes one.** If you ever need to, two rules apply:
every imperative getter must call `version.get(parts)` on **every** call, cache hit included, or its reads
become invisible to both the tracking scope and the DEV guard below; and if the hook reads during render while
subscribing itself, wrap the read in **`runSubscribed(() => …)`** so the guard knows the subscription exists.
`createReadSurface` and `useSelect`/`useSelectMany` already do both for you.

**The guard:** in `__DEV__`, a read that happens during render with nothing subscribing it logs a warning naming the
partition and the component (`reactivity/tracking.ts` + `reactivity/render_phase.ts`). That failure is invisible on
screen — the value is correct on first paint and then frozen — so it is checked at the single choke point every read
passes through. Reads outside render (callbacks, reducers, socket handlers) are deliberately unsubscribed and stay
silent.

---

## What the backend returns: `{ reads, push?, lifecycle? }`

Three groups, and which one a new function belongs in is decided by who calls it, not by what it does:

| group | holds |
| --- | --- |
| `reads` | one `read`/`readMany` descriptor per read. Required — a store with nothing to read is not a store. |
| `push` | a caller handing rows **in** |
| `lifecycle` | partition-level operations that neither read rows nor write them: priming, freshness, invalidation |

**A fetch-fed store's ingest belongs to the partition's `fetch`, and the only way rows arrive is a fetch the read
surface already triggers — the common case.** You add `push` when rows arrive from
somewhere Cellar doesn't own (a socket). `lifecycle` is where a caller outside the read path primes, checks
freshness or invalidates a partition.

A group with no members is left off rather than declared empty, so a backend's shape tells you what kind of store
it is at a glance. `StoreBackendShape` requires `reads`, and a backend-shape guard test in the consuming app
fails on a fourth group name, which keeps the grouping exhaustive enough to rely on when reading an unfamiliar
store.

---

---

## The facade

The service facade publishes reads; it does not re-implement them. `pairRead` takes the read and returns both
halves, with params typed as `Loose<Args>` so a caller may pass what it has:

```ts
const Reads = {
  GroupItems: pairRead(() => getMyBackend().reads.GroupItems),
};

export const Hooks = { useGroupItems: Reads.GroupItems.useValue };
export const Get = { getGroupItems: Reads.GroupItems.getValue };
```

The read supplies its own gate. `read({ … })` publishes `requires` — its partition's fields plus its `varyBy`
fields — and the pair holds the read inert until a caller has every one of them, so the facade restates nothing the
store already declared. A field counts as in hand unless it is `undefined`, `null` or `''`; `[]`, `0` and `false`
are answers, and what a read does with an empty list is its `varyBy`'s business. A read naming its partitions with a
function, where there are no fields to read them off, declares `requires` itself: a read that parses one arg into
a set of candidate partitions has no field the pair could gate on, so it names that arg.

A facade read's params are the store read's own args, so a service names no vocabulary of its own and translates
nothing: `pairRead` takes the read and nothing else. `pairRead` throws on a read that publishes no `requires`, since
it has been asked to gate on nothing.

Both halves resolve the backend per call, so the SQLite bind at startup is picked up by callers that ran before
it. Publishing only one half is what pushes a Redux selector into a loop of point reads, so a read-pairing guard
test in the consuming app fails on a read that ships without its twin.

---

## Declaring the store itself

The wiring is one descriptor — `defineSqliteStore` folds the version atom, the swappable
backend registry, the in-memory web/test default, and the SQLite bind builder:

```ts
const myStore = defineSqliteStore<MyRow, MyBackend>({
  name: 'my_store',
  schema: mySchema,
  buildBackend: buildMyBackend, // (rowTable, version, caps) => backend
});
export const getMyBackend = myStore.getBackend;
export const setMyBackend = myStore.setBackend;
export const createSqliteMyBackend = myStore.createSqliteBackend;
```

…and mobile binds it in one line, from wherever the app runs its startup:

```ts
export const initMyStore = () => bindSqliteStore('initMyStore', 'my.db', setMyBackend, createSqliteMyBackend);
```

Caching, reactivity and fetch orchestration are Cellar's; a store does not write its own.

Two optional fields, and nothing else: `nativeShredSpec` for a native (simdjson) ingest shred, and
`sqliteCapabilities` for an accelerator that needs the live connection. Every store falls back to the same
backend over an in-memory row table, so the two platforms can only differ in where the rows live. The fallback is
built on first read, so a platform that binds SQLite first never constructs one at all.

---

## The buffered flush behind `createPushIngest`

Two rules for the shape of a push-fed store first. A store fed *only* by a socket leaves `definePartitions`'s
`fetch` off, so its reads report `success` over an empty value, and sets `pushFed: true` on the schema, so a
rebuild of a table no fetch can refill says so out loud. A store fed by *both* has one decision to make
explicitly: what a frame naming a partition nothing has fetched should do. Creating the partition is what lets
rows appear for an entity no screen asked the API for — the only way they can appear at all, when the socket is
their only source; dropping the frame means they never do.

A bulk completion carries thousands of rows at once, and writing them inline froze JS for ~2s. So `ingest` never
writes: it stages rows and returns, and a scheduled task does the work. Five properties carry that, and each one
is load-bearing:

- **Stage into a `Map` keyed by row identity.** Two frames touching the same row inside one flush window collapse
  to the last, which is what makes a burst cost one write per *row* rather than one per *frame*.
- **Flush on a macrotask, chunked, yielding between chunks.** `setTimeout(0)` gets it off the current frame;
  `upsert` in chunks of 250 with a yield between them keeps a long flush from becoming the same block in a
  different place. Reactivity lands a frame after the write resolves, which is the deliberate trade.
- **Bump every touched partition once, inside `notifyManager.batch`.** The flush collects the distinct partitions
  it wrote and bumps them together, so a thousand rows across four partitions is four bumps in one React commit.
- **On failure, requeue only what no newer write replaced** (`if (!pending.has(key))`) and retry after a delay.
  The guard is what keeps a retry from putting a superseded row back over a fresher one, which is the one
  failure in here that reaches the screen as wrong data rather than as jank.
- **Clear the partition's ETag on every socket write** (`onSocketWrite`). The ETag describes the last body the
  *fetch* ingested, not the socket's writes over it, and the rows outlive the process — so the next launch would
  304 and keep an entity frozen where the socket left it. Costs nothing while the entity is live, since a body the
  socket is tracking is changing and would not have matched anyway.

---

## Map of the files here

**What earns a place in this package:** Cellar is the store-authoring vocabulary — the pieces you compose to write a
store. Being generic is not the bar, and neither is having more than one caller: a mechanism belongs here when a *store
author* reaches for it. So `read/windowed_list.ts` lives here with a single consumer today, because "windowed list read"
is one of the read shapes you choose between when writing a store; whereas the compute-table LRU inside a native-compute
store's ranker is just as generic and stays in that store, because no store author picks it — it's how that one store's
ranked scan happens to work. A per-store mechanism moves here when a second *store* needs it, which is also the point at
which its shape has been checked against more than one caller.

Cellar's reusable core (you use, never fork):

The root holds what a store declares itself with, plus the primitives every folder below needs. The folders
follow the trip a row takes: it lands in a `table/`, gets there through `write/`, comes back out through
`read/`, and the component that asked hears about it through `reactivity/`.

| file                                             | role                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `define_sqlite_store.ts`                         | the SQLite-or-memory descriptor a store declares itself with, and the spine it builds: version atom, backend slot, degrade path |
| `define_partitions.ts`                    | one table's partitions: their keys, their fetch, and the lifecycle over them |
| `store_result.ts`                                | the `DataResult` envelope, and the `offHeapStatus` rule that fills one     |
| `prime_state.ts`                                 | what a read knows about the fetch behind its partition — the contract between the two, so neither imports the other |
| `key.ts`                                         | how a key's parts are joined, on a separator no part can contain; imports nothing, so anything may have it |
| `args_key.ts`                                    | what a read's key is derived from: a value by its content, a partition, a vary list |
| `caches.ts`                                      | bounded LRU, the `byPartition` cache and the entity memo under `byEntity`, and the `isEqual` family |
| `cache_block.ts`                                 | the `partitions.defineCaches` block: binds each `byEntity` and `byPartition` entry to a store's partitions |
| `collections.ts`                                 | `chunkList` and `getOrCreate`                                             |
| `runtime.ts`                                     | the host's three services — where a report goes, the query runtime an ingest mounts on, and when a read is live — and the inert defaults until one is installed |

| `table/` — where rows live                       |                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `types.ts`                                       | the schema types and the `RowTable` contract both backends implement      |
| `sqlite.ts`, `memory.ts`                         | the two backends behind that contract; `query.ts` holds the `where`/order and digest semantics they must answer identically — SQLite concatenates a digest itself, so one string per row crosses the bridge instead of every column behind it |
| `schema.ts`                                      | what `init` builds, and the two stamps that decide between widening it and rebuilding it |
| `presence.ts`                              | whether a row filter holds rows, cached — a read asks far more often than it changes |
| `connection.ts`                                  | batch/read helpers over the native binding; routes reads to the reader handle (`pinnedReader` opts out, for `TEMP`-table readers) |

| `write/` — how rows get in                       |                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `fetch_ingest.ts`                                | write-through fetch → shred → bump                                       |
| `push_ingest.ts`                                 | the push counterpart: buffer → dedupe → chunked write → bump, with per-partition holds for an in-flight fetch |
| `shred_columns.ts`                               | co-located shred column table (each column's `sql` + its `js` twin), and `defineShredColumns`, which binds it to everything derived from it — `names`, `columnDefs`, `row`, and, once every column declares an `op`, `namedOps` and `ops` |
| `shred_spec.ts`                                  | the native shred op language + its JS reference interpreter              |

| `read/` — how rows come out                      |                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `surface.ts`                                     | the read engine — `read({ … })` → `{ getValue, useValue }`               |
| `partition_fields.ts`                            | the field specs a read names its partition and its vary key with          |
| `row_shaping.ts`                                 | `rowsOf`: a query, then rows → list / ordered list / record / groups, each with the stable empty |
| `derived_values.ts`                              | `byEntity` caches: a value per entity, built from the entity's rows by `fromRows` (usually a view model), kept until a write changes that entity, so a bump rebuilds only the entities that moved and every other reader gets the same reference back |
| `facade.ts`                                      | what a service is written against: `pairRead`, so it exposes the hook and the imperative read together, plus the types its methods are spelled in (`ReadOptions`, `MaybeId`, `Loose`) |
| `windowed_list.ts`                               | windowed list reads (fetch a page, keep the rest off-heap), and the per-row `useWindowedDetail` that indexes back into one |

| `reactivity/` — how a write reaches a component  |                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `version_atom.ts`                                | per-partition reactivity, and the host read gate applied to a subscription: a dead gate drops the subscription and holds the version, so the read keeps its value by reference and catches up in one render |
| `tracked_selector.ts`, `tracking.ts`             | off-heap-aware reselect, for reads reached from Redux selectors; also the DEV guard that catches an unsubscribed render read (`render_phase.ts` is its phase probe) |

| `diagnostics/` — how the layer reports on itself |                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `telemetry.ts`                                   | reports silent perf degradation (a native fallback that stayed correct)  |
| `ingest_timing.ts`                               | per-ingest timings, rolled up for the dev overlay — the `./diagnostics` entry, which no shipping screen reads |
| `once_guard.ts`                                  | warn-once guards that a test can reset                                   |

| `nitro/` — the device                            |                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `nitro_connection.ts`                            | the `SqliteConnection` over `react-native-nitro-sqlite`: pragmas, param coercion, the native shred sentinel, and the binds that degrade rather than throw |

Two more entries ship beside the core one. `./diagnostics` holds what a developer surface dumps —
`getIngestTimings` and `rollupIngestTimings` — kept out of the core entry because a shipping screen has no
business reading them. `./testing` is what a store's tests are written against: `sqljs_connection.ts` (a real
SQLite engine for parity tests), `version_atom.ts` (in-process version atom with working `subscribe`),
`runtime.ts` (the host services as spies), `caches.ts` (a store's `cache` block for a suite that builds one module
rather than a whole backend), and `dev_mode.ts` (the wrappers pinning a case to one build). It also re-exports the
handful of internals that only a test reaches for — a real `createVersionAtom` to bump by hand, `evalShredElement`
to check a native shred against, and `resetOnceGuards` — which is why those are absent from the core entry.

Bespoke per store, and staying in the app: the schema, the payload types, the row builders and the shred spec beside
them, the view models and the `fromRows` functions their derived values are declared with, and the backend that composes
all of the above out of the pieces here. A native-compute store adds the SQL engine behind its whole-collection read,
which is advanced, opt-in, and no part of this package.
