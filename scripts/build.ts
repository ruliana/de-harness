/**
 * `npm run build`: what gets published.
 *
 *   dist/index.js, dist/core.js, dist/browser/...  + .d.ts   compiled sources, for Node and for bundlers
 *   dist/de-harness.browser.js                               the core as one ES module, for a <script type="module">
 *   dist/de-harness.browser.min.js                           the same, minified
 *   dist/de-harness.iife.min.js                              the core for a classic <script>, as the global `DeHarness`
 *
 * The browser files are built from `src/core.ts`, which imports no Node module; the build fails if one gets in.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Format } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export const BROWSER_FILES = [
  { file: "de-harness.browser.js", format: "esm", minify: false },
  { file: "de-harness.browser.min.js", format: "esm", minify: true },
  { file: "de-harness.iife.min.js", format: "iife", minify: true },
] as const satisfies readonly { file: string; format: Format; minify: boolean }[];

/** Bundles `src/core.ts` into `outdir` as the browser files. */
export async function buildBrowser(outdir: string): Promise<string[]> {
  const out: string[] = [];
  for (const { file, format, minify } of BROWSER_FILES) {
    const outfile = join(outdir, file);
    await build({
      entryPoints: [join(ROOT, "src/core.ts")],
      bundle: true,
      platform: "browser",
      format,
      globalName: "DeHarness",
      minify,
      target: "es2022",
      outfile,
      // the one Node import left is the lazy `import("node:fs")` of a trace file, which a page never reaches
      external: ["node:*"],
      legalComments: "none",
      logLevel: "error",
    });
    const code = readFileSync(outfile, "utf8");
    if (/(from\s*["']node:|require\(["']node:)/.test(code)) throw new Error(`${file}: a static Node import got into the browser bundle`);
    out.push(outfile);
  }
  return out;
}

async function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
  const { version } = await import("../src/version.js");
  if (version !== pkg.version) throw new Error(`src/version.ts says ${version} but package.json says ${pkg.version}; bump both`);
  const dist = join(ROOT, "dist");
  rmSync(dist, { recursive: true, force: true });
  execFileSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", join(ROOT, "tsconfig.build.json")], { stdio: "inherit" });
  for (const f of await buildBrowser(dist)) console.log(`${f.slice(ROOT.length)}  ${readFileSync(f).length} bytes`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
