use std::path::PathBuf;
use std::sync::Arc;

use notes_application::{
    ExportFormat, ExportImage, ExportNode, ExportRendererPort, ExportSnapshot, RenderedExport,
};
use notes_core::{NodeId, NoteImage, NoteMarkerKind, NoteNodeKind};
use notes_export::NativeExportRenderer;

fn id(value: &str) -> NodeId {
    NodeId::try_from(value).expect("valid node id")
}

fn text_node(
    node_id: &str,
    text: &str,
    note: &str,
    marker: NoteMarkerKind,
    completed: bool,
    children: Vec<ExportNode>,
) -> ExportNode {
    ExportNode {
        id: id(node_id),
        kind: NoteNodeKind::Bullet,
        marker,
        text: text.into(),
        note: note.into(),
        completed,
        image: None,
        children,
    }
}

fn image_node(node_id: &str, original_name: &str, bytes: Option<Arc<[u8]>>) -> ExportNode {
    let hash = "a".repeat(64);
    ExportNode {
        id: id(node_id),
        kind: NoteNodeKind::Image,
        marker: NoteMarkerKind::Bullet,
        text: original_name.into(),
        note: String::new(),
        completed: false,
        image: Some(ExportImage {
            metadata: NoteImage::try_new(
                hash.clone(),
                format!("{hash}.png"),
                original_name,
                "image/png",
                3,
                1,
                1,
                320,
            )
            .expect("image metadata"),
            bytes,
        }),
        children: Vec::new(),
    }
}

fn snapshot(image_bytes: Option<Arc<[u8]>>) -> ExportSnapshot {
    ExportSnapshot {
        revision: 7,
        root_node_id: id("page"),
        title: "프로젝트".into(),
        exported_at: "2026-07-29T00:00:00.000Z".into(),
        root: ExportNode {
            id: id("page"),
            kind: NoteNodeKind::Page,
            marker: NoteMarkerKind::Bullet,
            text: "프로젝트".into(),
            note: String::new(),
            completed: false,
            image: None,
            children: vec![
                text_node(
                    "done",
                    "한국어 [완료]",
                    "첫 줄\r\n\r\n둘째 줄",
                    NoteMarkerKind::Todo,
                    true,
                    vec![text_node(
                        "nested",
                        "Nested",
                        "",
                        NoteMarkerKind::Bullet,
                        false,
                        Vec::new(),
                    )],
                ),
                text_node("empty", "", "", NoteMarkerKind::Bullet, false, Vec::new()),
                image_node("image-a", "shared.png", image_bytes.clone()),
                image_node("image-b", "copy.png", image_bytes),
            ],
        },
    }
}

#[test]
fn markdown_matches_the_deterministic_tree_and_asset_contract() {
    let renderer = NativeExportRenderer::new(PathBuf::from("unused-font.ttf"));
    let bytes = Arc::<[u8]>::from(vec![1, 2, 3]);

    let rendered = renderer
        .render(
            &snapshot(Some(bytes)),
            ExportFormat::Markdown,
            Some("Page_assets"),
        )
        .expect("render Markdown");
    let RenderedExport::Markdown {
        document,
        asset_directory_name,
        assets,
    } = rendered
    else {
        panic!("expected Markdown");
    };

    assert_eq!(asset_directory_name, "Page_assets");
    assert_eq!(
        document,
        concat!(
            "---\n",
            "kind: yonalist-notes-export\n",
            "format_version: 1\n",
            "source: notes.sqlite\n",
            "root_node_id: \"page\"\n",
            "exported_at: \"2026-07-29T00:00:00.000Z\"\n",
            "---\n",
            "\n",
            "# 프로젝트\n",
            "\n",
            "- [ ] 프로젝트 <!-- yonalist-node-id: page -->\n",
            "  - [x] 한국어 \\[완료\\] <!-- yonalist-node-id: done -->\n",
            "    > 첫 줄\n",
            "    >\n",
            "    > 둘째 줄\n",
            "    - [ ] Nested <!-- yonalist-node-id: nested -->\n",
            "  - [ ]  <!-- yonalist-node-id: empty -->\n",
            "  - [ ] ![Image](Page_assets/0001.png) <!-- yonalist-attachment-original-name: shared.png --> <!-- yonalist-node-id: image-a -->\n",
            "  - [ ] ![Image](Page_assets/0001.png) <!-- yonalist-attachment-original-name: copy.png --> <!-- yonalist-node-id: image-b -->\n",
        )
        .as_bytes()
    );
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0].file_name, "0001.png");
    assert_eq!(assets[0].bytes.as_ref(), [1, 2, 3]);
}

#[test]
fn markdown_is_repeatable_and_rejects_unhydrated_images() {
    let renderer = NativeExportRenderer::new(PathBuf::from("unused-font.ttf"));
    let bytes = Arc::<[u8]>::from(vec![1, 2, 3]);
    let hydrated = snapshot(Some(bytes));

    let first = renderer
        .render(&hydrated, ExportFormat::Markdown, Some("assets"))
        .expect("first render");
    let second = renderer
        .render(&hydrated, ExportFormat::Markdown, Some("assets"))
        .expect("second render");

    assert_eq!(first, second);
    assert!(
        renderer
            .render(&snapshot(None), ExportFormat::Markdown, Some("assets"))
            .is_err()
    );
}

/// A run of numbered rows leads with the numbers the outline draws, counting
/// from the one its first row carries. Anything that is not a numbered sibling
/// ends the run, and the row after it starts its own.
#[test]
fn markdown_numbers_a_run_of_ordered_rows() {
    let renderer = NativeExportRenderer::new(PathBuf::from("unused-font.ttf"));
    let snapshot = ExportSnapshot {
        revision: 1,
        root_node_id: id("page"),
        title: "Shopping".into(),
        exported_at: "2026-08-15T00:00:00.000Z".into(),
        root: ExportNode {
            id: id("page"),
            kind: NoteNodeKind::Page,
            marker: NoteMarkerKind::Bullet,
            text: "Shopping".into(),
            note: String::new(),
            completed: false,
            image: None,
            children: vec![
                text_node(
                    "milk",
                    "Milk",
                    "",
                    NoteMarkerKind::Ordered { start: 3 },
                    false,
                    Vec::new(),
                ),
                text_node(
                    "onion",
                    "Onion",
                    "",
                    NoteMarkerKind::Ordered { start: 9 },
                    true,
                    Vec::new(),
                ),
                text_node(
                    "break",
                    "Break",
                    "",
                    NoteMarkerKind::Bullet,
                    false,
                    Vec::new(),
                ),
                text_node(
                    "tofu",
                    "Tofu",
                    "",
                    NoteMarkerKind::Ordered { start: 1 },
                    false,
                    Vec::new(),
                ),
            ],
        },
    };

    let RenderedExport::Markdown { document, .. } = renderer
        .render(&snapshot, ExportFormat::Markdown, Some("assets"))
        .expect("render Markdown")
    else {
        panic!("expected Markdown");
    };
    let body = String::from_utf8(document).expect("UTF-8 Markdown");

    assert!(
        body.contains("  3. [ ] Milk <!-- yonalist-node-id: milk -->\n"),
        "{body}"
    );
    assert!(
        body.contains("  4. [x] Onion <!-- yonalist-node-id: onion -->\n"),
        "{body}"
    );
    assert!(
        body.contains("  - [ ] Break <!-- yonalist-node-id: break -->\n"),
        "{body}"
    );
    assert!(
        body.contains("  1. [ ] Tofu <!-- yonalist-node-id: tofu -->\n"),
        "{body}"
    );
}
