/**
 * HTTP for the storefront example: the cassette over the real network, politely and identified.
 *
 * aloyoga.com asks agents to identify themselves, to back off on 429 and to prefer structured data, so the real
 * network layer says what it is, waits as asked, and reads only public JSON and the home page. Responses are
 * trimmed before they are recorded (the home page is 400 KB, a collection page 1 MB) to what the client reads.
 */
import { parse } from "node-html-parser";
import { cassetteFetch, cassetteMode, type CassetteMode } from "../../src/index.js";

const USER_AGENT = "de-harness-example/0.1 (agent-initiated, read-only shopping demo; https://github.com/ruliana/de-harness)";
const MAX_TRIES = 6;

/** The menu lists and the currency of the home page; nothing else. */
export function trimHome(html: string): string {
  const root = parse(html);
  const lists = root.querySelectorAll("ul[id^=collapseThirdLevel-]").map((ul) => {
    const heading = ul.previousElementSibling?.text.replace(/\s+/g, " ").trim() ?? "";
    const links = ul
      .querySelectorAll("a")
      .map((a) => `<li><a href="${(a.getAttribute("href") ?? "").replace(/"/g, "&quot;")}">${a.innerHTML.trim()}</a></li>`)
      .join("");
    return `<div><li>${heading}</li></div><ul id="${ul.id}">${links}</ul>`;
  });
  const currency = /Shopify\.currency\s*=\s*\{"active":"([A-Z]{3})"/.exec(html)?.[1] ?? "USD";
  return `<html><body><script>Shopify.currency = {"active":"${currency}"}</script>${lists.join("")}</body></html>`;
}

type Raw = { handle: string; title: string; product_type?: string; type?: string; options?: { name: string; values?: string[] }[]; variants?: Record<string, unknown>[] };

/** One variant per listed product, whose price is the lowest and which is available if any is. Enough for a listing. */
const trimListing = (p: Raw) => {
  const prices = (p.variants ?? []).map((v) => Number(v.price)).filter(Number.isFinite);
  return {
    handle: p.handle,
    title: p.title,
    product_type: p.product_type,
    options: (p.options ?? []).map((o) => ({ name: o.name, values: o.values })),
    variants: [{ price: prices.length ? String(Math.min(...prices)) : "0", available: (p.variants ?? []).some((v) => v.available) }],
  };
};

const trimProduct = (p: Raw) => ({
  handle: p.handle,
  title: p.title,
  type: p.type,
  options: (p.options ?? []).map((o) => ({ name: o.name })),
  variants: (p.variants ?? []).map((v) => ({ option1: v.option1, option2: v.option2, option3: v.option3, price: v.price, available: v.available })),
});

async function politeFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("user-agent", USER_AGENT);
  let res: Response;
  for (let attempt = 1; ; attempt++) {
    res = await globalThis.fetch(input, { ...init, headers });
    if (res.status !== 429 && res.status < 500) break;
    if (attempt >= MAX_TRIES) throw new Error(`The shop keeps answering HTTP ${res.status}; try again later`);
    const asked = Number(res.headers.get("retry-after"));
    await new Promise((r) => setTimeout(r, 1000 * Math.min(60, Number.isFinite(asked) && asked > 0 ? asked + 1 : 3 * attempt)));
  }
  if (!res.ok) return res;
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url.pathname === "/") return new Response(trimHome(await res.text()), { status: 200, headers: { "content-type": "text/html" } });
  if (/^\/collections\/[^/]+\/products\.json$/.test(url.pathname)) return json({ products: ((await res.json()) as { products: Raw[] }).products.map(trimListing) });
  if (/^\/products\/[^/]+\.js$/.test(url.pathname)) return json(trimProduct((await res.json()) as Raw));
  return res;
}

/** In replay mode (the default) nothing leaves the machine. In record mode every request goes to the shop and replaces its recording. */
export function storefrontFetch(opts: { dir: string; mode?: CassetteMode }): typeof fetch {
  return cassetteFetch({ dir: opts.dir, mode: opts.mode ?? cassetteMode(), inner: politeFetch as typeof fetch });
}
