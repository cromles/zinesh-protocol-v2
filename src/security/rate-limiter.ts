export type RateLimitCategory = 'PRE_AUTH' | 'PRINCIPAL';

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(key: string): Promise<RateLimitDecision>;
}

export interface RateLimitPolicy {
  readonly limit: number;
  readonly windowMs: number;
  readonly retentionMs: number;
  readonly storageTimeoutMs: number;
}

export interface RateLimitMetric {
  readonly category: RateLimitCategory;
  readonly outcome: 'ALLOWED' | 'REJECTED' | 'STORAGE_FAILURE';
  readonly latencyMs: number;
}

export interface RateLimitMetricSink { record(metric: RateLimitMetric): void }

export class JsonLineRateLimitMetricSink implements RateLimitMetricSink {
  record(metric: RateLimitMetric): void { process.stdout.write(`${JSON.stringify(metric)}\n`); }
}

export class RateLimitStorageError extends Error {
  constructor() { super('Rate limit storage unavailable'); this.name = 'RateLimitStorageError'; }
}

export const allowAllRateLimiter: RateLimiter = {
  async consume() { return { allowed: true, retryAfterSeconds: 0 }; },
};
