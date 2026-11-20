/**
 * "Go to the shop, find a blue sweatshirt, select size large, and get the price", with Jev, a real headless browser, screenshots
 * and boxes. The shop is a look-alike on loopback (examples/storefront-browser/shop-site.ts: a menu that opens on hover, a grid that
 * continues below the fold, a size picker, an "Add to bag" button), so the page is the same on every machine and the screenshots
 * can be recorded. Jev's answers are in tests/cassettes/storefront-browser: `npm test` replays one run offline; `npm run test:live`
 * records five fresh runs and prints how many were correct. The real aloyoga.com is run by hand: `npm run example:storefront-browser`.
 *
 * Correct means: the run ended on the page of a blue sweatshirt with size L selected, and the price it read from the screenshot is
 * the price the shop lists for that colour and size (looked up by the test, not trusted from the run), and nothing was added to the bag.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CassetteModel, cassetteMode } from "../../../src/index.js";
import type { BrowserSession } from "../../../src/browser/index.js";
import { FIXTURE_PORT, launchFixture, problems, runOnce, startFixture, type Outcome } from "../../../examples/storefront-browser/run.js";
import type { ShopSite } from "../../../examples/storefront-browser/shop-site.js";

const live = cassetteMode() !== "replay";
const RUNS = live ? 5 : 1;
const MAX_STEPS = 14;

let site: ShopSite;
const outcomes: Outcome[] = [];

/** The first run is the one that `npm test` replays, so only it is recorded; the other live runs measure reliability and write nothing. */
const modelFor = (run: number) => new CassetteModel({ dir: "tests/cassettes/storefront-browser", mode: run === 0 ? undefined : "passthrough", apiKey: process.env.TYPESAFE_API_KEY });
const cartAddsAfter: number[] = [];

beforeAll(async () => {
  site = await startFixture();
  for (let i = 0; i < RUNS; i++) {
    const browser: BrowserSession = await launchFixture();
    try {
      outcomes.push(await runOnce({ kind: "fixture", browser, home: `${site.url}/`, model: modelFor(i), maxSteps: MAX_STEPS }));
      cartAddsAfter.push(site.cartAdds.length);
    } finally {
      await browser.close();
    }
  }
}, live ? 15 * 60_000 : 120_000);
afterAll(async () => {
  await site?.close();
});

describe("storefront in a browser: a blue sweatshirt in large, and its price, seen only as pictures", () => {
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

  it("goes through the page the way a person does: opens the shop, opens a menu by hovering, scrolls, picks a size, points at the price", () => {
    const tools = outcomes[0]!.result.steps.map((s) => s.tool);
    expect(tools[0]).toBe("navigate");
    for (const needed of ["hover", "click", "scroll", "read_price"]) expect(tools, `no ${needed} step`).toContain(needed);
    expect(tools.indexOf("hover")).toBeLessThan(tools.indexOf("scroll"));
    expect(tools.indexOf("scroll")).toBeLessThan(tools.indexOf("read_price"));
    expect(tools.at(-1)).toBe("end");
  });

  it("is reliable: every replayed run is correct, and at least four of five live ones", () => {
    const correct = outcomes.filter((o) => problems(o).length === 0).length;
    if (live) {
      const lines = outcomes.map((o) => `${problems(o).length ? "MISS" : "ok  "} ${o.result.steps.length} steps, read ${o.read ?? "nothing"}, on ${o.facts ? `${o.facts.product} / ${o.facts.colour} / ${o.facts.size}` : "no product page"}${problems(o).length ? `: ${problems(o).join("; ")}` : ""}`);
      console.log(`\nStorefront in a browser, live summary: ${correct} of ${RUNS} runs correct\n${lines.join("\n")}`);
    }
    expect(correct).toBeGreaterThanOrEqual(live ? 4 : RUNS);
  });

  it("only reads: nothing was added to the bag, and no write request reached the shop", () => {
    expect(site.cartAdds).toEqual([]);
    expect(cartAddsAfter.every((n) => n === 0)).toBe(true);
    expect(site.requests.filter((r) => r.startsWith("POST "))).toEqual([]);
  });
});
