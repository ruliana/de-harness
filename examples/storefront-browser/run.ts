/**
 * One run of the browser shopping task, on the live shop or on the local fixture, and the facts that judge it.
 * The test and the runner (`main.ts`) share this, so what the PR reports is what the test checks.
 */
import { BrowserSession, createAgent, type DecisionModel, type RunResult } from "../../src/index.js";
import { listingFor, startShopSite, type ShopSite } from "./shop-site.js";
import { SHOPPING_STEPS, shoppingTools, stepInstructions } from "./shopping.js";

export type SiteKind = "live" | "fixture";

/** Hosts the live shop needs to draw itself: the shop, its menu (builder.io), pictures and fonts, and the script that fades the pictures in. Anything else (ads, trackers) is aborted. */
export const LIVE = { home: "https://www.aloyoga.com/", hosts: ["aloyoga.com", "builder.io", "shopify.com", "typekit.net", "unpkg.com"], instructions: SHOPPING_STEPS } as const;
export const FIXTURE_PORT = 47214;

/** What the page says about itself once a run is over, read by code and never by the model. `listedPrice` is the shop's own price for that colour and size, from outside the page's text. */
export type PageFacts = {
  url: string;
  /** Product type or kind: "sweatshirt", "leggings", ... (the live shop's own `type` field, or the fixture's catalogue). */
  type: string;
  product: string;
  colour: string | null;
  /** "L", "XL", ... */
  size: string | null;
  /** The price as the page shows it ("$148"). */
  shownPrice: string | null;
  /** The shop's price for the selected colour and size ("$148"). */
  listedPrice: string | null;
};

type Raw = { url: string; handle: string; product: string; colour: string | null; size: string | null; shownPrice: string | null; type?: string; cents?: number };

export async function pageFacts(browser: BrowserSession, kind: SiteKind): Promise<PageFacts | null> {
  const info = await browser.info();
  if (!/\/products\//.test(new URL(info.url).pathname)) return null;
  if (kind === "fixture") {
    const raw = (await browser.evaluate(
      () => ({
        url: location.href,
        handle: location.pathname.split("/").pop() ?? "",
        product: document.querySelector(".name")?.textContent ?? "",
        colour: document.getElementById("colour")?.textContent ?? null,
        size: (document.querySelector('#sizes [aria-pressed="true"]') as HTMLElement | null)?.dataset.size ?? null,
        shownPrice: document.getElementById("price")?.textContent ?? null,
      }),
      0,
    )) as Raw;
    const listing = listingFor(raw.handle);
    return { url: raw.url, product: raw.product, colour: raw.colour, size: raw.size, shownPrice: raw.shownPrice, type: listing?.product.kind ?? "unknown", listedPrice: listing ? `$${listing.product.price}` : null };
  }
  const raw = (await browser.evaluate(async () => {
    const product = await (await fetch(`${location.pathname}.js`)).json();
    const colour = document.title.replace(/\s*\|.*$/, "").split(" - ").pop() ?? null;
    const size = (document.querySelector(".button-size-selector__button.active")?.textContent ?? "").trim().split(" ")[0] || null;
    const variant = (product.variants as { option1: string; option2: string; price: number }[]).find((v) => v.option1 === colour && v.option2 === size);
    const shown = [...document.querySelectorAll(".product__price")].map((e) => (e.textContent ?? "").trim()).find((t) => /^\$\d/.test(t)) ?? null;
    return { url: location.href, handle: "", product: product.title as string, type: (product.type as string) ?? "", colour, size, shownPrice: shown, cents: variant?.price };
  }, 0)) as Raw;
  return { url: raw.url, product: raw.product, colour: raw.colour, size: raw.size, shownPrice: raw.shownPrice, type: raw.type ?? "", listedPrice: raw.cents === undefined ? null : `$${raw.cents / 100}` };
}

export type Outcome = {
  result: RunResult;
  /** What the run said the price was: `state.price.text`. */
  read: string | null;
  facts: PageFacts | null;
  /** One entry per step: the tool and a one-line summary of what it did. */
  trail: string[];
};

export type RunOptions = { kind: SiteKind; model: DecisionModel; browser: BrowserSession; home: string; instructions?: string; maxSteps?: number; onStep?: (line: string) => void };

/** Run the agent once, from no page at all, and read the facts afterwards. */
export async function runOnce(opts: RunOptions): Promise<Outcome> {
  const trail: string[] = [];
  let pending = "";
  const result = await createAgent({
    model: opts.model,
    instructions: opts.instructions ?? (opts.kind === "live" ? LIVE.instructions : stepInstructions("the shop")),
    tools: shoppingTools(opts.browser, { home: opts.home }),
    initialState: {},
    maxSteps: opts.maxSteps ?? 14,
    onEvent: (e) => {
      if (e.type === "tool_call") pending = `${e.tool}${Object.keys(e.args).length ? `(${JSON.stringify(e.args).slice(0, 90)})` : ""}`;
      if (e.type === "tool_result") {
        const line = `${pending}${e.summary ? ` -> ${e.summary}` : ""}`;
        trail.push(line);
        opts.onStep?.(`step ${e.step}: ${line}`);
      }
    },
  }).run();
  const price = result.state.price as { text: string } | undefined;
  return { result, read: price?.text ?? null, facts: await pageFacts(opts.browser, opts.kind), trail };
}

/** The local look-alike shop, on a fixed port: the address is part of every request to Jev, so it must not change between a recording and its replay. */
export const startFixture = () => startShopSite({ port: FIXTURE_PORT });

/** A fresh browser per run, so that no pointer position or page from an earlier run is in the first screenshot. */
export const launchFixture = () => BrowserSession.launch({ allowedHosts: ["127.0.0.1"], settleMs: 150 });

/** A browser for the live shop, restricted to the hosts it needs. Goes through the egress proxy in a cloud sandbox (Chromium honours it by itself). */
export async function launchLive(): Promise<BrowserSession> {
  return await BrowserSession.launch({ allowedHosts: [...LIVE.hosts], settleMs: 800 });
}

/** The test's own judgment of colour and garment (the agent's judgment comes from Jev). */
export const BLUE = /blue|navy|azure|cobalt|indigo|denim|sapphire|cerulean|bluestone|provence|moonshadow/i;
export const SWEATSHIRT = /sweatshirt|pullover|crew|hoodie|fleece/i;

/** Why a run is wrong, as a list; empty means correct: a blue sweatshirt, size L selected, and the price the run read is the one the shop lists for that colour and size. */
export function problems(o: Outcome): string[] {
  const out: string[] = [];
  if (o.result.status !== "ended") out.push(`run ${o.result.status}${o.result.error ? `: ${o.result.error.message}` : ""}`);
  const f = o.facts;
  if (!f) return [...out, "did not end on a product page"];
  if (f.size !== "L") out.push(`size ${f.size ?? "none"} selected`);
  if (!BLUE.test(f.colour ?? "")) out.push(`colour ${f.colour ?? "none"} is not blue`);
  if (!SWEATSHIRT.test(`${f.type} ${f.product}`)) out.push(`${f.product} (${f.type}) is not a sweatshirt`);
  if (o.read === null) out.push("read no price");
  else if (o.read !== f.listedPrice) out.push(`read ${o.read}, the shop lists ${f.listedPrice ?? "nothing"}`);
  return out;
}
