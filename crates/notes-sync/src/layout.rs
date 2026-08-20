//! Where things go in the vault, and what they are called.
//!
//! One page is one folder. Its name always carries the page's id, never only
//! when two names would clash: deciding "who was here first" needs a comparison
//! two devices that have not seen each other cannot agree on.
//!
//! A title change does not rename the folder. Automatic renames are the one
//! operation file sync handles worst — a device that sees the delete before the
//! create loses the folder — so the name is set once and a command the user
//! runs is what tidies it later.

use unicode_normalization::UnicodeNormalization;

/// The most a cleaned title may be, before the id is appended.
const MAX_TITLE_CHARS: usize = 40;
const MAX_TITLE_BYTES: usize = 120;
/// Names Windows refuses whatever the extension, and the vault may well be
/// sitting in a folder that syncs there.
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

pub fn page_folder_name(title: &str, id: &str) -> Result<String, String> {
    let suffix = folder_suffix(id)?;
    Ok(format!("{}-{suffix}", clean_title(title)))
}

/// The first twelve hex digits of the id with its hyphens taken out. Twelve is
/// enough that two pages never share one, and short enough to read.
/// The block id, whole. It used to be the first twelve hex characters of a UUID,
/// which meant a folder name could not be traced back to the document that owns
/// it without going through the database — and two ids differing only in case
/// folded onto one folder. A `yid` is already twelve characters.
///
/// Home is refused: it is the one id that is not a `yid`, and it has no folder of
/// its own — its file is the vault's root `README.md`.
fn folder_suffix(id: &str) -> Result<String, String> {
    if id == notes_core::HOME_ID || !notes_core::is_block_id(id) {
        return Err(format!("`{id}` is not a page id."));
    }
    Ok(id.to_owned())
}

/// What an attachment is called in the vault: what the user called the file,
/// cleaned the same way a page title is, with enough of the content hash to
/// keep two different pictures of the same name apart. Every device computes
/// the same answer from the same bytes, which is what lets them agree on where
/// an attachment lives without talking to each other.
pub fn asset_disk_name(original_name: &str, content_hash: &str, mime_type: &str) -> String {
    let stem = original_name
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .filter(|stem| !stem.is_empty())
        .unwrap_or(original_name);
    let hash = &content_hash[..content_hash.len().min(12)];
    format!("{}-{hash}.{}", clean_title(stem), extension(mime_type))
}

/// From the decoded type, never from what the file was called: a `.png` that
/// is really a jpeg would otherwise keep lying about itself in the vault.
pub fn asset_extension(mime_type: &str) -> &'static str {
    extension(mime_type)
}

fn extension(mime_type: &str) -> &'static str {
    match mime_type {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    }
}

fn clean_title(title: &str) -> String {
    // Anything that would break a path or a markdown link target. Brackets and
    // parentheses go too: these names land inside `](…)`, and a `)` would close
    // the link. With all of it gone the link target needs no escaping at all.
    let replaced: String = title
        .nfc()
        // A control character is not a word boundary — it is nothing at all, so
        // it leaves without a trace rather than becoming a separator.
        .filter(|character| !character.is_control())
        .map(|character| {
            if character.is_whitespace()
                || matches!(
                    character,
                    '/' | '\\'
                        | ':'
                        | '*'
                        | '?'
                        | '"'
                        | '<'
                        | '>'
                        | '|'
                        | '#'
                        | '%'
                        | '{'
                        | '}'
                        | '^'
                        | '~'
                        | '['
                        | ']'
                        | '('
                        | ')'
                )
            {
                '-'
            } else {
                character
            }
        })
        .collect();

    let mut collapsed = String::with_capacity(replaced.len());
    for character in replaced.chars() {
        if character == '-' && collapsed.ends_with('-') {
            continue;
        }
        collapsed.push(character);
    }
    // A leading dot hides the folder, so it cannot survive whatever else does.
    let trimmed = collapsed.trim_matches(['-', '.']);

    let mut cut = String::new();
    for character in trimmed.chars() {
        if cut.chars().count() == MAX_TITLE_CHARS
            || cut.len() + character.len_utf8() > MAX_TITLE_BYTES
        {
            break;
        }
        cut.push(character);
    }
    let cut = cut.trim_end_matches(['-', '.']).to_owned();

    if cut.is_empty() {
        return "untitled".to_owned();
    }
    if RESERVED
        .iter()
        .any(|reserved| cut.eq_ignore_ascii_case(reserved))
    {
        return format!("_{cut}");
    }
    cut
}

/// The one form a vault path is held in. `readdir` hands back whatever form the
/// folder stored, and the two forms are different strings: a Korean folder name
/// that came from an HFS+ disk, an old archive, or another client arrives
/// decomposed, while the same name built here — `clean_title` composes it —
/// arrives composed. macOS opens either one, so nothing about a file is wrong;
/// what breaks is every comparison sync makes by string. The stat gate's key,
/// the recorded folder, the asset's location, and the folder written into a
/// link would each stand for the same file under two spellings, so the form is
/// settled once, where a path off the disk becomes a string.
pub fn composed_path(path: String) -> String {
    if path.is_ascii() {
        return path;
    }
    path.nfc().collect()
}
