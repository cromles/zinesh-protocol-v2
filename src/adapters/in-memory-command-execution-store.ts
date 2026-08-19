import type { CommandId } from '../core/types';
import type { EventStore } from './event-store';
import type {
  CommandExecutionResult,
  CommandExecutionStore,
  CommandWorkResult,
} from './command-execution-store';

interface RecordEntry { readonly fingerprint: string; readonly encodedResult: string }

export class InMemoryCommandExecutionStore implements CommandExecutionStore {
  private readonly records = new Map<CommandId, RecordEntry>();
  private readonly tails = new Map<CommandId, Promise<void>>();

  constructor(private readonly eventStore: EventStore) {}

  execute(
    commandId: CommandId,
    fingerprint: string,
    work: (eventStore: EventStore) => Promise<CommandWorkResult>,
  ): Promise<CommandExecutionResult> {
    const previous = this.tails.get(commandId) ?? Promise.resolve();
    const run = previous.then(async (): Promise<CommandExecutionResult> => {
      const existing = this.records.get(commandId);
      if (existing !== undefined) {
        return existing.fingerprint === fingerprint
          ? { kind: 'REPLAYED', encodedResult: existing.encodedResult }
          : { kind: 'CONFLICT' };
      }
      const completed = await work(this.eventStore);
      this.records.set(commandId, { fingerprint, encodedResult: completed.encodedResult });
      return { kind: 'EXECUTED', encodedResult: completed.encodedResult };
    });
    const tail = run.then(() => undefined, () => undefined);
    this.tails.set(commandId, tail);
    void tail.finally(() => {
      if (this.tails.get(commandId) === tail) this.tails.delete(commandId);
    });
    return run;
  }
}
