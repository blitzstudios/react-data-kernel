"use strict";

/** Which of a read's args name the partition it reads, and which it varies by. */

/** Args fields that can name a partition: every field of a partition key is one string. */

/** Args fields a read can vary by: anything that can go into a key. */

/**
 * The mapper from a read's args to its partition key: a field list picks those fields into an object, which *is*
 * the key, and an opaque key arrives through a function of its own.
 */
export function partitionKeyOf(spec) {
  if (typeof spec === 'function') return spec;
  const fields = spec;
  return args => {
    const key = {};
    for (const field of fields) key[field] = args[field];
    return key;
  };
}

/**
 * The args fields a read waits on: its partition's, then everything it varies by. A function in either spot computes
 * something no field name stands for, so a read declaring one has no such list and is published with its own mapper.
 */
export function requiredFieldsOf(partition, varyBy) {
  if (typeof partition === 'function' || typeof varyBy === 'function') return undefined;
  return Object.freeze([...partition, ...(varyBy ?? [])]);
}

/**
 * The mapper from a read's args to its vary values: a field list picks those fields out, and a computed vary arrives as
 * a function of its own. The read surface resolves a {@linkcode CommonDef.varyBy | varyBy} through this once, then
 * calls it on every read.
 */
export function varyValuesOf(spec) {
  if (typeof spec === 'function') return spec;
  const fields = spec;
  // One field is the common case and this runs on every read call, so it skips `map`'s closure.
  if (fields.length === 1) {
    const [field] = fields;
    return args => [args[field]];
  }
  return args => fields.map(field => args[field]);
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=partition_fields.js.map