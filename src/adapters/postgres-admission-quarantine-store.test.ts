import fs from 'fs';
import { Pool } from 'pg';
import { PostgresMigrator } from './postgres-migrator';
import { PostgresAdmissionQuarantineStore } from './postgres-admission-quarantine-store';
import { MAX_QUARANTINE_TTL_MS } from '../security/admission-quarantine';
import type { AdmissionQuarantine } from '../security/admission-quarantine';

const enabled = process.env['ZINESH_POSTGRES_TESTS'] === 'true';
const maybeDescribe = enabled ? describe : describe.skip;
const testSecret = (name: 'PG_PASSWORD_FILE' | 'PG_TLS_CA_PATH'): string => {
  if (!enabled) return 'postgres-tests-disabled';
  const filename = process.env[name];
  if (!filename) throw new Error(`${name} is required for PostgreSQL integration tests`);
  return fs.readFileSync(filename, 'utf8');
};
const config = {
  host: process.env['PGHOST'] ?? 'localhost', port: Number(process.env['PGPORT'] ?? 5432),
  database: process.env['PGDATABASE'] ?? 'zinesh_test', user: process.env['PGUSER'] ?? 'postgres',
  password: testSecret('PG_PASSWORD_FILE'),
  ssl: { ca: testSecret('PG_TLS_CA_PATH'), rejectUnauthorized: true },
};

maybeDescribe('V11 append-only admission quarantine memory', () => {
  let pool: Pool;
  let store: PostgresAdmissionQuarantineStore;
  let sequence = 0;

  beforeAll(async () => {
    pool = new Pool(config);
    await new PostgresMigrator(pool).migrate();
    store = new PostgresAdmissionQuarantineStore(pool);
  });
  afterAll(async () => { await pool.end(); });

  async function fixture(): Promise<AdmissionQuarantine> {
    sequence += 1;
    const principalId = `quarantine-principal-${process.pid}-${sequence}`;
    await pool.query(
      `INSERT INTO principals(principal_id,principal_type,actor_id,enabled,mapping_version)
       VALUES($1,'ACTOR',$2,TRUE,1)`, [principalId, `quarantine-actor-${process.pid}-${sequence}`],
    );
    return {
      quarantineId: `quarantine-${process.pid}-${sequence}`, principalId,
      reason: 'SECURITY_INCIDENT', issuedAt: 1_000, expiresAt: 61_000,
      issuedBy: 'security-operator', correlationId: `quarantine-correlation-${process.pid}-${sequence}`,
    };
  }

  test('issue, active lookup, explicit release and history survive as append-only records', async () => {
    const quarantine = await fixture();
    await expect(store.issue(quarantine)).resolves.toBe('ISSUED');
    await expect(store.findActive(quarantine.principalId, 999)).resolves.toBeNull();
    await expect(store.findActive(quarantine.principalId, 1_000)).resolves.toEqual(quarantine);
    await expect(store.findActive(quarantine.principalId, 61_000)).resolves.toBeNull();

    const release = {
      quarantineId: quarantine.quarantineId, releasedAt: 2_000,
      releasedBy: 'security-operator', correlationId: `release-${quarantine.correlationId}`,
    };
    await expect(store.release(release)).resolves.toBe('RELEASED');
    await expect(store.findActive(quarantine.principalId, 2_001)).resolves.toBeNull();
    expect((await pool.query('SELECT count(*)::int AS count FROM admission_quarantines WHERE quarantine_id=$1',
      [quarantine.quarantineId])).rows[0]).toEqual({ count: 1 });
    expect((await pool.query('SELECT count(*)::int AS count FROM admission_quarantine_releases WHERE quarantine_id=$1',
      [quarantine.quarantineId])).rows[0]).toEqual({ count: 1 });
  });

  test('issue and release are idempotent but conflicting reuse is rejected', async () => {
    const quarantine = await fixture();
    expect(await store.issue(quarantine)).toBe('ISSUED');
    expect(await store.issue({ ...quarantine, issuedAt: quarantine.issuedAt + 1 })).toBe('DUPLICATE');
    expect(await store.issue({ ...quarantine, expiresAt: quarantine.expiresAt + 1 })).toBe('CONFLICT');
    const release = { quarantineId: quarantine.quarantineId, releasedAt: 2_000,
      releasedBy: 'security-operator', correlationId: `release-${quarantine.correlationId}` };
    expect(await store.release(release)).toBe('RELEASED');
    expect(await store.release({ ...release, releasedAt: 2_001 })).toBe('DUPLICATE');
    expect(await store.release({ ...release, releasedBy: 'other-operator' })).toBe('CONFLICT');
  });

  test('bounded validation rejects unsafe identities, clocks and TTLs before persistence', async () => {
    const quarantine = await fixture();
    await expect(store.issue({ ...quarantine, quarantineId: 'unsafe id' })).resolves.toBe('INVALID');
    await expect(store.issue({ ...quarantine, expiresAt: quarantine.issuedAt + MAX_QUARANTINE_TTL_MS + 1 }))
      .resolves.toBe('INVALID');
    await expect(store.release({ quarantineId: 'missing', releasedAt: 1_000,
      releasedBy: 'security-operator', correlationId: 'missing-release' })).resolves.toBe('NOT_FOUND');
  });

  test('database rejects mutation and deletion of quarantine memory', async () => {
    const quarantine = await fixture();
    expect(await store.issue(quarantine)).toBe('ISSUED');
    await expect(pool.query('UPDATE admission_quarantines SET reason=$2 WHERE quarantine_id=$1',
      [quarantine.quarantineId, 'MANUAL_REVIEW'])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('DELETE FROM admission_quarantines WHERE quarantine_id=$1',
      [quarantine.quarantineId])).rejects.toMatchObject({ code: '23514' });
  });
});
