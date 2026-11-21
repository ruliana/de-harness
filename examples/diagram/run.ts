/**
 * One run of the assistant behind the panel, with a scripted person: the instruction is typed into the panel, a question that comes back is
 * answered there, and what the diagram and the panel ended up as is read afterwards. The test, the runner (`main.ts`) and the demo share it,
 * so that what the PR reports is what the test checks.
 */
import type { DecisionModel, HarnessEvent } from "../../src/index.js";
import { BrowserSession, PageOverlay, type BrowserOptions, type OverlayMessage } from "../../src/browser/index.js";
import { ARROWS, MESSAGES, PARTICIPANTS, STEPS, draw, drawn, quoted, serve, shown, type Handled } from "./assistant.js";
import { startDiagramSite } from "./diagram-site.js";
import { EMPTY, HEADER, labelOf, parse, shape, type Graph } from "./graph.js";

/** What the person says, what they answer when asked, the diagram the page starts with, and what the diagram has to be afterwards (`check`: what is wrong with it; empty when right). */
export type Scenario = { name: string; start: string; instruction: string; answer?: string; check(g: Graph): string[] };

const flowchart = (...lines: string[]) => [HEADER.flowchart, ...lines.map((l) => `  ${l}`)].join("\n");

/** The messages of a sequence diagram as `from|text|to`, in order. */
const messages = (g: Graph) => g.edges.map((e) => `${labelOf(g, e.from)}|${e.label}|${labelOf(g, e.to)}`);
const FAILURE = /invalid|error|fail|wrong|denied|reject/i;
/** The branches (cases) that the messages of a sequence diagram are in. */
const cases = (g: Graph) => [...new Set(g.edges.map((e) => e.case).filter((c): c is string => !!c))];

/** What every sequence diagram of an exchange must be: those participants and no others, each in the exchange, started by the user, with the whole exchange between them. */
function exchange(g: Graph, who: string[], { atLeast, failure }: { atLeast: number; failure: RegExp }): string[] {
  const out: string[] = [];
  if (g.kind !== "sequence") return ["it is not a sequence diagram"];
  const got = g.nodes.map((n) => n.label);
  if (JSON.stringify([...got].sort()) !== JSON.stringify([...who].sort())) out.push(`the participants are ${JSON.stringify(got)}, expected ${JSON.stringify(who)}`);
  if (g.edges.length < atLeast || g.edges.length > 16) out.push(`${g.edges.length} messages, expected ${atLeast} to 16`);
  for (const n of g.nodes) if (!g.edges.some((e) => e.from === n.id || e.to === n.id)) out.push(`"${n.label}" takes no part in the exchange`);
  if (g.edges[0] && labelOf(g, g.edges[0].from) !== "User") out.push("the exchange is not started by the user");
  if (!g.edges.some((e) => failure.test(e.label ?? ""))) out.push(`no message covers the failure (${failure})`);
  if (cases(g).length < 2) out.push(`the exchange has ${cases(g).length} branches, expected the one that works and the failure`);
  return out;
}
const sameShape = (g: Graph, want: { nodes: string[]; edges: string[] }): string[] => {
  const got = shape(g);
  return JSON.stringify(got) === JSON.stringify({ kind: "flowchart", nodes: [...want.nodes].sort(), edges: [...want.edges].sort() }) ? [] : [`the diagram is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`];
};

