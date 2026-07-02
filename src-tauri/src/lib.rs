use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct VaultPaths {
    pub metadata_dir: String,
    pub outbox_dir: String,
}

fn display_path(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

pub fn vault_paths(vault_path: impl AsRef<Path>) -> VaultPaths {
    let vault_path = vault_path.as_ref();
    let metadata_dir = vault_path.join(".yonalist");
    let outbox_dir = metadata_dir.join("outbox");

    VaultPaths {
        metadata_dir: display_path(metadata_dir),
        outbox_dir: display_path(outbox_dir),
    }
}

/// Resolves a vault-relative file path, rejecting absolute paths and any
/// component that could escape the vault root (`..`, drive prefixes, ...).
pub fn resolve_vault_file(vault_path: &str, relative_path: &str) -> Result<PathBuf, String> {
    if vault_path.trim().is_empty() {
        return Err("Vault path must not be empty.".to_string());
    }

    let relative = Path::new(relative_path);
    if relative.as_os_str().is_empty() {
        return Err("File path must not be empty.".to_string());
    }
    if relative.is_absolute() {
        return Err("File path must be relative to the vault.".to_string());
    }
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("File path may not contain '..', '.' or root components.".to_string());
    }

    Ok(Path::new(vault_path).join(relative))
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Writes through a sibling temp file and renames it into place so a crash
/// mid-write never leaves a truncated vault document behind.
fn write_text_file_inner(path: &Path, contents: &str) -> Result<(), String> {
    ensure_parent(path)?;

    let mut temp_name = path
        .file_name()
        .ok_or_else(|| "File path must name a file.".to_string())?
        .to_os_string();
    temp_name.push(".tmp");
    let temp_path = path.with_file_name(temp_name);

    fs::write(&temp_path, contents).map_err(|error| error.to_string())?;
    fs::rename(&temp_path, path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        error.to_string()
    })
}

#[tauri::command]
fn ensure_vault(vault_path: String) -> Result<VaultPaths, String> {
    let paths = vault_paths(&vault_path);
    fs::create_dir_all(&paths.outbox_dir).map_err(|error| error.to_string())?;
    Ok(paths)
}

#[tauri::command]
fn read_text_file(vault_path: String, relative_path: String) -> Result<String, String> {
    let path = resolve_vault_file(&vault_path, &relative_path)?;
    fs::read_to_string(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_text_file(
    vault_path: String,
    relative_path: String,
    contents: String,
) -> Result<(), String> {
    let path = resolve_vault_file(&vault_path, &relative_path)?;
    write_text_file_inner(&path, &contents)
}

#[tauri::command]
fn store_token(service: String, account: String, token: String) -> Result<(), String> {
    let entry = keyring::Entry::new(&service, &account).map_err(|error| error.to_string())?;
    entry
        .set_password(&token)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn load_token(service: String, account: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(&service, &account).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            ensure_vault,
            read_text_file,
            write_text_file,
            store_token,
            load_token
        ])
        .run(tauri::generate_context!())
        .expect("error while running Yonalist");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_paths_match_markdown_vault_plan() {
        let paths = vault_paths("/tmp/yonalist-vault");

        assert_eq!(paths.metadata_dir, "/tmp/yonalist-vault/.yonalist");
        assert_eq!(paths.outbox_dir, "/tmp/yonalist-vault/.yonalist/outbox");
    }

    #[test]
    fn write_text_file_creates_parent_directories() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let path = temp_dir
            .path()
            .join("github.com")
            .join("openai")
            .join("codex")
            .join("issues")
            .join("42")
            .join("issue.md");

        write_text_file_inner(&path, "---\nkind: issue\n---\nbody").expect("write file");

        let contents = fs::read_to_string(path).expect("read file");
        assert!(contents.contains("kind: issue"));
    }

    #[test]
    fn write_text_file_leaves_no_temp_file_behind() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let path = temp_dir.path().join("issue.md");

        write_text_file_inner(&path, "body").expect("write file");

        let entries: Vec<_> = fs::read_dir(temp_dir.path())
            .expect("read dir")
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("issue.md")]);
    }

    #[test]
    fn resolve_vault_file_joins_relative_paths() {
        let path = resolve_vault_file("/tmp/vault", "github.com/openai/codex/issues/42/issue.md")
            .expect("resolve");

        assert_eq!(
            path,
            PathBuf::from("/tmp/vault/github.com/openai/codex/issues/42/issue.md")
        );
    }

    #[test]
    fn resolve_vault_file_rejects_escaping_paths() {
        assert!(resolve_vault_file("/tmp/vault", "../outside.md").is_err());
        assert!(resolve_vault_file("/tmp/vault", "nested/../../outside.md").is_err());
        assert!(resolve_vault_file("/tmp/vault", "/etc/passwd").is_err());
        assert!(resolve_vault_file("/tmp/vault", "").is_err());
        assert!(resolve_vault_file("", "issue.md").is_err());
    }
}
