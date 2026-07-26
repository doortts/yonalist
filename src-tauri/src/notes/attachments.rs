#[cfg(unix)]
use cap_fs_ext::OpenOptionsExt;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
use fs4::FileExt;
use image::codecs::{gif::GifDecoder, webp::WebPDecoder};
use image::{AnimationDecoder, ImageDecoder, ImageFormat, ImageReader, Limits};
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufReader, Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use crate::file_io::rename_noreplace;
use crate::file_io::{
    capability_file_identity, capability_file_link_count, capability_metadata_is_reparse_point,
    hold_capability_regular_file_bounded_nofollow, HeldBoundedCapabilityFile,
    TryCapabilityFileIdentity, TryCapabilityFileLinkCount,
};
use crate::notes::attachment_ingest::RawAttachmentSource;
use crate::notes::repository::{notes_vault_generation, validate_vault_path};
use crate::notes::types::{ExportAttachment, NoteAttachment};

pub(crate) const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
pub(crate) const MAX_ATTACHMENT_BATCH_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const MAX_ATTACHMENT_PIXELS: u64 = 40_000_000;
pub(crate) const MAX_ATTACHMENT_CONTAINER_CHUNKS: u64 = 100_000;
// Animations retain the static canvas cap and may decode at most four full-size canvases total.
pub(crate) const MAX_ATTACHMENT_FRAMES: u64 = 256;
pub(crate) const MAX_ATTACHMENT_DECODED_PIXEL_WORK: u64 = 160_000_000;
const RECONCILIATION_MARKER: &str = ".notes-assets-reconcile-needed";
const ATTACHMENT_QUARANTINE_PREFIX: &str = ".attachment-quarantine-";
const ATTACHMENT_RECOVERY_PREFIX: &str = ".attachment-recovery-";
const ATTACHMENT_STREAM_CHUNK_BYTES: usize = 1024 * 1024;
/// Default ceiling on how long `AttachmentStorageLease::acquire` polls for the
/// exclusive vault lock before giving up. Without a deadline, a second app
/// instance holding the lease freezes every mutating command indefinitely.
const ATTACHMENT_LEASE_ACQUIRE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// Interval between `try_lock` attempts while waiting for the vault lock.
const ATTACHMENT_LEASE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);
/// User-facing error surfaced when the vault lock cannot be acquired before the
/// deadline (typically because another Yonalist window holds it).
pub(crate) const ATTACHMENT_LEASE_BUSY_MESSAGE: &str =
    "Notes vault is busy in another window. Close other Yonalist windows and try again.";
/// Name of the vault-level application lock inside `.yonalist`. Held for the
/// connection manager's (process) lifetime so only one app instance opens a
/// vault at a time; distinct from the short-lived attachment storage lease.
pub(crate) const VAULT_APP_LOCK_NAME: &str = "notes.app.lock";

/// Verifies every already-committed attachment before an idempotent retry can
/// report success. Retries must never repair a missing or corrupt owned asset
/// from request bytes.
pub(crate) fn validate_committed_retry_assets(
    storage: &AttachmentStorageLease,
    attachments: &[NoteAttachment],
) -> Result<(), String> {
    for attachment in attachments {
        storage
            .read_validated_attachment_bytes(attachment)
            .map_err(|error| {
                format!(
                    "Could not verify committed Notes attachment retry asset {}: {error}",
                    attachment.id
                )
            })?;
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sha256_reader(mut reader: impl Read, max_bytes: u64) -> Result<String, String> {
    let mut hasher = Sha256::new();
    let mut observed = 0_u64;
    let mut buffer = vec![0_u8; ATTACHMENT_STREAM_CHUNK_BYTES];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("Could not hash the Notes attachment image: {error}"))?;
        if read == 0 {
            break;
        }
        observed = observed
            .checked_add(u64::try_from(read).unwrap_or(0))
            .ok_or_else(|| "The Notes attachment byte count overflowed.".to_string())?;
        if observed > max_bytes {
            return Err(format!(
                "Notes attachment images must contain at most {max_bytes} bytes."
            ));
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
/// User-facing error when another OS-level app instance already holds the
/// vault application lock.
pub(crate) const VAULT_APP_LOCK_BUSY_MESSAGE: &str =
    "Notes vault is already open in another window.";
struct AttachmentImportBudgetState {
    occupied: bool,
    async_waiters: Vec<std::task::Waker>,
}

static IMPORT_BUDGET_STATE: Mutex<AttachmentImportBudgetState> =
    Mutex::new(AttachmentImportBudgetState {
        occupied: false,
        async_waiters: Vec::new(),
    });
static IMPORT_BUDGET_AVAILABLE: Condvar = Condvar::new();
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
thread_local! {
    static ATTACHMENT_STORAGE_AFTER_APP_LOCK_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn inject_attachment_storage_after_app_lock_once(action: impl FnOnce() + 'static) {
    ATTACHMENT_STORAGE_AFTER_APP_LOCK_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

fn maybe_inject_attachment_storage_after_app_lock() {
    #[cfg(test)]
    if let Some(action) =
        ATTACHMENT_STORAGE_AFTER_APP_LOCK_HOOK.with(|slot| slot.borrow_mut().take())
    {
        action();
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ValidationLimits {
    pub(crate) max_bytes: u64,
    pub(crate) max_pixels: u64,
    pub(crate) max_container_chunks: u64,
    pub(crate) max_frames: u64,
    pub(crate) max_decoded_pixel_work: u64,
}

impl ValidationLimits {
    pub(crate) const DEFAULT: Self = Self {
        max_bytes: MAX_ATTACHMENT_BYTES,
        max_pixels: MAX_ATTACHMENT_PIXELS,
        max_container_chunks: MAX_ATTACHMENT_CONTAINER_CHUNKS,
        max_frames: MAX_ATTACHMENT_FRAMES,
        max_decoded_pixel_work: MAX_ATTACHMENT_DECODED_PIXEL_WORK,
    };
}

#[derive(Debug, Clone, Copy)]
struct ContainerInspection {
    frame_count: u64,
    animated: bool,
}

impl ContainerInspection {
    const STATIC: Self = Self {
        frame_count: 1,
        animated: false,
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
    source: PreparedAttachmentSource,
    pub(crate) original_name: String,
    pub(crate) image: ValidatedImage,
}

#[derive(Debug)]
enum PreparedAttachmentSource {
    Bytes(Vec<u8>),
    StagedFile(File),
}

pub(crate) trait AttachmentIngestProgress: Send + Sync {
    fn hashing(&self, bytes_done: u64, bytes_total: u64);
    fn copying_started(&self, byte_size: u64);
    fn copying(&self, byte_delta: u64);
    fn done(&self, content_hash: &str);
}

#[derive(Debug)]
struct AttachmentImportLease;

#[derive(Clone, Debug)]
pub(crate) struct AttachmentImportPermit {
    _lease: Arc<AttachmentImportLease>,
}

#[derive(Debug)]
pub(crate) struct PreparedAttachmentBatch {
    _budget: AttachmentImportPermit,
    attachments: Vec<PreparedAttachment>,
}

impl Drop for AttachmentImportLease {
    fn drop(&mut self) {
        let mut state = IMPORT_BUDGET_STATE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.occupied = false;
        let async_waiters = std::mem::take(&mut state.async_waiters);
        drop(state);
        IMPORT_BUDGET_AVAILABLE.notify_all();
        for waiter in async_waiters {
            waiter.wake();
        }
    }
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

fn decoder_limits(dimensions: (u32, u32), limits: ValidationLimits) -> Limits {
    let mut decode_limits = Limits::default();
    decode_limits.max_image_width = Some(dimensions.0);
    decode_limits.max_image_height = Some(dimensions.1);
    decode_limits.max_alloc = Some(limits.max_pixels.saturating_mul(8));
    decode_limits
}

fn validate_decoded_dimensions(
    dimensions: (u64, u64),
    limits: ValidationLimits,
) -> Result<u64, String> {
    let pixels = dimensions
        .0
        .checked_mul(dimensions.1)
        .ok_or_else(|| "The Notes attachment decoded pixel count is too large.".to_string())?;
    if dimensions.0 == 0 || dimensions.1 == 0 || pixels > limits.max_pixels {
        return Err(format!(
            "Notes attachment images must contain between 1 and {} decoded pixels.",
            limits.max_pixels
        ));
    }
    Ok(pixels)
}

fn count_container_chunk(count: &mut u64, limits: ValidationLimits) -> Result<(), String> {
    *count = count
        .checked_add(1)
        .ok_or_else(|| "The Notes attachment container is too complex.".to_string())?;
    if *count > limits.max_container_chunks {
        return Err(format!(
            "Notes attachment containers must contain at most {} chunks.",
            limits.max_container_chunks
        ));
    }
    Ok(())
}

fn checked_advance(
    bytes: &[u8],
    offset: &mut usize,
    length: usize,
    format: &str,
) -> Result<(), String> {
    *offset = offset
        .checked_add(length)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| {
            format!("Could not decode the truncated Notes attachment {format} container.")
        })?;
    Ok(())
}

fn skip_gif_sub_blocks(
    bytes: &[u8],
    offset: &mut usize,
    chunks: &mut u64,
    limits: ValidationLimits,
) -> Result<(), String> {
    loop {
        count_container_chunk(chunks, limits)?;
        let length = *bytes.get(*offset).ok_or_else(|| {
            "Could not decode the truncated Notes attachment GIF container.".to_string()
        })? as usize;
        checked_advance(bytes, offset, 1, "GIF")?;
        if length == 0 {
            return Ok(());
        }
        checked_advance(bytes, offset, length, "GIF")?;
    }
}

fn count_animation_frame(
    frame_count: &mut u64,
    decoded_pixel_work: &mut u64,
    canvas_pixels: u64,
    limits: ValidationLimits,
) -> Result<(), String> {
    *frame_count = frame_count
        .checked_add(1)
        .ok_or_else(|| "The Notes attachment frame count is too large.".to_string())?;
    if *frame_count > limits.max_frames {
        let unit = if limits.max_frames == 1 {
            "frame"
        } else {
            "frames"
        };
        return Err(format!(
            "Animated Notes attachment images must contain at most {} {unit}.",
            limits.max_frames,
        ));
    }
    *decoded_pixel_work = decoded_pixel_work
        .checked_add(canvas_pixels)
        .ok_or_else(|| "The Notes attachment decoded-pixel work is too large.".to_string())?;
    if *decoded_pixel_work > limits.max_decoded_pixel_work {
        return Err(format!(
            "Animated Notes attachment images must require at most {} aggregate decoded pixels.",
            limits.max_decoded_pixel_work
        ));
    }
    Ok(())
}

fn inspect_gif(bytes: &[u8], limits: ValidationLimits) -> Result<ContainerInspection, String> {
    if bytes.len() < 13 || !matches!(&bytes[..6], b"GIF87a" | b"GIF89a") {
        return Err("Could not decode the Notes attachment GIF container.".to_string());
    }
    let canvas_width = u32::from(u16::from_le_bytes(bytes[6..8].try_into().unwrap()));
    let canvas_height = u32::from(u16::from_le_bytes(bytes[8..10].try_into().unwrap()));
    let canvas_pixels =
        validate_decoded_dimensions((u64::from(canvas_width), u64::from(canvas_height)), limits)?;
    let packed = bytes[10];
    let mut offset = 13_usize;
    if packed & 0x80 != 0 {
        let table_entries = 1_usize << (usize::from(packed & 0x07) + 1);
        checked_advance(bytes, &mut offset, table_entries * 3, "GIF")?;
    }
    let mut chunks = 0_u64;
    let mut frame_count = 0_u64;
    let mut decoded_pixel_work = 0_u64;
    loop {
        count_container_chunk(&mut chunks, limits)?;
        let marker = *bytes.get(offset).ok_or_else(|| {
            "Could not decode the truncated Notes attachment GIF container.".to_string()
        })?;
        checked_advance(bytes, &mut offset, 1, "GIF")?;
        match marker {
            0x2c => {
                let descriptor_start = offset;
                checked_advance(bytes, &mut offset, 9, "GIF")?;
                let left = u32::from(u16::from_le_bytes(
                    bytes[descriptor_start..descriptor_start + 2]
                        .try_into()
                        .unwrap(),
                ));
                let top = u32::from(u16::from_le_bytes(
                    bytes[descriptor_start + 2..descriptor_start + 4]
                        .try_into()
                        .unwrap(),
                ));
                let width = u32::from(u16::from_le_bytes(
                    bytes[descriptor_start + 4..descriptor_start + 6]
                        .try_into()
                        .unwrap(),
                ));
                let height = u32::from(u16::from_le_bytes(
                    bytes[descriptor_start + 6..descriptor_start + 8]
                        .try_into()
                        .unwrap(),
                ));
                if width == 0
                    || height == 0
                    || left
                        .checked_add(width)
                        .map_or(true, |right| right > canvas_width)
                    || top
                        .checked_add(height)
                        .map_or(true, |bottom| bottom > canvas_height)
                {
                    return Err(
                        "Could not decode the Notes attachment GIF frame bounds.".to_string()
                    );
                }
                count_animation_frame(
                    &mut frame_count,
                    &mut decoded_pixel_work,
                    canvas_pixels,
                    limits,
                )?;
                let descriptor_packed = bytes[descriptor_start + 8];
                if descriptor_packed & 0x80 != 0 {
                    let entries = 1_usize << (usize::from(descriptor_packed & 0x07) + 1);
                    checked_advance(bytes, &mut offset, entries * 3, "GIF")?;
                }
                checked_advance(bytes, &mut offset, 1, "GIF")?;
                skip_gif_sub_blocks(bytes, &mut offset, &mut chunks, limits)?;
            }
            0x21 => {
                checked_advance(bytes, &mut offset, 1, "GIF")?;
                skip_gif_sub_blocks(bytes, &mut offset, &mut chunks, limits)?;
            }
            0x3b => {
                if frame_count == 0 || offset != bytes.len() {
                    return Err("Could not decode the Notes attachment GIF container.".to_string());
                }
                return Ok(ContainerInspection {
                    frame_count,
                    animated: frame_count > 1,
                });
            }
            _ => return Err("Could not decode the Notes attachment GIF container.".to_string()),
        }
    }
}

fn inspect_static_png(
    bytes: &[u8],
    limits: ValidationLimits,
) -> Result<ContainerInspection, String> {
    if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("Could not decode the Notes attachment PNG container.".to_string());
    }
    let mut offset = 8_usize;
    let mut chunks = 0_u64;
    let mut saw_end = false;
    while offset < bytes.len() {
        count_container_chunk(&mut chunks, limits)?;
        let header_end = offset
            .checked_add(8)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| {
                "Could not decode the truncated Notes attachment PNG container.".to_string()
            })?;
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let kind: [u8; 4] = bytes[offset + 4..header_end].try_into().unwrap();
        offset = header_end;
        let payload_and_crc = length.checked_add(4).ok_or_else(|| {
            "Could not decode the truncated Notes attachment PNG container.".to_string()
        })?;
        checked_advance(bytes, &mut offset, payload_and_crc, "PNG")?;
        if &kind == b"acTL" {
            return Err("Animated PNG Notes attachments are not supported.".to_string());
        }
        if &kind == b"IEND" {
            saw_end = true;
            break;
        }
    }
    if !saw_end || offset != bytes.len() {
        return Err("Could not decode the Notes attachment PNG container.".to_string());
    }
    Ok(ContainerInspection::STATIC)
}

fn webp_u24(bytes: &[u8]) -> u32 {
    u32::from(bytes[0]) | (u32::from(bytes[1]) << 8) | (u32::from(bytes[2]) << 16)
}

fn inspect_webp_frame_payload(
    bytes: &[u8],
    chunks: &mut u64,
    limits: ValidationLimits,
) -> Result<(), String> {
    let mut offset = 0_usize;
    let mut saw_alpha = false;
    let mut saw_image = false;
    while offset < bytes.len() {
        count_container_chunk(chunks, limits)?;
        let header_end = offset
            .checked_add(8)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| {
                "Could not decode the truncated Notes attachment WebP frame.".to_string()
            })?;
        let kind: [u8; 4] = bytes[offset..offset + 4].try_into().unwrap();
        let length = u32::from_le_bytes(bytes[offset + 4..header_end].try_into().unwrap()) as usize;
        offset = header_end;
        checked_advance(bytes, &mut offset, length, "WebP")?;
        if length % 2 != 0 {
            checked_advance(bytes, &mut offset, 1, "WebP")?;
        }
        match &kind {
            b"ALPH" if !saw_alpha && !saw_image => saw_alpha = true,
            b"VP8 " | b"VP8L" if !saw_image => saw_image = true,
            _ => return Err("Could not decode the Notes attachment WebP frame chunks.".to_string()),
        }
    }
    if !saw_image {
        return Err("Could not decode the Notes attachment WebP frame image.".to_string());
    }
    Ok(())
}

fn inspect_webp(bytes: &[u8], limits: ValidationLimits) -> Result<ContainerInspection, String> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err("Could not decode the Notes attachment WebP container.".to_string());
    }
    let declared = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    if declared.checked_add(8) != Some(bytes.len()) {
        return Err("Could not decode the truncated Notes attachment WebP container.".to_string());
    }
    let mut offset = 12_usize;
    let mut chunks = 0_u64;
    let mut canvas = None;
    let mut animation_flag = false;
    let mut saw_animation_header = false;
    let mut saw_static_image = false;
    let mut frame_count = 0_u64;
    let mut decoded_pixel_work = 0_u64;
    while offset < bytes.len() {
        count_container_chunk(&mut chunks, limits)?;
        let header_end = offset
            .checked_add(8)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| {
                "Could not decode the truncated Notes attachment WebP container.".to_string()
            })?;
        let kind: [u8; 4] = bytes[offset..offset + 4].try_into().unwrap();
        let length = u32::from_le_bytes(bytes[offset + 4..header_end].try_into().unwrap()) as usize;
        offset = header_end;
        let payload_start = offset;
        checked_advance(bytes, &mut offset, length, "WebP")?;
        if length % 2 != 0 {
            checked_advance(bytes, &mut offset, 1, "WebP")?;
        }
        let payload = &bytes[payload_start..payload_start + length];
        match &kind {
            b"VP8X" => {
                if canvas.is_some() || payload.len() != 10 || payload[0] & 0xc1 != 0 {
                    return Err(
                        "Could not decode the Notes attachment WebP extended header.".to_string(),
                    );
                }
                let width = webp_u24(&payload[4..7]) + 1;
                let height = webp_u24(&payload[7..10]) + 1;
                canvas = Some((width, height));
                animation_flag = payload[0] & 0x02 != 0;
            }
            b"ANIM" => {
                if !animation_flag || saw_animation_header || payload.len() != 6 {
                    return Err(
                        "Could not decode the Notes attachment WebP animation header.".to_string(),
                    );
                }
                saw_animation_header = true;
            }
            b"ANMF" => {
                let (canvas_width, canvas_height) = canvas.ok_or_else(|| {
                    "Could not decode the Notes attachment WebP animation canvas.".to_string()
                })?;
                if !animation_flag || !saw_animation_header || payload.len() < 16 {
                    return Err(
                        "Could not decode the Notes attachment WebP animation frame.".to_string(),
                    );
                }
                let left = webp_u24(&payload[0..3]).checked_mul(2).ok_or_else(|| {
                    "Could not decode the Notes attachment WebP frame bounds.".to_string()
                })?;
                let top = webp_u24(&payload[3..6]).checked_mul(2).ok_or_else(|| {
                    "Could not decode the Notes attachment WebP frame bounds.".to_string()
                })?;
                let width = webp_u24(&payload[6..9]) + 1;
                let height = webp_u24(&payload[9..12]) + 1;
                if left
                    .checked_add(width)
                    .map_or(true, |right| right > canvas_width)
                    || top
                        .checked_add(height)
                        .map_or(true, |bottom| bottom > canvas_height)
                {
                    return Err(
                        "Could not decode the Notes attachment WebP frame bounds.".to_string()
                    );
                }
                inspect_webp_frame_payload(&payload[16..], &mut chunks, limits)?;
                let canvas_pixels = u64::from(canvas_width)
                    .checked_mul(u64::from(canvas_height))
                    .ok_or_else(|| {
                        "The Notes attachment decoded pixel count is too large.".to_string()
                    })?;
                count_animation_frame(
                    &mut frame_count,
                    &mut decoded_pixel_work,
                    canvas_pixels,
                    limits,
                )?;
            }
            b"VP8 " | b"VP8L" => {
                if saw_static_image || animation_flag {
                    return Err(
                        "Could not decode the Notes attachment WebP image chunks.".to_string()
                    );
                }
                saw_static_image = true;
            }
            _ => {}
        }
    }
    if animation_flag {
        if !saw_animation_header || frame_count == 0 || saw_static_image {
            return Err("Could not decode the Notes attachment WebP animation.".to_string());
        }
        Ok(ContainerInspection {
            frame_count,
            animated: true,
        })
    } else if saw_animation_header || frame_count != 0 || !saw_static_image {
        Err("Could not decode the Notes attachment WebP container.".to_string())
    } else {
        Ok(ContainerInspection::STATIC)
    }
}

fn inspect_container(
    format: ImageFormat,
    bytes: &[u8],
    limits: ValidationLimits,
) -> Result<ContainerInspection, String> {
    match format {
        ImageFormat::Gif => inspect_gif(bytes, limits),
        ImageFormat::Png => inspect_static_png(bytes, limits),
        ImageFormat::WebP => inspect_webp(bytes, limits),
        ImageFormat::Jpeg => Ok(ContainerInspection::STATIC),
        _ => Err("The Notes attachment image format is unsupported.".to_string()),
    }
}

fn fully_decode_image(
    format: ImageFormat,
    bytes: &[u8],
    dimensions: (u32, u32),
    inspection: ContainerInspection,
    limits: ValidationLimits,
) -> Result<(), String> {
    let decode_animation = |frames: image::Frames<'_>| -> Result<(), String> {
        let mut decoded_frames = 0_u64;
        for frame in frames {
            frame.map_err(|error| {
                format!("Could not decode a Notes attachment animation frame: {error}")
            })?;
            decoded_frames += 1;
        }
        if decoded_frames != inspection.frame_count {
            return Err(
                "The Notes attachment decoded frame count does not match its container."
                    .to_string(),
            );
        }
        Ok(())
    };
    if format == ImageFormat::Gif {
        let mut decoder = GifDecoder::new(Cursor::new(bytes))
            .map_err(|error| format!("Could not decode the Notes attachment GIF: {error}"))?;
        decoder
            .set_limits(decoder_limits(dimensions, limits))
            .map_err(|error| format!("Could not limit the Notes attachment GIF: {error}"))?;
        return decode_animation(decoder.into_frames());
    }
    if format == ImageFormat::WebP && inspection.animated {
        let decoder = WebPDecoder::new(Cursor::new(bytes))
            .map_err(|error| format!("Could not decode the Notes attachment WebP: {error}"))?;
        return decode_animation(decoder.into_frames());
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(decoder_limits(dimensions, limits));
    reader
        .decode()
        .map(|_| ())
        .map_err(|error| format!("Could not decode the Notes attachment image: {error}"))
}

fn source_reader(file: &File) -> Result<BufReader<File>, String> {
    let mut file = file
        .try_clone()
        .map_err(|error| format!("Could not clone the Notes attachment source: {error}"))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("Could not seek the Notes attachment source: {error}"))?;
    Ok(BufReader::new(file))
}

fn read_exact_container(
    reader: &mut (impl Read + Seek),
    bytes: &mut [u8],
    format: &str,
) -> Result<(), String> {
    reader
        .read_exact(bytes)
        .map_err(|_| format!("Could not decode the truncated Notes attachment {format} container."))
}

fn skip_container_bytes(
    reader: &mut (impl Read + Seek),
    byte_size: u64,
    length: u64,
    format: &str,
) -> Result<(), String> {
    let position = reader
        .stream_position()
        .map_err(|error| format!("Could not inspect the Notes attachment {format}: {error}"))?;
    let target = position
        .checked_add(length)
        .filter(|target| *target <= byte_size)
        .ok_or_else(|| {
            format!("Could not decode the truncated Notes attachment {format} container.")
        })?;
    reader
        .seek(SeekFrom::Start(target))
        .map_err(|error| format!("Could not inspect the Notes attachment {format}: {error}"))?;
    Ok(())
}

fn skip_gif_sub_blocks_reader(
    reader: &mut (impl Read + Seek),
    byte_size: u64,
    chunks: &mut u64,
    limits: ValidationLimits,
) -> Result<(), String> {
    loop {
        count_container_chunk(chunks, limits)?;
        let mut length = [0_u8; 1];
        read_exact_container(reader, &mut length, "GIF")?;
        if length[0] == 0 {
            return Ok(());
        }
        skip_container_bytes(reader, byte_size, u64::from(length[0]), "GIF")?;
    }
}

fn inspect_gif_reader(
    reader: &mut (impl Read + Seek),
    byte_size: u64,
    limits: ValidationLimits,
) -> Result<ContainerInspection, String> {
    let mut header = [0_u8; 13];
    read_exact_container(reader, &mut header, "GIF")?;
    if !matches!(&header[..6], b"GIF87a" | b"GIF89a") {
        return Err("Could not decode the Notes attachment GIF container.".to_string());
    }
    let canvas_width = u32::from(u16::from_le_bytes(header[6..8].try_into().unwrap()));
    let canvas_height = u32::from(u16::from_le_bytes(header[8..10].try_into().unwrap()));
    let canvas_pixels =
        validate_decoded_dimensions((u64::from(canvas_width), u64::from(canvas_height)), limits)?;
    if header[10] & 0x80 != 0 {
        let entries = 1_u64 << (u64::from(header[10] & 0x07) + 1);
        skip_container_bytes(reader, byte_size, entries * 3, "GIF")?;
    }
    let mut chunks = 0_u64;
    let mut frame_count = 0_u64;
    let mut decoded_pixel_work = 0_u64;
    loop {
        count_container_chunk(&mut chunks, limits)?;
        let mut marker = [0_u8; 1];
        read_exact_container(reader, &mut marker, "GIF")?;
        match marker[0] {
            0x2c => {
                let mut descriptor = [0_u8; 9];
                read_exact_container(reader, &mut descriptor, "GIF")?;
                let left = u32::from(u16::from_le_bytes(descriptor[0..2].try_into().unwrap()));
                let top = u32::from(u16::from_le_bytes(descriptor[2..4].try_into().unwrap()));
                let width = u32::from(u16::from_le_bytes(descriptor[4..6].try_into().unwrap()));
                let height = u32::from(u16::from_le_bytes(descriptor[6..8].try_into().unwrap()));
                if width == 0
                    || height == 0
                    || left
                        .checked_add(width)
                        .map_or(true, |right| right > canvas_width)
                    || top
                        .checked_add(height)
                        .map_or(true, |bottom| bottom > canvas_height)
                {
                    return Err(
                        "Could not decode the Notes attachment GIF frame bounds.".to_string()
                    );
                }
                count_animation_frame(
                    &mut frame_count,
                    &mut decoded_pixel_work,
                    canvas_pixels,
                    limits,
                )?;
                if descriptor[8] & 0x80 != 0 {
                    let entries = 1_u64 << (u64::from(descriptor[8] & 0x07) + 1);
                    skip_container_bytes(reader, byte_size, entries * 3, "GIF")?;
                }
                skip_container_bytes(reader, byte_size, 1, "GIF")?;
                skip_gif_sub_blocks_reader(reader, byte_size, &mut chunks, limits)?;
            }
            0x21 => {
                skip_container_bytes(reader, byte_size, 1, "GIF")?;
                skip_gif_sub_blocks_reader(reader, byte_size, &mut chunks, limits)?;
            }
            0x3b => {
                let position = reader.stream_position().map_err(|error| {
                    format!("Could not inspect the Notes attachment GIF: {error}")
                })?;
                if frame_count == 0 || position != byte_size {
                    return Err("Could not decode the Notes attachment GIF container.".to_string());
                }
                return Ok(ContainerInspection {
                    frame_count,
                    animated: frame_count > 1,
                });
            }
            _ => return Err("Could not decode the Notes attachment GIF container.".to_string()),
        }
    }
}

fn inspect_png_reader(
    reader: &mut (impl Read + Seek),
    byte_size: u64,
    limits: ValidationLimits,
) -> Result<ContainerInspection, String> {
    let mut signature = [0_u8; 8];
    read_exact_container(reader, &mut signature, "PNG")?;
    if signature != [137, 80, 78, 71, 13, 10, 26, 10] {
        return Err("Could not decode the Notes attachment PNG container.".to_string());
    }
    let mut chunks = 0_u64;
    loop {
        count_container_chunk(&mut chunks, limits)?;
        let mut header = [0_u8; 8];
        read_exact_container(reader, &mut header, "PNG")?;
        let length = u64::from(u32::from_be_bytes(header[..4].try_into().unwrap()));
        let kind: [u8; 4] = header[4..].try_into().unwrap();
        skip_container_bytes(reader, byte_size, length.saturating_add(4), "PNG")?;
        if &kind == b"acTL" {
            return Err("Animated PNG Notes attachments are not supported.".to_string());
        }
        if &kind == b"IEND" {
            let position = reader
                .stream_position()
                .map_err(|error| format!("Could not inspect the Notes attachment PNG: {error}"))?;
            if length != 0 || position != byte_size {
                return Err("Could not decode the Notes attachment PNG container.".to_string());
            }
            return Ok(ContainerInspection::STATIC);
        }
    }
}

fn inspect_webp_frame_reader(
    reader: &mut (impl Read + Seek),
    frame_end: u64,
    chunks: &mut u64,
    limits: ValidationLimits,
) -> Result<(), String> {
    let mut saw_alpha = false;
    let mut saw_image = false;
    while reader
        .stream_position()
        .map_err(|error| error.to_string())?
        < frame_end
    {
        count_container_chunk(chunks, limits)?;
        let mut header = [0_u8; 8];
        read_exact_container(reader, &mut header, "WebP frame")?;
        let kind: [u8; 4] = header[..4].try_into().unwrap();
        let length = u64::from(u32::from_le_bytes(header[4..].try_into().unwrap()));
        let padded = length.saturating_add(length % 2);
        skip_container_bytes(reader, frame_end, padded, "WebP frame")?;
        match &kind {
            b"ALPH" if !saw_alpha && !saw_image => saw_alpha = true,
            b"VP8 " | b"VP8L" if !saw_image => saw_image = true,
            _ => return Err("Could not decode the Notes attachment WebP frame chunks.".to_string()),
        }
    }
    if !saw_image {
        return Err("Could not decode the Notes attachment WebP frame image.".to_string());
    }
    Ok(())
}

fn inspect_webp_reader(
    reader: &mut (impl Read + Seek),
    byte_size: u64,
    limits: ValidationLimits,
) -> Result<ContainerInspection, String> {
    let mut riff = [0_u8; 12];
    read_exact_container(reader, &mut riff, "WebP")?;
    if &riff[..4] != b"RIFF" || &riff[8..] != b"WEBP" {
        return Err("Could not decode the Notes attachment WebP container.".to_string());
    }
    if u64::from(u32::from_le_bytes(riff[4..8].try_into().unwrap())).saturating_add(8) != byte_size
    {
        return Err("Could not decode the truncated Notes attachment WebP container.".to_string());
    }
    let mut chunks = 0_u64;
    let mut canvas = None;
    let mut animation_flag = false;
    let mut saw_animation_header = false;
    let mut saw_static_image = false;
    let mut frame_count = 0_u64;
    let mut decoded_pixel_work = 0_u64;
    while reader
        .stream_position()
        .map_err(|error| error.to_string())?
        < byte_size
    {
        count_container_chunk(&mut chunks, limits)?;
        let mut header = [0_u8; 8];
        read_exact_container(reader, &mut header, "WebP")?;
        let kind: [u8; 4] = header[..4].try_into().unwrap();
        let length = u64::from(u32::from_le_bytes(header[4..].try_into().unwrap()));
        let payload_start = reader
            .stream_position()
            .map_err(|error| format!("Could not inspect the Notes attachment WebP: {error}"))?;
        let payload_end = payload_start
            .checked_add(length)
            .filter(|end| *end <= byte_size)
            .ok_or_else(|| {
                "Could not decode the truncated Notes attachment WebP container.".to_string()
            })?;
        match &kind {
            b"VP8X" => {
                let mut payload = [0_u8; 10];
                if canvas.is_some() || length != 10 {
                    return Err(
                        "Could not decode the Notes attachment WebP extended header.".to_string(),
                    );
                }
                read_exact_container(reader, &mut payload, "WebP")?;
                if payload[0] & 0xc1 != 0 {
                    return Err(
                        "Could not decode the Notes attachment WebP extended header.".to_string(),
                    );
                }
                canvas = Some((webp_u24(&payload[4..7]) + 1, webp_u24(&payload[7..10]) + 1));
                animation_flag = payload[0] & 0x02 != 0;
            }
            b"ANIM" => {
                if !animation_flag || saw_animation_header || length != 6 {
                    return Err(
                        "Could not decode the Notes attachment WebP animation header.".to_string(),
                    );
                }
                saw_animation_header = true;
                skip_container_bytes(reader, payload_end, 6, "WebP")?;
            }
            b"ANMF" => {
                let (canvas_width, canvas_height) = canvas.ok_or_else(|| {
                    "Could not decode the Notes attachment WebP animation canvas.".to_string()
                })?;
                if !animation_flag || !saw_animation_header || length < 16 {
                    return Err(
                        "Could not decode the Notes attachment WebP animation frame.".to_string(),
                    );
                }
                let mut frame = [0_u8; 16];
                read_exact_container(reader, &mut frame, "WebP")?;
                let left = webp_u24(&frame[0..3]).checked_mul(2).ok_or_else(|| {
                    "Could not decode the Notes attachment WebP frame bounds.".to_string()
                })?;
                let top = webp_u24(&frame[3..6]).checked_mul(2).ok_or_else(|| {
                    "Could not decode the Notes attachment WebP frame bounds.".to_string()
                })?;
                let width = webp_u24(&frame[6..9]) + 1;
                let height = webp_u24(&frame[9..12]) + 1;
                if left
                    .checked_add(width)
                    .map_or(true, |right| right > canvas_width)
                    || top
                        .checked_add(height)
                        .map_or(true, |bottom| bottom > canvas_height)
                {
                    return Err(
                        "Could not decode the Notes attachment WebP frame bounds.".to_string()
                    );
                }
                inspect_webp_frame_reader(reader, payload_end, &mut chunks, limits)?;
                let canvas_pixels = u64::from(canvas_width)
                    .checked_mul(u64::from(canvas_height))
                    .ok_or_else(|| {
                        "The Notes attachment decoded pixel count is too large.".to_string()
                    })?;
                count_animation_frame(
                    &mut frame_count,
                    &mut decoded_pixel_work,
                    canvas_pixels,
                    limits,
                )?;
            }
            b"VP8 " | b"VP8L" => {
                if saw_static_image || animation_flag {
                    return Err(
                        "Could not decode the Notes attachment WebP image chunks.".to_string()
                    );
                }
                saw_static_image = true;
                skip_container_bytes(reader, payload_end, length, "WebP")?;
            }
            _ => skip_container_bytes(reader, payload_end, length, "WebP")?,
        }
        let position = reader
            .stream_position()
            .map_err(|error| format!("Could not inspect the Notes attachment WebP: {error}"))?;
        if position != payload_end {
            return Err("Could not decode the Notes attachment WebP container.".to_string());
        }
        if length % 2 != 0 {
            skip_container_bytes(reader, byte_size, 1, "WebP")?;
        }
    }
    if animation_flag {
        if !saw_animation_header || frame_count == 0 || saw_static_image {
            return Err("Could not decode the Notes attachment WebP animation.".to_string());
        }
        Ok(ContainerInspection {
            frame_count,
            animated: true,
        })
    } else if saw_animation_header || frame_count != 0 || !saw_static_image {
        Err("Could not decode the Notes attachment WebP container.".to_string())
    } else {
        Ok(ContainerInspection::STATIC)
    }
}

fn validate_image_file(
    source_path: &Path,
    file: &File,
    byte_size: u64,
    content_hash: String,
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
    let mut header_reader = source_reader(file)?;
    let mut header = [0_u8; 32];
    let header_length = header_reader
        .read(&mut header)
        .map_err(|error| format!("Could not read the Notes attachment format: {error}"))?;
    let format = image::guess_format(&header[..header_length])
        .map_err(|error| format!("Could not decode the Notes attachment image format: {error}"))?;
    let (mime_type, canonical_extension) = supported_format(format).ok_or_else(|| {
        "Only PNG, JPEG, WebP, and GIF Notes attachment images are supported.".to_string()
    })?;
    if !extension_matches(format, &extension) {
        return Err(format!(
            "The Notes attachment file extension .{extension} does not match its decoded image format."
        ));
    }
    let inspection = match format {
        ImageFormat::Gif => inspect_gif_reader(&mut source_reader(file)?, byte_size, limits)?,
        ImageFormat::Png => inspect_png_reader(&mut source_reader(file)?, byte_size, limits)?,
        ImageFormat::WebP => inspect_webp_reader(&mut source_reader(file)?, byte_size, limits)?,
        ImageFormat::Jpeg => ContainerInspection::STATIC,
        _ => return Err("The Notes attachment image format is unsupported.".to_string()),
    };
    let dimensions = ImageReader::with_format(source_reader(file)?, format)
        .into_dimensions()
        .map_err(|error| format!("Could not decode the Notes attachment dimensions: {error}"))?;
    validate_decoded_dimensions((u64::from(dimensions.0), u64::from(dimensions.1)), limits)?;
    let decode_animation = |frames: image::Frames<'_>| -> Result<(), String> {
        let mut decoded_frames = 0_u64;
        for frame in frames {
            frame.map_err(|error| {
                format!("Could not decode a Notes attachment animation frame: {error}")
            })?;
            decoded_frames += 1;
        }
        if decoded_frames != inspection.frame_count {
            return Err(
                "The Notes attachment decoded frame count does not match its container."
                    .to_string(),
            );
        }
        Ok(())
    };
    if format == ImageFormat::Gif {
        let mut decoder = GifDecoder::new(source_reader(file)?)
            .map_err(|error| format!("Could not decode the Notes attachment GIF: {error}"))?;
        decoder
            .set_limits(decoder_limits(dimensions, limits))
            .map_err(|error| format!("Could not limit the Notes attachment GIF: {error}"))?;
        decode_animation(decoder.into_frames())?;
    } else if format == ImageFormat::WebP && inspection.animated {
        let decoder = WebPDecoder::new(source_reader(file)?)
            .map_err(|error| format!("Could not decode the Notes attachment WebP: {error}"))?;
        decode_animation(decoder.into_frames())?;
    } else {
        let mut reader = ImageReader::with_format(source_reader(file)?, format);
        reader.limits(decoder_limits(dimensions, limits));
        reader
            .decode()
            .map_err(|error| format!("Could not decode the Notes attachment image: {error}"))?;
    }
    Ok(ValidatedImage {
        mime_type,
        extension: canonical_extension,
        width: dimensions.0,
        height: dimensions.1,
        byte_size,
        content_hash,
    })
}

