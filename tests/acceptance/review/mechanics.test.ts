/** `review` mechanics, forced with ScriptedModel. Still end to end through createAgent(...).run(). */
import { describe, expect, it } from "vitest";
import { DecisionModelError, READY_QUESTION, REVIEW_QUESTION, ScriptedModel, TOOL_QUESTION, createAgent, defineTool, wantedId, type DecisionRequest, type ReviewConfig, type ScriptStep } from "../../../src/index.js";

let ran = 0;
const makeTools = (extra: Record<string, unknown> = {}) => {
  ran = 0;
  return [
    defineTool({ name: "look", description: "Looks around.", run: () => ({ summary: "looked" }) }),
    defineTool({ name: "change", description: "Changes something.", effect: "change", ...extra, run: () => (ran++, { summary: "changed it" }) }),
  ];
};

const toolOptions = (r: DecisionRequest) => Object.keys((r.questions[TOOL_QUESTION] as { criteria: object }).criteria);
const isReview = (r: DecisionRequest) => REVIEW_QUESTION in r.questions;

/** A model whose tool choice and review answers come from two small functions. */
const model = (choose: (options: string[], n: number) => string, review: (r: DecisionRequest, n: number) => ScriptStep) => {
  let tools = 0;
  let reviews = 0;
  return new ScriptedModel([(r) => (isReview(r) ? review(r, reviews++) : { [TOOL_QUESTION]: choose(toolOptions(r), tools++) })]);
};

const run = (m: ScriptedModel, review: ReviewConfig | undefined, tools = makeTools(), extra: { maxSteps?: number } = {}) =>
  createAgent({ model: m, instructions: "Do the thing", tools, ...(review ? { review } : {}), ...extra }).run();

describe("review: end", () => {
  it("refuses an end while the review says something doable is left, and the model chooses again among the other tools", async () => {
    const m = model(
      (options, n) => (n === 0 ? "end" : options.includes("end") ? "end" : "look"),
      (_r, n) => ({ [REVIEW_QUESTION]: n === 0 ? 0.9 : 0.1 }),
    );
    const result = await run(m, { end: true });

    expect(result.status).toBe("ended");
    expect(result.steps.map((s) => s.tool)).toEqual(["look", "end"]);
    expect(result.steps[0]!.vetoed).toEqual(["end"]);
    // request 1: the tool question, 2: the review, 3: the tool question again, without `end`
    expect(m.requests.map((r) => (isReview(r) ? "review" : "tools"))).toEqual(["tools", "review", "tools", "tools", "review"]);
    expect(toolOptions(m.requests[0]!)).toContain("end");
    expect(toolOptions(m.requests[2]!)).not.toContain("end");
    expect(result.events.filter((e) => e.type === "review").map((e) => (e.type === "review" ? [e.check, e.refused] : []))).toEqual([["end", true], ["end", false]]);
  });

  it("lets the run end when the review says nothing is left", async () => {
    const m = model(() => "end", () => ({ [REVIEW_QUESTION]: 0.2 }));
    const result = await run(m, { end: true });
    expect(result.status).toBe("ended");
    expect(result.steps).toHaveLength(1);
    expect(m.requests).toHaveLength(2);
  });

  it("applies its threshold in code: 0.7 is below 0.8, so the end stands", async () => {
    const m = model(() => "end", () => ({ [REVIEW_QUESTION]: 0.7 }));
    expect((await run(m, { end: true, threshold: 0.8 })).steps.map((s) => s.tool)).toEqual(["end"]);
    const m2 = model((o) => (o.includes("end") ? "end" : "look"), () => ({ [REVIEW_QUESTION]: 0.7 }));
    expect((await run(m2, { end: true }, makeTools(), { maxSteps: 2 })).steps[0]!.tool).toBe("look");
  });

  it("does not review an end when end is the only tool, and not at all without the option", async () => {
    const only = model(() => "end", () => ({ [REVIEW_QUESTION]: 0.99 }));
    await createAgent({ model: only, instructions: "x", tools: [], review: { end: true } }).run();
    expect(only.requests).toHaveLength(1);

    const off = model(() => "end", () => ({ [REVIEW_QUESTION]: 0.99 }));
    const result = await run(off, undefined);
    expect(result.status).toBe("ended");
    expect(off.requests).toHaveLength(1);
    expect(isReview(off.requests[0]!)).toBe(false);
  });

  it("asks each available tool's own `wanted` question too, and one yes is enough to keep going", async () => {
    const tools = makeTools({ wanted: "Do `instructions` ask for anything to be changed?" });
    const m = model(
      (options) => (options.includes("end") ? "end" : "look"),
      (r, n) => {
        const q = r.questions[wantedId("change")] as { instructions: string } | undefined;
        expect(q?.instructions).toBe("Do `instructions` ask for anything to be changed?");
        // the general question says nothing is left, the tool's own says there is
        return { [REVIEW_QUESTION]: 0.1, [wantedId("change")]: n === 0 ? 0.9 : 0.1 };
      },
    );
    const result = await run(m, { end: true }, tools);
    expect(result.steps.map((s) => s.tool)).toEqual(["look", "end"]);
  });

  it("fails the run, as an error, when the review request fails", async () => {
    let n = 0;
    const m = new ScriptedModel([(r) => (isReview(r) ? new DecisionModelError("review down") : { [TOOL_QUESTION]: n++ === 0 ? "end" : "end" })]);
    const result = await run(m, { end: true });
    expect(result.status).toBe("error");
    expect(result.error?.message).toBe("review down");
  });
});

