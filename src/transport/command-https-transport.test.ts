import { generateKeyPairSync, sign } from 'crypto';
import type { KeyObject } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import { CommandHttpsTransport, TlsConfigurationError } from './command-https-transport';
import type { CommandHttpsConfig } from './command-https-transport';
import type { TransportAuditRecord, TransportAuditSink } from './command-http-transport';
import { CachedJwksProvider, JwtAuthenticationAdapter } from '../security/jwt-authentication';
import { TrustedCommandIngress, rejectAllFundingEvidence } from '../security/trusted-ingress';
import { CellApplication } from '../application/cell-application';
import { InMemoryPersistenceAdapter } from '../adapters/in-memory-persistence-adapter';
import { fixedClock } from '../application/clock';
import { createEventIdFactory } from '../application/event-id-factory';
import { cellKernel } from '../kernel';
import { makeActorId, makeTimestamp } from '../core/types';
import { selfSignedTestCertificate } from './tls-test-certificate';

const ISSUER = 'https://phase7f-issuer.test';
const AUDIENCE = 'zinesh-phase7f';
const HOST = 'api.zinesh.test';
const PAYER = makeActorId('https-payer');
const PAYEE = makeActorId('https-payee');

class Audit implements TransportAuditSink {
  readonly entries: TransportAuditRecord[] = [];
  record(entry: TransportAuditRecord): void { this.entries.push(entry); }
}

interface Harness {
  readonly transport: CommandHttpsTransport;
  readonly port: number;
  readonly token: string;
  readonly audit: Audit;
  readonly directory: string;
  readonly persistence: InMemoryPersistenceAdapter;
}

const open: Harness[] = [];

function jwt(privateKey: KeyObject): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'auth-key' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iss: ISSUER, sub: 'https-subject', aud: AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 300,
  })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), privateKey).toString('base64url');
  return `${header}.${claims}.${signature}`;
}

async function harness(trustedProxies: readonly string[] = []): Promise<Harness> {
  const directory = await mkdtemp(path.join(tmpdir(), 'zinesh-7f-'));
  const tls = selfSignedTestCertificate(new Date(Date.now() - 60_000), new Date(Date.now() + 86_400_000), HOST);
  const certificatePath = path.join(directory, 'certificate.pem');
  const privateKeyPath = path.join(directory, 'private-key.pem');
  await Promise.all([writeFile(certificatePath, tls.certificate), writeFile(privateKeyPath, tls.privateKey, { mode: 0o600 })]);
  const authPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...authPair.publicKey.export({ format: 'jwk' }), kid: 'auth-key', kty: 'RSA', alg: 'RS256', use: 'sig' };
  const authentication = new JwtAuthenticationAdapter(
    { issuers: [{ issuer: ISSUER, audiences: [AUDIENCE], algorithms: ['RS256'], jwksUrl: `${ISSUER}/jwks` }],
      clockSkewSeconds: 30, jwksCacheTtlMs: 60_000, jwksTimeoutMs: 1_000 },
    new CachedJwksProvider({ async fetch() { return { keys: [jwk] }; } }, 60_000, 1_000),
  );
  const persistence = new InMemoryPersistenceAdapter();
  const application = new CellApplication({
    persistence, kernel: cellKernel, clock: fixedClock(makeTimestamp(1_000_000)),
    eventIds: createEventIdFactory('https'),
  });
  const ingress = new TrustedCommandIngress(application, authentication, {
    async resolve(identity) {
      return identity.issuer === ISSUER && identity.subject === 'https-subject'
        ? { principalId: 'https-principal', type: 'ACTOR' as const, enabled: true,
          actorId: PAYER, capabilities: ['ACT_AS_SELF' as const], mappingVersion: 1 }
        : null;
    },
  }, rejectAllFundingEvidence);
  const audit = new Audit();
  const transport = await CommandHttpsTransport.create(
    { handleCommand: (request) => ingress.handle(request) },
    config(certificatePath, privateKeyPath, trustedProxies), audit,
  );
  await transport.listen();
  const result = { transport, port: transport.address()!.port, token: jwt(authPair.privateKey),
    audit, directory, persistence };
  open.push(result);
  return result;
}

function config(certificatePath: string, privateKeyPath: string, trustedProxies: readonly string[] = []): CommandHttpsConfig {
  return {
    host: '127.0.0.1', port: 0, maxBodyBytes: 4096, maxHeaderBytes: 8192,
    requestTimeoutMs: 2_000, headersTimeoutMs: 1_000,
    certificatePath, privateKeyPath, minimumTlsVersion: 'TLSv1.2',
    allowedHosts: [HOST], trustedProxies,
  };
}

function command(commandId = 'https-command') {
  return { command: {
    commandId, cellId: `cell-${commandId}`, type: 'CreateCell', payload: {
      payer: PAYER, payee: PAYEE, amount: '900719925474099312345', currency: 'TRY',
      fundingDeadline: 2_000_000, completionDeadline: 5_000_000,
    },
  } };
}

async function post(h: Harness, body: unknown = command(), extraHeaders: Record<string, string> = {}) {
  return new Promise<{ readonly status: number; readonly json: Record<string, unknown> }>((resolve, reject) => {
    const request = https.request({
      host: '127.0.0.1', port: h.port, path: '/commands', method: 'POST',
      rejectUnauthorized: false, agent: false,
      headers: { host: HOST, authorization: `Bearer ${h.token}`, 'content-type': 'application/json', ...extraHeaders },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0,
        json: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }));
    });
    request.once('error', reject);
    request.end(JSON.stringify(body));
  });
}

