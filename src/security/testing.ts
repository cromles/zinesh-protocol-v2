import type { ActorId } from '../core/types';
import type { PrincipalRecord } from './trusted-ingress';
import { TrustedCommandIngress } from './trusted-ingress';
import type { CellApplication } from '../application/cell-application';

export interface TestIdentity {
  readonly credential: string;
  readonly subject: string;
  readonly issuer?: string;
  readonly principal: PrincipalRecord;
}

export function createTestIngress(
  application: CellApplication,
  identities: ReadonlyArray<TestIdentity>,
  fundingVerifier: ConstructorParameters<typeof TrustedCommandIngress>[3] = { async verify() { return null; } },
): TrustedCommandIngress {
  const byCredential = new Map(identities.map((entry) => [entry.credential, {
    issuer: entry.issuer ?? 'test-issuer', subject: entry.subject,
  }]));
  const bySubject = new Map(identities.map((entry) => [
    `${entry.issuer ?? 'test-issuer'}\u0000${entry.subject}`, entry.principal,
  ]));
  return new TrustedCommandIngress(
    application,
    { async authenticate(credential) {
      if (typeof credential !== 'string') return { ok: false };
      const identity = byCredential.get(credential);
      return identity === undefined ? { ok: false } : { ok: true, identity };
    } },
    { async resolve(identity) { return bySubject.get(`${identity.issuer}\u0000${identity.subject}`) ?? null; } },
    fundingVerifier,
  );
}

export function actorIdentity(actorId: ActorId, suffix = String(actorId)): TestIdentity {
  return {
    credential: `test-credential-${suffix}`,
    subject: `test-subject-${suffix}`,
    principal: {
      principalId: `principal-${suffix}`,
      type: 'ACTOR', enabled: true, actorId,
      capabilities: ['ACT_AS_SELF'], mappingVersion: 1,
    },
  };
}
