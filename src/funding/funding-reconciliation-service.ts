import type { FundingIntent } from './types';
import type { FundingObservation, FundingObservationLookupResult, FundingReconciliationOutcome, FundingRoute } from './funding-foundation';
import { hasValidFundingObservation, hasValidFundingRoute } from './funding-foundation';
import type { ProviderFoundationStore } from '../adapters/provider-foundation-store';
import type { FundingIntentStore } from '../adapters/funding-intent-store';
import type { ProviderEvent, ProviderNegativeObservationKind, ProviderReconciliationState } from './provider-evidence';
import { providerIdentityHash } from './provider-identity';
import { makeAmount } from '../core/types';

/** Provider-neutral route and observation orchestration. It never creates funding authority. */
export class FundingReconciliationService {
  constructor(private readonly foundation: ProviderFoundationStore, private readonly intents: FundingIntentStore) {}

  async createRoute(route: FundingRoute): Promise<'CREATED' | 'DUPLICATE' | 'CONFLICT'> {
    if (!hasValidFundingRoute(route)) return 'CONFLICT';
    const intent = await this.intents.get(route.intentId);
    if (intent === null || !routeMatchesIntent(route,intent)) return 'CONFLICT';
    const result = await this.foundation.createRoute(route);
    return result.kind;
  }

  async reconcileLookup(result: FundingObservationLookupResult, route?: FundingRoute): Promise<FundingReconciliationOutcome> {
    if (result.outcome === 'NOT_FOUND') return { kind:'NOT_FOUND' };
    if (result.outcome === 'UNAVAILABLE') return { kind:'UNAVAILABLE' };
    return this.reconcileObservation(result.observation, route);
  }

  /** Lease-based inbox processing. The callback must use eventIdentity as its idempotency key. */
  async processInboxEvent(eventIdentity:string,workerId:string,now:number,leaseMs:number,
    process:(event:ProviderEvent,idempotencyKey:string)=>Promise<void>):Promise<'PROCESSED'|'BUSY'|'NOT_FOUND'|'FAILED'|'NOT_CLAIMED'>{
    const claim=await this.foundation.claimEvent(eventIdentity,workerId,now,leaseMs);
    if(claim.kind==='BUSY')return 'BUSY';
    if(claim.kind==='NOT_FOUND')return 'NOT_FOUND';
    if(claim.kind==='PROCESSED')return 'PROCESSED';
    const event=await this.foundation.getEvent(eventIdentity);
    if(event===null)return 'NOT_FOUND';
    try{
      await process(event,eventIdentity);
      const completed=await this.foundation.completeEvent(eventIdentity,workerId,now);
      return completed==='PROCESSED'?'PROCESSED':completed==='NOT_CLAIMED'?'NOT_CLAIMED':'NOT_FOUND';
    }catch{
      const failed=await this.foundation.failEvent(eventIdentity,workerId,now,'PROCESSING_FAILED');
      return failed==='FAILED'?'FAILED':failed==='NOT_CLAIMED'?'NOT_CLAIMED':'NOT_FOUND';
    }
  }

