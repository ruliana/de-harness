import { defineConfig } from "vitest/config";

// Acceptance tests only. Jev and external HTTP are answered from committed cassettes unless
// HARNESS_CASSETTE=record (npm run test:live).
export default defineConfig({
  test: {
    include: ["tests/acceptance/**/*.test.ts"],
    setupFiles: ["tests/support/setup.ts"],
    // The look-alike shop listens on a fixed port (it is part of every recorded request), so test files take turns
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
