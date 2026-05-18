import path from "node:path";

export function getRepoRoot(): string {
  return path.resolve(import.meta.dirname, "../../..");
}

export function getAgentMediaDir(): string {
  return path.join(getRepoRoot(), ".tmp", "langgraph-ts-media");
}
