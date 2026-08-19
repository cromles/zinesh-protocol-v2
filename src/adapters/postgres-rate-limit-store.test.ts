import { Pool } from 'pg';
import { PostgresMigrator } from './postgres-migrator';
import { PostgresFixedWindowRateLimiter, PostgresRateLimitStore } from './postgres-rate-limit-store';
import { RateLimitStorageError } from '../security/rate-limiter';
import type { RateLimitPolicy } from '../security/rate-limiter';

const enabled = process.env['ZINESH_POSTGRES_TESTS'] === 'true';
const maybeDescribe = enabled ? describe : describe.skip;
const config = {
  host: process.env['PGHOST'] ?? 'localhost', port: Number(process.env['PGPORT'] ?? 5432),
  database: process.env['PGDATABASE'] ?? 'zinesh_test', user: process.env['PGUSER'] ?? 'postgres',
  password: process.env['PGPASSWORD'] ?? 'postgres',
};
const policy = (limit: number, windowMs = 60_000, retentionMs = 120_000): RateLimitPolicy =>
  ({ limit, windowMs, retentionMs, storageTimeoutMs: 2_000 });

maybeDescribe('Phase 7G PostgreSQL distributed fixed-window limiter', () => {
  let poolA: Pool;
  let poolB: Pool;
  beforeAll(async () => {
    poolA = new Pool(config); poolB = new Pool(config);
    await new PostgresMigrator(poolA).migrate();
  });
  beforeEach(async () => { await poolA.query('TRUNCATE rate_limit_windows'); });
  afterAll(async () => { await Promise.all([poolA.end(), poolB.end()]); });

  test('two instances atomically enforce exact boundary under real concurrency', async () => {
    const first = new PostgresFixedWindowRateLimiter(new PostgresRateLimitStore(poolA), 'PRINCIPAL', policy(10));
    const second = new PostgresFixedWindowRateLimiter(new PostgresRateLimitStore(poolB), 'PRINCIPAL', policy(10));
    const decisions = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 === 0 ? first : second).consume('stable-principal')));
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(10);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(10);
    expect((await poolA.query('SELECT request_count FROM rate_limit_windows')).rows).toEqual([{ request_count: 10 }]);
  });

  test('different principals and categories have independent bounded state', async () => {
    const store = new PostgresRateLimitStore(poolA);
    const principal = new PostgresFixedWindowRateLimiter(store, 'PRINCIPAL', policy(1));
    const network = new PostgresFixedWindowRateLimiter(store, 'PRE_AUTH', policy(1));
    expect((await principal.consume('principal-a')).allowed).toBe(true);
    expect((await principal.consume('principal-b')).allowed).toBe(true);
    expect((await network.consume('principal-a')).allowed).toBe(true);
    expect((await poolA.query('SELECT count(*)::int AS count FROM rate_limit_windows')).rows[0]).toEqual({ count: 3 });
    expect(JSON.stringify((await poolA.query('SELECT * FROM rate_limit_windows')).rows)).not.toContain('principal-a');
  });

  test('process recreation cannot reset shared principal state', async () => {
    const original = new PostgresFixedWindowRateLimiter(new PostgresRateLimitStore(poolA), 'PRINCIPAL', policy(1));
    expect((await original.consume('restart-principal')).allowed).toBe(true);
    const recreated = new PostgresFixedWindowRateLimiter(new PostgresRateLimitStore(poolB), 'PRINCIPAL', policy(1));
    expect((await recreated.consume('restart-principal')).allowed).toBe(false);
  });

  test('database-clock window expiration resets and cleanup removes expired state', async () => {
    const limiter = new PostgresFixedWindowRateLimiter(new PostgresRateLimitStore(poolA), 'PRE_AUTH', policy(1, 1_000, 1_000));
    expect((await limiter.consume('198.51.100.1')).allowed).toBe(true);
    expect((await limiter.consume('198.51.100.1')).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await limiter.consume('198.51.100.1')).allowed).toBe(true);
    expect((await poolA.query('SELECT count(*)::int AS count FROM rate_limit_windows')).rows[0]).toEqual({ count: 1 });
  });

  test('unbounded keys and unavailable storage fail closed', async () => {
    const store = new PostgresRateLimitStore(poolA);
    await expect(store.consume('PRE_AUTH', 'x'.repeat(257), policy(1))).rejects.toBeInstanceOf(RateLimitStorageError);
    expect((await poolA.query('SELECT count(*)::int AS count FROM rate_limit_windows')).rows[0]).toEqual({ count: 0 });
    const isolated = new Pool(config);
    const unavailable = new PostgresFixedWindowRateLimiter(new PostgresRateLimitStore(isolated), 'PRE_AUTH', policy(1));
    await isolated.end();
    await expect(unavailable.consume('203.0.113.1')).rejects.toBeInstanceOf(RateLimitStorageError);
  });

  test('metric sink failure cannot change a real PostgreSQL limiter decision', async () => {
    const limiter = new PostgresFixedWindowRateLimiter(
      new PostgresRateLimitStore(poolA), 'PRE_AUTH', policy(1),
      { record() { throw new Error('metrics backend unavailable token=secret'); } },
    );
    await expect(limiter.consume('203.0.113.25')).resolves.toEqual({
      allowed: true, retryAfterSeconds: expect.any(Number),
    });
    await expect(limiter.consume('203.0.113.25')).resolves.toEqual({
      allowed: false, retryAfterSeconds: expect.any(Number),
    });
  });
});
