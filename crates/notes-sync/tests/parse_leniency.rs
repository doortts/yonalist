//! What the parser accepts it accepts for a stated reason, and what it rejects
//! it rejects whole — a document that is half applied is worse than one that is
//! skipped, because nothing downstream can tell which half it got.
//!
//! The body is the part a person edits, so the parser is lenient there: odd
//! indentation, a bullet nobody gave an id, a comment it cannot close. The
//! footer is the part only the app writes, so a footer it cannot read is a
//! reason to refuse the file rather than to guess.

use notes_sync::document::{ChildKind, DocumentId, Marker, NodeBody, VaultFile};
use notes_sync::parse::parse;

const DOCUMENT: &str = "PrJects00001";
const ONE: &str = "Nd0000000001";
const TWO: &str = "Nd0000000002";
const HASH: &str = "sha256:6d5ae96bf58a843503fe53accdd568af3b7363c91e445e71f6bba05402264443";

fn page(body: &str) -> String {
    format!(
        "---\nkind: yonalist-notes\nformat_version: 1\nid: {DOCUMENT}\n---\n# Projects\n\n{body}"
    )
}

/// A page whose footer states exactly what is passed in, so a test can say what
/// the app wrote without spelling out the whole envelope.
fn page_with_state(body: &str, state: &str) -> String {
    format!(
        "{}\n<!-- yonalist\n{{\"state_hash\":\"{HASH}\",\"base\":\"\",\"state\":{state}}}\n-->\n",
        page(body)
    )
}

fn accepted(source: &str) -> VaultFile {
    parse(source.as_bytes()).unwrap_or_else(|reason| panic!("expected accepted, got {reason}"))
}

fn nodes(source: &str) -> Vec<notes_sync::document::DocumentNode> {
    match accepted(source) {
        VaultFile::Page(page) => page.nodes,
        VaultFile::Trash(trash) => trash.nodes,
    }
}

fn round_trip(source: &str) {
    let once = notes_sync::render::render(&accepted(source)).expect("render");
    let text = String::from_utf8(once.clone()).expect("utf-8");
    let twice = notes_sync::render::render(&accepted(&text)).expect("render");

    assert_eq!(
        text, source,
        "the file came back different from how it went in"
    );
    assert_eq!(once, twice, "and a second trip has to change nothing");
}

// ---------------------------------------------------------------- the body

#[test]
fn a_bullet_without_yid_is_accepted_for_id_issue() {
    let parsed = nodes(&page("- Fresh thought\n"));

    assert_eq!(parsed.len(), 1);
    assert_eq!(
        parsed[0].id, "",
        "issuing an id is the merge's job, so the line still parses"
    );
}

#[test]
fn odd_indent_and_tabs_normalize_to_two_spaces() {
    let parsed = nodes(&page("- Parent\n\t- Tabbed\n     - Five spaces\n"));

    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].children.len(), 1, "a tab is one level");
    assert_eq!(
        parsed[0].children[0].children.len(),
        1,
        "five spaces round down to two levels"
    );
}

/// Indentation deeper than the line above can support is a hand edit, not a
/// hierarchy. The node joins at the deepest level that actually exists rather
/// than opening levels nobody wrote.
#[test]
fn a_bullet_indented_past_its_parent_clamps_to_the_deepest_real_level() {
    let parsed = nodes(&page("- Parent\n        - Far too deep\n"));

    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].children.len(), 1);
    assert!(parsed[0].children[0].children.is_empty());

    // Clamping is what keeps the depth cap honest: one line indented past the
    // cap is a typo, not a document that nests 200 deep, and rejecting the
    // whole file over it would lose everything else in it.
    let absurd = page(&format!("- Parent\n{}- Typo\n", "  ".repeat(200)));
    assert!(parse(absurd.as_bytes()).is_ok());
}

