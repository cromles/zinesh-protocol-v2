import type { ActorId, CellId, Command, CommandId } from '../core/types';
import { makeActorId, makeAmount } from '../core/types';
import type { ExpectedFundingBinding, FundingDestinationBinding, FundingEvidence, FundingIntent, FundingVerificationResult, VerifiedFundingContext } from '../funding/types';
import { hasValidFundingIntentBinding } from '../funding/funding-intent';
export type { VerifiedFundingContext } from '../funding/types';
import type { CellApplication } from '../application/cell-application';
import type { HandleCommandResult, TrustedHandleCommandRequest } from '../application/types';
import { rateLimitRejection, rateLimitUnavailable, securityRejection } from '../application/errors';
import { allowAllRateLimiter } from './rate-limiter';
import type { RateLimiter } from './rate-limiter';
import { noOpSecurityTelemetry, serverCorrelationId } from './security-observability';
import type { SecurityTelemetry } from './security-observability';

export type PrincipalType = 'ACTOR' | 'GATEWAY' | 'SYSTEM';
export type Capability = 'ACT_AS_SELF' | 'CONFIRM_FUNDING' | 'RESOLVE_FUNDING_NEGATIVE';

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

export interface FundingEvidencePort {
  verify(evidence: FundingEvidence, expected: ExpectedFundingBinding): Promise<FundingVerificationResult>;
}

export interface FundingDestinationResolver {
  resolve(binding: FundingDestinationBinding): Promise<string | null>;
}

export interface ExternalCommandRequest {
  readonly credential: unknown;
  readonly command: Command;
  readonly fundingEvidence?: unknown;
  readonly correlationId?: string;
}

