/**
 * Shopping in an online store: find a product, pick its colour and size, read the price. Nothing is added to a cart.
 *
 *   open_collection(collection)  open a section of the shop menu (options: the menu, described by where it sits)
 *   filter_colour(colours)       keep only the products of the open collection in the colours the instructions want
 *                                (one Noul per colour of the collection; code keeps the colours above the yes threshold)
 *   open_product(product)        open one product of the open collection
 *   select_colour(colour)        only for a product sold in several colours
 *   select_size(size)            pick a size of the open product (sold out sizes are described as such)
 *   read_price                   read the price of the selected variant into `state.price`
 *   go_back                      return to the page before this one
 *   end                          stop: `state.price` is the price the instructions ask for
 *
 * State: `page`, `collection`, `product`, `selected`, `price`. Code, not the model, cuts option lists to the budget,
 * collects the colours of a collection, applies the colour filter and looks the price up.
 */
import { defineTool, param, type AnyTool, type Json } from "../../src/index.js";
import { createStorefront, type Listing, type MenuEntry, type Product, type StorefrontOptions } from "./client.js";

/** Every question the example asks, in one place. */
export const QUESTIONS = {
  collection: "Which of these sections of the shop is the best place to look for the item that `instructions` ask for?",
  colour: "Is {} a shade of the colour that `instructions` ask for?",
  product: "Which of these products of the open collection in `state.collection` is the item that `instructions` ask for?",
  selectColour: "Which colour of the product in `state.product` do `instructions` ask for?",
  size: "Which size of the product in `state.product` do `instructions` ask for?",
} as const;

export const instructionsFor = (what: string, size: string) => `Find ${what} in the shop, select size ${size}, and get the price. Stop once \`state.price\` shows the price of ${what} in size ${size}.`;
export const SHOPPING_TASK = instructionsFor("a blue sweatshirt", "large");

export type StorefrontToolsOptions = StorefrontOptions & {
  /** Most options offered in one list. Default 200 (a Choice takes at most 255). */
  maxOptions?: number;
  /** Most colours asked about at once. Default 80. */
  maxColours?: number;
};

type View =
  | { kind: "home" }
  | { kind: "collection"; entry: MenuEntry; listing: Listing[]; colours: string[] | null }
  | { kind: "product"; listing: Listing; product: Product; colour: string | null; size: string | null; price: string | null };

const tail = (type: string) => {
  const parts = type.split(":").filter(Boolean);
  return parts.length > 1 ? `${parts[0]}: ${parts[parts.length - 1]}` : type;
};

