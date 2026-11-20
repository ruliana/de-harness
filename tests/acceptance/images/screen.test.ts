/** Box parameters and images in state, against Jev (through a cassette): a sign-up form seen only as a picture. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { JevModel, cassetteFetch, createAgent, endTool, type RunResult } from "../../../src/index.js";
import { createRooms } from "../../../examples/rooms/rooms.js";
import { SIZE, SUBMIT_BUTTON, formScreen } from "../../../examples/screen/render.js";
import { createScreen } from "../../../examples/screen/screen.js";
import { jevFor } from "../../support/models.js";

type Box = { top: number; bottom: number; left: number; right: number };
const px = (b: Box) => ({ left: b.left * SIZE.width, right: b.right * SIZE.width, top: b.top * SIZE.height, bottom: b.bottom * SIZE.height });
const area = (r: { left: number; right: number; top: number; bottom: number }) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
/** Overlap of the answered box with the true rectangle, over their union. Jev's edges are approximate, so tests compare overlap. */
function iou(b: Box): number {
  const a = px(b);
  const t = SUBMIT_BUTTON;
  const inter = area({ left: Math.max(a.left, t.left), right: Math.min(a.right, t.right), top: Math.max(a.top, t.top), bottom: Math.min(a.bottom, t.bottom) });
  return inter / (area(a) + area(t) - inter);
}

describe("screen: click the Submit button", () => {
  let result: RunResult;
  let screen: ReturnType<typeof createScreen>;

  beforeAll(async () => {
    screen = createScreen();
    result = await createAgent({ model: jevFor("screen"), instructions: "Click the Submit button", tools: screen.tools, initialState: screen.initialState, maxSteps: 3 }).run();
  });

  it("clicks with a box whose centre lies inside the button's true rectangle and that mostly overlaps it", () => {
    const first = result.steps[0]!;
    expect(first.tool).toBe("click");
    const box = (first.args as { target: Box | null }).target!;
    expect(box).not.toBeNull();
    const cx = ((box.left + box.right) / 2) * SIZE.width;
    const cy = ((box.top + box.bottom) / 2) * SIZE.height;
    expect(cx).toBeGreaterThan(SUBMIT_BUTTON.left);
    expect(cx).toBeLessThan(SUBMIT_BUTTON.right);
    expect(cy).toBeGreaterThan(SUBMIT_BUTTON.top);
    expect(cy).toBeLessThan(SUBMIT_BUTTON.bottom);
    expect(iou(box)).toBeGreaterThan(0.5);
  });

  it("presses the button: the page changes and the run ends", () => {
    expect(screen.world.page).toBe("done");
    expect(screen.world.clicks).toHaveLength(1);
    expect(result.status).toBe("ended");
  });

  it("sends the screen as an image under a reference that state uses, and the Box with its companion Noul", () => {
    const { request } = result.steps[0]!;
    const state = request.state as { state: { screen: string } };
    expect(Object.keys(request.images ?? {})).toEqual([state.state.screen]);
    expect(request.images![state.state.screen]).toMatchObject({ format: "png" });
    expect(request.questions["click.target"]!.type).toBe("box");
    expect(request.questions["click.target?present"]!.type).toBe("noul");
  });

  it("matches the committed fixture: the Submit rectangle is the blue button of the picture", () => {
    const canvas = formScreen();
    const at = (x: number, y: number) => [...canvas.pixels.slice((y * canvas.width + x) * 3, (y * canvas.width + x) * 3 + 3)];
    expect(at(SUBMIT_BUTTON.left + 3, SUBMIT_BUTTON.top + 3)).toEqual([37, 99, 235]);
    expect(at(SUBMIT_BUTTON.right + 3, SUBMIT_BUTTON.top + 3)).not.toEqual([37, 99, 235]);
  });
});

/** The first step must be a click: `end` is not offered until a click has been tried, so the model cannot just give up. */
const clickFirst = (screen: ReturnType<typeof createScreen>) => [...screen.tools, { ...endTool(), available: (ctx: { step: number }) => ctx.step > 1 }];

describe("screen: an element that is not there", () => {
  it("gives target = null for a Cancel button, through the companion Noul, and clicks nothing", async () => {
    const screen = createScreen();
    const result = await createAgent({ model: jevFor("screen"), instructions: "Click the Cancel button", tools: clickFirst(screen), initialState: screen.initialState, maxSteps: 1 }).run();
    const first = result.steps[0]!;
    expect(first.tool).toBe("click");
    expect(first.args).toEqual({ target: null });
    const present = first.answers["target?present"]!;
    expect(present.type === "noul" && present.noul).toBeLessThan(0.3);
    expect(screen.world.clicks).toEqual([]);
    expect(screen.world.page).toBe("form");
  });
});

describe("the images header", () => {
  /** A real JevModel on the cassette that remembers the headers and body of each request. */
  const spy = (dir: string) => {
    const seen: { headers: Record<string, string>; body: { assets?: Record<string, unknown> } }[] = [];
    const inner = cassetteFetch({ dir });
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({ headers: init!.headers as Record<string, string>, body: JSON.parse(init!.body as string) });
      return inner(input, init);
    }) as typeof fetch;
    return { model: new JevModel({ fetch: fetchImpl }), seen };
  };

  it("is sent with requests that carry images, and not with requests that do not", async () => {
    const withImage = spy("tests/cassettes/screen");
    const screen = createScreen();
    await createAgent({ model: withImage.model, instructions: "Click the Cancel button", tools: clickFirst(screen), initialState: screen.initialState, maxSteps: 1 }).run();
    expect(withImage.seen).toHaveLength(1);
    expect(withImage.seen[0]!.headers["TypeSafe-Danger-Zone-Images"]).toBe("true");
    expect(Object.keys(withImage.seen[0]!.body.assets ?? {})).toHaveLength(1);

    const without = spy("tests/cassettes/core");
    const rooms = createRooms();
    await createAgent({ model: without.model, instructions: "Leave the room through the red door", tools: rooms.tools, initialState: rooms.initialState, maxSteps: 4 }).run();
    expect(without.seen.length).toBeGreaterThan(0);
    for (const r of without.seen) {
      expect(r.headers["TypeSafe-Danger-Zone-Images"]).toBeUndefined();
      expect(r.body.assets).toBeUndefined();
    }
  });

  it("is recorded in the cassettes of the screen requests", () => {
    const dir = "tests/cassettes/screen";
    const files = Object.values(readFiles(dir));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const entry of files) expect(entry.request.headers["typesafe-danger-zone-images"]).toBe("true");
  });
});

function readFiles(dir: string): Record<string, any> {
  return Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => [f, JSON.parse(readFileSync(join(dir, f), "utf8"))]));
}
