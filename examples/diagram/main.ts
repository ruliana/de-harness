// npm run example:diagram -- [--scenario login-sequence|ask-wrong-password|insert-step|tidy] [--runs 1]   a scripted person, headless
// npm run example:diagram -- --headed                                                          you type into the panel yourself (needs a display)
// A small diagram studio with the assistant's panel beside the drawing. The person types an instruction into the panel, the agent edits
// the diagram (the state is its Mermaid text, drawn by the page as it changes), and the panel shows a question when it has one, and the result.
import { parseArgs } from "node:util";
import { JevModel } from "../../src/index.js";
import { BrowserSession, PageOverlay } from "../../src/browser/index.js";
import { draw, serve } from "./assistant.js";
import { startDiagramSite } from "./diagram-site.js";
import { EMPTY } from "./graph.js";
import { SCENARIOS, problems, runScenario, type Outcome } from "./run.js";

const { values } = parseArgs({ options: { scenario: { type: "string", default: "login-sequence" }, runs: { type: "string", default: "1" }, headed: { type: "boolean", default: false } } });
const model = () => new JevModel({ apiKey: process.env.TYPESAFE_API_KEY });

if (values.headed) {
  // A person at a visible window: no scripted instruction, the panel is the only way in.
  const site = await startDiagramSite();
  const browser = await BrowserSession.launch({ allowedHosts: ["127.0.0.1"], launch: { headless: false } });
  const overlay = await PageOverlay.install(browser, { title: "Diagram assistant", placeholder: "Tell me what to draw" });
  await browser.goto(site.url);
  await draw(browser, EMPTY);
  serve({ browser, overlay, model: model(), input: overlay.input, onEvent: (e) => e.type === "tool_call" && console.log(`step ${e.step}: ${e.tool}(${JSON.stringify(e.args).slice(0, 110)})`) });
  console.log("Type an instruction into the panel at the bottom right of the window, for example:\n  Draw a sequence diagram of a login. The user enters credentials in the browser, the browser sends a login request to the server, ...\nCtrl-C stops.");
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
  console.log(o.diagram);
  const bad = problems(o);
  console.log(`${bad.length ? "MISS" : "ok  "} ${o.handled?.result.steps.length ?? 0} steps, ${o.handled?.result.status}${bad.length ? `\n     ${bad.join("; ")}` : ""}`);
}
const ok = outcomes.filter((o) => problems(o).length === 0).length;
console.log(`\n${ok} of ${outcomes.length} runs correct (${scenario.name}); steps per run: ${outcomes.map((o) => o.handled?.result.steps.length ?? 0).join(", ")}`);
process.exit(ok === outcomes.length ? 0 : 1);
