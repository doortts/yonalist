//! The spec's grammar is the renderer's output, byte for byte. Each fixture is
//! the file a stated document state has to produce; if the renderer and the
//! spec ever disagree, one of them is wrong and this says so.

use notes_sync::document::{
    DocumentId, DocumentNode, DocumentRoot, ImageReference, Marker, NodeBody, PageDocument,
    TrashDocument, VaultFile,
};
use notes_sync::render::render;

fn node(id: &str, hlc: &str, text: &str) -> DocumentNode {
    DocumentNode {
        id: id.to_owned(),
        hlc: hlc.to_owned(),
        body: NodeBody::Text(text.to_owned()),
        note: String::new(),
        marker: Marker::Bullet,
        collapsed: false,
        completed: false,
        starred: false,
        from: None,
        unknown_tokens: Vec::new(),
        children: Vec::new(),
    }
}

fn page() -> PageDocument {
    let mut architecture = node(
        "8a201f33-0000-4c91-8d02-000000000001",
        "0swkd7qz6-00-a3f2",
        "아키텍처 다시 그리기",
    );
    let mut boundaries = node(
        "8a201f33-0000-4c91-8d02-000000000002",
        "0swkd7qz7-00-a3f2",
        "크레이트 경계 정리",
    );
    boundaries.marker = Marker::Todo;
    let mut diagram = node(
        "8a201f33-0000-4c91-8d02-000000000003",
        "0swkd7qz8-00-a3f2",
        "",
    );
    diagram.body = NodeBody::Image(ImageReference {
        original_name: "아키텍처.png".to_owned(),
        path: "assets/아키텍처-9f3a1c8e2044.png".to_owned(),
        display_width: 320,
        pixel_width: 1280,
        pixel_height: 720,
        byte_size: 421_904,
        unknown_tokens: Vec::new(),
    });
    architecture.children = vec![boundaries, diagram];

    let mut tidied = node(
        "8a201f33-0000-4c91-8d02-000000000004",
        "0swkd7qz9-00-a3f2",
        "정리한 것",
    );
    tidied.completed = true;
    tidied.collapsed = true;

    PageDocument {
        id: DocumentId::Node("4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1".to_owned()),
        parent: None,
        sort_key: None,
        max_hlc: "0swkd7qz9-00-a3f2".to_owned(),
        root: DocumentRoot {
            title: "Projects".to_owned(),
            note: "이번 분기에 손대는 것만.".to_owned(),
            hlc: "0swkd7qz5-00-a3f2".to_owned(),
            starred: true,
            ..DocumentRoot::default()
        },
        nodes: vec![architecture, tidied],
        unknown_frontmatter: Vec::new(),
    }
}

#[test]
fn a_page_renders_byte_identical_to_its_golden() {
    let rendered = render(&VaultFile::Page(page())).expect("render");

    assert_eq!(
        String::from_utf8(rendered).expect("utf-8"),
        include_str!("../fixtures/page.md")
    );
}

#[test]
fn rendering_the_same_state_twice_is_byte_identical() {
    let first = render(&VaultFile::Page(page())).expect("render");
    let second = render(&VaultFile::Page(page())).expect("render");

    assert_eq!(first, second);
}

#[test]
fn the_trash_renders_byte_identical_to_its_golden() {
    let mut old_page = node(
        "8a201f33-0000-4c91-8d02-000000000005",
        "0swkd7qza-00-a3f2",
        "Old page",
    );
    old_page.from = Some(("root".to_owned(), 4_294_967_296));
    let mut deleted = node(
        "8a201f33-0000-4c91-8d02-000000000006",
        "0swkd7qzb-00-a3f2",
        "Deleted",
    );
    deleted.from = Some((
        "4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1".to_owned(),
        8_589_934_592,
    ));
    let mut child = node(
        "8a201f33-0000-4c91-8d02-000000000007",
        "0swkd7qzc-00-a3f2",
        "Child",
    );
    child.completed = true;
    deleted.children = vec![child];

    let rendered = render(&VaultFile::Trash(TrashDocument {
        max_hlc: "0swkd7qzc-00-a3f2".to_owned(),
        nodes: vec![old_page, deleted],
    }))
    .expect("render");

    assert_eq!(
        String::from_utf8(rendered).expect("utf-8"),
        include_str!("../fixtures/trash.md")
    );
}

#[test]
fn a_split_document_renders_byte_identical_to_its_golden() {
    let rendered = render(&VaultFile::Page(PageDocument {
        id: DocumentId::Node("9d3f21b8-c440-4c91-8d02-2e77a05fb163".to_owned()),
        parent: Some("4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1".to_owned()),
        sort_key: Some(4_294_967_296),
        max_hlc: "0swkd7qze-00-a3f2".to_owned(),
        root: DocumentRoot {
            title: "2024 아카이브".to_owned(),
            hlc: "0swkd7qzd-00-a3f2".to_owned(),
            ..DocumentRoot::default()
        },
        nodes: vec![node(
            "8a201f33-0000-4c91-8d02-000000000008",
            "0swkd7qze-00-a3f2",
            "3월 회고",
        )],
        unknown_frontmatter: Vec::new(),
    }))
    .expect("render");

    assert_eq!(
        String::from_utf8(rendered).expect("utf-8"),
        include_str!("../fixtures/split.md")
    );
}

