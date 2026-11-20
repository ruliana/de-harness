// npm run example:probe -- --site fixture|live [--runs 5] [--out dir] | --from dir
// Runs the spelled-out shopping agent (the 5/5 mode of examples/storefront-browser) and asks the deciding level about every screenshot.
// `--out dir` keeps the steps (screenshots included) as JSON; `--from dir` asks again about saved steps without running a browser.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { JevModel } from "../../src/index.js";
import { LIVE, launchFixture, launchLive, problems, runOnce, startFixture, type SiteKind } from "../storefront-browser/run.js";
import { plainTask } from "../storefront-browser/shopping.js";
import { formatReport, probeSteps, report, scoreSteps, type ProbeStep } from "./probe.js";

const { values } = parseArgs({ options: { site: { type: "string", default: "fixture" }, runs: { type: "string", default: "5" }, out: { type: "string" }, from: { type: "string" } } });
const kind = values.site as SiteKind;
const model = new JevModel({ apiKey: process.env.TYPESAFE_API_KEY });
const task = plainTask(kind === "live" ? "aloyoga.com" : "the shop");

let steps: ProbeStep[] = [];
if (values.from) {
  for (const f of readdirSync(values.from).filter((f) => f.endsWith(".json")).sort()) steps.push(...(JSON.parse(readFileSync(`${values.from}/${f}`, "utf8")) as ProbeStep[]));
} else {
  if (values.out) mkdirSync(values.out, { recursive: true });
  const site = kind === "fixture" ? await startFixture() : null;
  try {
    for (let i = 1; i <= Number(values.runs); i++) {
      const browser = site ? await launchFixture() : await launchLive();
      try {
        const o = await runOnce({ kind, browser, home: site ? `${site.url}/` : LIVE.home, model, maxSteps: 14 });
        const bad = problems(o);
        console.log(`run ${i}: ${bad.length ? "MISS " + bad.join("; ") : "ok"}; ${o.trail.map((t) => t.split(" ")[0]).join(" ")}`);
        const s = probeSteps(`${kind}-${i}`, o.result);
        steps.push(...s);
        if (values.out) writeFileSync(`${values.out}/${kind}-${i}.json`, JSON.stringify(s));
      } finally {
        await browser.close();
      }
    }
  } finally {
    await site?.close();
  }
}
const scored = await scoreSteps(model, task, steps);
if (values.out) writeFileSync(`${values.out}/scored-${kind}.json`, JSON.stringify(scored, null, 1));
console.log("\n" + formatReport(report(scored), `${kind} (${new Set(steps.map((s) => s.run)).size} runs)`));
