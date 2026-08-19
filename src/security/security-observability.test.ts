import {
  JsonLineSecurityAlertSink,
  JsonLineSecurityLogSink,
  JsonLineSecurityMetricSink,
  SecurityTelemetry,
  serverCorrelationId,
} from './security-observability';
import type {
  SecurityAlert, SecurityEvent, SecurityEventInput, SecurityLogSink, SecurityMetric,
} from './security-observability';

const thresholds = {
  windowMs: 60_000,
  authenticationFailures: 2,
  rateLimitRejections: 2,
  authenticationDependencyFailures: 1,
  authorizationRejections: 2,
  disabledPrincipalAttempts: 1,
  postgresFailures: 1,
  failClosedDecisions: 1,
  telemetryFailures: 1,
} as const;

function harness(overrides: {
  log?: SecurityLogSink;
  metric?: { record(metric: SecurityMetric): void };
  alert?: { emit(alert: SecurityAlert): void };
} = {}) {
  const events: SecurityEvent[] = [];
  const metrics: SecurityMetric[] = [];
  const alerts: SecurityAlert[] = [];
  const telemetry = new SecurityTelemetry({
    instanceId: 'instance-a',
    log: overrides.log ?? { write(event) { events.push(event); } },
    metrics: overrides.metric ?? { record(metric) { metrics.push(metric); } },
    alerts: overrides.alert ?? { emit(alert) { alerts.push(alert); } },
    thresholds,
    retention: { securityLogDays: 30, metricDays: 14, securityAuditDays: 365 },
    now: () => new Date('2026-08-19T00:00:00.000Z'),
  });
  return { telemetry, events, metrics, alerts };
}

function authenticationFailure(reason = 'INVALID_SIGNATURE'): SecurityEventInput {
  return {
    category: 'AUTHENTICATION', action: 'VERIFY', outcome: 'REJECTED', reason,
    correlationId: 'correlation-1', commandId: 'command-1', commandType: 'CreateCell',
  };
}

