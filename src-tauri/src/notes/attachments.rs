use image::{ImageFormat, ImageReader, Limits};
use rusqlite::Connection;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tempfile::Builder;

use crate::notes::types::NoteAttachment;

pub(crate) const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
pub(crate) const MAX_ATTACHMENT_PIXELS: u64 = 40_000_000;
static ATTACHMENT_STORAGE_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn with_attachment_storage_lock<T>(
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _guard = ATTACHMENT_STORAGE_LOCK
        .lock()
        .map_err(|_| "The Notes attachment storage lock is unavailable.".to_string())?;
    operation()
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ValidationLimits {
    pub(crate) max_bytes: u64,
    pub(crate) max_pixels: u64,
}

impl ValidationLimits {
    pub(crate) const DEFAULT: Self = Self {
        max_bytes: MAX_ATTACHMENT_BYTES,
        max_pixels: MAX_ATTACHMENT_PIXELS,
    };
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValidatedImage {
    pub(crate) mime_type: &'static str,
    pub(crate) extension: &'static str,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) byte_size: u64,
    pub(crate) content_hash: String,
}

#[derive(Debug)]
pub(crate) struct PreparedAttachment {
    pub(crate) bytes: Vec<u8>,
    pub(crate) original_name: String,
    pub(crate) image: ValidatedImage,
}

fn supported_format(format: ImageFormat) -> Option<(&'static str, &'static str)> {
    match format {
        ImageFormat::Png => Some(("image/png", "png")),
        ImageFormat::Jpeg => Some(("image/jpeg", "jpg")),
        ImageFormat::WebP => Some(("image/webp", "webp")),
        ImageFormat::Gif => Some(("image/gif", "gif")),
        _ => None,
    }
}

fn extension_matches(format: ImageFormat, extension: &str) -> bool {
    match format {
        ImageFormat::Jpeg => matches!(extension, "jpg" | "jpeg"),
        ImageFormat::Png => extension == "png",
        ImageFormat::WebP => extension == "webp",
        ImageFormat::Gif => extension == "gif",
        _ => false,
    }
}

pub(crate) fn validate_image_bytes(
    source_path: &Path,
    bytes: &[u8],
    limits: ValidationLimits,
) -> Result<ValidatedImage, String> {
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| {
            "Notes attachment images must have a supported file extension.".to_string()
        })?;
    if extension == "svg" {
        return Err("SVG Notes attachments are not supported.".to_string());
    }
    let byte_size = u64::try_from(bytes.len())
        .map_err(|_| "The Notes attachment byte size is too large.".to_string())?;
    if byte_size == 0 || byte_size > limits.max_bytes {
        return Err(format!(
            "Notes attachment images must contain between 1 and {} bytes.",
            limits.max_bytes
        ));
    }

    let format = image::guess_format(bytes)
        .map_err(|error| format!("Could not decode the Notes attachment image format: {error}"))?;
    let (mime_type, canonical_extension) = supported_format(format).ok_or_else(|| {
        "Only PNG, JPEG, WebP, and GIF Notes attachment images are supported.".to_string()
    })?;
    if !extension_matches(format, &extension) {
        return Err(format!(
            "The Notes attachment file extension .{extension} does not match its decoded image format."
        ));
    }

    let dimensions = ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|error| format!("Could not decode the Notes attachment dimensions: {error}"))?;
    let pixels = u64::from(dimensions.0)
        .checked_mul(u64::from(dimensions.1))
        .ok_or_else(|| "The Notes attachment decoded pixel count is too large.".to_string())?;
    if dimensions.0 == 0 || dimensions.1 == 0 || pixels > limits.max_pixels {
        return Err(format!(
            "Notes attachment images must contain between 1 and {} decoded pixels.",
            limits.max_pixels
        ));
    }

    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut decode_limits = Limits::default();
    decode_limits.max_image_width = Some(dimensions.0);
    decode_limits.max_image_height = Some(dimensions.1);
    decode_limits.max_alloc = Some(limits.max_pixels.saturating_mul(8));
    reader.limits(decode_limits);
    reader
        .decode()
        .map_err(|error| format!("Could not decode the Notes attachment image: {error}"))?;

    Ok(ValidatedImage {
        mime_type,
        extension: canonical_extension,
        width: dimensions.0,
        height: dimensions.1,
        byte_size,
        content_hash: format!("{:x}", Sha256::digest(bytes)),
    })
}

