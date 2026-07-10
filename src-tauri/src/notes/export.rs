use super::types::{validate_note_id, ExportNode, NotesExportSnapshot};
use printpdf::{
    Color, FontId, Greyscale, Mm, Op, ParsedFont, PdfDocument, PdfFontHandle, PdfPage,
    PdfParseErrorSeverity, PdfSaveOptions, Point, Pt, TextItem,
};
use rusqlite::Connection;
use std::fmt::Write;

const PDF_FONT_BYTES: &[u8] = include_bytes!("../../resources/NanumGothic-Regular.ttf");
const PDF_PAGE_WIDTH_MM: f32 = 210.0;
const PDF_PAGE_HEIGHT_MM: f32 = 297.0;
const PDF_MARGIN_X_MM: f32 = 18.0;
const PDF_MARGIN_TOP_MM: f32 = 20.0;
const PDF_MARGIN_BOTTOM_MM: f32 = 18.0;
const PDF_FOOTER_RESERVE_MM: f32 = 10.0;
const PDF_TITLE_SIZE: f32 = 20.0;
const PDF_TITLE_LINE_HEIGHT: f32 = 26.0;
const PDF_TITLE_GAP: f32 = 14.0;
const PDF_ROW_SIZE: f32 = 10.8;
const PDF_ROW_LINE_HEIGHT: f32 = 15.0;
const PDF_NOTE_SIZE: f32 = 9.0;
const PDF_NOTE_LINE_HEIGHT: f32 = 12.5;
const PDF_ROW_GAP: f32 = 5.0;
const PDF_DEPTH_INDENT: f32 = 14.0;
const PDF_NOTE_INDENT: f32 = 12.0;
const PDF_MIN_TEXT_WIDTH: f32 = 72.0;
const PDF_FOOTER_SIZE: f32 = 8.5;

pub(crate) fn load_export_snapshot(
    connection: &Connection,
    root_node_id: &str,
) -> Result<NotesExportSnapshot, String> {
    super::repository::load_export_snapshot(connection, root_node_id)
}

fn normalize_newlines(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

fn escape_markdown(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            character if character.is_ascii_punctuation() => {
                escaped.push('\\');
                escaped.push(character);
            }
            character => escaped.push(character),
        }
    }
    escaped
}

fn escape_inline(value: &str) -> String {
    normalize_newlines(value)
        .split('\n')
        .map(escape_markdown)
        .collect::<Vec<_>>()
        .join(r"\n")
}

fn validate_export_node_ids(node: &ExportNode) -> Result<(), String> {
    validate_note_id(&node.id)?;
    for child in &node.children {
        validate_export_node_ids(child)?;
    }
    Ok(())
}

fn render_node(markdown: &mut String, node: &super::types::ExportNode, depth: usize) {
    let indentation = "  ".repeat(depth);
    let completion = if node.completed { 'x' } else { ' ' };
    writeln!(
        markdown,
        "{indentation}- [{completion}] {} <!-- yonalist-node-id: {} -->",
        escape_inline(&node.title),
        node.id
    )
    .expect("writing to a String cannot fail");

    if !node.note.is_empty() {
        let note_indentation = "  ".repeat(depth + 1);
        for line in normalize_newlines(&node.note).split('\n') {
            if line.is_empty() {
                writeln!(markdown, "{note_indentation}>").expect("writing to a String cannot fail");
            } else {
                writeln!(markdown, "{note_indentation}> {}", escape_markdown(line))
                    .expect("writing to a String cannot fail");
            }
        }
    }

    for child in &node.children {
        render_node(markdown, child, depth + 1);
    }
}

pub(crate) fn render_markdown(snapshot: &NotesExportSnapshot) -> Result<Vec<u8>, String> {
    validate_note_id(&snapshot.root_node_id)?;
    validate_export_node_ids(&snapshot.root)?;

    let mut markdown = String::new();
    writeln!(markdown, "---").expect("writing to a String cannot fail");
    writeln!(markdown, "kind: yonalist-notes-export").expect("writing to a String cannot fail");
    writeln!(markdown, "format_version: 1").expect("writing to a String cannot fail");
    writeln!(markdown, "source: notes.sqlite").expect("writing to a String cannot fail");
    writeln!(markdown, "root_node_id: \"{}\"", snapshot.root_node_id)
        .expect("writing to a String cannot fail");
    writeln!(markdown, "exported_at: \"{}\"", snapshot.exported_at)
        .expect("writing to a String cannot fail");
    writeln!(markdown, "---\n").expect("writing to a String cannot fail");
    writeln!(markdown, "# {}\n", escape_inline(&snapshot.title))
        .expect("writing to a String cannot fail");
    render_node(&mut markdown, &snapshot.root, 0);
    Ok(markdown.into_bytes())
}

