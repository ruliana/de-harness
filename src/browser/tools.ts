/**
 * Tools that drive a `BrowserSession`. The page is seen only as a screenshot in `state.screen`; the model points at it with a
 * Box, and the rest of its choices come from candidates that code supplies (Jev cannot write text).
 *
 *   navigate(url)       url  = one of the addresses in `urls`                  (only when `urls` is given)
 *   click(target)       target = the box around the element to click, or null when it is not in the screenshot
 *   hover(target)       target = the box around the element to move the pointer onto (menus that open when hovered; only when `hover` is set)
 *   scroll(direction)   down / up / top / bottom, only the directions the scroll position allows
 *   type_text(text)     text = one of the candidates in `texts`, typed into the focused field (only when `texts` is given)
 *   press_key(key)      key  = one of `keys` (default Enter, Tab, Escape)
 *   go_back             the previous page of the history; on the first page it changes nothing and says so (it never goes to a blank page)
 *   end                 built in
 *
 * Small and loose targets: Jev draws a Box on a grid about 13 x 8 px fine, so a target a few pixels wide (the x of a pop-up) cannot be hit with one.
 * When the Box is smaller than `zoom.smallerThan` (48 px) on both sides, or has nothing pressable under it or in it, the same question is asked
 * again on a picture of the part of the page around it, enlarged `zoom.factor` (3) times, and the answer is mapped back to the page. A click point that lands on something that cannot be pressed
 * is moved onto the pressable element that covers most of the Box (see `BrowserSession.targetOf`).
 *
 * No-change guard: click, hover, scroll, press_key and go_back are not offered any more once they changed nothing `noChange` (3) times
 * in a row; `state.stuck` shows the counts. Any change of the screenshot lifts it, except one that is only what the pointer lit up: a button's hover colour
 * is not the page changing (see `stuck.ts`).
 *
 * Every tool that changes the page replaces two state slots: `screen` (the screenshot) and `page` ({ url, title, scroll }; only `scroll` with `pageText: false`).
 * Put them into `initialState` with `await browser.snapshot()` (after `browser.goto(start)`) or leave them out and offer `navigate`.
 */
import { defineTool, type AnyTool, type ToolContext } from "../tools/tool.js";
import type { Json } from "../state/state.js";
import type { Box } from "../model/types.js";
import { param, type Options, type ParamContext } from "../tools/param.js";
import { isImageValue } from "../state/images.js";
import type { BrowserSession, ScrollDirection } from "./session.js";
import { DEFAULT_NO_CHANGE, isStuck, nextStuck, sameScreen } from "./stuck.js";

export type Candidates = Options | ((ctx: ParamContext) => Options);

