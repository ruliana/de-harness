/**
 * Wikipedia navigation mechanics, forced with ScriptedModel against a Wikipedia look-alike on loopback.
 * Still end to end: createAgent(...).run() with the example's real client, parser and tools.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedModel, TOOL_QUESTION, createAgent } from "../../../src/index.js";
import { createWikipedia, instructionsFor } from "../../../examples/wikipedia/wikipedia.js";
import { startFakeSite, type FakeArticle, type FakeSite } from "../../support/wikipedia-site.js";

const many: [string, string][] = Array.from({ length: 400 }, (_, i) => [`Topic ${i}`, `topic number ${i}`]);

const articles: FakeArticle[] = [
  {
    title: "Start",
    lead: [["Middle", "the middle"]],
    body: [["Dead end", "a dead end"], ["Middle", "middle again"], ["Middle", "centre"], ["Middle", "heart"], ["Middle", "core"]],
    infobox: ["Infobox only"],
    seeAlso: ["See also only"],
    references: ["Reference only"],
  },
  { title: "Middle", lead: [["Goal", "the goal"], ["Start", "where we began"]], body: [["Dead end", "also a dead end"]] },
  { title: "Dead end", lead: [], body: [] },
  { title: "Goal", lead: [], body: [] },
  { title: "Huge", lead: [], body: many },
];

let site: FakeSite;
beforeAll(async () => {
  site = await startFakeSite(articles);
});
afterAll(() => site.close());

const optionsOf = (model: ScriptedModel, request: number) => Object.keys((model.requests[request]!.questions["open_link.link"] as { criteria: object }).criteria);
const toolsOf = (model: ScriptedModel, request: number) => Object.keys((model.requests[request]!.questions[TOOL_QUESTION] as { criteria: object }).criteria);

async function run(start: string, script: ConstructorParameters<typeof ScriptedModel>[0], opts: { maxLinks?: number } = {}) {
  const wiki = await createWikipedia({ start, baseUrl: site.baseUrl, ...opts });
  const model = new ScriptedModel(script);
  const result = await createAgent({ model, instructions: instructionsFor(start, "Goal"), tools: wiki.tools, initialState: wiki.initialState, maxSteps: 6 }).run();
  return { wiki, model, result };
}

describe("wikipedia: what the agent is offered", () => {
  it("offers the links of the article body, keyed by title and described by anchor text, and nothing else", async () => {
    const { model } = await run("Start", [{ [TOOL_QUESTION]: "end" }]);
    expect(optionsOf(model, 0).sort()).toEqual(["Dead end", "Middle"]);
    const criteria = (model.requests[0]!.questions["open_link.link"] as { criteria: Record<string, string> }).criteria;
    expect(criteria["Middle"]).toContain("the middle");
    expect(criteria["Middle"]).toContain("centre");
    expect(criteria["Dead end"]).toContain("a dead end");
  });

  it("states the current article by title and lead, and the trail, but not the links", async () => {
    const { model } = await run("Start", [{ [TOOL_QUESTION]: "end" }]);
    const state = (model.requests[0]!.state as { state: Record<string, any> }).state;
    expect(state.page.title).toBe("Start");
    expect(state.page.summary).toContain("made-up article");
    expect(state.trail).toEqual(["Start"]);
    expect(state.page.links).toBeUndefined();
  });

  it("follows a link: the next article becomes the page, and the run ends there", async () => {
    const { result } = await run("Start", [{ [TOOL_QUESTION]: "open_link", "open_link.link": "Middle" }, { [TOOL_QUESTION]: "open_link", "open_link.link": "Goal" }, { [TOOL_QUESTION]: "end" }]);
    expect(result.status).toBe("ended");
    expect(result.output).toEqual({ title: "Goal", trail: ["Start", "Middle", "Goal"] });
  });

  it("cuts a huge link list to the budget in code", async () => {
    const { model } = await run("Huge", [{ [TOOL_QUESTION]: "end" }], { maxLinks: 120 });
    expect(optionsOf(model, 0)).toHaveLength(120);
    expect(optionsOf(model, 0)[0]).toBe("Topic 0");
  });

  it("never offers an article already on the trail", async () => {
    const { model } = await run("Start", [{ [TOOL_QUESTION]: "open_link", "open_link.link": "Middle" }, { [TOOL_QUESTION]: "end" }]);
    expect(optionsOf(model, 1).sort()).toEqual(["Dead end", "Goal"]); // Middle links back to Start, which is not offered
  });
});

describe("wikipedia: go_back", () => {
  it("is not offered on the first article, and restores the previous page slot afterwards", async () => {
    const { model, result } = await run("Start", [
      { [TOOL_QUESTION]: "open_link", "open_link.link": "Dead end" },
      { [TOOL_QUESTION]: "go_back" },
      { [TOOL_QUESTION]: "end" },
    ]);
    expect(toolsOf(model, 0)).not.toContain("go_back");
    expect(toolsOf(model, 1)).toContain("go_back"); // on "Dead end", which has no links
    expect(toolsOf(model, 1)).not.toContain("open_link");
    const pageAt = (i: number) => (model.requests[i]!.state as { state: { page: unknown } }).state.page;
    expect(pageAt(2)).toEqual(pageAt(0));
    expect(result.status).toBe("ended");
    expect(result.output).toEqual({ title: "Start", trail: ["Start"] });
  });

  it("does not offer an abandoned article again", async () => {
    const { model } = await run("Start", [
      { [TOOL_QUESTION]: "open_link", "open_link.link": "Dead end" },
      { [TOOL_QUESTION]: "go_back" },
      { [TOOL_QUESTION]: "end" },
    ]);
    expect(optionsOf(model, 2)).toEqual(["Middle"]);
    expect((model.requests[2]!.state as { state: { abandoned: string[] } }).state.abandoned).toEqual(["Dead end"]);
  });
});

describe("wikipedia: failures are state, not crashes", () => {
  it("a link to a missing article becomes the error slot and the run carries on", async () => {
    const broken: FakeArticle[] = [{ title: "Odd", lead: [], body: [["Missing page", "somewhere"]] }];
    const odd = await startFakeSite(broken);
    try {
      const wiki = await createWikipedia({ start: "Odd", baseUrl: odd.baseUrl });
      const model = new ScriptedModel([{ [TOOL_QUESTION]: "open_link", "open_link.link": "Missing page" }, { [TOOL_QUESTION]: "end" }]);
      const result = await createAgent({ model, instructions: "x", tools: wiki.tools, initialState: wiki.initialState, maxSteps: 4 }).run();
      expect(result.status).toBe("ended");
      expect(result.steps[0]!.error).toContain("There is no article");
      expect((model.requests[1]!.state as { state: { error: string; page: { title: string } } }).state.page.title).toBe("Odd");
    } finally {
      await odd.close();
    }
  });
});
