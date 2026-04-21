import { AgentError } from "../core/errors.js";
import type {
  DocumentIR,
  Tool,
  ToolExecutionInput,
  ToolExecutionOutput
} from "../core/types.js";
import { normalizeWriteOperationPayload } from "./style-operation.js";

function cloneDoc(doc: DocumentIR): DocumentIR {
  return structuredClone(doc);
}

export class InspectDocumentTool implements Tool {
  name = "inspect_document";
  readOnly = true;

  async validate(_input: ToolExecutionInput): Promise<void> {}

  async execute(input: ToolExecutionInput): Promise<ToolExecutionOutput> {
    return {
      doc: cloneDoc(input.doc),
      summary: `Inspected ${input.doc.nodes.length} node(s).`
    };
  }
}

export class WriteOperationTool implements Tool {
  name = "write_operation";
  readOnly = false;

  async validate(input: ToolExecutionInput): Promise<void> {
    if (!input.operation) {
      throw new AgentError({
        code: "E_INVALID_OPERATION",
        message: "Write operation is required.",
        retryable: false
      });
    }
    normalizeWriteOperationPayload(input.operation);
  }

  async execute(input: ToolExecutionInput): Promise<ToolExecutionOutput> {
    const next = cloneDoc(input.doc);
    const op = input.operation!;
    const targetNodeId = op.targetNodeId;
    if (!targetNodeId) {
      throw new AgentError({
        code: "E_INVALID_OPERATION",
        message: "Write operation requires targetNodeId after selector expansion.",
        retryable: false
      });
    }
    const normalizedStyle = normalizeWriteOperationPayload(op);
    if (!input.context.dryRun) {
      const target = next.nodes.find((n) => n.id === targetNodeId);
      if (!target) {
        throw new AgentError({
          code: "E_TARGET_NOT_FOUND",
          message: `Target node not found: ${targetNodeId}`,
          retryable: false
        });
      }
      target.style = { ...(target.style ?? {}), ...normalizedStyle, operation: op.type };
    }

    return {
      doc: next,
      summary: input.context.dryRun
        ? `Dry-run: ${op.type} skipped write.`
        : `Applied ${op.type} to ${targetNodeId}.`,
      rollbackToken: `rb_${input.context.stepId}`
    };
  }

  async rollback(rollbackToken: string, doc: DocumentIR): Promise<DocumentIR> {
    const next = cloneDoc(doc);
    next.metadata = { ...(next.metadata ?? {}), lastRollbackToken: rollbackToken };
    return next;
  }
}
