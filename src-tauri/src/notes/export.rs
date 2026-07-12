use super::types::{
    validate_note_id, ExportDateSpan, ExportNode, NotesExportSnapshot, MAX_NOTES_EXPORT_ATTACHMENTS,
};
use crate::notes::date_index::LocalDate;
use image::codecs::{gif::GifDecoder, webp::WebPDecoder};
use image::{AnimationDecoder, RgbaImage};
use printpdf::{
    Color, FontId, Greyscale, Mm, Op, ParsedFont, PdfDocument, PdfFontHandle, PdfPage,
    PdfParseErrorSeverity, PdfSaveOptions, Point, Pt, RawImage, RawImageData, RawImageFormat,
    TextItem, XObject, XObjectId, XObjectTransform,
};
use rusqlite::Connection;
use std::collections::HashMap;
use std::fmt::Write;
use std::fs;
use std::io::Cursor;
use std::io::Write as IoWrite;
use std::path::PathBuf;
use std::path::{Component, Path};
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

/// File written inside every Markdown export assets directory so that a later
/// overwrite can tell one of our own asset directories apart from an unrelated
/// user folder that merely happens to share the derived `{stem}_assets` name.
pub(crate) const EXPORT_ASSET_MARKER_NAME: &str = ".yonalist-notes-export.json";
pub(crate) const EXPORT_ASSET_MARKER_CREATED_BY: &str = "yonalist-notes-export";
const EXPORT_ASSET_MARKER_VERSION: u32 = 1;
/// Overwrite-refusal message. Kept deliberately distinct from
/// "Destination already exists." so it never triggers the frontend overwrite
/// prompt (see `src/domain/notesExport.ts`).
const FOREIGN_EXPORT_ASSET_DIR_MESSAGE: &str = "Export assets folder already exists and was not created by a previous export. Move or rename it and retry.";

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
        let components = Path::new(&attachment.original_name)
            .components()
            .collect::<Vec<_>>();
        if components.len() != 1
            || !matches!(components[0], Component::Normal(_))
            || attachment.original_name.contains(['/', '\\'])
            || attachment.original_name.chars().any(char::is_control)
        {
            return Err("A Notes export attachment filename is unsafe.".to_string());
        }
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

fn render_node(markdown: &mut String, node: &super::types::ExportNode, depth: usize) {
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
        render_node(markdown, child, depth + 1);
    }
}

fn escape_markdown_alt(value: &str) -> String {
    normalize_newlines(value)
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace('\n', " ")
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

fn percent_encode_path_component(value: &str) -> String {
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

    let attachment_indentation = "  ".repeat(depth + 1);
    for attachment in &node.attachments {
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
                bytes: attachment.bytes.clone().ok_or_else(|| {
                    "Notes export attachment bytes were not validated.".to_string()
                })?,
            });
            asset_links.insert(payload_key, file_name.clone());
            file_name
        };
        let link = format!(
            "{}/{}",
            percent_encode_path_component(asset_directory_name),
            file_name
        );
        writeln!(
            markdown,
            "{attachment_indentation}![{}]({link})",
            escape_markdown_alt(&attachment.original_name)
        )
        .expect("writing to a String cannot fail");
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
    writeln!(markdown, "# {}\n", escape_inline(&snapshot.title))
        .expect("writing to a String cannot fail");
    markdown
}

pub(crate) fn render_markdown(snapshot: &NotesExportSnapshot) -> Result<Vec<u8>, String> {
    validate_note_id(&snapshot.root_node_id)?;
    validate_export_node_ids(&snapshot.root)?;

    let mut markdown = render_markdown_frontmatter(snapshot);
    render_node(&mut markdown, &snapshot.root, 0);
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
        Ok(_) if !overwrite => Err("Destination already exists.".to_string()),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn remove_path_nofollow(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir_all(path).map_err(|error| error.to_string())
        }
        Ok(_) => fs::remove_file(path).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ExportDirectoryIdentity {
    volume: u64,
    file: u64,
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

#[cfg(any(
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    target_os = "redox"
))]
fn publish_directory_noreplace(staged: &Path, destination: &Path) -> Result<(), String> {
    match rustix::fs::renameat_with(
        rustix::fs::CWD,
        staged,
        rustix::fs::CWD,
        destination,
        rustix::fs::RenameFlags::NOREPLACE,
    ) {
        Ok(()) => Ok(()),
        Err(error) if error == rustix::io::Errno::EXIST => {
            Err("Destination already exists.".to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(windows)]
fn windows_directory_move_flags() -> u32 {
    0
}

#[cfg(all(test, not(windows)))]
fn windows_directory_move_flags() -> u32 {
    0
}

#[cfg(windows)]
fn publish_directory_noreplace(staged: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS};
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    let staged = staged
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            staged.as_ptr(),
            destination.as_ptr(),
            windows_directory_move_flags(),
        )
    };
    if moved != 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error().map(|code| code as u32) {
        Some(ERROR_ALREADY_EXISTS) | Some(ERROR_FILE_EXISTS) => {
            Err("Destination already exists.".to_string())
        }
        _ => Err(error.to_string()),
    }
}

