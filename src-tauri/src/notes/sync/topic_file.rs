use crate::notes::date_index::LocalDate;
use crate::notes::export::{escape_inline, escape_markdown, normalize_newlines};
use crate::notes::hlc::Hlc;
use crate::notes::markdown_import::decode_canonical_original_name;
use crate::notes::types::MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES;
use std::collections::BTreeSet;
use std::fmt::Write;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

pub(crate) const TOPIC_FORMAT_VERSION: u32 = 2;
pub(crate) const MAX_READ_TOPIC_FORMAT_VERSION: u32 = 3;

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
    pub(crate) format_version: u32,
    pub(crate) title: String,
    /// Root note rendered as a depth-0 blockquote between the heading and the
    /// first bullet. Kept in the format so a remote root winner cannot blank a
    /// locally edited root note (spec §7.1, remediation A3).
    pub(crate) note: String,
    pub(crate) hlc: String,
    pub(crate) starred: bool,
    pub(crate) completed_at: Option<String>,
    pub(crate) archived_at: Option<String>,
    pub(crate) root_collapsed: bool,
    pub(crate) root_readonly: Option<bool>,
    pub(crate) plugin: Option<String>,
    pub(crate) plugin_children: Option<String>,
    pub(crate) collapsed_groups: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TrashDoc {
    pub(crate) format_version: u32,
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
    pub(crate) collapsed: bool,
    pub(crate) readonly: Option<bool>,
    pub(crate) plugin_meta: Option<TopicPluginMeta>,
    /// One-based position among siblings as it appeared in the Markdown file.
    pub(crate) sibling_ordinal: usize,
    /// Reconstructed as `sibling_ordinal * SORT_KEY_STEP`; never rendered.
    pub(crate) sort_key: i64,
    pub(crate) children: Vec<TopicNode>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TopicPluginMeta {
    GithubDate {
        date_key: String,
    },
    GithubNotification {
        notification_key: String,
        notification_type: String,
        url: String,
        updated_at: String,
        unread: bool,
    },
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
    render_topic_doc_with_version(document, TOPIC_FORMAT_VERSION)
}

/// Render the dormant v3 representation used by focused sync tests.  The
/// production writer intentionally continues to call [`render_topic_doc`]
/// until the Task 10 cutover.
pub(crate) fn render_topic_doc_v3(document: &TopicDoc) -> Result<Vec<u8>, String> {
    render_topic_doc_with_version(document, MAX_READ_TOPIC_FORMAT_VERSION)
}

fn render_topic_doc_with_version(
    document: &TopicDoc,
    format_version: u32,
) -> Result<Vec<u8>, String> {
    if document.root.format_version != format_version {
        return Err(format!(
            "The topic document format version {} does not match renderer version {format_version}.",
            document.root.format_version
        ));
    }
    if format_version < MAX_READ_TOPIC_FORMAT_VERSION
        && (document.root.root_collapsed
            || document.root.root_readonly.is_some()
            || document.root.plugin.is_some()
            || document.root.plugin_children.is_some()
            || !document.root.collapsed_groups.is_empty()
            || document.nodes.iter().any(topic_node_has_v3_state))
    {
        return Err("A v3 Notes document cannot be rendered with the v2 envelope.".to_string());
    }
    let mut markdown = String::new();
    ensure_field_budget(&document.root.title, "root title")?;
    ensure_field_budget(&document.root.note, "root note")?;
    let id = canonical_uuid(&document.id)?;
    let max_hlc = canonical_hlc(&document.max_hlc)?;
    let root_hlc = canonical_hlc(&document.root.hlc)?;
    let completed_at = canonical_optional_frontmatter_value(&document.root.completed_at)?;
    let archived_at = canonical_optional_frontmatter_value(&document.root.archived_at)?;
    if format_version >= 3
        && document.root.plugin.is_some()
        && document.root.root_readonly.is_some()
    {
        return Err("A plugin-owned topic root cannot carry root_readonly.".to_string());
    }

    writeln!(markdown, "---").expect("writing to a String cannot fail");
    writeln!(markdown, "kind: yonalist-notes").expect("writing to a String cannot fail");
    writeln!(markdown, "format_version: {format_version}")
        .expect("writing to a String cannot fail");
    writeln!(markdown, "id: {id}").expect("writing to a String cannot fail");
    writeln!(markdown, "sort_key: {}", document.sort_key).expect("writing to a String cannot fail");
    writeln!(markdown, "max_hlc: {max_hlc}").expect("writing to a String cannot fail");
    writeln!(markdown, "root_hlc: {root_hlc}").expect("writing to a String cannot fail");
    if format_version >= 3 {
        writeln!(markdown, "root_collapsed: {}", document.root.root_collapsed)
            .expect("writing to a String cannot fail");
        if document.root.plugin.is_none() {
            writeln!(
                markdown,
                "root_readonly: {}",
                document.root.root_readonly.unwrap_or(false)
            )
            .expect("writing to a String cannot fail");
        }
    }
    writeln!(markdown, "root_starred: {}", document.root.starred)
        .expect("writing to a String cannot fail");
    writeln!(markdown, "root_completed_at: {completed_at}")
        .expect("writing to a String cannot fail");
    writeln!(markdown, "root_archived_at: {archived_at}").expect("writing to a String cannot fail");
    if format_version >= 3 {
        if let Some(plugin) = &document.root.plugin {
            writeln!(markdown, "plugin: {plugin}").expect("writing to a String cannot fail");
        }
        if let Some(plugin_children) = &document.root.plugin_children {
            writeln!(markdown, "plugin_children: {plugin_children}")
                .expect("writing to a String cannot fail");
        }
        let groups = document
            .root
            .collapsed_groups
            .iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(|group| serde_json::to_string(group).expect("date key is serializable"))
            .collect::<Vec<_>>()
            .join(",");
        if document.root.plugin.is_some() || !document.root.collapsed_groups.is_empty() {
            writeln!(markdown, "collapsed_groups: [{groups}]")
                .expect("writing to a String cannot fail");
        }
    }
    writeln!(markdown, "---").expect("writing to a String cannot fail");
    writeln!(markdown, "# {}", escape_inline(&document.root.title))
        .expect("writing to a String cannot fail");
    render_note_block(&mut markdown, &document.root.note, 0);
    writeln!(markdown).expect("writing to a String cannot fail");

    for node in &document.nodes {
        render_node_with_version(&mut markdown, node, 0, format_version)?;
    }
    Ok(markdown.into_bytes())
}

fn topic_node_has_v3_state(node: &TopicNode) -> bool {
    node.collapsed
        || node.readonly.is_some()
        || node.plugin_meta.is_some()
        || node.children.iter().any(topic_node_has_v3_state)
}

/// Renders a note as a blockquote indented for `depth` levels. The root note
/// uses depth 0 (`> …`); a node's note uses its own depth + 1.
fn render_note_block(markdown: &mut String, note: &str, depth: usize) {
    if note.is_empty() {
        return;
    }
    let indentation = "  ".repeat(depth);
    for line in normalize_newlines(note).split('\n') {
        if line.is_empty() {
            writeln!(markdown, "{indentation}>").expect("writing to a String cannot fail");
        } else {
            writeln!(markdown, "{indentation}> {}", escape_markdown(line))
                .expect("writing to a String cannot fail");
        }
    }
}

pub(crate) fn render_trash_doc(document: &TrashDoc) -> Result<Vec<u8>, String> {
    render_trash_doc_with_version(document, TOPIC_FORMAT_VERSION)
}

pub(crate) fn render_trash_doc_v3(document: &TrashDoc) -> Result<Vec<u8>, String> {
    render_trash_doc_with_version(document, MAX_READ_TOPIC_FORMAT_VERSION)
}

fn render_trash_doc_with_version(
    document: &TrashDoc,
    format_version: u32,
) -> Result<Vec<u8>, String> {
    if document.format_version != format_version {
        return Err(format!(
            "The trash document format version {} does not match renderer version {format_version}.",
            document.format_version
        ));
    }
    if format_version < MAX_READ_TOPIC_FORMAT_VERSION
        && document.nodes.iter().any(topic_node_has_v3_state)
    {
        return Err(
            "A v3 Notes trash document cannot be rendered with the v2 envelope.".to_string(),
        );
    }
    let mut markdown = String::new();
    let max_hlc = canonical_hlc(&document.max_hlc)?;
    writeln!(markdown, "---").expect("writing to a String cannot fail");
    writeln!(markdown, "kind: yonalist-trash").expect("writing to a String cannot fail");
    writeln!(markdown, "format_version: {format_version}")
        .expect("writing to a String cannot fail");
    writeln!(markdown, "max_hlc: {max_hlc}").expect("writing to a String cannot fail");

    let mut purged = document
        .purged
        .iter()
        .map(|tombstone| {
            let hlc = canonical_hlc(&tombstone.hlc)?;
            if hlc.is_empty() {
                return Err("A rendered purge tombstone needs an HLC.".to_string());
            }
            Ok((canonical_uuid(&tombstone.id)?, hlc))
        })
        .collect::<Result<Vec<_>, String>>()?;
    purged.sort();
    for (id, hlc) in purged {
        writeln!(markdown, "purged: {id} {hlc}").expect("writing to a String cannot fail");
    }
    writeln!(markdown, "---").expect("writing to a String cannot fail");
    for node in &document.nodes {
        render_node_with_version(&mut markdown, node, 0, format_version)?;
    }
    Ok(markdown.into_bytes())
}

pub(crate) fn render_topic_file(document: &TopicFile) -> Result<Vec<u8>, String> {
    match document {
        TopicFile::Topic(topic) => render_topic_doc(topic),
        TopicFile::Trash(trash) => render_trash_doc(trash),
    }
}

pub(crate) fn render_topic_file_v3(document: &TopicFile) -> Result<Vec<u8>, String> {
    match document {
        TopicFile::Topic(topic) => render_topic_doc_v3(topic),
        TopicFile::Trash(trash) => render_trash_doc_v3(trash),
    }
}

/// Canonical semantic form used by render self-validation. Ordinary writable
/// children omit `readonly` on disk, while plugin-owned rows use SQL NULL and
/// also omit the token. Both forms therefore compare as the same state.
pub(crate) fn canonicalize_topic_file_semantics(document: &TopicFile) -> TopicFile {
    fn normalize_node(node: &TopicNode) -> TopicNode {
        let mut normalized = node.clone();
        normalized.readonly = if normalized.plugin_meta.is_some() {
            None
        } else {
            normalized.readonly.filter(|value| *value)
        };
        normalized.children = normalized.children.iter().map(normalize_node).collect();
        normalized
    }
    match document {
        TopicFile::Topic(topic) => {
            let mut normalized = topic.clone();
            normalized.nodes = normalized.nodes.iter().map(normalize_node).collect();
            TopicFile::Topic(normalized)
        }
        TopicFile::Trash(trash) => {
            let mut normalized = trash.clone();
            normalized.nodes = normalized.nodes.iter().map(normalize_node).collect();
            TopicFile::Trash(normalized)
        }
    }
}

pub(crate) fn derive_topic_filename(title: &str, topic_id: &str) -> Result<String, String> {
    let canonical_id = canonical_uuid(topic_id)?;
    let mut slug = String::new();
    let mut separator_pending = false;
    for character in title.nfc() {
        if character.is_control() {
            continue;
        }
        if character.is_whitespace() || is_reserved_filename_character(character) {
            separator_pending = true;
            continue;
        }
        if separator_pending && !slug.is_empty() {
            slug.push('-');
        }
        separator_pending = false;
        slug.push(character);
    }
    let mut slug = slug.trim_matches(['-', '.']).to_string();
    if let Some((boundary, _)) = slug.char_indices().nth(40) {
        slug.truncate(boundary);
        slug.truncate(slug.trim_end_matches(['-', '.']).len());
    }
    if slug.is_empty() {
        slug.push_str("untitled");
    }
    Ok(format!("{slug}.{}.md", &canonical_id[..8]))
}

fn is_reserved_filename_character(character: char) -> bool {
    matches!(
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
    )
}

fn render_node_with_version(
    markdown: &mut String,
    node: &TopicNode,
    depth: usize,
    format_version: u32,
) -> Result<(), String> {
    ensure_field_budget(&node.note, "note")?;
    let indentation = "  ".repeat(depth);
    let completion = if node.completed { 'x' } else { ' ' };
    let comment = if format_version >= 3 {
        render_node_comment_v3(node)?
    } else {
        render_node_comment(node)?
    };
    match &node.content {
        TopicContent::Text(title) => {
            ensure_field_budget(title, "title")?;
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
            ensure_field_budget(before, "image before text")?;
            ensure_field_budget(after, "image after text")?;
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

    render_note_block(markdown, &node.note, depth + 1);

    for child in &node.children {
        render_node_with_version(markdown, child, depth + 1, format_version)?;
    }
    Ok(())
}

fn render_node_comment_v3(node: &TopicNode) -> Result<String, String> {
    let comment = render_node_comment(node)?;
    let insertion = comment
        .strip_suffix(" -->")
        .ok_or_else(|| "A rendered topic node comment is malformed.".to_string())?;
    let mut fields = insertion.to_string();
    if node.collapsed {
        fields.push_str(" collapsed");
    }
    if node.plugin_meta.is_some() && node.readonly.is_some() {
        return Err("A plugin-owned node cannot carry readonly metadata.".to_string());
    }
    if node.plugin_meta.is_none() && node.readonly.is_some_and(|readonly| readonly) {
        fields.push_str(" readonly");
    }
    match &node.plugin_meta {
        Some(TopicPluginMeta::GithubDate { date_key }) => {
            fields.push_str(" plugin: github-notifications-date date_key: ");
            fields.push_str(date_key);
        }
        Some(TopicPluginMeta::GithubNotification {
            notification_key,
            notification_type,
            url,
            updated_at,
            unread,
        }) => {
            fields.push_str(" plugin: github-notification notification_key: ");
            fields.push_str(notification_key);
            fields.push_str(" notification_type: ");
            fields.push_str(notification_type);
            fields.push_str(" notification_url: ");
            fields.push_str(url);
            fields.push_str(" notification_updated_at: ");
            fields.push_str(updated_at);
            fields.push_str(" notification_unread: ");
            fields.push_str(if *unread { "true" } else { "false" });
        }
        None => {}
    }
    fields.push_str(" -->");
    Ok(fields)
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
        Some(value) if is_app_timestamp(value) => Ok(value.clone()),
        Some(_) => Err("A topic timestamp must use the app's UTC ISO 8601 form.".to_string()),
        None => Ok("null".to_string()),
    }
}

pub(crate) fn is_app_timestamp(value: &str) -> bool {
    let Some(value) = value.strip_suffix('Z') else {
        return false;
    };
    let Some((date, time)) = value.split_once('T') else {
        return false;
    };
    if LocalDate::parse_iso(date).is_none() {
        return false;
    }
    let (whole_seconds, fraction) = match time.split_once('.') {
        Some((whole_seconds, fraction)) => (whole_seconds, Some(fraction)),
        None => (time, None),
    };
    if fraction.is_some_and(|fraction| {
        fraction.is_empty() || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    }) {
        return false;
    }
    let bytes = whole_seconds.as_bytes();
    if bytes.len() != 8 || bytes[2] != b':' || bytes[5] != b':' {
        return false;
    }
    let parse_pair = |pair: &[u8]| -> Option<u8> {
        pair.iter()
            .all(|byte| byte.is_ascii_digit())
            .then(|| (pair[0] - b'0') * 10 + pair[1] - b'0')
    };
    matches!(
        (
            parse_pair(&bytes[0..2]),
            parse_pair(&bytes[3..5]),
            parse_pair(&bytes[6..8]),
        ),
        (Some(0..=23), Some(0..=59), Some(0..=59))
    )
}

fn ensure_field_budget(value: &str, field: &str) -> Result<(), String> {
    if value.len() > MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES {
        return Err(format!("A topic {field} exceeds the field limit."));
    }
    Ok(())
}

pub(crate) fn canonical_asset_hash(value: &str) -> Result<String, String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("A topic image hash must be 64 hexadecimal characters.".to_string());
    }
    Ok(value.to_ascii_lowercase())
}

