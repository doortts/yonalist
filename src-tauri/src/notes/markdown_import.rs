use crate::notes::attachments::{AttachmentImportPermit, PreparedAttachmentBatch};
use crate::notes::types::{
    validate_note_id, MAX_IMPORT_SUBTREE_DEPTH, MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES,
    MAX_IMPORT_SUBTREE_NODES, MAX_NOTE_ATTACHMENTS_PER_VAULT,
};
#[cfg(unix)]
use cap_fs_ext::OpenOptionsExt;
use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, File as CapFile, OpenOptions as CapOpenOptions};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

pub(crate) const MAX_MARKDOWN_BYTES: usize = 16 * 1024 * 1024;
const NODE_MARKER_PREFIX: &str = " <!-- yonalist-node-id: ";
const ORIGINAL_NAME_PREFIX: &str = " <!-- yonalist-attachment-original-name: ";
const LEGACY_TEXT_ATTACHMENT_ERROR: &str =
    "unsupported legacy text attachment continuation in Notes Markdown import.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedMarkdownImage {
    pub(crate) relative_link: String,
    pub(crate) original_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedMarkdownNode {
    pub(crate) title: String,
    pub(crate) image_offset_utf16: i64,
    pub(crate) note: String,
    pub(crate) completed: bool,
    pub(crate) image: Option<ParsedMarkdownImage>,
    pub(crate) children: Vec<ParsedMarkdownNode>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MarkdownFileIdentity {
    volume: u64,
    file: u64,
}

/// Holds the Markdown parent capability, source file handle/name, and captured
/// identity for the full import. Nothing later needs to ambient-reopen either
/// the Markdown source or an asset path.
pub(crate) struct HeldMarkdownImportSource {
    parent: Dir,
    source_name: PathBuf,
    source: CapFile,
    source_identity: MarkdownFileIdentity,
}

impl HeldMarkdownImportSource {
    pub(crate) fn read_owned_bytes(&self) -> Result<Vec<u8>, String> {
        read_markdown_file_bounded(
            &self.source,
            u64::try_from(MAX_MARKDOWN_BYTES).expect("Markdown byte limit fits u64"),
            "source",
        )
    }

    pub(crate) fn revalidate_source_entry(&self) -> Result<(), String> {
        let held_identity = markdown_file_identity(&self.source.metadata().map_err(|error| {
            format!("Could not inspect the held Notes Markdown source: {error}")
        })?);
        if held_identity != self.source_identity {
            return Err("The held Notes Markdown source identity changed.".to_string());
        }
        let current =
            open_markdown_file_nofollow(&self.parent, &self.source_name).map_err(|error| {
                format!("Notes Markdown source identity changed before import commit: {error}")
            })?;
        let current_metadata = current.metadata().map_err(|error| {
            format!("Could not inspect the current Notes Markdown source entry: {error}")
        })?;
        if !current_metadata.file_type().is_file()
            || markdown_file_identity(&current_metadata) != self.source_identity
        {
            return Err("Notes Markdown source identity changed before import commit.".to_string());
        }
        Ok(())
    }
}

/// Import-local mapping from canonical asset links to owned prepared bytes and
/// content-addressed publication candidates. It is deliberately separate from
/// the generic attachment batch because import permits up to 512 distinct
/// assets while paste/image-node operations remain capped at 128.
pub(crate) struct PreparedMarkdownAssets {
    pub(crate) batch: PreparedAttachmentBatch,
    pub(crate) prepared_by_link: HashMap<String, usize>,
    pub(crate) unique_publication_indices: Vec<usize>,
}

pub(crate) fn hold_markdown_import_source(
    source_path: &str,
) -> Result<HeldMarkdownImportSource, String> {
    if source_path.trim().is_empty() {
        return Err("A Notes Markdown source path is required.".to_string());
    }
    let source_path = Path::new(source_path);
    let source_name = source_path
        .file_name()
        .filter(|name| {
            matches!(
                Path::new(name).components().next(),
                Some(Component::Normal(_))
            )
        })
        .map(PathBuf::from)
        .ok_or_else(|| "A Notes Markdown source must name a file.".to_string())?;
    let parent_path = source_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent = Dir::open_ambient_dir(parent_path, ambient_authority())
        .map_err(|error| format!("Could not open the Notes Markdown source directory: {error}"))?;
    let source = open_markdown_file_nofollow(&parent, &source_name)
        .map_err(|error| format!("Could not open the Notes Markdown source: {error}"))?;
    let metadata = source
        .metadata()
        .map_err(|error| format!("Could not inspect the Notes Markdown source: {error}"))?;
    if !metadata.file_type().is_file() {
        return Err("A Notes Markdown source must be a regular file.".to_string());
    }
    Ok(HeldMarkdownImportSource {
        parent,
        source_name,
        source_identity: markdown_file_identity(&metadata),
        source,
    })
}

pub(crate) fn prepare_markdown_assets(
    source: &HeldMarkdownImportSource,
    relative_links: &[&str],
    permit: AttachmentImportPermit,
    after_all_assets_prepared: impl FnOnce(),
) -> Result<PreparedMarkdownAssets, String> {
    #[cfg(test)]
    let _asset_open_hook_reset = MarkdownAssetOpenHookReset;

    let max_placements = usize::try_from(MAX_NOTE_ATTACHMENTS_PER_VAULT)
        .map_err(|_| "The Notes Markdown attachment placement cap is invalid.".to_string())?;
    if relative_links.is_empty() || relative_links.len() > max_placements {
        return Err(format!(
            "Notes Markdown import must contain between 1 and {max_placements} asset links."
        ));
    }
    let mut parsed_links = Vec::with_capacity(relative_links.len());
    let mut asset_directory_name = None;
    for &relative_link in relative_links {
        let (directory, file_name, declared_mime_type) = markdown_asset_components(relative_link)?;
        if let Some(expected_directory) = asset_directory_name.as_ref() {
            if expected_directory != &directory {
                return Err("Notes Markdown import assets must use one directory.".to_string());
            }
        } else {
            asset_directory_name = Some(directory);
        }
        parsed_links.push(MarkdownAssetLink {
            relative_link,
            file_name,
            declared_mime_type,
        });
    }
    let asset_directory_name = asset_directory_name
        .as_deref()
        .expect("nonempty asset links produce one directory");
    let asset_directory = source
        .parent
        .open_dir_nofollow(Path::new(asset_directory_name))
        .map_err(|error| format!("Could not open the Notes Markdown asset directory: {error}"))?;
    let mut prepared_by_link = HashMap::with_capacity(relative_links.len());
    let mut owned_assets = Vec::with_capacity(relative_links.len());
    let mut aggregate_bytes = 0_u64;

    for parsed_link in parsed_links {
        if prepared_by_link.contains_key(parsed_link.relative_link) {
            continue;
        }
        maybe_inject_markdown_asset_open_hook();
        let asset_file =
            open_markdown_file_nofollow(&asset_directory, Path::new(parsed_link.file_name))
                .map_err(|error| format!("Could not open the Notes Markdown asset: {error}"))?;
        let metadata = asset_file
            .metadata()
            .map_err(|error| format!("Could not inspect the Notes Markdown asset: {error}"))?;
        if !metadata.file_type().is_file() {
            return Err("A Notes Markdown asset must be a regular file.".to_string());
        }
        let byte_length = metadata.len();
        if byte_length == 0 || byte_length > crate::notes::attachments::MAX_ATTACHMENT_BYTES {
            return Err(format!(
                "Notes attachment images must contain between 1 and {} bytes.",
                crate::notes::attachments::MAX_ATTACHMENT_BYTES
            ));
        }
        aggregate_bytes = aggregate_bytes
            .checked_add(byte_length)
            .ok_or_else(|| "The Notes attachment batch byte length overflowed.".to_string())?;
        if aggregate_bytes > crate::notes::attachments::MAX_ATTACHMENT_BATCH_BYTES {
            return Err(format!(
                "Notes attachment batches must contain at most {} image bytes.",
                crate::notes::attachments::MAX_ATTACHMENT_BATCH_BYTES
            ));
        }
        let bytes = read_markdown_file_bounded(
            &asset_file,
            crate::notes::attachments::MAX_ATTACHMENT_BYTES,
            "asset",
        )?;
        let index = owned_assets.len();
        prepared_by_link.insert(parsed_link.relative_link.to_string(), index);
        owned_assets.push(OwnedMarkdownAsset {
            file_name: parsed_link.file_name.to_string(),
            declared_mime_type: parsed_link.declared_mime_type,
            bytes,
        });
    }

    let raw_sources = owned_assets
        .iter()
        .map(
            |asset| crate::notes::attachment_ingest::RawAttachmentSource {
                original_name: asset.file_name.clone(),
                declared_mime_type: asset.declared_mime_type.to_string(),
                bytes: &asset.bytes,
            },
        )
        .collect::<Vec<_>>();
    let batch = PreparedAttachmentBatch::from_markdown_import_bytes_with_import_permit(
        raw_sources,
        permit,
    )?;
    let mut payloads = HashSet::new();
    let mut unique_publication_indices = Vec::new();
    for (index, attachment) in batch.attachments().iter().enumerate() {
        let payload = format!(
            "{}.{}",
            attachment.image.content_hash, attachment.image.extension
        );
        if payloads.insert(payload) {
            unique_publication_indices.push(index);
        }
    }
    after_all_assets_prepared();
    Ok(PreparedMarkdownAssets {
        batch,
        prepared_by_link,
        unique_publication_indices,
    })
}

#[cfg(test)]
thread_local! {
    static MARKDOWN_ASSET_OPEN_HOOK: std::cell::RefCell<Option<Box<dyn FnMut()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
struct MarkdownAssetOpenHookReset;

#[cfg(test)]
impl Drop for MarkdownAssetOpenHookReset {
    fn drop(&mut self) {
        MARKDOWN_ASSET_OPEN_HOOK.with(|hook| *hook.borrow_mut() = None);
    }
}

#[cfg(test)]
pub(crate) fn inject_markdown_asset_open_hook(action: impl FnMut() + 'static) {
    MARKDOWN_ASSET_OPEN_HOOK.with(|hook| *hook.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
pub(crate) fn clear_markdown_asset_open_hook() {
    MARKDOWN_ASSET_OPEN_HOOK.with(|hook| *hook.borrow_mut() = None);
}

#[cfg(test)]
pub(crate) fn markdown_asset_open_hook_is_clear() -> bool {
    MARKDOWN_ASSET_OPEN_HOOK.with(|hook| hook.borrow().is_none())
}

#[cfg(test)]
fn maybe_inject_markdown_asset_open_hook() {
    MARKDOWN_ASSET_OPEN_HOOK.with(|hook| {
        if let Some(action) = hook.borrow_mut().as_mut() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_markdown_asset_open_hook() {}

struct OwnedMarkdownAsset {
    file_name: String,
    declared_mime_type: &'static str,
    bytes: Vec<u8>,
}

struct MarkdownAssetLink<'a> {
    relative_link: &'a str,
    file_name: &'a str,
    declared_mime_type: &'static str,
}

fn markdown_file_identity(metadata: &cap_std::fs::Metadata) -> MarkdownFileIdentity {
    MarkdownFileIdentity {
        volume: MetadataExt::dev(metadata),
        file: MetadataExt::ino(metadata),
    }
}

fn open_markdown_file_nofollow(parent: &Dir, name: &Path) -> std::io::Result<CapFile> {
    let mut options = CapOpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    parent.open_with(name, &options)
}

fn read_markdown_file_bounded(
    file: &CapFile,
    max_bytes: u64,
    kind: &str,
) -> Result<Vec<u8>, String> {
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect the Notes Markdown {kind}: {error}"))?;
    if !metadata.file_type().is_file() {
        return Err(format!("A Notes Markdown {kind} must be a regular file."));
    }
    if metadata.len() > max_bytes {
        return Err(format!("Notes Markdown {kind} exceeds its byte limit."));
    }
    let mut reader = file
        .try_clone()
        .map_err(|error| format!("Could not read the Notes Markdown {kind}: {error}"))?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|error| format!("Could not read the Notes Markdown {kind}: {error}"))?;
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    reader
        .by_ref()
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read the Notes Markdown {kind}: {error}"))?;
    if u64::try_from(bytes.len()).is_ok_and(|length| length > max_bytes) {
        return Err(format!("Notes Markdown {kind} exceeds its byte limit."));
    }
    Ok(bytes)
}

fn markdown_asset_components(link: &str) -> Result<(String, &str, &'static str), String> {
    let (directory, _) = parse_asset_link(link)?;
    let (_, file_name) = link
        .split_once('/')
        .ok_or_else(|| "Notes Markdown image asset link is invalid.".to_string())?;
    let declared_mime_type = if file_name.ends_with(".png") {
        "image/png"
    } else if file_name.ends_with(".jpg") {
        "image/jpeg"
    } else if file_name.ends_with(".webp") {
        "image/webp"
    } else if file_name.ends_with(".gif") {
        "image/gif"
    } else {
        return Err("Notes Markdown image asset filename is invalid.".to_string());
    };
    Ok((directory, file_name, declared_mime_type))
}

pub(crate) fn parse_notes_markdown(source: &str) -> Result<Vec<ParsedMarkdownNode>, String> {
    if source.len() > MAX_MARKDOWN_BYTES {
        return Err("Notes Markdown import exceeds the 16 MiB document limit.".to_string());
    }
    reject_lone_carriage_returns(source)?;
    if !source.ends_with('\n') {
        return Err("Notes Markdown import must end with a line feed.".to_string());
    }

    let normalized = source.replace("\r\n", "\n");
    let document = normalized
        .strip_suffix('\n')
        .expect("source ending was checked above");
    let mut lines = document.split('\n').peekable();
    let root_id = parse_frontmatter(&mut lines)?;

    let separator = lines
        .next()
        .ok_or_else(|| "Notes Markdown frontmatter needs one blank separator line.".to_string())?;
    validate_physical_line(separator)?;
    if !separator.is_empty() {
        return Err("Notes Markdown frontmatter needs one blank separator line.".to_string());
    }
    let heading = if let Some(line) = lines.peek().copied() {
        validate_physical_line(line)?;
        if let Some(encoded) = line.strip_prefix("# ") {
            lines.next();
            let heading = decode_escaped_text(encoded)?;
            ensure_field_budget(&heading, "heading")?;
            let blank = lines.next().ok_or_else(|| {
                "A text Notes Markdown root heading needs one blank line.".to_string()
            })?;
            validate_physical_line(blank)?;
            if !blank.is_empty() {
                return Err("A text Notes Markdown root heading needs one blank line.".to_string());
            }
            Some(heading)
        } else {
            None
        }
    } else {
        None
    };

    let mut nodes = Vec::new();
    let mut source_ids = HashSet::new();
    let mut last_at_depth: Vec<usize> = Vec::new();
    let mut assets = AssetTracker::default();
    let mut previous_depth: Option<usize> = None;

    while let Some(line) = lines.next() {
        validate_physical_line(line)?;
        let marker = parse_marker(line)?
            .ok_or_else(|| "Notes Markdown content must use canonical list markers.".to_string())?;
        let depth_limit = marker
            .depth
            .checked_add(1)
            .ok_or_else(|| "Notes Markdown nesting depth is too large.".to_string())?;
        if depth_limit > MAX_IMPORT_SUBTREE_DEPTH {
            return Err("Notes Markdown nesting depth exceeds the import limit.".to_string());
        }
        if let Some(previous_depth) = previous_depth {
            if marker.depth == 0 || marker.depth > previous_depth.saturating_add(1) {
                return Err("Notes Markdown list marker depth is not canonical.".to_string());
            }
        } else if marker.depth != 0 {
            return Err("Notes Markdown import must begin with one root marker.".to_string());
        }
        previous_depth = Some(marker.depth);

        if !source_ids.insert(marker.source_id.clone()) {
            return Err("Notes Markdown source node IDs must be unique.".to_string());
        }
        if nodes.is_empty() && marker.source_id != root_id {
            return Err("Notes Markdown root marker does not match frontmatter.".to_string());
        }
        if nodes.len() >= MAX_IMPORT_SUBTREE_NODES {
            return Err("Notes Markdown import exceeds the node limit.".to_string());
        }

        let parent = if marker.depth == 0 {
            None
        } else {
            Some(
                last_at_depth
                    .get(marker.depth - 1)
                    .copied()
                    .ok_or_else(|| {
                        "Notes Markdown list marker depth is not canonical.".to_string()
                    })?,
            )
        };
        last_at_depth.truncate(marker.depth);

        let (title, image) = parse_primary(&marker.primary, &mut assets)?;
        ensure_field_budget(&title, "title")?;
        let image_offset_utf16 = image.as_ref().map(|_| 0);
        nodes.push(FlatNode {
            parent,
            depth: marker.depth,
            title,
            image_offset_utf16,
            note: String::new(),
            note_lines: 0,
            completed: marker.completed,
            image,
            after_seen: false,
            note_started: false,
        });
        let index = nodes.len() - 1;
        last_at_depth.push(index);

        while let Some(next) = lines.peek().copied() {
            validate_physical_line(next)?;
            if is_marker_candidate(next) {
                break;
            }
            let continuation = lines.next().expect("the peeked line still exists");
            parse_continuation(&mut nodes[index], continuation, &mut assets)?;
        }

        if index == 0 {
            match &heading {
                Some(heading) if nodes[index].image.is_none() && nodes[index].title == *heading => {
                }
                Some(_) => {
                    return Err(
                        "Notes Markdown text root heading does not match the root node."
                            .to_string(),
                    )
                }
                None if nodes[index].image.is_none() => {
                    return Err(
                        "A text Notes Markdown root requires a canonical heading.".to_string()
                    )
                }
                None => {}
            }
        }
    }

    if nodes.is_empty() {
        return Err("Notes Markdown import must contain one root node.".to_string());
    }
    if nodes.iter().filter(|node| node.depth == 0).count() != 1 {
        return Err("Notes Markdown import must contain exactly one root node.".to_string());
    }
    build_tree(nodes)
}

#[derive(Debug)]
struct FlatNode {
    parent: Option<usize>,
    depth: usize,
    title: String,
    image_offset_utf16: Option<i64>,
    note: String,
    note_lines: usize,
    completed: bool,
    image: Option<ParsedMarkdownImage>,
    after_seen: bool,
    note_started: bool,
}

#[derive(Debug)]
struct Marker {
    depth: usize,
    completed: bool,
    primary: String,
    source_id: String,
}

#[derive(Default)]
struct AssetTracker {
    directory: Option<String>,
    links: HashSet<String>,
    placements: usize,
}

impl AssetTracker {
    fn record(&mut self, relative_link: &str) -> Result<(), String> {
        self.placements = self
            .placements
            .checked_add(1)
            .ok_or_else(|| "Notes Markdown image placement count is too large.".to_string())?;
        if self.placements > MAX_NOTE_ATTACHMENTS_PER_VAULT as usize {
            return Err("Notes Markdown import exceeds the image placement limit.".to_string());
        }

        let (directory, ordinal) = parse_asset_link(relative_link)?;
        if let Some(existing) = &self.directory {
            if existing != &directory {
                return Err("Notes Markdown image links must use one asset directory.".to_string());
            }
        } else {
            self.directory = Some(directory);
        }
        if self.links.insert(relative_link.to_string()) {
            if self.links.len() > MAX_NOTE_ATTACHMENTS_PER_VAULT as usize {
                return Err("Notes Markdown import exceeds the distinct asset limit.".to_string());
            }
            if ordinal != self.links.len() {
                return Err("Notes Markdown image asset ordinals must be contiguous.".to_string());
            }
        }
        Ok(())
    }
}

fn reject_lone_carriage_returns(source: &str) -> Result<(), String> {
    let bytes = source.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\r' {
            if bytes.get(index + 1) != Some(&b'\n') {
                return Err(
                    "Notes Markdown import does not accept lone carriage returns.".to_string(),
                );
            }
            index += 2;
        } else {
            index += 1;
        }
    }
    Ok(())
}

fn validate_physical_line(line: &str) -> Result<(), String> {
    let limit = MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES
        .checked_add(4096)
        .ok_or_else(|| "Notes Markdown physical line limit is invalid.".to_string())?;
    if line.len() > limit {
        return Err("Notes Markdown import contains an oversized physical line.".to_string());
    }
    Ok(())
}

fn parse_frontmatter<'a>(
    lines: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<String, String> {
    for expected in [
        "---",
        "kind: yonalist-notes-export",
        "format_version: 1",
        "source: notes.sqlite",
    ] {
        let line = lines
            .next()
            .ok_or_else(|| "Notes Markdown frontmatter is incomplete.".to_string())?;
        validate_physical_line(line)?;
        if line != expected {
            return Err("Notes Markdown frontmatter is not canonical.".to_string());
        }
    }
    let root = lines
        .next()
        .ok_or_else(|| "Notes Markdown frontmatter is incomplete.".to_string())?;
    validate_physical_line(root)?;
    let root_id = root
        .strip_prefix("root_node_id: \"")
        .and_then(|value| value.strip_suffix('"'))
        .ok_or_else(|| "Notes Markdown root node ID frontmatter is invalid.".to_string())?;
    validate_source_id(root_id)?;
    let exported_at = lines
        .next()
        .ok_or_else(|| "Notes Markdown frontmatter is incomplete.".to_string())?;
    validate_physical_line(exported_at)?;
    let exported_at = exported_at
        .strip_prefix("exported_at: \"")
        .and_then(|value| value.strip_suffix('"'))
        .filter(|value| !value.is_empty() && !value.contains('"'))
        .ok_or_else(|| "Notes Markdown exported_at frontmatter is invalid.".to_string())?;
    let _ = exported_at;
    let closing = lines
        .next()
        .ok_or_else(|| "Notes Markdown frontmatter is incomplete.".to_string())?;
    validate_physical_line(closing)?;
    if closing != "---" {
        return Err("Notes Markdown frontmatter is not canonical.".to_string());
    }
    Ok(root_id.to_string())
}

fn validate_source_id(id: &str) -> Result<(), String> {
    validate_note_id(id)?;
    if id.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Err(
            "Notes Markdown source IDs must use canonical lowercase UUID v4 strings.".to_string(),
        );
    }
    Ok(())
}

fn is_marker_candidate(line: &str) -> bool {
    line.trim_start_matches(' ').starts_with("- [")
}

fn parse_marker(line: &str) -> Result<Option<Marker>, String> {
    if !is_marker_candidate(line) {
        return Ok(None);
    }
    let indentation = line.len() - line.trim_start_matches(' ').len();
    if indentation % 2 != 0 {
        return Err("Notes Markdown marker indentation must use two spaces per depth.".to_string());
    }
    let depth = indentation / 2;
    let rest = &line[indentation..];
    let (completed, primary) = if let Some(primary) = rest.strip_prefix("- [ ] ") {
        (false, primary)
    } else if let Some(primary) = rest.strip_prefix("- [x] ") {
        (true, primary)
    } else {
        return Err("Notes Markdown completion marker is not canonical.".to_string());
    };
    let without_closing = primary
        .strip_suffix(" -->")
        .ok_or_else(|| "Notes Markdown node marker is invalid.".to_string())?;
    let (primary, source_id) = without_closing
        .rsplit_once(NODE_MARKER_PREFIX)
        .ok_or_else(|| "Notes Markdown node marker is invalid.".to_string())?;
    validate_source_id(source_id)?;
    Ok(Some(Marker {
        depth,
        completed,
        primary: primary.to_string(),
        source_id: source_id.to_string(),
    }))
}

fn parse_primary(
    primary: &str,
    assets: &mut AssetTracker,
) -> Result<(String, Option<ParsedMarkdownImage>), String> {
    if primary.starts_with("![") {
        return Ok((String::new(), Some(parse_image(primary, assets)?)));
    }
    Ok((decode_escaped_text(primary)?, None))
}

fn parse_continuation(
    node: &mut FlatNode,
    line: &str,
    assets: &mut AssetTracker,
) -> Result<(), String> {
    let indentation = "  ".repeat(
        node.depth
            .checked_add(1)
            .ok_or_else(|| "Notes Markdown nesting depth is too large.".to_string())?,
    );
    let content = line
        .strip_prefix(&indentation)
        .ok_or_else(|| "Notes Markdown continuation depth is not canonical.".to_string())?;

    if content == ">" || content.starts_with("> ") {
        let encoded = if content == ">" { "" } else { &content[2..] };
        if encoded.is_empty() && content != ">" {
            return Err("Notes Markdown blank notes must use the canonical > form.".to_string());
        }
        let note_line = decode_note_text(encoded)?;
        append_note_line(node, &note_line)?;
        node.note_started = true;
        return Ok(());
    }

    if content.starts_with("![") {
        if node.image.is_some() {
            return Err("Notes Markdown image nodes may contain only one image.".to_string());
        }
        if node.title.is_empty() {
            return Err(
                "Notes Markdown image continuations require a nonempty before segment.".to_string(),
            );
        }
        if node.note_started || node.after_seen {
            return Err("Notes Markdown image continuation is out of order.".to_string());
        }
        if !content.starts_with("![Image]") {
            return Err(LEGACY_TEXT_ATTACHMENT_ERROR.to_string());
        }
        let image =
            parse_image(content, assets).map_err(|_| LEGACY_TEXT_ATTACHMENT_ERROR.to_string())?;
        node.image_offset_utf16 = Some(
            i64::try_from(node.title.encode_utf16().count())
                .map_err(|_| "Notes Markdown image offset is too large.".to_string())?,
        );
        node.image = Some(image);
        return Ok(());
    }

    if node.image.is_none() {
        return Err("Notes Markdown text nodes do not allow primary continuations.".to_string());
    }
    if node.note_started || node.after_seen || content.is_empty() {
        return Err("Notes Markdown image after text is not canonical.".to_string());
    }
    let after = decode_escaped_text(content)?;
    let title_bytes = node
        .title
        .len()
        .checked_add(after.len())
        .ok_or_else(|| "Notes Markdown title is too large.".to_string())?;
    if title_bytes > MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES {
        return Err("Notes Markdown title exceeds the import limit.".to_string());
    }
    node.title.push_str(&after);
    node.after_seen = true;
    Ok(())
}

fn append_note_line(node: &mut FlatNode, line: &str) -> Result<(), String> {
    let separator = usize::from(node.note_lines != 0);
    let length = node
        .note
        .len()
        .checked_add(separator)
        .and_then(|length| length.checked_add(line.len()))
        .ok_or_else(|| "Notes Markdown note is too large.".to_string())?;
    if length > MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES {
        return Err("Notes Markdown note exceeds the import limit.".to_string());
    }
    if node.note_lines != 0 {
        node.note.push('\n');
    }
    node.note.push_str(line);
    node.note_lines = node
        .note_lines
        .checked_add(1)
        .ok_or_else(|| "Notes Markdown note has too many lines.".to_string())?;
    Ok(())
}

fn parse_image(value: &str, assets: &mut AssetTracker) -> Result<ParsedMarkdownImage, String> {
    let value = value
        .strip_prefix("![Image](")
        .ok_or_else(|| "Notes Markdown image syntax is not canonical.".to_string())?;
    let (relative_link, metadata) = value
        .split_once(')')
        .ok_or_else(|| "Notes Markdown image syntax is not canonical.".to_string())?;
    let encoded_name = metadata
        .strip_prefix(ORIGINAL_NAME_PREFIX)
        .and_then(|value| value.strip_suffix(" -->"))
        .ok_or_else(|| "Notes Markdown image metadata is not canonical.".to_string())?;
    let original_name = decode_canonical_original_name(encoded_name)?;
    assets.record(relative_link)?;
    Ok(ParsedMarkdownImage {
        relative_link: relative_link.to_string(),
        original_name,
    })
}

fn parse_asset_link(link: &str) -> Result<(String, usize), String> {
    if link.is_empty()
        || link.contains(['\\', '\0', '?', '#'])
        || link.starts_with('/')
        || link.contains("://")
    {
        return Err("Notes Markdown image asset link is invalid.".to_string());
    }
    let mut components = link.split('/');
    let encoded_directory = components
        .next()
        .ok_or_else(|| "Notes Markdown image asset link is invalid.".to_string())?;
    let filename = components
        .next()
        .ok_or_else(|| "Notes Markdown image asset link is invalid.".to_string())?;
    if components.next().is_some() {
        return Err("Notes Markdown image asset link is invalid.".to_string());
    }
    let directory = percent_decode_canonical(encoded_directory, true)?;
    if directory.is_empty()
        || matches!(directory.as_str(), "." | "..")
        || directory.contains(['/', '\\', '\0'])
        || directory.chars().any(char::is_control)
        || directory
            .as_bytes()
            .get(1)
            .is_some_and(|byte| *byte == b':')
    {
        return Err("Notes Markdown image asset directory is invalid.".to_string());
    }

    let (ordinal, extension) = filename
        .split_once('.')
        .ok_or_else(|| "Notes Markdown image asset filename is invalid.".to_string())?;
    if ordinal.len() != 4
        || !ordinal.bytes().all(|byte| byte.is_ascii_digit())
        || !matches!(extension, "png" | "jpg" | "webp" | "gif")
    {
        return Err("Notes Markdown image asset filename is invalid.".to_string());
    }
    let ordinal = ordinal
        .parse::<usize>()
        .map_err(|_| "Notes Markdown image asset filename is invalid.".to_string())?;
    if ordinal == 0 {
        return Err("Notes Markdown image asset filename is invalid.".to_string());
    }
    Ok((directory, ordinal))
}

pub(crate) fn decode_canonical_original_name(encoded: &str) -> Result<String, String> {
    if encoded.len() > MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES {
        return Err("Notes Markdown image original name is invalid.".to_string());
    }
    let original_name = percent_decode_canonical(encoded, false)?;
    if original_name.trim().is_empty() || original_name.len() > 1024 {
        return Err("Notes Markdown image original name is invalid.".to_string());
    }
    Ok(original_name)
}

fn percent_decode_canonical(encoded: &str, asset_directory: bool) -> Result<String, String> {
    let mut decoded = Vec::with_capacity(encoded.len());
    let bytes = encoded.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if is_raw_percent_allowed(byte, asset_directory) {
            decoded.push(byte);
            index += 1;
            continue;
        }
        if byte != b'%' || index.checked_add(2).is_none_or(|end| end >= bytes.len()) {
            return Err("Notes Markdown percent encoding is not canonical.".to_string());
        }
        let high = hex_value(bytes[index + 1])
            .ok_or_else(|| "Notes Markdown percent encoding is not canonical.".to_string())?;
        let low = hex_value(bytes[index + 2])
            .ok_or_else(|| "Notes Markdown percent encoding is not canonical.".to_string())?;
        if bytes[index + 1].is_ascii_lowercase() || bytes[index + 2].is_ascii_lowercase() {
            return Err("Notes Markdown percent encoding is not canonical.".to_string());
        }
        decoded.push(high << 4 | low);
        index += 3;
    }
    let decoded = String::from_utf8(decoded)
        .map_err(|_| "Notes Markdown percent metadata must be UTF-8.".to_string())?;
    let canonical = percent_encode(&decoded, asset_directory);
    if canonical != encoded {
        return Err("Notes Markdown percent encoding is not canonical.".to_string());
    }
    Ok(decoded)
}

fn is_raw_percent_allowed(byte: u8, asset_directory: bool) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(byte, b'.' | b'_' | b'~')
        || asset_directory && byte == b'-'
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_encode(value: &str, asset_directory: bool) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if is_raw_percent_allowed(byte, asset_directory) {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(encoded, "%{byte:02X}").expect("writing to a String cannot fail");
        }
    }
    encoded
}

