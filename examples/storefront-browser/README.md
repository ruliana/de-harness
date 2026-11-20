# storefront-browser

A sample: the same shopping task as `storefront/`, done the way a person would, in a headless browser.

**Shows:** the generic browser module (`src/browser`) on a real task: a page that is only a screenshot. The model points with boxes (`hover` to open the menu, `click`, `scroll`) and with
a box around the price: `read_price` lets code read the text inside it. Instructions spell out the steps; the one-sentence
task is the harder variant (`--plain`), which `storefront-by-sight/` addresses.

```sh
npm run example:storefront-browser -- [--site live|fixture] [--runs 1] [--max-steps 14] [--out shots/] [--plain | --task "..."]
```

`--site live` is the real aloyoga.com (reads only: no bag, no checkout); `--site fixture` is a look-alike shop on loopback
(`shop-site.ts`, bundled fonts, so screenshots are stable) and is the one CI replays.

**Needs:** Jev: `TYPESAFE_API_KEY` in the environment (the cloud proxy supplies it in cloud sessions) and Chromium (`npm ci`, `npx playwright install chromium`). The live site also needs network access to aloyoga.com
and a few of its hosts (see `LIVE` in `run.ts`); the fixture needs none.

**Files:** `shopping.ts` (tools and questions), `shop-site.ts` (fixture shop), `run.ts` (launch and check), `main.ts` (runner).
**Acceptance test:** `tests/acceptance/storefront-browser/shopping.test.ts`, replayed from `tests/cassettes/storefront-browser`.
