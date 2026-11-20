/**
 * The two levels, mechanics forced with ScriptedModel against the look-alike shop in a real headless Chromium: what the deciding level
 * is offered, what code does with a tactic that did not work, and that the navigating level does one thing and stops.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedModel, TOOL_QUESTION, say, type BrowserSession, type DecisionRequest } from "../../../src/index.js";
import { launchFixture, startFixture } from "../../../examples/storefront-browser/run.js";
import type { ShopSite } from "../../../examples/storefront-browser/shop-site.js";
import { runBySight } from "../../../examples/storefront-by-sight/run.js";

let site: ShopSite;
let browser: BrowserSession;
beforeAll(async () => {
  site = await startFixture();
  browser = await launchFixture();
});
afterAll(async () => {
  await browser?.close();
  await site?.close();
});

/** The deciding level's request offers tactics; `close_overlay` is the one that no rule removes. */
const isPlanner = (r: DecisionRequest) => "close_overlay" in ((r.questions[TOOL_QUESTION] as { criteria: Record<string, string> } | undefined)?.criteria ?? {});
const offered = (r: DecisionRequest) => Object.keys((r.questions[TOOL_QUESTION] as { criteria: Record<string, string> }).criteria).sort();
/** Where nothing reacts to the pointer: the bottom right corner of the home page. */
const NOTHING = { top: 0.9, bottom: 0.95, left: 0.9, right: 0.95 };

/** A script: the deciding level picks `tactics` in turn; the navigating level points at nothing; the judgments are all "unsure". */
function script(tactics: string[]) {
  let step = 0;
  return (request: DecisionRequest): Record<string, string | number | ReturnType<typeof say.box>> => {
    if (isPlanner(request)) return { [TOOL_QUESTION]: tactics[Math.min(step++, tactics.length - 1)]! };
    if (request.questions[TOOL_QUESTION]) return { [TOOL_QUESTION]: "hover", "hover.target": say.box(NOTHING), "hover.target?present": 0.95 };
    return {};
  };
}

describe("storefront by sight: mechanics", () => {
  it("offers only tactics that make sense: no menu entry before a menu, no option or value before an item, no end before a value", async () => {
    const model = new ScriptedModel([script(["scroll"])]);
    await runBySight({ kind: "fixture", browser, home: `${site.url}/`, model, maxSteps: 1 });
    const first = model.requests.find(isPlanner)!;
    expect(offered(first)).toEqual(["click_item", "close_overlay", "go_back", "open_menu", "scroll"]);
  });

  it("does not record a tactic that did not work, tells the deciding level so, and does not offer it again on the same screenshot", async () => {
    const model = new ScriptedModel([script(["open_menu", "scroll"])]);
    const result = (await runBySight({ kind: "fixture", browser, home: `${site.url}/`, model, maxSteps: 2 })).result;
    const planner = model.requests.filter(isPlanner);
    const second = planner[1]!.state as { state: { done: string[]; last_try?: string; stuck?: Record<string, number> } };
    expect(second.state.done).toEqual(["opened the home page of the web site"]); // the failed tactic is not in it
    expect(second.state.last_try).toMatch(/did not work|does not show that it worked/);
    expect(second.state.stuck).toEqual({ open_menu: 1 });
    expect(offered(planner[1]!)).not.toContain("open_menu"); // same screenshot, same failure: not again
    expect(result.steps).toHaveLength(2);
  });

  it("starts the navigating level with the task and one step to do, and lets it make one move", async () => {
    const model = new ScriptedModel([script(["open_menu"])]);
    const outcome = await runBySight({ kind: "fixture", browser, home: `${site.url}/`, model, maxSteps: 1 });
    const children = outcome.result.events.filter((e) => e.type === "child");
    const moves = children.flatMap((e) => (e.type === "child" && e.event.type === "tool_call" ? [e.event.tool] : []));
    expect(moves).toEqual(["hover"]); // one move, then the navigator stops by itself
    const navigator = model.requests.find((r) => !isPlanner(r) && r.questions[TOOL_QUESTION])!;
    expect((navigator.state as { instructions: string }).instructions).toMatch(/blue sweatshirt.*Point the mouse at the entry in the row of menus/);
    expect(offered(navigator)).toEqual(["hover"]); // only what the tactic needs, and no way to stop before moving
  });
});
