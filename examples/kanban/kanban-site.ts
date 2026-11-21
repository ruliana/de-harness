/**
 * The page the assistant works on: a small self-hosted Kanban board ("Tern Board") on loopback, with bundled fonts so that
 * screenshots look the same wherever it runs. The page is three static files in `page/` (`index.html`, `board.css` the theme, `board.js`, which
 * animates every change with CSS transitions: a card flies to its new place, an assignee fades in, the dialog grows in).
 *
 *   /            three columns, To Do, Doing and Done, with cards: a title and the assignee (a coloured disc with the initial and the name,
 *                or "Unassigned").
 *   drag         press a card, move it onto another column and let go: the card goes to the bottom of that column.
 *   click a card opens its dialog: the column it is in (three buttons), the assignee (five buttons) and Close. A choice is saved at once.
 * GET /api/board          the cards, in column order
 * POST /api/cards/<id>    `{ column?, assignee? }` moves or assigns a card
 *
 * The server keeps the board in memory, so a test or a demo reads what the person (or the agent) did from `site.cards()`.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { FONTS } from "../shared/fonts.js";

const here = join(import.meta.dirname, "page");
const PAGE: Record<string, [file: string, type: string]> = {
  "/board.css": ["board.css", "text/css; charset=utf-8"],
  "/board.js": ["board.js", "text/javascript; charset=utf-8"],
};

export const COLUMNS = ["To Do", "Doing", "Done"] as const;
export type Column = (typeof COLUMNS)[number];
export const PEOPLE = ["Ada", "Sam", "Priya", "Lee"] as const;
export type Card = { id: number; title: string; column: Column; assignee: string | null };

/** The board at the start of every run. */
export const START: Card[] = [
  { id: 1, title: "Fix login", column: "To Do", assignee: null },
  { id: 2, title: "Update docs", column: "To Do", assignee: null },
  { id: 3, title: "Write release notes", column: "To Do", assignee: "Lee" },
  { id: 4, title: "Design onboarding", column: "Doing", assignee: "Priya" },
  { id: 5, title: "Review pricing page", column: "Doing", assignee: "Ada" },
  { id: 6, title: "Set up CI", column: "Done", assignee: "Sam" },
  { id: 7, title: "Rotate API keys", column: "Done", assignee: "Lee" },
];

/**
 * What the page is, for the model, in a picture: the same page without the effects that are not the same pixels from one machine to the next
 * (blurred shadows and filters). The person sees the effects; the recordings of the model's answers are keyed on the picture it got.
 */
export const MODEL_STYLE = "*, *::before, *::after { box-shadow: none !important; filter: none !important; backdrop-filter: none !important; text-shadow: none !important; }";

const page = (cards: Card[]) => readFileSync(join(here, "index.html"), "utf-8").replace("__START__", () => JSON.stringify({ columns: COLUMNS, people: PEOPLE, cards }));

export type KanbanSite = {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** The cards as the server has them now. */
  cards(): Card[];
  /** Every request, as `METHOD /path`. */
  requests: string[];
  close(): Promise<void>;
};

export async function startKanbanSite(opts: { port?: number } = {}): Promise<KanbanSite> {
  let cards: Card[] = START.map((c) => ({ ...c }));
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    requests.push(`${req.method} ${path}`);
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    const font = FONTS[path.startsWith("/fonts/") ? path.slice("/fonts/".length) : ""];
    if (font) return send(200, "font/woff2", readFileSync(font));
    const file = PAGE[path];
    if (file) return send(200, file[1], readFileSync(join(here, file[0])));
    if (path === "/") return send(200, "text/html; charset=utf-8", page(cards));
    if (path === "/api/board") return send(200, "application/json", JSON.stringify({ cards }));
    const m = /^\/api\/cards\/(\d+)$/.exec(path);
    if (m && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const card = cards.find((c) => c.id === Number(m[1]));
        if (!card) return send(404, "application/json", JSON.stringify({ error: "no such card" }));
        const change = JSON.parse(body || "{}") as Partial<Pick<Card, "column" | "assignee">>;
        if (change.column !== undefined) {
          if (!COLUMNS.includes(change.column)) return send(400, "application/json", JSON.stringify({ error: "no such column" }));
          card.column = change.column;
          cards = [...cards.filter((c) => c !== card), card]; // to the bottom of its column
        }
        if (change.assignee !== undefined) card.assignee = change.assignee;
        send(200, "application/json", JSON.stringify({ cards }));
      });
      return;
    }
    send(404, "text/plain", "not found");
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, cards: () => cards.map((c) => ({ ...c })), requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
