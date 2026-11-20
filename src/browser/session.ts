/**
 * A headless browser the agent drives, and the screenshot that is its state.
 *
 * `BrowserSession` wraps one Chromium page (Playwright). It owns everything that is mechanics: launching, the viewport,
 * turning a Box (fractions of the screenshot) into a click at viewport pixels, scrolling, typing, waiting for the page to
 * settle, and screenshots as image values for the state. Decisions stay out of it: which address to open, where to click
 * and what to type are chosen by the model from candidates in `browserTools` (./tools.ts).
 *
 * Code, not the model, can read the page: `text()` and `visibleText()` serve verification in tests and use cases.
 *
 * Playwright is loaded lazily and is an optional peer dependency. Install it and a browser to use this module:
 *   npm i -D playwright && npx playwright install chromium
 */
import type { Browser, BrowserContext, LaunchOptions, Page } from "playwright";
import { IMAGE_LIMITS, image, type ImageValue } from "../state/images.js";
import type { Box } from "../model/types.js";
import type { Json } from "../state/state.js";

export type BrowserOptions = {
  /** Size of the page in CSS pixels, which is also the size of every screenshot. Each side 280-1568 (Jev's image limits). Default 1280x800. */
  viewport?: { width: number; height: number };
  /** Passed to `chromium.launch`. In a sandbox with an egress proxy: `{ proxy: { server: process.env.HTTPS_PROXY } }`. */
  launch?: LaunchOptions;
  userAgent?: string;
  /**
   * Hosts the page may talk to (`example.com` also allows its subdomains; `127.0.0.1` and `localhost` are different hosts).
   * Every request to any other host is aborted, so a click cannot walk the agent out of the site. Default: no restriction.
   */
  allowedHosts?: string[];
  /** Wait after an action before the screenshot, for animations and scripts to run. Default 250. */
  settleMs?: number;
  /** Upper bound for waiting on the network to go quiet after an action. Default 1500. */
  networkIdleMs?: number;
  /** Upper bound for loading a page. Default 30000. */
  navigationTimeoutMs?: number;
};

/** What the model learns about the page besides the picture: where it is and how far it is scrolled. */
export type PageInfo = {
  url: string;
  title: string;
  scroll: { /** pixels scrolled from the top */ position: number; /** the most that can be scrolled */ max: number };
};

export type ScrollDirection = "down" | "up" | "top" | "bottom";

/** What `click` found under the pointer, for a tool summary and for verification in code. */
export type Clicked = { x: number; y: number; element: string; /** Set when the click tried to open an address on a host that is not allowed: the page stayed where it was. */ blocked?: string };

