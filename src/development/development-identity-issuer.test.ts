import { generateKeyPairSync, sign } from 'crypto';
import { CachedJwksProvider, JwtAuthenticationAdapter } from '../security/jwt-authentication';
import { loadAuthenticationConfig } from '../composition/main';
import {
  DEVELOPMENT_IDENTITY_AUDIENCE,
  DEVELOPMENT_IDENTITY_ISSUER,
  DEVELOPMENT_IDENTITY_JWKS_URL,
  DEVELOPMENT_IDENTITY_TTL_SECONDS,
  DevelopmentIdentityIssuer,
} from './development-identity-issuer';

function parts(token: string): [string, string, string] {
  const result = token.split('.');
  if (result.length !== 3) throw new Error('Unexpected JWT shape');
  return [result[0]!, result[1]!, result[2]!];
}

function decode(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function verifier(issuer: DevelopmentIdentityIssuer, now: () => number = () => 1_000) {
  const config = issuer.authenticationConfig();
  return new JwtAuthenticationAdapter(config,
    new CachedJwksProvider(issuer, config.jwksCacheTtlMs, config.jwksTimeoutMs, () => now() * 1000), now);
}

describe('development-only identity issuer', () => {
  test('issues distinct PAYER and PAYEE subjects without actor authorization claims', async () => {
    const issuer = new DevelopmentIdentityIssuer(() => 1_000);
    const payerToken = issuer.issue('PAYER');
    const payeeToken = issuer.issue('PAYEE');
    const payerClaims = decode(parts(payerToken)[1]);
    const payeeClaims = decode(parts(payeeToken)[1]);

    expect(payerClaims).toEqual({ iss: DEVELOPMENT_IDENTITY_ISSUER, sub: 'development-payer',
      aud: DEVELOPMENT_IDENTITY_AUDIENCE, nbf: 1_000, exp: 1_000 + DEVELOPMENT_IDENTITY_TTL_SECONDS });
    expect(payeeClaims).toEqual({ iss: DEVELOPMENT_IDENTITY_ISSUER, sub: 'development-payee',
      aud: DEVELOPMENT_IDENTITY_AUDIENCE, nbf: 1_000, exp: 1_000 + DEVELOPMENT_IDENTITY_TTL_SECONDS });
    expect(payerClaims).not.toHaveProperty('actorId');
    expect(payerClaims).not.toHaveProperty('role');
    expect(await verifier(issuer).authenticate(payerToken)).toEqual({ ok: true,
      identity: { issuer: DEVELOPMENT_IDENTITY_ISSUER, subject: 'development-payer' } });
    expect(await verifier(issuer).authenticate(payeeToken)).toEqual({ ok: true,
      identity: { issuer: DEVELOPMENT_IDENTITY_ISSUER, subject: 'development-payee' } });
  });

  test('rejects a token whose issuer claim is not the configured development issuer', async () => {
    const issuer = new DevelopmentIdentityIssuer(() => 1_000);
    const [header, claimsPart] = parts(issuer.issue('PAYER'));
    const claims = { ...decode(claimsPart), iss: 'https://untrusted.invalid' };
    await expect(verifier(issuer).authenticate(`${header}.${encode(claims)}.invalid`))
      .resolves.toEqual({ ok: false, reason: 'INVALID_ISSUER' });
  });

  test('rejects a token whose audience does not match the configured audience', async () => {
    const issuer = new DevelopmentIdentityIssuer(() => 1_000);
    const [header, claimsPart] = parts(issuer.issue('PAYEE'));
    const claims = { ...decode(claimsPart), aud: 'another-application' };
    await expect(verifier(issuer).authenticate(`${header}.${encode(claims)}.invalid`))
      .resolves.toEqual({ ok: false, reason: 'INVALID_AUDIENCE' });
  });

  test('rejects a tampered signature', async () => {
    const issuer = new DevelopmentIdentityIssuer(() => 1_000);
    const [header, claims, signature] = parts(issuer.issue('PAYER'));
    const replacement = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    await expect(verifier(issuer).authenticate(`${header}.${claims}.${replacement}`))
      .resolves.toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
  });

  test('rejects an expired token', async () => {
    const issuer = new DevelopmentIdentityIssuer(() => 1_000);
    const expiredVerifier = verifier(issuer, () => 1_001 + DEVELOPMENT_IDENTITY_TTL_SECONDS);
    await expect(expiredVerifier.authenticate(issuer.issue('PAYEE')))
      .resolves.toEqual({ ok: false, reason: 'EXPIRED_CREDENTIAL' });
  });

  test('serves only its public key through the exact development JWKS URL', async () => {
    const issuer = new DevelopmentIdentityIssuer(() => 1_000);
    const jwks = await issuer.fetch(DEVELOPMENT_IDENTITY_JWKS_URL, 100);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig', key_ops: ['verify'] });
    expect(jwks.keys[0]).not.toHaveProperty('d');
    await expect(issuer.fetch('https://other.invalid/jwks', 100)).rejects.toThrow();
  });

  test('does not add the development issuer to production authentication configuration', () => {
    const development = new DevelopmentIdentityIssuer(() => 1_000);
    const devConfig = development.authenticationConfig();
    expect(devConfig.issuers).toHaveLength(1);
    expect(devConfig.issuers[0]?.issuer).toBe(DEVELOPMENT_IDENTITY_ISSUER);
    expect(devConfig.issuers[0]?.jwksUrl).toBe(DEVELOPMENT_IDENTITY_JWKS_URL);
    expect(devConfig.issuers[0]?.audiences).toEqual([DEVELOPMENT_IDENTITY_AUDIENCE]);

    const productionConfig = loadAuthenticationConfig({
      AUTH_TRUSTED_ISSUER: 'https://identity.example.test',
      AUTH_TRUSTED_AUDIENCE: 'zinesh-production',
      AUTH_JWKS_URL: 'https://identity.example.test/.well-known/jwks.json',
      AUTH_ALLOWED_ALGORITHM: 'RS256',
      AUTH_CLOCK_SKEW_SECONDS: '30',
      AUTH_JWKS_CACHE_TTL_MS: '300000',
      AUTH_JWKS_TIMEOUT_MS: '3000',
    });
    expect(productionConfig.issuers.map((entry) => entry.issuer)).toEqual(['https://identity.example.test']);
    expect(productionConfig.issuers.some((entry) => entry.issuer === DEVELOPMENT_IDENTITY_ISSUER)).toBe(false);
  });

  test('production TypeScript configuration excludes development issuer source', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const productionConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tsconfig.json'), 'utf8')) as {
      exclude?: string[];
    };
    expect(productionConfig.exclude).toContain('src/development/**/*');
  });

  test('tampered claims signed by another key are rejected by the configured JWKS key', async () => {
    const issuer = new DevelopmentIdentityIssuer(() => 1_000);
    const [header, claims] = parts(issuer.issue('PAYER'));
    const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forgedSignature = sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), attacker.privateKey)
      .toString('base64url');
    await expect(verifier(issuer).authenticate(`${header}.${claims}.${forgedSignature}`))
      .resolves.toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
  });
});
