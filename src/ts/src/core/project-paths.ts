import path from "node:path";

export function getTsProjectRoot(): string {
  return process.env.TS_AGENT_PROJECT_ROOT?.trim() || process.cwd();
}

export function getProjectRoot(): string {
  return process.env.DOC_FORMAT_PROJECT_ROOT?.trim() || path.resolve(getTsProjectRoot(), "..", "..");
}

export function getSessionsDir(): string {
  return path.join(getProjectRoot(), "sessions");
}

export function getOutputDir(): string {
  return path.join(getProjectRoot(), "output");
}

export function getAgentWorkspaceDir(): string {
  return path.join(getProjectRoot(), "agent_workspace");
}

export function getAgentMediaDir(): string {
  return path.join(getAgentWorkspaceDir(), "media");
}

export function getTempDir(): string {
  return path.join(getProjectRoot(), ".tmp");
}

export function getPythonToolRunnerPath(): string {
  return path.join(getProjectRoot(), "src", "python", "api", "python_tool_runner.py");
}

export function getWriterScriptPath(): string {
  return path.join(getProjectRoot(), "scripts", "write_docx_from_ir.py");
}
