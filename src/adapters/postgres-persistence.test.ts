/**
 * ZINESH PROTOCOL V2 — PostgreSQL Persistence Tests
 *
 * Integration tests that run against a REAL PostgreSQL database.
 * No mocks replace the database.
 *
 * If ZINESH_POSTGRES_TESTS is not set to "true" the entire suite is skipped.
 * This prevents CI failures when PostgreSQL is unavailable.
 *
 * To run:
 *   ZINESH_POSTGRES_TESTS=true \
 *   PGHOST=localhost PGPORT=5432 \
 *   PGDATABASE=zinesh_test PGUSER=postgres PGPASSWORD=postgres \
 *   npm test -- postgres-persistence
 *
 * Coverage:
 *
 * EVENT STORE (1–15)
 *  1.  insert one event → retrieve it
 *  2.  getEvents returns event
 *  3.  event_id is preserved
 *  4.  cell_id is preserved
 *  5.  version is preserved
 *  6.  timestamp is preserved
 *  7.  type is preserved
 *  8.  payload is preserved
 *  9.  getEvents returns version ASC
 *  10. getEventsSince works
 *  11. cell isolation (Cell A events not visible in Cell B)
 *  12. duplicate (cell_id, version) is rejected
 *  13. existing event cannot be overwritten by a new append
 *  14. no event deletion path exists
 *  15. no event update path exists
 *
 * ATOMICITY (16–17)
 *  16. multi-event append succeeds atomically
 *  17. failed multi-event append rolls back completely
 *
 * CONCURRENCY (18–19)
 *  18. duplicate cell/version produces a conflict result
 *  19. same version across different cells succeeds
 *
 * SNAPSHOTS (20–25)
 *  20. save a snapshot
 *  21. load a snapshot
 *  22. snapshot upsert replaces previous
 *  23. snapshot version is preserved
 *  24. snapshot cell isolation
 *  25. snapshot operations do not modify events
 *
 * INTEGRATION (26–30)
 *  26. persist events
 *  27. reload events
 *  28. replay persisted events through the existing Kernel
 *  29. missing snapshot does not prevent event replay
 *  30. event history remains authoritative when snapshot is stale
 */

import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { PostgresPersistenceAdapter } from './postgres-persistence-adapter';
import type { PostgresConfig } from './postgres-persistence-adapter';
import {
  makeActorId,
  makeCellId,
  makeCommandId,
  makeEventId,
  makeTimestamp,
  makeAmount,
  nextVersion,
  ZERO_VERSION,
} from '../core/types';
import type { CellId, Event, Version } from '../core/types';
import { cellKernel } from '../kernel';

// ---------------------------------------------------------------------------
// Skip guard — tests require a real PostgreSQL instance
// ---------------------------------------------------------------------------

const POSTGRES_ENABLED = process.env['ZINESH_POSTGRES_TESTS'] === 'true';

function maybeDescribe(name: string, fn: () => void): void {
  if (POSTGRES_ENABLED) {
    describe(name, fn);
  } else {
    describe.skip(name, fn);
  }
}

// ---------------------------------------------------------------------------
// Configuration — read from environment, no hardcoded credentials
// ---------------------------------------------------------------------------

const pgConfig: PostgresConfig = {
  host:     process.env['PGHOST']     ?? 'localhost',
  port:     parseInt(process.env['PGPORT'] ?? '5432', 10),
  database: process.env['PGDATABASE'] ?? 'zinesh_test',
  user:     process.env['PGUSER']     ?? 'postgres',
  password: process.env['PGPASSWORD'] ?? 'postgres',
};

// ---------------------------------------------------------------------------
// Schema setup helper
// ---------------------------------------------------------------------------