#[cfg(not(any(
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    target_os = "redox",
    windows
)))]
fn publish_directory_noreplace(_staged: &Path, _destination: &Path) -> Result<(), String> {
    Err("Atomic no-replace Notes asset publication is unsupported on this platform.".to_string())
}

fn unique_export_cleanup_path(parent: &Path, prefix: &str) -> Result<PathBuf, String> {
    let path = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in(parent)
        .map_err(|error| error.to_string())?
        .keep();
    fs::remove_dir(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn preserve_export_directory(
    directory: &Path,
    parent: &Path,
    prefix: &str,
) -> Result<PathBuf, String> {
    let preserved = unique_export_cleanup_path(parent, prefix)?;
    publish_directory_noreplace(directory, &preserved)?;
    Ok(preserved)
}

fn rollback_published_directory(
    published: &Path,
    parent: &Path,
    expected_identity: ExportDirectoryIdentity,
) -> Result<String, String> {
    let quarantine = unique_export_cleanup_path(parent, ".yonalist-notes-rollback-")?;
    publish_directory_noreplace(published, &quarantine)
        .map_err(|error| format!("Could not quarantine Notes export assets: {error}"))?;

    let actual_identity = match export_directory_identity(&quarantine) {
        Ok(identity) => identity,
        Err(error) => {
            let restore = publish_directory_noreplace(&quarantine, published);
            return match restore {
                Ok(()) => Err(format!(
                    "Could not verify the quarantined Notes export asset identity; the directory was preserved: {error}"
                )),
                Err(restore_error) => Err(format!(
                    "Could not verify the quarantined Notes export asset identity; the directory was preserved at {}: {error}; restore failed: {restore_error}",
                    quarantine.display()
                )),
            };
        }
    };
    if actual_identity != expected_identity {
        let restore = publish_directory_noreplace(&quarantine, published);
        return match restore {
            Ok(()) => Err(
                "Notes export asset directory identity changed before rollback; the unrelated replacement was preserved."
                    .to_string(),
            ),
            Err(restore_error) => Err(format!(
                "Notes export asset directory identity changed before rollback; the unrelated replacement was preserved at {} because restore failed: {restore_error}",
                quarantine.display()
            )),
        };
    }

    Ok(format!(
        "Notes export rollback cleanup warning: published assets were preserved for startup/manual cleanup at {}.",
        quarantine.display()
    ))
}

fn classify_export_directory_sync(result: std::io::Result<()>) -> Result<(), String> {
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::Unsupported => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(unix)]
fn sync_export_directory(path: &Path) -> Result<(), String> {
    classify_export_directory_sync(fs::File::open(path).and_then(|directory| directory.sync_all()))
}

#[cfg(not(unix))]
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
    static INJECT_MARKDOWN_POST_ASSET_PUBLICATION_SWAP: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
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
fn inject_export_parent_sync_failure_once() {
    INJECT_EXPORT_PARENT_SYNC_FAILURE.with(|injected| injected.set(true));
}

fn sync_export_parent(path: &Path) -> Result<(), String> {
    #[cfg(test)]
    if INJECT_EXPORT_PARENT_SYNC_FAILURE.with(|injected| injected.replace(false)) {
        return Err("Injected Notes export parent sync failure.".to_string());
    }
    sync_export_directory(path)
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

/// Guard for the overwrite path: an existing `{stem}_assets` directory may only
/// be displaced when it carries our marker with a matching `createdBy`. Missing
/// marker, unreadable/invalid marker, or a foreign `createdBy` all refuse with
/// [`FOREIGN_EXPORT_ASSET_DIR_MESSAGE`]. Must run before any destructive rename
/// so the destination `.md` and the foreign directory stay untouched on refusal.
fn ensure_overwritable_export_asset_directory(asset_destination: &Path) -> Result<(), String> {
    match fs::symlink_metadata(asset_destination) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("Notes export asset directory must not be a symlink.".to_string());
        }
        Ok(_) => {}
    }
    let marker_bytes = match fs::read(asset_destination.join(EXPORT_ASSET_MARKER_NAME)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(FOREIGN_EXPORT_ASSET_DIR_MESSAGE.to_string());
        }
        Err(error) => return Err(error.to_string()),
    };
    let marker = serde_json::from_slice::<ExportAssetMarker>(&marker_bytes)
        .map_err(|_| FOREIGN_EXPORT_ASSET_DIR_MESSAGE.to_string())?;
    if marker.created_by != EXPORT_ASSET_MARKER_CREATED_BY {
        return Err(FOREIGN_EXPORT_ASSET_DIR_MESSAGE.to_string());
    }
    Ok(())
}