#[test]
fn a_checkbox_line_is_always_a_todo() {
    let parsed = nodes(&page("- [ ] Open\n- [x] Closed\n"));

    assert_eq!(parsed[0].marker, Marker::Todo);
    assert!(!parsed[0].completed);
    assert_eq!(parsed[1].marker, Marker::Todo);
    assert!(parsed[1].completed);
}

/// A numbered row draws its own number, so reading it back needs nothing from
/// the footer. Each row keeps the number it showed, which is what the run was
/// counting to anyway.
#[test]
fn a_numbered_line_is_ordered_at_the_number_it_draws() {
    let parsed = nodes(&page("5. Fifth\n6. Sixth\n- Plain\n1. Restart\n"));

    assert_eq!(parsed[0].marker, Marker::Ordered(5));
    assert_eq!(parsed[1].marker, Marker::Ordered(6));
    assert_eq!(parsed[2].marker, Marker::Bullet);
    assert_eq!(parsed[3].marker, Marker::Ordered(1));
}

/// Text that opens with a number is not a numbered row. The renderer escapes
/// the dot for exactly this reason, and reading it back has to undo only that.
#[test]
fn text_opening_with_an_escaped_number_stays_text() {
    let parsed = nodes(&page("- 3\\. 진짜 본문\n"));

    assert_eq!(parsed[0].marker, Marker::Bullet);
    assert_eq!(parsed[0].body, NodeBody::Text("3. 진짜 본문".to_owned()));
}

#[test]
fn a_completed_plain_bullet_takes_it_from_the_footer() {
    let parsed = nodes(&page_with_state(
        &format!("- Done thing <!-- yid: {ONE} -->\n"),
        &format!("{{\"{ONE}\":{{\"completed\":true}}}}"),
    ));

    assert_eq!(parsed[0].marker, Marker::Bullet);
    assert!(
        parsed[0].completed,
        "a bullet has no checkbox to draw, so the footer carries it"
    );
}

#[test]
fn crlf_normalizes_to_lf() {
    let source = page("- One\n  - Two\n").replace('\n', "\r\n");
    let parsed = nodes(&source);

    assert_eq!(parsed[0].body, NodeBody::Text("One".to_owned()));
    assert_eq!(parsed[0].children.len(), 1);
}

#[test]
fn a_blank_looking_body_line_is_a_blank_line() {
    let parsed = nodes(&page("- One\n   \n- Two\n"));

    assert_eq!(
        parsed.len(),
        2,
        "whitespace alone separates, it does not break"
    );
}

#[test]
fn missing_frontmatter_keys_take_defaults() {
    let VaultFile::Page(parsed) = accepted(&page("- Text\n")) else {
        panic!("a page");
    };

    assert_eq!(parsed.root.marker, Marker::Bullet);
    assert!(!parsed.root.collapsed);
    assert!(!parsed.root.starred);
    assert!(!parsed.root.completed);
    assert_eq!(parsed.parent, None);
    assert_eq!(parsed.sort_key, None);
    assert_eq!(parsed.state_hash, "", "no footer is no state hash");
    assert_eq!(parsed.base, "");
}

#[test]
fn the_home_document_accepts_the_literal_root_id() {
    let source = "---\nkind: yonalist-notes\nformat_version: 1\nid: root\n---\n# Home\n\n";
    let VaultFile::Page(parsed) = accepted(source) else {
        panic!("a page");
    };

    assert_eq!(parsed.id, DocumentId::Home);
}

/// Whether a document sitting somewhere other than the vault root may call
/// itself `root` is not a question the parser can answer — it never learns the
/// path. Reading it as home is right here, and the loader is what refuses one
/// found in the wrong place.
#[test]
fn the_literal_root_id_reads_as_home_wherever_it_is_found() {
    let source = page("- Text\n").replace(DOCUMENT, "root");
    let VaultFile::Page(parsed) = accepted(&source) else {
        panic!("a page");
    };

    assert_eq!(parsed.id, DocumentId::Home);
}

