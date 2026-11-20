/**
 * The Kanban board and the panel beside it, mechanics forced with ScriptedModel against the board on loopback. Still end to end:
 * createAgent(...).run() with a real headless Chromium, real tools and real screenshots. A card moves by being dragged (a Box around
 * the card, a Box around the column) or from its dialog; the server's state shows what happened; the panel is not in what the model sees.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedModel, TOOL_QUESTION, createAgent, defineTool, param, say } from "../../../src/index.js";
import { BrowserSession, PageOverlay, browserTools, snapshotOf } from "../../../src/browser/index.js";
import { START, startKanbanSite, type KanbanSite } from "../../../examples/kanban/kanban-site.js";
import { changes, readBoard } from "../../../examples/kanban/assistant.js";

let site: KanbanSite;
let browser: BrowserSession;
beforeEach(async () => {
  site = await startKanbanSite();
  browser = await BrowserSession.launch({ allowedHosts: ["127.0.0.1"], settleMs: 100 });
  await browser.goto(site.url);
});
afterEach(async () => {
  await browser?.close();
  await site?.close();
});

const where = (title: string) => site.cards().find((c) => c.title === title)!;
const cardBox = async (id: number) => (await browser.boxOf(`.card[data-id="${id}"]`))!;
const columnBox = async (name: string) => (await browser.boxOf(`[data-column="${name}"]`))!;

/** A one-tool agent over `BrowserSession.dragBox`, the way the example's `drag` is built, with the Boxes that a perfect model would answer. */
async function dragWith(card: number, column: string) {
  const drag = defineTool({
    name: "drag",
    description: "Drags a card onto a column",
    params: { card: param.box({ question: "the card", image: "state.screen" }), column: param.box({ question: "the column", image: "state.screen" }) },
    run: async ({ card, column }) => {
      await browser.dragBox(card!, column!);
      return { state: await snapshotOf(browser), summary: "dragged" };
    },
  });
  const model = new ScriptedModel([
    { [TOOL_QUESTION]: "drag", "drag.card": say.box(await cardBox(card)), "drag.card?present": 0.95, "drag.column": say.box(await columnBox(column)), "drag.column?present": 0.95 },
    { [TOOL_QUESTION]: "end" },
  ]);
  return createAgent({ model, instructions: "Move the card", tools: [drag], initialState: await snapshotOf(browser), maxSteps: 3 }).run();
}

describe("kanban board: cards move by being dragged or by their dialog", () => {
  it("starts as the shared start: three columns, seven cards, nobody assigned to the first two to do", async () => {
    expect(await readBoard(browser)).toEqual(START.map(({ title, column, assignee }) => ({ title, column, assignee })));
    expect(where("Fix login")).toMatchObject({ column: "To Do", assignee: null });
  });

  it("moves a card to another column when it is dragged there, and the server has it", async () => {
    const result = await dragWith(1, "Done");
    expect(result.status).toBe("ended");
    expect(where("Fix login").column).toBe("Done");
    expect((await readBoard(browser)).find((c) => c.title === "Fix login")!.column).toBe("Done");
    expect(site.requests).toContain("POST /api/cards/1");
  });

  it("leaves a card where it is when it is dropped on its own column, and when it is only clicked", async () => {
    await dragWith(2, "To Do");
    expect(site.cards()).toEqual(START);
    expect(site.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
    await browser.clickBox(await cardBox(2)); // a click opens the dialog, it does not move anything
    expect(await browser.evaluate(() => document.getElementById("backdrop")!.classList.contains("open"), 0)).toBe(true);
    expect(site.cards()).toEqual(START);
  });

  it("opens a card's dialog on a click and assigns by a click on a name, then closes", async () => {
    const press = async (selector: string) => {
      const model = new ScriptedModel([{ [TOOL_QUESTION]: "click", "click.target": say.box((await browser.boxOf(selector))!), "click.target?present": 0.95 }, { [TOOL_QUESTION]: "end" }]);
      await createAgent({ model, instructions: "Click", tools: browserTools(browser), initialState: await browser.snapshot(), maxSteps: 3 }).run();
    };
    await press('.card[data-id="2"]');
    await press("#dialog .opts:nth-of-type(2) button:nth-child(2)"); // Sam
    expect(where("Update docs").assignee).toBe("Sam");
    await press("#close");
    expect(await browser.evaluate(() => document.getElementById("backdrop")!.classList.contains("open"), 0)).toBe(false);
    expect(changes(START, site.cards())).toEqual(['"Update docs" assigned to Sam']);
  });

  it("keeps the panel out of the picture of the board that the model sees, and out of the board's text", async () => {
    const overlay = await PageOverlay.install(browser, { title: "Board assistant" });
    await overlay.say("Looking at the board");
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "end" }]);
    await createAgent({ model, instructions: "Look", tools: browserTools(browser), initialState: await browser.snapshot(), maxSteps: 2 }).run();
    const seen = Object.values(model.requests[0]!.images ?? {})[0]!.base64;
    expect(seen).not.toBe(Buffer.from(await browser.screenshot({ everything: true })).toString("base64"));
    expect(await browser.text()).not.toContain("Looking at the board");
    // the panel's side of the page is free: no card lies under it
    expect(await browser.evaluate(() => Math.max(...[...document.querySelectorAll(".column")].map((c) => c.getBoundingClientRect().right)), 0)).toBeLessThanOrEqual(1280 - 340 - 16);
  });
});
