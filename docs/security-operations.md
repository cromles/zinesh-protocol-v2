# Zinesh V2 security operations contract

This runbook turns security telemetry into an operational response loop. It is
provider-neutral: the runtime emits newline-delimited JSON and the deployment
platform supplies collection, durable storage, paging, and dashboards.

## Signal transport

| Stream | Content | Required handling |
| --- | --- | --- |
| stdout | `SecurityEvent` and `SECURITY_METRIC` JSON lines | Collect from every replica, preserve `instanceId`, and route to restricted central storage. |
| stderr | `SECURITY_ALERT_CONDITION` JSON lines | Page on `CRITICAL`; create a reviewed operational notification for `WARNING`. |
| heartbeat | `TELEMETRY / HEARTBEAT / SUCCESS` every 60 seconds | Alert `CRITICAL` when an expected instance is silent for 150 seconds. |

The collector must parse one JSON object per line. It must not promote
`correlationId`, `commandId`, or `principalId` to metric labels. Access to raw
events is restricted because those bounded identifiers can still be sensitive.

Telemetry failure is isolated from escrow execution. Missing telemetry never
authorizes, rejects, releases, refunds, or otherwise changes an agreement. The
runtime records local pipeline degradation when a sink throws; an external
dead-man alarm detects total signal loss.

## Alert lifecycle

An alert is emitted once with `state=FIRING` when its threshold is reached. A
heartbeat sweeps expired observations. When the signal has been absent for a
complete evaluation window, the runtime emits the same alert with
`state=RESOLVED` and `observed=0`.

`RESOLVED` means that the triggering signal stopped. It does not prove that the
root cause was fixed. The incident owner closes the incident only after the
verification column below is satisfied.

## Response matrix

| Alert | Severity | Immediate action | Verification before closure |
| --- | --- | --- | --- |
| `AUTHENTICATION_DEPENDENCY_FAILURE` | Critical | Freeze rollout; verify JWKS reachability, TLS identity, issuer and audience. Keep authentication fail-closed. | Valid and invalid token probes behave correctly; no bypass was enabled. |
| `POSTGRES_DEPENDENCY_FAILURE` | Critical | Stop rollout and inspect database/TLS availability. Do not weaken `verify-full`. | `/ready` returns 200 and transaction/replay checks pass. |
| `TELEMETRY_PIPELINE_FAILURE` | Critical | Check collector, stdout/stderr routing, quota and storage. Preserve application availability. | Heartbeats from every expected instance are visible for two intervals. |
| missing heartbeat for 150 seconds | Critical | Determine whether the replica, collector, or route is silent. Correlate with `/live` and `/ready`. | Expected instance is deliberately removed or emits two consecutive heartbeats. |
| `BRUTE_FORCE_AUTHENTICATION` | Warning | Inspect source/network patterns and rate limiting; rotate credentials only with evidence of compromise. | Rejection rate returns to baseline and no successful anomalous authentication exists. |
| `RATE_LIMIT_REJECTION_SURGE` | Warning | Confirm abuse versus legitimate load; do not disable fail-closed rate limiting. | Capacity and rejection pattern are understood and stable. |
| `AUTHORIZATION_REJECTION_ANOMALY` | Warning | Inspect command types and principals using correlated raw events. | No privilege mapping or caller-to-actor binding was bypassed. |
| `DISABLED_PRINCIPAL_ATTEMPTS` | Warning | Confirm whether disabled identity use is expected; preserve the disable state. | Attempts cease or are attributed to an approved test. |
| `FAIL_CLOSED_SURGE` | Warning | Identify the unavailable dependency and customer impact. Never replace fail-closed with allow. | Dependency recovers and negative-path tests remain green. |

## Incident sequence

1. **Acknowledge:** assign an incident owner and severity using `SECURITY.md`.
2. **Preserve:** record alert name, state, first/last time, instance, deployment
   digest, correlation IDs, and relevant CI run. Do not paste secrets into the
   incident record.
3. **Contain:** pause rollout. Disable only the affected capability or ingress
   path when necessary; do not mutate historical events or settle agreements
   automatically.
4. **Diagnose:** correlate bounded events with immutable domain/audit records.
   A risk signal is not an accusation and does not decide a dispute.
5. **Recover:** restore the dependency or deploy a signed, digest-pinned fix.
   Follow backup/restore and rollback contracts when schema or data is involved.
6. **Verify:** require green CI, CodeQL, artifact/SBOM scans, signature chain,
   rollout verification, and the alert-specific closure check.
7. **Learn:** add a deterministic regression test and update thresholds or this
   runbook only through reviewed pull requests.

## Release and drill requirements

- Before production use, route all three JSON-line types to a central collector
  and test the 150-second dead-man alarm.
- Run a quarterly non-production drill for authentication dependency failure,
  PostgreSQL failure, telemetry sink failure, and backup restore.
- Keep evidence of alert delivery, containment time, recovery time, and the
  regression test added after each real incident.
- Threshold changes require a pull request. Never tune an alert away while an
  incident is active.
