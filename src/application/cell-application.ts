/**
 * ZINESH PROTOCOL V2 — Cell Application
 *
 * Orchestrator only. External intent → shape/auth → load stream →
 * Kernel.evolve → DeterministicContext → Kernel.applyCommand → persist.
 *
 * Kernel remains the sole authority for transitions, authorization,
 * deadlines, escrow, settlement, disputes, money, and invariants.
 *
 * Reconstruction path (the only legal one):
 *   eventStore.getEvents(cellId) → kernel.evolve(cellId, events)
 *
 * Snapshots are write-only. Snapshot save failure does not invalidate
 * successfully appended events. The result contract has no snapshot-warning
 * channel, so a snapshot save failure is swallowed and SUCCESS is returned.
 */

import type { PersistenceAdapter } from '../adapters/persistence-adapter';
import type { EventStoreError } from '../adapters/event-store';
import type {
  ActorId,
  Amount,
  CellId,
  CellState,
  Command,
  CommandId,
  DeterministicContext,
  DomainCommandType,
  Event,
  KernelError,
  Timestamp,
  Version,
} from '../core/types';
import {
  makeActorId,
  makeAmount,
  makeCellId,
  makeCommandId,
  makeTimestamp,
  nextVersion,
  ZERO_VERSION,
} from '../core/types';
import type { Kernel } from '../kernel/kernel';
import type { Clock } from './clock';
import type { EventIdFactory } from './event-id-factory';
import {
  gatewayDenied,
  invalidInput,
  mapEventStoreError,
  opaquePersistenceFailure,
  unauthenticated,
  type ApplicationError,
} from './errors';
import type { HandleCommandRequest, HandleCommandResult } from './types';

const RECOGNIZED_COMMAND_TYPES: ReadonlySet<DomainCommandType> = new Set([
  'CreateCell',
  'FundCell',
  'RequestRelease',
  'ApproveRelease',
  'RequestRefund',
  'ApproveRefund',
  'ForceRefund',
  'ExpireCell',
  'OpenDispute',
  'ResolveDispute',
]);

const CLOCK_ALIGNED_COMMANDS: ReadonlySet<DomainCommandType> = new Set([
  'ExpireCell',
  'ForceRefund',
  'OpenDispute',
]);

export interface CellApplicationDeps {
  readonly persistence: PersistenceAdapter;
  readonly kernel: Kernel;
  readonly clock: Clock;
  readonly eventIds: EventIdFactory;
}

export class CellApplication {
  private readonly persistence: PersistenceAdapter;
  private readonly kernel: Kernel;
  private readonly clock: Clock;
  private readonly eventIds: EventIdFactory;

  constructor(deps: CellApplicationDeps) {
    this.persistence = deps.persistence;
    this.kernel = deps.kernel;
    this.clock = deps.clock;
    this.eventIds = deps.eventIds;
  }

