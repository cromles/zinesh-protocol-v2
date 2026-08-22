import { randomUUID } from 'crypto';

export type SecurityEventCategory =
  | 'AUTHENTICATION'
  | 'PRINCIPAL'
  | 'AUTHORIZATION'
  | 'INGRESS'
  | 'RATE_LIMIT'
  | 'PERSISTENCE'
  | 'TLS'
  | 'TELEMETRY';

export type SecurityEventOutcome =
  | 'SUCCESS'
  | 'FAILURE'
  | 'ALLOWED'
  | 'REJECTED'
  | 'ACCEPTED'
  | 'DEPENDENCY_FAILURE';

export interface SecurityEvent {
  readonly schemaVersion: 1;
  readonly occurredAt: string;
  readonly category: SecurityEventCategory;
  readonly action: string;
  readonly outcome: SecurityEventOutcome;
  readonly correlationId: string;
  readonly instanceId: string;
  readonly reason?: string;
  readonly commandId?: string;
  readonly principalId?: string;
  readonly commandType?: string;
  readonly durationMs?: number;
}

export interface SecurityEventInput {
  readonly category: SecurityEventCategory;
  readonly action: string;
  readonly outcome: SecurityEventOutcome;
  readonly correlationId: string;
  readonly reason?: string;
  readonly commandId?: string;
  readonly principalId?: string;
  readonly commandType?: string;
  readonly durationMs?: number;
}

export interface SecurityLogSink { write(event: SecurityEvent): void }

export interface SecurityMetric {
  readonly name: string;
  readonly instanceId: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

export interface SecurityMetricSink { record(metric: SecurityMetric): void }

export interface SecurityAlert {
  readonly name: string;
  readonly severity: 'WARNING' | 'CRITICAL';
  readonly occurredAt: string;
  readonly instanceId: string;
  readonly observed: number;
  readonly threshold: number;
  readonly windowMs: number;
}

export interface SecurityAlertSink { emit(alert: SecurityAlert): void }

export interface SecurityAlertThresholds {
  readonly windowMs: number;
  readonly authenticationFailures: number;
  readonly rateLimitRejections: number;
  readonly authenticationDependencyFailures: number;
  readonly authorizationRejections: number;
  readonly disabledPrincipalAttempts: number;
  readonly postgresFailures: number;
  readonly failClosedDecisions: number;
  readonly telemetryFailures: number;
}

export interface TelemetryRetentionPolicy {
  readonly securityLogDays: number;
  readonly metricDays: number;
  readonly securityAuditDays: number;
}

export interface SecurityTelemetryOptions {
  readonly instanceId: string;
  readonly log: SecurityLogSink;
  readonly metrics: SecurityMetricSink;
  readonly alerts?: SecurityAlertSink;
  readonly thresholds?: SecurityAlertThresholds;
  readonly retention: TelemetryRetentionPolicy;
  readonly now?: () => Date;
}

const CATEGORIES = new Set<SecurityEventCategory>([
  'AUTHENTICATION', 'PRINCIPAL', 'AUTHORIZATION', 'INGRESS',
  'RATE_LIMIT', 'PERSISTENCE', 'TLS', 'TELEMETRY',
]);
const OUTCOMES = new Set<SecurityEventOutcome>([
  'SUCCESS', 'FAILURE', 'ALLOWED', 'REJECTED', 'ACCEPTED', 'DEPENDENCY_FAILURE',
]);
const SAFE_TOKEN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COMMAND_TYPES = new Set([
  'CreateCell', 'FundCell', 'RequestRelease', 'ApproveRelease', 'RequestRefund',
  'ApproveRefund', 'ForceRefund', 'ExpireCell', 'OpenDispute', 'ResolveDispute',
]);
const METRIC_ACTIONS = new Set([
  'VERIFY', 'RESOLVE', 'POST_AUTH', 'PRE_AUTH', 'COMMAND', 'IDEMPOTENCY', 'TRANSACTION',
  'PRINCIPAL_QUERY', 'CREDENTIAL', 'REQUEST', 'CONFIGURATION', 'HANDSHAKE', 'PIPELINE',
  'LEGACY_AUDIT', 'CREATE', 'ENABLE', 'DISABLE', 'ACTOR_MAPPING', 'CAPABILITY_ASSIGN',
  'CAPABILITY_REVOKE', 'IDENTITY_ATTACH', 'SECURITY_AUDIT',
]);
const METRIC_REASONS = new Set([
  'MALFORMED_CREDENTIAL', 'INVALID_SIGNATURE', 'INVALID_ISSUER', 'INVALID_AUDIENCE',
  'UNSUPPORTED_ALGORITHM', 'EXPIRED_CREDENTIAL', 'CREDENTIAL_NOT_ACTIVE', 'UNKNOWN_KEY',
  'AUTHENTICATION_DEPENDENCY_FAILURE', 'PRINCIPAL_NOT_MAPPED', 'PRINCIPAL_DISABLED',
  'PRINCIPAL_AUTHORITY_FAILURE', 'COMMAND_NOT_PERMITTED', 'FUNDING_EVIDENCE_INVALID',
  'GATEWAY_AUTHORIZATION_FAILURE', 'ACTOR_MISMATCH', 'GATEWAY_DENIED', 'AUTHORIZATION_DENIED',
  'IDEMPOTENCY_CONFLICT', 'POSTGRES_FAILURE', 'PERSISTENCE_FAILURE', 'FAIL_CLOSED',
  'HTTPS_REQUIRED', 'UNTRUSTED_HOST', 'UNTRUSTED_FORWARDING', 'TLS_CONFIGURATION_REJECTED',
  'TLS_REJECTION', 'NOT_FOUND', 'RATE_LIMITED', 'RATE_LIMIT_UNAVAILABLE',
  'UNSUPPORTED_MEDIA_TYPE', 'UNAUTHENTICATED', 'MALFORMED_JSON', 'INVALID_REQUEST',
  'MISSING_COMMAND_ID', 'INVALID_COMMAND', 'UNSUPPORTED_COMMAND', 'REQUEST_TOO_LARGE',
  'INTERNAL_FAILURE', 'RUNTIME_UNAVAILABLE', 'INVALID_INPUT', 'ILLEGAL_TRANSITION', 'INVARIANT_VIOLATION',
  'UNKNOWN_COMMAND', 'PRECONDITION_FAILED', 'DEADLINE_VIOLATION', 'STREAM_INTEGRITY_ERROR',
  'TELEMETRY_FAILURE', 'CONFLICT', 'NOT_FOUND', 'INVALID',
]);

export class JsonLineSecurityLogSink implements SecurityLogSink {
  constructor(private readonly output: (line: string) => void = (line) => process.stdout.write(line)) {}

