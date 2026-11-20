/**
 * Two levels, both by sight. The deciding level is this agent: its tools are the tactics of `tactics.ts`, so its `__tool__` Choice
 * is the tactic Choice that the probe measured. Its state is the screenshot, `state.done` (what happened so far, as code recorded
 * it) and `state.last_try` (what did not work): no page text, no address.
 *
 * A tactic is carried out by the navigating level: a child agent (`ctx.runAgent`) with the browser tools that tactic needs, the task and
 * a one-step goal, and three steps at most (the mode that went 5/5 in examples/storefront-browser). Afterwards code checks the result on
 * the new screenshot, with a yes/no question where a judgment is needed, and writes `done` only when the check says yes.
 *
 * Code removes tactics that make no sense at this point (`rules`) and, from `src/browser`, a tool that changed nothing three times.
 */
import { defineTool, type AnyTool, type DecisionModel, type Json } from "../../src/index.js";
import { isStuck, nextStuck, type BrowserSession } from "../../src/browser/index.js";
import { extractImages } from "../../src/state/images.js";
import { shoppingTools } from "../storefront-browser/shopping.js";
import { CHECKS, DONE, GOALS, judge, NAVIGATOR_TOOLS, TACTICS, type Judgments, type Tactic } from "./tactics.js";

export type SightOptions = {
  browser: BrowserSession;
  /** Asks the yes/no questions that check a tactic. Usually the model of the run. */
  model: DecisionModel;
  /** The task as the person said it. The navigator gets it with every goal. */
  task: string;
  /** The shop's home page, the one address the navigator's `navigate` could open (not offered: the run starts on it). */
  home: string;
  /** Steps of the navigator per tactic. Default 3. */
  navigatorSteps?: number;
  /** Remove tactics that make no sense yet (a menu entry before a menu, the value before an item). Default true. */
  rules?: boolean;
};

/** The yes/no judgments of a screenshot, as the planner state's `judgments` slot. */
export async function judgeScreen(model: DecisionModel, task: string, screen: Json): Promise<Json> {
  const { value, images } = extractImages({ screen });
  return (await judge(model, task, value.screen as string, images)) as unknown as Json;
}

/** What the run found, outside the state: the model never sees it. */
export type Found = { price?: string };

/**
 * The navigator does one thing: its run ends by itself after its first action that did something (a target it could not find is
 * not an action, so it may look again). Asking the model "is it done?" after each of its own actions was the weak judgment.
 */
const oneAction = (tool: AnyTool): AnyTool => ({
  ...tool,
  run: async (args, ctx) => {
    const result = await tool.run(args, ctx);
    return result.state ? { ...result, end: true } : result;
  },
});
/** A built-in `end` that is never offered, so that the navigator cannot stop before it acted. */
const neverEnd = defineTool({ name: "end", description: "Stops.", available: () => false, run: () => ({ end: true }) });

const doneOf = (state: Readonly<Record<string, unknown>>) => (state.done as string[] | undefined) ?? [];

/** Does it make sense to do this now? Code decides, from what is done. */
function sensible(tactic: Tactic, state: Readonly<Record<string, unknown>>): boolean {
  const done = doneOf(state);
  switch (tactic) {
    case "pick_menu_entry":
      return done.at(-1) === DONE.open_menu;
    case "select_option":
      return done.includes(DONE.click_item);
    case "read_value":
      return done.includes(DONE.click_item) && !done.includes(DONE.read_value);
    case "end":
      return done.includes(DONE.read_value);
    default:
      return true;
  }
}

export function sightTools(opts: SightOptions): { tools: AnyTool[]; found: Found } {
  const { browser } = opts;
  const found: Found = {};
  const navigator = shoppingTools(browser, { home: opts.home, pageText: false });
  const state0 = async () => {
    const s = await browser.snapshot();
    return { screen: s.screen!, page: { scroll: (s.page as { scroll: Json }).scroll } };
  };

  const tactic = (name: Tactic): AnyTool => {
    if (name === "end") {
      return defineTool({
        name,
        description: TACTICS.end,
        available: ({ state }) => state.screen !== undefined && (opts.rules === false || sensible(name, state)) && !isStuck(state.stuck, name, 1),
        run: () => ({ end: true, output: found, summary: "ended" }),
      });
    }
    return defineTool({
      name,
      description: TACTICS[name],
      available: ({ state }) => state.screen !== undefined && (opts.rules === false || sensible(name, state)) && !isStuck(state.stuck, name, 1),
      run: async (_args, ctx) => {
        const child = await ctx.runAgent({
          instructions: `${opts.task} ${GOALS[name]}`,
          tools: [...navigator.filter((t) => NAVIGATOR_TOOLS[name].includes(t.name)).map(oneAction), neverEnd],
          initialState: await state0(),
          maxSteps: opts.navigatorSteps ?? 3,
        });
        const after = (await browser.snapshot()).screen!;
        const stuck = nextStuck(ctx.state.stuck, name, ctx.state.screen, after);

        // Check on the new screenshot. Code decides what the answers mean.
        const check = CHECKS[name];
        const judgments = await judgeScreen(opts.model, opts.task, after as Json);
        let worked: boolean | "unsure" = true;
        if (name === "read_value") {
          const price = (child.state.price as { text?: string } | undefined)?.text;
          if (price) found.price = price;
          worked = price !== undefined;
        } else {
          if (check.changed && stuck !== null) worked = false;
          if (worked === true && check.holds) worked = check.holds(judgments as unknown as Judgments);
        }
        const result = { screen: after as Json, judgments, stuck: check.changed ? stuck : null } as Record<string, Json | null>;
        if (worked === true) {
          result.done = [...doneOf(ctx.state), DONE[name]];
          result.last_try = null;
        } else {
          result.last_try = `Tried this, and the screenshot does not show that it worked: ${DONE[name]}`;
        }
        return { state: result, summary: `${name}: the navigator ${child.status === "ended" ? "finished" : child.status}, ${worked === true ? "checked: done" : "checked: not done"}` };
      },
    });
  };

  return { tools: (Object.keys(TACTICS) as Tactic[]).map(tactic), found };
}
