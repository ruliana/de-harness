/**
 * Builds the step's question map and parses answers back into typed arguments.
 * The wording of the tool question is fixed here; the wording of each parameter question lives with its tool.
 */
import type { Answer, Question } from "../model/types.js";
import { isImageValue } from "../state/images.js";
import { MEMBER, defaultThresholds, normalizeOptions, readNoul, type ParamContext, type ParamSpec } from "../tools/param.js";
import type { AnyTool } from "../tools/tool.js";
import { TOOL_QUESTION_TEXT } from "../review/review.js";

export const TOOL_QUESTION = "__tool__";
export const questionId = (tool: string, param: string) => `${tool}.${param}`;
/** Question key (without the tool) of one member of a set parameter: `toppings[olives]`. */
export const memberKey = (param: string, member: string) => `${param}[${member}]`;
/** Question key (without the tool) of the "is it stated at all" Noul of an optional parameter: `delivery_time?stated`. */
export const statedKey = (param: string) => `${param}?stated`;
/** Question key (without the tool) of the companion Noul of a Box parameter, "is the target in the image at all?": `target?present`. */
export const presentKey = (param: string) => `${param}?present`;

/** The value at a state path such as `state.screen` or `state.page.screenshot`. */
function atPath(state: Readonly<Record<string, any>>, path: string): unknown {
  const parts = path.split(".");
  if (parts[0] === "state") parts.shift();
  let v: unknown = state;
  for (const p of parts) v = v && typeof v === "object" ? (v as Record<string, unknown>)[p] : undefined;
  return v;
}

/** Most options a Choice accepts. */
const MAX_OPTIONS = 255;

/** Default thresholds of every Noul-based answer: at or above `yes` reads as yes, at or below `no` as no, in between as 'unsure'. */
export const thresholds = defaultThresholds;

export type QueryPlan = {
  questions: Record<string, Question>;
  /** Tools that are part of this step's question. */
  tools: AnyTool[];
  /** Tools left out because a parameter had no candidates. */
  skipped: { tool: string; reason: string }[];
  /** Resolved choice options per question id, to validate answers. */
  options: Record<string, string[]>;
  /** Resolved members per set question key (`<tool>.<param>`), to read the answers back. */
  members: Record<string, string[]>;
};

export function buildQuestions(tools: AnyTool[], ctx: ParamContext, opts: { toolQuestion?: string } = {}): QueryPlan {
  const questions: Record<string, Question> = {};
  const options: Record<string, string[]> = {};
  const members: Record<string, string[]> = {};
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
      } else if (spec.kind === "box") {
        if (!isImageValue(atPath(ctx.state, spec.image))) {
          reason = `parameter "${name}" needs an image at \`${spec.image}\``;
          break;
        }
        own[id] = { type: "box", instructions: spec.question };
        own[questionId(tool.name, presentKey(name))] = { type: "noul", instructions: spec.present ?? `Is there anything in \`${spec.image}\` that matches this description: ${spec.question}?` };
      } else if (spec.kind === "noul") {
        own[id] = { type: "noul", instructions: spec.question, ...(spec.criteria ? { criteria: spec.criteria } : {}) };
      } else if (spec.kind === "set") {
        const list = [...(typeof spec.members === "function" ? spec.members(ctx) : spec.members)];
        if (list.length === 0) {
          reason = `parameter "${name}" has no members`;
          break;
        }
        if (new Set(list).size !== list.length) throw new Error(`Parameter "${name}" of tool "${tool.name}" has duplicate members: ${list.join(", ")}`);
        // one yes / no question per member, so members never split a probability between them
        for (const member of list) own[questionId(tool.name, memberKey(name, member))] = { type: "noul", instructions: spec.question.replaceAll(MEMBER, member) };
        members[id] = list;
      } else {
        own[id] = { type: "score", instructions: spec.question, criteria: Object.values(spec.levels) as string[] };
      }
      if (spec.optional) own[questionId(tool.name, statedKey(name))] = { type: "noul", instructions: spec.optional.stated };
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
        instructions: opts.toolQuestion ?? TOOL_QUESTION_TEXT,
        criteria: Object.fromEntries(used.map((t) => [t.name, t.description])),
      },
      ...questions,
    },
    tools: used,
    skipped,
    options,
    members,
  };
}

