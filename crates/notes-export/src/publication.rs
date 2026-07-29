use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

use notes_application::{ExportAsset, ExportError, ExportPublicationPort, RenderedExport};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const EXPORT_ASSET_MARKER_NAME: &str = ".yonalist-notes-export.json";
const EXPORT_ASSET_MARKER_CREATED_BY: &str = "yonalist-notes-export";
const EXPORT_ASSET_MARKER_VERSION: u32 = 1;

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
        let parent = validate_destination(destination, rendered, &self.forbidden_roots)?;
        match rendered {
            RenderedExport::Pdf { document } => {
                publish_document(&parent, destination, document, overwrite)
            }
            RenderedExport::Markdown {
                document,
                asset_directory_name,
                assets,
            } => publish_markdown(
                &parent,
                destination,
                document,
                asset_directory_name,
                assets,
                overwrite,
            ),
        }
    }
}

#[derive(Deserialize, Serialize)]
struct AssetMarker {
    created_by: String,
    version: u32,
    files: Vec<String>,
}

fn validate_destination(
    destination: &Path,
    rendered: &RenderedExport,
    forbidden_roots: &[PathBuf],
) -> Result<PathBuf, ExportError> {
    if !destination.is_absolute() || destination.file_name().is_none() {
        return Err(invalid("Export destination must be an absolute file path."));
    }
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
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| invalid("Export destination must have a parent directory."))?;
    let metadata = fs::symlink_metadata(parent).map_err(failed_io)?;
    if !metadata.is_dir() || metadata_is_link(&metadata) {
        return Err(invalid(
            "Export destination parent must be a regular directory.",
        ));
    }
    reject_link_ancestors(parent)?;
    let canonical_parent = fs::canonicalize(parent).map_err(failed_io)?;
    for root in forbidden_roots {
        if let Ok(canonical_root) = fs::canonicalize(root)
            && canonical_parent.starts_with(&canonical_root)
        {
            return Err(invalid(
                "Export destination is inside Yonalist application data.",
            ));
        }
    }
    validate_optional_file(destination)?;
    Ok(parent.to_path_buf())
}

fn validate_optional_file(path: &Path) -> Result<(), ExportError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata_is_link(&metadata) => Ok(()),
        Ok(_) => Err(invalid(
            "Export destination must be a regular file and must not be a link.",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(failed_io(error)),
    }
}

fn reject_link_ancestors(path: &Path) -> Result<(), ExportError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if !matches!(component, Component::Normal(_)) {
            continue;
        }
        let metadata = fs::symlink_metadata(&current).map_err(failed_io)?;
        if metadata_is_link(&metadata) {
            return Err(invalid(
                "Export destination ancestors must not be links or reparse points.",
            ));
        }
    }
    Ok(())
}

fn publish_document(
    parent: &Path,
    destination: &Path,
    document: &[u8],
    overwrite: bool,
) -> Result<(), ExportError> {
    let stage = unique_sibling(parent, "document-stage");
    write_staged_file(&stage, document)?;
    let result = if overwrite {
        replace_staged_path(&stage, destination, false)
    } else {
        rename_noreplace(&stage, destination).map_err(map_publication_error)
    };
    if result.is_err() {
        remove_file_if_exists(&stage);
    }
    result
}

