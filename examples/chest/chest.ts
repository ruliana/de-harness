/**
 * A tiny domain for dynamic tools: a locked chest and a key on the floor.
 *
 *   pick_up_key   only tool at the start (besides the built-in end). Picks the key up, adds `open_chest` to the tool set
 *                 and removes itself, because there is no key left to pick up.
 *   open_chest    does not exist until the key is picked up; opens the chest with an item from the inventory.
 *
 * Tools are added and removed at runtime through `ctx.tools`; the registry is read again at every step.
 */
import { defineTool, param, type AnyTool } from "../../src/index.js";

export function createChest() {
  const world = { inventory: [] as string[], chest: "locked" as "locked" | "open" };

  const slots = () => ({ inventory: [...world.inventory], chest: world.chest });

  const openChest = defineTool({
    name: "open_chest",
    description: "Opens the locked chest with an item from the inventory.",
    params: { with: param.choice({ question: "Which item of `state.inventory` opens the locked chest in `state.chest`?", options: (ctx) => ctx.state.inventory ?? [] }) },
    run: ({ with: item }) => {
      if (item !== "key") throw new Error(`The ${item} does not open the chest`);
      world.chest = "open";
      return { state: slots(), summary: `opened the chest with the ${item}` };
    },
  });

  const pickUpKey = defineTool({
    name: "pick_up_key",
    description: "Picks up the key that lies on the floor.",
    run: (_args, ctx) => {
      world.inventory.push("key");
      ctx.tools.add(openChest);
      ctx.tools.remove("pick_up_key");
      return { state: slots(), summary: "picked up the key" };
    },
  });

  const tools: AnyTool[] = [pickUpKey];
  return { tools, initialState: slots(), world };
}
