import type { ParsedDocumentBundle } from "../contracts/document-contracts.js";
import type { DocxPatchTarget } from "../document-core/docx-observation-schema.js";

export function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function readPatchTargets(bundle: ParsedDocumentBundle): DocxPatchTarget[] {
  return (bundle.document_ast.patchTargets as DocxPatchTarget[] | undefined) ?? [];
}

export function readDocumentPartPath(bundle: ParsedDocumentBundle): string {
  return (
    bundle.document_package.parts.find((part) => part.path === "word/document.xml")?.path ??
    bundle.document_package.packageMeta.partPaths.find((partPath) => partPath === "word/document.xml") ??
    "word/document.xml"
  );
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry)])
    );
  }
  return value;
}
