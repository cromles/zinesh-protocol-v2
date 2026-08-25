import { generateKeyPairSync, sign } from 'crypto';
import type { KeyObject } from 'crypto';
import { CommandHttpTransport } from './command-http-transport';
import type { TransportAuditRecord, TransportAuditSink } from './command-http-transport';
import { CachedJwksProvider, JwtAuthenticationAdapter } from '../security/jwt-authentication';
import { TrustedCommandIngress } from '../security/trusted-ingress';
import type { PrincipalRecord } from '../security/trusted-ingress';
import { CellApplication } from '../application/cell-application';
import { InMemoryPersistenceAdapter } from '../adapters/in-memory-persistence-adapter';
import { fixedClock } from '../application/clock';
import { createEventIdFactory } from '../application/event-id-factory';
import { cellKernel } from '../kernel';
import { makeActorId, makeTimestamp } from '../core/types';
import { SecurityTelemetry } from '../security/security-observability';
import type { SecurityEvent } from '../security/security-observability';

const ISSUER = 'https://transport-issuer.test';
const AUDIENCE = 'zinesh-transport';
const PAYER = makeActorId('transport-payer');
const PAYEE = makeActorId('transport-payee');

function pair(kid = 'transport-key') {
  const generated = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey: generated.privateKey,
    jwk: { ...generated.publicKey.export({ format: 'jwk' }), kid, kty: 'RSA', alg: 'RS256', use: 'sig' },
  };
}

function jwt(privateKey: KeyObject, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'transport-key', ...header })).toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify({
    iss: ISSUER, sub: 'payer-subject', aud: AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 300, ...claims,
  })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedClaims}`), privateKey).toString('base64url');
  return `${encodedHeader}.${encodedClaims}.${signature}`;
}

function command(commandId = 'transport-command', amount = '900719925474099312345') {
  return { commandId, cellId: `cell-${commandId}`, type: 'CreateCell', payload: {
    payer: PAYER, payee: PAYEE, amount, currency: 'TRY',
    fundingDeadline: 2_000_000, completionDeadline: 5_000_000,
  } };
}

class Audit implements TransportAuditSink {
  readonly entries: TransportAuditRecord[] = [];
  record(entry: TransportAuditRecord): void { this.entries.push(entry); }
}

interface Harness {
  readonly transport: CommandHttpTransport;
  readonly url: string;
  readonly token: string;
  readonly key: ReturnType<typeof pair>;
  readonly persistence: InMemoryPersistenceAdapter;
  readonly records: Map<string, PrincipalRecord>;
  readonly audit: Audit;
  readonly securityEvents: SecurityEvent[];
}

async function harness(options: { providerFailure?: boolean } = {}): Promise<Harness> {
  const key = pair();
  const authentication = new JwtAuthenticationAdapter(
    { issuers: [{ issuer: ISSUER, audiences: [AUDIENCE], algorithms: ['RS256'], jwksUrl: `${ISSUER}/jwks` }],
      clockSkewSeconds: 30, jwksCacheTtlMs: 60_000, jwksTimeoutMs: 20 },
    new CachedJwksProvider({ async fetch(_url, timeoutMs) {
      if (options.providerFailure) {
        await new Promise((resolve) => setTimeout(resolve, timeoutMs));
        throw new Error('provider timeout token=must-not-leak');
      }
      return { keys: [key.jwk] };
    } }, 60_000, 20),
  );
  const persistence = new InMemoryPersistenceAdapter();
  const app = new CellApplication({ persistence, kernel: cellKernel, clock: fixedClock(makeTimestamp(1_000_000)), eventIds: createEventIdFactory('http') });
  const records = new Map<string, PrincipalRecord>([
    ['payer-subject', { principalId: 'principal-payer', type: 'ACTOR', enabled: true,
      actorId: PAYER, capabilities: ['ACT_AS_SELF'], mappingVersion: 1 }],
    ['other-subject', { principalId: 'principal-other', type: 'ACTOR', enabled: true,
      actorId: PAYER, capabilities: ['ACT_AS_SELF'], mappingVersion: 1 }],
    ['gateway-subject', { principalId: 'principal-gateway', type: 'GATEWAY', enabled: true,
      capabilities: ['CONFIRM_FUNDING'], mappingVersion: 1 }],
  ]);
  const securityEvents: SecurityEvent[] = [];
  const telemetry = new SecurityTelemetry({
    instanceId: 'http-instance', log: { write(event) { securityEvents.push(event); } },
    metrics: { record() {} }, retention: { securityLogDays: 30, metricDays: 14, securityAuditDays: 365 },
  });
  const ingress = new TrustedCommandIngress(app, authentication, {
    async resolve(identity) { return identity.issuer === ISSUER ? records.get(identity.subject) ?? null : null; },
  }, { async verify(evidence, expected) { return { outcome: 'VERIFIED', context: {
    provider: evidence.provider, providerTransactionId: evidence.providerTransactionId, ...expected,
    confirmedAt: makeTimestamp(900_000), finality: 'SETTLED', evidenceDigest: 'b'.repeat(64),
    verifiedAt: makeTimestamp(950_000),
  } }; } }, undefined, telemetry, { async resolve() { return 'transport-custody'; } });
  const audit = new Audit();
  const transport = new CommandHttpTransport(
    { handleCommand: (request) => ingress.handle(request),
      handleFundingConfirmation: (request) => ingress.handleFundingConfirmation(request) },
    { host: '127.0.0.1', port: 0, maxBodyBytes: 2048, maxHeaderBytes: 4096,
      requestTimeoutMs: 2_000, headersTimeoutMs: 1_000 },
    audit, () => 'generated-correlation', undefined, undefined, undefined, telemetry,
  );
  await transport.listen();
  return { transport, url: `http://127.0.0.1:${transport.address()!.port}/commands`,
    token: jwt(key.privateKey), key, persistence, records, audit, securityEvents };
}

