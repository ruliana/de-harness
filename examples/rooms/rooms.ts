/**
 * A tiny domain for the core loop: a room with doors of different colours.
 *
 *   open_door(door)   walk through one of the doors of the current room (options come from the state)
 *   turn_on_light     only available while the light is off
 *   end               built in
 *
 * `layout` maps each room to its doors (colour -> room it leads to). The default is a hall whose red door leads outside.
 */
import { defineTool, param, type AnyTool, type Json } from "../../src/index.js";

export type Layout = Record<string, Record<string, string>>;

export const defaultLayout: Layout = {
  hall: { red: "outside", blue: "cellar", green: "kitchen" },
  cellar: { yellow: "hall", purple: "vault" },
  kitchen: { white: "hall" },
  vault: { black: "cellar" },
  outside: {},
};

export function createRooms(opts: { layout?: Layout; start?: string } = {}) {
  const layout = opts.layout ?? defaultLayout;
  const world = { room: opts.start ?? "hall", light: "off" as "on" | "off" };

  const slots = (): Record<string, Json> => ({
    room: { name: world.room, light: world.light, doors: Object.keys(layout[world.room] ?? {}) },
  });

  const tools: AnyTool[] = [
    defineTool({
      name: "open_door",
      description: "Opens one of the doors of the current room and walks through it.",
      params: {
        door: param.choice({
          question: "Which door of `state.room.doors` do `instructions` say to go through?",
          options: (ctx) => ctx.state.room?.doors ?? [],
        }),
      },
      available: (ctx) => (ctx.state.room?.doors?.length ?? 0) > 0,
      run: ({ door }) => {
        const target = layout[world.room]?.[door];
        if (!target) throw new Error(`There is no ${door} door in the ${world.room}`);
        world.room = target;
        return { state: slots(), summary: `went through the ${door} door into the ${target}` };
      },
    }),
    defineTool({
      name: "turn_on_light",
      description: "Turns on the light of the current room, which is dark.",
      available: (ctx) => ctx.state.room?.light === "off",
      run: () => {
        world.light = "on";
        return { state: slots(), summary: "turned on the light" };
      },
    }),
  ];

  return { tools, initialState: slots(), world };
}
