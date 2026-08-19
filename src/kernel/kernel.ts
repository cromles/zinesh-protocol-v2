/**
 * ZINESH PROTOCOL V2 — Kernel Core
 *
 * Pure, deterministic, I/O-free kernel execution frame.
 *
 * Responsibilities:
 *   1. Fold a stream of events onto an initial state to produce current state.
 *   2. Validate event stream integrity before folding.
 *   3. Apply a command against current state to produce new events + next state.
 *
 * This file contains ZERO domain logic.
 * All domain decisions are injected via KernelHandlers from state-machine.ts.
 *
 * What the kernel does NOT do:
 *   - No I/O of any kind
 *   - No Date.now() / Math.random() / UUID generation
 *   - No database access
 *   - No HTTP
 *   - No global mutable state
 */

import type {
  CellId,
  CellState,
  Command,
  DeterministicContext,
  Event,
  KernelError,
  KernelResult,
  Version,
} from '../core/types';
import { kernelError, nextVersion, TERMINAL_STATUSES } from '../core/types';

// ---------------------------------------------------------------------------
// Handler types — injected by the domain layer (state-machine.ts)
// ---------------------------------------------------------------------------

/**
 * A single event to emit: type + payload pair.
 * Supports heterogeneous event types from one command (e.g. ResolveDispute
 * which must emit DisputeResolved then Released/Refunded).
 */
export interface EventEmission {
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}

/**
 * A CommandHandler receives the current state and command, and either:
 *   - returns a list of EventEmissions to persist (success path), or
 *   - returns a KernelError (rejection path).
 *
 * Handlers are pure functions: same inputs → same outputs, no side effects.
 *
 * Handlers do NOT assign eventId, version, or timestamp.
 * The kernel frame assigns those from the deterministic context.
 */
export type CommandHandler = (
  state: Readonly<CellState>,
  command: Command,
  ctx: DeterministicContext,
) =>
  | { readonly ok: true;  readonly emissions: ReadonlyArray<EventEmission> }
  | { readonly ok: false; readonly error: KernelError };

/**
 * An EventFolder receives the current state and one event, and returns the
 * next state. Must be a pure function.
 */
export type EventFolder = (state: Readonly<CellState>, event: Event) => CellState;

/**
 * The full set of handlers that define domain behaviour.
 * This is the only domain-specific injection point into the kernel.
 */
export interface KernelHandlers {
  readonly commandHandlers: Readonly<Record<string, CommandHandler>>;
  readonly eventFolder: EventFolder;
  readonly initialState: (cellId: CellId) => CellState;
}

// ---------------------------------------------------------------------------
// Kernel public interface
// ---------------------------------------------------------------------------

export interface Kernel {
  /**
   * Validate and fold a stream of events to recover current cell state.
   *
   * Integrity checks performed:
   *   - All events must share the given cellId
   *   - Versions must be consecutive starting from 1 (no gaps, no duplicates)
   *   - No event may follow a terminal status
   *
   * Returns error if stream is invalid; otherwise returns the folded state.
   */
  evolve(cellId: CellId, events: ReadonlyArray<Event>): CellState | KernelError;

  /**
   * Apply a command to a given state.
   * Returns events to append and the resulting next state, or an error.
   *
   * Caller supplies:
   *   - current state (from evolve)
   *   - expectedNextVersion (for version assignment on produced events)
   *   - deterministic context (now, nextEventId)
   *
   * The kernel does NOT perform version conflict detection against a store.
   * That responsibility belongs to the EventStore adapter.
   */
  applyCommand(
    state: Readonly<CellState>,
    command: Command,
    expectedNextVersion: Version,
    ctx: DeterministicContext,
  ): KernelResult;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createKernel(handlers: KernelHandlers): Kernel {
  return {
    evolve(cellId: CellId, events: ReadonlyArray<Event>): CellState | KernelError {
      if (events.length === 0) {
        return handlers.initialState(cellId);
      }

      let expectedVersion = 1 as Version;
      let state = handlers.initialState(cellId);

      for (const event of events) {
        // Cell ID scope check
        if (event.cellId !== cellId) {
          return kernelError(
            'STREAM_INTEGRITY_ERROR',
            `Event cellId mismatch: expected ${cellId}, got ${event.cellId}`,
          );
        }

        // Version gap / duplicate check
        if (event.version !== expectedVersion) {
          return kernelError(
            'STREAM_INTEGRITY_ERROR',
            `Version sequence broken: expected ${expectedVersion}, got ${event.version}`,
          );
        }

        // Terminal state check — no event may follow a terminal status
        if (TERMINAL_STATUSES.has(state.status)) {
          return kernelError(
            'STREAM_INTEGRITY_ERROR',
            `Event at version ${event.version} follows terminal status ${state.status}`,
          );
        }

        state = handlers.eventFolder(state, event);
        expectedVersion = nextVersion(expectedVersion);
      }

      return state;
    },

    applyCommand(
      state: Readonly<CellState>,
      command: Command,
      expectedNextVersion: Version,
      ctx: DeterministicContext,
    ): KernelResult {
      // Terminal state guard — commands cannot be applied to terminal cells
      if (TERMINAL_STATUSES.has(state.status)) {
        return {
          ok: false,
          error: kernelError(
            'ILLEGAL_TRANSITION',
            `Cell is in terminal status ${state.status}; no further commands are accepted`,
          ),
        };
      }

      const handler = handlers.commandHandlers[command.type];
      if (handler === undefined) {
        return {
          ok: false,
          error: kernelError('UNKNOWN_COMMAND', `No handler for command type: ${command.type}`),
        };
      }

      const handlerResult = handler(state, command, ctx);
      if (!handlerResult.ok) {
        return { ok: false, error: handlerResult.error };
      }

      const { emissions } = handlerResult;

      if (emissions.length === 0) {
        return { ok: true, events: [], nextState: state };
      }

      const events: Event[] = [];
      let version = expectedNextVersion;

      for (let i = 0; i < emissions.length; i++) {
        const emission = emissions[i];
        if (emission === undefined) continue;

        events.push({
          eventId:   ctx.nextEventId(i),
          cellId:    command.cellId,
          version,
          timestamp: ctx.now,
          type:      emission.eventType as Event['type'],
          payload:   emission.payload as unknown as Event['payload'],
        });

        version = nextVersion(version);
      }

      const nextState = events.reduce<CellState>(
        (s, ev) => handlers.eventFolder(s, ev),
        state,
      );

      return { ok: true, events, nextState };
    },
  };
}
