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
import { openTrace } from "../events/trace.js";
import { BudgetError, DEFAULT_CONTEXT_BUDGET, fitRequest, largestPart, requestTokens } from "../budget/budget.js";
import { Planner, type LookaheadConfig } from "../lookahead/lookahead.js";
import type { EventInput, HarnessEvent, Phase } from "../events/events.js";
import { DecisionModelError, type Answer, type DecisionModel, type DecisionRequest, type DecisionResponse, type Question } from "../model/types.js";
import { AnswerError, TOOL_QUESTION, buildQuestions, paramQuestions, parseArgs, pickedTool, toolQuestionOnly } from "../questions/build.js";
import { createInputPort, type InputProvider } from "../input/provider.js";
import { extractImages } from "../state/images.js";
import { StateDocument, type Json, type PreviousAction } from "../state/state.js";
import { endTool } from "../tools/builtin.js";
import { DEFAULT_MAX_REFUSALS, DEFAULT_REVIEW_THRESHOLD, REVIEW_QUESTION, STRICT_END_DESCRIPTION, STRICT_TOOL_QUESTION_TEXT, READY_QUESTION, askedQuestion, wantedId, wantedQuestion, callPhrase, describeCall, readyQuestion, remainingQuestion, type ReviewConfig } from "../review/review.js";
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
  /**
   * Opt-in review of the model's own choices: stricter wording, a check before the run ends, a check before a tool
   * marked `effect: "change"` runs. Each check is one extra Noul request; see `src/review/review.ts`.
   */
  review?: ReviewConfig;
  /**
   * Opt-in short-horizon lookahead with replanning: before each action Jev shortlists a few, code previews them on
   * copies of the state (`preview` on the tool), judges the resulting states against `requirements` and `constraints`,
   * looks `depth` actions ahead, and runs only the first action of the best sequence. The run ends by itself when every
   * requirement is met, or when nothing explored improves on the current state. Several requests per step; see
   * `src/lookahead/lookahead.ts`.
   */
  lookahead?: LookaheadConfig;
  /** State slots before the first step. */
  initialState?: Record<string, Json>;
  /** Write every event to this file as JSONL (Node only; in a browser use `onEvent`). */
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
  /** Set when `review.actions` found that `instructions` do not ask for this call: the tool did not run. */
  refused?: string;
  /** Tools whose choice `review.end` turned down this step (`end`), after which the model chose again. */
  vetoed?: string[];
  /** With `lookahead`: the sequence this action is the first of, as calls, and whether it was planned or an exploratory try of a tool that cannot be previewed. */
  planned?: { sequence: string[]; why: string };
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
  if (!tools.has("end")) tools.add(endTool(config.review?.wording ? { description: STRICT_END_DESCRIPTION } : {}));
  return { tools, run: () => run(config, tools) };
}

