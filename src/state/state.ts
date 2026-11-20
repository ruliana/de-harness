import type { Answer } from "../model/types.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type StateView = Readonly<Record<string, any>>;

export type PreviousAction = { tool: string; args: Record<string, unknown>; summary?: string };

/**
 * The state document sent with every request:
 *   instructions      given at start, repeated unchanged at every step
 *   state             named slots that tools write (a slot is replaced, never appended; null deletes it)
 *   previous_actions  the last N actions, to avoid loops without sending the whole history
 * Step counters and ids are left out on purpose: irrelevant fields lower accuracy.
 */
export class StateDocument {
  private slots: Record<string, Json> = {};
  private actions: PreviousAction[] = [];

  constructor(initial: Record<string, Json> = {}) {
    this.merge(initial);
  }

  /** Replace slots with the given values; `null` deletes a slot. */
  merge(update: Record<string, Json | null | undefined>): void {
    for (const [key, value] of Object.entries(update)) {
      if (value === null || value === undefined) delete this.slots[key];
      else this.slots[key] = structuredClone(value);
    }
  }

  has(slot: string): boolean {
    return slot in this.slots;
  }

  /** How many previous actions are recorded (the window decides how many are shown). */
  actionCount(): number {
    return this.actions.length;
  }

  record(action: PreviousAction): void {
    this.actions.push(structuredClone(action));
  }

  /** A copy tools can read without being able to change the real state. */
  view(): StateView {
    return structuredClone(this.slots);
  }

  /** `show` newest previous actions; `withActions` false leaves the field out (previous actions disabled). */
  document(instructions: string, show: number, withActions = show > 0): Record<string, unknown> {
    return {
      instructions,
      state: structuredClone(this.slots),
      ...(withActions ? { previous_actions: show > 0 ? this.actions.slice(-show) : [] } : {}),
    };
  }
}

export type RawAnswers = Record<string, Answer>;
