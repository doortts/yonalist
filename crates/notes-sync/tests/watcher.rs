//! What the watcher decides about a file, without notify in the way.
//!
//! The callback is called directly here. What is being tested is the decision,
//! and the decision is the part that loses notes when it is wrong.

use notes_sync::watcher::{Verdict, consider, is_conflicted_copy};

const DOCUMENT: &[u8] = b"---\n\
    kind: yonalist-notes\n\
    format_version: 1\n\
    id: 4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1\n\
    max_hlc: 0swkd7qz9-00-a3f2\n\
    root_hlc: 0swkd7qz5-00-a3f2\n\
    ---\n\
    # Projects\n\
    \n\
    - Thought <!-- ya: yid=8a201f33-0000-4c91-8d02-000000000001 t=0swkd7qz9-00-a3f2 -->\n";

fn vault() -> tempfile::TempDir {
    tempfile::tempdir().expect("vault")
}

fn write(vault: &tempfile::TempDir, relative: &str, bytes: &[u8]) {
    let path = vault.path().join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("folder");
    }
    std::fs::write(path, bytes).expect("write");
}

fn hash(bytes: &[u8]) -> String {
    notes_sync::export::hash_bytes(bytes)
}

#[test]
fn a_file_this_app_did_not_write_is_merged() {
    let vault = vault();
    write(&vault, "Projects-4f1c8e20a3b7/README.md", DOCUMENT);

    let verdict = consider(vault.path(), "Projects-4f1c8e20a3b7/README.md", None).expect("look");

    let Verdict::Merge(_, input) = verdict else {
        panic!("a document nobody here has seen is news");
    };
    assert_eq!(input.file_hash, hash(DOCUMENT));
}

/// Every write this app makes lands as an event. Reading them back as news
/// would have two devices handing each other the same document for ever.
#[test]
fn an_echo_of_our_own_write_is_skipped() {
    let vault = vault();
    write(&vault, "Projects-4f1c8e20a3b7/README.md", DOCUMENT);

    let verdict = consider(
        vault.path(),
        "Projects-4f1c8e20a3b7/README.md",
        Some(&hash(DOCUMENT)),
    )
    .expect("look");

    assert!(
        matches!(verdict, Verdict::Echo),
        "these are the bytes this app itself wrote"
    );
}

/// The one rule the event path must not share with the startup scan. A
/// transport that preserves mtime — Syncthing does — would otherwise report
/// "nothing changed" about a file somebody just edited, and a hand edit moves
/// neither `max_hlc` nor any stamp, so the hash is the only thing that answers.
#[test]
fn a_watch_event_hashes_even_when_the_stat_has_not_moved() {
    let vault = vault();
    write(&vault, "Projects-4f1c8e20a3b7/README.md", DOCUMENT);
    let recorded = hash(DOCUMENT);
    let edited = DOCUMENT
        .to_vec()
        .iter()
        .copied()
        .chain(b"- Another <!-- ya: yid=8a201f33-0000-4c91-8d02-000000000002 t=0swkd7qz9-01-a3f2 -->\n".iter().copied())
        .collect::<Vec<u8>>();
    let path = vault.path().join("Projects-4f1c8e20a3b7/README.md");
    let was = std::fs::metadata(&path).expect("stat");
    std::fs::write(&path, &edited).expect("edit");
    // Exactly what a transport that preserves mtime hands over.
    std::fs::File::options()
        .write(true)
        .open(&path)
        .expect("open")
        .set_times(
            std::fs::FileTimes::new()
                .set_modified(was.modified().expect("mtime"))
                .set_accessed(
                    was.accessed()
                        .unwrap_or_else(|_| std::time::SystemTime::now()),
                ),
        )
        .expect("restore the reading");
    assert_eq!(
        std::fs::metadata(&path).expect("stat").modified().ok(),
        was.modified().ok(),
        "the stat has to look untouched for this test to mean anything"
    );

    let verdict = consider(
        vault.path(),
        "Projects-4f1c8e20a3b7/README.md",
        Some(&recorded),
    )
    .expect("look");

    assert!(
        matches!(verdict, Verdict::Merge(_, _)),
        "the stat says nothing changed; the bytes say otherwise, and the bytes are right"
    );
}

/// A cloud client leaves an empty file behind for something it has not
/// downloaded. Merging it would read every note in it as deleted.
#[test]
fn a_placeholder_file_waits_rather_than_emptying_the_document() {
    let vault = vault();
    write(&vault, "Projects-4f1c8e20a3b7/README.md", b"");

    let verdict = consider(vault.path(), "Projects-4f1c8e20a3b7/README.md", None).expect("look");

    assert!(
        matches!(verdict, Verdict::NotYetArrived),
        "a file whose bytes have not arrived is not a file that was emptied"
    );
}

#[test]
fn a_file_this_format_cannot_read_is_left_alone() {
    let vault = vault();
    write(&vault, "notes.md", b"somebody's own markdown\n");

    let verdict = consider(vault.path(), "notes.md", None).expect("look");

    assert!(
        matches!(verdict, Verdict::Unreadable(_)),
        "not every markdown file in the folder is ours"
    );
}

/// §3.4's no-follow contract, at the event path this time: the watcher sees a
/// link the same as any other entry.
#[test]
fn a_link_is_not_a_file_this_vault_holds() {
    let vault = vault();
    let outside = tempfile::tempdir().expect("outside");
    std::fs::write(outside.path().join("elsewhere.md"), DOCUMENT).expect("file");
    std::os::unix::fs::symlink(
        outside.path().join("elsewhere.md"),
        vault.path().join("linked.md"),
    )
    .expect("link");

    let refused = consider(vault.path(), "linked.md", None);

    assert!(
        refused.is_err(),
        "following it reads a file the user never put in this folder"
    );
}

/// Some sync clients answer a simultaneous edit by writing a second file. The
/// notes inside it are somebody's, so it is an input like any other.
#[test]
fn a_conflicted_copy_is_recognised_whatever_wrote_it() {
    assert!(is_conflicted_copy(
        "Projects-4f1c8e20a3b7/README (conflicted copy 2026-08-16).md"
    ));
    assert!(is_conflicted_copy(
        "Projects-4f1c8e20a3b7/README.sync-conflict-20260816-desktop.md"
    ));
    assert!(!is_conflicted_copy("Projects-4f1c8e20a3b7/README.md"));
}
