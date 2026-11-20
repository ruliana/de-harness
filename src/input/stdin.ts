/**
 * A user at a terminal: prints the prompt, reads one line from stdin. Works interactively and with piped input
 * (one line per question). When stdin ends, pending and later questions are rejected.
 */
import { createInterface, type Interface } from "node:readline";
import type { AskInput, InputProvider } from "./provider.js";

export class StdinInput implements InputProvider {
  private rl: Interface | undefined;
  private lines: string[] = [];
  private waiting: { resolve(line: string): void; reject(error: Error): void } | undefined;
  private ended = false;

  constructor(private readonly io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}) {}

  ask(prompt: string, { signal, choices }: AskInput): Promise<string> {
    this.start();
    const out = this.io.output ?? process.stdout;
    out.write(`\n${prompt}${choices?.length ? ` (${choices.join(" / ")})` : ""}\n> `);
    return new Promise<string>((resolve, reject) => {
      const buffered = this.lines.shift();
      if (buffered !== undefined) return resolve(buffered);
      if (this.ended) return reject(new Error("stdin has ended"));
      const onAbort = () => {
        this.waiting = undefined;
        reject(new Error("stopped waiting"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiting = {
        resolve: (line) => (signal.removeEventListener("abort", onAbort), resolve(line)),
        reject: (error) => (signal.removeEventListener("abort", onAbort), reject(error)),
      };
    });
  }

  /** Stop reading stdin, so the process can exit. */
  close(): void {
    this.rl?.close();
  }

  private start(): void {
    if (this.rl) return;
    this.rl = createInterface({ input: this.io.input ?? process.stdin, terminal: false });
    this.rl.on("line", (line) => {
      if (this.waiting) {
        const { resolve } = this.waiting;
        this.waiting = undefined;
        resolve(line);
      } else this.lines.push(line);
    });
    this.rl.on("close", () => {
      this.ended = true;
      this.waiting?.reject(new Error("stdin has ended"));
      this.waiting = undefined;
    });
  }
}
