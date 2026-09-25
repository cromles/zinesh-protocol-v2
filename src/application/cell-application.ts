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
import type { EventStore } from '../adapters/event-store';
import type { EventStoreError } from '../adapters/event-store';
import type { FundingReceiptStore } from '../adapters/funding-receipt-store';
import type { FundingDisputeStore } from '../adapters/funding-dispute-store';
import { createHash } from 'crypto';
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
  CELL_DESCRIPTION_MAX_LENGTH,
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
  actorMismatch,
  idempotencyConflict,
  invalidInput,
  mapEventStoreError,
  opaquePersistenceFailure,
  type ApplicationError,
} from './errors';
import type { TrustedHandleCommandRequest, HandleCommandResult } from './types';
import { isVerifiedFundingContext, isVerifiedPrincipal } from '../security/trusted-ingress';
import type { FundingReceipt, VerifiedFundingContext } from '../funding/types';
import type { FundingIntentDraft } from '../funding/funding-intent';
import { createFundingIntent } from '../funding/funding-intent';
import type { FundingRoute, FundingObservation, FundingReconciliationOutcome } from '../funding/funding-foundation';
import { FundingReconciliationService } from '../funding/funding-reconciliation-service';
import type { VerifiedPrincipal } from '../security/trusted-ingress';
import type { FundingIntentCreateResult } from '../adapters/funding-intent-store';

export interface ActorCellSummary {
  readonly cellId: CellId;
  readonly counterpartyId: ActorId;
  readonly description?: string;
  readonly amount: Amount;
  readonly currency: 'TRY';
  readonly status: CellState['status'];
  readonly acceptanceStatus: CellState['acceptanceStatus'];
  readonly fundingDeadline: Timestamp;
  readonly completionDeadline: Timestamp;
  readonly version: Version;
}

export interface ActorCellState {
  readonly state: CellState;
  readonly version: Version;
}

