/** Graph navigation: a transit map walked with move(neighbour), visited stations filtered out in code. */
import { describe, expect, it } from "vitest";
import { ScriptedModel, TOOL_QUESTION, createAgent } from "../../../src/index.js";
import { createTransit, defaultLines, shortestPath } from "../../../examples/graph/transit.js";
import { jevFor } from "../../support/models.js";

const instructionsFor = (from: string, to: string) => `You are at ${from} station. Get to ${to} station by riding the lines, then stop.`;
const toolNames = (q: Record<string, unknown>) => Object.keys((q[TOOL_QUESTION] as { criteria: object }).criteria);
const optionsOf = (q: Record<string, unknown>, id: string) => Object.keys((q[id] as { criteria: object }).criteria);

describe.each([
  ["Airport", "Stadium"],
  ["Westfield", "Harbour"],
])("graph: from %s to %s", (from, to) => {
  it("reaches the named station without revisiting any node, within 2x the shortest path", async () => {
    const transit = createTransit({ start: from });
    const result = await createAgent({ model: jevFor("graph"), instructions: instructionsFor(from, to), tools: transit.tools, initialState: transit.initialState, maxSteps: 12 }).run();
    const shortest = shortestPath(defaultLines, from, to)!;
    console.log(`${transit.world.path.join(" -> ")}  (${result.status}, ${transit.world.path.length - 1} rides, shortest ${shortest})`);

    expect(result.status).toBe("ended");
    expect(transit.world.at).toBe(to);
    expect(new Set(transit.world.path).size).toBe(transit.world.path.length);
    const rides = result.steps.filter((s) => s.tool === "move").length;
    expect(rides).toBe(transit.world.path.length - 1);
    expect(rides).toBeLessThanOrEqual(2 * shortest);
    expect(result.steps.at(-1)!.tool).toBe("end");
  });
});

describe("graph: mechanics, with a scripted model", () => {
  it("filters visited stations out of the options in code, the starting station included", async () => {
    const transit = createTransit({ start: "Airport" });
    const model = new ScriptedModel([
      { [TOOL_QUESTION]: "move", "move.station": "Northgate" },
      { [TOOL_QUESTION]: "move", "move.station": "Museum" },
      { [TOOL_QUESTION]: "move", "move.station": "Westfield" },
      { [TOOL_QUESTION]: "end" },
    ]);
    const result = await createAgent({ model, instructions: instructionsFor("Airport", "Westfield"), tools: transit.tools, initialState: transit.initialState }).run();

    expect(result.status).toBe("ended");
    expect(transit.world.path).toEqual(["Airport", "Northgate", "Museum", "Westfield"]);
    // Airport only borders Northgate; from Northgate the way back to Airport is not offered
    expect(optionsOf(model.requests[0]!.questions, "move.station")).toEqual(["Northgate"]);
    expect(optionsOf(model.requests[1]!.questions, "move.station")).toEqual(["Central", "Museum"]);
    // from Museum: Northgate is visited and filtered out, the rest remain
    expect(optionsOf(model.requests[2]!.questions, "move.station")).toEqual(["Westfield", "Central", "Old Town"]);
    // the model is told what it has visited
    const lastState = model.requests[3]!.state as { state: { visited: string[] } };
    expect(lastState.state.visited).toEqual(transit.world.path);
  });

  it("offers only end at a dead end, where every neighbour has been visited", async () => {
    const transit = createTransit({ start: "Riverside" });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "move", "move.station": "Harbour" }, { [TOOL_QUESTION]: "end" }]);
    const result = await createAgent({ model, instructions: instructionsFor("Riverside", "Central"), tools: transit.tools, initialState: transit.initialState }).run();

    expect(result.status).toBe("ended");
    expect(toolNames(model.requests[0]!.questions)).toEqual(["move", "end"]);
    expect(toolNames(model.requests[1]!.questions)).toEqual(["end"]);
    expect(Object.keys(model.requests[1]!.questions)).toEqual([TOOL_QUESTION]);
  });
});
