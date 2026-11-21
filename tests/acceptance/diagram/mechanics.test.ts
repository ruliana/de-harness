/**
 * The diagram and the panel beside it, mechanics forced with ScriptedModel against the page on loopback. Still end to end:
 * createAgent(...).run() with a real headless Chromium and the real tools. The state of the agent is the Mermaid text (no picture); the page
 * draws it with Mermaid; the tools come and go with what the diagram holds; the labels are chosen from candidates and never written.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedModel, TOOL_QUESTION, createAgent, type DecisionRequest, type RunResult, type ScriptStep } from "../../../src/index.js";
import { BrowserSession, PageOverlay } from "../../../src/browser/index.js";
import { assistantTools, draw, drawn, shown } from "../../../examples/diagram/assistant.js";
import { startDiagramSite, type DiagramSite } from "../../../examples/diagram/diagram-site.js";
import { EMPTY, HEADER } from "../../../examples/diagram/graph.js";

let site: DiagramSite;
let browser: BrowserSession;
beforeEach(async () => {
  site = await startDiagramSite();
  browser = await BrowserSession.launch({ allowedHosts: ["127.0.0.1"], settleMs: 100 });
  await browser.goto(site.url);
});
afterEach(async () => {
  await browser?.close();
  await site?.close();
});

const flowchart = (...lines: string[]) => [HEADER.flowchart, ...lines.map((l) => `  ${l}`)].join("\n");
const sequence = (...lines: string[]) => [HEADER.sequence, ...lines.map((l) => `  ${l}`)].join("\n");
const CHAIN = flowchart('n1["Push code"]', 'n2["Run tests"]', 'n3["Deploy"]', "n1 --> n2", "n2 -->|Pass| n3");

const offered = (request: DecisionRequest) => Object.keys((request.questions[TOOL_QUESTION] as { criteria: object }).criteria);
const optionsOf = (request: DecisionRequest, id: string) => Object.keys((request.questions[id] as { criteria: object }).criteria);
/** The requests of the steps (the "done?" judgments the tools ask are requests of their own). */
const stepRequests = (model: ScriptedModel) => model.requests.filter((r) => TOOL_QUESTION in r.questions);

const judged = (request: DecisionRequest) => String((request.state as { state: { diagram: string } }).state.diagram);
/** One agent over the tools of the assistant, the way `carryOut` builds it: the model answers the script, and says yes to every "done?" judgment (or as `done` says). */
async function run(start: string, instruction: string, script: ScriptStep[], done: number | ((diagram: string) => number) = 0.95, allow?: ReadonlySet<string>): Promise<{ result: RunResult; model: ScriptedModel }> {
  await draw(browser, start);
  const stepsSoFar = (i: number) => model.requests.slice(0, i).filter((r) => TOOL_QUESTION in r.questions).length;
  const model: ScriptedModel = new ScriptedModel([(request, i) => ("done" in request.questions ? { done: typeof done === "number" ? done : done(judged(request)) } : (script[Math.min(stepsSoFar(i), script.length - 1)] ?? { [TOOL_QUESTION]: "end" }))]);
  const result = await createAgent({ model, instructions: instruction, tools: assistantTools(browser, model, instruction, allow), initialState: { diagram: start, done: false }, maxSteps: script.length }).run();
  return { result, model };
}
const act = (tool: string, args: Record<string, string> = {}): ScriptStep => ({
  [TOOL_QUESTION]: tool,
  ...Object.fromEntries(Object.entries(args).map(([k, v]) => [`${tool}.${k}`, v])),
  ...(tool === "connect" && args.label ? { "connect.label?stated": 0.95 } : {}), // an optional parameter is read only when it is said to be stated
});

describe("diagram page: it draws the Mermaid text it is given", () => {
  it("draws a node per node and a label per labelled arrow, and shows the text beside the drawing", async () => {
    await draw(browser, CHAIN);
    expect(await drawn(browser)).toEqual({ nodes: ["Deploy", "Push code", "Run tests"], edgeLabels: ["Pass"], error: null });
    expect(await shown(browser)).toBe(CHAIN);
  });

  it("draws a sequence diagram: each participant once, each message with its text", async () => {
    const text = sequence("participant n1 as User", "participant n2 as Server", "n1->>n2: Enter credentials", "alt Credentials invalid", "  n2-->>n1: Invalid credentials", "end");
    await draw(browser, text);
    expect(await drawn(browser)).toEqual({ nodes: ["Server", "User"], edgeLabels: ["Enter credentials", "Invalid credentials"], error: null });
  });

  it("says so, and keeps the text in view, when Mermaid cannot read it", async () => {
    await expect(draw(browser, 'flowchart TD\n  n1["oops')).rejects.toThrow(/cannot draw/);
    expect((await drawn(browser)).error).toMatch(/Parse error/);
  });

  it("gives the model no picture, only the text; the panel is not part of the page's text, and the drawing stops before it", async () => {
    const overlay = await PageOverlay.install(browser, { title: "Diagram assistant" });
    await overlay.say("Looking at the diagram");
    const { model } = await run(CHAIN, "Look", [act("rename_node", { node: "Deploy", label: "Roll back" })], 0.1);
    expect(model.requests.every((r) => Object.keys(r.images ?? {}).length === 0)).toBe(true);
    expect(JSON.stringify(model.requests[0]!.state)).toContain("flowchart TD");
    expect(await browser.text()).not.toContain("Looking at the diagram");
    // the right of the page is free for the source pane and the panel: the drawing stops before it
    expect(await browser.evaluate(() => document.getElementById("canvas")!.getBoundingClientRect().right, 0)).toBeLessThanOrEqual(1280 - 340 - 16);
  });
});

