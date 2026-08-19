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
import { InMemoryCommandExecutionStore } from './in-memory-command-execution-store';

export class InMemoryPersistenceAdapter implements PersistenceAdapter {
  readonly eventStore: InMemoryEventStore;
  readonly snapshotStore: InMemorySnapshotStore;
  readonly commandExecutionStore: InMemoryCommandExecutionStore;

  constructor() {
    this.eventStore = new InMemoryEventStore();
    this.snapshotStore = new InMemorySnapshotStore();
    this.commandExecutionStore = new InMemoryCommandExecutionStore(this.eventStore);
  }

  async connect(): Promise<void> {
    // No-op for in-memory implementation.
  }

  async disconnect(): Promise<void> {
    // No-op for in-memory implementation.
  }
}
