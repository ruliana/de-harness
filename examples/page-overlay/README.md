# page-overlay

An assistant that lives on the page: a chat panel over the checkout of a small shop. You tell it what to do, and it operates the page behind it.

**Shows:** the harness as an overlay. `PageOverlay` (`src/browser/overlay.ts`, in the browser module) puts a panel on the page. The person types an
instruction into it; the agent works on the same page by sight (a screenshot, Box clicks, typing chosen from candidates) and the panel shows each step, a question when the
agent needs the person, and the result. Three things keep the agent from being confused by its own panel:

- the panel is **hidden from every picture the model sees** (screenshots and the enlarged pictures of small targets): `BrowserSession` hides what `hide` / `hideFromModel(selector)` names while it takes them, so there is nothing to point at;
- while the agent works (`overlay.working(true)`) the panel **lets the pointer through**, so a click aimed at the page lands on the page even where the panel covers it (the shop's *Place order* button lies under the panel on purpose), and its field is disabled, so typed text cannot land in it;
- it lives in a shadow root, so it is no part of the page's text (`browser.text()`), and its transcript is kept in Node and drawn again after each navigation.

The panel is also an input: `overlay.input` is an `InputProvider`, so a tool that calls `ctx.input.ask(question)` shows the question in the panel and **holds the loop**
until the person answers there. Here, `ask_user` is offered only when Jev judged, from the instruction alone, that it leaves something open ("does `instructions` say which delivery to choose?");
code reads anything but a clear yes as open and asks. Jev cannot write, so the details the assistant types (`PROFILE`) and the question it asks come from candidates. After each step that changed the page, one more yes/no question
("does the screenshot show the outcome that `instructions` ask for, such as a confirmation, and not a form still to be filled in?") decides whether `end` is offered at all, because a model that stops by itself, early, is not taken at its word.

```sh
npm run example:page-overlay -- [--scenario express|ask-express|ask-standard] [--runs 1] [--out shots/]   # a scripted person types into the panel, headless
npm run example:page-overlay -- --headed                                                                   # you type into the panel yourself (needs a display)
```

The scenarios: `express` ("Fill in my shipping details, choose express delivery and place the order"); `ask-express` and `ask-standard` ("... and ask me how fast I want it delivered, then place the order"; the scripted
person answers "Express please" / "Standard is fine"). `--out` saves what the person sees (the page with the panel) when the question is open and at the end. A run exits 0 only if the shop received exactly the order the person asked for.

To use the pieces on another page: `const overlay = await PageOverlay.install(browser)` after launching the session, give the agent `input: overlay.input`, wait for `overlay.nextInstruction()`, `overlay.say(text, "progress" | "result" | "error")` what happens,
and wrap the run in `overlay.working(true)` / `working(false)`. `examples/page-overlay/assistant.ts` is that loop (`serve`), with the page-specific parts (profile, questions, wording) at the top.

**Needs:** Jev: `TYPESAFE_API_KEY` in the environment (the cloud proxy supplies it in cloud sessions) and Chromium (`npm ci`, `npx playwright install chromium`). `--headed` needs a display. The shop is on loopback; no other network.

**Files:** `assistant.ts` (tools, questions, the loop behind the panel), `checkout-site.ts` (the shop's checkout page, bundled fonts), `run.ts` (a scripted person, scenarios, checks), `main.ts` (runner).
**Acceptance tests:** `tests/acceptance/page-overlay/`: `overlay.test.ts` (the panel's mechanics with a scripted model: hidden from the model's screenshot, click-through, disabled field, a question that holds the loop) and `assistant.test.ts` (Jev, replayed from `tests/cassettes/page-overlay`).
