//! Where the vault lives. The path is the one piece of sync state the adapter
//! owns rather than the database: it has to be readable before the worker is up,
//! and a data reset clears it without touching the folder it names.

use notes_application::{NotesError, NotesErrorCode, SyncVaultFolderState};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const VAULT_PATH_FILE: &str = "vault-path";
/// What a vault keeps its own bookkeeping in, and so what identifies one even
/// after every page has been deleted.
const VAULT_MARKER_DIRECTORY: &str = ".yonalist";
/// Frontmatter sits at the top of the file; reading past it would mean holding
/// an arbitrarily large document in memory to answer a yes-or-no question.
const README_PROBE_BYTES: u64 = 4096;

/// Two different problems with two different answers: the user can pick another
/// folder, but nothing they do fixes this app's own storage being unreachable,
/// and that one is worth retrying.
#[derive(Debug)]
pub(crate) enum VaultError {
    Rejected(String),
    Storage(String),
}

impl From<VaultError> for NotesError {
    fn from(error: VaultError) -> Self {
        match error {
            VaultError::Rejected(message) => NotesError {
                code: NotesErrorCode::InvalidDestination,
                message,
                retryable: false,
            },
            VaultError::Storage(message) => NotesError {
                code: NotesErrorCode::StorageUnavailable,
                message,
                retryable: true,
            },
        }
    }
}

/// Absent until the user picks one. That absence is what "first run" means, so
/// a data reset clearing this file puts the app back at first run without
/// touching the documents the folder holds.
pub(crate) fn read_vault_path(data_directory: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(data_directory.join(VAULT_PATH_FILE)).ok()?;
    // Only the line endings a hand edit might add: a folder name is allowed to
    // end in a space, and set writes the path with nothing appended.
    let trimmed = raw.trim_end_matches(['\n', '\r']);
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

pub(crate) fn set_vault_path(
    data_directory: &Path,
    vault: &Path,
) -> Result<SyncVaultFolderState, VaultError> {
    validate(data_directory, vault)?;
    fs::write(data_directory.join(VAULT_PATH_FILE), path_bytes(vault)?).map_err(|error| {
        VaultError::Storage(format!("Could not remember the vault location: {error}"))
    })?;
    Ok(classify(vault))
}

/// Reads the folder to describe it, never to change it. Hidden entries are what
/// Finder and the sync clients leave behind, so a folder holding only those is
/// still an empty one to the user.
fn classify(vault: &Path) -> SyncVaultFolderState {
    if vault.join(VAULT_MARKER_DIRECTORY).is_dir() {
        return SyncVaultFolderState::ExistingVault;
    }
    if readme_is_a_vault(&vault.join("README.md")) {
        return SyncVaultFolderState::ExistingVault;
    }
    let Ok(entries) = fs::read_dir(vault) else {
        return SyncVaultFolderState::Empty;
    };
    let visible = entries
        .flatten()
        .any(|entry| !entry.file_name().to_string_lossy().starts_with('.'));
    if visible {
        SyncVaultFolderState::NonEmpty
    } else {
        SyncVaultFolderState::Empty
    }
}

/// A README written by anything else is not a vault: without the frontmatter a
/// checkout of someone's project would read as one and invite a merge.
fn readme_is_a_vault(readme: &Path) -> bool {
    let Ok(file) = fs::File::open(readme) else {
        return false;
    };
    let mut head = Vec::new();
    if file
        .take(README_PROBE_BYTES)
        .read_to_end(&mut head)
        .is_err()
    {
        return false;
    }
    let head = String::from_utf8_lossy(&head);
    head.starts_with("---") && head.contains("kind: yonalist-")
}

/// Forgets where the vault is without going near it. The documents belong to
/// the user, not to this app's storage, so clearing the app's data returns to
/// first run and leaves the folder exactly as it stands.
pub(crate) fn clear_vault_path(data_directory: &Path) -> Result<(), String> {
    match fs::remove_file(data_directory.join(VAULT_PATH_FILE)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not forget the vault location: {error}")),
    }
}

fn path_bytes(vault: &Path) -> Result<String, VaultError> {
    vault
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| VaultError::Rejected("A vault path has to be valid UTF-8.".to_owned()))
}

