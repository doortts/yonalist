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
use uuid::Uuid;

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
fn folder_suffix(id: &str) -> Result<String, String> {
    let canonical = Uuid::parse_str(id)
        .map_err(|_| format!("`{id}` is not a page id."))?
        .simple()
        .to_string();
    Ok(canonical[..12].to_owned())
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
