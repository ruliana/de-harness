import type { Answer, DecisionRequest } from "../model/types.js";

/** Everything the loop reports. Events are plain JSON-serialisable objects, one per line in the JSONL trace. */
export type HarnessEvent = { ts: string } & (
  | { type: "run_start"; instructions: string; tools: string[]; maxSteps: number }
  | { type: "step_start"; step: number; tools: string[]; skipped: { tool: string; reason: string }[] }
  | { type: "request"; step: number; request: DecisionRequest }
  | { type: "answers"; step: number; model: string; answers: Record<string, Answer>; usage: { input_tokens: number; output_tokens: number } }
  | { type: "model_error"; step: number; message: string; status?: number }
  | { type: "tool_call"; step: number; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; step: number; tool: string; summary?: string; error?: string; end?: boolean }
  | { type: "tools_changed"; step: number; change: "added" | "removed"; tool: string; tools: string[] }
  | { type: "custom"; step: number; name: string; data?: unknown }
  | { type: "run_end"; status: string; steps: number }
);

/** A distributive Omit, so that `emit({ type: "custom", ... })` is checked against the right member. */
export type EventInput = HarnessEvent extends infer E ? (E extends unknown ? Omit<E, "ts"> : never) : never;
