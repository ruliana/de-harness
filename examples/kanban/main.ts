// npm run example:kanban -- [--scenario move-assign|ask-assignee|move-only] [--runs 1]     a scripted person, headless
// npm run example:kanban -- --headed                                                       you type into the panel yourself (needs a display)
// A small Kanban board with the assistant's panel beside it. The person types an instruction into the panel, the agent operates the
// board by sight (drags cards between columns, opens a card to assign it), and the panel shows the steps, a question when it has one, and the result.
import { parseArgs } from "node:util";
import { JevModel } from "../../src/index.js";
import { BrowserSession, PageOverlay } from "../../src/browser/index.js";
import { serve } from "./assistant.js";
import { startKanbanSite } from "./kanban-site.js";
import { SCENARIOS, problems, runScenario, type Outcome } from "./run.js";

const { values } = parseArgs({ options: { scenario: { type: "string", default: "move-assign" }, runs: { type: "string", default: "1" }, headed: { type: "boolean", default: false } } });
const model = () => new JevModel({ apiKey: process.env.TYPESAFE_API_KEY });

if (values.headed) {
  // A person at a visible window: no scripted instruction, the panel is the only way in.
  const site = await startKanbanSite();
  const browser = await BrowserSession.launch({ allowedHosts: ["127.0.0.1"], launch: { headless: false } });
  const overlay = await PageOverlay.install(browser, { title: "Board assistant", placeholder: "Tell me what to do on the board" });
  await browser.goto(site.url);
  serve({ browser, overlay, model: model(), input: overlay.input, onEvent: (e) => e.type === "tool_call" && console.log(`step ${e.step}: ${e.tool}(${JSON.stringify(e.args).slice(0, 110)})`) });
  console.log("Type an instruction into the panel at the bottom right of the window, for example:\n  Move the 'Fix login' card to Done and assign it to Sam\nCtrl-C stops.");
  await new Promise(() => {});
}

const scenario = SCENARIOS.find((s) => s.name === values.scenario);
if (!scenario) throw new Error(`--scenario is one of ${SCENARIOS.map((s) => s.name).join(", ")}`);

const outcomes: Outcome[] = [];
for (let i = 1; i <= Number(values.runs); i++) {
  console.log(`\n== run ${i}: ${scenario.name}${scenario.answer ? ` (the person answers "${scenario.answer}")` : ""}`);
  const o = await runScenario({ scenario, model: model(), onStep: (l) => console.log(l) });
  outcomes.push(o);
  for (const m of o.messages) console.log(`  panel [${m.kind}] ${m.text}`);
  const bad = problems(o);
  console.log(`${bad.length ? "MISS" : "ok  "} ${o.handled?.result.steps.length ?? 0} steps, ${o.handled?.result.status}${bad.length ? `\n     ${bad.join("; ")}` : ""}`);
}
const ok = outcomes.filter((o) => problems(o).length === 0).length;
console.log(`\n${ok} of ${outcomes.length} runs correct (${scenario.name}); steps per run: ${outcomes.map((o) => o.handled?.result.steps.length ?? 0).join(", ")}`);
process.exit(ok === outcomes.length ? 0 : 1);
