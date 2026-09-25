import { CellApplication } from './cell-application';
import { fixedClock } from './clock';
import { createEventIdFactory } from './event-id-factory';
import { InMemoryPersistenceAdapter } from '../adapters/in-memory-persistence-adapter';
import { makeActorId, makeAmount, makeCellId, makeCommandId, makeTimestamp } from '../core/types';
import { cellKernel } from '../kernel';
import { createTestIngress, actorIdentity } from '../security/testing';
import type { TestIdentity } from '../security/testing';

const ACTOR_A = makeActorId('cell-query-a');
const ACTOR_B = makeActorId('cell-query-b');
const ACTOR_C = makeActorId('cell-query-c');
const CELL = makeCellId('cell-query-owned');
const AMOUNT = makeAmount(4200n);
const gateway: TestIdentity = { credential: 'gateway-query-credential', subject: 'gateway-query', principal: {
  principalId: 'gateway-query', type: 'GATEWAY', enabled: true, capabilities: ['CONFIRM_FUNDING'], mappingVersion: 1,
} };

function harness() {
  const persistence = new InMemoryPersistenceAdapter();
  const application = new CellApplication({ persistence, kernel: cellKernel,
    clock: fixedClock(makeTimestamp(1_000_000)), eventIds: createEventIdFactory('cell-query') });
  const ingress = createTestIngress(application, [actorIdentity(ACTOR_A), actorIdentity(ACTOR_B), actorIdentity(ACTOR_C), gateway]);
  return { application, ingress, persistence };
}

async function createCell(h: ReturnType<typeof harness>, description = 'Logo tasarımı teslim edilecek.',
  commandId = 'cell-query-create') {
  return h.ingress.handle({ credential: 'test-credential-cell-query-a', command: {
    commandId: makeCommandId(commandId), cellId: CELL, type: 'CreateCell', payload: {
      payer: ACTOR_A, payee: ACTOR_B, description, amount: AMOUNT, currency: 'TRY',
      fundingDeadline: makeTimestamp(2_000_000), completionDeadline: makeTimestamp(5_000_000),
    },
  } });
}

