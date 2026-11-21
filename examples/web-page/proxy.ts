/**
 * The proxy an integrator hosts so that a web page can use Jev without ever holding a key. About forty lines; the same
 * shape works as a Cloudflare Worker, a Vercel function or an Express route.
 *
 * The page points `JevModel` at it: `new JevModel({ baseUrl: location.origin + "/api/jev" })`. The proxy forwards only
 * `POST /api/jev/v1/systemone`, drops whatever `Authorization` the page sent, and adds the server's own key. Jev refuses
 * requests from browser origins (CORS), so a server in between is needed anyway; this is where the integrator adds
 * their login check and rate limits.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export const JEV_PATH = "/api/jev/v1/systemone";

export type JevProxyOptions = {
  /** The integrator's TypeSafe key. Stays on the server. */
  apiKey: string;
  /** Default https://api.typesafe.ai. */
  upstream?: string;
  /** Default the global fetch; tests pass a cassette. */
  fetch?: typeof fetch;
  /** Called with each forwarded request, after the key is added. */
  onForward?: (headers: Record<string, string>) => void;
};

/** Handles a request if it is for the proxy and returns true; returns false for anything else. */
export function jevProxy(opts: JevProxyOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const upstream = opts.upstream ?? "https://api.typesafe.ai";
  return async (req, res) => {
    if (req.url !== JEV_PATH) return false;
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return true;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` };
    const images = req.headers["typesafe-danger-zone-images"];
    if (typeof images === "string") headers["TypeSafe-Danger-Zone-Images"] = images;
    opts.onForward?.(headers);
    try {
      const r = await (opts.fetch ?? globalThis.fetch)(`${upstream}/v1/systemone`, { method: "POST", headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" }).end(await r.text());
    } catch (e) {
      // an upstream failure reaches the page as an error status, never as an answer
      res.writeHead(502, { "content-type": "text/plain" }).end(`proxy: ${(e as Error).message}`);
    }
    return true;
  };
}
