/**
 * Browser tools, mechanics forced with ScriptedModel against a site on loopback. Still end to end:
 * createAgent(...).run() with a real headless Chromium, the real tools and real screenshots.
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
const criteria = (model: ScriptedModel, request: number, question: string) => (model.requests[request]!.questions[question] as { criteria: Record<string, string> }).criteria;
const toolsOf = (model: ScriptedModel, request: number) => Object.keys(criteria(model, request, TOOL_QUESTION)).sort();
const around = (b: Box, grow = 0): Box => ({ top: b.top - grow, bottom: b.bottom + grow, left: b.left - grow, right: b.right + grow });

/** Opens `path`, runs the agent over it with the browser tools, and returns what is needed to judge it. */
async function run(path: string, script: Script | ((box: (selector: string) => Promise<Box>) => Promise<Script>), options: BrowserToolsOptions = {}, session: BrowserSession = browser) {
  const browser = session;
  if (path !== "") await browser.goto(site.url + path);
  const box = async (selector: string) => (await browser.boxOf(selector))!;
  const model = new ScriptedModel(typeof script === "function" ? await script(box) : script);
  const initialState = path === "" ? {} : await browser.snapshot();
  const result = await createAgent({ model, instructions: "Use the browser", tools: browserTools(browser, options), initialState, maxSteps: 6 }).run();
  return { model, result };
}

describe("browser: the screenshot is the state", () => {
  it("shows the model one PNG of the viewport size and says where the page is", async () => {
    const { model, result } = await run("/", [{ [TOOL_QUESTION]: "end" }]);
    const request = model.requests[0]!;
    const images = Object.values(request.images!);
    expect(images).toHaveLength(1);
    expect(images[0]!.format).toBe("png");
    expect(pngSize(Buffer.from(images[0]!.base64, "base64"))).toEqual({ width: 1280, height: 800 });
    const page = (request.state as { state: { page: { url: string; title: string; scroll: { position: number; max: number } } } }).state.page;
    expect(page).toMatchObject({ url: `${site.url}/`, title: "Acme Studio", scroll: { position: 0 } });
    expect(page.scroll.max).toBeGreaterThan(0);
    expect(result.status).toBe("ended");
  });

  it("offers click, scroll, press_key and go_back on a page, but no navigate and no type_text unless there are candidates", async () => {
    const { model } = await run("/", [{ [TOOL_QUESTION]: "end" }]);
    expect(toolsOf(model, 0)).toEqual(["click", "end", "go_back", "press_key", "scroll"]);
    const withCandidates = await run("/", [{ [TOOL_QUESTION]: "end" }], { urls: [`${site.url}/pricing`], texts: ["Ada"] });
    expect(toolsOf(withCandidates.model, 0)).toEqual(["click", "end", "go_back", "navigate", "press_key", "scroll", "type_text"]);
  });

  it("offers only navigate and end before any page is open", async () => {
    const { model } = await run("", [{ [TOOL_QUESTION]: "end" }], { urls: [`${site.url}/`] });
    expect(toolsOf(model, 0)).toEqual(["end", "navigate"]);
  });
});

describe("browser: a Box becomes a click", () => {
  const pick = async (selector: string, grow = 0, offset = 0) => {
    const { result } = await run("/", async (box): Promise<Script> => {
      const b = around(await box(selector), grow);
      const moved = { ...b, left: b.left + offset, right: b.right + offset };
      return [{ [TOOL_QUESTION]: "click", "click.target": say.box(moved), "click.target?present": 0.95 }, { [TOOL_QUESTION]: "end" }];
    });
    return { result, shown: (await browser.visibleText()).split("\n").find((l) => l.startsWith("Last pick")) };
  };

  it("hits the element a box surrounds, for each of three buttons at different positions", async () => {
    expect((await pick("#red")).shown).toBe("Last pick: Red");
    expect((await pick("#green")).shown).toBe("Last pick: Green");
    expect((await pick("#blue")).shown).toBe("Last pick: Blue");
  });

  it("clicks the centre of the box, so a loose box that mostly covers the button still hits it", async () => {
    expect((await pick("#blue", 0.01, -0.01)).shown).toBe("Last pick: Blue");
  });

  it("reports what was clicked, and that nothing changed when a click lands on empty space", async () => {
    const hit = await pick("#green");
    expect(hit.result.steps[0]!.summary).toMatch(/^clicked <button> "Green" at \(\d+, \d+\)$/);
    const { result } = await run("/", [{ [TOOL_QUESTION]: "click", "click.target": say.box({ top: 0.9, bottom: 0.95, left: 0.9, right: 0.95 }), "click.target?present": 0.95 }, { [TOOL_QUESTION]: "end" }]);
    expect(result.steps[0]!.summary).toMatch(/and the page looks the same$/);
  });

  it("clicks nothing when the model says the target is not in the screenshot", async () => {
    const { result } = await run("/", [{ [TOOL_QUESTION]: "click", "click.target?present": 0.05 }, { [TOOL_QUESTION]: "end" }]);
    expect(result.steps[0]!.args).toEqual({ target: null });
    expect(result.steps[0]!.summary).toMatch(/found nothing to click/);
    expect((await browser.visibleText()).includes("Last pick: none")).toBe(true);
  });
});

