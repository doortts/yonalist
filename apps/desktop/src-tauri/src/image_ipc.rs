use notes_application::{
    ImageImportContext, ImageImportItem, ImageImportSource, ImagePathImportRequest, ImageSource,
    MAX_IMAGE_BATCH_BYTES, MAX_IMAGE_BATCH_ITEMS, MutationReceipt, NotesError, NotesErrorCode,
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
pub(crate) async fn notes_import_image_paths(
    state: State<'_, DesktopState>,
    request: ImagePathImportRequest,
) -> Result<MutationReceipt, NotesError> {
    let gate = std::sync::Arc::clone(&state.runtime);
    run_blocking(move || {
        let (context, sources) = path_import_sources(request)?;
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

fn path_import_sources(
    request: ImagePathImportRequest,
) -> Result<(ImageImportContext, Vec<ImageImportSource>), NotesError> {
    if request.images.is_empty() || request.images.len() > MAX_IMAGE_BATCH_ITEMS {
        return Err(invalid(
            "An image path batch must contain between 1 and 128 images.",
        ));
    }
    let mut items = Vec::with_capacity(request.images.len());
    let mut sources = Vec::with_capacity(request.images.len());
    let mut aggregate = 0_u64;
    for image in request.images {
        let (item, source) = path_source(image.node_id, image.path)?;
        let byte_length = item.byte_length;
        aggregate = aggregate
            .checked_add(byte_length)
            .ok_or_else(|| invalid("The image path batch length overflowed."))?;
        if aggregate > MAX_IMAGE_BATCH_BYTES {
            return Err(invalid("The image path batch exceeds 64 MiB."));
        }
        items.push(item);
        sources.push(source);
    }
    Ok((
        ImageImportContext {
            session_id: request.session_id,
            request_id: request.request_id,
            base_revision: request.base_revision,
            history_group: request.history_group,
            parent_id: request.parent_id,
            before_id: request.before_id,
            items,
        },
        sources,
    ))
}

pub(super) fn path_source(
    node_id: String,
    path: String,
) -> Result<(ImageImportItem, ImageImportSource), NotesError> {
    let path = std::path::PathBuf::from(path);
    if !path.is_absolute() {
        return Err(invalid("Notes image paths must be absolute."));
    }
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|error| unavailable(format!("The image path is unavailable: {error}")))?;
    if !metadata.is_file() {
        return Err(invalid("The selected image is not a regular file."));
    }
    let byte_length = metadata.len();
    if !(1..=MAX_IMAGE_BYTES).contains(&byte_length) {
        return Err(invalid("An image must be between 1 byte and 20 MiB."));
    }
    let original_name = path
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| invalid("The image filename is invalid."))?
        .to_owned();
    let parsed_id = NodeId::try_from(node_id.as_str()).map_err(NotesError::from)?;
    Ok((
        ImageImportItem {
            node_id,
            original_name: original_name.clone(),
            declared_mime_type: None,
            byte_length,
        },
        ImageImportSource {
            node_id: parsed_id,
            original_name,
            declared_mime_type: None,
            source: ImageSource::Path(path),
        },
    ))
}

pub(super) fn read_u16(body: &[u8], offset: usize) -> Result<u16, NotesError> {
    let bytes = body
        .get(offset..offset + 2)
        .ok_or_else(|| invalid("The image IPC header is truncated."))?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

pub(super) fn read_u32(body: &[u8], offset: usize) -> Result<u32, NotesError> {
    let bytes = body
        .get(offset..offset + 4)
        .ok_or_else(|| invalid("The image IPC header is truncated."))?;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

pub(super) fn invalid(message: impl Into<String>) -> NotesError {
    NotesError {
        code: NotesErrorCode::InvalidCommand,
        message: message.into(),
        retryable: false,
    }
}

fn unavailable(message: impl Into<String>) -> NotesError {
    NotesError {
        code: NotesErrorCode::StorageUnavailable,
        message: message.into(),
        retryable: true,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use notes_application::{
        ImageImportContext, ImageImportItem, ImagePathImportItem, ImagePathImportRequest,
        ImageSource,
    };

    use super::{decode_raw_envelope, path_import_sources};

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

    #[test]
    fn native_paths_become_owned_sources_in_request_order() {
        let root =
            std::env::temp_dir().join(format!("yonalist-v2-path-import-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).expect("create path import fixture");
        let first = root.join("cat.png");
        let second = root.join("dog.webp");
        fs::write(&first, [1, 2, 3]).expect("write first fixture");
        fs::write(&second, [4, 5]).expect("write second fixture");
        let request = ImagePathImportRequest {
            session_id: "session".into(),
            request_id: "request".into(),
            base_revision: 7,
            history_group: Some("images:batch".into()),
            parent_id: "page".into(),
            before_id: Some("next".into()),
            images: vec![
                ImagePathImportItem {
                    node_id: "cat".into(),
                    path: first.to_string_lossy().into_owned(),
                },
                ImagePathImportItem {
                    node_id: "dog".into(),
                    path: second.to_string_lossy().into_owned(),
                },
            ],
        };

        let (context, sources) = path_import_sources(request).expect("convert native paths");

        assert_eq!(context.items[0].original_name, "cat.png");
        assert_eq!(context.items[0].byte_length, 3);
        assert_eq!(context.items[1].original_name, "dog.webp");
        assert!(matches!(&sources[0].source, ImageSource::Path(path) if path == &first));
        assert!(matches!(&sources[1].source, ImageSource::Path(path) if path == &second));
        fs::remove_dir_all(root).expect("remove path import fixture");
    }

    #[test]
    fn native_path_import_rejects_relative_paths() {
        let request = ImagePathImportRequest {
            session_id: "session".into(),
            request_id: "request".into(),
            base_revision: 7,
            history_group: None,
            parent_id: "page".into(),
            before_id: None,
            images: vec![ImagePathImportItem {
                node_id: "cat".into(),
                path: "cat.png".into(),
            }],
        };

        assert!(path_import_sources(request).is_err());
    }
}
