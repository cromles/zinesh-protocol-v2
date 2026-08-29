import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import { Pool } from 'pg';
import { generateKeyPairSync, sign } from 'crypto';
import { PostgresMigrator, SchemaVersionError } from './postgres-migrator';
import { PostgresPrincipalAuthority } from './postgres-principal-authority';
import { makeActorId, makeTimestamp } from '../core/types';
import { makeAmount, makeCellId, makeCommandId } from '../core/types';
import type { CreatePrincipalInput } from '../security/principal-lifecycle';
import { CellApplication } from '../application/cell-application';
import { systemClock } from '../application/clock';
import { createEventIdFactory } from '../application/event-id-factory';
import { PostgresPersistenceAdapter } from './postgres-persistence-adapter';
import { cellKernel } from '../kernel';
import { TrustedCommandIngress, rejectAllFundingEvidence } from '../security/trusted-ingress';
import { CachedJwksProvider, JwtAuthenticationAdapter } from '../security/jwt-authentication';
import { composeRuntime } from '../composition/main';
import { CommandHttpsTransport } from '../transport/command-https-transport';
import { selfSignedTestCertificate } from '../transport/tls-test-certificate';
import { SecurityTelemetry } from '../security/security-observability';
import type { SecurityEvent } from '../security/security-observability';

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
  tls: { mode: 'verify-full' as const, ca: testSecret('PG_TLS_CA_PATH') },
  ssl: { ca: testSecret('PG_TLS_CA_PATH'), rejectUnauthorized: true },
};
const ACTOR = makeActorId('authority-actor');
const ACTOR_2 = makeActorId('authority-actor-2');
const context = (id: string) => ({ occurredAt: makeTimestamp(1_000_000), correlationId: id });

function actorInput(id: string, subject = id, actorId = ACTOR): CreatePrincipalInput {
  return {
    principalId: id, type: 'ACTOR', actorId, identity: { issuer: 'issuer-a', subject },
    capabilities: ['ACT_AS_SELF'], context: context(`corr-${id}`),
  };
}

