/**
 * "Go to the shop, find a blue sweatshirt, select size large, and get the price": the one-sentence task that failed 0/5 by sight in
 * examples/storefront-browser, now with two levels that look only at screenshots. The deciding level judges the screenshot and picks
 * a tactic; the navigating level carries it out with a Box; code checks the result and blocks circles. The shop is the loopback
 * look-alike (port 47214). Jev's answers are in tests/cassettes/storefront-by-sight: `npm test` replays one run offline,
 * `npm run test:live` records five fresh runs and prints how many were correct.
 *
 * Correct means what it meant before: a blue sweatshirt on its page with size L selected, the price the run read equal to the price
 * the shop lists (looked up by the test), and nothing added to the bag. Here it also means that nothing but pictures reached the
 * model: no page text, address or title in any request of either level.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CassetteModel, cassetteMode, type BrowserSession, type DecisionRequest, type HarnessEvent } from "../../../src/index.js";
import { FIXTURE_PORT, launchFixture, problems, startFixture } from "../../../examples/storefront-browser/run.js";
import type { Outcome } from "../../../examples/storefront-browser/run.js";
import type { ShopSite } from "../../../examples/storefront-browser/shop-site.js";
import { runBySight } from "../../../examples/storefront-by-sight/run.js";
import { TACTIC_IDS } from "../../../examples/storefront-by-sight/tactics.js";

const live = cassetteMode() !== "replay";
const RUNS = live ? 5 : 1;
const MAX_STEPS = 10;

let site: ShopSite;
const outcomes: (Outcome & { found: string | null })[] = [];
const cartAddsAfter: number[] = [];
/** The first run is the one `npm test` replays, so only it is recorded; the other live runs measure reliability and write nothing. */
const modelFor = (run: number) => new CassetteModel({ dir: "tests/cassettes/storefront-by-sight", mode: run === 0 ? undefined : "passthrough", apiKey: process.env.TYPESAFE_API_KEY });

beforeAll(async () => {
  site = await startFixture();
  for (let i = 0; i < RUNS; i++) {
    const browser: BrowserSession = await launchFixture();
    try {
      outcomes.push(await runBySight({ kind: "fixture", browser, home: `${site.url}/`, model: modelFor(i), maxSteps: MAX_STEPS }));
      cartAddsAfter.push(site.cartAdds.length);
    } finally {
      await browser.close();
    }
  }
}, live ? 20 * 60_000 : 120_000);
afterAll(async () => {
  await site?.close();
});

/** Every request of a run: the deciding level's, and the navigating level's inside `child` events. */
function requests(events: HarnessEvent[]): { level: "planner" | "navigator"; request: DecisionRequest }[] {
  const out: { level: "planner" | "navigator"; request: DecisionRequest }[] = [];
  for (const e of events) {
    if (e.type === "request") out.push({ level: "planner", request: e.request });
    if (e.type === "child" && e.event.type === "request") out.push({ level: "navigator", request: e.event.request });
  }
  return out;
}

describe("storefront by sight: the one-sentence task, a deciding level and a navigating level", () => {
  it("serves the shop on the port the recordings were made with", () => {
    expect(site.url).toBe(`http://127.0.0.1:${FIXTURE_PORT}`);
  });

  it("ends on its own, within the step limit, without an error", () => {
    for (const o of outcomes) {
      expect(o.result.error?.message, "the run failed").toBeUndefined();
      expect(o.result.status, o.trail.join("\n")).toBe("ended");
      expect(o.result.steps.length).toBeLessThanOrEqual(MAX_STEPS);
    }
  });

  it("finishes on a blue sweatshirt, size L, and reads the price the shop lists for it", () => {
    const first = outcomes[0]!;
    expect(problems(first), first.trail.join("\n")).toEqual([]);
    expect(first.facts!.size).toBe("L");
    expect(first.read).toBe(first.facts!.listedPrice);
    expect(first.read).toMatch(/^\$\d+$/);
  });

  it("decides in tactics, and goes through the page the way a person does: a menu, an entry, the list, an item, a size, the price", () => {
    const tools = outcomes[0]!.result.steps.map((s) => s.tool);
    for (const t of tools) expect(TACTIC_IDS as string[]).toContain(t);
    for (const needed of ["open_menu", "pick_menu_entry", "click_item", "select_option", "read_value"]) expect(tools, `no ${needed} step`).toContain(needed);
    expect(tools.indexOf("open_menu")).toBeLessThan(tools.indexOf("pick_menu_entry"));
    expect(tools.indexOf("pick_menu_entry")).toBeLessThan(tools.lastIndexOf("click_item"));
    expect(tools.lastIndexOf("click_item")).toBeLessThan(tools.indexOf("select_option"));
    expect(tools.indexOf("select_option")).toBeLessThan(tools.indexOf("read_value"));
    expect(tools.at(-1)).toBe("end");
  });

  it("shows the model nothing but pictures: no page text, address or title in any request of either level", () => {
    for (const o of outcomes) {
      const all = requests(o.result.events);
      expect(all.some((r) => r.level === "navigator"), "the navigating level never ran").toBe(true);
      for (const { level, request } of all) {
        const state = (request.state as { state: Record<string, unknown> }).state;
        const body = JSON.stringify(request.state) + JSON.stringify(request.questions);
        expect(body, `a request of the ${level} holds an address or a title`).not.toMatch(/127\.0\.0\.1|Nimbus|https?:\/\//);
        if (level === "planner") expect(Object.keys(state).every((k) => ["screen", "judgments", "done", "last_try", "stuck"].includes(k)), `planner state: ${Object.keys(state).join(", ")}`).toBe(true);
        else expect(Object.keys((state.page as Record<string, unknown> | undefined) ?? {}), "navigator page").toEqual(["scroll"]);
      }
    }
  });

  it("is reliable: every replayed run is correct, and at least four of five live ones", () => {
    const correct = outcomes.filter((o) => problems(o).length === 0).length;
    if (live) {
      const lines = outcomes.map((o) => `${problems(o).length ? "MISS" : "ok  "} ${o.result.steps.length} planner steps (${o.result.steps.map((s) => s.tool).join(" ")}), read ${o.read ?? "nothing"}${problems(o).length ? `: ${problems(o).join("; ")}` : ""}`);
      console.log(`\nStorefront by sight, live summary: ${correct} of ${RUNS} runs correct\n${lines.join("\n")}`);
    }
    expect(correct).toBeGreaterThanOrEqual(live ? 4 : RUNS);
  });

  it("only reads: nothing was added to the bag, and no write request reached the shop", () => {
    expect(site.cartAdds).toEqual([]);
    expect(cartAddsAfter.every((n) => n === 0)).toBe(true);
    expect(site.requests.filter((r) => r.startsWith("POST "))).toEqual([]);
  });
});
