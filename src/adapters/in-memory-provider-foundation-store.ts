import type { ProviderEvent, ProviderNegativeObservation, ProviderReconciliationCheckpoint,
  ProviderTransactionCorrelation, ProviderAccountReconciliationCheckpoint, ProviderEventClaim,
  ProviderEventProcessingState } from '../funding/provider-evidence';
import type { FundingObservation, FundingObservationEnvelope, FundingRoute } from '../funding/funding-foundation';
import { hasValidFundingObservation, hasValidFundingRoute } from '../funding/funding-foundation';
import type { ProviderCorrelationResult, ProviderEventRecordResult, ProviderFoundationStore,
  ProviderNegativeObservationResult, FundingRouteCreateResult, FundingObservationRecordResult,
  ProviderEventClaimResult, ProviderEventCompletionResult } from './provider-foundation-store';
import { sameProviderCorrelation, sameProviderEvent, sameProviderNegativeObservation } from './provider-foundation-store';
import { makeTimestamp } from '../core/types';
import type { ProviderNegativeDisposition } from '../funding/types';

export class InMemoryProviderFoundationStore implements ProviderFoundationStore {
  private readonly events: ProviderEvent[] = [];
  private readonly correlations: ProviderTransactionCorrelation[] = [];
  private readonly checkpoints = new Map<string, ProviderReconciliationCheckpoint>();
  private readonly negatives: ProviderNegativeObservation[] = [];
  private readonly dispositions: ProviderNegativeDisposition[] = [];
  private readonly routes: FundingRoute[] = [];
  private readonly observations: FundingObservation[] = [];
  private readonly eventStates = new Map<string, { state: ProviderEventProcessingState; workerId?: string | undefined;
    leaseUntil?: number | undefined; attemptCount: number; errorCategory?: string | undefined }>();
  private readonly accountCheckpoints = new Map<string, ProviderAccountReconciliationCheckpoint>();

  async recordEvent(event: ProviderEvent): Promise<ProviderEventRecordResult> {
    const matches = this.events.filter((item) => item.eventIdentity === event.eventIdentity
      || (item.provider === event.provider && item.environment === event.environment
        && item.replayIdentity === event.replayIdentity));
    const exact = matches.find((item) => sameProviderEvent(item,event));
    if (exact !== undefined) return { kind:'DUPLICATE',event:exact };
    if (matches.some((item) => item.replayIdentity === event.replayIdentity
      && item.payloadDigest !== event.payloadDigest)) return { kind:'REPLAY_PAYLOAD_CONFLICT' };
    if (matches.length > 0) return { kind:'CONFLICTING_DUPLICATE' };
    this.events.push(event);
    this.eventStates.set(event.eventIdentity, { state:'RECEIVED', attemptCount:0 });
    return { kind:'FIRST_SEEN' };
  }

  async getEvent(eventIdentity: string): Promise<ProviderEvent | null> {
    return this.events.find((item) => item.eventIdentity === eventIdentity) ?? null;
  }

  async listClaimableEvents(now:number,limit:number):Promise<ReadonlyArray<string>>{
    return this.events.filter((event)=>{
      const state=this.eventStates.get(event.eventIdentity);
      return state!==undefined&&state.state!=='PROCESSED'&&(state.state!=='CLAIMED'||(state.leaseUntil??0)<=now);
    }).slice(0,Math.max(0,limit)).map((event)=>event.eventIdentity);
  }

  async claimEvent(eventIdentity: string, workerId: string, now: number, leaseMs: number): Promise<ProviderEventClaimResult> {
    const state = this.eventStates.get(eventIdentity);
    if (state === undefined) return { kind:'NOT_FOUND' };
    if (state.state === 'PROCESSED') return { kind:'PROCESSED' };
    if (state.state === 'CLAIMED' && (state.leaseUntil ?? 0) > now) return { kind:'BUSY' };
    state.state = 'CLAIMED'; state.workerId = workerId; state.leaseUntil = now + leaseMs;
    state.attemptCount += 1;
    return { kind:'CLAIMED', claim:{ eventIdentity,workerId,leaseUntil:makeTimestamp(state.leaseUntil),attemptCount:state.attemptCount } };
  }

