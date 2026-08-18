# Zinesh 2.0 - Protocol Invariants

This document defines the **non-negotiable invariants** that must be enforced by the type system and runtime logic of Zinesh 2.0.

---

## Invariant 1: Conservation of Funds

**Statement:** Funds cannot be created or destroyed within a cell.

**Formal Definition:**
```
∀ cell ∈ Cells:
  sum(cell.events where event.type ∈ {FundingBound, CellReleased, CellRefunded}) = 0
  
  i.e., FundedAmount = ReleasedAmount + RefundedAmount
```

**Enforcement Mechanisms:**
- `Amount` type uses `bigint` to prevent precision loss
- State machine validates that release/refund amounts never exceed funded amount
- No arithmetic operations that could overflow without explicit handling

**Violation Examples (MUST PREVENT):**
- Releasing more than the funded amount
- Releasing AND refunding the same funds (double-spend)
- Rounding errors creating or destroying dust amounts

---

## Invariant 2: No Double Spend

**Statement:** A cell cannot execute both a Release and a Refund for the same funds.

**Formal Definition:**
```
∀ cell ∈ Cells:
  ¬(cell.state = Closed via Release ∧ cell.state = Closed via Refund)
  
  i.e., Mutually exclusive terminal states
```

**Enforcement Mechanisms:**
- State machine enforces that `CellReleased` and `CellRefunded` are mutually exclusive events
- Once a terminal event is emitted, no further state transitions are allowed
- Type system prevents calling both release and refund handlers

**Violation Examples (MUST PREVENT):**
- Calling `release()` after `refund()` has been executed
- Calling `refund()` after `release()` has been executed
- Race conditions allowing both paths to complete

---

## Invariant 3: Context Binding

**Statement:** Commands must strictly match the `CellId` of the state they are mutating.

**Formal Definition:**
```
∀ command ∈ Commands, ∀ cell ∈ Cells:
  command.cellId = cell.id ⇒ command may mutate cell.state
  command.cellId ≠ cell.id ⇒ command MUST NOT mutate cell.state
```

**Enforcement Mechanisms:**
- `CellId` is a branded type preventing accidental mixing
- Command validation checks `cellId` before any state mutation
- Compile-time type safety using TypeScript branded types

**Violation Examples (MUST PREVENT):**
- A command intended for Cell A accidentally mutating Cell B
- ID spoofing or confusion attacks
- Cross-cell replay attacks

---

## Invariant 4: Funding Finality

**Statement:** Exit paths (Release/Refund) cannot be triggered before funding is strictly bound and finalized.

**Formal Definition:**
```
∀ cell ∈ Cells:
  cell.state ∈ {ReleaseRequested, RefundRequested, Disputed} 
    ⇒ cell.state was previously {FundedLocked}
  
  i.e., ¬(FundingBound event) ⇒ ¬(ReleaseRequested ∨ RefundRequested)
```

**Enforcement Mechanisms:**
- State machine only allows transition to exit states from `FundedLocked`
- `BindFunding` command must be successfully processed before any exit command
- Type system enforces state preconditions

**Violation Examples (MUST PREVENT):**
- Requesting release before funds are confirmed
- Refunding an unfunded cell
- Exploiting race conditions during funding window

---

## Additional Safety Properties

### Property 5: State Machine Integrity

**Statement:** All state transitions must be valid according to the defined state machine.

**Allowed Transitions:**
```
Draft → AwaitingFunding → FundedLocked → ReleaseRequested → Closed
                                      ↓
                                RefundRequested → Closed
                                      ↓
                                  Disputed → Closed
                                      
Any State → Terminated (on policy violation or timeout)
```

### Property 6: Immutability of History

**Statement:** Once an event is recorded, it cannot be modified or deleted.

**Enforcement:**
- Event log is append-only
- Events are immutable (readonly properties)
- Replay detection prevents duplicate event processing

### Property 7: Role Authorization

**Statement:** Only authorized roles can execute specific commands.

| Command | Authorized Roles |
|---------|------------------|
| `CreateCell` | Payer (initiator) |
| `BindFunding` | System (on-chain confirmation) |
| `RequestRelease` | Payee |
| `RequestRefund` | Payer |
| `OpenDispute` | Payer, Payee |
| `TriggerTimeout` | Any party (after timeout) |

---

## Type-Level Enforcement

The following TypeScript patterns enforce invariants at compile-time:

### Branded Types for CellId
```typescript
type CellId = string & { readonly brand: unique symbol };
```

### Readonly Properties
```typescript
interface Policy {
  readonly amount: Amount;
  readonly asset: AssetRef;
  readonly timeout: number;
}
```

### Discriminated Unions for State
```typescript
type CellState = 
  | 'Draft'
  | 'AwaitingFunding'
  | 'FundedLocked'
  | 'ReleaseRequested'
  | 'RefundRequested'
  | 'Disputed'
  | 'Closed'
  | 'Terminated';
```

### Exact Optional Property Types
```typescript
// Prevents undefined vs missing property confusion
interface Cell {
  releasedAt?: number;  // Must be number if present, not undefined
}
```

---

## Runtime Validation

In addition to type-level enforcement, runtime checks MUST validate:

1. **Command Context:** Verify `command.cellId === state.cellId`
2. **State Preconditions:** Ensure current state allows the requested transition
3. **Amount Bounds:** Validate amounts are non-negative and within bounds
4. **Replay Detection:** Check command/event IDs against processed history
5. **Timeout Validation:** Ensure timeouts are evaluated correctly

---

## Audit Checklist

Before any code merge, verify:

- [ ] Conservation invariant holds for all code paths
- [ ] Double-spend is impossible by construction
- [ ] CellId binding is enforced at every mutation point
- [ ] Funding finality is checked before any exit path
- [ ] No global state or shared mutable data exists
- [ ] Core domain contains zero I/O operations
- [ ] All types use `readonly` where applicable
- [ ] `strict`, `noImplicitAny`, `exactOptionalPropertyTypes` are enabled
