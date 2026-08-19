/**
 * ZINESH PROTOCOL V2 — InMemoryEventStore
 *
 * Reference implementation of EventStore backed by an in-memory Map.
 *
 * Guarantees:
 *   - Append-only: no event is ever modified or deleted
 *   - Supplied event order is preserved exactly as given
 *   - Supplied versions, timestamps, and payloads are stored verbatim
 *   - Store never generates version, eventId, or timestamp
 *   - getEvents / getEventsSince return shallow copies of the stored slice
 *   - Cell A events are never visible in Cell B queries
 *   - No randomness, no Date.now(), no global mutable state beyond the Map
 *
 * This implementation is deterministic: given the same sequence of
 * append / getEvents calls it always produces the same result.
 */

import type { CellId, Event, Version } from '../core/types';
import type { AppendResult, EventStore } from './event-store';

export class InMemoryEventStore implements EventStore {
  /** Cell-isolated event streams. Never exposed directly to callers. */
  private readonly streams: Map<CellId, Event[]> = new Map();

  async append(cellId: CellId, events: ReadonlyArray<Event>): Promise<AppendResult> {
    if (events.length === 0) {
      return { ok: true };
    }

    const existing = this.streams.get(cellId) ?? [];
    const expectedFirstVersion = (existing.length + 1) as Version;

    // Validate that the batch starts at the expected next version and is consecutive.
    let expectedVersion = expectedFirstVersion;
    for (const event of events) {
      if (event.cellId !== cellId) {
        return {
          ok: false,
          error: {
            kind: 'APPEND_INTEGRITY_ERROR',
            message: `Event cellId ${event.cellId} does not match target cellId ${cellId}`,
          },
        };
      }
      if (event.version !== expectedVersion) {
        return {
          ok: false,
          error: {
            kind: 'APPEND_VERSION_CONFLICT',
            message:
              `Expected version ${expectedVersion} but got ${event.version} ` +
              `(stream has ${existing.length} event(s))`,
          },
        };
      }
      expectedVersion = (expectedVersion + 1) as Version;
    }

    // All checks passed: append verbatim.  Spread to store a copy of the incoming
    // array so that post-append mutation by the caller cannot affect the store.
    const stream = existing.length === 0 ? [] : existing;
    if (existing.length === 0) {
      this.streams.set(cellId, stream);
    }
    for (const event of events) {
      stream.push(event);
    }

    return { ok: true };
  }

  async getEvents(cellId: CellId): Promise<ReadonlyArray<Event>> {
    const stream = this.streams.get(cellId);
    if (stream === undefined || stream.length === 0) {
      return [];
    }
    // Return a shallow copy. Events are readonly objects so shallow copy is safe.
    return [...stream];
  }

  async getEventsSince(cellId: CellId, afterVersion: Version): Promise<ReadonlyArray<Event>> {
    const stream = this.streams.get(cellId);
    if (stream === undefined || stream.length === 0) {
      return [];
    }
    // Events are stored version ASC (append order preserves this).
    // Filter and copy.
    return stream.filter((e) => e.version > afterVersion);
  }
}
