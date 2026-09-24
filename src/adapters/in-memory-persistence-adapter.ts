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
import { InMemoryFundingIntentStore } from './in-memory-funding-intent-store';
import { InMemoryProviderFoundationStore } from './in-memory-provider-foundation-store';
import { InMemoryFundingDisputeStore } from './in-memory-funding-dispute-store';
import { InMemoryFundingReceiptStore } from './in-memory-funding-receipt-store';

export class InMemoryPersistenceAdapter implements PersistenceAdapter {
  readonly eventStore: InMemoryEventStore;
  readonly snapshotStore: InMemorySnapshotStore;
  readonly commandExecutionStore: InMemoryCommandExecutionStore;
  readonly fundingIntentStore: InMemoryFundingIntentStore;
  readonly providerFoundationStore: InMemoryProviderFoundationStore;
  readonly fundingDisputeStore: InMemoryFundingDisputeStore;
  readonly fundingReceiptStore: InMemoryFundingReceiptStore;

  constructor() {
    this.providerFoundationStore = new InMemoryProviderFoundationStore();
    this.eventStore = new InMemoryEventStore();
    this.snapshotStore = new InMemorySnapshotStore();
    this.fundingIntentStore = new InMemoryFundingIntentStore();
    this.fundingDisputeStore = new InMemoryFundingDisputeStore(this.providerFoundationStore);
    this.fundingReceiptStore = new InMemoryFundingReceiptStore();
    this.commandExecutionStore = new InMemoryCommandExecutionStore(
      this.eventStore, this.fundingDisputeStore, this.fundingReceiptStore,
    );
  }

  async connect(): Promise<void> {
    // No-op for in-memory implementation.
  }

  async disconnect(): Promise<void> {
    // No-op for in-memory implementation.
  }
}
