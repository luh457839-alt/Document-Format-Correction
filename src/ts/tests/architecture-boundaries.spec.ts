import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../src");

async function readSource(relativePath: string): Promise<string> {
  return await readFile(path.join(root, relativePath), "utf8");
}

describe("architecture boundaries", () => {
  it("keeps template modules off direct runtime internals", async () => {
    await expect(readSource("templates/template-classifier.ts")).resolves.not.toContain("../planner/llm-planner.js");
    await expect(readSource("templates/template-runner.ts")).resolves.not.toContain("../tools/python-tool-client.js");
    await expect(readSource("templates/template-executor.ts")).resolves.not.toContain("../executor/default-executor.js");
    await expect(readSource("templates/template-executor.ts")).resolves.not.toContain("../tools/python-tool-proxy.js");
  });

  it("keeps runtime assembly on shared facades instead of python internals", async () => {
    await expect(readSource("runtime/engine.ts")).resolves.not.toContain("../tools/python-tool-client.js");
    await expect(readSource("runtime/engine.ts")).resolves.not.toContain("../tools/python-tool-proxy.js");
  });

  it("keeps session service isolated from template implementation", async () => {
    await expect(readSource("runtime/session-service.ts")).resolves.not.toContain("../templates/");
  });
});