  async reconcileObservation(observation: FundingObservation, routeHint?: FundingRoute): Promise<FundingReconciliationOutcome> {
    if (!hasValidFundingObservation(observation)) return { kind:'UNMATCHED',reason:'NO_ROUTE' };
    const recorded = await this.foundation.recordObservation(observation);
    if (recorded.kind === 'CONFLICT') return { kind:'UNMATCHED',reason:'TRANSACTION_CONFLICT' };
    if (recorded.kind === 'DUPLICATE') return { kind:'DUPLICATE',observation:recorded.observation };

    const parentTransactionId = observation.relatedProviderTransactionId ?? observation.providerTransactionId;
    const existingCorrelation = await this.foundation.getCorrelation(observation.provider,observation.environment,parentTransactionId,observation.providerAccountScope);
    let route = routeHint;
    if (route !== undefined && (route.provider !== observation.provider || route.environment !== observation.environment
      || route.providerAccountScope !== observation.providerAccountScope)) route = undefined;
    if (route === undefined && observation.destinationReference !== undefined) {
      route = await this.foundation.findRoute(observation.provider,observation.environment,
        observation.providerAccountScope,observation.destinationReference) ?? undefined;
    }

    if (isNegative(observation.state)) {
      if (existingCorrelation === null) return { kind:'UNMATCHED',reason:'NO_ROUTE' };
      const linkedRoute = await this.foundation.getRouteByIntent(observation.provider,observation.environment,existingCorrelation.intentId);
      if (linkedRoute === null || linkedRoute.providerAccountScope !== observation.providerAccountScope) {
        return { kind:'UNMATCHED',reason:'NO_ROUTE' };
      }
      const intent = await this.intents.get(existingCorrelation.intentId);
      if (intent === null) return { kind:'UNMATCHED',reason:'NO_ROUTE' };
      if (isFinancialNegative(observation.state)) {
        await this.recordNegative(observation,existingCorrelation.intentId,intent,existingCorrelation.providerTransactionId);
      }
      await this.writeCheckpoint(observation,existingCorrelation.providerTransactionId);
      return { kind:'NEGATIVE',intentId:intent.intentId,state:observation.state as Exclude<typeof observation.state,'PENDING'|'SETTLED'|'FUNDS_HELD'|'UNKNOWN'> };
    }

    if (route === undefined) return { kind:'UNMATCHED',reason:'NO_ROUTE' };
    if (route.status !== 'ACTIVE' || route.expiresAt !== undefined && observation.observedAt > route.expiresAt) {
      return { kind:'UNMATCHED',reason:'NO_ROUTE' };
    }
    if (observation.destinationReference !== route.destinationReference) return { kind:'UNMATCHED',reason:'DESTINATION_MISMATCH' };
    if (observation.currency !== route.currency) return { kind:'UNMATCHED',reason:'CURRENCY_MISMATCH' };
    if (observation.amount !== route.expectedAmount) return { kind:'UNMATCHED',reason:'AMOUNT_MISMATCH' };
    if (observation.direction !== 'CREDIT') return { kind:'UNMATCHED',reason:'DESTINATION_MISMATCH' };

    const intent = await this.intents.get(route.intentId);
    if (intent === null || !routeMatchesIntent(route,intent)) return { kind:'UNMATCHED',reason:'NO_ROUTE' };
    const correlation = await this.foundation.correlateTransaction({
      provider:observation.provider,environment:observation.environment,
      providerTransactionId:observation.providerTransactionId,providerAccountScope:observation.providerAccountScope,
      intentId:intent.intentId,cellId:String(intent.cellId),createdAt:observation.observedAt,
    });
    if (correlation.kind === 'CONFLICT') return { kind:'UNMATCHED',reason:'TRANSACTION_CONFLICT' };
    await this.writeCheckpoint(observation,observation.providerTransactionId);
    if (observation.state === 'PENDING') return { kind:'PENDING',intentId:intent.intentId };
    if (observation.state === 'SETTLED') return { kind:'SETTLED',intentId:intent.intentId };
    if (observation.state === 'FUNDS_HELD') return { kind:'FUNDS_HELD',intentId:intent.intentId };
    return { kind:'UNKNOWN',intentId:intent.intentId };
  }

  private async recordNegative(observation:FundingObservation,intentId:string,intent:FundingIntent,
    providerTransactionId:string):Promise<void>{
    const kind:ProviderNegativeObservationKind=negativeKind(observation.state);
    await this.foundation.appendNegativeObservation({
      observationId:providerIdentityHash(observation.provider,observation.environment,observation.providerAccountScope,observation.observationId),
      provider:observation.provider,environment:observation.environment,providerAccountScope:observation.providerAccountScope,
      providerObservationId:observation.observationId,providerTransactionId,intentId,
      cellId:String(intent.cellId),kind,amountMinor:makeAmount(observation.amount),currency:observation.currency,
      payloadDigest:observation.rawPayloadDigest,observedAt:observation.observedAt,recordedAt:observation.observedAt,
    });
  }

  private async writeCheckpoint(observation:FundingObservation,providerTransactionId:string):Promise<void>{
    const prior=await this.foundation.getCheckpoint(observation.provider,observation.environment,providerTransactionId,observation.providerAccountScope);
    const state=observation.state as ProviderReconciliationState;
    await this.foundation.putCheckpoint({provider:observation.provider,environment:observation.environment,
      providerTransactionId,providerAccountScope:observation.providerAccountScope,state,attemptCount:(prior?.attemptCount??0)+1,checkedAt:observation.observedAt});
  }
}

function routeMatchesIntent(route:FundingRoute,intent:FundingIntent):boolean{
  return route.intentId===intent.intentId&&route.provider===intent.provider&&route.destinationReference===intent.destinationId
    &&route.currency===intent.currency&&route.expectedAmount===intent.amount;
}
function isNegative(state:FundingObservation['state']):boolean{
  return state==='RETURNED'||state==='REVERSED'||state==='REFUND'||state==='DISPUTE'
    ||state==='FAILED'||state==='CANCELLED'||state==='REFUNDED'||state==='DISPUTED';
}
function isFinancialNegative(state:FundingObservation['state']):boolean{
  return state==='RETURNED'||state==='REVERSED'||state==='REFUND'||state==='DISPUTE'||state==='REFUNDED'||state==='DISPUTED';
}
function negativeKind(state:FundingObservation['state']):ProviderNegativeObservationKind{
  if(state==='RETURNED')return 'RETURNED';
  if(state==='REVERSED')return 'REVERSAL';
  if(state==='DISPUTE'||state==='DISPUTED')return 'DISPUTE';
  return 'REFUND';
}

