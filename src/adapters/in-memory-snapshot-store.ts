/**
 * Zinesh 2.0 - In-Memory Snapshot Store Implementation
 * 
 * A deterministic, in-memory implementation of the SnapshotStore interface.
 * Designed for testing and development use.
 * 
 * Features:
 * - Fully deterministic (no randomness, no I/O)
 * - Multiple snapshots per cell (versioned)
 * - O(1) lookup by cell ID and version
 * 
 * @see src/adapters/snapshot-store.ts - Snapshot store interface
 */

import type { CellId } from '../core/types.js';
import type { SnapshotStore, CellSnapshot } from './snapshot-store.js';

/**
 * Internal storage structure for snapshots indexed by cell ID.
 * Maps cellId to a Map of version -> snapshot.
 */
interface SnapshotStorage {
  snapshots: Map<string, Map<number, CellSnapshot>>; // cellId -> (version -> snapshot)
}

/**
 * In-memory snapshot store implementation.
 * 
 * This implementation stores snapshots in memory using nested Maps for O(1) lookups.
 * Each cell can have multiple snapshots at different versions.
 */
export class InMemorySnapshotStore implements SnapshotStore {
  private storage: SnapshotStorage;

  constructor() {
    this.storage = {
      snapshots: new Map(),
    };
  }

  /**
   * Save a snapshot.
   * 
   * @param snapshot - The snapshot to save
   */
  async saveSnapshot(snapshot: CellSnapshot): Promise<void> {
    const { cellId } = snapshot.metadata;
    
    // Get or create version map for this cell
    let versionMap = this.storage.snapshots.get(cellId);
    if (!versionMap) {
      versionMap = new Map();
      this.storage.snapshots.set(cellId, versionMap);
    }

    // Store the snapshot at its version
    versionMap.set(snapshot.metadata.version, snapshot);
  }

  /**
   * Get the latest snapshot for a cell.
   * 
   * @param cellId - The cell ID
   * @returns The latest snapshot, or null if none exists
   */
  async getLatestSnapshot(cellId: CellId): Promise<CellSnapshot | null> {
    const versionMap = this.storage.snapshots.get(cellId);
    if (!versionMap || versionMap.size === 0) {
      return null;
    }

    // Find the snapshot with the highest version
    let latestVersion = -1;
    let latestSnapshot: CellSnapshot | null = null;

    for (const [version, snapshot] of versionMap.entries()) {
      if (version > latestVersion) {
        latestVersion = version;
        latestSnapshot = snapshot;
      }
    }

    return latestSnapshot;
  }

  /**
   * Get a snapshot at a specific version.
   * 
   * @param cellId - The cell ID
   * @param version - The version to retrieve
   * @returns The snapshot at that version, or null if not found
   */
  async getSnapshotAtVersion(cellId: CellId, version: number): Promise<CellSnapshot | null> {
    const versionMap = this.storage.snapshots.get(cellId);
    if (!versionMap) {
      return null;
    }

    return versionMap.get(version) ?? null;
  }

  /**
   * Check if a snapshot exists for a cell.
   * 
   * @param cellId - The cell ID
   * @returns True if any snapshot exists for the cell
   */
  async hasSnapshot(cellId: CellId): Promise<boolean> {
    const versionMap = this.storage.snapshots.get(cellId);
    return versionMap !== undefined && versionMap.size > 0;
  }

  /**
   * Delete all snapshots for a cell.
   * 
   * @param cellId - The cell ID
   */
  async deleteSnapshots(cellId: CellId): Promise<void> {
    this.storage.snapshots.delete(cellId);
  }

  /**
   * Clear all snapshots from the store.
   * 
   * WARNING: Intended for testing only.
   */
  async clear(): Promise<void> {
    this.storage.snapshots.clear();
  }
}
