import { createPublicKey, verify as verifySignature } from 'crypto';
import type { JsonWebKey } from 'crypto';
import type { AuthenticationPort, ExternalIdentity } from './trusted-ingress';

export type SupportedJwtAlgorithm = 'RS256';

export interface TrustedIssuerConfig {
  readonly issuer: string;
  readonly audiences: ReadonlyArray<string>;
  readonly algorithms: ReadonlyArray<SupportedJwtAlgorithm>;
  readonly jwksUrl: string;
}

export interface JwtAuthenticationConfig {
  readonly issuers: ReadonlyArray<TrustedIssuerConfig>;
  readonly clockSkewSeconds: number;
  readonly jwksCacheTtlMs: number;
  readonly jwksTimeoutMs: number;
  readonly maxCredentialLength?: number;
}

export interface Jwk extends JsonWebKey {
  readonly kid: string;
  readonly kty: string;
  readonly alg?: string;
  readonly use?: string;
}

export interface JwksDocument { readonly keys: ReadonlyArray<Jwk> }

export interface JwksFetcher {
  fetch(url: string, timeoutMs: number): Promise<JwksDocument>;
}

export class HttpJwksFetcher implements JwksFetcher {
  async fetch(url: string, timeoutMs: number): Promise<JwksDocument> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET', signal: controller.signal, redirect: 'error',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error('JWKS discovery failed');
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > 256_000) throw new Error('JWKS response too large');
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > 256_000) throw new Error('JWKS response too large');
      const document = JSON.parse(body) as unknown;
      if (!isJwksDocument(document)) throw new Error('Malformed JWKS response');
      return document;
    } finally { clearTimeout(timer); }
  }
}

interface CachedSet { readonly expiresAt: number; readonly keys: ReadonlyMap<string, Jwk> }

export class CachedJwksProvider {
  private readonly cache = new Map<string, CachedSet>();
  private readonly refreshes = new Map<string, Promise<CachedSet>>();
  private readonly lastUnknownRefresh = new Map<string, number>();

  constructor(
    private readonly fetcher: JwksFetcher,
    private readonly ttlMs: number,
    private readonly timeoutMs: number,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async key(config: TrustedIssuerConfig, kid: string): Promise<Jwk | null> {
    const current = this.cache.get(config.issuer);
    if (current !== undefined && current.expiresAt > this.nowMs()) {
      const known = current.keys.get(kid);
      if (known !== undefined) return known;
      const last = this.lastUnknownRefresh.get(config.issuer) ?? Number.NEGATIVE_INFINITY;
      if (this.nowMs() - last < Math.min(this.ttlMs, 5_000)) return null;
      this.lastUnknownRefresh.set(config.issuer, this.nowMs());
    }
    try {
      const refreshed = await this.refresh(config);
      return refreshed.keys.get(kid) ?? null;
    } catch {
      // Never use an expired set and never authenticate an unknown key.
      return null;
    }
  }

  clear(issuer?: string): void {
    if (issuer === undefined) this.cache.clear();
    else this.cache.delete(issuer);
    if (issuer === undefined) this.lastUnknownRefresh.clear();
    else this.lastUnknownRefresh.delete(issuer);
  }

  private refresh(config: TrustedIssuerConfig): Promise<CachedSet> {
    const active = this.refreshes.get(config.issuer);
    if (active !== undefined) return active;
    const refresh = this.fetcher.fetch(config.jwksUrl, this.timeoutMs).then((document) => {
      if (document.keys.length > 32) throw new Error('Too many JWKS keys');
      const keys = new Map<string, Jwk>();
      for (const key of document.keys) {
        if (key.kid.length === 0 || keys.has(key.kid)) throw new Error('Invalid JWKS key identity');
        keys.set(key.kid, Object.freeze({ ...key }));
      }
      const cached = { expiresAt: this.nowMs() + this.ttlMs, keys };
      this.cache.set(config.issuer, cached);
      return cached;
    }).finally(() => { this.refreshes.delete(config.issuer); });
    this.refreshes.set(config.issuer, refresh);
    return refresh;
  }
}

interface JwtHeader { readonly alg: string; readonly kid: string; readonly typ?: string }
interface JwtClaims {
  readonly iss: string; readonly sub: string; readonly aud: string | ReadonlyArray<string>;
  readonly exp: number; readonly nbf?: number;
}

export class JwtAuthenticationAdapter implements AuthenticationPort {
  private readonly issuers: ReadonlyMap<string, TrustedIssuerConfig>;
  private readonly maxLength: number;

  constructor(
    private readonly config: JwtAuthenticationConfig,
    private readonly keys: CachedJwksProvider,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    validateConfig(config);
    this.issuers = new Map(config.issuers.map((issuer) => [issuer.issuer, issuer]));
    this.maxLength = config.maxCredentialLength ?? 16_384;
  }

