/**
 * Live example: `npm run example:tree -- "Where does a cordless drill belong?"`
 * Prints the path the agent walked and the category it selected.
 */
import { JevModel, createAgent } from "../../src/index.js";
import { countNodes, formatPath } from "./taxonomy.js";
import { createTree } from "./tree.js";

const question = process.argv.slice(2).join(" ") || "Where does a cordless drill belong?";
const tree = createTree();
console.log(`${countNodes(tree.root)} categories. ${question}\n`);

const result = await createAgent({
  model: new JevModel(),
  instructions: `${question} Walk down the product taxonomy to its category and select that category.`,
  tools: tree.tools,
  initialState: tree.initialState,
  maxSteps: 12,
}).run();

console.log(tree.world.visits.map((n) => formatPath(n.path)).join("\n  -> "));
console.log(`\n${result.status} after ${result.steps.length} steps:`, result.output);
if (result.error) console.error(result.error.message);