describe("review: actions", () => {
  it("does not run a `change` call that the review says the instructions do not ask for, and shows the model why for one step", async () => {
    const m = model(
      (options, n) => (n === 0 ? "change" : "look"),
      () => ({ [REVIEW_QUESTION]: 0.1 }),
    );
    const result = await run(m, { actions: true }, makeTools({ summarize: () => "changes the red thing" }), { maxSteps: 2 });

    expect(ran).toBe(0);
    expect(result.steps[0]!.refused).toMatch(/Not done: changes the red thing\./);
    expect(result.steps[0]!.summary).toBe("not done, not asked for: changes the red thing");
    const next = m.requests[2]!.state as { state: { error: string }; previous_actions: { summary: string }[] };
    expect(next.state.error).toMatch(/changes the red thing/);
    expect(next.previous_actions.at(-1)!.summary).toMatch(/^not done/);
  });

  it("runs a `change` call that the review says the instructions ask for", async () => {
    const m = model((o, n) => (n === 0 ? "change" : "end"), () => ({ [REVIEW_QUESTION]: 0.9 }));
    const result = await run(m, { actions: true });
    expect(ran).toBe(1);
    expect(result.steps[0]!.refused).toBeUndefined();
  });

  it("never reviews a tool that is not marked `change`", async () => {
    const m = model((o, n) => (n === 0 ? "look" : "end"), () => ({ [REVIEW_QUESTION]: 0.0 }));
    const result = await run(m, { actions: true });
    expect(result.status).toBe("ended");
    expect(m.requests.some(isReview)).toBe(false);
  });

  it("ends the run after two refused calls in a row, and a call that runs in between starts the count again", async () => {
    // refused, run, refused, refused: the run ends at the fourth step, with the tool run once
    const answers = [0.1, 0.9, 0.1, 0.1];
    const m = model(() => "change", (_r, n) => ({ [REVIEW_QUESTION]: answers[n] ?? 0.1 }));
    const result = await run(m, { actions: true });

    expect(result.status).toBe("ended");
    expect(result.steps).toHaveLength(4);
    expect(ran).toBe(1);
    expect(result.events.filter((e) => e.type === "review_stop")).toHaveLength(1);
  });

  it("asks the readiness question too for a `final` tool, and puts the other parts first when it says no", async () => {
    const m = model(
      (o, n) => (n === 0 ? "change" : "end"),
      (r) => {
        expect(Object.keys(r.questions)).toEqual([REVIEW_QUESTION, READY_QUESTION]);
        return { [REVIEW_QUESTION]: 0.95, [READY_QUESTION]: 0.1 };
      },
    );
    const result = await run(m, { actions: true }, makeTools({ final: true }), { maxSteps: 1 });
    expect(ran).toBe(0);
    expect(result.steps[0]!.refused).toMatch(/Not done yet:.*do the other parts first/);

    const plain = model((o, n) => (n === 0 ? "change" : "end"), (r) => (expect(Object.keys(r.questions)).toEqual([REVIEW_QUESTION]), { [REVIEW_QUESTION]: 0.9 }));
    await run(plain, { actions: true });
    expect(ran).toBe(1);
  });

  it("asks the tool's own `confirm` question in place of the generic one", async () => {
    const m = model(
      (o, n) => (n === 0 ? "change" : "end"),
      (r) => {
        expect((r.questions[REVIEW_QUESTION] as { instructions: string }).instructions).toBe("Do `instructions` ask for the red thing?");
        return { [REVIEW_QUESTION]: 0.9 };
      },
    );
    await run(m, { actions: true }, makeTools({ confirm: () => "Do `instructions` ask for the red thing?" }));
    expect(ran).toBe(1);
  });
});

describe("review: wording", () => {
  it("rewords the tool question and the built-in end only when asked to", async () => {
    const plain = new ScriptedModel([{ [TOOL_QUESTION]: "end" }]);
    await createAgent({ model: plain, instructions: "x", tools: makeTools() }).run();
    const strict = new ScriptedModel([{ [TOOL_QUESTION]: "end" }]);
    await createAgent({ model: strict, instructions: "x", tools: makeTools(), review: { wording: true } }).run();

    const text = (m: ScriptedModel) => (m.requests[0]!.questions[TOOL_QUESTION] as { instructions: string; criteria: Record<string, string> });
    expect(text(plain).instructions).toBe("Which action best advances `instructions`, given `state` and `previous_actions`?");
    expect(text(strict).instructions).toMatch(/exactly what `instructions` ask, no more and no less/);
    expect(text(strict).criteria.end).not.toBe(text(plain).criteria.end);
    expect(text(strict).criteria.end).toMatch(/everything that `instructions` ask for has been done/);
  });
});
