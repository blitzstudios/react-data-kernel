/**
 * A memo of which row filters hold rows: {@linkcode RowTable.has | has} answers from memory, and a filter asked about
 * afresh costs a `SELECT`.
 */
import { RowShape } from './types';
import type { RowTable } from './types';
/** Identifies a row filter as a `Map` key, here and for the ETag cache; a read's key comes from `args_key`. */
export declare function whereMapKey(where: Partial<RowShape>): string;
/**
 * The memo behind a row table's {@linkcode RowTable.has | has}: {@linkcode Presence.get | get} and
 * {@linkcode Presence.observe | observe} remember whether one row filter matched, and the two `after` hooks retire the
 * entries a write could have moved. A row table owns one and has to call the hook on every write path it has, or
 * {@linkcode RowTable.has | has} keeps answering from before the write and a partition that just landed rows still
 * reads as empty.
 */
export interface Presence {
    get(where: Partial<RowShape>): boolean | undefined;
    observe(where: Partial<RowShape>, present: boolean): void;
    afterInsert(): void;
    /** `ingested` is recorded present, so a filter that fetched and landed zero rows still reads as fetched. */
    afterDelete(ingested?: Partial<RowShape>): void;
}
/** Builds a presence memo: an insert can only turn an absent filter present, and a delete drops every entry. */
export declare function createPresence(): Presence;
export type { RowTable };
//# sourceMappingURL=presence.d.ts.map