describe("diagram tools: the state is the Mermaid text, and each tool edits it", () => {
  it("builds a flowchart from nothing, one tool at a time, and the text and the page agree at the end", async () => {
    const { result, model } = await run(EMPTY, "Draw a flowchart of a login with a failure branch", [
      act("start_diagram", { kind: "flowchart" }),
      act("add_node", { label: "Enter credentials" }),
      act("add_node", { label: "Check password" }),
      act("add_node", { label: "Show error message" }),
      act("connect", { arrow: "Enter credentials -> Check password" }),
      act("connect", { arrow: "Check password -> Show error message", label: "Invalid" }),
      act("end"),
    ]);
    expect(result.error?.message).toBeUndefined();
    expect(result.status).toBe("ended");
    const expected = flowchart('n1["Enter credentials"]', 'n2["Check password"]', 'n3["Show error message"]', "n1 --> n2", "n2 -->|Invalid| n3");
    expect(result.state.diagram).toBe(expected);
    expect(await shown(browser)).toBe(expected);
    expect(await drawn(browser)).toEqual({ nodes: ["Check password", "Enter credentials", "Show error message"], edgeLabels: ["Invalid"], error: null });
    expect(stepRequests(model)).toHaveLength(7);
  });

  it("builds a sequence diagram: a message brings its participants, replies are drawn as replies, and messages of one case form one branch", async () => {
    const { result } = await run(EMPTY, "Draw a sequence diagram of a login", [
      act("start_diagram", { kind: "sequence diagram" }),
      act("add_message", { message: "User -> Browser: Enter credentials" }),
      act("add_message", { message: "Browser -> Server: Send login request" }),
      act("add_message", { message: "Server -> Browser: Session token" }), // only when the credentials are valid
      act("add_message", { message: "Server -> Browser: Invalid credentials" }), // only when they are not
      act("add_message", { message: "Browser -> User: Show dashboard" }), // valid again: it goes into the first branch, not after the second
      act("end"),
    ]);
    expect(result.error?.message).toBeUndefined();
    expect(result.status).toBe("ended");
    expect(result.state.diagram).toBe(
      sequence(
        "participant n1 as User",
        "participant n2 as Browser",
        "participant n3 as Server",
        "n1->>n2: Enter credentials",
        "n2->>n3: Send login request",
        "alt Credentials valid",
        "  n3-->>n2: Session token",
        "  n2-->>n1: Show dashboard",
        "else Credentials invalid",
        "  n3-->>n2: Invalid credentials",
        "end",
      ),
    );
    expect(await shown(browser)).toBe(result.state.diagram);
    const page = await drawn(browser);
    expect([...page.nodes].sort()).toEqual(["Browser", "Server", "User"]);
    expect(page.edgeLabels).toEqual(["Enter credentials", "Send login request", "Session token", "Show dashboard", "Invalid credentials"]);
    expect(page.error).toBeNull();
  });

  it("renames, relabels, disconnects and removes: the arrows of a removed node go with it", async () => {
    const { result } = await run(CHAIN, "Rename 'Run tests' to 'Run checks', relabel its arrow 'Green', cut the arrow from 'Push code' and remove 'Deploy'", [
      act("rename_node", { node: "Run tests", label: "Run checks" }),
      act("relabel_edge", { edge: "Run checks --Pass--> Deploy", label: "Green" }),
      act("disconnect", { edge: "Push code --> Run checks" }),
      act("remove_node", { node: "Deploy" }),
      act("end"),
    ]);
    expect(result.error?.message).toBeUndefined();
    expect(result.status).toBe("ended");
    expect(result.state.diagram).toBe(flowchart('n1["Push code"]', 'n2["Run checks"]'));
    expect(await shown(browser)).toBe(result.state.diagram);
  });

  it("offers a tool only when it has something to act on: a kind before anything, nodes before they can be removed or joined, arrows before they can be taken out", async () => {
    const { model } = await run(EMPTY, "Draw", [act("start_diagram", { kind: "flowchart" }), act("add_node", { label: "Push code" }), act("add_node", { label: "Run tests" }), act("connect", { arrow: "Push code -> Run tests" }), act("remove_node", { node: "Run tests" }), act("add_node", { label: "Deploy" })], 0.1);
    const [none, started, one, two, joined, back] = stepRequests(model).map(offered);
    expect(stepRequests(model)).toHaveLength(6);
    expect(none).toEqual(["start_diagram"]); // there is no diagram to add to, remove from or join
    expect(started).toEqual(["add_node"]);
    expect(one).toEqual(["add_node", "remove_node", "rename_node"]); // one node cannot be joined to another
    expect(two).toEqual(["add_node", "remove_node", "rename_node", "connect"]); // nothing to disconnect yet
    expect(joined).toEqual(["add_node", "remove_node", "rename_node", "connect", "disconnect", "relabel_edge"]); // 1 --> 2 is drawn; 2 --> 1 is left
    expect(back).toEqual(["add_node", "remove_node", "rename_node"]); // the arrow went with the node: one node is left, and there is nothing to join or take out
  });

  it("offers the tools of the kind: arrows for a flowchart, messages for a sequence diagram", async () => {
    const flow = await run(CHAIN, "Draw", [act("end")], 0.95);
    expect(offered(stepRequests(flow.model)[0]!)).toEqual(expect.arrayContaining(["connect", "disconnect", "relabel_edge"]));
    expect(offered(stepRequests(flow.model)[0]!)).not.toContain("add_message");
    const seq = await run(sequence("participant n1 as User", "participant n2 as Browser", "n1->>n2: Enter credentials"), "Draw", [act("end")], 0.95);
    expect(offered(stepRequests(seq.model)[0]!)).toEqual(expect.arrayContaining(["add_message", "disconnect", "relabel_edge"]));
    expect(offered(stepRequests(seq.model)[0]!)).not.toContain("connect");
  });

  it("offers the editing tools only when the instruction asks for editing, so that a model never takes out what it has just put in", async () => {
    const { model } = await run(CHAIN, "Add a step", [act("add_node", { label: "Notify team" })], 0.1, new Set(["rename_node"]));
    expect(offered(stepRequests(model)[0]!)).toEqual(["add_node", "rename_node", "connect"]); // no remove_node, disconnect or relabel_edge, though there are nodes and arrows
  });

  it("holds `end` back until the new diagram is judged to be what was asked, and offers it as soon as it is", async () => {
    const held = await run(EMPTY, "Draw a flow", [act("start_diagram", { kind: "flowchart" }), act("add_node", { label: "Push code" }), act("add_node", { label: "Run tests" })], 0.1);
    expect(held.result.error?.message).toBeUndefined();
    expect(stepRequests(held.model).every((r) => !offered(r).includes("end"))).toBe(true);
    expect(held.result.status).toBe("step_limit");
    const done = await run(EMPTY, "Draw a flow", [act("start_diagram", { kind: "flowchart" }), act("add_node", { label: "Push code" }), act("end")], 0.95);
    expect(stepRequests(done.model).map(offered)[0]).not.toContain("end"); // nothing is drawn yet
    expect(stepRequests(done.model).map(offered)[2]).toContain("end");
    expect(done.result.status).toBe("ended");
  });

  it("offers an arrow only where there is none yet, so the same arrow cannot be drawn twice", async () => {
    const { model } = await run(CHAIN, "Draw", [act("connect", { arrow: "Push code -> Deploy" }), act("end")]);
    const [first, second] = stepRequests(model);
    expect(optionsOf(first!, "connect.arrow").sort()).toEqual(["Deploy -> Push code", "Deploy -> Run tests", "Push code -> Deploy", "Run tests -> Push code"]);
    expect(optionsOf(second!, "connect.arrow")).not.toContain("Push code -> Deploy");
  });

  it("never writes a label: new names are chosen from the catalogs and from the texts in quotes in the instruction", async () => {
    const { result, model } = await run(CHAIN, "Rename 'Run tests' to 'Run checks'", [act("rename_node", { node: "Run tests", label: "Run checks" }), act("end")]);
    const [first] = stepRequests(model);
    expect(optionsOf(first!, "rename_node.label")).toContain("Run checks"); // quoted in the instruction
    expect(optionsOf(first!, "rename_node.label")).toContain("Build image"); // the catalog
    expect(optionsOf(first!, "rename_node.label")).not.toContain("Deploy"); // the diagram has it
    expect(optionsOf(first!, "add_node.label")).not.toContain("Push code");
    expect(result.state.diagram).toContain('n2["Run checks"]');
  });

  it("offers a message once, and a message that the instruction quotes between any two participants", async () => {
    const start = sequence("participant n1 as User", "participant n2 as Browser", "n1->>n2: Enter credentials");
    const { model } = await run(start, "Add 'Ask for a captcha' as the next message", [act("add_message", { message: "Browser -> User: Ask for a captcha" }), act("end")]);
    const [first, second] = stepRequests(model);
    expect(optionsOf(first!, "add_message.message")).not.toContain("User -> Browser: Enter credentials"); // said already
    expect(optionsOf(first!, "add_message.message")).toContain("Browser -> Server: Send login request"); // the catalog; Server joins the diagram with it
    expect(optionsOf(first!, "add_message.message")).toEqual(expect.arrayContaining(["User -> Browser: Ask for a captcha", "Browser -> User: Ask for a captcha", "Browser -> Browser: Ask for a captcha"]));
    expect(optionsOf(second!, "add_message.message")).not.toContain("Browser -> User: Ask for a captcha");
  });
});
