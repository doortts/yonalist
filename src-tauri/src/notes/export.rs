use super::types::{
    validate_note_id, ExportDateSpan, ExportNode, NoteNodeKind, NotesExportSnapshot,
    MAX_NOTES_EXPORT_ATTACHMENTS,
};
use crate::notes::date_index::LocalDate;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
#[cfg(not(windows))]
use cap_std::fs::DirBuilder;
#[cfg(unix)]
use cap_std::fs::DirBuilderExt as CapDirBuilderExt;
use cap_std::fs::{Dir, File as CapFile, OpenOptions as CapOpenOptions};
use image::codecs::{gif::GifDecoder, webp::WebPDecoder};
use image::{AnimationDecoder, RgbaImage};
use printpdf::{
    Color, DictItem, FontId, Greyscale, Mm, Op, ParsedFont, PdfDocument, PdfFontHandle, PdfPage,
    PdfParseErrorSeverity, PdfSaveOptions, Point, Pt, RawImage, RawImageData, RawImageFormat,
    TextItem, XObject, XObjectId, XObjectTransform,
};
use rusqlite::Connection;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt::Write;
use std::fs;
use std::io::Write as IoWrite;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

const PDF_FONT_BYTES: &[u8] = include_bytes!("../../resources/NanumGothic-Regular.ttf");
const PDF_PAGE_WIDTH_MM: f32 = 210.0;
const PDF_PAGE_HEIGHT_MM: f32 = 297.0;
const PDF_MARGIN_X_MM: f32 = 18.0;
const PDF_MARGIN_TOP_MM: f32 = 20.0;
const PDF_MARGIN_BOTTOM_MM: f32 = 18.0;
const PDF_FOOTER_RESERVE_MM: f32 = 10.0;
const PDF_TITLE_SIZE: f32 = 20.0;
const PDF_TITLE_LINE_HEIGHT: f32 = 26.0;
const PDF_TITLE_GAP: f32 = 14.0;
const PDF_ROW_SIZE: f32 = 10.8;
const PDF_ROW_LINE_HEIGHT: f32 = 15.0;
const PDF_NOTE_SIZE: f32 = 9.0;
const PDF_NOTE_LINE_HEIGHT: f32 = 12.5;
const PDF_ROW_GAP: f32 = 5.0;
const PDF_DEPTH_INDENT: f32 = 14.0;
const PDF_NOTE_INDENT: f32 = 12.0;
const PDF_MIN_TEXT_WIDTH: f32 = 72.0;
const PDF_FOOTER_SIZE: f32 = 8.5;
const PDF_IMAGE_CAPTION_SIZE: f32 = 8.5;
const PDF_IMAGE_CAPTION_LINE_HEIGHT: f32 = 11.0;
const PDF_IMAGE_CAPTION_GAP: f32 = 5.0;
const PDF_CSS_PIXEL_POINTS: f32 = 72.0 / 96.0;
const MAX_EXPORT_ENCODED_BYTES: u64 = 40 * 1024 * 1024;
const MAX_EXPORT_DECODED_PIXELS: u64 = 40_000_000;
const MAX_PDF_ATTACHMENT_WORKING_BYTES: u64 = 256 * 1024 * 1024;
const PDF_DECODER_BYTES_PER_PIXEL: u64 = 16;
const PDF_RETAINED_RGBA_BYTES_PER_PIXEL: u64 = 4;
const PDF_DOCUMENT_VERSION: &str = "1.5";
static EXPORT_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// File written inside every Markdown export assets directory so that a later
/// overwrite can tell one of our own asset directories apart from an unrelated
/// user folder that merely happens to share the derived `{stem}_assets` name.
pub(crate) const EXPORT_ASSET_MARKER_NAME: &str = ".yonalist-notes-export.json";
pub(crate) const EXPORT_ASSET_MARKER_CREATED_BY: &str = "yonalist-notes-export";
const EXPORT_ASSET_MARKER_VERSION: u32 = 1;
/// Overwrite-refusal message for an assets folder not created by a previous
/// export. The Notes IPC boundary maps this exact text to
/// [`crate::notes::error::NotesErrorCode::ForeignExportAssetDir`], a code
/// distinct from `DestinationExists`, so the frontend never mistakes it for an
/// overwrite conflict (see `src/domain/notesExport.ts`).
pub(crate) const FOREIGN_EXPORT_ASSET_DIR_MESSAGE: &str = "Export assets folder already exists and was not created by a previous export. Move or rename it and retry.";
pub(crate) const EXPORT_DESTINATION_IN_VAULT_METADATA_MESSAGE: &str =
    "Notes exports must be saved outside the vault metadata directory.";

fn canonical_existing_export_ancestor(path: &Path) -> Result<PathBuf, String> {
    let mut candidate = path;
    loop {
        match fs::canonicalize(candidate) {
            Ok(canonical) => return Ok(canonical),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                candidate = candidate.parent().ok_or_else(|| {
                    format!("Could not resolve the Notes export destination: {error}")
                })?;
            }
            Err(error) => {
                return Err(format!(
                    "Could not resolve the Notes export destination: {error}"
                ))
            }
        }
    }
}

pub(crate) fn preflight_export_destinations_outside_vault_metadata(
    vault_path: &str,
    destinations: &[&Path],
) -> Result<(), String> {
    let metadata = match fs::canonicalize(crate::metadata_dir(vault_path)) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Could not resolve the Notes metadata directory: {error}"
            ))
        }
    };
    for destination in destinations {
        let resolved = canonical_existing_export_ancestor(destination)?;
        if resolved.starts_with(&metadata) {
            return Err(EXPORT_DESTINATION_IN_VAULT_METADATA_MESSAGE.to_string());
        }
    }
    Ok(())
}

pub(crate) struct NotesExportDestinationGuard {
    app_lock: crate::notes::connection::VaultAppLockGuard,
    metadata_path: PathBuf,
    metadata_canonical: PathBuf,
    metadata: HeldExportDirectory,
    parent_path: PathBuf,
    parent_canonical: PathBuf,
    parent: HeldExportDirectory,
    destinations: Vec<PathBuf>,
}

impl NotesExportDestinationGuard {
    pub(crate) fn acquire(vault_path: &str, destinations: &[&Path]) -> Result<Self, String> {
        let app_lock = crate::notes::connection::try_acquire_existing_vault_app_lock(vault_path)?
            .ok_or_else(|| "The Notes metadata directory does not exist.".to_string())?;
        preflight_export_destinations_outside_vault_metadata(vault_path, destinations)?;
        let destination = destinations
            .first()
            .ok_or_else(|| "Notes export destination guard requires a destination.".to_string())?;
        let parent_path = destination
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf();
        if destinations.iter().any(|path| {
            path.parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."))
                != parent_path
        }) {
            return Err("Notes export destinations must share one parent directory.".to_string());
        }

        fs::create_dir_all(&parent_path)
            .map_err(|error| format!("Could not prepare the Notes export directory: {error}"))?;
        let metadata_path = crate::metadata_dir(vault_path);
        let metadata = HeldExportDirectory::from_directory(app_lock.try_clone_metadata()?)?;
        let parent = HeldExportDirectory::open_nofollow(
            &parent_path,
            "Notes export parent identity changed while export access was acquired",
        )?;
        let guard = Self {
            app_lock,
            metadata_canonical: fs::canonicalize(&metadata_path).map_err(|error| {
                format!("Could not resolve the Notes metadata directory: {error}")
            })?,
            parent_canonical: fs::canonicalize(&parent_path).map_err(|error| {
                format!("Could not resolve the Notes export parent directory: {error}")
            })?,
            metadata_path,
            metadata,
            parent_path,
            parent,
            destinations: destinations
                .iter()
                .map(|path| (*path).to_path_buf())
                .collect(),
        };
        guard.revalidate()?;
        Ok(guard)
    }

    pub(crate) fn revalidate(&self) -> Result<(), String> {
        self.app_lock.revalidate_metadata_path()?;
        self.metadata.verify_held(
            "Notes vault metadata directory identity changed before export publication",
        )?;
        self.parent.verify_at(
            &self.parent_path,
            "Notes export parent identity changed before publication",
        )?;
        let metadata_canonical = fs::canonicalize(&self.metadata_path).map_err(|error| {
            format!("Notes vault metadata directory identity changed before export publication: {error}")
        })?;
        let parent_canonical = fs::canonicalize(&self.parent_path).map_err(|error| {
            format!("Notes export parent identity changed before publication: {error}")
        })?;
        if metadata_canonical != self.metadata_canonical {
            return Err(
                "Notes vault metadata directory identity changed before export publication."
                    .to_string(),
            );
        }
        if parent_canonical != self.parent_canonical {
            return Err("Notes export parent identity changed before publication.".to_string());
        }
        if self.metadata.identity == self.parent.identity {
            return Err(EXPORT_DESTINATION_IN_VAULT_METADATA_MESSAGE.to_string());
        }
        for destination in &self.destinations {
            let resolved = canonical_existing_export_ancestor(destination)?;
            if resolved.starts_with(&metadata_canonical) {
                return Err(EXPORT_DESTINATION_IN_VAULT_METADATA_MESSAGE.to_string());
            }
        }
        self.app_lock.revalidate_metadata_path()?;
        Ok(())
    }

    fn destination_name<'a>(&self, destination: &'a Path) -> Result<&'a Path, String> {
        if !self.destinations.iter().any(|held| held == destination) {
            return Err("The Notes export destination was not held by this guard.".to_string());
        }
        destination
            .file_name()
            .map(Path::new)
            .ok_or_else(|| "File path must name a file.".to_string())
    }

    pub(crate) fn write_atomic_file(
        &self,
        destination: &Path,
        bytes: &[u8],
        overwrite: bool,
        after_final_revalidation: impl FnOnce(),
    ) -> Result<(), String> {
        let name = self.destination_name(destination)?;
        crate::file_io::write_atomic_file_in_guarded_parent(
            &self.parent.directory,
            name,
            bytes,
            overwrite,
            || self.revalidate(),
            after_final_revalidation,
        )
    }
}

pub(crate) fn load_export_snapshot(
    connection: &Connection,
    root_node_id: &str,
) -> Result<NotesExportSnapshot, String> {
    super::repository::load_export_snapshot(connection, root_node_id)
}

fn normalize_newlines(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
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

fn escape_inline(value: &str) -> String {
    normalize_newlines(value)
        .split('\n')
        .map(escape_markdown)
        .collect::<Vec<_>>()
        .join(r"\n")
}

fn validate_export_node_ids(node: &ExportNode) -> Result<(), String> {
    validate_note_id(&node.id)?;
    for attachment in &node.attachments {
        validate_note_id(&attachment.id)
            .map_err(|_| "A Notes export attachment ID is invalid.".to_string())?;
        if attachment.bytes.is_none() {
            return Err("Notes export attachment bytes were not validated.".to_string());
        }
    }
    for child in &node.children {
        validate_export_node_ids(child)?;
    }
    Ok(())
}

pub(crate) fn hydrate_export_attachments(
    snapshot: &mut NotesExportSnapshot,
    read: impl FnMut(&super::types::ExportAttachment) -> Result<Vec<u8>, String>,
) -> Result<(), String> {
    hydrate_export_attachments_with_budget(
        snapshot,
        ExportAttachmentBudget {
            max_attachments: MAX_NOTES_EXPORT_ATTACHMENTS,
            max_encoded_bytes: MAX_EXPORT_ENCODED_BYTES,
            max_decoded_pixels: MAX_EXPORT_DECODED_PIXELS,
        },
        read,
    )
}

#[derive(Clone, Copy)]
pub(crate) struct ExportAttachmentBudget {
    max_attachments: usize,
    max_encoded_bytes: u64,
    max_decoded_pixels: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ExportPayloadKey {
    relative_path: String,
    content_hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ExportPayloadMetadata {
    mime_type: String,
    byte_size: u64,
    intrinsic_width: u64,
    intrinsic_height: u64,
}

fn validate_pdf_attachment_working_budget(
    snapshot: &NotesExportSnapshot,
    max_working_bytes: u64,
) -> Result<u64, String> {
    fn inspect(
        node: &ExportNode,
        seen: &mut HashMap<ExportPayloadKey, ()>,
        working_bytes: &mut u64,
        max_working_bytes: u64,
    ) -> Result<(), String> {
        for attachment in &node.attachments {
            let key = ExportPayloadKey {
                relative_path: attachment.relative_path.clone(),
                content_hash: attachment.content_hash.clone(),
            };
            if seen.insert(key, ()).is_some() {
                continue;
            }
            let byte_size = u64::try_from(attachment.byte_size)
                .map_err(|_| "A Notes PDF attachment has an invalid byte size.".to_string())?;
            let width = u64::try_from(attachment.intrinsic_width)
                .map_err(|_| "A Notes PDF attachment has an invalid width.".to_string())?;
            let height = u64::try_from(attachment.intrinsic_height)
                .map_err(|_| "A Notes PDF attachment has an invalid height.".to_string())?;
            let pixels = width
                .checked_mul(height)
                .ok_or_else(|| "A Notes PDF attachment pixel count is too large.".to_string())?;
            let decoded_bytes = pixels
                .checked_mul(PDF_DECODER_BYTES_PER_PIXEL + PDF_RETAINED_RGBA_BYTES_PER_PIXEL)
                .ok_or_else(|| {
                    "The Notes PDF attachment working-memory total is too large.".to_string()
                })?;
            *working_bytes = working_bytes
                .checked_add(byte_size)
                .and_then(|total| total.checked_add(decoded_bytes))
                .ok_or_else(|| {
                    "The Notes PDF attachment working-memory total is too large.".to_string()
                })?;
            if *working_bytes > max_working_bytes {
                return Err(format!(
                    "Notes PDF attachments exceed the {max_working_bytes} byte aggregate working-memory budget."
                ));
            }
        }
        for child in &node.children {
            inspect(child, seen, working_bytes, max_working_bytes)?;
        }
        Ok(())
    }

    let mut seen = HashMap::new();
    let mut working_bytes = 0;
    inspect(
        &snapshot.root,
        &mut seen,
        &mut working_bytes,
        max_working_bytes,
    )?;
    Ok(working_bytes)
}

pub(crate) fn hydrate_export_attachments_with_budget(
    snapshot: &mut NotesExportSnapshot,
    budget: ExportAttachmentBudget,
    mut read: impl FnMut(&super::types::ExportAttachment) -> Result<Vec<u8>, String>,
) -> Result<(), String> {
    snapshot.root.validate_attachment_ownership()?;

    fn inspect(
        node: &ExportNode,
        budget: ExportAttachmentBudget,
        attachment_count: &mut usize,
        encoded_bytes: &mut u64,
        decoded_pixels: &mut u64,
        unique: &mut HashMap<ExportPayloadKey, ExportPayloadMetadata>,
        representatives: &mut Vec<super::types::ExportAttachment>,
    ) -> Result<(), String> {
        for attachment in &node.attachments {
            *attachment_count = attachment_count
                .checked_add(1)
                .ok_or_else(|| "The Notes export attachment count is too large.".to_string())?;
            if *attachment_count > budget.max_attachments {
                return Err(format!(
                    "Notes export must contain at most {} image attachments.",
                    budget.max_attachments
                ));
            }
            let byte_size = u64::try_from(attachment.byte_size)
                .map_err(|_| "A Notes export attachment has an invalid byte size.".to_string())?;
            let intrinsic_width = u64::try_from(attachment.intrinsic_width).map_err(|_| {
                "A Notes export attachment has an invalid intrinsic width.".to_string()
            })?;
            let intrinsic_height = u64::try_from(attachment.intrinsic_height).map_err(|_| {
                "A Notes export attachment has an invalid intrinsic height.".to_string()
            })?;
            let pixels = intrinsic_width
                .checked_mul(intrinsic_height)
                .ok_or_else(|| "A Notes export attachment pixel count is too large.".to_string())?;
            if byte_size == 0 || pixels == 0 {
                return Err("A Notes export attachment must have positive size.".to_string());
            }
            let key = ExportPayloadKey {
                relative_path: attachment.relative_path.clone(),
                content_hash: attachment.content_hash.clone(),
            };
            let metadata = ExportPayloadMetadata {
                mime_type: attachment.mime_type.clone(),
                byte_size,
                intrinsic_width,
                intrinsic_height,
            };
            if let Some(existing) = unique.get(&key) {
                if existing != &metadata {
                    return Err(
                        "Notes export attachments for one owned payload have conflicting metadata."
                            .to_string(),
                    );
                }
                continue;
            }
            *encoded_bytes = encoded_bytes
                .checked_add(byte_size)
                .ok_or_else(|| "The Notes export encoded-byte total is too large.".to_string())?;
            if *encoded_bytes > budget.max_encoded_bytes {
                return Err(format!(
                    "Notes export attachments exceed the {} byte aggregate encoded-byte budget.",
                    budget.max_encoded_bytes
                ));
            }
            *decoded_pixels = decoded_pixels
                .checked_add(pixels)
                .ok_or_else(|| "The Notes export decoded-pixel total is too large.".to_string())?;
            if *decoded_pixels > budget.max_decoded_pixels {
                return Err(format!(
                    "Notes export attachments exceed the {} decoded-pixel aggregate budget.",
                    budget.max_decoded_pixels
                ));
            }
            unique.insert(key, metadata);
            representatives.push(attachment.clone());
        }
        for child in &node.children {
            inspect(
                child,
                budget,
                attachment_count,
                encoded_bytes,
                decoded_pixels,
                unique,
                representatives,
            )?;
        }
        Ok(())
    }

    fn assign(
        node: &mut ExportNode,
        prepared: &HashMap<ExportPayloadKey, Arc<[u8]>>,
    ) -> Result<(), String> {
        for attachment in &mut node.attachments {
            let key = ExportPayloadKey {
                relative_path: attachment.relative_path.clone(),
                content_hash: attachment.content_hash.clone(),
            };
            attachment.bytes = Some(prepared.get(&key).cloned().ok_or_else(|| {
                "Prepared Notes export attachment bytes are incomplete.".to_string()
            })?);
        }
        for child in &mut node.children {
            assign(child, prepared)?;
        }
        Ok(())
    }

    let mut attachment_count = 0;
    let mut encoded_bytes = 0;
    let mut decoded_pixels = 0;
    let mut unique = HashMap::new();
    let mut representatives = Vec::new();
    inspect(
        &snapshot.root,
        budget,
        &mut attachment_count,
        &mut encoded_bytes,
        &mut decoded_pixels,
        &mut unique,
        &mut representatives,
    )?;

    let mut prepared = HashMap::with_capacity(representatives.len());
    for attachment in representatives {
        let key = ExportPayloadKey {
            relative_path: attachment.relative_path.clone(),
            content_hash: attachment.content_hash.clone(),
        };
        let expected_size = usize::try_from(attachment.byte_size)
            .map_err(|_| "A Notes export attachment byte size is too large.".to_string())?;
        let bytes = read(&attachment)?;
        if bytes.len() != expected_size {
            return Err(
                "A Notes export attachment read returned an unexpected byte size.".to_string(),
            );
        }
        prepared.insert(key, Arc::<[u8]>::from(bytes));
    }
    assign(&mut snapshot.root, &prepared)
}

fn render_node(
    markdown: &mut String,
    node: &super::types::ExportNode,
    depth: usize,
) -> Result<(), String> {
    if node.node_kind == NoteNodeKind::Image {
        return Err("Markdown image nodes require an export asset directory.".to_string());
    }
    let indentation = "  ".repeat(depth);
    let completion = if node.completed { 'x' } else { ' ' };
    writeln!(
        markdown,
        "{indentation}- [{completion}] {} <!-- yonalist-node-id: {} -->",
        escape_inline(&node.title),
        node.id
    )
    .expect("writing to a String cannot fail");

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

fn normalize_attachment_presentation(value: &str) -> String {
    normalize_newlines(value)
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect()
}

fn escape_markdown_alt(value: &str) -> String {
    normalize_attachment_presentation(value)
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

fn markdown_asset_extension(mime_type: &str) -> Result<&'static str, String> {
    match mime_type {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/webp" => Ok("webp"),
        "image/gif" => Ok("gif"),
        _ => Err("A Notes export attachment MIME type is unsupported.".to_string()),
    }
}

fn percent_encode_unreserved(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(*byte));
        } else {
            write!(encoded, "%{byte:02X}").expect("writing to a String cannot fail");
        }
    }
    encoded
}

fn percent_encode_markdown_comment_metadata(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~') {
            encoded.push(char::from(*byte));
        } else {
            write!(encoded, "%{byte:02X}").expect("writing to a String cannot fail");
        }
    }
    encoded
}

fn markdown_attachment_link(
    attachment: &super::types::ExportAttachment,
    asset_directory_name: &str,
    ordinal: &mut usize,
    asset_links: &mut HashMap<ExportPayloadKey, String>,
    assets: &mut Vec<MarkdownExportAsset>,
) -> Result<String, String> {
    let payload_key = ExportPayloadKey {
        relative_path: attachment.relative_path.clone(),
        content_hash: attachment.content_hash.clone(),
    };
    let file_name = if let Some(file_name) = asset_links.get(&payload_key) {
        file_name.clone()
    } else {
        *ordinal = ordinal
            .checked_add(1)
            .ok_or_else(|| "The Notes export attachment count is too large.".to_string())?;
        let file_name = format!(
            "{:04}.{}",
            *ordinal,
            markdown_asset_extension(&attachment.mime_type)?
        );
        assets.push(MarkdownExportAsset {
            file_name: file_name.clone(),
            bytes: attachment
                .bytes
                .clone()
                .ok_or_else(|| "Notes export attachment bytes were not validated.".to_string())?,
        });
        asset_links.insert(payload_key, file_name.clone());
        file_name
    };
    Ok(format!(
        "{}/{}",
        percent_encode_unreserved(asset_directory_name),
        file_name
    ))
}

fn render_node_with_assets(
    markdown: &mut String,
    node: &ExportNode,
    depth: usize,
    asset_directory_name: &str,
    ordinal: &mut usize,
    asset_links: &mut HashMap<ExportPayloadKey, String>,
    assets: &mut Vec<MarkdownExportAsset>,
) -> Result<(), String> {
    let indentation = "  ".repeat(depth);
    let completion = if node.completed { 'x' } else { ' ' };
    match node.node_kind {
        NoteNodeKind::Text => {
            writeln!(
                markdown,
                "{indentation}- [{completion}] {} <!-- yonalist-node-id: {} -->",
                escape_inline(&node.title),
                node.id
            )
            .expect("writing to a String cannot fail");
        }
        NoteNodeKind::Image => {
            let attachment = node
                .attachments
                .first()
                .expect("validated image node has one attachment");
            let link = markdown_attachment_link(
                attachment,
                asset_directory_name,
                ordinal,
                asset_links,
                assets,
            )?;
            let original_name = percent_encode_markdown_comment_metadata(&attachment.original_name);
            writeln!(
                markdown,
                "{indentation}- [{completion}] ![Image]({link}) <!-- yonalist-attachment-original-name: {original_name} --> <!-- yonalist-node-id: {} -->",
                node.id
            )
            .expect("writing to a String cannot fail");
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

    if node.node_kind == NoteNodeKind::Text {
        let attachment_indentation = "  ".repeat(depth + 1);
        for attachment in &node.attachments {
            let link = markdown_attachment_link(
                attachment,
                asset_directory_name,
                ordinal,
                asset_links,
                assets,
            )?;
            writeln!(
                markdown,
                "{attachment_indentation}![{}]({link})",
                escape_markdown_alt(&attachment.original_name)
            )
            .expect("writing to a String cannot fail");
        }
    }

    for child in &node.children {
        render_node_with_assets(
            markdown,
            child,
            depth + 1,
            asset_directory_name,
            ordinal,
            asset_links,
            assets,
        )?;
    }
    Ok(())
}

fn render_markdown_frontmatter(snapshot: &NotesExportSnapshot) -> String {
    let mut markdown = String::new();
    writeln!(markdown, "---").expect("writing to a String cannot fail");
    writeln!(markdown, "kind: yonalist-notes-export").expect("writing to a String cannot fail");
    writeln!(markdown, "format_version: 1").expect("writing to a String cannot fail");
    writeln!(markdown, "source: notes.sqlite").expect("writing to a String cannot fail");
    writeln!(markdown, "root_node_id: \"{}\"", snapshot.root_node_id)
        .expect("writing to a String cannot fail");
    writeln!(markdown, "exported_at: \"{}\"", snapshot.exported_at)
        .expect("writing to a String cannot fail");
    writeln!(markdown, "---\n").expect("writing to a String cannot fail");
    if snapshot.root.node_kind == NoteNodeKind::Text {
        writeln!(markdown, "# {}\n", escape_inline(&snapshot.title))
            .expect("writing to a String cannot fail");
    }
    markdown
}

pub(crate) fn render_markdown(snapshot: &NotesExportSnapshot) -> Result<Vec<u8>, String> {
    validate_note_id(&snapshot.root_node_id)?;
    snapshot.root.validate_attachment_ownership()?;
    validate_export_node_ids(&snapshot.root)?;

    let mut markdown = render_markdown_frontmatter(snapshot);
    render_node(&mut markdown, &snapshot.root, 0)?;
    Ok(markdown.into_bytes())
}

pub(crate) struct MarkdownExportAsset {
    file_name: String,
    bytes: Arc<[u8]>,
}

pub(crate) struct PreparedMarkdownExport {
    pub(crate) markdown: Vec<u8>,
    assets: Vec<MarkdownExportAsset>,
}

pub(crate) fn prepare_markdown_export(
    snapshot: &NotesExportSnapshot,
    asset_directory_name: &str,
) -> Result<PreparedMarkdownExport, String> {
    validate_note_id(&snapshot.root_node_id)?;
    snapshot.root.validate_attachment_ownership()?;
    validate_export_node_ids(&snapshot.root)?;
    let components = Path::new(asset_directory_name)
        .components()
        .collect::<Vec<_>>();
    if components.len() != 1
        || !matches!(components[0], Component::Normal(_))
        || asset_directory_name.contains(['/', '\\'])
        || asset_directory_name.chars().any(char::is_control)
    {
        return Err("The Notes export asset directory name is unsafe.".to_string());
    }

    let mut markdown = render_markdown_frontmatter(snapshot);
    let mut ordinal = 0;
    let mut asset_links = HashMap::new();
    let mut assets = Vec::new();
    render_node_with_assets(
        &mut markdown,
        &snapshot.root,
        0,
        asset_directory_name,
        &mut ordinal,
        &mut asset_links,
        &mut assets,
    )?;
    Ok(PreparedMarkdownExport {
        markdown: markdown.into_bytes(),
        assets,
    })
}

pub(crate) fn markdown_asset_destination(destination: &Path) -> Result<(PathBuf, String), String> {
    let stem = destination
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Markdown export path must have a UTF-8 file stem.".to_string())?;
    let name = format!("{stem}_assets");
    Ok((destination.with_file_name(&name), name))
}

pub(crate) fn preflight_markdown_asset_destination(
    asset_destination: &Path,
    overwrite: bool,
) -> Result<(), String> {
    match fs::symlink_metadata(asset_destination) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("Notes export asset directory must not be a symlink.".to_string())
        }
        Ok(_) if !overwrite => Err(crate::file_io::DESTINATION_EXISTS_MESSAGE.to_string()),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ExportDirectoryIdentity {
    volume: u64,
    file: u64,
}

#[cfg(windows)]
fn windows_export_directory_share_mode() -> u32 {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
}

#[cfg(all(test, not(windows)))]
fn windows_export_directory_share_mode() -> u32 {
    // FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE.
    0x1 | 0x2 | 0x4
}

#[cfg(windows)]
fn windows_open_export_handle(path: &Path, directory: bool) -> std::io::Result<fs::File> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, DELETE,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_READ_DATA,
        OPEN_EXISTING,
    };

    let path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let desired_access = DELETE
        | FILE_READ_ATTRIBUTES
        | if directory {
            FILE_LIST_DIRECTORY
        } else {
            FILE_READ_DATA
        };
    let flags = FILE_FLAG_OPEN_REPARSE_POINT
        | if directory {
            FILE_FLAG_BACKUP_SEMANTICS
        } else {
            0
        };
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            desired_access,
            windows_export_directory_share_mode(),
            std::ptr::null(),
            OPEN_EXISTING,
            flags,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    let file = unsafe { fs::File::from_raw_handle(handle) };
    let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let attributes = information.dwFileAttributes;
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Notes export held paths must not be reparse points.",
        ));
    }
    if (attributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Notes export held path has the wrong file type.",
        ));
    }
    Ok(file)
}

#[cfg(windows)]
fn windows_delete_export_handle(
    handle: windows_sys::Win32::Foundation::HANDLE,
) -> std::io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
    };

    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    let deleted = unsafe {
        SetFileInformationByHandle(
            handle,
            FileDispositionInfo,
            std::ptr::addr_of!(disposition).cast(),
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if deleted == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn open_export_directory_nofollow(path: &Path) -> std::io::Result<Dir> {
    windows_open_export_handle(path, true).map(Dir::from_std_file)
}

#[cfg(not(windows))]
fn open_export_directory_nofollow(path: &Path) -> std::io::Result<Dir> {
    let parent_path = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = path.file_name().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Notes export directory must have a final path component.",
        )
    })?;
    Dir::open_ambient_dir(parent_path, ambient_authority())?.open_dir_nofollow(name)
}

#[cfg(windows)]
fn open_export_directory_from(parent: &Dir, path: &Path) -> std::io::Result<Dir> {
    use windows_sys::Win32::Storage::FileSystem::FILE_LIST_DIRECTORY;

    crate::file_io::open_for_delete_nofollow(parent, path, FILE_LIST_DIRECTORY)
        .map(|directory| Dir::from_std_file(directory.into_std()))
}

#[cfg(not(windows))]
fn open_export_directory_from(parent: &Dir, path: &Path) -> std::io::Result<Dir> {
    parent.open_dir_nofollow(path)
}

#[cfg(windows)]
fn open_export_file_from(parent: &Dir, path: &Path) -> std::io::Result<CapFile> {
    use windows_sys::Win32::Storage::FileSystem::FILE_READ_DATA;

    crate::file_io::open_for_delete_nofollow(parent, path, FILE_READ_DATA)
}

#[cfg(not(windows))]
fn open_export_file_from(parent: &Dir, path: &Path) -> std::io::Result<CapFile> {
    let mut options = CapOpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    parent.open_with(path, &options)
}

#[cfg(unix)]
fn export_directory_identity(path: &Path) -> Result<ExportDirectoryIdentity, String> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    Ok(ExportDirectoryIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

#[cfg(windows)]
fn export_directory_identity(path: &Path) -> Result<ExportDirectoryIdentity, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    let inspected = unsafe { GetFileInformationByHandle(handle, &mut information) };
    let inspect_error = if inspected == 0 {
        Some(std::io::Error::last_os_error())
    } else {
        None
    };
    unsafe {
        CloseHandle(handle);
    }
    if let Some(error) = inspect_error {
        return Err(error.to_string());
    }
    Ok(ExportDirectoryIdentity {
        volume: u64::from(information.dwVolumeSerialNumber),
        file: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    })
}

#[cfg(not(any(unix, windows)))]
fn export_directory_identity(_path: &Path) -> Result<ExportDirectoryIdentity, String> {
    Err("Notes export rollback identity checks are unsupported on this platform.".to_string())
}

