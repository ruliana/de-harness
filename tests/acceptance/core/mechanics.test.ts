/** Loop mechanics, forced with ScriptedModel. Still end to end through createAgent(...).run(). */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DecisionModelError, ScriptedModel, TOOL_QUESTION, createAgent, defineTool, param, say } from "../../../src/index.js";
import { createRooms } from "../../../examples/rooms/rooms.js";

const noop = defineTool({ name: "noop", description: "Does nothing.", run: () => ({ summary: "did nothing" }) });

describe("core loop mechanics", () => {
  it("stops at the step limit after exactly maxSteps requests when the model never picks end", async () => {
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "noop" }]);
    const result = await createAgent({ model, instructions: "Keep going", tools: [noop], maxSteps: 3 }).run();
    expect(result.status).toBe("step_limit");
    expect(model.requests).toHaveLength(3);
    expect(result.steps).toHaveLength(3);
  });

  it("returns the run's output when end is chosen", async () => {
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "end" }]);
    const result = await createAgent({ model, instructions: "Finish", tools: [noop], initialState: { answer: "42" } }).run();
    expect(result.status).toBe("ended");
    expect(result.output).toEqual({ answer: "42" });
    expect(model.requests).toHaveLength(1);
  });

  it("lets any tool end the run with its own output", async () => {
    const finish = defineTool({ name: "finish", description: "Finishes with a result.", run: () => ({ end: true, output: { done: true } }) });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "finish" }]);
    const result = await createAgent({ model, instructions: "Finish", tools: [finish] }).run();
    expect(result).toMatchObject({ status: "ended", output: { done: true } });
  });

  it("leaves a tool whose available() is false out of the tool options and out of the questions", async () => {
    const hidden = defineTool({
      name: "hidden",
      description: "Never available.",
      params: { color: param.choice({ question: "Which colour?", options: ["red", "blue"] }) },
      available: () => false,
      run: () => ({}),
    });
    const shown = defineTool({
      name: "shown",
      description: "Always available.",
      params: { size: param.choice({ question: "Which size?", options: ["s", "l"] }) },
      run: () => ({}),
    });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "end" }]);
    await createAgent({ model, instructions: "x", tools: [hidden, shown] }).run();
    const q = model.requests[0]!.questions;
    expect(Object.keys((q[TOOL_QUESTION] as { criteria: object }).criteria)).toEqual(["shown", "end"]);
    expect(Object.keys(q).sort()).toEqual([TOOL_QUESTION, "shown.size"]);
  });

  it("builds options from the state: after the room changes, the next request lists the new doors", async () => {
    const rooms = createRooms();
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "open_door", "open_door.door": "blue" }, { [TOOL_QUESTION]: "end" }]);
    await createAgent({ model, instructions: "Explore", tools: rooms.tools, initialState: rooms.initialState }).run();
    const doors = (i: number) => Object.keys((model.requests[i]!.questions["open_door.door"] as { criteria: object }).criteria);
    expect(doors(0)).toEqual(["red", "blue", "green"]);
    expect(doors(1)).toEqual(["yellow", "purple"]);
  });

  it("leaves a tool out of the step when a choice parameter has no candidates", async () => {
    const pick = defineTool({
      name: "pick",
      description: "Picks an item.",
      params: { item: param.choice({ question: "Which item?", options: () => [] }) },
      run: () => ({}),
    });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "end" }]);
    const result = await createAgent({ model, instructions: "x", tools: [pick] }).run();
    expect(Object.keys(model.requests[0]!.questions)).toEqual([TOOL_QUESTION]);
    expect(result.events.find((e) => e.type === "step_start")).toMatchObject({ skipped: [{ tool: "pick" }] });
  });

  it("turns a thrown error into an error slot in the next request and keeps going", async () => {
    const boom = defineTool({
      name: "boom",
      description: "Always fails.",
      run: () => {
        throw new Error("the door is stuck");
      },
    });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "boom" }, { [TOOL_QUESTION]: "end" }]);
    const result = await createAgent({ model, instructions: "x", tools: [boom] }).run();
    expect(result.status).toBe("ended");
    expect((model.requests[1]!.state as { state: Record<string, unknown> }).state.error).toBe("the door is stuck");
    expect(result.steps[0]!.error).toBe("the door is stuck");
    // the error slot lives for one step
    expect(result.state.error).toBeUndefined();
  });

  it("stops with status error and the API error attached when the model fails, without running a tool", async () => {
    let ran = 0;
    const counted = defineTool({ name: "counted", description: "Counts.", run: () => {
        ran++;
        return {};
      },
    });
    const model = new ScriptedModel([new DecisionModelError("Jev is overloaded", 529)]);
    const result = await createAgent({ model, instructions: "x", tools: [counted] }).run();
    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({ name: "DecisionModelError", status: 529 });
    expect(ran).toBe(0);
    expect(result.steps).toHaveLength(0);
  });

  it("gives Noul and Score parameters to run as boolean | 'unsure' and the top level label", async () => {
    let got: unknown;
    const inspect = defineTool({
      name: "inspect",
      description: "Inspects the room.",
      params: {
        clean: param.noul({ question: "Is the room clean?" }),
        tidy: param.noul({ question: "Is the room tidy?" }),
        messy: param.noul({ question: "Is the room messy?" }),
        mood: param.score({ question: "How tense is the room?", levels: { calm: "Nobody is bothered", edgy: "People are on edge", tense: "People are about to argue" } }),
      },
      run: (args, ctx) => {
        got = { args, noul: ctx.answers.tidy };
        return { end: true };
      },
    });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "inspect", "inspect.clean": 0.9, "inspect.tidy": 0.5, "inspect.messy": 0.1, "inspect.mood": say.score(2) }]);
    await createAgent({ model, instructions: "x", tools: [inspect] }).run();
    expect(got).toEqual({ args: { clean: true, tidy: "unsure", messy: false, mood: "tense" }, noul: { type: "noul", noul: 0.5 } });
  });

  it("replaces and deletes state slots, and shows only the last N previous actions", async () => {
    const setter = defineTool({
      name: "setter",
      description: "Sets slots.",
      run: (_a, ctx) => ({ state: ctx.step === 1 ? { a: 1, b: 2 } : { a: 3, b: null }, summary: `step ${ctx.step}` }),
    });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "setter" }]);
    const result = await createAgent({ model, instructions: "x", tools: [setter], maxSteps: 4, previousActions: 2 }).run();
    expect(result.state).toEqual({ a: 3 });
    const last = model.requests[3]!.state as { state: object; previous_actions: { summary: string }[] };
    expect(last.state).toEqual({ a: 3 });
    expect(last.previous_actions.map((a) => a.summary)).toEqual(["step 2", "step 3"]);
  });

  it("does not run a step when already aborted", async () => {
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "noop" }]);
    const result = await createAgent({ model, instructions: "x", tools: [noop], signal: AbortSignal.abort() }).run();
    expect(result.status).toBe("aborted");
    expect(model.requests).toHaveLength(0);
  });

  it("writes a JSONL trace with one request payload and one answer set per step", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "trace-")), "run.jsonl");
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "noop" }, { [TOOL_QUESTION]: "end" }]);
    await createAgent({ model, instructions: "x", tools: [noop], trace: path }).run();
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.type === "request")).toHaveLength(2);
    expect(lines.filter((l) => l.type === "answers")).toHaveLength(2);
    expect(lines.map((l) => l.type)).toEqual(["run_start", "step_start", "request", "answers", "tool_call", "tool_result", "step_start", "request", "answers", "tool_call", "tool_result", "run_end"]);
    expect(lines.find((l) => l.type === "request").request.questions[TOOL_QUESTION]).toBeDefined();
  });
});
