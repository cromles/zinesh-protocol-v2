import { CellApplication } from './cell-application';
import { fixedClock } from './clock';
import { createEventIdFactory } from './event-id-factory';
import { InMemoryPersistenceAdapter } from '../adapters/in-memory-persistence-adapter';
import { makeActorId, makeAmount, makeCellId, makeCommandId, makeTimestamp } from '../core/types';
import { cellKernel } from '../kernel';
import type { FundingEvidencePort, FundingObservationEvidencePort } from '../security/trusted-ingress';
import { createTestIngress, actorIdentity } from '../security/testing';
import type { TestIdentity } from '../security/testing';
import type { FundingObservation } from '../funding/funding-foundation';
import { PrototypeFundingEvidence } from '../development/prototype-funding';
import type { ExpectedFundingBinding } from '../funding/types';

const payer = makeActorId('prototype-payer');
const payee = makeActorId('prototype-payee');
const cellId = makeCellId('prototype-cell');
const amount = makeAmount(12500n);
const gateway: TestIdentity = { credential: 'prototype-gateway-credential', subject: 'prototype-gateway',
  principal: { principalId: 'prototype-gateway', type: 'GATEWAY', enabled: true,
    capabilities: ['CONFIRM_FUNDING'], mappingVersion: 1 } };

function makeHarness() {
  const persistence = new InMemoryPersistenceAdapter();
  const app = new CellApplication({ persistence, kernel: cellKernel,
    clock: fixedClock(makeTimestamp(1_000_000)), eventIds: createEventIdFactory('prototype-flow') });
  const verifier: FundingEvidencePort = { async verify(evidence, expected) {
    const observationId = (evidence.opaqueEvidence as { observationId?: unknown } | undefined)?.observationId;
    if (typeof observationId !== 'string') return { outcome: 'INVALID', reason: 'AUTHENTICITY_FAILED' };
    const envelope = await persistence.providerFoundationStore.getObservation(
      evidence.provider, expected.environment, expected.providerAccountScope, observationId,
    );
    if (envelope === null || envelope.correlationStatus !== 'MATCHED' || envelope.intentId !== expected.intentId) {
      return { outcome: 'INVALID', reason: 'BINDING_MISMATCH' };
    }
    const observation = envelope.observation;
    if (observation.state !== 'FUNDS_HELD' || observation.provider !== evidence.provider
      || observation.providerTransactionId !== evidence.providerTransactionId
      || observation.environment !== expected.environment || observation.providerAccountScope !== expected.providerAccountScope
      || observation.amount !== expected.amount || observation.currency !== expected.currency
      || observation.destinationReference !== expected.destinationId) {
      return { outcome: 'INVALID', reason: 'BINDING_MISMATCH' };
    }
    return { outcome: 'VERIFIED', context: { intentId: expected.intentId, provider: observation.provider,
      environment: observation.environment, providerAccountScope: observation.providerAccountScope,
      providerTransactionId: observation.providerTransactionId, gatewayPrincipalId: expected.gatewayPrincipalId,
      cellId: expected.cellId, payer: expected.payer, payee: expected.payee, amount: observation.amount,
      currency: observation.currency, destinationId: expected.destinationId, confirmedAt: observation.observedAt,
      finality: 'FUNDS_HELD', evidenceDigest: observation.rawPayloadDigest, verifiedAt: makeTimestamp(1_000_100) } };
  } };
  const observationVerifier: FundingObservationEvidencePort = {
    async verify(_observation, evidence) { return evidence === 'prototype-observation-proof'; },
  };
  const ingress = createTestIngress(app, [actorIdentity(payer), actorIdentity(payee), gateway], verifier,
    undefined, { async resolve() { return 'prototype-destination'; } }, observationVerifier);
  return { app, ingress, persistence };
}

function observation(overrides: Partial<FundingObservation> = {}): FundingObservation {
  return { observationId: 'prototype-observation', provider: 'prototype-ledger', environment: 'SANDBOX',
    providerAccountScope: 'prototype-account', providerTransactionId: 'prototype-tx', direction: 'CREDIT',
    amount, currency: 'TRY', observedAt: makeTimestamp(1_000_050), destinationReference: 'prototype-destination',
    rawPayloadDigest: 'a'.repeat(64), state: 'FUNDS_HELD', ...overrides };
}

