use crate::notes::hlc::Hlc;
use crate::notes::markdown_import::MAX_MARKDOWN_BYTES;
use crate::notes::repository::SORT_KEY_STEP;
use crate::notes::sync::topic_file::{
    canonical_asset_extension, canonical_asset_hash, is_app_timestamp,
    validate_encoded_original_name, PurgedTombstone, TopicAttachment, TopicContent, TopicDoc,
    TopicFile, TopicNode, TopicRoot, TrashDoc, TOPIC_FORMAT_VERSION,
};
use crate::notes::types::{
    MAX_IMPORT_SUBTREE_DEPTH, MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES, MAX_IMPORT_SUBTREE_NODES,
};
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TopicParseOutcome {
    Parsed(TopicFile),
    Quarantined(TopicQuarantine),
}

/// Whole-file error information for a later sync runtime to record and notify
/// about without receiving a partially parsed document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TopicQuarantine {
    pub(crate) error: TopicParseError,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TopicParseError {
    FileTooLarge,
    InvalidUtf8,
    InvalidFrontmatter,
    MissingTopicId,
    InvalidTopicId,
    UnsupportedFormatVersion(u32),
    InvalidDocument,
    InvalidAssetLink,
    DepthLimitExceeded,
    NodeLimitExceeded,
}

pub(crate) fn parse_topic_file(bytes: &[u8]) -> TopicParseOutcome {
    if bytes.len() > MAX_MARKDOWN_BYTES {
        return quarantine(TopicParseError::FileTooLarge);
    }
    let source = match std::str::from_utf8(bytes) {
        Ok(source) => source,
        Err(_) => return quarantine(TopicParseError::InvalidUtf8),
    };
    // The allocation happens only after the on-disk byte cap is checked.
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    match parse_normalized(&normalized) {
        Ok(document) => TopicParseOutcome::Parsed(document),
        Err(error) => quarantine(error),
    }
}

