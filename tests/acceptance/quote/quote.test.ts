/**
 * The task is quoted inside the tool question (`quoteTask`, on by default): in every greedy step and in the shortlist of a
 * `lookahead` agent, and nowhere else. Mechanics forced with ScriptedModel, end to end through createAgent(...).run().
 */
import { describe, expect, it } from "vitest";
import { ScriptedModel, TOOL_QUESTION, createAgent, defineTool, type DecisionRequest } from "../../../src/index.js";

const TASK = 'Order the "cheaper" mug.';
const text = (r: DecisionRequest) => (r.questions[TOOL_QUESTION] as { instructions: string }).instructions;

const tools = () => [
  defineTool({
    name: "pay",
    description: "Pays for the basket.",
    params: {},
    preview: () => ({ state: { paid: true } }),
    run: () => ({ state: { paid: true }, summary: "paid" }),
  }),
];

describe("quoteTask", () => {
  it("quotes the task in the tool question of every greedy step, and asks nothing else differently", async () => {
    const m = new ScriptedModel([{ [TOOL_QUESTION]: "pay" }, { [TOOL_QUESTION]: "end" }]);
    await createAgent({ model: m, instructions: TASK, tools: tools() }).run();
    expect(m.requests).toHaveLength(2);
    for (const r of m.requests) {
      expect(text(r)).toBe(`The task is: "${TASK}". Which action best advances this task, given \`state\` and \`previous_actions\`?`);
      expect(Object.keys(r.questions)).toEqual([TOOL_QUESTION]);
    }
  });

  it("keeps the old wording when switched off", async () => {
    const m = new ScriptedModel([{ [TOOL_QUESTION]: "end" }]);
    await createAgent({ model: m, instructions: TASK, tools: tools(), quoteTask: false }).run();
    expect(text(m.requests[0]!)).toBe("Which action best advances `instructions`, given `state` and `previous_actions`?");
  });

  it("leaves review.wording's own question as it is", async () => {
    const m = new ScriptedModel([{ [TOOL_QUESTION]: "end" }]);
    await createAgent({ model: m, instructions: TASK, tools: tools(), review: { wording: true } }).run();
    expect(text(m.requests[0]!)).toMatch(/exactly what `instructions` ask/);
  });

  it("quotes the task in the lookahead shortlist, not in the judgments of the states", async () => {
    const m = new ScriptedModel([
      (r) => {
        if (TOOL_QUESTION in r.questions) return { [TOOL_QUESTION]: { type: "choice", choice: "pay", confidence: 0.9, probabilities: { pay: 0.9 } } };
        return Object.fromEntries(Object.keys(r.questions).map((id) => [id, (r.state as { state: { paid?: boolean } }).state.paid ? 0.95 : 0.05]));
      },
    ]);
    const result = await createAgent({ model: m, instructions: TASK, tools: tools(), lookahead: { requirements: ["`state.paid` is true"], depth: 1 }, maxSteps: 4 }).run();
    expect(result.status).toBe("ended");
    const shortlists = m.requests.filter((r) => TOOL_QUESTION in r.questions);
    expect(shortlists.length).toBeGreaterThan(0);
    for (const r of shortlists) expect(text(r)).toContain(`The task is: "${TASK}".`);
    for (const r of m.requests.filter((r) => !(TOOL_QUESTION in r.questions))) expect(JSON.stringify(r.questions)).not.toContain("The task is");
  });
});
