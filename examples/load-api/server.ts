/**
 * Two small HTTP APIs on one loopback port, each described by an OpenAPI 3 document that the server also serves.
 *
 *   /helpdesk/openapi.json   GET    /helpdesk/tickets?status&assignee     list (no bodies)
 *                            GET    /helpdesk/tickets/{id}                one ticket
 *                            POST   /helpdesk/tickets                     create (its `title` is free text)
 *                            PATCH  /helpdesk/tickets/{id}                {assignee?, labels?}
 *                            POST   /helpdesk/tickets/{id}/close          {resolution?, notify?}; 409 when already closed
 *                            DELETE /helpdesk/tickets/{id}
 *   /inventory/openapi.json  GET    /inventory/items, GET /inventory/items/{id}      a second API, only there to be told apart
 *
 * The state is real: tickets change as the calls arrive, and every response is appended to `log` so a run can be checked
 * for 4xx / 5xx, and for which documents were read.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const ASSIGNEES = ["ana", "ben", "carla"] as const;
export const STATUSES = ["open", "closed"] as const;
export const LABELS = ["billing", "bug", "urgent"] as const;
export const RESOLUTIONS = ["fixed", "wontfix", "duplicate"] as const;

export type Ticket = {
  id: number;
  title: string;
  status: (typeof STATUSES)[number];
  assignee: (typeof ASSIGNEES)[number] | null;
  priority: number;
  labels: string[];
  resolution: string | null;
  notified: boolean;
};
export type LogEntry = { method: string; path: string; status: number };

/** Six tickets. Ana has two: #2 is closed already, #4 is the open one. #5 is open and merely mentions Ana. */
export function seedTickets(): Ticket[] {
  const t = (id: number, title: string, status: Ticket["status"], assignee: Ticket["assignee"], labels: string[] = []): Ticket => ({ id, title, status, assignee, priority: 2, labels, resolution: status === "closed" ? "fixed" : null, notified: false });
  return [
    t(1, "Printer on floor 2 jams on every page", "open", "ben", ["bug"]),
    t(2, "Reset the shared mailbox password", "closed", "ana"),
    t(3, "Invoice 4417 shows the wrong VAT number", "open", "carla", ["billing"]),
    t(4, "Badge reader at the front door is offline", "open", "ana", ["urgent"]),
    t(5, "Welcome pack for the new hire, to be prepared with Ana", "open", "ben"),
    t(6, "Old laptop to be recycled", "open", null),
  ];
}

const ITEMS = [
  { id: 1, name: "USB-C dock", stock: 14 },
  { id: 2, name: "27 inch monitor", stock: 3 },
];

const assignee = { type: "string", enum: [...ASSIGNEES], description: "who the ticket is assigned to" };

/** The OpenAPI document of the helpdesk API. The server URL is relative to where the document is read from. */
export const helpdeskSpec = {
  openapi: "3.0.3",
  info: { title: "Helpdesk", version: "1.0.0", description: "Support tickets: list, read, create, update, close and delete tickets." },
  servers: [{ url: "/helpdesk" }],
  paths: {
    "/tickets": {
      get: {
        operationId: "listTickets",
        summary: "List tickets",
        description: "Lists the tickets, newest last. Each has an id, title, status and assignee.",
        parameters: [
          { name: "status", in: "query", required: false, description: "only tickets with this status", schema: { $ref: "#/components/schemas/Status" } },
          { name: "assignee", in: "query", required: false, description: "only tickets assigned to this person", schema: { $ref: "#/components/schemas/Assignee" } },
        ],
      },
      post: {
        operationId: "createTicket",
        summary: "Create a ticket",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["title"], properties: { title: { type: "string", description: "what the ticket is about" }, assignee: { $ref: "#/components/schemas/Assignee" }, priority: { type: "integer", minimum: 1, maximum: 3, description: "1 is the most urgent" } } } } },
        },
      },
    },
    "/tickets/{id}": {
      parameters: [{ name: "id", in: "path", required: true, description: "the ticket", schema: { type: "integer" } }],
      get: { operationId: "getTicket", summary: "Read a ticket", description: "Returns one ticket with its labels, priority and resolution." },
      patch: {
        operationId: "updateTicket",
        summary: "Reassign or label a ticket",
        description: "Changes who a ticket is assigned to, or which labels it carries.",
        requestBody: {
          content: { "application/json": { schema: { type: "object", properties: { assignee: { $ref: "#/components/schemas/Assignee" }, labels: { type: "array", description: "the labels the ticket should carry", items: { type: "string", enum: [...LABELS] } } } } } },
        },
      },
      delete: { operationId: "deleteTicket", summary: "Delete a ticket", description: "Removes the ticket for good." },
    },
    "/tickets/{id}/close": {
      parameters: [{ name: "id", in: "path", required: true, description: "the ticket", schema: { type: "integer" } }],
      post: {
        operationId: "closeTicket",
        summary: "Close a ticket",
        description: "Marks an open ticket as closed. Closing a closed ticket is a conflict.",
        requestBody: {
          content: {
            "application/json": { schema: { type: "object", properties: { resolution: { type: "string", enum: [...RESOLUTIONS], description: "how the ticket was resolved" }, notify: { type: "boolean", description: "email the requester that the ticket is closed" } } } },
          },
        },
      },
    },
  },
  components: { schemas: { Assignee: assignee, Status: { type: "string", enum: [...STATUSES], description: "open or closed" } } },
};

