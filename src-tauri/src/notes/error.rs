//! Structured error taxonomy for the Notes IPC boundary.
//!
//! Every `notes_*` command returns [`Result<T, NotesError>`]. `NotesError`
//! carries both the existing human-facing `message` (unchanged, still shown to
//! the user) and a stable machine-readable [`NotesErrorCode`] so the frontend
//! can branch on `code` instead of matching message text.
//!
//! The repository/attachments/export/history helpers still return
//! `Result<_, String>`; this module is the single place their message text is
//! mapped to a `code`, via [`NotesError::classify`]. The command layer converts
//! at the boundary (see `run_blocking` in `commands.rs`) so those helpers — and
//! their existing tests — keep their `String` contracts unchanged.

use serde::Serialize;

/// Stable classification for a Notes command failure. Serialized as camelCase
/// strings (`"destinationExists"`, `"vaultBusy"`, …). Only codes that are
/// actually derivable from a real error site are defined here; everything else
/// falls back to [`NotesErrorCode::Internal`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NotesErrorCode {
    /// Another OS-level instance already holds the vault application lock
    /// (see [`crate::notes::attachments::VAULT_APP_LOCK_BUSY_MESSAGE`]).
    VaultBusy,
    /// The on-disk database records a schema version this build cannot open.
    UnsupportedSchemaVersion,
    /// A non-overwrite export refused because the destination path already
    /// exists (see [`crate::file_io::DESTINATION_EXISTS_MESSAGE`]).
    DestinationExists,
    /// An overwrite export refused because the `{stem}_assets` folder was not
    /// created by a previous export
    /// (see [`crate::notes::export::FOREIGN_EXPORT_ASSET_DIR_MESSAGE`]).
    ForeignExportAssetDir,
    /// A readonly-descendant delete acknowledgement no longer matches the
    /// repository's current tree.
    ReadonlyConfirmationStale,
    /// Any failure without a more specific classification.
    Internal,
}

/// Structured error serialized across the Notes IPC boundary as
/// `{ "code": "...", "message": "..." }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotesError {
    pub(crate) code: NotesErrorCode,
    pub(crate) message: String,
}

impl NotesError {
    pub(crate) fn new(code: NotesErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// Maps a legacy `String` error into a structured code, preserving the
    /// message verbatim. This is the one boundary that inspects message text;
    /// the strings it matches are Rust-owned constants (or a stable prefix),
    /// not caller input, so the mapping stays deterministic.
    pub(crate) fn classify(message: String) -> Self {
        let code = classify_message(&message);
        Self { code, message }
    }
}

fn classify_message(message: &str) -> NotesErrorCode {
    if message == crate::file_io::DESTINATION_EXISTS_MESSAGE {
        NotesErrorCode::DestinationExists
    } else if message == crate::notes::export::FOREIGN_EXPORT_ASSET_DIR_MESSAGE {
        NotesErrorCode::ForeignExportAssetDir
    } else if message == crate::notes::attachments::VAULT_APP_LOCK_BUSY_MESSAGE {
        NotesErrorCode::VaultBusy
    } else if message.starts_with(UNSUPPORTED_SCHEMA_VERSION_PREFIX) {
        NotesErrorCode::UnsupportedSchemaVersion
    } else if message == "Notes readonly delete confirmation is stale." {
        NotesErrorCode::ReadonlyConfirmationStale
    } else {
        NotesErrorCode::Internal
    }
}

/// Shared prefix of every "unsupported schema version" message the repository
/// produces (`"… unsupported schema version {n}."`). Kept in sync with
/// `repository.rs`; the trailing version number varies so we match the prefix.
pub(crate) const UNSUPPORTED_SCHEMA_VERSION_PREFIX: &str =
    "This Notes database uses unsupported schema version";

impl From<String> for NotesError {
    fn from(message: String) -> Self {
        Self::classify(message)
    }
}

impl std::fmt::Display for NotesError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serialized_code(error: &NotesError) -> String {
        let value = serde_json::to_value(error).expect("serialize NotesError");
        assert_eq!(value["message"], error.message.as_str());
        value["code"]
            .as_str()
            .expect("code is a string")
            .to_string()
    }

    #[test]
    fn classifies_destination_exists_by_code() {
        let error = NotesError::from(crate::file_io::DESTINATION_EXISTS_MESSAGE.to_string());
        assert_eq!(error.code, NotesErrorCode::DestinationExists);
        assert_eq!(serialized_code(&error), "destinationExists");
        assert_eq!(error.message, "Destination already exists.");
    }

    #[test]
    fn classifies_foreign_export_asset_dir_by_code() {
        let error =
            NotesError::from(crate::notes::export::FOREIGN_EXPORT_ASSET_DIR_MESSAGE.to_string());
        assert_eq!(error.code, NotesErrorCode::ForeignExportAssetDir);
        assert_eq!(serialized_code(&error), "foreignExportAssetDir");
    }

    #[test]
    fn classifies_vault_busy_by_code() {
        let error =
            NotesError::from(crate::notes::attachments::VAULT_APP_LOCK_BUSY_MESSAGE.to_string());
        assert_eq!(error.code, NotesErrorCode::VaultBusy);
        assert_eq!(serialized_code(&error), "vaultBusy");
    }

    #[test]
    fn classifies_unsupported_schema_version_by_code() {
        let error =
            NotesError::from("This Notes database uses unsupported schema version 99.".to_string());
        assert_eq!(error.code, NotesErrorCode::UnsupportedSchemaVersion);
        assert_eq!(serialized_code(&error), "unsupportedSchemaVersion");
    }

    #[test]
    fn unclassified_messages_fall_back_to_internal() {
        let error = NotesError::from("A node could not be found.".to_string());
        assert_eq!(error.code, NotesErrorCode::Internal);
        assert_eq!(serialized_code(&error), "internal");
        assert_eq!(error.message, "A node could not be found.");
    }
}
