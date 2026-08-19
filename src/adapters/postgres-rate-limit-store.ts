import { createHash } from 'crypto';
import type { Pool, QueryConfig } from 'pg';
import type {
  RateLimitCategory, RateLimitDecision, RateLimiter, RateLimitMetricSink, RateLimitPolicy,
} from '../security/rate-limiter';
import { RateLimitStorageError } from '../security/rate-limiter';

export class PostgresRateLimitStore {
  constructor(private readonly pool: Pool) {}

  async consume(category: RateLimitCategory, key: string, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    if (key.length === 0 || key.length > 256) throw new RateLimitStorageError();
    const keyHash = createHash('sha256').update(`${category}\0${key}`).digest('hex');
    try {
      const query: QueryConfig & { readonly query_timeout: number } = {
        text: `WITH db_clock AS MATERIALIZED (SELECT clock_timestamp() AS now),
        timing AS MATERIALIZED (
          SELECT c.now,
            (floor(extract(epoch FROM c.now) * 1000 / $4::bigint) * $4::bigint)::bigint AS window_start
          FROM db_clock c
        ), cleanup AS (
          DELETE FROM rate_limit_windows r USING timing t WHERE r.expires_at < t.now RETURNING r.key_hash
        ), attempt AS (
          INSERT INTO rate_limit_windows(category,key_hash,window_start,request_count,expires_at)
          SELECT $1,$2,t.window_start,1,
            to_timestamp((t.window_start + $5::bigint)::double precision / 1000) FROM timing t
          ON CONFLICT(category,key_hash,window_start) DO UPDATE
            SET request_count=rate_limit_windows.request_count + 1
            WHERE rate_limit_windows.request_count < $3
          RETURNING request_count
        )
        SELECT EXISTS(SELECT 1 FROM attempt) AS allowed,
          greatest(1,ceil(((t.window_start + $4::bigint) - extract(epoch FROM t.now) * 1000) / 1000))::int
            AS retry_after_seconds
        FROM timing t`,
        values: [category, keyHash, policy.limit, policy.windowMs, policy.retentionMs],
        query_timeout: policy.storageTimeoutMs,
      };
      const result = await this.pool.query<{ allowed: boolean; retry_after_seconds: number }>(query);
      const row = result.rows[0];
      if (row === undefined) throw new Error('missing decision');
      return { allowed: row.allowed, retryAfterSeconds: Number(row.retry_after_seconds) };
    } catch { throw new RateLimitStorageError(); }
  }
}

export class PostgresFixedWindowRateLimiter implements RateLimiter {
  constructor(
    private readonly store: PostgresRateLimitStore,
    private readonly category: RateLimitCategory,
    private readonly policy: RateLimitPolicy,
    private readonly metrics?: RateLimitMetricSink,
  ) {}

  async consume(key: string): Promise<RateLimitDecision> {
    const started = Date.now();
    try {
      const decision = await this.store.consume(this.category, key, this.policy);
      this.metrics?.record({ category: this.category, outcome: decision.allowed ? 'ALLOWED' : 'REJECTED',
        latencyMs: Math.max(0, Date.now() - started) });
      return decision;
    } catch {
      this.metrics?.record({ category: this.category, outcome: 'STORAGE_FAILURE',
        latencyMs: Math.max(0, Date.now() - started) });
      throw new RateLimitStorageError();
    }
  }
}
