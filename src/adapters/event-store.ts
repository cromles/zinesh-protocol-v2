/**
 * Zinesh 2.0 - Event Store Interface
 * 
 * This module defines the abstraction for persisting and retrieving events.
 * The interface is designed to be implemented by various storage backends
 * (in-memory, PostgreSQL, etc.).
 * 
 * @see src/core/types.ts - Domain types
 */

import type { CellId, Event } from '../core/types.js';

/**
 * Event store interface for persisting and retrieving events.
 * 
 * Design principles:
 * - Append-only: Events are immutable once stored
 * - Order matters: Events must be retrievable in chronological order
 * - Replay support: All events for a cell must be retrievable for reconstruction
 */
export interface EventStore {
  /**
   * Append one or more events to the store.
   * 
   * @param cellId - The cell ID these events belong to
   * @param events - The events to append
   * @returns Promise resolving on success, rejecting on failure
   * @throws If any event has already been stored (replay detection)
   */
  appendEvents(cellId: CellId, events: readonly Event[]): Promise<void>;

  /**
   * Retrieve all events for a specific cell, ordered by timestamp.
   * 
   * @param cellId - The cell ID to retrieve events for
   * @returns Promise resolving to an array of events in chronological order
   * @returns Empty array if no events exist for the cell
   */
  getEventsForCell(cellId: CellId): Promise<readonly Event[]>;

  /**
   * Check if an event with the given eventId exists.
   * 
   * @param eventId - The event ID to check
   * @returns Promise resolving to true if the event exists
   */
  hasEvent(eventId: string): Promise<boolean>;

  /**
   * Get the current version (event count) for a cell.
   * 
   * @param cellId - The cell ID to get the version for
   * @returns Promise resolving to the number of events for the cell
   */
  getVersion(cellId: CellId): Promise<number>;
}