// Flags that make rendering the same on every Linux machine with the same Chromium build, so screenshots (and the cassettes keyed on them) are stable.
const STABLE_RENDERING = ["--font-render-hinting=none", "--disable-lcd-text", "--disable-gpu", "--force-color-profile=srgb", "--hide-scrollbars"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BrowserSession {
  readonly viewport: { width: number; height: number };
  private page: Page;
  /** The tabs the agent left behind by following a link that opened a new one, oldest first: where `back` returns when the new tab has no history. */
  private readonly openers: Page[] = [];
  private blockedUrl: string | null = null;
  private readonly allowed: string[] | undefined;
  private readonly opts: Required<Pick<BrowserOptions, "settleMs" | "networkIdleMs" | "navigationTimeoutMs">>;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    page: Page,
    viewport: { width: number; height: number },
    opts: BrowserOptions,
  ) {
    this.page = page;
    this.viewport = viewport;
    this.allowed = opts.allowedHosts?.map((h) => h.toLowerCase());
    this.opts = { settleMs: opts.settleMs ?? 250, networkIdleMs: opts.networkIdleMs ?? 1500, navigationTimeoutMs: opts.navigationTimeoutMs ?? 30_000 };
    const watch = (p: Page) => {
      p.on("dialog", (d) => void d.dismiss().catch(() => {})); // an alert must never freeze the agent
      p.setDefaultTimeout(this.opts.navigationTimeoutMs);
      // A tab that closes itself (`window.close()`) must not leave the agent on a dead page: it returns to the tab it came from.
      p.on("close", () => {
        const at = this.openers.indexOf(p);
        if (at >= 0) this.openers.splice(at, 1);
        if (this.page === p) this.page = this.openers.pop() ?? this.page;
      });
    };
    watch(page);
    // A click that opens a new tab moves the agent to that tab: the model only ever sees one page.
    context.on("page", (p) => {
      watch(p);
      this.openers.push(this.page);
      this.page = p;
    });
  }

  static async launch(opts: BrowserOptions = {}): Promise<BrowserSession> {
    const viewport = opts.viewport ?? { width: 1280, height: 800 };
    const { min, max } = IMAGE_LIMITS;
    for (const side of [viewport.width, viewport.height]) {
      if (!Number.isInteger(side) || side < min || side > max) throw new Error(`browser: viewport ${viewport.width}x${viewport.height} px is outside the ${min}-${max} px per side that Jev accepts`);
    }
    let playwright: typeof import("playwright");
    try {
      playwright = await import("playwright");
    } catch {
      throw new Error("browser: Playwright is not installed. Run `npm i -D playwright && npx playwright install chromium`.");
    }
    const launch = opts.launch ?? {};
    const browser = await playwright.chromium.launch({ headless: true, ...launch, args: [...STABLE_RENDERING, ...(launch.args ?? [])] });
    try {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, userAgent: opts.userAgent, reducedMotion: "reduce", serviceWorkers: "block" });
      const session = new BrowserSession(browser, context, await context.newPage(), viewport, opts);
      if (session.allowed) {
        await context.route("**/*", (route) => {
          const url = route.request().url();
          if (session.isAllowed(url)) return route.continue();
          if (route.request().isNavigationRequest()) session.blockedUrl = url;
          return route.abort("blockedbyclient");
        });
      }
      return session;
    } catch (e) {
      await browser.close();
      throw e;
    }
  }

  /** Load an address and wait for the page to settle. Throws when the page cannot be loaded, or when its host is not allowed (the page stays where it was). */
  async goto(url: string): Promise<void> {
    if (!this.isAllowed(url)) throw new Error(`browser: ${new URL(url).hostname} is not one of the allowed hosts (${this.allowed!.join(", ")})`);
    await this.page.goto(url, { waitUntil: "load", timeout: this.opts.navigationTimeoutMs });
    await this.settle();
  }

  /**
   * Go to the previous page, like the back button, and say whether there was one. It never lands on a blank page: the
   * `about:blank` the browser starts from (and an error page, which is shown for a blocked address) is not a page to go back to.
   *   - on a tab with earlier pages in its history (also pages of in-page navigation, which Playwright's `goBack` reports as `null`): go back there;
   *   - on a tab that a link opened and that has no earlier page: close it and return to the tab the link was in;
   *   - otherwise: do nothing and return false, the page stays.
   */
  async back(): Promise<boolean> {
    const steps = await this.stepsBack();
    for (let i = 0; i < steps; i++) await this.page.goBack({ waitUntil: "load", timeout: this.opts.navigationTimeoutMs });
    if (steps > 0) {
      await this.settle();
      return true;
    }
    const opener = this.openers.filter((p) => !p.isClosed()).pop();
    if (!opener) return false;
    const leaving = this.page;
    this.openers.splice(this.openers.lastIndexOf(opener), 1);
    this.page = opener;
    await leaving.close().catch(() => {});
    await opener.bringToFront();
    await this.settle();
    return true;
  }

  /** How many history entries lie between the page and the nearest earlier real page: 0 when there is none. */
  private async stepsBack(): Promise<number> {
    const cdp = await this.context.newCDPSession(this.page);
    try {
      const { currentIndex, entries } = await cdp.send("Page.getNavigationHistory");
      for (let i = currentIndex - 1; i >= 0; i--) if (!/^(about:blank|chrome-error:)/.test(entries[i]!.url)) return currentIndex - i;
      return 0;
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  /** The viewport pixel at the centre of a Box (fractions of the screenshot), clamped to the viewport. */
  pointOf(box: Box): { x: number; y: number } {
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return {
      x: Math.min(this.viewport.width - 1, Math.round(clamp((box.left + box.right) / 2) * this.viewport.width)),
      y: Math.min(this.viewport.height - 1, Math.round(clamp((box.top + box.bottom) / 2) * this.viewport.height)),
    };
  }

  /** Click the centre of a Box and wait for the page to settle. Reports what was under the pointer. */
  async clickBox(box: Box): Promise<Clicked> {
    const { x, y } = this.pointOf(box);
    const element = await this.describeAt(x, y);
    this.blockedUrl = null;
    await this.page.mouse.click(x, y);
    await this.settle();
    const blocked = this.blockedUrl ?? undefined;
    if (blocked && this.page.url().startsWith("chrome-error:")) await this.back(); // the browser shows an error page for a blocked address: leave it
    return { x, y, element, ...(blocked ? { blocked } : {}) };
  }

  /** Move the pointer onto the centre of a Box, for menus that open when hovered, and wait for the page to settle. Reports what is under the pointer. */
  async hoverBox(box: Box): Promise<Clicked> {
    const { x, y } = this.pointOf(box);
    const element = await this.describeAt(x, y);
    await this.page.mouse.move(x, y);
    await this.settle();
    return { x, y, element };
  }

  /**
   * The text the viewport shows inside a Box (fractions of the screenshot), in reading order: every text node whose rectangle is
   * at least half inside the box. Jev's edges are approximate, so a node that the box mostly covers counts. For use-case code that
   * lets the model point at something (a price, a total) and reads the characters itself, because the model cannot write them.
   * `grow` widens the box on every side first (as a fraction of the viewport), since a Box around a line of text is often a few pixels off.
   */
  async textIn(box: Box, grow = 0): Promise<string> {
    return await this.page.evaluate(([b, g]) => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const left = (b.left - g) * w, right = (b.right + g) * w, top = (b.top - g) * h, bottom = (b.bottom + g) * h;
      const parts: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent?.replace(/\s+/g, " ").trim();
        const parent = n.parentElement;
        if (!text || !parent || !parent.checkVisibility()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const iw = Math.min(r.right, right) - Math.max(r.left, left);
        const ih = Math.min(r.bottom, bottom) - Math.max(r.top, top);
        if (iw > 0 && ih > 0 && (iw * ih) / (r.width * r.height) >= 0.5) parts.push(text);
      }
      return parts.join(" ");
    }, [box, grow] as const);
  }

  /** Scroll by 80% of a viewport (or to an end). Returns the new scroll position. */
  async scroll(direction: ScrollDirection): Promise<number> {
    const step = Math.round(this.viewport.height * 0.8);
    await this.page.evaluate(
      ([d, by]) => {
        const el = document.scrollingElement ?? document.documentElement;
        const top = d === "top" ? 0 : d === "bottom" ? el.scrollHeight : el.scrollTop + (d === "down" ? 1 : -1) * Number(by);
        window.scrollTo({ top, left: 0, behavior: "instant" });
      },
      [direction, step] as const,
    );
    await this.settle();
    return (await this.info()).scroll.position;
  }

  /** Type into whatever has the focus (click a field first). Returns the element that received the text, or null when nothing is focused. */
  async type(text: string): Promise<string | null> {
    const focused = await this.focusedElement();
    if (focused === null) return null;
    await this.page.keyboard.type(text);
    await this.settle();
    return focused;
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
    await this.settle();
  }

  /** The viewport as a PNG, the size of the viewport. */
  async screenshot(): Promise<Uint8Array> {
    return await this.page.screenshot({ type: "png", scale: "css", animations: "disabled", caret: "initial" });
  }

  async info(): Promise<PageInfo> {
    const scroll = await this.page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return { position: Math.round(el.scrollTop), max: Math.max(0, Math.round(el.scrollHeight - el.clientHeight)) };
    });
    return { url: this.page.url(), title: await this.page.title(), scroll };
  }

  /** The state slots a browser step produces: the screenshot and where the page is. */
  async snapshot(slot = "screen"): Promise<Record<string, Json>> {
    const [png, page] = await Promise.all([this.screenshot(), this.info()]);
    return { [slot]: image(png) as ImageValue, page };
  }

  /** All the text of the page as a person could read it by scrolling (`innerText`). For verification in code, never for the model. */
  async text(): Promise<string> {
    return await this.page.evaluate(() => document.body?.innerText ?? "");
  }

  /** Only the text that is inside the viewport right now, one line per text node: what the screenshot shows, as characters. */
  async visibleText(): Promise<string> {
    return await this.page.evaluate(() => {
      const lines: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent?.replace(/\s+/g, " ").trim();
        const parent = n.parentElement;
        if (!text || !parent || !parent.checkVisibility()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth) lines.push(text);
      }
      return lines.join("\n");
    });
  }

  /** Run code in the page, for verification (`await browser.evaluate((sel) => document.querySelector(sel)?.textContent, "#total")`). The argument must be JSON. */
  async evaluate<A, T>(fn: (arg: A) => T, arg: A): Promise<T> {
    return (await this.page.evaluate(fn as never, arg as never)) as T;
  }

  /** The rectangle of the first element matching a CSS selector, as fractions of the viewport: the Box a perfect answer would be. */
  async boxOf(selector: string): Promise<Box | null> {
    const r = await this.page.evaluate((sel) => {
      const rect = document.querySelector(sel)?.getBoundingClientRect();
      return rect ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } : null;
    }, selector);
    if (!r) return null;
    const { width, height } = this.viewport;
    return { top: r.top / height, bottom: r.bottom / height, left: r.left / width, right: r.right / width };
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  private isAllowed(url: string): boolean {
    const u = new URL(url);
    return !this.allowed || !/^https?:$/.test(u.protocol) || this.allowed.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  }

  private async settle(): Promise<void> {
    await sleep(this.opts.settleMs);
    await this.page.waitForLoadState("load", { timeout: this.opts.navigationTimeoutMs }).catch(() => {});
    await this.page.waitForLoadState("networkidle", { timeout: this.opts.networkIdleMs }).catch(() => {});
  }

  private async describeAt(x: number, y: number): Promise<string> {
    return await this.page.evaluate(
      ([px, py]) => {
        const el = document.elementFromPoint(Number(px), Number(py));
        if (!el) return "nothing";
        const label = (el.getAttribute("aria-label") ?? (el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
        return label ? `<${el.tagName.toLowerCase()}> "${label}"` : `<${el.tagName.toLowerCase()}>`;
      },
      [x, y] as const,
    );
  }

  private async focusedElement(): Promise<string | null> {
    return await this.page.evaluate(() => {
      const el = document.activeElement;
      return !el || el === document.body || el === document.documentElement ? null : el.tagName.toLowerCase();
    });
  }
}