fn decode_escaped_text(encoded: &str) -> Result<String, String> {
    decode_escaped_text_with_newlines(encoded, true)
}

fn decode_note_text(encoded: &str) -> Result<String, String> {
    decode_escaped_text_with_newlines(encoded, false)
}

fn decode_escaped_text_with_newlines(encoded: &str, primary_text: bool) -> Result<String, String> {
    let mut decoded = String::with_capacity(encoded.len());
    let mut index = 0;
    while index < encoded.len() {
        let remaining = &encoded[index..];
        if remaining.starts_with("&amp;") {
            decoded.push('&');
            index += 5;
        } else if remaining.starts_with("&lt;") {
            decoded.push('<');
            index += 4;
        } else if remaining.starts_with("&gt;") {
            decoded.push('>');
            index += 4;
        } else if remaining.starts_with('&') {
            return Err("Notes Markdown text entity is not canonical.".to_string());
        } else if remaining.starts_with('\\') {
            let character = remaining
                .chars()
                .nth(1)
                .ok_or_else(|| "Notes Markdown text escape is incomplete.".to_string())?;
            if character == 'n' && primary_text {
                decoded.push('\n');
            } else if character.is_ascii_punctuation() {
                decoded.push(character);
            } else {
                return Err("Notes Markdown text escape is not canonical.".to_string());
            }
            index += 1 + character.len_utf8();
        } else {
            let character = remaining
                .chars()
                .next()
                .expect("a nonempty string has a first character");
            if character.is_ascii_punctuation() {
                return Err("Notes Markdown text punctuation must be escaped.".to_string());
            }
            decoded.push(character);
            index += character.len_utf8();
        }
    }
    let canonical = if primary_text {
        escape_inline(&decoded)
    } else {
        escape_markdown(&decoded)
    };
    if canonical != encoded {
        return Err("Notes Markdown text encoding is not canonical.".to_string());
    }
    Ok(decoded)
}

