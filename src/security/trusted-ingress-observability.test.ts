import { InMemoryPersistenceAdapter } from '../adapters/in-memory-persistence-adapter';
import { CellApplication } from '../application/cell-application';
import { fixedClock } from '../application/clock';
import { createEventIdFactory } from '../application/event-id-factory';
import { makeActorId, makeAmount, makeCellId, makeCommandId, makeTimestamp } from '../core/types';
import { cellKernel } from '../kernel';
import { SecurityTelemetry } from './security-observability';
import type { SecurityEvent } from './security-observability';
import { TrustedCommandIngress, rejectAllFundingEvidence } from './trusted-ingress';
import type { AuthenticationPort, PrincipalAuthority, PrincipalRecord } from './trusted-ingress';
import type { RateLimiter } from './rate-limiter';

const PAYER = makeActorId('observability-payer');
const principal: PrincipalRecord = {
  principalId: 'principal-observability', type: 'ACTOR', enabled: true,
  actorId: PAYER, capabilities: ['ACT_AS_SELF'], mappingVersion: 1,
};

function createCommand(id = 'observability-command', amount = 100n, payer = PAYER) {
  return {
    commandId: makeCommandId(id), cellId: makeCellId(`cell-${id}`), type: 'CreateCell' as const,
    payload: {
      payer, payee: makeActorId('observability-payee'), amount: makeAmount(amount), currency: 'TRY' as const,
      fundingDeadline: makeTimestamp(2_000_000), completionDeadline: makeTimestamp(3_000_000),
    },
  };
}

function fundCommand(id = 'observability-fund') {
  return {
    commandId: makeCommandId(id), cellId: makeCellId(`cell-${id}`), type: 'FundCell' as const,
    payload: { funderId: PAYER, amount: makeAmount(100n) },
  };
}

function setup(options: {
  authentication?: AuthenticationPort;
  authority?: PrincipalAuthority;
  limiter?: RateLimiter;
  telemetry?: SecurityTelemetry;
  persistence?: InMemoryPersistenceAdapter;
} = {}) {
  const events: SecurityEvent[] = [];
  const telemetry = options.telemetry ?? new SecurityTelemetry({
    instanceId: 'integration-instance', log: { write(event) { events.push(event); } },
    metrics: { record() {} }, retention: { securityLogDays: 30, metricDays: 14, securityAuditDays: 365 },
  });
  const persistence = options.persistence ?? new InMemoryPersistenceAdapter();
  const application = new CellApplication({
    persistence, kernel: cellKernel, clock: fixedClock(makeTimestamp(1_000_000)),
    eventIds: createEventIdFactory('observability'),
  });
  const ingress = new TrustedCommandIngress(
    application,
    options.authentication ?? { async authenticate() {
      return { ok: true as const, identity: { issuer: 'https://issuer.test', subject: 'subject' } };
    } },
    options.authority ?? { async resolve() { return principal; } },
    rejectAllFundingEvidence,
    options.limiter ?? { async consume() { return { allowed: true, retryAfterSeconds: 0 }; } },
    telemetry,
  );
  return { ingress, events, persistence };
}

function failedTelemetry(): SecurityTelemetry {
  return new SecurityTelemetry({
    instanceId: 'failed-pipeline',
    log: { write() { throw new Error('logger unavailable'); } },
    metrics: { record() { throw new Error('metrics unavailable'); } },
    retention: { securityLogDays: 1, metricDays: 1, securityAuditDays: 1 },
  });
}

