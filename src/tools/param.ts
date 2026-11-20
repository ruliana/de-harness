/**
 * Parameter specs. Each parameter becomes one question (id `<tool>.<param>`) and its answer is converted to a
 * typed value before `run` is called. Free text is never generated: options are supplied by code.
 *
 *   param.choice({ question, options })  -> Choice;  value: the chosen key (literal union when options are static)
 *   param.noul({ question })             -> Noul;    value: boolean from thresholds 0.7 / 0.3, or 'unsure' in between
 *   param.score({ question, levels })    -> Score;   value: the label of the most probable level
 *   param.set({ question, members })     -> one Noul per member (`{}` in the question is the member); value: the members above the yes threshold
 *   param.box({ question, image })       -> Box + a companion Noul (`<param>?present`); value: { top, bottom, left, right } or null
 *
 * Any spec takes `optional: { stated }`: one more Noul asks whether the value is stated at all, and the value is
 * `undefined` unless that answer is above the yes threshold. Noul-based specs (noul, set members, stated) take
 * `thresholds: { yes, no }` (default 0.7 / 0.3); the raw probabilities are in `ctx.answers` for code that wants more.
 *
 * Questions must stand alone: they cannot see each other's answers. Name the subject by state path in backticks
 * (`state.room.doors`, `instructions`) and ask one concrete judgment.
 */
import type { Box } from "../model/types.js";
import type { StateView } from "../state/state.js";

/** Candidate values: names, or name -> description of when it applies. Names are sent to the model, so make them descriptive. */
export type Options = readonly string[] | Readonly<Record<string, string>>;

export type ParamContext = { state: StateView; step: number };

/** A Noul answer at or above `yes` reads as true, at or below `no` as false, in between as 'unsure'. Defaults 0.7 / 0.3. */
export type Thresholds = { yes?: number; no?: number };

/** Makes the value optional: one extra Noul asks whether `instructions` state it at all. */
export type Optional = { stated: string; thresholds?: Thresholds };

/** Shared by every spec. `_optional` is a type-level marker only: when true the value may be `undefined`. */
type Common<Opt extends boolean> = { optional?: Optional; readonly _optional?: Opt };
type IsOptional<Opt extends Optional | undefined> = Opt extends Optional ? true : false;

export type ChoiceSpec<V extends string = string, Opt extends boolean = false> = Common<Opt> & {
  kind: "choice";
  question: string;
  /** Static, or computed from the state at the moment the question is built. */
  options: Options | ((ctx: ParamContext) => Options);
  readonly _value?: V;
};
export type NoulSpec<Opt extends boolean = false> = Common<Opt> & {
  kind: "noul";
  question: string;
  thresholds?: Thresholds;
  /** What counts as yes / no, as concrete situations. */
  criteria?: { true?: string; false?: string };
  readonly _value?: boolean | "unsure";
};
export type ScoreSpec<L extends string = string, Opt extends boolean = false> = Common<Opt> & {
  kind: "score";
  question: string;
  /** Ordered from the lowest level to the highest. Each is a situation that makes sense on its own. */
  levels: Readonly<Record<L, string>>;
  readonly _value?: L;
};

export type SetSpec<V extends string = string, Opt extends boolean = false> = Common<Opt> & {
  kind: "set";
  /** Contains `{}` where the member goes, so each member is its own yes / no question. */
  question: string;
  /** Static, or computed from the state at the moment the question is built. One Noul is asked per member. */
  members: readonly string[] | ((ctx: ParamContext) => readonly string[]);
  thresholds?: Thresholds;
  readonly _value?: V[];
};

export type BoxSpec<Opt extends boolean = false> = Common<Opt> & {
  kind: "box";
  /**
   * What to find, as a noun phrase that names the image by state path: "the button that `instructions` say to click, in
   * `state.screen`". It is not a question: a Box always answers with a box, even when nothing fits.
   */
  question: string;
  /** Where the image lives, as a state path (`state.screen`). The tool is left out of a step while that slot holds no image. */
  image: string;
  /** The companion Noul: is the target there at all? The default asks whether anything in `image` matches `question`. */
  present?: string;
  thresholds?: Thresholds;
  readonly _value?: Box | null;
};

export type ParamSpec = ChoiceSpec<any, any> | NoulSpec<any> | ScoreSpec<any, any> | SetSpec<any, any> | BoxSpec<any>;
export type Params = Record<string, ParamSpec>;