fn escape_inline(value: &str) -> String {
    value
        .split('\n')
        .map(escape_markdown)
        .collect::<Vec<_>>()
        .join(r"\n")
}

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

fn ensure_field_budget(value: &str, field: &str) -> Result<(), String> {
    if value.len() > MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES {
        return Err(format!("Notes Markdown {field} exceeds the import limit."));
    }
    Ok(())
}

fn build_tree(nodes: Vec<FlatNode>) -> Result<Vec<ParsedMarkdownNode>, String> {
    let mut children = (0..nodes.len()).map(|_| Vec::new()).collect::<Vec<_>>();
    let mut roots = Vec::new();
    for (index, node) in nodes.into_iter().enumerate().rev() {
        let mut node_children = std::mem::take(&mut children[index]);
        node_children.reverse();
        let parsed = ParsedMarkdownNode {
            title: node.title,
            image_offset_utf16: node.image_offset_utf16.unwrap_or(0),
            note: node.note,
            completed: node.completed,
            image: node.image,
            children: node_children,
        };
        if let Some(parent) = node.parent {
            children[parent].push(parsed);
        } else {
            roots.push(parsed);
        }
    }
    roots.reverse();
    if roots.len() != 1 {
        return Err("Notes Markdown import must contain exactly one root node.".to_string());
    }
    Ok(roots)
}

