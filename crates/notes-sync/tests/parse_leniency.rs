//! Section 5 of the spec, row by row. What the parser accepts it accepts for a
//! stated reason, and what it rejects it rejects whole — a document that is
//! half applied is worse than one that is skipped, because nothing downstream
//! can tell which half it got.

use notes_sync::document::{DocumentId, Marker, NodeBody, VaultFile};
use notes_sync::parse::parse;

fn page(body: &str) -> String {
    format!(
        "---\nkind: yonalist-notes\nformat_version: 1\n\
         id: PrJects00001\n\
         max_hlc: 0swkd7qz9-00-a3f2\nupdated: 2041-10-11T06:19:09Z\nroot_hlc: 0swkd7qz5-00-a3f2\n---\n# Projects\n\n{body}"
    )
}

/// The same page with the block that carries its bookkeeping, in the shape and
/// the place the renderer writes it. Each entry is one footer line without its
/// newline: `"yid: … t: … star"`.
///
/// The blank line in front is the renderer's own condition, repeated here so a
/// document a test states by hand is byte-identical to the one the renderer would
/// have written for it — every round-trip assertion below rests on that.
fn page_with_footer(body: &str, entries: &[&str]) -> String {
    let mut source = page(body);
    if !source.ends_with("\n\n") {
        source.push('\n');
    }
    source.push_str("<!-- yonalist\n");
    for entry in entries {
        source.push_str(entry);
        source.push('\n');
    }
    source.push_str("-->\n");
    source
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
    let parsed = nodes(&page_with_footer(
        "- Thought <!-- yid: Nd0000000001 -->\n",
        &["yid: Nd0000000001 t: too-new"],
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
    let parsed = nodes(&page_with_footer(
        "- Done thing <!-- yid: Nd0000000001 -->\n",
        &["yid: Nd0000000001 t: 0swkd7qz6-00-a3f2 done"],
    ));

    assert_eq!(parsed[0].marker, Marker::Bullet);
    assert!(
        parsed[0].completed,
        "the footer carries it, because a plain bullet has no checkbox to draw"
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
    let parsed = nodes(&page_with_footer(
        "- Text <!-- yid: Nd0000000001 -->\n",
        &["yid: Nd0000000001 t: 0swkd7qz6-00-a3f2 foo: collapsed"],
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
                  max_hlc: 0swkd7qz6-00-a3f2\nupdated: 2041-10-11T06:19:09Z\nroot_hlc: 0swkd7qz4-00-a3f2\n---\n# Home\n\n";
    let VaultFile::Page(parsed) = accepted(source) else {
        panic!("a page");
    };

    assert_eq!(parsed.id, DocumentId::Home);
}

#[test]
fn a_missing_max_hlc_is_recomputed_from_content() {
    let source = "---\nkind: yonalist-notes\nformat_version: 1\n\
                  id: PrJects00001\nroot_hlc: 0swkd7qz5-00-a3f2\n---\n\
                  # Projects\n\n\
                  - Later <!-- yid: Nd0000000001 -->\n\n\
                  <!-- yonalist\n\
                  yid: Nd0000000001 t: 0swkd7qz9-00-a3f2\n\
                  -->\n";
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
    let parsed = nodes(&page_with_footer(
        "- [x] [Archive](Archive-Archive00001/README.md) \
         <!-- yid: Archive00001 -->\n",
        &["yid: Archive00001 t: 0swkd7qzd-00-a3f2 \
             star todo split collapsed"],
    ));

    assert_eq!(
        parsed[0].body,
        NodeBody::Split {
            title: "Archive".to_owned(),
            path: "Archive-Archive00001/README.md".to_owned()
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
    let source = page("- Text\n").replace("id: PrJects00001\n", "");

    assert!(parse(source.as_bytes()).is_err());
}

#[test]
fn a_non_block_id_quarantines() {
    for wrong in [
        // Not twelve characters.
        "page-one",
        // Twelve characters, but not from the alphabet a folder name and a
        // Markdown comment can both carry.
        "page/one0001",
        // The shape this format used to use. It is refused now, which is what
        // stops a file an older build wrote from being read as though its ids
        // meant anything here.
        "4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1",
    ] {
        let source = page("- Text\n").replace("PrJects00001", wrong);

        assert!(
            parse(source.as_bytes()).is_err(),
            "`{wrong}` is not a block id, and the literal root is the format's one \
             exception to that"
        );
    }
}

/// Whether a document sitting somewhere other than the vault root may call
/// itself `root` is not a question the parser can answer — it never learns the
/// path. Reading it as home is right here, and the loader is what refuses one
/// found in the wrong place.
#[test]
fn the_literal_root_id_reads_as_home_wherever_it_is_found() {
    let source = page("- Text\n").replace("PrJects00001", "root");
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

/// Two lines claiming one block leave every reader downstream guessing which of
/// them the state belongs to, so the file is refused whole.
///
/// This used to state the rule about casing instead — a UUID meant the same thing
/// in either case, so two spellings were one id. A `yid` is not case-insensitive:
/// `Nd0000000001` and `nd0000000001` name two blocks, which is why `tree.rs`
/// stopped folding case before deriving children. So the claim this locks is the
/// one that survived the change: an id repeated exactly is a duplicate.
#[test]
fn a_duplicate_node_id_quarantines() {
    let source = page_with_footer(
        "- One <!-- yid: Nd0000000001 -->\n\
         - Two <!-- yid: Nd0000000001 -->\n",
        &["yid: Nd0000000001 t: 0swkd7qz6-00-a3f2"],
    );

    assert!(
        parse(source.as_bytes()).is_err(),
        "one block cannot be two lines"
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
fn a_duplicate_token_quarantines() {
    let footer = page_with_footer(
        "- Text <!-- yid: Nd0000000001 -->\n",
        &["yid: Nd0000000001 t: 0swkd7qz6-00-a3f2 star star"],
    );

    assert!(
        parse(footer.as_bytes()).is_err(),
        "one state has one spelling, so a second one is a file nobody can read for sure"
    );

    let line = page(
        "- Text <!-- yid: Nd0000000001 \
         yid: Nd0000000002 -->\n",
    );

    assert!(
        parse(line.as_bytes()).is_err(),
        "and a body line names one block, not two"
    );
}

/// §4's malformed rows. A footer half read is worse than none: some blocks would
/// come back holding somebody else's state and nothing downstream could tell
/// which, so the file is refused whole.
#[test]
fn a_footer_that_is_not_one_readable_block_quarantines() {
    let id = "Nd0000000001";
    let body = format!("- Text <!-- yid: {id} -->\n");
    let entry = format!("yid: {id} t: 0swkd7qz6-00-a3f2");

    for (what, source) in [
        (
            "a block that never closes leaves it unsaid where the body resumed",
            format!("{}\n<!-- yonalist\n{entry}\n", page(&body)),
        ),
        (
            "two blocks are two answers for one",
            format!(
                "{}\n<!-- yonalist\n{entry}\n-->\n",
                page_with_footer(&body, &[&entry])
            ),
        ),
        (
            "a line naming no block would have its state guessed onto somebody else's",
            page_with_footer(&body, &["t: 0swkd7qz6-00-a3f2 star"]),
        ),
        (
            "one block stated twice",
            page_with_footer(&body, &[&entry, &entry]),
        ),
    ] {
        assert!(parse(source.as_bytes()).is_err(), "{what}");
    }
}

/// A hand editor who deletes a bullet leaves its footer line behind, which is a
/// perfectly normal state to find a file in. There is nowhere in a document to
/// keep state for a block no line claims, and dropping it is what makes the trip
/// stable: the parse loses it and the render never writes it, so the second trip
/// is the same bytes as the first.
#[test]
fn a_footer_entry_for_a_line_that_is_gone_is_dropped() {
    let source = page_with_footer(
        "- Text <!-- yid: Nd0000000001 -->\n",
        &[
            "yid: Nd0000000001 t: 0swkd7qz6-00-a3f2",
            "yid: Nd0000000002 t: 0swkd7qz7-00-a3f2 star",
        ],
    );

    let parsed = nodes(&source);
    assert_eq!(
        parsed.len(),
        1,
        "the body says which blocks a document holds"
    );

    let once = String::from_utf8(notes_sync::render::render(&accepted(&source)).expect("render"))
        .expect("utf-8");
    assert!(
        !once.contains("Nd0000000002"),
        "an entry no line claims has nowhere to live: {once}"
    );

    let twice = String::from_utf8(notes_sync::render::render(&accepted(&once)).expect("render"))
        .expect("utf-8");
    assert_eq!(twice, once, "and the trip after that changes nothing");
}

/// The rule a line whose `t:` was deleted already gets, widened to a whole
/// document. Refusing instead would quarantine a file over a block somebody
/// trimmed off the end; reading it as unstamped loses it to the database, and the
/// next export writes the canonical form back.
#[test]
fn a_document_without_a_footer_reads_as_unstamped() {
    let body = "- Text <!-- yid: Nd0000000001 -->\n";

    for (what, source) in [
        ("no footer at all", page(body)),
        ("a footer holding nothing", page_with_footer(body, &[])),
    ] {
        let parsed = nodes(&source);

        assert_eq!(parsed.len(), 1, "{what}: the body is still the body");
        assert_eq!(
            parsed[0].id, "Nd0000000001",
            "{what}: and the line still says which block it is"
        );
        assert_eq!(
            parsed[0].hlc, "",
            "{what}: with no stamp, so it loses every comparison rather than winning one"
        );
        assert_eq!(parsed[0].marker, Marker::Bullet, "{what}");
        assert!(
            !parsed[0].starred && !parsed[0].collapsed && !parsed[0].completed,
            "{what}: every state falls back to its default"
        );
    }
}

#[test]
fn an_image_document_root_quarantines() {
    let source = "---\nkind: yonalist-notes\nformat_version: 1\n\
                  id: PrJects00001\nmax_hlc: 0swkd7qz9-00-a3f2\n\
                  root_hlc: 0swkd7qz5-00-a3f2\n---\n\
                  # ![shot.png](assets/shot-9f3a1c8e2044.png)\n\n";

    assert!(
        parse(source.as_bytes()).is_err(),
        "a heading has nowhere to put an image's metadata"
    );
}

#[test]
fn a_link_escaping_the_assets_folder_quarantines() {
    let source = page_with_footer(
        "- ![shot.png](../../outside/shot.png) \
         <!-- yid: Nd0000000001 -->\n",
        &["yid: Nd0000000001 t: 0swkd7qz6-00-a3f2 \
             w: 320 px: 10x10 bytes: 4"],
    );

    assert!(parse(source.as_bytes()).is_err());
}

#[test]
fn a_from_token_in_a_page_quarantines() {
    let source = page_with_footer(
        "- Text <!-- yid: Nd0000000001 -->\n",
        &["yid: Nd0000000001 t: 0swkd7qz6-00-a3f2 \
             from: root@4294967296"],
    );

    assert!(
        parse(source.as_bytes()).is_err(),
        "where a node was deleted from only means something in the trash"
    );
}

#[test]
fn an_id_key_in_the_trash_quarantines() {
    let source = "---\nkind: yonalist-trash\nformat_version: 1\n\
                  id: PrJects00001\nmax_hlc: 0swkd7qz9-00-a3f2\n---\n";

    assert!(parse(source.as_bytes()).is_err());
}

#[test]
fn an_oversized_file_quarantines() {
    let mut source = page("");
    source.push_str("- Text\n");
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

/// The stamp is the fact; the readable time is a reading of it. So the file's own
/// copy is never believed — a hand-edited one is replaced, and a file written by
/// something that never heard of the key gains it, which is what any ordinary
/// Markdown editor leaves behind after somebody fixes a typo.
#[test]
fn the_readable_time_is_derived_rather_than_believed() {
    let canonical = page_with_footer(
        "- Text <!-- yid: Nd0000000001 -->\n",
        &["yid: Nd0000000001 t: 0swkd7qz9-00-a3f2"],
    );
    assert!(
        canonical.contains("updated: 2041-10-11T06:19:09Z"),
        "the stamp reads 2041, so the file has to say so where a person can check it:\n{canonical}"
    );

    for (name, source) in [
        (
            "a hand-edited time",
            canonical.replace(
                "updated: 2041-10-11T06:19:09Z",
                "updated: 1999-01-01T00:00:00Z",
            ),
        ),
        (
            "no time at all",
            canonical.replace("updated: 2041-10-11T06:19:09Z\n", ""),
        ),
    ] {
        let rendered =
            String::from_utf8(notes_sync::render::render(&accepted(&source)).expect("render"))
                .expect("utf-8");

        assert_eq!(
            rendered, canonical,
            "{name} did not come back as the time the stamp states"
        );
    }
}

/// One instant, one spelling, whatever the device's own clock is set to. A local
/// offset here would have two devices in different zones write different bytes
/// for one document, and each would then read the other's file as an edit and
/// write it back.
#[test]
fn the_readable_time_does_not_depend_on_where_the_device_is() {
    let canonical = page_with_footer(
        "- Text <!-- yid: Nd0000000001 -->\n",
        &["yid: Nd0000000001 t: 0swkd7qz9-00-a3f2"],
    );

    let line = canonical
        .lines()
        .find(|line| line.starts_with("updated: "))
        .expect("the readable time");

    assert!(
        line.ends_with('Z'),
        "a time carrying an offset is a time that differs per device: `{line}`"
    );
}

#[test]
fn unknown_fields_survive_a_parse_render_round_trip() {
    let source = "---\nkind: yonalist-notes\nformat_version: 1\n\
                  id: PrJects00001\nmax_hlc: 0swkd7qz9-00-a3f2\n\
                  updated: 2041-10-11T06:19:09Z\n\
                  root_hlc: 0swkd7qz5-00-a3f2\nfuture_key: kept\n---\n# Projects\n\n\
                  - Text <!-- yid: Nd0000000001 -->\n\n\
                  <!-- yonalist\n\
                  yid: Nd0000000001 \
                  t: 0swkd7qz9-00-a3f2 star future: value lone\n\
                  -->\n";

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
                  <!-- yid: Nd0000000005 -->\n\n\
                  <!-- yonalist\n\
                  yid: Nd0000000005 t: 0swkd7qza-00-a3f2 \
                  w: 320 px: 10x10 bytes: 4\n\
                  -->\n";

    let parsed = nodes(source);

    assert_eq!(parsed.len(), 1, "a deleted image still has to come back");
}

#[test]
fn a_link_that_is_not_an_asset_quarantines() {
    for path in ["README.md", "assets/../README.md", "assets/deep/shot.png"] {
        let source = page_with_footer(
            &format!("- ![shot.png]({path}) <!-- yid: Nd0000000001 -->\n"),
            &["yid: Nd0000000001 t: 0swkd7qz6-00-a3f2 \
                 w: 320 px: 10x10 bytes: 4"],
        );

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
    let source = page_with_footer(
        "- a\\\\nb <!-- yid: Nd0000000001 -->\n",
        &["yid: Nd0000000001 t: 0swkd7qz9-00-a3f2"],
    );

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
    let parsed = nodes(&page_with_footer(
        "- Text <!-- yid: Nd0000000001 --> \n",
        &["yid: Nd0000000001 t: 0swkd7qz6-00-a3f2"],
    ));

    assert_eq!(parsed[0].id, "Nd0000000001");
    assert_eq!(
        parsed[0].hlc, "0swkd7qz6-00-a3f2",
        "and it still finds its own footer line"
    );
}

/// A picture's size used to ride on the line, so a line a person typed by hand
/// could still be read and the merge would issue the id. The size lives in the
/// footer now and the footer is joined by the line's own `yid:` — so a line with
/// no id has no entry it could be joined to, and one whose entry is gone has
/// nothing either. There is no default to fall back on: `notes_images` refuses
/// zero pixels and zero bytes, and a row built from a guess would draw a
/// placeholder over bytes this app has. The document is refused with a reason
/// that names the file, which is the answer a line with no metadata has always
/// had.
#[test]
fn an_image_line_without_a_footer_entry_quarantines() {
    for (what, line) in [
        (
            "no id, so no entry can name it",
            "- ![shot.png](assets/shot-9f3a1c8e2044.png)\n",
        ),
        (
            "an id whose entry somebody deleted",
            "- ![shot.png](assets/shot-9f3a1c8e2044.png) \
             <!-- yid: Nd0000000001 -->\n",
        ),
    ] {
        let refused = parse(page(line).as_bytes())
            .err()
            .unwrap_or_else(|| panic!("{what}: a picture with no size is not a row"));

        assert!(
            refused.contains("shot-9f3a1c8e2044.png"),
            "{what}: the reason has to name the file it is about: {refused}"
        );
    }
}

/// A stamp the content cannot account for is exactly what §4.2 calls
/// disagreeing with the content. Keeping it would let one hand edit push the
/// boot clock into the future and future-stamp every later local edit.
#[test]
fn a_stated_max_hlc_the_content_cannot_account_for_is_recomputed() {
    let source = page_with_footer(
        "- Text <!-- yid: Nd0000000001 -->\n",
        &["yid: Nd0000000001 t: 0swkd7qz6-00-a3f2"],
    )
    .replace("max_hlc: 0swkd7qz9-00-a3f2", "max_hlc: zzzzzzzzz-zz-ffff");
    let VaultFile::Page(parsed) = accepted(&source) else {
        panic!("a page");
    };

    assert_eq!(parsed.max_hlc, "0swkd7qz6-00-a3f2");
}

#[test]
fn an_unknown_footer_token_does_not_shift_the_ones_after_it() {
    let parsed = nodes(&page_with_footer(
        "- ![shot.png](assets/shot-9f3a1c8e2044.png) \
         <!-- yid: Nd0000000001 -->\n",
        &["yid: Nd0000000001 t: 0swkd7qz6-00-a3f2 \
             w: 320 future px: 10x10 bytes: 4"],
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
    let mut entries = Vec::new();
    for (index, text) in awkward.iter().enumerate() {
        let id = format!("Nd{:010}", index + 1);
        body.push_str(&format!("- {} <!-- yid: {id} -->\n", escaped(text)));
        body.push_str(&format!("  > note for {index}\n  >\n  > second line\n"));
        entries.push(format!(
            "yid: {id} t: 0swkd7qz6-00-a3f2 star ordered: {} collapsed",
            index as i64 - 3
        ));
    }
    let picture = "Nd0000000099";
    body.push_str(&format!(
        "- ![shot .png](../assets/shot-9f3a1c8e2044.png) <!-- yid: {picture} -->\n"
    ));
    entries.push(format!(
        "yid: {picture} t: 0swkd7qz6-00-a3f2 w: 320 px: 10x10 bytes: 4"
    ));

    let entries: Vec<&str> = entries.iter().map(String::as_str).collect();
    let source = page_with_footer(&body, &entries)
        .replace("max_hlc: 0swkd7qz9-00-a3f2", "max_hlc: 0swkd7qz6-00-a3f2");

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
/// What the renderer writes for a value that begins nothing. Three characters
/// earn an entity wherever they sit; the rest of the punctuation is text now, so
/// this helper says so too rather than describing the old rule.
///
/// A leading marker is out of scope here on purpose: every value this is asked
/// about is ordinary prose, and a test about a marker should say the marker out
/// loud instead of deriving it.
fn escaped(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '&' => "&amp;".to_owned(),
            '<' => "&lt;".to_owned(),
            '\\' => "\\\\".to_owned(),
            '\n' => "\\n".to_owned(),
            other => other.to_string(),
        })
        .collect()
}

/// §5.3's third row: a footer token this version has no meaning for belongs to
/// whoever wrote it. Without a place to keep it, reading a newer device's file
/// and writing it back would silently strip the value. A picture's own tokens sit
/// on the same line now, so the unknown ones have to come back behind them.
#[test]
fn an_unknown_footer_token_survives_a_parse_render_round_trip() {
    let source = page_with_footer(
        "- ![shot.png](assets/shot-9f3a1c8e2044.png) \
         <!-- yid: Nd0000000001 -->\n",
        &["yid: Nd0000000001 t: 0swkd7qz9-00-a3f2 \
             w: 320 px: 10x10 bytes: 4 focus: 0\\.5x0\\.3 lossless"],
    );

    let once = notes_sync::render::render(&accepted(&source)).expect("render");
    let text = String::from_utf8(once.clone()).expect("utf-8");
    let twice = notes_sync::render::render(&accepted(&text)).expect("render");

    assert_eq!(text, source, "the token came back changed or not at all");
    assert_eq!(once, twice);
}

/// The bounds an image has to satisfy are facts about the format, so a line
/// that breaks one is refused here — where the answer is a quarantine with a
/// reason — rather than surviving into a merge that dies on a constraint.
#[test]
fn an_image_line_outside_the_formats_bounds_quarantines() {
    for metadata in [
        "w: 10 px: 10x10 bytes: 4",
        "w: 320 px: 0x10 bytes: 4",
        "w: 320 px: 10x10 bytes: 0",
        "w: 320 px: 10x10 bytes: 20971521",
    ] {
        let source = page_with_footer(
            "- ![shot.png](assets/shot-9f3a1c8e2044.png) \
             <!-- yid: Nd0000000001 -->\n",
            &[&format!(
                "yid: Nd0000000001 t: 0swkd7qz6-00-a3f2 {metadata}"
            )],
        );

        assert!(
            parse(source.as_bytes()).is_err(),
            "`{metadata}` is outside what this format writes"
        );
    }
}

#[test]
fn an_image_with_an_unreadable_extension_quarantines() {
    let source = page_with_footer(
        "- ![shot.bmp](assets/shot-9f3a1c8e2044.bmp) \
         <!-- yid: Nd0000000001 -->\n",
        &["yid: Nd0000000001 t: 0swkd7qz6-00-a3f2 \
             w: 320 px: 10x10 bytes: 4"],
    );

    assert!(parse(source.as_bytes()).is_err());
}

/// A person writing an image line by hand leaves the alt text out — every
/// markdown editor does. The name is not decoration: a picture without one
/// has no metadata a row can be built from, and the note draws a placeholder
/// over bytes it has. The file already says what the file is called.
#[test]
fn an_image_line_with_no_alt_takes_its_file_name() {
    let parsed = nodes(&page_with_footer(
        "- ![](assets/shot-9f3a1c8e2044.png) \
         <!-- yid: Nd0000000001 -->\n",
        &["yid: Nd0000000001 t: 0swkd7qz6-00-a3f2 \
             w: 320 px: 10x10 bytes: 4"],
    ));

    let NodeBody::Image(image) = &parsed[0].body else {
        panic!("an image");
    };
    assert_eq!(image.original_name, "shot-9f3a1c8e2044.png");
}

// Whatever the escape rules are, this is what they are *for*: what a person
// typed comes back exactly as they typed it. Arguing the rules character by
// character is how a hole gets left in them, so the rules are checked against
// the only contract that matters instead.
//
// The generator reaches for the characters that decide it — markers, brackets,
// entities, backslashes, comment openers — at the front of a value as well as
// inside it, because position is the whole of what the rules turn on.
proptest::proptest! {
    #![proptest_config(proptest::prelude::ProptestConfig::with_cases(512))]

    #[test]
    fn whatever_a_person_typed_comes_back_as_they_typed_it(
        text in proptest::collection::vec(
            proptest::sample::select(vec![
                "- ", "* ", "+ ", "# ", "1. ", "2) ", "![", "[", "]", "(", ")",
                // Whole shapes as well as single marks. Reaching `[x] ` by
                // drawing three characters in a row is a 1-in-30000 event, and a
                // property that can only find a defect by luck has not checked it.
                "[ ] ", "[x] ", "[X] ", "```", "~~~", "---", "***", "___",
                ">", "<", "<!--", "-->", "&", "&lt;", "&amp;", "\\", "\\.", ".",
                "/", "+", "_", "*", "`", "a", "x", "가", " ", "1", "-", "\n",
            ]),
            0..12,
        ),
        note in proptest::collection::vec(
            proptest::sample::select(vec![
                "- ", "> ", ">", "#", "&", "<", "\\", ".", "a", "가", " ", "1. ",
                "[ ] ", "[x] ", "```", "---", "\n",
            ]),
            0..8,
        ),
    ) {
        let text = text.concat();
        let note = note.concat();
        // A value the renderer refuses for a stated reason is not this
        // property's business; a value it accepts has to survive.
        let mut node = notes_sync::document::DocumentNode {
            id: "Nd0000000001".to_owned(),
            hlc: "0swkd7qz9-00-a3f2".to_owned(),
            body: NodeBody::Text(text.clone()),
            note: note.clone(),
            marker: Marker::Bullet,
            collapsed: false,
            completed: false,
            starred: false,
            from: None,
            place: None,
            unknown_tokens: Vec::new(),
            children: Vec::new(),
        };
        node.note = note.clone();

        let VaultFile::Page(mut document) = accepted(&page("")) else {
            panic!("a page");
        };
        document.root.note = String::new();
        document.nodes = vec![node];
        let bytes = notes_sync::render::render(&VaultFile::Page(document)).expect("render");

        let VaultFile::Page(read_back) = parse(&bytes).unwrap_or_else(|reason| {
            panic!("a document this build wrote it cannot read: {reason}\n{}",
                String::from_utf8_lossy(&bytes))
        }) else {
            panic!("a page");
        };

        proptest::prop_assert_eq!(
            read_back.nodes.len(), 1,
            "one bullet went in:\n{}", String::from_utf8_lossy(&bytes)
        );
        proptest::prop_assert_eq!(
            &read_back.nodes[0].body, &NodeBody::Text(text),
            "\n{}", String::from_utf8_lossy(&bytes)
        );
        proptest::prop_assert_eq!(
            &read_back.nodes[0].note, &note,
            "\n{}", String::from_utf8_lossy(&bytes)
        );
    }
}

/// A title is not allowed to be an image — a document root that drew a picture
/// would have nowhere to put its own name — so the reader refuses one that begins
/// `![`. That refusal is why the heading keeps a backslash there even though `# `
/// already sits in front of it, and why loosening the escape rules had to stop at
/// this one character.
#[test]
fn a_title_that_begins_like_an_image_survives_instead_of_quarantining() {
    let VaultFile::Page(mut document) = accepted(&page_with_footer(
        "- Text <!-- yid: Nd0000000001 -->\n",
        &["yid: Nd0000000001 t: 0swkd7qz9-00-a3f2"],
    )) else {
        panic!("a page");
    };
    document.root.title = "![not a picture] 회고".to_owned();

    let bytes = notes_sync::render::render(&VaultFile::Page(document)).expect("render");

    let VaultFile::Page(read_back) = parse(&bytes).unwrap_or_else(|reason| {
        panic!(
            "the reader refused a title this build wrote: {reason}\n{}",
            String::from_utf8_lossy(&bytes)
        )
    }) else {
        panic!("a page");
    };
    assert_eq!(read_back.root.title, "![not a picture] 회고");
}

/// The shape the property could not reach by luck, said out loud. The reader
/// takes `- [ ] ` and `- [x] ` off the front of a line, so a bullet whose own
/// text begins that way is the one case where loosening the escape rules changed
/// a *value* rather than a spelling — and `[ ]` on its own was worse than that:
/// with nothing after it the line became `- [ ] <!-- yid: … -->`, the boundary
/// scan found no comment to split off, and the node lost its id into its text.
#[test]
fn a_bullet_whose_text_begins_with_a_checkbox_keeps_it() {
    for typed in [
        "[ ] milk",
        "[x] milk",
        "[ ]",
        "[x]",
        "[X] milk",
        "[ ] [ ] milk",
    ] {
        let VaultFile::Page(mut document) = accepted(&page_with_footer(
            "- Text <!-- yid: Nd0000000001 -->\n",
            &["yid: Nd0000000001 t: 0swkd7qz9-00-a3f2"],
        )) else {
            panic!("a page");
        };
        document.nodes[0].body = NodeBody::Text(typed.to_owned());
        let bytes = notes_sync::render::render(&VaultFile::Page(document)).expect("render");

        let VaultFile::Page(read_back) = parse(&bytes).expect("parse") else {
            panic!("a page");
        };

        assert_eq!(
            read_back.nodes[0].body,
            NodeBody::Text(typed.to_owned()),
            "{typed:?} came back as something else:\n{}",
            String::from_utf8_lossy(&bytes)
        );
        assert_eq!(
            read_back.nodes[0].marker,
            Marker::Bullet,
            "{typed:?} was read as a todo"
        );
        assert!(!read_back.nodes[0].completed, "{typed:?} was read as done");
        assert_eq!(
            read_back.nodes[0].id, "Nd0000000001",
            "{typed:?} lost its id"
        );
    }
}

/// A note whose own first line is blank. The renderer writes a bare `>` for it,
/// and the reader used an empty note as its "nothing yet" signal — so the next
/// line replaced the blank one instead of following it, and a note of nothing but
/// blank lines came back as no note at all. The app writes these itself, so this
/// was reachable without anybody hand-editing a file.
#[test]
fn a_note_that_opens_with_a_blank_line_keeps_it() {
    for typed in ["\n뒤에 온 줄", "\n", "\n\n", "앞\n\n뒤"] {
        let VaultFile::Page(mut document) = accepted(&page_with_footer(
            "- Text <!-- yid: Nd0000000001 -->\n",
            &["yid: Nd0000000001 t: 0swkd7qz9-00-a3f2"],
        )) else {
            panic!("a page");
        };
        document.nodes[0].note = typed.to_owned();
        let bytes = notes_sync::render::render(&VaultFile::Page(document)).expect("render");

        let VaultFile::Page(read_back) = parse(&bytes).expect("parse") else {
            panic!("a page");
        };

        assert_eq!(
            read_back.nodes[0].note,
            typed,
            "a note came back with a line missing:\n{}",
            String::from_utf8_lossy(&bytes)
        );
    }
}

/// Two ids differing only in case are two blocks, here as everywhere else.
///
/// A UUID means the same thing in either case, so folding was free. A `yid` is
/// base64url, where `a` and `A` are different characters — and the rest of the
/// format has already stopped folding: `derived_child_id` hashes the id as
/// written, and `folder_suffix` gives two such ids two folders. A parser still
/// folding would refuse a document that is perfectly legal, and refuse it as a
/// duplicate.
#[test]
fn two_ids_differing_only_in_case_are_two_blocks() {
    let source = page_with_footer(
        "- One <!-- yid: Nd0000000abc -->\n- Two <!-- yid: Nd0000000ABC -->\n",
        &[
            "yid: Nd0000000abc t: 0swkd7qz6-00-a3f2",
            "yid: Nd0000000ABC t: 0swkd7qz7-00-a3f2",
        ],
    );

    let parsed = nodes(&source);

    assert_eq!(parsed.len(), 2, "{source}");
    assert_eq!(parsed[0].id, "Nd0000000abc");
    assert_eq!(parsed[1].id, "Nd0000000ABC");
    assert_eq!(
        parsed[0].hlc, "0swkd7qz6-00-a3f2",
        "and each joined its own footer entry"
    );
    assert_eq!(parsed[1].hlc, "0swkd7qz7-00-a3f2");
}

/// An invisible character must not cost a document its whole footer.
///
/// The delimiters used to be exact-line matches, so one trailing space on
/// `<!-- yonalist` refused the document with "This line is not part of the
/// grammar" and one on `-->` refused it with "The footer is never closed" —
/// both naming something nobody can see. `split_trailing_comment` twelve lines
/// away already trims trailing whitespace off a body comment on the grounds that
/// it is an editor's and not the format's; the footer, now the load-bearing half,
/// had the opposite rule.
#[test]
fn whitespace_around_the_footer_delimiters_is_an_editors_and_not_the_formats() {
    let canonical = page_with_footer(
        "- One <!-- yid: Nd0000000abc -->\n",
        &["yid: Nd0000000abc t: 0swkd7qz6-00-a3f2"],
    );

    for (what, source) in [
        (
            "a space after the opener",
            canonical.replace("<!-- yonalist\n", "<!-- yonalist \n"),
        ),
        (
            "a space after the closer",
            canonical.replace("\n-->\n", "\n--> \n"),
        ),
        (
            "an indented opener",
            canonical.replace("<!-- yonalist\n", "  <!-- yonalist\n"),
        ),
        (
            "an indented closer",
            canonical.replace("\n-->\n", "\n  -->\n"),
        ),
    ] {
        let parsed = nodes(&source);

        assert_eq!(parsed.len(), 1, "{what} lost the body:\n{source}");
        assert_eq!(
            parsed[0].hlc, "0swkd7qz6-00-a3f2",
            "{what} lost the footer:\n{source}"
        );
    }
}

/// A hand-typed picture line is refused, and the refusal says where to look.
///
/// §7 accepts the refusal — a picture whose dimensions nobody stated has nothing
/// a row could be built from, and the database will not take a zero. What it does
/// not accept is a reason a person cannot act on: `An image line is not a link`
/// about a line that plainly is one, which is what the dead `ya:` special case in
/// the comment splitter produced.
#[test]
fn a_hand_typed_picture_line_is_refused_by_naming_the_footer() {
    let no_entry = page("- ![shot.png](assets/shot-9f3a1c8e2044.png) <!-- yid: Nd0000000abc -->\n");
    let refusal = parse(no_entry.as_bytes()).expect_err("a picture with no metadata");

    assert!(
        refusal.contains("footer"),
        "the refusal has to name the place a person can fix it: {refusal}"
    );

    // The old on-line comment, which somebody may copy out of an older file. It
    // is not a channel any more, so what is left is a link with text after it —
    // and "not a link" is the honest thing to say about that, rather than a
    // reference to a footer entry that would not have helped. Reading the old
    // comment instead would be a compatibility reader, which is a non-goal.
    let old_comment = page(
        "- ![shot.png](assets/shot-9f3a1c8e2044.png) \
         <!-- ya: w: 320 px: 10x10 bytes: 4 --> <!-- yid: Nd0000000abc -->\n",
    );
    let refusal = parse(old_comment.as_bytes()).expect_err("a line with two comments");

    assert!(
        refusal.contains("not a link") && refusal.contains("ya:"),
        "the refusal has to quote the line so a person sees the leftover: {refusal}"
    );
}
