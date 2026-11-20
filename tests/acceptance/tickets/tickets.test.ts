/**
 * Stateful API operations: an agent works a support-ticket queue over HTTP (examples/tickets).
 * The API is an in-process server the test starts; the model is Jev through a cassette (live scenario) or a script.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ScriptedModel, TOOL_QUESTION, createAgent, type RunResult } from "../../../src/index.js";
import { startTicketServer, type Ticket, type TicketServer } from "../../../examples/tickets/server.js";
import { createTicketDesk } from "../../../examples/tickets/tickets.js";
import { jevFor } from "../../support/models.js";

const INSTRUCTIONS = "Send every billing ticket to the billing team and close duplicates";
const BILLING = [1, 3, 6];
const DUPLICATES = [7, 8];

function table(before: Ticket[], after: Ticket[]): string {
  const cell = (s: string, n: number) => s.slice(0, n).padEnd(n);
  const rows = after.map((t, i) => `${String(t.id).padEnd(3)}${cell(t.subject, 40)} ${cell(before[i]!.team ?? "-", 10)} ${cell(t.team ?? "-", 10)} ${cell(before[i]!.status, 8)} ${cell(t.status, 8)}`);
  return [`id ${cell("subject", 40)} ${cell("team before", 10)} ${cell("team after", 10)} ${cell("status was", 8)} ${cell("status now", 8)}`, ...rows].join("\n");
}

describe("tickets: billing tickets to billing, duplicates closed (Jev)", () => {
  let server: TicketServer;
  let before: Ticket[];
  let after: Ticket[];
  let result: RunResult;

  beforeAll(async () => {
    server = await startTicketServer();
    before = server.snapshot();
    const desk = await createTicketDesk(server.url);
    result = await createAgent({ model: jevFor("tickets"), instructions: INSTRUCTIONS, tools: desk.tools, initialState: desk.initialState, maxSteps: 30 }).run();
    after = server.snapshot();
    console.log(`\n${table(before, after)}\n${result.status} in ${result.steps.length} steps, ${result.events.filter((e) => e.type === "request").length} Jev requests\n`);
    await server.close();
  });

  it("ends with every billing ticket on billing, both duplicates closed, and nothing else changed", () => {
    expect(result.status).toBe("ended");
    const expected = before.map((t) => ({ ...t, ...(BILLING.includes(t.id) ? { team: "billing" } : {}), ...(DUPLICATES.includes(t.id) ? { status: "closed" } : {}) }));
    expect(after).toEqual(expected);
  });

  it("gets no 4xx or 5xx response from the API during the run", () => {
    expect(server.log.length).toBeGreaterThan(0);
    expect(server.log.filter((e) => e.status >= 400)).toEqual([]);
  });

  it("keeps only the open ticket's details in the state", () => {
    for (const { request } of result.steps) {
      const { state } = request.state as { state: { queue: Record<string, unknown>[]; open_ticket?: { id: number } } };
      expect(state.queue).toHaveLength(8);
      for (const entry of state.queue) expect(Object.keys(entry).sort()).toEqual(["id", "status", "subject", "team"]);
    }
  });
});

describe("tickets: mechanics (scripted)", () => {
  let server: TicketServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("puts a 409 from the API in an error slot for one step, leaves the ticket alone, and goes on with a different action", async () => {
    server = await startTicketServer();
    const desk = await createTicketDesk(server.url);
    server.lock(6); // someone else is editing ticket 6
    const T = (id: number) => desk.initialState.queue.find((t) => (t as { id: number }).id === id) as { id: number; subject: string };
    const key = (id: number) => `#${id} ${T(id).subject}`;
    const model = new ScriptedModel([
      { [TOOL_QUESTION]: "open_ticket", "open_ticket.ticket": key(6) },
      { [TOOL_QUESTION]: "assign", "assign.team": "billing", "assign.instructed": 0.95 }, // 409
      { [TOOL_QUESTION]: "open_ticket", "open_ticket.ticket": key(1) }, // a different action
      { [TOOL_QUESTION]: "assign", "assign.team": "billing", "assign.instructed": 0.95 },
    ]);
    const result = await createAgent({ model, instructions: INSTRUCTIONS, tools: desk.tools, initialState: desk.initialState, maxSteps: 4 }).run();

    expect(result.status).toBe("step_limit");
    const stateAt = (i: number) => (model.requests[i]!.state as { state: Record<string, any>; previous_actions: { summary: string }[] });
    // the failed call is visible in the next request only, with the status and the API's reason
    expect(stateAt(2).state.error).toMatch(/409.*being edited by someone else/);
    expect(stateAt(2).previous_actions.at(-1)!.summary).toMatch(/^failed: .*409/);
    expect(stateAt(3).state.error).toBeUndefined();
    // the next step does something else, and the ticket that conflicted is untouched
    expect(result.steps.map((s) => s.tool)).toEqual(["open_ticket", "assign", "open_ticket", "assign"]);
    expect(result.steps[1]!.error).toMatch(/409/);
    expect(result.steps[2]!.error).toBeUndefined();
    const after = server.snapshot();
    expect(after.find((t) => t.id === 6)).toMatchObject({ team: null, status: "open" });
    expect(after.find((t) => t.id === 1)).toMatchObject({ team: "billing" });
    expect(server.log.filter((e) => e.status >= 400)).toEqual([{ method: "PATCH", path: "/tickets/6", status: 409 }]);
  });

  it("closes a ticket only when the judgment says its body marks a duplicate, and does not call the API otherwise", async () => {
    server = await startTicketServer();
    const desk = await createTicketDesk(server.url);
    const q = desk.initialState.queue;
    const key = (id: number) => `#${id} ${q.find((t) => t.id === id)!.subject}`;
    const close = (repeats: number) => ({ [TOOL_QUESTION]: "set_status", "set_status.status": "closed", "set_status.repeats_another": repeats });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "open_ticket", "open_ticket.ticket": key(5) }, close(0.1), { [TOOL_QUESTION]: "open_ticket", "open_ticket.ticket": key(7) }, close(0.95)]);
    const result = await createAgent({ model, instructions: INSTRUCTIONS, tools: desk.tools, initialState: desk.initialState, maxSteps: 4 }).run();
    expect(result.steps[1]!.error).toMatch(/not closed.*not say it is a duplicate/);
    expect(result.steps[3]!.error).toBeUndefined();
    const after = server.snapshot();
    expect(after.find((t) => t.id === 5)!.status).toBe("open");
    expect(after.find((t) => t.id === 7)!.status).toBe("closed");
    expect(server.log.filter((e) => e.method === "PATCH")).toEqual([{ method: "PATCH", path: "/tickets/7", status: 200 }]);
  });

  it("assigns a ticket only when the judgment says the instructions cover it, and does not call the API otherwise", async () => {
    server = await startTicketServer();
    const desk = await createTicketDesk(server.url);
    const key = (id: number) => `#${id} ${desk.initialState.queue.find((t) => t.id === id)!.subject}`;
    const assign = (instructed: number) => ({ [TOOL_QUESTION]: "assign", "assign.team": "technical", "assign.instructed": instructed });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "open_ticket", "open_ticket.ticket": key(5) }, assign(0.1), assign(0.5)]);
    const result = await createAgent({ model, instructions: INSTRUCTIONS, tools: desk.tools, initialState: desk.initialState, maxSteps: 3 }).run();
    expect(result.steps.map((s) => s.error)).toEqual([undefined, expect.stringMatching(/not assigned/), expect.stringMatching(/not assigned/)]);
    expect(server.snapshot().find((t) => t.id === 5)!.team).toBeNull();
    expect(server.log.filter((e) => e.method === "PATCH")).toEqual([]);
  });

  it("offers end only once every ticket has been opened", async () => {
    server = await startTicketServer();
    const desk = await createTicketDesk(server.url);
    const keys = desk.initialState.queue.map((t) => `#${t.id} ${t.subject}`);
    const model = new ScriptedModel([...keys.map((k) => ({ [TOOL_QUESTION]: "open_ticket", "open_ticket.ticket": k })), { [TOOL_QUESTION]: "end" }]);
    const result = await createAgent({ model, instructions: INSTRUCTIONS, tools: desk.tools, initialState: desk.initialState }).run();
    expect(result.status).toBe("ended");
    const toolOptions = (i: number) => Object.keys((model.requests[i]!.questions[TOOL_QUESTION] as { criteria: object }).criteria);
    for (let i = 0; i < 8; i++) expect(toolOptions(i)).not.toContain("end");
    expect(toolOptions(8)).toContain("end");
    expect(Object.keys(model.requests[8]!.questions)).not.toContain("open_ticket.ticket");
  });

  it("does not offer a ticket again once opened, and offers assign / set_status only while a ticket is open", async () => {
    server = await startTicketServer();
    const desk = await createTicketDesk(server.url);
    const first = (desk.initialState.queue[0] as { id: number; subject: string });
    const model = new ScriptedModel([{ [TOOL_QUESTION]: "open_ticket", "open_ticket.ticket": `#${first.id} ${first.subject}` }, { [TOOL_QUESTION]: "end" }]);
    await createAgent({ model, instructions: INSTRUCTIONS, tools: desk.tools, initialState: desk.initialState }).run();
    const options = (i: number, id: string) => Object.keys((model.requests[i]!.questions[id] as { criteria: object }).criteria);
    expect(Object.keys(model.requests[0]!.questions).sort()).toEqual([TOOL_QUESTION, "open_ticket.ticket"]);
    expect(options(0, "open_ticket.ticket")).toHaveLength(8);
    expect(options(1, "open_ticket.ticket")).toHaveLength(7);
    expect(options(1, "open_ticket.ticket").some((k) => k.startsWith(`#${first.id} `))).toBe(false);
    expect(Object.keys(model.requests[1]!.questions)).toEqual(expect.arrayContaining(["assign.team", "set_status.status", "tag.tag"]));
  });
});
