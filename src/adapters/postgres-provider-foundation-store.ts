import type { Pool } from 'pg';
import { makeAmount, makeTimestamp } from '../core/types';
import type { Currency } from '../core/types';
import type { ProviderEnvironment, ProviderEvent, ProviderNegativeObservation,
  ProviderNegativeObservationKind, ProviderReconciliationCheckpoint,
  ProviderReconciliationState, ProviderTransactionCorrelation } from '../funding/provider-evidence';
import { providerIdentityHash } from '../funding/provider-identity';
import type { ProviderCorrelationResult, ProviderEventRecordResult, ProviderFoundationStore,
  ProviderNegativeObservationResult } from './provider-foundation-store';
import { sameProviderCorrelation, sameProviderEvent } from './provider-foundation-store';

interface EventRow { event_identity: string; replay_identity: string; provider: string;
  environment: ProviderEnvironment; provider_event_id: string | null; provider_payment_id: string;
  provider_transaction_id: string; intent_id: string; receipt_id: string | null; cell_id: string | null;
  event_type: string; payload_digest: string; normalized_evidence_digest: string | null;
  received_at: string }
interface CorrelationRow { provider: string; environment: ProviderEnvironment;
  provider_transaction_id: string; provider_payment_id: string; intent_id: string;
  receipt_id: string | null; cell_id: string; created_at: string }
interface CheckpointRow { provider: string; environment: ProviderEnvironment;
  provider_transaction_id: string; state: ProviderReconciliationState;
  normalized_evidence_digest: string | null; last_event_identity: string | null;
  attempt_count: number; checked_at: string; next_attempt_at: string | null;
  last_error_category: string | null }
interface NegativeRow { observation_id: string; provider: string; environment: ProviderEnvironment;
  provider_observation_id: string; provider_transaction_id: string; intent_id: string;
  receipt_id: string | null; cell_id: string | null; kind: ProviderNegativeObservationKind;
  amount_minor: string | null; currency: string | null; payload_digest: string;
  observed_at: string; recorded_at: string }

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
      if (inserted.rowCount === 1) { await client.query('COMMIT'); return { kind: 'FIRST_SEEN' }; }
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

  async correlateTransaction(value: ProviderTransactionCorrelation): Promise<ProviderCorrelationResult> {
    const inserted = await this.pool.query(`INSERT INTO provider_transaction_correlations
      (provider,environment,provider_transaction_id,provider_payment_id,intent_id,receipt_id,cell_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING provider`,
    [value.provider,value.environment,value.providerTransactionId,value.providerPaymentId,value.intentId,
      value.receiptId ?? null,value.cellId,value.createdAt]);
    if (inserted.rowCount === 1) return { kind: 'RECORDED' };
    const existing = await this.pool.query<CorrelationRow>(`SELECT * FROM provider_transaction_correlations
      WHERE provider=$1 AND environment=$2 AND (provider_transaction_id=$3 OR intent_id=$4)`,
    [value.provider,value.environment,value.providerTransactionId,value.intentId]);
    const matches = existing.rows.map(rowToCorrelation);
    return matches.length === 1 && sameProviderCorrelation(matches[0]!,value)
      ? { kind: 'DUPLICATE', correlation: matches[0]! } : { kind: 'CONFLICT' };
  }

  async putCheckpoint(value: ProviderReconciliationCheckpoint): Promise<void> {
    await this.pool.query(`INSERT INTO provider_reconciliation_checkpoints
      (provider,environment,provider_transaction_id,state,normalized_evidence_digest,last_event_identity,
       attempt_count,checked_at,next_attempt_at,last_error_category)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(provider,environment,provider_transaction_id) DO UPDATE SET
       state=EXCLUDED.state,normalized_evidence_digest=EXCLUDED.normalized_evidence_digest,
       last_event_identity=EXCLUDED.last_event_identity,attempt_count=EXCLUDED.attempt_count,
       checked_at=EXCLUDED.checked_at,next_attempt_at=EXCLUDED.next_attempt_at,
       last_error_category=EXCLUDED.last_error_category`,
    [value.provider,value.environment,value.providerTransactionId,value.state,
      value.normalizedEvidenceDigest ?? null,value.lastEventIdentity ?? null,value.attemptCount,
      value.checkedAt,value.nextAttemptAt ?? null,value.lastErrorCategory ?? null]);
  }

  async getCheckpoint(provider: string, environment: string,
    providerTransactionId: string): Promise<ProviderReconciliationCheckpoint | null> {
    const result = await this.pool.query<CheckpointRow>(`SELECT * FROM provider_reconciliation_checkpoints
      WHERE provider=$1 AND environment=$2 AND provider_transaction_id=$3`,
    [provider,environment,providerTransactionId]);
    const row = result.rows[0];
    return row === undefined ? null : { provider:row.provider,environment:row.environment,
      providerTransactionId:row.provider_transaction_id,state:row.state,
      normalizedEvidenceDigest:row.normalized_evidence_digest ?? undefined,
      lastEventIdentity:row.last_event_identity ?? undefined,attemptCount:row.attempt_count,
      checkedAt:makeTimestamp(Number(row.checked_at)),
      nextAttemptAt:row.next_attempt_at === null ? undefined : makeTimestamp(Number(row.next_attempt_at)),
      lastErrorCategory:row.last_error_category ?? undefined };
  }

  async appendNegativeObservation(value: ProviderNegativeObservation):
    Promise<ProviderNegativeObservationResult> {
    const inserted = await this.pool.query(`INSERT INTO provider_negative_observations
      (observation_id,provider,environment,provider_observation_id,provider_transaction_id,intent_id,
       receipt_id,cell_id,kind,amount_minor,currency,payload_digest,observed_at,recorded_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT DO NOTHING RETURNING observation_id`,
    [value.observationId,value.provider,value.environment,value.providerObservationId,
      value.providerTransactionId,value.intentId,value.receiptId ?? null,value.cellId ?? null,value.kind,
      value.amountMinor?.toString() ?? null,value.currency ?? null,value.payloadDigest,value.observedAt,
      value.recordedAt]);
    if (inserted.rowCount === 1) return { kind: 'RECORDED' };
    const existing = await this.pool.query<NegativeRow>(`SELECT * FROM provider_negative_observations
      WHERE observation_id=$1 OR (provider=$2 AND environment=$3 AND provider_observation_id=$4)`,
    [value.observationId,value.provider,value.environment,value.providerObservationId]);
    const rows = existing.rows.map(rowToNegative);
    const exact = rows.find((item) => JSON.stringify({...item,amountMinor:item.amountMinor?.toString()})
      === JSON.stringify({...value,amountMinor:value.amountMinor?.toString()}));
    return exact === undefined ? { kind:'CONFLICT' } : { kind:'DUPLICATE',observation:exact };
  }
}

