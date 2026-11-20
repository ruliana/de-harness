// npm run example:wikipedia -- --from "Alan Turing" --to "Enigma machine"
import { parseArgs } from "node:util";
import { JevModel, createAgent } from "../../src/index.js";
import { wikipediaFetch } from "./http.js";
import { createWikipedia, instructionsFor } from "./wikipedia.js";

const { values } = parseArgs({ options: { from: { type: "string" }, to: { type: "string" }, "max-steps": { type: "string", default: "10" } } });
if (!values.from || !values.to) {
  console.error('usage: npm run example:wikipedia -- --from "<article>" --to "<article>" [--max-steps 10]');
  process.exit(2);
}

const wiki = await createWikipedia({ start: values.from, fetch: wikipediaFetch({ dir: "tests/cassettes/wikipedia-http", mode: "passthrough" }) });
const agent = createAgent({
  model: new JevModel({ apiKey: process.env.TYPESAFE_API_KEY }),
  instructions: instructionsFor(values.from, values.to),
  tools: wiki.tools,
  initialState: wiki.initialState,
  maxSteps: Number(values["max-steps"]),
  onEvent: (e) => {
    if (e.type === "tool_call") console.log(`step ${e.step}: ${e.tool}${Object.keys(e.args).length ? `(${JSON.stringify(e.args)})` : ""}`);
    if (e.type === "tool_result" && e.summary) console.log(`        -> ${e.summary}`);
  },
});

const result = await agent.run();
console.log(`\npath: ${wiki.trail().join(" > ")}`);
console.log(`status: ${result.status} after ${result.steps.length} steps; on "${wiki.current().title}"`);
if (result.error) console.error(result.error.message);
process.exit(result.status === "ended" && wiki.current().title === values.to ? 0 : 1);
