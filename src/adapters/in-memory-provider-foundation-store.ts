import type { ProviderEvent, ProviderNegativeObservation, ProviderReconciliationCheckpoint,
  ProviderTransactionCorrelation } from '../funding/provider-evidence';
import type { ProviderCorrelationResult, ProviderEventRecordResult, ProviderFoundationStore,
  ProviderNegativeObservationResult } from './provider-foundation-store';
import { sameProviderCorrelation, sameProviderEvent } from './provider-foundation-store';

export class InMemoryProviderFoundationStore implements ProviderFoundationStore {
  private readonly events: ProviderEvent[] = [];
  private readonly correlations: ProviderTransactionCorrelation[] = [];
  private readonly checkpoints = new Map<string, ProviderReconciliationCheckpoint>();
  private readonly negatives: ProviderNegativeObservation[] = [];

  async recordEvent(event: ProviderEvent): Promise<ProviderEventRecordResult> {
    const matches = this.events.filter((item) => item.eventIdentity === event.eventIdentity
      || (item.provider === event.provider && item.environment === event.environment
        && item.replayIdentity === event.replayIdentity));
    const exact = matches.find((item) => sameProviderEvent(item,event));
    if (exact !== undefined) return { kind:'DUPLICATE',event:exact };
    if (matches.some((item) => item.replayIdentity === event.replayIdentity
      && item.payloadDigest !== event.payloadDigest)) return { kind:'REPLAY_PAYLOAD_CONFLICT' };
    if (matches.length > 0) return { kind:'CONFLICTING_DUPLICATE' };
    this.events.push(event); return { kind:'FIRST_SEEN' };
  }

  async correlateTransaction(value: ProviderTransactionCorrelation): Promise<ProviderCorrelationResult> {
    const matches = this.correlations.filter((item) => item.provider === value.provider
      && item.environment === value.environment
      && (item.providerTransactionId === value.providerTransactionId || item.intentId === value.intentId));
    if (matches.length === 0) { this.correlations.push(value); return { kind:'RECORDED' }; }
    return matches.length === 1 && sameProviderCorrelation(matches[0]!,value)
      ? { kind:'DUPLICATE',correlation:matches[0]! } : { kind:'CONFLICT' };
  }

  async putCheckpoint(value: ProviderReconciliationCheckpoint): Promise<void> {
    this.checkpoints.set(key(value.provider,value.environment,value.providerTransactionId),value);
  }
  async getCheckpoint(provider: string, environment: string,
    providerTransactionId: string): Promise<ProviderReconciliationCheckpoint | null> {
    return this.checkpoints.get(key(provider,environment,providerTransactionId)) ?? null;
  }
  async appendNegativeObservation(value: ProviderNegativeObservation):
    Promise<ProviderNegativeObservationResult> {
    const matches = this.negatives.filter((item) => item.observationId === value.observationId
      || (item.provider === value.provider && item.environment === value.environment
        && item.providerObservationId === value.providerObservationId));
    if (matches.length === 0) { this.negatives.push(value); return { kind:'RECORDED' }; }
    const exact = matches.find((item) => JSON.stringify({...item,amountMinor:item.amountMinor?.toString()})
      === JSON.stringify({...value,amountMinor:value.amountMinor?.toString()}));
    return exact === undefined ? { kind:'CONFLICT' } : { kind:'DUPLICATE',observation:exact };
  }
}
function key(provider:string, environment:string, transaction:string): string {
  return `${provider.length}:${provider}${environment.length}:${environment}${transaction.length}:${transaction}`;
}
