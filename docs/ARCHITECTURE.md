# Zinesh 2.0 Architecture - M1 Independent Escrow Cells

## Overview

Zinesh 2.0 implements a **highly secure, isolated escrow protocol** based on the **M1 - Independent Escrow Cells** architecture. This design prioritizes security through strict isolation, determinism, and blast-radius limitation.

## Core Architectural Principles

### 1. Independent Escrow Cells (M1)

Each escrow agreement exists as an **isolated cell** with its own:
- Unique `CellId` (immutable identifier)
- Independent state machine
- Dedicated funding bindings
- Self-contained policy rules

**No shared state, no omnibus balances, no netting.**

### 2. Blast-Radius Limitation

The M1 architecture ensures that any failure, exploit, or bug is **strictly contained** within a single cell:
- A compromised cell cannot affect other cells
- No cross-cell contagion possible
- Each cell's maximum loss is bounded to its own funded amount

### 3. Pure Deterministic Core

The core domain logic is **100% pure and deterministic**:
- No I/O operations
- No network calls
- No database access
- No external dependencies

The core receives commands and current state, produces events and new state—nothing more.

---

## 🛑 CRITICAL ARCHITECTURAL RULES (RED LINES)

These rules are **non-negotiable** and must never be violated:

### Rule 1: NO Global Admin / Superuser / Master Keys
- There is no "god mode" or backdoor
- No entity can unilaterally control all cells
- Governance (if any) must be per-cell and policy-defined

### Rule 2: NO Shared Pools / Omnibus Balances / Netting
- Every escrow is a strictly isolated boundary
- Funds from Cell A can never be commingled with Cell B
- No netting across cells—each settlement is atomic and independent

### Rule 3: NO Cross-Cell State Contamination
- A function cannot read the state of another cell
- A function cannot mutate the state of another cell
- CellId binding ensures strict context isolation

### Rule 4: NO I/O, Network, or Database in Core Domain
- The state machine is pure function logic
- Side effects (blockchain writes, notifications, logging) happen at the **periphery**
- Core must be testable in complete isolation

### Rule 5: NO Global Emergency Withdrawals
- No "emergency stop" that affects all cells
- Emergency paths (if any) must be per-cell and policy-defined
- Users cannot lose funds due to another cell's emergency

---

## System Boundaries

```
┌─────────────────────────────────────────────────────────┐
│                    PERIPHERY (I/O)                       │
│  - Blockchain adapters                                   │
│  - Notification services                                 │
│  - API endpoints                                         │
│  - Logging & Monitoring                                  │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   CORE DOMAIN (PURE)                     │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  │
│  │   Cell A    │    │   Cell B    │    │   Cell C    │  │
│  │  (State +   │    │  (State +   │    │  (State +   │  │
│  │  Machine)   │    │  Machine)   │    │  Machine)   │  │
│  └─────────────┘    └─────────────┘    └─────────────┘  │
│                                                            │
│  • Isolated state machines                                │
│  • Pure transition functions                              │
│  • Event sourcing                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Cell Lifecycle States

1. **Draft** - Cell created, awaiting funding details
2. **AwaitingFunding** - Policy set, waiting for funds to arrive
3. **FundedLocked** - Funds bound and locked, awaiting resolution
4. **ReleaseRequested** - Payee requests release, awaiting execution
5. **RefundRequested** - Payer requests refund, awaiting execution
6. **Disputed** - Arbiter intervention required
7. **Closed** - Successfully completed (released or refunded)
8. **Terminated** - Cell ended due to policy violation or timeout

---

## Security Model

| Threat Vector | Mitigation |
|--------------|------------|
| Cross-cell attacks | Strict CellId isolation |
| Replay attacks | Command deduplication via event log |
| Double-spend | State machine enforces mutual exclusivity |
| Front-running | Funding finality before exit paths |
| Privilege escalation | No admin keys, policy-bound roles |
| State corruption | Immutable event log, pure transitions |

---

## References

- `docs/INVARIANTS.md` - Formal invariant specifications
- `src/core/types.ts` - Core domain type definitions
- `src/kernel/` - State machine implementation (forthcoming)
