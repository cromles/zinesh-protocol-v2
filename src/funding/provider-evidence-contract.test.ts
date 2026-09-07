import { makeActorId, makeAmount, makeCellId, makeTimestamp } from '../core/types';
import type { ExpectedFundingBinding } from './types';
import type { NormalizedProviderEvidence } from './provider-evidence';
import { assessProviderEvidence } from './provider-evidence-contract';

const expected: ExpectedFundingBinding = { intentId:'intent-1',gatewayPrincipalId:'gateway',
  cellId:makeCellId('cell-1'),payer:makeActorId('payer'),payee:makeActorId('payee'),
  amount:makeAmount(100n),currency:'TRY',destinationId:'custody-1' };
const evidence: NormalizedProviderEvidence = { schemaVersion:1,provider:'provider',environment:'SANDBOX',
  intentId:'intent-1',providerPaymentId:'payment-1',providerConversationId:'conversation-1',
  destinationReference:'custody-1',amountMinor:makeAmount(100n),currency:'TRY',providerStatus:'CAPTURED',
  reconciliationState:'FUNDS_HELD',queriedAt:makeTimestamp(100),responseAuthenticity:'VERIFIED',
  rawPayloadDigest:'a'.repeat(64),normalizedEvidenceDigest:'b'.repeat(64) };

describe('provider-neutral evidence contract', () => {
  test('accepts authentic exact held evidence without creating funding context', () => {
    expect(assessProviderEvidence(evidence,expected)).toEqual({outcome:'ACCEPTED'});
  });
  test('rejects unauthentic and malformed evidence', () => {
    expect(assessProviderEvidence({...evidence,responseAuthenticity:'FAILED'},expected))
      .toEqual({outcome:'INVALID',reason:'AUTHENTICITY_FAILED'});
    expect(assessProviderEvidence({...evidence,rawPayloadDigest:'bad'},expected))
      .toEqual({outcome:'INVALID',reason:'MALFORMED'});
  });
  test.each<['AMOUNT'|'CURRENCY'|'DESTINATION'|'INTENT',Partial<NormalizedProviderEvidence>]>([
    ['AMOUNT',{amountMinor:makeAmount(99n)}],['CURRENCY',{currency:'USD' as never}],
    ['DESTINATION',{destinationReference:'attacker'}],['INTENT',{intentId:'other'}],
  ])('rejects %s binding mismatch', (field,change) => {
    expect(assessProviderEvidence({...evidence,...change},expected))
      .toEqual({outcome:'BINDING_MISMATCH',field});
  });
  test.each(['PENDING','UNKNOWN','FAILED','CANCELLED','REFUNDED','REVERSED','DISPUTED'] as const)
  ('never accepts %s as held', (state) => {
    expect(assessProviderEvidence({...evidence,reconciliationState:state},expected))
      .toEqual({outcome:'NOT_FINAL',state});
  });
});
