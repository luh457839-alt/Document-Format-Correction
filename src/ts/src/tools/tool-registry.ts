import { AgentError } from "../core/errors.js";
import type { Tool, ToolRegistry } from "../core/types.js";

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new AgentError({
        code: "E_TOOL_NOT_FOUND",
        message: `Tool not found: ${name}`,
        retryable: false
      });
    }
    return tool;
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }
}

