import type { AnyTool } from "./tool.js";

export type ToolChange = { change: "added" | "removed"; tool: string };

/** Tools that always stay registered. */
const PROTECTED = new Set(["end"]);

/**
 * The live set of tools of one agent. Read fresh at every step, so the question map always matches it.
 * Guards: a name can be registered once, and the built-in `end` can't be removed (both throw; inside a tool's `run`
 * a throw becomes the `error` slot and leaves the registry unchanged).
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();
  private readonly listeners = new Set<(change: ToolChange) => void>();

  constructor(tools: AnyTool[] = []) {
    for (const t of tools) this.add(t);
  }

  add(tool: AnyTool): this {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(tool.name) || tool.name.startsWith("__")) throw new Error(`Invalid tool name: ${JSON.stringify(tool.name)}`);
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
    this.notify({ change: "added", tool: tool.name });
    return this;
  }

  /** Returns false when there was no such tool. Removing a tool that is running is fine: it applies from the next step. */
  remove(name: string): boolean {
    if (PROTECTED.has(name)) throw new Error(`Tool "${name}" is built in and can't be removed`);
    const removed = this.tools.delete(name);
    if (removed) this.notify({ change: "removed", tool: name });
    return removed;
  }

  /** Be told about every add and remove. Returns the function that stops listening. */
  onChange(listener: (change: ToolChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(change: ToolChange): void {
    for (const l of this.listeners) l(change);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  /** Tools in registration order (a stable order keeps runs replayable). */
  list(): AnyTool[] {
    return [...this.tools.values()];
  }
}
