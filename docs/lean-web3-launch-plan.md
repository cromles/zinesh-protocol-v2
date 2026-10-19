# Lean Web3 Launch Plan (6 Months)

**Status:** Working plan — not a promise of launch date, funding, or legal status.  
**Owner:** Zinesh Protocol  
**Starting point:** Hardened V2 reference protocol plus the separate V3.2 Solidity prototype in `cromles/zinesh-protocol`.

**Primary objective:** Turn the existing Base Sepolia prototype into a reproducible, verifiable end-to-end testnet pilot and evidence package, without handling real customer funds before the legal and security gates are passed.

## Operating rules

1. **No real customer funds during the prototype phase.** Use test tokens and clearly label the experience as testnet-only.
2. **No claim of zero legal risk.** A non-custodial design or a software-only company description does not by itself determine regulatory treatment. Obtain qualified advice for the actual product flow and target jurisdictions before mainnet or fee collection.
3. **One chain first.** Start with Base Sepolia unless a documented technical or ecosystem reason justifies another network. Do not build dual-chain support before one complete flow works.
4. **No assumed grant revenue.** Treat grants as uncertain pipeline until formally awarded and payable. Do not commit recurring expenses against pending applications.
5. **Security before mainnet.** No production launch with real assets until threat modelling, independent review appropriate to the risk, incident/recovery procedures, and legal clearance are complete.
6. **Fees must be measured, not marketed as guaranteed savings.** Calculate network costs, sponsored gas, monitoring, support, dispute handling, audits, and tax/accounting costs before publishing a fee promise.

## Phase 0 — Repository and product reality check (Week 1)

- [x] Confirm the V2 repository, default branch, CI status, and deterministic package boundary.
- [x] Map existing V2 agreement states, authorization boundaries, dispute/refund/expiry paths, and persistence.
- [x] Identify the separate V3.2 Solidity implementation and its repository boundary.
- [x] Define the minimum flow: create → dual acceptance → testnet funding → evidence hash → release/refund/dispute timeout.
- [x] Record security assumptions and out-of-scope items in the design and gap-audit documents.

**Exit gate:** A written gap audit separates verified existing capabilities from missing EVM functionality. Do not describe an off-chain transition as an on-chain escrow.

## Phase 1 — Testnet MVP (Month 1–2)

- [x] Select Base Sepolia as the first target network and configure chain ID `84532` in the deployment console.
- [x] Implement the minimal V3.2 native-asset escrow contract in the separate application repository.
- [x] Implement dual acceptance, funding, evidence, release/refund, expiry, resolver fallback, and timeout recovery paths.
- [x] Add 20 Solidity tests plus a compiled-bytecode consistency check in the V3.2 repository.
- [ ] Add the V3.2 suite to required CI and independently review adversarial and V2-difference cases.
- [ ] Publish a deployment manifest containing canonical address, deployment transaction, chain ID, exact source commit, compiler settings, bytecode hash, verified explorer source, and known limitations.
- [ ] Record one reproducible two-wallet Base Sepolia flow through settlement.
- [ ] Keep wallet onboarding and gas sponsorship optional until the core flow is reliable.

**Exit gate:** A third party can reproduce the testnet demo and inspect the source and test evidence. No real assets or production fee collection.

## Phase 2 — User validation and public proof (Month 2–3)

- [ ] Interview at least 10 target users (freelancers, designers, developers) about one narrow use case.
- [ ] Run a small testnet pilot; track completed flows, abandonment points, time to complete, and user-reported trust improvements.
- [ ] Publish concise technical updates in English: architecture, testnet demo, security assumptions, and what is not yet supported.
- [ ] Prepare a funding package: one-page problem statement, demo, repository, architecture diagram, test evidence, milestones, and a realistic use-of-funds budget.
- [ ] Verify current eligibility, application windows, and deliverables for each grant/hackathon before applying.

**Exit gate:** Evidence of user interest and a reusable application package. Grant amounts are not included in operating cash until awarded.

## Phase 3 — Legal and operational model (Month 3–4)

- [ ] Draw the exact user and asset flow, including who deploys contracts, who controls upgrade/admin keys, who can pause, who can resolve disputes, who receives fees, and what happens when a party disappears.
- [ ] Obtain qualified legal review for Turkey and each intended launch jurisdiction. Assess the actual activity, not just company wording or where keys/funds are held.
- [ ] Obtain accounting/tax advice for grants, software revenue, protocol fees, cross-border income, and invoicing.
- [ ] Decide whether the first release is testnet-only, a software/tooling release, or a real-asset product. These are different risk profiles.
- [ ] Define support, incident response, key recovery, vulnerability reporting, privacy, sanctions/abuse handling, and terms/disclosures appropriate to the chosen model.

**Exit gate:** Written advice and an approved operating model for the exact proposed release. If unresolved, remain testnet-only.

## Phase 4 — Security and economics gate (Month 4–5)

- [ ] Complete threat model and review of reentrancy, access control, token assumptions, replay, signature/nonce handling, timestamp/expiry edge cases, rounding, and emergency controls as applicable.
- [ ] Commission an independent review before real assets are at risk; remediate critical/high findings.
- [ ] Verify deployment reproducibility, source verification, key custody, monitoring, pause/recovery procedures, and incident communications.
- [ ] Benchmark realistic gas costs and any sponsored-transaction costs across small, median, and large transaction values.
- [ ] Model fee revenue after variable costs, audits, support, disputes, refunds, taxes, and fixed operating costs.
- [ ] Set a capped gas-sponsorship budget; prevent unbounded sponsorship and abuse.

**Exit gate:** No unresolved critical/high security findings; documented economics; legal sign-off for the actual launch model.

## Phase 5 — Conditional launch (Month 5–6)

- [ ] If all gates pass, launch a limited, monitored pilot with explicit limits and a rollback/incident plan.
- [ ] If any gate fails, continue testnet and user validation; do not launch real assets just to meet a calendar date.
- [ ] Publish what is live, what is experimental, supported networks/tokens, risks, fees, and support/dispute boundaries.
- [ ] Review weekly metrics: successful completion rate, failures, median completion time, repeat use, support burden, cost per transaction, and abuse attempts.

## Fee model: do not promise 0.25% until measured

A proposed 0.25% fee is a hypothesis, not a validated business model. For each transaction:

`Net contribution = fee revenue - chain cost - sponsored gas - variable service/support cost - expected loss and dispute cost`

The model must also cover fixed costs (security review, infrastructure, legal/accounting, monitoring, and maintenance). If low-value transactions cannot cover variable costs, use a minimum fee, a capped gas subsidy, or a different target segment rather than hiding the deficit.

## Funding and cash discipline

- Maintain a list of programs with eligibility, deadline, required entity status, deliverables, amount range, and application status.
- Separate **applied**, **shortlisted**, **awarded**, and **cash received**.
- Do not describe a grant as guaranteed or budget against it before award/payment conditions are understood.
- Prioritize grants and hackathons that accept the current project stage and do not require an entity the project does not yet have.

## Public claims checklist

Before publishing any claim, verify it against the deployed product:
- Do not claim “zero legal risk,” “license-free,” “fully decentralized,” or “trustless” without a precise, supportable basis.
- Distinguish testnet from mainnet and test tokens from real assets.
- Distinguish on-chain enforcement from off-chain evidence review or dispute decisions.
- Publish the fee only after the complete cost model is validated.
