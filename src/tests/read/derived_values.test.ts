import { definePartitions } from '../../define_partitions';
import { byEntity } from '../../read/derived_values';
import { createTestRowTable } from '../../testing/row_table';
import { createSqliteRowTable } from '../../table/sqlite';
import { createVersionAtom } from '../../reactivity/version_atom';
import { runTracked } from '../../reactivity/tracking';
import { RowTable, RowTableSchema } from '../../table/types';
import { createSqlJsConnection, initSqlJs } from '../../testing/sqljs_connection';
import { installTestRuntime } from '../../testing/runtime';
import { itDev } from '../../testing/dev_mode';
import { resetOnceGuards } from '../../diagnostics/once_guard';

installTestRuntime();

type PlayerRow = { sport: string; player_id: string; name: string; team: string | null; rank: number | null };
type PlayerKey = { sport: string };

/** One row per player: the primary key less the partition is exactly the entity. */
const SCHEMA: RowTableSchema<PlayerRow> = {
  table: 'players',
  columns: {
    sport: { type: 'TEXT', notNull: true },
    player_id: { type: 'TEXT', notNull: true },
    name: { type: 'TEXT', notNull: true },
    team: { type: 'TEXT' },
    rank: { type: 'INTEGER' },
  },
  primaryKey: ['sport', 'player_id'],
  entityId: 'player_id',
};

const NFL: PlayerKey = { sport: 'nfl' };

function player(id: string, name: string, team: string | null = 'NE', rank: number | null = 1): PlayerRow {
  return { sport: 'nfl', player_id: id, name, team, rank };
}

/**
 * The value these derived values build, deliberately carrying only part of the row so a change outside it still counts.
 */
type NameVm = { id: string; label: string };

function harness(over: { table?: RowTable<PlayerRow>; max?: number; fromRows?: (rows: readonly PlayerRow[]) => NameVm | undefined } = {}) {
  const table = over.table ?? createTestRowTable(SCHEMA);
  table.init();
  const version = createVersionAtom('derived_values_test');

  const players = definePartitions<PlayerRow, PlayerKey>({
    name: 'player',
    table,
    version,
    key: { fields: ['sport'], where: ({ sport }) => ({ sport }) },
    fetch: { query: () => ({ queryFn: async () => ({ data: '[]' }) }), parse: () => [] },
  });

  const fromRows = jest.fn(over.fromRows ?? (([row]: readonly PlayerRow[]): NameVm | undefined => ({ id: row.player_id, label: row.name })));
  const { name: derived } = players.defineCaches({ name: byEntity({ max: over.max ?? 64, fromRows }) });

  /** Writes the partition the way an ingest does: the table says what changed, and the bump carries it. */
  const seed = (rows: readonly PlayerRow[]): void => {
    const { changes } = table.overwrite({ sport: 'nfl' }, rows as PlayerRow[]);
    players.bump(NFL, changes);
  };

  return { players, table, derived, fromRows, seed };
}

const idsOf = (deps: readonly { id: string }[]): string[] => deps.map((dep) => dep.id);