  async completeEvent(eventIdentity: string, workerId: string, _now: number): Promise<ProviderEventCompletionResult> {
    const state = this.eventStates.get(eventIdentity);
    if (state === undefined) return 'NOT_FOUND';
    if (state.state === 'PROCESSED') return 'PROCESSED';
    if (state.state !== 'CLAIMED' || state.workerId !== workerId) return 'NOT_CLAIMED';
    state.state = 'PROCESSED'; delete state.workerId; delete state.leaseUntil;
    return 'PROCESSED';
  }

  async failEvent(eventIdentity: string, workerId: string, _now: number, errorCategory: string): Promise<ProviderEventCompletionResult> {
    const state = this.eventStates.get(eventIdentity);
    if (state === undefined) return 'NOT_FOUND';
    if (state.state === 'PROCESSED') return 'PROCESSED';
    if (state.state !== 'CLAIMED' || state.workerId !== workerId) return 'NOT_CLAIMED';
    state.state = 'FAILED'; state.errorCategory = errorCategory;
    delete state.workerId; delete state.leaseUntil;
    return 'FAILED';
  }

  async correlateTransaction(value: ProviderTransactionCorrelation): Promise<ProviderCorrelationResult> {
    const matches = this.correlations.filter((item) => item.provider === value.provider
      && item.environment === value.environment
      && scope(item.providerAccountScope) === scope(value.providerAccountScope)
      && (item.providerTransactionId === value.providerTransactionId || item.intentId === value.intentId));
    if (matches.length === 0) { this.correlations.push(value); return { kind:'RECORDED' }; }
    return matches.length === 1 && sameProviderCorrelation(matches[0]!,value)
      ? { kind:'DUPLICATE',correlation:matches[0]! } : { kind:'CONFLICT' };
  }

  async getCorrelation(provider: string, environment: string,
    providerTransactionId: string, providerAccountScope='DEFAULT'): Promise<ProviderTransactionCorrelation | null> {
    return this.correlations.find((item) => item.provider === provider && item.environment === environment
      && scope(item.providerAccountScope) === scope(providerAccountScope)
      && item.providerTransactionId === providerTransactionId) ?? null;
  }

  async createRoute(route: FundingRoute): Promise<FundingRouteCreateResult> {
    if (!hasValidFundingRoute(route)) return { kind:'CONFLICT' };
    const matches = this.routes.filter((item) => item.routeId === route.routeId
      || (item.provider === route.provider && item.environment === route.environment && item.intentId === route.intentId)
      || (item.provider === route.provider && item.environment === route.environment
        && item.providerAccountScope===route.providerAccountScope && item.destinationReference===route.destinationReference));
    if (matches.length === 0) { this.routes.push(Object.freeze({ ...route })); return { kind:'CREATED' }; }
    const exact = matches.find((item) => sameRoute(item,route));
    return exact === undefined ? { kind:'CONFLICT' } : { kind:'DUPLICATE',route:exact };
  }

  async getRouteByIntent(provider: string, environment: string, intentId: string): Promise<FundingRoute | null> {
    return this.routes.find((item) => item.provider === provider && item.environment === environment
      && item.intentId === intentId) ?? null;
  }

  async findRoute(provider: string, environment: string, providerAccountScope: string,
    destinationReference: string): Promise<FundingRoute | null> {
    return this.routes.find((item) => item.provider === provider && item.environment === environment
      && item.providerAccountScope === providerAccountScope && item.destinationReference === destinationReference) ?? null;
  }

  async recordObservation(observation: FundingObservation): Promise<FundingObservationRecordResult> {
    if (!hasValidFundingObservation(observation)) return { kind:'CONFLICT' };
    const matches = this.observations.filter((item) => item.provider === observation.provider
      && item.environment === observation.environment && item.providerAccountScope === observation.providerAccountScope
      && (item.observationId === observation.observationId || item.providerTransactionId === observation.providerTransactionId
        && item.observationId === observation.observationId));
    if (matches.length === 0) { this.observations.push(Object.freeze({ ...observation })); return { kind:'RECORDED' }; }
    const exact = matches.find((item) => sameObservation(item,observation));
    return exact === undefined ? { kind:'CONFLICT' }
      : { kind:'DUPLICATE',observation:this.envelope(exact) };
  }

