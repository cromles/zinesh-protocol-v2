import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cellKernel,
  makeActorId,
  makeAmount,
  makeCellId,
  makeCommandId,
  makeEventId,
  makeTimestamp,
  nextVersion,
  ZERO_VERSION,
} from '../src/index';
import type {
  CellState,
  Command,
  DeterministicContext,
  Event,
  KernelResult,
  Version,
} from '../src/index';

const payer = makeActorId('payer');
const payee = makeActorId('payee');
const arbiter = makeActorId('arbiter');
const stranger = makeActorId('stranger');
const cellId = makeCellId('agreement');
const amount = makeAmount(10_000n);
const now = makeTimestamp(1_000);
const fundingDeadline = makeTimestamp(2_000);
const completionDeadline = makeTimestamp(5_000);

function context(prefix: string): DeterministicContext {
  return {
    now,
    nextEventId: (index) => makeEventId(`${prefix}-${index}`),
  };
}

function command(
  id: string,
  type: Command['type'],
  payload: Command['payload'],
): Command {
  return { commandId: makeCommandId(id), cellId, type, payload };
}

function create(id = 'create'): Command {
  return command(id, 'CreateCell', {
    payer,
    payee,
    arbiter,
    description: 'A deterministic agreement for package verification.',
    amount,
    currency: 'TRY',
    fundingDeadline,
    completionDeadline,
  });
}

function run(commands: readonly Command[]): {
  readonly state: CellState;
  readonly events: readonly Event[];
  readonly nextVersion: Version;
} {
  const initial = cellKernel.evolve(cellId, []);
  assert.ok(!('code' in initial));
  let state = initial;
  let version = nextVersion(ZERO_VERSION);
  const events: Event[] = [];

  commands.forEach((item, index) => {
    const result = cellKernel.applyCommand(state, item, version, context(`event-${index}`));
    assert.equal(result.ok, true);
    state = result.nextState;
    events.push(...result.events);
    version = (version + result.events.length) as Version;
  });

  return { state, events, nextVersion: version };
}

function expectError(result: KernelResult, code: string): void {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, code);
}

const accepted = command('accept', 'AcceptCell', { acceptedBy: payee });
const funded = command('fund', 'FundCell', { funderId: payer, amount });

test('identical input and deterministic context produce identical output', () => {
  const { state, nextVersion: version } = run([create(), accepted, funded]);
  const request = command('release', 'RequestRelease', { requestedBy: payer });
  const first = cellKernel.applyCommand(state, request, version, context('fixed'));
  const second = cellKernel.applyCommand(state, request, version, context('fixed'));
  assert.deepEqual(first, second);
});

test('event replay reconstructs exactly the command-derived state', () => {
  const executed = run([
    create(),
    accepted,
    funded,
    command('release', 'RequestRelease', { requestedBy: payer }),
  ]);
  const replayed = cellKernel.evolve(cellId, executed.events);
  assert.ok(!('code' in replayed));
  assert.deepEqual(replayed, executed.state);
});

test('participant authorization rejects an unrelated actor', () => {
  const { state, nextVersion: version } = run([create(), accepted, funded]);
  const result = cellKernel.applyCommand(
    state,
    command('unauthorized', 'OpenDispute', { openedBy: stranger, currentTime: now }),
    version,
    context('unauthorized'),
  );
  expectError(result, 'AUTHORIZATION_DENIED');
});

test('a repeated pending request is rejected without emitting an event', () => {
  const executed = run([
    create(),
    accepted,
    funded,
    command('release-1', 'RequestRelease', { requestedBy: payer }),
  ]);
  const duplicate = cellKernel.applyCommand(
    executed.state,
    command('release-2', 'RequestRelease', { requestedBy: payer }),
    executed.nextVersion,
    context('duplicate'),
  );
  expectError(duplicate, 'PRECONDITION_FAILED');
});

test('dispute resolution is ordered and binary', () => {
  const disputed = run([
    create(),
    accepted,
    funded,
    command('dispute', 'OpenDispute', { openedBy: payer, currentTime: now }),
  ]);
  const resolved = cellKernel.applyCommand(
    disputed.state,
    command('resolve', 'ResolveDispute', { resolvedBy: arbiter, favourOf: 'payee' }),
    disputed.nextVersion,
    context('resolution'),
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.deepEqual(resolved.events.map((event) => event.type), ['DisputeResolved', 'Released']);
  assert.equal(resolved.nextState.status, 'RELEASED');
});

test('replay rejects version gaps', () => {
  const executed = run([create()]);
  const badEvent: Event = {
    ...executed.events[0]!,
    eventId: makeEventId('gap'),
    version: 3 as Version,
  };
  const result = cellKernel.evolve(cellId, [executed.events[0]!, badEvent]);
  assert.ok('code' in result);
  if ('code' in result) assert.equal(result.code, 'STREAM_INTEGRITY_ERROR');
});

test('replay rejects unsupported event types', () => {
  const executed = run([create()]);
  const unsupported = {
    ...executed.events[0]!,
    eventId: makeEventId('unsupported'),
    type: 'FutureEvent',
  } as unknown as Event;
  const result = cellKernel.evolve(cellId, [unsupported]);
  assert.ok('code' in result);
  if ('code' in result) assert.equal(result.code, 'STREAM_INTEGRITY_ERROR');
});

test('acceptance and funding fail after the funding deadline', () => {
  const created = run([create()]);
  const lateContext: DeterministicContext = {
    now: makeTimestamp(2_001),
    nextEventId: (index) => makeEventId(`late-${index}`),
  };
  const lateAcceptance = cellKernel.applyCommand(
    created.state,
    accepted,
    created.nextVersion,
    lateContext,
  );
  expectError(lateAcceptance, 'DEADLINE_VIOLATION');

  const acceptedOnTime = run([create(), accepted]);
  const lateFunding = cellKernel.applyCommand(
    acceptedOnTime.state,
    funded,
    acceptedOnTime.nextVersion,
    lateContext,
  );
  expectError(lateFunding, 'DEADLINE_VIOLATION');
});
