/**
 * ZINESH PROTOCOL V2 — PostgresSnapshotStore
 *
 * PostgreSQL implementation of the SnapshotStore interface.
 *
 * Constitution compliance:
 *   - Snapshots are cache only — event history remains authoritative
 *   - Store does NOT calculate or derive CellState — it stores what the caller supplies
 *   - No business rules, no domain logic, no state transitions
 *   - save uses INSERT ... ON CONFLICT DO UPDATE (UPSERT) — one snapshot per cell
 *   - load returns a copy — the returned object cannot mutate DB state
 *   - Every query is scoped by cell_id
 *   - No Date.now(), no Math.random()
 *   - Database does NOT generate snapshot version
 */

import type { Pool } from 'pg';
import type { CellId } from '../core/types';
import { makeCellId } from '../core/types';
import type { Snapshot, SnapshotStore } from './snapshot-store';

interface SnapshotRow {
  cell_id: string;
  version: string; // pg returns BIGINT as string
  state: unknown;
}

/**
 * JSON replacer that encodes bigint values as tagged strings.
 * Preserves precision for the Amount type (kuruş as bigint).
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

function rowToSnapshot(row: SnapshotRow): Snapshot {
  const state = typeof row.state === 'string'
    ? JSON.parse(row.state, jsonReviver)
    : JSON.parse(JSON.stringify(row.state), jsonReviver);
  return {
    cellId:  makeCellId(row.cell_id),
    version: parseInt(row.version, 10) as Snapshot['version'],
    state:   state as Snapshot['state'],
  };
}

export class PostgresSnapshotStore implements SnapshotStore {
  constructor(private readonly pool: Pool) {}

  async save(cellId: CellId, snapshot: Snapshot): Promise<void> {
    // UPSERT: one snapshot row per cell.
    // UPDATE is permitted for snapshots (unlike events which are append-only).
    await this.pool.query(
      `INSERT INTO snapshots (cell_id, version, state)
       VALUES ($1, $2, $3)
       ON CONFLICT (cell_id)
       DO UPDATE SET
         version = EXCLUDED.version,
         state   = EXCLUDED.state`,
      [
        cellId,
        snapshot.version,
        JSON.stringify(snapshot.state, jsonReplacer),
      ],
    );
  }

  async load(cellId: CellId): Promise<Snapshot | null> {
    const result = await this.pool.query<SnapshotRow>(
      `SELECT cell_id, version, state
       FROM snapshots
       WHERE cell_id = $1`,
      [cellId],
    );
    if (result.rows.length === 0) {
      return null;
    }
    // rowToSnapshot constructs a plain new object — not a mutable DB reference.
    return rowToSnapshot(result.rows[0]!);
  }
}
