/**
 * ZINESH PROTOCOL V2 — Application request/result types
 *
 * Transport-neutral. No HTTP, no Express/Fastify, no PostgreSQL types.
 */

import type { ApplicationError } from './errors';
import type { ActorId, CellState, Command, Event, KernelError, Version } from '../core/types';

export interface CallerIdentity {
  readonly authenticated: boolean;
  readonly actorId: ActorId;
}

/**
 * Infrastructure-level gateway check. Kernel still verifies funderId === payer.
 * Do not add gatewayId / providerType / issuedBy to Kernel types.
 */
export interface GatewayAuthorization {
  readonly authorizedGateway: boolean;
}

export interface HandleCommandRequest {
  readonly command: Command;
  readonly caller: CallerIdentity;
  readonly gateway?: GatewayAuthorization;
}

export type HandleCommandSuccess = {
  readonly outcome: 'SUCCESS';
  readonly events: ReadonlyArray<Event>;
  readonly nextState: CellState;
  readonly version: Version;
};

export type HandleCommandKernelRejection = {
  readonly outcome: 'KERNEL_REJECTION';
  readonly error: KernelError;
};

export type HandleCommandApplicationRejection = {
  readonly outcome: 'APPLICATION_REJECTION';
  readonly error: ApplicationError;
};

export type HandleCommandPersistenceFailure = {
  readonly outcome: 'PERSISTENCE_FAILURE';
  readonly error: ApplicationError;
};

export type HandleCommandResult =
  | HandleCommandSuccess
  | HandleCommandKernelRejection
  | HandleCommandApplicationRejection
  | HandleCommandPersistenceFailure;
