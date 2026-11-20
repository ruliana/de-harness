/**
 * A small outfitter's shop on loopback, built to reproduce two things that real shops do and that the by-sight agent has to cope with:
 *
 *   - a list whose first screens hold nothing of the colour asked for (no red t-shirt among the first 18 of 212), where only a filter
 *     (a closed "Colour" section in the side bar that opens on click, then a value) brings one up;
 *   - a boots list with a "Size" section in the side bar, open, next to the boots themselves, so that a task that says "size 10" can
 *     draw a click to the size facet instead of to a boot.
 *
 *   /                                       header (MEN menu that opens on hover) and a banner: no products
 *   /collections/t-shirts[?colour=Red]      18 of 212 t-shirts, side bar: Size (open), Colour (closed), Price (closed)
 *   /collections/boots[?colour=Brown]       boots, side bar: Size (open), Colour (closed)
 *   /products/<handle>                      one product in one colour: name, price, sizes, "Add to bag"
 * POST /cart/add is recorded in `cartAdds`; `requests` keeps every request, with its query string. Every font is bundled.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

const fonts = join(import.meta.dirname, "fixtures");

export const OUTFITTER_PORT = 47215;

type Kind = "tee" | "boot";
type Colour = { name: string; hex: string };
export type OutfitterProduct = { handle: string; name: string; kind: Kind; colour: Colour; price: number };

const TEE_COLOURS: Colour[] = [
  { name: "Black", hex: "#1a1a1a" },
  { name: "Charcoal", hex: "#444a52" },
  { name: "Navy", hex: "#1c2f55" },
  { name: "White", hex: "#f7f7f4" },
  { name: "Olive", hex: "#5d6b3f" },
  { name: "Red", hex: "#d42a2a" },
];
const TEE_STYLES = ["Everyday Tee", "Heavyweight Tee", "Pocket Tee", "Ringer Tee", "Trail Tee", "Lakeside Tee", "Summit Tee", "Relaxed Tee", "Longline Tee", "Boxy Tee"];
const BOOT_COLOURS: Colour[] = [
  { name: "Brown", hex: "#6b4226" },
  { name: "Black", hex: "#1c1c1c" },
  { name: "Tan", hex: "#b88a54" },
];
const BOOT_STYLES = ["Trailhead Boot", "Ridge Chelsea Boot", "Summit Hiker", "Fieldwork Boot", "Timberline Boot", "Outpost Lace-Up"];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** T-shirts: red ones come last in the list of 212, far beyond the first 18. */
const tees: OutfitterProduct[] = TEE_STYLES.flatMap((style, i) =>
  TEE_COLOURS.map((colour, j) => ({ handle: `${slug(style)}-${slug(colour.name)}`, name: style, kind: "tee" as const, colour, price: 28 + ((i * 3 + j) % 5) * 6 })),
).sort((a, b) => Number(a.colour.name === "Red") - Number(b.colour.name === "Red"));

/** Boots: a brown pair among the first three. */
const boots: OutfitterProduct[] = BOOT_STYLES.flatMap((style, i) =>
  BOOT_COLOURS.map((colour, j) => ({ handle: `${slug(style)}-${slug(colour.name)}`, name: style, kind: "boot" as const, colour, price: 119 + ((i * 2 + j) % 4) * 20 })),
).sort((a, b) => Number(!a.handle.startsWith("trailhead")) - Number(!b.handle.startsWith("trailhead")));

const all = [...tees, ...boots];
export const productFor = (handle: string): OutfitterProduct | undefined => all.find((p) => p.handle === handle);

const TEE_SIZES = ["XS", "S", "M", "L", "XL", "2XL"];
const BOOT_SIZES = ["8", "8 1/2", "9", "9 1/2", "10", "10 1/2", "11", "11 1/2", "12"];

