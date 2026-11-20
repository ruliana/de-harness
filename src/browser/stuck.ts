/**
 * The no-change guard. An agent that scrolls or presses a key and sees the same screenshot again is going in circles, and nothing in
 * a model's answer makes it stop. Code counts the runs of one tool that changed nothing; at the limit the tool is not offered any more,
 * until some other action changes the page.
 *
 * `state.stuck` holds the counts (`{ scroll: 2 }`) and exists only while there is one: any change of the screenshot deletes it.
 */
import type { Json } from "../state/state.js";

/** How many no-change runs of one tool it takes to stop offering it. */
export const DEFAULT_NO_CHANGE = 3;

const picture = (screen: unknown): string | undefined => (screen as { $image?: { base64?: string } } | undefined)?.$image?.base64;

/** The value of `state.stuck` after `tool` ran: one more for the tool when the screenshot is the same as before, none at all when it changed. */
export function nextStuck(previous: unknown, tool: string, before: unknown, after: unknown): Json | null {
  const was = picture(before);
  if (was === undefined || was !== picture(after)) return null;
  const counts = (previous ?? {}) as Record<string, number>;
  return { ...counts, [tool]: (counts[tool] ?? 0) + 1 };
}

/** True when `tool` has changed nothing `limit` times in a row. A limit of 0 turns the guard off. */
export function isStuck(stuck: unknown, tool: string, limit = DEFAULT_NO_CHANGE): boolean {
  return limit > 0 && ((stuck as Record<string, number> | undefined)?.[tool] ?? 0) >= limit;
}
