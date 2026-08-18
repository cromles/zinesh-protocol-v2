import { Pool } from 'pg';
import { CellId, Event, CellCreatedEvent, FundingBoundEvent, ReleaseRequestedEvent, RefundRequestedEvent, DisputeOpenedEvent, DisputeResolvedEvent, CellReleasedEvent, CellRefundedEvent, CellTerminatedEvent } from '../core/types.js';
import { EventStore } from './event-store.js';

type PersistedEvent = {
  eventId: string;
  cellId: CellId;
  version: number;
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
};

/**
 * PostgreSQL implementation of EventStore.
 * 
 * Security guarantees:
 * - Append-only: INSERT only, no UPDATE/DELETE on events
 * - Immutability: UNIQUE (cell_id, version) constraint prevents overwrites
 * - Replay protection: UNIQUE (id) constraint prevents duplicate event IDs
 * - Cell isolation: All operations scoped by cell_id
 * - Atomic batches: Transactions ensure all-or-nothing event persistence
 */
export class PostgresEventStore implements EventStore {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Append events to a cell's history.
   * 
   * Concurrency handling:
   * - Uses transaction with UNIQUE constraint on (cell_id, version)
   * - If concurrent write attempts same version, one fails with unique violation
   * - Caller must retry with fresh state on conflict
   * 
   * Atomicity:
   * - All events in batch commit together or none commit
   */
  async appendEvents(cellId: CellId, events: readonly Event[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const event of events) {
        const payload = extractPayload(event);
        await client.query(
          `INSERT INTO events (id, cell_id, version, type, payload)
           VALUES ($1, $2, $3, $4, $5)`,
          [event.eventId, cellId, event.version, event.type, JSON.stringify(payload)]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Retrieve all events for a cell, ordered by version.
   */
  async getEventsForCell(cellId: CellId): Promise<readonly Event[]> {
    const result = await this.pool.query(
      `SELECT id, cell_id, version, type, payload, timestamp
       FROM events
       WHERE cell_id = $1
       ORDER BY version ASC`,
      [cellId]
    );

    return result.rows.map((row): Event => reconstructEvent(row));
  }

  /**
   * Check if an event ID already exists (replay detection).
   */
  async hasEvent(eventId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM events WHERE id = $1 LIMIT 1`,
      [eventId]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Get the current version (event count) for a cell.
   * Returns 0 if no events exist for the cell.
   */
  async getVersion(cellId: CellId): Promise<number> {
    const result = await this.pool.query(
      `SELECT COALESCE(MAX(version), 0) as max_version
       FROM events
       WHERE cell_id = $1`,
      [cellId]
    );
    return parseInt(result.rows[0].max_version, 10);
  }
}

function extractPayload(event: Event): Record<string, unknown> {
  const e = event as unknown as Record<string, unknown>;
  const { eventId, cellId, timestamp, version, type, ...payload } = e;
  return payload;
}

function reconstructEvent(row: { id: string; cell_id: string; version: number; type: string; payload: string; timestamp: { getTime: () => number } }): Event {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  const baseEvent = {
    eventId: row.id,
    cellId: row.cell_id as CellId,
    version: row.version,
    timestamp: row.timestamp.getTime() / 1000,
    ...payload
  };

  switch (row.type) {
    case 'CellCreated':
      return { ...baseEvent, type: 'CellCreated' } as CellCreatedEvent;
    case 'FundingBound':
      return { ...baseEvent, type: 'FundingBound' } as FundingBoundEvent;
    case 'ReleaseRequested':
      return { ...baseEvent, type: 'ReleaseRequested' } as ReleaseRequestedEvent;
    case 'RefundRequested':
      return { ...baseEvent, type: 'RefundRequested' } as RefundRequestedEvent;
    case 'DisputeOpened':
      return { ...baseEvent, type: 'DisputeOpened' } as DisputeOpenedEvent;
    case 'DisputeResolved':
      return { ...baseEvent, type: 'DisputeResolved' } as DisputeResolvedEvent;
    case 'CellReleased':
      return { ...baseEvent, type: 'CellReleased' } as CellReleasedEvent;
    case 'CellRefunded':
      return { ...baseEvent, type: 'CellRefunded' } as CellRefundedEvent;
    case 'CellTerminated':
      return { ...baseEvent, type: 'CellTerminated' } as CellTerminatedEvent;
    default:
      throw new Error(`Unknown event type: ${row.type}`);
  }
}
