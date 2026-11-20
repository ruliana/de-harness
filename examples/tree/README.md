# tree

Walking a product taxonomy of a few hundred categories to file an item.

**Shows:** navigating a tree with `descend`, `ascend` and `select`. The model only sees where it is (`state.location`: the
path and the names of its sub-categories); which child to pick, when to back out and when to select are its judgments, the walk
itself is code. `select` ends the run.

```sh
npm run example:tree -- "Where does a cordless drill belong?"
```

Prints the path walked and the category selected.

**Needs:** Jev: `TYPESAFE_API_KEY` in the environment (the cloud proxy supplies it in cloud sessions). No browser; the taxonomy is in `taxonomy.ts`.

**Files:** `taxonomy.ts` (the data and parser), `tree.ts` (the tools), `main.ts` (runner).
**Acceptance test:** `tests/acceptance/tree/tree.test.ts`, replayed from `tests/cassettes/tree`.
