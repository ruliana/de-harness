/**
 * The lookahead experiment as an acceptance test: the same tasks, tools, instructions, Jev and external verifier for every
 * arm; only how the next action is chosen differs.
 *
 *   greedy          the default loop: one request, Jev picks the next action
 *   review          greedy + `review: { end, actions }` with no per-tool wording (what PR 42 gives an agent out of the box)
 *   lookahead 3x2   `lookahead: { width: 3, depth: 2 }`: stop when no explored sequence improves
 *   lookahead 3x2g  the same, but when nothing improves it takes Jev's most probable safe action and observes
 *
 * Outcomes are read from the worlds (tests/support/lookahead/worlds.ts), not from the agents. Jev's answers are in
 * tests/cassettes/lookahead; `npm run test:live` asks again. The live numbers over more runs are in docs/lookahead.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { jevFor } from "../../support/models.js";
import { ARMS, runArm, type Outcome } from "../../support/lookahead/run.js";
import { SCENARIOS } from "../../support/lookahead/worlds.js";

const ARM_IDS = ["greedy", "review", "la-3x2", "la-3x2g"];
const outcomes: Outcome[] = [];
const of = (arm: string, pick: (o: Outcome) => boolean = () => true) => outcomes.filter((o) => o.arm === arm && pick(o));
const sum = (os: Outcome[], f: (o: Outcome) => number) => os.reduce((n, o) => n + f(o), 0);

beforeAll(async () => {
  const model = jevFor("lookahead");
  for (const sc of SCENARIOS) for (const arm of ARMS.filter((a) => ARM_IDS.includes(a.id))) outcomes.push(await runArm(sc, arm, model));
  console.log("\n  arm        tasks  completed  regressions  limit-breaks  requests/run");
  for (const id of ARM_IDS) {
    const os = of(id);
    console.log(`  ${id.padEnd(10)} ${String(os.length).padStart(5)}  ${String(os.filter((o) => o.complete).length).padStart(9)}  ${String(sum(os, (o) => o.regressions)).padStart(11)}  ${String(sum(os, (o) => o.violations)).padStart(12)}  ${(sum(os, (o) => o.requests) / os.length).toFixed(1).padStart(12)}`);
  }
  for (const o of outcomes.filter((x) => !x.complete)) console.log(`  not completed: ${o.arm.padEnd(8)} ${o.scenario}: ${o.failed.join(", ")}${o.stopped?.blocker ? ` (${o.stopped.blocker})` : ""}`);
}, 900_000);

describe("lookahead on tasks with prerequisites", () => {
  const prerequisite = (o: Outcome) => o.kind === "prerequisite" && o.scenario !== "deploy-41";

  it("completes every one of them whose chain is no deeper than its depth, externally verified", () => {
    const failed = of("la-3x2", prerequisite).filter((o) => !o.complete);
    expect(failed.map((o) => `${o.scenario}: ${o.failed.join(", ")}`)).toEqual([]);
  });

  it("completes more of them than the same agent choosing greedily", () => {
    const greedy = of("greedy", prerequisite).filter((o) => o.complete).length;
    const planned = of("la-3x2", prerequisite).filter((o) => o.complete).length;
    expect(planned).toBeGreaterThanOrEqual(greedy);
  });

  it("meets a chain deeper than its depth (no requirement of its own on the way) by ending explicitly, naming what is unmet and why, never by looping or guessing", () => {
    const deep = of("la-3x2", (o) => o.scenario === "deploy-41")[0]!;
    expect(deep.status).toBe("ended");
    if (!deep.complete) {
      expect(deep.stopped?.complete).toBe(false);
      expect(deep.stopped?.unmet.join(" ")).toContain("production");
      expect(deep.stopped?.blocker).toBeTruthy();
    }
  });

  it("goes the whole way when the author names the milestones, or when it may fall back to Jev's own choice", () => {
    expect(of("la-3x2", (o) => o.scenario === "deploy-12-milestones")[0]!.complete).toBe(true);
    expect(of("la-3x2g", (o) => o.scenario === "deploy-41")[0]!.complete).toBe(true);
  });
});

describe("lookahead on tasks where a plausible action breaks something", () => {
  const trap = (o: Outcome) => o.kind === "regression";

  it("never goes over a limit and never leaves a task with a met requirement broken", () => {
    expect(sum(of("la-3x2", trap), (o) => o.violations)).toBe(0);
    expect(of("la-3x2", trap).filter((o) => !o.complete).map((o) => o.scenario)).toEqual([]);
  });

  it("breaks no more than greedy does, and leaves the calendar alone when the asked move cannot be made without breaking it", () => {
    expect(sum(of("la-3x2", trap), (o) => o.regressions)).toBeLessThanOrEqual(sum(of("greedy", trap), (o) => o.regressions));
    const only = of("la-3x2", (o) => o.scenario === "calendar-shift-only")[0]!;
    expect(only.regressions).toBe(0);
    expect(only.steps).toBe(0);
  });
});

describe("lookahead on plain tasks (the shop of the behaviour suite)", () => {
  it("completes all of them and pays for nothing that was not asked for when it may fall back to Jev's choice", () => {
    const shop = of("la-3x2g", (o) => o.kind === "control");
    expect(shop.filter((o) => !o.complete).map((o) => o.scenario)).toEqual([]);
    expect(sum(shop, (o) => o.violations)).toBe(0);
  });
});

describe("what it costs", () => {
  it("never fails for a reason other than the task: no API errors, no step limit", () => {
    for (const o of outcomes.filter((x) => x.arm.startsWith("la-"))) {
      expect(o.error, `${o.arm} ${o.scenario}`).toBeUndefined();
      expect(o.status, `${o.arm} ${o.scenario}`).not.toBe("step_limit");
    }
  });

  it("uses more requests than greedy, and at most a few dozen a step", () => {
    const per = (arm: string) => sum(of(arm), (o) => o.requests) / of(arm).length;
    expect(per("la-3x2")).toBeGreaterThan(per("greedy"));
    for (const o of of("la-3x2")) expect(o.requests / Math.max(o.steps, 1)).toBeLessThanOrEqual(30);
  });
});