export interface FundingConfirmationRequest {
  readonly credential: unknown;
  readonly commandId: CommandId;
  readonly cellId: CellId;
  readonly evidence: FundingEvidence;
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
    private readonly fundingDestinations: FundingDestinationResolver = rejectAllFundingDestinations,
  ) {}

  async handleFundingConfirmation(request: FundingConfirmationRequest): Promise<HandleCommandResult> {
    const command: Command = {
      commandId: request.commandId, cellId: request.cellId, type: 'FundCell',
      payload: { funderId: makeActorId('server-derived-funding-payer'), amount: makeAmount(1n) },
    };
    return this.handle({
      credential: request.credential, command, fundingEvidence: request.evidence,
      ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
    });
  }

  async handle(
    request: ExternalCommandRequest,
    fundingBoundary?: { readonly state: Awaited<ReturnType<CellApplication['getCellState']>> & object; readonly destinationId: string },
  ): Promise<HandleCommandResult> {
    let command = request.command;
    const requestedCorrelationId = serverCorrelationId(request.correlationId);
    const correlationId = requestedCorrelationId === String(command.commandId)
      ? serverCorrelationId() : requestedCorrelationId;
    const commandContext = {
      correlationId, commandId: String(command.commandId), commandType: command.type,
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
    if (command.type === 'FundCell') {
      if (principal.type !== 'GATEWAY' || !principal.capabilities.includes('CONFIRM_FUNDING')) {
        this.telemetry.record({
          category: 'AUTHORIZATION', action: 'COMMAND', outcome: 'REJECTED',
          reason: principal.type === 'GATEWAY' ? 'GATEWAY_AUTHORIZATION_FAILURE' : 'COMMAND_NOT_PERMITTED',
          ...principalContext,
        });
        return securityRejection('COMMAND_NOT_PERMITTED');
      }
      if (!isFundingEvidence(request.fundingEvidence)) {
        return securityRejection('FUNDING_EVIDENCE_INVALID');
      }
      if (fundingBoundary === undefined) {
        let state;
        try { state = await this.application.getCellState(command.cellId); }
        catch { return fundingIngressRejection('FUNDING_DEPENDENCY_UNAVAILABLE'); }
        if (state === null) return fundingIngressRejection('CELL_NOT_FOUND');
        let destinationId: string | null;
        const destinationBinding: FundingDestinationBinding = {
          provider: request.fundingEvidence.provider, cellId: command.cellId,
          payer: state.payer, payee: state.payee, amount: state.amount, currency: state.currency,
        };
        try { destinationId = await this.fundingDestinations.resolve(destinationBinding); }
        catch { return fundingIngressRejection('FUNDING_DEPENDENCY_UNAVAILABLE'); }
        if (destinationId === null) return securityRejection('FUNDING_EVIDENCE_INVALID');
        fundingBoundary = { state, destinationId };
      }
      command = { commandId: command.commandId, cellId: command.cellId, type: 'FundCell',
        payload: { funderId: fundingBoundary.state.payer, amount: fundingBoundary.state.amount } };
      let intent: FundingIntent | null;
      try { intent = await this.application.getFundingIntent(request.fundingEvidence.intentId); }
      catch { return fundingIngressRejection('FUNDING_DEPENDENCY_UNAVAILABLE'); }
      if (intent === null || !matchesIntent(intent, request.fundingEvidence, fundingBoundary)) {
        return securityRejection('FUNDING_EVIDENCE_INVALID');
      }
      const expected: ExpectedFundingBinding = {
        intentId: intent.intentId,
        environment: intent.environment, providerAccountScope: intent.providerAccountScope,
        gatewayPrincipalId: principal.principalId, cellId: command.cellId,
        payer: fundingBoundary.state.payer, amount: fundingBoundary.state.amount,
        payee: fundingBoundary.state.payee, currency: fundingBoundary.state.currency,
        destinationId: fundingBoundary.destinationId,
      };
      let verification: FundingVerificationResult;
      try { verification = await this.fundingEvidence.verify(request.fundingEvidence, expected); }
      catch { return fundingIngressRejection('FUNDING_DEPENDENCY_UNAVAILABLE'); }
      if (verification.outcome !== 'VERIFIED') {
        this.telemetry.record({
          category: 'AUTHORIZATION', action: 'COMMAND', outcome: 'REJECTED',
          reason: 'FUNDING_EVIDENCE_INVALID', ...principalContext,
        });
        if (verification.outcome === 'NOT_FINAL') return fundingIngressRejection('FUNDING_NOT_FINAL');
        if (verification.outcome === 'DEPENDENCY_UNAVAILABLE') return fundingIngressRejection('FUNDING_DEPENDENCY_UNAVAILABLE');
        return securityRejection('FUNDING_EVIDENCE_INVALID');
      }
      if (!matchesExpectedBinding(verification.context, expected, request.fundingEvidence)) {
        return securityRejection('FUNDING_EVIDENCE_INVALID');
      }
      if (verification.context.confirmedAt < intent.createdAt
        || verification.context.confirmedAt > intent.expiresAt) {
        return securityRejection('FUNDING_EVIDENCE_INVALID');
      }
      fundingContext = verifyFundingContext(verification.context);
    }

    this.telemetry.record({
      category: 'AUTHORIZATION', action: 'COMMAND', outcome: 'ALLOWED', ...principalContext,
    });

    const trusted: TrustedHandleCommandRequest = fundingContext === undefined
      ? { command, principal }
      : { command, principal, fundingContext };
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
  async verify() { return { outcome: 'INVALID', reason: 'UNSUPPORTED_PAYMENT' }; },
};

export const rejectAllFundingDestinations: FundingDestinationResolver = {
  async resolve() { return null; },
};

function isFundingEvidence(value: unknown): value is FundingEvidence {
  return typeof value === 'object' && value !== null
    && typeof (value as FundingEvidence).provider === 'string'
    && typeof (value as FundingEvidence).providerTransactionId === 'string'
    && ((value as FundingEvidence).environment === undefined || (value as FundingEvidence).environment === 'LIVE' || (value as FundingEvidence).environment === 'SANDBOX')
    && ((value as FundingEvidence).providerAccountScope === undefined || typeof (value as FundingEvidence).providerAccountScope === 'string')
    && typeof (value as FundingEvidence).intentId === 'string';
}

function matchesExpectedBinding(
  context: VerifiedFundingContext, expected: ExpectedFundingBinding, evidence: FundingEvidence,
): boolean {
  return context.intentId === expected.intentId && context.provider === evidence.provider
    && (evidence.environment === undefined || evidence.environment === expected.environment)
    && (evidence.providerAccountScope === undefined || evidence.providerAccountScope === expected.providerAccountScope)
    && context.environment === expected.environment && context.providerAccountScope === expected.providerAccountScope
    && context.providerTransactionId === evidence.providerTransactionId
    && context.gatewayPrincipalId === expected.gatewayPrincipalId
    && context.cellId === expected.cellId && context.payer === expected.payer && context.payee === expected.payee
    && context.amount === expected.amount
    && context.currency === expected.currency && context.destinationId === expected.destinationId
    && context.finality === 'FUNDS_HELD';
}

function matchesIntent(
  intent: FundingIntent, evidence: FundingEvidence,
  boundary: { readonly state: Awaited<ReturnType<CellApplication['getCellState']>> & object; readonly destinationId: string },
): boolean {
  return hasValidFundingIntentBinding(intent)
    && intent.provider === evidence.provider
    && (evidence.environment === undefined || intent.environment === evidence.environment)
    && (evidence.providerAccountScope === undefined || intent.providerAccountScope === evidence.providerAccountScope)
    && intent.cellId === boundary.state.cellId
    && intent.payer === boundary.state.payer && intent.payee === boundary.state.payee
    && intent.amount === boundary.state.amount && intent.currency === boundary.state.currency
    && intent.destinationId === boundary.destinationId;
}

function fundingIngressRejection(code: 'FUNDING_NOT_FINAL' | 'FUNDING_DEPENDENCY_UNAVAILABLE' | 'CELL_NOT_FOUND' | 'FUNDING_EVIDENCE_INVALID'): HandleCommandResult {
  return { outcome: 'APPLICATION_REJECTION', error: { type: 'ApplicationError', code, message: 'Funding confirmation rejected' } };
}

function elapsed(started: number): number { return Math.max(0, Date.now() - started); }
