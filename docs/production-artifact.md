# Zinesh V2 production artifact standard

The production artifact is a single-platform (`linux/amd64`) OCI image built from an exact Git commit. Build and dependency stages use the exact Debian slim Node image. The final stage is `scratch` and receives only the verified Node executable, its required shared libraries, the application, and production dependencies.

## Immutable inputs

- Node.js: `24.16.0`
- npm: `11.13.0`
- Base: `node:24.16.0-bookworm-slim`
- Base linux/amd64 manifest: `sha256:ca520832af80fa37a57c14077ed0fcdd83b5aefccc356059fdc3a9a05b78ae1f`
- Dependencies: `package-lock.json`, installed only with `npm ci --ignore-scripts`
- Timestamp: the source commit timestamp supplied as `SOURCE_DATE_EPOCH`

The reproducibility target is the runtime image subject manifest digest. SBOM and provenance attestations may contain their own build metadata and are not the digest comparison target.

## Runtime contract

- Numeric user and group: `1000:1000`
- Working directory: `/app`
- Entrypoint: `node dist/composition/main.js`
- Stop signal: `SIGTERM`
- Writable application directories: none
- Logs: JSON lines on stdout/stderr
- TLS certificate and private key: read-only runtime mounts, never image content

The private key must be a regular file owned/readable by the runtime identity with no group or world permission bits. The runtime is verified with a read-only root filesystem, all Linux capabilities dropped, and `no-new-privileges`.

## Artifact allowlist

The final `/app` contains only:

- `dist`
- `node_modules` with production dependencies
- `package.json`
- `package-lock.json`

The final image does not contain npm, Corepack, Yarn, a shell, or an operating-system package manager.

Source, tests, development dependencies, Git metadata, local configuration, credentials, TLS material, caches, and coverage are forbidden.

## Supply-chain evidence

CI performs two no-cache builds and requires identical runtime subject digests. BuildKit produces an SPDX SBOM and SLSA provenance for the OCI artifact. Trivy is pinned by its linux/amd64 manifest digest; Critical and High vulnerabilities fail the build unless a future exception is explicit, time-bounded, and reviewed.

Phase B does not push the image, sign it, deploy it, migrate a database, or define rollout policy.
