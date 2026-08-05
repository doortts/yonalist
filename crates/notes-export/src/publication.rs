mod assets;
mod capability;
mod destination;
mod rollback;
#[cfg(test)]
mod tests;

use std::io;
use std::path::{Component, Path, PathBuf};

use cap_std::fs::Dir;
use notes_application::{ExportError, ExportPublicationPort, RenderedExport};
use uuid::Uuid;

use self::assets::HeldAssets;
use self::capability::{HeldFile, rename_noreplace, write_new};
use self::destination::ValidatedDestination;
use self::rollback::{append_rollback_errors, rollback_document, rollback_markdown};

pub const EXPORT_ASSET_MARKER_NAME: &str = ".yonalist-notes-export.json";

pub struct NativeExportPublisher {
    forbidden_roots: Vec<PathBuf>,
}

impl NativeExportPublisher {
    pub fn new(forbidden_roots: Vec<PathBuf>) -> Self {
        Self { forbidden_roots }
    }
}

impl ExportPublicationPort for NativeExportPublisher {
    fn publish(
        &self,
        destination: &Path,
        rendered: &RenderedExport,
        overwrite: bool,
    ) -> Result<(), ExportError> {
        let validated =
            ValidatedDestination::acquire(destination, rendered, &self.forbidden_roots)?;
        validated.revalidate()?;
        let revalidate = || validated.revalidate();
        match rendered {
            RenderedExport::Pdf { document } => publish_document(
                &validated.parent.directory,
                &validated.name,
                document,
                overwrite,
                &revalidate,
            ),
            RenderedExport::Markdown {
                document,
                asset_directory_name,
                assets,
            } => publish_markdown(
                &validated.parent.directory,
                &validated.name,
                document,
                asset_directory_name,
                assets,
                overwrite,
                &revalidate,
            ),
        }
    }
}

fn publish_document(
    parent: &Dir,
    destination: &Path,
    document: &[u8],
    overwrite: bool,
    revalidate: &dyn Fn() -> Result<(), ExportError>,
) -> Result<(), ExportError> {
    revalidate()?;
    let original = existing_file(parent, destination)?;
    if !overwrite && original.is_some() {
        return Err(ExportError::DestinationExists);
    }
    maybe_inject_before_staging();
    revalidate()?;
    let stage_name = unique_name(parent, "document-stage")?;
    let staged = write_new(parent, &stage_name, document).map_err(failed_io)?;
    let backup_name = original
        .as_ref()
        .map(|_| unique_name(parent, "document-backup"))
        .transpose()?;
    let mut old_displaced = false;
    let mut new_published = false;
    let publication = (|| {
        maybe_inject_before_publication();
        revalidate()?;
        if let (Some(original), Some(backup)) = (&original, &backup_name) {
            original.verify_at(parent, destination).map_err(failed_io)?;
            rename_noreplace(parent, destination, parent, backup).map_err(map_publication_error)?;
            old_displaced = true;
            original.verify_at(parent, backup).map_err(failed_io)?;
        }
        staged.verify_at(parent, &stage_name).map_err(failed_io)?;
        rename_noreplace(parent, &stage_name, parent, destination)
            .map_err(map_publication_error)?;
        new_published = true;
        staged.verify_at(parent, destination).map_err(failed_io)
    })()
    .and_then(|_| revalidate());
    if let Err(error) = publication {
        return Err(rollback_document(
            parent,
            destination,
            &stage_name,
            staged,
            backup_name.as_deref(),
            original.as_ref(),
            new_published,
            old_displaced,
            error,
        ));
    }
    if let (Some(original), Some(backup)) = (original, backup_name.as_deref()) {
        original
            .remove_verified(parent, backup)
            .map_err(failed_io)?;
    }
    Ok(())
}

