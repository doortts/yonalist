use notes_application::{
    ImageImportSource, ImageReplaceContext, ImageReplacePathRequest, ImageSource, MutationReceipt,
    NotesError,
};
use notes_core::{MAX_IMAGE_BYTES, NodeId};
use tauri::State;

use super::image_ipc::{invalid, path_source, read_u16, read_u32};
use super::{DesktopState, run_blocking};

const HEADER_BYTES: usize = 16;
const MAX_METADATA_BYTES: usize = 1024 * 1024;

fn decode_replace_envelope(
    body: &[u8],
) -> Result<(ImageReplaceContext, ImageImportSource), NotesError> {
    if body.len() < HEADER_BYTES || &body[..4] != b"YV2I" {
        return Err(invalid("The image replacement envelope magic is invalid."));
    }
    if read_u16(body, 4)? != 1 || read_u16(body, 6)? != 0 {
        return Err(invalid(
            "The image replacement envelope version is invalid.",
        ));
    }
    let metadata_length = usize::try_from(read_u32(body, 8)?)
        .map_err(|_| invalid("The image replacement metadata length is invalid."))?;
    if metadata_length == 0 || metadata_length > MAX_METADATA_BYTES || read_u32(body, 12)? != 1 {
        return Err(invalid("An image replacement requires exactly one item."));
    }
    let metadata_end = HEADER_BYTES
        .checked_add(metadata_length)
        .filter(|end| *end <= body.len())
        .ok_or_else(|| invalid("The image replacement metadata is truncated."))?;
    let context: ImageReplaceContext = serde_json::from_slice(&body[HEADER_BYTES..metadata_end])
        .map_err(|_| invalid("The image replacement metadata is malformed."))?;
    if context.target_id != context.item.node_id {
        return Err(invalid(
            "The image replacement target identity does not match.",
        ));
    }
    if !(1..=MAX_IMAGE_BYTES).contains(&context.item.byte_length)
        || body.len().checked_sub(metadata_end) != usize::try_from(context.item.byte_length).ok()
    {
        return Err(invalid("The image replacement payload length is invalid."));
    }
    let node_id = NodeId::try_from(context.item.node_id.as_str()).map_err(NotesError::from)?;
    let source = ImageImportSource {
        node_id,
        original_name: context.item.original_name.clone(),
        declared_mime_type: context.item.declared_mime_type.clone(),
        source: ImageSource::Bytes(body[metadata_end..].to_vec()),
    };
    Ok((context, source))
}

#[tauri::command]
pub(crate) async fn notes_replace_image_bytes(
    state: State<'_, DesktopState>,
    request: tauri::ipc::Request<'_>,
) -> Result<MutationReceipt, NotesError> {
    let (context, source) = match request.body() {
        tauri::ipc::InvokeBody::Raw(body) => decode_replace_envelope(body)?,
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(invalid("Notes image replacements require a raw IPC body."));
        }
    };
    let gate = std::sync::Arc::clone(&state.runtime);
    run_blocking(move || {
        let runtime = gate.wait()?;
        runtime.clear_initial_boot()?;
        runtime.changed(
            runtime
                .service
                .replace_image(context, source, runtime.assets.as_ref()),
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn notes_replace_image_path(
    state: State<'_, DesktopState>,
    request: ImageReplacePathRequest,
) -> Result<MutationReceipt, NotesError> {
    let gate = std::sync::Arc::clone(&state.runtime);
    run_blocking(move || {
        let (item, source) = path_source(request.target_id.clone(), request.path)?;
        let context = ImageReplaceContext {
            session_id: request.session_id,
            request_id: request.request_id,
            base_revision: request.base_revision,
            history_group: request.history_group,
            target_id: request.target_id,
            item,
        };
        let runtime = gate.wait()?;
        runtime.clear_initial_boot()?;
        runtime.changed(
            runtime
                .service
                .replace_image(context, source, runtime.assets.as_ref()),
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use notes_application::{ImageImportItem, ImageReplaceContext, ImageSource};

    use super::decode_replace_envelope;

    #[test]
    fn replacement_envelope_binds_one_target_to_one_raw_payload() {
        let context = ImageReplaceContext {
            session_id: "session".into(),
            request_id: "replace".into(),
            base_revision: 8,
            history_group: Some("images:replace".into()),
            target_id: "image".into(),
            item: ImageImportItem {
                node_id: "image".into(),
                original_name: "replacement.png".into(),
                declared_mime_type: Some("image/png".into()),
                byte_length: 3,
            },
        };
        let json = serde_json::to_vec(&context).unwrap();
        let mut body = Vec::new();
        body.extend_from_slice(b"YV2I");
        body.extend_from_slice(&1_u16.to_le_bytes());
        body.extend_from_slice(&0_u16.to_le_bytes());
        body.extend_from_slice(&(json.len() as u32).to_le_bytes());
        body.extend_from_slice(&1_u32.to_le_bytes());
        body.extend_from_slice(&json);
        body.extend_from_slice(&[7, 8, 9]);

        let (decoded, source) = decode_replace_envelope(&body).unwrap();

        assert_eq!(decoded.target_id, "image");
        assert!(matches!(source.source, ImageSource::Bytes(bytes) if bytes == [7, 8, 9]));
    }
}
