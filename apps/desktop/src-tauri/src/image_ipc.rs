use notes_application::{
    ImageImportContext, ImageImportSource, ImageSource, MAX_IMAGE_BATCH_BYTES,
    MAX_IMAGE_BATCH_ITEMS, MutationReceipt, NotesError, NotesErrorCode,
};
use notes_core::{MAX_IMAGE_BYTES, NodeId};
use tauri::State;

use super::{DesktopState, run_blocking};

const HEADER_BYTES: usize = 16;
const MAX_METADATA_BYTES: usize = 1024 * 1024;

pub(crate) fn decode_raw_envelope(
    body: &[u8],
) -> Result<(ImageImportContext, Vec<ImageImportSource>), NotesError> {
    if body.len() < HEADER_BYTES || &body[..4] != b"YV2I" {
        return Err(invalid("The image IPC envelope magic is invalid."));
    }
    if read_u16(body, 4)? != 1 {
        return Err(invalid("The image IPC envelope version is unsupported."));
    }
    if read_u16(body, 6)? != 0 {
        return Err(invalid(
            "The image IPC envelope reserved bits must be zero.",
        ));
    }
    let metadata_length = usize::try_from(read_u32(body, 8)?)
        .map_err(|_| invalid("The image IPC metadata length is invalid."))?;
    if metadata_length == 0 || metadata_length > MAX_METADATA_BYTES {
        return Err(invalid("The image IPC metadata length is invalid."));
    }
    let item_count = usize::try_from(read_u32(body, 12)?)
        .map_err(|_| invalid("The image IPC item count is invalid."))?;
    if item_count == 0 || item_count > MAX_IMAGE_BATCH_ITEMS {
        return Err(invalid("The image IPC item count is invalid."));
    }
    let metadata_end = HEADER_BYTES
        .checked_add(metadata_length)
        .filter(|end| *end <= body.len())
        .ok_or_else(|| invalid("The image IPC metadata is truncated."))?;
    let context: ImageImportContext = serde_json::from_slice(&body[HEADER_BYTES..metadata_end])
        .map_err(|_| invalid("The image IPC metadata is malformed."))?;
    if context.items.len() != item_count {
        return Err(invalid(
            "The image IPC item count does not match its metadata.",
        ));
    }

    let mut aggregate = 0_u64;
    for item in &context.items {
        if !(1..=MAX_IMAGE_BYTES).contains(&item.byte_length) {
            return Err(invalid("An image IPC payload exceeds 20 MiB."));
        }
        aggregate = aggregate
            .checked_add(item.byte_length)
            .ok_or_else(|| invalid("The image IPC payload length overflowed."))?;
        if aggregate > MAX_IMAGE_BATCH_BYTES {
            return Err(invalid("The image IPC batch exceeds 64 MiB."));
        }
    }
    let aggregate =
        usize::try_from(aggregate).map_err(|_| invalid("The image IPC payload is too large."))?;
    if body.len().checked_sub(metadata_end) != Some(aggregate) {
        return Err(invalid(
            "The image IPC payload is truncated or contains trailing bytes.",
        ));
    }

    let mut offset = metadata_end;
    let mut sources = Vec::with_capacity(item_count);
    for item in &context.items {
        let length = usize::try_from(item.byte_length)
            .map_err(|_| invalid("The image IPC item length is invalid."))?;
        let end = offset
            .checked_add(length)
            .filter(|end| *end <= body.len())
            .ok_or_else(|| invalid("The image IPC item is truncated."))?;
        sources.push(ImageImportSource {
            node_id: NodeId::try_from(item.node_id.as_str()).map_err(NotesError::from)?,
            original_name: item.original_name.clone(),
            declared_mime_type: item.declared_mime_type.clone(),
            source: ImageSource::Bytes(body[offset..end].to_vec()),
        });
        offset = end;
    }
    Ok((context, sources))
}

#[tauri::command]
pub(crate) async fn notes_import_image_bytes(
    state: State<'_, DesktopState>,
    request: tauri::ipc::Request<'_>,
) -> Result<MutationReceipt, NotesError> {
    let (context, sources) = match request.body() {
        tauri::ipc::InvokeBody::Raw(body) => decode_raw_envelope(body)?,
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(invalid("Notes image imports require a raw IPC body."));
        }
    };
    let gate = std::sync::Arc::clone(&state.runtime);
    run_blocking(move || {
        let runtime = gate.wait()?;
        runtime.clear_initial_boot()?;
        runtime
            .service
            .import_images(context, sources, runtime.assets.as_ref())
    })
    .await
}

