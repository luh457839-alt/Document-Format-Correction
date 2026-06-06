import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import type { BaseMessage, AIMessage } from "@langchain/core/messages";
import { parseDocumentBundle } from "../document-core/parse-document-bundle.js";
import { tryCreateRuntimeModelFromConfig } from "../model/model-factory.js";
import { runDocumentAgentGraph } from "../runtime/graph.js";
import type {
  RuntimeCheckpointer,
  RuntimeModelAdapter,
  RuntimeInput,
  RuntimeDeps
} from "../runtime/contracts.js";
import type { ParsedDocumentBundle, RelationshipEdge } from "../contracts/document-contracts.js";
import type { WriteToolInput } from "../tooling/contracts.js";
import type { DocxPatchTarget } from "../document-core/docx-observation-schema.js";
import { normalizeProviderWriteToolInput } from "../model/provider-adapter.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.resolve(THIS_DIR, "..", "..", "..", "docs");
const SUPPORT_DIR_PREFIX = "langgraph-real-docx-";

export interface RealDocxSampleSpec {
  key:
    | "standard"
    | "image"
    | "hyperlink"
    | "headersFooters"
    | "stylesNumbering"
    | "settings"
    | "dirty"
    | "complex";
  name: string;
  fileName: string;
  expected: {
    paragraphs: number;
    tables: number;
    images: number;
    headers: number;
    footers: number;
    relationships: number;
    hasStyles: boolean;
    hasNumbering: boolean;
    hasSettings: boolean;
    hyperlinkRels: number;
  };
}

export const REAL_DOCX_SAMPLES: RealDocxSampleSpec[] = [
  {
    key: "standard",
    name: "标准正文样本",
    fileName: "标准正文样本.docx",
    expected: {
      paragraphs: 11,
      tables: 1,
      images: 0,
      headers: 1,
      footers: 1,
      relationships: 15,
      hasStyles: true,
      hasNumbering: true,
      hasSettings: true,
      hyperlinkRels: 0
    }
  },
  {
    key: "image",
    name: "含图片样本",
    fileName: "含图片样本.docx",
    expected: {
      paragraphs: 4,
      tables: 0,
      images: 1,
      headers: 0,
      footers: 0,
      relationships: 14,
      hasStyles: true,
      hasNumbering: true,
      hasSettings: true,
      hyperlinkRels: 0
    }
  },
  {
    key: "hyperlink",
    name: "含超链接样本",
    fileName: "含超链接样本.docx",
    expected: {
      paragraphs: 3,
      tables: 0,
      images: 0,
      headers: 0,
      footers: 0,
      relationships: 14,
      hasStyles: true,
      hasNumbering: true,
      hasSettings: true,
      hyperlinkRels: 1
    }
  },
  {
    key: "headersFooters",
    name: "含页眉页脚样本",
    fileName: "含页眉页脚样本.docx",
    expected: {
      paragraphs: 4,
      tables: 0,
      images: 0,
      headers: 4,
      footers: 4,
      relationships: 21,
      hasStyles: true,
      hasNumbering: true,
      hasSettings: true,
      hyperlinkRels: 0
    }
  },
  {
    key: "stylesNumbering",
    name: "样式与编号差异样本",
    fileName: "样式与编号差异样本.docx",
    expected: {
      paragraphs: 7,
      tables: 0,
      images: 0,
      headers: 0,
      footers: 0,
      relationships: 13,
      hasStyles: true,
      hasNumbering: true,
      hasSettings: true,
      hyperlinkRels: 0
    }
  },
  {
    key: "settings",
    name: "settings敏感样本",
    fileName: "settings敏感样本.docx",
    expected: {
      paragraphs: 2,
      tables: 0,
      images: 0,
      headers: 0,
      footers: 0,
      relationships: 13,
      hasStyles: true,
      hasNumbering: true,
      hasSettings: true,
      hyperlinkRels: 0
    }
  },
  {
    key: "dirty",
    name: "脏文档样本",
    fileName: "脏文档样本.docx",
    expected: {
      paragraphs: 2,
      tables: 0,
      images: 0,
      headers: 0,
      footers: 0,
      relationships: 13,
      hasStyles: true,
      hasNumbering: true,
      hasSettings: true,
      hyperlinkRels: 0
    }
  },
  {
    key: "complex",
    name: "高风险复杂样本",
    fileName: "高风险复杂样本.docx",
    expected: {
      paragraphs: 12,
      tables: 1,
      images: 1,
      headers: 1,
      footers: 1,
      relationships: 17,
      hasStyles: true,
      hasNumbering: true,
      hasSettings: true,
      hyperlinkRels: 1
    }
  }
];

