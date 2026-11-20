/** Thirty tools against Jev (through a cassette): the agent picks the tool the instructions describe, in two-phase mode. */
import { beforeAll, describe, expect, it } from "vitest";
import { TOOL_QUESTION, createAgent, requestTokens, type RunResult } from "../../../src/index.js";
import { createOffice } from "../../../examples/office/office.js";
import { jevFor } from "../../support/models.js";

const INSTRUCTIONS = "Dr. Okafor has just arrived at the front desk for her ten o'clock meeting. Sign her in, then stop.";
// Small enough that all thirty tools with their questions do not fit in one request, large enough for one tool's questions.
const BUDGET = 1500;

describe("front desk: thirty tools, two-phase", () => {
  let result: RunResult;
  let office: ReturnType<typeof createOffice>;

  beforeAll(async () => {
    office = createOffice();
    result = await createAgent({ model: jevFor("scale"), instructions: INSTRUCTIONS, tools: office.tools, initialState: office.initialState, contextBudget: BUDGET, maxSteps: 4 }).run();
  });

  it("goes two-phase because the full fan-out of thirty tools is over budget", () => {
    expect(result.error).toBeUndefined();
    const two = result.events.find((e) => e.type === "two_phase");
    expect(two).toMatchObject({ budget: BUDGET });
    expect((two as { estimatedTokens: number }).estimatedTokens).toBeGreaterThan(BUDGET);
    expect(result.steps[0]!.requests.map((r) => r.phase)).toEqual(["tool", "params"]);
    for (const { request } of result.steps.flatMap((s) => s.requests)) expect(requestTokens(request)).toBeLessThanOrEqual(BUDGET);
  });

  it("picks register_visitor for Dr. Okafor, with the second request holding only that tool's question", () => {
    expect(result.steps[0]).toMatchObject({ tool: "register_visitor", args: { choice: "Dr. Okafor" } });
    expect(Object.keys(result.steps[0]!.requests[1]!.request.questions)).toEqual(["register_visitor.choice"]);
    expect(Object.keys(result.steps[0]!.requests[0]!.request.questions)).toEqual([TOOL_QUESTION]);
    expect(office.done).toEqual([{ tool: "register_visitor", choice: "Dr. Okafor" }]);
  });

  it("ends after signing her in", () => {
    expect(result.status).toBe("ended");
    expect(result.steps.length).toBeLessThanOrEqual(3);
  });
});
