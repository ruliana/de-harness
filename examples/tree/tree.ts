/**
 * Navigating a tree: a product taxonomy of a few hundred categories, entered at the top.
 *
 *   descend(child)   go into one of the sub-categories of the current one (options come from the state)
 *   ascend           go back up to the parent category (only below the top)
 *   select           file the item under the current category and end the run (only below the top)
 *
 * The model only ever sees where it is (`state.location`): the path and the names of the sub-categories.
 * Which child to pick, when to back out and when to select are Jev's judgments; the walk itself is code.
 */
import { defineTool, param, type AnyTool, type Json } from "../../src/index.js";
import { formatPath, parseTaxonomy, type TaxonomyNode } from "./taxonomy.js";

export function createTree(opts: { root?: TaxonomyNode } = {}) {
  const root = opts.root ?? parseTaxonomy();
  const world = { at: root, visits: [root] as TaxonomyNode[] };

  const slots = (): Record<string, Json> => ({
    location: { path: formatPath(world.at.path), children: world.at.children.map((c) => c.name) },
  });

  const tools: AnyTool[] = [
    defineTool({
      name: "descend",
      description: "Goes into one of the sub-categories of the current category, to narrow down where the item belongs.",
      params: {
        child: param.choice({
          question: "Which of `state.location.children` is the best place to look for the item that `instructions` ask about?",
          options: (ctx) => ctx.state.location?.children ?? [],
        }),
      },
      available: (ctx) => (ctx.state.location?.children?.length ?? 0) > 0,
      run: ({ child }) => {
        const next = world.at.children.find((c) => c.name === child);
        if (!next) throw new Error(`There is no sub-category "${child}" in ${formatPath(world.at.path)}`);
        world.at = next;
        world.visits.push(next);
        return { state: slots(), summary: `went down into ${formatPath(next.path)}` };
      },
    }),
    defineTool({
      name: "ascend",
      description: "Goes back up to the parent of the current category, because the item does not belong in the current branch.",
      available: (ctx) => ctx.state.location?.path !== formatPath([]),
      run: () => {
        const parent = world.at.parent;
        if (!parent) throw new Error("Already at the top");
        const from = world.at;
        world.at = parent;
        world.visits.push(parent);
        return { state: slots(), summary: `went back up from ${formatPath(from.path)}` };
      },
    }),
    defineTool({
      name: "select",
      description: "Files the item that `instructions` ask about under the current category, because it is the most specific category that fits it.",
      available: (ctx) => ctx.state.location?.path !== formatPath([]),
      run: () => ({ end: true, output: { path: formatPath(world.at.path) }, summary: `selected ${formatPath(world.at.path)}` }),
    }),
  ];

  return { tools, initialState: slots(), world, root };
}
