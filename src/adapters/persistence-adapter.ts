/**
 * Zinesh 2.0 - Persistence Adapter Interface
 * 
 * This module defines the unified persistence abstraction that combines
 * event store and snapshot store functionality.
 * 
 * The persistence adapter is the primary interface used by the application
 * layer to interact with storage backends.
 * 
 * @see src/adapters/event-store.ts - Event store interface
 * @see src/adapters/snapshot-store.ts - Snapshot store interface
 */

import type { Cell, CellId } from '../core/types.js';
import type { EventStore } from './event-store.js';
import type { SnapshotStore, CellSnapshot } from './snapshot-store.js';

/**
 * Result of loading a cell from persistence.
 */
export interface LoadCellResult {
  readonly found: boolean;
  readonly cell?: Cell;
  readonly snapshotUsed: boolean;
}

/**
 * Persistence adapter interface combining event and snapshot stores.
 * 
 * This interface provides a unified API for:
 * - Storing and retrieving events
 * - Managing snapshots for performance optimization
 * - Loading complete cell state (replaying from events or snapshot)
 * 
 * Design principles:
 * - Events are the source of truth
 * - Snapshots are optional performance optimizations
 * - The adapter handles reconstruction logic
 */
export interface PersistenceAdapter extends EventStore, SnapshotStore {
  /**
   * Save a cell's state to persistence.
   * 
   * This method:
   * 1. Appends any new events from the cell's event log
   * 2. Optionally creates a snapshot if the cell has changed significantly
   * 
   * @param cell - The cell to persist
   * @param createSnapshot - Whether to create a snapshot (default: false)
   * @returns Promise resolving on success, rejecting on failure
   */
  saveCell(cell: Cell, createSnapshot?: boolean): Promise<void>;

  /**
   * Load a cell from persistence.
   * 
   * This method:
   * 1. Retrieves the latest snapshot (if available)
   * 2. Replays events after the snapshot version
   * 3. Returns the reconstructed cell
   * 
   * @param cellId - The cell ID to load
   * @returns Promise resolving to the load result
   */
  loadCell(cellId: CellId): Promise<LoadCellResult>;

  /**
   * Check if a cell exists in persistence.
   * 
   * @param cellId - The cell ID to check
   * @returns Promise resolving to true if the cell exists
   */
  cellExists(cellId: CellId): Promise<boolean>;
}

/**
 * Options for configuring persistence behavior.
 */
export interface PersistenceOptions {
  /**
   * Snapshot threshold: create a snapshot after this many events.
   * Set to 0 to disable automatic snapshots.
   * @default 100
   */
  readonly snapshotThreshold?: number;

  /**
   * Whether to enable automatic snapshots on save.
   * @default true
   */
  readonly autoSnapshot?: boolean;
}
