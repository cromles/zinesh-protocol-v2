# Zinesh V2 production artifact standard

The production artifact is a single-platform (`linux/amd64`) OCI image built from an exact Git commit. Build and dependency stages use an exact Alpine Node image. The final stage is `scratch` and receives only the verified Node executable, its required musl/GCC runtime libraries, their filtered Alpine package inventory, the application, and production dependencies.

## Immutable inputs

- Node.js: `24.18.1`
- npm: `11.16.0`
- Base: `node:24.18.1-alpine3.23`
- Base linux/amd64 manifest: `sha256:ba63d8e0b5d4cbc6db9da12ea77ddb35a4783ad653a092ef115cc383526d4369`
- Dependencies: `package-lock.json`, installed only with `npm ci --ignore-scripts`
- Timestamp: the source commit timestamp supplied as `SOURCE_DATE_EPOCH`

The reproducibility target is the runtime image subject manifest digest. SBOM and provenance attestations may contain their own build metadata and are not the digest comparison target.

## Runtime contract

- Numeric user and group: `1000:1000`
- Working directory: `/app`
- Default entrypoint: `node dist/composition/main.js` (serving; verifies schema; never migrates)
- One-shot schema apply: override the entrypoint to `node dist/composition/migrate.js`
- Stop signal: `SIGTERM`
- Writable application directories: none
- Logs: JSON lines on stdout/stderr
- TLS certificate and private key: read-only runtime mounts, never image content
- PostgreSQL password and CA: read-only runtime mounts, never image content. See [production runtime contract](production-runtime.md).

The scratch image does not contain `pg_dump` or `pg_restore`. Backup tooling is
not part of the runtime serving image. Backup and restore run from an operator
or CI PostgreSQL 16 client. See [production backup and restore](production-backup.md).

Schema apply must succeed on this artifact before serving replicas of the same
image are treated as ready. Serving does not run migrations. Schema version
equality is exact. There are no down migrations. Failed apply rolls back its
transaction.

The private key must be a regular file owned/readable by the runtime identity with no group or world permission bits. The runtime is verified with a read-only root filesystem, all Linux capabilities dropped, and `no-new-privileges`.

## Artifact allowlist

The final `/app` contains only:

- `dist`
- `node_modules` with production dependencies
- `package.json`
- `package-lock.json`

The final image does not contain npm, Corepack, Yarn, a shell, or an operating-system package manager.

The native runtime is limited to `musl`, `libgcc`, and `libstdc++`. Their exact Alpine package records remain in `/lib/apk/db/installed`, so an OS scanner can identify the libraries actually copied into the scratch image. Node's embedded OpenSSL version is checked at runtime and the standalone Node executable must appear as a binary component in the SBOM.

Source, tests, development dependencies, Git metadata, local configuration, credentials, TLS material, caches, and coverage are forbidden.

## Supply-chain evidence

CI performs two no-cache builds and requires identical runtime subject digests. BuildKit produces an SPDX SBOM with a digest-pinned Syft generator and SLSA provenance attached to that digest. The SBOM gate requires Node, musl, libgcc, libstdc++, `pg`, and its production tree while rejecting development tooling.

Trivy scans the final OCI artifact's Alpine/native and production npm inventories. Grype independently scans the attached SBOM so the standalone Node binary is included in vulnerability evaluation. Both scanners are pinned by linux/amd64 manifest digest. Critical and High vulnerabilities fail the build; Phase B defines no hidden ignore or exception path.

Phase B does not push the image, sign it, deploy it, migrate a database, or define rollout policy.