#[tauri::command]
pub(crate) async fn notes_read_image(
    state: State<'_, DesktopState>,
    request: notes_application::ImageReadRequest,
) -> Result<tauri::ipc::Response, NotesError> {
    let gate = std::sync::Arc::clone(&state.runtime);
    let bytes = run_blocking(move || {
        let runtime = gate.wait()?;
        runtime.service.read_image(request, runtime.assets.as_ref())
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

fn read_u16(body: &[u8], offset: usize) -> Result<u16, NotesError> {
    let bytes = body
        .get(offset..offset + 2)
        .ok_or_else(|| invalid("The image IPC header is truncated."))?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u32(body: &[u8], offset: usize) -> Result<u32, NotesError> {
    let bytes = body
        .get(offset..offset + 4)
        .ok_or_else(|| invalid("The image IPC header is truncated."))?;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn invalid(message: impl Into<String>) -> NotesError {
    NotesError {
        code: NotesErrorCode::InvalidCommand,
        message: message.into(),
        retryable: false,
    }
}

#[cfg(test)]
mod tests {
    use notes_application::{ImageImportContext, ImageImportItem, ImageSource};

    use super::decode_raw_envelope;

    fn metadata(lengths: &[u64]) -> ImageImportContext {
        ImageImportContext {
            session_id: "session".into(),
            request_id: "request".into(),
            base_revision: 7,
            history_group: Some("images:batch".into()),
            parent_id: "page".into(),
            before_id: Some("next".into()),
            items: lengths
                .iter()
                .enumerate()
                .map(|(index, byte_length)| ImageImportItem {
                    node_id: format!("image-{index}"),
                    original_name: format!("{index}.png"),
                    declared_mime_type: Some("image/png".into()),
                    byte_length: *byte_length,
                })
                .collect(),
        }
    }

    fn envelope(context: &ImageImportContext, payload: &[u8]) -> Vec<u8> {
        let json = serde_json::to_vec(context).expect("serialize metadata");
        let mut envelope = Vec::new();
        envelope.extend_from_slice(b"YV2I");
        envelope.extend_from_slice(&1_u16.to_le_bytes());
        envelope.extend_from_slice(&0_u16.to_le_bytes());
        envelope.extend_from_slice(&(json.len() as u32).to_le_bytes());
        envelope.extend_from_slice(&(context.items.len() as u32).to_le_bytes());
        envelope.extend_from_slice(&json);
        envelope.extend_from_slice(payload);
        envelope
    }

    #[test]
    fn raw_envelope_decodes_owned_sources_in_metadata_order() {
        let body = envelope(&metadata(&[3, 2]), &[1, 2, 3, 4, 5]);

        let (context, sources) = decode_raw_envelope(&body).expect("decode raw envelope");

        assert_eq!(context.base_revision, 7);
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].node_id.as_str(), "image-0");
        assert_eq!(sources[1].node_id.as_str(), "image-1");
        assert!(matches!(&sources[0].source, ImageSource::Bytes(bytes) if bytes == &[1, 2, 3]));
        assert!(matches!(&sources[1].source, ImageSource::Bytes(bytes) if bytes == &[4, 5]));
    }

    #[test]
    fn raw_envelope_rejects_header_metadata_and_length_corruption() {
        let valid = envelope(&metadata(&[3]), &[1, 2, 3]);
        for mutate in [
            |body: &mut Vec<u8>| body[0] = b'X',
            |body: &mut Vec<u8>| body[4..6].copy_from_slice(&2_u16.to_le_bytes()),
            |body: &mut Vec<u8>| body[6..8].copy_from_slice(&1_u16.to_le_bytes()),
            |body: &mut Vec<u8>| body[12..16].copy_from_slice(&2_u32.to_le_bytes()),
        ] {
            let mut body = valid.clone();
            mutate(&mut body);
            assert!(decode_raw_envelope(&body).is_err());
        }

        let mut trailing = valid.clone();
        trailing.push(4);
        assert!(decode_raw_envelope(&trailing).is_err());

        let malformed_json = {
            let mut body = valid.clone();
            body[16] = b'!';
            body
        };
        assert!(decode_raw_envelope(&malformed_json).is_err());
    }
}
