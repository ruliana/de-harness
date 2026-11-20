/**
 * "Go to aloyoga.com, find a blue sweatshirt, select size large, and get the price", with Jev, on the real shop.
 *
 * The shop's responses are in tests/cassettes/storefront-http (trimmed to what the client reads) and Jev's answers in
 * tests/cassettes/storefront, so `npm test` is deterministic, keyless and offline. `npm run test:live` goes to the live
 * shop and live Jev again, five times, and prints how many of the runs found a correct answer; its recordings replace the old.
 *
 * Correct means: the run ended on a product page in a blue colour that is a sweatshirt-like garment, size L selected, and the
 * price it reports is the one the shop itself lists for that colour and size (read again by the test, not trusted from the run).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { cassetteMode, createAgent, type RunResult } from "../../../src/index.js";
import { createStorefront } from "../../../examples/storefront/client.js";
import { storefrontFetch } from "../../../examples/storefront/http.js";
import { SHOPPING_TASK, createStorefrontTools } from "../../../examples/storefront/storefront.js";
import { jevFor } from "../../support/models.js";

const live = cassetteMode() !== "replay";
const RUNS = live ? 5 : 1;
const MAX_STEPS = 10;
const timeout = live ? 10 * 60_000 : 60_000;

/** Words that make a colour name a blue one. The test's own judgment; the agent's judgment comes from Jev. */
const BLUE = /blue|navy|azure|cobalt|indigo|denim|sapphire|cerulean|bluestone|provence|moonshadow/i;
const SWEATSHIRT = /sweatshirt|pullover|crew|hoodie|fleece/i;

type Found = { product: string; url: string; colour: string | null; size: string | null; price: string; currency: string; inStock: boolean };
type Outcome = { result: RunResult; found: Found | null; trail: string[]; requests: string[]; verified: { price: string; colour: string | null } | null; correct: boolean };

const outcomes: Outcome[] = [];

async function shop(): Promise<Outcome> {
  const requests: string[] = [];
  const inner = storefrontFetch({ dir: "tests/cassettes/storefront-http" });
  const http: typeof fetch = (input, init) => {
    requests.push(`${init?.method ?? "GET"} ${typeof input === "string" ? input : input instanceof URL ? input.href : input.url}`);
    return inner(input, init);
  };
  const tools = await createStorefrontTools({ fetch: http });
  const result = await createAgent({ model: jevFor("storefront"), instructions: SHOPPING_TASK, tools: tools.tools, initialState: tools.initialState, maxSteps: MAX_STEPS }).run();
  const found = result.status === "ended" ? (result.output as Found | null) : null;

  let verified: Outcome["verified"] = null;
  if (found) {
    const product = await createStorefront({ fetch: inner }).product(found.url.split("/products/")[1]!);
    const variant = product.variants.find((v) => v.size === found.size && v.colour === found.colour);
    if (variant) verified = { price: variant.price, colour: variant.colour };
  }
  const correct = !!found && !!verified && found.size === "L" && BLUE.test(found.colour ?? "") && SWEATSHIRT.test(found.product) && found.price === verified.price;
  return { result, found, trail: tools.trail(), requests, verified, correct };
}

describe("storefront: a blue sweatshirt in large, and its price", () => {
  beforeAll(async () => {
    for (let i = 0; i < RUNS; i++) outcomes.push(await shop());
  }, timeout * RUNS);

  it("ends within the step limit without an error", () => {
    for (const o of outcomes) {
      expect(o.result.error?.message, "the run failed").toBeUndefined();
      expect(o.result.status).toBe("ended");
      expect(o.result.steps.length).toBeLessThanOrEqual(MAX_STEPS);
    }
  });

  it("finds a blue sweatshirt, size L, with the price the shop lists for it", () => {
    const first = outcomes[0]!;
    expect(first.found, `trail: ${first.trail.join(" > ")}`).not.toBeNull();
    expect(first.found!.size).toBe("L");
    expect(first.found!.colour).toMatch(BLUE);
    expect(first.found!.product).toMatch(SWEATSHIRT);
    expect(first.verified, "the shop does not list that colour and size").not.toBeNull();
    expect(first.found!.price).toBe(first.verified!.price);
    expect(Number(first.found!.price)).toBeGreaterThan(0);
    expect(first.found!.currency).toBe("USD");
  });

  it("is reliable: every replayed run is correct, and at least four of five live ones", () => {
    const correct = outcomes.filter((o) => o.correct).length;
    if (live) {
      const lines = outcomes.map((o) => `${o.correct ? "ok  " : "MISS"} ${o.result.steps.length} steps: ${o.found ? `${o.found.product}, ${o.found.colour}, ${o.found.size}, ${o.found.currency} ${o.found.price}${o.found.inStock ? "" : " (sold out)"}` : "nothing found"}   [${o.trail.join(" > ")}]`);
      console.log(`\nStorefront live summary: ${correct} of ${RUNS} runs correct\n${lines.join("\n")}`);
    }
    expect(correct).toBeGreaterThanOrEqual(live ? 4 : RUNS);
  });

  it("only reads: no write, no cart, no checkout, and nothing beyond the shop's home page, one collection and one product", () => {
    for (const o of outcomes) {
      expect(o.requests.every((r) => r.startsWith("GET "))).toBe(true);
      expect(o.requests.filter((r) => /cart|checkout|account|orders/.test(r))).toEqual([]);
      expect(o.requests.filter((r) => r.includes("/products/") && r.endsWith(".js")).length).toBeLessThanOrEqual(2);
    }
  });
});