  async handleCommand(request: HandleCommandRequest): Promise<HandleCommandResult> {
    const auth = authenticateCaller(request);
    if (auth !== undefined) {
      return applicationRejection(auth);
    }

    const shaped = validateCommandShape(request.command);
    if (!shaped.ok) {
      return applicationRejection(shaped.error);
    }

    let command = shaped.command;

    if (command.type === 'FundCell') {
      if (request.gateway?.authorizedGateway !== true) {
        return applicationRejection(gatewayDenied());
      }
    }

    const now = this.clock.now();
    command = alignDeadlineCommandTime(command, now);

    const cellId = command.cellId;

    let loaded: ReadonlyArray<Event>;
    try {
      loaded = await this.persistence.eventStore.getEvents(cellId);
    } catch (err) {
      return persistenceFailureResult(toPersistenceFailure(err));
    }

    const evolved = this.kernel.evolve(cellId, loaded);
    if (isKernelError(evolved)) {
      return { outcome: 'KERNEL_REJECTION', error: evolved };
    }

    const expectedNextVersion = expectedVersionFromStream(loaded);

    const context: DeterministicContext = {
      now,
      nextEventId: (index: number) => this.eventIds.nextEventId(index),
    };

    const kernelResult = this.kernel.applyCommand(
      evolved,
      command,
      expectedNextVersion,
      context,
    );

    if (!kernelResult.ok) {
      return { outcome: 'KERNEL_REJECTION', error: kernelResult.error };
    }

    if (kernelResult.events.length > 0) {
      let appendResult;
      try {
        appendResult = await this.persistence.eventStore.append(
          cellId,
          kernelResult.events,
        );
      } catch (err) {
        return persistenceFailureResult(toPersistenceFailure(err));
      }

      if (!appendResult.ok) {
        return persistenceFailureResult(mapEventStoreError(appendResult.error));
      }

      const last = kernelResult.events[kernelResult.events.length - 1];
      if (last !== undefined) {
        try {
          await this.persistence.snapshotStore.save(cellId, {
            cellId,
            version: last.version,
            state: kernelResult.nextState,
          });
        } catch {
          // Snapshot is a write-only cache. Events remain authoritative.
          // HandleCommandResult has no non-domain warning channel, so SUCCESS
          // is returned. Do not roll back the append. Do not retry.
        }
      }
    }

    const version = resultingVersion(loaded, kernelResult.events);

    return {
      outcome: 'SUCCESS',
      events: kernelResult.events,
      nextState: kernelResult.nextState,
      version,
    };
  }
}

function applicationRejection(error: ApplicationError): HandleCommandResult {
  return { outcome: 'APPLICATION_REJECTION', error };
}

function persistenceFailureResult(error: ApplicationError): HandleCommandResult {
  return { outcome: 'PERSISTENCE_FAILURE', error };
}

function authenticateCaller(request: HandleCommandRequest): ApplicationError | undefined {
  if (request.caller === undefined || request.caller.authenticated !== true) {
    return unauthenticated();
  }
  const actor = parseActorId(request.caller.actorId, 'caller.actorId');
  if (!actor.ok) {
    return actor.error;
  }
  return undefined;
}

function expectedVersionFromStream(events: ReadonlyArray<Event>): Version {
  if (events.length === 0) {
    return nextVersion(ZERO_VERSION);
  }
  const last = events[events.length - 1];
  if (last === undefined) {
    return nextVersion(ZERO_VERSION);
  }
  return nextVersion(last.version);
}

function resultingVersion(
  loaded: ReadonlyArray<Event>,
  produced: ReadonlyArray<Event>,
): Version {
  const lastProduced = produced[produced.length - 1];
  if (lastProduced !== undefined) {
    return lastProduced.version;
  }
  const lastLoaded = loaded[loaded.length - 1];
  if (lastLoaded !== undefined) {
    return lastLoaded.version;
  }
  return ZERO_VERSION;
}

function isKernelError(value: CellState | KernelError): value is KernelError {
  return 'code' in value && !('status' in value);
}

function isEventStoreError(value: unknown): value is EventStoreError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'APPEND_VERSION_CONFLICT' || kind === 'APPEND_INTEGRITY_ERROR';
}

function toPersistenceFailure(error: unknown): ApplicationError {
  if (isEventStoreError(error)) {
    return mapEventStoreError(error);
  }
  return opaquePersistenceFailure();
}

function alignDeadlineCommandTime(command: Command, now: Timestamp): Command {
  if (!CLOCK_ALIGNED_COMMANDS.has(command.type)) {
    return command;
  }
  return {
    commandId: command.commandId,
    cellId: command.cellId,
    type: command.type,
    payload: {
      ...command.payload,
      currentTime: now,
    },
  };
}

// ---------------------------------------------------------------------------
// Input shape validation only — no domain rules
// ---------------------------------------------------------------------------

type ShapeResult =
  | { readonly ok: true; readonly command: Command }
  | { readonly ok: false; readonly error: ApplicationError };

