/**
 * Renders the assistant on the diagram studio as a short video (a small MP4 and an animated WebP), the media of the README.
 *
 *   npm run example:diagram:demo -- --out docs/media
 *
 * It runs three of the scenarios of the test (`login-sequence`, `tidy`, `ask-wrong-password`), by default replayed from the recordings in
 * tests/cassettes/diagram (no key, no network), in a Chromium that records the page. What a viewer sees besides the page: the person
 * types into the panel letter by letter, the model "thinks" a moment before each step (the replay would otherwise be instant), and a caption
 * names the tool the model chose and what it chose for each parameter. The captions are drawn into an element that the session hides from
 * the model (`hideFromModel`), so the pictures the model gets are the ones of the recordings.
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

const { values } = parseArgs({ options: { out: { type: "string", default: "docs/media" }, live: { type: "boolean", default: false }, "think-ms": { type: "string", default: "350" } } });
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
/** Runs in the page, before its own scripts (plain JavaScript in a string: it must not go through the compiler). Draws a caption for each tool call. */
const FX_SCRIPT = `(() => {
  const css = \`
    #demo-fx { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
    #demo-fx .cap { position: absolute; left: 52px; bottom: 44px; max-width: 800px; background: rgba(15, 18, 38, .94); color: #cbd5f5; border-radius: 14px; padding: 11px 18px; font: 500 15px/22px "Inter", sans-serif; box-shadow: 0 14px 34px rgba(15, 18, 38, .35); animation: cap 3.4s ease forwards; }
    #demo-fx .cap b { color: #c4b5fd; font-weight: 700; }
    #demo-fx .cap i { color: #a7f3d0; font-style: normal; font-family: "JetBrains Mono", monospace; font-size: 14px; }
    @keyframes cap { 0% { opacity: 0; transform: translateY(8px); } 8% { opacity: 1; transform: none; } 75% { opacity: 1; } 100% { opacity: 0; } }
  \`;
  const mount = () => {
    if (document.getElementById('demo-fx')) return;
    const fx = document.createElement('div'); fx.id = 'demo-fx';
    fx.innerHTML = '<style>' + css + '</style>';
    document.documentElement.append(fx);
  };
  window.__fxCaption = (tool, args) => {
    mount(); const fx = document.getElementById('demo-fx');
    fx.querySelectorAll('.cap').forEach((c) => c.remove());
    const d = document.createElement('div'); d.className = 'cap';
    const b = document.createElement('b'); b.textContent = tool; d.append(b);
    for (const [k, v] of Object.entries(args).filter(([, v]) => v !== undefined && v !== null)) { d.append(document.createTextNode('  ' + k + ' = ')); const i = document.createElement('i'); i.textContent = String(v); d.append(i); }
    fx.append(d); setTimeout(() => d.remove(), 3500);
  };
  if (document.documentElement) mount(); else addEventListener('DOMContentLoaded', mount);
})();`;

/** The person types into the panel's field, key by key, and presses Enter. */
async function typeSlowly(text: string, browser: BrowserSession) {
  await browser.userTypesSlowly(OVERLAY_FIELD, text, { delayMs: 38 });
  await sleep(450);
  await browser.userTypesSlowly(OVERLAY_FIELD, "", { key: "Enter" });
}

const face = (weight: number, key: string) => `@font-face{font-family:"Inter";font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(FONTS[key]!).toString("base64")}) format("woff2")}`;
const titleCard = (kicker: string, big: string, quote: string) => `<style>
${face(400, "inter-400.woff2")}${face(600, "inter-600.woff2")}${face(700, "inter-700.woff2")}
*{box-sizing:border-box;margin:0}
body{width:1280px;height:800px;background:radial-gradient(900px 600px at 15% 0%,#312e81 0%,transparent 70%),radial-gradient(800px 560px at 100% 100%,#581c87 0%,transparent 65%),#0f1226;color:#e0e7ff;font:400 20px/1.45 "Inter",sans-serif;display:flex;align-items:center;justify-content:center;text-align:center;flex-direction:column;gap:26px}
b{font:600 15px/1 "Inter";letter-spacing:.14em;text-transform:uppercase;color:#a5b4fc}.big{font:700 58px/1.15 "Inter";letter-spacing:-.03em;max-width:1000px;color:#fff}.q{max-width:900px;color:#c7d2fe;font-size:26px}.dim{color:#8187c4;font-size:17px;max-width:820px}
</style><b>${kicker}</b><div class="big">${big}</div><div class="q" style="font-size:${quote.length > 200 ? 20 : 26}px">${quote}</div><div class="dim">The model never writes text. At each step it answers closed questions: which tool, which node, which arrow, which label.</div>`;

