import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { AgentError } from "../core/errors.js";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const MATH_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";

const DEFAULT_NAMESPACES: Record<string, string> = {
  w: WORD_NS,
  r: REL_NS,
  a: DRAWING_NS,
  wp: WP_NS,
  m: MATH_NS
};

export function parseXmlDocument(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml");
}

export function serializeXmlDocument(document: Document): string {
  return new XMLSerializer().serializeToString(document);
}

export function localNameOf(node: Element | Attr): string {
  if (node.localName) {
    return node.localName;
  }
  const raw = node.nodeName ?? "";
  const index = raw.indexOf(":");
  return index >= 0 ? raw.slice(index + 1) : raw;
}

export function ensureXmlPart(partPath: string): string {
  if (/word\/settings\.xml$/i.test(partPath)) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="${WORD_NS}" xmlns:r="${REL_NS}"/>`;
  }
  if (/word\/styles\.xml$/i.test(partPath)) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${WORD_NS}" xmlns:r="${REL_NS}"/>`;
  }
  if (/word\/numbering\.xml$/i.test(partPath)) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${WORD_NS}" xmlns:r="${REL_NS}"/>`;
  }
  if (/word\/header\d+\.xml$/i.test(partPath)) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="${WORD_NS}" xmlns:r="${REL_NS}"/>`;
  }
  if (/word\/footer\d+\.xml$/i.test(partPath)) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="${WORD_NS}" xmlns:r="${REL_NS}"/>`;
  }
  throw new AgentError({
    code: "E_UNSUPPORTED_PATCH_TARGET",
    message: `Part '${partPath}' is not a creatable XML target in Phase 4.`,
    retryable: false
  });
}

export function findElementByXmlPath(document: Document, xmlPath: string): Element | null {
  const segments = xmlPath.split("/").filter(Boolean);
  let current: Element | null = document.documentElement;
  if (!current) {
    return null;
  }
  const rootSegment = segments.shift();
  if (rootSegment && stripIndex(rootSegment) !== localNameOf(current)) {
    return null;
  }
  for (const segment of segments) {
    const name = stripIndex(segment);
    const matcher = readSegmentMatcher(segment);
    const children = childElements(current).filter((child) => localNameOf(child) === name);
    current = matchChildBySegment(children, name, matcher);
    if (!current) {
      return null;
    }
  }
  return current;
}

export function childElements(node: Element): Element[] {
  return Array.from(node.childNodes).filter((child): child is Element => child.nodeType === child.ELEMENT_NODE);
}

export function ensureChildElement(parent: Element, qualifiedName: string, options?: { prepend?: boolean }): Element {
  const prefix = readQualifiedPrefix(qualifiedName);
  const namespace = resolveNamespace(parent, prefix);
  const element = parent.ownerDocument.createElementNS(namespace, qualifyName(prefix, localNameFromQualified(qualifiedName)));
  if (options?.prepend && parent.firstChild) {
    parent.insertBefore(element, parent.firstChild);
  } else {
    parent.appendChild(element);
  }
  return element;
}

export function findDirectChild(parent: Element, localName: string): Element | null {
  return childElements(parent).find((child) => localNameOf(child) === localName) ?? null;
}

export function findAncestor(node: Element | null, targetLocalName: string): Element | null {
  let current: Node | null = node;
  while (current) {
    if (current.nodeType === current.ELEMENT_NODE && localNameOf(current as Element) === targetLocalName) {
      return current as Element;
    }
    current = current.parentNode;
  }
  return null;
}

export function setQualifiedAttribute(element: Element, qualifiedName: string, value: string): void {
  const prefix = readQualifiedPrefix(qualifiedName);
  const namespace = resolveNamespace(element, prefix);
  element.setAttributeNS(namespace, qualifyName(prefix, localNameFromQualified(qualifiedName)), value);
}

export function removeQualifiedAttribute(element: Element, qualifiedName: string): void {
  const prefix = readQualifiedPrefix(qualifiedName);
  const namespace = resolveNamespace(element, prefix);
  element.removeAttributeNS(namespace, localNameFromQualified(qualifiedName));
}

