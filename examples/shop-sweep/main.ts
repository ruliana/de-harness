// npm run example:shops -- --shop taylorstitch [--runs 3] [--out dir] [--pause 4]
// The one-sentence task on shops the agent was never tuned on, by the two levels of examples/storefront-by-sight (unchanged).
// Writes <out>/<shop>/run-N/{result.json, step-NN.png, final.png}. Scoring is by the person: compare final.png and result.json with the live page.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { JevModel } from "../../src/index.js";
import { launchShop, runShop, taskFor } from "./run.js";
import { SHOPS } from "./shops.js";

const { values } = parseArgs({ options: { shop: { type: "string" }, runs: { type: "string", default: "3" }, out: { type: "string", default: "shop-sweep-runs" }, pause: { type: "string", default: "4" }, from: { type: "string", default: "1" } } });
const shop = SHOPS.find((s) => s.id === values.shop);
if (!shop) throw new Error(`--shop is one of ${SHOPS.map((s) => s.id).join(", ")}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const runs = Number(values.runs);
const from = Number(values.from);
console.log(`${shop.name}: ${taskFor(shop).text}`);
for (let i = from; i < from + runs; i++) {
  console.log(`\n== ${shop.id} run ${i}`);
  const dir = join(values.out!, shop.id, `run-${i}`);
  mkdirSync(dir, { recursive: true });
  const browser = await launchShop(shop);
  try {
    const r = await runShop({ shop, browser, model: new JevModel({ apiKey: process.env.TYPESAFE_API_KEY }), onStep: (l) => console.log(l) });
    for (const s of r.screens) writeFileSync(join(dir, s.name), s.png);
    const { screens, ...json } = r;
    writeFileSync(join(dir, "result.json"), JSON.stringify({ shop: shop.id, task: taskFor(shop).text, ...json }, null, 2));
    console.log(`${r.status} in ${r.trail.length} steps (${Math.round(r.ms / 1000)} s); read ${r.read ?? "nothing"}; page ${r.facts.url}`);
  } catch (e) {
    console.log(`CRASH ${(e as Error).message}`);
    writeFileSync(join(dir, "result.json"), JSON.stringify({ shop: shop.id, task: taskFor(shop).text, status: "crash", error: (e as Error).message }, null, 2));
  } finally {
    await browser.close();
  }
  if (i < from + runs - 1) await sleep(Number(values.pause) * 1000);
}
