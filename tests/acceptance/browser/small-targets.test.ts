/**
 * Browser tools on the pages where a plain Box click fails, forced with ScriptedModel against a site on loopback:
 * a tiny pop-up close button (smaller than the finest box Jev draws), a hover colour that is not a page change, menus that open when pressed,
 * a click point that falls in a gap, and options below the fold. End to end: createAgent(...).run() with a real headless Chromium.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedModel, TOOL_QUESTION, createAgent, say, type Box } from "../../../src/index.js";
import { BrowserSession, browserTools, type BrowserToolsOptions } from "../../../src/browser/index.js";
import { pngSize } from "../../../src/state/images.js";
import { startBrowserSite, type BrowserSite } from "../../support/browser-site.js";

let site: BrowserSite;
let browser: BrowserSession;
beforeAll(async () => {
  site = await startBrowserSite();
  browser = await BrowserSession.launch({ allowedHosts: ["127.0.0.1"], settleMs: 100 });
});
afterAll(async () => {
  await browser?.close();
  await site?.close();
});

type Script = ConstructorParameters<typeof ScriptedModel>[0];
type Entry = Script[number];
const VIEW = { width: 1280, height: 800 };
/** A Box from viewport pixels. */
const px = (left: number, top: number, right: number, bottom: number): Box => ({ left: left / VIEW.width, right: right / VIEW.width, top: top / VIEW.height, bottom: bottom / VIEW.height });
const toolsOf = (model: ScriptedModel, request: number) => Object.keys((model.requests[request]!.questions[TOOL_QUESTION] as { criteria: Record<string, string> }).criteria).sort();
const stuckIn = (model: ScriptedModel, request: number) => (model.requests[request]!.state as { state: { stuck?: Record<string, number> } }).state.stuck;
const click = (target: Box, present = 0.95): Entry => ({ [TOOL_QUESTION]: "click", "click.target": say.box(target), "click.target?present": present });
const hover = (target: Box): Entry => ({ [TOOL_QUESTION]: "hover", "hover.target": say.box(target), "hover.target?present": 0.95 });
const END: Entry = { [TOOL_QUESTION]: "end" };

async function run(path: string, script: Script | (() => Promise<Script>), options: BrowserToolsOptions = {}, maxSteps = 6) {
  await browser.goto(site.url + path);
  const model = new ScriptedModel(typeof script === "function" ? await script() : script);
  const result = await createAgent({ model, instructions: "Use the browser", tools: browserTools(browser, options), initialState: await browser.snapshot(), maxSteps }).run();
  return { model, result };
}