export async function createStorefrontTools(opts: StorefrontToolsOptions = {}) {
  const maxOptions = Math.min(opts.maxOptions ?? 200, 255);
  const maxColours = opts.maxColours ?? 80;
  const client = createStorefront(opts);
  const menu = await client.menu();
  const entries = new Map(menu.entries.map((e) => [e.handle, e]));

  const history: View[] = [{ kind: "home" }];
  const here = () => history[history.length - 1]!;
  const collectionView = () => {
    const v = here();
    return v.kind === "collection" ? v : null;
  };
  const productView = () => {
    const v = here();
    return v.kind === "product" ? v : null;
  };

  const sizesOf = (v: Extract<View, { kind: "product" }>) => {
    const sizes = new Map<string, boolean>();
    for (const variant of v.product.variants) {
      if (v.colour !== null && variant.colour !== v.colour) continue;
      if (variant.size !== null) sizes.set(variant.size, (sizes.get(variant.size) ?? false) || variant.available);
    }
    return sizes;
  };
  const coloursOf = (p: Product) => [...new Set(p.variants.map((v) => v.colour).filter((c): c is string => c !== null))];
  /** Products of the open collection that pass the colour filter. */
  const matching = (v: Extract<View, { kind: "collection" }>) => (v.colours ? v.listing.filter((l) => l.colours.some((c) => v.colours!.includes(c))) : v.listing);
  const productKeys = (v: Extract<View, { kind: "collection" }>) => {
    const keys = new Map<string, Listing>();
    for (const l of matching(v)) {
      if (keys.size >= maxOptions) break;
      keys.set(keys.has(l.title) ? `${l.title} (${l.handle})` : l.title, l);
    }
    return keys;
  };

  const slots = (): Record<string, Json | null> => {
    const v = here();
    return {
      page: v.kind,
      collection:
        v.kind === "collection"
          ? { section: `${v.entry.path} > ${v.entry.title}`, products: v.listing.length, colour_filter: v.colours ? [...v.colours] : null, products_matching: matching(v).length }
          : null,
      product: v.kind === "product" ? { title: v.product.title, type: tail(v.product.type), colours: coloursOf(v.product) } : null,
      selected: v.kind === "product" ? { colour: v.colour, size: v.size } : null,
      price: v.kind === "product" && v.price ? { amount: v.price, currency: menu.currency, product: v.product.title, colour: v.colour, size: v.size } : null,
    };
  };

  const tools: AnyTool[] = [
    defineTool({
      name: "open_collection",
      description: "Opens one section of the shop menu and lists its products.",
      params: {
        collection: param.choice({
          question: QUESTIONS.collection,
          options: () => Object.fromEntries(menu.entries.slice(0, maxOptions).map((e) => [e.handle, `${e.path ? `${e.path} > ` : ""}${e.title}`])),
        }),
      },
      run: async ({ collection }) => {
        const entry = entries.get(collection)!;
        const listing = await client.collection(entry.handle);
        history.push({ kind: "collection", entry, listing, colours: null });
        return { state: slots(), summary: `opened the collection "${entry.title}" (${listing.length} products)` };
      },
    }),
    defineTool({
      name: "filter_colour",
      description: "Keeps only the products of the open collection that come in a colour the instructions ask for.",
      available: () => collectionView() !== null && collectionView()!.colours === null,
      params: {
        colours: param.set({
          question: QUESTIONS.colour,
          members: () => {
            const count = new Map<string, number>();
            for (const l of collectionView()?.listing ?? []) for (const c of l.colours) count.set(c, (count.get(c) ?? 0) + 1);
            return [...count].sort((a, b) => b[1] - a[1]).slice(0, maxColours).map(([c]) => c);
          },
        }),
      },
      run: ({ colours }) => {
        const v = collectionView()!;
        if (colours.length === 0) return { summary: "no colour of this collection is a colour the instructions ask for" };
        v.colours = colours;
        return { state: slots(), summary: `kept the colours ${colours.join(", ")} (${matching(v).length} of ${v.listing.length} products)` };
      },
    }),
    defineTool({
      name: "open_product",
      description: "Opens one product of the open collection.",
      available: () => collectionView() !== null && matching(collectionView()!).length > 0,
      params: {
        product: param.choice({
          question: QUESTIONS.product,
          options: () => Object.fromEntries([...productKeys(collectionView()!)].map(([key, l]) => [key, `${tail(l.type)}, colour ${l.colours.join(" / ") || "unspecified"}`])),
        }),
      },
      run: async ({ product }) => {
        const listing = productKeys(collectionView()!).get(product)!;
        const p = await client.product(listing.handle);
        const colours = coloursOf(p);
        history.push({ kind: "product", listing, product: p, colour: colours.length === 1 ? colours[0]! : null, size: null, price: null });
        return { state: slots(), summary: `opened the product "${p.title}"` };
      },
    }),
    defineTool({
      name: "select_colour",
      description: "Selects one of the colours the open product is sold in.",
      available: () => productView() !== null && productView()!.colour === null,
      params: {
        colour: param.choice({ question: QUESTIONS.selectColour, options: () => coloursOf(productView()!.product) }),
      },
      run: ({ colour }) => {
        const v = productView()!;
        v.colour = colour;
        return { state: slots(), summary: `selected the colour ${colour}` };
      },
    }),
    defineTool({
      name: "select_size",
      description: "Selects one size of the open product.",
      available: () => productView() !== null && (productView()!.colour !== null || coloursOf(productView()!.product).length === 0),
      params: {
        size: param.choice({
          question: QUESTIONS.size,
          options: () => Object.fromEntries([...sizesOf(productView()!)].map(([size, inStock]) => [size, inStock ? "in stock" : "sold out"])),
        }),
      },
      run: ({ size }) => {
        const v = productView()!;
        v.size = size;
        v.price = null;
        return { state: slots(), summary: `selected size ${size}` };
      },
    }),
    defineTool({
      name: "read_price",
      description: "Reads the price of the open product in the selected colour and size into `state.price`.",
      available: () => productView() !== null && productView()!.size !== null,
      run: () => {
        const v = productView()!;
        const variant = v.product.variants.find((x) => x.size === v.size && (v.colour === null || x.colour === v.colour));
        if (!variant) throw new Error(`there is no variant of "${v.product.title}" in size ${v.size}`);
        v.price = variant.price;
        return { state: slots(), summary: `the price is ${menu.currency} ${variant.price}${variant.available ? "" : " (sold out)"}` };
      },
    }),
    defineTool({
      name: "go_back",
      description: "Goes back to the page before this one, because this page leads nowhere useful.",
      available: () => history.length > 1,
      run: () => {
        history.pop();
        return { state: slots(), summary: `went back to the ${here().kind} page` };
      },
    }),
    defineTool({
      name: "end",
      description: "Stops, because `state.price` shows the price that `instructions` ask for.",
      run: () => ({ end: true, output: found(), summary: "ended" }),
    }),
  ];

  /** What the run found, from the page the agent ended on. */
  const found = () => {
    const v = productView();
    const variant = v?.price ? v.product.variants.find((x) => x.size === v.size && (v.colour === null || x.colour === v.colour)) : undefined;
    return v && variant
      ? { product: v.product.title, url: v.product.url, colour: v.colour, size: v.size, price: variant.price, currency: menu.currency, inStock: variant.available }
      : null;
  };

  return {
    tools,
    initialState: slots() as Record<string, Json>,
    menu: menu.entries,
    /** The result of the shopping so far: null until a price has been read on a product page. */
    found,
    /** Pages visited, newest last. */
    trail: () => history.map((v) => (v.kind === "home" ? "home" : v.kind === "collection" ? `collection:${v.entry.handle}` : `product:${v.product.handle}`)),
  };
}
