//! What to do with a file the watcher noticed.
//!
//! Reading and parsing happen here, off the thread that owns the database, so
//! a folder arriving from another device does not stall a keystroke. What
//! comes back is a decision, and only the merge itself needs the worker.
//!
//! Three of the four answers are refusals, and each has its own reason:
//!
//! An echo — bytes this app wrote itself — is skipped. Nothing else can tell
//! the difference, since a hand edit moves neither `max_hlc` nor any stamp: the
//! hash is the only thing that answers, and it is taken on every event, never
//! from a stat. A transport that preserves mtime, as Syncthing does, would
//! otherwise hide somebody's edit for good.
//!
//! A file whose bytes have not arrived — the placeholder a cloud client leaves
//! behind — is not a file that was emptied. Merging it would delete everything
//! it holds, so it waits for the bytes instead.
//!
//! And a file this format cannot read is left alone rather than merged into
//! nothing.

use crate::document::VaultFile;
use crate::merger::MergeInput;
use std::path::Path;

pub enum Verdict {
    /// This app wrote these bytes. Reading them back as news would have two
    /// devices handing each other the same document for ever.
    Echo,
    /// Nothing to merge yet, and nothing wrong either — ask again later.
    NotYetArrived,
    /// The file is there and readable, and it says something new.
    Merge(Box<VaultFile>, MergeInput),
    /// Read, but not a document this version can make sense of. The reason is
    /// what the recovery page shows the user.
    Unreadable(String),
}

/// `recorded_hash` is what this app last dealt with at that path — what it
/// wrote, or what it refused. Either keeps a file from being re-read on every
/// event.
pub fn consider(
    vault_root: &Path,
    relative: &str,
    recorded_hash: Option<&str>,
) -> Result<Verdict, String> {
    let path = vault_root.join(relative);
    // The link itself, so a link pointing out of the vault reads as what it is
    // rather than as the file it names.
    let facts = std::fs::symlink_metadata(&path)
        .map_err(|error| format!("Could not look at `{relative}`: {error}"))?;
    if !facts.is_file() {
        return Err(format!("`{relative}` is not a file this vault holds."));
    }
    // A file the sync client has not filled in yet. Cloud clients leave one
    // behind when a file is "online only", and it reads as empty rather than
    // as missing. Empty is the whole test: this format always writes
    // frontmatter, so a document of ours is never zero bytes.
    if facts.len() == 0 {
        return Ok(Verdict::NotYetArrived);
    }
    let bytes =
        crate::file_io::read_regular_bounded(vault_root, &path, crate::parse::MAX_FILE_BYTES)?;
    let file_hash = crate::export::hash_bytes(&bytes);
    if recorded_hash == Some(file_hash.as_str()) {
        return Ok(Verdict::Echo);
    }
    let input = MergeInput {
        file_path: relative.to_owned(),
        file_hash,
        // Recorded so the startup scan can skip this file next time. The event
        // path never reads them back — that is the whole point of hashing here.
        file_mtime_ms: modified_millis(&facts),
        file_size: i64::try_from(facts.len()).ok(),
    };
    match crate::parse::parse(&bytes) {
        Ok(file) => Ok(Verdict::Merge(Box::new(file), input)),
        Err(reason) => Ok(Verdict::Unreadable(reason)),
    }
}

/// A conflicted copy is an input, not a mistake: some sync clients answer a
/// simultaneous edit by writing one, and the notes inside it are somebody's.
/// It is merged like any other file and then tidied away.
pub fn is_conflicted_copy(relative: &str) -> bool {
    let name = relative.rsplit('/').next().unwrap_or(relative);
    // The three the common clients write. Matching on shape rather than on an
    // exact string, since each puts its own device name or date inside.
    name.contains("conflicted copy")
        || name.contains("sync-conflict-")
        || name.contains(".conflict.")
        || is_numbered_duplicate(name)
}

/// iCloud leaves `README 2.md` beside `README.md` when its own sync collides
/// with this app's temp-file-and-rename write, and says nothing else about it.
/// The two names this format ever writes are the whole test: a numbered sibling
/// of one of them was written by something other than this app.
fn is_numbered_duplicate(name: &str) -> bool {
    let Some((stem, number)) = name
        .strip_suffix(".md")
        .and_then(|stem| stem.rsplit_once(' '))
    else {
        return false;
    };
    matches!(stem, "README" | "trash")
        // Digits only — `parse` would otherwise take a leading sign — and from
        // two up, which is where iCloud starts counting.
        && number.bytes().all(|byte| byte.is_ascii_digit())
        && number.parse::<u32>().is_ok_and(|number| number >= 2)
}

fn modified_millis(facts: &std::fs::Metadata) -> Option<i64> {
    let modified = facts.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(since.as_millis()).ok()
}