async function run(config: AgentConfig, tools: ToolRegistry): Promise<RunResult> {
  const maxSteps = config.maxSteps ?? 20;
  const window = config.previousActions ?? 5;
  const budget = config.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
  const signal = config.signal ?? new AbortController().signal;
  const doc = new StateDocument(config.initialState);
  const trace = config.trace ? await openTrace(config.trace) : undefined;
  const events: HarnessEvent[] = [];
  const steps: StepRecord[] = [];
  const emit = (e: EventInput) => {
    const event = { ts: new Date().toISOString(), ...e } as HarnessEvent;
    events.push(event);
    trace?.write(event);
    config.onEvent?.(event);
  };

  let refusals = 0;
  const planner = config.lookahead ? new Planner(config.lookahead) : undefined;
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

    // 1. which tools are available now (code only)
    const view = doc.view();
    const candidates = tools.list().filter((t) => t.available?.({ state: view, step, tools }) ?? true);

    // 2. ask: one request, or two when the full request is over budget
    // images in the state travel as references, listed once in `images` (and are not part of the token estimate)
    const requestOf = (shown: number, questions: Record<string, Question>): DecisionRequest => {
      const { value: state, images } = extractImages(doc.document(config.instructions, shown, window > 0));
      return { state, questions, ...(Object.keys(images).length ? { images } : {}) };
    };
    const sent: StepRecord["requests"] = [];
    const answers: Record<string, Answer> = {};
    let current: Phase = "single";
    const ask = async (phase: Phase, questions: Record<string, Question>): Promise<DecisionResponse> => {
      current = phase;
      let fitted: ReturnType<typeof fitRequest>;
      try {
        fitted = fitRequest((n) => requestOf(n, questions), Math.min(window, doc.actionCount()), budget);
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
    /** One review judgment (a Noul over the same state document). */
    const judge = async (questions: Record<string, Question>): Promise<Record<string, number>> => {
      const response = await ask("review", questions);
      return Object.fromEntries(
        Object.keys(questions).map((id) => {
          const a = response.answers[id];
          if (a?.type !== "noul") throw new AnswerError(`The model did not answer the review question "${id}"`);
          return [id, a.noul];
        }),
      );
    };
    const cut = config.review?.threshold ?? DEFAULT_REVIEW_THRESHOLD;

    // the choice of this step; with `review.end` an end that still leaves work is refused and the model chooses again
    const vetoed: string[] = [];
    let planned: { sequence: string[]; why: string } | undefined;
    let plan!: ReturnType<typeof buildQuestions>;
    let tool!: AnyTool;
    let parsed!: ReturnType<typeof parseArgs>;
    if (planner) {
      // lookahead: the planner searches over imagined states and returns the first action of the best sequence, or a stop
      emit({ type: "step_start", step, tools: candidates.filter((t) => t.name !== "end").map((t) => t.name), skipped: [] });
      const askDoc = async (phase: "shortlist" | "evaluate", doc: Record<string, unknown>, questions: Record<string, Question>): Promise<DecisionResponse> => {
        current = phase;
        const { value: state, images } = extractImages(doc);
        const request: DecisionRequest = { state, questions, ...(Object.keys(images).length ? { images } : {}) };
        const tokens = requestTokens(request);
        if (tokens > budget) throw new BudgetError(tokens, budget, largestPart(request));
        emit({ type: "request", step, phase, estimatedTokens: tokens, request });
        sent.push({ phase, request });
        const response = await config.model.ask(request);
        emit({ type: "answers", step, phase, model: response.model, answers: response.answers, usage: response.usage });
        return response;
      };
      let decision: Awaited<ReturnType<Planner["next"]>>;
      try {
        decision = await planner.next(
          {
            step,
            instructions: config.instructions,
            view,
            history: doc.document(config.instructions, window, window > 0).previous_actions as PreviousAction[] ?? [],
            window,
            registry: tools,
            tools: candidates,
            available: (state) => tools.list().filter((t) => t.available?.({ state, step, tools }) ?? true),
            ask: askDoc,
          },
          (search) => emit({ type: "lookahead", step, search }),
        );
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        if (error instanceof BudgetError) emit({ type: "budget_exceeded", step, phase: current, message: error.message, largest: error.largest.name, estimatedTokens: error.estimatedTokens, budget });
        else emit({ type: "model_error", step, message: error.message, status: error instanceof DecisionModelError ? error.status : undefined });
        return finish("error", { error });
      }
      if (decision.kind === "stop") {
        return finish("ended", { output: { complete: decision.reason === "complete", unmet: decision.unmet, ...(decision.blocker ? { blocker: decision.blocker } : {}), ...(decision.broken ? { broken: decision.broken } : {}), state: doc.view() } });
      }
      tool = decision.tool;
      parsed = { args: decision.args, raw: decision.raw };
      planned = { sequence: decision.sequence, why: decision.why };
    }
    else for (let attempt = 0; ; attempt++) {
      plan = buildQuestions(candidates.filter((t) => !vetoed.includes(t.name)), { state: view, step }, config.review?.wording ? { toolQuestion: STRICT_TOOL_QUESTION_TEXT } : {});
      if (attempt === 0) emit({ type: "step_start", step, tools: plan.tools.map((t) => t.name), skipped: plan.skipped });
      if (plan.tools.length === 0) return finish("error", { error: new Error("No tool is available") });
      try {
        const fullTokens = requestTokens(requestOf(window, plan.questions));
        if (fullTokens <= budget) {
          Object.assign(answers, (await ask("single", plan.questions)).answers);
        } else {
          emit({ type: "two_phase", step, estimatedTokens: fullTokens, budget });
          Object.assign(answers, (await ask("tool", toolQuestionOnly(plan))).answers);
          const chosen = pickedTool(answers, plan);
          if (Object.keys(chosen.params ?? {}).length > 0) Object.assign(answers, (await ask("params", paramQuestions(plan, chosen))).answers);
        }
        if (config.orderCheck && plan.tools.length > 1 && attempt === 0) {
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

      // 3. read the chosen tool's answers only
      try {
        tool = pickedTool(answers, plan);
        parsed = parseArgs(tool, answers, plan);
      } catch (e) {
        if (!(e instanceof AnswerError)) throw e;
        emit({ type: "model_error", step, message: e.message });
        return finish("error", { error: e });
      }

      // 3b. review.end: Jev judges whether anything doable is left; code refuses the end when it says so
      if (config.review?.end && tool.name === "end" && plan.tools.length > 1) {
        let left: number;
        const others = plan.tools.filter((t) => t.name !== "end");
        const wanted = others.filter((t) => t.wanted);
        try {
          const verdict = await judge({
            [REVIEW_QUESTION]: remainingQuestion(others),
            ...Object.fromEntries(wanted.map((t) => [wantedId(t.name), wantedQuestion(t.wanted!)])),
          });
          // something is left when the general question says so, or any available tool's own question does
          left = Math.max(...Object.values(verdict));
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          emit({ type: "model_error", step, message: error.message, status: error instanceof DecisionModelError ? error.status : undefined });
          return finish("error", { error });
        }
        const refused = left >= cut;
        emit({ type: "review", step, check: "end", tool: "end", p: left, refused });
        if (refused) {
          vetoed.push("end");
          continue;
        }
      }
      break;
    }
    // with lookahead every request of an earlier step may answer this one (equal states are asked about once)
    const request = sent[0]?.request ?? { state: doc.document(config.instructions, window, window > 0), questions: {} };

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
    const ctx: ToolContext = { state: view, answers: parsed.raw, step, instructions: config.instructions, signal, tools, input, emit: (name, data) => emit({ type: "custom", step, name, data }), runAgent };
    let result: ToolResult;
    let error: string | undefined;
    let refused: string | undefined;
    // review.actions: Jev judges whether `instructions` ask for this call; code refuses it when they do not
    if (config.review?.actions && tool.effect === "change") {
      const at = { state: view, step, tools };
      const phrase = callPhrase(tool, parsed.args, at);
      let verdict: Record<string, number>;
      try {
        verdict = await judge({
          [REVIEW_QUESTION]: tool.confirm ? wantedQuestion(tool.confirm(parsed.args as never, at)) : askedQuestion(phrase),
          ...(tool.final ? { [READY_QUESTION]: readyQuestion(phrase, candidates.filter((t) => t.name !== "end")) } : {}),
        });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        emit({ type: "model_error", step, message: err.message, status: err instanceof DecisionModelError ? err.status : undefined });
        return finish("error", { error: err });
      }
      const asked = verdict[REVIEW_QUESTION]!;
      const ready = verdict[READY_QUESTION];
      const call = tool.summarize?.(parsed.args as never, at) ?? describeCall(tool, parsed.args);
      emit({ type: "review", step, check: "action", tool: tool.name, call, p: asked, ...(ready !== undefined ? { ready } : {}), refused: asked < cut || (ready ?? 1) < cut });
      if (asked < cut) refused = `Not done: ${call}. \`instructions\` do not ask for it.`;
      else if (ready !== undefined && ready < cut) refused = `Not done yet: ${call}. Doing it now would stop another part of \`instructions\` from being done: do the other parts first.`;
    }
    if (refused) {
      result = { state: { error: refused }, summary: `not done, not asked for: ${tool.summarize?.(parsed.args as never, { state: view, step, tools }) ?? describeCall(tool, parsed.args)}` };
    } else {
      try {
        result = await tool.run(parsed.args as never, ctx);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        result = { state: { error } };
      }
    }

    // an abort while the tool was waiting (user input, a sub-agent) ends the run; the half-done step is not recorded
    if (signal.aborted) return finish("aborted");

    // 5. merge into the state; an `error` slot lives for one step
    if (doc.has("error")) doc.merge({ error: null });
    if (result.state) doc.merge(result.state);
    const summary = error ? `failed: ${error}` : result.summary;
    doc.record({ tool: tool.name, args: parsed.args, ...(summary !== undefined ? { summary } : {}) });
    steps.push({ step, tool: tool.name, args: parsed.args, answers: parsed.raw, request, requests: sent, ...(summary !== undefined ? { summary } : {}), ...(error ? { error } : {}), ...(refused ? { refused } : {}), ...(vetoed.length ? { vetoed: [...vetoed] } : {}), ...(planned ? { planned } : {}) });
    emit({ type: "tool_result", step, tool: tool.name, ...(summary !== undefined ? { summary } : {}), ...(error ? { error } : {}), ...(result.end ? { end: true } : {}) });

    if (result.end) return finish("ended", { output: result.output });
    if (refused) {
      if (++refusals >= (config.review?.maxRefusals ?? DEFAULT_MAX_REFUSALS)) {
        emit({ type: "review_stop", step, refusals });
        return finish("ended", { output: doc.view() });
      }
    } else refusals = 0;
  }
  return finish("step_limit");
}
