/**
 * Tools that drive a `BrowserSession`. The page is seen only as a screenshot in `state.screen`; the model points at it with a
 * Box, and the rest of its choices come from candidates that code supplies (Jev cannot write text).
 *
 *   navigate(url)       url  = one of the addresses in `urls`                  (only when `urls` is given)
 *   click(target)       target = the box around the element to click, or null when it is not in the screenshot
 *   hover(target)       target = the box around the element to move the pointer onto (menus that open when hovered; only when `hover` is true)
 *   scroll(direction)   down / up / top / bottom, only the directions the scroll position allows
 *   type_text(text)     text = one of the candidates in `texts`, typed into the focused field (only when `texts` is given)
 *   press_key(key)      key  = one of `keys` (default Enter, Tab, Escape)
 *   go_back             the previous page of the history; on the first page it changes nothing and says so (it never goes to a blank page)
 *   end                 built in
 *
 * No-change guard: click, hover, scroll, press_key and go_back are not offered any more once they changed nothing `noChange` (3) times
 * in a row; `state.stuck` shows the counts. Any change of the screenshot lifts it.
 *
 * Every tool that changes the page replaces two state slots: `screen` (the screenshot) and `page` ({ url, title, scroll }; only `scroll` with `pageText: false`).
 * Put them into `initialState` with `await browser.snapshot()` (after `browser.goto(start)`) or leave them out and offer `navigate`.
 */
import { defineTool, type AnyTool } from "../tools/tool.js";
import type { Json } from "../state/state.js";
import { param, type Options, type ParamContext } from "../tools/param.js";
import { isImageValue } from "../state/images.js";
import type { BrowserSession, ScrollDirection } from "./session.js";
import { DEFAULT_NO_CHANGE, isStuck, nextStuck } from "./stuck.js";

export type Candidates = Options | ((ctx: ParamContext) => Options);

