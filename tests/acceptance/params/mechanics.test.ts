/** Set, optional and threshold mechanics, forced with ScriptedModel. Still end to end through createAgent(...).run(). */
import { describe, expect, it } from "vitest";
import { ScriptedModel, TOOL_QUESTION, createAgent, defineTool, memberKey, param, questionId, statedKey } from "../../../src/index.js";

const TOPPINGS = ["mushrooms", "olives", "pepperoni", "onions", "peppers", "basil"] as const;

function pizzaTool(onRun: (args: { toppings: string[]; delivery_time: string | undefined }, answers: Record<string, unknown>) => void) {
  return defineTool({
    name: "order",
    description: "Orders a pizza.",
    params: {
      toppings: param.set({ question: "Do `instructions` ask for {} on the pizza?", members: TOPPINGS }),
      delivery_time: param.choice({
        question: "Which slot do `instructions` ask for?",
        options: { lunch: "from 11am to 2pm", evening: "from 5pm to 9pm" },
        optional: { stated: "Do `instructions` say when to deliver?" },
      }),
    },
    run: ({ toppings, delivery_time }, ctx) => {
      onRun({ toppings, delivery_time }, ctx.answers);
      return { end: true };
    },
  });
}

const member = (m: string) => questionId("order", memberKey("toppings", m));
const stated = questionId("order", statedKey("delivery_time"));

describe("set parameters", () => {
  it("sends exactly one Noul per member (6 members, 6 questions), plus one for each optional stated", async () => {
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "order" }]);
    await createAgent({ model, instructions: "x", tools: [pizzaTool(() => {})], maxSteps: 1 }).run();
    const q = model.requests[0]!.questions;
    const toppingQuestions = Object.entries(q).filter(([id]) => id.startsWith("order.toppings"));
    expect(toppingQuestions).toHaveLength(6);
    expect(toppingQuestions.every(([, question]) => question.type === "noul")).toBe(true);
    expect(Object.entries(q).filter(([id]) => id.endsWith("?stated"))).toHaveLength(1);
    // the tool question, 6 members, the stated Noul and the slot Choice: nothing else
    expect(Object.keys(q)).toHaveLength(1 + 6 + 1 + 1);
    // each member question names its member and stands alone
    expect(q[member("olives")]!.instructions).toBe("Do `instructions` ask for olives on the pizza?");
    expect(q[member("basil")]!.instructions).not.toContain("{}");
  });

  it("gives run the members at or above the yes threshold, in member order, and leaves 'unsure' and no out", async () => {
    let got: { toppings: string[] } | undefined;
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "order", [member("basil")]: 0.95, [member("mushrooms")]: 0.9, [member("olives")]: 0.5, [member("onions")]: 0.1 }]);
    await createAgent({ model, instructions: "x", tools: [pizzaTool((a) => (got = a))], maxSteps: 1 }).run();
    expect(got!.toppings).toEqual(["mushrooms", "basil"]);
  });

  it("honours custom thresholds for members", async () => {
    let got: { toppings: string[] } | undefined;
    const tool = defineTool({
      name: "order",
      description: "Orders a pizza.",
      params: { toppings: param.set({ question: "Do `instructions` ask for {}?", members: TOPPINGS, thresholds: { yes: 0.6, no: 0.4 } }) },
      run: ({ toppings }) => {
        got = { toppings };
        return { end: true };
      },
    });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "order", [member("mushrooms")]: 0.65, [member("olives")]: 0.5 }]);
    await createAgent({ model, instructions: "x", tools: [tool], maxSteps: 1 }).run();
    expect(got!.toppings).toEqual(["mushrooms"]);
  });

  it("takes the members from the state at the moment the question is built", async () => {
    const stock = defineTool({
      name: "stock",
      description: "Restocks.",
      run: () => ({ state: { stock: ["anchovies", "capers"] } }),
    });
    const pick = defineTool({
      name: "pick",
      description: "Picks.",
      params: { items: param.set({ question: "Do `instructions` ask for {} from `state.stock`?", members: (ctx) => ctx.state.stock ?? [] }) },
      run: () => ({}),
    });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "stock" }, { [TOOL_QUESTION]: "end" }]);
    const result = await createAgent({ model, instructions: "x", tools: [stock, pick], initialState: { stock: ["ham"] } }).run();
    expect(result.status).toBe("ended");
    const ids = (i: number) => Object.keys(model.requests[i]!.questions).filter((id) => id.startsWith("pick.items"));
    expect(ids(0)).toEqual(["pick.items[ham]"]);
    expect(ids(1)).toEqual(["pick.items[anchovies]", "pick.items[capers]"]);
  });

  it("leaves a tool out of the step when its set has no members", async () => {
    const pick = defineTool({ name: "pick", description: "Picks.", params: { items: param.set({ question: "Do `instructions` ask for {}?", members: () => [] }) }, run: () => ({}) });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "end" }]);
    const result = await createAgent({ model, instructions: "x", tools: [pick] }).run();
    expect(Object.keys(model.requests[0]!.questions)).toEqual([TOOL_QUESTION]);
    expect(result.events.find((e) => e.type === "step_start")).toMatchObject({ skipped: [{ tool: "pick" }] });
  });

  it("refuses a set question without {} for the member", () => {
    expect(() => param.set({ question: "Do `instructions` ask for toppings?", members: TOPPINGS })).toThrow(/\{\}/);
  });
});

