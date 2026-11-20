// npm run example:page-overlay -- [--scenario express|ask-express|ask-standard] [--runs 1] [--out shots/]     a scripted person, headless
// npm run example:page-overlay -- --headed                                                                    you type into the panel yourself (needs a display)
// The checkout page of a small shop with the assistant's panel over it. The person types an instruction into the panel, the agent
// operates the page behind it, and the panel shows the steps, a question when it has one, and the result.
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { JevModel } from "../../src/index.js";
import { BrowserSession, PageOverlay } from "../../src/browser/index.js";
import { serve } from "./assistant.js";
import { startCheckoutSite } from "./checkout-site.js";
import { SCENARIOS, problems, runScenario, type Outcome } from "./run.js";

const { values } = parseArgs({ options: { scenario: { type: "string", default: "express" }, runs: { type: "string", default: "1" }, headed: { type: "boolean", default: false }, out: { type: "string" } } });
const model = () => new JevModel({ apiKey: process.env.TYPESAFE_API_KEY });

if (values.headed) {
  // A person at a visible window: no scripted instruction, the panel is the only way in.
  const site = await startCheckoutSite();
  const browser = await BrowserSession.launch({ allowedHosts: ["127.0.0.1"], launch: { headless: false } });
  const overlay = await PageOverlay.install(browser, { title: "Tern assistant" });
  await browser.goto(`${site.url}/checkout`);
  serve({ browser, overlay, model: model(), input: overlay.input, onEvent: (e) => e.type === "tool_call" && console.log(`step ${e.step}: ${e.tool}(${JSON.stringify(e.args).slice(0, 90)})`) });
  console.log("Type an instruction into the panel at the bottom right of the window, for example:\n  Fill in my shipping details, choose express delivery and place the order\nCtrl-C stops.");
  await new Promise(() => {});
}

const scenario = SCENARIOS.find((s) => s.name === values.scenario);
if (!scenario) throw new Error(`--scenario is one of ${SCENARIOS.map((s) => s.name).join(", ")}`);
if (values.out) mkdirSync(values.out, { recursive: true });

const outcomes: Outcome[] = [];
for (let i = 1; i <= Number(values.runs); i++) {
  console.log(`\n== run ${i}: ${scenario.name}${scenario.answer ? ` (the person answers "${scenario.answer}")` : ""}`);
  const o = await runScenario({ scenario, model: model(), shots: Boolean(values.out), onStep: (l) => console.log(l) });
  outcomes.push(o);
  for (const m of o.messages) console.log(`  panel [${m.kind}] ${m.text}`);
  const bad = problems(o);
  console.log(`${bad.length ? "MISS" : "ok  "} ${o.handled?.result.steps.length ?? 0} steps, ${o.handled?.result.status}; the shop got ${JSON.stringify(o.orders)}${bad.length ? `\n     ${bad.join("; ")}` : ""}`);
  for (const [name, png] of Object.entries(o.shots)) writeFileSync(`${values.out}/${scenario.name}-run${i}-${name}.png`, png);
}
const ok = outcomes.filter((o) => problems(o).length === 0).length;
console.log(`\n${ok} of ${outcomes.length} runs correct (${scenario.name}); steps per run: ${outcomes.map((o) => o.handled?.result.steps.length ?? 0).join(", ")}`);
process.exit(ok === outcomes.length ? 0 : 1);
