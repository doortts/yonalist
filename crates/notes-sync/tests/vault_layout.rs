//! Where a page's folder goes and what it is called.
//!
//! The id suffix is always appended, never only on a collision. Adding it only
//! when names clash would need a comparison of "who was here first", and two
//! devices that have not seen each other answer that differently.

use notes_sync::layout::page_folder_name;

const ID: &str = "PrJects00001";

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
            format!("{expected}-{ID}"),
            "title {title:?}"
        );
    }
}

#[test]
fn a_long_title_is_cut_at_forty_characters_and_a_hundred_and_twenty_bytes() {
    let latin = "a".repeat(80);
    let name = page_folder_name(&latin, ID).expect("name");
    assert_eq!(name, format!("{}-{ID}", "a".repeat(40)));

    // Korean is three bytes a character, so the byte bound bites first.
    let korean = "가".repeat(80);
    let name = page_folder_name(&korean, ID).expect("name");
    let stem = name.strip_suffix(&format!("-{ID}")).expect("suffix");
    assert!(stem.len() <= 120, "{} bytes", stem.len());
    assert_eq!(stem.chars().count(), 40);
}

/// Cutting mid-character would produce bytes no filesystem should be handed,
/// and cutting mid-emoji produces something the reader does not recognise.
#[test]
fn a_cut_never_splits_a_character() {
    let emoji = "🌱".repeat(60);
    let name = page_folder_name(&emoji, ID).expect("name");
    let stem = name.strip_suffix(&format!("-{ID}")).expect("suffix");
    assert!(stem.len() <= 120);
    assert!(stem.chars().all(|character| character == '🌱'));
}

#[test]
fn the_id_suffix_is_always_appended() {
    let name = page_folder_name("Nothing else is called this", ID).expect("name");
    assert!(
        name.ends_with(ID),
        "a name that only sometimes carries its id needs a comparison nobody can make"
    );
}

#[test]
fn two_pages_with_the_same_title_get_different_folders() {
    let other = "Mnutes000001";

    assert_ne!(
        page_folder_name("Notes", ID).expect("name"),
        page_folder_name("Notes", other).expect("name")
    );
}

#[test]
fn a_name_needs_a_real_id_to_be_built_from() {
    assert!(page_folder_name("Projects", "not-an-id").is_err());
}

/// A control character is nothing at all, not a word boundary: turning one into
/// a separator would put a hyphen in a name the user never asked for.
#[test]
fn control_characters_leave_without_a_trace() {
    assert_eq!(
        page_folder_name("a\u{7}b", ID).expect("name"),
        format!("ab-{ID}")
    );
}

/// The suffix is the block id, whole. It used to be the first twelve hex
/// characters of a UUID — a lossy prefix of a 36-character name, which meant the
/// folder could not be traced back to the document that owns it without going
/// through the database. A `yid` is already twelve characters, so the folder can
/// simply carry it.
#[test]
fn a_page_folder_carries_the_whole_block_id() {
    assert_eq!(
        page_folder_name("Projects", "PrJects00001").expect("a folder"),
        "Projects-PrJects00001"
    );
    // Case matters now. Two ids that differ only in case are two blocks, where a
    // UUID prefix folded them onto one folder.
    assert_ne!(
        page_folder_name("Projects", "prjects00001").expect("a folder"),
        page_folder_name("Projects", "PrJects00001").expect("a folder")
    );
}

/// A UUID is no longer a block id, so it can no longer name a folder. The
/// refusal is what stops a stale row from writing a folder no reader would join
/// back to its document.
#[test]
fn a_uuid_is_no_longer_a_name_a_folder_can_be_built_from() {
    assert!(page_folder_name("Projects", "4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1").is_err());
    assert!(
        page_folder_name("Projects", "root").is_err(),
        "home has no folder of its own"
    );
}

/// The four characters a stamp carries used to be sliced off a fresh random
/// UUID, so a database provisioned twice on one Mac was two devices as far as
/// every merge was concerned — and the vault's files, which outlive a database,
/// then held two generations of stamps arguing with each other.
///
/// Derived from the machine, they agree. What the value *is* cannot be asserted
/// — it differs per machine, and that is the point — so what is pinned is that
/// it is stable, and that it is a device id the encoding will accept.
///
/// On a target with no machine identifier to derive from there is no answer at
/// all, and that absence is the contract: nothing here may invent one. So the
/// test asserts the shape only where an answer is owed.
#[test]
fn one_machine_provisions_one_device_id() {
    let once = notes_sync::hlc::device_seed();

    #[cfg(target_os = "macos")]
    {
        let once = once.clone().expect("a Mac says which machine it is");
        assert_eq!(
            Some(&once),
            notes_sync::hlc::device_seed().as_ref(),
            "a second database on this Mac has to be the same device"
        );
        assert!(
            notes_sync::hlc::is_device_id(&once),
            "`{once}` is not a device id the stamp encoding can carry"
        );
        notes_sync::hlc::Hlc::new(0, 0, &once).expect("a reading can be issued with it");
    }

    // Whatever the target, an answer that exists is a usable one and an answer
    // that does not is `None` rather than something drawn at random.
    if let Some(seed) = once {
        assert!(
            notes_sync::hlc::is_device_id(&seed),
            "`{seed}` is not a device id"
        );
    }
}
