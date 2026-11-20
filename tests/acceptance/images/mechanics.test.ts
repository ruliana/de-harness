/** Mechanics of images in state and Box parameters, with forced decisions (ScriptedModel). */
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { JevModel, ScriptedModel, createAgent, defineTool, image, param, say, type Json } from "../../../src/index.js";
import { Canvas } from "../../../examples/screen/canvas.js";

const png = (w = 320, h = 320) => new Canvas(w, h, [200, 200, 200]).png();
const other = () => new Canvas(320, 320, [20, 20, 20]).png();

const pointer = (slot: string) =>
  defineTool({
    name: "point",
    description: "Points at one element of the picture.",
    params: { target: param.box({ question: "the thing `instructions` talk about, in `state.nested.view`", image: slot }) },
    run: ({ target }, ctx) => ({ summary: JSON.stringify(target), output: { target, answers: Object.keys(ctx.answers) } }),
  });

describe("images in state", () => {
  it("lists an image once under a reference, even when it sits in two slots, and the state uses that reference", async () => {
    const model = new ScriptedModel([{ "point.target?present": 0.9 }]);
    const view = image(png());
    const agent = createAgent({ model, instructions: "Point at it", tools: [pointer("state.nested.view")], initialState: { nested: { view }, copy: { again: view, different: image(other()) } }, maxSteps: 1 });
    await agent.run();
    const request = model.requests[0]!;
    const state = (request.state as { state: { nested: { view: string }; copy: { again: string; different: string } } }).state;
    expect(state.nested.view).toBe(state.copy.again);
    expect(state.copy.different).not.toBe(state.nested.view);
    expect(Object.keys(request.images!).sort()).toEqual([state.nested.view, state.copy.different].sort());
  });

  it("sends no images when the state holds none", async () => {
    const model = new ScriptedModel([{}]);
    await createAgent({ model, instructions: "Nothing to see", tools: [], initialState: { note: "hello" }, maxSteps: 1 }).run();
    expect(model.requests[0]!.images).toBeUndefined();
  });

  it("refuses a PNG outside 280-1568 px per side with a message that says so", () => {
    expect(() => image(png(100, 100))).toThrow(/100x100.*280-1568/);
    expect(() => image(png(1600, 400))).toThrow(/1600x400/);
    expect(() => image(deflateSync(Buffer.from("not an image")))).toThrow(/PNG or JPEG/);
  });
});

describe("param.box", () => {
  const run = async (answers: Record<string, unknown>) => {
    const model = new ScriptedModel([{ "point.target": say.box({ top: 0.1, bottom: 0.4, left: 0.2, right: 0.6 }), ...answers } as never]);
    const result = await createAgent({ model, instructions: "Point at it", tools: [pointer("state.nested.view")], initialState: { nested: { view: image(png()) } }, maxSteps: 1 }).run();
    return { model, step: result.steps[0]!, result };
  };

  it("sends one Box and one companion Noul per parameter", async () => {
    const { model } = await run({ "point.target?present": 0.9 });
    const q = model.requests[0]!.questions;
    expect(q["point.target"]).toMatchObject({ type: "box" });
    expect(q["point.target?present"]).toMatchObject({ type: "noul" });
    expect(Object.keys(q).sort()).toEqual(["__tool__", "point.target", "point.target?present"]);
  });

  it("gives the tool the box when the companion Noul is above 0.7", async () => {
    const { step } = await run({ "point.target?present": 0.9 });
    expect(step.args).toEqual({ target: { top: 0.1, bottom: 0.4, left: 0.2, right: 0.6 } });
    expect(Object.keys(step.answers).sort()).toEqual(["target", "target?present"]);
  });

  it("gives null when the companion Noul is low or unsure", async () => {
    expect((await run({ "point.target?present": 0.1 })).step.args).toEqual({ target: null });
    expect((await run({ "point.target?present": 0.5 })).step.args).toEqual({ target: null });
  });

  it("leaves the tool out of a step while its image slot holds no image", async () => {
    const model = new ScriptedModel([{}]);
    const result = await createAgent({ model, instructions: "Point at it", tools: [pointer("state.nested.view")], initialState: { nested: { view: "not an image" as Json } }, maxSteps: 1 }).run();
    expect(Object.keys(model.requests[0]!.questions)).toEqual(["__tool__"]);
    expect(result.events.find((e) => e.type === "step_start")).toMatchObject({ skipped: [{ tool: "point" }] });
  });
});

describe("Jev model for Box requests", () => {
  const ok = (model: string) => new Response(JSON.stringify({ model, answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  const seenModels = async (pinned: string) => {
    const sent: string[] = [];
    const jev = new JevModel({ model: pinned, fetch: (async (_u: unknown, init?: RequestInit) => (sent.push(JSON.parse(init!.body as string).model), ok(pinned))) as typeof fetch });
    await jev.ask({ state: { view: "img-1" }, images: { "img-1": { format: "png", base64: "AAAA" } }, questions: { t: { type: "box", instructions: "the thing in `view`" } } });
    await jev.ask({ state: { view: "img-1" }, images: { "img-1": { format: "png", base64: "AAAA" } }, questions: { t: { type: "noul", instructions: "Is `view` bright?" } } });
    return sent;
  };

  it("switches a pinned Jev older than 1.14 to 1.14 for a request with a Box, and leaves other requests alone", async () => {
    expect(await seenModels("jev-1.13.0")).toEqual(["jev-1.14.0", "jev-1.13.0"]);
  });

  it("keeps 1.14 and later pins as they are", async () => {
    expect(await seenModels("jev-1.14.0")).toEqual(["jev-1.14.0", "jev-1.14.0"]);
    expect(await seenModels("jev-preview")).toEqual(["jev-preview", "jev-preview"]);
  });
});
