/**
 * The probe: do the screenshots of runs that worked tell Jev which tactic comes next?
 *
 * A run with the steps spelled out (examples/storefront-browser) produces one screenshot per step and the action taken on it. Each
 * action is named as a tactic by code, from the tool and from what code knew about the page (which the model never sees). Then
 * the deciding level looks at the same screenshot, alone, and picks a tactic. The probe counts how often the two agree.
 *
 * Three ways of asking, to show what helps:
 *   screen   the screenshot and the task
 *   done     + `state.done`, what has been done so far (taken from the real run, as a verifier would have written it)
 *   judged   + `state.judgments`, the answers to yes/no questions about the same screenshot
 */
import type { DecisionModel, Image, RunResult } from "../../src/index.js";
import { DONE, DONE_OPENED, judge, pickTactic, TACTIC_IDS, type Judgments, type PlannerState, type Tactic } from "./tactics.js";

export type Variant = "screen" | "done" | "judged";
export const VARIANTS: Variant[] = ["screen", "done", "judged"];

/** One screenshot of a run, with what the run did on it. */
export type ProbeStep = {
  run: string;
  step: number;
  /** The tactic the run's action amounts to. */
  truth: Tactic;
  tool: string;
  summary?: string;
  /** What code knew before the step (never given to the model). */
  urlBefore: string;
  doneBefore: string[];
  ref: string;
  image: Image;
};

/** Name an action as a tactic. Only code does this, from the tool and the page the action was taken on. `null`: no tactic names it (the first `navigate` has no screenshot before it; `press_key` and `type_text` are not in the list). */
export function tacticOf(tool: string, previousTool: string | undefined, urlBefore: string): Tactic | null {
  switch (tool) {
    case "hover":
      return "open_menu";
    case "click":
      if (previousTool === "hover") return "pick_menu_entry";
      return /\/products\//.test(new URL(urlBefore).pathname) ? "select_option" : "click_item";
    case "scroll":
      return "scroll";
    case "read_price":
      return "read_value";
    case "go_back":
      return "go_back";
    case "end":
      return "end";
    default:
      return null;
  }
}

/** The steps of a finished run that have a screenshot and a tactic. A step whose tool failed is left out: the run did not do what it chose. */
export function probeSteps(run: string, result: RunResult): ProbeStep[] {
  const out: ProbeStep[] = [];
  const done: string[] = [];
  let previous: string | undefined;
  for (const s of result.steps) {
    const images = s.request.images ?? {};
    const ref = Object.keys(images)[0];
    const state = (s.request.state as { state?: { page?: { url?: string } } }).state;
    const urlBefore = state?.page?.url;
    if (s.tool === "navigate") done.push(DONE_OPENED);
    const truth = ref && urlBefore ? tacticOf(s.tool, previous, urlBefore) : null;
    if (truth && ref && urlBefore && !s.error) out.push({ run, step: s.step, truth, tool: s.tool, summary: s.summary, urlBefore, doneBefore: [...done], ref, image: images[ref]! });
    if (truth && !s.error) done.push(DONE[truth]);
    previous = s.tool;
  }
  return out;
}

export type Scored = {
  run: string;
  step: number;
  truth: Tactic;
  judgments: Judgments;
  picks: Record<Variant, { tactic: Tactic; confidence: number | null }>;
};

/** Ask the deciding level about every step, in all three ways. The task is the plain one-sentence request: nothing of the steps. */
export async function scoreSteps(model: DecisionModel, instructions: string, steps: ProbeStep[]): Promise<Scored[]> {
  return await Promise.all(
    steps.map(async (s) => {
      const images = { [s.ref]: s.image };
      const [judgments, screen, done] = await Promise.all([
        judge(model, instructions, s.ref, images),
        pickTactic(model, instructions, { screen: s.ref }, images),
        pickTactic(model, instructions, { screen: s.ref, done: s.doneBefore }, images),
      ]);
      const judged = await pickTactic(model, instructions, { screen: s.ref, judgments, done: s.doneBefore } satisfies PlannerState, images);
      return { run: s.run, step: s.step, truth: s.truth, judgments, picks: { screen, done, judged } };
    }),
  );
}

export type Report = {
  steps: number;
  /** Share of steps where the pick equals the run's tactic (or is one of the `ALSO` that agree with it), per variant. */
  match: Record<Variant, number>;
  /** Per variant: truth -> picked -> count. */
  confusion: Record<Variant, Record<string, Record<string, number>>>;
  /** Per variant and tactic of the run: how many steps, how many matched. */
  perTactic: Record<Variant, Record<string, { steps: number; matched: number }>>;
};

/**
 * Other tactics that count as the run's own. The runs the probe replays scrolled a list to find the item; a person who had seen the
 * list's filters could as well have used them. Both bring the item into view, so a pick of `filter` where the run scrolled agrees.
 */
const ALSO: Partial<Record<Tactic, Tactic[]>> = { scroll: ["filter"] };

export function report(scored: Scored[]): Report {
  const match = {} as Report["match"];
  const confusion = {} as Report["confusion"];
  const perTactic = {} as Report["perTactic"];
  for (const v of VARIANTS) {
    confusion[v] = {};
    perTactic[v] = {};
    let hit = 0;
    for (const s of scored) {
      const picked = s.picks[v].tactic;
      (confusion[v][s.truth] ??= {})[picked] = (confusion[v][s.truth]?.[picked] ?? 0) + 1;
      const t = (perTactic[v][s.truth] ??= { steps: 0, matched: 0 });
      t.steps++;
      if (picked === s.truth || ALSO[s.truth]?.includes(picked)) {
        t.matched++;
        hit++;
      }
    }
    match[v] = scored.length ? hit / scored.length : 0;
  }
  return { steps: scored.length, match, confusion, perTactic };
}

export function formatReport(r: Report, label: string): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines = [`${label}: ${r.steps} steps`, ...VARIANTS.map((v) => `  ${v.padEnd(7)} ${pct(r.match[v]).padStart(4)} match`)];
  for (const v of VARIANTS) {
    lines.push(`  by tactic of the run, ${v}:`);
    for (const t of TACTIC_IDS) {
      const row = r.perTactic[v][t];
      if (!row) continue;
      const confused = Object.entries(r.confusion[v][t] ?? {}).filter(([k]) => k !== t).map(([k, n]) => `${k}×${n}`).join(", ");
      lines.push(`    ${t.padEnd(16)} ${row.matched}/${row.steps}${confused ? `  (picked instead: ${confused})` : ""}`);
    }
  }
  return lines.join("\n");
}
