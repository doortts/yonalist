use std::fs;
use std::path::{Component, Path, PathBuf};

use notes_application::{ExportError, RenderedExport};

use super::capability::HeldDirectory;
use super::{existing_file, failed_io, invalid, validate_relative_name};

pub(super) struct ValidatedDestination {
    pub(super) parent: HeldDirectory,
    pub(super) name: PathBuf,
    parent_path: PathBuf,
}

impl ValidatedDestination {
    pub(super) fn acquire(
        destination: &Path,
        rendered: &RenderedExport,
        forbidden_roots: &[PathBuf],
    ) -> Result<Self, ExportError> {
        if !destination.is_absolute() {
            return Err(invalid("Export destination must be an absolute file path."));
        }
        let name = destination
            .file_name()
            .map(PathBuf::from)
            .ok_or_else(|| invalid("Export destination must name a file."))?;
        validate_relative_name(&name)?;
        let expected_extension = match rendered {
            RenderedExport::Markdown { .. } => "md",
            RenderedExport::Pdf { .. } => "pdf",
        };
        if !destination
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(expected_extension))
        {
            return Err(invalid(format!(
                "Export destination must use the .{expected_extension} extension."
            )));
        }
        let parent_path = destination
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .ok_or_else(|| invalid("Export destination must have a parent directory."))?;
        reject_link_ancestors(parent_path)?;
        let canonical_parent = fs::canonicalize(parent_path).map_err(failed_io)?;
        for root in forbidden_roots {
            if let Ok(canonical_root) = fs::canonicalize(root)
                && canonical_parent.starts_with(canonical_root)
            {
                return Err(invalid(
                    "Export destination is inside Yonalist application data.",
                ));
            }
        }
        let parent = HeldDirectory::open_ambient(&canonical_parent).map_err(failed_io)?;
        if fs::canonicalize(parent_path).map_err(failed_io)? != canonical_parent {
            return Err(invalid(
                "Export destination parent changed while access was acquired.",
            ));
        }
        parent.verify_held().map_err(failed_io)?;
        existing_file(&parent.directory, &name)?;
        Ok(Self {
            parent,
            name,
            parent_path: canonical_parent,
        })
    }

    pub(super) fn revalidate(&self) -> Result<(), ExportError> {
        super::maybe_fail_parent_revalidation()?;
        self.parent.verify_held().map_err(failed_io)?;
        let current = HeldDirectory::open_ambient(&self.parent_path)
            .map_err(|_| invalid("Export destination parent changed during publication."))?;
        if !self.parent.has_same_identity(&current) {
            return Err(invalid(
                "Export destination parent changed during publication.",
            ));
        }
        Ok(())
    }
}

fn reject_link_ancestors(path: &Path) -> Result<(), ExportError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(component, Component::Normal(_)) {
            let metadata = fs::symlink_metadata(&current).map_err(failed_io)?;
            if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
                return Err(invalid(
                    "Export destination ancestors must not be links or reparse points.",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}
