use crate::notes::attachments::{MAX_ATTACHMENT_BATCH_BYTES, MAX_ATTACHMENT_BYTES};
use crate::notes::repository::validate_vault_path;
use crate::notes::types::{
    deserialize_required_nullable, validate_image_node_batch_fields, validate_note_id,
    ApplyImageAtomPasteInput, ImageAtomPasteFragmentItem, NoteNodeKind, NotesHistoryContext,
    MAX_IMAGE_NODE_IMPORT_ITEMS, MAX_NOTE_ATTACHMENTS_PER_NODE,
};
use serde::Deserialize;
use std::collections::HashSet;

const RAW_ATTACHMENT_MAGIC: &[u8; 4] = b"YNAB";
const RAW_ATTACHMENT_VERSION: u8 = 1;
const RAW_IMAGE_NODE_MAGIC: &[u8; 4] = b"YNIB";
const RAW_IMAGE_NODE_VERSION: u8 = 2;
const RAW_IMAGE_ATOM_PASTE_MAGIC: &[u8; 4] = b"YNAP";
const RAW_IMAGE_ATOM_PASTE_VERSION: u8 = 1;
const RAW_ATTACHMENT_HEADER_BYTES: usize = 9;
pub(crate) const MAX_ATTACHMENT_BATCH_METADATA_BYTES: usize = 256 * 1024;
const MAX_ATTACHMENT_ORIGINAL_NAME_BYTES: usize = 1024;

fn validate_raw_source_metadata(original_name: &str, mime_type: &str) -> Result<(), String> {
    if original_name.trim().is_empty() || original_name.len() > MAX_ATTACHMENT_ORIGINAL_NAME_BYTES {
        return Err(format!(
            "A Notes attachment original name must contain 1 to {MAX_ATTACHMENT_ORIGINAL_NAME_BYTES} bytes."
        ));
    }
    if !matches!(
        mime_type,
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    ) {
        return Err("The Notes attachment MIME type is unsupported.".to_string());
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportAttachmentBytesMetadata {
    pub(crate) vault_path: String,
    #[serde(default)]
    pub(crate) request_id: Option<String>,
    pub(crate) node_id: String,
    pub(crate) attachments: Vec<ImportAttachmentBytesMetadataItem>,
    pub(crate) initial_max_display_width: i64,
    pub(crate) history_context: Option<NotesHistoryContext>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportAttachmentBytesMetadataItem {
    pub(crate) id: String,
    pub(crate) ordinal: u32,
    pub(crate) original_name: String,
    pub(crate) mime_type: String,
    pub(crate) byte_length: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportImageNodeBytesMetadata {
    pub(crate) vault_path: String,
    #[serde(default)]
    pub(crate) request_id: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) parent_id: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) after_id: Option<String>,
    pub(crate) items: Vec<ImportImageNodeBytesMetadataItem>,
    pub(crate) initial_max_display_width: i64,
    pub(crate) history_context: Option<NotesHistoryContext>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportImageNodeBytesMetadataItem {
    pub(crate) node_id: String,
    pub(crate) attachment_id: String,
    pub(crate) ordinal: u32,
    pub(crate) original_name: String,
    pub(crate) mime_type: String,
    pub(crate) byte_length: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageAtomPasteBytesMetadata {
    pub(crate) vault_path: String,
    #[serde(default)]
    pub(crate) request_id: Option<String>,
    #[serde(flatten)]
    pub(crate) input: ApplyImageAtomPasteInput,
    pub(crate) history_context: NotesHistoryContext,
}

#[derive(Debug)]
pub(crate) struct RawAttachmentSource<'a> {
    pub(crate) original_name: String,
    pub(crate) declared_mime_type: String,
    pub(crate) bytes: &'a [u8],
}

#[derive(Debug)]
pub(crate) struct DecodedAttachmentBatch<'a> {
    pub(crate) metadata: ImportAttachmentBytesMetadata,
    pub(crate) sources: Vec<RawAttachmentSource<'a>>,
}

#[derive(Debug)]
pub(crate) struct DecodedImageNodeBatch<'a> {
    pub(crate) metadata: ImportImageNodeBytesMetadata,
    pub(crate) sources: Vec<RawAttachmentSource<'a>>,
}

#[derive(Debug)]
pub(crate) struct DecodedImageAtomPaste<'a> {
    pub(crate) metadata: ImageAtomPasteBytesMetadata,
    pub(crate) sources: Vec<RawAttachmentSource<'a>>,
}

fn validate_image_atom_paste_target(input: &ApplyImageAtomPasteInput) -> Result<(), String> {
    validate_note_id(&input.target.node_id)?;
    if input.target.expected_updated_at.trim().is_empty()
        || input.target.expected_updated_at.contains('\0')
    {
        return Err("The expected Notes image paste update timestamp is invalid.".to_string());
    }
    crate::notes::schema::validate_image_offset_utf16(
        &input.target.expected_title,
        input.target.expected_node_kind,
        input.target.expected_image_offset_utf16,
    )?;
    match (
        input.target.expected_node_kind,
        input.target.expected_primary_attachment_id.as_deref(),
    ) {
        (NoteNodeKind::Text, None) => Ok(()),
        (NoteNodeKind::Image, Some(attachment_id)) => validate_note_id(attachment_id).map_err(|_| {
            "The expected Notes image paste primary attachment ID must be a canonical UUID v4 string."
                .to_string()
        }),
        (NoteNodeKind::Text, Some(_)) => Err(
            "A text Notes image paste target must explicitly have no primary attachment."
                .to_string(),
        ),
        (NoteNodeKind::Image, None) => Err(
            "An image Notes image paste target must name its primary attachment."
                .to_string(),
        ),
    }
}

