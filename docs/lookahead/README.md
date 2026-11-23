# Lookahead: greedy Jev against short-horizon search

`createAgent({ lookahead })` (`src/lookahead/lookahead.ts`) lets Jev shortlist actions, previews them on copies of the state, judges
the resulting states against the task's requirements and constraints, looks a few actions ahead, and runs only the first action of
the best sequence before planning again. This page is the first experiment: greedy Jev against beam width 3 / depth 2 and a few
neighbours, on the same tasks, with the same model, tools, instructions and external verifier.

Run on 2026-11-23 against `jev-1.14.0`, 21 tasks × 8 arms × 2 runs = 336 runs, one at a time. Raw results:
[`results.json`](results.json). Re-run: `NODE_USE_ENV_PROXY=1 npx tsx scripts/lookahead-experiment.ts --runs 2 --parallel 1`.
The acceptance suite [`tests/acceptance/lookahead`](../../tests/acceptance/lookahead/) replays one run of four of the arms.

## Result

| Arm | Completed (verified) | Regressions | Limit breaks | Requests / run | Time / run |
| - | - | - | - | - | - |
| greedy | 26 / 42 (62%) | 12 | 7 | 3.7 | 0.40 s |
| greedy, told the requirements | 31 / 42 (74%) | 10 | 4 | 4.2 | 0.44 s |
| greedy + `review` (no per-tool wording) | 14 / 42 (33%) | 4 | 5 | 6.8 | 0.71 s |
| lookahead width 3, depth 1 | 14 / 42 (33%) | 0 | 0 | 6.2 | 0.45 s |
| lookahead width 1, depth 2 | 26 / 42 (62%) | 2 | 0 | 5.3 | 0.55 s |
| **lookahead width 3, depth 2** | **34 / 42 (81%)** | **2** | **0** | 14.1 | 0.86 s |
| lookahead width 3, depth 3 | 36 / 42 (86%) | 2 | 0 | 20.9 | 1.19 s |
| **lookahead 3 × 2, `onNoGain: "greedy"`** | **42 / 42 (100%)** | **2** | **0** | 19.1 | 1.08 s |

- *Completed*: every external check true at the end and no limit ever broken, read from the world by code.
- *Regressions*: times a check that was true became false during the run. The 2 regressions of every lookahead arm are the same,
  unavoidable one (`settings-preset-only`, where the only way to turn notifications off also resets the language, which is then
  set back).
- *Limit breaks*: steps after which a hard limit was broken (over budget, paid for an item not asked for).
- *Time*: wall time per run; lookahead sends its requests per level in parallel, so 5x the requests cost about 2.7x the time.

By kind of task (completed / runs, then regressions and limit breaks):

| Kind | greedy | told reqs | review | 3×1 | 1×2 | 3×2 | 3×3 | 3×2 greedy fallback |
| - | - | - | - | - | - | - | - | - |
| prerequisite (10 tasks) | 16/20 | 16/20 | 0/20 | 0/20 | 14/20 | 18/20 | 20/20 | 20/20 |
| regression (8 tasks) | 10/16, 11 reg, 5 breaks | 10/16, 10, 4 | 10/16, 4, 5 | 14/16, 0, 0 | 12/16, 2, 0 | 16/16, 2, 0 | 16/16, 2, 0 | 16/16, 2, 0 |
| plain shop tasks (3) | 0/6 | 5/6 | 4/6 | 0/6 | 0/6 | 0/6 | 0/6 | 6/6 |

Per task (completed out of 2):

