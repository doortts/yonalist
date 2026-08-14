use std::sync::Arc;

use notes_application::{ExportError, ExportNode, ExportSnapshot};
use notes_core::{NoteMarkerKind, NoteNodeKind};
use printpdf::ParsedFont;

pub(super) const PDF_PAGE_WIDTH_MM: f32 = 210.0;
pub(super) const PDF_PAGE_HEIGHT_MM: f32 = 297.0;
const MARGIN_X_MM: f32 = 18.0;
const MARGIN_TOP_MM: f32 = 20.0;
const MARGIN_BOTTOM_MM: f32 = 18.0;
const FOOTER_RESERVE_MM: f32 = 10.0;
const TITLE_SIZE: f32 = 20.0;
const TITLE_LINE_HEIGHT: f32 = 26.0;
const TITLE_GAP: f32 = 14.0;
const ROW_SIZE: f32 = 10.8;
const ROW_LINE_HEIGHT: f32 = 15.0;
const NOTE_SIZE: f32 = 9.0;
const NOTE_LINE_HEIGHT: f32 = 12.5;
const ROW_GAP: f32 = 5.0;
const DEPTH_INDENT: f32 = 14.0;
const NOTE_INDENT: f32 = 12.0;
const MIN_TEXT_WIDTH: f32 = 72.0;
const FOOTER_SIZE: f32 = 8.5;
const IMAGE_CAPTION_SIZE: f32 = 8.5;
const IMAGE_CAPTION_LINE_HEIGHT: f32 = 11.0;
const IMAGE_CAPTION_GAP: f32 = 5.0;
const CSS_PIXEL_POINTS: f32 = 72.0 / 96.0;

