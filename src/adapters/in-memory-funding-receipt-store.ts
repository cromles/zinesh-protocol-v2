import type { FundingReceipt } from '../funding/types';
import type {
  FundingReceiptClaimResult,
  FundingReceiptConflict,
  FundingReceiptStore,
} from './funding-receipt-store';
import { sameFundingReceiptIdentity } from './funding-receipt-store';

export class InMemoryFundingReceiptStore implements FundingReceiptStore {
  private readonly receipts: FundingReceipt[] = [];

  async getById(receiptId: string): Promise<FundingReceipt | null> {
    return this.receipts.find((item) => item.receiptId === receiptId) ?? null;
  }

  async claim(receipt: FundingReceipt): Promise<FundingReceiptClaimResult> {
    const matches = this.receipts.filter((existing) => conflictsWith(existing, receipt));
    if (matches.length === 0) {
      this.receipts.push(Object.freeze({ ...receipt }));
      return { kind: 'CLAIMED' };
    }
    if (matches.length === 1 && sameFundingReceiptIdentity(matches[0]!, receipt)) {
      return { kind: 'DUPLICATE', receipt: matches[0]! };
    }
    return { kind: 'CONFLICT', conflict: conflictKind(matches[0]!, receipt) };
  }
}

function conflictsWith(left: FundingReceipt, right: FundingReceipt): boolean {
  return left.receiptId === right.receiptId
    || left.intentId === right.intentId
    || (left.provider === right.provider && left.environment === right.environment
      && left.providerAccountScope === right.providerAccountScope
      && left.providerTransactionId === right.providerTransactionId)
    || left.cellId === right.cellId
    || left.commandId === right.commandId
    || left.fundingEventId === right.fundingEventId;
}

function conflictKind(left: FundingReceipt, right: FundingReceipt): FundingReceiptConflict {
  if (left.provider === right.provider && left.environment === right.environment
      && left.providerAccountScope === right.providerAccountScope
      && left.providerTransactionId === right.providerTransactionId) {
    return 'PROVIDER_TRANSACTION';
  }
  if (left.receiptId === right.receiptId) return 'RECEIPT';
  if (left.intentId === right.intentId) return 'INTENT';
  if (left.cellId === right.cellId) return 'CELL';
  if (left.commandId === right.commandId) return 'COMMAND';
  return 'EVENT';
}
