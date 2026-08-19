import type { ActorId, Amount, CellId, Command, Currency } from '../core/types';
import type { CellApplication } from '../application/cell-application';
import type { HandleCommandResult, TrustedHandleCommandRequest } from '../application/types';
import { rateLimitRejection, rateLimitUnavailable, securityRejection } from '../application/errors';
import { allowAllRateLimiter } from './rate-limiter';
import type { RateLimiter } from './rate-limiter';
import { noOpSecurityTelemetry, serverCorrelationId } from './security-observability';
import type { SecurityTelemetry } from './security-observability';

export type PrincipalType = 'ACTOR' | 'GATEWAY' | 'SYSTEM';
export type Capability = 'ACT_AS_SELF' | 'CONFIRM_FUNDING';

export interface PrincipalRecord {
  readonly principalId: string;
  readonly type: PrincipalType;
  readonly enabled: boolean;
  readonly actorId?: ActorId;
  readonly capabilities: ReadonlyArray<Capability>;
  readonly mappingVersion: number;
}

export interface VerifiedPrincipal extends PrincipalRecord {}

export interface AuthenticationPort {
  authenticate(credential: unknown): Promise<
    { readonly ok: true; readonly identity: ExternalIdentity } |
    { readonly ok: false; readonly reason?: AuthenticationFailureReason }
  >;
}

export type AuthenticationFailureReason =
  | 'MALFORMED_CREDENTIAL'
  | 'INVALID_SIGNATURE'
  | 'INVALID_ISSUER'
  | 'INVALID_AUDIENCE'
  | 'UNSUPPORTED_ALGORITHM'
  | 'EXPIRED_CREDENTIAL'
  | 'CREDENTIAL_NOT_ACTIVE'
  | 'UNKNOWN_KEY'
  | 'AUTHENTICATION_DEPENDENCY_FAILURE';

export interface ExternalIdentity {
  readonly issuer: string;
  readonly subject: string;
}

export interface PrincipalAuthority {
  resolve(identity: ExternalIdentity): Promise<PrincipalRecord | null>;
}

export interface VerifiedFundingContext {
  readonly providerTransactionId: string;
  readonly gatewayPrincipalId: string;
  readonly cellId: CellId;
  readonly payer: ActorId;
  readonly amount: Amount;
  readonly currency: Currency;
}

export interface FundingEvidencePort {
  verify(evidence: unknown): Promise<VerifiedFundingContext | null>;
}

export interface ExternalCommandRequest {
  readonly credential: unknown;
  readonly command: Command;
  readonly fundingEvidence?: unknown;
  readonly correlationId?: string;
}

const verifiedPrincipals = new WeakSet<object>();
const verifiedFundingContexts = new WeakSet<object>();

function verifyPrincipal(record: PrincipalRecord): VerifiedPrincipal {
  const principal = Object.freeze({ ...record, capabilities: Object.freeze([...record.capabilities]) });
  verifiedPrincipals.add(principal);
  return principal;
}

function verifyFundingContext(context: VerifiedFundingContext): VerifiedFundingContext {
  const verified = Object.freeze({ ...context });
  verifiedFundingContexts.add(verified);
  return verified;
}

export function isVerifiedPrincipal(value: unknown): value is VerifiedPrincipal {
  return typeof value === 'object' && value !== null && verifiedPrincipals.has(value);
}

export function isVerifiedFundingContext(value: unknown): value is VerifiedFundingContext {
  return typeof value === 'object' && value !== null && verifiedFundingContexts.has(value);
}

export class TrustedCommandIngress {
  constructor(
    private readonly application: CellApplication,
    private readonly authentication: AuthenticationPort,
    private readonly principals: PrincipalAuthority,
    private readonly fundingEvidence: FundingEvidencePort,
    private readonly principalRateLimiter: RateLimiter = allowAllRateLimiter,
    private readonly telemetry: SecurityTelemetry = noOpSecurityTelemetry,
  ) {}

