# browser

Any web page, by address: a headless Chromium whose page is only a screenshot.

**Shows:** the generic browser tools (`BrowserSession` and `browserTools`, imported from the separate browser module, `src/browser`, `de-harness/browser`): `navigate`, `click`, `hover`, `scroll`, `type_text`,
`press_key`, `go_back`. The model points with a box and code clicks its centre; typed text is selected from candidates you pass
with `--text`, since Jev cannot write. The browser may only talk to the host of `--url`, so a click cannot walk the agent off
the site.

```sh
npm run example:browser -- --url https://example.com "Click the More information link" [--text "some text"]... [--out last.png]
```

**Needs:** Jev: `TYPESAFE_API_KEY` in the environment (the cloud proxy supplies it in cloud sessions), network access to the site, and Chromium: `npm ci` then `npx playwright install chromium` (the cloud image
already has it). `--out` saves the final screenshot.

**Files:** `main.ts` only; the tools live in `src/browser`, which is its own module so that Playwright stays an optional dependency.
**Acceptance tests:** `tests/acceptance/browser/` run against a site on loopback and replay from `tests/cassettes/browser`.
