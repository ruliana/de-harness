import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HarnessEvent } from "./events.js";

/** Writes each event as one JSON line. The file is truncated when the run starts. */
export class TraceWriter {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }
  write(event: HarnessEvent): void {
    appendFileSync(this.path, JSON.stringify(event) + "\n");
  }
}