fn publish_markdown(
    parent: &Path,
    destination: &Path,
    document: &[u8],
    asset_directory_name: &str,
    assets: &[ExportAsset],
    overwrite: bool,
) -> Result<(), ExportError> {
    validate_single_name(asset_directory_name)?;
    let expected_name = destination
        .file_stem()
        .and_then(|value| value.to_str())
        .map(|stem| format!("{stem}_assets"))
        .ok_or_else(|| invalid("Markdown destination must have a UTF-8 file stem."))?;
    if asset_directory_name != expected_name {
        return Err(invalid(
            "Markdown asset directory does not match its document name.",
        ));
    }
    let asset_destination = parent.join(asset_directory_name);
    validate_optional_asset_directory(&asset_destination, overwrite)?;
    if !overwrite && (destination.exists() || fs::symlink_metadata(&asset_destination).is_ok()) {
        return Err(ExportError::DestinationExists);
    }

    let document_stage = unique_sibling(parent, "markdown-stage");
    write_staged_file(&document_stage, document)?;
    let asset_stage = if assets.is_empty() {
        None
    } else {
        let stage = unique_sibling(parent, "assets-stage");
        if let Err(error) = stage_assets(&stage, assets) {
            remove_file_if_exists(&document_stage);
            remove_directory_if_exists(&stage);
            return Err(error);
        }
        Some(stage)
    };

    let document_backup = if overwrite {
        displace_existing(destination, parent, "document-backup", false)?
    } else {
        None
    };
    let asset_backup = if overwrite {
        match displace_existing(&asset_destination, parent, "assets-backup", true) {
            Ok(backup) => backup,
            Err(error) => {
                restore_backup(document_backup.as_deref(), destination);
                remove_file_if_exists(&document_stage);
                if let Some(stage) = &asset_stage {
                    remove_directory_if_exists(stage);
                }
                return Err(error);
            }
        }
    } else {
        None
    };

    let mut published_assets = false;
    if let Some(stage) = &asset_stage {
        if let Err(error) = rename_noreplace(stage, &asset_destination) {
            restore_backup(asset_backup.as_deref(), &asset_destination);
            restore_backup(document_backup.as_deref(), destination);
            remove_file_if_exists(&document_stage);
            remove_directory_if_exists(stage);
            return Err(map_publication_error(error));
        }
        published_assets = true;
    }
    if let Err(error) = rename_noreplace(&document_stage, destination) {
        if published_assets {
            remove_directory_if_exists(&asset_destination);
        }
        restore_backup(asset_backup.as_deref(), &asset_destination);
        restore_backup(document_backup.as_deref(), destination);
        remove_file_if_exists(&document_stage);
        return Err(map_publication_error(error));
    }

    remove_backup(document_backup.as_deref(), false);
    remove_backup(asset_backup.as_deref(), true);
    Ok(())
}

fn validate_optional_asset_directory(path: &Path, overwrite: bool) -> Result<(), ExportError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata_is_link(&metadata) => {
            if overwrite {
                validate_asset_marker(path)
            } else {
                Ok(())
            }
        }
        Ok(_) => Err(invalid(
            "Markdown asset destination must be a regular directory and must not be a link.",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(failed_io(error)),
    }
}

fn validate_asset_marker(directory: &Path) -> Result<(), ExportError> {
    let marker_path = directory.join(EXPORT_ASSET_MARKER_NAME);
    let metadata = fs::symlink_metadata(&marker_path)
        .map_err(|_| invalid("Existing Markdown asset directory is not owned by Yonalist."))?;
    if !metadata.is_file() || metadata_is_link(&metadata) || metadata.len() > 64 * 1024 {
        return Err(invalid(
            "Existing Markdown asset ownership marker is invalid.",
        ));
    }
    let marker: AssetMarker =
        serde_json::from_slice(&fs::read(&marker_path).map_err(failed_io)?)
            .map_err(|_| invalid("Existing Markdown asset ownership marker is invalid."))?;
    if marker.created_by != EXPORT_ASSET_MARKER_CREATED_BY
        || marker.version != EXPORT_ASSET_MARKER_VERSION
    {
        return Err(invalid(
            "Existing Markdown asset directory is not owned by Yonalist.",
        ));
    }
    Ok(())
}

fn stage_assets(stage: &Path, assets: &[ExportAsset]) -> Result<(), ExportError> {
    fs::create_dir(stage).map_err(failed_io)?;
    let mut names = BTreeSet::new();
    for asset in assets {
        validate_single_name(&asset.file_name)?;
        if asset.file_name == EXPORT_ASSET_MARKER_NAME || !names.insert(asset.file_name.clone()) {
            return Err(ExportError::Failed(
                "Markdown export contains duplicate or reserved asset names.".into(),
            ));
        }
        write_staged_file(&stage.join(&asset.file_name), &asset.bytes)?;
    }
    let marker = serde_json::to_vec(&AssetMarker {
        created_by: EXPORT_ASSET_MARKER_CREATED_BY.into(),
        version: EXPORT_ASSET_MARKER_VERSION,
        files: names.into_iter().collect(),
    })
    .map_err(|error| ExportError::Failed(error.to_string()))?;
    write_staged_file(&stage.join(EXPORT_ASSET_MARKER_NAME), &marker)
}

