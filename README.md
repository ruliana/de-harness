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

### Sub-agents

A tool can run a whole nested agent with `ctx.runAgent(config)` and the loop simply waits for it. The child has its own
tools, instructions and step limit, uses the parent's model unless it brings one, stops when the parent run is aborted,
and its events are written to the parent's trace as `child` events under the step that called it (deeper children nest
further). `delegateTool` is the ready-made version: the parent *picks* the task from candidates (Jev cannot write it), the
child runs, and its `{ task, status, steps, output }` lands in a state slot, also when the child hit its step limit.

```ts
const delegate = delegateTool({
  tasks: { "Leave the room through the red door": "The helper finds the red door and walks out through it" },
  agent: (task) => ({ instructions: task, tools: rooms.tools, initialState: rooms.initialState, maxSteps: 4 }),
});
```

Try it live: `npm run example:rooms -- "Leave the room through the red door"`.

| Where | What |
| - | - |
| `src/model/` | `DecisionModel`, `JevModel` (pinned `jev-1.14.0`), `CassetteModel` / `cassetteFetch` (record/replay), `ScriptedModel` |
| `src/tools/` | `defineTool`, `param.*`, `ToolRegistry`, built-in `end`, `delegateTool` |
| `src/questions/` | the question map for a step and answer parsing (the `__tool__` wording lives here) |
| `src/state/` | the state document, slot merging, previous-actions window |
| `src/loop/` | `createAgent(config).run()` |
| `src/events/` | typed events and the JSONL trace |
| `examples/rooms/` | the example domain |
