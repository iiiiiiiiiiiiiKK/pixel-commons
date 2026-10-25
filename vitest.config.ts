import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
    // The Durable Object logic is covered by the integration suite that runs
    // against a real workerd instance (see tests/integration.mjs); unit tests here
    // stay pure so they are fast and deterministic.
    testTimeout: 20_000,
  },
});
