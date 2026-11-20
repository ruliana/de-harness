/**
 * Live example: `npm run example:graph -- Airport Stadium`
 * Prints the stations the agent visited, in order, and the length of the shortest route.
 */
import { JevModel, createAgent } from "../../src/index.js";
import { createTransit, defaultLines, shortestPath } from "./transit.js";

const [from = "Airport", to = "Stadium"] = process.argv.slice(2);
const transit = createTransit({ start: from });

const result = await createAgent({
  model: new JevModel(),
  instructions: `You are at ${from} station. Get to ${to} station by riding the lines, then stop.`,
  tools: transit.tools,
  initialState: transit.initialState,
  maxSteps: 12,
}).run();

console.log(transit.world.path.join(" -> "));
console.log(`${result.status} after ${result.steps.length} steps; shortest route is ${shortestPath(defaultLines, from, to)} rides`);
if (result.error) console.error(result.error.message);
