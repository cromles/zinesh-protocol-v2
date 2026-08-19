import type { Pool, PoolClient } from 'pg';

export const EXPECTED_SCHEMA_VERSION = 3;

const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT NOT NULL, cell_id TEXT NOT NULL, version BIGINT NOT NULL,
  timestamp BIGINT NOT NULL, type TEXT NOT NULL, payload JSONB NOT NULL,
  PRIMARY KEY (cell_id, version), CONSTRAINT events_event_id_unique UNIQUE (event_id),
  CONSTRAINT events_version_positive CHECK (version > 0),
  CONSTRAINT events_timestamp_nonneg CHECK (timestamp >= 0)
);
CREATE INDEX IF NOT EXISTS idx_events_cell_version ON events (cell_id, version ASC);
CREATE TABLE IF NOT EXISTS snapshots (
  cell_id TEXT NOT NULL PRIMARY KEY, version BIGINT NOT NULL, state JSONB NOT NULL,
  CONSTRAINT snapshots_version_positive CHECK (version > 0)
);
CREATE TABLE IF NOT EXISTS command_executions (
  command_id TEXT NOT NULL PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT
);`;

const PRINCIPAL_SCHEMA = `
CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('ACTOR','GATEWAY','SYSTEM')),
  actor_id TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  mapping_version BIGINT NOT NULL DEFAULT 1 CHECK (mapping_version > 0),
  CONSTRAINT principal_actor_shape CHECK (
    (principal_type = 'ACTOR' AND actor_id IS NOT NULL AND length(actor_id) > 0) OR
    (principal_type IN ('GATEWAY','SYSTEM') AND actor_id IS NULL)
  )
);
CREATE UNIQUE INDEX principals_actor_id_unique ON principals(actor_id) WHERE actor_id IS NOT NULL;

CREATE TABLE external_identities (
  issuer TEXT NOT NULL CHECK (length(issuer) > 0),
  subject TEXT NOT NULL CHECK (length(subject) > 0),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  PRIMARY KEY (issuer, subject)
);

CREATE TABLE principal_capabilities (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN ('ACT_AS_SELF','CONFIRM_FUNDING')),
  PRIMARY KEY (principal_id, capability)
);

CREATE OR REPLACE FUNCTION enforce_principal_capability() RETURNS trigger AS $$
DECLARE ptype TEXT;
BEGIN
  SELECT principal_type INTO ptype FROM principals WHERE principal_id = NEW.principal_id;
  IF (ptype = 'ACTOR' AND NEW.capability = 'ACT_AS_SELF') OR
     (ptype = 'GATEWAY' AND NEW.capability = 'CONFIRM_FUNDING') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'capability not allowed for principal type' USING ERRCODE = '23514';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER principal_capability_guard BEFORE INSERT OR UPDATE ON principal_capabilities
FOR EACH ROW EXECUTE FUNCTION enforce_principal_capability();

CREATE TABLE principal_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  principal_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  actor_id TEXT,
  operation TEXT NOT NULL,
  mapping_version BIGINT NOT NULL,
  capability TEXT,
  occurred_at BIGINT NOT NULL CHECK (occurred_at >= 0),
  correlation_id TEXT NOT NULL CHECK (length(correlation_id) > 0)
);`;

const PRINCIPAL_IMMUTABILITY = `
CREATE OR REPLACE FUNCTION prevent_principal_type_change() RETURNS trigger AS $$
BEGIN
  IF NEW.principal_type <> OLD.principal_type THEN
    RAISE EXCEPTION 'principal type is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER principal_type_immutable BEFORE UPDATE OF principal_type ON principals
FOR EACH ROW EXECUTE FUNCTION prevent_principal_type_change();

CREATE OR REPLACE FUNCTION prevent_identity_rebinding() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'external identity mappings are immutable; attach a new identity explicitly'
    USING ERRCODE = '23514';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER external_identity_immutable BEFORE UPDATE OR DELETE ON external_identities
FOR EACH ROW EXECUTE FUNCTION prevent_identity_rebinding();`;

export class SchemaVersionError extends Error {
  constructor(message: string) { super(message); this.name = 'SchemaVersionError'; }
}

export class PostgresMigrator {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [0x5a494e45]);
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.baselineExistingCore(client);
      const rows = await client.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
      const applied = new Set(rows.rows.map((row) => row.version));
      if (!applied.has(1)) {
        await client.query(CORE_SCHEMA);
        await client.query('INSERT INTO schema_migrations(version,name) VALUES (1,$1)', ['core-event-schema']);
      }
      if (!applied.has(2)) {
        await client.query(PRINCIPAL_SCHEMA);
        await client.query('INSERT INTO schema_migrations(version,name) VALUES (2,$1)', ['durable-principal-authority']);
      }
      if (!applied.has(3)) {
        await client.query(PRINCIPAL_IMMUTABILITY);
        await client.query('INSERT INTO schema_migrations(version,name) VALUES (3,$1)', ['principal-identity-immutability']);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  private async baselineExistingCore(client: PoolClient): Promise<void> {
    const existing = await client.query<{ exists: boolean }>(
      `SELECT to_regclass('public.events') IS NOT NULL AS exists`,
    );
    if (existing.rows[0]?.exists === true) {
      await client.query(`INSERT INTO schema_migrations(version,name) VALUES (1,$1)
        ON CONFLICT (version) DO NOTHING`, ['core-event-schema-baseline']);
    }
  }

  async verifyExpectedVersion(): Promise<void> {
    let result;
    try {
      result = await this.pool.query<{ version: number }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
    } catch {
      throw new SchemaVersionError('Database schema is not initialized');
    }
    const versions = result.rows.map((row) => row.version);
    if (versions.length !== EXPECTED_SCHEMA_VERSION ||
        versions.some((version, index) => version !== index + 1)) {
      throw new SchemaVersionError(`Expected schema version ${EXPECTED_SCHEMA_VERSION}`);
    }
  }
}