  write(event: SecurityEvent): void {
    this.output(`${JSON.stringify(event)}\n`);
  }
}

export class JsonLineSecurityMetricSink implements SecurityMetricSink {
  constructor(private readonly output: (line: string) => void = (line) => process.stdout.write(line)) {}

  record(metric: SecurityMetric): void {
    this.output(`${JSON.stringify({ type: 'SECURITY_METRIC', ...metric })}\n`);
  }
}

export class JsonLineSecurityAlertSink implements SecurityAlertSink {
  constructor(private readonly output: (line: string) => void = (line) => process.stderr.write(line)) {}

  emit(alert: SecurityAlert): void {
    this.output(`${JSON.stringify({ type: 'SECURITY_ALERT_CONDITION', ...alert })}\n`);
  }
}

export class SecurityTelemetry {
  private readonly now: () => Date;
  private readonly evaluator?: AlertConditionEvaluator;
  private pipelineFailureCount = 0;

  constructor(private readonly options: SecurityTelemetryOptions) {
    validateOptions(options);
    this.now = options.now ?? (() => new Date());
    if (options.alerts !== undefined && options.thresholds !== undefined) {
      this.evaluator = new AlertConditionEvaluator(
        options.instanceId, options.thresholds, options.alerts, this.now,
      );
    }
  }

  record(input: SecurityEventInput): void {
    const event = safeEvent(input, this.options.instanceId, this.now());
    let failed = false;
    try { this.options.log.write(event); } catch { failed = true; }
    try {
      for (const metric of toMetrics(event)) this.options.metrics.record(metric);
    } catch { failed = true; }
    try { this.evaluator?.observe(event); } catch { failed = true; }
    if (failed && event.category !== 'TELEMETRY') this.recordPipelineFailure(event.correlationId);
  }

