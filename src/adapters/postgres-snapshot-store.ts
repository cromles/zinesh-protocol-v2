import { Pool } from 'pg';
import { Cell, CellId } from '../core/types.js';
import { SnapshotStore, CellSnapshot } from './snapshot-store.js';

/**
 * PostgreSQL implementation of SnapshotStore.
 * 
 * Security guarantees:
 * - Snapshots are cache/optimization only, not authoritative
 * - Replacement allowed via UPSERT (events remain source of truth)
 * - No delete capabilities exposed
 * - Cell isolation: all operations scoped by cell_id
 */
export class PostgresSnapshotStore implements SnapshotStore {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Save or update a snapshot for a cell.
   * Uses UPSERT to allow snapshot replacement (cache optimization).
   */
  async saveSnapshot(snapshot: CellSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO snapshots (cell_id, version, state, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (cell_id) DO UPDATE SET
         version = EXCLUDED.version,
         state = EXCLUDED.state,
         updated_at = CURRENT_TIMESTAMP`,
      [snapshot.metadata.cellId, snapshot.metadata.version, JSON.stringify(snapshot.cell)]
    );
  }

  /**
   * Get the latest snapshot for a cell.
   */
  async getLatestSnapshot(cellId: CellId): Promise<CellSnapshot | null> {
    const result = await this.pool.query(
      `SELECT cell_id, version, state, updated_at
       FROM snapshots
       WHERE cell_id = $1`,
      [cellId]
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      metadata: {
        cellId: row.cell_id,
        version: row.version,
        timestamp: row.updated_at.getTime() / 1000
      },
      cell: JSON.parse(row.state)
    };
  }

  /**
   * Get a snapshot at a specific version.
   * Note: Since we only store latest snapshot, this returns the snapshot
   * only if its version matches exactly.
   */
  async getSnapshotAtVersion(cellId: CellId, version: number): Promise<CellSnapshot | null> {
    const result = await this.pool.query(
      `SELECT cell_id, version, state, updated_at
       FROM snapshots
       WHERE cell_id = $1 AND version = $2`,
      [cellId, version]
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      metadata: {
        cellId: row.cell_id,
        version: row.version,
        timestamp: row.updated_at.getTime() / 1000
      },
      cell: JSON.parse(row.state)
    };
  }

  /**
   * Check if a snapshot exists for a cell.
   */
  async hasSnapshot(cellId: CellId): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM snapshots WHERE cell_id = $1 LIMIT 1`,
      [cellId]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }
}
