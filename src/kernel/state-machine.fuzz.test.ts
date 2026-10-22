/**
 * Deterministic state-machine fuzzing.
 *
 * These tests deliberately generate hostile command sequences and corrupted
 * event streams. A failing seed is printed in the Jest test name and can be
 * replayed exactly without relying on Math.random().
 */

import { cellKernel } from './index';
import {
  TERMINAL_STATUSES,
  ZERO_VERSION,
  makeActorId,
  makeAmount,
  makeCellId,
  makeCommandId,
  makeEventId,
  makeTimestamp,
  nextVersion,
} from '../core/types';
import type {
  ActorId,
  Amount,
  CellCreatedPayload,
  CellState,
  Command,
  DeterministicContext,
  Event,
  Timestamp,
  Version,
} from '../core/types';

const CELL = makeCellId('fuzz-cell');
const OTHER_CELL = makeCellId('fuzz-other-cell');
const PAYER = makeActorId('fuzz-payer');
const PAYEE = makeActorId('fuzz-payee');
const ARBITER = makeActorId('fuzz-arbiter');
const STRANGER = makeActorId('fuzz-stranger');
const ACTORS = [PAYER, PAYEE, ARBITER, STRANGER] as const;
const AMOUNT = makeAmount(10_000n);
const WRONG_AMOUNT = makeAmount(10_001n);

const T0 = makeTimestamp(1_000);
const FUNDING_DEADLINE = makeTimestamp(2_000);
const COMPLETION_DEADLINE = makeTimestamp(5_000);
const TIMES = [
  T0,
  makeTimestamp(1_999),
  FUNDING_DEADLINE,
  makeTimestamp(2_001),
  makeTimestamp(4_999),
  COMPLETION_DEADLINE,
  makeTimestamp(5_001),
] as const;

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  pick<T>(values: readonly T[]): T {
    return values[this.next() % values.length]!;
  }

  chance(numerator: number, denominator: number): boolean {
    return this.next() % denominator < numerator;
  }
}

function context(seed: number, step: number, now: Timestamp): DeterministicContext {
  return {
    now,
    nextEventId: (index) => makeEventId(`fuzz-${seed}-${step}-${index}`),
  };
}

function command(
  seed: number,
  step: number,
  cellId: typeof CELL | typeof OTHER_CELL,
  type: Command['type'],
  payload: Command['payload'],
): Command {
  return {
    commandId: makeCommandId(`fuzz-command-${seed}-${step}`),
    cellId,
    type,
    payload,
  };
}

function actorOrExpected(random: SeededRandom, expected: ActorId): ActorId {
  return random.chance(1, 2) ? expected : random.pick(ACTORS);
}

function fuzzCommand(
  random: SeededRandom,
  seed: number,
  step: number,
  state: Readonly<CellState>,
): { readonly command: Command; readonly now: Timestamp } {
  const now = random.pick(TIMES);
  const targetCell = random.chance(1, 8) ? OTHER_CELL : CELL;
  const payer = state.payer === ('' as ActorId) ? PAYER : state.payer;
  const payee = state.payee === ('' as ActorId) ? PAYEE : state.payee;
  const arbiter = state.arbiter ?? ARBITER;
  const amount = state.payer === ('' as ActorId) ? AMOUNT : state.amount;
  const currentTime = random.pick(TIMES);

  switch (random.next() % 13) {
    case 0: {
      const variant = random.next() % 8;
      const payload = {
        payer: variant === 1 ? PAYER : payer,
        payee: variant === 1 ? PAYER : payee,
        description: variant === 2 ? '' : variant === 3 ? 'bad\u0000text' : 'Fuzzed deterministic agreement.',
        ...(variant === 4 ? { arbiter: payer } : { arbiter }),
        amount: (variant === 5 ? 0n : amount) as Amount,
        currency: (variant === 6 ? 'USD' : 'TRY') as 'TRY',
        fundingDeadline: variant === 7 ? COMPLETION_DEADLINE : FUNDING_DEADLINE,
        completionDeadline: variant === 7 ? FUNDING_DEADLINE : COMPLETION_DEADLINE,
      };
      return { command: command(seed, step, targetCell, 'CreateCell', payload), now };
    }
    case 1:
      return {
        command: command(seed, step, targetCell, 'AcceptCell', {
          acceptedBy: actorOrExpected(random, payee),
        }),
        now,
      };
    case 2:
      return {
        command: command(seed, step, targetCell, 'RejectCell', {
          rejectedBy: actorOrExpected(random, payee),
        }),
        now,
      };
    case 3:
      return {
        command: command(seed, step, targetCell, 'FundCell', {
          funderId: actorOrExpected(random, payer),
          amount: random.chance(3, 4) ? amount : WRONG_AMOUNT,
        }),
        now,
      };
    case 4:
      return {
        command: command(seed, step, targetCell, 'RequestRelease', {
          requestedBy: random.chance(3, 4) ? random.pick([payer, payee]) : STRANGER,
        }),
        now,
      };
    case 5: {
      const expected = state.releaseRequestedBy === payer ? payee : payer;
      return {
        command: command(seed, step, targetCell, 'ApproveRelease', {
          approvedBy: actorOrExpected(random, expected),
        }),
        now,
      };
    }
    case 6:
      return {
        command: command(seed, step, targetCell, 'RequestRefund', {
          requestedBy: actorOrExpected(random, payer),
        }),
        now,
      };
    case 7:
      return {
        command: command(seed, step, targetCell, 'ApproveRefund', {
          approvedBy: actorOrExpected(random, payee),
        }),
        now,
      };
    case 8:
      return {
        command: command(seed, step, targetCell, 'ForceRefund', {
          requestedBy: actorOrExpected(random, payer),
          currentTime,
        }),
        now,
      };
    case 9:
      return {
        command: command(seed, step, targetCell, 'ExpireCell', {
          triggeredBy: random.pick(ACTORS),
          currentTime,
        }),
        now,
      };
    case 10:
      return {
        command: command(seed, step, targetCell, 'OpenDispute', {
          openedBy: random.chance(3, 4) ? random.pick([payer, payee]) : STRANGER,
          currentTime,
        }),
        now,
      };
    case 11:
      return {
        command: command(seed, step, targetCell, 'ResolveDispute', {
          resolvedBy: actorOrExpected(random, arbiter),
          favourOf: random.pick(['payer', 'payee'] as const),
        }),
        now,
      };
    default:
      return {
        command: {
          commandId: makeCommandId(`fuzz-command-${seed}-${step}`),
          cellId: targetCell,
          type: 'UnknownCommand',
          payload: {},
        } as unknown as Command,
        now,
      };
  }
}

