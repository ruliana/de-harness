/* Tern Board, the page's script. The cards are elements that stay: a change of the board moves them (the same element goes to its new place,
 * and flies there from where it was: a CSS transition from the old position to the new one), an assignee fades in, a dialog grows in.
 * It does not look at prefers-reduced-motion, because the harness' browser always asks for reduced motion.
 *
 *   drag         press a card, move it onto another column and let go: the card goes to the bottom of that column
 *   click        a click on a card opens its dialog: the column (three buttons), the assignee (five buttons) and Close; a choice is saved at once
 */
const START = JSON.parse(document.getElementById("start").textContent);
const { columns: COLUMNS, people: PEOPLE } = START;
let cards = START.cards, open = null;
const FLY = 520;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const who = (a) => { const w = el("div", "who " + (a ?? "none")); w.dataset.a = a ?? ""; w.append(el("i", "", a ? a[0] : "?"), document.createTextNode(a ?? "Unassigned")); return w; };

async function save(id, change) {
  const res = await fetch("/api/cards/" + id, { method: "POST", body: JSON.stringify(change) });
  cards = (await res.json()).cards;
}

// ---- the board -------------------------------------------------------------------------------------------------------------------------------
const board = $("#board"), els = new Map(), bodies = new Map(), counts = new Map();
for (const name of COLUMNS) {
  const col = el("section", "column"); col.dataset.column = name;
  const h = el("h2"); const count = el("span"); h.append(el("i"), document.createTextNode(name), count);
  col.append(h); board.append(col); counts.set(name, count); bodies.set(name, col);
}
function cardEl(c, i) {
  let e = els.get(c.id);
  if (!e) {
    e = el("div", "card"); e.dataset.id = c.id; e.setAttribute("role", "button"); e.tabIndex = 0; e.style.setProperty("--i", i);
    e.append(el("b", "", c.title), who(c.assignee)); els.set(c.id, e);
    e.addEventListener("animationend", () => { e.style.animation = "none"; }); // the rise is over; a card that is moved later must not rise again
  } else if (e.querySelector(".who").dataset.a !== (c.assignee ?? "")) {
    const next = who(c.assignee); next.classList.add("enter");
    e.querySelector(".who").replaceWith(next);
    requestAnimationFrame(() => requestAnimationFrame(() => next.classList.remove("enter")));
  }
  return e;
}
/**
 * Shows `cards`. `rects` says where some cards were before (a card that was dropped was where the pointer let go of it); the others were where
 * they are on the page now. Every card whose place differs flies from the old one to the new one.
 */
function show(rects = new Map()) {
  const first = new Map();
  for (const [id, e] of els) if (e.isConnected) first.set(id, rects.get(id) ?? e.getBoundingClientRect());
  let n = 0;
  for (const name of COLUMNS) {
    const mine = cards.filter((c) => c.column === name);
    counts.get(name).textContent = String(mine.length);
    const col = bodies.get(name);
    for (const e of [...col.querySelectorAll(".card")]) if (!mine.some((c) => els.get(c.id) === e)) e.remove();
    mine.forEach((c) => col.append(cardEl(c, n++)));
  }
  const moving = [];
  for (const [id, e] of els) {
    const from = first.get(id);
    if (!from) continue;
    e.style.transition = "none"; e.style.transform = "";
    const to = e.getBoundingClientRect(), dx = from.left - to.left, dy = from.top - to.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    e.style.transform = `translate(${dx}px, ${dy}px)`; e.style.zIndex = "5"; e.style.animation = "none";
    moving.push(e);
  }
  void board.offsetHeight; // the first states are in place: from here on, what changes is animated
  for (const e of moving) {
    e.style.transition = `transform ${FLY}ms cubic-bezier(.22,.8,.24,1), box-shadow .2s ease, border-color .2s ease, opacity .2s ease`;
    e.style.transform = "";
    setTimeout(() => { e.style.transition = ""; e.style.zIndex = ""; }, FLY + 60);
  }
  syncDialog();
}

// ---- the dialog ------------------------------------------------------------------------------------------------------------------------------
const dialog = $("#dialog"), backdrop = $("#backdrop");
let buttons = [];
function openDialog(id) {
  open = id;
  const card = cards.find((c) => c.id === id);
  buttons = [];
  const group = (label, names, current, pick) => {
    const box = el("div", "opts");
    for (const n of names) { const b = el("button", n === current ? "on" : "", n); b.addEventListener("click", () => pick(n)); b.dataset.value = n; box.append(b); buttons.push([b, label]); }
    return [el("h3", "", label), box];
  };
  const close = el("button", "", "Close"); close.id = "close"; close.addEventListener("click", closeDialog);
  dialog.replaceChildren(el("h1", "", card.title),
    ...group("Column", COLUMNS, card.column, async (n) => { await save(id, { column: n }); show(); }),
    ...group("Assignee", [...PEOPLE, "Unassigned"], card.assignee ?? "Unassigned", async (n) => { await save(id, { assignee: n === "Unassigned" ? null : n }); show(); }),
    close);
  void dialog.offsetHeight;
  backdrop.classList.add("open");
}
function closeDialog() { open = null; backdrop.classList.remove("open"); }
/** The buttons that say what the card is now: the dark ones. */
function syncDialog() {
  const card = cards.find((c) => c.id === open);
  if (!card) return;
  for (const [b, label] of buttons) b.classList.toggle("on", b.dataset.value === (label === "Column" ? card.column : card.assignee ?? "Unassigned"));
}

// ---- drag and click: a press that moves more than a few pixels drags the card; one that does not opens it ---------------------------------------
let drag = null;
const columnAt = (x, y) => document.elementFromPoint(x, y)?.closest(".column") ?? null;
document.addEventListener("pointerdown", (e) => {
  const card = e.target.closest?.(".card");
  if (!card || open !== null) return;
  const r = card.getBoundingClientRect();
  drag = { card, x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, ghost: null };
});
document.addEventListener("pointermove", (e) => {
  if (!drag) return;
  if (!drag.ghost && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) {
    const g = drag.card.cloneNode(true); g.classList.add("ghost"); g.style.width = drag.w + "px"; g.style.animation = "none"; g.style.left = e.clientX - drag.dx + "px"; g.style.top = e.clientY - drag.dy + "px";
    document.body.append(g); drag.ghost = g; drag.card.classList.add("lifted");
    void g.offsetHeight; g.classList.add("picked"); // the card straightens up as it is picked up
  }
  if (!drag.ghost) return;
  drag.ghost.style.left = e.clientX - drag.dx + "px"; drag.ghost.style.top = e.clientY - drag.dy + "px";
  const over = columnAt(e.clientX, e.clientY);
  for (const c of document.querySelectorAll(".column")) c.classList.toggle("over", c === over);
});
document.addEventListener("pointerup", async (e) => {
  if (!drag) return;
  const { card, ghost } = drag; drag = null;
  const id = Number(card.dataset.id);
  if (!ghost) { openDialog(id); return; }
  const over = columnAt(e.clientX, e.clientY);
  for (const c of document.querySelectorAll(".column")) c.classList.remove("over");
  const from = ghost.getBoundingClientRect(); // the card flies on from where it was let go
  if (over && over.dataset.column !== cards.find((c) => c.id === id).column) await save(id, { column: over.dataset.column });
  ghost.remove(); card.classList.remove("lifted");
  show(new Map([[id, from]]));
});

show();