pub(crate) fn decode_raw_image_atom_paste_envelope(
    body: &[u8],
) -> Result<DecodedImageAtomPaste<'_>, String> {
    let header = body
        .get(..RAW_ATTACHMENT_HEADER_BYTES)
        .ok_or_else(|| "The Notes image atom paste envelope header is truncated.".to_string())?;
    if &header[..4] != RAW_IMAGE_ATOM_PASTE_MAGIC {
        return Err("The Notes image atom paste envelope magic is invalid.".to_string());
    }
    if header[4] != RAW_IMAGE_ATOM_PASTE_VERSION {
        return Err("The Notes image atom paste envelope version is unsupported.".to_string());
    }
    let metadata_length =
        usize::try_from(u32::from_le_bytes(header[5..9].try_into().map_err(
            |_| "The Notes image atom paste metadata length is invalid.".to_string(),
        )?))
        .map_err(|_| "The Notes image atom paste metadata length is too large.".to_string())?;
    if metadata_length > MAX_ATTACHMENT_BATCH_METADATA_BYTES {
        return Err(format!(
            "Notes image atom paste metadata must contain at most {MAX_ATTACHMENT_BATCH_METADATA_BYTES} bytes."
        ));
    }
    let metadata_end = RAW_ATTACHMENT_HEADER_BYTES
        .checked_add(metadata_length)
        .ok_or_else(|| "The Notes image atom paste metadata length overflowed.".to_string())?;
    let metadata_bytes = body
        .get(RAW_ATTACHMENT_HEADER_BYTES..metadata_end)
        .ok_or_else(|| "The Notes image atom paste envelope metadata is truncated.".to_string())?;
    let metadata: ImageAtomPasteBytesMetadata = serde_json::from_slice(metadata_bytes)
        .map_err(|error| format!("Could not decode Notes image atom paste metadata: {error}"))?;
    validate_vault_path(&metadata.vault_path)?;
    if metadata.input.version != 1 {
        return Err("The Notes image atom paste payload version is unsupported.".to_string());
    }
    validate_image_atom_paste_target(&metadata.input)?;
    if metadata.input.initial_max_display_width <= 0 {
        return Err(
            "A Notes image atom paste initial maximum display width must be positive.".to_string(),
        );
    }
    if metadata.input.fragment.is_empty() {
        return Err("A Notes image atom paste must contain at least one fragment.".to_string());
    }

    let mut node_ids = HashSet::new();
    let mut attachment_ids = HashSet::new();
    let mut all_ids = HashSet::new();
    let mut image_count = 0_usize;
    let mut aggregate_bytes = 0_u64;
    for item in &metadata.input.fragment {
        let ImageAtomPasteFragmentItem::Image {
            node_id,
            attachment_id,
            ordinal,
            original_name,
            mime_type,
            byte_length,
        } = item
        else {
            continue;
        };
        validate_raw_source_metadata(original_name, mime_type)?;
        if usize::try_from(*ordinal).ok() != Some(image_count) {
            return Err(
                "Notes image atom paste image ordinals must be contiguous and match source order."
                    .to_string(),
            );
        }
        validate_note_id(node_id).map_err(|_| {
            "A Notes image paste node ID must be a canonical UUID v4 string.".to_string()
        })?;
        validate_note_id(attachment_id).map_err(|_| {
            "A Notes image paste attachment ID must be a canonical UUID v4 string.".to_string()
        })?;
        if node_id == attachment_id
            || !node_ids.insert(node_id.as_str())
            || !attachment_ids.insert(attachment_id.as_str())
            || !all_ids.insert(node_id.as_str())
            || !all_ids.insert(attachment_id.as_str())
        {
            return Err(
                "Notes image atom paste node and attachment IDs must be globally distinct."
                    .to_string(),
            );
        }
        if *byte_length == 0 || *byte_length > MAX_ATTACHMENT_BYTES {
            return Err(format!(
                "Notes image atom paste images must contain between 1 and {MAX_ATTACHMENT_BYTES} bytes."
            ));
        }
        aggregate_bytes = aggregate_bytes
            .checked_add(*byte_length)
            .ok_or_else(|| "The Notes image atom paste byte length overflowed.".to_string())?;
        if aggregate_bytes > MAX_ATTACHMENT_BATCH_BYTES {
            return Err(format!(
                "Notes image atom paste batches must contain at most {MAX_ATTACHMENT_BATCH_BYTES} image bytes."
            ));
        }
        image_count += 1;
        if image_count > MAX_IMAGE_NODE_IMPORT_ITEMS {
            return Err(format!(
                "A Notes image atom paste may contain at most {MAX_IMAGE_NODE_IMPORT_ITEMS} images."
            ));
        }
    }
    if image_count == 0 {
        return Err("A Notes image atom byte paste must contain at least one image.".to_string());
    }

    let mut offset = metadata_end;
    let mut sources = Vec::with_capacity(image_count);
    for item in &metadata.input.fragment {
        let ImageAtomPasteFragmentItem::Image {
            original_name,
            mime_type,
            byte_length,
            ..
        } = item
        else {
            continue;
        };
        let byte_length = usize::try_from(*byte_length)
            .map_err(|_| "A Notes image atom paste byte length is too large.".to_string())?;
        let end = offset
            .checked_add(byte_length)
            .ok_or_else(|| "The Notes image atom paste source offset overflowed.".to_string())?;
        let bytes = body
            .get(offset..end)
            .ok_or_else(|| "The Notes image atom paste envelope body is truncated.".to_string())?;
        sources.push(RawAttachmentSource {
            original_name: original_name.clone(),
            declared_mime_type: mime_type.clone(),
            bytes,
        });
        offset = end;
    }
    if offset != body.len() {
        return Err("The Notes image atom paste envelope contains trailing bytes.".to_string());
    }
    Ok(DecodedImageAtomPaste { metadata, sources })
}

