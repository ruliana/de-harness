/**
 * Helpers of the behaviour suite: run an agent against one of the small worlds and describe what changed in it.
 * Every scenario runs once in `beforeAll`, with Jev answered from tests/cassettes/behaviour (replay) or live (test:live).
 */
import { createAgent, type ReviewConfig, type RunResult } from "../../../src/index.js";
import { startTicketServer, type Ticket } from "../../../examples/tickets/server.js";
import { createTicketDesk } from "../../../examples/tickets/tickets.js";
import { createTransit } from "../../../examples/graph/transit.js";
import { createDesk } from "../../support/desk.js";
import { jevFor } from "../../support/models.js";
import { createWebshop } from "../../support/webshop.js";

/** What the run did to the tickets: `#7 status closed`, `#1 team billing`, `#5 tag urgent`. Empty when nothing changed. */
export function ticketChanges(before: Ticket[], after: Ticket[]): string[] {
  return after.flatMap((t, i) => {
    const b = before[i]!;
    return [
      ...(t.team !== b.team ? [`#${t.id} team ${t.team}`] : []),
      ...(t.status !== b.status ? [`#${t.id} status ${t.status}`] : []),
      ...t.tags.filter((tag) => !b.tags.includes(tag)).map((tag) => `#${t.id} tag ${tag}`),
    ];
  });
}

export type TicketRun = { result: RunResult; changes: string[]; requests: number; summary: string };

const model = () => jevFor("behaviour");
/**
 * The review every agent of this suite runs with: the end is checked, and so is every call of a tool that changes
 * something. BEHAVIOUR_REVIEW (JSON, or `none`) overrides it in a live run, to see what a fix is worth on its own.
 */
export const REVIEW: ReviewConfig | undefined =
  process.env.BEHAVIOUR_REVIEW === "none" ? undefined : process.env.BEHAVIOUR_REVIEW ? (JSON.parse(process.env.BEHAVIOUR_REVIEW) as ReviewConfig) : { end: true, actions: true };
const reviews = (r: RunResult) =>
  r.events.flatMap((e) => (e.type === "review" ? [`${e.check === "end" ? "end?" : e.call}: ${e.p.toFixed(2)}${e.ready !== undefined ? `/ready ${e.ready.toFixed(2)}` : ""}${e.refused ? " REFUSED" : ""}`] : [])).join(" | ");
const requestsOf = (r: RunResult) => r.events.filter((e) => e.type === "request").length;

/** The plain desk of tests/support/desk.ts (assign, set_status, tag, end) on a fresh ticket server. */
export async function runPlainDesk(instructions: string, maxSteps = 12): Promise<TicketRun> {
  const server = await startTicketServer();
  try {
    const before = server.snapshot();
    const desk = await createDesk(server.url);
    const result = await createAgent({ model: model(), instructions, tools: desk.tools, initialState: desk.initialState, maxSteps, ...(REVIEW ? { review: REVIEW } : {}) }).run();
    const changes = ticketChanges(before, server.snapshot());
    return { result, changes, requests: requestsOf(result), summary: `${changes.join(", ") || "no change"}; ${result.status} after ${result.steps.map((s) => s.tool).join(" > ")}${REVIEW ? ` [${reviews(result)}]` : ""}` };
  } finally {
    await server.close();
  }
}

/** The shipped examples/tickets desk, with its own guards, on a fresh ticket server. */
export async function runShippedDesk(instructions: string, maxSteps = 20): Promise<TicketRun> {
  const server = await startTicketServer();
  try {
    const before = server.snapshot();
    const desk = await createTicketDesk(server.url);
    const result = await createAgent({ model: model(), instructions, tools: desk.tools, initialState: desk.initialState, maxSteps, ...(REVIEW ? { review: REVIEW } : {}) }).run();
    const changes = ticketChanges(before, server.snapshot());
    return { result, changes, requests: requestsOf(result), summary: `${changes.join(", ") || "no change"}; ${result.status} after ${result.steps.length} steps${REVIEW ? ` [${reviews(result)}]` : ""}` };
  } finally {
    await server.close();
  }
}

export type ShopRun = { result: RunResult; basket: string[]; orders: string[][]; trail: string[]; summary: string };

/** The shop of tests/support/webshop.ts; `basket` puts items in the basket before the run. */
export async function runShop(instructions: string, opts: { basket?: string[]; maxSteps?: number } = {}): Promise<ShopRun> {
  const shop = createWebshop();
  if (opts.basket?.length) {
    shop.world.basket.push(...opts.basket);
    shop.initialState.basket = [...opts.basket];
  }
  const result = await createAgent({ model: model(), instructions, tools: shop.tools, initialState: shop.initialState, maxSteps: opts.maxSteps ?? 10, ...(REVIEW ? { review: REVIEW } : {}) }).run();
  const { basket, orders, trail } = shop.world;
  return { result, basket: [...basket], orders: orders.map((o) => [...o]), trail: [...trail], summary: `basket [${basket.join(", ")}], orders ${JSON.stringify(orders)}; ${result.status} after ${result.steps.map((s) => s.tool).join(" > ")}${REVIEW ? ` [${reviews(result)}]` : ""}` };
}

export type TransitRun = { result: RunResult; path: string[]; summary: string };

export async function runTransit(start: string, instructions: string, maxSteps = 10): Promise<TransitRun> {
  const transit = createTransit({ start });
  const result = await createAgent({ model: model(), instructions, tools: transit.tools, initialState: transit.initialState, maxSteps, ...(REVIEW ? { review: REVIEW } : {}) }).run();
  const path = [...transit.world.path];
  return { result, path, summary: `${path.join(" > ")}; ${result.status}${REVIEW ? ` [${reviews(result)}]` : ""}` };
}
