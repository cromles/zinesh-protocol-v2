# Zinesh V2 production release and artifact trust contract

This document is the provider-neutral trust chain for the production OCI
artifact. It does not select GHCR, ECR, GCR, Kubernetes, or Helm. Any OCI
registry that can store a digest-pinned image and Cosign signatures satisfies
the distribution half. CI proves the chain with an ephemeral local registry.

## Artifact identity

The runtime identity is the **linux/amd64 subject manifest digest**:

```
<registry>/<repository>@sha256:<digest>
```

Tags are not authority. Promotion is copying the **same digest**. Promotion is
not a rebuild.

This digest is the Phase B reproducibility target. SBOM and SLSA provenance
attestations may have their own digests; they are not the runtime identity.

## Trust root

CI signs with an ephemeral Cosign key pair. The public key is the trust root for
that build. Production operators use their own long-lived Cosign key or
Sigstore identity. Keyless signing is allowed only when the identity is explicit
and verification is fail-closed against that identity.

The scratch serving image does not contain Cosign, private keys, or registry
credentials.

Signing uses Cosign pinned by linux/amd64 digest, the same pinning style as
Trivy and Grype. Transparency-log upload is not required for the ephemeral CI
key model (`--tlog-upload=false` / `--insecure-ignore-tlog`).

CI tool pins (linux/amd64 manifests):

- Cosign: `gcr.io/projectsigstore/cosign:v2.4.3@sha256:203f193bc86591bbc1a3a39ad3532590652477d1775ccb91221e8d14cfe5c000`
- Ephemeral registry: `registry:2.8.3@sha256:46faa9a1ae6813194b53921a370f2f4f8c5e1aae228a89bceafef5847a6a3278`
- Skopeo: `quay.io/skopeo/stable:v1.17.0@sha256:a5032a59f55ac82e2b5c9e9a8223a5249a31e82ae51f74d63ff356ccbed1adee`

These tools are CI-only. They are not copied into the scratch serving image.

## Chain

1. CI build of the scratch image from the exact Git commit
2. Dual-build reproducibility of the runtime subject digest
3. Attached SPDX SBOM
4. High/Critical Trivy + Grype
5. Attached SLSA provenance
6. Cosign signature of **that subject digest** (not a tag)
7. Push to an OCI registry **by digest**
8. Pull **by digest** and require equality with the signed digest
9. Logical backup ([production-backup.md](production-backup.md))
10. Schema apply with `node dist/composition/migrate.js` from **the same digest**
    ([production-runtime.md](production-runtime.md))
11. Serving replicas of **the same digest** (`node dist/composition/main.js`)
12. `GET /ready` `200`

Unsigned, wrong-key, mutated, or digest-mismatched artifacts are not releasable.

## Verify fail-closed

Verification must check, in order:

1. Expected runtime digest
2. Cosign signature
3. Trusted public key or identity
4. Registry-pulled digest equals the expected digest

Any failure exits `1`. Errors must not print passwords, TLS secrets, Cosign
private keys, registry credentials, or connection strings.

## Release operations

| Operation | Meaning |
|---|---|
| Run / migrate | `verified-registry/image@sha256:D` only |
| Promote | copy digest D to another registry or repository |
| Rollback (code) | previous **signed** digest D_prev |
| Rollback (schema after a successful apply) | D_prev plus restore of a pre-apply backup. No down migrations. |

Migration and serving of a release use the same signed digest. A local mutable
tag is not a production run model.

## Out of scope

Kubernetes, Helm, cloud-vendor registries as a required dependency, in-cluster
admission controllers, payment, deadline schedulers, outbox/inbox, read models,
PITR/WAL, mixed-version serving, and rebuilding to promote.
