# Base Sepolia Escrow MVP — Design Notes

**Status:** Historical V2-to-EVM design input, reconciled 2026-10-19. The EVM prototype is now implemented separately in `cromles/zinesh-protocol` as `contracts/ZineshEscrowV3_2.sol`, with `test/ZineshEscrowV3_2.t.sol`, Hardhat configuration, and a Base Sepolia deployment console. This document does not attest to a deployed address, verified explorer source, audit, or production readiness.

**Source of domain rules:** `src/core/types.ts` and `src/kernel/state-machine.ts` on the V2 `main` branch; cross-repository implementation evidence reviewed 2026-10-19.

## Current implementation boundary

- V2 remains the TypeScript/PostgreSQL reference protocol and now also exposes a standalone deterministic package under `packages/open-protocol`.
- V3.2 is a separate Solidity implementation in `cromles/zinesh-protocol`; it uses native test ETH rather than V2's TRY/kuruş model.
- The V3.2 contract implements dual acceptance, funding and work deadlines, evidence hashing, release/refund paths, primary and backup resolvers, timeout recovery, and a reentrancy guard.
- Its repository includes 20 Foundry-style Solidity tests and a bytecode consistency check. Those tests are implementation evidence, not an independent security review.
- The remaining work is deployment provenance, explorer source verification, adversarial review, frontend integration, key/resolver operations, and a reproducible end-to-end testnet run.

## Critical compatibility decisions

1. **V2 currently supports TRY only.** `Currency` is the literal type `'TRY'`, and amounts are positive integer kuruş. USDC has six decimals and is not TRY. The EVM MVP must not silently treat USDC base units as kuruş or claim that a stablecoin transfer is a TRY-denominated payment. Before implementation, choose one of:
   - a separate EVM settlement-asset domain with token address + token decimals + integer token units; or
   - an explicitly test-only representation that does not claim parity with V2's TRY financial semantics.
2. **On-chain enforcement must not depend on an API telling the contract what happened.** If an API or indexer reports a release, that report alone must not move assets. The contract must validate the required authorization itself.
3. **The existing kernel is a reference for business rules, not code that can be copied mechanically into Solidity.** On-chain authorization and asset custody need their own threat model and adversarial tests.
4. **A dispute is a governance decision.** V2 permits an optional arbiter; if present, only that arbiter resolves a dispute. The contract can enforce the designated arbiter's call, but it cannot independently determine whether real-world work was satisfactory.

## V2 rules observed in source

- Creation requires different payer/payee actors, a positive amount, a non-empty bounded description, and `fundingDeadline < completionDeadline`.
- New cells require payee acceptance before funding.
- Funding is exact-amount only; partial funding is not accepted.
- A release request can be made by either participant, and the other participant must approve it.
- A refund request is made by the payer and approved by the payee.
- The payer can force-refund a funded cell only when `currentTime > completionDeadline`.
- A cell can expire from CREATED only when `currentTime > fundingDeadline`.
- A dispute can be opened by either participant only while FUNDED, only if an arbiter exists, and only while `currentTime < completionDeadline`.
- Only the configured arbiter can resolve a dispute; resolution in favour of the payee releases funds, while resolution in favour of the payer refunds funds.
- RELEASED, REFUNDED, and EXPIRED are terminal states in the V2 kernel.

These rules remain the V2 reference. V3.2 intentionally differs in several places, including native-asset custody, dual acceptance, evidence/review windows, and primary/backup resolver timeouts. Any claimed parity must therefore be explicit and tested transition by transition.

## Original proposed minimum contract surface

This is retained as historical design input. It is not the current V3.2 ABI.

- `createAgreement(payee, arbiter, asset, amount, fundingDeadline, completionDeadline, termsHash)`
- `acceptAgreement(agreementId)`
- `rejectAgreement(agreementId)` (only before funding; specify whether this is a terminal cancelled state or a V2-compatible rejected state)
- `fund(agreementId, amount)` (payer only; exact amount; supported token only; no fee-on-transfer/rebasing token assumptions)
- `requestRelease(agreementId)`
- `approveRelease(agreementId)` (other party only; atomically transfer to payee)
- `requestRefund(agreementId)`
- `approveRefund(agreementId)` (payee only; atomically return to payer)
- `forceRefund(agreementId)` (payer only after completion deadline)
- `expire(agreementId)` (after funding deadline, only while unfunded)
- `openDispute(agreementId)` and `resolveDispute(agreementId, favourOfPayee)` (arbiter-gated)

Each successful action should emit indexed events containing the agreement ID and enough metadata for independent reconstruction. Terms should be committed by immutable fields and/or a terms hash; funded terms must not be editable.

## Questions that remain before a production pilot

### Identity and signatures
- Are payer, payee, and arbiter represented by EVM addresses, and how are they bound to the existing V2 actor IDs?
- Does each action require a direct transaction, or are relayed signatures in scope? For MVP, direct transactions are safer and simpler.
- If signatures are ever used, define EIP-712 domain separation, chain ID, nonces, expiry, and replay protection.

### Time and state
- EVM time uses block timestamps (seconds), whereas V2 timestamps are milliseconds. Convert explicitly and test boundary equality.
- V2 permits expiry only from CREATED; specify behavior for rejected cells and whether rejection should be a terminal state.
- Resolve whether acceptance can be withdrawn; do not add that behavior implicitly.
- Prevent duplicate requests, repeated settlement, and any transfer after a terminal state.

### Token handling
- Allowlist one known test token for the testnet pilot.
- Use safe ERC-20 transfer handling and verify exact received amount if token behavior could vary.
- Store token address and integer token units; do not reuse TRY/kuruş fields without an explicit domain mapping.
- Decide whether fees are out of scope for the first testnet contract. Recommendation: no protocol fee in the first contract; measure costs and validate legal/economic assumptions separately.

### Dispute and emergency policy
- Arbiter decisions can move all funds to one participant, so the arbiter's authority and replacement policy must be explicit.
- Decide whether any pause role exists. A pause can protect users but can also block withdrawals; specify which actions remain possible during a pause.
- Avoid upgradeability for the first testnet prototype unless there is a clear need and a reviewed admin model.

## Test and review matrix before a reproducible public pilot

- Happy path: create → accept → exact funding → release request → other party approves → payee receives exact amount.
- Refund path: payer requests refund → payee approves → payer receives exact amount.
- Deadline path: unfunded agreement expires strictly after funding deadline.
- Force refund: fails at deadline equality and succeeds strictly after completion deadline, if that is the chosen V2 parity.
- Dispute: cannot open without arbiter; cannot open at/after completion deadline; non-arbiter cannot resolve.
- Authorization: non-participant cannot fund/request/approve; requester cannot approve their own request.
- Invariants: no amount mismatch, no double funding, no double settlement, no state change after terminal settlement, no terms mutation after funding.
- Token adversarial cases: transfer failure, false return, unexpected balance delta, unsupported token, and zero amount.
- Replay/concurrency: repeated calls and two competing settlement calls cannot pay out twice.
- Reentrancy: malicious token/receiver scenarios do not violate accounting or state.

## Exit criteria

Do not claim production or mainnet readiness until:
- the deployed address, chain ID, transaction, source commit, compiler settings, and explorer verification are recorded together;
- the native-asset settlement model and differences from V2 TRY semantics are disclosed;
- all on-chain versus off-chain responsibilities and resolver operations are documented;
- every terminal path and deadline boundary has adversarial tests;
- an independent security review is complete and critical/high findings are resolved;
- no real assets, production fees, or uncapped gas sponsorship are enabled before the legal and operational gates pass.