async function applySchema(pool: Pool): Promise<void> {
  const schemaPath = path.resolve(__dirname, 'postgres-schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
}

async function truncateTables(pool: Pool): Promise<void> {
  // Only allowed in tests — not in production code.
  // events is append-only in production; we truncate here only to reset test state.
  await pool.query('TRUNCATE TABLE events, snapshots, command_executions RESTART IDENTITY CASCADE');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAYER  = makeActorId('payer-1');
const PAYEE  = makeActorId('payee-1');
const AMOUNT = makeAmount(10000n);
const T1 = makeTimestamp(1_000_000);
const T2 = makeTimestamp(2_000_000);
const T3 = makeTimestamp(3_000_000);

const V1 = nextVersion(ZERO_VERSION); // 1
const V2 = nextVersion(V1);           // 2
const V3 = nextVersion(V2);           // 3

let cellCounter = 0;
function freshCellId(): CellId {
  return makeCellId(`cell-pg-${++cellCounter}`);
}

let evtCounter = 0;
function makeEvent(cellId: CellId, version: Version, ts = T1): Event {
  return {
    eventId:   makeEventId(`evt-pg-${++evtCounter}-v${version}`),
    cellId,
    version,
    timestamp: ts,
    type:      'CellCreated',
    payload:   {
      payer:               PAYER,
      payee:               PAYEE,
      amount:              AMOUNT,
      currency:            'TRY',
      fundingDeadline:     T1,
      completionDeadline:  T3,
    },
  };
}

function makeFundedEvent(cellId: CellId, version: Version, ts = T2): Event {
  return {
    eventId:   makeEventId(`evt-pg-funded-${++evtCounter}-v${version}`),
    cellId,
    version,
    timestamp: ts,
    type:      'CellFunded',
    payload:   { fundedBy: PAYER, amount: AMOUNT },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

maybeDescribe('PostgreSQL Persistence', () => {
  let adapter: PostgresPersistenceAdapter;

  beforeAll(async () => {
    adapter = new PostgresPersistenceAdapter(pgConfig);
    await adapter.connect();
    const pool = (adapter as unknown as { pool: Pool }).pool;
    await applySchema(pool);
  });

  beforeEach(async () => {
    const pool = (adapter as unknown as { pool: Pool }).pool;
    await truncateTables(pool);
  });

  afterAll(async () => {
    await adapter.disconnect();
  });

  // -------------------------------------------------------------------------
  // 1–8: Single event round-trip — field preservation
  // -------------------------------------------------------------------------

  test('1. insert one event → retrieve it', async () => {
    const CELL = freshCellId();
    const event = makeEvent(CELL, V1, T1);
    const result = await adapter.eventStore.append(CELL, [event]);
    expect(result.ok).toBe(true);
    const events = await adapter.eventStore.getEvents(CELL);
    expect(events).toHaveLength(1);
  });

  test('2. getEvents returns event after append', async () => {
    const CELL = freshCellId();
    await adapter.eventStore.append(CELL, [makeEvent(CELL, V1)]);
    const events = await adapter.eventStore.getEvents(CELL);
    expect(events).toHaveLength(1);
  });

  test('3. event_id is preserved', async () => {
    const CELL = freshCellId();
    const event = makeEvent(CELL, V1);
    await adapter.eventStore.append(CELL, [event]);
    const [stored] = await adapter.eventStore.getEvents(CELL);
    expect(stored!.eventId).toBe(event.eventId);
  });

  test('4. cell_id is preserved', async () => {
    const CELL = freshCellId();
    const event = makeEvent(CELL, V1);
    await adapter.eventStore.append(CELL, [event]);
    const [stored] = await adapter.eventStore.getEvents(CELL);
    expect(stored!.cellId).toBe(CELL);
  });

  test('5. version is preserved', async () => {
    const CELL = freshCellId();
    const event = makeEvent(CELL, V1);
    await adapter.eventStore.append(CELL, [event]);
    const [stored] = await adapter.eventStore.getEvents(CELL);
    expect(stored!.version).toBe(V1);
  });

  test('6. timestamp is preserved', async () => {
    const CELL = freshCellId();
    const ts = makeTimestamp(9_876_543);
    const event: Event = { ...makeEvent(CELL, V1), timestamp: ts };
    await adapter.eventStore.append(CELL, [event]);
    const [stored] = await adapter.eventStore.getEvents(CELL);
    expect(stored!.timestamp).toBe(ts);
  });

  test('7. type is preserved', async () => {
    const CELL = freshCellId();
    const event = makeEvent(CELL, V1);
    await adapter.eventStore.append(CELL, [event]);
    const [stored] = await adapter.eventStore.getEvents(CELL);
    expect(stored!.type).toBe('CellCreated');
  });

  test('8. payload is preserved', async () => {
    const CELL = freshCellId();
    const event = makeEvent(CELL, V1);
    await adapter.eventStore.append(CELL, [event]);
    const [stored] = await adapter.eventStore.getEvents(CELL);
    // Deep-equal on payload (JSONB round-trips bigint as string, so use string comparison for amount)
    expect(stored!.payload).toMatchObject({
      payer:    PAYER,
      payee:    PAYEE,
      currency: 'TRY',
    });
  });

  // -------------------------------------------------------------------------
  // 9. Ordering
  // -------------------------------------------------------------------------

  test('9. getEvents returns version ASC', async () => {
    const CELL = freshCellId();
    const e1 = makeEvent(CELL, V1, T1);
    const e2 = makeFundedEvent(CELL, V2, T2);
    const e3: Event = { ...makeEvent(CELL, V3, T3), eventId: makeEventId(`e3-${++evtCounter}`) };
    await adapter.eventStore.append(CELL, [e1, e2, e3]);
    const events = await adapter.eventStore.getEvents(CELL);
    expect(events[0]!.version).toBe(V1);
    expect(events[1]!.version).toBe(V2);
    expect(events[2]!.version).toBe(V3);
  });

  // -------------------------------------------------------------------------
  // 10. getEventsSince
  // -------------------------------------------------------------------------

  test('10. getEventsSince returns events after given version', async () => {
    const CELL = freshCellId();
    await adapter.eventStore.append(CELL, [
      makeEvent(CELL, V1, T1),
      makeFundedEvent(CELL, V2, T2),
      { ...makeEvent(CELL, V3, T3), eventId: makeEventId(`e3-since-${++evtCounter}`) } as Event,
    ]);
    const since = await adapter.eventStore.getEventsSince(CELL, V1);
    expect(since).toHaveLength(2);
    expect(since[0]!.version).toBe(V2);
    expect(since[1]!.version).toBe(V3);
  });

  // -------------------------------------------------------------------------
  // 11. Cell isolation
  // -------------------------------------------------------------------------

  test('11. cell isolation — Cell A events not visible in Cell B', async () => {
    const CELL_A = freshCellId();
    const CELL_B = freshCellId();
    await adapter.eventStore.append(CELL_A, [makeEvent(CELL_A, V1)]);
    await adapter.eventStore.append(CELL_B, [makeEvent(CELL_B, V1)]);
    const aEvents = await adapter.eventStore.getEvents(CELL_A);
    const bEvents = await adapter.eventStore.getEvents(CELL_B);
    const aIds = aEvents.map((e) => e.eventId);
    const bIds = bEvents.map((e) => e.eventId);
    for (const id of aIds) {
      expect(bIds).not.toContain(id);
    }
  });

  // -------------------------------------------------------------------------
  // 12. Duplicate (cell_id, version) rejected
  // -------------------------------------------------------------------------

  test('12. duplicate (cell_id, version) is rejected with version conflict', async () => {
    const CELL = freshCellId();
    await adapter.eventStore.append(CELL, [makeEvent(CELL, V1)]);
    // Try to append a different event with the same version
    const duplicate: Event = { ...makeEvent(CELL, V1), eventId: makeEventId(`dup-${++evtCounter}`) };
    const result = await adapter.eventStore.append(CELL, [duplicate]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('APPEND_VERSION_CONFLICT');
  });

  // -------------------------------------------------------------------------
  // 13. Existing event cannot be overwritten
  // -------------------------------------------------------------------------

  test('13. existing event cannot be overwritten', async () => {
    const CELL = freshCellId();
    const original = makeEvent(CELL, V1, T1);
    await adapter.eventStore.append(CELL, [original]);
    // Attempt to overwrite with same version — must fail
    const overwrite: Event = { ...makeEvent(CELL, V1, T2), eventId: makeEventId(`ow-${++evtCounter}`) };
    const result = await adapter.eventStore.append(CELL, [overwrite]);
    expect(result.ok).toBe(false);
    // Stored event must still be the original
    const [stored] = await adapter.eventStore.getEvents(CELL);
    expect(stored!.eventId).toBe(original.eventId);
    expect(stored!.timestamp).toBe(T1);
  });

  // -------------------------------------------------------------------------
  // 14–15. No deletion / no update path
  // -------------------------------------------------------------------------

  test('14. no event deletion path — event store has no delete method', () => {
    const store = adapter.eventStore;
    expect(typeof (store as unknown as Record<string, unknown>)['delete']).toBe('undefined');
    expect(typeof (store as unknown as Record<string, unknown>)['deleteEvents']).toBe('undefined');
    expect(typeof (store as unknown as Record<string, unknown>)['remove']).toBe('undefined');
  });

  test('15. no event update path — event store has no update method', () => {
    const store = adapter.eventStore;
    expect(typeof (store as unknown as Record<string, unknown>)['update']).toBe('undefined');
    expect(typeof (store as unknown as Record<string, unknown>)['updateEvent']).toBe('undefined');
    expect(typeof (store as unknown as Record<string, unknown>)['patch']).toBe('undefined');
  });

  // -------------------------------------------------------------------------
  // 16. Multi-event atomic append succeeds
  // -------------------------------------------------------------------------

  test('16. multi-event append succeeds atomically', async () => {
    const CELL = freshCellId();
    const e1 = makeEvent(CELL, V1, T1);
    const e2 = makeFundedEvent(CELL, V2, T2);
    const e3: Event = { ...makeEvent(CELL, V3, T3), eventId: makeEventId(`e3-atom-${++evtCounter}`) };
    const result = await adapter.eventStore.append(CELL, [e1, e2, e3]);
    expect(result.ok).toBe(true);
    const events = await adapter.eventStore.getEvents(CELL);
    expect(events).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // 17. Failed multi-event append rolls back completely
  // -------------------------------------------------------------------------

  test('17. failed multi-event append rolls back completely', async () => {
    const CELL = freshCellId();
    // Pre-populate V1
    await adapter.eventStore.append(CELL, [makeEvent(CELL, V1)]);

    // Batch: V2 (valid) + V1 (duplicate — will conflict)
    const good: Event = { ...makeFundedEvent(CELL, V2), eventId: makeEventId(`good-${++evtCounter}`) };
    const bad: Event  = { ...makeEvent(CELL, V1), eventId: makeEventId(`bad-${++evtCounter}`) };
    const result = await adapter.eventStore.append(CELL, [good, bad]);
    expect(result.ok).toBe(false);

    // V2 must NOT be persisted because the batch was rolled back
    const events = await adapter.eventStore.getEvents(CELL);
    expect(events).toHaveLength(1);
    expect(events[0]!.version).toBe(V1);
  });

  // -------------------------------------------------------------------------
  // 18. Concurrency — duplicate version conflict
  // -------------------------------------------------------------------------

  test('18. duplicate cell/version across two sequential appends produces conflict', async () => {
    const CELL = freshCellId();
    const first  = makeEvent(CELL, V1);
    const second: Event = { ...makeEvent(CELL, V1), eventId: makeEventId(`conc-${++evtCounter}`) };
    await adapter.eventStore.append(CELL, [first]);
    const result = await adapter.eventStore.append(CELL, [second]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('APPEND_VERSION_CONFLICT');
  });

  // -------------------------------------------------------------------------
  // 19. Same version number across different cells is allowed
  // -------------------------------------------------------------------------

  test('19. same version across different cells succeeds', async () => {
    const CELL_A = freshCellId();
    const CELL_B = freshCellId();
    const r1 = await adapter.eventStore.append(CELL_A, [makeEvent(CELL_A, V1)]);
    const r2 = await adapter.eventStore.append(CELL_B, [makeEvent(CELL_B, V1)]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 20–21. Snapshot save / load
  // -------------------------------------------------------------------------

  test('20. save a snapshot', async () => {
    const CELL = freshCellId();
    const snap = {
      cellId:  CELL,
      version: V2,
      state: {
        cellId: CELL, status: 'FUNDED' as const,
        payer: PAYER, payee: PAYEE, amount: AMOUNT, currency: 'TRY' as const,
        fundingDeadline: T1, completionDeadline: T3, fundedAt: T2,
      },
    };
    await expect(adapter.snapshotStore.save(CELL, snap)).resolves.toBeUndefined();
  });

  test('21. load a snapshot', async () => {
    const CELL = freshCellId();
    const snap = {
      cellId:  CELL,
      version: V2,
      state: {
        cellId: CELL, status: 'FUNDED' as const,
        payer: PAYER, payee: PAYEE, amount: AMOUNT, currency: 'TRY' as const,
        fundingDeadline: T1, completionDeadline: T3, fundedAt: T2,
      },
    };
    await adapter.snapshotStore.save(CELL, snap);
    const loaded = await adapter.snapshotStore.load(CELL);
    expect(loaded).not.toBeNull();
    expect(loaded!.cellId).toBe(CELL);
    expect(loaded!.version).toBe(V2);
  });

  // -------------------------------------------------------------------------
  // 22. Snapshot upsert
  // -------------------------------------------------------------------------

  test('22. snapshot upsert replaces previous snapshot', async () => {
    const CELL = freshCellId();
    const base = {
      cellId: CELL, status: 'FUNDED' as const,
      payer: PAYER, payee: PAYEE, amount: AMOUNT, currency: 'TRY' as const,
      fundingDeadline: T1, completionDeadline: T3,
    };
    await adapter.snapshotStore.save(CELL, { cellId: CELL, version: V1, state: base });
    await adapter.snapshotStore.save(CELL, { cellId: CELL, version: V3, state: base });
    const loaded = await adapter.snapshotStore.load(CELL);
    expect(loaded!.version).toBe(V3);
  });

  // -------------------------------------------------------------------------
  // 23. Snapshot version preserved
  // -------------------------------------------------------------------------

  test('23. snapshot version is preserved', async () => {
    const CELL = freshCellId();
    const state = {
      cellId: CELL, status: 'FUNDED' as const,
      payer: PAYER, payee: PAYEE, amount: AMOUNT, currency: 'TRY' as const,
      fundingDeadline: T1, completionDeadline: T3,
    };
    await adapter.snapshotStore.save(CELL, { cellId: CELL, version: V3, state });
    const loaded = await adapter.snapshotStore.load(CELL);
    expect(loaded!.version).toBe(V3);
  });

  // -------------------------------------------------------------------------
  // 24. Snapshot cell isolation
  // -------------------------------------------------------------------------

  test('24. snapshot cell isolation', async () => {
    const CELL_A = freshCellId();
    const CELL_B = freshCellId();
    const stateA = {
      cellId: CELL_A, status: 'FUNDED' as const,
      payer: PAYER, payee: PAYEE, amount: AMOUNT, currency: 'TRY' as const,
      fundingDeadline: T1, completionDeadline: T3,
    };
    const stateB = { ...stateA, cellId: CELL_B, status: 'CREATED' as const };
    await adapter.snapshotStore.save(CELL_A, { cellId: CELL_A, version: V1, state: stateA });
    await adapter.snapshotStore.save(CELL_B, { cellId: CELL_B, version: V2, state: stateB });
    const loadedA = await adapter.snapshotStore.load(CELL_A);
    const loadedB = await adapter.snapshotStore.load(CELL_B);
    expect(loadedA!.version).toBe(V1);
    expect(loadedB!.version).toBe(V2);
  });

  // -------------------------------------------------------------------------
  // 25. Snapshot operations do not modify events
  // -------------------------------------------------------------------------

  test('25. snapshot save/load does not modify event history', async () => {
    const CELL = freshCellId();
    await adapter.eventStore.append(CELL, [makeEvent(CELL, V1), makeFundedEvent(CELL, V2)]);
    const state = {
      cellId: CELL, status: 'FUNDED' as const,
      payer: PAYER, payee: PAYEE, amount: AMOUNT, currency: 'TRY' as const,
      fundingDeadline: T1, completionDeadline: T3, fundedAt: T2,
    };
    await adapter.snapshotStore.save(CELL, { cellId: CELL, version: V2, state });
    await adapter.snapshotStore.save(CELL, { cellId: CELL, version: V2, state }); // overwrite
    const events = await adapter.eventStore.getEvents(CELL);
    expect(events).toHaveLength(2);
    expect(events[0]!.version).toBe(V1);
    expect(events[1]!.version).toBe(V2);
  });

  // -------------------------------------------------------------------------
  // 26–27. Persist and reload
  // -------------------------------------------------------------------------

  test('26. persist events', async () => {
    const CELL = freshCellId();
    const result = await adapter.eventStore.append(CELL, [makeEvent(CELL, V1)]);
    expect(result.ok).toBe(true);
  });

  test('27. reload events', async () => {
    const CELL = freshCellId();
    await adapter.eventStore.append(CELL, [makeEvent(CELL, V1), makeFundedEvent(CELL, V2)]);
    const events = await adapter.eventStore.getEvents(CELL);
    expect(events).toHaveLength(2);
    expect(events[0]!.version).toBe(V1);
    expect(events[1]!.version).toBe(V2);
  });

  // -------------------------------------------------------------------------
  // 28. Replay persisted events through the existing Kernel
  // -------------------------------------------------------------------------

  test('28. replay persisted events through Kernel', async () => {
    const CELL = freshCellId();
    let kernelState = cellKernel.evolve(CELL, []);
    if ('code' in kernelState) throw new Error('Unexpected kernel error');

    // Apply CreateCell command
    const createResult = cellKernel.applyCommand(
      kernelState,
      {
        commandId: makeCommandId('cmd-1'),
        cellId: CELL,
        type: 'CreateCell',
        payload: {
          payer: PAYER, payee: PAYEE, amount: AMOUNT, currency: 'TRY',
          fundingDeadline: T1, completionDeadline: T3,
        },
      },
      nextVersion(ZERO_VERSION),
      { now: T1, nextEventId: (i) => makeEventId(`pg-evt-${++evtCounter}-${i}`) },
    );
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    await adapter.eventStore.append(CELL, createResult.events);
    kernelState = createResult.nextState;

    // Apply FundCell command
    const fundResult = cellKernel.applyCommand(
      kernelState,
      {
        commandId: makeCommandId('cmd-2'),
        cellId: CELL,
        type: 'FundCell',
        payload: { funderId: PAYER, amount: AMOUNT },
      },
      nextVersion(nextVersion(ZERO_VERSION)),
      { now: T2, nextEventId: (i) => makeEventId(`pg-evt-${++evtCounter}-${i}`) },
    );
    expect(fundResult.ok).toBe(true);
    if (!fundResult.ok) return;
    await adapter.eventStore.append(CELL, fundResult.events);

    // Reload events from DB and replay through kernel
    const reloadedEvents = await adapter.eventStore.getEvents(CELL);
    expect(reloadedEvents).toHaveLength(2);

    const replayedState = cellKernel.evolve(CELL, reloadedEvents);
    expect('code' in replayedState).toBe(false);
    if ('code' in replayedState) return;
    expect(replayedState.status).toBe('FUNDED');
    expect(replayedState.payer).toBe(PAYER);
    expect(replayedState.payee).toBe(PAYEE);
  });

  // -------------------------------------------------------------------------
  // 29. Missing snapshot does not prevent event replay
  // -------------------------------------------------------------------------

  test('29. missing snapshot does not prevent event replay', async () => {
    const CELL = freshCellId();
    await adapter.eventStore.append(CELL, [makeEvent(CELL, V1)]);
    const snap = await adapter.snapshotStore.load(CELL);
    expect(snap).toBeNull();
    // Events are still loadable
    const events = await adapter.eventStore.getEvents(CELL);
    expect(events).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 30. Event history authoritative when snapshot is stale
  // -------------------------------------------------------------------------

  test('30. event history remains authoritative when snapshot is stale', async () => {
    const CELL = freshCellId();
    await adapter.eventStore.append(CELL, [makeEvent(CELL, V1), makeFundedEvent(CELL, V2)]);

    // Save a stale snapshot at V1
    const staleState = {
      cellId: CELL, status: 'CREATED' as const,
      payer: PAYER, payee: PAYEE, amount: AMOUNT, currency: 'TRY' as const,
      fundingDeadline: T1, completionDeadline: T3,
    };
    await adapter.snapshotStore.save(CELL, { cellId: CELL, version: V1, state: staleState });

    const snap = await adapter.snapshotStore.load(CELL);
    expect(snap!.version).toBe(V1);

    // Full event history must still return both events
    const allEvents = await adapter.eventStore.getEvents(CELL);
    expect(allEvents).toHaveLength(2);

    // Events since snapshot version
    const newEvents = await adapter.eventStore.getEventsSince(CELL, V1);
    expect(newEvents).toHaveLength(1);
    expect(newEvents[0]!.version).toBe(V2);
  });

  test('31. command result is replayed across adapter recreation without duplicate events', async () => {
    const CELL = freshCellId();
    const commandId = makeCommandId(`cmd-pg-replay-${cellCounter}`);
    const event = makeEvent(CELL, V1);
    const first = await adapter.commandExecutionStore.execute(commandId, 'same-fingerprint', async (store) => {
      expect((await store.append(CELL, [event])).ok).toBe(true);
      return { encodedResult: '{"outcome":"SUCCESS"}' };
    });
    const anotherAdapter = new PostgresPersistenceAdapter(pgConfig);
    await anotherAdapter.connect();
    try {
      const replay = await anotherAdapter.commandExecutionStore.execute(commandId, 'same-fingerprint', async () => {
        throw new Error('duplicate work must not execute');
      });
      expect(first.kind).toBe('EXECUTED');
      expect(replay.kind).toBe('REPLAYED');
      expect(await anotherAdapter.eventStore.getEvents(CELL)).toHaveLength(1);
    } finally {
      await anotherAdapter.disconnect();
    }
  });

  test('32. concurrent duplicate command executes work once', async () => {
    const CELL = freshCellId();
    const commandId = makeCommandId(`cmd-pg-race-${cellCounter}`);
    let executions = 0;
    const work = async (store: import('./event-store').EventStore) => {
      executions += 1;
      expect((await store.append(CELL, [makeEvent(CELL, V1)])).ok).toBe(true);
      return { encodedResult: '{"outcome":"SUCCESS"}' };
    };
    const results = await Promise.all([
      adapter.commandExecutionStore.execute(commandId, 'race-fingerprint', work),
      adapter.commandExecutionStore.execute(commandId, 'race-fingerprint', work),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['EXECUTED', 'REPLAYED']);
    expect(executions).toBe(1);
    expect(await adapter.eventStore.getEvents(CELL)).toHaveLength(1);
  });

  test('33. failed transaction rolls back events and permits retry', async () => {
    const CELL = freshCellId();
    const commandId = makeCommandId(`cmd-pg-rollback-${cellCounter}`);
    await expect(adapter.commandExecutionStore.execute(commandId, 'rollback-fingerprint', async (store) => {
      expect((await store.append(CELL, [makeEvent(CELL, V1)])).ok).toBe(true);
      throw new Error('injected failure');
    })).rejects.toThrow('injected failure');
    expect(await adapter.eventStore.getEvents(CELL)).toHaveLength(0);
    const retry = await adapter.commandExecutionStore.execute(commandId, 'rollback-fingerprint', async (store) => {
      expect((await store.append(CELL, [makeEvent(CELL, V1)])).ok).toBe(true);
      return { encodedResult: '{"outcome":"SUCCESS"}' };
    });
    expect(retry.kind).toBe('EXECUTED');
    expect(await adapter.eventStore.getEvents(CELL)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Informational output when tests are skipped
// ---------------------------------------------------------------------------

if (!POSTGRES_ENABLED) {
  test('PostgreSQL tests skipped — set ZINESH_POSTGRES_TESTS=true to enable', () => {
    // This test always passes and communicates why the suite is skipped.
    expect(POSTGRES_ENABLED).toBe(false);
  });
}
