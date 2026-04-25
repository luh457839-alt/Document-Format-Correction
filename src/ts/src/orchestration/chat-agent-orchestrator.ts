import type { DocumentIR, ExecutionResult } from "../core/types.js";
import type { RuntimeRunOptions } from "../runtime/engine.js";

export interface ChatAgentOrchestrator {
  run(goal: string, doc: DocumentIR, options?: RuntimeRunOptions): Promise<ExecutionResult>;
}

export class DefaultChatAgentOrchestrator implements ChatAgentOrchestrator {
  constructor(private readonly runtime: ChatAgentOrchestrator) {}

  async run(goal: string, doc: DocumentIR, options?: RuntimeRunOptions): Promise<ExecutionResult> {
    return await this.runtime.run(goal, doc, options);
  }
}

export function createChatAgentOrchestrator(runtime: ChatAgentOrchestrator): ChatAgentOrchestrator {
  return new DefaultChatAgentOrchestrator(runtime);
}