export const SCENARIOS: Scenario[] = [
  {
    name: "login-sequence",
    start: EMPTY,
    instruction:
      "Draw a sequence diagram of a login. The user enters credentials in the browser, the browser sends a login request to the server, the server looks the user up in the database, the database returns the user record, and the server checks the password. " +
      "If the password is right, the server sends a session token and the browser shows the dashboard. If it is wrong, the server sends invalid credentials and the browser shows an error message.",
    check: (g) => {
      const out = exchange(g, ["User", "Browser", "Server", "Database"], { atLeast: 7, failure: FAILURE });
      const m = messages(g);
      const at = (from: string, to: string) => m.findIndex((x) => x.startsWith(`${from}|`) && x.endsWith(`|${to}`));
      if (g.kind === "sequence") {
        if (at("Server", "Database") < 0 || at("Database", "Server") < 0) out.push("the server does not ask the database, or the database does not answer");
        else if (at("Server", "Database") > at("Database", "Server")) out.push("the database answers before the server asks");
        if (at("Browser", "Server") < 0 || at("Browser", "Server") > at("Server", "Database")) out.push("the browser does not ask the server before the server asks the database");
        if (!m.some((x) => x.endsWith("|User"))) out.push("nothing is shown to the user");
      }
      return out;
    },
  },
  {
    name: "ask-wrong-password",
    start: EMPTY,
    instruction:
      "Draw a sequence diagram of a login. The user enters credentials in the browser, the browser sends a login request to the server, and the server sends a session token to the browser when the password is right. " +
      "Ask me what the server sends to the browser when the password is wrong.",
    answer: "Account locked",
    check: (g) => {
      const out = exchange(g, ["User", "Browser", "Server"], { atLeast: 4, failure: /lock/i }); // the person's answer decides the failure case
      if (g.edges.some((e) => /invalid/i.test(e.label ?? ""))) out.push("the server sends invalid credentials, but the person answered account locked");
      return out;
    },
  },
  {
    name: "insert-step",
    start: flowchart('n1["Push code"]', 'n2["Run tests"]', 'n3["Deploy"]', "n1 --> n2", "n2 --> n3"),
    instruction: "Add a 'Build image' step between 'Run tests' and 'Deploy'",
    check: (g) => sameShape(g, { nodes: ["Push code", "Run tests", "Build image", "Deploy"], edges: ["Push code||Run tests", "Run tests||Build image", "Build image||Deploy"] }),
  },
  {
    name: "tidy",
    start: flowchart('n1["Push code"]', 'n2["Run tests"]', 'n3["Build image"]', 'n4["Deploy"]', 'n5["Notify team"]', "n1 --> n2", "n2 -->|Pass| n3", "n3 --> n4", "n4 --> n5"),
    instruction: "Rename 'Build image' to 'Package app', call the 'Pass' arrow 'Green', and remove the 'Notify team' step",
    check: (g) => sameShape(g, { nodes: ["Push code", "Run tests", "Package app", "Deploy"], edges: ["Push code||Run tests", "Run tests|Green|Package app", "Package app||Deploy"] }),
  },
];

export type Outcome = {
  scenario: Scenario;
  handled: Handled | undefined;
  /** The Mermaid text the page shows at the end, and the graph read from it (`null` when it cannot be read). */
  diagram: string;
  graph: Graph | null;
  /** What the page drew from it, read from its picture. */
  drawn: Awaited<ReturnType<typeof drawn>>;
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
  /** Called once the page and the panel are up, before the person types (the demo adds its captions there). */
  onReady?: (browser: BrowserSession, overlay: PageOverlay) => Promise<void>;
  /** Called when the instruction is carried out, before the browser is closed (the demo takes its last picture there). */
  onFinish?: (browser: BrowserSession, overlay: PageOverlay) => Promise<void>;
  /** Called with every event as it happens. */
  onEvent?: (e: HarnessEvent, browser: BrowserSession) => void;
  /** How the person types a line into the panel and sends it (default: all at once; the demo types it letter by letter and presses Enter). */
  type?: (text: string, browser: BrowserSession, overlay: PageOverlay) => Promise<void>;
  /** How long the person thinks before answering a question; the loop must stay quiet that long. */
  thinkMs?: number;
  maxWaitMs?: number;
};

