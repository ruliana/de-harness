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

export function createWebshop() {
  const world = { at: "Home", trail: ["Home"], basket: [] as string[], orders: [] as string[][] };
  const slots = (): Record<string, Json | null> => {
    const page = PAGES[world.at]!;
    return {
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
      run: ({ link }) => {
        world.at = link;
        world.trail.push(link);
        return { state: slots(), summary: `opened the page "${link}"` };
      },
    }),
    defineTool({
      name: "add_to_basket",
      description: "Puts the product of the open page into the basket.",
      available: (ctx) => ctx.state.page?.price !== undefined,
      run: () => {
        world.basket.push(PAGES[world.at]!.product!.name);
        return { state: slots(), summary: `put "${world.at}" into the basket` };
      },
    }),
    defineTool({
      name: "remove_from_basket",
      description: "Takes one item out of the basket.",
      params: {
        item: param.choice({
          question: "Which item of `state.basket` should be taken out of the basket, going by `instructions`?",
          options: (ctx) => Object.fromEntries(([...new Set((ctx.state.basket ?? []) as string[])]).map((i) => [i, `the ${i} in the basket`])),
        }),
      },
      available: (ctx) => ctx.state.basket != null,
      run: ({ item }) => {
        world.basket.splice(world.basket.indexOf(item), 1);
        return { state: slots(), summary: `took "${item}" out of the basket` };
      },
    }),
    defineTool({
      name: "checkout",
      description: "Pays for everything in the basket and places the order.",
      available: (ctx) => ctx.state.basket != null,
      run: () => {
        world.orders.push([...world.basket]);
        world.basket = [];
        return { state: slots(), summary: "paid and placed the order" };
      },
    }),
  ];

  return { tools, initialState: slots() as Record<string, Json>, world };
}
