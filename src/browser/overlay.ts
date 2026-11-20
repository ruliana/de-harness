/**
 * An assistant panel laid over the page the agent works on: the person types an instruction into it, the agent operates the page
 * behind it, and the panel shows what the agent does, asks the person when it needs an answer, and says what came out.
 *
 *   const overlay = await PageOverlay.install(browser);        // the panel appears on the page, and stays through navigations
 *   const task = await overlay.nextInstruction();              // waits for the person to send a message
 *   createAgent({ ..., input: overlay.input });                // ctx.input.ask(...) shows the question in the panel and holds the loop
 *   await overlay.say("Filled in the name", "progress");
 *
 * The panel is part of the page for the person and not for the agent:
 *   - it is hidden in every screenshot and zoom the model sees (`BrowserSession.hideFromModel`), so there is nothing to point at;
 *   - while the agent works (`working(true)`) it lets the pointer through to the page below it, so a click aimed at the page lands
 *     on the page even where the panel covers it, and its field is disabled, so typed text can never land in it.
 * It lives in a shadow root, so the page's styles do not touch it and it does not touch the page's text (`BrowserSession.text()`).
 * The transcript is kept here, in Node, and drawn again after each navigation.
 */
import type { AskInput, InputProvider } from "../input/provider.js";
import type { BrowserSession } from "./session.js";

/** Who or what a line of the panel is from: the person, the agent's progress, a question for the person, the outcome, or a failure. */
export type OverlayKind = "user" | "progress" | "question" | "result" | "error";
export type OverlayMessage = { kind: OverlayKind; text: string };

export type OverlayOptions = {
  /** The heading of the panel. Default "Assistant". */
  title?: string;
  /** What the field says while it waits for an instruction. Default "Tell me what to do on this page". */
  placeholder?: string;
};

/** The CSS selector of the panel's element, for tests that look at it and for `BrowserSession.screenshot({ everything: true })` users. */
export const OVERLAY_SELECTOR = "#de-overlay";
/** The panel's input field, as `BrowserSession.userTypes` finds it. */
export const OVERLAY_FIELD = "#de-overlay input";

type PanelState = { messages: OverlayMessage[]; mode: "idle" | "working" | "asking"; title: string; placeholder: string };

const STATE_BINDING = "__deOverlayState";
const SUBMIT_BINDING = "__deOverlaySubmit";

export class PageOverlay {
  private readonly log: OverlayMessage[] = [];
  private busy = false;
  private asking = false;
  /** Replies from the person that nobody waits for yet: the next `nextInstruction` takes the oldest. */
  private readonly unread: string[] = [];
  private waiter: ((text: string) => void) | null = null;
  private answer: ((text: string) => void) | null = null;

  private constructor(
    private readonly browser: BrowserSession,
    private readonly opts: Required<OverlayOptions>,
  ) {}

  /** Put the panel on the page that is open and on every page that opens after it. */
  static async install(browser: BrowserSession, options: OverlayOptions = {}): Promise<PageOverlay> {
    const overlay = new PageOverlay(browser, { title: options.title ?? "Assistant", placeholder: options.placeholder ?? "Tell me what to do on this page" });
    browser.hideFromModel(OVERLAY_SELECTOR);
    await browser.exposeFunction(STATE_BINDING, () => overlay.state());
    await browser.exposeFunction(SUBMIT_BINDING, (text: string) => overlay.received(String(text)));
    await browser.addInitScript(PANEL_SCRIPT);
    return overlay;
  }

  /** Everything said so far, in order, the person's lines included. */
  get messages(): readonly OverlayMessage[] {
    return this.log;
  }

  /** Add a line to the panel. */
  async say(text: string, kind: Exclude<OverlayKind, "user"> = "progress"): Promise<void> {
    this.log.push({ kind, text });
    await this.draw();
  }

  /** The agent is working (the field is disabled and the pointer goes through the panel) or not (the person may write). */
  async working(on: boolean): Promise<void> {
    this.busy = on;
    await this.draw();
  }

