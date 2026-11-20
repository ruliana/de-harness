/** Input mechanics, forced with ScriptedModel and ScriptedInput. Still end to end through createAgent(...).run(). */
import { describe, expect, it } from "vitest";
import { InputTimeoutError, ScriptedInput, ScriptedModel, TOOL_QUESTION, createAgent, defineTool, type HarnessEvent } from "../../../src/index.js";

const ask = defineTool({
  name: "ask_user",
  description: "Asks the user something.",
  run: async (_args, ctx) => ({ state: { user_reply: await ctx.input.ask("What size?") }, summary: "asked" }),
});

const at = (events: HarnessEvent[], type: HarnessEvent["type"], nth = 0) => {
  const e = events.filter((x) => x.type === type)[nth];
  if (!e) throw new Error(`no ${type} event`);
  return Date.parse(e.ts);
};

describe("user input holds the loop", () => {
  it("sends no request for the next step before a slow reply arrives (trace timestamps)", async () => {
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "ask_user" }, { [TOOL_QUESTION]: "end" }]);
    const input = new ScriptedInput([{ reply: "large please", delayMs: 500 }]);
    const result = await createAgent({ model, instructions: "Take the order", tools: [ask], input }).run();
    expect(result.status).toBe("ended");
    const asked = at(result.events, "input_requested");
    const received = at(result.events, "input_received");
    expect(received - asked).toBeGreaterThanOrEqual(490);
    expect(at(result.events, "request", 1)).toBeGreaterThanOrEqual(received);
    expect(model.requests).toHaveLength(2);
    expect((model.requests[1]!.state as { state: { user_reply: string } }).state.user_reply).toBe("large please");
  });

  it("answers several questions in order", async () => {
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "ask_user" }, { [TOOL_QUESTION]: "ask_user" }, { [TOOL_QUESTION]: "end" }]);
    const input = new ScriptedInput(["large", (prompt) => `to: ${prompt}`]);
    const result = await createAgent({ model, instructions: "x", tools: [ask], input }).run();
    expect(result.state.user_reply).toBe("to: What size?");
    expect(input.asked).toEqual(["What size?", "What size?"]);
  });

  it("puts an error slot in state when the wait times out, and the loop continues", async () => {
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "ask_user" }, { [TOOL_QUESTION]: "end" }]);
    const input = new ScriptedInput([{ never: true }]);
    const result = await createAgent({ model, instructions: "x", tools: [ask], input, inputTimeoutMs: 50 }).run();
    expect(result.status).toBe("ended");
    expect(result.steps[0]!.error).toMatch(/No reply from the user/);
    expect((model.requests[1]!.state as { state: { error: string } }).state.error).toMatch(/No reply from the user/);
    expect(result.events.find((e) => e.type === "input_failed")).toMatchObject({ reason: "timeout" });
  });

  it("lets a tool set its own timeout and handle it", async () => {
    const patient = defineTool({
      name: "ask_politely",
      description: "Asks, and falls back when nobody answers.",
      run: async (_a, ctx) => {
        try {
          return { state: { user_reply: await ctx.input.ask("Anything else?", { timeoutMs: 30 }) } };
        } catch (e) {
          if (e instanceof InputTimeoutError) return { state: { user_reply: "nothing" }, summary: "nobody answered" };
          throw e;
        }
      },
    });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "ask_politely" }, { [TOOL_QUESTION]: "end" }]);
    const result = await createAgent({ model, instructions: "x", tools: [patient], input: new ScriptedInput([{ never: true }]) }).run();
    expect(result.status).toBe("ended");
    expect(result.state).toMatchObject({ user_reply: "nothing" });
    expect(result.state.error).toBeUndefined();
  });

  it("ends the run with status aborted when aborted while waiting, and sends no further request", async () => {
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "ask_user" }]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const result = await createAgent({ model, instructions: "x", tools: [ask], input: new ScriptedInput([{ never: true }]), signal: controller.signal }).run();
    expect(result.status).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(model.requests).toHaveLength(1);
    expect(result.events.find((e) => e.type === "input_failed")).toMatchObject({ reason: "aborted" });
  });

  it("turns asking without an input provider into an error slot", async () => {
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "ask_user" }, { [TOOL_QUESTION]: "end" }]);
    const result = await createAgent({ model, instructions: "x", tools: [ask] }).run();
    expect(result.status).toBe("ended");
    expect(result.steps[0]!.error).toMatch(/No user input is available/);
  });
});
