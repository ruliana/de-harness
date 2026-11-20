/**
 * An in-process HTTP API for a support-ticket queue, started by the test (or the example) on a random loopback port.
 *
 *   GET   /tickets            -> [{ id, subject, status, team }]            the index, no bodies
 *   GET   /tickets/:id        -> { id, subject, body, status, team, tags }
 *   PATCH /tickets/:id        {team} | {status}                              404 unknown id, 400 bad value,
 *                                                                           409 closed ticket reassigned or ticket locked
 *   POST  /tickets/:id/tags   {tag}                                         404 / 400 / 409 as above
 *
 * Every response is appended to `log`, so a run can be checked for 4xx / 5xx. `lock(id)` makes the ticket answer 409
 * to every change until `unlock(id)`, the way a ticket someone else is editing would.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const TEAMS = ["billing", "technical", "accounts", "general"] as const;
export const STATUSES = ["open", "pending", "closed"] as const;
export const TAGS = ["refund", "urgent", "vip", "bug"] as const;

export type Ticket = { id: number; subject: string; body: string; status: (typeof STATUSES)[number]; team: (typeof TEAMS)[number] | null; tags: string[] };
export type LogEntry = { method: string; path: string; status: number };

/** Eight tickets: three about billing, two of them duplicates (of tickets 5 and 6), the rest unrelated. */
export function seedTickets(): Ticket[] {
  const t = (id: number, subject: string, body: string): Ticket => ({ id, subject, body, status: "open", team: null, tags: [] });
  return [
    t(1, "Charged twice for the March invoice", "My card was charged two times for the March invoice. Please look into the payment."),
    t(2, "Password reset email never arrives", "I click reset password but the email never arrives, so I cannot log in to my account."),
    t(3, "Refund for my cancelled subscription", "I cancelled my subscription last week and was still billed. I would like a refund."),
    t(4, "How do I export my data to CSV?", "Where in the app can I download all my records as a CSV file?"),
    t(5, "App crashes when I open the settings page", "The app shuts down every time I tap settings. Version 4.2 on Android."),
    t(6, "Invoice shows the wrong VAT number", "The VAT number printed on our latest invoice is not ours. Please correct the invoice."),
    t(7, "App crashes when I open the settings page", "Duplicate of ticket 5: I sent this a second time because nobody answered the first one."),
    t(8, "Password reset email never arrives", "Duplicate of ticket 2: still waiting for the reset email, sending this again."),
  ];
}

export type TicketServer = {
  url: string;
  log: LogEntry[];
  /** A copy of the store as it is now. */
  snapshot(): Ticket[];
  lock(id: number): void;
  unlock(id: number): void;
  close(): Promise<void>;
};

export async function startTicketServer(seed: Ticket[] = seedTickets()): Promise<TicketServer> {
  const store = new Map(seed.map((t) => [t.id, structuredClone(t)]));
  const locked = new Set<number>();
  const log: LogEntry[] = [];

  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    let text = "";
    for await (const chunk of req) text += chunk;
    try {
      const parsed: unknown = text ? JSON.parse(text) : {};
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const method = req.method ?? "GET";
    const reply = (status: number, body: unknown) => {
      log.push({ method, path, status });
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };

    if (method === "GET" && path === "/tickets") {
      return reply(200, [...store.values()].map(({ id, subject, status, team }) => ({ id, subject, status, team })));
    }
    const match = /^\/tickets\/(\d+)(\/tags)?$/.exec(path);
    const ticket = match ? store.get(Number(match[1])) : undefined;
    if (!match) return reply(404, { error: "no such route" });
    if (!ticket) return reply(404, { error: `ticket ${match[1]} does not exist` });
    if (method === "GET" && !match[2]) return reply(200, ticket);

    const body = await readBody(req);
    if (method === "PATCH" && !match[2]) {
      const keys = Object.keys(body);
      if (keys.length !== 1 || (keys[0] !== "team" && keys[0] !== "status")) return reply(400, { error: "send exactly one of team or status" });
      if (locked.has(ticket.id)) return reply(409, { error: `ticket ${ticket.id} is being edited by someone else` });
      if (body.team !== undefined) {
        if (!TEAMS.includes(body.team as never)) return reply(400, { error: `unknown team ${JSON.stringify(body.team)}` });
        if (ticket.status === "closed") return reply(409, { error: `ticket ${ticket.id} is closed and cannot be reassigned` });
        ticket.team = body.team as Ticket["team"];
      } else {
        if (!STATUSES.includes(body.status as never)) return reply(400, { error: `unknown status ${JSON.stringify(body.status)}` });
        ticket.status = body.status as Ticket["status"];
      }
      return reply(200, ticket);
    }
    if (method === "POST" && match[2]) {
      if (!TAGS.includes(body.tag as never)) return reply(400, { error: `unknown tag ${JSON.stringify(body.tag)}` });
      if (locked.has(ticket.id)) return reply(409, { error: `ticket ${ticket.id} is being edited by someone else` });
      if (ticket.tags.includes(body.tag as string)) return reply(409, { error: `ticket ${ticket.id} already has the tag ${String(body.tag)}` });
      ticket.tags.push(body.tag as string);
      return reply(200, ticket);
    }
    return reply(405, { error: "method not allowed" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    log,
    snapshot: () => [...store.values()].map((t) => structuredClone(t)),
    lock: (id) => void locked.add(id),
    unlock: (id) => void locked.delete(id),
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}
