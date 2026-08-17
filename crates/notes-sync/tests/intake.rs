//! Deciding what a file on disk means before anything reads it.
//!
//! Two gates, and which one applies is the whole point. A watch event says
//! *something happened to this file*, so the file is hashed — a transport that
//! preserves mtime (Syncthing does) would otherwise report "unchanged" about a
//! file that changed. A full scan reads thousands of files at startup, where
//! hashing everything costs more than it saves, so there the stat is allowed to
//! answer — and what that misses is closed by the reindex the user can run.

use notes_sync::intake::{Known, Verdict, scan_verdict, watch_verdict};

fn known() -> Known {
    Known {
        recorded_hash: "a".repeat(64),
        file_mtime_ms: Some(1_700_000_000_000),
        file_size: Some(256),
    }
}

#[test]
fn an_echo_of_our_own_write_is_skipped() {
    let verdict = watch_verdict(Some(&known()), &"a".repeat(64));

    assert_eq!(
        verdict,
        Verdict::Skip,
        "these are the bytes this app just wrote; reading them back is not news"
    );
}

/// Spec §6. The event path never looks at mtime: a transport that preserves it
/// would hand us a false "nothing changed" about a file somebody edited.
#[test]
fn a_watch_event_hashes_even_when_stat_is_unchanged() {
    let verdict = watch_verdict(Some(&known()), &"b".repeat(64));

    assert_eq!(verdict, Verdict::Merge);
}

/// The P0 this test exists to keep from coming back: a hand edit changes
/// neither `max_hlc` nor any stamp, so the only thing that can decide whether a
/// file is worth reading is its hash.
#[test]
fn a_file_this_app_has_never_seen_is_merged() {
    assert_eq!(watch_verdict(None, &"b".repeat(64)), Verdict::Merge);
}

/// A file that was refused recorded the bytes it was refused for, so the same
/// bytes arriving again are not news — otherwise every event would repeat the
/// same complaint. Different bytes are a fresh attempt.
#[test]
fn a_refused_file_is_left_alone_until_its_bytes_change() {
    let refused = Known {
        recorded_hash: "c".repeat(64),
        ..known()
    };

    assert_eq!(
        watch_verdict(Some(&refused), &"c".repeat(64)),
        Verdict::Skip
    );
    assert_eq!(
        watch_verdict(Some(&refused), &"d".repeat(64)),
        Verdict::Merge
    );
}

/// A startup scan is allowed the cheap answer, because hashing a thousand files
/// to learn that none of them moved is a cost the user feels on every launch.
#[test]
fn the_scan_gate_is_mtime_and_size_not_content() {
    let known = known();

    assert_eq!(
        scan_verdict(Some(&known), known.file_mtime_ms.unwrap(), 256),
        Verdict::Skip
    );
    assert_eq!(
        scan_verdict(Some(&known), known.file_mtime_ms.unwrap() + 1, 256),
        Verdict::Hash
    );
    assert_eq!(
        scan_verdict(Some(&known), known.file_mtime_ms.unwrap(), 257),
        Verdict::Hash
    );
}

#[test]
fn a_scan_reads_a_file_it_has_no_record_of() {
    assert_eq!(scan_verdict(None, 1, 1), Verdict::Hash);
}
