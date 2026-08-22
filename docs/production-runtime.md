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

## Out of scope

Health/readiness endpoints, migrations, backup, registry, signing, deployment,
and payment integration are not part of this contract.
