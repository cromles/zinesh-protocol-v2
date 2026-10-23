import { TrustedAdmissionQuarantineLifecycle } from './admission-quarantine-lifecycle';
import type { AdmissionQuarantineStore } from './admission-quarantine';
import type { AuthenticationPort, PrincipalAuthority, PrincipalRecord } from './trusted-ingress';
import { SecurityTelemetry } from './security-observability';
import type { SecurityEvent } from './security-observability';

const identity = { issuer: 'https://operator.example', subject: 'operator-subject' };
const operator: PrincipalRecord = {
  principalId: 'security-operator', type: 'SYSTEM', enabled: true,
  capabilities: ['MANAGE_ADMISSION_QUARANTINE'], mappingVersion: 1,
};

function authentication(result: Awaited<ReturnType<AuthenticationPort['authenticate']>> = { ok: true, identity }): AuthenticationPort {
  return { async authenticate() { return result; } };
}

function principals(result: PrincipalRecord | null = operator): PrincipalAuthority {
  return { async resolve() { return result; } };
}

function harness(overrides: {
  authentication?: AuthenticationPort;
  principals?: PrincipalAuthority;
  store?: AdmissionQuarantineStore;
  now?: () => number;
} = {}) {
  const events: SecurityEvent[] = [];
  const issued: unknown[] = [];
  const released: unknown[] = [];
  const store: AdmissionQuarantineStore = overrides.store ?? {
    async findActive() { return null; },
    async issue(value) { issued.push(value); return 'ISSUED'; },
    async release(value) { released.push(value); return 'RELEASED'; },
  };
  const telemetry = new SecurityTelemetry({
    instanceId: 'quarantine-lifecycle-test', log: { write(event) { events.push(event); } },
    metrics: { record() {} }, retention: { securityLogDays: 1, metricDays: 1, securityAuditDays: 1 },
    now: () => new Date('2026-10-23T00:00:00.000Z'),
  });
  return {
    lifecycle: new TrustedAdmissionQuarantineLifecycle(
      overrides.authentication ?? authentication(), overrides.principals ?? principals(), store,
      telemetry, overrides.now ?? (() => 1_000),
    ),
    events, issued, released,
  };
}

describe('trusted admission quarantine lifecycle', () => {
  test('SYSTEM operator with explicit capability can issue and release without receiving escrow authority', async () => {
    const h = harness();
    await expect(h.lifecycle.issue({
      credential: 'operator-token', quarantineId: 'quarantine-1', principalId: 'target-principal',
      reason: 'SECURITY_INCIDENT', expiresAt: 61_000, correlationId: 'incident-1',
    })).resolves.toEqual({ outcome: 'ISSUED' });
    expect(h.issued).toEqual([{
      quarantineId: 'quarantine-1', principalId: 'target-principal', reason: 'SECURITY_INCIDENT',
      issuedAt: 1_000, expiresAt: 61_000, issuedBy: 'security-operator', correlationId: 'incident-1',
    }]);

    await expect(h.lifecycle.release({
      credential: 'operator-token', quarantineId: 'quarantine-1', correlationId: 'release-1',
    })).resolves.toEqual({ outcome: 'RELEASED' });
    expect(h.released).toEqual([{
      quarantineId: 'quarantine-1', releasedAt: 1_000,
      releasedBy: 'security-operator', correlationId: 'release-1',
    }]);
    expect(h.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'ADMISSION', action: 'QUARANTINE_ISSUE', outcome: 'SUCCESS',
        reason: 'ISSUED', principalId: 'security-operator' }),
      expect.objectContaining({ category: 'ADMISSION', action: 'QUARANTINE_RELEASE', outcome: 'SUCCESS',
        reason: 'RELEASED', principalId: 'security-operator' }),
    ]));
  });

  test.each([
    { ...operator, type: 'ACTOR' as const, capabilities: ['ACT_AS_SELF' as const] },
    { ...operator, type: 'GATEWAY' as const, capabilities: ['CONFIRM_FUNDING' as const] },
    { ...operator, capabilities: [] },
    { ...operator, enabled: false },
  ])('rejects non-operator and disabled principals', async (principal) => {
    const h = harness({ principals: principals(principal) });
    await expect(h.lifecycle.issue({
      credential: 'credential', quarantineId: 'quarantine-2', principalId: 'target-principal',
      reason: 'MANUAL_REVIEW', expiresAt: 2_000, correlationId: 'incident-2',
    })).resolves.toEqual({ outcome: 'FORBIDDEN' });
    expect(h.issued).toHaveLength(0);
  });

  test('authenticates before validation and rejects unauthenticated callers opaquely', async () => {
    const h = harness({ authentication: authentication({ ok: false, reason: 'INVALID_SIGNATURE' }) });
    await expect(h.lifecycle.issue({
      credential: 'bad', quarantineId: 'unsafe id', principalId: 'target-principal',
      reason: 'MANUAL_REVIEW', expiresAt: -1, correlationId: 'bad correlation',
    })).resolves.toEqual({ outcome: 'UNAUTHENTICATED' });
    expect(h.issued).toHaveLength(0);
  });

  test('rejects invalid expiry and identifiers after authorization', async () => {
    const h = harness();
    await expect(h.lifecycle.issue({
      credential: 'operator-token', quarantineId: 'unsafe id', principalId: 'target-principal',
      reason: 'MANUAL_REVIEW', expiresAt: 2_000, correlationId: 'incident-3',
    })).resolves.toEqual({ outcome: 'INVALID' });
    await expect(h.lifecycle.issue({
      credential: 'operator-token', quarantineId: 'quarantine-3', principalId: 'target-principal',
      reason: 'MANUAL_REVIEW', expiresAt: 1_000, correlationId: 'incident-4',
    })).resolves.toEqual({ outcome: 'INVALID' });
    expect(h.issued).toHaveLength(0);
  });

  test('dependency failures fail closed without leaking adapter errors', async () => {
    const authFailure: AuthenticationPort = { async authenticate() { throw new Error('private jwks detail'); } };
    const authHarness = harness({ authentication: authFailure });
    await expect(authHarness.lifecycle.release({
      credential: 'token', quarantineId: 'quarantine-4', correlationId: 'release-4',
    })).resolves.toEqual({ outcome: 'UNAVAILABLE' });

    const storeFailure: AdmissionQuarantineStore = {
      async findActive() { return null; }, async issue() { throw new Error('private postgres detail'); },
      async release() { throw new Error('private postgres detail'); },
    };
    const storeHarness = harness({ store: storeFailure });
    await expect(storeHarness.lifecycle.issue({
      credential: 'token', quarantineId: 'quarantine-5', principalId: 'target-principal',
      reason: 'BEHAVIORAL_ANOMALY', expiresAt: 2_000, correlationId: 'incident-5',
    })).resolves.toEqual({ outcome: 'UNAVAILABLE' });
  });
});
