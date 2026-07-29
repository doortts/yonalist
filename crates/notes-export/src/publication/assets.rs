use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};

use cap_std::fs::Dir;
use notes_application::ExportAsset;
use serde::{Deserialize, Serialize};

use super::capability::{HeldDirectory, HeldFile, Identity, write_new};
use super::{EXPORT_ASSET_MARKER_NAME, invalid, validate_single_name};
use notes_application::ExportError;

const MARKER_CREATED_BY: &str = "yonalist-notes-export";
const MARKER_VERSION: u32 = 1;
const MAX_MARKER_BYTES: usize = 64 * 1024;

#[derive(Deserialize, Serialize)]
struct AssetMarker {
    created_by: String,
    version: u32,
    files: Vec<String>,
}

pub(super) struct HeldAssets {
    directory_identity: Identity,
    files: Vec<(PathBuf, Identity)>,
}

impl HeldAssets {
    pub(super) fn stage(
        parent: &Dir,
        name: &Path,
        assets: &[ExportAsset],
    ) -> Result<Self, ExportError> {
        parent
            .create_dir(name)
            .map_err(|error| asset_io("create stage directory", error))?;
        let directory = HeldDirectory::open(parent, name)
            .map_err(|error| asset_io("open stage directory", error))?;
        let mut held = Self {
            directory_identity: directory.identity(),
            files: Vec::new(),
        };
        let result = (|| {
            let mut names = BTreeSet::new();
            for asset in assets {
                validate_single_name(&asset.file_name)?;
                if asset.file_name == EXPORT_ASSET_MARKER_NAME
                    || !names.insert(asset.file_name.clone())
                {
                    return Err(ExportError::Failed(
                        "Markdown export contains duplicate or reserved asset names.".into(),
                    ));
                }
                let path = PathBuf::from(&asset.file_name);
                let file = write_new(&directory.directory, &path, &asset.bytes)
                    .map_err(|error| asset_io("write staged asset", error))?;
                held.files.push((path, file.identity()));
            }
            let marker = serde_json::to_vec(&AssetMarker {
                created_by: MARKER_CREATED_BY.into(),
                version: MARKER_VERSION,
                files: names.into_iter().collect(),
            })
            .map_err(|error| ExportError::Failed(error.to_string()))?;
            let marker_path = PathBuf::from(EXPORT_ASSET_MARKER_NAME);
            let marker_file = write_new(&directory.directory, &marker_path, &marker)
                .map_err(|error| asset_io("write staged marker", error))?;
            held.files.push((marker_path, marker_file.identity()));
            Ok(())
        })();
        if let Err(error) = result {
            drop(directory);
            let cleanup = held.remove_verified(parent, name);
            return match cleanup {
                Ok(()) => Err(error),
                Err(cleanup) => Err(ExportError::Failed(format!(
                    "{error} Staged asset cleanup also failed: {cleanup}"
                ))),
            };
        }
        drop(directory);
        Ok(held)
    }

    pub(super) fn open_owned(parent: &Dir, name: &Path) -> Result<Self, ExportError> {
        let directory = HeldDirectory::open(parent, name)
            .map_err(|_| invalid("Existing Markdown asset directory is unsafe."))?;
        let marker_path = Path::new(EXPORT_ASSET_MARKER_NAME);
        let marker_file = HeldFile::open(&directory.directory, marker_path)
            .map_err(|_| invalid("Existing Markdown asset directory is not owned by Yonalist."))?;
        let marker: AssetMarker = serde_json::from_slice(
            &marker_file
                .read_bounded(MAX_MARKER_BYTES)
                .map_err(|_| invalid("Existing Markdown asset ownership marker is invalid."))?,
        )
        .map_err(|_| invalid("Existing Markdown asset ownership marker is invalid."))?;
        if marker.created_by != MARKER_CREATED_BY || marker.version != MARKER_VERSION {
            return Err(invalid(
                "Existing Markdown asset directory is not owned by Yonalist.",
            ));
        }
        let mut expected = BTreeSet::from([PathBuf::from(EXPORT_ASSET_MARKER_NAME)]);
        for file in marker.files {
            validate_single_name(&file)?;
            if file == EXPORT_ASSET_MARKER_NAME || !expected.insert(PathBuf::from(file)) {
                return Err(invalid(
                    "Existing Markdown asset ownership marker is invalid.",
                ));
            }
        }
        let actual = entry_names(&directory.directory)?;
        if actual != expected {
            return Err(invalid(
                "Existing Markdown asset directory contains unowned files.",
            ));
        }
        let mut files = Vec::with_capacity(actual.len());
        let mut marker_file = Some(marker_file);
        for path in actual {
            let file = if path == marker_path {
                marker_file
                    .take()
                    .expect("validated marker must appear exactly once")
            } else {
                HeldFile::open(&directory.directory, &path)
                    .map_err(|_| invalid("Existing Markdown asset file is unsafe."))?
            };
            files.push((path, file.identity()));
        }
        debug_assert!(marker_file.is_none());
        let directory_identity = directory.identity();
        drop(directory);
        Ok(Self {
            directory_identity,
            files,
        })
    }

    pub(super) fn verify_at(&self, parent: &Dir, name: &Path) -> io::Result<()> {
        let directory = HeldDirectory::open(parent, name)?;
        if !directory.has_identity(self.directory_identity) {
            return Err(identity_changed());
        }
        for (path, expected) in &self.files {
            let file = HeldFile::open(&directory.directory, path)?;
            if !file.has_identity(*expected) {
                return Err(identity_changed());
            }
        }
        Ok(())
    }

    pub(super) fn remove_verified(self, parent: &Dir, name: &Path) -> io::Result<()> {
        let directory = HeldDirectory::open(parent, name)?;
        if !directory.has_identity(self.directory_identity) {
            return Err(identity_changed());
        }
        for (path, expected) in self.files {
            let file = HeldFile::open(&directory.directory, &path)?;
            if !file.has_identity(expected) {
                return Err(identity_changed());
            }
            file.remove_verified(&directory.directory, &path)?;
        }
        directory.verify_at(parent, name)?;
        if directory.directory.entries()?.next().is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Export asset directory changed before cleanup.",
            ));
        }
        parent.remove_dir(name)
    }
}

fn identity_changed() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Export asset identity changed during publication.",
    )
}

fn entry_names(directory: &Dir) -> Result<BTreeSet<PathBuf>, ExportError> {
    let mut names = BTreeSet::new();
    for entry in directory.entries().map_err(super::failed_io)? {
        let entry = entry.map_err(super::failed_io)?;
        let path = PathBuf::from(entry.file_name());
        if path.components().count() != 1
            || !matches!(
                path.components().next(),
                Some(std::path::Component::Normal(_))
            )
        {
            return Err(invalid("Existing Markdown asset file name is unsafe."));
        }
        names.insert(path);
    }
    Ok(names)
}

fn asset_io(context: &str, error: io::Error) -> ExportError {
    ExportError::Failed(format!("Notes export could not {context}: {error}"))
}
