/**
 * Navigating Wikipedia by following links.
 *
 *   open_link(link)  follow one of the links of the article body (options: article titles, described by anchor text)
 *   go_back          return to the article before this one, and never offer the abandoned one again
 *   end              stop: the article in `state.page.title` is the one the instructions ask for
 *
 * State: `page` (title and lead of the current article), `trail` (titles from the start to here), `abandoned`
 * (articles left through go_back). Code, not the model, cuts the link list to the budget and removes what is already
 * on the trail or abandoned.
 */
import { defineTool, param, type AnyTool, type Json } from "../../src/index.js";
import { createClient, type Page, type WikipediaClientOptions } from "./client.js";

export type WikipediaOptions = WikipediaClientOptions & {
  /** Most links offered per article. Default 200 (a Choice takes at most 255). */
  maxLinks?: number;
  /** Most characters of option text per article. Default 14 000 (~3.5k tokens). */
  maxLinkChars?: number;
  /** Characters of the lead kept in the state. Default 500. */
  leadChars?: number;
};

export const instructionsFor = (from: string, to: string) =>
  `Navigate Wikipedia from the article "${from}" to the article "${to}" by following links. Stop when the article you are on is "${to}".`;

/** One option per link: key = article title, description = how the text shows it. */
export function linkOptions(page: Page, exclude: ReadonlySet<string>, maxLinks: number, maxChars: number): Record<string, string> {
  const options: Record<string, string> = {};
  let chars = 0;
  for (const link of page.links) {
    if (exclude.has(link.title)) continue;
    const description = link.texts.length ? `shown in the text as ${link.texts.map((t) => `"${t}"`).join(", ")}` : "linked from the text";
    chars += link.title.length + description.length;
    if (Object.keys(options).length >= maxLinks || chars > maxChars) break;
    options[link.title] = description;
  }
  return options;
}

export async function createWikipedia(opts: WikipediaOptions & { start: string }) {
  const maxLinks = Math.min(opts.maxLinks ?? 200, 255);
  const maxChars = opts.maxLinkChars ?? 14_000;
  const leadChars = opts.leadChars ?? 500;
  const client = createClient(opts);
  const cache = new Map<string, Page>();
  const open = async (title: string): Promise<Page> => {
    const page = await client.page(title);
    cache.set(page.title, page);
    return page;
  };

  const trail: Page[] = [await open(opts.start)];
  const abandoned: string[] = [];
  /** Link targets already followed: a redirect opens an article under another title, and its old name must not be offered again. */
  const followed = new Set<string>([opts.start]);
  const here = () => trail[trail.length - 1]!;
  const slots = (): Record<string, Json | null> => ({
    page: { title: here().title, summary: here().lead.slice(0, leadChars) },
    trail: trail.map((p) => p.title),
    abandoned: abandoned.length ? [...abandoned] : null,
  });
  const excluded = () => new Set([...trail.map((p) => p.title), ...abandoned, ...followed]);

  const tools: AnyTool[] = [
    defineTool({
      name: "open_link",
      description: "Follows one link of the article in `state.page` and opens the linked article.",
      params: {
        link: param.choice({
          question: "Which of these linked articles is the best next step from the article in `state.page` towards the article that `instructions` ask to reach?",
          options: () => linkOptions(here(), excluded(), maxLinks, maxChars),
        }),
      },
      run: async ({ link }) => {
        const page = cache.get(link) ?? (await open(link));
        followed.add(link);
        trail.push(page);
        return { state: slots(), summary: `opened the article "${page.title}"` };
      },
    }),
    defineTool({
      name: "go_back",
      description: "Goes back to the previous article of `state.trail`, because the current one leads nowhere useful.",
      available: (ctx) => (ctx.state.trail?.length ?? 0) > 1,
      run: () => {
        const left = trail.pop()!;
        abandoned.push(left.title);
        return { state: slots(), summary: `went back from "${left.title}" to "${here().title}"` };
      },
    }),
    defineTool({
      name: "end",
      description: "Stops, because the article in `state.page.title` is the article that `instructions` ask to reach.",
      run: () => ({ end: true, output: { title: here().title, trail: trail.map((p) => p.title) }, summary: "ended" }),
    }),
  ];

  return {
    tools,
    initialState: slots() as Record<string, Json>,
    /** Titles from the start to the article the agent is on. */
    trail: () => trail.map((p) => p.title),
    current: () => here(),
    /** Every article fetched so far. */
    pages: () => [...cache.values()],
  };
}
