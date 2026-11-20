// npm run example:by-sight -- [--site live|fixture] [--runs 1] [--max-steps 10] [--no-rules]
// The one-sentence task, by sight: a deciding level that looks only at the screenshot and picks a tactic, and a navigating level that
// carries it out with a Box. `--site live` is the real aloyoga.com (reads only), `fixture` the look-alike shop of the acceptance test.
import { parseArgs } from "node:util";
import { JevModel } from "../../src/index.js";
import { LIVE, launchFixture, launchLive, problems, runBySight, startFixture } from "./run.js";
import type { SiteKind } from "../storefront-browser/run.js";

const { values } = parseArgs({ options: { site: { type: "string", default: "fixture" }, runs: { type: "string", default: "1" }, "max-steps": { type: "string", default: "10" }, "no-rules": { type: "boolean", default: false } } });
const kind = values.site as SiteKind;
if (kind !== "live" && kind !== "fixture") throw new Error("--site is live or fixture");
const site = kind === "fixture" ? await startFixture() : null;
let ok = 0;
const runs = Number(values.runs);
try {
  for (let i = 1; i <= runs; i++) {
    console.log(`\n== run ${i} on the ${kind} shop`);
    const browser = site ? await launchFixture() : await launchLive();
    try {
      const o = await runBySight({ kind, browser, home: site ? `${site.url}/` : LIVE.home, model: new JevModel({ apiKey: process.env.TYPESAFE_API_KEY }), maxSteps: Number(values["max-steps"]), rules: !values["no-rules"], onStep: (l) => console.log(l) });
      const bad = problems(o);
      if (bad.length === 0) ok++;
      console.log(`${bad.length ? "MISS" : "ok  "} ${o.result.steps.length} steps, status ${o.result.status}; read ${o.read ?? "nothing"}; page: ${o.facts ? `${o.facts.product} / ${o.facts.colour} / ${o.facts.size} / listed ${o.facts.listedPrice}` : "not a product page"}${bad.length ? `\n     ${bad.join("; ")}` : ""}`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await site?.close();
}
console.log(`\n${ok} of ${runs} runs correct on the ${kind} shop`);
process.exit(ok === runs ? 0 : 1);
