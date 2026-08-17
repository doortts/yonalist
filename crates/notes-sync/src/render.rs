//! Turns a document into the bytes that go in the vault. The same state has to
//! produce the same bytes every time — a re-render that only reorders keys
//! would look like an edit to every other device and start a merge over
//! nothing. Nothing here iterates a hash map or reads a clock.
//!
//! The body is the part a person reads, so it carries one `yid` per bullet and
//! nothing else. Everything markdown has nowhere to put goes in the single
//! footer comment at the bottom.

use crate::document::{
    BlockState, DocumentNode, DocumentRoot, Footer, ImageReference, Marker, NodeBody, PageDocument,
    TrashDocument, VaultFile,
};
use notes_core::is_block_id;
use std::collections::BTreeMap;
use std::fmt::Write;

pub const FORMAT_VERSION: u32 = 1;
/// The field cap exists so nothing reaches the vault that the parser would then
/// have to quarantine on the way back in. The depth and node-count caps are the
/// exporter's to check, since only it sees the whole document before deciding
/// to write.
pub const MAX_FIELD_BYTES: usize = 100_000;
/// The document id the trash file states in its footer. It has no `id` key of
/// its own — one trash per vault — but the footer's state map still needs a
/// document to hang the root under.
pub const TRASH_DOCUMENT_ID: &str = "yonalist-trash";

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
    let _ = writeln!(out, "id: {}", block_id(document.id.as_str())?);
    if let Some(parent) = &document.parent {
        let _ = writeln!(out, "parent: {}", block_id(parent)?);
    }
    // Zero is the default, and a key at its default would be one more line for
    // every merge to compare over nothing.
    if let Some(sort_key) = document.sort_key.filter(|key| *key != 0) {
        let _ = writeln!(out, "sort_key: {sort_key}");
    }
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

    render_nodes(&mut out, &document.nodes, 0)?;

    let mut state = BTreeMap::new();
    insert_state(&mut state, document.id.as_str(), root_state(&document.root));
    for node in &document.nodes {
        collect_state(&mut state, node);
    }
    render_footer(&mut out, &document.state_hash, &document.base, state)?;
    Ok(out.into_bytes())
}

fn render_trash(document: &TrashDocument) -> Result<Vec<u8>, String> {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str("kind: yonalist-trash\n");
    let _ = writeln!(out, "format_version: {FORMAT_VERSION}");
    out.push_str("---\n");
    render_nodes(&mut out, &document.nodes, 0)?;

    let mut state = BTreeMap::new();
    for node in &document.nodes {
        collect_state(&mut state, node);
    }
    render_footer(&mut out, &document.state_hash, &document.base, state)?;
    Ok(out.into_bytes())
}

/// One line, so the footer is one thing to replace rather than a block to
/// diff. Serde writes the struct in declaration order and every map in it is a
/// `BTreeMap`, so the same state produces the same bytes.
fn render_footer(
    out: &mut String,
    state_hash: &str,
    base: &str,
    state: BTreeMap<String, BlockState>,
) -> Result<(), String> {
    let footer = Footer {
        state_hash: state_hash.to_owned(),
        base: base.to_owned(),
        state,
    };
    let json = serde_json::to_string(&footer)
        .map_err(|error| format!("The footer could not be written: {error}"))?;
    out.push('\n');
    out.push_str("<!-- yonalist\n");
    out.push_str(&json);
    out.push_str("\n-->\n");
    Ok(())
}

