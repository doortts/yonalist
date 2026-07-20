use crate::notes::hlc::Hlc;
use crate::notes::repository::SORT_KEY_STEP;
use crate::notes::sync::topic_file::{
    canonical_asset_extension, canonical_asset_hash, validate_encoded_original_name,
    PurgedTombstone, TopicAttachment, TopicContent, TopicDoc, TopicFile, TopicNode, TopicRoot,
    TrashDoc, MAX_TOPIC_FILE_BYTES, TOPIC_FORMAT_VERSION,
};
use crate::notes::types::{MAX_IMPORT_SUBTREE_DEPTH, MAX_IMPORT_SUBTREE_NODES};
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
    UnsupportedFormatVersion(u32),
    InvalidDocument,
    InvalidAssetLink,
    DepthLimitExceeded,
    NodeLimitExceeded,
}

pub(crate) fn parse_topic_file(bytes: &[u8]) -> TopicParseOutcome {
    if bytes.len() > MAX_TOPIC_FILE_BYTES {
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
                return Err(TopicParseError::MissingTopicId);
            }
            let heading = lines.next().ok_or(TopicParseError::InvalidDocument)?;
            let title = heading
                .strip_prefix("# ")
                .ok_or(TopicParseError::InvalidDocument)
                .map(unescape_inline)?;
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
    loop {
        let line = lines.next().ok_or(TopicParseError::InvalidFrontmatter)?;
        if line == "---" {
            return Ok(frontmatter);
        }
        let Some((key, value)) = line.split_once(": ") else {
            continue;
        };
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
            "sort_key" => frontmatter.sort_key = value.parse::<i64>().ok(),
            "max_hlc" => frontmatter.max_hlc = Some(value.to_string()),
            "root_hlc" => frontmatter.root_hlc = Some(value.to_string()),
            "root_starred" => frontmatter.root_starred = Some(value == "true"),
            "root_completed_at" => {
                frontmatter.root_completed_at = Some(optional_frontmatter_value(value));
            }
            "root_archived_at" => {
                frontmatter.root_archived_at = Some(optional_frontmatter_value(value));
            }
            "purged" => {
                if let Some(tombstone) = parse_purged_tombstone(value) {
                    frontmatter.purged.push(tombstone);
                }
            }
            _ => {}
        }
    }
}

fn optional_frontmatter_value(value: &str) -> Option<String> {
    match value {
        "" | "null" => None,
        _ => Some(value.to_string()),
    }
}

fn parse_purged_tombstone(value: &str) -> Option<PurgedTombstone> {
    let (id, hlc) = value.split_once(' ')?;
    is_uuid(id).then(|| PurgedTombstone {
        id: id.to_string(),
        hlc: parse_hlc_or_empty(Some(hlc)),
    })
}

