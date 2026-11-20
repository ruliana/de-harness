# de-harness

A harness for decision models. The agent has tools; the model (Jev by default) is used only to call them, one
question per tool name and per parameter. See `CLAUDE.md` for principles and commands.

```sh
npm ci
npm run typecheck
npm test            # replay mode, no network
npm run test:live   # live Jev, re-records cassettes
```

## How it works

Each step is **one** request to the model: the state document (`instructions`, `state`, `previous_actions`), a Choice
`__tool__` over the available tools, and one question `<tool>.<param>` per parameter of every available tool
(speculative fan-out). Code reads only the chosen tool's answers, runs it, and merges its result into the state.
The model never writes text, so parameters are closed sets (`param.choice` options come from code, often from the state),
a Noul (`boolean | 'unsure'`) or a Score (a level label).

```ts
import { createAgent, defineTool, param, JevModel } from "./src/index.js";

const openDoor = defineTool({
  name: "open_door",
  description: "Opens one of the doors of the current room and walks through it.",
  params: { door: param.choice({ question: "Which door of `state.room.doors` do `instructions` say to go through?", options: (ctx) => ctx.state.room.doors }) },
  run: ({ door }) => ({ state: { room: enter(door) }, summary: `went through the ${door} door` }),
});

const result = await createAgent({ model: new JevModel(), instructions: "Leave through the red door", tools: [openDoor], initialState: { room } }).run();
// result.status: 'ended' | 'step_limit' | 'aborted' | 'error'; result.steps, result.state, result.output, result.events
```

Tools can be added and removed while the agent runs: `ctx.tools.add(tool)` / `ctx.tools.remove(name)` inside a tool (or
`agent.tools` from outside). The registry is read fresh every step, so a change shows from the next request, and each
change emits a `tools_changed` event. A duplicate name and removing the built-in `end` throw (inside a tool: an `error`
slot, registry unchanged). See `examples/chest/`.

### Scale: many tools and a context budget

Every request is kept under `contextBudget` tokens (default 48 000, estimated from characters; Jev takes about 64k).
When the one-request fan-out of a step would not fit (say 40 tools with 5 parameters each), the step goes **two-phase**:
first the state and `__tool__` alone, then the state and only the chosen tool's parameter questions (skipped for a tool
without parameters). Each `request` and `answers` event carries a `phase` (`single`, `tool`, `params`, `order_check`),
and `StepRecord.requests` lists them all. A request still over budget loses its oldest `previous_actions`
(a `trimmed` event); with none left the run ends with `status: "error"`, a `budget_exceeded` event and an error naming
the largest part, e.g. `state.page`. Cut big slots and long option lists in code: a Choice takes at most 255 options.

`orderCheck: true` is an opt-in guard against option-order bias: each step also asks `__tool__` with its options reversed,
and a different answer emits `order_disagreement` (the step still goes on with the normal order's answer).
Cassette keys ignore key order, so the reversed request replays the same recording: test the check with `ScriptedModel`.

Try it live: `npm run example:rooms -- "Leave the room through the red door"`.

| Where | What |
| - | - |
| `src/model/` | `DecisionModel`, `JevModel` (pinned `jev-1.14.0`), `CassetteModel` / `cassetteFetch` (record/replay), `ScriptedModel` |
| `src/tools/` | `defineTool`, `param.*`, `ToolRegistry`, built-in `end` |
| `src/questions/` | the question map for a step and answer parsing (the `__tool__` wording lives here) |
| `src/state/` | the state document, slot merging, previous-actions window |
| `src/loop/` | `createAgent(config).run()` |
| `src/input/` | `ctx.input.ask` holds the loop until an `InputProvider` replies: `StdinInput` (terminal), `ScriptedInput` (tests) |
| `src/events/` | typed events and the JSONL trace |
| `src/budget/` | token estimate, the context budget, previous-actions trimming |
| `examples/rooms/` | the example domain |
| `examples/coffee/` | a tool that asks the customer and waits (`npm run example:coffee`) |
| `examples/office/` | thirty tools, the many-tools domain |