async function plaintextRejected(h: Harness, headers: Record<string, string> = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1', port: h.port, path: '/commands', method: 'POST',
      headers: { host: HOST, authorization: `Bearer ${h.token}`, 'content-type': 'application/json', ...headers },
    }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode !== 200)); });
    request.once('error', () => resolve(true));
    request.end(JSON.stringify(command('plaintext')));
  });
}

describe('Phase 7F real TLS public ingress', () => {
  afterEach(async () => {
    while (open.length > 0) {
      const item = open.pop()!;
      await item.transport.close();
      await rm(item.directory, { recursive: true, force: true });
    }
  });

  test('real HTTPS handshake executes an authenticated command and preserves bigint', async () => {
    const h = await harness();
    const response = await post(h);
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ outcome: 'SUCCESS', nextState: { amount: '900719925474099312345' } });
    expect(await h.persistence.eventStore.getEvents('cell-https-command' as never)).toHaveLength(1);
  });

  test('plaintext and a plaintext X-Forwarded-Proto spoof cannot reach the command endpoint', async () => {
    const h = await harness(['127.0.0.1']);
    await expect(plaintextRejected(h)).resolves.toBe(true);
    await expect(plaintextRejected(h, { 'x-forwarded-proto': 'https' })).resolves.toBe(true);
  });

  test.each([
    { forwarded: 'for=203.0.113.5;proto=https' },
    { 'x-forwarded-for': '203.0.113.5' },
    { 'x-forwarded-host': HOST },
    { 'x-forwarded-proto': 'https' },
    { 'x-real-ip': '203.0.113.5' },
  ])('untrusted clients cannot supply forwarding metadata: %p', async (headers) => {
    const h = await harness();
    expect((await post(h, command(`spoof-${Object.keys(headers)[0]}`), headers)).status).toBe(403);
  });

  test('explicit trusted single-hop proxy metadata is accepted and malformed chains are rejected', async () => {
    const h = await harness(['127.0.0.1']);
    const accepted = await post(h, command('trusted-proxy'), {
      forwarded: `for=203.0.113.5;proto=https;host=${HOST}`,
      'x-forwarded-for': '203.0.113.5', 'x-real-ip': '203.0.113.5',
      'x-forwarded-proto': 'https', 'x-forwarded-host': HOST,
    });
    expect(accepted.status).toBe(200);
    expect((await post(h, command('bad-chain'), { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' })).status).toBe(403);
    expect((await post(h, command('bad-proto'), { 'x-forwarded-proto': 'http' })).status).toBe(403);
    expect((await post(h, command('bad-forward-host'), { 'x-forwarded-host': 'evil.example' })).status).toBe(403);
  });

  test('proxy trust configuration change is effective and unknown proxy fails closed', async () => {
    const unknown = await harness(['127.0.0.2']);
    expect((await post(unknown, command('unknown-proxy'), { 'x-forwarded-proto': 'https' })).status).toBe(403);
    const trusted = await harness(['127.0.0.1']);
    expect((await post(trusted, command('known-proxy'), { 'x-forwarded-proto': 'https' })).status).toBe(200);
  });

  test('arbitrary Host cannot influence command routing', async () => {
    const h = await harness();
    expect((await post(h, command('host-abuse'), { host: 'evil.example' })).status).toBe(421);
  });

  test('missing, expired, malformed and mismatched certificate material fail closed', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'zinesh-7f-invalid-'));
    try {
      const valid = selfSignedTestCertificate(new Date(Date.now() - 60_000), new Date(Date.now() + 60_000), HOST);
      const other = selfSignedTestCertificate(new Date(Date.now() - 60_000), new Date(Date.now() + 60_000), HOST);
      const expired = selfSignedTestCertificate(new Date(Date.now() - 120_000), new Date(Date.now() - 60_000), HOST);
      const cert = path.join(directory, 'cert.pem');
      const key = path.join(directory, 'key.pem');
      await writeFile(cert, valid.certificate); await writeFile(key, valid.privateKey, { mode: 0o600 });
      await expect(CommandHttpsTransport.create({ handleCommand: async () => { throw new Error(); } },
        config(path.join(directory, 'missing.pem'), key))).rejects.toBeInstanceOf(TlsConfigurationError);
      await writeFile(cert, expired.certificate); await writeFile(key, expired.privateKey);
      await expect(CommandHttpsTransport.create({ handleCommand: async () => { throw new Error(); } },
        config(cert, key), undefined, new Date())).rejects.toBeInstanceOf(TlsConfigurationError);
      await writeFile(cert, valid.certificate); await writeFile(key, other.privateKey);
      await expect(CommandHttpsTransport.create({ handleCommand: async () => { throw new Error(); } },
        config(cert, key))).rejects.toBeInstanceOf(TlsConfigurationError);
      await writeFile(cert, 'not a certificate'); await writeFile(key, valid.privateKey);
      await expect(CommandHttpsTransport.create({ handleCommand: async () => { throw new Error(); } },
        config(cert, key))).rejects.toBeInstanceOf(TlsConfigurationError);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test('credential and private material never enter audit or error responses', async () => {
    const h = await harness();
    const rejected = await post(h, command('credential-safe'), { host: 'evil.example' });
    const dump = JSON.stringify({ response: rejected.json, audit: h.audit.entries });
    expect(dump).not.toContain(h.token);
    const privateMaterial = await import('fs/promises').then((fs) => fs.readFile(path.join(h.directory, 'private-key.pem'), 'utf8'));
    expect(dump).not.toContain(privateMaterial);
  });
});