function assertStateInvariants(state: Readonly<CellState>, events: readonly Event[]): void {
  expect(state.cellId).toBe(CELL);

  const createdEvents = events.filter((event) => event.type === 'CellCreated');
  const fundingEvents = events.filter((event) => event.type === 'CellFunded');
  const settlementEvents = events.filter((event) => event.type === 'Released' || event.type === 'Refunded');

  expect(createdEvents.length).toBeLessThanOrEqual(1);
  expect(fundingEvents.length).toBeLessThanOrEqual(1);
  expect(settlementEvents.length).toBeLessThanOrEqual(1);
  if (events.length > 0) expect(events[0]?.type).toBe('CellCreated');
  if (settlementEvents.length === 1) expect(fundingEvents).toHaveLength(1);

  if (createdEvents[0]?.type === 'CellCreated') {
    const original = createdEvents[0].payload as CellCreatedPayload;
    expect(state.payer).toBe(original.payer);
    expect(state.payee).toBe(original.payee);
    expect(state.arbiter).toBe(original.arbiter);
    expect(state.description).toBe(original.description);
    expect(state.amount).toBe(original.amount);
    expect(state.currency).toBe(original.currency);
    expect(state.fundingDeadline).toBe(original.fundingDeadline);
    expect(state.completionDeadline).toBe(original.completionDeadline);
  }

  if (['FUNDED', 'DISPUTED', 'RELEASED', 'REFUNDED'].includes(state.status)) {
    expect(fundingEvents).toHaveLength(1);
  }
  if (state.status === 'EXPIRED') expect(fundingEvents).toHaveLength(0);
  if (state.status === 'RELEASED') expect(settlementEvents[0]?.type).toBe('Released');
  if (state.status === 'REFUNDED') expect(settlementEvents[0]?.type).toBe('Refunded');

  expect(events.map((event) => event.version)).toEqual(
    events.map((_, index) => index + 1),
  );
  expect(events.every((event) => event.cellId === CELL)).toBe(true);
  expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
}

const COMMAND_SEEDS = Array.from({ length: 64 }, (_, index) => 0x5a17 + index * 7919);

describe('deterministic hostile command sequences', () => {
  test.each(COMMAND_SEEDS)('seed %i preserves every kernel invariant', (seed) => {
    const random = new SeededRandom(seed);
    const initial = cellKernel.evolve(CELL, []);
    expect('code' in initial).toBe(false);
    if ('code' in initial) return;

    let state = initial;
    let version = nextVersion(ZERO_VERSION);
    const events: Event[] = [];

    for (let step = 0; step < 128; step += 1) {
      const generated = fuzzCommand(random, seed, step, state);
      const ctx = context(seed, step, generated.now);
      const before = state;
      const first = cellKernel.applyCommand(state, generated.command, version, ctx);
      const second = cellKernel.applyCommand(state, generated.command, version, ctx);

      expect(second).toEqual(first);

      if (!first.ok) {
        expect(state).toEqual(before);
        assertStateInvariants(state, events);
        continue;
      }

      expect(generated.command.cellId).toBe(CELL);
      expect(first.events.every((event) => event.timestamp === generated.now)).toBe(true);
      events.push(...first.events);
      state = first.nextState;
      version = (version + first.events.length) as Version;

      const replayed = cellKernel.evolve(CELL, events);
      expect('code' in replayed).toBe(false);
      if (!('code' in replayed)) expect(replayed).toEqual(state);
      assertStateInvariants(state, events);

      if (TERMINAL_STATUSES.has(state.status)) {
        const terminalState = state;
        const followUp = command(seed, step + 10_000, CELL, 'RequestRelease', {
          requestedBy: state.payer,
        });
        const rejected = cellKernel.applyCommand(
          state,
          followUp,
          version,
          context(seed, step + 10_000, generated.now),
        );
        expect(rejected.ok).toBe(false);
        expect(state).toEqual(terminalState);
      }
    }
  });
});