pub(crate) fn decode_raw_attachment_envelope(
    body: &[u8],
) -> Result<DecodedAttachmentBatch<'_>, String> {
    let header = body
        .get(..RAW_ATTACHMENT_HEADER_BYTES)
        .ok_or_else(|| "The Notes attachment envelope header is truncated.".to_string())?;
    if &header[..4] != RAW_ATTACHMENT_MAGIC {
        return Err("The Notes attachment envelope magic is invalid.".to_string());
    }
    if header[4] != RAW_ATTACHMENT_VERSION {
        return Err("The Notes attachment envelope version is unsupported.".to_string());
    }

    let metadata_length =
        usize::try_from(u32::from_le_bytes(header[5..9].try_into().map_err(
            |_| "The Notes attachment metadata length is invalid.".to_string(),
        )?))
        .map_err(|_| "The Notes attachment metadata length is too large.".to_string())?;
    if metadata_length > MAX_ATTACHMENT_BATCH_METADATA_BYTES {
        return Err(format!(
            "Notes attachment batch metadata must contain at most {MAX_ATTACHMENT_BATCH_METADATA_BYTES} bytes."
        ));
    }
    let metadata_end = RAW_ATTACHMENT_HEADER_BYTES
        .checked_add(metadata_length)
        .ok_or_else(|| "The Notes attachment metadata length overflowed.".to_string())?;
    let metadata_bytes = body
        .get(RAW_ATTACHMENT_HEADER_BYTES..metadata_end)
        .ok_or_else(|| "The Notes attachment envelope metadata is truncated.".to_string())?;
    let metadata: ImportAttachmentBytesMetadata = serde_json::from_slice(metadata_bytes)
        .map_err(|error| format!("Could not decode Notes attachment metadata: {error}"))?;

    validate_vault_path(&metadata.vault_path)?;
    if metadata.attachments.is_empty()
        || metadata.attachments.len()
            > usize::try_from(MAX_NOTE_ATTACHMENTS_PER_NODE)
                .map_err(|_| "The Notes attachment item cap is invalid.".to_string())?
    {
        return Err(format!(
            "A Notes attachment batch must contain between 1 and {MAX_NOTE_ATTACHMENTS_PER_NODE} images."
        ));
    }
    validate_note_id(&metadata.node_id)?;
    if metadata.initial_max_display_width <= 0 {
        return Err(
            "A Notes attachment initial maximum display width must be positive.".to_string(),
        );
    }

    let mut ids = HashSet::with_capacity(metadata.attachments.len());
    let mut aggregate_bytes = 0_u64;
    for (index, attachment) in metadata.attachments.iter().enumerate() {
        validate_raw_source_metadata(&attachment.original_name, &attachment.mime_type)?;
        if usize::try_from(attachment.ordinal).ok() != Some(index) {
            return Err(
                "Notes attachment ordinals must be contiguous and match source order.".to_string(),
            );
        }
        validate_note_id(&attachment.id)
            .map_err(|_| "A Notes attachment ID must be a canonical UUID v4 string.".to_string())?;
        if !ids.insert(attachment.id.as_str()) {
            return Err(format!(
                "A Notes attachment batch contains duplicate ID {}.",
                attachment.id
            ));
        }
        if attachment.byte_length == 0 || attachment.byte_length > MAX_ATTACHMENT_BYTES {
            return Err(format!(
                "Notes attachment images must contain between 1 and {MAX_ATTACHMENT_BYTES} bytes."
            ));
        }
        aggregate_bytes = aggregate_bytes
            .checked_add(attachment.byte_length)
            .ok_or_else(|| "The Notes attachment batch byte length overflowed.".to_string())?;
        if aggregate_bytes > MAX_ATTACHMENT_BATCH_BYTES {
            return Err(format!(
                "Notes attachment batches must contain at most {MAX_ATTACHMENT_BATCH_BYTES} image bytes."
            ));
        }
    }

    let mut offset = metadata_end;
    let mut sources = Vec::with_capacity(metadata.attachments.len());
    for attachment in &metadata.attachments {
        let byte_length = usize::try_from(attachment.byte_length)
            .map_err(|_| "A Notes attachment byte length is too large.".to_string())?;
        let end = offset
            .checked_add(byte_length)
            .ok_or_else(|| "The Notes attachment source offset overflowed.".to_string())?;
        let bytes = body
            .get(offset..end)
            .ok_or_else(|| "The Notes attachment envelope body is truncated.".to_string())?;
        sources.push(RawAttachmentSource {
            original_name: attachment.original_name.clone(),
            declared_mime_type: attachment.mime_type.clone(),
            bytes,
        });
        offset = end;
    }
    if offset != body.len() {
        return Err("The Notes attachment envelope contains trailing bytes.".to_string());
    }

    Ok(DecodedAttachmentBatch { metadata, sources })
}

