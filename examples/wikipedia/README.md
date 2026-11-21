# wikipedia

Getting from one Wikipedia article to another by following links.

**Shows:** navigating a real link graph with `open_link`, `go_back` and `end`. Link choices are closed sets taken from the
article, and the run is checked in code (did it end on the target?). Articles are fetched at a fixed snapshot so recordings
stay valid; `wikipediaFetch` retries 429/5xx and never records them.

```sh
npm run example:wikipedia -- --from "Alan Turing" --to "Enigma machine" [--max-steps 10]
```

Exits 0 only if the run ended on the target article.

Demo media (`docs/media/wikipedia-demo.{mp4,webp}`: a small MP4 and the animated WebP the README shows): `npm run example:wikipedia:demo -- [--from Telescope --to Jupiter] [--out docs/media] [--live]` replays the recorded run, screenshots each visited article on en.wikipedia.org (pinned revision) with Chromium, boxes the links on offer and circles the chosen one, and encodes with ffmpeg.

**Needs:** Jev: `TYPESAFE_API_KEY` in the environment (the cloud proxy supplies it in cloud sessions) and network access to Wikipedia (rate-limited; slow articles can answer 504). Pages already recorded in
`tests/cassettes/wikipedia-http` are reused. No browser.

**Files:** `wikipedia.ts` (tools), `article.ts` and `client.ts` (parsing, snapshot), `http.ts` (recording fetch), `main.ts` (runner), `demo.ts` (the README animation).
**Acceptance tests:** `tests/acceptance/wikipedia/`, replayed from `tests/cassettes/wikipedia` and `wikipedia-http`.
