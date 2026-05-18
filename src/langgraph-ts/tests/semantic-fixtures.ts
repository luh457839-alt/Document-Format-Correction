import type {
  DocumentAstParagraphRecord,
  DocumentInlineRecord,
  ParsedDocumentBundle,
  ParagraphNode,
  TextRunNode,
  TextRunStyle
} from "../contracts/document-contracts.js";

interface SemanticParagraphSpec {
  id: string;
  text: string;
  role?: string;
  headingLevel?: number;
  listLevel?: number;
  styleName?: string;
  inTable?: boolean;
  partPath?: string;
  runStyle?: TextRunStyle;
  imageCount?: number;
  imageDominant?: boolean;
}

export function createSemanticProjectionBundle(): ParsedDocumentBundle {
  return createSyntheticBundle([
    {
      id: "p_cover",
      text: "关于开展专项整治工作的通知",
      styleName: "BodyText",
      runStyle: {
        fontName: "FangSong",
        fontSizePt: 18,
        isBold: true,
        paragraphAlignment: "center"
      }
    },
    {
      id: "p_intro",
      text: "各有关单位：",
      styleName: "BodyText",
      runStyle: {
        fontName: "SimSun",
        fontSizePt: 12
      }
    },
    {
      id: "p_title_same_style",
      text: "一、总体要求",
      styleName: "BodyText",
      runStyle: {
        fontName: "SimSun",
        fontSizePt: 12
      }
    },
    {
      id: "p_body_1",
      text: "为进一步规范专项整治工作，现提出如下要求。",
      styleName: "BodyText",
      runStyle: {
        fontName: "SimSun",
        fontSizePt: 12,
        isBold: false,
        isItalic: false
      }
    },
    {
      id: "p_body_2",
      text: "请各部门结合实际情况认真贯彻落实。",
      styleName: "BodyText",
      runStyle: {
        fontName: "SimSun",
        fontSizePt: 12,
        isBold: false,
        isItalic: false
      }
    },
    {
      id: "p_list",
      text: "1. 加强组织领导。",
      role: "list_item",
      listLevel: 0,
      styleName: "BodyText",
      runStyle: {
        fontName: "SimSun",
        fontSizePt: 12
      }
    },
    {
      id: "p_table",
      text: "表格中的普通文字",
      styleName: "BodyText",
      inTable: true,
      runStyle: {
        fontName: "SimSun",
        fontSizePt: 12
      }
    },
    {
      id: "p_image",
      text: "",
      styleName: "BodyText",
      imageCount: 1,
      imageDominant: true
    },
    {
      id: "p_emphasis",
      text: "特别提醒：本页示例仅供内部讨论",
      styleName: "BodyText",
      runStyle: {
        fontName: "SimSun",
        fontSizePt: 12,
        isBold: true
      }
    }
  ]);
}

export function createLowConfidenceSemanticBundle(): ParsedDocumentBundle {
  return createSyntheticBundle([
    {
      id: "p_1",
      text: "今天完成材料汇总。",
      styleName: "BodyText",
      runStyle: { fontName: "SimSun", fontSizePt: 12 }
    },
    {
      id: "p_2",
      text: "明天继续推进相关事项。",
      styleName: "BodyText",
      runStyle: { fontName: "SimSun", fontSizePt: 12 }
    },
    {
      id: "p_3",
      text: "后续由办公室统一归档。",
      styleName: "BodyText",
      runStyle: { fontName: "SimSun", fontSizePt: 12 }
    }
  ]);
}

export function createAmbiguousSemanticBundle(): ParsedDocumentBundle {
  return createSyntheticBundle([
    {
      id: "p_title_1",
      text: "专项整治工作",
      styleName: "BodyText",
      runStyle: {
        fontName: "FangSong",
        fontSizePt: 16,
        isBold: true,
        paragraphAlignment: "center"
      }
    },
    {
      id: "p_title_2",
      text: "工作方案",
      styleName: "BodyText",
      runStyle: {
        fontName: "FangSong",
        fontSizePt: 16,
        isBold: true,
        paragraphAlignment: "center"
      }
    },
    {
      id: "p_body",
      text: "本方案用于指导后续专项整治工作。",
      styleName: "BodyText",
      runStyle: { fontName: "SimSun", fontSizePt: 12 }
    }
  ]);
}

export function createUnderdeterminedBaselineBundle(): ParsedDocumentBundle {
  return createSyntheticBundle([
    {
      id: "p_title",
      text: "一、需要同步的标题",
      styleName: "BodyText",
      runStyle: { fontName: "SimSun", fontSizePt: 12 }
    },
    {
      id: "p_body_a",
      text: "这是正文样式甲，用于推导正文字体基线。",
      styleName: "BodyText",
      runStyle: { fontName: "SimSun", fontSizePt: 12, isBold: false, isItalic: false }
    },
    {
      id: "p_body_b",
      text: "这是正文样式乙，但字体族不同导致基线不稳定。",
      styleName: "BodyText",
      runStyle: { fontName: "KaiTi", fontSizePt: 12, isBold: false, isItalic: false }
    }
  ]);
}