  async authenticate(credential: unknown): Promise<
    { readonly ok: true; readonly identity: ExternalIdentity } | { readonly ok: false }
  > {
    if (typeof credential !== 'string' || credential.length === 0 || credential.length > this.maxLength) {
      return { ok: false };
    }
    const parts = credential.split('.');
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) return { ok: false };
    const encodedHeader = parts[0];
    const encodedClaims = parts[1];
    const encodedSignature = parts[2];
    if (encodedHeader === undefined || encodedClaims === undefined || encodedSignature === undefined) return { ok: false };
    const header = decodeObject(encodedHeader) as JwtHeader | null;
    const claims = decodeObject(encodedClaims) as JwtClaims | null;
    if (!validHeader(header) || !validClaims(claims)) return { ok: false };

    const issuer = this.issuers.get(claims.iss);
    if (issuer === undefined || !issuer.algorithms.includes(header.alg as SupportedJwtAlgorithm)) {
      return { ok: false };
    }
    if (!audienceMatches(claims.aud, issuer.audiences)) return { ok: false };
    const now = this.nowSeconds();
    if (now - this.config.clockSkewSeconds >= claims.exp) return { ok: false };
    if (claims.nbf !== undefined && now + this.config.clockSkewSeconds < claims.nbf) return { ok: false };

    const key = await this.keys.key(issuer, header.kid);
    const operations = key?.key_ops;
    if (key === null || key.kty !== 'RSA' || (key.alg !== undefined && key.alg !== header.alg) ||
        (key.use !== undefined && key.use !== 'sig') ||
        (operations != null && (!Array.isArray(operations) || !operations.includes('verify')))) return { ok: false };
    try {
      const publicKey = createPublicKey({ key, format: 'jwk' });
      if (publicKey.asymmetricKeyType !== 'rsa' ||
          (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return { ok: false };
      const valid = verifySignature(
        'RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedClaims}`),
        publicKey, base64UrlBuffer(encodedSignature),
      );
      return valid ? { ok: true, identity: { issuer: claims.iss, subject: claims.sub } } : { ok: false };
    } catch { return { ok: false }; }
  }
}

function validateConfig(config: JwtAuthenticationConfig): void {
  if (config.issuers.length === 0 || config.clockSkewSeconds < 0 ||
      config.jwksCacheTtlMs <= 0 || config.jwksTimeoutMs <= 0) throw new Error('Invalid authentication configuration');
  const seen = new Set<string>();
  for (const item of config.issuers) {
    if (!item.issuer || seen.has(item.issuer) || item.audiences.length === 0 ||
        item.algorithms.length === 0 || !item.jwksUrl.startsWith('https://') ||
        item.algorithms.some((algorithm) => algorithm !== 'RS256')) throw new Error('Invalid trusted issuer configuration');
    seen.add(item.issuer);
  }
}

function decodeObject(value: string): Record<string, unknown> | null {
  try {
    const decoded = JSON.parse(base64UrlBuffer(value).toString('utf8')) as unknown;
    return typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)
      ? decoded as Record<string, unknown> : null;
  } catch { return null; }
}

function base64UrlBuffer(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
  return Buffer.from(value, 'base64url');
}

function validHeader(value: JwtHeader | null): value is JwtHeader {
  return value !== null && typeof value.alg === 'string' && typeof value.kid === 'string' && value.kid.length > 0;
}

function validClaims(value: JwtClaims | null): value is JwtClaims {
  return value !== null && typeof value.iss === 'string' && value.iss.length > 0 &&
    typeof value.sub === 'string' && value.sub.length > 0 &&
    (typeof value.aud === 'string' || (Array.isArray(value.aud) && value.aud.every((item) => typeof item === 'string'))) &&
    typeof value.exp === 'number' && Number.isSafeInteger(value.exp) &&
    (value.nbf === undefined || (typeof value.nbf === 'number' && Number.isSafeInteger(value.nbf)));
}

function audienceMatches(actual: string | ReadonlyArray<string>, trusted: ReadonlyArray<string>): boolean {
  const values = typeof actual === 'string' ? [actual] : actual;
  return values.some((value) => trusted.includes(value));
}

function isJwksDocument(value: unknown): value is JwksDocument {
  return typeof value === 'object' && value !== null && 'keys' in value &&
    Array.isArray((value as { keys: unknown }).keys) &&
    (value as { keys: unknown[] }).keys.every((key) =>
      typeof key === 'object' && key !== null && 'kid' in key && 'kty' in key &&
      typeof (key as { kid: unknown }).kid === 'string' && typeof (key as { kty: unknown }).kty === 'string');
}
