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
    let _ = writeln!(
        out,
        "max_hlc: {}",
        required_hlc(&document.max_hlc, "max_hlc")?
    );
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

    let title = escape_inline(&document.root.title);
    if title.is_empty() {
        out.push_str("#\n");
    } else {
        let _ = writeln!(out, "# {title}");
    }
    render_note(&mut out, &document.root.note, 0);
    out.push('\n');

    for node in &document.nodes {
        render_node(&mut out, node, 0)?;
    }
    Ok(out.into_bytes())
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
    let _ = writeln!(
        out,
        "max_hlc: {}",
        required_hlc(&document.max_hlc, "max_hlc")?
    );
    out.push_str("---\n");
    for node in &document.nodes {
        render_node(&mut out, node, 0)?;
    }
    Ok(out.into_bytes())
}

fn render_node(out: &mut String, node: &DocumentNode, depth: usize) -> Result<(), String> {
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
            escape_inline(text)
        }
        NodeBody::Image(image) => render_image(image)?,
        NodeBody::Split { title, path } => {
            field_fits(title, "split title")?;
            format!("[{}]({path})", escape_inline(title))
        }
    };
    let comment = render_comment(node)?;
    let _ = writeln!(out, "{indentation}{prefix}{body} {comment}");

    render_note(out, &node.note, depth + 1);
    for child in &node.children {
        render_node(out, child, depth + 1)?;
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
            let _ = writeln!(out, "{indentation}> {}", escape_markdown(line));
        }
    }
}

/// Token order is fixed, and each token appears only when it applies. A split
/// line carries no state tokens at all: the child document's frontmatter owns
/// that state, and two authorities would make the merge order matter.
fn render_comment(node: &DocumentNode) -> Result<String, String> {
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
        escape_inline(&image.original_name),
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
fn escape_markdown(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            character if character.is_ascii_punctuation() => {
                escaped.push('\\');
                escaped.push(character);
            }
            character => escaped.push(character),
        }
    }
    escaped
}

fn escape_inline(value: &str) -> String {
    normalize_newlines(value)
        .split('\n')
        .map(escape_markdown)
        .collect::<Vec<_>>()
        .join(r"\n")
}
