/**
 * Renders a Wikipedia run as a short video (the MP4 of the README).
 *
 *   npm run example:wikipedia:demo -- --from Linux --to Helsinki --out docs/media
 *
 * It runs the same agent as `main.ts`, by default replayed from the recordings in tests/cassettes (no key), then opens
 * each article the agent visited on en.wikipedia.org at the pinned revision and screenshots it with headless Chromium:
 * first the page, then the links the agent may follow boxed, then the link it chose circled, with the tool call as a
 * caption. ffmpeg makes the small MP4 (960 px, 10 fps, no audio). Needs network access to Wikipedia, Playwright's Chromium and ffmpeg.
 * Screenshots show Wikipedia (CC BY-SA 4.0).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { CassetteModel, JevModel, createAgent, type HarnessEvent } from "../../src/index.js";
import { wikipediaFetch } from "./http.js";
import { createWikipedia, instructionsFor } from "./wikipedia.js";

type Step = { n: number; title: string; lead: string; options: Record<string, string>; tool: string; args: Record<string, unknown>; summary: string; /** The trail before the tool ran, and after. */ before: string[]; trail: string[] };
type Shot = { file: string; seconds: number };

const { values } = parseArgs({
  options: {
    from: { type: "string", default: "Telescope" },
    to: { type: "string", default: "Jupiter" },
    out: { type: "string", default: "docs/media" },
    live: { type: "boolean", default: false },
    "max-steps": { type: "string", default: "10" },
  },
});
const from = values.from!;
const to = values.to!;