const CSS = `
@font-face { font-family: "Test Sans"; src: url(/fonts/DejaVuSans-ascii.woff); font-weight: 400; }
@font-face { font-family: "Test Sans"; src: url(/fonts/DejaVuSans-Bold-ascii.woff); font-weight: 700; }
* { box-sizing: border-box; }
body { margin: 0; font: 400 16px/24px "Test Sans", sans-serif; color: #1b1b1b; background: #ffffff; }
a { color: inherit; text-decoration: none; }
header { height: 76px; display: flex; align-items: center; padding: 0 40px; border-bottom: 1px solid #dddddd; position: relative; background: #ffffff; }
.logo { font: 700 32px "Test Sans"; margin-right: 40px; }
nav { display: flex; height: 100%; }
nav > .item { height: 100%; display: flex; align-items: center; padding: 0 18px; font-size: 16px; letter-spacing: 1px; text-transform: uppercase; }
nav > .item:hover > a { border-bottom: 2px solid #1b1b1b; }
.mega { display: none; position: absolute; left: 0; right: 0; top: 76px; background: #ffffff; padding: 26px 90px 34px; z-index: 10; border-bottom: 1px solid #dddddd; }
nav > .item:hover .mega { display: flex; gap: 60px; }
.mega h4 { margin: 0 0 12px; font: 700 15px "Test Sans"; }
.mega a { display: block; font-size: 15px; margin-bottom: 10px; color: #444444; text-transform: none; letter-spacing: 0; }
.tools { margin-left: auto; font: 700 13px "Test Sans"; letter-spacing: 1px; }
.hero { height: 340px; background: linear-gradient(135deg, #2c3a2e, #6d7f5c); color: #ffffff; padding: 120px 60px; font: 700 40px/48px "Test Sans"; }
h1 { font: 700 34px/42px "Test Sans"; margin: 36px 40px 18px; text-transform: uppercase; }
.layout { display: flex; gap: 30px; padding: 0 40px 60px; }
aside { width: 230px; flex: none; }
aside h3 { margin: 0 0 10px; font: 700 15px "Test Sans"; letter-spacing: 1px; }
.facet { border-top: 1px solid #cccccc; padding: 4px 0 10px; }
.facet > button { all: unset; display: flex; width: 100%; height: 44px; align-items: center; justify-content: space-between; font: 700 15px "Test Sans"; cursor: pointer; }
.facet ul { list-style: none; margin: 10px 0 0; padding: 0; }
.facet li a { display: block; padding: 4px 0; font-size: 15px; color: #333333; }
.facet li i { display: inline-block; width: 14px; height: 14px; border-radius: 7px; margin-right: 8px; border: 1px solid #aaaaaa; vertical-align: -2px; }
.facet [hidden] { display: none; }
.list { flex: 1; }
.count { color: #666666; margin: 0 0 14px; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 22px; }
.tile .pic { height: 270px; background: #f0eee9; display: flex; align-items: flex-end; justify-content: center; overflow: hidden; }
.tile .pic svg { height: 240px; width: 240px; }
.tile b { display: block; margin-top: 10px; }
.tile span { display: block; color: #444444; }
.pdp { display: flex; gap: 30px; padding: 30px 60px 60px; }
.pdp .big { width: 440px; height: 500px; background: #f0eee9; display: flex; align-items: flex-end; justify-content: center; }
.pdp .big svg { width: 420px; height: 440px; }
.info { width: 380px; }
.info .name { font: 400 28px/34px "Test Sans"; margin: 0; }
.info .price { font-size: 20px; margin: 6px 0 14px; padding-bottom: 14px; border-bottom: 1px solid #dddddd; }
.info .label { margin: 8px 0 10px; }
.sizes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; margin-top: 8px; }
.sizes button { height: 40px; border: 1px solid #888888; background: #ffffff; font: 400 15px "Test Sans"; cursor: pointer; }
.sizes button[aria-pressed="true"] { background: #1b1b1b; color: #ffffff; }
#add { margin-top: 24px; width: 100%; height: 52px; background: #1b1b1b; color: #ffffff; border: 0; font: 700 16px "Test Sans"; letter-spacing: 1px; cursor: pointer; }
#bag { margin-top: 12px; font-weight: 700; color: #15803d; min-height: 26px; }
footer { height: 140px; background: #eeeeee; padding: 50px 40px; }
`;

const SHAPE: Record<Kind, string> = {
  tee: `<path d="M100 20 L60 32 L20 90 L52 110 L65 92 L65 245 L235 245 L235 92 L248 110 L280 90 L240 32 L200 20 Q150 50 100 20 Z" fill="FILL" stroke="#00000022" stroke-width="2"/>`,
  boot: `<path d="M100 30 L172 30 L174 130 Q232 140 268 185 L270 232 L88 232 L88 205 L100 205 Z" fill="FILL" stroke="#00000022" stroke-width="2"/><rect x="88" y="220" width="182" height="12" fill="#2b2b2b"/>`,
};
const picture = (p: OutfitterProduct) => `<svg viewBox="0 0 300 270">${SHAPE[p.kind].replace("FILL", p.colour.hex)}</svg>`;

const tile = (p: OutfitterProduct) => `<a class="tile" href="/products/${p.handle}"><div class="pic">${picture(p)}</div><b>${p.name}</b><span>$${p.price}</span></a>`;

const MEGA_MEN = `<div class="mega"><div><h4>Clothing</h4><a href="/collections/t-shirts">T-Shirts</a></div><div><h4>Footwear</h4><a href="/collections/boots">Boots</a></div></div>`;

