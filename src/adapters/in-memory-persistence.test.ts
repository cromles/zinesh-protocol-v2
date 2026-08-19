/**
 * ZINESH PROTOCOL V2 — In-Memory Persistence Tests
 *
 * Tests InMemoryEventStore, InMemorySnapshotStore, and InMemoryPersistenceAdapter.
 *
 * Coverage:
 *
 * EVENT STORE (1–15)
 *  1.  append single event → getEvents returns it
 *  2.  append multiple events → supplied order preserved
 *  3.  different cells remain isolated
 *  4.  non-existent cell → empty array
 *  5.  getEventsSince filters by version
 *  6.  getEventsSince with no matching events → empty array
 *  7.  getEvents returns copy (not internal reference)
 *  8.  getEventsSince returns copy (not internal reference)
 *  9.  append does not overwrite existing events
 *  10. supplied event version is preserved
 *  11. supplied timestamp is preserved
 *  12. supplied payload is preserved
 *  13. store does not generate version (version from caller is used verbatim)
 *  14. store does not reorder supplied events
 *  15. version conflict (gap) is rejected explicitly, not silently reordered
 *
 * SNAPSHOT STORE (16–22)
 *  16. save → load returns correct snapshot
 *  17. missing snapshot → null
 *  18. save overwrites previous snapshot (UPSERT)
 *  19. load returns copy — mutation does not affect stored snapshot
 *  20. different cells remain isolated
 *  21. snapshot version is preserved verbatim
 *  22. store does not generate snapshot version (caller-supplied version used)
 *
 * PERSISTENCE ADAPTER (23–26)
 *  23. connect resolves without error
 *  24. disconnect resolves without error
 *  25. eventStore is accessible and functional
 *  26. snapshotStore is accessible and functional
 *
 * INTEGRATION (27–30)
 *  27. events and snapshot can coexist for the same cell
 *  28. missing snapshot does not prevent event replay
 *  29. event history remains source of truth (snapshot can be stale)
 *  30. snapshot replacement does not mutate event history
 */

import { InMemoryEventStore } from './in-memory-event-store';
import { InMemorySnapshotStore } from './in-memory-snapshot-store';
import { InMemoryPersistenceAdapter } from './in-memory-persistence-adapter';
import type { Snapshot } from './snapshot-store';
import {
  makeActorId,
  makeCellId,
  makeEventId,
  makeTimestamp,
  makeAmount,
  nextVersion,
  ZERO_VERSION,
} from '../core/types';
import type { CellId, CellState, Event, Version } from '../core/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CELL_A: CellId = makeCellId('cell-a');
const CELL_B: CellId = makeCellId('cell-b');
const CELL_C: CellId = makeCellId('cell-c');

const PAYER  = makeActorId('payer-1');
const PAYEE  = makeActorId('payee-1');
const AMOUNT = makeAmount(10000n);

const T1 = makeTimestamp(1_000_000);
const T2 = makeTimestamp(2_000_000);
const T3 = makeTimestamp(3_000_000);

const V1 = nextVersion(ZERO_VERSION);        // 1
const V2 = nextVersion(V1);                  // 2
const V3 = nextVersion(V2);                  // 3

