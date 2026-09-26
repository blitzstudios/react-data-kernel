/** Which of a read's args name the partition it reads, and which it varies by. */
import { VaryValue } from '../args_key';
import type { CommonDef } from './surface';
/** Args fields that can name a partition: every field of a partition key is one string. */
export type PartitionField<Args> = {
    [K in keyof Args]: Args[K] extends string ? K : never;
}[keyof Args];
/** Args fields a read can vary by: anything that can go into a key. */
export type VaryField<Args> = {
    [K in keyof Args]: Args[K] extends VaryValue ? K : never;
}[keyof Args];
/**
 * The mapper from a read's args to its partition key: a field list picks those fields into an object, which *is*
 * the key, and an opaque key arrives through a function of its own.
 */
export declare function partitionKeyOf<Args, Key>(spec: readonly PartitionField<Args>[] | ((args: Args) => Key)): (args: Args) => Key;
/**
 * The args fields a read waits on: its partition's, then everything it varies by. A function in either spot computes
 * something no field name stands for, so a read declaring one has no such list and is published with its own mapper.
 */
export declare function requiredFieldsOf<Args, Key>(partition: readonly PartitionField<Args>[] | ((args: Args) => Key), varyBy: readonly VaryField<Args>[] | ((args: Args) => readonly VaryValue[]) | undefined): readonly string[] | undefined;
/**
 * The mapper from a read's args to its vary values: a field list picks those fields out, and a computed vary arrives as
 * a function of its own. The read surface resolves a {@linkcode CommonDef.varyBy | varyBy} through this once, then
 * calls it on every read.
 */
export declare function varyValuesOf<Args>(spec: readonly VaryField<Args>[] | ((args: Args) => readonly VaryValue[])): (args: Args) => readonly VaryValue[];
export type { CommonDef };
//# sourceMappingURL=partition_fields.d.ts.map