export type BrowserToolsOptions = {
  /** Addresses the agent may open, as `url` or `url -> what is there`. Without it there is no `navigate` tool. */
  urls?: Candidates;
  /** Texts the agent may type, as `text` or `text -> when to use it`. Without it there is no `type_text` tool. */
  texts?: Candidates;
  /** Offer `hover(target)`, a Box like `click`'s that moves the pointer instead of pressing: for menus that open on hover. Default false. */
  hover?: boolean;
  /** Keys the agent may press. Default Enter, Tab and Escape. */
  keys?: Options;
  /** Stop offering a tool that left the screenshot unchanged this many times in a row. Default 3, 0 turns the guard off. */
  noChange?: number;
  /** Put the address and title of the page into `state.page`. Default true; false leaves only `page.scroll`, for agents that must decide from the picture alone. */
  pageText?: boolean;
  /** The state slot that holds the screenshot. Default `screen`. */
  screen?: string;
  /** Replace the wording of any question (every question names state by path and asks for one judgment). */
  questions?: Partial<Record<"navigate" | "click" | "clickPresent" | "hover" | "hoverPresent" | "scroll" | "typeText" | "pressKey", string>>;
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

/** The screenshot and where the page is; without `pageText` the page's address and title are left out. */
export async function snapshotOf(browser: BrowserSession, slot = "screen", pageText = true): Promise<Record<string, Json>> {
  const snapshot = await browser.snapshot(slot);
  return pageText ? snapshot : { ...snapshot, page: { scroll: (snapshot.page as { scroll: Json }).scroll } };
}

export function browserTools(browser: BrowserSession, options: BrowserToolsOptions = {}): AnyTool[] {
  const slot = options.screen ?? "screen";
  const ref = `state.${slot}`;
  const q = options.questions ?? {};
  const limit = options.noChange ?? DEFAULT_NO_CHANGE;
  const snap = () => snapshotOf(browser, slot, options.pageText !== false);
  const hasScreen = (state: Readonly<Record<string, unknown>>) => isImageValue(state[slot]);
  /** The tool is offered when there is a screenshot and the guard has not stopped it. */
  const usable = (tool: string) => ({ state }: { state: Readonly<Record<string, unknown>> }) => hasScreen(state) && !isStuck(state.stuck, tool, limit);
  /** The state a changing tool writes: the new snapshot and the guard's count. */
  const seen = (tool: string, ctx: { state: Readonly<Record<string, unknown>> }, snapshot: Record<string, Json>): Record<string, Json | null> => ({ ...snapshot, stuck: nextStuck(ctx.state.stuck, tool, ctx.state[slot], snapshot[slot]) });

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
          return { state: await snap(), summary: `opened ${url}${page ? ` ("${page}")` : ""}` };
        },
      }),
    );
  }

  tools.push(
    defineTool({
      name: "click",
      description: `Clicks one element of the web page, which is the picture in \`${ref}\`.`,
      available: usable("click"),
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
        const state = await snap();
        const same = before !== undefined && (state[slot] as { $image: { base64: string } }).$image.base64 === before;
        const note = clicked.blocked ? `, but ${clicked.blocked} is not an allowed address, so the page stayed` : same ? ", and the page looks the same" : "";
        return { state: seen("click", ctx, state), summary: `clicked ${clicked.element} at (${clicked.x}, ${clicked.y})${note}` };
      },
    }),
    ...(options.hover
      ? [
          defineTool({
            name: "hover",
            description: `Moves the mouse pointer onto one element of the web page, which is the picture in \`${ref}\`, without clicking: menus open this way.`,
            available: usable("hover"),
            params: {
              target: param.box({
                question: q.hover ?? `the element that \`instructions\` say to point the mouse at, in \`${ref}\``,
                image: ref,
                present: q.hoverPresent ?? `Is the element that \`instructions\` say to point the mouse at visible in \`${ref}\`?`,
              }),
            },
            run: async ({ target }, ctx) => {
              if (!target) return { summary: "found nothing to point at: the element is not visible in the screenshot" };
              const pointed = await browser.hoverBox(target);
              return { state: seen("hover", ctx, await snap()), summary: `pointed at ${pointed.element} at (${pointed.x}, ${pointed.y})` };
            },
          }),
        ]
      : []),
    defineTool({
      name: "scroll",
      description: "Scrolls the web page in the browser to see another part of it.",
      available: (ctx) => usable("scroll")(ctx) && ((ctx.state.page?.scroll as { max: number } | undefined)?.max ?? 1) > 0,
      params: { direction: param.choice({ question: q.scroll ?? `In which direction should the page in \`${ref}\` be scrolled to bring into view what \`instructions\` talk about?`, options: scrollOptions }) },
      run: async ({ direction }, ctx) => {
        const at = await browser.scroll(direction as ScrollDirection);
        return { state: seen("scroll", ctx, await snap()), summary: `scrolled ${direction} to ${at}px from the top` };
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
          return { state: await snap(), summary: `typed "${text}" into the <${into}>` };
        },
      }),
    );
  }

  tools.push(
    defineTool({
      name: "press_key",
      description: "Presses one key of the keyboard in the browser, for example to submit a form.",
      available: usable("press_key"),
      params: { key: param.choice({ question: q.pressKey ?? "Which key do `instructions` say to press now?", options: options.keys ?? ["Enter", "Tab", "Escape"] }) },
      run: async ({ key }, ctx) => {
        await browser.press(key as string);
        return { state: seen("press_key", ctx, await snap()), summary: `pressed ${key}` };
      },
    }),
    defineTool({
      name: "go_back",
      description: "Goes back to the previous web page in the browser history.",
      available: usable("go_back"),
      run: async (_args, ctx) => {
        const went = await browser.back();
        // Without a previous page nothing moves, but the step still reports the (unchanged) screenshot, so the no-change guard counts it and stops offering go_back.
        return { state: seen("go_back", ctx, await snap()), summary: went ? "went back to the previous page" : "there is no previous page to go back to: the browser is still on the same page" };
      },
    }),
  );

  return tools;
}
