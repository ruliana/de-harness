/** Extended parameters against Jev (through a cassette): a set of toppings and an optional delivery time. */
import { describe, expect, it } from "vitest";
import { createAgent, memberKey, questionId, statedKey } from "../../../src/index.js";
import { createPizza, menu } from "../../../examples/pizza/pizza.js";
import { jevFor } from "../../support/models.js";

async function order(instructions: string) {
  const pizza = createPizza();
  const result = await createAgent({ model: jevFor("params"), instructions, tools: pizza.tools, initialState: pizza.initialState, maxSteps: 4 }).run();
  return { pizza, result };
}

describe("pizza: set and optional parameters", () => {
  it('"A large pizza with mushrooms and olives" orders size large, toppings {mushrooms, olives} and no delivery time', async () => {
    const { pizza, result } = await order("A large pizza with mushrooms and olives");
    expect(result.status).toBe("ended");
    expect(pizza.orders).toHaveLength(1);
    const { size, toppings, delivery_time } = pizza.orders[0]!;
    expect(size).toBe("large");
    expect([...toppings].sort()).toEqual(["mushrooms", "olives"]);
    expect(delivery_time).toBeUndefined();

    // the typed call carries the same, with the delivery time undefined
    const call = result.steps.find((s) => s.tool === "place_order")!;
    expect(call.args.delivery_time).toBeUndefined();
    expect([...(call.args.toppings as string[])].sort()).toEqual(["mushrooms", "olives"]);
  });

  it('"... deliver at 7pm" also orders delivery_time = evening, one of the closed set of slots', async () => {
    const { pizza, result } = await order("A large pizza with mushrooms and olives, deliver at 7pm");
    expect(result.status).toBe("ended");
    expect(pizza.orders).toHaveLength(1);
    const { size, toppings, delivery_time } = pizza.orders[0]!;
    expect(size).toBe("large");
    expect([...toppings].sort()).toEqual(["mushrooms", "olives"]);
    expect(delivery_time).toBe("evening");
    expect(Object.keys(menu.delivery_slots)).toContain(delivery_time);
  });

  it("sends one Noul per topping and one for the stated delivery time, and hands the raw answers to the tool", async () => {
    const { result } = await order("A large pizza with mushrooms and olives");
    const first = result.steps[0]!;
    const questions = first.request.questions;
    for (const topping of menu.toppings) expect(questions[questionId("place_order", memberKey("toppings", topping))]!.type).toBe("noul");
    expect(questions[questionId("place_order", statedKey("delivery_time"))]!.type).toBe("noul");
    expect(first.answers[memberKey("toppings", "olives")]).toMatchObject({ type: "noul" });
    expect(first.answers[statedKey("delivery_time")]).toMatchObject({ type: "noul" });
  });
});
