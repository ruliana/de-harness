/**
 * One run of the assistant behind the panel, with a scripted person: the instruction is typed into the panel, a question that comes
 * back is answered there, and what the page and the panel ended up as is read afterwards. The test and the runner (`main.ts`) share it,
 * so that what the PR reports is what the test checks.
 */
import type { DecisionModel, HarnessEvent } from "../../src/index.js";
import { BrowserSession, PageOverlay, type OverlayMessage } from "../../src/browser/index.js";
import { serve, type Handled } from "./assistant.js";
import { startCheckoutSite, type Order } from "./checkout-site.js";

/** What the person says, what they answer when asked, and the order that has to reach the shop. */
export type Scenario = { name: string; instruction: string; answer?: string; expected: Order };

const ADA = { name: "Ada Lovelace", street: "12 Analytical Row", city: "London", postcode: "EC1A 1BB" };
export const SCENARIOS: Scenario[] = [
  { name: "express", instruction: "Fill in my shipping details, choose express delivery and place the order", expected: { ...ADA, delivery: "express" } },
  { name: "ask-express", instruction: "Fill in my shipping details and ask me how fast I want it delivered, then place the order", answer: "Express please", expected: { ...ADA, delivery: "express" } },
  { name: "ask-standard", instruction: "Fill in my shipping details and ask me how fast I want it delivered, then place the order", answer: "Standard is fine", expected: { ...ADA, delivery: "standard" } },
];

export type Outcome = {
  scenario: Scenario;
  handled: Handled | undefined;
  /** The orders the shop accepted. */
  orders: Order[];
  /** Everything the panel said, the person's lines included. */
  messages: OverlayMessage[];
  /** The panel as the person sees it at the end, read from the page. */
  panel: string;
  /** Set when a question reached the panel: the number of requests to the model while it waited, and the orders the shop had by then. */
  held?: { requestsWhenAsked: number; requestsAfterWaiting: number; ordersWhenAsked: number };
  /** The pictures of the page with the panel: when the question was open and at the end (only when `shots` is set). */
  shots: Record<string, Uint8Array>;
  /** What the person typed into the field of the panel, left over. */
  fieldLeftOver: string;
  events: HarnessEvent[];
};

export type RunOptions = { scenario: Scenario; model: DecisionModel; onStep?: (line: string) => void; shots?: boolean; maxWaitMs?: number };

/** What the person waits before they answer a question (and what the loop must stay quiet for). */
const WAIT_MS = 700;

export async function runScenario(opts: RunOptions): Promise<Outcome> {
  const { scenario } = opts;
  const site = await startCheckoutSite();
  const browser = await BrowserSession.launch({ allowedHosts: ["127.0.0.1"] });
  try {
    const overlay = await PageOverlay.install(browser, { title: "Tern assistant" });
    await browser.goto(`${site.url}/checkout`);
    const events: HarnessEvent[] = [];
    const requests = () => events.filter((e) => e.type === "request").length;
    const assistant = serve({
      browser,
      overlay,
      model: opts.model,
      input: overlay.input,
      onEvent: (e) => {
        events.push(e);
        if (e.type === "tool_call") opts.onStep?.(`step ${e.step}: ${e.tool}(${JSON.stringify(e.args).slice(0, 90)})`);
      },
    });
    const shots: Record<string, Uint8Array> = {};
    let held: Outcome["held"];

    await overlay.send(scenario.instruction); // as the person does: into the panel
    const until = Date.now() + (opts.maxWaitMs ?? 20 * 60_000);
    while (assistant.handled.length === 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 200));
      if (!held && overlay.messages.some((m) => m.kind === "question")) {
        const requestsWhenAsked = requests();
        const ordersWhenAsked = site.orders.length;
        if (opts.shots) shots.question = await browser.screenshot({ everything: true });
        await new Promise((r) => setTimeout(r, WAIT_MS)); // the person thinks about it
        held = { requestsWhenAsked, requestsAfterWaiting: requests(), ordersWhenAsked };
        if (scenario.answer) await overlay.send(scenario.answer);
      }
    }
    if (opts.shots) shots.done = await browser.screenshot({ everything: true });
    const panel = await browser.evaluate(() => (document.querySelector("#de-overlay")?.shadowRoot?.querySelector(".log") as HTMLElement | null)?.innerText ?? "", 0);
    const fieldLeftOver = await browser.evaluate(() => (document.querySelector("#de-overlay")?.shadowRoot?.querySelector("input") as HTMLInputElement | null)?.value ?? "", 0);
    const outcome: Outcome = { scenario, handled: assistant.handled[0], orders: [...site.orders], messages: [...overlay.messages], panel, held, shots, fieldLeftOver, events };
    await assistant.stop();
    return outcome;
  } finally {
    await browser.close();
    await site.close();
  }
}

/** What is wrong with a run, in words; empty when it is right. Code reads the shop and the panel, never the model. */
export function problems(o: Outcome): string[] {
  const out: string[] = [];
  const { scenario } = o;
  if (!o.handled) return ["the assistant never finished the instruction"];
  if (o.handled.result.status !== "ended") out.push(`the run ${o.handled.result.status} instead of ending on its own`);
  if (o.orders.length !== 1) out.push(`the shop got ${o.orders.length} orders, not one`);
  else if (JSON.stringify(o.orders[0]) !== JSON.stringify(scenario.expected)) out.push(`the order is ${JSON.stringify(o.orders[0])}, expected ${JSON.stringify(scenario.expected)}`);
  const last = o.messages.at(-1);
  if (last?.kind !== "result" || !/Order #\d+ placed/.test(last.text)) out.push(`the panel does not end with the result: ${last ? `[${last.kind}] ${last.text}` : "nothing"}`);
  const asked = o.messages.filter((m) => m.kind === "question").length;
  if (asked !== (scenario.answer ? 1 : 0)) out.push(`the panel asked ${asked} questions`);
  if (o.messages.filter((m) => m.kind === "progress").length < 5) out.push("the panel shows fewer than five steps");
  if (o.fieldLeftOver !== "") out.push(`something was typed into the panel's field: "${o.fieldLeftOver}"`);
  return out;
}