describe("browser: scrolling", () => {
  it("moves down a screen at a time, offering only directions that move the page", async () => {
    const { model, result } = await run("/", [{ [TOOL_QUESTION]: "scroll", "scroll.direction": "down" }, { [TOOL_QUESTION]: "scroll", "scroll.direction": "down" }, { [TOOL_QUESTION]: "scroll", "scroll.direction": "up" }, { [TOOL_QUESTION]: "end" }]);
    expect(Object.keys(criteria(model, 0, "scroll.direction")).sort()).toEqual(["bottom", "down"]); // at the top: nothing above
    expect(Object.keys(criteria(model, 1, "scroll.direction")).sort()).toEqual(["bottom", "down", "top", "up"]);
    const positions = result.steps.map((s) => /to (\d+)px/.exec(s.summary ?? "")?.[1]).slice(0, 3).map(Number);
    expect(positions[0]).toBe(640); // 80% of 800
    expect(positions[1]).toBeGreaterThan(positions[0]!);
    expect(positions[2]).toBeLessThan(positions[1]!);
  });

  it("offers neither down nor bottom once the page is at its end, and the screenshot then shows the newsletter", async () => {
    expect(await (async () => (await run("/", [{ [TOOL_QUESTION]: "scroll", "scroll.direction": "bottom" }, { [TOOL_QUESTION]: "end" }])).model)().then((m) => Object.keys(criteria(m, 1, "scroll.direction")).sort())).toEqual(["top", "up"]);
    expect(await browser.visibleText()).toContain("Subscribe");
  });

  it("is not offered on a page that fits in one screen", async () => {
    const { model } = await run("/short", [{ [TOOL_QUESTION]: "end" }]);
    expect(toolsOf(model, 0)).not.toContain("scroll");
  });

  it("changes what the screenshot and the page text show, while code can read the whole page at any time", async () => {
    await browser.goto(`${site.url}/`);
    expect(await browser.visibleText()).not.toContain("Subscribe");
    expect(await browser.text()).toContain("Subscribe");
    await run("/", [{ [TOOL_QUESTION]: "scroll", "scroll.direction": "bottom" }, { [TOOL_QUESTION]: "end" }]);
    expect(await browser.visibleText()).toContain("Subscribe");
    expect(await browser.visibleText()).not.toContain("Pick a colour");
  });
});

describe("browser: typing", () => {
  it("types a candidate into the clicked field and submits it with a key", async () => {
    const { result } = await run("/search", async (box): Promise<Script> => [
      { [TOOL_QUESTION]: "click", "click.target": say.box(await box("#q")), "click.target?present": 0.95 },
      { [TOOL_QUESTION]: "type_text", "type_text.text": "Ada Lovelace" },
      { [TOOL_QUESTION]: "press_key", "press_key.key": "Enter" },
      { [TOOL_QUESTION]: "end" },
    ], { texts: { "Ada Lovelace": "a name to look up", "Alan Turing": "another name" } });
    expect(result.steps.map((s) => s.summary)).toEqual([expect.stringMatching(/<input>/), `typed "Ada Lovelace" into the <input>`, "pressed Enter", "ended"]);
    expect(await browser.text()).toContain("Results for: Ada Lovelace");
  });

  it("types nothing, and says so, when no field is selected", async () => {
    const { result } = await run("/search", [{ [TOOL_QUESTION]: "type_text", "type_text.text": "Ada" }, { [TOOL_QUESTION]: "end" }], { texts: ["Ada"] });
    expect(result.steps[0]!.summary).toMatch(/typed nothing: no field is selected/);
  });

  it("fills the newsletter form on a long page: scroll, click the field, type, click Subscribe", async () => {
    const before = site.subscriptions.length;
    await run("/", async (box): Promise<Script> => {
      await browser.scroll("bottom");
      const email = await box("#email");
      const subscribe = await box("#subscribe");
      await browser.goto(`${site.url}/`);
      return [
        { [TOOL_QUESTION]: "scroll", "scroll.direction": "bottom" },
        { [TOOL_QUESTION]: "click", "click.target": say.box(email), "click.target?present": 0.95 },
        { [TOOL_QUESTION]: "type_text", "type_text.text": "ada@example.com" },
        { [TOOL_QUESTION]: "click", "click.target": say.box(subscribe), "click.target?present": 0.95 },
        { [TOOL_QUESTION]: "end" },
      ];
    }, { texts: ["ada@example.com"] });
    expect(site.subscriptions.slice(before)).toEqual(["ada@example.com"]);
    expect(await browser.visibleText()).toContain("Thanks for subscribing, ada@example.com");
  });
});