#[derive(Clone, Copy)]
enum PdfTextTone {
    Primary,
    Supporting,
}

struct PdfPreparedLine {
    text: String,
    x: f32,
    size: f32,
    line_height: f32,
    tone: PdfTextTone,
}

struct PdfPreparedRow {
    lines: Vec<PdfPreparedLine>,
    height: f32,
}

struct PdfPlacedLine {
    text: String,
    x: f32,
    y: f32,
    size: f32,
    line_height: f32,
    tone: PdfTextTone,
}

#[derive(Default)]
struct PdfPageDraft {
    lines: Vec<PdfPlacedLine>,
}

fn millimeters_to_points(value: f32) -> f32 {
    value * 72.0 / 25.4
}

fn pdf_text_width(font: &ParsedFont, text: &str, size: f32) -> Result<f32, String> {
    let units_per_em = font.font_metrics.units_per_em as f32;
    text.chars().try_fold(0.0, |width, character| {
        let glyph = font.lookup_glyph_index(character as u32).ok_or_else(|| {
            format!(
                "Bundled PDF font does not contain glyph U+{:04X}.",
                character as u32
            )
        })?;
        Ok(width + font.get_horizontal_advance(glyph) as f32 * size / units_per_em)
    })
}

fn wrap_pdf_text(
    font: &ParsedFont,
    value: &str,
    size: f32,
    max_width: f32,
) -> Result<Vec<String>, String> {
    if max_width < PDF_MIN_TEXT_WIDTH {
        return Err("PDF outline indentation leaves too little room for text.".to_string());
    }

    let normalized = normalize_newlines(value).replace('\t', "    ");
    let mut lines = Vec::new();

    for physical_line in normalized.split('\n') {
        if physical_line.is_empty() {
            lines.push(String::new());
            continue;
        }

        let mut line = String::new();
        let mut line_width = 0.0;
        for character in physical_line.chars() {
            let character_width = pdf_text_width(font, &character.to_string(), size)?;
            if !line.is_empty() && line_width + character_width > max_width {
                lines.push(line.trim_end().to_string());
                line.clear();
                line_width = 0.0;
                if character.is_whitespace() {
                    continue;
                }
            }
            line.push(character);
            line_width += character_width;
        }
        lines.push(line.trim_end().to_string());
    }

    Ok(lines)
}

fn prepare_pdf_row(
    font: &ParsedFont,
    node: &ExportNode,
    depth: usize,
) -> Result<PdfPreparedRow, String> {
    let margin_x = millimeters_to_points(PDF_MARGIN_X_MM);
    let body_width = millimeters_to_points(PDF_PAGE_WIDTH_MM - PDF_MARGIN_X_MM * 2.0);
    let max_indent = body_width - PDF_MIN_TEXT_WIDTH - PDF_NOTE_INDENT;
    let indentation = (depth as f32 * PDF_DEPTH_INDENT).min(max_indent);
    let title_x = margin_x + indentation;
    let title_width = body_width - indentation;
    let marker = if node.completed { 'x' } else { ' ' };
    let title = format!("[{marker}] {}", node.title);
    let title_lines = wrap_pdf_text(font, &title, PDF_ROW_SIZE, title_width)?;
    let mut lines = title_lines
        .into_iter()
        .map(|text| PdfPreparedLine {
            text,
            x: title_x,
            size: PDF_ROW_SIZE,
            line_height: PDF_ROW_LINE_HEIGHT,
            tone: PdfTextTone::Primary,
        })
        .collect::<Vec<_>>();

    if !node.note.is_empty() {
        let note_x = title_x + PDF_NOTE_INDENT;
        let note_width = title_width - PDF_NOTE_INDENT;
        for note_line in normalize_newlines(&node.note).split('\n') {
            let supporting = if note_line.is_empty() {
                ">".to_string()
            } else {
                format!("> {note_line}")
            };
            lines.extend(
                wrap_pdf_text(font, &supporting, PDF_NOTE_SIZE, note_width)?
                    .into_iter()
                    .map(|text| PdfPreparedLine {
                        text,
                        x: note_x,
                        size: PDF_NOTE_SIZE,
                        line_height: PDF_NOTE_LINE_HEIGHT,
                        tone: PdfTextTone::Supporting,
                    }),
            );
        }
    }

    let height = lines.iter().map(|line| line.line_height).sum::<f32>() + PDF_ROW_GAP;
    Ok(PdfPreparedRow { lines, height })
}