async function post(h: Harness, body: unknown, tokenValue = h.token, correlation?: string) {
  return postUrl(h, h.url, body, tokenValue, correlation);
}

async function postUrl(h: Harness, url: string, body: unknown, tokenValue = h.token, correlation?: string) {
  const response = await fetch(url, { method: 'POST', headers: {
    authorization: `Bearer ${tokenValue}`, 'content-type': 'application/json',
    ...(correlation === undefined ? {} : { 'x-correlation-id': correlation }),
  }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { response, json: await response.json() as Record<string, any> };
}

describe('Phase 7E real HTTP trusted command transport', () => {
  let open: CommandHttpTransport[] = [];
  afterEach(async () => { await Promise.all(open.map((transport) => transport.close())); open = []; });
  async function setup(options: { providerFailure?: boolean } = {}) { const h = await harness(options); open.push(h.transport); return h; }

  test('valid real credential executes command and preserves bigint precision', async () => {
    const h = await setup();
    const { response, json } = await post(h, { command: command() }, h.token, 'client-correlation-1');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-correlation-id')).toBe('generated-correlation');
    expect(response.headers.get('x-correlation-id')).not.toBe('client-correlation-1');
    expect(json.outcome).toBe('SUCCESS');
    expect(json.nextState.amount).toBe('900719925474099312345');
    expect((await h.persistence.eventStore.getEvents('cell-transport-command' as never))[0]?.payload).toMatchObject({ amount: 900719925474099312345n });
    expect(new Set(h.securityEvents.map((event) => event.correlationId))).toEqual(new Set(['generated-correlation']));
    expect(JSON.stringify(h.securityEvents)).not.toContain('client-correlation-1');
  });

  test('dedicated funding route verifies and funds while generic FundCell is blocked', async () => {
    const h = await setup();
    await post(h, { command: command('funding-route', '4200') });
    const gatewayToken = jwt(h.key.privateKey, { sub: 'gateway-subject' });
    const generic = await post(h, { command: { commandId: 'generic-fund', cellId: 'cell-funding-route',
      type: 'FundCell', payload: { funderId: PAYER, amount: '4200' } } }, gatewayToken);
    expect(generic.response.status).toBe(403);
    const dedicated = await postUrl(h, h.url.replace('/commands', '/funding-confirmations'), {
      commandId: 'dedicated-fund', cellId: 'cell-funding-route',
      evidence: { provider: 'test-provider', providerTransactionId: 'transport-provider-tx' },
    }, gatewayToken);
    expect(dedicated.response.status).toBe(200);
    expect(dedicated.json.outcome).toBe('SUCCESS');
    expect((await h.persistence.eventStore.getEvents('cell-funding-route' as never)).map((event) => event.type))
      .toEqual(['CellCreated', 'CellFunded']);
  });

  test('invalid credential, issuer, audience, unmapped and disabled principal fail closed', async () => {
    const h = await setup();
    expect((await post(h, { command: command('bad-signature') }, `${h.token.slice(0, -2)}xx`)).response.status).toBe(401);
    expect((await post(h, { command: command('issuer') }, jwt(h.key.privateKey, { iss: 'https://evil.test' }))).response.status).toBe(401);
    expect((await post(h, { command: command('aud') }, jwt(h.key.privateKey, { aud: 'other' }))).response.status).toBe(401);
    expect((await post(h, { command: command('unmapped') }, jwt(h.key.privateKey, { sub: 'missing' }))).response.status).toBe(403);
    h.records.set('payer-subject', { ...h.records.get('payer-subject')!, enabled: false });
    expect((await post(h, { command: command('disabled') })).response.status).toBe(403);
    expect(h.securityEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'AUTHENTICATION', reason: 'INVALID_SIGNATURE' }),
      expect.objectContaining({ category: 'AUTHENTICATION', reason: 'INVALID_ISSUER' }),
      expect.objectContaining({ category: 'AUTHENTICATION', reason: 'INVALID_AUDIENCE' }),
      expect.objectContaining({ category: 'PRINCIPAL', reason: 'PRINCIPAL_NOT_MAPPED' }),
      expect.objectContaining({ category: 'PRINCIPAL', reason: 'PRINCIPAL_DISABLED' }),
    ]));
  });

  test('payload security claims are rejected and actor impersonation cannot use correlation identity', async () => {
    const h = await setup();
    const securityFields = await post(h, { command: command('security-fields'), principalId: 'principal-payer', capability: 'ACT_AS_SELF' });
    expect(securityFields.response.status).toBe(400);
    const impersonation = command('impersonation');
    impersonation.payload.payer = 'different-actor' as never;
    expect((await post(h, { command: impersonation }, h.token, 'principal-payer')).response.status).toBe(403);
  });

  test('duplicate, changed payload, cross-principal and concurrent requests preserve Phase 7A semantics', async () => {
    const h = await setup();
    const original = { command: command('idem') };
    const first = await post(h, original);
    const replay = await post(h, original);
    expect(replay.json).toEqual(first.json);
    const changed = { command: command('idem', '10001') };
    expect((await post(h, changed)).response.status).toBe(409);
    expect((await post(h, original, jwt(h.key.privateKey, { sub: 'other-subject' }))).response.status).toBe(409);
    const concurrentBody = { command: command('concurrent') };
    const concurrent = await Promise.all([post(h, concurrentBody), post(h, concurrentBody)]);
    expect(concurrent.map((item) => item.response.status)).toEqual([200, 200]);
    expect(await h.persistence.eventStore.getEvents('cell-concurrent' as never)).toHaveLength(1);
  });

  test('malformed, oversized, missing commandId, unsupported command and media type are safely rejected', async () => {
    const h = await setup();
    expect((await post(h, '{')).response.status).toBe(400);
    expect((await post(h, { command: { ...command(), commandId: undefined } })).response.status).toBe(400);
    expect((await post(h, { command: { ...command(), type: 'DeleteEverything' } })).response.status).toBe(400);
    expect((await post(h, { padding: 'x'.repeat(3_000), command: command() })).response.status).toBe(413);
    const wrongType = await fetch(h.url, { method: 'POST', headers: { authorization: `Bearer ${h.token}`, 'content-type': 'text/plain' }, body: '{}' });
    expect(wrongType.status).toBe(415);
    expect(h.securityEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'INGRESS', reason: 'MALFORMED_JSON' }),
      expect.objectContaining({ category: 'INGRESS', reason: 'MISSING_COMMAND_ID' }),
      expect.objectContaining({ category: 'INGRESS', reason: 'UNSUPPORTED_COMMAND' }),
      expect.objectContaining({ category: 'INGRESS', reason: 'REQUEST_TOO_LARGE' }),
      expect.objectContaining({ category: 'INGRESS', reason: 'UNSUPPORTED_MEDIA_TYPE' }),
    ]));
    expect(JSON.stringify(h.securityEvents)).not.toContain('xxx');
  });

  test('provider timeout and internal failure return opaque errors without credential leakage', async () => {
    const timedOut = await setup({ providerFailure: true });
    const timeout = await post(timedOut, { command: command('timeout') });
    expect(timeout.response.status).toBe(401);
    expect(JSON.stringify(timeout.json)).not.toContain(timedOut.token);
    const auditDump = JSON.stringify(timedOut.audit.entries);
    expect(auditDump).not.toContain(timedOut.token);
    expect(auditDump).not.toContain('must-not-leak');
    expect(JSON.stringify(timedOut.securityEvents)).not.toContain(timedOut.token);
    expect(JSON.stringify(timedOut.securityEvents)).not.toContain('must-not-leak');
  });

  test('GET /live is unauthenticated, ignores Authorization, and is not a command audit', async () => {
    const h = await setup();
    const secret = `Bearer ${h.token}`;
    const response = await fetch(`http://127.0.0.1:${h.transport.address()!.port}/live`, {
      method: 'GET', headers: { authorization: secret },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(h.audit.entries).toEqual([]);
    expect(JSON.stringify(h.securityEvents)).not.toContain(h.token);
  });

  test('GET /ready is opaque and follows process probes without parsing Authorization', async () => {
    const audit = new Audit();
    let shuttingDown = false;
    let ready = true;
    const transport = new CommandHttpTransport(
      { async handleCommand() { throw new Error('commands must not run for probes'); } },
      { host: '127.0.0.1', port: 0, maxBodyBytes: 2048, maxHeaderBytes: 4096,
        requestTimeoutMs: 2_000, headersTimeoutMs: 1_000 },
      audit, () => 'probe-correlation', undefined, undefined, undefined, undefined,
      { shuttingDown: () => shuttingDown, readyCheck: async () => ready },
    );
    await transport.listen(); open.push(transport);
    const base = `http://127.0.0.1:${transport.address()!.port}`;
    const secret = 'Bearer probe-token-must-not-leak';
    const readyOk = await fetch(`${base}/ready`, { headers: { authorization: secret } });
    expect(readyOk.status).toBe(200);
    expect(await readyOk.json()).toEqual({ status: 'ok' });
    ready = false;
    const notReady = await fetch(`${base}/ready`);
    expect(notReady.status).toBe(503);
    expect(await notReady.text()).toBe('{"status":"unavailable"}');
    ready = true;
    shuttingDown = true;
    const draining = await fetch(`${base}/ready`);
    expect(draining.status).toBe(503);
    expect(await draining.json()).toEqual({ status: 'unavailable' });
    const live = await fetch(`${base}/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });
    expect(audit.entries).toEqual([]);
  });

  test('GET / and GET /ready with a query string remain NOT_FOUND', async () => {
    const h = await setup();
    const base = `http://127.0.0.1:${h.transport.address()!.port}`;
    const root = await fetch(base);
    expect(root.status).toBe(404);
    expect(await root.json()).toEqual({ error: { code: 'NOT_FOUND' } });
    const queried = await fetch(`${base}/ready?x=1`);
    expect(queried.status).toBe(404);
    expect(await queried.json()).toEqual({ error: { code: 'NOT_FOUND' } });
  });

  test('POST /commands during shutdown returns opaque 503 RUNTIME_UNAVAILABLE', async () => {
    const audit = new Audit();
    const transport = new CommandHttpTransport(
      { async handleCommand() {
        const error = new Error('Runtime is shutting down');
        error.name = 'RuntimeUnavailableError';
        throw error;
      } },
      { host: '127.0.0.1', port: 0, maxBodyBytes: 2048, maxHeaderBytes: 4096,
        requestTimeoutMs: 2_000, headersTimeoutMs: 1_000 }, audit,
    );
    await transport.listen(); open.push(transport);
    const response = await fetch(`http://127.0.0.1:${transport.address()!.port}/commands`, {
      method: 'POST', headers: { authorization: 'Bearer placeholder-token', 'content-type': 'application/json' },
      body: JSON.stringify({ command: command('draining') }),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":{"code":"RUNTIME_UNAVAILABLE"}}');
  });

  test('internal failure return opaque errors without credential leakage', async () => {
    const audit = new Audit();
    const broken = new CommandHttpTransport(
      { async handleCommand() { throw new Error('password=secret SQL SELECT /private/path'); } },
      { host: '127.0.0.1', port: 0, maxBodyBytes: 2048, maxHeaderBytes: 4096,
        requestTimeoutMs: 2_000, headersTimeoutMs: 1_000 }, audit,
    );
    await broken.listen(); open.push(broken);
    const response = await fetch(`http://127.0.0.1:${broken.address()!.port}/commands`, {
      method: 'POST', headers: { authorization: 'Bearer placeholder-token', 'content-type': 'application/json' },
      body: JSON.stringify({ command: command('internal') }),
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":{"code":"INTERNAL_FAILURE"}}');
  });
});
