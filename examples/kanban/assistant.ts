/**
 * The assistant: what runs behind the panel over the Kanban board. It takes the person's instruction ("Move the 'Fix login' card to Done
 * and assign it to Sam"), operates the board that the panel lies beside, and reports back into the panel.
 *
 * The agent sees the board only as a screenshot without the panel (`PageOverlay` hides it from the model). Its tools: `click` (a card, which
 * opens its dialog; a button in the dialog), `drag` (a card onto a column: two Boxes, which card and which column), `ask_user` (holds the
 * loop: it puts a question into the panel and waits for the answer there) and `end`. Jev cannot write, so a question the assistant asks
 * comes from a list that code supplies (`GAPS`). The agent works at full speed and the panel stays quiet while it does (the person watches the
 * board, where every move is animated); the one line it writes is the result, written by code from what the board did, not by the model.
 */
import { createAgent, defineTool, param, readNoul, type AnyTool, type DecisionModel, type HarnessEvent, type InputProvider, type Json, type RunResult } from "../../src/index.js";
import { extractImages } from "../../src/state/images.js";
import { browserTools, snapshotOf, type BrowserSession, type PageOverlay } from "../../src/browser/index.js";

/** What one card of the board says, as the page shows it. */
export type Shown = { title: string; column: string; assignee: string | null };

/** The cards of the board as the page shows them (code reads the page; the model never sees this). */
export async function readBoard(browser: BrowserSession): Promise<Shown[]> {
  return await browser.evaluate(
    () =>
      [...document.querySelectorAll<HTMLElement>(".card")].map((card) => {
        const who = card.querySelector(".who")?.textContent?.trim() ?? "";
        const assignee = card.querySelector(".who")?.classList.contains("none") ? null : who.slice(1); // the disc holds the initial
        return { title: card.querySelector("b")?.textContent ?? "", column: card.closest<HTMLElement>(".column")?.dataset.column ?? "", assignee };
      }),
    0,
  );
}

/** Is a card's dialog open? */
export const dialogOpen = (browser: BrowserSession): Promise<boolean> => browser.evaluate(() => document.getElementById("backdrop")?.classList.contains("open") ?? false, 0);

/** What changed between two readings of the board, in words: `"Fix login" is now in Done, assigned to Sam`. */
export function changes(before: Shown[], after: Shown[]): string[] {
  const out: string[] = [];
  for (const card of after) {
    const was = before.find((c) => c.title === card.title);
    if (!was) continue;
    const parts: string[] = [];
    if (was.column !== card.column) parts.push(`moved from ${was.column} to ${card.column}`);
    if (was.assignee !== card.assignee) parts.push(card.assignee ? `assigned to ${card.assignee}` : "left unassigned");
    if (parts.length) out.push(`"${card.title}" ${parts.join(", ")}`);
  }
  return out;
}

/**
 * What the assistant may have to ask the person. Jev judges whether the instruction leaves it open (`open`, a yes/no question about
 * `instructions`); code decides: only a clear yes is asked, in the words of `question`. (A judgment that is unsure does not make
 * the assistant ask: asking the person what they already said is worse than a run that comes out wrong, which the board shows.)
 */
export type Gap = { id: string; open: string; question: string };
export const GAPS: Gap[] = [
  {
    id: "assignee",
    open: "Do `instructions` tell the assistant to ask the person who a card is to be assigned to, or to assign it to someone without saying who?",
    question: "Who should I assign it to: Ada, Sam, Priya or Lee?",
  },
];

/** The questions the instruction leaves open, from one request to the model: a yes/no question per gap. */
export async function openQuestions(model: DecisionModel, instruction: string): Promise<string[]> {
  const response = await model.ask({
    state: { instructions: instruction },
    questions: Object.fromEntries(GAPS.map((g) => [g.id, { type: "noul" as const, instructions: g.open }])),
  });
  return GAPS.filter((g) => {
    const answer = response.answers[g.id];
    if (answer?.type !== "noul") throw new Error(`no yes/no answer for ${g.id}`);
    return readNoul(answer.noul) === true;
  }).map((g) => g.question);
}

export type AssistantOptions = {
  browser: BrowserSession;
  model: DecisionModel;
  /** Where `ask_user` puts its question and gets the answer: the panel's `input`, or any other provider. */
  input: InputProvider;
  maxSteps?: number;
  /** Every event of the run (steps, requests, answers), for a runner that wants to print them. */
  onEvent?: (event: HarnessEvent) => void;
};

