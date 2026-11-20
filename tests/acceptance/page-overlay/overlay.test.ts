/**
 * The overlay on a page, mechanics forced with ScriptedModel against the checkout page on loopback. Still end to end:
 * createAgent(...).run() with a real headless Chromium, the real tools and real screenshots. The panel belongs to the person,
 * not to the agent: it is not in the pictures the model sees, a click aimed at the page below it lands on the page, and text typed
 * for the page can never land in it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedModel, TOOL_QUESTION, createAgent, defineTool, say, type Box } from "../../../src/index.js";
import { BrowserSession, PageOverlay, browserTools } from "../../../src/browser/index.js";
import { startCheckoutSite, type CheckoutSite } from "../../../examples/page-overlay/checkout-site.js";

let site: CheckoutSite;
let browser: BrowserSession;
let overlay: PageOverlay;
beforeEach(async () => {
  site = await startCheckoutSite();
  browser = await BrowserSession.launch({ allowedHosts: ["127.0.0.1"], settleMs: 100 });
  overlay = await PageOverlay.install(browser, { title: "Helper" });
  await browser.goto(`${site.url}/checkout`);
});
afterEach(async () => {
  await browser?.close();
  await site?.close();
});

/** What the panel shows right now, read from the page like a person would look. */
const panelText = () => browser.evaluate(() => (document.querySelector("#de-overlay")?.shadowRoot?.querySelector(".log") as HTMLElement | null)?.innerText ?? "", 0);
const fieldDisabled = () => browser.evaluate(() => (document.querySelector("#de-overlay")?.shadowRoot?.querySelector("input") as HTMLInputElement).disabled, 0);
const pageError = () => browser.evaluate(() => document.getElementById("error")?.textContent ?? "", 0);
const base64 = (png: Uint8Array) => Buffer.from(png).toString("base64");

