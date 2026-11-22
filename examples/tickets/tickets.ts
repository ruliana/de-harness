/**
 * Stateful API operations: an agent works through a support-ticket queue over HTTP.
 *
 *   open_ticket(ticket)   read one ticket not yet opened into the state (its subject and body)
 *   assign(team, instructed)
 *                         assign the open ticket to a team; needs the judgment that `instructions` cover this ticket
 *   set_status(status, repeats_another)
 *                         set the status of the open ticket; closing needs the judgment that its body says it is a duplicate
 *   tag(tag)              add one tag to the open ticket
 *   end                   only once every ticket of the queue has been opened (a code decision: the model judges what a ticket needs,
 *                         code knows whether the whole queue has been looked at)
 *
 * The state holds a compact `queue` index (id, subject, team, status: no bodies) and the details of the open ticket
 * only, in `open_ticket`. Both are refreshed from the API after every change, so the state is what the server says.
 * Choice options are closed sets from code: the tickets of the index and the server's teams, statuses and tags.
 * A failed call (any 4xx / 5xx) throws, which the loop turns into the `error` slot for the next step.
 */
import { defineTool, param, type AnyTool, type Json } from "../../src/index.js";
import { STATUSES, TAGS, TEAMS } from "./server.js";

type IndexEntry = { id: number; subject: string; status: string; team: string | null };
type FullTicket = IndexEntry & { body: string; tags: string[] };

export function createApi(baseUrl: string) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(baseUrl + path, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(`${method} ${path} failed with ${res.status}: ${data.error ?? "no details"}`);
    return data;
  }
  return {
    index: () => call<IndexEntry[]>("GET", "/tickets"),
    ticket: (id: number) => call<FullTicket>("GET", `/tickets/${id}`),
    patch: (id: number, change: { team: string } | { status: string }) => call<FullTicket>("PATCH", `/tickets/${id}`, change),
    addTag: (id: number, tag: string) => call<FullTicket>("POST", `/tickets/${id}/tags`, { tag }),
  };
}

type QueueEntry = { id: number; subject: string; team: string; status: string };
const queueSlot = (index: IndexEntry[]): QueueEntry[] => index.map((t) => ({ id: t.id, subject: t.subject, team: t.team ?? "unassigned", status: t.status }));
const ticketSlot = (t: FullTicket): Json => ({ id: t.id, subject: t.subject, body: t.body, status: t.status, team: t.team ?? "unassigned", tags: t.tags });

