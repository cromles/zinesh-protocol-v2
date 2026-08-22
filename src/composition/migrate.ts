/**
 * ZINESH PROTOCOL V2 — One-shot production schema apply
 *
 * Same artifact as serving. Not a traffic process. Not HTTPS. Not JWT.
 * Applies schema, verifies expected version, then exits.
 */

import { PostgresPersistenceAdapter } from '../adapters/postgres-persistence-adapter';
import { ConfigurationError, loadPostgresConfig } from './main';
import type { EnvMap } from './main';

export async function migrateMain(
  env: EnvMap = process.env,
  exit: (code: number) => void = (code) => {
    process.exit(code);
  },
): Promise<void> {
  let persistence: PostgresPersistenceAdapter | undefined;
  try {
    const config = loadPostgresConfig(env);
    persistence = new PostgresPersistenceAdapter(config);
    await persistence.connect();
    await persistence.migrator.migrate();
    await persistence.migrator.verifyExpectedVersion();
    await persistence.disconnect();
    persistence = undefined;
    exit(0);
  } catch (error) {
    try {
      await persistence?.disconnect();
    } catch {
      // Opaque failure only. Do not expose disconnect errors.
    }
    if (error instanceof ConfigurationError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write('Persistence startup failed\n');
    }
    exit(1);
  }
}

const executedDirectly =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

if (executedDirectly) {
  void migrateMain();
}
