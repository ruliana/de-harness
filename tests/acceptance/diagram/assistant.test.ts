/**
 * The assistant behind the panel, with Jev (through a cassette): a small diagram studio with the panel beside the drawing. A scripted person
 * types an instruction into the panel; the agent's state is the diagram as Mermaid text (and a picture of what Mermaid drew from it); it adds,
 * renames, connects and removes through tools, and the panel shows the steps, a question when it has one, and the result. Jev's answers are in
 * tests/cassettes/diagram: `npm test` replays one run of each scenario offline, `npm run test:live` records them and runs two more of each,
 * then prints how many of them came out right.
 *
 * Right means: the Mermaid text that the page shows has the structure the scenario asks for (a drawing from nothing: a connected flow with a
 * failure branch; an edit: exactly the old diagram with the asked changes), Mermaid drew that text, the labels are all ones that code offered,
 * the panel shows the steps and ends with the result, and nothing was typed into the panel itself. A question holds the loop: while it is open,
 * the model gets no new request and the diagram does not change.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { CassetteModel, cassetteMode } from "../../../src/index.js";
import { SCENARIOS, branches, connected, hasCycle, problems, runScenario, type Outcome, type Scenario } from "../../../examples/diagram/run.js";
import { shape } from "../../../examples/diagram/graph.js";

const live = cassetteMode() !== "replay";
const RUNS = live ? 3 : 1;
/** The first run of a scenario is the one `npm test` replays, so only it is recorded; the other live runs measure reliability and write nothing. */
const modelFor = (run: number) => new CassetteModel({ dir: "tests/cassettes/diagram", mode: run === 0 ? undefined : "passthrough", apiKey: process.env.TYPESAFE_API_KEY });

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
const log = (o: Outcome) => `${o.messages.map((m) => `[${m.kind}] ${m.text}`).join("\n")}\n${o.diagram}`;

describe("diagram assistant: an instruction typed into the panel edits the diagram beside it", () => {
  it("draws a login flow from nothing: a connected flow of steps with a failure branch, in Mermaid text that the page drew", () => {
    const o = first("login-flow");
    expect(problems(o), log(o)).toEqual([]);
    const g = o.graph!;
    expect(g.nodes.length).toBeGreaterThanOrEqual(4);
    expect(connected(g)).toBe(true);
    expect(branches(g).length).toBeGreaterThanOrEqual(1);
    expect(o.diagram.split("\n")[0]).toBe("flowchart TD");
    expect(o.drawn.nodes.sort()).toEqual(g.nodes.map((n) => n.label).sort()); // what Mermaid drew is what the text says
    expect(o.handled!.result.state.diagram).toBe(o.diagram); // the agent's state is the text on the page
    expect(o.handled!.result.status).toBe("ended");
  });

  it("shows the person each step in the panel, then a result that says what changed", () => {
    const o = first("login-flow");
    const kinds = o.messages.map((m) => m.kind);
    expect(kinds[0]).toBe("user");
    expect(o.messages[0]!.text).toBe(scenario("login-flow").instruction);
    expect(kinds.filter((k) => k === "progress").length).toBeGreaterThanOrEqual(7); // four steps and at least three arrows
    expect(o.messages.filter((m) => m.kind === "progress").map((m) => m.text)).toEqual(expect.arrayContaining([expect.stringMatching(/^Added the step "/), expect.stringMatching(/^Connected "/)]));
    expect(kinds.at(-1)).toBe("result");
    expect(o.messages.at(-1)!.text).toMatch(/^Done: added ".*", .*\. The diagram has \d+ steps and \d+ arrows\.$/);
    expect(o.panel).toContain(o.messages.at(-1)!.text); // what the person reads in the panel
    expect(kinds).not.toContain("question"); // nothing was left open
  });

  it("puts a step between two others: the old arrow between them is replaced by two, and the other steps are untouched", () => {
    const o = first("insert-step");
    expect(problems(o), log(o)).toEqual([]);
    expect(shape(o.graph!)).toEqual({ nodes: ["Build image", "Deploy", "Push code", "Run tests"], edges: ["Build image||Deploy", "Push code||Run tests", "Run tests||Build image"] });
    // the steps that were there keep their place in the text: same ids, same labels
    expect(o.diagram).toContain('n1["Push code"]\n  n2["Run tests"]\n  n3["Deploy"]');
  });

  it("renames, relabels and removes as asked, and changes nothing else", () => {
    const o = first("tidy");
    expect(problems(o), log(o)).toEqual([]);
    expect(shape(o.graph!)).toEqual({ nodes: ["Deploy", "Package app", "Push code", "Run tests"], edges: ["Package app||Deploy", "Push code||Run tests", "Run tests|Green|Package app"] });
    expect(o.diagram).toContain('n1["Push code"]\n  n2["Run tests"]\n  n3["Package app"]\n  n4["Deploy"]'); // 'Build image' is n3, renamed in place
    expect(o.diagram).not.toContain("Notify team");
    expect(o.messages.at(-1)!.text).toBe('Done: renamed "Build image" to "Package app", removed "Notify team", 1 arrow relabelled. The diagram has 4 steps and 3 arrows.');
  });

  it("acts on the diagram and never on the panel: nothing typed into the panel, the person's lines are the only ones from them", () => {
    for (const runs of outcomes.values()) {
      for (const o of runs) {
        expect(o.fieldLeftOver).toBe("");
        expect(o.messages.filter((m) => m.kind === "user").map((m) => m.text)).toEqual(o.scenario.answer ? [o.scenario.instruction, o.scenario.answer] : [o.scenario.instruction]);
      }
    }
  });

  it("asks when the instruction leaves the failure to the person: the question is in the panel, the loop holds, and the answer decides", () => {
    const o = first("ask-failure");
    expect(problems(o), log(o)).toEqual([]);
    const kinds = o.messages.map((m) => m.kind);
    const asked = kinds.indexOf("question");
    expect(o.messages[asked]!.text).toBe("Where should a failure lead: back to the first step, or to an error message?");
    expect(o.messages[asked + 1]).toEqual({ kind: "user", text: scenario("ask-failure").answer });
    expect(hasCycle(o.graph!)).toBe(true); // the person said: back to the first step
    // held: while the question was open, no request went to the model
    expect(o.held!.requestsAfterWaiting).toBe(o.held!.requestsWhenAsked);
    // and it went on after the answer, to the end
    expect(kinds.slice(asked + 2).filter((k) => k === "progress").length).toBeGreaterThanOrEqual(1);
    expect(kinds.at(-1)).toBe("result");
  });

  it(`is reliable: every replayed run is correct, and at least ${RUNS === 1 ? "all" : "two of three"} live ones of each scenario`, () => {
    const lines: string[] = [];
    for (const [name, runs] of outcomes) {
      const correct = runs.filter((o) => problems(o).length === 0).length;
      lines.push(`${name}: ${correct} of ${runs.length} correct (${runs.map((o) => o.handled?.result.steps.length ?? "-").join(", ")} steps)${runs.flatMap((o) => problems(o)).length ? `\n   ${runs.flatMap((o) => problems(o)).join("\n   ")}` : ""}`);
      expect(correct).toBeGreaterThanOrEqual(live ? 2 : RUNS);
    }
    if (live) console.log(`\nDiagram assistant, live summary\n${lines.join("\n")}`);
  });
});
