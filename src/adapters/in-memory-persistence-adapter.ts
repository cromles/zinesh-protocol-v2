/**
 * ZINESH PROTOCOL V2 — InMemoryPersistenceAdapter
 *
 * Reference implementation of PersistenceAdapter using in-memory stores.
 *
 * connect() and disconnect() are no-ops — there are no resources to manage.
 *
 * Contains ZERO business logic, ZERO domain rules, ZERO authorization.
 */

import type { PersistenceAdapter } from './persistence-adapter';
import { InMemoryEventStore } from './in-memory-event-store';
import { InMemorySnapshotStore } from './in-memory-snapshot-store';

export class InMemoryPersistenceAdapter implements PersistenceAdapter {
  readonly eventStore: InMemoryEventStore;
  readonly snapshotStore: InMemorySnapshotStore;

  constructor() {
    this.eventStore = new InMemoryEventStore();
    this.snapshotStore = new InMemorySnapshotStore();
  }

  async connect(): Promise<void> {
    // No-op for in-memory implementation.
  }

  async disconnect(): Promise<void> {
    // No-op for in-memory implementation.
  }
}
