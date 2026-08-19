/**
 * ZINESH PROTOCOL V2 — EventStore interface
 *
 * Contract for all EventStore implementations (in-memory, PostgreSQL, …).
 *
 * Rules:
 *   - APPEND-ONLY: no update, no delete, no mutation of existing events
 *   - Store does NOT generate version, timestamp, or eventId
 *   - Store does NOT reorder supplied events
 *   - Store does NOT modify payload
 *   - All queries are scoped to a single cellId — no cross-cell access
 *   - getEvents / getEventsSince return defensive copies
 *
 * All methods are async to be compatible with future PostgreSQL implementation.
 */

import type { CellId, Event, Version } from '../core/types';

export interface EventStoreError {
  readonly kind: 'APPEND_VERSION_CONFLICT' | 'APPEND_INTEGRITY_ERROR';
  readonly message: string;
}

export type AppendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: EventStoreError };

export interface EventStore {
  /**
   * Append one or more events to a cell's event stream.
   *
   * Preconditions the store MAY enforce:
   *   - The first event's version must equal (current stream length + 1)
   *   - Versions within the batch must be consecutive
   *
   * The store MUST NOT:
   *   - Reorder events silently
   *   - Generate or modify versions
   *   - Modify timestamps
   *   - Modify payloads
   *   - Overwrite or delete existing events
   *
   * Returns ok: false with an explicit error rather than silently failing.
   */
  append(cellId: CellId, events: ReadonlyArray<Event>): Promise<AppendResult>;

  /**
   * Retrieve all events for a cell, version ASC.
   * Returns an empty array if no events exist for that cell.
   * Returns a defensive copy — callers cannot mutate the store through the result.
   */
  getEvents(cellId: CellId): Promise<ReadonlyArray<Event>>;

  /**
   * Retrieve events for a cell with version strictly greater than afterVersion,
   * ordered version ASC.
   * Returns an empty array if no matching events exist.
   * Returns a defensive copy.
   */
  getEventsSince(cellId: CellId, afterVersion: Version): Promise<ReadonlyArray<Event>>;
}
