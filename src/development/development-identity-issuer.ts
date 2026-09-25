import { generateKeyPairSync, sign } from 'crypto';
import type { KeyObject } from 'crypto';
import type { Jwk, JwksDocument, JwksFetcher, JwtAuthenticationConfig } from '../security/jwt-authentication';

/** These identifiers are external subjects only; the principal authority supplies actor mappings. */
export type DevelopmentIdentity = 'PAYER' | 'PAYEE';

export const DEVELOPMENT_IDENTITY_ISSUER = 'https://zinesh-development.invalid';
export const DEVELOPMENT_IDENTITY_AUDIENCE = 'zinesh-development';
export const DEVELOPMENT_IDENTITY_JWKS_URL = `${DEVELOPMENT_IDENTITY_ISSUER}/.well-known/jwks.json`;
export const DEVELOPMENT_IDENTITY_TTL_SECONDS = 300;

const DEVELOPMENT_SUBJECTS: Readonly<Record<DevelopmentIdentity, string>> = Object.freeze({
  PAYER: 'development-payer',
  PAYEE: 'development-payee',
});
const DEVELOPMENT_KEY_ID = 'zinesh-development-ephemeral';

/**
 * A process-local, development-only RS256 issuer for the two fixed prototype identities.
 * Its ephemeral private key is never read from or written to disk.
 */
export class DevelopmentIdentityIssuer implements JwksFetcher {
  private readonly privateKey: KeyObject;
  private readonly publicJwk: Jwk;

  constructor(private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000)) {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
    this.privateKey = pair.privateKey;
    const exported = pair.publicKey.export({ format: 'jwk' });
    if (typeof exported.n !== 'string' || typeof exported.e !== 'string') {
      throw new Error('Could not export development public key');
    }
    this.publicJwk = Object.freeze({
      kty: 'RSA', n: exported.n, e: exported.e, kid: DEVELOPMENT_KEY_ID,
      alg: 'RS256', use: 'sig', key_ops: ['verify'],
    });
  }

  issue(identity: DevelopmentIdentity): string {
    const subject = DEVELOPMENT_SUBJECTS[identity];
    if (subject === undefined) throw new Error('Unsupported development identity');
    const issuedAt = this.nowSeconds();
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error('Invalid development clock');
    const header = encode({ alg: 'RS256', kid: DEVELOPMENT_KEY_ID, typ: 'JWT' });
    const claims = encode({
      iss: DEVELOPMENT_IDENTITY_ISSUER,
      sub: subject,
      aud: DEVELOPMENT_IDENTITY_AUDIENCE,
      nbf: issuedAt,
      exp: issuedAt + DEVELOPMENT_IDENTITY_TTL_SECONDS,
    });
    const signingInput = `${header}.${claims}`;
    const signature = sign('RSA-SHA256', Buffer.from(signingInput), this.privateKey).toString('base64url');
    return `${signingInput}.${signature}`;
  }

  /** The verifier receives only the public key through the existing JWKS fetcher contract. */
  async fetch(url: string, _timeoutMs: number): Promise<JwksDocument> {
    if (url !== DEVELOPMENT_IDENTITY_JWKS_URL) throw new Error('Unknown development JWKS URL');
    return { keys: [this.publicJwk] };
  }

  authenticationConfig(): JwtAuthenticationConfig {
    return {
      issuers: [{ issuer: DEVELOPMENT_IDENTITY_ISSUER, audiences: [DEVELOPMENT_IDENTITY_AUDIENCE],
        algorithms: ['RS256'], jwksUrl: DEVELOPMENT_IDENTITY_JWKS_URL }],
      clockSkewSeconds: 0,
      jwksCacheTtlMs: 60_000,
      jwksTimeoutMs: 1_000,
    };
  }
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
