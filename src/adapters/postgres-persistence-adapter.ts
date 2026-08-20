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

export class PostgresPersistenceAdapter implements PersistenceAdapter {
  private readonly pool: Pool;
  readonly eventStore: PostgresEventStore;
  readonly snapshotStore: PostgresSnapshotStore;
  readonly commandExecutionStore: PostgresCommandExecutionStore;
  readonly principalAuthority: PostgresPrincipalAuthority;
  readonly migrator: PostgresMigrator;
  readonly rateLimitStore: PostgresRateLimitStore;

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
  }

  async connect(): Promise<void> {
    // Verify connectivity by acquiring and immediately releasing a connection.
    const client = await this.pool.connect();
    client.release();
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
  }
}
