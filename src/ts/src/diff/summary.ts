import type { ChangeSet } from "../core/types.js";

export function summarizeChangeSet(changeSet: ChangeSet): string {
  const count = changeSet.changes.length;
  const rollbackText = changeSet.rolledBack ? "rolled back" : "committed";
  const summaries = changeSet.changes.map((c) => `- ${c.stepId}: ${c.summary}`).join("\n");
  return `ChangeSet(${changeSet.taskId}) ${rollbackText}, total=${count}\n${summaries}`;
}

