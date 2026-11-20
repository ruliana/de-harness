/**
 * The step loop. Each step is ONE request to the model:
 *
 *   state document { instructions, state, previous_actions }
 *   + a Choice `__tool__` over the available tools
 *   + one question `<tool>.<param>` per parameter of every available tool   (speculative fan-out)
 *
 * Code reads `__tool__`, converts only that tool's answers to typed args, runs the tool, and merges its result
 * into the state. Repeats until a tool ends the run, the step limit is hit, the run is aborted, or the model fails.
 * The model never writes text.
 */
import { TraceWriter } from "../events/trace.js";
import type { EventInput, HarnessEvent } from "../events/events.js";
import { DecisionModelError, type Answer, type DecisionModel, type DecisionRequest } from "../model/types.js";
import { AnswerError, buildQuestions, parseArgs, pickedTool } from "../questions/build.js";
import { createInputPort, type InputProvider } from "../input/provider.js";
import { StateDocument, type Json } from "../state/state.js";
import { endTool } from "../tools/builtin.js";
import { ToolRegistry } from "../tools/registry.js";
import type { AnyTool, ToolContext, ToolResult } from "../tools/tool.js";

export type AgentConfig = {
  model: DecisionModel;
  /** Given at the start and repeated, unchanged, in every request. */
  instructions: string;
  tools: AnyTool[];
  /** Default 20. */
  maxSteps?: number;
  /** How many previous actions are shown to the model. Default 5, 0 disables. */
  previousActions?: number;
  /** State slots before the first step. */
  initialState?: Record<string, Json>;
  /** Write every event to this file as JSONL. */
  trace?: string;
  signal?: AbortSignal;
  /** Who answers `ctx.input.ask`: a terminal (`StdinInput`), a script (`ScriptedInput`), a web hook. Without one, asking throws. */
  input?: InputProvider;
  /** Default timeout of every `ctx.input.ask`, in ms. Unset waits forever. */
  inputTimeoutMs?: number;
  onEvent?: (event: HarnessEvent) => void;
};

export type StepRecord = {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  /** Raw answers for the chosen tool's parameters. */
  answers: Record<string, Answer>;
  /** The exact request sent to the model this step. */
  request: DecisionRequest;
  summary?: string;
  /** Set when the tool threw. */
  error?: string;
};

export type RunResult = {
  status: "ended" | "step_limit" | "aborted" | "error";
  steps: StepRecord[];
  /** The state slots when the run stopped. */
  state: Record<string, unknown>;
  /** What the ending tool returned (the built-in `end` returns the final state). */
  output?: unknown;
  /** Present when status is `error`: the API error, or a description of an answer that could not be used. */
  error?: Error;
  events: HarnessEvent[];
};

export type Agent = {
  run(): Promise<RunResult>;
  /** The live registry: add or remove tools at any time; changes apply from the next step. */
  readonly tools: ToolRegistry;
};

export function createAgent(config: AgentConfig): Agent {
  const tools = new ToolRegistry([...config.tools]);
  if (!tools.has("end")) tools.add(endTool());
  return { tools, run: () => run(config, tools) };
}

async function run(config: AgentConfig, tools: ToolRegistry): Promise<RunResult> {
  const maxSteps = config.maxSteps ?? 20;
  const window = config.previousActions ?? 5;
  const signal = config.signal ?? new AbortController().signal;
  const doc = new StateDocument(config.initialState);
  const trace = config.trace ? new TraceWriter(config.trace) : undefined;
  const events: HarnessEvent[] = [];
  const steps: StepRecord[] = [];
  const emit = (e: EventInput) => {
    const event = { ts: new Date().toISOString(), ...e } as HarnessEvent;
    events.push(event);
    trace?.write(event);
    config.onEvent?.(event);
  };

  const finish = (status: RunResult["status"], extra: { output?: unknown; error?: Error } = {}): RunResult => {
    emit({ type: "run_end", status, steps: steps.length });
    return { status, steps, state: doc.view(), events, ...extra };
  };

  emit({ type: "run_start", instructions: config.instructions, tools: tools.list().map((t) => t.name), maxSteps });

  for (let step = 1; step <= maxSteps; step++) {
    if (signal.aborted) return finish("aborted");

    // 1. which tools are available now (code only), and their questions
    const view = doc.view();
    const candidates = tools.list().filter((t) => t.available?.({ state: view, step, tools }) ?? true);
    const plan = buildQuestions(candidates, { state: view, step });
    emit({ type: "step_start", step, tools: plan.tools.map((t) => t.name), skipped: plan.skipped });
    if (plan.tools.length === 0) return finish("error", { error: new Error("No tool is available") });

    // 2. one request
    const request: DecisionRequest = { state: doc.document(config.instructions, window), questions: plan.questions };
    emit({ type: "request", step, request });
    let answers: Record<string, Answer>;
    try {
      const response = await config.model.ask(request);
      answers = response.answers;
      emit({ type: "answers", step, model: response.model, answers, usage: response.usage });
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      emit({ type: "model_error", step, message: error.message, status: error instanceof DecisionModelError ? error.status : undefined });
      return finish("error", { error });
    }

    // 3. read the chosen tool's answers only
    let tool: AnyTool;
    let parsed: ReturnType<typeof parseArgs>;
    try {
      tool = pickedTool(answers, plan);
      parsed = parseArgs(tool, answers, plan);
    } catch (e) {
      if (!(e instanceof AnswerError)) throw e;
      emit({ type: "model_error", step, message: e.message });
      return finish("error", { error: e });
    }

    // 4. run it (it may await anything)
    emit({ type: "tool_call", step, tool: tool.name, args: parsed.args });
    const input = createInputPort(config.input, {
      signal,
      ...(config.inputTimeoutMs !== undefined ? { defaultTimeoutMs: config.inputTimeoutMs } : {}),
      observer: {
        requested: (prompt, choices) => emit({ type: "input_requested", step, tool: tool.name, prompt, ...(choices ? { choices } : {}) }),
        received: (reply) => emit({ type: "input_received", step, tool: tool.name, reply }),
        failed: (reason, message) => emit({ type: "input_failed", step, tool: tool.name, reason, message }),
      },
    });
    const ctx: ToolContext = { state: view, answers: parsed.raw, step, signal, tools, input, emit: (name, data) => emit({ type: "custom", step, name, data }) };
    let result: ToolResult;
    let error: string | undefined;
    try {
      result = await tool.run(parsed.args as never, ctx);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      result = { state: { error } };
    }

    // an abort while the tool was waiting (user input, a sub-agent) ends the run; the half-done step is not recorded
    if (signal.aborted) return finish("aborted");

    // 5. merge into the state; an `error` slot lives for one step
    if (doc.has("error")) doc.merge({ error: null });
    if (result.state) doc.merge(result.state);
    const summary = error ? `failed: ${error}` : result.summary;
    doc.record({ tool: tool.name, args: parsed.args, ...(summary !== undefined ? { summary } : {}) });
    steps.push({ step, tool: tool.name, args: parsed.args, answers: parsed.raw, request, ...(summary !== undefined ? { summary } : {}), ...(error ? { error } : {}) });
    emit({ type: "tool_result", step, tool: tool.name, ...(summary !== undefined ? { summary } : {}), ...(error ? { error } : {}), ...(result.end ? { end: true } : {}) });

    if (result.end) return finish("ended", { output: result.output });
  }
  return finish("step_limit");
}
