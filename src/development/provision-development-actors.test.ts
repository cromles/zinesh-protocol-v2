import type { ActorId } from '../core/types';
import { makeActorId, makeTimestamp } from '../core/types';
import type { ExternalIdentity, PrincipalAuthority, PrincipalRecord } from '../security/trusted-ingress';
import type { CreatePrincipalInput, LifecycleContext, LifecycleResult, PrincipalLifecycleAuthority } from '../security/principal-lifecycle';
import { DEVELOPMENT_IDENTITY_ISSUER } from './development-identity-issuer';
import {
  assertDevelopmentProvisioningEnvironment,
  DevelopmentProvisioningConflict,
  DEVELOPMENT_DATABASE_NAME,
  provisionDevelopmentActors,
} from './provision-development-actors';

class MemoryPrincipalAuthority implements PrincipalAuthority, PrincipalLifecycleAuthority {
  readonly principals = new Map<string, PrincipalRecord>();
  readonly identities = new Map<string, string>();

  async resolve(identity: ExternalIdentity): Promise<PrincipalRecord | null> {
    const id = this.identities.get(this.key(identity));
    return id === undefined ? null : this.principals.get(id) ?? null;
  }

  async get(principalId: string): Promise<PrincipalRecord | null> {
    return this.principals.get(principalId) ?? null;
  }

  async create(input: CreatePrincipalInput): Promise<LifecycleResult> {
    const identityKey = this.key(input.identity);
    if (this.identities.has(identityKey) || this.principals.has(input.principalId)
      || (input.actorId !== undefined && [...this.principals.values()].some((item) => item.actorId === input.actorId))) {
      return { ok: false, kind: 'CONFLICT' };
    }
    const record: PrincipalRecord = { principalId: input.principalId, type: input.type, enabled: true,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      capabilities: input.capabilities ?? [], mappingVersion: 1 };
    this.identities.set(identityKey, input.principalId);
    this.principals.set(input.principalId, record);
    return { ok: true, principal: record };
  }

  async setEnabled(): Promise<LifecycleResult> { throw new Error('unused'); }
  async setActorMapping(): Promise<LifecycleResult> { throw new Error('unused'); }
  async assignCapability(): Promise<LifecycleResult> { throw new Error('unused'); }
  async revokeCapability(): Promise<LifecycleResult> { throw new Error('unused'); }
  async attachIdentity(): Promise<LifecycleResult> { throw new Error('unused'); }

  private key(identity: ExternalIdentity): string { return `${identity.issuer}\u0000${identity.subject}`; }
}

const context: LifecycleContext = { occurredAt: makeTimestamp(1_000), correlationId: 'development-provision-test' };
const validEnvironment = (): NodeJS.ProcessEnv => ({
  ZINESH_RUNTIME_ENV: 'development',
  ZINESH_DEVELOPMENT_PROVISIONING: 'true',
  PGHOST: '127.0.0.1',
  PGDATABASE: DEVELOPMENT_DATABASE_NAME,
  ZINESH_DEVELOPMENT_IDENTITY_ISSUER: DEVELOPMENT_IDENTITY_ISSUER,
  ZINESH_DEVELOPMENT_PAYER_SUBJECT: 'development-payer',
  ZINESH_DEVELOPMENT_PAYEE_SUBJECT: 'development-payee',
});