pub(crate) fn decode_raw_image_node_envelope(
    body: &[u8],
) -> Result<DecodedImageNodeBatch<'_>, String> {
    let header = body
        .get(..RAW_ATTACHMENT_HEADER_BYTES)
        .ok_or_else(|| "The Notes image node envelope header is truncated.".to_string())?;
    if &header[..4] != RAW_IMAGE_NODE_MAGIC {
        return Err("The Notes image node envelope magic is invalid.".to_string());
    }
    if header[4] != RAW_IMAGE_NODE_VERSION {
        return Err("The Notes image node envelope version is unsupported.".to_string());
    }

    let metadata_length =
        usize::try_from(u32::from_le_bytes(header[5..9].try_into().map_err(
            |_| "The Notes image node metadata length is invalid.".to_string(),
        )?))
        .map_err(|_| "The Notes image node metadata length is too large.".to_string())?;
    if metadata_length > MAX_ATTACHMENT_BATCH_METADATA_BYTES {
        return Err(format!(
            "Notes image node batch metadata must contain at most {MAX_ATTACHMENT_BATCH_METADATA_BYTES} bytes."
        ));
    }
    let metadata_end = RAW_ATTACHMENT_HEADER_BYTES
        .checked_add(metadata_length)
        .ok_or_else(|| "The Notes image node metadata length overflowed.".to_string())?;
    let metadata_bytes = body
        .get(RAW_ATTACHMENT_HEADER_BYTES..metadata_end)
        .ok_or_else(|| "The Notes image node envelope metadata is truncated.".to_string())?;
    let metadata: ImportImageNodeBytesMetadata = serde_json::from_slice(metadata_bytes)
        .map_err(|error| format!("Could not decode Notes image node metadata: {error}"))?;

    validate_vault_path(&metadata.vault_path)?;
    validate_image_node_batch_fields(
        metadata.parent_id.as_deref(),
        metadata.after_id.as_deref(),
        metadata.initial_max_display_width,
        metadata
            .items
            .iter()
            .map(|item| (item.node_id.as_str(), item.attachment_id.as_str())),
    )?;

    let mut aggregate_bytes = 0_u64;
    for (index, item) in metadata.items.iter().enumerate() {
        validate_raw_source_metadata(&item.original_name, &item.mime_type)?;
        if usize::try_from(item.ordinal).ok() != Some(index) {
            return Err(
                "Notes image node ordinals must be contiguous and match source order.".to_string(),
            );
        }
        if item.byte_length == 0 || item.byte_length > MAX_ATTACHMENT_BYTES {
            return Err(format!(
                "Notes image node images must contain between 1 and {MAX_ATTACHMENT_BYTES} bytes."
            ));
        }
        aggregate_bytes = aggregate_bytes
            .checked_add(item.byte_length)
            .ok_or_else(|| "The Notes image node batch byte length overflowed.".to_string())?;
        if aggregate_bytes > MAX_ATTACHMENT_BATCH_BYTES {
            return Err(format!(
                "Notes image node batches must contain at most {MAX_ATTACHMENT_BATCH_BYTES} image bytes."
            ));
        }
    }

    let mut offset = metadata_end;
    let mut sources = Vec::with_capacity(metadata.items.len());
    for item in &metadata.items {
        let byte_length = usize::try_from(item.byte_length)
            .map_err(|_| "A Notes image node byte length is too large.".to_string())?;
        let end = offset
            .checked_add(byte_length)
            .ok_or_else(|| "The Notes image node source offset overflowed.".to_string())?;
        let bytes = body
            .get(offset..end)
            .ok_or_else(|| "The Notes image node envelope body is truncated.".to_string())?;
        sources.push(RawAttachmentSource {
            original_name: item.original_name.clone(),
            declared_mime_type: item.mime_type.clone(),
            bytes,
        });
        offset = end;
    }
    if offset != body.len() {
        return Err("The Notes image node envelope contains trailing bytes.".to_string());
    }

    Ok(DecodedImageNodeBatch { metadata, sources })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes::attachments::{
        PreparedAttachmentBatch, MAX_ATTACHMENT_BATCH_BYTES, MAX_ATTACHMENT_BYTES,
    };
    use crate::notes::types::{MAX_IMAGE_NODE_IMPORT_ITEMS, MAX_NOTE_ATTACHMENTS_PER_NODE};
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
    use serde_json::{json, Value};
    use std::io::Cursor;
    use std::sync::mpsc;
    use std::time::Duration;

    const NODE_ID: &str = "11111111-1111-4111-8111-111111111111";
    const FIRST_ID: &str = "22222222-2222-4222-8222-222222222222";
    const SECOND_ID: &str = "33333333-3333-4333-8333-333333333333";

    fn fixture_bytes() -> Vec<u8> {
        let hex = include_str!("../../../src/test-fixtures/notes-attachment-batch-v1.hex").trim();
        assert!(hex.len() % 2 == 0, "fixture must contain complete bytes");
        hex.as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let pair = std::str::from_utf8(pair).expect("hex pair");
                u8::from_str_radix(pair, 16).expect("fixture hex")
            })
            .collect()
    }

    fn metadata_item(id: String, ordinal: u32, byte_length: u64) -> Value {
        json!({
            "id": id,
            "ordinal": ordinal,
            "originalName": format!("image-{ordinal}.png"),
            "mimeType": "image/png",
            "byteLength": byte_length
        })
    }

    fn base_metadata() -> Value {
        json!({
            "vaultPath": "/vault",
            "nodeId": NODE_ID,
            "attachments": [
                metadata_item(FIRST_ID.to_string(), 0, 2),
                metadata_item(SECOND_ID.to_string(), 1, 3)
            ],
            "initialMaxDisplayWidth": 480,
            "historyContext": null
        })
    }

    fn envelope(metadata: &Value, body: &[u8]) -> Vec<u8> {
        let metadata = serde_json::to_vec(metadata).expect("encode metadata");
        let mut envelope = Vec::with_capacity(9 + metadata.len() + body.len());
        envelope.extend_from_slice(b"YNAB");
        envelope.push(1);
        envelope.extend_from_slice(
            &u32::try_from(metadata.len())
                .expect("metadata length")
                .to_le_bytes(),
        );
        envelope.extend_from_slice(&metadata);
        envelope.extend_from_slice(body);
        envelope
    }

    fn encoded(format: ImageFormat) -> Vec<u8> {
        let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(2, 3, Rgb([32, 64, 96])));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, format).expect("encode image");
        bytes.into_inner()
    }

    fn source<'a>(name: &str, mime_type: &str, bytes: &'a [u8]) -> RawAttachmentSource<'a> {
        RawAttachmentSource {
            original_name: name.to_string(),
            declared_mime_type: mime_type.to_string(),
            bytes,
        }
    }

    fn image_node_metadata_item(
        node_id: &str,
        attachment_id: &str,
        ordinal: u32,
        byte_length: u64,
    ) -> Value {
        json!({
            "nodeId": node_id,
            "attachmentId": attachment_id,
            "ordinal": ordinal,
            "originalName": format!("image-{ordinal}.png"),
            "mimeType": "image/png",
            "byteLength": byte_length
        })
    }

    fn image_atom_paste_image_metadata_item(
        node_id: &str,
        attachment_id: &str,
        ordinal: u32,
        byte_length: u64,
    ) -> Value {
        json!({
            "kind": "image",
            "nodeId": node_id,
            "attachmentId": attachment_id,
            "ordinal": ordinal,
            "originalName": format!("image-{ordinal}.png"),
            "mimeType": "image/png",
            "byteLength": byte_length
        })
    }

    fn image_node_envelope(metadata: &Value, body: &[u8]) -> Vec<u8> {
        let metadata = serde_json::to_vec(metadata).expect("encode image node metadata");
        let mut envelope = Vec::with_capacity(9 + metadata.len() + body.len());
        envelope.extend_from_slice(b"YNIB");
        envelope.push(2);
        envelope.extend_from_slice(
            &u32::try_from(metadata.len())
                .expect("image node metadata length")
                .to_le_bytes(),
        );
        envelope.extend_from_slice(&metadata);
        envelope.extend_from_slice(body);
        envelope
    }

    fn image_atom_paste_envelope(metadata: &Value, body: &[u8]) -> Vec<u8> {
        let metadata = serde_json::to_vec(metadata).expect("encode image atom paste metadata");
        let mut envelope = Vec::with_capacity(9 + metadata.len() + body.len());
        envelope.extend_from_slice(b"YNAP");
        envelope.push(1);
        envelope.extend_from_slice(
            &u32::try_from(metadata.len())
                .expect("image atom paste metadata length")
                .to_le_bytes(),
        );
        envelope.extend_from_slice(&metadata);
        envelope.extend_from_slice(body);
        envelope
    }

    fn image_atom_paste_metadata() -> Value {
        json!({
            "vaultPath": "/vault",
            "target": {
                "nodeId": NODE_ID,
                "expectedUpdatedAt": "2026-07-18T00:00:00.000Z",
                "expectedNodeKind": "text",
                "expectedTitle": "Target",
                "expectedImageOffsetUtf16": 0,
                "expectedPrimaryAttachmentId": null
            },
            "selection": { "anchorUtf16": 1, "focusUtf16": 1 },
            "version": 1,
            "fragment": [
                { "kind": "text", "text": "before" },
                {
                    "kind": "image",
                    "nodeId": NODE_ID,
                    "attachmentId": FIRST_ID,
                    "ordinal": 0,
                    "originalName": "first.png",
                    "mimeType": "image/png",
                    "byteLength": 2
                },
                { "kind": "text", "text": "after" }
            ],
            "initialMaxDisplayWidth": 480,
            "historyContext": {
                "sessionId": "44444444-4444-4444-8444-444444444444",
                "historyEpoch": "epoch-a",
                "entryId": "55555555-5555-4555-8555-555555555555",
                "commandKind": "imageAtomPaste"
            }
        })
    }

    fn image_node_nullable_anchor_metadata() -> Value {
        json!({
            "vaultPath": "/vault",
            "parentId": null,
            "afterId": null,
            "items": [image_node_metadata_item(NODE_ID, FIRST_ID, 0, 2)],
            "initialMaxDisplayWidth": 480,
            "historyContext": null
        })
    }

    #[test]
    fn image_node_raw_envelope_accepts_explicit_null_anchor_keys() {
        let envelope = image_node_envelope(&image_node_nullable_anchor_metadata(), &[1, 2]);
        let decoded = decode_raw_image_node_envelope(&envelope)
            .expect("decode explicit null image node anchors");

        assert_eq!(decoded.metadata.parent_id, None);
        assert_eq!(decoded.metadata.after_id, None);
    }

    #[test]
    fn raw_ingest_envelopes_preserve_optional_request_ids() {
        let mut attachment = base_metadata();
        attachment["requestId"] = json!("request-attachment");
        assert_eq!(
            decode_raw_attachment_envelope(&envelope(&attachment, &[1, 2, 3, 4, 5]))
                .unwrap()
                .metadata
                .request_id
                .as_deref(),
            Some("request-attachment")
        );

        let mut image_node = image_node_nullable_anchor_metadata();
        image_node["requestId"] = json!("request-image-node");
        assert_eq!(
            decode_raw_image_node_envelope(&image_node_envelope(&image_node, &[1, 2]))
                .unwrap()
                .metadata
                .request_id
                .as_deref(),
            Some("request-image-node")
        );

        let mut image_atom = image_atom_paste_metadata();
        image_atom["requestId"] = json!("request-image-atom");
        assert_eq!(
            decode_raw_image_atom_paste_envelope(&image_atom_paste_envelope(&image_atom, &[1, 2],))
                .unwrap()
                .metadata
                .request_id
                .as_deref(),
            Some("request-image-atom")
        );
    }

    #[test]
    fn image_atom_paste_raw_envelope_requires_complete_byte_free_metadata() {
        let envelope = image_atom_paste_envelope(&image_atom_paste_metadata(), &[1, 2]);
        let decoded = decode_raw_image_atom_paste_envelope(&envelope)
            .expect("decode image atom paste envelope");
        assert_eq!(decoded.metadata.input.fragment.len(), 3);
        assert_eq!(decoded.sources.len(), 1);
        assert_eq!(decoded.sources[0].bytes, &[1, 2]);

        let mut unknown = image_atom_paste_metadata();
        unknown
            .as_object_mut()
            .expect("metadata object")
            .insert("unexpected".to_string(), json!(true));
        let error =
            decode_raw_image_atom_paste_envelope(&image_atom_paste_envelope(&unknown, &[1, 2]))
                .expect_err("unknown field");
        assert!(error.contains("unknown field `unexpected`"), "{error}");

        let mut missing_authority = image_atom_paste_metadata();
        missing_authority["target"]
            .as_object_mut()
            .expect("target")
            .remove("expectedPrimaryAttachmentId");
        let error = decode_raw_image_atom_paste_envelope(&image_atom_paste_envelope(
            &missing_authority,
            &[1, 2],
        ))
        .expect_err("missing explicit null authority");
        assert!(
            error.contains("missing field `expectedPrimaryAttachmentId`"),
            "{error}"
        );

        let mut duplicate = image_atom_paste_metadata();
        duplicate["fragment"] = json!([
            duplicate["fragment"][1].clone(),
            duplicate["fragment"][1].clone()
        ]);
        duplicate["fragment"][1]["ordinal"] = json!(1);
        let error = decode_raw_image_atom_paste_envelope(&image_atom_paste_envelope(
            &duplicate,
            &[1, 2, 3, 4],
        ))
        .expect_err("duplicate cross-namespace IDs");
        assert!(error.contains("globally distinct"), "{error}");

        let mut trailing = envelope;
        trailing.push(3);
        let error = decode_raw_image_atom_paste_envelope(&trailing).expect_err("trailing bytes");
        assert!(error.contains("trailing bytes"), "{error}");
    }

    #[test]
    fn image_atom_paste_raw_envelope_rejects_all_header_and_size_boundaries_before_slicing() {
        let valid = image_atom_paste_envelope(&image_atom_paste_metadata(), &[1, 2]);
        let mut invalid_magic = valid.clone();
        invalid_magic[0] = b'X';
        let mut invalid_version = valid.clone();
        invalid_version[4] = 2;

        let mut sparse_ordinal = image_atom_paste_metadata();
        sparse_ordinal["fragment"][1]["ordinal"] = json!(1);

        let mut truncated = image_atom_paste_metadata();
        truncated["fragment"][1]["byteLength"] = json!(3);

        let mut oversized_item = image_atom_paste_metadata();
        oversized_item["fragment"][1]["byteLength"] = json!(MAX_ATTACHMENT_BYTES + 1);

        let bytes_per_item = MAX_ATTACHMENT_BATCH_BYTES / 4 + 1;
        let mut aggregate = image_atom_paste_metadata();
        aggregate["fragment"] = Value::Array(
            (0..4)
                .map(|index| {
                    image_atom_paste_image_metadata_item(
                        &format!("70000000-0000-4000-8000-{index:012x}"),
                        &format!("80000000-0000-4000-8000-{index:012x}"),
                        u32::try_from(index).expect("ordinal"),
                        bytes_per_item,
                    )
                })
                .collect(),
        );

        let mut too_many_images = image_atom_paste_metadata();
        too_many_images["fragment"] = Value::Array(
            (0..=MAX_IMAGE_NODE_IMPORT_ITEMS)
                .map(|index| {
                    image_atom_paste_image_metadata_item(
                        &format!("90000000-0000-4000-8000-{index:012x}"),
                        &format!("a0000000-0000-4000-8000-{index:012x}"),
                        u32::try_from(index).expect("ordinal"),
                        1,
                    )
                })
                .collect(),
        );

        let mut oversized_metadata = Vec::from(&b"YNAP"[..]);
        oversized_metadata.push(1);
        oversized_metadata.extend_from_slice(
            &u32::try_from(MAX_ATTACHMENT_BATCH_METADATA_BYTES + 1)
                .expect("metadata cap")
                .to_le_bytes(),
        );

        let cases = [
            ("magic", invalid_magic, "magic is invalid"),
            ("version", invalid_version, "version is unsupported"),
            (
                "source ordinal",
                image_atom_paste_envelope(&sparse_ordinal, &[1, 2]),
                "ordinals must be contiguous",
            ),
            (
                "declared length truncation",
                image_atom_paste_envelope(&truncated, &[1, 2]),
                "body is truncated",
            ),
            (
                "20 MiB item cap",
                image_atom_paste_envelope(&oversized_item, &[]),
                "between 1 and 20971520 bytes",
            ),
            (
                "64 MiB aggregate cap",
                image_atom_paste_envelope(&aggregate, &[]),
                "at most 67108864 image bytes",
            ),
            (
                "128 image cap",
                image_atom_paste_envelope(&too_many_images, &[]),
                "at most 128 images",
            ),
            ("metadata cap", oversized_metadata, "at most 262144 bytes"),
        ];
        for (label, envelope, expected) in cases {
            let error = decode_raw_image_atom_paste_envelope(&envelope)
                .expect_err("image atom paste boundary must reject");
            assert!(error.contains(expected), "{label}: {error}");
        }
    }

    #[test]
    fn image_node_raw_envelope_requires_parent_id_key() {
        let mut metadata = image_node_nullable_anchor_metadata();
        metadata
            .as_object_mut()
            .expect("raw metadata object")
            .remove("parentId")
            .expect("remove parentId");
        let envelope = image_node_envelope(&metadata, &[1, 2]);

        let error = decode_raw_image_node_envelope(&envelope).expect_err("missing parentId");

        assert!(error.contains("missing field `parentId`"), "{error}");
    }

    #[test]
    fn image_node_raw_envelope_requires_after_id_key() {
        let mut metadata = image_node_nullable_anchor_metadata();
        metadata
            .as_object_mut()
            .expect("raw metadata object")
            .remove("afterId")
            .expect("remove afterId");
        let envelope = image_node_envelope(&metadata, &[1, 2]);

        let error = decode_raw_image_node_envelope(&envelope).expect_err("missing afterId");

        assert!(error.contains("missing field `afterId`"), "{error}");
    }

    #[test]
    fn image_node_raw_envelope_rejects_unknown_metadata_fields() {
        let mut metadata = image_node_nullable_anchor_metadata();
        metadata
            .as_object_mut()
            .expect("raw metadata object")
            .insert("unexpected".to_string(), json!(true));
        let envelope = image_node_envelope(&metadata, &[1, 2]);

        let error = decode_raw_image_node_envelope(&envelope).expect_err("unknown metadata field");

        assert!(error.contains("unknown field `unexpected`"), "{error}");
    }

    #[test]
    fn image_node_raw_envelope_v2_preserves_shared_anchor_ids_and_source_order() {
        let metadata = json!({
            "vaultPath": "/vault",
            "parentId": NODE_ID,
            "afterId": null,
            "items": [
                image_node_metadata_item(FIRST_ID, SECOND_ID, 0, 2),
                image_node_metadata_item(
                    "44444444-4444-4444-8444-444444444444",
                    "55555555-5555-4555-8555-555555555555",
                    1,
                    3
                )
            ],
            "initialMaxDisplayWidth": 480,
            "historyContext": null
        });
        let envelope = image_node_envelope(&metadata, &[1, 2, 3, 4, 5]);
        let decoded = decode_raw_image_node_envelope(&envelope).expect("decode image node batch");

        assert_eq!(decoded.metadata.parent_id.as_deref(), Some(NODE_ID));
        assert_eq!(decoded.metadata.after_id, None);
        assert_eq!(decoded.metadata.items[0].node_id, FIRST_ID);
        assert_eq!(decoded.metadata.items[0].attachment_id, SECOND_ID);
        assert_eq!(decoded.sources[0].bytes, &[1, 2]);
        assert_eq!(decoded.sources[1].bytes, &[3, 4, 5]);

        let mut legacy_v1 = envelope.clone();
        legacy_v1[..4].copy_from_slice(b"YNAB");
        legacy_v1[4] = 1;
        assert!(decode_raw_image_node_envelope(&legacy_v1).is_err());

        let mut legacy_magic_v2 = envelope.clone();
        legacy_magic_v2[..4].copy_from_slice(b"YNAB");
        assert!(decode_raw_image_node_envelope(&legacy_magic_v2).is_err());
        assert!(decode_raw_attachment_envelope(&envelope).is_err());
    }

    #[test]
    fn image_node_raw_envelope_rejects_duplicate_ids_ordinals_and_length_mismatches() {
        let base = json!({
            "vaultPath": "/vault",
            "parentId": null,
            "afterId": null,
            "items": [
                image_node_metadata_item(NODE_ID, FIRST_ID, 0, 2),
                image_node_metadata_item(SECOND_ID, "44444444-4444-4444-8444-444444444444", 1, 3)
            ],
            "initialMaxDisplayWidth": 480,
            "historyContext": null
        });

        let mut duplicate_node = base.clone();
        duplicate_node["items"][1]["nodeId"] = json!(NODE_ID);
        assert!(decode_raw_image_node_envelope(&image_node_envelope(
            &duplicate_node,
            &[1, 2, 3, 4, 5]
        ))
        .is_err());

        let mut duplicate_attachment = base.clone();
        duplicate_attachment["items"][1]["attachmentId"] = json!(FIRST_ID);
        assert!(decode_raw_image_node_envelope(&image_node_envelope(
            &duplicate_attachment,
            &[1, 2, 3, 4, 5]
        ))
        .is_err());

        let mut non_contiguous = base.clone();
        non_contiguous["items"][1]["ordinal"] = json!(2);
        assert!(decode_raw_image_node_envelope(&image_node_envelope(
            &non_contiguous,
            &[1, 2, 3, 4, 5]
        ))
        .is_err());

        assert!(
            decode_raw_image_node_envelope(&image_node_envelope(&base, &[1, 2, 3, 4])).is_err()
        );
        assert!(
            decode_raw_image_node_envelope(&image_node_envelope(&base, &[1, 2, 3, 4, 5, 6]))
                .is_err()
        );
    }

    #[test]
    fn raw_envelope_preserves_unicode_names_and_source_order() {
        let fixture = fixture_bytes();
        let decoded = decode_raw_attachment_envelope(&fixture).expect("decode fixture");

        assert_eq!(decoded.metadata.vault_path, "/vault");
        assert_eq!(decoded.metadata.node_id, NODE_ID);
        assert_eq!(decoded.sources[0].original_name, "첫째.png");
        assert_eq!(decoded.sources[0].bytes, &[1, 2]);
        assert_eq!(decoded.sources[1].original_name, "둘째.webp");
        assert_eq!(decoded.sources[1].bytes, &[3, 4, 5]);
        assert_eq!(
            decoded.sources[0].bytes.as_ptr(),
            fixture[fixture.len() - 5..].as_ptr(),
            "decoded sources must borrow the raw envelope body"
        );
    }

    #[test]
    fn raw_envelope_rejects_malformed_magic_and_version() {
        let mut malformed_magic = fixture_bytes();
        malformed_magic[0] = b'X';
        assert!(decode_raw_attachment_envelope(&malformed_magic).is_err());

        let mut malformed_version = fixture_bytes();
        malformed_version[4] = 2;
        assert!(decode_raw_attachment_envelope(&malformed_version).is_err());
    }

    #[test]
    fn raw_envelope_rejects_invalid_metadata_lengths() {
        let mut truncated = fixture_bytes();
        truncated[5..9].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(decode_raw_attachment_envelope(&truncated).is_err());

        let mut over_budget = b"YNAB\x01".to_vec();
        over_budget.extend_from_slice(
            &u32::try_from(MAX_ATTACHMENT_BATCH_METADATA_BYTES + 1)
                .expect("metadata cap")
                .to_le_bytes(),
        );
        assert!(decode_raw_attachment_envelope(&over_budget).is_err());
    }

    #[test]
    fn raw_envelope_rejects_trailing_bytes() {
        let mut fixture = fixture_bytes();
        fixture.push(0xff);
        assert!(decode_raw_attachment_envelope(&fixture).is_err());
    }

    #[test]
    fn raw_envelope_rejects_unknown_fields_and_wrong_json_types() {
        let mut unknown = base_metadata();
        unknown
            .as_object_mut()
            .expect("metadata object")
            .insert("unexpected".to_string(), json!(true));
        assert!(decode_raw_attachment_envelope(&envelope(&unknown, &[1, 2, 3, 4, 5])).is_err());

        let mut wrong_type = base_metadata();
        wrong_type["initialMaxDisplayWidth"] = json!("480");
        assert!(decode_raw_attachment_envelope(&envelope(&wrong_type, &[1, 2, 3, 4, 5])).is_err());
    }

    #[test]
    fn raw_envelope_rejects_non_contiguous_and_duplicate_ordinals() {
        let mut non_contiguous = base_metadata();
        non_contiguous["attachments"][1]["ordinal"] = json!(2);
        assert!(
            decode_raw_attachment_envelope(&envelope(&non_contiguous, &[1, 2, 3, 4, 5])).is_err()
        );

        let mut duplicate = base_metadata();
        duplicate["attachments"][1]["ordinal"] = json!(0);
        assert!(decode_raw_attachment_envelope(&envelope(&duplicate, &[1, 2, 3, 4, 5])).is_err());
    }

    #[test]
    fn raw_envelope_rejects_per_image_aggregate_and_item_caps() {
        let mut per_image = base_metadata();
        per_image["attachments"] = json!([metadata_item(
            FIRST_ID.to_string(),
            0,
            MAX_ATTACHMENT_BYTES + 1
        )]);
        assert!(decode_raw_attachment_envelope(&envelope(&per_image, &[])).is_err());

        let mut aggregate = base_metadata();
        aggregate["attachments"] = Value::Array(
            (0..4)
                .map(|index| {
                    metadata_item(
                        format!("22222222-2222-4222-8222-{index:012x}"),
                        index,
                        MAX_ATTACHMENT_BYTES,
                    )
                })
                .collect(),
        );
        assert!(decode_raw_attachment_envelope(&envelope(&aggregate, &[])).is_err());

        let mut too_many = base_metadata();
        too_many["attachments"] = Value::Array(
            (0..=u32::try_from(MAX_NOTE_ATTACHMENTS_PER_NODE).expect("item cap"))
                .map(|index| {
                    metadata_item(format!("22222222-2222-4222-8222-{index:012x}"), index, 1)
                })
                .collect(),
        );
        assert!(decode_raw_attachment_envelope(&envelope(&too_many, &[])).is_err());

        let mut empty = base_metadata();
        empty["attachments"] = json!([]);
        assert!(decode_raw_attachment_envelope(&envelope(&empty, &[])).is_err());
    }

    #[test]
    #[ignore = "allocates an exact 64 MiB raw attachment body; run the focused release command"]
    fn raw_envelope_accepts_exact_64_mib_batch_and_preserves_source_slice_boundaries() {
        const MIB: u64 = 1024 * 1024;
        const SOURCE_LENGTHS: [u64; 4] = [20 * MIB, 20 * MIB, 20 * MIB, 4 * MIB];

        let mut metadata = base_metadata();
        metadata["attachments"] = Value::Array(
            SOURCE_LENGTHS
                .iter()
                .enumerate()
                .map(|(index, byte_length)| {
                    metadata_item(
                        format!("22222222-2222-4222-8222-{index:012x}"),
                        u32::try_from(index).expect("source ordinal"),
                        *byte_length,
                    )
                })
                .collect(),
        );
        let mut raw_envelope = envelope(&metadata, &[]);
        let source_start = raw_envelope.len();
        raw_envelope.resize(
            source_start + usize::try_from(64 * MIB).expect("exact aggregate byte length"),
            0,
        );
        let mut offset = source_start;
        for (index, byte_length) in SOURCE_LENGTHS.iter().enumerate() {
            let end = offset + usize::try_from(*byte_length).expect("source byte length");
            raw_envelope[offset..end].fill(u8::try_from(index + 1).expect("source marker"));
            offset = end;
        }

        let decoded = decode_raw_attachment_envelope(&raw_envelope)
            .expect("the exact 64 MiB aggregate boundary must decode");

        assert_eq!(decoded.sources.len(), SOURCE_LENGTHS.len());
        let mut offset = source_start;
        for (index, (source, byte_length)) in decoded.sources.iter().zip(SOURCE_LENGTHS).enumerate()
        {
            let byte_length = usize::try_from(byte_length).expect("source byte length");
            assert_eq!(source.original_name, format!("image-{index}.png"));
            assert_eq!(source.bytes.len(), byte_length);
            assert_eq!(source.bytes[0], u8::try_from(index + 1).unwrap());
            assert_eq!(
                source.bytes[byte_length - 1],
                u8::try_from(index + 1).unwrap()
            );
            assert_eq!(source.bytes.as_ptr(), raw_envelope[offset..].as_ptr());
            offset += byte_length;
        }
        assert_eq!(offset, raw_envelope.len());
    }

    #[test]
    fn raw_envelope_rejects_exact_64_mib_plus_one_before_publication() {
        const MIB: u64 = 1024 * 1024;
        let mut metadata = base_metadata();
        metadata["attachments"] = Value::Array(
            [20 * MIB, 20 * MIB, 20 * MIB, 4 * MIB + 1]
                .into_iter()
                .enumerate()
                .map(|(index, byte_length)| {
                    metadata_item(
                        format!("22222222-2222-4222-8222-{index:012x}"),
                        u32::try_from(index).expect("source ordinal"),
                        byte_length,
                    )
                })
                .collect(),
        );

        let error = decode_raw_attachment_envelope(&envelope(&metadata, &[]))
            .expect_err("64 MiB plus one byte must fail from declarations alone");

        assert_eq!(
            error,
            "Notes attachment batches must contain at most 67108864 image bytes."
        );
    }

    #[test]
    fn raw_envelope_rejects_duplicate_and_invalid_ids() {
        let mut duplicate = base_metadata();
        duplicate["attachments"][1]["id"] = json!(FIRST_ID);
        assert!(decode_raw_attachment_envelope(&envelope(&duplicate, &[1, 2, 3, 4, 5])).is_err());

        let mut invalid = base_metadata();
        invalid["attachments"][0]["id"] = json!("not-a-uuid");
        assert!(decode_raw_attachment_envelope(&envelope(&invalid, &[1, 2, 3, 4, 5])).is_err());

        let mut invalid_node = base_metadata();
        invalid_node["nodeId"] = json!("not-a-uuid");
        assert!(
            decode_raw_attachment_envelope(&envelope(&invalid_node, &[1, 2, 3, 4, 5])).is_err()
        );
    }

    #[test]
    fn one_batch_budget_can_prepare_multiple_images_without_deadlock() {
        let first = encoded(ImageFormat::Png);
        let second = encoded(ImageFormat::Png);
        let batch = PreparedAttachmentBatch::from_bytes(vec![
            source("first.bin", "image/png", &first),
            source("second.jpg", "image/png", &second),
        ])
        .expect("prepare image batch");

        assert_eq!(batch.attachments()[0].image.mime_type, "image/png");
        assert_eq!(batch.attachments()[1].image.mime_type, "image/png");
    }

    #[test]
    fn byte_preparation_rejects_mime_mismatch() {
        let png = encoded(ImageFormat::Png);
        let error =
            PreparedAttachmentBatch::from_bytes(vec![source("image.png", "image/jpeg", &png)])
                .expect_err("declared MIME must match decoded bytes");
        assert!(error.to_lowercase().contains("mime"), "{error}");
    }

    #[test]
    fn byte_preparation_uses_canonical_extension_from_decoded_format() {
        let jpeg = encoded(ImageFormat::Jpeg);
        let batch = PreparedAttachmentBatch::from_bytes(vec![source(
            "misleading.png",
            "image/jpeg",
            &jpeg,
        )])
        .expect("decoded format is authoritative");

        assert_eq!(batch.attachments()[0].original_name, "misleading.png");
        assert_eq!(batch.attachments()[0].image.extension, "jpg");
    }

    #[test]
    fn second_batch_waits_until_first_prepared_batch_is_dropped() {
        let first_png = encoded(ImageFormat::Png);
        let first =
            PreparedAttachmentBatch::from_bytes(vec![source("first.png", "image/png", &first_png)])
                .expect("first batch");

        let (prepared_tx, prepared_rx) = mpsc::channel();
        let second = std::thread::spawn(move || {
            let second_png = encoded(ImageFormat::Png);
            let batch = PreparedAttachmentBatch::from_bytes(vec![source(
                "second.png",
                "image/png",
                &second_png,
            )])
            .expect("second batch");
            prepared_tx
                .send(batch.attachments().len())
                .expect("send prepared result");
        });

        assert!(
            prepared_rx
                .recv_timeout(Duration::from_millis(100))
                .is_err(),
            "a second batch acquired the live-byte budget too early"
        );
        drop(first);
        assert_eq!(
            prepared_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("second batch proceeds after drop"),
            1
        );
        second.join().expect("second preparation thread");
    }

    #[test]
    fn batch_preparation_rejects_direct_item_and_aggregate_caps() {
        let oversized = vec![0_u8; usize::try_from(MAX_ATTACHMENT_BYTES + 1).expect("byte cap")];
        assert!(PreparedAttachmentBatch::from_bytes(vec![source(
            "oversized.png",
            "image/png",
            &oversized,
        )])
        .is_err());

        let one = vec![0_u8; usize::try_from(MAX_ATTACHMENT_BYTES).expect("byte cap")];
        assert!(PreparedAttachmentBatch::from_bytes(vec![
            source("one.png", "image/png", &one),
            source("two.png", "image/png", &one),
            source("three.png", "image/png", &one),
            source("four.png", "image/png", &one),
        ])
        .is_err());
        assert_eq!(MAX_ATTACHMENT_BATCH_BYTES, 64 * 1024 * 1024);
    }
}
