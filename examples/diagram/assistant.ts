/**
 * The assistant: what runs behind the panel beside the diagram. It takes the person's instruction ("Draw a login flow with 3 steps and a
 * failure branch"), edits the diagram, and reports back into the panel.
 *
 * The state of the agent is the diagram as Mermaid text (`state.diagram`), and a picture of it as Mermaid draws it (`state.screen`). Every tool
 * reads the text, changes it and puts the new text and the new picture into the state. Its tools: `add_node`, `remove_node`, `rename_node`,
 * `connect`, `disconnect`, `relabel_edge`, `ask_user` (holds the loop: a question goes into the panel and the loop waits for the answer there) and
 * `end`. They come and go with the diagram: nothing can be removed, renamed or connected before there are nodes, and nothing disconnected or
 * relabelled before there are arrows.
 *
 * Jev cannot write, so every label the agent puts into the diagram is chosen from candidates that code supplies: a catalog of common steps
 * (`STEPS`), a catalog of arrow labels (`ARROWS`) and the texts in quotes in the instruction (`'Package app'`). The lines in the panel are
 * written by code from what the diagram did, not by the model.
 */
import { createAgent, defineTool, param, readNoul, type AnyTool, type DecisionModel, type HarnessEvent, type InputProvider, type Options, type RunResult } from "../../src/index.js";
import { extractImages } from "../../src/state/images.js";
import { snapshotOf, type BrowserSession, type PageOverlay } from "../../src/browser/index.js";
import { addNode, connect, disconnect, edgeKey, EMPTY, parse, relabelEdge, removeNode, renameNode, toMermaid, type Graph } from "./graph.js";

/** Steps that a diagram of a common flow is made of (the agent may add any of them, and any text in quotes in the instruction). */
export const STEPS = [
  // signing in
  "Enter credentials", "Check password", "Show dashboard", "Show error message", "Send verification code", "Verify code", "Reset password", "Lock account",
  // signing up
  "Fill in sign-up form", "Validate email", "Create account", "Send welcome email",
  // buying
  "Add to cart", "Enter payment details", "Charge card", "Confirm order", "Payment failed", "Retry payment", "Cancel order",
  // shipping code
  "Push code", "Run tests", "Build image", "Deploy", "Roll back", "Notify team",
  // support
  "Open ticket", "Triage", "Assign agent", "Escalate", "Resolve ticket", "Close ticket",
  // reviewing
  "Review", "Approve", "Reject",
];
/** Labels that an arrow may carry (and any text in quotes in the instruction). */
export const ARROWS = ["Yes", "No", "Valid", "Invalid", "Success", "Failure", "Pass", "Fail", "Retry", "Approved", "Rejected"];

/** The texts in quotes in the instruction: names that the person gives, which Jev cannot write but can choose. */
export function quoted(instruction: string): string[] {
  const out = [...instruction.matchAll(/(?<![\p{L}\p{N}])['"‘“]([^'"‘’“”]{1,40})['"’”]/gu)].map((m) => m[1]!.trim());
  return [...new Set(out)];
}

const graphOf = (state: Readonly<Record<string, unknown>>): Graph => parse(String(state.diagram ?? EMPTY));
/** Availability that never throws: a state without a readable diagram offers no editing tool. */
const shows = (state: Readonly<Record<string, unknown>>, ok: (g: Graph) => boolean): boolean => {
  try {
    return ok(graphOf(state));
  } catch {
    return false;
  }
};
const unique = (xs: string[]): string[] => [...new Set(xs)];

/** What the diagram looks like now: the Mermaid text that the page shows. */
export async function shown(browser: BrowserSession): Promise<string> {
  return await browser.evaluate(() => document.querySelector("#source code")?.textContent ?? "", 0);
}
/** What the page drew: the labels of its nodes and of its arrows, read from the picture it made (not from the text it was given). */
export async function drawn(browser: BrowserSession): Promise<{ nodes: string[]; edgeLabels: string[]; error: string | null }> {
  return await browser.evaluate(
    () => {
      const texts = (selector: string) => [...document.querySelectorAll(selector)].map((e) => (e.textContent ?? "").trim().replace(/\s+/g, " "));
      return { nodes: texts("#canvas g.node"), edgeLabels: texts("#canvas g.edgeLabel").filter(Boolean), error: document.querySelector("#canvas .error")?.textContent ?? null };
    },
    0,
  );
}
/** Have the page draw `text`. A text that Mermaid cannot read throws: the diagram is never left half drawn without anyone knowing. */
export async function draw(browser: BrowserSession, text: string): Promise<void> {
  const result = await browser.evaluate((t) => (window as unknown as { drawDiagram(t: string): Promise<{ ok: boolean; error?: string }> }).drawDiagram(t), text);
  if (!result.ok) throw new Error(`Mermaid cannot draw this diagram: ${result.error}`);
}