  async getObservation(provider: string, environment: string, providerAccountScope: string,
    observationId: string): Promise<FundingObservationEnvelope | null> {
    const observation = this.observations.find((item) => item.provider === provider && item.environment === environment
      && item.providerAccountScope === providerAccountScope && item.observationId === observationId);
    return observation === undefined ? null : this.envelope(observation);
  }

  async listUnmatchedObservations(provider: string, environment: string, providerAccountScope: string,
    limit: number): Promise<ReadonlyArray<FundingObservationEnvelope>> {
    return this.observations.filter((item) => item.provider === provider && item.environment === environment
      && item.providerAccountScope === providerAccountScope && this.getCorrelationSync(item) === null)
      .slice(0,Math.max(0,limit)).map((item) => this.envelope(item));
  }

  async putCheckpoint(value: ProviderReconciliationCheckpoint): Promise<void> {
    const k = checkpointKey(value.provider,value.environment,value.providerAccountScope??'DEFAULT',value.providerTransactionId);
    const existing = this.checkpoints.get(k);
    if (existing !== undefined && (value.checkedAt < existing.checkedAt
      || checkpointRank(value.state) < checkpointRank(existing.state))) return;
    this.checkpoints.set(k,value);
  }

  async putAccountCheckpoint(value: ProviderAccountReconciliationCheckpoint): Promise<boolean> {
    const k = key(value.provider,value.environment,value.providerAccountScope);
    const existing = this.accountCheckpoints.get(k);
    if (existing !== undefined && sameAccountCheckpoint(existing,value)) return true;
    const expectedRevision = existing === undefined ? 1 : existing.revision + 1;
    if (value.revision !== expectedRevision || existing !== undefined && value.checkedAt < existing.checkedAt) return false;
    this.accountCheckpoints.set(k,Object.freeze({ ...value })); return true;
  }

  async getAccountCheckpoint(provider: string, environment: string,
    providerAccountScope: string): Promise<ProviderAccountReconciliationCheckpoint | null> {
    return this.accountCheckpoints.get(key(provider,environment,providerAccountScope)) ?? null;
  }
  async getCheckpoint(provider: string, environment: string,
    providerTransactionId: string, providerAccountScope='DEFAULT'): Promise<ProviderReconciliationCheckpoint | null> {
    return this.checkpoints.get(checkpointKey(provider,environment,providerAccountScope,providerTransactionId)) ?? null;
  }
  async appendNegativeObservation(value: ProviderNegativeObservation):
    Promise<ProviderNegativeObservationResult> {
    const matches = this.negatives.filter((item) => item.observationId === value.observationId
      || (item.provider === value.provider && item.environment === value.environment
        && scope(item.providerAccountScope)===scope(value.providerAccountScope)
        && item.providerObservationId === value.providerObservationId));
    if (matches.length === 0) { this.negatives.push(value); return { kind:'RECORDED' }; }
    const exact = matches.find((item) => sameProviderNegativeObservation(item,value));
    return exact === undefined ? { kind:'CONFLICT' } : { kind:'DUPLICATE',observation:exact };
  }
  async getNegativeObservation(observationId: string): Promise<ProviderNegativeObservation | null> {
    return this.negatives.find((item) => item.observationId === observationId) ?? null;
  }

  async appendNegativeDisposition(value: ProviderNegativeDisposition): Promise<'RECORDED'|'DUPLICATE'|'CONFLICT'> {
    const source = this.negatives.find((item) => item.observationId === value.sourceNegativeObservationId);
    if (source === undefined || source.provider !== value.provider || source.environment !== value.environment
      || scope(source.providerAccountScope) !== value.providerAccountScope
      || source.providerObservationId !== value.providerObservationId
      || source.providerTransactionId !== value.providerTransactionId || source.intentId !== value.intentId
      || source.receiptId !== value.receiptId || source.cellId !== value.cellId) return 'CONFLICT';
    const series = this.dispositions.filter((item) => item.sourceNegativeObservationId === value.sourceNegativeObservationId);
    const sameVersion = series.find((item) => item.version === value.version);
    if (sameVersion !== undefined) return JSON.stringify(sameVersion, bigintJson) === JSON.stringify(value, bigintJson)
      ? 'DUPLICATE' : 'CONFLICT';
    if (value.version !== BigInt(series.length + 1) || ((value.status === 'PENDING') !== (value.outcome === 'PENDING'))) return 'CONFLICT';
    if (value.outcome === 'FUNDS_RETAINED' && (source.amountMinor === undefined || source.currency !== value.currency
      || source.amountMinor !== value.amount)) return 'CONFLICT';
    this.dispositions.push(Object.freeze({ ...value })); return 'RECORDED';
  }

