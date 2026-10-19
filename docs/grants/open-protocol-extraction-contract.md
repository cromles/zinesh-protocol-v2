# Zinesh Open Protocol: extraction contract v0.1

Status: implemented as a private development extraction in PR #23; not licensed or released. This document does not change the licensing of existing V2 files.

## Source boundary confirmed from V2

The reusable deterministic core consists of:
- `src/core/types.ts`: domain identifiers, version, timestamp, amount, commands, events and state contracts.
- `src/kernel/kernel.ts`: event-stream validation, replay and command execution frame.
- `src/kernel/state-machine.ts`: command guards, transitions, event folding and domain invariants.

These files import local domain modules. The full repository declares `pg` as a runtime dependency, while the package prepared in PR #23 compiles only the three authoritative protocol files and declares zero runtime dependencies. Its independent build, test and package-boundary checks passed in CI run #66.

## Implemented development boundary

Package: `@zinesh/open-protocol` (development name; registry availability not checked)

Exports:
- `createKernel(handlers)` or the equivalent existing kernel factory
- Pure event replay / fold interface
- Typed commands, events, state, errors and deterministic context
- Reference agreement lifecycle tests and fixtures

Explicit exclusions:
- Database adapters, payment gateways, custody, bank balances, fund transfers
- JWT/JWKS runtime ingress, web UI, hosting configuration and commercial integrations
- Automated AI decision-making or arbitration

## Verification gates

1. Verify authorship and ownership of all extracted files and any generated material; audit licenses of copied dependencies.
2. Select and apply a recognized FLOS license to the funded module only after the rights audit. Apache-2.0 is a candidate, not yet approved.
3. Maintain the dedicated TypeScript build with no database/runtime dependency.
4. Maintain deterministic replay, illegal transition, role/authority, version, idempotency and dispute tests; publish actual results for release candidates.
5. Publish a minimal consumer example and precise integration/security documentation.
6. Document how generated code, if any, was produced, with NLnet-compliant provenance.

## First release milestone acceptance criteria

- A fresh checkout can install, typecheck, test and build the standalone package using documented commands.
- An external consumer can create an agreement, replay its events and observe an identical final state from identical input.
- Invalid role, duplicate command, stale version and invalid state transitions are rejected in automated tests.
- No payment service or database is needed to run core tests.
- The published source and all funded deliverables have compatible recognized open licenses.

## Why separate the module?

An independent protocol can be inspected and reused without deploying Zinesh's commercial service. Commercial Zinesh remains a potential implementation, not a mandatory dependency. This is the intended grant scope, not a claim that the extraction has already been completed.
