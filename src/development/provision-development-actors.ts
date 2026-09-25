import { randomUUID } from 'crypto';
import type { ActorId } from '../core/types';
import { makeActorId, makeTimestamp } from '../core/types';
import { PostgresPersistenceAdapter } from '../adapters/postgres-persistence-adapter';
import { ConfigurationError, loadPostgresConfig } from '../composition/main';
import type { EnvMap } from '../composition/main';
import type { ExternalIdentity, PrincipalAuthority, PrincipalRecord } from '../security/trusted-ingress';
import type { LifecycleContext, PrincipalLifecycleAuthority } from '../security/principal-lifecycle';
import { DEVELOPMENT_IDENTITY_ISSUER } from './development-identity-issuer';

export const DEVELOPMENT_DATABASE_NAME = 'zinesh_development';

export interface DevelopmentActorProvisioningResult {
  readonly identity: 'PAYER' | 'PAYEE';
  readonly principalId: string;
  readonly actorId: ActorId;
  readonly outcome: 'CREATED' | 'UNCHANGED';
}

interface ProvisioningSpec {
  readonly identityName: 'PAYER' | 'PAYEE';
  readonly identity: ExternalIdentity;
  readonly principalId: string;
  readonly actorId: ActorId;
}

const SPECS: ReadonlyArray<ProvisioningSpec> = Object.freeze([
  Object.freeze({ identityName: 'PAYER',
    identity: Object.freeze({ issuer: DEVELOPMENT_IDENTITY_ISSUER, subject: 'development-payer' }),
    principalId: 'development-principal-payer', actorId: makeActorId('development-payer') }),
  Object.freeze({ identityName: 'PAYEE',
    identity: Object.freeze({ issuer: DEVELOPMENT_IDENTITY_ISSUER, subject: 'development-payee' }),
    principalId: 'development-principal-payee', actorId: makeActorId('development-payee') }),
]);

export class DevelopmentProvisioningConflict extends Error {
  constructor(identity: 'PAYER' | 'PAYEE') {
    super(`Development ${identity} principal mapping conflicts with the fixed bootstrap contract`);
    this.name = 'DevelopmentProvisioningConflict';
  }
}

export class DevelopmentProvisioningConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevelopmentProvisioningConfigurationError';
  }
}

/** Fail closed unless the operator explicitly selects the isolated development database and identities. */
export function assertDevelopmentProvisioningEnvironment(env: EnvMap): void {
  if (env['ZINESH_RUNTIME_ENV'] !== 'development') {
    throw new DevelopmentProvisioningConfigurationError('ZINESH_RUNTIME_ENV must be development');
  }
  if (env['ZINESH_DEVELOPMENT_PROVISIONING'] !== 'true') {
    throw new DevelopmentProvisioningConfigurationError('ZINESH_DEVELOPMENT_PROVISIONING must be true');
  }
  if (env['PGDATABASE'] !== DEVELOPMENT_DATABASE_NAME) {
    throw new DevelopmentProvisioningConfigurationError(`PGDATABASE must be ${DEVELOPMENT_DATABASE_NAME}`);
  }
  if (!['127.0.0.1', '::1', 'localhost'].includes(env['PGHOST'] ?? '')) {
    throw new DevelopmentProvisioningConfigurationError('PGHOST must identify a local development database');
  }
  if (env['ZINESH_DEVELOPMENT_IDENTITY_ISSUER'] !== DEVELOPMENT_IDENTITY_ISSUER) {
    throw new DevelopmentProvisioningConfigurationError('ZINESH_DEVELOPMENT_IDENTITY_ISSUER must match the fixed development issuer');
  }
  if (env['ZINESH_DEVELOPMENT_PAYER_SUBJECT'] !== 'development-payer'
    || env['ZINESH_DEVELOPMENT_PAYEE_SUBJECT'] !== 'development-payee') {
    throw new DevelopmentProvisioningConfigurationError('Development subjects must match the fixed bootstrap identities');
  }
}

/** Creates only the two fixed ACTOR principals; exact existing mappings are successful no-ops. */
export async function provisionDevelopmentActors(
  authority: PrincipalAuthority & PrincipalLifecycleAuthority,
  context: LifecycleContext = { occurredAt: makeTimestamp(Date.now()), correlationId: randomUUID() },
): Promise<ReadonlyArray<DevelopmentActorProvisioningResult>> {
  const results: DevelopmentActorProvisioningResult[] = [];
  for (const spec of SPECS) results.push(await provisionOne(authority, spec, context));
  return results;
}

async function provisionOne(
  authority: PrincipalAuthority & PrincipalLifecycleAuthority,
  spec: ProvisioningSpec,
  context: LifecycleContext,
): Promise<DevelopmentActorProvisioningResult> {
  const existingIdentity = await authority.resolve(spec.identity);
  const existingPrincipal = await authority.get(spec.principalId);
  if (existingIdentity !== null || existingPrincipal !== null) {
    if (existingIdentity !== null && existingPrincipal !== null
      && sameExpectedPrincipal(existingIdentity, spec) && sameExpectedPrincipal(existingPrincipal, spec)) {
      return result(spec, 'UNCHANGED');
    }
    throw new DevelopmentProvisioningConflict(spec.identityName);
  }

  const created = await authority.create({
    principalId: spec.principalId,
    type: 'ACTOR',
    actorId: spec.actorId,
    identity: spec.identity,
    capabilities: ['ACT_AS_SELF'],
    context,
  });
  if (created.ok && sameExpectedPrincipal(created.principal, spec)) return result(spec, 'CREATED');

  // Another operator process may have won the unique-key race. Accept only the exact fixed mapping.
  if (!created.ok && created.kind === 'CONFLICT') {
    const [resolved, principal] = await Promise.all([
      authority.resolve(spec.identity), authority.get(spec.principalId),
    ]);
    if (resolved !== null && principal !== null
      && sameExpectedPrincipal(resolved, spec) && sameExpectedPrincipal(principal, spec)) {
      return result(spec, 'UNCHANGED');
    }
  }
  throw new DevelopmentProvisioningConflict(spec.identityName);
}

function sameExpectedPrincipal(principal: PrincipalRecord, spec: ProvisioningSpec): boolean {
  return principal.principalId === spec.principalId && principal.type === 'ACTOR'
    && principal.enabled && principal.actorId === spec.actorId
    && principal.capabilities.length === 1 && principal.capabilities[0] === 'ACT_AS_SELF';
}

function result(spec: ProvisioningSpec, outcome: 'CREATED' | 'UNCHANGED'): DevelopmentActorProvisioningResult {
  return { identity: spec.identityName, principalId: spec.principalId, actorId: spec.actorId, outcome };
}

async function runDevelopmentProvisioning(env: EnvMap): Promise<void> {
  assertDevelopmentProvisioningEnvironment(env);
  const config = loadPostgresConfig(env);
  const persistence = new PostgresPersistenceAdapter(config);
  try {
    await persistence.connect();
    await persistence.migrator.verifyExpectedVersion();
    const results = await provisionDevelopmentActors(persistence.principalAuthority);
    for (const item of results) {
      process.stdout.write(`${item.identity}: ${item.outcome} (${item.actorId})\n`);
    }
  } finally {
    await persistence.disconnect();
  }
}

if (require.main === module) {
  void runDevelopmentProvisioning(process.env).catch((error: unknown) => {
    const message = error instanceof DevelopmentProvisioningConfigurationError
      || error instanceof DevelopmentProvisioningConflict || error instanceof ConfigurationError
      ? error.message
      : 'Development actor provisioning failed; verify PostgreSQL connectivity and schema readiness';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
