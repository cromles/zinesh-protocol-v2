import type { Pool, PoolClient } from 'pg';
import { makeActorId, makeAmount, makeCellId, makeTimestamp } from '../core/types';
import type { Currency } from '../core/types';
import type { FundingIntent } from '../funding/types';
import type { FundingIntentCreateResult, FundingIntentStore } from './funding-intent-store';
import { sameFundingIntent } from './funding-intent-store';
import { hasValidFundingIntentBinding } from '../funding/funding-intent';

interface IntentRow { intent_id: string; provider: string; environment: 'SANDBOX'|'LIVE'|null; provider_account_scope: string|null; cell_id: string; payer: string; payee: string;
  amount: string; currency: string; destination_id: string; binding_digest: string;
  created_at: string; expires_at: string }

export class PostgresFundingIntentStore implements FundingIntentStore {
  constructor(private readonly pool: Pool, private readonly transactionClient?: PoolClient) {}

  async create(intent: FundingIntent): Promise<FundingIntentCreateResult> {
    if (!hasValidFundingIntentBinding(intent)) return { kind: 'INVALID' };
    const queryable = this.transactionClient ?? this.pool;
    const inserted = await queryable.query(
      `INSERT INTO funding_intents (intent_id,provider,environment,provider_account_scope,cell_id,payer,payee,amount,currency,
        destination_id,binding_digest,created_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING intent_id`,
      [intent.intentId, intent.provider, intent.environment, intent.providerAccountScope, intent.cellId, intent.payer, intent.payee,
        intent.amount.toString(), intent.currency, intent.destinationId, intent.bindingDigest,
        intent.createdAt, intent.expiresAt],
    );
    if (inserted.rowCount === 1) return { kind: 'CREATED' };
    const existing = await this.get(intent.intentId);
    return existing !== null && sameFundingIntent(existing, intent)
      ? { kind: 'DUPLICATE', intent: existing } : { kind: 'CONFLICT' };
  }

  async get(intentId: string): Promise<FundingIntent | null> {
    const queryable = this.transactionClient ?? this.pool;
    const result = await queryable.query<IntentRow>(
      `SELECT intent_id,provider,environment,provider_account_scope,cell_id,payer,payee,amount,currency,destination_id,
        binding_digest,created_at,expires_at FROM funding_intents WHERE intent_id=$1`, [intentId],
    );
    return result.rows[0] === undefined || result.rows[0].environment === null
      || result.rows[0].provider_account_scope === null ? null : rowToIntent(result.rows[0]);
  }
}

function rowToIntent(row: IntentRow): FundingIntent {
  if (row.environment === null || row.provider_account_scope === null) throw new Error('Legacy funding intent has no trusted account scope');
  return { intentId: row.intent_id, provider: row.provider, environment: row.environment,
    providerAccountScope: row.provider_account_scope, cellId: makeCellId(row.cell_id),
    payer: makeActorId(row.payer), payee: makeActorId(row.payee), amount: makeAmount(BigInt(row.amount)),
    currency: row.currency as Currency, destinationId: row.destination_id,
    bindingDigest: row.binding_digest, createdAt: makeTimestamp(Number(row.created_at)),
    expiresAt: makeTimestamp(Number(row.expires_at)) };
}