/// The folder has to be one the app can keep writing to, and it must not overlap
/// the app's own storage in either direction: a vault inside `app_data_dir`
/// would be deleted by the reset that is supposed to leave the documents alone,
/// and one holding `app_data_dir` would later have the live database exported
/// into it as if it were a note.
fn validate(data_directory: &Path, vault: &Path) -> Result<(), VaultError> {
    if !vault.is_absolute() {
        return Err(VaultError::Rejected(
            "A vault path has to be absolute.".to_owned(),
        ));
    }
    let data_directory = fs::canonicalize(data_directory).map_err(|error| {
        VaultError::Storage(format!("Could not resolve the app's storage: {error}"))
    })?;
    let resolved = resolve_or_create(vault, &data_directory)?;
    if !resolved.is_dir() {
        return Err(VaultError::Rejected(
            "A vault has to be a folder.".to_owned(),
        ));
    }
    separate_from_storage(&resolved, &data_directory)
}

/// A folder the user names but has not made yet is theirs to have — the choice
/// is only recorded once it exists. Where it would go is checked before it is
/// made, so a rejected choice never leaves a folder behind.
fn resolve_or_create(vault: &Path, data_directory: &Path) -> Result<PathBuf, VaultError> {
    match fs::canonicalize(vault) {
        Ok(resolved) => Ok(resolved),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let (parent, name) = vault
                .parent()
                .zip(vault.file_name())
                .ok_or_else(|| VaultError::Rejected("Could not open that folder.".to_owned()))?;
            let parent = fs::canonicalize(parent).map_err(|error| {
                VaultError::Rejected(format!("Could not open that folder: {error}"))
            })?;
            let candidate = parent.join(name);
            separate_from_storage(&candidate, data_directory)?;
            fs::create_dir(&candidate).map_err(|error| {
                VaultError::Rejected(format!("Could not make that folder: {error}"))
            })?;
            fs::canonicalize(&candidate).map_err(|error| {
                VaultError::Rejected(format!("Could not open that folder: {error}"))
            })
        }
        Err(error) => Err(VaultError::Rejected(format!(
            "Could not open that folder: {error}"
        ))),
    }
}

