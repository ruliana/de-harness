/**
 * Runs one scenario with one arm and reads the outcome from the world, never from the agent. Same model, same tools, same
 * instructions and the same external verifier for every arm; only how the next action is chosen differs.
 */
import { createAgent, type AgentConfig, type DecisionModel, type LookaheadConfig, type RunResult } from "../../../src/index.js";
import type { Scenario, World } from "./worlds.js";

export type Arm = { id: string; label: string; config: (w: World) => Pick<AgentConfig, "review" | "lookahead">; /** The instructions this arm gives the agent. Default: the scenario's. */ instructions?: (base: string, w: World) => string };

const lookahead = (w: World, c: LookaheadConfig): Pick<AgentConfig, "lookahead"> => ({ lookahead: { requirements: w.requirements, constraints: w.constraints, ...c } });

export const ARMS: Arm[] = [
  { id: "greedy", label: "greedy", config: () => ({}) },
  {
    id: "criteria",
    label: "greedy, told the requirements and constraints",
    config: () => ({}),
    // what the planner is told, written into the instructions: separates "knowing what done means" from "searching"
    instructions: (base, w) => {
      const text = (c: (typeof w.requirements)[number]) => (typeof c === "string" ? c : c.text);
      return `${base} It is done when: ${w.requirements.map(text).join("; ")}.${w.constraints.length ? ` At all times: ${w.constraints.map(text).join("; ")}.` : ""}`;
    },
  },
  { id: "review", label: "greedy + review", config: () => ({ review: { end: true, actions: true } }) },
  { id: "la-3x1", label: "lookahead width 3, depth 1", config: (w) => lookahead(w, { width: 3, depth: 1 }) },
  { id: "la-1x2", label: "lookahead width 1, depth 2", config: (w) => lookahead(w, { width: 1, depth: 2 }) },
  { id: "la-3x2", label: "lookahead width 3, depth 2", config: (w) => lookahead(w, { width: 3, depth: 2 }) },
  { id: "la-3x3", label: "lookahead width 3, depth 3", config: (w) => lookahead(w, { width: 3, depth: 3 }) },
  { id: "la-3x2g", label: "lookahead 3x2, greedy when nothing gains", config: (w) => lookahead(w, { width: 3, depth: 2, onNoGain: "greedy" }) },
];

export type Outcome = {
  scenario: string;
  kind: string;
  arm: string;
  /** Every external check true at the end and no limit ever broken. */
  complete: boolean;
  failed: string[];
  /** Times a check that was true became false. */
  regressions: number;
  /** Steps after which a limit was broken. */
  violations: number;
  status: RunResult["status"];
  steps: number;
  /** Requests to the model. */
  requests: number;
  ms: number;
  trail: string[];
  /** The planner's own words when it ended the run. */
  stopped?: { complete: boolean; unmet: string[]; blocker?: string };
  error?: string;
};

export async function runArm(sc: Scenario, arm: Arm, model: DecisionModel): Promise<Outcome> {
  const world = sc.make();
  let before = world.probe();
  let regressions = 0;
  let violations = 0;
  const started = Date.now();
  const result = await createAgent({
    model,
    instructions: arm.instructions ? arm.instructions(sc.instructions, world) : sc.instructions,
    tools: world.tools,
    initialState: world.initialState,
    maxSteps: sc.maxSteps,
    ...arm.config(world),
    onEvent: (e) => {
      if (e.type !== "tool_result") return;
      const now = world.probe();
      regressions += [...Object.keys(before.checks).filter((k) => before.checks[k] && !now.checks[k]), ...Object.keys(before.limits).filter((k) => before.limits[k] && !now.limits[k])].length;
      violations += Object.values(now.limits).some((ok) => !ok) ? 1 : 0;
      before = now;
    },
  }).run();
  const ms = Date.now() - started;
  const { checks, limits } = world.probe();
  const failed = [...Object.keys(checks).filter((k) => !checks[k]), ...Object.keys(limits).filter((k) => !limits[k])];
  const out = result.output as { complete?: boolean; unmet?: string[]; blocker?: string } | undefined;
  return {
    scenario: sc.id,
    kind: sc.kind,
    arm: arm.id,
    complete: failed.length === 0 && violations === 0,
    failed,
    regressions,
    violations,
    status: result.status,
    steps: result.steps.length,
    requests: result.events.filter((e) => e.type === "request").length,
    ms,
    trail: result.steps.map((s) => `${s.tool}(${Object.values(s.args).join(", ")})`),
    ...(arm.id.startsWith("la-") && out && "complete" in out ? { stopped: { complete: out.complete!, unmet: out.unmet ?? [], ...(out.blocker ? { blocker: out.blocker } : {}) } } : {}),
    ...(result.error ? { error: result.error.message } : {}),
  };
}
