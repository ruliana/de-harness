import type { Answer, DecisionRequest } from "../model/types.js";

/**
 * Which request of a step this is:
 *   single       the whole step in one request: the `__tool__` Choice and every parameter question
 *   tool         two-phase, first request: only the `__tool__` Choice (the full fan-out was over budget)
 *   params       two-phase, second request: only the chosen tool's parameter questions
 *   order_check  the opt-in check: only `__tool__`, with its options in reverse order
 *   review       the opt-in review of a choice (`AgentConfig.review`): one Noul judgment
 */
export type Phase = "single" | "tool" | "params" | "order_check" | "review";

/** Everything the loop reports. Events are plain JSON-serialisable objects, one per line in the JSONL trace. */
export type HarnessEvent = { ts: string } & (
  | { type: "run_start"; instructions: string; tools: string[]; maxSteps: number }
  | { type: "step_start"; step: number; tools: string[]; skipped: { tool: string; reason: string }[] }
  | { type: "request"; step: number; phase: Phase; estimatedTokens: number; request: DecisionRequest }
  | { type: "answers"; step: number; phase: Phase; model: string; answers: Record<string, Answer>; usage: { input_tokens: number; output_tokens: number } }
  | { type: "two_phase"; step: number; estimatedTokens: number; budget: number }
  | { type: "trimmed"; step: number; phase: Phase; dropped: number; estimatedTokens: number; budget: number }
  | { type: "budget_exceeded"; step: number; phase: Phase; message: string; largest: string; estimatedTokens: number; budget: number }
  | { type: "order_disagreement"; step: number; forward: string; reversed: string }
  /** A review judgment (`AgentConfig.review`): `p` is the Noul answer, `refused` is the code's decision on it. */
  | { type: "review"; step: number; check: "end" | "action"; tool: string; call?: string; p: number; /** actions only: is this the right moment */ ready?: number; refused: boolean }
  /** `review.maxRefusals` calls in a row were refused: the model keeps asking for what `instructions` do not ask for, so the run ends. */
  | { type: "review_stop"; step: number; refusals: number }
  | { type: "model_error"; step: number; message: string; status?: number }
  | { type: "tool_call"; step: number; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; step: number; tool: string; summary?: string; error?: string; end?: boolean }
  | { type: "input_requested"; step: number; tool: string; prompt: string; choices?: readonly string[] }
  | { type: "input_received"; step: number; tool: string; reply: string }
  | { type: "input_failed"; step: number; tool: string; reason: "timeout" | "aborted" | "error"; message: string }
  | { type: "tools_changed"; step: number; change: "added" | "removed"; tool: string; tools: string[] }
  | { type: "custom"; step: number; name: string; data?: unknown }
  /** An event of a sub-agent started by `ctx.runAgent` during `step`. Sub-agents of sub-agents nest further. */
  | { type: "child"; step: number; event: HarnessEvent }
  | { type: "run_end"; status: string; steps: number }
);

/** A distributive Omit, so that `emit({ type: "custom", ... })` is checked against the right member. */
export type EventInput = HarnessEvent extends infer E ? (E extends unknown ? Omit<E, "ts"> : never) : never;
