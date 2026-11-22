/**
 * A plain ticket desk for the behaviour spec (tests/spec): the tools a developer would write first, with honest
 * one-line descriptions and no guard rails. Unlike examples/tickets there is no "was this instructed?" judgment on any
 * tool, no gate on `end` and no hints such as "use it only when `instructions` ask for it": whether the agent does
 * exactly what the instructions ask, no more and no less, is up to the harness.
 *
 *   assign(ticket, team)        PATCH the ticket's team
 *   set_status(ticket, status)  PATCH the ticket's status
 *   tag(ticket, tag)            POST a tag
 *   end                         built in
 *
 * The state holds every ticket in full (`tickets`: id, subject, body, status, team, tags), refreshed from the API
 * after every change, so the state is what the server says.
 */
import { defineTool, param, type AnyTool, type Json } from "../../src/index.js";
import { createApi } from "../../examples/tickets/tickets.js";
import { STATUSES, TAGS, TEAMS } from "../../examples/tickets/server.js";

type Full = { id: number; subject: string; body: string; status: string; team: string | null; tags: string[] };

export async function createDesk(baseUrl: string) {
  const api = createApi(baseUrl);
  const load = async (): Promise<Json[]> => {
    const index = await api.index();
    const full: Full[] = await Promise.all(index.map((t) => api.ticket(t.id)));
    return full.map((t) => ({ id: t.id, subject: t.subject, body: t.body, status: t.status, team: t.team ?? "unassigned", tags: t.tags }));
  };
  const initialState = { tickets: await load() };

  const ticketParam = (question: string) =>
    param.choice({
      question,
      options: (ctx) => Object.fromEntries((ctx.state.tickets as { id: number; subject: string }[]).map((t) => [`#${t.id} ${t.subject}`, `ticket ${t.id}`])),
    });
  const idOf = (key: string) => Number(/^#(\d+) /.exec(key)![1]);

  const tools: AnyTool[] = [
    defineTool({
      name: "assign",
      description: "Assigns a ticket to a team.",
      params: {
        ticket: ticketParam("Which ticket of `state.tickets` should be assigned to a team, going by `instructions`?"),
        team: param.choice({
          question: "Which team should the ticket be assigned to, going by `instructions`?",
          options: Object.fromEntries(TEAMS.map((t) => [t, `the ${t} team`])),
        }),
      },
      run: async ({ ticket, team }) => {
        const id = idOf(ticket);
        await api.patch(id, { team });
        return { state: { tickets: await load() }, summary: `assigned ticket ${id} to ${team}` };
      },
    }),
    defineTool({
      name: "set_status",
      description: "Sets the status of a ticket, for instance closes it.",
      params: {
        ticket: ticketParam("Which ticket of `state.tickets` should get a new status, going by `instructions`?"),
        status: param.choice({
          question: "Which status should the ticket get, going by `instructions`?",
          options: Object.fromEntries(STATUSES.map((s) => [s, `the ticket is ${s}`])),
        }),
      },
      run: async ({ ticket, status }) => {
        const id = idOf(ticket);
        await api.patch(id, { status });
        return { state: { tickets: await load() }, summary: `set ticket ${id} to ${status}` };
      },
    }),
    defineTool({
      name: "tag",
      description: "Adds a tag to a ticket.",
      params: {
        ticket: ticketParam("Which ticket of `state.tickets` should get a tag, going by `instructions`?"),
        tag: param.choice({
          question: "Which tag should the ticket get, going by `instructions`?",
          options: Object.fromEntries(TAGS.map((t) => [t, `the tag ${t}`])),
        }),
      },
      run: async ({ ticket, tag }) => {
        const id = idOf(ticket);
        await api.addTag(id, tag);
        return { state: { tickets: await load() }, summary: `tagged ticket ${id} as ${tag}` };
      },
    }),
  ];

  return { tools, initialState };
}
