/**
 * Opt-in short-horizon lookahead with replanning (`AgentConfig.lookahead`). Jev proposes, code searches and decides.
 *
 * Every step the agent does not ask "which action looks best now?" but "which short sequence of actions produces the best
 * verifiable state, and what is its first action?":
 *
 *   1. baseline   the real state is judged against the goal: the `requirements` (observable completion criteria) and the
 *                 `constraints` (hard rules that must hold after every action). All requirements met: the run ends.
 *   2. shortlist  one request over the same questions as a normal step: Jev's `__tool__` Choice and the Choice of each
 *                 parameter give probabilities; code turns them into the `width` most probable (tool, arguments) pairs.
 *                 A probability is a reason to look at an action, not evidence that it helps.
 *   3. preview    each pair is applied to a copy of the state through the tool's `preview` (it must not touch the outside
 *                 world). A tool without `preview` cannot be looked ahead through: its outcome is only a hypothesis.
 *   4. evaluate   every resulting state is judged against the same requirements and constraints (one request per distinct
 *                 state, in parallel, one Noul per criterion; a criterion with a `check` is decided by code and costs
 *                 nothing). Requirements that were met in the real state are rechecked, so an action that breaks one shows up.
 *   5. deepen     the best `width` states are expanded the same way, down to `depth` actions.
 *   6. commit     the FIRST action of the best sequence runs for real. The real result is observed, and the next step
 *                 plans again from it; the rest of the plan is thrown away.
 *   7. stop       when every requirement is met, or when no explored sequence improves on the unchanged state: the run ends
 *                 and says which requirements are unmet and why nothing was tried.
 *
 * Questions are built here from the criteria text the agent author supplied: Jev cannot write text.
 */
import { DecisionModelError, type Answer, type DecisionResponse, type Question } from "../model/types.js";
import { TOOL_QUESTION, buildQuestions, parseArgs, type QueryPlan } from "../questions/build.js";
import type { PreviousAction, StateView, Json } from "../state/state.js";
import { readNoul, type ChoiceSpec, type ParamSpec, type Thresholds } from "../tools/param.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { AnyTool } from "../tools/tool.js";
import { describeCall, TOOL_QUESTION_TEXT } from "../review/review.js";

/** A requirement or a constraint: a plain statement about `state` for Jev to judge, optionally with a check in code that decides instead. */
export type Criterion = string | { text: string; check?: (state: StateView) => boolean };

export type LookaheadConfig = {
  /** Candidates explored per state, and states kept per level. Default 3. */
  width?: number;
  /** Actions looked ahead. Default 2. */
  depth?: number;
  /**
   * What must be true for `instructions` to be carried out, as statements that name state by path
   * (`Every item the customer asked for is in \`state.basket\`.`). The run ends when all hold. Default: one requirement,
   * "everything that `instructions` ask for has been done".
   */
  requirements?: Criterion[];
  /** What must hold after every action, whatever the plan: a sequence that breaks one is dropped. */
  constraints?: Criterion[];
  /** Cuts for Jev's yes/no judgments (default 0.7 / 0.3): a requirement is met only at or above `yes`, a constraint is broken only at or below `no`. */
  thresholds?: Thresholds;
  /** How much a sequence has to gain over the unchanged state, in requirements, before its first action is taken. Default 0.25. */
  minGain?: number;
  /** What breaking a requirement that was met costs, in requirements. Default 1. */
  regressionPenalty?: number;
  /**
   * What to do when no explored sequence improves on the current state. `stop` (default) ends the run and reports the unmet
   * requirements and the blocker. `greedy` takes the most probable explored action that does not break a constraint, undo a
   * met requirement or loop back, and observes: for tasks whose requirements do not measure the way there (navigation).
   */
  onNoGain?: "stop" | "greedy";
};

