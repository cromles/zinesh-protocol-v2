import type { Pool } from 'pg';
import { makeAmount, makeTimestamp } from '../core/types';
import type { Currency } from '../core/types';
import type { ProviderEnvironment, ProviderEvent, ProviderNegativeObservation,
  ProviderNegativeObservationKind, ProviderReconciliationCheckpoint,
  ProviderReconciliationState, ProviderTransactionCorrelation, ProviderAccountReconciliationCheckpoint,
  ProviderEventClaim } from '../funding/provider-evidence';
import type { FundingObservation, FundingObservationEnvelope, FundingRoute } from '../funding/funding-foundation';
import type { ProviderNegativeDisposition } from '../funding/types';
import { hasValidFundingObservation, hasValidFundingRoute } from '../funding/funding-foundation';
import { providerIdentityHash } from '../funding/provider-identity';
import type { ProviderCorrelationResult, ProviderEventRecordResult, ProviderFoundationStore,
  ProviderNegativeObservationResult, FundingRouteCreateResult, FundingObservationRecordResult,
  ProviderEventClaimResult, ProviderEventCompletionResult } from './provider-foundation-store';
import { sameProviderCorrelation, sameProviderEvent, sameProviderNegativeObservation } from './provider-foundation-store';

interface EventRow { event_identity: string; replay_identity: string; provider: string;
  environment: ProviderEnvironment; provider_event_id: string | null; provider_payment_id: string | null;
  provider_transaction_id: string; intent_id: string | null; receipt_id: string | null; cell_id: string | null;
  event_type: string; payload_digest: string; normalized_evidence_digest: string | null;
  received_at: string }
interface CorrelationRow { provider: string; environment: ProviderEnvironment;
  provider_account_scope: string; provider_transaction_id: string; provider_payment_id: string | null; intent_id: string;
  receipt_id: string | null; cell_id: string; created_at: string }
interface CheckpointRow { provider: string; environment: ProviderEnvironment;
  provider_account_scope: string; provider_transaction_id: string; state: ProviderReconciliationState;
  normalized_evidence_digest: string | null; last_event_identity: string | null;
  attempt_count: number; checked_at: string; next_attempt_at: string | null;
  last_error_category: string | null }
interface NegativeRow { observation_id: string; provider: string; environment: ProviderEnvironment; provider_account_scope: string;
  provider_observation_id: string; provider_transaction_id: string; intent_id: string;
  receipt_id: string | null; cell_id: string | null; kind: ProviderNegativeObservationKind;
  amount_minor: string | null; currency: string | null; payload_digest: string;
  observed_at: string; recorded_at: string }
interface DispositionRow { resolution_id:string; source_negative_observation_id:string; provider:string; environment:ProviderEnvironment;
  provider_account_scope:string; provider_observation_id:string; provider_transaction_id:string; intent_id:string;
  receipt_id:string; cell_id:string; amount:string; currency:string; disposition_status:string; outcome:string; version:string;
  evidence_reference:string; evidence_digest:string; observed_at:string; recorded_at:string; resolver_principal_id:string;
  resolver_capability:'RESOLVE_FUNDING_NEGATIVE' }
interface RouteRow { route_id:string; intent_id:string; provider:string; environment:ProviderEnvironment;
  provider_account_scope:string; destination_reference:string; currency:string; expected_amount:string;
  status:FundingRoute['status']; created_at:string; expires_at:string|null }
interface ObservationRow { provider:string; environment:ProviderEnvironment; provider_account_scope:string;
  observation_id:string; provider_transaction_id:string; related_provider_transaction_id:string|null;
  direction:FundingObservation['direction'];
  amount_minor:string; currency:string; observed_at:string; booked_at:string|null;
  destination_reference:string|null; raw_payload_digest:string; state:FundingObservation['state'] }
interface ProcessingRow { state:'RECEIVED'|'CLAIMED'|'PROCESSED'|'FAILED'; worker_id:string|null;
  lease_until:string|null; attempt_count:number }
interface AccountCheckpointRow { provider:string; environment:ProviderEnvironment; provider_account_scope:string;
  cursor:string|null; page_token:string|null; statement_sequence:string|null; last_observed_at:string|null;
  checked_at:string; revision:number }

export class PostgresProviderFoundationStore implements ProviderFoundationStore {
  constructor(private readonly pool: Pool) {}

