import { CellApplication } from '../application/cell-application';
import { fixedClock } from '../application/clock';
import { createEventIdFactory } from '../application/event-id-factory';
import { InMemoryPersistenceAdapter } from '../adapters/in-memory-persistence-adapter';
import { cellKernel } from '../kernel';
import {
  makeActorId, makeAmount, makeCellId, makeCommandId, makeTimestamp,
} from '../core/types';
import type { ActorId, Command } from '../core/types';
import {
  TrustedCommandIngress,
  failClosedAuthentication,
  emptyPrincipalAuthority,
  rejectAllFundingEvidence,
} from './trusted-ingress';
import type { PrincipalRecord, VerifiedFundingContext } from './trusted-ingress';
import { actorIdentity, createTestIngress } from './testing';

const PAYER = makeActorId('payer-security');
const PAYEE = makeActorId('payee-security');
const OTHER = makeActorId('other-security');
const AMOUNT = makeAmount(10000n);
const CELL = makeCellId('cell-security');

function createCommand(id = 'create-security', payer: ActorId = PAYER): Command {
  return {
    commandId: makeCommandId(id), cellId: CELL, type: 'CreateCell',
    payload: {
      payer, payee: PAYEE, amount: AMOUNT, currency: 'TRY',
      fundingDeadline: makeTimestamp(2_000_000), completionDeadline: makeTimestamp(5_000_000),
    },
  };
}

function fundCommand(id = 'fund-security'): Command {
  return { commandId: makeCommandId(id), cellId: CELL, type: 'FundCell', payload: { funderId: PAYER, amount: AMOUNT } };
}

function application(persistence = new InMemoryPersistenceAdapter()): CellApplication {
  return new CellApplication({
    persistence, kernel: cellKernel, clock: fixedClock(makeTimestamp(1_000_000)),
    eventIds: createEventIdFactory('security'),
  });
}

const gateway: PrincipalRecord = {
  principalId: 'gateway-security', type: 'GATEWAY', enabled: true,
  capabilities: ['CONFIRM_FUNDING'], mappingVersion: 1,
};

function funding(overrides: Partial<VerifiedFundingContext> = {}): VerifiedFundingContext {
  return {
    providerTransactionId: 'provider-tx-1', gatewayPrincipalId: gateway.principalId,
    cellId: CELL, payer: PAYER, amount: AMOUNT, currency: 'TRY', ...overrides,
  };
}