export function getRealDocxSample(key: RealDocxSampleSpec["key"]): RealDocxSampleSpec {
  const sample = REAL_DOCX_SAMPLES.find((entry) => entry.key === key);
  if (!sample) {
    throw new Error(`Unknown real docx sample: ${key}`);
  }
  return sample;
}

export async function createRealDocxFixture(sample: RealDocxSampleSpec): Promise<RealDocxFixture> {
  const dir = await mkdtemp(path.join(os.tmpdir(), SUPPORT_DIR_PREFIX));
  const docxPath = path.join(DOCS_DIR, sample.fileName);
  const mediaDir = path.join(dir, "media");
  const bundle = await parseDocumentBundle({ docxPath, mediaDir });
  return new RealDocxFixture(sample, dir, docxPath, bundle);
}

export class RealDocxFixture {
  constructor(
    readonly sample: RealDocxSampleSpec,
    readonly dir: string,
    readonly docxPath: string,
    readonly bundle: ParsedDocumentBundle
  ) {}

  outputPath(suffix: string): string {
    const parsed = path.parse(this.docxPath);
    return path.join(this.dir, `${parsed.name}.${suffix}${parsed.ext}`);
  }

  findInlineTargetByText(text: string, partPath?: string): { target: DocxPatchTarget; runId: string } {
    const inline = this.bundle.document_ast.inlineNodes.find(
      (node) => node.nodeType === "text" && node.text === text && (!partPath || node.partPath === partPath)
    );
    if (!inline?.id) {
      throw new Error(`Missing inline node with text '${text}'`);
    }
    return {
      target: requirePatchTarget(this.bundle, `target:inline:${inline.id}`),
      runId: inline.id
    };
  }

  findFirstWritableInlineInPart(partPath: string): { target: DocxPatchTarget; runId: string; text: string } {
    const inline = this.bundle.document_ast.inlineNodes.find(
      (node) => node.nodeType === "text" && Boolean(node.id) && node.partPath === partPath
    );
    if (!inline?.id) {
      throw new Error(`Missing writable inline node in part '${partPath}'`);
    }
    return {
      target: requirePatchTarget(this.bundle, `target:inline:${inline.id}`),
      runId: inline.id,
      text: inline.text ?? ""
    };
  }

  findBlockTargetByText(text: string, partPath?: string): DocxPatchTarget {
    const paragraph = this.bundle.structure_index.paragraphs.find(
      (entry) => entry.text === text && (!partPath || entry.partPath === partPath)
    );
    if (!paragraph) {
      throw new Error(`Missing paragraph with text '${text}'`);
    }
    return requirePatchTarget(this.bundle, `target:block:${paragraph.id}`);
  }

  findBlockTargetByPartTextContains(partPath: string, fragment: string): DocxPatchTarget {
    const paragraph = this.bundle.structure_index.paragraphs.find(
      (entry) => entry.partPath === partPath && entry.text.includes(fragment)
    );
    if (!paragraph) {
      throw new Error(`Missing paragraph in '${partPath}' containing '${fragment}'`);
    }
    return requirePatchTarget(this.bundle, `target:block:${paragraph.id}`);
  }

