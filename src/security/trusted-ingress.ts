import type { ActorId, Amount, CellId, Command, Currency } from '../core/types';
import type { CellApplication } from '../application/cell-application';
import type { HandleCommandResult, TrustedHandleCommandRequest } from '../application/types';
import { rateLimitRejection, rateLimitUnavailable, securityRejection } from '../application/errors';
import { allowAllRateLimiter } from './rate-limiter';
import type { RateLimiter } from './rate-limiter';

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
    { readonly ok: true; readonly identity: ExternalIdentity } | { readonly ok: false }
  >;
}

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
  ) {}

  async handle(request: ExternalCommandRequest): Promise<HandleCommandResult> {
    const authenticated = await this.authentication.authenticate(request.credential);
    if (!authenticated.ok) return securityRejection('UNAUTHENTICATED');

    const record = await this.principals.resolve(authenticated.identity);
    if (record === null) return securityRejection('PRINCIPAL_NOT_MAPPED');
    if (!record.enabled) return securityRejection('PRINCIPAL_DISABLED');
    if (record.type === 'ACTOR' && record.actorId === undefined) {
      return securityRejection('PRINCIPAL_NOT_MAPPED');
    }

    try {
      const decision = await this.principalRateLimiter.consume(record.principalId);
      if (!decision.allowed) return rateLimitRejection(decision.retryAfterSeconds);
    } catch { return rateLimitUnavailable(); }

    const principal = verifyPrincipal(record);
    let fundingContext: VerifiedFundingContext | undefined;
    if (request.command.type === 'FundCell') {
      if (principal.type !== 'GATEWAY' || !principal.capabilities.includes('CONFIRM_FUNDING')) {
        return securityRejection('COMMAND_NOT_PERMITTED');
      }
      const evidence = await this.fundingEvidence.verify(request.fundingEvidence);
      if (evidence === null) return securityRejection('FUNDING_EVIDENCE_INVALID');
      fundingContext = verifyFundingContext(evidence);
    }

    const trusted: TrustedHandleCommandRequest = fundingContext === undefined
      ? { command: request.command, principal }
      : { command: request.command, principal, fundingContext };
    return this.application.handleCommand(trusted);
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