#[derive(Clone, Copy)]
pub(super) enum PdfTextTone {
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

struct PdfPreparedImage {
    content_hash: String,
    original_name: String,
    mime_type: String,
    bytes: Arc<[u8]>,
    intrinsic_width: u32,
    intrinsic_height: u32,
    x: f32,
    width: f32,
    height: f32,
    marker_line: PdfPreparedLine,
    caption_lines: Vec<PdfPreparedLine>,
    primary_height: f32,
    block_height: f32,
}

enum PdfPreparedBlock {
    Row(PdfPreparedRow),
    Image(PdfPreparedImage),
}

pub(super) struct PdfPlacedLine {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub size: f32,
    pub line_height: f32,
    pub tone: PdfTextTone,
}

pub(super) struct PdfPlacedImage {
    pub content_hash: String,
    pub original_name: String,
    pub mime_type: String,
    pub bytes: Arc<[u8]>,
    pub intrinsic_width: u32,
    pub intrinsic_height: u32,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

pub(super) enum PdfPlacedElement {
    Line(usize),
    Image(usize),
}

#[derive(Default)]
pub(super) struct PdfPageDraft {
    pub lines: Vec<PdfPlacedLine>,
    pub images: Vec<PdfPlacedImage>,
    pub elements: Vec<PdfPlacedElement>,
}

fn points(mm: f32) -> f32 {
    mm * 72.0 / 25.4
}

fn text_width(font: &ParsedFont, text: &str, size: f32) -> Result<f32, ExportError> {
    let units_per_em = font.font_metrics.units_per_em as f32;
    text.chars().try_fold(0.0, |width, character| {
        let glyph = font.lookup_glyph_index(character as u32).ok_or_else(|| {
            ExportError::Failed(format!(
                "Bundled PDF font does not contain glyph U+{:04X}.",
                character as u32
            ))
        })?;
        Ok(width + font.get_horizontal_advance(glyph) as f32 * size / units_per_em)
    })
}

fn wrap(
    font: &ParsedFont,
    value: &str,
    size: f32,
    max_width: f32,
) -> Result<Vec<String>, ExportError> {
    if max_width < MIN_TEXT_WIDTH {
        return Err(ExportError::Failed(
            "PDF outline indentation leaves too little room for text.".into(),
        ));
    }
    let normalized = value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\t', "    ");
    let mut lines = Vec::new();
    for physical_line in normalized.split('\n') {
        if physical_line.is_empty() {
            lines.push(String::new());
            continue;
        }
        let mut line = String::new();
        let mut width = 0.0;
        for character in physical_line.chars() {
            let character_width = text_width(font, &character.to_string(), size)?;
            if !line.is_empty() && width + character_width > max_width {
                lines.push(line.trim_end().to_owned());
                line.clear();
                width = 0.0;
                if character.is_whitespace() {
                    continue;
                }
            }
            line.push(character);
            width += character_width;
        }
        lines.push(line.trim_end().to_owned());
    }
    Ok(lines)
}

fn row(
    font: &ParsedFont,
    node: &ExportNode,
    depth: usize,
    number: Option<i64>,
) -> Result<PdfPreparedRow, ExportError> {
    let body_width = points(PDF_PAGE_WIDTH_MM - MARGIN_X_MM * 2.0);
    let max_indent = body_width - MIN_TEXT_WIDTH - NOTE_INDENT;
    let indentation = (depth as f32 * DEPTH_INDENT).min(max_indent);
    let x = points(MARGIN_X_MM) + indentation;
    let width = body_width - indentation;
    let mut lines = wrap(
        font,
        &format!(
            "{} {}",
            marker_prefix(node.marker, node.completed, number),
            node.text
        ),
        ROW_SIZE,
        width,
    )?
    .into_iter()
    .map(|text| PdfPreparedLine {
        text,
        x,
        size: ROW_SIZE,
        line_height: ROW_LINE_HEIGHT,
        tone: PdfTextTone::Primary,
    })
    .collect::<Vec<_>>();
    if !node.note.is_empty() {
        for physical_line in node
            .note
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .split('\n')
        {
            let note = if physical_line.is_empty() {
                ">".into()
            } else {
                format!("> {physical_line}")
            };
            lines.extend(
                wrap(font, &note, NOTE_SIZE, width - NOTE_INDENT)?
                    .into_iter()
                    .map(|text| PdfPreparedLine {
                        text,
                        x: x + NOTE_INDENT,
                        size: NOTE_SIZE,
                        line_height: NOTE_LINE_HEIGHT,
                        tone: PdfTextTone::Supporting,
                    }),
            );
        }
    }
    let height = lines.iter().map(|line| line.line_height).sum::<f32>() + ROW_GAP;
    Ok(PdfPreparedRow { lines, height })
}

fn image(
    font: &ParsedFont,
    node: &ExportNode,
    depth: usize,
    full_page_height: f32,
    number: Option<i64>,
) -> Result<PdfPreparedImage, ExportError> {
    let image = node
        .image
        .as_ref()
        .ok_or_else(|| ExportError::Failed("A PDF image node has no image metadata.".into()))?;
    let bytes = image
        .bytes
        .clone()
        .ok_or_else(|| ExportError::Failed("PDF image bytes were not hydrated.".into()))?;
    let body_width = points(PDF_PAGE_WIDTH_MM - MARGIN_X_MM * 2.0);
    let indentation = (depth as f32 * DEPTH_INDENT).min(body_width - MIN_TEXT_WIDTH - NOTE_INDENT);
    let marker_x = points(MARGIN_X_MM) + indentation;
    let x = marker_x + NOTE_INDENT;
    let max_width = body_width - indentation - NOTE_INDENT;
    let mut caption_lines = Vec::new();
    if !node.note.is_empty() {
        caption_lines.extend(
            wrap(font, &format!("> {}", node.note), NOTE_SIZE, max_width)?
                .into_iter()
                .map(|text| PdfPreparedLine {
                    text,
                    x,
                    size: NOTE_SIZE,
                    line_height: NOTE_LINE_HEIGHT,
                    tone: PdfTextTone::Supporting,
                }),
        );
    }
    caption_lines.extend(
        wrap(
            font,
            image.metadata.original_name(),
            IMAGE_CAPTION_SIZE,
            max_width,
        )?
        .into_iter()
        .map(|text| PdfPreparedLine {
            text,
            x,
            size: IMAGE_CAPTION_SIZE,
            line_height: IMAGE_CAPTION_LINE_HEIGHT,
            tone: PdfTextTone::Supporting,
        }),
    );
    let caption_height = caption_lines
        .iter()
        .map(|line| line.line_height)
        .sum::<f32>();
    let max_image_height = full_page_height - IMAGE_CAPTION_GAP - caption_height - ROW_GAP;
    if max_image_height <= 0.0 {
        return Err(ExportError::Failed(
            "A PDF image caption is too tall for an A4 page.".into(),
        ));
    }
    let intrinsic_width = image.metadata.pixel_width();
    let intrinsic_height = image.metadata.pixel_height();
    let mut width = image.metadata.display_width() as f32 * CSS_PIXEL_POINTS;
    let mut height = width * intrinsic_height as f32 / intrinsic_width as f32;
    let scale = (max_width / width).min(max_image_height / height).min(1.0);
    width *= scale;
    height *= scale;
    let marker_line = PdfPreparedLine {
        text: marker_prefix(node.marker, node.completed, number),
        x: marker_x,
        size: ROW_SIZE,
        line_height: ROW_LINE_HEIGHT,
        tone: PdfTextTone::Primary,
    };
    let primary_height = height.max(marker_line.line_height);
    let block_height = primary_height + IMAGE_CAPTION_GAP + caption_height + ROW_GAP;
    Ok(PdfPreparedImage {
        content_hash: image.metadata.content_hash().into(),
        original_name: image.metadata.original_name().into(),
        mime_type: image.metadata.mime_type().into(),
        bytes,
        intrinsic_width,
        intrinsic_height,
        x,
        width,
        height,
        marker_line,
        caption_lines,
        primary_height,
        block_height,
    })
}

fn marker_prefix(marker: NoteMarkerKind, completed: bool, number: Option<i64>) -> String {
    match marker {
        NoteMarkerKind::Bullet => "\u{2022}".into(),
        NoteMarkerKind::Todo if completed => "[x]".into(),
        NoteMarkerKind::Todo => "[ ]".into(),
        // A run counted from its own first row, so an export prints the numbers
        // the outline shows. A row torn out of its run falls back to its own.
        NoteMarkerKind::Ordered { start } => format!("{}.", number.unwrap_or(start)),
    }
}

fn blocks(
    font: &ParsedFont,
    node: &ExportNode,
    depth: usize,
    full_page_height: f32,
    output: &mut Vec<PdfPreparedBlock>,
    number: Option<i64>,
) -> Result<(), ExportError> {
    match node.kind {
        NoteNodeKind::Image => {
            output.push(PdfPreparedBlock::Image(image(
                font,
                node,
                depth,
                full_page_height,
                number,
            )?));
        }
        NoteNodeKind::Page | NoteNodeKind::Bullet => {
            output.push(PdfPreparedBlock::Row(row(font, node, depth, number)?));
        }
    }
    // One run of numbered siblings counts from the number its first row was
    // given; anything else between them ends the run, exactly as the outline
    // draws it.
    let mut counted: Option<i64> = None;
    for child in &node.children {
        let child_number = match child.marker {
            NoteMarkerKind::Ordered { start } => {
                let next = counted.map_or(start, |previous| previous + 1);
                counted = Some(next);
                Some(next)
            }
            _ => {
                counted = None;
                None
            }
        };
        blocks(
            font,
            child,
            depth + 1,
            full_page_height,
            output,
            child_number,
        )?;
    }
    Ok(())
}

fn place_lines(page: &mut PdfPageDraft, lines: Vec<PdfPreparedLine>, mut top: f32) {
    for line in lines {
        page.lines.push(PdfPlacedLine {
            text: line.text,
            x: line.x,
            y: top - line.size,
            size: line.size,
            line_height: line.line_height,
            tone: line.tone,
        });
        page.elements
            .push(PdfPlacedElement::Line(page.lines.len() - 1));
        top -= line.line_height;
    }
}

pub(super) fn build_pages(
    font: &ParsedFont,
    snapshot: &ExportSnapshot,
) -> Result<Vec<PdfPageDraft>, ExportError> {
    let page_height = points(PDF_PAGE_HEIGHT_MM);
    let content_top = page_height - points(MARGIN_TOP_MM);
    let content_bottom = points(MARGIN_BOTTOM_MM + FOOTER_RESERVE_MM);
    let body_width = points(PDF_PAGE_WIDTH_MM - MARGIN_X_MM * 2.0);
    let title_lines = if snapshot.root.kind == NoteNodeKind::Image {
        Vec::new()
    } else {
        wrap(font, &snapshot.title, TITLE_SIZE, body_width)?
            .into_iter()
            .map(|text| PdfPreparedLine {
                text,
                x: points(MARGIN_X_MM),
                size: TITLE_SIZE,
                line_height: TITLE_LINE_HEIGHT,
                tone: PdfTextTone::Primary,
            })
            .collect::<Vec<_>>()
    };
    let title_height = if title_lines.is_empty() {
        0.0
    } else {
        title_lines.len() as f32 * TITLE_LINE_HEIGHT + TITLE_GAP
    };
    let full_page_height = content_top - content_bottom;
    if title_height > full_page_height {
        return Err(ExportError::Failed(
            "The PDF title is too tall for an A4 page.".into(),
        ));
    }
    let mut prepared = Vec::new();
    blocks(
        font,
        &snapshot.root,
        0,
        full_page_height,
        &mut prepared,
        None,
    )?;
    let mut pages = vec![PdfPageDraft::default()];
    place_lines(&mut pages[0], title_lines, content_top);
    let mut cursor_top = content_top - title_height;
    for block in prepared {
        match block {
            PdfPreparedBlock::Row(row) => {
                if row.height <= full_page_height && cursor_top - row.height < content_bottom {
                    pages.push(PdfPageDraft::default());
                    cursor_top = content_top;
                }
                if row.height <= full_page_height {
                    let height = row.height;
                    place_lines(
                        pages.last_mut().expect("page exists"),
                        row.lines,
                        cursor_top,
                    );
                    cursor_top -= height;
                } else {
                    for line in row.lines {
                        if cursor_top - line.line_height < content_bottom {
                            pages.push(PdfPageDraft::default());
                            cursor_top = content_top;
                        }
                        let line_height = line.line_height;
                        place_lines(
                            pages.last_mut().expect("page exists"),
                            vec![line],
                            cursor_top,
                        );
                        cursor_top -= line_height;
                    }
                    cursor_top -= ROW_GAP;
                }
            }
            PdfPreparedBlock::Image(image) => {
                if image.block_height > full_page_height {
                    return Err(ExportError::Failed(
                        "A PDF image is too tall for an A4 page.".into(),
                    ));
                }
                if cursor_top - image.block_height < content_bottom {
                    pages.push(PdfPageDraft::default());
                    cursor_top = content_top;
                }
                let image_y = cursor_top - image.height;
                let caption_top = cursor_top - image.primary_height - IMAGE_CAPTION_GAP;
                let block_height = image.block_height;
                let page = pages.last_mut().expect("page exists");
                place_lines(page, vec![image.marker_line], cursor_top);
                page.images.push(PdfPlacedImage {
                    content_hash: image.content_hash,
                    original_name: image.original_name,
                    mime_type: image.mime_type,
                    bytes: image.bytes,
                    intrinsic_width: image.intrinsic_width,
                    intrinsic_height: image.intrinsic_height,
                    x: image.x,
                    y: image_y,
                    width: image.width,
                    height: image.height,
                });
                page.elements
                    .push(PdfPlacedElement::Image(page.images.len() - 1));
                place_lines(page, image.caption_lines, caption_top);
                cursor_top -= block_height;
            }
        }
    }
    let count = pages.len();
    for (index, page) in pages.iter_mut().enumerate() {
        let text = format!("Page {} / {count}", index + 1);
        let width = text_width(font, &text, FOOTER_SIZE)?;
        page.lines.push(PdfPlacedLine {
            text,
            x: (points(PDF_PAGE_WIDTH_MM) - width) / 2.0,
            y: points(10.0),
            size: FOOTER_SIZE,
            line_height: FOOTER_SIZE,
            tone: PdfTextTone::Supporting,
        });
        page.elements
            .push(PdfPlacedElement::Line(page.lines.len() - 1));
    }
    Ok(pages)
}

#[cfg(test)]
mod tests {
    use super::marker_prefix;
    use notes_core::NoteMarkerKind;

    #[test]
    fn markers_preserve_bullet_and_todo_semantics() {
        assert_eq!(
            marker_prefix(NoteMarkerKind::Bullet, false, None),
            "\u{2022}"
        );
        assert_eq!(
            marker_prefix(NoteMarkerKind::Bullet, true, None),
            "\u{2022}"
        );
        assert_eq!(marker_prefix(NoteMarkerKind::Todo, false, None), "[ ]");
        assert_eq!(marker_prefix(NoteMarkerKind::Todo, true, None), "[x]");
    }

    #[test]
    fn a_numbered_row_prints_the_number_its_run_reached() {
        let marker = NoteMarkerKind::Ordered { start: 3 };
        assert_eq!(marker_prefix(marker, false, Some(4)), "4.");
        assert_eq!(marker_prefix(marker, false, None), "3.");
    }
}
