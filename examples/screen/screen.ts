/**
 * A screen the agent can only see as an image. Boxes are the model's way of pointing at it.
 *
 *   click(target)   target = the box around the element `instructions` say to click, or null when it is not on the screen
 *   end             built in
 *
 * The world is a sign-up form (`fixtures/form.png`). Clicking inside its Submit button shows `fixtures/done.png`.
 */
import { join } from "node:path";
import { defineTool, imageFile, param, type AnyTool, type Json } from "../../src/index.js";
import { SIZE, SUBMIT_BUTTON, fixturesDir } from "./render.js";

export type Click = { x: number; y: number };

export function createScreen() {
  const world = { page: "form" as "form" | "done", clicks: [] as Click[] };
  const slots = (): Record<string, Json> => ({ screen: imageFile(join(fixturesDir, world.page === "form" ? "form.png" : "done.png")) });

  const tools: AnyTool[] = [
    defineTool({
      name: "click",
      description: "Clicks one element of the screen, which is the picture in `state.screen`.",
      params: {
        target: param.box({
          question: "the element that `instructions` say to click, in `state.screen`",
          image: "state.screen",
          present: "Is the element that `instructions` say to click visible in `state.screen`?",
        }),
      },
      run: ({ target }) => {
        if (!target) return { summary: "found nothing to click: the element is not on the screen" };
        const click = { x: Math.round(((target.left + target.right) / 2) * SIZE.width), y: Math.round(((target.top + target.bottom) / 2) * SIZE.height) };
        world.clicks.push(click);
        const b = SUBMIT_BUTTON;
        if (world.page === "form" && click.x >= b.left && click.x < b.right && click.y >= b.top && click.y < b.bottom) {
          world.page = "done";
          return { state: slots(), summary: `clicked at (${click.x}, ${click.y}) and the page changed` };
        }
        return { summary: `clicked at (${click.x}, ${click.y}) and nothing happened` };
      },
    }),
  ];

  return { tools, initialState: slots(), world };
}
