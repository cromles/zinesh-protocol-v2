import type { PostgresConfig } from '../adapters/postgres-persistence-adapter';
import type { SecurityTelemetry } from '../security/security-observability';
import { noOpSecurityTelemetry } from '../security/security-observability';
import { composeRuntime } from '../composition/main';
import type { ComposedRuntime, SecurityPorts } from '../composition/main';
import type { RateLimitingConfig } from '../composition/main';
import { PrototypeFundingEvidence } from './prototype-funding';

/** Composition entry available only from the development build. */
export function composeDevelopmentRuntime(
  config: PostgresConfig,
  security: Partial<SecurityPorts> = {},
  rateLimiting?: RateLimitingConfig,
  telemetry: SecurityTelemetry = noOpSecurityTelemetry,
): ComposedRuntime {
  return composeRuntime(config, { ...security, prototypeFundingEvidence: new PrototypeFundingEvidence() },
    rateLimiting, telemetry, { environment: 'development', enabled: true });
}
