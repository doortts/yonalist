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
        place: None,
        unknown_tokens: Vec::new(),
        unknown_state: Default::default(),
        children: Vec::new(),
    }
}

fn page() -> PageDocument {
    let mut architecture = node("Nd0000000001", "0swkd7qz6-00-a3f2", "아키텍처 다시 그리기");
    let mut boundaries = node("Nd0000000002", "0swkd7qz7-00-a3f2", "크레이트 경계 정리");
    boundaries.marker = Marker::Todo;
    let mut diagram = node("Nd0000000003", "0swkd7qz8-00-a3f2", "");
    diagram.body = NodeBody::Image(ImageReference {
        original_name: "아키텍처.png".to_owned(),
        path: "assets/아키텍처-9f3a1c8e2044.png".to_owned(),
        asset_hash: String::new(),
        display_width: 320,
        pixel_width: 1280,
        pixel_height: 720,
        byte_size: 421_904,
        unknown_tokens: Vec::new(),
    });
    architecture.children = vec![boundaries, diagram];

    let mut tidied = node("Nd0000000004", "0swkd7qz9-00-a3f2", "정리한 것");
    tidied.completed = true;
    tidied.collapsed = true;

    PageDocument {
        id: DocumentId::Node("PrJects00001".to_owned()),
        parent: None,
        sort_key: None,
        max_hlc: "0swkd7qz9-00-a3f2".to_owned(),
        state_hash: String::new(),
        base: String::new(),
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
    let mut old_page = node("Nd0000000005", "0swkd7qza-00-a3f2", "Old page");
    old_page.from = Some(("root".to_owned(), 4_294_967_296));
    let mut deleted = node("Nd0000000006", "0swkd7qzb-00-a3f2", "Deleted");
    deleted.from = Some(("PrJects00001".to_owned(), 8_589_934_592));
    let mut child = node("Nd0000000007", "0swkd7qzc-00-a3f2", "Child");
    child.completed = true;
    deleted.children = vec![child];

    let rendered = render(&VaultFile::Trash(TrashDocument {
        max_hlc: "0swkd7qzc-00-a3f2".to_owned(),
        state_hash: String::new(),
        base: String::new(),
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
        id: DocumentId::Node("Archive00001".to_owned()),
        parent: Some("PrJects00001".to_owned()),
        sort_key: Some(4_294_967_296),
        max_hlc: "0swkd7qze-00-a3f2".to_owned(),
        state_hash: String::new(),
        base: String::new(),
        root: DocumentRoot {
            title: "2024 아카이브".to_owned(),
            hlc: "0swkd7qzd-00-a3f2".to_owned(),
            ..DocumentRoot::default()
        },
        nodes: vec![node("Nd0000000008", "0swkd7qze-00-a3f2", "3월 회고")],
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
    let mut projects = node("PrJects00001", "0swkd7qz5-00-a3f2", "");
    projects.body = NodeBody::Split {
        title: "Projects".to_owned(),
        path: "Projects-PrJects00001/README.md".to_owned(),
        child_kind: notes_sync::document::ChildKind::Page,
    };
    let mut minutes = node("Mnutes000001", "0swkd7qz6-00-a3f2", "");
    minutes.body = NodeBody::Split {
        title: "회의록".to_owned(),
        path: "회의록-Mnutes000001/README.md".to_owned(),
        child_kind: notes_sync::document::ChildKind::Page,
    };

    let rendered = render(&VaultFile::Page(PageDocument {
        id: DocumentId::Home,
        parent: None,
        sort_key: None,
        max_hlc: "0swkd7qz6-00-a3f2".to_owned(),
        state_hash: String::new(),
        base: String::new(),
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
/// todo must not also say so in the footer — the reader would see it twice,
/// and a merge would have two places to disagree about one bit.
#[test]
fn a_completed_todo_says_so_with_its_checkbox_alone() {
    let mut errand = node("Nd0000000009", "0swkd7qzf-00-a3f2", "Errand");
    errand.marker = Marker::Todo;
    errand.completed = true;
    let mut plain = node("Nd0000000010", "0swkd7qzg-00-a3f2", "Plain");
    plain.completed = true;

    let rendered = rendered_file(vec![errand, plain]);

    assert!(
        rendered.contains("- [x] Errand <!-- yid: Nd0000000009 -->")
            && !rendered.contains(r#""Nd0000000009""#),
        "a completed todo reads once, as a checked box:\n{rendered}"
    );
    assert!(
        rendered.contains("- Plain <!-- yid: Nd0000000010 -->")
            && rendered.contains(r#""Nd0000000010":{"completed":true}"#),
        "a completed bullet has no checkbox, so the footer carries it:\n{rendered}"
    );
}

/// The child document's frontmatter owns a split node's state. Repeating it on
/// the parent's line would give one node two authorities, and then the order
/// the two files merged in would decide the answer. The one thing the footer
/// adds is which kind of child it is, which the line has nowhere to draw.
#[test]
fn a_split_line_carries_no_state_of_its_own() {
    let mut archive = node("Archive00001", "0swkd7qzd-00-a3f2", "");
    archive.body = NodeBody::Split {
        title: "2024 아카이브".to_owned(),
        path: "2024-아카이브-Archive00001/README.md".to_owned(),
        child_kind: notes_sync::document::ChildKind::Split,
    };
    archive.starred = true;
    archive.collapsed = true;
    archive.completed = true;
    archive.marker = Marker::Todo;

    let rendered = rendered_file(vec![archive]);

    assert!(
        rendered.contains(
            "- [2024 아카이브](2024-아카이브-Archive00001/README.md) <!-- yid: Archive00001 -->"
        ),
        "the line carries the child's name and nothing else:\n{rendered}"
    );
    assert_eq!(
        rendered.matches("Archive00001\":").count(),
        1,
        "the footer states the child kind and no state of its own:\n{rendered}"
    );
    assert!(
        rendered.contains(r#""Archive00001":{"child_kind":"split"}"#),
        "the child kind is the one thing the footer adds:\n{rendered}"
    );
}

fn rendered_file(nodes: Vec<DocumentNode>) -> String {
    let mut document = page();
    document.root.note = String::new();
    document.nodes = nodes;
    String::from_utf8(render(&VaultFile::Page(document)).expect("render")).expect("utf-8")
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
        .take_while(|line| *line != "<!-- yonalist")
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The whole of §3.1 in one document: a readable body carrying nothing but a
/// `yid` per bullet, document facts in the frontmatter, and everything markdown
/// cannot hold in a single footer. Rendering it has to produce the file the
/// design states, and reading that file back has to produce the same bytes —
/// otherwise two devices disagree about what they are looking at.
#[test]
fn the_representative_page_renders_and_reads_back_unchanged() {
    let rendered = render(&VaultFile::Page(representative())).expect("render");
    let rendered = String::from_utf8(rendered).expect("utf-8");

    assert_eq!(rendered, include_str!("../fixtures/representative.md"));

    let read_back = notes_sync::parse::parse(rendered.as_bytes()).expect("parse");
    let again = String::from_utf8(render(&read_back).expect("re-render")).expect("utf-8");

    assert_eq!(again, rendered, "a round trip changed the file");
}

fn representative() -> PageDocument {
    let mut explain = node(
        "Xm3_aP9kT2Ws",
        "0swkd7qz8-00-a3f2",
        "Shift+Enter — 설명 입력하기",
    );
    let mut picture = node("Qw6Jm2_zR8Ka", "0swkd7qza-00-a3f2", "");
    picture.body = NodeBody::Image(ImageReference {
        original_name: "SCR-20251116-tljz.png".to_owned(),
        path: "assets/SCR-20251116-tljz-5f47a32a8480.png".to_owned(),
        asset_hash: "sha256:ae3473dd5c72398997e6b7ac71e0dd308ea6c3a813855911c57a80627a531e12"
            .to_owned(),
        display_width: 268,
        pixel_width: 870,
        pixel_height: 602,
        byte_size: 38471,
        unknown_tokens: Vec::new(),
    });
    explain.children = vec![
        node(
            "Gp0vL7_cN4Ya",
            "0swkd7qz9-00-a3f2",
            "지금까지 한 걸로는 크게 차이를 모르겠는데",
        ),
        picture,
        node("Vc9_nL5pT1Xe", "0swkd7qzb-00-a3f2", "음."),
    ];

    let mut done = node(
        "Hm4sK8_qW2Pd",
        "0swkd7qzc-00-a3f2",
        "⌘/Ctrl+Enter — 완료 표시",
    );
    done.marker = Marker::Todo;
    done.starred = true;

    let mut archive = node("Ry2mN8_pQ4Kd", "0swkd7qzd-00-a3f2", "");
    archive.body = NodeBody::Split {
        title: "2024 아카이브".to_owned(),
        path: "2024-아카이브-Ry2mN8_pQ4Kd/README.md".to_owned(),
        child_kind: notes_sync::document::ChildKind::Split,
    };

    PageDocument {
        id: DocumentId::Node("Df4qM9_wK2Ls".to_owned()),
        parent: None,
        sort_key: None,
        max_hlc: "0swkd7qzd-00-a3f2".to_owned(),
        state_hash: "sha256:6d5ae96bf58a843503fe53accdd568af3b7363c91e445e71f6bba05402264443"
            .to_owned(),
        base: "sha256:9252d3da63ed134eb842ad21c0e772f8c8f8b7685d7dcd02653475945aa321fb".to_owned(),
        root: DocumentRoot {
            title: "Yonalist 시작하기".to_owned(),
            note: "이 노트는 자유롭게 수정하거나 삭제할 수 있어요.".to_owned(),
            hlc: "0swkd7qz5-00-a3f2".to_owned(),
            collapsed: true,
            ..DocumentRoot::default()
        },
        nodes: vec![
            node(
                "N7dP2k_q4WmA",
                "0swkd7qz6-00-a3f2",
                "Enter — 새 항목 만들기",
            ),
            node(
                "Bf8xL2mQ0_Ke",
                "0swkd7qz7-00-a3f2",
                "Tab / Shift+Tab — 들여쓰기 / 내어쓰기",
            ),
            explain,
            done,
            archive,
            node("Tn7_bC3xP9La", "0swkd7qze-00-a3f2", "↑/↓ — 항목 사이 이동"),
        ],
        unknown_frontmatter: Vec::new(),
    }
}

/// What the app draws is what the file shows. A numbered run counts up from the
/// number its first row was typed with, and the file writes that same number —
/// otherwise a person opening the vault in any editor sees bullets where the app
/// shows a list.
#[test]
fn an_ordered_run_draws_the_numbers_the_app_draws() {
    let mut fifth = node("Aa0000000001", "0swkd7qz6-00-a3f2", "다섯째");
    fifth.marker = Marker::Ordered(5);
    let mut sixth = node("Aa0000000002", "0swkd7qz7-00-a3f2", "여섯째");
    sixth.marker = Marker::Ordered(5);
    let plain = node("Aa0000000003", "0swkd7qz8-00-a3f2", "끼어든 줄");
    let mut restart = node("Aa0000000004", "0swkd7qz9-00-a3f2", "다시 하나");
    restart.marker = Marker::Ordered(1);
    // A bullet whose own text opens with a number must not read back as a
    // numbered row, or the escape is the only thing keeping the two apart.
    let looks_numbered = node("Aa0000000005", "0swkd7qza-00-a3f2", "3. 진짜 본문");

    let lines = rendered_lines(vec![fifth, sixth, plain, restart, looks_numbered]);

    assert_eq!(
        lines
            .iter()
            .map(|line| line.split(" <!--").next().unwrap_or_default())
            .collect::<Vec<_>>(),
        vec![
            "5. 다섯째",
            "6. 여섯째",
            "- 끼어든 줄",
            "1. 다시 하나",
            r"- 3\. 진짜 본문",
        ]
    );
}

/// The numbers are the body's to state, so nothing in the footer repeats them.
/// Two authorities for one fact is one too many, and the footer is the one a
/// person editing the file cannot keep correct.
#[test]
fn a_numbered_row_keeps_its_marker_out_of_the_footer() {
    let mut first = node("Aa0000000001", "0swkd7qz6-00-a3f2", "하나");
    first.marker = Marker::Ordered(1);
    let mut document = page();
    document.root = DocumentRoot {
        title: "Numbers".to_owned(),
        ..DocumentRoot::default()
    };
    document.nodes = vec![first];

    let rendered =
        String::from_utf8(render(&VaultFile::Page(document)).expect("render")).expect("utf-8");

    assert!(
        !rendered.contains("\"marker\"") && !rendered.contains("\"ordered_start\""),
        "the footer restated what the line already says:\n{rendered}"
    );
    let read_back = notes_sync::parse::parse(rendered.as_bytes()).expect("parse");
    let notes_sync::document::VaultFile::Page(read_back) = read_back else {
        panic!("a page read back as something else");
    };
    assert_eq!(read_back.nodes[0].marker, Marker::Ordered(1));
}