#[derive(Debug)]
struct FlatNode {
    parent: Option<usize>,
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
    while let Some(line) = lines.next() {
        if line.is_empty() {
            continue;
        }
        if let Some(bullet) = parse_bullet(line) {
            if bullet.depth + 1 > MAX_IMPORT_SUBTREE_DEPTH {
                return Err(TopicParseError::DepthLimitExceeded);
            }
            if nodes.len() >= MAX_IMPORT_SUBTREE_NODES {
                return Err(TopicParseError::NodeLimitExceeded);
            }
            let depth = bullet.depth.min(last_at_depth.len());
            last_at_depth.truncate(depth);
            let parent = last_at_depth.last().copied();
            let mut node = FlatNode {
                parent,
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
            } else {
                node.title = unescape_inline(&bullet.primary);
            }
            let index = nodes.len();
            nodes.push(node);
            last_at_depth.push(index);
            continue;
        }
        if let Some(node) = nodes.last_mut() {
            parse_continuation(node, line)?;
        }
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

fn parse_bullet(line: &str) -> Option<Bullet> {
    let (indentation, rest) = split_indentation(line);
    let rest = rest.strip_prefix("- ")?;
    let (completed, primary) = if let Some(primary) = rest.strip_prefix("[ ] ") {
        (false, primary)
    } else if let Some(primary) = rest.strip_prefix("[x] ") {
        (true, primary)
    } else {
        (false, rest)
    };
    let (primary, comment) = split_trailing_comment(primary);
    let metadata = comment.map(parse_node_comment).unwrap_or_default();
    Some(Bullet {
        depth: indentation / 2,
        completed,
        primary: primary.to_string(),
        id: metadata.id,
        hlc: metadata.hlc,
        starred: metadata.starred,
        from: metadata.from,
    })
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
    (value[..start].trim_end(), Some(comment.trim()))
}

#[derive(Default)]
struct NodeComment {
    id: Option<String>,
    hlc: String,
    starred: bool,
    from: Option<(String, i64)>,
}

fn parse_node_comment(comment: &str) -> NodeComment {
    let mut metadata = NodeComment::default();
    let mut tokens = comment.split_whitespace();
    while let Some(token) = tokens.next() {
        match token {
            "yid:" => {
                if let Some(id) = tokens.next().filter(|id| is_uuid(id)) {
                    metadata.id = Some(id.to_string());
                }
            }
            "t:" => metadata.hlc = parse_hlc_or_empty(tokens.next()),
            "star" => metadata.starred = true,
            "from:" => {
                metadata.from = tokens.next().and_then(parse_restore_origin);
            }
            _ => {}
        }
    }
    metadata
}

fn parse_restore_origin(value: &str) -> Option<(String, i64)> {
    let (parent_id, sort_key) = value.rsplit_once('@')?;
    is_uuid(parent_id)
        .then(|| sort_key.parse::<i64>().ok())
        .flatten()
        .map(|sort_key| (parent_id.to_string(), sort_key))
}

fn parse_continuation(node: &mut FlatNode, line: &str) -> Result<(), TopicParseError> {
    let (_, content) = split_indentation(line);
    if content == ">" || content.starts_with("> ") {
        let note_line = if content == ">" {
            ""
        } else {
            content.strip_prefix("> ").unwrap_or_default()
        };
        if node.note_lines != 0 {
            node.note.push('\n');
        }
        node.note.push_str(&unescape_markdown(note_line));
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
        let after = unescape_inline(content);
        if node.after_started {
            node.after.push('\n');
        }
        node.after.push_str(&after);
        node.after_started = true;
    }
    Ok(())
}

fn parse_image_atom(value: &str) -> Result<TopicAttachment, TopicParseError> {
    let value = value
        .strip_prefix("![Image](")
        .ok_or(TopicParseError::InvalidAssetLink)?;
    let (link, metadata) = value
        .split_once(") ")
        .ok_or(TopicParseError::InvalidAssetLink)?;
    let metadata = metadata
        .strip_prefix("<!-- ya: name: ")
        .and_then(|metadata| metadata.strip_suffix(" -->"))
        .ok_or(TopicParseError::InvalidAssetLink)?;
    let (encoded_original_name, width) = metadata
        .rsplit_once(" w: ")
        .ok_or(TopicParseError::InvalidAssetLink)?;
    validate_encoded_original_name(encoded_original_name)
        .map_err(|_| TopicParseError::InvalidAssetLink)?;
    let display_width = match width {
        "-" => None,
        value => Some(
            value
                .parse::<i64>()
                .map_err(|_| TopicParseError::InvalidAssetLink)?,
        ),
    };
    let (content_hash, extension) = parse_canonical_asset_link(link)?;
    Ok(TopicAttachment {
        content_hash,
        extension,
        encoded_original_name: encoded_original_name.to_string(),
        display_width,
    })
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

fn unescape_inline(value: &str) -> String {
    unescape(value, true)
}

fn unescape_markdown(value: &str) -> String {
    unescape(value, false)
}

fn unescape(value: &str, inline: bool) -> String {
    let mut decoded = String::with_capacity(value.len());
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
        } else {
            let character = remaining
                .chars()
                .next()
                .expect("a nonempty string has a first character");
            decoded.push(character);
            remaining = &remaining[character.len_utf8()..];
        }
    }
    decoded
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
            children[parent].push(parsed);
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
    use crate::notes::repository::SORT_KEY_STEP;
    use crate::notes::sync::topic_file::{
        render_topic_file, TopicContent, TopicFile, MAX_TOPIC_FILE_BYTES,
    };
    use crate::notes::types::{MAX_IMPORT_SUBTREE_DEPTH, MAX_IMPORT_SUBTREE_NODES};

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
        let source = topic_with_frontmatter(
            "id: ABCDEFAB-CDEF-4DEF-8DEF-ABCDEFABCDEF\n",
            "- [ ] Item <!-- yid: ABCDEFAB-CDEF-4DEF-8DEF-ABCDEFABCDEF t: 0swkd7qz4-00-a3f2 -->",
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
    fn quarantines_future_format_versions() {
        let source = topic_with_frontmatter("format_version: 3\n", "- Item");
        assert_quarantined(
            source.as_bytes(),
            TopicParseError::UnsupportedFormatVersion(3),
        );
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
        let bytes = vec![b'x'; MAX_TOPIC_FILE_BYTES + 1];
        assert_quarantined(&bytes, TopicParseError::FileTooLarge);
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
    fn quarantines_a_node_count_over_the_existing_import_cap_without_a_partial_document() {
        let mut source = topic("");
        for _ in 0..=MAX_IMPORT_SUBTREE_NODES {
            source.push_str("- Item\n");
        }
        assert_quarantined(source.as_bytes(), TopicParseError::NodeLimitExceeded);
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

    fn topic(document: &str) -> String {
        topic_with_frontmatter("", document)
    }

    fn topic_with_frontmatter(extra_frontmatter: &str, body: &str) -> String {
        format!(
            "---\nkind: yonalist-notes\nformat_version: 2\nid: 11111111-1111-4111-8111-111111111111\n{extra_frontmatter}---\n# Root\n\n{body}\n"
        )
    }

    fn topic_document(document: TopicFile) -> crate::notes::sync::topic_file::TopicDoc {
        match document {
            TopicFile::Topic(topic) => topic,
            TopicFile::Trash(_) => panic!("expected a topic document"),
        }
    }
}
