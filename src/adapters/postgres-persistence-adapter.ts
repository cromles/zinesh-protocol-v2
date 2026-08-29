/**
 * ZINESH PROTOCOL V2 — PostgresPersistenceAdapter
 *
 * PersistenceAdapter implementation backed by PostgreSQL.
 *
 * Constitution compliance:
 *   - No business logic
 *   - No state transitions
 *   - No authorization
 *   - No time evaluation
 *   - No command processing
 *   - No domain invariant enforcement
 *   - STORE and RETRIEVE only
 *
 * Configuration is constructor-injected. No process.env reads inside this file.
 * No hardcoded host, port, database, user, password, or connection string.
 */

import { Pool } from 'pg';
import type { PersistenceAdapter } from './persistence-adapter';
import { PostgresEventStore } from './postgres-event-store';
import { PostgresSnapshotStore } from './postgres-snapshot-store';
import { PostgresCommandExecutionStore } from './postgres-command-execution-store';
import { PostgresPrincipalAuthority } from './postgres-principal-authority';
import { PostgresMigrator } from './postgres-migrator';
import { PostgresRateLimitStore } from './postgres-rate-limit-store';
import { noOpSecurityTelemetry } from '../security/security-observability';
import type { SecurityTelemetry } from '../security/security-observability';
import { PostgresFundingIntentStore } from './postgres-funding-intent-store';
import { PostgresFundingDisputeStore } from './postgres-funding-dispute-store';
import { PostgresProviderFoundationStore } from './postgres-provider-foundation-store';

export interface PostgresConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly tls: {
    readonly mode: 'verify-full';
    readonly ca: string;
  };
}

/** Bounded probe budget. Not a domain rule. Not operator-configurable. */
export const READY_CHECK_TIMEOUT_MS = 500;
const READY_SUCCESS_CACHE_MS = 1_000;

export class PostgresPersistenceAdapter implements PersistenceAdapter {
  private readonly pool: Pool;
  private closed = false;
  private readyCheckInFlight: Promise<boolean> | undefined;
  private readySuccessUntil = 0;
  readonly eventStore: PostgresEventStore;
  readonly snapshotStore: PostgresSnapshotStore;
  readonly commandExecutionStore: PostgresCommandExecutionStore;
  readonly principalAuthority: PostgresPrincipalAuthority;
  readonly migrator: PostgresMigrator;
  readonly rateLimitStore: PostgresRateLimitStore;
  readonly fundingIntentStore: PostgresFundingIntentStore;
  readonly fundingDisputeStore: PostgresFundingDisputeStore;
  readonly providerFoundationStore: PostgresProviderFoundationStore;

  constructor(config: PostgresConfig, telemetry: SecurityTelemetry = noOpSecurityTelemetry) {
    this.pool = new Pool({
      host:     config.host,
      port:     config.port,
      database: config.database,
      user:     config.user,
      password: config.password,
      ssl: {
        ca: config.tls.ca,
        rejectUnauthorized: true,
      },
    });
    this.eventStore    = new PostgresEventStore(this.pool);
    this.snapshotStore = new PostgresSnapshotStore(this.pool);
    this.commandExecutionStore = new PostgresCommandExecutionStore(this.pool);
    this.principalAuthority = new PostgresPrincipalAuthority(this.pool, telemetry);
    this.migrator = new PostgresMigrator(this.pool);
    this.rateLimitStore = new PostgresRateLimitStore(this.pool);
    this.fundingIntentStore = new PostgresFundingIntentStore(this.pool);
    this.fundingDisputeStore = new PostgresFundingDisputeStore(this.pool);
    this.providerFoundationStore = new PostgresProviderFoundationStore(this.pool);
  }

  async connect(): Promise<void> {
    // Verify connectivity by acquiring and immediately releasing a connection.
    const client = await this.pool.connect();
    client.release();
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.readySuccessUntil = 0;
    await this.pool.end();
  }

  /**
   * Orchestrator readiness only. SELECT 1 plus expected schema version.
   * Never migrates. Never throws driver, SQL, host, or secret details.
   */
  readyCheck(): Promise<boolean> {
    if (this.closed) {
      return Promise.resolve(false);
    }
    if (Date.now() < this.readySuccessUntil) {
      return Promise.resolve(true);
    }
    if (this.readyCheckInFlight !== undefined) {
      return this.readyCheckInFlight;
    }
    const pending = this.executeReadyCheck().finally(() => {
      if (this.readyCheckInFlight === pending) {
        this.readyCheckInFlight = undefined;
      }
    });
    this.readyCheckInFlight = pending;
    return pending;
  }

  private async executeReadyCheck(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    try {
      await withTimeout(this.queryReadiness(), READY_CHECK_TIMEOUT_MS);
      if (this.closed) {
        return false;
      }
      this.readySuccessUntil = Date.now() + READY_SUCCESS_CACHE_MS;
      return true;
    } catch {
      return false;
    }
  }

  private async queryReadiness(): Promise<void> {
    await this.pool.query('SELECT 1');
    await this.migrator.verifyExpectedVersion();
  }
}

function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ready-check-timeout')), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
