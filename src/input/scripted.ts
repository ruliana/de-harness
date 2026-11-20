/**
 * A user that answers from a script, for acceptance tests. Replies are consumed in order, one per `ask`.
 *
 *   new ScriptedInput(["large please"])                              answers at once
 *   new ScriptedInput([{ reply: "large please", delayMs: 500 }])     answers after 500 ms
 *   new ScriptedInput([(prompt) => prompt.includes("size") ? "large" : "no"])
 *   new ScriptedInput([{ never: true }])                             never answers (timeout / abort tests)
 *
 * `delayMs` in the options is the default delay of every reply. Every prompt asked is kept in `asked`.
 * Asking more often than the script allows throws.
 */
import type { AskInput, InputProvider } from "./provider.js";

export type ScriptedReply = string | { reply: string; delayMs?: number } | { never: true } | ((prompt: string) => string);

export class ScriptedInput implements InputProvider {
  readonly asked: string[] = [];
  private next = 0;

  constructor(private readonly script: ScriptedReply[], private readonly options: { delayMs?: number } = {}) {}

  async ask(prompt: string, { signal }: AskInput): Promise<string> {
    this.asked.push(prompt);
    const entry = this.script[this.next++];
    if (entry === undefined) throw new Error(`ScriptedInput: the script has ${this.script.length} repl${this.script.length === 1 ? "y" : "ies"}, but was asked ${this.next} times (prompt: ${prompt})`);
    if (typeof entry === "object" && "never" in entry) return new Promise<string>(() => {}); // the harness stops waiting on timeout or abort
    const delayMs = typeof entry === "object" && "delayMs" in entry && entry.delayMs !== undefined ? entry.delayMs : this.options.delayMs ?? 0;
    if (delayMs > 0) await sleep(delayMs, signal);
    return typeof entry === "string" ? entry : typeof entry === "function" ? entry(prompt) : entry.reply;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("stopped waiting"))), { once: true });
  });
}