  async handle(request: ExternalCommandRequest): Promise<HandleCommandResult> {
    const requestedCorrelationId = serverCorrelationId(request.correlationId);
    const correlationId = requestedCorrelationId === String(request.command.commandId)
      ? serverCorrelationId() : requestedCorrelationId;
    const commandContext = {
      correlationId, commandId: String(request.command.commandId), commandType: request.command.type,
    } as const;
    const authenticationStarted = Date.now();
    let authenticated: Awaited<ReturnType<AuthenticationPort['authenticate']>>;
    try {
      authenticated = await this.authentication.authenticate(request.credential);
    } catch {
      this.telemetry.record({
        category: 'AUTHENTICATION', action: 'VERIFY', outcome: 'DEPENDENCY_FAILURE',
        reason: 'AUTHENTICATION_DEPENDENCY_FAILURE', durationMs: elapsed(authenticationStarted), ...commandContext,
      });
      return securityRejection('UNAUTHENTICATED');
    }
    if (!authenticated.ok) {
      this.telemetry.record({
        category: 'AUTHENTICATION', action: 'VERIFY',
        outcome: authenticated.reason === 'AUTHENTICATION_DEPENDENCY_FAILURE' ? 'DEPENDENCY_FAILURE' : 'REJECTED',
        reason: authenticated.reason ?? 'MALFORMED_CREDENTIAL', durationMs: elapsed(authenticationStarted),
        ...commandContext,
      });
      return securityRejection('UNAUTHENTICATED');
    }
    this.telemetry.record({
      category: 'AUTHENTICATION', action: 'VERIFY', outcome: 'SUCCESS',
      durationMs: elapsed(authenticationStarted), ...commandContext,
    });

    const principalStarted = Date.now();
    let record: PrincipalRecord | null;
    try {
      record = await this.principals.resolve(authenticated.identity);
    } catch {
      this.telemetry.record({
        category: 'PRINCIPAL', action: 'RESOLVE', outcome: 'DEPENDENCY_FAILURE',
        reason: 'PRINCIPAL_AUTHORITY_FAILURE', durationMs: elapsed(principalStarted), ...commandContext,
      });
      this.telemetry.record({
        category: 'PERSISTENCE', action: 'PRINCIPAL_QUERY', outcome: 'DEPENDENCY_FAILURE',
        reason: 'POSTGRES_FAILURE', ...commandContext,
      });
      throw new Error('Principal authority unavailable');
    }
    if (record === null) {
      this.telemetry.record({
        category: 'PRINCIPAL', action: 'RESOLVE', outcome: 'REJECTED', reason: 'PRINCIPAL_NOT_MAPPED',
        durationMs: elapsed(principalStarted), ...commandContext,
      });
      return securityRejection('PRINCIPAL_NOT_MAPPED');
    }
    const principalContext = { ...commandContext, principalId: record.principalId } as const;
    if (!record.enabled) {
      this.telemetry.record({
        category: 'PRINCIPAL', action: 'RESOLVE', outcome: 'REJECTED', reason: 'PRINCIPAL_DISABLED',
        durationMs: elapsed(principalStarted), ...principalContext,
      });
      return securityRejection('PRINCIPAL_DISABLED');
    }
    if (record.type === 'ACTOR' && record.actorId === undefined) {
      this.telemetry.record({
        category: 'PRINCIPAL', action: 'RESOLVE', outcome: 'REJECTED', reason: 'PRINCIPAL_NOT_MAPPED',
        durationMs: elapsed(principalStarted), ...principalContext,
      });
      return securityRejection('PRINCIPAL_NOT_MAPPED');
    }
    this.telemetry.record({
      category: 'PRINCIPAL', action: 'RESOLVE', outcome: 'SUCCESS',
      durationMs: elapsed(principalStarted), ...principalContext,
    });

    const limiterStarted = Date.now();
    try {
      const decision = await this.principalRateLimiter.consume(record.principalId);
      this.telemetry.record({
        category: 'RATE_LIMIT', action: 'POST_AUTH', outcome: decision.allowed ? 'ALLOWED' : 'REJECTED',
        durationMs: elapsed(limiterStarted), ...principalContext,
      });
      if (!decision.allowed) return rateLimitRejection(decision.retryAfterSeconds);
    } catch {
      this.telemetry.record({
        category: 'RATE_LIMIT', action: 'POST_AUTH', outcome: 'DEPENDENCY_FAILURE',
        reason: 'FAIL_CLOSED', durationMs: elapsed(limiterStarted), ...principalContext,
      });
      return rateLimitUnavailable();
    }

    const principal = verifyPrincipal(record);
    let fundingContext: VerifiedFundingContext | undefined;
    if (request.command.type === 'FundCell') {
      if (principal.type !== 'GATEWAY' || !principal.capabilities.includes('CONFIRM_FUNDING')) {
        this.telemetry.record({
          category: 'AUTHORIZATION', action: 'COMMAND', outcome: 'REJECTED',
          reason: principal.type === 'GATEWAY' ? 'GATEWAY_AUTHORIZATION_FAILURE' : 'COMMAND_NOT_PERMITTED',
          ...principalContext,
        });
        return securityRejection('COMMAND_NOT_PERMITTED');
      }
      const evidence = await this.fundingEvidence.verify(request.fundingEvidence);
      if (evidence === null) {
        this.telemetry.record({
          category: 'AUTHORIZATION', action: 'COMMAND', outcome: 'REJECTED',
          reason: 'FUNDING_EVIDENCE_INVALID', ...principalContext,
        });
        return securityRejection('FUNDING_EVIDENCE_INVALID');
      }
      fundingContext = verifyFundingContext(evidence);
    }

    this.telemetry.record({
      category: 'AUTHORIZATION', action: 'COMMAND', outcome: 'ALLOWED', ...principalContext,
    });

    const trusted: TrustedHandleCommandRequest = fundingContext === undefined
      ? { command: request.command, principal }
      : { command: request.command, principal, fundingContext };
    const commandStarted = Date.now();
    const result = await this.application.handleCommand(trusted);
    this.recordCommandResult(result, commandStarted, principalContext);
    return result;
  }

