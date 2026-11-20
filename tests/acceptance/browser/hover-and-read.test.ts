/**
 * Hovering and reading text by pointing, forced with ScriptedModel against the look-alike shop on loopback:
 * createAgent(...).run() with a real headless Chromium, the real tools and real screenshots.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession, ScriptedModel, TOOL_QUESTION, browserTools, createAgent, say, type Box } from "../../../src/index.js";
import { shoppingTools } from "../../../examples/storefront-browser/shopping.js";
import { startShopSite, type ShopSite } from "../../../examples/storefront-browser/shop-site.js";

let site: ShopSite;
let browser: BrowserSession;
beforeAll(async () => {
  site = await startShopSite();
  browser = await BrowserSession.launch({ allowedHosts: ["127.0.0.1"], settleMs: 100 });
});
afterAll(async () => {
  await browser?.close();
  await site?.close();
});

const around = (b: Box, grow: number): Box => ({ top: b.top - grow, bottom: b.bottom + grow, left: b.left - grow, right: b.right + grow });
const criteria = (model: ScriptedModel, request: number, question: string) => (model.requests[request]!.questions[question] as { criteria: Record<string, string> }).criteria;
const toolsOf = (model: ScriptedModel, request: number) => Object.keys(criteria(model, request, TOOL_QUESTION)).sort();

describe("hover: menus that open when the pointer is on them", () => {
  it("is offered only when asked for, next to click", async () => {
    await browser.goto(`${site.url}/`);
    const plain = new ScriptedModel([{ [TOOL_QUESTION]: "end" }]);
    await createAgent({ model: plain, instructions: "x", tools: browserTools(browser), initialState: await browser.snapshot(), maxSteps: 2 }).run();
    expect(toolsOf(plain, 0)).not.toContain("hover");
    const withHover = new ScriptedModel([{ [TOOL_QUESTION]: "end" }]);
    await createAgent({ model: withHover, instructions: "x", tools: browserTools(browser, { hover: true }), initialState: await browser.snapshot(), maxSteps: 2 }).run();
    expect(toolsOf(withHover, 0)).toEqual(["click", "end", "go_back", "hover", "press_key", "scroll"]);
  });

  it("opens the menu without leaving the page, so that its entries are in the next screenshot and can be clicked", async () => {
    await browser.goto(`${site.url}/`);
    expect(await browser.visibleText()).not.toContain("Sweatshirts");
    const women = (await browser.boxOf("nav .item a"))!;
    const model = new ScriptedModel([
      { [TOOL_QUESTION]: "hover", "hover.target": say.box(women), "hover.target?present": 0.95 },
    ]);
    const before = (await browser.snapshot()).screen;
    const result = await createAgent({ model, instructions: "Open the women's menu", tools: browserTools(browser, { hover: true }), initialState: { screen: before!, page: (await browser.snapshot()).page! }, maxSteps: 1 }).run();
    expect(result.steps[0]!.summary).toMatch(/pointed at <a> "Women"/i);
    expect((await browser.info()).url).toBe(`${site.url}/`);
    expect(await browser.visibleText()).toContain("Sweatshirts & Hoodies");
    expect(result.state.screen).not.toEqual(before);
    // the entry is under the pointer's menu: a click on it goes there
    const entry = (await browser.boxOf('.mega a[href="/collections/womens-sweatshirts-hoodies"]'))!;
    const click = new ScriptedModel([
      { [TOOL_QUESTION]: "click", "click.target": say.box(entry), "click.target?present": 0.95 },
      { [TOOL_QUESTION]: "end" },
    ]);
    await createAgent({ model: click, instructions: "Click the sweatshirts entry", tools: browserTools(browser, { hover: true }), initialState: await browser.snapshot(), maxSteps: 2 }).run();
    expect((await browser.info()).url).toBe(`${site.url}/collections/womens-sweatshirts-hoodies`);
  });

  it("does nothing when the element is not there", async () => {
    await browser.goto(`${site.url}/`);
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "hover", "hover.target": say.box({ top: 0.1, bottom: 0.2, left: 0.1, right: 0.2 }), "hover.target?present": 0.05 }, { [TOOL_QUESTION]: "end" }]);
    const result = await createAgent({ model, instructions: "x", tools: browserTools(browser, { hover: true }), initialState: await browser.snapshot(), maxSteps: 2 }).run();
    expect(result.steps[0]!.summary).toMatch(/not visible/);
  });
});

describe("textIn: the characters inside a box, read by code", () => {
  const product = `/products/w31007r-accolade-hoodie-moonshadow-blue`;

  it("reads the text of the elements a box covers, in reading order", async () => {
    await browser.goto(site.url + product);
    expect(await browser.textIn((await browser.boxOf("#price"))!)).toBe("$148");
    expect(await browser.textIn(around((await browser.boxOf(".name"))!, 0.01))).toBe("Accolade Hoodie");
    expect(await browser.textIn({ top: 0.2, bottom: 0.9, left: 0.4, right: 0.95 })).toMatch(/^Accolade Hoodie \$148 Colour: Moonshadow Blue/);
  });

  it("finds nothing in a box over an empty part of the page, and ignores text that the box only touches", async () => {
    await browser.goto(site.url + product);
    expect(await browser.textIn({ top: 0.75, bottom: 0.85, left: 0.6, right: 0.9 })).toBe("");
    const price = (await browser.boxOf("#price"))!;
    expect(await browser.textIn({ ...price, bottom: price.top + (price.bottom - price.top) * 0.3 })).toBe("");
  });

  it("`grow` forgives a box that is a few pixels off", async () => {
    await browser.goto(site.url + product);
    const price = (await browser.boxOf("#price"))!;
    const off: Box = { ...price, top: price.top - 0.03, bottom: price.bottom - 0.02 }; // slid up by about 24 px: it covers little of the price
    expect(await browser.textIn(off)).not.toBe("$148");
    expect(await browser.textIn(off, 0.02)).toContain("$148");
  });
});

describe("read_price: the model points, code reads the characters and decides what counts as a price", () => {
  async function run(box: Box | null, path = "/products/w31007r-accolade-hoodie-moonshadow-blue", scrolled = false) {
    await browser.goto(site.url + path);
    if (scrolled) await browser.scroll("down");
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "read_price", "read_price.target": say.box(box ?? { top: 0, bottom: 0.1, left: 0, right: 0.1 }), "read_price.target?present": box ? 0.95 : 0.05 }, { [TOOL_QUESTION]: "end" }]);
    return await createAgent({ model, instructions: "Read the price", tools: shoppingTools(browser, { home: `${site.url}/` }), initialState: await browser.snapshot(), maxSteps: 2 }).run();
  }

  it("puts the price into state.price", async () => {
    const result = await run((await browser.boxOf("#price"))!);
    expect(result.steps[0]!.summary).toBe("read the price $148");
    expect(result.state.price).toEqual({ text: "$148", page: `${site.url}/products/w31007r-accolade-hoodie-moonshadow-blue` });
  });

  it("also reads it from a box that is slightly off", async () => {
    await browser.goto(site.url + "/products/w31007r-accolade-hoodie-moonshadow-blue");
    const price = (await browser.boxOf("#price"))!;
    const result = await run({ ...price, top: price.top - 0.03, bottom: price.bottom - 0.02 });
    expect(result.state.price).toMatchObject({ text: "$148" });
  });

  it("says so when the box holds no price, several prices, or the model says the price is not there", async () => {
    expect((await run({ top: 0.7, bottom: 0.9, left: 0.6, right: 0.9 })).steps[0]!.summary).toMatch(/found no price in that box/);
    const several = await run({ top: 0.4, bottom: 0.99, left: 0.01, right: 0.99 }, "/collections/womens-sweatshirts-hoodies", true);
    expect(several.steps[0]!.summary).toMatch(/found several prices/);
    expect(several.state.price).toBeUndefined();
    const absent = await run(null);
    expect(absent.steps[0]!.summary).toMatch(/found no price: it is not visible/);
    expect(absent.state.price).toBeUndefined();
  });
});