/** The tools for one API, and the state slots to start from (read from the API now). */
export async function createTicketDesk(baseUrl: string) {
  const api = createApi(baseUrl);
  const initialState = { queue: queueSlot(await api.index()) };
  /** Tickets already opened: they are not offered again, so the queue is read once, front to back. */
  const opened = new Set<number>();

  const refresh = async (id: number) => ({ queue: queueSlot(await api.index()), open_ticket: ticketSlot(await api.ticket(id)) });
  const isOpen = (ctx: { state: Record<string, any> }) => ctx.state.open_ticket != null;
  /** The open ticket is still unassigned: the desk routes a ticket once, and a closed ticket cannot be routed. */
const canAssign = (ctx: { state: Record<string, any> }) => ctx.state.open_ticket != null && ctx.state.open_ticket.team === "unassigned" && ctx.state.open_ticket.status !== "closed";
/** A closed ticket stays closed. */
const canSetStatus = (ctx: { state: Record<string, any> }) => ctx.state.open_ticket != null && ctx.state.open_ticket.status !== "closed";
const idOf = (key: string) => Number(/^#(\d+) /.exec(key)![1]);
  const key = (t: { id: number; subject: string }) => `#${t.id} ${t.subject}`;

  const tools: AnyTool[] = [
    defineTool({
      name: "open_ticket",
      description: "Opens the next ticket of `state.queue` that has not been looked at yet, so that its body can be read and handled. Use it when the open ticket needs nothing more.",
      params: {
        ticket: param.choice({
          question: "Which ticket of `state.queue` should be looked at next to carry out `instructions`?",
          options: (ctx) => Object.fromEntries(((ctx.state.queue ?? []) as IndexEntry[]).filter((t) => !opened.has(t.id)).map((t) => [key(t), `Ticket ${t.id}, currently ${t.team} and ${t.status}`])),
        }),
      },
      run: async ({ ticket }) => {
        const id = idOf(ticket);
        const state = await refresh(id);
        opened.add(id);
        return { state, summary: `opened ticket ${id}` };
      },
    }),
    defineTool({
      name: "assign",
      effect: "change",
      description: "Assigns the open ticket (`state.open_ticket`), which has no team yet, to a team.",
      summarize: ({ team }, ctx) => `assigns the ticket ${ctx.state.open_ticket?.id} (${ctx.state.open_ticket?.subject}) to the ${team} team`,
      params: {
        team: param.choice({
          question: "Which team should the ticket in `state.open_ticket` go to to carry out `instructions`?",
          options: {
            billing: "payments, charges, refunds, subscriptions, invoices and VAT",
            technical: "bugs, crashes and errors of the product",
            accounts: "logins, passwords and profile settings",
            general: "anything else, such as how-to questions",
          },
        }),
        instructed: param.noul({
          question: "Is the ticket in `state.open_ticket` one of the tickets that `instructions` say to send to a team?",
          criteria: { true: "`instructions` name a kind of ticket and a team, and this ticket is of that kind", false: "`instructions` say nothing about sending a ticket of this kind to a team" },
        }),
      },
      available: canAssign,
      run: async ({ team, instructed }, ctx) => {
        const id = ctx.state.open_ticket.id as number;
        // Jev judges whether the instructions cover this ticket; code decides: no judgment, no API call.
        if (instructed !== true) throw new Error(`ticket ${id} was not assigned: \`instructions\` do not ask to send it to a team`);
        await api.patch(id, { team });
        return { state: await refresh(id), summary: `assigned ticket ${id} to ${team}` };
      },
    }),
    defineTool({
      name: "set_status",
      effect: "change",
      final: true,
      summarize: ({ status }, ctx) => `sets the ticket ${ctx.state.open_ticket?.id} (${ctx.state.open_ticket?.subject}) to ${status}`,
      description: "Sets the status of the open ticket (`state.open_ticket`), for instance closes it. A ticket is a duplicate only when its own body says it repeats another ticket, for instance 'Duplicate of ticket 5'; a ticket nobody repeats is not a duplicate.",
      params: {
        status: param.choice({
          question: "Which status should the ticket in `state.open_ticket` have to carry out `instructions`?",
          options: { open: "the ticket still needs work", pending: "the ticket waits for the customer", closed: "the ticket is done with: it repeats another ticket" },
        }),
        repeats_another: param.noul({
          question: "Does the body of `state.open_ticket` say that this ticket repeats, or is a duplicate of, another ticket?",
          criteria: { true: "The body names another ticket it duplicates, for instance 'Duplicate of ticket 5'", false: "The body describes a problem or a request and does not say it repeats another ticket" },
        }),
      },
      available: canSetStatus,
      run: async ({ status, repeats_another }, ctx) => {
        const id = ctx.state.open_ticket.id as number;
        // Jev judges whether the body marks a duplicate; code decides what to do with the judgment: only a ticket judged
        // to be a duplicate is closed, and the API is not called otherwise.
        if (status === "closed" && repeats_another !== true) throw new Error(`ticket ${id} was not closed: its body does not say it is a duplicate of another ticket`);
        await api.patch(id, { status });
        return { state: await refresh(id), summary: `set ticket ${id} to ${status}` };
      },
    }),
    defineTool({
      name: "tag",
      effect: "change",
      summarize: ({ tag }, ctx) => `adds the tag ${tag} to the ticket ${ctx.state.open_ticket?.id} (${ctx.state.open_ticket?.subject})`,
      description: "Adds one tag to the open ticket (`state.open_ticket`). Use it only when `instructions` ask for tags.",
      params: {
        tag: param.choice({
          question: "Which tag should be added to the ticket in `state.open_ticket` to carry out `instructions`?",
          options: { refund: "the customer wants money back", urgent: "the customer cannot work until it is fixed", vip: "the customer is a key account", bug: "the product misbehaves" },
        }),
      },
      available: isOpen,
      run: async ({ tag }, ctx) => {
        const id = ctx.state.open_ticket.id as number;
        await api.addTag(id, tag);
        return { state: await refresh(id), summary: `tagged ticket ${id} as ${tag}` };
      },
    }),
    defineTool({
      name: "end",
      description: "Stops, because every ticket of `state.queue` has been looked at and handled as `instructions` say.",
      available: (ctx) => ((ctx.state.queue ?? []) as IndexEntry[]).every((t) => opened.has(t.id)),
      run: (_args, ctx) => ({ end: true, output: ctx.state, summary: "ended" }),
    }),
  ];

  return { tools, initialState };
}

export { STATUSES, TAGS, TEAMS };