pub(crate) fn publish_markdown_export(
    destination: &Path,
    asset_destination: &Path,
    prepared: &PreparedMarkdownExport,
    overwrite: bool,
) -> Result<(), String> {
    if prepared.assets.is_empty() {
        return crate::file_io::write_atomic_file(destination, &prepared.markdown, overwrite);
    }
    preflight_markdown_asset_destination(asset_destination, overwrite)?;
    if !overwrite {
        match fs::symlink_metadata(destination) {
            Ok(_) => return Err("Destination already exists.".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }

    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let stage = tempfile::Builder::new()
        .prefix(".yonalist-notes-export-")
        .tempdir_in(parent)
        .map_err(|error| error.to_string())?;
    let staged_document = stage.path().join("document.md");
    let staged_assets = stage.path().join("assets");
    fs::create_dir(&staged_assets).map_err(|error| error.to_string())?;
    for asset in &prepared.assets {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(staged_assets.join(&asset.file_name))
            .map_err(|error| error.to_string())?;
        file.write_all(&asset.bytes)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }
    let marker_bytes = export_asset_marker_bytes(prepared)?;
    let mut marker = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(staged_assets.join(EXPORT_ASSET_MARKER_NAME))
        .map_err(|error| error.to_string())?;
    marker
        .write_all(&marker_bytes)
        .map_err(|error| error.to_string())?;
    marker.sync_all().map_err(|error| error.to_string())?;
    let mut document = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staged_document)
        .map_err(|error| error.to_string())?;
    document
        .write_all(&prepared.markdown)
        .map_err(|error| error.to_string())?;
    document.sync_all().map_err(|error| error.to_string())?;
    sync_export_directory(&staged_assets)?;
    let staged_asset_identity = export_directory_identity(&staged_assets)?;
    maybe_inject_markdown_commit_race();

    if !overwrite {
        maybe_inject_markdown_asset_destination_swap();
        let mut published_assets = false;
        let publish_result = (|| {
            publish_directory_noreplace(&staged_assets, asset_destination)?;
            published_assets = true;
            maybe_inject_markdown_post_asset_publication_swap();
            maybe_fail_markdown_publish()?;
            match fs::hard_link(&staged_document, destination) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    Err("Destination already exists.".to_string())
                }
                Err(error) => Err(error.to_string()),
            }
        })();
        if let Err(error) = publish_result {
            if published_assets {
                return match rollback_published_directory(
                    asset_destination,
                    parent,
                    staged_asset_identity,
                ) {
                    Ok(warning) => {
                        report_export_cleanup_warning(warning);
                        Err(error)
                    }
                    Err(rollback_error) => Err(format!(
                        "{error} Notes export rollback also failed: {rollback_error}"
                    )),
                };
            }
            return Err(error);
        }
        let _ = sync_export_parent(parent);
        return Ok(());
    }

    // Refuse before touching anything: only displace an assets directory that a
    // previous export created (see the marker guard). On refusal the existing
    // `.md` and the foreign directory both stay byte-for-byte untouched.
    ensure_overwritable_export_asset_directory(asset_destination)?;

    let old_document = stage.path().join("old-document");
    let old_assets = stage.path().join("old-assets");
    let had_document = fs::symlink_metadata(destination).is_ok();
    let had_assets = fs::symlink_metadata(asset_destination).is_ok();
    let mut published_document = false;
    let mut published_assets = false;
    let publish_result = (|| {
        if had_document {
            fs::rename(destination, &old_document).map_err(|error| error.to_string())?;
        }
        if had_assets {
            if let Err(error) = fs::rename(asset_destination, &old_assets) {
                if had_document {
                    let _ = fs::rename(&old_document, destination);
                }
                return Err(error.to_string());
            }
        }
        fs::rename(&staged_assets, asset_destination).map_err(|error| error.to_string())?;
        published_assets = true;
        maybe_inject_markdown_post_asset_publication_swap();
        maybe_fail_markdown_publish()?;
        fs::rename(&staged_document, destination).map_err(|error| error.to_string())?;
        published_document = true;
        Ok(())
    })();

    if let Err(error) = publish_result {
        let mut rollback_errors = Vec::new();
        let mut preserve_stage = false;
        if published_document {
            if let Err(rollback_error) = remove_path_nofollow(destination) {
                rollback_errors.push(rollback_error);
            }
        }
        if published_assets {
            match rollback_published_directory(asset_destination, parent, staged_asset_identity) {
                Ok(warning) => report_export_cleanup_warning(warning),
                Err(rollback_error) => rollback_errors.push(rollback_error),
            }
        }
        if had_assets && old_assets.exists() {
            if let Err(restore_error) = publish_directory_noreplace(&old_assets, asset_destination)
            {
                match preserve_export_directory(
                    &old_assets,
                    parent,
                    ".yonalist-notes-old-assets-",
                ) {
                    Ok(preserved) => rollback_errors.push(format!(
                        "Notes export incomplete rollback: the asset destination remained occupied; the old asset backup was preserved at {}: {restore_error}",
                        preserved.display()
                    )),
                    Err(preserve_error) => {
                        preserve_stage = true;
                        rollback_errors.push(format!(
                            "Notes export incomplete rollback: the asset destination remained occupied and the old asset backup could not be moved out of private staging: {restore_error}; preservation failed: {preserve_error}"
                        ));
                    }
                }
            }
        }
        if had_document && old_document.exists() {
            if let Err(rollback_error) = fs::rename(&old_document, destination) {
                preserve_stage = true;
                rollback_errors.push(rollback_error.to_string());
            }
        }
        if preserve_stage {
            let preserved_stage = stage.keep();
            rollback_errors.push(format!(
                "Notes export incomplete rollback: private staging was preserved at {} for startup/manual cleanup.",
                preserved_stage.display()
            ));
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

    let _ = sync_export_parent(parent);
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
    mime_type: String,
    payload_key: ExportPayloadKey,
    bytes: Arc<[u8]>,
    intrinsic_width: usize,
    intrinsic_height: usize,
    x: f32,
    width: f32,
    height: f32,
    caption_lines: Vec<PdfPreparedLine>,
    block_height: f32,
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
    let max_indent = body_width - PDF_MIN_TEXT_WIDTH;
    let indentation = (depth as f32 * PDF_DEPTH_INDENT).min(max_indent);
    let x = margin_x + indentation;
    let max_width = body_width - indentation;
    let caption_lines = wrap_pdf_text(
        font,
        &attachment.original_name,
        PDF_IMAGE_CAPTION_SIZE,
        max_width,
    )?
    .into_iter()
    .map(|text| PdfPreparedLine {
        text,
        x,
        size: PDF_IMAGE_CAPTION_SIZE,
        line_height: PDF_IMAGE_CAPTION_LINE_HEIGHT,
        tone: PdfTextTone::Supporting,
    })
    .collect::<Vec<_>>();
    let caption_height = caption_lines.len() as f32 * PDF_IMAGE_CAPTION_LINE_HEIGHT;
    let max_image_height = full_page_height - PDF_IMAGE_CAPTION_GAP - caption_height - PDF_ROW_GAP;
    if max_image_height <= 0.0 {
        return Err("A PDF attachment caption is too tall to fit on an A4 page.".to_string());
    }
    let mut width = attachment.display_width as f32 * PDF_CSS_PIXEL_POINTS;
    let mut height = width * intrinsic_height as f32 / intrinsic_width as f32;
    let scale = (max_width / width).min(max_image_height / height).min(1.0);
    width *= scale;
    height *= scale;
    let block_height = height + PDF_IMAGE_CAPTION_GAP + caption_height + PDF_ROW_GAP;

    Ok(PdfPreparedImage {
        attachment_id: attachment.id.clone(),
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
    blocks.push(PdfPreparedBlock::Row(prepare_pdf_row(font, node, depth)?));
    for attachment in &node.attachments {
        blocks.push(PdfPreparedBlock::Image(prepare_pdf_image(
            font,
            attachment,
            depth,
            full_page_height,
        )?));
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

fn build_pdf_pages(
    font: &ParsedFont,
    snapshot: &NotesExportSnapshot,
) -> Result<Vec<PdfPageDraft>, String> {
    let margin_x = millimeters_to_points(PDF_MARGIN_X_MM);
    let page_height = millimeters_to_points(PDF_PAGE_HEIGHT_MM);
    let content_top = page_height - millimeters_to_points(PDF_MARGIN_TOP_MM);
    let content_bottom = millimeters_to_points(PDF_MARGIN_BOTTOM_MM + PDF_FOOTER_RESERVE_MM);
    let body_width = millimeters_to_points(PDF_PAGE_WIDTH_MM - PDF_MARGIN_X_MM * 2.0);
    let display_title =
        format_date_matches_for_pdf_display(&snapshot.title, &snapshot.root.title_date_spans)?;
    let title_lines = wrap_pdf_text(font, &display_title, PDF_TITLE_SIZE, body_width)?
        .into_iter()
        .map(|text| PdfPreparedLine {
            text,
            x: margin_x,
            size: PDF_TITLE_SIZE,
            line_height: PDF_TITLE_LINE_HEIGHT,
            tone: PdfTextTone::Primary,
        })
        .collect::<Vec<_>>();
    let title_height = title_lines.len() as f32 * PDF_TITLE_LINE_HEIGHT + PDF_TITLE_GAP;
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
                let caption_top = image_y - PDF_IMAGE_CAPTION_GAP;
                let block_height = image.block_height;
                let page = pages.last_mut().expect("PDF page exists");
                page.images.push(PdfPlacedImage {
                    attachment_id: image.attachment_id,
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
                place_pdf_lines(page, image.caption_lines, caption_top);
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
    let bytes = document.save(&PdfSaveOptions::default(), &mut save_warnings);
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
        inject_markdown_commit_race_once, inject_markdown_post_asset_publication_swap_once,
        load_export_snapshot, prepare_markdown_export, publish_markdown_export, render_markdown,
        render_pdf, sync_export_directory, validate_pdf_attachment_working_budget,
        validate_serialized_pdf, windows_directory_move_flags, ExportAttachmentBudget,
        EXPORT_ASSET_MARKER_CREATED_BY, EXPORT_ASSET_MARKER_NAME, EXPORT_ASSET_MARKER_VERSION,
        FOREIGN_EXPORT_ASSET_DIR_MESSAGE, PDF_FONT_BYTES, PDF_MARGIN_BOTTOM_MM, PDF_MARGIN_TOP_MM,
        PDF_PAGE_HEIGHT_MM,
    };
    use crate::notes::types::{ExportAttachment, ExportDateSpan, ExportNode, NotesExportSnapshot};
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
            title: title.to_string(),
            note: note.to_string(),
            title_date_spans: Vec::new(),
            note_date_spans: Vec::new(),
            completed,
            attachments: Vec::new(),
            children,
        }
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

    fn initialize_export_connection(connection: &Connection) {
        connection
            .execute_batch(
                "CREATE TABLE notes_nodes (\
                   id TEXT PRIMARY KEY,\
                   parent_id TEXT,\
                   sort_key INTEGER NOT NULL,\
                   title TEXT NOT NULL,\
                   note TEXT NOT NULL,\
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
                   id, parent_id, sort_key, title, note, is_collapsed, completed_at, deleted_at\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    node.id,
                    node.parent_id,
                    node.sort_key,
                    node.title,
                    node.note,
                    node.is_collapsed,
                    node.completed_at,
                    node.deleted_at
                ],
            )
            .expect("insert node");
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

    #[test]
    fn notes_export_windows_directory_publication_never_requests_replace_existing() {
        assert_eq!(windows_directory_move_flags(), 0);
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

        let error = super::publish_directory_noreplace(&staged, &destination)
            .expect_err("existing destination must not be replaced");

        assert_eq!(error, "Destination already exists.");
        assert!(staged.join("0001.png").is_file());
        assert_eq!(
            std::fs::read_dir(&destination)
                .expect("existing destination")
                .count(),
            0
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
        root.attachments
            .push(export_attachment(FIRST_ID, "image.png", Some(vec![9, 8, 7])));
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
        root.attachments
            .push(export_attachment(FIRST_ID, "image.png", Some(vec![1, 2, 3])));
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
            std::fs::read_dir(&assets).expect("foreign directory").count(),
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
        root.attachments
            .push(export_attachment(FIRST_ID, "image.png", Some(vec![1, 2, 3])));
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
    fn renderers_reject_unsafe_attachment_output_names() {
        for original_name in ["../escape.png", "..\\escape.png", ".", "line\nbreak.png"] {
            let mut snapshot = snapshot(export_node(ROOT_ID, "Project", "", false, Vec::new()));
            snapshot.root.attachments.push(export_attachment(
                FIRST_ID,
                original_name,
                Some(vec![1, 2, 3]),
            ));

            assert_eq!(
                render_markdown(&snapshot).expect_err("unsafe Markdown attachment name"),
                "A Notes export attachment filename is unsafe."
            );
            assert_eq!(
                render_pdf(&snapshot).expect_err("unsafe PDF attachment name"),
                "A Notes export attachment filename is unsafe."
            );
        }
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
