# Zinesh V2 production backup and restore contract

This document is the provider-neutral logical backup and restore contract for the
production PostgreSQL database. It does not select a cloud vendor, pgBackRest,
Barman, or volume snapshots. Any operator environment that can run `pg_dump` and
`pg_restore` against the existing PostgreSQL TLS/secret contract satisfies it.

Point-in-time recovery, WAL archiving, and physical replication are a later
disaster-recovery phase. They are not this contract.

## Relationship to schema apply

Schema apply remains Step 5:

| Command | Role |
|---|---|
| `node dist/composition/migrate.js` | Apply schema to an empty or behind database, verify `{1,2,3,4}`, exit |
| `node dist/composition/main.js` | Serve. Verify schema only. Never migrate. Never dump. Never restore. |

Backup and restore are **not** serving commands and **not** schema apply.
`migrate.js` is not part of restoring a current dump. The dump already contains
schema, functions, triggers, and `schema_migrations`.

## PostgreSQL logical backup

- Format: PostgreSQL custom-format logical dump (`pg_dump -Fc`)
- Scope: the application database
- Isolation: a consistent dump (PostgreSQL dump snapshot). Do not dump from
  the serving process.
- Client: operator or CI PostgreSQL 16 client. Not the scratch serving image.

Connection uses the same production contract as serving and schema apply:

- `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` — non-secret identity
- `PG_PASSWORD_FILE` — path to the password file (`0600`)
- `PG_TLS_CA_PATH` — path to the server CA
- `PG_TLS_MODE=verify-full`

`PGPASSWORD` is forbidden. TLS bypass variables are forbidden
(`PGSSLMODE` as a Node/runtime bypass, `PG_TLS_REJECT_UNAUTHORIZED`,
`PG_TLS_SERVER_NAME`, `NODE_TLS_REJECT_UNAUTHORIZED`). The dump client maps
`PG_TLS_MODE=verify-full` and `PG_TLS_CA_PATH` onto libpq `verify-full` plus a
CA file. The password is supplied only through a `0600` pgpass file derived from
`PG_PASSWORD_FILE`, never through `PGPASSWORD`.

## Backup file

The dump is a **secret**. It contains escrow events, amounts, actor identifiers,
command idempotency records, and principal mappings.

- Mode: `0600`
- Location: operator-controlled secret storage, or a temporary CI path that is
  deleted after the job
- Must not enter git, the OCI image, image history, or process logs
- stdout/stderr must not print dump contents, passwords, connection strings, or
  certificate material

## What a dump must include

Authoritative:

- `schema_migrations` — exact set `{1,2,3,4}` for this image
- `events` — append-only escrow source of truth
- `command_executions` — durable idempotency; restore together with `events`
- `principals`, `external_identities`, `principal_capabilities`
- `principal_audit` — transactional security audit
- schema objects from versions 2–3 (functions and triggers)

Cache (include; do not treat as source of truth):

- `snapshots` — one cached `CellState` per cell. After restore,
  `snapshot.version <= max(event.version)` for that cell. Snapshot body need not
  equal kernel-evolved state.

Non-authoritative:

- `rate_limit_windows` — TTL limiter state. Empty windows after restore are
  acceptable. Restore success does not depend on them.

## Restore

1. Provision an empty PostgreSQL 16 database or cluster with the same TLS/secret
   contract.
2. `pg_restore` the dump into that empty database.
3. Do **not** run `node dist/composition/migrate.js` on a restored current dump.
4. Start serving replicas of the matching production image
   (`node dist/composition/main.js`). Startup is connect →
   `verifyExpectedVersion()` → listen.
5. Treat the replica as ready only when `GET /ready` returns `200`.

Serving never migrates. Schema equality remains exact `{1,2,3,4}`.

## Restore verification

A restore is successful only when all of the following hold:

- `schema_migrations` is exactly `{1,2,3,4}`
- fixture `events` exist and `kernel.evolve` reconstructs the pre-backup cell
  state (events are source of truth)
- `command_executions` exist; the same `commandId` and fingerprint replay and
  append no new events
- `principals` and `principal_audit` exist
- if a snapshot row exists: `snapshot.version <= max(event.version)` for that
  cell

An empty, unmigrated database must still fail-close serving startup.

## Rollback model

| Failure | Recovery |
|---|---|
| `migrate.js` throws | Existing transactional rollback and advisory lock (schema apply) |
| Serving process crash | Restart the same image. The database is unchanged. |
| Successful schema apply must be undone | Restore a **pre-apply** backup onto a fresh database, then run the **previous** image. There are no down migrations. |
| Corrupt or lost database | Fresh PostgreSQL 16 cluster plus restore of the last good dump, then the matching serving image |

Image rollout is orchestration. This contract defines the database half.

## Security

- Dump, pgpass, and password files are `0600` regular files
- Backup identity is an operator PostgreSQL role, not a serving-process feature
- The serving process does not gain `DELETE` or `TRUNCATE` on `events`
- Fail-closed: missing files, wrong CA, or forbidden password env vars must not
  produce a backup file or a serving process

## Out of scope

WAL archiving, point-in-time recovery, streaming replicas, failover, cloud
snapshot products, registry, signing, deployment manifests, mixed-version
application/schema compatibility, down migrations, and payment integration.
