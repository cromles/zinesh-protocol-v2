-- ZINESH PROTOCOL V2 — PostgreSQL Schema
--
-- Constitution rules enforced here:
--   - events is APPEND-ONLY (INSERT + SELECT only; no UPDATE, DELETE, TRUNCATE)
--   - event versions are caller-supplied (NO SERIAL, NO IDENTITY, NO sequence)
--   - event timestamps are caller-supplied (NO DEFAULT NOW(), NO CURRENT_TIMESTAMP)
--   - UNIQUE(cell_id, version) enforces optimistic concurrency
--   - snapshots allow UPSERT (event data does not)
--   - No cross-cell queries; all operations are cell-scoped by application code

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
-- This table is APPEND-ONLY.
-- No UPDATE or DELETE is ever issued against it.
-- Uniqueness on (cell_id, version) detects concurrent duplicate appends.

CREATE TABLE IF NOT EXISTS events (
    event_id  TEXT    NOT NULL,
    cell_id   TEXT    NOT NULL,
    version   BIGINT  NOT NULL,
    timestamp BIGINT  NOT NULL,  -- domain timestamp in ms since Unix epoch; NEVER DB-generated
    type      TEXT    NOT NULL,
    payload   JSONB   NOT NULL,

    -- Composite primary key guarantees:
    --   (a) no duplicate event_id per cell
    --   (b) optimistic concurrency: duplicate (cell_id, version) is rejected
    PRIMARY KEY (cell_id, version),

    -- Secondary uniqueness: event_id must be globally unique
    CONSTRAINT events_event_id_unique UNIQUE (event_id),

    -- Guard: version must be positive (domain rule: first event is version 1)
    CONSTRAINT events_version_positive CHECK (version > 0),

    -- Guard: timestamp must be non-negative
    CONSTRAINT events_timestamp_nonneg CHECK (timestamp >= 0)
);

-- Index to support getEventsSince(cellId, afterVersion) efficiently
CREATE INDEX IF NOT EXISTS idx_events_cell_version
    ON events (cell_id, version ASC);

-- ---------------------------------------------------------------------------
-- snapshots
-- ---------------------------------------------------------------------------
-- Snapshots are a cache.  They are NOT the source of truth.
-- One snapshot per cell (PRIMARY KEY on cell_id).
-- UPSERT (INSERT ... ON CONFLICT DO UPDATE) is the update mechanism.
-- No event-level constraints apply here.

CREATE TABLE IF NOT EXISTS snapshots (
    cell_id TEXT    NOT NULL PRIMARY KEY,
    version BIGINT  NOT NULL,   -- version of last event folded into this snapshot
    state   JSONB   NOT NULL,   -- serialised CellState at that version

    CONSTRAINT snapshots_version_positive CHECK (version > 0)
);

-- Durable command idempotency ledger. The row and its domain events are
-- committed by PostgresCommandExecutionStore in the same transaction.
CREATE TABLE IF NOT EXISTS command_executions (
    command_id  TEXT  NOT NULL PRIMARY KEY,
    fingerprint TEXT  NOT NULL,
    result      TEXT
);