/** What the agent hands the planner each step. */
export type PlanRound = {
  step: number;
  instructions: string;
  /** The real state. */
  view: StateView;
  /** The real previous actions that are shown (already windowed). */
  history: PreviousAction[];
  /** How many previous actions a request shows. */
  window: number;
  /** The live registry, handed to `preview` like to any availability check. */
  registry: ToolRegistry;
  /** Tools available now, `end` included (the planner ends the run itself and leaves it out). */
  tools: AnyTool[];
  /** Tools available in a state that does not exist yet. */
  available: (state: StateView) => AnyTool[];
  /** One request to the model with an arbitrary state document. */
  ask: (phase: "shortlist" | "evaluate", doc: Record<string, unknown>, questions: Record<string, Question>) => Promise<DecisionResponse>;
};

export type Move = { tool: AnyTool; args: Record<string, unknown>; call: string; p: number; summary?: string };

export type Plan =
  | {
      kind: "act";
      tool: AnyTool;
      args: Record<string, unknown>;
      raw: Record<string, Answer>;
      /** The sequence the first action belongs to, as calls. */
      sequence: string[];
      /** "plan": a looked-ahead sequence improves on the unchanged state; "explore": a tool with no preview, tried because nothing else helps. */
      why: "plan" | "explore";
    }
  | { kind: "stop"; reason: "complete" | "blocked"; unmet: string[]; blocker?: string; /** constraints already broken when the run stopped */ broken?: string[] };

export type SearchEvent = {
  baseline: { score: number; met: string[]; unmet: string[] };
  nodes: { sequence: string[]; score: number; gain: number; regressed: string[]; broken: string[]; complete: boolean }[];
  chosen?: string[];
  decision: "act" | "explore" | "complete" | "blocked";
};

type Eval = { req: number[]; con: number[] };
type Node = { slots: Record<string, Json>; path: Move[]; ev: Eval; score: number; regressed: number[]; broken: number[]; complete: boolean; prior: number };

const norm = (c: Criterion) => (typeof c === "string" ? { text: c } : c);

/** Stable JSON: object keys sorted, so equal states have equal keys. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** A requirement is met only when `state` shows it; a constraint is broken only when `state` shows it broken (an empty slot breaks nothing). */
const criterionQuestion = (text: string, kind: "requirement" | "constraint"): Question =>
  kind === "requirement"
    ? {
        type: "noul",
        instructions: `Going by \`state\`, is this true: ${text}`,
        criteria: { true: "Yes: `state` shows that it is true", false: "No: `state` shows that it is not true, or does not show that it is" },
      }
    : {
        type: "noul",
        instructions: `Going by \`state\`, does this hold: ${text}`,
        criteria: { true: "Yes: it holds, or nothing in `state` contradicts it", false: "No: `state` shows that it is broken" },
      };

const DEFAULT_REQUIREMENT = "Everything that `instructions` ask for has been done.";

export class Planner {
  private readonly width: number;
  private readonly depth: number;
  private readonly reqs: { text: string; check?: (s: StateView) => boolean }[];
  private readonly cons: { text: string; check?: (s: StateView) => boolean }[];
  private readonly minGain: number;
  private readonly penalty: number;
  private readonly memo = new Map<string, Promise<DecisionResponse>>();
  /** Real states the run has been in, to catch loops. */
  private readonly visited = new Set<string>();
  /** Calls already run in a state (an opaque one tried to see what it does, or any one whose real result left the state as it was). */
  private readonly explored = new Set<string>();

  constructor(private readonly config: LookaheadConfig) {
    this.width = Math.max(1, Math.floor(config.width ?? 3));
    this.depth = Math.max(1, Math.floor(config.depth ?? 2));
    this.reqs = (config.requirements?.length ? config.requirements : [DEFAULT_REQUIREMENT]).map(norm);
    this.cons = (config.constraints ?? []).map(norm);
    this.minGain = config.minGain ?? 0.25;
    this.penalty = config.regressionPenalty ?? 1;
  }

  private read(p: number) {
    return readNoul(p, this.config.thresholds);
  }