fn validate_image_bytes_with_extension_policy(
    source_path: Option<&Path>,
    bytes: &[u8],
    limits: ValidationLimits,
) -> Result<ValidatedImage, String> {
    let extension = source_path
        .map(|source_path| {
            source_path
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
                .ok_or_else(|| {
                    "Notes attachment images must have a supported file extension.".to_string()
                })
        })
        .transpose()?;
    if extension.as_deref() == Some("svg") {
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
    if let Some(extension) = extension {
        if !extension_matches(format, &extension) {
            return Err(format!(
                "The Notes attachment file extension .{extension} does not match its decoded image format."
            ));
        }
    }

    let inspection = inspect_container(format, bytes, limits)?;

    let dimensions = ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|error| format!("Could not decode the Notes attachment dimensions: {error}"))?;
    validate_decoded_dimensions((u64::from(dimensions.0), u64::from(dimensions.1)), limits)?;

    fully_decode_image(format, bytes, dimensions, inspection, limits)?;

    Ok(ValidatedImage {
        mime_type,
        extension: canonical_extension,
        width: dimensions.0,
        height: dimensions.1,
        byte_size,
        content_hash: sha256_hex(bytes),
    })
}

#[cfg(test)]
pub(crate) fn validate_image_bytes(
    source_path: &Path,
    bytes: &[u8],
    limits: ValidationLimits,
) -> Result<ValidatedImage, String> {
    validate_image_bytes_with_extension_policy(Some(source_path), bytes, limits)
}

fn validate_import_image_bytes(
    bytes: &[u8],
    limits: ValidationLimits,
) -> Result<ValidatedImage, String> {
    validate_image_bytes_with_extension_policy(None, bytes, limits)
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

fn read_bounded(mut reader: impl Read, max_bytes: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    Read::by_ref(&mut reader)
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

#[cfg(test)]
pub(crate) fn acquire_attachment_import_permit() -> Result<AttachmentImportPermit, String> {
    let mut state = IMPORT_BUDGET_STATE
        .lock()
        .map_err(|_| "The Notes attachment import budget is unavailable.".to_string())?;
    while state.occupied {
        state = IMPORT_BUDGET_AVAILABLE
            .wait(state)
            .map_err(|_| "The Notes attachment import budget is unavailable.".to_string())?;
    }
    state.occupied = true;
    Ok(AttachmentImportPermit {
        _lease: Arc::new(AttachmentImportLease),
    })
}

pub(crate) async fn acquire_attachment_import_permit_async(
) -> Result<AttachmentImportPermit, String> {
    std::future::poll_fn(|context| {
        let mut state = match IMPORT_BUDGET_STATE.lock() {
            Ok(state) => state,
            Err(_) => {
                return std::task::Poll::Ready(Err(
                    "The Notes attachment import budget is unavailable.".to_string(),
                ));
            }
        };
        if !state.occupied {
            state.occupied = true;
            return std::task::Poll::Ready(Ok(AttachmentImportPermit {
                _lease: Arc::new(AttachmentImportLease),
            }));
        }
        if !state
            .async_waiters
            .iter()
            .any(|waiter| waiter.will_wake(context.waker()))
        {
            state.async_waiters.push(context.waker().clone());
        }
        std::task::Poll::Pending
    })
    .await
}

#[cfg(test)]
thread_local! {
    static INJECTED_SOURCE_GROWTH: std::cell::RefCell<Option<Vec<u8>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn inject_source_growth(bytes: Vec<u8>) {
    INJECTED_SOURCE_GROWTH.with(|growth| *growth.borrow_mut() = Some(bytes));
}

#[cfg(test)]
fn maybe_inject_source_growth(path: &Path) -> Result<(), String> {
    let growth = INJECTED_SOURCE_GROWTH.with(|growth| growth.borrow_mut().take());
    if let Some(growth) = growth {
        std::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .and_then(|mut file| file.write_all(&growth))
            .map_err(|error| format!("Could not grow the Notes attachment test source: {error}"))?;
    }
    Ok(())
}

#[cfg(not(test))]
fn maybe_inject_source_growth(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn prepare_source_attachment_streaming(
    source_path: &str,
    remaining_batch_bytes: u64,
    expected_byte_size: u64,
    hash_done: &mut u64,
    hash_total: u64,
    progress: Option<&dyn AttachmentIngestProgress>,
) -> Result<PreparedAttachment, String> {
    if source_path.trim().is_empty() {
        return Err("A Notes attachment source path is required.".to_string());
    }
    let path = Path::new(source_path);
    let original_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "A Notes attachment source must name a file.".to_string())?
        .to_string();
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let source_dir = Dir::open_ambient_dir(parent, ambient_authority()).map_err(|error| {
        format!("Could not open the Notes attachment source directory: {error}")
    })?;
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    let file = source_dir
        .open_with(&original_name, &options)
        .map_err(|error| format!("Could not open the Notes attachment image: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect the Notes attachment source: {error}"))?;
    if !metadata.is_file() {
        return Err("A Notes attachment source must be a regular file.".to_string());
    }
    if metadata.len() == 0 || metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "Notes attachment images must contain between 1 and {MAX_ATTACHMENT_BYTES} bytes."
        ));
    }
    if metadata.len() > remaining_batch_bytes {
        return Err(format!(
            "Notes attachment batches must contain at most {MAX_ATTACHMENT_BATCH_BYTES} image bytes."
        ));
    }
    if metadata.len() != expected_byte_size {
        return Err("The Notes attachment source changed before hashing.".to_string());
    }
    maybe_inject_source_growth(path)?;
    let identity = file_identity(&metadata)?;
    let mut hash_reader = file
        .try_clone()
        .map_err(|error| format!("Could not clone the Notes attachment source: {error}"))?;
    hash_reader
        .seek(SeekFrom::Start(0))
        .map_err(|error| format!("Could not seek the Notes attachment source: {error}"))?;
    let mut hasher = Sha256::new();
    let mut staged = tempfile::tempfile().map_err(|error| {
        format!("Could not create a private Notes attachment staging file: {error}")
    })?;
    let mut observed = 0_u64;
    let mut buffer = vec![0_u8; ATTACHMENT_STREAM_CHUNK_BYTES];
    loop {
        let read = hash_reader
            .read(&mut buffer)
            .map_err(|error| format!("Could not hash the Notes attachment source: {error}"))?;
        if read == 0 {
            break;
        }
        observed =
            observed
                .checked_add(u64::try_from(read).map_err(|_| {
                    "The Notes attachment source byte count is too large.".to_string()
                })?)
                .ok_or_else(|| "The Notes attachment source byte count overflowed.".to_string())?;
        if observed > remaining_batch_bytes {
            return Err(format!(
                "Notes attachment images must contain at most {remaining_batch_bytes} bytes."
            ));
        }
        if observed > expected_byte_size {
            return Err("The Notes attachment source changed while hashing.".to_string());
        }
        hasher.update(&buffer[..read]);
        staged
            .write_all(&buffer[..read])
            .map_err(|error| format!("Could not stage the Notes attachment source: {error}"))?;
        *hash_done = hash_done
            .checked_add(u64::try_from(read).unwrap_or(0))
            .ok_or_else(|| "The Notes attachment hash progress overflowed.".to_string())?;
        progress.map(|progress| progress.hashing(*hash_done, hash_total));
    }
    if observed != expected_byte_size {
        return Err("The Notes attachment source changed while hashing.".to_string());
    }
    let held_metadata = file
        .metadata()
        .map_err(|error| format!("Could not revalidate the Notes attachment source: {error}"))?;
    let path_metadata = source_dir
        .symlink_metadata(&original_name)
        .map_err(|error| {
            format!("Could not revalidate the Notes attachment source path: {error}")
        })?;
    if file_identity(&held_metadata)? != identity
        || file_identity(&path_metadata)? != identity
        || !path_metadata.is_file()
        || !has_single_link(&path_metadata)?
    {
        return Err("The Notes attachment source changed while hashing.".to_string());
    }
    staged
        .flush()
        .and_then(|_| staged.seek(SeekFrom::Start(0)).map(|_| ()))
        .map_err(|error| format!("Could not finish the Notes attachment staging file: {error}"))?;
    let content_hash = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let image = validate_image_file(
        path,
        &staged,
        expected_byte_size,
        content_hash.clone(),
        ValidationLimits::DEFAULT,
    )?;
    if sha256_reader(source_reader(&staged)?.into_inner(), expected_byte_size)? != content_hash {
        return Err("The Notes attachment staging file changed during validation.".to_string());
    }
    Ok(PreparedAttachment {
        source: PreparedAttachmentSource::StagedFile(staged),
        original_name,
        image,
    })
}

fn source_path_byte_length(source_path: &str) -> Result<u64, String> {
    let path = Path::new(source_path);
    let name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "A Notes attachment source must name a file.".to_string())?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let directory = Dir::open_ambient_dir(parent, ambient_authority()).map_err(|error| {
        format!("Could not open the Notes attachment source directory: {error}")
    })?;
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    let file = directory
        .open_with(name, &options)
        .map_err(|error| format!("Could not open the Notes attachment image: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect the Notes attachment source: {error}"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "Notes attachment images must contain between 1 and {MAX_ATTACHMENT_BYTES} bytes."
        ));
    }
    Ok(metadata.len())
}

#[cfg(test)]
fn prepare_source_attachment_without_budget(
    source_path: &str,
    remaining_batch_bytes: u64,
) -> Result<PreparedAttachment, String> {
    let expected = source_path_byte_length(source_path)?;
    let mut hash_done = 0;
    prepare_source_attachment_streaming(
        source_path,
        remaining_batch_bytes,
        expected,
        &mut hash_done,
        expected,
        None,
    )
}

impl PreparedAttachmentBatch {
    #[cfg(test)]
    pub(crate) fn from_bytes(sources: Vec<RawAttachmentSource<'_>>) -> Result<Self, String> {
        let budget = acquire_attachment_import_permit()?;
        Self::from_bytes_with_import_permit(sources, budget)
    }

    #[cfg(test)]
    pub(crate) fn from_bytes_with_import_permit(
        sources: Vec<RawAttachmentSource<'_>>,
        budget: AttachmentImportPermit,
    ) -> Result<Self, String> {
        Self::from_bytes_with_import_permit_and_progress(sources, budget, None)
    }

    pub(crate) fn from_bytes_with_import_permit_and_progress(
        sources: Vec<RawAttachmentSource<'_>>,
        budget: AttachmentImportPermit,
        progress: Option<&dyn AttachmentIngestProgress>,
    ) -> Result<Self, String> {
        validate_batch_item_count(sources.len())?;
        let mut aggregate_bytes = 0_u64;
        for source in &sources {
            let byte_length = u64::try_from(source.bytes.len())
                .map_err(|_| "A Notes attachment byte length is too large.".to_string())?;
            if byte_length == 0 || byte_length > MAX_ATTACHMENT_BYTES {
                return Err(format!(
                    "Notes attachment images must contain between 1 and {MAX_ATTACHMENT_BYTES} bytes."
                ));
            }
            aggregate_bytes = aggregate_bytes
                .checked_add(byte_length)
                .ok_or_else(|| "The Notes attachment batch byte length overflowed.".to_string())?;
            if aggregate_bytes > MAX_ATTACHMENT_BATCH_BYTES {
                return Err(format!(
                    "Notes attachment batches must contain at most {MAX_ATTACHMENT_BATCH_BYTES} image bytes."
                ));
            }
        }

        let hash_total = aggregate_bytes;
        let mut hash_done = 0_u64;
        let mut attachments = Vec::with_capacity(sources.len());
        for source in sources {
            let image = validate_import_image_bytes(source.bytes, ValidationLimits::DEFAULT)
                .map_err(|error| format!("{}: {error}", source.original_name))?;
            if source.declared_mime_type != image.mime_type {
                return Err(format!(
                    "The declared MIME type for {} does not match its decoded image format.",
                    source.original_name
                ));
            }
            attachments.push(PreparedAttachment {
                source: PreparedAttachmentSource::Bytes(source.bytes.to_vec()),
                original_name: source.original_name,
                image,
            });
            hash_done =
                hash_done
                    .checked_add(u64::try_from(source.bytes.len()).map_err(|_| {
                        "The Notes attachment byte length is too large.".to_string()
                    })?)
                    .ok_or_else(|| "The Notes attachment hash progress overflowed.".to_string())?;
            progress.map(|progress| progress.hashing(hash_done, hash_total));
        }
        Ok(Self {
            _budget: budget,
            attachments,
        })
    }

    /// Markdown imports may have one vault's worth of distinct assets without
    /// changing the intentionally smaller paste/image-node batch limit.
    pub(crate) fn from_markdown_import_bytes_with_import_permit(
        sources: Vec<RawAttachmentSource<'_>>,
        budget: AttachmentImportPermit,
    ) -> Result<Self, String> {
        let max_items = usize::try_from(crate::notes::types::MAX_NOTE_ATTACHMENTS_PER_VAULT)
            .map_err(|_| "The Notes Markdown attachment item cap is invalid.".to_string())?;
        if sources.is_empty() || sources.len() > max_items {
            return Err(format!(
                "A Notes Markdown attachment batch must contain between 1 and {max_items} images."
            ));
        }
        let mut aggregate_bytes = 0_u64;
        for source in &sources {
            let byte_length = u64::try_from(source.bytes.len())
                .map_err(|_| "A Notes attachment byte length is too large.".to_string())?;
            if byte_length == 0 || byte_length > MAX_ATTACHMENT_BYTES {
                return Err(format!(
                    "Notes attachment images must contain between 1 and {MAX_ATTACHMENT_BYTES} bytes."
                ));
            }
            aggregate_bytes = aggregate_bytes
                .checked_add(byte_length)
                .ok_or_else(|| "The Notes attachment batch byte length overflowed.".to_string())?;
            if aggregate_bytes > MAX_ATTACHMENT_BATCH_BYTES {
                return Err(format!(
                    "Notes attachment batches must contain at most {MAX_ATTACHMENT_BATCH_BYTES} image bytes."
                ));
            }
        }
        let mut attachments = Vec::with_capacity(sources.len());
        for source in sources {
            let image = validate_import_image_bytes(source.bytes, ValidationLimits::DEFAULT)
                .map_err(|error| format!("{}: {error}", source.original_name))?;
            if source.declared_mime_type != image.mime_type {
                return Err(format!(
                    "The declared MIME type for {} does not match its decoded image format.",
                    source.original_name
                ));
            }
            attachments.push(PreparedAttachment {
                source: PreparedAttachmentSource::Bytes(source.bytes.to_vec()),
                original_name: source.original_name,
                image,
            });
        }
        Ok(Self {
            _budget: budget,
            attachments,
        })
    }

    #[cfg(test)]
    pub(crate) fn from_source_paths(source_paths: &[&str]) -> Result<Self, String> {
        validate_batch_item_count(source_paths.len())?;
        let budget = acquire_attachment_import_permit()?;
        Self::from_source_paths_with_import_permit(source_paths, budget)
    }

    #[cfg(test)]
    pub(crate) fn from_source_paths_with_import_permit(
        source_paths: &[&str],
        budget: AttachmentImportPermit,
    ) -> Result<Self, String> {
        Self::from_source_paths_with_import_permit_and_progress(source_paths, budget, None)
    }

    pub(crate) fn from_source_paths_with_import_permit_and_progress(
        source_paths: &[&str],
        budget: AttachmentImportPermit,
        progress: Option<&dyn AttachmentIngestProgress>,
    ) -> Result<Self, String> {
        validate_batch_item_count(source_paths.len())?;
        let mut expected_sizes = Vec::with_capacity(source_paths.len());
        let mut hash_total = 0_u64;
        for source_path in source_paths {
            let byte_size = source_path_byte_length(source_path).map_err(|error| {
                let file_name = Path::new(source_path)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("unknown image");
                format!("{file_name}: {error}")
            })?;
            hash_total = hash_total
                .checked_add(byte_size)
                .ok_or_else(|| "The Notes attachment batch byte length overflowed.".to_string())?;
            if hash_total > MAX_ATTACHMENT_BATCH_BYTES {
                return Err(format!(
                    "Notes attachment batches must contain at most {MAX_ATTACHMENT_BATCH_BYTES} image bytes."
                ));
            }
            expected_sizes.push(byte_size);
        }
        let mut aggregate_bytes = 0_u64;
        let mut hash_done = 0_u64;
        let mut attachments = Vec::with_capacity(source_paths.len());
        for (source_path, expected_size) in source_paths.iter().zip(expected_sizes) {
            let remaining = MAX_ATTACHMENT_BATCH_BYTES
                .checked_sub(aggregate_bytes)
                .ok_or_else(|| "The Notes attachment batch byte length overflowed.".to_string())?;
            match prepare_source_attachment_streaming(
                source_path,
                remaining,
                expected_size,
                &mut hash_done,
                hash_total,
                progress,
            ) {
                Ok(prepared) => {
                    aggregate_bytes = aggregate_bytes
                        .checked_add(prepared.image.byte_size)
                        .ok_or_else(|| {
                            "The Notes attachment batch byte length overflowed.".to_string()
                        })?;
                    if aggregate_bytes > MAX_ATTACHMENT_BATCH_BYTES {
                        return Err(format!(
                            "Notes attachment batches must contain at most {MAX_ATTACHMENT_BATCH_BYTES} image bytes."
                        ));
                    }
                    attachments.push(prepared);
                }
                Err(error) => {
                    let file_name = Path::new(source_path)
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("unknown image");
                    return Err(format!("{file_name}: {error}"));
                }
            }
        }
        Ok(Self {
            _budget: budget,
            attachments,
        })
    }

    pub(crate) fn attachments(&self) -> &[PreparedAttachment] {
        &self.attachments
    }
}

impl PreparedAttachment {
    #[cfg(test)]
    pub(crate) fn bytes(&self) -> &[u8] {
        match &self.source {
            PreparedAttachmentSource::Bytes(bytes) => bytes,
            PreparedAttachmentSource::StagedFile(_) => &[],
        }
    }
}

impl Drop for PreparedAttachmentBatch {
    fn drop(&mut self) {
        // Release prepared byte buffers before the permit's final release.
        self.attachments.clear();
    }
}