fn canonical_relative_path(content_hash: &str, mime_type: &str) -> Result<String, String> {
    if content_hash.len() != 64
        || !content_hash
            .bytes()
            .all(|value| value.is_ascii_digit() || matches!(value, b'a'..=b'f'))
    {
        return Err("A Notes attachment content hash must be lowercase SHA-256 hex.".to_string());
    }
    let extension = match mime_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => return Err("The Notes attachment MIME type is unsupported.".to_string()),
    };
    Ok(format!("notes-assets/{content_hash}.{extension}"))
}

pub(crate) fn resolve_owned_asset_path(
    metadata_dir: &Path,
    relative_path: &str,
    content_hash: &str,
    mime_type: &str,
) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    let components = relative.components().collect::<Vec<_>>();
    if components.len() != 2
        || components[0] != Component::Normal("notes-assets".as_ref())
        || !matches!(components[1], Component::Normal(_))
    {
        return Err("A Notes attachment path must be a safe owned relative path.".to_string());
    }
    if relative_path != canonical_relative_path(content_hash, mime_type)? {
        return Err("A Notes attachment path does not match its hash and MIME type.".to_string());
    }
    Ok(metadata_dir.join(relative))
}

fn read_bounded_file(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Could not open the Notes attachment image: {error}"))?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read the Notes attachment image: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!(
            "Notes attachment images must contain at most {max_bytes} bytes."
        ));
    }
    Ok(bytes)
}

pub(crate) fn prepare_source_attachment(source_path: &str) -> Result<PreparedAttachment, String> {
    if source_path.trim().is_empty() {
        return Err("A Notes attachment source path is required.".to_string());
    }
    let path = Path::new(source_path);
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not inspect the Notes attachment source: {error}"))?;
    if !metadata.is_file() {
        return Err("A Notes attachment source must be a regular file.".to_string());
    }
    let original_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "A Notes attachment source must name a file.".to_string())?
        .to_string();
    let bytes = read_bounded_file(path, MAX_ATTACHMENT_BYTES)?;
    let image = validate_image_bytes(path, &bytes, ValidationLimits::DEFAULT)?;
    Ok(PreparedAttachment {
        bytes,
        original_name,
        image,
    })
}

fn asset_root(vault_path: &str) -> PathBuf {
    crate::metadata_dir(vault_path).join("notes-assets")
}

fn verify_asset_root(root: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
            Ok(true)
        }
        Ok(_) => Err(
            "The Notes attachment directory must be an owned directory, not a file or symlink."
                .to_string(),
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "Could not inspect the Notes attachment directory: {error}"
        )),
    }
}

fn ensure_asset_root(root: &Path) -> Result<(), String> {
    if !verify_asset_root(root)? {
        fs::create_dir_all(root)
            .map_err(|error| format!("Could not create the Notes attachment directory: {error}"))?;
    }
    if verify_asset_root(root)? {
        Ok(())
    } else {
        Err("Could not create the Notes attachment directory.".to_string())
    }
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    if !verify_asset_root(path)? {
        return Ok(());
    }
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not sync the Notes attachment directory: {error}"))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

pub(crate) fn publish_attachment_bytes(
    vault_path: &str,
    prepared: &PreparedAttachment,
) -> Result<String, String> {
    let relative_path =
        canonical_relative_path(&prepared.image.content_hash, prepared.image.mime_type)?;
    let root = asset_root(vault_path);
    ensure_asset_root(&root)?;
    let target = resolve_owned_asset_path(
        &crate::metadata_dir(vault_path),
        &relative_path,
        &prepared.image.content_hash,
        prepared.image.mime_type,
    )?;

    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if metadata.file_type().is_file() {
            let existing = read_bounded_file(&target, MAX_ATTACHMENT_BYTES)?;
            if format!("{:x}", Sha256::digest(&existing)) == prepared.image.content_hash {
                return Ok(relative_path);
            }
        }
    }

    let mut temporary = Builder::new()
        .prefix(".attachment-")
        .tempfile_in(&root)
        .map_err(|error| format!("Could not create a Notes attachment temporary file: {error}"))?;
    temporary
        .write_all(&prepared.bytes)
        .map_err(|error| format!("Could not write a Notes attachment temporary file: {error}"))?;
    temporary
        .flush()
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Could not sync a Notes attachment temporary file: {error}"))?;
    temporary.persist(&target).map_err(|error| {
        format!(
            "Could not publish the Notes attachment atomically: {}",
            error.error
        )
    })?;
    sync_directory(&root)?;
    Ok(relative_path)
}

