import { defineConfig } from "vitest/config";

// The behaviour spec (tests/spec): acceptance tests for how the agent reads instructions. They describe what a harness
// should do and some FAIL today, on purpose, so they are kept out of `npm test` (the Premerge gate). Same cassettes and
// replay rules as the acceptance tests: `npm run test:spec` replays, `npm run test:spec:live` re-records.
export default defineConfig({
  test: {
    include: ["tests/spec/**/*.test.ts"],
    setupFiles: ["tests/support/setup.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