fn quarantine(error: TopicParseError) -> TopicParseOutcome {
    TopicParseOutcome::Quarantined(TopicQuarantine { error })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DocumentKind {
    Topic,
    Trash,
}

#[derive(Default)]
struct Frontmatter {
    kind: Option<DocumentKind>,
    format_version: Option<u32>,
    id: Option<String>,
    sort_key: Option<i64>,
    max_hlc: Option<String>,
    root_hlc: Option<String>,
    root_starred: Option<bool>,
    root_completed_at: Option<Option<String>>,
    root_archived_at: Option<Option<String>>,
    purged: Vec<PurgedTombstone>,
}

fn parse_normalized(source: &str) -> Result<TopicFile, TopicParseError> {
    let mut lines = source.split('\n').peekable();
    if lines.next() != Some("---") {
        return Err(TopicParseError::InvalidFrontmatter);
    }
    let frontmatter = parse_frontmatter(&mut lines)?;
    let format_version = frontmatter.format_version.unwrap_or(TOPIC_FORMAT_VERSION);
    if format_version > TOPIC_FORMAT_VERSION {
        return Err(TopicParseError::UnsupportedFormatVersion(format_version));
    }
    let kind = frontmatter.kind.unwrap_or(DocumentKind::Topic);

    match kind {
        DocumentKind::Topic => {
            let id = frontmatter.id.ok_or(TopicParseError::MissingTopicId)?;
            if !is_uuid(&id) {
                return Err(TopicParseError::InvalidTopicId);
            }
            let heading = lines.next().ok_or(TopicParseError::InvalidDocument)?;
            let title = heading
                .strip_prefix("# ")
                .ok_or(TopicParseError::InvalidDocument)?;
            if title.contains("![") {
                return Err(TopicParseError::InvalidAssetLink);
            }
            let title = unescape_inline(title)?;
            if lines.peek() == Some(&"") {
                lines.next();
            }
            let nodes = parse_nodes(&mut lines)?;
            let root = TopicRoot {
                title,
                hlc: parse_hlc_or_empty(frontmatter.root_hlc.as_deref()),
                starred: frontmatter.root_starred.unwrap_or(false),
                completed_at: frontmatter.root_completed_at.unwrap_or(None),
                archived_at: frontmatter.root_archived_at.unwrap_or(None),
            };
            return Ok(TopicFile::Topic(TopicDoc {
                id,
                sort_key: frontmatter.sort_key.unwrap_or(0),
                max_hlc: parse_hlc_or_empty(frontmatter.max_hlc.as_deref()),
                root,
                nodes,
            }));
        }
        DocumentKind::Trash => Ok(TopicFile::Trash(TrashDoc {
            max_hlc: parse_hlc_or_empty(frontmatter.max_hlc.as_deref()),
            purged: frontmatter.purged,
            nodes: parse_nodes(&mut lines)?,
        })),
    }
}

fn parse_frontmatter<'a>(
    lines: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<Frontmatter, TopicParseError> {
    let mut frontmatter = Frontmatter::default();
    let mut seen_scalars = HashSet::new();
    loop {
        let line = lines.next().ok_or(TopicParseError::InvalidFrontmatter)?;
        if line == "---" {
            return Ok(frontmatter);
        }
        let Some((key, remainder)) = line.split_once(':') else {
            continue;
        };
        let recognized_scalar = matches!(
            key,
            "kind"
                | "format_version"
                | "id"
                | "sort_key"
                | "max_hlc"
                | "root_hlc"
                | "root_starred"
                | "root_completed_at"
                | "root_archived_at"
        );
        if !recognized_scalar && key != "purged" {
            continue;
        }
        let value = remainder
            .strip_prefix(' ')
            .ok_or(TopicParseError::InvalidFrontmatter)?;
        if recognized_scalar && !seen_scalars.insert(key) {
            return Err(TopicParseError::InvalidFrontmatter);
        }
        match key {
            "kind" => {
                frontmatter.kind = match value {
                    "yonalist-notes" => Some(DocumentKind::Topic),
                    "yonalist-trash" => Some(DocumentKind::Trash),
                    _ => return Err(TopicParseError::InvalidFrontmatter),
                };
            }
            "format_version" => {
                frontmatter.format_version = Some(
                    value
                        .parse::<u32>()
                        .map_err(|_| TopicParseError::InvalidFrontmatter)?,
                );
            }
            "id" => frontmatter.id = Some(value.to_string()),
            "sort_key" => {
                frontmatter.sort_key = Some(
                    value
                        .parse::<i64>()
                        .map_err(|_| TopicParseError::InvalidFrontmatter)?,
                );
            }
            "max_hlc" => frontmatter.max_hlc = Some(value.to_string()),
            "root_hlc" => frontmatter.root_hlc = Some(value.to_string()),
            "root_starred" => {
                frontmatter.root_starred = Some(match value {
                    "true" => true,
                    "false" => false,
                    _ => return Err(TopicParseError::InvalidFrontmatter),
                });
            }
            "root_completed_at" => {
                frontmatter.root_completed_at = Some(parse_optional_timestamp(value)?);
            }
            "root_archived_at" => {
                frontmatter.root_archived_at = Some(parse_optional_timestamp(value)?);
            }
            "purged" => {
                frontmatter.purged.push(parse_purged_tombstone(value)?);
            }
            _ => {}
        }
    }
}

fn parse_optional_timestamp(value: &str) -> Result<Option<String>, TopicParseError> {
    if value == "null" {
        return Ok(None);
    }
    is_app_timestamp(value)
        .then(|| Some(value.to_string()))
        .ok_or(TopicParseError::InvalidFrontmatter)
}

fn parse_purged_tombstone(value: &str) -> Result<PurgedTombstone, TopicParseError> {
    let mut fields = value.split_whitespace();
    let id = fields.next().ok_or(TopicParseError::InvalidFrontmatter)?;
    let hlc = fields.next().ok_or(TopicParseError::InvalidFrontmatter)?;
    if fields.next().is_some() || !is_uuid(id) {
        return Err(TopicParseError::InvalidFrontmatter);
    }
    Ok(PurgedTombstone {
        id: id.to_string(),
        hlc: parse_hlc_or_empty(Some(hlc)),
    })
}

#[derive(Debug)]
struct FlatNode {
    parent: Option<usize>,
    depth: usize,
    title: String,
    attachment: Option<TopicAttachment>,
    after: String,
    note: String,
    id: Option<String>,
    hlc: String,
    starred: bool,
    completed: bool,
    from: Option<(String, i64)>,
    note_lines: usize,
    note_started: bool,
    after_started: bool,
}

fn parse_nodes<'a>(
    lines: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<Vec<TopicNode>, TopicParseError> {
    let mut nodes = Vec::new();
    let mut last_at_depth = Vec::<usize>::new();
    let mut node_ids = HashSet::new();
    while let Some(line) = lines.next() {
        if line.is_empty() {
            continue;
        }
        if let Some(bullet) = parse_bullet(line)? {
            if bullet.depth + 1 > MAX_IMPORT_SUBTREE_DEPTH {
                return Err(TopicParseError::DepthLimitExceeded);
            }
            if nodes.len() >= MAX_IMPORT_SUBTREE_NODES {
                return Err(TopicParseError::NodeLimitExceeded);
            }
            let depth = bullet.depth.min(last_at_depth.len());
            last_at_depth.truncate(depth);
            let parent = last_at_depth.last().copied();
            if let Some(id) = bullet.id.as_deref() {
                let parsed_id =
                    Uuid::parse_str(id).map_err(|_| TopicParseError::InvalidDocument)?;
                if !node_ids.insert(parsed_id) {
                    return Err(TopicParseError::InvalidDocument);
                }
            }
            let mut node = FlatNode {
                parent,
                depth,
                title: String::new(),
                attachment: None,
                after: String::new(),
                note: String::new(),
                id: bullet.id,
                hlc: bullet.hlc,
                starred: bullet.starred,
                completed: bullet.completed,
                from: bullet.from,
                note_lines: 0,
                note_started: false,
                after_started: false,
            };
            if bullet.primary.starts_with("![Image](") {
                node.attachment = Some(parse_image_atom(&bullet.primary)?);
            } else if bullet.primary.contains("![") {
                return Err(TopicParseError::InvalidAssetLink);
            } else {
                node.title = unescape_inline(&bullet.primary)?;
            }
            let index = nodes.len();
            nodes.push(node);
            last_at_depth.push(index);
            continue;
        }
        let node = nodes.last_mut().ok_or(TopicParseError::InvalidDocument)?;
        parse_continuation(node, line)?;
    }
    build_tree(nodes)
}

struct Bullet {
    depth: usize,
    completed: bool,
    primary: String,
    id: Option<String>,
    hlc: String,
    starred: bool,
    from: Option<(String, i64)>,
}

fn parse_bullet(line: &str) -> Result<Option<Bullet>, TopicParseError> {
    let (indentation, rest) = split_indentation(line);
    let Some(rest) = rest.strip_prefix("- ") else {
        return Ok(None);
    };
    let (completed, primary) = if let Some(primary) = rest.strip_prefix("[ ] ") {
        (false, primary)
    } else if let Some(primary) = rest.strip_prefix("[x] ") {
        (true, primary)
    } else {
        (false, rest)
    };
    let (primary, comment) = split_trailing_comment(primary);
    let metadata = comment
        .map(parse_node_comment)
        .transpose()?
        .unwrap_or_default();
    Ok(Some(Bullet {
        depth: indentation / 2,
        completed,
        primary: primary.to_string(),
        id: metadata.id,
        hlc: metadata.hlc,
        starred: metadata.starred,
        from: metadata.from,
    }))
}

fn split_indentation(line: &str) -> (usize, &str) {
    let mut indentation = 0;
    let mut byte_index = 0;
    for byte in line.bytes() {
        match byte {
            b' ' => {
                indentation += 1;
                byte_index += 1;
            }
            b'\t' => {
                indentation += 2;
                byte_index += 1;
            }
            _ => break,
        }
    }
    (indentation, &line[byte_index..])
}

fn split_trailing_comment(value: &str) -> (&str, Option<&str>) {
    let Some(start) = value.rfind("<!--") else {
        return (value.trim_end(), None);
    };
    let Some(comment) = value[start..]
        .strip_prefix("<!--")
        .and_then(|value| value.strip_suffix("-->"))
    else {
        return (value.trim_end(), None);
    };
    let comment = comment.trim();
    if comment.starts_with("ya:") {
        return (value.trim_end(), None);
    }
    if !comment
        .split_whitespace()
        .any(|token| matches!(token, "yid:" | "t:" | "star" | "from:"))
    {
        return (value.trim_end(), None);
    }
    (value[..start].trim_end(), Some(comment))
}

#[derive(Default)]
struct NodeComment {
    id: Option<String>,
    hlc: String,
    starred: bool,
    from: Option<(String, i64)>,
}

fn parse_node_comment(comment: &str) -> Result<NodeComment, TopicParseError> {
    let mut metadata = NodeComment::default();
    let tokens = comment.split_whitespace().collect::<Vec<_>>();
    let mut index = 0;
    let mut seen = HashSet::new();
    while index < tokens.len() {
        let token = tokens[index];
        index += 1;
        match token {
            "yid:" => {
                if !seen.insert("yid") {
                    return Err(TopicParseError::InvalidDocument);
                }
                let id = required_metadata_value(&tokens, &mut index)?;
                if !is_uuid(id) {
                    return Err(TopicParseError::InvalidDocument);
                }
                metadata.id = Some(id.to_string());
            }
            "t:" => {
                if !seen.insert("t") {
                    return Err(TopicParseError::InvalidDocument);
                }
                let value = tokens.get(index).copied();
                if value.is_some_and(|value| !is_known_node_metadata_token(value)) {
                    index += 1;
                    metadata.hlc = parse_hlc_or_empty(value);
                }
            }
            "star" => {
                if !seen.insert("star") {
                    return Err(TopicParseError::InvalidDocument);
                }
                metadata.starred = true;
            }
            "from:" => {
                if !seen.insert("from") {
                    return Err(TopicParseError::InvalidDocument);
                }
                let value = required_metadata_value(&tokens, &mut index)?;
                metadata.from =
                    Some(parse_restore_origin(value).ok_or(TopicParseError::InvalidDocument)?);
            }
            _ => {}
        }
    }
    Ok(metadata)
}

fn required_metadata_value<'a>(
    tokens: &[&'a str],
    index: &mut usize,
) -> Result<&'a str, TopicParseError> {
    let value = tokens
        .get(*index)
        .copied()
        .filter(|value| !is_known_node_metadata_token(value))
        .ok_or(TopicParseError::InvalidDocument)?;
    *index += 1;
    Ok(value)
}

fn is_known_node_metadata_token(value: &str) -> bool {
    matches!(value, "yid:" | "t:" | "star" | "from:")
}

