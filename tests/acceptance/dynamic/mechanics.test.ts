/** Dynamic tool mechanics and guards, forced with ScriptedModel. Still end to end through createAgent(...).run(). */
import { describe, expect, it } from "vitest";
import { ScriptedModel, TOOL_QUESTION, createAgent, defineTool, param, type DecisionRequest } from "../../../src/index.js";

const noop = defineTool({ name: "noop", description: "Does nothing.", run: () => ({ summary: "did nothing" }) });

const offered = (request: DecisionRequest) => Object.keys((request.questions[TOOL_QUESTION] as { criteria: object }).criteria);
const questionIds = (request: DecisionRequest) => Object.keys(request.questions).filter((id) => id !== TOOL_QUESTION);
const errorSlot = (request: DecisionRequest) => (request.state as { state: { error?: string } }).state.error;

const colored = (name: string) =>
  defineTool({ name, description: `The ${name} tool.`, params: { color: param.choice({ question: "Which colour?", options: ["red", "blue"] }) }, run: () => ({ summary: `${name} ran` }) });

describe("dynamic tools", () => {
  it("adds a tool that takes part from the next request only", async () => {
    const extra = colored("extra");
    const adder = defineTool({ name: "adder", description: "Adds the extra tool.", run: (_a, ctx) => (ctx.tools.add(extra), { summary: "added extra" }) });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "adder" }, { [TOOL_QUESTION]: "extra" }, { [TOOL_QUESTION]: "end" }]);
    const result = await createAgent({ model, instructions: "x", tools: [adder] }).run();
    expect(result.status).toBe("ended");
    expect(offered(model.requests[0]!)).toEqual(["adder", "end"]);
    expect(offered(model.requests[1]!)).toEqual(["adder", "end", "extra"]);
    expect(questionIds(model.requests[0]!)).toEqual([]);
    expect(questionIds(model.requests[1]!)).toEqual(["extra.color"]);
  });

  it("lets a one-shot tool remove itself: the next request has neither its option nor its questions", async () => {
    const once = defineTool({
      name: "once",
      description: "Does something one time.",
      params: { color: param.choice({ question: "Which colour?", options: ["red", "blue"] }) },
      run: (_a, ctx) => (ctx.tools.remove("once"), { summary: "did it once" }),
    });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "once" }, { [TOOL_QUESTION]: "end" }]);
    const result = await createAgent({ model, instructions: "x", tools: [once, noop] }).run();
    expect(result.status).toBe("ended");
    expect(offered(model.requests[0]!)).toEqual(["once", "noop", "end"]);
    expect(questionIds(model.requests[0]!)).toEqual(["once.color"]);
    expect(offered(model.requests[1]!)).toEqual(["noop", "end"]);
    expect(questionIds(model.requests[1]!)).toEqual([]);
  });

  it("refuses a duplicate name: an error slot appears in the next request and the registry is unchanged", async () => {
    const dupe = defineTool({ name: "noop", description: "An impostor.", run: () => ({}) });
    const adder = defineTool({ name: "adder", description: "Tries to add a second noop.", run: (_a, ctx) => (ctx.tools.add(dupe), {}) });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "adder" }, { [TOOL_QUESTION]: "end" }]);
    const agent = createAgent({ model, instructions: "x", tools: [adder, noop] });
    const before = agent.tools.list();
    const result = await agent.run();
    expect(result.status).toBe("ended");
    expect(errorSlot(model.requests[1]!)).toMatch(/already registered: noop/i);
    expect(agent.tools.list().map((t) => t.name)).toEqual(before.map((t) => t.name));
    expect(agent.tools.get("noop")).toBe(noop);
    expect(offered(model.requests[1]!)).toEqual(["adder", "noop", "end"]);
    expect(result.events.some((e) => e.type === "tools_changed")).toBe(false);
  });

  it("refuses to remove end the same way", async () => {
    const saboteur = defineTool({ name: "saboteur", description: "Tries to remove end.", run: (_a, ctx) => (ctx.tools.remove("end"), {}) });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "saboteur" }, { [TOOL_QUESTION]: "end" }]);
    const agent = createAgent({ model, instructions: "x", tools: [saboteur] });
    const result = await agent.run();
    expect(result.status).toBe("ended");
    expect(errorSlot(model.requests[1]!)).toMatch(/end.*can't be removed/i);
    expect(offered(model.requests[1]!)).toContain("end");
    expect(agent.tools.has("end")).toBe(true);
  });

  it("never shows a tool that is added and removed in the same step", async () => {
    const flash = colored("flash");
    const blink = defineTool({ name: "blink", description: "Adds and removes a tool at once.", run: (_a, ctx) => (ctx.tools.add(flash), ctx.tools.remove("flash"), { summary: "blinked" }) });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "blink" }, { [TOOL_QUESTION]: "blink" }, { [TOOL_QUESTION]: "end" }]);
    const result = await createAgent({ model, instructions: "x", tools: [blink] }).run();
    expect(result.status).toBe("ended");
    for (const request of model.requests) {
      expect(offered(request)).not.toContain("flash");
      expect(questionIds(request).some((id) => id.startsWith("flash."))).toBe(false);
    }
    expect(result.events.filter((e) => e.type === "tools_changed").map((e) => `${e.step}:${e.change}:${e.tool}`)).toEqual(["1:added:flash", "1:removed:flash", "2:added:flash", "2:removed:flash"]);
  });

  it("lets code outside the loop add and remove tools between runs and before a run", async () => {
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "end" }]);
    const agent = createAgent({ model, instructions: "x", tools: [noop] });
    agent.tools.add(colored("late"));
    agent.tools.remove("noop");
    const result = await agent.run();
    expect(offered(model.requests[0]!)).toEqual(["end", "late"]);
    expect(result.events.filter((e) => e.type === "tools_changed")).toEqual([]);
    expect(agent.tools.remove("nothing_here")).toBe(false);
  });
});