describe("browser: moving between pages", () => {
  it("opens an address from the candidates, then goes back", async () => {
    const { model, result } = await run("", [{ [TOOL_QUESTION]: "navigate", "navigate.url": `${site.url}/pricing` }, { [TOOL_QUESTION]: "navigate", "navigate.url": `${site.url}/short` }, { [TOOL_QUESTION]: "go_back" }, { [TOOL_QUESTION]: "end" }], {
      urls: { [`${site.url}/pricing`]: "the prices", [`${site.url}/short`]: "a short page" },
    });
    expect(Object.keys(criteria(model, 0, "navigate.url")).sort()).toEqual([`${site.url}/pricing`, `${site.url}/short`]);
    expect(result.steps[0]!.summary).toBe(`opened ${site.url}/pricing ("Pricing")`);
    expect(result.steps[2]!.summary).toBe("went back to the previous page");
    expect((result.state.page as { url: string }).url).toBe(`${site.url}/pricing`);
  });

  it("follows a link that opens a new tab", async () => {
    const { result } = await run("/popup", async (box): Promise<Script> => [{ [TOOL_QUESTION]: "click", "click.target": say.box(await box("#out")), "click.target?present": 0.95 }, { [TOOL_QUESTION]: "end" }]);
    expect(result.state.page).toMatchObject({ url: `${site.url}/pricing`, title: "Pricing" });
  });

  // Each of these needs a browser whose history starts empty: the shared one remembers every page the tests above opened.
  const withFreshBrowser = async <T>(use: (fresh: BrowserSession) => Promise<T>): Promise<T> => {
    const fresh = await BrowserSession.launch({ allowedHosts: ["127.0.0.1"], settleMs: 100 });
    try {
      return await use(fresh);
    } finally {
      await fresh.close();
    }
  };

  it("does not go back to a blank page from the first page: the page stays, the step says so, and the run goes on", () =>
    withFreshBrowser(async (fresh) => {
      const goBack = { [TOOL_QUESTION]: "go_back" };
      const { model, result } = await run("/", [goBack, { [TOOL_QUESTION]: "click", "click.target": say.box({ top: 0.9, bottom: 0.95, left: 0.9, right: 0.95 }), "click.target?present": 0.95 }, goBack, { [TOOL_QUESTION]: "end" }], {}, fresh);
      expect(result.status).toBe("ended");
      expect(result.steps[0]!.summary).toMatch(/there is no previous page to go back to/);
      expect(result.state.page).toMatchObject({ url: `${site.url}/`, title: "Acme Studio" });
      expect((await fresh.info()).url).toBe(`${site.url}/`);
      expect(await fresh.visibleText()).toContain("Pick a colour");
      expect(Object.keys(model.requests[1]!.images!)).toHaveLength(1); // the model still sees the page, not an empty screenshot
    }));

  it("stops offering go_back after three tries on a page with nothing before it, like any tool that changes nothing", () =>
    withFreshBrowser(async (fresh) => {
      const goBack = { [TOOL_QUESTION]: "go_back" };
      const { model, result } = await run("/", [goBack, goBack, goBack, { [TOOL_QUESTION]: "end" }], {}, fresh);
      expect(toolsOf(model, 2)).toContain("go_back");
      expect(toolsOf(model, 3)).not.toContain("go_back");
      expect((result.state.page as { url: string }).url).toBe(`${site.url}/`);
    }));

  it("goes back to the page before a link that loaded another page, and not past the first one", () =>
    withFreshBrowser(async (fresh) => {
      const goBack = { [TOOL_QUESTION]: "go_back" };
      const { result } = await run("/", async (box): Promise<Script> => [{ [TOOL_QUESTION]: "click", "click.target": say.box(around(await box("nav a[href='/pricing']"), 0.01)), "click.target?present": 0.95 }, goBack, goBack, { [TOOL_QUESTION]: "end" }], {}, fresh);
      expect(result.steps[0]!.summary).toMatch(/clicked/);
      expect(result.steps[1]!.summary).toBe("went back to the previous page");
      expect(result.steps[2]!.summary).toMatch(/there is no previous page/);
      expect((result.state.page as { url: string }).url).toBe(`${site.url}/`);
    }));

  it("goes back after the page changed its view without loading a page (in-page navigation)", () =>
    withFreshBrowser(async (fresh) => {
      const { result } = await run("/views", async (box): Promise<Script> => [{ [TOOL_QUESTION]: "click", "click.target": say.box(await box("#next")), "click.target?present": 0.95 }, { [TOOL_QUESTION]: "go_back" }, { [TOOL_QUESTION]: "end" }], {}, fresh);
      expect(result.steps[1]!.summary).toBe("went back to the previous page");
      expect(result.state.page).toMatchObject({ url: `${site.url}/views` });
      expect(await fresh.text()).toContain("View one");
    }));

  it("returns from a tab that a link opened to the tab it was opened from, and no further", () =>
    withFreshBrowser(async (fresh) => {
      const { result } = await run("/popup", async (box): Promise<Script> => [{ [TOOL_QUESTION]: "click", "click.target": say.box(await box("#out")), "click.target?present": 0.95 }, { [TOOL_QUESTION]: "go_back" }, { [TOOL_QUESTION]: "go_back" }, { [TOOL_QUESTION]: "end" }], {}, fresh);
      expect(result.steps[1]!.summary).toBe("went back to the previous page");
      expect(result.steps[2]!.summary).toMatch(/there is no previous page/);
      expect(result.state.page).toMatchObject({ url: `${site.url}/popup`, title: "Popup" });
    }));

  it("refuses an address on a host that is not allowed, as an error the agent sees, and stays where it was", async () => {
    await browser.goto(`${site.url}/short`);
    const { result } = await run("", [{ [TOOL_QUESTION]: "navigate", "navigate.url": `${site.otherHostUrl}/pricing` }, { [TOOL_QUESTION]: "end" }], { urls: [`${site.otherHostUrl}/pricing`] });
    expect(result.steps[0]!.error).toMatch(/localhost is not one of the allowed hosts/);
    expect((await browser.info()).url).toBe(`${site.url}/short`);
  });

  it("does not let a click on a link walk off the allowed hosts: the page stays and the summary says why", async () => {
    const { result } = await run("/leave", async (box): Promise<Script> => [{ [TOOL_QUESTION]: "click", "click.target": say.box(await box("#away")), "click.target?present": 0.95 }, { [TOOL_QUESTION]: "end" }]);
    expect(result.steps[0]!.summary).toMatch(/localhost:\d+\/pricing is not an allowed address, so the page stayed/);
    expect((result.state.page as { url: string }).url).toBe(`${site.url}/leave`);
  });
});

