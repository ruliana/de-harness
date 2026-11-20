/**
 * Parameter specs. Each parameter becomes one question (id `<tool>.<param>`) and its answer is converted to a
 * typed value before `run` is called. Free text is never generated: options are supplied by code.
 *
 *   param.choice({ question, options })  -> Choice;  value: the chosen key (literal union when options are static)
 *   param.noul({ question })             -> Noul;    value: boolean from thresholds 0.7 / 0.3, or 'unsure' in between
 *   param.score({ question, levels })    -> Score;   value: the label of the most probable level
 *
 * Questions must stand alone: they cannot see each other's answers. Name the subject by state path in backticks
 * (`state.room.doors`, `instructions`) and ask one concrete judgment.
 */
import type { StateView } from "../state/state.js";

/** Candidate values: names, or name -> description of when it applies. Names are sent to the model, so make them descriptive. */
export type Options = readonly string[] | Readonly<Record<string, string>>;

export type ParamContext = { state: StateView; step: number };

export type ChoiceSpec<V extends string = string> = {
  kind: "choice";
  question: string;
  /** Static, or computed from the state at the moment the question is built. */
  options: Options | ((ctx: ParamContext) => Options);
  readonly _value?: V;
};
export type NoulSpec = {
  kind: "noul";
  question: string;
  /** What counts as yes / no, as concrete situations. */
  criteria?: { true?: string; false?: string };
  readonly _value?: boolean | "unsure";
};
export type ScoreSpec<L extends string = string> = {
  kind: "score";
  question: string;
  /** Ordered from the lowest level to the highest. Each is a situation that makes sense on its own. */
  levels: Readonly<Record<L, string>>;
  readonly _value?: L;
};

export type ParamSpec = ChoiceSpec<any> | NoulSpec | ScoreSpec<any>;
export type Params = Record<string, ParamSpec>;

export type ValueOf<S extends ParamSpec> = NonNullable<S["_value"]>;
/** The typed arguments `run` receives. */
export type ArgsOf<P extends Params> = { [K in keyof P]: ValueOf<P[K]> };

function choice<const O extends Options>(spec: { question: string; options: O }): ChoiceSpec<O extends readonly (infer U extends string)[] ? U : Extract<keyof O, string>>;
function choice(spec: { question: string; options: (ctx: ParamContext) => Options }): ChoiceSpec<string>;
function choice(spec: { question: string; options: Options | ((ctx: ParamContext) => Options) }): ChoiceSpec<any> {
  return { kind: "choice", ...spec };
}

export const param = {
  choice,
  noul: (spec: { question: string; criteria?: { true?: string; false?: string } }): NoulSpec => ({ kind: "noul", ...spec }),
  score: <const L extends Readonly<Record<string, string>>>(spec: { question: string; levels: L }): ScoreSpec<Extract<keyof L, string>> => ({ kind: "score", ...spec }) as ScoreSpec<Extract<keyof L, string>>,
};

export function normalizeOptions(options: Options): Record<string, string> {
  return Array.isArray(options) ? Object.fromEntries((options as readonly string[]).map((o) => [o, ""])) : { ...(options as Record<string, string>) };
}