fn validate_batch_item_count(item_count: usize) -> Result<(), String> {
    let max_items = usize::try_from(crate::notes::types::MAX_NOTE_ATTACHMENTS_PER_NODE)
        .map_err(|_| "The Notes attachment item cap is invalid.".to_string())?;
    if item_count == 0 || item_count > max_items {
        return Err(format!(
            "A Notes attachment batch must contain between 1 and {max_items} images."
        ));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn prepare_source_attachment(
    source_path: &str,
) -> Result<PreparedAttachmentBatch, String> {
    PreparedAttachmentBatch::from_source_paths(&[source_path])
}

fn safe_owned_file_name(relative_path: &str) -> Result<&str, String> {
    let relative = Path::new(relative_path);
    let components = relative.components().collect::<Vec<_>>();
    if components.len() != 2
        || components[0] != Component::Normal("notes-assets".as_ref())
        || !matches!(components[1], Component::Normal(_))
    {
        return Err("A Notes attachment path must be a safe owned relative path.".to_string());
    }
    let file_name = relative
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "A Notes attachment owned file name must be UTF-8.".to_string())?;
    let (hash, extension) = file_name
        .split_once('.')
        .ok_or_else(|| "A Notes attachment owned file name is invalid.".to_string())?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|value| value.is_ascii_digit() || matches!(value, b'a'..=b'f'))
        || !matches!(extension, "png" | "jpg" | "webp" | "gif")
    {
        return Err("A Notes attachment owned file name is invalid.".to_string());
    }
    Ok(file_name)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

struct HeldFile {
    held: HeldBoundedCapabilityFile,
    identity: FileIdentity,
}

struct QuarantinedFile {
    name: PathBuf,
    held: HeldFile,
    snapshot_hash: String,
}

pub(crate) struct AttachmentCanonicalEvidence {
    file_name: PathBuf,
    content_hash: String,
    held: HeldBoundedCapabilityFile,
}

fn file_identity(metadata: &impl TryCapabilityFileIdentity) -> Result<FileIdentity, String> {
    let (device, inode) = capability_file_identity(metadata)
        .map_err(|error| format!("Could not determine a Notes attachment identity: {error}"))?;
    Ok(FileIdentity { device, inode })
}

fn has_single_link(metadata: &impl TryCapabilityFileLinkCount) -> Result<bool, String> {
    capability_file_link_count(metadata)
        .map(|count| count == 1)
        .map_err(|error| format!("Could not determine a Notes attachment link count: {error}"))
}

fn owned_file_name_content_hash(file_name: &Path) -> Option<&str> {
    let (hash, extension) = file_name.to_str()?.split_once('.')?;
    (hash.len() == 64
        && hash
            .bytes()
            .all(|value| value.is_ascii_digit() || matches!(value, b'a'..=b'f'))
        && matches!(extension, "png" | "jpg" | "webp" | "gif"))
    .then_some(hash)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VaultStorageIdentity {
    database: FileIdentity,
    generation: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CleanupFailurePoint {
    Reconcile,
    Remove,
    Sync,
}

#[cfg(test)]
thread_local! {
    static INJECTED_CLEANUP_FAILURE: std::cell::Cell<Option<CleanupFailurePoint>> =
        const { std::cell::Cell::new(None) };
    static FULL_RECONCILIATION_AFTER_SNAPSHOT_HOOK:
        std::cell::RefCell<Option<Box<dyn FnOnce(&Connection)>>> =
        const { std::cell::RefCell::new(None) };
    static FULL_RECONCILIATION_AFTER_QUARANTINE_HOOK:
        std::cell::RefCell<Option<Box<dyn FnOnce(&Connection)>>> =
        const { std::cell::RefCell::new(None) };
    static FULL_RECONCILIATION_BEFORE_REMOVE_HOOK:
        std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static FULL_RECONCILIATION_AFTER_REMOVE_HOOK:
        std::cell::RefCell<Option<Box<dyn FnOnce(&Connection)>>> =
        const { std::cell::RefCell::new(None) };
    static QUARANTINED_FILE_BEFORE_ACTION_HOOK:
        std::cell::RefCell<Option<Box<dyn FnOnce(&Path)>>> =
        const { std::cell::RefCell::new(None) };
    static QUARANTINED_FILE_AFTER_VALIDATION_HOOK:
        std::cell::RefCell<Option<Box<dyn FnOnce(&Path)>>> =
        const { std::cell::RefCell::new(None) };
    static QUARANTINE_AFTER_MOVE_HOOK:
        std::cell::RefCell<Option<Box<dyn FnOnce(&Path)>>> =
        const { std::cell::RefCell::new(None) };
    static RESTORE_AFTER_CONFLICT_QUARANTINE_HOOK:
        std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static HELD_FILE_AFTER_OPEN_HOOK:
        std::cell::RefCell<Option<Box<dyn FnOnce(&cap_std::fs::File)>>> =
        const { std::cell::RefCell::new(None) };
    static RESTORE_BEFORE_DUPLICATE_RETIREMENT_HOOK:
        std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static RESTORE_AFTER_DUPLICATE_HASH_HOOK:
        std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static RECOVERY_FILE_AFTER_COPY_HOOK:
        std::cell::RefCell<Option<Box<dyn FnOnce(&Path)>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn inject_cleanup_failure(point: CleanupFailurePoint) {
    INJECTED_CLEANUP_FAILURE.with(|failure| failure.set(Some(point)));
}

#[cfg(test)]
pub(crate) fn clear_injected_cleanup_failure() {
    INJECTED_CLEANUP_FAILURE.with(|failure| failure.set(None));
}

#[cfg(test)]
fn inject_full_reconciliation_after_snapshot_once(action: impl FnOnce(&Connection) + 'static) {
    FULL_RECONCILIATION_AFTER_SNAPSHOT_HOOK
        .with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn maybe_inject_full_reconciliation_after_snapshot(connection: &Connection) {
    if let Some(action) =
        FULL_RECONCILIATION_AFTER_SNAPSHOT_HOOK.with(|slot| slot.borrow_mut().take())
    {
        action(connection);
    }
}

#[cfg(not(test))]
fn maybe_inject_full_reconciliation_after_snapshot(_connection: &Connection) {}

#[cfg(test)]
pub(crate) fn inject_full_reconciliation_after_quarantine_once(
    action: impl FnOnce(&Connection) + 'static,
) {
    FULL_RECONCILIATION_AFTER_QUARANTINE_HOOK
        .with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn maybe_inject_full_reconciliation_after_quarantine(connection: &Connection) {
    if let Some(action) =
        FULL_RECONCILIATION_AFTER_QUARANTINE_HOOK.with(|slot| slot.borrow_mut().take())
    {
        action(connection);
    }
}

#[cfg(not(test))]
fn maybe_inject_full_reconciliation_after_quarantine(_connection: &Connection) {}

#[cfg(test)]
fn inject_full_reconciliation_before_remove_once(action: impl FnOnce() + 'static) {
    FULL_RECONCILIATION_BEFORE_REMOVE_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn maybe_inject_full_reconciliation_before_remove() {
    if let Some(action) =
        FULL_RECONCILIATION_BEFORE_REMOVE_HOOK.with(|slot| slot.borrow_mut().take())
    {
        action();
    }
}

#[cfg(not(test))]
fn maybe_inject_full_reconciliation_before_remove() {}

#[cfg(test)]
pub(crate) fn inject_full_reconciliation_after_remove_once(
    action: impl FnOnce(&Connection) + 'static,
) {
    FULL_RECONCILIATION_AFTER_REMOVE_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn maybe_inject_full_reconciliation_after_remove(connection: &Connection) {
    if let Some(action) =
        FULL_RECONCILIATION_AFTER_REMOVE_HOOK.with(|slot| slot.borrow_mut().take())
    {
        action(connection);
    }
}

#[cfg(not(test))]
fn maybe_inject_full_reconciliation_after_remove(_connection: &Connection) {}

#[cfg(test)]
fn inject_quarantined_file_before_action_once(action: impl FnOnce(&Path) + 'static) {
    QUARANTINED_FILE_BEFORE_ACTION_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn maybe_inject_quarantined_file_before_action(path: &Path) {
    if let Some(action) = QUARANTINED_FILE_BEFORE_ACTION_HOOK.with(|slot| slot.borrow_mut().take())
    {
        action(path);
    }
}

#[cfg(test)]
fn inject_quarantined_file_after_validation_once(action: impl FnOnce(&Path) + 'static) {
    QUARANTINED_FILE_AFTER_VALIDATION_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn maybe_inject_quarantined_file_after_validation(path: &Path) {
    if let Some(action) =
        QUARANTINED_FILE_AFTER_VALIDATION_HOOK.with(|slot| slot.borrow_mut().take())
    {
        action(path);
    }
}

#[cfg(test)]
fn inject_quarantine_after_move_once(action: impl FnOnce(&Path) + 'static) {
    QUARANTINE_AFTER_MOVE_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn maybe_inject_quarantine_after_move(path: &Path) {
    if let Some(action) = QUARANTINE_AFTER_MOVE_HOOK.with(|slot| slot.borrow_mut().take()) {
        action(path);
    }
}

#[cfg(not(test))]
fn maybe_inject_quarantine_after_move(_path: &Path) {}

#[cfg(not(test))]
fn maybe_inject_quarantined_file_after_validation(_path: &Path) {}

#[cfg(not(test))]
fn maybe_inject_quarantined_file_before_action(_path: &Path) {}

#[cfg(test)]
fn inject_restore_after_conflict_quarantine_once(action: impl FnOnce() + 'static) {
    RESTORE_AFTER_CONFLICT_QUARANTINE_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn maybe_inject_restore_after_conflict_quarantine() {
    if let Some(action) =
        RESTORE_AFTER_CONFLICT_QUARANTINE_HOOK.with(|slot| slot.borrow_mut().take())
    {
        action();
    }
}

#[cfg(not(test))]
fn maybe_inject_restore_after_conflict_quarantine() {}

#[cfg(test)]
fn inject_held_file_after_open_once(action: impl FnOnce(&cap_std::fs::File) + 'static) {
    HELD_FILE_AFTER_OPEN_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn maybe_inject_held_file_after_open(file: &cap_std::fs::File) {
    if let Some(action) = HELD_FILE_AFTER_OPEN_HOOK.with(|slot| slot.borrow_mut().take()) {
        action(file);
    }
}

#[cfg(test)]
fn inject_restore_before_duplicate_retirement_once(action: impl FnOnce() + 'static) {
    RESTORE_BEFORE_DUPLICATE_RETIREMENT_HOOK
        .with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn maybe_inject_restore_before_duplicate_retirement() {
    if let Some(action) =
        RESTORE_BEFORE_DUPLICATE_RETIREMENT_HOOK.with(|slot| slot.borrow_mut().take())
    {
        action();
    }
}

#[cfg(test)]
fn inject_recovery_file_after_copy_once(action: impl FnOnce(&Path) + 'static) {
    RECOVERY_FILE_AFTER_COPY_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn maybe_inject_recovery_file_after_copy(name: &Path) {
    if let Some(action) = RECOVERY_FILE_AFTER_COPY_HOOK.with(|slot| slot.borrow_mut().take()) {
        action(name);
    }
}

#[cfg(not(test))]
fn maybe_inject_recovery_file_after_copy(_name: &Path) {}

#[cfg(not(test))]
fn maybe_inject_restore_before_duplicate_retirement() {}

#[cfg(test)]
fn inject_restore_after_duplicate_hash_once(action: impl FnOnce() + 'static) {
    RESTORE_AFTER_DUPLICATE_HASH_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn maybe_inject_restore_after_duplicate_hash() {
    if let Some(action) = RESTORE_AFTER_DUPLICATE_HASH_HOOK.with(|slot| slot.borrow_mut().take()) {
        action();
    }
}

#[cfg(not(test))]
fn maybe_inject_restore_after_duplicate_hash() {}

#[cfg(test)]
fn maybe_inject_cleanup_failure(point: CleanupFailurePoint) -> Result<(), String> {
    let injected = INJECTED_CLEANUP_FAILURE.with(|failure| {
        if failure.get() == Some(point) {
            failure.set(None);
            true
        } else {
            false
        }
    });
    if injected {
        Err(format!(
            "Injected Notes attachment {point:?} cleanup failure."
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(test))]
fn maybe_inject_cleanup_failure(_point: CleanupFailurePoint) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn sync_capability_directory(directory: &Dir) -> Result<(), String> {
    directory
        .try_clone()
        .and_then(|directory| directory.into_std_file().sync_all())
        .map_err(|error| format!("Could not sync the Notes metadata directory: {error}"))
}

#[cfg(not(unix))]
fn sync_capability_directory(_directory: &Dir) -> Result<(), String> {
    Ok(())
}

fn mark_reconciliation_needed_in(metadata: &Dir) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create(true)
        .truncate(true)
        .follow(FollowSymlinks::No);
    let mut marker = metadata
        .open_with(RECONCILIATION_MARKER, &options)
        .map_err(|error| {
            format!("Could not create the Notes attachment reconciliation marker: {error}")
        })?;
    marker
        .write_all(b"reconcile\n")
        .and_then(|_| marker.sync_all())
        .map_err(|error| {
            format!("Could not sync the Notes attachment reconciliation marker: {error}")
        })?;
    sync_capability_directory(metadata)
}

/// Opens `.yonalist/notes.app.lock` symlink-safely (the same directory
/// discipline the attachment lease uses) and takes the exclusive `flock` for
/// this process without blocking. On success the returned `File` owns the lock
/// for as long as it lives; callers keep it alive for the connection manager's
/// lifetime. A second OS-level process that already holds the lock yields
/// [`VAULT_APP_LOCK_BUSY_MESSAGE`]. Reentrancy within one process is the
/// caller's responsibility — a same-process second `flock` on a fresh descriptor
/// would contend with our own held lock, so the manager caches one handle per
/// vault instead of re-opening here.
pub(crate) struct AcquiredVaultAppLockFile {
    pub(crate) file: File,
    pub(crate) vault: Dir,
    pub(crate) metadata: Dir,
}

pub(crate) fn acquire_vault_app_lock_file(
    vault_path: &str,
) -> Result<AcquiredVaultAppLockFile, String> {
    validate_vault_path(vault_path)?;
    let metadata_path = crate::metadata_dir(vault_path);
    fs::create_dir_all(&metadata_path)
        .map_err(|error| format!("Could not create the Notes metadata directory: {error}"))?;
    let vault_dir = metadata_path
        .parent()
        .ok_or_else(|| "Could not resolve the Notes vault directory.".to_string())?;
    let vault = Dir::open_ambient_dir(vault_dir, ambient_authority())
        .map_err(|error| format!("Could not open the Notes vault directory: {error}"))?;
    let metadata = vault.open_dir_nofollow(".yonalist").map_err(|error| {
        format!("The Notes metadata directory must be an owned directory, not a symlink: {error}")
    })?;

    acquire_vault_app_lock_file_in_metadata(vault, metadata)
}

pub(crate) fn acquire_existing_vault_app_lock_file(
    vault_path: &str,
) -> Result<Option<AcquiredVaultAppLockFile>, String> {
    validate_vault_path(vault_path)?;
    let metadata_path = crate::metadata_dir(vault_path);
    let vault_dir = metadata_path
        .parent()
        .ok_or_else(|| "Could not resolve the Notes vault directory.".to_string())?;
    let vault = match Dir::open_ambient_dir(vault_dir, ambient_authority()) {
        Ok(vault) => vault,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not open the Notes vault directory: {error}")),
    };
    let metadata = match vault.open_dir_nofollow(".yonalist") {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "The Notes metadata directory must be an owned directory, not a symlink: {error}"
            ))
        }
    };

    acquire_vault_app_lock_file_in_metadata(vault, metadata).map(Some)
}

fn acquire_vault_app_lock_file_in_metadata(
    vault: Dir,
    metadata: Dir,
) -> Result<AcquiredVaultAppLockFile, String> {
    let mut lock_options = OpenOptions::new();
    lock_options
        .read(true)
        .write(true)
        .create(true)
        .follow(FollowSymlinks::No);
    let lock_file = metadata
        .open_with(VAULT_APP_LOCK_NAME, &lock_options)
        .map_err(|error| format!("Could not open the Notes vault application lock: {error}"))?
        .into_std();
    if !lock_file
        .metadata()
        .map_err(|error| format!("Could not inspect the Notes vault application lock: {error}"))?
        .is_file()
    {
        return Err("The Notes vault application lock must be a regular file.".to_string());
    }
    match FileExt::try_lock(&lock_file) {
        Ok(()) => Ok(AcquiredVaultAppLockFile {
            file: lock_file,
            vault,
            metadata,
        }),
        Err(fs4::TryLockError::WouldBlock) => Err(VAULT_APP_LOCK_BUSY_MESSAGE.to_string()),
        Err(fs4::TryLockError::Error(error)) => {
            Err(format!("Could not lock the Notes vault: {error}"))
        }
    }
}

pub(crate) struct AttachmentStorageLease {
    _lock_file: File,
    metadata: Dir,
    assets: Dir,
    database_storage: crate::notes::repository::NotesStorageDirectory,
    database_path: PathBuf,
    metadata_identity: FileIdentity,
    lock_identity: FileIdentity,
    assets_identity: FileIdentity,
}

impl AttachmentStorageLease {
    pub(crate) fn asset_gc_directories(&self) -> Result<(Dir, Dir), String> {
        self.validate_core_identity()?;
        self.database_storage.revalidate_path()?;
        let assets = self
            .assets
            .try_clone()
            .map_err(|error| format!("Could not clone the Notes asset directory: {error}"))?;
        match self.database_storage.directory().create_dir("asset-trash") {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(format!(
                    "Could not create the app-local Notes asset trash: {error}"
                ))
            }
        }
        let trash = self
            .database_storage
            .directory()
            .open_dir_nofollow("asset-trash")
            .map_err(|error| {
                format!("Could not open the app-local Notes asset trash safely: {error}")
            })?;
        Ok((assets, trash))
    }

    pub(crate) fn validate_asset_gc_directories(
        &self,
        assets: &Dir,
        trash: &Dir,
    ) -> Result<(), String> {
        self.validate_core_identity()?;
        self.database_storage.revalidate_path()?;
        let held_assets = assets.dir_metadata().map_err(|error| {
            format!("Could not inspect the held Notes asset directory: {error}")
        })?;
        let held_trash = trash
            .dir_metadata()
            .map_err(|error| format!("Could not inspect the held Notes asset trash: {error}"))?;
        let current_assets = self
            .metadata
            .open_dir_nofollow("notes-assets")
            .and_then(|directory| directory.dir_metadata())
            .map_err(|error| {
                format!("Could not revalidate the Notes asset directory path: {error}")
            })?;
        let current_trash = self
            .database_storage
            .directory()
            .open_dir_nofollow("asset-trash")
            .and_then(|directory| directory.dir_metadata())
            .map_err(|error| format!("Could not revalidate the Notes asset trash path: {error}"))?;
        if capability_metadata_is_reparse_point(&held_assets)
            || capability_metadata_is_reparse_point(&held_trash)
            || capability_metadata_is_reparse_point(&current_assets)
            || capability_metadata_is_reparse_point(&current_trash)
            || !held_assets.is_dir()
            || !held_trash.is_dir()
            || !current_assets.is_dir()
            || !current_trash.is_dir()
            || capability_file_identity(&held_assets)
                .map_err(|error| format!("Could not identify the held Notes assets: {error}"))?
                != capability_file_identity(&current_assets).map_err(|error| {
                    format!("Could not identify the current Notes asset path: {error}")
                })?
            || capability_file_identity(&held_trash).map_err(|error| {
                format!("Could not identify the held Notes asset trash: {error}")
            })? != capability_file_identity(&current_trash).map_err(|error| {
                format!("Could not identify the current Notes asset trash path: {error}")
            })?
        {
            return Err(
                "The Notes asset or trash directory identity changed during the operation."
                    .to_string(),
            );
        }
        self.database_storage.revalidate_path()?;
        self.validate_core_identity()
    }

    pub(crate) fn acquire(vault_path: &str) -> Result<Self, String> {
        Self::acquire_with_deadline(vault_path, ATTACHMENT_LEASE_ACQUIRE_TIMEOUT)
    }

    pub(crate) fn acquire_with_app_lock(
        vault_path: &str,
        app_lock: &crate::notes::connection::VaultAppLockGuard,
    ) -> Result<Self, String> {
        crate::notes::repository::preflight_notes_schema_before_attachment_storage(vault_path)?;
        Self::acquire_with_app_lock_and_deadline(
            vault_path,
            app_lock,
            ATTACHMENT_LEASE_ACQUIRE_TIMEOUT,
        )
    }

    fn acquire_with_deadline(
        vault_path: &str,
        deadline: std::time::Duration,
    ) -> Result<Self, String> {
        validate_vault_path(vault_path)?;
        crate::notes::repository::preflight_notes_schema_before_attachment_storage(vault_path)?;
        let app_lock = crate::notes::connection::acquire_vault_app_lock(vault_path)?;
        Self::acquire_with_app_lock_and_deadline(vault_path, &app_lock, deadline)
    }

    fn acquire_with_app_lock_and_deadline(
        vault_path: &str,
        app_lock: &crate::notes::connection::VaultAppLockGuard,
        deadline: std::time::Duration,
    ) -> Result<Self, String> {
        validate_vault_path(vault_path)?;
        app_lock.revalidate_vault_path()?;
        let database_path = crate::notes::repository::notes_db_path(vault_path);
        crate::notes::repository::preflight_app_local_notes_storage_before_creation(
            vault_path,
            app_lock,
            &database_path,
        )?;
        maybe_inject_attachment_storage_after_app_lock();
        let database_storage =
            crate::notes::repository::NotesStorageDirectory::open(app_lock, &database_path, true)?;
        app_lock.revalidate_vault_path()?;
        database_storage.revalidate_path()?;
        let metadata = app_lock.try_clone_metadata()?;
        let metadata_identity =
            file_identity(&metadata.dir_metadata().map_err(|error| {
                format!("Could not inspect the Notes metadata identity: {error}")
            })?)?;

        let mut lock_options = OpenOptions::new();
        lock_options
            .read(true)
            .write(true)
            .create(true)
            .follow(FollowSymlinks::No);
        let lock_file = metadata
            .open_with(".notes-assets.lock", &lock_options)
            .map_err(|error| format!("Could not open the Notes attachment storage lock: {error}"))?
            .into_std();
        if !lock_file
            .metadata()
            .map_err(|error| {
                format!("Could not inspect the Notes attachment storage lock: {error}")
            })?
            .is_file()
        {
            return Err("The Notes attachment storage lock must be a regular file.".to_string());
        }
        Self::lock_with_deadline(&lock_file, deadline)?;
        let lock_identity = file_identity(&lock_file.metadata().map_err(|error| {
            format!("Could not inspect the Notes attachment lock identity: {error}")
        })?)?;

        let assets = match metadata.open_dir_nofollow("notes-assets") {
            Ok(assets) => assets,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match metadata.create_dir("notes-assets") {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => {
                        return Err(format!(
                            "Could not create the Notes attachment directory: {error}"
                        ))
                    }
                }
                metadata.open_dir_nofollow("notes-assets").map_err(|error| {
                    format!(
                        "The Notes attachment directory must be an owned directory, not a file or symlink: {error}"
                    )
                })?
            }
            Err(error) => {
                return Err(format!(
                    "The Notes attachment directory must be an owned directory, not a file or symlink: {error}"
                ))
            }
        };
        let assets_identity =
            file_identity(&assets.dir_metadata().map_err(|error| {
                format!("Could not inspect the Notes asset identity: {error}")
            })?)?;

        Ok(Self {
            _lock_file: lock_file,
            metadata,
            assets,
            database_storage,
            database_path,
            metadata_identity,
            lock_identity,
            assets_identity,
        })
    }

    /// Poll for the exclusive vault lock, sleeping between attempts, and give up
    /// once `deadline` elapses. `fs4` names the non-blocking exclusive lock
    /// `try_lock` (its shared counterpart is `try_lock_shared`) and reports
    /// contention as `TryLockError::WouldBlock`; any other error is a real I/O
    /// failure and is surfaced immediately.
    fn lock_with_deadline(lock_file: &File, deadline: std::time::Duration) -> Result<(), String> {
        let started = std::time::Instant::now();
        loop {
            match FileExt::try_lock(lock_file) {
                Ok(()) => return Ok(()),
                Err(fs4::TryLockError::WouldBlock) => {
                    let elapsed = started.elapsed();
                    if elapsed >= deadline {
                        return Err(ATTACHMENT_LEASE_BUSY_MESSAGE.to_string());
                    }
                    let remaining = deadline - elapsed;
                    std::thread::sleep(ATTACHMENT_LEASE_POLL_INTERVAL.min(remaining));
                }
                Err(fs4::TryLockError::Error(error)) => {
                    return Err(format!(
                        "Could not lock the Notes attachment storage: {error}"
                    ));
                }
            }
        }
    }

    fn validate_core_identity(&self) -> Result<(), String> {
        self.database_storage.revalidate_path()?;
        let metadata_identity =
            file_identity(&self.metadata.dir_metadata().map_err(|error| {
                format!("Could not inspect the Notes metadata identity: {error}")
            })?)?;
        let mut lock_options = OpenOptions::new();
        lock_options
            .read(true)
            .write(true)
            .follow(FollowSymlinks::No);
        let lock = self
            .metadata
            .open_with(".notes-assets.lock", &lock_options)
            .map_err(|error| format!("Could not revalidate the Notes lock identity: {error}"))?;
        let lock_identity = file_identity(
            &lock
                .metadata()
                .map_err(|error| format!("Could not inspect the Notes lock identity: {error}"))?,
        )?;
        let assets = self
            .metadata
            .open_dir_nofollow("notes-assets")
            .map_err(|error| format!("Could not revalidate the Notes asset identity: {error}"))?;
        let assets_identity =
            file_identity(&assets.dir_metadata().map_err(|error| {
                format!("Could not inspect the Notes asset identity: {error}")
            })?)?;
        if metadata_identity != self.metadata_identity
            || lock_identity != self.lock_identity
            || assets_identity != self.assets_identity
        {
            return Err(
                "The Notes vault storage identity changed during the attachment operation."
                    .to_string(),
            );
        }
        Ok(())
    }

    pub(crate) fn capture_database_identity(
        &self,
        connection: &Connection,
    ) -> Result<VaultStorageIdentity, String> {
        self.validate_core_identity()?;
        let connection_path = connection.path().ok_or_else(|| {
            "The Notes database connection does not identify a persistent database.".to_string()
        })?;
        let expected_path = fs::canonicalize(&self.database_path).map_err(|error| {
            format!("Could not resolve the leased Notes database connection: {error}")
        })?;
        let connection_path = fs::canonicalize(connection_path).map_err(|error| {
            format!("Could not resolve the active Notes database connection: {error}")
        })?;
        if connection_path != expected_path {
            return Err(
                "The Notes database connection does not belong to the leased vault.".to_string(),
            );
        }
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let database = self
            .database_storage
            .directory()
            .open_with("notes.sqlite", &options)
            .map_err(|error| format!("Could not open the Notes database identity: {error}"))?;
        let database_metadata = database
            .metadata()
            .map_err(|error| format!("Could not inspect the Notes database identity: {error}"))?;
        if !database_metadata.is_file() {
            return Err("The Notes database identity must be a regular file.".to_string());
        }
        Ok(VaultStorageIdentity {
            database: file_identity(&database_metadata)?,
            generation: notes_vault_generation(connection)?,
        })
    }

    pub(crate) fn validate_identity(&self, identity: &VaultStorageIdentity) -> Result<(), String> {
        self.validate_core_identity()?;
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let database = self
            .database_storage
            .directory()
            .open_with("notes.sqlite", &options)
            .map_err(|error| {
                format!("Could not revalidate the Notes database identity: {error}")
            })?;
        let current =
            file_identity(&database.metadata().map_err(|error| {
                format!("Could not inspect the Notes database identity: {error}")
            })?)?;
        if current != identity.database {
            return Err(
                "The Notes database identity changed during the attachment operation.".to_string(),
            );
        }
        let connection =
            Connection::open_with_flags(&self.database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|error| {
                    format!("Could not reopen the Notes database identity: {error}")
                })?;
        let generation = notes_vault_generation(&connection)?;
        let current = self
            .database_storage
            .directory()
            .open_with("notes.sqlite", &options)
            .and_then(|database| database.metadata())
            .map_err(|error| {
                format!("Could not revalidate the Notes database identity: {error}")
            })?;
        if file_identity(&current)? != identity.database || generation != identity.generation {
            return Err(
                "The Notes database identity changed during the attachment operation.".to_string(),
            );
        }
        Ok(())
    }

    pub(crate) fn reconciliation_needed(&self) -> Result<bool, String> {
        match self.metadata.symlink_metadata(RECONCILIATION_MARKER) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!(
                "Could not inspect the Notes attachment reconciliation marker: {error}"
            )),
        }
    }

    pub(crate) fn mark_reconciliation_needed(&self) -> Result<(), String> {
        mark_reconciliation_needed_in(&self.metadata)
    }

    pub(crate) fn clear_reconciliation_marker(&self) -> Result<(), String> {
        let removed = match self.metadata.remove_file_or_symlink(RECONCILIATION_MARKER) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => {
                return Err(format!(
                    "Could not clear the Notes attachment reconciliation marker: {error}"
                ))
            }
        };
        if removed {
            sync_capability_directory(&self.metadata)?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn prepare_source_attachment(
        &self,
        source_path: &str,
    ) -> Result<PreparedAttachmentBatch, String> {
        PreparedAttachmentBatch::from_source_paths(&[source_path])
    }

    fn open_owned_file(&self, file_name: &str) -> Result<HeldBoundedCapabilityFile, String> {
        let held = hold_capability_regular_file_bounded_nofollow(
            &self.assets,
            Path::new(file_name),
            MAX_ATTACHMENT_BYTES,
        )
        .map_err(|error| format!("Could not open the Notes attachment image: {error}"))?;
        let metadata = held
            .metadata()
            .map_err(|error| format!("Could not inspect the Notes attachment image: {error}"))?;
        if !has_single_link(&metadata)? {
            return Err("A Notes attachment image must be an owned file.".to_string());
        }
        Ok(held)
    }

    pub(crate) fn retain_attachment_canonical_evidence(
        &self,
        relative_path: &str,
        content_hash: &str,
    ) -> Result<AttachmentCanonicalEvidence, String> {
        let file_name = PathBuf::from(safe_owned_file_name(relative_path)?);
        let held = self.open_owned_file(
            file_name
                .to_str()
                .ok_or_else(|| "A Notes attachment asset name must be UTF-8.".to_string())?,
        )?;
        crate::notes::sync::asset_gc::verify_owned_asset_evidence(
            &self.assets,
            &file_name,
            &held,
            content_hash,
        )?;
        Ok(AttachmentCanonicalEvidence {
            file_name,
            content_hash: content_hash.to_string(),
            held,
        })
    }

    pub(crate) fn validate_attachment_canonical_evidence(
        &self,
        identity: &VaultStorageIdentity,
        evidence: &[AttachmentCanonicalEvidence],
    ) -> Result<(), String> {
        self.validate_identity(identity)?;
        for evidence in evidence {
            crate::notes::sync::asset_gc::verify_owned_asset_evidence(
                &self.assets,
                &evidence.file_name,
                &evidence.held,
                &evidence.content_hash,
            )?;
        }
        self.validate_identity(identity)
    }

    #[cfg(unix)]
    fn sync_directory(&self) -> Result<(), String> {
        self.assets
            .try_clone()
            .and_then(|directory| directory.into_std_file().sync_all())
            .map_err(|error| format!("Could not sync the Notes attachment directory: {error}"))
    }

    #[cfg(not(unix))]
    fn sync_directory(&self) -> Result<(), String> {
        Ok(())
    }

    fn sync_cleanup_directory(&self) -> Result<(), String> {
        maybe_inject_cleanup_failure(CleanupFailurePoint::Sync)?;
        self.sync_directory()
    }

    #[cfg(test)]
    pub(crate) fn publish_attachment_bytes(
        &self,
        prepared: &PreparedAttachment,
    ) -> Result<String, String> {
        self.publish_attachment_bytes_with_identity(prepared, None, None)
    }

    pub(crate) fn publish_attachment_bytes_for_import(
        &self,
        prepared: &PreparedAttachment,
        identity: &VaultStorageIdentity,
    ) -> Result<String, String> {
        self.publish_attachment_bytes_with_identity(prepared, Some(identity), None)
    }

    pub(crate) fn publish_attachment_for_import_with_progress(
        &self,
        prepared: &PreparedAttachment,
        identity: &VaultStorageIdentity,
        progress: Option<&dyn AttachmentIngestProgress>,
    ) -> Result<String, String> {
        self.publish_attachment_bytes_with_identity(prepared, Some(identity), progress)
    }

    fn publish_attachment_bytes_with_identity(
        &self,
        prepared: &PreparedAttachment,
        identity: Option<&VaultStorageIdentity>,
        progress: Option<&dyn AttachmentIngestProgress>,
    ) -> Result<String, String> {
        match identity {
            Some(identity) => self.validate_identity(identity)?,
            None => self.validate_core_identity()?,
        }
        let relative_path =
            canonical_relative_path(&prepared.image.content_hash, prepared.image.mime_type)?;
        let target_name = safe_owned_file_name(&relative_path)?.to_string();
        if let Ok(existing) = self.open_owned_file(&target_name) {
            let matches = sha256_reader(
                existing.reader_from_start().map_err(|error| {
                    format!("Could not read the Notes attachment image: {error}")
                })?,
                MAX_ATTACHMENT_BYTES,
            )? == prepared.image.content_hash;
            if matches
                && existing
                    .verify_at(&self.assets, Path::new(&target_name))
                    .is_ok()
                && sha256_reader(
                    existing.reader_from_start().map_err(|error| {
                        format!("Could not re-read the Notes attachment image: {error}")
                    })?,
                    MAX_ATTACHMENT_BYTES,
                )? == prepared.image.content_hash
            {
                return Ok(relative_path);
            }
        }

        crate::notes::sync::asset_gc::publish_owned_asset_with_writer(
            &self.assets,
            Path::new(&target_name),
            &prepared.image.content_hash,
            prepared.image.byte_size,
            |temporary| {
                progress.map(|progress| progress.copying_started(prepared.image.byte_size));
                let mut write_chunk = |bytes: &[u8]| -> Result<(), String> {
                    temporary.write_all(bytes).map_err(|error| {
                        format!("Could not write a Notes attachment temporary file: {error}")
                    })?;
                    progress
                        .map(|progress| progress.copying(u64::try_from(bytes.len()).unwrap_or(0)));
                    Ok(())
                };
                match &prepared.source {
                    PreparedAttachmentSource::Bytes(bytes) => {
                        for chunk in bytes.chunks(ATTACHMENT_STREAM_CHUNK_BYTES) {
                            write_chunk(chunk)?;
                        }
                    }
                    PreparedAttachmentSource::StagedFile(file) => {
                        let mut source = file.try_clone().map_err(|error| {
                            format!("Could not clone the Notes attachment source: {error}")
                        })?;
                        source.seek(SeekFrom::Start(0)).map_err(|error| {
                            format!("Could not seek the Notes attachment source: {error}")
                        })?;
                        let mut copied = 0_u64;
                        let mut copied_hash = Sha256::new();
                        let mut buffer = vec![0_u8; ATTACHMENT_STREAM_CHUNK_BYTES];
                        loop {
                            let read = source.read(&mut buffer).map_err(|error| {
                                format!("Could not copy the Notes attachment source: {error}")
                            })?;
                            if read == 0 {
                                break;
                            }
                            copied = copied
                                .checked_add(u64::try_from(read).unwrap_or(0))
                                .ok_or_else(|| {
                                    "The Notes attachment copy byte count overflowed.".to_string()
                                })?;
                            if copied > prepared.image.byte_size {
                                return Err("The Notes attachment source changed while copying."
                                    .to_string());
                            }
                            copied_hash.update(&buffer[..read]);
                            write_chunk(&buffer[..read])?;
                        }
                        if copied != prepared.image.byte_size {
                            return Err(
                                "The Notes attachment source changed while copying.".to_string()
                            );
                        }
                        let copied_hash = copied_hash
                            .finalize()
                            .iter()
                            .map(|byte| format!("{byte:02x}"))
                            .collect::<String>();
                        if copied_hash != prepared.image.content_hash {
                            return Err(
                                "The Notes attachment source changed while copying.".to_string()
                            );
                        }
                    }
                }
                Ok(())
            },
        )?;
        match identity {
            Some(identity) => self.validate_identity(identity)?,
            None => self.validate_core_identity()?,
        }
        Ok(relative_path)
    }

    pub(crate) fn read_validated_attachment_bytes(
        &self,
        attachment: &NoteAttachment,
    ) -> Result<Vec<u8>, String> {
        self.read_validated_attachment_fields(
            &attachment.relative_path,
            &attachment.content_hash,
            &attachment.mime_type,
        )
    }

    pub(crate) fn read_validated_export_attachment_bytes(
        &self,
        attachment: &ExportAttachment,
    ) -> Result<Vec<u8>, String> {
        self.read_validated_attachment_fields(
            &attachment.relative_path,
            &attachment.content_hash,
            &attachment.mime_type,
        )
    }

    fn read_validated_attachment_fields(
        &self,
        relative_path: &str,
        content_hash: &str,
        mime_type: &str,
    ) -> Result<Vec<u8>, String> {
        resolve_owned_asset_path(Path::new("."), relative_path, content_hash, mime_type)?;
        let file_name = safe_owned_file_name(relative_path)?;
        let file = self.open_owned_file(file_name)?;
        let bytes = read_bounded(
            file.reader_from_start()
                .map_err(|error| format!("Could not read the Notes attachment file: {error}"))?,
            MAX_ATTACHMENT_BYTES,
        )?;
        file.verify_at(&self.assets, Path::new(file_name))
            .map_err(|error| {
                format!("The Notes attachment file changed while it was read: {error}")
            })?;
        // The image was fully decoded and validated at ingest, so on read we only
        // recompute the SHA-256 digest to detect on-disk corruption or tampering.
        // Skipping the per-read decode keeps multi-megabyte reads cheap. The
        // canonical `notes-assets/{hash}.{ext}` path was already checked by
        // `resolve_owned_asset_path`, so a matching digest confirms the bytes.
        if sha256_hex(&bytes) != content_hash {
            return Err(
                "The Notes attachment file no longer matches its stored content hash.".to_string(),
            );
        }
        Ok(bytes)
    }
}

#[cfg(test)]
pub(crate) fn publish_attachment_bytes(
    vault_path: &str,
    prepared: &PreparedAttachment,
) -> Result<String, String> {
    AttachmentStorageLease::acquire(vault_path)?.publish_attachment_bytes(prepared)
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

fn attachment_path_is_reachable(
    connection: &Connection,
    relative_path: &str,
) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(\
               SELECT 1 FROM notes_attachments WHERE relative_path = ?1 \
               UNION ALL \
               SELECT 1 FROM notes_history_changes \
               WHERE table_name = 'notes_attachments' AND (\
                 json_extract(before_json, '$.relative_path') = ?1 OR \
                 json_extract(after_json, '$.relative_path') = ?1\
               )\
             )",
            [relative_path],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect Notes attachment reachability: {error}"))
}

#[derive(Debug)]
enum QuarantineRenameError {
    AlreadyExists,
    Other(String),
}

impl AttachmentStorageLease {
    fn reconciliation_candidates(&self) -> Result<Vec<(PathBuf, FileIdentity)>, String> {
        let entries = self.assets.entries().map_err(|error| {
            format!("Could not inspect the Notes attachment directory: {error}")
        })?;
        let mut candidates = Vec::new();
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("Could not inspect a Notes attachment file: {error}"))?;
            let file_name = PathBuf::from(entry.file_name());
            if file_name
                .to_str()
                .is_some_and(|name| name.starts_with(ATTACHMENT_RECOVERY_PREFIX))
            {
                continue;
            }
            let metadata = match self.assets.symlink_metadata(&file_name) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(format!(
                        "Could not inspect a Notes attachment entry: {error}"
                    ))
                }
            };
            if !metadata.is_dir() {
                candidates.push((file_name, file_identity(&metadata)?));
            }
        }
        Ok(candidates)
    }

    fn open_held_file(&self, file_name: &Path) -> Result<HeldFile, String> {
        let held = hold_capability_regular_file_bounded_nofollow(
            &self.assets,
            file_name,
            MAX_ATTACHMENT_BYTES,
        )
        .map_err(|error| format!("Could not open a quarantined Notes attachment: {error}"))?;
        let metadata = held.metadata().map_err(|error| {
            format!("Could not inspect a quarantined Notes attachment: {error}")
        })?;
        if !has_single_link(&metadata)? {
            return Err("A quarantined Notes attachment must be an owned file.".to_string());
        }
        #[cfg(test)]
        held.inspect_capability_file(maybe_inject_held_file_after_open);
        let (device, inode) = held.identity();
        Ok(HeldFile {
            identity: FileIdentity { device, inode },
            held,
        })
    }

    fn held_file_bytes(&self, held: &HeldFile) -> Result<Vec<u8>, String> {
        let mut reader = held
            .held
            .reader_from_start()
            .map_err(|error| format!("Could not rewind a quarantined Notes attachment: {error}"))?;
        let mut bytes = Vec::with_capacity(usize::try_from(held.held.byte_size()).unwrap_or(0));
        reader
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Could not read a quarantined Notes attachment: {error}"))?;
        Ok(bytes)
    }

    fn held_file_matches_content_hash(
        &self,
        held: &HeldFile,
        expected_hash: &str,
    ) -> Result<bool, String> {
        Ok(sha256_hex(&self.held_file_bytes(held)?) == expected_hash)
    }

    fn quarantined_path_matches(&self, quarantined: &QuarantinedFile) -> Result<bool, String> {
        match self.assets.symlink_metadata(&quarantined.name) {
            Ok(metadata) => Ok(file_identity(&metadata)? == quarantined.held.identity),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!(
                "Could not revalidate a quarantined Notes attachment: {error}"
            )),
        }
    }

    fn quarantined_snapshot_matches(&self, quarantined: &QuarantinedFile) -> Result<bool, String> {
        Ok(self.quarantined_path_matches(quarantined)?
            && self
                .held_file_matches_content_hash(&quarantined.held, &quarantined.snapshot_hash)?
            && quarantined
                .held
                .held
                .verify_at(&self.assets, &quarantined.name)
                .is_ok())
    }

    fn preserve_quarantine_recovery(
        &self,
        quarantined: &QuarantinedFile,
        reason: &str,
    ) -> Result<(), String> {
        let recovery = self.copy_held_file_to_recovery(quarantined)?;
        Err(format!(
            "{reason} The exact held Notes attachment was preserved as {}.",
            recovery.name.display()
        ))
    }

    fn restore_verified_quarantine(
        &self,
        quarantined: &QuarantinedFile,
        file_name: &Path,
    ) -> Result<(), String> {
        let metadata = quarantined.held.held.metadata().map_err(|error| {
            format!("Could not inspect the held Notes attachment before restoration: {error}")
        })?;
        if !has_single_link(&metadata)? || !self.quarantined_snapshot_matches(quarantined)? {
            return self.preserve_quarantine_recovery(
                quarantined,
                "The raced Notes attachment quarantine path did not contain the exact held original.",
            );
        }
        match rename_noreplace(&self.assets, &quarantined.name, &self.assets, file_name) {
            Ok(()) => {
                let restored_metadata = quarantined.held.held.metadata().map_err(|error| {
                    format!("Could not inspect the restored Notes attachment: {error}")
                })?;
                if has_single_link(&restored_metadata)?
                    && self.held_file_matches_content_hash(
                        &quarantined.held,
                        &quarantined.snapshot_hash,
                    )?
                    && quarantined
                        .held
                        .held
                        .verify_at(&self.assets, file_name)
                        .is_ok()
                {
                    Ok(())
                } else {
                    self.preserve_quarantine_recovery(
                        quarantined,
                        "The restored Notes attachment changed during exact restoration.",
                    )
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => self
                .preserve_quarantine_recovery(
                    quarantined,
                    "The canonical Notes attachment path was occupied during exact restoration.",
                ),
            Err(error) => self.preserve_quarantine_recovery(
                quarantined,
                &format!("Could not restore the exact held Notes attachment: {error}"),
            ),
        }
    }

    fn quarantine_candidate_with_prefix(
        &self,
        file_name: &Path,
        expected_identity: FileIdentity,
        prefix: &str,
    ) -> Result<Option<QuarantinedFile>, String> {
        let boundary = match self.open_held_file(file_name) {
            Ok(held) if held.identity == expected_identity => held,
            Ok(_) => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "Could not hold a Notes attachment quarantine boundary: {error}"
                ))
            }
        };
        let boundary_metadata = boundary.held.metadata().map_err(|error| {
            format!("Could not inspect a Notes attachment quarantine boundary: {error}")
        })?;
        if !has_single_link(&boundary_metadata)?
            || boundary.held.verify_at(&self.assets, file_name).is_err()
        {
            return Ok(None);
        }
        let snapshot_hash = sha256_hex(&self.held_file_bytes(&boundary)?);
        let snapshot_metadata = boundary.held.metadata().map_err(|error| {
            format!("Could not re-inspect a Notes attachment quarantine snapshot: {error}")
        })?;
        if !has_single_link(&snapshot_metadata)?
            || !self.held_file_matches_content_hash(&boundary, &snapshot_hash)?
            || boundary.held.verify_at(&self.assets, file_name).is_err()
        {
            return Ok(None);
        }
        let mut quarantined_name = None;
        for _ in 0..100 {
            let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let candidate = PathBuf::from(format!("{prefix}{}-{sequence}", std::process::id()));
            let final_metadata = boundary.held.metadata().map_err(|error| {
                format!("Could not re-inspect a Notes attachment quarantine boundary: {error}")
            })?;
            if !has_single_link(&final_metadata)?
                || boundary.held.verify_at(&self.assets, file_name).is_err()
            {
                return Ok(None);
            }
            match rename_noreplace(&self.assets, file_name, &self.assets, &candidate) {
                Ok(()) => {
                    quarantined_name = Some(candidate);
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => {
                    return Err(format!("Could not quarantine a Notes attachment: {error}"))
                }
            }
        }
        let quarantined_name = quarantined_name
            .ok_or_else(|| "Could not allocate a Notes attachment quarantine path.".to_string())?;
        maybe_inject_quarantine_after_move(&quarantined_name);
        let quarantined = QuarantinedFile {
            name: quarantined_name,
            held: boundary,
            snapshot_hash,
        };
        if !has_single_link(&quarantined.held.held.metadata().map_err(|error| {
            format!("Could not re-inspect a quarantined Notes attachment: {error}")
        })?)?
            || !self.quarantined_snapshot_matches(&quarantined)?
        {
            self.restore_verified_quarantine(&quarantined, file_name)?;
            return Ok(None);
        }
        Ok(Some(quarantined))
    }

    fn quarantine_reconciliation_candidate(
        &self,
        file_name: &Path,
        expected_identity: FileIdentity,
    ) -> Result<Option<QuarantinedFile>, String> {
        self.quarantine_candidate_with_prefix(
            file_name,
            expected_identity,
            ATTACHMENT_QUARANTINE_PREFIX,
        )
    }

    fn copy_held_file_to_recovery(
        &self,
        quarantined: &QuarantinedFile,
    ) -> Result<QuarantinedFile, String> {
        let bytes = self.held_file_bytes(&quarantined.held)?;
        let expected_hash = quarantined.snapshot_hash.clone();
        if sha256_hex(&bytes) != expected_hash {
            return Err(
                "The Notes attachment quarantine bytes changed before recovery copying."
                    .to_string(),
            );
        }
        if quarantined
            .name
            .to_str()
            .is_some_and(|name| name.starts_with(ATTACHMENT_RECOVERY_PREFIX))
            && self.quarantined_path_matches(quarantined)?
        {
            if !self.held_file_matches_content_hash(&quarantined.held, &expected_hash)?
                || quarantined
                    .held
                    .held
                    .verify_at(&self.assets, &quarantined.name)
                    .is_err()
            {
                return Err(
                    "The Notes attachment recovery bytes changed before they could be retained."
                        .to_string(),
                );
            }
            return Ok(QuarantinedFile {
                name: quarantined.name.clone(),
                held: HeldFile {
                    held: quarantined.held.held.try_clone_held().map_err(|error| {
                        format!("Could not retain a Notes attachment recovery handle: {error}")
                    })?,
                    identity: quarantined.held.identity,
                },
                snapshot_hash: expected_hash,
            });
        }
        for _ in 0..100 {
            let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let recovery_name = PathBuf::from(format!(
                "{ATTACHMENT_RECOVERY_PREFIX}{}-{sequence}",
                std::process::id()
            ));
            let mut options = OpenOptions::new();
            options
                .read(true)
                .write(true)
                .create_new(true)
                .follow(FollowSymlinks::No);
            let mut recovery = match self.assets.open_with(&recovery_name, &options) {
                Ok(recovery) => recovery,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!(
                        "Could not create a Notes attachment recovery quarantine: {error}"
                    ))
                }
            };
            recovery.write_all(&bytes).map_err(|error| {
                format!("Could not preserve Notes attachment recovery bytes: {error}")
            })?;
            recovery.sync_all().map_err(|error| {
                format!("Could not sync Notes attachment recovery bytes: {error}")
            })?;
            let recovery_metadata = recovery.metadata().map_err(|error| {
                format!("Could not inspect a Notes attachment recovery file: {error}")
            })?;
            let recovery_identity = file_identity(&recovery_metadata)?;
            drop(recovery);
            maybe_inject_recovery_file_after_copy(&recovery_name);
            self.sync_directory()?;
            let held = self.open_held_file(&recovery_name)?;
            if held.identity != recovery_identity
                || !self.held_file_matches_content_hash(&held, &expected_hash)?
                || held.held.verify_at(&self.assets, &recovery_name).is_err()
            {
                return Err("The Notes attachment recovery changed after publication.".to_string());
            }
            return Ok(QuarantinedFile {
                name: recovery_name,
                held,
                snapshot_hash: expected_hash,
            });
        }
        Err("Could not allocate a Notes attachment recovery quarantine path.".to_string())
    }

    fn mark_quarantine_for_recovery(
        &self,
        quarantined: &mut QuarantinedFile,
    ) -> Result<(), String> {
        if quarantined
            .name
            .to_str()
            .is_some_and(|name| name.starts_with(ATTACHMENT_RECOVERY_PREFIX))
        {
            if self.quarantined_snapshot_matches(quarantined)? {
                return Ok(());
            }
            let recovery = self.copy_held_file_to_recovery(quarantined)?;
            let recovery_name = recovery.name.display().to_string();
            *quarantined = recovery;
            return Err(format!(
                "The Notes attachment quarantine identity changed; verified bytes were preserved as {}.",
                recovery_name
            ));
        }
        for _ in 0..100 {
            let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let recovery_name = PathBuf::from(format!(
                "{ATTACHMENT_RECOVERY_PREFIX}{}-{sequence}",
                std::process::id()
            ));
            if !self.quarantined_path_matches(quarantined)? {
                let recovery = self.copy_held_file_to_recovery(quarantined)?;
                let recovery_name = recovery.name.display().to_string();
                *quarantined = recovery;
                return Err(format!(
                    "The Notes attachment quarantine identity changed; verified bytes were preserved as {}.",
                    recovery_name
                ));
            }
            match rename_noreplace(
                &self.assets,
                &quarantined.name,
                &self.assets,
                &recovery_name,
            ) {
                Ok(()) => {
                    quarantined.name = recovery_name;
                    if self.quarantined_path_matches(quarantined)? {
                        return Ok(());
                    }
                    let recovery = self.copy_held_file_to_recovery(quarantined)?;
                    let recovery_name = recovery.name.display().to_string();
                    *quarantined = recovery;
                    return Err(format!(
                        "The Notes attachment recovery identity changed; verified bytes were preserved as {}.",
                        recovery_name
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    let recovery = self.copy_held_file_to_recovery(quarantined)?;
                    let recovery_name = recovery.name.display().to_string();
                    *quarantined = recovery;
                    return Err(format!(
                        "Could not preserve a Notes attachment recovery quarantine: {error}. Verified bytes were preserved as {}.",
                        recovery_name
                    ));
                }
            }
        }
        Err("Could not allocate a Notes attachment recovery quarantine path.".to_string())
    }

    fn ensure_quarantined_identity_for_action(
        &self,
        quarantined: &QuarantinedFile,
    ) -> Result<(), String> {
        maybe_inject_quarantined_file_before_action(&quarantined.name);
        if !self.held_file_matches_content_hash(&quarantined.held, &quarantined.snapshot_hash)? {
            return Err(
                "The Notes attachment quarantine bytes changed before the filesystem action."
                    .to_string(),
            );
        }
        let metadata = quarantined.held.held.metadata().map_err(|error| {
            format!("Could not inspect a quarantined Notes attachment: {error}")
        })?;
        if has_single_link(&metadata)?
            && self.quarantined_path_matches(quarantined)?
            && quarantined
                .held
                .held
                .verify_at(&self.assets, &quarantined.name)
                .is_ok()
        {
            return Ok(());
        }
        let recovery = self.copy_held_file_to_recovery(quarantined)?;
        Err(format!(
            "The Notes attachment quarantine identity changed before the filesystem action; verified bytes were preserved as {}.",
            recovery.name.display()
        ))
    }

    fn rename_quarantined_noreplace(
        &self,
        quarantined: &QuarantinedFile,
        file_name: &Path,
    ) -> Result<(), QuarantineRenameError> {
        self.ensure_quarantined_identity_for_action(quarantined)
            .map_err(QuarantineRenameError::Other)?;
        match rename_noreplace(&self.assets, &quarantined.name, &self.assets, file_name) {
            Ok(()) => {
                let restored_metadata = quarantined.held.held.metadata().map_err(|error| {
                    QuarantineRenameError::Other(format!(
                        "Could not inspect a restored Notes attachment: {error}"
                    ))
                })?;
                if has_single_link(&restored_metadata).map_err(QuarantineRenameError::Other)?
                    && self
                        .held_file_matches_content_hash(
                            &quarantined.held,
                            &quarantined.snapshot_hash,
                        )
                        .map_err(QuarantineRenameError::Other)?
                    && quarantined
                        .held
                        .held
                        .verify_at(&self.assets, file_name)
                        .is_ok()
                {
                    Ok(())
                } else {
                    let recovery = self
                        .copy_held_file_to_recovery(quarantined)
                        .map_err(QuarantineRenameError::Other)?;
                    Err(QuarantineRenameError::Other(format!(
                        "The restored Notes attachment identity changed; verified bytes were preserved as {}.",
                        recovery.name.display()
                    )))
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                Err(QuarantineRenameError::AlreadyExists)
            }
            Err(error) => Err(QuarantineRenameError::Other(format!(
                "Could not restore a quarantined Notes attachment: {error}"
            ))),
        }
    }

    fn retire_quarantined_file(
        &self,
        quarantined: QuarantinedFile,
        context: &str,
        survivor: Option<crate::notes::sync::asset_gc::RetirementSurvivor<'_>>,
    ) -> Result<(), String> {
        self.ensure_quarantined_identity_for_action(&quarantined)?;
        maybe_inject_quarantined_file_after_validation(&quarantined.name);
        if !self.quarantined_snapshot_matches(&quarantined)? {
            return Err(format!(
                "Could not remove {context}: the quarantined Notes attachment changed at the final retirement boundary."
            ));
        }
        let QuarantinedFile {
            name,
            held,
            snapshot_hash,
        } = quarantined;
        crate::notes::sync::asset_gc::logical_retire_noreplace(
            &self.assets,
            &name,
            held.held,
            Some(&snapshot_hash),
            survivor,
            &mut || Ok(()),
        )
        .map_err(|error| format!("Could not remove {context}: {error}"))
    }

    fn remove_quarantined_file(
        &self,
        quarantined: QuarantinedFile,
        context: &str,
    ) -> Result<(), String> {
        self.retire_quarantined_file(quarantined, context, None)
    }

    fn restore_quarantined_file(
        &self,
        mut quarantined: QuarantinedFile,
        file_name: &Path,
    ) -> Result<(), String> {
        let destination_exists = match self.assets.symlink_metadata(file_name) {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => {
                return Err(format!(
                    "Could not inspect a Notes attachment restore destination: {error}"
                ))
            }
        };
        if !destination_exists {
            match self.rename_quarantined_noreplace(&quarantined, file_name) {
                Ok(()) => return Ok(()),
                Err(QuarantineRenameError::AlreadyExists) => {}
                Err(QuarantineRenameError::Other(error)) => return Err(error),
            }
        }

        self.mark_quarantine_for_recovery(&mut quarantined)?;
        let expected_hash = owned_file_name_content_hash(file_name).ok_or_else(|| {
            "A conflicting Notes attachment restore preserved both files because their intended content could not be verified."
                .to_string()
        })?;
        let destination = self.open_held_file(file_name)?;
        if self.held_file_matches_content_hash(&destination, expected_hash)? {
            maybe_inject_restore_before_duplicate_retirement();
            if !self.held_file_matches_content_hash(&destination, expected_hash)? {
                return Err(
                    "The verified duplicate Notes attachment changed before recovery retirement; both files were preserved."
                        .to_string(),
                );
            }
            maybe_inject_restore_after_duplicate_hash();
            destination
                .held
                .verify_at(&self.assets, file_name)
                .map_err(|error| {
                    format!(
                        "The verified duplicate Notes attachment changed before recovery retirement: {error}"
                    )
                })?;
            drop(destination);
            return self.retire_quarantined_file(
                quarantined,
                "verified duplicate Notes attachment",
                Some(crate::notes::sync::asset_gc::RetirementSurvivor::new(
                    &self.assets,
                    file_name,
                    expected_hash,
                )),
            );
        }
        if !self.held_file_matches_content_hash(&quarantined.held, expected_hash)? {
            return Err(
                "A conflicting Notes attachment restore preserved both files because neither file matched the intended content hash."
                    .to_string(),
            );
        }
        let destination_identity = destination.identity;
        drop(destination);
        let Some(conflict) =
            self.quarantine_reconciliation_candidate(file_name, destination_identity)?
        else {
            return Err(
                "A conflicting Notes attachment restore preserved verified recovery bytes because the destination identity changed."
                    .to_string(),
            );
        };
        maybe_inject_restore_after_conflict_quarantine();
        match self.rename_quarantined_noreplace(&quarantined, file_name) {
            Ok(()) => self
                .remove_quarantined_file(conflict, "conflicting Notes attachment quarantine"),
            Err(QuarantineRenameError::AlreadyExists) => Err(
                "A conflicting Notes attachment restore preserved verified recovery bytes because a new destination appeared."
                    .to_string(),
            ),
            Err(QuarantineRenameError::Other(error)) => Err(error),
        }
    }

    fn restore_quarantined_file_after_error(
        &self,
        quarantined: QuarantinedFile,
        file_name: &Path,
        error: String,
    ) -> String {
        match self.restore_quarantined_file(quarantined, file_name) {
            Ok(()) => error,
            Err(restore_error) => format!("{error} {restore_error}"),
        }
    }

    fn preserve_quarantine_for_restore(
        &self,
        quarantined: &mut QuarantinedFile,
    ) -> Result<(), String> {
        match self.quarantined_path_matches(quarantined) {
            Ok(true) => self.mark_quarantine_for_recovery(quarantined),
            Ok(false) => {
                *quarantined = self.copy_held_file_to_recovery(quarantined)?;
                Ok(())
            }
            Err(error) => {
                *quarantined = self.copy_held_file_to_recovery(quarantined)?;
                Err(error)
            }
        }
    }

    fn restore_reconciliation_quarantines_after_error(
        &self,
        quarantines: Vec<(PathBuf, QuarantinedFile)>,
        error: String,
    ) -> String {
        let mut errors = vec![error];
        for (file_name, mut quarantined) in quarantines {
            if let Err(error) = self.preserve_quarantine_for_restore(&mut quarantined) {
                errors.push(format!(
                    "Could not protect a Notes attachment cleanup quarantine: {error}"
                ));
            }
            if let Err(error) = self.restore_quarantined_file(quarantined, &file_name) {
                errors.push(format!(
                    "Could not restore a Notes attachment cleanup quarantine: {error}"
                ));
            }
        }
        if let Err(error) = self.sync_directory() {
            errors.push(error);
        }
        if let Err(error) = self.mark_reconciliation_needed() {
            errors.push(format!(
                "Could not mark Notes attachment reconciliation after cleanup rollback: {error}"
            ));
        }
        errors.join(" ")
    }

    fn validate_reconciliation_identity(
        &self,
        identity: &VaultStorageIdentity,
        validate_connection: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        validate_connection()?;
        self.validate_identity(identity)?;
        validate_connection()
    }

    fn finalize_reconciliation_quarantines(
        &self,
        transaction: rusqlite::Transaction<'_>,
        quarantines: Vec<(PathBuf, QuarantinedFile)>,
        identity: &VaultStorageIdentity,
        validate_connection: &mut impl FnMut() -> Result<(), String>,
        context: &str,
        sync_when_empty: bool,
    ) -> Result<usize, String> {
        if let Err(error) = self.validate_reconciliation_identity(identity, validate_connection) {
            return Err(self.restore_reconciliation_quarantines_after_error(quarantines, error));
        }

        let (gc_assets, trash) = match self.asset_gc_directories() {
            Ok(directories) => directories,
            Err(error) => {
                return Err(self.restore_reconciliation_quarantines_after_error(quarantines, error))
            }
        };
        if let Err(error) = self.validate_asset_gc_directories(&gc_assets, &trash) {
            return Err(self.restore_reconciliation_quarantines_after_error(quarantines, error));
        }

        let quarantine_count = quarantines.len();
        let mut quarantines = quarantines.into_iter().map(Some).collect::<Vec<_>>();
        let mut recoveries = Vec::with_capacity(quarantines.len());
        for index in 0..quarantines.len() {
            let removal = (|| {
                let file_name = quarantines[index]
                    .as_ref()
                    .expect("pending reconciliation quarantine")
                    .0
                    .clone();
                self.validate_asset_gc_directories(&gc_assets, &trash)?;
                maybe_inject_full_reconciliation_before_remove();
                let retained_destination = if let Some(expected_hash) =
                    owned_file_name_content_hash(&file_name)
                {
                    let quarantined_name = &quarantines[index]
                        .as_ref()
                        .expect("pending reconciliation quarantine")
                        .1
                        .name;
                    let retained = crate::notes::sync::asset_gc::retain_reconciliation_asset(
                        &transaction,
                        &gc_assets,
                        quarantined_name,
                        &trash,
                        &file_name,
                        expected_hash,
                        &mut || self.validate_asset_gc_directories(&gc_assets, &trash),
                    )?;
                    self.validate_asset_gc_directories(&gc_assets, &trash)?;
                    retained
                        .map(|retained| (file_name.clone(), expected_hash.to_string(), retained))
                } else {
                    None
                };
                maybe_inject_cleanup_failure(CleanupFailurePoint::Remove)?;
                let retained_survivor = retained_destination
                    .map(|(file_name, expected_hash, retained)| {
                        crate::notes::sync::asset_gc::verify_owned_asset_evidence(
                            &trash,
                            &file_name,
                            &retained,
                            &expected_hash,
                        )?;
                        drop(retained);
                        Ok::<_, String>((file_name, expected_hash))
                    })
                    .transpose()?;
                let recovery = self.copy_held_file_to_recovery(
                    &quarantines[index]
                        .as_ref()
                        .expect("pending reconciliation quarantine")
                        .1,
                )?;
                recoveries.push((file_name.clone(), recovery));
                let quarantined = quarantines[index]
                    .take()
                    .expect("pending reconciliation quarantine")
                    .1;
                self.retire_quarantined_file(
                    quarantined,
                    context,
                    retained_survivor
                        .as_ref()
                        .map(|(file_name, expected_hash)| {
                            crate::notes::sync::asset_gc::RetirementSurvivor::new(
                                &trash,
                                file_name,
                                expected_hash,
                            )
                        }),
                )?;
                self.validate_asset_gc_directories(&gc_assets, &trash)
            })();
            if let Err(error) = removal {
                return Err(self.restore_reconciliation_quarantines_after_error(
                    recoveries
                        .into_iter()
                        .chain(quarantines.into_iter().flatten())
                        .collect(),
                    error,
                ));
            }
            maybe_inject_full_reconciliation_after_remove(&transaction);
        }

        if sync_when_empty || quarantine_count != 0 {
            if let Err(error) = self.sync_cleanup_directory() {
                return Err(self.restore_reconciliation_quarantines_after_error(
                    recoveries
                        .into_iter()
                        .chain(quarantines.into_iter().flatten())
                        .collect(),
                    error,
                ));
            }
        }
        if let Err(error) = self.validate_asset_gc_directories(&gc_assets, &trash) {
            return Err(self.restore_reconciliation_quarantines_after_error(
                recoveries
                    .into_iter()
                    .chain(quarantines.into_iter().flatten())
                    .collect(),
                error,
            ));
        }
        if let Err(error) = transaction.commit() {
            return Err(self.restore_reconciliation_quarantines_after_error(
                recoveries
                    .into_iter()
                    .chain(quarantines.into_iter().flatten())
                    .collect(),
                format!("Could not release Notes attachment reconciliation lock: {error}"),
            ));
        }
        if let Err(error) = self.validate_reconciliation_identity(identity, validate_connection) {
            return Err(self.restore_reconciliation_quarantines_after_error(
                recoveries
                    .into_iter()
                    .chain(quarantines.into_iter().flatten())
                    .collect(),
                error,
            ));
        }
        if let Err(error) = self.validate_asset_gc_directories(&gc_assets, &trash) {
            return Err(self.restore_reconciliation_quarantines_after_error(
                recoveries
                    .into_iter()
                    .chain(quarantines.into_iter().flatten())
                    .collect(),
                error,
            ));
        }
        for (_, recovery) in recoveries {
            self.retire_quarantined_file(
                recovery,
                "verified Notes attachment recovery cleanup",
                None,
            )?;
        }
        Ok(quarantine_count)
    }

    pub(crate) fn reconcile_attachment_files_validated(
        &self,
        connection: &Connection,
        identity: &VaultStorageIdentity,
        mut validate_connection: impl FnMut() -> Result<(), String>,
    ) -> Result<usize, String> {
        maybe_inject_cleanup_failure(CleanupFailurePoint::Reconcile)?;
        let candidates = self.reconciliation_candidates()?;
        let transaction = rusqlite::Transaction::new_unchecked(
            connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(|error| {
            format!("Could not lock Notes attachment reachability for reconciliation: {error}")
        })?;
        let reachable = reachable_asset_paths(&transaction)?;
        maybe_inject_full_reconciliation_after_snapshot(&transaction);
        let mut quarantines = Vec::new();
        let staged = (|| {
            for (file_name, expected_identity) in candidates {
                let relative = file_name
                    .to_str()
                    .map(|name| format!("notes-assets/{name}"));
                if relative
                    .as_ref()
                    .is_some_and(|path| reachable.contains(path))
                {
                    continue;
                }
                let Some(quarantined) =
                    self.quarantine_reconciliation_candidate(&file_name, expected_identity)?
                else {
                    continue;
                };
                maybe_inject_full_reconciliation_after_quarantine(&transaction);
                let is_reachable = match relative.as_deref() {
                    Some(relative_path) => {
                        match attachment_path_is_reachable(&transaction, relative_path) {
                            Ok(is_reachable) => is_reachable,
                            Err(error) => {
                                quarantines.push((file_name, quarantined));
                                return Err(error);
                            }
                        }
                    }
                    None => false,
                };
                if is_reachable {
                    self.restore_quarantined_file(quarantined, &file_name)?;
                } else {
                    quarantines.push((file_name, quarantined));
                }
            }
            Ok(())
        })();
        if let Err(error) = staged {
            return Err(self.restore_reconciliation_quarantines_after_error(quarantines, error));
        }
        self.finalize_reconciliation_quarantines(
            transaction,
            quarantines,
            identity,
            &mut validate_connection,
            "unreferenced Notes attachment quarantine",
            true,
        )
    }

    pub(crate) fn reconcile_attachment_candidates_validated(
        &self,
        connection: &Connection,
        identity: &VaultStorageIdentity,
        candidates: &[String],
        mut validate_connection: impl FnMut() -> Result<(), String>,
    ) -> Result<usize, String> {
        maybe_inject_cleanup_failure(CleanupFailurePoint::Reconcile)?;
        let transaction = rusqlite::Transaction::new_unchecked(
            connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(|error| {
            format!("Could not lock Notes attachment reachability for targeted cleanup: {error}")
        })?;
        let mut quarantines = Vec::new();
        let staged = (|| {
            for relative_path in candidates {
                let file_name = PathBuf::from(safe_owned_file_name(relative_path)?);
                if attachment_path_is_reachable(&transaction, relative_path)? {
                    continue;
                }
                let metadata = match self.assets.symlink_metadata(&file_name) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => {
                        return Err(format!(
                            "Could not inspect an evicted Notes attachment: {error}"
                        ))
                    }
                };
                let Some(quarantined) = self
                    .quarantine_reconciliation_candidate(&file_name, file_identity(&metadata)?)?
                else {
                    continue;
                };
                maybe_inject_full_reconciliation_after_quarantine(&transaction);
                match attachment_path_is_reachable(&transaction, relative_path) {
                    Ok(true) => self.restore_quarantined_file(quarantined, &file_name)?,
                    Ok(false) => quarantines.push((file_name, quarantined)),
                    Err(error) => {
                        quarantines.push((file_name, quarantined));
                        return Err(error);
                    }
                }
            }
            Ok(())
        })();
        if let Err(error) = staged {
            return Err(self.restore_reconciliation_quarantines_after_error(quarantines, error));
        }
        self.finalize_reconciliation_quarantines(
            transaction,
            quarantines,
            identity,
            &mut validate_connection,
            "evicted Notes attachment quarantine",
            false,
        )
    }

    #[cfg(test)]
    pub(crate) fn reconcile_attachment_files(
        &self,
        connection: &Connection,
    ) -> Result<usize, String> {
        let identity = self.capture_database_identity(connection)?;
        self.reconcile_attachment_files_validated(connection, &identity, || Ok(()))
    }

    #[cfg(test)]
    pub(crate) fn reconcile_attachment_candidates(
        &self,
        connection: &Connection,
        candidates: &[String],
    ) -> Result<usize, String> {
        let identity = self.capture_database_identity(connection)?;
        self.reconcile_attachment_candidates_validated(connection, &identity, candidates, || Ok(()))
    }

    fn delete_attachment_file_entries(&self) -> Result<(), String> {
        let entries = self.assets.entries().map_err(|error| {
            format!("Could not enumerate Notes attachment files for deletion: {error}")
        })?;
        let mut candidates = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| {
                format!("Could not inspect a Notes attachment for deletion: {error}")
            })?;
            let file_name = PathBuf::from(entry.file_name());
            if crate::notes::sync::asset_gc::is_private_asset_operation_name(&file_name) {
                crate::notes::sync::asset_gc::reclaim_private_asset_operation_payload(
                    &self.assets,
                    &file_name,
                )?;
                continue;
            }
            let name = file_name.to_str().ok_or_else(|| {
                "A Notes attachment file name must be UTF-8 before deletion.".to_string()
            })?;
            if !name.starts_with(ATTACHMENT_QUARANTINE_PREFIX)
                && !name.starts_with(ATTACHMENT_RECOVERY_PREFIX)
            {
                safe_owned_file_name(&format!("notes-assets/{name}"))?;
            }
            let metadata = self
                .assets
                .symlink_metadata(&file_name)
                .map_err(|error| format!("Could not inspect a Notes attachment type: {error}"))?;
            if !metadata.is_file() {
                return Err(
                    "Notes attachment deletion found a non-regular owned entry.".to_string()
                );
            }
            candidates.push((file_name, file_identity(&metadata)?));
        }
        for (file_name, expected_identity) in candidates {
            let Some(quarantined) =
                self.quarantine_reconciliation_candidate(&file_name, expected_identity)?
            else {
                return Err(
                    "A Notes attachment identity changed during database deletion.".to_string(),
                );
            };
            if let Err(error) = maybe_inject_cleanup_failure(CleanupFailurePoint::Remove) {
                return Err(self.restore_quarantined_file_after_error(
                    quarantined,
                    &file_name,
                    error,
                ));
            }
            self.remove_quarantined_file(quarantined, "verified Notes attachment quarantine")?;
        }
        maybe_inject_cleanup_failure(CleanupFailurePoint::Sync)?;
        self.assets
            .try_clone()
            .and_then(|directory| directory.into_std_file().sync_all())
            .map_err(|error| format!("Could not sync deleted Notes attachments: {error}"))
    }

    pub(crate) fn delete_attachment_files(self) -> Result<(), String> {
        let mut cleanup_errors = Vec::new();
        match self.asset_gc_directories() {
            Ok((_assets, trash)) => {
                if let Err(error) =
                    crate::notes::sync::asset_gc::reclaim_all_owned_asset_entries(&trash)
                {
                    cleanup_errors.push(format!(
                        "Could not clean the app-local Notes asset trash: {error}"
                    ));
                }
            }
            Err(error) => cleanup_errors.push(error),
        }
        if let Err(error) = self.delete_attachment_file_entries() {
            cleanup_errors.push(error);
        }
        if !cleanup_errors.is_empty() {
            let error = cleanup_errors.join(" ");
            let _ = mark_reconciliation_needed_in(&self.metadata);
            eprintln!("Notes attachment cleanup warning: {error}");
            return Err(error);
        }
        let Self {
            _lock_file,
            metadata,
            assets,
            database_storage: _,
            database_path: _,
            metadata_identity: _,
            lock_identity: _,
            assets_identity: _,
        } = self;
        drop(assets);
        let result = (|| {
            match metadata.remove_file_or_symlink(RECONCILIATION_MARKER) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "Could not clear the Notes attachment reconciliation marker: {error}"
                    ))
                }
            }
            sync_capability_directory(&metadata)
        })();
        if let Err(error) = &result {
            let _ = mark_reconciliation_needed_in(&metadata);
            eprintln!("Notes attachment cleanup warning: {error}");
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_relative_path, inject_attachment_storage_after_app_lock_once,
        inject_cleanup_failure, inject_full_reconciliation_after_quarantine_once,
        inject_full_reconciliation_after_snapshot_once,
        inject_full_reconciliation_before_remove_once, inject_held_file_after_open_once,
        inject_quarantine_after_move_once, inject_quarantined_file_after_validation_once,
        inject_quarantined_file_before_action_once, inject_recovery_file_after_copy_once,
        inject_restore_after_conflict_quarantine_once, inject_restore_after_duplicate_hash_once,
        inject_restore_before_duplicate_retirement_once, inject_source_growth,
        prepare_source_attachment, prepare_source_attachment_without_budget,
        publish_attachment_bytes, rename_noreplace, resolve_owned_asset_path, sha256_hex,
        validate_decoded_dimensions, validate_image_bytes, AttachmentStorageLease,
        CleanupFailurePoint, PreparedAttachmentBatch, ValidationLimits, MAX_ATTACHMENT_BATCH_BYTES,
    };
    // Alias each command to its synchronous `_inner` body so these tests keep
    // running the note logic inline (the public commands are now async wrappers
    // that dispatch onto the blocking thread pool). Call sites stay unchanged.
    use crate::notes::commands::{
        notes_clear_history_legacy_inner as notes_clear_history,
        notes_delete_database_inner as notes_delete_database,
        notes_download_attachment_inner as notes_download_attachment,
        notes_empty_trash_legacy_inner as notes_empty_trash,
        notes_export_markdown_inner as notes_export_markdown,
        notes_import_attachment_with_optional_history_context_for_test as notes_import_attachment,
        notes_import_markdown_inner as notes_import_markdown,
        notes_initialize_inner as notes_initialize,
        notes_read_attachment_bytes_inner as notes_read_attachment_bytes,
        notes_redo_legacy_inner as notes_redo,
        notes_remove_attachment_with_optional_history_context_for_test as notes_remove_attachment,
        notes_resize_attachment_with_optional_history_context_for_test as notes_resize_attachment,
        notes_restore_attachment_with_optional_history_context_for_test as notes_restore_attachment,
        notes_undo_legacy_inner as notes_undo,
        notes_update_node_with_optional_history_context_for_test as notes_update_node,
    };
    use crate::notes::connection::{acquire_notes_connection, lock_notes_connection};
    use crate::notes::history::HISTORY_MAX_ENTRIES;
    use crate::notes::history::{redo, undo};
    use crate::notes::repository::{
        archive_node, connect_notes_db, create_attachment_coordinated, create_node,
        load_export_snapshot, load_workspace, remove_empty_node, restore_node, soft_delete_node,
        unarchive_node,
    };
    use crate::notes::sync::asset_gc::{
        create_private_directory, inject_after_counterpart_isolation_once,
        inject_before_staged_publication_once, inject_retirement_authorization_failure_once,
        run_asset_gc, AssetGcConfig, PRIVATE_ASSET_PAYLOAD, RETIRED_DIRECTORY_PREFIX,
    };
    use crate::notes::types::{
        CreateNodeInput, ExportAttachment, ExportNode, ImportAttachmentInput,
        ImportNotesMarkdownInput, NoteNodeKind, NotesExportSnapshot, NotesHistoryContext,
        NotesWorkspaceScope, ResizeAttachmentInput, UpdateNodeInput,
    };
    use image::codecs::gif::GifEncoder;
    use image::{DynamicImage, Frame, ImageFormat, Rgba, RgbaImage};
    use rusqlite::{params, Connection};
    use std::fs;
    use std::io::Cursor;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

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

    fn encoded_gif_frames(frame_count: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = GifEncoder::new(&mut bytes);
            for index in 0..frame_count {
                let frame = RgbaImage::from_pixel(
                    2,
                    3,
                    Rgba([u8::try_from(index % 255).expect("frame color"), 0, 0, 255]),
                );
                encoder
                    .encode_frame(Frame::new(frame))
                    .expect("encode GIF frame");
            }
        }
        bytes
    }

    fn encoded_apng_frames(frame_count: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 2, 3);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .set_animated(frame_count, 0)
                .expect("configure APNG fixture");
            let mut writer = encoder.write_header().expect("write APNG header");
            for index in 0..frame_count {
                let mut frame = vec![0_u8; 2 * 3 * 4];
                frame[0] = u8::try_from(index % 255).expect("frame color");
                frame[3] = 255;
                writer.write_image_data(&frame).expect("write APNG frame");
            }
            writer.finish().expect("finish APNG fixture");
        }
        bytes
    }

    fn push_webp_chunk(output: &mut Vec<u8>, kind: &[u8; 4], payload: &[u8]) {
        output.extend_from_slice(kind);
        output.extend_from_slice(
            &u32::try_from(payload.len())
                .expect("WebP chunk size")
                .to_le_bytes(),
        );
        output.extend_from_slice(payload);
        if payload.len() % 2 != 0 {
            output.push(0);
        }
    }

    fn encoded_animated_webp() -> Vec<u8> {
        let static_webp = encoded(ImageFormat::WebP);
        let image_chunk = &static_webp[12..];
        let mut chunks = Vec::new();
        push_webp_chunk(&mut chunks, b"VP8X", &[0x02, 0, 0, 0, 1, 0, 0, 2, 0, 0]);
        push_webp_chunk(&mut chunks, b"ANIM", &[0, 0, 0, 0, 0, 0]);
        for duration in [10_u8, 20_u8] {
            let mut frame = vec![0_u8; 16];
            frame[6] = 1;
            frame[9] = 2;
            frame[12] = duration;
            frame.extend_from_slice(image_chunk);
            push_webp_chunk(&mut chunks, b"ANMF", &frame);
        }
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(
            &u32::try_from(4 + chunks.len())
                .expect("WebP RIFF size")
                .to_le_bytes(),
        );
        bytes.extend_from_slice(b"WEBP");
        bytes.extend_from_slice(&chunks);
        bytes
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
        connection
            .execute("DELETE FROM notes_nodes", [])
            .expect("remove onboarding fixture nodes");
        create_node(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "Image node".to_string(),
                note: String::new(),
            },
        )
        .expect("seed node");
    }

    #[derive(Debug)]
    struct ResetSeedRow {
        id: String,
        parent_id: Option<String>,
        sort_key: i64,
        title: String,
        note: String,
        is_collapsed: bool,
        is_starred: bool,
        completed_at: Option<String>,
        is_readonly: Option<i64>,
        plugin_state: Option<String>,
        plugin_meta: Option<String>,
    }

    fn assert_reset_seed_roles(connection: &Connection) {
        let rows = connection
            .prepare(
                "SELECT id, parent_id, sort_key, title, note, is_collapsed, is_starred, \
                        completed_at, is_readonly, plugin_state, plugin_meta \
                 FROM notes_nodes ORDER BY id",
            )
            .expect("prepare reset seed roles")
            .query_map([], |row| {
                Ok(ResetSeedRow {
                    id: row.get(0)?,
                    parent_id: row.get(1)?,
                    sort_key: row.get(2)?,
                    title: row.get(3)?,
                    note: row.get(4)?,
                    is_collapsed: row.get::<_, i64>(5)? != 0,
                    is_starred: row.get::<_, i64>(6)? != 0,
                    completed_at: row.get(7)?,
                    is_readonly: row.get(8)?,
                    plugin_state: row.get(9)?,
                    plugin_meta: row.get(10)?,
                })
            })
            .expect("query reset seed roles")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect reset seed roles");
        assert_eq!(rows.len(), 8);

        let github_root = rows
            .iter()
            .find(|row| row.id == crate::notes::github_notifications::GITHUB_NOTIFICATIONS_ROOT_ID)
            .expect("canonical GitHub Notifications seed");
        assert!(github_root.parent_id.is_none());
        assert_eq!(github_root.title, "Github Notifications");
        assert!(github_root.note.is_empty());
        assert!(!github_root.is_collapsed);
        assert!(!github_root.is_starred);
        assert!(github_root.completed_at.is_none());
        assert_eq!(github_root.is_readonly, None);
        assert_eq!(github_root.plugin_state.as_deref(), Some("[]"));
        assert_eq!(github_root.plugin_meta, None);

        let ordinary = rows
            .iter()
            .filter(|row| {
                row.id != crate::notes::github_notifications::GITHUB_NOTIFICATIONS_ROOT_ID
            })
            .collect::<Vec<_>>();
        assert_eq!(ordinary.len(), 7);
        assert!(ordinary.iter().all(|row| {
            row.is_readonly == Some(0) && row.plugin_state.is_none() && row.plugin_meta.is_none()
        }));
        let onboarding_roots = ordinary
            .iter()
            .copied()
            .filter(|row| row.parent_id.is_none())
            .collect::<Vec<_>>();
        assert_eq!(onboarding_roots.len(), 1);
        let onboarding_root = onboarding_roots[0];
        assert_eq!(onboarding_root.title, "Yonalist 시작하기");
        assert_eq!(
            onboarding_root.note,
            "이 노트는 자유롭게 수정하거나 삭제할 수 있어요."
        );
        assert!(!onboarding_root.is_collapsed);
        assert!(!onboarding_root.is_starred);
        assert!(onboarding_root.completed_at.is_none());
        let mut onboarding_children = ordinary
            .iter()
            .copied()
            .filter(|row| row.parent_id.as_deref() == Some(onboarding_root.id.as_str()))
            .collect::<Vec<_>>();
        onboarding_children.sort_by_key(|row| row.sort_key);
        assert_eq!(onboarding_children.len(), 6);
        assert!(onboarding_children.iter().all(|row| row.note.is_empty()));
        assert_eq!(
            onboarding_children
                .iter()
                .map(|row| row.title.as_str())
                .collect::<Vec<_>>(),
            vec![
                "Enter — 새 항목 만들기",
                "Tab / Shift+Tab — 들여쓰기 / 내어쓰기",
                "Shift+Enter — 설명 입력하기",
                "⌘/Ctrl+Enter — 완료 표시",
                "↑/↓ — 항목 사이 이동",
                "불릿을 드래그해 순서와 계층 바꾸기",
            ]
        );
    }

    #[test]
    fn production_app_data_storage_supports_attachment_identity_io_and_reconciliation() {
        const CHILD_ENV: &str = "YONALIST_APP_LOCAL_ATTACHMENT_CHILD";
        const TEST_NAME: &str = "notes::attachments::tests::production_app_data_storage_supports_attachment_identity_io_and_reconciliation";

        if std::env::var_os(CHILD_ENV).is_some() {
            let sandbox = std::env::current_dir().expect("isolated child cwd");
            let notes_root = sandbox.join("app-data/notes");
            crate::NOTES_DATA_ROOT
                .set(notes_root.clone())
                .expect("set isolated production Notes root");
            let vault = sandbox.join("vault");
            fs::create_dir_all(&vault).expect("create vault");
            let vault_path = vault.to_string_lossy().into_owned();
            seed_node(&vault_path);
            let png = encoded_dimensions(ImageFormat::Png, 320, 200);
            let source_dir = tempfile::tempdir_in(&sandbox).expect("source temp dir");
            let source = write_source(&source_dir, "production.png", &png);

            let imported = notes_import_attachment(
                vault_path.clone(),
                import_input(ATTACHMENT_ID, source),
                None,
            )
            .expect("import through production app-local database");
            assert_eq!(
                imported.workspace.attachments_by_node_id[NODE_ID][0].id,
                ATTACHMENT_ID
            );
            let database_path = crate::notes::repository::notes_db_path(&vault_path);
            assert!(
                database_path.is_file(),
                "app-local database was not created"
            );
            assert!(
                !vault.join(".yonalist/notes.sqlite").exists(),
                "attachment flow created a vault-local database"
            );
            assert!(vault.join(".yonalist/notes-assets").is_dir());
            assert_eq!(
                notes_read_attachment_bytes(vault_path.clone(), ATTACHMENT_ID.to_string())
                    .expect("read download bytes from app-local metadata"),
                png
            );
            let download_path = sandbox.join("downloaded.png");
            notes_download_attachment(
                vault_path.clone(),
                ATTACHMENT_ID.to_string(),
                download_path.to_string_lossy().into_owned(),
            )
            .expect("download attachment through app-local database");
            assert_eq!(
                fs::read(&download_path).expect("read downloaded attachment"),
                png
            );

            let export_path = sandbox.join("manual-export.md");
            notes_export_markdown(
                vault_path.clone(),
                NODE_ID.to_string(),
                export_path.to_string_lossy().into_owned(),
                false,
            )
            .expect("export attachment through app-local database");
            assert!(export_path.is_file());

            let manual_source = sandbox.join("manual-import.md");
            let prepared = crate::notes::export::prepare_markdown_export(
                &NotesExportSnapshot {
                    root_node_id: "44444444-4444-4444-8444-444444444444".to_string(),
                    title: "Manual root".to_string(),
                    exported_at: "2026-07-21T00:00:00.000Z".to_string(),
                    root: ExportNode {
                        marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                        id: "44444444-4444-4444-8444-444444444444".to_string(),
                        node_kind: NoteNodeKind::Text,
                        title: "Manual root".to_string(),
                        note: String::new(),
                        image_offset_utf16: 0,
                        title_date_spans: Vec::new(),
                        note_date_spans: Vec::new(),
                        completed: false,
                        attachments: Vec::new(),
                        children: vec![ExportNode {
                            marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                            id: "55555555-5555-4555-8555-555555555555".to_string(),
                            node_kind: NoteNodeKind::Image,
                            title: "Manual image".to_string(),
                            note: String::new(),
                            image_offset_utf16: 0,
                            title_date_spans: Vec::new(),
                            note_date_spans: Vec::new(),
                            completed: false,
                            attachments: vec![ExportAttachment {
                                id: "66666666-6666-4666-8666-666666666666".to_string(),
                                relative_path: "notes-assets/manual-source.png".to_string(),
                                content_hash: super::sha256_hex(&png),
                                original_name: "manual-source.png".to_string(),
                                mime_type: "image/png".to_string(),
                                byte_size: i64::try_from(png.len()).expect("PNG byte size"),
                                intrinsic_width: 320,
                                intrinsic_height: 200,
                                display_width: 320,
                                bytes: Some(std::sync::Arc::<[u8]>::from(png.clone())),
                            }],
                            children: Vec::new(),
                        }],
                    },
                },
                "manual-assets",
            )
            .expect("prepare canonical manual import fixture");
            fs::write(&manual_source, prepared.markdown).expect("write manual import Markdown");
            let manual_assets = sandbox.join("manual-assets");
            fs::create_dir(&manual_assets).expect("create manual import assets");
            fs::write(manual_assets.join("0001.png"), &png)
                .expect("write manual import attachment");
            let import_vault = sandbox.join("import-vault");
            fs::create_dir(&import_vault).expect("create manual import vault");
            let import_vault_path = import_vault.to_string_lossy().into_owned();
            notes_initialize(import_vault_path.clone()).expect("initialize manual import vault");
            let manual_import = notes_import_markdown(
                import_vault_path.clone(),
                ImportNotesMarkdownInput {
                    source_path: manual_source.to_string_lossy().into_owned(),
                    parent_id: None,
                    after_id: None,
                },
                history_context(1, "importMarkdown"),
            )
            .expect("manual import with attachment through app-local database");
            assert!(manual_import
                .workspace
                .attachments_by_node_id
                .values()
                .flatten()
                .any(|attachment| attachment.original_name == "manual-source.png"));
            assert!(crate::notes::repository::notes_db_path(&import_vault_path).is_file());
            assert!(!import_vault.join(".yonalist/notes.sqlite").exists());

            let storage = AttachmentStorageLease::acquire(&vault_path)
                .expect("acquire production attachment storage");
            let connection = connect_notes_db(&vault_path).expect("open app-local database");
            let identity = storage
                .capture_database_identity(&connection)
                .expect("capture app-local database identity");
            let export_snapshot = load_export_snapshot(&connection, NODE_ID)
                .expect("load attachment export snapshot");
            assert_eq!(
                storage
                    .read_validated_export_attachment_bytes(&export_snapshot.root.attachments[0])
                    .expect("read export bytes from app-local metadata"),
                png
            );

            let orphan_name = format!("{}.png", "f".repeat(64));
            let orphan_path = vault.join(".yonalist/notes-assets").join(&orphan_name);
            fs::write(&orphan_path, &png).expect("write reconciliation orphan");
            assert_eq!(
                storage
                    .reconcile_attachment_files(&connection)
                    .expect("reconcile against app-local database"),
                1
            );
            assert!(!orphan_path.exists());
            storage
                .validate_identity(&identity)
                .expect("stable app-local database identity");

            let keyed_directory = database_path.parent().expect("keyed database directory");
            let displaced = notes_root.join("displaced-key-directory");
            fs::rename(keyed_directory, &displaced).expect("displace keyed directory");
            fs::create_dir(keyed_directory).expect("replace keyed directory");
            let error = storage
                .validate_identity(&identity)
                .expect_err("replaced app-local directory identity must be rejected");
            assert!(error.to_lowercase().contains("identity"), "{error}");
            return;
        }

        let isolated = tempfile::tempdir().expect("isolated app-local attachment cwd");
        let output = std::process::Command::new(std::env::current_exe().expect("current test exe"))
            .arg(TEST_NAME)
            .arg("--exact")
            .arg("--nocapture")
            .env(CHILD_ENV, "1")
            .current_dir(isolated.path())
            .output()
            .expect("run isolated app-local attachment regression");
        assert!(
            output.status.success(),
            "isolated app-local attachment regression failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }

    #[test]
    fn notes_attachment_noreplace_abstraction_does_not_overwrite_destination() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let source = Path::new("source");
        let destination = Path::new("destination");
        fs::write(temp_dir.path().join(source), b"source bytes").expect("source");
        fs::write(temp_dir.path().join(destination), b"destination bytes").expect("destination");
        let directory =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("capability directory");

        let error = rename_noreplace(&directory, source, &directory, destination)
            .expect_err("occupied destination must not be replaced");

        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(
            fs::read(temp_dir.path().join(source)).expect("source remains"),
            b"source bytes"
        );
        assert_eq!(
            fs::read(temp_dir.path().join(destination)).expect("destination remains"),
            b"destination bytes"
        );

        fs::remove_file(temp_dir.path().join(destination)).expect("remove destination");
        rename_noreplace(&directory, source, &directory, destination)
            .expect("vacant destination accepts source");
        assert!(!temp_dir.path().join(source).exists());
        assert_eq!(
            fs::read(temp_dir.path().join(destination)).expect("moved source"),
            b"source bytes"
        );
    }

    #[test]
    fn attachment_lock_and_storage_reject_blank_vault_without_side_effects() {
        const CHILD_ENV: &str = "YONALIST_BLANK_ATTACHMENT_STORAGE_CHILD";
        const TEST_NAME: &str =
            "notes::attachments::tests::attachment_lock_and_storage_reject_blank_vault_without_side_effects";

        if std::env::var_os(CHILD_ENV).is_some() {
            let cwd = std::env::current_dir().expect("isolated child cwd");
            let whitespace_vault = cwd.join(" \t ");

            for vault_path in ["", " \t "] {
                let lock_error = match super::acquire_vault_app_lock_file(vault_path) {
                    Ok(lock) => {
                        drop(lock);
                        None
                    }
                    Err(error) => Some(error),
                };
                let storage_error = match AttachmentStorageLease::acquire(vault_path) {
                    Ok(storage) => {
                        drop(storage);
                        None
                    }
                    Err(error) => Some(error),
                };

                assert_eq!(lock_error.as_deref(), Some("Vault path must not be empty."));
                assert_eq!(
                    storage_error.as_deref(),
                    Some("Vault path must not be empty.")
                );
            }

            assert!(!cwd.join(".yonalist").exists());
            assert!(!whitespace_vault.exists());
            return;
        }

        let isolated = tempfile::tempdir().expect("isolated child cwd");
        let output = std::process::Command::new(std::env::current_exe().expect("current test exe"))
            .arg(TEST_NAME)
            .arg("--exact")
            .arg("--nocapture")
            .env(CHILD_ENV, "1")
            .current_dir(isolated.path())
            .output()
            .expect("run isolated attachment storage regression");
        assert!(
            output.status.success(),
            "isolated attachment storage regression failed (created cwd metadata: {}, created whitespace vault: {}):\nstdout:\n{}\nstderr:\n{}",
            isolated.path().join(".yonalist").exists(),
            isolated.path().join(" \t ").exists(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        assert!(!isolated.path().join(".yonalist").exists());
        assert!(!isolated.path().join(" \t ").exists());
    }

    fn history_context(index: usize, command_kind: &str) -> NotesHistoryContext {
        NotesHistoryContext {
            session_id: SESSION_ID.to_string(),
            history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
            entry_id: format!("00000000-0000-4000-8000-{index:012x}"),
            command_kind: command_kind.to_string(),
        }
    }

    fn write_source(temp_dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> String {
        let path = temp_dir.path().join(name);
        fs::write(&path, bytes).expect("write source");
        path.to_string_lossy().into_owned()
    }

    fn asset_file_with_bytes(asset_root: &Path, expected: &[u8]) -> Option<std::path::PathBuf> {
        fs::read_dir(asset_root)
            .ok()?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| fs::read(path).is_ok_and(|bytes| bytes == expected))
    }

    fn expect_source_preparation_error(source_path: &str, expectation: &str) -> String {
        match prepare_source_attachment(source_path) {
            Ok(batch) => {
                drop(batch);
                panic!("{expectation}");
            }
            Err(error) => error,
        }
    }

    fn import_input(id: &str, source_path: String) -> ImportAttachmentInput {
        ImportAttachmentInput {
            request_id: None,
            id: id.to_string(),
            node_id: NODE_ID.to_string(),
            source_path,
            initial_max_display_width: 10_000,
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
    fn sha256_hashes_attachment_bytes_as_lowercase_hex() {
        assert_eq!(
            sha256_hex(b"yonalist"),
            "5cd15991da55063f883628051a44e9d5db87c7c70339800606a14f4e92d22d4d"
        );
    }

    #[test]
    fn notes_attachment_validation_accepts_gif_and_webp_animation_but_rejects_apng() {
        for (name, bytes, mime_type) in [
            ("animated.gif", encoded_gif_frames(2), "image/gif"),
            ("animated.webp", encoded_animated_webp(), "image/webp"),
        ] {
            let validated =
                validate_image_bytes(Path::new(name), &bytes, ValidationLimits::DEFAULT)
                    .unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(validated.mime_type, mime_type);
            assert_eq!((validated.width, validated.height), (2, 3));
        }

        let apng = encoded_apng_frames(2);
        let error =
            validate_image_bytes(Path::new("animated.png"), &apng, ValidationLimits::DEFAULT)
                .expect_err("APNG animation must be rejected");
        assert!(error.to_lowercase().contains("animat"), "{error}");
    }

    #[test]
    fn notes_attachment_animation_import_returns_original_browser_bytes() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault = vault_path(&temp_dir);
        seed_node(&vault);

        for (id, name, bytes) in [
            (ATTACHMENT_ID, "animated.gif", encoded_gif_frames(2)),
            (
                SECOND_ATTACHMENT_ID,
                "animated.webp",
                encoded_animated_webp(),
            ),
        ] {
            let source_path = write_source(&temp_dir, name, &bytes);
            notes_import_attachment(vault.clone(), import_input(id, source_path), None)
                .unwrap_or_else(|error| panic!("import {name}: {error}"));

            assert_eq!(
                notes_read_attachment_bytes(vault.clone(), id.to_string())
                    .unwrap_or_else(|error| panic!("read {name}: {error}")),
                bytes
            );
        }
    }

    #[test]
    fn notes_attachment_animation_enforces_frame_and_aggregate_pixel_caps() {
        for (name, bytes) in [
            ("too-many.gif", encoded_gif_frames(2)),
            ("too-many.webp", encoded_animated_webp()),
        ] {
            let frame_error = validate_image_bytes(
                Path::new(name),
                &bytes,
                ValidationLimits {
                    max_frames: 1,
                    ..ValidationLimits::DEFAULT
                },
            )
            .expect_err("frame ceiling must fail");
            assert_eq!(
                frame_error,
                "Animated Notes attachment images must contain at most 1 frame."
            );

            let work_error = validate_image_bytes(
                Path::new(name),
                &bytes,
                ValidationLimits {
                    max_decoded_pixel_work: 11,
                    ..ValidationLimits::DEFAULT
                },
            )
            .expect_err("aggregate decoded-pixel ceiling must fail");
            assert_eq!(
                work_error,
                "Animated Notes attachment images must require at most 11 aggregate decoded pixels."
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_source_open_rejects_symlinks_and_fifos_without_blocking() {
        use std::os::unix::fs::symlink;
        use std::process::Command;
        use std::time::{Duration, Instant};

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let png_path = write_source(&temp_dir, "source.png", &encoded(ImageFormat::Png));
        let symlink_path = temp_dir.path().join("source-link.png");
        symlink(&png_path, &symlink_path).expect("source symlink");
        assert!(
            prepare_source_attachment_without_budget(
                &symlink_path.to_string_lossy(),
                MAX_ATTACHMENT_BATCH_BYTES,
            )
            .is_err(),
            "source import followed a symlink"
        );

        let fifo_path = temp_dir.path().join("source-fifo.png");
        let status = Command::new("mkfifo")
            .arg(&fifo_path)
            .status()
            .expect("run mkfifo");
        assert!(status.success(), "mkfifo failed");
        let started = Instant::now();
        assert!(prepare_source_attachment_without_budget(
            &fifo_path.to_string_lossy(),
            MAX_ATTACHMENT_BATCH_BYTES,
        )
        .is_err());
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "FIFO source open blocked"
        );
    }

    #[test]
    fn notes_attachment_source_path_rejects_png_named_jpeg() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let source = write_source(&temp_dir, "spoofed.jpg", &encoded(ImageFormat::Png));

        let error = expect_source_preparation_error(
            &source,
            "path import must validate the source extension",
        );

        assert!(error.to_lowercase().contains("extension"), "{error}");
    }

    #[test]
    fn notes_attachment_source_path_rejects_png_named_svg() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let source = write_source(&temp_dir, "spoofed.svg", &encoded(ImageFormat::Png));

        let error = expect_source_preparation_error(
            &source,
            "path import must keep SVG source names rejected",
        );

        assert!(error.to_lowercase().contains("svg"), "{error}");
    }

    #[test]
    fn notes_attachment_path_batch_never_exposes_a_componentless_source_path() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let private_path = temp_dir.path().join("private").join("..");
        let private_path = private_path.to_string_lossy().into_owned();

        let error = PreparedAttachmentBatch::from_source_paths(&[private_path.as_str()])
            .expect_err("componentless source path");

        assert!(!error.contains(&private_path), "{error}");
        assert!(error.contains("unknown image"), "{error}");
    }

    #[test]
    fn notes_attachment_source_read_rejects_growth_past_remaining_batch_budget() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let png = encoded(ImageFormat::Png);
        let source = write_source(&temp_dir, "growing.png", &png);
        let remaining_batch_bytes = u64::try_from(png.len()).expect("remaining batch bytes");
        inject_source_growth(vec![0xff]);

        let error = prepare_source_attachment_without_budget(&source, remaining_batch_bytes)
            .expect_err("source growth must not exceed the remaining batch budget");

        assert_eq!(
            error,
            format!("Notes attachment images must contain at most {remaining_batch_bytes} bytes.")
        );
        assert_eq!(
            fs::metadata(&source).expect("grown source metadata").len(),
            remaining_batch_bytes + 1
        );
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

        for (name, bytes) in [
            ("truncated.gif", encoded(ImageFormat::Gif)),
            ("truncated.webp", encoded(ImageFormat::WebP)),
            ("truncated.png", encoded(ImageFormat::Png)),
        ] {
            let truncated = &bytes[..bytes.len().saturating_sub(5)];
            assert!(
                validate_image_bytes(Path::new(name), truncated, ValidationLimits::DEFAULT)
                    .is_err(),
                "accepted {name}"
            );
        }

        for (name, bytes) in [
            ("truncated-animated.gif", encoded_gif_frames(2)),
            ("truncated-animated.webp", encoded_animated_webp()),
            ("truncated-animated.png", encoded_apng_frames(2)),
        ] {
            let truncated = &bytes[..bytes.len() / 2];
            assert!(
                validate_image_bytes(Path::new(name), truncated, ValidationLimits::DEFAULT)
                    .is_err(),
                "accepted {name}"
            );
        }
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
                ..ValidationLimits::DEFAULT
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
                ..ValidationLimits::DEFAULT
            },
        )
        .expect_err("pixel ceiling must fail");
        assert!(
            pixel_error.to_lowercase().contains("pixel"),
            "{pixel_error}"
        );

        for (name, bytes) in [
            ("container-limit.gif", encoded(ImageFormat::Gif)),
            ("container-limit.webp", encoded(ImageFormat::WebP)),
            ("container-limit.png", encoded(ImageFormat::Png)),
        ] {
            let error = validate_image_bytes(
                Path::new(name),
                &bytes,
                ValidationLimits {
                    max_container_chunks: 0,
                    ..ValidationLimits::DEFAULT
                },
            )
            .expect_err("container work ceiling must fail");
            assert!(
                error.to_lowercase().contains("container"),
                "{name}: {error}"
            );
        }
    }

    #[test]
    fn notes_attachment_default_pixel_ceiling_accepts_40m_and_rejects_40m_plus_one() {
        assert_eq!(
            validate_decoded_dimensions((8_000, 5_000), ValidationLimits::DEFAULT),
            Ok(40_000_000)
        );

        let error = validate_decoded_dimensions((40_000_001, 1), ValidationLimits::DEFAULT)
            .expect_err("40,000,001 decoded pixels must exceed the default ceiling");

        assert_eq!(
            error,
            "Notes attachment images must contain between 1 and 40000000 decoded pixels."
        );
    }

    #[test]
    fn notes_attachment_dimension_limit_rejects_zero_and_overflow() {
        for dimensions in [(0, 1), (1, 0)] {
            let error = validate_decoded_dimensions(dimensions, ValidationLimits::DEFAULT)
                .expect_err("zero dimensions must fail");
            assert_eq!(
                error,
                "Notes attachment images must contain between 1 and 40000000 decoded pixels."
            );
        }

        let error = validate_decoded_dimensions((u64::MAX, 2), ValidationLimits::DEFAULT)
            .expect_err("dimension multiplication overflow must fail");
        assert_eq!(
            error,
            "The Notes attachment decoded pixel count is too large."
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
    fn notes_attachment_import_budget_lives_until_prepared_bytes_are_released() {
        use std::sync::mpsc;
        use std::time::Duration;

        let first_dir = tempfile::tempdir().expect("first temp dir");
        let second_dir = tempfile::tempdir().expect("second temp dir");
        let first_vault = vault_path(&first_dir);
        let second_vault = vault_path(&second_dir);
        seed_node(&first_vault);
        seed_node(&second_vault);
        let first_source = write_source(
            &first_dir,
            "first-budget.png",
            &encoded_dimensions(ImageFormat::Png, 320, 200),
        );
        let second_source = write_source(
            &second_dir,
            "second-budget.png",
            &encoded_dimensions(ImageFormat::Png, 320, 200),
        );
        let first_storage = AttachmentStorageLease::acquire(&first_vault).expect("first lease");
        let first_prepared = first_storage
            .prepare_source_attachment(&first_source)
            .expect("first prepared bytes");

        let (second_prepared_tx, second_prepared_rx) = mpsc::channel();
        let second = std::thread::spawn(move || {
            let storage =
                AttachmentStorageLease::acquire(&second_vault).expect("second vault lease");
            let prepared = storage
                .prepare_source_attachment(&second_source)
                .expect("second prepared bytes");
            second_prepared_tx
                .send(prepared.attachments()[0].image.byte_size as usize)
                .expect("second prepared");
        });
        assert!(
            second_prepared_rx
                .recv_timeout(Duration::from_millis(100))
                .is_err(),
            "second vault multiplied the live import allocation"
        );

        drop(first_prepared);
        second_prepared_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("second import proceeds after first bytes drop");
        second.join().expect("second import thread");
    }

    #[test]
    fn notes_attachment_import_permit_is_sendable() {
        fn assert_send<T: Send>() {}
        fn assert_send_value<T: Send>(_value: T) {}

        assert_send::<super::AttachmentImportPermit>();
        assert_send_value(super::acquire_attachment_import_permit_async());
    }

    #[test]
    fn notes_attachment_storage_lease_covers_publication_through_metadata_commit() {
        use std::sync::mpsc;
        use std::time::Duration;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let source = write_source(
            &temp_dir,
            "interprocess.png",
            &encoded_dimensions(ImageFormat::Png, 320, 200),
        );
        let first = AttachmentStorageLease::acquire(&vault_path).expect("first storage lease");
        let prepared_batch = first
            .prepare_source_attachment(&source)
            .expect("prepare while leased");
        let prepared = &prepared_batch.attachments()[0];
        let mut connection = connect_notes_db(&vault_path).expect("metadata connection");
        let identity = first
            .capture_database_identity(&connection)
            .expect("stable storage identity");
        let (second_done_tx, second_done_rx) = mpsc::channel();
        let mut second_thread = None;
        let mut asset_path = None;
        create_attachment_coordinated(
            &mut connection,
            || {
                let relative_path =
                    first.publish_attachment_bytes_for_import(prepared, &identity)?;
                asset_path = Some(temp_dir.path().join(".yonalist").join(&relative_path));

                let sqlite_contender =
                    rusqlite::Connection::open(temp_dir.path().join(".yonalist/notes.sqlite"))
                        .expect("independent SQLite connection");
                sqlite_contender
                    .busy_timeout(Duration::from_millis(50))
                    .expect("short busy timeout");
                // Remediation 1.3 moved file publication *outside* the metadata
                // write transaction (file-before-commit) so the slow temp-write +
                // fsync + rename no longer holds the single SQLite writer slot.
                // This assertion previously required the write lock to be held
                // during publication; it now verifies the opposite — an
                // independent connection can take and release the writer slot
                // mid-publication, and the metadata commit runs afterward in its
                // own IMMEDIATE transaction. The vault storage lease (flock),
                // asserted just below, is what actually covers the whole
                // publication-through-commit window.
                sqlite_contender
                    .execute_batch("BEGIN IMMEDIATE; COMMIT")
                    .expect("publication must not hold the SQLite write lock");

                let second_vault = vault_path.clone();
                second_thread = Some(std::thread::spawn(move || {
                    let second_connection =
                        connect_notes_db(&second_vault).expect("independent connection");
                    let second = AttachmentStorageLease::acquire(&second_vault)
                        .expect("independent storage lease");
                    second
                        .reconcile_attachment_files(&second_connection)
                        .expect("reconcile after lock handoff");
                    second_done_tx.send(()).expect("second done");
                }));
                assert!(
                    second_done_rx
                        .recv_timeout(Duration::from_millis(100))
                        .is_err(),
                    "independent reconciliation entered before metadata commit"
                );

                Ok(crate::notes::repository::NewAttachment {
                    id: ATTACHMENT_ID.to_string(),
                    node_id: NODE_ID.to_string(),
                    relative_path,
                    content_hash: prepared.image.content_hash.clone(),
                    original_name: prepared.original_name.clone(),
                    mime_type: prepared.image.mime_type.to_string(),
                    byte_size: i64::try_from(prepared.image.byte_size).expect("byte size"),
                    intrinsic_width: i64::from(prepared.image.width),
                    intrinsic_height: i64::from(prepared.image.height),
                    display_width: i64::from(prepared.image.width),
                })
            },
            || first.validate_identity(&identity),
        )
        .expect("coordinated metadata commit");
        let asset_path = asset_path.expect("published asset path");
        drop(first);
        second_done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("second reconciles after release");
        second_thread
            .expect("second thread started")
            .join()
            .expect("second thread");
        assert!(
            asset_path.is_file(),
            "committed shared bytes were reconciled"
        );
    }

    #[test]
    fn notes_attachment_lease_acquire_gives_up_when_vault_busy_in_another_window() {
        use std::time::{Duration, Instant};

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        // Hold the vault lock (a stand-in for a second Yonalist window). flock is
        // per open-file-description, so a second acquire in this process opens a
        // fresh handle and genuinely contends for the exclusive lock.
        let held = AttachmentStorageLease::acquire(&vault_path).expect("first lease");

        let started = Instant::now();
        // `AttachmentStorageLease` is not `Debug`, so match rather than `expect_err`.
        let error = match AttachmentStorageLease::acquire_with_deadline(
            &vault_path,
            Duration::from_millis(200),
        ) {
            Ok(_) => panic!("second lease must give up while the first is held"),
            Err(error) => error,
        };
        let elapsed = started.elapsed();

        assert!(
            error.contains("busy in another window"),
            "unexpected lease error: {error}"
        );
        assert!(
            elapsed < Duration::from_secs(1),
            "bounded acquire blocked too long: {elapsed:?}"
        );
        drop(held);
    }

    #[test]
    fn notes_attachment_lease_acquire_succeeds_after_prior_lease_is_dropped() {
        use std::time::Duration;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);

        let first = AttachmentStorageLease::acquire(&vault_path).expect("first lease");
        drop(first);

        // Dropping the lease closes the lock file descriptor, releasing the flock,
        // so a fresh acquire succeeds well within the deadline.
        let _second =
            AttachmentStorageLease::acquire_with_deadline(&vault_path, Duration::from_millis(200))
                .expect("lease reacquired after release");
    }

    #[cfg(unix)]
    #[test]
    fn attachment_storage_rejects_metadata_relocation_after_app_lock_acquisition() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let attacker_dir = tempfile::tempdir().expect("attacker dir");
        let vault_path = vault_path(&temp_dir);
        let metadata_path = temp_dir.path().join(".yonalist");
        let held_metadata = temp_dir.path().join(".yonalist-held");
        let raced_metadata = metadata_path.clone();
        let raced_held = held_metadata.clone();
        let attacker_path = attacker_dir.path().to_path_buf();
        inject_attachment_storage_after_app_lock_once(move || {
            fs::rename(&raced_metadata, &raced_held).expect("relocate locked metadata");
            symlink(&attacker_path, &raced_metadata).expect("redirect metadata path");
        });

        let error = match AttachmentStorageLease::acquire(&vault_path) {
            Ok(_) => panic!("metadata relocation must invalidate attachment storage acquisition"),
            Err(error) => error,
        };

        assert!(
            error.contains("metadata directory identity changed"),
            "{error}"
        );
        assert!(!held_metadata.join(".notes-assets.lock").exists());
        assert!(!held_metadata.join("notes-assets").exists());
        assert!(!attacker_dir.path().join(".notes-assets.lock").exists());
        assert!(!attacker_dir.path().join("notes-assets").exists());
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_storage_detects_replaced_directory_identity_before_publication() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let external_dir = tempfile::tempdir().expect("external dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let source = write_source(
            &temp_dir,
            "identity.png",
            &encoded_dimensions(ImageFormat::Png, 320, 200),
        );
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");
        let prepared_batch = storage
            .prepare_source_attachment(&source)
            .expect("prepare source");
        let prepared = &prepared_batch.attachments()[0];
        let original_root = temp_dir.path().join(".yonalist/notes-assets");
        let renamed_root = temp_dir.path().join(".yonalist/notes-assets-held");
        fs::rename(&original_root, &renamed_root).expect("rename opened asset root");
        let external_name = format!("{}.png", "a".repeat(64));
        let external_sentinel = external_dir.path().join(&external_name);
        fs::write(&external_sentinel, b"external sentinel").expect("external sentinel");
        symlink(external_dir.path(), &original_root).expect("replace path with symlink");

        let error = storage
            .publish_attachment_bytes(prepared)
            .expect_err("replaced asset identity must abort publication");
        assert!(error.to_lowercase().contains("identity"), "{error}");
        assert_eq!(
            fs::read(&external_sentinel).expect("external sentinel remains"),
            b"external sentinel"
        );
        assert_eq!(
            fs::read_dir(&renamed_root).expect("held root").count(),
            0,
            "publication wrote through a stale directory handle"
        );
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_storage_detects_replaced_database_and_lock_identities() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let leased_vault = vault_path(&temp_dir);
        seed_node(&leased_vault);
        let storage = AttachmentStorageLease::acquire(&leased_vault).expect("storage lease");
        let connection = connect_notes_db(&leased_vault).expect("database connection");
        let unrelated_dir = tempfile::tempdir().expect("unrelated temp dir");
        let unrelated_vault = vault_path(&unrelated_dir);
        seed_node(&unrelated_vault);
        let unrelated_connection =
            connect_notes_db(&unrelated_vault).expect("unrelated database connection");
        let unrelated_error = storage
            .capture_database_identity(&unrelated_connection)
            .expect_err("identity capture must belong to the leased vault connection");
        assert!(
            unrelated_error.to_lowercase().contains("connection"),
            "{unrelated_error}"
        );
        let identity = storage
            .capture_database_identity(&connection)
            .expect("database identity");
        let database_path = temp_dir.path().join(".yonalist/notes.sqlite");
        let old_database_path = temp_dir.path().join(".yonalist/notes-old.sqlite");
        fs::rename(&database_path, &old_database_path).expect("rename open database");
        fs::copy(&old_database_path, &database_path).expect("replace database inode");
        let database_error = storage
            .validate_identity(&identity)
            .expect_err("replaced database identity must fail");
        assert!(
            database_error.to_lowercase().contains("identity"),
            "{database_error}"
        );

        let lock_path = temp_dir.path().join(".yonalist/.notes-assets.lock");
        let old_lock_path = temp_dir.path().join(".yonalist/.notes-assets-old.lock");
        fs::rename(&lock_path, &old_lock_path).expect("rename held lock");
        fs::write(&lock_path, b"replacement lock").expect("replace lock inode");
        let lock_error = storage
            .validate_core_identity()
            .expect_err("replaced lock identity must fail");
        assert!(
            lock_error.to_lowercase().contains("identity"),
            "{lock_error}"
        );
    }

    #[test]
    fn notes_attachment_storage_detects_changed_vault_generation_on_the_same_database_file() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let leased_vault = vault_path(&temp_dir);
        seed_node(&leased_vault);
        let storage = AttachmentStorageLease::acquire(&leased_vault).expect("storage lease");
        let connection = connect_notes_db(&leased_vault).expect("database connection");
        let identity = storage
            .capture_database_identity(&connection)
            .expect("database identity");
        let replacement_generation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        assert_eq!(
            connection
                .execute(
                    "UPDATE notes_metadata SET vault_generation = ?1 WHERE id = 1",
                    [replacement_generation],
                )
                .expect("replace generation"),
            1
        );

        let error = storage
            .validate_identity(&identity)
            .expect_err("changed vault generation must fail");

        assert!(error.to_lowercase().contains("identity"), "{error}");
    }

    #[test]
    fn notes_attachment_database_delete_removes_only_verified_regular_owned_files() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let source = write_source(
            &temp_dir,
            "delete.png",
            &encoded_dimensions(ImageFormat::Png, 320, 200),
        );
        notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import before database delete");

        let outcome =
            notes_delete_database(vault_path.clone()).expect("delete database and regular assets");

        assert!(
            temp_dir.path().join(".yonalist/notes.sqlite").is_file(),
            "delete-all must rebuild the Notes database"
        );
        let connection = connect_notes_db(&vault_path).expect("open rebuilt database");
        assert_reset_seed_roles(&connection);
        assert_eq!(
            serde_json::to_value(outcome).unwrap(),
            serde_json::json!({ "attachmentCleanupFailed": false })
        );
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        assert!(
            asset_root.exists(),
            "runtime must retain operation tombstones"
        );
        assert!(
            fs::read_dir(asset_root)
                .expect("retained operation directory")
                .filter_map(Result::ok)
                .all(
                    |entry| crate::notes::sync::asset_gc::is_private_asset_operation_name(
                        Path::new(&entry.file_name())
                    )
                ),
            "database deletion left a canonical asset"
        );
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_delete_all_reclaims_private_operation_payloads() {
        use std::os::unix::fs::PermissionsExt;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        fs::create_dir(&asset_root).expect("asset root");
        let operation = asset_root.join(format!(".asset-gc-staging-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&operation).expect("private operation directory");
        fs::set_permissions(&operation, fs::Permissions::from_mode(0o700))
            .expect("owner-private operation directory");
        let payload = operation.join("payload");
        fs::write(&payload, b"hidden staged attachment bytes").expect("full staged payload");

        AttachmentStorageLease::acquire(&vault_path)
            .expect("storage lease")
            .delete_attachment_files()
            .expect("delete all attachment files");

        assert_eq!(
            fs::metadata(payload)
                .expect("staged payload tombstone")
                .len(),
            0,
            "delete-all must not retain hidden staged payload bytes"
        );
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_database_delete_never_recurses_into_unverified_entries() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let external_dir = tempfile::tempdir().expect("external dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        fs::create_dir(&asset_root).expect("asset root");
        let nested = asset_root.join("nested");
        fs::create_dir(&nested).expect("nested directory");
        let external_sentinel = external_dir.path().join("sentinel");
        fs::write(&external_sentinel, b"external").expect("external sentinel");
        symlink(external_dir.path(), asset_root.join("linked-directory"))
            .expect("linked directory");

        notes_delete_database(vault_path.clone())
            .expect("database commit is not masked by conservative asset cleanup");

        assert!(
            temp_dir.path().join(".yonalist/notes.sqlite").is_file(),
            "delete-all must rebuild the Notes database"
        );
        let connection = connect_notes_db(&vault_path).expect("open rebuilt database");
        assert_reset_seed_roles(&connection);
        assert!(nested.is_dir(), "nested directory was recursively removed");
        assert_eq!(
            fs::read(&external_sentinel).expect("external sentinel remains"),
            b"external"
        );
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("cleanup marker");
        assert!(storage.reconciliation_needed().expect("marker state"));
    }

    #[test]
    fn notes_attachment_committed_cleanup_failures_return_success_and_reconcile_later() {
        for point in [
            CleanupFailurePoint::Reconcile,
            CleanupFailurePoint::Remove,
            CleanupFailurePoint::Sync,
        ] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let vault_path = vault_path(&temp_dir);
            seed_node(&vault_path);
            let source = write_source(
                &temp_dir,
                "cleanup.png",
                &encoded_dimensions(ImageFormat::Png, 320, 200),
            );
            let imported = notes_import_attachment(
                vault_path.clone(),
                import_input(ATTACHMENT_ID, source),
                Some(history_context(1, "importAttachment")),
            )
            .expect("journaled import");
            let asset_path = temp_dir
                .path()
                .join(".yonalist")
                .join(&imported.workspace.attachments_by_node_id[NODE_ID][0].relative_path);
            notes_remove_attachment(vault_path.clone(), ATTACHMENT_ID.to_string(), None)
                .expect("remove live metadata while history retains bytes");

            inject_cleanup_failure(point);
            notes_clear_history(vault_path.clone(), SESSION_ID.to_string()).unwrap_or_else(
                |error| panic!("{point:?} cleanup masked committed clear: {error}"),
            );

            let storage = AttachmentStorageLease::acquire(&vault_path).expect("inspect marker");
            assert!(
                storage.reconciliation_needed().expect("marker state"),
                "{point:?} cleanup failure was not recorded"
            );
            drop(storage);
            if point == CleanupFailurePoint::Remove {
                assert!(
                    asset_path.exists(),
                    "failed removal left the attachment only under its quarantine name"
                );
            }
            notes_initialize(vault_path.clone()).expect("later startup reconciliation");
            assert!(!asset_path.exists(), "{point:?} orphan survived startup");
            let storage = AttachmentStorageLease::acquire(&vault_path).expect("marker cleared");
            assert!(!storage.reconciliation_needed().expect("marker state"));
        }
    }

    #[test]
    fn notes_attachment_import_and_empty_trash_cleanup_failures_do_not_mask_commits() {
        for point in [
            CleanupFailurePoint::Reconcile,
            CleanupFailurePoint::Remove,
            CleanupFailurePoint::Sync,
        ] {
            let import_dir = tempfile::tempdir().expect("import temp dir");
            let import_vault = vault_path(&import_dir);
            seed_node(&import_vault);
            let asset_root = import_dir.path().join(".yonalist/notes-assets");
            fs::create_dir(&asset_root).expect("asset root");
            let orphan = asset_root.join(format!("{}.png", "a".repeat(64)));
            fs::write(&orphan, b"orphan").expect("orphan asset");
            let source = write_source(
                &import_dir,
                "import-cleanup.png",
                &encoded_dimensions(ImageFormat::Png, 320, 200),
            );
            inject_cleanup_failure(point);
            let imported = notes_import_attachment(
                import_vault.clone(),
                import_input(ATTACHMENT_ID, source),
                None,
            )
            .unwrap_or_else(|error| {
                panic!("{point:?} post-commit cleanup masked committed import: {error}")
            });
            assert_eq!(imported.workspace.attachments_by_node_id[NODE_ID].len(), 1);
            let storage = AttachmentStorageLease::acquire(&import_vault).expect("import marker");
            assert!(
                storage.reconciliation_needed().expect("marker state"),
                "{point:?} import cleanup failure was not recorded"
            );
            drop(storage);
            if point == CleanupFailurePoint::Sync {
                inject_cleanup_failure(CleanupFailurePoint::Sync);
                notes_initialize(import_vault.clone())
                    .expect("startup sync retry must not mask committed expiry");
                let storage = AttachmentStorageLease::acquire(&import_vault).expect("retry marker");
                assert!(
                    storage.reconciliation_needed().expect("retry marker state"),
                    "startup cleared the marker without retrying the failed directory sync"
                );
                drop(storage);
            }
            notes_initialize(import_vault.clone()).expect("import startup reconciliation");
            assert!(!orphan.exists(), "{point:?} orphan survived startup");
            assert!(notes_read_attachment_bytes(import_vault, ATTACHMENT_ID.to_string()).is_ok());
        }

        let trash_dir = tempfile::tempdir().expect("trash temp dir");
        let trash_vault = vault_path(&trash_dir);
        seed_node(&trash_vault);
        let source = write_source(
            &trash_dir,
            "trash-cleanup.png",
            &encoded_dimensions(ImageFormat::Png, 320, 200),
        );
        let imported = notes_import_attachment(
            trash_vault.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("trash import");
        let asset_path = trash_dir
            .path()
            .join(".yonalist")
            .join(&imported.workspace.attachments_by_node_id[NODE_ID][0].relative_path);
        let mut connection = connect_notes_db(&trash_vault).expect("trash connection");
        soft_delete_node(&mut connection, NODE_ID).expect("trash node");
        drop(connection);
        inject_cleanup_failure(CleanupFailurePoint::Reconcile);
        let workspace = notes_empty_trash(trash_vault.clone())
            .expect("committed Empty Trash must succeed despite cleanup failure");
        assert!(workspace.nodes.is_empty());
        notes_initialize(trash_vault).expect("trash startup reconciliation");
        assert!(!asset_path.exists());
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

    #[cfg(unix)]
    #[test]
    fn notes_attachment_full_reconciliation_restores_a_reference_added_after_its_snapshot() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "referenced-race.png", &png);
        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import race fixture");
        let attachment = imported.workspace.attachments_by_node_id[NODE_ID][0].clone();
        let asset_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&attachment.relative_path);
        let connection = connect_notes_db(&vault_path).expect("race connection");
        let placeholder_hash = "a".repeat(64);
        let placeholder_path = format!("notes-assets/{placeholder_hash}.png");
        connection
            .execute(
                "UPDATE notes_attachments SET relative_path = ?1, content_hash = ?2 WHERE id = ?3",
                params![placeholder_path, placeholder_hash, ATTACHMENT_ID],
            )
            .expect("make owned bytes initially unreachable");
        let referenced_path = attachment.relative_path.clone();
        let referenced_hash = attachment.content_hash.clone();
        inject_full_reconciliation_after_snapshot_once(move |connection| {
            connection
                .execute(
                    "UPDATE notes_attachments SET relative_path = ?1, content_hash = ?2 WHERE id = ?3",
                    params![referenced_path, referenced_hash, ATTACHMENT_ID],
                )
                .expect("restore reference after reconciliation snapshot");
        });
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");

        let removed = storage
            .reconcile_attachment_files(&connection)
            .expect("race-safe reconciliation");

        assert_eq!(removed, 0);
        assert_eq!(fs::read(asset_path).expect("referenced bytes survive"), png);
        assert_eq!(
            connection
                .query_row(
                    "SELECT relative_path FROM notes_attachments WHERE id = ?1",
                    [ATTACHMENT_ID],
                    |row| row.get::<_, String>(0),
                )
                .expect("current attachment path"),
            attachment.relative_path
        );
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_full_reconciliation_opens_a_swapped_fifo_nonblocking() {
        use std::os::unix::fs::{FileTypeExt, OpenOptionsExt as _};
        use std::process::Command;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "fifo-race.png", &png);
        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import FIFO race fixture");
        let asset_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&imported.workspace.attachments_by_node_id[NODE_ID][0].relative_path);
        let connection = connect_notes_db(&vault_path).expect("race connection");
        connection
            .execute(
                "DELETE FROM notes_attachments WHERE id = ?1",
                [ATTACHMENT_ID],
            )
            .expect("make owned bytes unreachable");

        let fifo_path = temp_dir.path().join("reconciliation-race-fifo");
        let status = Command::new("mkfifo")
            .arg(&fifo_path)
            .status()
            .expect("run mkfifo");
        assert!(status.success(), "mkfifo failed");
        let _fifo_guard = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32)
            .open(&fifo_path)
            .expect("open FIFO guard without blocking");
        let displaced_path = temp_dir.path().join("displaced-fifo-race-attachment");
        let raced_asset_path = asset_path.clone();
        inject_full_reconciliation_after_snapshot_once(move |_| {
            fs::rename(&raced_asset_path, &displaced_path).expect("displace regular candidate");
            fs::rename(&fifo_path, &raced_asset_path).expect("swap candidate for FIFO");
        });
        inject_held_file_after_open_once(|file| {
            let flags = rustix::fs::fcntl_getfl(file).expect("inspect held file flags");
            assert!(
                flags.contains(rustix::fs::OFlags::NONBLOCK),
                "reconciliation opened the FIFO without O_NONBLOCK"
            );
        });
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");

        let error = storage
            .reconcile_attachment_files(&connection)
            .expect_err("swapped FIFO must fail closed");

        assert!(error.contains("regular file"), "{error}");
        assert_eq!(
            fs::read(temp_dir.path().join("displaced-fifo-race-attachment"))
                .expect("displaced regular file survives"),
            png
        );
        assert!(
            fs::symlink_metadata(&asset_path)
                .expect("restored FIFO metadata")
                .file_type()
                .is_fifo(),
            "swapped FIFO was not preserved"
        );
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_full_reconciliation_preserves_a_file_replaced_after_its_snapshot() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "replacement-race.png", &png);
        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import race fixture");
        let asset_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&imported.workspace.attachments_by_node_id[NODE_ID][0].relative_path);
        let connection = connect_notes_db(&vault_path).expect("race connection");
        connection
            .execute(
                "DELETE FROM notes_attachments WHERE id = ?1",
                [ATTACHMENT_ID],
            )
            .expect("make owned bytes unreachable");
        fs::remove_file(&asset_path).expect("remove imported inode");
        fs::write(&asset_path, b"stale bytes").expect("install stale inode");
        let displaced_path = temp_dir.path().join("displaced-stale-attachment");
        let raced_asset_path = asset_path.clone();
        let replacement = png.clone();
        inject_full_reconciliation_after_snapshot_once(move |_| {
            fs::rename(&raced_asset_path, displaced_path).expect("displace stale inode");
            fs::write(&raced_asset_path, replacement).expect("publish replacement inode");
        });
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");

        let removed = storage
            .reconcile_attachment_files(&connection)
            .expect("race-safe reconciliation");

        assert_eq!(removed, 0);
        assert_eq!(fs::read(asset_path).expect("replacement survives"), png);
    }

    #[test]
    fn notes_attachment_quarantine_never_restores_a_post_move_path_replacement() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");
        let original = encoded_dimensions(ImageFormat::Png, 320, 200);
        let hash = sha256_hex(&original);
        let canonical_name = PathBuf::from(format!("{hash}.png"));
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        let canonical = asset_root.join(&canonical_name);
        let displaced = temp_dir.path().join("displaced-pre-snapshot-original.png");
        let replacement = vec![0xa5; original.len()];
        fs::write(&canonical, &original).expect("canonical original");
        let expected_identity = storage
            .open_held_file(&canonical_name)
            .expect("hold canonical original")
            .identity;
        let quarantined_name = Arc::new(Mutex::new(None));
        let captured_name = Arc::clone(&quarantined_name);
        let asset_root_for_hook = asset_root.clone();
        let displaced_for_hook = displaced.clone();
        let replacement_for_hook = replacement.clone();
        inject_quarantine_after_move_once(move |relative_path| {
            fs::rename(asset_root_for_hook.join(relative_path), &displaced_for_hook)
                .expect("displace exact moved original");
            fs::write(
                asset_root_for_hook.join(relative_path),
                &replacement_for_hook,
            )
            .expect("install quarantine path replacement");
            *captured_name.lock().expect("capture quarantine name") =
                Some(relative_path.to_path_buf());
        });

        let result =
            storage.quarantine_reconciliation_candidate(&canonical_name, expected_identity);

        assert!(
            result.is_err(),
            "quarantine replacement was treated as restored"
        );
        assert!(
            !canonical.exists(),
            "quarantine pathname replacement was promoted to canonical"
        );
        let quarantined_name = quarantined_name
            .lock()
            .expect("quarantine name")
            .clone()
            .expect("quarantine hook ran");
        assert_eq!(
            fs::read(asset_root.join(quarantined_name)).unwrap(),
            replacement,
            "quarantine pathname replacement was mutated"
        );
        assert_eq!(fs::read(displaced).unwrap(), original);
        assert!(
            fs::read_dir(&asset_root)
                .unwrap()
                .filter_map(Result::ok)
                .any(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(super::ATTACHMENT_RECOVERY_PREFIX)
                        && fs::read(entry.path()).is_ok_and(|bytes| bytes == original)
                }),
            "the exact held original was not preserved in tracked recovery"
        );
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_full_reconciliation_serializes_the_final_recheck_and_remove() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "recheck-gap.png", &png);
        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import race fixture");
        let attachment = imported.workspace.attachments_by_node_id[NODE_ID][0].clone();
        let asset_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&attachment.relative_path);
        let connection = connect_notes_db(&vault_path).expect("cleanup connection");
        let placeholder_hash = "a".repeat(64);
        let placeholder_path = format!("notes-assets/{placeholder_hash}.png");
        connection
            .execute(
                "UPDATE notes_attachments SET relative_path = ?1, content_hash = ?2 WHERE id = ?3",
                params![placeholder_path, placeholder_hash, ATTACHMENT_ID],
            )
            .expect("make owned bytes unreachable");
        let racer = rusqlite::Connection::open(temp_dir.path().join(".yonalist/notes.sqlite"))
            .expect("independent SQLite connection");
        crate::notes::hlc::register_placeholder_hlc_function(&racer)
            .expect("register racer HLC function");
        racer
            .busy_timeout(std::time::Duration::ZERO)
            .expect("disable racer wait");
        let referenced_path = attachment.relative_path.clone();
        let referenced_hash = attachment.content_hash.clone();
        inject_full_reconciliation_before_remove_once(move || {
            let error = racer
                .execute(
                    "UPDATE notes_attachments SET relative_path = ?1, content_hash = ?2 WHERE id = ?3",
                    params![referenced_path, referenced_hash, ATTACHMENT_ID],
                )
                .expect_err("cleanup must hold the SQLite writer slot through unlink");
            assert!(
                matches!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
                ),
                "{error}"
            );
        });
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");

        assert_eq!(
            storage
                .reconcile_attachment_files(&connection)
                .expect("serialized reconciliation"),
            1
        );
        assert!(!asset_path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_full_reconciliation_keeps_verified_bytes_on_restore_conflict() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "restore-conflict.png", &png);
        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import race fixture");
        let attachment = imported.workspace.attachments_by_node_id[NODE_ID][0].clone();
        let asset_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&attachment.relative_path);
        let connection = connect_notes_db(&vault_path).expect("cleanup connection");
        let placeholder_hash = "a".repeat(64);
        let placeholder_path = format!("notes-assets/{placeholder_hash}.png");
        connection
            .execute(
                "UPDATE notes_attachments SET relative_path = ?1, content_hash = ?2 WHERE id = ?3",
                params![placeholder_path, placeholder_hash, ATTACHMENT_ID],
            )
            .expect("make owned bytes unreachable");
        let raced_asset_path = asset_path.clone();
        let referenced_path = attachment.relative_path.clone();
        let referenced_hash = attachment.content_hash.clone();
        inject_full_reconciliation_after_quarantine_once(move |connection| {
            fs::write(&raced_asset_path, b"corrupt replacement")
                .expect("publish conflicting occupant");
            connection
                .execute(
                    "UPDATE notes_attachments SET relative_path = ?1, content_hash = ?2 WHERE id = ?3",
                    params![referenced_path, referenced_hash, ATTACHMENT_ID],
                )
                .expect("restore reference after quarantine");
        });
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");

        assert_eq!(
            storage
                .reconcile_attachment_files(&connection)
                .expect("conflict recovery"),
            0
        );
        assert_eq!(fs::read(asset_path).expect("verified bytes survive"), png);
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_restore_never_publishes_a_swapped_quarantine_path() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "restore-swap.png", &png);
        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import race fixture");
        let attachment = imported.workspace.attachments_by_node_id[NODE_ID][0].clone();
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        let asset_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&attachment.relative_path);
        let connection = connect_notes_db(&vault_path).expect("cleanup connection");
        let placeholder_hash = "a".repeat(64);
        let placeholder_path = format!("notes-assets/{placeholder_hash}.png");
        connection
            .execute(
                "UPDATE notes_attachments SET relative_path = ?1, content_hash = ?2 WHERE id = ?3",
                params![placeholder_path, placeholder_hash, ATTACHMENT_ID],
            )
            .expect("make owned bytes unreachable");
        let raced_asset_path = asset_path.clone();
        let referenced_path = attachment.relative_path.clone();
        let referenced_hash = attachment.content_hash.clone();
        inject_full_reconciliation_after_quarantine_once(move |connection| {
            fs::write(&raced_asset_path, b"corrupt destination")
                .expect("publish conflicting occupant");
            connection
                .execute(
                    "UPDATE notes_attachments SET relative_path = ?1, content_hash = ?2 WHERE id = ?3",
                    params![referenced_path, referenced_hash, ATTACHMENT_ID],
                )
                .expect("restore reference after quarantine");
        });
        let displaced = temp_dir.path().join("displaced-valid-quarantine");
        let raced_root = asset_root.clone();
        let action_path = std::sync::Arc::new(std::sync::Mutex::new(None));
        let captured_action_path = std::sync::Arc::clone(&action_path);
        inject_quarantined_file_before_action_once(move |relative_path| {
            let full_path = raced_root.join(relative_path);
            fs::rename(&full_path, &displaced).expect("swap verified quarantine out");
            fs::write(&full_path, b"swapped bytes").expect("swap replacement in");
            *captured_action_path.lock().expect("capture action path") = Some(full_path);
        });
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");

        let result = storage.reconcile_attachment_files(&connection);

        assert!(result.is_err(), "swapped restore unexpectedly succeeded");
        let action_path = action_path
            .lock()
            .expect("action path")
            .clone()
            .expect("action hook ran");
        assert_eq!(
            fs::read(action_path).expect("swapped path survives"),
            b"swapped bytes"
        );
        assert_ne!(
            fs::read(&asset_path).unwrap_or_default(),
            b"swapped bytes",
            "swapped bytes became canonical"
        );
        assert!(
            asset_file_with_bytes(&asset_root, b"corrupt destination").is_some(),
            "conflicting destination was deleted"
        );
        let recovery = asset_file_with_bytes(&asset_root, &png).expect("valid recovery quarantine");
        assert!(
            recovery
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(".attachment-recovery-")),
            "{}",
            recovery.display()
        );
    }

    #[test]
    fn notes_attachment_restore_quarantines_conflict_before_noreplace_recovery() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "restore-noreplace.png", &png);
        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import race fixture");
        let attachment = imported.workspace.attachments_by_node_id[NODE_ID][0].clone();
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        let asset_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&attachment.relative_path);
        let connection = connect_notes_db(&vault_path).expect("cleanup connection");
        let placeholder_hash = "a".repeat(64);
        let placeholder_path = format!("notes-assets/{placeholder_hash}.png");
        connection
            .execute(
                "UPDATE notes_attachments SET relative_path = ?1, content_hash = ?2 WHERE id = ?3",
                params![placeholder_path, placeholder_hash, ATTACHMENT_ID],
            )
            .expect("make owned bytes unreachable");
        let raced_asset_path = asset_path.clone();
        let referenced_path = attachment.relative_path.clone();
        let referenced_hash = attachment.content_hash.clone();
        inject_full_reconciliation_after_quarantine_once(move |connection| {
            fs::write(&raced_asset_path, b"corrupt destination")
                .expect("publish conflicting occupant");
            connection
                .execute(
                    "UPDATE notes_attachments SET relative_path = ?1, content_hash = ?2 WHERE id = ?3",
                    params![referenced_path, referenced_hash, ATTACHMENT_ID],
                )
                .expect("restore reference after quarantine");
        });
        let raced_asset_path = asset_path.clone();
        inject_restore_after_conflict_quarantine_once(move || {
            assert!(
                !raced_asset_path.exists(),
                "conflicting destination was not quarantined first"
            );
            fs::write(&raced_asset_path, b"raced destination").expect("race no-replace restore");
        });
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");

        let result = storage.reconcile_attachment_files(&connection);

        assert!(
            result.is_err(),
            "raced no-replace restore unexpectedly succeeded"
        );
        assert_eq!(
            fs::read(&asset_path).expect("raced destination survives"),
            b"raced destination"
        );
        let recovery = asset_file_with_bytes(&asset_root, &png).expect("valid recovery quarantine");
        assert!(
            recovery
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(".attachment-recovery-")),
            "{}",
            recovery.display()
        );

        storage
            .reconcile_attachment_files(&connection)
            .expect("ordinary cleanup preserves recovery quarantine");
        assert!(recovery.exists(), "ordinary cleanup deleted recovery bytes");
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_restore_keeps_recovery_when_verified_canonical_binding_changes() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let hash = sha256_hex(&png);
        let canonical_name = PathBuf::from(format!("{hash}.png"));
        let recovery_name = PathBuf::from(format!(
            "{}duplicate-binding-test",
            super::ATTACHMENT_RECOVERY_PREFIX
        ));
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        let canonical = asset_root.join(&canonical_name);
        let recovery = asset_root.join(&recovery_name);
        fs::write(&canonical, &png).expect("canonical duplicate");
        fs::write(&recovery, &png).expect("recovery duplicate");
        let held = storage
            .open_held_file(&recovery_name)
            .expect("hold recovery");
        let quarantined = super::QuarantinedFile {
            name: recovery_name,
            held,
            snapshot_hash: hash.clone(),
        };
        let displaced = temp_dir.path().join("displaced-verified-canonical.png");
        let canonical_for_hook = canonical.clone();
        let displaced_for_hook = displaced.clone();
        inject_restore_before_duplicate_retirement_once(move || {
            fs::rename(&canonical_for_hook, &displaced_for_hook)
                .expect("displace verified canonical");
            fs::write(&canonical_for_hook, b"canonical replacement")
                .expect("install canonical replacement");
        });

        let result = storage.restore_quarantined_file(quarantined, &canonical_name);

        assert!(
            result.is_err(),
            "changed canonical binding retired recovery"
        );
        assert_eq!(fs::read(&canonical).unwrap(), b"canonical replacement");
        assert_eq!(fs::read(&displaced).unwrap(), png);
        assert_eq!(fs::read(&recovery).unwrap(), png);
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_restore_rechecks_canonical_binding_after_final_hash() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let hash = sha256_hex(&png);
        let canonical_name = PathBuf::from(format!("{hash}.png"));
        let recovery_name = PathBuf::from(format!(
            "{}post-hash-binding-test",
            super::ATTACHMENT_RECOVERY_PREFIX
        ));
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        let canonical = asset_root.join(&canonical_name);
        let recovery = asset_root.join(&recovery_name);
        let displaced = temp_dir.path().join("displaced-post-hash-canonical.png");
        fs::write(&canonical, &png).unwrap();
        fs::write(&recovery, &png).unwrap();
        let held = storage.open_held_file(&recovery_name).unwrap();
        let quarantined = super::QuarantinedFile {
            name: recovery_name,
            held,
            snapshot_hash: hash.clone(),
        };
        let canonical_for_hook = canonical.clone();
        let displaced_for_hook = displaced.clone();
        inject_restore_after_duplicate_hash_once(move || {
            fs::rename(&canonical_for_hook, &displaced_for_hook).unwrap();
            fs::write(&canonical_for_hook, b"post-hash canonical replacement").unwrap();
        });

        let result = storage.restore_quarantined_file(quarantined, &canonical_name);

        assert!(
            result.is_err(),
            "post-hash rebind retired the recovery copy"
        );
        assert_eq!(fs::read(&recovery).unwrap(), png);
        assert_eq!(
            fs::read(&canonical).unwrap(),
            b"post-hash canonical replacement"
        );
        assert_eq!(fs::read(&displaced).unwrap(), png);
    }

    #[test]
    fn notes_attachment_recovery_copy_rejects_a_same_inode_mutation_after_copy() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let hash = sha256_hex(&png);
        let canonical_name = PathBuf::from(format!("{hash}.png"));
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        fs::write(asset_root.join(&canonical_name), &png).expect("canonical source");
        let held = storage
            .open_held_file(&canonical_name)
            .expect("hold source");
        let quarantined = super::QuarantinedFile {
            name: canonical_name,
            held,
            snapshot_hash: hash.clone(),
        };
        let replacement = vec![0xa5; png.len()];
        let asset_root_for_hook = asset_root.clone();
        inject_recovery_file_after_copy_once(move |recovery_name| {
            fs::write(asset_root_for_hook.join(recovery_name), &replacement)
                .expect("mutate recovery copy in place");
        });

        let result = storage.copy_held_file_to_recovery(&quarantined);

        assert!(
            result.is_err(),
            "same-inode recovery mutation was accepted as verified evidence"
        );
    }

    #[test]
    fn notes_attachment_restore_rejects_recovery_bytes_changed_after_copy() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let hash = sha256_hex(&png);
        let canonical_name = PathBuf::from(format!("{hash}.png"));
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        fs::write(asset_root.join(&canonical_name), &png).expect("canonical source");
        let held = storage
            .open_held_file(&canonical_name)
            .expect("hold source");
        let quarantined = super::QuarantinedFile {
            name: canonical_name.clone(),
            held,
            snapshot_hash: hash.clone(),
        };
        let recovery = storage
            .copy_held_file_to_recovery(&quarantined)
            .expect("copy recovery");
        let recovery_path = asset_root.join(&recovery.name);
        let replacement = vec![0xa5; png.len()];
        fs::write(&recovery_path, &replacement).expect("mutate recovery in place");

        let result = storage.restore_quarantined_file(recovery, &canonical_name);

        assert!(result.is_err(), "changed recovery bytes were retired");
        assert_eq!(fs::read(&recovery_path).unwrap(), replacement);
        assert_eq!(fs::read(asset_root.join(canonical_name)).unwrap(), png);
    }

    #[test]
    fn notes_attachment_retirement_rejects_recovery_bytes_changed_after_copy() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let hash = sha256_hex(&png);
        let canonical_name = PathBuf::from(format!("{hash}.png"));
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        fs::write(asset_root.join(&canonical_name), &png).expect("canonical source");
        let held = storage
            .open_held_file(&canonical_name)
            .expect("hold source");
        let quarantined = super::QuarantinedFile {
            name: canonical_name,
            held,
            snapshot_hash: hash.clone(),
        };
        let recovery = storage
            .copy_held_file_to_recovery(&quarantined)
            .expect("copy recovery");
        let recovery_path = asset_root.join(&recovery.name);
        let replacement = vec![0x5a; png.len()];
        fs::write(&recovery_path, &replacement).expect("mutate recovery in place");

        let result = storage.retire_quarantined_file(recovery, "test recovery", None);

        assert!(result.is_err(), "changed recovery bytes were retired");
        assert_eq!(fs::read(&recovery_path).unwrap(), replacement);
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_restore_reopens_survivor_after_recovery_isolation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let hash = sha256_hex(&png);
        let canonical_name = PathBuf::from(format!("{hash}.png"));
        let recovery_name = PathBuf::from(format!(
            "{}post-isolation-survivor-test",
            super::ATTACHMENT_RECOVERY_PREFIX
        ));
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        let canonical = asset_root.join(&canonical_name);
        let recovery = asset_root.join(&recovery_name);
        let displaced = temp_dir
            .path()
            .join("displaced-post-isolation-survivor.png");
        fs::write(&canonical, &png).unwrap();
        fs::write(&recovery, &png).unwrap();
        let held = storage.open_held_file(&recovery_name).unwrap();
        let quarantined = super::QuarantinedFile {
            name: recovery_name,
            held,
            snapshot_hash: hash.clone(),
        };
        let canonical_for_hook = canonical.clone();
        let displaced_for_hook = displaced.clone();
        let replacement = png.clone();
        inject_after_counterpart_isolation_once(move || {
            fs::rename(&canonical_for_hook, &displaced_for_hook).unwrap();
            fs::write(&canonical_for_hook, &replacement).unwrap();
        });

        let result = storage.restore_quarantined_file(quarantined, &canonical_name);

        assert!(
            result.is_err(),
            "a rebound survivor committed recovery retirement"
        );
        assert_eq!(fs::read(&canonical).unwrap(), png);
        assert_eq!(fs::read(&displaced).unwrap(), png);
        assert!(
            fs::read_dir(&asset_root)
                .unwrap()
                .filter_map(Result::ok)
                .any(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".asset-gc-retired-")
                        && fs::read(entry.path().join("payload")).is_ok_and(|bytes| bytes == png)
                }),
            "the isolated recovery bytes were not preserved"
        );
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_owned_opener_rejects_multiply_linked_files() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");
        let file_name = format!("{}.png", "a".repeat(64));
        let canonical = temp_dir
            .path()
            .join(".yonalist/notes-assets")
            .join(&file_name);
        let alias = temp_dir.path().join("owned-hardlink-alias.png");
        fs::write(&canonical, b"multiply linked owned file").unwrap();
        fs::hard_link(&canonical, &alias).unwrap();

        let result = storage.open_owned_file(&file_name);

        assert!(result.is_err(), "owned opener accepted nlink > 1");
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_quarantine_opener_rejects_multiply_linked_files() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");
        let file_name = PathBuf::from(format!(
            "{}hardlink-opener-test",
            super::ATTACHMENT_QUARANTINE_PREFIX
        ));
        let canonical = temp_dir
            .path()
            .join(".yonalist/notes-assets")
            .join(&file_name);
        let alias = temp_dir.path().join("quarantine-hardlink-alias.png");
        fs::write(&canonical, b"multiply linked quarantine file").unwrap();
        fs::hard_link(&canonical, &alias).unwrap();

        let result = storage.open_held_file(&file_name);

        assert!(result.is_err(), "quarantine opener accepted nlink > 1");
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_restore_rejects_a_link_added_at_the_final_move_boundary() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let hash = sha256_hex(&png);
        let canonical_name = PathBuf::from(format!("{hash}.png"));
        let recovery_name = PathBuf::from(format!(
            "{}late-link-restore",
            super::ATTACHMENT_RECOVERY_PREFIX
        ));
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        let recovery = asset_root.join(&recovery_name);
        let canonical = asset_root.join(&canonical_name);
        let alias = temp_dir.path().join("restore-hardlink-alias.png");
        fs::write(&recovery, &png).unwrap();
        let held = storage.open_held_file(&recovery_name).unwrap();
        let quarantined = super::QuarantinedFile {
            name: recovery_name,
            held,
            snapshot_hash: hash.clone(),
        };
        let asset_root_for_hook = asset_root.clone();
        let alias_for_hook = alias.clone();
        inject_quarantined_file_before_action_once(move |relative_path| {
            fs::hard_link(asset_root_for_hook.join(relative_path), &alias_for_hook).unwrap();
        });

        let result = storage.restore_quarantined_file(quarantined, &canonical_name);

        assert!(result.is_err(), "restore accepted a late hardlink");
        assert!(!canonical.exists());
        assert_eq!(fs::read(&recovery).unwrap(), png);
        assert_eq!(fs::read(&alias).unwrap(), png);
    }

    #[test]
    fn notes_attachment_restore_delegates_duplicate_survivor_ownership_to_retirement() {
        let source = include_str!("attachments.rs");
        let restore = source
            .find("fn restore_quarantined_file(")
            .expect("restore implementation");
        let restore_end = source[restore..]
            .find("\n    fn restore_quarantined_file_after_error(")
            .map(|offset| restore + offset)
            .expect("restore implementation end");
        let after_hash = source[restore..restore_end]
            .find("maybe_inject_restore_after_duplicate_hash();")
            .map(|offset| restore + offset)
            .expect("duplicate hash boundary");
        let duplicate_drop = source[after_hash..restore_end]
            .find("drop(destination);")
            .map(|offset| after_hash + offset)
            .expect("duplicate destination release");
        let duplicate_retirement = source[duplicate_drop..restore_end]
            .find("retire_quarantined_file(")
            .map(|offset| duplicate_drop + offset)
            .expect("duplicate retirement");
        assert!(
            duplicate_drop < duplicate_retirement
                && source[duplicate_drop..restore_end].contains("RetirementSurvivor::new("),
            "caller aliases must close before the authority internally opens its survivor"
        );
        let conflict_identity = source[restore..]
            .find("let destination_identity = destination.identity;")
            .map(|offset| restore + offset)
            .expect("conflict destination identity");
        let conflict_rename = source[conflict_identity..]
            .find("quarantine_reconciliation_candidate(file_name, destination_identity)")
            .map(|offset| conflict_identity + offset)
            .expect("conflict quarantine rename");
        assert!(
            source[conflict_identity..conflict_rename].contains("drop(destination);"),
            "conflicting destination alias must close before quarantine rename"
        );
    }

    #[test]
    fn notes_attachment_quarantine_retirement_consumes_source_ownership_once() {
        let source = include_str!("attachments.rs");
        let removal = source
            .find("fn retire_quarantined_file(")
            .expect("quarantine removal implementation");
        let removal_end = source[removal..]
            .find("\n    fn remove_quarantined_file(")
            .map(|offset| removal + offset)
            .expect("quarantine removal implementation end");
        let implementation = &source[removal..removal_end];
        assert!(
            implementation.contains("quarantined: QuarantinedFile")
                && implementation.contains("logical_retire_noreplace(")
                && !implementation.contains("try_clone_held()"),
            "retirement must consume the source handle and delegate survivor ownership"
        );
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_full_reconciliation_never_unlinks_a_swapped_quarantine_path() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "remove-swap.png", &png);
        notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import race fixture");
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        let connection = connect_notes_db(&vault_path).expect("cleanup connection");
        connection
            .execute(
                "DELETE FROM notes_attachments WHERE id = ?1",
                [ATTACHMENT_ID],
            )
            .expect("make owned bytes unreachable");
        let displaced = temp_dir.path().join("displaced-remove-quarantine");
        let raced_root = asset_root.clone();
        let action_path = std::sync::Arc::new(std::sync::Mutex::new(None));
        let captured_action_path = std::sync::Arc::clone(&action_path);
        inject_quarantined_file_before_action_once(move |relative_path| {
            let full_path = raced_root.join(relative_path);
            fs::rename(&full_path, &displaced).expect("swap quarantine out");
            fs::write(&full_path, b"replacement bytes").expect("swap replacement in");
            *captured_action_path.lock().expect("capture action path") = Some(full_path);
        });
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");

        let result = storage.reconcile_attachment_files(&connection);

        assert!(result.is_err(), "swapped unlink unexpectedly succeeded");
        let action_path = action_path
            .lock()
            .expect("action path")
            .clone()
            .expect("action hook ran");
        assert_eq!(
            fs::read(action_path).expect("replacement survives"),
            b"replacement bytes"
        );
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_retirement_rechecks_identity_after_quarantine_validation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "post-validation-remove-swap.png", &png);
        notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import race fixture");
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        let connection = connect_notes_db(&vault_path).expect("cleanup connection");
        connection
            .execute(
                "DELETE FROM notes_attachments WHERE id = ?1",
                [ATTACHMENT_ID],
            )
            .expect("make owned bytes unreachable");
        let displaced = temp_dir.path().join("post-validation-displaced-quarantine");
        let raced_root = asset_root.clone();
        let displaced_for_hook = displaced.clone();
        let replacement_path = std::sync::Arc::new(std::sync::Mutex::new(None));
        let captured_path = std::sync::Arc::clone(&replacement_path);
        inject_quarantined_file_after_validation_once(move |relative_path| {
            let full_path = raced_root.join(relative_path);
            fs::rename(&full_path, &displaced_for_hook).expect("displace validated quarantine");
            fs::write(&full_path, b"post-validation replacement").expect("install replacement");
            *captured_path.lock().expect("capture replacement") = Some(full_path);
        });
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");

        let error = storage
            .reconcile_attachment_files(&connection)
            .expect_err("post-validation replacement must fail exact retirement");

        assert!(
            error.contains("changed") || error.contains("identity"),
            "{error}"
        );
        let replacement_path = replacement_path
            .lock()
            .expect("replacement path")
            .clone()
            .expect("hook ran");
        assert_eq!(
            fs::read(replacement_path).expect("replacement survives"),
            b"post-validation replacement"
        );
        assert_eq!(fs::read(displaced).expect("original survives"), png);
    }

    #[test]
    fn notes_attachment_reconciliation_preserves_retirement_recovery_on_failure() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "rollback-retirement-failure.png", &png);
        notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import fixture");
        let connection = connect_notes_db(&vault_path).expect("cleanup connection");
        connection
            .execute(
                "DELETE FROM notes_attachments WHERE id = ?1",
                [ATTACHMENT_ID],
            )
            .expect("make owned bytes unreachable");
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        inject_retirement_authorization_failure_once();
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");

        let result = storage.reconcile_attachment_files(&connection);

        assert!(
            result.is_err(),
            "injected retirement unexpectedly succeeded"
        );
        let recovery = fs::read_dir(&asset_root)
            .expect("asset root")
            .filter_map(Result::ok)
            .map(|entry| entry.path().join("payload"))
            .find(|payload| fs::read(payload).is_ok_and(|bytes| bytes == png))
            .expect("intent-only retirement must preserve the exact recovery bytes");
        assert!(recovery.is_file());
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_targeted_cleanup_holds_writer_lock_through_unlink() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "targeted-lock.png", &png);
        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import race fixture");
        let attachment = imported.workspace.attachments_by_node_id[NODE_ID][0].clone();
        let asset_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&attachment.relative_path);
        let connection = connect_notes_db(&vault_path).expect("cleanup connection");
        let placeholder_hash = "a".repeat(64);
        let placeholder_path = format!("notes-assets/{placeholder_hash}.png");
        connection
            .execute(
                "UPDATE notes_attachments SET relative_path = ?1, content_hash = ?2 WHERE id = ?3",
                params![placeholder_path, placeholder_hash, ATTACHMENT_ID],
            )
            .expect("make candidate unreachable");
        let racer = rusqlite::Connection::open(temp_dir.path().join(".yonalist/notes.sqlite"))
            .expect("independent SQLite connection");
        crate::notes::hlc::register_placeholder_hlc_function(&racer)
            .expect("register racer HLC function");
        racer
            .busy_timeout(std::time::Duration::ZERO)
            .expect("disable racer wait");
        let referenced_path = attachment.relative_path.clone();
        let referenced_hash = attachment.content_hash.clone();
        inject_full_reconciliation_before_remove_once(move || {
            let error = racer
                .execute(
                    "UPDATE notes_attachments SET relative_path = ?1, content_hash = ?2 WHERE id = ?3",
                    params![referenced_path, referenced_hash, ATTACHMENT_ID],
                )
                .expect_err("targeted cleanup must hold the SQLite writer slot through unlink");
            assert!(
                matches!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
                ),
                "{error}"
            );
        });
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");

        assert_eq!(
            storage
                .reconcile_attachment_candidates(&connection, &[attachment.relative_path])
                .expect("serialized targeted cleanup"),
            1
        );
        assert!(!asset_path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_targeted_cleanup_never_unlinks_a_swapped_path() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "targeted-swap.png", &png);
        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import race fixture");
        let attachment = imported.workspace.attachments_by_node_id[NODE_ID][0].clone();
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        let connection = connect_notes_db(&vault_path).expect("cleanup connection");
        let placeholder_hash = "a".repeat(64);
        let placeholder_path = format!("notes-assets/{placeholder_hash}.png");
        connection
            .execute(
                "UPDATE notes_attachments SET relative_path = ?1, content_hash = ?2 WHERE id = ?3",
                params![placeholder_path, placeholder_hash, ATTACHMENT_ID],
            )
            .expect("make candidate unreachable");
        let displaced = temp_dir.path().join("displaced-targeted-quarantine");
        let raced_root = asset_root.clone();
        let action_path = std::sync::Arc::new(std::sync::Mutex::new(None));
        let captured_action_path = std::sync::Arc::clone(&action_path);
        inject_quarantined_file_before_action_once(move |relative_path| {
            let full_path = raced_root.join(relative_path);
            fs::rename(&full_path, &displaced).expect("swap targeted path out");
            fs::write(&full_path, b"replacement bytes").expect("swap replacement in");
            *captured_action_path.lock().expect("capture action path") = Some(full_path);
        });
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");

        let result =
            storage.reconcile_attachment_candidates(&connection, &[attachment.relative_path]);

        assert!(
            result.is_err(),
            "swapped targeted unlink unexpectedly succeeded"
        );
        let action_path = action_path
            .lock()
            .expect("action path")
            .clone()
            .expect("action hook ran");
        assert_eq!(
            fs::read(action_path).expect("replacement survives"),
            b"replacement bytes"
        );
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_database_delete_never_unlinks_a_swapped_path() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "database-delete-swap.png", &png);
        notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            None,
        )
        .expect("import race fixture");
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        let displaced = temp_dir.path().join("displaced-database-delete-quarantine");
        let raced_root = asset_root.clone();
        let action_path = std::sync::Arc::new(std::sync::Mutex::new(None));
        let captured_action_path = std::sync::Arc::clone(&action_path);
        inject_quarantined_file_before_action_once(move |relative_path| {
            let full_path = raced_root.join(relative_path);
            fs::rename(&full_path, &displaced).expect("swap database-delete path out");
            fs::write(&full_path, b"replacement bytes").expect("swap replacement in");
            *captured_action_path.lock().expect("capture action path") = Some(full_path);
        });
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");

        let result = storage.delete_attachment_files();

        assert!(
            result.is_err(),
            "swapped database-delete unlink unexpectedly succeeded"
        );
        let action_path = action_path
            .lock()
            .expect("action path")
            .clone()
            .expect("action hook ran");
        assert_eq!(
            fs::read(action_path).expect("replacement survives"),
            b"replacement bytes"
        );
    }

    #[test]
    fn notes_attachment_database_delete_reclaims_asset_trash_and_private_payloads() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");
        let (_assets, trash) = storage.asset_gc_directories().expect("asset directories");
        let canonical_bytes = b"app-local canonical trash bytes";
        let canonical_hash = sha256_hex(canonical_bytes);
        let canonical_name = PathBuf::from(format!("{canonical_hash}.png"));
        fs::write(
            temp_dir
                .path()
                .join(".yonalist/asset-trash")
                .join(&canonical_name),
            canonical_bytes,
        )
        .expect("canonical trash asset");
        let (operation, operation_name, _) =
            create_private_directory(&trash, RETIRED_DIRECTORY_PREFIX, &mut || Ok(()))
                .expect("private trash operation");
        operation
            .write(PRIVATE_ASSET_PAYLOAD, b"private operation payload")
            .expect("private payload");
        drop(operation);

        storage
            .delete_attachment_files()
            .expect("delete all attachment bytes");

        assert!(
            !temp_dir
                .path()
                .join(".yonalist/asset-trash")
                .join(canonical_name)
                .exists(),
            "canonical app-local trash bytes survived database deletion"
        );
        assert_eq!(
            fs::metadata(
                temp_dir
                    .path()
                    .join(".yonalist/asset-trash")
                    .join(operation_name)
                    .join(PRIVATE_ASSET_PAYLOAD)
            )
            .unwrap()
            .len(),
            0,
            "private app-local operation payload survived database deletion"
        );
    }

    #[test]
    fn notes_delete_database_reports_asset_trash_cleanup_failure() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("storage lease");
        storage.asset_gc_directories().expect("create asset trash");
        drop(storage);
        fs::write(
            temp_dir.path().join(".yonalist/asset-trash/not-owned.txt"),
            b"unexpected entry",
        )
        .expect("malformed trash entry");

        let outcome = notes_delete_database(vault_path).expect("delete database outcome");

        assert_eq!(
            serde_json::to_value(outcome).unwrap()["attachmentCleanupFailed"],
            true,
            "asset-trash cleanup failure was reported as success"
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
        let attachments = &workspace.workspace.attachments_by_node_id[NODE_ID];
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
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
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
            resized.workspace.attachments_by_node_id[NODE_ID][0].display_width,
            160
        );
    }

    #[test]
    fn notes_attachment_import_clamps_initial_max_width_to_measurement_and_intrinsic_width() {
        for (initial_max_display_width, expected_display_width) in
            [(100, 100), (480, 480), (2_000, 1_200)]
        {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let vault_path = vault_path(&temp_dir);
            seed_node(&vault_path);
            let source = write_source(
                &temp_dir,
                "wide.png",
                &encoded_dimensions(ImageFormat::Png, 1_200, 800),
            );
            let mut input = import_input(ATTACHMENT_ID, source);
            input.initial_max_display_width = initial_max_display_width;

            let imported = notes_import_attachment(vault_path, input, None)
                .expect("import with initial max display width");

            assert_eq!(
                imported.workspace.attachments_by_node_id[NODE_ID][0].display_width,
                expected_display_width
            );
        }
    }

    #[test]
    fn notes_attachment_import_rejects_nonpositive_initial_max_width() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let source = write_source(
            &temp_dir,
            "invalid-width.png",
            &encoded_dimensions(ImageFormat::Png, 320, 200),
        );
        let mut input = import_input(ATTACHMENT_ID, source);
        input.initial_max_display_width = 0;

        let error = notes_import_attachment(vault_path, input, None)
            .expect_err("nonpositive initial max display width");

        assert!(error.contains("positive"), "{error}");
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

        let blocked_batch =
            prepare_source_attachment(&second_source).expect("prepare blocked publish");
        let blocked = &blocked_batch.attachments()[0];
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
        drop(blocked_batch);

        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, first_source.clone()),
            None,
        )
        .expect("shared import");
        let shared_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&imported.workspace.attachments_by_node_id[NODE_ID][0].relative_path);

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
            entries
                .iter()
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
                .count(),
            1,
            "an unshared canonical file survived reconciliation"
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
    fn notes_attachment_publish_never_accepts_a_replaced_private_staging_payload() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "private-stage-race.png", &png);
        let prepared_batch =
            prepare_source_attachment(&source).expect("prepare publication race fixture");
        let prepared = &prepared_batch.attachments()[0];
        let relative =
            canonical_relative_path(&prepared.image.content_hash, prepared.image.mime_type)
                .expect("canonical target");
        let canonical = temp_dir.path().join(".yonalist").join(relative);
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        let displaced = temp_dir.path().join("displaced-private-stage.png");
        let displaced_for_hook = displaced.clone();
        let asset_root_for_hook = asset_root.clone();
        let replacement = vec![0x5a; png.len()];
        let replacement_for_hook = replacement.clone();
        let replacement_payload = Arc::new(Mutex::new(None));
        let replacement_payload_for_hook = Arc::clone(&replacement_payload);
        inject_before_staged_publication_once(move || {
            let staging = fs::read_dir(&asset_root_for_hook)
                .expect("enumerate private staging")
                .filter_map(Result::ok)
                .find(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".asset-gc-staging-")
                })
                .expect("private staging directory")
                .path();
            let payload = staging.join("payload");
            fs::rename(&payload, &displaced_for_hook).expect("displace staged payload");
            fs::write(&payload, &replacement_for_hook).expect("replace staged payload");
            *replacement_payload_for_hook
                .lock()
                .expect("record replacement payload") = Some(payload);
        });

        let error = publish_attachment_bytes(&vault_path, prepared)
            .expect_err("a replaced staged identity must fail publication");

        assert!(
            error.contains("identity") || error.contains("content"),
            "{error}"
        );
        assert!(
            !canonical.exists(),
            "a replacement crossed the final staged boundary"
        );
        let replacement_payload = replacement_payload
            .lock()
            .expect("read replacement payload")
            .clone()
            .expect("replacement payload path");
        assert_eq!(
            fs::read(&replacement_payload).expect("external replacement survives privately"),
            replacement
        );
        assert_eq!(
            fs::read(&displaced).expect("verified staging survives"),
            png
        );
    }

    #[cfg(unix)]
    #[test]
    fn notes_attachment_dedup_rejects_a_fifo_without_blocking() {
        use std::os::unix::fs::OpenOptionsExt as _;
        use std::sync::mpsc;
        use std::time::Duration;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "fifo-dedup-source.png", &png);
        let hash = sha256_hex(&png);
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        fs::create_dir_all(&asset_root).expect("asset root");
        let canonical = asset_root.join(format!("{hash}.png"));
        let status = std::process::Command::new("mkfifo")
            .arg(&canonical)
            .status()
            .expect("create FIFO canonical");
        assert!(status.success(), "mkfifo failed");
        let _guard = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32)
            .open(&canonical)
            .expect("open FIFO guard");
        // Prepare on this thread: it waits on the global import permit, which
        // other suite tests hold for arbitrary stretches. Only the publish step
        // inspects the canonical FIFO, so only it runs under the timeout.
        let batch = prepare_source_attachment(&source).expect("prepare FIFO dedup source");
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let result = publish_attachment_bytes(&vault_path, &batch.attachments()[0]);
            let _ = sender.send(result);
        });

        let result = receiver
            .recv_timeout(Duration::from_secs(30))
            .expect("canonical FIFO inspection must not block");
        let error = result.expect_err("canonical FIFO must fail closed");
        assert!(error.contains("regular file"), "{error}");
    }

    #[test]
    fn notes_attachment_history_replays_import_resize_remove_and_restore_metadata() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "history.png", &png);
        let import_context = history_context(1, "importAttachment");

        let mut input = import_input(ATTACHMENT_ID, source);
        input.initial_max_display_width = 100;
        let imported =
            notes_import_attachment(vault_path.clone(), input, Some(import_context.clone()))
                .expect("journaled import");
        assert_eq!(
            imported.history_entry_id.as_deref(),
            Some(import_context.entry_id.as_str())
        );
        assert!(imported.can_undo);
        assert!(!imported.can_redo);
        let asset_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&imported.workspace.attachments_by_node_id[NODE_ID][0].relative_path);
        let shared = acquire_notes_connection(&vault_path).expect("connect history");
        let mut connection = lock_notes_connection(&shared).expect("lock history");
        let undone =
            undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("undo import");
        assert!(undone.workspace.attachments_by_node_id.is_empty());
        assert!(asset_path.is_file(), "redo-reachable bytes were removed");
        let redone =
            redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active).expect("redo import");
        assert_eq!(
            redone.workspace.attachments_by_node_id[NODE_ID][0].display_width,
            100
        );
        drop(connection);
        drop(shared);

        let resize_context = history_context(2, "resizeAttachment");
        let resized = notes_resize_attachment(
            vault_path.clone(),
            ResizeAttachmentInput {
                id: ATTACHMENT_ID.to_string(),
                display_width: 180,
            },
            Some(resize_context.clone()),
        )
        .expect("journaled resize");
        assert_eq!(
            resized.history_entry_id.as_deref(),
            Some(resize_context.entry_id.as_str())
        );
        assert!(resized.can_undo);
        assert!(!resized.can_redo);
        let shared = acquire_notes_connection(&vault_path).expect("connect resize history");
        let mut connection = lock_notes_connection(&shared).expect("lock resize history");
        assert_eq!(
            undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
                .expect("undo resize")
                .workspace
                .attachments_by_node_id[NODE_ID][0]
                .display_width,
            100
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
        drop(shared);

        let remove_context = history_context(3, "removeAttachment");
        let removed = notes_remove_attachment(
            vault_path.clone(),
            ATTACHMENT_ID.to_string(),
            Some(remove_context.clone()),
        )
        .expect("journaled remove");
        assert_eq!(
            removed.history_entry_id.as_deref(),
            Some(remove_context.entry_id.as_str())
        );
        assert!(removed.can_undo);
        assert!(!removed.can_redo);
        assert!(asset_path.is_file(), "undo-reachable bytes were removed");
        let restored = notes_restore_attachment(
            vault_path.clone(),
            ATTACHMENT_ID.to_string(),
            Some(history_context(4, "restoreAttachment")),
        )
        .expect("explicit history restore");
        assert_eq!(
            restored.history_entry_id.as_deref(),
            Some("00000000-0000-4000-8000-000000000004")
        );
        assert!(restored.can_undo);
        assert!(!restored.can_redo);
        assert_eq!(
            restored.workspace.attachments_by_node_id[NODE_ID][0].display_width,
            180
        );

        let unjournaled =
            notes_remove_attachment(vault_path.clone(), ATTACHMENT_ID.to_string(), None)
                .expect("permanent metadata removal");
        assert_eq!(unjournaled.history_entry_id, None);
        assert!(!unjournaled.can_undo);
        assert!(!unjournaled.can_redo);
        notes_clear_history(vault_path, SESSION_ID.to_string()).expect("clear history");
        assert!(
            !asset_path.exists(),
            "unreferenced bytes survived history clearing"
        );
        let trash_path = temp_dir
            .path()
            .join(".yonalist/asset-trash")
            .join(asset_path.file_name().expect("asset file name"));
        assert!(
            trash_path.exists(),
            "history pruning bypassed asset retention"
        );
    }

    #[test]
    fn notes_attachment_undo_restores_bytes_quarantined_by_asset_gc() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let source = write_source(
            &temp_dir,
            "undo-after-gc.png",
            &encoded_dimensions(ImageFormat::Png, 16, 12),
        );
        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            Some(history_context(1, "importAttachment")),
        )
        .expect("journaled import");
        let relative_path = imported.workspace.attachments_by_node_id[NODE_ID][0]
            .relative_path
            .clone();
        let live_path = temp_dir.path().join(".yonalist").join(&relative_path);
        notes_remove_attachment(
            vault_path.clone(),
            ATTACHMENT_ID.to_string(),
            Some(history_context(2, "removeAttachment")),
        )
        .expect("journaled remove");

        // C1: the periodic GC now defers freshly written unreferenced bytes for
        // 24h, so age the asset past that window before expecting quarantine.
        std::fs::OpenOptions::new()
            .write(true)
            .open(&live_path)
            .and_then(|file| {
                file.set_modified(
                    std::time::SystemTime::now() - std::time::Duration::from_secs(25 * 60 * 60),
                )
            })
            .expect("age the zero-ref asset past the GC minimum");

        run_asset_gc(&vault_path, AssetGcConfig::default()).expect("asset GC");
        assert!(
            !live_path.exists(),
            "GC did not quarantine the zero-ref asset"
        );

        let undone = notes_undo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect("undo remove after GC quarantine");

        assert_eq!(
            undone.workspace.attachments_by_node_id[NODE_ID][0].id,
            ATTACHMENT_ID
        );
        assert!(live_path.exists(), "Undo did not restore quarantined bytes");
    }

    #[test]
    fn notes_attachment_replay_preflight_preserves_all_trash_when_a_later_asset_is_corrupt() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let first_source = write_source(
            &temp_dir,
            "replay-first.png",
            &encoded_dimensions(ImageFormat::Png, 16, 12),
        );
        let second_source = write_source(
            &temp_dir,
            "replay-second.png",
            &encoded_dimensions(ImageFormat::Png, 17, 12),
        );
        notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, first_source),
            None,
        )
        .expect("first import");
        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(SECOND_ATTACHMENT_ID, second_source),
            None,
        )
        .expect("second import");
        let attachments = imported.workspace.attachments_by_node_id[NODE_ID].clone();
        let entry_id = "00000000-0000-4000-8000-000000000099";
        let shared = acquire_notes_connection(&vault_path).expect("history connection");
        let connection = lock_notes_connection(&shared).expect("lock history connection");
        connection
            .execute(
                "INSERT INTO notes_history_entries(id, session_id, sequence, is_undone, estimated_bytes, command_kind) \
                 VALUES (?1, ?2, 1, 1, 0, 'importAttachmentBatch')",
                params![entry_id, SESSION_ID],
            )
            .expect("insert replay entry");
        for (index, attachment) in attachments.iter().enumerate() {
            let snapshot = serde_json::json!({
                "id": attachment.id,
                "node_id": attachment.node_id,
                "sort_key": attachment.sort_key,
                "relative_path": attachment.relative_path,
                "content_hash": attachment.content_hash,
                "original_name": attachment.original_name,
                "mime_type": attachment.mime_type,
                "byte_size": attachment.byte_size,
                "intrinsic_width": attachment.intrinsic_width,
                "intrinsic_height": attachment.intrinsic_height,
                "display_width": attachment.display_width,
                "created_at": attachment.created_at,
                "updated_at": attachment.updated_at
            })
            .to_string();
            connection
                .execute(
                    "INSERT INTO notes_history_changes(entry_id, table_name, row_id, ordinal, before_json, after_json) \
                     VALUES (?1, 'notes_attachments', ?2, ?3, NULL, ?4)",
                    params![
                        entry_id,
                        attachment.id,
                        i64::try_from(index + 1).expect("history ordinal"),
                        snapshot
                    ],
                )
                .expect("insert attachment replay change");
        }
        connection
            .execute("DELETE FROM notes_attachments", [])
            .expect("remove live attachment rows");
        drop(connection);

        // C1: age the now-unreferenced replay assets past the GC minimum so the
        // periodic GC quarantines them instead of deferring the fresh bytes.
        for attachment in &attachments {
            let path = temp_dir
                .path()
                .join(".yonalist")
                .join(&attachment.relative_path);
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .and_then(|file| {
                    file.set_modified(
                        std::time::SystemTime::now() - std::time::Duration::from_secs(25 * 60 * 60),
                    )
                })
                .expect("age replay assets past the GC minimum");
        }

        run_asset_gc(&vault_path, AssetGcConfig::default()).expect("quarantine replay assets");
        let live_paths = attachments
            .iter()
            .map(|attachment| {
                temp_dir
                    .path()
                    .join(".yonalist")
                    .join(&attachment.relative_path)
            })
            .collect::<Vec<_>>();
        let trash_paths = live_paths
            .iter()
            .map(|path| {
                temp_dir
                    .path()
                    .join(".yonalist/asset-trash")
                    .join(path.file_name().expect("asset file name"))
            })
            .collect::<Vec<_>>();
        fs::write(&trash_paths[1], b"corrupt later replay asset")
            .expect("corrupt second quarantined asset");

        let error = notes_redo(
            vault_path.clone(),
            SESSION_ID.to_string(),
            NotesWorkspaceScope::Active,
        )
        .expect_err("later corrupt replay asset must reject the batch");

        assert!(error.to_lowercase().contains("attachment"), "{error}");
        for (live, trash) in live_paths.iter().zip(&trash_paths) {
            assert!(!live.exists(), "failed replay partially restored {live:?}");
            assert!(
                trash.exists(),
                "failed replay retired trash backup {trash:?}"
            );
        }
        let connection = lock_notes_connection(&shared).expect("relock history connection");
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| row
                    .get::<_, i64>(0))
                .expect("attachment count"),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .expect("trash row count"),
            2
        );
    }

    #[test]
    fn notes_attachment_path_prepare_stages_the_validated_snapshot() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        notes_initialize(vault_path.clone()).expect("initialize vault");
        let original = encoded_dimensions(ImageFormat::Png, 8, 6);
        let source = write_source(&temp_dir, "staged.png", &original);
        let prepared = PreparedAttachmentBatch::from_source_paths(&[source.as_str()])
            .expect("prepare staged path attachment");
        fs::write(&source, vec![0_u8; original.len()]).expect("mutate original source");

        let relative_path = publish_attachment_bytes(&vault_path, &prepared.attachments()[0])
            .expect("publish staged snapshot");

        assert_eq!(
            fs::read(temp_dir.path().join(".yonalist").join(relative_path)).unwrap(),
            original
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
        let shared = acquire_notes_connection(&vault_path).expect("connect");
        let mut connection = lock_notes_connection(&shared).expect("lock history");
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
    fn notes_attachment_history_replay_rejects_missing_or_corrupt_owned_bytes_atomically() {
        for (case, replacement) in [
            ("missing", None),
            ("corrupt", Some(b"not an image".as_slice())),
        ] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let vault_path = vault_path(&temp_dir);
            seed_node(&vault_path);
            let png = encoded_dimensions(ImageFormat::Png, 320, 200);
            let source = write_source(&temp_dir, "replay.png", &png);
            let imported = notes_import_attachment(
                vault_path.clone(),
                import_input(ATTACHMENT_ID, source),
                Some(history_context(1, "importAttachment")),
            )
            .expect("journaled import");
            let asset_path = temp_dir
                .path()
                .join(".yonalist")
                .join(&imported.workspace.attachments_by_node_id[NODE_ID][0].relative_path);
            notes_undo(
                vault_path.clone(),
                SESSION_ID.to_string(),
                NotesWorkspaceScope::Active,
            )
            .expect("undo import metadata");
            match replacement {
                Some(bytes) => fs::write(&asset_path, bytes).expect("corrupt owned bytes"),
                None => fs::remove_file(&asset_path).expect("remove owned bytes"),
            }

            let error = notes_redo(
                vault_path.clone(),
                SESSION_ID.to_string(),
                NotesWorkspaceScope::Active,
            )
            .expect_err(&format!("{case} bytes must block metadata replay"));

            assert!(
                error.to_lowercase().contains("attachment"),
                "{case}: {error}"
            );
            let shared =
                acquire_notes_connection(&vault_path).expect("reopen after replay conflict");
            let connection = lock_notes_connection(&shared).expect("lock replay-conflict history");
            assert!(
                load_workspace(&connection, NotesWorkspaceScope::Active)
                    .expect("workspace after replay conflict")
                    .attachments_by_node_id
                    .is_empty(),
                "{case} replay partially restored attachment metadata"
            );
            assert!(
                connection
                    .query_row(
                        "SELECT is_undone FROM notes_history_entries WHERE session_id = ?1",
                        [SESSION_ID],
                        |row| row.get::<_, bool>(0),
                    )
                    .expect("history replay state"),
                "{case} replay advanced history despite validation failure"
            );
        }
    }

    #[test]
    fn notes_attachment_non_attachment_history_eviction_reconciles_only_newly_unreachable_bytes() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = vault_path(&temp_dir);
        seed_node(&vault_path);
        let png = encoded_dimensions(ImageFormat::Png, 320, 200);
        let source = write_source(&temp_dir, "evicted.png", &png);
        let imported = notes_import_attachment(
            vault_path.clone(),
            import_input(ATTACHMENT_ID, source),
            Some(history_context(1, "importAttachment")),
        )
        .expect("journaled import");
        let asset_root = temp_dir.path().join(".yonalist/notes-assets");
        let asset_path = temp_dir
            .path()
            .join(".yonalist")
            .join(&imported.workspace.attachments_by_node_id[NODE_ID][0].relative_path);
        let unrelated = asset_root.join("unrelated-sentinel");
        fs::write(&unrelated, b"not a managed attachment").expect("write unrelated sentinel");
        let connection = connect_notes_db(&vault_path).expect("remove live metadata");
        connection
            .execute(
                "DELETE FROM notes_attachments WHERE id = ?1",
                [ATTACHMENT_ID],
            )
            .expect("leave bytes reachable only from history");
        drop(connection);

        for index in 0..HISTORY_MAX_ENTRIES {
            if index == HISTORY_MAX_ENTRIES - 1 {
                inject_cleanup_failure(CleanupFailurePoint::Reconcile);
            }
            notes_update_node(
                vault_path.clone(),
                UpdateNodeInput {
                    marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                    id: NODE_ID.to_string(),
                    title: format!("ordinary edit {index}"),
                    note: String::new(),
                    image_offset_utf16: 0,
                    markdown_image_width: None,
                },
                Some(history_context(
                    usize::try_from(index + 2).expect("history index"),
                    "updateNode",
                )),
            )
            .expect("ordinary journaled edit");
        }

        assert!(
            asset_path.exists(),
            "injected ordinary cleanup failure did not defer byte removal"
        );
        assert!(
            unrelated.exists(),
            "ordinary mutation performed an unconditional asset directory scan"
        );
        let storage = AttachmentStorageLease::acquire(&vault_path).expect("mutation marker");
        assert!(storage.reconciliation_needed().expect("marker state"));
        drop(storage);
        notes_initialize(vault_path).expect("later mutation reconciliation");
        assert!(!asset_path.exists());
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
            .join(&imported.workspace.attachments_by_node_id[NODE_ID][0].relative_path);

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
            .join(&workspace.workspace.attachments_by_node_id[NODE_ID][0].relative_path);
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

    #[test]
    fn markdown_import_batch_allows_512_unique_assets_without_weakening_paste_cap() {
        use crate::notes::attachment_ingest::RawAttachmentSource;
        use std::path::Path;

        let png = encoded(ImageFormat::Png);
        let general_sources = (1..=129)
            .map(|index| RawAttachmentSource {
                original_name: format!("{index:04}.png"),
                declared_mime_type: "image/png".to_string(),
                bytes: &png,
            })
            .collect::<Vec<_>>();
        assert!(
            PreparedAttachmentBatch::from_bytes(general_sources).is_err(),
            "the existing paste/image-node batch cap accepted 129 assets"
        );

        let too_many_sources = (1..=513)
            .map(|index| RawAttachmentSource {
                original_name: format!("{index:04}.png"),
                declared_mime_type: "image/png".to_string(),
                bytes: &png,
            })
            .collect::<Vec<_>>();
        let permit = super::acquire_attachment_import_permit().expect("import permit");
        assert!(
            PreparedAttachmentBatch::from_markdown_import_bytes_with_import_permit(
                too_many_sources,
                permit,
            )
            .is_err(),
            "the Markdown-import batch accepted 513 distinct assets"
        );

        let (width, height) = (3_000_u32, 1_900_u32);
        let mut pixels = Vec::with_capacity(
            usize::try_from(u64::from(width) * u64::from(height) * 3)
                .expect("large PNG pixel buffer"),
        );
        let mut state = 0x6a09_e667_f3bc_c909_u64;
        for _ in 0..pixels.capacity() {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
            pixels.push((state >> 24) as u8);
        }
        let mut max_sized_png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut max_sized_png, width, height);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .write_header()
                .expect("write aggregate-budget PNG header")
                .write_image_data(&pixels)
                .expect("write aggregate-budget PNG data");
        }
        assert!(
            max_sized_png.len()
                > usize::try_from(super::MAX_ATTACHMENT_BATCH_BYTES / 4)
                    .expect("one quarter of aggregate cap"),
            "aggregate-budget PNG must push four valid sources over 64 MiB"
        );
        assert!(
            max_sized_png.len()
                <= usize::try_from(super::MAX_ATTACHMENT_BYTES).expect("maximum attachment size"),
            "aggregate-budget PNG must fit the per-attachment cap"
        );
        assert!(
            super::validate_image_bytes(
                Path::new("padded.png"),
                &max_sized_png,
                super::ValidationLimits::DEFAULT,
            )
            .is_ok(),
            "aggregate-budget fixture must remain a valid individual PNG"
        );
        let aggregate_sources = (1..=4)
            .map(|index| RawAttachmentSource {
                original_name: format!("aggregate-{index}.png"),
                declared_mime_type: "image/png".to_string(),
                bytes: &max_sized_png,
            })
            .collect::<Vec<_>>();
        let permit = super::acquire_attachment_import_permit().expect("import permit");
        let aggregate_error =
            PreparedAttachmentBatch::from_markdown_import_bytes_with_import_permit(
                aggregate_sources,
                permit,
            )
            .expect_err("aggregate bytes over 64 MiB must fail before image decode");
        assert!(
            aggregate_error.contains("batches must contain at most 67108864 image bytes"),
            "aggregate ceiling used a decoder error instead of the batch budget: {aggregate_error}"
        );

        let boundary_sources = (1..=512)
            .map(|index| RawAttachmentSource {
                original_name: format!("{index:04}.png"),
                declared_mime_type: "image/png".to_string(),
                bytes: &png,
            })
            .collect::<Vec<_>>();
        let permit = super::acquire_attachment_import_permit().expect("import permit");
        let batch = PreparedAttachmentBatch::from_markdown_import_bytes_with_import_permit(
            boundary_sources,
            permit,
        )
        .expect("Markdown import accepts exactly 512 unique assets");
        assert_eq!(batch.attachments().len(), 512);
    }
}
