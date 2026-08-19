import { generateKeyPairSync, sign } from 'crypto';
import type { KeyObject } from 'crypto';
import {
  CachedJwksProvider, JwtAuthenticationAdapter,
} from './jwt-authentication';
import type {
  Jwk, JwksDocument, JwksFetcher, JwtAuthenticationConfig,
} from './jwt-authentication';
import { CellApplication } from '../application/cell-application';
import { InMemoryPersistenceAdapter } from '../adapters/in-memory-persistence-adapter';
import { fixedClock } from '../application/clock';
import { createEventIdFactory } from '../application/event-id-factory';
import { cellKernel } from '../kernel';
import { TrustedCommandIngress, rejectAllFundingEvidence } from './trusted-ingress';
import { makeActorId, makeAmount, makeCellId, makeCommandId, makeTimestamp } from '../core/types';

const ISSUER = 'https://issuer.example.test';
const AUDIENCE = 'zinesh-test';
const NOW = 1_000;

function keys(kid: string): { privateKey: KeyObject; jwk: Jwk } {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const exported = pair.publicKey.export({ format: 'jwk' });
  return { privateKey: pair.privateKey, jwk: { ...exported, kid, kty: 'RSA', alg: 'RS256', use: 'sig' } };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(
  privateKey: KeyObject,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
): string {
  const encodedHeader = encode({ alg: 'RS256', kid: 'key-1', typ: 'JWT', ...header });
  const encodedClaims = encode({ iss: ISSUER, sub: 'subject-1', aud: AUDIENCE, exp: NOW + 100, nbf: NOW - 10, ...claims });
  const signature = sign('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedClaims}`), privateKey).toString('base64url');
  return `${encodedHeader}.${encodedClaims}.${signature}`;
}

class ControlledFetcher implements JwksFetcher {
  document: JwksDocument;
  failure = false;
  calls = 0;
  constructor(document: JwksDocument) { this.document = document; }
  async fetch(url: string): Promise<JwksDocument> {
    this.calls += 1;
    expect(url).toBe(`${ISSUER}/jwks`);
    if (this.failure) throw new Error('provider unavailable');
    return this.document;
  }
}

function config(overrides: Partial<JwtAuthenticationConfig> = {}): JwtAuthenticationConfig {
  return {
    issuers: [{ issuer: ISSUER, audiences: [AUDIENCE], algorithms: ['RS256'], jwksUrl: `${ISSUER}/jwks` }],
    clockSkewSeconds: 30, jwksCacheTtlMs: 1_000, jwksTimeoutMs: 100, ...overrides,
  };
}

function adapter(fetcher: ControlledFetcher, nowMs = () => NOW * 1000) {
  const provider = new CachedJwksProvider(fetcher, 1_000, 100, nowMs);
  return { provider, authentication: new JwtAuthenticationAdapter(config(), provider, () => NOW) };
}

describe('Phase 7D production JWT authentication trust anchor', () => {
  test('performs real RS256 verification and returns only issuer + subject', async () => {
    const key = keys('key-1');
    const authentication = adapter(new ControlledFetcher({ keys: [key.jwk] })).authentication;
    await expect(authentication.authenticate(token(key.privateKey))).resolves.toEqual({
      ok: true, identity: { issuer: ISSUER, subject: 'subject-1' },
    });
  });

  test('rejects fake issuer and audience before authentication succeeds', async () => {
    const key = keys('key-1');
    const authentication = adapter(new ControlledFetcher({ keys: [key.jwk] })).authentication;
    expect(await authentication.authenticate(token(key.privateKey, { iss: 'https://evil.test' }))).toEqual({ ok: false });
    expect(await authentication.authenticate(token(key.privateKey, { aud: 'different-app' }))).toEqual({ ok: false });
  });

  test('rejects invalid signature and manipulated payload', async () => {
    const trusted = keys('key-1');
    const attacker = keys('attacker');
    const authentication = adapter(new ControlledFetcher({ keys: [trusted.jwk] })).authentication;
    expect(await authentication.authenticate(token(attacker.privateKey))).toEqual({ ok: false });
    const valid = token(trusted.privateKey).split('.');
    valid[1] = encode({ iss: ISSUER, sub: 'attacker', aud: AUDIENCE, exp: NOW + 100 });
    expect(await authentication.authenticate(valid.join('.'))).toEqual({ ok: false });
  });

  test('rejects unsupported algorithm and algorithm confusion/downgrade', async () => {
    const key = keys('key-1');
    const authentication = adapter(new ControlledFetcher({ keys: [key.jwk] })).authentication;
    expect(await authentication.authenticate(token(key.privateKey, {}, { alg: 'none' }))).toEqual({ ok: false });
    expect(await authentication.authenticate(token(key.privateKey, {}, { alg: 'HS256' }))).toEqual({ ok: false });
  });

  test('enforces expiry, not-before and exact clock-skew boundaries', async () => {
    const key = keys('key-1');
    const authentication = adapter(new ControlledFetcher({ keys: [key.jwk] })).authentication;
    expect(await authentication.authenticate(token(key.privateKey, { exp: NOW - 31 }))).toEqual({ ok: false });
    expect((await authentication.authenticate(token(key.privateKey, { exp: NOW - 29 }))).ok).toBe(true);
    expect(await authentication.authenticate(token(key.privateKey, { nbf: NOW + 31 }))).toEqual({ ok: false });
    expect((await authentication.authenticate(token(key.privateKey, { nbf: NOW + 30 }))).ok).toBe(true);
  });

  test('rejects malformed, oversized, unknown-key and wrong-key-type credentials', async () => {
    const key = keys('key-1');
    const fetcher = new ControlledFetcher({ keys: [key.jwk] });
    const authentication = adapter(fetcher).authentication;
    expect(await authentication.authenticate('not-a-jwt')).toEqual({ ok: false });
    expect(await authentication.authenticate('x'.repeat(20_000))).toEqual({ ok: false });
    expect(await authentication.authenticate(token(key.privateKey, {}, { kid: 'unknown' }))).toEqual({ ok: false });
    fetcher.document = { keys: [{ kid: 'key-1', kty: 'oct', k: 'c2VjcmV0', alg: 'RS256' }] };
    const wrongType = adapter(fetcher).authentication;
    expect(await wrongType.authenticate(token(key.privateKey))).toEqual({ ok: false });
  });

  test('supports real key rotation and bounds unknown-kid refresh storms', async () => {
    let nowMs = NOW * 1000;
    const first = keys('key-1');
    const second = keys('key-2');
    const fetcher = new ControlledFetcher({ keys: [first.jwk] });
    const { authentication } = adapter(fetcher, () => nowMs);
    expect((await authentication.authenticate(token(first.privateKey))).ok).toBe(true);
    fetcher.document = { keys: [first.jwk, second.jwk] };
    expect((await authentication.authenticate(token(second.privateKey, {}, { kid: 'key-2' }))).ok).toBe(true);
    const callsAfterRotation = fetcher.calls;
    expect(await authentication.authenticate(token(second.privateKey, {}, { kid: 'unknown-a' }))).toEqual({ ok: false });
    expect(await authentication.authenticate(token(second.privateKey, {}, { kid: 'unknown-b' }))).toEqual({ ok: false });
    expect(fetcher.calls - callsAfterRotation).toBeLessThanOrEqual(1);
    nowMs += 5_001;
  });

  test('provider failure and expired JWKS cache fail closed', async () => {
    let nowMs = NOW * 1000;
    const key = keys('key-1');
    const fetcher = new ControlledFetcher({ keys: [key.jwk] });
    const { authentication } = adapter(fetcher, () => nowMs);
    expect((await authentication.authenticate(token(key.privateKey))).ok).toBe(true);
    nowMs += 1_001;
    fetcher.failure = true;
    expect(await authentication.authenticate(token(key.privateKey))).toEqual({ ok: false });
  });

  test('credential replay and rotation preserve the stable principal and idempotent result', async () => {
    const key = keys('key-1');
    const authentication = adapter(new ControlledFetcher({ keys: [key.jwk] })).authentication;
    const persistence = new InMemoryPersistenceAdapter();
    const app = new CellApplication({ persistence, kernel: cellKernel, clock: fixedClock(makeTimestamp(1_000_000)), eventIds: createEventIdFactory('jwt') });
    const actorId = makeActorId('jwt-actor');
    const authority = { async resolve(identity: { issuer: string; subject: string }) {
      return identity.issuer === ISSUER && identity.subject === 'subject-1' ? {
        principalId: 'stable-principal', type: 'ACTOR' as const, enabled: true, actorId,
        capabilities: ['ACT_AS_SELF' as const], mappingVersion: 1,
      } : null;
    } };
    const ingress = new TrustedCommandIngress(app, authentication, authority, rejectAllFundingEvidence);
    const command = {
      commandId: makeCommandId('jwt-command'), cellId: makeCellId('jwt-cell'), type: 'CreateCell' as const,
      payload: { payer: actorId, payee: makeActorId('jwt-payee'), amount: makeAmount(10000n), currency: 'TRY' as const,
        fundingDeadline: makeTimestamp(2_000_000), completionDeadline: makeTimestamp(5_000_000) },
    };
    const first = await ingress.handle({ credential: token(key.privateKey, { jti: 'token-a' }), command });
    const replay = await ingress.handle({ credential: token(key.privateKey, { jti: 'token-b' }), command });
    expect(first.outcome).toBe('SUCCESS');
    expect(replay).toEqual(first);
    expect(await persistence.eventStore.getEvents(command.cellId)).toHaveLength(1);
    const serialized = JSON.stringify(await persistence.eventStore.getEvents(command.cellId), (_k, value) => typeof value === 'bigint' ? value.toString() : value);
    expect(serialized).not.toContain('token-a');
    expect(serialized).not.toContain('token-b');
  });

  test('valid credential still rejects unmapped and disabled principals', async () => {
    const key = keys('key-1');
    const authentication = adapter(new ControlledFetcher({ keys: [key.jwk] })).authentication;
    const app = new CellApplication({ persistence: new InMemoryPersistenceAdapter(), kernel: cellKernel,
      clock: fixedClock(makeTimestamp(1)), eventIds: createEventIdFactory('disabled') });
    const command = { commandId: makeCommandId('x'), cellId: makeCellId('x'), type: 'CreateCell' as const,
      payload: { payer: makeActorId('a'), payee: makeActorId('b'), amount: makeAmount(1n), currency: 'TRY' as const,
        fundingDeadline: makeTimestamp(2), completionDeadline: makeTimestamp(3) } };
    const unmapped = new TrustedCommandIngress(app, authentication, { async resolve() { return null; } }, rejectAllFundingEvidence);
    const unmappedResult = await unmapped.handle({ credential: token(key.privateKey), command });
    expect(unmappedResult.outcome).toBe('APPLICATION_REJECTION');
    const disabled = new TrustedCommandIngress(app, authentication, { async resolve() { return {
      principalId: 'disabled', type: 'ACTOR' as const, enabled: false, actorId: makeActorId('a'),
      capabilities: ['ACT_AS_SELF' as const], mappingVersion: 1,
    }; } }, rejectAllFundingEvidence);
    const disabledResult = await disabled.handle({ credential: token(key.privateKey), command });
    expect(disabledResult.outcome).toBe('APPLICATION_REJECTION');
    if (disabledResult.outcome === 'APPLICATION_REJECTION') expect(disabledResult.error.code).toBe('PRINCIPAL_DISABLED');
  });
});
