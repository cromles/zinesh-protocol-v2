import { makeActorId, makeAmount, makeCellId, makeCommandId, makeEventId, makeTimestamp } from '../core/types';
import { InMemoryFundingReceiptStore } from '../adapters/in-memory-funding-receipt-store';
import { InMemoryProviderFoundationStore } from '../adapters/in-memory-provider-foundation-store';
import type { ProviderNegativeResolutionEvidence, FundingReceipt } from '../funding/types';
import { TrustedNegativeResolutionIngress } from './negative-resolution-ingress';
import type { AuthenticationPort, PrincipalAuthority } from './trusted-ingress';

const receipt: FundingReceipt = { intentId:'intent-r',receiptId:'receipt-r',provider:'bank',environment:'LIVE',
  providerAccountScope:'account-r',providerTransactionId:'tx-r',cellId:makeCellId('cell-r'),commandId:makeCommandId('cmd-r'),
  fundingEventId:makeEventId('evt-r'),gatewayPrincipalId:'gateway-confirm',payer:makeActorId('payer-r'),payee:makeActorId('payee-r'),
  amount:makeAmount(1000n),currency:'TRY',destinationId:'dest-r',confirmedAt:makeTimestamp(1),finality:'FUNDS_HELD',
  evidenceDigest:'a'.repeat(64),verifiedAt:makeTimestamp(2),createdAt:makeTimestamp(3) };
const negative = { observationId:'b'.repeat(64),provider:'bank',environment:'LIVE' as const,
  providerAccountScope:'account-r',providerObservationId:'negative-r',providerTransactionId:'tx-r',intentId:'intent-r',
  receiptId:'receipt-r',cellId:'cell-r',kind:'RETURNED' as const,amountMinor:makeAmount(1000n),currency:'TRY' as const,
  payloadDigest:'c'.repeat(64),observedAt:makeTimestamp(4),recordedAt:makeTimestamp(5) };
function setup(options: { authorized?: boolean; verified?: boolean; partial?: boolean } = {}) {
  const foundation = new InMemoryProviderFoundationStore(); const receipts = new InMemoryFundingReceiptStore();
  const authentication: AuthenticationPort = { async authenticate() { return { ok:true,identity:{issuer:'issuer',subject:'subject'} }; } };
  const principals: PrincipalAuthority = { async resolve() { return { principalId:'resolver-1',type:'GATEWAY',enabled:true,
    capabilities:options.authorized === false ? [] : ['RESOLVE_FUNDING_NEGATIVE'],mappingVersion:1 }; } };
  const proof: ProviderNegativeResolutionEvidence = { schemaVersion:1,provider:'bank',environment:'LIVE',
    providerAccountScope:'account-r',providerTransactionId:'tx-r',sourceNegativeObservationId:negative.observationId,
    sourceProviderObservationId:'negative-r',intentId:'intent-r',receiptId:'receipt-r',cellId:receipt.cellId,
    amount:receipt.amount,currency:'TRY',providerFinalState:'FUNDS_HELD',status:'RESOLVED',outcome:'FUNDS_RETAINED',
    responseAuthenticity:'VERIFIED',evidenceReference:'account-ledger/record-1',evidenceDigest:'d'.repeat(64),observedAt:makeTimestamp(6) };
  const ingress = new TrustedNegativeResolutionIngress(authentication,principals,
    { async verify() { return options.verified === false ? null : options.partial === true
      ? { ...proof, amount:makeAmount(700n) } : proof; } },foundation,receipts,()=>7);
  return {foundation,receipts,ingress};
}

describe('trusted provider-negative resolution', () => {
  test('only separately authorized verified exact evidence appends a disposition; it creates no funding context', async () => {
    const h=setup(); await h.receipts.claim(receipt); await h.foundation.appendNegativeObservation(negative);
    await expect(h.ingress.resolve({credential:'credential',sourceNegativeObservationId:negative.observationId,evidence:{}}))
      .resolves.toBe('RECORDED');
    const saved=await h.foundation.listNegativeDispositions('cell-r');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({outcome:'FUNDS_RETAINED',resolverPrincipalId:'resolver-1',resolverCapability:'RESOLVE_FUNDING_NEGATIVE'});
    expect(saved[0]).not.toHaveProperty('finality');
  });

  test.each([{authorized:false},{verified:false}])('rejects unauthorized or NOT_FOUND/unverified evidence %#', async (opts) => {
    const h=setup(opts); await h.receipts.claim(receipt); await h.foundation.appendNegativeObservation(negative);
    await expect(h.ingress.resolve({credential:'credential',sourceNegativeObservationId:negative.observationId,evidence:{}}))
      .resolves.toBe('REJECTED');
    expect(await h.foundation.listNegativeDispositions('cell-r')).toHaveLength(0);
  });

  test('partial retained amount remains blocked', async () => {
    const h=setup({partial:true}); await h.receipts.claim(receipt); await h.foundation.appendNegativeObservation(negative);
    await expect(h.ingress.resolve({credential:'credential',sourceNegativeObservationId:negative.observationId,evidence:{}}))
      .resolves.toBe('REJECTED');
    expect(await h.foundation.listNegativeDispositions('cell-r')).toHaveLength(0);
  });
});
