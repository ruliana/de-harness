// npm run example:storefront-browser -- [--site live|fixture] [--runs 1] [--max-steps 14] [--out shots/] [--plain | --task "..."]
// "Go to aloyoga.com, find a blue sweatshirt, select size large, and get the price" with a headless browser: the page is only a
// screenshot, Jev points with boxes. `--site live` is the real aloyoga.com (reads only: no bag, no checkout); `--site fixture` is the
// look-alike shop on loopback that the acceptance test uses.
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { JevModel } from "../../src/index.js";
import { plainInstructions } from "./shopping.js";
import { LIVE, launchFixture, launchLive, problems, runOnce, startFixture, type Outcome, type SiteKind } from "./run.js";

const { values } = parseArgs({ options: { site: { type: "string", default: "live" }, runs: { type: "string", default: "1" }, "max-steps": { type: "string", default: "14" }, out: { type: "string" }, task: { type: "string" }, plain: { type: "boolean", default: false } } });
const kind = values.site as SiteKind;
if (kind !== "live" && kind !== "fixture") throw new Error("--site is live or fixture");
if (values.out) mkdirSync(values.out, { recursive: true });

const site = kind === "fixture" ? await startFixture() : null;
const outcomes: Outcome[] = [];
try {
  for (let i = 1; i <= Number(values.runs); i++) {
    console.log(`\n== run ${i} on the ${kind} shop`);
    const browser = site ? await launchFixture() : await launchLive();
    try {
      const o = await runOnce({ kind, browser, home: site ? `${site.url}/` : LIVE.home, model: new JevModel({ apiKey: process.env.TYPESAFE_API_KEY }), instructions: values.task ?? (values.plain ? plainInstructions(kind === "live" ? "aloyoga.com" : "the shop") : undefined), maxSteps: Number(values["max-steps"]), onStep: (l) => console.log(l) });
      outcomes.push(o);
      const bad = problems(o);
      console.log(`${bad.length ? "MISS" : "ok  "} ${o.result.steps.length} steps, status ${o.result.status}; read ${o.read ?? "nothing"}; page: ${o.facts ? `${o.facts.product} / ${o.facts.colour} / ${o.facts.size} / listed ${o.facts.listedPrice}` : "not a product page"}${bad.length ? `\n     ${bad.join("; ")}` : ""}`);
      if (values.out) writeFileSync(`${values.out}/run${i}.png`, await browser.screenshot());
    } finally {
      await browser.close();
    }
  }
} finally {
  await site?.close();
}
const ok = outcomes.filter((o) => problems(o).length === 0).length;
console.log(`\n${ok} of ${outcomes.length} runs correct on the ${kind} shop; steps per run: ${outcomes.map((o) => o.result.steps.length).join(", ")}`);
process.exit(ok === outcomes.length ? 0 : 1);
