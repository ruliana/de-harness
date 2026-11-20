/**
 * The deciding level of a browser agent that looks only at the screenshot. It does not point at anything: it judges what the
 * screenshot shows (a few yes/no questions) and picks one of a short list of tactics that name no site and no task. Code supplies
 * the list, so the model never has to write a goal. A second level (not here yet) carries a tactic out with a Box.
 *
 * Nothing but `state.screen`, `state.done` and the task reaches the model: no page text, no address, no title.
 * All question wording of this level is in this file.
 */
import type { DecisionModel, DecisionRequest, Image, Question } from "../../src/index.js";
import { readNoul } from "../../src/index.js";

/** The tactics, in the order the model sees them. The keys are the answers; the values are what each one means (the model reads these). */
export const TACTICS = {
  open_menu: "Point at an entry in the row of menus at the top of the page, so that a menu opens under it. Right on the front page of a site when what `instructions` ask for is not visible yet and no menu is open.",
  pick_menu_entry: "Click the entry of the open menu that leads to what `instructions` ask for. Right when a menu is open.",
  scroll: "Scroll down to bring more of this page into view. Right only on a list of items, when what `instructions` ask for is not visible in it yet and the list goes on below.",
  click_item: "Click the item that `instructions` ask for in a list of items, to open its own page. Right when that item is visible in a list.",
  select_option: "Choose the option that `instructions` ask for (a size, a colour) on the page of one item. Right on an item's page when that option is not chosen yet.",
  read_value: "Read the value that `instructions` ask to get (a price, a number) from the page. Right when that value is visible and the options `instructions` ask for are chosen.",
  go_back: "Go back to the previous page. Right when this page does not lead to what `instructions` ask for.",
  close_overlay: "Close what is in the way (a pop-up, a banner, a notice).",
  end: "Stop, because `instructions` have been carried out according to `state.done`.",
} as const;
export type Tactic = keyof typeof TACTICS;
export const TACTIC_IDS = Object.keys(TACTICS) as Tactic[];

/** How each tactic reads in `state.done`, once it has happened. */
export const DONE = {
  open_menu: "pointed at an entry at the top of the page, so that its menu opened",
  pick_menu_entry: "clicked an entry of the open menu",
  scroll: "scrolled down",
  click_item: "clicked an item of a list, to open its page",
  select_option: "chose an option on the item's page",
  read_value: "read the value into `state.price`",
  go_back: "went back to the previous page",
  close_overlay: "closed something that was in the way",
  end: "stopped",
} as const satisfies Record<Tactic, string>;
export const DONE_OPENED = "opened the home page of the web site";

export const PAGE_KINDS = {
  home: "The front page of a web site: banners and a few sections of items",
  list: "A list or grid of several items, with a price or a name under each",
  item: "The page of one single item: a large picture, options such as sizes, and a price",
  other: "Anything else: a pop-up, a bag, a checkout, an error",
} as const;
export type PageKind = keyof typeof PAGE_KINDS;

/** Every judgment of the screen, one question each. */
export const QUESTIONS = {
  itemVisible: "Is the item that `instructions` ask for visible in `state.screen`, as a picture or a name (not as a menu entry or a heading)?",
  menuOpen: "Is a list of links shown under the row of menu entries at the top of `state.screen`?",
  optionChosen: "Is every option that `instructions` ask for (such as the size) chosen in `state.screen`?",
  valueVisible: "Is the price of the item that `instructions` ask for visible in `state.screen`, next to that item?",
  pageKind: "Which kind of page is `state.screen`?",
  tactic: "Which action best advances `instructions`, given `state.screen`, `state.judgments` and `state.done`?",
} as const;

export type Judgments = {
  itemVisible: boolean | "unsure";
  menuOpen: boolean | "unsure";
  optionChosen: boolean | "unsure";
  valueVisible: boolean | "unsure";
  pageKind: PageKind;
};

/** What the model gets to see. `done` is progress as code recorded it; `judgments` are the earlier judgments of the same screenshot. */
export type PlannerState = { screen: string; judgments?: Judgments; done?: string[] };

const request = (instructions: string, state: PlannerState, images: Record<string, Image>, questions: Record<string, Question>): DecisionRequest => ({
  state: { instructions, state, previous_actions: [] },
  questions,
  images,
});

