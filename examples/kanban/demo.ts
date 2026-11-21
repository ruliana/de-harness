/**
 * Renders the assistant on the Kanban board as a short video (a small MP4 and an animated WebP), the media of the README.
 *
 *   npm run example:kanban:demo -- --out docs/media
 *
 * It runs the same two scenarios as the test (`move-assign`, then `ask-assignee`), by default replayed from the recordings in
 * tests/cassettes/kanban (no key, no network), in a Chromium that records the page. What a viewer sees besides the page: the person
 * types into the panel letter by letter, the model "thinks" a moment before each step (the replay would otherwise be instant), a pointer
 * and the Box that the model chose are drawn on the page, and a dragged card travels slowly. All of it is drawn into an element that the
 * session hides from the model (`hideFromModel`), so the pictures the model gets are the ones of the recordings.
 * ffmpeg encodes (960 px, 10 fps, no audio). Needs Playwright's Chromium and ffmpeg.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { CassetteModel, JevModel, type DecisionModel, type DecisionRequest, type DecisionResponse } from "../../src/index.js";
import { OVERLAY_FIELD, type BrowserSession } from "../../src/browser/index.js";
import { FONTS } from "../shared/fonts.js";
import { SCENARIOS, problems, runScenario, type Scenario } from "./run.js";

const { values } = parseArgs({ options: { out: { type: "string", default: "docs/media" }, live: { type: "boolean", default: false }, "think-ms": { type: "string", default: "650" } } });
const out = resolve(values.out!); // absolute: ffmpeg reads the frame list relative to the list file
const work = join(out, ".frames");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The model, made slower: the recordings answer at once, a viewer needs to see each step before the next. */
class Thinking implements DecisionModel {
  readonly id: string;
  constructor(private readonly inner: DecisionModel, private readonly ms: number) {
    this.id = inner.id;
  }
  async ask(request: DecisionRequest): Promise<DecisionResponse> {
    await sleep(this.ms);
    return this.inner.ask(request);
  }
}

const FX = "#demo-fx";
/** Runs in the page, before its own scripts (plain JavaScript in a string: it must not go through the compiler). Draws a pointer, click ripples and Boxes. */
const FX_SCRIPT = `(() => {
  const css = \`
    #demo-fx { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
    #demo-fx .dot { position: absolute; width: 20px; height: 20px; margin: -10px 0 0 -10px; background: #6366f1; border: 3px solid #ffffff; box-shadow: 0 0 0 2px #6366f1, 0 4px 12px rgba(15,18,38,.45); border-radius: 50%; transition: transform .15s ease; }
    #demo-fx .ring { position: absolute; width: 20px; height: 20px; margin: -10px 0 0 -10px; border: 3px solid #8b5cf6; border-radius: 50%; animation: ring .6s ease-out forwards; }
    #demo-fx .box { position: absolute; border: 3px solid #f59e0b; background: rgba(245,158,11,.14); border-radius: 14px; animation: fade 1.6s ease forwards; }
    #demo-fx .box.to { border-style: dashed; border-color: #10b981; background: rgba(16,185,129,.12); border-radius: 22px; }
    @keyframes ring { to { transform: scale(4); opacity: 0; } }
    @keyframes fade { 0% { opacity: 0; } 10%, 70% { opacity: 1; } 100% { opacity: 0; } }
  \`;
  const mount = () => {
    if (document.getElementById('demo-fx')) return;
    const fx = document.createElement('div'); fx.id = 'demo-fx';
    fx.innerHTML = '<style>' + css + '</style><div class="dot" style="left:-50px;top:-50px"></div>';
    document.documentElement.append(fx);
    const dot = fx.querySelector('.dot');
    addEventListener('mousemove', (e) => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', (e) => { const r = document.createElement('div'); r.className = 'ring'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; fx.append(r); setTimeout(() => r.remove(), 700); }, true);
  };
  window.__fxBox = (boxes) => { mount(); const fx = document.getElementById('demo-fx'); for (const [b, kind] of boxes) { const d = document.createElement('div'); d.className = 'box ' + kind; d.style.left = b.left * innerWidth + 'px'; d.style.top = b.top * innerHeight + 'px'; d.style.width = (b.right - b.left) * innerWidth + 'px'; d.style.height = (b.bottom - b.top) * innerHeight + 'px'; fx.append(d); setTimeout(() => d.remove(), 1700); } };
  if (document.documentElement) mount(); else addEventListener('DOMContentLoaded', mount);
})();`;

type Box = { top: number; bottom: number; left: number; right: number };
const boxes = (args: Record<string, unknown>): [Box, string][] => {
  const out: [Box, string][] = [];
  for (const [key, v] of Object.entries(args)) {
    if (v && typeof v === "object" && "top" in v && "left" in v) out.push([v as Box, key === "column" ? "to" : "from"]);
  }
  return out;
};

/** The person types into the panel's field, key by key (nothing is ever shown as selected). */
async function typeSlowly(text: string, browser: BrowserSession) {
  await browser.userTypesSlowly(OVERLAY_FIELD, text, { delayMs: 38 });
  await sleep(450);
}

