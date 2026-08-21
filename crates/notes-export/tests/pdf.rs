use std::io::Cursor;
use std::path::PathBuf;
use std::sync::Arc;

use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use notes_application::{
    ExportError, ExportFormat, ExportImage, ExportNode, ExportRendererPort, ExportSnapshot,
    RenderedExport,
};
use notes_core::{NodeId, NoteImage, NoteMarkerKind, NoteNodeKind};
use notes_export::NativeExportRenderer;

fn id(value: &str) -> NodeId {
    NodeId::try_from(value).expect("valid node ID")
}

fn font_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/yonalist/src-tauri/resources/NanumGothic-Regular.ttf")
}

fn text_node(id_value: &str, text: impl Into<String>, note: impl Into<String>) -> ExportNode {
    ExportNode {
        id: id(id_value),
        kind: NoteNodeKind::Bullet,
        marker: NoteMarkerKind::Bullet,
        text: text.into(),
        note: note.into(),
        completed: false,
        image: None,
        children: Vec::new(),
    }
}

fn encoded_image(format: ImageFormat) -> Vec<u8> {
    let pixels = RgbaImage::from_pixel(8, 5, Rgba([32, 120, 240, 255]));
    let mut cursor = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(pixels)
        .write_to(&mut cursor, format)
        .expect("encode image fixture");
    cursor.into_inner()
}

fn image_node(
    id_value: &str,
    hash_digit: char,
    extension: &str,
    mime_type: &str,
    bytes: Arc<[u8]>,
) -> ExportNode {
    let hash = hash_digit.to_string().repeat(64);
    let metadata = NoteImage::try_new(
        hash.clone(),
        format!("{hash}.{extension}"),
        format!("fixture.{extension}"),
        mime_type,
        bytes.len() as u64,
        8,
        5,
        320,
    )
    .expect("valid image metadata");
    ExportNode {
        id: id(id_value),
        kind: NoteNodeKind::Image,
        marker: NoteMarkerKind::Bullet,
        text: metadata.original_name().into(),
        note: String::new(),
        completed: false,
        image: Some(ExportImage {
            metadata,
            bytes: Some(bytes),
        }),
        children: Vec::new(),
    }
}

fn snapshot(children: Vec<ExportNode>) -> ExportSnapshot {
    ExportSnapshot {
        revision: 7,
        root_node_id: id("page"),
        title: "한글 내보내기".into(),
        exported_at: "2026-07-29T00:00:00.000Z".into(),
        root: ExportNode {
            id: id("page"),
            kind: NoteNodeKind::Page,
            marker: NoteMarkerKind::Bullet,
            text: "한글 내보내기".into(),
            note: "페이지 설명".into(),
            completed: false,
            image: None,
            children,
        },
    }
}

fn pdf_bytes(rendered: RenderedExport) -> Vec<u8> {
    match rendered {
        RenderedExport::Pdf { document } => document,
        RenderedExport::Markdown { .. } => panic!("expected PDF"),
    }
}

fn dictionary_name<'a>(dictionary: &'a lopdf::Dictionary, key: &[u8]) -> Option<&'a [u8]> {
    dictionary.get(key).ok()?.as_name().ok()
}

fn object_dictionary(object: &lopdf::Object) -> Option<&lopdf::Dictionary> {
    match object {
        lopdf::Object::Dictionary(dictionary) => Some(dictionary),
        lopdf::Object::Stream(stream) => Some(&stream.dict),
        _ => None,
    }
}

