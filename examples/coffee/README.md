# coffee

A coffee counter where the customer is a person at the terminal (or a script on stdin).

**Shows:** a tool that holds the loop. `ask_customer` waits for `ctx.input` (`StdinInput` here, `ScriptedInput` in tests), and
because Jev cannot write text, the tool supplies candidate questions and the model *selects* one. `place_order` then takes the
size from the menu.

```sh
npm run example:coffee                       # answer in the terminal
echo "large please" | npm run example:coffee # or pipe the reply
```

**Needs:** Jev: `TYPESAFE_API_KEY` in the environment (the cloud proxy supplies it in cloud sessions). No browser, no fixtures.

**Files:** `coffee.ts` (tools and candidate questions), `main.ts` (runner).
**Acceptance test:** `tests/acceptance/input/coffee.test.ts`, replayed from `tests/cassettes/input`.