/** What changed between two diagrams, in words. */
export function changes(before: Graph, after: Graph): string[] {
  const out: string[] = [];
  for (const n of after.nodes) {
    const was = before.nodes.find((b) => b.id === n.id);
    if (!was) out.push(`added "${n.label}"`);
    else if (was.label !== n.label) out.push(`renamed "${was.label}" to "${n.label}"`);
  }
  for (const n of before.nodes) if (!after.nodes.some((a) => a.id === n.id)) out.push(`removed "${n.label}"`);
  // An arrow is the same arrow when it joins the same two nodes; the arrows of a removed node go with it and are not counted.
  const key = (e: Graph["edges"][number]) => `${e.from}>${e.to}`;
  const was = new Map(before.edges.map((e) => [key(e), e]));
  const now = new Map(after.edges.map((e) => [key(e), e]));
  const added = after.edges.filter((e) => !was.has(key(e)));
  const gone = before.edges.filter((e) => !now.has(key(e)) && after.nodes.some((n) => n.id === e.from) && after.nodes.some((n) => n.id === e.to));
  const relabelled = after.edges.filter((e) => was.has(key(e)) && was.get(key(e))!.label !== e.label);
  if (added.length) out.push(`${added.length} new ${added.length === 1 ? "arrow" : "arrows"}`);
  if (gone.length) out.push(`${gone.length} ${gone.length === 1 ? "arrow" : "arrows"} taken out`);
  if (relabelled.length) out.push(`${relabelled.length} ${relabelled.length === 1 ? "arrow" : "arrows"} relabelled`);
  return out;
}

/**
 * What the assistant may have to ask the person. Jev judges whether the instruction leaves it open (`open`, a yes/no question about
 * `instructions`); code decides: only a clear yes is asked, in the words of `question`.
 */
