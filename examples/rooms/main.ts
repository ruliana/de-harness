// npm run example:rooms -- "Leave the room through the red door"
import { JevModel, createAgent } from "../../src/index.js";
import { createRooms } from "./rooms.js";

const instructions = process.argv.slice(2).join(" ") || "Leave the room through the red door";
const rooms = createRooms();
const agent = createAgent({
  model: new JevModel({ apiKey: process.env.TYPESAFE_API_KEY }),
  instructions,
  tools: rooms.tools,
  initialState: rooms.initialState,
  maxSteps: 6,
  onEvent: (e) => {
    if (e.type === "tool_call") console.log(`step ${e.step}: ${e.tool}(${JSON.stringify(e.args)})`);
    if (e.type === "tool_result" && e.summary) console.log(`        -> ${e.summary}`);
  },
});

const result = await agent.run();
console.log(`\nstatus: ${result.status} after ${result.steps.length} steps; now in the ${rooms.world.room}`);
if (result.error) console.error(result.error.message);
