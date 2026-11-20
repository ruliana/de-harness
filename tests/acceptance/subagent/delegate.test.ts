/** W5: a parent agent hands a task to a child agent (ctx.runAgent / delegateTool), against Jev through a cassette. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createAgent, delegateTool, type RunResult } from "../../../src/index.js";
import { createRooms } from "../../../examples/rooms/rooms.js";
import { jevFor } from "../../support/models.js";

const INSTRUCTIONS = "Have the helper find the red door and leave the room through it. Stop once the helper has reported back in `state.delegated`.";

describe("delegate: a parent hands the red door to a child with the rooms tools", () => {
  let result: RunResult;
  let world: ReturnType<typeof createRooms>["world"];
  let trace: string;

  beforeAll(async () => {
    const rooms = createRooms();
    world = rooms.world;
    trace = join(mkdtempSync(join(tmpdir(), "delegate-")), "run.jsonl");
    const delegate = delegateTool({
      description: "Hands a task to a helper agent that can walk through the doors of the rooms, and waits for its report.",
      tasks: {
        "Leave the room through the red door": "The helper finds the red door and walks out through it",
        "Leave the room through the blue door": "The helper finds the blue door and walks out through it",
        "Leave the room through the green door": "The helper finds the green door and walks out through it",
      },
      agent: (task) => ({ instructions: task, tools: rooms.tools, initialState: rooms.initialState, maxSteps: 4 }),
    });
    result = await createAgent({ model: jevFor("subagent"), instructions: INSTRUCTIONS, tools: [delegate], maxSteps: 4, trace }).run();
  });

  it("delegates the red door to the child, puts the child's output in a parent slot, and the parent ends", () => {
    expect(result.status).toBe("ended");
    expect(result.steps[0]).toMatchObject({ tool: "delegate", args: { task: "Leave the room through the red door" } });
    expect(world.room).toBe("outside");
    expect(result.state.delegated).toMatchObject({ task: "Leave the room through the red door", status: "ended", output: { room: { name: "outside" } } });
  });

  it("never shows the child's tools to the parent, nor the parent's tools to the child", () => {
    const parentIds = result.steps.flatMap((s) => Object.keys(s.request.questions));
    expect(parentIds.some((id) => id.startsWith("open_door") || id.startsWith("turn_on_light"))).toBe(false);
    const childRequests = result.events.filter((e) => e.type === "child").flatMap((e) => (e.event.type === "request" ? [e.event.request] : []));
    expect(childRequests.length).toBeGreaterThan(0);
    for (const request of childRequests) expect(Object.keys(request.questions).some((id) => id.startsWith("delegate"))).toBe(false);
  });

  it("writes the child's events to the trace nested under the parent step that called it", () => {
    const lines = readFileSync(trace, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    // no child request is ever written at the top level: only the parent's own
    expect(lines.filter((l) => l.type === "request")).toHaveLength(result.steps.length);
    const call = lines.findIndex((l) => l.type === "tool_call" && l.tool === "delegate");
    const done = lines.findIndex((l) => l.type === "tool_result" && l.tool === "delegate");
    const nested = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.type === "child");
    expect(nested.length).toBeGreaterThan(0);
    for (const { l, i } of nested) {
      expect(l.step).toBe(1);
      expect(i).toBeGreaterThan(call);
      expect(i).toBeLessThan(done);
    }
    expect(nested[0]!.l.event.type).toBe("run_start");
    expect(nested.at(-1)!.l.event).toMatchObject({ type: "run_end", status: "ended" });
  });
});
