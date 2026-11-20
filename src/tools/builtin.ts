import { defineTool } from "./tool.js";

/** The built-in `end` tool. Choosing it stops the run; the run's output is the final state. */
export function endTool() {
  return defineTool({
    name: "end",
    description: "Stops, because `instructions` have been carried out according to `state`, or cannot be carried out.",
    run: (_args, ctx) => ({ end: true, output: ctx.state, summary: "ended" }),
  });
}
