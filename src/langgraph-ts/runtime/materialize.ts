import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type { ParsedDocumentBundle } from "../contracts/document-contracts.js";
import type { RuntimeArtifactRef, RuntimeDiagnostic } from "./contracts.js";

export async function materializeBundle(
  bundle: ParsedDocumentBundle,
  outputPath: string
): Promise<{ artifact: RuntimeArtifactRef; diagnostics: RuntimeDiagnostic[] }> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const zip = new JSZip();
  for (const part of Object.values(bundle.package_snapshot.parts)) {
    if (part.kind === "xml") {
      zip.file(part.path, part.text ?? "");
      continue;
    }
    zip.file(part.path, Buffer.from(part.base64 ?? "", "base64"));
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(outputPath, buffer);
  return {
    artifact: {
      kind: "docx",
      path: outputPath
    },
    diagnostics: [
      {
        stage: "materialize",
        output_path: outputPath,
        part_count: Object.keys(bundle.package_snapshot.parts).length
      }
    ]
  };
}
