// npm run example:tickets -- "Send every billing ticket to the billing team and close duplicates"
import { JevModel, createAgent } from "../../src/index.js";
import { startTicketServer } from "./server.js";
import { createTicketDesk } from "./tickets.js";

const instructions = process.argv.slice(2).join(" ") || "Send every billing ticket to the billing team and close duplicates";
const server = await startTicketServer();
const before = server.snapshot();
const desk = await createTicketDesk(server.url);

const result = await createAgent({
  model: new JevModel({ apiKey: process.env.TYPESAFE_API_KEY }),
  instructions,
  tools: desk.tools,
  initialState: desk.initialState,
  maxSteps: 30,
  onEvent: (e) => {
    if (e.type === "tool_call") console.log(`step ${e.step}: ${e.tool}(${JSON.stringify(e.args)})`);
    if (e.type === "tool_result" && e.summary) console.log(`        -> ${e.summary}`);
  },
}).run();

console.log(`\nstatus: ${result.status} after ${result.steps.length} steps`);
console.table(
  server.snapshot().map((t, i) => ({ id: t.id, subject: t.subject.slice(0, 40), "team before": before[i]!.team ?? "-", "team after": t.team ?? "-", "status before": before[i]!.status, "status after": t.status })),
);
await server.close();
if (result.error) console.error(result.error.message);