fn parse_restore_origin(value: &str) -> Option<(String, i64)> {
    let (parent_id, sort_key) = value.rsplit_once('@')?;
    is_uuid(parent_id)
        .then(|| sort_key.parse::<i64>().ok())
        .flatten()
        .map(|sort_key| (parent_id.to_string(), sort_key))
}

fn parse_continuation(node: &mut FlatNode, line: &str) -> Result<(), TopicParseError> {
    let (indentation, content) = split_indentation(line);
    if indentation <= node.depth.saturating_mul(2) {
        return Err(TopicParseError::InvalidDocument);
    }
    if content.contains("![") && !content.starts_with("![Image](") {
        return Err(TopicParseError::InvalidAssetLink);
    }
    if content == ">" || content.starts_with("> ") {
        let note_line = if content == ">" {
            ""
        } else {
            content.strip_prefix("> ").unwrap_or_default()
        };
        let note_line = unescape_markdown(note_line)?;
        let separator = usize::from(node.note_lines != 0);
        let length = node
            .note
            .len()
            .checked_add(separator)
            .and_then(|length| length.checked_add(note_line.len()))
            .ok_or(TopicParseError::InvalidDocument)?;
        if length > MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES {
            return Err(TopicParseError::InvalidDocument);
        }
        if node.note_lines != 0 {
            node.note.push('\n');
        }
        node.note.push_str(&note_line);
        node.note_lines = node
            .note_lines
            .checked_add(1)
            .ok_or(TopicParseError::InvalidDocument)?;
        node.note_started = true;
        return Ok(());
    }
    if content.starts_with("![Image](") {
        if node.attachment.is_some() || node.note_started || node.after_started {
            return Err(TopicParseError::InvalidAssetLink);
        }
        node.attachment = Some(parse_image_atom(content)?);
        return Ok(());
    }
    if node.attachment.is_some() && !node.note_started {
        let after = unescape_inline(content)?;
        let separator = usize::from(node.after_started);
        let length = node
            .after
            .len()
            .checked_add(separator)
            .and_then(|length| length.checked_add(after.len()))
            .ok_or(TopicParseError::InvalidDocument)?;
        if length > MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES {
            return Err(TopicParseError::InvalidDocument);
        }
        if node.after_started {
            node.after.push('\n');
        }
        node.after.push_str(&after);
        node.after_started = true;
        return Ok(());
    }
    Err(TopicParseError::InvalidDocument)
}

fn parse_image_atom(value: &str) -> Result<TopicAttachment, TopicParseError> {
    let value = value
        .strip_prefix("![Image](")
        .ok_or(TopicParseError::InvalidAssetLink)?;
    let (link, metadata) = value
        .split_once(") ")
        .ok_or(TopicParseError::InvalidAssetLink)?;
    let metadata = metadata
        .strip_prefix("<!-- ya:")
        .and_then(|metadata| metadata.strip_suffix(" -->"))
        .ok_or(TopicParseError::InvalidAssetLink)?;
    let tokens = metadata.split_whitespace().collect::<Vec<_>>();
    let mut encoded_original_name = None;
    let mut width = None;
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        index += 1;
        match token {
            "name:" => {
                if encoded_original_name.is_some() {
                    return Err(TopicParseError::InvalidAssetLink);
                }
                let value = required_image_metadata_value(&tokens, &mut index)?;
                encoded_original_name = Some(value);
            }
            "w:" => {
                if width.is_some() {
                    return Err(TopicParseError::InvalidAssetLink);
                }
                let value = required_image_metadata_value(&tokens, &mut index)?;
                width = Some(value);
            }
            _ => {}
        }
    }
    let encoded_original_name = encoded_original_name.ok_or(TopicParseError::InvalidAssetLink)?;
    let width = width.ok_or(TopicParseError::InvalidAssetLink)?;
    validate_encoded_original_name(encoded_original_name)
        .map_err(|_| TopicParseError::InvalidAssetLink)?;
    let display_width = match width {
        "-" => None,
        value => {
            let parsed = value
                .parse::<i64>()
                .map_err(|_| TopicParseError::InvalidAssetLink)?;
            if parsed.to_string() != value {
                return Err(TopicParseError::InvalidAssetLink);
            }
            Some(parsed)
        }
    };
    let (content_hash, extension) = parse_canonical_asset_link(link)?;
    Ok(TopicAttachment {
        content_hash,
        extension,
        encoded_original_name: encoded_original_name.to_string(),
        display_width,
    })
}

fn required_image_metadata_value<'a>(
    tokens: &[&'a str],
    index: &mut usize,
) -> Result<&'a str, TopicParseError> {
    let value = tokens
        .get(*index)
        .copied()
        .filter(|value| !matches!(*value, "name:" | "w:"))
        .ok_or(TopicParseError::InvalidAssetLink)?;
    *index += 1;
    Ok(value)
}

fn parse_canonical_asset_link(link: &str) -> Result<(String, String), TopicParseError> {
    let filename = link
        .strip_prefix(".yonalist/notes-assets/")
        .ok_or(TopicParseError::InvalidAssetLink)?;
    if filename.contains(['/', '\\', '?', '#']) {
        return Err(TopicParseError::InvalidAssetLink);
    }
    let (hash, extension) = filename
        .rsplit_once('.')
        .ok_or(TopicParseError::InvalidAssetLink)?;
    let canonical_hash =
        canonical_asset_hash(hash).map_err(|_| TopicParseError::InvalidAssetLink)?;
    let canonical_extension =
        canonical_asset_extension(extension).map_err(|_| TopicParseError::InvalidAssetLink)?;
    if canonical_hash != hash || canonical_extension != extension {
        return Err(TopicParseError::InvalidAssetLink);
    }
    Ok((hash.to_string(), extension.to_string()))
}

fn parse_hlc_or_empty(value: Option<&str>) -> String {
    value
        .filter(|value| Hlc::decode(value).is_ok())
        .unwrap_or_default()
        .to_string()
}

fn is_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok()
}

fn unescape_inline(value: &str) -> Result<String, TopicParseError> {
    unescape(value, true)
}

fn unescape_markdown(value: &str) -> Result<String, TopicParseError> {
    unescape(value, false)
}

fn unescape(value: &str, inline: bool) -> Result<String, TopicParseError> {
    let mut decoded = String::with_capacity(value.len().min(MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES));
    let mut remaining = value;
    while !remaining.is_empty() {
        if let Some(rest) = remaining.strip_prefix("&amp;") {
            decoded.push('&');
            remaining = rest;
        } else if let Some(rest) = remaining.strip_prefix("&lt;") {
            decoded.push('<');
            remaining = rest;
        } else if let Some(rest) = remaining.strip_prefix("&gt;") {
            decoded.push('>');
            remaining = rest;
        } else if let Some(rest) = remaining.strip_prefix('\\') {
            if let Some(character) = rest.chars().next() {
                if inline && character == 'n' {
                    decoded.push('\n');
                    remaining = &rest[character.len_utf8()..];
                } else if character.is_ascii_punctuation() {
                    decoded.push(character);
                    remaining = &rest[character.len_utf8()..];
                } else {
                    decoded.push('\\');
                    remaining = rest;
                }
            } else {
                decoded.push('\\');
                remaining = rest;
            }
        } else if let Some(character) = remaining.chars().next() {
            decoded.push(character);
            remaining = &remaining[character.len_utf8()..];
        } else {
            break;
        }
        if decoded.len() > MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES {
            return Err(TopicParseError::InvalidDocument);
        }
    }
    Ok(decoded)
}

