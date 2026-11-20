// npm run example:screen -- "Click the Submit button" [--out proof.png]
// Writes the screen with the model's box drawn on it when --out is given.
import { writeFileSync } from "node:fs";
import { CassetteModel, JevModel, createAgent } from "../../src/index.js";
import { Canvas } from "./canvas.js";
import { formScreen, withBox } from "./render.js";
import { createScreen } from "./screen.js";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args.splice(outAt, 2)[1] : undefined;
const instructions = args.join(" ") || "Click the Submit button";

const screen = createScreen();
let drawn: Canvas = formScreen();
const agent = createAgent({
  // HARNESS_CASSETTE=replay answers from the committed recordings, so the example (and its proof image) can run without a key
  model: process.env.HARNESS_CASSETTE ? new CassetteModel({ dir: "tests/cassettes/screen" }) : new JevModel({ apiKey: process.env.TYPESAFE_API_KEY }),
  instructions,
  tools: screen.tools,
  initialState: screen.initialState,
  maxSteps: 3,
  onEvent: (e) => {
    if (e.type === "tool_call") console.log(`step ${e.step}: ${e.tool}(${JSON.stringify(e.args)})`);
    if (e.type === "tool_result" && e.summary) console.log(`        -> ${e.summary}`);
    if (e.type === "tool_call" && e.tool === "click" && e.step === 1) {
      const target = (e.args as { target: Parameters<typeof withBox>[1] | null }).target;
      if (target) drawn = withBox(formScreen(), target);
    }
  },
});

const result = await agent.run();
console.log(`\nstatus: ${result.status} after ${result.steps.length} steps; page: ${screen.world.page}; clicks: ${JSON.stringify(screen.world.clicks)}`);
if (result.error) console.error(result.error.message);
if (out) {
  writeFileSync(out, drawn.png());
  console.log(`wrote ${out}`);
}
