# Zinesh V2 production rollout contract

This document is the provider-neutral release procedure for a **verified signed
digest**. It does not select Kubernetes, Helm, GHCR, ECR, GCR, or a cloud
vendor. Any operator that can copy a digest, run `pg_dump`/`pg_restore`, and
start the scratch image by digest satisfies it.

CI proves the chain with two ephemeral local registries.

## Release identity

The only production identity is:

```
<registry>/<repository>@sha256:<digest>
```

Tags are not authority. A local mutable tag (`IMAGE_TAG`) is not a release
handle. Promotion is copying digest D. Promotion is not a rebuild.

Migrate and serve of one release MUST use the same verified digest D.
`MIGRATE_IMAGE_DIGEST === SERVE_IMAGE_DIGEST`. Inequality fails the release.

## Ownership

| Stage | Owner | Artifact | Must not |
|---|---|---|---|
| VERIFY | operator / CI Cosign | public trust root + D | run migrate or serve on failure |
| PROMOTE | operator / CI copy | same D in another registry/repository | rebuild |
| BACKUP | operator PostgreSQL 16 client | `pg_dump -Fc` (secret, `0600`) | the serving process |
| MIGRATE | one-shot job of D | `node dist/composition/migrate.js` | the serving process |
| SERVE | replicas of D | `node dist/composition/main.js` | migrate, dump, restore |
| READY | public HTTPS | `GET /ready` → `200` | treat unsigned/mismatched D as ready |

The scratch image does not contain Cosign, `pg_dump`, or `pg_restore`.

## Chain

Fail-closed. If VERIFY fails, stop. Do not migrate. Do not serve. Do not accept ready.

1. **VERIFY D** — Cosign signature, trusted key/identity, digest equality. See
   [production-release.md](production-release.md).
2. **PROMOTE D** — copy D to the destination registry. Pull D. Source digest
   equals destination digest.
3. **PRE-APPLY BACKUP** — `pg_dump -Fc` over the existing TLS/secret contract.
   See [production-backup.md](production-backup.md).
4. **MIGRATE D** — `registry/image@sha256:D` with entrypoint
   `node dist/composition/migrate.js`. Apply, `verifyExpectedVersion()`, exit 0.
5. **SERVE D** — the same `@sha256:D` with `node dist/composition/main.js`.
   Startup is connect → `verifyExpectedVersion()` → listen.
6. **READY** — `GET /ready` `200` with TLS and `Host` from `TLS_ALLOWED_HOSTS`.

Unsigned, wrong-signature, digest-mismatched, or mutated destination artifacts
are not releasable.

## Rollback

| Situation | Action |
|---|---|
| Code rollback | previous **signed** digest `D_prev` |
| Successful schema apply must be undone | restore the **pre-apply** dump onto a fresh database, then serve `D_prev` |
| Lost database | restore the last good dump, then the matching **signed** digest |

There are no down migrations. CI may prove the restore data path with the same
verified digest D (it does not manufacture a second product version). `D_prev`
remains the production rollback identity.

## Out of scope

Kubernetes, Helm, cloud registries as a required dependency, admission
controllers, PITR/WAL, payment, deadline schedulers, outbox/inbox, read models,
mixed-version serving, down migrations, database role/GRANT migrations, and
in-process secret reload.