/// Siblings are written together because a number is not a property of one row.
/// A run is the numbered rows standing together under one parent: it counts up
/// from the number its first row was typed with, and anything else between two
/// numbered siblings ends it. The outline draws them this way and so does the
/// PDF export, so the file showing anything else would be the odd one out.
fn render_nodes(out: &mut String, nodes: &[DocumentNode], depth: usize) -> Result<(), String> {
    let mut running: Option<i64> = None;
    for node in nodes {
        let number = match node.marker {
            Marker::Ordered(start) if !matches!(node.body, NodeBody::Split { .. }) => {
                // Markdown has no notation for a negative ordinal, and a file
                // this renderer cannot read back is one every device would
                // quarantine. Nothing in the app can reach a negative start, so
                // one in a row is damage, and drawing it as zero keeps the rest
                // of the document readable instead of stranding all of it.
                let number = running.map_or(start.max(0), |previous| previous + 1);
                running = Some(number);
                Some(number)
            }
            _ => {
                running = None;
                None
            }
        };
        render_node(out, node, depth, number)?;
    }
    Ok(())
}

fn render_node(
    out: &mut String,
    node: &DocumentNode,
    depth: usize,
    number: Option<i64>,
) -> Result<(), String> {
    field_fits(&node.note, "note")?;
    let indentation = "  ".repeat(depth);
    // A checkbox and a number are the markers' own notation, so a row draws
    // what it is rather than saying so in metadata. Nothing else on the line is
    // state.
    let boundary = matches!(node.body, NodeBody::Split { .. });
    let numbered;
    let prefix = match (node.marker, node.completed) {
        _ if boundary => "- ",
        (Marker::Todo, false) => "- [ ] ",
        (Marker::Todo, true) => "- [x] ",
        _ => match number {
            Some(number) => {
                numbered = format!("{number}. ");
                &numbered
            }
            None => "- ",
        },
    };
    let body = match &node.body {
        NodeBody::Text(text) => {
            field_fits(text, "text")?;
            escape_inline(text)
        }
        NodeBody::Image(image) => render_image(image)?,
        NodeBody::Split { title, path, .. } => {
            field_fits(title, "split title")?;
            format!("[{}]({path})", escape_label(title))
        }
    };
    let _ = writeln!(
        out,
        "{indentation}{prefix}{body} <!-- yid: {} -->",
        block_id(&node.id)?
    );

    render_note(out, &node.note, depth + 1);
    render_nodes(out, &node.children, depth + 1)?;
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
            let _ = writeln!(out, "{indentation}> {}", escape_line(line));
        }
    }
}

fn render_image(image: &ImageReference) -> Result<String, String> {
    field_fits(&image.original_name, "image name")?;
    if image.path.is_empty() {
        return Err("A rendered image needs a path.".to_owned());
    }
    Ok(format!(
        "![{}]({})",
        escape_label(&image.original_name),
        image.path
    ))
}

fn root_state(root: &DocumentRoot) -> BlockState {
    let mut state = BlockState {
        collapsed: root.collapsed,
        starred: root.starred,
        unknown: root.unknown_state.clone(),
        ..BlockState::default()
    };
    // The heading has no checkbox to draw, so unlike a bullet the root says
    // both of these here.
    if root.marker == Marker::Todo {
        state.marker = Some("todo".to_owned());
    }
    if root.completed {
        state.completed = true;
    }
    apply_marker(&mut state, root.marker);
    state
}

fn collect_state(state: &mut BTreeMap<String, BlockState>, node: &DocumentNode) {
    // A boundary is two representations of one block, and the child document is
    // the authority on all of it. Anything this side wrote would be a second
    // authority, and then the order the two files merged in would decide.
    if let NodeBody::Split { child_kind, .. } = &node.body {
        insert_state(
            state,
            &node.id,
            BlockState {
                child_kind: Some(child_kind.as_str().to_owned()),
                unknown: node.unknown_state.clone(),
                ..BlockState::default()
            },
        );
        for child in &node.children {
            collect_state(state, child);
        }
        return;
    }
    let mut entry = BlockState {
        collapsed: node.collapsed,
        starred: node.starred,
        unknown: node.unknown_state.clone(),
        ..BlockState::default()
    };
    // A todo already reads as `- [ ]` or `- [x]`; anything else completed has
    // nowhere on the line to say so.
    if node.completed && node.marker != Marker::Todo {
        entry.completed = true;
    }
    match &node.body {
        NodeBody::Image(image) => {
            entry.width = Some(image.display_width);
            entry.pixel_width = Some(image.pixel_width);
            entry.pixel_height = Some(image.pixel_height);
            entry.byte_size = Some(image.byte_size);
            if !image.asset_hash.is_empty() {
                entry.asset_hash = Some(image.asset_hash.clone());
            }
        }
        NodeBody::Split { .. } => unreachable!("a boundary returned above"),
        NodeBody::Text(_) => {}
    }
    if let Some((parent, after)) = &node.from {
        entry.restore_parent = Some(parent.clone());
        entry.restore_after = Some(*after);
    }
    insert_state(state, &node.id, entry);
    for child in &node.children {
        collect_state(state, child);
    }
}