describe('Phase 7H security observability contracts', () => {
  test('real JSON-line log, metric and alert serialization are valid and newline-delimited', () => {
    const output: string[] = [];
    const event: SecurityEvent = {
      schemaVersion: 1, occurredAt: '2026-08-19T00:00:00.000Z', category: 'AUTHENTICATION',
      action: 'VERIFY', outcome: 'REJECTED', correlationId: 'correlation-1',
      instanceId: 'instance-a', reason: 'INVALID_SIGNATURE',
    };
    new JsonLineSecurityLogSink((line) => output.push(line)).write(event);
    new JsonLineSecurityMetricSink((line) => output.push(line)).record({
      name: 'zinesh_security_events_total', instanceId: 'instance-a',
      labels: { category: 'AUTHENTICATION' }, value: 1,
    });
    new JsonLineSecurityAlertSink((line) => output.push(line)).emit({
      name: 'BRUTE_FORCE_AUTHENTICATION', severity: 'WARNING',
      occurredAt: event.occurredAt, instanceId: 'instance-a', observed: 2, threshold: 2, windowMs: 60_000,
    });
    expect(output).toHaveLength(3);
    expect(output.every((line) => line.endsWith('\n'))).toBe(true);
    expect(output.map((line) => JSON.parse(line) as object)).toHaveLength(3);
  });

  test('allowlist serialization redacts credentials, JWTs, request bodies, payment data and arbitrary fields', () => {
    const { telemetry, events } = harness();
    const unsafe = {
      ...authenticationFailure(),
      authorization: 'Bearer ey.secret.token', password: 'password-secret',
      requestBody: { paymentCredential: 'card-secret' }, privateKey: 'private-key-secret',
    } as unknown as SecurityEventInput;
    telemetry.record(unsafe);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('ey.secret.token');
    expect(serialized).not.toContain('password-secret');
    expect(serialized).not.toContain('card-secret');
    expect(serialized).not.toContain('private-key-secret');
  });

  test('metric labels are bounded and exclude principal, command and correlation identities', () => {
    const { telemetry, metrics } = harness();
    telemetry.record({ ...authenticationFailure(), principalId: 'principal-user-controlled' });
    expect(metrics[0]?.labels).toEqual({
      category: 'AUTHENTICATION', action: 'VERIFY', outcome: 'REJECTED',
      reason: 'INVALID_SIGNATURE', commandType: 'CreateCell',
    });
    expect(JSON.stringify(metrics)).not.toContain('principal-user-controlled');
    expect(JSON.stringify(metrics)).not.toContain('correlation-1');
    expect(JSON.stringify(metrics)).not.toContain('command-1');
  });

  test('invalid optional metadata is dropped rather than serialized', () => {
    const { telemetry, events } = harness();
    telemetry.record({
      ...authenticationFailure('reason controlled by user'), commandId: 'contains secret whitespace',
      principalId: 'bad/value', commandType: 'UserInventedCommand',
    });
    expect(events[0]).toEqual(expect.not.objectContaining({
      reason: expect.anything(), commandId: expect.anything(), principalId: expect.anything(),
      commandType: expect.anything(),
    }));
  });

  test('unknown but syntactically valid actions and reasons collapse to bounded metric labels', () => {
    const { telemetry, metrics } = harness();
    telemetry.record({
      category: 'INGRESS', action: 'USERCONTROLLED123', outcome: 'REJECTED',
      reason: 'ARBITRARYVALUE123', correlationId: 'bounded-label-test',
    });
    expect(metrics[0]?.labels).toEqual({
      category: 'INGRESS', action: 'OTHER', outcome: 'REJECTED', reason: 'OTHER',
    });
  });

  test('brute-force, rate abuse and authorization anomaly conditions use configured thresholds', () => {
    const { telemetry, alerts } = harness();
    telemetry.record(authenticationFailure()); telemetry.record(authenticationFailure());
    telemetry.record({ category: 'RATE_LIMIT', action: 'PRE_AUTH', outcome: 'REJECTED', correlationId: 'correlation-2' });
    telemetry.record({ category: 'RATE_LIMIT', action: 'PRE_AUTH', outcome: 'REJECTED', correlationId: 'correlation-3' });
    telemetry.record({ category: 'AUTHORIZATION', action: 'COMMAND', outcome: 'REJECTED', correlationId: 'correlation-4' });
    telemetry.record({ category: 'AUTHORIZATION', action: 'COMMAND', outcome: 'REJECTED', correlationId: 'correlation-5' });
    expect(alerts.map((alert) => alert.name)).toEqual(expect.arrayContaining([
      'BRUTE_FORCE_AUTHENTICATION', 'RATE_LIMIT_REJECTION_SURGE', 'AUTHORIZATION_REJECTION_ANOMALY',
    ]));
  });

  test('dependency, disabled-principal and fail-closed conditions are alarm-ready', () => {
    const { telemetry, alerts } = harness();
    telemetry.record({ category: 'AUTHENTICATION', action: 'VERIFY', outcome: 'DEPENDENCY_FAILURE', correlationId: 'c-1' });
    telemetry.record({ category: 'PRINCIPAL', action: 'RESOLVE', outcome: 'REJECTED', reason: 'PRINCIPAL_DISABLED', correlationId: 'c-2' });
    telemetry.record({ category: 'PERSISTENCE', action: 'TRANSACTION', outcome: 'DEPENDENCY_FAILURE', correlationId: 'c-3' });
    telemetry.record({ category: 'RATE_LIMIT', action: 'PRE_AUTH', outcome: 'DEPENDENCY_FAILURE', reason: 'FAIL_CLOSED', correlationId: 'c-4' });
    expect(alerts.map((alert) => alert.name)).toEqual(expect.arrayContaining([
      'AUTHENTICATION_DEPENDENCY_FAILURE', 'DISABLED_PRINCIPAL_ATTEMPTS',
      'POSTGRES_DEPENDENCY_FAILURE', 'FAIL_CLOSED_SURGE',
    ]));
  });

  test('logger, metric and alert failures are isolated and expose pipeline health', () => {
    const telemetry = harness({
      log: { write() { throw new Error('logger token=secret'); } },
      metric: { record() { throw new Error('metrics unavailable'); } },
      alert: { emit() { throw new Error('alerts unavailable'); } },
    }).telemetry;
    expect(() => telemetry.record(authenticationFailure())).not.toThrow();
    expect(telemetry.health()).toEqual({
      pipelineFailures: 1,
      retention: { securityLogDays: 30, metricDays: 14, securityAuditDays: 365 },
    });
  });

  test('high-volume concurrent events remain independent and bounded', async () => {
    const { telemetry, events, metrics } = harness();
    await Promise.all(Array.from({ length: 1_000 }, async (_, index) => {
      telemetry.record({
        category: 'INGRESS', action: 'REQUEST', outcome: 'ACCEPTED',
        correlationId: `correlation-${index}`,
      });
    }));
    expect(events).toHaveLength(1_000);
    expect(metrics).toHaveLength(1_000);
    expect(new Set(metrics.map((metric) => JSON.stringify(metric.labels))).size).toBe(1);
  });

  test('multiple instances retain bounded instance identity only in events and alerts', () => {
    const first = harness();
    const secondEvents: SecurityEvent[] = [];
    const second = new SecurityTelemetry({
      instanceId: 'instance-b', log: { write(event) { secondEvents.push(event); } },
      metrics: { record() {} }, retention: { securityLogDays: 30, metricDays: 14, securityAuditDays: 365 },
    });
    first.telemetry.record(authenticationFailure());
    second.record(authenticationFailure());
    expect(first.events[0]?.instanceId).toBe('instance-a');
    expect(secondEvents[0]?.instanceId).toBe('instance-b');
    expect(first.metrics[0]?.instanceId).toBe('instance-a');
  });

  test('server correlation identity is bounded and never accepts an invalid client value', () => {
    expect(serverCorrelationId('safe-generated-id')).toBe('safe-generated-id');
    expect(serverCorrelationId('Bearer secret value')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('invalid retention, thresholds and unbounded instance identity fail configuration', () => {
    expect(() => new SecurityTelemetry({
      instanceId: 'bad identity', log: { write() {} }, metrics: { record() {} },
      retention: { securityLogDays: 0, metricDays: 1, securityAuditDays: 1 },
    })).toThrow();
    expect(() => new SecurityTelemetry({
      instanceId: 'valid', log: { write() {} }, metrics: { record() {} },
      alerts: { emit() {} }, thresholds: { ...thresholds, telemetryFailures: 0 },
      retention: { securityLogDays: 1, metricDays: 1, securityAuditDays: 1 },
    })).toThrow();
  });
});