export const inventorySpec = {
  openapi: "3.0.3",
  info: { title: "Inventory", version: "1.0.0", description: "Office equipment in stock: list items and read one." },
  servers: [{ url: "/inventory" }],
  paths: {
    "/items": { get: { operationId: "listItems", summary: "List items", description: "Lists the equipment in stock with its quantity." } },
    "/items/{id}": { get: { operationId: "getItem", summary: "Read an item", parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }] } },
  },
};

export type HelpdeskServer = {
  url: string;
  log: LogEntry[];
  /** A copy of the tickets as they are now. */
  snapshot(): Ticket[];
  close(): Promise<void>;
};

export async function startServer(seed: Ticket[] = seedTickets()): Promise<HelpdeskServer> {
  const store = new Map(seed.map((t) => [t.id, structuredClone(t)]));
  let nextId = Math.max(0, ...store.keys()) + 1;
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
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const reply = (status: number, body: unknown) => {
      log.push({ method, path, status });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 204 ? undefined : JSON.stringify(body));
    };

    if (method === "GET" && path === "/helpdesk/openapi.json") return reply(200, helpdeskSpec);
    if (method === "GET" && path === "/inventory/openapi.json") return reply(200, inventorySpec);
    if (method === "GET" && path === "/inventory/items") return reply(200, ITEMS);
    const item = /^\/inventory\/items\/(\d+)$/.exec(path);
    if (method === "GET" && item) {
      const found = ITEMS.find((i) => i.id === Number(item[1]));
      return found ? reply(200, found) : reply(404, { error: `item ${item[1]} does not exist` });
    }

    const summary = ({ id, title, status, assignee }: Ticket) => ({ id, title, status, assignee });
    if (path === "/helpdesk/tickets") {
      if (method === "GET") {
        const status = url.searchParams.get("status");
        const who = url.searchParams.get("assignee");
        if (status && !STATUSES.includes(status as never)) return reply(400, { error: `unknown status ${status}` });
        if (who && !ASSIGNEES.includes(who as never)) return reply(400, { error: `unknown assignee ${who}` });
        return reply(200, [...store.values()].filter((t) => (!status || t.status === status) && (!who || t.assignee === who)).map(summary));
      }
      if (method === "POST") {
        const body = await readBody(req);
        if (typeof body.title !== "string" || !body.title) return reply(400, { error: "title is required" });
        if (body.assignee !== undefined && !ASSIGNEES.includes(body.assignee as never)) return reply(400, { error: `unknown assignee ${String(body.assignee)}` });
        const ticket: Ticket = { id: nextId++, title: body.title, status: "open", assignee: (body.assignee as Ticket["assignee"]) ?? null, priority: Number(body.priority ?? 2), labels: [], resolution: null, notified: false };
        store.set(ticket.id, ticket);
        return reply(201, ticket);
      }
      return reply(405, { error: "method not allowed" });
    }

    const match = /^\/helpdesk\/tickets\/(\d+)(\/close)?$/.exec(path);
    if (!match) return reply(404, { error: "no such route" });
    const ticket = store.get(Number(match[1]));
    if (!ticket) return reply(404, { error: `ticket ${match[1]} does not exist` });

    if (method === "GET" && !match[2]) return reply(200, ticket);
    if (method === "DELETE" && !match[2]) {
      store.delete(ticket.id);
      return reply(204, null);
    }
    const body = await readBody(req);
    if (method === "PATCH" && !match[2]) {
      if (body.assignee !== undefined && !ASSIGNEES.includes(body.assignee as never)) return reply(400, { error: `unknown assignee ${String(body.assignee)}` });
      if (body.labels !== undefined && !(Array.isArray(body.labels) && body.labels.every((l) => LABELS.includes(l as never)))) return reply(400, { error: "unknown label" });
      if (body.assignee !== undefined) ticket.assignee = body.assignee as Ticket["assignee"];
      if (body.labels !== undefined) ticket.labels = body.labels as string[];
      return reply(200, ticket);
    }
    if (method === "POST" && match[2]) {
      if (ticket.status === "closed") return reply(409, { error: `ticket ${ticket.id} is already closed` });
      if (body.resolution !== undefined && !RESOLUTIONS.includes(body.resolution as never)) return reply(400, { error: `unknown resolution ${String(body.resolution)}` });
      ticket.status = "closed";
      ticket.resolution = (body.resolution as string | undefined) ?? "fixed";
      ticket.notified = body.notify === true;
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
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}
