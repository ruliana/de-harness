/**
 * The assistant behind the panel, with Jev (through a cassette): a small Kanban board with the panel beside it. A scripted person types an
 * instruction into the panel; the agent sees only a screenshot of the board (without the panel), drags cards between columns, opens a card
 * to assign it, and the panel shows the steps, a question when it has one, and the result. Jev's answers are in tests/cassettes/kanban:
 * `npm test` replays one run of each scenario offline, `npm run test:live` records them and runs two more of each, then prints how many
 * of them came out right.
 *
 * Right means: the board (as the server holds it) is the start with exactly the card the person talked about changed, the panel shows the
 * steps and ends with the result, and nothing was typed into the panel itself. A question holds the loop: while it is open, the model gets
 * no new request and the board does not change.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { CassetteModel, cassetteMode } from "../../../src/index.js";
import { SCENARIOS, problems, runScenario, type Outcome, type Scenario } from "../../../examples/kanban/run.js";

const live = cassetteMode() !== "replay";
const RUNS = live ? 3 : 1;
/** The first run of a scenario is the one `npm test` replays, so only it is recorded; the other live runs measure reliability and write nothing. */
const modelFor = (run: number) => new CassetteModel({ dir: "tests/cassettes/kanban", mode: run === 0 ? undefined : "passthrough", apiKey: process.env.TYPESAFE_API_KEY });

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
const log = (o: Outcome) => o.messages.map((m) => `[${m.kind}] ${m.text}`).join("\n");

describe("kanban assistant: an instruction typed into the panel operates the board beside it", () => {
  it("moves the card to Done and gives it to Sam, as the instruction says, and changes nothing else", () => {
    const o = first("move-assign");
    expect(problems(o), log(o)).toEqual([]);
    expect(o.cards.find((c) => c.title === "Fix login")).toMatchObject({ column: "Done", assignee: "Sam" });
    expect(o.handled!.result.status).toBe("ended");
  });

  it("shows the person each step in the panel, then a result that says what changed", () => {
    const o = first("move-assign");
    const kinds = o.messages.map((m) => m.kind);
    expect(kinds[0]).toBe("user");
    expect(o.messages[0]!.text).toBe(scenario("move-assign").instruction);
    expect(kinds.filter((k) => k === "progress").length).toBeGreaterThanOrEqual(3); // the move, the card opened, the name, Close
    expect(o.messages.filter((m) => m.kind === "progress").map((m) => m.text)).toEqual(expect.arrayContaining(['Dragged: "Fix login" moved from To Do to Done', 'Pressed "Sam"']));
    expect(kinds.at(-1)).toBe("result");
    expect(o.messages.at(-1)!.text).toBe('Done: "Fix login" moved from To Do to Done, assigned to Sam.');
    expect(o.panel).toContain(o.messages.at(-1)!.text); // what the person reads in the panel
    expect(kinds).not.toContain("question"); // nothing was left open
  });

  it("only moves when that is all that was asked: no question, no assignee touched", () => {
    const o = first("move-only");
    expect(problems(o), log(o)).toEqual([]);
    expect(o.messages.some((m) => m.kind === "question")).toBe(false);
    expect(o.cards.find((c) => c.title === "Review pricing page")).toMatchObject({ column: "Done", assignee: "Ada" });
  });

  it("acts on the board and never on the panel: nothing typed into the panel, the person's lines are the only ones from them", () => {
    for (const runs of outcomes.values()) {
      for (const o of runs) {
        expect(o.fieldLeftOver).toBe("");
        expect(o.messages.filter((m) => m.kind === "user").map((m) => m.text)).toEqual(o.scenario.answer ? [o.scenario.instruction, o.scenario.answer] : [o.scenario.instruction]);
      }
    }
  });

  it("asks when the instruction leaves the assignee to the person: the question is in the panel, the loop holds, and the answer decides", () => {
    const o = first("ask-assignee");
    expect(problems(o), log(o)).toEqual([]);
    const kinds = o.messages.map((m) => m.kind);
    const asked = kinds.indexOf("question");
    expect(o.messages[asked]!.text).toBe("Who should I assign it to: Ada, Sam, Priya or Lee?");
    expect(o.messages[asked + 1]).toEqual({ kind: "user", text: scenario("ask-assignee").answer });
    expect(o.cards.find((c) => c.title === "Update docs")).toMatchObject({ column: "Doing", assignee: "Priya" });
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
    if (live) console.log(`\nKanban assistant, live summary\n${lines.join("\n")}`);
  });
});
