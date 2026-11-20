// npm run example:storefront -- [--task "..."] [--max-steps 10]
import { parseArgs } from "node:util";
import { JevModel, createAgent } from "../../src/index.js";
import { storefrontFetch } from "./http.js";
import { SHOPPING_TASK, createStorefrontTools } from "./storefront.js";

const { values } = parseArgs({ options: { task: { type: "string", default: SHOPPING_TASK }, "max-steps": { type: "string", default: "10" }, base: { type: "string" } } });

const shop = await createStorefrontTools({ baseUrl: values.base, fetch: storefrontFetch({ dir: "tests/cassettes/storefront-http", mode: "passthrough" }) });
const agent = createAgent({
  model: new JevModel({ apiKey: process.env.TYPESAFE_API_KEY }),
  instructions: values.task!,
  tools: shop.tools,
  initialState: shop.initialState,
  maxSteps: Number(values["max-steps"]),
  onEvent: (e) => {
    if (e.type === "tool_call") console.log(`step ${e.step}: ${e.tool}${Object.keys(e.args).length ? `(${JSON.stringify(e.args)})` : ""}`);
    if (e.type === "tool_result" && e.summary) console.log(`        -> ${e.summary}`);
  },
});

const result = await agent.run();
console.log(`\npath: ${shop.trail().join(" > ")}`);
console.log(`status: ${result.status} after ${result.steps.length} steps`);
console.log(`found: ${JSON.stringify(shop.found())}`);
if (result.error) console.error(result.error.message);
process.exit(result.status === "ended" && shop.found() ? 0 : 1);
