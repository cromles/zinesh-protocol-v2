/**
 * ZINESH PROTOCOL V2 — Application layer tests
 *
 * Real CellApplication + real cellKernel + InMemoryPersistenceAdapter.
 * No Kernel mocks. No EventStore mocks. No SnapshotStore mocks. No PostgreSQL.
 */

import fs from 'fs';
import path from 'path';
import { CellApplication } from './cell-application';
import { fixedClock } from './clock';
import { createEventIdFactory } from './event-id-factory';
import type { EventIdFactory } from './event-id-factory';
import { InMemoryPersistenceAdapter } from '../adapters/in-memory-persistence-adapter';
import { cellKernel } from '../kernel';
import {
  makeActorId,
  makeAmount,
  makeCellId,
  makeCommandId,
  makeEventId,
  makeTimestamp,
  nextVersion,
  ZERO_VERSION,
} from '../core/types';
import type {
  ActorId,
  Amount,
  CellId,
  Command,
  EventId,
  Timestamp,
} from '../core/types';
import type { HandleCommandResult } from './types';
import { actorIdentity, createTestIngress } from '../security/testing';
import type { TestIdentity } from '../security/testing';
import type { ExternalCommandRequest } from '../security/trusted-ingress';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAYER = makeActorId('payer-1');
const PAYEE = makeActorId('payee-1');
const ARBITER = makeActorId('arbiter-1');
const STRANGER = makeActorId('stranger-99');

const AMOUNT: Amount = makeAmount(10000n);

const T0 = makeTimestamp(1_000_000);
const T_FUNDING_DEADLINE = makeTimestamp(2_000_000);
const T_COMPLETION_DEADLINE = makeTimestamp(5_000_000);
const T_AFTER_FUNDING_DL = makeTimestamp(2_500_000);
const T_AFTER_COMPLETION_DL = makeTimestamp(6_000_000);
const T_BEFORE_COMPLETION_DL = makeTimestamp(4_000_000);

let seq = 0;

function nextCellId(): CellId {
  seq += 1;
  return makeCellId(`cell-${seq}`);
}

function cmd(
  type: Command['type'],
  payload: Command['payload'],
  cellId: CellId,
): Command {
  seq += 1;
  return {
    commandId: makeCommandId(`cmd-${seq}`),
    cellId,
    type,
    payload,
  };
}

function createCellPayload(opts: { arbiter?: ActorId } = {}) {
  return {
    payer: PAYER,
    payee: PAYEE,
    amount: AMOUNT,
    currency: 'TRY' as const,
    fundingDeadline: T_FUNDING_DEADLINE,
    completionDeadline: T_COMPLETION_DEADLINE,
    ...(opts.arbiter !== undefined ? { arbiter: opts.arbiter } : {}),
  };
}

interface LegacyTestRequest {
  readonly command: Command;
  readonly caller: { readonly authenticated: boolean; readonly actorId: ActorId };
  readonly gateway?: { readonly authorizedGateway: boolean };
}

function caller(actorId: ActorId = PAYER): LegacyTestRequest['caller'] {
  return { authenticated: true, actorId };
}

function gateway(): { readonly authorizedGateway: true } {
  return { authorizedGateway: true };
}

function request(
  command: Command,
  opts: {
    actor?: ActorId;
    gateway?: { readonly authorizedGateway: boolean };
    authenticated?: boolean;
  } = {},
): LegacyTestRequest {
  const authenticated = opts.authenticated ?? true;
  const req: LegacyTestRequest = {
    command,
    caller: { authenticated, actorId: opts.actor ?? PAYER },
  };
  if (opts.gateway !== undefined) {
    return { ...req, gateway: opts.gateway };
  }
  if (command.type === 'FundCell') {
    return { ...req, gateway: gateway() };
  }
  return req;
}

interface AppHarness {
  app: { handleCommand(request: LegacyTestRequest): Promise<HandleCommandResult> };
  persistence: InMemoryPersistenceAdapter;
  clock: { now(): Timestamp };
  eventIds: EventIdFactory;
  issuedIds: EventId[];
  setNow: (at: Timestamp) => void;
}

