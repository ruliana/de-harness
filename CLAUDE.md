# de-harness

A TypeScript harness for decision models (default: Jev, TypeSafe System One). The agent has tools; the model is used
only to call them: a tool name is a Choice question and every tool parameter is its own question (Choice, Noul, Score
or Box). The tool's result becomes state. Instructions are repeated every step until an `end` tool is chosen or the
step limit is reached.

## Principles

1. **Acceptance tests only. No unit tests.** Tests drive the public API (`createAgent(...).run()`) end to end and assert
   outcomes and invariants, never an exact probability. Mechanics that need a forced decision use `ScriptedModel`.
2. **TypeScript**, strict. ESM. Node 22.
3. **Jev judges, code decides.** Judgments come from the model; decisions (thresholds, what to do with "unsure") live in
   code. Jev cannot generate text: free-form values are *selected* from candidates the tool supplies.
4. **All question wording in one place per tool**, plain, one judgment each, naming state by path in backticks.
5. **Tools are easy to add and remove at runtime**, and a tool may hold the loop (user input, sub-agents).
6. API failures are errors, never answers.
7. **`src/core.ts` stays browser-safe**: nothing it reaches imports a Node module (the build fails if one does). Node-only
   parts (cassettes, stdin, files) are exported from `src/index.ts`; keep `src/version.ts` equal to `package.json`.

## Commands

| Command | What |
| - | - |
| `npm run typecheck` | `tsc --noEmit`, strict, over `src`, `examples`, `tests` |
| `npm run build` | `dist/`: compiled sources + `.d.ts`, and the browser bundles of `src/core.ts` (ESM, minified ESM, IIFE `DeHarness`) |
| `npm test` | acceptance tests in **replay** mode: Jev and external HTTP answered from `tests/cassettes/`; no network |
| `npm run test:live` | same tests against live Jev and HTTP, re-recording cassettes (`HARNESS_CASSETTE=record`) |
| `npm run test:spec` | the behaviour spec (`tests/spec`): how the agent reads instructions. Some tests fail on purpose until fixed, so it is not part of `npm test` or the Premerge check. `test:spec:live` re-records `tests/cassettes/spec` |

## PR flow

Work arrives as pull requests. CI runs `typecheck` and `acceptance`; when both pass the PR is squash-merged
(auto-merge). Run `npm run test:live` before opening the PR, commit the cassette changes, and paste the live summary in
the PR body. A missing recording fails with `no recording for <hash>`: re-record with `npm run test:live`.

Releases: bump `version` in `package.json` and `src/version.ts` in a PR; when it merges, `.github/workflows/publish.yml`
publishes that version to npm (jsDelivr and unpkg follow) and tags it `v<version>`. A version already on npm is skipped.

Browser tests (`tests/acceptance/browser`) drive a real headless Chromium: `npm ci` then `npx playwright install chromium` (the cloud image already has it; CI installs it). Screenshots are keyed into cassettes, so the test site bundles its fonts and the session launches Chromium with flags that keep rendering stable.

Cloud sessions: Node's built-in `fetch` ignores the proxy, so live runs need `NODE_USE_ENV_PROXY=1` (the script sets it).