maybeDescribe('Phase 7C PostgreSQL Principal Authority', () => {
  let pool: Pool;
  let authority: PostgresPrincipalAuthority;

  beforeAll(async () => {
    pool = new Pool(config);
    await new PostgresMigrator(pool).migrate();
    authority = new PostgresPrincipalAuthority(pool);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE principal_audit,principal_capabilities,external_identities,principals,events,snapshots,command_executions,rate_limit_windows CASCADE');
  });
  afterAll(async () => { await pool.end(); });

  test('creates and resolves durable ACTOR, GATEWAY and SYSTEM principals', async () => {
    expect((await authority.create(actorInput('actor-1'))).ok).toBe(true);
    expect((await authority.create({
      principalId: 'gateway-1', type: 'GATEWAY', identity: { issuer: 'gateway', subject: 'one' },
      capabilities: ['CONFIRM_FUNDING'], context: context('gateway-create'),
    })).ok).toBe(true);
    expect((await authority.create({
      principalId: 'system-1', type: 'SYSTEM', identity: { issuer: 'system', subject: 'one' },
      context: context('system-create'),
    })).ok).toBe(true);
    const resolved = await authority.resolve({ issuer: 'issuer-a', subject: 'actor-1' });
    expect(resolved).toMatchObject({ principalId: 'actor-1', type: 'ACTOR', actorId: ACTOR, enabled: true, mappingVersion: 1 });
  });

  test('rejects invalid type/ActorId shapes at authority and database levels', async () => {
    expect((await authority.create({
      principalId: 'missing', type: 'ACTOR', identity: { issuer: 'issuer-a', subject: 'missing' },
      context: context('missing'),
    })).ok).toBe(false);
    expect((await authority.create({ ...actorInput('bad-gateway'), type: 'GATEWAY' })).ok).toBe(false);
    await expect(pool.query(
      `INSERT INTO principals(principal_id,principal_type,actor_id,enabled,mapping_version)
       VALUES('db-bad','SYSTEM','actor',TRUE,1)`,
    )).rejects.toMatchObject({ code: '23514' });
  });

  test('enforces unique external identity and ActorId', async () => {
    expect((await authority.create(actorInput('first', 'shared'))).ok).toBe(true);
    expect(await authority.create(actorInput('second', 'shared', ACTOR_2))).toMatchObject({ ok: false, kind: 'CONFLICT' });
    expect(await authority.create(actorInput('third', 'other', ACTOR))).toMatchObject({ ok: false, kind: 'CONFLICT' });
  });

  test('database prevents silent principal type changes and identity rebinding', async () => {
    await authority.create(actorInput('immutable'));
    await expect(pool.query(
      `UPDATE principals SET principal_type='SYSTEM',actor_id=NULL WHERE principal_id='immutable'`,
    )).rejects.toMatchObject({ code: '23514' });
    await authority.create(actorInput('identity-target', 'identity-target', ACTOR_2));
    await expect(pool.query(
      `UPDATE external_identities SET principal_id='identity-target'
       WHERE issuer='issuer-a' AND subject='immutable'`,
    )).rejects.toMatchObject({ code: '23514' });
  });

  test('concurrent provisioning permits exactly one identity owner', async () => {
    const results = await Promise.all([
      authority.create(actorInput('race-a', 'race', ACTOR)),
      authority.create(actorInput('race-b', 'race', ACTOR_2)),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
  });

  test('enable/disable is optimistic, audited, and trusted ingress rejects disabled', async () => {
    await authority.create(actorInput('lifecycle'));
    const disabled = await authority.setEnabled('lifecycle', false, 1, context('disable'));
    expect(disabled).toMatchObject({ ok: true, principal: { enabled: false, mappingVersion: 2 } });
    expect(await authority.setEnabled('lifecycle', true, 1, context('stale-enable'))).toMatchObject({ ok: false, kind: 'CONFLICT' });

    const adapter = new PostgresPersistenceAdapter(config);
    const app = new CellApplication({ persistence: adapter, kernel: cellKernel, clock: systemClock(), eventIds: createEventIdFactory('authority') });
    const ingress = new TrustedCommandIngress(
      app, { async authenticate() { return { ok: true, identity: { issuer: 'issuer-a', subject: 'lifecycle' } }; } },
      authority, rejectAllFundingEvidence,
    );
    const result = await ingress.handle({ credential: 'rotated-credential', command: {
      commandId: 'disabled-command' as never, cellId: 'disabled-cell' as never, type: 'CreateCell',
      payload: { payer: ACTOR, payee: ACTOR_2, amount: 100n as never, currency: 'TRY',
        fundingDeadline: 2 as never, completionDeadline: 3 as never },
    } });
    expect(result.outcome).toBe('APPLICATION_REJECTION');
    if (result.outcome === 'APPLICATION_REJECTION') expect(result.error.code).toBe('PRINCIPAL_DISABLED');
  });

  test('concurrent enable/disable with same version has one winner', async () => {
    await authority.create(actorInput('state-race'));
    const results = await Promise.all([
      authority.setEnabled('state-race', false, 1, context('disable-race')),
      authority.setEnabled('state-race', true, 1, context('enable-race')),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  test('assigns/revokes valid capabilities and rejects wrong type, wildcard and impersonation', async () => {
    await authority.create({
      principalId: 'gateway-cap', type: 'GATEWAY', identity: { issuer: 'gateway', subject: 'cap' },
      context: context('gateway-cap-create'),
    });
    const assigned = await authority.assignCapability('gateway-cap', 'CONFIRM_FUNDING', 1, context('assign'));
    expect(assigned).toMatchObject({ ok: true, principal: { capabilities: ['CONFIRM_FUNDING'], mappingVersion: 2 } });
    const revoked = await authority.revokeCapability('gateway-cap', 'CONFIRM_FUNDING', 2, context('revoke'));
    expect(revoked).toMatchObject({ ok: true, principal: { capabilities: [], mappingVersion: 3 } });
    await authority.create(actorInput('actor-cap', 'actor-cap', ACTOR));
    expect(await authority.assignCapability('actor-cap', 'CONFIRM_FUNDING', 1, context('wrong'))).toMatchObject({ ok: false, kind: 'CONFLICT' });
    await expect(pool.query(
      `INSERT INTO principal_capabilities(principal_id,capability) VALUES('actor-cap','*')`,
    )).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(
      `INSERT INTO principal_capabilities(principal_id,capability) VALUES('actor-cap','IMPERSONATE_ANY_ACTOR')`,
    )).rejects.toMatchObject({ code: '23514' });
  });

  test('concurrent capability mutation and mapping updates cannot silently overwrite', async () => {
    await authority.create(actorInput('mutations'));
    const capabilities = await Promise.all([
      authority.revokeCapability('mutations', 'ACT_AS_SELF', 1, context('revoke-race')),
      authority.setActorMapping('mutations', ACTOR_2, 1, context('mapping-race')),
    ]);
    expect(capabilities.filter((result) => result.ok)).toHaveLength(1);
    expect((await authority.get('mutations'))?.mappingVersion).toBe(2);
  });

  test('mapping update increments version and unique ActorId prevents competing mappings', async () => {
    await authority.create(actorInput('map-a', 'map-a', ACTOR));
    await authority.create(actorInput('map-b', 'map-b', ACTOR_2));
    expect(await authority.setActorMapping('map-a', ACTOR_2, 1, context('map-conflict'))).toMatchObject({ ok: false, kind: 'CONFLICT' });
    const changed = await authority.setActorMapping('map-a', makeActorId('actor-new'), 1, context('map-change'));
    expect(changed).toMatchObject({ ok: true, principal: { mappingVersion: 2, actorId: 'actor-new' } });
  });

  test('credential rotation and process recreation preserve principalId', async () => {
    await authority.create(actorInput('stable', 'old-subject'));
    expect((await authority.attachIdentity('stable', { issuer: 'issuer-b', subject: 'new-subject' }, 1, context('rotate'))).ok).toBe(true);
    const recreated = new PostgresPrincipalAuthority(pool);
    expect(await recreated.resolve({ issuer: 'issuer-b', subject: 'new-subject' })).toMatchObject({ principalId: 'stable', mappingVersion: 2 });
  });

  test('mapping change does not reinterpret a PostgreSQL command execution', async () => {
    await authority.create(actorInput('history', 'history-subject'));
    const adapter = new PostgresPersistenceAdapter(config);
    const app = new CellApplication({ persistence: adapter, kernel: cellKernel,
      clock: systemClock(), eventIds: createEventIdFactory('history') });
    const ingress = new TrustedCommandIngress(
      app,
      { async authenticate() { return { ok: true, identity: { issuer: 'issuer-a', subject: 'history-subject' } }; } },
      authority, rejectAllFundingEvidence,
    );
    const cellId = makeCellId('history-cell');
    const command = {
      commandId: makeCommandId('history-command'), cellId, type: 'CreateCell' as const,
      payload: { payer: ACTOR, payee: ACTOR_2, amount: makeAmount(10000n), currency: 'TRY' as const,
        fundingDeadline: makeTimestamp(2_000_000), completionDeadline: makeTimestamp(5_000_000) },
    };
    expect((await ingress.handle({ credential: 'first', command })).outcome).toBe('SUCCESS');
    expect((await authority.setActorMapping('history', makeActorId('history-new-actor'), 1, context('history-map'))).ok).toBe(true);
    const denied = await ingress.handle({ credential: 'rotated', command });
    expect(denied.outcome).toBe('APPLICATION_REJECTION');
    if (denied.outcome === 'APPLICATION_REJECTION') expect(denied.error.code).toBe('ACTOR_MISMATCH');
    expect(await adapter.eventStore.getEvents(cellId)).toHaveLength(1);
    expect((await pool.query(`SELECT count(*)::int AS count FROM command_executions WHERE command_id='history-command'`)).rows[0]).toEqual({ count: 1 });
    await adapter.disconnect();
  });

  test('production composition accepts a real cryptographically verified subject', async () => {
    const issuer = 'https://phase7d.example.test';
    const audience = 'zinesh-phase7d';
    await authority.create({ ...actorInput('crypto-principal', 'crypto-subject'),
      identity: { issuer, subject: 'crypto-subject' } });
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'production-key', kty: 'RSA', alg: 'RS256', use: 'sig' };
    const authenticationConfig = {
      issuers: [{ issuer, audiences: [audience], algorithms: ['RS256' as const], jwksUrl: `${issuer}/jwks` }],
      clockSkewSeconds: 30, jwksCacheTtlMs: 60_000, jwksTimeoutMs: 1_000,
    };
    const authentication = new JwtAuthenticationAdapter(
      authenticationConfig,
      new CachedJwksProvider({ async fetch() { return { keys: [jwk] }; } }, 60_000, 1_000),
    );
    const runtime = composeRuntime(config, { authentication });
    await runtime.persistence.connect();
    try {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'production-key' })).toString('base64url');
      const claims = Buffer.from(JSON.stringify({
        iss: issuer, sub: 'crypto-subject', aud: audience,
        exp: Math.floor(Date.now() / 1000) + 300,
      })).toString('base64url');
      const signature = sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), pair.privateKey).toString('base64url');
      const result = await runtime.handleCommand({ credential: `${header}.${claims}.${signature}`, command: {
        commandId: makeCommandId('crypto-command'), cellId: makeCellId('crypto-cell'), type: 'CreateCell',
        payload: { payer: ACTOR, payee: ACTOR_2, amount: makeAmount(10000n), currency: 'TRY',
          fundingDeadline: makeTimestamp(2_000_000), completionDeadline: makeTimestamp(5_000_000) },
      } });
      expect(result.outcome).toBe('SUCCESS');
    } finally { await runtime.persistence.disconnect(); }
  });

  test('real HTTPS ingress preserves authentication, durable authority and PostgreSQL idempotency', async () => {
    const issuer = 'https://phase7e.example.test';
    const audience = 'zinesh-phase7e';
    await authority.create({ ...actorInput('http-principal', 'http-subject'),
      identity: { issuer, subject: 'http-subject' } });
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'http-key', kty: 'RSA', alg: 'RS256', use: 'sig' };
    const authentication = new JwtAuthenticationAdapter(
      { issuers: [{ issuer, audiences: [audience], algorithms: ['RS256'], jwksUrl: `${issuer}/jwks` }],
        clockSkewSeconds: 30, jwksCacheTtlMs: 60_000, jwksTimeoutMs: 1_000 },
      new CachedJwksProvider({ async fetch() { return { keys: [jwk] }; } }, 60_000, 1_000),
    );
    const runtime = composeRuntime(config, { authentication }, {
      preAuth: { limit: 10, windowMs: 60_000, retentionMs: 120_000, storageTimeoutMs: 2_000 },
      principal: { limit: 10, windowMs: 60_000, retentionMs: 120_000, storageTimeoutMs: 2_000 },
    });
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zinesh-7f-pg-'));
    const tls = selfSignedTestCertificate(new Date(Date.now() - 60_000), new Date(Date.now() + 60_000), 'api.zinesh.test');
    const certificatePath = path.join(directory, 'certificate.pem');
    const privateKeyPath = path.join(directory, 'private-key.pem');
    await Promise.all([
      fs.promises.writeFile(certificatePath, tls.certificate),
      fs.promises.writeFile(privateKeyPath, tls.privateKey, { mode: 0o600 }),
    ]);
    const transport = await CommandHttpsTransport.create(
      runtime,
      { host: '127.0.0.1', port: 0, maxBodyBytes: 4096, maxHeaderBytes: 8192,
        requestTimeoutMs: 2_000, headersTimeoutMs: 1_000, certificatePath, privateKeyPath,
        minimumTlsVersion: 'TLSv1.2', allowedHosts: ['api.zinesh.test'], trustedProxies: [] },
      { record() { /* Assertions use durable state; no test output. */ } }, undefined,
      runtime.preAuthenticationRateLimiter,
    );
    await runtime.persistence.connect();
    await transport.listen();
    try {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'http-key' })).toString('base64url');
      const claims = Buffer.from(JSON.stringify({
        iss: issuer, sub: 'http-subject', aud: audience,
        exp: Math.floor(Date.now() / 1000) + 300,
      })).toString('base64url');
      const signature = sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), pair.privateKey).toString('base64url');
      const token = `${header}.${claims}.${signature}`;
      const body = JSON.stringify({ command: {
        commandId: 'http-postgres-command', cellId: 'http-postgres-cell', type: 'CreateCell',
        payload: { payer: ACTOR, payee: ACTOR_2, amount: '900719925474099312345', currency: 'TRY',
          fundingDeadline: 2_000_000, completionDeadline: 5_000_000 },
      } });
      const invoke = async () => new Promise<{ status: number; value: { nextState: { amount: string } } }>((resolve, reject) => {
        const request = https.request({
          host: '127.0.0.1', port: transport.address()!.port, path: '/commands', method: 'POST',
          rejectUnauthorized: false, agent: false,
          headers: { host: 'api.zinesh.test', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0,
            value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as { nextState: { amount: string } } }));
        });
        request.once('error', reject); request.end(body);
      });
      const [first, concurrentReplay] = await Promise.all([invoke(), invoke()]);
      expect([first.status, concurrentReplay.status]).toEqual([200, 200]);
      const firstBody = first.value;
      const replayBody = concurrentReplay.value;
      expect(replayBody).toEqual(firstBody);
      expect(firstBody.nextState.amount).toBe('900719925474099312345');
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM events WHERE cell_id='http-postgres-cell'`,
      )).rows[0]).toEqual({ count: 1 });
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM command_executions WHERE command_id='http-postgres-command'`,
      )).rows[0]).toEqual({ count: 1 });
      expect((await pool.query(
        `SELECT category,request_count FROM rate_limit_windows ORDER BY category`,
      )).rows).toEqual([
        { category: 'PRE_AUTH', request_count: 2 },
        { category: 'PRINCIPAL', request_count: 2 },
      ]);
    } finally {
      await transport.close();
      await runtime.persistence.disconnect();
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });

  test('audit and authority tables contain metadata but no credential secrets', async () => {
    const secret = 'secret-access-token-never-store';
    await authority.create(actorInput('no-secret', 'subject-not-secret'));
    const dump = JSON.stringify((await pool.query(
      `SELECT p.*,e.issuer,e.subject,a.operation,a.correlation_id
       FROM principals p JOIN external_identities e USING(principal_id)
       JOIN principal_audit a USING(principal_id)`,
    )).rows);
    expect(dump).not.toContain(secret);
    const columns = (await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name IN ('principals','external_identities','principal_capabilities','principal_audit')`,
    )).rows.map((row) => row.column_name).join(' ');
    expect(columns).not.toMatch(/token|password|secret|private_key|authorization/i);
  });

  test('real PostgreSQL principal lifecycle audit and operational telemetry stay distinct and correlated', async () => {
    const events: SecurityEvent[] = [];
    const telemetry = new SecurityTelemetry({
      instanceId: 'postgres-instance', log: { write(event) { events.push(event); } },
      metrics: { record() {} }, retention: { securityLogDays: 30, metricDays: 14, securityAuditDays: 365 },
    });
    const observed = new PostgresPrincipalAuthority(pool, telemetry);
    expect((await observed.create(actorInput('observed-lifecycle'))).ok).toBe(true);
    expect((await observed.setEnabled('observed-lifecycle', false, 1, context('observed-disable'))).ok).toBe(true);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'PRINCIPAL', action: 'CREATE', outcome: 'SUCCESS',
        correlationId: 'corr-observed-lifecycle', principalId: 'observed-lifecycle' }),
      expect.objectContaining({ category: 'PRINCIPAL', action: 'DISABLE', outcome: 'SUCCESS',
        correlationId: 'observed-disable', principalId: 'observed-lifecycle' }),
    ]));
    expect((await pool.query(
      `SELECT operation,correlation_id FROM principal_audit
       WHERE principal_id='observed-lifecycle' ORDER BY audit_id`,
    )).rows).toEqual([
      { operation: 'CREATE', correlation_id: 'corr-observed-lifecycle' },
      { operation: 'DISABLE', correlation_id: 'observed-disable' },
    ]);
  });

  test('real PostgreSQL security-audit persistence failure rolls back lifecycle mutation and is observable', async () => {
    await authority.create(actorInput('audit-failure-rollback'));
    const events: SecurityEvent[] = [];
    const observed = new PostgresPrincipalAuthority(pool, new SecurityTelemetry({
      instanceId: 'postgres-instance', log: { write(event) { events.push(event); } },
      metrics: { record() {} }, retention: { securityLogDays: 30, metricDays: 14, securityAuditDays: 365 },
    }));
    try {
      await pool.query(`CREATE FUNCTION phase7h_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'principal audit unavailable'; END $$;
        CREATE TRIGGER phase7h_reject_audit BEFORE INSERT ON principal_audit
        FOR EACH ROW EXECUTE FUNCTION phase7h_reject_audit()`);
      await expect(observed.setEnabled('audit-failure-rollback', false, 1, context('audit-failed'))).rejects.toBeDefined();
      expect((await authority.get('audit-failure-rollback'))?.enabled).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({
        category: 'PRINCIPAL', action: 'DISABLE', outcome: 'DEPENDENCY_FAILURE',
        reason: 'POSTGRES_FAILURE', correlationId: 'audit-failed',
      }));
      expect(JSON.stringify(events)).not.toContain('principal audit unavailable');
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS phase7h_reject_audit ON principal_audit; DROP FUNCTION IF EXISTS phase7h_reject_audit()');
    }
  });
});

maybeDescribe('Phase 7C migrations', () => {
  const admin = new Pool(config);
  const names: string[] = [];
  async function database(prefix: string): Promise<{ name: string; pool: Pool }> {
    const name = `${prefix}_${process.pid}_${names.length}`.replace(/[^a-z0-9_]/g, '');
    names.push(name);
    await admin.query(`CREATE DATABASE ${name}`);
    return { name, pool: new Pool({ ...config, database: name }) };
  }
  afterAll(async () => {
    for (const name of names) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [name]);
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    }
    await admin.end();
  });

  test('fresh database migrates deterministically to expected version', async () => {
    const db = await database('zinesh_fresh');
    const migrator = new PostgresMigrator(db.pool);
    await migrator.migrate();
    await migrator.migrate();
    await expect(migrator.verifyExpectedVersion()).resolves.toBeUndefined();
    expect((await db.pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows)
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }]);
    await db.pool.end();
  });

  test('existing Phase 7A/7B schema upgrades without losing event data', async () => {
    const db = await database('zinesh_upgrade');
    const schema = fs.readFileSync(path.resolve(__dirname, 'postgres-schema.sql'), 'utf8');
    await db.pool.query(schema);
    await db.pool.query(`INSERT INTO events(event_id,cell_id,version,timestamp,type,payload)
      VALUES('existing-event','existing-cell',1,1,'CellCreated','{}')`);
    const migrator = new PostgresMigrator(db.pool);
    await migrator.migrate();
    await expect(migrator.verifyExpectedVersion()).resolves.toBeUndefined();
    expect((await db.pool.query('SELECT count(*)::int AS count FROM events')).rows[0]).toEqual({ count: 1 });
    await db.pool.end();
  });

  test('migration failure rolls back and wrong schema version fails closed', async () => {
    const db = await database('zinesh_failure');
    await db.pool.query(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TIMESTAMPTZ DEFAULT now());
      INSERT INTO schema_migrations(version,name) VALUES(1,'fake-core');
      CREATE TABLE principals(broken TEXT);`);
    await expect(new PostgresMigrator(db.pool).migrate()).rejects.toBeDefined();
    expect((await db.pool.query('SELECT version FROM schema_migrations')).rows).toEqual([{ version: 1 }]);
    await expect(new PostgresMigrator(db.pool).verifyExpectedVersion()).rejects.toBeInstanceOf(SchemaVersionError);
    await db.pool.end();
  });
});