#[cfg(test)]
mod tests {
    use super::{parse_notes_markdown, MAX_MARKDOWN_BYTES};
    use crate::notes::export::prepare_markdown_export;
    use crate::notes::types::{
        ExportAttachment, ExportNode, NoteNodeKind, NotesExportSnapshot, MAX_IMPORT_SUBTREE_DEPTH,
        MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES, MAX_IMPORT_SUBTREE_NODES,
        MAX_NOTE_ATTACHMENTS_PER_VAULT,
    };
    use std::sync::Arc;

    const ROOT_ID: &str = "11111111-1111-4111-8111-111111111111";
    const CHILD_ID: &str = "22222222-2222-4222-8222-222222222222";
    const SIBLING_ID: &str = "33333333-3333-4333-8333-333333333333";
    const IMAGE_ID: &str = "44444444-4444-4444-8444-444444444444";
    const ATTACHMENT_ID: &str = "55555555-5555-4555-8555-555555555555";
    const MAX_PHYSICAL_LINE_BYTES: usize = MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES + 4096;

    fn frontmatter(root_id: &str) -> String {
        format!(
            "---\nkind: yonalist-notes-export\nformat_version: 1\nsource: notes.sqlite\nroot_node_id: \"{root_id}\"\nexported_at: \"2026-07-19T00:00:00.000Z\"\n---\n\n"
        )
    }

    fn text_document(root_title: &str, root_id: &str) -> String {
        format!(
            "{}# {root_title}\n\n- [ ] {root_title} <!-- yonalist-node-id: {root_id} -->\n",
            frontmatter(root_id)
        )
    }

