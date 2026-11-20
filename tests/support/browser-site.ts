/**
 * A small web site on loopback for the browser tests. No external network, and every font is bundled, so screenshots look
 * the same wherever the tests run.
 *
 *   /           "Acme Studio": three colour buttons in the first screen, a newsletter signup (email field + Subscribe button) below the fold
 *   /short      a page that fits in one screen (cannot scroll)
 *   /search     a form: type a query, press Enter, read the results on /results?q=...
 *   /popup      a link that opens in a new tab
 *   /leave      a link to the same site under another host name (`localhost` instead of `127.0.0.1`)
 *   /views      a page that changes its view without loading a page (history.pushState), so going back stays on the same document
 *   /pricing    a plain page
 *   /notice     a pop-up whose close button is 16 x 16 px (its x about 9 px wide), a CONTINUE button that lights up under the pointer but closes nothing
 *   /click-menu a menu entry that opens its menu when pressed; pointing at it only underlines it
 *   /hover-menu a menu entry that opens its menu when pointed at; pressing it only counts a press
 *   /sizes      an item page whose size buttons are below the fold ("Selected: none" until one is pressed)
 *   /slow-go    a link to /slow-page, which is sent after 2.2 s, longer than the browser waits for the network to go quiet (a page that loads slowly after a click)
 *   /cards      a card whose middle is not pressable: a picture link above a row of colour dots (not links) and a gap
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
const VIEWS = page(
  "Views",
  `${header}<main><h1 id="view">View one</h1><button class="colour" id="next" style="background:#2563eb">Next view</button></main>`,
  `document.getElementById('next').addEventListener('click', () => { history.pushState({}, '', '/views?view=two'); document.getElementById('view').textContent = 'View two'; });
window.addEventListener('popstate', () => { document.getElementById('view').textContent = location.search ? 'View two' : 'View one'; });`,
);

const NOTICE = page(
  "Notice",
  `${header}<main><h1>Spring collection</h1><p>The page behind the notice.</p></main>
<div id="notice" style="position:fixed;top:140px;left:280px;width:720px;height:150px;background:#ffffff;border:2px solid #111827;border-radius:6px;z-index:10;padding:24px 32px">
  <button id="close" aria-label="Close modal" style="position:absolute;top:6px;right:6px;width:16px;height:16px;padding:0;background:#ffffff;color:#111827;font:400 20px/14px 'Test Sans';border-radius:0">&times;</button>
  <p style="margin:0 0 16px">We use cookies to improve your visit.</p>
  <button id="continue" style="width:320px;height:48px;background:#374151">CONTINUE</button>
</div>`,
  `document.getElementById('close').addEventListener('click', () => document.getElementById('notice').remove());`,
);
const NOTICE_CSS = `<style>#continue:hover{background:#d97706 !important}</style>`;

const CLICK_MENU = page(
  "Click menu",
  `${header}<main><nav id="top" style="display:flex;gap:40px;margin:24px 0"><a href="#" id="shoes" style="color:#111827;text-decoration:none">Shoes</a><a href="#" style="color:#111827;text-decoration:none">Bags</a></nav>
<div id="menu" style="display:none;width:520px;padding:16px 24px;background:#f3f4f6;border:1px solid #9ca3af"><a href="/pricing" id="sneakers">Sneakers</a><br><a href="/short" id="boots">Boots</a></div></main>
<style>#top a:hover{text-decoration:underline !important}</style>`,
  `document.getElementById('shoes').addEventListener('click', (e) => { e.preventDefault(); document.getElementById('menu').style.display = 'block'; });`,
);

const HOVER_MENU = page(
  "Hover menu",
  `${header}<main><nav id="top" style="display:flex;gap:40px;margin:24px 0"><div id="shoes-item"><a href="#" id="shoes" style="color:#111827;text-decoration:none">Shoes</a><div id="menu" style="display:none;position:absolute;width:520px;padding:16px 24px;background:#f3f4f6;border:1px solid #9ca3af"><a href="/pricing">Sneakers</a><br><a href="/short">Boots</a></div></div><a href="#" style="color:#111827;text-decoration:none">Bags</a></nav>
<p id="presses">Presses: 0</p></main>
<style>#shoes-item:hover #menu{display:block !important}</style>`,
  `let n = 0; document.getElementById('shoes').addEventListener('click', (e) => { e.preventDefault(); document.getElementById('presses').textContent = 'Presses: ' + (++n); });`,
);

const SIZES = page(
  "Item",
  `${header}<main><h1>Storm Chaser</h1><div style="height:760px;background:#e5e7eb;margin-bottom:60px">A big picture of the boot.</div>
<p>Pick a size</p><div class="row"><button class="colour" id="size-9" style="background:#374151;width:90px">9</button><button class="colour" id="size-10" style="background:#374151;width:90px">10</button><button class="colour" id="size-11" style="background:#374151;width:90px">11</button></div>
<p id="pick">Selected: none</p><div style="height:400px"></div></main>`,
  `for (const b of document.querySelectorAll('.colour')) b.addEventListener('click', () => { document.getElementById('pick').textContent = 'Selected: ' + b.textContent; });`,
);

const SLOW_GO = page("Slow go", `${header}<main><h1>Slow go</h1><p><a id="go" href="/slow-page" style="font-size:32px">Open the slow page</a></p></main>`);
const SLOW_PAGE = page("Slow page", `${header}<main><h1>The slow page</h1><p>It arrived.</p></main>`);

const CARDS = page(
  "Cards",
  `${header}<main><h1>Boots</h1><div id="card" style="width:300px;height:380px;border:1px solid #d1d5db">
<a id="boot" href="/pricing" style="display:block;height:240px;background:#92400e;color:#ffffff">The brown boot</a>
<div id="dots" style="height:70px;padding:24px"><span style="display:inline-block;width:22px;height:22px;border-radius:11px;background:#92400e"></span> <span style="display:inline-block;width:22px;height:22px;border-radius:11px;background:#111827"></span></div></div></main>`,
);

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
      case "/notice": return send(NOTICE.replace("</head>", `${NOTICE_CSS}</head>`));
      case "/click-menu": return send(CLICK_MENU);
      case "/hover-menu": return send(HOVER_MENU);
      case "/sizes": return send(SIZES);
      case "/cards": return send(CARDS);
      case "/slow-go": return send(SLOW_GO);
      case "/slow-page": return void setTimeout(() => send(SLOW_PAGE), 2200);
      case "/views": return send(VIEWS);
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