const DONE_QUESTION =
  "Does `state.screen` show the board as `instructions` ask for it? The card that `instructions` talk about must be in the column they ask for. " +
  "If `instructions` name an assignee, or say to ask the person who, it must have that person's name under its title: the one in `instructions`, or the one in `state.user_reply`, the person's answer. No card dialog may be open.";

/**
 * Has everything been done, by the new screenshot? One yes/no question to the model, asked after every step that changed the page.
 * Code decides what the answer means: only a clear yes makes `end` available (see `assistantTools`).
 */
export async function judgeDone(model: DecisionModel, instruction: string, state: Readonly<Record<string, unknown>>, screen: Json): Promise<boolean> {
  const { value, images } = extractImages({ screen });
  const response = await model.ask({ state: { instructions: instruction, state: { screen: value.screen, user_reply: state.user_reply ?? null }, previous_actions: [] }, questions: { done: { type: "noul", instructions: DONE_QUESTION } }, images });
  const answer = response.answers.done;
  if (answer?.type !== "noul") throw new Error("no yes/no answer for done");
  return readNoul(answer.noul) === true;
}

const CLICK =
  "the element in `state.screen` to click next to give the card that `instructions` talk about the assignee that `instructions` name, or the one in `state.user_reply`, the person's answer. " +
  "When no card dialog is open: that card. When a card dialog is open: the button with the name of that assignee, " +
  "unless that button is already dark, and then the Close button";
const CLICK_PRESENT = "Is the card that `instructions` talk about visible in `state.screen`, or is a card dialog open?";
const DRAG_CARD = "the card in `state.screen` that `instructions` say to move to another column";
const DRAG_CARD_PRESENT = "Is the card that `instructions` say to move visible in `state.screen`, in a column other than the one it is to go to?";
const DRAG_COLUMN = "the whole column in `state.screen` that `instructions` say the card is to go to";
const DRAG_COLUMN_PRESENT = "Is the column that `instructions` say the card is to go to visible in `state.screen`?";

/** The tools of the assistant for one instruction. */
export function assistantTools(browser: BrowserSession, model: DecisionModel, instruction: string): AnyTool[] {
  const browsing = browserTools(browser, { pageText: false, questions: { click: CLICK, clickPresent: CLICK_PRESENT } }).filter((t) => t.name === "click");

  /** Plain words for what a click did: a button by its name, a card by its title (`at (x, y)` in the summary of `click` says where it was clicked). */
  const clickLine = async (summary: string): Promise<string> => {
    const m = /^clicked <(\w+)> "([^"]*)" at \((\d+), (\d+)\)/.exec(summary);
    if (!m) return summary;
    if (m[1] === "button") return `Pressed "${m[2]}"`;
    // The card whose rectangle holds the point (a dialog may lie over it by now, so elementFromPoint would find that).
    const title = await browser.evaluate(
      ([x, y]) => {
        const card = [...document.querySelectorAll(".card")].find((c) => {
          const r = c.getBoundingClientRect();
          return x! >= r.left && x! <= r.right && y! >= r.top && y! <= r.bottom;
        });
        return card?.querySelector("b")?.textContent ?? null;
      },
      [Number(m[3]), Number(m[4])] as const,
    );
    return title ? `Opened the card "${title}"` : "Clicked on the board";
  };

  // Every step that changed the page ends with the "done?" judgment.
  const withProgress = browsing.map((tool) =>
    defineTool({
      ...tool,
      run: async (args, ctx) => {
        const result = await tool.run(args, ctx);
        if (!result.state?.screen) return result;
        return { ...result, summary: result.summary ? await clickLine(result.summary) : result.summary, state: { ...result.state, done: await judgeDone(model, instruction, ctx.state, result.state.screen) } };
      },
    }),
  );

  const drag = defineTool({
    name: "drag",
    description: "Drags one card of the board in `state.screen` onto a column, which moves the card to that column.",
    params: {
      card: param.box({ question: DRAG_CARD, image: "state.screen", present: DRAG_CARD_PRESENT }),
      column: param.box({ question: DRAG_COLUMN, image: "state.screen", present: DRAG_COLUMN_PRESENT }),
    },
    run: async ({ card, column }, ctx) => {
      if (!card || !column) return { summary: "found nothing to drag: the card or the column is not visible in the screenshot" };
      const before = await readBoard(browser);
      await browser.dragBox(card, column);
      const state = await snapshotOf(browser, "screen", false);
      const moved = changes(before, await readBoard(browser));
      const summary = moved.length ? `Dragged: ${moved.join("; ")}` : "Dragged a card, but the board looks the same";
      return { state: { ...state, done: await judgeDone(model, instruction, ctx.state, state.screen!) }, summary };
    },
  });

  // Only when the screenshot shows that everything is done: a model that stops by itself, early, is not taken at its word.
  const end = defineTool({
    name: "end",
    description: "Stops, because everything that `instructions` ask for has been done, as `state.screen` shows.",
    available: ({ state }) => state.done === true,
    run: () => ({ end: true, summary: "ended" }),
  });

  const askUser = defineTool({
    name: "ask_user",
    description: "Asks the person one of the open questions in `state.open_questions` in the assistant panel and waits for their answer, which is saved in `state.user_reply`.",
    available: ({ state }) => ((state.open_questions as string[] | undefined) ?? []).length > 0,
    params: {
      question: param.choice({
        question: "Which of the open questions in `state.open_questions` should be asked of the person now?",
        options: (ctx) => Object.fromEntries(((ctx.state.open_questions as string[] | undefined) ?? []).map((q) => [q, "Still open: the person has not answered it"])),
      }),
    },
    run: async ({ question }, ctx) => {
      const reply = await ctx.input.ask(question as string);
      const open = ((ctx.state.open_questions as string[] | undefined) ?? []).filter((q) => q !== question);
      return { state: { user_reply: reply, open_questions: open }, summary: `asked "${question}" and the person replied` };
    },
  });
  return [...withProgress, drag, askUser, end];
}