fn publish_markdown(
    parent: &Dir,
    destination: &Path,
    document: &[u8],
    asset_directory_name: &str,
    assets: &[notes_application::ExportAsset],
    overwrite: bool,
    revalidate: &dyn Fn() -> Result<(), ExportError>,
) -> Result<(), ExportError> {
    revalidate()?;
    validate_single_name(asset_directory_name)?;
    let expected = destination
        .file_stem()
        .and_then(|value| value.to_str())
        .map(|stem| format!("{stem}_assets"))
        .ok_or_else(|| invalid("Markdown destination must have a UTF-8 file stem."))?;
    if asset_directory_name != expected {
        return Err(invalid(
            "Markdown asset directory does not match its document name.",
        ));
    }
    let asset_destination = Path::new(asset_directory_name);
    let original_document = existing_file(parent, destination)?;
    let original_assets = existing_assets(parent, asset_destination, overwrite)?;
    if !overwrite && (original_document.is_some() || path_exists(parent, asset_destination)?) {
        return Err(ExportError::DestinationExists);
    }
    maybe_inject_before_staging();
    revalidate()?;
    let document_stage_name = unique_name(parent, "markdown-stage")?;
    let staged_document = write_new(parent, &document_stage_name, document).map_err(failed_io)?;
    let asset_stage_name = (!assets.is_empty())
        .then(|| unique_name(parent, "assets-stage"))
        .transpose()?;
    let staged_assets = match asset_stage_name.as_deref() {
        Some(name) => match HeldAssets::stage(parent, name, assets) {
            Ok(staged) => Some(staged),
            Err(error) => {
                let cleanup = staged_document.remove_verified(parent, &document_stage_name);
                return combine(error, cleanup, "document stage cleanup");
            }
        },
        None => None,
    };
    publish_markdown_stages(
        parent,
        destination,
        asset_destination,
        &document_stage_name,
        asset_stage_name.as_deref(),
        staged_document,
        staged_assets,
        original_document,
        original_assets,
        revalidate,
    )
}

#[allow(clippy::too_many_arguments)]
fn publish_markdown_stages(
    parent: &Dir,
    destination: &Path,
    asset_destination: &Path,
    document_stage_name: &Path,
    asset_stage_name: Option<&Path>,
    staged_document: HeldFile,
    staged_assets: Option<HeldAssets>,
    original_document: Option<HeldFile>,
    original_assets: Option<HeldAssets>,
    revalidate: &dyn Fn() -> Result<(), ExportError>,
) -> Result<(), ExportError> {
    let document_backup = original_document
        .as_ref()
        .map(|_| unique_name(parent, "document-backup"))
        .transpose()?;
    let asset_backup = original_assets
        .as_ref()
        .map(|_| unique_name(parent, "assets-backup"))
        .transpose()?;
    let mut old_document_displaced = false;
    let mut old_assets_displaced = false;
    let mut new_assets_published = false;
    let mut new_document_published = false;
    let publication = (|| {
        maybe_inject_before_publication();
        revalidate()?;
        if let (Some(original), Some(backup)) = (&original_document, &document_backup) {
            original.verify_at(parent, destination).map_err(failed_io)?;
            rename_noreplace(parent, destination, parent, backup).map_err(map_publication_error)?;
            old_document_displaced = true;
            original.verify_at(parent, backup).map_err(failed_io)?;
        }
        if let (Some(original), Some(backup)) = (&original_assets, &asset_backup) {
            original
                .verify_at(parent, asset_destination)
                .map_err(failed_io)?;
            rename_noreplace(parent, asset_destination, parent, backup)
                .map_err(map_publication_error)?;
            old_assets_displaced = true;
            original.verify_at(parent, backup).map_err(failed_io)?;
        }
        if let (Some(staged), Some(stage_name)) = (&staged_assets, asset_stage_name) {
            staged.verify_at(parent, stage_name).map_err(failed_io)?;
            rename_noreplace(parent, stage_name, parent, asset_destination)
                .map_err(map_publication_error)?;
            new_assets_published = true;
            staged
                .verify_at(parent, asset_destination)
                .map_err(failed_io)?;
        }
        staged_document
            .verify_at(parent, document_stage_name)
            .map_err(failed_io)?;
        rename_noreplace(parent, document_stage_name, parent, destination)
            .map_err(map_publication_error)?;
        new_document_published = true;
        staged_document
            .verify_at(parent, destination)
            .map_err(failed_io)
    })()
    .and_then(|_| revalidate());
    if let Err(error) = publication {
        let mut failure = rollback_markdown(
            parent,
            destination,
            asset_destination,
            document_stage_name,
            asset_stage_name,
            &staged_document,
            staged_assets.as_ref(),
            document_backup.as_deref(),
            asset_backup.as_deref(),
            original_document.as_ref(),
            original_assets.as_ref(),
            new_document_published,
            new_assets_published,
            old_document_displaced,
            old_assets_displaced,
            error,
        );
        if let Err(error) = staged_document.remove_verified(parent, document_stage_name) {
            failure = append_rollback_errors(
                failure,
                vec![format!("document stage cleanup failed: {error}")],
            );
        }
        if let (Some(stage), Some(staged)) = (asset_stage_name, staged_assets)
            && let Err(error) = staged.remove_verified(parent, stage)
        {
            failure = append_rollback_errors(
                failure,
                vec![format!("asset stage cleanup failed: {error}")],
            );
        }
        return Err(failure);
    }
    if let (Some(original), Some(backup)) = (original_document, document_backup.as_deref()) {
        original
            .remove_verified(parent, backup)
            .map_err(failed_io)?;
    }
    if let (Some(original), Some(backup)) = (original_assets, asset_backup.as_deref()) {
        original
            .remove_verified(parent, backup)
            .map_err(failed_io)?;
    }
    Ok(())
}

