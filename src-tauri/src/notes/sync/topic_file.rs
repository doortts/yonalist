use crate::notes::export::{escape_inline, escape_markdown, normalize_newlines};
use crate::notes::hlc::Hlc;
use std::fmt::Write;
use uuid::Uuid;

pub(crate) const TOPIC_FORMAT_VERSION: u32 = 2;
pub(crate) const MAX_TOPIC_FILE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TopicDoc {
    pub(crate) id: String,
    pub(crate) sort_key: i64,
    pub(crate) max_hlc: String,
    pub(crate) root: TopicRoot,
    pub(crate) nodes: Vec<TopicNode>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TopicRoot {
    pub(crate) title: String,
    pub(crate) hlc: String,
    pub(crate) starred: bool,
    pub(crate) completed_at: Option<String>,
    pub(crate) archived_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TrashDoc {
    pub(crate) max_hlc: String,
    pub(crate) purged: Vec<PurgedTombstone>,
    pub(crate) nodes: Vec<TopicNode>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PurgedTombstone {
    pub(crate) id: String,
    pub(crate) hlc: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TopicNode {
    pub(crate) id: Option<String>,
    pub(crate) hlc: String,
    pub(crate) starred: bool,
    pub(crate) completed: bool,
    pub(crate) content: TopicContent,
    pub(crate) note: String,
    pub(crate) from: Option<(String, i64)>,
    /// One-based position among siblings as it appeared in the Markdown file.
    pub(crate) sibling_ordinal: usize,
    /// Reconstructed as `sibling_ordinal * SORT_KEY_STEP`; never rendered.
    pub(crate) sort_key: i64,
    pub(crate) children: Vec<TopicNode>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TopicContent {
    Text(String),
    Image {
        before: String,
        attachment: TopicAttachment,
        after: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TopicAttachment {
    pub(crate) content_hash: String,
    pub(crate) extension: String,
    /// Canonical percent-encoded filename, retained without lossy decoding.
    pub(crate) encoded_original_name: String,
    pub(crate) display_width: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TopicFile {
    Topic(TopicDoc),
    Trash(TrashDoc),
}

pub(crate) fn render_topic_doc(document: &TopicDoc) -> Result<Vec<u8>, String> {
    let mut markdown = String::new();
    let id = canonical_uuid(&document.id)?;
    let max_hlc = canonical_hlc(&document.max_hlc)?;
    let root_hlc = canonical_hlc(&document.root.hlc)?;
    let completed_at = canonical_optional_frontmatter_value(&document.root.completed_at)?;
    let archived_at = canonical_optional_frontmatter_value(&document.root.archived_at)?;

    writeln!(markdown, "---").expect("writing to a String cannot fail");
    writeln!(markdown, "kind: yonalist-notes").expect("writing to a String cannot fail");
    writeln!(markdown, "format_version: {TOPIC_FORMAT_VERSION}")
        .expect("writing to a String cannot fail");
    writeln!(markdown, "id: {id}").expect("writing to a String cannot fail");
    writeln!(markdown, "sort_key: {}", document.sort_key).expect("writing to a String cannot fail");
    writeln!(markdown, "max_hlc: {max_hlc}").expect("writing to a String cannot fail");
    writeln!(markdown, "root_hlc: {root_hlc}").expect("writing to a String cannot fail");
    writeln!(markdown, "root_starred: {}", document.root.starred)
        .expect("writing to a String cannot fail");
    writeln!(markdown, "root_completed_at: {completed_at}")
        .expect("writing to a String cannot fail");
    writeln!(markdown, "root_archived_at: {archived_at}").expect("writing to a String cannot fail");
    writeln!(markdown, "---").expect("writing to a String cannot fail");
    writeln!(markdown, "# {}", escape_inline(&document.root.title))
        .expect("writing to a String cannot fail");
    writeln!(markdown).expect("writing to a String cannot fail");

    for node in &document.nodes {
        render_node(&mut markdown, node, 0)?;
    }
    Ok(markdown.into_bytes())
}

pub(crate) fn render_trash_doc(document: &TrashDoc) -> Result<Vec<u8>, String> {
    let mut markdown = String::new();
    let max_hlc = canonical_hlc(&document.max_hlc)?;
    writeln!(markdown, "---").expect("writing to a String cannot fail");
    writeln!(markdown, "kind: yonalist-trash").expect("writing to a String cannot fail");
    writeln!(markdown, "format_version: {TOPIC_FORMAT_VERSION}")
        .expect("writing to a String cannot fail");
    writeln!(markdown, "max_hlc: {max_hlc}").expect("writing to a String cannot fail");

    let mut purged = document.purged.iter().collect::<Vec<_>>();
    purged.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.hlc.cmp(&right.hlc))
    });
    for tombstone in purged {
        writeln!(
            markdown,
            "purged: {} {}",
            canonical_uuid(&tombstone.id)?,
            canonical_hlc(&tombstone.hlc)?
        )
        .expect("writing to a String cannot fail");
    }
    writeln!(markdown, "---").expect("writing to a String cannot fail");
    for node in &document.nodes {
        render_node(&mut markdown, node, 0)?;
    }
    Ok(markdown.into_bytes())
}

pub(crate) fn render_topic_file(document: &TopicFile) -> Result<Vec<u8>, String> {
    match document {
        TopicFile::Topic(topic) => render_topic_doc(topic),
        TopicFile::Trash(trash) => render_trash_doc(trash),
    }
}

fn render_node(markdown: &mut String, node: &TopicNode, depth: usize) -> Result<(), String> {
    let indentation = "  ".repeat(depth);
    let completion = if node.completed { 'x' } else { ' ' };
    let comment = render_node_comment(node)?;
    match &node.content {
        TopicContent::Text(title) => {
            writeln!(
                markdown,
                "{indentation}- [{completion}] {} {comment}",
                escape_inline(title)
            )
            .expect("writing to a String cannot fail");
        }
        TopicContent::Image {
            before,
            attachment,
            after,
        } => {
            if before.is_empty() {
                writeln!(
                    markdown,
                    "{indentation}- [{completion}] {} {comment}",
                    render_image_atom(attachment)?
                )
                .expect("writing to a String cannot fail");
            } else {
                writeln!(
                    markdown,
                    "{indentation}- [{completion}] {} {comment}",
                    escape_inline(before)
                )
                .expect("writing to a String cannot fail");
                let continuation_indentation = "  ".repeat(depth + 1);
                writeln!(
                    markdown,
                    "{continuation_indentation}{}",
                    render_image_atom(attachment)?
                )
                .expect("writing to a String cannot fail");
            }
            if !after.is_empty() {
                let continuation_indentation = "  ".repeat(depth + 1);
                writeln!(
                    markdown,
                    "{continuation_indentation}{}",
                    escape_inline(after)
                )
                .expect("writing to a String cannot fail");
            }
        }
    }

    if !node.note.is_empty() {
        let note_indentation = "  ".repeat(depth + 1);
        for line in normalize_newlines(&node.note).split('\n') {
            if line.is_empty() {
                writeln!(markdown, "{note_indentation}>").expect("writing to a String cannot fail");
            } else {
                writeln!(markdown, "{note_indentation}> {}", escape_markdown(line))
                    .expect("writing to a String cannot fail");
            }
        }
    }

    for child in &node.children {
        render_node(markdown, child, depth + 1)?;
    }
    Ok(())
}

fn render_node_comment(node: &TopicNode) -> Result<String, String> {
    let id = node
        .id
        .as_deref()
        .ok_or_else(|| "A rendered topic node needs a UUID.".to_string())
        .and_then(canonical_uuid)?;
    let hlc = canonical_hlc(&node.hlc)?;
    if hlc.is_empty() {
        return Err("A rendered topic node needs an HLC.".to_string());
    }
    let mut comment = format!("<!-- yid: {id} t: {hlc}");
    if node.starred {
        comment.push_str(" star");
    }
    if let Some((parent_id, sort_key)) = &node.from {
        write!(comment, " from: {}@{sort_key}", canonical_uuid(parent_id)?)
            .expect("writing to a String cannot fail");
    }
    comment.push_str(" -->");
    Ok(comment)
}

fn render_image_atom(attachment: &TopicAttachment) -> Result<String, String> {
    let hash = canonical_asset_hash(&attachment.content_hash)?;
    let extension = canonical_asset_extension(&attachment.extension)?;
    validate_encoded_original_name(&attachment.encoded_original_name)?;
    let width = attachment
        .display_width
        .map_or_else(|| "-".to_string(), |width| width.to_string());
    Ok(format!(
        "![Image](.yonalist/notes-assets/{hash}.{extension}) <!-- ya: name: {} w: {width} -->",
        attachment.encoded_original_name
    ))
}

fn canonical_uuid(value: &str) -> Result<String, String> {
    Uuid::parse_str(value)
        .map(|id| id.hyphenated().to_string())
        .map_err(|_| "A topic ID must be a UUID.".to_string())
}

fn canonical_hlc(value: &str) -> Result<String, String> {
    if value.is_empty() {
        return Ok(String::new());
    }
    Hlc::decode(value)
        .and_then(|hlc| hlc.encode())
        .map_err(|error| format!("A topic HLC is invalid: {error}"))
}

fn canonical_optional_frontmatter_value(value: &Option<String>) -> Result<String, String> {
    match value {
        Some(value) if !value.is_empty() && !value.contains(['\r', '\n']) => Ok(value.clone()),
        Some(_) => Err("A topic frontmatter value must be one nonempty line.".to_string()),
        None => Ok("null".to_string()),
    }
}

pub(crate) fn canonical_asset_hash(value: &str) -> Result<String, String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("A topic image hash must be 64 hexadecimal characters.".to_string());
    }
    Ok(value.to_ascii_lowercase())
}

pub(crate) fn canonical_asset_extension(value: &str) -> Result<String, String> {
    let canonical = value.to_ascii_lowercase();
    if !matches!(canonical.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif") {
        return Err("A topic image extension is unsupported.".to_string());
    }
    Ok(canonical)
}

pub(crate) fn validate_encoded_original_name(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("A topic image original name is required.".to_string());
    }
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'~' => index += 1,
            b'%' if index + 2 < bytes.len()
                && bytes[index + 1].is_ascii_hexdigit()
                && bytes[index + 2].is_ascii_hexdigit()
                && !bytes[index + 1].is_ascii_lowercase()
                && !bytes[index + 2].is_ascii_lowercase() =>
            {
                index += 3;
            }
            _ => {
                return Err(
                    "A topic image original name is not canonically percent encoded.".to_string(),
                )
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{render_topic_doc, TopicAttachment, TopicContent, TopicDoc, TopicNode, TopicRoot};

    const GOLDEN: &str = include_str!("fixtures/topic_golden.md");

    #[test]
    fn renders_the_committed_topic_fixture_exactly() {
        assert_eq!(
            render_topic_doc(&golden_topic()).unwrap(),
            GOLDEN.as_bytes()
        );
    }

    #[test]
    fn repeated_rendering_is_byte_deterministic() {
        let topic = golden_topic();
        assert_eq!(
            render_topic_doc(&topic).unwrap(),
            render_topic_doc(&topic).unwrap()
        );
    }

    fn golden_topic() -> TopicDoc {
        TopicDoc {
            id: "11111111-1111-4111-8111-111111111111".to_string(),
            sort_key: 1024,
            max_hlc: "0swkd7qz3-01-a3f2".to_string(),
            root: TopicRoot {
                title: "Groceries & Supplies".to_string(),
                hlc: "0swkd7qz2-00-a3f2".to_string(),
                starred: true,
                completed_at: Some("2026-07-21T00:00:00Z".to_string()),
                archived_at: None,
            },
            nodes: vec![
                TopicNode {
                    id: Some("22222222-2222-4222-8222-222222222222".to_string()),
                    hlc: "0swkd7qz4-00-a3f2".to_string(),
                    starred: true,
                    completed: false,
                    content: TopicContent::Text("Milk & bread".to_string()),
                    note: "first note\n\nsecond > line".to_string(),
                    from: None,
                    sibling_ordinal: 1,
                    sort_key: 1024,
                    children: vec![],
                },
                TopicNode {
                    id: Some("33333333-3333-4333-8333-333333333333".to_string()),
                    hlc: "0swkd7qz5-00-a3f2".to_string(),
                    starred: false,
                    completed: true,
                    content: TopicContent::Image {
                        before: "Before".to_string(),
                        attachment: TopicAttachment {
                            content_hash:
                                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                                    .to_string(),
                            extension: "png".to_string(),
                            encoded_original_name: "photo%20one.png".to_string(),
                            display_width: Some(320),
                        },
                        after: "After ! text".to_string(),
                    },
                    note: String::new(),
                    from: None,
                    sibling_ordinal: 2,
                    sort_key: 2048,
                    children: vec![TopicNode {
                        id: Some("44444444-4444-4444-8444-444444444444".to_string()),
                        hlc: "0swkd7qz6-00-a3f2".to_string(),
                        starred: false,
                        completed: false,
                        content: TopicContent::Text("Child".to_string()),
                        note: String::new(),
                        from: Some(("55555555-5555-4555-8555-555555555555".to_string(), 2048)),
                        sibling_ordinal: 1,
                        sort_key: 1024,
                        children: vec![],
                    }],
                },
            ],
        }
    }
}
