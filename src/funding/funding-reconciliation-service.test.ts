import { makeActorId, makeAmount, makeCellId, makeTimestamp } from '../core/types';
import { InMemoryFundingIntentStore } from '../adapters/in-memory-funding-intent-store';
import { InMemoryProviderFoundationStore } from '../adapters/in-memory-provider-foundation-store';
import { createFundingIntent } from './funding-intent';
import type { FundingObservation, FundingRoute } from './funding-foundation';
import { FundingReconciliationService } from './funding-reconciliation-service';

const at=makeTimestamp(100);
const intent=createFundingIntent({intentId:'intent-1',provider:'bank',environment:'LIVE',providerAccountScope:'account-1',cellId:makeCellId('cell-1'),
  payer:makeActorId('payer'),payee:makeActorId('payee'),amount:makeAmount(1000n),currency:'TRY',
  destinationId:'route-ref-1',createdAt:at,expiresAt:makeTimestamp(1000)});
const route:FundingRoute={routeId:'route-1',intentId:intent.intentId,provider:'bank',environment:'LIVE',
  providerAccountScope:'account-1',destinationReference:'route-ref-1',currency:'TRY',expectedAmount:makeAmount(1000n),
  status:'ACTIVE',createdAt:at,expiresAt:makeTimestamp(900)};
function observation(overrides:Partial<FundingObservation>={}):FundingObservation{return {
  observationId:'observation-1',provider:'bank',environment:'LIVE',providerAccountScope:'account-1',
  providerTransactionId:'bank-tx-1',direction:'CREDIT',amount:makeAmount(1000n),currency:'TRY',
  observedAt:makeTimestamp(200),destinationReference:'route-ref-1',rawPayloadDigest:'a'.repeat(64),state:'FUNDS_HELD',
  ...overrides,
};}

async function setup(){
  const foundation=new InMemoryProviderFoundationStore();
  const intents=new InMemoryFundingIntentStore();
  await intents.create(intent);
  const service=new FundingReconciliationService(foundation,intents);
  return {foundation,intents,service};
}

