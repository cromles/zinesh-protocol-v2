/**
 * ZINESH PROTOCOL V2 — PostgresEventStore
 *
 * PostgreSQL implementation of the EventStore interface.
 *
 * Constitution compliance:
 *   - APPEND-ONLY: only INSERT and SELECT are issued against the events table
 *   - No UPDATE, DELETE, TRUNCATE on events — ever
 *   - Caller-supplied versions, timestamps, event_ids, and payloads are stored verbatim
 *   - Database never generates or modifies versions, timestamps, or event_ids
 *   - No SERIAL / IDENTITY / sequence for event versioning
 *   - Every query is scoped by cell_id — no cross-cell access
 *   - Multi-event append is atomic via a single transaction
 *   - Version conflict (UNIQUE violation) is translated to AppendResult { ok: false }
 *   - No SELECT FOR UPDATE, no pessimistic locking, no advisory locks
 *   - No business rules, no domain logic, no state transitions
 *   - No Date.now(), no Math.random()
 */

import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { CellId, Event, Version } from '../core/types';
import { makeEventId, makeCellId, makeTimestamp } from '../core/types';
import type { AppendResult, EventStore } from './event-store';

/** Row shape returned by the events table SELECT. */
interface EventRow {
  event_id: string;
  cell_id: string;
  version: string; // pg returns BIGINT as string
  timestamp: string;
  type: string;
  payload: unknown;
}

/**
 * JSON replacer that encodes bigint values as tagged strings.
 * This preserves precision for the Amount type (kuruş as bigint).
 * Format: "__bigint__:<decimal string>"
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return `__bigint__:${value.toString()}`;
  }
  return value;
}

/**
 * JSON reviver that decodes tagged bigint strings back to bigint.
 */
function jsonReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith('__bigint__:')) {
    return BigInt(value.slice(11));
  }
  return value;
}

/** Translate a raw DB row into the domain Event type. */
function rowToEvent(row: EventRow): Event {
  const payload = typeof row.payload === 'string'
    ? JSON.parse(row.payload, jsonReviver)
    : JSON.parse(JSON.stringify(row.payload), jsonReviver);
  return {
    eventId:   makeEventId(row.event_id),
    cellId:    makeCellId(row.cell_id),
    version:   parseInt(row.version, 10) as Version,
    timestamp: makeTimestamp(parseInt(row.timestamp, 10)),
    type:      row.type as Event['type'],
    payload:   payload as Event['payload'],
  };
}

/** Detect whether a pg error is a unique-constraint violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === '23505'
  );
}

interface Queryable {
  query<R extends QueryResultRow = any>(text: string, values?: ReadonlyArray<unknown>): Promise<QueryResult<R>>;
}

export class PostgresEventStore implements EventStore {
  constructor(private readonly pool: Pool, private readonly transactionClient?: PoolClient) {}

  async append(cellId: CellId, events: ReadonlyArray<Event>): Promise<AppendResult> {
    if (events.length === 0) {
      return { ok: true };
    }

    // Validate that all events belong to the supplied cellId before touching the DB.
    for (const event of events) {
      if (event.cellId !== cellId) {
        return {
          ok: false,
          error: {
            kind: 'APPEND_INTEGRITY_ERROR',
            message: `Event cellId ${event.cellId} does not match target cellId ${cellId}`,
          },
        };
      }
    }

    // All events are inserted inside a single transaction for atomicity.
    // If any INSERT fails the entire batch is rolled back.
    // DO NOT use SELECT FOR UPDATE.
    if (this.transactionClient !== undefined) {
      return this.insertBatch(this.transactionClient, events);
    }
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const event of events) {
        // INSERT only — no UPDATE, no ON CONFLICT DO UPDATE for events.
        // A duplicate (cell_id, version) causes a unique-constraint violation
        // which is caught below and translated to AppendResult { ok: false }.
        await client.query(
          `INSERT INTO events (event_id, cell_id, version, timestamp, type, payload)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            event.eventId,
            event.cellId,
            event.version,
            event.timestamp,
            event.type,
            JSON.stringify(event.payload, jsonReplacer),
          ],
        );
      }

      await client.query('COMMIT');
      return { ok: true };
    } catch (err: unknown) {
      await client.query('ROLLBACK');

      if (isUniqueViolation(err)) {
        return {
          ok: false,
          error: {
            kind: 'APPEND_VERSION_CONFLICT',
            message: 'A duplicate (cell_id, version) or event_id was detected',
          },
        };
      }

      // Re-throw unexpected database errors — they are infrastructure failures,
      // not domain errors. The caller decides how to handle them.
      throw err;
    } finally {
      client.release();
    }
  }

  private async insertBatch(client: Queryable, events: ReadonlyArray<Event>): Promise<AppendResult> {
    try {
      for (const event of events) {
        await client.query(
          `INSERT INTO events (event_id, cell_id, version, timestamp, type, payload)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [event.eventId, event.cellId, event.version, event.timestamp, event.type,
            JSON.stringify(event.payload, jsonReplacer)],
        );
      }
      return { ok: true };
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return { ok: false, error: { kind: 'APPEND_VERSION_CONFLICT', message: 'A duplicate (cell_id, version) or event_id was detected' } };
      }
      throw err;
    }
  }

  async getEvents(cellId: CellId): Promise<ReadonlyArray<Event>> {
    const queryable: Queryable = this.transactionClient ?? this.pool;
    const result = await queryable.query<EventRow>(
      `SELECT event_id, cell_id, version, timestamp, type, payload
       FROM events
       WHERE cell_id = $1
       ORDER BY version ASC`,
      [cellId],
    );
    return result.rows.map(rowToEvent);
  }

  async getEventsSince(cellId: CellId, afterVersion: Version): Promise<ReadonlyArray<Event>> {
    const queryable: Queryable = this.transactionClient ?? this.pool;
    const result = await queryable.query<EventRow>(
      `SELECT event_id, cell_id, version, timestamp, type, payload
       FROM events
       WHERE cell_id = $1
         AND version > $2
       ORDER BY version ASC`,
      [cellId, afterVersion],
    );
    return result.rows.map(rowToEvent);
  }
}
