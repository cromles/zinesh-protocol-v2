# EVM / Testnet Readiness Gap Audit

**Audit date:** 2026-10-09  
**Repository reviewed:** `cromles/zinesh-protocol-v2`, default branch `main`  
**Scope:** Repository tree, README, and package scripts. This is a static repository review, not a security audit and not a claim that CI was run during this review.

## Executive finding

The repository currently documents a deterministic TypeScript escrow/application protocol with a React/Vite frontend and PostgreSQL-backed persistence. The inspected repository tree contains no Solidity (`.sol`) or Vyper (`.vy`) source files and no visible Hardhat or Foundry configuration. The current package scripts are TypeScript/Jest/Vite-oriented and do not expose an EVM contract compile, test, or deploy command.

**Implication:** Base Sepolia deployment is not a simple configuration switch for the current V2 application. An EVM contract/adapter and a carefully specified boundary between the on-chain asset lifecycle and the existing off-chain application must be designed and tested. Do not describe V2 as already deployed on-chain unless there is a separate repository/deployment that proves it.

## What is visible in the repository

- `README.md` describes HTTPS → JWT/JWKS → trusted ingress → principal/capability authority → application API → deterministic escrow kernel → PostgreSQL.
- `package.json` includes TypeScript typecheck/build, Jest tests, and Vite/Vitest frontend scripts.
- The tracked tree includes TypeScript source under `src/`, frontend source under `frontend/`, and operational/security documents under `docs/`.
- The inspected tracked tree did not reveal `.sol`, `.vy`, `hardhat.config.*`, or `foundry.toml` files.
- The README describes agreement lifecycle states and operational security boundaries. Those are useful foundations, but documentation alone does not prove EVM behavior, deployed code, legal status, or production readiness.

## Gap register

| Area | Current observation | Required next action | Priority |
|---|---|---|---|
| EVM implementation | No Solidity/Vyper source or EVM toolchain config found in inspected tree | Decide whether to add a minimal contract package or maintain a separate contract repository; document the boundary | P0 |
| State-machine parity | Existing V2 kernel is the documented application source of truth | Specify which transitions must be enforced on-chain and create parity/adversarial tests | P0 |
| Asset and token model | No on-chain token/escrow deployment is evidenced by this repository inspection | Select test token assumptions and define supported token behavior; avoid arbitrary-token assumptions | P0 |
| Disputes and evidence | README includes disputed state, but real-world evidence resolution is not automatically solved by a contract | Define who/what resolves disputes, evidence format, timeouts, appeal limits, and failure modes | P0 |
| Admin and recovery | Production security docs cover runtime hardening, but EVM admin/upgrade/pausing policy is not evidenced here | Define roles, key custody, pause powers, upgrade policy, recovery, and disclosure | P0 |
| Deployment provenance | No EVM deployment manifest/address was identified in the inspected tree | Add reproducible deployment scripts, chain IDs, addresses, verified-source links, and commit provenance | P1 |
| Testnet user flow | Existing frontend describes an off-chain agreement lifecycle | Decide the MVP flow and connect wallet/funding/release to a testnet contract only after contract tests pass | P1 |
| Grant evidence | Existing repository has technical documentation but no grant-specific package in the inspected paths | Prepare demo, concise milestones, budget, eligibility/deadline tracker, and measurable public-good rationale | P1 |
| Economics | 0.25% fee and sponsored gas are proposals, not validated costs | Benchmark gas and variable service cost; calculate net contribution at different transaction sizes | P1 |
| Legal classification | Code and README cannot determine licensing/regulatory obligations | Have qualified counsel review actual user, asset, control, fee, dispute, and jurisdiction flows before real assets | P0 |
| Verification | This review did not execute tests or inspect the latest CI run | Run repository CI and report the exact commit and results before making readiness claims | P1 |

## Suggested minimal EVM MVP boundary

Do not port the whole backend on-chain. First design the smallest contract that can safely represent the asset lifecycle for one narrowly defined agreement type. Keep authentication, user experience, indexing, notifications, and off-chain evidence handling outside the contract where appropriate, while ensuring that no off-chain API can bypass on-chain authorization.

Before implementation, answer these questions in writing:

1. Which party can create an agreement, and can terms be changed after funding?
2. Which exact event or authorization allows release?
3. Is refund permissionless after a deadline, or does it require another party?
4. What happens when the parties disagree or evidence is ambiguous?
5. Which token behaviors are supported, and how are fee-on-transfer/rebasing tokens handled or excluded?
6. Are contracts immutable or upgradeable? Who controls emergency powers?
7. How are signatures, nonces, replay, chain IDs, and expiry enforced?
8. Who pays gas, what is the per-user/per-day sponsorship cap, and how is abuse prevented?

## Acceptance gates before any mainnet real-asset pilot

- [ ] Contract design and threat model reviewed.
- [ ] State-transition and adversarial tests cover every funded path.
- [ ] Testnet deployment is reproducible from a documented commit.
- [ ] Contract source is verified on the target explorer.
- [ ] Independent security review completed and critical/high findings resolved.
- [ ] Admin keys, pause/recovery, monitoring, and incident response are operational.
- [ ] Legal review covers the actual product flow and target jurisdictions.
- [ ] Fee/gas model is positive or the subsidy is explicitly capped and funded.
- [ ] User disclosures accurately distinguish on-chain logic from off-chain dispute/evidence handling.

## Limitations

This document is a static gap audit of selected repository metadata and documentation. It does not establish that no EVM implementation exists in another repository, private branch, or external deployment. It does not replace a code-level security review, CI run, or legal opinion.
