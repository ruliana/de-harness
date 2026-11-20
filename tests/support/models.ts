import { CassetteModel } from "../../src/index.js";

/**
 * The model acceptance tests use: pinned Jev through a cassette under tests/cassettes/<item>.
 * Replay by default; `npm run test:live` records. TYPESAFE_API_KEY is used only when set (direct API access).
 */
export function jevFor(item: string) {
  return new CassetteModel({ dir: `tests/cassettes/${item}`, apiKey: process.env.TYPESAFE_API_KEY });
}