pub(crate) fn read_validated_attachment_bytes(
    vault_path: &str,
    attachment: &NoteAttachment,
) -> Result<Vec<u8>, String> {
    let root = asset_root(vault_path);
    if !verify_asset_root(&root)? {
        return Err("The Notes attachment directory does not exist.".to_string());
    }
    let path = resolve_owned_asset_path(
        &crate::metadata_dir(vault_path),
        &attachment.relative_path,
        &attachment.content_hash,
        &attachment.mime_type,
    )?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("Could not inspect the Notes attachment file: {error}"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("A Notes attachment owned path must contain a regular file.".to_string());
    }
    let bytes = read_bounded_file(&path, MAX_ATTACHMENT_BYTES)?;
    let validated = validate_image_bytes(&path, &bytes, ValidationLimits::DEFAULT)?;
    if validated.content_hash != attachment.content_hash
        || validated.mime_type != attachment.mime_type
        || validated.byte_size != attachment.byte_size as u64
        || i64::from(validated.width) != attachment.intrinsic_width
        || i64::from(validated.height) != attachment.intrinsic_height
    {
        return Err("The Notes attachment file no longer matches its stored metadata.".to_string());
    }
    Ok(bytes)
}

#[derive(Deserialize)]
struct AttachmentPathSnapshot {
    relative_path: String,
    content_hash: String,
    mime_type: String,
}

fn insert_reachable_path(
    reachable: &mut HashSet<String>,
    snapshot: AttachmentPathSnapshot,
) -> Result<(), String> {
    resolve_owned_asset_path(
        Path::new("."),
        &snapshot.relative_path,
        &snapshot.content_hash,
        &snapshot.mime_type,
    )?;
    reachable.insert(snapshot.relative_path);
    Ok(())
}

fn reachable_asset_paths(connection: &Connection) -> Result<HashSet<String>, String> {
    let mut reachable = HashSet::new();
    {
        let mut statement = connection
            .prepare("SELECT relative_path, content_hash, mime_type FROM notes_attachments")
            .map_err(|error| {
                format!("Could not prepare Notes attachment reconciliation: {error}")
            })?;
        let rows = statement
            .query_map([], |row| {
                Ok(AttachmentPathSnapshot {
                    relative_path: row.get(0)?,
                    content_hash: row.get(1)?,
                    mime_type: row.get(2)?,
                })
            })
            .map_err(|error| format!("Could not read Notes attachment reconciliation: {error}"))?;
        for row in rows {
            insert_reachable_path(
                &mut reachable,
                row.map_err(|error| {
                    format!("Could not collect Notes attachment reconciliation: {error}")
                })?,
            )?;
        }
    }
    {
        let mut statement = connection
            .prepare(
                "SELECT before_json, after_json FROM notes_history_changes \
                 WHERE table_name = 'notes_attachments'",
            )
            .map_err(|error| {
                format!("Could not prepare Notes attachment history reachability: {error}")
            })?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            })
            .map_err(|error| {
                format!("Could not read Notes attachment history reachability: {error}")
            })?;
        for row in rows {
            let (before, after) = row.map_err(|error| {
                format!("Could not collect Notes attachment history reachability: {error}")
            })?;
            for snapshot in [before, after].into_iter().flatten() {
                let snapshot =
                    serde_json::from_str::<AttachmentPathSnapshot>(&snapshot).map_err(|error| {
                        format!("Could not decode attachment history reachability: {error}")
                    })?;
                insert_reachable_path(&mut reachable, snapshot)?;
            }
        }
    }
    Ok(reachable)
}