  findPatchTargetsByPart(partPath: string, kind: DocxPatchTarget["target_kind"]): DocxPatchTarget[] {
    return readPatchTargets(this.bundle).filter((target) => target.part_path === partPath && target.target_kind === kind);
  }

  cleanup(): Promise<void> {
    return rm(this.dir, { recursive: true, force: true });
  }
}

export function requirePatchTarget(bundle: ParsedDocumentBundle, targetId: string): DocxPatchTarget {
  const target = readPatchTargets(bundle).find((entry) => entry.id === targetId);
  if (!target) {
    throw new Error(`Missing patch target ${targetId}`);
  }
  return target;
}

export function readPatchTargets(bundle: ParsedDocumentBundle): DocxPatchTarget[] {
  return (bundle.document_ast.patchTargets as DocxPatchTarget[]) ?? [];
}

export function collectBundleHealth(bundle: ParsedDocumentBundle) {
  return {
    paragraphs: bundle.document_ast.documentMeta.totalParagraphs,
    tables: bundle.document_ast.documentMeta.totalTables,
    images: bundle.document_ast.documentMeta.totalImages ?? 0,
    headers: bundle.document_ast.documentMeta.totalHeaders ?? 0,
    footers: bundle.document_ast.documentMeta.totalFooters ?? 0,
    relationships: bundle.document_package.packageMeta.relationshipCount,
    hasStyles: Boolean(bundle.package_snapshot.parts["word/styles.xml"]),
    hasNumbering: Boolean(bundle.package_snapshot.parts["word/numbering.xml"]),
    hasSettings: Boolean(bundle.package_snapshot.parts["word/settings.xml"]),
    hyperlinkRels: countRelationships(bundle, /hyperlink/i)
  };
}

export function countRelationships(bundle: ParsedDocumentBundle, pattern: RegExp): number {
  return bundle.relationship_graph.edges.filter((entry) => pattern.test(entry.type)).length;
}

export async function loadZip(outputPath: string): Promise<JSZip> {
  return JSZip.loadAsync(await readFile(outputPath));
}

export async function readZipText(outputPath: string, partPath: string): Promise<string> {
  const zip = await loadZip(outputPath);
  return (await zip.file(partPath)?.async("string")) ?? "";
}

export function findRelationship(bundle: ParsedDocumentBundle, predicate: (edge: RelationshipEdge) => boolean): RelationshipEdge {
  const match = bundle.relationship_graph.edges.find(predicate);
  if (!match) {
    throw new Error("Expected relationship edge was not found.");
  }
  return match;
}

export class InMemoryCheckpointer implements RuntimeCheckpointer {
  private readonly state = new Map<string, unknown>();

  async load(threadId: string): Promise<unknown | undefined> {
    return this.state.get(threadId);
  }

  async save(threadId: string, state: unknown): Promise<void> {
    this.state.set(threadId, structuredClone(state));
  }
}

type ModelStep =
  | {
      type: "ai";
      text: string;
      toolCalls?: Array<{
        id: string;
        name: string;
        args: WriteToolInput;
      }>;
    };

export class StaticModelAdapter implements RuntimeModelAdapter {
  private readonly steps: ModelStep[];
  private index = 0;

  constructor(steps: ModelStep[]) {
    this.steps = steps;
  }

  async invoke(_messages: BaseMessage[], _input: RuntimeInput): Promise<AIMessage> {
    const step = this.steps[this.index] ?? { type: "ai", text: "默认回复。" };
    this.index += 1;
    const { AIMessage } = await import("@langchain/core/messages");
    return new AIMessage({
      content: step.text,
      tool_calls: step.toolCalls?.map((call) => ({
        id: call.id,
        name: call.name,
        args: call.args
      }))
    });
  }
}