function makeEvent(
  cellId: CellId,
  version: Version,
  timestamp = T1,
): Event {
  return {
    eventId:   makeEventId(`evt-${cellId}-v${version}`),
    cellId,
    version,
    timestamp,
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

function makeFundedEvent(cellId: CellId, version: Version, timestamp = T2): Event {
  return {
    eventId:   makeEventId(`evt-funded-${cellId}-v${version}`),
    cellId,
    version,
    timestamp,
    type:      'CellFunded',
    payload:   { fundedBy: PAYER, amount: AMOUNT },
  };
}

function makeSnapshot(cellId: CellId, version: Version): Snapshot {
  const state: CellState = {
    cellId,
    status:             'FUNDED',
    payer:              PAYER,
    payee:              PAYEE,
    amount:             AMOUNT,
    currency:           'TRY',
    fundingDeadline:    T1,
    completionDeadline: T3,
    fundedAt:           T2,
  };
  return { cellId, version, state };
}

// ---------------------------------------------------------------------------
// 1–15: EventStore tests
// ---------------------------------------------------------------------------

describe('EventStore — InMemoryEventStore', () => {

  test('1. append single event → getEvents returns it', async () => {
    const store = new InMemoryEventStore();
    const event = makeEvent(CELL_A, V1);
    const result = await store.append(CELL_A, [event]);
    expect(result.ok).toBe(true);
    const events = await store.getEvents(CELL_A);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventId).toBe(event.eventId);
  });

  test('2. append multiple events → supplied order preserved', async () => {
    const store = new InMemoryEventStore();
    const e1 = makeEvent(CELL_A, V1, T1);
    const e2 = makeFundedEvent(CELL_A, V2, T2);
    await store.append(CELL_A, [e1, e2]);
    const events = await store.getEvents(CELL_A);
    expect(events).toHaveLength(2);
    expect(events[0]!.version).toBe(V1);
    expect(events[1]!.version).toBe(V2);
    expect(events[0]!.eventId).toBe(e1.eventId);
    expect(events[1]!.eventId).toBe(e2.eventId);
  });

  test('3. different cells remain isolated', async () => {
    const store = new InMemoryEventStore();
    await store.append(CELL_A, [makeEvent(CELL_A, V1)]);
    await store.append(CELL_B, [makeEvent(CELL_B, V1)]);

    const aEvents = await store.getEvents(CELL_A);
    const bEvents = await store.getEvents(CELL_B);

    expect(aEvents).toHaveLength(1);
    expect(bEvents).toHaveLength(1);
    expect(aEvents[0]!.cellId).toBe(CELL_A);
    expect(bEvents[0]!.cellId).toBe(CELL_B);
    // Cell A events must not appear in Cell B results
    const aIds = aEvents.map((e) => e.eventId);
    const bIds = bEvents.map((e) => e.eventId);
    for (const id of aIds) {
      expect(bIds).not.toContain(id);
    }
  });

  test('4. non-existent cell → empty array', async () => {
    const store = new InMemoryEventStore();
    const events = await store.getEvents(CELL_C);
    expect(events).toHaveLength(0);
  });

  test('5. getEventsSince filters by version', async () => {
    const store = new InMemoryEventStore();
    const e1 = makeEvent(CELL_A, V1, T1);
    const e2 = makeFundedEvent(CELL_A, V2, T2);
    const e3: Event = { ...makeEvent(CELL_A, V3, T3), eventId: makeEventId('e3') };
    await store.append(CELL_A, [e1, e2, e3]);

    const since1 = await store.getEventsSince(CELL_A, V1);
    expect(since1).toHaveLength(2);
    expect(since1[0]!.version).toBe(V2);
    expect(since1[1]!.version).toBe(V3);
  });

  test('6. getEventsSince with no matching events → empty array', async () => {
    const store = new InMemoryEventStore();
    await store.append(CELL_A, [makeEvent(CELL_A, V1)]);
    const result = await store.getEventsSince(CELL_A, V1);
    expect(result).toHaveLength(0);
  });

  test('7. getEvents returns copy — mutation does not affect store', async () => {
    const store = new InMemoryEventStore();
    await store.append(CELL_A, [makeEvent(CELL_A, V1)]);

    const copy1 = await store.getEvents(CELL_A);
    // TypeScript readonly prevents direct push — cast to test runtime behaviour
    (copy1 as Event[]).push(makeEvent(CELL_A, V2));

    const copy2 = await store.getEvents(CELL_A);
    expect(copy2).toHaveLength(1);
  });

  test('8. getEventsSince returns copy — mutation does not affect store', async () => {
    const store = new InMemoryEventStore();
    const e1 = makeEvent(CELL_A, V1, T1);
    const e2 = makeFundedEvent(CELL_A, V2, T2);
    await store.append(CELL_A, [e1, e2]);

    const copy = await store.getEventsSince(CELL_A, V1);
    (copy as Event[]).push(makeEvent(CELL_A, V3));

    const fresh = await store.getEventsSince(CELL_A, V1);
    expect(fresh).toHaveLength(1);
  });

  test('9. append does not overwrite existing events', async () => {
    const store = new InMemoryEventStore();
    const e1 = makeEvent(CELL_A, V1, T1);
    await store.append(CELL_A, [e1]);

    const e2 = makeFundedEvent(CELL_A, V2, T2);
    await store.append(CELL_A, [e2]);

    const events = await store.getEvents(CELL_A);
    expect(events).toHaveLength(2);
    // Original event is still present and unchanged
    expect(events[0]!.eventId).toBe(e1.eventId);
    expect(events[0]!.version).toBe(V1);
    expect(events[1]!.eventId).toBe(e2.eventId);
  });

  test('10. supplied event version is preserved verbatim', async () => {
    const store = new InMemoryEventStore();
    const event = makeEvent(CELL_A, V1);
    await store.append(CELL_A, [event]);
    const [stored] = await store.getEvents(CELL_A);
    expect(stored!.version).toBe(V1);
  });

  test('11. supplied timestamp is preserved verbatim', async () => {
    const store = new InMemoryEventStore();
    const ts = makeTimestamp(9_999_999);
    const event: Event = { ...makeEvent(CELL_A, V1), timestamp: ts };
    await store.append(CELL_A, [event]);
    const [stored] = await store.getEvents(CELL_A);
    expect(stored!.timestamp).toBe(ts);
  });

  test('12. supplied payload is preserved verbatim', async () => {
    const store = new InMemoryEventStore();
    const event = makeEvent(CELL_A, V1);
    await store.append(CELL_A, [event]);
    const [stored] = await store.getEvents(CELL_A);
    expect(stored!.payload).toEqual(event.payload);
  });

  test('13. store does not generate version — caller-supplied version is used', async () => {
    const store = new InMemoryEventStore();
    // Deliberately use V1 (not auto-generated)
    const event = makeEvent(CELL_A, V1);
    await store.append(CELL_A, [event]);
    const [stored] = await store.getEvents(CELL_A);
    // Version must be exactly what we supplied, not what the store decided
    expect(stored!.version).toBe(V1);
    expect(stored!.version).not.toBe(ZERO_VERSION);
  });

  test('14. store does not reorder supplied events', async () => {
    // Supply events already in V1, V2, V3 order; they must come back in that order
    const store = new InMemoryEventStore();
    const e1 = makeEvent(CELL_A, V1, T1);
    const e2 = makeFundedEvent(CELL_A, V2, T2);
    const e3: Event = { ...makeEvent(CELL_A, V3, T3), eventId: makeEventId('e3-sort') };
    await store.append(CELL_A, [e1, e2, e3]);
    const events = await store.getEvents(CELL_A);
    expect(events[0]!.version).toBe(V1);
    expect(events[1]!.version).toBe(V2);
    expect(events[2]!.version).toBe(V3);
  });

  test('15. version conflict is rejected explicitly, not silently reordered', async () => {
    const store = new InMemoryEventStore();
    await store.append(CELL_A, [makeEvent(CELL_A, V1)]);

    // Try to append an event with wrong version (gap: skips V2, goes to V3)
    const result = await store.append(CELL_A, [makeEvent(CELL_A, V3)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('APPEND_VERSION_CONFLICT');

    // Store must still have only the original event — no partial write
    const events = await store.getEvents(CELL_A);
    expect(events).toHaveLength(1);
    expect(events[0]!.version).toBe(V1);
  });

});

// ---------------------------------------------------------------------------
// 16–22: SnapshotStore tests
// ---------------------------------------------------------------------------

describe('SnapshotStore — InMemorySnapshotStore', () => {

  test('16. save → load returns correct snapshot', async () => {
    const store = new InMemorySnapshotStore();
    const snap = makeSnapshot(CELL_A, V2);
    await store.save(CELL_A, snap);
    const loaded = await store.load(CELL_A);
    expect(loaded).not.toBeNull();
    expect(loaded!.cellId).toBe(CELL_A);
    expect(loaded!.version).toBe(V2);
    expect(loaded!.state.status).toBe('FUNDED');
  });

  test('17. missing snapshot → null', async () => {
    const store = new InMemorySnapshotStore();
    const result = await store.load(CELL_C);
    expect(result).toBeNull();
  });

  test('18. save overwrites previous snapshot (UPSERT)', async () => {
    const store = new InMemorySnapshotStore();
    const snap1 = makeSnapshot(CELL_A, V1);
    const snap2 = makeSnapshot(CELL_A, V3);
    await store.save(CELL_A, snap1);
    await store.save(CELL_A, snap2);
    const loaded = await store.load(CELL_A);
    expect(loaded!.version).toBe(V3);
  });

  test('19. load returns copy — mutation does not affect stored snapshot', async () => {
    const store = new InMemorySnapshotStore();
    const snap = makeSnapshot(CELL_A, V2);
    await store.save(CELL_A, snap);

    const copy = await store.load(CELL_A);
    // Mutate the returned copy
    (copy!.state as { status: string }).status = 'RELEASED';

    // Store must be unaffected
    const reloaded = await store.load(CELL_A);
    expect(reloaded!.state.status).toBe('FUNDED');
  });

  test('20. different cells remain isolated', async () => {
    const store = new InMemorySnapshotStore();
    const snapA = makeSnapshot(CELL_A, V1);
    const snapB = makeSnapshot(CELL_B, V2);
    await store.save(CELL_A, snapA);
    await store.save(CELL_B, snapB);

    const loadedA = await store.load(CELL_A);
    const loadedB = await store.load(CELL_B);

    expect(loadedA!.cellId).toBe(CELL_A);
    expect(loadedA!.version).toBe(V1);
    expect(loadedB!.cellId).toBe(CELL_B);
    expect(loadedB!.version).toBe(V2);
  });

  test('21. snapshot version is preserved verbatim', async () => {
    const store = new InMemorySnapshotStore();
    const snap = makeSnapshot(CELL_A, V3);
    await store.save(CELL_A, snap);
    const loaded = await store.load(CELL_A);
    expect(loaded!.version).toBe(V3);
  });

  test('22. store does not generate snapshot version — caller-supplied version used', async () => {
    const store = new InMemorySnapshotStore();
    const snap = makeSnapshot(CELL_A, V2);
    await store.save(CELL_A, snap);
    const loaded = await store.load(CELL_A);
    // Version must be exactly what we saved
    expect(loaded!.version).toBe(V2);
    expect(loaded!.version).not.toBe(ZERO_VERSION);
  });

});

// ---------------------------------------------------------------------------
// 23–26: PersistenceAdapter tests
// ---------------------------------------------------------------------------

describe('PersistenceAdapter — InMemoryPersistenceAdapter', () => {

  test('23. connect resolves without error', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    await expect(adapter.connect()).resolves.toBeUndefined();
  });

  test('24. disconnect resolves without error', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    await adapter.connect();
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });

  test('25. eventStore is accessible and functional', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    await adapter.connect();
    const event = makeEvent(CELL_A, V1);
    await adapter.eventStore.append(CELL_A, [event]);
    const events = await adapter.eventStore.getEvents(CELL_A);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventId).toBe(event.eventId);
  });

  test('26. snapshotStore is accessible and functional', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    await adapter.connect();
    const snap = makeSnapshot(CELL_A, V2);
    await adapter.snapshotStore.save(CELL_A, snap);
    const loaded = await adapter.snapshotStore.load(CELL_A);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(V2);
  });

});