fn publish_path_noreplace_in(
    source_parent: &Dir,
    source: &Path,
    destination_parent: &Dir,
    destination: &Path,
) -> Result<(), String> {
    match crate::file_io::rename_noreplace(source_parent, source, destination_parent, destination) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(crate::file_io::DESTINATION_EXISTS_MESSAGE.to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn unique_export_capability_name(parent: &Dir, prefix: &str) -> Result<String, String> {
    for _ in 0..128 {
        let sequence = EXPORT_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let name = format!("{prefix}{:x}-{sequence:x}", std::process::id());
        match parent.symlink_metadata(&name) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(name),
            Ok(_) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Could not allocate a Notes export staging path.".to_string())
}

fn path_exists_nofollow_in(parent: &Dir, path: &Path) -> Result<bool, String> {
    #[cfg(test)]
    if INJECT_MARKDOWN_ROLLBACK_INSPECTION_FAILURE.with(|injected| {
        let mut injected = injected.borrow_mut();
        if injected.as_deref() == path.file_name().and_then(|name| name.to_str()) {
            injected.take();
            true
        } else {
            false
        }
    }) {
        return Err("Injected Notes export rollback inspection failure.".to_string());
    }
    match parent.symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn classify_export_directory_sync(result: std::io::Result<()>) -> Result<(), String> {
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::Unsupported => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(all(test, unix))]
fn sync_export_directory(path: &Path) -> Result<(), String> {
    classify_export_directory_sync(fs::File::open(path).and_then(|directory| directory.sync_all()))
}

#[cfg(all(test, not(unix)))]
fn sync_export_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
thread_local! {
    static INJECT_MARKDOWN_PUBLISH_FAILURE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static INJECT_MARKDOWN_COMMIT_RACE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static INJECT_MARKDOWN_ASSET_DESTINATION_SWAP: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static INJECT_MARKDOWN_ASSET_MARKER_IDENTITY_RACE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static INJECT_MARKDOWN_OVERWRITE_DISPLACEMENT_RACE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static INJECT_MARKDOWN_PRE_DOCUMENT_BACKUP_SLOT_RACE: std::cell::RefCell<Option<Box<dyn FnOnce(&Path)>>> =
        const { std::cell::RefCell::new(None) };
    static INJECT_MARKDOWN_PRE_ASSET_BACKUP_SLOT_RACE: std::cell::RefCell<Option<Box<dyn FnOnce(&Path)>>> =
        const { std::cell::RefCell::new(None) };
    static INJECT_MARKDOWN_POST_ASSET_PUBLICATION_SWAP: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static INJECT_MARKDOWN_PRE_DOCUMENT_PUBLICATION_ASSET_SWAP: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static INJECT_MARKDOWN_PRE_STAGE_CLEANUP_RACE: std::cell::RefCell<Option<Box<dyn FnOnce(&Path)>>> =
        const { std::cell::RefCell::new(None) };
    static INJECT_MARKDOWN_POST_STAGE_VALIDATION_CLEANUP_RACE: std::cell::RefCell<Option<Box<dyn FnOnce(&Path)>>> =
        const { std::cell::RefCell::new(None) };
    static INJECT_MARKDOWN_PRE_DOCUMENT_ROLLBACK_RACE: std::cell::RefCell<Option<Box<dyn FnOnce(&Path)>>> =
        const { std::cell::RefCell::new(None) };
    static INJECT_MARKDOWN_ROLLBACK_INSPECTION_FAILURE: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
    static INJECT_EXPORT_PARENT_SYNC_FAILURE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static EXPORT_CLEANUP_WARNINGS: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn report_export_cleanup_warning(warning: String) {
    eprintln!("{warning}");
    #[cfg(test)]
    EXPORT_CLEANUP_WARNINGS.with(|warnings| warnings.borrow_mut().push(warning));
}

#[cfg(test)]
fn take_export_cleanup_warnings() -> Vec<String> {
    EXPORT_CLEANUP_WARNINGS.with(|warnings| std::mem::take(&mut *warnings.borrow_mut()))
}

#[cfg(test)]
pub(crate) fn inject_markdown_publish_failure_once() {
    INJECT_MARKDOWN_PUBLISH_FAILURE.with(|injected| injected.set(true));
}

#[cfg(test)]
fn inject_markdown_commit_race_once(action: impl FnOnce() + 'static) {
    INJECT_MARKDOWN_COMMIT_RACE.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

fn maybe_inject_markdown_commit_race() {
    #[cfg(test)]
    INJECT_MARKDOWN_COMMIT_RACE.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(test)]
fn inject_markdown_asset_destination_swap_once(action: impl FnOnce() + 'static) {
    INJECT_MARKDOWN_ASSET_DESTINATION_SWAP.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

fn maybe_inject_markdown_asset_destination_swap() {
    #[cfg(test)]
    INJECT_MARKDOWN_ASSET_DESTINATION_SWAP.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(test)]
fn inject_markdown_asset_marker_identity_race_once(action: impl FnOnce() + 'static) {
    INJECT_MARKDOWN_ASSET_MARKER_IDENTITY_RACE.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

fn maybe_inject_markdown_asset_marker_identity_race() {
    #[cfg(test)]
    INJECT_MARKDOWN_ASSET_MARKER_IDENTITY_RACE.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(test)]
fn inject_markdown_overwrite_displacement_race_once(action: impl FnOnce() + 'static) {
    INJECT_MARKDOWN_OVERWRITE_DISPLACEMENT_RACE.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

fn maybe_inject_markdown_overwrite_displacement_race() {
    #[cfg(test)]
    INJECT_MARKDOWN_OVERWRITE_DISPLACEMENT_RACE.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(test)]
fn inject_markdown_pre_document_backup_slot_race_once(action: impl FnOnce(&Path) + 'static) {
    INJECT_MARKDOWN_PRE_DOCUMENT_BACKUP_SLOT_RACE.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

fn maybe_inject_markdown_pre_document_backup_slot_race(_stage: &Path) {
    #[cfg(test)]
    INJECT_MARKDOWN_PRE_DOCUMENT_BACKUP_SLOT_RACE.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action(_stage);
        }
    });
}

#[cfg(test)]
fn inject_markdown_pre_asset_backup_slot_race_once(action: impl FnOnce(&Path) + 'static) {
    INJECT_MARKDOWN_PRE_ASSET_BACKUP_SLOT_RACE.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

fn maybe_inject_markdown_pre_asset_backup_slot_race(_stage: &Path) {
    #[cfg(test)]
    INJECT_MARKDOWN_PRE_ASSET_BACKUP_SLOT_RACE.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action(_stage);
        }
    });
}

#[cfg(test)]
fn inject_markdown_post_asset_publication_swap_once(action: impl FnOnce() + 'static) {
    INJECT_MARKDOWN_POST_ASSET_PUBLICATION_SWAP.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

fn maybe_inject_markdown_post_asset_publication_swap() {
    #[cfg(test)]
    INJECT_MARKDOWN_POST_ASSET_PUBLICATION_SWAP.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(test)]
fn inject_markdown_pre_document_publication_asset_swap_once(action: impl FnOnce() + 'static) {
    INJECT_MARKDOWN_PRE_DOCUMENT_PUBLICATION_ASSET_SWAP.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

fn maybe_inject_markdown_pre_document_publication_asset_swap() {
    #[cfg(test)]
    INJECT_MARKDOWN_PRE_DOCUMENT_PUBLICATION_ASSET_SWAP.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(test)]
fn inject_markdown_pre_stage_cleanup_race_once(action: impl FnOnce(&Path) + 'static) {
    INJECT_MARKDOWN_PRE_STAGE_CLEANUP_RACE.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

fn maybe_inject_markdown_pre_stage_cleanup_race(_stage: &Path) {
    #[cfg(test)]
    INJECT_MARKDOWN_PRE_STAGE_CLEANUP_RACE.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action(_stage);
        }
    });
}

#[cfg(test)]
fn inject_markdown_post_stage_validation_cleanup_race_once(action: impl FnOnce(&Path) + 'static) {
    INJECT_MARKDOWN_POST_STAGE_VALIDATION_CLEANUP_RACE.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

fn maybe_inject_markdown_post_stage_validation_cleanup_race(_stage: &Path) {
    #[cfg(test)]
    INJECT_MARKDOWN_POST_STAGE_VALIDATION_CLEANUP_RACE.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action(_stage);
        }
    });
}

#[cfg(test)]
fn inject_markdown_pre_document_rollback_race_once(action: impl FnOnce(&Path) + 'static) {
    INJECT_MARKDOWN_PRE_DOCUMENT_ROLLBACK_RACE.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

fn maybe_inject_markdown_pre_document_rollback_race(_stage: &Path) {
    #[cfg(test)]
    INJECT_MARKDOWN_PRE_DOCUMENT_ROLLBACK_RACE.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action(_stage);
        }
    });
}

#[cfg(test)]
fn inject_markdown_rollback_inspection_failure_once(file_name: &str) {
    INJECT_MARKDOWN_ROLLBACK_INSPECTION_FAILURE.with(|injected| {
        *injected.borrow_mut() = Some(file_name.to_string());
    });
}

#[cfg(test)]
fn inject_export_parent_sync_failure_once() {
    INJECT_EXPORT_PARENT_SYNC_FAILURE.with(|injected| injected.set(true));
}

#[cfg(unix)]
fn sync_held_export_directory(directory: &Dir) -> Result<(), String> {
    classify_export_directory_sync(
        directory
            .try_clone()
            .and_then(|directory| directory.into_std_file().sync_all()),
    )
}

#[cfg(not(unix))]
fn sync_held_export_directory(_directory: &Dir) -> Result<(), String> {
    Ok(())
}

fn sync_export_capability(directory: &Dir) -> Result<(), String> {
    #[cfg(test)]
    if INJECT_EXPORT_PARENT_SYNC_FAILURE.with(|injected| injected.replace(false)) {
        return Err("Injected Notes export parent sync failure.".to_string());
    }
    sync_held_export_directory(directory)
}

fn maybe_fail_markdown_publish() -> Result<(), String> {
    #[cfg(test)]
    if INJECT_MARKDOWN_PUBLISH_FAILURE.with(|injected| injected.replace(false)) {
        return Err("Injected Notes Markdown publish failure.".to_string());
    }
    Ok(())
}

/// Self-describing manifest written into each export assets directory. Only
/// `created_by` gates the overwrite guard; `version`/`files` are advisory and
/// tolerated-absent so older or newer markers still validate as our own.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportAssetMarker {
    created_by: String,
    #[serde(default)]
    version: u32,
    #[serde(default)]
    files: Vec<String>,
}

fn export_asset_marker_bytes(prepared: &PreparedMarkdownExport) -> Result<Vec<u8>, String> {
    let marker = ExportAssetMarker {
        created_by: EXPORT_ASSET_MARKER_CREATED_BY.to_string(),
        version: EXPORT_ASSET_MARKER_VERSION,
        files: prepared
            .assets
            .iter()
            .map(|asset| asset.file_name.clone())
            .collect(),
    };
    serde_json::to_vec(&marker)
        .map_err(|error| format!("Could not serialize the Notes export asset marker: {error}"))
}

fn export_capability_identity(metadata: &cap_std::fs::Metadata) -> ExportDirectoryIdentity {
    ExportDirectoryIdentity {
        volume: cap_fs_ext::MetadataExt::dev(metadata),
        file: cap_fs_ext::MetadataExt::ino(metadata),
    }
}

struct HeldExportDirectory {
    directory: Dir,
    identity: ExportDirectoryIdentity,
}

impl HeldExportDirectory {
    fn from_directory(directory: Dir) -> Result<Self, String> {
        let metadata = directory
            .dir_metadata()
            .map_err(|error| error.to_string())?;
        if !metadata.is_dir() {
            return Err("Notes export held paths must be directories.".to_string());
        }
        let identity = export_capability_identity(&metadata);
        Ok(Self {
            directory,
            identity,
        })
    }

    fn open_from(parent: &Dir, path: &Path, changed_context: &str) -> Result<Self, String> {
        let held = Self::from_directory(
            open_export_directory_from(parent, path).map_err(|error| error.to_string())?,
        )?;
        held.verify_in(parent, path, changed_context)?;
        Ok(held)
    }

    fn open_nofollow(path: &Path, changed_context: &str) -> Result<Self, String> {
        let directory = open_export_directory_nofollow(path).map_err(|error| error.to_string())?;
        let identity = export_capability_identity(
            &directory
                .dir_metadata()
                .map_err(|error| error.to_string())?,
        );
        let held = Self {
            directory,
            identity,
        };
        held.verify_at(path, changed_context)?;
        Ok(held)
    }

    fn verify_at(&self, path: &Path, changed_context: &str) -> Result<(), String> {
        self.verify_held(changed_context)?;
        let path_identity = export_directory_identity(path)
            .map_err(|error| format!("{changed_context}: {error}"))?;
        if path_identity != self.identity {
            return Err(format!("{changed_context}."));
        }
        Ok(())
    }

    fn verify_held(&self, changed_context: &str) -> Result<(), String> {
        let capability_identity =
            export_capability_identity(&self.directory.dir_metadata().map_err(|error| {
                format!("{changed_context}; could not inspect the held directory: {error}")
            })?);
        if capability_identity != self.identity {
            return Err(format!(
                "{changed_context}; the held directory identity changed."
            ));
        }
        Ok(())
    }

    fn verify_in(&self, parent: &Dir, path: &Path, changed_context: &str) -> Result<(), String> {
        self.verify_held(changed_context)?;
        let current = open_export_directory_from(parent, path)
            .map_err(|error| format!("{changed_context}: {error}"))?;
        let identity = export_capability_identity(
            &current
                .dir_metadata()
                .map_err(|error| format!("{changed_context}: {error}"))?,
        );
        if identity != self.identity {
            return Err(format!("{changed_context}."));
        }
        Ok(())
    }

    fn remove_empty_held(self, context: &str) -> Result<(), String> {
        self.verify_held(context)?;
        let unexpected_entry = {
            let mut entries = self
                .directory
                .entries()
                .map_err(|error| format!("{context}; could not inspect the directory: {error}"))?;
            entries
                .next()
                .transpose()
                .map_err(|error| format!("{context}; could not inspect the directory: {error}"))?
                .map(|entry| entry.file_name())
        };
        if let Some(entry) = unexpected_entry {
            return Err(format!(
                "{context}; the directory contains an unexpected entry named {}.",
                Path::new(&entry).display()
            ));
        }

        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;

            let result = windows_delete_export_handle(self.directory.as_raw_handle())
                .map_err(|error| format!("{context}: {error}"));
            drop(self.directory);
            result
        }

        #[cfg(not(windows))]
        {
            self.directory
                .remove_open_dir()
                .map_err(|error| format!("{context}: {error}"))
        }
    }
}

struct HeldExportFile {
    file: CapFile,
    identity: ExportDirectoryIdentity,
}

impl HeldExportFile {
    fn open_from(parent: &Dir, path: &Path, changed_context: &str) -> Result<Self, String> {
        let file = open_export_file_from(parent, path).map_err(|error| error.to_string())?;
        let held = Self::from_file_held(file)?;
        held.verify_in(parent, path, changed_context)?;
        Ok(held)
    }

    fn from_file_held(file: CapFile) -> Result<Self, String> {
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        if !metadata.file_type().is_file() {
            return Err("Notes export held paths must be regular files.".to_string());
        }
        Ok(Self {
            identity: export_capability_identity(&metadata),
            file,
        })
    }

    fn verify_held(&self, changed_context: &str) -> Result<(), String> {
        let capability_identity =
            export_capability_identity(&self.file.metadata().map_err(|error| {
                format!("{changed_context}; could not inspect the held file: {error}")
            })?);
        if capability_identity != self.identity {
            return Err(format!(
                "{changed_context}; the held file identity changed."
            ));
        }
        Ok(())
    }

    fn verify_in(&self, parent: &Dir, path: &Path, changed_context: &str) -> Result<(), String> {
        self.verify_held(changed_context)?;
        let current = Self::open_from_unverified(parent, path, changed_context)?;
        if current.identity != self.identity {
            return Err(format!("{changed_context}."));
        }
        Ok(())
    }

    fn open_from_unverified(
        parent: &Dir,
        path: &Path,
        changed_context: &str,
    ) -> Result<Self, String> {
        let file = open_export_file_from(parent, path)
            .map_err(|error| format!("{changed_context}: {error}"))?;
        Self::from_file_held(file).map_err(|error| format!("{changed_context}; {error}"))
    }

    fn preserve_copy_in(&self, parent: &Dir, prefix: &str) -> Result<PathBuf, String> {
        let name = unique_export_capability_name(parent, prefix)?;
        let mut source = self.file.try_clone().map_err(|error| error.to_string())?;
        source
            .seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;
        let mut options = CapOpenOptions::new();
        options.write(true).create_new(true);
        let mut destination = parent
            .open_with(&name, &options)
            .map_err(|error| error.to_string())?;
        std::io::copy(&mut source, &mut destination).map_err(|error| error.to_string())?;
        destination.sync_all().map_err(|error| error.to_string())?;
        Ok(PathBuf::from(name))
    }

    fn remove_from_held(
        self,
        parent: &Dir,
        relative_path: &Path,
        context: &str,
    ) -> Result<(), String> {
        self.verify_in(parent, relative_path, context)?;

        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;

            let result = windows_delete_export_handle(self.file.as_raw_handle())
                .map_err(|error| format!("{context}: {error}"));
            drop(self.file);
            result
        }

        #[cfg(not(windows))]
        {
            parent
                .remove_file(relative_path)
                .map_err(|error| format!("{context}: {error}"))
        }
    }

    fn read_all(&self) -> Result<Vec<u8>, String> {
        let mut source = self.file.try_clone().map_err(|error| error.to_string())?;
        source
            .seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        source
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        Ok(bytes)
    }

    fn has_same_identity(&self, other: &Self) -> bool {
        self.identity == other.identity
    }
}

struct HeldExportAssetFile {
    relative_path: PathBuf,
    file: HeldExportFile,
}

struct HeldExportAssetDirectory {
    directory: HeldExportDirectory,
    files: Vec<HeldExportAssetFile>,
}

impl HeldExportAssetDirectory {
    fn capture_held(
        directory: HeldExportDirectory,
        preheld_file: Option<HeldExportAssetFile>,
        changed_context: &str,
    ) -> Result<Self, String> {
        directory.verify_held(changed_context)?;
        let entry_names = Self::entry_names(&directory.directory, changed_context)?;
        let mut preheld_file = preheld_file;
        let mut files = Vec::with_capacity(entry_names.len());
        for relative_path in entry_names {
            let file = if preheld_file
                .as_ref()
                .is_some_and(|file| file.relative_path == relative_path)
            {
                preheld_file
                    .take()
                    .expect("matching preheld asset file must be present")
                    .file
            } else {
                HeldExportFile::open_from(&directory.directory, &relative_path, changed_context)?
            };
            files.push(HeldExportAssetFile {
                relative_path,
                file,
            });
        }
        if preheld_file.is_some() {
            return Err(format!(
                "{changed_context}; the validated marker disappeared while asset files were captured."
            ));
        }
        let held = Self { directory, files };
        held.verify_held(changed_context)?;
        Ok(held)
    }

    fn entry_names(directory: &Dir, context: &str) -> Result<BTreeSet<PathBuf>, String> {
        let entries = directory
            .entries()
            .map_err(|error| format!("{context}; could not inspect asset files: {error}"))?;
        let mut names = BTreeSet::new();
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("{context}; could not inspect an asset file: {error}"))?;
            let relative_path = PathBuf::from(entry.file_name());
            if relative_path.components().count() != 1
                || !matches!(
                    relative_path.components().next(),
                    Some(Component::Normal(_))
                )
            {
                return Err(format!(
                    "{context}; an asset file has an unsafe relative path."
                ));
            }
            names.insert(relative_path);
        }
        Ok(names)
    }

    fn verify_held(&self, changed_context: &str) -> Result<(), String> {
        self.directory.verify_held(changed_context)?;
        let current_names = Self::entry_names(&self.directory.directory, changed_context)?;
        let expected_names = self
            .files
            .iter()
            .map(|file| file.relative_path.clone())
            .collect::<BTreeSet<_>>();
        if current_names != expected_names {
            return Err(format!(
                "{changed_context}; the asset directory entry set changed."
            ));
        }
        for file in &self.files {
            file.file.verify_in(
                &self.directory.directory,
                &file.relative_path,
                &format!(
                    "{changed_context}; asset file {} changed",
                    file.relative_path.display()
                ),
            )?;
        }
        self.directory.verify_held(changed_context)
    }

    fn verify_in(&self, parent: &Dir, path: &Path, changed_context: &str) -> Result<(), String> {
        self.directory.verify_in(parent, path, changed_context)?;
        self.verify_held(changed_context)
    }

    fn is_in(&self, parent: &Dir, path: &Path, changed_context: &str) -> Result<bool, String> {
        match parent.symlink_metadata(path) {
            Ok(_) => self.verify_in(parent, path, changed_context).map(|()| true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!("{changed_context}: {error}")),
        }
    }

    fn remove_owned_held(self, context: &str) -> Result<(), String> {
        self.verify_held(context)?;
        let Self { directory, files } = self;
        for file in files {
            file.file.remove_from_held(
                &directory.directory,
                &file.relative_path,
                &format!(
                    "{context}; owned asset file {} changed during cleanup",
                    file.relative_path.display()
                ),
            )?;
        }
        directory.remove_empty_held(context)
    }
}

fn validated_export_asset_marker_in(
    parent: &Dir,
    asset_path: &Path,
    asset_directory: &HeldExportDirectory,
) -> Result<HeldExportFile, String> {
    asset_directory.verify_in(
        parent,
        asset_path,
        "Notes export asset destination identity changed before marker validation",
    )?;
    let marker_path = Path::new(EXPORT_ASSET_MARKER_NAME);
    match asset_directory.directory.symlink_metadata(marker_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(FOREIGN_EXPORT_ASSET_DIR_MESSAGE.to_string())
        }
        Err(error) => return Err(error.to_string()),
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(FOREIGN_EXPORT_ASSET_DIR_MESSAGE.to_string())
        }
        Ok(_) => {}
    }
    let marker_file = HeldExportFile::open_from(
        &asset_directory.directory,
        marker_path,
        "Notes export asset marker identity changed while it was opened",
    )?;
    let marker = serde_json::from_slice::<ExportAssetMarker>(&marker_file.read_all()?)
        .map_err(|_| FOREIGN_EXPORT_ASSET_DIR_MESSAGE.to_string())?;
    if marker.created_by != EXPORT_ASSET_MARKER_CREATED_BY {
        return Err(FOREIGN_EXPORT_ASSET_DIR_MESSAGE.to_string());
    }
    maybe_inject_markdown_asset_marker_identity_race();
    asset_directory.verify_in(
        parent,
        asset_path,
        "Notes export asset destination identity changed during marker validation",
    )?;
    marker_file.verify_in(
        &asset_directory.directory,
        marker_path,
        "Notes export asset marker identity changed during marker validation",
    )?;
    Ok(marker_file)
}

fn existing_export_document_in(
    parent: &Dir,
    destination: &Path,
) -> Result<Option<HeldExportFile>, String> {
    match parent.symlink_metadata(destination) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            Err("Notes export document destination must be a regular file.".to_string())
        }
        Ok(_) => HeldExportFile::open_from(
            parent,
            destination,
            "Notes export document destination identity changed while it was opened",
        )
        .map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

struct PreparedMarkdownStage {
    name: String,
    path: PathBuf,
    directory: HeldExportDirectory,
    document_path: PathBuf,
    document: HeldExportFile,
    assets_path: PathBuf,
    assets: HeldExportAssetDirectory,
}

fn prepare_markdown_stage_in(
    parent: &Dir,
    parent_path: &Path,
    prepared: &PreparedMarkdownExport,
) -> Result<PreparedMarkdownStage, String> {
    let stage_name = unique_export_capability_name(parent, ".yonalist-notes-export-")?;
    #[cfg(windows)]
    parent
        .create_dir(&stage_name)
        .map_err(|error| error.to_string())?;
    #[cfg(not(windows))]
    {
        let mut builder = DirBuilder::new();
        #[cfg(unix)]
        CapDirBuilderExt::mode(&mut builder, 0o700);
        parent
            .create_dir_with(&stage_name, &builder)
            .map_err(|error| error.to_string())?;
    }
    let stage_path = parent_path.join(&stage_name);
    let prepared_stage = (|| {
        let stage_directory = HeldExportDirectory::open_from(
            parent,
            Path::new(&stage_name),
            "Notes export private staging identity changed while it was opened",
        )?;
        stage_directory
            .directory
            .create_dir("assets")
            .map_err(|error| error.to_string())?;
        let assets_path = stage_path.join("assets");
        let assets = HeldExportDirectory::open_from(
            &stage_directory.directory,
            Path::new("assets"),
            "Notes export staged asset directory identity changed while it was opened",
        )?;
        for asset in &prepared.assets {
            let mut options = CapOpenOptions::new();
            options.write(true).create_new(true);
            let mut file = assets
                .directory
                .open_with(&asset.file_name, &options)
                .map_err(|error| error.to_string())?;
            file.write_all(&asset.bytes)
                .map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
        }
        let marker_bytes = export_asset_marker_bytes(prepared)?;
        let mut marker_options = CapOpenOptions::new();
        marker_options.write(true).create_new(true);
        let mut marker = assets
            .directory
            .open_with(EXPORT_ASSET_MARKER_NAME, &marker_options)
            .map_err(|error| error.to_string())?;
        marker
            .write_all(&marker_bytes)
            .map_err(|error| error.to_string())?;
        marker.sync_all().map_err(|error| error.to_string())?;

        let document_path = stage_path.join("document.md");
        let mut document_options = CapOpenOptions::new();
        document_options.read(true).write(true).create_new(true);
        let mut document = stage_directory
            .directory
            .open_with("document.md", &document_options)
            .map_err(|error| error.to_string())?;
        document
            .write_all(&prepared.markdown)
            .map_err(|error| error.to_string())?;
        document.sync_all().map_err(|error| error.to_string())?;
        drop(document);
        let document = HeldExportFile::open_from(
            &stage_directory.directory,
            Path::new("document.md"),
            "Notes export staged document identity changed while it was opened",
        )?;
        sync_held_export_directory(&assets.directory)?;
        let assets = HeldExportAssetDirectory::capture_held(
            assets,
            None,
            "Notes export staged asset directory identity changed before publication",
        )?;
        sync_held_export_directory(&stage_directory.directory)?;
        Ok(PreparedMarkdownStage {
            name: stage_name.clone(),
            path: stage_path.clone(),
            directory: stage_directory,
            document_path,
            document,
            assets_path,
            assets,
        })
    })();
    prepared_stage.map_err(|error: String| {
        format!(
            "{error} Notes export private staging was preserved at {}.",
            stage_path.display()
        )
    })
}

fn overwritable_export_asset_directory_in(
    parent: &Dir,
    asset_destination: &Path,
) -> Result<Option<HeldExportAssetDirectory>, String> {
    match parent.symlink_metadata(asset_destination) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("Notes export asset directory must not be a symlink.".to_string());
        }
        Ok(_) => {}
    }

    let asset_directory = HeldExportDirectory::open_from(
        parent,
        asset_destination,
        "Notes export asset destination identity changed before marker validation",
    )?;
    let marker_file =
        validated_export_asset_marker_in(parent, asset_destination, &asset_directory)?;
    HeldExportAssetDirectory::capture_held(
        asset_directory,
        Some(HeldExportAssetFile {
            relative_path: PathBuf::from(EXPORT_ASSET_MARKER_NAME),
            file: marker_file,
        }),
        "Notes export asset destination identity changed while its files were captured",
    )
    .map(Some)
}

fn rollback_published_directory_in(
    parent: &Dir,
    parent_path: &Path,
    published: &Path,
    expected_directory: &HeldExportAssetDirectory,
) -> Result<String, String> {
    let quarantine = unique_export_capability_name(parent, ".yonalist-notes-rollback-")?;
    let quarantine_path = Path::new(&quarantine);
    publish_path_noreplace_in(parent, published, parent, quarantine_path)
        .map_err(|error| format!("Could not quarantine Notes export assets: {error}"))?;

    if let Err(error) = expected_directory.verify_in(
        parent,
        quarantine_path,
        "Notes export asset directory identity changed before rollback",
    ) {
        let restore = publish_path_noreplace_in(parent, quarantine_path, parent, published);
        return match restore {
            Ok(()) => Err(format!("{error}; the unrelated replacement was preserved.")),
            Err(restore_error) => Err(format!(
                "{error}; the unrelated replacement was preserved at {} because restore failed: {restore_error}",
                parent_path.join(quarantine_path).display()
            )),
        };
    }

    Ok(format!(
        "Notes export rollback cleanup warning: published assets were preserved for startup/manual cleanup at {}.",
        parent_path.join(quarantine_path).display()
    ))
}

fn restore_or_preserve_displaced_path_in(
    source_parent: &Dir,
    displaced: &Path,
    destination_parent: &Dir,
    destination: &Path,
    recovery_parent: &Dir,
    recovery_parent_path: &Path,
    preserve_prefix: &str,
) -> Result<String, String> {
    match publish_path_noreplace_in(source_parent, displaced, destination_parent, destination) {
        Ok(()) => Ok("the unrelated replacement was preserved.".to_string()),
        Err(restore_error) => {
            let preserved = unique_export_capability_name(recovery_parent, preserve_prefix)?;
            publish_path_noreplace_in(
                source_parent,
                displaced,
                recovery_parent,
                Path::new(&preserved),
            )
            .map_err(|preserve_error| {
                format!(
                    "the unrelated replacement could not be restored or moved out of private staging: {restore_error}; preservation failed: {preserve_error}"
                )
            })?;
            Ok(format!(
                "the unrelated replacement was preserved at {} because restore failed: {restore_error}",
                recovery_parent_path.join(preserved).display()
            ))
        }
    }
}

fn displace_verified_overwrite_destination_in(
    parent: &Dir,
    destination: &Path,
    stage: &Dir,
    displaced: &Path,
    parent_path: &Path,
    expected_file: &HeldExportFile,
    destination_kind: &str,
    preserve_prefix: &str,
) -> Result<(), String> {
    publish_path_noreplace_in(parent, destination, stage, displaced)?;
    if let Err(error) = expected_file.verify_in(
        stage,
        displaced,
        &format!(
            "Notes export {destination_kind} destination identity changed before overwrite displacement"
        ),
    ) {
        let preservation = restore_or_preserve_displaced_path_in(
            stage,
            displaced,
            parent,
            destination,
            parent,
            parent_path,
            preserve_prefix,
        )
        .map_err(|preserve_error| format!("{error}; {preserve_error}"))?;
        return Err(format!("{error}; {preservation}"));
    }
    Ok(())
}

fn displace_verified_overwrite_asset_directory_in(
    parent: &Dir,
    destination: &Path,
    stage: &Dir,
    displaced: &Path,
    parent_path: &Path,
    expected_directory: &HeldExportAssetDirectory,
    preserve_prefix: &str,
) -> Result<(), String> {
    publish_path_noreplace_in(parent, destination, stage, displaced)?;
    if let Err(error) = expected_directory.verify_in(
        stage,
        displaced,
        "Notes export asset destination identity changed before overwrite displacement",
    ) {
        let preservation = restore_or_preserve_displaced_path_in(
            stage,
            displaced,
            parent,
            destination,
            parent,
            parent_path,
            preserve_prefix,
        )
        .map_err(|preserve_error| format!("{error}; {preserve_error}"))?;
        return Err(format!("{error}; {preservation}"));
    }
    Ok(())
}

fn rollback_published_document_in(
    parent: &Dir,
    destination: &Path,
    stage: &Dir,
    expected_file: &HeldExportFile,
) -> Result<(), String> {
    expected_file.verify_in(
        parent,
        destination,
        "Notes export published document identity changed before rollback",
    )?;
    let rolled_back = Path::new("published-document");
    publish_path_noreplace_in(parent, destination, stage, rolled_back)
        .map_err(|error| format!("Could not roll back the published Notes document: {error}"))?;
    if let Err(error) = expected_file.verify_in(
        stage,
        rolled_back,
        "Notes export published document identity changed during rollback",
    ) {
        let preservation = restore_or_preserve_displaced_path_in(
            stage,
            rolled_back,
            parent,
            destination,
            parent,
            Path::new("."),
            ".yonalist-notes-raced-document-",
        )
        .map_err(|preserve_error| format!("{error}; {preserve_error}"))?;
        return Err(format!("{error}; {preservation}"));
    }
    Ok(())
}

