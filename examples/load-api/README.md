# load-api

Tools that add tools: the agent starts with `load_api` and `end`, reads an API's OpenAPI document and gets one tool per endpoint.

**Shows:** dynamic tools at work (`ctx.tools.add` for each endpoint, `ctx.tools.remove` for `load_api` itself), and the
reusable converter behind it, `openApiTools` in `src/openapi/`. The task is "find the open ticket assigned to Ana and
close it", against a mock helpdesk API on loopback with real state.

```sh
npm run example:load-api -- [--runs 3] ["Close Ben's open ticket about the printer as won't fix and email the requester"]
```

Prints which tools each step offers, what was called, and what changed on the server. With `--runs N` it prints one line per
run and the count of runs that closed exactly Ana's ticket (the default task) and changed nothing else.

How it goes:

1. Step 1 offers `load_api` and `end`. `state.apis` lists two APIs (helpdesk, inventory); the model picks one by name from
   a closed set, because it cannot write an address. The address of the document stays in code.
2. `load_api` reads the OpenAPI document, adds a tool for each operation and removes itself. Step 2 offers `list_tickets`
   (`status` and `assignee` as enums, both optional) and `end`.
3. `get_ticket`, `update_ticket`, `close_ticket` and `delete_ticket` take an `id` from the response of `list_tickets`, so
   they are left out of a step until the agent has listed tickets. After a change the lists it has made are made again, so
   the state is what the server says.
4. `create_ticket` is not turned into a tool: its `title` is free text, which the model cannot write. `state.loaded.not_loaded`
   says so. Pass `candidates` to `openApiTools` to supply titles to choose from.

How the converter maps the spec to questions: enum, small integer range and ids from the state to a Choice, boolean to a Noul
(unsure on a required one fails the call), array of enum to a Set, a parameter that is not required gets the `stated` Noul.
Parameters go to the path, the query or the JSON body as the spec says; a response outside 2xx throws and becomes the `error`
slot of the next step. Question wording is in one place, `wording` in `src/openapi/openapi.ts`.

**Needs:** Jev: `TYPESAFE_API_KEY` in the environment (the cloud proxy supplies it in cloud sessions). No external service: `server.ts` starts the mock APIs on a random loopback port.

**Files:** `server.ts` (the two APIs, their OpenAPI documents and the seed tickets), `load-api.ts` (`createLoader`: the `load_api` tool), `main.ts` (runner).
**Acceptance test:** `tests/acceptance/load-api/load-api.test.ts`, replayed from `tests/cassettes/load-api`.