function validTerminalStream(seed: number): Event[] {
  const commands: Command[] = [
    command(seed, 0, CELL, 'CreateCell', {
      payer: PAYER,
      payee: PAYEE,
      arbiter: ARBITER,
      description: 'Valid stream used as a corruption target.',
      amount: AMOUNT,
      currency: 'TRY',
      fundingDeadline: FUNDING_DEADLINE,
      completionDeadline: COMPLETION_DEADLINE,
    }),
    command(seed, 1, CELL, 'AcceptCell', { acceptedBy: PAYEE }),
    command(seed, 2, CELL, 'FundCell', { funderId: PAYER, amount: AMOUNT }),
    command(seed, 3, CELL, 'RequestRelease', { requestedBy: PAYEE }),
    command(seed, 4, CELL, 'ApproveRelease', { approvedBy: PAYER }),
  ];

  const events: Event[] = [];
  const initial = cellKernel.evolve(CELL, []);
  if ('code' in initial) throw new Error(initial.message);
  let state = initial;
  let version = nextVersion(ZERO_VERSION);

  commands.forEach((item, step) => {
    const result = cellKernel.applyCommand(state, item, version, context(seed, step, T0));
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    events.push(...result.events);
    state = result.nextState;
    version = (version + result.events.length) as Version;
  });

  return events;
}

const STREAM_SEEDS = Array.from({ length: 48 }, (_, index) => 0xc0de + index * 3571);

describe('regressions discovered by fuzzing', () => {
  test('rejects a command whose cellId does not match the loaded state', () => {
    const initial = cellKernel.evolve(CELL, []);
    expect('code' in initial).toBe(false);
    if ('code' in initial) return;

    const result = cellKernel.applyCommand(
      initial,
      command(1, 0, OTHER_CELL, 'CreateCell', {
        payer: PAYER,
        payee: PAYEE,
        description: 'Cross-cell context attack.',
        amount: AMOUNT,
        currency: 'TRY',
        fundingDeadline: FUNDING_DEADLINE,
        completionDeadline: COMPLETION_DEADLINE,
      }),
      nextVersion(ZERO_VERSION),
      context(1, 0, T0),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVARIANT_VIOLATION');
  });

  test('cannot expire the sentinel state before CellCreated exists', () => {
    const initial = cellKernel.evolve(CELL, []);
    expect('code' in initial).toBe(false);
    if ('code' in initial) return;

    const result = cellKernel.applyCommand(
      initial,
      command(2, 0, CELL, 'ExpireCell', {
        triggeredBy: STRANGER,
        currentTime: makeTimestamp(10_000),
      }),
      nextVersion(ZERO_VERSION),
      context(2, 0, makeTimestamp(10_000)),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ILLEGAL_TRANSITION');
  });
});

describe('fuzzed event-stream corruption', () => {
  test.each(STREAM_SEEDS)('seed %i fails closed', (seed) => {
    const random = new SeededRandom(seed);
    const events = validTerminalStream(seed);
    const corrupted = events.map((event) => ({ ...event })) as Event[];

    switch (random.next() % 6) {
      case 0:
        corrupted[1] = { ...corrupted[1]!, version: 99 as Version };
        break;
      case 1:
        corrupted[2] = { ...corrupted[2]!, cellId: OTHER_CELL };
        break;
      case 2:
        corrupted[1] = { ...corrupted[1]!, type: 'UnsupportedEvent' } as unknown as Event;
        break;
      case 3:
        [corrupted[1], corrupted[2]] = [corrupted[2]!, corrupted[1]!];
        break;
      case 4:
        corrupted.splice(2, 0, { ...corrupted[1]! });
        break;
      default:
        corrupted.push({
          ...corrupted[0]!,
          eventId: makeEventId(`post-terminal-${seed}`),
          version: (corrupted.length + 1) as Version,
        });
        break;
    }

    const result = cellKernel.evolve(CELL, corrupted);
    expect('code' in result).toBe(true);
    if ('code' in result) expect(result.code).toBe('STREAM_INTEGRITY_ERROR');
  });
});