    fn image_document(root_id: &str, image: &str) -> String {
        format!(
            "{}- [ ] {image} <!-- yonalist-node-id: {root_id} -->\n",
            frontmatter(root_id)
        )
    }

    fn image_line(link: &str) -> String {
        format!("![Image]({link}) <!-- yonalist-attachment-original-name: photo.png -->")
    }

    fn physical_line_document(line_bytes: usize) -> String {
        let prefix = "- [ ] ";
        let suffix = format!(" <!-- yonalist-node-id: {ROOT_ID} -->");
        let escaped_title_bytes = line_bytes - prefix.len() - suffix.len();
        let escaped_punctuation_count = escaped_title_bytes / 2;
        let has_safe_tail = escaped_title_bytes % 2 == 1;
        let mut escaped_title = r"\!".repeat(escaped_punctuation_count);
        let mut decoded_title = "!".repeat(escaped_punctuation_count);
        if has_safe_tail {
            escaped_title.push('a');
            decoded_title.push('a');
        }
        assert!(decoded_title.len() < MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES);

        let source = format!(
            "{}# {escaped_title}\n\n{prefix}{escaped_title}{suffix}\n",
            frontmatter(ROOT_ID)
        );
        let list_line = source.lines().last().expect("list marker");
        assert_eq!(list_line.len(), line_bytes);
        source
    }

    fn node_id(index: usize) -> String {
        format!("00000000-0000-4000-8000-{index:012x}")
    }

    fn attachment(name: &str) -> ExportAttachment {
        ExportAttachment {
            id: ATTACHMENT_ID.to_string(),
            relative_path: "attachments/owned.png".to_string(),
            content_hash: "a".repeat(64),
            original_name: name.to_string(),
            mime_type: "image/png".to_string(),
            byte_size: 3,
            intrinsic_width: 1,
            intrinsic_height: 1,
            display_width: 1,
            bytes: Some(Arc::from(vec![1, 2, 3])),
        }
    }

    fn text_node(
        id: &str,
        title: &str,
        note: &str,
        completed: bool,
        children: Vec<ExportNode>,
    ) -> ExportNode {
        ExportNode {
            marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
            id: id.to_string(),
            node_kind: NoteNodeKind::Text,
            title: title.to_string(),
            note: note.to_string(),
            image_offset_utf16: 0,
            title_date_spans: Vec::new(),
            note_date_spans: Vec::new(),
            completed,
            attachments: Vec::new(),
            children,
        }
    }

    fn image_node(
        id: &str,
        before: &str,
        after: &str,
        note: &str,
        completed: bool,
        name: &str,
        children: Vec<ExportNode>,
    ) -> ExportNode {
        ExportNode {
            marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
            id: id.to_string(),
            node_kind: NoteNodeKind::Image,
            title: format!("{before}{after}"),
            note: note.to_string(),
            image_offset_utf16: i64::try_from(before.encode_utf16().count())
                .expect("small test offset"),
            title_date_spans: Vec::new(),
            note_date_spans: Vec::new(),
            completed,
            attachments: vec![attachment(name)],
            children,
        }
    }

    fn snapshot(root: ExportNode, title: &str) -> NotesExportSnapshot {
        NotesExportSnapshot {
            root_node_id: root.id.clone(),
            title: title.to_string(),
            exported_at: "2026-07-19T00:00:00.000Z".to_string(),
            root,
        }
    }

    #[test]
    fn canonical_image_atom_forms_parse_to_one_root_with_exact_offsets() {
        for (before, after, completed) in [
            ("", "", false),
            ("", "Below", true),
            ("😀Above", "", false),
            ("😀Above", "Below", true),
        ] {
            let source = image_document(
                ROOT_ID,
                &format!(
                    "![Image](assets/0001.png) <!-- yonalist-attachment-original-name: photo.png -->{}",
                    if before.is_empty() {
                        ""
                    } else {
                        ""
                    }
                ),
            );
            let source = if before.is_empty() {
                let mut source = source;
                if completed {
                    source = source.replacen("- [ ]", "- [x]", 1);
                }
                if after.is_empty() {
                    source
                } else {
                    format!("{}  {after}\n", source)
                }
            } else {
                let checkbox = if completed { "x" } else { " " };
                format!(
                    "{}- [{checkbox}] {before} <!-- yonalist-node-id: {ROOT_ID} -->\n  ![Image](assets/0001.png) <!-- yonalist-attachment-original-name: photo.png -->\n{}",
                    frontmatter(ROOT_ID),
                    if after.is_empty() { String::new() } else { format!("  {after}\n") },
                )
            };

            let roots = parse_notes_markdown(&source).expect("canonical image atom parses");
            assert_eq!(roots.len(), 1);
            let root = &roots[0];
            assert_eq!(root.title, format!("{before}{after}"));
            assert_eq!(
                root.image_offset_utf16,
                before.encode_utf16().count() as i64
            );
            assert_eq!(root.completed, completed);
            assert_eq!(root.note, "");
            assert!(root.children.is_empty());
            assert_eq!(
                root.image
                    .as_ref()
                    .map(|image| image.relative_link.as_str()),
                Some("assets/0001.png")
            );
            assert_eq!(
                root.image
                    .as_ref()
                    .map(|image| image.original_name.as_str()),
                Some("photo.png")
            );
        }
    }