  /** One request per distinct (phase, state, questions): equal states reached twice are asked about once. */
  private once(round: PlanRound, phase: "shortlist" | "evaluate", doc: Record<string, unknown>, questions: Record<string, Question>): Promise<DecisionResponse> {
    const key = `${phase}\n${canonical(doc)}\n${canonical(questions)}`;
    let hit = this.memo.get(key);
    if (!hit) {
      hit = round.ask(phase, doc, questions);
      this.memo.set(key, hit);
    }
    return hit;
  }

  /** The state judged against every requirement and constraint. Criteria with a `check` never reach the model. */
  private async evaluate(round: PlanRound, slots: Record<string, Json>): Promise<Eval> {
    const questions: Record<string, Question> = {};
    this.reqs.forEach((c, i) => {
      if (!c.check) questions[`req.${i}`] = criterionQuestion(c.text, "requirement");
    });
    this.cons.forEach((c, i) => {
      if (!c.check) questions[`con.${i}`] = criterionQuestion(c.text, "constraint");
    });
    const answers = Object.keys(questions).length ? (await this.once(round, "evaluate", { instructions: round.instructions, state: slots }, questions)).answers : {};
    const p = (id: string, c: { check?: (s: StateView) => boolean }): number => {
      if (c.check) return c.check(slots) ? 1 : 0;
      const a = answers[id];
      if (a?.type !== "noul") throw new DecisionModelError(`The model did not answer the criterion "${id}"`);
      return a.noul;
    };
    return { req: this.reqs.map((c, i) => p(`req.${i}`, c)), con: this.cons.map((c, i) => p(`con.${i}`, c)) };
  }

  private metOf(ev: Eval): boolean[] {
    return ev.req.map((p) => this.read(p) === true);
  }

  /** The legal (tool, arguments) pairs worth looking at in a state: the most probable by Jev's Choices, with the tools that cannot be previewed apart. */
  private async shortlist(round: PlanRound, slots: Record<string, Json>, path: Move[], tools: AnyTool[]): Promise<{ moves: Move[]; plan: QueryPlan; answers: Record<string, Answer> } | undefined> {
    const plan = buildQuestions(tools, { state: slots, step: round.step }, { toolQuestion: TOOL_QUESTION_TEXT });
    if (plan.tools.length === 0) return undefined;
    const shown = [...round.history, ...path.map((m) => ({ tool: m.tool.name, args: m.args, summary: m.summary ?? m.call }))].slice(-Math.max(round.window, path.length));
    const doc: Record<string, unknown> = { instructions: round.instructions, state: slots, ...(round.window > 0 ? { previous_actions: shown } : {}) };
    const { answers } = await this.once(round, "shortlist", doc, plan.questions);
    return { moves: this.moves(plan, answers), plan, answers };
  }

  /** (tool, arguments) pairs by joint probability: P(tool) times P(option) of each Choice parameter. Everything else in the arguments is read as usual. */
  private moves(plan: QueryPlan, answers: Record<string, Answer>): Move[] {
    const toolAnswer = answers[TOOL_QUESTION];
    if (toolAnswer?.type !== "choice") return [];
    const out: Move[] = [];
    for (const tool of plan.tools) {
      const pTool = toolAnswer.probabilities[tool.name] ?? (toolAnswer.choice === tool.name ? 1 : 0);
      let base: Record<string, unknown>;
      try {
        base = parseArgs(tool, answers, plan).args;
      } catch {
        continue;
      }
      let combos: { args: Record<string, unknown>; p: number }[] = [{ args: base, p: pTool }];
      for (const [name, spec] of Object.entries((tool.params ?? {}) as Record<string, ParamSpec>)) {
        if (spec.kind !== "choice" || (spec as ChoiceSpec).optional) continue;
        const a = answers[`${tool.name}.${name}`];
        if (a?.type !== "choice") continue;
        const options = plan.options[`${tool.name}.${name}`] ?? [];
        const ranked = options
          .map((o, i) => ({ o, i, p: a.probabilities[o] ?? (a.choice === o ? 1 : 0) }))
          .sort((x, y) => y.p - x.p || x.i - y.i)
          .slice(0, this.width);
        combos = combos.flatMap((c) => ranked.map((r) => ({ args: { ...c.args, [name]: r.o }, p: c.p * r.p })));
      }
      for (const c of combos) out.push({ tool, args: c.args, call: describeCall(tool, c.args), p: c.p });
    }
    return out.sort((a, b) => b.p - a.p);
  }

