// npm run example:coffee            (interactive: answer in the terminal)
// echo "large please" | npm run example:coffee
import { JevModel, StdinInput, createAgent } from "../../src/index.js";
import { createCoffee } from "./coffee.js";

const coffee = createCoffee();
const input = new StdinInput();
const agent = createAgent({
  model: new JevModel({ apiKey: process.env.TYPESAFE_API_KEY }),
  instructions: process.argv.slice(2).join(" ") || "Take the customer's coffee order: ask which size they want, then place the order",
  tools: coffee.tools,
  input,
  maxSteps: 8,
  onEvent: (e) => {
    if (e.type === "tool_call") console.log(`step ${e.step}: ${e.tool}(${JSON.stringify(e.args)})`);
    if (e.type === "tool_result" && e.summary) console.log(`        -> ${e.summary}`);
  },
});

const result = await agent.run();
input.close();
console.log(`\nstatus: ${result.status} after ${result.steps.length} steps; orders: ${JSON.stringify(coffee.orders)}`);
if (result.error) console.error(result.error.message);
