import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writePhaseOneFixtureDocx } from "./test-fixtures.js";
import { parseDocumentBundle } from "../document-core/parse-document-bundle.js";
import type { ParsedDocumentBundle } from "../contracts/document-contracts.js";
import type { DocxPatchTarget } from "../document-core/docx-observation-schema.js";
import { applyPatchOperationsToBundle } from "../runtime/bundle-mutation.js";
import { reconcileBundleRelationships } from "../runtime/relationship-reconcile.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "langgraph-phase4-reconcile-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("phase 4 relationship reconcile", () => {
  it("adds settings relationships and content types for newly materialized settings parts", async () => {
    const bundle = await createFixtureBundle();
    const settingsTarget: DocxPatchTarget = {
      id: "target:settings:settings",
      target_kind: "settings_node",
      part_path: "word/settings.xml",
      block_id: "settings",
      locator: {
        part_path: "word/settings.xml",
        xml_path: "/settings"
      }
    };
    const mutated = applyPatchOperationsToBundle(bundle, [settingsTarget], [
      {
        id: "settings",
        type: "set_attr",
        target_id: settingsTarget.id,
        name: "w:zoom",
        value: "bestFit"
      }
    ]).bundle;

    const reconciled = reconcileBundleRelationships(mutated);

    expect(reconciled.bundle.package_snapshot.parts["word/_rels/document.xml.rels"]?.text).toMatch(/relationships\/settings/);
    expect(reconciled.bundle.package_snapshot.parts["[Content_Types].xml"]?.text).toMatch(/\/word\/settings\.xml/);
    expect(reconciled.bundle.relationship_graph.bySource["word/document.xml"]?.some((edge) => edge.target === "word/settings.xml")).toBe(true);
    expect(reconciled.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ stage: "reconcile", added_relationship_count: 1 })])
    );
  });

  it("adds new header relationships for newly referenced header parts", async () => {
    const bundle = await createFixtureBundle();
    const sectionTarget: DocxPatchTarget = {
      id: "target:document:section:0",
      target_kind: "block",
      part_path: "word/document.xml",
      block_id: "section:0",
      locator: {
        part_path: "word/document.xml",
        xml_path: "/document/body/sectPr[0]"
      }
    };
    const mutated = structuredClone(bundle);
    mutated.package_snapshot.parts["word/header2.xml"] = {
      path: "word/header2.xml",
      kind: "xml",
      text:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>新增页眉</w:t></w:r></w:p></w:hdr>'
    };

    const updated = applyPatchOperationsToBundle(mutated, [sectionTarget], [
      {
        id: "header-ref",
        type: "ensure_node",
        target_id: sectionTarget.id,
        path: "/document/body/sectPr[0]",
        xml_tag: "w:headerReference",
        attrs: {
          "w:type": "first",
          "r:id": "rIdHeader2"
        }
      }
    ]).bundle;

    const reconciled = reconcileBundleRelationships(updated);

    expect(reconciled.bundle.package_snapshot.parts["word/_rels/document.xml.rels"]?.text).toMatch(/Id="rIdHeader2"/);
    expect(reconciled.bundle.package_snapshot.parts["word/_rels/document.xml.rels"]?.text).toMatch(/Target="header2\.xml"/);
    expect(reconciled.bundle.package_snapshot.parts["[Content_Types].xml"]?.text).toMatch(/\/word\/header2\.xml/);
    expect(reconciled.bundle.relationship_graph.bySource["word/document.xml"]?.some((edge) => edge.target === "word/header2.xml")).toBe(true);
  });

  it("fails structurally for unsupported hyperlink references that cannot be reconciled", async () => {
    const bundle = await createFixtureBundle();
    const paragraphTarget = requirePatchTarget(bundle, "target:block:p_1");
    const mutated = applyPatchOperationsToBundle(bundle, [paragraphTarget], [
      {
        id: "hyperlink",
        type: "ensure_node",
        target_id: paragraphTarget.id,
        path: "/document/body/p[1]",
        xml_tag: "w:hyperlink",
        attrs: {
          "r:id": "rIdHyperlink42"
        }
      }
    ]).bundle;

    expect(() => reconcileBundleRelationships(mutated)).toThrow(/E_UNSUPPORTED_REFERENCE_KIND|hyperlink/i);
  });
});

async function createFixtureBundle(): Promise<ParsedDocumentBundle> {
  const dir = await makeTempDir();
  const docxPath = path.join(dir, "sample.docx");
  await writePhaseOneFixtureDocx(docxPath);
  return parseDocumentBundle({ docxPath, mediaDir: path.join(dir, "media") });
}

function requirePatchTarget(bundle: ParsedDocumentBundle, targetId: string): DocxPatchTarget {
  const target = (bundle.document_ast.patchTargets as DocxPatchTarget[]).find((entry) => entry.id === targetId);
  if (!target) {
    throw new Error(`Missing patch target ${targetId}`);
  }
  return target;
}
