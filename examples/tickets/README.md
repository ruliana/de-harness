# tickets

Stateful API operations: the agent works through a support-ticket queue over HTTP.

**Shows:** tools that call an API and refresh the state from it after every change; choice options as closed sets from code
(ticket ids, teams, statuses, tags); judgments that gate an action (closing needs "is this a duplicate?"); a code decision for
`end` (only once every ticket has been opened); and a failed call (4xx/5xx) throwing, which becomes the `error` slot of the
next step.

```sh
npm run example:tickets -- "Send every billing ticket to the billing team and close duplicates"
```

Prints a before/after table of the tickets.

**Needs:** Jev: `TYPESAFE_API_KEY` in the environment (the cloud proxy supplies it in cloud sessions). No external service: `server.ts` starts an in-process HTTP API on a random loopback port.

**Files:** `server.ts` (the API and seed tickets), `tickets.ts` (the tools), `main.ts` (runner).
**Acceptance test:** `tests/acceptance/tickets/tickets.test.ts`, replayed from `tests/cassettes/tickets`.
