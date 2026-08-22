# Zinesh V2 production runtime contract

This document is the provider-neutral runtime injection contract for secrets and TLS
material. It does not select Docker Compose, Kubernetes, or a cloud vendor. Any
platform that can supply the files and environment variables below satisfies the
contract.

The process never accepts secret or certificate **values** from the environment.
Environment variables carry **paths only**.

## Canonical layout

Mount a read-only directory at `/run/zinesh-tls` containing:

| File | Role | Mode | Env var |
|---|---|---|---|
| `/run/zinesh-tls/database-password` | PostgreSQL password | `0600` | `PG_PASSWORD_FILE` |
| `/run/zinesh-tls/database-ca.pem` | PostgreSQL server CA | `0644` or stricter | `PG_TLS_CA_PATH` |
| `/run/zinesh-tls/certificate.pem` | HTTPS server certificate | `0644` or stricter | `TLS_CERTIFICATE_PATH` |
| `/run/zinesh-tls/private-key.pem` | HTTPS private key | `0600` | `TLS_PRIVATE_KEY_PATH` |

A provider may place the files elsewhere. The env vars must then point at those
paths. The canonical layout above is what CI verifies.

## Identity and filesystem

- Container user and group: `1000:1000`
- Root filesystem: read-only
- Secret/TLS directory: read-only mount (the process cannot rewrite material)
- Linux capabilities: none
- `no-new-privileges`
- Files: regular files, owned by `1000:1000`
- Password and private key: `(mode & 0o077) === 0` (`0600`)
- CA and certificate: not world-writable; `0644` is acceptable because they are
  public material

## PostgreSQL TLS

- `PG_TLS_MODE=verify-full` is required
- `PGHOST`, `PGPORT`, `PGDATABASE`, and `PGUSER` are required non-secret identity
- `PGPASSWORD` is rejected
- TLS bypass variables (`PGSSLMODE`, `PG_TLS_REJECT_UNAUTHORIZED`,
  `PG_TLS_SERVER_NAME`, `NODE_TLS_REJECT_UNAUTHORIZED`) are rejected

The runtime authenticates the PostgreSQL server with the mounted CA. There is no
insecure TLS mode in this contract.

## HTTPS material

HTTPS certificate and private key are runtime mounts, never image content. The
private key must not be group- or world-accessible.

## Image boundary

The OCI image must not contain:

- password files or password values
- `.pem` / `.key` / other certificate or key material
- `/run/zinesh-tls` contents
- `PGPASSWORD` or inline private keys in image history

## Rotation

This phase does **not** reload password, CA, or TLS material in-process.

Rotation procedure:

1. Present the replacement files on the read-only mount (new mount or replaced
   files visible to the next process).
2. Send `SIGTERM` to the running process.
3. Start a new process so it reads the files at startup.

Until restart, the previous in-memory password and CA remain in use.

## Fail-closed startup

Missing files, non-regular files, group/world-accessible password files, invalid
password content, invalid CA PEM, or any forbidden TLS bypass variable must exit
the process with status `1`. Errors name the variable. They must not print
password, CA, or private-key contents, connection strings, or driver internals.

## Process probes

The public HTTPS listener serves unauthenticated `GET /live` and `GET /ready`.
There is no plaintext health port.

Probe requests still require TLS and an allowed `Host`. Orchestrators must send
`Host` from `TLS_ALLOWED_HOSTS`. Query strings are not accepted (`GET /ready?x`
is `404`). `Authorization` is ignored and not parsed.

| Path | Ready meaning |
|---|---|
| `GET /live` | Process can answer. No PostgreSQL, schema, JWKS, or telemetry check. `200` during graceful shutdown. |
| `GET /ready` | Listener is up, runtime is not shutting down, PostgreSQL answers `SELECT 1`, schema is exactly the expected version, and the pool is not ended. |

Bodies are opaque: `{"status":"ok"}` or `{"status":"unavailable"}`. They never
include schema version, host, path, pool state, driver errors, or telemetry.

`GET /ready` becoming `503` is the drain signal. `POST /commands` after
`beginShutdown()` returns `503 {"error":{"code":"RUNTIME_UNAVAILABLE"}}`.
Liveness stays `200` until the process exits.

## Schema apply ownership

Schema apply is a **one-shot command on the same production artifact**. It is not
the serving process.

| Command | Role |
|---|---|
| `node dist/composition/migrate.js` | Apply schema, verify expected version, exit |
| `node dist/composition/main.js` | Serve commands. Verify schema only. Never migrate. |

Release order:

1. Run the schema apply job with the new image and the same PostgreSQL TLS/secret
   contract (`PG_PASSWORD_FILE`, `PG_TLS_CA_PATH`, `PG_TLS_MODE=verify-full`).
2. The job must exit `0`. Failure is opaque (`Invalid configuration: ...` or
   `Persistence startup failed`).
3. Only then start or replace serving replicas of that image.

Serving replicas call `verifyExpectedVersion()` at startup and on `/ready`.
Schema version equality is exact: this image requires `{1,2,3,4}`. A newer or
older schema is not ready. There is no mixed-version compatibility window.

Concurrent apply jobs are serialized by the existing PostgreSQL advisory lock.
A failed apply rolls back its transaction. There are **no down migrations**.
Release rollback of a successful apply is a previous image plus restore of a
pre-apply backup. See [production backup and restore](production-backup.md).

The apply command does not create HTTPS, listen, initialize JWT, or serve
`/live` or `/ready`. It does not dump or restore PostgreSQL.

## Out of scope

Registry, signing, deployment automation, mixed-version rollouts, payment
integration, and WAL/PITR replication are not part of this contract.

Logical PostgreSQL backup and restore are defined in
[production-backup.md](production-backup.md).
