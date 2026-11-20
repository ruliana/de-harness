/**
 * A Shopify look-alike served on loopback: the home page with a menu, collection pages (products.json) and product pages (.js),
 * in the shapes the real shop uses. Lets tests control what the shop offers. Every request path is kept.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeVariant = { colour?: string; size: string; price: number; available?: boolean };
export type FakeProduct = { handle: string; title: string; type: string; variants: FakeVariant[] };
export type FakeCollection = { handle: string; title: string; section: string; group: string; products: string[] };

const optionNames = (p: FakeProduct) => (p.variants.some((v) => v.colour) ? ["Color", "Size"] : ["Size"]);
const distinct = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];

function rawVariant(p: FakeProduct, v: FakeVariant, cents: boolean) {
  const opts = p.variants.some((x) => x.colour) ? [v.colour, v.size] : [v.size];
  return { option1: opts[0] ?? null, option2: opts[1] ?? null, option3: null, price: cents ? v.price * 100 : v.price.toFixed(2), available: v.available ?? true, title: opts.join(" / ") };
}

const options = (p: FakeProduct) => optionNames(p).map((name) => ({ name, values: distinct(p.variants.map((v) => (name === "Color" ? v.colour : v.size))) }));

export function homeHtml(collections: FakeCollection[], currency = "USD"): string {
  const groups = new Map<string, FakeCollection[]>();
  for (const c of collections) groups.set(`${c.section}|${c.group}`, [...(groups.get(`${c.section}|${c.group}`) ?? []), c]);
  let n = 0;
  const lists = [...groups].map(([key, cs]) => {
    const [section, group] = key.split("|");
    return `<div class="second-level__wrapper"><li class="main-nav__item__mobile--second-level">${group}<span class="arrow-down"></span></li></div>
<ul class="collapse collapse--third-level" id="collapseThirdLevel-${section}-${n++}">${cs.map((c) => `<li><a href="/collections/${c.handle}">${c.title.replace("&", "&amp;")}</a></li>`).join("")}<li><a href="/pages/about">About us</a></li></ul>`;
  });
  return `<!doctype html><html><head><title>Fake shop</title><script>Shopify.currency = {"active":"${currency}","rate":"1.0"};</script></head><body>${lists.join("\n")}<p>${"filler ".repeat(500)}</p></body></html>`;
}

export type FakeShop = { baseUrl: string; requests: string[]; userAgents: Set<string>; close(): Promise<void> };

export async function startFakeShop(shop: { collections: FakeCollection[]; products: FakeProduct[]; currency?: string }): Promise<FakeShop> {
  const products = new Map(shop.products.map((p) => [p.handle, p]));
  const requests: string[] = [];
  const userAgents = new Set<string>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    userAgents.add(String(req.headers["user-agent"] ?? ""));
    const json = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/") return void res.writeHead(200, { "content-type": "text/html" }).end(homeHtml(shop.collections, shop.currency));
    const c = /^\/collections\/([^/]+)\/products\.json$/.exec(url.pathname);
    if (c) {
      const col = shop.collections.find((x) => x.handle === c[1]);
      if (!col) return void res.writeHead(404).end("not found");
      const page = Number(url.searchParams.get("page") ?? "1");
      const items = col.products.map((h) => products.get(h)!).slice((page - 1) * 250, page * 250);
      return json({ products: items.map((p) => ({ id: 1, handle: p.handle, title: p.title, product_type: p.type, body_html: "<p>long text</p>", options: options(p), variants: p.variants.map((v) => rawVariant(p, v, false)) })) });
    }
    const m = /^\/products\/([^/]+)\.js$/.exec(url.pathname);
    const p = m && products.get(m[1]!);
    if (p) return json({ id: 1, handle: p.handle, title: p.title, type: p.type, description: "long text", options: options(p), variants: p.variants.map((v) => rawVariant(p, v, true)) });
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests, userAgents, close: () => new Promise<void>((r) => server.close(() => r())) };
}
