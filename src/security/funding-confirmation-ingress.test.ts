import { InMemoryPersistenceAdapter } from '../adapters/in-memory-persistence-adapter';
import { CellApplication } from '../application/cell-application';
import { fixedClock } from '../application/clock';
import { createEventIdFactory } from '../application/event-id-factory';
import { cellKernel } from '../kernel';
import { makeActorId, makeAmount, makeCellId, makeCommandId, makeTimestamp } from '../core/types';
import type { ExpectedFundingBinding, FundingDestinationBinding, FundingVerificationResult } from '../funding/types';
import type { FundingEvidencePort, PrincipalRecord } from './trusted-ingress';
import { actorIdentity, createTestIngress } from './testing';
import { createFundingIntent } from '../funding/funding-intent';

const PAYER = makeActorId('phase2-payer');
const PAYEE = makeActorId('phase2-payee');
const AMOUNT = makeAmount(4200n);
const gateway: PrincipalRecord = { principalId: 'phase2-gateway', type: 'GATEWAY', enabled: true,
  capabilities: ['CONFIRM_FUNDING'], mappingVersion: 1 };
const gatewayIdentity = { credential: 'phase2-gateway-token', subject: 'phase2-gateway-subject', principal: gateway };

function verified(expected: ExpectedFundingBinding, transaction = 'phase2-tx'): FundingVerificationResult {
  return { outcome: 'VERIFIED', context: {
    provider: 'test-provider', providerTransactionId: transaction,
    ...expected, confirmedAt: makeTimestamp(900_000), finality: 'FUNDS_HELD',
    evidenceDigest: 'a'.repeat(64), verifiedAt: makeTimestamp(950_000),
  } };
}

function intentIdFor(cellId: ReturnType<typeof makeCellId>): string {
  return `intent-${cellId}`;
}

async function setup(result?: FundingVerificationResult) {
  const persistence = new InMemoryPersistenceAdapter();
  const app = new CellApplication({ persistence, kernel: cellKernel,
    clock: fixedClock(makeTimestamp(1_000_000)), eventIds: createEventIdFactory('phase2') });
  let captured: ExpectedFundingBinding | undefined;
  let destinationBinding: FundingDestinationBinding | undefined;
  let verification: FundingVerificationResult | undefined = result;
  const port: FundingEvidencePort = { async verify(evidence, expected) {
    captured = expected; return verification ?? verified(expected, evidence.providerTransactionId);
  } };
  const actor = actorIdentity(PAYER, 'phase2-payer');
  const ingress = createTestIngress(app, [actor, gatewayIdentity], port, undefined, {
    async resolve(binding) { destinationBinding = binding; return 'test-custody'; },
  });
  async function create(cellName: string) {
    const cellId = makeCellId(cellName);
    await ingress.handle({ credential: actor.credential, command: { commandId: makeCommandId(`create-${cellName}`),
      cellId, type: 'CreateCell', payload: { payer: PAYER, payee: PAYEE, amount: AMOUNT, currency: 'TRY',
        fundingDeadline: makeTimestamp(2_000_000), completionDeadline: makeTimestamp(3_000_000) } } });
    await persistence.fundingIntentStore.create(createFundingIntent({
      intentId: intentIdFor(cellId), provider: 'test-provider', environment: 'SANDBOX', providerAccountScope: 'account-test', cellId, payer: PAYER, payee: PAYEE,
      amount: AMOUNT, currency: 'TRY', destinationId: 'test-custody',
      createdAt: makeTimestamp(800_000), expiresAt: makeTimestamp(2_000_000),
    }));
    return cellId;
  }
  return { persistence, ingress, create, captured: () => captured, destinationBinding: () => destinationBinding,
    setResult(value: FundingVerificationResult) { verification = value; } };
}

