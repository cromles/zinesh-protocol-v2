/**
 * ZINESH PROTOCOL V2 — Application errors
 *
 * Distinct from KernelError. These cover input shape, authentication,
 * gateway authorization at the application boundary, and persistence
 * infrastructure failures.
 *
 * Domain rejections (illegal transitions, deadlines, settlement, money)
 * remain KernelError and are never rewritten here.
 */

import type { EventStoreError } from '../adapters/event-store';

export type ApplicationErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHENTICATED'
  | 'GATEWAY_DENIED'
  | 'PERSISTENCE_FAILURE';

export interface ApplicationError {
  readonly type: 'ApplicationError';
  readonly code: ApplicationErrorCode;
  readonly message: string;
  /**
   * EventStore failure kind, when the rejection came from append/getEvents.
   * Opaque: never SQL, never driver internals.
   */
  readonly persistenceKind?: EventStoreError['kind'];
}

export function invalidInput(message: string): ApplicationError {
  return {
    type: 'ApplicationError',
    code: 'INVALID_INPUT',
    message,
  };
}

export function unauthenticated(message = 'Caller is not authenticated'): ApplicationError {
  return {
    type: 'ApplicationError',
    code: 'UNAUTHENTICATED',
    message,
  };
}

export function gatewayDenied(
  message = 'Caller is not an authorized payment gateway',
): ApplicationError {
  return {
    type: 'ApplicationError',
    code: 'GATEWAY_DENIED',
    message,
  };
}

export function persistenceFailure(
  message: string,
  persistenceKind?: EventStoreError['kind'],
): ApplicationError {
  const error: ApplicationError = {
    type: 'ApplicationError',
    code: 'PERSISTENCE_FAILURE',
    message,
  };
  if (persistenceKind !== undefined) {
    return { ...error, persistenceKind };
  }
  return error;
}

export function mapEventStoreError(error: EventStoreError): ApplicationError {
  if (error.kind === 'APPEND_VERSION_CONFLICT') {
    return persistenceFailure('Event stream version conflict', error.kind);
  }
  return persistenceFailure('Event stream integrity error', error.kind);
}

export function opaquePersistenceFailure(): ApplicationError {
  return persistenceFailure('Persistence operation failed');
}
