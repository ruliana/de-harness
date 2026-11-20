// In replay mode (the default, and what CI runs) no test may touch the network: any real fetch fails loudly.
// Record / passthrough modes (npm run test:live) keep the real fetch.
const mode = process.env.HARNESS_CASSETTE ?? "replay";
if (mode === "replay") {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`Network is blocked in replay mode (fetch ${String(input)}). Use a cassette, or run npm run test:live.`);
  }) as typeof fetch;
}
