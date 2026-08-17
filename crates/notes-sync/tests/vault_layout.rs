//! Where a page's folder goes and what it is called.
//!
//! The id suffix is always appended, never only on a collision. Adding it only
//! when names clash would need a comparison of "who was here first", and two
//! devices that have not seen each other answer that differently.

use notes_sync::layout::page_folder_name;

const ID: &str = "26VJSt4Rw5eO";
const SUFFIX: &str = "26VJSt4Rw5eO";

#[test]
fn a_page_folder_name_follows_the_seven_steps() {
    for (title, expected) in [
        ("Projects", "Projects"),
        // Everything that would break a path or a markdown link target. The
        // brackets and parentheses go too: these names land inside `](…)`, and
        // a `)` closes the link.
        (r#"a/b\c:d*e?f"g<h>i|j"#, "a-b-c-d-e-f-g-h-i-j"),
        ("a#b%c{d}e^f~g[h]i(j)", "a-b-c-d-e-f-g-h-i-j"),
        ("  spaced   out  ", "spaced-out"),
        ("---dashes---", "dashes"),
        // A leading dot hides the folder, so it cannot survive.
        (".hidden", "hidden"),
        ("...", "untitled"),
        ("", "untitled"),
        // Reserved on Windows whatever the case, and the vault may well be
        // sitting in a folder that syncs there.
        ("con", "_con"),
        ("COM9", "_COM9"),
        ("lpt3", "_lpt3"),
        ("NULL", "NULL"),
    ] {
        assert_eq!(
            page_folder_name(title, ID).expect("name"),
            format!("{expected}-{SUFFIX}"),
            "title {title:?}"
        );
    }
}

#[test]
fn a_long_title_is_cut_at_forty_characters_and_a_hundred_and_twenty_bytes() {
    let latin = "a".repeat(80);
    let name = page_folder_name(&latin, ID).expect("name");
    assert_eq!(name, format!("{}-{SUFFIX}", "a".repeat(40)));

    // Korean is three bytes a character, so the byte bound bites first.
    let korean = "가".repeat(80);
    let name = page_folder_name(&korean, ID).expect("name");
    let stem = name.strip_suffix(&format!("-{SUFFIX}")).expect("suffix");
    assert!(stem.len() <= 120, "{} bytes", stem.len());
    assert_eq!(stem.chars().count(), 40);
}

/// Cutting mid-character would produce bytes no filesystem should be handed,
/// and cutting mid-emoji produces something the reader does not recognise.
#[test]
fn a_cut_never_splits_a_character() {
    let emoji = "🌱".repeat(60);
    let name = page_folder_name(&emoji, ID).expect("name");
    let stem = name.strip_suffix(&format!("-{SUFFIX}")).expect("suffix");
    assert!(stem.len() <= 120);
    assert!(stem.chars().all(|character| character == '🌱'));
}

#[test]
fn the_id_suffix_is_always_appended() {
    let name = page_folder_name("Nothing else is called this", ID).expect("name");
    assert!(
        name.ends_with(SUFFIX),
        "a name that only sometimes carries its id needs a comparison nobody can make"
    );
}

#[test]
fn two_pages_with_the_same_title_get_different_folders() {
    let other = "HFu8ZQ2yPdGr";

    assert_ne!(
        page_folder_name("Notes", ID).expect("name"),
        page_folder_name("Notes", other).expect("name")
    );
}

#[test]
fn a_name_needs_a_real_id_to_be_built_from() {
    assert!(page_folder_name("Projects", "not-a-uuid").is_err());
}

/// A control character is nothing at all, not a word boundary: turning one into
/// a separator would put a hyphen in a name the user never asked for.
#[test]
fn control_characters_leave_without_a_trace() {
    assert_eq!(
        page_folder_name("a\u{7}b", ID).expect("name"),
        format!("ab-{SUFFIX}")
    );
}
