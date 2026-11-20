/** Tools that hold the loop: a coffee order where the customer's reply comes from a (scripted) user. Jev through a cassette. */
import { beforeAll, describe, expect, it } from "vitest";
import { ScriptedInput, createAgent, type RunResult } from "../../../src/index.js";
import { QUESTIONS, createCoffee } from "../../../examples/coffee/coffee.js";
import { jevFor } from "../../support/models.js";

const INSTRUCTIONS = "Take the customer's coffee order: ask which size they want, then place the order";

describe("coffee order", () => {
  let result: RunResult;
  let orders: { size: string }[];
  let input: ScriptedInput;

  beforeAll(async () => {
    const coffee = createCoffee();
    orders = coffee.orders;
    input = new ScriptedInput(["large please"]);
    result = await createAgent({ model: jevFor("input"), instructions: INSTRUCTIONS, tools: coffee.tools, input, maxSteps: 6 }).run();
  });

  it("asks the size, keeps the reply in state.user_reply, places the order with size large and ends", () => {
    expect(result.status).toBe("ended");
    expect(input.asked).toEqual([QUESTIONS.size]);
    expect(result.state.user_reply).toBe("large please");
    const calls = result.events.filter((e) => e.type === "tool_call").map((e) => (e.type === "tool_call" ? e.tool : ""));
    expect(calls).toEqual(["ask_customer", "place_order", "end"]);
    expect(result.events.find((e) => e.type === "tool_call" && e.tool === "place_order")).toMatchObject({ args: { size: "large" } });
    expect(orders).toEqual([{ size: "large" }]);
  });

  it("shows the reply to the model only after it arrived, and does not offer place_order before it", () => {
    const [first, second] = result.steps.map((s) => s.request);
    expect((first!.state as { state: object }).state).not.toHaveProperty("user_reply");
    expect(first!.questions).not.toHaveProperty("place_order.size");
    expect((second!.state as { state: { user_reply: string } }).state.user_reply).toBe("large please");
    expect(second!.questions).toHaveProperty("place_order.size");
  });
});