fn rollback_old_document_in(
    stage: &Dir,
    old_document: &Path,
    parent: &Dir,
    parent_path: &Path,
    destination: &Path,
    expected_file: &HeldExportFile,
) -> Result<(), (String, bool)> {
    if let Err(identity_error) = expected_file.verify_in(
        stage,
        old_document,
        "Notes export old document backup identity changed before rollback",
    ) {
        return match expected_file.preserve_copy_in(parent, ".yonalist-notes-old-document-") {
            Ok(preserved) => Err((
                format!(
                    "{identity_error}; the original old document was preserved at {} and the untrusted staging path was retained.",
                    parent_path.join(preserved).display()
                ),
                true,
            )),
            Err(preserve_error) => Err((
                format!(
                    "{identity_error}; the untrusted staging path was retained, but the held original document could not be copied to recovery: {preserve_error}"
                ),
                true,
            )),
        };
    }

    match publish_path_noreplace_in(stage, old_document, parent, destination) {
        Ok(()) => expected_file
            .verify_in(
                parent,
                destination,
                "Notes export old document identity changed during rollback",
            )
            .map_err(|identity_error| (identity_error, true)),
        Err(restore_error) => match expected_file
            .preserve_copy_in(parent, ".yonalist-notes-old-document-")
        {
            Ok(preserved) => Err((
                format!(
                    "Notes export incomplete rollback: the document destination remained occupied; the original old document backup was preserved at {}: {restore_error}",
                    parent_path.join(preserved).display()
                ),
                false,
            )),
            Err(preserve_error) => Err((
                format!(
                    "Notes export incomplete rollback: the document destination remained occupied and the held original document could not be copied to recovery: {restore_error}; preservation failed: {preserve_error}"
                ),
                true,
            )),
        },
    }
}

fn rollback_old_assets_in(
    stage: &Dir,
    old_assets: &Path,
    parent: &Dir,
    parent_path: &Path,
    asset_destination: &Path,
    expected_directory: &HeldExportAssetDirectory,
) -> Result<(), (String, bool)> {
    if let Err(identity_error) = expected_directory.verify_in(
        stage,
        old_assets,
        "Notes export old asset backup identity changed before rollback",
    ) {
        return Err((identity_error, true));
    }
    match publish_path_noreplace_in(stage, old_assets, parent, asset_destination) {
        Ok(()) => expected_directory
            .verify_in(
                parent,
                asset_destination,
                "Notes export old asset backup identity changed during rollback",
            )
            .map_err(|identity_error| (identity_error, true)),
        Err(restore_error) => {
            let preserved = unique_export_capability_name(parent, ".yonalist-notes-old-assets-")
                .map_err(|error| {
                    (
                        format!(
                            "Notes export incomplete rollback: the asset destination remained occupied and no recovery path could be reserved: {restore_error}; {error}"
                        ),
                        true,
                    )
                })?;
            publish_path_noreplace_in(stage, old_assets, parent, Path::new(&preserved)).map_err(
                |preserve_error| {
                    (
                        format!(
                            "Notes export incomplete rollback: the asset destination remained occupied and the old asset backup could not be moved out of private staging: {restore_error}; preservation failed: {preserve_error}"
                        ),
                        true,
                    )
                },
            )?;
            expected_directory
                .verify_in(
                    parent,
                    Path::new(&preserved),
                    "Notes export old asset backup identity changed during recovery preservation",
                )
                .map_err(|identity_error| {
                    (
                        format!(
                            "{identity_error}; the untrusted recovery path was retained at {}",
                            parent_path.join(&preserved).display()
                        ),
                        true,
                    )
                })?;
            Err((
                format!(
                    "Notes export incomplete rollback: the asset destination remained occupied; the old asset backup was preserved at {}: {restore_error}",
                    parent_path.join(preserved).display()
                ),
                false,
            ))
        }
    }
}

fn cleanup_markdown_stage_in(
    stage_path: &Path,
    stage_directory: HeldExportDirectory,
    staged_document: HeldExportFile,
    old_document: Option<HeldExportFile>,
    staged_assets: HeldExportAssetDirectory,
    old_assets: Option<HeldExportAssetDirectory>,
) -> Result<(), String> {
    let cleanup = (|| {
        maybe_inject_markdown_pre_stage_cleanup_race(stage_path);
        stage_directory
            .verify_held("Notes export private staging identity changed before cleanup")?;
        let staged_assets_present = staged_assets.is_in(
            &stage_directory.directory,
            Path::new("assets"),
            "Notes export staged asset directory identity changed before private staging cleanup",
        )?;
        let old_assets_present = match old_assets.as_ref() {
            Some(directory) => directory.is_in(
                &stage_directory.directory,
                Path::new("old-assets"),
                "Notes export old asset backup identity changed before private staging cleanup",
            )?,
            None => false,
        };
        let staged_document_cleanup = matching_export_file_in(
            &stage_directory.directory,
            Path::new("document.md"),
            &staged_document,
            "Notes export staged document identity changed before private staging cleanup",
        )?;
        let rolled_back_document_cleanup = matching_export_file_in(
            &stage_directory.directory,
            Path::new("published-document"),
            &staged_document,
            "Notes export rolled-back document identity changed before private staging cleanup",
        )?;
        let old_document_cleanup = match old_document.as_ref() {
            Some(file) => matching_export_file_in(
                &stage_directory.directory,
                Path::new("old-document"),
                file,
                "Notes export old document backup identity changed before private staging cleanup",
            )?,
            None => None,
        };

        maybe_inject_markdown_post_stage_validation_cleanup_race(stage_path);
        stage_directory
            .verify_held("Notes export private staging identity changed during cleanup")?;
        if staged_assets_present {
            staged_assets.remove_owned_held("Could not remove owned staged Notes export assets")?;
        }
        if old_assets_present {
            old_assets
                .expect("presence requires an old asset capability")
                .remove_owned_held("Could not remove the owned old Notes export asset backup")?;
        }
        drop(staged_document);
        drop(old_document);
        for (file, relative, context) in [
            (
                staged_document_cleanup,
                "document.md",
                "Notes export staged document identity changed during private staging cleanup",
            ),
            (
                rolled_back_document_cleanup,
                "published-document",
                "Notes export rolled-back document identity changed during private staging cleanup",
            ),
        ] {
            if let Some(file) = file {
                file.remove_from_held(&stage_directory.directory, Path::new(relative), context)?;
            }
        }
        if let Some(file) = old_document_cleanup {
            file.remove_from_held(
                &stage_directory.directory,
                Path::new("old-document"),
                "Notes export old document backup identity changed during private staging cleanup",
            )?;
        }
        stage_directory
            .verify_held("Notes export private staging identity changed before final cleanup")?;
        stage_directory.remove_empty_held("Could not remove private Notes export staging")
    })();
    cleanup.map_err(|error| {
        format!(
            "{error} Notes export private staging was preserved at {}.",
            stage_path.display()
        )
    })
}

fn matching_export_file_in(
    parent: &Dir,
    path: &Path,
    expected_file: &HeldExportFile,
    changed_context: &str,
) -> Result<Option<HeldExportFile>, String> {
    match parent.symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{changed_context}: {error}")),
        Ok(metadata) if !metadata.file_type().is_file() => Err(format!(
            "{changed_context}; the cleanup path is not a regular file."
        )),
        Ok(_) => {
            let file = HeldExportFile::open_from(parent, path, changed_context)?;
            if !file.has_same_identity(expected_file) {
                return Err(format!("{changed_context}."));
            }
            Ok(Some(file))
        }
    }
}

#[cfg(test)]
pub(crate) fn publish_markdown_export(
    destination: &Path,
    asset_destination: &Path,
    prepared: &PreparedMarkdownExport,
    overwrite: bool,
) -> Result<(), String> {
    let parent_path = destination.parent().unwrap_or_else(|| Path::new("."));
    let parent = Dir::open_ambient_dir(parent_path, ambient_authority())
        .map_err(|error| error.to_string())?;
    publish_markdown_export_with_revalidation(
        destination,
        asset_destination,
        prepared,
        overwrite,
        &parent,
        || Ok(()),
        || {},
    )
}

pub(crate) fn publish_markdown_export_guarded(
    destination: &Path,
    asset_destination: &Path,
    prepared: &PreparedMarkdownExport,
    overwrite: bool,
    guard: &NotesExportDestinationGuard,
    after_final_revalidation: impl FnOnce(),
) -> Result<(), String> {
    publish_markdown_export_with_revalidation(
        destination,
        asset_destination,
        prepared,
        overwrite,
        &guard.parent.directory,
        || guard.revalidate(),
        after_final_revalidation,
    )
}