describe('Phase 7B trusted principal boundary', () => {
  test('fake authenticated boolean and payload ActorId are not trusted', async () => {
    const app = application();
    const result = await app.handleCommand({
      command: createCommand(),
      principal: { authenticated: true, actorId: PAYER } as never,
    });
    expect(result.outcome).toBe('APPLICATION_REJECTION');
    if (result.outcome === 'APPLICATION_REJECTION') expect(result.error.code).toBe('UNAUTHENTICATED');
  });

  test('invalid authentication fails closed before mapping or Kernel', async () => {
    const persistence = new InMemoryPersistenceAdapter();
    const ingress = new TrustedCommandIngress(application(persistence), failClosedAuthentication, emptyPrincipalAuthority, rejectAllFundingEvidence);
    const result = await ingress.handle({ credential: { authenticated: true }, command: createCommand() });
    expect(result.outcome).toBe('APPLICATION_REJECTION');
    if (result.outcome === 'APPLICATION_REJECTION') expect(result.error.code).toBe('UNAUTHENTICATED');
    expect(await persistence.eventStore.getEvents(CELL)).toHaveLength(0);
  });

  test('verified subject maps to actor and actor can act as self', async () => {
    const identity = actorIdentity(PAYER);
    const result = await createTestIngress(application(), [identity]).handle({ credential: identity.credential, command: createCommand() });
    expect(result.outcome).toBe('SUCCESS');
  });

  test('actor cannot impersonate another actor', async () => {
    const identity = actorIdentity(OTHER);
    const result = await createTestIngress(application(), [identity]).handle({ credential: identity.credential, command: createCommand() });
    expect(result.outcome).toBe('APPLICATION_REJECTION');
    if (result.outcome === 'APPLICATION_REJECTION') expect(result.error.code).toBe('ACTOR_MISMATCH');
  });

  test('gateway and system cannot send general actor commands', async () => {
    const system: PrincipalRecord = { principalId: 'system-1', type: 'SYSTEM', enabled: true, capabilities: [], mappingVersion: 1 };
    for (const principal of [gateway, system]) {
      const identity = { credential: `credential-${principal.principalId}`, subject: `subject-${principal.principalId}`, principal };
      const result = await createTestIngress(application(), [identity]).handle({ credential: identity.credential, command: createCommand() });
      expect(result.outcome).toBe('APPLICATION_REJECTION');
      if (result.outcome === 'APPLICATION_REJECTION') expect(result.error.code).toBe('COMMAND_NOT_PERMITTED');
    }
  });

  test('actor cannot FundCell and gateway requires CONFIRM_FUNDING capability', async () => {
    const actor = actorIdentity(PAYER);
    const actorResult = await createTestIngress(application(), [actor]).handle({ credential: actor.credential, command: fundCommand() });
    expect(actorResult.outcome).toBe('APPLICATION_REJECTION');
    const noCapability = { ...gateway, principalId: 'gateway-no-cap', capabilities: [] };
    const identity = { credential: 'no-cap', subject: 'no-cap-subject', principal: noCapability };
    const gatewayResult = await createTestIngress(application(), [identity]).handle({ credential: identity.credential, command: fundCommand(), fundingEvidence: funding() });
    expect(gatewayResult.outcome).toBe('APPLICATION_REJECTION');
  });

  test('gateway FundCell requires verified evidence matching gateway, cell, payer, amount and currency', async () => {
    const persistence = new InMemoryPersistenceAdapter();
    const app = application(persistence);
    const actor = actorIdentity(PAYER);
    await createTestIngress(app, [actor]).handle({ credential: actor.credential, command: createCommand() });
    const gatewayIdentity = { credential: 'gateway-credential', subject: 'gateway-subject', principal: gateway };
    let current: VerifiedFundingContext | null = null;
    const ingress = createTestIngress(app, [gatewayIdentity], { async verify() { return current; } });
    const base = { credential: gatewayIdentity.credential, command: fundCommand(), fundingEvidence: 'opaque-evidence' };
    expect((await ingress.handle(base)).outcome).toBe('APPLICATION_REJECTION');
    for (const invalid of [
      funding({ gatewayPrincipalId: 'other-gateway' }), funding({ cellId: makeCellId('other-cell') }),
      funding({ payer: OTHER }), funding({ amount: makeAmount(9999n) }), funding({ currency: 'EUR' as never }),
    ]) {
      current = invalid;
      const result = await ingress.handle(base);
      expect(result.outcome).toBe('APPLICATION_REJECTION');
    }
    current = funding();
    expect((await ingress.handle(base)).outcome).toBe('SUCCESS');
  });

  test('disabled principal cannot execute or receive an old replay', async () => {
    const persistence = new InMemoryPersistenceAdapter();
    const app = application(persistence);
    let record = actorIdentity(PAYER).principal;
    const ingress = new TrustedCommandIngress(
      app,
      { async authenticate() { return { ok: true, identity: { issuer: 'test', subject: 'stable-subject' } }; } },
      { async resolve() { return record; } }, rejectAllFundingEvidence,
    );
    const request = { credential: 'credential', command: createCommand('disabled-command') };
    expect((await ingress.handle(request)).outcome).toBe('SUCCESS');
    record = { ...record, enabled: false };
    const denied = await ingress.handle(request);
    expect(denied.outcome).toBe('APPLICATION_REJECTION');
    if (denied.outcome === 'APPLICATION_REJECTION') expect(denied.error.code).toBe('PRINCIPAL_DISABLED');
    expect(await persistence.eventStore.getEvents(CELL)).toHaveLength(1);
  });

  test('credential rotation preserves replay for the same stable principal', async () => {
    const persistence = new InMemoryPersistenceAdapter();
    const app = application(persistence);
    const identity = actorIdentity(PAYER);
    const ingress = new TrustedCommandIngress(
      app,
      { async authenticate(credential) { return credential === 'old' || credential === 'new' ? { ok: true, identity: { issuer: 'test-issuer', subject: identity.subject } } : { ok: false }; } },
      { async resolve() { return identity.principal; } }, rejectAllFundingEvidence,
    );
    const command = createCommand('rotation-command');
    const first = await ingress.handle({ credential: 'old', command });
    const replay = await ingress.handle({ credential: 'new', command });
    expect(replay).toEqual(first);
    expect(await persistence.eventStore.getEvents(CELL)).toHaveLength(1);
  });

  test('mapping change does not reinterpret or re-execute a past command', async () => {
    const persistence = new InMemoryPersistenceAdapter();
    const app = application(persistence);
    let record = actorIdentity(PAYER).principal;
    const ingress = new TrustedCommandIngress(
      app,
      { async authenticate() { return { ok: true, identity: { issuer: 'test', subject: 'mapped-subject' } }; } },
      { async resolve() { return record; } }, rejectAllFundingEvidence,
    );
    const command = createCommand('mapping-change');
    expect((await ingress.handle({ credential: 'first', command })).outcome).toBe('SUCCESS');
    record = { ...record, actorId: OTHER, mappingVersion: 2 };
    const denied = await ingress.handle({ credential: 'rotated', command });
    expect(denied.outcome).toBe('APPLICATION_REJECTION');
    if (denied.outcome === 'APPLICATION_REJECTION') expect(denied.error.code).toBe('ACTOR_MISMATCH');
    expect(await persistence.eventStore.getEvents(CELL)).toHaveLength(1);
  });

  test('different principal cannot reuse commandId or learn original result', async () => {
    const app = application();
    const first = actorIdentity(PAYER, 'first');
    const second = actorIdentity(PAYER, 'second');
    const ingress = createTestIngress(app, [first, second]);
    const command = createCommand('cross-principal');
    expect((await ingress.handle({ credential: first.credential, command })).outcome).toBe('SUCCESS');
    const denied = await ingress.handle({ credential: second.credential, command });
    expect(denied.outcome).toBe('APPLICATION_REJECTION');
    if (denied.outcome === 'APPLICATION_REJECTION') expect(denied.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('mapping version and credential secrets are not persisted in events', async () => {
    const persistence = new InMemoryPersistenceAdapter();
    const identity = actorIdentity(PAYER);
    const secret = 'super-secret-token-value';
    const result = await createTestIngress(application(persistence), [{ ...identity, credential: secret }]).handle({ credential: secret, command: createCommand('secret-test') });
    expect(result.outcome).toBe('SUCCESS');
    const encoded = JSON.stringify(await persistence.eventStore.getEvents(CELL), (_key, value) => typeof value === 'bigint' ? value.toString() : value);
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain(identity.subject);
  });
});

describe('Phase 7G principal abuse boundary', () => {
  test('token rotation uses stable principalId and storage denial precedes application', async () => {
    const stable = actorIdentity(PAYER, 'rotating-a');
    const rotated = { ...actorIdentity(PAYER, 'rotating-b'), principal: stable.principal };
    const keys: string[] = [];
    const decisions = [true, false];
    const limiter = { async consume(key: string) {
      keys.push(key); return { allowed: decisions.shift() ?? false, retryAfterSeconds: 4 };
    } };
    const ingress = createTestIngress(application(), [stable, rotated], undefined, limiter);
    expect((await ingress.handle({ credential: stable.credential, command: createCommand('rotation-first') })).outcome).toBe('SUCCESS');
    const rejected = await ingress.handle({ credential: rotated.credential, command: createCommand('rotation-second') });
    expect(rejected).toMatchObject({ outcome: 'APPLICATION_REJECTION', error: { code: 'RATE_LIMITED', retryAfterSeconds: 4 } });
    expect(keys).toEqual([stable.principal.principalId, stable.principal.principalId]);
  });

  test('disabled principal is rejected without using principal limiter as a bypass', async () => {
    const disabled = { ...actorIdentity(PAYER, 'disabled-limited'), principal: {
      ...actorIdentity(PAYER, 'disabled-limited').principal, enabled: false,
    } };
    let calls = 0;
    const ingress = createTestIngress(application(), [disabled], undefined, {
      async consume() { calls += 1; return { allowed: true, retryAfterSeconds: 0 }; },
    });
    expect(await ingress.handle({ credential: disabled.credential, command: createCommand('disabled-limited') }))
      .toMatchObject({ outcome: 'APPLICATION_REJECTION', error: { code: 'PRINCIPAL_DISABLED' } });
    expect(calls).toBe(0);
  });
});
