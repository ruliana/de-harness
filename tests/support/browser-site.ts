/**
 * A small web site on loopback for the browser tests. No external network, and every font is bundled, so screenshots look
 * the same wherever the tests run.
 *
 *   /           "Acme Studio": three colour buttons in the first screen, a newsletter signup (email field + Subscribe button) below the fold
 *   /short      a page that fits in one screen (cannot scroll)
 *   /search     a form: type a query, press Enter, read the results on /results?q=...
 *   /popup      a link that opens in a new tab
 *   /leave      a link to the same site under another host name (`localhost` instead of `127.0.0.1`)
 *   /pricing    a plain page
 * POST /api/subscribe records the address; `requests` keeps every request path.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

const fonts = join(import.meta.dirname, "fixtures");

const CSS = `
@font-face { font-family: "Test Sans"; src: url(/fonts/DejaVuSans-ascii.woff); font-weight: 400; }
@font-face { font-family: "Test Sans"; src: url(/fonts/DejaVuSans-Bold-ascii.woff); font-weight: 700; }
* { box-sizing: border-box; }
body { margin: 0; font: 400 20px/28px "Test Sans", sans-serif; color: #111827; background: #ffffff; }
header { height: 80px; background: #1f2937; color: #ffffff; display: flex; align-items: center; justify-content: space-between; padding: 0 40px; }
header b { font-size: 26px; }
nav a { color: #ffffff; margin-left: 32px; text-decoration: none; }
main { padding: 0 120px; }
h1 { font: 700 40px/48px "Test Sans"; margin: 60px 0 24px; }
.row { display: flex; gap: 40px; }
button { border: 0; border-radius: 8px; color: #ffffff; font: 700 22px "Test Sans"; cursor: pointer; }
.colour { width: 220px; height: 80px; }
#red { background: #dc2626; } #green { background: #15803d; } #blue { background: #2563eb; }
#pick { margin-top: 24px; }
.filler { height: 880px; margin-top: 40px; color: #6b7280; }
#newsletter { height: 300px; }
#email { width: 420px; height: 52px; font: 400 20px "Test Sans"; padding: 0 12px; border: 2px solid #6b7280; border-radius: 8px; }
#subscribe { width: 200px; height: 56px; margin-left: 16px; background: #7c3aed; }
#thanks { margin-top: 24px; font-weight: 700; color: #15803d; }
footer { height: 120px; background: #e5e7eb; padding: 40px 120px; }
`;

const page = (title: string, body: string, script = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style></head><body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;

const header = `<header><b>Acme Studio</b><nav><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/search">Search</a></nav></header>`;

const HOME = page(
  "Acme Studio",
  `${header}<main>
<h1>Pick a colour</h1>
<div class="row"><button class="colour" id="red">Red</button><button class="colour" id="green">Green</button><button class="colour" id="blue">Blue</button></div>
<p id="pick">Last pick: none</p>
<div class="filler">Keep scrolling: the newsletter signup is at the bottom of this page.</div>
<section id="newsletter"><h1>Newsletter</h1><input id="email" type="email" placeholder="Email address"><button id="subscribe">Subscribe</button><p id="thanks"></p></section>
</main><footer>Acme Studio, 2026</footer>`,
  `
for (const b of document.querySelectorAll('.colour')) b.addEventListener('click', () => { document.getElementById('pick').textContent = 'Last pick: ' + b.textContent; });
document.getElementById('subscribe').addEventListener('click', async () => {
  const email = document.getElementById('email').value;
  await fetch('/api/subscribe', { method: 'POST', body: JSON.stringify({ email }) });
  document.getElementById('thanks').textContent = 'Thanks for subscribing, ' + email;
});`,
);

const SHORT = page("Short page", `${header}<main><h1>Nothing to scroll</h1><p>This page fits in one screen.</p></main>`);
const PRICING = page("Pricing", `${header}<main><h1>Pricing</h1><p>One plan: 12 dollars a month.</p></main>`);
const SEARCH = page("Search", `${header}<main><h1>Search</h1><form action="/results"><input id="q" name="q" type="text" placeholder="Search the site" style="width:420px;height:52px;font:400 20px 'Test Sans';padding:0 12px"></form></main>`);
const results = (q: string) => page("Results", `${header}<main><h1>Results</h1><p id="results">Results for: ${q.replace(/[<>&]/g, "")}</p></main>`);
const POPUP = page("Popup", `${header}<main><h1>Links</h1><p><a id="out" href="/pricing" target="_blank">See pricing in a new tab</a></p></main>`);
const leave = (other: string) => page("Leave", `${header}<main><h1>Elsewhere</h1><p><a id="away" href="${other}/pricing">Go to the other host</a></p></main>`);

export type BrowserSite = {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** The same server under another host name: `http://localhost:<port>`. */
  otherHostUrl: string;
  requests: string[];
  subscriptions: string[];
  close(): Promise<void>;
};

export async function startBrowserSite(opts: { port?: number } = {}): Promise<BrowserSite> {
  const requests: string[] = [];
  const subscriptions: string[] = [];
  let port = 0;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    requests.push(`${req.method} ${url.pathname}`);
    const send = (body: string | Buffer, type = "text/html; charset=utf-8") => {
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (url.pathname.startsWith("/fonts/")) return send(readFileSync(join(fonts, url.pathname.slice("/fonts/".length).replace(/[^\w.-]/g, ""))), "font/woff");
    if (req.method === "POST" && url.pathname === "/api/subscribe") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        subscriptions.push((JSON.parse(body) as { email: string }).email);
        send("{}", "application/json");
      });
      return;
    }
    switch (url.pathname) {
      case "/": return send(HOME);
      case "/short": return send(SHORT);
      case "/pricing": return send(PRICING);
      case "/search": return send(SEARCH);
      case "/results": return send(results(url.searchParams.get("q") ?? ""));
      case "/popup": return send(POPUP);
      case "/leave": return send(leave(`http://localhost:${port}`));
      default:
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    otherHostUrl: `http://localhost:${port}`,
    requests,
    subscriptions,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