  private recordCommandResult(
    result: HandleCommandResult,
    started: number,
    context: { readonly correlationId: string; readonly commandId: string;
      readonly commandType: Command['type']; readonly principalId: string },
  ): void {
    if (result.outcome === 'SUCCESS') {
      this.telemetry.record({
        category: 'INGRESS', action: 'COMMAND', outcome: 'SUCCESS', durationMs: elapsed(started), ...context,
      });
      return;
    }
    const reason = result.error.code;
    if (reason === 'IDEMPOTENCY_CONFLICT') {
      this.telemetry.record({ category: 'PERSISTENCE', action: 'IDEMPOTENCY', outcome: 'REJECTED', reason, ...context });
    } else if (result.outcome === 'PERSISTENCE_FAILURE') {
      this.telemetry.record({
        category: 'PERSISTENCE', action: 'TRANSACTION', outcome: 'DEPENDENCY_FAILURE',
        reason: 'POSTGRES_FAILURE', ...context,
      });
    }
    if (reason === 'ACTOR_MISMATCH' || reason === 'GATEWAY_DENIED' || reason === 'AUTHORIZATION_DENIED'
      || reason === 'COMMAND_NOT_PERMITTED' || reason === 'FUNDING_EVIDENCE_INVALID') {
      this.telemetry.record({
        category: 'AUTHORIZATION', action: 'COMMAND', outcome: 'REJECTED', reason, ...context,
      });
    }
    this.telemetry.record({
      category: 'INGRESS', action: 'COMMAND', outcome: 'FAILURE', reason,
      durationMs: elapsed(started), ...context,
    });
  }
}

/** Production-safe defaults: without a real provider the boundary is closed. */
export const failClosedAuthentication: AuthenticationPort = {
  async authenticate() { return { ok: false }; },
};

export const emptyPrincipalAuthority: PrincipalAuthority = {
  async resolve() { return null; },
};

export const rejectAllFundingEvidence: FundingEvidencePort = {
  async verify() { return null; },
};

function elapsed(started: number): number { return Math.max(0, Date.now() - started); }
