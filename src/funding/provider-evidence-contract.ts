import type { ExpectedFundingBinding } from './types';
import type { NormalizedProviderEvidence } from './provider-evidence';

export type ProviderEvidenceAssessment =
  | { readonly outcome: 'ACCEPTED' }
  | { readonly outcome: 'INVALID'; readonly reason: 'AUTHENTICITY_FAILED' | 'MALFORMED' }
  | { readonly outcome: 'BINDING_MISMATCH'; readonly field:
      'INTENT' | 'AMOUNT' | 'CURRENCY' | 'DESTINATION' }
  | { readonly outcome: 'NOT_FINAL'; readonly state: NormalizedProviderEvidence['reconciliationState'] };

/** Assessment only: deliberately cannot manufacture a branded VerifiedFundingContext. */
export function assessProviderEvidence(evidence: NormalizedProviderEvidence,
  expected: ExpectedFundingBinding): ProviderEvidenceAssessment {
  if (!isDigest(evidence.rawPayloadDigest) || !isDigest(evidence.normalizedEvidenceDigest)
      || evidence.schemaVersion !== 1 || evidence.provider.length === 0
      || evidence.providerAccountScope.length === 0 || evidence.providerTransactionId.length === 0
      || evidence.providerPaymentId.length === 0 || evidence.providerConversationId.length === 0) {
    return { outcome:'INVALID',reason:'MALFORMED' };
  }
  if (evidence.responseAuthenticity !== 'VERIFIED') {
    return { outcome:'INVALID',reason:'AUTHENTICITY_FAILED' };
  }
  if (evidence.intentId !== expected.intentId) return { outcome:'BINDING_MISMATCH',field:'INTENT' };
  if (evidence.environment !== expected.environment
      || evidence.providerAccountScope !== expected.providerAccountScope
      || evidence.providerTransactionId.length === 0) return { outcome:'BINDING_MISMATCH',field:'INTENT' };
  if (evidence.amountMinor !== expected.amount) return { outcome:'BINDING_MISMATCH',field:'AMOUNT' };
  if (evidence.currency !== expected.currency) return { outcome:'BINDING_MISMATCH',field:'CURRENCY' };
  if (evidence.destinationReference !== expected.destinationId) {
    return { outcome:'BINDING_MISMATCH',field:'DESTINATION' };
  }
  if (evidence.reconciliationState !== 'FUNDS_HELD') {
    return { outcome:'NOT_FINAL',state:evidence.reconciliationState };
  }
  return { outcome:'ACCEPTED' };
}
function isDigest(value: string): boolean { return /^[0-9a-f]{64}$/.test(value); }
