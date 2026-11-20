/**
 * Navigating Wikipedia with Jev, tested in the wild.
 *
 * Articles come from tests/cassettes/wikipedia-http (revisions fixed at SNAPSHOT) and Jev's answers from
 * tests/cassettes/wikipedia, so `npm test` is deterministic and keyless. `npm run test:live` asks Jev again and
 * reports how many of the pairs it solves; the recordings of a live run replace the old ones.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_BUDGET, ScriptedModel, TOOL_QUESTION, cassetteMode, createAgent, requestTokens, type RunResult } from "../../../src/index.js";
import { wikipediaFetch } from "../../../examples/wikipedia/http.js";
import { createWikipedia, instructionsFor } from "../../../examples/wikipedia/wikipedia.js";
import { jevFor } from "../../support/models.js";

const live = cassetteMode() !== "replay";
/** A live run waits for Wikipedia's rate limit as often as it is told to. */
const LIVE_TIMEOUT = 2 * 60 * 60 * 1000;
const timeout = live ? LIVE_TIMEOUT : 60_000;
const http = () => wikipediaFetch({ dir: "tests/cassettes/wikipedia-http" });

const BUDGET_TOKENS = DEFAULT_CONTEXT_BUDGET;
const estimateTokens = requestTokens;

type Pair = { from: string; to: string; why: string };

/** The start article links straight to the target: open it, then stop. */
const ONE_HOP: Pair = { from: "Alan Turing", to: "Enigma machine", why: "the lead names it" };

/**
 * Five fixed pairs, each needing two or three clicks. `why` is the route a reader would take; the agent may find
 * another. None of the targets is among the links offered on the start article.
 */
const MULTI_HOP: Pair[] = [
  { from: "Volcano", to: "Pompeii", why: "Volcano > Mount Vesuvius > Pompeii" },
  { from: "Penicillin", to: "Imperial College London", why: "Penicillin > Alexander Fleming > Imperial College London" },
  { from: "Telescope", to: "Jupiter", why: "Telescope > Galileo Galilei > Jupiter" },
  { from: "Linux", to: "Helsinki", why: "Linux > Linus Torvalds > Helsinki" },
  { from: "Mount Everest", to: "Hinduism", why: "Mount Everest > Nepal > Hinduism" },
];

type Outcome = { pair: Pair; result: RunResult; trail: string[]; reached: boolean; pages: { title: string; links: number }[] };
const outcomes = new Map<string, Outcome>();

async function navigate(pair: Pair, maxSteps: number): Promise<Outcome> {
  const wiki = await createWikipedia({ start: pair.from, fetch: http() });
  const result = await createAgent({ model: jevFor("wikipedia"), instructions: instructionsFor(pair.from, pair.to), tools: wiki.tools, initialState: wiki.initialState, maxSteps }).run();
  return { pair, result, trail: wiki.trail(), reached: result.status === "ended" && wiki.current().title === pair.to, pages: wiki.pages().map((p) => ({ title: p.title, links: p.links.length })) };
}

describe("wikipedia: one hop", () => {
  let outcome: Outcome;
  beforeAll(async () => {
    outcome = await navigate(ONE_HOP, 3);
    outcomes.set(ONE_HOP.from, outcome);
  }, timeout);

  it("ends within 3 steps on the target page", () => {
    expect(outcome.result.error?.message).toBeUndefined();
    expect(outcome.result.status).toBe("ended");
    expect(outcome.result.steps.length).toBeLessThanOrEqual(3);
    expect(outcome.trail.at(-1)).toBe(ONE_HOP.to);
  });
});

describe("wikipedia: several hops", () => {
  beforeAll(async () => {
    for (const pair of MULTI_HOP) outcomes.set(pair.from, await navigate(pair, 10));
  }, timeout);

  it.each(MULTI_HOP.map((p) => [`${p.from} -> ${p.to}`, p] as const))("%s: reaches the target within 10 steps", (_name, pair) => {
    const o = outcomes.get(pair.from)!;
    expect(o.result.error?.message, "the run failed before the end").toBeUndefined();
    if (!live) {
      expect(o.reached, `trail: ${o.trail.join(" > ")}`).toBe(true);
      expect(o.result.steps.length).toBeLessThanOrEqual(10);
    }
  });

  it("solves all five in replay, and at least four of five live", () => {
    const solved = MULTI_HOP.filter((p) => outcomes.get(p.from)!.reached);
    if (live) {
      const lines = [ONE_HOP, ...MULTI_HOP].map((p) => {
        const o = outcomes.get(p.from)!;
        return `${o.reached ? "ok  " : "MISS"} ${o.result.steps.length} steps, ${o.result.steps.length} Jev requests: ${o.trail.join(" > ")}`;
      });
      console.log(`\nWikipedia live summary: ${solved.length} of ${MULTI_HOP.length} multi-hop pairs solved\n${lines.join("\n")}`);
    }
    expect(solved.length).toBeGreaterThanOrEqual(live ? 4 : MULTI_HOP.length);
  });
});

describe("wikipedia: the request budget", () => {
  it("no request to Jev exceeds the budget, and neither does one on the largest page of the set", async () => {
    const all = [...outcomes.values()];
    for (const o of all) {
      for (const step of o.result.steps) expect(estimateTokens(step.request)).toBeLessThanOrEqual(BUDGET_TOKENS);
      expect(o.result.events.filter((e) => e.type === "two_phase" || e.type === "trimmed" || e.type === "budget_exceeded")).toEqual([]); // links are cut in code, so the harness never has to
    }

    const largest = all.flatMap((o) => o.pages).reduce((a, b) => (b.links > a.links ? b : a));
    const wiki = await createWikipedia({ start: largest.title, fetch: http() });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "end" }]);
    await createAgent({ model, instructions: instructionsFor(largest.title, "anywhere"), tools: wiki.tools, initialState: wiki.initialState, maxSteps: 1 }).run();
    const request = model.requests[0]!;
    const options = Object.keys((request.questions["open_link.link"] as { criteria: object }).criteria);
    expect(largest.links).toBeGreaterThan(options.length); // the page really was cut
    expect(options.length).toBeLessThanOrEqual(255);
    expect(estimateTokens(request)).toBeLessThanOrEqual(BUDGET_TOKENS);
  }, timeout);
});
