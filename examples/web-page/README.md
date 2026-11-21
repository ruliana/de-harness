# web-page

The harness inside a web page: the browser bundle (`dist/de-harness.iife.min.js`) loaded with a plain `<script>` tag, an
agent that routes a customer message to a team, and the proxy that keeps the Jev key on the server.

**Shows:** the browser-safe core (`de-harness/core`, or the `DeHarness` global from the IIFE bundle), `JevModel` pointed at
the page's own server with `baseUrl`, and a thin proxy (`proxy.ts`) that adds the key. Jev refuses requests from browser
origins, and a key in page code would be public, so a page always talks to its own server.

```sh
npm run example:web-page -- "My invoice is wrong"   # one message, in headless Chromium
npm run example:web-page -- --serve                 # the page on http://127.0.0.1:8787/
```

From a CDN, once the package is on npm:

```html
<script src="https://cdn.jsdelivr.net/npm/de-harness@0.1.0/dist/de-harness.iife.min.js"></script>
<script type="module">
  import { createAgent, JevModel } from "https://cdn.jsdelivr.net/npm/de-harness@0.1.0/dist/de-harness.browser.min.js";
</script>
```

**Needs:** Jev through the proxy: `TYPESAFE_API_KEY` on the server (the cloud proxy supplies it in cloud sessions).
Chromium for the headless run.

**Files:** `page.html` (the page and its agent), `proxy.ts` (the Jev proxy), `site.ts` (serves both), `main.ts` (the runner).
**Acceptance test:** `tests/acceptance/web-page/web-page.test.ts`, replayed from `tests/cassettes/web-page`.
