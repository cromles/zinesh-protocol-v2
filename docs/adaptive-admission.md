# Adaptive admission contract

Adaptive admission is a narrowing security boundary between verified principal resolution and command execution.
It cannot authenticate a caller, grant a capability, rewrite a command, bypass the deterministic kernel, or decide an
escrow outcome. Existing authentication, principal, capability, funding evidence, idempotency, and kernel checks remain
authoritative.

## Decision model

Every candidate policy returns one bounded decision:

| Disposition | Enforcement meaning |
| --- | --- |
| `ALLOW` | Continue to the existing authorization and kernel boundaries. It does not grant authority. |
| `LIMIT` | Reject with the existing opaque rate-limit contract and a bounded retry interval. |
| `CHALLENGE` | Reject until a separate, explicitly implemented proof protocol exists. |
| `QUARANTINE` | Reject this command while an active, time-bounded quarantine exists. |
| `DENY` | Reject with the opaque command-not-permitted contract. |

The policy receives only principal identity, principal type, bounded capabilities, mapping version, and command type.
Credentials, JWTs, request bodies, amounts, descriptions, evidence, and arbitrary headers are excluded.

## Modes and failure behavior

- `ENFORCE`: every non-`ALLOW` decision rejects. Policy exceptions and malformed decisions fail closed.
- `SHADOW`: candidate decisions are recorded but cannot block, authorize, mutate, settle, release, or refund anything.

Policy versions and decisions are included in security events but are not metric labels. This keeps audit correlation
without allowing unbounded metric cardinality. Error details from a policy dependency are never serialized.

## Safe learning lifecycle

1. Create a new immutable policy version.
2. Run it in `SHADOW` against live-shaped, data-minimized signals.
3. Replay the version against regression and hostile-command corpora.
4. Pass invariant, chaos, typecheck, build, artifact, and rollout gates.
5. Promote that exact reviewed version to `ENFORCE`.
6. Roll back to the previous signed version if rejection behavior is unsafe.

No online learner may publish its own policy directly. A future learner can propose a version, but review, deterministic
replay, and signed deployment remain mandatory. Automatic settlement authority is permanently outside this boundary.

## Current implementation boundary

Adaptive admission is integrated into authenticated command ingress. It provides the versioned policy interface,
immutable minimal context, bounded decisions, shadow isolation, enforcement failure safety, and structured
observability.

Production composition also evaluates an append-only PostgreSQL quarantine registry before command execution. An
issuance has a maximum 30-day TTL and becomes ineffective automatically at expiry. Early release creates a separate
immutable release record; it never edits or deletes the issuance. A registry failure propagates to the admission
controller and fails closed in `ENFORCE` mode. Quarantine can only narrow access and cannot grant capabilities or decide
an escrow outcome.

There is intentionally no public quarantine mutation endpoint and no online learner with write authority. An internal
trusted lifecycle requires an authenticated, enabled `SYSTEM` principal with the dedicated
`MANAGE_ADMISSION_QUARANTINE` capability. Actor and gateway principals cannot receive that capability, and all issue,
release, rejection, and dependency-failure outcomes emit bounded security telemetry. Behavioral feature storage,
promotion automation, and chaos reports remain separate increments. Read-only actor queries and non-command funding
administration retain their existing authorization boundaries until admission contracts are defined for those endpoint
classes.