#[test]
fn korean_text_wraps_and_paginates_into_a_parseable_pdf() {
    let mut children = Vec::new();
    children.push(text_node(
        "long",
        "긴 문장 ".repeat(75),
        "여러 줄 메모\n둘째 줄",
    ));
    children.extend(
        (0..112)
            .map(|index| text_node(&format!("row-{index}"), format!("목록 항목 {index:03}"), "")),
    );
    let renderer = NativeExportRenderer::new(font_path());

    let bytes = pdf_bytes(
        renderer
            .render(&snapshot(children), ExportFormat::Pdf, None)
            .expect("render Korean PDF"),
    );

    assert!(bytes.starts_with(b"%PDF-"));
    let parsed = lopdf::Document::load_mem(&bytes).expect("parse generated PDF");
    assert!(parsed.get_pages().len() >= 3);
    let unicode_fonts = parsed
        .objects
        .values()
        .filter_map(object_dictionary)
        .filter(|dictionary| dictionary_name(dictionary, b"Type") == Some(b"Font"))
        .filter(|dictionary| dictionary_name(dictionary, b"Subtype") == Some(b"Type0"))
        .count();
    assert_eq!(unicode_fonts, 1);
}

#[test]
fn one_oversized_outline_row_continues_across_pages() {
    let renderer = NativeExportRenderer::new(font_path());
    let oversized = text_node("oversized-row", "A ".repeat(18_000), "");

    let bytes = pdf_bytes(
        renderer
            .render(&snapshot(vec![oversized]), ExportFormat::Pdf, None)
            .expect("split one oversized row"),
    );

    let parsed = lopdf::Document::load_mem(&bytes).expect("parse generated PDF");
    assert!(parsed.get_pages().len() >= 2);
}

#[test]
fn supported_images_are_embedded_once_per_unique_payload() {
    let png = Arc::<[u8]>::from(encoded_image(ImageFormat::Png));
    let jpeg = Arc::<[u8]>::from(encoded_image(ImageFormat::Jpeg));
    let gif = Arc::<[u8]>::from(encoded_image(ImageFormat::Gif));
    let webp = Arc::<[u8]>::from(encoded_image(ImageFormat::WebP));
    let children = vec![
        image_node("png", 'a', "png", "image/png", Arc::clone(&png)),
        image_node("png-copy", 'a', "png", "image/png", png),
        image_node("jpeg", 'b', "jpg", "image/jpeg", jpeg),
        image_node("gif", 'c', "gif", "image/gif", gif),
        image_node("webp", 'd', "webp", "image/webp", webp),
    ];
    let renderer = NativeExportRenderer::new(font_path());

    let bytes = pdf_bytes(
        renderer
            .render(&snapshot(children), ExportFormat::Pdf, None)
            .expect("render image PDF"),
    );
    let parsed = lopdf::Document::load_mem(&bytes).expect("parse generated PDF");
    let image_count = parsed
        .objects
        .values()
        .filter_map(object_dictionary)
        .filter(|dictionary| dictionary_name(dictionary, b"Subtype") == Some(b"Image"))
        .count();
    assert_eq!(image_count, 4);
}

#[test]
fn unsupported_glyphs_and_pdf_working_memory_fail_before_publication() {
    let renderer = NativeExportRenderer::new(font_path());
    let glyph_error = renderer
        .render(
            &snapshot(vec![text_node("emoji", "unsupported 🫠", "")]),
            ExportFormat::Pdf,
            None,
        )
        .expect_err("emoji is not present in Nanum Gothic");
    assert!(matches!(glyph_error, ExportError::Failed(_)));

    let hash = "e".repeat(64);
    let metadata = NoteImage::try_new(
        hash.clone(),
        format!("{hash}.png"),
        "oversized.png",
        "image/png",
        1,
        4_000,
        10_000,
        320,
    )
    .expect("valid maximum-size image metadata");
    let oversized = ExportNode {
        id: id("oversized"),
        kind: NoteNodeKind::Image,
        marker: NoteMarkerKind::Bullet,
        text: "oversized.png".into(),
        note: String::new(),
        completed: false,
        image: Some(ExportImage {
            metadata,
            bytes: Some(Arc::from([0_u8])),
        }),
        children: Vec::new(),
    };
    let budget_error = renderer
        .render(&snapshot(vec![oversized]), ExportFormat::Pdf, None)
        .expect_err("working memory budget must be checked before decode");
    assert!(matches!(budget_error, ExportError::TooLarge(_)));
}
