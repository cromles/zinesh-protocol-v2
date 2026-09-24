import type { Pool, PoolClient } from 'pg';
import { makeActorId, makeAmount, makeCellId, makeCommandId, makeEventId, makeTimestamp } from '../core/types';
import type { Currency } from '../core/types';
import type { FundingReceipt } from '../funding/types';
import type {
  FundingReceiptClaimResult,
  FundingReceiptConflict,
  FundingReceiptStore,
} from './funding-receipt-store';
import { sameFundingReceiptIdentity } from './funding-receipt-store';

interface ReceiptRow {
  receipt_id: string;
  intent_id: string;
  provider: string;
  environment: 'SANDBOX'|'LIVE'|null;
  provider_account_scope: string|null;
  provider_transaction_id: string;
  cell_id: string;
  command_id: string;
  funding_event_id: string;
  gateway_principal_id: string;
  payer: string;
  payee: string;
  amount: string;
  currency: string;
  destination_id: string;
  confirmed_at: string;
  finality: 'FUNDS_HELD' | 'SETTLED_LEGACY';
  evidence_digest: string;
  verified_at: string;
  created_at: string;
}

export class PostgresFundingReceiptStore implements FundingReceiptStore {
  constructor(private readonly pool: Pool, private readonly transactionClient?: PoolClient) {}

  async getById(receiptId: string): Promise<FundingReceipt | null> {
    const result = await (this.transactionClient ?? this.pool).query<ReceiptRow>(
      `SELECT receipt_id,intent_id,provider,environment,provider_account_scope,provider_transaction_id,cell_id,command_id,
       funding_event_id,gateway_principal_id,payer,payee,amount,currency,destination_id,confirmed_at,finality,
       evidence_digest,verified_at,created_at FROM funding_receipts WHERE receipt_id=$1`, [receiptId]);
    return result.rows[0] === undefined || result.rows[0].environment === null
      || result.rows[0].provider_account_scope === null ? null : rowToReceipt(result.rows[0]);
  }

  async claim(receipt: FundingReceipt): Promise<FundingReceiptClaimResult> {
    const queryable = this.transactionClient ?? this.pool;
    const inserted = await queryable.query(
      `INSERT INTO funding_receipts (
        receipt_id, intent_id, provider, environment, provider_account_scope, provider_transaction_id, cell_id, command_id,
        funding_event_id, gateway_principal_id, payer, payee, amount, currency,
        destination_id, confirmed_at, finality, evidence_digest, verified_at, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT DO NOTHING
      RETURNING receipt_id`,
      [
        receipt.receiptId, receipt.intentId, receipt.provider, receipt.environment, receipt.providerAccountScope, receipt.providerTransactionId,
        receipt.cellId, receipt.commandId, receipt.fundingEventId,
        receipt.gatewayPrincipalId, receipt.payer, receipt.payee, receipt.amount.toString(),
        receipt.currency, receipt.destinationId, receipt.confirmedAt,
        receipt.finality, receipt.evidenceDigest, receipt.verifiedAt, receipt.createdAt,
      ],
    );
    if (inserted.rowCount === 1) return { kind: 'CLAIMED' };

    const existing = await queryable.query<ReceiptRow>(
      `SELECT receipt_id, intent_id, provider, environment, provider_account_scope, provider_transaction_id, cell_id, command_id,
        funding_event_id, gateway_principal_id, payer, payee, amount, currency,
        destination_id, confirmed_at, finality, evidence_digest, verified_at, created_at
       FROM funding_receipts
       WHERE receipt_id = $1 OR (provider = $2 AND environment = $3 AND provider_account_scope = $4 AND provider_transaction_id = $5)
          OR cell_id = $6 OR command_id = $7 OR funding_event_id = $8 OR intent_id = $9`,
      [receipt.receiptId, receipt.provider, receipt.environment, receipt.providerAccountScope, receipt.providerTransactionId,
        receipt.cellId, receipt.commandId, receipt.fundingEventId, receipt.intentId],
    );
    const matches = existing.rows.map(rowToReceipt).filter((row): row is FundingReceipt => row !== null);
    if (matches.length !== existing.rows.length) return { kind: 'CONFLICT', conflict: 'PROVIDER_TRANSACTION' };
    if (matches.length === 1 && sameFundingReceiptIdentity(matches[0]!, receipt)) {
      return { kind: 'DUPLICATE', receipt: matches[0]! };
    }
    return { kind: 'CONFLICT', conflict: conflictKind(matches[0], receipt) };
  }
}

function rowToReceipt(row: ReceiptRow): FundingReceipt | null {
  if (row.environment === null || row.provider_account_scope === null) return null;
  return {
    receiptId: row.receipt_id,
    intentId: row.intent_id,
    provider: row.provider,
    environment: row.environment,
    providerAccountScope: row.provider_account_scope,
    providerTransactionId: row.provider_transaction_id,
    cellId: makeCellId(row.cell_id),
    commandId: makeCommandId(row.command_id),
    fundingEventId: makeEventId(row.funding_event_id),
    gatewayPrincipalId: row.gateway_principal_id,
    payer: makeActorId(row.payer),
    payee: makeActorId(row.payee),
    amount: makeAmount(BigInt(row.amount)),
    currency: row.currency as Currency,
    destinationId: row.destination_id,
    confirmedAt: makeTimestamp(Number(row.confirmed_at)),
    finality: row.finality,
    evidenceDigest: row.evidence_digest,
    verifiedAt: makeTimestamp(Number(row.verified_at)),
    createdAt: makeTimestamp(Number(row.created_at)),
  };
}

function conflictKind(existing: FundingReceipt | undefined, candidate: FundingReceipt): FundingReceiptConflict {
  if (existing === undefined) return 'PROVIDER_TRANSACTION';
  if (existing.provider === candidate.provider && existing.environment === candidate.environment
      && existing.providerAccountScope === candidate.providerAccountScope
      && existing.providerTransactionId === candidate.providerTransactionId) return 'PROVIDER_TRANSACTION';
  if (existing.receiptId === candidate.receiptId) return 'RECEIPT';
  if (existing.intentId === candidate.intentId) return 'INTENT';
  if (existing.cellId === candidate.cellId) return 'CELL';
  if (existing.commandId === candidate.commandId) return 'COMMAND';
  return 'EVENT';
}
