/** Tree navigation: a product taxonomy walked with descend / ascend / select. */
import { beforeAll, describe, expect, it } from "vitest";
import { ScriptedModel, TOOL_QUESTION, createAgent, type RunResult } from "../../../src/index.js";
import { countNodes, formatPath } from "../../../examples/tree/taxonomy.js";
import { createTree } from "../../../examples/tree/tree.js";
import { jevFor } from "../../support/models.js";

const INSTRUCTIONS = "Where does a cordless drill belong? Walk down the product taxonomy to its category and select that category.";
const toolNames = (q: Record<string, unknown>) => Object.keys((q[TOOL_QUESTION] as { criteria: object }).criteria);
const optionsOf = (q: Record<string, unknown>, id: string) => Object.keys((q[id] as { criteria: object }).criteria);

describe("tree: a cordless drill belongs in Tools > Power Tools > Drills", () => {
  let result: RunResult;
  let tree: ReturnType<typeof createTree>;

  beforeAll(async () => {
    tree = createTree();
    result = await createAgent({ model: jevFor("tree"), instructions: INSTRUCTIONS, tools: tree.tools, initialState: tree.initialState, maxSteps: 12 }).run();
    console.log(`${countNodes(tree.root)} categories; path walked:\n  ${tree.world.visits.map((n) => formatPath(n.path)).join("\n  -> ")}\nselected: ${JSON.stringify(result.output)}`);
  });

  it("is a taxonomy of about 200 nodes or more", () => {
    expect(countNodes(tree.root)).toBeGreaterThanOrEqual(200);
  });

  it("ends with select on Tools > Power Tools > Drills", () => {
    expect(result.status).toBe("ended");
    expect(result.steps.at(-1)!.tool).toBe("select");
    expect(result.output).toEqual({ path: "Tools > Power Tools > Drills" });
    expect(formatPath(tree.world.at.path)).toBe("Tools > Power Tools > Drills");
  });

  it("gets there without wandering: never more steps than a few over the depth", () => {
    expect(result.steps.length).toBeLessThanOrEqual(6);
  });
});

describe("tree: mechanics, with a scripted model", () => {
  it("backs out of a wrong branch with ascend, then takes the right leaf, and the output is the right node", async () => {
    const tree = createTree();
    const model = new ScriptedModel([
      { [TOOL_QUESTION]: "descend", "descend.child": "Tools" },
      { [TOOL_QUESTION]: "descend", "descend.child": "Hand Tools" },
      { [TOOL_QUESTION]: "ascend" },
      { [TOOL_QUESTION]: "descend", "descend.child": "Power Tools" },
      { [TOOL_QUESTION]: "descend", "descend.child": "Drills" },
      { [TOOL_QUESTION]: "select" },
    ]);
    const result = await createAgent({ model, instructions: INSTRUCTIONS, tools: tree.tools, initialState: tree.initialState }).run();

    expect(result.status).toBe("ended");
    expect(result.steps.map((s) => s.tool)).toEqual(["descend", "descend", "ascend", "descend", "descend", "select"]);
    expect(result.output).toEqual({ path: "Tools > Power Tools > Drills" });
    // the wrong branch was really entered, and really left
    expect(tree.world.visits.map((n) => formatPath(n.path))).toContain("Tools > Hand Tools");
    expect(tree.world.visits.map((n) => n.name)).toEqual(["Products", "Tools", "Hand Tools", "Tools", "Power Tools", "Drills"]);
  });

  it("offers descend alone at the top; ascend and select appear below it", async () => {
    const tree = createTree();
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "descend", "descend.child": "Tools" }, { [TOOL_QUESTION]: "end" }]);
    await createAgent({ model, instructions: INSTRUCTIONS, tools: tree.tools, initialState: tree.initialState }).run();
    expect(toolNames(model.requests[0]!.questions)).toEqual(["descend", "end"]);
    expect(toolNames(model.requests[1]!.questions)).toEqual(["descend", "ascend", "select", "end"]);
  });

  it("builds the child options from where the agent stands, and offers no descend at a leaf", async () => {
    const tree = createTree();
    const model = new ScriptedModel([
      { [TOOL_QUESTION]: "descend", "descend.child": "Tools" },
      { [TOOL_QUESTION]: "descend", "descend.child": "Power Tools" },
      { [TOOL_QUESTION]: "descend", "descend.child": "Drills" },
      { [TOOL_QUESTION]: "end" },
    ]);
    await createAgent({ model, instructions: INSTRUCTIONS, tools: tree.tools, initialState: tree.initialState }).run();
    const power = tree.root.children.find((c) => c.name === "Tools")!.children.find((c) => c.name === "Power Tools")!;
    expect(optionsOf(model.requests[0]!.questions, "descend.child")).toContain("Garden and Outdoor");
    expect(optionsOf(model.requests[1]!.questions, "descend.child")).toEqual(tree.root.children[0]!.children.map((c) => c.name));
    expect(optionsOf(model.requests[2]!.questions, "descend.child")).toEqual(power.children.map((c) => c.name));
    // at the leaf there is nothing to descend into: its question is absent and the tool is not offered
    expect(toolNames(model.requests[3]!.questions)).toEqual(["ascend", "select", "end"]);
    expect(Object.keys(model.requests[3]!.questions)).toEqual([TOOL_QUESTION]);
  });
});
