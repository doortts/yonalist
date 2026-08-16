//! Section 5 of the spec, row by row. What the parser accepts it accepts for a
//! stated reason, and what it rejects it rejects whole — a document that is
//! half applied is worse than one that is skipped, because nothing downstream
//! can tell which half it got.

use notes_sync::document::{DocumentId, Marker, NodeBody, VaultFile};
use notes_sync::parse::parse;

fn page(body: &str) -> String {
    format!(
        "---\nkind: yonalist-notes\nformat_version: 1\n\
         id: 4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1\n\
         max_hlc: 0swkd7qz9-00-a3f2\nroot_hlc: 0swkd7qz5-00-a3f2\n---\n# Projects\n\n{body}"
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
fn an_unparsable_hlc_becomes_empty_and_loses_lww() {
    let parsed = nodes(&page(
        "- Thought <!-- yid: 8a201f33-0000-4c91-8d02-000000000001 t: too-new -->\n",
    ));

    assert_eq!(
        parsed[0].hlc, "",
        "an unreadable stamp loses every comparison rather than winning one"
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
fn a_bare_dash_line_is_a_plain_bullet() {
    let parsed = nodes(&page("- Just text\n"));

    assert_eq!(parsed[0].marker, Marker::Bullet);
    assert!(
        !parsed[0].completed,
        "no checkbox means nothing was checked"
    );
}

#[test]
fn a_checkbox_line_is_always_a_todo() {
    let parsed = nodes(&page("- [ ] Open\n- [x] Closed\n"));

    assert_eq!(parsed[0].marker, Marker::Todo);
    assert!(!parsed[0].completed);
    assert_eq!(parsed[1].marker, Marker::Todo);
    assert!(parsed[1].completed);
}

#[test]
fn a_completed_plain_bullet_round_trips_through_the_done_token() {
    let parsed = nodes(&page(
        "- Done thing <!-- yid: 8a201f33-0000-4c91-8d02-000000000001 t: 0swkd7qz6-00-a3f2 done -->\n",
    ));

    assert_eq!(parsed[0].marker, Marker::Bullet);
    assert!(
        parsed[0].completed,
        "the comment carries it, not the prefix"
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
}

#[test]
fn crlf_normalizes_to_lf() {
    let source = page("- One\n  - Two\n").replace('\n', "\r\n");
    let parsed = nodes(&source);

    assert_eq!(parsed[0].body, NodeBody::Text("One".to_owned()));
    assert_eq!(parsed[0].children.len(), 1);
}

#[test]
fn a_colon_token_swallows_the_next_word() {
    let parsed = nodes(&page(
        "- Text <!-- yid: 8a201f33-0000-4c91-8d02-000000000001 t: 0swkd7qz6-00-a3f2 foo: collapsed -->\n",
    ));

    assert!(
        !parsed[0].collapsed,
        "the word after an unknown `key:` is its value, not a state token"
    );
    assert_eq!(parsed[0].unknown_tokens, vec!["foo:", "collapsed"]);
}

#[test]
fn the_home_document_accepts_the_literal_root_id() {
    let source = "---\nkind: yonalist-notes\nformat_version: 1\nid: root\n\
                  max_hlc: 0swkd7qz6-00-a3f2\nroot_hlc: 0swkd7qz4-00-a3f2\n---\n# Home\n\n";
    let VaultFile::Page(parsed) = accepted(source) else {
        panic!("a page");
    };

    assert_eq!(parsed.id, DocumentId::Home);
}

#[test]
fn a_missing_max_hlc_is_recomputed_from_content() {
    let source = "---\nkind: yonalist-notes\nformat_version: 1\n\
                  id: 4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1\nroot_hlc: 0swkd7qz5-00-a3f2\n---\n\
                  # Projects\n\n\
                  - Later <!-- yid: 8a201f33-0000-4c91-8d02-000000000001 t: 0swkd7qz9-00-a3f2 -->\n";
    let VaultFile::Page(parsed) = accepted(source) else {
        panic!("a page");
    };

    assert_eq!(
        parsed.max_hlc, "0swkd7qz9-00-a3f2",
        "the content knows the answer, so a missing key is not a reason to skip the file"
    );
}

/// A hand editor can write state onto a split line, and the format has no way
/// to stop them. What it can do is refuse to believe it: the child document's
/// frontmatter is the one authority, so a merge cannot depend on which file it
/// read first.
#[test]
fn a_split_line_carries_no_state_and_grants_none() {
    let parsed = nodes(&page(
        "- [x] [Archive](Archive-9d3f21b8c440/README.md) \
         <!-- yid: 9d3f21b8-c440-4c91-8d02-2e77a05fb163 t: 0swkd7qzd-00-a3f2 \
         star todo split collapsed -->\n",
    ));

    assert_eq!(
        parsed[0].body,
        NodeBody::Split {
            title: "Archive".to_owned(),
            path: "Archive-9d3f21b8c440/README.md".to_owned()
        }
    );
    assert_eq!(parsed[0].marker, Marker::Bullet);
    assert!(!parsed[0].starred && !parsed[0].collapsed && !parsed[0].completed);
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
fn a_foreign_format_version_quarantines() {
    let source = page("- Text\n").replace("format_version: 1", "format_version: 4");

    assert!(parse(source.as_bytes()).is_err());
}

#[test]
fn a_missing_topic_id_quarantines() {
    let source = page("- Text\n").replace("id: 4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1\n", "");

    assert!(parse(source.as_bytes()).is_err());
}

#[test]
fn a_non_uuid_id_quarantines() {
    let source = page("- Text\n").replace("4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1", "page-one");

    assert!(
        parse(source.as_bytes()).is_err(),
        "every id is a UUID; the literal root is the format's one exception"
    );
}

/// Whether a document sitting somewhere other than the vault root may call
/// itself `root` is not a question the parser can answer — it never learns the
/// path. Reading it as home is right here, and the loader is what refuses one
/// found in the wrong place.
#[test]
fn the_literal_root_id_reads_as_home_wherever_it_is_found() {
    let source = page("- Text\n").replace("4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1", "root");
    let VaultFile::Page(parsed) = accepted(&source) else {
        panic!("a page");
    };

    assert_eq!(parsed.id, DocumentId::Home);
}

/// The closing marker is the dangerous half: it starts with `>`, so without a
/// rule of its own it reads as an ordinary note line and a git-merged file
/// would be accepted with someone else's text quietly folded in.
#[test]
fn a_git_conflict_marker_quarantines() {
    let source = page("- Text\n>>>>>>> theirs\n");

    assert!(
        parse(source.as_bytes()).is_err(),
        "a merged-by-git file is not a file this format can reason about"
    );
    assert!(parse(page("<<<<<<< HEAD\n- Text\n").as_bytes()).is_err());
}

#[test]
fn an_unexplainable_line_quarantines() {
    let source = page("Loose prose that is neither a bullet nor a note.\n");

    assert!(parse(source.as_bytes()).is_err());
}

#[test]
fn a_duplicate_node_id_quarantines() {
    let source = page(
        "- One <!-- yid: 8a201f33-0000-4c91-8d02-000000000001 t: 0swkd7qz6-00-a3f2 -->\n\
         - Two <!-- yid: 8A201F33-0000-4C91-8D02-000000000001 t: 0swkd7qz7-00-a3f2 -->\n",
    );

    assert!(
        parse(source.as_bytes()).is_err(),
        "the same id twice under different casing is still the same id"
    );
}

#[test]
fn a_duplicate_frontmatter_key_quarantines() {
    let source = page("- Text\n").replace(
        "root_hlc: 0swkd7qz5-00-a3f2\n",
        "root_hlc: 0swkd7qz5-00-a3f2\nroot_hlc: 0swkd7qz6-00-a3f2\n",
    );

    assert!(parse(source.as_bytes()).is_err());
}

#[test]
fn a_duplicate_comment_token_quarantines() {
    let source = page(
        "- Text <!-- yid: 8a201f33-0000-4c91-8d02-000000000001 t: 0swkd7qz6-00-a3f2 star star -->\n",
    );

    assert!(parse(source.as_bytes()).is_err());
}

#[test]
fn an_image_document_root_quarantines() {
    let source = "---\nkind: yonalist-notes\nformat_version: 1\n\
                  id: 4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1\nmax_hlc: 0swkd7qz9-00-a3f2\n\
                  root_hlc: 0swkd7qz5-00-a3f2\n---\n\
                  # ![shot.png](assets/shot-9f3a1c8e2044.png)\n\n";

    assert!(
        parse(source.as_bytes()).is_err(),
        "a heading has nowhere to put an image's metadata"
    );
}

#[test]
fn a_link_escaping_the_assets_folder_quarantines() {
    let source = page(
        "- ![shot.png](../../outside/shot.png) <!-- ya: w: 320 px: 10x10 bytes: 4 --> \
         <!-- yid: 8a201f33-0000-4c91-8d02-000000000001 t: 0swkd7qz6-00-a3f2 -->\n",
    );

    assert!(parse(source.as_bytes()).is_err());
}

#[test]
fn a_from_token_in_a_page_quarantines() {
    let source = page(
        "- Text <!-- yid: 8a201f33-0000-4c91-8d02-000000000001 t: 0swkd7qz6-00-a3f2 \
         from: root@4294967296 -->\n",
    );

    assert!(
        parse(source.as_bytes()).is_err(),
        "where a node was deleted from only means something in the trash"
    );
}

#[test]
fn an_id_key_in_the_trash_quarantines() {
    let source = "---\nkind: yonalist-trash\nformat_version: 1\n\
                  id: 4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1\nmax_hlc: 0swkd7qz9-00-a3f2\n---\n";

    assert!(parse(source.as_bytes()).is_err());
}

#[test]
fn an_oversized_file_quarantines() {
    let mut source = page("");
    source.push_str(&"- Text\n".repeat(1));
    let padded = format!("{source}{}", "x".repeat(17 * 1024 * 1024));

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
fn unknown_fields_survive_a_parse_render_round_trip() {
    let source = "---\nkind: yonalist-notes\nformat_version: 1\n\
                  id: 4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1\nmax_hlc: 0swkd7qz9-00-a3f2\n\
                  root_hlc: 0swkd7qz5-00-a3f2\nfuture_key: kept\n---\n# Projects\n\n\
                  - Text <!-- yid: 8a201f33-0000-4c91-8d02-000000000001 \
                  t: 0swkd7qz9-00-a3f2 star future: value lone -->\n";

    let once = notes_sync::render::render(&accepted(source)).expect("render");
    let twice = notes_sync::render::render(&accepted(std::str::from_utf8(&once).expect("utf-8")))
        .expect("render");

    assert_eq!(
        String::from_utf8(once.clone()).expect("utf-8"),
        source,
        "a key and a token this version has no meaning for still belong to whoever wrote them"
    );
    assert_eq!(once, twice, "and they land in the same place every time");
}

/// Every shared attachment sits in the vault's root `assets/`, which from a
/// page is `../assets/` and from a split document `../../assets/`. A trash
/// image is always `../assets/`. Refusing those would make every trash file
/// holding an image unreadable.
#[test]
fn a_link_climbing_to_the_root_assets_folder_is_accepted() {
    let source = "---\nkind: yonalist-trash\nformat_version: 1\n\
                  max_hlc: 0swkd7qzc-00-a3f2\n---\n\
                  - ![shot.png](../assets/shot-9f3a1c8e2044.png) \
                  <!-- ya: w: 320 px: 10x10 bytes: 4 --> \
                  <!-- yid: 8a201f33-0000-4c91-8d02-000000000005 t: 0swkd7qza-00-a3f2 -->\n";

    let parsed = nodes(source);

    assert_eq!(parsed.len(), 1, "a deleted image still has to come back");
}

#[test]
fn a_link_that_is_not_an_asset_quarantines() {
    for path in ["README.md", "assets/../README.md", "assets/deep/shot.png"] {
        let source = page(&format!(
            "- ![shot.png]({path}) <!-- ya: w: 320 px: 10x10 bytes: 4 --> \
             <!-- yid: 8a201f33-0000-4c91-8d02-000000000001 t: 0swkd7qz6-00-a3f2 -->\n"
        ));

        assert!(
            parse(source.as_bytes()).is_err(),
            "`{path}` is not a shape this format writes"
        );
    }
}

/// Text holding the two characters `\n` is not a newline. Unescaping has to
/// read left to right so the backslash before it is consumed first — otherwise
/// the file comes back rewritten with a line break the user never typed.
#[test]
fn a_literal_backslash_n_in_text_is_not_a_newline() {
    let source =
        page("- a\\\\nb <!-- yid: 8a201f33-0000-4c91-8d02-000000000001 t: 0swkd7qz9-00-a3f2 -->\n");

    let parsed = nodes(&source);

    assert_eq!(parsed[0].body, NodeBody::Text("a\\nb".to_owned()));
    let rendered = notes_sync::render::render(&accepted(&source)).expect("render");
    assert_eq!(String::from_utf8(rendered).expect("utf-8"), source);
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
    let parsed = nodes(&page(
        "- Text <!-- yid: 8a201f33-0000-4c91-8d02-000000000001 t: 0swkd7qz6-00-a3f2 --> \n",
    ));

    assert_eq!(parsed[0].id, "8a201f33-0000-4c91-8d02-000000000001");
}

/// An image line a person added by hand has no node comment yet. The merge
/// issues the id; refusing the line would lose the image instead.
#[test]
fn an_image_line_without_a_node_comment_is_accepted() {
    let parsed = nodes(&page(
        "- ![shot.png](assets/shot-9f3a1c8e2044.png) <!-- ya: w: 320 px: 10x10 bytes: 4 -->\n",
    ));

    assert_eq!(parsed.len(), 1);
    assert!(matches!(parsed[0].body, NodeBody::Image(_)));
    assert_eq!(parsed[0].id, "");
}

/// A stamp the content cannot account for is exactly what §4.2 calls
/// disagreeing with the content. Keeping it would let one hand edit push the
/// boot clock into the future and future-stamp every later local edit.
#[test]
fn a_stated_max_hlc_the_content_cannot_account_for_is_recomputed() {
    let source =
        page("- Text <!-- yid: 8a201f33-0000-4c91-8d02-000000000001 t: 0swkd7qz6-00-a3f2 -->\n")
            .replace("max_hlc: 0swkd7qz9-00-a3f2", "max_hlc: zzzzzzzzz-zz-ffff");
    let VaultFile::Page(parsed) = accepted(&source) else {
        panic!("a page");
    };

    assert_eq!(parsed.max_hlc, "0swkd7qz6-00-a3f2");
}

#[test]
fn an_unknown_ya_token_does_not_shift_the_ones_after_it() {
    let parsed = nodes(&page(
        "- ![shot.png](assets/shot-9f3a1c8e2044.png) \
         <!-- ya: w: 320 future px: 10x10 bytes: 4 --> \
         <!-- yid: 8a201f33-0000-4c91-8d02-000000000001 t: 0swkd7qz6-00-a3f2 -->\n",
    ));

    let NodeBody::Image(image) = &parsed[0].body else {
        panic!("an image");
    };
    assert_eq!((image.pixel_width, image.pixel_height), (10, 10));
    assert_eq!(image.byte_size, 4);
}

#[test]
fn a_document_with_more_nodes_than_the_cap_quarantines() {
    let body = "- Text\n".repeat(20_001);

    assert!(parse(page(&body).as_bytes()).is_err());
}

/// The goldens only cover the states the spec drew. This walks the space they
/// left out — notes, ordered markers, stars, escape-heavy text, empty titles,
/// climbing asset links — and holds the one property that matters: writing what
/// was read has to land on the same bytes, or every read looks like an edit.
#[test]
fn a_document_holding_every_shape_survives_two_round_trips() {
    let awkward = [
        "plain",
        "",
        r"a\nb",
        "punctuation .,:;!?*_`~[](){}#+-",
        "&amp; &lt; &gt; already-looking text",
        "trailing space ",
        "  leading spaces",
        "한글과 emoji 🌱",
        "<!-- not a comment -->",
        // A real newline inside one node's text: the renderer folds it to the
        // two characters `\n`, which is exactly what the literal above must
        // not be confused with.
        "two\nlines",
    ];
    let mut body = String::new();
    for (index, text) in awkward.iter().enumerate() {
        body.push_str(&format!(
            "- {} <!-- yid: 8a201f33-0000-4c91-8d02-{:012} t: 0swkd7qz6-00-a3f2 \
             star ordered: {} collapsed -->\n",
            escaped(text),
            index + 1,
            index as i64 - 3
        ));
        body.push_str(&format!("  > note for {}\n  >\n  > second line\n", index));
    }
    body.push_str(
        "- ![shot \\.png](../assets/shot-9f3a1c8e2044.png) \
         <!-- ya: w: 320 px: 10x10 bytes: 4 --> \
         <!-- yid: 8a201f33-0000-4c91-8d02-000000000099 t: 0swkd7qz6-00-a3f2 -->\n",
    );
    let source = page(&body).replace("max_hlc: 0swkd7qz9-00-a3f2", "max_hlc: 0swkd7qz6-00-a3f2");

    let once = notes_sync::render::render(&accepted(&source)).expect("render");
    let text = String::from_utf8(once.clone()).expect("utf-8");
    let twice = notes_sync::render::render(&accepted(&text)).expect("render");

    assert_eq!(
        text, source,
        "the file came back different from how it went in"
    );
    assert_eq!(once, twice, "and a second trip has to change nothing");
}

/// Matches the renderer's escaping so the fixture above states a document the
/// renderer would actually write.
fn escaped(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '&' => "&amp;".to_owned(),
            '<' => "&lt;".to_owned(),
            '>' => "&gt;".to_owned(),
            '\n' => "\\n".to_owned(),
            other if other.is_ascii_punctuation() => format!("\\{other}"),
            other => other.to_string(),
        })
        .collect()
}