#[test]
fn the_home_document_renders_byte_identical_to_its_golden() {
    let mut projects = node(
        "4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1",
        "0swkd7qz5-00-a3f2",
        "",
    );
    projects.body = NodeBody::Split {
        title: "Projects".to_owned(),
        path: "Projects-4f1c8e20a3b7/README.md".to_owned(),
    };
    let mut minutes = node(
        "11c8da70-b5e1-4c91-8d02-a3f204ee81cc",
        "0swkd7qz6-00-a3f2",
        "",
    );
    minutes.body = NodeBody::Split {
        title: "회의록".to_owned(),
        path: "회의록-11c8da70b5e1/README.md".to_owned(),
    };

    let rendered = render(&VaultFile::Page(PageDocument {
        id: DocumentId::Home,
        parent: None,
        sort_key: None,
        max_hlc: "0swkd7qz6-00-a3f2".to_owned(),
        root: DocumentRoot {
            title: "Home".to_owned(),
            hlc: "0swkd7qz4-00-a3f2".to_owned(),
            ..DocumentRoot::default()
        },
        nodes: vec![projects, minutes],
        unknown_frontmatter: Vec::new(),
    }))
    .expect("render");

    assert_eq!(
        String::from_utf8(rendered).expect("utf-8"),
        include_str!("../fixtures/home.md")
    );
}

/// A checkbox is the todo marker's notation and nothing else, so a completed
/// todo must not also say `done` — the reader would see the same fact twice,
/// and a merge would have two places to disagree about one bit.
#[test]
fn a_completed_todo_says_so_with_its_checkbox_alone() {
    let mut errand = node(
        "8a201f33-0000-4c91-8d02-000000000009",
        "0swkd7qzf-00-a3f2",
        "Errand",
    );
    errand.marker = Marker::Todo;
    errand.completed = true;
    let mut plain = node(
        "8a201f33-0000-4c91-8d02-00000000000a",
        "0swkd7qzg-00-a3f2",
        "Plain",
    );
    plain.completed = true;

    let rendered = rendered_lines(vec![errand, plain]);

    assert!(
        rendered[0].starts_with("- [x] Errand <!--") && !rendered[0].contains(" done"),
        "a completed todo reads once, as a checked box: {}",
        rendered[0]
    );
    assert!(
        rendered[1].starts_with("- Plain <!--") && rendered[1].contains(" done"),
        "a completed bullet has no checkbox, so the token carries it: {}",
        rendered[1]
    );
}

/// The child document's frontmatter owns a split node's state. Repeating it on
/// the parent's line would give one node two authorities, and then the order
/// the two files merged in would decide the answer.
#[test]
fn a_split_line_carries_no_state_of_its_own() {
    let mut archive = node(
        "9d3f21b8-c440-4c91-8d02-2e77a05fb163",
        "0swkd7qzd-00-a3f2",
        "",
    );
    archive.body = NodeBody::Split {
        title: "2024 아카이브".to_owned(),
        path: "2024-아카이브-9d3f21b8c440/README.md".to_owned(),
    };
    archive.starred = true;
    archive.collapsed = true;
    archive.completed = true;
    archive.marker = Marker::Todo;

    let rendered = rendered_lines(vec![archive]);

    assert_eq!(
        rendered[0],
        "- [2024 아카이브](2024-아카이브-9d3f21b8c440/README.md) \
<!-- yid: 9d3f21b8-c440-4c91-8d02-2e77a05fb163 t: 0swkd7qzd-00-a3f2 split -->"
    );
}

/// A hand editor and `git diff --check` both eat a trailing space, so a key
/// whose value is missing must not be written at all.
#[test]
fn an_unstamped_document_is_reported_rather_than_written() {
    let mut document = page();
    document.max_hlc = String::new();

    assert_eq!(
        render(&VaultFile::Page(document)).expect_err("unstamped"),
        "A rendered document needs max_hlc.",
        "the report has to name what is missing, not call an empty value invalid"
    );
}

fn rendered_lines(nodes: Vec<DocumentNode>) -> Vec<String> {
    let mut document = page();
    document.root.note = String::new();
    document.nodes = nodes;
    let rendered =
        String::from_utf8(render(&VaultFile::Page(document)).expect("render")).expect("utf-8");
    rendered
        .split_once("\n\n")
        .expect("body")
        .1
        .lines()
        .map(str::to_owned)
        .collect()
}
