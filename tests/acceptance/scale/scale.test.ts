/** Scale, forced with ScriptedModel: context budget, two-phase requests, previous-actions trimming, the order check. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_BUDGET, ScriptedModel, TOOL_QUESTION, createAgent, defineTool, param, requestTokens, type AnyTool, type DecisionRequest, type HarnessEvent, type ScriptStep } from "../../../src/index.js";

const criteriaOf = (request: DecisionRequest, id: string) => Object.keys((request.questions[id] as { criteria: Record<string, string> }).criteria);
const eventsOf = <T extends HarnessEvent["type"]>(events: HarnessEvent[], type: T) => events.filter((e): e is Extract<HarnessEvent, { type: T }> => e.type === type);
const stateOf = (request: DecisionRequest) => request.state as { instructions: string; state: Record<string, unknown>; previous_actions?: { summary?: string }[] };

/** `count` tools with `params` parameters each, every one a Choice with twelve described options. */
function bulkTools(count: number, params: number): AnyTool[] {
  return Array.from({ length: count }, (_, t) =>
    defineTool({
      name: `tool_${t}`,
      description: `Handles the kind ${t} requests of the warehouse, one shipment at a time.`,
      params: Object.fromEntries(
        Array.from({ length: params }, (_, p) => [
          `p${p}`,
          param.choice({
            question: `Which of the options of kind ${t}, field ${p}, do \`instructions\` ask for?`,
            options: Object.fromEntries(Array.from({ length: 12 }, (_, o) => [`opt_${o}`, `Choose this when the shipment of kind ${t} needs handling number ${o} for field ${p}, as described in the manual.`])),
          }),
        ]),
      ),
      run: (args, ctx) => ({ state: { handled: { tool: `tool_${t}`, args } }, summary: `handled kind ${t} at step ${ctx.step}` }),
    }),
  );
}

describe("many tools: two-phase requests over the context budget", () => {
  const tools = bulkTools(40, 5);
  // step 1 asks for tool_7 with p3 = opt_5; every later step ends
  const model = new ScriptedModel([(req): ScriptStep => (stateOf(req).previous_actions?.length ? { [TOOL_QUESTION]: "end" } : { [TOOL_QUESTION]: "tool_7", "tool_7.p3": "opt_5" })]);
  const trace = join(mkdtempSync(join(tmpdir(), "scale-")), "run.jsonl");
  const run = createAgent({ model, instructions: "Handle the kind 7 shipment", tools, trace }).run();

  it("sends two requests for the step: the tool Choice alone, then only the chosen tool's questions", async () => {
    const result = await run;
    expect(result.status).toBe("ended");
    expect(result.steps[0]!.requests.map((r) => r.phase)).toEqual(["tool", "params"]);
    const [first, second] = result.steps[0]!.requests.map((r) => r.request);
    expect(Object.keys(first!.questions)).toEqual([TOOL_QUESTION]);
    expect(criteriaOf(first!, TOOL_QUESTION)).toHaveLength(41); // 40 tools and end
    expect(Object.keys(second!.questions).sort()).toEqual(["tool_7.p0", "tool_7.p1", "tool_7.p2", "tool_7.p3", "tool_7.p4"]);
    expect(stateOf(second!).instructions).toBe("Handle the kind 7 shipment");
  });

  it("would have been over budget as one request, and no request sent is", async () => {
    const result = await run;
    const first = result.events.find((e) => e.type === "request")!;
    const everything = Object.assign({}, ...tools.flatMap((t) => Object.keys(t.params!).map((p) => ({ [`${t.name}.${p}`]: 1 })))) as object;
    expect(Object.keys(everything)).toHaveLength(200);
    const two = eventsOf(result.events, "two_phase")[0]!;
    expect(two.estimatedTokens).toBeGreaterThan(DEFAULT_CONTEXT_BUDGET);
    for (const e of eventsOf(result.events, "request")) expect(requestTokens(e.request)).toBeLessThanOrEqual(DEFAULT_CONTEXT_BUDGET);
    expect(first).toMatchObject({ type: "request", phase: "tool" });
  });

  it("runs the chosen tool with the parameters answered in the second request", async () => {
    const result = await run;
    expect(result.steps[0]).toMatchObject({ tool: "tool_7", args: { p3: "opt_5" } });
    expect(Object.keys(result.steps[0]!.answers).sort()).toEqual(["p0", "p1", "p2", "p3", "p4"]);
  });

  it("sends one request for a tool that has no parameters, and none for the second phase", async () => {
    const result = await run;
    expect(result.steps[1]!.tool).toBe("end");
    expect(result.steps[1]!.requests.map((r) => r.phase)).toEqual(["tool"]);
    expect(model.requests).toHaveLength(3);
  });

  it("shows a phase marker on every request in the trace", async () => {
    await run;
    const lines = readFileSync(trace, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const requests = lines.filter((l) => l.type === "request");
    expect(requests.map((l) => l.phase)).toEqual(["tool", "params", "tool"]);
    expect(lines.filter((l) => l.type === "answers").map((l) => l.phase)).toEqual(["tool", "params", "tool"]);
  });
});

describe("context budget: previous actions go first, then the run fails naming the largest slot", () => {
  const BUDGET = 1500;
  const read = defineTool({
    name: "read",
    description: "Reads the next section of the page.",
    run: (_a, ctx) => ({ summary: `step ${ctx.step} ${"x".repeat(800)}` }),
  });
  const bloat = defineTool({
    name: "bloat",
    description: "Stores everything it found in a single slot.",
    run: () => ({ state: { dump: "y".repeat(8000) }, summary: "stored everything" }),
  });

  it("drops the oldest previous actions of a request that is over budget, and keeps sending the newest", async () => {
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "read" }]);
    const result = await createAgent({ model, instructions: "Read the page", tools: [read], initialState: { page: "z".repeat(3000) }, contextBudget: BUDGET, maxSteps: 8 }).run();
    expect(result.status).toBe("step_limit");
    const trimmed = eventsOf(result.events, "trimmed");
    expect(trimmed.length).toBeGreaterThan(0);
    for (const r of model.requests) expect(requestTokens(r)).toBeLessThanOrEqual(BUDGET);
    const last = stateOf(model.requests.at(-1)!).previous_actions!;
    expect(last.length).toBeGreaterThan(0);
    expect(last.length).toBeLessThan(5);
    expect(last.at(-1)!.summary).toMatch(/^step 7 /); // the newest action is the one kept
    expect(result.state.page).toBeDefined(); // trimming changes the request, never the state
  });

  it("fails the step with an error naming the largest slot once no previous action is left to drop", async () => {
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "read" }, { [TOOL_QUESTION]: "bloat" }, { [TOOL_QUESTION]: "read" }]);
    const result = await createAgent({ model, instructions: "Read the page", tools: [read, bloat], contextBudget: BUDGET, maxSteps: 6 }).run();
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("state.dump");
    expect(model.requests).toHaveLength(2); // the third step never reached the model
    const step3 = result.events.filter((e) => "step" in e && e.step === 3).map((e) => e.type);
    expect(step3).toEqual(["step_start", "two_phase", "trimmed", "budget_exceeded"]); // previous actions went first
    expect(eventsOf(result.events, "trimmed").at(-1)).toMatchObject({ dropped: 2 });
    expect(eventsOf(result.events, "budget_exceeded")[0]).toMatchObject({ largest: "state.dump", budget: BUDGET });
  });

  it("fails before the first request when the initial state alone is over budget", async () => {
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "end" }]);
    const result = await createAgent({ model, instructions: "x", tools: [read], initialState: { small: "a", huge: "b".repeat(20000) }, contextBudget: BUDGET }).run();
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("state.huge");
    expect(model.requests).toHaveLength(0);
    expect(result.steps).toHaveLength(0);
  });
});

