/**
 * A coffee counter where the customer is a person (or a script).
 *
 *   ask_customer(question)   hold the loop and ask the customer one of the candidate questions; the reply lands in `state.user_reply`
 *   place_order(size)        once the customer has replied, place the order; the size is selected from the sizes on the menu
 *   end                      built in
 *
 * Jev cannot write the question, so the tool supplies candidate questions and the model selects one.
 */
import { defineTool, param, type AnyTool } from "../../src/index.js";

export const SIZES = ["small", "medium", "large"] as const;

export const QUESTIONS = {
  size: "What size would you like: small, medium or large?",
  name: "What name should I put on the order?",
  extras: "Would you like anything with your coffee?",
} as const;

export function createCoffee() {
  const orders: { size: string }[] = [];

  const tools: AnyTool[] = [
    defineTool({
      name: "ask_customer",
      description: "Asks the customer one question and waits for the reply, which is saved in `state.user_reply`. Use it for what the order still lacks.",
      params: {
        question: param.choice({
          question: "Which question should be asked next to take the order described in `instructions`, given what `state.user_reply` already says?",
          options: {
            [QUESTIONS.size]: "The size of the coffee is not known yet",
            [QUESTIONS.name]: "The name for the order is not known yet",
            [QUESTIONS.extras]: "The customer may want something to eat or drink with the coffee",
          },
        }),
      },
      available: (ctx) => ctx.state.order == null,
      run: async ({ question }, ctx) => {
        const reply = await ctx.input.ask(question);
        return { state: { user_reply: reply }, summary: `asked "${question}" and the customer replied` };
      },
    }),
    defineTool({
      name: "place_order",
      description: "Places the coffee order, once the customer has replied with the size they want.",
      params: {
        size: param.choice({
          question: "Which size did the customer ask for in `state.user_reply`?",
          options: {
            small: "The reply asks for a small coffee",
            medium: "The reply asks for a medium coffee",
            large: "The reply asks for a large coffee",
          },
        }),
      },
      available: (ctx) => ctx.state.user_reply != null && ctx.state.order == null,
      run: ({ size }) => {
        orders.push({ size });
        return { state: { order: { size, status: "placed" } }, summary: `placed an order for a ${size} coffee` };
      },
    }),
  ];

  return { tools, orders };
}