/// A comment the parser cannot read is still the user's bytes. Dropping it
/// would delete text, and dropping a broken `yid:` would hand the node a new
/// identity at the next merge — one invisible trailing space, one duplicate.
#[test]
fn a_malformed_comment_stays_in_the_body() {
    let parsed = nodes(&page("- keep this <!-- and this too\n"));

    assert_eq!(
        parsed[0].body,
        NodeBody::Text("keep this <!-- and this too".to_owned())
    );
}

#[test]
fn a_trailing_space_does_not_cost_a_node_its_identity() {
    let parsed = nodes(&page(&format!("- Text <!-- yid: {ONE} --> \n")));

    assert_eq!(parsed[0].id, ONE);
}

// ------------------------------------------------------- the older format

/// The format version did not move, so the parser is the only thing standing
/// between a vault and an older device's file. Meeting one of these means the
/// file is older, not newer: reading it would give every line a fresh id.
#[test]
fn a_reserved_frontmatter_key_quarantines() {
    for key in [
        "max_hlc: 0swkd7qz9-00-a3f2",
        "root_hlc: 0swkd7qz5-00-a3f2",
        "root_marker_kind: todo",
        "root_ordered_start: 3",
        "root_collapsed: true",
        "root_completed: true",
        "root_starred: true",
    ] {
        let source =
            page("- Text\n").replace("---\n# Projects", &format!("{key}\n---\n# Projects"));

        assert!(
            parse(source.as_bytes()).is_err(),
            "`{key}` is an older development format's key"
        );
    }
}

#[test]
fn a_reserved_comment_token_quarantines() {
    for token in [
        "t: 0swkd7qz6-00-a3f2",
        "prev: @0swkd7qz6-00-a3f2",
        "from: root@4294967296",
        "star",
        "todo",
        "ordered: 3",
        "done",
        "split",
        "collapsed",
    ] {
        let source = page(&format!("- Text <!-- yid: {ONE} {token} -->\n"));

        assert!(
            parse(source.as_bytes()).is_err(),
            "`{token}` is an older development format's token"
        );
    }
}

/// The old format put an image's measurements on the line. They are the app's
/// numbers, not a person's, so they moved to the footer — and a line still
/// carrying them is a file from before that move.
#[test]
fn an_image_line_still_carrying_its_ya_comment_quarantines() {
    let source = page(&format!(
        "- ![shot.png](assets/shot-9f3a1c8e2044.png) <!-- ya: w: 320 px: 10x10 bytes: 4 --> \
         <!-- yid: {ONE} -->\n"
    ));

    assert!(parse(source.as_bytes()).is_err());
}

#[test]
fn a_comment_carrying_more_than_an_id_quarantines() {
    let source = page(&format!("- Text <!-- yid: {ONE} future: value -->\n"));

    assert!(
        parse(source.as_bytes()).is_err(),
        "a bullet says which block it is and nothing else"
    );
}

// ------------------------------------------------------------- the footer

#[test]
fn the_footer_states_the_root_state_the_heading_cannot_draw() {
    let VaultFile::Page(parsed) = accepted(&page_with_state(
        "- Text\n",
        &format!(
            "{{\"{DOCUMENT}\":{{\"collapsed\":true,\"starred\":true,\"marker\":\"ordered\",\"ordered_start\":3}}}}"
        ),
    )) else {
        panic!("a page");
    };

    assert!(parsed.root.collapsed && parsed.root.starred);
    assert_eq!(parsed.root.marker, Marker::Ordered(3));
}

#[test]
fn the_footer_turns_a_link_line_into_a_child_document() {
    let parsed = nodes(&page_with_state(
        &format!("- [Archive](Archive-Archive00001/README.md) <!-- yid: {ONE} -->\n"),
        &format!("{{\"{ONE}\":{{\"child_kind\":\"split\"}}}}"),
    ));

    assert_eq!(
        parsed[0].body,
        NodeBody::Split {
            title: "Archive".to_owned(),
            path: "Archive-Archive00001/README.md".to_owned(),
            child_kind: ChildKind::Split,
        }
    );
}

