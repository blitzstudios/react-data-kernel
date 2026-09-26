/** Key derivation for reads: a read's key is its partition plus the values it is scoped by. */

import { createOnceGuard } from './diagnostics/once_guard';
import { cacheKey, cacheKeyOf, KEY_SEP } from './key';
import type { CommonDef, ReadDef } from './read/surface';
import type { Partitions } from './define_partitions';

export { cacheKey, cacheKeyOf, KEY_SEP };

/**
 * A `Map`, a `Set` or a class instance keys as `{}`, since none of what it holds is an own enumerable property — so two
 * different ones would share a cache entry. Caught in dev rather than typed away, because the types that legitimately
 * arrive here are ordinary interfaces, which no `Record` constraint accepts.
 */
const notPlainData = createOnceGuard();

function warnOnceIfNotPlainData(value: object): void {
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto === Object.prototype || proto === null) return;
  const name = (value.constructor as { name?: string } | undefined)?.name ?? 'an object';
  if (notPlainData.seen(name)) return;
  // eslint-disable-next-line no-console
  console.warn(
    `[cellar] keyed by a ${name}, which is not plain data: only own enumerable properties count towards a key, ` +
      `so two different ${name}s would key alike and share one cache entry. Key by the values you mean instead.`,
  );
}

/** A string that identifies a value by its content, with object keys sorted so equal content yields one key. */
export function stableKey(value: unknown): string {
  if (value === undefined) return 'u';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'u';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (__DEV__) warnOnceIfNotPlainData(value);
  const entries = Object.entries(value as Record<string, unknown>).filter(([, value]) => value !== undefined);
  entries.sort((left, right) => (left[0] < right[0] ? -1 : 1));
  // Keys are quoted as well as values: unquoted, `{'a:1,b': 2}` and `{a: 1, b: 2}` render the same string.
  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${stableKey(value)}`).join(',')}}`;
}

/**
 * Freezes what {@linkcode stableKey} walked, so a part whose identity is remembered cannot drift from it. Mirrors that
 * walk rather than freezing everything reachable: a `Map`, a `Set` or a class instance is not content-addressed —
 * {@linkcode stableKey} warns about it instead — and freezing one would break invariants it maintains for its owner.
 */
function freezeKeyPart(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  if (Array.isArray(value)) {
    Object.freeze(value);
    for (const entry of value) freezeKeyPart(entry);
    return;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) freezeKeyPart(entry);
}

/**
 * The content identity of a part, remembered per reference. Callers that hold one part across a loop -- ranking a
 * page of rows re-keys the same shape object once per row -- otherwise re-serialize an unchanged object every time,
 * and the part carrying a whole metric config makes that the most expensive thing on the read path.
 *
 * Shared across keyers because {@linkcode stableKey} is a pure function of the part. Only the serialization is skipped:
 * the id still comes from the content, so an equal part built fresh keys the same as one held, and a reference whose
 * id was evicted re-mints exactly as it would have.
 */
const identities = new WeakMap<object, string>();

export function identityOf(part: object): string {
  const known = identities.get(part);
  if (known !== undefined) return known;
  const identity = stableKey(part);
  // Reading a reference's identity from cache is only sound while its content holds still. Nothing here can detect a
  // later mutation, so dev makes it impossible rather than letting a stale key through a release build unnoticed.
  if (__DEV__) freezeKeyPart(part);
  identities.set(part, identity);
  return identity;
}

/**
 * A value a read varies by: anything {@linkcode ReadDef.select | select} reads beyond the partition itself. An object
 * or an array keys by its content, so a read can vary by a config or an options object without the caller serializing
 * one — but it must be plain data, since only own enumerable properties count towards the key (see
 * {@linkcode stableKey}).
 */
export type VaryValue = string | number | boolean | null | undefined | readonly unknown[] | object;

/**
 * The vary list of a read that declares no {@linkcode CommonDef.varyBy | varyBy}, and of one called with no args: one
 * shared array, not a fresh one per call.
 */
export const EMPTY_VARY: readonly VaryValue[] = Object.freeze([]);

/** Separator between groups of parts, one level above {@linkcode KEY_SEP}, so the grouping is part of the key. */
export const GROUP_SEP = '\u0001';

/**
 * The identity of a whole set of partitions, for something keyed by the set rather than by one member — a
 * {@linkcode Partitions.defineReadMany | defineReadMany}'s cache entry, a fetch over several partitions at once. Order
 * and grouping are both part of the key, so the same partitions named differently are a different set.
 */
export function partitionsKey(partitions: readonly (readonly string[])[]): string {
  return partitions.map(cacheKeyOf).join(GROUP_SEP);
}

/** A partition's parts as a human reads them. Never as a key: `:` occurs inside a part (`region:us-west`). */
export function partitionLabel(parts: readonly string[]): string {
  return parts.join(':');
}

/** `undefined`, `null`, `''` and an empty array count as absent; `0` and `false` count as present. */
export function isVaryPresent(value: VaryValue): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * A read's key: its partition, then everything it varies by, which a hook runs its select again for when it changes.
 * Vary values go through {@linkcode stableKey}, so an object or array arg keys by its content and a caller rebuilding
 * one per render doesn't count as a change.
 */
export function varyKey(parts: readonly string[], vary: readonly VaryValue[]): string {
  if (!vary.length) return cacheKeyOf(parts);
  // One array rather than three: `cacheKey(...parts, ...vary.map(stableKey))` allocates the mapped list and a
  // spread of both. Structured values go through {@linkcode identityOf}, so a caller holding an options object across
  // a list serializes it once instead of once per row.
  const joined = new Array<string>(parts.length + vary.length);
  for (let index = 0; index < parts.length; index++) joined[index] = parts[index];
  for (let index = 0; index < vary.length; index++) {
    const value = vary[index];
    joined[parts.length + index] = value !== null && typeof value === 'object' ? identityOf(value) : stableKey(value);
  }
  return cacheKeyOf(joined);
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { CommonDef, Partitions, ReadDef };