const face = (weight: number, key: string) => `@font-face{font-family:"Inter";font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(FONTS[key]!).toString("base64")}) format("woff2")}`;
const titleCard = (kicker: string, big: string, quote: string) => `<style>
${face(400, "inter-400.woff2")}${face(600, "inter-600.woff2")}${face(700, "inter-700.woff2")}
*{box-sizing:border-box;margin:0}
body{width:1280px;height:800px;background:radial-gradient(900px 600px at 15% 0%,#312e81 0%,transparent 70%),radial-gradient(800px 560px at 100% 100%,#581c87 0%,transparent 65%),#0f1226;color:#e0e7ff;font:400 20px/1.45 "Inter",sans-serif;display:flex;align-items:center;justify-content:center;text-align:center;flex-direction:column;gap:26px}
b{font:600 15px/1 "Inter";letter-spacing:.14em;text-transform:uppercase;color:#a5b4fc}.big{font:700 58px/1.15 "Inter";letter-spacing:-.03em;max-width:1000px;color:#fff}.q{max-width:900px;color:#c7d2fe;font-size:26px}.dim{color:#8187c4;font-size:17px;max-width:820px}
</style><b>${kicker}</b><div class="big">${big}</div><div class="q">${quote}</div><div class="dim">The model never writes text. At each step it answers closed questions: which tool, which card, which column, which button.</div>`;

type Segment = { video: string; trimSeconds: number; frames: string[]; scenario: Scenario };

async function record(scenario: Scenario, index: number): Promise<Segment> {
  const dir = join(work, `video-${index}`);
  mkdirSync(dir, { recursive: true });
  const frames: string[] = [];
  const queue: Promise<unknown>[] = [];
  const started = Date.now();
  let readyAt = 0;
  const base = values.live ? new JevModel({ apiKey: process.env.TYPESAFE_API_KEY }) : new CassetteModel({ dir: "tests/cassettes/kanban" });
  const shoot = (browser: BrowserSession, wait: number) =>
    queue.push(
      (async () => {
        await sleep(wait);
        const file = join(work, `s${index}-${String(frames.length).padStart(3, "0")}.png`);
        frames.push(file);
        writeFileSync(file, await browser.screenshot({ everything: true }));
      })(),
    );
  const outcome = await runScenario({
    scenario,
    model: new Thinking(base, Number(values["think-ms"])),
    thinkMs: 1600,
    browser: { video: { dir }, dragStepMs: 45, settleMs: 500 },
    type: (text, browser) => typeSlowly(text, browser),
    onReady: async (browser, overlay) => {
      browser.hideFromModel(FX);
      await browser.addInitScript(FX_SCRIPT);
      await sleep(900);
      readyAt = Date.now();
      shoot(browser, 0);
      void overlay;
    },
    onFinish: async (browser) => {
      await Promise.all(queue);
      shoot(browser, 700); // the panel's last line is written once the run is over
      await Promise.all(queue);
      await sleep(1500); // a moment on the finished board, for the video
    },
    onEvent: (e, browser) => {
      if (e.type === "tool_call") void browser.evaluate((b) => (window as unknown as { __fxBox?: (b: unknown) => void }).__fxBox?.(b), boxes(e.args)).catch(() => {});
      if (e.type === "tool_result" || e.type === "input_requested") shoot(browser, e.type === "tool_result" ? 700 : 400);
    },
  });
  const bad = problems(outcome);
  if (bad.length) throw new Error(`the run of "${scenario.name}" is not right: ${bad.join("; ")}`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".webm"));
  if (files.length !== 1) throw new Error("expected one recorded video");
  return { video: join(dir, files[0]!), trimSeconds: (readyAt - started) / 1000 - 0.3, frames, scenario };
}

async function main() {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const segments: Segment[] = [];
  for (const [i, name] of ["move-assign", "ask-assignee"].entries()) segments.push(await record(SCENARIOS.find((s) => s.name === name)!, i));

  // The title cards, as pictures of a page.
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })).newPage();
  const cards: string[] = [];
  const intro: [string, string, string][] = [
    ["de-harness · an assistant over a Kanban board", "You type. It operates the board.", "“" + segments[0]!.scenario.instruction + "”"],
    ["de-harness · when it is not sure", "It asks you, and waits.", "“" + segments[1]!.scenario.instruction + "”"],
  ];
  for (const [i, c] of intro.entries()) {
    await page.setContent(titleCard(...c));
    const file = join(work, `card${i}.png`);
    await page.screenshot({ path: file });
    cards.push(file);
  }
  await browser.close();

  // MP4: card, run, card, run.
  const cardClip = (n: number) => ["-loop", "1", "-framerate", "25", "-t", "2.6", "-i", cards[n]!];
  const inputs = [...cardClip(0), "-ss", String(segments[0]!.trimSeconds), "-i", segments[0]!.video, ...cardClip(1), "-ss", String(segments[1]!.trimSeconds), "-i", segments[1]!.video];
  const norm = (i: number) => `[${i}:v]scale=1280:800,fps=25,scale=960:-2:flags=lanczos,fps=10,format=yuv420p,setsar=1[v${i}]`;
  const filter = `${[0, 1, 2, 3].map(norm).join(";")};[v0][v1][v2][v3]concat=n=4:v=1:a=0[v]`;
  const encode = (...args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-map", "[v]", ...args], { stdio: "inherit" });
  // Small on purpose: 960 px wide, 10 fps, no audio (a README video, a few hundred KB).
  encode("-c:v", "libx264", "-crf", "38", "-preset", "veryslow", "-tune", "animation", "-g", "250", "-movflags", "+faststart", join(out, "kanban-demo.mp4"));
  // The animated WebP the README shows (GitHub does not play video in a README): same frames, 800 px, 8 fps.
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(out, "kanban-demo.mp4"), "-vf", "fps=8,scale=800:-2:flags=lanczos", "-c:v", "libwebp_anim", "-lossless", "0", "-q:v", "30", "-compression_level", "6", "-loop", "0", join(out, "kanban-demo.webp")], { stdio: "inherit" });

  const steps = segments.map((s) => s.frames.length);
  rmSync(work, { recursive: true, force: true });
  console.log(`kanban demo: ${steps.join(" + ")} frames, written to ${out}`);
}

await main();