/// A hand editor can write state onto a boundary line, and the format has no
/// way to stop them. What it can do is refuse to believe it: the child
/// document is the one authority, so a merge cannot depend on which file it
/// read first.
#[test]
fn a_child_document_line_grants_no_state_of_its_own() {
    let parsed = nodes(&page_with_state(
        &format!("- [x] [Archive](Archive-Archive00001/README.md) <!-- yid: {ONE} -->\n"),
        &format!("{{\"{ONE}\":{{\"collapsed\":true,\"starred\":true,\"child_kind\":\"page\"}}}}"),
    ));

    assert_eq!(parsed[0].marker, Marker::Bullet);
    assert!(!parsed[0].starred && !parsed[0].collapsed && !parsed[0].completed);
}

/// An external edit that deletes a bullet leaves its state behind. That is
/// ordinary, not damage: the body is the evidence, and state naming a block
/// the body does not hold simply has nothing to apply to.
#[test]
fn state_naming_a_block_the_body_does_not_hold_is_ignored() {
    let source = page_with_state(
        &format!("- Text <!-- yid: {ONE} -->\n"),
        &format!("{{\"{ONE}\":{{\"starred\":true}},\"{TWO}\":{{\"collapsed\":true}}}}"),
    );

    let parsed = nodes(&source);

    assert_eq!(parsed.len(), 1);
    assert!(parsed[0].starred);
}

#[test]
fn a_footer_that_is_not_last_quarantines() {
    let source = format!(
        "{}\n- After the footer <!-- yid: {TWO} -->\n",
        page_with_state("- Text\n", "{}").trim_end()
    );

    assert!(parse(source.as_bytes()).is_err());
}

#[test]
fn two_footers_quarantine() {
    let source = format!(
        "{}{}",
        page_with_state("- Text\n", "{}"),
        "\n<!-- yonalist\n{\"state_hash\":\"\",\"base\":\"\",\"state\":{}}\n-->\n"
    );

    assert!(parse(source.as_bytes()).is_err());
}

#[test]
fn an_unreadable_footer_quarantines() {
    for json in [
        "{not json at all}",
        "{\"state_hash\":\"nonsense\",\"base\":\"\",\"state\":{}}",
        "{\"state_hash\":\"sha256:ABCD\",\"base\":\"\",\"state\":{}}",
    ] {
        let source = format!("{}\n<!-- yonalist\n{json}\n-->\n", page("- Text\n"));

        assert!(
            parse(source.as_bytes()).is_err(),
            "`{json}` is not a footer this app wrote"
        );
    }
}

/// No footer at all is a plain markdown file somebody wrote by hand. It has no
/// ancestor to prove, which is a state the merge already knows how to handle —
/// refusing it would make the format unable to read ordinary markdown.
#[test]
fn a_file_with_no_footer_is_accepted() {
    let parsed = nodes(&page("- Just markdown\n"));

    assert_eq!(parsed.len(), 1);
}

// ---------------------------------------------------------- quarantine

#[test]
fn a_foreign_format_version_quarantines() {
    let source = page("- Text\n").replace("format_version: 1", "format_version: 4");

    assert!(parse(source.as_bytes()).is_err());
}

#[test]
fn a_missing_document_id_quarantines() {
    let source = page("- Text\n").replace(&format!("id: {DOCUMENT}\n"), "");

    assert!(parse(source.as_bytes()).is_err());
}

#[test]
fn an_id_that_is_not_a_yid_quarantines() {
    for id in [
        "page-one",
        "4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1",
        "short",
        "thirteenchars",
    ] {
        let source = page("- Text\n").replace(DOCUMENT, id);

        assert!(
            parse(source.as_bytes()).is_err(),
            "`{id}` is not twelve base64url characters"
        );
    }
}

