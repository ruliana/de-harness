/**
 * A pizza order, to show the extended parameters:
 *
 *   place_order(size, toppings, delivery_time?)
 *     size           a Choice between the sizes on the menu
 *     toppings       a set: one yes / no question per topping on the menu, the typed value is the toppings asked for
 *     delivery_time  optional: only given when the order says when to deliver, and then one of the menu's slots
 *   end              built in
 *
 * The order is placed once; afterwards only `end` is available.
 */
import { defineTool, param, type AnyTool } from "../../src/index.js";

export const menu = {
  sizes: ["small", "medium", "large"],
  toppings: ["mushrooms", "olives", "pepperoni", "onions", "peppers", "basil"],
  delivery_slots: {
    morning: "before 11am",
    lunch: "from 11am to 2pm",
    afternoon: "from 2pm to 5pm",
    evening: "from 5pm to 9pm",
    late: "after 9pm",
  },
};

export type Order = { size: string; toppings: string[]; delivery_time?: string };

export function createPizza() {
  const orders: Order[] = [];

  const placeOrder = defineTool({
    name: "place_order",
    description: "Places the pizza order that `instructions` ask for, with its size, its toppings and, when stated, its delivery time.",
    params: {
      size: param.choice({
        question: "Which size from `state.menu.sizes` do `instructions` order?",
        options: menu.sizes,
      }),
      toppings: param.set({
        question: "Do `instructions` ask for {} on the pizza?",
        members: menu.toppings,
      }),
      delivery_time: param.choice({
        question: "Which delivery slot from `state.menu.delivery_slots` do `instructions` ask for?",
        options: menu.delivery_slots,
        optional: { stated: "Do `instructions` say when the pizza should be delivered?" },
      }),
    },
    available: (ctx) => ctx.state.order == null,
    run: ({ size, toppings, delivery_time }) => {
      const order: Order = { size, toppings, ...(delivery_time ? { delivery_time } : {}) };
      orders.push(order);
      return { state: { order }, summary: `ordered a ${size} pizza with ${toppings.length ? toppings.join(" and ") : "no toppings"}${delivery_time ? `, delivered in the ${delivery_time}` : ""}` };
    },
  });

  const tools: AnyTool[] = [placeOrder];
  return { tools, initialState: { menu }, orders };
}
