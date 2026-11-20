/**
 * Builds the step's question map and parses answers back into typed arguments.
 * The wording of the tool question is fixed here; the wording of each parameter question lives with its tool.
 */
import type { Answer, Question } from "../model/types.js";
import { normalizeOptions, type ParamContext, type ParamSpec } from "../tools/param.js";
import type { AnyTool } from "../tools/tool.js";

export const TOOL_QUESTION = "__tool__";
export const questionId = (tool: string, param: string) => `${tool}.${param}`;

/** Most options a Choice accepts. */
const MAX_OPTIONS = 255;

/** Noul above `yes` reads as yes, below `no` as no, in between as 'unsure'. */
export const thresholds = { yes: 0.7, no: 0.3 };

export type QueryPlan = {
  questions: Record<string, Question>;
  /** Tools that are part of this step's question. */
  tools: AnyTool[];
  /** Tools left out because a parameter had no candidates. */
  skipped: { tool: string; reason: string }[];
  /** Resolved choice options per question id, to validate answers. */
  options: Record<string, string[]>;
};

export function buildQuestions(tools: AnyTool[], ctx: ParamContext): QueryPlan {
  const questions: Record<string, Question> = {};
  const options: Record<string, string[]> = {};
  const used: AnyTool[] = [];
  const skipped: QueryPlan["skipped"] = [];

  for (const tool of tools) {
    const own: Record<string, Question> = {};
    let reason: string | undefined;
    for (const [name, spec] of Object.entries((tool.params ?? {}) as Record<string, ParamSpec>)) {
      const id = questionId(tool.name, name);
      if (spec.kind === "choice") {
        const resolved = normalizeOptions(typeof spec.options === "function" ? spec.options(ctx) : spec.options);
        const keys = Object.keys(resolved);
        if (keys.length === 0) {
          reason = `parameter "${name}" has no candidates`;
          break;
        }
        if (keys.length > MAX_OPTIONS) throw new Error(`Parameter "${name}" of tool "${tool.name}" has ${keys.length} options, more than ${MAX_OPTIONS}. Narrow them in code first.`);
        own[id] = { type: "choice", instructions: spec.question, criteria: resolved };
        options[id] = keys;
      } else if (spec.kind === "noul") {
        own[id] = { type: "noul", instructions: spec.question, ...(spec.criteria ? { criteria: spec.criteria } : {}) };
      } else {
        own[id] = { type: "score", instructions: spec.question, criteria: Object.values(spec.levels) as string[] };
      }
    }
    if (reason) skipped.push({ tool: tool.name, reason });
    else {
      used.push(tool);
      Object.assign(questions, own);
    }
  }

  return {
    questions: {
      [TOOL_QUESTION]: {
        type: "choice",
        instructions: "Which action best advances `instructions`, given `state` and `previous_actions`?",
        criteria: Object.fromEntries(used.map((t) => [t.name, t.description])),
      },
      ...questions,
    },
    tools: used,
    skipped,
    options,
  };
}

export class AnswerError extends Error {}

/** The tool the model picked. */
export function pickedTool(answers: Record<string, Answer>, plan: QueryPlan): AnyTool {
  const a = answers[TOOL_QUESTION];
  if (!a || a.type !== "choice") throw new AnswerError(`The model did not answer the tool question`);
  const tool = plan.tools.find((t) => t.name === a.choice);
  if (!tool) throw new AnswerError(`The model chose "${a.choice}", which is not an available tool`);
  return tool;
}

/** Typed arguments of the picked tool; only its answers are read. */
export function parseArgs(tool: AnyTool, answers: Record<string, Answer>, plan: QueryPlan): { args: Record<string, unknown>; raw: Record<string, Answer> } {
  const args: Record<string, unknown> = {};
  const raw: Record<string, Answer> = {};
  for (const [name, spec] of Object.entries((tool.params ?? {}) as Record<string, ParamSpec>)) {
    const id = questionId(tool.name, name);
    const a = answers[id];
    if (!a) throw new AnswerError(`The model did not answer "${id}"`);
    raw[name] = a;
    if (spec.kind === "choice") {
      if (a.type !== "choice") throw new AnswerError(`"${id}" should be a choice answer`);
      if (!plan.options[id]?.includes(a.choice)) throw new AnswerError(`The model chose "${a.choice}" for "${id}", which is not one of its options`);
      args[name] = a.choice;
    } else if (spec.kind === "noul") {
      if (a.type !== "noul") throw new AnswerError(`"${id}" should be a noul answer`);
      args[name] = a.noul >= thresholds.yes ? true : a.noul <= thresholds.no ? false : "unsure";
    } else {
      if (a.type !== "score") throw new AnswerError(`"${id}" should be a score answer`);
      const labels = Object.keys(spec.levels);
      const top = Object.entries(a.probabilities).reduce((best, e) => (e[1] > best[1] ? e : best), ["0", -1] as [string, number]);
      const label = labels[Number(top[0])];
      if (label === undefined) throw new AnswerError(`The model scored "${id}" at level ${top[0]}, which does not exist`);
      args[name] = label;
    }
  }
  return { args, raw };
}