  async recordEvent(event: ProviderEvent): Promise<ProviderEventRecordResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [providerIdentityHash(event.provider, event.environment, event.replayIdentity)]);
      const inserted = await client.query(
        `INSERT INTO provider_event_inbox(event_identity,replay_identity,provider,environment,
          provider_event_id,provider_payment_id,provider_transaction_id,intent_id,receipt_id,cell_id,
          event_type,payload_digest,normalized_evidence_digest,received_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT DO NOTHING RETURNING event_identity`,
        [event.eventIdentity,event.replayIdentity,event.provider,event.environment,event.providerEventId ?? null,
          event.providerPaymentId,event.providerTransactionId,event.intentId,event.receiptId ?? null,
          event.cellId ?? null,event.eventType,event.payloadDigest,event.normalizedEvidenceDigest ?? null,
          event.receivedAt],
      );
      if (inserted.rowCount === 1) {
        await client.query(`INSERT INTO provider_event_processing(event_identity,state,attempt_count,updated_at)
          VALUES($1,'RECEIVED',0,$2)`, [event.eventIdentity,event.receivedAt]);
        await client.query('COMMIT'); return { kind: 'FIRST_SEEN' };
      }
      const rows = await client.query<EventRow>(`SELECT * FROM provider_event_inbox
        WHERE event_identity=$1 OR (provider=$2 AND environment=$3 AND replay_identity=$4)`,
      [event.eventIdentity,event.provider,event.environment,event.replayIdentity]);
      await client.query('COMMIT');
      const exact = rows.rows.map(rowToEvent).find((candidate) => sameProviderEvent(candidate,event));
      if (exact !== undefined) return { kind: 'DUPLICATE', event: exact };
      if (rows.rows.some((row) => row.provider === event.provider && row.environment === event.environment
        && row.replay_identity === event.replayIdentity && row.payload_digest !== event.payloadDigest)) {
        return { kind: 'REPLAY_PAYLOAD_CONFLICT' };
      }
      return { kind: 'CONFLICTING_DUPLICATE' };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async getEvent(eventIdentity: string): Promise<ProviderEvent | null> {
    const result = await this.pool.query<EventRow>('SELECT * FROM provider_event_inbox WHERE event_identity=$1',[eventIdentity]);
    return result.rows[0] === undefined ? null : rowToEvent(result.rows[0]);
  }

  async listClaimableEvents(now:number,limit:number):Promise<ReadonlyArray<string>>{
    const result=await this.pool.query<{event_identity:string}>(`SELECT event_identity FROM provider_event_processing
      WHERE state IN ('RECEIVED','FAILED') OR (state='CLAIMED' AND lease_until<=$1)
      ORDER BY updated_at,event_identity LIMIT $2`,[now,Math.max(0,limit)]);
    return result.rows.map((row)=>row.event_identity);
  }

  async claimEvent(eventIdentity: string, workerId: string, now: number, leaseMs: number): Promise<ProviderEventClaimResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query<ProcessingRow>(`UPDATE provider_event_processing SET
          state='CLAIMED',worker_id=$2,lease_until=$4,attempt_count=attempt_count+1,updated_at=$3,error_category=NULL
        WHERE event_identity=$1 AND state<>'PROCESSED'
          AND (state<>'CLAIMED' OR lease_until<=$3)
        RETURNING state,worker_id,lease_until,attempt_count`,
      [eventIdentity,workerId,now,now+leaseMs]);
      if (claimed.rowCount === 1) {
        const row=claimed.rows[0]!;
        await client.query('COMMIT');
        const claim:ProviderEventClaim={eventIdentity,workerId,leaseUntil:makeTimestamp(Number(row.lease_until)),attemptCount:row.attempt_count};
        return {kind:'CLAIMED',claim};
      }
      const existing=await client.query<ProcessingRow>('SELECT state,worker_id,lease_until,attempt_count FROM provider_event_processing WHERE event_identity=$1',[eventIdentity]);
      await client.query('COMMIT');
      const row=existing.rows[0];
      if(row===undefined)return {kind:'NOT_FOUND'};
      return row.state==='PROCESSED'?{kind:'PROCESSED'}:{kind:'BUSY'};
    } catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
  }

  async completeEvent(eventIdentity:string,workerId:string,now:number):Promise<ProviderEventCompletionResult>{
    return this.finishEvent(eventIdentity,workerId,now,'PROCESSED',undefined);
  }

  async failEvent(eventIdentity:string,workerId:string,now:number,errorCategory:string):Promise<ProviderEventCompletionResult>{
    return this.finishEvent(eventIdentity,workerId,now,'FAILED',errorCategory);
  }

  private async finishEvent(eventIdentity:string,workerId:string,now:number,
    state:'PROCESSED'|'FAILED',errorCategory:string|undefined):Promise<ProviderEventCompletionResult>{
    const updated=await this.pool.query(`UPDATE provider_event_processing SET state=$3,worker_id=NULL,
      lease_until=NULL,updated_at=$4,error_category=$5 WHERE event_identity=$1 AND worker_id=$2 AND state='CLAIMED'`,
    [eventIdentity,workerId,state,now,errorCategory??null]);
    if(updated.rowCount===1)return state;
    const existing=await this.pool.query<{state:string}>('SELECT state FROM provider_event_processing WHERE event_identity=$1',[eventIdentity]);
    if(existing.rows[0]===undefined)return 'NOT_FOUND';
    return existing.rows[0].state==='PROCESSED'?'PROCESSED':'NOT_CLAIMED';
  }

  async correlateTransaction(value: ProviderTransactionCorrelation): Promise<ProviderCorrelationResult> {
    const inserted = await this.pool.query(`INSERT INTO provider_transaction_correlations
      (provider,environment,provider_account_scope,provider_transaction_id,provider_payment_id,intent_id,receipt_id,cell_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING provider`,
    [value.provider,value.environment,value.providerAccountScope ?? 'DEFAULT',value.providerTransactionId,
      value.providerPaymentId ?? null,value.intentId,value.receiptId ?? null,value.cellId,value.createdAt]);
    if (inserted.rowCount === 1) return { kind: 'RECORDED' };
    const existing = await this.pool.query<CorrelationRow>(`SELECT * FROM provider_transaction_correlations
      WHERE provider=$1 AND environment=$2 AND provider_account_scope=$3
        AND (provider_transaction_id=$4 OR intent_id=$5)`,
    [value.provider,value.environment,value.providerAccountScope ?? 'DEFAULT',value.providerTransactionId,value.intentId]);
    const matches = existing.rows.map(rowToCorrelation);
    return matches.length === 1 && sameProviderCorrelation(matches[0]!,value)
      ? { kind: 'DUPLICATE', correlation: matches[0]! } : { kind: 'CONFLICT' };
  }

  async getCorrelation(provider:string,environment:string,providerTransactionId:string,
    providerAccountScope='DEFAULT'):Promise<ProviderTransactionCorrelation|null>{
    const result=await this.pool.query<CorrelationRow>(`SELECT * FROM provider_transaction_correlations
      WHERE provider=$1 AND environment=$2 AND provider_account_scope=$3 AND provider_transaction_id=$4`,
    [provider,environment,providerAccountScope,providerTransactionId]);
    return result.rows[0]===undefined?null:rowToCorrelation(result.rows[0]);
  }

  async createRoute(route:FundingRoute):Promise<FundingRouteCreateResult>{
    if(!hasValidFundingRoute(route))return {kind:'CONFLICT'};
    const inserted=await this.pool.query(`INSERT INTO funding_routes(route_id,intent_id,provider,environment,
      provider_account_scope,destination_reference,currency,expected_amount,status,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING route_id`,
    [route.routeId,route.intentId,route.provider,route.environment,route.providerAccountScope,
      route.destinationReference,route.currency,route.expectedAmount.toString(),route.status,route.createdAt,route.expiresAt??null]);
    if(inserted.rowCount===1)return {kind:'CREATED'};
    const existing=await this.pool.query<RouteRow>(`SELECT * FROM funding_routes WHERE route_id=$1
      OR (provider=$2 AND environment=$3 AND intent_id=$4)`,[route.routeId,route.provider,route.environment,route.intentId]);
    const exact=existing.rows.map(rowToRoute).find((item)=>sameRoute(item,route));
    return exact===undefined?{kind:'CONFLICT'}:{kind:'DUPLICATE',route:exact};
  }

  async getRouteByIntent(provider:string,environment:string,intentId:string):Promise<FundingRoute|null>{
    const result=await this.pool.query<RouteRow>('SELECT * FROM funding_routes WHERE provider=$1 AND environment=$2 AND intent_id=$3',[provider,environment,intentId]);
    return result.rows[0]===undefined?null:rowToRoute(result.rows[0]);
  }

  async findRoute(provider:string,environment:string,providerAccountScope:string,destinationReference:string):Promise<FundingRoute|null>{
    const result=await this.pool.query<RouteRow>(`SELECT * FROM funding_routes WHERE provider=$1 AND environment=$2
      AND provider_account_scope=$3 AND destination_reference=$4`,[provider,environment,providerAccountScope,destinationReference]);
    return result.rows[0]===undefined?null:rowToRoute(result.rows[0]);
  }

  async recordObservation(observation:FundingObservation):Promise<FundingObservationRecordResult>{
    if(!hasValidFundingObservation(observation))return {kind:'CONFLICT'};
    const inserted=await this.pool.query(`INSERT INTO provider_funding_observations(provider,environment,
      provider_account_scope,observation_id,provider_transaction_id,related_provider_transaction_id,direction,
      amount_minor,currency,observed_at,booked_at,destination_reference,raw_payload_digest,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING RETURNING observation_id`,
    [observation.provider,observation.environment,observation.providerAccountScope,observation.observationId,
      observation.providerTransactionId,observation.relatedProviderTransactionId??null,observation.direction,
      observation.amount.toString(),observation.currency,observation.observedAt,observation.bookedAt??null,
      observation.destinationReference??null,observation.rawPayloadDigest,observation.state]);
    if(inserted.rowCount===1)return {kind:'RECORDED'};
    const result=await this.pool.query<ObservationRow>(`SELECT * FROM provider_funding_observations WHERE
      provider=$1 AND environment=$2 AND provider_account_scope=$3 AND observation_id=$4`,
    [observation.provider,observation.environment,observation.providerAccountScope,observation.observationId]);
    const existing=result.rows[0]===undefined?null:rowToObservation(result.rows[0]);
    return existing===null||!sameObservation(existing,observation)?{kind:'CONFLICT'}
      :{kind:'DUPLICATE',observation:await this.observationEnvelope(existing)};
  }

  async getObservation(provider:string,environment:string,providerAccountScope:string,observationId:string):Promise<FundingObservationEnvelope|null>{
    const result=await this.pool.query<ObservationRow>(`SELECT * FROM provider_funding_observations WHERE
      provider=$1 AND environment=$2 AND provider_account_scope=$3 AND observation_id=$4`,
    [provider,environment,providerAccountScope,observationId]);
    return result.rows[0]===undefined?null:this.observationEnvelope(rowToObservation(result.rows[0]));
  }

  async listUnmatchedObservations(provider:string,environment:string,providerAccountScope:string,limit:number):Promise<ReadonlyArray<FundingObservationEnvelope>>{
    const result=await this.pool.query<ObservationRow>(`SELECT o.* FROM provider_funding_observations o
      WHERE o.provider=$1 AND o.environment=$2 AND o.provider_account_scope=$3
      AND NOT EXISTS (SELECT 1 FROM provider_transaction_correlations c WHERE c.provider=o.provider
        AND c.environment=o.environment AND c.provider_account_scope=o.provider_account_scope
        AND c.provider_transaction_id=COALESCE(o.related_provider_transaction_id,o.provider_transaction_id))
      ORDER BY o.observed_at,o.observation_id LIMIT $4`,[provider,environment,providerAccountScope,Math.max(0,limit)]);
    return Promise.all(result.rows.map((row)=>this.observationEnvelope(rowToObservation(row))));
  }

  private async observationEnvelope(observation:FundingObservation):Promise<FundingObservationEnvelope>{
    const correlation=await this.getCorrelation(observation.provider,observation.environment,
      observation.relatedProviderTransactionId??observation.providerTransactionId,observation.providerAccountScope);
    return {observation,correlationStatus:correlation===null?'UNMATCHED':'MATCHED',
      ...(correlation===null?{}:{intentId:correlation.intentId})};
  }

  async putCheckpoint(value: ProviderReconciliationCheckpoint): Promise<void> {
    await this.pool.query(`INSERT INTO provider_reconciliation_checkpoints
      (provider,environment,provider_account_scope,provider_transaction_id,state,normalized_evidence_digest,last_event_identity,
       attempt_count,checked_at,next_attempt_at,last_error_category)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(provider,environment,provider_account_scope,provider_transaction_id) DO UPDATE SET
       state=EXCLUDED.state,normalized_evidence_digest=EXCLUDED.normalized_evidence_digest,
       last_event_identity=EXCLUDED.last_event_identity,attempt_count=EXCLUDED.attempt_count,
       checked_at=EXCLUDED.checked_at,next_attempt_at=EXCLUDED.next_attempt_at,
       last_error_category=EXCLUDED.last_error_category
      WHERE provider_reconciliation_checkpoints.checked_at<=EXCLUDED.checked_at
        AND CASE WHEN provider_reconciliation_checkpoints.state IN ('PENDING','UNKNOWN') THEN 0
          WHEN provider_reconciliation_checkpoints.state IN ('SETTLED','FUNDS_HELD') THEN 1 ELSE 2 END
        <= CASE WHEN EXCLUDED.state IN ('PENDING','UNKNOWN') THEN 0
          WHEN EXCLUDED.state IN ('SETTLED','FUNDS_HELD') THEN 1 ELSE 2 END`,
    [value.provider,value.environment,value.providerAccountScope ?? 'DEFAULT',value.providerTransactionId,value.state,
      value.normalizedEvidenceDigest ?? null,value.lastEventIdentity ?? null,value.attemptCount,
      value.checkedAt,value.nextAttemptAt ?? null,value.lastErrorCategory ?? null]);
  }

  async putAccountCheckpoint(value:ProviderAccountReconciliationCheckpoint):Promise<boolean>{
    const result=await this.pool.query(`INSERT INTO provider_account_reconciliation_checkpoints(provider,environment,
      provider_account_scope,cursor,page_token,statement_sequence,last_observed_at,checked_at,revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(provider,environment,provider_account_scope) DO UPDATE SET cursor=EXCLUDED.cursor,
        page_token=EXCLUDED.page_token,statement_sequence=EXCLUDED.statement_sequence,
        last_observed_at=EXCLUDED.last_observed_at,checked_at=EXCLUDED.checked_at,revision=EXCLUDED.revision
      WHERE provider_account_reconciliation_checkpoints.revision=EXCLUDED.revision-1
        AND provider_account_reconciliation_checkpoints.checked_at<=EXCLUDED.checked_at
      RETURNING revision`,[value.provider,value.environment,value.providerAccountScope,value.cursor??null,
        value.pageToken??null,value.statementSequence??null,value.lastObservedAt??null,value.checkedAt,value.revision]);
    if(result.rowCount===1)return true;
    const current=await this.getAccountCheckpoint(value.provider,value.environment,value.providerAccountScope);
    return current!==null&&sameAccountCheckpoint(current,value);
  }

  async getAccountCheckpoint(provider:string,environment:string,providerAccountScope:string):Promise<ProviderAccountReconciliationCheckpoint|null>{
    const result=await this.pool.query<AccountCheckpointRow>(`SELECT * FROM provider_account_reconciliation_checkpoints
      WHERE provider=$1 AND environment=$2 AND provider_account_scope=$3`,[provider,environment,providerAccountScope]);
    const row=result.rows[0];
    return row===undefined?null:{provider:row.provider,environment:row.environment,providerAccountScope:row.provider_account_scope,
      cursor:row.cursor??undefined,pageToken:row.page_token??undefined,statementSequence:row.statement_sequence??undefined,
      lastObservedAt:row.last_observed_at===null?undefined:makeTimestamp(Number(row.last_observed_at)),
      checkedAt:makeTimestamp(Number(row.checked_at)),revision:row.revision};
  }

  async getCheckpoint(provider: string, environment: string,
    providerTransactionId: string,providerAccountScope='DEFAULT'): Promise<ProviderReconciliationCheckpoint | null> {
    const result = await this.pool.query<CheckpointRow>(`SELECT * FROM provider_reconciliation_checkpoints
      WHERE provider=$1 AND environment=$2 AND provider_account_scope=$3 AND provider_transaction_id=$4`,
    [provider,environment,providerAccountScope,providerTransactionId]);
    const row = result.rows[0];
    return row === undefined ? null : { provider:row.provider,environment:row.environment,
      providerAccountScope:row.provider_account_scope,
      providerTransactionId:row.provider_transaction_id,state:row.state,
      normalizedEvidenceDigest:row.normalized_evidence_digest ?? undefined,
      lastEventIdentity:row.last_event_identity ?? undefined,attemptCount:row.attempt_count,
      checkedAt:makeTimestamp(Number(row.checked_at)),
      nextAttemptAt:row.next_attempt_at === null ? undefined : makeTimestamp(Number(row.next_attempt_at)),
      lastErrorCategory:row.last_error_category ?? undefined };
  }

  async appendNegativeObservation(value: ProviderNegativeObservation):
    Promise<ProviderNegativeObservationResult> {
    const client = await this.pool.connect();
    try {
    await client.query('BEGIN');
    if (value.cellId !== undefined) await client.query(
      'SELECT receipt_id FROM funding_receipts WHERE cell_id=$1 FOR UPDATE',[value.cellId]);
    const inserted = await client.query(`INSERT INTO provider_negative_observations
      (observation_id,provider,environment,provider_account_scope,provider_observation_id,provider_transaction_id,intent_id,
       receipt_id,cell_id,kind,amount_minor,currency,payload_digest,observed_at,recorded_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT DO NOTHING RETURNING observation_id`,
    [value.observationId,value.provider,value.environment,value.providerAccountScope ?? 'DEFAULT',value.providerObservationId,
      value.providerTransactionId,value.intentId,value.receiptId ?? null,value.cellId ?? null,value.kind,
      value.amountMinor?.toString() ?? null,value.currency ?? null,value.payloadDigest,value.observedAt,
      value.recordedAt]);
    if (inserted.rowCount === 1) { await client.query('COMMIT'); return { kind: 'RECORDED' }; }
    const existing = await client.query<NegativeRow>(`SELECT * FROM provider_negative_observations
      WHERE observation_id=$1 OR (provider=$2 AND environment=$3 AND provider_account_scope=$4 AND provider_observation_id=$5)`,
    [value.observationId,value.provider,value.environment,value.providerAccountScope ?? 'DEFAULT',value.providerObservationId]);
    const rows = existing.rows.map(rowToNegative);
    const exact = rows.find((item) => sameProviderNegativeObservation(item,value));
    await client.query('COMMIT');
    return exact === undefined ? { kind:'CONFLICT' } : { kind:'DUPLICATE',observation:exact };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async getNegativeObservation(observationId: string): Promise<ProviderNegativeObservation | null> {
    const result = await this.pool.query<NegativeRow>('SELECT * FROM provider_negative_observations WHERE observation_id=$1', [observationId]);
    return result.rows[0] === undefined ? null : rowToNegative(result.rows[0]);
  }

  async appendNegativeDisposition(value: ProviderNegativeDisposition): Promise<'RECORDED'|'DUPLICATE'|'CONFLICT'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT receipt_id FROM funding_receipts WHERE receipt_id=$1 FOR UPDATE', [value.receiptId]);
      const source = await client.query(`SELECT * FROM provider_negative_observations WHERE observation_id=$1 FOR SHARE`,
        [value.sourceNegativeObservationId]);
      const sourceRow = source.rows[0] as NegativeRow | undefined;
      if (sourceRow === undefined) { await client.query('ROLLBACK'); return 'CONFLICT'; }
      const negative = rowToNegative(sourceRow);
      if (negative.provider !== value.provider || negative.environment !== value.environment
        || (negative.providerAccountScope ?? 'DEFAULT') !== value.providerAccountScope
        || negative.providerObservationId !== value.providerObservationId
        || negative.providerTransactionId !== value.providerTransactionId || negative.intentId !== value.intentId
        || negative.receiptId !== value.receiptId || negative.cellId !== value.cellId) {
        await client.query('ROLLBACK'); return 'CONFLICT';
      }
      const byId = await client.query<DispositionRow>('SELECT * FROM provider_negative_dispositions WHERE resolution_id=$1', [value.resolutionId]);
      if (byId.rows[0] !== undefined) {
        const exact = sameDispositionRow(byId.rows[0], value);
        await client.query('COMMIT'); return exact ? 'DUPLICATE' : 'CONFLICT';
      }
      const latest = await client.query<{version:string}>('SELECT COALESCE(MAX(version),0)::text AS version FROM provider_negative_dispositions WHERE source_negative_observation_id=$1', [value.sourceNegativeObservationId]);
      const expected = BigInt(latest.rows[0]!.version) + 1n;
      if (value.version !== expected || ((value.status === 'PENDING') !== (value.outcome === 'PENDING'))
        || value.outcome === 'FUNDS_RETAINED' && (negative.amountMinor !== value.amount || negative.currency !== value.currency)) {
        await client.query('ROLLBACK'); return 'CONFLICT';
      }
      const result = await client.query(`INSERT INTO provider_negative_dispositions
        (resolution_id,source_negative_observation_id,provider,environment,provider_account_scope,provider_observation_id,
         provider_transaction_id,intent_id,receipt_id,cell_id,amount,currency,disposition_status,outcome,version,
         evidence_reference,evidence_digest,observed_at,recorded_at,resolver_principal_id,resolver_capability)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
        ON CONFLICT DO NOTHING RETURNING resolution_id`, [value.resolutionId,value.sourceNegativeObservationId,value.provider,
          value.environment,value.providerAccountScope,value.providerObservationId,value.providerTransactionId,value.intentId,
          value.receiptId,value.cellId,value.amount.toString(),value.currency,value.status,value.outcome,value.version.toString(),
          value.evidenceReference,value.evidenceDigest,value.observedAt,value.recordedAt,value.resolverPrincipalId,value.resolverCapability]);
      if (result.rowCount === 1) { await client.query('COMMIT'); return 'RECORDED'; }
      const duplicate = await client.query<DispositionRow>(`SELECT * FROM provider_negative_dispositions
        WHERE resolution_id=$1 OR (source_negative_observation_id=$2 AND (version=$3 OR evidence_digest=$4))`,
        [value.resolutionId,value.sourceNegativeObservationId,value.version.toString(),value.evidenceDigest]);
      const duplicateRow = duplicate.rows[0];
      const exact = duplicate.rowCount === 1 && duplicateRow !== undefined && sameDispositionRow(duplicateRow, value);
      await client.query('COMMIT');
      return exact ? 'DUPLICATE' : 'CONFLICT';
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async listNegativeDispositions(cellId: string): Promise<ReadonlyArray<ProviderNegativeDisposition>> {
    const result = await this.pool.query(`SELECT * FROM provider_negative_dispositions WHERE cell_id=$1 ORDER BY source_negative_observation_id,version`, [cellId]);
    return result.rows.map((r) => ({ resolutionId:r.resolution_id,sourceNegativeObservationId:r.source_negative_observation_id,
      provider:r.provider,environment:r.environment,providerAccountScope:r.provider_account_scope,
      providerObservationId:r.provider_observation_id,providerTransactionId:r.provider_transaction_id,
      intentId:r.intent_id,receiptId:r.receipt_id,cellId:r.cell_id,amount:makeAmount(BigInt(r.amount)),currency:r.currency,
      status:r.disposition_status,outcome:r.outcome,version:BigInt(r.version),evidenceReference:r.evidence_reference,
      evidenceDigest:r.evidence_digest,observedAt:makeTimestamp(Number(r.observed_at)),recordedAt:makeTimestamp(Number(r.recorded_at)),
      resolverPrincipalId:r.resolver_principal_id,resolverCapability:r.resolver_capability }));
  }
}

function rowToEvent(row: EventRow): ProviderEvent { return { eventIdentity:row.event_identity,
  replayIdentity:row.replay_identity,provider:row.provider,environment:row.environment,
  providerEventId:row.provider_event_id ?? undefined,providerPaymentId:row.provider_payment_id ?? undefined,
  providerTransactionId:row.provider_transaction_id,intentId:row.intent_id ?? undefined,
  receiptId:row.receipt_id ?? undefined,cellId:row.cell_id ?? undefined,eventType:row.event_type,
  payloadDigest:row.payload_digest,normalizedEvidenceDigest:row.normalized_evidence_digest ?? undefined,
  receivedAt:makeTimestamp(Number(row.received_at)) }; }

function sameDispositionRow(row:DispositionRow,value:ProviderNegativeDisposition):boolean {
  return row.resolution_id===value.resolutionId&&row.source_negative_observation_id===value.sourceNegativeObservationId
    &&row.provider===value.provider&&row.environment===value.environment
    &&row.provider_account_scope===value.providerAccountScope&&row.provider_observation_id===value.providerObservationId
    &&row.provider_transaction_id===value.providerTransactionId&&row.intent_id===value.intentId
    &&row.receipt_id===value.receiptId&&row.cell_id===value.cellId&&BigInt(row.amount)===value.amount
    &&row.currency===value.currency&&row.disposition_status===value.status&&row.outcome===value.outcome
    &&BigInt(row.version)===value.version&&row.evidence_reference===value.evidenceReference
    &&row.evidence_digest===value.evidenceDigest&&Number(row.observed_at)===value.observedAt
    &&Number(row.recorded_at)===value.recordedAt&&row.resolver_principal_id===value.resolverPrincipalId
    &&row.resolver_capability===value.resolverCapability;
}
function rowToCorrelation(row: CorrelationRow): ProviderTransactionCorrelation { return {
  provider:row.provider,environment:row.environment,providerAccountScope:row.provider_account_scope,
  providerTransactionId:row.provider_transaction_id,
  providerPaymentId:row.provider_payment_id ?? undefined,intentId:row.intent_id,receiptId:row.receipt_id ?? undefined,
  cellId:row.cell_id,createdAt:makeTimestamp(Number(row.created_at)) }; }
function rowToNegative(row: NegativeRow): ProviderNegativeObservation { return {
  observationId:row.observation_id,provider:row.provider,environment:row.environment,
  providerAccountScope:row.provider_account_scope,
  providerObservationId:row.provider_observation_id,providerTransactionId:row.provider_transaction_id,
  intentId:row.intent_id,receiptId:row.receipt_id ?? undefined,cellId:row.cell_id ?? undefined,kind:row.kind,
  amountMinor:row.amount_minor === null ? undefined : makeAmount(BigInt(row.amount_minor)),
  currency:row.currency === null ? undefined : row.currency as Currency,payloadDigest:row.payload_digest,
  observedAt:makeTimestamp(Number(row.observed_at)),recordedAt:makeTimestamp(Number(row.recorded_at)) }; }
function rowToRoute(row:RouteRow):FundingRoute{return {routeId:row.route_id,intentId:row.intent_id,provider:row.provider,
  environment:row.environment,providerAccountScope:row.provider_account_scope,destinationReference:row.destination_reference,
  currency:row.currency as Currency,expectedAmount:makeAmount(BigInt(row.expected_amount)),status:row.status,
  createdAt:makeTimestamp(Number(row.created_at)),expiresAt:row.expires_at===null?undefined:makeTimestamp(Number(row.expires_at))};}
function rowToObservation(row:ObservationRow):FundingObservation{return {observationId:row.observation_id,provider:row.provider,
  environment:row.environment,providerAccountScope:row.provider_account_scope,providerTransactionId:row.provider_transaction_id,
  relatedProviderTransactionId:row.related_provider_transaction_id??undefined,
  direction:row.direction,amount:makeAmount(BigInt(row.amount_minor)),currency:row.currency as Currency,
  observedAt:makeTimestamp(Number(row.observed_at)),bookedAt:row.booked_at===null?undefined:makeTimestamp(Number(row.booked_at)),
  destinationReference:row.destination_reference??undefined,rawPayloadDigest:row.raw_payload_digest,state:row.state};}
function sameRoute(a:FundingRoute,b:FundingRoute):boolean{return a.routeId===b.routeId&&a.intentId===b.intentId&&a.provider===b.provider
  &&a.environment===b.environment&&a.providerAccountScope===b.providerAccountScope&&a.destinationReference===b.destinationReference
  &&a.currency===b.currency&&a.expectedAmount===b.expectedAmount&&a.status===b.status&&a.createdAt===b.createdAt&&a.expiresAt===b.expiresAt;}
function sameObservation(a:FundingObservation,b:FundingObservation):boolean{return a.observationId===b.observationId&&a.provider===b.provider
  &&a.environment===b.environment&&a.providerAccountScope===b.providerAccountScope&&a.providerTransactionId===b.providerTransactionId
  &&a.relatedProviderTransactionId===b.relatedProviderTransactionId
  &&a.direction===b.direction&&a.amount===b.amount&&a.currency===b.currency&&a.observedAt===b.observedAt&&a.bookedAt===b.bookedAt
  &&a.destinationReference===b.destinationReference&&a.rawPayloadDigest===b.rawPayloadDigest&&a.state===b.state;}
function sameAccountCheckpoint(a:ProviderAccountReconciliationCheckpoint,b:ProviderAccountReconciliationCheckpoint):boolean{
  return a.provider===b.provider&&a.environment===b.environment&&a.providerAccountScope===b.providerAccountScope
    &&a.cursor===b.cursor&&a.pageToken===b.pageToken&&a.statementSequence===b.statementSequence
    &&a.lastObservedAt===b.lastObservedAt&&a.checkedAt===b.checkedAt&&a.revision===b.revision;}
