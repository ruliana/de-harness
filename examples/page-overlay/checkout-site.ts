/**
 * The page the assistant works on: a checkout of a small shop ("Tern Supply") on loopback, with bundled fonts so that screenshots look
 * the same wherever it runs.
 *
 *   /checkout    "Shipping details" (name, street, city, postcode), "Delivery" (Standard, free / Express, $12) and an order summary
 *                with the "Place order" button. The button sits at the bottom right, where the assistant's panel lies on purpose:
 *                the agent has to click through it.
 * POST /api/order checks the form and records the order; the page then shows "Order #<n> placed" and what was ordered.
 *
 * Nothing is chosen at the start: a person has to fill every field and pick a delivery before the order is accepted.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

const fonts = join(import.meta.dirname, "../../tests/support/fixtures");

export type Order = { name: string; street: string; city: string; postcode: string; delivery: string };

export const DELIVERY = { standard: { label: "Standard", days: "5 to 7 days", price: 0 }, express: { label: "Express", days: "1 to 2 days", price: 12 } } as const;
const SUBTOTAL = 64;

const CSS = `
@font-face { font-family: "Test Sans"; src: url(/fonts/DejaVuSans-ascii.woff); font-weight: 400; }
@font-face { font-family: "Test Sans"; src: url(/fonts/DejaVuSans-Bold-ascii.woff); font-weight: 700; }
/* Square corners: Chromium anti-aliases a rounded corner a little differently from one paint to the next, which would make screenshots, and the recordings keyed on them, unstable. */
* { box-sizing: border-box; border-radius: 0 !important; }
body { margin: 0; font: 400 18px/26px "Test Sans", sans-serif; color: #1f2937; background: #f9fafb; }
header { height: 72px; background: #0f766e; color: #ffffff; display: flex; align-items: center; padding: 0 48px; font: 700 26px "Test Sans"; }
main { display: flex; gap: 48px; padding: 28px 48px; }
section { background: #ffffff; border: 1px solid #d1d5db; border-radius: 12px; padding: 24px 28px; }
#form { width: 640px; } #summary { width: 460px; height: 640px; position: relative; }
h1 { font: 700 30px/36px "Test Sans"; margin: 0 0 8px; }
h2 { font: 700 20px/26px "Test Sans"; margin: 18px 0 10px; }
label.field { display: block; margin-bottom: 8px; font-weight: 700; font-size: 16px; }
input[type=text] { display: block; width: 100%; height: 44px; margin-top: 4px; padding: 0 12px; font: 400 18px "Test Sans"; border: 2px solid #9ca3af; border-radius: 8px; }
input[type=text]:focus { border-color: #0f766e; outline: none; }
.row { display: flex; gap: 16px; } .row > * { flex: 1; }
.choice { display: flex; align-items: center; gap: 12px; border: 2px solid #9ca3af; border-radius: 10px; padding: 10px 16px; margin-bottom: 10px; cursor: pointer; }
.choice:has(input:checked) { border-color: #0f766e; background: #ccfbf1; }
.choice b { display: block; } .choice small { color: #4b5563; font-size: 15px; } .choice .price { margin-left: auto; font-weight: 700; }
.line { display: flex; justify-content: space-between; margin: 8px 0; }
.total { border-top: 2px solid #1f2937; padding-top: 12px; margin-top: 16px; font: 700 22px "Test Sans"; }
#place { position: absolute; left: 28px; right: 28px; bottom: 24px; height: 60px; border: 0; border-radius: 10px; background: #0f766e; color: #ffffff; font: 700 22px "Test Sans"; cursor: pointer; }
#error { color: #b91c1c; font-weight: 700; margin-top: 14px; min-height: 26px; }
#done { color: #15803d; }
`;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Checkout - Tern Supply</title><style>${CSS}</style></head><body>
<header>Tern Supply</header>
<main>
<section id="form"><h1>Checkout</h1>
<h2>Shipping details</h2>
<label class="field">Full name<input type="text" id="name" autocomplete="off"></label>
<label class="field">Street address<input type="text" id="street" autocomplete="off"></label>
<div class="row"><label class="field">City<input type="text" id="city" autocomplete="off"></label><label class="field">Postcode<input type="text" id="postcode" autocomplete="off"></label></div>
<h2>Delivery</h2>
<label class="choice"><input type="radio" name="delivery" value="standard"><span><b>Standard</b><small>5 to 7 days</small></span><span class="price">Free</span></label>
<label class="choice"><input type="radio" name="delivery" value="express"><span><b>Express</b><small>1 to 2 days</small></span><span class="price">$12</span></label>
</section>
<section id="summary"><h2 style="margin-top:0">Order summary</h2>
<div class="line"><span>Canvas tote bag</span><span>$34</span></div>
<div class="line"><span>Enamel camp mug</span><span>$30</span></div>
<div class="line"><span>Subtotal</span><span>$${SUBTOTAL}</span></div>
<div class="line"><span>Delivery</span><span id="ship">not chosen</span></div>
<div class="line total"><span>Total</span><span id="total">$${SUBTOTAL}</span></div>
<p id="error"></p>
<button id="place">Place order</button>
</section>
</main>
<script>
const PRICE = { standard: 0, express: 12 };
const $ = (id) => document.getElementById(id);
const chosen = () => document.querySelector('input[name=delivery]:checked')?.value ?? null;
for (const r of document.querySelectorAll('input[name=delivery]')) r.addEventListener('change', () => {
  $('ship').textContent = PRICE[chosen()] ? '$' + PRICE[chosen()] : 'Free';
  $('total').textContent = '$' + (${SUBTOTAL} + PRICE[chosen()]);
});
$('place').addEventListener('click', async () => {
  const order = { name: $('name').value.trim(), street: $('street').value.trim(), city: $('city').value.trim(), postcode: $('postcode').value.trim(), delivery: chosen() };
  const res = await (await fetch('/api/order', { method: 'POST', body: JSON.stringify(order) })).json();
  if (res.error) { $('error').textContent = res.error; return; }
  $('form').innerHTML = '<h1 id="done">Order #' + res.id + ' placed</h1><p>' + res.line + '</p><p>Thank you for shopping at Tern Supply.</p>';
  $('summary').remove();
});
</script></body></html>`;

export type CheckoutSite = {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** The orders the server accepted, in order. */
  orders: Order[];
  /** Every request, as `METHOD /path`. */
  requests: string[];
  close(): Promise<void>;
};

export async function startCheckoutSite(opts: { port?: number } = {}): Promise<CheckoutSite> {
  const orders: Order[] = [];
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    requests.push(`${req.method} ${path}`);
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    if (path.startsWith("/fonts/")) {
      try {
        return send(200, "font/woff", readFileSync(join(fonts, path.slice("/fonts/".length))));
      } catch {
        return send(404, "text/plain", "not found");
      }
    }
    if (path === "/" || path === "/checkout") return send(200, "text/html; charset=utf-8", HTML);
    if (path === "/api/order" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const o = JSON.parse(body || "{}") as Partial<Order>;
        const missing = (["name", "street", "city", "postcode"] as const).filter((k) => !o[k]);
        if (missing.length) return send(200, "application/json", JSON.stringify({ error: `Please fill in: ${missing.join(", ")}.` }));
        if (!o.delivery || !(o.delivery in DELIVERY)) return send(200, "application/json", JSON.stringify({ error: "Please choose a delivery." }));
        const order = o as Order;
        orders.push(order);
        const d = DELIVERY[order.delivery as keyof typeof DELIVERY];
        send(200, "application/json", JSON.stringify({ id: 1000 + orders.length, line: `${d.label} delivery (${d.days}) to ${order.name}, ${order.street}, ${order.city} ${order.postcode}.` }));
      });
      return;
    }
    send(404, "text/plain", "not found");
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, orders, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
