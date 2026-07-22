use crate::file_io::{
    capability_file_identity, capability_file_link_count, capability_metadata_is_reparse_point,
    hold_capability_regular_file_bounded_nofollow,
    hold_capability_regular_file_bounded_nofollow_writable, rename_noreplace,
    HeldBoundedCapabilityFile,
};
#[cfg(windows)]
use crate::file_io::{
    establish_windows_private_directory_security, validate_windows_private_directory_security,
};
use crate::notes::attachments::{AttachmentStorageLease, MAX_ATTACHMENT_BYTES};
use crate::notes::connection::{acquire_notes_connection, lock_notes_connection};
use crate::notes::error::{NotesError, NotesErrorCode};
use crate::notes::repository::validate_vault_path;
use crate::notes::types::NoteAttachment;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
#[cfg(unix)]
use cap_std::fs::DirBuilderExt;
use cap_std::fs::{Dir, DirBuilder, OpenOptions};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use uuid::Uuid;

const COPY_CHUNK_BYTES: usize = 1024 * 1024;
/// C1: freshly written asset bytes can reach disk before the DB attachment row
/// that references them (ingest race), so a live asset with no references is
/// only quarantined once its file has aged past this window.
/// ponytail: 24h constant, no setting — the ingest→commit gap is milliseconds.
const MIN_UNREFERENCED_QUARANTINE_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const STAGING_DIRECTORY_PREFIX: &str = ".asset-gc-staging-";
pub(crate) const RETIRED_DIRECTORY_PREFIX: &str = ".asset-gc-retired-";
pub(crate) const PRIVATE_ASSET_PAYLOAD: &str = "payload";
const PRIVATE_ASSET_OPERATION_ATTESTATION: &str = "intent.json";
const PRIVATE_ASSET_OPERATION_TEMP: &str = "intent.tmp";
const PRIVATE_ASSET_OPERATION_COMPLETION: &str = "complete.json";
const PRIVATE_ASSET_OPERATION_COMPLETION_TEMP: &str = "complete.tmp";
const PRIVATE_ASSET_OPERATION_VERSION: u8 = 1;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AssetOperationAttestation {
    version: u8,
    kind: AssetOperationKind,
    state: AssetOperationState,
    device: u64,
    inode: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    byte_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_hash: Option<String>,
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum AssetOperationKind {
    Staging,
    Retirement,
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum AssetOperationState {
    Intent,
    Complete,
}

#[cfg(test)]
thread_local! {
    static INJECTED_SYNC_FAILURE_AFTER: std::cell::Cell<Option<usize>> = const {
        std::cell::Cell::new(None)
    };
    static INJECTED_BEFORE_OWNED_FILE_REMOVE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECT_COPY_ABORT_AFTER_WRITE: std::cell::Cell<bool> = const {
        std::cell::Cell::new(false)
    };
    static INJECTED_BEFORE_OWNED_FILE_OPEN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_BEFORE_OWNED_FILE_READ: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_BEFORE_GC_FILE_MUTATION: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_AFTER_GC_FILE_MUTATION: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_BEFORE_GC_ROW_DELETE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_BEFORE_ISOLATED_RESTORE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECT_ISOLATED_DELETE_FAILURE: std::cell::Cell<bool> = const {
        std::cell::Cell::new(false)
    };
    static INJECT_RETIREMENT_AUTHORIZATION_FAILURE: std::cell::Cell<bool> = const {
        std::cell::Cell::new(false)
    };
    static INJECTED_BEFORE_SAME_FILESYSTEM_MOVE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_BEFORE_STAGED_PUBLICATION: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECT_OPERATION_ATTESTATION_PUBLISH_FAILURE: std::cell::Cell<bool> = const {
        std::cell::Cell::new(false)
    };
    static INJECTED_AFTER_UNUSED_ASSET_EVIDENCE: std::cell::RefCell<Option<Box<dyn FnMut()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_AFTER_RETIRED_HANDLE_DROP: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_BEFORE_COPY_SOURCE_RETIREMENT: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_AFTER_PUBLISHED_ASSET_HOLD: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_AFTER_COPY_DESTINATION_HASH: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_AFTER_PUBLISHED_ASSET_HASH: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_AFTER_MOVED_ASSET_HASH: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_BEFORE_EXACT_ROLLBACK_MOVE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_AFTER_EXACT_ROLLBACK_HASH: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_BEFORE_LAST_COPY_RETIREMENT: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_AFTER_RETIREMENT_FINAL_HASH: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECT_MOVE_VALIDATION_FAILURE: std::cell::Cell<bool> = const {
        std::cell::Cell::new(false)
    };
    static INJECTED_DURING_MOVE_RECOVERY_VALIDATION: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_AFTER_EXACT_ROLLBACK_FINAL_BINDING: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_AFTER_EXACT_ROLLBACK_MOVE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_AFTER_STAGING_PAYLOAD_CREATION: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_AFTER_COUNTERPART_ISOLATION: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_AFTER_MOVE_RECOVERY_FINAL_BINDING: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

#[cfg(test)]
fn inject_sync_failure_after(successful_calls: usize) {
    INJECTED_SYNC_FAILURE_AFTER.with(|remaining| remaining.set(Some(successful_calls)));
}

#[cfg(test)]
fn maybe_inject_sync_failure() -> Result<(), String> {
    INJECTED_SYNC_FAILURE_AFTER.with(|remaining| match remaining.get() {
        Some(0) => {
            remaining.set(None);
            Err("Injected Notes asset directory sync failure.".to_string())
        }
        Some(calls) => {
            remaining.set(Some(calls - 1));
            Ok(())
        }
        None => Ok(()),
    })
}

#[cfg(test)]
pub(crate) fn inject_before_owned_file_remove_once(action: impl FnOnce() + 'static) {
    INJECTED_BEFORE_OWNED_FILE_REMOVE.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_before_owned_file_remove() {
    INJECTED_BEFORE_OWNED_FILE_REMOVE.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_owned_file_remove() {}

#[cfg(test)]
fn inject_copy_abort_after_write_once() {
    INJECT_COPY_ABORT_AFTER_WRITE.with(|injected| injected.set(true));
}

#[cfg(test)]
fn maybe_inject_copy_abort_after_write() {
    INJECT_COPY_ABORT_AFTER_WRITE.with(|injected| {
        if injected.replace(false) {
            panic!("Injected abrupt Notes asset copy termination.");
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_copy_abort_after_write() {}

#[cfg(test)]
fn inject_before_owned_file_open_once(action: impl FnOnce() + 'static) {
    INJECTED_BEFORE_OWNED_FILE_OPEN.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_before_owned_file_open() {
    INJECTED_BEFORE_OWNED_FILE_OPEN.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_owned_file_open() {}

#[cfg(test)]
fn inject_before_owned_file_read_once(action: impl FnOnce() + 'static) {
    INJECTED_BEFORE_OWNED_FILE_READ.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_before_owned_file_read() {
    INJECTED_BEFORE_OWNED_FILE_READ.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_owned_file_read() {}

#[cfg(test)]
fn inject_before_gc_file_mutation_once(action: impl FnOnce() + 'static) {
    INJECTED_BEFORE_GC_FILE_MUTATION.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_before_gc_file_mutation() {
    INJECTED_BEFORE_GC_FILE_MUTATION.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_gc_file_mutation() {}

#[cfg(test)]
fn inject_after_gc_file_mutation_once(action: impl FnOnce() + 'static) {
    INJECTED_AFTER_GC_FILE_MUTATION.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_after_gc_file_mutation() {
    INJECTED_AFTER_GC_FILE_MUTATION.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_after_gc_file_mutation() {}

#[cfg(test)]
fn inject_before_gc_row_delete_once(action: impl FnOnce() + 'static) {
    INJECTED_BEFORE_GC_ROW_DELETE.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_before_gc_row_delete() {
    INJECTED_BEFORE_GC_ROW_DELETE.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_gc_row_delete() {}

#[cfg(test)]
fn inject_before_isolated_restore_once(action: impl FnOnce() + 'static) {
    INJECTED_BEFORE_ISOLATED_RESTORE.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_before_isolated_restore() {
    INJECTED_BEFORE_ISOLATED_RESTORE.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_isolated_restore() {}

#[cfg(test)]
fn inject_isolated_delete_failure_once() {
    INJECT_ISOLATED_DELETE_FAILURE.with(|injected| injected.set(true));
}

#[cfg(test)]
pub(crate) fn inject_retirement_authorization_failure_once() {
    INJECT_RETIREMENT_AUTHORIZATION_FAILURE.with(|injected| injected.set(true));
}

#[cfg(test)]
fn maybe_inject_retirement_authorization_failure() -> Result<(), String> {
    INJECT_RETIREMENT_AUTHORIZATION_FAILURE.with(|injected| {
        if injected.replace(false) {
            Err("Injected Notes asset retirement authorization failure.".to_string())
        } else {
            Ok(())
        }
    })
}

#[cfg(test)]
fn inject_before_same_filesystem_move_once(action: impl FnOnce() + 'static) {
    INJECTED_BEFORE_SAME_FILESYSTEM_MOVE.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_before_same_filesystem_move() {
    INJECTED_BEFORE_SAME_FILESYSTEM_MOVE.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_same_filesystem_move() {}

#[cfg(test)]
pub(crate) fn inject_before_staged_publication_once(action: impl FnOnce() + 'static) {
    INJECTED_BEFORE_STAGED_PUBLICATION.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_before_staged_publication() {
    INJECTED_BEFORE_STAGED_PUBLICATION.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_staged_publication() {}

#[cfg(test)]
fn inject_operation_attestation_publish_failure_once() {
    INJECT_OPERATION_ATTESTATION_PUBLISH_FAILURE.with(|injected| injected.set(true));
}

#[cfg(test)]
fn maybe_inject_operation_attestation_publish_failure() -> Result<(), String> {
    INJECT_OPERATION_ATTESTATION_PUBLISH_FAILURE.with(|injected| {
        if injected.replace(false) {
            Err("Injected Notes asset operation attestation publication failure.".to_string())
        } else {
            Ok(())
        }
    })
}

#[cfg(test)]
fn inject_after_unused_asset_evidence(action: impl FnMut() + 'static) {
    INJECTED_AFTER_UNUSED_ASSET_EVIDENCE.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn clear_after_unused_asset_evidence() {
    INJECTED_AFTER_UNUSED_ASSET_EVIDENCE.with(|injected| {
        injected.borrow_mut().take();
    });
}

#[cfg(test)]
fn maybe_inject_after_unused_asset_evidence() {
    INJECTED_AFTER_UNUSED_ASSET_EVIDENCE.with(|injected| {
        if let Some(action) = injected.borrow_mut().as_mut() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_after_unused_asset_evidence() {}

#[cfg(test)]
pub(crate) fn inject_after_retired_handle_drop_once(action: impl FnOnce() + 'static) {
    INJECTED_AFTER_RETIRED_HANDLE_DROP.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_after_retired_handle_drop() {
    INJECTED_AFTER_RETIRED_HANDLE_DROP.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_after_retired_handle_drop() {}

#[cfg(test)]
fn inject_before_copy_source_retirement_once(action: impl FnOnce() + 'static) {
    INJECTED_BEFORE_COPY_SOURCE_RETIREMENT.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_before_copy_source_retirement() {
    INJECTED_BEFORE_COPY_SOURCE_RETIREMENT.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_copy_source_retirement() {}

#[cfg(test)]
pub(crate) fn inject_after_published_asset_hold_once(action: impl FnOnce() + 'static) {
    INJECTED_AFTER_PUBLISHED_ASSET_HOLD.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_after_published_asset_hold() {
    INJECTED_AFTER_PUBLISHED_ASSET_HOLD.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_after_published_asset_hold() {}

macro_rules! one_shot_test_hook {
    ($inject:ident, $maybe:ident, $slot:ident) => {
        #[cfg(test)]
        pub(crate) fn $inject(action: impl FnOnce() + 'static) {
            $slot.with(|injected| *injected.borrow_mut() = Some(Box::new(action)));
        }

        #[cfg(test)]
        fn $maybe() {
            $slot.with(|injected| {
                if let Some(action) = injected.borrow_mut().take() {
                    action();
                }
            });
        }

        #[cfg(not(test))]
        fn $maybe() {}
    };
}

one_shot_test_hook!(
    inject_after_copy_destination_hash_once,
    maybe_inject_after_copy_destination_hash,
    INJECTED_AFTER_COPY_DESTINATION_HASH
);
one_shot_test_hook!(
    inject_after_published_asset_hash_once,
    maybe_inject_after_published_asset_hash,
    INJECTED_AFTER_PUBLISHED_ASSET_HASH
);
one_shot_test_hook!(
    inject_after_moved_asset_hash_once,
    maybe_inject_after_moved_asset_hash,
    INJECTED_AFTER_MOVED_ASSET_HASH
);
one_shot_test_hook!(
    inject_before_exact_rollback_move_once,
    maybe_inject_before_exact_rollback_move,
    INJECTED_BEFORE_EXACT_ROLLBACK_MOVE
);
one_shot_test_hook!(
    inject_after_exact_rollback_hash_once,
    maybe_inject_after_exact_rollback_hash,
    INJECTED_AFTER_EXACT_ROLLBACK_HASH
);
one_shot_test_hook!(
    inject_before_last_copy_retirement_once,
    maybe_inject_before_last_copy_retirement,
    INJECTED_BEFORE_LAST_COPY_RETIREMENT
);
one_shot_test_hook!(
    inject_after_retirement_final_hash_once,
    maybe_inject_after_retirement_final_hash,
    INJECTED_AFTER_RETIREMENT_FINAL_HASH
);
one_shot_test_hook!(
    inject_during_move_recovery_validation_once,
    maybe_inject_during_move_recovery_validation,
    INJECTED_DURING_MOVE_RECOVERY_VALIDATION
);
one_shot_test_hook!(
    inject_after_exact_rollback_final_binding_once,
    maybe_inject_after_exact_rollback_final_binding,
    INJECTED_AFTER_EXACT_ROLLBACK_FINAL_BINDING
);
one_shot_test_hook!(
    inject_after_exact_rollback_move_once,
    maybe_inject_after_exact_rollback_move,
    INJECTED_AFTER_EXACT_ROLLBACK_MOVE
);
one_shot_test_hook!(
    inject_after_staging_payload_creation_once,
    maybe_inject_after_staging_payload_creation,
    INJECTED_AFTER_STAGING_PAYLOAD_CREATION
);
one_shot_test_hook!(
    inject_after_counterpart_isolation_once,
    maybe_inject_after_counterpart_isolation,
    INJECTED_AFTER_COUNTERPART_ISOLATION
);
one_shot_test_hook!(
    inject_after_move_recovery_final_binding_once,
    maybe_inject_after_move_recovery_final_binding,
    INJECTED_AFTER_MOVE_RECOVERY_FINAL_BINDING
);

#[cfg(test)]
fn inject_move_validation_failure_once() {
    INJECT_MOVE_VALIDATION_FAILURE.with(|injected| injected.set(true));
}

#[cfg(test)]
fn maybe_inject_move_validation_failure(validation: &mut Result<(), String>) {
    INJECT_MOVE_VALIDATION_FAILURE.with(|injected| {
        if injected.replace(false) {
            *validation = Err("injected moved destination validation failure".to_string());
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_move_validation_failure(_validation: &mut Result<(), String>) {}

#[cfg(not(test))]
fn maybe_inject_operation_attestation_publish_failure() -> Result<(), String> {
    Ok(())
}

#[cfg(not(test))]
fn maybe_inject_retirement_authorization_failure() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
fn maybe_inject_isolated_delete_failure() -> Result<(), String> {
    INJECT_ISOLATED_DELETE_FAILURE.with(|injected| {
        if injected.replace(false) {
            Err("Injected isolated Notes asset delete failure.".to_string())
        } else {
            Ok(())
        }
    })
}

#[cfg(not(test))]
fn maybe_inject_isolated_delete_failure() -> Result<(), String> {
    Ok(())
}

#[cfg(not(test))]
fn maybe_inject_sync_failure() -> Result<(), String> {
    Ok(())
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AssetGcConfig {
    pub(crate) asset_trash_retention_days: u16,
    pub(crate) asset_trash_large_file_days: u16,
    pub(crate) asset_large_file_threshold_mb: u16,
}

impl Default for AssetGcConfig {
    fn default() -> Self {
        Self {
            asset_trash_retention_days: 7,
            asset_trash_large_file_days: 2,
            asset_large_file_threshold_mb: 5,
        }
    }
}

impl AssetGcConfig {
    pub(crate) fn validate(self) -> Result<Self, String> {
        if self.asset_trash_retention_days > 365
            || self.asset_trash_large_file_days > 365
            || self.asset_large_file_threshold_mb > 365
        {
            return Err("Notes asset GC settings must be integers between 0 and 365.".to_string());
        }
        Ok(self)
    }

    fn retention_days(self, byte_size: u64) -> u16 {
        let threshold = u64::from(self.asset_large_file_threshold_mb) * 1024 * 1024;
        if byte_size >= threshold {
            self.asset_trash_large_file_days
        } else {
            self.asset_trash_retention_days
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PurgeReport {
    pub(crate) count: u32,
    pub(crate) total_bytes: u64,
}

#[derive(Clone, Default)]
pub(crate) struct AssetPurgePreviewState(Arc<Mutex<HashMap<String, String>>>);

#[derive(Debug, Clone)]
struct AssetFile {
    content_hash: String,
    extension: String,
    name: PathBuf,
    byte_size: u64,
}

fn parse_asset_name(name: &Path) -> Option<(String, String)> {
    let name = name.to_str()?;
    let (content_hash, extension) = name.split_once('.')?;
    if content_hash.len() != 64
        || !content_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        || !matches!(extension, "png" | "jpg" | "webp" | "gif")
    {
        return None;
    }
    Some((content_hash.to_string(), extension.to_string()))
}

/// Returns the owned regular asset files plus a per-entry error list. C2: an
/// individual symlink/hardlink/unreadable entry is skipped and collected rather
/// than aborting the whole GC pass, so one bad file cannot wedge quarantine,
/// restore, and expiry for every other asset.
fn list_assets(directory: &Dir) -> Result<(Vec<AssetFile>, Vec<String>), String> {
    let mut assets = Vec::new();
    let mut errors = Vec::new();
    for entry in directory
        .entries()
        .map_err(|error| format!("Could not inspect Notes assets: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Could not inspect a Notes asset: {error}"))?;
        let name = PathBuf::from(entry.file_name());
        let Some((content_hash, extension)) = parse_asset_name(&name) else {
            continue;
        };
        let metadata = match directory.symlink_metadata(&name) {
            Ok(metadata) => metadata,
            Err(error) => {
                errors.push(format!("Could not inspect Notes asset {name:?}: {error}"));
                continue;
            }
        };
        let single_link = match has_single_link(&metadata) {
            Ok(single_link) => single_link,
            Err(error) => {
                errors.push(error);
                continue;
            }
        };
        if !metadata.is_file() || metadata.is_symlink() || !single_link {
            errors.push(format!(
                "The Notes asset {name:?} must be an owned regular file."
            ));
            continue;
        }
        assets.push(AssetFile {
            content_hash,
            extension,
            name,
            byte_size: metadata.len(),
        });
    }
    assets.sort_by(|left, right| left.name.cmp(&right.name));
    Ok((assets, errors))
}

fn has_references(connection: &Connection, content_hash: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_attachments WHERE content_hash = ?1)",
            [content_hash],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not derive the Notes asset refcount: {error}"))
}

/// C1: a quarantined topic's parse was rejected, so its attachment rows are not
/// in `notes_attachments` yet. If any topic is quarantined we skip the whole
/// live→trash quarantine phase so those not-yet-inserted references cannot look
/// unreferenced and get swept away. Tolerant of the `sync_topics` table being
/// absent (unit fixtures) — production schema v2 always has it.
fn any_topic_quarantined(connection: &Connection) -> Result<bool, String> {
    let has_table: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master \
               WHERE type = 'table' AND name = 'sync_topics')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect the Notes sync schema: {error}"))?;
    if !has_table {
        return Ok(false);
    }
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_topics WHERE quarantined = 1)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect quarantined Notes topics: {error}"))
}

fn path_exists(directory: &Dir, name: &Path) -> Result<bool, String> {
    match directory.symlink_metadata(name) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Could not inspect Notes asset {name:?}: {error}")),
    }
}

fn owned_file_matches_hash(
    directory: &Dir,
    name: &Path,
    expected_hash: &str,
) -> Result<bool, String> {
    maybe_inject_before_owned_file_open();
    let held = hold_capability_regular_file_bounded_nofollow(directory, name, MAX_ATTACHMENT_BYTES)
        .map_err(|error| format!("Could not securely open Notes asset {name:?}: {error}"))?;
    let metadata = held
        .metadata()
        .map_err(|error| format!("Could not inspect Notes asset {name:?}: {error}"))?;
    if !has_single_link(&metadata)? {
        return Err(format!(
            "The Notes asset {name:?} must be an owned regular file."
        ));
    }
    maybe_inject_before_owned_file_read();
    let mut file = held
        .reader_from_start()
        .map_err(|error| format!("Could not retain Notes asset {name:?}: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; COPY_CHUNK_BYTES];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not hash Notes asset {name:?}: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    held.verify_at(directory, name).map_err(|error| {
        format!("The Notes asset {name:?} changed while it was hashed: {error}")
    })?;
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
        == expected_hash)
}

#[cfg(unix)]
fn sync_directory(directory: &Dir) -> Result<(), String> {
    maybe_inject_sync_failure()?;
    directory
        .try_clone()
        .and_then(|directory| directory.into_std_file().sync_all())
        .map_err(|error| format!("Could not sync a Notes asset directory: {error}"))
}

#[cfg(not(unix))]
fn sync_directory(_directory: &Dir) -> Result<(), String> {
    maybe_inject_sync_failure()?;
    Ok(())
}

fn has_single_link(metadata: &cap_std::fs::Metadata) -> Result<bool, String> {
    capability_file_link_count(metadata)
        .map(|count| count == 1)
        .map_err(|error| format!("Could not determine a Notes asset link count: {error}"))
}

fn validate_private_directory_security(
    directory: &Dir,
    name: &Path,
    metadata: &cap_std::fs::Metadata,
) -> Result<(), String> {
    #[cfg(not(windows))]
    let _ = directory;
    if capability_metadata_is_reparse_point(metadata) || !metadata.is_dir() {
        return Err(format!(
            "The private Notes asset directory {name:?} must be an owned directory."
        ));
    }
    #[cfg(windows)]
    validate_windows_private_directory_security(
        directory,
        &format!("private Notes asset directory {name:?}"),
    )?;
    #[cfg(unix)]
    if cap_std::fs::MetadataExt::uid(metadata) != rustix::process::geteuid().as_raw()
        || cap_std::fs::MetadataExt::mode(metadata) & 0o777 != 0o700
    {
        return Err(format!(
            "The private Notes asset directory {name:?} must be private to its owner."
        ));
    }
    Ok(())
}

pub(crate) fn create_private_directory(
    parent: &Dir,
    prefix: &str,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<(Dir, PathBuf, (u64, u64)), String> {
    let mut builder = DirBuilder::new();
    #[cfg(unix)]
    builder.mode(0o700);
    for _ in 0..128 {
        let name = PathBuf::from(format!("{prefix}{}", Uuid::new_v4()));
        validate_directories()?;
        match parent.create_dir_with(&name, &builder) {
            Ok(()) => {
                validate_directories()?;
                let directory = parent.open_dir_nofollow(&name).map_err(|error| {
                    format!("Could not hold private Notes asset directory {name:?}: {error}")
                })?;
                #[cfg(windows)]
                establish_windows_private_directory_security(
                    &directory,
                    &format!("private Notes asset directory {name:?}"),
                )?;
                let metadata = directory.dir_metadata().map_err(|error| {
                    format!("Could not inspect private Notes asset directory {name:?}: {error}")
                })?;
                validate_private_directory_security(&directory, &name, &metadata)?;
                let identity = capability_file_identity(&metadata).map_err(|error| {
                    format!("Could not identify private Notes asset directory {name:?}: {error}")
                })?;
                revalidate_private_directory(parent, &name, identity)?;
                return Ok((directory, name, identity));
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Could not create the private Notes asset directory {name:?}: {error}"
                ))
            }
        }
    }
    Err("Could not allocate a private Notes asset directory.".to_string())
}

fn revalidate_private_directory(
    parent: &Dir,
    name: &Path,
    identity: (u64, u64),
) -> Result<(), String> {
    let current_directory = parent.open_dir_nofollow(name).map_err(|error| {
        format!("Could not revalidate private Notes asset directory {name:?}: {error}")
    })?;
    let current = current_directory.dir_metadata().map_err(|error| {
        format!("Could not inspect private Notes asset directory {name:?}: {error}")
    })?;
    validate_private_directory_security(&current_directory, name, &current)?;
    if capability_file_identity(&current).map_err(|error| {
        format!("Could not identify private Notes asset directory {name:?}: {error}")
    })? != identity
    {
        return Err(format!(
            "The private Notes asset directory {name:?} identity changed."
        ));
    }
    Ok(())
}

pub(crate) fn reclaim_private_asset_operation_payload(
    parent: &Dir,
    name: &Path,
) -> Result<bool, String> {
    if !is_private_asset_operation_name(name) {
        return Err(format!(
            "Refusing to reclaim a non-private Notes asset operation {name:?}."
        ));
    }
    let directory = parent.open_dir_nofollow(name).map_err(|error| {
        format!("Could not hold private Notes asset operation {name:?}: {error}")
    })?;
    let metadata = directory.dir_metadata().map_err(|error| {
        format!("Could not inspect private Notes asset operation {name:?}: {error}")
    })?;
    validate_private_directory_security(&directory, name, &metadata)?;
    let identity = capability_file_identity(&metadata).map_err(|error| {
        format!("Could not identify private Notes asset operation {name:?}: {error}")
    })?;
    revalidate_private_directory(parent, name, identity)?;

    let payload_name = Path::new(PRIVATE_ASSET_PAYLOAD);
    let payload = match hold_capability_regular_file_bounded_nofollow_writable(
        &directory,
        payload_name,
        MAX_ATTACHMENT_BYTES,
    ) {
        Ok(payload) => payload,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Could not hold private Notes asset operation payload {name:?}: {error}"
            ))
        }
    };
    let payload_metadata = payload.metadata().map_err(|error| {
        format!("Could not inspect private Notes asset operation payload {name:?}: {error}")
    })?;
    if !has_single_link(&payload_metadata)? || payload.verify_at(&directory, payload_name).is_err()
    {
        return Err(format!(
            "The private Notes asset operation payload {name:?} changed before reclamation."
        ));
    }
    revalidate_private_directory(parent, name, identity)?;
    payload.truncate_and_sync().map_err(|error| {
        format!("Could not reclaim private Notes asset operation payload {name:?}: {error}")
    })?;
    sync_directory(&directory)?;
    Ok(true)
}

pub(crate) fn is_private_asset_operation_name(name: &Path) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    [STAGING_DIRECTORY_PREFIX, RETIRED_DIRECTORY_PREFIX]
        .into_iter()
        .find_map(|prefix| name.strip_prefix(prefix))
        .is_some_and(|suffix| Uuid::parse_str(suffix).is_ok())
}

pub(crate) fn reclaim_all_owned_asset_entries(directory: &Dir) -> Result<(), String> {
    let mut names = directory
        .entries()
        .map_err(|error| format!("Could not enumerate owned Notes asset files: {error}"))?
        .map(|entry| {
            entry
                .map(|entry| PathBuf::from(entry.file_name()))
                .map_err(|error| format!("Could not inspect an owned Notes asset: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    names.sort();
    for name in names {
        if is_private_asset_operation_name(&name) {
            reclaim_private_asset_operation_payload(directory, &name)?;
            continue;
        }
        let (expected_hash, _) = parse_asset_name(&name)
            .ok_or_else(|| format!("Notes asset deletion found an unowned entry {name:?}."))?;
        let held = hold_verified_owned_asset(directory, &name, &expected_hash)?;
        logical_retire_noreplace(
            directory,
            &name,
            held,
            Some(&expected_hash),
            None,
            &mut || Ok(()),
        )?;
    }
    sync_directory(directory)
}

fn held_file_content_hash(held: &HeldBoundedCapabilityFile) -> Result<String, String> {
    let mut reader = held
        .reader_from_start()
        .map_err(|error| format!("Could not read held Notes asset bytes: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; COPY_CHUNK_BYTES];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("Could not hash held Notes asset bytes: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn retirement_attestation(
    held: &HeldBoundedCapabilityFile,
    state: AssetOperationState,
) -> Result<AssetOperationAttestation, String> {
    let (device, inode) = held.identity();
    Ok(AssetOperationAttestation {
        version: PRIVATE_ASSET_OPERATION_VERSION,
        kind: AssetOperationKind::Retirement,
        state,
        device,
        inode,
        byte_size: Some(held.byte_size()),
        content_hash: Some(held_file_content_hash(held)?),
    })
}

fn write_operation_attestation(
    operation_directory: &Dir,
    attestation: &AssetOperationAttestation,
) -> Result<(), String> {
    write_operation_attestation_at(
        operation_directory,
        Path::new(PRIVATE_ASSET_OPERATION_TEMP),
        Path::new(PRIVATE_ASSET_OPERATION_ATTESTATION),
        attestation,
    )
}

fn write_operation_completion(
    operation_directory: &Dir,
    attestation: &AssetOperationAttestation,
) -> Result<(), String> {
    write_operation_attestation_at(
        operation_directory,
        Path::new(PRIVATE_ASSET_OPERATION_COMPLETION_TEMP),
        Path::new(PRIVATE_ASSET_OPERATION_COMPLETION),
        attestation,
    )
}

fn write_operation_attestation_at(
    operation_directory: &Dir,
    temporary_name: &Path,
    final_name: &Path,
    attestation: &AssetOperationAttestation,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(attestation)
        .map_err(|error| format!("Could not encode Notes asset operation: {error}"))?;
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let mut file = operation_directory
        .open_with(temporary_name, &options)
        .map_err(|error| format!("Could not create Notes asset operation: {error}"))?;
    let identity = file
        .metadata()
        .and_then(|metadata| capability_file_identity(&metadata))
        .map_err(|error| format!("Could not identify Notes asset operation: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not persist Notes asset operation: {error}"))?;
    maybe_inject_operation_attestation_publish_failure()?;
    drop(file);
    rename_noreplace(
        operation_directory,
        temporary_name,
        operation_directory,
        final_name,
    )
    .map_err(|error| format!("Could not publish Notes asset operation: {error}"))?;
    let published = operation_directory
        .symlink_metadata(final_name)
        .map_err(|error| format!("Could not verify Notes asset operation: {error}"))?;
    if !published.is_file()
        || !has_single_link(&published)?
        || capability_file_identity(&published)
            .map_err(|error| format!("Could not identify Notes asset operation: {error}"))?
            != identity
    {
        return Err("The published Notes asset operation identity changed.".to_string());
    }
    sync_directory(operation_directory)
}

fn read_operation_attestation(
    operation_directory: &Dir,
) -> Result<(AssetOperationAttestation, HeldBoundedCapabilityFile), String> {
    read_operation_attestation_at(
        operation_directory,
        Path::new(PRIVATE_ASSET_OPERATION_ATTESTATION),
    )
}

fn read_operation_completion(
    operation_directory: &Dir,
) -> Result<(AssetOperationAttestation, HeldBoundedCapabilityFile), String> {
    read_operation_attestation_at(
        operation_directory,
        Path::new(PRIVATE_ASSET_OPERATION_COMPLETION),
    )
}

fn read_operation_attestation_at(
    operation_directory: &Dir,
    name: &Path,
) -> Result<(AssetOperationAttestation, HeldBoundedCapabilityFile), String> {
    const MAX_ATTESTATION_BYTES: u64 = 4096;
    let held = hold_capability_regular_file_bounded_nofollow(
        operation_directory,
        name,
        MAX_ATTESTATION_BYTES,
    )
    .map_err(|error| format!("Could not securely open Notes asset operation: {error}"))?;
    let metadata = held
        .metadata()
        .map_err(|error| format!("Could not inspect Notes asset operation: {error}"))?;
    if !has_single_link(&metadata)? {
        return Err("A Notes asset operation attestation must be an owned file.".to_string());
    }
    let mut bytes = Vec::with_capacity(usize::try_from(held.byte_size()).unwrap_or(0));
    held.reader_from_start()
        .map_err(|error| format!("Could not read Notes asset operation: {error}"))?
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read Notes asset operation: {error}"))?;
    held.verify_at(operation_directory, name)
        .map_err(|error| format!("Notes asset operation changed: {error}"))?;
    let attestation: AssetOperationAttestation = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Could not decode Notes asset operation: {error}"))?;
    if attestation.version != PRIVATE_ASSET_OPERATION_VERSION {
        return Err("The Notes asset operation version is unsupported.".to_string());
    }
    Ok((attestation, held))
}

struct StagedAssetOperation {
    directory: Dir,
    directory_name: PathBuf,
    directory_identity: (u64, u64),
    payload_name: PathBuf,
    payload: cap_std::fs::File,
    payload_identity: (u64, u64),
}

fn create_staged_asset_operation(
    parent: &Dir,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<StagedAssetOperation, String> {
    let (directory, directory_name, directory_identity) =
        create_private_directory(parent, STAGING_DIRECTORY_PREFIX, validate_directories)?;
    let intent = AssetOperationAttestation {
        version: PRIVATE_ASSET_OPERATION_VERSION,
        kind: AssetOperationKind::Staging,
        state: AssetOperationState::Intent,
        device: directory_identity.0,
        inode: directory_identity.1,
        byte_size: None,
        content_hash: None,
    };
    if let Err(error) = write_operation_attestation(&directory, &intent) {
        return Err(error);
    }
    let payload_name = PathBuf::from(PRIVATE_ASSET_PAYLOAD);
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let payload = match directory.open_with(&payload_name, &options) {
        Ok(payload) => payload,
        Err(error) => return Err(format!("Could not create a staged Notes asset: {error}")),
    };
    maybe_inject_after_staging_payload_creation();
    let payload_metadata = match payload.metadata() {
        Ok(metadata) => metadata,
        Err(error) => {
            drop(payload);
            return Err(format!("Could not identify a staged Notes asset: {error}"));
        }
    };
    let payload_identity = if payload_metadata.is_file() && has_single_link(&payload_metadata)? {
        capability_file_identity(&payload_metadata)
            .map_err(|error| format!("Could not identify a staged Notes asset: {error}"))?
    } else {
        drop(payload);
        return Err(
            "Could not identify a staged Notes asset: staged payload must be an owned regular file"
                .to_string(),
        );
    };
    Ok(StagedAssetOperation {
        directory,
        directory_name,
        directory_identity,
        payload_name,
        payload,
        payload_identity,
    })
}

fn completed_staging_operation_is_attested(
    directory: &Dir,
    directory_identity: (u64, u64),
    entries: &[PathBuf],
) -> Result<bool, String> {
    let payload = Path::new(PRIVATE_ASSET_PAYLOAD);
    let intent_name = Path::new(PRIVATE_ASSET_OPERATION_ATTESTATION);
    let completion_name = Path::new(PRIVATE_ASSET_OPERATION_COMPLETION);
    if entries.len() < 2
        || entries.len() > 3
        || entries
            .iter()
            .any(|entry| entry != payload && entry != intent_name && entry != completion_name)
        || !entries.iter().any(|entry| entry == intent_name)
        || !entries.iter().any(|entry| entry == completion_name)
    {
        return Ok(false);
    }
    let (intent, held_intent) = match read_operation_attestation(directory) {
        Ok(operation) => operation,
        Err(_) => return Ok(false),
    };
    let (completion, held_completion) = match read_operation_completion(directory) {
        Ok(operation) => operation,
        Err(_) => return Ok(false),
    };
    if intent.kind != AssetOperationKind::Staging
        || intent.state != AssetOperationState::Intent
        || (intent.device, intent.inode) != directory_identity
        || intent.byte_size.is_some()
        || intent.content_hash.is_some()
        || completion.kind != AssetOperationKind::Staging
        || completion.state != AssetOperationState::Complete
        || completion.byte_size.is_none()
        || completion.content_hash.is_none()
        || held_intent.verify_at(directory, intent_name).is_err()
        || held_completion
            .verify_at(directory, completion_name)
            .is_err()
    {
        return Ok(false);
    }
    if !entries.iter().any(|entry| entry == payload) {
        return Ok(true);
    }
    let held_payload = match hold_capability_regular_file_bounded_nofollow(
        directory,
        payload,
        MAX_ATTACHMENT_BYTES,
    ) {
        Ok(held) => held,
        Err(_) => return Ok(false),
    };
    let metadata = held_payload
        .metadata()
        .map_err(|error| format!("Could not inspect private Notes asset payload: {error}"))?;
    let observed_hash = held_file_content_hash(&held_payload)?;
    Ok(has_single_link(&metadata)?
        && held_payload.identity() == (completion.device, completion.inode)
        && completion.byte_size == Some(held_payload.byte_size())
        && completion.content_hash.as_deref() == Some(observed_hash.as_str())
        && held_payload.verify_at(directory, payload).is_ok())
}

fn reclaim_intent_only_staging_payload_if_attested(
    directory: &Dir,
    directory_identity: (u64, u64),
    entries: &[PathBuf],
) -> Result<bool, String> {
    let payload = Path::new(PRIVATE_ASSET_PAYLOAD);
    let intent_name = Path::new(PRIVATE_ASSET_OPERATION_ATTESTATION);
    let completion_temp = Path::new(PRIVATE_ASSET_OPERATION_COMPLETION_TEMP);
    if entries.len() < 2
        || entries.len() > 3
        || entries
            .iter()
            .any(|entry| entry != payload && entry != intent_name && entry != completion_temp)
        || !entries.iter().any(|entry| entry == payload)
        || !entries.iter().any(|entry| entry == intent_name)
    {
        return Ok(false);
    }
    let (intent, held_intent) = match read_operation_attestation(directory) {
        Ok(operation) => operation,
        Err(_) => return Ok(false),
    };
    if intent.kind != AssetOperationKind::Staging
        || intent.state != AssetOperationState::Intent
        || (intent.device, intent.inode) != directory_identity
        || intent.byte_size.is_some()
        || intent.content_hash.is_some()
        || held_intent.verify_at(directory, intent_name).is_err()
    {
        return Ok(false);
    }
    let payload = match hold_capability_regular_file_bounded_nofollow_writable(
        directory,
        payload,
        MAX_ATTACHMENT_BYTES,
    ) {
        Ok(payload) => payload,
        Err(_) => return Ok(false),
    };
    let metadata = payload
        .metadata()
        .map_err(|error| format!("Could not inspect private Notes asset payload: {error}"))?;
    if !has_single_link(&metadata)?
        || payload
            .verify_at(directory, Path::new(PRIVATE_ASSET_PAYLOAD))
            .is_err()
    {
        return Ok(false);
    }
    drop(held_intent);
    payload.truncate_and_sync().map_err(|error| {
        format!("Could not reclaim an intent-only Notes asset staging payload: {error}")
    })?;
    sync_directory(directory)?;
    Ok(true)
}

fn reclaim_completed_staging_payload(directory: &Dir) -> Result<(), String> {
    let payload = Path::new(PRIVATE_ASSET_PAYLOAD);
    let payload = match hold_capability_regular_file_bounded_nofollow_writable(
        directory,
        payload,
        MAX_ATTACHMENT_BYTES,
    ) {
        Ok(payload) => payload,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Could not open a completed Notes asset staging payload: {error}"
            ))
        }
    };
    let metadata = payload
        .metadata()
        .map_err(|error| format!("Could not inspect private Notes asset payload: {error}"))?;
    if !has_single_link(&metadata)?
        || payload
            .verify_at(directory, Path::new(PRIVATE_ASSET_PAYLOAD))
            .is_err()
    {
        return Err(
            "A completed Notes asset staging payload changed before reclamation.".to_string(),
        );
    }
    payload.truncate_and_sync().map_err(|error| {
        format!("Could not reclaim a completed Notes asset staging payload: {error}")
    })?;
    sync_directory(directory)
}

fn reclaim_verified_staging_payload(
    directory: &Dir,
    payload_name: &Path,
    expected_hash: &str,
) -> Result<(), String> {
    let payload = hold_capability_regular_file_bounded_nofollow_writable(
        directory,
        payload_name,
        MAX_ATTACHMENT_BYTES,
    )
    .map_err(|error| format!("Could not open a verified Notes asset staging payload: {error}"))?;
    let metadata = payload.metadata().map_err(|error| {
        format!("Could not inspect a verified Notes asset staging payload: {error}")
    })?;
    if !has_single_link(&metadata)?
        || held_file_content_hash(&payload)? != expected_hash
        || payload.verify_at(directory, payload_name).is_err()
    {
        return Err(
            "A verified Notes asset staging payload changed before reclamation.".to_string(),
        );
    }
    payload.truncate_and_sync().map_err(|error| {
        format!("Could not reclaim a verified Notes asset staging payload: {error}")
    })?;
    sync_directory(directory)
}

fn remove_reclaimed_staging_operation(
    parent: &Dir,
    directory: &Dir,
    directory_name: &Path,
    directory_identity: (u64, u64),
) -> Result<(), String> {
    revalidate_private_directory(parent, directory_name, directory_identity)?;
    let mut entries = directory
        .entries()
        .map_err(|error| format!("Could not inspect completed Notes asset staging: {error}"))?
        .map(|entry| {
            entry
                .map(|entry| PathBuf::from(entry.file_name()))
                .map_err(|error| {
                    format!("Could not inspect completed Notes asset staging: {error}")
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort();
    let payload_name = Path::new(PRIVATE_ASSET_PAYLOAD);
    let intent_name = Path::new(PRIVATE_ASSET_OPERATION_ATTESTATION);
    let completion_name = Path::new(PRIVATE_ASSET_OPERATION_COMPLETION);
    if entries.len() < 2
        || entries.len() > 3
        || entries
            .iter()
            .any(|entry| entry != payload_name && entry != intent_name && entry != completion_name)
        || !entries.iter().any(|entry| entry == intent_name)
        || !entries.iter().any(|entry| entry == completion_name)
    {
        return Err(
            "A completed Notes asset staging operation has unexpected entries.".to_string(),
        );
    }
    let (intent, held_intent) = read_operation_attestation(directory)?;
    let (completion, held_completion) = read_operation_completion(directory)?;
    if intent.kind != AssetOperationKind::Staging
        || intent.state != AssetOperationState::Intent
        || (intent.device, intent.inode) != directory_identity
        || intent.byte_size.is_some()
        || intent.content_hash.is_some()
        || completion.kind != AssetOperationKind::Staging
        || completion.state != AssetOperationState::Complete
        || completion.byte_size.is_none()
        || completion.content_hash.is_none()
        || held_intent.verify_at(directory, intent_name).is_err()
        || held_completion
            .verify_at(directory, completion_name)
            .is_err()
    {
        return Err(
            "A completed Notes asset staging operation changed before cleanup.".to_string(),
        );
    }
    if entries.iter().any(|entry| entry == payload_name) {
        let payload = hold_capability_regular_file_bounded_nofollow_writable(
            directory,
            payload_name,
            MAX_ATTACHMENT_BYTES,
        )
        .map_err(|error| {
            format!("Could not hold reclaimed Notes asset staging payload: {error}")
        })?;
        let payload_metadata = payload.metadata().map_err(|error| {
            format!("Could not inspect reclaimed Notes asset staging payload: {error}")
        })?;
        if !has_single_link(&payload_metadata)?
            || payload.byte_size() != 0
            || payload.verify_at(directory, payload_name).is_err()
        {
            return Err(
                "A reclaimed Notes asset staging payload changed before cleanup.".to_string(),
            );
        }
    }
    drop(held_intent);
    drop(held_completion);
    revalidate_private_directory(parent, directory_name, directory_identity)?;
    #[cfg(unix)]
    directory
        .try_clone()
        .map_err(|error| format!("Could not retain completed Notes asset staging: {error}"))?
        .remove_open_dir_all()
        .map_err(|error| {
            format!("Could not remove completed Notes asset staging {directory_name:?}: {error}")
        })?;
    #[cfg(not(unix))]
    {
        // cap-std's Windows implementation closes the held directory and recurses
        // by pathname. Keep the verified zero-byte tombstone instead.
        sync_directory(directory)?;
    }
    sync_directory(parent)
}

fn remove_reclaimed_retirement_operation(
    parent: &Dir,
    directory: &Dir,
    directory_name: &Path,
    directory_identity: (u64, u64),
) -> Result<(), String> {
    revalidate_private_directory(parent, directory_name, directory_identity)?;
    let mut entries = directory
        .entries()
        .map_err(|error| format!("Could not inspect completed Notes asset retirement: {error}"))?
        .map(|entry| {
            entry
                .map(|entry| PathBuf::from(entry.file_name()))
                .map_err(|error| {
                    format!("Could not inspect completed Notes asset retirement: {error}")
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort();
    let payload_name = Path::new(PRIVATE_ASSET_PAYLOAD);
    let intent_name = Path::new(PRIVATE_ASSET_OPERATION_ATTESTATION);
    let completion_name = Path::new(PRIVATE_ASSET_OPERATION_COMPLETION);
    if entries.len() != 3
        || entries
            .iter()
            .any(|entry| entry != payload_name && entry != intent_name && entry != completion_name)
    {
        return Err("A completed Notes asset retirement has unexpected entries.".to_string());
    }
    let (intent, held_intent) = read_operation_attestation(directory)?;
    let (completion, held_completion) = read_operation_completion(directory)?;
    if intent.kind != AssetOperationKind::Retirement
        || intent.state != AssetOperationState::Intent
        || completion.kind != AssetOperationKind::Retirement
        || completion.state != AssetOperationState::Complete
        || (intent.device, intent.inode) != (completion.device, completion.inode)
        || intent.byte_size != completion.byte_size
        || intent.content_hash != completion.content_hash
        || intent.byte_size.is_none()
        || intent.content_hash.is_none()
        || held_intent.verify_at(directory, intent_name).is_err()
        || held_completion
            .verify_at(directory, completion_name)
            .is_err()
    {
        return Err("A completed Notes asset retirement changed before cleanup.".to_string());
    }
    let payload = hold_capability_regular_file_bounded_nofollow_writable(
        directory,
        payload_name,
        MAX_ATTACHMENT_BYTES,
    )
    .map_err(|error| format!("Could not hold reclaimed Notes asset retirement payload: {error}"))?;
    let payload_metadata = payload.metadata().map_err(|error| {
        format!("Could not inspect reclaimed Notes asset retirement payload: {error}")
    })?;
    if !has_single_link(&payload_metadata)?
        || payload.byte_size() != 0
        || payload.verify_at(directory, payload_name).is_err()
    {
        return Err(
            "A reclaimed Notes asset retirement payload changed before cleanup.".to_string(),
        );
    }
    drop(held_intent);
    drop(held_completion);
    revalidate_private_directory(parent, directory_name, directory_identity)?;
    #[cfg(unix)]
    directory
        .try_clone()
        .map_err(|error| format!("Could not retain completed Notes asset retirement: {error}"))?
        .remove_open_dir_all()
        .map_err(|error| {
            format!("Could not remove completed Notes asset retirement {directory_name:?}: {error}")
        })?;
    #[cfg(not(unix))]
    {
        // cap-std's Windows implementation closes the held directory and recurses
        // by pathname. Keep the verified zero-byte tombstone instead.
        sync_directory(directory)?;
    }
    sync_directory(parent)
}

fn completed_retirement_operation_is_attested_and_reclaimed(
    directory: &Dir,
    entries: &[PathBuf],
) -> Result<bool, String> {
    let payload = Path::new(PRIVATE_ASSET_PAYLOAD);
    let intent_name = Path::new(PRIVATE_ASSET_OPERATION_ATTESTATION);
    let completion_name = Path::new(PRIVATE_ASSET_OPERATION_COMPLETION);
    if entries.len() != 3
        || entries
            .iter()
            .any(|entry| entry != payload && entry != intent_name && entry != completion_name)
    {
        return Ok(false);
    }
    let (intent, held_intent) = match read_operation_attestation(directory) {
        Ok(operation) => operation,
        Err(_) => return Ok(false),
    };
    let (completion, held_completion) = match read_operation_completion(directory) {
        Ok(operation) => operation,
        Err(_) => return Ok(false),
    };
    if intent.kind != AssetOperationKind::Retirement
        || intent.state != AssetOperationState::Intent
        || completion.kind != AssetOperationKind::Retirement
        || completion.state != AssetOperationState::Complete
        || (intent.device, intent.inode) != (completion.device, completion.inode)
        || intent.byte_size != completion.byte_size
        || intent.content_hash != completion.content_hash
        || intent.byte_size.is_none()
        || intent.content_hash.is_none()
        || held_intent.verify_at(directory, intent_name).is_err()
        || held_completion
            .verify_at(directory, completion_name)
            .is_err()
    {
        return Ok(false);
    }
    let held_payload = match hold_capability_regular_file_bounded_nofollow_writable(
        directory,
        payload,
        MAX_ATTACHMENT_BYTES,
    ) {
        Ok(held) => held,
        Err(_) => return Ok(false),
    };
    let metadata = held_payload
        .metadata()
        .map_err(|error| format!("Could not inspect private Notes asset payload: {error}"))?;
    if !has_single_link(&metadata)?
        || held_payload.identity() != (completion.device, completion.inode)
        || held_payload.verify_at(directory, payload).is_err()
    {
        return Ok(false);
    }
    if held_payload.byte_size() != 0 {
        let observed_hash = held_file_content_hash(&held_payload)?;
        if completion.byte_size != Some(held_payload.byte_size())
            || completion.content_hash.as_deref() != Some(observed_hash.as_str())
        {
            return Ok(false);
        }
        drop(held_intent);
        drop(held_completion);
        held_payload.truncate_and_sync().map_err(|error| {
            format!("Could not reclaim a completed Notes asset operation: {error}")
        })?;
        sync_directory(directory)?;
    }
    Ok(true)
}

fn cleanup_completed_private_operations_at_startup(
    parent: &Dir,
    remove_completed_directories: bool,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let mut names = parent
        .entries()
        .map_err(|error| format!("Could not inspect private Notes asset recovery: {error}"))?
        .map(|entry| {
            entry
                .map(|entry| PathBuf::from(entry.file_name()))
                .map_err(|error| format!("Could not inspect a private Notes asset entry: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    names.sort();
    for name in names
        .into_iter()
        .filter(|name| is_private_asset_operation_name(name))
    {
        let directory = match parent.open_dir_nofollow(&name) {
            Ok(directory) => directory,
            Err(_) => continue,
        };
        let metadata = match directory.dir_metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if validate_private_directory_security(&directory, &name, &metadata).is_err() {
            continue;
        }
        let identity = match capability_file_identity(&metadata) {
            Ok(identity) => identity,
            Err(_) => continue,
        };
        if revalidate_private_directory(parent, &name, identity).is_err() {
            continue;
        }
        let mut entries = directory
            .entries()
            .map_err(|error| format!("Could not inspect private Notes asset payload: {error}"))?
            .map(|entry| {
                entry
                    .map(|entry| PathBuf::from(entry.file_name()))
                    .map_err(|error| {
                        format!("Could not inspect private Notes asset payload: {error}")
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        entries.sort();
        let is_staging = name
            .to_str()
            .is_some_and(|value| value.starts_with(STAGING_DIRECTORY_PREFIX));
        let reclaimable = if is_staging {
            match completed_staging_operation_is_attested(&directory, identity, &entries) {
                Ok(true) => match reclaim_completed_staging_payload(&directory) {
                    Ok(()) => true,
                    Err(_) => false,
                },
                Ok(false) => {
                    let _ = reclaim_intent_only_staging_payload_if_attested(
                        &directory, identity, &entries,
                    );
                    false
                }
                Err(_) => false,
            }
        } else {
            completed_retirement_operation_is_attested_and_reclaimed(&directory, &entries)
                .unwrap_or(false)
        };
        if !reclaimable {
            continue;
        }
        validate_directories()?;
        revalidate_private_directory(parent, &name, identity)?;
        if !remove_completed_directories {
            continue;
        }
        #[cfg(unix)]
        directory.remove_open_dir_all().map_err(|error| {
            format!("Could not remove completed private Notes asset operation {name:?}: {error}")
        })?;
        #[cfg(not(unix))]
        {
            // cap-std's Windows implementation closes the held directory and
            // recurses by pathname. Leave the already-reclaimed tombstone in
            // place rather than reopen a replacement directory.
        }
        sync_directory(parent)?;
        validate_directories()?;
    }
    Ok(())
}

pub(crate) fn recover_completed_asset_operations_at_startup(
    storage: &AttachmentStorageLease,
) -> Result<(), String> {
    let (assets, trash) = storage.asset_gc_directories()?;
    storage.validate_asset_gc_directories(&assets, &trash)?;
    cleanup_completed_private_operations_at_startup(&assets, false, &mut || {
        storage.validate_asset_gc_directories(&assets, &trash)
    })?;
    cleanup_completed_private_operations_at_startup(&trash, true, &mut || {
        storage.validate_asset_gc_directories(&assets, &trash)
    })?;
    storage.validate_asset_gc_directories(&assets, &trash)
}

fn copy_held_asset_with_validation(
    from_parent: &Dir,
    from: &Path,
    held_source: HeldBoundedCapabilityFile,
    to_parent: &Dir,
    to: &Path,
    expected_hash: &str,
    retire_source: bool,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<HeldBoundedCapabilityFile, String> {
    validate_directories()?;
    let source_metadata = held_source
        .metadata()
        .map_err(|error| format!("Could not inspect Notes asset {from:?}: {error}"))?;
    if !has_single_link(&source_metadata)? {
        return Err(format!(
            "The Notes asset {from:?} must be an owned regular file."
        ));
    }
    let source_byte_size = held_source.byte_size();
    let mut source = held_source
        .reader_from_start()
        .map_err(|error| format!("Could not retain Notes asset {from:?}: {error}"))?;
    validate_directories()?;
    let StagedAssetOperation {
        directory: staging,
        directory_name: staging_directory_name,
        directory_identity: staging_identity,
        payload_name: staging_name,
        payload: mut destination,
        payload_identity: destination_identity,
    } = create_staged_asset_operation(to_parent, validate_directories)?;
    validate_directories()?;
    let copy_result = (|| {
        let mut buffer = vec![0_u8; COPY_CHUNK_BYTES];
        let mut copied = 0_u64;
        let mut copied_hash = Sha256::new();
        loop {
            let read = source
                .read(&mut buffer)
                .map_err(|error| format!("Could not read Notes asset {from:?}: {error}"))?;
            if read == 0 {
                break;
            }
            copied = copied
                .checked_add(
                    u64::try_from(read)
                        .map_err(|_| "The Notes asset copy byte count overflowed.".to_string())?,
                )
                .ok_or_else(|| "The Notes asset copy byte count overflowed.".to_string())?;
            if copied > source_byte_size {
                return Err(format!(
                    "The Notes asset {from:?} changed while it was copied."
                ));
            }
            copied_hash.update(&buffer[..read]);
            destination
                .write_all(&buffer[..read])
                .map_err(|error| format!("Could not copy Notes asset {to:?}: {error}"))?;
            maybe_inject_copy_abort_after_write();
        }
        if copied != source_byte_size
            || copied_hash
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
                != expected_hash
        {
            return Err(format!(
                "The Notes asset {from:?} does not match its content hash."
            ));
        }
        destination
            .sync_all()
            .map_err(|error| format!("Could not sync Notes asset {to:?}: {error}"))?;
        destination
            .seek(SeekFrom::Start(0))
            .map_err(|error| format!("Could not seek Notes asset {to:?}: {error}"))?;
        let mut destination_hash = Sha256::new();
        let mut destination_bytes = 0_u64;
        loop {
            let read = destination
                .read(&mut buffer)
                .map_err(|error| format!("Could not verify Notes asset {to:?}: {error}"))?;
            if read == 0 {
                break;
            }
            destination_bytes = destination_bytes
                .checked_add(u64::try_from(read).map_err(|_| {
                    "The Notes asset verification byte count overflowed.".to_string()
                })?)
                .ok_or_else(|| "The Notes asset verification byte count overflowed.".to_string())?;
            if destination_bytes > source_byte_size {
                return Err(format!(
                    "The copied Notes asset {to:?} exceeds its verified byte size."
                ));
            }
            destination_hash.update(&buffer[..read]);
        }
        if destination_bytes != source_byte_size
            || destination_hash
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
                != expected_hash
        {
            return Err(format!(
                "The copied Notes asset {to:?} does not match its content hash."
            ));
        }
        source = held_source
            .reader_from_start()
            .map_err(|error| format!("Could not re-open Notes asset {from:?}: {error}"))?;
        let mut source_hash = Sha256::new();
        let mut observed = 0_u64;
        loop {
            let read = source
                .read(&mut buffer)
                .map_err(|error| format!("Could not re-read Notes asset {from:?}: {error}"))?;
            if read == 0 {
                break;
            }
            observed = observed
                .checked_add(u64::try_from(read).map_err(|_| {
                    "The Notes asset verification byte count overflowed.".to_string()
                })?)
                .ok_or_else(|| "The Notes asset verification byte count overflowed.".to_string())?;
            source_hash.update(&buffer[..read]);
        }
        if observed != source_byte_size
            || source_hash
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
                != expected_hash
        {
            return Err(format!(
                "The Notes asset {from:?} changed while it was copied."
            ));
        }
        let source_link_metadata = held_source
            .metadata()
            .map_err(|error| format!("Could not re-inspect Notes asset {from:?}: {error}"))?;
        if !has_single_link(&source_link_metadata)? {
            return Err(format!(
                "The Notes asset {from:?} gained another link while it was copied."
            ));
        }
        held_source.verify_at(from_parent, from).map_err(|error| {
            format!("The Notes asset {from:?} changed while it was moved: {error}")
        })?;
        drop(source);
        let destination_path_metadata = staging
            .symlink_metadata(&staging_name)
            .map_err(|error| format!("Could not revalidate staged Notes asset {to:?}: {error}"))?;
        if !destination_path_metadata.is_file()
            || !has_single_link(&destination_path_metadata)?
            || destination_path_metadata.len() != source_byte_size
            || capability_file_identity(&destination_path_metadata)
                .map_err(|error| format!("Could not identify staged Notes asset {to:?}: {error}"))?
                != destination_identity
        {
            return Err(format!(
                "The staged Notes asset {to:?} changed while it was copied."
            ));
        }
        revalidate_private_directory(to_parent, &staging_directory_name, staging_identity)?;
        write_operation_completion(
            &staging,
            &AssetOperationAttestation {
                version: PRIVATE_ASSET_OPERATION_VERSION,
                kind: AssetOperationKind::Staging,
                state: AssetOperationState::Complete,
                device: destination_identity.0,
                inode: destination_identity.1,
                byte_size: Some(source_byte_size),
                content_hash: Some(expected_hash.to_string()),
            },
        )?;
        sync_directory(&staging)?;
        drop(destination);
        validate_directories()?;
        let staged_publication = hold_verified_owned_asset(&staging, &staging_name, expected_hash)?;
        if staged_publication.identity() != destination_identity {
            return Err(format!(
                "The staged Notes asset {to:?} changed identity before publication."
            ));
        }
        maybe_inject_before_staged_publication();
        let final_staged_hash = held_file_content_hash(&staged_publication)?;
        let final_staged_metadata = staged_publication.metadata().map_err(|error| {
            format!("Could not inspect staged Notes asset {to:?} before publication: {error}")
        })?;
        if final_staged_hash != expected_hash || !has_single_link(&final_staged_metadata)? {
            return Err(format!(
                "The staged Notes asset {to:?} changed before publication."
            ));
        }
        staged_publication
            .verify_at(&staging, &staging_name)
            .map_err(|error| {
                format!("The staged Notes asset {to:?} changed before publication: {error}")
            })?;
        let published_held = match rename_noreplace(&staging, &staging_name, to_parent, to) {
            Ok(()) => {
                validate_directories()?;
                let published_metadata = staged_publication.metadata().map_err(|error| {
                    format!("Could not inspect published Notes asset {to:?}: {error}")
                })?;
                if held_file_content_hash(&staged_publication)? != expected_hash
                    || !has_single_link(&published_metadata)?
                    || staged_publication.verify_at(to_parent, to).is_err()
                {
                    return Err(format!(
                        "The published Notes asset {to:?} changed during publication."
                    ));
                }
                staged_publication
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                let held =
                    hold_verified_owned_asset(to_parent, to, expected_hash).map_err(|_| {
                        format!(
                        "The existing published Notes asset {to:?} does not match its content hash."
                    )
                    })?;
                validate_directories()?;
                drop(staged_publication);
                reclaim_verified_staging_payload(&staging, &staging_name, expected_hash)?;
                held
            }
            Err(error) => {
                return Err(format!(
                    "Could not publish copied Notes asset {to:?} atomically: {error}"
                ))
            }
        };
        drop(staging);
        validate_directories()?;
        sync_directory(to_parent)?;
        maybe_inject_before_copy_source_retirement();
        if held_file_content_hash(&published_held)? != expected_hash {
            return Err(format!(
                "The published Notes asset {to:?} changed contents before source retirement."
            ));
        }
        maybe_inject_after_copy_destination_hash();
        verify_owned_asset_evidence(to_parent, to, &published_held, expected_hash).map_err(
            |error| {
                format!(
                    "The published Notes asset {to:?} changed before source retirement: {error}"
                )
            },
        )?;
        if retire_source {
            remove_held_owned_file_with_validation(
                from_parent,
                from,
                held_source,
                Some(expected_hash),
                validate_directories,
            )?;
        }
        Ok(published_held)
    })();
    match copy_result {
        Ok(published) => Ok(published),
        Err(error) => Err(error),
    }
}

fn copy_owned_asset_with_validation(
    from_parent: &Dir,
    from: &Path,
    to_parent: &Dir,
    to: &Path,
    expected_hash: &str,
    retire_source: bool,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<HeldBoundedCapabilityFile, String> {
    validate_directories()?;
    let held_source =
        hold_capability_regular_file_bounded_nofollow(from_parent, from, MAX_ATTACHMENT_BYTES)
            .map_err(|error| format!("Could not securely open Notes asset {from:?}: {error}"))?;
    copy_held_asset_with_validation(
        from_parent,
        from,
        held_source,
        to_parent,
        to,
        expected_hash,
        retire_source,
        validate_directories,
    )
}

fn copy_owned_asset(
    from_parent: &Dir,
    from: &Path,
    to_parent: &Dir,
    to: &Path,
    expected_hash: &str,
    retire_source: bool,
) -> Result<(), String> {
    copy_owned_asset_with_validation(
        from_parent,
        from,
        to_parent,
        to,
        expected_hash,
        retire_source,
        &mut || Ok(()),
    )?;
    Ok(())
}

fn rollback_exact_published_asset(
    directory: &Dir,
    target: &Path,
    expected_identity: (u64, u64),
    expected_hash: &str,
    staging: &Dir,
    payload: &Path,
) -> Result<(), String> {
    let held =
        hold_capability_regular_file_bounded_nofollow(directory, target, MAX_ATTACHMENT_BYTES)
            .map_err(|error| {
                format!("Could not hold the published Notes asset for rollback: {error}")
            })?;
    if held.identity() != expected_identity {
        return Err(
            "The published Notes asset replacement was preserved because its identity changed."
                .to_string(),
        );
    }
    if held_file_content_hash(&held)? != expected_hash {
        return Err(
            "The published Notes asset was preserved because its contents changed.".to_string(),
        );
    }
    maybe_inject_before_exact_rollback_move();
    let published_metadata = held
        .metadata()
        .map_err(|error| format!("Could not inspect the published Notes asset: {error}"))?;
    if !has_single_link(&published_metadata)? {
        return Err("The published Notes asset gained another link before rollback.".to_string());
    }
    held.verify_at(directory, target).map_err(|error| {
        format!("The published Notes asset was preserved before rollback: {error}")
    })?;
    maybe_inject_after_exact_rollback_final_binding();
    verify_owned_asset_evidence(directory, target, &held, expected_hash).map_err(|error| {
        format!("The published Notes asset was preserved at the final rollback boundary: {error}")
    })?;
    rename_noreplace(directory, target, staging, payload)
        .map_err(|error| format!("Could not roll back the exact published Notes asset: {error}"))?;
    maybe_inject_after_exact_rollback_move();
    let moved_validation = (|| {
        if held_file_content_hash(&held)? != expected_hash {
            return Err("the rolled-back contents changed".to_string());
        }
        maybe_inject_after_exact_rollback_hash();
        verify_owned_asset_evidence(staging, payload, &held, expected_hash)
            .map_err(|error| format!("the rolled-back Notes asset changed: {error}"))
    })();
    if let Err(error) = moved_validation {
        let exact_entry_remains = held_file_content_hash(&held)
            .is_ok_and(|observed_hash| observed_hash == expected_hash)
            && held.verify_at(staging, payload).is_ok();
        let restoration = if exact_entry_remains {
            rename_noreplace(staging, payload, directory, target)
                .map(|()| "the exact moved entry was restored".to_string())
                .unwrap_or_else(|restore_error| {
                    format!("the moved entry was preserved because restore failed: {restore_error}")
                })
        } else {
            let replacement = hold_capability_regular_file_bounded_nofollow(
                staging,
                payload,
                MAX_ATTACHMENT_BYTES,
            )
            .map_err(|replacement_error| {
                format!(
                    "{error}; could not retain the moved replacement for restoration: {replacement_error}"
                )
            })?;
            let replacement_hash = held_file_content_hash(&replacement)?;
            let replacement_metadata = replacement.metadata().map_err(|metadata_error| {
                format!("Could not inspect the moved replacement: {metadata_error}")
            })?;
            if !has_single_link(&replacement_metadata)?
                || replacement.verify_at(staging, payload).is_err()
            {
                return Err(format!(
                    "{error}; the moved replacement changed and was preserved in private staging."
                ));
            }
            rename_noreplace(staging, payload, directory, target).map_err(|restore_error| {
                format!(
                    "{error}; the moved replacement was preserved because restoration failed: {restore_error}"
                )
            })?;
            if held_file_content_hash(&replacement)? != replacement_hash
                || replacement.verify_at(directory, target).is_err()
            {
                return Err(format!(
                    "{error}; the moved replacement changed during restoration and was preserved."
                ));
            }
            "the moved replacement was restored to the publication target".to_string()
        };
        return Err(format!("{error}; {restoration}."));
    }
    Ok(())
}

pub(crate) fn publish_owned_asset_with_writer(
    directory: &Dir,
    target: &Path,
    expected_hash: &str,
    expected_byte_size: u64,
    write_source: impl FnOnce(&mut cap_std::fs::File) -> Result<(), String>,
) -> Result<bool, String> {
    let mut validate = || Ok(());
    let StagedAssetOperation {
        directory: staging,
        directory_name: staging_name,
        directory_identity: staging_identity,
        payload_name: payload,
        payload: mut destination,
        payload_identity: destination_identity,
    } = create_staged_asset_operation(directory, &mut validate)?;

    let result = (|| {
        write_source(&mut destination)?;
        destination
            .flush()
            .and_then(|_| destination.sync_all())
            .map_err(|error| format!("Could not sync a staged Notes asset: {error}"))?;
        destination
            .seek(SeekFrom::Start(0))
            .map_err(|error| format!("Could not seek a staged Notes asset: {error}"))?;
        let mut hasher = Sha256::new();
        let mut observed = 0_u64;
        let mut buffer = vec![0_u8; COPY_CHUNK_BYTES];
        loop {
            let read = destination
                .read(&mut buffer)
                .map_err(|error| format!("Could not verify a staged Notes asset: {error}"))?;
            if read == 0 {
                break;
            }
            observed = observed
                .checked_add(u64::try_from(read).unwrap_or(u64::MAX))
                .ok_or_else(|| "The staged Notes asset byte count overflowed.".to_string())?;
            if observed > expected_byte_size {
                return Err("The staged Notes asset exceeds its expected size.".to_string());
            }
            hasher.update(&buffer[..read]);
        }
        let observed_hash = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if observed != expected_byte_size || observed_hash != expected_hash {
            return Err("The staged Notes asset does not match its expected contents.".to_string());
        }
        let current = staging
            .symlink_metadata(&payload)
            .map_err(|error| format!("Could not revalidate a staged Notes asset: {error}"))?;
        if !current.is_file()
            || !has_single_link(&current)?
            || current.len() != expected_byte_size
            || capability_file_identity(&current)
                .map_err(|error| format!("Could not identify a staged Notes asset: {error}"))?
                != destination_identity
        {
            return Err("The staged Notes asset identity changed.".to_string());
        }
        revalidate_private_directory(directory, &staging_name, staging_identity)?;
        write_operation_completion(
            &staging,
            &AssetOperationAttestation {
                version: PRIVATE_ASSET_OPERATION_VERSION,
                kind: AssetOperationKind::Staging,
                state: AssetOperationState::Complete,
                device: destination_identity.0,
                inode: destination_identity.1,
                byte_size: Some(expected_byte_size),
                content_hash: Some(expected_hash.to_string()),
            },
        )?;
        drop(destination);
        let staged_publication = hold_verified_owned_asset(&staging, &payload, expected_hash)?;
        if staged_publication.identity() != destination_identity {
            return Err("The staged Notes asset identity changed before publication.".to_string());
        }
        maybe_inject_before_staged_publication();
        let final_staged_hash = held_file_content_hash(&staged_publication)?;
        let final_staged_metadata = staged_publication.metadata().map_err(|error| {
            format!("Could not inspect the staged Notes asset before publication: {error}")
        })?;
        if final_staged_hash != expected_hash || !has_single_link(&final_staged_metadata)? {
            return Err("The staged Notes asset changed before publication.".to_string());
        }
        staged_publication
            .verify_at(&staging, &payload)
            .map_err(|error| {
                format!("The staged Notes asset changed before publication: {error}")
            })?;
        let published = match rename_noreplace(&staging, &payload, directory, target) {
            Ok(()) => {
                staged_publication
                    .verify_at(directory, target)
                    .map_err(|error| {
                        format!("The staged Notes asset changed during publication: {error}")
                    })?;
                drop(staged_publication);
                true
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                hold_verified_owned_asset(directory, target, expected_hash).map_err(|error| {
                    format!("An existing Notes attachment asset has unexpected contents: {error}")
                })?;
                drop(staged_publication);
                reclaim_verified_staging_payload(&staging, &payload, expected_hash)?;
                false
            }
            Err(error) => {
                return Err(format!(
                    "Could not publish the Notes attachment atomically: {error}"
                ))
            }
        };
        let published_file = match hold_verified_owned_asset(directory, target, expected_hash) {
            Ok(held) => held,
            Err(error) if published => {
                let restoration = rollback_exact_published_asset(
                    directory,
                    target,
                    destination_identity,
                    expected_hash,
                    &staging,
                    &payload,
                )
                .map(|()| "the exact publication was returned to private staging".to_string())
                .unwrap_or_else(|rollback_error| rollback_error);
                return Err(format!("{error} {restoration}."));
            }
            Err(error) => return Err(error),
        };
        if published && published_file.identity() != destination_identity {
            drop(published_file);
            let restoration = rollback_exact_published_asset(
                directory,
                target,
                destination_identity,
                expected_hash,
                &staging,
                &payload,
            )
            .map(|()| "the exact publication was returned to private staging".to_string())
            .unwrap_or_else(|rollback_error| rollback_error);
            return Err(format!(
                "The published Notes attachment identity changed; {restoration}."
            ));
        }
        maybe_inject_after_published_asset_hold();
        let published_validation = (held_file_content_hash(&published_file)? == expected_hash)
            .then_some(())
            .ok_or_else(|| "The published Notes attachment contents changed.".to_string());
        maybe_inject_after_published_asset_hash();
        let published_validation = published_validation.and_then(|()| {
            verify_owned_asset_evidence(directory, target, &published_file, expected_hash)
                .map_err(|error| format!("The published Notes attachment changed: {error}"))
        });
        if let Err(error) = published_validation {
            if published {
                let restoration = rollback_exact_published_asset(
                    directory,
                    target,
                    destination_identity,
                    expected_hash,
                    &staging,
                    &payload,
                )
                .map(|()| "the exact publication was returned to private staging".to_string())
                .unwrap_or_else(|rollback_error| rollback_error);
                return Err(format!("{error} {restoration}."));
            }
            return Err(error);
        }
        drop(published_file);
        drop(staging);
        sync_directory(directory)?;
        Ok(published)
    })();
    match result {
        Ok(published) => Ok(published),
        Err(error) => Err(error),
    }
}

fn copy_then_remove(
    from_parent: &Dir,
    from: &Path,
    to_parent: &Dir,
    to: &Path,
    expected_hash: &str,
) -> Result<(), String> {
    copy_owned_asset(from_parent, from, to_parent, to, expected_hash, true)
}

fn hold_verified_owned_asset(
    directory: &Dir,
    name: &Path,
    expected_hash: &str,
) -> Result<HeldBoundedCapabilityFile, String> {
    let held = hold_capability_regular_file_bounded_nofollow(directory, name, MAX_ATTACHMENT_BYTES)
        .map_err(|error| format!("Could not securely open Notes asset {name:?}: {error}"))?;
    let metadata = held
        .metadata()
        .map_err(|error| format!("Could not inspect Notes asset {name:?}: {error}"))?;
    if !has_single_link(&metadata)? {
        return Err(format!(
            "The Notes asset {name:?} must be an owned regular file."
        ));
    }
    if held_file_content_hash(&held)? != expected_hash {
        return Err(format!(
            "The Notes asset {name:?} does not match its content hash."
        ));
    }
    held.verify_at(directory, name)
        .map_err(|error| format!("The Notes asset {name:?} changed: {error}"))?;
    Ok(held)
}

pub(crate) fn verify_owned_asset_evidence(
    directory: &Dir,
    name: &Path,
    held: &HeldBoundedCapabilityFile,
    expected_hash: &str,
) -> Result<(), String> {
    if held_file_content_hash(held)? != expected_hash {
        return Err(format!(
            "The retained Notes asset {name:?} changed contents."
        ));
    }
    let retained_metadata = held
        .metadata()
        .map_err(|error| format!("Could not inspect retained Notes asset {name:?}: {error}"))?;
    if !has_single_link(&retained_metadata)? {
        return Err(format!(
            "The retained Notes asset {name:?} gained another link."
        ));
    }
    held.verify_at(directory, name)
        .map_err(|error| format!("The retained Notes asset {name:?} changed: {error}"))
}

pub(crate) fn reopen_and_verify_survivor(
    directory: &Dir,
    name: &Path,
    retained: &HeldBoundedCapabilityFile,
    expected_hash: &str,
) -> Result<(), String> {
    verify_owned_asset_evidence(directory, name, retained, expected_hash)?;
    let reopened = hold_verified_owned_asset(directory, name, expected_hash).map_err(|error| {
        format!(
            "Could not re-open retained Notes asset {name:?} after counterpart isolation: {error}"
        )
    })?;
    if reopened.identity() != retained.identity() {
        return Err(format!(
            "The retained Notes asset {name:?} identity changed after counterpart isolation."
        ));
    }
    verify_owned_asset_evidence(directory, name, &reopened, expected_hash)
}

fn move_noreplace_with_validation(
    from_parent: &Dir,
    from: &Path,
    to_parent: &Dir,
    to: &Path,
    expected_hash: &str,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<u64, String> {
    validate_directories()?;
    let held_source = hold_verified_owned_asset(from_parent, from, expected_hash)?;
    let verified_byte_size = held_source.byte_size();
    validate_directories()?;
    maybe_inject_before_same_filesystem_move();
    validate_directories()?;
    let final_source_hash = held_file_content_hash(&held_source)?;
    let final_source_metadata = held_source
        .metadata()
        .map_err(|error| format!("Could not re-inspect Notes asset {from:?}: {error}"))?;
    if final_source_hash != expected_hash || !has_single_link(&final_source_metadata)? {
        return Err(format!(
            "The Notes asset {from:?} changed at the final move boundary."
        ));
    }
    held_source.verify_at(from_parent, from).map_err(|error| {
        format!("The Notes asset {from:?} changed at the final move boundary: {error}")
    })?;
    match rename_noreplace(from_parent, from, to_parent, to) {
        Ok(()) => {
            validate_directories()?;
            let moved_validation = held_file_content_hash(&held_source).and_then(|observed_hash| {
                if observed_hash == expected_hash {
                    Ok(())
                } else {
                    Err("the moved contents changed".to_string())
                }
            });
            maybe_inject_after_moved_asset_hash();
            let mut moved_validation = moved_validation.and_then(|()| {
                verify_owned_asset_evidence(to_parent, to, &held_source, expected_hash)
            });
            maybe_inject_move_validation_failure(&mut moved_validation);
            if let Err(error) = moved_validation {
                let recovery_hash = held_file_content_hash(&held_source)?;
                maybe_inject_during_move_recovery_validation();
                let recovery_metadata = held_source.metadata().map_err(|metadata_error| {
                    format!("Could not inspect moved Notes asset {to:?}: {metadata_error}")
                })?;
                let exact_destination_remains = recovery_hash == expected_hash
                    && has_single_link(&recovery_metadata)?
                    && held_source.verify_at(to_parent, to).is_ok();
                let restoration = if exact_destination_remains {
                    maybe_inject_after_move_recovery_final_binding();
                    let final_hash = held_file_content_hash(&held_source)?;
                    let final_metadata = held_source.metadata().map_err(|metadata_error| {
                        format!(
                            "Could not finally inspect moved Notes asset {to:?}: {metadata_error}"
                        )
                    })?;
                    if final_hash != expected_hash
                        || !has_single_link(&final_metadata)?
                        || held_source.verify_at(to_parent, to).is_err()
                    {
                        "the replacement destination was preserved".to_string()
                    } else {
                        match rename_noreplace(to_parent, to, from_parent, from) {
                            Ok(()) => {
                                let restored_hash = held_file_content_hash(&held_source)?;
                                let restored_metadata = held_source.metadata().map_err(
                                    |metadata_error| {
                                        format!(
                                            "Could not inspect restored Notes asset {from:?}: {metadata_error}"
                                        )
                                    },
                                )?;
                                if restored_hash == expected_hash
                                    && has_single_link(&restored_metadata)?
                                    && held_source.verify_at(from_parent, from).is_ok()
                                {
                                    "the exact moved entry was restored".to_string()
                                } else {
                                    "the restored pathname changed and recovery evidence was preserved"
                                        .to_string()
                                }
                            }
                            Err(restore_error) => {
                                format!(
                                    "restore failed and the entry was preserved: {restore_error}"
                                )
                            }
                        }
                    }
                } else {
                    "the replacement destination was preserved".to_string()
                };
                return Err(format!(
                    "The moved Notes asset {to:?} changed identity: {error}; {restoration}."
                ));
            }
            sync_directory(from_parent)?;
            sync_directory(to_parent)?;
            Ok(verified_byte_size)
        }
        Err(error) if error.kind() == ErrorKind::CrossesDevices => {
            copy_held_asset_with_validation(
                from_parent,
                from,
                held_source,
                to_parent,
                to,
                expected_hash,
                true,
                validate_directories,
            )?;
            Ok(verified_byte_size)
        }
        Err(error) => Err(format!("Could not move Notes asset {from:?}: {error}")),
    }
}

pub(crate) fn retain_reconciliation_asset(
    connection: &Connection,
    assets: &Dir,
    quarantined_name: &Path,
    trash: &Dir,
    canonical_name: &Path,
    expected_hash: &str,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<Option<HeldBoundedCapabilityFile>, String> {
    validate_directories()?;
    let (parsed_hash, extension) = parse_asset_name(canonical_name)
        .ok_or_else(|| "A retained Notes asset must have a canonical file name.".to_string())?;
    if parsed_hash != expected_hash {
        return Err("A retained Notes asset file name did not match its content hash.".to_string());
    }
    let source_matches = owned_file_matches_hash(assets, quarantined_name, expected_hash)?;
    let retained = if path_exists(trash, canonical_name)? {
        Some(hold_verified_owned_asset(trash, canonical_name, expected_hash).map_err(|_| {
            format!(
                "The retained Notes asset {canonical_name:?} conflicts with bytes that do not match its content hash; both files were preserved."
            )
        })?)
    } else if !source_matches {
        None
    } else {
        validate_directories()?;
        let retained = copy_owned_asset_with_validation(
            assets,
            quarantined_name,
            trash,
            canonical_name,
            expected_hash,
            false,
            validate_directories,
        )?;
        validate_directories()?;
        Some(retained)
    };
    let Some(retained) = retained else {
        return Ok(None);
    };
    let verified_byte_size = retained.byte_size();
    let retention_days = AssetGcConfig::default().retention_days(verified_byte_size);
    let byte_size = i64::try_from(verified_byte_size)
        .map_err(|_| "The retained Notes asset byte size is too large.".to_string())?;
    validate_directories()?;
    verify_owned_asset_evidence(trash, canonical_name, &retained, expected_hash)?;
    connection
        .execute(
            "INSERT INTO asset_trash(content_hash, extension, byte_size, quarantined_at, delete_after) \
             VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('+%d days', ?4))) \
             ON CONFLICT(content_hash) DO NOTHING",
            params![expected_hash, extension, byte_size, retention_days],
        )
        .map_err(|error| format!("Could not retain a reconciled Notes asset: {error}"))?;
    validate_directories()?;
    Ok(Some(retained))
}

fn replay_asset_name(attachment: &NoteAttachment) -> Result<PathBuf, String> {
    let expected_extension = match attachment.mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => return Err("A replayed Notes attachment has an unsupported MIME type.".to_string()),
    };
    let expected_name = format!("{}.{}", attachment.content_hash, expected_extension);
    if attachment.relative_path != format!("notes-assets/{expected_name}")
        || parse_asset_name(Path::new(&expected_name))
            != Some((
                attachment.content_hash.clone(),
                expected_extension.to_string(),
            ))
    {
        return Err("A replayed Notes attachment has an unsafe owned path.".to_string());
    }
    Ok(PathBuf::from(expected_name))
}

pub(crate) fn validate_attachment_for_replay(
    storage: &AttachmentStorageLease,
    attachment: &NoteAttachment,
) -> Result<(), String> {
    let name = replay_asset_name(attachment)?;
    let (assets, trash) = storage.asset_gc_directories()?;
    storage.validate_asset_gc_directories(&assets, &trash)?;
    let live_exists = path_exists(&assets, &name)?;
    let trash_exists = path_exists(&trash, &name)?;
    if live_exists {
        if !owned_file_matches_hash(&assets, &name, &attachment.content_hash)? {
            return Err(format!(
                "The live Notes asset {name:?} did not match its content hash; replay preserved all copies."
            ));
        }
        if trash_exists {
            if !owned_file_matches_hash(&trash, &name, &attachment.content_hash)? {
                return Err(format!(
                    "The quarantined Notes asset {name:?} did not match its content hash; replay preserved all copies."
                ));
            }
        }
    } else if trash_exists {
        if !owned_file_matches_hash(&trash, &name, &attachment.content_hash)? {
            return Err(format!(
                "The quarantined Notes asset {name:?} did not match its content hash."
            ));
        }
    } else {
        return Err(format!(
            "The Notes attachment asset {name:?} is missing from live storage and trash."
        ));
    }
    storage.validate_asset_gc_directories(&assets, &trash)
}

pub(crate) struct ReplayAttachmentAssetStage {
    name: PathBuf,
    content_hash: String,
    created_live: bool,
    live: HeldBoundedCapabilityFile,
    trash: Option<HeldBoundedCapabilityFile>,
}

pub(crate) fn restore_attachment_for_replay(
    connection: &Connection,
    storage: &AttachmentStorageLease,
    attachment: &NoteAttachment,
) -> Result<ReplayAttachmentAssetStage, String> {
    let name = replay_asset_name(attachment)?;
    let (assets, trash) = storage.asset_gc_directories()?;
    storage.validate_asset_gc_directories(&assets, &trash)?;
    let live_exists = path_exists(&assets, &name)?;
    let trash_exists = path_exists(&trash, &name)?;
    let (created_live, live, held_trash) = if live_exists {
        let live = hold_verified_owned_asset(&assets, &name, &attachment.content_hash).map_err(
            |_| {
                format!(
                    "The live Notes asset {name:?} did not match its content hash; replay preserved all copies."
                )
            },
        )?;
        let held_trash = if trash_exists {
            Some(
                hold_verified_owned_asset(&trash, &name, &attachment.content_hash).map_err(
                    |_| {
                        format!(
                            "The quarantined Notes asset {name:?} did not match its content hash; replay preserved all copies."
                        )
                    },
                )?,
            )
        } else {
            None
        };
        (false, live, held_trash)
    } else if trash_exists {
        let held_trash = hold_verified_owned_asset(&trash, &name, &attachment.content_hash)
            .map_err(|_| {
                format!("The quarantined Notes asset {name:?} did not match its content hash.")
            })?;
        storage.validate_asset_gc_directories(&assets, &trash)?;
        let live = copy_held_asset_with_validation(
            &trash,
            &name,
            held_trash
                .try_clone_held()
                .map_err(|error| format!("Could not retain replay trash evidence: {error}"))?,
            &assets,
            &name,
            &attachment.content_hash,
            false,
            &mut || storage.validate_asset_gc_directories(&assets, &trash),
        )?;
        storage.validate_asset_gc_directories(&assets, &trash)?;
        (true, live, Some(held_trash))
    } else {
        return Err(format!(
            "The Notes attachment asset {name:?} is missing from live storage and trash."
        ));
    };
    storage.validate_asset_gc_directories(&assets, &trash)?;
    if let Err(error) = connection
        .execute(
            "DELETE FROM asset_trash WHERE content_hash = ?1",
            [&attachment.content_hash],
        )
        .map_err(|error| format!("Could not clear replayed Notes asset trash: {error}"))
    {
        if created_live {
            storage.validate_asset_gc_directories(&assets, &trash)?;
            remove_held_owned_file_with_validation(
                &assets,
                &name,
                live,
                Some(&attachment.content_hash),
                &mut || storage.validate_asset_gc_directories(&assets, &trash),
            )?;
            storage.validate_asset_gc_directories(&assets, &trash)?;
        }
        return Err(error);
    }
    storage.validate_asset_gc_directories(&assets, &trash)?;
    Ok(ReplayAttachmentAssetStage {
        name,
        content_hash: attachment.content_hash.clone(),
        created_live,
        live,
        trash: held_trash,
    })
}

pub(crate) fn rollback_attachment_for_replay(
    storage: &AttachmentStorageLease,
    stage: ReplayAttachmentAssetStage,
) -> Result<(), String> {
    if !stage.created_live {
        return Ok(());
    }
    let (assets, trash) = storage.asset_gc_directories()?;
    storage.validate_asset_gc_directories(&assets, &trash)?;
    remove_held_owned_file_with_validation(
        &assets,
        &stage.name,
        stage.live,
        Some(&stage.content_hash),
        &mut || storage.validate_asset_gc_directories(&assets, &trash),
    )?;
    storage.validate_asset_gc_directories(&assets, &trash)
}

pub(crate) fn finalize_attachment_for_replay(
    storage: &AttachmentStorageLease,
    stage: ReplayAttachmentAssetStage,
) -> Result<(), String> {
    let (assets, trash) = storage.asset_gc_directories()?;
    storage.validate_asset_gc_directories(&assets, &trash)?;
    let Some(held_trash) = stage.trash else {
        return Ok(());
    };
    verify_owned_asset_evidence(&assets, &stage.name, &stage.live, &stage.content_hash).map_err(
        |_| {
            format!(
                "The replayed Notes asset {:?} could not retire its trash backup; both copies were preserved.",
                stage.name
            )
        },
    )?;
    storage.validate_asset_gc_directories(&assets, &trash)?;
    drop(stage.live);
    logical_retire_noreplace(
        &trash,
        &stage.name,
        held_trash,
        Some(&stage.content_hash),
        Some(RetirementSurvivor::new(
            &assets,
            &stage.name,
            &stage.content_hash,
        )),
        &mut || storage.validate_asset_gc_directories(&assets, &trash),
    )?;
    storage.validate_asset_gc_directories(&assets, &trash)
}

#[cfg(test)]
fn remove_owned_file_with_validation(
    directory: &Dir,
    name: &Path,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    validate_directories()?;
    let held = hold_capability_regular_file_bounded_nofollow(directory, name, MAX_ATTACHMENT_BYTES)
        .map_err(|error| format!("Could not securely open Notes asset {name:?}: {error}"))?;
    let metadata = held
        .metadata()
        .map_err(|error| format!("Could not inspect Notes asset {name:?}: {error}"))?;
    if !has_single_link(&metadata)? {
        return Err(format!(
            "The Notes asset {name:?} must be an owned regular file."
        ));
    }
    remove_held_owned_file_with_validation(directory, name, held, None, validate_directories)
}

pub(crate) fn retire_held_owned_file(
    directory: &Dir,
    name: &Path,
    held: HeldBoundedCapabilityFile,
) -> Result<(), String> {
    let mut validate = || Ok(());
    logical_retire_noreplace(directory, name, held, None, None, &mut validate)
}

pub(crate) struct RetirementSurvivor<'a> {
    directory: &'a Dir,
    name: &'a Path,
    expected_content_hash: &'a str,
}

impl<'a> RetirementSurvivor<'a> {
    pub(crate) fn new(directory: &'a Dir, name: &'a Path, expected_content_hash: &'a str) -> Self {
        Self {
            directory,
            name,
            expected_content_hash,
        }
    }
}

fn remove_held_owned_file_with_validation(
    directory: &Dir,
    name: &Path,
    held: HeldBoundedCapabilityFile,
    expected_content_hash: Option<&str>,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    logical_retire_noreplace(
        directory,
        name,
        held,
        expected_content_hash,
        None,
        validate_directories,
    )
}

pub(crate) fn logical_retire_noreplace(
    directory: &Dir,
    name: &Path,
    held: HeldBoundedCapabilityFile,
    expected_content_hash: Option<&str>,
    survivor: Option<RetirementSurvivor<'_>>,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    held.verify_at(directory, name)
        .map_err(|error| format!("The Notes asset {name:?} changed before deletion: {error}"))?;
    let held_survivor = survivor
        .as_ref()
        .map(|survivor| {
            hold_verified_owned_asset(
                survivor.directory,
                survivor.name,
                survivor.expected_content_hash,
            )
            .map_err(|error| {
                format!(
                    "Could not retain Notes asset survivor {:?}: {error}",
                    survivor.name
                )
            })
        })
        .transpose()?;
    maybe_inject_before_owned_file_remove();
    validate_directories()?;
    let (retired, retired_directory_name, retired_identity) =
        create_private_directory(directory, RETIRED_DIRECTORY_PREFIX, validate_directories)?;
    validate_directories()?;
    let retired_name = PathBuf::from(PRIVATE_ASSET_PAYLOAD);
    let attestation = retirement_attestation(&held, AssetOperationState::Intent)?;
    let attestation_hash = attestation
        .content_hash
        .as_deref()
        .ok_or_else(|| "A retirement intent needs a content hash.".to_string())?
        .to_string();
    if expected_content_hash.is_some_and(|expected| expected != attestation_hash) {
        return Err(format!(
            "The Notes asset {name:?} changed after it was authorized for retirement."
        ));
    }
    write_operation_attestation(&retired, &attestation)?;
    validate_directories()?;
    let final_hash = held_file_content_hash(&held)?;
    maybe_inject_after_retirement_final_hash();
    let final_metadata = held
        .metadata()
        .map_err(|error| format!("Could not re-inspect Notes asset {name:?}: {error}"))?;
    if !has_single_link(&final_metadata)? || final_hash != attestation_hash {
        return Err(format!(
            "The Notes asset {name:?} changed at the final retirement boundary."
        ));
    }
    held.verify_at(directory, name).map_err(|error| {
        format!("The Notes asset {name:?} changed at the final retirement boundary: {error}")
    })?;
    rename_noreplace(directory, name, &retired, &retired_name)
        .map_err(|error| format!("Could not isolate Notes asset {name:?}: {error}"))?;
    validate_directories()?;
    let moved_validation: Result<(), String> = (|| {
        held.verify_at(&retired, &retired_name).map_err(|error| {
            format!("Could not revalidate isolated Notes asset {name:?}: {error}")
        })?;
        if held_file_content_hash(&held)? != attestation_hash {
            return Err(format!(
                "Could not revalidate isolated Notes asset {name:?}: its contents changed."
            ));
        }
        let isolated_metadata = held
            .metadata()
            .map_err(|error| format!("Could not inspect isolated Notes asset {name:?}: {error}"))?;
        if !has_single_link(&isolated_metadata)? {
            return Err(format!(
                "Could not revalidate isolated Notes asset {name:?}: it gained another link."
            ));
        }
        revalidate_private_directory(directory, &retired_directory_name, retired_identity)
            .map_err(|error| {
                format!("The Notes asset {name:?} changed during logical isolation: {error}")
            })?;
        Ok(())
    })();
    if let Err(error) = moved_validation {
        validate_directories()?;
        maybe_inject_before_isolated_restore();
        return match rename_noreplace(&retired, &retired_name, directory, name) {
            Ok(()) => {
                validate_directories()?;
                Err(format!("{error} The isolated entry was restored."))
            }
            Err(restore_error) => Err(format!(
                "{error} The unverified isolated entry was preserved because restore failed: {restore_error}."
            )),
        };
    }
    validate_directories()?;
    maybe_inject_retirement_authorization_failure()?;
    maybe_inject_isolated_delete_failure()?;
    maybe_inject_after_counterpart_isolation();
    if let (Some(survivor), Some(held_survivor)) = (survivor.as_ref(), held_survivor.as_ref()) {
        reopen_and_verify_survivor(
            survivor.directory,
            survivor.name,
            held_survivor,
            survivor.expected_content_hash,
        )
        .map_err(|error| format!("{error} The isolated counterpart was preserved for recovery."))?;
    }
    let completion = AssetOperationAttestation {
        state: AssetOperationState::Complete,
        ..attestation
    };
    write_operation_completion(&retired, &completion)?;
    sync_directory(&retired)?;
    drop(held);
    drop(held_survivor);
    maybe_inject_after_retired_handle_drop();
    validate_directories()?;
    revalidate_private_directory(directory, &retired_directory_name, retired_identity)?;
    let writable = hold_capability_regular_file_bounded_nofollow_writable(
        &retired,
        &retired_name,
        MAX_ATTACHMENT_BYTES,
    )
    .map_err(|error| {
        format!("Could not hold isolated Notes asset {name:?} for reclamation: {error}")
    })?;
    let writable_metadata = writable
        .metadata()
        .map_err(|error| format!("Could not inspect isolated Notes asset {name:?}: {error}"))?;
    if writable.identity() != (completion.device, completion.inode)
        || writable.byte_size() != completion.byte_size.unwrap_or(u64::MAX)
        || !has_single_link(&writable_metadata)?
        || held_file_content_hash(&writable)? != attestation_hash
        || writable.verify_at(&retired, &retired_name).is_err()
    {
        return Err(format!(
            "The isolated Notes asset {name:?} changed before exact reclamation; it was preserved."
        ));
    }
    writable
        .truncate_and_sync()
        .map_err(|error| format!("Could not reclaim isolated Notes asset {name:?}: {error}"))?;
    sync_directory(&retired)?;
    sync_directory(directory)?;
    validate_directories()
}

#[cfg(test)]
fn remove_owned_file(directory: &Dir, name: &Path) -> Result<(), String> {
    remove_owned_file_with_validation(directory, name, &mut || Ok(()))
}

fn trash_rows(connection: &Connection) -> Result<Vec<AssetFile>, String> {
    let mut statement = connection
        .prepare("SELECT content_hash, extension, byte_size FROM asset_trash ORDER BY content_hash")
        .map_err(|error| format!("Could not prepare Notes asset trash: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let content_hash: String = row.get(0)?;
            let extension: String = row.get(1)?;
            let byte_size =
                u64::try_from(row.get::<_, i64>(2)?).map_err(|_| rusqlite::Error::InvalidQuery)?;
            let name = PathBuf::from(format!("{content_hash}.{extension}"));
            if parse_asset_name(&name).as_ref() != Some(&(content_hash.clone(), extension.clone()))
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Ok(AssetFile {
                name,
                content_hash,
                extension,
                byte_size,
            })
        })
        .map_err(|error| format!("Could not load Notes asset trash: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read Notes asset trash: {error}"))?;
    Ok(rows)
}

pub(crate) fn run_asset_gc(vault_path: &str, config: AssetGcConfig) -> Result<(), String> {
    let config = config.validate()?;
    let storage = AttachmentStorageLease::acquire(vault_path)?;
    let (assets, trash) = storage.asset_gc_directories()?;
    let shared = acquire_notes_connection(vault_path)?;
    let connection = lock_notes_connection(&shared)?;
    let now: String = connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("Could not read the Notes asset GC clock: {error}"))?;
    let mut validate_directories = || storage.validate_asset_gc_directories(&assets, &trash);
    run_asset_gc_in_with_validation(
        &connection,
        &assets,
        &trash,
        config,
        &now,
        Some(SystemTime::now()),
        &mut validate_directories,
    )
}

fn run_asset_gc_in(
    connection: &Connection,
    assets: &Dir,
    trash: &Dir,
    config: AssetGcConfig,
    now: &str,
) -> Result<(), String> {
    run_asset_gc_in_with_validation(connection, assets, trash, config, now, None, &mut || Ok(()))
}

/// `min_age_now`: when `Some(clock)`, an unreferenced live asset is only
/// quarantined once its file is older than [`MIN_UNREFERENCED_QUARANTINE_AGE`]
/// relative to `clock` (C1). `None` disables the age gate — used by unit
/// fixtures that assert immediate quarantine.
fn run_asset_gc_in_with_validation(
    connection: &Connection,
    assets: &Dir,
    trash: &Dir,
    config: AssetGcConfig,
    now: &str,
    min_age_now: Option<SystemTime>,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    validate_directories()?;
    // C1: if any topic is quarantined its attachment rows are not inserted yet,
    // so the live→trash quarantine phase would sweep assets it still references.
    let skip_quarantine = any_topic_quarantined(connection)?;
    // C2: non-regular entries (symlink/hardlink) are skipped and their reasons
    // collected so one bad file cannot wedge quarantine/restore/expiry for the
    // rest; the joined summary is returned so the status event surfaces it.
    // ponytail: content-hash mismatch and directory/handle rebind stay fatal —
    // those are data-integrity/tamper failures existing tests require to abort.
    let mut skipped_entries: Vec<String> = Vec::new();
    for record in trash_rows(connection)? {
        validate_directories()?;
        let retention_days = config.retention_days(record.byte_size);
        validate_directories()?;
        connection
            .execute(
                "UPDATE asset_trash SET delete_after = \
                   strftime('%Y-%m-%dT%H:%M:%fZ', quarantined_at, printf('+%d days', ?2)) \
                 WHERE content_hash = ?1",
                params![record.content_hash, retention_days],
            )
            .map_err(|error| {
                format!("Could not update a quarantined Notes asset deadline: {error}")
            })?;
        validate_directories()?;
        if has_references(connection, &record.content_hash)? {
            let trash_exists = path_exists(trash, &record.name)?;
            let live_exists = path_exists(assets, &record.name)?;
            let held_trash = if trash_exists {
                Some(
                    hold_verified_owned_asset(trash, &record.name, &record.content_hash).map_err(
                        |_| {
                            format!(
                                "The quarantined Notes asset {:?} did not match its content hash; all copies were preserved.",
                                record.name
                            )
                        },
                    )?,
                )
            } else {
                None
            };
            let mut held_live = if live_exists {
                Some(
                    hold_verified_owned_asset(assets, &record.name, &record.content_hash).map_err(
                        |_| {
                            format!(
                                "The live Notes asset {:?} did not match its content hash; its tracked trash row was preserved.",
                                record.name
                            )
                        },
                    )?,
                )
            } else {
                None
            };
            if held_live.is_none() && held_trash.is_none() {
                return Err(format!(
                    "The tracked Notes asset {:?} was missing from both live storage and trash.",
                    record.name
                ));
            }
            if held_live.is_none() {
                let source = held_trash
                    .as_ref()
                    .expect("held trash exists")
                    .try_clone_held()
                    .map_err(|error| format!("Could not retain tracked trash evidence: {error}"))?;
                validate_directories()?;
                let restored = copy_held_asset_with_validation(
                    trash,
                    &record.name,
                    source,
                    assets,
                    &record.name,
                    &record.content_hash,
                    false,
                    validate_directories,
                )?;
                held_live = Some(restored);
                validate_directories()?;
            }
            if let Some(held_trash) = held_trash {
                validate_directories()?;
                maybe_inject_before_last_copy_retirement();
                let held_live = held_live.take().expect("verified live destination exists");
                verify_owned_asset_evidence(
                    assets,
                    &record.name,
                    &held_live,
                    &record.content_hash,
                )?;
                drop(held_live);
                logical_retire_noreplace(
                    trash,
                    &record.name,
                    held_trash,
                    Some(&record.content_hash),
                    Some(RetirementSurvivor::new(
                        assets,
                        &record.name,
                        &record.content_hash,
                    )),
                    validate_directories,
                )?;
                validate_directories()?;
            }
            validate_directories()?;
            connection
                .execute(
                    "DELETE FROM asset_trash WHERE content_hash = ?1",
                    [&record.content_hash],
                )
                .map_err(|error| format!("Could not clear restored Notes asset trash: {error}"))?;
            validate_directories()?;
        }
    }

    if !skip_quarantine {
        validate_directories()?;
        let (live_assets, mut list_errors) = list_assets(assets)?;
        skipped_entries.append(&mut list_errors);
        for asset in live_assets {
        validate_directories()?;
        if has_references(connection, &asset.content_hash)? {
            continue;
        }
        if let Some(clock) = min_age_now {
            let modified = assets
                .symlink_metadata(&asset.name)
                .and_then(|metadata| metadata.modified())
                .map_err(|error| {
                    format!("Could not read the Notes asset age {:?}: {error}", asset.name)
                })?
                .into_std();
            if clock
                .duration_since(modified)
                .map_or(true, |age| age < MIN_UNREFERENCED_QUARANTINE_AGE)
            {
                continue;
            }
        }
        maybe_inject_before_gc_file_mutation();
        validate_directories()?;
        let verified_byte_size = if path_exists(trash, &asset.name)? {
            let held_live = hold_verified_owned_asset(assets, &asset.name, &asset.content_hash)?;
            let held_trash = hold_verified_owned_asset(trash, &asset.name, &asset.content_hash)
                .map_err(|_| {
                    format!(
                        "The colliding zero-ref Notes asset {:?} did not match its content hash; both files were preserved.",
                        asset.name
                    )
                })?;
            let verified_byte_size = held_live.byte_size();
            validate_directories()?;
            maybe_inject_before_last_copy_retirement();
            verify_owned_asset_evidence(trash, &asset.name, &held_trash, &asset.content_hash)?;
            drop(held_trash);
            logical_retire_noreplace(
                assets,
                &asset.name,
                held_live,
                Some(&asset.content_hash),
                Some(RetirementSurvivor::new(
                    trash,
                    &asset.name,
                    &asset.content_hash,
                )),
                validate_directories,
            )?;
            verified_byte_size
        } else {
            validate_directories()?;
            move_noreplace_with_validation(
                assets,
                &asset.name,
                trash,
                &asset.name,
                &asset.content_hash,
                validate_directories,
            )?
        };
        maybe_inject_after_gc_file_mutation();
        validate_directories()?;
        let retention_days = config.retention_days(verified_byte_size);
        let byte_size = i64::try_from(verified_byte_size)
            .map_err(|_| "The Notes asset byte size is too large.".to_string())?;
        validate_directories()?;
        connection
            .execute(
                "INSERT INTO asset_trash(content_hash, extension, byte_size, quarantined_at, delete_after) \
                 VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', ?4, printf('+%d days', ?5))) \
                 ON CONFLICT(content_hash) DO UPDATE SET extension=excluded.extension, \
                   byte_size=excluded.byte_size",
                params![asset.content_hash, asset.extension, byte_size, now, retention_days],
            )
            .map_err(|error| format!("Could not record quarantined Notes asset: {error}"))?;
        validate_directories()?;
        }
    }

    validate_directories()?;
    let (trash_assets, mut list_errors) = list_assets(trash)?;
    skipped_entries.append(&mut list_errors);
    for asset in trash_assets {
        validate_directories()?;
        let existing: Option<String> = connection
            .query_row(
                "SELECT content_hash FROM asset_trash WHERE content_hash = ?1",
                [&asset.content_hash],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Could not inspect Notes asset trash row: {error}"))?;
        if existing.is_none() {
            if has_references(connection, &asset.content_hash)? {
                let held_trash =
                    hold_verified_owned_asset(trash, &asset.name, &asset.content_hash).map_err(
                        |_| {
                            format!(
                                "The quarantined Notes asset {:?} did not match its content hash; all copies were preserved.",
                                asset.name
                            )
                        },
                    )?;
                let held_live = if path_exists(assets, &asset.name)? {
                    hold_verified_owned_asset(assets, &asset.name, &asset.content_hash).map_err(
                        |_| {
                            format!(
                                "The colliding Notes asset {:?} did not match its content hash; both files were preserved.",
                                asset.name
                            )
                        },
                    )?
                } else {
                    validate_directories()?;
                    let restored = copy_held_asset_with_validation(
                        trash,
                        &asset.name,
                        held_trash.try_clone_held().map_err(|error| {
                            format!("Could not retain untracked trash evidence: {error}")
                        })?,
                        assets,
                        &asset.name,
                        &asset.content_hash,
                        false,
                        validate_directories,
                    )?;
                    validate_directories()?;
                    restored
                };
                validate_directories()?;
                maybe_inject_before_last_copy_retirement();
                verify_owned_asset_evidence(assets, &asset.name, &held_live, &asset.content_hash)?;
                drop(held_live);
                logical_retire_noreplace(
                    trash,
                    &asset.name,
                    held_trash,
                    Some(&asset.content_hash),
                    Some(RetirementSurvivor::new(
                        assets,
                        &asset.name,
                        &asset.content_hash,
                    )),
                    validate_directories,
                )?;
                validate_directories()?;
                continue;
            }
            let retention_days = config.retention_days(asset.byte_size);
            let byte_size = i64::try_from(asset.byte_size)
                .map_err(|_| "The Notes asset byte size is too large.".to_string())?;
            validate_directories()?;
            connection
                .execute(
                    "INSERT INTO asset_trash(content_hash, extension, byte_size, quarantined_at, delete_after) \
                     VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', ?4, printf('+%d days', ?5)))",
                    params![asset.content_hash, asset.extension, byte_size, now, retention_days],
                )
                .map_err(|error| format!("Could not recover Notes asset trash row: {error}"))?;
            validate_directories()?;
        }
    }

    validate_directories()?;
    let mut expired = connection
        .prepare(
            "SELECT content_hash, extension FROM asset_trash WHERE delete_after <= ?1 \
             AND NOT EXISTS(SELECT 1 FROM notes_attachments \
               WHERE notes_attachments.content_hash = asset_trash.content_hash) \
             ORDER BY content_hash",
        )
        .map_err(|error| format!("Could not prepare expired Notes assets: {error}"))?
        .query_map([now], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Could not load expired Notes assets: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read expired Notes assets: {error}"))?;
    expired.sort();
    for (content_hash, extension) in expired {
        validate_directories()?;
        let name = PathBuf::from(format!("{content_hash}.{extension}"));
        if parse_asset_name(&name).as_ref() != Some(&(content_hash.clone(), extension.clone())) {
            return Err("The Notes asset trash row contains an unsafe file name.".to_string());
        }
        if path_exists(trash, &name)? {
            let held = hold_verified_owned_asset(trash, &name, &content_hash).map_err(|_| {
                format!(
                    "The expired Notes asset {name:?} did not match its content hash; it was preserved."
                )
            })?;
            validate_directories()?;
            remove_held_owned_file_with_validation(
                trash,
                &name,
                held,
                Some(&content_hash),
                validate_directories,
            )?;
            validate_directories()?;
        }
        maybe_inject_before_gc_row_delete();
        validate_directories()?;
        connection
            .execute(
                "DELETE FROM asset_trash WHERE content_hash = ?1",
                [&content_hash],
            )
            .map_err(|error| format!("Could not delete expired Notes asset trash row: {error}"))?;
        validate_directories()?;
    }
    if skipped_entries.is_empty() {
        Ok(())
    } else {
        Err(skipped_entries.join("; "))
    }
}

pub(crate) fn purge_unused_assets(
    vault_path: &str,
    preview_state: &AssetPurgePreviewState,
    confirm: bool,
) -> Result<PurgeReport, String> {
    let storage = AttachmentStorageLease::acquire(vault_path)?;
    let (assets, trash) = storage.asset_gc_directories()?;
    let shared = acquire_notes_connection(vault_path)?;
    let connection = lock_notes_connection(&shared)?;
    let vault_scope = crate::notes::repository::vault_key(vault_path);
    let mut validate_directories = || storage.validate_asset_gc_directories(&assets, &trash);
    purge_unused_assets_in_with_preview_and_validation(
        &connection,
        &assets,
        &trash,
        &vault_scope,
        preview_state,
        confirm,
        &mut validate_directories,
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_purge_unused_assets(
    vault_path: String,
    confirm: bool,
    preview_state: tauri::State<'_, AssetPurgePreviewState>,
) -> Result<PurgeReport, NotesError> {
    validate_vault_path(&vault_path).map_err(NotesError::from)?;
    let preview_state = preview_state.inner().clone();
    match tauri::async_runtime::spawn_blocking(move || {
        purge_unused_assets(&vault_path, &preview_state, confirm)
    })
    .await
    {
        Ok(result) => result.map_err(NotesError::from),
        Err(error) => Err(NotesError::new(
            NotesErrorCode::Internal,
            format!("Notes asset purge background task failed: {error}"),
        )),
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum AssetLocation {
    Live,
    Trash,
}

impl AssetLocation {
    fn directory<'a>(self, assets: &'a Dir, trash: &'a Dir) -> &'a Dir {
        match self {
            Self::Live => assets,
            Self::Trash => trash,
        }
    }

    fn digest_tag(self) -> u8 {
        match self {
            Self::Live => 0,
            Self::Trash => 1,
        }
    }
}

struct UnusedAssetPath {
    location: AssetLocation,
    name: PathBuf,
    identity: (u64, u64),
    byte_size: u64,
    observed_hash: String,
}

struct UnusedAsset {
    byte_size: u64,
    paths: Vec<UnusedAssetPath>,
}

type UnusedAssets = BTreeMap<String, UnusedAsset>;

fn collect_unused_assets(
    connection: &Connection,
    assets: &Dir,
    trash: &Dir,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<UnusedAssets, String> {
    let mut unused = UnusedAssets::new();
    for (location, directory) in [(AssetLocation::Live, assets), (AssetLocation::Trash, trash)] {
        validate_directories()?;
        // Skipped non-regular entries are not reported as unused (never purged).
        let (entries, _skipped) = list_assets(directory)?;
        for asset in entries {
            validate_directories()?;
            if !has_references(connection, &asset.content_hash)? {
                let held = hold_capability_regular_file_bounded_nofollow(
                    directory,
                    &asset.name,
                    MAX_ATTACHMENT_BYTES,
                )
                .map_err(|error| {
                    format!(
                        "Could not securely inspect unused Notes asset {:?}: {error}",
                        asset.name
                    )
                })?;
                let metadata = held.metadata().map_err(|error| {
                    format!(
                        "Could not inspect unused Notes asset {:?}: {error}",
                        asset.name
                    )
                })?;
                if !has_single_link(&metadata)? {
                    return Err(format!(
                        "The unused Notes asset {:?} must be an owned regular file.",
                        asset.name
                    ));
                }
                let observed_hash = held_file_content_hash(&held)?;
                held.verify_at(directory, &asset.name).map_err(|error| {
                    format!("The unused Notes asset {:?} changed: {error}", asset.name)
                })?;
                let byte_size = held.byte_size();
                let identity = held.identity();
                drop(held);
                let entry = unused.entry(asset.content_hash).or_insert(UnusedAsset {
                    byte_size,
                    paths: Vec::new(),
                });
                entry.byte_size = entry.byte_size.max(byte_size);
                entry.paths.push(UnusedAssetPath {
                    location,
                    name: asset.name,
                    identity,
                    byte_size,
                    observed_hash,
                });
                maybe_inject_after_unused_asset_evidence();
            }
        }
    }
    validate_directories()?;
    Ok(unused)
}

fn unused_assets_report(unused: &UnusedAssets) -> Result<PurgeReport, String> {
    let report = PurgeReport {
        count: u32::try_from(unused.len())
            .map_err(|_| "The Notes unused asset count is too large.".to_string())?,
        total_bytes: unused.values().try_fold(0_u64, |total, asset| {
            total
                .checked_add(asset.byte_size)
                .ok_or_else(|| "The Notes unused asset byte count is too large.".to_string())
        })?,
    };
    Ok(report)
}

fn unused_assets_membership_digest(unused: &UnusedAssets) -> String {
    let mut hasher = Sha256::new();
    for (content_hash, asset) in unused {
        hasher.update(content_hash.as_bytes());
        hasher.update(asset.byte_size.to_le_bytes());
        let mut paths = asset.paths.iter().collect::<Vec<_>>();
        paths
            .sort_by(|left, right| (left.location, &left.name).cmp(&(right.location, &right.name)));
        for path in paths {
            hasher.update([path.location.digest_tag()]);
            let name = path.name.as_os_str().to_string_lossy();
            hasher.update((name.len() as u64).to_le_bytes());
            hasher.update(name.as_bytes());
            hasher.update(path.identity.0.to_le_bytes());
            hasher.update(path.identity.1.to_le_bytes());
            hasher.update(path.byte_size.to_le_bytes());
            hasher.update(path.observed_hash.as_bytes());
        }
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn purge_unused_assets_in_with_preview_and_validation(
    connection: &Connection,
    assets: &Dir,
    trash: &Dir,
    vault_scope: &str,
    preview_state: &AssetPurgePreviewState,
    confirm: bool,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<PurgeReport, String> {
    validate_directories()?;
    let unused = collect_unused_assets(connection, assets, trash, validate_directories)?;
    let report = unused_assets_report(&unused)?;
    let digest = unused_assets_membership_digest(&unused);
    if !confirm {
        preview_state
            .0
            .lock()
            .map_err(|_| "Could not lock the Notes asset purge preview.".to_string())?
            .insert(vault_scope.to_string(), digest);
        return Ok(report);
    }
    let expected = preview_state
        .0
        .lock()
        .map_err(|_| "Could not lock the Notes asset purge preview.".to_string())?
        .remove(vault_scope)
        .ok_or_else(|| {
            "The Notes asset purge has no current preview; run a new dry-run before confirming."
                .to_string()
        })?;
    if expected != digest {
        return Err(
            "The Notes asset purge membership changed; run a new dry-run before confirming."
                .to_string(),
        );
    }
    validate_directories()?;
    for (content_hash, asset) in unused {
        for path in asset.paths {
            let UnusedAssetPath {
                location,
                name,
                identity,
                byte_size,
                observed_hash,
            } = path;
            validate_directories()?;
            let held = hold_capability_regular_file_bounded_nofollow(
                location.directory(assets, trash),
                &name,
                MAX_ATTACHMENT_BYTES,
            )
            .map_err(|error| format!("Could not reopen previewed Notes asset {name:?}: {error}"))?;
            if held.identity() != identity
                || held.byte_size() != byte_size
                || held_file_content_hash(&held)? != observed_hash
            {
                return Err(
                    "The Notes asset purge membership changed; run a new dry-run before confirming."
                        .to_string(),
                );
            }
            held.verify_at(location.directory(assets, trash), &name)
                .map_err(|_| {
                    "The Notes asset purge membership changed; run a new dry-run before confirming."
                        .to_string()
                })?;
            remove_held_owned_file_with_validation(
                location.directory(assets, trash),
                &name,
                held,
                Some(&observed_hash),
                validate_directories,
            )?;
            validate_directories()?;
        }
        validate_directories()?;
        connection
            .execute(
                "DELETE FROM asset_trash WHERE content_hash = ?1",
                [&content_hash],
            )
            .map_err(|error| format!("Could not clear purged Notes asset trash: {error}"))?;
        validate_directories()?;
    }
    validate_directories()?;
    connection
        .execute(
            "DELETE FROM asset_trash WHERE NOT EXISTS(SELECT 1 FROM notes_attachments \
             WHERE notes_attachments.content_hash = asset_trash.content_hash)",
            [],
        )
        .map_err(|error| format!("Could not clear stale Notes asset trash rows: {error}"))?;
    validate_directories()?;
    Ok(report)
}

fn purge_unused_assets_in_with_preview(
    connection: &Connection,
    assets: &Dir,
    trash: &Dir,
    vault_scope: &str,
    preview_state: &AssetPurgePreviewState,
    confirm: bool,
) -> Result<PurgeReport, String> {
    purge_unused_assets_in_with_preview_and_validation(
        connection,
        assets,
        trash,
        vault_scope,
        preview_state,
        confirm,
        &mut || Ok(()),
    )
}

#[cfg(test)]
mod tests {
    use super::{
        cleanup_completed_private_operations_at_startup, clear_after_unused_asset_evidence,
        copy_owned_asset, copy_then_remove, create_private_directory,
        inject_after_copy_destination_hash_once, inject_after_counterpart_isolation_once,
        inject_after_exact_rollback_final_binding_once, inject_after_exact_rollback_hash_once,
        inject_after_exact_rollback_move_once, inject_after_gc_file_mutation_once,
        inject_after_move_recovery_final_binding_once, inject_after_moved_asset_hash_once,
        inject_after_published_asset_hash_once, inject_after_published_asset_hold_once,
        inject_after_retired_handle_drop_once, inject_after_retirement_final_hash_once,
        inject_after_staging_payload_creation_once, inject_after_unused_asset_evidence,
        inject_before_copy_source_retirement_once, inject_before_exact_rollback_move_once,
        inject_before_gc_file_mutation_once, inject_before_gc_row_delete_once,
        inject_before_last_copy_retirement_once, inject_before_owned_file_open_once,
        inject_before_owned_file_read_once, inject_before_owned_file_remove_once,
        inject_before_same_filesystem_move_once, inject_before_staged_publication_once,
        inject_copy_abort_after_write_once, inject_during_move_recovery_validation_once,
        inject_isolated_delete_failure_once, inject_move_validation_failure_once,
        inject_operation_attestation_publish_failure_once,
        inject_retirement_authorization_failure_once, inject_sync_failure_after,
        move_noreplace_with_validation, owned_file_matches_hash, publish_owned_asset_with_writer,
        purge_unused_assets_in_with_preview, remove_owned_file, rollback_exact_published_asset,
        run_asset_gc_in, run_asset_gc_in_with_validation, AssetGcConfig, AssetPurgePreviewState,
        PurgeReport, PRIVATE_ASSET_OPERATION_ATTESTATION, PRIVATE_ASSET_OPERATION_COMPLETION,
        PRIVATE_ASSET_OPERATION_COMPLETION_TEMP, PRIVATE_ASSET_OPERATION_TEMP,
        PRIVATE_ASSET_PAYLOAD, RETIRED_DIRECTORY_PREFIX, STAGING_DIRECTORY_PREFIX,
    };
    use cap_std::ambient_authority;
    use cap_std::fs::Dir;
    use rusqlite::{params, Connection};
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::io::Write;
    use std::path::Path;

    fn fixture() -> (tempfile::TempDir, Dir, Dir, Connection) {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("assets")).unwrap();
        fs::create_dir(root.path().join("trash")).unwrap();
        let assets =
            Dir::open_ambient_dir(root.path().join("assets"), ambient_authority()).unwrap();
        let trash = Dir::open_ambient_dir(root.path().join("trash"), ambient_authority()).unwrap();
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE notes_attachments(content_hash TEXT NOT NULL); \
                 CREATE TABLE asset_trash(content_hash TEXT PRIMARY KEY, extension TEXT NOT NULL, \
                   byte_size INTEGER NOT NULL, quarantined_at TEXT NOT NULL, delete_after TEXT NOT NULL);",
            )
            .unwrap();
        (root, assets, trash, connection)
    }

    fn private_gc_entries(directory: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut entries = fs::read_dir(directory)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".asset-gc-")
            })
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        entries.sort();
        entries
    }

    #[test]
    fn gc_quarantines_by_derived_refcount_and_retention_tier() {
        let (root, assets, trash, connection) = fixture();
        let small_bytes = [1];
        let large_bytes = vec![2; 6 * 1024 * 1024];
        let small = Sha256::digest(small_bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let large = Sha256::digest(&large_bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        fs::write(
            root.path().join("assets").join(format!("{small}.png")),
            small_bytes,
        )
        .unwrap();
        fs::write(
            root.path().join("assets").join(format!("{large}.png")),
            large_bytes,
        )
        .unwrap();

        run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        )
        .unwrap();

        assert!(!root
            .path()
            .join("assets")
            .join(format!("{small}.png"))
            .exists());
        assert!(root
            .path()
            .join("trash")
            .join(format!("{small}.png"))
            .exists());
        let rows = connection
            .prepare("SELECT content_hash, delete_after FROM asset_trash ORDER BY content_hash")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                (small, "2026-07-28T00:00:00.000Z".to_string()),
                (large, "2026-07-23T00:00:00.000Z".to_string())
            ]
        );
    }

    fn hash_of(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    }

    fn backdate(path: &Path, seconds: u64) {
        fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(seconds))
            .unwrap();
    }

    fn trash_count(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn gc_defers_fresh_unreferenced_assets_until_minimum_age() {
        // C1: a freshly written unreferenced asset may be an ingest whose DB row
        // has not committed yet, so it is only quarantined once it ages out.
        let (root, assets, trash, connection) = fixture();
        let bytes = [7_u8, 7, 7];
        let name = format!("{}.png", hash_of(&bytes));
        let path = root.path().join("assets").join(&name);
        fs::write(&path, bytes).unwrap();

        run_asset_gc_in_with_validation(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
            Some(std::time::SystemTime::now()),
            &mut || Ok(()),
        )
        .unwrap();
        assert!(path.exists(), "a fresh unreferenced asset must be preserved");
        assert!(!root.path().join("trash").join(&name).exists());
        assert_eq!(trash_count(&connection), 0);

        backdate(&path, 25 * 60 * 60);
        run_asset_gc_in_with_validation(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
            Some(std::time::SystemTime::now()),
            &mut || Ok(()),
        )
        .unwrap();
        assert!(!path.exists(), "an aged unreferenced asset must be quarantined");
        assert!(root.path().join("trash").join(&name).exists());
        assert_eq!(trash_count(&connection), 1);
    }

    #[test]
    fn gc_skips_quarantine_when_a_topic_is_quarantined() {
        // C1: a quarantined topic's attachment rows are not inserted, so pause
        // the whole quarantine phase to protect its not-yet-inserted references.
        let (root, assets, trash, connection) = fixture();
        connection
            .execute_batch(
                "CREATE TABLE sync_topics(topic_id TEXT PRIMARY KEY, \
                   quarantined INTEGER NOT NULL DEFAULT 0); \
                 INSERT INTO sync_topics(topic_id, quarantined) VALUES ('t', 1);",
            )
            .unwrap();
        let bytes = [9_u8, 9];
        let name = format!("{}.png", hash_of(&bytes));
        let path = root.path().join("assets").join(&name);
        fs::write(&path, bytes).unwrap();
        // Age it past the minimum window so only the topic guard can protect it.
        backdate(&path, 48 * 60 * 60);

        run_asset_gc_in_with_validation(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
            Some(std::time::SystemTime::now()),
            &mut || Ok(()),
        )
        .unwrap();
        assert!(path.exists(), "a quarantined topic must pause quarantine");
        assert_eq!(trash_count(&connection), 0);

        connection
            .execute("UPDATE sync_topics SET quarantined = 0", [])
            .unwrap();
        run_asset_gc_in_with_validation(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
            Some(std::time::SystemTime::now()),
            &mut || Ok(()),
        )
        .unwrap();
        assert!(!path.exists());
        assert!(root.path().join("trash").join(&name).exists());
    }

    #[cfg(unix)]
    #[test]
    fn gc_continues_past_a_symlinked_asset_and_reports_it() {
        // C2: one bad (symlinked) entry is skipped and reported, but the rest of
        // the pass still quarantines the healthy asset.
        let (root, assets, trash, connection) = fixture();
        let good_bytes = [1_u8, 2, 3, 4];
        let good_name = format!("{}.png", hash_of(&good_bytes));
        fs::write(root.path().join("assets").join(&good_name), good_bytes).unwrap();
        let bad_name = format!("{}.png", "a".repeat(64));
        std::os::unix::fs::symlink(
            root.path().join("assets").join(&good_name),
            root.path().join("assets").join(&bad_name),
        )
        .unwrap();

        let error = run_asset_gc_in_with_validation(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
            None,
            &mut || Ok(()),
        )
        .expect_err("a symlinked asset must be reported");

        assert!(error.contains("owned regular file"), "{error}");
        assert!(!root.path().join("assets").join(&good_name).exists());
        assert!(root.path().join("trash").join(&good_name).exists());
        assert!(
            fs::symlink_metadata(root.path().join("assets").join(&bad_name)).is_ok(),
            "the symlink entry must be preserved"
        );
    }

    #[test]
    fn gc_recalculates_existing_deadlines_from_the_current_retention_settings() {
        let (_root, assets, trash, connection) = fixture();
        let content_hash = "8".repeat(64);
        connection
            .execute(
                "INSERT INTO asset_trash VALUES (?1, 'png', 1, '2026-07-20T00:00:00.000Z', '2026-07-27T00:00:00.000Z')",
                [&content_hash],
            )
            .unwrap();

        run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig {
                asset_trash_retention_days: 30,
                ..AssetGcConfig::default()
            },
            "2026-07-21T00:00:00.000Z",
        )
        .unwrap();

        assert_eq!(
            connection
                .query_row(
                    "SELECT delete_after FROM asset_trash WHERE content_hash = ?1",
                    [&content_hash],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "2026-08-19T00:00:00.000Z"
        );
    }

    #[test]
    fn gc_restores_rereferenced_assets_and_deletes_expired_assets() {
        let (root, assets, trash, connection) = fixture();
        let restored_bytes = [1_u8];
        let restored = Sha256::digest(restored_bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let expired_bytes = [2_u8];
        let expired = Sha256::digest(expired_bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        fs::write(
            root.path().join("trash").join(format!("{restored}.png")),
            restored_bytes,
        )
        .unwrap();
        fs::write(
            root.path().join("trash").join(format!("{expired}.png")),
            expired_bytes,
        )
        .unwrap();
        connection
            .execute(
                "INSERT INTO notes_attachments(content_hash) VALUES (?1)",
                [&restored],
            )
            .unwrap();
        for hash in [&restored, &expired] {
            connection
                .execute(
                    "INSERT INTO asset_trash VALUES (?1, 'png', 1, '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z')",
                    [hash],
                )
                .unwrap();
        }

        run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        )
        .unwrap();

        assert!(root
            .path()
            .join("assets")
            .join(format!("{restored}.png"))
            .exists());
        assert!(!root
            .path()
            .join("trash")
            .join(format!("{expired}.png"))
            .exists());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn gc_rereference_retirement_preserves_a_replacement_after_exact_verification() {
        let (root, assets, trash, connection) = fixture();
        let bytes = b"rereferenced verified bytes";
        let content_hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{content_hash}.png");
        let trash_path = root.path().join("trash").join(&name);
        let displaced = root.path().join("displaced-rereferenced-trash.png");
        fs::write(&trash_path, bytes).unwrap();
        connection
            .execute(
                "INSERT INTO notes_attachments(content_hash) VALUES (?1)",
                [&content_hash],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO asset_trash VALUES (?1, 'png', ?2, '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')",
                params![content_hash, i64::try_from(bytes.len()).unwrap()],
            )
            .unwrap();
        let trash_for_hook = trash_path.clone();
        let displaced_for_hook = displaced.clone();
        inject_before_owned_file_remove_once(move || {
            fs::rename(&trash_for_hook, &displaced_for_hook).unwrap();
            fs::write(&trash_for_hook, b"external trash replacement").unwrap();
        });

        let error = run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        )
        .expect_err("replacement trash pathname must fail exact retirement");

        assert!(
            error.contains("changed") || error.contains("revalidate"),
            "{error}"
        );
        assert_eq!(
            fs::read(&trash_path).unwrap(),
            b"external trash replacement"
        );
        assert_eq!(fs::read(&displaced).unwrap(), bytes);
        assert_eq!(
            fs::read(root.path().join("assets").join(&name)).unwrap(),
            bytes
        );
    }

    #[test]
    fn gc_expiry_retirement_preserves_a_replacement_after_exact_verification() {
        let (root, assets, trash, connection) = fixture();
        let bytes = b"expired verified bytes";
        let content_hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{content_hash}.png");
        let trash_path = root.path().join("trash").join(&name);
        let displaced = root.path().join("displaced-expired-trash.png");
        fs::write(&trash_path, bytes).unwrap();
        connection
            .execute(
                "INSERT INTO asset_trash VALUES (?1, 'png', ?2, '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z')",
                params![content_hash, i64::try_from(bytes.len()).unwrap()],
            )
            .unwrap();
        let trash_for_hook = trash_path.clone();
        let displaced_for_hook = displaced.clone();
        inject_before_owned_file_remove_once(move || {
            fs::rename(&trash_for_hook, &displaced_for_hook).unwrap();
            fs::write(&trash_for_hook, b"external expired replacement").unwrap();
        });

        let error = run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        )
        .expect_err("replacement expired pathname must fail exact retirement");

        assert!(
            error.contains("changed") || error.contains("revalidate"),
            "{error}"
        );
        assert_eq!(
            fs::read(&trash_path).unwrap(),
            b"external expired replacement"
        );
        assert_eq!(fs::read(&displaced).unwrap(), bytes);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn gc_rejects_corrupt_tracked_and_untracked_trash_before_restore() {
        for tracked in [true, false] {
            let (root, assets, trash, connection) = fixture();
            let content_hash = Sha256::digest(b"expected bytes")
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let name = format!("{content_hash}.png");
            fs::write(root.path().join("trash").join(&name), b"corrupt bytes").unwrap();
            connection
                .execute(
                    "INSERT INTO notes_attachments(content_hash) VALUES (?1)",
                    [&content_hash],
                )
                .unwrap();
            if tracked {
                connection
                    .execute(
                        "INSERT INTO asset_trash VALUES (?1, 'png', 13, '2026-07-20T00:00:00.000Z', '2026-07-27T00:00:00.000Z')",
                        [&content_hash],
                    )
                    .unwrap();
            }

            let error = run_asset_gc_in(
                &connection,
                &assets,
                &trash,
                AssetGcConfig::default(),
                "2026-07-21T00:00:00.000Z",
            )
            .expect_err("corrupt trash must not be promoted");

            assert!(error.contains("content hash"), "{error}");
            assert!(!root.path().join("assets").join(&name).exists());
            assert!(root.path().join("trash").join(&name).exists());
            assert_eq!(
                connection
                    .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                i64::from(tracked)
            );
        }
    }

    #[test]
    fn gc_preserves_a_tracked_row_when_only_corrupt_live_bytes_remain() {
        let (root, assets, trash, connection) = fixture();
        let content_hash = Sha256::digest(b"expected bytes")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{content_hash}.png");
        fs::write(root.path().join("assets").join(&name), b"corrupt bytes").unwrap();
        connection
            .execute(
                "INSERT INTO notes_attachments(content_hash) VALUES (?1)",
                [&content_hash],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO asset_trash VALUES (?1, 'png', 13, '2026-07-20T00:00:00.000Z', '2026-07-27T00:00:00.000Z')",
                [&content_hash],
            )
            .unwrap();

        let error = run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        )
        .expect_err("corrupt live fallback must not clear tracked trash metadata");

        assert!(error.contains("content hash"), "{error}");
        assert!(root.path().join("assets").join(&name).exists());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn gc_preserves_live_and_trash_collision_unless_both_match_the_content_hash() {
        let (root, assets, trash, connection) = fixture();
        let valid = [1_u8, 2, 3];
        let content_hash = Sha256::digest(valid)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{content_hash}.png");
        fs::write(root.path().join("assets").join(&name), b"corrupt").unwrap();
        fs::write(root.path().join("trash").join(&name), valid).unwrap();
        connection
            .execute(
                "INSERT INTO notes_attachments(content_hash) VALUES (?1)",
                [&content_hash],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO asset_trash VALUES (?1, 'png', 3, '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')",
                [&content_hash],
            )
            .unwrap();

        let error = run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        )
        .unwrap_err();

        assert!(error.contains("content hash"), "{error}");
        assert!(root.path().join("assets").join(&name).exists());
        assert!(root.path().join("trash").join(&name).exists());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn gc_collapses_verified_zero_ref_duplicates_without_extending_expired_retention() {
        let (root, assets, trash, connection) = fixture();
        let bytes = [1_u8, 2, 3];
        let content_hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{content_hash}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        fs::write(root.path().join("trash").join(&name), bytes).unwrap();
        connection
            .execute(
                "INSERT INTO asset_trash VALUES (?1, 'png', 3, '2026-07-01T00:00:00.000Z', '2026-07-08T00:00:00.000Z')",
                [&content_hash],
            )
            .unwrap();

        run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        )
        .unwrap();

        assert!(!root.path().join("assets").join(&name).exists());
        assert!(!root.path().join("trash").join(&name).exists());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn gc_restores_rereferenced_untracked_trash_in_the_same_pass() {
        let (root, assets, trash, connection) = fixture();
        let restored_bytes = [1_u8];
        let restored = Sha256::digest(restored_bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{restored}.png");
        fs::write(root.path().join("trash").join(&name), restored_bytes).unwrap();
        connection
            .execute(
                "INSERT INTO notes_attachments(content_hash) VALUES (?1)",
                [&restored],
            )
            .unwrap();

        run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        )
        .unwrap();

        assert!(root.path().join("assets").join(&name).exists());
        assert!(!root.path().join("trash").join(&name).exists());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn cross_device_copy_keeps_destination_after_source_retirement() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = [1_u8, 2, 3];
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        inject_sync_failure_after(8);

        let error = copy_then_remove(
            &assets,
            std::path::Path::new(&name),
            &trash,
            std::path::Path::new(&name),
            &expected,
        )
        .unwrap_err();

        assert!(error.contains("Injected Notes asset directory sync failure"));
        assert!(!root.path().join("assets").join(&name).exists());
        assert!(root.path().join("trash").join(&name).exists());
    }

    #[test]
    fn cross_device_copy_rejects_bytes_that_do_not_match_the_asset_hash() {
        let (root, assets, trash, _connection) = fixture();
        let expected = Sha256::digest(b"expected")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), b"changed").unwrap();

        let error = copy_then_remove(
            &assets,
            std::path::Path::new(&name),
            &trash,
            std::path::Path::new(&name),
            &expected,
        )
        .unwrap_err();

        assert!(error.contains("content hash"), "{error}");
        assert!(root.path().join("assets").join(&name).exists());
        assert!(!root.path().join("trash").join(&name).exists());
    }

    #[test]
    fn cross_device_copy_revalidates_published_bytes_before_source_retirement() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"verified source bytes";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        let source = root.path().join("assets").join(&name);
        let published = root.path().join("trash").join(&name);
        fs::write(&source, bytes).unwrap();
        let published_for_hook = published.clone();
        inject_before_copy_source_retirement_once(move || {
            fs::write(&published_for_hook, b"changed destination bytes").unwrap();
        });

        let error = copy_then_remove(
            &assets,
            Path::new(&name),
            &trash,
            Path::new(&name),
            &expected,
        )
        .expect_err("changed publication must stop source retirement");

        assert!(error.contains("changed contents"), "{error}");
        assert_eq!(fs::read(source).unwrap(), bytes);
        assert_eq!(fs::read(published).unwrap(), b"changed destination bytes");
    }

    #[test]
    fn published_asset_rollback_preserves_same_inode_content_mutation() {
        let (root, assets, _trash, _connection) = fixture();
        let bytes = b"published attachment";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        let canonical = root.path().join("assets").join(&name);
        let canonical_for_hook = canonical.clone();
        inject_after_published_asset_hold_once(move || {
            fs::write(&canonical_for_hook, b"same inode mutation!!").unwrap();
        });

        let error = publish_owned_asset_with_writer(
            &assets,
            Path::new(&name),
            &expected,
            u64::try_from(bytes.len()).unwrap(),
            |destination| {
                destination
                    .write_all(bytes)
                    .map_err(|error| error.to_string())
            },
        )
        .expect_err("mutated publication must fail closed");

        assert!(error.contains("contents changed"), "{error}");
        assert_eq!(fs::read(canonical).unwrap(), b"same inode mutation!!");
    }

    #[test]
    fn duplicate_publication_reclaims_the_verified_staging_payload() {
        let (root, assets, _trash, _connection) = fixture();
        let bytes = b"duplicate publication staging payload";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();

        let published = publish_owned_asset_with_writer(
            &assets,
            Path::new(&name),
            &expected,
            u64::try_from(bytes.len()).unwrap(),
            |destination| {
                destination
                    .write_all(bytes)
                    .map_err(|error| error.to_string())
            },
        )
        .expect("existing canonical asset is an idempotent publication");

        assert!(
            !published,
            "existing canonical bytes must win the deduplication race"
        );
        let operation = private_gc_entries(&root.path().join("assets"))
            .into_iter()
            .next()
            .expect("completed staging tombstone");
        assert_eq!(
            fs::metadata(operation.join(PRIVATE_ASSET_PAYLOAD))
                .expect("staging payload metadata")
                .len(),
            0,
            "an AlreadyExists deduplication must not retain a full staged payload"
        );
    }

    #[test]
    fn incomplete_operation_temp_is_preserved_without_wedging_publication() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"attestation crash asset";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        let (interrupted_directory, interrupted_name, _) =
            create_private_directory(&trash, STAGING_DIRECTORY_PREFIX, &mut || Ok(())).unwrap();
        drop(interrupted_directory);
        let interrupted = root.path().join("trash").join(interrupted_name);
        fs::write(
            interrupted.join(PRIVATE_ASSET_PAYLOAD),
            b"unverified interrupted payload",
        )
        .unwrap();
        assert!(!interrupted
            .join(PRIVATE_ASSET_OPERATION_ATTESTATION)
            .exists());
        let operation_temp = interrupted.join(PRIVATE_ASSET_OPERATION_TEMP);
        fs::write(&operation_temp, b"malformed interrupted marker").unwrap();

        copy_owned_asset(
            &assets,
            Path::new(&name),
            &trash,
            Path::new(&name),
            &expected,
            false,
        )
        .expect("malformed incomplete marker must not wedge later cleanup");

        assert!(operation_temp.exists());
        assert!(!interrupted
            .join(PRIVATE_ASSET_OPERATION_ATTESTATION)
            .exists());
        assert!(
            interrupted.exists(),
            "unexpected operation state must be preserved"
        );
        assert_eq!(
            fs::read(root.path().join("trash").join(&name)).unwrap(),
            bytes
        );
    }

    #[test]
    fn retry_preserves_an_intent_only_partial_payload_mutation() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"complete staged bytes";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        inject_copy_abort_after_write_once();
        let aborted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            copy_owned_asset(
                &assets,
                Path::new(&name),
                &trash,
                Path::new(&name),
                &expected,
                false,
            )
        }));
        assert!(aborted.is_err());
        let staging = private_gc_entries(&root.path().join("trash"))
            .into_iter()
            .next()
            .expect("interrupted staging");
        let payload = staging.join(PRIVATE_ASSET_PAYLOAD);
        let replacement = vec![b'x'; bytes.len()];
        fs::write(&payload, &replacement).unwrap();

        copy_owned_asset(
            &assets,
            Path::new(&name),
            &trash,
            Path::new(&name),
            &expected,
            false,
        )
        .expect("a new copy may publish without touching the incomplete operation");

        assert_eq!(fs::read(&payload).unwrap(), replacement);
        assert!(private_gc_entries(&root.path().join("trash")).len() >= 2);
        assert_eq!(
            fs::read(root.path().join("trash").join(&name)).unwrap(),
            bytes
        );
    }

    #[test]
    fn interrupted_copy_never_exposes_a_partial_canonical_asset() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"complete asset bytes";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        inject_copy_abort_after_write_once();

        let aborted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            copy_owned_asset(
                &assets,
                std::path::Path::new(&name),
                &trash,
                std::path::Path::new(&name),
                &expected,
                false,
            )
        }));

        assert!(aborted.is_err(), "the fault must interrupt the copy");
        assert!(root.path().join("assets").join(&name).exists());
        assert!(
            !root.path().join("trash").join(&name).exists(),
            "an interrupted copy must not expose its final name"
        );

        copy_owned_asset(
            &assets,
            std::path::Path::new(&name),
            &trash,
            std::path::Path::new(&name),
            &expected,
            false,
        )
        .expect("retry must leave the interrupted operation isolated and publish exact bytes");
        assert_eq!(
            fs::read(root.path().join("trash").join(&name)).unwrap(),
            bytes
        );
        assert!(private_gc_entries(&root.path().join("trash")).len() >= 2);
    }

    #[test]
    fn interrupted_intent_is_preserved_on_retry() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = vec![b'i'; super::COPY_CHUNK_BYTES + 4096];
        let expected = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), &bytes).unwrap();
        inject_copy_abort_after_write_once();

        let aborted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            copy_owned_asset(
                &assets,
                Path::new(&name),
                &trash,
                Path::new(&name),
                &expected,
                false,
            )
        }));
        assert!(aborted.is_err(), "copy interruption hook did not run");
        assert_eq!(private_gc_entries(&root.path().join("trash")).len(), 1);

        copy_owned_asset(
            &assets,
            Path::new(&name),
            &trash,
            Path::new(&name),
            &expected,
            false,
        )
        .expect("retry publishes independently of the interrupted intent");

        assert!(
            private_gc_entries(&root.path().join("trash")).len() >= 2,
            "incomplete intent and completed publication tombstone must remain isolated"
        );
        assert_eq!(
            fs::read(root.path().join("trash").join(name)).unwrap(),
            bytes
        );
    }

    #[cfg(unix)]
    #[test]
    fn publication_rejects_a_link_added_at_the_final_staged_boundary() {
        let (root, assets, _trash, _connection) = fixture();
        let bytes = b"final publication link boundary";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        let assets_root = root.path().join("assets");
        let alias = root.path().join("publication-hardlink-alias.png");
        let assets_for_hook = assets_root.clone();
        let alias_for_hook = alias.clone();
        inject_before_staged_publication_once(move || {
            let staging = private_gc_entries(&assets_for_hook)
                .into_iter()
                .next()
                .expect("publication staging");
            fs::hard_link(staging.join(PRIVATE_ASSET_PAYLOAD), &alias_for_hook).unwrap();
        });

        let result = publish_owned_asset_with_writer(
            &assets,
            Path::new(&name),
            &expected,
            u64::try_from(bytes.len()).unwrap(),
            |destination| {
                destination
                    .write_all(bytes)
                    .map_err(|error| error.to_string())
            },
        );

        assert!(result.is_err(), "publication accepted a late hardlink");
        assert!(!assets_root.join(&name).exists());
        assert_eq!(fs::read(alias).unwrap(), bytes);
    }

    #[test]
    fn private_asset_operations_never_trust_precreated_fixed_names() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"private operation asset";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        fs::write(root.path().join("assets/.asset-gc-retired"), b"external").unwrap();
        fs::write(root.path().join("trash/.asset-gc-staging"), b"external").unwrap();

        copy_owned_asset(
            &assets,
            std::path::Path::new(&name),
            &trash,
            std::path::Path::new(&name),
            &expected,
            false,
        )
        .expect("copy must use a newly created unpredictable private capability");
        remove_owned_file(&assets, std::path::Path::new(&name))
            .expect("delete must use a newly created unpredictable private capability");

        assert_eq!(
            fs::read(root.path().join("assets/.asset-gc-retired")).unwrap(),
            b"external"
        );
        assert_eq!(
            fs::read(root.path().join("trash/.asset-gc-staging")).unwrap(),
            b"external"
        );
    }

    #[test]
    fn runtime_gc_preserves_an_intent_only_retirement_after_reclamation_failure() {
        let (root, assets, trash, connection) = fixture();
        let bytes = b"retired recovery asset";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        inject_isolated_delete_failure_once();

        let error = remove_owned_file(&assets, std::path::Path::new(&name))
            .expect_err("fault must strand the logically retired bytes");
        assert!(error.contains("Injected isolated"), "{error}");
        assert!(!private_gc_entries(&root.path().join("assets")).is_empty());

        run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        )
        .expect("the next pass must ignore private intent-only entries");
        let operations = private_gc_entries(&root.path().join("assets"));
        assert_eq!(operations.len(), 1);
        assert_eq!(
            fs::read(operations[0].join(PRIVATE_ASSET_PAYLOAD)).unwrap(),
            bytes
        );
    }

    #[test]
    fn cross_device_copy_retry_retires_source_after_completed_publication() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"complete asset bytes";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        fs::write(root.path().join("trash").join(&name), bytes).unwrap();

        copy_then_remove(
            &assets,
            std::path::Path::new(&name),
            &trash,
            std::path::Path::new(&name),
            &expected,
        )
        .expect("a retry must accept the already published exact destination");

        assert!(!root.path().join("assets").join(&name).exists());
        assert_eq!(
            fs::read(root.path().join("trash").join(&name)).unwrap(),
            bytes
        );
    }

    #[test]
    fn asset_hashing_rejects_files_over_the_attachment_limit() {
        let (root, assets, _trash, _connection) = fixture();
        let name = "b".repeat(64) + ".png";
        fs::write(
            root.path().join("assets").join(&name),
            vec![7_u8; 20 * 1024 * 1024 + 1],
        )
        .unwrap();

        let error = owned_file_matches_hash(&assets, std::path::Path::new(&name), &"b".repeat(64))
            .expect_err("oversized GC inputs must fail before unbounded hashing");

        assert!(error.contains("byte limit"), "{error}");
    }

    #[test]
    fn asset_hashing_rejects_growth_past_the_limit_after_open() {
        let (root, assets, _trash, _connection) = fixture();
        let name = "d".repeat(64) + ".png";
        let canonical = root.path().join("assets").join(&name);
        fs::write(&canonical, b"initial").unwrap();
        inject_before_owned_file_read_once(move || {
            fs::OpenOptions::new()
                .write(true)
                .open(&canonical)
                .unwrap()
                .set_len(20 * 1024 * 1024 + 1)
                .unwrap();
        });

        let error = owned_file_matches_hash(&assets, std::path::Path::new(&name), &"d".repeat(64))
            .expect_err("post-open growth must remain bounded");

        assert!(error.contains("byte limit"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn asset_hashing_rejects_a_fifo_replacement_without_blocking() {
        use std::sync::mpsc;
        use std::time::Duration;

        let (root, assets, _trash, _connection) = fixture();
        let name = "c".repeat(64) + ".png";
        let canonical = root.path().join("assets").join(&name);
        let displaced = root.path().join("displaced-fifo-source.png");
        fs::write(&canonical, b"regular bytes").unwrap();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let canonical_for_hook = canonical.clone();
            let displaced_for_hook = displaced.clone();
            inject_before_owned_file_open_once(move || {
                fs::rename(&canonical_for_hook, &displaced_for_hook).unwrap();
                let status = std::process::Command::new("mkfifo")
                    .arg(&canonical_for_hook)
                    .status()
                    .unwrap();
                assert!(status.success());
            });
            let result =
                owned_file_matches_hash(&assets, std::path::Path::new(&name), &"c".repeat(64));
            let _ = sender.send(result);
        });

        let result = receiver
            .recv_timeout(Duration::from_millis(500))
            .expect("a FIFO replacement must not block the GC worker");
        let error = result.expect_err("a FIFO replacement must fail closed");
        assert!(error.contains("regular file"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn gc_rejects_a_rebound_trash_directory_before_recording_the_move() {
        use std::os::unix::fs::MetadataExt as StdMetadataExt;

        let (root, assets, trash, connection) = fixture();
        let bytes = b"directory-bound asset";
        let content_hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{content_hash}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        let trash_path = root.path().join("trash");
        let displaced_trash = root.path().join("displaced-trash");
        let expected = fs::metadata(&trash_path).unwrap();
        let expected_identity = (expected.dev(), expected.ino());
        let trash_for_hook = trash_path.clone();
        let displaced_for_hook = displaced_trash.clone();
        inject_after_gc_file_mutation_once(move || {
            fs::rename(&trash_for_hook, &displaced_for_hook).unwrap();
            fs::create_dir(&trash_for_hook).unwrap();
        });
        let mut validate = || {
            let current = fs::symlink_metadata(&trash_path)
                .map_err(|error| format!("Could not revalidate test trash: {error}"))?;
            if (current.dev(), current.ino()) != expected_identity {
                return Err("The Notes asset trash directory identity changed.".to_string());
            }
            Ok(())
        };

        let error = run_asset_gc_in_with_validation(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
            None,
            &mut validate,
        )
        .expect_err("a rebound trash basename must stop before SQL records the move");

        assert!(error.contains("identity changed"), "{error}");
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(displaced_trash.join(&name).exists());
    }

    #[cfg(unix)]
    #[test]
    fn gc_rejects_a_rebound_assets_directory_immediately_before_file_mutation() {
        use std::os::unix::fs::MetadataExt as StdMetadataExt;

        let (root, assets, trash, connection) = fixture();
        let bytes = b"assets-directory-bound asset";
        let content_hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{content_hash}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        let assets_path = root.path().join("assets");
        let displaced_assets = root.path().join("displaced-assets");
        let expected = fs::metadata(&assets_path).unwrap();
        let expected_identity = (expected.dev(), expected.ino());
        let assets_for_hook = assets_path.clone();
        let displaced_for_hook = displaced_assets.clone();
        inject_before_gc_file_mutation_once(move || {
            fs::rename(&assets_for_hook, &displaced_for_hook).unwrap();
            fs::create_dir(&assets_for_hook).unwrap();
        });
        let mut validate = || {
            let current = fs::symlink_metadata(&assets_path)
                .map_err(|error| format!("Could not revalidate test assets: {error}"))?;
            if (current.dev(), current.ino()) != expected_identity {
                return Err("The Notes asset directory identity changed.".to_string());
            }
            Ok(())
        };

        let error = run_asset_gc_in_with_validation(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
            None,
            &mut validate,
        )
        .expect_err("a rebound assets basename must stop before moving the held file");

        assert!(error.contains("identity changed"), "{error}");
        assert!(displaced_assets.join(&name).exists());
        assert!(!root.path().join("trash").join(&name).exists());
    }

    #[cfg(unix)]
    #[test]
    fn gc_rejects_a_rebound_trash_directory_immediately_before_row_deletion() {
        use std::os::unix::fs::MetadataExt as StdMetadataExt;

        let (root, assets, trash, connection) = fixture();
        let expired_bytes = b"expired";
        let content_hash = Sha256::digest(expired_bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{content_hash}.png");
        fs::write(root.path().join("trash").join(&name), expired_bytes).unwrap();
        connection
            .execute(
                "INSERT INTO asset_trash VALUES (?1, 'png', 7, '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z')",
                [&content_hash],
            )
            .unwrap();
        let trash_path = root.path().join("trash");
        let displaced_trash = root.path().join("displaced-expired-trash");
        let expected = fs::metadata(&trash_path).unwrap();
        let expected_identity = (expected.dev(), expected.ino());
        let trash_for_hook = trash_path.clone();
        let displaced_for_hook = displaced_trash.clone();
        inject_before_gc_row_delete_once(move || {
            fs::rename(&trash_for_hook, &displaced_for_hook).unwrap();
            fs::create_dir(&trash_for_hook).unwrap();
        });
        let mut validate = || {
            let current = fs::symlink_metadata(&trash_path)
                .map_err(|error| format!("Could not revalidate test trash: {error}"))?;
            if (current.dev(), current.ino()) != expected_identity {
                return Err("The Notes asset trash directory identity changed.".to_string());
            }
            Ok(())
        };

        let error = run_asset_gc_in_with_validation(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
            None,
            &mut validate,
        )
        .expect_err("a rebound trash basename must stop before deleting its row");

        assert!(error.contains("identity changed"), "{error}");
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn owned_file_delete_never_unlinks_a_replacement_after_validation() {
        let (root, assets, _trash, _connection) = fixture();
        let name = "a".repeat(64) + ".png";
        let canonical = root.path().join("assets").join(&name);
        let displaced = root.path().join("displaced-original.png");
        fs::write(&canonical, b"verified original").unwrap();
        let canonical_for_hook = canonical.clone();
        let displaced_for_hook = displaced.clone();
        inject_before_owned_file_remove_once(move || {
            fs::rename(&canonical_for_hook, &displaced_for_hook).unwrap();
            fs::write(&canonical_for_hook, b"external replacement").unwrap();
        });

        let error = remove_owned_file(&assets, std::path::Path::new(&name))
            .expect_err("a replaced canonical path must fail closed");

        assert!(error.contains("changed"), "{error}");
        assert_eq!(fs::read(&canonical).unwrap(), b"external replacement");
        assert_eq!(fs::read(&displaced).unwrap(), b"verified original");
    }

    #[test]
    fn copied_asset_retires_only_the_exact_held_source_identity() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"verified cross-device source";
        let hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{hash}.png");
        let canonical = root.path().join("assets").join(&name);
        let displaced = root.path().join("displaced-copy-source.png");
        fs::write(&canonical, bytes).unwrap();
        let canonical_for_hook = canonical.clone();
        let displaced_for_hook = displaced.clone();
        inject_before_owned_file_remove_once(move || {
            fs::rename(&canonical_for_hook, &displaced_for_hook).unwrap();
            fs::write(&canonical_for_hook, b"external source replacement").unwrap();
        });

        let error = copy_then_remove(&assets, Path::new(&name), &trash, Path::new(&name), &hash)
            .expect_err("copy retirement must reject a replacement source pathname");

        assert!(
            error.contains("revalidate") || error.contains("changed"),
            "{error}"
        );
        assert_eq!(
            fs::read(&canonical).unwrap(),
            b"external source replacement"
        );
        assert_eq!(fs::read(&displaced).unwrap(), bytes);
        assert_eq!(
            fs::read(root.path().join("trash").join(&name)).unwrap(),
            bytes
        );
    }

    #[test]
    fn authorization_interruption_is_not_reclaimed_by_a_later_runtime_retirement() {
        let (root, assets, _trash, _connection) = fixture();
        let first = "8".repeat(64) + ".png";
        fs::write(root.path().join("assets").join(&first), b"retire me").unwrap();
        inject_retirement_authorization_failure_once();

        let error = remove_owned_file(&assets, Path::new(&first))
            .expect_err("injected interruption must leave a recoverable retirement");
        assert!(error.contains("authorization failure"), "{error}");
        assert!(!root.path().join("assets").join(&first).exists());
        assert!(!private_gc_entries(&root.path().join("assets")).is_empty());

        let second = "9".repeat(64) + ".png";
        fs::write(root.path().join("assets").join(&second), b"second").unwrap();
        remove_owned_file(&assets, Path::new(&second)).unwrap();

        let operations = private_gc_entries(&root.path().join("assets"));
        assert_eq!(operations.len(), 2);
        assert!(operations.iter().any(|operation| {
            fs::read(operation.join(PRIVATE_ASSET_PAYLOAD)).is_ok_and(|bytes| bytes == b"retire me")
        }));
    }

    #[test]
    fn logical_retirement_commits_without_runtime_path_unlink() {
        let (root, assets, _trash, _connection) = fixture();
        let bytes = b"logical retirement payload";
        let name = "d".repeat(64) + ".png";
        let source = root.path().join("assets").join(&name);
        fs::write(&source, bytes).unwrap();

        remove_owned_file(&assets, Path::new(&name)).expect("logical retirement");

        assert!(!source.exists(), "the logical source name must be isolated");
        let operations = private_gc_entries(&root.path().join("assets"));
        assert_eq!(
            operations.len(),
            1,
            "runtime must retain one operation tombstone"
        );
        let operation = &operations[0];
        assert_eq!(
            fs::metadata(operation.join(PRIVATE_ASSET_PAYLOAD))
                .expect("retained payload tombstone")
                .len(),
            0,
            "the exact isolated payload must be reclaimed by held-handle truncation"
        );
        assert!(operation.join(PRIVATE_ASSET_OPERATION_ATTESTATION).exists());
        assert!(operation.join(PRIVATE_ASSET_OPERATION_COMPLETION).exists());
    }

    #[test]
    fn startup_cleanup_consumes_only_a_completed_app_local_operation() {
        let (root, _assets, trash, _connection) = fixture();
        let name = "e".repeat(64) + ".png";
        fs::write(root.path().join("trash").join(&name), b"startup retirement").unwrap();
        remove_owned_file(&trash, Path::new(&name)).expect("logical retirement");
        assert_eq!(private_gc_entries(&root.path().join("trash")).len(), 1);

        cleanup_completed_private_operations_at_startup(&trash, true, &mut || Ok(()))
            .expect("startup cleanup");

        assert!(private_gc_entries(&root.path().join("trash")).is_empty());
    }

    #[test]
    fn startup_cleanup_preserves_an_intent_only_retirement() {
        let (root, _assets, trash, _connection) = fixture();
        let name = "f".repeat(64) + ".png";
        fs::write(root.path().join("trash").join(&name), b"recoverable bytes").unwrap();
        inject_retirement_authorization_failure_once();
        remove_owned_file(&trash, Path::new(&name)).expect_err("injected interruption");
        let operation = private_gc_entries(&root.path().join("trash"))
            .into_iter()
            .next()
            .expect("intent-only operation");

        cleanup_completed_private_operations_at_startup(&trash, true, &mut || Ok(()))
            .expect("malformed or incomplete operations are preserved, not fatal");

        assert_eq!(
            fs::read(operation.join(PRIVATE_ASSET_PAYLOAD)).unwrap(),
            b"recoverable bytes"
        );
        assert!(!operation.join(PRIVATE_ASSET_OPERATION_COMPLETION).exists());
    }

    #[test]
    fn startup_cleanup_reclaims_a_full_intent_only_staging_payload() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"full intent-only staging payload";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("trash").join(&name), bytes).unwrap();
        inject_copy_abort_after_write_once();
        let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            copy_owned_asset(
                &trash,
                Path::new(&name),
                &assets,
                Path::new(&name),
                &expected,
                false,
            )
        }));
        assert!(
            crashed.is_err(),
            "test fixture must crash after staging write"
        );
        let operation = private_gc_entries(&root.path().join("assets"))
            .into_iter()
            .next()
            .expect("intent-only staging operation");
        let payload = operation.join(PRIVATE_ASSET_PAYLOAD);
        assert_eq!(fs::read(&payload).unwrap(), bytes);

        cleanup_completed_private_operations_at_startup(&assets, false, &mut || Ok(()))
            .expect("startup cleanup");

        assert_eq!(
            fs::metadata(payload).unwrap().len(),
            0,
            "startup cleanup must reclaim full intent-only staging bytes without pathname deletion"
        );
        assert!(operation.join(PRIVATE_ASSET_OPERATION_ATTESTATION).exists());
        assert!(!operation.join(PRIVATE_ASSET_OPERATION_COMPLETION).exists());
    }

    #[test]
    fn startup_cleanup_reclaims_intent_only_staging_with_untrusted_completion_temp() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"full staging payload with interrupted completion";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("trash").join(&name), bytes).unwrap();
        inject_copy_abort_after_write_once();
        let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            copy_owned_asset(
                &trash,
                Path::new(&name),
                &assets,
                Path::new(&name),
                &expected,
                false,
            )
        }));
        assert!(
            crashed.is_err(),
            "test fixture must leave intent-only staging"
        );
        let operation = private_gc_entries(&root.path().join("assets"))
            .into_iter()
            .next()
            .expect("intent-only staging operation");
        let payload = operation.join(PRIVATE_ASSET_PAYLOAD);
        let completion_temp = operation.join(PRIVATE_ASSET_OPERATION_COMPLETION_TEMP);
        fs::write(&completion_temp, b"malformed and untrusted").unwrap();

        cleanup_completed_private_operations_at_startup(&assets, false, &mut || Ok(()))
            .expect("startup cleanup");

        assert_eq!(
            fs::metadata(payload).unwrap().len(),
            0,
            "verified intent must authorize payload reclamation without trusting complete.tmp"
        );
        assert_eq!(
            fs::read(completion_temp).unwrap(),
            b"malformed and untrusted"
        );
        assert!(operation.join(PRIVATE_ASSET_OPERATION_ATTESTATION).exists());
        assert!(!operation.join(PRIVATE_ASSET_OPERATION_COMPLETION).exists());
    }

    #[test]
    fn startup_cleanup_finishes_a_completed_retirement_crash_before_truncation() {
        let (root, _assets, trash, _connection) = fixture();
        let bytes = b"completed but not yet truncated";
        let name = "a".repeat(64) + ".png";
        fs::write(root.path().join("trash").join(&name), bytes).unwrap();
        inject_after_retired_handle_drop_once(|| {
            panic!("Injected crash after retirement Complete publication.")
        });

        let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            remove_owned_file(&trash, Path::new(&name))
        }));
        assert!(crashed.is_err());
        let operation = private_gc_entries(&root.path().join("trash"))
            .into_iter()
            .next()
            .expect("completed recovery operation");
        assert_eq!(
            fs::read(operation.join(PRIVATE_ASSET_PAYLOAD)).unwrap(),
            bytes
        );
        assert!(operation.join(PRIVATE_ASSET_OPERATION_COMPLETION).exists());

        cleanup_completed_private_operations_at_startup(&trash, true, &mut || Ok(()))
            .expect("startup exact-handle recovery");

        assert!(private_gc_entries(&root.path().join("trash")).is_empty());
    }

    #[test]
    fn recovery_never_reinterprets_a_retirement_as_staging_cleanup() {
        let (root, assets, _trash, _connection) = fixture();
        let first = "b".repeat(64) + ".png";
        fs::write(root.path().join("assets").join(&first), b"retired identity").unwrap();
        inject_retirement_authorization_failure_once();
        remove_owned_file(&assets, Path::new(&first)).unwrap_err();
        let retired = private_gc_entries(&root.path().join("assets"))
            .into_iter()
            .next()
            .expect("retired operation directory");
        let retired_name = retired.file_name().unwrap().to_string_lossy();
        let suffix = retired_name
            .strip_prefix(RETIRED_DIRECTORY_PREFIX)
            .expect("retirement prefix");
        let rebound = root
            .path()
            .join("assets")
            .join(format!("{STAGING_DIRECTORY_PREFIX}{suffix}"));
        fs::rename(&retired, &rebound).unwrap();

        let second = "c".repeat(64) + ".png";
        fs::write(root.path().join("assets").join(&second), b"second").unwrap();
        remove_owned_file(&assets, Path::new(&second)).unwrap();

        assert_eq!(
            fs::read(rebound.join(PRIVATE_ASSET_PAYLOAD)).unwrap(),
            b"retired identity"
        );
    }

    #[test]
    fn same_filesystem_quarantine_rejects_a_same_size_replacement() {
        let (root, assets, trash, connection) = fixture();
        let bytes = b"verified bytes";
        let replacement = b"mutated! bytes";
        assert_eq!(bytes.len(), replacement.len());
        let hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{hash}.png");
        let canonical = root.path().join("assets").join(&name);
        let displaced = root.path().join("displaced-same-fs.png");
        fs::write(&canonical, bytes).unwrap();
        let canonical_for_hook = canonical.clone();
        let displaced_for_hook = displaced.clone();
        inject_before_same_filesystem_move_once(move || {
            fs::rename(&canonical_for_hook, &displaced_for_hook).unwrap();
            fs::write(&canonical_for_hook, replacement).unwrap();
        });

        let error = run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        )
        .expect_err("a swapped same-filesystem source must not be recorded as quarantined");

        assert!(error.contains("final move boundary"), "{error}");
        assert_eq!(fs::read(&canonical).unwrap(), replacement);
        assert_eq!(fs::read(&displaced).unwrap(), bytes);
        assert!(!root.path().join("trash").join(&name).exists());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn failed_isolated_validation_is_never_reclaimed_as_verified_retirement() {
        let (root, assets, _trash, _connection) = fixture();
        let name = "6".repeat(64) + ".png";
        let canonical = root.path().join("assets").join(&name);
        let displaced = root.path().join("displaced-preserved-original.png");
        fs::write(&canonical, b"verified original").unwrap();
        let canonical_for_swap = canonical.clone();
        let displaced_for_swap = displaced.clone();
        inject_before_owned_file_remove_once(move || {
            fs::rename(&canonical_for_swap, &displaced_for_swap).unwrap();
            fs::write(&canonical_for_swap, b"external replacement").unwrap();
        });
        let error = remove_owned_file(&assets, std::path::Path::new(&name))
            .expect_err("failed isolation validation must preserve the unverified payload");
        assert!(error.contains("final retirement boundary"), "{error}");

        let second_name = "7".repeat(64) + ".png";
        fs::write(root.path().join("assets").join(&second_name), b"second").unwrap();
        remove_owned_file(&assets, std::path::Path::new(&second_name))
            .expect("a later cleanup pass must skip the preserved directory");

        assert_eq!(private_gc_entries(&root.path().join("assets")).len(), 2);
        assert_eq!(fs::read(&canonical).unwrap(), b"external replacement");
        assert_eq!(fs::read(&displaced).unwrap(), b"verified original");
    }

    #[test]
    fn purge_report_serializes_the_fixed_wire_contract() {
        assert_eq!(
            serde_json::to_value(PurgeReport {
                count: 2,
                total_bytes: 4096,
            })
            .unwrap(),
            serde_json::json!({ "count": 2, "totalBytes": 4096 })
        );
    }

    #[test]
    fn asset_gc_directory_binding_uses_cross_platform_capability_contracts() {
        let attachments = include_str!("../attachments.rs");
        let validator = attachments
            .split("pub(crate) fn validate_asset_gc_directories")
            .nth(1)
            .and_then(|source| source.split("pub(crate) fn acquire").next())
            .expect("asset GC directory validator source");
        let file_io = include_str!("../../file_io.rs");
        let source = include_str!("asset_gc.rs");
        let production = source
            .split("#[cfg(test)]\nmod tests {")
            .next()
            .expect("production source");
        let startup_cleanup = source
            .split("fn cleanup_completed_private_operations_at_startup")
            .nth(1)
            .and_then(|source| source.split("pub(crate) fn recover_completed").next())
            .expect("startup cleanup source");
        let private_directory_validation = source
            .split("fn validate_private_directory_security")
            .nth(1)
            .and_then(|source| source.split("fn create_private_directory").next())
            .expect("private operation directory validation source");

        assert!(
            validator
                .matches("capability_metadata_is_reparse_point")
                .count()
                >= 4
        );
        assert!(validator.matches("capability_file_identity").count() >= 4);
        assert!(validator.contains("open_dir_nofollow(\"notes-assets\")"));
        assert!(validator.contains("open_dir_nofollow(\"asset-trash\")"));
        assert!(
            file_io.contains("#[cfg(windows)]\npub(crate) fn capability_metadata_is_reparse_point")
        );
        assert!(file_io.contains("try_capability_file_identity(metadata)"));
        assert!(
            file_io.contains("pub(crate) fn establish_windows_private_directory_security")
                && file_io.contains("pub(crate) fn validate_windows_private_directory_security"),
            "Windows private operation directories need shared held-handle ACL enforcement"
        );
        assert!(
            private_directory_validation.contains("validate_windows_private_directory_security")
                && !private_directory_validation.contains("cannot establish an owner-private"),
            "Windows private operation directories must validate an exact owner-private ACL"
        );
        assert!(
            production.contains("establish_windows_private_directory_security(")
                && production.contains("&directory,")
                && production.contains("validate_private_directory_security(&directory"),
            "new Windows private operation directories must establish and prove security on the held directory"
        );
        let unix_only_cleanup = [
            "#[cfg(unix)]\n        directory.remove_open_dir_all()",
            ".map_err(|error|",
        ]
        .concat();
        assert!(
            startup_cleanup.contains(&unix_only_cleanup),
            "Windows startup cleanup must preserve zero-byte tombstones instead of calling cap-std's path-racy recursive remover"
        );
        assert!(!production.contains("parent.remove_dir(name)"));
        assert!(!production.contains("directory.remove_file("));
    }

    #[test]
    fn purge_dry_run_reports_then_confirm_deletes_live_and_quarantined_assets() {
        let (root, assets, trash, connection) = fixture();
        let previews = AssetPurgePreviewState::default();
        let live = "e".repeat(64);
        let quarantined = "f".repeat(64);
        fs::write(
            root.path().join("assets").join(format!("{live}.png")),
            [1, 2],
        )
        .unwrap();
        fs::write(
            root.path().join("trash").join(format!("{quarantined}.png")),
            [3, 4, 5],
        )
        .unwrap();
        connection
            .execute(
                "INSERT INTO asset_trash VALUES (?1, 'png', 3, '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')",
                params![quarantined],
            )
            .unwrap();

        assert_eq!(
            purge_unused_assets_in_with_preview(
                &connection,
                &assets,
                &trash,
                "test-vault",
                &previews,
                false,
            )
            .unwrap(),
            PurgeReport {
                count: 2,
                total_bytes: 5
            }
        );
        assert!(root
            .path()
            .join("assets")
            .join(format!("{live}.png"))
            .exists());

        assert_eq!(
            purge_unused_assets_in_with_preview(
                &connection,
                &assets,
                &trash,
                "test-vault",
                &previews,
                true,
            )
            .unwrap(),
            PurgeReport {
                count: 2,
                total_bytes: 5
            }
        );
        assert!(!root
            .path()
            .join("assets")
            .join(format!("{live}.png"))
            .exists());
        assert!(!root
            .path()
            .join("trash")
            .join(format!("{quarantined}.png"))
            .exists());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn purge_confirm_rejects_membership_added_after_the_preview() {
        let (root, assets, trash, connection) = fixture();
        let first = "1".repeat(64);
        let second = "2".repeat(64);
        let first_name = format!("{first}.png");
        let second_name = format!("{second}.png");
        fs::write(root.path().join("assets").join(&first_name), b"first").unwrap();
        let previews = AssetPurgePreviewState::default();

        assert_eq!(
            purge_unused_assets_in_with_preview(
                &connection,
                &assets,
                &trash,
                "vault-a",
                &previews,
                false,
            )
            .unwrap(),
            PurgeReport {
                count: 1,
                total_bytes: 5,
            }
        );
        fs::write(root.path().join("trash").join(&second_name), b"second").unwrap();

        let error = purge_unused_assets_in_with_preview(
            &connection,
            &assets,
            &trash,
            "vault-a",
            &previews,
            true,
        )
        .expect_err("confirm must reject membership that differs from the preview");

        assert!(error.contains("new dry-run"), "{error}");
        assert!(root.path().join("assets").join(&first_name).exists());
        assert!(root.path().join("trash").join(&second_name).exists());
    }

    #[test]
    fn purge_confirm_rejects_membership_removed_after_the_preview() {
        let (root, assets, trash, connection) = fixture();
        let first = "3".repeat(64);
        let second = "4".repeat(64);
        let first_name = format!("{first}.png");
        let second_name = format!("{second}.png");
        fs::write(root.path().join("assets").join(&first_name), b"first").unwrap();
        fs::write(root.path().join("trash").join(&second_name), b"second").unwrap();
        let previews = AssetPurgePreviewState::default();

        purge_unused_assets_in_with_preview(
            &connection,
            &assets,
            &trash,
            "vault-a",
            &previews,
            false,
        )
        .unwrap();
        fs::remove_file(root.path().join("trash").join(&second_name)).unwrap();

        let error = purge_unused_assets_in_with_preview(
            &connection,
            &assets,
            &trash,
            "vault-a",
            &previews,
            true,
        )
        .expect_err("confirm must reject membership removed since the preview");

        assert!(error.contains("new dry-run"), "{error}");
        assert!(root.path().join("assets").join(&first_name).exists());
    }

    #[test]
    fn purge_confirm_rejects_same_size_content_replacement_after_preview() {
        let (root, assets, trash, connection) = fixture();
        let content_hash = "a".repeat(64);
        let name = format!("{content_hash}.png");
        let canonical = root.path().join("assets").join(&name);
        fs::write(&canonical, b"previewed").unwrap();
        let previews = AssetPurgePreviewState::default();

        purge_unused_assets_in_with_preview(
            &connection,
            &assets,
            &trash,
            "vault-a",
            &previews,
            false,
        )
        .unwrap();
        fs::remove_file(&canonical).unwrap();
        fs::write(&canonical, b"replaced!").unwrap();

        let error = purge_unused_assets_in_with_preview(
            &connection,
            &assets,
            &trash,
            "vault-a",
            &previews,
            true,
        )
        .expect_err("confirm must bind the previewed file identity and contents");

        assert!(error.contains("new dry-run"), "{error}");
        assert_eq!(fs::read(&canonical).unwrap(), b"replaced!");
    }

    #[cfg(unix)]
    #[test]
    fn purge_preview_streams_evidence_without_retaining_one_fd_per_asset() {
        use std::sync::{Arc, Mutex};

        let (root, assets, trash, connection) = fixture();
        for index in 0_u16..256 {
            let bytes = index.to_le_bytes();
            let content_hash = Sha256::digest(bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            fs::write(
                root.path()
                    .join("assets")
                    .join(format!("{content_hash}.png")),
                bytes,
            )
            .unwrap();
        }
        let baseline = fs::read_dir("/dev/fd").unwrap().count();
        let peak = Arc::new(Mutex::new(baseline));
        let observed_peak = Arc::clone(&peak);
        inject_after_unused_asset_evidence(move || {
            let current = fs::read_dir("/dev/fd").unwrap().count();
            let mut peak = observed_peak.lock().unwrap();
            *peak = (*peak).max(current);
        });

        let result = purge_unused_assets_in_with_preview(
            &connection,
            &assets,
            &trash,
            "fd-vault",
            &AssetPurgePreviewState::default(),
            false,
        );
        clear_after_unused_asset_evidence();

        assert_eq!(result.unwrap().count, 256);
        assert!(
            *peak.lock().unwrap() <= baseline + 4,
            "purge preview retained O(n) descriptors: baseline={baseline}, peak={}",
            *peak.lock().unwrap()
        );
    }

    #[test]
    fn purge_preview_is_scoped_to_one_vault() {
        let (root, assets, trash, connection) = fixture();
        let content_hash = "5".repeat(64);
        let name = format!("{content_hash}.png");
        fs::write(root.path().join("assets").join(&name), b"unused").unwrap();
        let previews = AssetPurgePreviewState::default();

        purge_unused_assets_in_with_preview(
            &connection,
            &assets,
            &trash,
            "vault-a",
            &previews,
            false,
        )
        .unwrap();
        let error = purge_unused_assets_in_with_preview(
            &connection,
            &assets,
            &trash,
            "vault-b",
            &previews,
            true,
        )
        .expect_err("one vault must never consume another vault's preview");

        assert!(error.contains("new dry-run"), "{error}");
        assert!(root.path().join("assets").join(&name).exists());
    }

    #[test]
    fn copied_destination_rebind_after_final_hash_stops_source_retirement() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"copy destination final binding";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        let source = root.path().join("assets").join(&name);
        let destination = root.path().join("trash").join(&name);
        let displaced = root.path().join("displaced-copy-destination");
        fs::write(&source, bytes).unwrap();
        let destination_for_hook = destination.clone();
        let displaced_for_hook = displaced.clone();
        inject_after_copy_destination_hash_once(move || {
            fs::rename(&destination_for_hook, &displaced_for_hook).unwrap();
            fs::write(&destination_for_hook, b"external copy replacement").unwrap();
        });

        let result = copy_then_remove(
            &assets,
            Path::new(&name),
            &trash,
            Path::new(&name),
            &expected,
        );

        assert!(result.is_err(), "rebound destination retired the source");
        assert_eq!(fs::read(&source).unwrap(), bytes);
        assert_eq!(
            fs::read(&destination).unwrap(),
            b"external copy replacement"
        );
        assert_eq!(fs::read(&displaced).unwrap(), bytes);
    }

    #[test]
    fn copied_destination_same_inode_mutation_after_final_hash_stops_source_retirement() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"copy destination same inode boundary";
        let replacement = b"copy destination same inode changed!";
        assert_eq!(bytes.len(), replacement.len());
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        let source = root.path().join("assets").join(&name);
        let destination = root.path().join("trash").join(&name);
        fs::write(&source, bytes).unwrap();
        let destination_for_hook = destination.clone();
        inject_after_copy_destination_hash_once(move || {
            fs::write(&destination_for_hook, replacement).unwrap();
        });

        let result = copy_then_remove(
            &assets,
            Path::new(&name),
            &trash,
            Path::new(&name),
            &expected,
        );

        assert!(result.is_err(), "same-inode mutation retired the source");
        assert_eq!(fs::read(&source).unwrap(), bytes);
        assert_eq!(fs::read(&destination).unwrap(), replacement);
    }

    #[test]
    fn published_destination_rebind_after_final_hash_fails_before_commit() {
        let (root, assets, _trash, _connection) = fixture();
        let bytes = b"published final binding";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        let canonical = root.path().join("assets").join(&name);
        let displaced = root.path().join("displaced-published-destination");
        let canonical_for_hook = canonical.clone();
        let displaced_for_hook = displaced.clone();
        inject_after_published_asset_hash_once(move || {
            fs::rename(&canonical_for_hook, &displaced_for_hook).unwrap();
            fs::write(&canonical_for_hook, b"external publish replacement").unwrap();
        });

        let result = publish_owned_asset_with_writer(
            &assets,
            Path::new(&name),
            &expected,
            u64::try_from(bytes.len()).unwrap(),
            |destination| {
                destination
                    .write_all(bytes)
                    .map_err(|error| error.to_string())
            },
        );

        assert!(result.is_err(), "rebound publication was committed");
        assert_eq!(
            fs::read(&canonical).unwrap(),
            b"external publish replacement"
        );
        assert_eq!(fs::read(&displaced).unwrap(), bytes);
    }

    #[test]
    fn published_destination_same_inode_mutation_after_final_hash_fails_before_commit() {
        let (root, assets, _trash, _connection) = fixture();
        let bytes = b"published same inode boundary";
        let replacement = b"published same inode changed!";
        assert_eq!(bytes.len(), replacement.len());
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        let canonical = root.path().join("assets").join(&name);
        let canonical_for_hook = canonical.clone();
        inject_after_published_asset_hash_once(move || {
            fs::write(&canonical_for_hook, replacement).unwrap();
        });

        let result = publish_owned_asset_with_writer(
            &assets,
            Path::new(&name),
            &expected,
            u64::try_from(bytes.len()).unwrap(),
            |destination| {
                destination
                    .write_all(bytes)
                    .map_err(|error| error.to_string())
            },
        );

        assert!(result.is_err(), "same-inode publication was committed");
        assert_eq!(fs::read(&canonical).unwrap(), replacement);
    }

    #[test]
    fn moved_destination_rebind_after_final_hash_fails_before_transition() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"moved final binding";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        let destination = root.path().join("trash").join(&name);
        let displaced = root.path().join("displaced-moved-destination");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        let destination_for_hook = destination.clone();
        let displaced_for_hook = displaced.clone();
        inject_after_moved_asset_hash_once(move || {
            fs::rename(&destination_for_hook, &displaced_for_hook).unwrap();
            fs::write(&destination_for_hook, b"external move replacement").unwrap();
        });

        let result = move_noreplace_with_validation(
            &assets,
            Path::new(&name),
            &trash,
            Path::new(&name),
            &expected,
            &mut || Ok(()),
        );

        assert!(result.is_err(), "rebound move destination was accepted");
        assert_eq!(
            fs::read(&destination).unwrap(),
            b"external move replacement"
        );
        assert_eq!(fs::read(&displaced).unwrap(), bytes);
    }

    #[test]
    fn moved_destination_same_inode_write_after_final_hash_fails_before_transition() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"moved same inode original";
        let replacement = b"moved same inode changed!";
        assert_eq!(bytes.len(), replacement.len());
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        let destination = root.path().join("trash").join(&name);
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        let destination_for_hook = destination.clone();
        inject_after_moved_asset_hash_once(move || {
            fs::write(&destination_for_hook, replacement).unwrap();
        });

        let result = move_noreplace_with_validation(
            &assets,
            Path::new(&name),
            &trash,
            Path::new(&name),
            &expected,
            &mut || Ok(()),
        );

        assert!(result.is_err(), "same-inode moved mutation was accepted");
        assert_eq!(fs::read(&destination).unwrap(), replacement);
    }

    #[cfg(unix)]
    #[test]
    fn same_filesystem_move_rejects_a_link_added_after_moved_hash() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"same filesystem moved link boundary";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        let source = root.path().join("assets").join(&name);
        let destination = root.path().join("trash").join(&name);
        let alias = root.path().join("moved-hardlink-alias.png");
        fs::write(&source, bytes).unwrap();
        let destination_for_hook = destination.clone();
        let alias_for_hook = alias.clone();
        inject_after_moved_asset_hash_once(move || {
            fs::hard_link(&destination_for_hook, &alias_for_hook).unwrap();
        });

        let result = move_noreplace_with_validation(
            &assets,
            Path::new(&name),
            &trash,
            Path::new(&name),
            &expected,
            &mut || Ok(()),
        );

        assert!(result.is_err(), "the moved boundary accepted nlink > 1");
        assert_eq!(fs::read(&destination).unwrap(), bytes);
        assert_eq!(fs::read(&alias).unwrap(), bytes);
    }

    #[test]
    fn duplicate_quarantine_keeps_live_copy_evidence_until_source_retirement() {
        let (root, assets, trash, connection) = fixture();
        let bytes = b"duplicate last-copy evidence";
        let content_hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{content_hash}.png");
        let live = root.path().join("assets").join(&name);
        let destination = root.path().join("trash").join(&name);
        fs::write(&live, bytes).unwrap();
        fs::write(&destination, bytes).unwrap();
        connection
            .execute(
                "INSERT INTO asset_trash VALUES (?1, 'png', ?2, '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')",
                params![content_hash, i64::try_from(bytes.len()).unwrap()],
            )
            .unwrap();
        let destination_for_hook = destination.clone();
        inject_before_last_copy_retirement_once(move || {
            fs::write(&destination_for_hook, b"changed duplicate destination").unwrap();
        });

        let result = run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        );

        assert!(
            result.is_err(),
            "changed destination allowed last-copy retirement"
        );
        assert_eq!(fs::read(&live).unwrap(), bytes);
    }

    #[test]
    fn duplicate_survivor_is_reopened_after_counterpart_isolation() {
        let (root, assets, trash, connection) = fixture();
        let bytes = b"duplicate survivor after isolation";
        let content_hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{content_hash}.png");
        let live = root.path().join("assets").join(&name);
        let survivor = root.path().join("trash").join(&name);
        let displaced = root.path().join("displaced-duplicate-survivor.png");
        fs::write(&live, bytes).unwrap();
        fs::write(&survivor, bytes).unwrap();
        let survivor_for_hook = survivor.clone();
        let displaced_for_hook = displaced.clone();
        inject_after_counterpart_isolation_once(move || {
            fs::rename(&survivor_for_hook, &displaced_for_hook).unwrap();
            fs::write(&survivor_for_hook, bytes).unwrap();
        });

        let result = run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        );

        assert!(
            result.is_err(),
            "a rebound survivor committed counterpart retirement"
        );
        assert_eq!(fs::read(&survivor).unwrap(), bytes);
        assert_eq!(fs::read(&displaced).unwrap(), bytes);
        assert!(
            private_gc_entries(&root.path().join("assets"))
                .into_iter()
                .any(|entry| {
                    fs::read(entry.join(PRIVATE_ASSET_PAYLOAD))
                        .is_ok_and(|observed| observed == bytes)
                }),
            "the isolated counterpart was not preserved as recovery evidence"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn tracked_restore_keeps_published_live_evidence_until_trash_retirement() {
        let (root, assets, trash, connection) = fixture();
        let bytes = b"tracked restore last-copy evidence";
        let content_hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{content_hash}.png");
        let live = root.path().join("assets").join(&name);
        let source = root.path().join("trash").join(&name);
        fs::write(&source, bytes).unwrap();
        connection
            .execute(
                "INSERT INTO notes_attachments(content_hash) VALUES (?1)",
                [&content_hash],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO asset_trash VALUES (?1, 'png', ?2, '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')",
                params![content_hash, i64::try_from(bytes.len()).unwrap()],
            )
            .unwrap();
        let live_for_hook = live.clone();
        inject_before_last_copy_retirement_once(move || {
            fs::write(&live_for_hook, b"changed restored destination").unwrap();
        });

        let result = run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        );

        assert!(
            result.is_err(),
            "changed live copy allowed trash retirement"
        );
        assert_eq!(fs::read(&source).unwrap(), bytes);
    }

    #[test]
    fn attestation_publish_failure_precedes_payload_creation() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"uninitialized payload";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        inject_operation_attestation_publish_failure_once();

        copy_owned_asset(
            &assets,
            Path::new(&name),
            &trash,
            Path::new(&name),
            &expected,
            false,
        )
        .expect_err("attestation publication failure must surface");

        let operation = private_gc_entries(&root.path().join("trash"))
            .into_iter()
            .next()
            .expect("failed intent publication directory");
        assert!(operation.join(PRIVATE_ASSET_OPERATION_TEMP).exists());
        assert!(!operation.join(PRIVATE_ASSET_PAYLOAD).exists());
    }

    #[cfg(unix)]
    #[test]
    fn exact_rollback_never_moves_a_replacement_after_final_verification() {
        let (root, assets, staging, _connection) = fixture();
        let bytes = b"exact rollback original";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        let canonical = root.path().join("assets").join(&name);
        let displaced = root.path().join("displaced-rollback-original");
        fs::write(&canonical, bytes).unwrap();
        let metadata = fs::metadata(&canonical).unwrap();
        use std::os::unix::fs::MetadataExt;
        let identity = (metadata.dev(), metadata.ino());
        let canonical_for_hook = canonical.clone();
        let displaced_for_hook = displaced.clone();
        inject_before_exact_rollback_move_once(move || {
            fs::rename(&canonical_for_hook, &displaced_for_hook).unwrap();
            fs::write(&canonical_for_hook, b"external rollback replacement").unwrap();
        });

        let result = rollback_exact_published_asset(
            &assets,
            Path::new(&name),
            identity,
            &expected,
            &staging,
            Path::new(PRIVATE_ASSET_PAYLOAD),
        );

        assert!(
            result.is_err(),
            "replacement rollback unexpectedly succeeded"
        );
        assert_eq!(
            fs::read(&canonical).unwrap(),
            b"external rollback replacement"
        );
        assert_eq!(fs::read(&displaced).unwrap(), bytes);
    }

    #[cfg(unix)]
    #[test]
    fn exact_rollback_preserves_a_rebound_private_entry_after_its_final_hash() {
        let (root, assets, staging, _connection) = fixture();
        let bytes = b"exact rollback original";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        let canonical = root.path().join("assets").join(&name);
        let staged_path = root.path().join("trash").join(PRIVATE_ASSET_PAYLOAD);
        let displaced = root.path().join("displaced-private-rollback-original");
        fs::write(&canonical, bytes).unwrap();
        let metadata = fs::metadata(&canonical).unwrap();
        use std::os::unix::fs::MetadataExt;
        let identity = (metadata.dev(), metadata.ino());
        let staged_for_hook = staged_path.clone();
        let displaced_for_hook = displaced.clone();
        inject_after_exact_rollback_hash_once(move || {
            fs::rename(&staged_for_hook, &displaced_for_hook).unwrap();
            fs::write(&staged_for_hook, b"external private replacement").unwrap();
        });

        let result = rollback_exact_published_asset(
            &assets,
            Path::new(&name),
            identity,
            &expected,
            &staging,
            Path::new(PRIVATE_ASSET_PAYLOAD),
        );

        assert!(result.is_err(), "rebound private rollback was accepted");
        assert_eq!(
            fs::read(&canonical).unwrap(),
            b"external private replacement"
        );
        assert!(!staged_path.exists());
        assert_eq!(fs::read(&displaced).unwrap(), bytes);
    }

    #[test]
    fn exact_rollback_rejects_same_inode_write_after_rollback_hash() {
        let (root, assets, staging, _connection) = fixture();
        let bytes = b"exact rollback original";
        let replacement = vec![0xa5; bytes.len()];
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        let canonical = root.path().join("assets").join(&name);
        let staged_path = root.path().join("trash").join(PRIVATE_ASSET_PAYLOAD);
        fs::write(&canonical, bytes).unwrap();
        let published = super::hold_verified_owned_asset(&assets, Path::new(&name), &expected)
            .expect("hold published asset");
        let identity = published.identity();
        drop(published);
        let staged_for_hook = staged_path.clone();
        let replacement_for_hook = replacement.clone();
        inject_after_exact_rollback_hash_once(move || {
            fs::write(&staged_for_hook, replacement_for_hook)
                .expect("mutate rolled-back inode after final hash");
        });

        let result = rollback_exact_published_asset(
            &assets,
            Path::new(&name),
            identity,
            &expected,
            &staging,
            Path::new(PRIVATE_ASSET_PAYLOAD),
        );

        assert!(
            result.is_err(),
            "same-inode post-hash rollback mutation was accepted"
        );
        assert_eq!(fs::read(canonical).unwrap(), replacement);
        assert!(!staged_path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn exact_rollback_restores_a_replacement_installed_after_final_binding() {
        let (root, assets, staging, _connection) = fixture();
        let bytes = b"exact rollback bound original";
        let replacement = b"post-binding rollback replacement";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        let canonical = root.path().join("assets").join(&name);
        let displaced = root.path().join("displaced-bound-rollback-original");
        fs::write(&canonical, bytes).unwrap();
        let metadata = fs::metadata(&canonical).unwrap();
        use std::os::unix::fs::MetadataExt;
        let identity = (metadata.dev(), metadata.ino());
        let canonical_for_hook = canonical.clone();
        let displaced_for_hook = displaced.clone();
        inject_after_exact_rollback_final_binding_once(move || {
            fs::rename(&canonical_for_hook, &displaced_for_hook).unwrap();
            fs::write(&canonical_for_hook, replacement).unwrap();
        });

        let result = rollback_exact_published_asset(
            &assets,
            Path::new(&name),
            identity,
            &expected,
            &staging,
            Path::new(PRIVATE_ASSET_PAYLOAD),
        );

        assert!(
            result.is_err(),
            "post-binding replacement rollback succeeded"
        );
        assert_eq!(fs::read(&canonical).unwrap(), replacement);
        assert_eq!(fs::read(&displaced).unwrap(), bytes);
    }

    #[test]
    fn exact_rollback_same_inode_write_after_final_binding_stops_before_move() {
        use std::cell::Cell;
        use std::rc::Rc;

        let (root, assets, staging, _connection) = fixture();
        let bytes = b"rollback same inode original";
        let replacement = b"rollback same inode changed!";
        assert_eq!(bytes.len(), replacement.len());
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        let canonical = root.path().join("assets").join(&name);
        fs::write(&canonical, bytes).unwrap();
        let metadata = fs::metadata(&canonical).unwrap();
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        #[cfg(unix)]
        let identity = (metadata.dev(), metadata.ino());
        #[cfg(not(unix))]
        let identity = crate::file_io::capability_file_identity(&metadata).unwrap();
        let canonical_for_hook = canonical.clone();
        inject_after_exact_rollback_final_binding_once(move || {
            fs::write(&canonical_for_hook, replacement).unwrap();
        });
        let post_move_hook_ran = Rc::new(Cell::new(false));
        let post_move_hook_for_test = Rc::clone(&post_move_hook_ran);
        inject_after_exact_rollback_move_once(move || post_move_hook_for_test.set(true));

        let result = rollback_exact_published_asset(
            &assets,
            Path::new(&name),
            identity,
            &expected,
            &staging,
            Path::new(PRIVATE_ASSET_PAYLOAD),
        );

        assert!(result.is_err(), "same-inode rollback mutation was accepted");
        assert!(
            !post_move_hook_ran.get(),
            "rollback moved the mutated inode before rejecting it"
        );
        assert_eq!(fs::read(&canonical).unwrap(), replacement);
    }

    #[cfg(unix)]
    #[test]
    fn copy_retirement_closes_all_source_reader_aliases_before_unlink() {
        use std::os::unix::fs::MetadataExt;

        let (root, assets, trash, _connection) = fixture();
        let bytes = b"source reader lifecycle";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        let source = root.path().join("assets").join(&name);
        fs::write(&source, bytes).unwrap();
        let metadata = fs::metadata(&source).unwrap();
        let identity = (metadata.dev(), metadata.ino());
        inject_after_retired_handle_drop_once(move || {
            let still_open = fs::read_dir("/dev/fd")
                .unwrap()
                .filter_map(Result::ok)
                .any(|entry| {
                    fs::metadata(entry.path())
                        .map(|metadata| (metadata.dev(), metadata.ino()) == identity)
                        .unwrap_or(false)
                });
            assert!(
                !still_open,
                "source reader alias remained open through retirement"
            );
        });

        copy_then_remove(
            &assets,
            Path::new(&name),
            &trash,
            Path::new(&name),
            &expected,
        )
        .expect("copy retirement");
    }

    #[test]
    fn runtime_publication_does_not_touch_an_older_incomplete_staging_payload() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"attested staged payload";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        inject_copy_abort_after_write_once();
        let aborted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            copy_owned_asset(
                &assets,
                Path::new(&name),
                &trash,
                Path::new(&name),
                &expected,
                false,
            )
        }));
        assert!(aborted.is_err());
        let staging = private_gc_entries(&root.path().join("trash"))
            .into_iter()
            .next()
            .expect("interrupted staging");
        let payload = staging.join(PRIVATE_ASSET_PAYLOAD);

        copy_owned_asset(
            &assets,
            Path::new(&name),
            &trash,
            Path::new(&name),
            &expected,
            false,
        )
        .expect("publication must not sweep an older incomplete operation");

        assert_eq!(fs::read(&payload).unwrap(), bytes);
        assert_eq!(
            fs::read(root.path().join("trash").join(name)).unwrap(),
            bytes
        );
    }

    #[test]
    fn whole_operation_retirement_never_targets_a_canonical_replacement() {
        let (root, assets, _trash, _connection) = fixture();
        let name = format!("{}.png", "e".repeat(64));
        let canonical = root.path().join("assets").join(&name);
        fs::write(&canonical, b"verified retirement payload").unwrap();
        let assets_root = root.path().join("assets");
        let displaced = root.path().join("displaced-isolated-retirement");
        let assets_for_hook = assets_root.clone();
        let displaced_for_hook = displaced.clone();
        inject_after_retired_handle_drop_once(move || {
            let retirement = private_gc_entries(&assets_for_hook)
                .into_iter()
                .next()
                .expect("retirement directory");
            let isolated = retirement.join(PRIVATE_ASSET_PAYLOAD);
            fs::rename(&isolated, &displaced_for_hook).unwrap();
            fs::write(&isolated, b"external isolated replacement").unwrap();
        });

        let error = remove_owned_file(&assets, Path::new(&name))
            .expect_err("exact held-handle reclamation must reject a rebound private payload");

        assert!(
            error.contains("changed before exact reclamation"),
            "{error}"
        );
        assert!(!canonical.exists());
        assert_eq!(fs::read(displaced).unwrap(), b"verified retirement payload");
        let operation = private_gc_entries(&assets_root)
            .into_iter()
            .next()
            .expect("completed operation preserved for recovery");
        assert_eq!(
            fs::read(operation.join(PRIVATE_ASSET_PAYLOAD)).unwrap(),
            b"external isolated replacement"
        );
    }

    #[test]
    fn malformed_final_operation_does_not_block_other_private_cleanup_or_publication() {
        let (root, assets, trash, _connection) = fixture();
        let (malformed, malformed_name, _) =
            create_private_directory(&trash, STAGING_DIRECTORY_PREFIX, &mut || Ok(())).unwrap();
        fs::write(
            root.path()
                .join("trash")
                .join(&malformed_name)
                .join(PRIVATE_ASSET_OPERATION_ATTESTATION),
            b"not valid operation json",
        )
        .unwrap();
        drop(malformed);
        let bytes = b"publication after malformed operation";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();

        copy_owned_asset(
            &assets,
            Path::new(&name),
            &trash,
            Path::new(&name),
            &expected,
            false,
        )
        .expect("malformed final operation must be preserved without blocking later work");

        assert!(root
            .path()
            .join("trash")
            .join(malformed_name)
            .join(PRIVATE_ASSET_OPERATION_ATTESTATION)
            .exists());
        assert_eq!(
            fs::read(root.path().join("trash").join(name)).unwrap(),
            bytes
        );
    }

    #[test]
    fn invalid_temporary_marker_is_preserved_and_allows_publication() {
        let (root, assets, trash, _connection) = fixture();
        let (invalid, invalid_name, _) =
            create_private_directory(&trash, STAGING_DIRECTORY_PREFIX, &mut || Ok(())).unwrap();
        drop(invalid);
        fs::create_dir(
            root.path()
                .join("trash")
                .join(&invalid_name)
                .join(PRIVATE_ASSET_OPERATION_TEMP),
        )
        .unwrap();
        let bytes = b"publication after invalid temporary marker";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();

        copy_owned_asset(
            &assets,
            Path::new(&name),
            &trash,
            Path::new(&name),
            &expected,
            false,
        )
        .expect("an invalid temporary marker must not block unrelated publication");

        assert_eq!(
            fs::read(root.path().join("trash").join(name)).unwrap(),
            bytes
        );
        assert!(root.path().join("trash").join(invalid_name).exists());
    }

    #[test]
    fn payload_creation_crash_leaves_intent_owned_operation_preserved_on_retry() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"intent before payload crash";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        inject_after_staging_payload_creation_once(|| {
            panic!("Injected crash immediately after payload creation.")
        });

        let aborted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            copy_owned_asset(
                &assets,
                Path::new(&name),
                &trash,
                Path::new(&name),
                &expected,
                false,
            )
        }));
        assert!(aborted.is_err());
        let interrupted = private_gc_entries(&root.path().join("trash"))
            .into_iter()
            .find(|entry| {
                entry.file_name().is_some_and(|name| {
                    name.to_string_lossy().starts_with(STAGING_DIRECTORY_PREFIX)
                })
            })
            .expect("interrupted staging operation");
        assert!(
            interrupted
                .join(PRIVATE_ASSET_OPERATION_ATTESTATION)
                .exists(),
            "payload creation preceded durable Intent"
        );
        assert!(interrupted.join(PRIVATE_ASSET_PAYLOAD).exists());

        copy_owned_asset(
            &assets,
            Path::new(&name),
            &trash,
            Path::new(&name),
            &expected,
            false,
        )
        .expect("retry publishes without mutating the incomplete operation");

        assert_eq!(
            fs::read(root.path().join("trash").join(name)).unwrap(),
            bytes
        );
        assert!(interrupted.exists());
        assert!(private_gc_entries(&root.path().join("trash")).len() >= 2);
    }

    #[test]
    fn review_handoff_docs_do_not_claim_open_findings_are_already_addressed() {
        let task_brief = include_str!("../../../../.superpowers/sdd/task-5-brief.md");
        assert!(
            !task_brief.contains("current frozen candidate addresses each"),
            "open-review documentation must not claim the findings are addressed"
        );
    }

    #[test]
    fn operation_attestation_helpers_use_a_neutral_directory_parameter_name() {
        let source = include_str!("asset_gc.rs");
        assert!(
            !source.contains("fn write_operation_attestation(\n    retired:")
                && !source.contains("fn read_operation_attestation(\n    retired:"),
            "operation attestations are used for both staging and retirement"
        );
    }

    #[test]
    fn copy_source_reader_is_explicitly_closed_before_retirement() {
        let source = include_str!("asset_gc.rs");
        let reread = source
            .find("source = held_source")
            .expect("second source reader");
        let retirement = source[reread..]
            .find("remove_held_owned_file_with_validation(")
            .map(|offset| reread + offset)
            .expect("source retirement");
        assert!(
            source[reread..retirement].contains("drop(source);"),
            "the second source reader must close before Windows retirement"
        );
    }

    #[test]
    fn runtime_retirement_never_path_unlinks_private_payloads() {
        let source = include_str!("asset_gc.rs");
        let retirement = source
            .split("pub(crate) fn logical_retire_noreplace(")
            .nth(1)
            .and_then(|source| source.split("\nfn ").next())
            .expect("logical retirement authority");
        assert!(retirement.contains("truncate_and_sync()"));
        assert!(retirement.contains("write_operation_completion("));
        assert!(!retirement.contains("remove_file("));
        assert!(!retirement.contains("remove_dir("));
        assert!(!retirement.contains("remove_open_dir_all("));
    }

    #[test]
    fn staging_intent_precedes_payload_creation_in_one_shared_state_machine() {
        let source = include_str!("asset_gc.rs");
        assert!(
            source.matches("create_staged_asset_operation(").count() >= 3,
            "copy and writer staging must share one initialization state machine"
        );
        let helper = source
            .split("fn create_staged_asset_operation(")
            .nth(1)
            .and_then(|source| source.split("\nfn ").next())
            .expect("shared staged-operation initializer");
        let intent = helper
            .find("write_operation_attestation(")
            .expect("durable staging intent");
        let payload = helper.find(".open_with(").expect("payload creation");
        assert!(
            intent < payload,
            "durable Intent must publish before payload creation"
        );
    }

    #[test]
    fn replay_survivor_reopens_after_trash_isolation_before_retirement_commit() {
        let source = include_str!("asset_gc.rs");
        let finalize = source
            .split("pub(crate) fn finalize_attachment_for_replay(")
            .nth(1)
            .and_then(|source| source.split("\nfn ").next())
            .expect("replay finalization");
        assert!(
            finalize.contains("logical_retire_noreplace("),
            "replay must use the one retirement authority"
        );
        assert!(
            finalize.contains("RetirementSurvivor::new("),
            "replay must give the authority a survivor specification, not a caller-held handle"
        );
    }

    #[cfg(unix)]
    #[test]
    fn retirement_rejects_a_link_added_after_its_final_hash() {
        let (root, assets, _trash, _connection) = fixture();
        let bytes = b"final retirement link boundary";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        let canonical = root.path().join("assets").join(&name);
        let alias = root.path().join("retirement-hardlink-alias.png");
        fs::write(&canonical, bytes).unwrap();
        let canonical_for_hook = canonical.clone();
        let alias_for_hook = alias.clone();
        inject_after_retirement_final_hash_once(move || {
            fs::hard_link(&canonical_for_hook, &alias_for_hook).unwrap();
        });

        let result = remove_owned_file(&assets, Path::new(&name));

        assert!(result.is_err(), "retirement accepted a late hardlink");
        assert_eq!(fs::read(&canonical).unwrap(), bytes);
        assert_eq!(fs::read(&alias).unwrap(), bytes);
    }

    #[cfg(unix)]
    #[test]
    fn same_filesystem_move_recovery_preserves_a_rebind_during_final_validation() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"move recovery exact source";
        let replacement = b"move recovery replacement";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        let source = root.path().join("assets").join(&name);
        let destination = root.path().join("trash").join(&name);
        let displaced = root.path().join("displaced-move-recovery-original");
        fs::write(&source, bytes).unwrap();
        inject_move_validation_failure_once();
        let destination_for_hook = destination.clone();
        let displaced_for_hook = displaced.clone();
        inject_during_move_recovery_validation_once(move || {
            fs::rename(&destination_for_hook, &displaced_for_hook).unwrap();
            fs::write(&destination_for_hook, replacement).unwrap();
        });

        let result = move_noreplace_with_validation(
            &assets,
            Path::new(&name),
            &trash,
            Path::new(&name),
            &expected,
            &mut || Ok(()),
        );

        assert!(
            result.is_err(),
            "rebound move recovery unexpectedly succeeded"
        );
        assert!(!source.exists());
        assert_eq!(fs::read(&destination).unwrap(), replacement);
        assert_eq!(fs::read(&displaced).unwrap(), bytes);
    }

    #[cfg(unix)]
    #[test]
    fn same_filesystem_move_recovery_rebinds_immediately_before_restore() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"move recovery final source";
        let replacement = b"move recovery final replacement";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        let source = root.path().join("assets").join(&name);
        let destination = root.path().join("trash").join(&name);
        let displaced = root.path().join("displaced-final-move-recovery-original");
        fs::write(&source, bytes).unwrap();
        inject_move_validation_failure_once();
        let destination_for_hook = destination.clone();
        let displaced_for_hook = displaced.clone();
        inject_after_move_recovery_final_binding_once(move || {
            fs::rename(&destination_for_hook, &displaced_for_hook).unwrap();
            fs::write(&destination_for_hook, replacement).unwrap();
        });

        let result = move_noreplace_with_validation(
            &assets,
            Path::new(&name),
            &trash,
            Path::new(&name),
            &expected,
            &mut || Ok(()),
        );

        assert!(
            result.is_err(),
            "failed move validation unexpectedly succeeded"
        );
        assert!(
            !source.exists(),
            "a rebound destination was moved to source"
        );
        assert_eq!(fs::read(&destination).unwrap(), replacement);
        assert_eq!(fs::read(&displaced).unwrap(), bytes);
    }
}
