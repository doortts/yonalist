//! Turns a document into the bytes that go in the vault. The same state has to
//! produce the same bytes every time — a re-render that only reorders keys
//! would look like an edit to every other device and start a merge over
//! nothing. Nothing here iterates a hash map or reads a clock.

use crate::document::{
    DocumentId, DocumentNode, DocumentRoot, ImageReference, Marker, NodeBody, PageDocument,
    TrashDocument, VaultFile,
};
use crate::hlc::Hlc;
use std::fmt::Write;
use uuid::Uuid;

pub const FORMAT_VERSION: u32 = 1;
/// The field cap exists so nothing reaches the vault that the parser would then
/// have to quarantine on the way back in. The depth and node-count caps are the
/// exporter's to check (M4's self-verifying emission), since only it sees the
/// whole document before deciding to write.
pub const MAX_FIELD_BYTES: usize = 100_000;

pub fn render(file: &VaultFile) -> Result<Vec<u8>, String> {
    match file {
        VaultFile::Page(page) => render_page(page),
        VaultFile::Trash(trash) => render_trash(trash),
    }
}

fn render_page(document: &PageDocument) -> Result<Vec<u8>, String> {
    let mut out = String::new();
    field_fits(&document.root.title, "root title")?;
    field_fits(&document.root.note, "root note")?;

    out.push_str("---\n");
    out.push_str("kind: yonalist-notes\n");
    let _ = writeln!(out, "format_version: {FORMAT_VERSION}");
    let _ = writeln!(out, "id: {}", document_id(&document.id)?);
    if let Some(parent) = &document.parent {
        let _ = writeln!(out, "parent: {}", canonical_uuid(parent)?);
    }
    // Zero is the default, and §4.2 omits a key at its default: written out it
    // would be one more line for every merge to compare over nothing.
    if let Some(sort_key) = document.sort_key.filter(|key| *key != 0) {
        let _ = writeln!(out, "sort_key: {sort_key}");
    }
    // An empty HLC would leave a key ending in a space, which a hand editor
    // trims away and `git diff --check` flags. Both are required at render, so
    // this reports rather than writes one.
    let max_hlc = required_hlc(&document.max_hlc, "max_hlc")?;
    let _ = writeln!(out, "max_hlc: {max_hlc}");
    let _ = writeln!(out, "updated: {}", readable(&max_hlc)?);
    let _ = writeln!(
        out,
        "root_hlc: {}",
        required_hlc(&document.root.hlc, "root_hlc")?
    );
    render_root_state(&mut out, &document.root);
    for line in &document.unknown_frontmatter {
        let _ = writeln!(out, "{line}");
    }
    out.push_str("---\n");

    // The heading is not a line start in the ordinary sense — `# ` is already in
    // front of it — but the reader refuses a title that begins `![`, so the one
    // character that has to keep its backslash is the same one.
    let title = escape_inline(&document.root.title, At::LineStart);
    if title.is_empty() {
        out.push_str("#\n");
    } else {
        let _ = writeln!(out, "# {title}");
    }
    render_note(&mut out, &document.root.note, 0);
    out.push('\n');

    let mut previous = String::new();
    for node in &document.nodes {
        render_node(&mut out, node, 0, &previous)?;
        previous = node.id.clone();
    }
    Ok(out.into_bytes())
}

