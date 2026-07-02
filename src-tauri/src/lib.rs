use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

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

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn write_text_file_inner(path: &Path, contents: &str) -> Result<(), String> {
    ensure_parent(path)?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

#[tauri::command]
fn ensure_vault(vault_path: String) -> Result<VaultPaths, String> {
    let paths = vault_paths(&vault_path);
    fs::create_dir_all(&paths.outbox_dir).map_err(|error| error.to_string())?;
    Ok(paths)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    write_text_file_inner(Path::new(&path), &contents)
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
}