pub(crate) fn canonical_asset_extension(value: &str) -> Result<String, String> {
    let canonical = value.to_ascii_lowercase();
    if !matches!(canonical.as_str(), "png" | "jpg" | "webp" | "gif") {
        return Err("A topic image extension is unsupported.".to_string());
    }
    Ok(canonical)
}

pub(crate) fn validate_encoded_original_name(value: &str) -> Result<(), String> {
    decode_canonical_original_name(value).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::{
        derive_topic_filename, render_topic_doc, render_topic_doc_v3, render_trash_doc_v3,
        TopicAttachment, TopicContent, TopicDoc, TopicFile, TopicNode, TopicRoot,
    };
    use crate::notes::github_notifications::{
        GITHUB_NOTIFICATIONS_FILENAME, GITHUB_NOTIFICATIONS_ROOT_ID, GITHUB_NOTIFICATIONS_TITLE,
    };
    use crate::notes::sync::topic_parser::{parse_topic_file, TopicParseOutcome};
    use crate::notes::types::validate_note_id;

    const GOLDEN: &str = include_str!("fixtures/topic_golden.md");
    const GITHUB_GOLDEN: &str = include_str!("fixtures/github_notifications_golden.md");

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

    #[test]
    fn explicit_v3_renderer_round_trips_root_and_node_state_without_changing_v2() {
        let mut topic = golden_topic();
        topic.root.format_version = 3;
        topic.root.root_collapsed = true;
        topic.root.root_readonly = Some(false);
        topic.nodes[0].collapsed = true;
        topic.nodes[0].readonly = Some(true);
        let bytes = render_topic_doc_v3(&topic).unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        assert!(text.contains("format_version: 3\n"));
        assert!(text.contains("root_collapsed: true\nroot_readonly: false\n"));
        assert!(text.contains("collapsed readonly"));
        match parse_topic_file(&bytes) {
            TopicParseOutcome::Parsed(TopicFile::Topic(parsed)) => {
                assert!(parsed.root.root_collapsed);
                assert_eq!(parsed.root.root_readonly, Some(false));
                assert!(parsed.nodes[0].collapsed);
                assert_eq!(parsed.nodes[0].readonly, Some(true));
            }
            other => panic!("unexpected v3 parse result: {other:?}"),
        }
        assert_eq!(
            render_topic_doc(&golden_topic()).unwrap(),
            GOLDEN.as_bytes()
        );
    }

    #[test]
    fn v2_renderer_rejects_root_collapse_state_instead_of_dropping_it() {
        let mut topic = golden_topic();
        topic.root.root_collapsed = true;

        assert!(render_topic_doc(&topic)
            .unwrap_err()
            .contains("v2 envelope"));
    }

    #[test]
    fn explicit_v3_trash_renderer_uses_v3_frontmatter() {
        let document = super::TrashDoc {
            format_version: 3,
            max_hlc: "0swkd7qz3-01-a3f2".to_string(),
            purged: Vec::new(),
            nodes: vec![golden_topic().nodes[0].clone()],
        };
        let bytes = render_trash_doc_v3(&document).unwrap();
        assert!(String::from_utf8(bytes)
            .unwrap()
            .contains("format_version: 3\n"));
    }

    #[test]
    fn explicit_v3_github_renderer_keeps_hybrid_metadata_and_quarantines_readonly_plugin_rows() {
        let parsed = match parse_topic_file(GITHUB_GOLDEN.as_bytes()) {
            TopicParseOutcome::Parsed(TopicFile::Topic(document)) => document,
            other => panic!("unexpected Github fixture: {other:?}"),
        };
        let bytes = render_topic_doc_v3(&parsed).unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        assert!(text.contains("plugin: github-notifications\nplugin_children: hybrid\n"));
        assert!(text.contains("collapsed_groups: [\"2026.07.21\"]"));
        assert!(!text.contains("root_readonly:"));
        assert!(!text.contains("plugin: github-notifications-date date_key: 2026.07.21 readonly"));
        match parse_topic_file(&bytes) {
            TopicParseOutcome::Parsed(TopicFile::Topic(round_trip)) => {
                assert_eq!(round_trip.root.plugin, parsed.root.plugin);
                assert_eq!(round_trip.root.collapsed_groups, vec!["2026.07.21"]);
            }
            other => panic!("unexpected Github v3 round trip: {other:?}"),
        }
    }

    #[test]
    fn derives_a_stable_sanitized_topic_filename() {
        let id = "ABCDEFAB-CDEF-4DEF-8DEF-ABCDEFABCDEF";
        assert_eq!(
            derive_topic_filename(r#"  Keep CASE / \:*?"<>|#%{}^~[] together..-- "#, id).unwrap(),
            "Keep-CASE-together.abcdefab.md"
        );
        assert_eq!(
            derive_topic_filename("Cafe\u{301}", id).unwrap(),
            "Café.abcdefab.md"
        );
        assert_eq!(
            derive_topic_filename("a\u{0}b", id).unwrap(),
            "ab.abcdefab.md"
        );
    }

    #[test]
    fn derives_untitled_and_utf8_safe_forty_character_slugs() {
        let id = "11111111-1111-4111-8111-111111111111";
        assert_eq!(
            derive_topic_filename(" \t/#%{}^~[]... ", id).unwrap(),
            "untitled.11111111.md"
        );
        assert_eq!(
            derive_topic_filename(&"A".repeat(41), id).unwrap(),
            format!("{}.11111111.md", "A".repeat(40))
        );
        assert_eq!(
            derive_topic_filename(&"가".repeat(41), id).unwrap(),
            format!("{}.11111111.md", "가".repeat(40))
        );
    }

    #[test]
    fn topic_filename_derivation_rejects_invalid_ids() {
        assert!(derive_topic_filename("Title", "not-a-uuid").is_err());
    }

    #[test]
    fn github_notifications_contract_has_a_canonical_v4_root_and_filename() {
        validate_note_id(GITHUB_NOTIFICATIONS_ROOT_ID).unwrap();
        assert_eq!(
            derive_topic_filename(GITHUB_NOTIFICATIONS_TITLE, GITHUB_NOTIFICATIONS_ROOT_ID)
                .unwrap(),
            GITHUB_NOTIFICATIONS_FILENAME
        );
    }

    #[test]
    fn renderer_rejects_jpeg_attachments() {
        let mut topic = golden_topic();
        let TopicContent::Image { attachment, .. } = &mut topic.nodes[1].content else {
            panic!("expected image")
        };
        attachment.extension = "jpeg".to_string();
        assert!(render_topic_doc(&topic).is_err());
    }

    #[test]
    fn renderer_rejects_non_app_timestamps() {
        let mut topic = golden_topic();
        topic.root.completed_at = Some("2026-02-30T00:00:00Z".to_string());
        assert!(render_topic_doc(&topic).is_err());
    }

    fn golden_topic() -> TopicDoc {
        TopicDoc {
            id: "11111111-1111-4111-8111-111111111111".to_string(),
            sort_key: 1024,
            max_hlc: "0swkd7qz6-00-a3f2".to_string(),
            root: TopicRoot {
                format_version: 2,
                title: "Groceries & Supplies".to_string(),
                note: "Weekly staples\n\nand & treats".to_string(),
                hlc: "0swkd7qz2-00-a3f2".to_string(),
                starred: true,
                completed_at: Some("2026-07-21T00:00:00Z".to_string()),
                archived_at: None,
                root_collapsed: false,
                root_readonly: None,
                plugin: None,
                plugin_children: None,
                collapsed_groups: Vec::new(),
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
                    collapsed: false,
                    readonly: None,
                    plugin_meta: None,
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
                    collapsed: false,
                    readonly: None,
                    plugin_meta: None,
                    sibling_ordinal: 2,
                    sort_key: 2048,
                    children: vec![TopicNode {
                        id: Some("44444444-4444-4444-8444-444444444444".to_string()),
                        hlc: "0swkd7qz6-00-a3f2".to_string(),
                        starred: false,
                        completed: false,
                        content: TopicContent::Text("Child".to_string()),
                        note: String::new(),
                        from: None,
                        collapsed: false,
                        readonly: None,
                        plugin_meta: None,
                        sibling_ordinal: 1,
                        sort_key: 1024,
                        children: vec![],
                    }],
                },
            ],
        }
    }
}
