# screen

A sign-up form that the agent can only see as a picture.

**Shows:** images in the state (`imageFile`) and `param.box`: the model points at the Submit button with a bounding box and
code decides what the box means (a click inside the button). `null` means the element is not on the screen.

```sh
npm run example:screen -- "Click the Submit button" --out proof.png   # --out draws the model's box on the screen
HARNESS_CASSETTE=replay npm run example:screen                        # answer from the recordings, no key needed
npm run example:screen:fixtures                                       # redraw fixtures/*.png
```

**Needs:** Jev: `TYPESAFE_API_KEY` in the environment (the cloud proxy supplies it in cloud sessions), or replay mode as above. The screens (`fixtures/form.png`, `done.png`) are drawn by code and committed, so tests
and cassettes always see the same bytes. No browser.

**Files:** `screen.ts` (the tool), `render.ts` and `canvas.ts` (drawing), `main.ts` (runner).
**Acceptance test:** `tests/acceptance/images/screen.test.ts`, replayed from `tests/cassettes/screen`.
