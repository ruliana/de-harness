/**
 * The assistant: what runs behind the panel beside the diagram. It takes the person's instruction ("Draw a sequence diagram of a login between
 * a user, a browser, a server and a database, with a failure case"), edits the diagram, and reports back into the panel when it is done.
 *
 * The state of the agent is the diagram as Mermaid text (`state.diagram`) and nothing else about it: no picture, the text is enough. Every tool
 * reads the text, changes it and puts the new text into the state; the page draws it as it comes, so the person watches the diagram grow while
 * the agent works at full speed, and the panel says nothing until there is a result (or a question).
 *
 * Its tools come and go with the diagram. Before anything is drawn there is only `start_diagram` (a flowchart or a sequence diagram). Then
 * `add_node` (a step, or a participant), and once there are nodes `remove_node` and `rename_node`; `connect` (a flowchart's arrow) or `add_message`
 * (a sequence diagram's message, after the last one) once there are two; `disconnect` and `relabel_edge` once there is an arrow or a message;
 * `ask_user` (holds the loop: a question goes into the panel and the loop waits for the answer there) while a question is open; `end` when the
 * diagram is judged to be what was asked.
 *
 * Jev cannot write, so every label the agent puts into the diagram is chosen from candidates that code supplies: catalogs of steps, arrow
 * labels, participants and messages (`STEPS`, `ARROWS`, `PARTICIPANTS`, `MESSAGES`) and the texts in quotes in the instruction (`'Package app'`).
 * The lines in the panel are written by code from what the diagram did, not by the model.
 */
import { createAgent, defineTool, param, readNoul, type AnyTool, type DecisionModel, type HarnessEvent, type InputProvider, type Options, type RunResult } from "../../src/index.js";
import type { BrowserSession, PageOverlay } from "../../src/browser/index.js";
import { addMessage, addNode, connect, disconnect, edgeKey, EMPTY, labelOf, parse, relabelEdge, removeNode, renameNode, start, toMermaid, words, type Graph, type Kind } from "./graph.js";