export type BrowserToolsOptions = {
  /** Addresses the agent may open, as `url` or `url -> what is there`. Without it there is no `navigate` tool. */
  urls?: Candidates;
  /** Texts the agent may type, as `text` or `text -> when to use it`. Without it there is no `type_text` tool. */
  texts?: Candidates;
  /**
   * Offer `hover(target)`, a Box like `click`'s that moves the pointer instead of pressing: for menus that open on hover. Default false.
   * With "or-click", a hover after which the page looks the same (apart from what the pointer lit up) is followed by a click on the same point:
   * for menus that open when pressed. Code decides; the model is not asked which kind of menu it is.
   */
  hover?: boolean | "or-click";
  /**
   * When `click` finds its target is not in the screenshot and the page can scroll further down, scroll down one step instead of doing nothing,
   * so that the next try sees more of the page (options of an item below the fold). Default false.
   */
  scrollToFind?: boolean;
  /** Ask a Box question again on an enlarged picture when the first answer is smaller than `smallerThan` px on both sides. Default `{ smallerThan: 48, factor: 3 }`; false turns it off. */
  zoom?: boolean | { smallerThan?: number; factor?: number };
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

const canScrollDown = async (browser: BrowserSession): Promise<boolean> => {
  const { position, max } = (await browser.info()).scroll;
  return position < max;
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
  const seen = (tool: string, ctx: { state: Readonly<Record<string, unknown>> }, snapshot: Record<string, Json>): Record<string, Json | null> => ({ ...snapshot, stuck: nextStuck(ctx.state.stuck, tool, ctx.state[slot], snapshot[slot], browser.pointerNoise()) });

  const clickQuestion = q.click ?? `the element that \`instructions\` say to click next, in \`${ref}\``;
  const clickPresent = q.clickPresent ?? `Is the element that \`instructions\` say to click next visible in \`${ref}\`?`;
  const hoverQuestion = q.hover ?? `the element that \`instructions\` say to point the mouse at, in \`${ref}\``;
  const hoverPresent = q.hoverPresent ?? `Is the element that \`instructions\` say to point the mouse at visible in \`${ref}\`?`;
  const zoom = options.zoom === false ? null : { smallerThan: 48, factor: 3, ...(typeof options.zoom === "object" ? options.zoom : {}) };
  const widthOf = (b: Box) => (b.right - b.left) * browser.viewport.width;
  const heightOf = (b: Box) => (b.bottom - b.top) * browser.viewport.height;
  const small = (b: Box) => Math.max(widthOf(b), heightOf(b)) < zoom!.smallerThan;
  /** Does the Box fit in the part of the page that an enlarged picture shows? */
  const fits = (b: Box) => widthOf(b) <= browser.viewport.width / zoom!.factor && heightOf(b) <= browser.viewport.height / zoom!.factor;
  /**
   * The Box to act on: the model's, or its answer to the same question on an enlarged picture of the part around it, when the first is too
   * small to be exact (Jev's finest box is about 13 x 8 px) or is loose (nothing pressable under it or in it, so the click would land on a gap).
   */
  const aim = async (target: Box, ctx: ToolContext, question: string, present: string): Promise<Box> => {
    if (!zoom) return target;
    if (!small(target) && !(fits(target) && (await browser.targetOf(target)).on === "nothing")) return target;
    const zoomed = await browser.zoom(target, zoom.factor);
    const locate = defineTool({
      name: "locate",
      description: "Points at the element on the enlarged picture of a part of the web page, which is the picture in `state.zoom`.",
      params: { target: param.box({ question: question.replaceAll(ref, "state.zoom"), image: "state.zoom", present: present.replaceAll(ref, "state.zoom") }) },
      run: ({ target }) => ({ end: true, output: target }),
    });
    const child = await ctx.runAgent({ instructions: ctx.instructions, tools: [locate, defineTool({ name: "end", description: "Stops.", available: () => false, run: () => ({ end: true }) })], initialState: { zoom: zoomed.screen }, maxSteps: 1, previousActions: 0 });
    if (child.status === "error") throw child.error ?? new Error("browser: the enlarged picture could not be read");
    const refined = child.output as Box | null | undefined;
    return refined ? browser.fromZoom(zoomed, refined) : target;
  };

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
          question: clickQuestion,
          image: ref,
          present: clickPresent,
        }),
      },
      run: async ({ target }, ctx) => {
        if (!target) {
          if (options.scrollToFind && (await canScrollDown(browser))) {
            const at = await browser.scroll("down");
            return { state: seen("click", ctx, await snap()), summary: `found nothing to click: the element is not visible in the screenshot, so scrolled down to look further (${at}px from the top)` };
          }
          return { summary: "found nothing to click: the element is not visible in the screenshot" };
        }
        const aimed = await aim(target, ctx, clickQuestion, clickPresent);
        const clicked = await browser.clickBox(aimed);
        const state = await snap();
        const same = sameScreen(ctx.state[slot], state[slot], browser.pointerNoise());
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
                question: hoverQuestion,
                image: ref,
                present: hoverPresent,
              }),
            },
            run: async ({ target }, ctx) => {
              if (!target) return { summary: "found nothing to point at: the element is not visible in the screenshot" };
              const aimed = await aim(target, ctx, hoverQuestion, hoverPresent);
              const pointed = await browser.hoverBox(aimed);
              let state = await snap();
              if (options.hover === "or-click" && sameScreen(ctx.state[slot], state[slot], browser.pointerNoise())) {
                const clicked = await browser.clickBox(aimed);
                state = await snap();
                const note = clicked.blocked ? `, but ${clicked.blocked} is not an allowed address, so the page stayed` : "";
                return { state: seen("hover", ctx, state), summary: `pointed at ${pointed.element} at (${pointed.x}, ${pointed.y}), nothing opened, so clicked ${clicked.element}${note}` };
              }
              return { state: seen("hover", ctx, state), summary: `pointed at ${pointed.element} at (${pointed.x}, ${pointed.y})` };
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