describe('authenticated actor cell queries', () => {
  test('authenticated actor lists own cell with a kernel-derived summary and version', async () => {
    const h = harness();
    expect((await createCell(h)).outcome).toBe('SUCCESS');
    const result = await h.ingress.listActorCells('test-credential-cell-query-a');
    expect(result).toMatchObject({ outcome: 'SUCCESS', cells: [{
      cellId: CELL, counterpartyId: ACTOR_B, description: 'Logo tasarımı teslim edilecek.',
      amount: AMOUNT, currency: 'TRY', status: 'CREATED', acceptanceStatus: 'PENDING',
      fundingDeadline: 2_000_000, completionDeadline: 5_000_000, version: 1,
    }] });
  });

  test('authenticated actor reads own cell state and event-stream version', async () => {
    const h = harness();
    await createCell(h);
    expect(await h.ingress.getActorCellState('test-credential-cell-query-a', String(CELL)))
      .toMatchObject({ outcome: 'SUCCESS', cell: { state: { cellId: CELL, payer: ACTOR_A, payee: ACTOR_B,
        description: 'Logo tasarımı teslim edilecek.', status: 'CREATED', acceptanceStatus: 'PENDING', amount: AMOUNT }, version: 1 } });
  });

  test('another actor cannot list or read the first actor cell', async () => {
    const h = harness();
    await createCell(h);
    expect(await h.ingress.listActorCells('test-credential-cell-query-c')).toEqual({ outcome: 'SUCCESS', cells: [] });
    const other = await h.ingress.getActorCellState('test-credential-cell-query-c', String(CELL));
    expect(other).toEqual({ outcome: 'NOT_FOUND' });
  });

  test('anonymous callers are rejected for both query APIs', async () => {
    const h = harness();
    expect(await h.ingress.listActorCells('unknown-credential')).toEqual({ outcome: 'UNAUTHENTICATED' });
    expect(await h.ingress.getActorCellState('unknown-credential', String(CELL)))
      .toEqual({ outcome: 'UNAUTHENTICATED' });
  });

  test('gateway credentials cannot use actor cell query APIs', async () => {
    const h = harness();
    expect(await h.ingress.listActorCells(gateway.credential)).toEqual({ outcome: 'FORBIDDEN' });
    expect(await h.ingress.getActorCellState(gateway.credential, String(CELL))).toEqual({ outcome: 'FORBIDDEN' });
  });

  test('CreateCell → list → state returns the same created state and version without store mutation', async () => {
    const h = harness();
    const created = await createCell(h);
    expect(created).toMatchObject({ outcome: 'SUCCESS', nextState: { status: 'CREATED' }, version: 1 });
    const listed = await h.ingress.listActorCells('test-credential-cell-query-a');
    const fetched = await h.ingress.getActorCellState('test-credential-cell-query-a', String(CELL));
    expect(listed).toMatchObject({ outcome: 'SUCCESS', cells: [{ status: 'CREATED', version: 1 }] });
    expect(fetched).toMatchObject({ outcome: 'SUCCESS', cell: { state: created.outcome === 'SUCCESS'
      ? created.nextState : undefined, version: 1 } });
    expect(await h.persistence.eventStore.getEvents(CELL)).toEqual(created.outcome === 'SUCCESS' ? created.events : []);
  });

  test('valid description survives command, persisted event, kernel state, list and state APIs', async () => {
    const h = harness();
    const description = 'Logo tasarımı teslim edilecek.';
    const created = await createCell(h, description);
    expect(created).toMatchObject({ outcome: 'SUCCESS', events: [{ type: 'CellCreated', payload: { description } }],
      nextState: { description } });
    expect(await h.ingress.listActorCells('test-credential-cell-query-a'))
      .toMatchObject({ outcome: 'SUCCESS', cells: [{ description }] });
    expect(await h.ingress.getActorCellState('test-credential-cell-query-a', String(CELL)))
      .toMatchObject({ outcome: 'SUCCESS', cell: { state: { description } } });
    expect(await h.persistence.eventStore.getEvents(CELL)).toMatchObject([{ payload: { description } }]);
  });

  test.each([
    ['empty', ''], ['whitespace only', '  \n  '], ['too long', 'x'.repeat(257)], ['control character', 'brief\u0000text'],
  ])('rejects %s descriptions before persisting an event', async (_label, description) => {
    const h = harness();
    const result = await createCell(h, description);
    expect(result).toMatchObject({ outcome: 'APPLICATION_REJECTION', error: { code: 'INVALID_INPUT' } });
    expect(await h.persistence.eventStore.getEvents(CELL)).toEqual([]);
  });

  test('CreateCell idempotency replays equal descriptions and conflicts on changed descriptions', async () => {
    const h = harness();
    const first = await createCell(h, 'Logo tasarımı teslim edilecek.', 'same-description-command');
    const replay = await createCell(h, 'Logo tasarımı teslim edilecek.', 'same-description-command');
    const conflict = await createCell(h, 'Farklı bir teslimat.', 'same-description-command');
    expect(first).toMatchObject({ outcome: 'SUCCESS', version: 1 });
    expect(replay).toMatchObject({ outcome: 'SUCCESS', version: 1, nextState: { description: 'Logo tasarımı teslim edilecek.' } });
    expect(conflict).toMatchObject({ outcome: 'APPLICATION_REJECTION', error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(await h.persistence.eventStore.getEvents(CELL)).toHaveLength(1);
  });

  test('malformed cell identifiers do not reach storage', async () => {
    const h = harness();
    expect(await h.ingress.getActorCellState('test-credential-cell-query-a', 'x'.repeat(129)))
      .toEqual({ outcome: 'NOT_FOUND' });
  });
});
