/**
 * ZINESH PROTOCOL V2 — InMemorySnapshotStore
 *
 * Reference implementation of SnapshotStore backed by an in-memory Map.
 *
 * Guarantees:
 *   - save uses UPSERT: replaces previous snapshot for the cell
 *   - load returns a deep-enough copy that caller mutation cannot affect the store
 *   - Store never generates snapshot version or derives snapshot content
 *   - Cell isolation: Cell A snapshot never visible in Cell B load
 *   - No randomness, no Date.now(), no global mutable state beyond the Map
 */

import type { CellId } from '../core/types';
import type { Snapshot, SnapshotStore } from './snapshot-store';

export class InMemorySnapshotStore implements SnapshotStore {
  /** Cell-isolated snapshot registry. Never exposed directly to callers. */
  private readonly snapshots: Map<CellId, Snapshot> = new Map();

  async save(cellId: CellId, snapshot: Snapshot): Promise<void> {
    // Store a structural copy so caller mutations after save do not affect the store.
    // CellState contains only primitive values and readonly branded types,
    // so a spread copy of both the snapshot and the nested state is sufficient.
    this.snapshots.set(cellId, {
      cellId:   snapshot.cellId,
      version:  snapshot.version,
      state:    { ...snapshot.state },
    });
  }

  async load(cellId: CellId): Promise<Snapshot | null> {
    const stored = this.snapshots.get(cellId);
    if (stored === undefined) {
      return null;
    }
    // Return a defensive copy so caller cannot mutate the stored snapshot.
    return {
      cellId:  stored.cellId,
      version: stored.version,
      state:   { ...stored.state },
    };
  }
}