export function readQualifiedAttribute(element: Element, qualifiedName: string): string | null {
  const prefix = readQualifiedPrefix(qualifiedName);
  const namespace = resolveNamespace(element, prefix);
  return element.getAttributeNS(namespace, localNameFromQualified(qualifiedName));
}

export function replaceElementWithXml(target: Element, nodeXml: string): Element {
  const wrapper = parseXmlDocument(buildWrapperXml(target.ownerDocument.documentElement, nodeXml));
  const replacement = childElements(wrapper.documentElement)[0];
  if (!replacement || !target.parentNode) {
    throw new AgentError({
      code: "E_PATCH_TARGET_NOT_FOUND",
      message: "Replacement XML did not contain a valid element node.",
      retryable: false
    });
  }
  target.parentNode.replaceChild(replacement, target);
  return replacement;
}

export function createRelationshipsDocument(): Document {
  return parseXmlDocument(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG_REL_NS}"/>`
  );
}

export function createContentTypesDocument(): Document {
  return parseXmlDocument(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${CONTENT_TYPES_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`
  );
}

function buildWrapperXml(root: Element, innerXml: string): string {
  const namespaceAttrs = Array.from(root.attributes)
    .filter((attribute) => attribute.name === "xmlns" || attribute.name.startsWith("xmlns:"))
    .map((attribute) => `${attribute.name}="${attribute.value}"`)
    .join(" ");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><phase4-wrapper ${namespaceAttrs}>${innerXml}</phase4-wrapper>`;
}

function matchChildBySegment(children: Element[], name: string, matcher: string | number | undefined): Element | null {
  if (matcher !== undefined) {
    const token = String(matcher);
    const identified = children.find((child) => readIdentifierAttribute(child, name) === token);
    if (identified) {
      return identified;
    }
  }
  if (typeof matcher === "number" || (typeof matcher === "string" && /^\d+$/.test(matcher))) {
    const index = typeof matcher === "number" ? matcher : Number.parseInt(matcher, 10);
    return children[index] ?? null;
  }
  return children[0] ?? null;
}

function readIdentifierAttribute(element: Element, localName: string): string | null {
  const candidates = (() => {
    switch (localName) {
      case "style":
        return ["w:styleId", "styleId"];
      case "abstractNum":
        return ["w:abstractNumId", "abstractNumId"];
      case "num":
        return ["w:numId", "numId"];
      case "lvl":
        return ["w:ilvl", "ilvl"];
      case "footnote":
      case "endnote":
        return ["w:id", "id"];
      default:
        return ["w:id", "id", "Id"];
    }
  })();
  for (const candidate of candidates) {
    const value = readQualifiedAttribute(element, candidate);
    if (value) {
      return value;
    }
    const direct = element.getAttribute(candidate);
    if (direct) {
      return direct;
    }
  }
  return null;
}

function readSegmentMatcher(segment: string): string | number | undefined {
  const match = segment.match(/\[(.+)\]$/);
  if (!match) {
    return undefined;
  }
  return match[1];
}

function stripIndex(segment: string): string {
  return segment.replace(/\[.+\]$/, "");
}

function readQualifiedPrefix(name: string): string | undefined {
  const index = name.indexOf(":");
  return index >= 0 ? name.slice(0, index) : undefined;
}

function localNameFromQualified(name: string): string {
  const index = name.indexOf(":");
  return index >= 0 ? name.slice(index + 1) : name;
}

function qualifyName(prefix: string | undefined, localName: string): string {
  return prefix ? `${prefix}:${localName}` : localName;
}

function resolveNamespace(element: Element, prefix: string | undefined): string | null {
  if (prefix) {
    return element.lookupNamespaceURI(prefix) ?? DEFAULT_NAMESPACES[prefix] ?? null;
  }
  return element.lookupNamespaceURI(null) ?? null;
}
