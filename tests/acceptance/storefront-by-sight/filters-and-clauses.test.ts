/**
 * Two things real shops do to the by-sight agent, reproduced on a loopback outfitter's shop (tests/support/outfitter-site.ts, port 47215)
 * in a real headless Chromium:
 *
 *   1. The item is not in the list at all. The first 18 of 212 t-shirts hold no red one, and a closed "Colour" section in the side bar is the
 *      only way to one. Scrolling never shows it, so the deciding level needs a tactic that uses the filters (`filter`).
 *   2. The task says "size 10", and the boots list has a "Size" section next to the boots. The navigating level that picks the item
 *      used to read the whole task and clicked "10" in the side bar. Each tactic's navigator now reads only the clauses it needs.
 *
 * Jev's answers are in tests/cassettes/storefront-by-sight-outfitter: `npm test` replays one run of each, `npm run test:live` records the
 * first and runs more fresh ones, and prints how many were correct.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CassetteModel, cassetteMode, type DecisionRequest, type HarnessEvent } from "../../../src/index.js";
import type { BrowserSession } from "../../../src/browser/index.js";
import { launchFixture, runBySight } from "../../../examples/storefront-by-sight/run.js";
import { shopTask } from "../../../examples/storefront-by-sight/tactics.js";
import { OUTFITTER_PORT, productFor, startOutfitterSite, type OutfitterSite } from "../../support/outfitter-site.js";

const live = cassetteMode() !== "replay";
const RUNS = live ? 5 : 1;
const MAX_STEPS = 10;

type Run = Awaited<ReturnType<typeof runBySight>> & { requests: string[]; cartAdds: number };
let site: OutfitterSite;
const tees: Run[] = [];
const boots: Run[] = [];

/** The first run of each is the one `npm test` replays, so only it is recorded; the other live runs measure reliability and write nothing. */
const modelFor = (dir: string, run: number) => new CassetteModel({ dir: `tests/cassettes/storefront-by-sight-outfitter/${dir}`, mode: run === 0 ? undefined : "passthrough", apiKey: process.env.TYPESAFE_API_KEY });

async function scenario(out: Run[], dir: string, what: string, size: string) {
  for (let i = 0; i < RUNS; i++) {
    const browser: BrowserSession = await launchFixture();
    const before = site.requests.length;
    const adds = site.cartAdds.length;
    try {
      const o = await runBySight({ kind: "fixture", browser, home: `${site.url}/`, model: modelFor(dir, i), task: shopTask("the shop", what, size), maxSteps: MAX_STEPS });
      out.push({ ...o, requests: site.requests.slice(before).filter((r) => !r.includes("/fonts/")), cartAdds: site.cartAdds.length - adds });
    } finally {
      await browser.close();
    }
  }
}

beforeAll(async () => {
  site = await startOutfitterSite({ port: OUTFITTER_PORT });
  await scenario(tees, "red-t-shirt", "a red t-shirt", "medium");
  await scenario(boots, "brown-boots", "a pair of brown boots", "10");
}, live ? 30 * 60_000 : 120_000);
afterAll(async () => {
  await site?.close();
});

/** Every request of the navigating level, with its instructions. */
function navigatorRequests(events: HarnessEvent[]): { instructions: string; request: DecisionRequest }[] {
  const out: { instructions: string; request: DecisionRequest }[] = [];
  for (const e of events) if (e.type === "child" && e.event.type === "request") out.push({ instructions: (e.event.request.state as { instructions: string }).instructions, request: e.event.request });
  return out;
}

/** Why a run is wrong; empty means correct: on the product page asked for, the size selected, the price the shop lists read. */
function problems(o: Run, colour: string, kind: "tee" | "boot", size: string): string[] {
  const out: string[] = [];
  if (o.result.status !== "ended") out.push(`run ${o.result.status}${o.result.error ? `: ${o.result.error.message}` : ""}`);
  const f = o.facts;
  if (!f) return [...out, "did not end on a product page"];
  const p = productFor(f.url.split("/").pop() ?? "");
  if (f.colour !== colour) out.push(`colour ${f.colour ?? "none"}`);
  if (p?.kind !== kind) out.push(`${f.product} is not a ${kind}`);
  if (f.size !== size) out.push(`size ${f.size ?? "none"} selected`);
  if (o.read === null) out.push("read no price");
  else if (o.read !== `$${p?.price}`) out.push(`read ${o.read}, the shop lists $${p?.price}`);
  return out;
}
const tee = (o: Run) => problems(o, "Red", "tee", "M");
const boot = (o: Run) => problems(o, "Brown", "boot", "10");