/** A Box value is `null` when the companion Noul says the target is not in the image, so only `undefined` is excluded. */
export type ValueOf<S extends ParamSpec> = S extends { readonly _optional?: true } ? Exclude<S["_value"], undefined> | undefined : Exclude<S["_value"], undefined>;
/** The typed arguments `run` receives. */
export type ArgsOf<P extends Params> = { [K in keyof P]: ValueOf<P[K]> };

function choice<const O extends Options, Opt extends Optional | undefined = undefined>(spec: { question: string; options: O; optional?: Opt }): ChoiceSpec<O extends readonly (infer U extends string)[] ? U : Extract<keyof O, string>, IsOptional<Opt>>;
function choice<Opt extends Optional | undefined = undefined>(spec: { question: string; options: (ctx: ParamContext) => Options; optional?: Opt }): ChoiceSpec<string, IsOptional<Opt>>;
function choice(spec: { question: string; options: Options | ((ctx: ParamContext) => Options); optional?: Optional }): ChoiceSpec<any, any> {
  return { kind: "choice", ...spec };
}

function set<const M extends readonly string[], Opt extends Optional | undefined = undefined>(spec: { question: string; members: M; thresholds?: Thresholds; optional?: Opt }): SetSpec<M[number], IsOptional<Opt>>;
function set<Opt extends Optional | undefined = undefined>(spec: { question: string; members: (ctx: ParamContext) => readonly string[]; thresholds?: Thresholds; optional?: Opt }): SetSpec<string, IsOptional<Opt>>;
function set(spec: { question: string; members: readonly string[] | ((ctx: ParamContext) => readonly string[]); thresholds?: Thresholds; optional?: Optional }): SetSpec<any, any> {
  if (!spec.question.includes(MEMBER)) throw new Error(`A set question must contain ${MEMBER} where the member goes, got: ${spec.question}`);
  if (spec.thresholds) checkThresholds(spec.thresholds);
  if (spec.optional?.thresholds) checkThresholds(spec.optional.thresholds);
  return { kind: "set", ...spec };
}

export const param = {
  choice,
  set,
  box: <Opt extends Optional | undefined = undefined>(spec: { question: string; image: string; present?: string; thresholds?: Thresholds; optional?: Opt }): BoxSpec<IsOptional<Opt>> => {
    if (spec.thresholds) checkThresholds(spec.thresholds);
    if (spec.optional?.thresholds) checkThresholds(spec.optional.thresholds);
    return { kind: "box", ...spec } as BoxSpec<any>;
  },
  noul: <Opt extends Optional | undefined = undefined>(spec: { question: string; criteria?: { true?: string; false?: string }; thresholds?: Thresholds; optional?: Opt }): NoulSpec<IsOptional<Opt>> => {
    if (spec.thresholds) checkThresholds(spec.thresholds);
    if (spec.optional?.thresholds) checkThresholds(spec.optional.thresholds);
    return { kind: "noul", ...spec } as NoulSpec<any>;
  },
  score: <const L extends Readonly<Record<string, string>>, Opt extends Optional | undefined = undefined>(spec: { question: string; levels: L; optional?: Opt }): ScoreSpec<Extract<keyof L, string>, IsOptional<Opt>> => ({ kind: "score", ...spec }) as ScoreSpec<any, any>,
};

/** Where the member goes in the question of a set. */
export const MEMBER = "{}";

/** Defaults for every Noul-based answer. */
export const defaultThresholds = { yes: 0.7, no: 0.3 };

function checkThresholds(t: Thresholds): void {
  const { yes, no } = { ...defaultThresholds, ...t };
  if (!(0 <= no && no <= yes && yes <= 1)) throw new Error(`Thresholds must satisfy 0 <= no <= yes <= 1, got yes=${yes} no=${no}`);
}

/** Reads a Noul probability against thresholds: true at or above `yes`, false at or below `no`, else 'unsure'. */
export function readNoul(p: number, t: Thresholds = {}): boolean | "unsure" {
  const { yes, no } = { ...defaultThresholds, ...t };
  return p >= yes ? true : p <= no ? false : "unsure";
}

export function normalizeOptions(options: Options): Record<string, string> {
  return Array.isArray(options) ? Object.fromEntries((options as readonly string[]).map((o) => [o, ""])) : { ...(options as Record<string, string>) };
}
