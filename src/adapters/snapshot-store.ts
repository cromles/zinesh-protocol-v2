/**
 * ZINESH PROTOCOL V2 — SnapshotStore interface
 *
 * Contract for all SnapshotStore implementations.
 *
 * Rules:
 *   - Snapshot is a CACHE, NOT the source of truth
 *   - Event history is always authoritative
 *   - Store does NOT generate snapshot version
 *   - Store does NOT derive or modify snapshot content
 *   - load returns a defensive copy (or null)
 *   - save uses UPSERT semantics (replaces previous snapshot for the cell)
 *   - No cross-cell access
 *
 * All methods are async to be compatible with future PostgreSQL implementation.
 */

import type { CellId, CellState, Version } from '../core/types';

/**
 * A snapshot packages the reconstructed CellState together with the version
 * of the last event that was folded into it.  The version is required so the
 * application layer can load only new events (getEventsSince(snapshotVersion))
 * rather than replaying the entire stream.
 */
export interface Snapshot {
  readonly cellId: CellId;
  /** Version of the last event folded into this snapshot. */
  readonly version: Version;
  /** The reconstructed cell state at that version. */
  readonly state: CellState;
}

export interface SnapshotStore {
  /**
   * Persist (or replace) a snapshot for a cell.
   * UPSERT: if a snapshot already exists for this cellId, it is overwritten.
   * The store does NOT validate or derive the snapshot content.
   */
  save(cellId: CellId, snapshot: Snapshot): Promise<void>;

  /**
   * Load the most recent snapshot for a cell.
   * Returns null if no snapshot exists.
   * Returns a defensive copy — callers cannot mutate the store through the result.
   */
  load(cellId: CellId): Promise<Snapshot | null>;
}