fn prepare_pdf_rows(
    font: &ParsedFont,
    node: &ExportNode,
    depth: usize,
    rows: &mut Vec<PdfPreparedRow>,
) -> Result<(), String> {
    rows.push(prepare_pdf_row(font, node, depth)?);
    for child in &node.children {
        prepare_pdf_rows(font, child, depth + 1, rows)?;
    }
    Ok(())
}

fn place_pdf_lines(page: &mut PdfPageDraft, lines: Vec<PdfPreparedLine>, mut top: f32) {
    for line in lines {
        let y = top - line.size;
        page.lines.push(PdfPlacedLine {
            text: line.text,
            x: line.x,
            y,
            size: line.size,
            line_height: line.line_height,
            tone: line.tone,
        });
        top -= line.line_height;
    }
}

fn pdf_text_color(tone: PdfTextTone) -> Color {
    let percent = match tone {
        PdfTextTone::Primary => 0.12,
        PdfTextTone::Supporting => 0.48,
    };
    Color::Greyscale(Greyscale::new(percent, None))
}

fn append_pdf_text_op(ops: &mut Vec<Op>, font_id: &FontId, line: PdfPlacedLine) {
    ops.extend([
        Op::StartTextSection,
        Op::SetTextCursor {
            pos: Point {
                x: Pt(line.x),
                y: Pt(line.y),
            },
        },
        Op::SetFont {
            font: PdfFontHandle::External(font_id.clone()),
            size: Pt(line.size),
        },
        Op::SetLineHeight {
            lh: Pt(line.line_height),
        },
        Op::SetFillColor {
            col: pdf_text_color(line.tone),
        },
        Op::ShowText {
            items: vec![TextItem::Text(line.text)],
        },
        Op::EndTextSection,
    ]);
}

fn build_pdf_pages(
    font: &ParsedFont,
    snapshot: &NotesExportSnapshot,
) -> Result<Vec<PdfPageDraft>, String> {
    let margin_x = millimeters_to_points(PDF_MARGIN_X_MM);
    let page_height = millimeters_to_points(PDF_PAGE_HEIGHT_MM);
    let content_top = page_height - millimeters_to_points(PDF_MARGIN_TOP_MM);
    let content_bottom = millimeters_to_points(PDF_MARGIN_BOTTOM_MM + PDF_FOOTER_RESERVE_MM);
    let body_width = millimeters_to_points(PDF_PAGE_WIDTH_MM - PDF_MARGIN_X_MM * 2.0);
    let title_lines = wrap_pdf_text(font, &snapshot.title, PDF_TITLE_SIZE, body_width)?
        .into_iter()
        .map(|text| PdfPreparedLine {
            text,
            x: margin_x,
            size: PDF_TITLE_SIZE,
            line_height: PDF_TITLE_LINE_HEIGHT,
            tone: PdfTextTone::Primary,
        })
        .collect::<Vec<_>>();
    let title_height = title_lines.len() as f32 * PDF_TITLE_LINE_HEIGHT + PDF_TITLE_GAP;
    if title_height > content_top - content_bottom {
        return Err("PDF title is too tall to fit on an A4 page.".to_string());
    }

    let mut rows = Vec::new();
    prepare_pdf_rows(font, &snapshot.root, 0, &mut rows)?;
    let full_page_height = content_top - content_bottom;
    let mut pages = vec![PdfPageDraft::default()];
    place_pdf_lines(&mut pages[0], title_lines, content_top);
    let mut cursor_top = content_top - title_height;

    for row in rows {
        if row.height > full_page_height {
            return Err("A PDF outline row is too tall to fit on an A4 page.".to_string());
        }
        if cursor_top - row.height < content_bottom {
            pages.push(PdfPageDraft::default());
            cursor_top = content_top;
        }
        let row_height = row.height;
        place_pdf_lines(
            pages.last_mut().expect("PDF page exists"),
            row.lines,
            cursor_top,
        );
        cursor_top -= row_height;
    }

    let page_count = pages.len();
    let footer_y = millimeters_to_points(10.0);
    for (index, page) in pages.iter_mut().enumerate() {
        let text = format!("Page {} / {page_count}", index + 1);
        let footer_width = pdf_text_width(font, &text, PDF_FOOTER_SIZE)?;
        let footer_x = (millimeters_to_points(PDF_PAGE_WIDTH_MM) - footer_width) / 2.0;
        page.lines.push(PdfPlacedLine {
            text,
            x: footer_x,
            y: footer_y,
            size: PDF_FOOTER_SIZE,
            line_height: PDF_FOOTER_SIZE,
            tone: PdfTextTone::Supporting,
        });
    }

    Ok(pages)
}

