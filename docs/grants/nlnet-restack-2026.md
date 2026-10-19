# NLnet Restack grant scope (draft, October 2026)

Project: Zinesh — Deterministic Agreement and Evidence Protocol for Open Digital Trade
Applicant: Yasin Karademir (individual, Türkiye)
Requested funding: EUR 30,000
Contact: zinesh.protocol@gmail.com

## Scope
A reusable, open-source software component for deterministic agreement state transitions, explicit actor/capability authorization, idempotent command handling, verifiable state/evidence records, and human-led dispute workflows. This grant does not finance payment processing, custody of customer funds, financial licensing, or a commercial marketplace.

## Proposed deliverables
1. Stabilize and document the standalone agreement state machine and its command/event contracts for a rights-cleared FLOS release. The existing development extraction is prior work and is not charged to the grant.
2. Expand reproducible transition and compatibility tests, including invalid transitions, concurrent requests, idempotency and versioned upgrade behavior.
3. Implement portable evidence and audit export with privacy-sensitive fields minimized.
4. Provide a reference API, sample integrations, and threat-model/security documentation.
5. Publish installation guidance, interoperability examples, and test evidence.

## Preliminary budget
- Public API stabilization, versioning and documentation: 150 hours x EUR 40 = EUR 6,000
- Idempotency and persistence/recovery hardening: 200 hours x EUR 40 = EUR 8,000
- Evidence export and dispute workflow: 175 hours x EUR 40 = EUR 7,000
- Interoperability examples, tests and security review: 150 hours x EUR 40 = EUR 6,000
- Public release, docs and community feedback: 75 hours x EUR 40 = EUR 3,000
Total: 750 hours x EUR 40 = EUR 30,000

## Submission gates
- Verify all repository code ownership, dependencies and compatibility before applying a FLOS license. No license is granted by this draft.
- Separate completed pre-grant work from proposed funded work. Do not bill the existing development extraction or its current tests to NLnet.
- Disclose use of ChatGPT/Codex in proposal preparation with model, timestamp, prompts and unedited outputs as required by NLnet; do not fabricate missing provenance.
- Confirm previous funding statements and applicant experience are accurate.
- Review and rewrite final application in applicant's own words as required by NLnet.
- Do not claim AI-generated work as paid human development.
