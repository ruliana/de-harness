/**
 * One run of the assistant behind the panel, with a scripted person: the instruction is typed into the panel, a question that comes
 * back is answered there, and what the board and the panel ended up as is read afterwards. The test, the runner (`main.ts`) and the demo
 * share it, so that what the PR reports is what the test checks.
 */
import type { DecisionModel, HarnessEvent } from "../../src/index.js";
import { BrowserSession, PageOverlay, type BrowserOptions, type OverlayMessage } from "../../src/browser/index.js";
import { serve, type Handled } from "./assistant.js";
import { MODEL_STYLE, START, startKanbanSite, type Card } from "./kanban-site.js";

/** What the person says, what they answer when asked, and the one card that has to be different on the board afterwards. */
export type Scenario = { name: string; instruction: string; answer?: string; expected: { title: string; column: Card["column"]; assignee: string | null } };

export const SCENARIOS: Scenario[] = [
  { name: "move-assign", instruction: "Move the 'Fix login' card to Done and assign it to Sam", expected: { title: "Fix login", column: "Done", assignee: "Sam" } },
  { name: "ask-assignee", instruction: "Move the 'Update docs' card to Doing and ask me who to assign it to", answer: "Priya", expected: { title: "Update docs", column: "Doing", assignee: "Priya" } },
  { name: "move-only", instruction: "Move the 'Review pricing page' card to Done", expected: { title: "Review pricing page", column: "Done", assignee: "Ada" } },
];

export type Outcome = {
  scenario: Scenario;
  handled: Handled | undefined;
  /** The cards as the server has them at the end. */
  cards: Card[];
  /** Everything the panel said, the person's lines included. */
  messages: OverlayMessage[];
  /** The panel as the person sees it at the end, read from the page. */
  panel: string;
  /** Set when a question reached the panel: the number of requests to the model when it was asked, and after the person had thought about it. */
  held?: { requestsWhenAsked: number; requestsAfterWaiting: number };
  /** What the person typed into the field of the panel, left over. */
  fieldLeftOver: string;
  events: HarnessEvent[];
};

export type RunOptions = {
  scenario: Scenario;
  model: DecisionModel;
  onStep?: (line: string) => void;
  /** Extra browser options (the demo records a video). */
  browser?: Partial<BrowserOptions>;
  /** Called once the page and the panel are up, before the person types (the demo adds its pointer there). */
  onReady?: (browser: BrowserSession, overlay: PageOverlay) => Promise<void>;
  /** Called when the instruction is carried out, before the browser is closed (the demo takes its last picture there). */
  onFinish?: (browser: BrowserSession, overlay: PageOverlay) => Promise<void>;
  /** Called with every event as it happens (the demo draws the box the model chose). */
  onEvent?: (e: HarnessEvent, browser: BrowserSession) => void;
  /** How the person's lines get into the panel (default: all at once; the demo types them letter by letter). */
  type?: (text: string, browser: BrowserSession, overlay: PageOverlay) => Promise<void>;
  /** How long the person thinks before answering a question; the loop must stay quiet that long. */
  thinkMs?: number;
  maxWaitMs?: number;
};

export async function runScenario(opts: RunOptions): Promise<Outcome> {
  const { scenario } = opts;
  const site = await startKanbanSite();
  const browser = await BrowserSession.launch({ allowedHosts: ["127.0.0.1"], screenshotStyle: MODEL_STYLE, ...opts.browser });
  try {
    const overlay = await PageOverlay.install(browser, { title: "Board assistant", placeholder: "Tell me what to do on the board" });
    await browser.goto(site.url);
    await opts.onReady?.(browser, overlay);
    const events: HarnessEvent[] = [];
    const requests = () => events.filter((e) => e.type === "request").length;
    const assistant = serve({
      browser,
      overlay,
      model: opts.model,
      input: overlay.input,
      onEvent: (e) => {
        events.push(e);
        if (e.type === "tool_call") opts.onStep?.(`step ${e.step}: ${e.tool}(${JSON.stringify(e.args).slice(0, 110)})`);
        opts.onEvent?.(e, browser);
      },
    });
    let held: Outcome["held"];

    await opts.type?.(scenario.instruction, browser, overlay);
    await overlay.send(scenario.instruction); // as the person does: into the panel
    const until = Date.now() + (opts.maxWaitMs ?? 20 * 60_000);
    while (assistant.handled.length === 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 200));
      if (!held && overlay.messages.some((m) => m.kind === "question")) {
        const requestsWhenAsked = requests();
        await new Promise((r) => setTimeout(r, opts.thinkMs ?? 700)); // the person thinks about it
        held = { requestsWhenAsked, requestsAfterWaiting: requests() };
        if (scenario.answer) {
          await opts.type?.(scenario.answer, browser, overlay);
          await overlay.send(scenario.answer);
        }
      }
    }
    await new Promise((r) => setTimeout(r, 100));
    await opts.onFinish?.(browser, overlay);
    const panel = await browser.evaluate(() => (document.querySelector("#de-overlay")?.shadowRoot?.querySelector(".log") as HTMLElement | null)?.innerText ?? "", 0);
    const fieldLeftOver = await browser.evaluate(() => (document.querySelector("#de-overlay")?.shadowRoot?.querySelector("input") as HTMLInputElement | null)?.value ?? "", 0);
    const outcome: Outcome = { scenario, handled: assistant.handled[0], cards: site.cards(), messages: [...overlay.messages], panel, held, fieldLeftOver, events };
    await assistant.stop();
    return outcome;
  } finally {
    await browser.close();
    await site.close();
  }
}

/** The board the scenario should leave: the start, with the one card changed (compared as a set: where a card sits within its column does not matter). */
export function expectedBoard(s: Scenario): Pick<Card, "title" | "column" | "assignee">[] {
  const rest = START.filter((c) => c.title !== s.expected.title).map(({ title, column, assignee }) => ({ title, column, assignee }));
  return [...rest, s.expected];
}

/** What is wrong with a run, in words; empty when it is right. Code reads the board and the panel, never the model. */
export function problems(o: Outcome): string[] {
  const out: string[] = [];
  const { scenario } = o;
  if (!o.handled) return ["the assistant never finished the instruction"];
  if (o.handled.result.status !== "ended") out.push(`the run ${o.handled.result.status} instead of ending on its own`);
  const key = (c: { title: string; column: string; assignee: string | null }) => `${c.column}|${c.title}|${c.assignee ?? "-"}`;
  const got = o.cards.map(key).sort();
  const want = expectedBoard(scenario).map(key).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`the board is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  const last = o.messages.at(-1);
  if (last?.kind !== "result") out.push(`the panel does not end with the result: ${last ? `[${last.kind}] ${last.text}` : "nothing"}`);
  const asked = o.messages.filter((m) => m.kind === "question").length;
  if (asked !== (scenario.answer ? 1 : 0)) out.push(`the panel asked ${asked} questions`);
  const chatter = o.messages.filter((m) => m.kind === "progress");
  if (chatter.length) out.push(`the panel narrates the steps, it should stay quiet until the result: ${chatter.map((m) => m.text).join(" | ")}`);
  if (o.fieldLeftOver !== "") out.push(`something was typed into the panel's field: "${o.fieldLeftOver}"`);
  return out;
}
