use std::io;
use std::path::Path;

use cap_std::fs::Dir;
use notes_application::ExportError;

use super::assets::HeldAssets;
use super::capability::{HeldFile, rename_noreplace};

#[allow(clippy::too_many_arguments)]
pub(super) fn rollback_document(
    parent: &Dir,
    destination: &Path,
    stage: &Path,
    staged: HeldFile,
    backup: Option<&Path>,
    original: Option<&HeldFile>,
    new_published: bool,
    old_displaced: bool,
    failure: ExportError,
) -> ExportError {
    let mut errors = Vec::new();
    if new_published && let Err(error) = move_verified_file(parent, destination, stage, &staged) {
        errors.push(format!("new document rollback failed: {error}"));
    }
    if old_displaced
        && let (Some(backup), Some(original)) = (backup, original)
        && let Err(error) = move_verified_file(parent, backup, destination, original)
    {
        errors.push(format!("old document restore failed: {error}"));
    }
    if let Err(error) = staged.remove_verified(parent, stage) {
        errors.push(format!("document stage cleanup failed: {error}"));
    }
    append_rollback_errors(failure, errors)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn rollback_markdown(
    parent: &Dir,
    destination: &Path,
    asset_destination: &Path,
    document_stage: &Path,
    asset_stage: Option<&Path>,
    staged_document: &HeldFile,
    staged_assets: Option<&HeldAssets>,
    document_backup: Option<&Path>,
    asset_backup: Option<&Path>,
    original_document: Option<&HeldFile>,
    original_assets: Option<&HeldAssets>,
    new_document_published: bool,
    new_assets_published: bool,
    old_document_displaced: bool,
    old_assets_displaced: bool,
    failure: ExportError,
) -> ExportError {
    let mut errors = Vec::new();
    if new_document_published
        && let Err(error) = move_verified_file(parent, destination, document_stage, staged_document)
    {
        errors.push(format!("new document rollback failed: {error}"));
    }
    if new_assets_published
        && let (Some(stage), Some(staged)) = (asset_stage, staged_assets)
        && let Err(error) = move_verified_assets(parent, asset_destination, stage, staged)
    {
        errors.push(format!("new assets rollback failed: {error}"));
    }
    if old_assets_displaced
        && let (Some(backup), Some(original)) = (asset_backup, original_assets)
        && let Err(error) = move_verified_assets(parent, backup, asset_destination, original)
    {
        errors.push(format!("old assets restore failed: {error}"));
    }
    if old_document_displaced
        && let (Some(backup), Some(original)) = (document_backup, original_document)
        && let Err(error) = move_verified_file(parent, backup, destination, original)
    {
        errors.push(format!("old document restore failed: {error}"));
    }
    append_rollback_errors(failure, errors)
}

fn move_verified_file(parent: &Dir, from: &Path, to: &Path, held: &HeldFile) -> io::Result<()> {
    held.verify_at(parent, from)?;
    rename_noreplace(parent, from, parent, to)?;
    held.verify_at(parent, to)
}

fn move_verified_assets(parent: &Dir, from: &Path, to: &Path, held: &HeldAssets) -> io::Result<()> {
    held.verify_at(parent, from)?;
    rename_noreplace(parent, from, parent, to)?;
    held.verify_at(parent, to)
}

pub(super) fn append_rollback_errors(failure: ExportError, errors: Vec<String>) -> ExportError {
    if errors.is_empty() {
        failure
    } else {
        ExportError::Failed(format!(
            "{failure} Rollback also failed: {}",
            errors.join("; ")
        ))
    }
}