  health(): { readonly pipelineFailures: number; readonly retention: TelemetryRetentionPolicy } {
    return { pipelineFailures: this.pipelineFailureCount, retention: this.options.retention };
  }

  private recordPipelineFailure(correlationId: string): void {
    this.pipelineFailureCount += 1;
    const event = safeEvent({
      category: 'TELEMETRY', action: 'PIPELINE', outcome: 'DEPENDENCY_FAILURE',
      correlationId, reason: 'TELEMETRY_FAILURE',
    }, this.options.instanceId, this.now());
    try { this.options.log.write(event); } catch { /* Failure-isolated by design. */ }
    try {
      for (const metric of toMetrics(event)) this.options.metrics.record(metric);
    } catch { /* Failure-isolated by design. */ }
    try { this.evaluator?.observe(event); } catch { /* Failure-isolated by design. */ }
  }
}

export const noOpSecurityTelemetry = new SecurityTelemetry({
  instanceId: 'noop',
  log: { write() { /* Intentionally disabled. */ } },
  metrics: { record() { /* Intentionally disabled. */ } },
  retention: { securityLogDays: 1, metricDays: 1, securityAuditDays: 1 },
});

export function serverCorrelationId(candidate: unknown = randomUUID()): string {
  return typeof candidate === 'string' && SAFE_IDENTIFIER.test(candidate) ? candidate : randomUUID();
}

function safeEvent(input: SecurityEventInput, instanceId: string, now: Date): SecurityEvent {
  if (!CATEGORIES.has(input.category) || !OUTCOMES.has(input.outcome)
    || !SAFE_TOKEN.test(input.action) || !SAFE_IDENTIFIER.test(input.correlationId)) {
    throw new Error('Invalid security telemetry event');
  }
  const base: SecurityEvent = {
    schemaVersion: 1,
    occurredAt: now.toISOString(),
    category: input.category,
    action: input.action,
    outcome: input.outcome,
    correlationId: input.correlationId,
    instanceId,
  };
  return {
    ...base,
    ...(safeToken(input.reason) === undefined ? {} : { reason: safeToken(input.reason)! }),
    ...(safeIdentifier(input.commandId) === undefined ? {} : { commandId: safeIdentifier(input.commandId)! }),
    ...(safeIdentifier(input.principalId) === undefined ? {} : { principalId: safeIdentifier(input.principalId)! }),
    ...(input.commandType !== undefined && COMMAND_TYPES.has(input.commandType)
      ? { commandType: input.commandType } : {}),
    ...(input.durationMs !== undefined && Number.isSafeInteger(input.durationMs) && input.durationMs >= 0
      ? { durationMs: input.durationMs } : {}),
  };
}

function toMetrics(event: SecurityEvent): SecurityMetric[] {
  const labels: Record<string, string> = {
    category: event.category,
    action: METRIC_ACTIONS.has(event.action) ? event.action : 'OTHER',
    outcome: event.outcome,
  };
  if (event.reason !== undefined) labels.reason = METRIC_REASONS.has(event.reason) ? event.reason : 'OTHER';
  if (event.commandType !== undefined) labels.commandType = event.commandType;
  const boundedLabels = Object.freeze(labels);
  const metrics: SecurityMetric[] = [{
    name: 'zinesh_security_events_total', instanceId: event.instanceId, labels: boundedLabels, value: 1,
  }];
  if (event.durationMs !== undefined) {
    metrics.push({
      name: 'zinesh_security_duration_ms', instanceId: event.instanceId,
      labels: boundedLabels, value: event.durationMs,
    });
  }
  return metrics;
}

function safeToken(value: string | undefined): string | undefined {
  return value !== undefined && SAFE_TOKEN.test(value) ? value : undefined;
}

function safeIdentifier(value: string | undefined): string | undefined {
  return value !== undefined && SAFE_IDENTIFIER.test(value) ? value : undefined;
}

function validateOptions(options: SecurityTelemetryOptions): void {
  if (!SAFE_IDENTIFIER.test(options.instanceId)) throw new Error('Invalid telemetry instance identity');
  const retention = options.retention;
  if (![retention.securityLogDays, retention.metricDays, retention.securityAuditDays]
    .every((value) => Number.isSafeInteger(value) && value > 0 && value <= 3_650)) {
    throw new Error('Invalid telemetry retention policy');
  }
  if (options.thresholds !== undefined) {
    const values = Object.values(options.thresholds);
    if (!values.every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new Error('Invalid security alert thresholds');
    }
  }
}

type SignalName = Exclude<keyof SecurityAlertThresholds, 'windowMs'>;

class AlertConditionEvaluator {
  private readonly observations = new Map<SignalName, number[]>();
  private readonly lastAlertAt = new Map<SignalName, number>();

