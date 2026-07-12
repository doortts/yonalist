#[cfg(unix)]
use cap_fs_ext::OpenOptionsExt;
use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
use fs4::FileExt;
use image::codecs::{gif::GifDecoder, webp::WebPDecoder};
use image::{AnimationDecoder, ImageDecoder, ImageFormat, ImageReader, Limits};
use rusqlite::Connection;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use crate::notes::attachment_ingest::RawAttachmentSource;
use crate::notes::types::{ExportAttachment, NoteAttachment};

pub(crate) const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
pub(crate) const MAX_ATTACHMENT_BATCH_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const MAX_ATTACHMENT_PIXELS: u64 = 40_000_000;
pub(crate) const MAX_ATTACHMENT_CONTAINER_CHUNKS: u64 = 100_000;
// Animations retain the static canvas cap and may decode at most four full-size canvases total.
pub(crate) const MAX_ATTACHMENT_FRAMES: u64 = 256;
pub(crate) const MAX_ATTACHMENT_DECODED_PIXEL_WORK: u64 = 160_000_000;
const RECONCILIATION_MARKER: &str = ".notes-assets-reconcile-needed";
static IMPORT_BUDGET_LOCK: Mutex<()> = Mutex::new(());
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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
    pub(crate) bytes: Vec<u8>,
    pub(crate) original_name: String,
    pub(crate) image: ValidatedImage,
}

#[derive(Debug)]
struct AttachmentImportBudget {
    _guard: MutexGuard<'static, ()>,
}

#[derive(Debug)]
pub(crate) struct PreparedAttachmentBatch {
    _budget: AttachmentImportBudget,
    attachments: Vec<PreparedAttachment>,
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
        content_hash: format!("{:x}", Sha256::digest(bytes)),
    })
}

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