// ---------------------------------------------------------------------------
// 27–30: Integration tests
// ---------------------------------------------------------------------------

describe('Integration — events + snapshots', () => {

  test('27. events and snapshot can coexist for the same cell', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    await adapter.connect();

    const e1 = makeEvent(CELL_A, V1, T1);
    const e2 = makeFundedEvent(CELL_A, V2, T2);
    await adapter.eventStore.append(CELL_A, [e1, e2]);

    const snap = makeSnapshot(CELL_A, V2);
    await adapter.snapshotStore.save(CELL_A, snap);

    const events = await adapter.eventStore.getEvents(CELL_A);
    const loaded = await adapter.snapshotStore.load(CELL_A);

    expect(events).toHaveLength(2);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(V2);
  });

  test('28. missing snapshot does not prevent event retrieval', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    await adapter.connect();

    await adapter.eventStore.append(CELL_A, [makeEvent(CELL_A, V1)]);

    const snap = await adapter.snapshotStore.load(CELL_A);
    expect(snap).toBeNull();

    // Events are still available regardless of snapshot absence
    const events = await adapter.eventStore.getEvents(CELL_A);
    expect(events).toHaveLength(1);
  });

  test('29. event history remains source of truth — snapshot can be stale', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    await adapter.connect();

    // Append two events
    const e1 = makeEvent(CELL_A, V1, T1);
    const e2 = makeFundedEvent(CELL_A, V2, T2);
    await adapter.eventStore.append(CELL_A, [e1, e2]);

    // Save a snapshot only covering V1 (stale — V2 not yet snapshotted)
    const staleSnap = makeSnapshot(CELL_A, V1);
    await adapter.snapshotStore.save(CELL_A, staleSnap);

    const snap = await adapter.snapshotStore.load(CELL_A);
    expect(snap!.version).toBe(V1);

    // Full event history still contains both events
    const allEvents = await adapter.eventStore.getEvents(CELL_A);
    expect(allEvents).toHaveLength(2);

    // Application can load events since snapshot version to catch up
    const newEvents = await adapter.eventStore.getEventsSince(CELL_A, V1);
    expect(newEvents).toHaveLength(1);
    expect(newEvents[0]!.version).toBe(V2);
  });

  test('30. snapshot replacement does not mutate event history', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    await adapter.connect();

    const e1 = makeEvent(CELL_A, V1, T1);
    const e2 = makeFundedEvent(CELL_A, V2, T2);
    await adapter.eventStore.append(CELL_A, [e1, e2]);

    // Save then overwrite a snapshot
    await adapter.snapshotStore.save(CELL_A, makeSnapshot(CELL_A, V1));
    await adapter.snapshotStore.save(CELL_A, makeSnapshot(CELL_A, V2));

    // Event history must be intact and unaffected
    const events = await adapter.eventStore.getEvents(CELL_A);
    expect(events).toHaveLength(2);
    expect(events[0]!.version).toBe(V1);
    expect(events[1]!.version).toBe(V2);
  });

});
