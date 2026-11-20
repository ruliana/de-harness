# pizza

Ordering a pizza from a menu, to show the richer parameter types.

**Shows:** `place_order(size, toppings, delivery_time?)`: a `param.choice` for the size, a `param.set` for the toppings (one
yes/no question per topping, the value is the ones above the yes threshold), and an optional parameter that is only given when
the order says when to deliver. 'unsure' never counts as a member.

```sh
npm run example:pizza -- "A large pizza with mushrooms and olives, delivered at 7pm"
```

**Needs:** Jev: `TYPESAFE_API_KEY` in the environment (the cloud proxy supplies it in cloud sessions). No browser, no fixtures.

**Files:** `pizza.ts` (menu and tool), `main.ts` (runner; prints the orders placed).
**Acceptance test:** `tests/acceptance/params/pizza.test.ts`, replayed from `tests/cassettes/params`.
