/** The core loop against Jev (through a cassette): leave a room through the red door. */
import { beforeAll, describe, expect, it } from "vitest";
import { TOOL_QUESTION, createAgent, type RunResult } from "../../../src/index.js";
import { createRooms } from "../../../examples/rooms/rooms.js";
import { jevFor } from "../../support/models.js";

const INSTRUCTIONS = "Leave the room through the red door";

describe("rooms: leave through the red door", () => {
  let result: RunResult;
  let world: ReturnType<typeof createRooms>["world"];

  beforeAll(async () => {
    const rooms = createRooms();
    world = rooms.world;
    result = await createAgent({ model: jevFor("core"), instructions: INSTRUCTIONS, tools: rooms.tools, initialState: rooms.initialState, maxSteps: 4 }).run();
  });

  it("ends within 4 steps, and the trace shows open_door with door = red", () => {
    expect(result.status).toBe("ended");
    expect(result.steps.length).toBeLessThanOrEqual(4);
    const call = result.events.find((e) => e.type === "tool_call" && e.tool === "open_door");
    expect(call).toMatchObject({ args: { door: "red" } });
    expect(world.room).toBe("outside");
  });

  it("sends identical instructions, one __tool__ Choice and one question per parameter of every available tool in every request", () => {
    for (const { request } of result.steps) {
      const state = request.state as { instructions: string; state: { room: { doors: string[] } } };
      expect(state.instructions).toBe(INSTRUCTIONS);
      expect(Object.keys(request.questions).filter((id) => id === TOOL_QUESTION)).toHaveLength(1);
      expect(request.questions[TOOL_QUESTION]!.type).toBe("choice");
      // open_door (one parameter, `door`) is available while the room has doors; turn_on_light has no parameters
      const expected = state.state.room.doors.length > 0 ? [TOOL_QUESTION, "open_door.door"] : [TOOL_QUESTION];
      expect(Object.keys(request.questions).sort()).toEqual(expected);
    }
  });
});