/** Steps that a flowchart of a common flow is made of. */
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
/** Labels that a flowchart's arrow may carry. */
export const ARROWS = ["Yes", "No", "Valid", "Invalid", "Success", "Failure", "Pass", "Fail", "Retry", "Approved", "Rejected"];
/** Who may take part in a sequence diagram. */
export const PARTICIPANTS = ["User", "Browser", "Server", "Database", "Cache", "API", "Auth service", "Email service", "Payment provider", "Admin"];
/** A message that is common in an exchange, with who sends it to whom and, when it only happens in one case, which (the branch it goes into). */
export type Template = { from: string; to: string; text: string; case?: string };
const T = (from: string, to: string, text: string, branch?: string): Template => ({ from, to, text, ...(branch ? { case: branch } : {}) });
export const OK = "Credentials valid";
export const BAD = "Credentials invalid";
/** What a message of a sequence diagram may say, and between whom: an agent chooses among these , never writes. */
export const MESSAGES: Template[] = [
  T("User", "Browser", "Enter credentials"), T("Browser", "Server", "Send login request"), T("Server", "Database", "Look up user"), T("Database", "Server", "User record"),
  T("Server", "Server", "Check password"),
  T("Server", "Browser", "Session token", OK), T("Browser", "User", "Show dashboard", OK),
  T("Server", "Browser", "Invalid credentials", BAD), T("Browser", "User", "Show error message", BAD), T("Server", "Database", "Record failed attempt", BAD),
  T("Server", "Database", "Lock account", BAD), T("Server", "Browser", "Account locked", BAD), T("Browser", "User", "Show account locked", BAD),
  T("Server", "Email service", "Send verification code"), T("Email service", "User", "Verification code"), T("User", "Browser", "Enter code"),
];

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
/** What the page drew: the labels of its nodes, sorted (a participant once, not at the top and at the foot) and of its arrows or messages, read from the picture it made, not from the text it was given. */
export async function drawn(browser: BrowserSession): Promise<{ nodes: string[]; edgeLabels: string[]; error: string | null }> {
  return await browser.evaluate(
    () => {
      const texts = (selector: string) => [...document.querySelectorAll(selector)].map((e) => (e.textContent ?? "").trim().replace(/\s+/g, " "));
      const sequence = document.querySelector("#canvas svg")?.getAttribute("aria-roledescription") === "sequence";
      return {
        nodes: (sequence ? [...new Set(texts("#canvas text.actor"))] : texts("#canvas g.node")).sort(),
        edgeLabels: (sequence ? texts("#canvas text.messageText") : texts("#canvas g.edgeLabel")).filter(Boolean),
        error: document.querySelector("#canvas .error")?.textContent ?? null,
      };
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
  const w = words(after.kind);
  if (before.kind === null && after.kind !== null) out.push(`started a ${after.kind === "sequence" ? "sequence diagram" : "flowchart"}`);
  const added = after.nodes.filter((n) => !before.nodes.some((b) => b.id === n.id));
  if (added.length) out.push(`added the ${added.length === 1 ? w.node : w.nodes} ${added.map((n) => (after.kind === "sequence" ? n.label : `"${n.label}"`)).join(", ")}`);
  for (const n of after.nodes) {
    const was = before.nodes.find((b) => b.id === n.id);
    if (was && was.label !== n.label) out.push(`renamed "${was.label}" to "${n.label}"`);
  }
  for (const n of before.nodes) if (!after.nodes.some((a) => a.id === n.id)) out.push(`removed "${n.label}"`);
  // An arrow is the same arrow when it joins the same two nodes; the arrows of a removed node go with it and are not counted.
  const key = (e: Graph["edges"][number]) => (after.kind === "sequence" ? `${e.from}>${e.to}:${e.label}` : `${e.from}>${e.to}`);
  const was = new Map(before.edges.map((e) => [key(e), e]));
  const now = new Map(after.edges.map((e) => [key(e), e]));
  const newer = after.edges.filter((e) => !was.has(key(e)));
  const gone = before.edges.filter((e) => !now.has(key(e)) && after.nodes.some((n) => n.id === e.from) && after.nodes.some((n) => n.id === e.to));
  const relabelled = after.kind === "sequence" ? [] : after.edges.filter((e) => was.has(key(e)) && was.get(key(e))!.label !== e.label);
  const many = (n: number) => `${n} ${n === 1 ? w.edge : w.edges}`;
  if (newer.length) out.push(`${newer.length} new ${newer.length === 1 ? w.edge : w.edges}`);
  if (gone.length) out.push(`${many(gone.length)} taken out`);
  if (relabelled.length) out.push(`${many(relabelled.length)} relabelled`);
  return out;
}

/**
 * What the assistant may have to ask the person. Jev judges whether the instruction leaves it open (`open`, a yes/no question about
 * `instructions`); code decides: only a clear yes is asked, in the words of `question`.
 */
export type Gap = { id: string; open: string; question: string };
export const GAPS: Gap[] = [
  {
    id: "wrong-password",
    open: "Do `instructions` tell the assistant to ask the person what the server sends, or does, when a password is wrong?",
    question: "When the password is wrong, what should the server send to the browser: invalid credentials, or account locked?",
  },
];

/**
 * Editing what is already drawn is only worth offering when the instruction asks for it: a model that has to choose a tool at every step
 * will otherwise take things out and put them back. Jev judges, once, whether the instruction asks for each kind of edit; code decides:
 * the tool is offered unless the judgment is a clear no.
 */
export const EDITS: Record<string, string> = {
  remove_node: "Do `instructions` ask to remove a step or a participant from a diagram?",
  rename_node: "Do `instructions` ask to give a step or a participant another name?",
  disconnect: "Do `instructions` ask to take out an arrow or a message, or to put a step between two that are joined already?",
  relabel_edge: "Do `instructions` ask to give an arrow or a message another label?",
};

/** What the instruction says, from one request to the model of yes/no questions: the questions it leaves open for the person, and the edits that it asks for. */
export async function readInstruction(model: DecisionModel, instruction: string): Promise<{ questions: string[]; allow: Set<string> }> {
  const response = await model.ask({
    state: { instructions: instruction },
    questions: {
      ...Object.fromEntries(GAPS.map((g) => [g.id, { type: "noul" as const, instructions: g.open }])),
      ...Object.fromEntries(Object.entries(EDITS).map(([tool, question]) => [tool, { type: "noul" as const, instructions: question }])),
    },
  });
  const said = (id: string): boolean | "unsure" => {
    const answer = response.answers[id];
    if (answer?.type !== "noul") throw new Error(`no yes/no answer for ${id}`);
    return readNoul(answer.noul);
  };
  return {
    questions: GAPS.filter((g) => said(g.id) === true).map((g) => g.question),
    allow: new Set(Object.keys(EDITS).filter((tool) => said(tool) !== false)),
  };
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

const COMMON =
  "If `instructions` ask for the person's answer, the diagram follows `state.user_reply`. ";
/** What "done" means for each kind of diagram: short and concrete, since the judgment is asked after every step. */
const DONE: Record<Kind | "none", string> = {
  none: "Has a diagram been drawn that `instructions` ask for? " + COMMON,
  sequence:
    "Does the sequence diagram in `state.diagram` have every message that `instructions` describe, in the order in which they are sent, with a branch (`alt` and `else`) for each case that they describe, and no message that neither `instructions` nor `state.user_reply` describe? " +
    "Its participants are the ones that the messages need. " + COMMON,
  flowchart:
    "Is the flowchart in `state.diagram` exactly what `instructions` ask for? " +
    "Every step that `instructions` ask to add must be in it, every step they ask to remove must be gone, and every rename and arrow label they ask for must be there. " +
    "If `instructions` give a number of steps, it has that many, besides the steps of a branch that they ask for; a branch is a step with two arrows leaving it. " +
    "The steps are joined by arrows in the order of the flow, and no step is left without an arrow. " +
    "A step that `instructions` put between two others sits on the way from one to the other, so the arrow that joined those two directly is gone. " + COMMON,
};

/** Has everything been done, by the new diagram? One yes/no question to the model, asked after every step that changed it. Code decides what the answer means: only a clear yes makes `end` available. */
export async function judgeDone(model: DecisionModel, instruction: string, state: Readonly<Record<string, unknown>>, diagram: string): Promise<boolean> {
  const response = await model.ask({ state: { instructions: instruction, state: { diagram, user_reply: state.user_reply ?? null }, previous_actions: [] }, questions: { done: { type: "noul", instructions: DONE[parse(diagram).kind ?? "none"] } } });
  const answer = response.answers.done;
  if (answer?.type !== "noul") throw new Error("no yes/no answer for done");
  return readNoul(answer.noul) === true;
}

const nodeQuestion = (what: string) => `Which node of the diagram in \`state.diagram\` do \`instructions\` say to ${what}? A node is a step of a flowchart or a participant of a sequence diagram.`;
const edgeQuestion = (what: string) => `Which arrow or message of the diagram in \`state.diagram\` do \`instructions\` say to ${what}? A flowchart's arrow is written \`from --label--> to\`, a sequence diagram's message \`number. from -> to: text\`.`;

/** The tools of the assistant for one instruction. */
export function assistantTools(browser: BrowserSession, model: DecisionModel, instruction: string, allow?: ReadonlySet<string>): AnyTool[] {
  const named = quoted(instruction);
  const may = (tool: string) => allow === undefined || allow.has(tool);
  const kindOf = (state: Readonly<Record<string, unknown>>): Kind | null => (shows(state, () => true) ? graphOf(state).kind : null);
  const labelsOf = (state: Readonly<Record<string, unknown>>) => (shows(state, () => true) ? graphOf(state).nodes.map((n) => n.label) : []);
  const messagesOf = (state: Readonly<Record<string, unknown>>) => (shows(state, () => true) ? graphOf(state).edges.map((e) => e.label ?? "") : []);
  const nodeNames = (state: Readonly<Record<string, unknown>>) => unique([...named, ...(kindOf(state) === "sequence" ? PARTICIPANTS : STEPS)]).filter((n) => !labelsOf(state).includes(n));
  const edgeOptions = (state: Readonly<Record<string, unknown>>): Options => {
    const g = graphOf(state);
    return g.edges.map((e) => edgeKey(g, e));
  };
  /** Every ordered pair of nodes, `from -> to`, that is not joined in that direction yet (a flowchart), or every pair at all, a node with itself included (a sequence diagram). */
  const pairs = (state: Readonly<Record<string, unknown>>): string[] => {
    const g = graphOf(state);
    return g.nodes.flatMap((a) => g.nodes.filter((b) => (g.kind === "sequence" ? true : b !== a && !g.edges.some((e) => e.from === a.id && e.to === b.id))).map((b) => `${a.label} -> ${b.label}`));
  };

  /** Draw the new text, and judge whether the diagram is done. The text is the state. */
  const result = async (g: Graph, summary: string, ctx: { state: Readonly<Record<string, unknown>> }) => {
    const text = toMermaid(g);
    await draw(browser, text);
    return { state: { diagram: text, done: await judgeDone(model, instruction, ctx.state, text) }, summary };
  };
  /** A tool that cannot do what it was asked leaves the diagram alone and says so. */
  const attempt = async (make: () => Graph, summary: string, ctx: { state: Readonly<Record<string, unknown>> }) => {
    let next: Graph;
    try {
      next = make();
    } catch (e) {
      return { summary: `could not do it: ${e instanceof Error ? e.message.replace(/^diagram: /, "") : String(e)}` };
    }
    return result(next, summary, ctx);
  };

  const begin = defineTool({
    name: "start_diagram",
    description: "Starts the diagram that `instructions` ask for, which nothing has been drawn of yet, as a flowchart or as a sequence diagram.",
    available: ({ state }) => shows(state, (g) => g.kind === null),
    params: {
      kind: param.choice({
        question: "Which kind of diagram do `instructions` ask for?",
        options: { "sequence diagram": "participants, and the messages that they send each other, in the order in which they are sent", flowchart: "steps, joined by arrows" },
      }),
    },
    run: ({ kind }, ctx) => attempt(() => start(graphOf(ctx.state), kind === "flowchart" ? "flowchart" : "sequence"), `Started a ${kind}`, ctx),
  });

  const add = defineTool({
    name: "add_node",
    description: "Adds one node to the diagram in `state.diagram`: a step of a flowchart, or a participant of a sequence diagram, which `instructions` ask for and which the diagram does not have yet.",
    available: ({ state }) => shows(state, (g) => g.kind !== null),
    params: {
      label: param.choice({
        question: "Which step or participant that `instructions` ask for is still missing from the diagram in `state.diagram`? If more than one is missing, the one that comes first in the flow, or the one furthest to the left.",
        options: (ctx) => nodeNames(ctx.state),
      }),
    },
    run: ({ label }, ctx) => attempt(() => addNode(graphOf(ctx.state), label), `Added "${label}"`, ctx),
  });

  const remove = defineTool({
    name: "remove_node",
    description: "Removes one node, with all its arrows or messages, from the diagram in `state.diagram`.",
    available: ({ state }) => may("remove_node") && shows(state, (g) => g.nodes.length > 0),
    params: { node: param.choice({ question: nodeQuestion("remove"), options: (ctx) => labelsOf(ctx.state) }) },
    run: ({ node }, ctx) => attempt(() => removeNode(graphOf(ctx.state), node), `Removed "${node}"`, ctx),
  });

  const rename = defineTool({
    name: "rename_node",
    description: "Gives one node of the diagram in `state.diagram` another label.",
    available: ({ state }) => may("rename_node") && shows(state, (g) => g.nodes.length > 0),
    params: {
      node: param.choice({ question: nodeQuestion("rename"), options: (ctx) => labelsOf(ctx.state) }),
      label: param.choice({ question: "What do `instructions` say that node is to be called now?", options: (ctx) => nodeNames(ctx.state) }),
    },
    run: ({ node, label }, ctx) => attempt(() => renameNode(graphOf(ctx.state), node, label), `Renamed "${node}" to "${label}"`, ctx),
  });

  const join = defineTool({
    name: "connect",
    description: "Draws one new arrow in the flowchart in `state.diagram`, from one step to another, with a label if `instructions` give it one.",
    available: ({ state }) => shows(state, (g) => g.kind === "flowchart" && g.nodes.length >= 2 && pairs(state).length > 0),
    params: {
      arrow: param.choice({ question: "Which arrow that `instructions` ask for is still missing from the flowchart in `state.diagram`? If more than one is missing, the one that comes first in the flow. An arrow is written `from -> to`.", options: (ctx) => pairs(ctx.state) }),
      label: param.choice({
        question: "Which label do `instructions` give that arrow?",
        options: () => unique([...named, ...ARROWS]),
        optional: { stated: "Do `instructions` give a label to that arrow, such as Yes, No, Valid, Invalid or a text in quotes?" },
      }),
    },
    run: ({ arrow, label }, ctx) => {
      const [from, to] = arrow.split(" -> ") as [string, string];
      return attempt(() => connect(graphOf(ctx.state), from, to, label ?? null), `Connected "${from}" to "${to}"${label ? ` as "${label}"` : ""}`, ctx);
    },
  });

  /**
   * The messages that could be added to a sequence diagram, as `from -> to: text`: the catalog's that are not said yet, and any text in quotes in the
   * instruction between any two of the participants. One choice, so that who speaks to whom and what is said never come apart.
   */
  const nextMessages = (state: Readonly<Record<string, unknown>>): (Template & { key: string })[] => {
    const g = graphOf(state);
    const said = new Set(g.edges.map((e) => `${labelOf(g, e.from)}|${labelOf(g, e.to)}|${e.label}`));
    const catalog = MESSAGES.filter((m) => !said.has(`${m.from}|${m.to}|${m.text}`));
    const free = named.flatMap((text) => g.nodes.flatMap((a) => g.nodes.map((b) => T(a.label, b.label, text)))).filter((m) => !said.has(`${m.from}|${m.to}|${m.text}`));
    return [...catalog, ...free].map((m) => ({ ...m, key: `${m.from} -> ${m.to}: ${m.text}` }));
  };
  const send = defineTool({
    name: "add_message",
    description:
      "Adds one message to the end of the sequence diagram in `state.diagram`: one that the exchange in `instructions` has and the diagram does not have yet. " +
      "The participants of the message join the diagram if they are not in it. A message that only happens in one case goes into that case's branch, and a reply is drawn as one when it goes back the way a request came.",
    available: ({ state }) => shows(state, (g) => g.kind === "sequence" && nextMessages(state).length > 0),
    params: {
      message: param.choice({
        question: "Which message that `instructions` describe is not in the sequence diagram in `state.diagram` yet? If more than one is missing, the one that is sent first. A message is written `from -> to: text`.",
        options: (ctx) => Object.fromEntries(nextMessages(ctx.state).map((m) => [m.key, m.case ? `only when: ${m.case}` : "in every case"])),
      }),
    },
    run: ({ message }, ctx) => {
      const m = nextMessages(ctx.state).find((x) => x.key === message);
      if (!m) return { summary: `could not do it: no such message "${message}"` };
      return attempt(
        () => {
          let g = graphOf(ctx.state);
          for (const who of unique([m.from, m.to])) if (!g.nodes.some((n) => n.label === who)) g = addNode(g, who);
          return addMessage(g, m.from, m.to, m.text, m.case ?? null);
        },
        `Message ${m.key}`,
        ctx,
      );
    },
  });

  const cut = defineTool({
    name: "disconnect",
    description: "Takes one arrow or message out of the diagram in `state.diagram`; the nodes stay.",
    available: ({ state }) => may("disconnect") && shows(state, (g) => g.edges.length > 0),
    params: { edge: param.choice({ question: edgeQuestion("take out, or to replace with another"), options: (ctx) => edgeOptions(ctx.state) }) },
    run: ({ edge }, ctx) => attempt(() => disconnect(graphOf(ctx.state), edge), `Took out ${edge}`, ctx),
  });

  const relabel = defineTool({
    name: "relabel_edge",
    description: "Gives one arrow or message of the diagram in `state.diagram` another label.",
    available: ({ state }) => may("relabel_edge") && shows(state, (g) => g.edges.length > 0),
    params: {
      edge: param.choice({ question: edgeQuestion("relabel"), options: (ctx) => edgeOptions(ctx.state) }),
      label: param.choice({ question: "What label do `instructions` give that arrow or message now?", options: (ctx) => unique([...named, ...(kindOf(ctx.state) === "sequence" ? [...new Set(MESSAGES.map((m) => m.text))] : ARROWS)]) }),
    },
    run: ({ edge, label }, ctx) => attempt(() => relabelEdge(graphOf(ctx.state), edge, label), `Labelled ${edge} as "${label}"`, ctx),
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
  return [begin, add, remove, rename, join, send, cut, relabel, askUser, end];
}

/** The line that closes a run, written from what the diagram did: the changes, or that nothing changed. */
export function resultLine(before: Graph, after: Graph, result: RunResult): { ok: boolean; text: string } {
  const done = changes(before, after);
  const w = words(after.kind);
  const size = `${after.nodes.length} ${after.nodes.length === 1 ? w.node : w.nodes} and ${after.edges.length} ${after.edges.length === 1 ? w.edge : w.edges}`;
  if (result.status === "ended" && done.length) return { ok: true, text: `Done: ${done.join(", ")}. The diagram has ${size}.` };
  const why = result.status === "step_limit" ? "ran out of steps" : result.status === "error" ? `failed (${result.error?.message ?? "error"})` : "stopped";
  return { ok: false, text: `I ${why}${done.length ? ` after: ${done.join(", ")}` : " and left the diagram as it was"}. The diagram has ${size}.` };
}

/** One instruction, start to end: the agent edits the diagram, which the page draws as it goes; the panel says nothing until the result (or a question). */
export async function carryOut(opts: AssistantOptions & { overlay: PageOverlay; instruction: string }): Promise<RunResult & { line: { ok: boolean; text: string } }> {
  const { browser, overlay } = opts;
  await overlay.working(true);
  try {
    const text = await shown(browser);
    const before = parse(text);
    const { questions, allow } = await readInstruction(opts.model, opts.instruction);
    const result = await createAgent({
      model: opts.model,
      instructions: opts.instruction,
      tools: assistantTools(browser, opts.model, opts.instruction, allow),
      input: opts.input,
      initialState: { diagram: text, done: false, user_reply: null, open_questions: questions },
      maxSteps: opts.maxSteps ?? 30,
      onEvent: opts.onEvent,
    }).run();
    const line = resultLine(before, parse(await shown(browser)), result);
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
