/**
 * The assistant: what runs behind the panel. It takes the person's instruction, operates the page that the panel lies over, and
 * reports back into the panel.
 *
 * The agent sees the page only as a screenshot without the panel (`PageOverlay` hides it from the model). Its tools are the generic
 * browser tools `click(Box)`, `type_text` and `scroll`, plus `ask_user`, a tool that holds the loop: it puts a question into the panel and the loop
 * waits until the person answers there. Jev cannot write, so what it types and what it asks are chosen from candidates that code
 * supplies: the details the assistant knows about the person (`PROFILE`) and the questions it may ask (`QUESTIONS`).
 *
 * The panel gets: a line for each step ("typed ... into the <input>"), the questions, and at the end one result line that code
 * writes from what the page says (the model writes nothing).
 */
import { createAgent, defineTool, param, readNoul, type AnyTool, type DecisionModel, type HarnessEvent, type InputProvider, type Json, type RunResult } from "../../src/index.js";
import { extractImages } from "../../src/state/images.js";
import { browserTools, snapshotOf, type BrowserSession, type PageOverlay } from "../../src/browser/index.js";

/** What the assistant knows about the person: the texts it may type, each with what it is. */
export const PROFILE: Record<string, string> = {
  "Ada Lovelace": "the full name of the person who is ordering",
  "12 Analytical Row": "the street address of the person",
  London: "the city of the person",
  "EC1A 1BB": "the postcode of the person",
};

/**
 * What the assistant may have to ask the person. Jev judges whether the instruction already settles it (`stated`, a yes/no question
 * about `instructions`); code decides: anything but a clear yes is open, and an open one is asked, in the words of `question`.
 */
export type Gap = { id: string; stated: string; question: string };
export const GAPS: Gap[] = [
  { id: "delivery", stated: "Do `instructions` say which delivery to choose, Standard or Express?", question: "Which delivery do you want, Standard or Express?" },
];

/** The questions the instruction leaves open, from one request to the model: a yes/no question per gap, and code reads "unsure" as open. */
export async function openQuestions(model: DecisionModel, instruction: string): Promise<string[]> {
  const response = await model.ask({
    state: { instructions: instruction },
    questions: Object.fromEntries(GAPS.map((g) => [g.id, { type: "noul" as const, instructions: g.stated }])),
  });
  return GAPS.filter((g) => {
    const answer = response.answers[g.id];
    if (answer?.type !== "noul") throw new Error(`no yes/no answer for ${g.id}`);
    return readNoul(answer.noul) !== true;
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

const DONE_QUESTION = "Does `state.screen` show the outcome that `instructions` ask for, such as a confirmation, and not a form that is still to be filled in or sent?";

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

/** The tools of the assistant for one instruction. */
export function assistantTools(browser: BrowserSession, model: DecisionModel, instruction: string): AnyTool[] {
  const typed = (state: Readonly<Record<string, unknown>>) => (state.typed as string[] | undefined) ?? [];
  const browsing = browserTools(browser, {
    pageText: false,
    // What is left to type: every text of the profile that is not typed yet.
    texts: (ctx) => Object.fromEntries(Object.entries(PROFILE).filter(([text]) => !typed(ctx.state).includes(text))),
    questions: {
      click:
        "the element in `state.screen` to click next for `instructions`: the first text field of the form that is still empty, " +
        "else the delivery option that `instructions` or `state.user_reply` ask for, else the button that places the order",
      clickPresent: "Is there still something to click in `state.screen` for `instructions`: a text field of the form that is empty, a delivery option that is not chosen yet, or the button that places the order?",
      typeText: "Which text belongs into the field that has the cursor in `state.screen`, going by the label of that field?",
    },
  }).filter((t) => ["click", "type_text", "scroll"].includes(t.name));

  // `type_text` remembers what it typed, so that the next step offers only what is left. Every step that changed the page ends with the "done?" judgment.
  const withProgress = browsing.map((tool) =>
    defineTool({
      ...tool,
      run: async (args, ctx) => {
        const result = await tool.run(args, ctx);
        if (!result.state?.screen) return result;
        const state: Record<string, Json | null> = { ...result.state, done: await judgeDone(model, instruction, ctx.state, result.state.screen) };
        if (tool.name === "type_text") state.typed = [...typed(ctx.state), (args as { text: string }).text];
        return { ...result, state };
      },
    }),
  );

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
  return [...withProgress, askUser, end];
}

/** What the page says once the run is over, for the line that closes it: the confirmation of an order, or what is still wrong. */
export async function resultLine(browser: BrowserSession, result: RunResult): Promise<{ ok: boolean; text: string }> {
  const text = await browser.text();
  const placed = /Order #\d+ placed\n+([^\n]+)/.exec(text);
  if (placed) return { ok: true, text: `Done: ${/Order #\d+ placed/.exec(text)![0]}. ${placed[1]}` };
  const why = result.status === "step_limit" ? "ran out of steps" : result.status === "error" ? `failed (${result.error?.message ?? "error"})` : "stopped";
  const error = (await browser.evaluate(() => document.getElementById("error")?.textContent ?? "", 0)).trim();
  return { ok: false, text: `I ${why} before the order was placed${error ? `: the page says "${error}"` : ""}.` };
}

/** Plain words for a step of the run: no coordinates, no tag names. */
const say = (summary: string) =>
  summary
    .replace(/ at \(\d+, \d+\)/, "")
    .replace("<input>", "a text field")
    .replace(/<(?:label|button|a|span)> /, "")
    .replace("the a text field", "the field")
    .replace(/^./, (c) => c.toUpperCase());

/**
 * One instruction, start to end: the agent works on the page while the panel shows the steps; the result closes it. The panel is
 * "working" meanwhile (the pointer goes through it), and free for the person again at the end.
 */
export async function carryOut(opts: AssistantOptions & { overlay: PageOverlay; instruction: string }): Promise<RunResult & { line: { ok: boolean; text: string } }> {
  const { browser, overlay } = opts;
  await overlay.working(true);
  try {
    const result = await createAgent({
      model: opts.model,
      instructions: opts.instruction,
      tools: assistantTools(browser, opts.model, opts.instruction),
      input: opts.input,
      initialState: { ...(await snapshotOf(browser, "screen", false)), typed: [], done: false, open_questions: await openQuestions(opts.model, opts.instruction) },
      maxSteps: opts.maxSteps ?? 14,
      onEvent: (e) => {
        opts.onEvent?.(e);
        if (e.type === "tool_result" && e.summary && e.tool !== "ask_user" && e.tool !== "end") void overlay.say(say(e.summary), "progress");
      },
    }).run();
    const line = await resultLine(browser, result);
    await overlay.say(line.text, line.ok ? "result" : "error");
    return { ...result, line };
  } finally {
    await overlay.working(false);
  }
}

/** What one instruction came to: the instruction, how the run ended, and the line that closed it in the panel. */
export type Handled = { instruction: string; result: RunResult; line: { ok: boolean; text: string } };

/**
 * The assistant, waiting behind the panel: for each instruction the person sends there, it operates the page (`carryOut`), then waits for
 * the next one. `stop()` ends the wait (a run in progress is aborted by the caller's model or ends by itself) and resolves once it is over.
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