describe('provider-neutral funding foundation',()=>{
  test('route creation is intent-bound and idempotent',async()=>{
    const {service}=await setup();
    await expect(service.createRoute(route)).resolves.toBe('CREATED');
    await expect(service.createRoute(route)).resolves.toBe('DUPLICATE');
    await expect(service.createRoute({...route,routeId:'other',expectedAmount:makeAmount(500n)})).resolves.toBe('CONFLICT');
    await expect(service.createRoute({...route,intentId:'unknown'})).resolves.toBe('CONFLICT');
  });

  test('observation is recorded before matching and wrong amount remains auditable as unmatched',async()=>{
    const {foundation,service}=await setup();
    await service.createRoute(route);
    const wrong=observation({amount:makeAmount(999n)});
    await expect(service.reconcileObservation(wrong)).resolves.toEqual({kind:'UNMATCHED',reason:'AMOUNT_MISMATCH'});
    const saved=await foundation.getObservation('bank','LIVE','account-1',wrong.observationId);
    expect(saved).toMatchObject({correlationStatus:'UNMATCHED',observation:wrong});
    await expect(foundation.listUnmatchedObservations('bank','LIVE','account-1',10)).resolves.toHaveLength(1);
  });

  test('valid held observation correlates once and does not create VerifiedFundingContext',async()=>{
    const {foundation,service}=await setup();
    await service.createRoute(route);
    await expect(service.reconcileObservation(observation())).resolves.toEqual({kind:'FUNDS_HELD',intentId:intent.intentId});
    await expect(service.reconcileObservation(observation())).resolves.toMatchObject({kind:'DUPLICATE'});
    await expect(foundation.getCorrelation('bank','LIVE','bank-tx-1','account-1')).resolves.toMatchObject({intentId:intent.intentId});
    await expect(foundation.getCheckpoint('bank','LIVE','bank-tx-1','account-1')).resolves.toMatchObject({state:'FUNDS_HELD'});
  });

  test('pending, settled, not found, unavailable and unknown remain distinct',async()=>{
    const {service}=await setup();
    await service.createRoute(route);
    await expect(service.reconcileObservation(observation({state:'PENDING'}))).resolves.toEqual({kind:'PENDING',intentId:intent.intentId});
    await expect(service.reconcileObservation(observation({observationId:'settled',state:'SETTLED'})))
      .resolves.toEqual({kind:'SETTLED',intentId:intent.intentId});
    await expect(service.reconcileObservation(observation({observationId:'unknown',state:'UNKNOWN'})))
      .resolves.toEqual({kind:'UNKNOWN',intentId:intent.intentId});
    await expect(service.reconcileLookup({outcome:'NOT_FOUND',checkedAt:at})).resolves.toEqual({kind:'NOT_FOUND'});
    await expect(service.reconcileLookup({outcome:'UNAVAILABLE',checkedAt:at})).resolves.toEqual({kind:'UNAVAILABLE'});
  });

  test.each(['RETURNED','REVERSED','REFUND','DISPUTE'] as const)('%s remains a negative observation, not PENDING',async(state)=>{
    const {foundation,service}=await setup();
    await service.createRoute(route);
    await service.reconcileObservation(observation());
    const negative=observation({observationId:`negative-${state}`,state,relatedProviderTransactionId:'bank-tx-1'});
    await expect(service.reconcileObservation(negative)).resolves.toMatchObject({kind:'NEGATIVE',state});
    await expect(foundation.getCheckpoint('bank','LIVE','bank-tx-1','account-1')).resolves.toMatchObject({state});
    const unmatched=await foundation.listUnmatchedObservations('bank','LIVE','account-1',10);
    expect(unmatched).toHaveLength(0);
  });

  test('transaction and route mismatches never bind an observation',async()=>{
    const {foundation,service}=await setup();
    await service.createRoute(route);
    await service.reconcileObservation(observation());
    await expect(service.reconcileObservation(observation({observationId:'other',providerTransactionId:'other-tx'})))
      .resolves.toEqual({kind:'UNMATCHED',reason:'TRANSACTION_CONFLICT'});
    await expect(service.reconcileObservation(observation({observationId:'currency',providerTransactionId:'currency-tx',currency:'USD' as never})))
      .resolves.toEqual({kind:'UNMATCHED',reason:'CURRENCY_MISMATCH'});
    await expect(service.reconcileObservation(observation({observationId:'destination',providerTransactionId:'dest-tx',destinationReference:'wrong'})))
      .resolves.toEqual({kind:'UNMATCHED',reason:'NO_ROUTE'});
    await expect(foundation.getCorrelation('bank','LIVE','other-tx')).resolves.toBeNull();
  });

  test('inbox lease permits one concurrent worker and completion is idempotent',async()=>{
    const {foundation,service}=await setup();
    await foundation.recordEvent({eventIdentity:'e'.repeat(64),replayIdentity:'r'.repeat(64),provider:'bank',
      environment:'LIVE',providerTransactionId:'tx',intentId:'intent-1',eventType:'CREDIT',payloadDigest:'p'.repeat(64),receivedAt:at});
    const [one,two]=await Promise.all([
      foundation.claimEvent('e'.repeat(64),'worker-1',100,50),foundation.claimEvent('e'.repeat(64),'worker-2',100,50),
    ]);
    expect([one.kind,two.kind].sort()).toEqual(['BUSY','CLAIMED']);
    const owner=one.kind==='CLAIMED'?'worker-1':'worker-2';
    let runs=0;
    const outsider=owner==='worker-1'?'worker-2':'worker-1';
    await expect(foundation.claimEvent('e'.repeat(64),outsider,101,50)).resolves.toEqual({kind:'BUSY'});
    await expect(foundation.completeEvent('e'.repeat(64),outsider,101)).resolves.toBe('NOT_CLAIMED');
    await expect(foundation.completeEvent('e'.repeat(64),owner,101)).resolves.toBe('PROCESSED');
    await expect(foundation.completeEvent('e'.repeat(64),owner,102)).resolves.toBe('PROCESSED');
    await foundation.recordEvent({eventIdentity:'z'.repeat(64),replayIdentity:'q'.repeat(64),provider:'bank',
      environment:'LIVE',providerTransactionId:'tx-z',eventType:'CREDIT',payloadDigest:'z'.repeat(64),receivedAt:at});
    await expect(service.processInboxEvent('z'.repeat(64),'worker-3',103,50,async()=>{runs+=1;})).resolves.toBe('PROCESSED');
    await expect(service.processInboxEvent('z'.repeat(64),'worker-3',104,50,async()=>{runs+=1;})).resolves.toBe('PROCESSED');
    expect(runs).toBe(1);
  });

  test('expired leases can be recovered and failed work can retry',async()=>{
    const {foundation,service}=await setup();
    await foundation.recordEvent({eventIdentity:'f'.repeat(64),replayIdentity:'s'.repeat(64),provider:'bank',
      environment:'LIVE',providerTransactionId:'tx-f',eventType:'CREDIT',payloadDigest:'d'.repeat(64),receivedAt:at});
    await foundation.claimEvent('f'.repeat(64),'worker-1',100,10);
    await expect(foundation.claimEvent('f'.repeat(64),'worker-2',110,10)).resolves.toMatchObject({kind:'CLAIMED'});
    await expect(foundation.failEvent('f'.repeat(64),'worker-2',111,'PROCESSING_FAILED')).resolves.toBe('FAILED');
    await expect(service.processInboxEvent('f'.repeat(64),'worker-3',112,10,async()=>{})).resolves.toBe('PROCESSED');
  });

  test('stale transaction checkpoints and invalid account cursor revisions are rejected',async()=>{
    const {foundation,service}=await setup();
    await service.createRoute(route);
    await service.reconcileObservation(observation());
    await foundation.putCheckpoint({provider:'bank',environment:'LIVE',providerAccountScope:'account-1',providerTransactionId:'bank-tx-1',
      state:'PENDING',attemptCount:1,checkedAt:makeTimestamp(150)});
    await expect(foundation.getCheckpoint('bank','LIVE','bank-tx-1','account-1')).resolves.toMatchObject({state:'FUNDS_HELD',checkedAt:makeTimestamp(200)});
    const checkpoint={provider:'bank',environment:'LIVE' as const,providerAccountScope:'account-1',cursor:'c1',checkedAt:at,revision:1};
    await expect(foundation.putAccountCheckpoint(checkpoint)).resolves.toBe(true);
    await expect(foundation.putAccountCheckpoint({...checkpoint,cursor:'stale',revision:1})).resolves.toBe(false);
    await expect(foundation.getAccountCheckpoint('bank','LIVE','account-1')).resolves.toMatchObject({cursor:'c1',revision:1});
  });
});