fn separate_from_storage(vault: &Path, data_directory: &Path) -> Result<(), VaultError> {
    if vault.starts_with(data_directory) || data_directory.starts_with(vault) {
        return Err(VaultError::Rejected(
            "A vault cannot live inside the app's own storage, or hold it.".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The app's storage and the vault are separate places, which is the whole
    /// point of the rule the second test covers.
    fn workspace() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let directory = tempfile::tempdir().expect("temporary directory");
        let data = directory.path().join("app-data");
        let vault = directory.path().join("Notes");
        std::fs::create_dir_all(&data).expect("data");
        std::fs::create_dir_all(&vault).expect("vault");
        (directory, data, vault)
    }

    #[test]
    fn vault_path_round_trips_through_the_settings_file() {
        let (_directory, data, vault) = workspace();

        assert_eq!(read_vault_path(&data), None, "no vault means first run");
        set_vault_path(&data, &vault).expect("set");

        assert_eq!(read_vault_path(&data).as_deref(), Some(vault.as_path()));
    }

    #[test]
    fn choosing_a_folder_with_an_existing_vault_reports_it() {
        let (_directory, data, vault) = workspace();
        std::fs::write(
            vault.join("README.md"),
            b"---\nkind: yonalist-notes\nformat_version: 1\n---\n\n# Home\n",
        )
        .expect("document");

        assert_eq!(
            set_vault_path(&data, &vault).expect("set"),
            SyncVaultFolderState::ExistingVault
        );
    }

    #[test]
    fn a_marker_folder_alone_reports_an_existing_vault() {
        let (_directory, data, vault) = workspace();
        std::fs::create_dir(vault.join(".yonalist")).expect("marker");

        assert_eq!(
            set_vault_path(&data, &vault).expect("set"),
            SyncVaultFolderState::ExistingVault,
            "a vault whose pages were all deleted still belongs to Yonalist"
        );
    }

    #[test]
    fn an_unrelated_readme_is_not_a_vault() {
        let (_directory, data, vault) = workspace();
        std::fs::write(vault.join("README.md"), b"# Some project\n").expect("document");

        assert_eq!(
            set_vault_path(&data, &vault).expect("set"),
            SyncVaultFolderState::NonEmpty,
            "a git checkout is not a vault to merge with"
        );
    }

    #[test]
    fn hidden_entries_leave_a_folder_empty() {
        let (_directory, data, vault) = workspace();
        std::fs::write(vault.join(".DS_Store"), b"\x00").expect("finder");
        std::fs::create_dir(vault.join(".stfolder")).expect("syncthing");

        assert_eq!(
            set_vault_path(&data, &vault).expect("set"),
            SyncVaultFolderState::Empty,
            "what a sync client left behind is not the user's content"
        );
    }

    #[test]
    fn vault_set_writes_nothing_inside_the_chosen_folder() {
        let (_directory, data, vault) = workspace();
        std::fs::write(vault.join("README.md"), b"---\nkind: yonalist-notes\n---\n")
            .expect("document");
        let before = listing(&vault);

        set_vault_path(&data, &vault).expect("set");

        assert_eq!(
            before,
            listing(&vault),
            "reporting a folder is not entering it"
        );
    }

    fn listing(folder: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(folder)
            .expect("read")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_folder_that_does_not_exist_yet_is_created_and_empty() {
        let (_directory, data, vault) = workspace();
        let fresh = vault.join("Yonalist Vault");

        assert_eq!(
            set_vault_path(&data, &fresh).expect("set"),
            SyncVaultFolderState::Empty
        );
        assert!(
            fresh.is_dir(),
            "the folder the user named has to exist after"
        );
        assert_eq!(read_vault_path(&data).as_deref(), Some(fresh.as_path()));
    }

    #[test]
    fn a_vault_that_would_swallow_the_app_storage_is_rejected() {
        let (directory, data, _vault) = workspace();

        assert!(
            set_vault_path(&data, directory.path()).is_err(),
            "a vault holding the app's own storage would export the live database"
        );
    }

    #[test]
    fn a_bad_folder_and_broken_storage_read_differently() {
        let (_directory, data, vault) = workspace();

        assert!(matches!(
            set_vault_path(&data, std::path::Path::new("Notes")),
            Err(VaultError::Rejected(_))
        ));

        std::fs::remove_dir_all(&data).expect("remove");
        assert!(
            matches!(set_vault_path(&data, &vault), Err(VaultError::Storage(_))),
            "the folder was fine; it was this app's storage that was not"
        );
    }

    #[test]
    fn a_folder_name_keeps_its_trailing_space() {
        let (_directory, data, vault) = workspace();
        let spaced = vault.join("Notes ");
        std::fs::create_dir(&spaced).expect("spaced");

        set_vault_path(&data, &spaced).expect("set");

        assert_eq!(read_vault_path(&data).as_deref(), Some(spaced.as_path()));
    }

    #[test]
    fn a_relative_or_data_dir_path_is_rejected() {
        let (_directory, data, _vault) = workspace();
        let inside = data.join("vault");
        std::fs::create_dir_all(&inside).expect("inside");

        assert!(set_vault_path(&data, std::path::Path::new("Notes")).is_err());
        assert!(
            set_vault_path(&data, &inside).is_err(),
            "the reset that clears the database would take the documents with it"
        );
        let inside_missing = data.join("missing");
        assert!(set_vault_path(&data, &inside_missing).is_err());
        assert!(
            !inside_missing.exists(),
            "a folder that gets rejected must not be left behind"
        );
    }
}
