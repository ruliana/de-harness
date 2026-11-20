/**
 * Storefront mechanics, forced with ScriptedModel against a Shopify look-alike on loopback. Still end to end:
 * createAgent(...).run() with the example's real client, http layer, parser and tools.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedModel, TOOL_QUESTION, createAgent } from "../../../src/index.js";
import { storefrontFetch } from "../../../examples/storefront/http.js";
import { SHOPPING_TASK, createStorefrontTools } from "../../../examples/storefront/storefront.js";
import { startFakeShop, type FakeCollection, type FakeProduct, type FakeShop } from "../../support/shop-site.js";

const sizes = (price: number, soldOut: string[] = []) => ["S", "M", "L", "XL"].map((size) => ({ size, price, available: !soldOut.includes(size) }));
const crew = (colour: string, price = 118) => ({ colour, ...sizes(price)[0]! });

const products: FakeProduct[] = [
  { handle: "crew-navy", title: "Crew - Navy", type: "Women:Outerwear:Coverups:Pullovers", variants: sizes(118).map((v) => ({ ...v, colour: "Navy" })) },
  { handle: "hoodie-azure", title: "Hoodie - Azure Blue", type: "Women:Outerwear:Coverups:Hoodies", variants: sizes(148, ["L"]).map((v) => ({ ...v, colour: "Azure Blue" })) },
  { handle: "hoodie-bone", title: "Hoodie - Bone", type: "Women:Outerwear:Coverups:Hoodies", variants: sizes(148).map((v) => ({ ...v, colour: "Bone" })) },
  { handle: "crew-two-colours", title: "Crew Duo", type: "Women:Outerwear:Coverups:Pullovers", variants: [...sizes(98).map((v) => ({ ...v, colour: "Black" })), ...sizes(108).map((v) => ({ ...v, colour: "Cobalt" }))] },
  { handle: "plain-tee", title: "Tee", type: "Women:Tops:Tees", variants: ["S", "M"].map((size) => ({ size, price: 48 })) }, // no colour option at all
  ...Array.from({ length: 300 }, (_, i): FakeProduct => ({ handle: `many-${i}`, title: `Many ${i}`, type: "Women:Tops:Tees", variants: sizes(20 + i).map((v) => ({ ...v, colour: `Colour ${i % 7}` })) })),
];
const collections: FakeCollection[] = [
  { handle: "sweatshirts", title: "Sweatshirts & Hoodies", section: "women", group: "Clothing", products: ["crew-navy", "hoodie-azure", "hoodie-bone", "crew-two-colours"] },
  { handle: "mens-sweatshirts", title: "Sweatshirts & Hoodies", section: "men", group: "Clothing", products: ["hoodie-bone"] },
  { handle: "tees", title: "Tees", section: "women", group: "Tops", products: ["plain-tee"] },
  { handle: "everything", title: "Everything", section: "women", group: "Clothing", products: products.filter((p) => p.handle.startsWith("many-")).map((p) => p.handle) },
];

let shop: FakeShop;
beforeAll(async () => {
  shop = await startFakeShop({ collections, products });
});
afterAll(() => shop.close());

const criteria = (model: ScriptedModel, request: number, question: string) => (model.requests[request]!.questions[question] as { criteria: Record<string, string> }).criteria;
const toolsOf = (model: ScriptedModel, request: number) => Object.keys(criteria(model, request, TOOL_QUESTION));

type Script = ConstructorParameters<typeof ScriptedModel>[0];

async function run(script: Script, opts: { maxOptions?: number; maxColours?: number } = {}) {
  const tools = await createStorefrontTools({ baseUrl: shop.baseUrl, fetch: storefrontFetch({ dir: "unused", mode: "passthrough" }), ...opts });
  const model = new ScriptedModel(script);
  const result = await createAgent({ model, instructions: SHOPPING_TASK, tools: tools.tools, initialState: tools.initialState, maxSteps: 8 }).run();
  return { tools, model, result };
}

const colourAnswers = (...yes: string[]) => Object.fromEntries(yes.map((c) => [`filter_colour.colours[${c}]`, 0.95]));

describe("storefront: what the agent is offered", () => {
  it("starts on the home page offering the menu, with where each entry sits, and only the tools that make sense there", async () => {
    const { model, tools } = await run([{ [TOOL_QUESTION]: "end" }]);
    expect(toolsOf(model, 0).sort()).toEqual(["end", "open_collection"]);
    const options = criteria(model, 0, "open_collection.collection");
    expect(Object.keys(options).sort()).toEqual(["everything", "mens-sweatshirts", "sweatshirts", "tees"]); // not "About us": it is not a collection
    expect(options["sweatshirts"]).toBe("Women > Clothing > Sweatshirts & Hoodies");
    expect(options["mens-sweatshirts"]).toBe("Men > Clothing > Sweatshirts & Hoodies");
    expect(tools.found()).toBeNull();
  });

  it("asks one yes/no question per colour of the open collection, and offers products only once something is open", async () => {
    const { model } = await run([{ [TOOL_QUESTION]: "open_collection", "open_collection.collection": "sweatshirts" }, { [TOOL_QUESTION]: "end" }]);
    const second = model.requests[1]!.questions;
    const colourQuestions = Object.keys(second).filter((q) => q.startsWith("filter_colour.colours["));
    expect(colourQuestions.sort()).toEqual(["Azure Blue", "Black", "Bone", "Cobalt", "Navy"].map((c) => `filter_colour.colours[${c}]`));
    expect(toolsOf(model, 1).sort()).toEqual(["end", "filter_colour", "go_back", "open_collection", "open_product"]);
  });

  it("keeps the products of the colours code accepts, and describes them by type and colour", async () => {
    const { model, tools } = await run([
      { [TOOL_QUESTION]: "open_collection", "open_collection.collection": "sweatshirts" },
      { [TOOL_QUESTION]: "filter_colour", ...colourAnswers("Navy", "Azure Blue", "Cobalt") },
      { [TOOL_QUESTION]: "end" },
    ]);
    const options = criteria(model, 2, "open_product.product");
    expect(Object.keys(options).sort()).toEqual(["Crew - Navy", "Crew Duo", "Hoodie - Azure Blue"]);
    expect(options["Crew - Navy"]).toBe("Women: Pullovers, colour Navy");
    expect(options["Crew Duo"]).toContain("Black / Cobalt");
    expect(tools.trail()).toEqual(["home", "collection:sweatshirts"]);
  });

  it("a colour that no question accepts leaves the collection as it was", async () => {
    const { model } = await run([
      { [TOOL_QUESTION]: "open_collection", "open_collection.collection": "sweatshirts" },
      { [TOOL_QUESTION]: "filter_colour", ...colourAnswers() },
      { [TOOL_QUESTION]: "end" },
    ]);
    expect(Object.keys(criteria(model, 2, "open_product.product"))).toHaveLength(4);
    expect(toolsOf(model, 2)).toContain("filter_colour");
  });

  it("cuts long lists to the budget in code: colours asked about and products offered", async () => {
    const { model } = await run(
      [{ [TOOL_QUESTION]: "open_collection", "open_collection.collection": "everything" }, { [TOOL_QUESTION]: "end" }],
      { maxOptions: 120, maxColours: 5 },
    );
    expect(Object.keys(criteria(model, 1, "open_product.product"))).toHaveLength(120);
    expect(Object.keys(model.requests[1]!.questions).filter((q) => q.startsWith("filter_colour.colours["))).toHaveLength(5);
  });
});

describe("storefront: shopping to the price", () => {
  const to = (product: string): Script => [
    { [TOOL_QUESTION]: "open_collection", "open_collection.collection": "sweatshirts" },
    { [TOOL_QUESTION]: "open_product", "open_product.product": product },
  ];

  it("selects the size and reads the price of that variant, and ends with what it found", async () => {
    const { result, tools, model } = await run([...to("Crew - Navy"), { [TOOL_QUESTION]: "select_size", "select_size.size": "L" }, { [TOOL_QUESTION]: "read_price" }, { [TOOL_QUESTION]: "end" }]);
    expect(result.status).toBe("ended");
    expect(result.output).toEqual({ product: "Crew - Navy", url: `${shop.baseUrl}/products/crew-navy`, colour: "Navy", size: "L", price: "118.00", currency: "USD", inStock: true });
    expect(tools.found()).toEqual(result.output);
    expect(toolsOf(model, 2).sort()).toEqual(["end", "go_back", "open_collection", "select_size"]); // no read_price before a size is selected, no select_colour for one colour
    const state = (model.requests[4]!.state as { state: Record<string, any> }).state;
    expect(state.price).toEqual({ amount: "118.00", currency: "USD", product: "Crew - Navy", colour: "Navy", size: "L" });
  });

  it("describes sizes as in stock or sold out, and still reports a sold out size as such", async () => {
    const { model, result } = await run([...to("Hoodie - Azure Blue"), { [TOOL_QUESTION]: "select_size", "select_size.size": "L" }, { [TOOL_QUESTION]: "read_price" }, { [TOOL_QUESTION]: "end" }]);
    expect(criteria(model, 2, "select_size.size")).toEqual({ S: "in stock", M: "in stock", L: "sold out", XL: "in stock" });
    expect(result.output).toMatchObject({ product: "Hoodie - Azure Blue", size: "L", price: "148.00", inStock: false });
  });

  it("a product sold in two colours needs select_colour first, and the price follows the colour", async () => {
    const { model, result } = await run([
      ...to("Crew Duo"),
      { [TOOL_QUESTION]: "select_colour", "select_colour.colour": "Cobalt" },
      { [TOOL_QUESTION]: "select_size", "select_size.size": "M" },
      { [TOOL_QUESTION]: "read_price" },
      { [TOOL_QUESTION]: "end" },
    ]);
    expect(toolsOf(model, 2)).toContain("select_colour");
    expect(toolsOf(model, 2)).not.toContain("select_size");
    expect(result.output).toMatchObject({ colour: "Cobalt", size: "M", price: "108.00" });
  });

  it("a product without a colour option can still be sized and priced", async () => {
    const { result } = await run([
      { [TOOL_QUESTION]: "open_collection", "open_collection.collection": "tees" },
      { [TOOL_QUESTION]: "open_product", "open_product.product": "Tee" },
      { [TOOL_QUESTION]: "select_size", "select_size.size": "M" },
      { [TOOL_QUESTION]: "read_price" },
      { [TOOL_QUESTION]: "end" },
    ]);
    expect(result.output).toMatchObject({ product: "Tee", colour: null, size: "M", price: "48.00" });
  });

  it("go_back returns to the collection, and ending without a price finds nothing", async () => {
    const { tools, result, model } = await run([...to("Crew - Navy"), { [TOOL_QUESTION]: "go_back" }, { [TOOL_QUESTION]: "end" }]);
    expect(tools.trail()).toEqual(["home", "collection:sweatshirts"]);
    expect(Object.keys(criteria(model, 3, "open_product.product"))).toHaveLength(4);
    expect(result.output).toBeNull();
  });

  it("only reads: GET requests for the home page, collections and products, identified as an agent, never the cart or checkout", async () => {
    await run([...to("Crew - Navy"), { [TOOL_QUESTION]: "select_size", "select_size.size": "M" }, { [TOOL_QUESTION]: "read_price" }, { [TOOL_QUESTION]: "end" }]);
    expect(shop.requests.length).toBeGreaterThan(0);
    for (const r of shop.requests) {
      expect(r).toMatch(/^GET \/($|collections\/[^/]+\/products\.json|products\/[^/]+\.js)/);
      expect(r).not.toMatch(/cart|checkout/);
    }
    expect([...shop.userAgents].every((ua) => /de-harness-example/.test(ua) && /agent-initiated/.test(ua))).toBe(true);
  });
});
