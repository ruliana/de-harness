/**
 * A read-only client for a Shopify storefront (aloyoga.com is one), over the public endpoints that every Shopify shop
 * serves to anyone:
 *
 *   /                                     the shop menu (sections and collections) and the shop currency
 *   /collections/<handle>/products.json   the products of a collection, 250 per page
 *   /products/<handle>.js                 one product: options and variants with price and availability
 *
 * It never touches /cart or /checkout (robots.txt disallows them), and it never writes anything.
 */
import { parse } from "node-html-parser";

export type MenuEntry = { handle: string; title: string; /** e.g. "Women > Clothing" */ path: string };
export type Listing = { handle: string; title: string; type: string; colours: string[] };
export type Variant = { colour: string | null; size: string | null; price: string; available: boolean };
export type Product = { handle: string; title: string; type: string; variants: Variant[]; url: string };
export type Menu = { entries: MenuEntry[]; currency: string };

export class StorefrontError extends Error {}

export type StorefrontOptions = {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Pages of 250 products read per collection. Default 3. */
  maxPages?: number;
};

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const decode = (s: string) => squash(parse(`<p>${s}</p>`).text);

/** The menu: collections that the shop's navigation links to, with the section path they sit under. */
export function parseMenu(html: string): Menu {
  const root = parse(html);
  const currency = /Shopify\.currency\s*=\s*\{"active":"([A-Z]{3})"/.exec(html)?.[1] ?? "USD";
  const entries = new Map<string, MenuEntry>();
  for (const ul of root.querySelectorAll("ul[id^=collapseThirdLevel-]")) {
    const [, section = ""] = /^collapseThirdLevel-(.+?)-\d+$/.exec(ul.id) ?? [];
    // The group's name is in the list item of the heading just before the list.
    const heading = squash(ul.previousElementSibling?.text ?? "");
    for (const a of ul.querySelectorAll("a")) {
      const m = /\/collections\/([^/?#]+)$/.exec((a.getAttribute("href") ?? "").split("?")[0]!.split("#")[0]!);
      const title = decode(a.text);
      if (!m || !title || entries.has(m[1]!)) continue;
      const path = [section ? section[0]!.toUpperCase() + section.slice(1) : "", heading].filter(Boolean).join(" > ");
      entries.set(m[1]!, { handle: m[1]!, title, path });
    }
  }
  return { entries: [...entries.values()], currency };
}

type RawOption = { name: string; values?: string[] };
type RawVariant = { option1?: string | null; option2?: string | null; option3?: string | null; price: string | number; available?: boolean };
type RawProduct = { handle: string; title: string; product_type?: string; type?: string; options?: RawOption[]; variants?: RawVariant[] };

const COLOUR = /colou?r/i;
const SIZE = /size/i;
const optionIndex = (p: RawProduct, name: RegExp) => (p.options ?? []).findIndex((o) => name.test(o.name));
const optionOf = (p: RawProduct, v: RawVariant, name: RegExp): string | null => {
  const i = optionIndex(p, name);
  return i < 0 ? null : (((v as Record<string, unknown>)[`option${i + 1}`] as string | null | undefined) ?? null);
};

export function parseListing(p: RawProduct): Listing {
  const i = optionIndex(p, COLOUR);
  return { handle: p.handle, title: p.title, type: p.product_type ?? p.type ?? "", colours: i < 0 ? [] : (p.options?.[i]?.values ?? []) };
}

/** `.js` prices are in cents (integers), `.json` prices are strings with decimals. */
const money = (price: string | number) => (typeof price === "number" ? (price / 100).toFixed(2) : Number(price).toFixed(2));

export function parseProduct(p: RawProduct, baseUrl: string): Product {
  return {
    handle: p.handle,
    title: p.title,
    type: p.product_type ?? p.type ?? "",
    url: `${baseUrl}/products/${p.handle}`,
    variants: (p.variants ?? []).map((v) => ({ colour: optionOf(p, v, COLOUR), size: optionOf(p, v, SIZE), price: money(v.price), available: v.available ?? true })),
  };
}

export function createStorefront(opts: StorefrontOptions = {}) {
  const baseUrl = (opts.baseUrl ?? "https://www.aloyoga.com").replace(/\/$/, "");
  const maxPages = opts.maxPages ?? 3;
  const get = async (path: string): Promise<Response> => {
    const res = await (opts.fetch ?? globalThis.fetch)(`${baseUrl}${path}`);
    if (!res.ok) throw new StorefrontError(`${path} failed: HTTP ${res.status}`);
    return res;
  };

  return {
    baseUrl,
    async menu(): Promise<Menu> {
      return parseMenu(await (await get("/")).text());
    },
    /** One entry per product (on aloyoga.com a product is one colourway of a style), in the shop's own order. */
    async collection(handle: string): Promise<Listing[]> {
      const out: Listing[] = [];
      for (let page = 1; page <= maxPages; page++) {
        const body = (await (await get(`/collections/${encodeURIComponent(handle)}/products.json?limit=250&page=${page}`)).json()) as { products?: RawProduct[] };
        const products = body.products ?? [];
        out.push(...products.map(parseListing));
        if (products.length < 250) break;
      }
      return out;
    },
    async product(handle: string): Promise<Product> {
      return parseProduct((await (await get(`/products/${encodeURIComponent(handle)}.js`)).json()) as RawProduct, baseUrl);
    },
  };
}
