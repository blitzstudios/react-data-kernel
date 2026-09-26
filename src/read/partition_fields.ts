/** Which of a read's args name the partition it reads, and which it varies by. */

import { VaryValue } from '../args_key';
import type { CommonDef } from './surface';

/** Args fields that can name a partition: every field of a partition key is one string. */
export type PartitionField<Args> = { [K in keyof Args]: Args[K] extends string ? K : never }[keyof Args];

/** Args fields a read can vary by: anything that can go into a key. */
export type VaryField<Args> = { [K in keyof Args]: Args[K] extends VaryValue ? K : never }[keyof Args];

/**
 * The mapper from a read's args to its partition key: a field list picks those fields into an object, which *is*
 * the key, and an opaque key arrives through a function of its own.
 */
export function partitionKeyOf<Args, Key>(spec: readonly PartitionField<Args>[] | ((args: Args) => Key)): (args: Args) => Key {
  if (typeof spec === 'function') return spec;
  const fields = spec as readonly string[];
  return (args) => {
    const key: Record<string, unknown> = {};
    for (const field of fields) key[field] = (args as Record<string, unknown>)[field];
    return key as Key;
  };
}

/**
 * The args fields a read waits on: its partition's, then everything it varies by. A function in either spot computes
 * something no field name stands for, so a read declaring one has no such list and is published with its own mapper.
 */
export function requiredFieldsOf<Args, Key>(
  partition: readonly PartitionField<Args>[] | ((args: Args) => Key),
  varyBy: readonly VaryField<Args>[] | ((args: Args) => readonly VaryValue[]) | undefined,
): readonly string[] | undefined {
  if (typeof partition === 'function' || typeof varyBy === 'function') return undefined;
  return Object.freeze([...(partition as readonly string[]), ...((varyBy ?? []) as readonly string[])]);
}

/**
 * The mapper from a read's args to its vary values: a field list picks those fields out, and a computed vary arrives as
 * a function of its own. The read surface resolves a {@linkcode CommonDef.varyBy | varyBy} through this once, then
 * calls it on every read.
 */
export function varyValuesOf<Args>(spec: readonly VaryField<Args>[] | ((args: Args) => readonly VaryValue[])): (args: Args) => readonly VaryValue[] {
  if (typeof spec === 'function') return spec;
  const fields = spec as readonly string[];
  // One field is the common case and this runs on every read call, so it skips `map`'s closure.
  if (fields.length === 1) {
    const [field] = fields;
    return (args) => [(args as Record<string, VaryValue>)[field]];
  }
  return (args) => fields.map((field) => (args as Record<string, VaryValue>)[field]);
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { CommonDef };