pub(crate) fn reconcile_attachment_files(
    vault_path: &str,
    connection: &Connection,
) -> Result<usize, String> {
    let reachable = reachable_asset_paths(connection)?;
    let root = asset_root(vault_path);
    if !verify_asset_root(&root)? {
        return Ok(0);
    }
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => {
            return Err(format!(
                "Could not inspect the Notes attachment directory: {error}"
            ))
        }
    };
    let mut removed = 0;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not inspect a Notes attachment file: {error}"))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|error| format!("Could not inspect a Notes attachment entry: {error}"))?;
        if metadata.file_type().is_dir() {
            continue;
        }
        let relative = entry
            .file_name()
            .to_str()
            .map(|name| format!("notes-assets/{name}"));
        if relative
            .as_ref()
            .is_some_and(|path| reachable.contains(path))
        {
            continue;
        }
        fs::remove_file(entry.path()).map_err(|error| {
            format!("Could not remove an unreferenced Notes attachment: {error}")
        })?;
        removed += 1;
    }
    if removed > 0 {
        sync_directory(&root)?;
    }
    Ok(removed)
}

pub(crate) fn delete_attachment_files(vault_path: &str) -> Result<(), String> {
    let root = asset_root(vault_path);
    if !verify_asset_root(&root)? {
        return Ok(());
    }
    match fs::remove_dir_all(root) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not delete Notes attachment files: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_relative_path, prepare_source_attachment, publish_attachment_bytes,
        resolve_owned_asset_path, validate_image_bytes, with_attachment_storage_lock,
        ValidationLimits,
    };
    use crate::notes::commands::{
        notes_clear_history, notes_empty_trash, notes_import_attachment, notes_initialize,
        notes_read_attachment_bytes, notes_remove_attachment, notes_resize_attachment,
        notes_restore_attachment,
    };
    use crate::notes::history::{redo, undo};
    use crate::notes::repository::{
        archive_node, connect_notes_db, create_node, load_workspace, remove_empty_node,
        restore_node, soft_delete_node, unarchive_node,
    };
    use crate::notes::types::{
        CreateNodeInput, ImportAttachmentInput, NotesHistoryContext, NotesWorkspaceScope,
        ResizeAttachmentInput,
    };
    use image::{DynamicImage, ImageFormat};
    use rusqlite::params;
    use std::fs;
    use std::io::Cursor;
    use std::path::Path;

    fn encoded(format: ImageFormat) -> Vec<u8> {
        encoded_dimensions(format, 2, 3)
    }

    fn encoded_dimensions(format: ImageFormat, width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(width, height)
            .write_to(&mut bytes, format)
            .expect("encode fixture");
        bytes.into_inner()
    }

    const NODE_ID: &str = "11111111-1111-4111-8111-111111111111";
    const ATTACHMENT_ID: &str = "22222222-2222-4222-8222-222222222222";
    const SECOND_ATTACHMENT_ID: &str = "33333333-3333-4333-8333-333333333333";
    const SESSION_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    fn vault_path(temp_dir: &tempfile::TempDir) -> String {
        temp_dir.path().to_string_lossy().into_owned()
    }

    fn seed_node(vault_path: &str) {
        let mut connection = connect_notes_db(vault_path).expect("connect");
        create_node(
            &mut connection,
            CreateNodeInput {
                id: NODE_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "Image node".to_string(),
                note: String::new(),
            },
        )
        .expect("seed node");
    }

    fn history_context(index: usize, command_kind: &str) -> NotesHistoryContext {
        NotesHistoryContext {
            session_id: SESSION_ID.to_string(),
            entry_id: format!("00000000-0000-4000-8000-{index:012x}"),
            command_kind: command_kind.to_string(),
        }
    }

    fn write_source(temp_dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> String {
        let path = temp_dir.path().join(name);
        fs::write(&path, bytes).expect("write source");
        path.to_string_lossy().into_owned()
    }

    fn import_input(id: &str, source_path: String) -> ImportAttachmentInput {
        ImportAttachmentInput {
            id: id.to_string(),
            node_id: NODE_ID.to_string(),
            source_path,
            display_width: None,
        }
    }

    #[test]
    fn notes_attachment_validation_decodes_only_the_supported_raster_formats() {
        for (name, format, mime_type, extension) in [
            ("fixture.png", ImageFormat::Png, "image/png", "png"),
            ("fixture.jpeg", ImageFormat::Jpeg, "image/jpeg", "jpg"),
            ("fixture.webp", ImageFormat::WebP, "image/webp", "webp"),
            ("fixture.gif", ImageFormat::Gif, "image/gif", "gif"),
        ] {
            let bytes = encoded(format);
            let validated =
                validate_image_bytes(Path::new(name), &bytes, ValidationLimits::DEFAULT)
                    .unwrap_or_else(|error| panic!("{name}: {error}"));

            assert_eq!(validated.mime_type, mime_type);
            assert_eq!(validated.extension, extension);
            assert_eq!((validated.width, validated.height), (2, 3));
            assert_eq!(validated.byte_size, bytes.len() as u64);
            assert_eq!(validated.content_hash.len(), 64);
        }
    }

    #[test]
    fn notes_attachment_validation_rejects_spoofed_svg_and_truncated_sources() {
        let png = encoded(ImageFormat::Png);
        let spoofed = validate_image_bytes(
            Path::new("actually-jpeg.jpg"),
            &png,
            ValidationLimits::DEFAULT,
        )
        .expect_err("extension spoof must fail");
        assert!(spoofed.to_lowercase().contains("extension"), "{spoofed}");

        let svg = validate_image_bytes(
            Path::new("active.svg"),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>"#,
            ValidationLimits::DEFAULT,
        )
        .expect_err("svg must fail");
        assert!(svg.to_lowercase().contains("svg"), "{svg}");

        let truncated = validate_image_bytes(
            Path::new("broken.png"),
            &png[..png.len() / 2],
            ValidationLimits::DEFAULT,
        )
        .expect_err("truncated image must fail");
        assert!(truncated.to_lowercase().contains("decode"), "{truncated}");
    }

    #[test]
    fn notes_attachment_validation_enforces_byte_and_decoded_pixel_limits() {
        let png = encoded(ImageFormat::Png);
        let byte_error = validate_image_bytes(
            Path::new("too-large.png"),
            &png,
            ValidationLimits {
                max_bytes: png.len() as u64 - 1,
                max_pixels: 6,
            },
        )
        .expect_err("byte ceiling must fail");
        assert!(byte_error.to_lowercase().contains("byte"), "{byte_error}");

        let pixel_error = validate_image_bytes(
            Path::new("too-many-pixels.png"),
            &png,
            ValidationLimits {
                max_bytes: png.len() as u64,
                max_pixels: 5,
            },
        )
        .expect_err("pixel ceiling must fail");
        assert!(
            pixel_error.to_lowercase().contains("pixel"),
            "{pixel_error}"
        );
    }

    #[test]
    fn notes_attachment_owned_paths_are_exact_safe_hash_paths() {
        let metadata = Path::new("/vault/.yonalist");
        let hash = "a".repeat(64);
        let relative = format!("notes-assets/{hash}.png");
        assert_eq!(
            resolve_owned_asset_path(metadata, &relative, &hash, "image/png")
                .expect("canonical path"),
            metadata.join(&relative)
        );

        for unsafe_path in [
            format!("../{hash}.png"),
            format!("notes-assets/../{hash}.png"),
            format!("notes-assets/{hash}.jpg"),
            format!("notes-assets/extra/{hash}.png"),
            format!("/tmp/{hash}.png"),
        ] {
            assert!(
                resolve_owned_asset_path(metadata, &unsafe_path, &hash, "image/png").is_err(),
                "accepted unsafe path {unsafe_path}"
            );
        }
    }

    #[test]
    fn notes_attachment_storage_operations_are_serialized() {
        use std::sync::mpsc;
        use std::time::Duration;

        let (first_entered_tx, first_entered_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();
        let first = std::thread::spawn(move || {
            with_attachment_storage_lock(|| {
                first_entered_tx.send(()).expect("first entered");
                release_first_rx.recv().expect("release first");
                Ok(())
            })
            .expect("first operation");
        });
        first_entered_rx.recv().expect("first lock acquired");

        let (second_entered_tx, second_entered_rx) = mpsc::channel();
        let second = std::thread::spawn(move || {
            with_attachment_storage_lock(|| {
                second_entered_tx.send(()).expect("second entered");
                Ok(())
            })
            .expect("second operation");
        });
        assert!(
            second_entered_rx
                .recv_timeout(Duration::from_millis(50))
                .is_err(),
            "second operation entered before the first released storage"
        );

        release_first_tx.send(()).expect("release first");
        second_entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("second enters after release");
        first.join().expect("first thread");
        second.join().expect("second thread");
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_reconciliation_rejects_a_symlinked_owned_root() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let external_dir = tempfile::tempdir().expect("external dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let sentinel = external_dir.path().join("sentinel.png");
        fs::write(&sentinel, b"external sentinel").expect("sentinel");
        symlink(
            external_dir.path(),
            temp_dir.path().join(".yonalist/notes-assets"),
        )
        .expect("symlink asset root");

        let error = notes_initialize(vault_path).expect_err("symlinked root must fail closed");

        assert!(error.to_lowercase().contains("directory"), "{error}");
        assert_eq!(
            fs::read(&sentinel).expect("external sentinel remains"),
            b"external sentinel"
        );
    }

    #[test]
    fn notes_attachment_import_deduplicates_hashes_orders_workspace_and_bounds_width() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let first_source = write_source(&temp_dir, "first.png", &png);
        let second_source = write_source(&temp_dir, "second.png", &png);

        notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, first_source),
            None,
        )
        .expect("first import");
        let workspace = notes_import_attachment(
            vault_path.clone(),
            import_input(SECOND_ATTACHMENT_ID, second_source),
            None,
        )
        .expect("deduplicated import");
        let attachments = &workspace.attachments_by_node_id[NODE_ID];
        assert_eq!(
            attachments
                .iter()
                .map(|value| value.id.as_str())
                .collect::<Vec<_>>(),
            vec![ATTACHMENT_ID, SECOND_ATTACHMENT_ID]
        );
        assert_eq!(attachments[0].relative_path, attachments[1].relative_path);
        assert_eq!(attachments[0].display_width, 320);
        assert_eq!(
            fs::read_dir(temp_dir.path().join(".yonalist/notes-assets"))
                .expect("asset dir")
                .count(),
            1
        );
        assert_eq!(
            notes_read_attachment_bytes(vault_path.clone(), ATTACHMENT_ID.to_string())
                .expect("validated bytes"),
            png
        );

        for invalid_width in [159, 321] {
            assert!(notes_resize_attachment(
                vault_path.clone(),
                ResizeAttachmentInput {
                    id: ATTACHMENT_ID.to_string(),
                    display_width: invalid_width,
                },
                None,
            )
            .is_err());
        }
        let resized = notes_resize_attachment(
            vault_path,
            ResizeAttachmentInput {
                id: ATTACHMENT_ID.to_string(),
                display_width: 160,
            },
            None,
        )
        .expect("valid resize");
        assert_eq!(
            resized.attachments_by_node_id[NODE_ID][0].display_width,
            160
        );
    }

    #[test]
    fn notes_attachment_import_failures_reconcile_without_deleting_shared_hashes() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let first_png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let second_png = encoded_dimensions(ImageFormat::Png, 321, 200);
        let first_source = write_source(&temp_dir, "shared.png", &first_png);
        let second_source = write_source(&temp_dir, "unshared.png", &second_png);

        let blocked = prepare_source_attachment(&second_source).expect("prepare blocked publish");
        let blocked_relative =
            canonical_relative_path(&blocked.image.content_hash, blocked.image.mime_type)
                .expect("blocked relative path");
        let blocked_target = temp_dir.path().join(".yonalist").join(blocked_relative);
        fs::create_dir_all(&blocked_target).expect("blocking target directory");
        publish_attachment_bytes(&vault_path, &blocked).expect_err("directory target must fail");
        assert!(
            fs::read_dir(temp_dir.path().join(".yonalist/notes-assets"))
                .expect("asset dir")
                .all(|entry| !entry
                    .expect("asset entry")
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".attachment-")),
            "failed publish left a temporary file"
        );
        fs::remove_dir(blocked_target).expect("remove blocking target");

        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, first_source.clone()),
            None,
        )
        .expect("shared import");
        let shared_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&imported.attachments_by_node_id[NODE_ID][0].relative_path);

        let connection = connect_notes_db(&vault_path).expect("connect trigger");
        connection
            .execute_batch(
                "CREATE TRIGGER reject_attachment_import BEFORE INSERT ON notes_attachments \
                 BEGIN SELECT RAISE(ABORT, 'blocked attachment metadata'); END;",
            )
            .expect("install rejection");
        drop(connection);

        assert!(notes_import_attachment(
            vault_path.clone(),
            import_input(SECOND_ATTACHMENT_ID, first_source),
            None,
        )
        .is_err());
        assert!(
            shared_path.is_file(),
            "shared hash was deleted after metadata failure"
        );

        let unshared_error = notes_import_attachment(
            vault_path.clone(),
            import_input(SECOND_ATTACHMENT_ID, second_source),
            None,
        )
        .expect_err("metadata failure must surface");
        assert!(
            unshared_error.contains("blocked attachment metadata"),
            "{unshared_error}"
        );
        let entries = fs::read_dir(temp_dir.path().join(".yonalist/notes-assets"))
            .expect("asset dir")
            .collect::<Result<Vec<_>, _>>()
            .expect("asset entries");
        assert_eq!(
            entries.len(),
            1,
            "unshared file or temp file survived reconciliation"
        );

        let broken = write_source(&temp_dir, "broken.png", &first_png[..16]);
        assert!(notes_import_attachment(
            vault_path.clone(),
            import_input(SECOND_ATTACHMENT_ID, broken),
            None,
        )
        .is_err());

        let connection = connect_notes_db(&vault_path).expect("connect orphan");
        connection
            .execute_batch("DROP TRIGGER reject_attachment_import")
            .expect("drop rejection");
        connection
            .execute("DELETE FROM notes_attachments", [])
            .expect("orphan shared file");
        drop(connection);
        notes_initialize(vault_path).expect("startup reconciliation");
        assert!(
            !shared_path.exists(),
            "startup reconciliation kept an orphan"
        );
    }

    #[test]
    fn notes_attachment_history_replays_import_resize_remove_and_restore_metadata() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "history.png", &png);
        let import_context = history_context(1, "importAttachment");

        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            Some(import_context),
        )
        .expect("journaled import");
        let asset_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&imported.attachments_by_node_id[NODE_ID][0].relative_path);
        let mut connection = connect_notes_db(&vault_path).expect("connect history");
        let undone =
            undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("undo import");
        assert!(undone.workspace.attachments_by_node_id.is_empty());
        assert!(asset_path.is_file(), "redo-reachable bytes were removed");
        let redone =
            redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("redo import");
        assert_eq!(redone.workspace.attachments_by_node_id[NODE_ID].len(), 1);
        drop(connection);

        let resize_context = history_context(2, "resizeAttachment");
        notes_resize_attachment(
            vault_path.clone(),
            ResizeAttachmentInput {
                id: ATTACHMENT_ID.to_string(),
                display_width: 180,
            },
            Some(resize_context),
        )
        .expect("journaled resize");
        let mut connection = connect_notes_db(&vault_path).expect("connect resize history");
        assert_eq!(
            undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
                .expect("undo resize")
                .workspace
                .attachments_by_node_id[NODE_ID][0]
                .display_width,
            320
        );
        assert_eq!(
            redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
                .expect("redo resize")
                .workspace
                .attachments_by_node_id[NODE_ID][0]
                .display_width,
            180
        );
        drop(connection);

        let remove_context = history_context(3, "removeAttachment");
        notes_remove_attachment(
            vault_path.clone(),
            ATTACHMENT_ID.to_string(),
            Some(remove_context),
        )
        .expect("journaled remove");
        assert!(asset_path.is_file(), "undo-reachable bytes were removed");
        let restored = notes_restore_attachment(
            vault_path.clone(),
            ATTACHMENT_ID.to_string(),
            Some(history_context(4, "restoreAttachment")),
        )
        .expect("explicit history restore");
        assert_eq!(
            restored.attachments_by_node_id[NODE_ID][0].display_width,
            180
        );

        notes_remove_attachment(vault_path.clone(), ATTACHMENT_ID.to_string(), None)
            .expect("permanent metadata removal");
        notes_clear_history(vault_path, SESSION_ID.to_string()).expect("clear history");
        assert!(
            !asset_path.exists(),
            "unreferenced bytes survived history clearing"
        );
    }

    #[test]
    fn notes_attachment_history_rejects_stale_resize_replay_without_mutation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "stale.png", &png);
        notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import");
        notes_resize_attachment(
            vault_path.clone(),
            ResizeAttachmentInput {
                id: ATTACHMENT_ID.to_string(),
                display_width: 180,
            },
            Some(history_context(1, "resizeAttachment")),
        )
        .expect("journaled resize");
        let mut connection = connect_notes_db(&vault_path).expect("connect");
        connection
            .execute(
                "UPDATE notes_attachments SET display_width = 170 WHERE id = ?1",
                [ATTACHMENT_ID],
            )
            .expect("newer attachment update");

        let error = undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect_err("stale resize undo must conflict");

        assert!(error.to_lowercase().contains("history conflict"), "{error}");
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Active)
                .expect("workspace after conflict")
                .attachments_by_node_id[NODE_ID][0]
                .display_width,
            170
        );
    }

    #[test]
    fn notes_attachment_bytes_follow_live_trash_archive_and_reject_tampered_paths() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "lifecycle.png", &png);
        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import");
        let asset_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&imported.attachments_by_node_id[NODE_ID][0].relative_path);

        let mut connection = connect_notes_db(&vault_path).expect("connect lifecycle");
        soft_delete_node(&mut connection, NODE_ID).expect("trash node");
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Trash)
                .expect("trash workspace")
                .attachments_by_node_id[NODE_ID]
                .len(),
            1
        );
        restore_node(&mut connection, NODE_ID).expect("restore node");
        archive_node(&mut connection, NODE_ID).expect("archive node");
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Archive)
                .expect("archive workspace")
                .attachments_by_node_id[NODE_ID]
                .len(),
            1
        );
        unarchive_node(&mut connection, NODE_ID).expect("unarchive node");

        fs::write(&asset_path, &png[..16]).expect("truncate owned file");
        assert!(
            notes_read_attachment_bytes(vault_path.clone(), ATTACHMENT_ID.to_string()).is_err()
        );
        fs::write(&asset_path, &png).expect("repair owned file");

        let secret = temp_dir.path().join(".yonalist/secret.png");
        fs::write(&secret, b"must not be returned").expect("secret");
        connection
            .execute(
                "UPDATE notes_attachments SET relative_path = '../secret.png' WHERE id = ?1",
                params![ATTACHMENT_ID],
            )
            .expect("tamper path");
        drop(connection);
        assert!(
            notes_read_attachment_bytes(vault_path.clone(), ATTACHMENT_ID.to_string()).is_err()
        );

        let mut connection = connect_notes_db(&vault_path).expect("connect cleanup");
        connection
            .execute(
                "DELETE FROM notes_attachments WHERE id = ?1",
                [ATTACHMENT_ID],
            )
            .expect("remove corrupt metadata");
        soft_delete_node(&mut connection, NODE_ID).expect("trash for empty");
        drop(connection);
        notes_empty_trash(vault_path).expect("empty trash");
        assert_eq!(
            fs::read(&secret).expect("secret remains"),
            b"must not be returned"
        );
    }

    #[test]
    fn notes_attachment_empty_trash_removes_valid_unreferenced_owned_bytes() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "trash.png", &png);
        let workspace = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import");
        let asset_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&workspace.attachments_by_node_id[NODE_ID][0].relative_path);
        let mut connection = connect_notes_db(&vault_path).expect("connect");
        soft_delete_node(&mut connection, NODE_ID).expect("trash node");
        drop(connection);

        notes_empty_trash(vault_path).expect("empty trash");

        assert!(!asset_path.exists());
    }

    #[test]
    fn notes_attachment_prevents_image_only_nodes_from_being_removed_as_empty() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let connection = connect_notes_db(&vault_path).expect("connect empty seed");
        connection
            .execute(
                "UPDATE notes_nodes SET title = '', note = '' WHERE id = ?1",
                [NODE_ID],
            )
            .expect("empty node text");
        drop(connection);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "not-empty.png", &png);
        notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import");
        let mut connection = connect_notes_db(&vault_path).expect("connect");

        let error = remove_empty_node(&mut connection, NODE_ID)
            .expect_err("an attached image makes the node non-empty");

        assert!(error.to_lowercase().contains("empty"), "{error}");
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Active)
                .expect("active workspace")
                .attachments_by_node_id[NODE_ID]
                .len(),
            1
        );
    }
}
