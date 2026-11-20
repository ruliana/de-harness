/**
 * Tools that add tools (examples/load-api): the agent starts with `load_api` alone, reads an OpenAPI document and gets one tool
 * per endpoint. The API is a mock HTTP server on loopback with real state; the model is Jev through a cassette, or a script
 * where a decision has to be forced.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ScriptedModel, TOOL_QUESTION, createAgent, openApiTools, resolveBaseUrl, type DecisionRequest, type RunResult } from "../../../src/index.js";
import { createLoader } from "../../../examples/load-api/load-api.js";
import { helpdeskSpec, startServer, type HelpdeskServer, type Ticket } from "../../../examples/load-api/server.js";
import { jevFor } from "../../support/models.js";

const ANA = "Find the open ticket assigned to Ana and close it";

const catalog = (server: HelpdeskServer) => ({
  helpdesk: { description: "Support tickets: list, read, create, update, close and delete tickets", spec: `${server.url}/helpdesk/openapi.json` },
  inventory: { description: "Office equipment in stock: list items and read one", spec: `${server.url}/inventory/openapi.json` },
});

const offered = (request: DecisionRequest) => Object.keys((request.questions[TOOL_QUESTION] as { criteria: object }).criteria);
const options = (request: DecisionRequest, id: string) => Object.keys((request.questions[id] as { criteria: object }).criteria);
const asksAbout = (request: DecisionRequest, tool: string) => Object.keys(request.questions).some((id) => id.startsWith(`${tool}.`));
const apiState = (request: DecisionRequest) => (request.state as { state: { api?: Record<string, any>; error?: string; loaded?: any } }).state;

/** Every ticket as it was, except the ones named, which change as given. */
const expected = (before: Ticket[], changes: Record<number, Partial<Ticket>>) => before.map((t) => ({ ...t, ...changes[t.id] }));

async function runJev(item: string, instructions: string) {
  const server = await startServer();
  const before = server.snapshot();
  const loader = createLoader(catalog(server));
  const result = await createAgent({ model: jevFor(item), instructions, tools: loader.tools, initialState: loader.initialState, maxSteps: 10 }).run();
  const after = server.snapshot();
  const log = [...server.log];
  await server.close();
  return { result, before, after, log };
}

describe("load_api: find the open ticket assigned to Ana and close it (Jev)", () => {
  let run: Awaited<ReturnType<typeof runJev>>;
  let result: RunResult;

  beforeAll(async () => {
    run = await runJev("load-api", ANA);
    result = run.result;
    console.log(`\n${result.steps.map((s) => `${s.step}. ${s.tool}(${JSON.stringify(s.args)})`).join("\n")}\n${result.status} in ${result.steps.length} steps\n`);
  });

  it("ends with Ana's open ticket closed and every other ticket untouched", () => {
    expect(result.status).toBe("ended");
    expect(run.after).toEqual(expected(run.before, { 4: { status: "closed", resolution: expect.any(String) } }));
  });

  it("loads the helpdesk API once, closes exactly one ticket, and gets no 4xx or 5xx from the server", () => {
    const tools = result.steps.map((s) => s.tool);
    expect(tools[0]).toBe("load_api");
    expect(tools.filter((t) => t === "load_api")).toHaveLength(1);
    expect(tools.filter((t) => t === "close_ticket")).toHaveLength(1);
    expect(tools.at(-1)).toBe("end");
    expect(run.log.filter((e) => e.status >= 400)).toEqual([]);
    expect(run.log.map((e) => e.path)).toContain("/helpdesk/openapi.json");
    expect(run.log.map((e) => e.path)).not.toContain("/inventory/openapi.json");
    expect((result.state.api as Record<string, { status: string }>).close_ticket).toMatchObject({ status: "closed" });
  });

  it("starts with only load_api and end, and the first request asks nothing about any endpoint", () => {
    const first = result.steps[0]!.request;
    expect(offered(first)).toEqual(["load_api", "end"]);
    expect(Object.keys(first.questions).filter((id) => id !== TOOL_QUESTION)).toEqual(["load_api.api"]);
  });

  it("offers different tools as the run goes: endpoints after the load, the id-taking ones only after a list, never load_api again", () => {
    const shown = result.events.filter((e) => e.type === "step_start").map((e) => e.tools);
    expect(shown[0]).toEqual(["load_api", "end"]);
    expect(shown[1]).toEqual(expect.arrayContaining(["list_tickets", "end"]));
    expect(shown[1]).not.toContain("load_api");
    expect(shown[1]).not.toContain("close_ticket");
    const listed = result.steps.findIndex((s) => s.tool === "list_tickets");
    expect(shown[listed + 1]).toEqual(expect.arrayContaining(["get_ticket", "update_ticket", "close_ticket", "delete_ticket"]));
    for (const tools of shown.slice(1)) expect(tools).not.toContain("load_api");
    expect(new Set(shown.map((t) => t.join(","))).size).toBeGreaterThanOrEqual(3);
  });

  it("shows in the trace the endpoint tools being added and load_api removing itself during step 1", () => {
    const changes = result.events.filter((e) => e.type === "tools_changed");
    expect(changes.every((c) => c.step === 1)).toBe(true);
    expect(changes.filter((c) => c.change === "added").map((c) => c.tool)).toEqual(["list_tickets", "get_ticket", "update_ticket", "delete_ticket", "close_ticket"]);
    expect(changes.at(-1)).toMatchObject({ change: "removed", tool: "load_api", tools: ["end", "list_tickets", "get_ticket", "update_ticket", "delete_ticket", "close_ticket"] });
  });
});

