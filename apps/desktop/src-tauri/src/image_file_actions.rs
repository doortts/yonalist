use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use notes_application::{ImageDownloadRequest, ImageReadRequest, NotesError, NotesErrorCode};
use tauri::State;

use super::{DesktopState, run_blocking};

#[tauri::command]
pub(crate) async fn notes_view_image_original(
    state: State<'_, DesktopState>,
    request: ImageReadRequest,
) -> Result<(), NotesError> {
    let gate = std::sync::Arc::clone(&state.runtime);
    run_blocking(move || {
        let runtime = gate.wait()?;
        let node_id = request.node_id.clone();
        let (image, bytes) = runtime
            .service
            .read_image_asset(request, runtime.assets.as_ref())?;
        fs::create_dir_all(&runtime.original_directory).map_err(unavailable)?;
        let destination = runtime
            .original_directory
            .join(format!("{node_id}-{}", image.original_name()));
        write_atomic(&destination, &bytes)?;
        open::that(&destination).map_err(unavailable)?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn notes_download_image(
    state: State<'_, DesktopState>,
    request: ImageDownloadRequest,
) -> Result<(), NotesError> {
    let gate = std::sync::Arc::clone(&state.runtime);
    run_blocking(move || {
        let runtime = gate.wait()?;
        let destination = PathBuf::from(request.destination_path);
        validate_download_destination(&runtime.data_directory, &destination)?;
        let (_, bytes) = runtime.service.read_image_asset(
            ImageReadRequest {
                session_id: request.session_id,
                node_id: request.node_id,
            },
            runtime.assets.as_ref(),
        )?;
        write_atomic(&destination, &bytes)
    })
    .await
}

fn validate_download_destination(
    protected_root: &Path,
    destination: &Path,
) -> Result<(), NotesError> {
    if !destination.is_absolute() || destination.starts_with(protected_root) {
        return Err(invalid("The image download destination is not allowed."));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| invalid("The image download destination has no parent."))?;
    let parent_metadata = fs::symlink_metadata(parent).map_err(unavailable)?;
    if is_link_or_reparse(&parent_metadata) || !parent_metadata.is_dir() {
        return Err(invalid(
            "The image download parent is not a regular directory.",
        ));
    }
    match fs::symlink_metadata(destination) {
        Ok(metadata) if is_link_or_reparse(&metadata) || !metadata.is_file() => {
            return Err(invalid(
                "The image download destination is not a regular file.",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(unavailable(error)),
    }
    Ok(())
}

fn write_atomic(destination: &Path, bytes: &[u8]) -> Result<(), NotesError> {
    let parent = destination
        .parent()
        .ok_or_else(|| invalid("The image destination has no parent."))?;
    let filename = destination
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| invalid("The image destination filename is invalid."))?;
    let temporary = parent.join(format!(".{filename}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(unavailable)?;
        file.write_all(bytes).map_err(unavailable)?;
        file.sync_all().map_err(unavailable)?;
        drop(file);
        replace_file(&temporary, destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), NotesError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain([0]).collect();
    let destination: Vec<u16> = destination.as_os_str().encode_wide().chain([0]).collect();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(unavailable(std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), NotesError> {
    fs::rename(source, destination).map_err(unavailable)
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn invalid(message: impl Into<String>) -> NotesError {
    NotesError {
        code: NotesErrorCode::InvalidCommand,
        message: message.into(),
        retryable: false,
    }
}

fn unavailable(error: impl std::fmt::Display) -> NotesError {
    NotesError {
        code: NotesErrorCode::StorageUnavailable,
        message: error.to_string(),
        retryable: true,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io;
    use std::path::Path;

    use super::{validate_download_destination, write_atomic};

    #[test]
    fn download_destination_is_regular_external_and_atomically_replaceable() {
        let root =
            std::env::temp_dir().join(format!("yonalist-v2-download-{}", uuid::Uuid::new_v4()));
        let protected = root.join("protected");
        let downloads = root.join("downloads");
        fs::create_dir_all(&protected).unwrap();
        fs::create_dir_all(&downloads).unwrap();
        let destination = downloads.join("cat.png");

        validate_download_destination(&protected, &destination).unwrap();
        write_atomic(&destination, &[1, 2, 3]).unwrap();
        write_atomic(&destination, &[4, 5]).unwrap();

        assert_eq!(fs::read(&destination).unwrap(), [4, 5]);
        assert!(validate_download_destination(&protected, Path::new("cat.png")).is_err());
        assert!(validate_download_destination(&protected, &protected.join("cat.png")).is_err());
        assert!(validate_download_destination(&protected, &downloads).is_err());

        let broken_link = downloads.join("broken.png");
        if create_file_symlink(&downloads.join("missing.png"), &broken_link).is_ok() {
            assert!(
                validate_download_destination(&protected, &broken_link).is_err(),
                "a broken link must not bypass destination validation"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    fn create_file_symlink(target: &Path, link: &Path) -> io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }

    #[cfg(unix)]
    fn create_file_symlink(target: &Path, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }
}
