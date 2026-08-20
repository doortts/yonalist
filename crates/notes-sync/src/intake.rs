//! What a file on disk means, before anything reads it.
//!
//! Two gates, and which one applies is the whole point.
//!
//! A watch event says *something happened to this file*. The file is hashed, no
//! exceptions: a transport that preserves mtime — Syncthing does — would
//! otherwise report "nothing changed" about a file somebody just edited, and
//! that edit would be lost to us until something else touched it. A hand edit
//! moves neither `max_hlc` nor any stamp, so the hash is the only thing that can
//! answer.
//!
//! A startup scan walks thousands of files at once, where hashing all of them
//! costs more than it saves. There the stat is allowed to answer. What that
//! misses — a change that kept both the mtime and the size, whose event was also
//! missed — is closed by the reindex the user can ask for, which reads every
//! file whatever its stat says and so needs no verdict from here at all.

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Known {
    /// The hash of the bytes this app last dealt with there — what it wrote, or
    /// what it refused. Either way the same bytes arriving again are not news,
    /// which is what keeps a refused file from repeating its complaint on every
    /// event.
    pub recorded_hash: String,
    pub file_mtime_ms: Option<i64>,
    pub file_size: Option<i64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Verdict {
    /// Nothing to do — this is what we wrote, or what we already refused.
    Skip,
    /// Read the file and hash it, then ask again.
    Hash,
    /// The bytes differ from what this app last wrote. Parse and merge.
    Merge,
}

/// `SF_DATALESS` as `sys/stat.h` spells it. No crate publishes it, and the
/// state it marks is the one an evicted iCloud file is in: since macOS 14 such a
/// file keeps its name and its whole apparent size and holds no bytes, so
/// nothing about its stat gives it away except this.
const SF_DATALESS: u32 = 0x4000_0000;

/// Whether the flags a file reports say its bytes live in the cloud rather than
/// here. Kept apart from the file itself so the one thing a test cannot make —
/// a really evicted file — is not the same thing as the arithmetic.
pub fn flags_say_dataless(st_flags: u32) -> bool {
    st_flags & SF_DATALESS != 0
}

/// Whether this file's bytes have not been brought down yet. Only worth asking
/// once a read has already failed: a read that succeeds is what fetches them.
#[cfg(target_os = "macos")]
pub(crate) fn is_dataless(facts: &std::fs::Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    flags_say_dataless(facts.st_flags())
}

/// Only iCloud leaves a file in this state, and only on Apple's filesystems.
#[cfg(not(target_os = "macos"))]
pub(crate) fn is_dataless(_facts: &std::fs::Metadata) -> bool {
    false
}

/// After a watch event, with the file already hashed.
pub fn watch_verdict(known: Option<&Known>, file_hash: &str) -> Verdict {
    match known {
        Some(known) if known.recorded_hash == file_hash => Verdict::Skip,
        _ => Verdict::Merge,
    }
}

/// During a startup or safety-net scan, from the stat alone.
pub fn scan_verdict(known: Option<&Known>, mtime_ms: i64, size: i64) -> Verdict {
    match known {
        Some(known) if known.file_mtime_ms == Some(mtime_ms) && known.file_size == Some(size) => {
            Verdict::Skip
        }
        _ => Verdict::Hash,
    }
}