describe('Funding Phase 2 verification and ingress', () => {
  test('derives the complete expected binding from authoritative cell state and trusted destination config', async () => {
    const h = await setup(); const cellId = await h.create('phase2-binding');
    const result = await h.ingress.handleFundingConfirmation({ credential: gatewayIdentity.credential,
      commandId: makeCommandId('phase2-fund'), cellId,
      evidence: { intentId: intentIdFor(cellId), provider: 'test-provider', providerTransactionId: 'phase2-tx',
        opaqueEvidence: { amount: 'caller-value' } } });
    expect(result.outcome).toBe('SUCCESS');
    expect(h.captured()).toEqual({ intentId: intentIdFor(cellId), gatewayPrincipalId: gateway.principalId,
      environment: 'SANDBOX', providerAccountScope: 'account-test',
      cellId, payer: PAYER, payee: PAYEE,
      amount: AMOUNT, currency: 'TRY', destinationId: 'test-custody' });
    expect(h.destinationBinding()).toEqual({ provider: 'test-provider', cellId, payer: PAYER,
      payee: PAYEE, amount: AMOUNT, currency: 'TRY' });
    expect((await h.persistence.eventStore.getEvents(cellId)).map((event) => event.type))
      .toEqual(['CellCreated', 'CellFunded']);
  });

  test.each([
    ['unknown intent', async (h: Awaited<ReturnType<typeof setup>>, cellId: ReturnType<typeof makeCellId>) =>
      ({ intentId: 'missing-intent', provider: 'test-provider', providerTransactionId: 'unknown-intent-tx' })],
    ['provider mismatch', async (_h: Awaited<ReturnType<typeof setup>>, cellId: ReturnType<typeof makeCellId>) =>
      ({ intentId: intentIdFor(cellId), provider: 'other-provider', providerTransactionId: 'provider-mismatch-tx' })],
    ['payee mismatch', async (h: Awaited<ReturnType<typeof setup>>, cellId: ReturnType<typeof makeCellId>) => {
      await h.persistence.fundingIntentStore.create(createFundingIntent({
        intentId: 'wrong-payee-intent', provider: 'test-provider', environment: 'SANDBOX', providerAccountScope: 'account-test', cellId, payer: PAYER,
        payee: makeActorId('wrong-payee'), amount: AMOUNT, currency: 'TRY', destinationId: 'test-custody',
        createdAt: makeTimestamp(800_000), expiresAt: makeTimestamp(2_000_000),
      }));
      return { intentId: 'wrong-payee-intent', provider: 'test-provider', providerTransactionId: 'payee-mismatch-tx' };
    }],
    ['destination mismatch', async (h: Awaited<ReturnType<typeof setup>>, cellId: ReturnType<typeof makeCellId>) => {
      await h.persistence.fundingIntentStore.create(createFundingIntent({
        intentId: 'wrong-destination-intent', provider: 'test-provider', environment: 'SANDBOX', providerAccountScope: 'account-test', cellId, payer: PAYER, payee: PAYEE,
        amount: AMOUNT, currency: 'TRY', destinationId: 'wrong-custody',
        createdAt: makeTimestamp(800_000), expiresAt: makeTimestamp(2_000_000),
      }));
      return { intentId: 'wrong-destination-intent', provider: 'test-provider',
        providerTransactionId: 'destination-mismatch-tx' };
    }],
    ['invalid binding digest', async (h: Awaited<ReturnType<typeof setup>>, cellId: ReturnType<typeof makeCellId>) => {
      await expect(h.persistence.fundingIntentStore.create({
        intentId: 'forged-digest-intent', provider: 'test-provider', environment: 'SANDBOX', providerAccountScope: 'account-test', cellId, payer: PAYER, payee: PAYEE,
        amount: AMOUNT, currency: 'TRY', destinationId: 'test-custody', bindingDigest: 'f'.repeat(64),
        createdAt: makeTimestamp(800_000), expiresAt: makeTimestamp(2_000_000),
      })).resolves.toEqual({ kind: 'INVALID' });
      return { intentId: 'forged-digest-intent', provider: 'test-provider',
        providerTransactionId: 'forged-digest-tx' };
    }],
  ])('%s is rejected before provider verification', async (_name, evidenceFactory) => {
    const h = await setup(); const cellId = await h.create(`phase3a-${_name.replace(' ', '-')}`);
    const evidence = await evidenceFactory(h, cellId);
    const result = await h.ingress.handleFundingConfirmation({ credential: gatewayIdentity.credential,
      commandId: makeCommandId(`phase3a-${_name}`), cellId, evidence });
    expect(result).toMatchObject({ outcome: 'APPLICATION_REJECTION', error: { code: 'FUNDING_EVIDENCE_INVALID' } });
    expect(h.captured()).toBeUndefined();
  });

  test('confirmation timestamp must fall inside the immutable intent window', async () => {
    const h = await setup(); const cellId = await h.create('phase3a-expired');
    await h.persistence.fundingIntentStore.create(createFundingIntent({
      intentId: 'expired-intent', provider: 'test-provider', environment: 'SANDBOX', providerAccountScope: 'account-test', cellId, payer: PAYER, payee: PAYEE,
      amount: AMOUNT, currency: 'TRY', destinationId: 'test-custody',
      createdAt: makeTimestamp(800_000), expiresAt: makeTimestamp(850_000),
    }));
    const result = await h.ingress.handleFundingConfirmation({ credential: gatewayIdentity.credential,
      commandId: makeCommandId('phase3a-expired-fund'), cellId,
      evidence: { intentId: 'expired-intent', provider: 'test-provider', providerTransactionId: 'expired-tx' } });
    expect(result).toMatchObject({ outcome: 'APPLICATION_REJECTION', error: { code: 'FUNDING_EVIDENCE_INVALID' } });
    expect((await h.persistence.eventStore.getEvents(cellId)).map((event) => event.type)).toEqual(['CellCreated']);
  });

  test.each([
    ['INVALID', { outcome: 'INVALID', reason: 'BINDING_MISMATCH' } as FundingVerificationResult, 'FUNDING_EVIDENCE_INVALID'],
    ['NOT_FINAL', { outcome: 'NOT_FINAL', observedFinality: 'CAPTURED' } as FundingVerificationResult, 'FUNDING_NOT_FINAL'],
    ['DEPENDENCY_UNAVAILABLE', { outcome: 'DEPENDENCY_UNAVAILABLE' } as FundingVerificationResult, 'FUNDING_DEPENDENCY_UNAVAILABLE'],
  ])('%s fails closed without a financial mutation', async (_name, verification, code) => {
    const h = await setup(verification); const cellId = await h.create(`phase2-${_name}`);
    const result = await h.ingress.handleFundingConfirmation({ credential: gatewayIdentity.credential,
      commandId: makeCommandId(`fund-${_name}`), cellId,
      evidence: { intentId: intentIdFor(cellId), provider: 'test-provider', providerTransactionId: `tx-${_name}` } });
    expect(result).toMatchObject({ outcome: 'APPLICATION_REJECTION', error: { code } });
    expect((await h.persistence.eventStore.getEvents(cellId)).map((event) => event.type)).toEqual(['CellCreated']);
  });

  test('unauthenticated, unauthorized and unknown-cell requests fail before verification', async () => {
    const h = await setup(); const cellId = await h.create('phase2-auth');
    const request = { commandId: makeCommandId('phase2-auth-fund'), cellId,
      evidence: { intentId: intentIdFor(cellId), provider: 'test-provider', providerTransactionId: 'phase2-auth-tx' } };
    expect(await h.ingress.handleFundingConfirmation({ ...request, credential: 'bad' }))
      .toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(await h.ingress.handleFundingConfirmation({ ...request, credential: actorIdentity(PAYER).credential }))
      .toMatchObject({ error: { code: 'COMMAND_NOT_PERMITTED' } });
    expect(await h.ingress.handleFundingConfirmation({ ...request, credential: gatewayIdentity.credential,
      cellId: makeCellId('missing-phase2') })).toMatchObject({ error: { code: 'CELL_NOT_FOUND' } });
  });

  test('same confirmation replays deterministically and provider transaction reuse across cells conflicts', async () => {
    const h = await setup(); const first = await h.create('phase2-first'); const second = await h.create('phase2-second');
    const request = { credential: gatewayIdentity.credential, commandId: makeCommandId('phase2-duplicate'), cellId: first,
      evidence: { intentId: intentIdFor(first), provider: 'test-provider', providerTransactionId: 'shared-phase2-tx' } };
    const one = await h.ingress.handleFundingConfirmation(request);
    const replay = await h.ingress.handleFundingConfirmation(request);
    expect(replay).toEqual(one);
    const conflict = await h.ingress.handleFundingConfirmation({ ...request,
      commandId: makeCommandId('phase2-conflict'), cellId: second,
      evidence: { ...request.evidence, intentId: intentIdFor(second) } });
    expect(conflict).toMatchObject({ outcome: 'APPLICATION_REJECTION', error: { code: 'FUNDING_RECEIPT_CONFLICT' } });
    expect((await h.persistence.eventStore.getEvents(second)).map((event) => event.type)).toEqual(['CellCreated']);
  });
});