async function createCell(h: ReturnType<typeof makeHarness>) {
  const created = await h.ingress.handle({ credential: 'test-credential-prototype-payer', command: {
    commandId: makeCommandId('prototype-create-cell'), cellId, type: 'CreateCell', payload: { payer, payee,
      description: 'Prototype agreement delivery.', amount,
      currency: 'TRY', fundingDeadline: makeTimestamp(2_000_000), completionDeadline: makeTimestamp(5_000_000) } } });
  if (created.outcome !== 'SUCCESS') return created;
  return h.ingress.handle({ credential: 'test-credential-prototype-payee', command: {
    commandId: makeCommandId('prototype-accept-cell'), cellId, type: 'AcceptCell', payload: { acceptedBy: payee } } });
}

async function provision(h: ReturnType<typeof makeHarness>) {
  const intent = { intentId: 'prototype-intent', provider: 'prototype-ledger', environment: 'SANDBOX' as const,
    providerAccountScope: 'prototype-account', cellId, destinationId: 'prototype-destination',
    expiresAt: makeTimestamp(1_900_000) };
  const created = await h.ingress.provisionFundingIntent({ credential: gateway.credential, intent: {
    intentId: intent.intentId, provider: intent.provider, environment: intent.environment,
    providerAccountScope: intent.providerAccountScope, cellId, destinationId: intent.destinationId,
    expiresAt: intent.expiresAt } });
  expect(created.kind).toBe('CREATED');
  const route = { routeId: 'prototype-route', intentId: intent.intentId, provider: intent.provider,
    environment: intent.environment, providerAccountScope: intent.providerAccountScope,
    destinationReference: intent.destinationId, currency: 'TRY' as const, expectedAmount: amount,
    status: 'ACTIVE' as const, createdAt: makeTimestamp(1_000_000), expiresAt: makeTimestamp(1_800_000) };
  expect(await h.ingress.provisionFundingRoute({ credential: gateway.credential, route })).toBe('CREATED');
  return intent;
}

async function confirm(h: ReturnType<typeof makeHarness>, observationId = 'prototype-observation') {
  return h.ingress.handleFundingConfirmation({ credential: gateway.credential,
    commandId: makeCommandId('prototype-fund-command'), cellId, evidence: { intentId: 'prototype-intent',
      provider: 'prototype-ledger', environment: 'SANDBOX', providerAccountScope: 'prototype-account',
      providerTransactionId: 'prototype-tx', opaqueEvidence: { observationId } } });
}

function reconcile(h: ReturnType<typeof makeHarness>, value: FundingObservation, credential = gateway.credential) {
  return h.ingress.reconcileFundingObservation({ credential, observation: value, evidence: 'prototype-observation-proof' });
}