function rowToEvent(row: EventRow): ProviderEvent { return { eventIdentity:row.event_identity,
  replayIdentity:row.replay_identity,provider:row.provider,environment:row.environment,
  providerEventId:row.provider_event_id ?? undefined,providerPaymentId:row.provider_payment_id,
  providerTransactionId:row.provider_transaction_id,intentId:row.intent_id,
  receiptId:row.receipt_id ?? undefined,cellId:row.cell_id ?? undefined,eventType:row.event_type,
  payloadDigest:row.payload_digest,normalizedEvidenceDigest:row.normalized_evidence_digest ?? undefined,
  receivedAt:makeTimestamp(Number(row.received_at)) }; }
function rowToCorrelation(row: CorrelationRow): ProviderTransactionCorrelation { return {
  provider:row.provider,environment:row.environment,providerTransactionId:row.provider_transaction_id,
  providerPaymentId:row.provider_payment_id,intentId:row.intent_id,receiptId:row.receipt_id ?? undefined,
  cellId:row.cell_id,createdAt:makeTimestamp(Number(row.created_at)) }; }
function rowToNegative(row: NegativeRow): ProviderNegativeObservation { return {
  observationId:row.observation_id,provider:row.provider,environment:row.environment,
  providerObservationId:row.provider_observation_id,providerTransactionId:row.provider_transaction_id,
  intentId:row.intent_id,receiptId:row.receipt_id ?? undefined,cellId:row.cell_id ?? undefined,kind:row.kind,
  amountMinor:row.amount_minor === null ? undefined : makeAmount(BigInt(row.amount_minor)),
  currency:row.currency === null ? undefined : row.currency as Currency,payloadDigest:row.payload_digest,
  observedAt:makeTimestamp(Number(row.observed_at)),recordedAt:makeTimestamp(Number(row.recorded_at)) }; }
