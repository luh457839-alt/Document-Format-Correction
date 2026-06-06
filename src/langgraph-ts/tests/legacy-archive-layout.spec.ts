import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../../");

describe("phase 1 archive layout", () => {
  it("archives legacy runtime assets and records the migration boundary", () => {
    expect(existsSync(path.join(repoRoot, "archive/legacy/python-host"))).toBe(true);
    expect(existsSync(path.join(repoRoot, "archive/legacy/frontend"))).toBe(true);
    expect(existsSync(path.join(repoRoot, "archive/legacy/ts-runtime/src"))).toBe(true);
    expect(existsSync(path.join(repoRoot, "archive/legacy/ts-runtime/tests"))).toBe(true);
    expect(existsSync(path.join(repoRoot, "src/python"))).toBe(false);
    expect(existsSync(path.join(repoRoot, "src/frontend"))).toBe(false);
    expect(existsSync(path.join(repoRoot, "src/ts/src"))).toBe(false);

    const readme = readFileSync(path.join(repoRoot, "archive/legacy/README.md"), "utf8");
    expect(readme).toContain("legacy 子目录原职责");
    expect(readme).toContain("不允许作为新运行时依赖");
    expect(readme).toContain("observation / package model");
    expect(readme).toContain("selector expansion");
    expect(readme).toContain("template classifier");
  });
});
