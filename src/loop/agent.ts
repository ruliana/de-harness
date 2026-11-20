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
 *
 * Scale: when that request would be over the context budget, the step goes two-phase instead: first the state
 * and `__tool__` alone, then the state and only the chosen tool's parameter questions. A request still over budget
 * loses its oldest previous actions; with none left the run fails, naming the largest part.
 */
import { TraceWriter } from "../events/trace.js";
import { BudgetError, DEFAULT_CONTEXT_BUDGET, fitRequest, requestTokens } from "../budget/budget.js";
import type { EventInput, HarnessEvent, Phase } from "../events/events.js";
import { DecisionModelError, type Answer, type DecisionModel, type DecisionRequest, type DecisionResponse, type Question } from "../model/types.js";
import { AnswerError, TOOL_QUESTION, buildQuestions, paramQuestions, parseArgs, pickedTool, toolQuestionOnly } from "../questions/build.js";
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
  /**
   * Most tokens (estimated from characters) one request may hold. Default 48 000, under Jev's 64k limit.
   * Over it, a step goes two-phase; a request still over it drops its oldest previous actions, then the run fails.
   */
  contextBudget?: number;
  /**
   * Opt-in check for option-order bias: also ask `__tool__` with its options in reverse order. When the two answers
   * differ an `order_disagreement` event is emitted; the step still proceeds with the answer to the normal order.
   * One extra request per step.
   */
  orderCheck?: boolean;
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

/** The config of an agent started by a tool through `ctx.runAgent`. */
export type SubAgentConfig = Omit<AgentConfig, "model" | "signal" | "onEvent"> & {
  /** Defaults to the model of the agent that runs the tool. */
  model?: DecisionModel;
  /** Extra signal; the child also stops when the parent run is aborted. */
  signal?: AbortSignal;
};

export type StepRecord = {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  /** Raw answers for the chosen tool's parameters. */
  answers: Record<string, Answer>;
  /** The first request sent to the model this step. */
  request: DecisionRequest;
  /** Every request of this step with its phase: one in a normal step, two in a two-phase step, plus one for the order check. */
  requests: { phase: Phase; request: DecisionRequest }[];
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
  const budget = config.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
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

  // step 0 is before the first step (tools added through `agent.tools` before `run`)
  let currentStep = 0;
  const stopListening = tools.onChange((c) => emit({ type: "tools_changed", step: currentStep, change: c.change, tool: c.tool, tools: tools.list().map((t) => t.name) }));

  const finish = (status: RunResult["status"], extra: { output?: unknown; error?: Error } = {}): RunResult => {
    stopListening();
    emit({ type: "run_end", status, steps: steps.length });
    return { status, steps, state: doc.view(), events, ...extra };
  };

  emit({ type: "run_start", instructions: config.instructions, tools: tools.list().map((t) => t.name), maxSteps });

  for (let step = 1; step <= maxSteps; step++) {
    currentStep = step;
    if (signal.aborted) return finish("aborted");

    // 1. which tools are available now (code only), and their questions
    const view = doc.view();
    const candidates = tools.list().filter((t) => t.available?.({ state: view, step, tools }) ?? true);
    const plan = buildQuestions(candidates, { state: view, step });
    emit({ type: "step_start", step, tools: plan.tools.map((t) => t.name), skipped: plan.skipped });
    if (plan.tools.length === 0) return finish("error", { error: new Error("No tool is available") });

    // 2. ask: one request, or two when the full request is over budget
    const full: DecisionRequest = { state: doc.document(config.instructions, window, window > 0), questions: plan.questions };
    const sent: StepRecord["requests"] = [];
    const answers: Record<string, Answer> = {};
    let current: Phase = "single";
    const ask = async (phase: Phase, questions: Record<string, Question>): Promise<DecisionResponse> => {
      current = phase;
      let fitted: ReturnType<typeof fitRequest>;
      try {
        fitted = fitRequest((n) => ({ state: doc.document(config.instructions, n, window > 0), questions }), Math.min(window, doc.actionCount()), budget);
      } catch (e) {
        if (e instanceof BudgetError && e.dropped > 0) emit({ type: "trimmed", step, phase, dropped: e.dropped, estimatedTokens: e.estimatedTokens, budget });
        throw e;
      }
      if (fitted.dropped > 0) emit({ type: "trimmed", step, phase, dropped: fitted.dropped, estimatedTokens: fitted.tokens, budget });
      emit({ type: "request", step, phase, estimatedTokens: fitted.tokens, request: fitted.request });
      sent.push({ phase, request: fitted.request });
      const response = await config.model.ask(fitted.request);
      emit({ type: "answers", step, phase, model: response.model, answers: response.answers, usage: response.usage });
      return response;
    };
    try {
      const fullTokens = requestTokens(full);
      if (fullTokens <= budget) {
        Object.assign(answers, (await ask("single", plan.questions)).answers);
      } else {
        emit({ type: "two_phase", step, estimatedTokens: fullTokens, budget });
        Object.assign(answers, (await ask("tool", toolQuestionOnly(plan))).answers);
        const chosen = pickedTool(answers, plan);
        if (Object.keys(chosen.params ?? {}).length > 0) Object.assign(answers, (await ask("params", paramQuestions(plan, chosen))).answers);
      }
      if (config.orderCheck && plan.tools.length > 1) {
        const reversed = (await ask("order_check", toolQuestionOnly(plan, true))).answers[TOOL_QUESTION];
        const forward = answers[TOOL_QUESTION];
        if (forward?.type === "choice" && reversed?.type === "choice" && forward.choice !== reversed.choice) {
          emit({ type: "order_disagreement", step, forward: forward.choice, reversed: reversed.choice });
        }
      }
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      if (error instanceof BudgetError) {
        emit({ type: "budget_exceeded", step, phase: current, message: error.message, largest: error.largest.name, estimatedTokens: error.estimatedTokens, budget });
      } else {
        emit({ type: "model_error", step, message: error.message, status: error instanceof DecisionModelError ? error.status : undefined });
      }
      return finish("error", { error });
    }
    const request = sent[0]!.request;

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
    const runAgent = (child: SubAgentConfig) =>
      createAgent({
        ...child,
        model: child.model ?? config.model,
        ...(child.input ?? config.input ? { input: child.input ?? config.input } : {}),
        ...(child.inputTimeoutMs ?? config.inputTimeoutMs !== undefined ? { inputTimeoutMs: child.inputTimeoutMs ?? config.inputTimeoutMs } : {}),
        signal: child.signal ? AbortSignal.any([signal, child.signal]) : signal,
        onEvent: (event) => emit({ type: "child", step, event }),
      }).run();
    const ctx: ToolContext = { state: view, answers: parsed.raw, step, signal, tools, input, emit: (name, data) => emit({ type: "custom", step, name, data }), runAgent };
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
    steps.push({ step, tool: tool.name, args: parsed.args, answers: parsed.raw, request, requests: sent, ...(summary !== undefined ? { summary } : {}), ...(error ? { error } : {}) });
    emit({ type: "tool_result", step, tool: tool.name, ...(summary !== undefined ? { summary } : {}), ...(error ? { error } : {}), ...(result.end ? { end: true } : {}) });

    if (result.end) return finish("ended", { output: result.output });
  }
  return finish("step_limit");
}
