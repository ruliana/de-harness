// npm run example:pizza -- "A large pizza with mushrooms and olives, delivered at 7pm"
import { JevModel, createAgent } from "../../src/index.js";
import { createPizza } from "./pizza.js";

const instructions = process.argv.slice(2).join(" ") || "A large pizza with mushrooms and olives";
const pizza = createPizza();
const result = await createAgent({
  model: new JevModel({ apiKey: process.env.TYPESAFE_API_KEY }),
  instructions,
  tools: pizza.tools,
  initialState: pizza.initialState,
  maxSteps: 4,
  onEvent: (e) => {
    if (e.type === "tool_call") console.log(`step ${e.step}: ${e.tool}(${JSON.stringify(e.args)})`);
  },
}).run();

console.log(`\nstatus: ${result.status} after ${result.steps.length} steps`);
console.log(`orders: ${JSON.stringify(pizza.orders)}`);
if (result.error) console.error(result.error.message);
