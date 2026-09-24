import type { ProviderNegativeObservation } from '../funding/provider-evidence';
import type { ProviderNegativeDisposition, ProviderNegativeResolutionEvidence, FundingReceipt } from '../funding/types';
import type { ProviderFoundationStore } from '../adapters/provider-foundation-store';
import type { FundingReceiptStore } from '../adapters/funding-receipt-store';
import { makeTimestamp } from '../core/types';
import type { AuthenticationPort, PrincipalAuthority, Capability } from './trusted-ingress';

export interface NegativeResolutionEvidencePort {
  verify(evidence: unknown, source: ProviderNegativeObservation, receipt: FundingReceipt):
    Promise<ProviderNegativeResolutionEvidence | null>;
}
export interface FundingNegativeResolutionRequest {
  readonly credential: unknown;
  readonly sourceNegativeObservationId: string;
  readonly evidence: unknown;
}
export const rejectAllNegativeResolutionEvidence: NegativeResolutionEvidencePort = {
  async verify() { return null; },
};

export type NegativeResolutionResult = 'RECORDED' | 'DUPLICATE' | 'REJECTED' | 'UNAVAILABLE';

/** Separate authenticated entry point; never creates a funding context or invokes settlement. */
export class TrustedNegativeResolutionIngress {
  constructor(private readonly authentication: AuthenticationPort, private readonly principals: PrincipalAuthority,
    private readonly evidence: NegativeResolutionEvidencePort, private readonly foundation: ProviderFoundationStore,
    private readonly receipts: FundingReceiptStore, private readonly now: () => number = Date.now) {}

  async resolve(request: FundingNegativeResolutionRequest): Promise<NegativeResolutionResult> {
    try {
      const auth = await this.authentication.authenticate(request.credential);
      if (!auth.ok) return 'REJECTED';
      const principal = await this.principals.resolve(auth.identity);
      if (principal === null || !principal.enabled || principal.type !== 'GATEWAY'
        || !principal.capabilities.includes('RESOLVE_FUNDING_NEGATIVE' as Capability)) return 'REJECTED';
      const source = await this.foundation.getNegativeObservation(request.sourceNegativeObservationId);
      if (source === null || source.receiptId === undefined || source.providerAccountScope === undefined) return 'REJECTED';
      const receipt = await this.receipts.getById(source.receiptId);
      if (receipt === null || !sameNegativeReceipt(source, receipt)) return 'REJECTED';
      const proof = await this.evidence.verify(request.evidence, source, receipt);
      if (proof === null || !validProof(proof, source, receipt)) return 'REJECTED';
      const prior = await this.foundation.listNegativeDispositions(String(receipt.cellId));
      const version = prior.filter((item) => item.sourceNegativeObservationId === source.observationId)
        .reduce((latest, item) => item.version > latest ? item.version : latest, 0n) + 1n;
      const disposition: ProviderNegativeDisposition = Object.freeze({
        resolutionId: `negative-resolution-${proof.evidenceDigest}`,
        sourceNegativeObservationId: source.observationId, provider: source.provider,
        environment: source.environment, providerAccountScope: source.providerAccountScope,
        providerObservationId: source.providerObservationId, providerTransactionId: source.providerTransactionId,
        intentId: source.intentId, receiptId: receipt.receiptId, cellId: receipt.cellId,
        amount: receipt.amount, currency: receipt.currency, status: proof.status, outcome: proof.outcome,
        version,
        evidenceReference: proof.evidenceReference, evidenceDigest: proof.evidenceDigest,
        observedAt: proof.observedAt, recordedAt: makeTimestamp(this.now()), resolverPrincipalId: principal.principalId,
        resolverCapability: 'RESOLVE_FUNDING_NEGATIVE',
      });
      const outcome = await this.foundation.appendNegativeDisposition(disposition);
      return outcome === 'RECORDED' ? 'RECORDED' : outcome === 'DUPLICATE' ? 'DUPLICATE' : 'REJECTED';
    } catch { return 'UNAVAILABLE'; }
  }
}

function sameNegativeReceipt(source: ProviderNegativeObservation, receipt: FundingReceipt): boolean {
  return source.provider === receipt.provider && source.environment === receipt.environment
    && source.providerAccountScope === receipt.providerAccountScope
    && source.providerTransactionId === receipt.providerTransactionId && source.intentId === receipt.intentId
    && source.receiptId === receipt.receiptId && source.cellId === receipt.cellId;
}

function validProof(proof: ProviderNegativeResolutionEvidence, source: ProviderNegativeObservation,
  receipt: FundingReceipt): boolean {
  return proof.schemaVersion === 1 && proof.responseAuthenticity === 'VERIFIED'
    && proof.provider === source.provider && proof.environment === source.environment
    && proof.providerAccountScope === source.providerAccountScope
    && proof.providerTransactionId === source.providerTransactionId
    && proof.sourceNegativeObservationId === source.observationId
    && proof.sourceProviderObservationId === source.providerObservationId
    && proof.intentId === source.intentId && proof.receiptId === receipt.receiptId
    && proof.cellId === receipt.cellId && proof.amount === receipt.amount && proof.currency === receipt.currency
    && proof.status !== 'PENDING' && proof.outcome !== 'PENDING'
    && ((proof.outcome === 'FUNDS_RETAINED' && proof.providerFinalState === 'FUNDS_HELD')
      || (proof.outcome === 'FUNDS_LOST' && proof.providerFinalState === 'FUNDS_LOST'))
    && proof.evidenceReference.length > 0 && /^[0-9a-f]{64}$/.test(proof.evidenceDigest);
}
