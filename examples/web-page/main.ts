/**
 * npm run example:web-page -- "My invoice is wrong"      # routes one message in a headless page and prints the team
 * npm run example:web-page -- --serve                    # serves the page on http://127.0.0.1:8787/ until Ctrl-C
 *
 * Builds the browser bundle first, so `npm run build` is not needed.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { buildBrowser } from "../../scripts/build.js";
import { startWebPageSite } from "./site.js";

const bundleDir = mkdtempSync(join(tmpdir(), "de-harness-bundle-"));
await buildBrowser(bundleDir);
const apiKey = process.env.TYPESAFE_API_KEY ?? "dummy"; // the cloud proxy supplies the real key in cloud sessions
const arg = process.argv.slice(2).join(" ");

if (arg === "--serve") {
  const site = await startWebPageSite({ apiKey, bundleDir, port: 8787 });
  console.log(`open ${site.url}`);
} else {
  const site = await startWebPageSite({ apiKey, bundleDir });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(site.url);
  const message = arg || "The app logs me out every time I open the settings page.";
  const result = await page.evaluate((m) => (window as unknown as { triage(m: string): Promise<unknown> }).triage(m), message);
  console.log(message, "\n", result);
  await browser.close();
  await site.close();
}
