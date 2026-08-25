import type { CellId } from '../core/types';
import type { FundingDisputeObservation } from '../funding/types';
import type { FundingDisputeRecordResult, FundingDisputeStore } from './funding-dispute-store';
import { hasConsistentFundingDisputeLifecycle, isBlockingFundingDispute,
  sameFundingDisputeBinding, sameFundingDisputeObservation } from './funding-dispute-store';

export class InMemoryFundingDisputeStore implements FundingDisputeStore {
  private readonly observations: FundingDisputeObservation[] = [];

  async record(observation: FundingDisputeObservation): Promise<FundingDisputeRecordResult> {
    if (!hasConsistentFundingDisputeLifecycle(observation)) return { kind: 'CONFLICT' };
    const series = this.observations.filter((item) => item.provider === observation.provider
      && item.providerDisputeId === observation.providerDisputeId);
    if (series.some((item) => !sameFundingDisputeBinding(item, observation))) {
      return { kind: 'CONFLICT' };
    }
    const matches = this.observations.filter((item) => item.observationId === observation.observationId
      || (item.provider === observation.provider && item.providerDisputeId === observation.providerDisputeId
        && (item.observationVersion === observation.observationVersion
          || item.evidenceDigest === observation.evidenceDigest)));
    if (matches.length === 1 && sameFundingDisputeObservation(matches[0]!, observation)) {
      return { kind: 'DUPLICATE', observation: matches[0]! };
    }
    if (matches.length > 0) return { kind: 'CONFLICT' };
    this.observations.push(Object.freeze({ ...observation }));
    return { kind: 'RECORDED' };
  }

  async hasBlockingDispute(cellId: CellId): Promise<boolean> {
    const latest = new Map<string, FundingDisputeObservation>();
    for (const observation of this.observations.filter((item) => item.cellId === cellId)) {
      const key = `${observation.provider}\u0000${observation.providerDisputeId}`;
      const previous = latest.get(key);
      if (previous === undefined || observation.observationVersion > previous.observationVersion) {
        latest.set(key, observation);
      }
    }
    return [...latest.values()].some((item) => isBlockingFundingDispute(item.outcome));
  }
}