#[test]
fn a_node_id_that_is_not_a_yid_quarantines() {
    let source = page("- Text <!-- yid: not-a-yid -->\n");

    assert!(parse(source.as_bytes()).is_err());
}

/// The closing marker is the dangerous half: it starts with `>`, so without a
/// rule of its own it reads as an ordinary note line and a git-merged file
/// would be accepted with someone else's text quietly folded in.
#[test]
fn a_git_conflict_marker_quarantines() {
    assert!(parse(page("- Text\n>>>>>>> theirs\n").as_bytes()).is_err());
    assert!(parse(page("<<<<<<< HEAD\n- Text\n").as_bytes()).is_err());
}

#[test]
fn an_unexplainable_line_quarantines() {
    let source = page("Loose prose that is neither a bullet nor a note.\n");

    assert!(parse(source.as_bytes()).is_err());
}

#[test]
fn a_duplicate_node_id_quarantines() {
    let source = page(&format!(
        "- One <!-- yid: {ONE} -->\n- Two <!-- yid: {ONE} -->\n"
    ));

    assert!(parse(source.as_bytes()).is_err());
}

/// A yid is case sensitive where a uuid was not: `Nd…1` and `nd…1` are two
/// different blocks, and treating them as one would refuse a legal vault.
#[test]
fn two_ids_differing_only_in_case_are_two_nodes() {
    let source = page(&format!(
        "- One <!-- yid: {ONE} -->\n- Two <!-- yid: {} -->\n",
        ONE.to_lowercase()
    ));

    assert_eq!(nodes(&source).len(), 2);
}

#[test]
fn a_duplicate_frontmatter_key_quarantines() {
    let source = page("- Text\n").replace(
        &format!("id: {DOCUMENT}\n"),
        &format!("id: {DOCUMENT}\nid: {DOCUMENT}\n"),
    );

    assert!(parse(source.as_bytes()).is_err());
}

#[test]
fn an_image_document_root_quarantines() {
    let source = "---\nkind: yonalist-notes\nformat_version: 1\nid: PrJects00001\n---\n\
                  # ![shot.png](assets/shot-9f3a1c8e2044.png)\n\n";

    assert!(
        parse(source.as_bytes()).is_err(),
        "a heading has nowhere to put an image's metadata"
    );
}

#[test]
fn an_id_key_in_the_trash_quarantines() {
    let source = "---\nkind: yonalist-trash\nformat_version: 1\nid: PrJects00001\n---\n";

    assert!(parse(source.as_bytes()).is_err());
}

#[test]
fn an_oversized_file_quarantines() {
    let padded = format!("{}{}", page("- Text\n"), "x".repeat(17 * 1024 * 1024));

    assert!(parse(padded.as_bytes()).is_err());
}

#[test]
fn a_document_deeper_than_the_cap_quarantines() {
    let mut body = String::new();
    for depth in 0..130 {
        body.push_str(&format!("{}- Deep\n", "  ".repeat(depth)));
    }

    assert!(parse(page(&body).as_bytes()).is_err());
}

#[test]
fn a_document_with_more_nodes_than_the_cap_quarantines() {
    let body = "- Text\n".repeat(20_001);

    assert!(parse(page(&body).as_bytes()).is_err());
}

// ------------------------------------------------------------ attachments

/// Every shared attachment sits in the vault's root `assets/`, which from a
/// page is `../assets/` and from a split document `../../assets/`. A trash
/// image is always `../assets/`. Refusing those would make every trash file
/// holding an image unreadable.
#[test]
fn a_link_climbing_to_the_root_assets_folder_is_accepted() {
    let source = format!(
        "---\nkind: yonalist-trash\nformat_version: 1\n---\n\
         - ![shot.png](../assets/shot-9f3a1c8e2044.png) <!-- yid: {ONE} -->\n"
    );

    assert_eq!(
        nodes(&source).len(),
        1,
        "a deleted image still has to come back"
    );
}

