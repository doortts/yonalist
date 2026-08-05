use std::path::Path;
use std::sync::Arc;

use notes_core::{NodeId, NoteImage, NoteMarkerKind, NoteNodeKind};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

use crate::StorageError;

pub const MAX_EXPORT_NODES: usize = 20_000;
pub const MAX_EXPORT_DEPTH: usize = 128;
pub const MAX_EXPORT_IMAGES: usize = 512;
pub const MAX_PDF_IMAGE_WORKING_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ExportFormat {
    Markdown,
    Pdf,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NotesExportRequest {
    pub session_id: String,
    #[ts(type = "number")]
    pub base_revision: u64,
    pub root_node_id: String,
    pub format: ExportFormat,
    pub destination_path: String,
    pub overwrite: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NotesExportResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub root_node_id: String,
    pub format: ExportFormat,
    pub destination_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExportSnapshot {
    pub revision: u64,
    pub root_node_id: NodeId,
    pub title: String,
    pub exported_at: String,
    pub root: ExportNode,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExportNode {
    pub id: NodeId,
    pub kind: NoteNodeKind,
    pub marker: NoteMarkerKind,
    pub text: String,
    pub note: String,
    pub completed: bool,
    pub image: Option<ExportImage>,
    pub children: Vec<ExportNode>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExportImage {
    pub metadata: NoteImage,
    pub bytes: Option<Arc<[u8]>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExportAsset {
    pub file_name: String,
    pub bytes: Arc<[u8]>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RenderedExport {
    Markdown {
        document: Vec<u8>,
        asset_directory_name: String,
        assets: Vec<ExportAsset>,
    },
    Pdf {
        document: Vec<u8>,
    },
}

#[derive(Debug, Error)]
pub enum ExportError {
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error("Destination already exists.")]
    DestinationExists,
    #[error("{0}")]
    InvalidDestination(String),
    #[error("{0}")]
    TooLarge(String),
    #[error("{0}")]
    Failed(String),
}

pub trait ExportSnapshotPort: Send + Sync {
    fn load_export_snapshot(
        &self,
        expected_revision: u64,
        root_id: &NodeId,
    ) -> Result<ExportSnapshot, ExportError>;
}

impl<T: ExportSnapshotPort + ?Sized> ExportSnapshotPort for &T {
    fn load_export_snapshot(
        &self,
        expected_revision: u64,
        root_id: &NodeId,
    ) -> Result<ExportSnapshot, ExportError> {
        (**self).load_export_snapshot(expected_revision, root_id)
    }
}

impl<T: ExportSnapshotPort + ?Sized> ExportSnapshotPort for Arc<T> {
    fn load_export_snapshot(
        &self,
        expected_revision: u64,
        root_id: &NodeId,
    ) -> Result<ExportSnapshot, ExportError> {
        (**self).load_export_snapshot(expected_revision, root_id)
    }
}

pub trait ExportRendererPort: Send + Sync {
    fn render(
        &self,
        snapshot: &ExportSnapshot,
        format: ExportFormat,
        asset_directory_name: Option<&str>,
    ) -> Result<RenderedExport, ExportError>;
}

pub trait ExportPublicationPort: Send + Sync {
    fn publish(
        &self,
        destination: &Path,
        rendered: &RenderedExport,
        overwrite: bool,
    ) -> Result<(), ExportError>;
}
