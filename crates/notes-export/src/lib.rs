//! Deterministic Notes export renderers and native publication adapters.

mod markdown;
mod pdf;
mod publication;

use std::path::PathBuf;

use notes_application::{
    ExportError, ExportFormat, ExportRendererPort, ExportSnapshot, RenderedExport,
};

pub use publication::{EXPORT_ASSET_MARKER_NAME, NativeExportPublisher};

pub struct NativeExportRenderer {
    font_path: PathBuf,
}

impl NativeExportRenderer {
    pub fn new(font_path: PathBuf) -> Self {
        Self { font_path }
    }
}

impl ExportRendererPort for NativeExportRenderer {
    fn render(
        &self,
        snapshot: &ExportSnapshot,
        format: ExportFormat,
        asset_directory_name: Option<&str>,
    ) -> Result<RenderedExport, ExportError> {
        match format {
            ExportFormat::Markdown => markdown::render(snapshot, asset_directory_name),
            ExportFormat::Pdf => pdf::render(snapshot, &self.font_path),
        }
    }
}
