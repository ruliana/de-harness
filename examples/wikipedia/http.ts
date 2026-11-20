/**
 * HTTP for the example: the cassette over the real network, politely.
 *
 * Wikimedia asks for an identifying User-Agent and answers 429 with Retry-After when asked too fast, so the real
 * network layer identifies itself and waits. Article HTML is megabytes, so what gets recorded is the parsed article
 * (title, lead, body links) as JSON; `createClient` reads both forms.
 */
import { cassetteFetch, cassetteMode, type CassetteMode } from "../../src/index.js";
import { parseArticle } from "./article.js";

const USER_AGENT = "de-harness-example/0.1 (https://github.com/ruliana/de-harness)";
const MAX_TRIES = 12;

async function politeFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("user-agent", USER_AGENT);
  let res: Response;
  for (let attempt = 1; ; attempt++) {
    res = await globalThis.fetch(input, { ...init, headers });
    // Throttled (429) or struggling (5xx, e.g. a 504 on a very large article): wait and ask again. Never record these.
    if (res.status !== 429 && res.status < 500) break;
    if (attempt >= MAX_TRIES) throw new Error(`Wikipedia keeps answering HTTP ${res.status}; try again later`);
    const asked = Number(res.headers.get("retry-after"));
    await new Promise((r) => setTimeout(r, 1000 * Math.min(60, Number.isFinite(asked) && asked > 0 ? asked + 1 : 3 * attempt)));
  }
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (res.ok && url.includes("/api/rest_v1/page/html/")) {
    const { title, lead, links } = parseArticle(await res.text());
    return new Response(JSON.stringify({ title, lead, links }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return res;
}

/**
 * `dir` holds the recordings. In replay mode (the default) nothing leaves the machine.
 *
 * Revisions are fixed (see `SNAPSHOT`), so a recorded article never goes stale: in record mode a page that is already
 * on disk is kept, and only missing ones are fetched. That keeps `npm run test:live` polite to Wikipedia.
 */
export function wikipediaFetch(opts: { dir: string; mode?: CassetteMode }): typeof fetch {
  const mode = opts.mode ?? cassetteMode();
  const replay = cassetteFetch({ dir: opts.dir, mode: "replay" });
  const network = cassetteFetch({ dir: opts.dir, mode, inner: politeFetch as typeof fetch });
  if (mode === "replay") return replay;
  if (mode === "passthrough") return network;
  return async (input, init) => {
    try {
      return await replay(input, init);
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith("no recording for")) throw e;
      return network(input, init);
    }
  };
}