fn acquire_import_budget() -> Result<AttachmentImportBudget, String> {
    IMPORT_BUDGET_LOCK
        .lock()
        .map(|guard| AttachmentImportBudget { _guard: guard })
        .map_err(|_| "The Notes attachment import budget is unavailable.".to_string())
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

fn prepare_source_attachment_without_budget(
    source_path: &str,
    remaining_batch_bytes: u64,
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
    maybe_inject_source_growth(path)?;
    let bytes = read_bounded(file, remaining_batch_bytes.min(MAX_ATTACHMENT_BYTES))?;
    let image = validate_image_bytes(path, &bytes, ValidationLimits::DEFAULT)?;
    Ok(PreparedAttachment {
        bytes,
        original_name,
        image,
    })
}

impl PreparedAttachmentBatch {
    pub(crate) fn from_bytes(sources: Vec<RawAttachmentSource<'_>>) -> Result<Self, String> {
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

        let budget = acquire_import_budget()?;
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
                bytes: source.bytes.to_vec(),
                original_name: source.original_name,
                image,
            });
        }
        Ok(Self {
            _budget: budget,
            attachments,
        })
    }

    pub(crate) fn from_source_paths(source_paths: &[&str]) -> Result<Self, String> {
        validate_batch_item_count(source_paths.len())?;
        let budget = acquire_import_budget()?;
        let mut aggregate_bytes = 0_u64;
        let mut attachments = Vec::with_capacity(source_paths.len());
        let mut failures = Vec::new();
        for source_path in source_paths {
            let remaining = MAX_ATTACHMENT_BATCH_BYTES
                .checked_sub(aggregate_bytes)
                .ok_or_else(|| "The Notes attachment batch byte length overflowed.".to_string())?;
            match prepare_source_attachment_without_budget(source_path, remaining) {
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
                        .unwrap_or(source_path);
                    failures.push(format!("{file_name}: {error}"));
                }
            }
        }
        if !failures.is_empty() {
            return Err(failures.join("; "));
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

impl Drop for PreparedAttachmentBatch {
    fn drop(&mut self) {
        // Release prepared byte buffers before the budget guard's field drop.
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

fn file_identity(metadata: &impl MetadataExt) -> FileIdentity {
    FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct VaultStorageIdentity {
    database: FileIdentity,
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
}

#[cfg(test)]
pub(crate) fn inject_cleanup_failure(point: CleanupFailurePoint) {
    INJECTED_CLEANUP_FAILURE.with(|failure| failure.set(Some(point)));
}

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

pub(crate) struct AttachmentStorageLease {
    _lock_file: File,
    vault: Dir,
    metadata: Dir,
    assets: Dir,
    database_path: PathBuf,
    metadata_identity: FileIdentity,
    lock_identity: FileIdentity,
    assets_identity: FileIdentity,
}

impl AttachmentStorageLease {
    pub(crate) fn acquire(vault_path: &str) -> Result<Self, String> {
        let metadata_path = crate::metadata_dir(vault_path);
        fs::create_dir_all(&metadata_path)
            .map_err(|error| format!("Could not create the Notes metadata directory: {error}"))?;
        let vault_path = metadata_path
            .parent()
            .ok_or_else(|| "Could not resolve the Notes vault directory.".to_string())?;
        let vault = Dir::open_ambient_dir(vault_path, ambient_authority())
            .map_err(|error| format!("Could not open the Notes vault directory: {error}"))?;
        let metadata = vault.open_dir_nofollow(".yonalist").map_err(|error| {
            format!(
                "The Notes metadata directory must be an owned directory, not a symlink: {error}"
            )
        })?;
        let metadata_identity =
            file_identity(&metadata.dir_metadata().map_err(|error| {
                format!("Could not inspect the Notes metadata identity: {error}")
            })?);

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
        FileExt::lock(&lock_file)
            .map_err(|error| format!("Could not lock the Notes attachment storage: {error}"))?;
        let lock_identity = file_identity(&lock_file.metadata().map_err(|error| {
            format!("Could not inspect the Notes attachment lock identity: {error}")
        })?);

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
        let assets_identity = file_identity(
            &assets
                .dir_metadata()
                .map_err(|error| format!("Could not inspect the Notes asset identity: {error}"))?,
        );

        Ok(Self {
            _lock_file: lock_file,
            vault,
            metadata,
            assets,
            database_path: metadata_path.join("notes.sqlite"),
            metadata_identity,
            lock_identity,
            assets_identity,
        })
    }

    fn validate_core_identity(&self) -> Result<(), String> {
        let metadata = self.vault.open_dir_nofollow(".yonalist").map_err(|error| {
            format!("Could not revalidate the Notes metadata identity: {error}")
        })?;
        let metadata_identity =
            file_identity(&metadata.dir_metadata().map_err(|error| {
                format!("Could not inspect the Notes metadata identity: {error}")
            })?);
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
        );
        let assets = self
            .metadata
            .open_dir_nofollow("notes-assets")
            .map_err(|error| format!("Could not revalidate the Notes asset identity: {error}"))?;
        let assets_identity = file_identity(
            &assets
                .dir_metadata()
                .map_err(|error| format!("Could not inspect the Notes asset identity: {error}"))?,
        );
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
            .metadata
            .open_with("notes.sqlite", &options)
            .map_err(|error| format!("Could not open the Notes database identity: {error}"))?;
        let database_metadata = database
            .metadata()
            .map_err(|error| format!("Could not inspect the Notes database identity: {error}"))?;
        if !database_metadata.is_file() {
            return Err("The Notes database identity must be a regular file.".to_string());
        }
        Ok(VaultStorageIdentity {
            database: file_identity(&database_metadata),
        })
    }

    pub(crate) fn validate_identity(&self, identity: &VaultStorageIdentity) -> Result<(), String> {
        self.validate_core_identity()?;
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let database = self
            .metadata
            .open_with("notes.sqlite", &options)
            .map_err(|error| {
                format!("Could not revalidate the Notes database identity: {error}")
            })?;
        let current =
            file_identity(&database.metadata().map_err(|error| {
                format!("Could not inspect the Notes database identity: {error}")
            })?);
        if current != identity.database {
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

    pub(crate) fn prepare_source_attachment(
        &self,
        source_path: &str,
    ) -> Result<PreparedAttachmentBatch, String> {
        PreparedAttachmentBatch::from_source_paths(&[source_path])
    }

    fn open_owned_file(&self, file_name: &str) -> Result<cap_std::fs::File, String> {
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        self.assets
            .open_with(file_name, &options)
            .map_err(|error| format!("Could not open the Notes attachment image: {error}"))
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

    pub(crate) fn publish_attachment_bytes(
        &self,
        prepared: &PreparedAttachment,
    ) -> Result<String, String> {
        self.publish_attachment_bytes_with_identity(prepared, None)
    }

    pub(crate) fn publish_attachment_bytes_for_import(
        &self,
        prepared: &PreparedAttachment,
        identity: &VaultStorageIdentity,
    ) -> Result<String, String> {
        self.publish_attachment_bytes_with_identity(prepared, Some(identity))
    }

    fn publish_attachment_bytes_with_identity(
        &self,
        prepared: &PreparedAttachment,
        identity: Option<&VaultStorageIdentity>,
    ) -> Result<String, String> {
        match identity {
            Some(identity) => self.validate_identity(identity)?,
            None => self.validate_core_identity()?,
        }
        let relative_path =
            canonical_relative_path(&prepared.image.content_hash, prepared.image.mime_type)?;
        let target_name = safe_owned_file_name(&relative_path)?.to_string();
        if let Ok(existing) = self.open_owned_file(&target_name) {
            let existing = read_bounded(existing, MAX_ATTACHMENT_BYTES)?;
            if format!("{:x}", Sha256::digest(&existing)) == prepared.image.content_hash {
                return Ok(relative_path);
            }
        }

        let (temporary_name, mut temporary) = (0..100)
            .find_map(|_| {
                let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
                let name = format!(".attachment-{}-{sequence}", std::process::id());
                let mut options = OpenOptions::new();
                options
                    .write(true)
                    .create_new(true)
                    .follow(FollowSymlinks::No);
                match self.assets.open_with(&name, &options) {
                    Ok(file) => Some(Ok((name, file))),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                    Err(error) => Some(Err(error)),
                }
            })
            .transpose()
            .map_err(|error| {
                format!("Could not create a Notes attachment temporary file: {error}")
            })?
            .ok_or_else(|| {
                "Could not allocate a unique Notes attachment temporary file.".to_string()
            })?;

        let publish_result = (|| {
            temporary.write_all(&prepared.bytes).map_err(|error| {
                format!("Could not write a Notes attachment temporary file: {error}")
            })?;
            temporary
                .flush()
                .and_then(|_| temporary.sync_all())
                .map_err(|error| {
                    format!("Could not sync a Notes attachment temporary file: {error}")
                })?;
            drop(temporary);
            match identity {
                Some(identity) => self.validate_identity(identity)?,
                None => self.validate_core_identity()?,
            }
            self.assets
                .rename(&temporary_name, &self.assets, &target_name)
                .map_err(|error| {
                    format!("Could not publish the Notes attachment atomically: {error}")
                })?;
            self.sync_directory()?;
            Ok(relative_path)
        })();
        if publish_result.is_err() {
            let _ = self.assets.remove_file_or_symlink(&temporary_name);
        }
        publish_result
    }

    pub(crate) fn read_validated_attachment_bytes(
        &self,
        attachment: &NoteAttachment,
    ) -> Result<Vec<u8>, String> {
        self.read_validated_attachment_fields(
            &attachment.relative_path,
            &attachment.content_hash,
            &attachment.mime_type,
            attachment.byte_size,
            attachment.intrinsic_width,
            attachment.intrinsic_height,
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
            attachment.byte_size,
            attachment.intrinsic_width,
            attachment.intrinsic_height,
        )
    }

    fn read_validated_attachment_fields(
        &self,
        relative_path: &str,
        content_hash: &str,
        mime_type: &str,
        byte_size: i64,
        intrinsic_width: i64,
        intrinsic_height: i64,
    ) -> Result<Vec<u8>, String> {
        resolve_owned_asset_path(Path::new("."), relative_path, content_hash, mime_type)?;
        let file_name = safe_owned_file_name(relative_path)?;
        let file = self.open_owned_file(file_name)?;
        if !file
            .metadata()
            .map_err(|error| format!("Could not inspect the Notes attachment file: {error}"))?
            .is_file()
        {
            return Err("A Notes attachment owned path must contain a regular file.".to_string());
        }
        let bytes = read_bounded(file, MAX_ATTACHMENT_BYTES)?;
        let validated =
            validate_image_bytes(Path::new(relative_path), &bytes, ValidationLimits::DEFAULT)?;
        if validated.content_hash != content_hash
            || validated.mime_type != mime_type
            || validated.byte_size != byte_size as u64
            || i64::from(validated.width) != intrinsic_width
            || i64::from(validated.height) != intrinsic_height
        {
            return Err(
                "The Notes attachment file no longer matches its stored metadata.".to_string(),
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

impl AttachmentStorageLease {
    pub(crate) fn reconcile_attachment_files(
        &self,
        connection: &Connection,
    ) -> Result<usize, String> {
        maybe_inject_cleanup_failure(CleanupFailurePoint::Reconcile)?;
        let reachable = reachable_asset_paths(connection)?;
        let entries = self.assets.entries().map_err(|error| {
            format!("Could not inspect the Notes attachment directory: {error}")
        })?;
        let mut removed = 0;
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("Could not inspect a Notes attachment file: {error}"))?;
            if entry
                .file_type()
                .map_err(|error| format!("Could not inspect a Notes attachment entry: {error}"))?
                .is_dir()
            {
                continue;
            }
            let file_name = entry.file_name();
            let relative = file_name
                .to_str()
                .map(|name| format!("notes-assets/{name}"));
            if relative
                .as_ref()
                .is_some_and(|path| reachable.contains(path))
            {
                continue;
            }
            maybe_inject_cleanup_failure(CleanupFailurePoint::Remove)?;
            self.assets
                .remove_file_or_symlink(&file_name)
                .map_err(|error| {
                    format!("Could not remove an unreferenced Notes attachment: {error}")
                })?;
            removed += 1;
        }
        self.sync_cleanup_directory()?;
        Ok(removed)
    }

    pub(crate) fn reconcile_attachment_candidates(
        &self,
        connection: &Connection,
        candidates: &[String],
    ) -> Result<usize, String> {
        maybe_inject_cleanup_failure(CleanupFailurePoint::Reconcile)?;
        let mut removed = 0;
        for relative_path in candidates {
            let file_name = safe_owned_file_name(relative_path)?;
            if attachment_path_is_reachable(connection, relative_path)? {
                continue;
            }
            maybe_inject_cleanup_failure(CleanupFailurePoint::Remove)?;
            match self.assets.remove_file_or_symlink(file_name) {
                Ok(()) => removed += 1,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "Could not remove an evicted Notes attachment: {error}"
                    ))
                }
            }
        }
        if removed > 0 {
            self.sync_cleanup_directory()?;
        }
        Ok(removed)
    }

    pub(crate) fn delete_attachment_files(self) -> Result<(), String> {
        let Self {
            _lock_file,
            vault: _vault,
            metadata,
            assets,
            database_path: _,
            metadata_identity: _,
            lock_identity: _,
            assets_identity: _,
        } = self;
        let result = (|| {
            let entries = assets.entries().map_err(|error| {
                format!("Could not enumerate Notes attachment files for deletion: {error}")
            })?;
            for entry in entries {
                let entry = entry.map_err(|error| {
                    format!("Could not inspect a Notes attachment for deletion: {error}")
                })?;
                let file_name = entry.file_name();
                let relative_path = file_name
                    .to_str()
                    .map(|name| format!("notes-assets/{name}"))
                    .ok_or_else(|| {
                        "A Notes attachment file name must be UTF-8 before deletion.".to_string()
                    })?;
                safe_owned_file_name(&relative_path)?;
                if !entry
                    .file_type()
                    .map_err(|error| format!("Could not inspect a Notes attachment type: {error}"))?
                    .is_file()
                {
                    return Err(
                        "Notes attachment deletion found a non-regular owned entry.".to_string()
                    );
                }
                let mut options = OpenOptions::new();
                options.read(true).follow(FollowSymlinks::No);
                let file = assets.open_with(&file_name, &options).map_err(|error| {
                    format!("Could not open a Notes attachment before deletion: {error}")
                })?;
                if !file
                    .metadata()
                    .map_err(|error| {
                        format!("Could not verify a Notes attachment before deletion: {error}")
                    })?
                    .is_file()
                {
                    return Err(
                        "Notes attachment deletion requires a verified regular file.".to_string(),
                    );
                }
                maybe_inject_cleanup_failure(CleanupFailurePoint::Remove)?;
                assets.remove_file(&file_name).map_err(|error| {
                    format!("Could not remove a verified Notes attachment: {error}")
                })?;
            }
            maybe_inject_cleanup_failure(CleanupFailurePoint::Sync)?;
            assets
                .try_clone()
                .and_then(|directory| directory.into_std_file().sync_all())
                .map_err(|error| format!("Could not sync deleted Notes attachments: {error}"))?;
            drop(assets);
            metadata.remove_dir("notes-assets").map_err(|error| {
                format!("Could not remove the empty Notes asset directory: {error}")
            })?;
            match metadata.remove_file_or_symlink(RECONCILIATION_MARKER) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "Could not clear the Notes attachment reconciliation marker: {error}"
                    ))
                }
            }
            sync_capability_directory(&metadata)?;
            Ok(())
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
        canonical_relative_path, inject_cleanup_failure, inject_source_growth,
        prepare_source_attachment, prepare_source_attachment_without_budget,
        publish_attachment_bytes, resolve_owned_asset_path, validate_decoded_dimensions,
        validate_image_bytes, AttachmentStorageLease, CleanupFailurePoint, ValidationLimits,
    };
    use crate::notes::commands::{
        notes_clear_history, notes_delete_database, notes_empty_trash, notes_import_attachment,
        notes_initialize, notes_read_attachment_bytes, notes_redo, notes_remove_attachment,
        notes_resize_attachment, notes_restore_attachment, notes_undo, notes_update_node,
    };
    use crate::notes::history::HISTORY_MAX_ENTRIES;
    use crate::notes::history::{redo, undo};
    use crate::notes::repository::{
        archive_node, connect_notes_db, create_attachment_coordinated, create_node, load_workspace,
        remove_empty_node, restore_node, soft_delete_node, unarchive_node,
    };
    use crate::notes::types::{
        CreateNodeInput, ImportAttachmentInput, NotesHistoryContext, NotesWorkspaceScope,
        ResizeAttachmentInput, UpdateNodeInput,
    };
    use image::codecs::gif::GifEncoder;
    use image::{DynamicImage, Frame, ImageFormat, Rgba, RgbaImage};
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
            prepare_source_attachment(&symlink_path.to_string_lossy()).is_err(),
            "source import followed a symlink"
        );

        let fifo_path = temp_dir.path().join("source-fifo.png");
        let status = Command::new("mkfifo")
            .arg(&fifo_path)
            .status()
            .expect("run mkfifo");
        assert!(status.success(), "mkfifo failed");
        let started = Instant::now();
        assert!(prepare_source_attachment(&fifo_path.to_string_lossy()).is_err());
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
                .send(prepared.attachments()[0].bytes.len())
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
    fn notes_attachment_storage_and_sqlite_locks_cover_publication_through_metadata_commit() {
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
                assert!(
                    sqlite_contender.execute_batch("BEGIN IMMEDIATE").is_err(),
                    "publication occurred without the SQLite write lock"
                );

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

        notes_delete_database(vault_path.clone()).expect("delete database and regular assets");

        assert!(!temp_dir.path().join(".yonalist/notes.sqlite").exists());
        assert!(!temp_dir.path().join(".yonalist/notes-assets").exists());
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

        assert!(!temp_dir.path().join(".yonalist/notes.sqlite").exists());
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
        let mut connection = connect_notes_db(&vault_path).expect("connect history");
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
        let mut connection = connect_notes_db(&vault_path).expect("connect resize history");
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
            let connection = connect_notes_db(&vault_path).expect("reopen after replay conflict");
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
                    id: NODE_ID.to_string(),
                    title: format!("ordinary edit {index}"),
                    note: String::new(),
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
}
