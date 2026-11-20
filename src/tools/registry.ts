import type { AnyTool } from "./tool.js";

/** The live set of tools of one agent. Read fresh at every step. */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  constructor(tools: AnyTool[] = []) {
    for (const t of tools) this.add(t);
  }

  add(tool: AnyTool): this {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(tool.name) || tool.name.startsWith("__")) throw new Error(`Invalid tool name: ${JSON.stringify(tool.name)}`);
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  remove(name: string): boolean {
    return this.tools.delete(name);
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