const layout = (title: string, body: string, script = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title} | Ridgeline</title><style>${CSS}</style></head><body>` +
  `<header><a class="logo" href="/">ridgeline</a><nav><div class="item"><a href="/collections/t-shirts">Men</a>${MEGA_MEN}</div></nav><div class="tools">SIGN IN</div></header>` +
  `${body}<footer>Ridgeline Outfitters</footer>${script ? `<script>${script}</script>` : ""}</body></html>`;

const home = () => layout("Outdoor clothing and boots", `<div class="hero">NEW SEASON ESSENTIALS</div><h1>Built for the trail</h1><p class="count" style="margin: 0 40px 60px">Clothing and footwear that last: shop the new season.</p>`);

type Facet = { title: string; open: boolean; param: string; values: { label: string; hex?: string }[] };
const facetsHtml = (path: string, facets: Facet[]) =>
  `<aside><h3>FILTERS</h3>${facets
    .map(
      (f) =>
        `<div class="facet"><button type="button" aria-expanded="${f.open}">${f.title}<span>${f.open ? "-" : "+"}</span></button><ul${f.open ? "" : " hidden"}>${f.values
          .map((v) => `<li><a href="${path}?${f.param}=${encodeURIComponent(v.label)}">${v.hex ? `<i style="background:${v.hex}"></i>` : ""}${v.label}</a></li>`)
          .join("")}</ul></div>`,
    )
    .join("")}</aside>`;

const FACET_SCRIPT = `
for (const b of document.querySelectorAll('.facet > button')) b.addEventListener('click', () => {
  const ul = b.nextElementSibling;
  ul.hidden = !ul.hidden;
  b.setAttribute('aria-expanded', String(!ul.hidden));
  b.lastElementChild.textContent = ul.hidden ? '+' : '-';
});`;

const teePage = (colour: string | null) => {
  const shown = (colour ? tees.filter((t) => t.colour.name === colour) : tees).slice(0, 18);
  const facets: Facet[] = [
    { title: "Size", open: true, param: "size", values: TEE_SIZES.map((label) => ({ label })) },
    { title: "Colour", open: false, param: "colour", values: TEE_COLOURS.map((c) => ({ label: c.name, hex: c.hex })) },
    { title: "Price", open: false, param: "price", values: [{ label: "Under $40" }, { label: "$40 and over" }] },
  ];
  const total = colour ? tees.filter((t) => t.colour.name === colour).length : 212;
  return layout("T-Shirts", `<h1>T-Shirts</h1><div class="layout">${facetsHtml("/collections/t-shirts", facets)}<div class="list"><p class="count">Showing ${shown.length} of ${total} products</p><div class="grid">${shown.map(tile).join("")}</div></div></div>`, FACET_SCRIPT);
};

const bootPage = (colour: string | null) => {
  const shown = colour ? boots.filter((b) => b.colour.name === colour) : boots;
  const facets: Facet[] = [
    { title: "Size", open: true, param: "size", values: BOOT_SIZES.map((label) => ({ label })) },
    { title: "Colour", open: false, param: "colour", values: BOOT_COLOURS.map((c) => ({ label: c.name, hex: c.hex })) },
  ];
  return layout("Boots", `<h1>Boots</h1><div class="layout">${facetsHtml("/collections/boots", facets)}<div class="list"><p class="count">Showing ${shown.length} of ${shown.length} products</p><div class="grid">${shown.map(tile).join("")}</div></div></div>`, FACET_SCRIPT);
};

const productPage = (p: OutfitterProduct) =>
  layout(
    `${p.name} - ${p.colour.name}`,
    `<div class="pdp"><div class="big">${picture(p)}</div><div class="info"><h2 class="name">${p.name}</h2><div class="price" id="price">$${p.price}</div><div class="label">Colour: <b id="colour">${p.colour.name}</b></div><div class="label">Size</div><div class="sizes" id="sizes">${(p.kind === "tee" ? TEE_SIZES : BOOT_SIZES).map((s) => `<button type="button" aria-pressed="false" data-size="${s}">${s}</button>`).join("")}</div><button id="add" type="button">ADD TO BAG</button><div id="bag"></div></div></div>`,
    `
for (const b of document.querySelectorAll('#sizes button')) b.addEventListener('click', () => {
  for (const o of document.querySelectorAll('#sizes button')) o.setAttribute('aria-pressed', String(o === b));
});
document.getElementById('add').addEventListener('click', async () => {
  await fetch('/cart/add', { method: 'POST', body: JSON.stringify({ handle: ${JSON.stringify(p.handle)} }) });
  document.getElementById('bag').textContent = 'Added to your bag';
});`,
  );

export type OutfitterSite = {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** Every request, "GET /collections/boots?size=10" and so on. */
  requests: string[];
  /** Handles added to the bag. A run that reads a price must leave this empty. */
  cartAdds: string[];
  close(): Promise<void>;
};

export async function startOutfitterSite(opts: { port?: number } = {}): Promise<OutfitterSite> {
  const requests: string[] = [];
  const cartAdds: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (body: string | Buffer, type = "text/html; charset=utf-8", status = 200) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (url.pathname.startsWith("/fonts/")) return send(readFileSync(join(fonts, url.pathname.slice("/fonts/".length).replace(/[^\w.-]/g, ""))), "font/woff");
    if (req.method === "POST" && url.pathname === "/cart/add") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        cartAdds.push((JSON.parse(body) as { handle: string }).handle);
        send("{}", "application/json");
      });
      return;
    }
    if (url.pathname === "/") return send(home());
    if (url.pathname === "/collections/t-shirts") return send(teePage(url.searchParams.get("colour")));
    if (url.pathname === "/collections/boots") return send(bootPage(url.searchParams.get("colour")));
    const product = /^\/products\/([\w-]+)$/.exec(url.pathname);
    const found = product ? productFor(product[1]!) : undefined;
    if (found) return send(productPage(found));
    return send("not found", "text/plain", 404);
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, requests, cartAdds, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