export function createProjectionBudgetStressBundle(): ParsedDocumentBundle {
  return createSyntheticBundle([
    {
      id: "p_focus_intro",
      text: "专项整治实施方案预算测试：请优先保留这一段，因为它包含预算测试焦点关键词。",
      styleName: "BodyText",
      runStyle: { fontName: "SimSun", fontSizePt: 12, isBold: true }
    },
    {
      id: "p_focus_title",
      text: "一、预算测试焦点标题",
      styleName: "BodyText",
      runStyle: { fontName: "SimSun", fontSizePt: 12 }
    },
    {
      id: "p_body_long_1",
      text: "这是一个较长的正文段落，用于制造投影预算压力，并验证背景文本会先被压缩，然后才会继续缩减邻域与其他附加信息。".repeat(2),
      styleName: "BodyText",
      runStyle: { fontName: "SimSun", fontSizePt: 12 }
    },
    {
      id: "p_body_long_2",
      text: "第二个较长正文段落继续提供背景噪声，使模板投影需要进行 local context 降级以及批次拆分，不能静默丢失段落顺序和段落 id。".repeat(2),
      styleName: "BodyText",
      runStyle: { fontName: "SimSun", fontSizePt: 12 }
    },
    {
      id: "p_list_long",
      text: "1. 这是一个编号段落，同时带来额外文本预算压力，并帮助模板分类器识别 numberingPattern 与局部上下文。",
      role: "list_item",
      listLevel: 0,
      styleName: "BodyText",
      runStyle: { fontName: "SimSun", fontSizePt: 12 }
    },
    {
      id: "p_body_long_3",
      text: "第三个正文段落继续扩展背景信息，用于验证 batch 拆分后仍然可以保留 classification 必需字段与稳定顺序。".repeat(2),
      styleName: "BodyText",
      runStyle: { fontName: "SimSun", fontSizePt: 12 }
    },
    {
      id: "p_image_budget",
      text: "",
      styleName: "BodyText",
      imageCount: 1,
      imageDominant: true
    },
    {
      id: "p_body_tail",
      text: "尾部正文段落用于验证背景段合并与后续批次拆分仍然保留 paragraphId 与 paragraphIndex。",
      styleName: "BodyText",
      runStyle: { fontName: "SimSun", fontSizePt: 12 }
    }
  ]);
}