describe('derived values — every answer is cached, lists included', () => {
  it('hands back the same list for the same ids until one of their values changes', () => {
    const { derived, seed } = harness();
    seed([player('p1', 'Alice'), player('p2', 'Bob'), player('p3', 'Cal')]);

    const list = derived.atEach(NFL, ['p1', 'p2']);
    const map = derived.pick(NFL, ['p1', 'p2']);
    expect(derived.atEach(NFL, ['p1', 'p2'])).toBe(list);
    expect(derived.pick(NFL, ['p1', 'p2'])).toBe(map);

    seed([player('p1', 'Alice'), player('p2', 'Bob'), player('p3', 'Cy')]);
    expect(derived.atEach(NFL, ['p1', 'p2'])).toBe(list);
    expect(derived.pick(NFL, ['p1', 'p2'])).toBe(map);

    seed([player('p1', 'Alicia'), player('p2', 'Bob'), player('p3', 'Cy')]);
    expect(derived.atEach(NFL, ['p1', 'p2'])).not.toBe(list);
    expect(derived.pick(NFL, ['p1', 'p2'])).not.toBe(map);
  });

  it('keeps which entities match a filter until the partition changes, and the same list while they hold the same values', () => {
    const { derived, seed, table } = harness();
    seed([player('p1', 'Alice', 'NE'), player('p2', 'Bob', 'KC')]);
    const query = jest.spyOn(table, 'entityIdsWhere');

    const onNe = derived.where(NFL, { team: 'NE' });
    expect(derived.where(NFL, { team: 'NE' })).toBe(onNe);
    expect(query).toHaveBeenCalledTimes(1);

    seed([player('p1', 'Alice', 'NE'), player('p2', 'Bo', 'KC')]);
    expect(derived.where(NFL, { team: 'NE' })).toBe(onNe);
    expect(query).toHaveBeenCalledTimes(2);

    seed([player('p1', 'Alice', 'NE'), player('p2', 'Bo', 'NE')]);
    expect(derived.where(NFL, { team: 'NE' }).map((vm) => vm.label)).toEqual(['Alice', 'Bo']);
  });

  it('keeps the whole partition like a filter', () => {
    const { derived, seed, table } = harness();
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);
    const query = jest.spyOn(table, 'entityIdsWhere');

    const all = derived.all(NFL);
    expect(derived.all(NFL)).toBe(all);
    expect(derived.where(NFL)).toBe(all);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('derived values — a write rebuilds only the entities it changed', () => {
  it('builds one view model per entity, and answers a repeat without rebuilding', () => {
    const { derived, fromRows, seed } = harness();
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);

    const first = derived.atEach(NFL, ['p1', 'p2']);
    expect(first.map((vm) => vm.label)).toEqual(['Alice', 'Bob']);
    expect(fromRows).toHaveBeenCalledTimes(2);

    const second = derived.atEach(NFL, ['p1', 'p2']);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(fromRows).toHaveBeenCalledTimes(2);
  });

  it('rebuilds nothing for a write that changed nothing, which bumps nothing at all', () => {
    const { derived, fromRows, players, seed } = harness();
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);
    const before = derived.atEach(NFL, ['p1', 'p2']);
    const version = players.versionOf(NFL);
    fromRows.mockClear();

    seed([player('p1', 'Alice'), player('p2', 'Bob')]);

    expect(players.versionOf(NFL)).toBe(version);
    expect(derived.atEach(NFL, ['p1', 'p2'])).toEqual(before);
    expect(fromRows).not.toHaveBeenCalled();
  });

  it('rebuilds the one entity that moved and holds the reference of every entity that did not', () => {
    const { derived, fromRows, seed } = harness();
    seed([player('p1', 'Alice'), player('p2', 'Bob'), player('p3', 'Cara')]);
    const before = derived.atEach(NFL, ['p1', 'p2', 'p3']);
    fromRows.mockClear();

    seed([player('p1', 'Alice'), player('p2', 'Robert'), player('p3', 'Cara')]);
    const after = derived.atEach(NFL, ['p1', 'p2', 'p3']);

    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1].label).toBe('Robert');
    expect(fromRows).toHaveBeenCalledTimes(1);
  });

  it('counts a change the view model does not show, since the write, not the view model, decides what changed', () => {
    const { derived, fromRows, seed } = harness();
    seed([player('p1', 'Alice', 'NE', 1)]);
    derived.at(NFL, 'p1');
    fromRows.mockClear();

    seed([player('p1', 'Alice', 'NE', 2)]);
    derived.at(NFL, 'p1');

    expect(fromRows).toHaveBeenCalledTimes(1);
  });

  it('shares one memo across every read of the shape, so an entity asked for three ways is built once', () => {
    const { derived, fromRows, seed } = harness();
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);

    const viaAt = derived.at(NFL, 'p1');
    const viaAtEach = derived.atEach(NFL, ['p1'])[0];
    const viaTeam = derived.where(NFL, { team: 'NE' }).find((vm) => vm.id === 'p1');

    expect(viaAtEach).toBe(viaAt);
    expect(viaTeam).toBe(viaAt);
    expect(fromRows).toHaveBeenCalledTimes(2);
  });
});

