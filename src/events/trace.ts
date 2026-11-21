import type { HarnessEvent } from "./events.js";

/** Writes each event as one JSON line. The file is truncated when the run starts. */
export type TraceWriter = { write(event: HarnessEvent): void };

/**
 * Opens a JSONL trace file. `node:fs` is loaded only here, when a run asks for a trace file, so the core loads in a
 * browser; there, pass `onEvent` instead of `trace`.
 */
export async function openTrace(path: string): Promise<TraceWriter> {
  const fs = await import("node:fs").catch(() => {
    throw new Error("trace: writing a trace file needs Node; in a browser use onEvent instead");
  });
  const { dirname } = await import("node:path");
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, "");
  return { write: (event) => fs.appendFileSync(path, JSON.stringify(event) + "\n") };
}