describe("load_api: close Ben's printer ticket as won't fix and email the requester (Jev)", () => {
  it("passes the stated resolution and notification, and leaves every other ticket alone", async () => {
    const { result, before, after, log } = await runJev("load-api", "Close Ben's open ticket about the printer as won't fix and email the requester");
    expect(result.status).toBe("ended");
    expect(after).toEqual(expected(before, { 1: { status: "closed", resolution: "wontfix", notified: true } }));
    expect(log.filter((e) => e.status >= 400)).toEqual([]);
  });
});

describe("load_api: mechanics (scripted)", () => {
  let server: HelpdeskServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const setup = async () => {
    server = await startServer();
    return { server, before: server.snapshot(), loader: createLoader(catalog(server)) };
  };
  const loadHelpdesk = { [TOOL_QUESTION]: "load_api", "load_api.api": "helpdesk" };
  const list = (extra: Record<string, string | number> = {}) => ({ [TOOL_QUESTION]: "list_tickets", ...extra });

  it("turns each parameter of the spec into the matching kind of question, and leaves out the endpoint that needs free text", async () => {
    const { loader } = await setup();
    const model = new ScriptedModel([loadHelpdesk, list(), { [TOOL_QUESTION]: "end" }]);
    await createAgent({ model, instructions: ANA, tools: loader.tools, initialState: loader.initialState, maxSteps: 3 }).run();

    const afterLoad = model.requests[1]!;
    expect(offered(afterLoad)).toEqual(["end", "list_tickets"]);
    expect(afterLoad.questions["list_tickets.status"]).toMatchObject({ type: "choice" });
    expect(options(afterLoad, "list_tickets.status")).toEqual(["open", "closed"]);
    expect(options(afterLoad, "list_tickets.assignee")).toEqual(["ana", "ben", "carla"]);
    // not required: one more Noul says whether the instructions state a value at all
    expect(afterLoad.questions["list_tickets.status?stated"]).toMatchObject({ type: "noul" });
    expect(Object.keys(afterLoad.questions).some((id) => id.startsWith("create_ticket"))).toBe(false);
    expect(apiState(afterLoad).loaded).toMatchObject({ api: "helpdesk", tools: ["list_tickets", "get_ticket", "update_ticket", "delete_ticket", "close_ticket"] });
    expect(apiState(afterLoad).loaded.not_loaded).toEqual([expect.stringMatching(/^create_ticket: .*"title" is free text/)]);

    const afterList = model.requests[2]!;
    const q = afterList.questions;
    expect(q["close_ticket.id"]).toMatchObject({ type: "choice" });
    expect(options(afterList, "close_ticket.id")).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect((q["close_ticket.id"] as { criteria: Record<string, string> }).criteria["4"]).toContain("assignee: ana");
    expect(options(afterList, "close_ticket.resolution")).toEqual(["fixed", "wontfix", "duplicate"]);
    expect(q["close_ticket.resolution?stated"]).toMatchObject({ type: "noul" });
    expect(q["close_ticket.notify"]).toMatchObject({ type: "noul" });
    expect(q["update_ticket.labels[billing]"]).toMatchObject({ type: "noul" });
    expect(Object.keys(q).filter((id) => id.startsWith("update_ticket.labels["))).toHaveLength(3);
    expect(asksAbout(afterList, "delete_ticket")).toBe(true);
    // every question names the action and stands alone
    expect(q["close_ticket.resolution"]!.instructions).toContain('"Close a ticket"');
    expect(q["close_ticket.id"]!.instructions).toContain("`state.api.list_tickets`");
  });

  it("offers only the ids the agent has listed, and a list that comes back empty takes the id-taking tools away again", async () => {
    const { loader } = await setup();
    const model = new ScriptedModel([
      loadHelpdesk,
      list({ "list_tickets.assignee": "ana", "list_tickets.assignee?stated": 0.95 }),
      { [TOOL_QUESTION]: "close_ticket", "close_ticket.id": "4" },
      { [TOOL_QUESTION]: "end" },
    ]);
    const result = await createAgent({ model, instructions: ANA, tools: loader.tools, initialState: loader.initialState, maxSteps: 4 }).run();
    expect(options(model.requests[2]!, "close_ticket.id")).toEqual(["2", "4"]);
    expect(result.steps.map((s) => s.tool)).toEqual(["load_api", "list_tickets", "close_ticket", "end"]);
  });

  it("makes the calls the agent has looked at again after a change, so the state is what the server says", async () => {
    const { server, before, loader } = await setup();
    const model = new ScriptedModel([loadHelpdesk, list(), { [TOOL_QUESTION]: "close_ticket", "close_ticket.id": "4" }, { [TOOL_QUESTION]: "end" }]);
    await createAgent({ model, instructions: ANA, tools: loader.tools, initialState: loader.initialState, maxSteps: 4 }).run();
    const seen = (request: DecisionRequest) => (apiState(request).api!.list_tickets as Ticket[]).find((t) => t.id === 4)!.status;
    expect(seen(model.requests[2]!)).toBe("open");
    expect(seen(model.requests[3]!)).toBe("closed");
    expect(apiState(model.requests[3]!).api!.close_ticket).toMatchObject({ id: 4, status: "closed" });
    // nothing stated: the server's defaults apply
    expect(server.snapshot()).toEqual(expected(before, { 4: { status: "closed", resolution: "fixed", notified: false } }));
  });

  it("sends a stated choice, a yes and a set as the right JSON, in the body of the right call", async () => {
    const { server, before, loader } = await setup();
    const model = new ScriptedModel([
      loadHelpdesk,
      list(),
      { [TOOL_QUESTION]: "close_ticket", "close_ticket.id": "4", "close_ticket.resolution": "wontfix", "close_ticket.resolution?stated": 0.9, "close_ticket.notify": 0.9, "close_ticket.notify?stated": 0.9 },
      { [TOOL_QUESTION]: "update_ticket", "update_ticket.id": "6", "update_ticket.assignee": "carla", "update_ticket.assignee?stated": 0.9, "update_ticket.labels[billing]": 0.9, "update_ticket.labels[urgent]": 0.9, "update_ticket.labels?stated": 0.9 },
    ]);
    const result = await createAgent({ model, instructions: "x", tools: loader.tools, initialState: loader.initialState, maxSteps: 4 }).run();
    expect(result.steps.map((s) => s.error)).toEqual([undefined, undefined, undefined, undefined]);
    expect(server.snapshot()).toEqual(
      expected(before, { 4: { status: "closed", resolution: "wontfix", notified: true }, 6: { assignee: "carla", labels: ["billing", "urgent"] } }),
    );
  });

  it("puts a 409 from the server in the error slot for one step and goes on, with the ticket untouched", async () => {
    const { server, before, loader } = await setup();
    const model = new ScriptedModel([loadHelpdesk, list(), { [TOOL_QUESTION]: "close_ticket", "close_ticket.id": "2" }, { [TOOL_QUESTION]: "close_ticket", "close_ticket.id": "4" }, { [TOOL_QUESTION]: "end" }]);
    const result = await createAgent({ model, instructions: ANA, tools: loader.tools, initialState: loader.initialState, maxSteps: 5 }).run();
    expect(result.steps[2]!.error).toMatch(/409.*already closed/);
    expect(apiState(model.requests[3]!).error).toMatch(/409.*already closed/);
    expect(apiState(model.requests[4]!).error).toBeUndefined();
    expect(result.status).toBe("ended");
    expect(server.log.filter((e) => e.status >= 400)).toEqual([{ method: "POST", path: "/helpdesk/tickets/2/close", status: 409 }]);
    expect(server.snapshot()).toEqual(expected(before, { 4: { status: "closed", resolution: "fixed" } }));
  });

  it("takes an operation as a tool only when the caller can supply what the model cannot write, and can leave operations out", async () => {
    const { server, before } = await setup();
    const withTitles = openApiTools(helpdeskSpec, {
      baseUrl: resolveBaseUrl(helpdeskSpec, `${server.url}/helpdesk/openapi.json`),
      include: (op) => op.method !== "DELETE",
      candidates: ({ tool, param }) => (tool === "create_ticket" && param === "title" ? ["Badge reader at the side door is offline"] : undefined),
    });
    expect(withTitles.skipped).toEqual([]);
    expect(withTitles.tools.map((t) => t.name)).toEqual(["list_tickets", "create_ticket", "get_ticket", "update_ticket", "close_ticket"]);

    const model = new ScriptedModel([{ [TOOL_QUESTION]: "create_ticket", "create_ticket.assignee": "ana", "create_ticket.assignee?stated": 0.9, "create_ticket.priority": "1", "create_ticket.priority?stated": 0.9 }]);
    const result = await createAgent({ model, instructions: "x", tools: withTitles.tools, maxSteps: 1 }).run();
    expect(result.steps[0]!.error).toBeUndefined();
    expect(options(model.requests[0]!, "create_ticket.priority")).toEqual(["1", "2", "3"]);
    // priority is a number in the JSON, not the text of the option
    expect(server.snapshot().at(-1)).toMatchObject({ id: before.length + 1, title: "Badge reader at the side door is offline", assignee: "ana", priority: 1, status: "open" });
  });
});
