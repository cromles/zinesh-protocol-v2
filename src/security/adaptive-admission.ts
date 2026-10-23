import type { Command } from '../core/types';
import type { Capability, PrincipalType, VerifiedPrincipal } from './trusted-ingress';

export type AdmissionMode = 'ENFORCE' | 'SHADOW';
export type AdmissionDisposition = 'ALLOW' | 'LIMIT' | 'CHALLENGE' | 'QUARANTINE' | 'DENY';
export type AdmissionReason =
  | 'BASELINE_ALLOW'
  | 'RISK_LIMIT'
  | 'ADDITIONAL_PROOF_REQUIRED'
  | 'PRINCIPAL_QUARANTINED'
  | 'POLICY_DENY'
  | 'ADMISSION_POLICY_FAILURE'
  | 'INVALID_ADMISSION_DECISION';

export interface AdmissionContext {
  readonly principal: {
    readonly principalId: string;
    readonly type: PrincipalType;
    readonly capabilities: ReadonlyArray<Capability>;
    readonly mappingVersion: number;
  };
  readonly command: {
    readonly type: Command['type'];
  };
}

export interface AdmissionDecision {
  readonly disposition: AdmissionDisposition;
  readonly reason: AdmissionReason;
  readonly retryAfterSeconds?: number;
}

export interface AdmissionPolicy {
  readonly version: string;
  evaluate(context: AdmissionContext): Promise<AdmissionDecision>;
}

export interface AdmissionEvaluation {
  readonly mode: AdmissionMode;
  readonly policyVersion: string;
  readonly observed: AdmissionDecision;
  readonly effective: 'ALLOW' | 'REJECT';
  readonly policyFailed: boolean;
}

const SAFE_POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DISPOSITIONS = new Set<AdmissionDisposition>([
  'ALLOW', 'LIMIT', 'CHALLENGE', 'QUARANTINE', 'DENY',
]);
const REASONS = new Set<AdmissionReason>([
  'BASELINE_ALLOW', 'RISK_LIMIT', 'ADDITIONAL_PROOF_REQUIRED', 'PRINCIPAL_QUARANTINED',
  'POLICY_DENY', 'ADMISSION_POLICY_FAILURE', 'INVALID_ADMISSION_DECISION',
]);

export const baselineAdmissionPolicy: AdmissionPolicy = Object.freeze({
  version: 'baseline-v1',
  async evaluate(): Promise<AdmissionDecision> {
    return { disposition: 'ALLOW', reason: 'BASELINE_ALLOW' };
  },
});

/**
 * A policy may only narrow access after authentication and principal resolution.
 * SHADOW observes candidate policy decisions without changing command execution.
 */
export class AdaptiveAdmissionController {
  readonly mode: AdmissionMode;
  readonly policyVersion: string;

  constructor(
    private readonly policy: AdmissionPolicy = baselineAdmissionPolicy,
    mode: AdmissionMode = 'ENFORCE',
  ) {
    if (!SAFE_POLICY_VERSION.test(policy.version)) throw new Error('Invalid admission policy version');
    this.mode = mode;
    this.policyVersion = policy.version;
  }

  async evaluate(principal: VerifiedPrincipal, command: Command): Promise<AdmissionEvaluation> {
    const context = immutableContext(principal, command);
    let observed: AdmissionDecision;
    let policyFailed = false;
    try {
      const candidate = await this.policy.evaluate(context);
      observed = validDecision(candidate)
        ? immutableDecision(candidate)
        : { disposition: 'DENY', reason: 'INVALID_ADMISSION_DECISION' };
      policyFailed = !validDecision(candidate);
    } catch {
      observed = { disposition: 'DENY', reason: 'ADMISSION_POLICY_FAILURE' };
      policyFailed = true;
    }
    return Object.freeze({
      mode: this.mode,
      policyVersion: this.policyVersion,
      observed,
      effective: this.mode === 'SHADOW' || observed.disposition === 'ALLOW' ? 'ALLOW' : 'REJECT',
      policyFailed,
    });
  }
}

function immutableContext(principal: VerifiedPrincipal, command: Command): AdmissionContext {
  return Object.freeze({
    principal: Object.freeze({
      principalId: principal.principalId,
      type: principal.type,
      capabilities: Object.freeze([...principal.capabilities]),
      mappingVersion: principal.mappingVersion,
    }),
    command: Object.freeze({ type: command.type }),
  });
}

function immutableDecision(decision: AdmissionDecision): AdmissionDecision {
  return Object.freeze({
    disposition: decision.disposition,
    reason: decision.reason,
    ...(decision.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: decision.retryAfterSeconds }),
  });
}

function validDecision(value: unknown): value is AdmissionDecision {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AdmissionDecision>;
  if (candidate.disposition === undefined || !DISPOSITIONS.has(candidate.disposition)
    || candidate.reason === undefined || !REASONS.has(candidate.reason)) return false;
  if (candidate.disposition === 'LIMIT') return candidate.reason === 'RISK_LIMIT'
    && Number.isSafeInteger(candidate.retryAfterSeconds)
    && candidate.retryAfterSeconds !== undefined
    && candidate.retryAfterSeconds >= 1
    && candidate.retryAfterSeconds <= 86_400;
  if (candidate.retryAfterSeconds !== undefined) return false;
  if (candidate.disposition === 'ALLOW') return candidate.reason === 'BASELINE_ALLOW';
  if (candidate.disposition === 'CHALLENGE') return candidate.reason === 'ADDITIONAL_PROOF_REQUIRED';
  if (candidate.disposition === 'QUARANTINE') return candidate.reason === 'PRINCIPAL_QUARANTINED';
  return candidate.disposition === 'DENY' && candidate.reason === 'POLICY_DENY';
}