describe("small targets: a close button smaller than the finest box the model draws", () => {
  // What Jev gives for a 16 px button: a box on its grid (13 x 8 px) that is a few pixels off, here 30 px to the left of it, over the notice's empty corner.
  const coarse = px(942, 148, 955, 156);
  const noticeOpen = async () => (await browser.visibleText()).includes("We use cookies");

  it("misses with the coarse box alone: the click lands on the notice, which stays", async () => {
    const { result } = await run("/notice", [click(coarse), END], { zoom: false });
    expect(result.steps[0]!.summary).toMatch(/clicked <div>.*and the page looks the same$/);
    expect(await noticeOpen()).toBe(true);
  });

  it("asks the same question again on an enlarged picture of the part around the box, and clicks what it points at there", async () => {
    const { model, result } = await run("/notice", async (): Promise<Script> => {
      const zoomed = await browser.zoom(coarse);
      const close = (await browser.boxOf("#close"))!;
      const onZoom = (b: Box): Box => ({ left: (b.left * VIEW.width - zoomed.region.left) / (zoomed.region.right - zoomed.region.left), right: (b.right * VIEW.width - zoomed.region.left) / (zoomed.region.right - zoomed.region.left), top: (b.top * VIEW.height - zoomed.region.top) / (zoomed.region.bottom - zoomed.region.top), bottom: (b.bottom * VIEW.height - zoomed.region.top) / (zoomed.region.bottom - zoomed.region.top) });
      return [click(coarse), { [TOOL_QUESTION]: "locate", "locate.target": say.box(onZoom(close)), "locate.target?present": 0.95 }, END];
    });
    expect(result.status).toBe("ended");
    expect(result.steps[0]!.summary).toMatch(/^clicked <button> "Close modal" at \(\d+, \d+\)$/);
    expect(await noticeOpen()).toBe(false);
    // the second question is about a picture of the page's size that shows a part of it larger, and is asked of the same instructions
    expect(model.requests).toHaveLength(3);
    const zoomRequest = model.requests[1]!;
    const [picture] = Object.values(zoomRequest.images!);
    const size = pngSize(Buffer.from(picture!.base64, "base64"));
    expect(Math.abs(size.width - VIEW.width)).toBeLessThanOrEqual(3);
    expect(Math.abs(size.height - VIEW.height)).toBeLessThanOrEqual(3);
    expect(picture!.base64).not.toBe(Object.values(model.requests[0]!.images!)[0]!.base64);
    expect((zoomRequest.state as { instructions: string }).instructions).toBe("Use the browser");
    expect(JSON.stringify(zoomRequest.questions)).toContain("state.zoom");
  });

  it("also asks again on an enlarged picture when a bigger box has nothing pressable under its centre or in it, which is where a click would land on a gap", async () => {
    const loose = px(900, 100, 1060, 300); // a box around the corner of the notice that is about the close button; the 16 px button is 0.3% of it
    const { model, result } = await run("/notice", async (): Promise<Script> => {
      const zoomed = await browser.zoom(loose);
      const close = (await browser.boxOf("#close"))!;
      const w = zoomed.region.right - zoomed.region.left;
      const h = zoomed.region.bottom - zoomed.region.top;
      const onZoom: Box = { left: (close.left * VIEW.width - zoomed.region.left) / w, right: (close.right * VIEW.width - zoomed.region.left) / w, top: (close.top * VIEW.height - zoomed.region.top) / h, bottom: (close.bottom * VIEW.height - zoomed.region.top) / h };
      return [click(loose), { [TOOL_QUESTION]: "locate", "locate.target": say.box(onZoom), "locate.target?present": 0.95 }, END];
    });
    expect(model.requests).toHaveLength(3);
    expect(result.steps[0]!.summary).toMatch(/^clicked <button> "Close modal"/);
    expect(await noticeOpen()).toBe(false);
  });

  it("does not ask again for a target that is big enough, and keeps the first box when the enlarged picture does not show the target", async () => {
    const big = await run("/notice", async () => [click((await browser.boxOf("#continue"))!), END]);
    expect(big.model.requests).toHaveLength(2);
    const unsure = await run("/notice", [click(coarse), { [TOOL_QUESTION]: "locate", "locate.target": say.box({ top: 0.4, bottom: 0.5, left: 0.4, right: 0.5 }), "locate.target?present": 0.05 }, END]);
    expect(unsure.result.steps[0]!.summary).toMatch(/clicked <div>.*and the page looks the same$/);
    expect(await noticeOpen()).toBe(true);
  });

  it("leaves the click at the centre of a big box in which the only pressable things are small: a click on a gap does nothing, one on the wrong button does something", async () => {
    const { result } = await run("/notice", [click(px(300, 100, 1000, 700)), END], { zoom: false });
    expect(result.steps[0]!.summary).not.toMatch(/<button>/); // not CONTINUE, which takes up 4% of the box
    expect(result.steps[0]!.summary).toMatch(/and the page looks the same$/);
  });

  it("turns the pointer to a pressable element in the box when the point is on a gap: a box over the dots under a picture link opens the link", async () => {
    const { result } = await run("/cards", [click(px(130, 400, 410, 590)), END]);
    expect(result.steps[0]!.summary).toMatch(/clicked <a> "The brown boot"/);
    expect((await browser.info()).url).toBe(`${site.url}/pricing`);
  });
});

describe("the no-change guard and the pointer: a hover colour is not the page changing", () => {
  it("counts a hover that only lit up the element it points at as a run that changed nothing, and stops offering hover after three", async () => {
    const onContinue = async () => hover((await browser.boxOf("#continue"))!);
    const { model } = await run("/notice", async () => [await onContinue(), await onContinue(), await onContinue(), END], { hover: true, zoom: false });
    expect(stuckIn(model, 1)).toEqual({ hover: 1 });
    expect(stuckIn(model, 3)).toEqual({ hover: 3 });
    expect(toolsOf(model, 2)).toContain("hover");
    expect(toolsOf(model, 3)).not.toContain("hover");
  });

  it("keeps the count of a click that missed through a hover and the click away from it (the picture changes only where the pointer was)", async () => {
    const emptyCorner = px(100, 500, 400, 700);
    const { model, result } = await run("/notice", async () => [click(emptyCorner), hover((await browser.boxOf("#continue"))!), click(emptyCorner), END], { hover: true, zoom: false });
    expect(result.steps.map((s) => s.tool)).toEqual(["click", "hover", "click", "end"]);
    expect(stuckIn(model, 1)).toEqual({ click: 1 });
    expect(stuckIn(model, 2)).toEqual({ click: 1, hover: 1 }); // the hover colour did not clear it
    expect(stuckIn(model, 3)).toEqual({ click: 2, hover: 1 }); // nor did the pointer leaving CONTINUE, which put the colour out
  });

  it("still sees a real change next to the pointer: a click that changes the page clears the counts", async () => {
    const { model } = await run("/notice", async () => [click(px(100, 500, 400, 700)), click(px(942, 148, 955, 156)), click((await browser.boxOf("#close"))!), END], { zoom: false });
    expect(stuckIn(model, 1)).toEqual({ click: 1 });
    expect(stuckIn(model, 3)).toBeUndefined();
  });
});

