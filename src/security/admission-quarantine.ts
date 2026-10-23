import type { AdmissionContext, AdmissionDecision, AdmissionPolicy } from './adaptive-admission';

export const MAX_QUARANTINE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export type QuarantineReason =
  | 'SECURITY_INCIDENT'
  | 'BEHAVIORAL_ANOMALY'
  | 'CREDENTIAL_COMPROMISE'
  | 'MANUAL_REVIEW';

export interface AdmissionQuarantine {
  readonly quarantineId: string;
  readonly principalId: string;
  readonly reason: QuarantineReason;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly issuedBy: string;
  readonly correlationId: string;
}

export interface QuarantineRelease {
  readonly quarantineId: string;
  readonly releasedAt: number;
  readonly releasedBy: string;
  readonly correlationId: string;
}

export interface AdmissionQuarantineReader {
  findActive(principalId: string, at: number): Promise<AdmissionQuarantine | null>;
}

export interface AdmissionQuarantineStore extends AdmissionQuarantineReader {
  issue(quarantine: AdmissionQuarantine): Promise<'ISSUED' | 'DUPLICATE' | 'CONFLICT' | 'INVALID'>;
  release(release: QuarantineRelease): Promise<'RELEASED' | 'DUPLICATE' | 'CONFLICT' | 'NOT_FOUND' | 'INVALID'>;
}

/**
 * Durable quarantine is a narrowing policy only. Expiration is evaluated using an injected clock;
 * no background process can settle or mutate an escrow cell.
 */
export class QuarantineAdmissionPolicy implements AdmissionPolicy {
  readonly version = 'quarantine-v1';

  constructor(
    private readonly reader: AdmissionQuarantineReader,
    private readonly now: () => number = Date.now,
  ) {}

  async evaluate(context: AdmissionContext): Promise<AdmissionDecision> {
    const at = this.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('Invalid quarantine clock');
    const active = await this.reader.findActive(context.principal.principalId, at);
    return active === null
      ? { disposition: 'ALLOW', reason: 'BASELINE_ALLOW' }
      : { disposition: 'QUARANTINE', reason: 'PRINCIPAL_QUARANTINED' };
  }
}
