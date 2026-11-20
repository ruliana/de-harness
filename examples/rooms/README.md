# rooms

A hall with coloured doors: the smallest agent that runs the core loop.

**Shows:** `defineTool` with a `param.choice` whose options come from the state (the doors of the current room), a tool that is
only offered while it makes sense (`turn_on_light`), the built-in `end` tool, and `onEvent` tracing.

```sh
npm run example:rooms -- "Leave the room through the red door"
```

**Needs:** Jev: `TYPESAFE_API_KEY` in the environment (the cloud proxy supplies it in cloud sessions). No browser, no fixtures.

**Files:** `rooms.ts` (the domain and its tools), `main.ts` (the runner).
**Acceptance test:** `tests/acceptance/core/rooms.test.ts`, replayed from `tests/cassettes/core`.