const RECOGNIZED_COMMAND_TYPES: ReadonlySet<DomainCommandType> = new Set([
  'CreateCell',
  'AcceptCell',
  'RejectCell',
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

const FINANCIAL_SETTLEMENT_COMMANDS: ReadonlySet<DomainCommandType> = new Set([
  'ApproveRelease', 'ApproveRefund', 'ForceRefund', 'ResolveDispute',
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

  async handleCommand(request: TrustedHandleCommandRequest): Promise<HandleCommandResult> {
    if (!isVerifiedPrincipal(request.principal)) {
      return applicationRejection({ type: 'ApplicationError', code: 'UNAUTHENTICATED', message: 'Verified principal required' });
    }
    if (!request.principal.enabled) {
      return applicationRejection({ type: 'ApplicationError', code: 'PRINCIPAL_DISABLED', message: 'Principal is disabled' });
    }

    const shaped = validateCommandShape(request.command);
    if (!shaped.ok) {
      return applicationRejection(shaped.error);
    }

    let command = shaped.command;

    const authorization = authorizePrincipal(request, command);
    if (authorization !== undefined) {
      return applicationRejection(authorization);
    }

    const now = this.clock.now();
    command = alignDeadlineCommandTime(command, now);

    const fingerprint = canonicalEncode({
      principalId: request.principal.principalId,
      principalType: request.principal.type,
      actorId: request.principal.actorId,
      funding: request.fundingContext,
      command,
    });

    let execution;
    try {
      execution = await this.persistence.commandExecutionStore.execute(
        command.commandId,
        fingerprint,
        async (eventStore, fundingReceiptStore, fundingDisputeStore) => ({
          encodedResult: canonicalEncode(await this.executeOnce(
            command, now, eventStore, fundingReceiptStore, fundingDisputeStore, request.fundingContext,
          )),
        }),
      );
    } catch (err) {
      return persistenceFailureResult(toPersistenceFailure(err));
    }

    if (execution.kind === 'CONFLICT') {
      return applicationRejection(idempotencyConflict());
    }

    const result = canonicalDecode(execution.encodedResult) as HandleCommandResult;
    if (execution.kind === 'EXECUTED' && result.outcome === 'SUCCESS') {
      try {
        await this.persistence.snapshotStore.save(command.cellId, {
          cellId: command.cellId,
          version: result.version,
          state: result.nextState,
        });
      } catch {
        // Snapshot remains a non-authoritative cache.
      }
    }
    return result;
  }

  private async executeOnce(
    command: Command,
    now: Timestamp,
    eventStore: EventStore,
    fundingReceiptStore: FundingReceiptStore,
    fundingDisputeStore: FundingDisputeStore,
    fundingContext?: VerifiedFundingContext,
  ): Promise<HandleCommandResult> {

    const cellId = command.cellId;

    let loaded: ReadonlyArray<Event>;
    try {
      loaded = await eventStore.getEvents(cellId);
    } catch (err) {
      return persistenceFailureResult(toPersistenceFailure(err));
    }

    const evolved = this.kernel.evolve(cellId, loaded);
    if (isKernelError(evolved)) {
      return { outcome: 'KERNEL_REJECTION', error: evolved };
    }

    const expectedNextVersion = expectedVersionFromStream(loaded);

    if (FINANCIAL_SETTLEMENT_COMMANDS.has(command.type)
      && await fundingDisputeStore.hasBlockingDispute(cellId)) {
      return applicationRejection({ type: 'ApplicationError', code: 'FUNDING_DISPUTE_BLOCKED',
        message: 'Financial settlement is blocked by a provider funding dispute' });
    }

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
      if (command.type === 'FundCell') {
        const fundedEvent = kernelResult.events.find((event) => event.type === 'CellFunded');
        if (fundedEvent === undefined || fundingContext === undefined) {
          return applicationRejection({ type: 'ApplicationError', code: 'FUNDING_EVIDENCE_INVALID', message: 'Verified funding evidence required' });
        }
        const claimed = await fundingReceiptStore.claim(
          createFundingReceipt(fundingContext, command, fundedEvent, now),
        );
        if (claimed.kind !== 'CLAIMED') {
          return applicationRejection({ type: 'ApplicationError', code: 'FUNDING_RECEIPT_CONFLICT', message: 'Funding receipt identity conflicts with an existing receipt' });
        }
      }
      let appendResult;
      try {
        appendResult = await eventStore.append(
          cellId,
          kernelResult.events,
        );
      } catch (err) {
        return persistenceFailureResult(toPersistenceFailure(err));
      }

      if (!appendResult.ok) {
        return persistenceFailureResult(mapEventStoreError(appendResult.error));
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

  async getCellState(cellId: CellId): Promise<CellState | null> {
    return (await this.loadCell(cellId))?.state ?? null;
  }

  async listCellsForActor(principal: VerifiedPrincipal): Promise<ReadonlyArray<ActorCellSummary> | null> {
    if (!isAuthorizedActorPrincipal(principal) || principal.actorId === undefined) return null;
    const events = await this.persistence.eventStore.getEventsForActor(principal.actorId);
    const streams = new Map<CellId, Event[]>();
    for (const event of events) {
      const stream = streams.get(event.cellId) ?? [];
      stream.push(event);
      streams.set(event.cellId, stream);
    }
    return [...streams.entries()].flatMap(([cellId, stream]): ActorCellSummary[] => {
      const entry = this.reconstructCell(cellId, stream);
      if (entry === null || (entry.state.payer !== principal.actorId && entry.state.payee !== principal.actorId)) return [];
      return [{ cellId: entry.state.cellId,
        counterpartyId: entry.state.payer === principal.actorId ? entry.state.payee : entry.state.payer,
        ...(entry.state.description === undefined ? {} : { description: entry.state.description }),
        amount: entry.state.amount, currency: entry.state.currency, status: entry.state.status,
        acceptanceStatus: entry.state.acceptanceStatus,
        fundingDeadline: entry.state.fundingDeadline, completionDeadline: entry.state.completionDeadline,
        version: entry.version }];
    });
  }

  async getCellStateForActor(principal: VerifiedPrincipal, cellId: CellId): Promise<ActorCellState | null> {
    if (!isAuthorizedActorPrincipal(principal) || principal.actorId === undefined) return null;
    const entry = await this.loadCell(cellId);
    if (entry === null || (entry.state.payer !== principal.actorId && entry.state.payee !== principal.actorId)) return null;
    return entry;
  }

  private async loadCell(cellId: CellId): Promise<ActorCellState | null> {
    const events = await this.persistence.eventStore.getEvents(cellId);
    return this.reconstructCell(cellId, events);
  }

  private reconstructCell(cellId: CellId, events: ReadonlyArray<Event>): ActorCellState | null {
    if (events.length === 0) return null;
    const state = this.kernel.evolve(cellId, events);
    if (isKernelError(state)) throw new Error('Invalid authoritative cell stream');
    return { state, version: events[events.length - 1]!.version };
  }

  async createFundingIntent(principal: VerifiedPrincipal, draft: Omit<FundingIntentDraft,
    'payer' | 'payee' | 'amount' | 'currency' | 'createdAt'>): Promise<FundingIntentCreateResult> {
    if (!isVerifiedPrincipal(principal) || !principal.enabled || principal.type !== 'GATEWAY'
      || !principal.capabilities.includes('CONFIRM_FUNDING')) return { kind: 'INVALID' };
    const state = await this.getCellState(draft.cellId);
    if (state === null || state.status !== 'CREATED') return { kind: 'INVALID' };
    const createdAt = this.clock.now();
    if (draft.expiresAt <= createdAt || draft.expiresAt > state.fundingDeadline) return { kind: 'INVALID' };
    let intent;
    try {
      intent = createFundingIntent({ ...draft, createdAt, payer: state.payer, payee: state.payee,
        amount: state.amount, currency: state.currency });
    } catch { return { kind: 'INVALID' }; }
    return this.persistence.fundingIntentStore.create(intent);
  }

  async createFundingRoute(principal: VerifiedPrincipal, route: FundingRoute): Promise<'CREATED' | 'DUPLICATE' | 'CONFLICT'> {
    if (!isVerifiedPrincipal(principal) || !principal.enabled || principal.type !== 'GATEWAY'
      || !principal.capabilities.includes('CONFIRM_FUNDING')) return 'CONFLICT';
    return new FundingReconciliationService(this.persistence.providerFoundationStore,
      this.persistence.fundingIntentStore).createRoute(route);
  }

  async reconcileFundingObservation(principal: VerifiedPrincipal,
    observation: FundingObservation): Promise<FundingReconciliationOutcome | null> {
    if (!isVerifiedPrincipal(principal) || !principal.enabled || principal.type !== 'GATEWAY'
      || !principal.capabilities.includes('CONFIRM_FUNDING')) return null;
    return new FundingReconciliationService(this.persistence.providerFoundationStore,
      this.persistence.fundingIntentStore).reconcileObservation(observation);
  }

  async getFundingReceipt(principal: VerifiedPrincipal, cellId: CellId): Promise<FundingReceipt | null> {
    if (!isVerifiedPrincipal(principal) || !principal.enabled) return null;
    const state = await this.getCellState(cellId);
    const authorized = principal.type === 'ACTOR'
      ? principal.actorId === state?.payer || principal.actorId === state?.payee
      : principal.type === 'GATEWAY' && principal.capabilities.includes('CONFIRM_FUNDING');
    if (state === null || !authorized) return null;
    return this.persistence.fundingReceiptStore.getByCellId(cellId);
  }

  getFundingIntent(intentId: string) {
    return this.persistence.fundingIntentStore.get(intentId);
  }
}

function createFundingReceipt(
  context: VerifiedFundingContext, command: Command, event: Event, now: Timestamp,
): FundingReceipt {
  const identityHash = createHash('sha256');
  for (const part of [context.provider, context.environment, context.providerAccountScope, context.providerTransactionId]) {
    const encoded = Buffer.from(part, 'utf8');
    const length = Buffer.allocUnsafe(4); length.writeUInt32BE(encoded.length);
    identityHash.update(length); identityHash.update(encoded);
  }
  const receiptId = `funding-${identityHash.digest('hex')}`;
  return {
    receiptId, intentId: context.intentId, provider: context.provider,
    environment: context.environment, providerAccountScope: context.providerAccountScope,
    providerTransactionId: context.providerTransactionId,
    cellId: command.cellId, commandId: command.commandId, fundingEventId: event.eventId,
    gatewayPrincipalId: context.gatewayPrincipalId, payer: context.payer, payee: context.payee,
    amount: context.amount,
    currency: context.currency, destinationId: context.destinationId, confirmedAt: context.confirmedAt,
    finality: context.finality, evidenceDigest: context.evidenceDigest, verifiedAt: context.verifiedAt,
    createdAt: now,
  };
}

function callerMatchesCommand(actorId: ActorId, command: Command): boolean {
  const payload = command.payload as unknown as Record<string, unknown>;
  const actorField: Record<DomainCommandType, string> = {
    CreateCell: 'payer',
    AcceptCell: 'acceptedBy',
    RejectCell: 'rejectedBy',
    FundCell: 'funderId',
    RequestRelease: 'requestedBy',
    ApproveRelease: 'approvedBy',
    RequestRefund: 'requestedBy',
    ApproveRefund: 'approvedBy',
    ForceRefund: 'requestedBy',
    ExpireCell: 'triggeredBy',
    OpenDispute: 'openedBy',
    ResolveDispute: 'resolvedBy',
  };
  return payload[actorField[command.type]] === actorId;
}

function isAuthorizedActorPrincipal(principal: VerifiedPrincipal): boolean {
  return isVerifiedPrincipal(principal) && principal.enabled && principal.type === 'ACTOR'
    && principal.actorId !== undefined && principal.capabilities.includes('ACT_AS_SELF');
}

function authorizePrincipal(
  request: TrustedHandleCommandRequest,
  command: Command,
): ApplicationError | undefined {
  const principal = request.principal;
  if (principal.type === 'ACTOR') {
    if (command.type === 'FundCell' || !principal.capabilities.includes('ACT_AS_SELF')) {
      return { type: 'ApplicationError', code: 'COMMAND_NOT_PERMITTED', message: 'Principal cannot send this command' };
    }
    if (principal.actorId === undefined || !callerMatchesCommand(principal.actorId, command)) {
      return actorMismatch();
    }
    return undefined;
  }

  if (principal.type === 'GATEWAY') {
    if (command.type !== 'FundCell' || !principal.capabilities.includes('CONFIRM_FUNDING')) {
      return { type: 'ApplicationError', code: 'COMMAND_NOT_PERMITTED', message: 'Principal cannot send this command' };
    }
    const context = request.fundingContext;
    if (!isVerifiedFundingContext(context)) {
      return { type: 'ApplicationError', code: 'FUNDING_EVIDENCE_INVALID', message: 'Verified funding evidence required' };
    }
    const payload = command.payload as { funderId: ActorId; amount: Amount };
    if (
      context.gatewayPrincipalId !== principal.principalId ||
      context.cellId !== command.cellId || context.payer !== payload.funderId ||
      context.amount !== payload.amount || context.currency !== 'TRY'
    ) {
      return { type: 'ApplicationError', code: 'FUNDING_EVIDENCE_INVALID', message: 'Funding evidence does not match command' };
    }
    return undefined;
  }

  return { type: 'ApplicationError', code: 'COMMAND_NOT_PERMITTED', message: 'Principal cannot send actor commands' };
}

function canonicalEncode(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (typeof input === 'bigint') return { __zinesh_bigint__: input.toString() };
    if (Array.isArray(input)) return input.map(normalize);
    if (typeof input === 'object' && input !== null) {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function canonicalDecode(encoded: string): unknown {
  return JSON.parse(encoded, (_key, value: unknown) => {
    if (
      typeof value === 'object' && value !== null &&
      Object.keys(value).length === 1 && '__zinesh_bigint__' in value
    ) {
      return BigInt((value as { __zinesh_bigint__: string }).__zinesh_bigint__);
    }
    return value;
  });
}

function applicationRejection(error: ApplicationError): HandleCommandResult {
  return { outcome: 'APPLICATION_REJECTION', error };
}

function persistenceFailureResult(error: ApplicationError): HandleCommandResult {
  return { outcome: 'PERSISTENCE_FAILURE', error };
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
    case 'AcceptCell': {
      const acceptedBy = parseActorId(field(payload, 'acceptedBy'), 'acceptedBy');
      if (!acceptedBy.ok) return acceptedBy;
      return { ok: true, value: { acceptedBy: acceptedBy.value } };
    }

    case 'RejectCell': {
      const rejectedBy = parseActorId(field(payload, 'rejectedBy'), 'rejectedBy');
      if (!rejectedBy.ok) return rejectedBy;
      return { ok: true, value: { rejectedBy: rejectedBy.value } };
    }

    case 'CreateCell': {
      const payer = parseActorId(field(payload, 'payer'), 'payer');
      if (!payer.ok) return payer;
      const payee = parseActorId(field(payload, 'payee'), 'payee');
      if (!payee.ok) return payee;
      const description = parseCellDescription(field(payload, 'description'));
      if (!description.ok) return description;
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
            description: description.value,
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
          description: description.value,
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

function parseCellDescription(raw: unknown): Parse<string> {
  if (typeof raw !== 'string' || raw.trim().length === 0
    || raw.length > CELL_DESCRIPTION_MAX_LENGTH
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(raw)) {
    return failShape('description must be non-empty plain text within the supported length');
  }
  return { ok: true, value: raw };
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
