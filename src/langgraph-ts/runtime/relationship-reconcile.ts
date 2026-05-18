import type { ParsedDocumentBundle, RelationshipEdge } from "../contracts/document-contracts.js";
import { AgentError } from "../core/errors.js";
import type { Phase3Diagnostic } from "./contracts.js";
import {
  childElements,
  createContentTypesDocument,
  createRelationshipsDocument,
  findElementByXmlPath,
  localNameOf,
  parseXmlDocument,
  readQualifiedAttribute,
  serializeXmlDocument,
  setQualifiedAttribute
} from "./xml-mutation-helpers.js";

const DOCUMENT_REL_SOURCE = "word/document.xml";

type SupportedReferenceKind = "settings" | "header" | "footer" | "image" | "hyperlink";

interface DesiredRelationship {
  id: string;
  type: string;
  target?: string;
  targetMode?: string;
  kind: SupportedReferenceKind;
}

interface RelationshipPartEntry {
  sourcePart: string;
  id: string;
  type: string;
  target: string;
  targetMode?: string;
}

export function reconcileBundleRelationships(
  bundle: ParsedDocumentBundle
): { bundle: ParsedDocumentBundle; diagnostics: Phase3Diagnostic[] } {
  const nextBundle = structuredClone(bundle);
  const existing = readRelationshipEntries(nextBundle);
  const documentExisting = existing.get(DOCUMENT_REL_SOURCE) ?? [];
  const desired = collectDocumentDesiredRelationships(nextBundle, documentExisting);
  const preserved = documentExisting.filter((entry) => !isManagedRelationshipType(entry.type));
  const nextDocumentEntries = reconcileManagedEntries(documentExisting, desired).concat(preserved);
  existing.set(DOCUMENT_REL_SOURCE, sortEntries(nextDocumentEntries));
  writeRelationshipEntries(nextBundle, existing);
  ensureContentTypes(nextBundle);
  refreshRelationshipGraph(nextBundle, existing);
  refreshPackageMetadata(nextBundle, existing);

  const previousManagedCount = documentExisting.filter((entry) => isManagedRelationshipType(entry.type)).length;
  const nextManagedCount = nextDocumentEntries.filter((entry) => isManagedRelationshipType(entry.type)).length;
  return {
    bundle: nextBundle,
    diagnostics: [
      {
        stage: "reconcile",
        reconciled_part_count: 1,
        added_relationship_count: Math.max(0, nextManagedCount - previousManagedCount),
        removed_relationship_count: Math.max(0, previousManagedCount - nextManagedCount)
      }
    ]
  };
}

function collectDocumentDesiredRelationships(
  bundle: ParsedDocumentBundle,
  existing: RelationshipPartEntry[]
): DesiredRelationship[] {
  const desired: DesiredRelationship[] = [];
  if (bundle.package_snapshot.parts["word/settings.xml"]) {
    desired.push({
      id: findExistingRelationshipId(existing, settingsType()) ?? "rIdSettings1",
      type: settingsType(),
      target: "word/settings.xml",
      kind: "settings"
    });
  }

  const documentXml = bundle.package_snapshot.parts[DOCUMENT_REL_SOURCE]?.text;
  if (!documentXml) {
    return desired;
  }
  const document = parseXmlDocument(documentXml);
  const section = findElementByXmlPath(document, "/document/body/sectPr[0]");
  if (section) {
    const references = childElements(section).filter(
      (child) => localNameOf(child) === "headerReference" || localNameOf(child) === "footerReference"
    );
    for (const reference of references) {
      const id = readQualifiedAttribute(reference, "r:id");
      if (!id) {
        continue;
      }
      const local = localNameOf(reference);
      desired.push({
        id,
        type: local === "headerReference" ? headerType() : footerType(),
        target:
          findExistingTarget(existing, id) ??
          inferSingleAvailablePart(bundle, local === "headerReference" ? "header" : "footer", existing),
        kind: local === "headerReference" ? "header" : "footer"
      });
    }
  }

  const imageReferences = Array.from(document.getElementsByTagName("*")).filter((element) => localNameOf(element) === "blip");
  for (const reference of imageReferences) {
    const id = readQualifiedAttribute(reference, "r:embed");
    if (!id) {
      continue;
    }
    desired.push({
      id,
      type: imageType(),
      target: findExistingTarget(existing, id) ?? inferSingleAvailablePart(bundle, "image", existing),
      kind: "image"
    });
  }

  const hyperlinks = Array.from(document.getElementsByTagName("*")).filter((element) => localNameOf(element) === "hyperlink");
  for (const hyperlink of hyperlinks) {
    const id = readQualifiedAttribute(hyperlink, "r:id");
    if (!id) {
      continue;
    }
    const existingTarget = existing.find((entry) => entry.id === id);
    if (!existingTarget?.targetMode || !existingTarget.target) {
      throw new AgentError({
        code: "E_UNSUPPORTED_REFERENCE_KIND",
        message: `hyperlink relationship '${id}' cannot be inferred from the current bundle.`,
        retryable: false
      });
    }
    desired.push({
      id,
      type: hyperlinkType(),
      target: existingTarget.target,
      targetMode: existingTarget.targetMode,
      kind: "hyperlink"
    });
  }

  return desired;
}

