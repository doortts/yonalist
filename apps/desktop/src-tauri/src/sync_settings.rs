//! Where the vault lives. The path is the one piece of sync state the adapter
//! owns rather than the database: it has to be readable before the worker is up,
//! and a data reset clears it without touching the folder it names.

use std::fs;
use std::path::{Path, PathBuf};

const VAULT_PATH_FILE: &str = "vault-path";

/// Absent until the user picks one. That absence is what "first run" means, so
/// a data reset clearing this file puts the app back at first run without
/// touching the documents the folder holds.
pub(crate) fn read_vault_path(data_directory: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(data_directory.join(VAULT_PATH_FILE)).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

pub(crate) fn set_vault_path(data_directory: &Path, vault: &Path) -> Result<(), String> {
    validate(data_directory, vault)?;
    fs::write(data_directory.join(VAULT_PATH_FILE), path_bytes(vault)?)
        .map_err(|error| format!("Could not remember the vault location: {error}"))
}

fn path_bytes(vault: &Path) -> Result<String, String> {
    vault
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "A vault path has to be valid UTF-8.".to_owned())
}

/// The folder has to be one the app can keep writing to, and it must not be the
/// app's own storage: a vault inside `app_data_dir` would be deleted by the very
/// reset that is supposed to leave the documents alone.
fn validate(data_directory: &Path, vault: &Path) -> Result<(), String> {
    if !vault.is_absolute() {
        return Err("A vault path has to be absolute.".to_owned());
    }
    let resolved =
        fs::canonicalize(vault).map_err(|error| format!("Could not open that folder: {error}"))?;
    if !resolved.is_dir() {
        return Err("A vault has to be a folder.".to_owned());
    }
    let data_directory = fs::canonicalize(data_directory)
        .map_err(|error| format!("Could not resolve the app's storage: {error}"))?;
    if resolved.starts_with(&data_directory) {
        return Err("A vault cannot live inside the app's own storage.".to_owned());
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
    fn a_relative_or_data_dir_path_is_rejected() {
        let (_directory, data, _vault) = workspace();
        let inside = data.join("vault");
        std::fs::create_dir_all(&inside).expect("inside");

        assert!(set_vault_path(&data, std::path::Path::new("Notes")).is_err());
        assert!(
            set_vault_path(&data, &inside).is_err(),
            "the reset that clears the database would take the documents with it"
        );
        assert!(set_vault_path(&data, &data.join("missing")).is_err());
    }
}