describe("order check: the opt-in reversed __tool__ Choice", () => {
  const named = (name: string) => defineTool({ name, description: `Does ${name}.`, run: () => ({ summary: `did ${name}` }) });
  const tools = [named("alpha"), named("beta"), named("gamma")];
  // a model with a position bias: always picks the first option it is shown
  const firstOption = (req: DecisionRequest) => ({ [TOOL_QUESTION]: criteriaOf(req, TOOL_QUESTION)[0]! });

  it("asks a second request with the options reversed and reports a disagreement, then goes on with the normal order's answer", async () => {
    const model = new ScriptedModel([firstOption]);
    const result = await createAgent({ model, instructions: "x", tools, orderCheck: true, maxSteps: 1 }).run();
    expect(result.steps[0]!.requests.map((r) => r.phase)).toEqual(["single", "order_check"]);
    const [normal, reversed] = result.steps[0]!.requests.map((r) => r.request);
    expect(Object.keys(reversed!.questions)).toEqual([TOOL_QUESTION]);
    expect(criteriaOf(reversed!, TOOL_QUESTION)).toEqual(criteriaOf(normal!, TOOL_QUESTION).reverse());
    expect(eventsOf(result.events, "order_disagreement")).toMatchObject([{ step: 1, forward: "alpha", reversed: "end" }]);
    expect(result.steps[0]!.tool).toBe("alpha");
  });

  it("emits nothing when both orders give the same answer", async () => {
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "beta" }]);
    const result = await createAgent({ model, instructions: "x", tools, orderCheck: true, maxSteps: 2 }).run();
    expect(eventsOf(result.events, "order_disagreement")).toHaveLength(0);
    expect(model.requests).toHaveLength(4);
  });

  it("is off by default: one request per step", async () => {
    const model = new ScriptedModel([firstOption]);
    const result = await createAgent({ model, instructions: "x", tools, maxSteps: 2 }).run();
    expect(model.requests).toHaveLength(2);
    expect(eventsOf(result.events, "order_disagreement")).toHaveLength(0);
  });

  it("runs after a two-phase step too", async () => {
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "tool_1" }]);
    const result = await createAgent({ model, instructions: "x", tools: bulkTools(40, 5), orderCheck: true, maxSteps: 1 }).run();
    expect(result.steps[0]!.requests.map((r) => r.phase)).toEqual(["tool", "params", "order_check"]);
  });
});
