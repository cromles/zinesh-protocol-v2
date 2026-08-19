-- Zinesh V2 PostgreSQL Schema
-- Append-only event store and snapshot cache

-- Events table: authoritative, immutable event log
CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY,
    cell_id VARCHAR(255) NOT NULL,
    version BIGINT NOT NULL,
    type VARCHAR(255) NOT NULL,
    payload JSONB NOT NULL,
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints for immutability and ordering
    CONSTRAINT events_cell_version_unique UNIQUE (cell_id, version),
    CONSTRAINT events_version_positive CHECK (version > 0)
);

-- Indexes for efficient cell-scoped queries
CREATE INDEX IF NOT EXISTS idx_events_cell_id ON events (cell_id);
CREATE INDEX IF NOT EXISTS idx_events_cell_version ON events (cell_id, version);

-- Snapshots table: optimization cache, replaceable
CREATE TABLE IF NOT EXISTS snapshots (
    cell_id VARCHAR(255) PRIMARY KEY,
    version BIGINT NOT NULL,
    state JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraint for valid versioning
    CONSTRAINT snapshots_version_positive CHECK (version > 0)
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_snapshots_version ON snapshots (cell_id, version);
