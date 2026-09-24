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
 *   PGDATABASE=zinesh_test PGUSER=postgres PG_PASSWORD_FILE=/run/secrets/postgres-password \
 *   PG_TLS_CA_PATH=/run/secrets/postgres-ca.pem \
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
import { READY_CHECK_TIMEOUT_MS } from './postgres-persistence-adapter';
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
import { PostgresMigrator } from './postgres-migrator';
import type { FundingDisputeObservation, FundingIntent, FundingReceipt } from '../funding/types';
import { PostgresFundingReceiptStore } from './postgres-funding-receipt-store';
import { PostgresFundingDisputeStore } from './postgres-funding-dispute-store';
import { createFundingIntent } from '../funding/funding-intent';
import type { FundingObservation, FundingRoute } from '../funding/funding-foundation';
import type { ProviderEvent, ProviderNegativeObservation,
  ProviderTransactionCorrelation } from '../funding/provider-evidence';
import { providerIdentityHash } from '../funding/provider-identity';

// ---------------------------------------------------------------------------
// Skip guard — tests require a real PostgreSQL instance
// ---------------------------------------------------------------------------

const POSTGRES_ENABLED = process.env['ZINESH_POSTGRES_TESTS'] === 'true';

function testSecret(name: 'PG_PASSWORD_FILE' | 'PG_TLS_CA_PATH'): string {
  if (!POSTGRES_ENABLED) return 'postgres-tests-disabled';
  const filename = process.env[name];
  if (!filename) throw new Error(`${name} is required for PostgreSQL integration tests`);
  return fs.readFileSync(filename, 'utf8');
}

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
  password: testSecret('PG_PASSWORD_FILE'),
  tls: { mode: 'verify-full', ca: testSecret('PG_TLS_CA_PATH') },
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
  await pool.query('TRUNCATE TABLE funding_intents, events, snapshots, command_executions RESTART IDENTITY CASCADE');
}

async function expectTlsConnectionFailure(config: PostgresConfig, expected: RegExp): Promise<void> {
  const candidate = new PostgresPersistenceAdapter(config);
  try {
    let failure: unknown;
    try { await candidate.connect(); } catch (error) { failure = error; }
    expect(failure).toBeDefined();
    const message = String(failure);
    expect(message).toMatch(expected);
    expect(message).not.toContain(pgConfig.password);
  } finally {
    await candidate.disconnect();
  }
}