function summary(title: string, runs: Run[], check: (o: Run) => string[]) {
  const correct = runs.filter((o) => check(o).length === 0).length;
  if (live) {
    const lines = runs.map((o) => `${check(o).length ? "MISS" : "ok  "} ${o.result.steps.length} steps (${o.result.steps.map((s) => s.tool).join(" ")})${check(o).length ? `: ${check(o).join("; ")}` : ""}`);
    console.log(`\n${title}, live summary: ${correct} of ${RUNS} runs correct\n${lines.join("\n")}`);
  }
  return correct;
}

describe("a list that does not hold the item: use its filters", () => {
  it("serves the shop on the port the recordings were made with", () => {
    expect(site.url).toBe(`http://127.0.0.1:${OUTFITTER_PORT}`);
  });

  it("finds a red t-shirt that no screen of the list shows, with the colour filter, and reads the price the shop lists", () => {
    const first = tees[0]!;
    expect(first.result.error?.message, "the run failed").toBeUndefined();
    expect(tee(first), first.trail.join("\n")).toEqual([]);
    const tools = first.result.steps.map((s) => s.tool);
    expect(tools, "no filter step").toContain("filter");
    expect(tools.indexOf("filter")).toBeLessThan(tools.indexOf("click_item"));
    expect(first.requests.some((r) => r.includes("colour=Red")), first.requests.join("\n")).toBe(true);
    expect(first.result.steps.length).toBeLessThanOrEqual(MAX_STEPS);
  });

  it("is reliable: every replayed run is correct, and at least four of five live ones", () => {
    expect(summary("Red t-shirt behind a filter", tees, tee)).toBeGreaterThanOrEqual(live ? 4 : RUNS);
  });
});

describe("a task with a size, on a list with a size filter: each step reads only its part of the task", () => {
  it("picks a boot, not the size in the side bar, and ends on a brown pair with size 10 selected and the price the shop lists", () => {
    const first = boots[0]!;
    expect(first.result.error?.message, "the run failed").toBeUndefined();
    expect(boot(first), first.trail.join("\n")).toEqual([]);
    expect(first.requests.filter((r) => /[?&]size=/.test(r)), "clicked the size filter of the list").toEqual([]);
  });

  it("tells the navigating level of each step the clauses of the task that step needs, and no others", () => {
    for (const o of boots) {
      const nav = navigatorRequests(o.result.events).map((n) => n.instructions);
      const picks = nav.filter((i) => /Click the item that the task asks for/.test(i));
      expect(picks.length, "no click on an item").toBeGreaterThan(0);
      for (const i of picks) {
        expect(i).toMatch(/brown boots/);
        expect(i, "the item-picking step reads the size").not.toMatch(/size|10/i);
      }
      const options = nav.filter((i) => /Click the option that the task asks for/.test(i));
      expect(options.length, "no choice of an option").toBeGreaterThan(0);
      for (const i of options) {
        expect(i).toMatch(/size 10/);
        expect(i, "the option step reads the item").not.toMatch(/boots/i);
      }
    }
  });

  it("is reliable: every replayed run is correct, and at least four of five live ones", () => {
    expect(summary("Brown boots with a size filter", boots, boot)).toBeGreaterThanOrEqual(live ? 4 : RUNS);
  });
});

describe("both: pictures only, and nothing added to the bag", () => {
  it("shows the model no page text, address or title, and adds nothing to the bag", () => {
    for (const o of [...tees, ...boots]) {
      const all = [...o.result.events.flatMap((e) => (e.type === "request" ? [e.request] : [])), ...navigatorRequests(o.result.events).map((n) => n.request)];
      for (const r of all) expect(JSON.stringify(r.state) + JSON.stringify(r.questions), "an address or a title reached the model").not.toMatch(/127\.0\.0\.1|Ridgeline|https?:\/\//);
      expect(o.cartAdds).toBe(0);
    }
    expect(site.requests.filter((r) => r.startsWith("POST "))).toEqual([]);
  });
});