/** The line that closes a run, written from what the board did: the changes, or that nothing changed. */
export function resultLine(before: Shown[], after: Shown[], result: RunResult, dialog: boolean): { ok: boolean; text: string } {
  const done = changes(before, after);
  if (result.status === "ended" && done.length) return { ok: true, text: `Done: ${done.join("; ")}.` };
  const why = result.status === "step_limit" ? "ran out of steps" : result.status === "error" ? `failed (${result.error?.message ?? "error"})` : "stopped";
  return { ok: false, text: `I ${why}${done.length ? ` after ${done.join("; ")}` : " and left the board as it was"}${dialog ? ", with a card still open" : ""}.` };
}

/** One instruction, start to end: the agent works on the board while the panel stays quiet (a question aside); the result closes it. */
export async function carryOut(opts: AssistantOptions & { overlay: PageOverlay; instruction: string }): Promise<RunResult & { line: { ok: boolean; text: string } }> {
  const { browser, overlay } = opts;
  await overlay.working(true);
  try {
    const before = await readBoard(browser);
    const result = await createAgent({
      model: opts.model,
      instructions: opts.instruction,
      tools: assistantTools(browser, opts.model, opts.instruction),
      input: opts.input,
      initialState: { ...(await snapshotOf(browser, "screen", false)), done: false, user_reply: null, open_questions: await openQuestions(opts.model, opts.instruction) },
      maxSteps: opts.maxSteps ?? 10,
      onEvent: (e) => opts.onEvent?.(e),
    }).run();
    const line = resultLine(before, await readBoard(browser), result, await dialogOpen(browser));
    await overlay.say(line.text, line.ok ? "result" : "error");
    return { ...result, line };
  } finally {
    await overlay.working(false);
  }
}

/** What one instruction came to: the instruction, how the run ended, and the line that closed it in the panel. */
export type Handled = { instruction: string; result: RunResult; line: { ok: boolean; text: string } };

/**
 * The assistant, waiting behind the panel: for each instruction the person sends there, it operates the board (`carryOut`), then waits
 * for the next one. `stop()` ends the wait and resolves once it is over.
 */
export function serve(opts: AssistantOptions & { overlay: PageOverlay }): { handled: Handled[]; stop(): Promise<void> } {
  const handled: Handled[] = [];
  const stopping = new AbortController();
  const loop = (async () => {
    for (;;) {
      let instruction: string;
      try {
        instruction = await opts.overlay.nextInstruction(stopping.signal);
      } catch {
        return;
      }
      const { line, ...result } = await carryOut({ ...opts, instruction });
      handled.push({ instruction, result: result as RunResult, line });
    }
  })();
  return {
    handled,
    stop: async () => {
      stopping.abort();
      await loop;
    },
  };
}