/// Ordered is the one marker the body cannot draw: rendering it as `1.` would
/// make the number a second authority on where the list starts.
fn apply_marker(state: &mut BlockState, marker: Marker) {
    if let Marker::Ordered(start) = marker {
        state.marker = Some("ordered".to_owned());
        if start != 1 {
            state.ordered_start = Some(start);
        }
    }
}

fn insert_state(state: &mut BTreeMap<String, BlockState>, id: &str, entry: BlockState) {
    if entry == BlockState::default() {
        return;
    }
    state.insert(id.to_owned(), entry);
}

fn block_id(value: &str) -> Result<String, String> {
    if is_block_id(value) {
        return Ok(value.to_owned());
    }
    Err(format!("A block id has to be a yid: {value}"))
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

/// Only what actually opens markdown syntax. Escaping every ASCII punctuation
/// mark is what made the old files unreadable: a sentence full of `\.` and
/// `\+` is not a sentence anyone wants to edit by hand.
fn escape_markdown(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(at) = rest.find(['\\', '&', '<']) {
        escaped.push_str(&rest[..at]);
        let tail = &rest[at..];
        match tail.as_bytes()[0] {
            b'\\' => {
                escaped.push_str("\\\\");
                rest = &tail[1..];
            }
            b'&' => {
                escaped.push_str("&amp;");
                rest = &tail[1..];
            }
            // A user's own `<` is ordinary text and stays one. Only the two
            // openers that would turn into this format's own comments have to
            // go, or a line could carry a second `yid`.
            _ if tail.starts_with("<!-- yid:") || tail.starts_with("<!-- yonalist") => {
                escaped.push_str("&lt;");
                rest = &tail[1..];
            }
            _ => {
                escaped.push('<');
                rest = &tail[1..];
            }
        }
    }
    escaped.push_str(rest);
    escaped
}

/// What a line may not open with. Inside a list item markdown still reads a
/// heading, a quote or a nested list, and `[ ]` would become a checkbox that
/// nobody ticked.
fn escape_line(value: &str) -> String {
    let escaped = escape_markdown(value);
    let mut characters = escaped.char_indices();
    match characters.next() {
        Some((_, '#' | '>' | '-' | '*' | '+' | '[')) => format!("\\{escaped}"),
        Some((_, first)) if first.is_ascii_digit() => {
            let end = escaped
                .find(|character: char| !character.is_ascii_digit())
                .unwrap_or(escaped.len());
            if matches!(escaped[end..].as_bytes().first(), Some(b'.' | b')')) {
                format!("{}\\{}", &escaped[..end], &escaped[end..])
            } else {
                escaped
            }
        }
        _ => escaped,
    }
}

fn escape_inline(value: &str) -> String {
    normalize_newlines(value)
        .split('\n')
        .map(escape_line)
        .collect::<Vec<_>>()
        .join(r"\n")
}

/// A link label sits inside `[…]`, so the one character that would close it
/// early needs a backslash on top of the ordinary escaping.
fn escape_label(value: &str) -> String {
    escape_inline(value).replace(']', "\\]")
}
