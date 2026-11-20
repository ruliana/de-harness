import { defineConfig } from "vitest/config";

// Acceptance tests only. Jev and external HTTP are answered from committed cassettes unless
// HARNESS_CASSETTE=record (npm run test:live).
export default defineConfig({
  test: {
    include: ["tests/acceptance/**/*.test.ts"],
    setupFiles: ["tests/support/setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