describe("page overlay: the panel is the person's, not the agent's", () => {
  it("is on the page for the person but not in the screenshot the model sees", async () => {
    const withPanel = await browser.screenshot({ everything: true });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "end" }]);
    await overlay.say("Looking at the page");
    const result = await createAgent({ model, instructions: "Look", tools: browserTools(browser), initialState: await browser.snapshot(), maxSteps: 2 }).run();
    expect(result.status).toBe("ended");
    const seen = Object.values(model.requests[0]!.images ?? {})[0]!.base64;

    // the person's picture has the panel, the model's does not: it equals the page with the panel taken away altogether
    expect(seen).not.toBe(base64(withPanel));
    await browser.evaluate(() => document.querySelector("#de-overlay")?.remove(), 0);
    expect(seen).toBe(base64(await browser.screenshot({ everything: true })));
  });

  it("is not part of the page's text either", async () => {
    await overlay.say("A line of the transcript");
    expect(await panelText()).toContain("A line of the transcript");
    expect(await browser.text()).not.toContain("A line of the transcript");
    expect(await browser.visibleText()).not.toContain("A line of the transcript");
  });

  it("lets a click through to the page below it while the agent works, and takes it when the person's turn", async () => {
    const box: Box = { left: 0.78, right: 0.9, top: 0.82, bottom: 0.88 }; // a part of the Place order button that lies wholly under the panel
    const clickIt = async () => {
      const model = new ScriptedModel([{ [TOOL_QUESTION]: "click", "click.target": say.box(box), "click.target?present": 0.95 }, { [TOOL_QUESTION]: "end" }]);
      await createAgent({ model, instructions: "Click Place order", tools: browserTools(browser), initialState: await browser.snapshot(), maxSteps: 3 }).run();
    };
    // the Place order button lies under the panel
    const under = await browser.evaluate((b) => document.elementFromPoint(b.x, b.y)?.id ?? "", { x: 1000, y: 690 });
    expect(under).toBe("de-overlay");

    await clickIt(); // the person's turn: the click lands on the panel, the page does not notice
    expect(await pageError()).toBe("");
    expect(site.requests.filter((r) => r.startsWith("POST"))).toEqual([]);

    await overlay.working(true);
    await clickIt(); // the agent's turn: it goes through, and the shop answers that the form is empty
    expect(await pageError()).toMatch(/Please fill in/);
    expect(site.requests).toContain("POST /api/order");
    await overlay.working(false);
  });

  it("is not a field that typed text can reach: while the agent works it is disabled, and what the agent types goes to the page", async () => {
    await overlay.working(true);
    expect(await fieldDisabled()).toBe(true);
    const field = (await browser.boxOf("#name"))!;
    const name = { ...field, top: field.top - 0.03, bottom: field.bottom + 0.03 }; // a box of at least 48 px, or the click is asked again on an enlarged picture
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "click", "click.target": say.box(name), "click.target?present": 0.95 }, { [TOOL_QUESTION]: "type_text", "type_text.text": "Ada Lovelace" }, { [TOOL_QUESTION]: "end" }]);
    await createAgent({ model, instructions: "Type the name", tools: browserTools(browser, { texts: ["Ada Lovelace"] }), initialState: await browser.snapshot(), maxSteps: 4 }).run();
    expect(await browser.evaluate(() => (document.getElementById("name") as HTMLInputElement).value, 0)).toBe("Ada Lovelace");
    await overlay.working(false);
    expect(await fieldDisabled()).toBe(false);
    expect(overlay.messages).toEqual([]);
  });

  it("stays when the page is loaded again, with what was said", async () => {
    await overlay.say("First step done");
    await browser.goto(`${site.url}/checkout`);
    expect(await panelText()).toContain("First step done");
    await overlay.say("Second step done");
    expect(await panelText()).toContain("Second step done");
  });

  it("hands what the person types to whoever waits for an instruction", async () => {
    const waiting = overlay.nextInstruction();
    await overlay.send("  make me a coffee  ");
    expect(await waiting).toBe("make me a coffee");
    await overlay.send("an instruction sent before anyone waits");
    expect(await overlay.nextInstruction()).toBe("an instruction sent before anyone waits");
    expect(overlay.messages.map((m) => m.kind)).toEqual(["user", "user"]);
  });
});

describe("page overlay: a question holds the loop until the person answers in the panel", () => {
  it("shows the question, waits, and continues with the answer", async () => {
    const ask = defineTool({
      name: "ask_delivery",
      description: "Asks the person how fast the delivery should be.",
      run: async (_args, ctx) => ({ state: { reply: await ctx.input.ask("Standard or Express?") }, summary: "asked" }),
    });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "ask_delivery" }, { [TOOL_QUESTION]: "end" }]);
    await overlay.working(true);
    const running = createAgent({ model, instructions: "Ask how fast", tools: [ask], input: overlay.input, maxSteps: 4 }).run();

    await new Promise((r) => setTimeout(r, 600)); // nobody answers yet
    expect(model.requests).toHaveLength(1); // the loop is held: no request for the next step
    expect(await panelText()).toContain("Standard or Express?");
    expect(await fieldDisabled()).toBe(false); // the person can write while a question is open

    await overlay.send("Express please");
    const result = await running;
    expect(result.status).toBe("ended");
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1]!.state)).toContain("Express please"); // the answer is in the state the next step sees
    expect(overlay.messages).toEqual([
      { kind: "question", text: "Standard or Express?" },
      { kind: "user", text: "Express please" },
    ]);
    expect(await fieldDisabled()).toBe(true); // back to working on the page
    await overlay.working(false);
  });

  it("does not take an answer for the next instruction, nor the next instruction for an answer", async () => {
    const early = overlay.nextInstruction();
    const asked = overlay.input.ask("Which one?", { signal: new AbortController().signal });
    await overlay.send("the answer");
    expect(await asked).toBe("the answer");
    await overlay.send("a new instruction");
    expect(await early).toBe("a new instruction");
  });
});
