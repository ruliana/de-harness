// npm run example:load-api -- [--runs 3] ["find the open ticket assigned to Ana and close it"]
import { JevModel, createAgent } from "../../src/index.js";
import { startServer } from "./server.js";
import { createLoader } from "./load-api.js";

const TASK = "Find the open ticket assigned to Ana and close it";

const args = process.argv.slice(2);
const runsAt = args.indexOf("--runs");
const runs = runsAt >= 0 ? Number(args.splice(runsAt, 2)[1]) : 1;
const instructions = args.join(" ") || TASK;

let correct = 0;
for (let run = 1; run <= runs; run++) {
  const server = await startServer();
  const before = server.snapshot();
  const loader = createLoader({
    helpdesk: { description: "Support tickets: list, read, create, update, close and delete tickets", spec: `${server.url}/helpdesk/openapi.json` },
    inventory: { description: "Office equipment in stock: list items and read one", spec: `${server.url}/inventory/openapi.json` },
  });
  const result = await createAgent({
    model: new JevModel({ apiKey: process.env.TYPESAFE_API_KEY }),
    instructions,
    tools: loader.tools,
    initialState: loader.initialState,
    maxSteps: 10,
    onEvent: (e) => {
      if (runs === 1 && e.type === "step_start") console.log(`step ${e.step} offers: ${e.tools.join(", ")}`);
      if (runs === 1 && e.type === "tool_call") console.log(`        -> ${e.tool}(${JSON.stringify(e.args)})`);
      if (runs === 1 && e.type === "tool_result" && e.error) console.log(`        error: ${e.error}`);
    },
  }).run();
  const changed = server.snapshot().filter((t, i) => JSON.stringify(t) !== JSON.stringify(before[i]));
  const ok = result.status === "ended" && changed.length === 1 && changed[0]!.id === 4 && changed[0]!.status === "closed" && server.snapshot().length === before.length;
  if (ok) correct++;
  console.log(`run ${run}: ${ok ? "ok" : "WRONG"}: ${result.status} in ${result.steps.length} steps (${result.steps.map((s) => s.tool).join(" > ")}); changed tickets: ${changed.map((t) => `#${t.id} ${t.status}`).join(", ") || "none"}; 4xx/5xx: ${server.log.filter((l) => l.status >= 400).length}`);
  await server.close();
}
if (runs > 1) console.log(`\n${correct} of ${runs} runs closed Ana's open ticket and changed nothing else`);
