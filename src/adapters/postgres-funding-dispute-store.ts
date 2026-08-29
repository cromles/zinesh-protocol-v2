import { createHash } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { makeAmount, makeCellId, makeTimestamp } from '../core/types';
import type { Currency } from '../core/types';
import type { FundingDisputeKind, FundingDisputeObservation, FundingDisputeOutcome,
  FundingDisputeStatus } from '../funding/types';
import type { FundingDisputeRecordResult, FundingDisputeStore } from './funding-dispute-store';
import { hasConsistentFundingDisputeLifecycle, sameFundingDisputeBinding,
  sameFundingDisputeObservation } from './funding-dispute-store';

interface DisputeRow { observation_id: string; provider: string; provider_dispute_id: string;
  provider_transaction_id: string; observation_version: string; receipt_id: string; cell_id: string;
  kind: FundingDisputeKind; status: FundingDisputeStatus; outcome: FundingDisputeOutcome;
  amount: string; currency: string;
  evidence_digest: string; observed_at: string; recorded_at: string }

export class PostgresFundingDisputeStore implements FundingDisputeStore {
  constructor(private readonly pool: Pool, private readonly transactionClient?: PoolClient) {}

  async record(observation: FundingDisputeObservation): Promise<FundingDisputeRecordResult> {
    if (!hasConsistentFundingDisputeLifecycle(observation)) return { kind: 'CONFLICT' };
    if (this.transactionClient !== undefined) {
      return this.recordInTransaction(this.transactionClient, observation);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.recordInTransaction(client, observation);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async recordInTransaction(
    client: PoolClient, observation: FundingDisputeObservation,
  ): Promise<FundingDisputeRecordResult> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [fundingDisputeAdvisoryLockKey(observation.provider, observation.providerDisputeId)]);
    await client.query('SELECT receipt_id FROM funding_receipts WHERE receipt_id=$1 FOR UPDATE',
      [observation.receiptId]);
    const prior = await client.query<DisputeRow>(
      `SELECT observation_id,provider,provider_dispute_id,provider_transaction_id,observation_version,
        receipt_id,cell_id,kind,status,outcome,amount,currency,evidence_digest,observed_at,recorded_at
       FROM funding_dispute_observations WHERE provider=$1 AND provider_dispute_id=$2
       ORDER BY observation_version LIMIT 1`,
      [observation.provider, observation.providerDisputeId],
    );
    if (prior.rows[0] !== undefined
      && !sameFundingDisputeBinding(rowToObservation(prior.rows[0]), observation)) {
      return { kind: 'CONFLICT' };
    }
    const inserted = await client.query(
      `INSERT INTO funding_dispute_observations (observation_id,provider,provider_dispute_id,
        provider_transaction_id,observation_version,receipt_id,cell_id,kind,status,outcome,amount,currency,
        evidence_digest,observed_at,recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT DO NOTHING RETURNING observation_id`,
      [observation.observationId, observation.provider, observation.providerDisputeId,
        observation.providerTransactionId, observation.observationVersion.toString(), observation.receiptId,
        observation.cellId, observation.kind, observation.status, observation.outcome,
        observation.amount.toString(),
        observation.currency, observation.evidenceDigest, observation.observedAt, observation.recordedAt],
    );
    if (inserted.rowCount === 1) return { kind: 'RECORDED' };
    const existing = await client.query<DisputeRow>(
      `SELECT observation_id,provider,provider_dispute_id,provider_transaction_id,observation_version,
        receipt_id,cell_id,kind,status,outcome,amount,currency,evidence_digest,observed_at,recorded_at
       FROM funding_dispute_observations WHERE observation_id=$1 OR
        (provider=$2 AND provider_dispute_id=$3 AND (observation_version=$4 OR evidence_digest=$5))`,
      [observation.observationId, observation.provider, observation.providerDisputeId,
        observation.observationVersion.toString(), observation.evidenceDigest],
    );
    const matches = existing.rows.map(rowToObservation);
    return matches.length === 1 && sameFundingDisputeObservation(matches[0]!, observation)
      ? { kind: 'DUPLICATE', observation: matches[0]! } : { kind: 'CONFLICT' };
  }

  async hasBlockingDispute(cellId: ReturnType<typeof makeCellId>): Promise<boolean> {
    const queryable = this.transactionClient ?? this.pool;
    if (this.transactionClient !== undefined) {
      await this.transactionClient.query(
        'SELECT receipt_id FROM funding_receipts WHERE cell_id=$1 FOR UPDATE', [cellId],
      );
    }
    const result = await queryable.query<{ blocked: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM (
          SELECT DISTINCT ON (provider,provider_dispute_id) outcome
          FROM funding_dispute_observations WHERE cell_id=$1
          ORDER BY provider,provider_dispute_id,observation_version DESC
        ) latest WHERE outcome <> 'FUNDS_RETAINED'
      ) AS blocked`, [cellId],
    );
    return result.rows[0]?.blocked === true;
  }
}

export function fundingDisputeAdvisoryLockKey(provider: string, providerDisputeId: string): string {
  const hash = createHash('sha256');
  for (const value of [provider, providerDisputeId]) {
    const encoded = Buffer.from(value, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(encoded.length);
    hash.update(length);
    hash.update(encoded);
  }
  return hash.digest('hex');
}

function rowToObservation(row: DisputeRow): FundingDisputeObservation {
  return { observationId: row.observation_id, provider: row.provider,
    providerDisputeId: row.provider_dispute_id, providerTransactionId: row.provider_transaction_id,
    observationVersion: BigInt(row.observation_version), receiptId: row.receipt_id,
    cellId: makeCellId(row.cell_id), kind: row.kind, status: row.status, outcome: row.outcome,
    amount: makeAmount(BigInt(row.amount)), currency: row.currency as Currency,
    evidenceDigest: row.evidence_digest, observedAt: makeTimestamp(Number(row.observed_at)),
    recordedAt: makeTimestamp(Number(row.recorded_at)) };
}
