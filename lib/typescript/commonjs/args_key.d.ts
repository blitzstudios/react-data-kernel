/** Key derivation for reads: a read's key is its partition plus the values it is scoped by. */
import { cacheKey, cacheKeyOf, KEY_SEP } from './key';
import type { CommonDef, ReadDef } from './read/surface';
import type { Partitions } from './define_partitions';
export { cacheKey, cacheKeyOf, KEY_SEP };
/** A string that identifies a value by its content, with object keys sorted so equal content yields one key. */
export declare function stableKey(value: unknown): string;
export declare function identityOf(part: object): string;
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
export declare const EMPTY_VARY: readonly VaryValue[];
/** Separator between groups of parts, one level above {@linkcode KEY_SEP}, so the grouping is part of the key. */
export declare const GROUP_SEP = "\u0001";
/**
 * The identity of a whole set of partitions, for something keyed by the set rather than by one member — a
 * {@linkcode Partitions.defineReadMany | defineReadMany}'s cache entry, a fetch over several partitions at once. Order
 * and grouping are both part of the key, so the same partitions named differently are a different set.
 */
export declare function partitionsKey(partitions: readonly (readonly string[])[]): string;
/** A partition's parts as a human reads them. Never as a key: `:` occurs inside a part (`region:us-west`). */
export declare function partitionLabel(parts: readonly string[]): string;
/** `undefined`, `null`, `''` and an empty array count as absent; `0` and `false` count as present. */
export declare function isVaryPresent(value: VaryValue): boolean;
/**
 * A read's key: its partition, then everything it varies by, which a hook runs its select again for when it changes.
 * Vary values go through {@linkcode stableKey}, so an object or array arg keys by its content and a caller rebuilding
 * one per render doesn't count as a change.
 */
export declare function varyKey(parts: readonly string[], vary: readonly VaryValue[]): string;
export type { CommonDef, Partitions, ReadDef };
//# sourceMappingURL=args_key.d.ts.map