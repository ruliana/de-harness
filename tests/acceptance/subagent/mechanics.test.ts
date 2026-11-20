/** Sub-agent mechanics, forced with ScriptedModel. Still end to end through createAgent(...).run(). */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptedInput, ScriptedModel, TOOL_QUESTION, createAgent, defineTool, delegateTool, type HarnessEvent } from "../../../src/index.js";

const noop = defineTool({ name: "noop", description: "Does nothing.", run: () => ({ summary: "did nothing" }) });
const tasks = { "Do the chores": "The helper does the chores" };
const delegate = (agent: Parameters<typeof delegateTool>[0]["agent"], result?: Parameters<typeof delegateTool>[0]["result"]) => delegateTool({ tasks, agent, ...(result ? { result } : {}) });
const slotOf = (request: { state?: unknown }) => (request.state as { state: Record<string, any> }).state.delegated;

describe("sub-agents", () => {
  it("returns { status: 'step_limit' } into the parent's state when the child runs out of steps, and the parent keeps running", async () => {
    const parent = new ScriptedModel([{ [TOOL_QUESTION]: "delegate" }, { [TOOL_QUESTION]: "end" }]);
    const child = new ScriptedModel([{ [TOOL_QUESTION]: "noop" }]);
    const result = await createAgent({ model: parent, instructions: "Delegate", tools: [delegate(() => ({ model: child, instructions: "Chores", tools: [noop], maxSteps: 2 }))] }).run();
    expect(child.requests).toHaveLength(2);
    expect(slotOf(parent.requests[1]!)).toMatchObject({ task: "Do the chores", status: "step_limit", steps: 2 });
    expect(result.status).toBe("ended");
    expect(result.steps.map((s) => s.tool)).toEqual(["delegate", "end"]);
  });

  it("uses the parent's model when the child brings none", async () => {
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "delegate" }, { [TOOL_QUESTION]: "end" }, { [TOOL_QUESTION]: "end" }]);
    const result = await createAgent({ model, instructions: "Delegate", tools: [delegate(() => ({ instructions: "Chores", tools: [noop] }))] }).run();
    expect(result.status).toBe("ended");
    expect(model.requests).toHaveLength(3); // parent, child, parent
    expect(slotOf(model.requests[2]!)).toMatchObject({ status: "ended", steps: 1 });
  });

  it("keeps the child's tools out of the parent's requests and the parent's out of the child's", async () => {
    const parent = new ScriptedModel([{ [TOOL_QUESTION]: "delegate" }, { [TOOL_QUESTION]: "end" }]);
    const child = new ScriptedModel([{ [TOOL_QUESTION]: "end" }]);
    await createAgent({ model: parent, instructions: "Delegate", tools: [delegate(() => ({ model: child, instructions: "Chores", tools: [noop] }))] }).run();
    const tools = (m: ScriptedModel) => m.requests.map((r) => Object.keys((r.questions[TOOL_QUESTION] as { criteria: object }).criteria));
    expect(tools(parent)).toEqual([["delegate", "end"], ["delegate", "end"]]);
    expect(tools(child)).toEqual([["noop", "end"]]);
  });

  it("nests the child's events under the calling parent step, at any depth", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "nest-")), "run.jsonl");
    const grandchild = new ScriptedModel([{ [TOOL_QUESTION]: "end" }]);
    const child = new ScriptedModel([{ [TOOL_QUESTION]: "noop" }, { [TOOL_QUESTION]: "delegate" }, { [TOOL_QUESTION]: "end" }]);
    const parent = new ScriptedModel([{ [TOOL_QUESTION]: "noop" }, { [TOOL_QUESTION]: "delegate" }, { [TOOL_QUESTION]: "end" }]);
    const inner = delegate(() => ({ model: grandchild, instructions: "Deep chore", tools: [noop] }));
    const outer = delegate(() => ({ model: child, instructions: "Chores", tools: [noop, inner] }));
    const result = await createAgent({ model: parent, instructions: "Delegate", tools: [noop, outer], trace: path }).run();
    expect(result.status).toBe("ended");

    const lines: HarnessEvent[] = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    // only the parent's three requests are at the top level
    expect(lines.filter((l) => l.type === "request")).toHaveLength(3);
    const children = lines.filter((l): l is Extract<HarnessEvent, { type: "child" }> => l.type === "child");
    expect(children.length).toBeGreaterThan(0);
    // all of them belong to parent step 2, the step that called `delegate`
    expect(new Set(children.map((c) => c.step))).toEqual(new Set([2]));
    const kinds = children.map((c) => c.event.type);
    expect(kinds[0]).toBe("run_start");
    expect(kinds.at(-1)).toBe("run_end");
    // the grandchild's events sit one level deeper, under the child's step 2
    const grand = children.flatMap((c) => (c.event.type === "child" ? [c.event] : []));
    expect(grand.length).toBeGreaterThan(0);
    expect(new Set(grand.map((g) => g.step))).toEqual(new Set([2]));
    expect(grand[0]!.event.type).toBe("run_start");
    // the result keeps the same nesting
    expect(result.events.filter((e) => e.type === "child").length).toBe(children.length);
  });

  it("aborts the child when the parent is aborted, and both report aborted", async () => {
    const controller = new AbortController();
    const child = new ScriptedModel([() => {
      controller.abort(); // the user cancels while the child is working
      return { [TOOL_QUESTION]: "noop" };
    }]);
    const parent = new ScriptedModel([{ [TOOL_QUESTION]: "delegate" }]);
    let childStatus: string | undefined;
    const tool = delegate(() => ({ model: child, instructions: "Chores", tools: [noop] }), (_task, r) => ({ status: (childStatus = r.status) }));
    const result = await createAgent({ model: parent, instructions: "Delegate", tools: [tool], signal: controller.signal, maxSteps: 5 }).run();
    expect(result.status).toBe("aborted");
    expect(childStatus).toBe("aborted");
    expect(child.requests).toHaveLength(1); // the child did not start another step
    expect(parent.requests).toHaveLength(1);
    const childEnd = result.events.find((e) => e.type === "child" && e.event.type === "run_end");
    expect(childEnd).toMatchObject({ event: { status: "aborted" } });
  });

  it("stops a child tool that waits on ctx.signal when the parent is aborted", async () => {
    const controller = new AbortController();
    const waiting = defineTool({
      name: "wait_for_user",
      description: "Waits for something that never comes.",
      run: (_a, ctx) =>
        new Promise((resolve) => {
          setTimeout(() => controller.abort(), 20);
          ctx.signal.addEventListener("abort", () => resolve({ summary: "gave up waiting" }));
        }),
    });
    const child = new ScriptedModel([{ [TOOL_QUESTION]: "wait_for_user" }]);
    const parent = new ScriptedModel([{ [TOOL_QUESTION]: "delegate" }]);
    let childRun: { status: string; steps: number } | undefined;
    const tool = delegate(() => ({ model: child, instructions: "Wait", tools: [waiting] }), (_task, r) => ({ status: (childRun = { status: r.status, steps: r.steps.length }).status }));
    const result = await createAgent({ model: parent, instructions: "Delegate", tools: [tool], signal: controller.signal }).run();
    expect(result.status).toBe("aborted");
    expect(childRun?.status).toBe("aborted");
  });

  it("lets any tool call ctx.runAgent directly and use the child's result", async () => {
    const asker = defineTool({
      name: "ask_helper",
      description: "Asks a helper.",
      run: async (_a, ctx) => {
        const r = await ctx.runAgent({ instructions: "Help", tools: [noop], maxSteps: 1 });
        return { state: { helper: r.status }, summary: `helper ${r.status}` };
      },
    });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "ask_helper" }, { [TOOL_QUESTION]: "end" }]);
    const result = await createAgent({ model, instructions: "Ask", tools: [asker] }).run();
    // parent step 1, then the helper uses the same scripted model for its single step, so the script advances
    expect(result.steps[0]!.summary).toBe("helper ended");
  });

  it("lets a child ask the user through the parent's input provider", async () => {
    const ask = defineTool({
      name: "ask_size",
      description: "Asks the user for a size.",
      run: async (_a, ctx) => ({ state: { user_reply: await ctx.input.ask("What size?") }, summary: "asked the size" }),
    });
    const input = new ScriptedInput(["large please"]);
    const child = new ScriptedModel([{ [TOOL_QUESTION]: "ask_size" }, { [TOOL_QUESTION]: "end" }]);
    const parent = new ScriptedModel([{ [TOOL_QUESTION]: "delegate" }, { [TOOL_QUESTION]: "end" }]);
    const result = await createAgent({ model: parent, instructions: "Delegate", input, tools: [delegate(() => ({ model: child, instructions: "Ask", tools: [ask] }))] }).run();
    expect(result.status).toBe("ended");
    expect(input.asked).toEqual(["What size?"]);
    expect(slotOf(parent.requests[1]!)).toMatchObject({ status: "ended", output: { user_reply: "large please" } });
  });
});
