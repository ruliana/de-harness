/**
 * The probe behind the two-level design: do the screenshots of runs that worked tell Jev which tactic comes next?
 *
 * The runs are the spelled-out ones of examples/storefront-browser (the mode that went 5/5), on the loopback look-alike shop. Each of
 * their steps is named as a tactic by code, from the tool and the page it acted on; the deciding level then sees only that step's
 * screenshot and picks a tactic, with no page text. The test counts how often the two agree. `npm test` replays the recorded run
 * (tests/cassettes/storefront-browser) and the recorded answers (tests/cassettes/tactic-probe); `npm run test:live` runs five fresh
 * runs and prints the match rates. The real aloyoga.com is measured by hand: `npm run example:probe -- --site live`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CassetteModel, cassetteMode, type BrowserSession, type DecisionModel, type DecisionRequest } from "../../../src/index.js";
import { launchFixture, runOnce, startFixture } from "../../../examples/storefront-browser/run.js";
import { plainTask } from "../../../examples/storefront-browser/shopping.js";
import type { ShopSite } from "../../../examples/storefront-browser/shop-site.js";
import { formatReport, probeSteps, report, scoreSteps, VARIANTS, type ProbeStep, type Scored } from "../../../examples/storefront-by-sight/probe.js";
import { TACTIC_IDS } from "../../../examples/storefront-by-sight/tactics.js";

const live = cassetteMode() !== "replay";
const RUNS = live ? 5 : 1;
/** What the probe has to reach for the design to be worth building. */
const BAR = 0.8;

let site: ShopSite;
const steps: ProbeStep[] = [];
const scored: Scored[] = [];
const sent: DecisionRequest[] = [];

/** Records what is asked, so that the test can check that no page text went out. */
const spy = (inner: DecisionModel): DecisionModel => ({ id: inner.id, ask: (r) => (sent.push(structuredClone(r)), inner.ask(r)) });

beforeAll(async () => {
  site = await startFixture();
  for (let i = 0; i < RUNS; i++) {
    // The first run is the one `npm test` replays, so only it is recorded; the other live runs measure and write nothing.
    const mode = i === 0 ? undefined : "passthrough";
    const browser: BrowserSession = await launchFixture();
    try {
      const o = await runOnce({ kind: "fixture", browser, home: `${site.url}/`, model: new CassetteModel({ dir: "tests/cassettes/storefront-browser", mode, apiKey: process.env.TYPESAFE_API_KEY }), maxSteps: 14 });
      const mine = probeSteps(`run ${i + 1}`, o.result);
      steps.push(...mine);
      scored.push(...(await scoreSteps(spy(new CassetteModel({ dir: "tests/cassettes/tactic-probe", mode, apiKey: process.env.TYPESAFE_API_KEY })), plainTask("the shop"), mine)));
    } finally {
      await browser.close();
    }
  }
}, live ? 20 * 60_000 : 120_000);
afterAll(async () => {
  await site?.close();
});

describe("tactic probe: does the screenshot alone say what to do next?", () => {
  it("names every step of the spelled-out run by a tactic, in the order a person goes through the shop", () => {
    const first = steps.filter((s) => s.run === "run 1").map((s) => s.truth);
    expect(first.length).toBeGreaterThanOrEqual(6);
    for (const needed of ["open_menu", "pick_menu_entry", "scroll", "click_item", "select_option", "read_value", "end"]) expect(first, `no ${needed}`).toContain(needed);
    expect(first.indexOf("open_menu")).toBeLessThan(first.indexOf("pick_menu_entry"));
    expect(first.indexOf("click_item")).toBeLessThan(first.indexOf("select_option"));
    expect(first.at(-1)).toBe("end");
  });

  it("asks about the screenshot only: no page text, address or title in any request", () => {
    expect(sent.length).toBeGreaterThan(0);
    for (const r of sent) {
      expect(JSON.stringify(r.state) + JSON.stringify(r.questions)).not.toMatch(/127\.0\.0\.1|Nimbus|https?:\/\//);
      expect(Object.keys((r.state as { state: object }).state).every((k) => ["screen", "judgments", "done"].includes(k))).toBe(true);
    }
  });

  it("always picks one of the tactics", () => {
    expect(scored.length).toBe(steps.length);
    for (const s of scored) for (const v of VARIANTS) expect(TACTIC_IDS as string[]).toContain(s.picks[v].tactic);
  });

  it(`picks the tactic the run took on at least ${BAR * 100}% of the steps, when it knows what is done (alone, and with the judgments)`, () => {
    const r = report(scored);
    if (live) console.log("\n" + formatReport(r, `Tactic probe on the fixture shop, live (${RUNS} runs)`));
    expect(r.match.done, formatReport(r, "done")).toBeGreaterThanOrEqual(BAR);
    expect(r.match.judged, formatReport(r, "judged")).toBeGreaterThanOrEqual(BAR);
  });
});
