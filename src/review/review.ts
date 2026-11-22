/**
 * Opt-in review of the model's own choices (`AgentConfig.review`). Jev judges, code decides: each check is one extra
 * Noul request over the same state document, and code applies the threshold.
 *
 *   wording  the tool question and the built-in `end` ask for exactly what `instructions` say, no more and no less
 *   end      before the run ends: is anything that `instructions` ask for still undone and doable? If so the end is
 *            refused for this step and the model chooses again among the other tools
 *   actions  before a tool marked `effect: "change"` runs: do `instructions` ask for this action with these details?
 *            If not, the tool does not run; the next step shows the model that it was not run
 *
 * Questions are built here, from code-known text only (tool names, descriptions and the arguments the model chose).
 */
import type { Question } from "../model/types.js";
import type { AnyTool, AvailabilityContext } from "../tools/tool.js";

export type ReviewConfig = {
  /** Reword the tool question and `end` to "exactly what `instructions` ask". Changes every request, so recordings made without it do not replay. */
  wording?: boolean;
  /** Check, before the run ends, that nothing doable is left. */
  end?: boolean;
  /** Check, before a `change` tool runs, that `instructions` ask for it. */
  actions?: boolean;
  /**
   * Both judgments are probabilities and code applies this cut (default 0.5): an end is refused when "something is
   * left" is at or above it, an action is refused when "instructions ask for it" is below it.
   */
  threshold?: number;
  /**
   * Refused calls in a row after which the run ends: the model keeps proposing what `instructions` do not ask for,
   * which is what an instruction that cannot be carried out looks like. Default 2.
   */
  maxRefusals?: number;
};

export const REVIEW_QUESTION = "__review__";
export const READY_QUESTION = "__ready__";
export const wantedId = (tool: string) => `__wanted__.${tool}`;
export const DEFAULT_REVIEW_THRESHOLD = 0.5;
export const DEFAULT_MAX_REFUSALS = 2;

/** The default wording of the question every step asks. */
export const TOOL_QUESTION_TEXT = "Which action best advances `instructions`, given `state` and `previous_actions`?";
/** The reworded one: carry out what is asked, nothing more, and stop when it is done or cannot be done. */
export const STRICT_TOOL_QUESTION_TEXT = "Which single action should come next to carry out exactly what `instructions` ask, no more and no less, given `state` and `previous_actions`? Choose `end` only when everything that `instructions` ask for has been done, or cannot be done with the other actions.";
export const STRICT_END_DESCRIPTION = "Stops, because everything that `instructions` ask for has been done according to `state`, or because none of the other actions can do what is left.";

const describe = (tools: AnyTool[]) => tools.map((t) => `${t.name} (${t.description})`).join("; ");

/** "Is there still work?": true means yes, an available action would carry `instructions` further than `state` shows. */
export function remainingQuestion(others: AnyTool[]): Question {
  return {
    type: "noul",
    instructions: `Looking at \`state\` and \`previous_actions\`, would one of these actions carry \`instructions\` further than they already are: ${describe(others)}?`,
    criteria: {
      true: "An action would take it further: a part of `instructions` is missing from `state`, or was only started or prepared (chosen but not confirmed, put aside but not paid, compared but not acted on, passed through but not reached)",
      false: "`state` shows everything that `instructions` ask for as done and finished, or no action could do what is left; any action left would be something `instructions` do not ask for",
    },
  };
}

const show = (v: unknown): string => (typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v));
export const describeCall = (tool: AnyTool, args: Record<string, unknown>) =>
  `${tool.name}(${Object.entries(args).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${show(v)}`).join(", ")})`;

/** The tool's own "do `instructions` still call for this?" question. */
export function wantedQuestion(text: string): Question {
  return { type: "noul", instructions: text, criteria: { true: "Yes, `instructions` call for it", false: "No, `instructions` do not call for it" } };
}

/** What a call does, as the review shows it: the tool's own phrase, else `name(args)` and its description. */
export function callPhrase(tool: AnyTool, args: Record<string, unknown>, ctx: AvailabilityContext): string {
  return tool.summarize?.(args as never, ctx) ?? `${describeCall(tool, args)}, which ${tool.description.charAt(0).toLowerCase()}${tool.description.slice(1)}`;
}

/** "Is this action asked for?": true means yes. */
export function askedQuestion(phrase: string): Question {
  return {
    type: "noul",
    instructions: `Do \`instructions\` ask for this: ${phrase}?`,
    criteria: {
      true: "`instructions` ask for it, or it is a plain part of getting what they ask for done and finished (choosing, confirming, paying), on this very item and with these values",
      false: "`instructions` do not ask for it: they name another item, team, status or tag, or say nothing about this kind of change",
    },
  };
}

/** "Is this the right moment?": true means doing it now keeps every part of `instructions` that is still to do possible. */
export function readyQuestion(phrase: string, others: AnyTool[]): Question {
  return {
    type: "noul",
    instructions: `If this is done now: ${phrase}, can every part of \`instructions\` that is still to do (not counting this one) be done afterwards with these actions: ${describe(others)}?`,
    criteria: {
      true: "Everything else that is still to do can be done afterwards, or nothing else is left to do",
      false: "Doing it now would stop another part of `instructions` that is still to do from being done, so that part has to come first",
    },
  };
}
