import { InMemoryPersistenceAdapter } from '../adapters/in-memory-persistence-adapter';
import { CellApplication } from '../application/cell-application';
import { fixedClock } from '../application/clock';
import { createEventIdFactory } from '../application/event-id-factory';
import { cellKernel } from '../kernel';
import { makeActorId, makeAmount, makeCellId, makeCommandId, makeTimestamp } from '../core/types';
import type { ExpectedFundingBinding, FundingVerificationResult } from '../funding/types';
import type { FundingEvidencePort, PrincipalRecord } from './trusted-ingress';
import { actorIdentity, createTestIngress } from './testing';

const PAYER = makeActorId('phase2-payer');
const PAYEE = makeActorId('phase2-payee');
const AMOUNT = makeAmount(4200n);
const gateway: PrincipalRecord = { principalId: 'phase2-gateway', type: 'GATEWAY', enabled: true,
  capabilities: ['CONFIRM_FUNDING'], mappingVersion: 1 };
const gatewayIdentity = { credential: 'phase2-gateway-token', subject: 'phase2-gateway-subject', principal: gateway };

function verified(expected: ExpectedFundingBinding, transaction = 'phase2-tx'): FundingVerificationResult {
  return { outcome: 'VERIFIED', context: {
    provider: 'test-provider', providerTransactionId: transaction,
    ...expected, confirmedAt: makeTimestamp(900_000), finality: 'SETTLED',
    evidenceDigest: 'a'.repeat(64), verifiedAt: makeTimestamp(950_000),
  } };
}

async function setup(result?: FundingVerificationResult) {
  const persistence = new InMemoryPersistenceAdapter();
  const app = new CellApplication({ persistence, kernel: cellKernel,
    clock: fixedClock(makeTimestamp(1_000_000)), eventIds: createEventIdFactory('phase2') });
  let captured: ExpectedFundingBinding | undefined;
  let verification: FundingVerificationResult | undefined = result;
  const port: FundingEvidencePort = { async verify(_evidence, expected) {
    captured = expected; return verification ?? verified(expected);
  } };
  const actor = actorIdentity(PAYER, 'phase2-payer');
  const ingress = createTestIngress(app, [actor, gatewayIdentity], port);
  async function create(cellName: string) {
    const cellId = makeCellId(cellName);
    await ingress.handle({ credential: actor.credential, command: { commandId: makeCommandId(`create-${cellName}`),
      cellId, type: 'CreateCell', payload: { payer: PAYER, payee: PAYEE, amount: AMOUNT, currency: 'TRY',
        fundingDeadline: makeTimestamp(2_000_000), completionDeadline: makeTimestamp(3_000_000) } } });
    return cellId;
  }
  return { persistence, ingress, create, captured: () => captured,
    setResult(value: FundingVerificationResult) { verification = value; } };
}

describe('Funding Phase 2 verification and ingress', () => {
  test('derives the complete expected binding from authoritative cell state and trusted destination config', async () => {
    const h = await setup(); const cellId = await h.create('phase2-binding');
    const result = await h.ingress.handleFundingConfirmation({ credential: gatewayIdentity.credential,
      commandId: makeCommandId('phase2-fund'), cellId,
      evidence: { provider: 'test-provider', providerTransactionId: 'phase2-tx', opaqueEvidence: { amount: 'caller-value' } } });
    expect(result.outcome).toBe('SUCCESS');
    expect(h.captured()).toEqual({ gatewayPrincipalId: gateway.principalId, cellId, payer: PAYER,
      amount: AMOUNT, currency: 'TRY', destinationId: 'test-custody' });
    expect((await h.persistence.eventStore.getEvents(cellId)).map((event) => event.type))
      .toEqual(['CellCreated', 'CellFunded']);
  });

  test.each([
    ['INVALID', { outcome: 'INVALID', reason: 'BINDING_MISMATCH' } as FundingVerificationResult, 'FUNDING_EVIDENCE_INVALID'],
    ['NOT_FINAL', { outcome: 'NOT_FINAL', observedFinality: 'CAPTURED' } as FundingVerificationResult, 'FUNDING_NOT_FINAL'],
    ['DEPENDENCY_UNAVAILABLE', { outcome: 'DEPENDENCY_UNAVAILABLE' } as FundingVerificationResult, 'FUNDING_DEPENDENCY_UNAVAILABLE'],
  ])('%s fails closed without a financial mutation', async (_name, verification, code) => {
    const h = await setup(verification); const cellId = await h.create(`phase2-${_name}`);
    const result = await h.ingress.handleFundingConfirmation({ credential: gatewayIdentity.credential,
      commandId: makeCommandId(`fund-${_name}`), cellId,
      evidence: { provider: 'test-provider', providerTransactionId: `tx-${_name}` } });
    expect(result).toMatchObject({ outcome: 'APPLICATION_REJECTION', error: { code } });
    expect((await h.persistence.eventStore.getEvents(cellId)).map((event) => event.type)).toEqual(['CellCreated']);
  });

  test('unauthenticated, unauthorized and unknown-cell requests fail before verification', async () => {
    const h = await setup(); const cellId = await h.create('phase2-auth');
    const request = { commandId: makeCommandId('phase2-auth-fund'), cellId,
      evidence: { provider: 'test-provider', providerTransactionId: 'phase2-auth-tx' } };
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
      evidence: { provider: 'test-provider', providerTransactionId: 'shared-phase2-tx' } };
    const one = await h.ingress.handleFundingConfirmation(request);
    const replay = await h.ingress.handleFundingConfirmation(request);
    expect(replay).toEqual(one);
    const conflict = await h.ingress.handleFundingConfirmation({ ...request,
      commandId: makeCommandId('phase2-conflict'), cellId: second });
    expect(conflict).toMatchObject({ outcome: 'APPLICATION_REJECTION', error: { code: 'FUNDING_RECEIPT_CONFLICT' } });
    expect((await h.persistence.eventStore.getEvents(second)).map((event) => event.type)).toEqual(['CellCreated']);
  });
});