  private apply(slots: Record<string, Json>, update: Record<string, Json | null> | undefined): Record<string, Json> {
    const next = structuredClone(slots);
    for (const [k, v] of Object.entries(update ?? {})) {
      if (v === null || v === undefined) delete next[k];
      else next[k] = structuredClone(v);
    }
    return next;
  }

  /** What the planner decides this step. */
  async next(round: PlanRound, trace: (e: SearchEvent) => void): Promise<Plan> {
    const root = structuredClone(round.view) as Record<string, Json>;
    const rootKey = canonical(root);
    this.visited.add(rootKey);

    const baseEv = await this.evaluate(round, root);
    const baseMet = this.metOf(baseEv);
    const reqText = (met: boolean) => this.reqs.filter((_, i) => baseMet[i] === met).map((c) => c.text);
    const baseScore = baseEv.req.reduce((a, b) => a + b, 0);
    const brokenAtRoot = new Set(baseEv.con.flatMap((p, i) => (this.read(p) === false ? [i] : [])));
    const baseline = { score: baseScore, met: reqText(true), unmet: reqText(false) };

    // every requirement met: done. A constraint that is broken already cannot be helped by more actions, and is reported.
    if (baseMet.every(Boolean)) {
      trace({ baseline, nodes: [], decision: "complete" });
      return { kind: "stop", reason: "complete", unmet: [], ...(brokenAtRoot.size ? { broken: [...brokenAtRoot].map((i) => this.cons[i]!.text) } : {}) };
    }

    const make = (parent: Node, move: Move, slots: Record<string, Json>, ev: Eval): Node => {
      const met = this.metOf(ev);
      const regressed = baseMet.flatMap((was, i) => (was && !met[i] ? [i] : []));
      const broken = ev.con.flatMap((p, i) => (this.read(p) === false && !brokenAtRoot.has(i) ? [i] : []));
      return {
        slots,
        path: [...parent.path, move],
        ev,
        score: ev.req.reduce((a, b) => a + b, 0) - this.penalty * regressed.length,
        regressed,
        broken,
        complete: met.every(Boolean),
        prior: parent.prior * Math.max(move.p, 1e-6),
      };
    };
    const rootNode: Node = { slots: root, path: [], ev: baseEv, score: baseScore, regressed: [], broken: [], complete: false, prior: 1 };

    const seen = new Set<string>([rootKey]);
    const searched: Node[] = [];
    let frontier: Node[] = [rootNode];
    let opaque: { move: Move; answers: Record<string, Answer>; plan: QueryPlan }[] = [];
    let rootShort: { plan: QueryPlan; answers: Record<string, Answer> } | undefined;

    for (let depth = 1; depth <= this.depth && frontier.length > 0; depth++) {
      // expand every state of the frontier: a shortlist, then a preview of each candidate
      const expansions = await Promise.all(
        frontier.map(async (node) => {
          const tools = (depth === 1 ? round.tools : round.available(node.slots)).filter((t) => t.name !== "end");
          const short = await this.shortlist(round, node.slots, node.path, tools);
          if (!short) return [];
          if (depth === 1) {
            rootShort = short;
            opaque = short.moves.filter((m) => !m.tool.preview).map((move) => ({ move, answers: short.answers, plan: short.plan }));
          }
          const out: { node: Node; move: Move; slots: Record<string, Json> }[] = [];
          const untried = (m: Move) => depth > 1 || !this.explored.has(`${rootKey}|${m.tool.name}|${canonical(m.args)}`);
          for (const move of short.moves.filter((m) => m.tool.preview && untried(m)).slice(0, this.width)) {
            try {
              const preview = await move.tool.preview!(move.args as never, { state: node.slots, step: round.step, tools: round.registry });
              out.push({ node, move: { ...move, ...(preview.summary !== undefined ? { summary: preview.summary } : {}) }, slots: this.apply(node.slots, preview.state) });
            } catch {
              // a preview that throws says the action is not possible here
            }
          }
          return out;
        }),
      );
      // a state seen before (the real one, or another branch's) adds nothing: it is a loop or a duplicate
      const fresh = expansions.flat().filter((e) => {
        const key = canonical(e.slots);
        if (seen.has(key) || this.visited.has(key)) return false;
        seen.add(key);
        return true;
      });
      const evals = await Promise.all(fresh.map((e) => this.evaluate(round, e.slots)));
      const children = fresh.map((e, i) => make(e.node, e.move, e.slots, evals[i]!));
      const kept = children.filter((n) => n.broken.length === 0);
      searched.push(...children);
      frontier = kept
        .filter((n) => !n.complete)
        .sort((a, b) => b.score - a.score || b.prior - a.prior)
        .slice(0, this.width);
    }

    const seq = (n: Node) => n.path.map((m) => m.call);
    const nodes = searched.map((n) => ({
      sequence: seq(n),
      score: n.score,
      gain: n.score - baseScore,
      regressed: n.regressed.map((i) => this.reqs[i]!.text),
      broken: n.broken.map((i) => this.cons[i]!.text),
      complete: n.complete,
    }));
    const eligible = searched.filter((n) => n.broken.length === 0);
    // the best state of any depth; of equal ones the shorter sequence, then the more probable
    const best = [...eligible].sort((a, b) => b.score - a.score || a.path.length - b.path.length || b.prior - a.prior)[0];

    if (best && (best.complete || best.score - baseScore >= this.minGain)) {
      const first = best.path[0]!;
      this.explored.add(`${rootKey}|${first.tool.name}|${canonical(first.args)}`);
      trace({ baseline, nodes, chosen: seq(best), decision: "act" });
      return { kind: "act", tool: first.tool, args: first.args, raw: this.rawOf(rootShort, first), sequence: seq(best), why: "plan" };
    }

    // nothing explored helps. A tool that cannot be previewed may still: try the most probable one once per state and observe.
    const untried = opaque.find((o) => !this.explored.has(`${rootKey}|${o.move.tool.name}|${canonical(o.move.args)}`));
    if (untried) {
      this.explored.add(`${rootKey}|${untried.move.tool.name}|${canonical(untried.move.args)}`);
      trace({ baseline, nodes, chosen: [untried.move.call], decision: "explore" });
      return { kind: "act", tool: untried.move.tool, args: untried.move.args, raw: this.rawOf(rootShort, untried.move), sequence: [untried.move.call], why: "explore" };
    }

    if (this.config.onNoGain === "greedy") {
      const step = eligible.filter((n) => n.path.length === 1 && n.regressed.length === 0).sort((a, b) => b.prior - a.prior)[0];
      if (step) {
        const first = step.path[0]!;
        this.explored.add(`${rootKey}|${first.tool.name}|${canonical(first.args)}`);
        trace({ baseline, nodes, chosen: [first.call], decision: "explore" });
        return { kind: "act", tool: first.tool, args: first.args, raw: this.rawOf(rootShort, first), sequence: [first.call], why: "explore" };
      }
    }

    const reason = searched.length === 0 ? "no legal action leads to a state not already seen" : `no sequence of up to ${this.depth} actions improves on the current state${eligible.length < searched.length ? " without breaking a constraint" : ""}`;
    trace({ baseline, nodes, decision: "blocked" });
    return { kind: "stop", reason: "blocked", unmet: reqText(false), blocker: reason };
  }

  private rawOf(short: { plan: QueryPlan; answers: Record<string, Answer> } | undefined, move: Move): Record<string, Answer> {
    if (!short) return {};
    try {
      return parseArgs(move.tool, short.answers, short.plan).raw;
    } catch {
      return {};
    }
  }
}
