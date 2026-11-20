/**
 * One run of the plain task on a shop, by the two levels of `examples/storefront-by-sight`, used unchanged. The run is a copy of
 * `runBySight` without its aloyoga.com page facts (which read Shopify's `.js` product feed): here the facts are whatever the page
 * says about itself in generic markup, and the person scoring a run looks at the screenshots as well.
 */
import { createAgent, BrowserSession, type DecisionModel, type HarnessEvent } from "../../src/index.js";
import { plainTask } from "../storefront-browser/shopping.js";
import { judgeScreen, sightTools } from "../storefront-by-sight/planner.js";
import { DONE_OPENED } from "../storefront-by-sight/tactics.js";
import type { Shop } from "./shops.js";

export const launchShop = (shop: Shop) => BrowserSession.launch({ allowedHosts: shop.hosts, settleMs: 800 });

export const taskFor = (shop: Shop) => plainTask(shop.name, shop.what, shop.size);

/** What the page says about itself at the end of a run, read by code from generic markup (never seen by the model). Best effort: the scorer's eyes are the verdict. */
export type Facts = {
  url: string;
  title: string;
  h1: string | null;
  /** schema.org Product entries: name, colour and offers (price per variant when the page lists them). */
  products: { name?: string; color?: string; offers: { price?: string | number; sku?: string; name?: string }[] }[];
  /** Texts of controls that say they are selected / pressed / checked / active. */
  selected: string[];
  /** Price-looking strings in the viewport. */
  pricesInView: string[];
};

/** Runs in the page. A string, so that the TypeScript runner cannot add helpers (`__name`) that the page does not have. */
const PAGE_SCRIPT = `(() => {
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const nodes = [];
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const j = JSON.parse(s.textContent || "");
      for (const o of Array.isArray(j) ? j : j["@graph"] || [j]) nodes.push(o);
    } catch (e) {}
  }
  const isProduct = (o) => o && (o["@type"] === "Product" || (Array.isArray(o["@type"]) && o["@type"].includes("Product")));
  const products = nodes.filter(isProduct).map((p) => ({
    name: p.name,
    color: p.color,
    offers: [].concat(p.offers || []).flatMap((o) => (Array.isArray(o.offers) ? o.offers : [o])).slice(0, 40).map((o) => ({ price: o.price !== undefined ? o.price : o.lowPrice, sku: o.sku, name: o.name })),
  }));
  const sel = Array.from(document.querySelectorAll('[aria-checked="true"],[aria-pressed="true"],[aria-selected="true"],input:checked,[class*="selected"],[class*="Selected"],[class*="active"]'))
    .map((e) => clean((e.type === "radio" ? e.closest("label") || e.parentElement : e).textContent).slice(0, 40) || clean(e.value))
    .filter((t) => t && t.length < 40);
  const h1 = document.querySelector("h1");
  return { h1: clean(h1 && h1.textContent) || null, products, selected: Array.from(new Set(sel)).slice(0, 30) };
})()`;

export async function pageFacts(browser: BrowserSession): Promise<Facts> {
  const info = await browser.info();
  const visible = await browser.visibleText();
  const raw = (await browser.evaluate((src: string) => (0, eval)(src), PAGE_SCRIPT)) as Pick<Facts, "h1" | "products" | "selected">;
  const pricesInView = Array.from(new Set(visible.match(/(?:[$€£]|USD\s?)\s?\d[\d,]*(?:\.\d{2})?/g) ?? [])).slice(0, 12);
  return { url: info.url, title: info.title, ...raw, pricesInView };
}

export type SweepRun = {
  status: string;
  /** Tactics in order, with their one-line summaries and the navigator's calls under them. */
  trail: { step: number; tactic: string; summary: string; navigator: string[] }[];
  /** The price the run read (`state.price.text`), or null. */
  read: string | null;
  facts: Facts;
  /** The picture the deciding level saw at each step, and the page after the last step. */
  screens: { name: string; png: Buffer }[];
  /** Clicks whose target looked like adding to the bag or checking out, found in the trail. */
  bagTouches: string[];
  error?: string;
  ms: number;
};

export type SweepOptions = { shop: Shop; model: DecisionModel; browser: BrowserSession; maxSteps?: number; onStep?: (line: string) => void };

/** Open the shop and run the deciding level, exactly as `runBySight` does: the same tools, the same first screenshot and judgments, 10 steps. */
export async function runShop(opts: SweepOptions): Promise<SweepRun> {
  const t0 = Date.now();
  const task = taskFor(opts.shop);
  const { tools, found } = sightTools({ browser: opts.browser, model: opts.model, task, home: opts.shop.home });
  await opts.browser.goto(opts.shop.home);
  const trail: SweepRun["trail"] = [];
  /** The navigator's lines per step: they arrive before the tactic's own result. */
  const nav = new Map<number, string[]>();
  const events: HarnessEvent[] = [];
  const screen = (await opts.browser.snapshot()).screen!;
  const result = await createAgent({
    model: opts.model,
    instructions: task,
    tools,
    initialState: { screen, judgments: await judgeScreen(opts.model, task, screen), done: [DONE_OPENED] },
    previousActions: 0,
    maxSteps: opts.maxSteps ?? 10,
    onEvent: (e) => {
      events.push(e);
      if (e.type === "tool_result") {
        trail.push({ step: e.step, tactic: e.tool, summary: e.summary ?? e.error ?? "", navigator: nav.get(e.step) ?? [] });
        opts.onStep?.(`step ${e.step}: ${e.tool}${e.summary ? ` -> ${e.summary}` : ""}`);
      }
      if (e.type === "child" && e.event.type === "tool_call") {
        const line = `${e.event.tool}${Object.keys(e.event.args).length ? `(${JSON.stringify(e.event.args).slice(0, 100)})` : ""}`;
        nav.set(e.step, [...(nav.get(e.step) ?? []), line]);
        opts.onStep?.(`    navigator: ${line}`);
      }
      if (e.type === "child" && e.event.type === "tool_result" && e.event.summary) {
        opts.onStep?.(`      -> ${e.event.summary.slice(0, 140)}`);
        nav.set(e.step, [...(nav.get(e.step) ?? []), `  = ${e.event.summary.slice(0, 160)}`]);
      }
    },
  }).run();
  const screens: SweepRun["screens"] = [];
  result.steps.forEach((s, i) => {
    const img = Object.values(s.request.images ?? {})[0];
    if (img) screens.push({ name: `step-${String(i + 1).padStart(2, "0")}.png`, png: Buffer.from(img.base64, "base64") });
  });
  screens.push({ name: "final.png", png: Buffer.from(await opts.browser.screenshot()) });
  const bagTouches = events
    .flatMap((e) => (e.type === "child" && e.event.type === "tool_result" && e.event.summary ? [e.event.summary] : []))
    .filter((s) => /\b(add to (bag|cart|basket)|checkout|check out|buy now|place order)\b/i.test(s));
  return { status: result.status, trail, read: found.price ?? null, facts: await pageFacts(opts.browser), screens, bagTouches, error: result.error?.message, ms: Date.now() - t0 };
}
