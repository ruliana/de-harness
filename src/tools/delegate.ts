/**
 * `delegate`: a tool that hands a task to a sub-agent (`ctx.runAgent`) and holds the loop until it is done.
 *
 * Jev cannot write the task, so the parent picks it from candidates (`tasks`, name -> when it applies). The child's
 * outcome lands in one state slot, `{ task, status, steps, output }`, whatever the status: a child that hits its step
 * limit or fails does not stop the parent, which sees the status in its state and decides what to do next.
 *
 *   delegate({
 *     tasks: { "Leave the room through the red door": "The way out is the red door" },
 *     agent: (task) => ({ instructions: task, tools: rooms.tools, initialState: rooms.initialState, maxSteps: 4 }),
 *   })
 */
import type { RunResult, SubAgentConfig } from "../loop/agent.js";
import type { Json } from "../state/state.js";
import { param, type Options, type ParamContext } from "./param.js";
import { defineTool, type ToolContext } from "./tool.js";

export type DelegateOptions = {
  /** Default `delegate`. */
  name?: string;
  /** What the tool does, distinctly from the other tools. */
  description?: string;
  /** Wording of the question that picks the task. */
  question?: string;
  /** Candidate tasks: the chosen name is passed to `agent`. Static, or computed from the state. */
  tasks: Options | ((ctx: ParamContext) => Options);
  /** The slot that receives the child's outcome. Default `delegated`. */
  slot?: string;
  /** The child for a task: its instructions, tools, step limit and so on. Its model defaults to the parent's. */
  agent(task: string, ctx: ToolContext): SubAgentConfig;
  /** Replace the value written to the slot. */
  result?(task: string, result: RunResult): Json;
};

export function delegate(opts: DelegateOptions) {
  const slot = opts.slot ?? "delegated";
  const question = opts.question ?? "Which of these tasks do `instructions` ask a helper agent to carry out?";
  const task = typeof opts.tasks === "function" ? param.choice({ question, options: opts.tasks }) : param.choice({ question, options: opts.tasks });
  return defineTool({
    name: opts.name ?? "delegate",
    description: opts.description ?? `Hands a task to a helper agent with its own tools, waits until it is done and records what it reports in \`state.${slot}\`.`,
    params: { task },
    run: async ({ task }, ctx) => {
      const result = await ctx.runAgent(opts.agent(task, ctx));
      const value = opts.result?.(task, result) ?? outcome(task, result);
      return { state: { [slot]: value }, summary: `delegated "${task}": the helper ${describe(result)}` };
    },
  });
}

function outcome(task: string, result: RunResult): Json {
  return {
    task,
    status: result.status,
    steps: result.steps.length,
    ...(result.output !== undefined ? { output: JSON.parse(JSON.stringify(result.output)) as Json } : {}),
    ...(result.error ? { error: result.error.message } : {}),
  };
}

function describe(result: RunResult): string {
  const n = result.steps.length;
  const steps = `${n} step${n === 1 ? "" : "s"}`;
  return result.status === "ended" ? `finished in ${steps}` : result.status === "step_limit" ? `ran out of steps (${steps})` : result.status === "aborted" ? "was aborted" : `failed: ${result.error?.message ?? "error"}`;
}