async function verifyAuthenticatedTlsBoundary(): Promise<void> {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required for PostgreSQL TLS verification`);
    return value;
  };
  const wrongCa = fs.readFileSync(required('PG_TLS_WRONG_CA_PATH'), 'utf8');
  await expectTlsConnectionFailure(
    { ...pgConfig, tls: { mode: 'verify-full', ca: wrongCa } }, /certificate|issuer|self.signed/i,
  );
  await expectTlsConnectionFailure(
    { ...pgConfig, port: Number(required('PG_TLS_HOSTNAME_MISMATCH_PORT')) }, /hostname|altnames/i,
  );
  await expectTlsConnectionFailure(
    { ...pgConfig, port: Number(required('PG_TLS_EXPIRED_PORT')) }, /expired/i,
  );
  await expectTlsConnectionFailure(
    { ...pgConfig, port: Number(required('PG_TLS_INVALID_CHAIN_PORT')) }, /certificate|issuer|verify/i,
  );

  const plaintext = new Pool({
    host: pgConfig.host, port: pgConfig.port, database: pgConfig.database,
    user: pgConfig.user, password: pgConfig.password, ssl: false,
  });
  try {
    await expect(plaintext.query('SELECT 1')).rejects.toThrow(/no pg_hba.conf entry|SSL off|no encryption|rejects connection/i);
  } finally {
    await plaintext.end();
  }

  const bypass = new PostgresPersistenceAdapter({
    ...pgConfig,
    tls: { mode: 'verify-full', ca: wrongCa },
    ssl: { rejectUnauthorized: false },
  } as unknown as PostgresConfig);
  try {
    await expect(bypass.connect()).rejects.toThrow(/certificate|issuer|self.signed/i);
  } finally {
    await bypass.disconnect();
  }
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

function makeFundingReceipt(
  cellId: CellId,
  commandId: ReturnType<typeof makeCommandId>,
  fundingEvent: Event,
  overrides: Partial<FundingReceipt> = {},
): FundingReceipt {
  return {
    intentId: `intent-pg-${evtCounter}`,
    receiptId: `receipt-pg-${++evtCounter}`,
    provider: 'provider-pg',
    environment: 'LIVE',
    providerAccountScope: 'account-pg',
    providerTransactionId: `transaction-pg-${evtCounter}`,
    cellId,
    commandId,
    fundingEventId: fundingEvent.eventId,
    gatewayPrincipalId: 'gateway-pg',
    payer: PAYER,
    payee: PAYEE,
    amount: AMOUNT,
    currency: 'TRY',
    destinationId: 'custody-pg',
    confirmedAt: T1,
    finality: 'FUNDS_HELD',
    evidenceDigest: 'a'.repeat(64),
    verifiedAt: T2,
    createdAt: T3,
    ...overrides,
  };
}

function intentForReceipt(receipt: FundingReceipt): FundingIntent {
  return createFundingIntent({
    intentId: receipt.intentId, provider: receipt.provider, environment: receipt.environment,
    providerAccountScope: receipt.providerAccountScope, cellId: receipt.cellId,
    payer: receipt.payer, payee: receipt.payee, amount: receipt.amount, currency: receipt.currency,
    destinationId: receipt.destinationId,
    createdAt: makeTimestamp(500_000), expiresAt: makeTimestamp(1_500_000),
  });
}

function rebindIntent(
  intent: FundingIntent, change: Partial<Omit<FundingIntent, 'intentId' | 'bindingDigest'>>,
): FundingIntent {
  const { bindingDigest: _bindingDigest, ...draft } = intent;
  return createFundingIntent({ ...draft, ...change });
}

async function createIntent(adapter: PostgresPersistenceAdapter, receipt: FundingReceipt): Promise<void> {
  const result = await adapter.fundingIntentStore.create(intentForReceipt(receipt));
  expect(['CREATED', 'DUPLICATE']).toContain(result.kind);
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
    await new PostgresMigrator(pool).migrate();
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
    await verifyAuthenticatedTlsBoundary();
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

  test('34. readyCheck succeeds for SELECT 1 and expected schema without migrating', async () => {
    const pool = (adapter as unknown as { pool: Pool }).pool;
    await new PostgresMigrator(pool).migrate();
    const migrate = jest.spyOn(adapter.migrator, 'migrate');
    await expect(adapter.readyCheck()).resolves.toBe(true);
    expect(migrate).not.toHaveBeenCalled();
    migrate.mockRestore();
  });

  test('35. readyCheck coalesces in-flight work and caches success for at most one second', async () => {
    await new Promise((resolve) => setTimeout(resolve, READY_CHECK_TIMEOUT_MS + 600));
    const pool = (adapter as unknown as { pool: Pool }).pool;
    await new PostgresMigrator(pool).migrate();
    let selectCount = 0;
    const original = pool.query.bind(pool) as Pool['query'];
    const spy = jest.spyOn(pool, 'query').mockImplementation((...args: Parameters<Pool['query']>) => {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
      if (text === 'SELECT 1') selectCount += 1;
      return original(...args);
    });
    try {
      const [first, second] = await Promise.all([adapter.readyCheck(), adapter.readyCheck()]);
      expect(first).toBe(true);
      expect(second).toBe(true);
      expect(selectCount).toBe(1);
      await expect(adapter.readyCheck()).resolves.toBe(true);
      expect(selectCount).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('36. readyCheck is opaque not-ready when schema is not the expected version', async () => {
    const extra = new PostgresPersistenceAdapter(pgConfig);
    await extra.connect();
    const pool = (extra as unknown as { pool: Pool }).pool;
    await new PostgresMigrator(pool).migrate();
    await pool.query('INSERT INTO schema_migrations(version,name) VALUES (99,$1)', ['probe-break']);
    try {
      const result = await extra.readyCheck();
      expect(result).toBe(false);
      expect(String(result)).not.toContain('99');
      expect(String(result)).not.toContain(pgConfig.password);
    } finally {
      await pool.query('DELETE FROM schema_migrations WHERE version = 99');
      await extra.disconnect();
    }
  });

  test('37. readyCheck is false after the pool is ended', async () => {
    const extra = new PostgresPersistenceAdapter(pgConfig);
    await extra.connect();
    await extra.disconnect();
    await expect(extra.readyCheck()).resolves.toBe(false);
  });

  test('38. funding receipt, CellFunded event and command result commit atomically', async () => {
    const cellId = freshCellId();
    await adapter.eventStore.append(cellId, [makeEvent(cellId, V1)]);
    const commandId = makeCommandId(`funding-command-${cellCounter}`);
    const fundedEvent = makeFundedEvent(cellId, V2);
    const receipt = makeFundingReceipt(cellId, commandId, fundedEvent);
    await createIntent(adapter, receipt);

    const execution = await adapter.commandExecutionStore.execute(
      commandId,
      'funding-atomic-fingerprint',
      async (eventStore, receiptStore) => {
        expect(await receiptStore.claim(receipt)).toEqual({ kind: 'CLAIMED' });
        expect((await eventStore.append(cellId, [fundedEvent])).ok).toBe(true);
        return { encodedResult: '{"outcome":"SUCCESS"}' };
      },
    );
    expect(execution.kind).toBe('EXECUTED');

    const pool = (adapter as unknown as { pool: Pool }).pool;
    const persisted = await pool.query(
      `SELECT receipt_id, intent_id, command_id, funding_event_id, payee, amount::text AS amount,
              evidence_digest, finality
       FROM funding_receipts WHERE receipt_id = $1`,
      [receipt.receiptId],
    );
    expect(persisted.rows).toEqual([{
      receipt_id: receipt.receiptId,
      intent_id: receipt.intentId,
      command_id: commandId,
      funding_event_id: fundedEvent.eventId,
      payee: PAYEE,
      amount: AMOUNT.toString(),
      evidence_digest: receipt.evidenceDigest,
      finality: 'FUNDS_HELD',
    }]);
    expect((await adapter.eventStore.getEvents(cellId)).map((event) => event.type))
      .toEqual(['CellCreated', 'CellFunded']);
  });

  test('39. PostgreSQL preserves a 31-digit integer funding amount exactly', async () => {
    const cellId = freshCellId();
    const exact = makeAmount(1234567890123456789012345678901n);
    await adapter.eventStore.append(cellId, [makeEvent(cellId, V1)]);
    const commandId = makeCommandId(`funding-exact-${cellCounter}`);
    const fundedEvent: Event = {
      ...makeFundedEvent(cellId, V2),
      payload: { fundedBy: PAYER, amount: exact },
    };
    const receipt = makeFundingReceipt(cellId, commandId, fundedEvent, { amount: exact });
    await createIntent(adapter, receipt);
    await adapter.commandExecutionStore.execute(commandId, 'funding-exact-fingerprint', async (events, receipts) => {
      expect((await receipts.claim(receipt)).kind).toBe('CLAIMED');
      expect((await events.append(cellId, [fundedEvent])).ok).toBe(true);
      return { encodedResult: '{"outcome":"SUCCESS"}' };
    });
    const pool = (adapter as unknown as { pool: Pool }).pool;
    expect((await pool.query('SELECT amount::text AS amount FROM funding_receipts WHERE receipt_id=$1', [receipt.receiptId])).rows)
      .toEqual([{ amount: exact.toString() }]);
  });

  test('40. an injected PostgreSQL transaction failure rolls back receipt, event and command', async () => {
    const cellId = freshCellId();
    await adapter.eventStore.append(cellId, [makeEvent(cellId, V1)]);
    const commandId = makeCommandId(`funding-rollback-${cellCounter}`);
    const fundedEvent = makeFundedEvent(cellId, V2);
    const receipt = makeFundingReceipt(cellId, commandId, fundedEvent);
    await createIntent(adapter, receipt);
    await expect(adapter.commandExecutionStore.execute(commandId, 'funding-rollback-fingerprint', async (events, receipts) => {
      expect((await receipts.claim(receipt)).kind).toBe('CLAIMED');
      expect((await events.append(cellId, [fundedEvent])).ok).toBe(true);
      throw new Error('injected funding transaction failure');
    })).rejects.toThrow('injected funding transaction failure');
    const pool = (adapter as unknown as { pool: Pool }).pool;
    expect((await pool.query('SELECT count(*)::int AS count FROM funding_receipts WHERE receipt_id=$1', [receipt.receiptId])).rows[0])
      .toEqual({ count: 0 });
    expect((await pool.query('SELECT count(*)::int AS count FROM command_executions WHERE command_id=$1', [commandId])).rows[0])
      .toEqual({ count: 0 });
    expect((await adapter.eventStore.getEvents(cellId)).map((event) => event.type)).toEqual(['CellCreated']);
  });

  test('41. receipt uniqueness conflict leaves no CellFunded event behind', async () => {
    const firstCell = freshCellId();
    const secondCell = freshCellId();
    await adapter.eventStore.append(firstCell, [makeEvent(firstCell, V1)]);
    await adapter.eventStore.append(secondCell, [makeEvent(secondCell, V1)]);
    const firstCommand = makeCommandId(`funding-first-${cellCounter}`);
    const firstEvent = makeFundedEvent(firstCell, V2);
    const firstReceipt = makeFundingReceipt(firstCell, firstCommand, firstEvent);
    await createIntent(adapter, firstReceipt);
    await adapter.commandExecutionStore.execute(firstCommand, 'funding-first-fingerprint', async (events, receipts) => {
      expect((await receipts.claim(firstReceipt)).kind).toBe('CLAIMED');
      expect((await events.append(firstCell, [firstEvent])).ok).toBe(true);
      return { encodedResult: '{"outcome":"SUCCESS"}' };
    });

    const secondCommand = makeCommandId(`funding-second-${cellCounter}`);
    const secondEvent = makeFundedEvent(secondCell, V2);
    const conflicting = makeFundingReceipt(secondCell, secondCommand, secondEvent, {
      provider: firstReceipt.provider,
      providerTransactionId: firstReceipt.providerTransactionId,
    });
    await createIntent(adapter, conflicting);
    await adapter.commandExecutionStore.execute(secondCommand, 'funding-second-fingerprint', async (events, receipts) => {
      const claim = await receipts.claim(conflicting);
      expect(claim).toEqual({ kind: 'CONFLICT', conflict: 'PROVIDER_TRANSACTION' });
      return { encodedResult: '{"outcome":"APPLICATION_REJECTION"}' };
    });
    expect((await adapter.eventStore.getEvents(secondCell)).map((event) => event.type)).toEqual(['CellCreated']);
  });

  test('42. event version conflict rolls back the uncommitted receipt', async () => {
    const cellId = freshCellId();
    await adapter.eventStore.append(cellId, [makeEvent(cellId, V1), makeFundedEvent(cellId, V2)]);
    const commandId = makeCommandId(`funding-version-conflict-${cellCounter}`);
    const conflictingEvent = makeFundedEvent(cellId, V2);
    const receipt = makeFundingReceipt(cellId, commandId, conflictingEvent);
    await createIntent(adapter, receipt);
    await expect(adapter.commandExecutionStore.execute(commandId, 'funding-version-conflict', async (events, receipts) => {
      expect((await receipts.claim(receipt)).kind).toBe('CLAIMED');
      expect((await events.append(cellId, [conflictingEvent])).ok).toBe(false);
      return { encodedResult: '{"outcome":"PERSISTENCE_FAILURE"}' };
    })).rejects.toThrow();
    const pool = (adapter as unknown as { pool: Pool }).pool;
    expect((await pool.query('SELECT count(*)::int AS count FROM funding_receipts WHERE receipt_id=$1', [receipt.receiptId])).rows[0])
      .toEqual({ count: 0 });
  });

  test('43. concurrent funding attempts allow one receipt and one CellFunded event', async () => {
    const cellId = freshCellId();
    await adapter.eventStore.append(cellId, [makeEvent(cellId, V1)]);
    const execute = async (suffix: string) => {
      const commandId = makeCommandId(`funding-race-${suffix}-${cellCounter}`);
      const fundedEvent = makeFundedEvent(cellId, V2);
      const receipt = makeFundingReceipt(cellId, commandId, fundedEvent);
      await createIntent(adapter, receipt);
      return adapter.commandExecutionStore.execute(commandId, `funding-race-${suffix}`, async (events, receipts) => {
        const claim = await receipts.claim(receipt);
        if (claim.kind !== 'CLAIMED') return { encodedResult: `{"claim":"${claim.kind}"}` };
        const append = await events.append(cellId, [fundedEvent]);
        if (!append.ok) throw new Error('unexpected event conflict after receipt claim');
        return { encodedResult: '{"claim":"CLAIMED"}' };
      });
    };
    const outcomes = await Promise.all([execute('a'), execute('b')]);
    expect(outcomes.map((result) => result.kind === 'CONFLICT' ? 'COMMAND_CONFLICT' : result.encodedResult).sort())
      .toEqual(['{"claim":"CLAIMED"}', '{"claim":"CONFLICT"}']);
    const pool = (adapter as unknown as { pool: Pool }).pool;
    expect((await pool.query('SELECT count(*)::int AS count FROM funding_receipts WHERE cell_id=$1', [cellId])).rows[0])
      .toEqual({ count: 1 });
    expect((await adapter.eventStore.getEvents(cellId)).filter((event) => event.type === 'CellFunded')).toHaveLength(1);
  });

  test('44. historical CellFunded without a receipt remains foldable', async () => {
    const cellId = freshCellId();
    await adapter.eventStore.append(cellId, [makeEvent(cellId, V1), makeFundedEvent(cellId, V2)]);
    const state = cellKernel.evolve(cellId, await adapter.eventStore.getEvents(cellId));
    expect('status' in state && state.status).toBe('FUNDED');
    const pool = (adapter as unknown as { pool: Pool }).pool;
    expect((await pool.query('SELECT count(*)::int AS count FROM funding_receipts WHERE cell_id=$1', [cellId])).rows[0])
      .toEqual({ count: 0 });
  });

  test('45. funding intents preserve the exact payee-aware binding and reject mutation or rebinding', async () => {
    const cellId = freshCellId();
    const receipt = makeFundingReceipt(cellId, makeCommandId(`intent-command-${cellCounter}`),
      makeFundedEvent(cellId, V2));
    const candidate = intentForReceipt(receipt);
    await expect(adapter.fundingIntentStore.create(candidate)).resolves.toEqual({ kind: 'CREATED' });
    await expect(adapter.fundingIntentStore.create({ ...candidate })).resolves
      .toEqual({ kind: 'DUPLICATE', intent: candidate });
    const rebindings: Array<Partial<Omit<FundingIntent, 'intentId' | 'bindingDigest'>>> = [
      { payer: makeActorId('rebound-payer') },
      { payee: makeActorId('rebound-payee') },
      { amount: makeAmount(candidate.amount + 1n) },
      { currency: 'EUR' as never },
      { destinationId: 'rebound-custody' },
    ];
    for (const change of rebindings) {
      await expect(adapter.fundingIntentStore.create(rebindIntent(candidate, change)))
        .resolves.toEqual({ kind: 'CONFLICT' });
      await expect(adapter.fundingIntentStore.get(candidate.intentId)).resolves.toEqual(candidate);
    }
    await expect(adapter.fundingIntentStore.create({
      ...candidate, payee: makeActorId('invalid-rebound-payee'),
    })).resolves.toEqual({ kind: 'INVALID' });
    await expect(adapter.fundingIntentStore.get(candidate.intentId)).resolves.toEqual(candidate);

    const pool = (adapter as unknown as { pool: Pool }).pool;
    await expect(pool.query('UPDATE funding_intents SET destination_id=$2 WHERE intent_id=$1',
      [candidate.intentId, 'rebound-custody'])).rejects.toThrow(/immutable/i);
    await expect(pool.query('DELETE FROM funding_intents WHERE intent_id=$1', [candidate.intentId]))
      .rejects.toThrow(/immutable/i);
  });

  test('46. a funding receipt must match its immutable intent including payee and held finality', async () => {
    const cellId = freshCellId();
    await adapter.eventStore.append(cellId, [makeEvent(cellId, V1)]);
    const commandId = makeCommandId(`intent-link-${cellCounter}`);
    const fundedEvent = makeFundedEvent(cellId, V2);
    const receipt = makeFundingReceipt(cellId, commandId, fundedEvent);
    await createIntent(adapter, receipt);
    const mismatched = { ...receipt, payee: makeActorId('wrong-receipt-payee') };

    await expect(adapter.commandExecutionStore.execute(commandId, 'intent-link-fingerprint',
      async (events, receipts) => {
        expect((await receipts.claim(mismatched)).kind).toBe('CLAIMED');
        expect((await events.append(cellId, [fundedEvent])).ok).toBe(true);
        return { encodedResult: '{"outcome":"SUCCESS"}' };
      })).rejects.toThrow(/match.*intent/i);
    expect((await adapter.eventStore.getEvents(cellId)).map((event) => event.type)).toEqual(['CellCreated']);
    const pool = (adapter as unknown as { pool: Pool }).pool;
    expect((await pool.query('SELECT count(*)::int AS count FROM funding_receipts WHERE intent_id=$1',
      [receipt.intentId])).rows[0]).toEqual({ count: 0 });
  });

  test('47. provider dispute observations are linked, append-only, versioned and settlement-blocking', async () => {
    const cellId = freshCellId();
    await adapter.eventStore.append(cellId, [makeEvent(cellId, V1)]);
    const commandId = makeCommandId(`dispute-funding-${cellCounter}`);
    const fundedEvent = makeFundedEvent(cellId, V2);
    const receipt = makeFundingReceipt(cellId, commandId, fundedEvent);
    await createIntent(adapter, receipt);
    await adapter.commandExecutionStore.execute(commandId, 'dispute-funding-fingerprint', async (events, receipts) => {
      expect((await receipts.claim(receipt)).kind).toBe('CLAIMED');
      expect((await events.append(cellId, [fundedEvent])).ok).toBe(true);
      return { encodedResult: '{"outcome":"SUCCESS"}' };
    });
    const opened: FundingDisputeObservation = {
      observationId: 'pg-dispute-open', provider: receipt.provider, providerDisputeId: 'pg-dispute-1',
      providerTransactionId: receipt.providerTransactionId, observationVersion: 1n,
      receiptId: receipt.receiptId, cellId, kind: 'CHARGEBACK', status: 'OPEN', outcome: 'PENDING',
      amount: receipt.amount,
      currency: receipt.currency, evidenceDigest: 'c'.repeat(64), observedAt: T2, recordedAt: T3,
    };
    await expect(adapter.fundingDisputeStore.record(opened)).resolves.toEqual({ kind: 'RECORDED' });
    await expect(adapter.fundingDisputeStore.record({ ...opened, recordedAt: makeTimestamp(3_000_001) }))
      .resolves.toEqual({ kind: 'DUPLICATE', observation: opened });
    await expect(adapter.fundingDisputeStore.hasBlockingDispute(cellId)).resolves.toBe(true);

    const retained = { ...opened, observationId: 'pg-dispute-retained', observationVersion: 2n as const,
      status: 'RESOLVED' as const, outcome: 'FUNDS_RETAINED' as const,
      evidenceDigest: 'd'.repeat(64), recordedAt: makeTimestamp(3_000_001) };
    await expect(adapter.fundingDisputeStore.record(retained)).resolves.toEqual({ kind: 'RECORDED' });
    await expect(adapter.fundingDisputeStore.hasBlockingDispute(cellId)).resolves.toBe(false);
    await expect(adapter.fundingDisputeStore.record({ ...retained,
      observationId: 'pg-dispute-rebound', observationVersion: 3n, receiptId: 'other-receipt',
      cellId: makeCellId('other-cell'), evidenceDigest: 'f'.repeat(64) }))
      .resolves.toEqual({ kind: 'CONFLICT' });
    await expect(adapter.fundingDisputeStore.record({ ...retained,
      observationId: 'pg-dispute-invalid-lifecycle', observationVersion: 3n,
      status: 'OPEN', evidenceDigest: '0'.repeat(64) }))
      .resolves.toEqual({ kind: 'CONFLICT' });

    const pool = (adapter as unknown as { pool: Pool }).pool;
    await expect(pool.query('UPDATE funding_dispute_observations SET status=$2 WHERE observation_id=$1',
      [opened.observationId, 'CLOSED'])).rejects.toThrow(/append-only/i);
    await expect(pool.query('DELETE FROM funding_dispute_observations WHERE observation_id=$1',
      [opened.observationId])).rejects.toThrow(/append-only/i);
    await expect(adapter.fundingDisputeStore.record({ ...opened, observationId: 'pg-dispute-invalid-link',
      providerDisputeId: 'pg-dispute-invalid', provider: 'wrong-provider', evidenceDigest: 'e'.repeat(64) }))
      .rejects.toThrow(/match.*receipt/i);
  });

  test('48. V7 provider event inbox distinguishes duplicate and conflicting replay', async () => {
    const cellId=freshCellId();
    const receipt=makeFundingReceipt(cellId,makeCommandId(`provider-event-${cellCounter}`),
      makeFundedEvent(cellId,V2));
    await createIntent(adapter,receipt);
    const event:ProviderEvent={eventIdentity:providerIdentityHash('event','1'),
      replayIdentity:providerIdentityHash('replay','1'),provider:receipt.provider,environment:'SANDBOX',
      providerPaymentId:'provider-payment-1',providerTransactionId:receipt.providerTransactionId,
      intentId:receipt.intentId,eventType:'PAYMENT',payloadDigest:'a'.repeat(64),receivedAt:T2};
    await expect(adapter.providerFoundationStore.recordEvent(event)).resolves.toEqual({kind:'FIRST_SEEN'});
    await expect(adapter.providerFoundationStore.recordEvent(event)).resolves.toMatchObject({kind:'DUPLICATE'});
    await expect(adapter.providerFoundationStore.recordEvent({...event,eventIdentity:providerIdentityHash('event','2'),
      payloadDigest:'b'.repeat(64)})).resolves.toEqual({kind:'REPLAY_PAYLOAD_CONFLICT'});
    const pool=(adapter as unknown as {pool:Pool}).pool;
    expect((await pool.query('SELECT count(*)::int AS count FROM funding_receipts WHERE intent_id=$1',
      [event.intentId])).rows[0]).toEqual({count:0});
    await expect(pool.query('UPDATE provider_event_inbox SET event_type=$2 WHERE event_identity=$1',
      [event.eventIdentity,'MUTATED'])).rejects.toThrow(/append-only/i);
  });

  test('49. V7 transaction correlation is immutable and rejects intent or receipt rebinding', async () => {
    const cellId=freshCellId();
    await adapter.eventStore.append(cellId,[makeEvent(cellId,V1)]);
    const commandId=makeCommandId(`provider-correlation-${cellCounter}`);
    const fundedEvent=makeFundedEvent(cellId,V2);
    const receipt=makeFundingReceipt(cellId,commandId,fundedEvent);
    await createIntent(adapter,receipt);
    await adapter.commandExecutionStore.execute(commandId,'provider-correlation',async(events,receipts)=>{
      expect((await receipts.claim(receipt)).kind).toBe('CLAIMED');
      expect((await events.append(cellId,[fundedEvent])).ok).toBe(true);
      return {encodedResult:'{"outcome":"SUCCESS"}'};
    });
    const correlation:ProviderTransactionCorrelation={provider:receipt.provider,environment:'SANDBOX',
      providerTransactionId:receipt.providerTransactionId,providerPaymentId:'provider-payment-2',
      intentId:receipt.intentId,receiptId:receipt.receiptId,cellId,createdAt:T3};
    await expect(adapter.providerFoundationStore.correlateTransaction(correlation))
      .resolves.toEqual({kind:'RECORDED'});
    await expect(adapter.providerFoundationStore.correlateTransaction(correlation))
      .resolves.toMatchObject({kind:'DUPLICATE'});
    await expect(adapter.providerFoundationStore.correlateTransaction({...correlation,intentId:'other'}))
      .resolves.toEqual({kind:'CONFLICT'});
    const pool=(adapter as unknown as {pool:Pool}).pool;
    await expect(pool.query(`UPDATE provider_transaction_correlations SET cell_id='other'
      WHERE provider=$1 AND environment=$2 AND provider_transaction_id=$3`,
    [correlation.provider,correlation.environment,correlation.providerTransactionId]))
      .rejects.toThrow(/immutable/i);
  });

  test('50. V7 negative observations append once and never mutate funding history', async () => {
    const cellId=freshCellId();
    expect((await adapter.eventStore.append(cellId,[makeEvent(cellId,V1)])).ok).toBe(true);
    const commandId=makeCommandId(`provider-negative-${cellCounter}`);
    const fundedEvent=makeFundedEvent(cellId,V2);
    const receipt=makeFundingReceipt(cellId,commandId,fundedEvent);
    await createIntent(adapter,receipt);
    await adapter.commandExecutionStore.execute(commandId,'provider-negative',async(events,receipts)=>{
      expect((await receipts.claim(receipt)).kind).toBe('CLAIMED');
      expect((await events.append(cellId,[fundedEvent])).ok).toBe(true);
      return {encodedResult:'{"outcome":"SUCCESS"}'};
    });
    const correlation:ProviderTransactionCorrelation={provider:receipt.provider,environment:'SANDBOX',
      providerTransactionId:receipt.providerTransactionId,providerPaymentId:'provider-payment-negative',
      intentId:receipt.intentId,receiptId:receipt.receiptId,cellId,createdAt:T3};
    await expect(adapter.providerFoundationStore.correlateTransaction(correlation))
      .resolves.toEqual({kind:'RECORDED'});
    const pool=(adapter as unknown as {pool:Pool}).pool;
    const observation:ProviderNegativeObservation={observationId:providerIdentityHash('negative','1'),
      provider:receipt.provider,environment:'SANDBOX',providerObservationId:'refund-v7-1',
      providerTransactionId:receipt.providerTransactionId,intentId:receipt.intentId,
      receiptId:receipt.receiptId,cellId,kind:'REFUND',amountMinor:makeAmount(1n),
      currency:'TRY',payloadDigest:'c'.repeat(64),observedAt:T2,recordedAt:T3};
    await expect(adapter.providerFoundationStore.appendNegativeObservation(observation))
      .resolves.toEqual({kind:'RECORDED'});
    expect(await adapter.fundingDisputeStore.hasBlockingDispute(cellId)).toBe(true);
    await expect(adapter.providerFoundationStore.appendNegativeObservation(observation))
      .resolves.toMatchObject({kind:'DUPLICATE'});
    const reordered = Object.fromEntries(Object.entries(observation).reverse()) as unknown as ProviderNegativeObservation;
    await expect(adapter.providerFoundationStore.appendNegativeObservation(reordered))
      .resolves.toEqual({kind:'DUPLICATE',observation:{...observation,providerAccountScope:'DEFAULT'}});
    await expect(adapter.providerFoundationStore.appendNegativeObservation({...reordered,amountMinor:makeAmount(2n)}))
      .resolves.toEqual({kind:'CONFLICT'});
    await expect(adapter.providerFoundationStore.appendNegativeObservation({...reordered,payloadDigest:'d'.repeat(64)}))
      .resolves.toEqual({kind:'CONFLICT'});
    expect((await pool.query('SELECT count(*)::int AS count FROM provider_negative_observations WHERE observation_id=$1',
      [observation.observationId])).rows[0]).toEqual({count:1});
    expect((await pool.query('SELECT provider_account_scope FROM provider_negative_observations WHERE observation_id=$1',
      [observation.observationId])).rows[0]).toEqual({provider_account_scope:'DEFAULT'});
    await expect(pool.query('DELETE FROM provider_negative_observations WHERE observation_id=$1',
      [observation.observationId])).rejects.toThrow(/append-only/i);
    expect((await pool.query('SELECT count(*)::int AS count FROM funding_receipts WHERE receipt_id=$1',
      [receipt.receiptId])).rows[0]).toEqual({count:1});
  });

  test('V10 persists scoped receipt bindings and append-only negative dispositions idempotently', async () => {
    await adapter.migrator.migrate();
    await adapter.migrator.verifyExpectedVersion();
    const cellId=freshCellId();
    await adapter.eventStore.append(cellId,[makeEvent(cellId,V1)]);
    const commandId=makeCommandId(`negative-disposition-${cellCounter}`);
    const fundedEvent=makeFundedEvent(cellId,V2);
    const receipt=makeFundingReceipt(cellId,commandId,fundedEvent,{environment:'LIVE',providerAccountScope:'account-v10'});
    await createIntent(adapter,receipt);
    await adapter.commandExecutionStore.execute(commandId,'negative-disposition-funding',async(events,receipts)=>{
      expect((await receipts.claim(receipt)).kind).toBe('CLAIMED');
      expect((await events.append(cellId,[fundedEvent])).ok).toBe(true);
      return {encodedResult:'{"outcome":"SUCCESS"}'};
    });
    const otherCell=freshCellId(); await adapter.eventStore.append(otherCell,[makeEvent(otherCell,V1)]);
    const otherCommand=makeCommandId(`scoped-same-tx-${cellCounter}`);
    const otherEvent=makeFundedEvent(otherCell,V2);
    const otherReceipt=makeFundingReceipt(otherCell,otherCommand,otherEvent,{environment:'LIVE',
      providerAccountScope:'account-v10-other',providerTransactionId:receipt.providerTransactionId});
    await createIntent(adapter,otherReceipt);
    await adapter.commandExecutionStore.execute(otherCommand,'scoped-same-transaction',async(events,receipts)=>{
      expect((await receipts.claim(otherReceipt)).kind).toBe('CLAIMED');
      expect((await events.append(otherCell,[otherEvent])).ok).toBe(true);
      return {encodedResult:'{"outcome":"SUCCESS"}'};
    });
    await adapter.providerFoundationStore.correlateTransaction({provider:receipt.provider,environment:receipt.environment,
      providerAccountScope:receipt.providerAccountScope,providerTransactionId:receipt.providerTransactionId,
      intentId:receipt.intentId,receiptId:receipt.receiptId,cellId,createdAt:T3});
    const observation:ProviderNegativeObservation={observationId:providerIdentityHash('negative-v10',String(cellId)),
      provider:receipt.provider,environment:receipt.environment,providerAccountScope:receipt.providerAccountScope,
      providerObservationId:`negative-v10-${cellCounter}`,providerTransactionId:receipt.providerTransactionId,
      intentId:receipt.intentId,receiptId:receipt.receiptId,cellId,kind:'RETURNED',amountMinor:receipt.amount,
      currency:receipt.currency,payloadDigest:'f'.repeat(64),observedAt:T3,recordedAt:T3};
    await expect(adapter.providerFoundationStore.appendNegativeObservation(observation)).resolves.toEqual({kind:'RECORDED'});
    expect(await adapter.fundingDisputeStore.hasBlockingDispute(cellId)).toBe(true);
    const pool=(adapter as unknown as {pool:Pool}).pool;
    await pool.query(`INSERT INTO principals(principal_id,principal_type,actor_id,enabled,mapping_version)
      VALUES($1,'GATEWAY',NULL,TRUE,1)`,[`resolver-v10-${cellCounter}`]);
    await pool.query(`INSERT INTO principal_capabilities(principal_id,capability) VALUES($1,'RESOLVE_FUNDING_NEGATIVE')`,
      [`resolver-v10-${cellCounter}`]);
    const disposition={resolutionId:`resolution-v10-${cellCounter}`,sourceNegativeObservationId:observation.observationId,
      provider:receipt.provider,environment:receipt.environment,providerAccountScope:receipt.providerAccountScope,
      providerObservationId:observation.providerObservationId,providerTransactionId:receipt.providerTransactionId,
      intentId:receipt.intentId,receiptId:receipt.receiptId,cellId,amount:receipt.amount,currency:receipt.currency,
      status:'RESOLVED' as const,outcome:'FUNDS_RETAINED' as const,version:1n,evidenceReference:'provider/statement/v10',
      evidenceDigest:'9'.repeat(64),observedAt:T3,recordedAt:T3,resolverPrincipalId:`resolver-v10-${cellCounter}`,
      resolverCapability:'RESOLVE_FUNDING_NEGATIVE' as const};
    await expect(adapter.providerFoundationStore.appendNegativeDisposition(disposition)).resolves.toBe('RECORDED');
    await expect(adapter.providerFoundationStore.appendNegativeDisposition(disposition)).resolves.toBe('DUPLICATE');
    expect(await adapter.fundingDisputeStore.hasBlockingDispute(cellId)).toBe(false);
    await expect(pool.query('UPDATE provider_negative_dispositions SET outcome=$2 WHERE resolution_id=$1',
      [disposition.resolutionId,'FUNDS_LOST'])).rejects.toThrow(/append-only/i);
  });

  test('51. V8 route and unmatched funding observations persist without intent fabrication', async () => {
    const cellId=freshCellId();
    const intentReceipt=makeFundingReceipt(cellId,makeCommandId(`route-v8-${cellCounter}`),makeFundedEvent(cellId,V2));
    await createIntent(adapter,intentReceipt);
    const route:FundingRoute={routeId:`route-${cellCounter}`,intentId:intentReceipt.intentId,provider:intentReceipt.provider,
      environment:'LIVE',providerAccountScope:'account-a',destinationReference:intentReceipt.destinationId,
      currency:intentReceipt.currency,expectedAmount:intentReceipt.amount,status:'ACTIVE',createdAt:T3};
    await expect(adapter.providerFoundationStore.createRoute(route)).resolves.toEqual({kind:'CREATED'});
    await expect(adapter.providerFoundationStore.createRoute(route)).resolves.toMatchObject({kind:'DUPLICATE'});
    const observation:FundingObservation={observationId:'bank-observation-1',provider:route.provider,environment:route.environment,
      providerAccountScope:route.providerAccountScope,providerTransactionId:'bank-transaction-unmatched',direction:'CREDIT',
      amount:makeAmount(1n),currency:'TRY',observedAt:T3,destinationReference:'unknown-route',
      rawPayloadDigest:'d'.repeat(64),state:'SETTLED'};
    await expect(adapter.providerFoundationStore.recordObservation(observation)).resolves.toEqual({kind:'RECORDED'});
    await expect(adapter.providerFoundationStore.recordObservation(observation)).resolves.toMatchObject({kind:'DUPLICATE',
      observation:{correlationStatus:'UNMATCHED'}});
    await expect(adapter.providerFoundationStore.listUnmatchedObservations(route.provider,route.environment,
      route.providerAccountScope,10)).resolves.toHaveLength(1);
    const unmatched=await adapter.providerFoundationStore.listUnmatchedObservations(route.provider,route.environment,
      route.providerAccountScope,10);
    expect(unmatched[0]).not.toHaveProperty('intentId');
    const pool=(adapter as unknown as {pool:Pool}).pool;
    expect((await pool.query('SELECT count(*)::int AS count FROM provider_funding_observations WHERE observation_id=$1',
      [observation.observationId])).rows[0]).toEqual({count:1});
  });

  test('52. V8 inbox claims are concurrent, recoverable, and idempotently completed', async () => {
    const event:ProviderEvent={eventIdentity:providerIdentityHash('event','unmatched'),
      replayIdentity:providerIdentityHash('replay','unmatched'),provider:'bank-v8',environment:'LIVE',
      providerTransactionId:'bank-tx-no-intent',eventType:'ACCOUNT_CREDIT',payloadDigest:'e'.repeat(64),receivedAt:T2};
    await expect(adapter.providerFoundationStore.recordEvent(event)).resolves.toEqual({kind:'FIRST_SEEN'});
    const claims=await Promise.all([
      adapter.providerFoundationStore.claimEvent(event.eventIdentity,'worker-a',1000,100),
      adapter.providerFoundationStore.claimEvent(event.eventIdentity,'worker-b',1000,100),
    ]);
    expect(claims.map((claim)=>claim.kind).sort()).toEqual(['BUSY','CLAIMED']);
    const owner=claims[0]?.kind==='CLAIMED'?'worker-a':'worker-b';
    const outsider=owner==='worker-a'?'worker-b':'worker-a';
    await expect(adapter.providerFoundationStore.completeEvent(event.eventIdentity,outsider,1001)).resolves.toBe('NOT_CLAIMED');
    await expect(adapter.providerFoundationStore.completeEvent(event.eventIdentity,owner,1001)).resolves.toBe('PROCESSED');
    await expect(adapter.providerFoundationStore.completeEvent(event.eventIdentity,owner,1002)).resolves.toBe('PROCESSED');
    await expect(adapter.providerFoundationStore.claimEvent(event.eventIdentity,'worker-c',1003,100)).resolves.toEqual({kind:'PROCESSED'});
  });

  test('53. V8 account cursor uses optimistic revision and transaction checkpoints reject stale regression', async () => {
    const cellId=freshCellId();
    const receipt=makeFundingReceipt(cellId,makeCommandId(`checkpoint-v8-${cellCounter}`),makeFundedEvent(cellId,V2));
    await createIntent(adapter,receipt);
    const correlation:ProviderTransactionCorrelation={provider:receipt.provider,environment:'LIVE',
      providerAccountScope:'account-v8',providerTransactionId:receipt.providerTransactionId,
      intentId:receipt.intentId,cellId,createdAt:T3};
    await adapter.providerFoundationStore.correlateTransaction(correlation);
    await adapter.providerFoundationStore.putCheckpoint({provider:receipt.provider,environment:'LIVE',
      providerAccountScope:'account-v8',providerTransactionId:receipt.providerTransactionId,
      state:'FUNDS_HELD',attemptCount:2,checkedAt:T3});
    await adapter.providerFoundationStore.putCheckpoint({provider:receipt.provider,environment:'LIVE',
      providerAccountScope:'account-v8',providerTransactionId:receipt.providerTransactionId,
      state:'PENDING',attemptCount:3,checkedAt:T3});
    await expect(adapter.providerFoundationStore.getCorrelation(receipt.provider,'LIVE',receipt.providerTransactionId,'account-v8'))
      .resolves.toMatchObject({providerAccountScope:'account-v8'});
    await expect(adapter.providerFoundationStore.getCheckpoint(receipt.provider,'LIVE',receipt.providerTransactionId,'account-v8'))
      .resolves.toMatchObject({providerAccountScope:'account-v8',state:'FUNDS_HELD',attemptCount:2});
    const accountCheckpoint={provider:receipt.provider,environment:'LIVE' as const,providerAccountScope:'account-v8',
      cursor:'cursor-1',checkedAt:T3,revision:1};
    await expect(adapter.providerFoundationStore.putAccountCheckpoint(accountCheckpoint)).resolves.toBe(true);
    await expect(adapter.providerFoundationStore.putAccountCheckpoint({...accountCheckpoint,cursor:'stale',revision:1}))
      .resolves.toBe(false);
    await expect(adapter.providerFoundationStore.getAccountCheckpoint(receipt.provider,'LIVE','account-v8'))
      .resolves.toMatchObject({cursor:'cursor-1',revision:1});
  });

  test('54. identical transaction IDs stay isolated across account scopes for correlation and negatives', async () => {
    const cellId=freshCellId();
    const receipt=makeFundingReceipt(cellId,makeCommandId(`scope-parity-${cellCounter}`),makeFundedEvent(cellId,V2));
    await createIntent(adapter,receipt);
    const cellB=freshCellId();
    const receiptB=makeFundingReceipt(cellB,makeCommandId(`scope-parity-b-${cellCounter}`),makeFundedEvent(cellB,V2));
    await createIntent(adapter,receiptB);
    const tx='same-provider-transaction-id';
    const a:ProviderTransactionCorrelation={provider:receipt.provider,environment:'LIVE',providerAccountScope:'account-A',
      providerTransactionId:tx,intentId:receipt.intentId,cellId,createdAt:T3};
    const b={...a,providerAccountScope:'account-B',intentId:receiptB.intentId,cellId:cellB};
    await expect(adapter.providerFoundationStore.correlateTransaction(a)).resolves.toEqual({kind:'RECORDED'});
    await expect(adapter.providerFoundationStore.correlateTransaction(b)).resolves.toEqual({kind:'RECORDED'});
    await expect(adapter.providerFoundationStore.correlateTransaction(a)).resolves.toMatchObject({kind:'DUPLICATE'});
    const observationA:FundingObservation={observationId:'scope-observation',provider:receipt.provider,environment:'LIVE',
      providerAccountScope:'account-A',providerTransactionId:tx,direction:'CREDIT',amount:receipt.amount,currency:'TRY',
      observedAt:T3,destinationReference:receipt.destinationId,rawPayloadDigest:'a'.repeat(64),state:'SETTLED'};
    const observationB={...observationA,providerAccountScope:'account-B',observationId:'scope-observation-B',
      amount:receiptB.amount,destinationReference:receiptB.destinationId};
    await adapter.providerFoundationStore.recordObservation(observationA);
    await adapter.providerFoundationStore.recordObservation(observationB);
    expect(await adapter.providerFoundationStore.listUnmatchedObservations(receipt.provider,'LIVE','account-A',10)).toHaveLength(0);
    expect(await adapter.providerFoundationStore.listUnmatchedObservations(receipt.provider,'LIVE','account-B',10)).toHaveLength(0);
    const negative=(scope:string,intentId:string,cell:string):ProviderNegativeObservation=>({observationId:providerIdentityHash('scope-negative',scope),
      provider:receipt.provider,environment:'LIVE',providerAccountScope:scope,providerObservationId:'negative-shared-id',
      providerTransactionId:tx,intentId,cellId:cell,kind:'RETURNED',payloadDigest:'b'.repeat(64),
      observedAt:T3,recordedAt:T3});
    const negativeA=negative('account-A',receipt.intentId,cellId); const negativeB=negative('account-B',receiptB.intentId,cellB);
    await expect(adapter.providerFoundationStore.appendNegativeObservation(negativeA)).resolves.toEqual({kind:'RECORDED'});
    expect(await adapter.fundingDisputeStore.hasBlockingDispute(cellB)).toBe(false);
    await expect(adapter.providerFoundationStore.appendNegativeObservation(negativeB)).resolves.toEqual({kind:'RECORDED'});
    await expect(adapter.providerFoundationStore.appendNegativeObservation(negativeA)).resolves.toMatchObject({kind:'DUPLICATE'});
    const pool=(adapter as unknown as {pool:Pool}).pool;
    expect((await pool.query(`SELECT provider_account_scope FROM provider_negative_observations
      WHERE observation_id=ANY($1::char(64)[]) ORDER BY provider_account_scope`,[[negativeA.observationId,negativeB.observationId]])).rows)
      .toEqual([{provider_account_scope:'account-A'},{provider_account_scope:'account-B'}]);
  });

  test('55. negative write and settlement check serialize on the funding receipt row', async () => {
    const cellId=freshCellId();
    await adapter.eventStore.append(cellId,[makeEvent(cellId,V1)]);
    const fundedEvent=makeFundedEvent(cellId,V2);
    const receipt=makeFundingReceipt(cellId,makeCommandId(`negative-race-${cellCounter}`),fundedEvent);
    await createIntent(adapter,receipt);
    await adapter.commandExecutionStore.execute(receipt.commandId,'negative-race-funding',async(events,receipts)=>{
      expect((await receipts.claim(receipt)).kind).toBe('CLAIMED');
      expect((await events.append(cellId,[fundedEvent])).ok).toBe(true);
      return {encodedResult:'{"outcome":"SUCCESS"}'};
    });
    await adapter.providerFoundationStore.correlateTransaction({provider:receipt.provider,environment:'LIVE',
      providerAccountScope:'account-race',providerTransactionId:receipt.providerTransactionId,
      intentId:receipt.intentId,receiptId:receipt.receiptId,cellId,createdAt:T3});
    const pool=(adapter as unknown as {pool:Pool}).pool;
    const settlementClient=await pool.connect();
    const observation:ProviderNegativeObservation={observationId:providerIdentityHash('negative-race',String(cellId)),
      provider:receipt.provider,environment:'LIVE',providerAccountScope:'account-race',
      providerObservationId:`negative-race-${cellCounter}`,providerTransactionId:receipt.providerTransactionId,
      intentId:receipt.intentId,receiptId:receipt.receiptId,cellId,kind:'RETURNED',payloadDigest:'e'.repeat(64),
      observedAt:T3,recordedAt:T3};
    try {
      await settlementClient.query('BEGIN');
      const txDisputes=new PostgresFundingDisputeStore(pool,settlementClient);
      expect(await txDisputes.hasBlockingDispute(cellId)).toBe(false);
      const writer=adapter.providerFoundationStore.appendNegativeObservation(observation);
      let waiting=false;
      const deadline=Date.now()+5_000;
      while(Date.now()<deadline){
        const activity=await pool.query<{waiting:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type='Lock' AND query LIKE '%funding_receipts WHERE cell_id=$1 FOR UPDATE%') AS waiting`);
        if(activity.rows[0]?.waiting===true){waiting=true;break;}
        await new Promise((resolve)=>setTimeout(resolve,10));
      }
      expect(waiting).toBe(true);
      await settlementClient.query('COMMIT');
      await expect(writer).resolves.toEqual({kind:'RECORDED'});
      expect(await adapter.fundingDisputeStore.hasBlockingDispute(cellId)).toBe(true);
    } catch(error) {
      await settlementClient.query('ROLLBACK').catch(()=>undefined);
      throw error;
    } finally {
      settlementClient.release();
    }
  });

  test('negative resolution serializes with settlement and only enables a later recheck', async () => {
    const cellId=freshCellId(); await adapter.eventStore.append(cellId,[makeEvent(cellId,V1)]);
    const commandId=makeCommandId(`negative-resolution-race-${cellCounter}`),fundedEvent=makeFundedEvent(cellId,V2);
    const receipt=makeFundingReceipt(cellId,commandId,fundedEvent,{environment:'LIVE',providerAccountScope:'resolution-race'});
    await createIntent(adapter,receipt);
    await adapter.commandExecutionStore.execute(commandId,'negative-resolution-race-funding',async(events,receipts)=>{
      expect((await receipts.claim(receipt)).kind).toBe('CLAIMED');
      expect((await events.append(cellId,[fundedEvent])).ok).toBe(true); return {encodedResult:'{"outcome":"SUCCESS"}'};
    });
    await adapter.providerFoundationStore.correlateTransaction({provider:receipt.provider,environment:'LIVE',
      providerAccountScope:'resolution-race',providerTransactionId:receipt.providerTransactionId,intentId:receipt.intentId,
      receiptId:receipt.receiptId,cellId,createdAt:T3});
    const negative:ProviderNegativeObservation={observationId:providerIdentityHash('resolution-race',String(cellId)),
      provider:receipt.provider,environment:'LIVE',providerAccountScope:'resolution-race',
      providerObservationId:`resolution-race-${cellCounter}`,providerTransactionId:receipt.providerTransactionId,
      intentId:receipt.intentId,receiptId:receipt.receiptId,cellId,kind:'RETURNED',amountMinor:receipt.amount,
      currency:receipt.currency,payloadDigest:'8'.repeat(64),observedAt:T3,recordedAt:T3};
    await adapter.providerFoundationStore.appendNegativeObservation(negative);
    const pool=(adapter as unknown as {pool:Pool}).pool;
    const principalId=`resolution-race-gateway-${cellCounter}`;
    await pool.query(`INSERT INTO principals(principal_id,principal_type,actor_id,enabled,mapping_version)
      VALUES($1,'GATEWAY',NULL,TRUE,1)`,[principalId]);
    await pool.query(`INSERT INTO principal_capabilities(principal_id,capability) VALUES($1,'RESOLVE_FUNDING_NEGATIVE')`,[principalId]);
    const disposition={resolutionId:`resolution-race-${cellCounter}`,sourceNegativeObservationId:negative.observationId,
      provider:receipt.provider,environment:'LIVE' as const,providerAccountScope:'resolution-race',
      providerObservationId:negative.providerObservationId,providerTransactionId:negative.providerTransactionId,
      intentId:receipt.intentId,receiptId:receipt.receiptId,cellId,amount:receipt.amount,currency:receipt.currency,
      status:'RESOLVED' as const,outcome:'FUNDS_RETAINED' as const,version:1n,evidenceReference:'statement/race',
      evidenceDigest:'7'.repeat(64),observedAt:T3,recordedAt:T3,resolverPrincipalId:principalId,
      resolverCapability:'RESOLVE_FUNDING_NEGATIVE' as const};
    const settlementClient=await pool.connect();
    try {
      await settlementClient.query('BEGIN');
      const settlementStore=new PostgresFundingDisputeStore(pool,settlementClient);
      expect(await settlementStore.hasBlockingDispute(cellId)).toBe(true);
      const resolver=adapter.providerFoundationStore.appendNegativeDisposition(disposition);
      let waiting=false; const deadline=Date.now()+5_000;
      while(Date.now()<deadline){
        const activity=await pool.query<{waiting:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type='Lock' AND query LIKE '%funding_receipts WHERE receipt_id=$1 FOR UPDATE%') AS waiting`);
        if(activity.rows[0]?.waiting===true){waiting=true;break;}
        await new Promise((resolve)=>setTimeout(resolve,10));
      }
      expect(waiting).toBe(true);
      await settlementClient.query('COMMIT');
      await expect(resolver).resolves.toBe('RECORDED');
      expect(await adapter.fundingDisputeStore.hasBlockingDispute(cellId)).toBe(false);
    } catch(error) { await settlementClient.query('ROLLBACK').catch(()=>undefined); throw error; }
    finally { settlementClient.release(); }
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

test('readyCheck is opaque false when PostgreSQL is unreachable', async () => {
  const extra = new PostgresPersistenceAdapter({
    ...pgConfig,
    port: 1,
    password: 'unreachable-secret-must-not-leak',
  });
  try {
    const result = await extra.readyCheck();
    expect(result).toBe(false);
    expect(String(result)).not.toContain('unreachable-secret-must-not-leak');
  } finally {
    await extra.disconnect();
  }
});
