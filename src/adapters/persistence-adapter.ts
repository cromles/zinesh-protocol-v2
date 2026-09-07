/**
 * ZINESH PROTOCOL V2 — PersistenceAdapter interface
 *
 * Facade that groups EventStore and SnapshotStore under a single lifecycle.
 *
 * Rules:
 *   - No business logic
 *   - No state transition
 *   - No authorization
 *   - No time evaluation
 *   - No command processing
 *   - No domain invariant enforcement
 *   - No money calculation
 *   - STORE and RETRIEVE only
 */

import type { EventStore } from './event-store';
import type { SnapshotStore } from './snapshot-store';
import type { CommandExecutionStore } from './command-execution-store';
import type { FundingIntentStore } from './funding-intent-store';
import type { FundingDisputeStore } from './funding-dispute-store';
import type { ProviderFoundationStore } from './provider-foundation-store';

export interface PersistenceAdapter {
  readonly eventStore: EventStore;
  readonly snapshotStore: SnapshotStore;
  readonly commandExecutionStore: CommandExecutionStore;
  readonly fundingIntentStore: FundingIntentStore;
  readonly fundingDisputeStore: FundingDisputeStore;
  readonly providerFoundationStore: ProviderFoundationStore;

  /**
   * Open / initialise the underlying storage.
   * For in-memory implementations this is a no-op.
   * For PostgreSQL this would open a connection pool.
   */
  connect(): Promise<void>;

  /**
   * Release resources held by the underlying storage.
   * For in-memory implementations this is a no-op.
   * For PostgreSQL this would drain and close the connection pool.
   */
  disconnect(): Promise<void>;
}
