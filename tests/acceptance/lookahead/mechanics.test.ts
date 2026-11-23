/**
 * `lookahead` mechanics, forced with ScriptedModel. Still end to end through createAgent(...).run(). The scripted model
 * plays Jev: it shortlists with probabilities, and judges each requirement by reading the state in the request.
 */
import { describe, expect, it } from "vitest";
import { DecisionModelError, ScriptedModel, TOOL_QUESTION, createAgent, defineTool, type Answer, type DecisionRequest, type LookaheadConfig, type RunResult, type ScriptStep } from "../../../src/index.js";

type Facts = Record<string, boolean>;
const facts = (r: DecisionRequest): Facts => ((r.state as { state: { facts: Facts } }).state.facts ?? {}) as Facts;
const isEvaluate = (r: DecisionRequest) => Object.keys(r.questions).some((q) => q.startsWith("req.") || q.startsWith("con."));
const isShortlist = (r: DecisionRequest) => TOOL_QUESTION in r.questions;
const options = (r: DecisionRequest) => Object.keys((r.questions[TOOL_QUESTION] as { criteria: object }).criteria);

/** A choice answer with the given probabilities (options not named get 0). */
const choice = (p: Record<string, number>): Answer => {
  const best = Object.entries(p).sort((a, b) => b[1] - a[1])[0]![0];
  return { type: "choice", choice: best, confidence: p[best]!, probabilities: p };
};

/**
 * `prefer` lists tools by probability for the shortlist (only the available ones are used); `holds` says, for each criterion
 * text, whether the state in the request satisfies it.
 */
function jev(prefer: string[], holds: Record<string, (f: Facts) => boolean>): ScriptedModel {
  return new ScriptedModel([
    (r): ScriptStep => {
      if (isShortlist(r)) {
        const avail = options(r);
        const ranked = prefer.filter((t) => avail.includes(t));
        const p = Object.fromEntries(avail.map((t) => [t, ranked.includes(t) ? 0.9 - 0.2 * ranked.indexOf(t) : 0]));
        return { [TOOL_QUESTION]: choice(p) };
      }
      return Object.fromEntries(
        Object.entries(r.questions).map(([id, q]) => {
          const text = Object.keys(holds).find((t) => (q as { instructions: string }).instructions.includes(t))!;
          return [id, holds[text]!(facts(r)) ? 0.95 : 0.05];
        }),
      );
    },
  ]);
}

/** Tools over `state.facts`: each sets some facts, `needs` makes it available only once other facts hold. */
const tool = (name: string, sets: string[], opts: { needs?: string[]; run?: string[]; preview?: boolean; effect?: "change" } = {}) =>
  defineTool({
    name,
    description: `Does ${name}.`,
    ...(opts.needs ? { available: (ctx) => opts.needs!.every((n) => ctx.state.facts[n]) } : {}),
    ...(opts.preview === false ? {} : { preview: (_args: {}, ctx: { state: Readonly<Record<string, any>> }) => ({ state: { facts: { ...ctx.state.facts, ...Object.fromEntries(sets.map((s) => [s, true])) } }, summary: `did ${name}` }) }),
    run: (_args: {}, ctx: { state: Readonly<Record<string, any>> }) => ({ state: { facts: { ...ctx.state.facts, ...Object.fromEntries((opts.run ?? sets).map((s) => [s, true])) } }, summary: `did ${name}` }),
  });

const start = { facts: { a: false, b: false, c: false, d: false } };
const has = (k: string) => (f: Facts) => !!f[k];
const REQ = { a: "`state.facts.a` is true", c: "`state.facts.c` is true", d: "`state.facts.d` is true" };
const holds = { [REQ.a]: has("a"), [REQ.c]: has("c"), [REQ.d]: has("d") };

const run = (m: ScriptedModel, tools: ReturnType<typeof tool>[], lookahead: LookaheadConfig, extra: { maxSteps?: number } = {}): Promise<RunResult> =>
  createAgent({ model: m, instructions: "Get a, c and d.", tools: tools as never, initialState: start, lookahead, ...extra }).run();

const requests = (r: RunResult) => r.events.flatMap((e) => (e.type === "request" ? [e] : []));
const phases = (r: RunResult) => requests(r).map((e) => e.phase);

describe("lookahead: choosing the first action of the best sequence", () => {
  // a satisfies one requirement at once; b satisfies none but unlocks c, and c satisfies two: b then c is the better sequence
  const world = () => [tool("a", ["a"]), tool("b", ["b"]), tool("c", ["c", "d"], { needs: ["b"] })];
  const reqs = [REQ.a, REQ.c, REQ.d];

  it("takes the prerequisite first when two steps ahead it pays more, and replans from what it observes", async () => {
    const result = await run(jev(["a", "b", "c"], holds), world(), { requirements: reqs });
    expect(result.status).toBe("ended");
    expect(result.steps.map((s) => s.tool)).toEqual(["b", "c", "a"]);
    expect(result.steps[0]!.planned?.sequence.map((c) => c.split("(")[0])).toEqual(["b", "c"]);
    expect(result.output).toMatchObject({ complete: true, unmet: [] });
  });

  it("takes the immediate gain when it can only look one action ahead", async () => {
    const result = await run(jev(["a", "b", "c"], holds), world(), { requirements: reqs, depth: 1 });
    expect(result.steps[0]!.tool).toBe("a");
  });

  it("runs only the first action of the plan for real: one tool call per step", async () => {
    const result = await run(jev(["a", "b", "c"], holds), world(), { requirements: reqs });
    expect(result.events.filter((e) => e.type === "tool_call")).toHaveLength(result.steps.length);
  });

  it("uses a model request for the shortlist and one per distinct state to judge, and no state is judged twice", async () => {
    const m = jev(["a", "b", "c"], holds);
    const result = await run(m, world(), { requirements: reqs });
    const judged = m.requests.filter(isEvaluate).map((r) => JSON.stringify(r.state));
    expect(new Set(judged).size).toBe(judged.length);
    expect(phases(result).every((p) => p === "shortlist" || p === "evaluate")).toBe(true);
    expect(phases(result)).toContain("shortlist");
  });
});