#[test]
fn a_link_that_is_not_an_asset_quarantines() {
    for path in [
        "../../outside/shot.png",
        "README.md",
        "assets/../README.md",
        "assets/deep/shot.png",
    ] {
        let source = page(&format!("- ![shot.png]({path}) <!-- yid: {ONE} -->\n"));

        assert!(
            parse(source.as_bytes()).is_err(),
            "`{path}` is not a shape this format writes"
        );
    }
}

#[test]
fn an_image_with_an_unreadable_extension_quarantines() {
    let source = page(&format!(
        "- ![shot.bmp](assets/shot-9f3a1c8e2044.bmp) <!-- yid: {ONE} -->\n"
    ));

    assert!(parse(source.as_bytes()).is_err());
}

/// A person writing an image line by hand leaves the alt text out — every
/// markdown editor does. The name is not decoration: a picture without one
/// has no metadata a row can be built from, and the note draws a placeholder
/// over bytes it has. The file already says what the file is called.
#[test]
fn an_image_line_with_no_alt_takes_its_file_name() {
    let parsed = nodes(&page("- ![](assets/shot-9f3a1c8e2044.png)\n"));

    let NodeBody::Image(image) = &parsed[0].body else {
        panic!("an image");
    };
    assert_eq!(image.original_name, "shot-9f3a1c8e2044.png");
}

#[test]
fn an_image_takes_its_measurements_from_the_footer() {
    let parsed = nodes(&page_with_state(
        &format!("- ![shot.png](assets/shot-9f3a1c8e2044.png) <!-- yid: {ONE} -->\n"),
        &format!(
            "{{\"{ONE}\":{{\"width\":268,\"pixel_width\":870,\"pixel_height\":602,\
             \"byte_size\":38471,\"asset_hash\":\"{HASH}\"}}}}"
        ),
    ));

    let NodeBody::Image(image) = &parsed[0].body else {
        panic!("an image");
    };
    assert_eq!(image.display_width, 268);
    assert_eq!((image.pixel_width, image.pixel_height), (870, 602));
    assert_eq!(image.byte_size, 38471);
    assert_eq!(image.asset_hash, HASH);
}

/// The bounds an image has to satisfy are facts about the format, so a footer
/// that breaks one is refused here — where the answer is a quarantine with a
/// reason — rather than surviving into a merge that dies on a constraint.
#[test]
fn an_image_measured_outside_the_formats_bounds_quarantines() {
    for state in [
        "\"byte_size\":20971521",
        "\"pixel_width\":0,\"pixel_height\":10,\"byte_size\":4",
    ] {
        let source = page_with_state(
            &format!("- ![shot.png](assets/shot-9f3a1c8e2044.png) <!-- yid: {ONE} -->\n"),
            &format!("{{\"{ONE}\":{{{state}}}}}"),
        );

        assert!(
            parse(source.as_bytes()).is_err(),
            "`{state}` is outside what this format writes"
        );
    }
}

// ----------------------------------------------------------- round trips

/// Rendering what was parsed has to land on the same bytes, or the two halves
/// disagree and every read of a file would look like an edit to the device that
/// wrote it.
#[test]
fn every_golden_survives_a_parse_render_round_trip() {
    for (name, source) in [
        ("page", include_str!("../fixtures/page.md")),
        ("trash", include_str!("../fixtures/trash.md")),
        ("split", include_str!("../fixtures/split.md")),
        ("home", include_str!("../fixtures/home.md")),
        (
            "representative",
            include_str!("../fixtures/representative.md"),
        ),
    ] {
        let parsed = accepted(source);
        let rendered = notes_sync::render::render(&parsed).expect("render");

        assert_eq!(
            String::from_utf8(rendered).expect("utf-8"),
            source,
            "{name} did not come back the way it went in"
        );
    }
}