export type Gap = { id: string; open: string; question: string };
export const GAPS: Gap[] = [
  {
    id: "failure",
    open: "Do `instructions` tell the assistant to ask the person where a failure, such as a failed login, is to lead?",
    question: "Where should a failure lead: back to the first step, or to an error message?",
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
  "Is the diagram in `state.diagram`, which `state.screen` shows drawn, exactly what `instructions` ask for? " +
  "Every step that `instructions` ask to add must be in it, every step they ask to remove must be gone, and every rename and arrow label they ask for must be there. " +
  "If `instructions` give a number of steps, the diagram has that many, besides the steps of a branch that they ask for. A branch is a step with two arrows leaving it. " +
  "The steps are joined by arrows in the order of the flow, and no step is left without an arrow. " +
  "A step that `instructions` put between two others sits on the way from one to the other, so the arrow that joined those two directly is gone. " +
  "If `instructions` ask for the person's answer, the diagram follows `state.user_reply`.";

/** Has everything been done, by the new diagram? One yes/no question to the model, asked after every step that changed it. Code decides what the answer means: only a clear yes makes `end` available. */
export async function judgeDone(model: DecisionModel, instruction: string, state: Readonly<Record<string, unknown>>, diagram: string, screen: unknown): Promise<boolean> {
  const { value, images } = extractImages({ screen });
  const response = await model.ask({ state: { instructions: instruction, state: { diagram, screen: value.screen, user_reply: state.user_reply ?? null }, previous_actions: [] }, questions: { done: { type: "noul", instructions: DONE_QUESTION } }, images });
  const answer = response.answers.done;
  if (answer?.type !== "noul") throw new Error("no yes/no answer for done");
  return readNoul(answer.noul) === true;
}

const nodeQuestion = (what: string) => `Which node of the diagram in \`state.diagram\` do \`instructions\` say to ${what}?`;
const edgeQuestion = (what: string) => `Which arrow of the diagram in \`state.diagram\` do \`instructions\` say to ${what}? An arrow is written \`from --label--> to\`.`;

/** The tools of the assistant for one instruction. */
export function assistantTools(browser: BrowserSession, model: DecisionModel, instruction: string): AnyTool[] {
  const names = unique([...quoted(instruction), ...STEPS]);
  const arrows = unique([...quoted(instruction), ...ARROWS]);
  const labelsOf = (state: Readonly<Record<string, unknown>>) => (shows(state, () => true) ? graphOf(state).nodes.map((n) => n.label) : []);
  const edgeOptions = (state: Readonly<Record<string, unknown>>): Options => {
    const g = graphOf(state);
    return g.edges.map((e) => edgeKey(g, e));
  };

  /** Draw the new text, take the picture and judge whether the diagram is done. The text is the state. */
  const result = async (g: Graph, summary: string, ctx: { state: Readonly<Record<string, unknown>> }) => {
    const text = toMermaid(g);
    await draw(browser, text);
    const snap = await snapshotOf(browser, "screen", false);
    return { state: { diagram: text, screen: snap.screen!, done: await judgeDone(model, instruction, ctx.state, text, snap.screen) }, summary };
  };
  /** A tool that cannot do what it was asked leaves the diagram alone and says so (the state would not change, and neither would the picture). */
  const attempt = async (make: () => Graph, summary: string, ctx: { state: Readonly<Record<string, unknown>> }) => {
    let next: Graph;
    try {
      next = make();
    } catch (e) {
      return { summary: `could not do it: ${e instanceof Error ? e.message.replace(/^diagram: /, "") : String(e)}` };
    }
    return result(next, summary, ctx);
  };

  const add = defineTool({
    name: "add_node",
    description: "Adds one node to the diagram in `state.diagram`, a step of the flow that `instructions` ask for, which the diagram does not have yet.",
    params: {
      label: param.choice({
        question: "Which step that `instructions` ask for is still missing from the diagram in `state.diagram`? If more than one is missing, the one that comes first in the flow.",
        options: (ctx) => names.filter((n) => !labelsOf(ctx.state).includes(n)),
      }),
    },
    run: ({ label }, ctx) => attempt(() => addNode(graphOf(ctx.state), label), `Added the step "${label}"`, ctx),
  });

  const remove = defineTool({
    name: "remove_node",
    description: "Removes one node, with all its arrows, from the diagram in `state.diagram`.",
    available: ({ state }) => shows(state, (g) => g.nodes.length > 0),
    params: { node: param.choice({ question: nodeQuestion("remove"), options: (ctx) => labelsOf(ctx.state) }) },
    run: ({ node }, ctx) => attempt(() => removeNode(graphOf(ctx.state), node), `Removed the step "${node}"`, ctx),
  });

  const rename = defineTool({
    name: "rename_node",
    description: "Gives one node of the diagram in `state.diagram` another label.",
    available: ({ state }) => shows(state, (g) => g.nodes.length > 0),
    params: {
      node: param.choice({ question: nodeQuestion("rename"), options: (ctx) => labelsOf(ctx.state) }),
      label: param.choice({
        question: "What do `instructions` say that node is to be called now?",
        options: (ctx) => names.filter((n) => !labelsOf(ctx.state).includes(n)),
      }),
    },
    run: ({ node, label }, ctx) => attempt(() => renameNode(graphOf(ctx.state), node, label), `Renamed "${node}" to "${label}"`, ctx),
  });

  /** The arrows that could still be drawn: every pair of different nodes that is not joined in that direction yet, written `from --> to`. */
  const missing = (state: Readonly<Record<string, unknown>>): string[] => {
    const g = graphOf(state);
    return g.nodes.flatMap((a) => g.nodes.filter((b) => b !== a && !g.edges.some((e) => e.from === a.id && e.to === b.id)).map((b) => `${a.label} --> ${b.label}`));
  };
  const join = defineTool({
    name: "connect",
    description: "Draws one new arrow in the diagram in `state.diagram`, from one node to another, with a label if `instructions` give it one.",
    available: ({ state }) => shows(state, (g) => missing(state).length > 0 && g.nodes.length >= 2),
    params: {
      arrow: param.choice({ question: "Which arrow that `instructions` ask for is still missing from the diagram in `state.diagram`? If more than one is missing, the one that comes first in the flow. An arrow is written `from --> to`.", options: (ctx) => missing(ctx.state) }),
      label: param.choice({
        question: "Which label do `instructions` give that arrow?",
        options: arrows,
        optional: { stated: "Do `instructions` give a label to that arrow, such as Yes, No, Valid, Invalid or a text in quotes?" },
      }),
    },
    run: ({ arrow, label }, ctx) => {
      const [from, to] = arrow.split(" --> ") as [string, string];
      return attempt(() => connect(graphOf(ctx.state), from, to, label ?? null), `Connected "${from}" to "${to}"${label ? ` as "${label}"` : ""}`, ctx);
    },
  });

  const cut = defineTool({
    name: "disconnect",
    description: "Takes one arrow out of the diagram in `state.diagram`; the nodes stay.",
    available: ({ state }) => shows(state, (g) => g.edges.length > 0),
    params: { edge: param.choice({ question: edgeQuestion("take out, or to replace with another"), options: (ctx) => edgeOptions(ctx.state) }) },
    run: ({ edge }, ctx) => attempt(() => disconnect(graphOf(ctx.state), edge), `Took out the arrow ${edge}`, ctx),
  });

  const relabel = defineTool({
    name: "relabel_edge",
    description: "Gives one arrow of the diagram in `state.diagram` another label.",
    available: ({ state }) => shows(state, (g) => g.edges.length > 0),
    params: {
      edge: param.choice({ question: edgeQuestion("relabel"), options: (ctx) => edgeOptions(ctx.state) }),
      label: param.choice({ question: "What label do `instructions` give that arrow now?", options: arrows }),
    },
    run: ({ edge, label }, ctx) => attempt(() => relabelEdge(graphOf(ctx.state), edge, label), `Labelled the arrow ${edge} as "${label}"`, ctx),
  });

  // Only when the new diagram is judged to be what was asked for: a model that stops by itself, early, is not taken at its word.
  const end = defineTool({
    name: "end",
    description: "Stops, because the diagram in `state.diagram` is what `instructions` ask for.",
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
      // What the person answered changes what is done: it must be judged again, and `end` waits for that.
      return { state: { user_reply: reply, open_questions: open, done: false }, summary: `asked "${question}" and the person replied` };
    },
  });
  return [add, remove, rename, join, cut, relabel, askUser, end];
}

/** The line that closes a run, written from what the diagram did: the changes, or that nothing changed. */
export function resultLine(before: Graph, after: Graph, result: RunResult): { ok: boolean; text: string } {
  const done = changes(before, after);
  const size = `${after.nodes.length} ${after.nodes.length === 1 ? "step" : "steps"} and ${after.edges.length} ${after.edges.length === 1 ? "arrow" : "arrows"}`;
  if (result.status === "ended" && done.length) return { ok: true, text: `Done: ${done.join(", ")}. The diagram has ${size}.` };
  const why = result.status === "step_limit" ? "ran out of steps" : result.status === "error" ? `failed (${result.error?.message ?? "error"})` : "stopped";
  return { ok: false, text: `I ${why}${done.length ? ` after: ${done.join(", ")}` : " and left the diagram as it was"}. The diagram has ${size}.` };
}

/** One instruction, start to end: the agent edits the diagram while the panel shows the steps; the result closes it. */
export async function carryOut(opts: AssistantOptions & { overlay: PageOverlay; instruction: string }): Promise<RunResult & { line: { ok: boolean; text: string } }> {
  const { browser, overlay } = opts;
  browser.hideFromModel("#source");
  await overlay.working(true);
  try {
    const text = (await shown(browser)) || EMPTY;
    const before = parse(text);
    const snap = await snapshotOf(browser, "screen", false);
    const result = await createAgent({
      model: opts.model,
      instructions: opts.instruction,
      tools: assistantTools(browser, opts.model, opts.instruction),
      input: opts.input,
      initialState: { diagram: text, screen: snap.screen!, done: false, user_reply: null, open_questions: await openQuestions(opts.model, opts.instruction) },
      maxSteps: opts.maxSteps ?? 20,
      onEvent: (e) => {
        opts.onEvent?.(e);
        if (e.type === "tool_result" && e.summary && e.tool !== "ask_user" && e.tool !== "end") void overlay.say(e.summary, "progress");
      },
    }).run();
    const line = resultLine(before, parse((await shown(browser)) || EMPTY), result);
    await overlay.say(line.text, line.ok ? "result" : "error");
    return { ...result, line };
  } finally {
    await overlay.working(false);
  }
}

/** What one instruction came to: the instruction, how the run ended, and the line that closed it in the panel. */
export type Handled = { instruction: string; result: RunResult; line: { ok: boolean; text: string } };

/**
 * The assistant, waiting behind the panel: for each instruction the person sends there, it edits the diagram (`carryOut`), then waits
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