describe("browser: launching", () => {
  it("refuses a viewport outside the image limits Jev accepts, before launching anything", async () => {
    await expect(BrowserSession.launch({ viewport: { width: 100, height: 100 } })).rejects.toThrow(/100x100.*280-1568/);
    await expect(BrowserSession.launch({ viewport: { width: 2000, height: 800 } })).rejects.toThrow(/2000x800/);
  });
});

describe("browser: the no-change guard", () => {
  const escape = { [TOOL_QUESTION]: "press_key", "press_key.key": "Escape" };
  const stuckIn = (model: ScriptedModel, request: number) => (model.requests[request]!.state as { state: { stuck?: Record<string, number> } }).state.stuck;

  it("counts the runs of a tool that changed nothing, and stops offering it at the third", async () => {
    const { model, result } = await run("/", [escape, escape, escape, { [TOOL_QUESTION]: "end" }]);
    expect(stuckIn(model, 0)).toBeUndefined();
    expect(stuckIn(model, 1)).toEqual({ press_key: 1 });
    expect(stuckIn(model, 2)).toEqual({ press_key: 2 });
    expect(toolsOf(model, 2)).toContain("press_key");
    expect(stuckIn(model, 3)).toEqual({ press_key: 3 });
    expect(toolsOf(model, 3)).toEqual(["click", "end", "go_back", "scroll"]);
    expect(result.status).toBe("ended");
  });

  it("lifts the block as soon as something changes the screenshot", async () => {
    const { model } = await run("/", [escape, escape, { [TOOL_QUESTION]: "scroll", "scroll.direction": "down" }, escape, { [TOOL_QUESTION]: "end" }]);
    expect(stuckIn(model, 2)).toEqual({ press_key: 2 });
    expect(stuckIn(model, 3)).toBeUndefined(); // the scroll changed the page
    expect(stuckIn(model, 4)).toEqual({ press_key: 1 }); // and counting starts again
  });

  it("can be turned off with noChange: 0", async () => {
    const { model } = await run("/", [escape, escape, escape, escape, { [TOOL_QUESTION]: "end" }], { noChange: 0 });
    expect(toolsOf(model, 4)).toContain("press_key");
  });

  it("leaves the address and the title out of the state when pageText is false, keeping only the scroll position", async () => {
    const { model } = await run("/", [{ [TOOL_QUESTION]: "scroll", "scroll.direction": "down" }, { [TOOL_QUESTION]: "end" }], { pageText: false });
    const page = (model.requests[1]!.state as { state: { page: Record<string, unknown> } }).state.page;
    expect(Object.keys(page)).toEqual(["scroll"]);
    expect((page.scroll as { position: number }).position).toBe(640);
  });
});