describe("optional parameters", () => {
  it("gives run undefined when the stated Noul is below the yes threshold, however the value question was answered", async () => {
    let got: { delivery_time: string | undefined } | undefined;
    for (const p of [0.1, 0.5]) {
      const model = new ScriptedModel([{ [TOOL_QUESTION]: "order", [stated]: p, "order.delivery_time": "evening" }]);
      await createAgent({ model, instructions: "x", tools: [pizzaTool((a) => (got = a))], maxSteps: 1 }).run();
      expect(got!.delivery_time).toBeUndefined();
    }
  });

  it("gives run the value when stated, and keeps the raw answers of both questions", async () => {
    let got: { delivery_time: string | undefined } | undefined;
    let raw: Record<string, unknown> = {};
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "order", [stated]: 0.9, "order.delivery_time": "evening" }]);
    await createAgent({ model, instructions: "x", tools: [pizzaTool((a, answers) => ((got = a), (raw = answers)))], maxSteps: 1 }).run();
    expect(got!.delivery_time).toBe("evening");
    expect(raw[statedKey("delivery_time")]).toEqual({ type: "noul", noul: 0.9 });
    expect(raw["delivery_time"]).toMatchObject({ type: "choice", choice: "evening" });
  });

  it("honours custom thresholds for the stated Noul", async () => {
    let got: string | undefined;
    const tool = defineTool({
      name: "order",
      description: "Orders.",
      params: { note: param.choice({ question: "Which note?", options: ["gift", "none"], optional: { stated: "Is a note stated?", thresholds: { yes: 0.6, no: 0.4 } } }) },
      run: ({ note }) => {
        got = note;
        return { end: true };
      },
    });
    const run = (p: number) => createAgent({ model: new ScriptedModel([{ [TOOL_QUESTION]: "order", "order.note?stated": p, "order.note": "gift" }]), instructions: "x", tools: [tool], maxSteps: 1 }).run();
    await run(0.65);
    expect(got).toBe("gift");
    await run(0.5);
    expect(got).toBeUndefined();
  });

  it("works on Noul and Score parameters too", async () => {
    let got: { urgent: boolean | "unsure" | undefined; mood: string | undefined } | undefined;
    const tool = defineTool({
      name: "check",
      description: "Checks.",
      params: {
        urgent: param.noul({ question: "Is it urgent?", optional: { stated: "Is urgency stated?" } }),
        mood: param.score({ question: "How tense?", levels: { calm: "Nobody minds", tense: "Argument" }, optional: { stated: "Is the mood stated?" } }),
      },
      run: (args) => {
        got = args;
        return { end: true };
      },
    });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "check", "check.urgent": 0.9, "check.urgent?stated": 0.9, "check.mood?stated": 0.1 }]);
    await createAgent({ model, instructions: "x", tools: [tool], maxSteps: 1 }).run();
    expect(got).toEqual({ urgent: true, mood: undefined });
  });
});

describe("noul thresholds", () => {
  const probe = (thresholds?: { yes?: number; no?: number }) => {
    let got: unknown;
    const tool = defineTool({
      name: "probe",
      description: "Probes.",
      params: { ok: param.noul({ question: "Is it ok?", ...(thresholds ? { thresholds } : {}) }) },
      run: ({ ok }) => {
        got = ok;
        return { end: true };
      },
    });
    return async (p: number) => {
      await createAgent({ model: new ScriptedModel([{ [TOOL_QUESTION]: "probe", "probe.ok": p }]), instructions: "x", tools: [tool], maxSteps: 1 }).run();
      return got;
    };
  };

  it("reads 0.5 as 'unsure' with the default thresholds 0.7 / 0.3", async () => {
    const ask = probe();
    expect(await ask(0.5)).toBe("unsure");
    expect(await ask(0.65)).toBe("unsure");
    expect(await ask(0.7)).toBe(true);
    expect(await ask(0.3)).toBe(false);
  });

  it("honours custom thresholds 0.6 / 0.4", async () => {
    const ask = probe({ yes: 0.6, no: 0.4 });
    expect(await ask(0.65)).toBe(true);
    expect(await ask(0.35)).toBe(false);
    expect(await ask(0.5)).toBe("unsure");
  });

  it("rejects thresholds where no is above yes", () => {
    expect(() => param.noul({ question: "Is it ok?", thresholds: { yes: 0.4, no: 0.6 } })).toThrow(/Thresholds/);
  });
});