  /** Resolve with the next thing the person sends that is not the answer to a question. Rejects when `signal` aborts. */
  nextInstruction(signal?: AbortSignal): Promise<string> {
    const queued = this.unread.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const stop = () => {
        this.waiter = null;
        reject(new Error("overlay: stopped waiting for an instruction"));
      };
      if (signal?.aborted) return stop();
      signal?.addEventListener("abort", stop, { once: true });
      this.waiter = (text) => {
        signal?.removeEventListener("abort", stop);
        resolve(text);
      };
    });
  }

  /**
   * The person's side, for tests and demos: type `text` into the panel's field and press Enter, as someone using the page does.
   * Does nothing useful while the field is disabled (the agent is working).
   */
  async send(text: string): Promise<void> {
    await this.browser.userTypes(OVERLAY_FIELD, text, "Enter");
  }

  /** For `createAgent({ input })`: a question is shown in the panel, and the loop waits for the person's reply there. */
  readonly input: InputProvider = {
    ask: async (prompt: string, { signal }: AskInput): Promise<string> => {
      const wasBusy = this.busy;
      this.log.push({ kind: "question", text: prompt });
      this.asking = true;
      this.busy = false;
      await this.draw();
      try {
        return await new Promise<string>((resolve, reject) => {
          const stop = () => {
            this.answer = null;
            reject(new Error("overlay: stopped waiting for the reply"));
          };
          if (signal.aborted) return stop();
          signal.addEventListener("abort", stop, { once: true });
          this.answer = (text) => {
            signal.removeEventListener("abort", stop);
            resolve(text);
          };
        });
      } finally {
        this.answer = null;
        this.asking = false;
        this.busy = wasBusy;
        await this.draw();
      }
    },
  };

  private state(): PanelState {
    return { messages: [...this.log], mode: this.asking ? "asking" : this.busy ? "working" : "idle", title: this.opts.title, placeholder: this.opts.placeholder };
  }

  /** The person pressed send in the panel. */
  private received(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.log.push({ kind: "user", text: trimmed });
    const [answer, waiter] = [this.answer, this.waiter];
    if (answer) {
      this.answer = null;
      answer(trimmed);
    } else if (waiter) {
      this.waiter = null;
      waiter(trimmed);
    } else this.unread.push(trimmed);
    void this.draw();
  }

  /** Show the state on the page that is open. A page that is just navigating draws it itself when it has loaded. */
  private async draw(): Promise<void> {
    try {
      await this.browser.evaluate((s) => (window as unknown as { __deOverlay?: { render(s: unknown): void } }).__deOverlay?.render(s), this.state());
    } catch {
      /* the page is being replaced */
    }
  }
}

/** The panel, as code that runs in the page. Plain JavaScript in a string: it must not go through the compiler, which may wrap helpers around functions. */
const PANEL_SCRIPT = `(() => {
  if (window.__deOverlay) return;
  const css = \`
    :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; font: 14px/20px system-ui, sans-serif; }
    .panel { width: 340px; height: 420px; display: flex; flex-direction: column; background: #ffffff; color: #111827; border: 1px solid #9ca3af; border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.28); overflow: hidden; }
    :host([data-mode="working"]) { pointer-events: none; }
    header { background: #111827; color: #ffffff; padding: 10px 14px; font-weight: 700; display: flex; justify-content: space-between; align-items: center; }
    header span { font-weight: 400; font-size: 12px; color: #9ca3af; }
    .log { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 6px; background: #f3f4f6; }
    .log div { padding: 6px 10px; border-radius: 10px; max-width: 88%; white-space: pre-wrap; word-wrap: break-word; }
    .user { align-self: flex-end; background: #2563eb; color: #ffffff; }
    .progress { align-self: flex-start; background: #e5e7eb; color: #374151; font-size: 13px; }
    .question { align-self: flex-start; background: #fef3c7; color: #78350f; border: 1px solid #f59e0b; }
    .result { align-self: flex-start; background: #dcfce7; color: #14532d; border: 1px solid #16a34a; }
    .error { align-self: flex-start; background: #fee2e2; color: #7f1d1d; border: 1px solid #dc2626; }
    form { display: flex; gap: 6px; padding: 10px; border-top: 1px solid #d1d5db; background: #ffffff; }
    input { flex: 1; min-width: 0; font: inherit; padding: 8px 10px; border: 1px solid #9ca3af; border-radius: 8px; }
    input:disabled { background: #e5e7eb; }
    button { font: inherit; font-weight: 700; padding: 8px 14px; border: 0; border-radius: 8px; background: #2563eb; color: #ffffff; cursor: pointer; }
  \`;
  const host = document.createElement("div");
  host.id = "de-overlay";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = '<style>' + css + '</style><section class="panel"><header><b></b><span></span></header><div class="log"></div><form><input type="text" autocomplete="off"><button type="submit">Send</button></form></section>';
  const [title, status, log, input, form] = [root.querySelector("b"), root.querySelector("header span"), root.querySelector(".log"), root.querySelector("input"), root.querySelector("form")];
  const STATUS = { idle: "ready", working: "working on the page", asking: "waiting for your answer" };
  const render = (s) => {
    title.textContent = s.title;
    status.textContent = STATUS[s.mode];
    host.setAttribute("data-mode", s.mode);
    log.replaceChildren(...s.messages.map((m) => { const d = document.createElement("div"); d.className = m.kind; d.textContent = m.text; return d; }));
    log.scrollTop = log.scrollHeight;
    input.disabled = s.mode === "working";
    input.placeholder = s.mode === "working" ? "Working on it..." : s.mode === "asking" ? "Type your answer" : s.placeholder;
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || input.disabled) return;
    input.value = "";
    window.${SUBMIT_BINDING}(text);
  });
  window.__deOverlay = { render };
  const mount = () => { document.documentElement.append(host); refresh(); };
  const refresh = async () => { try { render(await window.${STATE_BINDING}()); } catch (e) { setTimeout(refresh, 100); } };
  if (document.documentElement) mount(); else document.addEventListener("readystatechange", mount, { once: true });
})();`;
