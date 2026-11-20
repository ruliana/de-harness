// In replay mode (the default, and what CI runs) no test may reach an external network: any such fetch fails loudly.
// Loopback stays open so tests can run their own local servers. Record / passthrough (npm run test:live) keep the real fetch.
const mode = process.env.HARNESS_CASSETTE ?? "replay";
if (mode === "replay") {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).hostname;
    if (host === "127.0.0.1" || host === "localhost" || host === "[::1]") return realFetch(input, init);
    throw new Error(`Network is blocked in replay mode (fetch ${url}). Use a cassette, or run npm run test:live.`);
  }) as typeof fetch;
}
