/**
 * Behaviour, failure mode 2: TOO LITERAL. The intent of the instructions is obvious and the agent must carry it out, not
 * stop at the letter.
 *
 * Without `review` Jev fails all of them: it ends when the last thing it did matches a phrase of the instructions
 * ("through Museum", "buy"), does the first half of a task and ends, compares options and does not act on the comparison,
 * and does the steps in the order written even when an earlier step makes a later one impossible. With `review.end` it does
 * not end while something doable is left (a tool can say, in its own words, what that looks like: `wanted`), and with
 * `review.actions` a `final` tool waits until the other parts are done.
 *
 * Jev's answers are recorded in tests/cassettes/behaviour.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { runPlainDesk, runShop, runTransit, type ShopRun, type TicketRun, type TransitRun } from "./support.js";

const log = (name: string, summary: string) => console.log(`  [behaviour] ${name}: ${summary}`);

describe("too literal: a route 'through' a station", () => {
  let run: TransitRun;
  beforeAll(async () => {
    run = await runTransit("Airport", "You are at Airport station. Get to Southpark station by a route through Museum, then stop.");
    log("to Southpark through Museum", run.summary);
  });

  it("ends at Southpark, not at Museum, the station the route passes through", () => {
    expect(run.path.at(-1), `rode ${run.path.join(" > ")}`).toBe("Southpark");
    expect(run.path).toContain("Museum");
  });
});

describe("too literal: 'buy' means pay", () => {
  let run: ShopRun;
  beforeAll(async () => {
    run = await runShop("Buy the red mug and the blue mug.");
    log("buy both mugs", run.summary);
  });

  it("pays for both mugs: they are not left sitting in the basket", () => {
    expect(run.orders.flat().sort(), `basket was [${run.basket.join(", ")}] when the agent ended`).toEqual(["Blue mug", "Red mug"]);
  });
});

describe("too literal: a task with two parts", () => {
  let run: ShopRun;
  beforeAll(async () => {
    run = await runShop("Order the striped shirt and the blue mug.");
    log("order the shirt and the mug", run.summary);
  });

  it("orders both, not just the first one it finds", () => {
    expect(run.orders.flat().sort(), `trail ${run.trail.join(" > ")}; basket [${run.basket.join(", ")}]`).toEqual(["Blue mug", "Striped shirt"]);
  });
});

describe("too literal: compares the options, then does not act on the comparison", () => {
  let basket: ShopRun;
  let order: ShopRun;
  beforeAll(async () => {
    basket = await runShop("Put the cheaper of the two mugs in the basket.");
    log("cheaper mug into the basket", basket.summary);
    order = await runShop("Order the cheaper of the two mugs.");
    log("order the cheaper mug", order.summary);
  });

  it("puts the red mug (6 EUR, against 8 EUR for the blue one) in the basket", () => {
    expect(basket.basket, `looked at ${basket.trail.join(" > ")} and then ended`).toEqual(["Red mug"]);
  });

  it("orders the red mug", () => {
    expect(order.orders, `looked at ${order.trail.join(" > ")}; ${order.result.status}`).toEqual([["Red mug"]]);
  });
});

describe("too literal: steps in the order written when the first makes the second impossible", () => {
  let run: TicketRun;
  beforeAll(async () => {
    // the API refuses to reassign a closed ticket (409), so the obvious order is assign, then close
    run = await runPlainDesk("Close ticket 7 and assign it to the technical team.");
    log("close then assign", run.summary);
  });

  it("ends with ticket 7 both closed and assigned to technical", () => {
    expect(run.changes.sort()).toEqual(["#7 status closed", "#7 team technical"]);
  });
});

describe("too literal: a name the tools do not use for what the instructions plainly mean", () => {
  let run: TicketRun;
  beforeAll(async () => {
    // there is no money team: billing is the team that handles charges
    run = await runPlainDesk("Send the ticket about being charged twice to the money team.");
    log("to the money team", run.summary);
  });

  it("sends ticket 1 to billing and stops", () => {
    expect(run.changes, run.summary).toEqual(["#1 team billing"]);
    expect(run.result.status).toBe("ended");
    expect(run.result.steps.length).toBeLessThanOrEqual(4);
  });
});
