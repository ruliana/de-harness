/**
 * The page the assistant works on: a small self-hosted Kanban board ("Tern Board") on loopback, with bundled fonts so that
 * screenshots look the same wherever it runs.
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

const fonts = join(import.meta.dirname, "../../tests/support/fixtures");

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

const CSS = `
@font-face { font-family: "Test Sans"; src: url(/fonts/DejaVuSans-ascii.woff); font-weight: 400; }
@font-face { font-family: "Test Sans"; src: url(/fonts/DejaVuSans-Bold-ascii.woff); font-weight: 700; }
/* Square corners: Chromium anti-aliases a rounded corner a little differently from one paint to the next, which would make screenshots, and the recordings keyed on them, unstable. */
* { box-sizing: border-box; border-radius: 0 !important; }
body { margin: 0; font: 400 18px/26px "Test Sans", sans-serif; color: #1f2937; background: #e2e8f0; user-select: none; }
header { height: 64px; background: #1e3a5f; color: #ffffff; display: flex; align-items: center; gap: 20px; padding: 0 32px; font: 700 24px "Test Sans"; }
header small { font: 400 16px "Test Sans"; color: #bcd0e8; }
/* The right 356 px are left free for the assistant's panel (340 px + 16 px margin). */
#board { display: flex; gap: 20px; padding: 28px 376px 28px 32px; }
.column { flex: 1; min-width: 0; min-height: 640px; background: #cbd5e1; border: 2px solid #cbd5e1; padding: 14px; }
.column.over { border: 2px dashed #1e3a5f; background: #bfdbfe; }
.column h2 { margin: 0 0 12px; font: 700 20px/28px "Test Sans"; color: #1f2937; display: flex; justify-content: space-between; }
.column h2 span { color: #475569; font-weight: 400; }
.card:focus { outline: none; }
.card { background: #ffffff; border: 1px solid #94a3b8; border-left: 6px solid #1e3a5f; padding: 12px 14px; margin-bottom: 12px; cursor: grab; }
.card b { display: block; font: 700 19px/26px "Test Sans"; margin-bottom: 6px; }
.who { display: flex; align-items: center; gap: 8px; font-size: 16px; color: #334155; }
.who i { width: 24px; height: 24px; display: inline-block; text-align: center; font: 700 14px/24px "Test Sans"; font-style: normal; color: #ffffff; border-radius: 0 !important; }
.who.none { color: #64748b; }
.who.none i { background: #cbd5e1; color: #64748b; }
.Ada i { background: #b45309; } .Sam i { background: #0f766e; } .Priya i { background: #7e22ce; } .Lee i { background: #be123c; }
.ghost { position: fixed; z-index: 50; pointer-events: none; width: 250px; opacity: .92; box-shadow: 6px 8px 0 rgba(15,23,42,.25); }
#backdrop { position: fixed; inset: 0; background: rgba(15,23,42,.5); display: none; z-index: 20; }
#backdrop.open { display: block; }
#dialog { position: absolute; left: 170px; top: 110px; width: 520px; background: #ffffff; border: 2px solid #1e3a5f; padding: 24px 28px 28px; }
#dialog h1 { margin: 0 0 4px; font: 700 28px/34px "Test Sans"; }
#dialog h3 { margin: 18px 0 8px; font: 700 16px/22px "Test Sans"; color: #475569; }
.opts { display: flex; flex-wrap: wrap; gap: 8px; }
.opts button { font: 400 18px "Test Sans"; height: 44px; padding: 0 18px; border: 2px solid #94a3b8; background: #ffffff; color: #1f2937; cursor: pointer; }
.opts button.on { background: #1e3a5f; border-color: #1e3a5f; color: #ffffff; font-weight: 700; }
#close { margin-top: 24px; width: 100%; height: 50px; border: 0; background: #0f766e; color: #ffffff; font: 700 20px "Test Sans"; cursor: pointer; }
`;

const script = (cards: Card[]) => `
const COLUMNS = ${JSON.stringify(COLUMNS)}, PEOPLE = ${JSON.stringify(PEOPLE)};
let cards = ${JSON.stringify(cards)};
let open = null;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const who = (a) => { const w = el('div', 'who ' + (a ?? 'none')); w.append(el('i', '', a ? a[0] : '?'), document.createTextNode(a ?? 'Unassigned')); return w; };
async function save(id, change) {
  const res = await fetch('/api/cards/' + id, { method: 'POST', body: JSON.stringify(change) });
  cards = (await res.json()).cards;
  render();
}
function render() {
  const board = $('#board');
  board.replaceChildren(...COLUMNS.map((name) => {
    const mine = cards.filter((c) => c.column === name);
    const col = el('section', 'column'); col.dataset.column = name;
    const h = el('h2', '', name); h.append(el('span', '', String(mine.length)));
    col.append(h, ...mine.map((c) => { const card = el('div', 'card'); card.dataset.id = c.id; card.setAttribute('role', 'button'); card.tabIndex = 0; card.append(el('b', '', c.title), who(c.assignee)); return card; }));
    return col;
  }));
  const card = cards.find((c) => c.id === open);
  $('#backdrop').classList.toggle('open', !!card);
  if (!card) return;
  const dialog = $('#dialog');
  const group = (label, names, current, pick) => {
    const box = el('div', 'opts');
    for (const n of names) { const b = el('button', n === current ? 'on' : '', n); b.addEventListener('click', () => pick(n)); box.append(b); }
    return [el('h3', '', label), box];
  };
  const close = el('button', '', 'Close'); close.id = 'close'; close.addEventListener('click', () => { open = null; render(); });
  dialog.replaceChildren(el('h1', '', card.title),
    ...group('Column', COLUMNS, card.column, (n) => save(card.id, { column: n })),
    ...group('Assignee', [...PEOPLE, 'Unassigned'], card.assignee ?? 'Unassigned', (n) => save(card.id, { assignee: n === 'Unassigned' ? null : n })),
    close);
}
// A press that moves more than a few pixels drags the card; one that does not opens it.
let drag = null;
document.addEventListener('pointerdown', (e) => {
  const card = e.target.closest?.('.card');
  if (!card || open !== null) return;
  drag = { card, x: e.clientX, y: e.clientY, ghost: null };
});
document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.ghost && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) {
    drag.ghost = drag.card.cloneNode(true); drag.ghost.classList.add('ghost'); document.body.append(drag.ghost); drag.card.style.opacity = '.35';
  }
  if (!drag.ghost) return;
  drag.ghost.style.left = (e.clientX - 125) + 'px'; drag.ghost.style.top = (e.clientY - 28) + 'px';
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.column');
  for (const c of document.querySelectorAll('.column')) c.classList.toggle('over', c === over);
});
document.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const { card, ghost } = drag; drag = null;
  ghost?.remove();
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.column');
  for (const c of document.querySelectorAll('.column')) c.classList.remove('over');
  if (!ghost) { open = Number(card.dataset.id); render(); return; }
  if (over && over.dataset.column !== cards.find((c) => c.id === Number(card.dataset.id)).column) save(Number(card.dataset.id), { column: over.dataset.column }); else render();
});
render();
`;

const page = (cards: Card[]) => `<!doctype html><html><head><meta charset="utf-8"><title>Tern Board</title><style>${CSS}</style></head><body>
<header>Tern Board <small>Website relaunch</small></header>
<div id="board"></div>
<div id="backdrop"><div id="dialog"></div></div>
<script>${script(cards)}</script></body></html>`;

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
    if (path.startsWith("/fonts/")) {
      try {
        return send(200, "font/woff", readFileSync(join(fonts, path.slice("/fonts/".length))));
      } catch {
        return send(404, "text/plain", "not found");
      }
    }
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