fn publish_markdown_export_with_revalidation(
    destination: &Path,
    asset_destination: &Path,
    prepared: &PreparedMarkdownExport,
    overwrite: bool,
    parent_capability: &Dir,
    mut revalidate: impl FnMut() -> Result<(), String>,
    after_final_revalidation: impl FnOnce(),
) -> Result<(), String> {
    revalidate()?;
    let destination_name = destination
        .file_name()
        .map(Path::new)
        .ok_or_else(|| "File path must name a file.".to_string())?;
    let asset_destination_name = asset_destination
        .file_name()
        .map(Path::new)
        .ok_or_else(|| "Notes export asset destination must name a directory.".to_string())?;
    if prepared.assets.is_empty() {
        return crate::file_io::write_atomic_file_in_guarded_parent(
            parent_capability,
            destination_name,
            &prepared.markdown,
            overwrite,
            revalidate,
            after_final_revalidation,
        );
    }
    if !overwrite {
        match parent_capability.symlink_metadata(destination_name) {
            Ok(_) => return Err(crate::file_io::DESTINATION_EXISTS_MESSAGE.to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }

    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let old_document_capability = if overwrite {
        existing_export_document_in(parent_capability, destination_name)?
    } else {
        None
    };
    let old_asset_directory = if overwrite {
        overwritable_export_asset_directory_in(parent_capability, asset_destination_name)?
    } else {
        if path_exists_nofollow_in(parent_capability, asset_destination_name)? {
            return Err(crate::file_io::DESTINATION_EXISTS_MESSAGE.to_string());
        }
        None
    };
    let PreparedMarkdownStage {
        name: _stage_name,
        path: stage_path,
        directory: stage_directory,
        document_path: _staged_document,
        document: staged_document_capability,
        assets_path: _staged_assets,
        assets: staged_asset_directory,
    } = prepare_markdown_stage_in(parent_capability, parent, prepared)?;
    let mut after_final_revalidation = Some(after_final_revalidation);
    maybe_inject_markdown_commit_race();

    if !overwrite {
        maybe_inject_markdown_asset_destination_swap();
        let mut published_assets = false;
        let mut published_document = false;
        let publish_result = (|| {
            revalidate()?;
            if let Some(action) = after_final_revalidation.take() {
                action();
            }
            publish_path_noreplace_in(
                &stage_directory.directory,
                Path::new("assets"),
                parent_capability,
                asset_destination_name,
            )?;
            published_assets = true;
            maybe_inject_markdown_post_asset_publication_swap();
            maybe_fail_markdown_publish()?;
            staged_asset_directory.verify_in(
                parent_capability,
                asset_destination_name,
                "Notes export staged asset directory identity changed after publication",
            )?;
            maybe_inject_markdown_pre_document_publication_asset_swap();
            revalidate()?;
            publish_path_noreplace_in(
                &stage_directory.directory,
                Path::new("document.md"),
                parent_capability,
                destination_name,
            )?;
            published_document = true;
            staged_document_capability.verify_in(
                parent_capability,
                destination_name,
                "Notes export staged document identity changed after publication",
            )?;
            staged_asset_directory.verify_in(
                parent_capability,
                asset_destination_name,
                "Notes export staged asset directory identity changed after document publication",
            )?;
            revalidate()
        })();
        if let Err(error) = publish_result {
            let mut rollback_errors = Vec::new();
            let mut preserve_stage = false;
            if published_document {
                if let Err(rollback_error) = rollback_published_document_in(
                    parent_capability,
                    destination_name,
                    &stage_directory.directory,
                    &staged_document_capability,
                ) {
                    preserve_stage = true;
                    rollback_errors.push(rollback_error);
                }
            }
            if published_assets {
                match rollback_published_directory_in(
                    parent_capability,
                    parent,
                    asset_destination_name,
                    &staged_asset_directory,
                ) {
                    Ok(warning) => report_export_cleanup_warning(warning),
                    Err(rollback_error) => rollback_errors.push(rollback_error),
                }
            }
            if preserve_stage {
                rollback_errors.push(format!(
                    "Notes export incomplete rollback: private staging was preserved at {} for startup/manual recovery.",
                    stage_path.display()
                ));
            } else {
                if let Err(cleanup_error) = cleanup_markdown_stage_in(
                    &stage_path,
                    stage_directory,
                    staged_document_capability,
                    None,
                    staged_asset_directory,
                    None,
                ) {
                    rollback_errors.push(cleanup_error);
                }
            }
            return if rollback_errors.is_empty() {
                Err(error)
            } else {
                Err(format!(
                    "{error} Notes export rollback also failed: {}",
                    rollback_errors.join("; ")
                ))
            };
        }
        if let Err(cleanup_error) = cleanup_markdown_stage_in(
            &stage_path,
            stage_directory,
            staged_document_capability,
            None,
            staged_asset_directory,
            None,
        ) {
            report_export_cleanup_warning(format!("Notes export cleanup warning: {cleanup_error}"));
        }
        let _ = sync_export_capability(parent_capability);
        return Ok(());
    }

    let old_document = Path::new("old-document");
    let old_assets = Path::new("old-assets");
    let had_document = old_document_capability.is_some();
    let had_assets = old_asset_directory.is_some();
    let mut published_document = false;
    let mut published_assets = false;
    maybe_inject_markdown_overwrite_displacement_race();
    let publish_result = (|| {
        revalidate()?;
        if let Some(action) = after_final_revalidation.take() {
            action();
        }
        if let Some(document) = old_document_capability.as_ref() {
            maybe_inject_markdown_pre_document_backup_slot_race(&stage_path);
            displace_verified_overwrite_destination_in(
                parent_capability,
                destination_name,
                &stage_directory.directory,
                old_document,
                parent,
                document,
                "document",
                ".yonalist-notes-replaced-document-",
            )?;
        }
        if let Some(directory) = old_asset_directory.as_ref() {
            maybe_inject_markdown_pre_asset_backup_slot_race(&stage_path);
            displace_verified_overwrite_asset_directory_in(
                parent_capability,
                asset_destination_name,
                &stage_directory.directory,
                old_assets,
                parent,
                directory,
                ".yonalist-notes-replaced-assets-",
            )?;
        }
        publish_path_noreplace_in(
            &stage_directory.directory,
            Path::new("assets"),
            parent_capability,
            asset_destination_name,
        )?;
        published_assets = true;
        maybe_inject_markdown_post_asset_publication_swap();
        maybe_fail_markdown_publish()?;
        staged_asset_directory.verify_in(
            parent_capability,
            asset_destination_name,
            "Notes export staged asset directory identity changed after publication",
        )?;
        maybe_inject_markdown_pre_document_publication_asset_swap();
        publish_path_noreplace_in(
            &stage_directory.directory,
            Path::new("document.md"),
            parent_capability,
            destination_name,
        )?;
        published_document = true;
        staged_document_capability.verify_in(
            parent_capability,
            destination_name,
            "Notes export staged document identity changed after publication",
        )?;
        staged_asset_directory.verify_in(
            parent_capability,
            asset_destination_name,
            "Notes export staged asset directory identity changed after document publication",
        )?;
        revalidate()
    })();

    if let Err(error) = publish_result {
        let mut rollback_errors = Vec::new();
        let mut preserve_stage = false;
        if published_document {
            if let Err(rollback_error) = rollback_published_document_in(
                parent_capability,
                destination_name,
                &stage_directory.directory,
                &staged_document_capability,
            ) {
                preserve_stage = true;
                rollback_errors.push(rollback_error);
            }
        }
        if published_assets {
            match rollback_published_directory_in(
                parent_capability,
                parent,
                asset_destination_name,
                &staged_asset_directory,
            ) {
                Ok(warning) => report_export_cleanup_warning(warning),
                Err(rollback_error) => rollback_errors.push(rollback_error),
            }
        }
        if had_assets {
            match path_exists_nofollow_in(&stage_directory.directory, old_assets) {
                Ok(true) => {
                    if let Err((rollback_error, must_preserve_stage)) = rollback_old_assets_in(
                        &stage_directory.directory,
                        old_assets,
                        parent_capability,
                        parent,
                        asset_destination_name,
                        old_asset_directory
                            .as_ref()
                            .expect("had assets requires a held directory"),
                    ) {
                        preserve_stage |= must_preserve_stage;
                        rollback_errors.push(rollback_error);
                    }
                }
                Ok(false) => {}
                Err(inspect_error) => {
                    preserve_stage = true;
                    rollback_errors.push(format!(
                        "Could not inspect the old Notes export asset backup during rollback: {inspect_error}"
                    ));
                }
            }
        }
        if had_document {
            maybe_inject_markdown_pre_document_rollback_race(&stage_path);
            match path_exists_nofollow_in(&stage_directory.directory, old_document) {
                Ok(true) => {
                    if let Err((rollback_error, must_preserve_stage)) = rollback_old_document_in(
                        &stage_directory.directory,
                        old_document,
                        parent_capability,
                        parent,
                        destination_name,
                        old_document_capability
                            .as_ref()
                            .expect("had document requires a held file"),
                    ) {
                        preserve_stage |= must_preserve_stage;
                        rollback_errors.push(rollback_error);
                    }
                }
                Ok(false) => {}
                Err(inspect_error) => {
                    preserve_stage = true;
                    rollback_errors.push(format!(
                        "Could not inspect the old Notes export document backup during rollback: {inspect_error}"
                    ));
                }
            }
        }
        if preserve_stage {
            rollback_errors.push(format!(
                "Notes export incomplete rollback: private staging was preserved at {} for startup/manual recovery.",
                stage_path.display()
            ));
        } else {
            if let Err(cleanup_error) = cleanup_markdown_stage_in(
                &stage_path,
                stage_directory,
                staged_document_capability,
                old_document_capability,
                staged_asset_directory,
                old_asset_directory,
            ) {
                rollback_errors.push(cleanup_error);
            }
        }
        return if rollback_errors.is_empty() {
            Err(error)
        } else {
            Err(format!(
                "{error} Notes export rollback also failed: {}",
                rollback_errors.join("; ")
            ))
        };
    }

    if let Err(cleanup_error) = cleanup_markdown_stage_in(
        &stage_path,
        stage_directory,
        staged_document_capability,
        old_document_capability,
        staged_asset_directory,
        old_asset_directory,
    ) {
        report_export_cleanup_warning(format!("Notes export cleanup warning: {cleanup_error}"));
    }
    let _ = sync_export_capability(parent_capability);
    Ok(())
}

fn pdf_display_date(date: LocalDate) -> String {
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ][usize::from(date.month - 1)];
    format!("{month} {}, {}", date.day, date.year)
}

fn format_date_matches_for_pdf_display_inner(
    source: &str,
    matches: &[ExportDateSpan],
) -> Result<(String, usize), String> {
    fn advance_to_utf16_boundary(
        source: &str,
        byte_offset: &mut usize,
        utf16_offset: &mut usize,
        target_utf16: usize,
        boundary_name: &str,
        visited_utf16: &mut usize,
    ) -> Result<usize, String> {
        while *utf16_offset < target_utf16 {
            let character = source[*byte_offset..]
                .chars()
                .next()
                .ok_or_else(|| format!("A PDF date {boundary_name} is past the source text."))?;
            let character_utf16 = character.len_utf16();
            if *utf16_offset + character_utf16 > target_utf16 {
                return Err(format!(
                    "A PDF date {boundary_name} is not on a UTF-16 scalar boundary."
                ));
            }
            *byte_offset += character.len_utf8();
            *utf16_offset += character_utf16;
            *visited_utf16 += character_utf16;
        }
        Ok(*byte_offset)
    }

    let mut rendered = String::with_capacity(source.len());
    let mut source_byte_offset = 0;
    let mut source_utf16_offset = 0;
    let mut copy_byte_offset = 0;
    let mut visited_utf16 = 0;
    let mut previous_end_utf16 = 0;
    for date in matches {
        if date.start_utf16 >= date.end_utf16 || date.start_utf16 < previous_end_utf16 {
            return Err("PDF date spans are invalid or overlapping.".to_string());
        }
        let start_byte = advance_to_utf16_boundary(
            source,
            &mut source_byte_offset,
            &mut source_utf16_offset,
            date.start_utf16,
            "start",
            &mut visited_utf16,
        )?;
        rendered.push_str(&source[copy_byte_offset..start_byte]);
        let end_byte = advance_to_utf16_boundary(
            source,
            &mut source_byte_offset,
            &mut source_utf16_offset,
            date.end_utf16,
            "end",
            &mut visited_utf16,
        )?;
        let start = LocalDate::parse_iso(&date.normalized_start)
            .ok_or_else(|| "A PDF date has an invalid normalized start.".to_string())?;
        let end = LocalDate::parse_iso(&date.normalized_end)
            .ok_or_else(|| "A PDF date has an invalid normalized end.".to_string())?;
        if start > end {
            return Err("A PDF date has a reversed normalized range.".to_string());
        }
        let replacement = if end != start {
            format!("{} - {}", pdf_display_date(start), pdf_display_date(end))
        } else {
            pdf_display_date(start)
        };
        rendered.push_str(&replacement);
        copy_byte_offset = end_byte;
        previous_end_utf16 = date.end_utf16;
    }
    rendered.push_str(&source[copy_byte_offset..]);
    Ok((rendered, visited_utf16))
}

pub(crate) fn format_date_matches_for_pdf_display(
    source: &str,
    matches: &[ExportDateSpan],
) -> Result<String, String> {
    format_date_matches_for_pdf_display_inner(source, matches).map(|(rendered, _)| rendered)
}

#[cfg(test)]
fn format_date_matches_for_pdf_display_with_work(
    source: &str,
    matches: &[ExportDateSpan],
) -> Result<(String, usize), String> {
    format_date_matches_for_pdf_display_inner(source, matches)
}

#[derive(Clone, Copy)]
enum PdfTextTone {
    Primary,
    Supporting,
}

struct PdfPreparedLine {
    text: String,
    x: f32,
    size: f32,
    line_height: f32,
    tone: PdfTextTone,
}

struct PdfPreparedRow {
    lines: Vec<PdfPreparedLine>,
    height: f32,
}

struct PdfPreparedImage {
    attachment_id: String,
    original_name: String,
    mime_type: String,
    payload_key: ExportPayloadKey,
    bytes: Arc<[u8]>,
    intrinsic_width: usize,
    intrinsic_height: usize,
    x: f32,
    width: f32,
    height: f32,
    marker_line: Option<PdfPreparedLine>,
    primary_height: f32,
    caption_lines: Vec<PdfPreparedLine>,
    block_height: f32,
}

struct PdfImageSupportingContent {
    text: String,
    size: f32,
    line_height: f32,
}

enum PdfPreparedBlock {
    Row(PdfPreparedRow),
    Image(PdfPreparedImage),
}

struct PdfPlacedLine {
    text: String,
    x: f32,
    y: f32,
    size: f32,
    line_height: f32,
    tone: PdfTextTone,
}

struct PdfPlacedImage {
    attachment_id: String,
    original_name: String,
    mime_type: String,
    payload_key: ExportPayloadKey,
    bytes: Arc<[u8]>,
    intrinsic_width: usize,
    intrinsic_height: usize,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

#[derive(Default)]
struct PdfPageDraft {
    lines: Vec<PdfPlacedLine>,
    images: Vec<PdfPlacedImage>,
}

fn millimeters_to_points(value: f32) -> f32 {
    value * 72.0 / 25.4
}

fn pdf_text_width(font: &ParsedFont, text: &str, size: f32) -> Result<f32, String> {
    let units_per_em = font.font_metrics.units_per_em as f32;
    text.chars().try_fold(0.0, |width, character| {
        let glyph = font.lookup_glyph_index(character as u32).ok_or_else(|| {
            format!(
                "Bundled PDF font does not contain glyph U+{:04X}.",
                character as u32
            )
        })?;
        Ok(width + font.get_horizontal_advance(glyph) as f32 * size / units_per_em)
    })
}

fn wrap_pdf_text(
    font: &ParsedFont,
    value: &str,
    size: f32,
    max_width: f32,
) -> Result<Vec<String>, String> {
    if max_width < PDF_MIN_TEXT_WIDTH {
        return Err("PDF outline indentation leaves too little room for text.".to_string());
    }

    let normalized = normalize_newlines(value).replace('\t', "    ");
    let mut lines = Vec::new();

    for physical_line in normalized.split('\n') {
        if physical_line.is_empty() {
            lines.push(String::new());
            continue;
        }

        let mut line = String::new();
        let mut line_width = 0.0;
        for character in physical_line.chars() {
            let character_width = pdf_text_width(font, &character.to_string(), size)?;
            if !line.is_empty() && line_width + character_width > max_width {
                lines.push(line.trim_end().to_string());
                line.clear();
                line_width = 0.0;
                if character.is_whitespace() {
                    continue;
                }
            }
            line.push(character);
            line_width += character_width;
        }
        lines.push(line.trim_end().to_string());
    }

    Ok(lines)
}

fn prepare_pdf_row(
    font: &ParsedFont,
    node: &ExportNode,
    depth: usize,
) -> Result<PdfPreparedRow, String> {
    let margin_x = millimeters_to_points(PDF_MARGIN_X_MM);
    let body_width = millimeters_to_points(PDF_PAGE_WIDTH_MM - PDF_MARGIN_X_MM * 2.0);
    let max_indent = body_width - PDF_MIN_TEXT_WIDTH - PDF_NOTE_INDENT;
    let indentation = (depth as f32 * PDF_DEPTH_INDENT).min(max_indent);
    let title_x = margin_x + indentation;
    let title_width = body_width - indentation;
    let marker = if node.completed { 'x' } else { ' ' };
    let display_title = format_date_matches_for_pdf_display(&node.title, &node.title_date_spans)?;
    let title = format!("[{marker}] {display_title}");
    let title_lines = wrap_pdf_text(font, &title, PDF_ROW_SIZE, title_width)?;
    let mut lines = title_lines
        .into_iter()
        .map(|text| PdfPreparedLine {
            text,
            x: title_x,
            size: PDF_ROW_SIZE,
            line_height: PDF_ROW_LINE_HEIGHT,
            tone: PdfTextTone::Primary,
        })
        .collect::<Vec<_>>();

    if !node.note.is_empty() {
        let note_x = title_x + PDF_NOTE_INDENT;
        let note_width = title_width - PDF_NOTE_INDENT;
        let display_note = format_date_matches_for_pdf_display(&node.note, &node.note_date_spans)?;
        for note_line in normalize_newlines(&display_note).split('\n') {
            let supporting = if note_line.is_empty() {
                ">".to_string()
            } else {
                format!("> {note_line}")
            };
            lines.extend(
                wrap_pdf_text(font, &supporting, PDF_NOTE_SIZE, note_width)?
                    .into_iter()
                    .map(|text| PdfPreparedLine {
                        text,
                        x: note_x,
                        size: PDF_NOTE_SIZE,
                        line_height: PDF_NOTE_LINE_HEIGHT,
                        tone: PdfTextTone::Supporting,
                    }),
            );
        }
    }

    let height = lines.iter().map(|line| line.line_height).sum::<f32>() + PDF_ROW_GAP;
    Ok(PdfPreparedRow { lines, height })
}

fn prepare_pdf_image(
    font: &ParsedFont,
    attachment: &super::types::ExportAttachment,
    depth: usize,
    full_page_height: f32,
    marker: Option<char>,
    supporting: Option<PdfImageSupportingContent>,
) -> Result<PdfPreparedImage, String> {
    let intrinsic_width = usize::try_from(attachment.intrinsic_width)
        .map_err(|_| "A PDF attachment has an invalid intrinsic width.".to_string())?;
    let intrinsic_height = usize::try_from(attachment.intrinsic_height)
        .map_err(|_| "A PDF attachment has an invalid intrinsic height.".to_string())?;
    if intrinsic_width == 0 || intrinsic_height == 0 || attachment.display_width <= 0 {
        return Err("A PDF attachment has invalid display dimensions.".to_string());
    }
    let margin_x = millimeters_to_points(PDF_MARGIN_X_MM);
    let body_width = millimeters_to_points(PDF_PAGE_WIDTH_MM - PDF_MARGIN_X_MM * 2.0);
    let marker_indent = if marker.is_some() {
        PDF_NOTE_INDENT
    } else {
        0.0
    };
    let max_indent = body_width - PDF_MIN_TEXT_WIDTH - marker_indent;
    let indentation = (depth as f32 * PDF_DEPTH_INDENT).min(max_indent);
    let marker_x = margin_x + indentation;
    let x = marker_x + marker_indent;
    let max_width = body_width - indentation - marker_indent;
    let caption_lines = supporting
        .map(|supporting| {
            wrap_pdf_text(font, &supporting.text, supporting.size, max_width).map(|lines| {
                lines
                    .into_iter()
                    .map(|text| PdfPreparedLine {
                        text,
                        x,
                        size: supporting.size,
                        line_height: supporting.line_height,
                        tone: PdfTextTone::Supporting,
                    })
                    .collect::<Vec<_>>()
            })
        })
        .transpose()?
        .unwrap_or_default();
    let caption_height = caption_lines
        .iter()
        .map(|line| line.line_height)
        .sum::<f32>();
    let caption_gap = if caption_lines.is_empty() {
        0.0
    } else {
        PDF_IMAGE_CAPTION_GAP
    };
    let max_image_height = full_page_height - caption_gap - caption_height - PDF_ROW_GAP;
    if max_image_height <= 0.0 {
        return Err("A PDF attachment caption is too tall to fit on an A4 page.".to_string());
    }
    let mut width = attachment.display_width as f32 * PDF_CSS_PIXEL_POINTS;
    let mut height = width * intrinsic_height as f32 / intrinsic_width as f32;
    let scale = (max_width / width).min(max_image_height / height).min(1.0);
    width *= scale;
    height *= scale;
    let marker_line = marker.map(|marker| PdfPreparedLine {
        text: format!("[{marker}]"),
        x: marker_x,
        size: PDF_ROW_SIZE,
        line_height: PDF_ROW_LINE_HEIGHT,
        tone: PdfTextTone::Primary,
    });
    let primary_height = marker_line
        .as_ref()
        .map_or(height, |line| height.max(line.line_height));
    let block_height = primary_height + caption_gap + caption_height + PDF_ROW_GAP;

    Ok(PdfPreparedImage {
        attachment_id: attachment.id.clone(),
        original_name: attachment.original_name.clone(),
        mime_type: attachment.mime_type.clone(),
        payload_key: ExportPayloadKey {
            relative_path: attachment.relative_path.clone(),
            content_hash: attachment.content_hash.clone(),
        },
        bytes: attachment
            .bytes
            .clone()
            .ok_or_else(|| "Notes export attachment bytes were not validated.".to_string())?,
        intrinsic_width,
        intrinsic_height,
        x,
        width,
        height,
        marker_line,
        primary_height,
        caption_lines,
        block_height,
    })
}

fn prepare_pdf_blocks(
    font: &ParsedFont,
    node: &ExportNode,
    depth: usize,
    full_page_height: f32,
    blocks: &mut Vec<PdfPreparedBlock>,
) -> Result<(), String> {
    match node.node_kind {
        NoteNodeKind::Text => {
            blocks.push(PdfPreparedBlock::Row(prepare_pdf_row(font, node, depth)?));
            for attachment in &node.attachments {
                blocks.push(PdfPreparedBlock::Image(prepare_pdf_image(
                    font,
                    attachment,
                    depth,
                    full_page_height,
                    None,
                    Some(PdfImageSupportingContent {
                        text: normalize_attachment_presentation(&attachment.original_name),
                        size: PDF_IMAGE_CAPTION_SIZE,
                        line_height: PDF_IMAGE_CAPTION_LINE_HEIGHT,
                    }),
                )?));
            }
        }
        NoteNodeKind::Image => {
            let description = if node.note.is_empty() {
                None
            } else {
                let display_note =
                    format_date_matches_for_pdf_display(&node.note, &node.note_date_spans)?;
                Some(PdfImageSupportingContent {
                    text: normalize_newlines(&display_note)
                        .split('\n')
                        .map(|line| {
                            if line.is_empty() {
                                ">".to_string()
                            } else {
                                format!("> {line}")
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("\n"),
                    size: PDF_NOTE_SIZE,
                    line_height: PDF_NOTE_LINE_HEIGHT,
                })
            };
            blocks.push(PdfPreparedBlock::Image(prepare_pdf_image(
                font,
                node.attachments
                    .first()
                    .expect("validated image node has one attachment"),
                depth,
                full_page_height,
                Some(if node.completed { 'x' } else { ' ' }),
                description,
            )?));
        }
    }
    for child in &node.children {
        prepare_pdf_blocks(font, child, depth + 1, full_page_height, blocks)?;
    }
    Ok(())
}

fn place_pdf_lines(page: &mut PdfPageDraft, lines: Vec<PdfPreparedLine>, mut top: f32) {
    for line in lines {
        let y = top - line.size;
        page.lines.push(PdfPlacedLine {
            text: line.text,
            x: line.x,
            y,
            size: line.size,
            line_height: line.line_height,
            tone: line.tone,
        });
        top -= line.line_height;
    }
}

fn pdf_text_color(tone: PdfTextTone) -> Color {
    let percent = match tone {
        PdfTextTone::Primary => 0.12,
        PdfTextTone::Supporting => 0.48,
    };
    Color::Greyscale(Greyscale::new(percent, None))
}

fn append_pdf_text_op(ops: &mut Vec<Op>, font_id: &FontId, line: PdfPlacedLine) {
    ops.extend([
        Op::StartTextSection,
        Op::SetTextCursor {
            pos: Point {
                x: Pt(line.x),
                y: Pt(line.y),
            },
        },
        Op::SetFont {
            font: PdfFontHandle::External(font_id.clone()),
            size: Pt(line.size),
        },
        Op::SetLineHeight {
            lh: Pt(line.line_height),
        },
        Op::SetFillColor {
            col: pdf_text_color(line.tone),
        },
        Op::ShowText {
            items: vec![TextItem::Text(line.text)],
        },
        Op::EndTextSection,
    ]);
}

fn pdf_image_alt_properties(original_name: &str) -> DictItem {
    let original_name = normalize_attachment_presentation(original_name);
    DictItem::Dict {
        map: BTreeMap::from([(
            "Alt".to_string(),
            DictItem::from_lopdf(&lopdf::text_string(&original_name)),
        )]),
    }
}

fn build_pdf_pages(
    font: &ParsedFont,
    snapshot: &NotesExportSnapshot,
) -> Result<Vec<PdfPageDraft>, String> {
    let margin_x = millimeters_to_points(PDF_MARGIN_X_MM);
    let page_height = millimeters_to_points(PDF_PAGE_HEIGHT_MM);
    let content_top = page_height - millimeters_to_points(PDF_MARGIN_TOP_MM);
    let content_bottom = millimeters_to_points(PDF_MARGIN_BOTTOM_MM + PDF_FOOTER_RESERVE_MM);
    let body_width = millimeters_to_points(PDF_PAGE_WIDTH_MM - PDF_MARGIN_X_MM * 2.0);
    let title_lines = if snapshot.root.node_kind == NoteNodeKind::Text {
        let display_title =
            format_date_matches_for_pdf_display(&snapshot.title, &snapshot.root.title_date_spans)?;
        wrap_pdf_text(font, &display_title, PDF_TITLE_SIZE, body_width)?
            .into_iter()
            .map(|text| PdfPreparedLine {
                text,
                x: margin_x,
                size: PDF_TITLE_SIZE,
                line_height: PDF_TITLE_LINE_HEIGHT,
                tone: PdfTextTone::Primary,
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let title_height = if title_lines.is_empty() {
        0.0
    } else {
        title_lines.len() as f32 * PDF_TITLE_LINE_HEIGHT + PDF_TITLE_GAP
    };
    if title_height > content_top - content_bottom {
        return Err("PDF title is too tall to fit on an A4 page.".to_string());
    }

    let full_page_height = content_top - content_bottom;
    let mut blocks = Vec::new();
    prepare_pdf_blocks(font, &snapshot.root, 0, full_page_height, &mut blocks)?;
    let mut pages = vec![PdfPageDraft::default()];
    place_pdf_lines(&mut pages[0], title_lines, content_top);
    let mut cursor_top = content_top - title_height;

    for block in blocks {
        match block {
            PdfPreparedBlock::Row(row) => {
                if row.height > full_page_height {
                    return Err("A PDF outline row is too tall to fit on an A4 page.".to_string());
                }
                if cursor_top - row.height < content_bottom {
                    pages.push(PdfPageDraft::default());
                    cursor_top = content_top;
                }
                let row_height = row.height;
                place_pdf_lines(
                    pages.last_mut().expect("PDF page exists"),
                    row.lines,
                    cursor_top,
                );
                cursor_top -= row_height;
            }
            PdfPreparedBlock::Image(image) => {
                if image.block_height > full_page_height + f32::EPSILON {
                    return Err("A PDF attachment is too tall to fit on an A4 page.".to_string());
                }
                if cursor_top - image.block_height < content_bottom {
                    pages.push(PdfPageDraft::default());
                    cursor_top = content_top;
                }
                let image_y = cursor_top - image.height;
                let caption_gap = if image.caption_lines.is_empty() {
                    0.0
                } else {
                    PDF_IMAGE_CAPTION_GAP
                };
                let caption_top = cursor_top - image.primary_height - caption_gap;
                let block_height = image.block_height;
                let marker_line = image.marker_line;
                let caption_lines = image.caption_lines;
                let page = pages.last_mut().expect("PDF page exists");
                page.images.push(PdfPlacedImage {
                    attachment_id: image.attachment_id,
                    original_name: image.original_name,
                    mime_type: image.mime_type,
                    payload_key: image.payload_key,
                    bytes: image.bytes,
                    intrinsic_width: image.intrinsic_width,
                    intrinsic_height: image.intrinsic_height,
                    x: image.x,
                    y: image_y,
                    width: image.width,
                    height: image.height,
                });
                if let Some(marker_line) = marker_line {
                    place_pdf_lines(page, vec![marker_line], cursor_top);
                }
                place_pdf_lines(page, caption_lines, caption_top);
                cursor_top -= block_height;
            }
        }
    }

    let page_count = pages.len();
    let footer_y = millimeters_to_points(10.0);
    for (index, page) in pages.iter_mut().enumerate() {
        let text = format!("Page {} / {page_count}", index + 1);
        let footer_width = pdf_text_width(font, &text, PDF_FOOTER_SIZE)?;
        let footer_x = (millimeters_to_points(PDF_PAGE_WIDTH_MM) - footer_width) / 2.0;
        page.lines.push(PdfPlacedLine {
            text,
            x: footer_x,
            y: footer_y,
            size: PDF_FOOTER_SIZE,
            line_height: PDF_FOOTER_SIZE,
            tone: PdfTextTone::Supporting,
        });
    }

    Ok(pages)
}

fn validate_serialized_pdf(bytes: &[u8], expected_page_count: usize) -> Result<(), String> {
    if !bytes.starts_with(b"%PDF-") || !bytes.windows(5).any(|window| window == b"%%EOF") {
        return Err("PDF serialization returned an invalid document.".to_string());
    }

    let parsed = lopdf::Document::load_mem(bytes)
        .map_err(|error| format!("Generated PDF could not be parsed: {error}"))?;
    if parsed.get_pages().len() != expected_page_count {
        return Err("Generated PDF page count changed during serialization.".to_string());
    }

    Ok(())
}

fn decode_pdf_attachment_rgba(bytes: &[u8], mime_type: &str) -> Result<RgbaImage, String> {
    let first_frame = |mut frames: image::Frames<'_>, format: &str| {
        frames
            .next()
            .ok_or_else(|| format!("A PDF attachment {format} contains no animation frames."))?
            .map(|frame| frame.into_buffer())
            .map_err(|error| {
                format!("Could not decode the first PDF attachment {format} frame: {error}")
            })
    };

    match mime_type {
        "image/gif" => {
            let decoder = GifDecoder::new(Cursor::new(bytes)).map_err(|error| {
                format!("Could not open the PDF attachment GIF decoder: {error}")
            })?;
            first_frame(decoder.into_frames(), "GIF")
        }
        "image/webp" => {
            let decoder = WebPDecoder::new(Cursor::new(bytes)).map_err(|error| {
                format!("Could not open the PDF attachment WebP decoder: {error}")
            })?;
            if decoder.has_animation() {
                first_frame(decoder.into_frames(), "WebP")
            } else {
                image::load_from_memory(bytes)
                    .map(|decoded| decoded.into_rgba8())
                    .map_err(|error| {
                        format!("Could not decode a PDF attachment WebP image: {error}")
                    })
            }
        }
        "image/png" | "image/jpeg" => image::load_from_memory(bytes)
            .map(|decoded| decoded.into_rgba8())
            .map_err(|error| format!("Could not decode a PDF attachment image: {error}")),
        _ => Err("A PDF attachment image has an unsupported MIME type.".to_string()),
    }
}

pub(crate) fn render_pdf(snapshot: &NotesExportSnapshot) -> Result<Vec<u8>, String> {
    validate_note_id(&snapshot.root_node_id)?;
    snapshot.root.validate_attachment_ownership()?;
    validate_export_node_ids(&snapshot.root)?;
    validate_pdf_attachment_working_budget(snapshot, MAX_PDF_ATTACHMENT_WORKING_BYTES)?;

    let mut font_warnings = Vec::new();
    let font = ParsedFont::from_bytes(PDF_FONT_BYTES, 0, &mut font_warnings)
        .ok_or_else(|| format!("Bundled PDF font could not be parsed: {font_warnings:?}"))?;
    let page_drafts = build_pdf_pages(&font, snapshot)?;
    let expected_page_count = page_drafts.len();
    let mut document = PdfDocument::new(&snapshot.title);
    let font_id = document.add_font(&font);
    let mut image_ids: HashMap<ExportPayloadKey, printpdf::XObjectId> = HashMap::new();
    let mut pages = Vec::with_capacity(page_drafts.len());
    for page in page_drafts {
        let mut ops = Vec::new();
        for image in page.images {
            let image_id = if let Some(image_id) = image_ids.get(&image.payload_key) {
                image_id.clone()
            } else {
                let rgba = decode_pdf_attachment_rgba(&image.bytes, &image.mime_type)?;
                if rgba.width() as usize != image.intrinsic_width
                    || rgba.height() as usize != image.intrinsic_height
                {
                    return Err(
                        "A PDF attachment image no longer matches its snapshot dimensions."
                            .to_string(),
                    );
                }
                let raw = RawImage {
                    pixels: RawImageData::U8(rgba.into_raw()),
                    width: image.intrinsic_width,
                    height: image.intrinsic_height,
                    data_format: RawImageFormat::RGBA8,
                    tag: image.attachment_id.into_bytes(),
                };
                let image_id = XObjectId::new();
                document
                    .resources
                    .xobjects
                    .map
                    .insert(image_id.clone(), XObject::Image(raw));
                image_ids.insert(image.payload_key, image_id.clone());
                image_id
            };
            ops.push(Op::BeginMarkedContentWithProperties {
                tag: "Span".to_string(),
                properties: pdf_image_alt_properties(&image.original_name),
            });
            ops.push(Op::UseXobject {
                id: image_id,
                transform: XObjectTransform {
                    translate_x: Some(Pt(image.x)),
                    translate_y: Some(Pt(image.y)),
                    scale_x: Some(image.width / image.intrinsic_width as f32),
                    scale_y: Some(image.height / image.intrinsic_height as f32),
                    dpi: Some(72.0),
                    ..XObjectTransform::default()
                },
            });
            ops.push(Op::EndMarkedContent);
        }
        for line in page.lines {
            append_pdf_text_op(&mut ops, &font_id, line);
        }
        pages.push(PdfPage::new(
            Mm(PDF_PAGE_WIDTH_MM),
            Mm(PDF_PAGE_HEIGHT_MM),
            ops,
        ));
    }
    document.with_pages(pages);

    let mut save_warnings = Vec::new();
    let mut serialized = document.to_lopdf_document(&PdfSaveOptions::default(), &mut save_warnings);
    serialized.version = PDF_DOCUMENT_VERSION.to_string();
    let mut bytes = Vec::new();
    serialized
        .save_to(&mut bytes)
        .map_err(|error| format!("Could not serialize the Notes PDF: {error}"))?;
    if save_warnings
        .iter()
        .any(|warning| warning.severity == PdfParseErrorSeverity::Error)
    {
        return Err(format!(
            "PDF serialization reported errors: {save_warnings:?}"
        ));
    }
    validate_serialized_pdf(&bytes, expected_page_count)?;

    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::{
        build_pdf_pages, classify_export_directory_sync, decode_pdf_attachment_rgba,
        format_date_matches_for_pdf_display, format_date_matches_for_pdf_display_with_work,
        hydrate_export_attachments, hydrate_export_attachments_with_budget,
        inject_export_parent_sync_failure_once, inject_markdown_asset_destination_swap_once,
        inject_markdown_asset_marker_identity_race_once, inject_markdown_commit_race_once,
        inject_markdown_overwrite_displacement_race_once,
        inject_markdown_post_asset_publication_swap_once,
        inject_markdown_post_stage_validation_cleanup_race_once,
        inject_markdown_pre_asset_backup_slot_race_once,
        inject_markdown_pre_document_backup_slot_race_once,
        inject_markdown_pre_document_publication_asset_swap_once,
        inject_markdown_pre_document_rollback_race_once,
        inject_markdown_pre_stage_cleanup_race_once,
        inject_markdown_rollback_inspection_failure_once, load_export_snapshot,
        prepare_markdown_export, publish_markdown_export, render_markdown, render_pdf,
        sync_export_directory, validate_pdf_attachment_working_budget, validate_serialized_pdf,
        ExportAttachmentBudget, EXPORT_ASSET_MARKER_CREATED_BY, EXPORT_ASSET_MARKER_NAME,
        EXPORT_ASSET_MARKER_VERSION, FOREIGN_EXPORT_ASSET_DIR_MESSAGE, PDF_FONT_BYTES,
        PDF_MARGIN_BOTTOM_MM, PDF_MARGIN_TOP_MM, PDF_PAGE_HEIGHT_MM,
    };
    use crate::notes::types::{
        ExportAttachment, ExportDateSpan, ExportNode, NoteNodeKind, NotesExportSnapshot,
    };
    use image::codecs::gif::GifEncoder;
    use image::{DynamicImage, Frame, ImageFormat, Rgba, RgbaImage};
    use printpdf::{Mm, Op, ParsedFont, PdfDocument, PdfPage, PdfParseOptions, Pt, TextItem};
    use rusqlite::{params, Connection};
    use std::collections::{BTreeMap, BTreeSet};
    use std::io::Cursor;
    use std::sync::Arc;

    const ROOT_ID: &str = "11111111-1111-4111-8111-111111111111";
    const FIRST_ID: &str = "22222222-2222-4222-8222-222222222222";
    const SECOND_ID: &str = "33333333-3333-4333-8333-333333333333";
    const LATER_ID: &str = "44444444-4444-4444-8444-444444444444";
    const DELETED_ID: &str = "55555555-5555-4555-8555-555555555555";
    const COLLAPSED_CHILD_ID: &str = "66666666-6666-4666-8666-666666666666";
    const INVALID_DESCENDANT_ID: &str = "bad -->\n# injected";

    fn export_node(
        id: &str,
        title: &str,
        note: &str,
        completed: bool,
        children: Vec<ExportNode>,
    ) -> ExportNode {
        ExportNode {
            id: id.to_string(),
            node_kind: NoteNodeKind::Text,
            title: title.to_string(),
            note: note.to_string(),
            title_date_spans: Vec::new(),
            note_date_spans: Vec::new(),
            completed,
            attachments: Vec::new(),
            children,
        }
    }

    fn image_node(
        id: &str,
        title: &str,
        note: &str,
        completed: bool,
        attachment: ExportAttachment,
        children: Vec<ExportNode>,
    ) -> ExportNode {
        let mut node = export_node(id, title, note, completed, children);
        node.node_kind = NoteNodeKind::Image;
        node.attachments.push(attachment);
        node
    }

    fn snapshot(root: ExportNode) -> NotesExportSnapshot {
        NotesExportSnapshot {
            root_node_id: root.id.clone(),
            title: root.title.clone(),
            exported_at: "2026-07-10T12:34:56.789Z".to_string(),
            root,
        }
    }

    fn export_attachment(
        id: &str,
        original_name: &str,
        bytes: Option<Vec<u8>>,
    ) -> ExportAttachment {
        ExportAttachment {
            id: id.to_string(),
            relative_path: format!("notes-assets/{}.png", "a".repeat(64)),
            content_hash: "a".repeat(64),
            original_name: original_name.to_string(),
            mime_type: "image/png".to_string(),
            byte_size: 3,
            intrinsic_width: 1,
            intrinsic_height: 1,
            display_width: 1,
            bytes: bytes.map(Arc::<[u8]>::from),
        }
    }

    fn distinct_export_attachment(
        id: &str,
        original_name: &str,
        content_hash: &str,
        bytes: Vec<u8>,
    ) -> ExportAttachment {
        let byte_size = bytes.len() as i64;
        ExportAttachment {
            relative_path: format!("notes-assets/{content_hash}.png"),
            content_hash: content_hash.to_string(),
            byte_size,
            ..export_attachment(id, original_name, Some(bytes))
        }
    }

    #[derive(Debug, PartialEq, Eq)]
    struct ParsedNativeMarkdownImage {
        source: String,
        alt: String,
        title: Option<String>,
    }

    fn decode_commonmark_entity(reference: &str) -> Option<String> {
        match reference {
            "&amp;" => Some("&".to_string()),
            "&apos;" => Some("'".to_string()),
            "&gt;" => Some(">".to_string()),
            "&lt;" => Some("<".to_string()),
            "&quot;" => Some("\"".to_string()),
            _ => {
                let digits = reference.strip_prefix("&#")?.strip_suffix(';')?;
                let hexadecimal = digits
                    .strip_prefix('x')
                    .or_else(|| digits.strip_prefix('X'));
                let (radix, digits) = hexadecimal.map_or((10, digits), |digits| (16, digits));
                char::from_u32(u32::from_str_radix(digits, radix).ok()?)
                    .map(|value| value.to_string())
            }
        }
    }

    fn parse_native_markdown_image(source: &str) -> ParsedNativeMarkdownImage {
        let image = source.strip_prefix("![").expect("native image opener");
        let (alt, image) = image.split_once("](").expect("native image alt");
        let image = image.strip_suffix(')').expect("native image closer");
        let Some((destination, title)) = image.split_once(" \"") else {
            return ParsedNativeMarkdownImage {
                source: image.to_string(),
                alt: alt.to_string(),
                title: None,
            };
        };
        let title_and_close = title.strip_suffix('"').expect("image title closer");
        let mut title = String::new();
        let mut index = 0;
        while index < title_and_close.len() {
            let character = title_and_close[index..]
                .chars()
                .next()
                .expect("title character");
            if character == '\\' {
                index += character.len_utf8();
                let escaped = title_and_close[index..]
                    .chars()
                    .next()
                    .expect("escaped title character");
                if escaped.is_ascii_punctuation() {
                    title.push(escaped);
                    index += escaped.len_utf8();
                    continue;
                }
                title.push(character);
                continue;
            }
            if character == '&' {
                if let Some(end) = title_and_close[index..].find(';') {
                    let reference = &title_and_close[index..index + end + 1];
                    if let Some(decoded) = decode_commonmark_entity(reference) {
                        title.push_str(&decoded);
                        index += end + 1;
                        continue;
                    }
                }
            }
            title.push(character);
            index += character.len_utf8();
        }
        ParsedNativeMarkdownImage {
            source: destination.to_string(),
            alt: alt.to_string(),
            title: Some(title),
        }
    }

    fn parse_exported_native_image(markdown: &[u8]) -> ParsedNativeMarkdownImage {
        let source = std::str::from_utf8(markdown).expect("UTF-8 Markdown");
        let line = source
            .lines()
            .find(|line| line.contains("![Image]("))
            .expect("native image-node line");
        let start = line.find("![Image](").expect("native image start");
        let end = line[start..]
            .find(") <!--")
            .map(|end| start + end + 1)
            .expect("image-node metadata comment");
        parse_native_markdown_image(&line[start..end])
    }

    fn decode_percent_encoded_metadata(value: &str) -> String {
        let mut decoded = Vec::with_capacity(value.len());
        let mut bytes = value.as_bytes().iter().copied();
        while let Some(byte) = bytes.next() {
            if byte == b'%' {
                let high = bytes.next().expect("percent-encoded high nibble");
                let low = bytes.next().expect("percent-encoded low nibble");
                let digits = [high, low];
                decoded.push(
                    u8::from_str_radix(std::str::from_utf8(&digits).expect("ASCII hex"), 16)
                        .expect("hex byte"),
                );
            } else {
                decoded.push(byte);
            }
        }
        String::from_utf8(decoded).expect("UTF-8 attachment metadata")
    }

    fn exported_markdown_original_name(markdown: &[u8]) -> String {
        const PREFIX: &str = "<!-- yonalist-attachment-original-name: ";
        let source = std::str::from_utf8(markdown).expect("UTF-8 Markdown");
        let encoded = source
            .split_once(PREFIX)
            .expect("attachment metadata opener")
            .1
            .split_once(" -->")
            .expect("attachment metadata closer")
            .0;
        decode_percent_encoded_metadata(encoded)
    }

    fn read_export_asset_marker(assets: &std::path::Path) -> serde_json::Value {
        let bytes =
            std::fs::read(assets.join(EXPORT_ASSET_MARKER_NAME)).expect("read export asset marker");
        serde_json::from_slice(&bytes).expect("parse export asset marker")
    }

    fn write_export_asset_marker(assets: &std::path::Path, files: &[&str], created_by: &str) {
        let marker = serde_json::json!({
            "createdBy": created_by,
            "version": 1,
            "files": files,
        });
        std::fs::write(
            assets.join(EXPORT_ASSET_MARKER_NAME),
            serde_json::to_vec(&marker).expect("serialize test marker"),
        )
        .expect("write test marker");
    }

    fn encoded_png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width, height);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().expect("PNG header");
            writer
                .write_image_data(&vec![0x77; width as usize * height as usize * 3])
                .expect("PNG pixels");
        }
        bytes
    }

    fn png_export_attachment(
        id: &str,
        original_name: &str,
        width: u32,
        height: u32,
    ) -> ExportAttachment {
        let bytes = encoded_png(width, height);
        let mut attachment = export_attachment(id, original_name, Some(bytes));
        attachment.byte_size = attachment.bytes.as_ref().expect("PNG bytes").len() as i64;
        attachment.intrinsic_width = i64::from(width);
        attachment.intrinsic_height = i64::from(height);
        attachment.display_width = i64::from(width);
        attachment
    }

    fn encoded_animated_gif() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = GifEncoder::new(&mut bytes);
            for color in [
                Rgba([0xe1, 0x12, 0x23, 0xff]),
                Rgba([0x14, 0x25, 0xe2, 0xff]),
            ] {
                encoder
                    .encode_frame(Frame::new(RgbaImage::from_pixel(2, 3, color)))
                    .expect("encode animated GIF frame");
            }
        }
        bytes
    }

    fn encoded_webp_frame(color: Rgba<u8>) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(2, 3, color))
            .write_to(&mut bytes, ImageFormat::WebP)
            .expect("encode WebP frame");
        bytes.into_inner()
    }

    fn push_webp_chunk(output: &mut Vec<u8>, kind: &[u8; 4], payload: &[u8]) {
        output.extend_from_slice(kind);
        output.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        output.extend_from_slice(payload);
        if payload.len() % 2 != 0 {
            output.push(0);
        }
    }

    fn encoded_animated_webp() -> Vec<u8> {
        let mut chunks = Vec::new();
        push_webp_chunk(&mut chunks, b"VP8X", &[0x02, 0, 0, 0, 1, 0, 0, 2, 0, 0]);
        push_webp_chunk(&mut chunks, b"ANIM", &[0, 0, 0, 0, 0, 0]);
        for (duration, color) in [
            (10_u8, Rgba([0xd2, 0x21, 0x32, 0xff])),
            (20_u8, Rgba([0x23, 0x34, 0xd3, 0xff])),
        ] {
            let encoded = encoded_webp_frame(color);
            let mut frame = vec![0_u8; 16];
            frame[6] = 1;
            frame[9] = 2;
            frame[12] = duration;
            frame.extend_from_slice(&encoded[12..]);
            push_webp_chunk(&mut chunks, b"ANMF", &frame);
        }
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&((4 + chunks.len()) as u32).to_le_bytes());
        bytes.extend_from_slice(b"WEBP");
        bytes.extend_from_slice(&chunks);
        bytes
    }

    fn korean_snapshot() -> NotesExportSnapshot {
        snapshot(export_node(
            ROOT_ID,
            "프로젝트 · Project 2026",
            "한글 메모 “Korean note”",
            false,
            vec![export_node(
                FIRST_ID,
                "완료 작업 - ASCII 42",
                "지원 설명… supporting detail!",
                true,
                Vec::new(),
            )],
        ))
    }

    fn parse_pdf(bytes: &[u8]) -> PdfDocument {
        let mut warnings = Vec::new();
        PdfDocument::parse(bytes, &PdfParseOptions::default(), &mut warnings)
            .expect("parse rendered PDF")
    }

    fn hydrate_parsed_glyph_cids(document: &mut PdfDocument) {
        let used_glyphs = document
            .pages
            .iter()
            .flat_map(|page| &page.ops)
            .filter_map(|op| match op {
                Op::ShowText { items } => Some(items),
                _ => None,
            })
            .flat_map(|items| items)
            .filter_map(|item| match item {
                TextItem::GlyphIds(glyphs) => Some(glyphs),
                _ => None,
            })
            .flat_map(|glyphs| glyphs.iter().map(|glyph| glyph.gid))
            .collect::<BTreeSet<_>>();
        let parsed_font = &document
            .resources
            .fonts
            .map
            .values()
            .next()
            .expect("parsed PDF font")
            .parsed_font;
        let mut glyph_text = BTreeMap::new();
        for codepoint in 0..=char::MAX as u32 {
            let Some(character) = char::from_u32(codepoint) else {
                continue;
            };
            let Some(glyph) = parsed_font.lookup_glyph_index(codepoint) else {
                continue;
            };
            if used_glyphs.contains(&glyph) {
                glyph_text.entry(glyph).or_insert(character);
                if glyph_text.len() == used_glyphs.len() {
                    break;
                }
            }
        }
        assert_eq!(glyph_text.len(), used_glyphs.len());

        for page in &mut document.pages {
            for op in &mut page.ops {
                let Op::ShowText { items } = op else {
                    continue;
                };
                for item in items {
                    let TextItem::GlyphIds(glyphs) = item else {
                        continue;
                    };
                    for glyph in glyphs {
                        glyph.cid = glyph_text
                            .get(&glyph.gid)
                            .map(|character| character.to_string());
                    }
                }
            }
        }
    }

    fn extracted_pdf_pages(document: &mut PdfDocument) -> Vec<String> {
        // printpdf 0.9.1 currently drops ToUnicode while parsing and otherwise
        // reverse-scans the entire BMP for every glyph during extraction.
        hydrate_parsed_glyph_cids(document);
        document
            .extract_text()
            .into_iter()
            .map(|chunks| chunks.join(" "))
            .collect()
    }

    fn serialized_pdf_image_xobject_count(bytes: &[u8]) -> usize {
        let structural = lopdf::Document::load_mem(bytes).expect("parse PDF structure");
        structural
            .objects
            .values()
            .filter(|object| {
                object
                    .as_stream()
                    .ok()
                    .and_then(|stream| stream.dict.get(b"Subtype").ok())
                    .and_then(|subtype| subtype.as_name().ok())
                    == Some(&b"Image"[..])
            })
            .count()
    }

    fn parsed_pdf_image_use_count(bytes: &[u8]) -> usize {
        parse_pdf(bytes)
            .pages
            .iter()
            .flat_map(|page| &page.ops)
            .filter(|op| matches!(op, Op::UseXobject { .. }))
            .count()
    }

    fn serialized_pdf_image_alt_texts(bytes: &[u8]) -> Vec<String> {
        let document = lopdf::Document::load_mem(bytes).expect("parse PDF structure");
        let mut alt_texts = Vec::new();
        for page_id in document.get_pages().into_values() {
            let content = document
                .get_and_decode_page_content(page_id)
                .expect("decode PDF page content");
            let mut active_alt = None;
            for operation in content.operations {
                match operation.operator.as_str() {
                    "BDC" => {
                        active_alt = operation
                            .operands
                            .get(1)
                            .and_then(|properties| properties.as_dict().ok())
                            .and_then(|properties| properties.get(b"Alt").ok())
                            .map(|alt| {
                                lopdf::decode_text_string(alt).expect("decode image alternate text")
                            });
                    }
                    "Do" => {
                        if let Some(alt) = active_alt.take() {
                            alt_texts.push(alt);
                        }
                    }
                    "EMC" => active_alt = None,
                    _ => {}
                }
            }
        }
        alt_texts
    }

    fn pdf_content_bounds() -> (f32, f32, f32, f32) {
        let left = super::millimeters_to_points(super::PDF_MARGIN_X_MM);
        let right = super::millimeters_to_points(super::PDF_PAGE_WIDTH_MM - super::PDF_MARGIN_X_MM);
        let bottom =
            super::millimeters_to_points(PDF_MARGIN_BOTTOM_MM + super::PDF_FOOTER_RESERVE_MM);
        let top = super::millimeters_to_points(PDF_PAGE_HEIGHT_MM - PDF_MARGIN_TOP_MM);
        (left, right, bottom, top)
    }

    fn initialize_export_connection(connection: &Connection) {
        connection
            .execute_batch(
                "CREATE TABLE notes_nodes (\
                   id TEXT PRIMARY KEY,\
                   parent_id TEXT,\
                   sort_key INTEGER NOT NULL,\
                   title TEXT NOT NULL,\
                   note TEXT NOT NULL,\
                   node_kind TEXT NOT NULL DEFAULT 'text' CHECK (node_kind IN ('text', 'image')),\
                   is_collapsed INTEGER NOT NULL DEFAULT 0,\
                   completed_at TEXT,\
                   deleted_at TEXT,\
                   archived_at TEXT\
                );
                 CREATE TABLE notes_dates (
                   node_id TEXT NOT NULL,
                   field TEXT NOT NULL,
                   start_utf16 INTEGER NOT NULL,
                   end_utf16 INTEGER NOT NULL,
                   normalized_start TEXT NOT NULL,
                   normalized_end TEXT NOT NULL,
                   token_text TEXT NOT NULL
                 );
                 CREATE TABLE notes_attachments (
                   id TEXT PRIMARY KEY,
                   node_id TEXT NOT NULL,
                   sort_key INTEGER NOT NULL,
                   relative_path TEXT NOT NULL,
                   content_hash TEXT NOT NULL,
                   original_name TEXT NOT NULL,
                   mime_type TEXT NOT NULL,
                   byte_size INTEGER NOT NULL,
                   intrinsic_width INTEGER NOT NULL,
                   intrinsic_height INTEGER NOT NULL,
                   display_width INTEGER NOT NULL,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );",
            )
            .expect("create notes table");
    }

    fn export_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        initialize_export_connection(&connection);
        connection
    }

    struct SeedNode<'a> {
        id: &'a str,
        parent_id: Option<&'a str>,
        sort_key: i64,
        title: &'a str,
        note: &'a str,
        node_kind: NoteNodeKind,
        is_collapsed: bool,
        completed_at: Option<&'a str>,
        deleted_at: Option<&'a str>,
    }

    impl<'a> SeedNode<'a> {
        fn active(id: &'a str, parent_id: Option<&'a str>, sort_key: i64, title: &'a str) -> Self {
            Self {
                id,
                parent_id,
                sort_key,
                title,
                note: "",
                node_kind: NoteNodeKind::Text,
                is_collapsed: false,
                completed_at: None,
                deleted_at: None,
            }
        }
    }

    fn insert_node(connection: &Connection, node: SeedNode<'_>) {
        connection
            .execute(
                "INSERT INTO notes_nodes (\
                   id, parent_id, sort_key, title, note, node_kind, is_collapsed, completed_at, deleted_at\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    node.id,
                    node.parent_id,
                    node.sort_key,
                    node.title,
                    node.note,
                    node.node_kind.as_str(),
                    node.is_collapsed,
                    node.completed_at,
                    node.deleted_at
                ],
            )
            .expect("insert node");
    }

    fn insert_export_attachment_metadata(
        connection: &Connection,
        id: &str,
        node_id: &str,
        sort_key: i64,
        original_name: &str,
    ) {
        connection
            .execute(
                "INSERT INTO notes_attachments (
                   id, node_id, sort_key, relative_path, content_hash, original_name,
                   mime_type, byte_size, intrinsic_width, intrinsic_height, display_width,
                   created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'image/png', 3, 1, 1, 1,
                           '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')",
                params![
                    id,
                    node_id,
                    sort_key,
                    format!("notes-assets/{}.png", "a".repeat(64)),
                    "a".repeat(64),
                    original_name,
                ],
            )
            .expect("seed export attachment metadata");
    }

    fn insert_date_span(
        connection: &Connection,
        node_id: &str,
        field: &str,
        span: &ExportDateSpan,
        token_text: &str,
    ) {
        connection
            .execute(
                "INSERT INTO notes_dates (node_id, field, start_utf16, end_utf16, \
                   normalized_start, normalized_end, token_text) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    node_id,
                    field,
                    i64::try_from(span.start_utf16).expect("date span start offset"),
                    i64::try_from(span.end_utf16).expect("date span end offset"),
                    span.normalized_start.as_str(),
                    span.normalized_end.as_str(),
                    token_text
                ],
            )
            .expect("insert indexed export date");
    }

    fn seeded_export_connection() -> Connection {
        let connection = export_connection();
        insert_node(
            &connection,
            SeedNode {
                note: "Root note",
                is_collapsed: true,
                ..SeedNode::active(ROOT_ID, None, 1024, "Project")
            },
        );
        insert_node(
            &connection,
            SeedNode::active(SECOND_ID, Some(ROOT_ID), 1024, "Second by ID"),
        );
        insert_node(
            &connection,
            SeedNode {
                note: "Supporting note",
                is_collapsed: true,
                completed_at: Some("2026-07-10T00:00:00.000Z"),
                ..SeedNode::active(FIRST_ID, Some(ROOT_ID), 1024, "First task")
            },
        );
        insert_node(
            &connection,
            SeedNode::active(LATER_ID, Some(ROOT_ID), 2048, "Later task"),
        );
        insert_node(
            &connection,
            SeedNode {
                deleted_at: Some("2026-07-10T01:00:00.000Z"),
                ..SeedNode::active(DELETED_ID, Some(ROOT_ID), 512, "Deleted task")
            },
        );
        insert_node(
            &connection,
            SeedNode {
                note: "Still exported",
                ..SeedNode::active(COLLAPSED_CHILD_ID, Some(FIRST_ID), 1024, "Collapsed child")
            },
        );
        connection
    }

    fn total_changes(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT total_changes()", [], |row| row.get(0))
            .expect("read total changes")
    }

    #[test]
    fn export_snapshot_keeps_active_sibling_order_content_and_completion_state() {
        let connection = seeded_export_connection();
        let changes_before = total_changes(&connection);

        let snapshot = load_export_snapshot(&connection, ROOT_ID).expect("snapshot");

        assert_eq!(snapshot.root_node_id, ROOT_ID);
        assert_eq!(snapshot.title, "Project");
        assert_eq!(snapshot.root.id, ROOT_ID);
        assert_eq!(snapshot.root.title, "Project");
        assert_eq!(snapshot.root.note, "Root note");
        assert!(!snapshot.root.completed);
        assert!(snapshot.exported_at.ends_with('Z'));
        assert_eq!(
            snapshot
                .root
                .children
                .iter()
                .map(|child| child.title.as_str())
                .collect::<Vec<_>>(),
            vec!["First task", "Second by ID", "Later task"]
        );
        assert!(snapshot.root.children[0].completed);
        assert_eq!(snapshot.root.children[0].note, "Supporting note");
        assert_eq!(
            snapshot.root.children[0].children[0].title,
            "Collapsed child"
        );
        assert_eq!(total_changes(&connection), changes_before);
    }

    #[test]
    fn export_snapshot_threads_image_node_kind_and_owned_attachment() {
        let connection = export_connection();
        insert_node(
            &connection,
            SeedNode::active(ROOT_ID, None, 1024, "Project"),
        );
        insert_node(
            &connection,
            SeedNode {
                note: "Visible description",
                node_kind: NoteNodeKind::Image,
                ..SeedNode::active(FIRST_ID, Some(ROOT_ID), 1024, "hidden-file.png")
            },
        );
        insert_export_attachment_metadata(
            &connection,
            SECOND_ID,
            FIRST_ID,
            1024,
            "hidden-file.png",
        );

        let snapshot = load_export_snapshot(&connection, ROOT_ID).expect("image snapshot");
        let image = &snapshot.root.children[0];

        assert_eq!(snapshot.root.node_kind, NoteNodeKind::Text);
        assert_eq!(image.node_kind, NoteNodeKind::Image);
        assert_eq!(image.title, "hidden-file.png");
        assert_eq!(image.note, "Visible description");
        assert_eq!(image.attachments.len(), 1);
        assert_eq!(image.attachments[0].id, SECOND_ID);
    }

    #[test]
    fn export_snapshot_rejects_image_node_without_an_attachment() {
        let connection = export_connection();
        insert_node(
            &connection,
            SeedNode {
                node_kind: NoteNodeKind::Image,
                ..SeedNode::active(ROOT_ID, None, 1024, "missing.png")
            },
        );

        let error = load_export_snapshot(&connection, ROOT_ID)
            .expect_err("image node without attachment must be rejected");

        assert_eq!(
            error,
            format!(
                "Image Note node {ROOT_ID} must own exactly one attachment for export; found 0."
            )
        );
    }

    #[test]
    fn export_snapshot_rejects_image_node_with_multiple_attachments() {
        let connection = export_connection();
        insert_node(
            &connection,
            SeedNode {
                node_kind: NoteNodeKind::Image,
                ..SeedNode::active(ROOT_ID, None, 1024, "duplicate.png")
            },
        );
        insert_export_attachment_metadata(&connection, FIRST_ID, ROOT_ID, 1024, "first.png");
        insert_export_attachment_metadata(&connection, SECOND_ID, ROOT_ID, 2048, "second.png");

        let error = load_export_snapshot(&connection, ROOT_ID)
            .expect_err("image node with multiple attachments must be rejected");

        assert_eq!(
            error,
            format!(
                "Image Note node {ROOT_ID} must own exactly one attachment for export; found 2."
            )
        );
    }

    #[test]
    fn export_snapshot_keeps_attachment_metadata_in_deterministic_node_order() {
        let connection = export_connection();
        insert_node(
            &connection,
            SeedNode {
                id: ROOT_ID,
                parent_id: None,
                sort_key: 1024,
                title: "Project",
                note: "",
                node_kind: NoteNodeKind::Text,
                is_collapsed: false,
                completed_at: None,
                deleted_at: None,
            },
        );
        for (id, sort_key, original_name) in [
            (SECOND_ID, 2048, "same.png"),
            (FIRST_ID, 1024, "same.png"),
            (LATER_ID, 2048, "later.png"),
        ] {
            connection
                .execute(
                    "INSERT INTO notes_attachments (
                       id, node_id, sort_key, relative_path, content_hash, original_name,
                       mime_type, byte_size, intrinsic_width, intrinsic_height, display_width,
                       created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'image/png', 67, 1, 1, 1,
                               '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')",
                    params![
                        id,
                        ROOT_ID,
                        sort_key,
                        format!("notes-assets/{}.png", "a".repeat(64)),
                        "a".repeat(64),
                        original_name,
                    ],
                )
                .expect("seed export attachment");
        }

        let snapshot = load_export_snapshot(&connection, ROOT_ID).expect("attachment snapshot");

        assert_eq!(
            snapshot
                .root
                .attachments
                .iter()
                .map(|attachment| attachment.id.as_str())
                .collect::<Vec<_>>(),
            vec![FIRST_ID, SECOND_ID, LATER_ID]
        );
        assert!(snapshot
            .root
            .attachments
            .iter()
            .all(|attachment| attachment.bytes.is_none()));
    }

    #[test]
    fn notes_export_snapshot_rejects_attachment_metadata_above_the_count_budget() {
        let connection = export_connection();
        insert_node(
            &connection,
            SeedNode::active(ROOT_ID, None, 1024, "Many images"),
        );
        for index in 0..=512 {
            connection
                .execute(
                    "INSERT INTO notes_attachments (
                       id, node_id, sort_key, relative_path, content_hash, original_name,
                       mime_type, byte_size, intrinsic_width, intrinsic_height, display_width,
                       created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, 'duplicate.png', 'image/png', 3, 1, 1, 1,
                               '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')",
                    params![
                        format!("{index:08x}-0000-4000-8000-{index:012x}"),
                        ROOT_ID,
                        index,
                        format!("notes-assets/{}.png", "a".repeat(64)),
                        "a".repeat(64),
                    ],
                )
                .expect("seed attachment metadata");
        }

        let error = load_export_snapshot(&connection, ROOT_ID)
            .expect_err("attachment metadata count budget");

        assert_eq!(
            error,
            "Notes export must contain at most 512 image attachments."
        );
    }

    #[test]
    fn renderers_reject_attachment_metadata_without_validated_snapshot_bytes() {
        let mut snapshot = snapshot(export_node(ROOT_ID, "Project", "", false, Vec::new()));
        snapshot
            .root
            .attachments
            .push(export_attachment(FIRST_ID, "diagram.png", None));

        assert_eq!(
            render_markdown(&snapshot).expect_err("Markdown requires validated bytes"),
            "Notes export attachment bytes were not validated."
        );
        assert_eq!(
            render_pdf(&snapshot).expect_err("PDF requires validated bytes"),
            "Notes export attachment bytes were not validated."
        );
    }

    #[test]
    fn image_node_attachment_cardinality_is_rejected_before_hydration_or_rendering() {
        for found in [0, 2] {
            let mut root = image_node(
                ROOT_ID,
                "hidden.png",
                "Visible description",
                false,
                export_attachment(FIRST_ID, "hidden.png", Some(vec![1, 2, 3])),
                Vec::new(),
            );
            if found == 0 {
                root.attachments.clear();
            } else {
                root.attachments.push(export_attachment(
                    SECOND_ID,
                    "extra.png",
                    Some(vec![1, 2, 3]),
                ));
            }
            let expected = format!(
                "Image Note node {ROOT_ID} must own exactly one attachment for export; found {found}."
            );

            let mut hydration_snapshot = snapshot(root.clone());
            for attachment in &mut hydration_snapshot.root.attachments {
                attachment.bytes = None;
            }
            let mut reads = 0;
            let hydration_error = hydrate_export_attachments(&mut hydration_snapshot, |_| {
                reads += 1;
                Ok(vec![1, 2, 3])
            })
            .expect_err("invalid image ownership must fail before hydration");
            assert_eq!(hydration_error, expected);
            assert_eq!(reads, 0);

            let render_snapshot = snapshot(root);
            let markdown_error = match prepare_markdown_export(&render_snapshot, "image_assets") {
                Ok(_) => panic!("invalid image ownership must fail before Markdown preparation"),
                Err(error) => error,
            };
            assert_eq!(markdown_error, expected);
            assert_eq!(
                render_pdf(&render_snapshot)
                    .expect_err("invalid image ownership must fail before PDF rendering"),
                expected
            );
        }
    }

    #[test]
    fn nested_image_node_attachment_cardinality_is_rejected_before_hydration_or_rendering() {
        for found in [0, 2] {
            let mut nested = image_node(
                FIRST_ID,
                "nested-hidden.png",
                "Nested description",
                false,
                export_attachment(SECOND_ID, "nested-hidden.png", Some(vec![1, 2, 3])),
                Vec::new(),
            );
            if found == 0 {
                nested.attachments.clear();
            } else {
                nested.attachments.push(export_attachment(
                    LATER_ID,
                    "extra-nested.png",
                    Some(vec![1, 2, 3]),
                ));
            }
            let root = export_node(ROOT_ID, "Project", "", false, vec![nested]);
            let expected = format!(
                "Image Note node {FIRST_ID} must own exactly one attachment for export; found {found}."
            );

            let mut hydration_snapshot = snapshot(root.clone());
            for attachment in &mut hydration_snapshot.root.children[0].attachments {
                attachment.bytes = None;
            }
            let mut reads = 0;
            let hydration_error = hydrate_export_attachments(&mut hydration_snapshot, |_| {
                reads += 1;
                Ok(vec![1, 2, 3])
            })
            .expect_err("invalid nested image ownership must fail before hydration");
            assert_eq!(hydration_error, expected);
            assert_eq!(reads, 0);

            let render_snapshot = snapshot(root);
            assert_eq!(
                render_markdown(&render_snapshot)
                    .expect_err("invalid nested image ownership must fail before Markdown render"),
                expected
            );
            assert_eq!(
                match prepare_markdown_export(&render_snapshot, "nested_image_assets") {
                    Ok(_) => {
                        panic!("invalid nested image ownership must fail before Markdown export")
                    }
                    Err(error) => error,
                },
                expected
            );
            assert_eq!(
                render_pdf(&render_snapshot)
                    .expect_err("invalid nested image ownership must fail before PDF render"),
                expected
            );
        }
    }

    #[test]
    fn image_node_svg_remains_unsupported_in_markdown_and_pdf() {
        let mut attachment = export_attachment(
            FIRST_ID,
            "hidden-vector.svg",
            Some(b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec()),
        );
        attachment.mime_type = "image/svg+xml".to_string();
        attachment.relative_path = format!("notes-assets/{}.svg", "a".repeat(64));
        attachment.byte_size = attachment.bytes.as_ref().expect("SVG bytes").len() as i64;
        let snapshot = snapshot(image_node(
            ROOT_ID,
            "hidden-vector.svg",
            "Vector description",
            false,
            attachment,
            Vec::new(),
        ));

        let markdown_error = match prepare_markdown_export(&snapshot, "vector_assets") {
            Ok(_) => panic!("SVG Markdown export must stay unsupported"),
            Err(error) => error,
        };
        assert_eq!(
            markdown_error,
            "A Notes export attachment MIME type is unsupported."
        );
        assert_eq!(
            render_pdf(&snapshot).expect_err("SVG PDF export must stay unsupported"),
            "A PDF attachment image has an unsupported MIME type."
        );
    }

    #[test]
    fn attachment_hydration_is_all_or_nothing_and_preserves_snapshot_bytes() {
        let mut snapshot = snapshot(export_node(ROOT_ID, "Project", "", false, Vec::new()));
        let mut second = export_attachment(SECOND_ID, "second.png", None);
        second.content_hash = "b".repeat(64);
        second.relative_path = format!("notes-assets/{}.png", second.content_hash);
        snapshot.root.attachments = vec![export_attachment(FIRST_ID, "first.png", None), second];

        let error = hydrate_export_attachments(&mut snapshot, |attachment| {
            if attachment.id == SECOND_ID {
                Err("missing attachment bytes".to_string())
            } else {
                Ok(vec![1, 2, 3])
            }
        })
        .expect_err("second attachment failure");

        assert_eq!(error, "missing attachment bytes");
        assert!(snapshot
            .root
            .attachments
            .iter()
            .all(|attachment| attachment.bytes.is_none()));

        let mut source = vec![7, 8, 9];
        hydrate_export_attachments(&mut snapshot, |_| Ok(source.clone()))
            .expect("hydrate immutable snapshot bytes");
        source.fill(0);

        assert!(snapshot
            .root
            .attachments
            .iter()
            .all(|attachment| attachment.bytes.as_deref() == Some(&[7, 8, 9][..])));
    }

    #[test]
    fn notes_export_attachment_budget_rejects_unique_encoded_bytes_before_any_read() {
        let mut snapshot = snapshot(export_node(ROOT_ID, "Project", "", false, Vec::new()));
        snapshot.root.attachments = (0..3)
            .map(|index| {
                let mut attachment = export_attachment(
                    &format!("{index:08x}-0000-4000-8000-{index:012x}"),
                    "budget.png",
                    None,
                );
                attachment.content_hash = format!("{index:064x}");
                attachment.relative_path = format!("notes-assets/{}.png", attachment.content_hash);
                attachment.byte_size = 4;
                attachment.intrinsic_width = 2;
                attachment.intrinsic_height = 2;
                attachment
            })
            .collect();
        let mut reads = 0;

        let error = hydrate_export_attachments_with_budget(
            &mut snapshot,
            ExportAttachmentBudget {
                max_attachments: 3,
                max_encoded_bytes: 8,
                max_decoded_pixels: 12,
            },
            |_| {
                reads += 1;
                Ok(vec![0; 4])
            },
        )
        .expect_err("aggregate encoded-byte budget");

        assert_eq!(
            error,
            "Notes export attachments exceed the 8 byte aggregate encoded-byte budget."
        );
        assert_eq!(reads, 0);
        assert!(snapshot
            .root
            .attachments
            .iter()
            .all(|attachment| attachment.bytes.is_none()));
    }

    #[test]
    fn notes_export_duplicate_payloads_share_one_read_and_one_budget_allocation() {
        let mut snapshot = snapshot(export_node(ROOT_ID, "Project", "", false, Vec::new()));
        snapshot.root.attachments = vec![
            export_attachment(FIRST_ID, "first.png", None),
            export_attachment(SECOND_ID, "second.png", None),
        ];
        let mut reads = 0;

        hydrate_export_attachments_with_budget(
            &mut snapshot,
            ExportAttachmentBudget {
                max_attachments: 2,
                max_encoded_bytes: 3,
                max_decoded_pixels: 1,
            },
            |_| {
                reads += 1;
                Ok(vec![7, 8, 9])
            },
        )
        .expect("deduplicated hydration");

        assert_eq!(reads, 1);
        let first = snapshot.root.attachments[0]
            .bytes
            .as_ref()
            .expect("first shared bytes");
        let second = snapshot.root.attachments[1]
            .bytes
            .as_ref()
            .expect("second shared bytes");
        assert!(std::sync::Arc::ptr_eq(first, second));
    }

    #[test]
    fn notes_export_markdown_preparation_reuses_prevalidated_payload_allocations() {
        let mut snapshot = snapshot(export_node(ROOT_ID, "Project", "", false, Vec::new()));
        snapshot.root.attachments = vec![
            export_attachment(FIRST_ID, "first.png", None),
            export_attachment(SECOND_ID, "second.png", None),
        ];
        hydrate_export_attachments_with_budget(
            &mut snapshot,
            ExportAttachmentBudget {
                max_attachments: 2,
                max_encoded_bytes: 3,
                max_decoded_pixels: 1,
            },
            |_| Ok(vec![7, 8, 9]),
        )
        .expect("hydrate shared payload");

        let prepared =
            prepare_markdown_export(&snapshot, "project_assets").expect("prepare Markdown");

        assert_eq!(prepared.assets.len(), 1);
        assert!(Arc::ptr_eq(
            &prepared.assets[0].bytes,
            snapshot.root.attachments[0]
                .bytes
                .as_ref()
                .expect("snapshot payload"),
        ));
        let markdown = std::str::from_utf8(&prepared.markdown).expect("UTF-8 Markdown");
        assert_eq!(markdown.matches("(project_assets/0001.png)").count(), 2);
    }

    #[test]
    fn markdown_export_preserves_original_animated_gif_and_webp_bytes() {
        for (id, name, mime_type, extension, bytes) in [
            (
                FIRST_ID,
                "animated.gif",
                "image/gif",
                "gif",
                encoded_animated_gif(),
            ),
            (
                SECOND_ID,
                "animated.webp",
                "image/webp",
                "webp",
                encoded_animated_webp(),
            ),
        ] {
            let mut attachment = export_attachment(id, name, Some(bytes.clone()));
            attachment.mime_type = mime_type.to_string();
            attachment.relative_path = format!("notes-assets/{}.{}", "a".repeat(64), extension);
            attachment.byte_size = bytes.len() as i64;
            attachment.intrinsic_width = 2;
            attachment.intrinsic_height = 3;
            attachment.display_width = 2;
            let mut root = export_node(ROOT_ID, "Animations", "", false, Vec::new());
            root.attachments.push(attachment);

            let prepared = prepare_markdown_export(&snapshot(root), "animations_assets")
                .unwrap_or_else(|error| panic!("prepare {name}: {error}"));

            assert_eq!(prepared.assets.len(), 1);
            assert_eq!(prepared.assets[0].bytes.as_ref(), bytes.as_slice());
            assert_eq!(prepared.assets[0].file_name, format!("0001.{extension}"));
        }
    }

    #[test]
    fn notes_export_attachment_budget_rejects_duplicate_placement_floods() {
        let mut snapshot = snapshot(export_node(ROOT_ID, "Project", "", false, Vec::new()));
        snapshot.root.attachments = vec![
            export_attachment(FIRST_ID, "first.png", None),
            export_attachment(SECOND_ID, "second.png", None),
            export_attachment(LATER_ID, "third.png", None),
        ];
        let mut reads = 0;

        let error = hydrate_export_attachments_with_budget(
            &mut snapshot,
            ExportAttachmentBudget {
                max_attachments: 2,
                max_encoded_bytes: 3,
                max_decoded_pixels: 1,
            },
            |_| {
                reads += 1;
                Ok(vec![7, 8, 9])
            },
        )
        .expect_err("attachment count budget");

        assert_eq!(
            error,
            "Notes export must contain at most 2 image attachments."
        );
        assert_eq!(reads, 0);
    }

    #[test]
    fn notes_export_attachment_budget_enforces_the_decoded_pixel_boundary() {
        let mut at_limit = snapshot(export_node(ROOT_ID, "Project", "", false, Vec::new()));
        let mut attachment = export_attachment(FIRST_ID, "six-pixels.png", None);
        attachment.intrinsic_width = 2;
        attachment.intrinsic_height = 3;
        at_limit.root.attachments.push(attachment.clone());
        hydrate_export_attachments_with_budget(
            &mut at_limit,
            ExportAttachmentBudget {
                max_attachments: 1,
                max_encoded_bytes: 3,
                max_decoded_pixels: 6,
            },
            |_| Ok(vec![7, 8, 9]),
        )
        .expect("decoded pixels exactly at budget");

        let mut over_limit = snapshot(export_node(ROOT_ID, "Project", "", false, Vec::new()));
        attachment.id = SECOND_ID.to_string();
        attachment.content_hash = "b".repeat(64);
        attachment.relative_path = format!("notes-assets/{}.png", attachment.content_hash);
        over_limit.root.attachments = vec![at_limit.root.attachments[0].clone(), attachment];
        for attachment in &mut over_limit.root.attachments {
            attachment.bytes = None;
        }
        let mut reads = 0;
        let error = hydrate_export_attachments_with_budget(
            &mut over_limit,
            ExportAttachmentBudget {
                max_attachments: 2,
                max_encoded_bytes: 6,
                max_decoded_pixels: 11,
            },
            |_| {
                reads += 1;
                Ok(vec![7, 8, 9])
            },
        )
        .expect_err("decoded pixels one over budget");

        assert_eq!(
            error,
            "Notes export attachments exceed the 11 decoded-pixel aggregate budget."
        );
        assert_eq!(reads, 0);
    }

    #[test]
    fn notes_export_rejects_conflicting_metadata_for_one_owned_payload() {
        let mut snapshot = snapshot(export_node(ROOT_ID, "Project", "", false, Vec::new()));
        let first = export_attachment(FIRST_ID, "first.png", None);
        let mut conflicting = export_attachment(SECOND_ID, "second.png", None);
        conflicting.intrinsic_width = 2;
        snapshot.root.attachments = vec![first, conflicting];
        let mut reads = 0;

        let error = hydrate_export_attachments_with_budget(
            &mut snapshot,
            ExportAttachmentBudget {
                max_attachments: 2,
                max_encoded_bytes: 6,
                max_decoded_pixels: 3,
            },
            |_| {
                reads += 1;
                Ok(vec![7, 8, 9])
            },
        )
        .expect_err("conflicting duplicate metadata");

        assert_eq!(
            error,
            "Notes export attachments for one owned payload have conflicting metadata."
        );
        assert_eq!(reads, 0);
    }

    #[test]
    fn notes_export_markdown_deduplicates_512_placements_of_one_large_payload() {
        const PAYLOAD_BYTES: usize = 20 * 1024 * 1024;
        let payload = Arc::<[u8]>::from(vec![0x5a; PAYLOAD_BYTES]);
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        for index in 0..512 {
            let mut attachment = export_attachment(
                &format!("00000000-0000-4000-8000-{index:012}"),
                &format!("placement-{index}.png"),
                None,
            );
            attachment.byte_size = PAYLOAD_BYTES as i64;
            attachment.bytes = Some(payload.clone());
            root.attachments.push(attachment);
        }

        let prepared =
            prepare_markdown_export(&snapshot(root), "large_assets").expect("prepare export");
        let markdown = String::from_utf8(prepared.markdown).expect("UTF-8 Markdown");

        assert_eq!(prepared.assets.len(), 1, "one physical payload file");
        assert_eq!(prepared.assets[0].file_name, "0001.png");
        assert_eq!(prepared.assets[0].bytes.len(), PAYLOAD_BYTES);
        assert_eq!(markdown.matches("(large_assets/0001.png)").count(), 512);
        assert!(!markdown.contains("large_assets/0002.png"));
    }

    #[test]
    fn notes_export_markdown_reuses_first_deterministic_link_for_later_duplicates() {
        let first = export_attachment(FIRST_ID, "first.png", Some(vec![1, 2, 3]));
        let mut second = export_attachment(SECOND_ID, "second.png", Some(vec![4, 5, 6]));
        second.content_hash = "b".repeat(64);
        second.relative_path = format!("notes-assets/{}.png", second.content_hash);
        let mut duplicate = first.clone();
        duplicate.id = LATER_ID.to_string();
        duplicate.original_name = "first-again.png".to_string();
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments = vec![first, second, duplicate];

        let prepared =
            prepare_markdown_export(&snapshot(root), "ordered_assets").expect("prepare export");
        let markdown = String::from_utf8(prepared.markdown).expect("UTF-8 Markdown");

        assert_eq!(prepared.assets.len(), 2);
        assert_eq!(prepared.assets[0].file_name, "0001.png");
        assert_eq!(prepared.assets[1].file_name, "0002.png");
        assert!(markdown.contains("![first.png](ordered_assets/0001.png)"));
        assert!(markdown.contains("![second.png](ordered_assets/0002.png)"));
        assert!(markdown.contains("![first-again.png](ordered_assets/0001.png)"));
    }

    #[test]
    fn notes_export_pdf_working_budget_counts_encoded_decoder_and_owned_rgba_bytes() {
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        let mut attachment = export_attachment(FIRST_ID, "six-pixels.png", Some(vec![1, 2, 3]));
        attachment.intrinsic_width = 2;
        attachment.intrinsic_height = 3;
        root.attachments = vec![attachment.clone(), attachment];
        let snapshot = snapshot(root);

        assert_eq!(
            validate_pdf_attachment_working_budget(&snapshot, 123),
            Ok(123),
            "3 encoded bytes + 6 pixels * (16 decoder + 4 retained RGBA)"
        );
        assert_eq!(
            validate_pdf_attachment_working_budget(&snapshot, 122),
            Err(
                "Notes PDF attachments exceed the 122 byte aggregate working-memory budget."
                    .to_string()
            )
        );
    }

    #[test]
    fn notes_export_pdf_rejects_realistic_aggregate_working_memory_before_decoding() {
        let mut first = export_attachment(FIRST_ID, "first.png", Some(vec![1, 2, 3]));
        first.intrinsic_width = 3000;
        first.intrinsic_height = 3000;
        let mut second = first.clone();
        second.id = SECOND_ID.to_string();
        second.original_name = "second.png".to_string();
        second.content_hash = "b".repeat(64);
        second.relative_path = format!("notes-assets/{}.png", second.content_hash);
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments = vec![first, second];

        let error = render_pdf(&snapshot(root)).expect_err("working-memory budget");

        assert_eq!(
            error,
            "Notes PDF attachments exceed the 268435456 byte aggregate working-memory budget."
        );
    }

    #[test]
    fn notes_export_directory_sync_ignores_unsupported_platform_errors() {
        let unsupported = std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "directory handles are unsupported",
        );

        assert_eq!(classify_export_directory_sync(Err(unsupported)), Ok(()));
        assert_eq!(
            classify_export_directory_sync(Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "denied",
            ))),
            Err("denied".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn notes_export_directory_sync_accepts_a_real_directory_on_unix() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        sync_export_directory(temp_dir.path()).expect("sync directory");
    }

    #[cfg(unix)]
    #[test]
    fn notes_export_guard_rejects_locked_metadata_relocated_into_export_parent() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault = temp_dir.path().join("vault");
        std::fs::create_dir(&vault).expect("vault directory");
        let vault_path = vault.to_str().expect("UTF-8 vault path");
        let _app_lock = crate::notes::connection::acquire_vault_app_lock(vault_path)
            .expect("acquire vault app lock");
        let metadata = crate::metadata_dir(vault_path);
        let export_parent = temp_dir.path().join("export-parent");
        let destination = export_parent.join("notes.sqlite");
        std::fs::write(metadata.join("notes.sqlite"), b"real database")
            .expect("seed real database");

        std::fs::rename(&metadata, &export_parent)
            .expect("relocate real metadata into export parent");
        std::fs::create_dir(&metadata).expect("replace metadata path");

        let result = super::NotesExportDestinationGuard::acquire(vault_path, &[&destination])
            .and_then(|guard| {
                guard.write_atomic_file(&destination, b"export payload", true, || {})
            });

        assert_eq!(
            std::fs::read(&destination).expect("real database survives"),
            b"real database"
        );
        assert!(
            result.is_err(),
            "relocated locked metadata must be rejected"
        );
    }

    #[cfg(windows)]
    #[test]
    fn notes_export_windows_directory_publication_preserves_an_existing_empty_directory() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let staged = temp_dir.path().join("staged-assets");
        let destination = temp_dir.path().join("existing-assets");
        std::fs::create_dir(&staged).expect("staged directory");
        std::fs::write(staged.join("0001.png"), b"image").expect("staged asset");
        std::fs::create_dir(&destination).expect("existing empty directory");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open export parent");

        let error = super::publish_path_noreplace_in(
            &parent,
            std::path::Path::new("staged-assets"),
            &parent,
            std::path::Path::new("existing-assets"),
        )
        .expect_err("existing destination must not be replaced");

        assert_eq!(error, crate::file_io::DESTINATION_EXISTS_MESSAGE);
        assert!(staged.join("0001.png").is_file());
        assert_eq!(
            std::fs::read_dir(&destination)
                .expect("existing destination")
                .count(),
            0
        );
    }

    #[test]
    fn notes_export_adversarial_rejects_published_asset_capability_swap() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("published-swap.md");
        let assets = temp_dir.path().join("published-swap_assets");
        let displaced_assets = temp_dir.path().join("racer-moved-published-assets");
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared = prepare_markdown_export(&snapshot(root), "published-swap_assets")
            .expect("prepare export");
        let raced_assets = assets.clone();
        let raced_displaced_assets = displaced_assets.clone();
        inject_markdown_post_asset_publication_swap_once(move || {
            std::fs::rename(&raced_assets, &raced_displaced_assets)
                .expect("racer moves published assets");
            std::fs::create_dir(&raced_assets).expect("racer replacement directory");
            std::fs::write(raced_assets.join("unrelated.txt"), b"unrelated assets")
                .expect("racer replacement content");
        });

        let error = publish_markdown_export(&destination, &assets, &prepared, false)
            .expect_err("published asset capability swap must fail closed");

        assert!(
            error.contains("staged asset directory identity changed after publication"),
            "{error}"
        );
        assert!(!destination.exists());
        assert_eq!(
            std::fs::read(assets.join("unrelated.txt")).expect("replacement survives"),
            b"unrelated assets"
        );
        assert_eq!(
            std::fs::read(displaced_assets.join("0001.png"))
                .expect("published export assets survive"),
            [1, 2, 3]
        );
    }

    #[test]
    fn notes_export_adversarial_preserves_stage_when_old_asset_capability_is_replaced_before_cleanup(
    ) {
        use std::cell::RefCell;
        use std::rc::Rc;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("cleanup-swap.md");
        let assets = temp_dir.path().join("cleanup-swap_assets");
        let displaced_old_assets = temp_dir.path().join("racer-moved-old-assets-at-cleanup");
        std::fs::write(&destination, b"old document").expect("old document");
        std::fs::create_dir(&assets).expect("old asset directory");
        std::fs::write(assets.join("old.png"), b"old asset").expect("old asset");
        write_export_asset_marker(&assets, &["old.png"], EXPORT_ASSET_MARKER_CREATED_BY);
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared = prepare_markdown_export(&snapshot(root), "cleanup-swap_assets")
            .expect("prepare export");
        let preserved_stage = Rc::new(RefCell::new(None));
        let injected_stage = preserved_stage.clone();
        let raced_displaced_old_assets = displaced_old_assets.clone();
        let _ = super::take_export_cleanup_warnings();
        inject_markdown_pre_stage_cleanup_race_once(move |stage| {
            let old_assets = stage.join("old-assets");
            std::fs::rename(&old_assets, &raced_displaced_old_assets)
                .expect("racer moves validated old assets");
            std::fs::create_dir(&old_assets).expect("racer replacement directory");
            std::fs::create_dir(old_assets.join("nested")).expect("racer nested directory");
            std::fs::write(
                old_assets.join("nested").join("sentinel.txt"),
                b"unrelated cleanup directory",
            )
            .expect("racer sentinel");
            *injected_stage.borrow_mut() = Some(stage.to_path_buf());
        });

        publish_markdown_export(&destination, &assets, &prepared, true)
            .expect("publication remains committed with staging preserved");

        let preserved_stage = preserved_stage.borrow().clone().expect("captured stage");
        assert!(preserved_stage.is_dir(), "{}", preserved_stage.display());
        assert_eq!(
            std::fs::read(
                preserved_stage
                    .join("old-assets")
                    .join("nested")
                    .join("sentinel.txt")
            )
            .expect("unrelated cleanup directory survives"),
            b"unrelated cleanup directory"
        );
        assert_eq!(
            std::fs::read(displaced_old_assets.join("old.png"))
                .expect("validated old assets survive"),
            b"old asset"
        );
        let warnings = super::take_export_cleanup_warnings();
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(
            warnings[0]
                .contains("old asset backup identity changed before private staging cleanup"),
            "{warnings:?}"
        );
        assert!(
            warnings[0].contains(&preserved_stage.display().to_string()),
            "{warnings:?}"
        );
        assert_eq!(
            std::fs::read(&destination).expect("new document remains published"),
            prepared.markdown
        );
        assert_eq!(
            std::fs::read(assets.join("0001.png")).expect("new assets remain published"),
            [1, 2, 3]
        );
    }

    #[test]
    fn notes_export_adversarial_retains_old_document_when_rollback_inspection_fails() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("rollback-inspection.md");
        let assets = temp_dir.path().join("rollback-inspection_assets");
        std::fs::write(&destination, b"old document").expect("old document");
        std::fs::create_dir(&assets).expect("old asset directory");
        std::fs::write(assets.join("old.png"), b"old asset").expect("old asset");
        write_export_asset_marker(&assets, &["old.png"], EXPORT_ASSET_MARKER_CREATED_BY);
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared = prepare_markdown_export(&snapshot(root), "rollback-inspection_assets")
            .expect("prepare export");
        inject_markdown_rollback_inspection_failure_once("old-document");
        super::inject_markdown_publish_failure_once();

        let error = publish_markdown_export(&destination, &assets, &prepared, true)
            .expect_err("injected publication failure");

        assert!(
            error
                .contains("Could not inspect the old Notes export document backup during rollback"),
            "{error}"
        );
        let preserved_stages = std::fs::read_dir(temp_dir.path())
            .expect("list export parent")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".yonalist-notes-export-")
            })
            .collect::<Vec<_>>();
        assert_eq!(preserved_stages.len(), 1, "{error}");
        let preserved_stage = preserved_stages[0].path();
        assert!(
            error.contains(&preserved_stage.display().to_string()),
            "{error}"
        );
        assert_eq!(
            std::fs::read(preserved_stage.join("old-document"))
                .expect("old document retained in staging"),
            b"old document"
        );
        assert!(!destination.exists());
        assert_eq!(
            std::fs::read(assets.join("old.png")).expect("old assets restored"),
            b"old asset"
        );
    }

    #[test]
    fn notes_export_adversarial_no_overwrite_document_publication_does_not_require_hard_links() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("no-link.md");
        let assets = temp_dir.path().join("no-link_assets");
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared =
            prepare_markdown_export(&snapshot(root), "no-link_assets").expect("prepare export");
        publish_markdown_export(&destination, &assets, &prepared, false)
            .expect("no-overwrite publication uses an atomic move");

        assert_eq!(
            std::fs::read(&destination).expect("published document"),
            prepared.markdown
        );
        assert_eq!(
            std::fs::read(assets.join("0001.png")).expect("published asset"),
            [1, 2, 3]
        );
    }

    #[test]
    fn notes_export_adversarial_overwrite_document_publication_does_not_require_hard_links() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("overwrite-no-link.md");
        let assets = temp_dir.path().join("overwrite-no-link_assets");
        std::fs::write(&destination, b"old document").expect("old document");
        std::fs::create_dir(&assets).expect("old asset directory");
        std::fs::write(assets.join("old.png"), b"old asset").expect("old asset");
        write_export_asset_marker(&assets, &["old.png"], EXPORT_ASSET_MARKER_CREATED_BY);
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared = prepare_markdown_export(&snapshot(root), "overwrite-no-link_assets")
            .expect("prepare export");
        publish_markdown_export(&destination, &assets, &prepared, true)
            .expect("overwrite publication uses an atomic move");

        assert_eq!(
            std::fs::read(&destination).expect("published document"),
            prepared.markdown
        );
        assert_eq!(
            std::fs::read(assets.join("0001.png")).expect("published asset"),
            [1, 2, 3]
        );
        assert!(!assets.join("old.png").exists());
    }

    #[test]
    fn notes_export_third_review_windows_directory_capability_uses_delete_sharing() {
        let source = include_str!("export.rs");
        let constructor = ["fn open_export_", "directory_nofollow"].concat();
        let share_mode = ["windows_export_directory_", "share_mode()"].concat();
        let wrapped_handle = ["Dir::from_", "std_file"].concat();
        let delete_access = ["let desired_access = ", "DELETE"].concat();
        let delete_share = ["FILE_SHARE_", "DELETE"].concat();
        let nofollow = ["FILE_FLAG_OPEN_", "REPARSE_POINT"].concat();
        let exact_delete = ["SetFileInformation", "ByHandle"].concat();
        let disposition = ["FILE_DISPOSITION", "_INFO"].concat();

        assert_ne!(super::windows_export_directory_share_mode() & 0x4, 0);
        assert!(source.contains(&constructor), "{constructor}");
        assert!(source.contains(&share_mode), "{share_mode}");
        assert!(source.contains(&wrapped_handle), "{wrapped_handle}");
        assert!(source.contains(&delete_access), "{delete_access}");
        assert!(source.contains(&delete_share), "{delete_share}");
        assert!(source.contains(&nofollow), "{nofollow}");
        assert!(source.contains(&exact_delete), "{exact_delete}");
        assert!(source.contains(&disposition), "{disposition}");
    }

    #[cfg(windows)]
    #[test]
    fn notes_export_windows_held_file_and_directory_support_noreplace_and_disposition() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let original = temp_dir.path().join("held-directory");
        let moved = temp_dir.path().join("moved-directory");
        std::fs::create_dir(&original).expect("held directory");
        std::fs::write(original.join("owned.txt"), b"owned").expect("owned file");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open export parent");
        let held = super::HeldExportDirectory::open_from(
            &parent,
            std::path::Path::new("held-directory"),
            "held directory changed before Windows rename",
        )
        .expect("hold directory");
        let held_file = super::HeldExportFile::open_from(
            &held.directory,
            std::path::Path::new("owned.txt"),
            "held file changed before Windows rename",
        )
        .expect("hold file");

        super::publish_path_noreplace_in(
            &parent,
            std::path::Path::new("held-directory"),
            &parent,
            std::path::Path::new("moved-directory"),
        )
        .expect("no-replace rename while held");
        held.verify_in(
            &parent,
            std::path::Path::new("moved-directory"),
            "held directory changed during Windows rename",
        )
        .expect("same held directory after rename");
        held_file
            .remove_from_held(
                &held.directory,
                std::path::Path::new("owned.txt"),
                "held file changed before Windows deletion",
            )
            .expect("delete held file");
        held.remove_empty_held("delete held Windows directory")
            .expect("delete held directory");
        assert!(!moved.exists());
    }

    #[cfg(windows)]
    #[test]
    fn notes_export_windows_held_capabilities_reject_reparse_points() {
        use std::os::windows::fs::{symlink_dir, symlink_file};

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let target_directory = temp_dir.path().join("target-directory");
        std::fs::create_dir(&target_directory).expect("target directory");
        std::fs::write(target_directory.join("owned.txt"), b"owned").expect("target file");
        symlink_dir(
            "target-directory",
            temp_dir.path().join("held-directory-link"),
        )
        .expect("directory symlink");
        symlink_file(
            std::path::Path::new("target-directory").join("owned.txt"),
            temp_dir.path().join("held-file-link"),
        )
        .expect("file symlink");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open export parent");

        assert!(super::HeldExportDirectory::open_from(
            &parent,
            std::path::Path::new("held-directory-link"),
            "held directory link must be rejected",
        )
        .is_err());
        assert!(super::HeldExportFile::open_from(
            &parent,
            std::path::Path::new("held-file-link"),
            "held file link must be rejected",
        )
        .is_err());
    }

    #[test]
    fn notes_export_third_review_never_recursively_cleans_post_validation_stage_entries() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("stage-race.md");
        let assets = temp_dir.path().join("stage-race_assets");
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared =
            prepare_markdown_export(&snapshot(root), "stage-race_assets").expect("prepare export");
        let captured_stage = Rc::new(RefCell::new(None));
        let injected_stage = captured_stage.clone();
        let _ = super::take_export_cleanup_warnings();
        inject_markdown_post_stage_validation_cleanup_race_once(move |stage| {
            let unrelated = stage.join("racer-added").join("nested");
            std::fs::create_dir_all(&unrelated).expect("racer directory");
            std::fs::write(unrelated.join("sentinel.txt"), b"unrelated stage entry")
                .expect("racer sentinel");
            *injected_stage.borrow_mut() = Some(stage.to_path_buf());
        });

        publish_markdown_export(&destination, &assets, &prepared, false)
            .expect("publication remains committed");

        let stage = captured_stage.borrow().clone().expect("captured stage");
        assert_eq!(
            std::fs::read(stage.join("racer-added/nested/sentinel.txt"))
                .expect("unrelated stage entry survives"),
            b"unrelated stage entry"
        );
        let warnings = super::take_export_cleanup_warnings();
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(warnings[0].contains(&stage.display().to_string()));
    }

    #[test]
    fn notes_export_third_review_never_recursively_cleans_unexpected_old_asset_entries() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("asset-cleanup-race.md");
        let assets = temp_dir.path().join("asset-cleanup-race_assets");
        std::fs::write(&destination, b"old document").expect("old document");
        std::fs::create_dir(&assets).expect("old asset directory");
        std::fs::write(assets.join("old.png"), b"old asset").expect("old asset");
        write_export_asset_marker(&assets, &["old.png"], EXPORT_ASSET_MARKER_CREATED_BY);
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared = prepare_markdown_export(&snapshot(root), "asset-cleanup-race_assets")
            .expect("prepare export");
        let captured_stage = Rc::new(RefCell::new(None));
        let injected_stage = captured_stage.clone();
        let _ = super::take_export_cleanup_warnings();
        inject_markdown_post_stage_validation_cleanup_race_once(move |stage| {
            let unrelated = stage.join("old-assets").join("racer-added").join("nested");
            std::fs::create_dir_all(&unrelated).expect("racer directory");
            std::fs::write(unrelated.join("sentinel.txt"), b"unrelated old asset entry")
                .expect("racer sentinel");
            *injected_stage.borrow_mut() = Some(stage.to_path_buf());
        });

        publish_markdown_export(&destination, &assets, &prepared, true)
            .expect("publication remains committed");

        assert_eq!(
            std::fs::read(&destination).expect("new document published"),
            prepared.markdown
        );
        let stage = captured_stage.borrow().clone().expect("captured stage");
        assert_eq!(
            std::fs::read(stage.join("old-assets/racer-added/nested/sentinel.txt"))
                .expect("unrelated old asset entry survives"),
            b"unrelated old asset entry"
        );
        let warnings = super::take_export_cleanup_warnings();
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(warnings[0].contains(&stage.display().to_string()));
    }

    #[test]
    fn notes_export_third_review_rejects_directory_document_destination_before_displacement() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("directory.md");
        let assets = temp_dir.path().join("directory_assets");
        std::fs::create_dir(&destination).expect("document directory");
        std::fs::write(destination.join("sentinel.txt"), b"document directory")
            .expect("document directory sentinel");
        std::fs::create_dir(&assets).expect("old asset directory");
        std::fs::write(assets.join("old.png"), b"old asset").expect("old asset");
        write_export_asset_marker(&assets, &["old.png"], EXPORT_ASSET_MARKER_CREATED_BY);
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared =
            prepare_markdown_export(&snapshot(root), "directory_assets").expect("prepare export");

        let error = publish_markdown_export(&destination, &assets, &prepared, true)
            .expect_err("document directory must be refused");

        assert_eq!(
            error,
            "Notes export document destination must be a regular file."
        );
        assert_eq!(
            std::fs::read(destination.join("sentinel.txt")).expect("document directory survives"),
            b"document directory"
        );
        assert_eq!(
            std::fs::read(assets.join("old.png")).expect("old assets survive"),
            b"old asset"
        );
    }

    #[test]
    fn notes_export_third_review_old_document_swap_is_never_restored_and_original_is_recovered() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("old-document-swap.md");
        let assets = temp_dir.path().join("old-document-swap_assets");
        let removed_original = temp_dir.path().join("racer-unlinked-original.md");
        std::fs::write(&destination, b"old document").expect("old document");
        std::fs::create_dir(&assets).expect("old asset directory");
        std::fs::write(assets.join("old.png"), b"old asset").expect("old asset");
        write_export_asset_marker(&assets, &["old.png"], EXPORT_ASSET_MARKER_CREATED_BY);
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared = prepare_markdown_export(&snapshot(root), "old-document-swap_assets")
            .expect("prepare export");
        let captured_stage = Rc::new(RefCell::new(None));
        let injected_stage = captured_stage.clone();
        let raced_original = removed_original.clone();
        inject_markdown_pre_document_rollback_race_once(move |stage| {
            let old_document = stage.join("old-document");
            std::fs::rename(&old_document, &raced_original).expect("move real old document");
            std::fs::remove_file(&raced_original).expect("unlink real old document");
            std::fs::write(&old_document, b"foreign staged document")
                .expect("foreign staged replacement");
            *injected_stage.borrow_mut() = Some(stage.to_path_buf());
        });
        super::inject_markdown_publish_failure_once();

        let error = publish_markdown_export(&destination, &assets, &prepared, true)
            .expect_err("injected publication failure");

        assert!(
            !destination.exists(),
            "foreign document must not be restored"
        );
        let stage = captured_stage.borrow().clone().expect("captured stage");
        assert_eq!(
            std::fs::read(stage.join("old-document")).expect("foreign staging path survives"),
            b"foreign staged document"
        );
        assert!(error.contains(&stage.display().to_string()), "{error}");
        let recoveries = std::fs::read_dir(temp_dir.path())
            .expect("list recoveries")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".yonalist-notes-old-document-")
            })
            .collect::<Vec<_>>();
        assert_eq!(recoveries.len(), 1, "{error}");
        assert_eq!(
            std::fs::read(recoveries[0].path()).expect("recovered original document"),
            b"old document"
        );
        assert!(
            error.contains(&recoveries[0].path().display().to_string()),
            "{error}"
        );
    }

    #[test]
    fn notes_export_third_review_no_overwrite_rechecks_assets_after_document_publication() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("final-swap.md");
        let assets = temp_dir.path().join("final-swap_assets");
        let moved_assets = temp_dir.path().join("racer-moved-final-assets");
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared =
            prepare_markdown_export(&snapshot(root), "final-swap_assets").expect("prepare export");
        let raced_assets = assets.clone();
        let raced_moved_assets = moved_assets.clone();
        inject_markdown_pre_document_publication_asset_swap_once(move || {
            std::fs::rename(&raced_assets, &raced_moved_assets)
                .expect("move verified published assets");
            std::fs::create_dir(&raced_assets).expect("foreign replacement directory");
            std::fs::write(raced_assets.join("foreign.txt"), b"foreign assets")
                .expect("foreign asset sentinel");
        });

        let error = publish_markdown_export(&destination, &assets, &prepared, false)
            .expect_err("post-document asset swap must roll back");

        assert!(
            error.contains("staged asset directory identity changed after document publication"),
            "{error}"
        );
        assert!(!destination.exists(), "published document must roll back");
        assert_eq!(
            std::fs::read(assets.join("foreign.txt")).expect("foreign assets survive"),
            b"foreign assets"
        );
        assert_eq!(
            std::fs::read(moved_assets.join("0001.png")).expect("real assets survive"),
            [1, 2, 3]
        );
    }

    #[test]
    fn notes_export_third_review_overwrite_rechecks_assets_after_document_publication() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("overwrite-final-swap.md");
        let assets = temp_dir.path().join("overwrite-final-swap_assets");
        let moved_assets = temp_dir.path().join("racer-moved-overwrite-final-assets");
        std::fs::write(&destination, b"old document").expect("old document");
        std::fs::create_dir(&assets).expect("old asset directory");
        std::fs::write(assets.join("old.png"), b"old asset").expect("old asset");
        write_export_asset_marker(&assets, &["old.png"], EXPORT_ASSET_MARKER_CREATED_BY);
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared = prepare_markdown_export(&snapshot(root), "overwrite-final-swap_assets")
            .expect("prepare export");
        let raced_assets = assets.clone();
        let raced_moved_assets = moved_assets.clone();
        inject_markdown_pre_document_publication_asset_swap_once(move || {
            std::fs::rename(&raced_assets, &raced_moved_assets)
                .expect("move verified published assets");
            std::fs::create_dir(&raced_assets).expect("foreign replacement directory");
            std::fs::write(raced_assets.join("foreign.txt"), b"foreign assets")
                .expect("foreign asset sentinel");
        });

        let error = publish_markdown_export(&destination, &assets, &prepared, true)
            .expect_err("post-document asset swap must roll back");

        assert!(
            error.contains("staged asset directory identity changed after document publication"),
            "{error}"
        );
        assert_eq!(
            std::fs::read(&destination).expect("old document restored"),
            b"old document"
        );
        assert_eq!(
            std::fs::read(assets.join("foreign.txt")).expect("foreign assets survive"),
            b"foreign assets"
        );
        assert_eq!(
            std::fs::read(moved_assets.join("0001.png")).expect("new assets survive"),
            [1, 2, 3]
        );
        let old_asset_recoveries = std::fs::read_dir(temp_dir.path())
            .expect("list recoveries")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".yonalist-notes-old-assets-")
            })
            .collect::<Vec<_>>();
        assert_eq!(old_asset_recoveries.len(), 1, "{error}");
        assert_eq!(
            std::fs::read(old_asset_recoveries[0].path().join("old.png"))
                .expect("old assets recovered"),
            b"old asset"
        );
    }

    #[test]
    fn notes_export_no_overwrite_preserves_document_created_at_markdown_commit() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("race.md");
        let assets = temp_dir.path().join("race_assets");
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared = prepare_markdown_export(&snapshot(root), "race_assets").expect("prepare");
        let raced_destination = destination.clone();
        inject_markdown_commit_race_once(move || {
            std::fs::write(raced_destination, b"racer document").expect("create racer document");
        });

        let error = publish_markdown_export(&destination, &assets, &prepared, false)
            .expect_err("commit-time document conflict");

        assert_eq!(error, "Destination already exists.");
        assert_eq!(
            std::fs::read(&destination).expect("racer survives"),
            b"racer document"
        );
        assert!(!assets.exists(), "staged assets must not be published");
    }

    #[test]
    fn notes_export_no_overwrite_preserves_assets_created_at_markdown_commit() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("race.md");
        let assets = temp_dir.path().join("race_assets");
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared = prepare_markdown_export(&snapshot(root), "race_assets").expect("prepare");
        let raced_assets = assets.clone();
        inject_markdown_commit_race_once(move || {
            std::fs::create_dir(&raced_assets).expect("create racer assets");
            std::fs::write(raced_assets.join("owned.txt"), b"racer assets")
                .expect("create racer asset");
        });

        let error = publish_markdown_export(&destination, &assets, &prepared, false)
            .expect_err("commit-time asset conflict");

        assert_eq!(error, "Destination already exists.");
        assert_eq!(
            std::fs::read(assets.join("owned.txt")).expect("racer survives"),
            b"racer assets"
        );
        assert!(
            !destination.exists(),
            "staged document must not be published"
        );
    }

    #[cfg(unix)]
    #[test]
    fn notes_export_no_overwrite_asset_swap_never_writes_through_a_symlink() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("swap.md");
        let assets = temp_dir.path().join("swap_assets");
        let outside = temp_dir.path().join("outside");
        std::fs::create_dir(&outside).expect("outside directory");
        std::fs::write(outside.join("sentinel.txt"), b"outside").expect("outside sentinel");
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared = prepare_markdown_export(&snapshot(root), "swap_assets").expect("prepare");
        let raced_assets = assets.clone();
        let raced_outside = outside.clone();
        inject_markdown_asset_destination_swap_once(move || {
            match std::fs::remove_dir(&raced_assets) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => panic!("remove empty reservation: {error}"),
            }
            symlink(&raced_outside, &raced_assets).expect("swap reservation for symlink");
        });

        let error = publish_markdown_export(&destination, &assets, &prepared, false)
            .expect_err("symlink swap must conflict");

        assert_eq!(error, "Destination already exists.");
        assert!(std::fs::symlink_metadata(&assets)
            .expect("racer symlink remains")
            .file_type()
            .is_symlink());
        assert!(!destination.exists());
        assert!(!outside.join("0001.png").exists());
        assert_eq!(
            std::fs::read(outside.join("sentinel.txt")).expect("sentinel survives"),
            b"outside"
        );
    }

    #[test]
    fn notes_export_rollback_preserves_a_directory_swapped_after_asset_publication() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("rollback-swap.md");
        let assets = temp_dir.path().join("rollback-swap_assets");
        let displaced_assets = temp_dir.path().join("displaced-export-assets");
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared = prepare_markdown_export(&snapshot(root), "rollback-swap_assets")
            .expect("prepare export");
        let raced_assets = assets.clone();
        let raced_displaced = displaced_assets.clone();
        inject_markdown_post_asset_publication_swap_once(move || {
            std::fs::rename(&raced_assets, &raced_displaced).expect("displace published assets");
            std::fs::create_dir(&raced_assets).expect("replacement directory");
            std::fs::write(raced_assets.join("unrelated.txt"), b"unrelated")
                .expect("replacement content");
        });
        super::inject_markdown_publish_failure_once();

        let error = publish_markdown_export(&destination, &assets, &prepared, false)
            .expect_err("injected publish failure");

        assert!(
            error.contains("Injected Notes Markdown publish failure."),
            "{error}"
        );
        assert!(error.contains("rollback also failed"), "{error}");
        assert!(error.contains("identity changed"), "{error}");
        assert_eq!(
            std::fs::read(assets.join("unrelated.txt")).expect("replacement preserved"),
            b"unrelated"
        );
        assert_eq!(
            std::fs::read(displaced_assets.join("0001.png")).expect("published assets displaced"),
            [1, 2, 3]
        );
        assert!(!destination.exists());
    }

    #[test]
    fn notes_export_overwrite_rollback_preserves_racer_and_old_asset_backup() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("overwrite-race.md");
        let assets = temp_dir.path().join("overwrite-race_assets");
        let displaced_assets = temp_dir.path().join("displaced-new-assets");
        std::fs::write(&destination, b"old document").expect("old document");
        std::fs::create_dir(&assets).expect("old asset directory");
        std::fs::write(assets.join("old.png"), b"old asset").expect("old asset");
        // A real prior export leaves our marker behind; the overwrite guard
        // requires it before displacing the directory.
        write_export_asset_marker(&assets, &["old.png"], EXPORT_ASSET_MARKER_CREATED_BY);
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared = prepare_markdown_export(&snapshot(root), "overwrite-race_assets")
            .expect("prepare export");
        let racer_identity = Rc::new(RefCell::new(None));
        let injected_identity = racer_identity.clone();
        let raced_assets = assets.clone();
        let raced_displaced = displaced_assets.clone();
        inject_markdown_post_asset_publication_swap_once(move || {
            std::fs::rename(&raced_assets, &raced_displaced).expect("displace new assets");
            std::fs::create_dir(&raced_assets).expect("empty racer directory");
            *injected_identity.borrow_mut() =
                Some(super::export_directory_identity(&raced_assets).expect("racer identity"));
        });
        super::inject_markdown_publish_failure_once();

        let error = publish_markdown_export(&destination, &assets, &prepared, true)
            .expect_err("injected overwrite failure");

        assert!(error.contains("incomplete rollback"), "{error}");
        assert_eq!(
            super::export_directory_identity(&assets).expect("surviving racer identity"),
            racer_identity.borrow().expect("recorded racer identity")
        );
        assert_eq!(
            std::fs::read_dir(&assets)
                .expect("empty racer survives")
                .count(),
            0
        );
        let old_backups = std::fs::read_dir(temp_dir.path())
            .expect("list export parent")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".yonalist-notes-old-assets-")
            })
            .collect::<Vec<_>>();
        assert_eq!(old_backups.len(), 1, "{error}");
        assert_eq!(
            std::fs::read(old_backups[0].path().join("old.png")).expect("preserved old backup"),
            b"old asset"
        );
        assert_eq!(
            std::fs::read(&destination).expect("old document restored"),
            b"old document"
        );
        assert_eq!(
            std::fs::read(displaced_assets.join("0001.png")).expect("new assets displaced"),
            [1, 2, 3]
        );
    }

    #[test]
    fn notes_export_overwrite_rollback_preserves_raced_document_and_old_document_backup() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("rollback-document-race.md");
        let assets = temp_dir.path().join("rollback-document-race_assets");
        std::fs::write(&destination, b"old document").expect("old document");
        std::fs::create_dir(&assets).expect("old asset directory");
        std::fs::write(assets.join("old.png"), b"old asset").expect("old asset");
        write_export_asset_marker(&assets, &["old.png"], EXPORT_ASSET_MARKER_CREATED_BY);
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared = prepare_markdown_export(&snapshot(root), "rollback-document-race_assets")
            .expect("prepare export");
        let raced_destination = destination.clone();
        inject_markdown_post_asset_publication_swap_once(move || {
            std::fs::write(&raced_destination, b"racer document")
                .expect("create racer document before final publication");
        });

        let error = publish_markdown_export(&destination, &assets, &prepared, true)
            .expect_err("final no-replace document publication must conflict");

        assert_eq!(
            std::fs::read(&destination).expect("racer document survives rollback"),
            b"racer document"
        );
        let old_document_backups = std::fs::read_dir(temp_dir.path())
            .expect("list export parent")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".yonalist-notes-old-document-")
            })
            .collect::<Vec<_>>();
        assert_eq!(old_document_backups.len(), 1, "{error}");
        assert_eq!(
            std::fs::read(old_document_backups[0].path()).expect("preserved old document backup"),
            b"old document"
        );
        assert!(
            error.contains("old document backup was preserved at"),
            "{error}"
        );
        assert!(
            error.contains(&old_document_backups[0].path().display().to_string()),
            "{error}"
        );
        assert_eq!(
            std::fs::read(assets.join("old.png")).expect("old assets restored"),
            b"old asset"
        );
        assert!(!assets.join("0001.png").exists());
    }

    #[test]
    fn notes_export_overwrite_same_uid_document_backup_slot_race_preserves_foreign_file() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("document-backup-slot-race.md");
        let assets = temp_dir.path().join("document-backup-slot-race_assets");
        std::fs::write(&destination, b"old document").expect("old document");
        std::fs::create_dir(&assets).expect("old asset directory");
        std::fs::write(assets.join("old.png"), b"old asset").expect("old asset");
        write_export_asset_marker(&assets, &["old.png"], EXPORT_ASSET_MARKER_CREATED_BY);
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared = prepare_markdown_export(&snapshot(root), "document-backup-slot-race_assets")
            .expect("prepare export");
        let captured_stage = Rc::new(RefCell::new(None));
        let injected_stage = captured_stage.clone();
        inject_markdown_pre_document_backup_slot_race_once(move |stage| {
            std::fs::write(stage.join("old-document"), b"foreign backup slot")
                .expect("same-uid racer creates document backup slot");
            *injected_stage.borrow_mut() = Some(stage.to_path_buf());
        });

        let error = publish_markdown_export(&destination, &assets, &prepared, true)
            .expect_err("occupied document backup slot must fail closed");

        let stage = captured_stage.borrow().clone().expect("captured stage");
        assert!(
            error.contains(crate::file_io::DESTINATION_EXISTS_MESSAGE),
            "{error}"
        );
        assert!(error.contains(&stage.display().to_string()), "{error}");
        assert_eq!(
            std::fs::read(stage.join("old-document")).expect("foreign backup slot survives"),
            b"foreign backup slot"
        );
        assert_eq!(
            std::fs::read(&destination).expect("old document remains"),
            b"old document"
        );
        assert_eq!(
            std::fs::read(assets.join("old.png")).expect("old assets remain"),
            b"old asset"
        );
        assert!(!assets.join("0001.png").exists());
    }

    #[test]
    fn notes_export_overwrite_same_uid_asset_backup_slot_race_preserves_foreign_directory() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("asset-backup-slot-race.md");
        let assets = temp_dir.path().join("asset-backup-slot-race_assets");
        std::fs::write(&destination, b"old document").expect("old document");
        std::fs::create_dir(&assets).expect("old asset directory");
        std::fs::write(assets.join("old.png"), b"old asset").expect("old asset");
        write_export_asset_marker(&assets, &["old.png"], EXPORT_ASSET_MARKER_CREATED_BY);
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared = prepare_markdown_export(&snapshot(root), "asset-backup-slot-race_assets")
            .expect("prepare export");
        let captured_slot = Rc::new(RefCell::new(None));
        let injected_slot = captured_slot.clone();
        inject_markdown_pre_asset_backup_slot_race_once(move |stage| {
            let slot = stage.join("old-assets");
            std::fs::create_dir(&slot).expect("same-uid racer creates empty asset backup slot");
            let identity = super::export_directory_identity(&slot).expect("foreign slot identity");
            *injected_slot.borrow_mut() = Some((stage.to_path_buf(), identity));
        });

        let error = publish_markdown_export(&destination, &assets, &prepared, true)
            .expect_err("occupied asset backup slot must fail closed");

        let (stage, foreign_identity) = captured_slot.borrow().clone().expect("captured slot");
        let foreign_slot = stage.join("old-assets");
        assert!(
            error.contains(crate::file_io::DESTINATION_EXISTS_MESSAGE),
            "{error}"
        );
        assert!(error.contains(&stage.display().to_string()), "{error}");
        assert_eq!(
            super::export_directory_identity(&foreign_slot).expect("surviving slot identity"),
            foreign_identity
        );
        assert_eq!(
            std::fs::read_dir(&foreign_slot)
                .expect("foreign backup slot survives")
                .count(),
            0
        );
        assert_eq!(
            std::fs::read(&destination).expect("old document restored"),
            b"old document"
        );
        assert_eq!(
            std::fs::read(assets.join("old.png")).expect("old assets remain"),
            b"old asset"
        );
        assert!(!assets.join("0001.png").exists());
    }

    #[test]
    fn notes_export_overwrite_fails_closed_when_document_destination_is_swapped_before_displacement(
    ) {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("overwrite-document-swap.md");
        let assets = temp_dir.path().join("overwrite-document-swap_assets");
        let displaced_document = temp_dir.path().join("racer-moved-old-document.md");
        std::fs::write(&destination, b"old document").expect("old document");
        std::fs::create_dir(&assets).expect("old asset directory");
        std::fs::write(assets.join("old.png"), b"old asset").expect("old asset");
        write_export_asset_marker(&assets, &["old.png"], EXPORT_ASSET_MARKER_CREATED_BY);
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared = prepare_markdown_export(&snapshot(root), "overwrite-document-swap_assets")
            .expect("prepare export");
        let raced_destination = destination.clone();
        let raced_displaced_document = displaced_document.clone();
        inject_markdown_overwrite_displacement_race_once(move || {
            std::fs::rename(&raced_destination, &raced_displaced_document)
                .expect("racer moves old document");
            std::fs::create_dir(&raced_destination).expect("racer directory");
            std::fs::write(
                raced_destination.join("unrelated.txt"),
                b"unrelated document dir",
            )
            .expect("racer sentinel");
        });

        let error = publish_markdown_export(&destination, &assets, &prepared, true)
            .expect_err("swapped document destination must be refused");

        assert!(
            error.contains("document destination identity changed"),
            "{error}"
        );
        assert_eq!(
            std::fs::read(destination.join("unrelated.txt")).expect("racer directory survives"),
            b"unrelated document dir"
        );
        assert_eq!(
            std::fs::read(&displaced_document).expect("racer-moved old document survives"),
            b"old document"
        );
        assert_eq!(
            std::fs::read(assets.join("old.png")).expect("old assets remain"),
            b"old asset"
        );
        assert!(!assets.join("0001.png").exists());
    }

    #[test]
    fn notes_export_overwrite_binds_marker_validation_to_the_captured_asset_identity() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("marker-identity-race.md");
        let assets = temp_dir.path().join("marker-identity-race_assets");
        let displaced_assets = temp_dir.path().join("racer-moved-owned-assets");
        std::fs::write(&destination, b"old document").expect("old document");
        std::fs::create_dir(&assets).expect("owned asset directory");
        std::fs::write(assets.join("old.png"), b"old asset").expect("old asset");
        write_export_asset_marker(&assets, &["old.png"], EXPORT_ASSET_MARKER_CREATED_BY);
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared = prepare_markdown_export(&snapshot(root), "marker-identity-race_assets")
            .expect("prepare export");
        let raced_assets = assets.clone();
        let raced_displaced_assets = displaced_assets.clone();
        inject_markdown_asset_marker_identity_race_once(move || {
            std::fs::rename(&raced_assets, &raced_displaced_assets)
                .expect("racer moves marker-owned assets");
            std::fs::create_dir(&raced_assets).expect("racer replacement directory");
            std::fs::create_dir(raced_assets.join("unrelated")).expect("racer nested directory");
            std::fs::write(
                raced_assets.join("unrelated").join("sentinel.txt"),
                b"unrelated assets",
            )
            .expect("racer sentinel");
        });

        let error = publish_markdown_export(&destination, &assets, &prepared, true)
            .expect_err("asset identity changed after marker validation");

        assert!(
            error.contains("asset destination identity changed during marker validation"),
            "{error}"
        );
        assert_eq!(
            std::fs::read(&destination).expect("old document remains"),
            b"old document"
        );
        assert_eq!(
            std::fs::read(assets.join("unrelated").join("sentinel.txt"))
                .expect("unrelated replacement survives"),
            b"unrelated assets"
        );
        assert_eq!(
            std::fs::read(displaced_assets.join("old.png")).expect("owned directory survives"),
            b"old asset"
        );
        assert!(!assets.join("0001.png").exists());
    }

    #[test]
    fn notes_export_overwrite_fails_closed_when_asset_destination_is_swapped_before_displacement() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("overwrite-asset-swap.md");
        let assets = temp_dir.path().join("overwrite-asset-swap_assets");
        let displaced_assets = temp_dir.path().join("racer-moved-old-assets");
        std::fs::write(&destination, b"old document").expect("old document");
        std::fs::create_dir(&assets).expect("old asset directory");
        std::fs::write(assets.join("old.png"), b"old asset").expect("old asset");
        write_export_asset_marker(&assets, &["old.png"], EXPORT_ASSET_MARKER_CREATED_BY);
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared = prepare_markdown_export(&snapshot(root), "overwrite-asset-swap_assets")
            .expect("prepare export");
        let raced_assets = assets.clone();
        let raced_displaced_assets = displaced_assets.clone();
        inject_markdown_overwrite_displacement_race_once(move || {
            std::fs::rename(&raced_assets, &raced_displaced_assets)
                .expect("racer moves old assets");
            std::fs::create_dir(&raced_assets).expect("racer asset directory");
            std::fs::write(raced_assets.join("unrelated.txt"), b"unrelated assets")
                .expect("racer asset sentinel");
        });

        let error = publish_markdown_export(&destination, &assets, &prepared, true)
            .expect_err("swapped asset destination must be refused");

        assert!(
            error.contains("asset destination identity changed"),
            "{error}"
        );
        assert_eq!(
            std::fs::read(&destination).expect("old document restored"),
            b"old document"
        );
        assert_eq!(
            std::fs::read(assets.join("unrelated.txt")).expect("racer assets survive"),
            b"unrelated assets"
        );
        assert_eq!(
            std::fs::read(displaced_assets.join("old.png")).expect("racer-moved old assets"),
            b"old asset"
        );
        assert!(!assets.join("0001.png").exists());
    }

    #[test]
    fn notes_export_rollback_retains_owned_quarantine_without_recursive_deletion() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("retained.md");
        let assets = temp_dir.path().join("retained_assets");
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared =
            prepare_markdown_export(&snapshot(root), "retained_assets").expect("prepare export");
        let _ = super::take_export_cleanup_warnings();
        super::inject_markdown_publish_failure_once();

        let error = publish_markdown_export(&destination, &assets, &prepared, false)
            .expect_err("injected publish failure");

        assert_eq!(error, "Injected Notes Markdown publish failure.");
        let warnings = super::take_export_cleanup_warnings();
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(warnings[0].contains("cleanup warning"), "{warnings:?}");
        assert!(
            warnings[0].contains("startup/manual cleanup"),
            "{warnings:?}"
        );
        let quarantines = std::fs::read_dir(temp_dir.path())
            .expect("list export parent")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".yonalist-notes-rollback-")
            })
            .collect::<Vec<_>>();
        assert_eq!(quarantines.len(), 1, "{error}");
        assert_eq!(
            std::fs::read(quarantines[0].path().join("0001.png"))
                .expect("retained quarantine asset"),
            [1, 2, 3]
        );
        assert!(!assets.exists());
        assert!(!destination.exists());
    }

    #[test]
    fn notes_export_success_removes_private_staging_without_quarantine() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("success.md");
        let assets = temp_dir.path().join("success_assets");
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared =
            prepare_markdown_export(&snapshot(root), "success_assets").expect("prepare export");

        publish_markdown_export(&destination, &assets, &prepared, false).expect("publish export");

        assert!(destination.is_file());
        assert!(assets.join("0001.png").is_file());
        let private_artifacts = std::fs::read_dir(temp_dir.path())
            .expect("list export parent")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".yonalist-notes-")
            })
            .collect::<Vec<_>>();
        assert!(private_artifacts.is_empty(), "{private_artifacts:?}");
    }

    #[test]
    fn notes_export_writes_a_marker_listing_every_written_asset_file() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("marker.md");
        let assets = temp_dir.path().join("marker_assets");
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(distinct_export_attachment(
            FIRST_ID,
            "first.png",
            &"a".repeat(64),
            vec![1, 2, 3],
        ));
        root.attachments.push(distinct_export_attachment(
            SECOND_ID,
            "second.png",
            &"b".repeat(64),
            vec![4, 5, 6, 7],
        ));
        let prepared =
            prepare_markdown_export(&snapshot(root), "marker_assets").expect("prepare export");

        publish_markdown_export(&destination, &assets, &prepared, false).expect("publish export");

        assert!(assets.join("0001.png").is_file());
        assert!(assets.join("0002.png").is_file());
        let marker = read_export_asset_marker(&assets);
        assert_eq!(
            marker["createdBy"],
            serde_json::json!(EXPORT_ASSET_MARKER_CREATED_BY)
        );
        assert_eq!(
            marker["version"],
            serde_json::json!(EXPORT_ASSET_MARKER_VERSION)
        );
        // The marker lists the written asset files only; it never lists itself.
        assert_eq!(marker["files"], serde_json::json!(["0001.png", "0002.png"]));
    }

    #[test]
    fn notes_export_overwrite_replaces_an_asset_directory_that_carries_our_marker() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("owned.md");
        let assets = temp_dir.path().join("owned_assets");
        std::fs::write(&destination, b"stale document").expect("stale document");
        std::fs::create_dir(&assets).expect("prior asset directory");
        std::fs::write(assets.join("0001.png"), b"stale asset").expect("stale asset");
        std::fs::write(assets.join("0002.png"), b"stale extra").expect("stale extra");
        write_export_asset_marker(
            &assets,
            &["0001.png", "0002.png"],
            EXPORT_ASSET_MARKER_CREATED_BY,
        );
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![9, 8, 7]),
        ));
        let prepared =
            prepare_markdown_export(&snapshot(root), "owned_assets").expect("prepare export");

        publish_markdown_export(&destination, &assets, &prepared, true).expect("overwrite export");

        // The directory was replaced wholesale: the stale second asset is gone.
        assert!(!assets.join("0002.png").exists());
        assert_eq!(
            std::fs::read(assets.join("0001.png")).expect("new asset"),
            [9, 8, 7]
        );
        let marker = read_export_asset_marker(&assets);
        assert_eq!(marker["files"], serde_json::json!(["0001.png"]));
        let document = std::fs::read(&destination).expect("new document");
        assert_ne!(document, b"stale document");
        assert!(String::from_utf8_lossy(&document).contains("kind: yonalist-notes-export"));
    }

    #[test]
    fn notes_export_overwrite_refuses_an_asset_directory_without_our_marker() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("foreign.md");
        let assets = temp_dir.path().join("foreign_assets");
        std::fs::write(&destination, b"user document").expect("user document");
        std::fs::create_dir(&assets).expect("user directory");
        std::fs::write(assets.join("keepsake.txt"), b"precious").expect("user file");
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared =
            prepare_markdown_export(&snapshot(root), "foreign_assets").expect("prepare export");

        let error = publish_markdown_export(&destination, &assets, &prepared, true)
            .expect_err("foreign asset directory must be refused");

        assert_eq!(error, FOREIGN_EXPORT_ASSET_DIR_MESSAGE);
        // The refusal must never masquerade as the frontend overwrite-prompt string.
        assert_ne!(error, "Destination already exists.");
        // The foreign directory and its lone file are untouched.
        assert_eq!(
            std::fs::read(assets.join("keepsake.txt")).expect("keepsake survives"),
            b"precious"
        );
        assert_eq!(
            std::fs::read_dir(&assets)
                .expect("foreign directory")
                .count(),
            1
        );
        // The pre-existing destination document is byte-identical.
        assert_eq!(
            std::fs::read(&destination).expect("document survives"),
            b"user document"
        );
        // Private staging must not leak on the refusal.
        let leaked = std::fs::read_dir(temp_dir.path())
            .expect("list export parent")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".yonalist-notes-")
            })
            .count();
        assert_eq!(leaked, 0);
    }

    #[test]
    fn notes_export_overwrite_refuses_a_marker_with_a_foreign_created_by() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("impostor.md");
        let assets = temp_dir.path().join("impostor_assets");
        std::fs::write(&destination, b"user document").expect("user document");
        std::fs::create_dir(&assets).expect("user directory");
        std::fs::write(assets.join("0001.png"), b"user asset").expect("user asset");
        write_export_asset_marker(&assets, &["0001.png"], "some-other-tool");
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared =
            prepare_markdown_export(&snapshot(root), "impostor_assets").expect("prepare export");

        let error = publish_markdown_export(&destination, &assets, &prepared, true)
            .expect_err("a foreign createdBy marker must be refused");

        assert_eq!(error, FOREIGN_EXPORT_ASSET_DIR_MESSAGE);
        assert_eq!(
            std::fs::read(assets.join("0001.png")).expect("user asset survives"),
            b"user asset"
        );
        assert_eq!(
            std::fs::read(&destination).expect("document survives"),
            b"user document"
        );
    }

    #[test]
    fn notes_export_without_attachments_writes_no_assets_directory_or_marker() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("plain.md");
        let assets = temp_dir.path().join("plain_assets");
        let root = export_node(ROOT_ID, "Project", "just text", false, Vec::new());
        let prepared =
            prepare_markdown_export(&snapshot(root), "plain_assets").expect("prepare export");

        publish_markdown_export(&destination, &assets, &prepared, false).expect("publish export");

        assert!(destination.is_file());
        assert!(!assets.exists());
        assert!(!assets.join(EXPORT_ASSET_MARKER_NAME).exists());
    }

    #[cfg(windows)]
    #[test]
    fn notes_export_windows_overwrite_displaces_a_document_symlink_without_following_it() {
        use std::os::windows::fs::symlink_file;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let target = temp_dir.path().join("symlink-target.md");
        let destination = temp_dir.path().join("plain.md");
        let assets = temp_dir.path().join("plain_assets");
        std::fs::write(&target, b"target stays untouched").expect("symlink target");
        symlink_file("symlink-target.md", &destination).expect("destination symlink");
        let root = export_node(ROOT_ID, "Project", "replacement", false, Vec::new());
        let prepared =
            prepare_markdown_export(&snapshot(root), "plain_assets").expect("prepare export");

        publish_markdown_export(&destination, &assets, &prepared, true)
            .expect("overwrite destination symlink");

        assert_eq!(
            std::fs::read(&target).expect("symlink target survives"),
            b"target stays untouched"
        );
        let metadata = std::fs::symlink_metadata(&destination).expect("published document");
        assert!(metadata.file_type().is_file());
        assert!(!metadata.file_type().is_symlink());
        assert_eq!(
            std::fs::read(&destination).expect("published bytes"),
            prepared.markdown
        );
        assert!(!assets.exists());
    }

    #[test]
    fn notes_export_post_publish_parent_sync_failure_keeps_success_semantics() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("synced.md");
        let assets = temp_dir.path().join("synced_assets");
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            "image.png",
            Some(vec![1, 2, 3]),
        ));
        let prepared =
            prepare_markdown_export(&snapshot(root), "synced_assets").expect("prepare export");
        inject_export_parent_sync_failure_once();

        publish_markdown_export(&destination, &assets, &prepared, false)
            .expect("committed output remains a successful export");

        assert!(destination.is_file());
        assert_eq!(
            std::fs::read(assets.join("0001.png")).expect("asset"),
            [1, 2, 3]
        );
    }

    #[cfg(not(unix))]
    #[test]
    fn notes_export_directory_sync_is_a_noop_without_unix_directory_handles() {
        sync_export_directory(Path::new("directory-that-does-not-exist"))
            .expect("non-Unix directory sync no-op");
    }

    #[test]
    fn export_snapshot_rejects_a_missing_deleted_or_archived_root() {
        let connection = seeded_export_connection();
        connection
            .execute(
                "UPDATE notes_nodes SET archived_at = '2026-07-12T00:00:00.000Z' WHERE id = ?1",
                [ROOT_ID],
            )
            .expect("archive root fixture");

        let missing = load_export_snapshot(&connection, "77777777-7777-4777-8777-777777777777")
            .expect_err("missing root");
        let deleted = load_export_snapshot(&connection, DELETED_ID).expect_err("deleted root");
        let archived = load_export_snapshot(&connection, ROOT_ID).expect_err("archived root");

        assert!(missing.contains("missing, deleted, or archived"));
        assert!(deleted.contains("missing, deleted, or archived"));
        assert!(archived.contains("missing, deleted, or archived"));
    }

    #[test]
    fn export_snapshot_excludes_archived_descendant_dates_and_attachments() {
        let connection = seeded_export_connection();
        connection
            .execute(
                "UPDATE notes_nodes SET archived_at = '2026-07-12T00:00:00.000Z' WHERE id = ?1",
                [FIRST_ID],
            )
            .expect("archive descendant fixture");
        insert_date_span(
            &connection,
            FIRST_ID,
            "title",
            &ExportDateSpan {
                start_utf16: 0,
                end_utf16: 5,
                normalized_start: "2026-07-12".to_string(),
                normalized_end: "2026-07-12".to_string(),
            },
            "First",
        );
        connection
            .execute(
                "INSERT INTO notes_attachments (
                   id, node_id, sort_key, relative_path, content_hash, original_name,
                   mime_type, byte_size, intrinsic_width, intrinsic_height, display_width,
                   created_at, updated_at
                 ) VALUES (?1, ?2, 1024, ?3, ?4, 'archived.png', 'image/png', 3, 1, 1, 1,
                           '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')",
                params![
                    SECOND_ID,
                    FIRST_ID,
                    format!("notes-assets/{}.png", "a".repeat(64)),
                    "a".repeat(64)
                ],
            )
            .expect("insert archived attachment fixture");

        let snapshot = load_export_snapshot(&connection, ROOT_ID).expect("active root snapshot");

        assert!(!snapshot
            .root
            .children
            .iter()
            .any(|child| child.id == FIRST_ID));
    }

    #[test]
    fn export_snapshot_rejects_cyclic_tree_corruption() {
        let connection = export_connection();
        insert_node(
            &connection,
            SeedNode::active(ROOT_ID, Some(FIRST_ID), 1024, "Cycle one"),
        );
        insert_node(
            &connection,
            SeedNode::active(FIRST_ID, Some(ROOT_ID), 1024, "Cycle two"),
        );

        let error = load_export_snapshot(&connection, ROOT_ID).expect_err("cycle");

        assert!(error.contains("cycle"));
    }

    #[test]
    fn markdown_renderer_matches_the_deterministic_frontmatter_and_tree_byte_contract() {
        let snapshot = snapshot(export_node(
            ROOT_ID,
            "Project",
            "Root note",
            false,
            vec![export_node(FIRST_ID, "First task", "", true, Vec::new())],
        ));

        let rendered = render_markdown(&snapshot).expect("render Markdown");

        assert_eq!(
            rendered,
            concat!(
                "---\n",
                "kind: yonalist-notes-export\n",
                "format_version: 1\n",
                "source: notes.sqlite\n",
                "root_node_id: \"11111111-1111-4111-8111-111111111111\"\n",
                "exported_at: \"2026-07-10T12:34:56.789Z\"\n",
                "---\n",
                "\n",
                "# Project\n",
                "\n",
                "- [ ] Project <!-- yonalist-node-id: 11111111-1111-4111-8111-111111111111 -->\n",
                "  > Root note\n",
                "  - [x] First task <!-- yonalist-node-id: 22222222-2222-4222-8222-222222222222 -->\n",
            )
            .as_bytes()
        );
        assert!(rendered.ends_with(b"\n"));
        assert!(!rendered.ends_with(b"\n\n"));
    }

    #[test]
    fn markdown_nested_image_node_is_primary_content_with_description_and_children_in_order() {
        let root = export_node(
            ROOT_ID,
            "Project",
            "",
            false,
            vec![
                image_node(
                    FIRST_ID,
                    "hidden-nested.png",
                    "Visible image description",
                    true,
                    export_attachment(COLLAPSED_CHILD_ID, "hidden-nested.png", Some(vec![1, 2, 3])),
                    vec![export_node(
                        SECOND_ID,
                        "Child after image",
                        "",
                        false,
                        Vec::new(),
                    )],
                ),
                export_node(LATER_ID, "Later sibling", "", false, Vec::new()),
            ],
        );

        let prepared = prepare_markdown_export(&snapshot(root), "project_assets")
            .expect("prepare nested image Markdown");

        assert_eq!(
            prepared.markdown,
            concat!(
                "---\n",
                "kind: yonalist-notes-export\n",
                "format_version: 1\n",
                "source: notes.sqlite\n",
                "root_node_id: \"11111111-1111-4111-8111-111111111111\"\n",
                "exported_at: \"2026-07-10T12:34:56.789Z\"\n",
                "---\n",
                "\n",
                "# Project\n",
                "\n",
                "- [ ] Project <!-- yonalist-node-id: 11111111-1111-4111-8111-111111111111 -->\n",
                "  - [x] ![Image](project_assets/0001.png) <!-- yonalist-attachment-original-name: hidden%2Dnested.png --> <!-- yonalist-node-id: 22222222-2222-4222-8222-222222222222 -->\n",
                "    > Visible image description\n",
                "    - [ ] Child after image <!-- yonalist-node-id: 33333333-3333-4333-8333-333333333333 -->\n",
                "  - [ ] Later sibling <!-- yonalist-node-id: 44444444-4444-4444-8444-444444444444 -->\n",
            )
            .as_bytes()
        );
        let source = std::str::from_utf8(&prepared.markdown).expect("UTF-8 Markdown");
        assert!(source.contains("![Image](project_assets/0001.png)"));
        assert!(!source.contains("# hidden-nested.png"), "{source}");
        assert!(!source.contains("> hidden-nested.png"), "{source}");
        assert_eq!(prepared.assets.len(), 1);
    }

    #[test]
    fn markdown_root_image_node_omits_visible_filename_heading_and_keeps_description() {
        let root = image_node(
            ROOT_ID,
            "hidden [root].png",
            "Root image description",
            false,
            export_attachment(FIRST_ID, "hidden [root].png", Some(vec![1, 2, 3])),
            vec![export_node(SECOND_ID, "Child task", "", false, Vec::new())],
        );

        let prepared = prepare_markdown_export(&snapshot(root), "root-image_assets")
            .expect("prepare root image Markdown");

        assert_eq!(
            prepared.markdown,
            concat!(
                "---\n",
                "kind: yonalist-notes-export\n",
                "format_version: 1\n",
                "source: notes.sqlite\n",
                "root_node_id: \"11111111-1111-4111-8111-111111111111\"\n",
                "exported_at: \"2026-07-10T12:34:56.789Z\"\n",
                "---\n",
                "\n",
                "- [ ] ![Image](root-image_assets/0001.png) <!-- yonalist-attachment-original-name: hidden%20%5Broot%5D.png --> <!-- yonalist-node-id: 11111111-1111-4111-8111-111111111111 -->\n",
                "  > Root image description\n",
                "  - [ ] Child task <!-- yonalist-node-id: 33333333-3333-4333-8333-333333333333 -->\n",
            )
            .as_bytes()
        );
        let source = std::str::from_utf8(&prepared.markdown).expect("UTF-8 Markdown");
        assert!(source.contains("![Image](root-image_assets/0001.png)"));
        assert!(!source.contains("# hidden [root].png"), "{source}");
        assert!(!source.contains("> hidden [root].png"), "{source}");
    }

    #[test]
    fn markdown_image_node_omits_title_and_round_trips_parser_sensitive_metadata() {
        let printable_ascii = (0x20_u8..=0x7e).map(char::from).collect::<String>();
        for original_name in [
            "hidden [root] (final) \"quoted\" &amp; <angle>.png",
            printable_ascii.as_str(),
            "사진 [원본] (최종) &amp; \"인용\".png",
            "a &amp; b.png",
            "literal &#42; &#x2A; &quot;.png",
            r#"comment --> (round) [square] 100%.png"#,
        ] {
            let root = image_node(
                ROOT_ID,
                original_name,
                "",
                false,
                export_attachment(FIRST_ID, original_name, Some(vec![1, 2, 3])),
                Vec::new(),
            );
            let prepared = prepare_markdown_export(&snapshot(root), "image_assets")
                .expect("prepare parser-sensitive image-node Markdown");

            assert_eq!(
                parse_exported_native_image(&prepared.markdown),
                ParsedNativeMarkdownImage {
                    source: "image_assets/0001.png".to_string(),
                    alt: "Image".to_string(),
                    title: None,
                }
            );
            assert_eq!(
                exported_markdown_original_name(&prepared.markdown),
                original_name
            );
        }
    }

    #[test]
    fn markdown_image_metadata_is_one_valid_html_comment_for_repeated_hyphens() {
        let original_name = "before----middle-->after-->.png";
        let root = image_node(
            ROOT_ID,
            original_name,
            "",
            false,
            export_attachment(FIRST_ID, original_name, Some(vec![1, 2, 3])),
            Vec::new(),
        );

        let prepared = prepare_markdown_export(&snapshot(root), "image_assets")
            .expect("prepare comment-sensitive image-node Markdown");
        let source = std::str::from_utf8(&prepared.markdown).expect("UTF-8 Markdown");
        let metadata_prefix = "<!-- yonalist-attachment-original-name: ";
        let encoded = source
            .split_once(metadata_prefix)
            .expect("metadata opener")
            .1
            .split_once(" -->")
            .expect("metadata closer")
            .0;
        let image_line = source
            .lines()
            .find(|line| line.contains("![Image]("))
            .expect("image-node line");

        assert!(
            !encoded.contains('-'),
            "invalid HTML comment body: {encoded}"
        );
        assert!(encoded.contains("%2D%2D%3E"), "{encoded}");
        assert_eq!(image_line.matches("-->").count(), 2, "{image_line}");
        assert_eq!(
            exported_markdown_original_name(&prepared.markdown),
            original_name
        );
        assert_eq!(parse_exported_native_image(&prepared.markdown).title, None);
        assert!(!source.contains(original_name), "{source}");
    }

    #[test]
    fn markdown_image_node_accepts_path_like_and_control_original_name_as_hidden_metadata() {
        let original_name = "../folder\\line\tname\r\nnul\0.png";
        let root = image_node(
            ROOT_ID,
            original_name,
            "",
            false,
            export_attachment(FIRST_ID, original_name, Some(vec![1, 2, 3])),
            Vec::new(),
        );

        let prepared = prepare_markdown_export(&snapshot(root), "image_assets")
            .expect("prepare image-node Markdown");
        let source = std::str::from_utf8(&prepared.markdown).expect("UTF-8 Markdown");
        let parsed = parse_exported_native_image(&prepared.markdown);

        assert_eq!(
            parsed,
            ParsedNativeMarkdownImage {
                source: "image_assets/0001.png".to_string(),
                alt: "Image".to_string(),
                title: None,
            }
        );
        assert_eq!(
            exported_markdown_original_name(&prepared.markdown),
            original_name
        );
        assert!(source.contains(
            "<!-- yonalist-attachment-original-name: ..%2Ffolder%5Cline%09name%0D%0Anul%00.png -->"
        ));
        assert!(!source.contains(['\t', '\r', '\0']), "{source:?}");
        assert_eq!(prepared.assets.len(), 1);
        assert_eq!(prepared.assets[0].file_name, "0001.png");
    }

    #[test]
    fn markdown_text_node_legacy_attachment_output_remains_byte_compatible() {
        let mut root = export_node(
            ROOT_ID,
            "Project",
            "Root note",
            false,
            vec![export_node(SECOND_ID, "Child task", "", false, Vec::new())],
        );
        root.attachments.push(export_attachment(
            FIRST_ID,
            "legacy diagram.png",
            Some(vec![1, 2, 3]),
        ));

        let prepared = prepare_markdown_export(&snapshot(root), "legacy_assets")
            .expect("prepare legacy attachment Markdown");

        assert_eq!(
            prepared.markdown,
            concat!(
                "---\n",
                "kind: yonalist-notes-export\n",
                "format_version: 1\n",
                "source: notes.sqlite\n",
                "root_node_id: \"11111111-1111-4111-8111-111111111111\"\n",
                "exported_at: \"2026-07-10T12:34:56.789Z\"\n",
                "---\n",
                "\n",
                "# Project\n",
                "\n",
                "- [ ] Project <!-- yonalist-node-id: 11111111-1111-4111-8111-111111111111 -->\n",
                "  > Root note\n",
                "  ![legacy diagram.png](legacy_assets/0001.png)\n",
                "  - [ ] Child task <!-- yonalist-node-id: 33333333-3333-4333-8333-333333333333 -->\n",
            )
            .as_bytes()
        );
    }

    #[test]
    fn markdown_text_node_legacy_attachment_accepts_untrusted_original_name() {
        let original_name = "../folder\\draft\tname\r\nnul\0.png";
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments.push(export_attachment(
            FIRST_ID,
            original_name,
            Some(vec![1, 2, 3]),
        ));

        let prepared = prepare_markdown_export(&snapshot(root), "legacy_assets")
            .expect("prepare legacy attachment with untrusted name");
        let source = std::str::from_utf8(&prepared.markdown).expect("UTF-8 Markdown");

        assert!(source.contains("  ![../folder\\\\draft name nul .png](legacy_assets/0001.png)\n"));
        assert!(!source.contains("yonalist-attachment-original-name"));
        assert_eq!(prepared.assets.len(), 1);
        assert_eq!(prepared.assets[0].file_name, "0001.png");
    }

    #[test]
    fn markdown_renderer_escapes_markdown_and_comment_sensitive_text_consistently() {
        let unsafe_text = r#"A \ *bold* [link](x) #tag <!-- forged --> & done"#;
        let snapshot = snapshot(export_node(
            ROOT_ID,
            unsafe_text,
            unsafe_text,
            false,
            Vec::new(),
        ));

        let rendered = String::from_utf8(render_markdown(&snapshot).expect("render Markdown"))
            .expect("UTF-8 Markdown");
        let escaped = r#"A \\ \*bold\* \[link\]\(x\) \#tag &lt;\!\-\- forged \-\-&gt; &amp; done"#;

        assert!(rendered.contains(&format!("# {escaped}\n")));
        assert!(rendered.contains(&format!(
            "- [ ] {escaped} <!-- yonalist-node-id: {ROOT_ID} -->\n"
        )));
        assert!(rendered.contains(&format!("  > {escaped}\n")));
        assert_eq!(rendered.matches("<!--").count(), 1);
        assert_eq!(rendered.matches("-->").count(), 1);
    }

    #[test]
    fn markdown_renderer_preserves_inline_formatting_markers() {
        // Inline formatting (the Workflowy-style markdown subset from Phase 4.2)
        // is stored as PLAIN TEXT. Every marker character survives the export;
        // it is backslash-escaped for markdown safety, exactly like any other
        // punctuation (see the escaping-consistency test above). Emitting the
        // markers as *live* markdown formatting on export is a deliberate
        // follow-up, tracked alongside rich PDF styling.
        let source = "**bold** *italic* ~~strike~~ `code`";
        let snapshot = snapshot(export_node(ROOT_ID, "Formats", source, false, Vec::new()));

        let rendered = String::from_utf8(render_markdown(&snapshot).expect("render Markdown"))
            .expect("UTF-8 Markdown");

        let escaped = r#"\*\*bold\*\* \*italic\* \~\~strike\~\~ \`code\`"#;
        assert!(
            rendered.contains(&format!("  > {escaped}\n")),
            "rendered: {rendered}"
        );
        // No marker character is dropped from the exported payload.
        assert_eq!(source.matches('*').count(), rendered.matches(r"\*").count());
        assert_eq!(source.matches('~').count(), rendered.matches(r"\~").count());
        assert_eq!(source.matches('`').count(), rendered.matches(r"\`").count());
    }

    #[test]
    fn markdown_renderer_normalizes_crlf_and_preserves_blank_multiline_note_lines() {
        let snapshot = snapshot(export_node(
            ROOT_ID,
            "Project",
            "first\r\n\rsecond\nthird",
            false,
            Vec::new(),
        ));

        let rendered = String::from_utf8(render_markdown(&snapshot).expect("render Markdown"))
            .expect("UTF-8 Markdown");

        assert!(rendered.contains("  > first\n  >\n  > second\n  > third\n"));
        assert!(!rendered.contains('\r'));
    }

    #[test]
    fn markdown_keeps_raw_dates_while_pdf_display_helper_replaces_spans_end_to_start() {
        let source = "😀 today then tomorrow";
        let matches = vec![
            ExportDateSpan {
                start_utf16: 3,
                end_utf16: 8,
                normalized_start: "2026-07-11".to_string(),
                normalized_end: "2026-07-11".to_string(),
            },
            ExportDateSpan {
                start_utf16: 14,
                end_utf16: 22,
                normalized_start: "2026-07-12".to_string(),
                normalized_end: "2026-07-12".to_string(),
            },
        ];
        let snapshot = snapshot(export_node(ROOT_ID, source, "", false, vec![]));
        let markdown = String::from_utf8(render_markdown(&snapshot).expect("render Markdown"))
            .expect("UTF-8 Markdown");

        assert!(markdown.contains(source));
        assert_eq!(
            format_date_matches_for_pdf_display(source, &matches).expect("format indexed dates"),
            "😀 Jul 11, 2026 then Jul 12, 2026"
        );
    }

    #[test]
    fn pdf_uses_immutable_indexed_dates_without_reparsing_relative_export_text() {
        let connection = seeded_export_connection();
        connection
            .execute(
                "UPDATE notes_nodes SET title = 'today then 07/12/2026', note = 'tomorrow' \
                 WHERE id = ?1",
                [ROOT_ID],
            )
            .expect("set raw relative export text");
        insert_date_span(
            &connection,
            ROOT_ID,
            "title",
            &ExportDateSpan {
                start_utf16: 0,
                end_utf16: 5,
                normalized_start: "2031-02-03".to_string(),
                normalized_end: "2031-02-03".to_string(),
            },
            "today",
        );
        insert_date_span(
            &connection,
            ROOT_ID,
            "title",
            &ExportDateSpan {
                start_utf16: 11,
                end_utf16: 21,
                normalized_start: "2040-04-05".to_string(),
                normalized_end: "2040-04-05".to_string(),
            },
            "07/12/2026",
        );
        insert_date_span(
            &connection,
            ROOT_ID,
            "note",
            &ExportDateSpan {
                start_utf16: 0,
                end_utf16: 8,
                normalized_start: "2050-06-07".to_string(),
                normalized_end: "2050-06-07".to_string(),
            },
            "tomorrow",
        );

        let snapshot = load_export_snapshot(&connection, ROOT_ID).expect("dated snapshot");
        assert_eq!(
            snapshot.root.title_date_spans,
            vec![
                ExportDateSpan {
                    start_utf16: 0,
                    end_utf16: 5,
                    normalized_start: "2031-02-03".to_string(),
                    normalized_end: "2031-02-03".to_string(),
                },
                ExportDateSpan {
                    start_utf16: 11,
                    end_utf16: 21,
                    normalized_start: "2040-04-05".to_string(),
                    normalized_end: "2040-04-05".to_string(),
                },
            ]
        );
        assert_eq!(snapshot.root.note_date_spans.len(), 1);
        let markdown = String::from_utf8(render_markdown(&snapshot).expect("raw Markdown"))
            .expect("UTF-8 Markdown");
        assert!(markdown.contains("today then 07\\/12\\/2026"));
        assert!(markdown.contains("> tomorrow"));

        let bytes = render_pdf(&snapshot).expect("render indexed date PDF");
        let mut parsed = parse_pdf(&bytes);
        let text = extracted_pdf_pages(&mut parsed).join(" ");
        assert!(text.contains("Feb 3, 2031 then Apr 5, 2040"), "{text}");
        assert!(text.contains("> Jun 7, 2050"), "{text}");
        assert!(!text.contains("today"), "{text}");
        assert!(!text.contains("tomorrow"), "{text}");
    }

    #[test]
    fn notes_export_snapshot_keeps_node_text_and_dates_in_one_concurrent_read_generation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let database_path = temp_dir.path().join("snapshot.sqlite");
        let reader = Connection::open(&database_path).expect("open reader");
        reader
            .pragma_update(None, "journal_mode", "WAL")
            .expect("enable WAL");
        initialize_export_connection(&reader);
        insert_node(&reader, SeedNode::active(ROOT_ID, None, 0, "today"));
        insert_date_span(
            &reader,
            ROOT_ID,
            "title",
            &ExportDateSpan {
                start_utf16: 0,
                end_utf16: 5,
                normalized_start: "2026-07-12".to_string(),
                normalized_end: "2026-07-12".to_string(),
            },
            "today",
        );
        let writer = Connection::open(&database_path).expect("open writer");
        crate::notes::repository::inject_export_snapshot_query_boundary_once(move || {
            let transaction = writer.unchecked_transaction().expect("writer transaction");
            transaction
                .execute(
                    "UPDATE notes_nodes SET title = 'later' WHERE id = ?1",
                    [ROOT_ID],
                )
                .expect("update concurrent text");
            transaction
                .execute("DELETE FROM notes_dates WHERE node_id = ?1", [ROOT_ID])
                .expect("delete old date");
            transaction
                .execute(
                    "INSERT INTO notes_dates (node_id, field, start_utf16, end_utf16, \
                       normalized_start, normalized_end, token_text) \
                     VALUES (?1, 'title', 0, 5, '2030-01-02', '2030-01-02', 'later')",
                    [ROOT_ID],
                )
                .expect("insert concurrent date");
            transaction.commit().expect("commit concurrent edit");
        });

        let snapshot = load_export_snapshot(&reader, ROOT_ID).expect("coherent snapshot");

        assert_eq!(snapshot.root.title, "today");
        assert_eq!(snapshot.root.title_date_spans.len(), 1);
        assert_eq!(
            snapshot.root.title_date_spans[0].normalized_start,
            "2026-07-12"
        );
    }

    #[test]
    fn date_heavy_export_loads_nodes_once_and_formats_indexed_spans_in_one_utf16_walk() {
        const SPAN_COUNT: usize = 4_096;
        let connection = export_connection();
        let source = std::iter::repeat("😀today")
            .take(SPAN_COUNT)
            .collect::<Vec<_>>()
            .join(" ");
        insert_node(
            &connection,
            SeedNode {
                note: &source,
                ..SeedNode::active(ROOT_ID, None, 1024, "Date scale")
            },
        );
        let token_utf16 = "😀today".encode_utf16().count();
        for index in 0..SPAN_COUNT {
            let start_utf16 = index * (token_utf16 + 1) + 2;
            insert_date_span(
                &connection,
                ROOT_ID,
                "note",
                &ExportDateSpan {
                    start_utf16,
                    end_utf16: start_utf16 + 5,
                    normalized_start: "2032-03-04".to_string(),
                    normalized_end: "2032-03-04".to_string(),
                },
                "today",
            );
        }

        let (snapshot, row_counts) =
            crate::notes::repository::load_export_snapshot_with_row_counts(&connection, ROOT_ID)
                .expect("date-heavy snapshot");

        assert_eq!(row_counts.node_rows, 1);
        assert_eq!(row_counts.date_rows, SPAN_COUNT);
        assert_eq!(snapshot.root.note_date_spans.len(), SPAN_COUNT);
        let (rendered, visited_utf16) = format_date_matches_for_pdf_display_with_work(
            &snapshot.root.note,
            &snapshot.root.note_date_spans,
        )
        .expect("linear indexed date formatting");
        assert_eq!(rendered.matches("Mar 4, 2032").count(), SPAN_COUNT);
        assert!(!rendered.contains("today"));
        assert!(visited_utf16 <= source.encode_utf16().count());
    }

    #[test]
    fn markdown_renderer_rejects_an_invalid_descendant_without_returning_injected_markdown() {
        let snapshot = snapshot(export_node(
            ROOT_ID,
            "Project",
            "",
            false,
            vec![export_node(
                INVALID_DESCENDANT_ID,
                "Injected child",
                "",
                false,
                Vec::new(),
            )],
        ));

        let error = render_markdown(&snapshot)
            .expect_err("invalid descendant must not return Markdown bytes");

        assert_eq!(error, "Note ID must be a canonical UUID v4 string.");
    }

    #[test]
    fn pdf_font_asset_parses_and_maps_required_korean_punctuation_and_ascii_glyphs() {
        let mut warnings = Vec::new();
        let font =
            ParsedFont::from_bytes(PDF_FONT_BYTES, 0, &mut warnings).expect("parse bundled font");

        for codepoint in 0xAC00..=0xD7A3 {
            let character = char::from_u32(codepoint).expect("modern Hangul syllable");
            let glyph = font
                .lookup_glyph_index(character as u32)
                .unwrap_or_else(|| panic!("missing Korean glyph U+{codepoint:04X}"));
            assert!(
                font.get_horizontal_advance(glyph) > 0,
                "Korean glyph U+{codepoint:04X} has no advance"
            );
        }

        for character in "ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎㅏㅑㅓㅕㅗㅛㅜㅠㅡㅣ·…“”‘’「」『』〈〉《》()[]{}<>.,!?;:'\"-_/\\#&+*= 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".chars() {
            let glyph = font
                .lookup_glyph_index(character as u32)
                .unwrap_or_else(|| panic!("missing required glyph U+{:04X}", character as u32));
            assert!(
                font.get_horizontal_advance(glyph) > 0,
                "required glyph U+{:04X} has no advance",
                character as u32
            );
        }
    }

    #[test]
    fn pdf_export_keeps_small_korean_document_under_three_megabytes() {
        let bytes = render_pdf(&korean_snapshot()).expect("render small Korean PDF");

        assert!(
            bytes.len() < 3_000_000,
            "small Korean PDF was {} bytes",
            bytes.len()
        );
    }

    #[test]
    fn pdf_export_serializes_parseable_a4_document_for_korean_snapshot() {
        let bytes = render_pdf(&korean_snapshot()).expect("render PDF");

        assert!(bytes.starts_with(b"%PDF-"));
        assert!(bytes.len() > 1_024);
        assert!(bytes.windows(5).any(|window| window == b"%%EOF"));

        let parsed = parse_pdf(&bytes);
        assert_eq!(parsed.page_count(), 1);
        let expected_width: Pt = Mm(210.0).into();
        let expected_height: Pt = Mm(297.0).into();
        assert!((parsed.pages[0].media_box.width.0 - expected_width.0).abs() < 1.0);
        assert!((parsed.pages[0].media_box.height.0 - expected_height.0).abs() < 1.0);
    }

    #[test]
    fn pdf_serialization_validation_checks_the_structural_page_count() {
        let mut document = PdfDocument::new("validation fixture");
        document.with_pages(vec![PdfPage::new(Mm(210.0), Mm(297.0), Vec::new())]);
        let mut warnings = Vec::new();
        let bytes = document.save(&Default::default(), &mut warnings);

        validate_serialized_pdf(&bytes, 1).expect("validate one-page PDF");
        assert_eq!(
            validate_serialized_pdf(&bytes, 2).expect_err("reject changed page count"),
            "Generated PDF page count changed during serialization."
        );
    }

    #[test]
    fn pdf_export_preserves_korean_text_and_embeds_a_unicode_font() {
        let bytes = render_pdf(&korean_snapshot()).expect("render PDF");
        let mut parsed = parse_pdf(&bytes);
        let text = extracted_pdf_pages(&mut parsed).join(" ");

        assert!(text.contains("프로젝트 · Project 2026"));
        assert!(text.contains("한글 메모 “Korean note”"));
        assert!(text.contains("[x] 완료 작업 - ASCII 42"));
        assert!(text.contains("지원 설명… supporting detail!"));
        assert!(text.contains("Page 1 / 1"));
        assert_eq!(parsed.resources.fonts.map.len(), 1);
        assert!(bytes
            .windows(b"/ToUnicode".len())
            .any(|window| window == b"/ToUnicode"));
        assert!(
            bytes
                .windows(b"/FontFile2".len())
                .any(|window| window == b"/FontFile2")
                || bytes
                    .windows(b"/FontFile3".len())
                    .any(|window| window == b"/FontFile3")
        );
    }

    #[test]
    fn pdf_export_wraps_long_korean_rows_without_losing_text() {
        let long_title = "긴한글제목".repeat(36);
        let long_note = "긴한글메모".repeat(36);
        let rendered = render_pdf(&snapshot(export_node(
            ROOT_ID,
            &long_title,
            &long_note,
            false,
            Vec::new(),
        )))
        .expect("render wrapped PDF");
        let mut parsed = parse_pdf(&rendered);
        let text = extracted_pdf_pages(&mut parsed)
            .join("")
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<String>();

        assert!(text.contains(&long_title));
        assert!(text.contains(&long_note));
    }

    #[test]
    fn pdf_export_keeps_rows_whole_across_numbered_pages() {
        let sentinel_id = "77777777-7777-4777-8777-777777777777";
        let sentinel_title = "페이지 경계 제목 Boundary title";
        let sentinel_note = "페이지 경계 메모 Boundary note";
        let mut children = (0..72)
            .map(|index| {
                export_node(
                    &format!("{index:08x}-0000-4000-8000-{index:012x}"),
                    &format!("행 {index:02} Outline row"),
                    "",
                    false,
                    Vec::new(),
                )
            })
            .collect::<Vec<_>>();
        children.insert(
            48,
            export_node(
                sentinel_id,
                sentinel_title,
                sentinel_note,
                false,
                Vec::new(),
            ),
        );
        let bytes = render_pdf(&snapshot(export_node(
            ROOT_ID,
            "긴 프로젝트 Long project",
            "",
            false,
            children,
        )))
        .expect("render multi-page PDF");
        let mut parsed = parse_pdf(&bytes);
        let pages = extracted_pdf_pages(&mut parsed);

        assert!(pages.len() > 1);
        for (index, page) in pages.iter().enumerate() {
            assert!(page.contains(&format!("Page {} / {}", index + 1, pages.len())));
        }
        let sentinel_page = pages
            .iter()
            .find(|page| page.contains(sentinel_title))
            .expect("sentinel title page");
        assert!(sentinel_page.contains(sentinel_note));
    }

    #[test]
    fn pdf_export_embeds_attachment_images_in_order_with_filename_captions() {
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        let mut first = export_attachment(FIRST_ID, "first diagram.png", Some(encoded_png(40, 20)));
        first.byte_size = first.bytes.as_ref().expect("first bytes").len() as i64;
        first.intrinsic_width = 40;
        first.intrinsic_height = 20;
        first.display_width = 40;
        let mut second =
            export_attachment(SECOND_ID, "second diagram.png", Some(encoded_png(20, 40)));
        second.byte_size = second.bytes.as_ref().expect("second bytes").len() as i64;
        second.intrinsic_width = 20;
        second.intrinsic_height = 40;
        second.display_width = 20;
        root.attachments = vec![first, second];
        let snapshot = snapshot(root);
        let mut warnings = Vec::new();
        let font = ParsedFont::from_bytes(PDF_FONT_BYTES, 0, &mut warnings).expect("font");

        let drafts = build_pdf_pages(&font, &snapshot).expect("attachment page drafts");
        let image_ids = drafts
            .iter()
            .flat_map(|page| page.images.iter().map(|image| image.attachment_id.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(image_ids, vec![FIRST_ID, SECOND_ID]);
        let draft_text = drafts
            .iter()
            .flat_map(|page| page.lines.iter().map(|line| line.text.as_str()))
            .collect::<Vec<_>>()
            .join(" ");
        assert!(draft_text.contains("first diagram.png"), "{draft_text}");
        assert!(draft_text.contains("second diagram.png"), "{draft_text}");

        let bytes = render_pdf(&snapshot).expect("render attachment PDF");
        let structural = lopdf::Document::load_mem(&bytes).expect("parse PDF structure");
        assert!(structural.objects.values().any(|object| {
            object
                .as_stream()
                .ok()
                .and_then(|stream| stream.dict.get(b"Subtype").ok())
                .and_then(|subtype| subtype.as_name().ok())
                == Some(&b"Image"[..])
        }));
        let mut parsed = parse_pdf(&bytes);
        let text = extracted_pdf_pages(&mut parsed).join(" ");
        assert!(text.contains("first diagram.png"), "{text}");
        assert!(text.contains("second diagram.png"), "{text}");
    }

    #[test]
    fn pdf_text_node_legacy_attachment_accepts_untrusted_original_name() {
        let original_name = "../folder\\draft\tname\r\nnul\0.png";
        let presented_name = "../folder\\draft name nul .png";
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments
            .push(png_export_attachment(FIRST_ID, original_name, 40, 20));

        let bytes = render_pdf(&snapshot(root))
            .expect("render legacy attachment with untrusted original name");
        assert_eq!(serialized_pdf_image_alt_texts(&bytes), vec![presented_name]);
        let mut parsed = parse_pdf(&bytes);
        let text = extracted_pdf_pages(&mut parsed).join(" ");

        assert!(text.contains(presented_name), "{text:?}");
        assert!(!text.contains(['\t', '\r', '\0']), "{text:?}");
    }

    #[test]
    fn pdf_nested_image_node_uses_image_as_primary_content_without_filename_caption() {
        let root = export_node(
            ROOT_ID,
            "Project",
            "",
            false,
            vec![
                image_node(
                    FIRST_ID,
                    "hidden-nested.png",
                    "Visible image description",
                    true,
                    png_export_attachment(COLLAPSED_CHILD_ID, "hidden-nested.png", 120, 80),
                    vec![export_node(
                        SECOND_ID,
                        "Child after image",
                        "",
                        false,
                        Vec::new(),
                    )],
                ),
                export_node(LATER_ID, "Later sibling", "", false, Vec::new()),
            ],
        );
        let snapshot = snapshot(root);
        let mut warnings = Vec::new();
        let font = ParsedFont::from_bytes(PDF_FONT_BYTES, 0, &mut warnings).expect("font");

        let drafts = build_pdf_pages(&font, &snapshot).expect("image-node page drafts");
        let draft_images = drafts
            .iter()
            .enumerate()
            .flat_map(|(page_index, page)| page.images.iter().map(move |image| (page_index, image)))
            .collect::<Vec<_>>();
        assert_eq!(draft_images.len(), 1);
        let (image_page_index, image) = draft_images[0];
        assert_eq!(image.attachment_id, COLLAPSED_CHILD_ID);
        let (content_left, content_right, content_bottom, content_top) = pdf_content_bounds();
        assert!(image.x >= content_left);
        assert!(image.x + image.width <= content_right + 0.01);
        assert!(image.y >= content_bottom);
        assert!(image.y + image.height <= content_top + 0.01);
        let expected_image_x = content_left + super::PDF_DEPTH_INDENT + super::PDF_NOTE_INDENT;
        assert!((image.x - expected_image_x).abs() < 0.01);

        let image_page = &drafts[image_page_index];
        let marker = image_page
            .lines
            .iter()
            .find(|line| line.text == "[x]")
            .expect("image-node marker");
        let description = image_page
            .lines
            .iter()
            .find(|line| line.text.contains("Visible image description"))
            .expect("image-node description");
        let child = image_page
            .lines
            .iter()
            .find(|line| line.text.contains("Child after image"))
            .expect("image-node child");
        let sibling = image_page
            .lines
            .iter()
            .find(|line| line.text.contains("Later sibling"))
            .expect("later sibling");
        assert!((marker.x + super::PDF_NOTE_INDENT - image.x).abs() < 0.01);
        assert!(marker.y >= image.y);
        assert!(marker.y <= image.y + image.height);
        assert!((description.x - image.x).abs() < 0.01);
        assert!(description.y < image.y);
        assert!(description.y > child.y);
        assert!(child.y > sibling.y);

        let bytes = render_pdf(&snapshot).expect("render nested image PDF");
        assert_eq!(serialized_pdf_image_xobject_count(&bytes), 1);
        assert_eq!(parsed_pdf_image_use_count(&bytes), 1);
        let mut parsed = parse_pdf(&bytes);
        let text = extracted_pdf_pages(&mut parsed).join(" ");

        assert!(!text.contains("hidden-nested.png"), "{text}");
        assert!(text.contains("Visible image description"), "{text}");
        assert!(text.contains("[x]"), "{text}");
        let description = text.find("Visible image description").expect("description");
        let child = text.find("Child after image").expect("image child");
        let sibling = text.find("Later sibling").expect("later sibling");
        assert!(description < child && child < sibling, "{text}");
    }

    #[test]
    fn pdf_root_image_node_omits_visible_filename_title_and_keeps_description() {
        let original_name = "숨은 root image (최종).png";
        let root = image_node(
            ROOT_ID,
            original_name,
            "Root image description",
            false,
            png_export_attachment(FIRST_ID, original_name, 120, 80),
            vec![export_node(SECOND_ID, "Child task", "", false, Vec::new())],
        );

        let bytes = render_pdf(&snapshot(root)).expect("render root image PDF");
        let structural = lopdf::Document::load_mem(&bytes).expect("parse PDF structure");
        assert_eq!(structural.version, "1.5");
        assert_eq!(serialized_pdf_image_alt_texts(&bytes), vec![original_name]);
        let mut parsed = parse_pdf(&bytes);
        let text = extracted_pdf_pages(&mut parsed).join(" ");

        assert!(!text.contains(original_name), "{text}");
        assert!(text.contains("Root image description"), "{text}");
        assert!(text.contains("Child task"), "{text}");
        assert!(
            text.find("Root image description").expect("description")
                < text.find("Child task").expect("child"),
            "{text}"
        );
    }

    #[test]
    fn pdf_image_node_accepts_untrusted_original_name_as_accessibility_metadata() {
        let original_name = "../folder\\image\tname\r\nnul\0.png";
        let presented_name = "../folder\\image name nul .png";
        let root = image_node(
            ROOT_ID,
            original_name,
            "Visible description",
            false,
            png_export_attachment(FIRST_ID, original_name, 40, 20),
            Vec::new(),
        );

        let bytes =
            render_pdf(&snapshot(root)).expect("render image node with untrusted original name");
        assert_eq!(serialized_pdf_image_alt_texts(&bytes), vec![presented_name]);
        let mut parsed = parse_pdf(&bytes);
        let text = extracted_pdf_pages(&mut parsed).join(" ");

        assert!(!text.contains(presented_name), "{text:?}");
        assert!(text.contains("Visible description"), "{text:?}");
    }

    #[test]
    fn pdf_layout_keeps_paginated_image_node_marker_image_and_description_grouped() {
        let mut children = (0..68)
            .map(|index| {
                export_node(
                    &format!("{index:08x}-0000-4000-8000-{index:012x}"),
                    &format!("Outline row {index:02}"),
                    "",
                    false,
                    Vec::new(),
                )
            })
            .collect::<Vec<_>>();
        children.push(image_node(
            LATER_ID,
            "paginated-image.png",
            "Paginated image description",
            true,
            png_export_attachment(FIRST_ID, "paginated-image.png", 120, 90),
            vec![export_node(
                SECOND_ID,
                "Child after paginated image",
                "",
                false,
                Vec::new(),
            )],
        ));
        let snapshot = snapshot(export_node(
            ROOT_ID,
            "Long image project",
            "",
            false,
            children,
        ));
        let mut warnings = Vec::new();
        let font = ParsedFont::from_bytes(PDF_FONT_BYTES, 0, &mut warnings).expect("font");

        let drafts = build_pdf_pages(&font, &snapshot).expect("paginated image-node layout");
        let image_page_index = drafts
            .iter()
            .position(|page| !page.images.is_empty())
            .expect("image page");
        assert!(image_page_index > 0);
        let image_page = &drafts[image_page_index];
        assert_eq!(image_page.images.len(), 1);
        let image = &image_page.images[0];
        assert_eq!(image.attachment_id, FIRST_ID);
        let marker = image_page
            .lines
            .iter()
            .find(|line| line.text == "[x]")
            .expect("image-node marker");
        let description = image_page
            .lines
            .iter()
            .find(|line| line.text.contains("Paginated image description"))
            .expect("image-node description");
        let child = image_page
            .lines
            .iter()
            .find(|line| line.text.contains("Child after paginated image"))
            .expect("image-node child");

        assert!(marker.y >= image.y);
        assert!(marker.y <= image.y + image.height);
        assert!(description.y < image.y);
        assert!(description.y > child.y);
        assert!(!drafts[..image_page_index].iter().any(|page| {
            page.lines
                .iter()
                .any(|line| line.text == "[x]" || line.text.contains("Paginated image description"))
        }));

        let bytes = render_pdf(&snapshot).expect("render paginated image-node PDF");
        assert_eq!(serialized_pdf_image_xobject_count(&bytes), 1);
        assert_eq!(parsed_pdf_image_use_count(&bytes), 1);
        assert_eq!(
            serialized_pdf_image_alt_texts(&bytes),
            vec!["paginated-image.png"]
        );
        let mut parsed = parse_pdf(&bytes);
        let pages = extracted_pdf_pages(&mut parsed);
        assert!(pages[image_page_index].contains("[x]"));
        assert!(pages[image_page_index].contains("Paginated image description"));
        assert!(pages[image_page_index].contains("Child after paginated image"));
    }

    #[test]
    fn pdf_export_deterministically_decodes_the_first_animation_frame() {
        for (name, mime_type, bytes, first_pixel) in [
            (
                "animated.gif",
                "image/gif",
                encoded_animated_gif(),
                [0xe1, 0x12, 0x23, 0xff],
            ),
            (
                "animated.webp",
                "image/webp",
                encoded_animated_webp(),
                [0xd2, 0x21, 0x32, 0xff],
            ),
        ] {
            let rgba = decode_pdf_attachment_rgba(&bytes, mime_type)
                .unwrap_or_else(|error| panic!("decode {name}: {error}"));
            assert_eq!(rgba.dimensions(), (2, 3));
            let decoded_pixel = rgba.get_pixel(0, 0).0;
            assert!(
                decoded_pixel
                    .iter()
                    .zip(first_pixel)
                    .all(|(actual, expected)| actual.abs_diff(expected) <= 2),
                "{name}: {decoded_pixel:?}"
            );

            let mut attachment = export_attachment(FIRST_ID, name, Some(bytes.clone()));
            attachment.mime_type = mime_type.to_string();
            attachment.relative_path = format!(
                "notes-assets/{}.{}",
                "a".repeat(64),
                if mime_type == "image/gif" {
                    "gif"
                } else {
                    "webp"
                }
            );
            attachment.byte_size = bytes.len() as i64;
            attachment.intrinsic_width = 2;
            attachment.intrinsic_height = 3;
            attachment.display_width = 2;
            let mut root = export_node(ROOT_ID, "Animations", "", false, Vec::new());
            root.attachments.push(attachment);

            render_pdf(&snapshot(root)).unwrap_or_else(|error| panic!("render {name}: {error}"));
        }
    }

    #[test]
    fn notes_export_pdf_reuses_one_image_xobject_for_duplicate_payloads() {
        let png = encoded_png(40, 20);
        let mut first = export_attachment(FIRST_ID, "first copy.png", Some(png.clone()));
        first.byte_size = png.len() as i64;
        first.intrinsic_width = 40;
        first.intrinsic_height = 20;
        first.display_width = 40;
        let mut second = first.clone();
        second.id = SECOND_ID.to_string();
        second.original_name = "second copy.png".to_string();
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        root.attachments = vec![first, second];

        let bytes = render_pdf(&snapshot(root)).expect("render duplicate-image PDF");
        let structural = lopdf::Document::load_mem(&bytes).expect("parse PDF structure");
        let image_xobjects = structural
            .objects
            .values()
            .filter(|object| {
                object
                    .as_stream()
                    .ok()
                    .and_then(|stream| stream.dict.get(b"Subtype").ok())
                    .and_then(|subtype| subtype.as_name().ok())
                    == Some(&b"Image"[..])
            })
            .count();

        assert_eq!(image_xobjects, 1);
        assert_eq!(
            serialized_pdf_image_alt_texts(&bytes),
            vec!["first copy.png", "second copy.png"]
        );
        let mut parsed = parse_pdf(&bytes);
        let text = extracted_pdf_pages(&mut parsed).join(" ");
        assert!(text.contains("first copy.png"), "{text}");
        assert!(text.contains("second copy.png"), "{text}");
    }

    #[test]
    fn pdf_layout_preserves_aspect_ratio_and_caps_oversized_images_to_page_bounds() {
        let mut root = export_node(ROOT_ID, "Project", "", false, Vec::new());
        let mut attachment =
            export_attachment(FIRST_ID, "very tall.png", Some(encoded_png(100, 4000)));
        attachment.byte_size = attachment.bytes.as_ref().expect("bytes").len() as i64;
        attachment.intrinsic_width = 100;
        attachment.intrinsic_height = 4000;
        attachment.display_width = 100;
        root.attachments.push(attachment);
        let mut wide = export_attachment(SECOND_ID, "very wide.png", Some(encoded_png(4000, 100)));
        wide.byte_size = wide.bytes.as_ref().expect("wide bytes").len() as i64;
        wide.intrinsic_width = 4000;
        wide.intrinsic_height = 100;
        wide.display_width = 4000;
        root.attachments.push(wide);
        let snapshot = snapshot(root);
        let mut warnings = Vec::new();
        let font = ParsedFont::from_bytes(PDF_FONT_BYTES, 0, &mut warnings).expect("font");

        let drafts = build_pdf_pages(&font, &snapshot).expect("oversized image layout");
        let images = drafts
            .iter()
            .flat_map(|page| &page.images)
            .collect::<Vec<_>>();
        let image = images[0];
        assert!((image.height / image.width - 40.0).abs() < 0.01);
        let content_top = super::millimeters_to_points(PDF_PAGE_HEIGHT_MM - PDF_MARGIN_TOP_MM);
        let content_bottom =
            super::millimeters_to_points(PDF_MARGIN_BOTTOM_MM + super::PDF_FOOTER_RESERVE_MM);
        assert!(image.y >= content_bottom);
        assert!(image.y + image.height <= content_top + 0.01);
        let wide = images[1];
        let content_width =
            super::millimeters_to_points(super::PDF_PAGE_WIDTH_MM - super::PDF_MARGIN_X_MM * 2.0);
        assert!((wide.width - content_width).abs() < 0.01);
        assert!((wide.width / wide.height - 40.0).abs() < 0.01);
    }

    #[test]
    fn pdf_layout_uses_the_persisted_480_pixel_display_width() {
        let mut attachment = export_attachment(FIRST_ID, "wide.png", Some(encoded_png(1, 1)));
        attachment.intrinsic_width = 1_200;
        attachment.intrinsic_height = 800;
        attachment.display_width = 480;
        let mut root = export_node(ROOT_ID, "Persisted width", "", false, Vec::new());
        root.attachments.push(attachment);
        let mut warnings = Vec::new();
        let font = ParsedFont::from_bytes(PDF_FONT_BYTES, 0, &mut warnings).expect("font");

        let drafts = build_pdf_pages(&font, &snapshot(root)).expect("PDF image layout");
        let image = drafts
            .iter()
            .flat_map(|page| page.images.iter())
            .next()
            .expect("placed image");

        assert!((image.width - 480.0 * super::PDF_CSS_PIXEL_POINTS).abs() < 0.01);
        assert!((image.height / image.width - 800.0 / 1_200.0).abs() < 0.01);
    }

    #[test]
    fn pdf_layout_paginates_images_with_their_captions_after_outline_rows() {
        let mut children = (0..68)
            .map(|index| {
                export_node(
                    &format!("{index:08x}-0000-4000-8000-{index:012x}"),
                    &format!("Outline row {index:02}"),
                    "",
                    false,
                    Vec::new(),
                )
            })
            .collect::<Vec<_>>();
        let mut attachment = export_attachment(
            FIRST_ID,
            "pagination sentinel.png",
            Some(encoded_png(120, 90)),
        );
        attachment.byte_size = attachment.bytes.as_ref().expect("bytes").len() as i64;
        attachment.intrinsic_width = 120;
        attachment.intrinsic_height = 90;
        attachment.display_width = 120;
        children
            .last_mut()
            .expect("last child")
            .attachments
            .push(attachment);
        let snapshot = snapshot(export_node(ROOT_ID, "Long project", "", false, children));
        let mut warnings = Vec::new();
        let font = ParsedFont::from_bytes(PDF_FONT_BYTES, 0, &mut warnings).expect("font");

        let drafts = build_pdf_pages(&font, &snapshot).expect("paginated image layout");
        let image_page = drafts
            .iter()
            .position(|page| !page.images.is_empty())
            .expect("image page");

        assert!(image_page > 0);
        assert!(drafts[image_page]
            .lines
            .iter()
            .any(|line| line.text.contains("pagination sentinel.png")));
    }

    #[test]
    fn pdf_renderer_rejects_invalid_descendant_before_returning_bytes() {
        let snapshot = snapshot(export_node(
            ROOT_ID,
            "Project",
            "",
            false,
            vec![export_node(
                INVALID_DESCENDANT_ID,
                "Injected child",
                "",
                false,
                Vec::new(),
            )],
        ));

        let error = render_pdf(&snapshot).expect_err("invalid descendant must not return PDF");

        assert_eq!(error, "Note ID must be a canonical UUID v4 string.");
    }
}