function reconcileManagedEntries(existing: RelationshipPartEntry[], desired: DesiredRelationship[]): RelationshipPartEntry[] {
  const byId = new Map(existing.map((entry) => [entry.id, entry] as const));
  const next: RelationshipPartEntry[] = [];
  for (const entry of desired) {
    if (!entry.target) {
      throw new AgentError({
        code: "E_UNSUPPORTED_REFERENCE_KIND",
        message: `${entry.kind} relationship '${entry.id}' cannot be reconciled with the current bundle parts.`,
        retryable: false
      });
    }
    const existingEntry = byId.get(entry.id);
    next.push({
      sourcePart: DOCUMENT_REL_SOURCE,
      id: entry.id,
      type: entry.type,
      target: entry.target,
      ...(entry.targetMode ?? existingEntry?.targetMode ? { targetMode: entry.targetMode ?? existingEntry?.targetMode } : {})
    });
  }
  return next;
}

function readRelationshipEntries(bundle: ParsedDocumentBundle): Map<string, RelationshipPartEntry[]> {
  const entries = new Map<string, RelationshipPartEntry[]>();
  for (const [partPath, part] of Object.entries(bundle.package_snapshot.parts)) {
    if (!/\.rels$/i.test(partPath) || part.kind !== "xml" || !part.text) {
      continue;
    }
    const sourcePart = relsPathToSourcePartPath(partPath);
    const document = parseXmlDocument(part.text);
    const relationships = Array.from(document.getElementsByTagName("*")).filter((element) => localNameOf(element) === "Relationship");
    entries.set(
      sourcePart,
      relationships.map((element) => ({
        sourcePart,
        id: element.getAttribute("Id") ?? "",
        type: element.getAttribute("Type") ?? "",
        target: normalizeRelationshipTarget(sourcePart, element.getAttribute("Target") ?? ""),
        targetMode: element.getAttribute("TargetMode") ?? undefined
      }))
    );
  }
  return entries;
}

function writeRelationshipEntries(bundle: ParsedDocumentBundle, entries: Map<string, RelationshipPartEntry[]>): void {
  for (const [sourcePart, sourceEntries] of entries) {
    const relsPath = sourcePartPathToRelsPath(sourcePart);
    const document = createRelationshipsDocument();
    const root = document.documentElement;
    for (const entry of sourceEntries) {
      const relationship = document.createElementNS(root.namespaceURI, "Relationship");
      relationship.setAttribute("Id", entry.id);
      relationship.setAttribute("Type", entry.type);
      relationship.setAttribute("Target", denormalizeRelationshipTarget(sourcePart, entry.target));
      if (entry.targetMode) {
        relationship.setAttribute("TargetMode", entry.targetMode);
      }
      root.appendChild(relationship);
    }
    bundle.package_snapshot.parts[relsPath] = {
      path: relsPath,
      kind: "xml",
      text: serializeXmlDocument(document)
    };
  }
}

function ensureContentTypes(bundle: ParsedDocumentBundle): void {
  const existing = bundle.package_snapshot.parts["[Content_Types].xml"];
  const document = existing?.kind === "xml" && existing.text ? parseXmlDocument(existing.text) : createContentTypesDocument();
  const root = document.documentElement;
  const overrides = childElements(root).filter((element) => localNameOf(element) === "Override");
  const defaults = childElements(root).filter((element) => localNameOf(element) === "Default");
  const existingOverrideNames = new Set(overrides.map((element) => element.getAttribute("PartName")));
  const existingDefaultExtensions = new Set(defaults.map((element) => element.getAttribute("Extension")?.toLowerCase()));

  for (const partPath of Object.keys(bundle.package_snapshot.parts)) {
    if (/\.rels$/i.test(partPath)) {
      continue;
    }
    if (bundle.package_snapshot.parts[partPath]?.kind === "binary") {
      const ext = partPath.split(".").pop()?.toLowerCase();
      if (ext && !existingDefaultExtensions.has(ext)) {
        const node = document.createElementNS(root.namespaceURI, "Default");
        node.setAttribute("Extension", ext);
        node.setAttribute("ContentType", inferBinaryContentType(ext));
        root.appendChild(node);
        existingDefaultExtensions.add(ext);
      }
      continue;
    }
    const contentType = inferXmlContentType(partPath);
    if (!contentType) {
      continue;
    }
    const partName = `/${partPath}`;
    if (existingOverrideNames.has(partName)) {
      continue;
    }
    const node = document.createElementNS(root.namespaceURI, "Override");
    node.setAttribute("PartName", partName);
    node.setAttribute("ContentType", contentType);
    root.appendChild(node);
    existingOverrideNames.add(partName);
  }

  bundle.package_snapshot.parts["[Content_Types].xml"] = {
    path: "[Content_Types].xml",
    kind: "xml",
    text: serializeXmlDocument(document)
  };
}

