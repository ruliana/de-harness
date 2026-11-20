# office

A front-desk assistant with thirty tools, the "many tools" domain.

**Shows:** scale. Each tool does one office chore with one `param.choice`; with this many tools the one-request fan-out no longer
fits `contextBudget`, so the step goes two-phase (first the tool, then only that tool's parameter questions). One tool
(`register_visitor`) takes its options from the state.

There is no `npm run` script; the acceptance test drives it with a small budget so the two-phase path is exercised:

```sh
npx vitest run tests/acceptance/scale/office.test.ts
```

**Needs:** nothing in replay mode (the default): answers come from `tests/cassettes/scale`. With `npm run test:live` it needs
Jev: `TYPESAFE_API_KEY` in the environment (the cloud proxy supplies it in cloud sessions). Nothing real happens; tools only record what they did.

**Files:** `office.ts` (`createOffice()`).
