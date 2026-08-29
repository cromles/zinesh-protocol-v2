import type { CommandId } from '../core/types';
import type { EventStore } from './event-store';
import type { FundingReceiptStore } from './funding-receipt-store';
import type { FundingDisputeStore } from './funding-dispute-store';

export interface CommandWorkResult {
  readonly encodedResult: string;
}

export type CommandExecutionResult =
  | { readonly kind: 'EXECUTED'; readonly encodedResult: string }
  | { readonly kind: 'REPLAYED'; readonly encodedResult: string }
  | { readonly kind: 'CONFLICT' };

/**
 * Durable command boundary. Implementations must commit the command result and
 * every event and funding receipt written through the supplied transaction in
 * one atomic unit.
 */
export interface CommandExecutionStore {
  execute(
    commandId: CommandId,
    fingerprint: string,
    work: (eventStore: EventStore, fundingReceiptStore: FundingReceiptStore,
      fundingDisputeStore: FundingDisputeStore) => Promise<CommandWorkResult>,
  ): Promise<CommandExecutionResult>;
}