describe("lookahead: stopping explicitly", () => {
  it("ends without calling a tool when every requirement already holds", async () => {
    let ran = 0;
    const t = defineTool({ name: "a", description: "Does a.", preview: () => ({ state: { facts: { a: true } } }), run: () => (ran++, {}) });
    const m = jev(["a"], holds);
    const result = await createAgent({ model: m, instructions: "Get a.", tools: [t], initialState: { facts: { a: true } }, lookahead: { requirements: [REQ.a] } }).run();
    expect(result.status).toBe("ended");
    expect(ran).toBe(0);
    expect(result.output).toMatchObject({ complete: true });
    expect(m.requests).toHaveLength(1);
  });

  it("ends with the unmet requirements and the blocker when no explored sequence improves, and runs nothing", async () => {
    const result = await run(jev(["a"], holds), [tool("a", [])], { requirements: [REQ.a] });
    expect(result.status).toBe("ended");
    expect(result.steps).toHaveLength(0);
    expect(result.output).toMatchObject({ complete: false, unmet: [REQ.a] });
    expect((result.output as { blocker: string }).blocker).toMatch(/no/i);
  });

  it("does not run an action that breaks a requirement that was met, even when it satisfies another", async () => {
    // `x` satisfies c but un-sets a: net no gain, so with a already true the planner leaves it alone
    const x = defineTool({
      name: "x",
      description: "Does x.",
      preview: (_a: {}, ctx: { state: Readonly<Record<string, any>> }) => ({ state: { facts: { ...ctx.state.facts, a: false, c: true } } }),
      run: () => ({ state: { facts: { a: false, c: true, b: false, d: false } } }),
    });
    const result = await createAgent({ model: jev(["x"], holds), instructions: "Get a and c.", tools: [x], initialState: { facts: { a: true, b: false, c: false, d: false } }, lookahead: { requirements: [REQ.a, REQ.c] } }).run();
    expect(result.steps).toHaveLength(0);
    expect((result.output as { unmet: string[] }).unmet).toEqual([REQ.c]);
  });

  it("drops a sequence that breaks a constraint, however much it would gain", async () => {
    const m = jev(["bad", "a"], { ...holds, "`state.facts.d` is false": (f) => !f.d });
    const bad = tool("bad", ["a", "c", "d"]);
    const result = await run(m, [bad, tool("a", ["a"])], { requirements: [REQ.a, REQ.c], constraints: ["`state.facts.d` is false"] }, { maxSteps: 3 });
    expect(result.steps.map((s) => s.tool)).not.toContain("bad");
    expect(result.steps[0]!.tool).toBe("a");
    expect(result.events.some((e) => e.type === "lookahead" && e.search.nodes.some((n) => n.broken.length > 0))).toBe(true);
  });
});

describe("lookahead: reality against the preview", () => {
  it("does not repeat an action whose real result left the state as it was: it plans again from what it sees and ends instead of looping", async () => {
    // `a` claims to set a and does nothing; b is the honest way to progress, and a requirement is left that nothing can meet
    const liar = tool("a", ["a"], { run: [] });
    const m = jev(["a", "b"], holds);
    const result = await run(m, [liar, tool("b", ["c"])], { requirements: [REQ.a, REQ.c] }, { maxSteps: 10 });
    expect(result.steps.map((s) => s.tool).slice(0, 2)).toEqual(["a", "b"]);
    // once per distinct state: before b and after b, never twice in the same state
    expect(result.steps.filter((s) => s.tool === "a")).toHaveLength(2);
    expect(result.status).toBe("ended");
    expect(result.output).toMatchObject({ complete: false, unmet: [REQ.a] });
  });

  it("tries a tool it cannot preview only when nothing previewed helps, once, and counts progress after it observes", async () => {
    const blind = tool("blind", [], { preview: false, run: ["a"] });
    const m = jev(["blind"], holds);
    const result = await run(m, [blind], { requirements: [REQ.a] });
    expect(result.steps.map((s) => [s.tool, s.planned?.why])).toEqual([["blind", "explore"]]);
    expect(result.output).toMatchObject({ complete: true });
  });
});

describe("lookahead: criteria decided in code", () => {
  it("never asks the model about a criterion that has a check", async () => {
    const m = jev(["a"], {});
    const result = await run(m, [tool("a", ["a"])], { requirements: [{ text: REQ.a, check: (s) => !!s.facts.a }] });
    expect(result.output).toMatchObject({ complete: true });
    expect(m.requests.some(isEvaluate)).toBe(false);
  });
});

describe("lookahead: opt-in", () => {
  it("changes nothing for an agent without it: one request per step, no lookahead phases", async () => {
    const m = new ScriptedModel([{ [TOOL_QUESTION]: "end" }]);
    const result = await createAgent({ model: m, instructions: "x", tools: [tool("a", ["a"])] as never }).run();
    expect(result.status).toBe("ended");
    expect(m.requests).toHaveLength(1);
    expect(phases(result)).toEqual(["single"]);
  });

  it("is an error, never an answer, when the model fails", async () => {
    const m = new ScriptedModel([new DecisionModelError("boom", 500)]);
    const result = await run(m, [tool("a", ["a"])], { requirements: [REQ.a] });
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("boom");
  });
});
