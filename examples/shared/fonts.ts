/**
 * The fonts of the example pages: Inter for text and JetBrains Mono for code, from `node_modules` (`@fontsource`), served from loopback by name
 * (`/fonts/inter-500.woff2`), so there is no network and screenshots look the same wherever they are taken.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const fontsource = (name: string) => join(dirname(createRequire(import.meta.url).resolve(`@fontsource/${name}/package.json`)), "files");

/** The name a page asks for, and the file that answers it. */
export const FONTS: Record<string, string> = {
  "inter-400.woff2": join(fontsource("inter"), "inter-latin-400-normal.woff2"),
  "inter-500.woff2": join(fontsource("inter"), "inter-latin-500-normal.woff2"),
  "inter-600.woff2": join(fontsource("inter"), "inter-latin-600-normal.woff2"),
  "inter-700.woff2": join(fontsource("inter"), "inter-latin-700-normal.woff2"),
  "mono-400.woff2": join(fontsource("jetbrains-mono"), "jetbrains-mono-latin-400-normal.woff2"),
  "mono-500.woff2": join(fontsource("jetbrains-mono"), "jetbrains-mono-latin-500-normal.woff2"),
};
