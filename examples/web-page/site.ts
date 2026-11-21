/**
 * The integrator's server for the example: serves the page, the browser bundle, and the Jev proxy, on loopback.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jevProxy, type JevProxyOptions } from "./proxy.js";

const PAGE = fileURLToPath(new URL("page.html", import.meta.url));

export type WebPageSite = { url: string; close(): Promise<void> };

/** `bundleDir` holds `de-harness.iife.min.js` (`npm run build` puts it in `dist/`). */
export async function startWebPageSite(opts: JevProxyOptions & { bundleDir: string; port?: number }): Promise<WebPageSite> {
  const proxy = jevProxy(opts);
  const server = createServer(async (req, res) => {
    if (await proxy(req, res)) return;
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(PAGE));
    } else if (req.method === "GET" && req.url === "/de-harness.iife.min.js") {
      res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(join(opts.bundleDir, "de-harness.iife.min.js")));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
