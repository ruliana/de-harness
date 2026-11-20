# graph

A small transit map: get from one station to another by riding the lines.

**Shows:** navigating a graph. The state holds the lines and the current station; `move(station)` offers only the unvisited
neighbours, filtered in code, so nothing is revisited by construction. Choosing `end` at the named station is the model's
judgment. The runner compares the route with the shortest one.

```sh
npm run example:graph -- Airport Stadium
```

**Needs:** Jev: `TYPESAFE_API_KEY` in the environment (the cloud proxy supplies it in cloud sessions). No browser, no fixtures.

**Files:** `transit.ts` (lines, adjacency, `shortestPath`, tools), `main.ts` (runner).
**Acceptance test:** `tests/acceptance/graph/graph.test.ts`, replayed from `tests/cassettes/graph`.