function refreshRelationshipGraph(bundle: ParsedDocumentBundle, entries: Map<string, RelationshipPartEntry[]>): void {
  const all = Array.from(entries.values()).flat();
  const edges: RelationshipEdge[] = all.map((entry) => ({
    sourcePart: entry.sourcePart,
    id: entry.id,
    type: entry.type,
    target: entry.target,
    targetMode: entry.targetMode
  }));
  bundle.relationship_graph = {
    edges,
    bySource: Object.fromEntries(
      Array.from(entries.entries()).map(([sourcePart, sourceEntries]) => [
        sourcePart,
        sourceEntries.map((entry) => ({
          sourcePart: entry.sourcePart,
          id: entry.id,
          type: entry.type,
          target: entry.target,
          targetMode: entry.targetMode
        }))
      ])
    )
  };
}

function refreshPackageMetadata(bundle: ParsedDocumentBundle, entries: Map<string, RelationshipPartEntry[]>): void {
  const partPaths = Object.keys(bundle.package_snapshot.parts).sort();
  const xmlPartPaths = partPaths.filter((partPath) => bundle.package_snapshot.parts[partPath]?.kind === "xml");
  const mediaPartPaths = partPaths.filter((partPath) => /^word\/media\//i.test(partPath));
  bundle.document_package.packageMeta.partCount = partPaths.length;
  bundle.document_package.packageMeta.partPaths = partPaths;
  bundle.document_package.packageMeta.xmlPartCount = xmlPartPaths.length;
  bundle.document_package.packageMeta.mediaCount = mediaPartPaths.length;
  bundle.document_package.packageMeta.headerCount = partPaths.filter((partPath) => /^word\/header\d+\.xml$/i.test(partPath)).length;
  bundle.document_package.packageMeta.footerCount = partPaths.filter((partPath) => /^word\/footer\d+\.xml$/i.test(partPath)).length;
  bundle.document_package.packageMeta.relationshipCount = Array.from(entries.values()).flat().length;

  const relationshipCountBySource = new Map<string, number>();
  for (const [source, sourceEntries] of entries) {
    relationshipCountBySource.set(source, sourceEntries.length);
  }
  const existingPartMap = new Map(bundle.document_package.parts.map((part) => [part.path, part] as const));
  for (const partPath of partPaths) {
    const existing = existingPartMap.get(partPath);
    const part = bundle.package_snapshot.parts[partPath];
    if (existing) {
      existing.relationshipCount = relationshipCountBySource.get(partPath) ?? 0;
      continue;
    }
    existingPartMap.set(partPath, {
      path: partPath,
      kind: inferPartKind(partPath),
      contentType: inferXmlContentType(partPath),
      xmlRoot: part?.kind === "xml" && part.text ? parseXmlDocument(part.text).documentElement?.nodeName : undefined,
      relationshipCount: relationshipCountBySource.get(partPath) ?? 0
    });
  }
  bundle.document_package.parts = Array.from(existingPartMap.values()).sort((left, right) => left.path.localeCompare(right.path));
}

function findExistingRelationshipId(entries: RelationshipPartEntry[], type: string): string | undefined {
  return entries.find((entry) => entry.type === type)?.id;
}

function findExistingTarget(entries: RelationshipPartEntry[], id: string): string | undefined {
  return entries.find((entry) => entry.id === id)?.target;
}

function inferSingleAvailablePart(
  bundle: ParsedDocumentBundle,
  kind: "header" | "footer" | "image",
  existing: RelationshipPartEntry[]
): string | undefined {
  const usedTargets = new Set(existing.map((entry) => entry.target));
  const candidates = Object.keys(bundle.package_snapshot.parts)
    .filter((partPath) => {
      if (kind === "header") {
        return /^word\/header\d+\.xml$/i.test(partPath);
      }
      if (kind === "footer") {
        return /^word\/footer\d+\.xml$/i.test(partPath);
      }
      return /^word\/media\//i.test(partPath);
    })
    .filter((partPath) => !usedTargets.has(partPath));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function normalizeRelationshipTarget(sourcePart: string, target: string): string {
  if (!target || /^[a-z]+:\/\//i.test(target)) {
    return target;
  }
  const baseDir = sourcePart.includes("/") ? sourcePart.slice(0, sourcePart.lastIndexOf("/")) : "";
  const segments = `${baseDir}/${target}`.split("/").filter(Boolean);
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.join("/");
}

function denormalizeRelationshipTarget(sourcePart: string, target: string): string {
  if (!target || /^[a-z]+:\/\//i.test(target)) {
    return target;
  }
  const sourceDir = sourcePart.includes("/") ? sourcePart.slice(0, sourcePart.lastIndexOf("/") + 1) : "";
  if (!sourceDir) {
    return target;
  }
  if (!target.startsWith(sourceDir)) {
    return target;
  }
  return target.slice(sourceDir.length);
}

function relsPathToSourcePartPath(relsPath: string): string {
  const normalized = relsPath.replace(/\\/g, "/");
  if (normalized === "_rels/.rels") {
    return "";
  }
  const match = normalized.match(/^(.*)\/_rels\/([^/]+)\.rels$/);
  if (!match) {
    return normalized;
  }
  return `${match[1]}/${match[2]}`;
}

function sourcePartPathToRelsPath(sourcePart: string): string {
  if (!sourcePart) {
    return "_rels/.rels";
  }
  const lastSlash = sourcePart.lastIndexOf("/");
  const dir = lastSlash >= 0 ? sourcePart.slice(0, lastSlash) : "";
  const fileName = lastSlash >= 0 ? sourcePart.slice(lastSlash + 1) : sourcePart;
  return dir ? `${dir}/_rels/${fileName}.rels` : `_rels/${fileName}.rels`;
}

function isManagedRelationshipType(type: string): boolean {
  return new Set([settingsType(), headerType(), footerType(), imageType(), hyperlinkType()]).has(type);
}

function settingsType(): string {
  return "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings";
}

function headerType(): string {
  return "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header";
}

function footerType(): string {
  return "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer";
}

function imageType(): string {
  return "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
}

function hyperlinkType(): string {
  return "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
}

function sortEntries(entries: RelationshipPartEntry[]): RelationshipPartEntry[] {
  return [...entries].sort((left, right) => left.id.localeCompare(right.id));
}

function inferXmlContentType(partPath: string): string | undefined {
  if (partPath === "word/document.xml") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
  }
  if (partPath === "word/styles.xml") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml";
  }
  if (partPath === "word/numbering.xml") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml";
  }
  if (partPath === "word/settings.xml") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml";
  }
  if (/^word\/header\d+\.xml$/i.test(partPath)) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml";
  }
  if (/^word\/footer\d+\.xml$/i.test(partPath)) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml";
  }
  if (partPath === "word/footnotes.xml") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml";
  }
  if (partPath === "word/endnotes.xml") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml";
  }
  if (partPath === "docProps/core.xml") {
    return "application/vnd.openxmlformats-package.core-properties+xml";
  }
  if (partPath === "docProps/app.xml") {
    return "application/vnd.openxmlformats-officedocument.extended-properties+xml";
  }
  return undefined;
}

function inferBinaryContentType(extension: string): string {
  if (extension === "png") {
    return "image/png";
  }
  return "application/octet-stream";
}

function inferPartKind(partPath: string): string {
  if (partPath === "word/document.xml") {
    return "main_document";
  }
  if (/^word\/header\d+\.xml$/i.test(partPath)) {
    return "header";
  }
  if (/^word\/footer\d+\.xml$/i.test(partPath)) {
    return "footer";
  }
  if (partPath === "word/styles.xml") {
    return "styles";
  }
  if (partPath === "word/numbering.xml") {
    return "numbering";
  }
  if (partPath === "word/settings.xml") {
    return "settings";
  }
  if (partPath === "word/footnotes.xml") {
    return "footnotes";
  }
  if (partPath === "word/endnotes.xml") {
    return "endnotes";
  }
  if (/^word\/media\//i.test(partPath)) {
    return "media";
  }
  if (/\.rels$/i.test(partPath)) {
    return "relationships";
  }
  return "xml";
}
