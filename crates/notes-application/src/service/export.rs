use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, PoisonError};

use notes_core::NodeId;

use super::NotesService;
use crate::{
    ExportError, ExportFormat, ExportImage, ExportNode, ExportPublicationPort, ExportRendererPort,
    ExportSnapshotPort, ImageAssetPort, NotesError, NotesExportRequest, NotesExportResult,
    StoragePort,
};

impl<S> NotesService<S>
where
    S: StoragePort + ExportSnapshotPort,
{
    pub fn export<A, R, P>(
        &self,
        request: NotesExportRequest,
        assets: &A,
        renderer: &R,
        publisher: &P,
    ) -> Result<NotesExportResult, NotesError>
    where
        A: ImageAssetPort,
        R: ExportRendererPort,
        P: ExportPublicationPort,
    {
        let session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        self.ensure_session(&session, &request.session_id)?;
        self.ensure_revision(&session, request.base_revision)?;
        drop(session);

        let root_id = NodeId::try_from(request.root_node_id.as_str())?;
        let destination = Path::new(&request.destination_path);
        let asset_directory_name = match request.format {
            ExportFormat::Markdown => Some(markdown_asset_directory_name(destination)?),
            ExportFormat::Pdf => None,
        };
        let mut snapshot = self
            .storage
            .load_export_snapshot(request.base_revision, &root_id)?;
        if snapshot.revision != request.base_revision || snapshot.root_node_id != root_id {
            return Err(ExportError::Failed(
                "The Notes export snapshot did not match the requested revision and root.".into(),
            )
            .into());
        }
        hydrate_images(&mut snapshot.root, assets, &mut HashMap::new())?;
        let rendered =
            renderer.render(&snapshot, request.format, asset_directory_name.as_deref())?;
        publisher.publish(destination, &rendered, request.overwrite)?;

        Ok(NotesExportResult {
            revision: snapshot.revision,
            root_node_id: request.root_node_id,
            format: request.format,
            destination_path: request.destination_path,
        })
    }
}

fn markdown_asset_directory_name(destination: &Path) -> Result<String, ExportError> {
    let stem = destination
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ExportError::InvalidDestination(
                "Markdown export requires a destination with a UTF-8 file name.".into(),
            )
        })?;
    Ok(format!("{stem}_assets"))
}

fn hydrate_images<A: ImageAssetPort>(
    node: &mut ExportNode,
    assets: &A,
    cache: &mut HashMap<String, Arc<[u8]>>,
) -> Result<(), NotesError> {
    if let Some(image) = &mut node.image {
        image.bytes = Some(hydrate_image(image, assets, cache)?);
    }
    for child in &mut node.children {
        hydrate_images(child, assets, cache)?;
    }
    Ok(())
}

fn hydrate_image<A: ImageAssetPort>(
    image: &ExportImage,
    assets: &A,
    cache: &mut HashMap<String, Arc<[u8]>>,
) -> Result<Arc<[u8]>, NotesError> {
    if let Some(bytes) = cache.get(image.metadata.content_hash()) {
        return Ok(Arc::clone(bytes));
    }
    let bytes = assets.read(&image.metadata)?;
    let actual_length = u64::try_from(bytes.len()).map_err(|_| {
        ExportError::Failed("An exported image payload is too large for this platform.".into())
    })?;
    if actual_length != image.metadata.byte_length() {
        return Err(ExportError::Failed(
            "An exported image payload did not match its stored byte length.".into(),
        )
        .into());
    }
    let bytes = Arc::<[u8]>::from(bytes);
    cache.insert(image.metadata.content_hash().to_owned(), Arc::clone(&bytes));
    Ok(bytes)
}