function validateCommandShape(command: Command): ShapeResult {
  if (command === undefined || command === null || typeof command !== 'object') {
    return failShape('command is required');
  }

  const commandId = parseCommandId(command.commandId);
  if (!commandId.ok) {
    return commandId;
  }

  const cellId = parseCellId(command.cellId);
  if (!cellId.ok) {
    return cellId;
  }

  if (typeof command.type !== 'string' || !RECOGNIZED_COMMAND_TYPES.has(command.type)) {
    return failShape('command type is not recognized');
  }

  const payload = validatePayload(command.type, command.payload);
  if (!payload.ok) {
    return payload;
  }

  return {
    ok: true,
    command: {
      commandId: commandId.value,
      cellId: cellId.value,
      type: command.type,
      payload: payload.value,
    },
  };
}

function validatePayload(
  type: DomainCommandType,
  payload: Command['payload'],
):
  | { readonly ok: true; readonly value: Command['payload'] }
  | { readonly ok: false; readonly error: ApplicationError } {
  if (payload === undefined || payload === null || typeof payload !== 'object') {
    return failShape('command payload is required');
  }

  switch (type) {
    case 'CreateCell': {
      const payer = parseActorId(field(payload, 'payer'), 'payer');
      if (!payer.ok) return payer;
      const payee = parseActorId(field(payload, 'payee'), 'payee');
      if (!payee.ok) return payee;
      const amount = parseAmount(field(payload, 'amount'), 'amount');
      if (!amount.ok) return amount;
      const currency = parseCurrency(field(payload, 'currency'));
      if (!currency.ok) return currency;
      const fundingDeadline = parseTimestamp(field(payload, 'fundingDeadline'), 'fundingDeadline');
      if (!fundingDeadline.ok) return fundingDeadline;
      const completionDeadline = parseTimestamp(
        field(payload, 'completionDeadline'),
        'completionDeadline',
      );
      if (!completionDeadline.ok) return completionDeadline;

      const rawArbiter = field(payload, 'arbiter');
      if (rawArbiter === undefined) {
        return {
          ok: true,
          value: {
            payer: payer.value,
            payee: payee.value,
            amount: amount.value,
            currency: currency.value,
            fundingDeadline: fundingDeadline.value,
            completionDeadline: completionDeadline.value,
          },
        };
      }
      const arbiter = parseActorId(rawArbiter, 'arbiter');
      if (!arbiter.ok) return arbiter;
      return {
        ok: true,
        value: {
          payer: payer.value,
          payee: payee.value,
          arbiter: arbiter.value,
          amount: amount.value,
          currency: currency.value,
          fundingDeadline: fundingDeadline.value,
          completionDeadline: completionDeadline.value,
        },
      };
    }

    case 'FundCell': {
      const funderId = parseActorId(field(payload, 'funderId'), 'funderId');
      if (!funderId.ok) return funderId;
      const amount = parseAmount(field(payload, 'amount'), 'amount');
      if (!amount.ok) return amount;
      return { ok: true, value: { funderId: funderId.value, amount: amount.value } };
    }

    case 'RequestRelease': {
      const requestedBy = parseActorId(field(payload, 'requestedBy'), 'requestedBy');
      if (!requestedBy.ok) return requestedBy;
      return { ok: true, value: { requestedBy: requestedBy.value } };
    }

    case 'ApproveRelease': {
      const approvedBy = parseActorId(field(payload, 'approvedBy'), 'approvedBy');
      if (!approvedBy.ok) return approvedBy;
      return { ok: true, value: { approvedBy: approvedBy.value } };
    }

    case 'RequestRefund': {
      const requestedBy = parseActorId(field(payload, 'requestedBy'), 'requestedBy');
      if (!requestedBy.ok) return requestedBy;
      return { ok: true, value: { requestedBy: requestedBy.value } };
    }

    case 'ApproveRefund': {
      const approvedBy = parseActorId(field(payload, 'approvedBy'), 'approvedBy');
      if (!approvedBy.ok) return approvedBy;
      return { ok: true, value: { approvedBy: approvedBy.value } };
    }

    case 'ForceRefund': {
      const requestedBy = parseActorId(field(payload, 'requestedBy'), 'requestedBy');
      if (!requestedBy.ok) return requestedBy;
      const currentTime = parseOptionalTimestamp(field(payload, 'currentTime'), 'currentTime');
      if (!currentTime.ok) return currentTime;
      if (currentTime.value === undefined) {
        return { ok: true, value: { requestedBy: requestedBy.value, currentTime: makeTimestamp(0) } };
      }
      return { ok: true, value: { requestedBy: requestedBy.value, currentTime: currentTime.value } };
    }

    case 'ExpireCell': {
      const triggeredBy = parseActorId(field(payload, 'triggeredBy'), 'triggeredBy');
      if (!triggeredBy.ok) return triggeredBy;
      const currentTime = parseOptionalTimestamp(field(payload, 'currentTime'), 'currentTime');
      if (!currentTime.ok) return currentTime;
      if (currentTime.value === undefined) {
        return { ok: true, value: { triggeredBy: triggeredBy.value, currentTime: makeTimestamp(0) } };
      }
      return { ok: true, value: { triggeredBy: triggeredBy.value, currentTime: currentTime.value } };
    }

    case 'OpenDispute': {
      const openedBy = parseActorId(field(payload, 'openedBy'), 'openedBy');
      if (!openedBy.ok) return openedBy;
      const currentTime = parseOptionalTimestamp(field(payload, 'currentTime'), 'currentTime');
      if (!currentTime.ok) return currentTime;
      if (currentTime.value === undefined) {
        return { ok: true, value: { openedBy: openedBy.value, currentTime: makeTimestamp(0) } };
      }
      return { ok: true, value: { openedBy: openedBy.value, currentTime: currentTime.value } };
    }

    case 'ResolveDispute': {
      const resolvedBy = parseActorId(field(payload, 'resolvedBy'), 'resolvedBy');
      if (!resolvedBy.ok) return resolvedBy;
      const favourOf = field(payload, 'favourOf');
      if (favourOf !== 'payer' && favourOf !== 'payee') {
        return failShape('favourOf must be payer or payee');
      }
      return { ok: true, value: { resolvedBy: resolvedBy.value, favourOf } };
    }
  }
}

