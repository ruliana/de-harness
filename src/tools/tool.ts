/**
 * The tool interface. A tool is a plain object built with `defineTool`; argument types are inferred from `params`.
 *
 *   defineTool({
 *     name: "open_door",
 *     description: "Opens one of the doors of the room and walks through it.",
 *     params: { door: param.choice({ question: "Which door do `instructions` say to go through?", options: (ctx) => ctx.state.room.doors }) },
 *     available: (ctx) => ctx.state.room != null,          // optional, code only
 *     run: async ({ door }, ctx) => ({ state: { room: await walkThrough(door) }, summary: `went through the ${door} door` }),
 *   })
 */
import type { Answer } from "../model/types.js";
import type { EventInput } from "../events/events.js";
import type { Json, StateView } from "../state/state.js";
import type { InputPort } from "../input/provider.js";
import type { ToolRegistry } from "./registry.js";
import type { ArgsOf, Params } from "./param.js";

export type ToolContext = {
  /** Read-only copy of the state slots. */
  state: StateView;
  /** Raw answers for this tool's questions, keyed by parameter name (probabilities, confidence), so code can apply its own thresholds. */
  answers: Record<string, Answer>;
  /** 1-based number of the current step. */
  step: number;
  /** Aborted when the caller cancels the run. Tools that wait on anything should honour it. */
  signal: AbortSignal;
  /** The live registry. Changes take effect from the next step. */
  tools: ToolRegistry;
  /** Ask the user and hold the loop until they reply (`await ctx.input.ask(prompt)`). Throws on timeout, and when no provider is configured. */
  input: InputPort;
  /** Add a custom event to the trace. */
  emit(name: string, data?: unknown): void;
};

/** Availability is decided in code, before the question map is built. */
export type AvailabilityContext = Pick<ToolContext, "state" | "step" | "tools">;

export type ToolResult = {
  /** Slots to replace in the state. `null` deletes a slot. */
  state?: Record<string, Json | null>;
  /** One line for the previous-actions window. */
  summary?: string;
  /** Stop the run after this step. */
  end?: boolean;
  /** The run's result when ending. */
  output?: unknown;
};

export type Tool<P extends Params = Params> = {
  /** Letters, digits and underscore. */
  name: string;
  /** What the tool does, concretely and distinctly from the others. Sent to the model as the criterion of this tool's option. */
  description: string;
  params?: P;
  available?(ctx: AvailabilityContext): boolean;
  /** May be async and wait on anything (user input, another agent): the loop simply awaits it. A throw does not stop the run: it becomes the `error` slot. */
  run(args: ArgsOf<P>, ctx: ToolContext): ToolResult | Promise<ToolResult>;
};

export type AnyTool = Tool<any>;

export function defineTool<P extends Params = Record<never, never>>(tool: Tool<P>): Tool<P> {
  return tool;
}

export type { EventInput };