| Task | greedy | told reqs | review | 3×1 | 1×2 | 3×2 | 3×3 | 3×2 g |
| - | - | - | - | - | - | - | - | - |
| settings-night | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| settings-presentation | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| basket-mugs (bundle goes over budget) | 0 | 0 | 2 | 2 | 0 | 2 | 2 | 2 |
| basket-stationery (same) | 0 | 0 | 0 | 2 | 0 | 2 | 2 | 2 |
| calendar-review | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| calendar-demo | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| calendar-shift-only (no safe way: leave it alone) | 0 | 0 | 0 | 2 | 2 | 2 | 2 | 2 |
| settings-preset-only (preset, then fix the language) | 2 | 2 | 0 | 0 | 2 | 2 | 2 | 2 |
| share-q4 (verify the user first) | 2 | 2 | 0 | 0 | 2 | 2 | 2 | 2 |
| share-budget | 2 | 2 | 0 | 0 | 2 | 2 | 2 | 2 |
| trip-lisbon (passport before flight, flight before transfer) | 2 | 2 | 0 | 0 | 2 | 2 | 2 | 2 |
| trip-vienna | 2 | 2 | 0 | 0 | 2 | 2 | 2 | 2 |
| print-contract (sign and connect before printing) | 2 | 2 | 0 | 0 | 2 | 2 | 2 | 2 |
| print-lease | 2 | 2 | 0 | 0 | 2 | 2 | 2 | 2 |
| ticket-7-technical (assign before closing) | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 2 |
| ticket-3-billing | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 2 |
| deploy-41 (three steps with no requirement on the way) | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 2 |
| deploy-12-milestones (same, with the milestone listed) | 2 | 2 | 0 | 0 | 2 | 2 | 2 | 2 |
| shop-order-red-mug (a blue mug already in the basket) | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 2 |
| shop-buy-two-mugs | 0 | 2 | 2 | 0 | 0 | 0 | 0 | 2 |
| shop-cheaper-mug | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 2 |

## What it shows

1. **Looking at consequences removes the damage.** Every lookahead arm broke no limit and caused no avoidable regression; greedy
   broke a limit or undid something in 6 of 16 runs of the regression tasks (the bundles over budget, the day shift that moves the
   1:1, paying for the blue mug). Previewing the bundle shows the total, so it is never taken.
2. **Two steps ahead is what solves ordering.** "Close ticket 7 and assign it to technical" fails for greedy every time (it closes
   first and can no longer assign); depth 2 sees that close-then-assign stops halfway and assign-then-close finishes. Depth 1 and
   width 1 do not: depth 1 cannot value an action that only unlocks another (0/20 on prerequisites, it stops), width 1 explores only
   Jev's first pick, which is the one that goes wrong.
3. **It cannot value steps its requirements do not measure.** On a chain of three steps with no requirement on the way
   (`deploy-41`) depth 2 sees no gain and stops, saying so; depth 3, or one listed milestone, or the greedy fallback fixes it. The
   shop tasks are navigation (Home, Mugs, Red mug, add, pay): no requirement moves until the basket does, so pure lookahead stops at
   the start. With `onNoGain: "greedy"` it follows Jev's most probable safe action until a plan appears: 6/6, where greedy is 0/6.
4. **The gain is from searching, not from being told what done means.** Greedy given the same requirements and constraints in its
   instructions goes from 26 to 31 completed, all on the shop; it still fails the bundles, the shift and the tickets.
5. **`review` without per-tool wording hurts here** (14/42): its action check refuses the enabling actions (verifying a user, adding
   a passport) as "not asked for". PR 42 reached 0 failures on its own suite with tools that word their own checks; these worlds
   don't, which is the out-of-the-box case.

This matches what the instruction-following investigation found: Jev answers narrow yes/no questions about a state well and picks
the right action directly far less often. The planner asks Jev mostly the first kind of question (judge this state) and uses the
second only to shortlist.

## Cost

Width 3, depth 2 is about 4x greedy's requests and 2x its time; with the greedy fallback about 5x and 2.7x (the shop tasks walk a
few pages under it, 42 requests a run). Per step: shortlist the real state (1), judge the real state (1, usually answered by the
previous step's judgement of the same state), judge up to 3 previews, shortlist up to 3 of them, judge up to 9; equal states are
asked about once. A criterion with a `check` in code costs nothing.

## Caveats

- The worlds are small and written for this experiment, and their previews are exact. A real tool's preview may be wrong; the
  planner then sees the real result, does not repeat a call that left the state unchanged, and plans again, but how well that
  works with inexact previews is not measured here.
- The requirements and constraints are written per task, as an agent author would. Lookahead needs them; greedy does not.
- 21 tasks, 2 runs each. Jev is nearly deterministic at these questions (1 of 168 task-arm pairs gave a different outcome on the
  second run), so more runs of the same tasks add little; more tasks would.

## Recommendation

Keep `lookahead` opt-in and use `{ width: 3, depth: 2, onNoGain: "greedy" }` for agents whose tools can preview their effect and
whose task can be written as requirements: it completed every task here with no limit broken, for about 5x the requests. Use
depth 3, or list milestones as requirements, when a prerequisite chain has more than one step without visible progress. Next:
quote the task in the shortlist question (the investigation's finding, which raised the right action's probability 0.13 to 0.39)
and try the planner where previews are not exact (an API with a dry-run, the browser).