describe('derived values — what a read depends on', () => {
  it('a read of named entities depends on those entities and not the partition, so a write to another leaves it asleep', () => {
    const { derived, players, seed } = harness();
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);

    const { deps } = runTracked(() => derived.atEach(NFL, ['p1']));
    expect(idsOf(deps)).toEqual([expect.stringMatching(/\u0001p1$/)]);

    const [dep] = deps;
    const listener = jest.fn();
    dep.subscribe(listener);
    seed([player('p1', 'Alice'), player('p2', 'Robert')]);
    expect(listener).not.toHaveBeenCalled();
    seed([player('p1', 'Alicia'), player('p2', 'Robert')]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(players.versionOf(NFL)).toBeGreaterThan(0);
  });

  it('a read over a filter depends on the partition, since which entities match can move with any write', () => {
    const { derived, seed } = harness();
    seed([player('p1', 'Alice')]);

    const { deps } = runTracked(() => derived.where(NFL, { team: 'NE' }));

    expect(idsOf(deps)).toContainEqual('derived_values_test\u0000nfl');
  });
});

describe('derived values — what it hands back', () => {
  it('orders by the ids asked for, not by storage order, and drops an id with no rows', () => {
    const { derived, seed } = harness();
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);
    expect(derived.atEach(NFL, ['p2', 'missing', 'p1']).map((vm) => vm.id)).toEqual(['p2', 'p1']);
  });

  it('remembers that an entity is absent, so a write to another entity does not send it asking again', () => {
    const { derived, table, seed } = harness();
    seed([player('p1', 'Alice')]);
    derived.atEach(NFL, ['missing']);
    const findIn = jest.spyOn(table, 'findIn');

    seed([player('p1', 'Alicia')]);
    derived.atEach(NFL, ['missing']);

    expect(findIn).not.toHaveBeenCalled();
  });

  it('notices an entity that arrives where there was none', () => {
    const { derived, seed } = harness();
    seed([player('p1', 'Alice')]);
    expect(derived.at(NFL, 'p2')).toBeUndefined();

    seed([player('p1', 'Alice'), player('p2', 'Bob')]);
    expect(derived.at(NFL, 'p2')?.label).toBe('Bob');
  });

  it('keys by id when asked for a map, and leaves out what it has no rows for', () => {
    const { derived, seed } = harness();
    seed([player('p1', 'Alice')]);
    expect(Object.keys(derived.pick(NFL, ['p1', 'missing']))).toEqual(['p1']);
  });

  it('narrows to a filter within the partition, and reflects an entity leaving that filter', () => {
    const { derived, seed } = harness();
    seed([player('p1', 'Alice', 'NE'), player('p2', 'Bob', 'KC')]);
    expect(derived.where(NFL, { team: 'NE' }).map((vm) => vm.id)).toEqual(['p1']);

    seed([player('p1', 'Alice', 'KC'), player('p2', 'Bob', 'KC')]);
    expect(derived.where(NFL, { team: 'NE' })).toEqual([]);
    expect(derived.all(NFL).map((vm) => vm.id).sort()).toEqual(['p1', 'p2']);
  });

  it('answers an empty ask without touching the rows', () => {
    const { derived, table, seed } = harness();
    seed([player('p1', 'Alice')]);
    const findIn = jest.spyOn(table, 'findIn');

    expect(derived.atEach(NFL, [])).toEqual([]);
    expect(derived.pick(NFL, [])).toEqual({});
    expect(findIn).not.toHaveBeenCalled();
  });

  it('keeps an entity out of the view models where the store says it makes none', () => {
    const { derived, seed } = harness({ fromRows: ([row]) => (row.team ? { id: row.player_id, label: row.name } : undefined) });
    seed([player('p1', 'Alice', null), player('p2', 'Bob', 'NE')]);

    expect(derived.atEach(NFL, ['p1', 'p2']).map((vm) => vm.id)).toEqual(['p2']);
    expect(derived.all(NFL).map((vm) => vm.id)).toEqual(['p2']);
  });
});

