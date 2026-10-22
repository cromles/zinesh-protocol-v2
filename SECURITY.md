# Security Policy

Zinesh Protocol V2 is under active development. Security reports are treated as engineering incidents, not ordinary feature requests.

## Supported code

Security fixes target the current `main` branch and the latest signed release candidate produced from it. Older development snapshots are not supported unless maintainers explicitly state otherwise.

This policy applies to Zinesh Protocol V2. V3 pilots and unrelated deployments have separate risk boundaries.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting for this repository when available. If it is unavailable, email **zinesh.protocol@gmail.com** with the subject `[SECURITY] Zinesh Protocol V2`.

Include:

- the affected commit, component, and deployment assumptions;
- impact and a minimal reproducible case;
- evidence that does not contain live credentials, personal data, or destructive payloads;
- any known workaround or mitigation.

Do not access data that is not yours, degrade service, persist after testing, or publicly disclose the issue before a coordinated fix.

## Response targets

Targets begin after the report is received and apply to validated findings.

| Severity | Initial acknowledgement | Triage and containment target | Fix or documented mitigation target |
| --- | --- | --- | --- |
| Critical | 4 hours | 24 hours | 24 hours |
| High | 1 business day | 3 business days | 7 days |
| Medium | 2 business days | 10 business days | 30 days |
| Low | 5 business days | Next planned maintenance cycle | Next planned maintenance cycle |

If a complete fix cannot safely ship inside the target, maintainers will prioritize containment, disable the affected path when necessary, and document the remaining risk before restoring it.

## Continuous verification

The repository runs:

- the complete PostgreSQL, application, artifact, container, SBOM, vulnerability, signature, rollout, and backup/restore verification every day and on relevant pull requests;
- CodeQL JavaScript and TypeScript analysis on pull requests, pushes to `main`, and every day;
- weekly Dependabot checks for npm, Docker, GitHub Actions, and the standalone open-protocol package.

Scheduled runs evaluate the current `main` branch. Dependabot opens reviewable pull requests and never bypasses required checks.

## Release security gates

A release or deployment candidate is blocked when any of the following is true:

- a validated unresolved Critical or High vulnerability affects the shipped artifact;
- CodeQL, Trivy, Grype, or the repository's vulnerability-coverage verification fails;
- required tests, authenticated PostgreSQL TLS verification, backup/restore verification, or startup checks fail;
- the runtime SBOM is missing or does not match the packaged runtime;
- artifact digest reproducibility, signature verification, provenance, or digest-pinned rollout verification fails;
- an exception lacks a named owner, compensating control, expiration date, and written approval.

Medium findings must have an owner and remediation deadline before release. Security exceptions are temporary risk acceptances, not permanent waivers.

## Coordinated disclosure

Maintainers will confirm the affected versions, prepare a fix and release notes, and agree on a disclosure date with the reporter when practical. Credit is offered unless the reporter requests anonymity.
