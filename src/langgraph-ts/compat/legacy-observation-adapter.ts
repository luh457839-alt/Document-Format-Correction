import type { ParsedDocumentBundle } from "../contracts/document-contracts.js";
import type { DocxObservationState, DocxPatchTarget } from "../document-core/legacy-observation-schema.js";

export function bundleToLegacyObservation(bundle: ParsedDocumentBundle): DocxObservationState {
  return {
    package_model: {
      package_meta: {
        part_count: bundle.document_package.packageMeta.partCount,
        xml_part_count: bundle.document_package.packageMeta.xmlPartCount,
        media_count: bundle.document_package.packageMeta.mediaCount,
        relationship_count: bundle.document_package.packageMeta.relationshipCount,
        section_count: bundle.document_package.packageMeta.sectionCount,
        header_count: bundle.document_package.packageMeta.headerCount,
        footer_count: bundle.document_package.packageMeta.footerCount,
        footnote_count: bundle.document_package.packageMeta.footnoteCount,
        endnote_count: bundle.document_package.packageMeta.endnoteCount,
        custom_xml_count: bundle.document_package.packageMeta.customXmlCount,
        created_by: bundle.document_package.packageMeta.createdBy,
        modified_by: bundle.document_package.packageMeta.modifiedBy,
        created_at: bundle.document_package.packageMeta.createdAt,
        modified_at: bundle.document_package.packageMeta.modifiedAt,
        revision: bundle.document_package.packageMeta.revision,
        warnings: [...bundle.document_package.packageMeta.warnings],
        part_paths: [...bundle.document_package.packageMeta.partPaths],
        header_footer_bindings: bundle.document_package.packageMeta.headerFooterBindings.map((binding) => ({
          section_id: binding.sectionId,
          headers: [...binding.headers],
          footers: [...binding.footers]
        }))
      },
      parts: bundle.document_package.parts.map((part) => ({
        path: part.path,
        kind: part.kind,
        content_type: part.contentType,
        xml_root: part.xmlRoot,
        relationship_count: part.relationshipCount
      })),
      relationship_graph: {
        edges: bundle.relationship_graph.edges.map((edge) => ({
          source_part: edge.sourcePart,
          id: edge.id,
          type: edge.type,
          target: edge.target,
          target_mode: edge.targetMode
        })),
        by_source: Object.fromEntries(
          Object.entries(bundle.relationship_graph.bySource).map(([source, edges]) => [
            source,
            edges.map((edge) => ({
              source_part: edge.sourcePart,
              id: edge.id,
              type: edge.type,
              target: edge.target,
              target_mode: edge.targetMode
            }))
          ])
        )
      }
    },
    package_meta: {
      part_count: bundle.document_package.packageMeta.partCount,
      xml_part_count: bundle.document_package.packageMeta.xmlPartCount,
      media_count: bundle.document_package.packageMeta.mediaCount,
      relationship_count: bundle.document_package.packageMeta.relationshipCount,
      section_count: bundle.document_package.packageMeta.sectionCount,
      header_count: bundle.document_package.packageMeta.headerCount,
      footer_count: bundle.document_package.packageMeta.footerCount,
      footnote_count: bundle.document_package.packageMeta.footnoteCount,
      endnote_count: bundle.document_package.packageMeta.endnoteCount,
      custom_xml_count: bundle.document_package.packageMeta.customXmlCount,
      created_by: bundle.document_package.packageMeta.createdBy,
      modified_by: bundle.document_package.packageMeta.modifiedBy,
      created_at: bundle.document_package.packageMeta.createdAt,
      modified_at: bundle.document_package.packageMeta.modifiedAt,
      revision: bundle.document_package.packageMeta.revision,
      warnings: [...bundle.document_package.packageMeta.warnings],
      part_paths: [...bundle.document_package.packageMeta.partPaths],
      header_footer_bindings: bundle.document_package.packageMeta.headerFooterBindings.map((binding) => ({
        section_id: binding.sectionId,
        headers: [...binding.headers],
        footers: [...binding.footers]
      }))
    },
    document_meta: {
      total_paragraphs: bundle.document_ast.documentMeta.totalParagraphs,
      total_tables: bundle.document_ast.documentMeta.totalTables,
      total_images: bundle.document_ast.documentMeta.totalImages,
      total_formulas: bundle.document_ast.documentMeta.totalFormulas,
      total_footnotes: bundle.document_ast.documentMeta.totalFootnotes,
      total_endnotes: bundle.document_ast.documentMeta.totalEndnotes,
      total_headers: bundle.document_ast.documentMeta.totalHeaders,
      total_footers: bundle.document_ast.documentMeta.totalFooters,
      warning: bundle.document_ast.documentMeta.warning,
      warnings: bundle.document_ast.documentMeta.warnings
    },
    blocks: bundle.document_ast.blocks.map((block) => ({
      id: block.id,
      block_id: block.blockId,
      part_path: block.partPath,
      node_type: block.nodeType,
      paragraph_id: block.paragraphId,
      table_id: block.tableId,
      role: block.role,
      anchor: block.anchor
        ? {
            part_path: block.anchor.partPath,
            xml_path: block.anchor.xmlPath
          }
        : undefined
    })),
    inline_nodes: bundle.document_ast.inlineNodes.map((node) => ({
      id: node.id,
      block_id: node.blockId,
      part_path: node.partPath,
      node_type: node.nodeType,
      text: node.text,
      src: node.src,
      size: node.size,
      format: node.format,
      content: node.content,
      style: node.style
        ? {
            font_name: node.style.fontName,
            font_size_pt: node.style.fontSizePt,
            line_spacing: node.style.lineSpacing,
            font_color: node.style.fontColor,
            is_bold: node.style.isBold,
            is_italic: node.style.isItalic,
            is_underline: node.style.isUnderline,
            is_strike: node.style.isStrike,
            highlight_color: node.style.highlightColor,
            is_all_caps: node.style.isAllCaps,
            paragraph_alignment: node.style.paragraphAlignment
          }
        : undefined,
      anchor: node.anchor
        ? {
            part_path: node.anchor.partPath,
            xml_path: node.anchor.xmlPath
          }
        : undefined
    })),
    styles: {
      defaults: {
        font_name: bundle.document_ast.styles.defaults.fontName,
        font_size_pt: bundle.document_ast.styles.defaults.fontSizePt,
        line_spacing: bundle.document_ast.styles.defaults.lineSpacing,
        font_color: bundle.document_ast.styles.defaults.fontColor,
        is_bold: bundle.document_ast.styles.defaults.isBold,
        is_italic: bundle.document_ast.styles.defaults.isItalic,
        is_underline: bundle.document_ast.styles.defaults.isUnderline,
        is_strike: bundle.document_ast.styles.defaults.isStrike,
        highlight_color: bundle.document_ast.styles.defaults.highlightColor,
        is_all_caps: bundle.document_ast.styles.defaults.isAllCaps,
        paragraph_alignment: bundle.document_ast.styles.defaults.paragraphAlignment
      },
      paragraph_styles: mapStyleDictionary(bundle.document_ast.styles.paragraphStyles),
      character_styles: mapStyleDictionary(bundle.document_ast.styles.characterStyles),
      table_styles: mapStyleDictionary(bundle.document_ast.styles.tableStyles)
    },
    numbering: {
      instances: bundle.document_ast.numbering.instances.map((instance) => ({
        num_id: instance.numId,
        abstract_num_id: instance.abstractNumId,
        levels: instance.levels.map((level) => ({
          ilvl: level.ilvl,
          start: level.start,
          num_fmt: level.numFmt,
          lvl_text: level.lvlText
        }))
      }))
    },
    structure_index: {
      paragraphs: bundle.structure_index.paragraphs.map((paragraph) => ({
        id: paragraph.id,
        text: paragraph.text,
        role: paragraph.role,
        heading_level: paragraph.headingLevel,
        list_level: paragraph.listLevel,
        style_name: paragraph.styleName,
        run_ids: [...paragraph.runIds],
        in_table: paragraph.inTable,
        part_path: paragraph.partPath
      })),
      role_counts: { ...bundle.structure_index.roleCounts }
    },
    patch_targets: structuredClone(bundle.document_ast.patchTargets) as DocxPatchTarget[],
    paragraphs: bundle.structure_index.paragraphs.map((paragraph) => ({
      id: paragraph.id,
      text: paragraph.text,
      role: paragraph.role,
      heading_level: paragraph.headingLevel,
      list_level: paragraph.listLevel,
      style_name: paragraph.styleName,
      run_ids: [...paragraph.runIds],
      in_table: paragraph.inTable,
      part_path: paragraph.partPath
    })),
    nodes: bundle.document_ast.nodes.map((node) =>
      node.nodeType === "paragraph"
        ? {
            id: node.id,
            node_type: "paragraph",
            children: node.children.map((child) =>
              child.nodeType === "text_run"
                ? {
                    id: child.id,
                    node_type: "text_run",
                    content: child.content,
                    style: child.style
                      ? {
                          font_name: child.style.fontName,
                          font_size_pt: child.style.fontSizePt,
                          line_spacing: child.style.lineSpacing,
                          font_color: child.style.fontColor,
                          is_bold: child.style.isBold,
                          is_italic: child.style.isItalic,
                          is_underline: child.style.isUnderline,
                          is_strike: child.style.isStrike,
                          highlight_color: child.style.highlightColor,
                          is_all_caps: child.style.isAllCaps,
                          paragraph_alignment: child.style.paragraphAlignment
                        }
                      : undefined
                  }
                : child.nodeType === "image"
                ? {
                    id: child.id,
                    node_type: "image",
                    src: child.src,
                    size: child.size
                  }
                : {
                    id: child.id,
                    node_type: "formula",
                    format: child.format,
                    content: child.content
                  }
            )
          }
        : {
            id: node.id,
            node_type: "table",
            rows: node.rows.map((row) => ({
              row_index: row.rowIndex,
              cells: row.cells.map((cell) => ({
                cell_index: cell.cellIndex,
                paragraphs: cell.paragraphs.map((paragraph) => ({
                  id: paragraph.id,
                  node_type: "paragraph",
                  children: paragraph.children.map((child) =>
                    child.nodeType === "text_run"
                      ? {
                          id: child.id,
                          node_type: "text_run",
                          content: child.content,
                          style: child.style
                            ? {
                                font_name: child.style.fontName,
                                font_size_pt: child.style.fontSizePt,
                                line_spacing: child.style.lineSpacing,
                                font_color: child.style.fontColor,
                                is_bold: child.style.isBold,
                                is_italic: child.style.isItalic,
                                is_underline: child.style.isUnderline,
                                is_strike: child.style.isStrike,
                                highlight_color: child.style.highlightColor,
                                is_all_caps: child.style.isAllCaps,
                                paragraph_alignment: child.style.paragraphAlignment
                              }
                            : undefined
                        }
                      : child.nodeType === "image"
                      ? {
                          id: child.id,
                          node_type: "image",
                          src: child.src,
                          size: child.size
                        }
                      : {
                          id: child.id,
                          node_type: "formula",
                          format: child.format,
                          content: child.content
                        }
                  )
                })),
                tables: []
              }))
            }))
          }
    )
  };
}

function mapStyleDictionary(input: Record<string, ParsedDocumentBundle["document_ast"]["styles"]["paragraphStyles"][string]>) {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      {
        style_id: value.styleId,
        style_name: value.styleName,
        based_on: value.basedOn,
        resolved_run: {
          font_name: value.resolvedRun.fontName,
          font_size_pt: value.resolvedRun.fontSizePt,
          line_spacing: value.resolvedRun.lineSpacing,
          font_color: value.resolvedRun.fontColor,
          is_bold: value.resolvedRun.isBold,
          is_italic: value.resolvedRun.isItalic,
          is_underline: value.resolvedRun.isUnderline,
          is_strike: value.resolvedRun.isStrike,
          highlight_color: value.resolvedRun.highlightColor,
          is_all_caps: value.resolvedRun.isAllCaps,
          paragraph_alignment: value.resolvedRun.paragraphAlignment
        },
        paragraph_alignment: value.paragraphAlignment
      }
    ])
  );
}