describe('derived values — an entity of several rows', () => {
  type GameRow = { week: string; game_id: string; player_id: string; team: string; pts: number };
  const GAMES: RowTableSchema<GameRow> = {
    table: 'games',
    columns: { week: { type: 'TEXT' }, game_id: { type: 'TEXT' }, player_id: { type: 'TEXT' }, team: { type: 'TEXT' }, pts: { type: 'REAL' } },
    primaryKey: ['week', 'game_id', 'player_id'],
    entityId: 'player_id',
  };
  type TotalVm = { id: string; games: number; pts: number };

  function games() {
    const table = createTestRowTable(GAMES);
    const version = createVersionAtom('derived_values_games_test');
    const weeks = definePartitions<GameRow, string>({ name: 'games', table, version, key: { where: (week) => ({ week }) } });
    const fromRows = jest.fn((rows: readonly GameRow[]): TotalVm => ({ id: rows[0].player_id, games: rows.length, pts: rows.reduce((sum, row) => sum + row.pts, 0) }));
    const { totals } = weeks.defineCaches({ totals: byEntity({ max: 64, fromRows }) });
    const seed = (rows: GameRow[]) => weeks.bump('w1', table.overwrite({ week: 'w1' }, rows).changes);
    return { totals, fromRows, seed };
  }
  const game = (id: string, playerId: string, team: string, pts: number): GameRow => ({ week: 'w1', game_id: id, player_id: playerId, team, pts });

  it('hands an entity every one of its rows', () => {
    const { totals, seed } = games();
    seed([game('g1', 'p1', 'LAL', 10), game('g2', 'p1', 'LAL', 20), game('g1', 'p2', 'BOS', 5)]);

    expect(totals.atEach('w1', ['p1', 'p2'])).toEqual([
      { id: 'p1', games: 2, pts: 30 },
      { id: 'p2', games: 1, pts: 5 },
    ]);
  });

  it('builds a filtered read from the rows the filter holds, apart from the entity whole, since they differ', () => {
    const { totals, seed } = games();
    // Traded mid-week: one game for each team.
    seed([game('g1', 'p1', 'BOS', 10), game('g2', 'p1', 'LAL', 20)]);

    const whole = totals.at('w1', 'p1');
    const forLakers = totals.where('w1', { team: 'LAL' })[0];

    expect(whole).toEqual({ id: 'p1', games: 2, pts: 30 });
    expect(forLakers).toEqual({ id: 'p1', games: 1, pts: 20 });
    expect(totals.at('w1', 'p1')).toBe(whole);
  });
});

describe('derived values — the memo bound is a bound, not a promise', () => {
  it('stays correct when the ask exceeds what it holds, even though the references cannot survive', () => {
    const { derived, seed } = harness({ max: 2 });
    const rows = [player('p1', 'A'), player('p2', 'B'), player('p3', 'C'), player('p4', 'D')];
    seed(rows);
    const ids = rows.map((row) => row.player_id);

    expect(derived.atEach(NFL, ids).map((vm) => vm.label)).toEqual(['A', 'B', 'C', 'D']);
    expect(derived.atEach(NFL, ids).map((vm) => vm.label)).toEqual(['A', 'B', 'C', 'D']);
  });

  itDev('says so in dev, naming the derived values and the bound to raise', () => {
    resetOnceGuards();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { derived, seed } = harness({ max: 2 });
    seed([player('p1', 'A'), player('p2', 'B'), player('p3', 'C')]);

    derived.atEach(NFL, ['p1', 'p2', 'p3']);

    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/'name' cache was asked for 3 entities but holds 2/);
    warn.mockRestore();
  });
});

describe('derived values — over real SQLite', () => {
  beforeAll(async () => {
    await initSqlJs();
  });

  const onSqlite = () => harness({ table: createSqliteRowTable(SCHEMA, createSqlJsConnection({ capabilities: 'full' })) });

  it('rebuilds exactly as the Map backend does', () => {
    const { derived, seed } = onSqlite();
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);
    const before = derived.atEach(NFL, ['p1', 'p2']);

    seed([player('p1', 'Alice'), player('p2', 'Robert')]);
    const after = derived.atEach(NFL, ['p1', 'p2']);

    expect(after[0]).toBe(before[0]);
    expect(after[1].label).toBe('Robert');
  });

  it('reads no rows at all for a partition whose write changed nothing', () => {
    const { derived, table, seed } = onSqlite();
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);
    derived.atEach(NFL, ['p1', 'p2']);
    const findIn = jest.spyOn(table, 'findIn');

    seed([player('p1', 'Alice'), player('p2', 'Bob')]);
    derived.atEach(NFL, ['p1', 'p2']);

    expect(findIn).not.toHaveBeenCalled();
  });
});
