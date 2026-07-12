use crate::notes::attachments::{MAX_ATTACHMENT_BATCH_BYTES, MAX_ATTACHMENT_BYTES};
use crate::notes::types::{validate_note_id, NotesHistoryContext, MAX_NOTE_ATTACHMENTS_PER_NODE};
use serde::Deserialize;
use std::collections::HashSet;

const RAW_ATTACHMENT_MAGIC: &[u8; 4] = b"YNAB";
const RAW_ATTACHMENT_VERSION: u8 = 1;
const RAW_ATTACHMENT_HEADER_BYTES: usize = 9;
pub(crate) const MAX_ATTACHMENT_BATCH_METADATA_BYTES: usize = 256 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportAttachmentBytesMetadata {
    pub(crate) vault_path: String,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes::attachments::{
        PreparedAttachmentBatch, MAX_ATTACHMENT_BATCH_BYTES, MAX_ATTACHMENT_BYTES,
    };
    use crate::notes::types::MAX_NOTE_ATTACHMENTS_PER_NODE;
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
