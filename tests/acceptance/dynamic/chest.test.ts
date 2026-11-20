/** Dynamic tools against Jev (through a cassette): the key unlocks a tool that did not exist before. */
import { beforeAll, describe, expect, it } from "vitest";
import { TOOL_QUESTION, createAgent, type RunResult } from "../../../src/index.js";
import { createChest } from "../../../examples/chest/chest.js";
import { jevFor } from "../../support/models.js";

const INSTRUCTIONS = "Open the chest, then stop";

const toolsOffered = (request: RunResult["steps"][number]["request"]) => Object.keys((request.questions[TOOL_QUESTION] as { criteria: object }).criteria);
const asksAbout = (request: RunResult["steps"][number]["request"], tool: string) => Object.keys(request.questions).some((id) => id.startsWith(`${tool}.`));

describe("key and chest", () => {
  let result: RunResult;
  let world: ReturnType<typeof createChest>["world"];

  beforeAll(async () => {
    const chest = createChest();
    world = chest.world;
    result = await createAgent({ model: jevFor("dynamic"), instructions: INSTRUCTIONS, tools: chest.tools, initialState: chest.initialState, maxSteps: 5 }).run();
  });

  it("picks up the key, opens the chest and ends", () => {
    expect(result.status).toBe("ended");
    expect(result.steps.map((s) => s.tool)).toEqual(["pick_up_key", "open_chest", "end"]);
    expect(world.chest).toBe("open");
  });

  it("starts with only pick_up_key and end, and open_chest appears in the requests after the key", () => {
    const [first, ...later] = result.steps.map((s) => s.request);
    expect(toolsOffered(first!)).toEqual(["pick_up_key", "end"]);
    expect(asksAbout(first!, "open_chest")).toBe(false);
    for (const request of later) {
      expect(toolsOffered(request)).toContain("open_chest");
      expect(asksAbout(request, "open_chest")).toBe(true);
    }
  });

  it("shows the tool set changing between steps in the trace", () => {
    const changes = result.events.filter((e) => e.type === "tools_changed");
    expect(changes).toMatchObject([
      { step: 1, change: "added", tool: "open_chest", tools: ["pick_up_key", "end", "open_chest"] },
      { step: 1, change: "removed", tool: "pick_up_key", tools: ["end", "open_chest"] },
    ]);
    const offered = result.events.filter((e) => e.type === "step_start").map((e) => e.tools);
    expect(offered).toEqual([["pick_up_key", "end"], ["end", "open_chest"], ["end", "open_chest"]]);
  });
});
