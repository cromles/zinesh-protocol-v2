# NLnet Restack: source-verified engineering evidence

This is a preliminary evidence note, not a claim of complete audit or a final grant submission.

Repository: https://github.com/cromles/zinesh-protocol-v2
Source inspected: current main plus PR #23 package boundary and CI evidence (updated 19 October 2026).

Observed in source:
- A TypeScript event folder handles CellCreated, CellFunded, CellAccepted, CellRejected, ReleaseRequested, Released, RefundRequested, Refunded, CellExpired, DisputeOpened and DisputeResolved.
- CreateCell validates positive amounts, TRY currency, nonempty descriptions, ordered deadlines and distinct payer/payee/arbiter.
- The kernel has no I/O and receives time and event identifiers through a deterministic context.
- PR #23 CI run #66 passed the standalone package build, typecheck, tests and package-boundary check, as well as the repository's PostgreSQL/TLS production verification and frontend gate.
- Current main CI after PR #24 passed 526/526 tests and the complete production verification chain, including typecheck, build, backup/restore, OCI reproducibility, vulnerability scans, signature verification and digest-preserving rollout.

Licensing gap: LICENSE and LICENSE.md were not found at the repository root. Do not assert that the repository is already FLOS-licensed. Before publishing grant deliverables, perform ownership and dependency review and add an appropriate recognized FLOS license to the funded output.

Funding proposal: build a reusable agreement-state-machine and evidence interface with interoperability examples, tests and documentation. Do not represent proposed outputs as already complete.

AI disclosure: ChatGPT helped prepare the grant documentation; earlier Codex use was reported. NLnet requires original prompt and unedited output logs, timestamps and models. Recover these from actual history; never invent provenance.

Remaining release verification: human ownership review, dependency-license sign-off, third-party notices, final FLOS license selection and complete AI provenance records. The successful CI evidence does not remove these release gates.
