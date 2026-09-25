import type { ExpectedFundingBinding, FundingEvidence, FundingVerificationResult } from '../funding/types';
import type { CommandId, Timestamp } from '../core/types';
import type { PrototypeFundingPort } from '../security/trusted-ingress';

/** Development-only evidence issuer. Excluded from the production TypeScript build. */
export class PrototypeFundingEvidence implements PrototypeFundingPort {
  private readonly issued = new WeakMap<object, { readonly expected: ExpectedFundingBinding; readonly now: Timestamp }>();

  issue(expected: ExpectedFundingBinding, commandId: CommandId, now: Timestamp): FundingEvidence {
    const proof = Object.freeze({});
    this.issued.set(proof, { expected, now });
    return Object.freeze({ provider: 'zinesh-prototype', environment: 'SANDBOX',
      providerAccountScope: 'prototype-only', providerTransactionId: `prototype-${String(commandId)}`,
      intentId: expected.intentId, opaqueEvidence: proof });
  }

  async verify(evidence: FundingEvidence, expected: ExpectedFundingBinding): Promise<FundingVerificationResult> {
    const proof = evidence.opaqueEvidence;
    if (typeof proof !== 'object' || proof === null) return { outcome: 'INVALID', reason: 'AUTHENTICITY_FAILED' };
    const issued = this.issued.get(proof);
    if (issued === undefined || !sameBinding(issued.expected, expected)
      || evidence.provider !== 'zinesh-prototype' || evidence.environment !== 'SANDBOX'
      || evidence.providerAccountScope !== 'prototype-only' || evidence.intentId !== expected.intentId
      || evidence.providerTransactionId.length === 0) {
      return { outcome: 'INVALID', reason: 'AUTHENTICITY_FAILED' };
    }
    return { outcome: 'VERIFIED', context: { ...expected, provider: 'zinesh-prototype', environment: 'SANDBOX',
      providerAccountScope: 'prototype-only', providerTransactionId: evidence.providerTransactionId,
      confirmedAt: issued.now, finality: 'FUNDS_HELD', evidenceDigest: '0'.repeat(64), verifiedAt: issued.now } };
  }
}

function sameBinding(left: ExpectedFundingBinding, right: ExpectedFundingBinding): boolean {
  return left.intentId === right.intentId && left.environment === right.environment
    && left.providerAccountScope === right.providerAccountScope && left.gatewayPrincipalId === right.gatewayPrincipalId
    && left.cellId === right.cellId && left.payer === right.payer && left.payee === right.payee
    && left.amount === right.amount && left.currency === right.currency && left.destinationId === right.destinationId;
}
