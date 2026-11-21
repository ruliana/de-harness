/**
 * The browser bundle in a real page: `dist/de-harness.iife.min.js` built from `src/core.ts`, loaded with a <script> tag in
 * headless Chromium, runs an agent whose JevModel talks only to the page's own server; the server's proxy adds the key.
 * Jev answers through a cassette on the server side (tests/cassettes/web-page).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cassetteFetch } from "../../../src/index.js";
import { BROWSER_FILES, buildBrowser } from "../../../scripts/build.js";
import { startWebPageSite, type WebPageSite } from "../../../examples/web-page/site.js";

type Triage = { status: string; team?: string; error?: string };
const API_KEY = process.env.TYPESAFE_API_KEY ?? "dummy";

let bundleDir: string;
let browser: Browser;
beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), "de-harness-bundle-"));
  await buildBrowser(bundleDir);
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

async function open(site: WebPageSite): Promise<{ page: Page; requests: string[] }> {
  const page = await browser.newPage();
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(site.url);
  return { page, requests };
}
const triage = (page: Page, message: string) => page.evaluate((m) => (window as unknown as { triage(m: string): Promise<Triage> }).triage(m), message);

describe("the harness in a web page", () => {
  it("builds the browser files from the core with no Node module in them", () => {
    for (const { file } of BROWSER_FILES) {
      const code = readFileSync(join(bundleDir, file), "utf8");
      expect(code.length).toBeGreaterThan(1000);
      expect(code).not.toMatch(/from\s*["']node:|require\(["']node:/);
    }
  });

  it("routes a billing message and a technical message to their teams, through the page's own server", async () => {
    const forwarded: Record<string, string>[] = [];
    const site = await startWebPageSite({ apiKey: API_KEY, bundleDir, fetch: cassetteFetch({ dir: "tests/cassettes/web-page" }), onForward: (h) => forwarded.push(h) });
    try {
      const { page, requests } = await open(site);
      const billing = await triage(page, "I was charged twice for my subscription this month. Please refund the extra charge.");
      const technical = await triage(page, "The app logs me out every time I open the settings page, even right after I sign in.");
      expect(billing).toMatchObject({ status: "ended", team: "billing" });
      expect(technical).toMatchObject({ status: "ended", team: "technical" });
      // the page reached nothing but its own origin; the key was added on the server
      const origin = new URL(site.url).origin;
      expect(requests.length).toBeGreaterThan(2);
      expect(requests.every((u) => u.startsWith(origin))).toBe(true);
      expect(forwarded).toHaveLength(2);
      expect(forwarded.every((h) => h.authorization === `Bearer ${API_KEY}`)).toBe(true);
    } finally {
      await site.close();
    }
  });

  it("ends the run with an error, not an answer, when the proxy cannot reach Jev", async () => {
    const down: typeof fetch = async () => {
      throw new Error("upstream down");
    };
    const site = await startWebPageSite({ apiKey: API_KEY, bundleDir, fetch: down });
    try {
      const { page } = await open(site);
      const result = await triage(page, "I was charged twice for my subscription this month.");
      expect(result.status).toBe("error");
      expect(result.team).toBeUndefined();
    } finally {
      await site.close();
    }
  });
});
