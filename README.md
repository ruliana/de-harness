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

### Sets, optional values and thresholds

```ts
params: {
  size: param.choice({ question: "Which size from `state.menu.sizes` do `instructions` order?", options: ["small", "medium", "large"] }),
  // one Noul per member (`{}` is the member); the value is the members at or above the yes threshold
  toppings: param.set({ question: "Do `instructions` ask for {} on the pizza?", members: ["mushrooms", "olives", "basil"] }),
  // one extra Noul asks whether the value is stated at all; `undefined` unless it is
  delivery_time: param.choice({ question: "Which slot do `instructions` ask for?", options: slots, optional: { stated: "Do `instructions` say when to deliver?" } }),
  // thresholds per parameter (default yes 0.7 / no 0.3): `true`, `false` or 'unsure'
  gift: param.noul({ question: "Is it a gift?", thresholds: { yes: 0.6, no: 0.4 } }),
}
```

`members` can be a function of the state. 'unsure' never counts as a member or as stated; the raw probabilities are in
`ctx.answers` (`toppings[olives]`, `delivery_time?stated`) for code that wants another rule. Try it:
`npm run example:pizza -- "A large pizza with mushrooms and olives, deliver at 7pm"`.

### Images and boxes

A tool can put a picture into the state with `image(pngOrJpegBytes)` (PNG 280-1568 px per side). The model sees it wherever a question names the slot by path, and requests that carry images are sent with `TypeSafe-Danger-Zone-Images: true`. `param.box({ question, image })` asks Jev where something is (a Box) and, in the same request, whether it is there at all (a companion Noul, `<param>?present` in `ctx.answers`); the tool receives `{ top, bottom, left, right }` as fractions of the image, or `null` when the Noul says the target is absent. Box answers are approximate: compare overlap, not exact edges. Box requests always go to Jev 1.14 or later. Try it: `npm run example:screen -- "Click the Submit button" --out proof.png` (`HARNESS_CASSETTE=replay` uses the recordings).

| Where | What |
| - | - |
| `src/model/` | `DecisionModel`, `JevModel` (pinned `jev-1.14.0`), `CassetteModel` / `cassetteFetch` (record/replay), `ScriptedModel` |
| `src/tools/` | `defineTool`, `param.*`, `ToolRegistry`, built-in `end`, `delegateTool` |
| `src/questions/` | the question map for a step and answer parsing (the `__tool__` wording lives here) |
| `src/state/` | the state document, slot merging, previous-actions window |
| `src/loop/` | `createAgent(config).run()` |
| `src/input/` | `ctx.input.ask` holds the loop until an `InputProvider` replies: `StdinInput` (terminal), `ScriptedInput` (tests) |
| `src/events/` | typed events and the JSONL trace |
| `src/budget/` | token estimate, the context budget, previous-actions trimming |
| `examples/rooms/`, `examples/pizza/` | the example domains |
| `examples/coffee/` | a tool that asks the customer and waits (`npm run example:coffee`) |
| `examples/tickets/` | stateful API operations: an in-process support-ticket API and the tools that work its queue (`npm run example:tickets`) |
| `examples/office/` | thirty tools, the many-tools domain |
| `examples/screen/` | a form seen as a picture: `click(target)` with a Box (fixtures drawn by code, `npm run example:screen:fixtures`) |
| `examples/wikipedia/` | navigating Wikipedia by following links (`open_link`, `go_back`, `end`) |

## Example: Wikipedia navigation

`npm run example:wikipedia -- --from "Alan Turing" --to "Enigma machine"` walks from one article to another by following
links and prints the path. `open_link(link)` offers the links of the article body (references, info boxes, navboxes,
other namespaces and redlinks are left out in code, and the list is cut to a budget), keyed by article title and
described by their anchor text; `go_back` returns to the previous article and never offers the abandoned one again.
Articles are fetched as they were at a fixed snapshot (`SNAPSHOT` in `examples/wikipedia/client.ts`), so a recording
never goes stale. Wikipedia rate-limits shared addresses: the live run waits as asked and keeps what is already recorded.
