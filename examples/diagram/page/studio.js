/* Diagram Studio, the page's script.
 *
 *   window.drawDiagram(text)   draws `text` (a flowchart or a sequence diagram; an empty text is "nothing drawn yet"); resolves `{ ok: true }` or
 *                              `{ ok: false, error }` when Mermaid cannot read it
 *
 * Mermaid draws a new SVG for every text. To make the change *look* like an edit, the new drawing is compared with the old one: what is in both
 * moves from where it was to where it is now, what is new grows or draws in, what is gone fades out. Everything is a CSS transition (the script
 * only sets the first and the last state); it does not look at prefers-reduced-motion because the harness' browser always asks for reduced motion.
 */
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  look: "classic",
  themeVariables: { fontFamily: '"Inter", sans-serif', fontSize: "17px", primaryColor: "#ffffff", primaryBorderColor: "#c7d2fe", primaryTextColor: "#1e1b4b", lineColor: "#818cf8", edgeLabelBackground: "#eef2ff" },
  flowchart: { htmlLabels: false, curve: "linear", nodeSpacing: 56, rankSpacing: 64, padding: 18, wrappingWidth: 400 },
  sequence: { actorMargin: 70, messageMargin: 44, boxMargin: 12, mirrorActors: true, width: 160, height: 56, useMaxWidth: false },
});

const MOVE = 650, ENTER = 560, LEAVE = 350, EASE = "cubic-bezier(.22,.8,.24,1)";
let drawn = 0;
const canvas = document.getElementById("canvas"), ghosts = document.getElementById("ghosts"), kindPill = document.getElementById("kind");
const code = document.querySelector("#source code");
// Mermaid builds its drawing in an element of the page that is out of sight, so that nothing of it flashes in the page while it works.
const bench = document.createElement("div");
bench.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden";
document.body.append(bench);

const EMPTY = `<svg viewBox="0 0 76 76" fill="none" stroke="#a5b4fc" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="8" width="24" height="16" rx="6"/><rect x="46" y="8" width="24" height="16" rx="6"/><rect x="26" y="50" width="24" height="16" rx="6"/><path d="M30 16h16M18 24l12 26M58 24L46 50" stroke-dasharray="3 6"/></svg><b>Nothing drawn yet</b><span>Tell the assistant what to draw.</span>`;

// ---- the source pane -------------------------------------------------------------------------------------------------------------------------
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const TOKEN = /("[^"]*")|(-->>|->>|-->|---|-\.->)|(\bn\d+\b)|(^\s*(?:flowchart|sequenceDiagram|participant|alt|else|end)\b|\bas\b)|(\|[^|]+\|)|(:\s.*$)/g;
function highlight(line) {
  let out = "", at = 0;
  for (const m of line.matchAll(TOKEN)) {
    const cls = m[1] ? "str" : m[2] ? "arrow" : m[3] ? "id" : m[4] ? "kw" : m[5] ? "txt" : "txt";
    out += esc(line.slice(at, m.index)) + `<span class="${cls}">${esc(m[0])}</span>`;
    at = m.index + m[0].length;
  }
  return out + esc(line.slice(at));
}
/** The text of the pane is exactly `text` (the assistant reads it back from here): every line is a block that ends with its own newline (but the last). */
function showSource(text) {
  const before = new Map();
  for (const l of code.querySelectorAll(".ln")) before.set(l.dataset.t, (before.get(l.dataset.t) ?? 0) + 1);
  const lines = text.split("\n"), fresh = [];
  code.replaceChildren(...lines.map((line, i) => {
    const span = document.createElement("span");
    span.className = "ln"; span.dataset.t = line;
    span.innerHTML = highlight(line) + (i < lines.length - 1 ? "\n" : "");
    const left = before.get(line) ?? 0;
    if (left > 0) before.set(line, left - 1); else if (before.size > 0 || i > 0) fresh.push(span);
    return span;
  }));
  const body = code.parentElement; body.scrollTop = body.scrollHeight;
  if (!fresh.length) return;
  for (const s of fresh) s.classList.add("fresh");
  void code.offsetHeight;
  for (const s of fresh) s.classList.remove("fresh");
}