export async function parseOutputDocx(outputPath: string, label = "reparsed"): Promise<ParsedDocumentBundle> {
  const mediaDir = await mkdtemp(path.join(os.tmpdir(), `${SUPPORT_DIR_PREFIX}${label}-`));
  try {
    return await parseDocumentBundle({ docxPath: outputPath, mediaDir });
  } finally {
    await rm(mediaDir, { recursive: true, force: true });
  }
}

export async function runPhase3WithStaticModel(
  fixture: RealDocxFixture,
  input: Omit<RuntimeInput, "document_path">,
  steps: ModelStep[],
  deps?: Partial<RuntimeDeps>
) {
  return runDocumentAgentGraph(
    {
      ...input,
      document_path: fixture.docxPath
    },
    {
      model: deps?.model ?? new StaticModelAdapter(steps),
      checkpoint: deps?.checkpoint
    }
  );
}

export async function normalizeOpenAICompatibleWriteToolInputForSmoke(
  rawInput: unknown,
  runtimeInput: Pick<RuntimeInput, "document_path">
): Promise<WriteToolInput> {
  return normalizeProviderWriteToolInput(rawInput, runtimeInput);
}

export async function synthesizeSmokeWriteToolInputFromPrompt(
  input: Pick<RuntimeInput, "document_path" | "user_message">
): Promise<WriteToolInput | undefined> {
  const textReplacement = extractQuotedText(input.user_message);
  if (/第一段正文/.test(input.user_message) && textReplacement) {
    const bundle = await parseBundleForSmoke(input.document_path);
    const firstBodyParagraph = bundle.structure_index.paragraphs.find((paragraph) => paragraph.role === "body");
    if (!firstBodyParagraph) {
      throw new Error("Cannot synthesize smoke write target for first body paragraph.");
    }
    return {
      request_id: "smoke-standard-write",
      operation: "set_text",
      target: {
        kind: "selector",
        selector: {
          scope: "paragraph_ids",
          paragraphIds: [firstBodyParagraph.id]
        }
      },
      payload: {
        value: textReplacement
      }
    };
  }

  const fontName = extractFontName(input.user_message);
  if (/二级标题/.test(input.user_message) && fontName) {
    return {
      request_id: "smoke-style-write",
      operation: "set_font",
      target: {
        kind: "selector",
        selector: {
          scope: "heading",
          headingLevel: 2
        }
      },
      payload: {
        font_name: fontName
      }
    };
  }

  const paperSize = /A4/i.test(input.user_message) ? "A4" : /Letter/i.test(input.user_message) ? "Letter" : undefined;
  if ((/页面设置/.test(input.user_message) || /settings/i.test(input.user_message)) && paperSize) {
    return {
      request_id: "smoke-settings-write",
      operation: "set_page_layout",
      target: {
        kind: "patch_targets",
        patch_target_ids: ["target:document:section:0"],
        patch_part_paths: ["word/document.xml"]
      },
      payload: {
        paper_size: paperSize
      }
    };
  }

  return undefined;
}

export function createOpenAICompatibleModelFromEnv(): {
  model: RuntimeModelAdapter;
  reason?: undefined;
} | {
  model?: undefined;
  reason: string;
} {
  return tryCreateRuntimeModelFromConfig("chat");
}

async function parseBundleForSmoke(documentPath: string): Promise<ParsedDocumentBundle> {
  const mediaDir = await mkdtemp(path.join(os.tmpdir(), `${SUPPORT_DIR_PREFIX}model-`));
  try {
    return await parseDocumentBundle({ docxPath: documentPath, mediaDir });
  } finally {
    await rm(mediaDir, { recursive: true, force: true });
  }
}

function extractQuotedText(value: string): string | undefined {
  const match = value.match(/[“"]([^”"]+)[”"]/);
  return match?.[1]?.trim() || undefined;
}

function extractFontName(value: string): string | undefined {
  const match = value.match(/字体改成\s*([A-Za-z0-9 _-]+)/i);
  return match?.[1]?.trim().replace(/[，。,.]+$/g, "") || undefined;
}
