import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { CommandHttpTransport } from '../transport/command-http-transport';
import type { CommandDispatcher } from '../transport/command-http-transport';
import { CachedJwksProvider, JwtAuthenticationAdapter } from '../security/jwt-authentication';
import {
  DEVELOPMENT_IDENTITY_AUDIENCE,
  DEVELOPMENT_IDENTITY_ISSUER,
  DEVELOPMENT_IDENTITY_TTL_SECONDS,
  DevelopmentIdentityIssuer,
} from './development-identity-issuer';
import {
  createDevelopmentHttpServerFactory,
  DEVELOPMENT_TOKEN_PATH,
} from './development-http';
import {
  DEVELOPMENT_HTTP_DEFAULT_PORT,
  loadDevelopmentHttpConfig,
} from './development-launcher';

const validEnvironment = (): NodeJS.ProcessEnv => ({
  ZINESH_RUNTIME_ENV: 'development',
  ZINESH_DEVELOPMENT_PROVISIONING: 'true',
  ZINESH_DEVELOPMENT_IDENTITY_ISSUER: DEVELOPMENT_IDENTITY_ISSUER,
  ZINESH_DEVELOPMENT_PAYER_SUBJECT: 'development-payer',
  ZINESH_DEVELOPMENT_PAYEE_SUBJECT: 'development-payee',
  PROTOTYPE_FUNDING_ENABLED: 'true',
  PGHOST: 'localhost',
  PGDATABASE: 'zinesh_development',
});

const browserOrigin = 'http://localhost:5173';

function decodeClaims(token: string): Record<string, unknown> {
  const claims = token.split('.')[1];
  if (claims === undefined) throw new Error('JWT claims missing');
  return JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function startTokenServer(issuer: DevelopmentIdentityIssuer): Promise<{ server: Server; url: string }> {
  const server = createDevelopmentHttpServerFactory(issuer, browserOrigin, 16_384)(
    (_request, response) => { response.statusCode = 404; response.end(); },
  );
  return listen(server).then((url) => ({ server, url }));
}

describe('development launcher configuration', () => {
  test('requires the development runtime and provisioning guards', () => {
    const env = validEnvironment();
    expect(loadDevelopmentHttpConfig(env).port).toBe(DEVELOPMENT_HTTP_DEFAULT_PORT);
    expect(() => loadDevelopmentHttpConfig({ ...env, ZINESH_RUNTIME_ENV: 'production' })).toThrow();
    expect(() => loadDevelopmentHttpConfig({ ...env, ZINESH_DEVELOPMENT_PROVISIONING: 'false' })).toThrow();
    expect(() => loadDevelopmentHttpConfig({ ...env, PROTOTYPE_FUNDING_ENABLED: 'false' })).toThrow();
  });

  test('allows configurable HTTP_PORT but refuses non-loopback bind and browser origins', () => {
    const env = validEnvironment();
    expect(loadDevelopmentHttpConfig({ ...env, HTTP_PORT: '9876' }).port).toBe(9876);
    expect(() => loadDevelopmentHttpConfig({ ...env, HTTP_HOST: '0.0.0.0' })).toThrow(/HTTP_HOST/);
    expect(() => loadDevelopmentHttpConfig({ ...env, ZINESH_DEVELOPMENT_WEB_ORIGIN: 'https://example.test' }))
      .toThrow(/ZINESH_DEVELOPMENT_WEB_ORIGIN/);
  });
});

describe('development JWT bootstrap endpoint', () => {
  test.each([
    ['payer', 'development-payer'],
    ['payee', 'development-payee'],
  ] as const)('%s issues a short-lived JWT for its fixed external subject', async (role, subject) => {
    const issuer = new DevelopmentIdentityIssuer();
    const { server, url } = await startTokenServer(issuer);
    try {
      const response = await fetch(`${url}${DEVELOPMENT_TOKEN_PATH}`, {
        method: 'POST',
        headers: { origin: browserOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      const body = await response.json() as { token: string; expiresIn: number; role: string };
      expect(Object.keys(body).sort()).toEqual(['expiresIn', 'role', 'token']);
      expect(body).toMatchObject({ expiresIn: DEVELOPMENT_IDENTITY_TTL_SECONDS, role });

      const claims = decodeClaims(body.token);
      expect(claims).toMatchObject({ iss: DEVELOPMENT_IDENTITY_ISSUER, sub: subject,
        aud: DEVELOPMENT_IDENTITY_AUDIENCE });
      expect(claims['exp'] as number - (claims['nbf'] as number)).toBe(DEVELOPMENT_IDENTITY_TTL_SECONDS);
      expect(claims).not.toHaveProperty('actorId');
      expect(claims).not.toHaveProperty('role');

      const config = issuer.authenticationConfig();
      const authentication = new JwtAuthenticationAdapter(config,
        new CachedJwksProvider(issuer, config.jwksCacheTtlMs, config.jwksTimeoutMs));
      await expect(authentication.authenticate(body.token)).resolves.toEqual({ ok: true,
        identity: { issuer: DEVELOPMENT_IDENTITY_ISSUER, subject } });
    } finally { await close(server); }
  });

  test('rejects unsupported roles, non-matching origins, missing origins and non-POST requests', async () => {
    const { server, url } = await startTokenServer(new DevelopmentIdentityIssuer());
    try {
      const invalidRole = await fetch(`${url}${DEVELOPMENT_TOKEN_PATH}`, {
        method: 'POST', headers: { origin: browserOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'system' }),
      });
      expect(invalidRole.status).toBe(400);
      const wrongOrigin = await fetch(`${url}${DEVELOPMENT_TOKEN_PATH}`, {
        method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'payer' }),
      });
      expect(wrongOrigin.status).toBe(403);
      const missingOrigin = await fetch(`${url}${DEVELOPMENT_TOKEN_PATH}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'payer' }),
      });
      expect(missingOrigin.status).toBe(403);
      const wrongMethod = await fetch(`${url}${DEVELOPMENT_TOKEN_PATH}`, { method: 'GET' });
      expect(wrongMethod.status).toBe(405);
    } finally { await close(server); }
  });

  test('the production HTTP transport has no development token route', async () => {
    const config = { host: '127.0.0.1', port: 0, maxBodyBytes: 65_536, maxHeaderBytes: 16_384,
      requestTimeoutMs: 5_000, headersTimeoutMs: 2_000 };
    const transport = new CommandHttpTransport({} as CommandDispatcher, config, { record() {} });
    await transport.listen();
    try {
      const address = transport.address();
      if (address === null) throw new Error('HTTP server did not bind');
      const response = await fetch(`http://127.0.0.1:${address.port}${DEVELOPMENT_TOKEN_PATH}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'payer' }),
      });
      expect(response.status).toBe(404);
    } finally { await transport.close(); }
  });
});