// ---- what is in a drawing --------------------------------------------------------------------------------------------------------------------
/** Everything that has an identity, by key: a node by its id, an edge by its ends, a message by who, to whom and what, an actor by its name. */
function parts(svg) {
  const m = new Map(), add = (key, el) => { if (el && !m.has(key)) m.set(key, el); };
  const seen = new Map(), once = (base) => { const n = (seen.get(base) ?? 0) + 1; seen.set(base, n); return base + "#" + n; };
  if (svg.getAttribute("aria-roledescription") === "sequence") {
    svg.querySelectorAll('g[data-et="participant"]').forEach((g) => add("a:" + g.dataset.id, g));
    svg.querySelectorAll("rect.actor-bottom").forEach((r) => add("ab:" + r.getAttribute("name"), r.parentElement));
    svg.querySelectorAll("line.actor-line").forEach((l) => add("life:" + l.dataset.id, l));
    svg.querySelectorAll('line[data-et="message"]').forEach((l) => {
      const t = l.previousElementSibling, key = once("m:" + l.dataset.from + ">" + l.dataset.to + ":" + (t?.textContent ?? ""));
      add(key + ":line", l); if (t?.matches("text.messageText")) add(key + ":text", t);
    });
    svg.querySelectorAll('g[data-et="control-structure"]').forEach((g) => add(once("c:" + (g.querySelector("text.loopText")?.textContent ?? "")), g));
  } else {
    svg.querySelectorAll("g.node").forEach((g) => add("n:" + (g.id.match(/flowchart-(.+)-\d+$/)?.[1] ?? g.id), g));
    svg.querySelectorAll("path.flowchart-link").forEach((p) => add("e:" + p.dataset.id, p));
    svg.querySelectorAll("g.edgeLabel").forEach((g) => add("l:" + (g.querySelector("[data-id]")?.dataset.id ?? g.textContent), g));
  }
  return m;
}
/** Where a part is on the screen, and how big it is in the drawing's own units (the drawing is zoomed to fit, and the zoom differs from text to text). */
function measure(svg, el) {
  const r = el.getBoundingClientRect(), vb = svg.viewBox.baseVal, k = svg.getBoundingClientRect().width / vb.width;
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width / k, h: r.height / k, k, ctm: el.getScreenCTM() };
}
/** The `translate(x, y)` of a part, as a CSS transform: what the part's own position is, to which the animation adds its movement. */
function base(el) {
  const m = (el.getAttribute("transform") ?? "").match(/^translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)$/);
  return m ? `translate(${m[1]}px, ${m[2]}px)` : "";
}
const isPath = (el) => el.localName === "path";
/** `d` of an old path in the coordinates of the new drawing, or null when the two do not have the same shape (same commands) and cannot be morphed. */
function morphFrom(oldPath, oldM, newPath, newM) {
  const tok = (d) => d.match(/[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const a = tok(oldPath), b = tok(newPath.getAttribute("d"));
  const sig = (t) => t.filter((x) => /[A-Za-z]/.test(x)).join("");
  if (/[^MLQ]/.test(sig(a)) || sig(a) !== sig(b) || a.length !== b.length) return null;
  const inv = newM.ctm.inverse(), out = [];
  for (let i = 0; i < a.length;) {
    if (/[A-Za-z]/.test(a[i])) { out.push(a[i++]); continue; }
    const p = new DOMPoint(+a[i], +a[i + 1]).matrixTransform(oldM.ctm).matrixTransform(inv);
    out.push(p.x.toFixed(2) + " " + p.y.toFixed(2)); i += 2;
  }
  return out.join(" ").replace(/([MLQ]) /g, "$1");
}

// ---- the change ------------------------------------------------------------------------------------------------------------------------------
function transition(el, props, ms) { el.style.transition = props.map((p) => `${p} ${ms}ms ${EASE}`).join(", "); }
function settle(el, ms, drawn = false) { setTimeout(() => { el.style.transition = ""; el.style.transform = ""; el.style.opacity = ""; el.style.d = ""; if (drawn) { el.style.strokeDasharray = ""; el.style.strokeDashoffset = ""; el.removeAttribute("pathLength"); } }, ms + 60); }

/** Puts the new drawing in place of the old one, so that it looks like the old one turning into the new one. */
function swap(oldSvg, newSvg) {
  const was = oldSvg ? parts(oldSvg) : new Map();
  const oldInfo = new Map(); let ghost = null, ghostBox = null;
  if (oldSvg) {
    ghostBox = oldSvg.getBoundingClientRect();
    let i = 0;
    for (const [key, el] of was) { oldInfo.set(key, { ...measure(oldSvg, el), d: isPath(el) ? el.getAttribute("d") : null, tag: String(i) }); el.setAttribute("data-k", String(i++)); }
    ghost = oldSvg.cloneNode(true);
  }
  canvas.replaceChildren(newSvg);
  const now = parts(newSvg), todo = [], matched = new Set();
  for (const [key, el] of now) {
    const old = oldInfo.get(key), m = measure(newSvg, el);
    if (old && Math.abs(old.w - m.w) < 1.5 && Math.abs(old.h - m.h) < 1.5) {
      matched.add(old.tag);
      if (isPath(el)) {
        const from = old.d === el.getAttribute("d") ? null : morphFrom(old.d, old, el, m);
        if (from) { el.style.d = `path("${from}")`; todo.push(() => { transition(el, ["d"], MOVE); el.style.d = `path("${el.getAttribute("d").replace(/"/g, "")}")`; settle(el, MOVE); }); }
        else if (old.d !== el.getAttribute("d")) { matched.delete(old.tag); todo.push(...enter(el, key)); }
        continue;
      }
      const dx = (old.cx - m.cx) / m.k, dy = (old.cy - m.cy) / m.k;
      if (Math.abs(dx) < .5 && Math.abs(dy) < .5) continue;
      const b = base(el);
      el.style.transform = `${b} translate(${dx}px, ${dy}px)`;
      todo.push(() => { transition(el, ["transform"], MOVE); el.style.transform = b || "none"; settle(el, MOVE); });
    } else todo.push(...enter(el, key));
  }
  // What was in the old drawing and has no counterpart now stays as it was, in a layer over the page, and fades out.
  if (ghost) {
    ghost.removeAttribute("id");
    for (const tag of matched) ghost.querySelector(`[data-k="${tag}"]`)?.remove();
    const host = canvas.getBoundingClientRect();
    Object.assign(ghost.style, { left: ghostBox.left - host.left + "px", top: ghostBox.top - host.top + "px", width: ghostBox.width + "px", height: ghostBox.height + "px", opacity: "1" });
    ghosts.replaceChildren(ghost);
  }
  void canvas.offsetHeight; // the first states are in place: from here on, what changes is animated
  for (const go of todo) go();
  if (ghost) { ghost.style.opacity = "0"; setTimeout(() => { if (ghosts.contains(ghost)) ghost.remove(); }, LEAVE + 80); }
}

/** A new part: a node or an actor grows in, an arrow draws itself, anything else fades in. Returns what starts it. */
function enter(el, key) {
  const b = base(el), box = key.startsWith("n:") || key.startsWith("a") || key.startsWith("l:");
  el.style.opacity = "0";
  if (key.startsWith("e:") || (key.endsWith(":line") && el.classList.contains("messageLine0"))) {
    el.style.transform = "";
    el.setAttribute("pathLength", "1");
    el.style.strokeDasharray = "1 1"; el.style.strokeDashoffset = "1";
    return [() => { transition(el, ["stroke-dashoffset", "opacity"], ENTER + 120); el.style.strokeDashoffset = "0"; el.style.opacity = "1"; settle(el, ENTER + 120, true); }];
  }
  el.style.transform = box ? `${b} scale(.82)` : `${b} translateY(10px)`;
  return [() => { transition(el, ["transform", "opacity"], ENTER); el.style.transform = b || "none"; el.style.opacity = "1"; settle(el, ENTER); }];
}

// ---- the page's one function -----------------------------------------------------------------------------------------------------------------
window.drawDiagram = async (text) => {
  await document.fonts.load('17px "Inter"'); await document.fonts.load('500 17px "Inter"'); await document.fonts.load('600 17px "Inter"');
  showSource(text);
  const oldSvg = canvas.querySelector("svg");
  if (!/\bn\d+\b/.test(text)) {
    kindPill.classList.remove("on");
    canvas.replaceChildren(Object.assign(document.createElement("div"), { className: "empty", innerHTML: EMPTY }));
    if (oldSvg) { ghosts.replaceChildren(); }
    return { ok: true };
  }
  const id = "diagram" + (++drawn);
  try {
    const { svg } = await mermaid.render(id, text, bench);
    const holder = document.createElement("div"); holder.innerHTML = svg;
    const el = holder.querySelector("svg"), [, , w, h] = el.getAttribute("viewBox").split(" ").map(Number);
    // Drawn as large as the canvas allows, up to one and a half times its natural size, so that a small diagram is still easy to read.
    const zoom = Math.min(1.5, 820 / w, 640 / h);
    el.setAttribute("width", String(Math.round(w * zoom))); el.setAttribute("height", String(Math.round(h * zoom)));
    el.removeAttribute("style");
    bench.replaceChildren();
    ghosts.replaceChildren();
    swap(oldSvg, el);
    kindPill.textContent = el.getAttribute("aria-roledescription") === "sequence" ? "Sequence diagram" : "Flowchart";
    kindPill.classList.add("on");
    // the dashed replies: a dash that suits the style
    el.querySelectorAll("line.messageLine1").forEach((l) => { l.style.strokeDasharray = "7 6"; });
    return { ok: true };
  } catch (e) {
    bench.replaceChildren(); ghosts.replaceChildren();
    canvas.replaceChildren(Object.assign(document.createElement("div"), { className: "error", textContent: String((e && e.message) || e) }));
    return { ok: false, error: String((e && e.message) || e) };
  }
};
window.drawDiagram("");
