/**
 * Zinesh 2.0 - In-Memory Event Store Implementation
 * 
 * A deterministic, in-memory implementation of the EventStore interface.
 * Designed for testing and development use.
 * 
 * Features:
 * - Fully deterministic (no randomness, no I/O)
 * - Replay detection via eventId tracking
 * - Chronological ordering of events
 * - Thread-safe operations (single-threaded by design)
 * 
 * @see src/adapters/event-store.ts - Event store interface
 */

import type { CellId, Event } from '../core/types.js';
import type { EventStore } from './event-store.js';
import { ZineshError, ZineshErrorCode } from '../core/types.js';

/**
 * Internal storage structure for events indexed by cell ID.
 */
interface EventStorage {
  events: Map<string, Event[]>; // cellId -> events array
  eventIndex: Map<string, Set<string>>; // eventId -> set of cellIds (for replay detection)
}

/**
 * In-memory event store implementation.
 * 
 * This implementation stores events in memory using Maps for O(1) lookups.
 * Events are maintained in insertion order for each cell.
 */
export class InMemoryEventStore implements EventStore {
  private storage: EventStorage;

  constructor() {
    this.storage = {
      events: new Map(),
      eventIndex: new Map(),
    };
  }

  /**
   * Append events to the store.
   * 
   * @param cellId - The cell ID these events belong to
   * @param events - The events to append
   * @throws ZineshError if any event has already been stored
   */
  async appendEvents(cellId: CellId, events: readonly Event[]): Promise<void> {
    // Check for replay attempts
    for (const event of events) {
      if (this.storage.eventIndex.has(event.eventId)) {
        throw new ZineshError(
          ZineshErrorCode.ReplayDetected,
          `Event ${event.eventId} has already been stored`
        );
      }
    }

    // Get or create events array for this cell
    let cellEvents = this.storage.events.get(cellId);
    if (!cellEvents) {
      cellEvents = [];
      this.storage.events.set(cellId, cellEvents);
    }

    // Append events and index them
    for (const event of events) {
      cellEvents.push(event);
      
      // Index by eventId for replay detection
      const cellsWithEvent = this.storage.eventIndex.get(event.eventId) || new Set();
      cellsWithEvent.add(cellId);
      this.storage.eventIndex.set(event.eventId, cellsWithEvent);
    }
  }

  /**
   * Retrieve all events for a cell, ordered by timestamp.
   * 
   * @param cellId - The cell ID to retrieve events for
   * @returns Array of events in chronological order
   */
  async getEventsForCell(cellId: CellId): Promise<readonly Event[]> {
    const events = this.storage.events.get(cellId);
    if (!events || events.length === 0) {
      return [];
    }

    // Return a copy sorted by timestamp (defensive copy)
    return [...events].sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Check if an event exists.
   * 
   * @param eventId - The event ID to check
   * @returns True if the event exists
   */
  async hasEvent(eventId: string): Promise<boolean> {
    return this.storage.eventIndex.has(eventId);
  }

  /**
   * Get the version (event count) for a cell.
   * 
   * @param cellId - The cell ID
   * @returns Number of events for the cell
   */
  async getVersion(cellId: CellId): Promise<number> {
    const events = this.storage.events.get(cellId);
    return events ? events.length : 0;
  }

  /**
   * Clear all events from the store.
   * 
   * WARNING: Intended for testing only.
   */
  async clear(): Promise<void> {
    this.storage.events.clear();
    this.storage.eventIndex.clear();
  }
}
