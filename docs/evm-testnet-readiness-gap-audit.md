# EVM / Testnet Readiness Gap Audit

**Audit date:** 2026-10-19

**Repositories reviewed:** `cromles/zinesh-protocol-v2` and the EVM implementation evidence in `cromles/zinesh-protocol`, both on `main`

**Scope:** Repository trees, relevant source/tests, package scripts, and the latest V2 CI evidence. This is not an independent smart-contract security audit or legal opinion.

## Executive finding

The V2 repository remains a deterministic TypeScript escrow/application protocol with React/Vite, PostgreSQL persistence, and a standalone open-protocol package. It intentionally contains no Solidity/Vyper source or EVM toolchain.

The separate `cromles/zinesh-protocol` repository now contains `contracts/ZineshEscrowV3_2.sol`, `test/ZineshEscrowV3_2.t.sol`, `hardhat.config.ts`, a `test:escrow-v32` command, and a Base Sepolia deployment console. The earlier conclusion that an EVM implementation still needed to be created is therefore retired. The remaining gap is not “write the first contract”; it is to pin deployment provenance, verify source, run independent security review, integrate the real testnet flow, and document the operational boundary.

## What is visible in the repository

- `README.md` describes HTTPS → JWT/JWKS → trusted ingress → principal/capability authority → application API → deterministic escrow kernel → PostgreSQL.
- `package.json` includes TypeScript typecheck/build, Jest tests, and Vite/Vitest frontend scripts.
- The tracked tree includes TypeScript source under `src/`, frontend source under `frontend/`, and operational/security documents under `docs/`.
- The inspected tracked tree did not reveal `.sol`, `.vy`, `hardhat.config.*`, or `foundry.toml` files.
- The README describes agreement lifecycle states and operational security boundaries. Those are useful foundations, but documentation alone does not prove EVM behavior, deployed code, legal status, or production readiness.
- V2 `main` at `3763dde322dc5a165b22f6a7b67b79a9e4422175` passed frontend, standalone-package, PostgreSQL, backup/restore, OCI reproducibility, SBOM/scanning, signing, and rollout gates in Actions run `39227070636`.
- V3.2 source uses native value custody, explicit acceptance/funding/work/review/dispute windows, evidence hashes, two resolver stages, timeout recovery, and a reentrancy guard.
- The V3.2 repository states 20/20 Solidity tests in its deployment UI and contains the corresponding 20 test functions. This audit did not independently rerun that separate repository's suite.

## Gap register

| Area | Current observation | Required next action | Priority |
|---|---|---|---|
| EVM implementation | V3.2 Solidity source, Hardhat config, tests, and deployment console exist in the separate main repository | Keep the cross-repository boundary explicit; do not duplicate the contract into V2 | Done |
| State-machine parity | V3.2 intentionally differs from V2 in states, native-asset custody, evidence windows, and resolver fallback | Publish a transition mapping and adversarial parity/difference tests | P0 |
| Asset model | V2 uses TRY/kuruş; V3.2 uses native test ETH value | State this incompatibility clearly and decide the eventual production asset model | P0 |
| Disputes and evidence | README includes disputed state, but real-world evidence resolution is not automatically solved by a contract | Define who/what resolves disputes, evidence format, timeouts, appeal limits, and failure modes | P0 |
| Admin and recovery | Production security docs cover runtime hardening, but EVM admin/upgrade/pausing policy is not evidenced here | Define roles, key custody, pause powers, upgrade policy, recovery, and disclosure | P0 |
| Deployment provenance | A deployment console exists, but the reviewed repositories do not pin one canonical address, transaction, source commit, compiler settings, and verified-source link together | Add a signed/reviewable deployment manifest and explorer verification | P0 |
| Testnet user flow | Contract and deployment UI exist; reproducible two-wallet create/accept/fund/evidence/release evidence is not pinned in these repositories | Add one scripted or documented end-to-end Base Sepolia run with transaction links | P0 |
| Grant evidence | Existing repository has technical documentation but no grant-specific package in the inspected paths | Prepare demo, concise milestones, budget, eligibility/deadline tracker, and measurable public-good rationale | P1 |
| Economics | 0.25% fee and sponsored gas are proposals, not validated costs | Benchmark gas and variable service cost; calculate net contribution at different transaction sizes | P1 |
| Legal classification | Code and README cannot determine licensing/regulatory obligations | Have qualified counsel review actual user, asset, control, fee, dispute, and jurisdiction flows before real assets | P0 |
| Verification | V2 CI is green on the exact main commit; the separate V3.2 suite was inspected but not rerun here | Add V3.2 contract tests and bytecode check to required CI | P0 |

## Suggested minimal EVM MVP boundary

Do not port the whole backend on-chain. V3.2 already follows a narrow contract boundary; keep authentication, user experience, indexing, notifications, and evidence content off-chain while ensuring that no off-chain API can bypass asset-moving authorization.

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

This document reconciles two public repositories at a point in time. It does not prove control of a deployed address, explorer verification, complete bytecode/source equivalence, production safety, or legal status. It does not replace a code-level security review, reproducible deployment check, or legal opinion.
