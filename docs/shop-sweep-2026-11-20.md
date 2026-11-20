# By-sight shopping on five shops it was never tuned on (2026-11-20)

The agent is `examples/storefront-by-sight` exactly as merged in PR 16 (planner, tactics, wording, no-change guard, `browserTools`): not one line of it changed
for this check (`git diff` of `src/` and `examples/storefront-by-sight/` is empty). Only a runner was added (`examples/shop-sweep/`, `npm run example:shops -- --shop <id> --runs 4`).
The task is PR 16's plain sentence, `plainTask(shop, item, size)`: "Go to <shop>, find <item>, select size <size>, and get the price. Never add anything to the bag and never open the checkout. Stop once the price of <item> in size <size> has been read."
Only pictures reach Jev. 4 live runs per shop, 10 steps at most, one run at a time per shop, 4 s between runs, nothing but page loads and clicks on product pages (no login, cart or checkout; no run clicked an add-to-bag button).

## Result

| Shop (platform) | Task | Correct | Steps | What went wrong |
| - | - | - | - | - |
| taylorstitch.com (Shopify theme, hover mega menu) | a gray sweater, size medium | **4 / 4** | 5 | Right item and price ($178, the same for every size, checked in the shop's own product feed). But the site opens the page with M already selected and the agent never clicked a size: no `select_option` step in any run. |
| llbean.com (own stack, e-mail pop-up) | a pair of brown boots, size 10 | 0 / 4 | 10 (limit) | Pop-up closed fine, Footwear > Boots reached. Run 1 got to a brown boot page and selected size 10 on step 10, one step short of reading the price. Runs 2-4 clicked the size refinements in the sidebar ("10", "10 1/2") instead of a boot, and stayed on the list. |
| zappos.com (Amazon's stack, cookie banner) | a pair of white sneakers, size 9 | 0 / 4 | 9-10 | Menus open on click, not on hover, so `open_menu` (hover) never opened one (confirmed by hand, with and without the host allow-list). Then `go_back` on the first page lands on `about:blank` (see below) and the run ends with "No tool is available" (3 of 4). |
| carhartt.com (Salesforce Commerce Cloud, cookie notice) | a black hoodie, size large | 0 / 4 | 10 (limit) | A cookie notice covers the page. `close_overlay` points at its tiny X and misses by a few pixels (it clicks the notice's own box), `open_menu` then hovers the big CONTINUE button without pressing it, and the pair repeats until the limit. Run 3 closed it by luck on step 5, reached a Black Friday hoodie list and ran out of steps scrolling. |
| gymshark.com (headless storefront, cookie banner) | a red t-shirt, size medium | 0 / 4 | 10 (limit) | Hover menu and the T-shirts list worked (steps 1-3). On the list `pick_menu_entry` was judged "not done" (the check wants the menu gone and the judgment disagreed), then it scrolled a list with hero photos and never clicked an item (no filter tactic exists); runs 1 and 4 went back twice and ended on `about:blank`. |

Overall **4 of 20 correct, all on one shop**; 1 of 5 shops works, and not for the reason the task intended (size preselected). Runs of one shop are nearly identical (Jev is deterministic on the same picture):
Taylor Stitch gave the same 5 steps four times, the Carhartt runs the same loop three times, so 4 runs per shop is closer to one sample than four. L.L.Bean varies the most (page timing differs).
For comparison, PR 16 reported 5/5 on aloyoga.com and the look-alike shop that its wording was tuned on.

Scoring: by me, from the final screenshot and the live page (price re-read in the shop's product feed); the machine-read facts (JSON-LD, selected controls) are in each `result.json`. Screenshots of every step: `/mnt/project-files/shop-sweep/<shop>/run-N-steps.jpg`.

## Setup note (my own mistake, fixed before the numbers above)

The first batch of Taylor Stitch runs (4 misses) was void: its product grid is fed by `api-r3.tagalys.com`, which my host allow-list blocked, so every list showed grey placeholders. I added `tagalys.com` and re-ran that shop; the agent was not touched. I checked the other four shops' list pages under their allow-lists: they draw normally.
The allow-lists keep consent managers (so cookie banners appear as for a visitor) and drop ads, trackers, chat widgets and tag managers, like aloyoga.com in PR 16. A first smoke run on Taylor Stitch (before my fact-reader worked, one miss) is not counted.

## Failure modes, by tactic

- **`close_overlay`**: never seen before (go_back / close_overlay "never occurred" in the probe). It cleared L.L.Bean's pop-up and Zappos' banner on the first click, but failed on Carhartt (box 1-2% wide around an X; it hit the notice) and it is the only way out of a modal. Its check ("the screenshot changed") also passes when the pointer merely highlights a button, so a hover on CONTINUE counted as "closed" (✓ in `tactics`).
- **`open_menu` assumes hover**: right on Taylor Stitch, L.L.Bean, Gymshark; wrong on Zappos where menus open on click. Run 2 spent five of its ten steps on the same hover.
- **`go_back` from the first page**: `BrowserSession.back()` reports "there is no previous page" when `goBack()` returns null, but from the first page the browser has in fact moved to `about:blank` (verified: goBack returns null and the URL becomes `about:blank`). All tactics then become unavailable. 5 of 20 runs ended there (Zappos 3, Gymshark 2). This is a harness bug, not Jev.
- **Lists that are filtered, not browsed**: Gymshark (no colour in sight) and L.L.Bean (size refinements next to the items) need a filter tactic; the agent has only `scroll`, `click_item` and `select_option`, and `click_item` was pointed at the sidebar.
- **Step budget**: 10 steps is tight on real shops with a banner and a two-level menu; L.L.Bean run 1 was one step from the price.
- **Size already selected**: `optionChosen` is judged from the screenshot, so a preselected size counts. Correct here by luck of the shop; a shop that preselects a different size would be wrong.
- Not seen in these runs: `read_value` failures (it worked 4/4 when reached), wrong item, add-to-bag clicks.

## Suggested fixes (not applied; nothing here was tuned on these runs)

1. `BrowserSession.back()`: treat a result of `about:blank` as no history (go forward again) and report it. Mechanics, small.
2. A tactic for click-opened menus (or `open_menu` trying a click when the hover opened nothing), so Zappos-like menus work.
3. `close_overlay`: prefer a labelled button (CONTINUE / Accept / Close) over a tiny X, and make the check "the thing that was over the page is gone" (a judgment) instead of "the picture changed".
4. A `filter` tactic (apply a colour or size facet) for list pages, and a note in `tactics.ts` that sidebar refinements are not items.
5. Raise the step limit to about 15, and make the no-change guard ignore differences that are only a hover highlight.
6. Make the size check demand a click: only count `optionChosen` after a `select_option` step, or ask whether the chosen size is the requested one.
7. Re-run this sweep after any of these on a fresh set of shops: these five shops were now looked at, so they are no longer unseen.