describe("hover: menus that open when pressed", () => {
  const shoes = async () => (await browser.boxOf("#shoes"))!;
  const menuShown = async () => (await browser.visibleText()).includes("Sneakers");

  it("with plain hover the menu stays shut: pointing at the entry only underlines it", async () => {
    const { result } = await run("/click-menu", async () => [hover(await shoes()), END], { hover: true });
    expect(result.steps[0]!.summary).toMatch(/^pointed at <a> "Shoes" at \(\d+, \d+\)$/);
    expect(await menuShown()).toBe(false);
  });

  it("with 'or-click', a hover that opened nothing is followed by a click on the same point, and the menu opens", async () => {
    const { result } = await run("/click-menu", async () => [hover(await shoes()), END], { hover: "or-click" });
    expect(result.steps[0]!.summary).toMatch(/^pointed at <a> "Shoes" at \(\d+, \d+\), nothing opened, so clicked <a> "Shoes"$/);
    expect(await menuShown()).toBe(true);
    expect(result.state.stuck).toBeUndefined();
    // and its entries can be clicked next
    const next = await run("/click-menu", async () => {
      await browser.goto(site.url + "/click-menu");
      const entry = (await (async () => { await browser.clickBox(await shoes()); return browser.boxOf("#sneakers"); })())!;
      await browser.goto(site.url + "/click-menu");
      return [hover(await shoes()), click(entry), END];
    }, { hover: "or-click" });
    expect(next.result.state.page).toMatchObject({ url: `${site.url}/pricing` });
  });

  it("does not click when the menu opened on hover", async () => {
    const { result } = await run("/hover-menu", async () => [hover(await shoes()), END], { hover: "or-click" });
    expect(result.steps[0]!.summary).toMatch(/^pointed at <a> "Shoes" at \(\d+, \d+\)$/);
    expect(await menuShown()).toBe(true);
    expect(await browser.visibleText()).toContain("Presses: 0");
    expect(result.state.stuck).toBeUndefined();
  });
});

describe("scrollToFind: an option below the fold", () => {
  const sizeTen = async () => {
    await browser.goto(`${site.url}/sizes`);
    await browser.scroll("down");
    const box = (await browser.boxOf("#size-10"))!;
    await browser.goto(`${site.url}/sizes`);
    return box;
  };
  const notThere = { [TOOL_QUESTION]: "click", "click.target?present": 0.05 };

  it("scrolls down one step instead of giving up when the target is not in the screenshot, and clicks it on the next try", async () => {
    const { model, result } = await run("/sizes", async () => [notThere, click(await sizeTen()), END], { scrollToFind: true });
    expect(result.steps[0]!.summary).toMatch(/not visible in the screenshot, so scrolled down to look further \(640px from the top\)$/);
    expect((result.steps[0]! as { args: unknown }).args).toEqual({ target: null });
    expect((model.requests[1]!.state as { state: { page: { scroll: { position: number } } } }).state.page.scroll.position).toBe(640);
    expect(result.steps[1]!.summary).toMatch(/clicked <button> "10"/);
    expect(await browser.visibleText()).toContain("Selected: 10");
  });

  it("does nothing when it is not asked to, as before", async () => {
    const { result } = await run("/sizes", [notThere, END]);
    expect(result.steps[0]!.summary).toBe("found nothing to click: the element is not visible in the screenshot");
    expect((await browser.info()).scroll.position).toBe(0);
  });

  it("does nothing at the end of the page, where there is no further to go", async () => {
    await browser.goto(`${site.url}/sizes`);
    await browser.scroll("bottom");
    const model = new ScriptedModel([notThere, END]);
    const result = await createAgent({ model, instructions: "x", tools: browserTools(browser, { scrollToFind: true }), initialState: await browser.snapshot(), maxSteps: 2 }).run();
    expect(result.steps[0]!.summary).toBe("found nothing to click: the element is not visible in the screenshot");
  });
});

describe("a click that loads another page", () => {
  it("waits for the page to arrive: the next screenshot, and the state, are of the new page, not of the old one", async () => {
    const { result } = await run("/slow-go", async () => [click((await browser.boxOf("#go"))!), END]);
    expect(result.steps[0]!.error).toBeUndefined();
    expect(result.state.page).toMatchObject({ url: `${site.url}/slow-page`, title: "Slow page" });
    expect(await browser.visibleText()).toContain("It arrived.");
  });
});

