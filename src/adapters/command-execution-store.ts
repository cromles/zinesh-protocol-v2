import type { CommandId } from '../core/types';
import type { EventStore } from './event-store';

export interface CommandWorkResult {
  readonly encodedResult: string;
}

export type CommandExecutionResult =
  | { readonly kind: 'EXECUTED'; readonly encodedResult: string }
  | { readonly kind: 'REPLAYED'; readonly encodedResult: string }
  | { readonly kind: 'CONFLICT' };

/**
 * Durable command boundary. Implementations must commit the command result and
 * every event appended through the supplied EventStore in one atomic unit.
 */
export interface CommandExecutionStore {
  execute(
    commandId: CommandId,
    fingerprint: string,
    work: (eventStore: EventStore) => Promise<CommandWorkResult>,
  ): Promise<CommandExecutionResult>;
}
