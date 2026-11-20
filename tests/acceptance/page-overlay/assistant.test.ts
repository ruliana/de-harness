/**
 * The assistant behind the panel, with Jev (through a cassette): the checkout page of a small shop with the panel over it. A scripted
 * person types an instruction into the panel; the agent sees only a screenshot of the page (without the panel), clicks and types on
 * the page through Boxes, and the panel shows the steps, a question when it has one, and the result. Jev's answers are in
 * tests/cassettes/page-overlay: `npm test` replays one run of each scenario offline, `npm run test:live` records them and runs two
 * more of each, then prints how many of them came out right.
 *
 * Right means: the shop received exactly the order the person asked for (the details typed from the person's profile, the delivery
 * they chose, the button that lies under the panel pressed), the panel shows the steps and ends with the result, and nothing was typed
 * into the panel itself. A question holds the loop: while it is open, the model gets no new request and the shop no order.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { CassetteModel, cassetteMode } from "../../../src/index.js";
import { SCENARIOS, problems, runScenario, type Outcome, type Scenario } from "../../../examples/page-overlay/run.js";

const live = cassetteMode() !== "replay";
const RUNS = live ? 3 : 1;
/** The first run of a scenario is the one `npm test` replays, so only it is recorded; the other live runs measure reliability and write nothing. */
const modelFor = (run: number) => new CassetteModel({ dir: "tests/cassettes/page-overlay", mode: run === 0 ? undefined : "passthrough", apiKey: process.env.TYPESAFE_API_KEY });

const outcomes = new Map<string, Outcome[]>();
beforeAll(async () => {
  for (const scenario of SCENARIOS) {
    const runs: Outcome[] = [];
    for (let i = 0; i < RUNS; i++) runs.push(await runScenario({ scenario, model: modelFor(i) }));
    outcomes.set(scenario.name, runs);
  }
}, live ? 40 * 60_000 : 180_000);

const first = (name: string) => outcomes.get(name)![0]!;
const scenario = (name: string): Scenario => SCENARIOS.find((s) => s.name === name)!;

describe("page overlay assistant: an instruction typed into the panel operates the page behind it", () => {
  it("fills in the details, picks express and places the order, as the instruction says", () => {
    const o = first("express");
    expect(problems(o), o.messages.map((m) => `[${m.kind}] ${m.text}`).join("\n")).toEqual([]);
    expect(o.orders).toEqual([scenario("express").expected]);
    expect(o.handled!.result.status).toBe("ended");
  });

  it("shows the person each step in the panel, then the result, which is also what the page itself says", () => {
    const o = first("express");
    const kinds = o.messages.map((m) => m.kind);
    expect(kinds[0]).toBe("user");
    expect(o.messages[0]!.text).toBe(scenario("express").instruction);
    expect(kinds.filter((k) => k === "progress").length).toBeGreaterThanOrEqual(8); // four fields (a click and the typing each), the delivery, the button
    expect(o.messages.filter((m) => m.kind === "progress").map((m) => m.text)).toEqual(expect.arrayContaining(['Typed "Ada Lovelace" into the field', 'Typed "EC1A 1BB" into the field']));
    expect(kinds.at(-1)).toBe("result");
    expect(o.messages.at(-1)!.text).toMatch(/Order #1001 placed.*Express.*Ada Lovelace/);
    expect(o.panel).toContain(o.messages.at(-1)!.text); // what the person reads in the panel
    expect(kinds).not.toContain("question"); // nothing was left open
  });

  it("acts on the page and never on the panel: nothing typed into the panel, no click on it, the person's lines are the only ones from them", () => {
    for (const runs of outcomes.values()) {
      for (const o of runs) {
        expect(o.fieldLeftOver).toBe("");
        expect(o.messages.filter((m) => m.kind === "user").map((m) => m.text)).toEqual(o.scenario.answer ? [o.scenario.instruction, o.scenario.answer] : [o.scenario.instruction]);
      }
    }
  });

  it("asks when the instruction leaves the delivery to the person: the question is in the panel, the loop holds, and the answer decides", () => {
    for (const name of ["ask-express", "ask-standard"]) {
      const o = first(name);
      expect(problems(o), o.messages.map((m) => `[${m.kind}] ${m.text}`).join("\n")).toEqual([]);
      const kinds = o.messages.map((m) => m.kind);
      const asked = kinds.indexOf("question");
      expect(o.messages[asked]!.text).toBe("Which delivery do you want, Standard or Express?");
      expect(o.messages[asked + 1]).toEqual({ kind: "user", text: scenario(name).answer });
      expect(o.orders.map((x) => x.delivery)).toEqual([scenario(name).expected.delivery]);
      // held: while the question was open, no request went to the model and no order reached the shop
      expect(o.held!.requestsAfterWaiting).toBe(o.held!.requestsWhenAsked);
      expect(o.held!.ordersWhenAsked).toBe(0);
      // and it went on after the answer, to the end
      expect(kinds.slice(asked + 2).filter((k) => k === "progress").length).toBeGreaterThanOrEqual(1);
      expect(kinds.at(-1)).toBe("result");
    }
  });

  it("does not ask when the instruction already says what it needs", () => {
    for (const o of outcomes.get("express")!) expect(o.messages.some((m) => m.kind === "question")).toBe(false);
  });

  it(`is reliable: every replayed run is correct, and at least ${RUNS === 1 ? "all" : "two of three"} live ones of each scenario`, () => {
    const lines: string[] = [];
    for (const [name, runs] of outcomes) {
      const correct = runs.filter((o) => problems(o).length === 0).length;
      lines.push(`${name}: ${correct} of ${runs.length} correct (${runs.map((o) => o.handled?.result.steps.length ?? "-").join(", ")} steps)${runs.flatMap((o) => problems(o)).length ? `\n   ${runs.flatMap((o) => problems(o)).join("\n   ")}` : ""}`);
      expect(correct).toBeGreaterThanOrEqual(live ? 2 : RUNS);
    }
    if (live) console.log(`\nPage overlay, live summary\n${lines.join("\n")}`);
  });
});
