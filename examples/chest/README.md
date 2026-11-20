# chest

A locked chest and a key on the floor: tools that appear and disappear while the agent runs.

**Shows:** dynamic tools. `pick_up_key` is the only tool at first; it adds `open_chest` through `ctx.tools.add` and removes
itself with `ctx.tools.remove`. The registry is read again every step, so the change shows from the next request.

There is no `npm run` script for this example; it is a domain used by the acceptance test:

```sh
npx vitest run tests/acceptance/dynamic/chest.test.ts
```

**Needs:** nothing in replay mode (the default): answers come from `tests/cassettes/dynamic`. With `npm run test:live` it
needs Jev: `TYPESAFE_API_KEY` in the environment (the cloud proxy supplies it in cloud sessions).

**Files:** `chest.ts` (`createChest()`: the world and its tools).