  async listNegativeDispositions(cellId: string): Promise<ReadonlyArray<ProviderNegativeDisposition>> {
    return this.dispositions.filter((item) => item.cellId === cellId);
  }

  hasBlockingNegativeForCell(cellId: string): boolean {
    return this.negatives.some((item) => {
      if (item.cellId !== cellId) return false;
      const latest = this.dispositions.filter((d) => d.sourceNegativeObservationId === item.observationId)
        .sort((a,b) => a.version > b.version ? -1 : 1)[0];
      return latest === undefined || !(['RESOLVED','CLOSED'].includes(latest.status)
        && latest.outcome === 'FUNDS_RETAINED');
    });
  }

  private getCorrelationSync(observation: FundingObservation): ProviderTransactionCorrelation | null {
    return this.correlations.find((item) => item.provider === observation.provider
      && item.environment === observation.environment && scope(item.providerAccountScope)===scope(observation.providerAccountScope)
      && item.providerTransactionId === (observation.relatedProviderTransactionId
        ?? observation.providerTransactionId)) ?? null;
  }
  private envelope(observation: FundingObservation): FundingObservationEnvelope {
    const correlation = this.getCorrelationSync(observation);
    return { observation,correlationStatus:correlation === null ? 'UNMATCHED' : 'MATCHED',
      ...(correlation === null ? {} : { intentId:correlation.intentId }) };
  }
}
function key(provider:string, environment:string, transaction:string): string {
  return `${provider.length}:${provider}${environment.length}:${environment}${transaction.length}:${transaction}`;
}
function checkpointKey(provider:string,environment:string,scopeValue:string,transaction:string):string{
  return `${key(provider,environment,scopeValue)}${transaction.length}:${transaction}`;
}
function scope(value:string|undefined):string{return value??'DEFAULT';}
function sameRoute(a:FundingRoute,b:FundingRoute):boolean {
  return a.routeId===b.routeId && a.intentId===b.intentId && a.provider===b.provider
    && a.environment===b.environment && a.providerAccountScope===b.providerAccountScope
    && a.destinationReference===b.destinationReference && a.currency===b.currency
    && a.expectedAmount===b.expectedAmount && a.status===b.status && a.createdAt===b.createdAt
    && a.expiresAt===b.expiresAt;
}
function sameObservation(a:FundingObservation,b:FundingObservation):boolean {
  return a.observationId===b.observationId && a.provider===b.provider && a.environment===b.environment
    && a.providerAccountScope===b.providerAccountScope && a.providerTransactionId===b.providerTransactionId
    && a.relatedProviderTransactionId===b.relatedProviderTransactionId
    && a.direction===b.direction && a.amount===b.amount && a.currency===b.currency
    && a.observedAt===b.observedAt && a.bookedAt===b.bookedAt
    && a.destinationReference===b.destinationReference && a.rawPayloadDigest===b.rawPayloadDigest
    && a.state===b.state;
}
function sameAccountCheckpoint(a:ProviderAccountReconciliationCheckpoint,b:ProviderAccountReconciliationCheckpoint):boolean{
  return a.provider===b.provider&&a.environment===b.environment&&a.providerAccountScope===b.providerAccountScope
    &&a.cursor===b.cursor&&a.pageToken===b.pageToken&&a.statementSequence===b.statementSequence
    &&a.lastObservedAt===b.lastObservedAt&&a.checkedAt===b.checkedAt&&a.revision===b.revision;
}
function checkpointRank(state:ProviderReconciliationCheckpoint['state']):number {
  if (state==='PENDING' || state==='UNKNOWN') return 0;
  if (state==='SETTLED' || state==='FUNDS_HELD') return 1;
  return 2;
}
function bigintJson(_key:string,value:unknown):unknown{return typeof value==='bigint'?value.toString():value;}