describe('Phase 7H trusted ingress observability', () => {
  test('authentication success, principal resolution, authorization and command success share correlation', async () => {
    const { ingress, events } = setup();
    const result = await ingress.handle({ credential: 'opaque-token', command: createCommand(), correlationId: 'server-correlation' });
    expect(result.outcome).toBe('SUCCESS');
    expect(events.map((event) => `${event.category}:${event.outcome}`)).toEqual(expect.arrayContaining([
      'AUTHENTICATION:SUCCESS', 'PRINCIPAL:SUCCESS', 'AUTHORIZATION:ALLOWED',
      'RATE_LIMIT:ALLOWED', 'INGRESS:SUCCESS',
    ]));
    expect(new Set(events.map((event) => event.correlationId))).toEqual(new Set(['server-correlation']));
    expect(events.every((event) => event.commandId === 'observability-command')).toBe(true);
    expect(events.every((event) => event.correlationId !== event.commandId)).toBe(true);
  });

  test('commandId can never become the operational correlation identity', async () => {
    const { ingress, events } = setup();
    const result = await ingress.handle({
      credential: 'opaque-token', command: createCommand(), correlationId: 'observability-command',
    });
    expect(result.outcome).toBe('SUCCESS');
    expect(events.every((event) => event.commandId === 'observability-command')).toBe(true);
    expect(events.every((event) => event.correlationId !== event.commandId)).toBe(true);
  });

  test.each([
    'INVALID_SIGNATURE', 'INVALID_ISSUER', 'INVALID_AUDIENCE', 'UNKNOWN_KEY', 'EXPIRED_CREDENTIAL',
  ] as const)('authentication failure %s is categorized without credential material', async (reason) => {
    const { ingress, events } = setup({ authentication: { async authenticate() { return { ok: false, reason }; } } });
    const result = await ingress.handle({ credential: `secret-${reason}`, command: createCommand(), correlationId: 'auth-failure' });
    expect(result).toMatchObject({ outcome: 'APPLICATION_REJECTION', error: { code: 'UNAUTHENTICATED' } });
    expect(events).toContainEqual(expect.objectContaining({ category: 'AUTHENTICATION', outcome: 'REJECTED', reason }));
    expect(JSON.stringify(events)).not.toContain(`secret-${reason}`);
  });

  test('authentication dependency failure remains fail-closed', async () => {
    const { ingress, events } = setup({ authentication: { async authenticate() {
      return { ok: false, reason: 'AUTHENTICATION_DEPENDENCY_FAILURE' };
    } } });
    const result = await ingress.handle({ credential: 'secret', command: createCommand(), correlationId: 'auth-dependency' });
    expect(result).toMatchObject({ outcome: 'APPLICATION_REJECTION', error: { code: 'UNAUTHENTICATED' } });
    expect(events).toContainEqual(expect.objectContaining({
      category: 'AUTHENTICATION', outcome: 'DEPENDENCY_FAILURE',
      reason: 'AUTHENTICATION_DEPENDENCY_FAILURE',
    }));
  });

  test('unmapped and disabled principals produce distinct security outcomes', async () => {
    const unmapped = setup({ authority: { async resolve() { return null; } } });
    await unmapped.ingress.handle({ credential: 'token', command: createCommand(), correlationId: 'unmapped' });
    expect(unmapped.events).toContainEqual(expect.objectContaining({ reason: 'PRINCIPAL_NOT_MAPPED' }));

    const disabled = setup({ authority: { async resolve() { return { ...principal, enabled: false }; } } });
    await disabled.ingress.handle({ credential: 'token', command: createCommand(), correlationId: 'disabled' });
    expect(disabled.events).toContainEqual(expect.objectContaining({ reason: 'PRINCIPAL_DISABLED' }));
  });

  test('actor mismatch is observed as authorization rejection', async () => {
    const { ingress, events } = setup();
    const result = await ingress.handle({
      credential: 'token', command: createCommand('actor-mismatch', 100n, makeActorId('impersonated')),
      correlationId: 'actor-mismatch-correlation',
    });
    expect(result).toMatchObject({ outcome: 'APPLICATION_REJECTION', error: { code: 'ACTOR_MISMATCH' } });
    expect(events).toContainEqual(expect.objectContaining({
      category: 'AUTHORIZATION', outcome: 'REJECTED', reason: 'ACTOR_MISMATCH',
    }));
  });

  test('gateway and system authorization failures remain constrained and distinct', async () => {
    const gateway = setup({ authority: { async resolve() { return {
      principalId: 'gateway-observability', type: 'GATEWAY', enabled: true,
      capabilities: [], mappingVersion: 1,
    }; } } });
    await expect(gateway.ingress.handle({
      credential: 'gateway', command: fundCommand(), correlationId: 'gateway-denied',
    })).resolves.toMatchObject({ error: { code: 'COMMAND_NOT_PERMITTED' } });
    expect(gateway.events).toContainEqual(expect.objectContaining({
      category: 'AUTHORIZATION', outcome: 'REJECTED', reason: 'GATEWAY_AUTHORIZATION_FAILURE',
    }));

    const system = setup({ authority: { async resolve() { return {
      principalId: 'system-observability', type: 'SYSTEM', enabled: true,
      capabilities: [], mappingVersion: 1,
    }; } } });
    await expect(system.ingress.handle({
      credential: 'system', command: createCommand('system-denied'), correlationId: 'system-denied',
    })).resolves.toMatchObject({ error: { code: 'COMMAND_NOT_PERMITTED' } });
    expect(system.events).toContainEqual(expect.objectContaining({
      category: 'AUTHORIZATION', outcome: 'REJECTED', reason: 'COMMAND_NOT_PERMITTED',
    }));
  });

  test('post-auth rate-limit rejection and storage failure are distinct and fail closed', async () => {
    const rejected = setup({ limiter: { async consume() { return { allowed: false, retryAfterSeconds: 4 }; } } });
    expect(await rejected.ingress.handle({ credential: 'token', command: createCommand(), correlationId: 'limited' }))
      .toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(rejected.events).toContainEqual(expect.objectContaining({
      category: 'RATE_LIMIT', action: 'POST_AUTH', outcome: 'REJECTED',
    }));

    const failed = setup({ limiter: { async consume() { throw new Error('database password=secret'); } } });
    expect(await failed.ingress.handle({ credential: 'token', command: createCommand(), correlationId: 'limiter-failed' }))
      .toMatchObject({ error: { code: 'RATE_LIMIT_UNAVAILABLE' } });
    expect(failed.events).toContainEqual(expect.objectContaining({
      category: 'RATE_LIMIT', outcome: 'DEPENDENCY_FAILURE', reason: 'FAIL_CLOSED',
    }));
    expect(JSON.stringify(failed.events)).not.toContain('password=secret');
  });

  test('idempotency conflict is observed separately from command failure', async () => {
    const { ingress, events } = setup();
    await ingress.handle({ credential: 'token', command: createCommand('same-command', 100n), correlationId: 'first' });
    const conflict = await ingress.handle({
      credential: 'token', command: createCommand('same-command', 200n), correlationId: 'second',
    });
    expect(conflict).toMatchObject({ outcome: 'APPLICATION_REJECTION', error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(events).toContainEqual(expect.objectContaining({
      category: 'PERSISTENCE', action: 'IDEMPOTENCY', outcome: 'REJECTED',
      reason: 'IDEMPOTENCY_CONFLICT', correlationId: 'second',
    }));
  });

  test('PostgreSQL-shaped command persistence failure is opaque in telemetry', async () => {
    const persistence = new InMemoryPersistenceAdapter();
    jest.spyOn(persistence.commandExecutionStore, 'execute').mockRejectedValue(
      new Error('postgres://user:password@host/private database query'),
    );
    const { ingress, events } = setup({ persistence });
    const result = await ingress.handle({ credential: 'token', command: createCommand(), correlationId: 'postgres-failure' });
    expect(result.outcome).toBe('PERSISTENCE_FAILURE');
    expect(events).toContainEqual(expect.objectContaining({
      category: 'PERSISTENCE', outcome: 'DEPENDENCY_FAILURE', reason: 'POSTGRES_FAILURE',
    }));
    expect(JSON.stringify(events)).not.toContain('password@host');
    expect(JSON.stringify(events)).not.toContain('query');
  });

  test('telemetry backend failure does not weaken or block successful authentication, authorization or rate limiting', async () => {
    const telemetry = failedTelemetry();
    const { ingress } = setup({ telemetry });
    const result = await ingress.handle({ credential: 'valid', command: createCommand(), correlationId: 'pipeline-failure' });
    expect(result.outcome).toBe('SUCCESS');
    expect(telemetry.health().pipelineFailures).toBeGreaterThan(0);
  });

  test('telemetry failure does not weaken authentication rejection', async () => {
    const { ingress } = setup({
      telemetry: failedTelemetry(),
      authentication: { async authenticate() { return { ok: false, reason: 'INVALID_SIGNATURE' }; } },
    });
    await expect(ingress.handle({ credential: 'invalid', command: createCommand(), correlationId: 'failed-auth-log' }))
      .resolves.toMatchObject({ outcome: 'APPLICATION_REJECTION', error: { code: 'UNAUTHENTICATED' } });
  });

  test('telemetry failure does not weaken authorization rejection', async () => {
    const { ingress } = setup({ telemetry: failedTelemetry() });
    await expect(ingress.handle({
      credential: 'valid', command: createCommand('failed-authz-log', 100n, makeActorId('attacker')),
      correlationId: 'failed-authz-log',
    })).resolves.toMatchObject({ outcome: 'APPLICATION_REJECTION', error: { code: 'ACTOR_MISMATCH' } });
  });

  test('telemetry failure does not weaken rate-limit rejection', async () => {
    const { ingress } = setup({
      telemetry: failedTelemetry(),
      limiter: { async consume() { return { allowed: false, retryAfterSeconds: 3 }; } },
    });
    await expect(ingress.handle({ credential: 'valid', command: createCommand(), correlationId: 'failed-limit-log' }))
      .resolves.toMatchObject({ outcome: 'APPLICATION_REJECTION', error: { code: 'RATE_LIMITED' } });
  });
});