    #[test]
    fn canonical_export_round_trip_restores_multiline_primary_note_and_hierarchy() {
        let root = text_node(
            ROOT_ID,
            "Root",
            "",
            false,
            vec![
                image_node(
                    CHILD_ID,
                    "😀Before!\\ punctuation\nsecond",
                    "After & < >\nlast",
                    "Note first\n\nNote last",
                    true,
                    "photo --> 이름.png",
                    vec![text_node(IMAGE_ID, "Child", "", false, Vec::new())],
                ),
                text_node(SIBLING_ID, "Sibling", "", false, Vec::new()),
            ],
        );
        let prepared = prepare_markdown_export(&snapshot(root, "Root"), "assets")
            .expect("Task 13 canonical Markdown");
        let source = std::str::from_utf8(&prepared.markdown).expect("UTF-8 export");

        let roots = parse_notes_markdown(source).expect("canonical export parses");
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].title, "Root");
        assert_eq!(roots[0].children.len(), 2);
        let image = &roots[0].children[0];
        assert_eq!(
            image.title,
            "😀Before!\\ punctuation\nsecondAfter & < >\nlast"
        );
        assert_eq!(
            image.image_offset_utf16,
            "😀Before!\\ punctuation\nsecond".encode_utf16().count() as i64
        );
        assert_eq!(image.note, "Note first\n\nNote last");
        assert!(image.completed);
        assert_eq!(image.children.len(), 1);
        assert_eq!(image.children[0].title, "Child");
        assert_eq!(roots[0].children[1].title, "Sibling");
        assert_eq!(
            image
                .image
                .as_ref()
                .map(|value| value.original_name.as_str()),
            Some("photo --> 이름.png")
        );
    }

    #[test]
    fn canonical_parser_rejects_ambiguous_frontmatter_markers_and_continuations() {
        let canonical = text_document("Root", ROOT_ID);
        let image = image_document(
            ROOT_ID,
            "![Image](assets/0001.png) <!-- yonalist-attachment-original-name: photo.png -->",
        );
        let invalid = vec![
            ("wrong kind", canonical.replacen("yonalist-notes-export", "other", 1)),
            ("wrong version", canonical.replacen("format_version: 1", "format_version: 2", 1)),
            (
                "reordered frontmatter",
                canonical.replacen(
                    "kind: yonalist-notes-export\nformat_version: 1",
                    "format_version: 1\nkind: yonalist-notes-export",
                    1,
                ),
            ),
            ("unknown frontmatter", canonical.replacen("source: notes.sqlite\n", "source: notes.sqlite\nextra: no\n", 1)),
            ("duplicate frontmatter", canonical.replacen("source: notes.sqlite\n", "source: notes.sqlite\nsource: notes.sqlite\n", 1)),
            ("missing frontmatter", canonical.replacen("exported_at: \"2026-07-19T00:00:00.000Z\"\n", "", 1)),
            (
                "missing closing delimiter",
                canonical.replacen("---\n\n# Root\n", "# Root\n", 1),
            ),
            (
                "missing frontmatter separator",
                canonical.replacen("---\n\n# Root\n", "---\n# Root\n", 1),
            ),
            ("blank exported at", canonical.replacen("exported_at: \"2026-07-19T00:00:00.000Z\"", "exported_at: \"\"", 1)),
            ("lone CR", canonical.replace('\n', "\r")),
            ("text root missing heading", canonical.replacen("# Root\n\n", "", 1)),
            ("text root mismatched heading", canonical.replacen("# Root", "# Other", 1)),
            ("root mismatch", canonical.replacen(ROOT_ID, CHILD_ID, 1)),
            (
                "duplicate marker",
                format!(
                    "{canonical}  - [ ] Other <!-- yonalist-node-id: {ROOT_ID} -->\n"
                ),
            ),
            ("non-v4 marker", canonical.replacen(ROOT_ID, "11111111-1111-3111-8111-111111111111", 2)),
            ("two roots", format!("{}- [ ] Second <!-- yonalist-node-id: {CHILD_ID} -->\n", canonical)),
            ("depth jump", format!("{}    - [ ] Child <!-- yonalist-node-id: {CHILD_ID} -->\n", canonical)),
            ("odd indentation", format!("{} - [ ] Child <!-- yonalist-node-id: {CHILD_ID} -->\n", canonical)),
            ("tab indentation", format!("{}\t- [ ] Child <!-- yonalist-node-id: {CHILD_ID} -->\n", canonical)),
            ("duplicate image", format!("{}  ![Image](assets/0001.png) <!-- yonalist-attachment-original-name: photo.png -->\n", image)),
            ("duplicate after", format!("{}  Below\n  Again\n", image)),
            ("after after note", format!("{}  Below\n  > Note\n  Again\n", image)),
            ("missing marker", canonical.replacen(&format!(" <!-- yonalist-node-id: {ROOT_ID}"), "", 1)),
            (
                "image root heading",
                format!(
                    "{}# Root\n\n{}",
                    frontmatter(ROOT_ID),
                    image
                        .strip_prefix(&frontmatter(ROOT_ID))
                        .expect("canonical image outline")
                ),
            ),
            ("extra trailing content", format!("{canonical}trailing\n")),
        ];
        for (label, source) in invalid {
            assert!(parse_notes_markdown(&source).is_err(), "accepted {label}");
        }

        let canonical_asset = image_line("assets/0001.png");
        let invalid_assets = [
            (
                "wrong alt",
                canonical_asset.replacen("![Image]", "![image]", 1),
            ),
            (
                "title",
                canonical_asset.replacen(
                    "![Image](assets/0001.png)",
                    "![Image](assets/0001.png \"title\")",
                    1,
                ),
            ),
            ("extra comment", format!("{canonical_asset} <!-- extra -->")),
            ("absolute", image_line("/assets/0001.png")),
            ("remote", image_line("https://example.test/0001.png")),
            ("data", image_line("data:image/png;base64,AA==")),
            ("file", image_line("file:///assets/0001.png")),
            ("query", image_line("assets/0001.png?x=1")),
            ("fragment", image_line("assets/0001.png#part")),
            ("backslash", image_line(r"assets\0001.png")),
            ("parent", image_line("../assets/0001.png")),
            ("extra component", image_line("assets/nested/0001.png")),
            ("encoded slash", image_line("assets%2Fescape/0001.png")),
            ("encoded backslash", image_line("assets%5Cescape/0001.png")),
            ("encoded ASCII control", image_line("assets%09/0001.png")),
            (
                "encoded Unicode C1 control",
                image_line("assets%C2%85/0001.png"),
            ),
            ("noncanonical percent", image_line("assets%41/0001.png")),
            ("unsupported extension", image_line("assets/0001.bmp")),
            ("ordinal zero", image_line("assets/0000.png")),
        ];
        for (label, image) in invalid_assets {
            assert!(
                parse_notes_markdown(&image_document(ROOT_ID, &image)).is_err(),
                "accepted invalid asset grammar: {label}"
            );
        }
        for (label, source) in [
            (
                "ordinal gap",
                format!(
                    "{}  - [ ] {} <!-- yonalist-node-id: {} -->\n",
                    image_document(ROOT_ID, &canonical_asset),
                    image_line("assets/0003.png"),
                    node_id(2)
                ),
            ),
            (
                "mixed asset directories",
                format!(
                    "{}  - [ ] {} <!-- yonalist-node-id: {} -->\n",
                    image_document(ROOT_ID, &canonical_asset),
                    image_line("other/0002.png"),
                    node_id(2)
                ),
            ),
        ] {
            assert!(
                parse_notes_markdown(&source).is_err(),
                "accepted invalid asset grammar: {label}"
            );
        }

        let repeated_link = format!(
            "{}  - [ ] {} <!-- yonalist-node-id: {} -->\n",
            image_document(ROOT_ID, &canonical_asset),
            canonical_asset,
            node_id(2)
        );
        let repeated_roots =
            parse_notes_markdown(&repeated_link).expect("repeated canonical asset link parses");
        assert_eq!(repeated_roots.len(), 1);
        assert_eq!(repeated_roots[0].children.len(), 1);
        assert_eq!(
            repeated_roots[0]
                .image
                .as_ref()
                .map(|image| image.relative_link.as_str()),
            Some("assets/0001.png")
        );
        assert_eq!(
            repeated_roots[0].children[0]
                .image
                .as_ref()
                .map(|image| image.relative_link.as_str()),
            Some("assets/0001.png")
        );
        let empty_before_image = format!(
            "{}  - [ ]  <!-- yonalist-node-id: {CHILD_ID} -->\n    {}\n",
            image_document(ROOT_ID, &canonical_asset),
            image_line("assets/0002.png"),
        );
        assert!(
            parse_notes_markdown(&empty_before_image).is_err(),
            "accepted an image continuation with an empty before segment"
        );
        assert!(
            parse_notes_markdown(&canonical.replace('\n', "\r\n")).is_ok(),
            "canonical CRLF document must parse"
        );
        assert!(
            parse_notes_markdown(&canonical).is_ok(),
            "canonical LF control document must parse"
        );
    }

    #[test]
    fn canonical_parser_rejects_legacy_text_attachment_continuation_explicitly() {
        let source = format!(
            "{}  ![legacy.png](assets/0001.png)\n",
            text_document("Root", ROOT_ID)
        );
        let error = parse_notes_markdown(&source).expect_err("legacy attachment must reject");
        assert!(
            error.contains("unsupported legacy text attachment continuation"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn canonical_parser_enforces_document_node_depth_field_and_placement_budgets() {
        let title = "a".repeat(MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES);
        assert!(parse_notes_markdown(&text_document(&title, ROOT_ID)).is_ok());
        let too_long_title = "a".repeat(MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES + 1);
        assert!(parse_notes_markdown(&text_document(&too_long_title, ROOT_ID)).is_err());

        let note = "a".repeat(MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES);
        let note_source = format!("{}  > {note}\n", text_document("Root", ROOT_ID));
        assert!(parse_notes_markdown(&note_source).is_ok());
        let too_long_note = "a".repeat(MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES + 1);
        assert!(parse_notes_markdown(&format!(
            "{}  > {too_long_note}\n",
            text_document("Root", ROOT_ID)
        ))
        .is_err());

        let mut max_nodes = text_document("Root", ROOT_ID);
        for index in 1..MAX_IMPORT_SUBTREE_NODES {
            max_nodes.push_str(&format!(
                "  - [ ] n <!-- yonalist-node-id: {} -->\n",
                node_id(index)
            ));
        }
        assert!(parse_notes_markdown(&max_nodes).is_ok());
        max_nodes.push_str(&format!(
            "  - [ ] n <!-- yonalist-node-id: {} -->\n",
            node_id(MAX_IMPORT_SUBTREE_NODES)
        ));
        assert!(parse_notes_markdown(&max_nodes).is_err());

        let mut max_depth = text_document("Root", ROOT_ID);
        for depth in 1..MAX_IMPORT_SUBTREE_DEPTH {
            max_depth.push_str(&format!(
                "{}- [ ] n <!-- yonalist-node-id: {} -->\n",
                "  ".repeat(depth),
                node_id(depth)
            ));
        }
        assert!(parse_notes_markdown(&max_depth).is_ok());
        max_depth.push_str(&format!(
            "{}- [ ] n <!-- yonalist-node-id: {} -->\n",
            "  ".repeat(MAX_IMPORT_SUBTREE_DEPTH),
            node_id(MAX_IMPORT_SUBTREE_DEPTH)
        ));
        assert!(parse_notes_markdown(&max_depth).is_err());

        let mut max_placements = image_document(ROOT_ID, &image_line("assets/0001.png"));
        for index in 2..=MAX_NOTE_ATTACHMENTS_PER_VAULT as usize {
            max_placements.push_str(&format!(
                "  - [ ] {} <!-- yonalist-node-id: {} -->\n",
                image_line(&format!("assets/{index:04}.png")),
                node_id(index)
            ));
        }
        assert!(parse_notes_markdown(&max_placements).is_ok());
        max_placements.push_str(&format!(
            "  - [ ] {} <!-- yonalist-node-id: {} -->\n",
            image_line(&format!(
                "assets/{:04}.png",
                MAX_NOTE_ATTACHMENTS_PER_VAULT + 1
            )),
            node_id(MAX_NOTE_ATTACHMENTS_PER_VAULT as usize + 1)
        ));
        assert!(parse_notes_markdown(&max_placements).is_err());

        let physical_line = physical_line_document(MAX_PHYSICAL_LINE_BYTES);
        assert!(parse_notes_markdown(&physical_line).is_ok());
        assert!(
            parse_notes_markdown(&physical_line_document(MAX_PHYSICAL_LINE_BYTES + 1)).is_err()
        );

        let base_document = text_document("Root", ROOT_ID);
        let max_extra_per_title = MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES - 1;
        let minimum_line_len = |index: usize| {
            let prefix = "  - [ ] ";
            let suffix = format!(" <!-- yonalist-node-id: {} -->\n", node_id(index));
            prefix.len() + 1 + suffix.len()
        };
        let mut child_count = 1usize;
        while base_document.len()
            + (1..=child_count).map(minimum_line_len).sum::<usize>()
            + child_count * max_extra_per_title
            < MAX_MARKDOWN_BYTES
        {
            child_count += 1;
        }
        assert!(child_count < MAX_IMPORT_SUBTREE_NODES);

        let minimum_children = (1..=child_count).map(minimum_line_len).sum::<usize>();
        let mut remaining = MAX_MARKDOWN_BYTES - base_document.len() - minimum_children;
        let mut max_document = base_document;
        for index in 1..=child_count {
            let prefix = "  - [ ] ";
            let suffix = format!(" <!-- yonalist-node-id: {} -->\n", node_id(index));
            let fill = 1 + remaining.min(max_extra_per_title);
            max_document.push_str(&prefix);
            max_document.push_str(&"a".repeat(fill));
            max_document.push_str(&suffix);
            remaining -= fill - 1;
        }
        assert_eq!(
            max_document.len(),
            MAX_MARKDOWN_BYTES,
            "document builder must reach the exact byte boundary"
        );
        assert!(parse_notes_markdown(&max_document).is_ok());
        max_document.push('x');
        assert!(parse_notes_markdown(&max_document).is_err());
    }

    #[test]
    fn canonical_parser_decodes_only_exporter_escaping_and_metadata_encoding() {
        let before = "Korean 한국어 ! [] () & < > \\n literal\\n\nactual";
        let original_name = "../folder\\line\tname\r\nnul\0.png";
        let prepared = prepare_markdown_export(
            &snapshot(
                image_node(ROOT_ID, before, "", "", false, original_name, Vec::new()),
                before,
            ),
            "assets",
        )
        .expect("canonical exporter bytes");
        let source = std::str::from_utf8(&prepared.markdown).expect("UTF-8 export");
        let roots = parse_notes_markdown(source).expect("exporter escaping round trips");
        assert_eq!(roots[0].title, before);
        assert_eq!(
            roots[0].image_offset_utf16,
            before.encode_utf16().count() as i64
        );
        assert_eq!(
            roots[0]
                .image
                .as_ref()
                .map(|image| image.original_name.as_str()),
            Some(original_name)
        );

        for (label, source) in [
            ("dangling escape", text_document("bad\\", ROOT_ID)),
            ("unknown escape", text_document("bad\\q", ROOT_ID)),
            ("raw punctuation", text_document("bad!", ROOT_ID)),
            ("unknown entity", text_document("bad &quot;", ROOT_ID)),
            (
                "invalid percent UTF-8",
                image_document(ROOT_ID, "![Image](assets/0001.png) <!-- yonalist-attachment-original-name: %FF -->"),
            ),
            (
                "noncanonical percent case",
                image_document(ROOT_ID, "![Image](assets/0001.png) <!-- yonalist-attachment-original-name: photo%2epng -->"),
            ),
            (
                "overlong original name",
                image_document(ROOT_ID, &format!("![Image](assets/0001.png) <!-- yonalist-attachment-original-name: {} -->", "a".repeat(1025))),
            ),
        ] {
            assert!(parse_notes_markdown(&source).is_err(), "accepted {label}");
        }
    }

    fn tiny_png(width: u32, height: u32) -> Vec<u8> {
        use image::{DynamicImage, ImageFormat};
        use std::io::Cursor;

        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(width, height)
            .write_to(&mut bytes, ImageFormat::Png)
            .expect("encode tiny PNG fixture");
        bytes.into_inner()
    }

    fn write_markdown_source(temp_dir: &tempfile::TempDir) -> String {
        let source = temp_dir.path().join("import.md");
        std::fs::write(&source, b"original Markdown bytes\n").expect("write Markdown source");
        source.to_string_lossy().into_owned()
    }

    #[test]
    fn markdown_assets_are_opened_beneath_one_held_parent_without_following_links() {
        use super::{
            hold_markdown_import_source, inject_markdown_asset_open_hook, prepare_markdown_assets,
        };
        use crate::notes::attachments::{acquire_attachment_import_permit, MAX_ATTACHMENT_BYTES};
        use std::fs;

        let temp_dir = tempfile::tempdir().expect("temp import directory");
        let source_path = write_markdown_source(&temp_dir);
        let assets = temp_dir.path().join("assets");
        fs::create_dir(&assets).expect("create assets directory");
        fs::write(assets.join("0001.png"), tiny_png(2, 3)).expect("write regular asset");

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            use std::process::Command;
            use std::sync::mpsc;
            use std::time::Duration;

            let source_link = temp_dir.path().join("source-link.md");
            symlink(&source_path, &source_link).expect("Markdown source symlink");
            assert!(
                hold_markdown_import_source(&source_link.to_string_lossy()).is_err(),
                "followed Markdown source symlink"
            );

            let source_fifo = temp_dir.path().join("source-fifo.md");
            assert!(
                Command::new("mkfifo")
                    .arg(&source_fifo)
                    .status()
                    .expect("run mkfifo")
                    .success(),
                "mkfifo failed"
            );
            let source_fifo_path = source_fifo.to_string_lossy().into_owned();
            let (result_tx, result_rx) = mpsc::channel();
            let worker = std::thread::spawn(move || {
                result_tx
                    .send(hold_markdown_import_source(&source_fifo_path).is_err())
                    .expect("send Markdown FIFO result");
            });
            let rejected = result_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("Markdown source FIFO hold must not block");
            worker.join().expect("Markdown FIFO worker");
            assert!(rejected, "accepted Markdown source FIFO");
        }

        let source = hold_markdown_import_source(&source_path).expect("hold Markdown source");

        let too_many_links =
            vec![
                "assets/0001.png";
                usize::try_from(MAX_NOTE_ATTACHMENTS_PER_VAULT).expect("placement cap") + 1
            ];
        let too_many_opens = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_too_many_opens = Arc::clone(&too_many_opens);
        inject_markdown_asset_open_hook(move || {
            observed_too_many_opens.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        let too_many_callbacks = std::cell::Cell::new(0);
        let permit = acquire_attachment_import_permit().expect("asset permit");
        let too_many_rejected = prepare_markdown_assets(&source, &too_many_links, permit, || {
            too_many_callbacks.set(too_many_callbacks.get() + 1)
        })
        .is_err();

        let other_assets = temp_dir.path().join("other-assets");
        fs::create_dir(&other_assets).expect("create second canonical asset directory");
        fs::write(other_assets.join("0001.png"), tiny_png(2, 3))
            .expect("write second canonical asset");
        let mixed_directory_opens = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_mixed_directory_opens = Arc::clone(&mixed_directory_opens);
        inject_markdown_asset_open_hook(move || {
            observed_mixed_directory_opens.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        let mixed_directory_callbacks = std::cell::Cell::new(0);
        let permit = acquire_attachment_import_permit().expect("asset permit");
        let mixed_directory_rejected = prepare_markdown_assets(
            &source,
            &["assets/0001.png", "other-assets/0001.png"],
            permit,
            || mixed_directory_callbacks.set(mixed_directory_callbacks.get() + 1),
        )
        .is_err();

        assert!(
            too_many_rejected,
            "accepted 513 Markdown image placements before preflight"
        );
        assert_eq!(
            too_many_opens.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "opened an asset before rejecting 513 Markdown image placements"
        );
        assert_eq!(
            too_many_callbacks.get(),
            0,
            "ran the callback before rejecting 513 Markdown image placements"
        );
        assert!(
            mixed_directory_rejected,
            "accepted Markdown assets from different directories"
        );
        assert_eq!(
            mixed_directory_opens.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "opened an asset before rejecting mixed Markdown asset directories"
        );
        assert_eq!(
            mixed_directory_callbacks.get(),
            0,
            "ran the callback before rejecting mixed Markdown asset directories"
        );

        let oversized_source = temp_dir.path().join("oversized.md");
        fs::write(&oversized_source, vec![b'x'; 16 * 1024 * 1024 + 1])
            .expect("write oversized Markdown source");
        let oversized = hold_markdown_import_source(&oversized_source.to_string_lossy())
            .expect("hold oversized Markdown source before bounded read");
        assert!(
            oversized.read_owned_bytes().is_err(),
            "accepted a Markdown source over 16 MiB"
        );

        for link in [
            "/assets/0001.png",
            "https://example.test/assets/0001.png",
            "../assets/0001.png",
            "assets\\0001.png",
            "assets%2Fescape/0001.png",
            "assets%5Cescape/0001.png",
        ] {
            let permit = acquire_attachment_import_permit().expect("asset permit");
            assert!(
                prepare_markdown_assets(&source, &[link], permit, || {}).is_err(),
                "accepted unsafe asset link {link}"
            );
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            use std::process::Command;
            use std::sync::mpsc;
            use std::time::Duration;

            let outside = tempfile::tempdir().expect("outside directory");
            fs::write(outside.path().join("0001.png"), tiny_png(2, 3))
                .expect("write outside asset");
            symlink(outside.path(), temp_dir.path().join("linked-assets"))
                .expect("asset-directory symlink");
            let permit = acquire_attachment_import_permit().expect("asset permit");
            assert!(
                prepare_markdown_assets(&source, &["linked-assets/0001.png"], permit, || {})
                    .is_err(),
                "followed asset-directory symlink"
            );

            symlink(assets.join("0001.png"), assets.join("0002.png")).expect("asset-file symlink");
            let permit = acquire_attachment_import_permit().expect("asset permit");
            assert!(
                prepare_markdown_assets(&source, &["assets/0002.png"], permit, || {}).is_err(),
                "followed asset-file symlink"
            );

            let fifo = assets.join("0003.png");
            assert!(
                Command::new("mkfifo")
                    .arg(&fifo)
                    .status()
                    .expect("run mkfifo")
                    .success(),
                "mkfifo failed"
            );
            let fifo_source_path = source_path.clone();
            let (result_tx, result_rx) = mpsc::channel();
            let worker = std::thread::spawn(move || {
                let result = hold_markdown_import_source(&fifo_source_path).and_then(|source| {
                    let permit = acquire_attachment_import_permit()?;
                    prepare_markdown_assets(&source, &["assets/0003.png"], permit, || {})
                });
                result_tx.send(result.is_err()).expect("send FIFO result");
            });
            let rejected = result_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("FIFO asset preparation must not block");
            worker.join().expect("FIFO worker");
            assert!(rejected, "accepted FIFO asset");
        }

        fs::write(
            assets.join("0004.png"),
            vec![0_u8; usize::try_from(MAX_ATTACHMENT_BYTES + 1).expect("asset test size")],
        )
        .expect("write oversized regular asset");
        let permit = acquire_attachment_import_permit().expect("asset permit");
        assert!(
            prepare_markdown_assets(&source, &["assets/0004.png"], permit, || {}).is_err(),
            "accepted asset over the 20 MiB bounded-read limit"
        );

        let permit = acquire_attachment_import_permit().expect("asset permit");
        let prepared = prepare_markdown_assets(&source, &["assets/0001.png"], permit, || {})
            .expect("prepare regular asset beneath held Markdown parent");
        assert_eq!(prepared.batch.attachments().len(), 1);
    }

    #[test]
    fn markdown_source_identity_and_capability_survive_path_replacement_without_reopen() {
        use super::{hold_markdown_import_source, prepare_markdown_assets};
        use crate::notes::attachments::acquire_attachment_import_permit;
        use std::fs;

        let temp_dir = tempfile::tempdir().expect("temp import directory");
        let selected = temp_dir.path().join("selected");
        fs::create_dir(&selected).expect("create selected source directory");
        let source_path = selected.join("import.md");
        fs::write(&source_path, b"original Markdown bytes\n").expect("write Markdown source");
        let assets = selected.join("assets");
        fs::create_dir(&assets).expect("create selected assets directory");
        let original_asset = tiny_png(2, 3);
        fs::write(assets.join("0001.png"), &original_asset).expect("write original asset");
        let held = hold_markdown_import_source(&source_path.to_string_lossy())
            .expect("hold Markdown source");

        let held_parent_path = temp_dir.path().join("selected-held");
        fs::rename(&selected, &held_parent_path).expect("rename held Markdown parent directory");
        fs::create_dir(&selected).expect("recreate attacker-selected directory");
        fs::write(selected.join("import.md"), b"attacker Markdown bytes\n")
            .expect("write attacker Markdown source");
        fs::create_dir(selected.join("assets")).expect("create attacker asset directory");
        fs::write(selected.join("assets/0001.png"), tiny_png(7, 5)).expect("write attacker asset");

        assert_eq!(
            held.read_owned_bytes().expect("read held Markdown handle"),
            b"original Markdown bytes\n"
        );
        let permit = acquire_attachment_import_permit().expect("asset permit");
        let prepared = prepare_markdown_assets(&held, &["assets/0001.png"], permit, || {})
            .expect("prepare asset through renamed held parent capability");
        let attachment = &prepared.batch.attachments()[0];
        assert_eq!(attachment.bytes(), original_asset);
        assert_eq!((attachment.image.width, attachment.image.height), (2, 3));
        assert!(
            held.revalidate_source_entry().is_ok(),
            "ambient source-parent replacement changed the held source entry"
        );

        let held_source_path = held_parent_path.join("import.md");
        let moved_source_path = held_parent_path.join("import-original.md");
        fs::rename(&held_source_path, &moved_source_path).expect("rename held source entry");
        fs::write(
            &held_source_path,
            b"attacker replacement inside held parent\n",
        )
        .expect("replace held source entry");
        assert!(
            held.revalidate_source_entry().is_err(),
            "replaced Markdown entry inside the held parent passed revalidation"
        );
    }

    #[test]
    fn markdown_asset_bytes_are_owned_before_path_swap() {
        use super::{hold_markdown_import_source, prepare_markdown_assets};
        use crate::notes::attachments::acquire_attachment_import_permit;
        use std::fs;

        let temp_dir = tempfile::tempdir().expect("temp import directory");
        let source_path = write_markdown_source(&temp_dir);
        let assets = temp_dir.path().join("assets");
        fs::create_dir(&assets).expect("create assets directory");
        let original = tiny_png(2, 3);
        let asset_path = assets.join("0001.png");
        fs::write(&asset_path, &original).expect("write original asset");
        let source = hold_markdown_import_source(&source_path).expect("hold Markdown source");
        let permit = acquire_attachment_import_permit().expect("asset permit");
        let callbacks = std::cell::Cell::new(0);
        let prepared = prepare_markdown_assets(&source, &["assets/0001.png"], permit, || {
            callbacks.set(callbacks.get() + 1);
            let renamed = assets.join("0001-original.png");
            fs::rename(&asset_path, &renamed).expect("rename prepared asset entry");
            fs::write(&asset_path, tiny_png(7, 5)).expect("replace prepared asset entry");
        })
        .expect("prepare asset bytes before callback-time path swap");

        assert_eq!(callbacks.get(), 1, "success callback must run exactly once");
        let attachment = &prepared.batch.attachments()[0];
        assert_eq!(attachment.bytes(), original);
        assert_eq!(attachment.image.mime_type, "image/png");
        assert_eq!((attachment.image.width, attachment.image.height), (2, 3));
    }

    #[test]
    fn markdown_asset_preparation_rejects_one_bad_asset_before_any_publish_hook() {
        use super::{hold_markdown_import_source, prepare_markdown_assets};
        use crate::notes::attachments::acquire_attachment_import_permit;
        use std::cell::Cell;
        use std::fs;

        let temp_dir = tempfile::tempdir().expect("temp import directory");
        let source_path = write_markdown_source(&temp_dir);
        let assets = temp_dir.path().join("assets");
        fs::create_dir(&assets).expect("create assets directory");
        fs::write(assets.join("0001.png"), tiny_png(2, 3)).expect("write valid first asset");
        fs::write(assets.join("0002.png"), b"not an image").expect("write corrupt second asset");
        fs::write(assets.join("0003.jpg"), tiny_png(2, 3))
            .expect("write PNG bytes under canonical JPG name");
        let source = hold_markdown_import_source(&source_path).expect("hold Markdown source");

        for (label, later_asset) in [
            ("missing", "assets/0099.png"),
            ("corrupt", "assets/0002.png"),
            ("extension/MIME mismatch", "assets/0003.jpg"),
        ] {
            let permit = acquire_attachment_import_permit().expect("asset permit");
            let published = Cell::new(0);
            assert!(
                prepare_markdown_assets(&source, &["assets/0001.png", later_asset], permit, || {
                    published.set(published.get() + 1)
                },)
                .is_err(),
                "accepted {label} later asset"
            );
            assert_eq!(
                published.get(),
                0,
                "asset publication hook ran before every asset was validated for {label} asset"
            );
        }
    }

    #[test]
    fn repeated_markdown_link_is_read_once_and_payload_candidates_are_unique() {
        use super::{
            hold_markdown_import_source, inject_markdown_asset_open_hook, prepare_markdown_assets,
        };
        use crate::notes::attachments::acquire_attachment_import_permit;
        use std::fs;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let temp_dir = tempfile::tempdir().expect("temp import directory");
        let source_path = write_markdown_source(&temp_dir);
        let assets = temp_dir.path().join("assets");
        fs::create_dir(&assets).expect("create assets directory");
        let bytes = tiny_png(2, 3);
        fs::write(assets.join("0001.png"), &bytes).expect("write first asset");
        fs::write(assets.join("0002.png"), &bytes).expect("write same-payload second asset");
        let source = hold_markdown_import_source(&source_path).expect("hold Markdown source");
        let opened = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&opened);
        inject_markdown_asset_open_hook(move || {
            observed.fetch_add(1, Ordering::SeqCst);
        });
        let permit = acquire_attachment_import_permit().expect("asset permit");
        let prepared = prepare_markdown_assets(
            &source,
            &["assets/0001.png", "assets/0001.png", "assets/0002.png"],
            permit,
            || {},
        )
        .expect("prepare repeated and equal-payload links");

        assert_eq!(opened.load(Ordering::SeqCst), 2, "repeated link was reread");
        assert_eq!(prepared.batch.attachments().len(), 2);
        assert_eq!(prepared.prepared_by_link.len(), 2);
        assert_eq!(prepared.unique_publication_indices.len(), 1);
    }
}
