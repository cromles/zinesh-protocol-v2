/**
 * Zinesh 2.0 - Snapshot Store Interface
 * 
 * This module defines the abstraction for persisting and retrieving cell snapshots.
 * Snapshots are used to optimize replay performance by storing periodic state checkpoints.
 * 
 * @see src/core/types.ts - Domain types
 */

import type { Cell, CellId } from '../core/types.js';

/**
 * Snapshot metadata for tracking snapshot versions.
 */
export interface SnapshotMetadata {
  readonly cellId: CellId;
  readonly version: number; // Event version at snapshot time
  readonly timestamp: number;
}

/**
 * A snapshot containing the cell state and metadata.
 */
export interface CellSnapshot {
  readonly metadata: SnapshotMetadata;
  readonly cell: Cell;
}

/**
 * Snapshot store interface for persisting and retrieving cell snapshots.
 * 
 * Design principles:
 * - Snapshots are optimization checkpoints, not the source of truth
 * - The event log is always the authoritative state source
 * - Snapshots can be created at any version for performance optimization
 */
export interface SnapshotStore {
  /**
   * Save a snapshot of the cell state.
   * 
   * @param snapshot - The snapshot to save
   * @returns Promise resolving on success, rejecting on failure
   */
  saveSnapshot(snapshot: CellSnapshot): Promise<void>;

  /**
   * Retrieve the latest snapshot for a specific cell.
   * 
   * @param cellId - The cell ID to retrieve the snapshot for
   * @returns Promise resolving to the snapshot, or null if none exists
   */
  getLatestSnapshot(cellId: CellId): Promise<CellSnapshot | null>;

  /**
   * Retrieve a snapshot at a specific version (if available).
   * 
   * @param cellId - The cell ID to retrieve the snapshot for
   * @param version - The event version to retrieve
   * @returns Promise resolving to the snapshot, or null if not available
   */
  getSnapshotAtVersion(cellId: CellId, version: number): Promise<CellSnapshot | null>;

  /**
   * Check if a snapshot exists for a cell.
   * 
   * @param cellId - The cell ID to check
   * @returns Promise resolving to true if a snapshot exists
   */
  hasSnapshot(cellId: CellId): Promise<boolean>;
}
