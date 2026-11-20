/**
 * The browser tools against Jev (through a cassette): the page is only a screenshot, Jev answers with boxes and picks from
 * candidates. The site is on loopback with a fixed port, so the address in the state, and with it every recorded request, is stable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession, browserTools, createAgent, type Box, type RunResult } from "../../../src/index.js";
import { startBrowserSite, type BrowserSite } from "../../support/browser-site.js";
import { jevFor } from "../../support/models.js";

const PORT = 47213;
let site: BrowserSite;
let browser: BrowserSession;
beforeAll(async () => {
  site = await startBrowserSite({ port: PORT });
  browser = await BrowserSession.launch({ allowedHosts: ["127.0.0.1"], settleMs: 100 });
});
afterAll(async () => {
  await browser?.close();
  await site?.close();
});

const area = (b: Box) => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
/** Overlap of the answered box with the element's true box, over their union. Jev's edges are approximate, so tests compare overlap. */
function iou(a: Box, t: Box): number {
  const inter = area({ left: Math.max(a.left, t.left), right: Math.min(a.right, t.right), top: Math.max(a.top, t.top), bottom: Math.min(a.bottom, t.bottom) });
  return inter / (area(a) + area(t) - inter);
}

async function run(instructions: string, options: Parameters<typeof browserTools>[1] = {}, maxSteps = 8): Promise<RunResult> {
  await browser.goto(`${site.url}/`);
  return createAgent({ model: jevFor("browser"), instructions, tools: browserTools(browser, options), initialState: await browser.snapshot(), maxSteps }).run();
}

describe("browser: click what is asked for, seen only as a picture", () => {
  let truth: Box;
  let result: RunResult;
  beforeAll(async () => {
    await browser.goto(`${site.url}/`);
    truth = (await browser.boxOf("#green"))!;
    result = await run("Click the Green button, then end");
  });

  it("answers with a box that mostly overlaps the Green button and whose centre is inside it", () => {
    const first = result.steps[0]!;
    expect(first.tool).toBe("click");
    const box = (first.args as { target: Box | null }).target!;
    expect(box).not.toBeNull();
    const cx = (box.left + box.right) / 2;
    const cy = (box.top + box.bottom) / 2;
    expect(cx).toBeGreaterThan(truth.left);
    expect(cx).toBeLessThan(truth.right);
    expect(cy).toBeGreaterThan(truth.top);
    expect(cy).toBeLessThan(truth.bottom);
    expect(iou(box, truth)).toBeGreaterThan(0.5);
  });

  it("presses it for real, and ends", async () => {
    expect(await browser.visibleText()).toContain("Last pick: Green");
    expect(result.status).toBe("ended");
  });
});

describe("browser: a task that needs scrolling, clicking a field, typed text and a button", () => {
  let result: RunResult;
  beforeAll(async () => {
    result = await run("Find the newsletter signup lower on the page, click its email field, type ada@example.com into it, click the Subscribe button, then end.", {
      texts: { "ada@example.com": "the address to subscribe", "grace@example.com": "somebody else's address" },
    }, 12);
  });

  it("gets the right address to the server, from the page, through the browser", () => {
    expect(site.subscriptions).toEqual(["ada@example.com"]);
    expect(result.status).toBe("ended");
  });

  it("went down the page before it could click the field and the button, and typed only what the tool offered", () => {
    const tools = result.steps.map((s) => s.tool);
    expect(tools.indexOf("scroll")).toBeGreaterThanOrEqual(0);
    expect(tools.indexOf("scroll")).toBeLessThan(tools.indexOf("type_text"));
    expect(tools.indexOf("type_text")).toBeLessThan(tools.lastIndexOf("click"));
    for (const s of result.steps.filter((s) => s.tool === "type_text")) expect(s.args).toEqual({ text: "ada@example.com" });
  });
});
