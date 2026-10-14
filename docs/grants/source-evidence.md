# NLnet Restack: source-verified engineering evidence

This is a preliminary evidence note, not a claim of complete audit or a final grant submission.

Repository: https://github.com/cromles/zinesh-protocol-v2
Source inspected: src/kernel/state-machine.ts, README.md, package.json (main branch, 14 October 2026).

Observed in source:
- A TypeScript event folder handles CellCreated, CellFunded, CellAccepted, CellRejected, ReleaseRequested, Released, RefundRequested, Refunded, CellExpired, DisputeOpened and DisputeResolved.
- CreateCell validates positive amounts, TRY currency, nonempty descriptions, ordered deadlines and distinct payer/payee/arbiter.
- Source comments describe a pure deterministic kernel. This note does not independently prove runtime determinism or production readiness.
- package.json provides test, typecheck and build scripts. No tests were executed during this review.

Licensing gap: LICENSE and LICENSE.md were not found at the repository root. Do not assert that the repository is already FLOS-licensed. Before publishing grant deliverables, perform ownership and dependency review and add an appropriate recognized FLOS license to the funded output.

Funding proposal: build a reusable agreement-state-machine and evidence interface with interoperability examples, tests and documentation. Do not represent proposed outputs as already complete.

AI disclosure: ChatGPT helped prepare the grant documentation; earlier Codex use was reported. NLnet requires original prompt and unedited output logs, timestamps and models. Recover these from actual history; never invent provenance.

Next verification: inspect actual test results and implementation of persistence, idempotency, evidence export and dispute flows.
