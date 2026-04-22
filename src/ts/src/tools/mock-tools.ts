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
    const targetNodeIds = readTargetNodeIds(op);
    if (targetNodeIds.length === 0) {
      throw new AgentError({
        code: "E_INVALID_OPERATION",
        message: "Write operation requires targetNodeId or targetNodeIds after selector expansion.",
        retryable: false
      });
    }
    const normalizedStyle = normalizeWriteOperationPayload(op);
    if (!input.context.dryRun) {
      for (const targetNodeId of targetNodeIds) {
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
    }

    return {
      doc: next,
      summary: buildWriteOperationSummary(op.type, targetNodeIds, input.context.dryRun),
      rollbackToken: `rb_${input.context.stepId}`
    };
  }

  async rollback(rollbackToken: string, doc: DocumentIR): Promise<DocumentIR> {
    const next = cloneDoc(doc);
    next.metadata = { ...(next.metadata ?? {}), lastRollbackToken: rollbackToken };
    return next;
  }
}

function readTargetNodeIds(input: NonNullable<ToolExecutionInput["operation"]>): string[] {
  if (Array.isArray(input.targetNodeIds) && input.targetNodeIds.length > 0) {
    return input.targetNodeIds;
  }
  return input.targetNodeId ? [input.targetNodeId] : [];
}

function buildWriteOperationSummary(operationType: string, targetNodeIds: string[], dryRun: boolean): string {
  if (targetNodeIds.length === 1) {
    return dryRun ? `Dry-run: ${operationType} prepared for ${targetNodeIds[0]}.` : `Applied ${operationType} to ${targetNodeIds[0]}.`;
  }
  return dryRun
    ? `Dry-run: ${operationType} prepared for ${targetNodeIds.length} nodes.`
    : `Applied ${operationType} to ${targetNodeIds.length} nodes.`;
}
