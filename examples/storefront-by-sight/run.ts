/**
 * One run of the plain task, "go to the shop, find a blue sweatshirt, select size large, and get the price", by the two levels that
 * look only at screenshots. The test and the runner (`main.ts`) share it, and so does the check of the result with the one-sentence
 * run of examples/storefront-browser (`pageFacts`, `problems`).
 */
import { createAgent, type DecisionModel } from "../../src/index.js";
import type { BrowserSession } from "../../src/browser/index.js";
import { pageFacts, type Outcome, type SiteKind } from "../storefront-browser/run.js";
import { judgeScreen, sightTools } from "./planner.js";
import { DONE_OPENED, shopTask, sightTask, type SightTask } from "./tactics.js";

export { launchFixture, launchLive, startFixture, FIXTURE_PORT, LIVE, problems } from "../storefront-browser/run.js";

export type SightRun = { kind: SiteKind; model: DecisionModel; browser: BrowserSession; home: string; task?: string | SightTask; maxSteps?: number; navigatorSteps?: number; rules?: boolean; onStep?: (line: string) => void };

/** Open the shop and run the deciding level. At most `maxSteps` (default 10) tactics. */
export async function runBySight(opts: SightRun): Promise<Outcome & { found: string | null }> {
  const task = sightTask(opts.task ?? shopTask(opts.kind === "live" ? "aloyoga.com" : "the shop", "a blue sweatshirt", "large"));
  const { tools, found } = sightTools({ browser: opts.browser, model: opts.model, task, home: opts.home, navigatorSteps: opts.navigatorSteps, rules: opts.rules });
  await opts.browser.goto(opts.home);
  const trail: string[] = [];
  const screen = (await opts.browser.snapshot()).screen!;
  const result = await createAgent({
    model: opts.model,
    instructions: task.text,
    tools,
    initialState: { screen, judgments: await judgeScreen(opts.model, task, screen), done: [DONE_OPENED] },
    previousActions: 0,
    maxSteps: opts.maxSteps ?? 10,
    onEvent: (e) => {
      if (e.type === "tool_result") {
        trail.push(`${e.tool}${e.summary ? ` -> ${e.summary}` : ""}`);
        opts.onStep?.(`step ${e.step}: ${trail.at(-1)}`);
      }
      // the navigator's steps, one level down
      if (e.type === "child" && e.event.type === "tool_call") opts.onStep?.(`    navigator: ${e.event.tool}${Object.keys(e.event.args).length ? `(${JSON.stringify(e.event.args).slice(0, 80)})` : ""}`);
    },
  }).run();
  return { result, read: found.price ?? null, found: found.price ?? null, facts: await pageFacts(opts.browser, opts.kind), trail };
}
