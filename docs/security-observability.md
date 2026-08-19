# Phase 7H security observability contract

Security telemetry is an operational signal, not an authentication, authorization, rate-limit,
domain, or persistence boundary. Log, metric, and alert-condition sink failures are isolated from
those decisions. They are counted as telemetry pipeline failures and never create an allow result.

## Data classes and durability

- Security logs contain allowlisted diagnostic metadata only. They are not the durable security
  audit and may be delivered asynchronously by the process output collector.
- Security metrics are aggregate counters and durations with bounded labels. `instanceId` is a
  bounded top-level routing field; principal, actor, command, correlation, issuer, URL, and network
  source values are never metric labels.
- Security alert output represents an evaluated alert condition. It does not claim that a human or
  notification provider received an alert. The in-process evaluator is instance-scoped and bounded;
  a central backend must aggregate the emitted multi-instance metric contract for fleet-wide alerts.
- Phase 7C `principal_audit` remains the transactional, PostgreSQL-backed security audit for
  principal lifecycle changes. A failed audit insert rolls back the lifecycle mutation. It is not
  replaced by logs or metrics.

## Retention

Production configuration must explicitly set security-log, metric, and durable security-audit
retention in days. The values are contracts for the external collectors/storage policy; this phase
does not install or pretend to operate a log or metrics backend. Deployments must configure their
backend expiration to the same or a shorter data-minimizing period. Durable `principal_audit`
deletion/archival remains an operator-controlled database policy and is not coupled to escrow
transactions by Phase 7H.

## Privacy

Telemetry serialization is allowlist-based. Raw credentials, Authorization headers, JWT bodies,
JWKS documents, request bodies, private keys, passwords, payment credentials, SQL text, and driver
errors have no field in the contract. Correlation IDs are server-generated operational identities;
they are distinct from command IDs and do not grant authority.
