/**
 * Renders a Wikipedia run as a short video and an animated PNG (the media of the README).
 *
 *   npm run example:wikipedia:demo -- --from Linux --to Helsinki --out docs/media
 *
 * It runs the same agent as `main.ts`, by default replayed from the recordings in tests/cassettes (no network, no
 * key), and draws one frame per moment of each step with headless Chromium: the article the agent is on and the links it
 * may follow, the question asked, the tool call it chose and what came back. ffmpeg then makes the MP4, WebM and APNG.
 * Needs Playwright's Chromium and ffmpeg. Article text is from Wikipedia (CC BY-SA 4.0).
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
type Frame = { html: string; seconds: number };

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
async function capture(): Promise<{ steps: Step[]; reached: boolean }> {
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
  return { steps, reached: result.status === "ended" && wiki.current().title === to };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

const css = `
*{box-sizing:border-box;margin:0}
body{width:1280px;height:720px;background:#0f1419;color:#e6edf3;font:20px/1.4 Inter,system-ui,sans-serif;display:flex;flex-direction:column}
header{height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 32px;border-bottom:1px solid #263040;font-size:20px}
header b{color:#7ee0a8;font-weight:600}header span{color:#8b98a9}
main{flex:1;display:flex;gap:24px;padding:24px 32px;min-height:0}
.card{background:#171e27;border:1px solid #263040;border-radius:14px;padding:22px 24px}
.article{flex:1.45;display:flex;flex-direction:column;gap:14px}
.agent{flex:1;display:flex;flex-direction:column;gap:14px}
h1{font:600 34px/1.15 "Linux Libertine",Georgia,serif;border-bottom:1px solid #263040;padding-bottom:10px}
.lead{font:19px/1.45 Georgia,serif;color:#c7d1dc}
.label{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8b98a9;margin-bottom:8px}
.chips{display:flex;flex-wrap:wrap;gap:7px}
.chip{font-size:16px;padding:3px 10px;border-radius:999px;background:#1f2a37;color:#9fb3c8;border:1px solid #2c3a4b}
.chip.pick{background:#143d2a;color:#7ee0a8;border-color:#2f9e63;font-weight:600;box-shadow:0 0 0 3px #2f9e6355}
.more{font-size:15px;color:#6b7a8c;margin-top:8px}
.q{font-size:18px;color:#c7d1dc}.q code{color:#f0c674}
.tools{display:flex;gap:8px}
.tool{font:16px "DejaVu Sans Mono",monospace;padding:6px 12px;border-radius:8px;background:#1f2a37;color:#8b98a9;border:1px solid #2c3a4b}
.tool.pick{background:#143d2a;color:#7ee0a8;border-color:#2f9e63}
pre{font:19px/1.5 "DejaVu Sans Mono",monospace;color:#7ee0a8;white-space:pre-wrap}
.res{font-size:18px;color:#c7d1dc}
.dim{opacity:.35}
footer{height:84px;border-top:1px solid #263040;padding:0 32px;display:flex;align-items:center;gap:10px;flex-wrap:nowrap;overflow:hidden}
.crumb{padding:6px 14px;border-radius:8px;background:#1f2a37;font-size:18px;white-space:nowrap}
.crumb.now{background:#143d2a;color:#7ee0a8;font-weight:600}.arrow{color:#566377}
.big{font:600 48px/1.2 Inter,sans-serif}.goal{font:600 40px/1.25 Georgia,serif;color:#7ee0a8}
.center{align-items:center;justify-content:center;text-align:center;flex-direction:column;gap:18px;flex:1;display:flex}
`;

const page = (header: string, body: string, trail: string[]) =>
  `<style>${css}</style><header><div><b>de-harness</b> <span>· Wikipedia navigation</span></div><span>${esc(header)}</span></header>${body}` +
  `<footer>${trail.length ? `<span class="label" style="margin:0">Trail</span>` + trail.map((t, i) => `<span class="crumb${i === trail.length - 1 ? " now" : ""}">${esc(clip(t, 26))}</span>`).join('<span class="arrow">›</span>') : ""}</footer>`;

function introFrame(): string {
  return page("", `<main><div class="center"><div class="big">${esc(from)} <span style="color:#566377">→</span> <span class="goal" style="font-family:Inter">${esc(to)}</span></div><div class="q" style="max-width:900px">“${esc(instructionsFor(from, to))}”</div><div class="label">The model never writes text. At every step it answers closed questions: which tool, which link.</div></div></main>`, []);
}

function chips(options: Record<string, string>, pick?: string): string {
  const names = Object.keys(options);
  const shown = names.slice(0, 26);
  if (pick && names.includes(pick) && !shown.includes(pick)) shown[shown.length - 1] = pick;
  const hidden = names.length - shown.length;
  return `<div class="chips">${shown.map((n) => `<span class="chip${n === pick ? " pick" : ""}">${esc(clip(n, 30))}</span>`).join("")}</div>${hidden > 0 ? `<div class="more">… and ${hidden} more links offered</div>` : ""}`;
}

function stepFrame(s: Step, total: number, decided: boolean): string {
  const link = typeof s.args.link === "string" ? s.args.link : undefined;
  const tools = ["open_link", "go_back", "end"].filter((t) => t !== "go_back" || s.before.length > 1);
  const article = `<div class="card article"><h1>${esc(s.title)}</h1><div class="lead">${esc(clip(s.lead, 330))}</div><div><div class="label">Links the agent may follow (${Object.keys(s.options).length})</div>${chips(s.options, decided ? link : undefined)}</div></div>`;
  const question = `<div class="card"><div class="label">Questions asked of the model</div><div class="q"><code>__tool__</code> which tool?<div class="tools" style="margin-top:8px">${tools.map((t) => `<span class="tool${decided && t === s.tool ? " pick" : ""}">${t}</span>`).join("")}</div></div><div class="q" style="margin-top:14px"><code>open_link.link</code> which linked article is the best next step towards “${esc(to)}”?</div></div>`;
  const call = decided
    ? `<div class="card"><div class="label">Tool call</div><pre>${esc(s.tool)}(${link ? `link: "${esc(link)}"` : ""})</pre><div class="res">→ ${esc(s.summary)}</div></div>`
    : `<div class="card dim"><div class="label">Tool call</div><pre>…</pre></div>`;
  return page(`step ${s.n} of ${total}`, `<main>${article}<div class="agent">${question}${call}</div></main>`, decided ? s.trail : s.before);
}

function endFrame(s: Step, reached: boolean, count: number): string {
  const trail = s.trail;
  return page(`done in ${count} steps`, `<main><div class="center"><div class="label">The model chose <span style="color:#7ee0a8">end</span></div><div class="goal">${reached ? "Reached" : "Stopped on"} “${esc(trail.at(-1) ?? to)}”</div><div class="q">${count} steps, ${trail.length - 1} link${trail.length === 2 ? "" : "s"} followed</div></div></main>`, trail);
}

async function main() {
  const { steps, reached } = await capture();
  if (!reached) throw new Error(`the run did not reach "${to}": ${steps.map((s) => s.tool).join(", ")}`);
  const frames: Frame[] = [{ html: introFrame(), seconds: 3 }];
  for (const s of steps) {
    if (s.tool === "end") frames.push({ html: endFrame(s, reached, steps.length), seconds: 4 });
    else {
      frames.push({ html: stepFrame(s, steps.length, false), seconds: 2.2 }, { html: stepFrame(s, steps.length, true), seconds: 3 });
    }
  }

  const out = values.out!;
  const work = join(out, ".frames");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const tab = await context.newPage();
  const list: string[] = [];
  for (const [i, f] of frames.entries()) {
    await tab.setContent(f.html);
    const file = join(work, `f${String(i).padStart(3, "0")}.png`);
    await tab.screenshot({ path: file });
    list.push(`file '${file.replace(/^.*\/\.frames\//, "")}'`, `duration ${f.seconds}`);
  }
  await browser.close();
  list.push(list[list.length - 2]!); // the concat demuxer ignores the duration of the last file unless it is repeated
  writeFileSync(join(work, "frames.txt"), list.join("\n") + "\n");

  const ff = (...args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(work, "frames.txt"), ...args], { stdio: "inherit" });
  ff("-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "20", "-movflags", "+faststart", join(out, "wikipedia-demo.mp4"));
  ff("-vf", "fps=30", "-c:v", "libvpx-vp9", "-crf", "34", "-b:v", "0", join(out, "wikipedia-demo.webm"));
  ff("-vf", "scale=800:-1:flags=lanczos,fps=5", "-plays", "0", "-f", "apng", join(out, "wikipedia-demo.png"));
  rmSync(work, { recursive: true, force: true });
  console.log(`${from} > ${to}: ${steps.length} steps, ${frames.length} frames, written to ${out}`);
}

await main();
