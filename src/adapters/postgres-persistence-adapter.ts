import { Pool } from 'pg';
import { Cell, CellId, Event } from '../core/types.js';
import { PersistenceAdapter, LoadCellResult } from './persistence-adapter.js';
import { PostgresEventStore } from './postgres-event-store.js';
import { PostgresSnapshotStore } from './postgres-snapshot-store.js';
import { CellSnapshot } from './snapshot-store.js';

/**
 * PostgreSQL implementation of PersistenceAdapter.
 * 
 * This is a passive facade that orchestrates EventStore and SnapshotStore.
 * It has ZERO protocol authority - all state transitions happen in the kernel.
 * 
 * Security guarantees:
 * - No event history deletion capability
 * - No global destructive operations
 * - No kernel bypass
 * - Cell isolation maintained
 */
export class PostgresPersistenceAdapter implements PersistenceAdapter {
  private eventStore: PostgresEventStore;
  private snapshotStore: PostgresSnapshotStore;
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
    this.eventStore = new PostgresEventStore(pool);
    this.snapshotStore = new PostgresSnapshotStore(pool);
  }

  /**
   * Save a cell's state to persistence.
   * Appends events and optionally creates a snapshot.
   */
  async saveCell(cell: Cell, createSnapshot?: boolean): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Get current version to determine which events are new
      const currentVersion = await this.eventStore.getVersion(cell.id);
      
      // Filter events that haven't been persisted yet
      const newEvents = cell.eventLog.filter(e => e.version > currentVersion);

      // Append new events
      if (newEvents.length > 0) {
        for (const event of newEvents) {
          const payload = extractPayload(event);
          await client.query(
            `INSERT INTO events (id, cell_id, version, type, payload)
             VALUES ($1, $2, $3, $4, $5)`,
            [event.eventId, cell.id, event.version, event.type, JSON.stringify(payload)]
          );
        }
      }

      // Create snapshot if requested
      if (createSnapshot && cell.eventLog.length > 0) {
        const latestEvent = cell.eventLog[cell.eventLog.length - 1]!;
        await client.query(
          `INSERT INTO snapshots (cell_id, version, state, updated_at)
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
           ON CONFLICT (cell_id) DO UPDATE SET
             version = EXCLUDED.version,
             state = EXCLUDED.state,
             updated_at = CURRENT_TIMESTAMP`,
          [cell.id, latestEvent.version, JSON.stringify(cell)]
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
   * Load a cell from persistence.
   * Returns the cell with snapshot usage indicator.
   */
  async loadCell(cellId: CellId): Promise<LoadCellResult> {
    const snapshot = await this.snapshotStore.getLatestSnapshot(cellId);
    const events = await this.eventStore.getEventsForCell(cellId);

    if (events.length === 0 && !snapshot) {
      return { found: false, snapshotUsed: false };
    }

    let cell: Cell | undefined = undefined;
    let snapshotUsed = false;

    if (snapshot) {
      cell = snapshot.cell;
      snapshotUsed = true;
      // Caller must replay events after snapshot through kernel
    } else if (events.length > 0) {
      // No snapshot, caller must replay all events from beginning
      snapshotUsed = false;
    }

    return {
      found: true,
      ...(cell !== undefined ? { cell } : {}),
      snapshotUsed
    };
  }

  /**
   * Check if a cell exists in persistence.
   */
  async cellExists(cellId: CellId): Promise<boolean> {
    const hasEvents = await this.eventStore.getVersion(cellId).then(v => v > 0);
    if (hasEvents) {
      return true;
    }
    return await this.snapshotStore.hasSnapshot(cellId);
  }

  // Delegate EventStore methods
  async appendEvents(cellId: CellId, events: readonly Event[]): Promise<void> {
    return this.eventStore.appendEvents(cellId, events);
  }

  async getEventsForCell(cellId: CellId): Promise<readonly Event[]> {
    return this.eventStore.getEventsForCell(cellId);
  }

  async hasEvent(eventId: string): Promise<boolean> {
    return this.eventStore.hasEvent(eventId);
  }

  async getVersion(cellId: CellId): Promise<number> {
    return this.eventStore.getVersion(cellId);
  }

  // Delegate SnapshotStore methods
  async saveSnapshot(snapshot: CellSnapshot): Promise<void> {
    return this.snapshotStore.saveSnapshot(snapshot);
  }

  async getLatestSnapshot(cellId: CellId): Promise<CellSnapshot | null> {
    return this.snapshotStore.getLatestSnapshot(cellId);
  }

  async getSnapshotAtVersion(cellId: CellId, version: number): Promise<CellSnapshot | null> {
    return this.snapshotStore.getSnapshotAtVersion(cellId, version);
  }

  async hasSnapshot(cellId: CellId): Promise<boolean> {
    return this.snapshotStore.hasSnapshot(cellId);
  }
}

function extractPayload(event: Event): Record<string, unknown> {
  const e = event as unknown as Record<string, unknown>;
  const { eventId, cellId, timestamp, version, type, ...payload } = e;
  return payload;
}