#[test]
fn an_unknown_frontmatter_key_survives_a_parse_render_round_trip() {
    round_trip(&format!(
        "---\nkind: yonalist-notes\nformat_version: 1\nid: {DOCUMENT}\nfuture_key: kept\n\
         ---\n# Projects\n\n- Text <!-- yid: {ONE} -->\n\
         \n<!-- yonalist\n{{\"state_hash\":\"{HASH}\",\"base\":\"\",\"state\":{{}}}}\n-->\n"
    ));
}

/// A newer device writes state keys this version has no meaning for. Without a
/// place to keep them, reading its file and writing it back would silently
/// strip whatever it knew that this build does not.
#[test]
fn an_unknown_state_key_survives_a_parse_render_round_trip() {
    round_trip(&page_with_state(
        &format!("- Text <!-- yid: {ONE} -->\n"),
        &format!("{{\"{ONE}\":{{\"starred\":true,\"future\":\"value\"}}}}"),
    ));
}

/// Text holding the two characters `\n` is not a newline. Unescaping has to
/// read left to right so the backslash before it is consumed first — otherwise
/// the file comes back rewritten with a line break the user never typed.
#[test]
fn a_literal_backslash_n_in_text_is_not_a_newline() {
    let source = page_with_state(&format!("- a\\\\nb <!-- yid: {ONE} -->\n"), "{}");
    let parsed = nodes(&source);

    assert_eq!(parsed[0].body, NodeBody::Text("a\\nb".to_owned()));
    round_trip(&source);
}

/// The goldens only cover the states the design drew. This walks the space they
/// left out — notes, numbered runs, escape-heavy text, empty titles, climbing
/// asset links — and holds the one property that matters: writing what was read
/// has to land on the same bytes, or every read looks like an edit.
#[test]
fn a_document_holding_every_shape_survives_two_round_trips() {
    let awkward = [
        "plain",
        "",
        r"a\nb",
        "punctuation .,:;!?*_`~(){}",
        "&amp; &lt; already-looking text",
        "trailing space ",
        "한글과 emoji 🌱",
        "<!-- not a comment -->",
        "<!-- yid: looks like ours -->",
        "- opens like a bullet",
        "3. opens like a number",
        "# opens like a heading",
        "> opens like a quote",
        "[ ] opens like a checkbox",
        // A real newline inside one node's text: the renderer folds it to the
        // two characters `\n`, which is exactly what the literal above must
        // not be confused with.
        "two\nlines",
    ];
    let mut document = notes_sync::document::PageDocument {
        id: DocumentId::Node(DOCUMENT.to_owned()),
        parent: None,
        sort_key: None,
        max_hlc: String::new(),
        state_hash: HASH.to_owned(),
        base: String::new(),
        root: notes_sync::document::DocumentRoot {
            title: String::new(),
            note: "root note\n\nwith a gap".to_owned(),
            ..Default::default()
        },
        nodes: Vec::new(),
        unknown_frontmatter: Vec::new(),
    };
    for (index, text) in awkward.iter().enumerate() {
        document.nodes.push(notes_sync::document::DocumentNode {
            id: format!("Nd{:010}", index + 1),
            hlc: String::new(),
            body: NodeBody::Text((*text).to_owned()),
            note: format!("note for {index}\n\nsecond line"),
            marker: Marker::Ordered(index as i64 + 1),
            collapsed: true,
            completed: false,
            starred: true,
            from: None,
            place: None,
            unknown_tokens: Vec::new(),
            unknown_state: Default::default(),
            children: Vec::new(),
        });
    }

    let once = notes_sync::render::render(&VaultFile::Page(document)).expect("render");
    let text = String::from_utf8(once.clone()).expect("utf-8");
    round_trip(&text);
}
