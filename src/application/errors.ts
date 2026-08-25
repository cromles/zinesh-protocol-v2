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
  | 'ACTOR_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PRINCIPAL_NOT_MAPPED'
  | 'PRINCIPAL_DISABLED'
  | 'COMMAND_NOT_PERMITTED'
  | 'FUNDING_EVIDENCE_INVALID'
  | 'FUNDING_RECEIPT_CONFLICT'
  | 'RATE_LIMITED'
  | 'RATE_LIMIT_UNAVAILABLE'
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
  readonly retryAfterSeconds?: number;
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

export function actorMismatch(): ApplicationError {
  return { type: 'ApplicationError', code: 'ACTOR_MISMATCH', message: 'Command actor does not match authenticated caller' };
}

export function idempotencyConflict(): ApplicationError {
  return { type: 'ApplicationError', code: 'IDEMPOTENCY_CONFLICT', message: 'commandId was already used for a different command' };
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

export function securityRejection(code: Extract<ApplicationErrorCode,
  'UNAUTHENTICATED' | 'PRINCIPAL_NOT_MAPPED' | 'PRINCIPAL_DISABLED' |
  'COMMAND_NOT_PERMITTED' | 'FUNDING_EVIDENCE_INVALID'>): import('./types').HandleCommandResult {
  return { outcome: 'APPLICATION_REJECTION', error: { type: 'ApplicationError', code, message: 'Security policy rejected the command' } };
}

export function rateLimitRejection(retryAfterSeconds: number): import('./types').HandleCommandResult {
  return { outcome: 'APPLICATION_REJECTION', error: {
    type: 'ApplicationError', code: 'RATE_LIMITED', message: 'Request rate exceeded', retryAfterSeconds,
  } };
}

export function rateLimitUnavailable(): import('./types').HandleCommandResult {
  return { outcome: 'APPLICATION_REJECTION', error: {
    type: 'ApplicationError', code: 'RATE_LIMIT_UNAVAILABLE', message: 'Request cannot be admitted',
  } };
}
