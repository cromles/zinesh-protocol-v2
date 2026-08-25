import type { Pool } from 'pg';
import type { CommandId } from '../core/types';
import type {
  CommandExecutionResult,
  CommandExecutionStore,
  CommandWorkResult,
} from './command-execution-store';
import type { EventStore } from './event-store';
import { PostgresEventStore } from './postgres-event-store';
import { PostgresFundingReceiptStore } from './postgres-funding-receipt-store';
import type { FundingReceiptStore } from './funding-receipt-store';

interface ExecutionRow { fingerprint: string; result: string | null }

export class PostgresCommandExecutionStore implements CommandExecutionStore {
  constructor(private readonly pool: Pool) {}

  async execute(
    commandId: CommandId,
    fingerprint: string,
    work: (eventStore: EventStore, fundingReceiptStore: FundingReceiptStore) => Promise<CommandWorkResult>,
  ): Promise<CommandExecutionResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query(
        `INSERT INTO command_executions (command_id, fingerprint, result)
         VALUES ($1, $2, NULL)
         ON CONFLICT (command_id) DO NOTHING
         RETURNING command_id`,
        [commandId, fingerprint],
      );

      if (claimed.rowCount === 0) {
        const existing = await client.query<ExecutionRow>(
          `SELECT fingerprint, result FROM command_executions WHERE command_id = $1`,
          [commandId],
        );
        const row = existing.rows[0];
        await client.query('COMMIT');
        if (row === undefined || row.fingerprint !== fingerprint || row.result === null) {
          return { kind: 'CONFLICT' };
        }
        return { kind: 'REPLAYED', encodedResult: row.result };
      }

      const completed = await work(
        new PostgresEventStore(this.pool, client),
        new PostgresFundingReceiptStore(this.pool, client),
      );
      await client.query(
        `UPDATE command_executions SET result = $2 WHERE command_id = $1`,
        [commandId, completed.encodedResult],
      );
      await client.query('COMMIT');
      return { kind: 'EXECUTED', encodedResult: completed.encodedResult };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
