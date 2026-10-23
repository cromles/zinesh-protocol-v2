import type { AdmissionQuarantineStore, QuarantineReason } from './admission-quarantine';
import { MAX_QUARANTINE_TTL_MS } from './admission-quarantine';
import type { AuthenticationPort, PrincipalAuthority, PrincipalRecord } from './trusted-ingress';
import { noOpSecurityTelemetry, serverCorrelationId } from './security-observability';
import type { SecurityTelemetry } from './security-observability';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface IssueAdmissionQuarantineRequest {
  readonly credential: unknown;
  readonly quarantineId: string;
  readonly principalId: string;
  readonly reason: QuarantineReason;
  readonly expiresAt: number;
  readonly correlationId: string;
}

export interface ReleaseAdmissionQuarantineRequest {
  readonly credential: unknown;
  readonly quarantineId: string;
  readonly correlationId: string;
}

export type AdmissionQuarantineLifecycleResult =
  | { readonly outcome: 'ISSUED' | 'RELEASED' | 'DUPLICATE' }
  | { readonly outcome: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID' | 'CONFLICT' | 'NOT_FOUND' | 'UNAVAILABLE' };

/**
 * Authentication and least-privilege boundary for quarantine writes. This service is intentionally
 * not exposed by the public command transport and cannot mutate escrow state.
 */
export class TrustedAdmissionQuarantineLifecycle {
  constructor(
    private readonly authentication: AuthenticationPort,
    private readonly principals: PrincipalAuthority,
    private readonly store: AdmissionQuarantineStore,
    private readonly telemetry: SecurityTelemetry = noOpSecurityTelemetry,
    private readonly now: () => number = Date.now,
  ) {}

  async issue(request: IssueAdmissionQuarantineRequest): Promise<AdmissionQuarantineLifecycleResult> {
    const eventCorrelationId = serverCorrelationId(request.correlationId);
    const operator = await this.authorize(request.credential, eventCorrelationId, 'QUARANTINE_ISSUE');
    if (!('principalId' in operator)) return operator;
    if (!safeId(request.quarantineId) || !safeId(request.principalId)
      || !safeId(request.correlationId) || !timestamp(request.expiresAt)) {
      return this.result('QUARANTINE_ISSUE', 'INVALID', eventCorrelationId, operator.principalId);
    }
    const issuedAt = this.now();
    if (!timestamp(issuedAt) || request.expiresAt <= issuedAt
      || request.expiresAt - issuedAt > MAX_QUARANTINE_TTL_MS) {
      return this.result('QUARANTINE_ISSUE', 'INVALID', eventCorrelationId, operator.principalId);
    }
    try {
      const outcome = await this.store.issue({
        quarantineId: request.quarantineId,
        principalId: request.principalId,
        reason: request.reason,
        issuedAt,
        expiresAt: request.expiresAt,
        issuedBy: operator.principalId,
        correlationId: request.correlationId,
      });
      return this.result('QUARANTINE_ISSUE', outcome, eventCorrelationId, operator.principalId);
    } catch {
      return this.unavailable('QUARANTINE_ISSUE', eventCorrelationId, 'QUARANTINE_STORE_FAILURE', operator.principalId);
    }
  }

  async release(request: ReleaseAdmissionQuarantineRequest): Promise<AdmissionQuarantineLifecycleResult> {
    const eventCorrelationId = serverCorrelationId(request.correlationId);
    const operator = await this.authorize(request.credential, eventCorrelationId, 'QUARANTINE_RELEASE');
    if (!('principalId' in operator)) return operator;
    if (!safeId(request.quarantineId) || !safeId(request.correlationId)) {
      return this.result('QUARANTINE_RELEASE', 'INVALID', eventCorrelationId, operator.principalId);
    }
    const releasedAt = this.now();
    if (!timestamp(releasedAt)) {
      return this.result('QUARANTINE_RELEASE', 'INVALID', eventCorrelationId, operator.principalId);
    }
    try {
      const outcome = await this.store.release({
        quarantineId: request.quarantineId,
        releasedAt,
        releasedBy: operator.principalId,
        correlationId: request.correlationId,
      });
      return this.result('QUARANTINE_RELEASE', outcome, eventCorrelationId, operator.principalId);
    } catch {
      return this.unavailable('QUARANTINE_RELEASE', eventCorrelationId, 'QUARANTINE_STORE_FAILURE', operator.principalId);
    }
  }

  private async authorize(
    credential: unknown, correlationId: string, action: 'QUARANTINE_ISSUE' | 'QUARANTINE_RELEASE',
  ): Promise<PrincipalRecord | AdmissionQuarantineLifecycleResult> {
    let authenticated: Awaited<ReturnType<AuthenticationPort['authenticate']>>;
    try { authenticated = await this.authentication.authenticate(credential); }
    catch { return this.unavailable(action, correlationId, 'AUTHENTICATION_DEPENDENCY_FAILURE'); }
    if (!authenticated.ok) {
      if (authenticated.reason === 'AUTHENTICATION_DEPENDENCY_FAILURE') {
        return this.unavailable(action, correlationId, 'AUTHENTICATION_DEPENDENCY_FAILURE');
      }
      this.telemetry.record({
        category: 'ADMISSION', action, outcome: 'REJECTED', reason: 'OPERATOR_UNAUTHENTICATED', correlationId,
      });
      return { outcome: 'UNAUTHENTICATED' };
    }
    let principal: PrincipalRecord | null;
    try { principal = await this.principals.resolve(authenticated.identity); }
    catch { return this.unavailable(action, correlationId, 'PRINCIPAL_AUTHORITY_FAILURE'); }
    if (principal === null || !principal.enabled || principal.type !== 'SYSTEM'
      || !principal.capabilities.includes('MANAGE_ADMISSION_QUARANTINE')) {
      this.telemetry.record({
        category: 'ADMISSION', action, outcome: 'REJECTED', reason: 'OPERATOR_FORBIDDEN', correlationId,
        ...(principal === null ? {} : { principalId: principal.principalId }),
      });
      return { outcome: 'FORBIDDEN' };
    }
    return principal;
  }

  private result(
    action: 'QUARANTINE_ISSUE' | 'QUARANTINE_RELEASE',
    outcome: 'ISSUED' | 'RELEASED' | 'DUPLICATE' | 'CONFLICT' | 'NOT_FOUND' | 'INVALID',
    correlationId: string,
    principalId?: string,
  ): AdmissionQuarantineLifecycleResult {
    this.telemetry.record({
      category: 'ADMISSION', action,
      outcome: outcome === 'ISSUED' || outcome === 'RELEASED' || outcome === 'DUPLICATE' ? 'SUCCESS' : 'REJECTED',
      reason: outcome, correlationId,
      ...(principalId === undefined ? {} : { principalId }),
    });
    return { outcome };
  }

  private unavailable(
    action: 'QUARANTINE_ISSUE' | 'QUARANTINE_RELEASE', correlationId: string,
    reason: 'AUTHENTICATION_DEPENDENCY_FAILURE' | 'PRINCIPAL_AUTHORITY_FAILURE' | 'QUARANTINE_STORE_FAILURE',
    principalId?: string,
  ): AdmissionQuarantineLifecycleResult {
    this.telemetry.record({
      category: 'ADMISSION', action, outcome: 'DEPENDENCY_FAILURE', reason,
      correlationId, ...(principalId === undefined ? {} : { principalId }),
    });
    return { outcome: 'UNAVAILABLE' };
  }
}

function safeId(value: string): boolean { return SAFE_ID.test(value); }
function timestamp(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