fn validate_serialized_pdf(bytes: &[u8], expected_page_count: usize) -> Result<(), String> {
    if !bytes.starts_with(b"%PDF-") || !bytes.windows(5).any(|window| window == b"%%EOF") {
        return Err("PDF serialization returned an invalid document.".to_string());
    }

    let parsed = lopdf::Document::load_mem(bytes)
        .map_err(|error| format!("Generated PDF could not be parsed: {error}"))?;
    if parsed.get_pages().len() != expected_page_count {
        return Err("Generated PDF page count changed during serialization.".to_string());
    }

    Ok(())
}

pub(crate) fn render_pdf(snapshot: &NotesExportSnapshot) -> Result<Vec<u8>, String> {
    validate_note_id(&snapshot.root_node_id)?;
    validate_export_node_ids(&snapshot.root)?;

    let mut font_warnings = Vec::new();
    let font = ParsedFont::from_bytes(PDF_FONT_BYTES, 0, &mut font_warnings)
        .ok_or_else(|| format!("Bundled PDF font could not be parsed: {font_warnings:?}"))?;
    let page_drafts = build_pdf_pages(&font, snapshot)?;
    let expected_page_count = page_drafts.len();
    let mut document = PdfDocument::new(&snapshot.title);
    let font_id = document.add_font(&font);
    let pages = page_drafts
        .into_iter()
        .map(|page| {
            let mut ops = Vec::new();
            for line in page.lines {
                append_pdf_text_op(&mut ops, &font_id, line);
            }
            PdfPage::new(Mm(PDF_PAGE_WIDTH_MM), Mm(PDF_PAGE_HEIGHT_MM), ops)
        })
        .collect();
    document.with_pages(pages);

    let mut save_warnings = Vec::new();
    let bytes = document.save(&PdfSaveOptions::default(), &mut save_warnings);
    if save_warnings
        .iter()
        .any(|warning| warning.severity == PdfParseErrorSeverity::Error)
    {
        return Err(format!(
            "PDF serialization reported errors: {save_warnings:?}"
        ));
    }
    validate_serialized_pdf(&bytes, expected_page_count)?;

    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::{
        load_export_snapshot, render_markdown, render_pdf, validate_serialized_pdf, PDF_FONT_BYTES,
    };
    use crate::notes::types::{ExportNode, NotesExportSnapshot};
    use printpdf::{Mm, Op, ParsedFont, PdfDocument, PdfPage, PdfParseOptions, Pt, TextItem};
    use rusqlite::{params, Connection};
    use std::collections::{BTreeMap, BTreeSet};

    const ROOT_ID: &str = "11111111-1111-4111-8111-111111111111";
    const FIRST_ID: &str = "22222222-2222-4222-8222-222222222222";
    const SECOND_ID: &str = "33333333-3333-4333-8333-333333333333";
    const LATER_ID: &str = "44444444-4444-4444-8444-444444444444";
    const DELETED_ID: &str = "55555555-5555-4555-8555-555555555555";
    const COLLAPSED_CHILD_ID: &str = "66666666-6666-4666-8666-666666666666";
    const INVALID_DESCENDANT_ID: &str = "bad -->\n# injected";

    fn export_node(
        id: &str,
        title: &str,
        note: &str,
        completed: bool,
        children: Vec<ExportNode>,
    ) -> ExportNode {
        ExportNode {
            id: id.to_string(),
            title: title.to_string(),
            note: note.to_string(),
            completed,
            children,
        }
    }

    fn snapshot(root: ExportNode) -> NotesExportSnapshot {
        NotesExportSnapshot {
            root_node_id: root.id.clone(),
            title: root.title.clone(),
            exported_at: "2026-07-10T12:34:56.789Z".to_string(),
            root,
        }
    }

    fn korean_snapshot() -> NotesExportSnapshot {
        snapshot(export_node(
            ROOT_ID,
            "프로젝트 · Project 2026",
            "한글 메모 “Korean note”",
            false,
            vec![export_node(
                FIRST_ID,
                "완료 작업 - ASCII 42",
                "지원 설명… supporting detail!",
                true,
                Vec::new(),
            )],
        ))
    }

    fn parse_pdf(bytes: &[u8]) -> PdfDocument {
        let mut warnings = Vec::new();
        PdfDocument::parse(bytes, &PdfParseOptions::default(), &mut warnings)
            .expect("parse rendered PDF")
    }

    fn hydrate_parsed_glyph_cids(document: &mut PdfDocument) {
        let used_glyphs = document
            .pages
            .iter()
            .flat_map(|page| &page.ops)
            .filter_map(|op| match op {
                Op::ShowText { items } => Some(items),
                _ => None,
            })
            .flat_map(|items| items)
            .filter_map(|item| match item {
                TextItem::GlyphIds(glyphs) => Some(glyphs),
                _ => None,
            })
            .flat_map(|glyphs| glyphs.iter().map(|glyph| glyph.gid))
            .collect::<BTreeSet<_>>();
        let parsed_font = &document
            .resources
            .fonts
            .map
            .values()
            .next()
            .expect("parsed PDF font")
            .parsed_font;
        let mut glyph_text = BTreeMap::new();
        for codepoint in 0..=char::MAX as u32 {
            let Some(character) = char::from_u32(codepoint) else {
                continue;
            };
            let Some(glyph) = parsed_font.lookup_glyph_index(codepoint) else {
                continue;
            };
            if used_glyphs.contains(&glyph) {
                glyph_text.entry(glyph).or_insert(character);
                if glyph_text.len() == used_glyphs.len() {
                    break;
                }
            }
        }
        assert_eq!(glyph_text.len(), used_glyphs.len());

        for page in &mut document.pages {
            for op in &mut page.ops {
                let Op::ShowText { items } = op else {
                    continue;
                };
                for item in items {
                    let TextItem::GlyphIds(glyphs) = item else {
                        continue;
                    };
                    for glyph in glyphs {
                        glyph.cid = glyph_text
                            .get(&glyph.gid)
                            .map(|character| character.to_string());
                    }
                }
            }
        }
    }

    fn extracted_pdf_pages(document: &mut PdfDocument) -> Vec<String> {
        // printpdf 0.9.1 currently drops ToUnicode while parsing and otherwise
        // reverse-scans the entire BMP for every glyph during extraction.
        hydrate_parsed_glyph_cids(document);
        document
            .extract_text()
            .into_iter()
            .map(|chunks| chunks.join(" "))
            .collect()
    }

    fn export_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        connection
            .execute_batch(
                "CREATE TABLE notes_nodes (\
                   id TEXT PRIMARY KEY,\
                   parent_id TEXT,\
                   sort_key INTEGER NOT NULL,\
                   title TEXT NOT NULL,\
                   note TEXT NOT NULL,\
                   is_collapsed INTEGER NOT NULL DEFAULT 0,\
                   completed_at TEXT,\
                   deleted_at TEXT\
                 );",
            )
            .expect("create notes table");
        connection
    }

    struct SeedNode<'a> {
        id: &'a str,
        parent_id: Option<&'a str>,
        sort_key: i64,
        title: &'a str,
        note: &'a str,
        is_collapsed: bool,
        completed_at: Option<&'a str>,
        deleted_at: Option<&'a str>,
    }

    impl<'a> SeedNode<'a> {
        fn active(id: &'a str, parent_id: Option<&'a str>, sort_key: i64, title: &'a str) -> Self {
            Self {
                id,
                parent_id,
                sort_key,
                title,
                note: "",
                is_collapsed: false,
                completed_at: None,
                deleted_at: None,
            }
        }
    }

    fn insert_node(connection: &Connection, node: SeedNode<'_>) {
        connection
            .execute(
                "INSERT INTO notes_nodes (\
                   id, parent_id, sort_key, title, note, is_collapsed, completed_at, deleted_at\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    node.id,
                    node.parent_id,
                    node.sort_key,
                    node.title,
                    node.note,
                    node.is_collapsed,
                    node.completed_at,
                    node.deleted_at
                ],
            )
            .expect("insert node");
    }

    fn seeded_export_connection() -> Connection {
        let connection = export_connection();
        insert_node(
            &connection,
            SeedNode {
                note: "Root note",
                is_collapsed: true,
                ..SeedNode::active(ROOT_ID, None, 1024, "Project")
            },
        );
        insert_node(
            &connection,
            SeedNode::active(SECOND_ID, Some(ROOT_ID), 1024, "Second by ID"),
        );
        insert_node(
            &connection,
            SeedNode {
                note: "Supporting note",
                is_collapsed: true,
                completed_at: Some("2026-07-10T00:00:00.000Z"),
                ..SeedNode::active(FIRST_ID, Some(ROOT_ID), 1024, "First task")
            },
        );
        insert_node(
            &connection,
            SeedNode::active(LATER_ID, Some(ROOT_ID), 2048, "Later task"),
        );
        insert_node(
            &connection,
            SeedNode {
                deleted_at: Some("2026-07-10T01:00:00.000Z"),
                ..SeedNode::active(DELETED_ID, Some(ROOT_ID), 512, "Deleted task")
            },
        );
        insert_node(
            &connection,
            SeedNode {
                note: "Still exported",
                ..SeedNode::active(COLLAPSED_CHILD_ID, Some(FIRST_ID), 1024, "Collapsed child")
            },
        );
        connection
    }

    fn total_changes(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT total_changes()", [], |row| row.get(0))
            .expect("read total changes")
    }

    #[test]
    fn export_snapshot_keeps_active_sibling_order_content_and_completion_state() {
        let connection = seeded_export_connection();
        let changes_before = total_changes(&connection);

        let snapshot = load_export_snapshot(&connection, ROOT_ID).expect("snapshot");

        assert_eq!(snapshot.root_node_id, ROOT_ID);
        assert_eq!(snapshot.title, "Project");
        assert_eq!(snapshot.root.id, ROOT_ID);
        assert_eq!(snapshot.root.title, "Project");
        assert_eq!(snapshot.root.note, "Root note");
        assert!(!snapshot.root.completed);
        assert!(snapshot.exported_at.ends_with('Z'));
        assert_eq!(
            snapshot
                .root
                .children
                .iter()
                .map(|child| child.title.as_str())
                .collect::<Vec<_>>(),
            vec!["First task", "Second by ID", "Later task"]
        );
        assert!(snapshot.root.children[0].completed);
        assert_eq!(snapshot.root.children[0].note, "Supporting note");
        assert_eq!(
            snapshot.root.children[0].children[0].title,
            "Collapsed child"
        );
        assert_eq!(total_changes(&connection), changes_before);
    }

    #[test]
    fn export_snapshot_rejects_a_missing_or_deleted_root() {
        let connection = seeded_export_connection();

        let missing = load_export_snapshot(&connection, "77777777-7777-4777-8777-777777777777")
            .expect_err("missing root");
        let deleted = load_export_snapshot(&connection, DELETED_ID).expect_err("deleted root");

        assert!(missing.contains("missing or deleted"));
        assert!(deleted.contains("missing or deleted"));
    }

    #[test]
    fn export_snapshot_rejects_cyclic_tree_corruption() {
        let connection = export_connection();
        insert_node(
            &connection,
            SeedNode::active(ROOT_ID, Some(FIRST_ID), 1024, "Cycle one"),
        );
        insert_node(
            &connection,
            SeedNode::active(FIRST_ID, Some(ROOT_ID), 1024, "Cycle two"),
        );

        let error = load_export_snapshot(&connection, ROOT_ID).expect_err("cycle");

        assert!(error.contains("cycle"));
    }

    #[test]
    fn markdown_renderer_matches_the_deterministic_frontmatter_and_tree_byte_contract() {
        let snapshot = snapshot(export_node(
            ROOT_ID,
            "Project",
            "Root note",
            false,
            vec![export_node(FIRST_ID, "First task", "", true, Vec::new())],
        ));

        let rendered = render_markdown(&snapshot).expect("render Markdown");

        assert_eq!(
            rendered,
            concat!(
                "---\n",
                "kind: yonalist-notes-export\n",
                "format_version: 1\n",
                "source: notes.sqlite\n",
                "root_node_id: \"11111111-1111-4111-8111-111111111111\"\n",
                "exported_at: \"2026-07-10T12:34:56.789Z\"\n",
                "---\n",
                "\n",
                "# Project\n",
                "\n",
                "- [ ] Project <!-- yonalist-node-id: 11111111-1111-4111-8111-111111111111 -->\n",
                "  > Root note\n",
                "  - [x] First task <!-- yonalist-node-id: 22222222-2222-4222-8222-222222222222 -->\n",
            )
            .as_bytes()
        );
        assert!(rendered.ends_with(b"\n"));
        assert!(!rendered.ends_with(b"\n\n"));
    }

    #[test]
    fn markdown_renderer_escapes_markdown_and_comment_sensitive_text_consistently() {
        let unsafe_text = r#"A \ *bold* [link](x) #tag <!-- forged --> & done"#;
        let snapshot = snapshot(export_node(
            ROOT_ID,
            unsafe_text,
            unsafe_text,
            false,
            Vec::new(),
        ));

        let rendered = String::from_utf8(render_markdown(&snapshot).expect("render Markdown"))
            .expect("UTF-8 Markdown");
        let escaped = r#"A \\ \*bold\* \[link\]\(x\) \#tag &lt;\!\-\- forged \-\-&gt; &amp; done"#;

        assert!(rendered.contains(&format!("# {escaped}\n")));
        assert!(rendered.contains(&format!(
            "- [ ] {escaped} <!-- yonalist-node-id: {ROOT_ID} -->\n"
        )));
        assert!(rendered.contains(&format!("  > {escaped}\n")));
        assert_eq!(rendered.matches("<!--").count(), 1);
        assert_eq!(rendered.matches("-->").count(), 1);
    }

    #[test]
    fn markdown_renderer_normalizes_crlf_and_preserves_blank_multiline_note_lines() {
        let snapshot = snapshot(export_node(
            ROOT_ID,
            "Project",
            "first\r\n\rsecond\nthird",
            false,
            Vec::new(),
        ));

        let rendered = String::from_utf8(render_markdown(&snapshot).expect("render Markdown"))
            .expect("UTF-8 Markdown");

        assert!(rendered.contains("  > first\n  >\n  > second\n  > third\n"));
        assert!(!rendered.contains('\r'));
    }

    #[test]
    fn markdown_renderer_rejects_an_invalid_descendant_without_returning_injected_markdown() {
        let snapshot = snapshot(export_node(
            ROOT_ID,
            "Project",
            "",
            false,
            vec![export_node(
                INVALID_DESCENDANT_ID,
                "Injected child",
                "",
                false,
                Vec::new(),
            )],
        ));

        let error = render_markdown(&snapshot)
            .expect_err("invalid descendant must not return Markdown bytes");

        assert_eq!(error, "Note ID must be a canonical UUID v4 string.");
    }

    #[test]
    fn pdf_font_asset_parses_and_maps_required_korean_punctuation_and_ascii_glyphs() {
        let mut warnings = Vec::new();
        let font =
            ParsedFont::from_bytes(PDF_FONT_BYTES, 0, &mut warnings).expect("parse bundled font");

        for codepoint in 0xAC00..=0xD7A3 {
            let character = char::from_u32(codepoint).expect("modern Hangul syllable");
            let glyph = font
                .lookup_glyph_index(character as u32)
                .unwrap_or_else(|| panic!("missing Korean glyph U+{codepoint:04X}"));
            assert!(
                font.get_horizontal_advance(glyph) > 0,
                "Korean glyph U+{codepoint:04X} has no advance"
            );
        }

        for character in "ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎㅏㅑㅓㅕㅗㅛㅜㅠㅡㅣ·…“”‘’「」『』〈〉《》()[]{}<>.,!?;:'\"-_/\\#&+*= 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".chars() {
            let glyph = font
                .lookup_glyph_index(character as u32)
                .unwrap_or_else(|| panic!("missing required glyph U+{:04X}", character as u32));
            assert!(
                font.get_horizontal_advance(glyph) > 0,
                "required glyph U+{:04X} has no advance",
                character as u32
            );
        }
    }

    #[test]
    fn pdf_export_keeps_small_korean_document_under_three_megabytes() {
        let bytes = render_pdf(&korean_snapshot()).expect("render small Korean PDF");

        assert!(
            bytes.len() < 3_000_000,
            "small Korean PDF was {} bytes",
            bytes.len()
        );
    }

    #[test]
    fn pdf_export_serializes_parseable_a4_document_for_korean_snapshot() {
        let bytes = render_pdf(&korean_snapshot()).expect("render PDF");

        assert!(bytes.starts_with(b"%PDF-"));
        assert!(bytes.len() > 1_024);
        assert!(bytes.windows(5).any(|window| window == b"%%EOF"));

        let parsed = parse_pdf(&bytes);
        assert_eq!(parsed.page_count(), 1);
        let expected_width: Pt = Mm(210.0).into();
        let expected_height: Pt = Mm(297.0).into();
        assert!((parsed.pages[0].media_box.width.0 - expected_width.0).abs() < 1.0);
        assert!((parsed.pages[0].media_box.height.0 - expected_height.0).abs() < 1.0);
    }

    #[test]
    fn pdf_serialization_validation_checks_the_structural_page_count() {
        let mut document = PdfDocument::new("validation fixture");
        document.with_pages(vec![PdfPage::new(Mm(210.0), Mm(297.0), Vec::new())]);
        let mut warnings = Vec::new();
        let bytes = document.save(&Default::default(), &mut warnings);

        validate_serialized_pdf(&bytes, 1).expect("validate one-page PDF");
        assert_eq!(
            validate_serialized_pdf(&bytes, 2).expect_err("reject changed page count"),
            "Generated PDF page count changed during serialization."
        );
    }

    #[test]
    fn pdf_export_preserves_korean_text_and_embeds_a_unicode_font() {
        let bytes = render_pdf(&korean_snapshot()).expect("render PDF");
        let mut parsed = parse_pdf(&bytes);
        let text = extracted_pdf_pages(&mut parsed).join(" ");

        assert!(text.contains("프로젝트 · Project 2026"));
        assert!(text.contains("한글 메모 “Korean note”"));
        assert!(text.contains("[x] 완료 작업 - ASCII 42"));
        assert!(text.contains("지원 설명… supporting detail!"));
        assert!(text.contains("Page 1 / 1"));
        assert_eq!(parsed.resources.fonts.map.len(), 1);
        assert!(bytes
            .windows(b"/ToUnicode".len())
            .any(|window| window == b"/ToUnicode"));
        assert!(
            bytes
                .windows(b"/FontFile2".len())
                .any(|window| window == b"/FontFile2")
                || bytes
                    .windows(b"/FontFile3".len())
                    .any(|window| window == b"/FontFile3")
        );
    }

    #[test]
    fn pdf_export_wraps_long_korean_rows_without_losing_text() {
        let long_title = "긴한글제목".repeat(36);
        let long_note = "긴한글메모".repeat(36);
        let rendered = render_pdf(&snapshot(export_node(
            ROOT_ID,
            &long_title,
            &long_note,
            false,
            Vec::new(),
        )))
        .expect("render wrapped PDF");
        let mut parsed = parse_pdf(&rendered);
        let text = extracted_pdf_pages(&mut parsed)
            .join("")
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<String>();

        assert!(text.contains(&long_title));
        assert!(text.contains(&long_note));
    }

    #[test]
    fn pdf_export_keeps_rows_whole_across_numbered_pages() {
        let sentinel_id = "77777777-7777-4777-8777-777777777777";
        let sentinel_title = "페이지 경계 제목 Boundary title";
        let sentinel_note = "페이지 경계 메모 Boundary note";
        let mut children = (0..72)
            .map(|index| {
                export_node(
                    &format!("{index:08x}-0000-4000-8000-{index:012x}"),
                    &format!("행 {index:02} Outline row"),
                    "",
                    false,
                    Vec::new(),
                )
            })
            .collect::<Vec<_>>();
        children.insert(
            48,
            export_node(
                sentinel_id,
                sentinel_title,
                sentinel_note,
                false,
                Vec::new(),
            ),
        );
        let bytes = render_pdf(&snapshot(export_node(
            ROOT_ID,
            "긴 프로젝트 Long project",
            "",
            false,
            children,
        )))
        .expect("render multi-page PDF");
        let mut parsed = parse_pdf(&bytes);
        let pages = extracted_pdf_pages(&mut parsed);

        assert!(pages.len() > 1);
        for (index, page) in pages.iter().enumerate() {
            assert!(page.contains(&format!("Page {} / {}", index + 1, pages.len())));
        }
        let sentinel_page = pages
            .iter()
            .find(|page| page.contains(sentinel_title))
            .expect("sentinel title page");
        assert!(sentinel_page.contains(sentinel_note));
    }

    #[test]
    fn pdf_renderer_rejects_invalid_descendant_before_returning_bytes() {
        let snapshot = snapshot(export_node(
            ROOT_ID,
            "Project",
            "",
            false,
            vec![export_node(
                INVALID_DESCENDANT_ID,
                "Injected child",
                "",
                false,
                Vec::new(),
            )],
        ));

        let error = render_pdf(&snapshot).expect_err("invalid descendant must not return PDF");

        assert_eq!(error, "Note ID must be a canonical UUID v4 string.");
    }
}
