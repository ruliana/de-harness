# storefront

A sample: "find a blue sweatshirt, select size large, and get the price" in a real Shopify shop (aloyoga.com), without a browser.

**Shows:** a multi-step task through a site's public JSON (menu, collection, product): `open_collection`, `filter_colour`,
`open_product`, `select_size`, `read_price`, `end`. `filter_colour` is a `param.set` with one yes/no question per colour; code
decides what passes the threshold. The example reads only: it sends an identifying User-Agent, never touches the cart or checkout,
and follows the site's rules for agents.

```sh
npm run example:storefront -- [--task "..."] [--max-steps 10]
```

Exits 0 when it ends having found a matching item.

**Needs:** Jev: `TYPESAFE_API_KEY` in the environment (the cloud proxy supplies it in cloud sessions) and network access to aloyoga.com. Prices and stock change, so a live run may differ from the recordings in
`tests/cassettes/storefront-http` (trimmed responses), which the acceptance test replays offline.

**Files:** `storefront.ts` (tools), `client.ts` (shop JSON), `http.ts` (recording fetch), `main.ts` (runner).
**Acceptance tests:** `tests/acceptance/storefront/`, cassettes in `tests/cassettes/storefront`.