fn existing_file(parent: &Dir, name: &Path) -> Result<Option<HeldFile>, ExportError> {
    match parent.symlink_metadata(name) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            HeldFile::open(parent, name).map(Some).map_err(failed_io)
        }
        Ok(_) => Err(invalid(
            "Export destination must be a regular file and must not be a link.",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(failed_io(error)),
    }
}

fn existing_assets(
    parent: &Dir,
    name: &Path,
    overwrite: bool,
) -> Result<Option<HeldAssets>, ExportError> {
    match parent.symlink_metadata(name) {
        Ok(_) if overwrite => HeldAssets::open_owned(parent, name).map(Some),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(failed_io(error)),
    }
}

fn path_exists(parent: &Dir, name: &Path) -> Result<bool, ExportError> {
    match parent.symlink_metadata(name) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(failed_io(error)),
    }
}

fn validate_relative_name(value: &Path) -> Result<(), ExportError> {
    let mut components = value.components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err(invalid("Export file name is unsafe."));
    }
    Ok(())
}

fn validate_single_name(value: &str) -> Result<(), ExportError> {
    let path = Path::new(value);
    validate_relative_name(path)?;
    if value.contains(['/', '\\']) || value.chars().any(char::is_control) {
        return Err(invalid("Export asset name is unsafe."));
    }
    Ok(())
}

fn unique_name(parent: &Dir, prefix: &str) -> Result<PathBuf, ExportError> {
    for _ in 0..128 {
        let name = PathBuf::from(format!(".yonalist-{prefix}-{}", Uuid::new_v4()));
        if !path_exists(parent, &name)? {
            return Ok(name);
        }
    }
    Err(ExportError::Failed(
        "Could not allocate an export staging path.".into(),
    ))
}

fn combine(
    failure: ExportError,
    cleanup: io::Result<()>,
    context: &str,
) -> Result<(), ExportError> {
    match cleanup {
        Ok(()) => Err(failure),
        Err(error) => Err(ExportError::Failed(format!(
            "{failure} {context} also failed: {error}"
        ))),
    }
}

fn map_publication_error(error: io::Error) -> ExportError {
    if error.kind() == io::ErrorKind::AlreadyExists {
        ExportError::DestinationExists
    } else {
        failed_io(error)
    }
}

fn failed_io(error: io::Error) -> ExportError {
    ExportError::Failed(format!("Notes export file operation failed: {error}"))
}

fn invalid(message: impl Into<String>) -> ExportError {
    ExportError::InvalidDestination(message.into())
}

#[cfg(test)]
thread_local! {
    static BEFORE_STAGING: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static BEFORE_PUBLICATION: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static FORCE_PARENT_REVALIDATION_FAILURE: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
}

#[cfg(test)]
fn maybe_inject_before_staging() {
    BEFORE_STAGING.with(|injection| {
        if let Some(injection) = injection.borrow_mut().take() {
            injection();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_staging() {}

#[cfg(test)]
fn maybe_inject_before_publication() {
    BEFORE_PUBLICATION.with(|injection| {
        if let Some(injection) = injection.borrow_mut().take() {
            injection();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_publication() {}

#[cfg(test)]
fn maybe_fail_parent_revalidation() -> Result<(), ExportError> {
    FORCE_PARENT_REVALIDATION_FAILURE.with(|failure| {
        if failure.replace(false) {
            Err(invalid(
                "Export destination parent changed during publication.",
            ))
        } else {
            Ok(())
        }
    })
}

#[cfg(not(test))]
fn maybe_fail_parent_revalidation() -> Result<(), ExportError> {
    Ok(())
}
