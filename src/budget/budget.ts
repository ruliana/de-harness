/**
 * The context budget. Jev accepts about 64k tokens per request; the harness stays under a smaller budget
 * (default 48k) so the answer is never refused for size. Tokens are estimated from characters, never counted.
 *
 * When a step's full request (state + the `__tool__` Choice + every parameter question) is over budget, the loop
 * goes two-phase (see `loop/agent.ts`). A request that is still over budget loses its oldest `previous_actions`
 * one at a time. If it is over budget with none left, the run fails with a `BudgetError` naming the largest part.
 */
import type { DecisionRequest } from "../model/types.js";

export const DEFAULT_CONTEXT_BUDGET = 48_000;

/** JSON is denser than prose, so 4 characters per token is about right and errs on the safe side. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN);
}

/** Images are sent as assets and are not part of this estimate. */
export function requestTokens(request: Pick<DecisionRequest, "state" | "questions">): number {
  return estimateTokens({ state: request.state, questions: request.questions });
}

/** The parts a request is made of, named the way the questions name them (by state path). */
function parts(request: Pick<DecisionRequest, "state" | "questions">): { name: string; tokens: number }[] {
  const out: { name: string; tokens: number }[] = [];
  const doc = (request.state ?? {}) as { instructions?: unknown; state?: Record<string, unknown>; previous_actions?: unknown };
  if (doc.instructions !== undefined) out.push({ name: "instructions", tokens: estimateTokens(doc.instructions) });
  for (const [slot, value] of Object.entries(doc.state ?? {})) out.push({ name: `state.${slot}`, tokens: estimateTokens(value) });
  if (doc.previous_actions !== undefined) out.push({ name: "previous_actions", tokens: estimateTokens(doc.previous_actions) });
  for (const [id, q] of Object.entries(request.questions)) out.push({ name: `question ${id}`, tokens: estimateTokens(q) });
  return out;
}

export function largestPart(request: Pick<DecisionRequest, "state" | "questions">): { name: string; tokens: number } {
  return parts(request).reduce((best, p) => (p.tokens > best.tokens ? p : best), { name: "(empty)", tokens: 0 });
}

export class BudgetError extends Error {
  constructor(
    readonly estimatedTokens: number,
    readonly budget: number,
    readonly largest: { name: string; tokens: number },
    /** Previous actions that were dropped before giving up. */
    readonly dropped = 0,
  ) {
    super(
      `The request is about ${estimatedTokens} tokens, over the context budget of ${budget}, even without previous actions. ` +
        `The largest part is \`${largest.name}\` (about ${largest.tokens} tokens): make it smaller in code, or raise \`contextBudget\`.`,
    );
    this.name = "BudgetError";
  }
}

export type Fitted = {
  request: DecisionRequest;
  /** Estimated tokens of the request as sent. */
  tokens: number;
  /** How many previous actions were left out to fit. */
  dropped: number;
};

/**
 * Builds a request that fits the budget. `build(n)` returns the request showing the `n` newest previous actions.
 * Drops the oldest previous actions first; throws `BudgetError` when it is still too big with none.
 */
export function fitRequest(build: (previousActions: number) => DecisionRequest, available: number, budget: number): Fitted {
  let shown = available;
  let request = build(shown);
  let tokens = requestTokens(request);
  while (tokens > budget && shown > 0) {
    shown--;
    request = build(shown);
    tokens = requestTokens(request);
  }
  if (tokens > budget) throw new BudgetError(tokens, budget, largestPart(request), available - shown);
  return { request, tokens, dropped: available - shown };
}
