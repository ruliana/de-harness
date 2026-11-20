# storefront-by-sight

A sample: the one-sentence shopping task ("go to the shop, find a blue sweatshirt, select size large, and get the price"), by
sight alone, with two levels of agent.

**Shows:** sub-agents and code-owned decisions. The *deciding level* (`planner.ts`) sees only the screenshot and what code
recorded as done, and picks one of a short list of generic tactics (`tactics.ts`: open a menu, click an item, scroll, ...).
The *navigating level* is a child agent started with `ctx.runAgent` that carries the tactic out with a Box. Code checks the
result with yes/no judgments, removes tactics that make no sense, and stops a tactic that changed nothing repeatedly. The tactic
probe measures how well the model picks a tactic from a screenshot alone.

Two more things the deciding level does for shops it has not seen. The `filter` tactic narrows a list with its filters (a closed
"Colour" section opens on one click, its value on the next) when the item is not in view and scrolling would never show it; code
offers it only on a list whose item is not visible, three times at most. And each tactic's navigator reads only the clauses of the
task that tactic needs (`SightTask` in `tactics.ts`): the item to find, the option to choose, the value to get. A navigator that
read "select size 10" while picking a boot clicked "10" in the side bar.

```sh
npm run example:by-sight -- [--site live|fixture] [--runs 1] [--max-steps 10] [--no-rules]
npm run example:probe -- [--site fixture|live] [--runs 5] [--out dir | --from dir]
```

**Needs:** Jev: `TYPESAFE_API_KEY` in the environment (the cloud proxy supplies it in cloud sessions) and Chromium (`npm ci`, `npx playwright install chromium`). `--site live` also needs network access to aloyoga.com
(reads only); `fixture` (the default) uses the loopback shop of `storefront-browser/`.

**Files:** `planner.ts`, `tactics.ts`, `run.ts`, `main.ts`; `probe.ts` and `probe-main.ts` for the probe.
**Acceptance tests:** `tests/acceptance/storefront-by-sight/`, replayed from `tests/cassettes/storefront-by-sight`, `storefront-by-sight-outfitter` (the filter and the size-clause fixtures, `tests/support/outfitter-site.ts`) and `tactic-probe`.
