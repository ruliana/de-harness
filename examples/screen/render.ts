/**
 * The screens of the example, drawn by code. `npm run example:screen:fixtures` rewrites examples/screen/fixtures/*.png;
 * the PNGs are committed, so tests and cassettes always see the same bytes.
 *
 * The form has a "Submit" button at a known rectangle (`SUBMIT_BUTTON`, in pixels). There is deliberately no "Cancel".
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Canvas, type Rect, type Rgb } from "./canvas.js";

export const SIZE = { width: 640, height: 440 } as const;
export const SUBMIT_BUTTON: Rect = { left: 60, top: 320, right: 260, bottom: 376 };

const INK: Rgb = [30, 41, 59];
const FIELD: Rgb = [148, 163, 184];
const BLUE: Rgb = [37, 99, 235];
const GREEN: Rgb = [22, 163, 74];

export function formScreen(): Canvas {
  const c = new Canvas(SIZE.width, SIZE.height, [241, 245, 249]);
  c.text("SIGN UP", 60, 40, 5, INK);
  c.text("NAME", 60, 112, 3, INK);
  c.fill({ left: 60, top: 140, right: 580, bottom: 184 }, [255, 255, 255]);
  c.outline({ left: 60, top: 140, right: 580, bottom: 184 }, FIELD, 2);
  c.text("EMAIL", 60, 204, 3, INK);
  c.fill({ left: 60, top: 232, right: 580, bottom: 276 }, [255, 255, 255]);
  c.outline({ left: 60, top: 232, right: 580, bottom: 276 }, FIELD, 2);
  c.fill(SUBMIT_BUTTON, BLUE);
  c.centred("SUBMIT", SUBMIT_BUTTON, 4, [255, 255, 255]);
  return c;
}

export function doneScreen(): Canvas {
  const c = new Canvas(SIZE.width, SIZE.height, [241, 245, 249]);
  c.fill({ left: 60, top: 150, right: 580, bottom: 290 }, GREEN);
  c.centred("THANK YOU", { left: 60, top: 150, right: 580, bottom: 290 }, 6, [255, 255, 255]);
  return c;
}

/** A copy of `screen` with a red frame around `box` (fractions of the width and height), as in the PR proof image. */
export function withBox(screen: Canvas, box: { top: number; bottom: number; left: number; right: number }): Canvas {
  const c = screen.clone();
  c.outline(
    { left: Math.round(box.left * c.width), top: Math.round(box.top * c.height), right: Math.round(box.right * c.width), bottom: Math.round(box.bottom * c.height) },
    [220, 38, 38],
    3,
  );
  return c;
}

export const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(fixturesDir, { recursive: true });
  writeFileSync(join(fixturesDir, "form.png"), formScreen().png());
  writeFileSync(join(fixturesDir, "done.png"), doneScreen().png());
  console.log(`wrote ${fixturesDir}/form.png and done.png`);
}