export async function runScenario(opts: RunOptions): Promise<Outcome> {
  const { scenario } = opts;
  const site = await startDiagramSite();
  const browser = await BrowserSession.launch({ allowedHosts: ["127.0.0.1"], ...opts.browser });
  try {
    const overlay = await PageOverlay.install(browser, { title: "Diagram assistant", placeholder: "Tell me what to draw" });
    await browser.goto(site.url);
    await draw(browser, scenario.start);
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

    const say = opts.type ?? ((text: string, _browser: BrowserSession, panel: PageOverlay) => panel.send(text));
    await say(scenario.instruction, browser, overlay); // as the person does: into the panel
    const until = Date.now() + (opts.maxWaitMs ?? 20 * 60_000);
    while (assistant.handled.length === 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 200));
      if (!held && overlay.messages.some((m) => m.kind === "question")) {
        const requestsWhenAsked = requests();
        await new Promise((r) => setTimeout(r, opts.thinkMs ?? 700)); // the person thinks about it
        held = { requestsWhenAsked, requestsAfterWaiting: requests() };
        if (scenario.answer) await say(scenario.answer, browser, overlay);
      }
    }
    await new Promise((r) => setTimeout(r, 100));
    await opts.onFinish?.(browser, overlay);
    const panel = await browser.evaluate(() => (document.querySelector("#de-overlay")?.shadowRoot?.querySelector(".log") as HTMLElement | null)?.innerText ?? "", 0);
    const fieldLeftOver = await browser.evaluate(() => (document.querySelector("#de-overlay")?.shadowRoot?.querySelector("input") as HTMLInputElement | null)?.value ?? "", 0);
    const diagram = await shown(browser);
    let graph: Graph | null = null;
    try {
      graph = parse(diagram);
    } catch {
      /* problems() says so */
    }
    const outcome: Outcome = { scenario, handled: assistant.handled[0], diagram, graph, drawn: await drawn(browser), messages: [...overlay.messages], panel, held, fieldLeftOver, events };
    await assistant.stop();
    return outcome;
  } finally {
    await browser.close();
    await site.close();
  }
}

/** What is wrong with a run, in words; empty when it is right. Code reads the diagram, the page and the panel, never the model. */
export function problems(o: Outcome): string[] {
  const out: string[] = [];
  const { scenario } = o;
  if (!o.handled) return ["the assistant never finished the instruction"];
  if (o.handled.result.status !== "ended") out.push(`the run ${o.handled.result.status} instead of ending on its own`);
  if (!o.graph) return [...out, `the page shows text that is not a diagram of this shape: ${JSON.stringify(o.diagram)}`];
  const g = o.graph;
  out.push(...scenario.check(g));
  if (o.handled.result.state.diagram !== o.diagram) out.push("the agent's state and the page show different text");
  if (o.drawn.error) out.push(`Mermaid could not draw the text: ${o.drawn.error}`);
  if (JSON.stringify([...o.drawn.nodes].sort()) !== JSON.stringify(g.nodes.map((n) => n.label).sort())) out.push(`the page drew the nodes ${JSON.stringify(o.drawn.nodes)}, not those of the text`);
  const labels = g.edges.map((e) => e.label).filter((l): l is string => !!l);
  if (JSON.stringify([...o.drawn.edgeLabels].sort()) !== JSON.stringify([...labels].sort())) out.push(`the page drew the arrow labels ${JSON.stringify(o.drawn.edgeLabels)}, not those of the text`);
  // Jev does not write: every label is one that code offered.
  const offered = new Set([...STEPS, ...ARROWS, ...PARTICIPANTS, ...MESSAGES.map((m) => m.text), ...quoted(scenario.instruction)]);
  for (const l of [...g.nodes.map((n) => n.label), ...labels]) if (!offered.has(l)) out.push(`"${l}" is not a label that was offered`);
  const last = o.messages.at(-1);
  if (last?.kind !== "result") out.push(`the panel does not end with the result: ${last ? `[${last.kind}] ${last.text}` : "nothing"}`);
  const asked = o.messages.filter((m) => m.kind === "question").length;
  if (asked !== (scenario.answer ? 1 : 0)) out.push(`the panel asked ${asked} questions`);
  const narrated = o.messages.filter((m) => m.kind === "progress").length;
  if (narrated > 0) out.push(`the panel narrated ${narrated} steps; it should be quiet until the result`);
  if (o.fieldLeftOver !== "") out.push(`something was typed into the panel's field: "${o.fieldLeftOver}"`);
  return out;
}