/** Runs the agent and keeps, per step, what a viewer needs to see. */
async function capture(): Promise<{ steps: Step[]; reached: boolean; revisions: Map<string, number> }> {
  const wiki = await createWikipedia({ start: from, fetch: wikipediaFetch({ dir: "tests/cassettes/wikipedia-http", mode: values.live ? "passthrough" : "replay" }) });
  const model = values.live ? new JevModel({ apiKey: process.env.TYPESAFE_API_KEY }) : new CassetteModel({ dir: "tests/cassettes/wikipedia" });
  const steps: Step[] = [];
  let pending: Partial<Step> = {};
  const result = await createAgent({
    model,
    instructions: instructionsFor(from, to),
    tools: wiki.tools,
    initialState: wiki.initialState,
    maxSteps: Number(values["max-steps"]),
    onEvent: (e: HarnessEvent) => {
      if (e.type === "request" && e.phase !== "order_check") {
        const q = e.request.questions["open_link.link"] as { criteria?: Record<string, string> } | undefined;
        pending = { n: e.step, title: wiki.current().title, lead: wiki.current().lead, options: q?.criteria ?? {}, before: wiki.trail() };
      }
      if (e.type === "tool_call") pending = { ...pending, tool: e.tool, args: e.args };
      if (e.type === "tool_result") steps.push({ ...(pending as Step), summary: e.summary ?? e.error ?? "", trail: wiki.trail() });
    },
  }).run();
  return { steps, reached: result.status === "ended" && wiki.current().title === to, revisions: new Map(wiki.pages().map((p) => [p.title, p.revision])) };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const introHtml = () => `<style>
*{box-sizing:border-box;margin:0}
body{width:1280px;height:720px;background:#0f1419;color:#e6edf3;font:20px/1.4 Inter,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;text-align:center;flex-direction:column;gap:22px}
b{font-size:22px;color:#7ee0a8;font-weight:600}.big{font:600 52px/1.2 Inter,sans-serif}.goal{color:#7ee0a8}.q{max-width:900px;color:#c7d1dc;font-size:22px}.dim{color:#8b98a9;font-size:18px;max-width:820px}
</style><b>de-harness · Wikipedia navigation</b><div class="big">${esc(from)} <span style="color:#566377">→</span> <span class="goal">${esc(to)}</span></div><div class="q">“${esc(instructionsFor(from, to))}”</div><div class="dim">The model never writes text. At every step it answers closed questions: which tool, which link.</div>`;

/** Runs in the page: hides page furniture that is not part of the article. */
const TIDY_CSS = ".mw-revision,.vector-sticky-header,#vector-appearance-pinned-container,.vector-appearance-landmark{display:none!important}";

type Overlay = { caption: [string, string]; ring?: string; candidates?: string[]; green?: boolean };

/** Runs in the page: draws the caption, the boxes around the links offered and the circle around the chosen one. */
function draw(o: Overlay): { found: boolean } {
  document.getElementById("de-overlay")?.remove();
  const root = document.createElement("div");
  root.id = "de-overlay";
  document.body.append(root);
  const el = (css: string) => {
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;" + css;
    root.append(d);
    return d;
  };
  const body = document.querySelector("#mw-content-text .mw-parser-output") ?? document.body;
  const skipped = "table,sup,figure,.hatnote,.navbox,.thumb,.reflist,.infobox,.sidebar,.toc,.mw-references-wrap";
  const titleOf = (a: HTMLAnchorElement) => {
    try {
      const u = new URL(a.href);
      return u.pathname.startsWith("/wiki/") && !u.pathname.includes(":", 6) ? decodeURIComponent(u.pathname.slice(6)).replace(/_/g, " ") : null;
    } catch {
      return null;
    }
  };
  const anchors = [...body.querySelectorAll<HTMLAnchorElement>("a[href]")].filter((a) => !a.closest(skipped) && titleOf(a));
  const inView = (r: DOMRect) => r.width > 0 && r.top >= 0 && r.bottom <= innerHeight - 100 && r.left >= 0 && r.right <= innerWidth;
  if (o.candidates) {
    const wanted = new Set(o.candidates);
    const seen = new Set<string>();
    for (const a of anchors) {
      const t = titleOf(a)!;
      const r = a.getClientRects()[0];
      if (!r || !wanted.has(t) || seen.has(t) || !inView(r)) continue;
      seen.add(t);
      el(`left:${r.left - 4}px;top:${r.top - 2}px;width:${r.width + 8}px;height:${r.height + 4}px;border:2px solid #f0a500;border-radius:6px;background:#f0a50022`);
    }
  }
  let found = true;
  if (o.ring) {
    const a = anchors.find((x) => titleOf(x) === o.ring && x.getClientRects()[0]);
    const r = a?.getClientRects()[0];
    found = !!r;
    if (r) el(`left:${r.left - 16}px;top:${r.top - 11}px;width:${r.width + 32}px;height:${r.height + 22}px;border:4px solid #e5383b;border-radius:50%;transform:rotate(-1.5deg);box-shadow:0 0 0 2px #fff,0 0 14px #e5383b99`);
  }
  const bar = el(`left:0;right:0;bottom:0;height:96px;background:${o.green ? "#0f3d27" : "#0f1419"};color:#e6edf3;padding:14px 32px;font:600 24px/1.3 Inter,system-ui,sans-serif;border-top:3px solid ${o.green ? "#2f9e63" : "#263040"}`);
  const l1 = document.createElement("div");
  l1.style.cssText = "font:600 26px/1.3 'DejaVu Sans Mono',monospace;color:#7ee0a8";
  l1.textContent = o.caption[0];
  const l2 = document.createElement("div");
  l2.style.cssText = "font:400 21px/1.4 Inter,system-ui,sans-serif;color:#c7d1dc;margin-top:4px";
  l2.textContent = o.caption[1];
  bar.append(l1, l2);
  return { found };
}

async function main() {
  const { steps, reached, revisions } = await capture();
  if (!reached) throw new Error(`the run did not reach "${to}": ${steps.map((s) => s.tool).join(", ")}`);
  const out = values.out!;
  const work = join(out, ".frames");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await context.addInitScript("globalThis.__name = (f) => f;"); // tsx wraps functions in a helper the page does not have
  const tab = await context.newPage();
  const shots: Shot[] = [];
  const shoot = async (seconds: number) => {
    const file = join(work, `f${String(shots.length).padStart(3, "0")}.png`);
    await tab.screenshot({ path: file });
    shots.push({ file: file.slice(work.length + 1), seconds });
  };
  const show = (o: Overlay) => tab.evaluate(draw, o);
  const settle = async () => {
    await tab.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
    await tab.waitForTimeout(400);
  };

  await tab.setContent(introHtml());
  await shoot(3);

  const total = steps.length;
  for (const s of steps) {
    const revision = revisions.get(s.title);
    if (revision === undefined) throw new Error(`no revision recorded for "${s.title}"`);
    await tab.goto(`https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(s.title)}&oldid=${revision}`, { waitUntil: "load", timeout: 60_000 });
    await tab.addStyleTag({ content: TIDY_CSS });
    await settle();
    const where = `step ${s.n} of ${total} · on “${s.title}”`;
    const asked = `Asked: which of ${Object.keys(s.options).length} links is the best next step towards “${to}”?`;
    if (s.tool === "end") {
      await show({ caption: [`step ${s.n} of ${total} · end`, `Reached “${s.title}” after ${total - 1} links.`], green: true });
      await shoot(4.5);
      continue;
    }
    const link = String(s.args.link);
    await show({ caption: [where, asked] });
    await shoot(1.6);
    // Scroll the chosen link to the upper part of the screen; the first mention in the body is the one drawn.
    const ok = await tab.evaluate((t) => {
      const body = document.querySelector("#mw-content-text .mw-parser-output")!;
      const a = [...body.querySelectorAll<HTMLAnchorElement>("a[href]")].find((x) => {
        if (x.closest("table,sup,figure,.hatnote,.navbox,.thumb,.reflist,.infobox,.sidebar,.toc")) return false;
        try {
          const u = new URL(x.href);
          return u.pathname.startsWith("/wiki/") && decodeURIComponent(u.pathname.slice(6)).replace(/_/g, " ") === t;
        } catch {
          return false;
        }
      });
      if (!a) return false;
      window.scrollTo(0, window.scrollY + a.getBoundingClientRect().top - innerHeight * 0.3);
      return true;
    }, link);
    if (!ok) throw new Error(`the link "${link}" is not in the body of "${s.title}"`);
    await settle();
    await show({ caption: [where, `${asked.replace("Asked:", "Asked:")} The links it may follow are boxed.`], candidates: Object.keys(s.options) });
    await shoot(2.4);
    await show({ caption: [`step ${s.n} of ${total} · open_link(link: "${link}")`, `→ ${s.summary}`], ring: link });
    await shoot(3);
  }
  await browser.close();

  const list = shots.flatMap((f) => [`file '${f.file}'`, `duration ${f.seconds}`]);
  list.push(list[list.length - 2]!); // the concat demuxer ignores the duration of the last file unless it is repeated
  writeFileSync(join(work, "frames.txt"), list.join("\n") + "\n");

  const ff = (...args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(work, "frames.txt"), ...args], { stdio: "inherit" });
  // Small on purpose: 960 px wide, 10 fps, no audio (a README video, a few hundred KB).
  ff("-vf", "fps=10,scale=960:-2:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-crf", "38", "-preset", "veryslow", "-tune", "animation", "-g", "250", "-movflags", "+faststart", join(out, "wikipedia-demo.mp4"));
  rmSync(work, { recursive: true, force: true });
  console.log(`${from} > ${to}: ${steps.length} steps, ${shots.length} frames, written to ${out}`);
}

await main();
