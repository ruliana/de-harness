/**
 * A small clothing shop on loopback that is built like a real one (menus that open on hover, collection pages with a grid of
 * products that continues below the fold, product pages with colour swatches and a size picker, an "Add to bag" button that must
 * stay alone), so the browser example runs offline, deterministically, and in CI. Every font is bundled, so screenshots look the
 * same wherever it runs. The pictures are drawn with SVG: a garment in its colour.
 *
 *   /                                      announcement bar, header (WOMEN, MEN, SHOES), hero, a few products
 *   /collections/womens-shop-all           everything for women (leggings first, mixed)
 *   /collections/womens-sweatshirts-hoodies, /collections/mens-sweatshirts-hoodies, /collections/womens-navy, ...
 *   /products/<handle>-<colour>            one product in one colour: name, price, swatches, sizes, "Add to bag"
 * POST /cart/add is recorded in `cartAdds`; `requests` keeps every request path. Hovering WOMEN or MEN opens the menu with CSS only.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

const fonts = join(import.meta.dirname, "../../tests/support/fixtures");

type Kind = "sweatshirt" | "leggings" | "jacket" | "tee";
type Colour = { name: string; hex: string };
type Product = { id: string; name: string; kind: Kind; section: "womens" | "mens"; price: number; colours: Colour[] };

const C = {
  black: { name: "Black", hex: "#141414" },
  espresso: { name: "Espresso", hex: "#4a3427" },
  ivory: { name: "Ivory", hex: "#efece3" },
  navy: { name: "Navy", hex: "#16294d" },
  blue: { name: "Moonshadow Blue", hex: "#4a78ad" },
  grey: { name: "Heather Grey", hex: "#b9bbbf" },
  bordeaux: { name: "Rich Bordeaux", hex: "#6d1f33" },
  olive: { name: "Olive Green", hex: "#5b6b3e" },
  white: { name: "White", hex: "#fafafa" },
} satisfies Record<string, Colour>;

/** The catalogue. The order of a collection is the order here, so the first screen of a sweatshirt collection holds no blue. */
export const PRODUCTS: Product[] = [
  { id: "u3040rg-accolade-1-4-zip-pullover", name: "Accolade 1/4 Zip Pullover", kind: "sweatshirt", section: "womens", price: 148, colours: [C.black, C.espresso, C.blue, C.navy] },
  { id: "w3845r-hazy-mock-neck-pullover", name: "Hazy Mock Neck Pullover", kind: "sweatshirt", section: "womens", price: 138, colours: [C.ivory, C.espresso, C.black, C.olive] },
  { id: "w3678r-airlift-high-waist-legging", name: "Airlift High-Waist Legging", kind: "leggings", section: "womens", price: 128, colours: [C.navy, C.black, C.blue] },
  { id: "w31007r-accolade-hoodie", name: "Accolade Hoodie", kind: "sweatshirt", section: "womens", price: 148, colours: [C.grey, C.blue, C.bordeaux, C.navy] },
  { id: "w2201r-muse-sweatshirt", name: "Muse Sweatshirt", kind: "sweatshirt", section: "womens", price: 128, colours: [C.ivory, C.black] },
  { id: "w5120r-cinch-jacket", name: "Cinch Cropped Jacket", kind: "jacket", section: "womens", price: 178, colours: [C.navy, C.espresso] },
  { id: "m3001r-triumph-crew-neck-sweatshirt", name: "Triumph Crew Neck Sweatshirt", kind: "sweatshirt", section: "mens", price: 118, colours: [C.black, C.navy, C.grey] },
  { id: "m3102r-the-triumph-hoodie", name: "The Triumph Hoodie", kind: "sweatshirt", section: "mens", price: 138, colours: [C.olive, C.blue, C.black] },
  { id: "m1010r-conquer-tee", name: "Conquer Reform Crew Tee", kind: "tee", section: "mens", price: 68, colours: [C.navy, C.white] },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const handleOf = (p: Product, c: Colour) => `${p.id}-${slug(c.name)}`;
const SIZES = ["XXS (00-0)", "XS (2-4)", "S (4-6)", "M (8-10)", "L (12-14)", "XL (16-18)", "2XL (20-22)"];

export type Listing = { product: Product; colour: Colour; handle: string };
const listings: Listing[] = PRODUCTS.flatMap((p) => p.colours.map((c) => ({ product: p, colour: c, handle: handleOf(p, c) })));
export const listingFor = (handle: string): Listing | undefined => listings.find((l) => l.handle === handle);

/** The best sellers are dark and neutral: the blue ones come after the first screen, so finding one takes scrolling. */
const blueLast = (items: Listing[]) => [...items].sort((a, b) => Number(/Blue|Navy/.test(a.colour.name)) - Number(/Blue|Navy/.test(b.colour.name)));

type Collection = { title: string; blurb: string; items: Listing[] };
const collections: Record<string, Collection> = {
  "womens-shop-all": { title: "Women's Shop All", blurb: "Shop must-have pieces, from everyday essentials to bold statements.", items: listings.filter((l) => l.product.section === "womens").sort((a, b) => Number(b.product.kind === "leggings") - Number(a.product.kind === "leggings")) },
  "womens-sweatshirts-hoodies": { title: "Sweatshirts & Hoodies for Women", blurb: "Cozy layers for the studio and beyond.", items: blueLast(listings.filter((l) => l.product.section === "womens" && l.product.kind === "sweatshirt")) },
  "mens-sweatshirts-hoodies": { title: "Sweatshirts & Hoodies for Men", blurb: "Heavyweight comfort, made to move.", items: blueLast(listings.filter((l) => l.product.section === "mens" && l.product.kind === "sweatshirt")) },
  "womens-leggings": { title: "Leggings for Women", blurb: "High-waist, high-performance.", items: listings.filter((l) => l.product.kind === "leggings") },
  "womens-navy": { title: "Shop Navy", blurb: "Deep, classic and endlessly wearable.", items: listings.filter((l) => l.product.section === "womens" && l.colour.name === "Navy") },
  "womens-moonshadow-blue": { title: "Shop Moonshadow Blue", blurb: "A limited colour.", items: listings.filter((l) => l.product.section === "womens" && l.colour.name === "Moonshadow Blue") },
  "mens-shop-all": { title: "Men's Shop All", blurb: "Everything for him.", items: listings.filter((l) => l.product.section === "mens") },
};

const CSS = `
@font-face { font-family: "Test Sans"; src: url(/fonts/DejaVuSans-ascii.woff); font-weight: 400; }
@font-face { font-family: "Test Sans"; src: url(/fonts/DejaVuSans-Bold-ascii.woff); font-weight: 700; }
* { box-sizing: border-box; }
body { margin: 0; font: 400 18px/26px "Test Sans", sans-serif; color: #111111; background: #ffffff; }
a { color: inherit; text-decoration: none; }
.bar { height: 50px; background: #4875a8; color: #ffffff; font: 700 14px/50px "Test Sans"; text-align: center; letter-spacing: 1px; }
header { height: 84px; display: flex; align-items: center; padding: 0 44px; border-bottom: 1px solid #dddddd; position: relative; background: #ffffff; }
.logo { font: 700 40px "Test Sans"; margin-right: 36px; }
nav { display: flex; height: 100%; }
nav > .item { height: 100%; display: flex; align-items: center; padding: 0 16px; font-size: 18px; letter-spacing: 1px; text-transform: uppercase; }
nav > .item:hover > a { border-bottom: 2px solid #111111; }
.mega { display: none; position: absolute; left: 0; right: 0; top: 84px; background: #ffffff; padding: 28px 90px 40px; z-index: 10; border-bottom: 1px solid #dddddd; }
nav > .item:hover .mega { display: flex; gap: 40px; }
.mega h4 { margin: 0 0 12px; font: 700 16px "Test Sans"; }
.mega a { display: block; font-size: 16px; line-height: 22px; margin-bottom: 10px; color: #444444; text-transform: none; letter-spacing: 0; }
.mega div { width: 170px; }
.tools { margin-left: auto; font: 700 14px "Test Sans"; letter-spacing: 1px; }
.hero { height: 420px; background: linear-gradient(135deg, #3b2a22, #8a6a52); color: #ffffff; padding: 150px 60px; font: 700 44px/52px "Test Sans"; position: relative; }
.hero a { position: absolute; right: 60px; bottom: 40px; background: #ffffff; color: #111111; padding: 12px 30px; font: 700 18px "Test Sans"; letter-spacing: 1px; }
h1 { font: 700 40px/48px "Test Sans"; text-align: center; margin: 50px 0 14px; text-transform: uppercase; }
.blurb { text-align: center; margin: 0 0 30px; }
.pills { display: flex; gap: 14px; padding: 0 26px 18px; }
.pills span { border: 1px solid #999999; border-radius: 20px; padding: 6px 24px; font-size: 14px; letter-spacing: 1px; }
.count { padding: 14px 26px 20px; border-top: 1px solid #999999; color: #666666; text-align: right; }
.grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 25px; padding: 0 26px 60px; }
.tile .pic { height: 300px; background: #f1efec; display: flex; align-items: flex-end; justify-content: center; overflow: hidden; }
.tile .pic svg { height: 270px; width: 270px; }
.swatches { display: flex; gap: 12px; margin: 14px 0 12px; }
.swatches i { width: 28px; height: 28px; border-radius: 14px; display: inline-block; border: 1px solid #cccccc; }
.tile b { display: block; font-size: 17px; }
.tile span { display: block; color: #444444; font-size: 17px; }
.pdp { display: flex; gap: 30px; padding: 30px 60px 60px; }
.pdp .big { width: 440px; height: 560px; background: #f1efec; display: flex; align-items: flex-end; justify-content: center; }
.pdp .big svg { width: 420px; height: 480px; }
.info { width: 370px; }
.info .name { font: 400 28px/34px "Test Sans"; margin: 0; }
.info .price { font-size: 20px; margin: 6px 0 14px; padding-bottom: 14px; border-bottom: 1px solid #dddddd; }
.info .label { margin: 8px 0 10px; font-size: 17px; }
.colours { display: flex; gap: 12px; margin-bottom: 18px; }
.colours a { width: 36px; height: 36px; border-radius: 18px; border: 1px solid #cccccc; display: block; }
.colours a.on { outline: 2px solid #111111; outline-offset: 2px; }
.sizes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; margin-top: 8px; }
.sizes button { height: 40px; border: 1px solid #888888; background: #ffffff; font: 400 15px "Test Sans"; cursor: pointer; }
.sizes button[aria-pressed="true"] { background: #111111; color: #ffffff; }
#add { margin-top: 24px; width: 100%; height: 52px; background: #111111; color: #ffffff; border: 0; font: 700 17px "Test Sans"; letter-spacing: 1px; cursor: pointer; }
#bag { margin-top: 12px; font-weight: 700; color: #15803d; min-height: 26px; }
footer { height: 160px; background: #eeeeee; padding: 60px 44px; }
`;

const GARMENT: Record<Kind, string> = {
  sweatshirt: "M95 20 L65 28 L10 120 L38 138 L62 100 L62 245 L238 245 L238 100 L262 138 L290 120 L235 28 L205 20 Q150 55 95 20 Z",
  leggings: "M70 15 L230 15 L240 60 L205 255 L160 255 L150 90 L140 255 L95 255 L60 60 Z",
  jacket: "M95 20 L60 30 L8 130 L36 148 L62 108 L62 250 L238 250 L238 108 L264 148 L292 130 L240 30 L205 20 L150 40 Z",
  tee: "M100 20 L60 32 L20 90 L52 110 L65 92 L65 245 L235 245 L235 92 L248 110 L280 90 L240 32 L200 20 Q150 50 100 20 Z",
};
const picture = (kind: Kind, hex: string) => `<svg viewBox="0 0 300 270"><path d="${GARMENT[kind]}" fill="${hex}" stroke="#00000022" stroke-width="2"/></svg>`;

const money = (n: number) => `$${n}`;
const tile = (l: Listing) =>
  `<a class="tile" href="/products/${l.handle}"><div class="pic">${picture(l.product.kind, l.colour.hex)}</div><div class="swatches">${l.product.colours.map((c) => `<i style="background:${c.hex}"></i>`).join("")}</div><b>${l.product.name}</b><span>${l.colour.name}</span><span>${money(l.product.price)}</span></a>`;

const MEGA_WOMEN = `<div class="mega"><div><h4>Clothing</h4><a href="/collections/womens-shop-all">Shop All</a><a href="/collections/womens-leggings">Leggings</a><a href="/collections/womens-sweatshirts-hoodies">Sweatshirts &amp; Hoodies</a><a href="/collections/womens-shop-all">Jackets &amp; Coats</a><a href="/collections/womens-shop-all">Tops &amp; Tanks</a><a href="/collections/womens-shop-all">Sweatpants</a></div><div><h4>New &amp; Trending</h4><a href="/collections/womens-shop-all">New Arrivals</a><a href="/collections/womens-shop-all">Best Sellers</a><a href="/collections/womens-shop-all">Last Few Pieces</a></div><div><h4>Shop By Color</h4><a href="/collections/womens-moonshadow-blue">Moonshadow Blue</a><a href="/collections/womens-shop-all">Espresso</a><a href="/collections/womens-navy">Navy</a><a href="/collections/womens-shop-all">Ivory</a><a href="/collections/womens-shop-all">Black</a></div><div><h4>Accessories</h4><a href="/collections/womens-shop-all">Bags</a><a href="/collections/womens-shop-all">Hats</a><a href="/collections/womens-shop-all">Socks</a></div></div>`;
const MEGA_MEN = `<div class="mega"><div><h4>Clothing</h4><a href="/collections/mens-shop-all">Shop All</a><a href="/collections/mens-sweatshirts-hoodies">Sweatshirts &amp; Hoodies</a><a href="/collections/mens-shop-all">Shirts</a><a href="/collections/mens-shop-all">Sweatpants</a><a href="/collections/mens-shop-all">Shorts</a></div><div><h4>Highlights</h4><a href="/collections/mens-shop-all">Best Sellers</a><a href="/collections/mens-shop-all">New Arrivals</a></div></div>`;

const layout = (title: string, body: string, script = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title} | Nimbus</title><style>${CSS}</style></head><body><div class="bar">EXTENDED RETURNS &amp; EXCHANGES THROUGH JAN 10</div>` +
  `<header><a class="logo" href="/">nimbus</a><nav><div class="item"><a href="/collections/womens-shop-all">Women</a>${MEGA_WOMEN}</div><div class="item"><a href="/collections/mens-shop-all">Men</a>${MEGA_MEN}</div><div class="item"><a href="/collections/womens-shop-all">Shoes</a></div></nav><div class="tools">SIGN IN TO GET REWARDS</div></header>` +
  `${body}<footer>Nimbus Activewear</footer>${script ? `<script>${script}</script>` : ""}</body></html>`;

const home = () => layout("Activewear for studio to street", `<div class="hero">NEW IN ESPRESSO<a href="/collections/womens-shop-all">SHOP NEW IN</a></div><h1>Trending now</h1><div class="grid">${collections["womens-shop-all"]!.items.slice(0, 4).map(tile).join("")}</div>`);

const collectionPage = (c: Collection) =>
  layout(c.title, `<h1>${c.title}</h1><p class="blurb">${c.blurb}</p><div class="pills"><span>ALL FILTERS</span><span>SIZE</span><span>COLOR</span><span>FABRIC</span></div><div class="count">${c.items.length} products</div><div class="grid">${c.items.map(tile).join("")}</div>`);

const productPage = (l: Listing) =>
  layout(
    `${l.product.name} - ${l.colour.name}`,
    `<div class="pdp"><div class="big">${picture(l.product.kind, l.colour.hex)}</div><div class="info"><h2 class="name">${l.product.name}</h2><div class="price" id="price">${money(l.product.price)}</div><div class="label">Colour: <b id="colour">${l.colour.name}</b></div><div class="colours">${l.product.colours.map((c) => `<a href="/products/${handleOf(l.product, c)}" title="${c.name}" class="${c.name === l.colour.name ? "on" : ""}" style="background:${c.hex}"></a>`).join("")}</div><div class="label">Size</div><div class="sizes" id="sizes">${SIZES.map((s) => `<button type="button" aria-pressed="false" data-size="${s.split(" ")[0]}">${s}</button>`).join("")}</div><button id="add" type="button">ADD TO BAG</button><div id="bag"></div></div></div>`,
    `
for (const b of document.querySelectorAll('#sizes button')) b.addEventListener('click', () => {
  for (const o of document.querySelectorAll('#sizes button')) o.setAttribute('aria-pressed', String(o === b));
});
document.getElementById('add').addEventListener('click', async () => {
  await fetch('/cart/add', { method: 'POST', body: JSON.stringify({ handle: ${JSON.stringify(l.handle)} }) });
  document.getElementById('bag').textContent = 'Added to your bag';
});`,
  );

export type ShopSite = {
  /** `http://127.0.0.1:<port>` */
  url: string;
  requests: string[];
  /** Handles added to the bag. A run that reads a price must leave this empty. */
  cartAdds: string[];
  close(): Promise<void>;
};

export async function startShopSite(opts: { port?: number } = {}): Promise<ShopSite> {
  const requests: string[] = [];
  const cartAdds: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    requests.push(`${req.method} ${url.pathname}`);
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
    const collection = /^\/collections\/([\w-]+)$/.exec(url.pathname);
    if (collection && collections[collection[1]!]) return send(collectionPage(collections[collection[1]!]!));
    const product = /^\/products\/([\w-]+)$/.exec(url.pathname);
    const listing = product ? listingFor(product[1]!) : undefined;
    if (listing) return send(productPage(listing));
    return send("not found", "text/plain", 404);
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, requests, cartAdds, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