fn build_tree(nodes: Vec<FlatNode>) -> Result<Vec<TopicNode>, TopicParseError> {
    let mut children = (0..nodes.len()).map(|_| Vec::new()).collect::<Vec<_>>();
    let mut roots = Vec::new();
    for (index, node) in nodes.into_iter().enumerate().rev() {
        let mut node_children = std::mem::take(&mut children[index]);
        node_children.reverse();
        let content = match node.attachment {
            Some(attachment) => TopicContent::Image {
                before: node.title,
                attachment,
                after: node.after,
            },
            None => TopicContent::Text(node.title),
        };
        let parsed = TopicNode {
            id: node.id,
            hlc: node.hlc,
            starred: node.starred,
            completed: node.completed,
            content,
            note: node.note,
            from: node.from,
            sibling_ordinal: 0,
            sort_key: 0,
            children: node_children,
        };
        if let Some(parent) = node.parent {
            children
                .get_mut(parent)
                .ok_or(TopicParseError::InvalidDocument)?
                .push(parsed);
        } else {
            roots.push(parsed);
        }
    }
    roots.reverse();
    assign_sibling_positions(&mut roots)?;
    Ok(roots)
}

fn assign_sibling_positions(nodes: &mut [TopicNode]) -> Result<(), TopicParseError> {
    for (index, node) in nodes.iter_mut().enumerate() {
        let ordinal = index
            .checked_add(1)
            .ok_or(TopicParseError::NodeLimitExceeded)?;
        let ordinal_i64 = i64::try_from(ordinal).map_err(|_| TopicParseError::NodeLimitExceeded)?;
        node.sibling_ordinal = ordinal;
        node.sort_key = ordinal_i64
            .checked_mul(SORT_KEY_STEP)
            .ok_or(TopicParseError::NodeLimitExceeded)?;
        assign_sibling_positions(&mut node.children)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse_topic_file, TopicParseError, TopicParseOutcome};
    use crate::notes::markdown_import::MAX_MARKDOWN_BYTES;
    use crate::notes::repository::SORT_KEY_STEP;
    use crate::notes::sync::topic_file::{
        render_topic_file, render_trash_doc, PurgedTombstone, TopicAttachment, TopicContent,
        TopicDoc, TopicFile, TopicNode, TopicRoot, TrashDoc,
    };
    use crate::notes::types::{
        MAX_IMPORT_SUBTREE_DEPTH, MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES, MAX_IMPORT_SUBTREE_NODES,
    };

    const TOPIC_GOLDEN: &str = include_str!("fixtures/topic_golden.md");
    const TRASH_GOLDEN: &str = "---\nkind: yonalist-trash\nformat_version: 2\nmax_hlc: 0swkd7qz3-01-a3f2\npurged: 66666666-6666-4666-8666-666666666666 0swkd7qz7-00-a3f2\npurged: 77777777-7777-4777-8777-777777777777 0swkd7qz8-00-a3f2\n---\n- [ ] Deleted <!-- yid: 88888888-8888-4888-8888-888888888888 t: 0swkd7qz9-00-a3f2 from: 99999999-9999-4999-8999-999999999999@1024 -->\n  - [x] Child <!-- yid: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa t: 0swkd7qza-00-a3f2 -->\n";

    #[test]
    fn parses_and_renders_topic_golden_byte_identically() {
        let parsed = parsed(TOPIC_GOLDEN.as_bytes());
        assert_eq!(render_topic_file(&parsed).unwrap(), TOPIC_GOLDEN.as_bytes());
    }

    #[test]
    fn parses_and_renders_trash_with_purged_tombstones_byte_identically() {
        let parsed = parsed(TRASH_GOLDEN.as_bytes());
        assert!(matches!(parsed, TopicFile::Trash(_)));
        assert_eq!(render_topic_file(&parsed).unwrap(), TRASH_GOLDEN.as_bytes());
    }

    #[test]
    fn accepts_a_bullet_without_yid_for_later_write_back() {
        let topic = topic_document(parsed(topic("- New external bullet").as_bytes()));
        let node = &topic.nodes[0];
        assert_eq!(node.id, None);
        assert_eq!(node.hlc, "");
    }

    #[test]
    fn parses_image_only_bullet_without_node_metadata() {
        let topic = topic_document(parsed(
            topic(&image_bullet("png", "photo.png", "name: {name} w: -")).as_bytes(),
        ));
        let node = &topic.nodes[0];
        assert_eq!(node.id, None);
        assert_eq!(node.hlc, "");
        let TopicContent::Image { attachment, .. } = &node.content else {
            panic!("expected image")
        };
        assert_eq!(attachment.encoded_original_name, "photo.png");
    }

    #[test]
    fn treats_malformed_hlc_as_empty_without_quarantining() {
        let topic = topic_document(parsed(
            topic("- [ ] Draft <!-- yid: 22222222-2222-4222-8222-222222222222 t: too-new -->")
                .as_bytes(),
        ));
        assert_eq!(topic.nodes[0].hlc, "");
    }

    #[test]
    fn normalizes_odd_space_and_tab_indentation_to_two_space_depths() {
        let topic = topic_document(parsed(
            topic("- Root\n   - Odd child\n\t\t- Tab grandchild").as_bytes(),
        ));
        assert_eq!(topic.nodes[0].children[0].sibling_ordinal, 1);
        assert_eq!(topic.nodes[0].children[0].sort_key, SORT_KEY_STEP);
        assert_eq!(
            topic.nodes[0].children[0].children[0].sort_key,
            SORT_KEY_STEP
        );
    }

    #[test]
    fn treats_a_missing_checkbox_as_unchecked() {
        let topic = topic_document(parsed(topic("- No checkbox").as_bytes()));
        assert!(!topic.nodes[0].completed);
        assert!(matches!(topic.nodes[0].content, TopicContent::Text(_)));
    }

    #[test]
    fn defaults_missing_optional_frontmatter_fields() {
        let source = "---\nkind: yonalist-notes\nid: 11111111-1111-4111-8111-111111111111\n---\n# Root\n\n- Item\n";
        let topic = topic_document(parsed(source.as_bytes()));
        assert_eq!(topic.sort_key, 0);
        assert_eq!(topic.max_hlc, "");
        assert_eq!(topic.root.hlc, "");
        assert!(!topic.root.starred);
        assert_eq!(topic.root.completed_at, None);
        assert_eq!(topic.root.archived_at, None);
    }

    #[test]
    fn defaults_each_individually_missing_optional_frontmatter_field_including_kind() {
        let canonical = [
            "kind: yonalist-notes",
            "format_version: 2",
            "id: 11111111-1111-4111-8111-111111111111",
            "sort_key: 1024",
            "max_hlc: 0swkd7qz3-01-a3f2",
            "root_hlc: 0swkd7qz2-00-a3f2",
            "root_starred: true",
            "root_completed_at: 2026-07-21T00:00:00.000Z",
            "root_archived_at: 2026-07-21T01:02:03Z",
        ];
        for missing in [0, 1, 3, 4, 5, 6, 7, 8] {
            let frontmatter = canonical
                .iter()
                .enumerate()
                .filter(|(index, _)| *index != missing)
                .map(|(_, line)| *line)
                .collect::<Vec<_>>()
                .join("\n");
            assert!(matches!(
                parse_topic_file(topic_with_exact_frontmatter(&frontmatter, "- Item").as_bytes()),
                TopicParseOutcome::Parsed(TopicFile::Topic(_))
            ));
        }
    }

    #[test]
    fn quarantines_duplicate_recognized_frontmatter_fields() {
        for duplicate in [
            "kind: yonalist-notes",
            "format_version: 2",
            "id: 11111111-1111-4111-8111-111111111111",
            "sort_key: 1024",
            "max_hlc: 0swkd7qz3-01-a3f2",
            "root_hlc: 0swkd7qz2-00-a3f2",
            "root_starred: false",
            "root_completed_at: null",
            "root_archived_at: null",
        ] {
            let source = TOPIC_GOLDEN.replacen("---\n# ", &format!("{duplicate}\n---\n# "), 1);
            assert_any_quarantine(source.as_bytes());
        }
    }

    #[test]
    fn future_format_version_cannot_be_hidden_by_a_later_version_two() {
        let source = topic_with_exact_frontmatter(
            "kind: yonalist-notes\nformat_version: 3\nformat_version: 2\nid: 11111111-1111-4111-8111-111111111111",
            "- Item",
        );
        assert_any_quarantine(source.as_bytes());
    }

    #[test]
    fn quarantines_malformed_known_non_hlc_frontmatter_values() {
        for (key, value) in [
            ("sort_key", "not-an-integer"),
            ("root_starred", "TRUE"),
            ("root_starred", "yes"),
            ("root_completed_at", "2026-02-30T00:00:00Z"),
            ("root_completed_at", "2026-07-21 00:00:00Z"),
            ("root_completed_at", "2026-07-21T24:00:00Z"),
            ("root_archived_at", "2026-07-21T00:00:00"),
            ("root_archived_at", "2026-07-21T00:00:00.Z"),
        ] {
            let source = TOPIC_GOLDEN.replacen(
                &format!("{key}: {}", frontmatter_value(TOPIC_GOLDEN, key)),
                &format!("{key}: {value}"),
                1,
            );
            assert_any_quarantine(source.as_bytes());
        }
    }

    #[test]
    fn accepts_app_generated_utc_timestamp_forms() {
        for timestamp in ["2026-07-21T00:00:00Z", "2026-07-21T00:00:00.123Z"] {
            let source = TOPIC_GOLDEN.replacen(
                "root_completed_at: 2026-07-21T00:00:00Z",
                &format!("root_completed_at: {timestamp}"),
                1,
            );
            assert!(matches!(
                parse_topic_file(source.as_bytes()),
                TopicParseOutcome::Parsed(_)
            ));
        }
    }

    #[test]
    fn ignores_unknown_frontmatter_and_comment_tokens() {
        let source = topic_with_frontmatter(
            "future_key: compatible\n",
            "- [ ] Item <!-- yid: 22222222-2222-4222-8222-222222222222 future: token t: 0swkd7qz4-00-a3f2 unknown -->",
        );
        let topic = topic_document(parsed(source.as_bytes()));
        assert_eq!(
            topic.nodes[0].id.as_deref(),
            Some("22222222-2222-4222-8222-222222222222")
        );
        assert_eq!(topic.nodes[0].hlc, "0swkd7qz4-00-a3f2");
    }

    #[test]
    fn preserves_valid_remote_ids_and_hlcs_without_rewriting_them() {
        let source = topic(
            "- [ ] Item <!-- yid: ABCDEFAB-CDEF-4DEF-8DEF-ABCDEFABCDEF t: 0swkd7qz4-00-a3f2 -->",
        )
        .replacen(
            "id: 11111111-1111-4111-8111-111111111111",
            "id: ABCDEFAB-CDEF-4DEF-8DEF-ABCDEFABCDEF",
            1,
        );
        let topic = topic_document(parsed(source.as_bytes()));
        assert_eq!(topic.id, "ABCDEFAB-CDEF-4DEF-8DEF-ABCDEFABCDEF");
        assert_eq!(
            topic.nodes[0].id.as_deref(),
            Some("ABCDEFAB-CDEF-4DEF-8DEF-ABCDEFABCDEF")
        );
        assert_eq!(topic.nodes[0].hlc, "0swkd7qz4-00-a3f2");
    }

    #[test]
    fn normalizes_crlf_to_lf_before_parsing() {
        let crlf = TOPIC_GOLDEN.replace('\n', "\r\n");
        let parsed = parsed(crlf.as_bytes());
        assert_eq!(render_topic_file(&parsed).unwrap(), TOPIC_GOLDEN.as_bytes());
    }

    #[test]
    fn preserves_a_note_that_begins_with_a_blank_blockquote_line() {
        let source = TOPIC_GOLDEN.replace(
            "  > first note\n  >\n  > second &gt; line",
            "  >\n  > second line",
        );
        let parsed = parsed(source.as_bytes());
        assert_eq!(render_topic_file(&parsed).unwrap(), source.as_bytes());
    }

    #[test]
    fn quarantines_a_topic_missing_frontmatter_id() {
        let source = "---\nkind: yonalist-notes\nformat_version: 2\n---\n# Root\n\n- Item\n";
        assert_quarantined(source.as_bytes(), TopicParseError::MissingTopicId);
    }

    #[test]
    fn quarantines_an_invalid_topic_id() {
        let source = topic_with_exact_frontmatter(
            "kind: yonalist-notes\nformat_version: 2\nid: not-a-uuid",
            "- Item",
        );
        assert_quarantined(source.as_bytes(), TopicParseError::InvalidTopicId);
    }

    #[test]
    fn quarantines_future_format_versions() {
        let source = topic_with_exact_frontmatter(
            "kind: yonalist-notes\nformat_version: 3\nid: 11111111-1111-4111-8111-111111111111",
            "- Item",
        );
        assert_quarantined(
            source.as_bytes(),
            TopicParseError::UnsupportedFormatVersion(3),
        );
    }

    #[test]
    fn quarantines_present_invalid_missing_or_duplicate_identity_tokens() {
        for comment in [
            "yid: invalid t: 0swkd7qz4-00-a3f2",
            "yid: t: 0swkd7qz4-00-a3f2",
            "yid: 22222222-2222-4222-8222-222222222222 yid: 33333333-3333-4333-8333-333333333333 t: 0swkd7qz4-00-a3f2",
            "yid: 22222222-2222-4222-8222-222222222222 t: 0swkd7qz4-00-a3f2 t: 0swkd7qz5-00-a3f2",
            "yid: 22222222-2222-4222-8222-222222222222 t: 0swkd7qz4-00-a3f2 from: invalid@1024",
            "yid: 22222222-2222-4222-8222-222222222222 t: 0swkd7qz4-00-a3f2 from:",
            "yid: 22222222-2222-4222-8222-222222222222 t: 0swkd7qz4-00-a3f2 from: 33333333-3333-4333-8333-333333333333@x",
            "yid: 22222222-2222-4222-8222-222222222222 t: 0swkd7qz4-00-a3f2 from: 33333333-3333-4333-8333-333333333333@1024 from: 44444444-4444-4444-8444-444444444444@2048",
            "yid: 22222222-2222-4222-8222-222222222222 t: 0swkd7qz4-00-a3f2 star star",
        ] {
            assert_any_quarantine(topic(&format!("- Item <!-- {comment} -->")).as_bytes());
        }
    }

    #[test]
    fn missing_or_malformed_t_is_empty_but_duplicate_t_quarantines() {
        for comment in [
            "yid: 22222222-2222-4222-8222-222222222222",
            "yid: 22222222-2222-4222-8222-222222222222 t:",
            "yid: 22222222-2222-4222-8222-222222222222 t: malformed",
        ] {
            let topic = topic_document(parsed(
                topic(&format!("- Item <!-- {comment} -->")).as_bytes(),
            ));
            assert_eq!(topic.nodes[0].hlc, "");
        }
    }

    #[test]
    fn quarantines_duplicate_valid_node_ids_within_one_file() {
        let source = topic(
            "- First <!-- yid: 22222222-2222-4222-8222-222222222222 t: 0swkd7qz4-00-a3f2 -->\n- Second <!-- yid: 22222222-2222-4222-8222-222222222222 t: 0swkd7qz5-00-a3f2 -->",
        );
        assert_any_quarantine(source.as_bytes());
    }

    #[test]
    fn quarantines_unconsumed_body_lines() {
        for body in [
            "leading text\n- Item",
            "  unplaced text\n- Item",
            "- Item\n  plain continuation",
            "- Item\n  > note\n  content after note",
            "- Item\ntrailing text",
        ] {
            assert_any_quarantine(topic(body).as_bytes());
        }
    }

    #[test]
    fn quarantines_every_noncanonical_image_like_body_atom() {
        for body in [
            "- ![Other](/tmp/image.png)",
            "- ![Image](/tmp/image.png)",
            "- Item\n  ![Other](../image.png)",
            "- Item\n  ![Image](../image.png)",
            "- Item\n  > ![Other](/tmp/image.png)",
            "- Item\n  > ![Image](/tmp/image.png)",
        ] {
            assert_any_quarantine(topic(body).as_bytes());
        }
        let heading = topic("- Item").replacen("# Root", "# ![Other](/tmp/image.png)", 1);
        assert_any_quarantine(heading.as_bytes());
    }

    #[test]
    fn quarantines_structurally_invalid_purged_entries_but_keeps_malformed_hlc_empty() {
        for purged in [
            "purged: invalid 0swkd7qz7-00-a3f2",
            "purged: 66666666-6666-4666-8666-666666666666",
            "purged: 66666666-6666-4666-8666-666666666666 0swkd7qz7-00-a3f2 extra",
        ] {
            assert_any_quarantine(trash_with_frontmatter(purged, "").as_bytes());
        }
        let parsed = parsed(
            trash_with_frontmatter("purged: 66666666-6666-4666-8666-666666666666 malformed", "")
                .as_bytes(),
        );
        let TopicFile::Trash(trash) = parsed else {
            panic!("expected trash")
        };
        assert_eq!(trash.purged[0].hlc, "");
    }

    #[test]
    fn requires_canonical_utf8_percent_encoded_original_names() {
        for encoded in ["%41.png", "%FF.png", "photo%2fpng", "%20%20%20"] {
            assert_any_quarantine(
                topic(&image_bullet("png", encoded, "name: {name} w: -")).as_bytes(),
            );
        }
        let oversized = format!("{}.png", "a".repeat(1025));
        assert_any_quarantine(
            topic(&image_bullet("png", &oversized, "name: {name} w: -")).as_bytes(),
        );

        let unicode = "%ED%95%9C%EA%B8%80.png";
        let topic = topic_document(parsed(
            topic(&image_bullet("png", unicode, "name: {name} w: -")).as_bytes(),
        ));
        let TopicContent::Image { attachment, .. } = &topic.nodes[0].content else {
            panic!("expected image")
        };
        assert_eq!(attachment.encoded_original_name, unicode);
    }

    #[test]
    fn accepts_original_names_at_the_legacy_limit_and_rejects_one_byte_more() {
        let exact = "a".repeat(1024);
        let parsed_topic = topic_document(parsed(
            topic(&image_bullet("png", &exact, "name: {name} w: -")).as_bytes(),
        ));
        let TopicContent::Image { attachment, .. } = &parsed_topic.nodes[0].content else {
            panic!("expected image")
        };
        assert_eq!(attachment.encoded_original_name, exact);

        let too_long = "a".repeat(1025);
        assert_any_quarantine(
            topic(&image_bullet("png", &too_long, "name: {name} w: -")).as_bytes(),
        );

        let exact_unicode = "%C3%A9".repeat(512);
        assert!(matches!(
            parse_topic_file(
                topic(&image_bullet("png", &exact_unicode, "name: {name} w: -")).as_bytes()
            ),
            TopicParseOutcome::Parsed(_)
        ));
        let too_long_unicode = format!("{exact_unicode}a");
        assert_any_quarantine(
            topic(&image_bullet("png", &too_long_unicode, "name: {name} w: -")).as_bytes(),
        );
    }

    #[test]
    fn enforces_the_shared_field_cap_for_root_and_text_titles() {
        let exact = "a".repeat(MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES);
        let too_long = "a".repeat(MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES + 1);

        let root = topic_with_exact_frontmatter(
            "kind: yonalist-notes\nformat_version: 2\nid: 11111111-1111-4111-8111-111111111111",
            "",
        )
        .replacen("# Root", &format!("# {exact}"), 1);
        assert!(matches!(
            parse_topic_file(root.as_bytes()),
            TopicParseOutcome::Parsed(_)
        ));
        let root_over = root.replacen(&format!("# {exact}"), &format!("# {too_long}"), 1);
        assert_any_quarantine(root_over.as_bytes());

        assert!(matches!(
            parse_topic_file(topic(&format!("- {exact}")).as_bytes()),
            TopicParseOutcome::Parsed(_)
        ));
        assert_any_quarantine(topic(&format!("- {too_long}")).as_bytes());
    }

    #[test]
    fn enforces_the_shared_field_cap_for_image_before_and_after_text() {
        let exact = "a".repeat(MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES);
        let too_long = "a".repeat(MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES + 1);
        let atom = "![Image](.yonalist/notes-assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png) <!-- ya: name: photo.png w: - -->";

        assert!(matches!(
            parse_topic_file(topic(&format!("- {exact}\n  {atom}")).as_bytes()),
            TopicParseOutcome::Parsed(_)
        ));
        assert_any_quarantine(topic(&format!("- {too_long}\n  {atom}")).as_bytes());

        assert!(matches!(
            parse_topic_file(topic(&format!("- {atom}\n  {exact}")).as_bytes()),
            TopicParseOutcome::Parsed(_)
        ));
        assert_any_quarantine(topic(&format!("- {atom}\n  {too_long}")).as_bytes());
    }

    #[test]
    fn enforces_the_shared_field_cap_while_accumulating_note_lines() {
        let exact = "a".repeat(MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES);
        let too_long = "a".repeat(MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES + 1);
        assert!(matches!(
            parse_topic_file(topic(&format!("- Item\n  > {exact}")).as_bytes()),
            TopicParseOutcome::Parsed(_)
        ));
        assert_any_quarantine(topic(&format!("- Item\n  > {too_long}")).as_bytes());

        let first = "a".repeat(MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES / 2);
        let second = "b".repeat(MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES / 2);
        assert_any_quarantine(topic(&format!("- Item\n  > {first}\n  > {second}")).as_bytes());
    }

    #[test]
    fn accepts_forward_compatible_reordered_image_metadata_tokens() {
        for metadata in [
            "future: yes name: {name} w: 320 trailing",
            "w: - unknown name: {name}",
            "name: {name} extra: value w: 480",
            "star name: {name} w: -",
        ] {
            let topic = topic_document(parsed(
                topic(&image_bullet("png", "photo.png", metadata)).as_bytes(),
            ));
            assert!(matches!(topic.nodes[0].content, TopicContent::Image { .. }));
        }
    }

    #[test]
    fn quarantines_duplicate_missing_or_malformed_known_image_metadata_tokens() {
        for metadata in [
            "name: {name} name: other.png w: 320",
            "name: {name} w: 320 w: 480",
            "w: 320",
            "name: {name}",
            "name: w: 320",
            "name: {name} w: wide",
        ] {
            assert_any_quarantine(topic(&image_bullet("png", "photo.png", metadata)).as_bytes());
        }
    }

    #[test]
    fn accepts_only_owned_storage_asset_extensions() {
        for extension in ["png", "jpg", "webp", "gif"] {
            let topic = topic_document(parsed(
                topic(&image_bullet(extension, "photo.png", "name: {name} w: -")).as_bytes(),
            ));
            let TopicContent::Image { attachment, .. } = &topic.nodes[0].content else {
                panic!("expected image")
            };
            assert_eq!(attachment.extension, extension);
        }
        assert_any_quarantine(
            topic(&image_bullet("jpeg", "photo.jpeg", "name: {name} w: -")).as_bytes(),
        );
    }

    #[test]
    fn quarantines_orphan_image_atoms_including_unsafe_links() {
        for link in [
            ".yonalist/notes-assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
            "/tmp/image.png",
            "../image.png",
        ] {
            let source = topic(&format!(
                "![Image]({link}) <!-- ya: name: photo.png w: - -->"
            ));
            assert_any_quarantine(source.as_bytes());
        }
    }

    #[test]
    fn quarantines_absolute_traversal_and_noncanonical_asset_links() {
        for link in [
            "/tmp/image.png",
            "../.yonalist/notes-assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
            ".yonalist/notes-assets/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.png",
        ] {
            let source = topic(&format!(
                "- [ ] Before <!-- yid: 22222222-2222-4222-8222-222222222222 t: 0swkd7qz4-00-a3f2 -->\n  ![Image]({link}) <!-- ya: name: photo.png w: - -->"
            ));
            assert_quarantined(source.as_bytes(), TopicParseError::InvalidAssetLink);
        }
    }

    #[test]
    fn quarantines_files_larger_than_sixteen_mebibytes_before_parsing() {
        let bytes = vec![b'x'; MAX_MARKDOWN_BYTES + 1];
        assert_quarantined(&bytes, TopicParseError::FileTooLarge);
    }

    #[test]
    fn accepts_a_valid_file_at_exactly_sixteen_mebibytes() {
        let mut source = topic("- Item");
        source.push_str(&"\n".repeat(MAX_MARKDOWN_BYTES - source.len()));
        assert_eq!(source.len(), MAX_MARKDOWN_BYTES);
        let topic = topic_document(parsed(source.as_bytes()));
        assert_eq!(topic.nodes.len(), 1);
    }

    #[test]
    fn quarantines_a_depth_over_the_existing_import_cap_without_a_partial_document() {
        let mut source = topic("");
        for depth in 0..=MAX_IMPORT_SUBTREE_DEPTH {
            source.push_str(&"  ".repeat(depth));
            source.push_str("- Item\n");
        }
        assert_quarantined(source.as_bytes(), TopicParseError::DepthLimitExceeded);
    }

    #[test]
    fn accepts_exactly_the_existing_import_depth_cap() {
        let mut source = topic("");
        for depth in 0..MAX_IMPORT_SUBTREE_DEPTH {
            source.push_str(&"  ".repeat(depth));
            source.push_str("- Item\n");
        }
        let topic = topic_document(parsed(source.as_bytes()));
        let mut depth = 0;
        let mut nodes = topic.nodes.as_slice();
        while let Some(node) = nodes.first() {
            depth += 1;
            nodes = &node.children;
        }
        assert_eq!(depth, MAX_IMPORT_SUBTREE_DEPTH);
    }

    #[test]
    fn quarantines_a_node_count_over_the_existing_import_cap_without_a_partial_document() {
        let mut source = topic("");
        for _ in 0..=MAX_IMPORT_SUBTREE_NODES {
            source.push_str("- Item\n");
        }
        assert_quarantined(source.as_bytes(), TopicParseError::NodeLimitExceeded);
    }

    #[test]
    fn accepts_exactly_the_existing_import_node_cap() {
        let mut source = topic("");
        for _ in 0..MAX_IMPORT_SUBTREE_NODES {
            source.push_str("- Item\n");
        }
        let topic = topic_document(parsed(source.as_bytes()));
        assert_eq!(topic.nodes.len(), MAX_IMPORT_SUBTREE_NODES);
    }

    #[test]
    fn resets_ordinals_and_sort_keys_at_every_sibling_level() {
        let topic = topic_document(parsed(
            topic("- Root 1\n  - Child 1\n    - Grandchild 1\n    - Grandchild 2\n  - Child 2\n- Root 2")
                .as_bytes(),
        ));
        assert_positions(&topic.nodes, &[1, 2]);
        assert_positions(&topic.nodes[0].children, &[1, 2]);
        assert_positions(&topic.nodes[0].children[0].children, &[1, 2]);
    }

    #[test]
    fn round_trips_escape_sensitive_root_title_and_note_text() {
        let document = TopicFile::Topic(TopicDoc {
            id: "11111111-1111-4111-8111-111111111111".to_string(),
            sort_key: SORT_KEY_STEP,
            max_hlc: "0swkd7qz3-01-a3f2".to_string(),
            root: TopicRoot {
                title: "line 1\nline 2\\n &amp; ! <!-- -->".to_string(),
                hlc: "0swkd7qz2-00-a3f2".to_string(),
                starred: false,
                completed_at: None,
                archived_at: None,
            },
            nodes: vec![text_node(
                "22222222-2222-4222-8222-222222222222",
                "literal\\n slash\\ &amp; ! <!-- -->",
                "first\\n &amp; ! <!-- -->\nsecond\\line",
                vec![],
            )],
        });
        assert_round_trip(document);
    }

    #[test]
    fn round_trips_primary_images_with_after_note_children_and_trash_notes() {
        let child = text_node("44444444-4444-4444-8444-444444444444", "Child", "", vec![]);
        let mut second_image = image_node(
            "33333333-3333-4333-8333-333333333333",
            "",
            "After",
            "image note",
            vec![child.clone()],
        );
        second_image.sibling_ordinal = 2;
        second_image.sort_key = SORT_KEY_STEP * 2;
        let topic = TopicFile::Topic(TopicDoc {
            id: "11111111-1111-4111-8111-111111111111".to_string(),
            sort_key: SORT_KEY_STEP,
            max_hlc: "0swkd7qz3-01-a3f2".to_string(),
            root: TopicRoot {
                title: "Root".to_string(),
                hlc: "0swkd7qz2-00-a3f2".to_string(),
                starred: false,
                completed_at: None,
                archived_at: None,
            },
            nodes: vec![
                image_node("22222222-2222-4222-8222-222222222222", "", "", "", vec![]),
                second_image,
            ],
        });
        assert_round_trip(topic);

        let trash = TopicFile::Trash(TrashDoc {
            max_hlc: "0swkd7qz3-01-a3f2".to_string(),
            purged: vec![],
            nodes: vec![image_node(
                "33333333-3333-4333-8333-333333333333",
                "",
                "After",
                "trash image note",
                vec![child],
            )],
        });
        assert_round_trip(trash);
    }

    #[test]
    fn renders_unsorted_and_equal_purge_entries_deterministically() {
        let trash = TrashDoc {
            max_hlc: "0swkd7qz3-01-a3f2".to_string(),
            purged: vec![
                purge("77777777-7777-4777-8777-777777777777", "0swkd7qz8-00-a3f2"),
                purge("66666666-6666-4666-8666-666666666666", "0swkd7qz7-00-a3f2"),
                purge("77777777-7777-4777-8777-777777777777", "0swkd7qz7-00-a3f2"),
                purge("77777777-7777-4777-8777-777777777777", "0swkd7qz7-00-a3f2"),
            ],
            nodes: vec![],
        };
        let first = render_trash_doc(&trash).unwrap();
        let second = render_trash_doc(&trash).unwrap();
        assert_eq!(first, second);
        let rendered = String::from_utf8(first).unwrap();
        let purged = rendered
            .lines()
            .filter(|line| line.starts_with("purged:"))
            .collect::<Vec<_>>();
        assert_eq!(
            purged,
            [
                "purged: 66666666-6666-4666-8666-666666666666 0swkd7qz7-00-a3f2",
                "purged: 77777777-7777-4777-8777-777777777777 0swkd7qz7-00-a3f2",
                "purged: 77777777-7777-4777-8777-777777777777 0swkd7qz7-00-a3f2",
                "purged: 77777777-7777-4777-8777-777777777777 0swkd7qz8-00-a3f2",
            ]
        );
    }

    #[test]
    fn canonicalizes_purge_tuples_before_sorting_them() {
        let trash = TrashDoc {
            max_hlc: "0swkd7qz3-01-a3f2".to_string(),
            purged: vec![
                purge("BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB", "0swkd7qz8-00-a3f2"),
                purge("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "0swkd7qz7-00-a3f2"),
            ],
            nodes: vec![],
        };
        let first = render_trash_doc(&trash).unwrap();
        let reparsed = parsed(&first);
        let second = render_topic_file(&reparsed).unwrap();
        assert_eq!(first, second);
        let rendered = String::from_utf8(first).unwrap();
        let purged = rendered
            .lines()
            .filter(|line| line.starts_with("purged:"))
            .collect::<Vec<_>>();
        assert_eq!(
            purged,
            [
                "purged: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa 0swkd7qz7-00-a3f2",
                "purged: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb 0swkd7qz8-00-a3f2",
            ]
        );
    }

    #[test]
    fn quarantines_invalid_utf8() {
        assert_quarantined(&[0xff], TopicParseError::InvalidUtf8);
    }

    fn parsed(bytes: &[u8]) -> TopicFile {
        match parse_topic_file(bytes) {
            TopicParseOutcome::Parsed(document) => document,
            TopicParseOutcome::Quarantined(quarantine) => {
                panic!("expected parsed document, got quarantine: {quarantine:?}")
            }
        }
    }

    fn assert_quarantined(bytes: &[u8], expected: TopicParseError) {
        match parse_topic_file(bytes) {
            TopicParseOutcome::Parsed(document) => {
                panic!("expected quarantine, got parsed document: {document:?}")
            }
            TopicParseOutcome::Quarantined(quarantine) => assert_eq!(quarantine.error, expected),
        }
    }

    fn assert_any_quarantine(bytes: &[u8]) {
        assert!(matches!(
            parse_topic_file(bytes),
            TopicParseOutcome::Quarantined(_)
        ));
    }

    fn topic(document: &str) -> String {
        topic_with_frontmatter("", document)
    }

    fn topic_with_frontmatter(extra_frontmatter: &str, body: &str) -> String {
        format!(
            "---\nkind: yonalist-notes\nformat_version: 2\nid: 11111111-1111-4111-8111-111111111111\n{extra_frontmatter}---\n# Root\n\n{body}\n"
        )
    }

    fn topic_with_exact_frontmatter(frontmatter: &str, body: &str) -> String {
        format!("---\n{frontmatter}\n---\n# Root\n\n{body}\n")
    }

    fn trash_with_frontmatter(frontmatter: &str, body: &str) -> String {
        format!(
            "---\nkind: yonalist-trash\nformat_version: 2\nmax_hlc: 0swkd7qz3-01-a3f2\n{frontmatter}\n---\n{body}"
        )
    }

    fn frontmatter_value<'a>(source: &'a str, key: &str) -> &'a str {
        source
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{key}: ")))
            .unwrap()
    }

    fn image_bullet(extension: &str, encoded_name: &str, metadata: &str) -> String {
        let metadata = metadata.replace("{name}", encoded_name);
        format!(
            "- [ ] ![Image](.yonalist/notes-assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.{extension}) <!-- ya: {metadata} -->"
        )
    }

    fn assert_positions(nodes: &[TopicNode], expected: &[usize]) {
        assert_eq!(
            nodes
                .iter()
                .map(|node| node.sibling_ordinal)
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(
            nodes.iter().map(|node| node.sort_key).collect::<Vec<_>>(),
            expected
                .iter()
                .map(|ordinal| i64::try_from(*ordinal).unwrap() * SORT_KEY_STEP)
                .collect::<Vec<_>>()
        );
    }

    fn assert_round_trip(document: TopicFile) {
        let first = render_topic_file(&document).unwrap();
        let parsed = parsed(&first);
        assert_eq!(parsed, document);
        assert_eq!(render_topic_file(&parsed).unwrap(), first);
    }

    fn text_node(id: &str, title: &str, note: &str, children: Vec<TopicNode>) -> TopicNode {
        TopicNode {
            id: Some(id.to_string()),
            hlc: "0swkd7qz4-00-a3f2".to_string(),
            starred: false,
            completed: false,
            content: TopicContent::Text(title.to_string()),
            note: note.to_string(),
            from: None,
            sibling_ordinal: 1,
            sort_key: SORT_KEY_STEP,
            children,
        }
    }

    fn image_node(
        id: &str,
        before: &str,
        after: &str,
        note: &str,
        children: Vec<TopicNode>,
    ) -> TopicNode {
        TopicNode {
            id: Some(id.to_string()),
            hlc: "0swkd7qz4-00-a3f2".to_string(),
            starred: false,
            completed: false,
            content: TopicContent::Image {
                before: before.to_string(),
                attachment: TopicAttachment {
                    content_hash:
                        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                            .to_string(),
                    extension: "png".to_string(),
                    encoded_original_name: "photo.png".to_string(),
                    display_width: None,
                },
                after: after.to_string(),
            },
            note: note.to_string(),
            from: None,
            sibling_ordinal: 1,
            sort_key: SORT_KEY_STEP,
            children,
        }
    }

    fn purge(id: &str, hlc: &str) -> PurgedTombstone {
        PurgedTombstone {
            id: id.to_string(),
            hlc: hlc.to_string(),
        }
    }

    fn topic_document(document: TopicFile) -> crate::notes::sync::topic_file::TopicDoc {
        match document {
            TopicFile::Topic(topic) => topic,
            TopicFile::Trash(_) => panic!("expected a topic document"),
        }
    }
}
