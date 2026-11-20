/**
 * Tools that drive a `BrowserSession`. The page is seen only as a screenshot in `state.screen`; the model points at it with a
 * Box, and the rest of its choices come from candidates that code supplies (Jev cannot write text).
 *
 *   navigate(url)       url  = one of the addresses in `urls`                  (only when `urls` is given)
 *   click(target)       target = the box around the element to click, or null when it is not in the screenshot
 *   scroll(direction)   down / up / top / bottom, only the directions the scroll position allows
 *   type_text(text)     text = one of the candidates in `texts`, typed into the focused field (only when `texts` is given)
 *   press_key(key)      key  = one of `keys` (default Enter, Tab, Escape)
 *   go_back             the previous page of the history
 *   end                 built in
 *
 * Every tool that changes the page replaces two state slots: `screen` (the screenshot) and `page` ({ url, title, scroll }).
 * Put them into `initialState` with `await browser.snapshot()` (after `browser.goto(start)`) or leave them out and offer `navigate`.
 */
import { defineTool, type AnyTool } from "../tools/tool.js";
import { param, type Options, type ParamContext } from "../tools/param.js";
import { isImageValue } from "../state/images.js";
import type { BrowserSession, ScrollDirection } from "./session.js";

export type Candidates = Options | ((ctx: ParamContext) => Options);

export type BrowserToolsOptions = {
  /** Addresses the agent may open, as `url` or `url -> what is there`. Without it there is no `navigate` tool. */
  urls?: Candidates;
  /** Texts the agent may type, as `text` or `text -> when to use it`. Without it there is no `type_text` tool. */
  texts?: Candidates;
  /** Keys the agent may press. Default Enter, Tab and Escape. */
  keys?: Options;
  /** The state slot that holds the screenshot. Default `screen`. */
  screen?: string;
  /** Replace the wording of any question (every question names state by path and asks for one judgment). */
  questions?: Partial<Record<"navigate" | "click" | "clickPresent" | "scroll" | "typeText" | "pressKey", string>>;
};

const DIRECTIONS: Record<ScrollDirection, string> = {
  down: "Scroll down by most of a screen, to see what is below",
  up: "Scroll up by most of a screen, to see what is above",
  top: "Jump to the very top of the page",
  bottom: "Jump to the very bottom of the page",
};

/** The scroll directions that would move the page, from `state.page.scroll`. All of them while the position is unknown. */
function scrollOptions(ctx: ParamContext): Record<string, string> {
  const s = ctx.state.page?.scroll as { position: number; max: number } | undefined;
  const allowed = (d: ScrollDirection) => (s === undefined ? true : d === "down" || d === "bottom" ? s.position < s.max : s.position > 0);
  return Object.fromEntries((Object.keys(DIRECTIONS) as ScrollDirection[]).filter(allowed).map((d) => [d, DIRECTIONS[d]]));
}

export function browserTools(browser: BrowserSession, options: BrowserToolsOptions = {}): AnyTool[] {
  const slot = options.screen ?? "screen";
  const ref = `state.${slot}`;
  const q = options.questions ?? {};
  const hasScreen = (state: Readonly<Record<string, unknown>>) => isImageValue(state[slot]);

  const tools: AnyTool[] = [];

  if (options.urls) {
    tools.push(
      defineTool({
        name: "navigate",
        description: "Opens one of the web addresses in the options in the browser.",
        params: { url: param.choice({ question: q.navigate ?? "Which address do `instructions` say to open in the browser next?", options: options.urls as never }) },
        run: async ({ url }) => {
          await browser.goto(url as string);
          const page = (await browser.info()).title;
          return { state: await browser.snapshot(slot), summary: `opened ${url}${page ? ` ("${page}")` : ""}` };
        },
      }),
    );
  }

  tools.push(
    defineTool({
      name: "click",
      description: `Clicks one element of the web page, which is the picture in \`${ref}\`.`,
      available: ({ state }) => hasScreen(state),
      params: {
        target: param.box({
          question: q.click ?? `the element that \`instructions\` say to click next, in \`${ref}\``,
          image: ref,
          present: q.clickPresent ?? `Is the element that \`instructions\` say to click next visible in \`${ref}\`?`,
        }),
      },
      run: async ({ target }, ctx) => {
        if (!target) return { summary: "found nothing to click: the element is not visible in the screenshot" };
        const before = (ctx.state[slot] as { $image?: { base64: string } } | undefined)?.$image?.base64;
        const clicked = await browser.clickBox(target);
        const state = await browser.snapshot(slot);
        const same = before !== undefined && (state[slot] as { $image: { base64: string } }).$image.base64 === before;
        const note = clicked.blocked ? `, but ${clicked.blocked} is not an allowed address, so the page stayed` : same ? ", and the page looks the same" : "";
        return { state, summary: `clicked ${clicked.element} at (${clicked.x}, ${clicked.y})${note}` };
      },
    }),
    defineTool({
      name: "scroll",
      description: "Scrolls the web page in the browser to see another part of it.",
      available: ({ state }) => hasScreen(state) && ((state.page?.scroll as { max: number } | undefined)?.max ?? 1) > 0,
      params: { direction: param.choice({ question: q.scroll ?? `In which direction should the page in \`${ref}\` be scrolled to bring into view what \`instructions\` talk about?`, options: scrollOptions }) },
      run: async ({ direction }) => {
        const at = await browser.scroll(direction as ScrollDirection);
        return { state: await browser.snapshot(slot), summary: `scrolled ${direction} to ${at}px from the top` };
      },
    }),
  );

  if (options.texts) {
    tools.push(
      defineTool({
        name: "type_text",
        description: "Types one of the texts in the options into the field that is selected on the web page.",
        available: ({ state }) => hasScreen(state),
        params: { text: param.choice({ question: q.typeText ?? `Which text do \`instructions\` say to type into the field that is selected in \`${ref}\`?`, options: options.texts as never }) },
        run: async ({ text }) => {
          const into = await browser.type(text as string);
          if (into === null) return { summary: `typed nothing: no field is selected (click a field first)` };
          return { state: await browser.snapshot(slot), summary: `typed "${text}" into the <${into}>` };
        },
      }),
    );
  }

  tools.push(
    defineTool({
      name: "press_key",
      description: "Presses one key of the keyboard in the browser, for example to submit a form.",
      available: ({ state }) => hasScreen(state),
      params: { key: param.choice({ question: q.pressKey ?? "Which key do `instructions` say to press now?", options: options.keys ?? ["Enter", "Tab", "Escape"] }) },
      run: async ({ key }) => {
        await browser.press(key as string);
        return { state: await browser.snapshot(slot), summary: `pressed ${key}` };
      },
    }),
    defineTool({
      name: "go_back",
      description: "Goes back to the previous web page in the browser history.",
      available: ({ state }) => hasScreen(state),
      run: async () => {
        const went = await browser.back();
        return went ? { state: await browser.snapshot(slot), summary: "went back to the previous page" } : { summary: "there is no previous page to go back to" };
      },
    }),
  );

  return tools;
}