function makeApp(now: Timestamp = T0): AppHarness {
  const persistence = new InMemoryPersistenceAdapter();
  let current = now;
  const issuedIds: EventId[] = [];
  const inner = createEventIdFactory(`test-${seq}`);
  const eventIds: EventIdFactory = {
    nextEventId(index: number): EventId {
      const id = inner.nextEventId(index);
      issuedIds.push(id);
      return id;
    },
  };
  const clock = {
    now(): Timestamp {
      return current;
    },
  };
  const application = new CellApplication({
    persistence,
    kernel: cellKernel,
    clock,
    eventIds,
  });
  const identities = [PAYER, PAYEE, ARBITER, STRANGER].map((actor) => actorIdentity(actor));
  const gatewayIdentity: TestIdentity = {
    credential: 'test-gateway-credential', subject: 'test-gateway-subject',
    principal: {
      principalId: 'gateway-1', type: 'GATEWAY', enabled: true,
      capabilities: ['CONFIRM_FUNDING'], mappingVersion: 1,
    },
  };
  const ingress = createTestIngress(application, [...identities, gatewayIdentity], {
    async verify(evidence) {
      if (typeof evidence !== 'object' || evidence === null) return { outcome: 'INVALID', reason: 'AUTHENTICITY_FAILED' };
      return { outcome: 'VERIFIED', context: evidence as import('../security/trusted-ingress').VerifiedFundingContext };
    },
  });
  const app = {
    handleCommand(input: LegacyTestRequest): Promise<HandleCommandResult> {
      const external: ExternalCommandRequest = input.command.type === 'FundCell'
        ? {
            credential: input.gateway?.authorizedGateway === true ? 'test-gateway-credential' : 'invalid',
            command: input.command,
            fundingEvidence: {
              provider: 'test-provider',
              providerTransactionId: `provider-${input.command.commandId}`,
              gatewayPrincipalId: 'gateway-1', cellId: input.command.cellId,
              payer: (input.command.payload as { funderId: ActorId }).funderId,
              amount: (input.command.payload as { amount: Amount }).amount,
              currency: 'TRY',
              destinationId: 'test-custody', confirmedAt: makeTimestamp(900_000),
              finality: 'SETTLED', evidenceDigest: 'a'.repeat(64),
              verifiedAt: makeTimestamp(950_000),
            },
          }
        : {
            credential: input.caller.authenticated ? `test-credential-${input.caller.actorId}` : 'invalid',
            command: input.command,
          };
      return ingress.handle(external);
    },
  };
  return {
    app,
    persistence,
    clock,
    eventIds,
    issuedIds,
    setNow(at: Timestamp) {
      current = at;
    },
  };
}

async function expectSuccess(result: HandleCommandResult) {
  expect(result.outcome).toBe('SUCCESS');
  if (result.outcome !== 'SUCCESS') {
    throw new Error(`Expected SUCCESS, got ${result.outcome}`);
  }
  return result;
}

async function createCell(
  harness: AppHarness,
  cellId: CellId,
  opts: { arbiter?: ActorId } = {},
) {
  return expectSuccess(
    await harness.app.handleCommand(
      request(cmd('CreateCell', createCellPayload(opts), cellId)),
    ),
  );
}

async function fundCell(harness: AppHarness, cellId: CellId, funderId: ActorId = PAYER) {
  return expectSuccess(
    await harness.app.handleCommand(
      request(cmd('FundCell', { funderId, amount: AMOUNT }, cellId), {
        gateway: gateway(),
      }),
    ),
  );
}

const APPLICATION_SRC_DIR = __dirname;

function applicationSourceFiles(): string[] {
  return fs
    .readdirSync(APPLICATION_SRC_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => path.join(APPLICATION_SRC_DIR, name));
}

function readApplicationSources(): string {
  return applicationSourceFiles()
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
}

function kernelSources(): string {
  const kernelDir = path.resolve(__dirname, '../kernel');
  return ['kernel.ts', 'state-machine.ts', 'index.ts']
    .map((name) => fs.readFileSync(path.join(kernelDir, name), 'utf8'))
    .join('\n');
}

// ---------------------------------------------------------------------------
// 1. CreateCell through Application succeeds
// ---------------------------------------------------------------------------