describe('development actor provisioning contract', () => {
  test('creates two distinct enabled ACTOR principals with ACT_AS_SELF only', async () => {
    const authority = new MemoryPrincipalAuthority();
    const result = await provisionDevelopmentActors(authority, context);
    expect(result.map((item) => item.outcome)).toEqual(['CREATED', 'CREATED']);

    const payer = await authority.resolve({ issuer: DEVELOPMENT_IDENTITY_ISSUER, subject: 'development-payer' });
    const payee = await authority.resolve({ issuer: DEVELOPMENT_IDENTITY_ISSUER, subject: 'development-payee' });
    expect(payer).toMatchObject({ principalId: 'development-principal-payer', type: 'ACTOR', enabled: true,
      actorId: makeActorId('development-payer'), capabilities: ['ACT_AS_SELF'] });
    expect(payee).toMatchObject({ principalId: 'development-principal-payee', type: 'ACTOR', enabled: true,
      actorId: makeActorId('development-payee'), capabilities: ['ACT_AS_SELF'] });
    expect(payer?.actorId).not.toBe(payee?.actorId);
  });

  test('second run preserves exact mappings and creates no duplicate principal', async () => {
    const authority = new MemoryPrincipalAuthority();
    await provisionDevelopmentActors(authority, context);
    const second = await provisionDevelopmentActors(authority, context);
    expect(second.map((item) => item.outcome)).toEqual(['UNCHANGED', 'UNCHANGED']);
    expect(authority.principals.size).toBe(2);
    expect(authority.identities.size).toBe(2);
  });

  test('fails closed for non-development, non-opted-in, production DB, issuer, or subject configuration', () => {
    expect(() => assertDevelopmentProvisioningEnvironment(validEnvironment())).not.toThrow();
    for (const changes of [
      { ZINESH_RUNTIME_ENV: 'production' },
      { ZINESH_DEVELOPMENT_PROVISIONING: 'false' },
      { PGDATABASE: 'zinesh_production' },
      { PGHOST: 'production-db.example.com' },
      { ZINESH_DEVELOPMENT_IDENTITY_ISSUER: 'https://identity.example.com' },
      { ZINESH_DEVELOPMENT_PAYER_SUBJECT: 'unexpected-subject' },
      { ZINESH_DEVELOPMENT_PAYEE_SUBJECT: undefined },
    ]) {
      expect(() => assertDevelopmentProvisioningEnvironment({ ...validEnvironment(), ...changes }))
        .toThrow();
    }
  });

  test('rejects an identity already mapped to the wrong actor instead of rebinding it', async () => {
    const authority = new MemoryPrincipalAuthority();
    const wrongActor: ActorId = makeActorId('someone-else');
    const seeded = await authority.create({ principalId: 'existing-payer', type: 'ACTOR', actorId: wrongActor,
      identity: { issuer: DEVELOPMENT_IDENTITY_ISSUER, subject: 'development-payer' },
      capabilities: ['ACT_AS_SELF'], context });
    expect(seeded.ok).toBe(true);
    await expect(provisionDevelopmentActors(authority, context))
      .rejects.toBeInstanceOf(DevelopmentProvisioningConflict);
    expect((await authority.resolve({ issuer: DEVELOPMENT_IDENTITY_ISSUER, subject: 'development-payer' }))?.actorId)
      .toBe(wrongActor);
  });

  test('rejects a fixed principal ID already occupied by another identity', async () => {
    const authority = new MemoryPrincipalAuthority();
    await authority.create({ principalId: 'development-principal-payer', type: 'ACTOR',
      actorId: makeActorId('development-payer'),
      identity: { issuer: DEVELOPMENT_IDENTITY_ISSUER, subject: 'unexpected-subject' },
      capabilities: ['ACT_AS_SELF'], context });
    await expect(provisionDevelopmentActors(authority, context))
      .rejects.toBeInstanceOf(DevelopmentProvisioningConflict);
  });

  test('rejects binding a fixed development actor to an unexpected subject', async () => {
    const authority = new MemoryPrincipalAuthority();
    await authority.create({ principalId: 'other-subject-principal', type: 'ACTOR',
      actorId: makeActorId('development-payer'),
      identity: { issuer: DEVELOPMENT_IDENTITY_ISSUER, subject: 'unexpected-subject' },
      capabilities: ['ACT_AS_SELF'], context });
    await expect(provisionDevelopmentActors(authority, context))
      .rejects.toBeInstanceOf(DevelopmentProvisioningConflict);
  });
});
