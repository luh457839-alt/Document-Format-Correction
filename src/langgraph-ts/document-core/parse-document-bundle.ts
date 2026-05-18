import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { parseDocxToState } from "./legacy-docx-parser.js";
import { mapLegacyStateToBundle } from "./mappers.js";
import type { DocumentPackageSnapshot, ParsedDocumentBundle } from "../contracts/document-contracts.js";

export async function parseDocumentBundle(input: { docxPath: string; mediaDir?: string }): Promise<ParsedDocumentBundle> {
  const state = await parseDocxToState({
    docxPath: input.docxPath,
    mediaDir: input.mediaDir,
    allowFallback: false
  });
  const bundle = mapLegacyStateToBundle(state, input.docxPath);
  bundle.package_snapshot = await readPackageSnapshot(input.docxPath);
  return bundle;
}

async function readPackageSnapshot(docxPath: string): Promise<DocumentPackageSnapshot> {
  const buffer = await readFile(docxPath);
  const zip = await JSZip.loadAsync(buffer);
  const parts: DocumentPackageSnapshot["parts"] = {};
  for (const [partPath, file] of Object.entries(zip.files)) {
    if (!file || file.dir) {
      continue;
    }
    if (/\.xml$/i.test(partPath) || /\.rels$/i.test(partPath)) {
      parts[partPath] = {
        path: partPath,
        kind: "xml",
        text: await zip.file(partPath)?.async("string")
      };
      continue;
    }
    parts[partPath] = {
      path: partPath,
      kind: "binary",
      base64: (await zip.file(partPath)?.async("nodebuffer"))?.toString("base64")
    };
  }
  return { parts };
}