type Segment = { video: string; trimSeconds: number; frames: string[]; scenario: Scenario };

async function record(scenario: Scenario, index: number): Promise<Segment> {
  const dir = join(work, `video-${index}`);
  mkdirSync(dir, { recursive: true });
  const frames: string[] = [];
  const queue: Promise<unknown>[] = [];
  const started = Date.now();
  let readyAt = 0;
  const base = values.live ? new JevModel({ apiKey: process.env.TYPESAFE_API_KEY }) : new CassetteModel({ dir: "tests/cassettes/diagram" });
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
      await sleep(1500); // a moment on the finished diagram, for the video
    },
    onEvent: (e, browser) => {
      if (e.type === "tool_call") void browser.evaluate(([tool, args]) => (window as unknown as { __fxCaption?: (t: string, a: unknown) => void }).__fxCaption?.(tool as string, args), [e.tool, e.args] as const).catch(() => {});
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
  for (const [i, name] of ["login-sequence", "tidy", "ask-wrong-password"].entries()) segments.push(await record(SCENARIOS.find((s) => s.name === name)!, i));

  // The title cards, as pictures of a page.
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })).newPage();
  const cards: string[] = [];
  const intro: [string, string][] = [
    ["de-harness · an assistant beside a diagram", "You type. It draws."],
    ["de-harness · an assistant beside a diagram", "It edits what is there."],
    ["de-harness · when it is not sure", "It asks you, and waits."],
  ];
  for (const [i, c] of intro.entries()) {
    await page.setContent(titleCard(c[0], c[1], "\u201c" + segments[i]!.scenario.instruction + "\u201d"));
    const file = join(work, `card${i}.png`);
    await page.screenshot({ path: file });
    cards.push(file);
  }
  await browser.close();

  // MP4: card, run, card, run, card, run.
  const cardClip = (n: number) => ["-loop", "1", "-framerate", "25", "-t", "2.6", "-i", cards[n]!];
  const inputs = segments.flatMap((s, n) => [...cardClip(n), "-ss", String(s.trimSeconds), "-i", s.video]);
  const count = segments.length * 2;
  const norm = (i: number) => `[${i}:v]scale=1280:800,fps=25,format=yuv420p,setsar=1[v${i}]`;
  const ids = [...Array(count).keys()];
  const filter = `${ids.map(norm).join(";")};${ids.map((i) => `[v${i}]`).join("")}concat=n=${count}:v=1:a=0[v]`;
  const encode = (...args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-map", "[v]", ...args], { stdio: "inherit" });
  // A near-lossless 1280 px master, then two small files made from it (never from each other, so the animation is not compressed twice).
  const master = join(work, "master.mp4");
  encode("-c:v", "libx264", "-crf", "16", "-preset", "fast", master);
  const ffmpeg = (...args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", master, ...args], { stdio: "inherit" });
  // The MP4: 960 px, 10 fps, no audio (a few hundred KB).
  ffmpeg("-vf", "scale=960:-2:flags=lanczos,fps=10", "-c:v", "libx264", "-crf", "38", "-preset", "veryslow", "-tune", "animation", "-g", "250", "-movflags", "+faststart", join(out, "diagram-demo.mp4"));
  // The animated WebP the README shows (GitHub does not play video in a README): 800 px wide (the width GitHub shows it at), 6 fps.
  ffmpeg("-vf", "fps=6,scale=800:-2:flags=lanczos", "-c:v", "libwebp_anim", "-lossless", "0", "-q:v", "75", "-compression_level", "6", "-loop", "0", join(out, "diagram-demo.webp"));

  const steps = segments.map((s) => s.frames.length);
  rmSync(work, { recursive: true, force: true });
  console.log(`diagram demo: ${steps.join(" + ")} frames, written to ${out}`);
}

await main();