/** The judgments of one screenshot, in one request. */
export async function judge(model: DecisionModel, instructions: string, ref: string, images: Record<string, Image>): Promise<Judgments> {
  const noul = (instructions: string): Question => ({ type: "noul", instructions });
  const res = await model.ask(
    request(instructions, { screen: ref }, images, {
      itemVisible: noul(QUESTIONS.itemVisible),
      menuOpen: noul(QUESTIONS.menuOpen),
      optionChosen: noul(QUESTIONS.optionChosen),
      valueVisible: noul(QUESTIONS.valueVisible),
      pageKind: { type: "choice", instructions: QUESTIONS.pageKind, criteria: PAGE_KINDS },
    }),
  );
  const p = (id: string) => {
    const a = res.answers[id];
    if (a?.type !== "noul") throw new Error(`no yes/no answer for ${id}`);
    return readNoul(a.noul);
  };
  const kind = res.answers.pageKind;
  if (kind?.type !== "choice") throw new Error("no answer for pageKind");
  return { itemVisible: p("itemVisible"), menuOpen: p("menuOpen"), optionChosen: p("optionChosen"), valueVisible: p("valueVisible"), pageKind: kind.choice as PageKind };
}

export type TacticPick = { tactic: Tactic; confidence: number | null };

/** One Choice over the tactics. */
export async function pickTactic(model: DecisionModel, instructions: string, state: PlannerState, images: Record<string, Image>): Promise<TacticPick> {
  const res = await model.ask(request(instructions, state, images, { tactic: { type: "choice", instructions: QUESTIONS.tactic, criteria: TACTICS } }));
  const a = res.answers.tactic;
  if (a?.type !== "choice") throw new Error("no answer for tactic");
  return { tactic: a.choice as Tactic, confidence: a.confidence };
}

/**
 * What the navigating level is told to do for a tactic. The child agent's `instructions` are the task, then this: one step, then stop.
 * "The task" is whatever the person asked, in their words; the goals name no site.
 */
export const GOALS: Record<Exclude<Tactic, "end">, string> = {
  open_menu: "Point the mouse at the entry in the row of menus at the top of the page that is most likely to lead to what the task asks for, so that its menu opens. Then stop.",
  pick_menu_entry: "Click the entry of the open menu that leads to what the task asks for. Then stop.",
  scroll: "Scroll down once, to see more of this page. Then stop.",
  click_item: "Click the item that the task asks for. Then stop.",
  select_option: "Click the option that the task asks for (such as the size) on this page. Then stop.",
  read_value: "Point at the value that the task asks to get, to read it. Then stop.",
  go_back: "Go back to the previous page. Then stop.",
  close_overlay: "Close what is in the way, by clicking its close button or pressing Escape. Then stop.",
};

/**
 * The wording of the navigator's click question for the tactics whose target the generic one ("the element that `instructions` say to click next")
 * does not find: on an open menu it picked the search field or answered that nothing was there. Other tactics use the generic wording.
 */
export const NAVIGATOR_QUESTIONS: Partial<Record<Exclude<Tactic, "end">, { click: string; clickPresent: string }>> = {
  pick_menu_entry: {
    click: "the entry of the open menu in `state.screen` that is most likely to lead to what `instructions` ask for",
    // The model said "no" to "is there an entry that leads to what `instructions` ask for?" on an open menu of 25 entries (nothing in it says "white"), so
    // it does not judge the match: it judges that the menu is there, and the Box picks the best entry.
    clickPresent: QUESTIONS.menuOpen,
  },
};

/** The browser tools (by name) that the navigator of a tactic is given, out of those of `shoppingTools`. */
export const NAVIGATOR_TOOLS: Record<Exclude<Tactic, "end">, string[]> = {
  open_menu: ["hover"],
  pick_menu_entry: ["click"],
  scroll: ["scroll"],
  click_item: ["click"],
  select_option: ["click"],
  read_value: ["read_price"],
  go_back: ["go_back"],
  close_overlay: ["click", "press_key"],
};

/**
 * How a tactic is checked once the navigator is done, on the screenshot it left. `changed`: the screenshot must differ from before.
 * `holds`: what the judgments of the new screenshot must say. Code decides what the answers mean; "unsure" is not done.
 */
export const CHECKS: Record<Exclude<Tactic, "end">, { changed: boolean; holds?: (j: Judgments) => boolean | "unsure" }> = {
  open_menu: { changed: true, holds: (j) => j.menuOpen },
  pick_menu_entry: { changed: true, holds: (j) => (j.menuOpen === "unsure" ? "unsure" : !j.menuOpen) },
  scroll: { changed: true },
  click_item: { changed: true, holds: (j) => j.pageKind === "item" },
  select_option: { changed: true, holds: (j) => j.optionChosen },
  read_value: { changed: false },
  go_back: { changed: true },
  close_overlay: { changed: true },
};
