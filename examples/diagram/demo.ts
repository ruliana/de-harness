/**
 * Renders the assistant on the diagram studio as a short video (MP4, WebM) and an animated PNG, the media of the README.
 *
 *   npm run example:diagram:demo -- --out docs/media
 *
 * It runs three of the scenarios of the test (`login-flow`, `tidy`, `ask-failure`), by default replayed from the recordings in
 * tests/cassettes/diagram (no key, no network), in a Chromium that records the page. What a viewer sees besides the page: the person
 * types into the panel letter by letter, the model "thinks" a moment before each step (the replay would otherwise be instant), and a caption
 * names the tool the model chose and what it chose for each parameter. The captions are drawn into an element that the session hides from
 * the model (`hideFromModel`), so the pictures the model gets are the ones of the recordings.
 * The animated PNG is made from screenshots taken after each step. ffmpeg encodes. Needs Playwright's Chromium and ffmpeg.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { CassetteModel, JevModel, type DecisionModel, type DecisionRequest, type DecisionResponse } from "../../src/index.js";
import { OVERLAY_FIELD, type BrowserSession } from "../../src/browser/index.js";
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
/** Runs in the page, before its own scripts (plain JavaScript in a string: it must not go through the compiler). Draws a caption for each tool call. */
const FX_SCRIPT = `(() => {
  const css = \`
    #demo-fx { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
    #demo-fx .cap { position: absolute; left: 48px; bottom: 44px; max-width: 800px; background: #0f172a; color: #e2e8f0; border-left: 8px solid #f59e0b; padding: 10px 18px; font: 400 17px/24px "Test Sans", sans-serif; animation: fade 3.4s ease-in forwards; }
    #demo-fx .cap b { color: #fbbf24; font-weight: 700; }
    #demo-fx .cap i { color: #7ee0a8; font-style: normal; }
    @keyframes fade { 0%, 75% { opacity: 1; } 100% { opacity: 0; } }
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

/** The person types into the panel's field letter by letter. */
async function typeSlowly(text: string, browser: BrowserSession) {
  for (let i = 1; i <= text.length; i++) {
    await browser.userTypes(OVERLAY_FIELD, text.slice(0, i));
    await sleep(38);
  }
  await sleep(450);
}

const titleCard = (kicker: string, big: string, quote: string) => `<style>
*{box-sizing:border-box;margin:0}
body{width:1280px;height:800px;background:#0f1419;color:#e6edf3;font:20px/1.4 "DejaVu Sans",system-ui,sans-serif;display:flex;align-items:center;justify-content:center;text-align:center;flex-direction:column;gap:24px}
b{font-size:22px;color:#7ee0a8;font-weight:700}.big{font:700 50px/1.2 "DejaVu Sans",sans-serif;max-width:1000px}.q{max-width:900px;color:#c7d1dc;font-size:26px}.dim{color:#8b98a9;font-size:18px;max-width:820px}
</style><b>${kicker}</b><div class="big">${big}</div><div class="q">${quote}</div><div class="dim">The model never writes text. At each step it answers closed questions: which tool, which node, which arrow, which label.</div>`;

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
  for (const [i, name] of ["login-flow", "tidy", "ask-failure"].entries()) segments.push(await record(SCENARIOS.find((s) => s.name === name)!, i));

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

  // MP4 and WebM: card, run, card, run, card, run.
  const cardClip = (n: number) => ["-loop", "1", "-framerate", "25", "-t", "2.6", "-i", cards[n]!];
  const inputs = segments.flatMap((s, n) => [...cardClip(n), "-ss", String(s.trimSeconds), "-i", s.video]);
  const count = segments.length * 2;
  const norm = (i: number) => `[${i}:v]scale=1280:800,fps=25,format=yuv420p,setsar=1[v${i}]`;
  const ids = [...Array(count).keys()];
  const filter = `${ids.map(norm).join(";")};${ids.map((i) => `[v${i}]`).join("")}concat=n=${count}:v=1:a=0[v]`;
  const encode = (...args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-map", "[v]", ...args], { stdio: "inherit" });
  encode("-c:v", "libx264", "-crf", "27", "-preset", "slow", "-movflags", "+faststart", join(out, "diagram-demo.mp4"));
  encode("-c:v", "libvpx-vp9", "-crf", "40", "-b:v", "0", "-cpu-used", "4", join(out, "diagram-demo.webm"));

  // The animated PNG: the cards and a screenshot after each step.
  const stills = (s: Segment) => s.frames.map((file, i) => ({ file, seconds: i === s.frames.length - 1 ? 3 : 1.1 }));
  const seq: { file: string; seconds: number }[] = segments.flatMap((s, n) => [{ file: cards[n]!, seconds: 2.4 }, ...stills(s)]);
  const list = seq.flatMap((f) => [`file '${f.file}'`, `duration ${f.seconds}`]);
  list.push(list[list.length - 2]!);
  writeFileSync(join(work, "frames.txt"), list.join("\n") + "\n");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(work, "frames.txt"), "-vf", "scale=900:-1:flags=lanczos", "-fps_mode", "vfr", "-plays", "0", "-f", "apng", join(out, "diagram-demo.png")], { stdio: "inherit" });
  const steps = segments.map((s) => s.frames.length);
  rmSync(work, { recursive: true, force: true });
  console.log(`diagram demo: ${steps.join(" + ")} frames, written to ${out}`);
}

await main();