  constructor(
    private readonly instanceId: string,
    private readonly thresholds: SecurityAlertThresholds,
    private readonly sink: SecurityAlertSink,
    private readonly now: () => Date,
  ) {}

  observe(event: SecurityEvent): void {
    const signals = signalsFor(event);
    const nowMs = this.now().getTime();
    for (const signal of signals) {
      const current = this.observations.get(signal) ?? [];
      const retained = current.filter((time) => time > nowMs - this.thresholds.windowMs);
      if (retained.length >= this.thresholds[signal]) retained.shift();
      retained.push(nowMs);
      this.observations.set(signal, retained);
      const threshold = this.thresholds[signal];
      const last = this.lastAlertAt.get(signal) ?? Number.NEGATIVE_INFINITY;
      if (retained.length >= threshold && nowMs - last >= this.thresholds.windowMs) {
        this.sink.emit({
          name: alertName(signal), severity: severity(signal), occurredAt: this.now().toISOString(),
          instanceId: this.instanceId, observed: retained.length, threshold,
          windowMs: this.thresholds.windowMs,
        });
        this.lastAlertAt.set(signal, nowMs);
      }
    }
  }
}

function signalsFor(event: SecurityEvent): SignalName[] {
  const signals: SignalName[] = [];
  if (event.category === 'AUTHENTICATION' && event.outcome === 'REJECTED') signals.push('authenticationFailures');
  if (event.category === 'RATE_LIMIT' && event.outcome === 'REJECTED') signals.push('rateLimitRejections');
  if (event.category === 'AUTHENTICATION' && event.outcome === 'DEPENDENCY_FAILURE') {
    signals.push('authenticationDependencyFailures');
  }
  if (event.category === 'AUTHORIZATION' && event.outcome === 'REJECTED') signals.push('authorizationRejections');
  if (event.category === 'PRINCIPAL' && event.reason === 'PRINCIPAL_DISABLED') signals.push('disabledPrincipalAttempts');
  if (event.category === 'PERSISTENCE' && event.outcome === 'DEPENDENCY_FAILURE') signals.push('postgresFailures');
  if (event.reason === 'FAIL_CLOSED') signals.push('failClosedDecisions');
  if (event.category === 'TELEMETRY' && event.outcome === 'DEPENDENCY_FAILURE') signals.push('telemetryFailures');
  return signals;
}

function alertName(signal: SignalName): string {
  const names: Record<SignalName, string> = {
    authenticationFailures: 'BRUTE_FORCE_AUTHENTICATION',
    rateLimitRejections: 'RATE_LIMIT_REJECTION_SURGE',
    authenticationDependencyFailures: 'AUTHENTICATION_DEPENDENCY_FAILURE',
    authorizationRejections: 'AUTHORIZATION_REJECTION_ANOMALY',
    disabledPrincipalAttempts: 'DISABLED_PRINCIPAL_ATTEMPTS',
    postgresFailures: 'POSTGRES_DEPENDENCY_FAILURE',
    failClosedDecisions: 'FAIL_CLOSED_SURGE',
    telemetryFailures: 'TELEMETRY_PIPELINE_FAILURE',
  };
  return names[signal];
}

function severity(signal: SignalName): 'WARNING' | 'CRITICAL' {
  return ['authenticationDependencyFailures', 'postgresFailures', 'telemetryFailures'].includes(signal)
    ? 'CRITICAL' : 'WARNING';
}