describe('application-level prototype funding flow', () => {
  test('prototype evidence verifier rejects caller-constructed FUNDS_HELD claims', async () => {
    const verifier = new PrototypeFundingEvidence();
    const expected: ExpectedFundingBinding = { intentId: 'prototype-proof-intent', environment: 'SANDBOX',
      providerAccountScope: 'prototype-only', gatewayPrincipalId: 'zinesh-prototype-gateway', cellId,
      payer, payee, amount, currency: 'TRY', destinationId: 'prototype-destination' };
    await expect(verifier.verify({ provider: 'zinesh-prototype', environment: 'SANDBOX',
      providerAccountScope: 'prototype-only', providerTransactionId: 'forged', intentId: expected.intentId,
      opaqueEvidence: {} }, expected)).resolves.toMatchObject({ outcome: 'INVALID', reason: 'AUTHENTICITY_FAILED' });
  });

  test('development prototype contract funds only the payer-owned cell through trusted funding and release ingress', async () => {
    const persistence = new InMemoryPersistenceAdapter();
    const app = new CellApplication({ persistence, kernel: cellKernel,
      clock: fixedClock(makeTimestamp(1_000_000)), eventIds: createEventIdFactory('prototype-contract') });
    const ingress = createTestIngress(app, [actorIdentity(payer), actorIdentity(payee)], undefined,
      undefined, undefined, undefined, new PrototypeFundingEvidence());
    const created = await ingress.handle({ credential: 'test-credential-prototype-payer', command: {
      commandId: makeCommandId('prototype-contract-create'), cellId, type: 'CreateCell', payload: { payer, payee,
        description: 'Prototype agreement delivery.', amount, currency: 'TRY',
        fundingDeadline: makeTimestamp(2_000_000), completionDeadline: makeTimestamp(5_000_000) } } });
    expect(created.outcome).toBe('SUCCESS');
    const accepted = await ingress.handle({ credential: 'test-credential-prototype-payee', command: {
      commandId: makeCommandId('prototype-contract-accept'), cellId, type: 'AcceptCell', payload: { acceptedBy: payee } } });
    expect(accepted.outcome).toBe('SUCCESS');
    const request = { credential: 'test-credential-prototype-payer',
      commandId: makeCommandId('prototype-contract-fund'), cellId };
    const funded = await ingress.handlePrototypeFunding(request);
    expect(funded).toMatchObject({ outcome: 'SUCCESS', nextState: { status: 'FUNDED' }, version: 3 });
    expect(await ingress.handlePrototypeFunding(request)).toMatchObject({ outcome: 'SUCCESS', version: 3 });
    expect(await persistence.eventStore.getEvents(cellId)).toHaveLength(3);
    expect(await ingress.getFundingReceipt('test-credential-prototype-payer', cellId))
      .toMatchObject({ provider: 'zinesh-prototype', environment: 'SANDBOX', finality: 'FUNDS_HELD' });
    const requested = await ingress.handle({ credential: 'test-credential-prototype-payer', command: {
      commandId: makeCommandId('prototype-contract-release-request'), cellId,
      type: 'RequestRelease', payload: { requestedBy: payer } } });
    expect(requested.outcome).toBe('SUCCESS');
    const approved = await ingress.handle({ credential: 'test-credential-prototype-payee', command: {
      commandId: makeCommandId('prototype-contract-release-approval'), cellId,
      type: 'ApproveRelease', payload: { approvedBy: payee } } });
    expect(approved).toMatchObject({ outcome: 'SUCCESS', nextState: { status: 'RELEASED' } });
  });

  test('prototype contract is closed without the development adapter and rejects non-owners and unknown cells', async () => {
    const h = makeHarness();
    await createCell(h);
    expect((await h.ingress.handlePrototypeFunding({ credential: 'test-credential-prototype-payer',
      commandId: makeCommandId('disabled-prototype-fund'), cellId })).outcome).toBe('APPLICATION_REJECTION');
    const enabledIngress = createTestIngress(h.app, [actorIdentity(payer), actorIdentity(payee)], undefined,
      undefined, undefined, undefined, new PrototypeFundingEvidence());
    expect((await enabledIngress.handlePrototypeFunding({ credential: 'test-credential-prototype-payee',
      commandId: makeCommandId('payee-prototype-fund'), cellId })).outcome).toBe('APPLICATION_REJECTION');
    expect((await enabledIngress.handlePrototypeFunding({ credential: 'test-credential-prototype-payer',
      commandId: makeCommandId('missing-prototype-fund'), cellId: makeCellId('missing-prototype-cell') }))
      .outcome).toBe('APPLICATION_REJECTION');
  });

  test('cell → intent → route → observation → verified receipt → release → terminal state', async () => {
    const h = makeHarness();
    expect((await createCell(h)).outcome).toBe('SUCCESS');
    await provision(h);
    expect(await reconcile(h, observation())).toEqual({ outcome: 'ACCEPTED',
      reconciliation: { kind: 'FUNDS_HELD', intentId: 'prototype-intent' } });
    expect((await confirm(h)).outcome).toBe('SUCCESS');
    const receipt = await h.ingress.getFundingReceipt(gateway.credential, cellId);
    expect(receipt).toMatchObject({ intentId: 'prototype-intent', provider: 'prototype-ledger',
      environment: 'SANDBOX', providerAccountScope: 'prototype-account', finality: 'FUNDS_HELD' });
    expect((await h.app.getCellState(cellId))?.status).toBe('FUNDED');
    const requested = await h.ingress.handle({ credential: 'test-credential-prototype-payer', command: {
      commandId: makeCommandId('prototype-release-request'), cellId, type: 'RequestRelease', payload: { requestedBy: payer } } });
    expect(requested.outcome).toBe('SUCCESS');
    const approved = await h.ingress.handle({ credential: 'test-credential-prototype-payee', command: {
      commandId: makeCommandId('prototype-release-approval'), cellId, type: 'ApproveRelease', payload: { approvedBy: payee } } });
    expect(approved).toMatchObject({ outcome: 'SUCCESS', nextState: { status: 'RELEASED' } });
  });

  test('invalid evidence and route scope mismatches cannot fund; identical and conflicting observations are distinguished', async () => {
    const h = makeHarness(); await createCell(h); await provision(h);
    expect(await reconcile(h, observation({ state: 'RETURNED', observationId: 'unauthorized-negative',
      relatedProviderTransactionId: 'prototype-tx' }), 'test-credential-prototype-payer')).toEqual({ outcome: 'REJECTED' });
    expect(await h.persistence.providerFoundationStore.getObservation('prototype-ledger', 'SANDBOX',
      'prototype-account', 'unauthorized-negative')).toBeNull();
    expect(await h.persistence.fundingDisputeStore.hasBlockingDispute(cellId)).toBe(false);
    const wrongRoute = { routeId: 'wrong-scope-route', intentId: 'prototype-intent', provider: 'prototype-ledger',
      environment: 'LIVE' as const, providerAccountScope: 'other-account', destinationReference: 'prototype-destination',
      currency: 'TRY' as const, expectedAmount: amount, status: 'ACTIVE' as const,
      createdAt: makeTimestamp(1_000_000) };
    expect(await h.ingress.provisionFundingRoute({ credential: gateway.credential, route: wrongRoute })).toBe('CONFLICT');
    expect(await reconcile(h, observation({ environment: 'LIVE', observationId: 'wrong-env' })))
      .toMatchObject({ outcome: 'ACCEPTED', reconciliation: { kind: 'UNMATCHED' } });
    expect(await reconcile(h, observation({ provider: 'other-ledger', observationId: 'wrong-provider' })))
      .toMatchObject({ outcome: 'ACCEPTED', reconciliation: { kind: 'UNMATCHED' } });
    expect(await reconcile(h, observation({ providerAccountScope: 'other-account', observationId: 'wrong-account' })))
      .toMatchObject({ outcome: 'ACCEPTED', reconciliation: { kind: 'UNMATCHED' } });
    const matched = observation();
    expect(await reconcile(h, matched)).toMatchObject({ outcome: 'ACCEPTED', reconciliation: { kind: 'FUNDS_HELD' } });
    expect(await reconcile(h, matched)).toMatchObject({ outcome: 'ACCEPTED', reconciliation: { kind: 'DUPLICATE' } });
    expect(await reconcile(h, observation({ rawPayloadDigest: 'b'.repeat(64) })))
      .toMatchObject({ outcome: 'ACCEPTED', reconciliation: { kind: 'UNMATCHED' } });
    expect((await h.ingress.handleFundingConfirmation({ credential: gateway.credential,
      commandId: makeCommandId('bad-prototype-fund'), cellId, evidence: { intentId: 'prototype-intent',
        provider: 'prototype-ledger', providerTransactionId: 'prototype-tx' } })).outcome).toBe('APPLICATION_REJECTION');
    expect((await h.app.getCellState(cellId))?.status).toBe('CREATED');
  });

  test('unresolved negative observation continues to block settlement', async () => {
    const h = makeHarness(); await createCell(h); await provision(h);
    await reconcile(h, observation());
    expect((await confirm(h)).outcome).toBe('SUCCESS');
    expect(await reconcile(h, observation({ observationId: 'prototype-return',
      state: 'RETURNED', relatedProviderTransactionId: 'prototype-tx' })))
      .toMatchObject({ outcome: 'ACCEPTED', reconciliation: { kind: 'NEGATIVE' } });
    const request = await h.ingress.handle({ credential: 'test-credential-prototype-payer', command: {
      commandId: makeCommandId('blocked-release-request'), cellId, type: 'RequestRelease', payload: { requestedBy: payer } } });
    expect(request.outcome).toBe('SUCCESS');
    const approval = await h.ingress.handle({ credential: 'test-credential-prototype-payee', command: {
      commandId: makeCommandId('blocked-release-approval'), cellId, type: 'ApproveRelease', payload: { approvedBy: payee } } });
    expect(approval).toMatchObject({ outcome: 'APPLICATION_REJECTION', error: { code: 'FUNDING_DISPUTE_BLOCKED' } });
  });
});