function field(payload: object, name: string): unknown {
  return (payload as Record<string, unknown>)[name];
}

function failShape(message: string): { readonly ok: false; readonly error: ApplicationError } {
  return { ok: false, error: invalidInput(message) };
}

type Parse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApplicationError };

function parseCommandId(raw: unknown): Parse<CommandId> {
  if (typeof raw !== 'string') {
    return failShape('commandId must be a non-empty string');
  }
  try {
    return { ok: true, value: makeCommandId(raw) };
  } catch {
    return failShape('commandId is not a valid command id');
  }
}

function parseCellId(raw: unknown): Parse<CellId> {
  if (typeof raw !== 'string') {
    return failShape('cellId must be a non-empty string');
  }
  try {
    return { ok: true, value: makeCellId(raw) };
  } catch {
    return failShape('cellId is not a valid cell id');
  }
}

function parseActorId(raw: unknown, fieldName: string): Parse<ActorId> {
  if (typeof raw !== 'string') {
    return failShape(`${fieldName} must be a non-empty string`);
  }
  try {
    return { ok: true, value: makeActorId(raw) };
  } catch {
    return failShape(`${fieldName} is not a valid actor id`);
  }
}

function parseAmount(raw: unknown, fieldName: string): Parse<Amount> {
  if (typeof raw !== 'bigint') {
    return failShape(`${fieldName} must be a bigint`);
  }
  try {
    return { ok: true, value: makeAmount(raw) };
  } catch {
    return failShape(`${fieldName} is not a valid amount`);
  }
}

function parseCurrency(raw: unknown): Parse<'TRY'> {
  if (raw !== 'TRY') {
    return failShape('currency representation is not structurally valid');
  }
  return { ok: true, value: 'TRY' };
}

function parseTimestamp(raw: unknown, fieldName: string): Parse<Timestamp> {
  if (typeof raw !== 'number') {
    return failShape(`${fieldName} must be a timestamp`);
  }
  try {
    return { ok: true, value: makeTimestamp(raw) };
  } catch {
    return failShape(`${fieldName} is not a valid timestamp`);
  }
}

function parseOptionalTimestamp(
  raw: unknown,
  fieldName: string,
): Parse<Timestamp | undefined> {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  return parseTimestamp(raw, fieldName);
}
