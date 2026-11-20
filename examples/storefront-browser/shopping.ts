/**
 * Shopping in a web shop by sight: go to the shop, find a blue sweatshirt, select size large, read its price. Nothing is added to
 * the bag. The page is only a screenshot (`state.screen`); the model points at it with boxes and never reads a character of it.
 *
 *   navigate(url)     open the shop's home page (the only address offered; the first step, before any page is open)
 *   hover(target)     point at a menu entry, so that its menu opens
 *   click(target)     click a menu entry, a product, a size
 *   scroll(direction) see more of a long page
 *   read_price(target) point at the price: code reads the characters inside the box into `state.price`
 *   press_key, go_back, end
 *
 * Code decides what the model cannot write: the address it may open, the click point (the box's centre), the price's characters
 * (the text of the page inside the box) and, in the test and the runner, whether the run found the right thing (`pageFacts`).
 */
import { defineTool, param, type AnyTool } from "../../src/index.js";
import { browserTools, type BrowserSession } from "../../src/browser/index.js";

/** Every question this example asks, in one place (the generic click, hover and scroll questions live in `src/browser/tools.ts`). */
export const QUESTIONS = {
  click: "the element that `instructions` say to click next, in `state.screen`",
  hover: "the menu entry in `state.screen` that `instructions` say to point at, to open its menu",
  price: "the price of the item that `instructions` ask for, in `state.screen`",
  pricePresent: "Is the price of the item that `instructions` ask for visible in `state.screen`?",
  hoverPresent: "Is there a menu entry at the top of `state.screen` that can be pointed at to open a menu?",
} as const;

/**
 * The task as a person would say it, for a shop that can be named ("aloyoga.com") and one that cannot ("the shop"). Jev needs more than
 * this: it scrolls and scrolls, or keeps pointing at nothing, because nothing says where in the page to look first.
 */
export const plainInstructions = (shop: string, what = "a blue sweatshirt", size = "large") =>
  `Go to ${shop}, find ${what}, select size ${size}, and get the price. Never add anything to the bag and never open the checkout. Stop once \`state.price\` shows the price of ${what} in size ${size}.`;

/** The same task with the steps spelled out. Without the steps a plain request is not carried out (see the README). Nothing in them is specific to one shop. */
export const stepInstructions = (shop: string, what = "a blue sweatshirt", section = "sweatshirts", size = "large", sizeButton = "L") =>
  `Go to ${shop}, find ${what}, select size ${size}, and get the price. Do it in these steps: ` +
  `1. Open the shop's home page. ` +
  `2. Point the mouse at a menu entry at the top of the page so that its menu opens, then click the entry for ${section} in that menu. ` +
  `3. Scroll down the list until you see ${what}, then click it. ` +
  `4. On the product page, click the size ${sizeButton} button. ` +
  `5. Point at the price to read it into \`state.price\`. ` +
  `6. Stop. ` +
  `Never add anything to the bag and never open the checkout.`;

/** The same task for an agent that has no `state.price` of its own: it stops when the price has been read. */
export const plainTask = (shop: string, what = "a blue sweatshirt", size = "large") =>
  `Go to ${shop}, find ${what}, select size ${size}, and get the price. Never add anything to the bag and never open the checkout. Stop once the price of ${what} in size ${size} has been read.`;

export const SHOPPING_TASK = plainInstructions("aloyoga.com");
export const SHOPPING_STEPS = stepInstructions("aloyoga.com");

const MONEY = /(?:[$€£]|USD\s?)\s?\d[\d,]*(?:\.\d{2})?/;

export type ShoppingOptions = {
  /** The shop's home page: the one address `navigate` offers. */
  home: string;
  /** Leave the page's address and title out of the state (`state.page` keeps only the scroll position): the model then has nothing but the picture. */
  pageText?: boolean;
  /** Replace the wording of a question. */
  questions?: Partial<typeof QUESTIONS>;
};

/** The browser tools for a shop and the one tool that reads a price. Start the agent with no state: `navigate` is the only tool until a page is open. */
export function shoppingTools(browser: BrowserSession, opts: ShoppingOptions): AnyTool[] {
  const q = { ...QUESTIONS, ...opts.questions };
  const readPrice = defineTool({
    name: "read_price",
    description: "Reads the price of the item from the web page, which is the picture in `state.screen`.",
    available: ({ state }) => state.screen !== undefined,
    params: { target: param.box({ question: q.price, image: "state.screen", present: q.pricePresent }) },
    run: async ({ target }) => {
      if (!target) return { summary: "found no price: it is not visible in the screenshot" };
      // Boxes are a few pixels off: look a little beyond it. Code decides what counts as a price: exactly one distinct amount in there.
      const text = await browser.textIn(target, 0.02);
      const prices = [...new Set((text.match(new RegExp(MONEY, "g")) ?? []).map((m) => m.replace(/\s+/g, "")))];
      if (prices.length === 0) return { summary: `found no price in that box (it holds "${text.slice(0, 60)}")` };
      if (prices.length > 1) return { summary: `found several prices in that box (${prices.join(", ")}): point at just one` };
      return { state: { price: { text: prices[0]!, page: (await browser.info()).url } }, summary: `read the price ${prices[0]}` };
    },
  });
  return [
    ...browserTools(browser, { urls: { [opts.home]: "the home page of the shop" }, hover: true, pageText: opts.pageText, questions: { click: q.click, hover: q.hover, hoverPresent: q.hoverPresent } }),
    readPrice,
  ];
}

