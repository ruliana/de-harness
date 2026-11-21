/**
 * One run of the assistant behind the panel, with a scripted person: the instruction is typed into the panel, a question that comes back is
 * answered there, and what the diagram and the panel ended up as is read afterwards. The test, the runner (`main.ts`) and the demo share it,
 * so that what the PR reports is what the test checks.
 */
import type { DecisionModel, HarnessEvent } from "../../src/index.js";
import { BrowserSession, PageOverlay, type BrowserOptions, type OverlayMessage } from "../../src/browser/index.js";
import { ARROWS, STEPS, draw, drawn, quoted, serve, shown, type Handled } from "./assistant.js";
import { startDiagramSite } from "./diagram-site.js";
import { EMPTY, parse, shape, type Graph } from "./graph.js";

/** What the person says, what they answer when asked, the diagram the page starts with, and what the diagram has to be afterwards (`check`: what is wrong with it; empty when right). */
export type Scenario = { name: string; start: string; instruction: string; answer?: string; check(g: Graph): string[] };

const text = (...lines: string[]) => [EMPTY, ...lines.map((l) => `  ${l}`)].join("\n");

/** Every node is reachable from every other when the arrows are read both ways: nothing is left lying around. */
export function connected(g: Graph): boolean {
  if (g.nodes.length === 0) return true;
  const seen = new Set([g.nodes[0]!.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of g.edges) {
      if (seen.has(e.from) !== seen.has(e.to)) {
        seen.add(e.from).add(e.to);
        grew = true;
      }
    }
  }
  return seen.size === g.nodes.length;
}
/** Does an arrow lead back to a step from which the flow came? */
export function hasCycle(g: Graph): boolean {
  const reach = (from: string, seen = new Set<string>()): Set<string> => {
    for (const e of g.edges) if (e.from === from && !seen.has(e.to)) reach(e.to, seen.add(e.to));
    return seen;
  };
  return g.nodes.some((n) => reach(n.id).has(n.id));
}
export const branches = (g: Graph): string[] => g.nodes.filter((n) => g.edges.filter((e) => e.from === n.id).length >= 2).map((n) => n.label);
const FAILURE = /error|fail|reject|invalid|lock|retry|cancel|roll ?back/i;

/** What every drawing from nothing must be: a handful of steps, joined into one flow, with a branch and a step for the failure. */
function drawing(g: Graph, { loop }: { loop: boolean }): string[] {
  const min = loop ? 3 : 4; // a loop back needs no step of its own for the failure
  const out: string[] = [];
  if (g.nodes.length < min || g.nodes.length > 7) out.push(`${g.nodes.length} steps, expected ${min} to 7`);
  if (!connected(g)) out.push("the diagram is in pieces");
  if (branches(g).length < 1) out.push("no step has two ways out, so there is no failure branch");
  if (loop ? !hasCycle(g) : !g.nodes.some((n) => FAILURE.test(n.label))) out.push(loop ? "no arrow leads back, as the person answered" : "no step is a failure");
  return out;
}
const sameShape = (g: Graph, want: { nodes: string[]; edges: string[] }): string[] => {
  const got = shape(g);
  return JSON.stringify(got) === JSON.stringify({ nodes: [...want.nodes].sort(), edges: [...want.edges].sort() }) ? [] : [`the diagram is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`];
};

export const SCENARIOS: Scenario[] = [
  { name: "login-flow", start: EMPTY, instruction: "Draw a login flow with 3 steps and a failure branch", check: (g) => drawing(g, { loop: false }) },
  { name: "ask-failure", start: EMPTY, instruction: "Draw a login flow with 3 steps and a failure branch, and ask me where a failure should lead", answer: "Back to the first step", check: (g) => drawing(g, { loop: true }) },
  {
    name: "insert-step",
    start: text('n1["Push code"]', 'n2["Run tests"]', 'n3["Deploy"]', "n1 --> n2", "n2 --> n3"),
    instruction: "Add a 'Build image' step between 'Run tests' and 'Deploy'",
    check: (g) => sameShape(g, { nodes: ["Push code", "Run tests", "Build image", "Deploy"], edges: ["Push code||Run tests", "Run tests||Build image", "Build image||Deploy"] }),
  },
  {
    name: "tidy",
    start: text('n1["Push code"]', 'n2["Run tests"]', 'n3["Build image"]', 'n4["Deploy"]', 'n5["Notify team"]', "n1 --> n2", "n2 -->|Pass| n3", "n3 --> n4", "n4 --> n5"),
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
  /** How the person's lines get into the panel (default: all at once; the demo types them letter by letter). */
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
  const offered = new Set([...STEPS, ...ARROWS, ...quoted(scenario.instruction)]);
  for (const l of [...g.nodes.map((n) => n.label), ...labels]) if (!offered.has(l)) out.push(`"${l}" is not a label that was offered`);
  const last = o.messages.at(-1);
  if (last?.kind !== "result") out.push(`the panel does not end with the result: ${last ? `[${last.kind}] ${last.text}` : "nothing"}`);
  const asked = o.messages.filter((m) => m.kind === "question").length;
  if (asked !== (scenario.answer ? 1 : 0)) out.push(`the panel asked ${asked} questions`);
  if (o.messages.filter((m) => m.kind === "progress").length < 1) out.push("the panel shows no steps");
  if (o.fieldLeftOver !== "") out.push(`something was typed into the panel's field: "${o.fieldLeftOver}"`);
  return out;
}