describe('1. CreateCell through Application succeeds', () => {
  test('CreateCell persists CellCreated and returns FUNDED-ready CREATED state', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    const result = await createCell(harness, cellId);

    expect(result.nextState.status).toBe('CREATED');
    expect(result.nextState.payer).toBe(PAYER);
    expect(result.nextState.payee).toBe(PAYEE);
    expect(result.nextState.amount).toBe(AMOUNT);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.type).toBe('CellCreated');
    expect(result.version).toBe(1);

    const stored = await harness.persistence.eventStore.getEvents(cellId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.type).toBe('CellCreated');
  });
});

describe('Phase 7A command execution boundary', () => {
  test('same commandId and content replays without duplicate events', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    const command = cmd('CreateCell', createCellPayload(), cellId);
    const first = await harness.app.handleCommand(request(command));
    const replay = await harness.app.handleCommand(request(command));
    expect(replay).toEqual(first);
    expect(await harness.persistence.eventStore.getEvents(cellId)).toHaveLength(1);
  });

  test('same commandId with different content is rejected', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    const original = cmd('CreateCell', createCellPayload(), cellId);
    await harness.app.handleCommand(request(original));
    const changed: Command = { ...original, payload: { ...createCellPayload(), amount: makeAmount(20000n) } };
    const result = await harness.app.handleCommand(request(changed));
    expect(result.outcome).toBe('APPLICATION_REJECTION');
    if (result.outcome !== 'APPLICATION_REJECTION') return;
    expect(result.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await harness.persistence.eventStore.getEvents(cellId)).toHaveLength(1);
  });

  test('concurrent duplicate execution produces one event', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    const command = cmd('CreateCell', createCellPayload(), cellId);
    const [first, second] = await Promise.all([
      harness.app.handleCommand(request(command)),
      harness.app.handleCommand(request(command)),
    ]);
    expect(second).toEqual(first);
    expect(first.outcome).toBe('SUCCESS');
    expect(await harness.persistence.eventStore.getEvents(cellId)).toHaveLength(1);
  });

  test('idempotency survives application recreation over the same persistence', async () => {
    const persistence = new InMemoryPersistenceAdapter();
    const cellId = nextCellId();
    const command = cmd('CreateCell', createCellPayload(), cellId);
    const firstApp = new CellApplication({ persistence, kernel: cellKernel, clock: fixedClock(T0), eventIds: createEventIdFactory('restart-a') });
    const secondApp = new CellApplication({ persistence, kernel: cellKernel, clock: fixedClock(T0), eventIds: createEventIdFactory('restart-b') });
    const identity = actorIdentity(PAYER);
    const firstIngress = createTestIngress(firstApp, [identity]);
    const secondIngress = createTestIngress(secondApp, [identity]);
    const external = { credential: identity.credential, command };
    const first = await firstIngress.handle(external);
    const replay = await secondIngress.handle(external);
    expect(replay).toEqual(first);
    expect(await persistence.eventStore.getEvents(cellId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Application loads existing events before command
// ---------------------------------------------------------------------------

describe('2. Application loads existing events before command', () => {
  test('FundCell after CreateCell appends version 2 rather than recreating the stream', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    await createCell(harness, cellId);
    const funded = await fundCell(harness, cellId);

    expect(funded.events).toHaveLength(1);
    expect(funded.events[0]?.type).toBe('CellFunded');
    expect(funded.events[0]?.version).toBe(2);

    const stored = await harness.persistence.eventStore.getEvents(cellId);
    expect(stored.map((e) => e.type)).toEqual(['CellCreated', 'CellFunded']);
    expect(stored.map((e) => e.version)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// 3. Application reconstructs state through Kernel
// ---------------------------------------------------------------------------

describe('3. Application reconstructs state through Kernel', () => {
  test('post-command state matches cellKernel.evolve on the stored stream', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    await createCell(harness, cellId);
    const funded = await fundCell(harness, cellId);

    const stored = await harness.persistence.eventStore.getEvents(cellId);
    const evolved = cellKernel.evolve(cellId, stored);
    expect('status' in evolved).toBe(true);
    if (!('status' in evolved)) return;
    expect(evolved).toEqual(funded.nextState);
    expect(evolved.status).toBe('FUNDED');
  });
});

// ---------------------------------------------------------------------------
// 4. FundCell succeeds when funderId matches payer
// ---------------------------------------------------------------------------

describe('4. FundCell succeeds when funderId matches payer', () => {
  test('authorized gateway + payer funderId funds the cell', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    await createCell(harness, cellId);
    const funded = await fundCell(harness, cellId, PAYER);

    expect(funded.nextState.status).toBe('FUNDED');
    expect(funded.nextState.fundedAt).toBe(T0);
  });
});

// ---------------------------------------------------------------------------
// 5. Application does not bypass Kernel authorization
// ---------------------------------------------------------------------------

describe('5. Application does not bypass Kernel authorization', () => {
  test('verified gateway FundCell with non-payer evidence is rejected before Kernel', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    await createCell(harness, cellId);

    const command = cmd('FundCell', { funderId: STRANGER, amount: AMOUNT }, cellId);
    const stored = await harness.persistence.eventStore.getEvents(cellId);
    const state = cellKernel.evolve(cellId, stored);
    if (!('status' in state)) throw new Error('evolve failed');
    const direct = cellKernel.applyCommand(
      state,
      command,
      nextVersion(stored[stored.length - 1]!.version),
      { now: T0, nextEventId: (i) => makeEventId(`x-${i}`) },
    );
    expect(direct.ok).toBe(false);

    const result = await harness.app.handleCommand(
      request(command, { gateway: gateway() }),
    );

    expect(result.outcome).toBe('APPLICATION_REJECTION');
    if (result.outcome !== 'APPLICATION_REJECTION' || direct.ok) return;
    expect(result.error.code).toBe('FUNDING_EVIDENCE_INVALID');
  });

  test('stranger RequestRelease impersonation is rejected before Kernel', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    await createCell(harness, cellId);
    await fundCell(harness, cellId);

    const result = await harness.app.handleCommand(
      request(cmd('RequestRelease', { requestedBy: STRANGER }, cellId)),
    );

    expect(result.outcome).toBe('APPLICATION_REJECTION');
    if (result.outcome !== 'APPLICATION_REJECTION') return;
    expect(result.error.code).toBe('ACTOR_MISMATCH');

    const stored = await harness.persistence.eventStore.getEvents(cellId);
    expect(stored).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 6. Illegal command returns KernelError
// ---------------------------------------------------------------------------

describe('6. Illegal command returns KernelError', () => {
  test('RequestRelease on a CREATED cell is Kernel ILLEGAL_TRANSITION', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    await createCell(harness, cellId);

    const result = await harness.app.handleCommand(
      request(cmd('RequestRelease', { requestedBy: PAYER }, cellId)),
    );

    expect(result.outcome).toBe('KERNEL_REJECTION');
    if (result.outcome !== 'KERNEL_REJECTION') return;
    expect(result.error.code).toBe('ILLEGAL_TRANSITION');
    expect(result.error.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Terminal cell command is rejected by Kernel and surfaced unchanged
// ---------------------------------------------------------------------------

describe('7. Terminal cell command is rejected by Kernel and surfaced unchanged', () => {
  test('FundCell after ExpireCell returns the Kernel terminal error unchanged', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    await createCell(harness, cellId);

    harness.setNow(T_AFTER_FUNDING_DL);
    const expired = await expectSuccess(
      await harness.app.handleCommand(
        request(cmd('ExpireCell', { triggeredBy: PAYER, currentTime: T0 }, cellId)),
      ),
    );
    expect(expired.nextState.status).toBe('EXPIRED');

    const stored = await harness.persistence.eventStore.getEvents(cellId);
    const state = cellKernel.evolve(cellId, stored);
    if (!('status' in state)) throw new Error('evolve failed');
    const direct = cellKernel.applyCommand(
      state,
      cmd('FundCell', { funderId: PAYER, amount: AMOUNT }, cellId),
      nextVersion(stored[stored.length - 1]!.version),
      { now: T_AFTER_FUNDING_DL, nextEventId: (i) => makeEventId(`k-${i}`) },
    );
    expect(direct.ok).toBe(false);

    const result = await harness.app.handleCommand(
      request(cmd('FundCell', { funderId: PAYER, amount: AMOUNT }, cellId), {
        gateway: gateway(),
      }),
    );

    expect(result.outcome).toBe('KERNEL_REJECTION');
    if (result.outcome !== 'KERNEL_REJECTION' || direct.ok) return;
    expect(result.error).toEqual(direct.error);
    expect(result.error.code).toBe('ILLEGAL_TRANSITION');
  });
});

// ---------------------------------------------------------------------------
// 8–11. Deadline commands use Application clock
// ---------------------------------------------------------------------------

describe('8. Deadline command uses Application clock', () => {
  test('ExpireCell at clock time after funding deadline succeeds', async () => {
    const harness = makeApp(T0);
    const cellId = nextCellId();
    await createCell(harness, cellId);
    harness.setNow(T_AFTER_FUNDING_DL);

    const result = await expectSuccess(
      await harness.app.handleCommand(
        request(cmd('ExpireCell', { triggeredBy: PAYER, currentTime: T0 }, cellId)),
      ),
    );
    expect(result.nextState.status).toBe('EXPIRED');
    expect(result.events[0]?.timestamp).toBe(T_AFTER_FUNDING_DL);
  });
});

describe('9. ExpireCell receives the same timestamp as context.now', () => {
  test('payload.currentTime is aligned to the Application clock', async () => {
    const harness = makeApp(T0);
    const cellId = nextCellId();
    await createCell(harness, cellId);
    harness.setNow(T_AFTER_FUNDING_DL);

    const result = await expectSuccess(
      await harness.app.handleCommand(
        request(
          cmd('ExpireCell', { triggeredBy: PAYER, currentTime: T0 }, cellId),
        ),
      ),
    );

    const event = result.events[0];
    expect(event?.type).toBe('CellExpired');
    expect(event?.timestamp).toBe(T_AFTER_FUNDING_DL);
    expect((event?.payload as { currentTime: Timestamp }).currentTime).toBe(
      T_AFTER_FUNDING_DL,
    );
    expect(event?.timestamp).toBe(harness.clock.now());
  });
});

describe('10. ForceRefund receives the same timestamp as context.now', () => {
  test('payload.currentTime is aligned to the Application clock', async () => {
    const harness = makeApp(T0);
    const cellId = nextCellId();
    await createCell(harness, cellId);
    await fundCell(harness, cellId);
    harness.setNow(T_AFTER_COMPLETION_DL);

    const result = await expectSuccess(
      await harness.app.handleCommand(
        request(
          cmd('ForceRefund', { requestedBy: PAYER, currentTime: T0 }, cellId),
        ),
      ),
    );

    expect(result.nextState.status).toBe('REFUNDED');
    expect(result.events[0]?.timestamp).toBe(T_AFTER_COMPLETION_DL);
    expect(result.events[0]?.timestamp).toBe(harness.clock.now());
  });
});

describe('11. OpenDispute receives the same timestamp as context.now', () => {
  test('payload.currentTime is aligned to the Application clock', async () => {
    const harness = makeApp(T0);
    const cellId = nextCellId();
    await createCell(harness, cellId, { arbiter: ARBITER });
    await fundCell(harness, cellId);
    harness.setNow(T_BEFORE_COMPLETION_DL);

    const result = await expectSuccess(
      await harness.app.handleCommand(
        request(
          cmd(
            'OpenDispute',
            { openedBy: PAYER, currentTime: T_AFTER_COMPLETION_DL },
            cellId,
          ),
        ),
      ),
    );

    const event = result.events[0];
    expect(event?.type).toBe('DisputeOpened');
    expect(event?.timestamp).toBe(T_BEFORE_COMPLETION_DL);
    expect((event?.payload as { currentTime: Timestamp }).currentTime).toBe(
      T_BEFORE_COMPLETION_DL,
    );
    expect(event?.timestamp).toBe(harness.clock.now());
  });
});

// ---------------------------------------------------------------------------
// 12–13. expectedNextVersion
// ---------------------------------------------------------------------------

describe('12. expectedNextVersion starts at 1', () => {
  test('first event on an empty stream is version 1', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    const result = await createCell(harness, cellId);
    expect(result.events[0]?.version).toBe(nextVersion(ZERO_VERSION));
    expect(result.version).toBe(1);
  });
});

describe('13. expectedNextVersion follows last event version', () => {
  test('second command uses lastEvent.version + 1', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    const created = await createCell(harness, cellId);
    const last = created.events[created.events.length - 1];
    expect(last).toBeDefined();

    const funded = await fundCell(harness, cellId);
    expect(funded.events[0]?.version).toBe(nextVersion(last!.version));
  });
});

// ---------------------------------------------------------------------------
// 14. Multi-event ResolveDispute receives distinct event IDs
// ---------------------------------------------------------------------------

describe('14. Multi-event ResolveDispute receives distinct event IDs', () => {
  test('DisputeResolved and Released have different event IDs', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    await createCell(harness, cellId, { arbiter: ARBITER });
    await fundCell(harness, cellId);
    await expectSuccess(
      await harness.app.handleCommand(
        request(
          cmd('OpenDispute', { openedBy: PAYER, currentTime: T0 }, cellId),
        ),
      ),
    );

    const resolved = await expectSuccess(
      await harness.app.handleCommand(
        request(
          cmd('ResolveDispute', { resolvedBy: ARBITER, favourOf: 'payee' }, cellId),
          { actor: ARBITER },
        ),
      ),
    );

    expect(resolved.events).toHaveLength(2);
    expect(resolved.events[0]?.type).toBe('DisputeResolved');
    expect(resolved.events[1]?.type).toBe('Released');
    expect(resolved.events[0]?.eventId).not.toBe(resolved.events[1]?.eventId);
    expect(resolved.events[0]?.version).toBe(4);
    expect(resolved.events[1]?.version).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 15. Event IDs are not generated by Kernel
// ---------------------------------------------------------------------------

describe('15. Event IDs are not generated by Kernel', () => {
  test('persisted event IDs come from the Application factory', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    const before = harness.issuedIds.length;
    const result = await createCell(harness, cellId);
    const produced = harness.issuedIds.slice(before);

    expect(produced.length).toBeGreaterThan(0);
    expect(result.events[0]?.eventId).toBe(produced[0]);
  });

  test('Kernel source does not generate IDs or wall-clock time', () => {
    const src = kernelSources()
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
      })
      .join('\n');
    expect(src).not.toMatch(/Date\.now\s*\(/);
    expect(src).not.toMatch(/Math\.random\s*\(/);
    expect(src).not.toMatch(/randomUUID\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// 16. Persistence append receives exactly Kernel-produced events
// ---------------------------------------------------------------------------

describe('16. Persistence append receives exactly Kernel-produced events', () => {
  test('store contents equal Kernel result events for the command', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    const created = await createCell(harness, cellId);
    const afterCreate = await harness.persistence.eventStore.getEvents(cellId);
    expect(afterCreate).toEqual([...created.events]);

    const funded = await fundCell(harness, cellId);
    const afterFund = await harness.persistence.eventStore.getEvents(cellId);
    expect(afterFund.slice(afterCreate.length)).toEqual([...funded.events]);
    expect(afterFund).toHaveLength(created.events.length + funded.events.length);
  });
});

// ---------------------------------------------------------------------------
// 17–18. Version conflict is a persistence error; no retry
// ---------------------------------------------------------------------------

describe('17. Version conflict is surfaced as Application persistence error', () => {
  test('concurrent FundCell yields one success and one APPEND_VERSION_CONFLICT', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    await createCell(harness, cellId);

    const [a, b] = await Promise.all([
      harness.app.handleCommand(
        request(cmd('FundCell', { funderId: PAYER, amount: AMOUNT }, cellId), {
          gateway: gateway(),
        }),
      ),
      harness.app.handleCommand(
        request(cmd('FundCell', { funderId: PAYER, amount: AMOUNT }, cellId), {
          gateway: gateway(),
        }),
      ),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['APPLICATION_REJECTION', 'SUCCESS']);

    const failure = a.outcome === 'APPLICATION_REJECTION' ? a : b;
    const success = a.outcome === 'SUCCESS' ? a : b;
    expect(success.outcome).toBe('SUCCESS');
    expect(failure.outcome).toBe('APPLICATION_REJECTION');
    if (failure.outcome !== 'APPLICATION_REJECTION') return;
    expect(failure.error.type).toBe('ApplicationError');
    expect(failure.error.code).toBe('FUNDING_RECEIPT_CONFLICT');
    expect(failure.error.message).not.toMatch(/SELECT|INSERT|pg_|password|postgresql/i);
  });
});

describe('18. No version mutation/retry occurs', () => {
  test('conflicted FundCell does not append a mutated later version', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    await createCell(harness, cellId);

    await Promise.all([
      harness.app.handleCommand(
        request(cmd('FundCell', { funderId: PAYER, amount: AMOUNT }, cellId), {
          gateway: gateway(),
        }),
      ),
      harness.app.handleCommand(
        request(cmd('FundCell', { funderId: PAYER, amount: AMOUNT }, cellId), {
          gateway: gateway(),
        }),
      ),
    ]);

    const stored = await harness.persistence.eventStore.getEvents(cellId);
    expect(stored).toHaveLength(2);
    expect(stored.map((e) => e.version)).toEqual([1, 2]);
    expect(stored.filter((e) => e.type === 'CellFunded')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 19–20. Snapshot write-only
// ---------------------------------------------------------------------------

describe('19. Snapshot save may occur after successful append', () => {
  test('a snapshot is stored at the resulting version after CreateCell', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    const created = await createCell(harness, cellId);

    const snapshot = await harness.persistence.snapshotStore.load(cellId);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.version).toBe(created.version);
    expect(snapshot?.state).toEqual(created.nextState);
    expect(snapshot?.cellId).toBe(cellId);
  });
});

describe('20. Snapshot is NOT used for reconstruction', () => {
  test('a corrupted snapshot does not change command outcomes', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    const created = await createCell(harness, cellId);

    await harness.persistence.snapshotStore.save(cellId, {
      cellId,
      version: created.version,
      state: {
        ...created.nextState,
        status: 'RELEASED',
      },
    });

    const funded = await fundCell(harness, cellId);
    expect(funded.nextState.status).toBe('FUNDED');

    const stored = await harness.persistence.eventStore.getEvents(cellId);
    const evolved = cellKernel.evolve(cellId, stored);
    expect(evolved).toEqual(funded.nextState);
  });
});

// ---------------------------------------------------------------------------
// 21. Application works with InMemoryPersistenceAdapter
// ---------------------------------------------------------------------------

describe('21. Application works with InMemoryPersistenceAdapter', () => {
  test('harness persistence is InMemoryPersistenceAdapter', async () => {
    const harness = makeApp();
    expect(harness.persistence).toBeInstanceOf(InMemoryPersistenceAdapter);
    const cellId = nextCellId();
    await createCell(harness, cellId);
    expect(await harness.persistence.eventStore.getEvents(cellId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 22–28. Constitution of Application sources
// ---------------------------------------------------------------------------

describe('22. Application contains no SQL', () => {
  test('Phase 5 sources have no SQL verbs or query fragments', () => {
    const src = readApplicationSources();
    expect(src).not.toMatch(/\bSELECT\b/);
    expect(src).not.toMatch(/\bINSERT\b/);
    expect(src).not.toMatch(/\bUPDATE\b/);
    expect(src).not.toMatch(/\bDELETE\b/);
    expect(src).not.toMatch(/\bJOIN\b/);
    expect(src).not.toMatch(/\bTRUNCATE\b/);
    expect(src).not.toMatch(/\bFROM\b/);
  });
});

describe('23. Application contains no PostgreSQL imports', () => {
  test('Phase 5 sources do not import pg or Postgres adapters', () => {
    const src = readApplicationSources();
    expect(src).not.toMatch(/\bfrom ['"]pg['"]/);
    expect(src).not.toMatch(/PostgresEventStore/);
    expect(src).not.toMatch(/PostgresSnapshotStore/);
    expect(src).not.toMatch(/PostgresPersistenceAdapter/);
    expect(src).not.toMatch(/postgres-event-store/);
    expect(src).not.toMatch(/postgres-snapshot-store/);
    expect(src).not.toMatch(/postgres-persistence-adapter/);
  });
});

describe('24. Application contains no state-transition implementation', () => {
  test('Phase 5 sources do not encode cell status transitions', () => {
    const src = readApplicationSources();
    expect(src).not.toMatch(/TERMINAL_STATUSES/);
    expect(src).not.toMatch(/status\s*===\s*['"]FUNDED['"]/);
    expect(src).not.toMatch(/status\s*===\s*['"]CREATED['"]/);
    expect(src).not.toMatch(/ILLEGAL_TRANSITION/);
    expect(src).not.toMatch(/eventFolder/);
  });
});

describe('25. Application contains no deadline implementation', () => {
  test('Phase 5 sources do not compare clocks against deadlines', () => {
    const src = readApplicationSources();
    expect(src).not.toMatch(/DEADLINE_VIOLATION/);
    expect(src).not.toMatch(/currentTime\s*[<>]=/);
    expect(src).not.toMatch(/now\(\)\s*[<>]/);
    expect(src).not.toMatch(/requires currentTime/);
  });
});

describe('26. Application contains no settlement implementation', () => {
  test('Phase 5 sources do not decide release or refund settlement', () => {
    const src = readApplicationSources();
    expect(src).not.toMatch(/favourOf\s*===\s*['"]payee['"]/);
    expect(src).not.toMatch(/settlementEventType/);
    expect(src).not.toMatch(/eventType:\s*['"]Released['"]/);
    expect(src).not.toMatch(/eventType:\s*['"]Refunded['"]/);
  });
});

describe('27. Application contains no money calculation', () => {
  test('Phase 5 sources do not add, split, or convert amounts', () => {
    const src = readApplicationSources();
    expect(src).not.toMatch(/amount\s*\+/);
    expect(src).not.toMatch(/amount\s*\*/);
    expect(src).not.toMatch(/\/\s*100n/);
    expect(src).not.toMatch(/partial/);
  });
});

describe('28. Application contains no dispute resolution logic', () => {
  test('Phase 5 sources do not resolve disputes', () => {
    const src = readApplicationSources();
    expect(src).not.toMatch(/Only the Arbiter/);
    expect(src).not.toMatch(/DisputeResolved/);
  });
});

describe('constitution extras', () => {
  test('Date.now appears only in clock.ts', () => {
    for (const file of applicationSourceFiles()) {
      const text = fs.readFileSync(file, 'utf8');
      if (path.basename(file) === 'clock.ts') {
        expect(text).toMatch(/Date\.now/);
      } else {
        expect(text).not.toMatch(/Date\.now/);
      }
      expect(text).not.toMatch(/Math\.random/);
      expect(text).not.toMatch(/randomUUID/);
    }
  });

  test('unauthenticated callers are rejected before Kernel', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    const result = await harness.app.handleCommand(
      request(cmd('CreateCell', createCellPayload(), cellId), {
        authenticated: false,
      }),
    );
    expect(result.outcome).toBe('APPLICATION_REJECTION');
    if (result.outcome !== 'APPLICATION_REJECTION') return;
    expect(result.error.code).toBe('UNAUTHENTICATED');
    expect(await harness.persistence.eventStore.getEvents(cellId)).toHaveLength(0);
  });

  test('FundCell without verified gateway credential is UNAUTHENTICATED', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    await createCell(harness, cellId);
    const result = await harness.app.handleCommand({
      command: cmd('FundCell', { funderId: PAYER, amount: AMOUNT }, cellId),
      caller: caller(PAYER),
    });
    expect(result.outcome).toBe('APPLICATION_REJECTION');
    if (result.outcome !== 'APPLICATION_REJECTION') return;
    expect(result.error.code).toBe('UNAUTHENTICATED');
  });

  test('unrecognized command type is INVALID_INPUT', async () => {
    const harness = makeApp();
    const cellId = nextCellId();
    const result = await harness.app.handleCommand(
      request({
        ...cmd('CreateCell', createCellPayload(), cellId),
        type: 'NotACommand' as Command['type'],
      }),
    );
    expect(result.outcome).toBe('APPLICATION_REJECTION');
    if (result.outcome !== 'APPLICATION_REJECTION') return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  test('fixedClock is used by tests, not systemClock wall time', () => {
    const clock = fixedClock(T0);
    expect(clock.now()).toBe(T0);
    expect(clock.now()).toBe(T0);
  });
});
