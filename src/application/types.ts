/**
 * ZINESH PROTOCOL V2 — Application request/result types
 *
 * Transport-neutral. No HTTP, no Express/Fastify, no PostgreSQL types.
 */

import type { ApplicationError } from './errors';
import type { CellState, Command, Event, KernelError, Version } from '../core/types';
import type { VerifiedFundingContext, VerifiedPrincipal } from '../security/trusted-ingress';

export interface TrustedHandleCommandRequest {
  readonly command: Command;
  readonly principal: VerifiedPrincipal;
  readonly fundingContext?: VerifiedFundingContext;
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