/// The instant a stamp stands for, in a form a person can read.
///
/// `max_hlc` is base36 and says nothing to anyone opening the file; this is the
/// same fact in the one notation every editor, log and calendar agrees on. It is
/// derived rather than recorded, so it cannot drift from the stamp it describes.
///
/// UTC, and deliberately. The value has to be a function of the stamp alone: a
/// local offset would have two devices in different zones render different bytes
/// for one document, and each would then read the other's file as an edit and
/// write it back — a loop over a difference nobody made.
fn readable(stamp: &str) -> Result<String, String> {
    let millis = crate::hlc::Hlc::decode(stamp)?.millis();
    let millis = i64::try_from(millis).map_err(|_| "A stamp's time is out of range.".to_owned())?;
    chrono::DateTime::from_timestamp_millis(millis)
        .ok_or_else(|| "A stamp's time is out of range.".to_owned())
        .map(|at| at.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

/// Only what differs from the default is written: a file full of keys nobody
/// set is harder to read by hand, and every one of them is another line a merge
/// has to compare.
fn render_root_state(out: &mut String, root: &DocumentRoot) {
    match root.marker {
        Marker::Bullet => {}
        Marker::Todo => out.push_str("root_marker_kind: todo\n"),
        Marker::Ordered(start) => {
            out.push_str("root_marker_kind: ordered\n");
            if start != 1 {
                let _ = writeln!(out, "root_ordered_start: {start}");
            }
        }
    }
    if root.collapsed {
        out.push_str("root_collapsed: true\n");
    }
    if root.completed {
        out.push_str("root_completed: true\n");
    }
    if root.starred {
        out.push_str("root_starred: true\n");
    }
}

fn render_trash(document: &TrashDocument) -> Result<Vec<u8>, String> {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str("kind: yonalist-trash\n");
    let _ = writeln!(out, "format_version: {FORMAT_VERSION}");
    let max_hlc = required_hlc(&document.max_hlc, "max_hlc")?;
    let _ = writeln!(out, "max_hlc: {max_hlc}");
    let _ = writeln!(out, "updated: {}", readable(&max_hlc)?);
    out.push_str("---\n");
    let mut previous = String::new();
    for node in &document.nodes {
        render_node(&mut out, node, 0, &previous)?;
        previous = node.id.clone();
    }
    Ok(out.into_bytes())
}

fn render_node(
    out: &mut String,
    node: &DocumentNode,
    depth: usize,
    implied_previous: &str,
) -> Result<(), String> {
    field_fits(&node.note, "note")?;
    let indentation = "  ".repeat(depth);
    // A split line says nothing about the node beyond where it lives, and the
    // checkbox would be saying something: the child document's frontmatter is
    // what carries the marker.
    let split = matches!(node.body, NodeBody::Split { .. });
    let prefix = match (node.marker, node.completed) {
        _ if split => "- ",
        (Marker::Todo, false) => "- [ ] ",
        (Marker::Todo, true) => "- [x] ",
        _ => "- ",
    };
    let body = match &node.body {
        NodeBody::Text(text) => {
            field_fits(text, "text")?;
            escape_inline(text, At::LineStart)
        }
        NodeBody::Image(image) => render_image(image)?,
        NodeBody::Split { title, path } => {
            field_fits(title, "split title")?;
            format!("[{}]({path})", escape_inline(title, At::LinkLabel))
        }
    };
    let comment = render_comment(node, implied_previous)?;
    let _ = writeln!(out, "{indentation}{prefix}{body} {comment}");

    render_note(out, &node.note, depth + 1);
    let mut previous = String::new();
    for child in &node.children {
        render_node(out, child, depth + 1, &previous)?;
        previous = child.id.clone();
    }
    Ok(())
}

/// A note is a blockquote under the line it belongs to. An empty line inside it
/// keeps the `>` alone, so the block stays one block rather than two.
fn render_note(out: &mut String, note: &str, depth: usize) {
    if note.is_empty() {
        return;
    }
    let indentation = "  ".repeat(depth);
    for line in normalize_newlines(note).split('\n') {
        if line.is_empty() {
            let _ = writeln!(out, "{indentation}>");
        } else {
            let _ = writeln!(
                out,
                "{indentation}> {}",
                escape_markdown(line, At::LineStart)
            );
        }
    }
}

/// Token order is fixed, and each token appears only when it applies. A split
/// line carries no state tokens at all: the child document's frontmatter owns
/// that state, and two authorities would make the merge order matter.
fn render_comment(node: &DocumentNode, implied_previous: &str) -> Result<String, String> {
    let mut comment = format!(
        "<!-- yid: {} t: {}",
        canonical_uuid(&node.id)?,
        required_hlc(&node.hlc, "node t")?
    );
    let split = matches!(node.body, NodeBody::Split { .. });
    if !split {
        if node.starred {
            comment.push_str(" star");
        }
        match node.marker {
            Marker::Bullet => {}
            Marker::Todo => comment.push_str(" todo"),
            Marker::Ordered(start) => {
                let _ = write!(comment, " ordered: {start}");
            }
        }
        // A checkbox is the todo marker's notation, so a completed todo already
        // reads as `- [x]`. Anything else completed says so here instead.
        if node.completed && node.marker != Marker::Todo {
            comment.push_str(" done");
        }
    }
    if split {
        comment.push_str(" split");
    }
    // Omitted when it says only what the line order already says: a document in
    // creation order renders exactly as it did before this token existed, which
    // is what lets the format version stay where it is.
    if let Some((previous, claim)) = &node.place
        // An empty claim stamp means nothing has claimed this node's place yet,
        // which the line order already says.
        && !claim.is_empty()
        && (previous.as_str(), claim.as_str()) != (implied_previous, node.hlc.as_str())
    {
        let previous = if previous.is_empty() {
            String::new()
        } else {
            canonical_uuid(previous)?
        };
        let _ = write!(comment, " prev: {previous}@{claim}");
    }
    if let Some((parent, sort_key)) = &node.from {
        let parent = if parent == "root" {
            "root".to_owned()
        } else {
            canonical_uuid(parent)?
        };
        let _ = write!(comment, " from: {parent}@{sort_key}");
    }
    if !split && node.collapsed {
        comment.push_str(" collapsed");
    }
    for token in &node.unknown_tokens {
        comment.push(' ');
        comment.push_str(token);
    }
    comment.push_str(" -->");
    Ok(comment)
}

fn render_image(image: &ImageReference) -> Result<String, String> {
    field_fits(&image.original_name, "image name")?;
    if image.path.is_empty() {
        return Err("A rendered image needs a path.".to_owned());
    }
    let mut comment = format!(
        "<!-- ya: w: {} px: {}x{} bytes: {}",
        image.display_width, image.pixel_width, image.pixel_height, image.byte_size
    );
    for token in &image.unknown_tokens {
        comment.push(' ');
        comment.push_str(token);
    }
    comment.push_str(" -->");
    Ok(format!(
        "![{}]({}) {comment}",
        escape_inline(&image.original_name, At::LinkLabel),
        image.path
    ))
}

fn document_id(id: &DocumentId) -> Result<String, String> {
    match id {
        DocumentId::Home => Ok("root".to_owned()),
        DocumentId::Node(id) => canonical_uuid(id),
    }
}

fn canonical_uuid(value: &str) -> Result<String, String> {
    Uuid::parse_str(value)
        .map(|id| id.hyphenated().to_string())
        .map_err(|_| format!("A document id has to be a UUID: {value}"))
}

/// A node that has never been stamped must not reach the vault: without an HLC
/// the merge has nothing to order it by, and it would lose every comparison.
fn required_hlc(value: &str, field: &str) -> Result<String, String> {
    if value.is_empty() {
        return Err(format!("A rendered document needs {field}."));
    }
    Hlc::decode(value)
        .map(|hlc| hlc.encode())
        .map_err(|error| format!("A stamped {field} is invalid: {error}"))
}

fn field_fits(value: &str, field: &str) -> Result<(), String> {
    if value.len() > MAX_FIELD_BYTES {
        return Err(format!(
            "A {field} of {} bytes is over the {MAX_FIELD_BYTES} byte cap.",
            value.len()
        ));
    }
    Ok(())
}

fn normalize_newlines(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

/// Ported from the exporter unchanged. `<` becoming an entity is what keeps a
/// user's own `<!--` from ever turning into a node comment.
/// Where a value sits, which is the whole of what decides its escaping. A full
/// stop is a full stop in the middle of a sentence and a list marker at the
/// front of a line; the character alone cannot tell you which.
#[derive(Clone, Copy, Eq, PartialEq)]
enum At {
    /// The value's first character is the first thing on its line — a bullet's
    /// own text, a note line, the document's title.
    LineStart,
    /// Somewhere after the start of a line, where nothing can open a block.
    Inline,
    /// Inside a link's square brackets, where a `]` would close them early.
    LinkLabel,
}

/// Three characters are escaped wherever they appear and the rest earn it by
/// position.
///
/// `\` always doubles, or nothing else here could be undone. `&` and `<` always
/// become entities: `<` because a `<!--` a person typed would otherwise open the
/// management comment the parser reads state out of, and `&` because without it a
/// person who typed `&lt;` would find it had become `<` on the way back.
///
/// Everything else — the full stops, slashes, plus signs, brackets and dashes
/// that made these files a chore to read — is text.
fn escape_markdown(value: &str, at: At) -> String {
    let mut escaped = String::with_capacity(value.len());
    let marker = if at == At::LineStart {
        block_marker_at(value)
    } else {
        None
    };
    for (index, character) in value.char_indices() {
        // Before the character that closes the marker, which is not always the
        // first one: a backslash in front of the `1` of `1. ` escapes a digit and
        // leaves the list marker standing.
        if marker == Some(index) {
            escaped.push('\\');
        }
        match character {
            '\\' => escaped.push_str(r"\\"),
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '[' | ']' if at == At::LinkLabel => {
                escaped.push('\\');
                escaped.push(character);
            }
            character => escaped.push(character),
        }
    }
    escaped
}

/// Where this line needs a backslash to stay text, if anywhere. Asked once per
/// line, because a block can only be opened at its start.
///
/// The shapes are the ones this format's own reader looks for — a bullet, an
/// image, a heading — plus an ordered marker, which this reader does not use and
/// an editor the person opens the file in does.
fn block_marker_at(line: &str) -> Option<usize> {
    let after_marker = |rest: &str| rest.is_empty() || rest.starts_with([' ', '\t']);
    if let Some(rest) = line.strip_prefix(['-', '*', '+', '#']) {
        return after_marker(rest).then_some(0);
    }
    if let Some(rest) = line.strip_prefix('!') {
        return rest.starts_with('[').then_some(0);
    }
    // A leading `>` is deliberately not here. A note writes its own `> ` in
    // front of the line, and the reader takes one `>` and one space back off
    // again — so a second one survives the trip as the text it was. Nowhere else
    // does this format read a `>` as anything but a character.
    //
    // A run of digits closed by `.` or `)` and then a space. `1.5` closes into
    // nothing and stays a number.
    // Every digit is one byte, so the count is the index the marker sits at.
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    line[digits..]
        .strip_prefix(['.', ')'])
        .is_some_and(after_marker)
        .then_some(digits)
}

fn escape_inline(value: &str, at: At) -> String {
    // Only the first segment begins a line. The rest are joined onto it with a
    // literal `\n`, so nothing after the join can open a block — but a bracket
    // still closes a link wherever it sits.
    let later = match at {
        At::LinkLabel => At::LinkLabel,
        At::LineStart | At::Inline => At::Inline,
    };
    normalize_newlines(value)
        .split('\n')
        .enumerate()
        .map(|(index, segment)| escape_markdown(segment, if index == 0 { at } else { later }))
        .collect::<Vec<_>>()
        .join(r"\n")
}
