import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
