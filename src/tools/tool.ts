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
import type { RunResult, SubAgentConfig } from "../loop/agent.js";
import type { InputPort } from "../input/provider.js";
import type { ToolRegistry } from "./registry.js";
import type { ArgsOf, Params } from "./param.js";

export type ToolContext = {
  /** Read-only copy of the state slots. */
  state: StateView;
  /**
   * Raw answers for this tool's questions (probabilities, confidence), so code can apply its own thresholds. Keyed by parameter name;
   * a set's members are keyed `toppings[olives]` and an optional parameter's stated question `delivery_time?stated`.
   */
  answers: Record<string, Answer>;
  /** 1-based number of the current step. */
  step: number;
  /** The instructions of this run, as given to the model in every request: what a tool that asks the model again (a nested agent) repeats to it. */
  instructions: string;
  /** Aborted when the caller cancels the run. Tools that wait on anything should honour it. */
  signal: AbortSignal;
  /** The live registry. Changes take effect from the next step. */
  tools: ToolRegistry;
  /** Ask the user and hold the loop until they reply (`await ctx.input.ask(prompt)`). Throws on timeout, and when no provider is configured. */
  input: InputPort;
  /** Add a custom event to the trace. */
  emit(name: string, data?: unknown): void;
  /**
   * Run a nested agent with its own tools, instructions and step limit, and await its result. The loop holds until it
   * finishes. The child uses this agent's model unless it brings its own, stops when this run is aborted, and its
   * events appear in this trace as `child` events under the current step.
   */
  runAgent(config: SubAgentConfig): Promise<RunResult>;
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
  /**
   * `change` marks a tool that changes something outside the agent (an order, a ticket, a record). With `review.actions`
   * the agent checks that `instructions` ask for the call before it runs. Default `read`: never checked.
   */
  effect?: "read" | "change";
  /**
   * A yes/no question in the tool's own wording, true while `instructions` still call for this tool's work
   * (`Do \`instructions\` ask for what is in \`state.basket\` to be bought, ordered or paid for?`). Name the state it is
   * about by path, and make it a plain judgment that does not depend on the model's habit of what a verb means. With
   * `review.end` the run does not end while the answer is yes for an available tool.
   */
  wanted?: string;
  /**
   * With `review.actions`: the yes/no question asked before this call runs, in place of the generic "do `instructions`
   * ask for this" built from `summarize`. For a call whose plain phrase the model reads wrongly (it does not take
   * "buy" for "pay"); same rules as `wanted`.
   */
  confirm?(args: ArgsOf<P>, ctx: AvailabilityContext): string;
  /**
   * With `review.actions`: this tool can close the door on other changes or cannot be undone (an order, closing a
   * ticket), so before it runs the agent also checks that every other part of `instructions` can still be done
   * afterwards, and otherwise does those parts first. Only meaningful on a `change` tool.
   */
  final?: boolean;
  /**
   * What this call does, in one phrase naming the item and the values, for the review of a `change` tool
   * (`puts the Blue mug into the basket`). Without it the review shows `name(args)` and the description.
   */
  summarize?(args: ArgsOf<P>, ctx: AvailabilityContext): string;
  /**
   * With `lookahead`: what this call would leave in the state, without doing it. It sees a state that may not be the real
   * one (`ctx.state` is a copy several imagined actions ahead) and must not touch the outside world. Returns the same
   * `state` slots (and `summary`) that `run` would. A tool without it cannot be looked ahead through: the planner only
   * tries it for real, when no previewed sequence helps.
   */
  preview?(args: ArgsOf<P>, ctx: AvailabilityContext): ToolResult | Promise<ToolResult>;
  available?(ctx: AvailabilityContext): boolean;
  /** May be async and wait on anything (user input, another agent): the loop simply awaits it. A throw does not stop the run: it becomes the `error` slot. */
  run(args: ArgsOf<P>, ctx: ToolContext): ToolResult | Promise<ToolResult>;
};

export type AnyTool = Tool<any>;

export function defineTool<P extends Params = Record<never, never>>(tool: Tool<P>): Tool<P> {
  return tool;
}

export type { EventInput };
