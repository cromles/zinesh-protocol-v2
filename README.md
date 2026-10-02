# Zinesh Protocol V2

Zinesh Protocol V2 is a deterministic trust and agreement infrastructure designed to connect real-world commerce with a verifiable software protocol.

The V2 architecture focuses on **independent escrow cells**, explicit actor authority, deterministic state transitions, secure API boundaries, PostgreSQL-backed persistence, and a frontend agreement flow.

> V2 is infrastructure first: the protocol defines what can happen, who can do it, and how the resulting state is persisted and verified.

## Architecture

```text
HTTPS Transport
      ↓
JWT / JWKS Verification
      ↓
Trusted Ingress
      ↓
Principal / Capability Authority
      ↓
Application API
      ↓
Deterministic Escrow Kernel
      ↓
PostgreSQL
```

The core is deliberately deterministic. Commands enter through an application boundary, are authorized against the active principal, and are applied to the escrow state machine rather than directly mutating business state.

## Core Model

### Independent Escrow Cells

Each agreement is represented as an independent cell with its own lifecycle and state. A failure or dispute in one cell does not require the protocol to compromise the state of unrelated cells.

Typical lifecycle states include:

```text
CREATED
   ↓
FUNDED
   ↓
RELEASED

CREATED / FUNDED
   ├── REFUNDED
   ├── DISPUTED
   └── EXPIRED
```

Agreement acceptance is tracked separately from the financial state, allowing the protocol to distinguish between an agreement that exists, an agreement that has been accepted, and an agreement whose financial lifecycle has progressed.

## Actor Authority

V2 separates authority by principal type and does not treat authentication as authorization.

The architecture includes:

- ACTOR authority
- GATEWAY authority
- SYSTEM authority
- JWT verification using RS256
- issuer and audience validation
- JWKS caching
- capability-aware command authorization
- PostgreSQL-backed rate limiting

The application layer decides whether a command is permitted; the deterministic kernel remains responsible for valid state transitions.

## Security Boundary

The production security model is built around:

- HTTPS transport
- RS256 JWT verification
- JWKS-based key discovery
- trusted ingress
- principal/capability authorization
- PostgreSQL TLS with CA verification
- hostname verification
- plaintext PostgreSQL rejection
- non-root container execution
- read-only filesystem hardening
- mounted TLS and database secrets
- security observability
- backup and restore verification

Secrets are expected to be supplied through the runtime environment or mounted secret files rather than committed to the repository.

## Frontend

V2 includes a frontend development shell and an agreement flow built against the real API contracts.

The frontend currently covers the development agreement lifecycle, including:

- Payer and Payee roles
- agreement creation
- agreement detail loading
- acceptance / rejection state
- funding flow
- release requests
- release approval
- refund state
- dispute state
- expiration handling
- stale-state protection after role or cell changes
- user-facing API error handling

The frontend deliberately follows the backend command contract instead of inventing a second business model.

## API / Protocol Principles

The protocol is designed around explicit commands and explicit state.

A simplified command flow is:

```text
Client
  ↓
Authentication
  ↓
Authorization
  ↓
Command
  ↓
Deterministic Kernel
  ↓
State Transition
  ↓
Persistence
  ↓
Response / Events
```

Important principle: **the UI is not the source of truth.** The protocol state and its authorization rules are.

## Database & Recovery

PostgreSQL is part of the V2 persistence boundary.

The repository includes backup/restore verification and TLS-aware database access. Runtime database connections are expected to fail closed when TLS or required secret configuration is invalid.

Backup and restore testing is part of the CI path rather than being treated as an optional operational task.

## Testing & CI

V2 has an extensive automated test suite covering the deterministic kernel, authorization, API behavior, persistence, security boundaries, backup/restore behavior, and frontend contracts.

Recent development milestones include:

- deterministic escrow kernel tests
- PostgreSQL integration coverage
- security observability
- PostgreSQL TLS verification
- backup/restore verification
- frontend quality gate
- frontend API contract alignment
- frontend agreement-flow tests

The repository's CI pipeline is used as the authoritative verification environment for infrastructure-dependent tests.

## Repository Structure

The project is organized around clear separation between protocol state, application behavior, infrastructure, and frontend concerns.

```text
src/
├── core/        # Core protocol types and domain definitions
├── kernel/      # Deterministic state machine / escrow kernel
└── ...          # Application and infrastructure layers

api/             # API / runtime boundaries
frontend/        # Frontend development and agreement flow
scripts/         # Operational and verification tooling
tests/           # Automated protocol and integration tests
```

The exact directory layout may evolve as V2 continues, but the architectural boundary between deterministic protocol logic and surrounding infrastructure is intentional.

## Current Development State

The repository is an active V2 development line. Recent work has moved beyond the core escrow kernel into the production-facing boundaries around:

1. secure runtime configuration
2. PostgreSQL TLS
3. backup and restore verification
4. principal authority
5. frontend API contracts
6. agreement lifecycle UX
7. security and operational observability

The latest main-line development has focused on completing and hardening the frontend agreement flow while preserving the protocol's authorization boundaries.

## Development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Run type checking:

```bash
npm run typecheck
```

Build:

```bash
npm run build
```

For PostgreSQL- and TLS-dependent verification, use the repository's CI/runtime environment rather than assuming a local machine has the required infrastructure available.

## Security

Do not commit:

- private keys
- JWT signing keys
- database passwords
- CA certificates containing private material
- production credentials
- `.env` files containing secrets

Production deployments should use secure secret mounts and TLS verification. Development shortcuts that disable certificate verification must never be promoted to production configuration.

## Project Direction

Zinesh V2 is being developed as a trust infrastructure layer rather than a conventional payment UI.

The long-term model is to make agreements, authority, state transitions, evidence, and dispute handling machine-verifiable while keeping the deterministic protocol core independent from external payment providers and deployment infrastructure.

---

**Zinesh Protocol V2**  
Deterministic agreement infrastructure for trust between actors.
