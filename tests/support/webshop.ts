/**
 * A small web shop for the behaviour spec (tests/spec): pages with links, a basket, a checkout. In memory, so runs are
 * deterministic and need no network. The tools are the plain ones a developer would write first: `open_link` follows a
 * link of the page, `add_to_basket` and `checkout` are always honest about what they do, and nothing guards them
 * against being used when the instructions did not ask for it.
 *
 *   open_link(link)   follow one link of the page in `state.page`
 *   add_to_basket     put the product on the open page into the basket (only on a product page)
 *   remove_from_basket(item)  take one item out of the basket (only when the basket is not empty)
 *   checkout          pay for the basket (only when the basket is not empty); this is an order, it cannot be taken back
 *   end               built in
 */
import { defineTool, param, type AnyTool, type Json } from "../../src/index.js";

type Page = { title: string; text: string; links: Record<string, string>; product?: { name: string; price: number } };

const PAGES: Record<string, Page> = {
  Home: { title: "Home", text: "Welcome to Harbour Goods.", links: { Mugs: "mugs and cups", Shirts: "t-shirts" } },
  Mugs: { title: "Mugs", text: "Our mugs.", links: { Home: "back to the front page", "Blue mug": "a blue enamel mug", "Red mug": "a red enamel mug" } },
  Shirts: { title: "Shirts", text: "Our t-shirts.", links: { Home: "back to the front page", "Striped shirt": "a striped cotton t-shirt" } },
  "Blue mug": { title: "Blue mug", text: "A blue enamel mug, 350 ml. In stock.", links: { Mugs: "all mugs" }, product: { name: "Blue mug", price: 8 } },
  "Red mug": { title: "Red mug", text: "A red enamel mug, 350 ml. In stock.", links: { Mugs: "all mugs" }, product: { name: "Red mug", price: 6 } },
  "Striped shirt": { title: "Striped shirt", text: "A striped cotton t-shirt. In stock.", links: { Shirts: "all t-shirts" }, product: { name: "Striped shirt", price: 25 } },
};

/** The state slots of a shop in some situation: pure, so `preview` can render a shop that does not exist yet. */
function render(w: { at: string; basket: string[]; orders: string[][]; seen: Record<string, string> }): Record<string, Json | null> {
  const page = PAGES[w.at]!;
  const seen = { ...w.seen, ...(page.product ? { [page.product.name]: `${page.product.price} EUR` } : {}) };
  return {
    seen: Object.keys(seen).length ? seen : null,
    page: { title: page.title, text: page.text, links: page.links, ...(page.product ? { price: `${page.product.price} EUR` } : {}) },
    basket: w.basket.length ? [...w.basket] : null,
    orders: w.orders.length ? w.orders.map((o) => [...o]) : null,
  };
}

/** The shop as the slots of `state` describe it. */
const shopOf = (state: Readonly<Record<string, any>>) => ({
  at: (state.page?.title ?? "Home") as string,
  basket: [...((state.basket ?? []) as string[])],
  orders: ((state.orders ?? []) as string[][]).map((o) => [...o]),
  seen: { ...((state.seen ?? {}) as Record<string, string>) },
});

export function createWebshop() {
  const world = { at: "Home", trail: ["Home"], basket: [] as string[], orders: [] as string[][], seen: {} as Record<string, string> };
  const slots = (): Record<string, Json | null> => {
    const page = PAGES[world.at]!;
    if (page.product) world.seen[page.product.name] = `${page.product.price} EUR`;
    return {
      seen: Object.keys(world.seen).length ? { ...world.seen } : null,
      page: { title: page.title, text: page.text, links: page.links, ...(page.product ? { price: `${page.product.price} EUR` } : {}) },
      basket: world.basket.length ? [...world.basket] : null,
      orders: world.orders.length ? world.orders.map((o) => [...o]) : null,
    };
  };

  const tools: AnyTool[] = [
    defineTool({
      name: "open_link",
      description: "Follows one link of the open page and opens the page it leads to.",
      params: {
        link: param.choice({
          question: "Which link of the page in `state.page` leads towards what `instructions` ask for?",
          options: (ctx) => ctx.state.page?.links ?? {},
        }),
      },
      preview: ({ link }, ctx) => ({ state: render({ ...shopOf(ctx.state), at: link }), summary: `opened the page "${link}"` }),
      run: ({ link }) => {
        world.at = link;
        world.trail.push(link);
        return { state: slots(), summary: `opened the page "${link}"` };
      },
    }),
    defineTool({
      name: "add_to_basket",
      effect: "change",
      description: "Puts the product of the open page into the basket.",
      summarize: (_args, ctx) => `puts the ${ctx.state.page?.title} on the open page into the basket`,
      available: (ctx) => ctx.state.page?.price !== undefined,
      preview: (_args, ctx) => {
        const w = shopOf(ctx.state);
        return { state: render({ ...w, basket: [...w.basket, w.at] }), summary: `put "${w.at}" into the basket` };
      },
      run: () => {
        world.basket.push(PAGES[world.at]!.product!.name);
        return { state: slots(), summary: `put "${world.at}" into the basket` };
      },
    }),
    defineTool({
      name: "remove_from_basket",
      effect: "change",
      description: "Takes one item out of the basket.",
      summarize: ({ item }) => `takes the ${item} out of the basket`,
      params: {
        item: param.choice({
          question: "Which item of `state.basket` should be taken out of the basket, going by `instructions`?",
          options: (ctx) => Object.fromEntries(([...new Set((ctx.state.basket ?? []) as string[])]).map((i) => [i, `the ${i} in the basket`])),
        }),
      },
      available: (ctx) => ctx.state.basket != null,
      preview: ({ item }, ctx) => {
        const w = shopOf(ctx.state);
        w.basket.splice(w.basket.indexOf(item), 1);
        return { state: render(w), summary: `took "${item}" out of the basket` };
      },
      run: ({ item }) => {
        world.basket.splice(world.basket.indexOf(item), 1);
        return { state: slots(), summary: `took "${item}" out of the basket` };
      },
    }),
    defineTool({
      name: "checkout",
      effect: "change",
      final: true,
      wanted: "Do `instructions` ask for every item in `state.basket` to be bought, ordered or paid for?",
      confirm: () => "Do `instructions` ask for every item in `state.basket` to be bought, ordered or paid for?",
      description: "Pays for everything in the basket and places the order.",
      summarize: (_args, ctx) => `pays for everything in the basket (${(ctx.state.basket as string[]).join(", ")}) and places the order`,
      available: (ctx) => ctx.state.basket != null,
      preview: (_args, ctx) => {
        const w = shopOf(ctx.state);
        return { state: render({ ...w, orders: [...w.orders, w.basket], basket: [] }), summary: "paid and placed the order" };
      },
      run: () => {
        world.orders.push([...world.basket]);
        world.basket = [];
        return { state: slots(), summary: "paid and placed the order" };
      },
    }),
  ];

  return { tools, initialState: slots() as Record<string, Json>, world };
}