function createSyntheticBundle(paragraphs: SemanticParagraphSpec[]): ParsedDocumentBundle {
  const blockNodes: ParagraphNode[] = [];
  const inlineNodes: DocumentInlineRecord[] = [];
  const structureParagraphs: DocumentAstParagraphRecord[] = [];

  for (const paragraph of paragraphs) {
    const runStyle = paragraph.runStyle;
    const runIds = paragraph.text
      ? [paragraph.id.replace(/^p_/, "r_")]
      : [];
    const children: ParagraphNode["children"] = [];

    if (paragraph.text) {
      const runId = runIds[0];
      const runNode: TextRunNode = {
        id: runId,
        nodeType: "text_run",
        content: paragraph.text,
        ...(runStyle ? { style: { ...runStyle } } : {})
      };
      children.push(runNode);
      inlineNodes.push({
        id: runId,
        blockId: paragraph.id,
        partPath: paragraph.partPath ?? "word/document.xml",
        nodeType: "text",
        text: paragraph.text,
        ...(runStyle ? { style: { ...runStyle } } : {})
      });
    }

    const imageCount = paragraph.imageCount ?? 0;
    for (let index = 0; index < imageCount; index += 1) {
      const imageId = `${paragraph.id}_img_${index}`;
      children.push({
        id: imageId,
        nodeType: "image",
        src: `media/${imageId}.png`,
        size: {
          width: 320,
          height: 180
        }
      });
      inlineNodes.push({
        id: imageId,
        blockId: paragraph.id,
        partPath: paragraph.partPath ?? "word/document.xml",
        nodeType: "image",
        src: `media/${imageId}.png`,
        size: {
          width: 320,
          height: 180
        }
      });
    }

    blockNodes.push({
      id: paragraph.id,
      nodeType: "paragraph",
      children
    });

    structureParagraphs.push({
      id: paragraph.id,
      text: paragraph.text,
      role: paragraph.role ?? "body",
      headingLevel: paragraph.headingLevel,
      listLevel: paragraph.listLevel,
      styleName: paragraph.styleName ?? "BodyText",
      runIds,
      inTable: paragraph.inTable ?? false,
      partPath: paragraph.partPath ?? "word/document.xml"
    });
  }

  return {
    source: {
      docxPath: "synthetic-semantic.docx"
    },
    document_ast: {
      documentMeta: {
        totalParagraphs: blockNodes.length,
        totalTables: 0,
        totalImages: inlineNodes.filter((node) => node.nodeType === "image").length,
        totalFormulas: 0,
        totalFootnotes: 0,
        totalEndnotes: 0,
        totalHeaders: 0,
        totalFooters: 0,
        warnings: []
      },
      nodes: blockNodes,
      blocks: structureParagraphs.map((paragraph) => ({
        id: `block:${paragraph.id}`,
        blockId: paragraph.id,
        partPath: paragraph.partPath ?? "word/document.xml",
        nodeType: "paragraph",
        paragraphId: paragraph.id,
        role: paragraph.role
      })),
      inlineNodes,
      styles: {
        defaults: {
          fontName: "SimSun",
          fontSizePt: 12,
          paragraphAlignment: "left"
        },
        paragraphStyles: {
          BodyText: {
            styleId: "BodyText",
            styleName: "Body Text",
            resolvedRun: {
              fontName: "SimSun",
              fontSizePt: 12,
              paragraphAlignment: "left"
            }
          }
        },
        characterStyles: {},
        tableStyles: {}
      },
      numbering: {
        instances: [
          {
            numId: "1",
            abstractNumId: "1",
            levels: [
              {
                ilvl: 0,
                numFmt: "decimal",
                lvlText: "%1."
              }
            ]
          }
        ]
      },
      patchTargets: structureParagraphs.flatMap((paragraph) => [
        {
          id: `target:block:${paragraph.id}`,
          target_kind: "block" as const,
          part_path: paragraph.partPath ?? "word/document.xml",
          block_id: paragraph.id,
          locator: {
            part_path: paragraph.partPath ?? "word/document.xml",
            xml_path: `/document/body/p[${paragraph.id}]`
          }
        },
        ...paragraph.runIds.map((runId) => ({
          id: `target:inline:${runId}`,
          target_kind: "inline" as const,
          part_path: paragraph.partPath ?? "word/document.xml",
          block_id: paragraph.id,
          node_id: runId,
          locator: {
            part_path: paragraph.partPath ?? "word/document.xml",
            xml_path: `/document/body/p[${paragraph.id}]/r[${runId}]`
          },
          text: paragraph.text,
          ...(inlineNodes.find((node) => node.id === runId)?.style
            ? {
                style_snapshot: inlineNodes.find((node) => node.id === runId)?.style
              }
            : {})
        }))
      ])
    },
    document_package: {
      packageMeta: {
        partCount: 4,
        xmlPartCount: 4,
        mediaCount: inlineNodes.filter((node) => node.nodeType === "image").length,
        relationshipCount: 0,
        sectionCount: 1,
        headerCount: 0,
        footerCount: 0,
        footnoteCount: 0,
        endnoteCount: 0,
        customXmlCount: 0,
        warnings: [],
        partPaths: ["word/document.xml", "word/styles.xml", "word/numbering.xml", "word/settings.xml"],
        headerFooterBindings: []
      },
      parts: [
        { path: "word/document.xml", kind: "document", xmlRoot: "w:document", relationshipCount: 0 },
        { path: "word/styles.xml", kind: "styles", xmlRoot: "w:styles", relationshipCount: 0 },
        { path: "word/numbering.xml", kind: "numbering", xmlRoot: "w:numbering", relationshipCount: 0 },
        { path: "word/settings.xml", kind: "settings", xmlRoot: "w:settings", relationshipCount: 0 }
      ]
    },
    package_snapshot: {
      parts: {
        "word/document.xml": {
          path: "word/document.xml",
          kind: "xml",
          text: buildSyntheticDocumentXml(structureParagraphs, inlineNodes)
        },
        "word/styles.xml": {
          path: "word/styles.xml",
          kind: "xml",
          text: "<w:styles/>"
        },
        "word/numbering.xml": {
          path: "word/numbering.xml",
          kind: "xml",
          text: "<w:numbering/>"
        },
        "word/settings.xml": {
          path: "word/settings.xml",
          kind: "xml",
          text: "<w:settings/>"
        }
      }
    },
    structure_index: {
      paragraphs: structureParagraphs,
      paragraphMap: Object.fromEntries(structureParagraphs.map((paragraph) => [paragraph.id, paragraph])),
      roleCounts: structureParagraphs.reduce<Record<string, number>>((counts, paragraph) => {
        counts[paragraph.role] = (counts[paragraph.role] ?? 0) + 1;
        return counts;
      }, {})
    },
    relationship_graph: {
      edges: [],
      bySource: {}
    }
  };
}

function buildSyntheticDocumentXml(
  paragraphs: DocumentAstParagraphRecord[],
  inlineNodes: DocumentInlineRecord[]
): string {
  const body = paragraphs
    .map((paragraph) => {
      const runs = paragraph.runIds
        .map((runId) => inlineNodes.find((node) => node.id === runId && node.nodeType === "text"))
        .filter((node): node is Extract<DocumentInlineRecord, { nodeType: "text" }> => Boolean(node))
        .map((node) => `<w:r w:id="${node.id}"><w:t>${escapeXml(node.text ?? "")}</w:t></w:r>`)
        .join("");
      return `<w:p w:id="${paragraph.id}">${runs}</w:p>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}