fn validate_single_name(value: &str) -> Result<(), ExportError> {
    let components = Path::new(value).components().collect::<Vec<_>>();
    if components.len() != 1
        || !matches!(components[0], Component::Normal(_))
        || value.contains(['/', '\\'])
        || value.chars().any(char::is_control)
    {
        return Err(invalid("Export asset name is unsafe."));
    }
    Ok(())
}

fn write_staged_file(path: &Path, bytes: &[u8]) -> Result<(), ExportError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(failed_io)?;
    file.write_all(bytes).map_err(failed_io)?;
    file.sync_all().map_err(failed_io)
}

fn displace_existing(
    destination: &Path,
    parent: &Path,
    prefix: &str,
    directory: bool,
) -> Result<Option<PathBuf>, ExportError> {
    match fs::symlink_metadata(destination) {
        Ok(metadata)
            if !metadata_is_link(&metadata)
                && ((directory && metadata.is_dir()) || (!directory && metadata.is_file())) =>
        {
            let backup = unique_sibling(parent, prefix);
            rename_noreplace(destination, &backup).map_err(map_publication_error)?;
            Ok(Some(backup))
        }
        Ok(_) => Err(invalid("Export overwrite destination changed identity.")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(failed_io(error)),
    }
}

fn replace_staged_path(
    stage: &Path,
    destination: &Path,
    directory: bool,
) -> Result<(), ExportError> {
    let parent = destination
        .parent()
        .ok_or_else(|| invalid("Export destination has no parent."))?;
    let backup = displace_existing(destination, parent, "document-backup", directory)?;
    if let Err(error) = rename_noreplace(stage, destination) {
        restore_backup(backup.as_deref(), destination);
        return Err(map_publication_error(error));
    }
    remove_backup(backup.as_deref(), directory);
    Ok(())
}

fn restore_backup(backup: Option<&Path>, destination: &Path) {
    let Some(backup) = backup else {
        return;
    };
    if !destination.exists() {
        let _ = rename_noreplace(backup, destination);
    }
}

fn remove_backup(backup: Option<&Path>, directory: bool) {
    let Some(backup) = backup else {
        return;
    };
    if directory {
        remove_directory_if_exists(backup);
    } else {
        remove_file_if_exists(backup);
    }
}

fn unique_sibling(parent: &Path, prefix: &str) -> PathBuf {
    parent.join(format!(".yonalist-{prefix}-{}", Uuid::new_v4()))
}

fn remove_file_if_exists(path: &Path) {
    if let Err(error) = fs::remove_file(path)
        && error.kind() != io::ErrorKind::NotFound
    {
        let _ = error;
    }
}

fn remove_directory_if_exists(path: &Path) {
    if let Err(error) = fs::remove_dir_all(path)
        && error.kind() != io::ErrorKind::NotFound
    {
        let _ = error;
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

#[cfg(windows)]
fn metadata_is_link(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn metadata_is_link(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS};
    use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};

    let from = from
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let to = to
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) };
    if moved != 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if matches!(
        error.raw_os_error().map(|code| code as u32),
        Some(ERROR_ALREADY_EXISTS) | Some(ERROR_FILE_EXISTS)
    ) {
        Err(io::Error::new(io::ErrorKind::AlreadyExists, error))
    } else {
        Err(error)
    }
}

#[cfg(any(
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    target_os = "redox"
))]
fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    rustix::fs::renameat_with(
        rustix::fs::CWD,
        from,
        rustix::fs::CWD,
        to,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(io::Error::from)
}

#[cfg(not(any(
    windows,
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    target_os = "redox"
)))]
fn rename_noreplace(_from: &Path, _to: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Atomic no-replace rename is unsupported on this platform.",
    ))
}