/** Phase one of a two-phase step: only the `__tool__` Choice, its options optionally in reverse order (the order check). */
export function toolQuestionOnly(plan: QueryPlan, reverse = false): Record<string, Question> {
  const q = plan.questions[TOOL_QUESTION] as Extract<Question, { type: "choice" }>;
  if (!reverse) return { [TOOL_QUESTION]: q };
  return { [TOOL_QUESTION]: { ...q, criteria: Object.fromEntries(Object.entries(q.criteria).reverse()) } };
}

/** Phase two of a two-phase step: only the questions of the chosen tool's parameters. */
export function paramQuestions(plan: QueryPlan, tool: AnyTool): Record<string, Question> {
  const out: Record<string, Question> = {};
  for (const name of Object.keys(tool.params ?? {})) {
    const id = questionId(tool.name, name);
    out[id] = plan.questions[id]!;
  }
  return out;
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

/** Typed arguments of the picked tool; only its answers are read. Raw answers are keyed like the questions, without the tool name. */
export function parseArgs(tool: AnyTool, answers: Record<string, Answer>, plan: QueryPlan): { args: Record<string, unknown>; raw: Record<string, Answer> } {
  const args: Record<string, unknown> = {};
  const raw: Record<string, Answer> = {};
  const take = (key: string, type: Answer["type"]): Answer => {
    const id = questionId(tool.name, key);
    const a = answers[id];
    if (!a) throw new AnswerError(`The model did not answer "${id}"`);
    if (a.type !== type) throw new AnswerError(`"${id}" should be a ${type} answer`);
    raw[key] = a;
    return a;
  };
  for (const [name, spec] of Object.entries((tool.params ?? {}) as Record<string, ParamSpec>)) {
    const id = questionId(tool.name, name);
    let value: unknown;
    if (spec.kind === "choice") {
      const a = take(name, "choice") as Extract<Answer, { type: "choice" }>;
      if (!plan.options[id]?.includes(a.choice)) throw new AnswerError(`The model chose "${a.choice}" for "${id}", which is not one of its options`);
      value = a.choice;
    } else if (spec.kind === "box") {
      const a = take(name, "box") as Extract<Answer, { type: "box" }>;
      // a Box always answers; only the companion Noul says whether the target is there ('unsure' counts as not found)
      const present = readNoul((take(presentKey(name), "noul") as Extract<Answer, { type: "noul" }>).noul, spec.thresholds);
      value = present === true ? a.box : null;
    } else if (spec.kind === "noul") {
      value = readNoul((take(name, "noul") as Extract<Answer, { type: "noul" }>).noul, spec.thresholds);
    } else if (spec.kind === "set") {
      const list = plan.members[id] ?? [];
      value = list.filter((member) => readNoul((take(memberKey(name, member), "noul") as Extract<Answer, { type: "noul" }>).noul, spec.thresholds) === true);
    } else {
      const a = take(name, "score") as Extract<Answer, { type: "score" }>;
      const labels = Object.keys(spec.levels);
      const top = Object.entries(a.probabilities).reduce((best, e) => (e[1] > best[1] ? e : best), ["0", -1] as [string, number]);
      const label = labels[Number(top[0])];
      if (label === undefined) throw new AnswerError(`The model scored "${id}" at level ${top[0]}, which does not exist`);
      value = label;
    }
    // optional: the value counts only when the model says it is stated (at or above `yes`); 'unsure' counts as not stated
    if (spec.optional) {
      const stated = readNoul((take(statedKey(name), "noul") as Extract<Answer, { type: "noul" }>).noul, spec.optional.thresholds);
      if (stated !== true) value = undefined;
    }
    args[name] = value;
  }
  return { args, raw };
}
