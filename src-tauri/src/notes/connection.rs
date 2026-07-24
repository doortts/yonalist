//! Process-wide manager that keeps a single SQLite connection open per vault.
//!
//! This module caches one `Arc<Mutex<Connection>>` per vault so database setup
//! runs once, on the first acquisition, and later acquisitions hand back the
//! cached connection without repeating schema work.
//!
//! The manager is a module-level `OnceLock` rather than Tauri managed
//! [`State`](tauri::State) on purpose: the command bodies stay plain functions
//! (no signature churn) and the synchronous `_inner` functions remain directly
//! callable from tests. Commands run inside `spawn_blocking` (see task 1.1), and
//! the per-connection `Mutex` serializes database access per vault; callers must
//! hold that lock only around the actual database work.

use crate::notes::attachments::{
    acquire_existing_vault_app_lock_file, acquire_vault_app_lock_file,
};
use crate::notes::repository::{connect_notes_db, notes_db_path};
use cap_fs_ext::MetadataExt as CapMetadataExt;
use cap_std::fs::Dir;
use rusqlite::Connection;
#[cfg(unix)]
use rusqlite::{OpenFlags, TransactionBehavior};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError, Weak};

/// A vault's SQLite connection, shared across commands and guarded by a `Mutex`
/// that serializes database access for that vault.
struct ManagedNotesConnection {
    connection: Option<Connection>,
    #[cfg(unix)]
    identity: NotesDatabaseSetIdentity,
}

pub(crate) struct NotesConnectionEntry {
    key: PathBuf,
    connection: Mutex<ManagedNotesConnection>,
}

impl NotesConnectionEntry {
    fn is_poisoned(&self) -> bool {
        self.connection.is_poisoned()
    }
}

pub(crate) type SharedNotesConnection = Arc<NotesConnectionEntry>;

pub(crate) struct NotesConnectionGuard<'a> {
    shared: &'a SharedNotesConnection,
    connection: MutexGuard<'a, ManagedNotesConnection>,
    _active_use: ActiveNotesConnectionUse,
}

impl Deref for NotesConnectionGuard<'_> {
    type Target = Connection;

    fn deref(&self) -> &Self::Target {
        self.connection
            .connection
            .as_ref()
            .expect("an active Notes connection guard must own an open connection")
    }
}

impl DerefMut for NotesConnectionGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.connection
            .connection
            .as_mut()
            .expect("an active Notes connection guard must own an open connection")
    }
}

/// The cached connections and their per-key eviction epochs, kept behind a single
/// `Mutex`.
///
/// `connections` maps a vault to its live handle. `epochs` counts how many times
/// a key has been evicted; entries are bumped on every eviction and never
/// removed. [`open_and_cache`] snapshots a key's epoch under the lock *before*
/// opening the file and re-checks it under the lock *before* caching, so an
/// eviction that raced into the open window (e.g. a delete that unlinked the
/// file) is detected and the now-stale connection is not cached.
#[derive(Default)]
struct VaultRegistry {
    connections: HashMap<PathBuf, SharedNotesConnection>,
    entries: HashMap<PathBuf, Vec<Weak<NotesConnectionEntry>>>,
    epochs: HashMap<PathBuf, u64>,
    deleting: HashSet<PathBuf>,
    active_uses: HashMap<PathBuf, usize>,
}

impl VaultRegistry {
    fn epoch(&self, key: &Path) -> u64 {
        self.epochs.get(key).copied().unwrap_or(0)
    }

    fn bump_epoch(&mut self, key: PathBuf) {
        *self.epochs.entry(key).or_insert(0) += 1;
    }
}

struct NotesConnectionRegistry {
    state: Mutex<VaultRegistry>,
    idle: Condvar,
}

fn connection_registry() -> &'static NotesConnectionRegistry {
    static REGISTRY: OnceLock<NotesConnectionRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| NotesConnectionRegistry {
        state: Mutex::new(VaultRegistry::default()),
        idle: Condvar::new(),
    })
}

fn registry_lock() -> MutexGuard<'static, VaultRegistry> {
    // The registry only ever holds `Arc` clones, `PathBuf` keys, and epoch
    // counters, so recover a poisoned guard rather than propagating: a panic
    // elsewhere can never leave the maps themselves inconsistent.
    connection_registry()
        .state
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

struct ActiveNotesConnectionUse {
    key: PathBuf,
}

impl Drop for ActiveNotesConnectionUse {
    fn drop(&mut self) {
        let mut registry = registry_lock();
        let should_remove = match registry.active_uses.get_mut(&self.key) {
            Some(count) => {
                *count -= 1;
                *count == 0
            }
            None => false,
        };
        if should_remove {
            registry.active_uses.remove(&self.key);
            connection_registry().idle.notify_all();
        }
    }
}

fn begin_notes_connection_use(key: &Path) -> Result<ActiveNotesConnectionUse, String> {
    let mut registry = registry_lock();
    if registry.deleting.contains(key) && !maintenance_deletion_access_allows(key) {
        return Err("The Notes database is being deleted.".to_string());
    }
    *registry.active_uses.entry(key.to_path_buf()).or_insert(0) += 1;
    Ok(ActiveNotesConnectionUse {
        key: key.to_path_buf(),
    })
}

/// Returns the cached connection for `vault_path`, opening and fully
/// initializing it on first use. Subsequent calls return the same
/// [`SharedNotesConnection`] without touching the schema.
///
/// If the cached connection's `Mutex` has been poisoned (a panic happened while
/// its lock was held, i.e. the connection may be mid-transaction and unusable),
/// it is evicted and a fresh connection is opened once in its place.
///
/// The plan calls for evicting and reconnecting "on a rusqlite error indicating
/// an unusable connection." That is implemented here *only* as poisoned-`Mutex`
/// eviction: command results are stringified to `Result<_, String>`, so the
/// concrete `rusqlite::Error` variant is not available to classify at this
/// layer, and multi-statement writes already roll back via `Transaction`-on-drop
/// (so an ordinary query error leaves the connection reusable). Revisit if typed
/// errors are ever threaded through the command layer.
pub(crate) fn acquire_notes_connection(vault_path: &str) -> Result<SharedNotesConnection, String> {
    drop(acquire_vault_app_lock(vault_path)?);
    let key = notes_db_path(vault_path);
    {
        let mut registry = registry_lock();
        if let Some(existing) = registry.connections.get(&key) {
            if existing.is_poisoned() {
                registry.connections.remove(&key);
            } else {
                return Ok(Arc::clone(existing));
            }
        }
    }
    open_and_cache(vault_path, key)
}

/// Discards any cached connection and opens a fresh, fully-initialized one.
///
/// `notes_initialize` uses this so that (re)opening a vault always runs the
/// initialization pipeline exactly once, regardless of whether an earlier
/// command already populated the cache.
pub(crate) fn reinitialize_notes_connection(
    vault_path: &str,
) -> Result<SharedNotesConnection, String> {
    evict_notes_connection(vault_path);
    open_and_cache(vault_path, notes_db_path(vault_path))
}

/// Removes and closes the cached connection for a vault, if any.
///
/// Callers that delete the underlying database files must evict first so no open
/// handle survives the deletion (and so the next acquisition reconnects).
pub(crate) fn evict_notes_connection(vault_path: &str) {
    let key = notes_db_path(vault_path);
    let evicted = {
        let mut registry = registry_lock();
        // Bump the epoch even when nothing is currently cached: a reader may have
        // opened the file but not yet reached its registry insert (see
        // `open_and_cache`). The bump is how we tell that in-flight open its
        // connection is now stale and must not be cached.
        registry.bump_epoch(key.clone());
        registry.connections.remove(&key)
    };
    // Drop the `Arc` outside the registry lock. The connection (and its WAL/SHM
    // handles) closes here only if no in-flight command still holds a clone.
    drop(evicted);
}

pub(crate) struct NotesDatabaseDeletionGuard {
    key: PathBuf,
}

thread_local! {
    static MAINTENANCE_DELETION_KEYS: std::cell::RefCell<HashMap<PathBuf, usize>> =
        std::cell::RefCell::new(HashMap::new());
}

fn maintenance_deletion_access_allows(key: &Path) -> bool {
    MAINTENANCE_DELETION_KEYS.with(|keys| keys.borrow().get(key).copied().unwrap_or(0) > 0)
}

struct MaintenanceDeletionAccess {
    key: PathBuf,
}

impl Drop for MaintenanceDeletionAccess {
    fn drop(&mut self) {
        MAINTENANCE_DELETION_KEYS.with(|keys| {
            let mut keys = keys.borrow_mut();
            if let Some(count) = keys.get_mut(&self.key) {
                *count -= 1;
                if *count == 0 {
                    keys.remove(&self.key);
                }
            }
        });
    }
}

impl NotesDatabaseDeletionGuard {
    /// Grants only the deletion-owning thread registry admission while this
    /// guard stays active. Bootstrap therefore reuses the managed connection's
    /// identity and commit protections, while every other caller remains
    /// rejected as a concurrent Notes operation.
    pub(crate) fn with_maintenance_access<T>(
        &self,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        if !registry_lock().deleting.contains(&self.key) {
            return Err("The Notes maintenance guard is no longer active.".to_string());
        }
        MAINTENANCE_DELETION_KEYS.with(|keys| {
            *keys.borrow_mut().entry(self.key.clone()).or_insert(0) += 1;
        });
        let _access = MaintenanceDeletionAccess {
            key: self.key.clone(),
        };
        operation()
    }
}

impl Drop for NotesDatabaseDeletionGuard {
    fn drop(&mut self) {
        let mut registry = registry_lock();
        registry.deleting.remove(&self.key);
        connection_registry().idle.notify_all();
    }
}

/// Blocks new operations for one vault, waits for current connection guards and
/// opens to finish, then closes the cached SQLite handle before deletion starts.
pub(crate) fn begin_notes_database_deletion(
    vault_path: &str,
) -> Result<NotesDatabaseDeletionGuard, String> {
    let key = notes_db_path(vault_path);
    let registry = connection_registry();
    let mut state = registry
        .state
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if !state.deleting.insert(key.clone()) {
        return Err("The Notes database is already being deleted.".to_string());
    }
    let deletion_guard = NotesDatabaseDeletionGuard { key: key.clone() };
    state.bump_epoch(key.clone());
    state.connections.remove(&key);
    while state.active_uses.get(&key).copied().unwrap_or(0) > 0 {
        state = registry
            .idle
            .wait(state)
            .unwrap_or_else(PoisonError::into_inner);
    }
    let live_connections = state
        .entries
        .remove(&key)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| entry.upgrade())
        .collect::<Vec<_>>();
    drop(state);

    for shared in live_connections {
        let connection = shared
            .connection
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .connection
            .take();
        if let Some(connection) = connection {
            connection.close().map_err(|(_, error)| {
                format!("Could not close the Notes database before deletion: {error}")
            })?;
        }
    }

    Ok(deletion_guard)
}

/// Locks a shared connection for the duration of a database operation.
///
/// Recovers a poisoned guard so a prior panic does not cascade into every later
/// command; the poisoned entry is evicted and reconnected by the next
/// [`acquire_notes_connection`]. On Unix, validates the open SQLite file identity
/// after acquiring the mutex so a pathname replacement that happened while this
/// operation waited cannot redirect an acknowledged mutation into the moved set.
pub(crate) fn lock_notes_connection(
    shared: &SharedNotesConnection,
) -> Result<NotesConnectionGuard<'_>, String> {
    let active_use = begin_notes_connection_use(&shared.key)?;
    let mut connection = shared
        .connection
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if connection.connection.is_none() {
        return Err("The Notes database connection is closed.".to_string());
    }
    #[cfg(unix)]
    revalidate_notes_connection(shared, &mut connection)?;
    Ok(NotesConnectionGuard {
        shared,
        connection,
        _active_use: active_use,
    })
}

#[cfg(unix)]
fn revalidate_notes_connection(
    shared: &SharedNotesConnection,
    managed: &mut ManagedNotesConnection,
) -> Result<(), String> {
    let connection = managed
        .connection
        .as_ref()
        .ok_or_else(|| "The Notes database connection is closed.".to_string())?;
    let validation = notes_database_has_moved(connection).and_then(|moved| {
        if moved {
            Ok(true)
        } else {
            notes_wal_has_moved(connection).and_then(|moved| {
                if moved {
                    Ok(true)
                } else {
                    managed.identity.paths_have_changed()
                }
            })
        }
    });
    if matches!(validation, Ok(false)) {
        return Ok(());
    }

    let vault_path = managed
        .identity
        .database_path
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf);
    if let Some(vault_path) = vault_path.as_deref().and_then(Path::to_str) {
        match connect_notes_db(vault_path) {
            Ok(reopened) => match install_commit_identity_guard(&reopened) {
                Ok(identity) => {
                    managed.connection = Some(reopened);
                    managed.identity = identity;
                    return Ok(());
                }
                Err(error) => {
                    invalidate_notes_connection(connection);
                    evict_shared_notes_connection(shared);
                    return Err(format!(
                        "Could not bind the reopened Notes database to its pathname: {error}"
                    ));
                }
            },
            Err(error) => {
                invalidate_notes_connection(connection);
                evict_shared_notes_connection(shared);
                return Err(format!(
                    "Could not reopen the moved Notes database connection: {error}"
                ));
            }
        }
    }

    invalidate_notes_connection(connection);
    evict_shared_notes_connection(shared);
    Err("Could not resolve the vault for the moved Notes database connection.".to_string())
}

fn invalidate_notes_connection(connection: &Connection) {
    let _ = connection.commit_hook(Some(|| true));
    let _ = connection.pragma_update(None, "query_only", true);
}

pub(crate) fn validate_notes_connection(
    connection: &NotesConnectionGuard<'_>,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        let validation = notes_database_has_moved(connection).and_then(|moved| {
            if moved {
                Ok(true)
            } else {
                notes_wal_has_moved(connection).and_then(|moved| {
                    if moved {
                        Ok(true)
                    } else {
                        connection.connection.identity.paths_have_changed()
                    }
                })
            }
        });
        match validation {
            Ok(false) => {}
            Ok(true) => {
                let detail = describe_notes_database_swap(
                    &connection.connection.identity.database_path,
                    &connection.connection.identity.members[0].1,
                );
                invalidate_notes_connection(connection);
                evict_shared_notes_connection(connection.shared);
                return Err(format!(
                    "The Notes database identity changed during the database operation.{detail}"
                ));
            }
            Err(error) => {
                invalidate_notes_connection(connection);
                evict_shared_notes_connection(connection.shared);
                return Err(error);
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn evict_shared_notes_connection(shared: &SharedNotesConnection) {
    let evicted = {
        let mut registry = registry_lock();
        let matches = registry
            .connections
            .get(&shared.key)
            .is_some_and(|cached| Arc::ptr_eq(cached, shared));
        matches.then(|| {
            registry.bump_epoch(shared.key.clone());
            registry.connections.remove(&shared.key)
        })
    };
    drop(evicted);
}

#[cfg(unix)]
fn notes_database_has_moved(connection: &Connection) -> Result<bool, String> {
    let mut moved = 0;
    // SAFETY: the connection mutex is held, `main` is NUL-terminated, and
    // SQLITE_FCNTL_HAS_MOVED expects a valid pointer to an `int` output value.
    let result = unsafe {
        rusqlite::ffi::sqlite3_file_control(
            connection.handle(),
            b"main\0".as_ptr().cast(),
            rusqlite::ffi::SQLITE_FCNTL_HAS_MOVED,
            (&mut moved as *mut std::ffi::c_int).cast(),
        )
    };
    if result != rusqlite::ffi::SQLITE_OK {
        return Err(format!(
            "Could not validate the cached Notes database identity (SQLite code {result})."
        ));
    }
    Ok(moved != 0)
}

#[cfg(unix)]
fn notes_wal_has_moved(connection: &Connection) -> Result<bool, String> {
    let mut wal_file = std::ptr::null_mut::<rusqlite::ffi::sqlite3_file>();
    // SAFETY: the connection is exclusively owned or its manager mutex is held;
    // `main` is NUL-terminated, and JOURNAL_POINTER writes one sqlite3_file pointer.
    let result = unsafe {
        rusqlite::ffi::sqlite3_file_control(
            connection.handle(),
            b"main\0".as_ptr().cast(),
            rusqlite::ffi::SQLITE_FCNTL_JOURNAL_POINTER,
            (&mut wal_file as *mut *mut rusqlite::ffi::sqlite3_file).cast(),
        )
    };
    if result != rusqlite::ffi::SQLITE_OK {
        return Err(format!(
            "Could not resolve the active Notes WAL handle (SQLite code {result})."
        ));
    }
    let methods = unsafe { wal_file.as_ref() }
        .filter(|file| !file.pMethods.is_null())
        .and_then(|file| unsafe { file.pMethods.as_ref() })
        .ok_or_else(|| {
            "The active Notes connection does not expose a WAL VFS handle.".to_string()
        })?;
    let file_control = methods
        .xFileControl
        .ok_or_else(|| "The active Notes WAL VFS cannot validate file identity.".to_string())?;
    let mut moved = 0;
    // SAFETY: `wal_file` and its methods belong to this live SQLite connection,
    // and SQLITE_FCNTL_HAS_MOVED expects a valid pointer to an integer output.
    let result = unsafe {
        file_control(
            wal_file,
            rusqlite::ffi::SQLITE_FCNTL_HAS_MOVED,
            (&mut moved as *mut std::ffi::c_int).cast(),
        )
    };
    if result != rusqlite::ffi::SQLITE_OK {
        return Err(format!(
            "Could not validate the active Notes WAL identity (SQLite code {result})."
        ));
    }
    Ok(moved != 0)
}

#[cfg(unix)]
fn notes_binding_probe_value(connection: &Connection) -> Result<String, String> {
    connection
        .query_row(
            "SELECT vault_generation FROM notes_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not read the Notes connection binding probe: {error}"))
}

#[cfg(unix)]
fn write_notes_binding_probe_value(connection: &Connection, value: &str) -> Result<(), String> {
    let changed = connection
        .execute(
            "UPDATE notes_metadata SET vault_generation = ?1 WHERE id = 1",
            [value],
        )
        .map_err(|error| format!("Could not write the Notes connection binding probe: {error}"))?;
    if changed != 1 {
        return Err("Could not locate the Notes connection binding probe row.".to_string());
    }
    Ok(())
}

#[cfg(unix)]
fn establish_notes_database_set_binding(
    connection: &Connection,
    identity: &NotesDatabaseSetIdentity,
) -> Result<(), String> {
    let verifier =
        Connection::open_with_flags(&identity.database_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|error| {
                format!("Could not open the Notes database-set binding verifier: {error}")
            })?;
    verifier
        .busy_timeout(std::time::Duration::ZERO)
        .map_err(|error| format!("Could not configure the Notes binding verifier: {error}"))?;

    // A WAL writer lock lives in the shared-memory file. If both connections can
    // hold it, the candidate is mapped to a different -shm inode than pathname.
    let candidate_transaction =
        rusqlite::Transaction::new_unchecked(connection, TransactionBehavior::Immediate).map_err(
            |error| format!("Could not lock the active Notes shared-memory file: {error}"),
        )?;
    let verifier_lock = verifier.execute_batch("BEGIN IMMEDIATE");
    let shares_shm = match verifier_lock {
        Err(error)
            if matches!(
                error.sqlite_error_code(),
                Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
            ) =>
        {
            true
        }
        Err(error) => {
            candidate_transaction.rollback().map_err(|rollback_error| {
                format!(
                    "Could not release the Notes shared-memory binding probe after {error}: \
                     {rollback_error}"
                )
            })?;
            return Err(format!(
                "Could not verify the active Notes shared-memory file: {error}"
            ));
        }
        Ok(()) => {
            verifier.execute_batch("ROLLBACK").map_err(|error| {
                format!("Could not release the pathname Notes shared-memory probe: {error}")
            })?;
            false
        }
    };
    candidate_transaction.rollback().map_err(|error| {
        format!("Could not release the active Notes shared-memory binding probe: {error}")
    })?;
    if !shares_shm {
        return Err(format!(
            "The active Notes connection is not bound to the pathname shared-memory file.{}",
            describe_notes_database_swap(&identity.database_path, &identity.members[0].1)
        ));
    }

    // Unix SQLite does not expose the WAL descriptor, and its WAL unixFile has
    // no pInode for SQLITE_FCNTL_HAS_MOVED to compare. Commit a reversible,
    // JSON-equivalent marker and require the pathname connection to observe it.
    let original_value = notes_binding_probe_value(connection)?;
    if notes_binding_probe_value(&verifier)? != original_value {
        return Err(format!(
            "The active Notes connection and pathname database disagree before WAL validation.{}",
            describe_notes_database_swap(&identity.database_path, &identity.members[0].1)
        ));
    }
    let mut probe_value = original_value.clone();
    probe_value.push(' ');
    write_notes_binding_probe_value(connection, &probe_value)?;
    let observed_probe = notes_binding_probe_value(&verifier);
    let restore_result = write_notes_binding_probe_value(connection, &original_value);
    if let Err(error) = restore_result {
        return Err(format!(
            "Could not restore the Notes connection binding probe: {error}"
        ));
    }
    let observed_probe = observed_probe?;
    if observed_probe != probe_value || notes_binding_probe_value(&verifier)? != original_value {
        return Err(format!(
            "The active Notes connection is not bound to the pathname WAL file.{}",
            describe_notes_database_swap(&identity.database_path, &identity.members[0].1)
        ));
    }
    Ok(())
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct NotesDatabaseFileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(unix)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct NotesDatabaseSetIdentity {
    database_path: PathBuf,
    members: [(PathBuf, NotesDatabaseFileIdentity); 3],
}

#[cfg(unix)]
impl NotesDatabaseSetIdentity {
    fn paths_have_changed(&self) -> Result<bool, String> {
        for (path, expected) in &self.members {
            let metadata = fs::symlink_metadata(path).map_err(|error| {
                format!("Could not inspect the cached Notes database set: {error}")
            })?;
            if !metadata.file_type().is_file()
                || metadata.file_type().is_symlink()
                || notes_database_file_identity(&metadata) != *expected
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

#[cfg(unix)]
fn notes_database_file_identity(metadata: &fs::Metadata) -> NotesDatabaseFileIdentity {
    NotesDatabaseFileIdentity {
        device: CapMetadataExt::dev(metadata),
        inode: CapMetadataExt::ino(metadata),
    }
}

/// Best-effort forensic sentence appended to identity/binding errors so the user
/// sees *what* replaced the database, not just that something did. Compares the
/// pathname's current file against the connection's bound identity. Never fails:
/// a missing current file (or an unformattable time) degrades gracefully.
#[cfg(unix)]
fn describe_notes_database_swap(path: &Path, bound: &NotesDatabaseFileIdentity) -> String {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("the Notes database");
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => {
            return format!(
                " Swap detail: {file_name}'s current file is missing (bound file id {}).",
                bound.inode
            );
        }
    };
    let current = notes_database_file_identity(&metadata);
    let changed_at =
        local_hms_from_metadata(&metadata).unwrap_or_else(|| "an unknown time".to_string());
    format!(
        " Swap detail: {file_name} changed at {changed_at} ({} bytes, file id {}->{}).",
        metadata.len(),
        bound.inode,
        current.inode
    )
}

/// Formats a file's modification time as local `HH:MM:SS`. Uses an in-memory
/// SQLite connection so the OS timezone is applied (`localtime`) without adding a
/// date/time dependency — the whole codebase already times through SQLite.
#[cfg(unix)]
fn local_hms_from_metadata(metadata: &fs::Metadata) -> Option<String> {
    let epoch = i64::try_from(
        metadata
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs(),
    )
    .ok()?;
    let connection = Connection::open_in_memory().ok()?;
    connection
        .query_row(
            "SELECT strftime('%H:%M:%S', ?1, 'unixepoch', 'localtime')",
            [epoch],
            |row| row.get::<_, String>(0),
        )
        .ok()
}

#[cfg(unix)]
fn notes_database_set_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut path = database_path.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

#[cfg(unix)]
fn capture_notes_database_set_identity(
    connection: &Connection,
) -> Result<NotesDatabaseSetIdentity, String> {
    let database_path = connection
        .path()
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "Could not resolve the cached Notes database path.".to_string())?;
    if notes_database_has_moved(connection)? || notes_wal_has_moved(connection)? {
        return Err("The cached Notes database identity changed while opening.".to_string());
    }
    let paths = [
        database_path.clone(),
        notes_database_set_path(&database_path, "-wal"),
        notes_database_set_path(&database_path, "-shm"),
    ];
    let members = paths.map(|path| {
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("Could not inspect the cached Notes database set: {error}"))?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err("The cached Notes database set must contain regular files.".to_string());
        }
        Ok((path, notes_database_file_identity(&metadata)))
    });
    let [main, wal, shm] = members;
    let identity = NotesDatabaseSetIdentity {
        database_path,
        members: [main?, wal?, shm?],
    };
    establish_notes_database_set_binding(connection, &identity)?;
    if notes_database_has_moved(connection)?
        || notes_wal_has_moved(connection)?
        || identity.paths_have_changed()?
    {
        return Err(format!(
            "The cached Notes database set changed while opening.{}",
            describe_notes_database_swap(&identity.database_path, &identity.members[0].1)
        ));
    }
    Ok(identity)
}

#[cfg(test)]
thread_local! {
    static COMMIT_AFTER_IDENTITY_CHECK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn inject_commit_after_identity_check_once(action: impl FnOnce() + 'static) {
    COMMIT_AFTER_IDENTITY_CHECK.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

fn run_commit_after_identity_check_hook() {
    #[cfg(test)]
    if let Some(action) = COMMIT_AFTER_IDENTITY_CHECK.with(|slot| slot.borrow_mut().take()) {
        action();
    }
}

#[cfg(unix)]
fn install_commit_identity_guard(
    connection: &Connection,
) -> Result<NotesDatabaseSetIdentity, String> {
    let expected_identity = capture_notes_database_set_identity(connection)?;
    let commit_identity = expected_identity.clone();
    connection
        .commit_hook(Some(move || {
            let identity_changed = commit_identity.paths_have_changed().unwrap_or(true);
            if !identity_changed {
                run_commit_after_identity_check_hook();
            }
            identity_changed
        }))
        .map_err(|error| format!("Could not install the Notes commit identity guard: {error}"))?;
    Ok(expected_identity)
}

/// Process-wide table of held vault application locks, keyed by the vault's
/// `.yonalist` directory. Each entry owns an `flock`ed file handle whose lock is
/// released only when the handle is dropped; because entries are never removed,
/// the lock is held for the connection manager's (process) lifetime.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AppLockFileIdentity {
    device: u64,
    inode: u64,
}

fn app_lock_file_identity(metadata: &fs::Metadata) -> AppLockFileIdentity {
    AppLockFileIdentity {
        device: CapMetadataExt::dev(metadata),
        inode: CapMetadataExt::ino(metadata),
    }
}

fn app_lock_capability_identity(metadata: &cap_std::fs::Metadata) -> AppLockFileIdentity {
    AppLockFileIdentity {
        device: CapMetadataExt::dev(metadata),
        inode: CapMetadataExt::ino(metadata),
    }
}

struct HeldVaultAppLock {
    file: File,
    vault: Dir,
    vault_path: PathBuf,
    vault_identity: AppLockFileIdentity,
    metadata: Dir,
    metadata_path: PathBuf,
    metadata_identity: AppLockFileIdentity,
    lock_identity: AppLockFileIdentity,
}

impl HeldVaultAppLock {
    fn verify_at(&self, metadata_path: &Path) -> Result<(), String> {
        let vault_path = metadata_path
            .parent()
            .ok_or_else(|| "Could not resolve the Notes vault directory.".to_string())?;
        let vault_metadata = fs::symlink_metadata(vault_path).map_err(|error| {
            format!("The Notes vault application lock identity changed: {error}")
        })?;
        if !vault_metadata.file_type().is_dir() || vault_metadata.file_type().is_symlink() {
            return Err(
                "The Notes vault application lock identity changed with its vault directory."
                    .to_string(),
            );
        }
        let held_vault_metadata = self.vault.dir_metadata().map_err(|error| {
            format!("The Notes vault application lock identity changed: {error}")
        })?;
        if app_lock_file_identity(&vault_metadata) != self.vault_identity
            || app_lock_capability_identity(&held_vault_metadata) != self.vault_identity
        {
            return Err("The Notes vault application lock identity changed.".to_string());
        }
        let metadata = fs::symlink_metadata(metadata_path).map_err(|error| {
            format!("The Notes vault application lock identity changed: {error}")
        })?;
        if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
            return Err(
                "The Notes vault application lock identity changed with its metadata directory."
                    .to_string(),
            );
        }
        let lock_path = metadata_path.join(crate::notes::attachments::VAULT_APP_LOCK_NAME);
        let lock_metadata = fs::symlink_metadata(&lock_path).map_err(|error| {
            format!("The Notes vault application lock identity changed: {error}")
        })?;
        if !lock_metadata.file_type().is_file() || lock_metadata.file_type().is_symlink() {
            return Err("The Notes vault application lock identity changed.".to_string());
        }
        let held_metadata = self.file.metadata().map_err(|error| {
            format!("The Notes vault application lock identity changed: {error}")
        })?;
        let held_directory_metadata = self.metadata.dir_metadata().map_err(|error| {
            format!("The Notes vault application lock identity changed: {error}")
        })?;
        if app_lock_file_identity(&metadata) != self.metadata_identity
            || app_lock_capability_identity(&held_directory_metadata) != self.metadata_identity
            || app_lock_file_identity(&lock_metadata) != self.lock_identity
            || app_lock_file_identity(&held_metadata) != self.lock_identity
        {
            return Err("The Notes vault application lock identity changed.".to_string());
        }
        Ok(())
    }

    fn guard(&self) -> Result<VaultAppLockGuard, String> {
        Ok(VaultAppLockGuard {
            vault: self.vault.try_clone().map_err(|error| {
                format!("Could not clone the held Notes vault directory: {error}")
            })?,
            vault_path: self.vault_path.clone(),
            vault_identity: self.vault_identity,
            metadata: self.metadata.try_clone().map_err(|error| {
                format!("Could not clone the held Notes metadata directory: {error}")
            })?,
            metadata_path: self.metadata_path.clone(),
            metadata_identity: self.metadata_identity,
            lock_identity: self.lock_identity,
        })
    }
}

pub(crate) struct VaultAppLockGuard {
    vault: Dir,
    vault_path: PathBuf,
    vault_identity: AppLockFileIdentity,
    metadata: Dir,
    metadata_path: PathBuf,
    metadata_identity: AppLockFileIdentity,
    lock_identity: AppLockFileIdentity,
}

impl VaultAppLockGuard {
    pub(crate) fn try_clone_vault(&self) -> Result<Dir, String> {
        self.vault
            .try_clone()
            .map_err(|error| format!("Could not clone the held Notes vault directory: {error}"))
    }

    pub(crate) fn try_clone_metadata(&self) -> Result<Dir, String> {
        self.metadata
            .try_clone()
            .map_err(|error| format!("Could not clone the held Notes metadata directory: {error}"))
    }

    pub(crate) fn revalidate_metadata_path(&self) -> Result<(), String> {
        self.revalidate_vault_directory()?;
        self.revalidate_metadata_directory()
    }

    pub(crate) fn revalidate_vault_path(&self) -> Result<(), String> {
        self.revalidate_metadata_path()
    }

    fn revalidate_metadata_directory(&self) -> Result<(), String> {
        let path_metadata = fs::symlink_metadata(&self.metadata_path)
            .map_err(|error| format!("The Notes metadata directory identity changed: {error}"))?;
        if !path_metadata.file_type().is_dir() || path_metadata.file_type().is_symlink() {
            return Err("The Notes metadata directory identity changed.".to_string());
        }
        let held_metadata = self
            .metadata
            .dir_metadata()
            .map_err(|error| format!("The Notes metadata directory identity changed: {error}"))?;
        if app_lock_file_identity(&path_metadata) != self.metadata_identity
            || app_lock_capability_identity(&held_metadata) != self.metadata_identity
        {
            return Err("The Notes metadata directory identity changed.".to_string());
        }
        let lock_path = self
            .metadata_path
            .join(crate::notes::attachments::VAULT_APP_LOCK_NAME);
        let lock_metadata = fs::symlink_metadata(&lock_path).map_err(|error| {
            format!("The Notes vault application lock identity changed: {error}")
        })?;
        let held_lock_metadata = self
            .metadata
            .symlink_metadata(crate::notes::attachments::VAULT_APP_LOCK_NAME)
            .map_err(|error| {
                format!("The Notes vault application lock identity changed: {error}")
            })?;
        if !lock_metadata.file_type().is_file()
            || lock_metadata.file_type().is_symlink()
            || !held_lock_metadata.file_type().is_file()
            || held_lock_metadata.file_type().is_symlink()
            || app_lock_file_identity(&lock_metadata) != self.lock_identity
            || app_lock_capability_identity(&held_lock_metadata) != self.lock_identity
        {
            return Err("The Notes vault application lock identity changed.".to_string());
        }
        Ok(())
    }

    fn revalidate_vault_directory(&self) -> Result<(), String> {
        let path_metadata = fs::symlink_metadata(&self.vault_path)
            .map_err(|error| format!("The Notes vault directory identity changed: {error}"))?;
        if !path_metadata.file_type().is_dir() || path_metadata.file_type().is_symlink() {
            return Err("The Notes vault directory identity changed.".to_string());
        }
        let held_metadata = self
            .vault
            .dir_metadata()
            .map_err(|error| format!("The Notes vault directory identity changed: {error}"))?;
        if app_lock_file_identity(&path_metadata) != self.vault_identity
            || app_lock_capability_identity(&held_metadata) != self.vault_identity
        {
            return Err("The Notes vault directory identity changed.".to_string());
        }
        Ok(())
    }
}

fn app_lock_registry() -> &'static Mutex<HashMap<PathBuf, HeldVaultAppLock>> {
    static APP_LOCKS: OnceLock<Mutex<HashMap<PathBuf, HeldVaultAppLock>>> = OnceLock::new();
    APP_LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ensures this process holds the exclusive application lock for `vault_path`,
/// acquiring it on first use. Returns
/// [`VAULT_APP_LOCK_BUSY_MESSAGE`](crate::notes::attachments::VAULT_APP_LOCK_BUSY_MESSAGE)
/// when another OS-level instance already holds the vault, so `notes_initialize`
/// rejects a second window instead of letting its `clear_all_history` wipe this
/// instance's undo stack.
///
/// Reentrant within one process: the first acquisition caches the locked file
/// handle keyed by the vault's `.yonalist` directory, and every later call for
/// the same vault returns `Ok(())` without opening a second descriptor. That
/// reentrancy is essential — a same-process second `flock` on a fresh descriptor
/// contends with our own held lock, so single-process reopen paths (and the test
/// suite) must never re-lock. The registry `Mutex` is held across the check and
/// the lock acquisition so two threads racing the first open cannot both attempt
/// the (non-blocking) `flock`.
pub(crate) fn acquire_vault_app_lock(vault_path: &str) -> Result<VaultAppLockGuard, String> {
    acquire_vault_app_lock_inner(vault_path, false)?.ok_or_else(|| {
        "Could not create the Notes metadata directory for application locking.".to_string()
    })
}

pub(crate) fn try_acquire_existing_vault_app_lock(
    vault_path: &str,
) -> Result<Option<VaultAppLockGuard>, String> {
    acquire_vault_app_lock_inner(vault_path, true)
}

fn acquire_vault_app_lock_inner(
    vault_path: &str,
    existing_only: bool,
) -> Result<Option<VaultAppLockGuard>, String> {
    let key = crate::metadata_dir(vault_path);
    let mut locks = app_lock_registry()
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if let Some(held) = locks.get(&key) {
        held.verify_at(&key)?;
        return held.guard().map(Some);
    }
    let acquired = if existing_only {
        let Some(acquired) = acquire_existing_vault_app_lock_file(vault_path)? else {
            return Ok(None);
        };
        acquired
    } else {
        acquire_vault_app_lock_file(vault_path)?
    };
    let metadata = fs::symlink_metadata(&key).map_err(|error| {
        format!("Could not inspect the Notes vault application lock identity: {error}")
    })?;
    let vault_path = key
        .parent()
        .ok_or_else(|| "Could not resolve the Notes vault directory.".to_string())?
        .to_path_buf();
    let vault_metadata = fs::symlink_metadata(&vault_path).map_err(|error| {
        format!("Could not inspect the Notes vault application lock identity: {error}")
    })?;
    let held_vault_metadata = acquired.vault.dir_metadata().map_err(|error| {
        format!("Could not inspect the Notes vault application lock identity: {error}")
    })?;
    if !vault_metadata.file_type().is_dir()
        || vault_metadata.file_type().is_symlink()
        || app_lock_file_identity(&vault_metadata)
            != app_lock_capability_identity(&held_vault_metadata)
    {
        return Err(
            "The Notes vault directory identity changed during app-lock acquisition.".to_string(),
        );
    }
    let lock_metadata = acquired.file.metadata().map_err(|error| {
        format!("Could not inspect the Notes vault application lock identity: {error}")
    })?;
    let held = HeldVaultAppLock {
        vault_identity: app_lock_file_identity(&vault_metadata),
        vault: acquired.vault,
        vault_path,
        metadata_identity: app_lock_file_identity(&metadata),
        lock_identity: app_lock_file_identity(&lock_metadata),
        file: acquired.file,
        metadata: acquired.metadata,
        metadata_path: key.clone(),
    };
    held.verify_at(&key)?;
    let guard = held.guard()?;
    locks.insert(key, held);
    Ok(Some(guard))
}

// One-shot test hook fired inside `open_and_cache` *after* `connect_notes_db`
// opens the file but *before* the registry insert. Tests arm it to run a delete
// (unlink + evict) in that exact window, exercising the eviction-epoch guard
// that must refuse to cache a connection to the just-unlinked inode.
#[cfg(test)]
thread_local! {
    static OPEN_AND_CACHE_BEFORE_IDENTITY_GUARD: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static OPEN_AND_CACHE_AFTER_CONNECT: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn inject_open_and_cache_before_identity_guard_once(action: impl FnOnce() + 'static) {
    OPEN_AND_CACHE_BEFORE_IDENTITY_GUARD.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn run_open_and_cache_before_identity_guard_hook() {
    if let Some(action) = OPEN_AND_CACHE_BEFORE_IDENTITY_GUARD.with(|slot| slot.borrow_mut().take())
    {
        action();
    }
}

#[cfg(test)]
fn inject_open_and_cache_after_connect_once(action: impl FnOnce() + 'static) {
    OPEN_AND_CACHE_AFTER_CONNECT.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn run_open_and_cache_after_connect_hook() {
    if let Some(action) = OPEN_AND_CACHE_AFTER_CONNECT.with(|slot| slot.borrow_mut().take()) {
        action();
    }
}

fn open_and_cache(vault_path: &str, key: PathBuf) -> Result<SharedNotesConnection, String> {
    let _active_open = begin_notes_connection_use(&key)?;
    // Snapshot the key's eviction epoch under the registry lock BEFORE opening the
    // file. If an evict bumps it while we open (e.g. a delete unlinks the file
    // mid-open), the re-check below refuses to cache our now-stale connection.
    let epoch_at_open = registry_lock().epoch(&key);

    // Open and initialize without holding the registry lock so unrelated vaults
    // can be acquired concurrently without blocking the whole map.
    let connection = connect_notes_db(vault_path)?;
    #[cfg(test)]
    run_open_and_cache_before_identity_guard_hook();
    #[cfg(unix)]
    let identity = install_commit_identity_guard(&connection)?;
    #[cfg(test)]
    run_open_and_cache_after_connect_hook();
    let shared: SharedNotesConnection = Arc::new(NotesConnectionEntry {
        key: key.clone(),
        connection: Mutex::new(ManagedNotesConnection {
            connection: Some(connection),
            #[cfg(unix)]
            identity,
        }),
    });

    let mut registry = registry_lock();
    if registry.deleting.contains(&key) && !maintenance_deletion_access_allows(&key) {
        return Err("The Notes database is being deleted.".to_string());
    }
    let entries = registry.entries.entry(key.clone()).or_default();
    entries.retain(|entry| entry.strong_count() > 0);
    entries.push(Arc::downgrade(&shared));
    // A concurrent acquisition may have cached a healthy connection while we were
    // opening ours. Prefer the already-cached one so every caller shares a single
    // connection per vault; our redundant open is dropped (closed) on return.
    if let Some(existing) = registry.connections.get(&key) {
        if !existing.is_poisoned() {
            return Ok(Arc::clone(existing));
        }
    }
    if registry.epoch(&key) == epoch_at_open {
        registry.connections.insert(key, Arc::clone(&shared));
    }
    // If the epoch changed, an evict raced into our open window and the file we
    // opened may already be unlinked. Return the freshly opened connection WITHOUT
    // caching it: the caller uses it once and the next acquisition reconnects
    // against the current on-disk state, matching pre-manager in-flight semantics.
    Ok(shared)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::panic::AssertUnwindSafe;

    #[cfg(unix)]
    fn sqlite_set_paths(database_path: &Path) -> Vec<PathBuf> {
        ["", "-wal", "-shm"]
            .into_iter()
            .map(|suffix| {
                let mut path = database_path.as_os_str().to_os_string();
                path.push(suffix);
                PathBuf::from(path)
            })
            .collect()
    }

    #[cfg(unix)]
    fn replace_database_set(vault_path: &str, replacement_vault_path: &str) {
        let replacement = connect_notes_db(replacement_vault_path).expect("open replacement set");
        replacement
            .execute(
                "INSERT INTO notes_nodes (id, parent_id, sort_key, title, created_at, updated_at) \
                 VALUES ('replacement', NULL, 0, 'Replacement', '2026-07-15T00:00:00.000Z', \
                         '2026-07-15T00:00:00.000Z')",
                [],
            )
            .expect("seed replacement set");
        replacement
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .expect("checkpoint replacement set");
        drop(replacement);

        let live_database = notes_db_path(vault_path);
        let moved_directory = live_database
            .parent()
            .expect("live metadata directory")
            .join("moved-database-set");
        fs::create_dir(&moved_directory).expect("create moved-set directory");
        for path in sqlite_set_paths(&live_database) {
            assert!(path.exists(), "live SQLite set member must exist: {path:?}");
            let destination = moved_directory.join(path.file_name().expect("SQLite set file name"));
            fs::rename(path, destination).expect("move live SQLite set member aside");
        }

        let replacement_database = notes_db_path(replacement_vault_path);
        for source in sqlite_set_paths(&replacement_database) {
            if source.exists() {
                let suffix = source
                    .file_name()
                    .expect("replacement set file name")
                    .to_string_lossy()
                    .strip_prefix("notes.sqlite")
                    .expect("replacement set suffix")
                    .to_string();
                let mut destination = live_database.as_os_str().to_os_string();
                destination.push(suffix);
                fs::rename(source, PathBuf::from(destination))
                    .expect("install replacement SQLite set member");
            }
        }
    }

    #[cfg(unix)]
    fn replace_database_sidecars_in_place(vault_path: &str) {
        let database = notes_db_path(vault_path);
        let moved_directory = database
            .parent()
            .expect("live metadata directory")
            .join("moved-database-sidecars");
        fs::create_dir(&moved_directory).expect("create moved-sidecar directory");
        for path in sqlite_set_paths(&database).into_iter().skip(1) {
            assert!(path.exists(), "live SQLite sidecar must exist: {path:?}");
            let moved = moved_directory.join(path.file_name().expect("SQLite sidecar name"));
            fs::rename(&path, &moved).expect("move live SQLite sidecar aside");
            fs::copy(&moved, &path).expect("install copied SQLite sidecar");
        }
    }

    #[cfg(unix)]
    fn replace_database_with_invalid_file(vault_path: &str) {
        let database = notes_db_path(vault_path);
        let moved_directory = database
            .parent()
            .expect("live metadata directory")
            .join("moved-before-invalid-database");
        fs::create_dir(&moved_directory).expect("create invalid-database backup directory");
        for path in sqlite_set_paths(&database) {
            if path.exists() {
                let moved = moved_directory.join(path.file_name().expect("SQLite set file name"));
                fs::rename(path, moved).expect("move live SQLite set member aside");
            }
        }
        fs::write(database, b"not a SQLite database").expect("install invalid database file");
    }

    #[cfg(unix)]
    fn insert_identity_probe(shared: &SharedNotesConnection, id: &str) -> Result<usize, String> {
        let connection = lock_notes_connection(shared)?;
        connection
            .execute(
                "INSERT INTO notes_nodes (id, parent_id, sort_key, title, created_at, updated_at) \
             VALUES (?1, NULL, 1024, 'Identity probe', '2026-07-15T00:00:00.000Z', \
                     '2026-07-15T00:00:00.000Z')",
                [id],
            )
            .map_err(|error| error.to_string())
    }

    #[cfg(unix)]
    fn live_database_contains(vault_path: &str, id: &str) -> bool {
        let connection = Connection::open(notes_db_path(vault_path)).expect("open live database");
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes_nodes WHERE id = ?1)",
                [id],
                |row| row.get(0),
            )
            .expect("query live database")
    }

    #[cfg(unix)]
    fn assert_mutation_was_not_hidden(vault_path: &str, id: &str, result: Result<usize, String>) {
        if result.is_ok() {
            assert!(
                live_database_contains(vault_path, id),
                "an acknowledged mutation must be visible in the installed database"
            );
        }
    }

    fn temp_vault() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().to_string_lossy().into_owned();
        (dir, path)
    }

    fn schema_is_usable(shared: &SharedNotesConnection) {
        let connection = lock_notes_connection(shared).expect("lock schema connection");
        connection
            .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("fresh connection can query the notes schema");
    }

    #[test]
    fn sequential_acquisitions_share_one_connection() {
        let (_dir, vault_path) = temp_vault();
        let first = acquire_notes_connection(&vault_path).expect("first acquisition");
        let second = acquire_notes_connection(&vault_path).expect("second acquisition");
        assert!(
            Arc::ptr_eq(&first, &second),
            "the second acquisition must reuse the cached connection"
        );
    }

    #[test]
    fn delete_then_reinitialize_yields_a_fresh_working_connection() {
        let (_dir, vault_path) = temp_vault();
        let original = acquire_notes_connection(&vault_path).expect("initial acquisition");

        // Close the cached handle before removing files, mirroring
        // `notes_delete_database`.
        evict_notes_connection(&vault_path);
        crate::notes::repository::delete_database(&vault_path).expect("delete database files");

        let refreshed =
            reinitialize_notes_connection(&vault_path).expect("reinitialize after deletion");
        assert!(
            !Arc::ptr_eq(&original, &refreshed),
            "reinitialization must open a brand new connection"
        );
        schema_is_usable(&refreshed);
    }

    #[test]
    fn deletion_gate_closes_an_evicted_connection_still_held_by_a_caller() {
        let (_dir, vault_path) = temp_vault();
        let stale = acquire_notes_connection(&vault_path).expect("initial acquisition");
        evict_notes_connection(&vault_path);

        let deletion =
            begin_notes_database_deletion(&vault_path).expect("begin managed database deletion");
        drop(deletion);

        assert!(
            lock_notes_connection(&stale).is_err(),
            "deletion must close every live handle, including an already-evicted Arc"
        );
    }

    #[test]
    fn poisoned_connection_is_evicted_and_recreated() {
        let (_dir, vault_path) = temp_vault();
        let poisoned = acquire_notes_connection(&vault_path).expect("initial acquisition");

        // Simulate an unusable connection by poisoning its mutex: panic while
        // holding the lock. Silence the panic hook so the deliberate panic does
        // not pollute test output, then restore it.
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let poison_result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _guard = poisoned.connection.lock().expect("lock before poisoning");
            panic!("simulate an unusable notes connection");
        }));
        std::panic::set_hook(previous_hook);
        assert!(poison_result.is_err(), "the deliberate panic must unwind");
        assert!(
            poisoned.is_poisoned(),
            "the connection mutex should now be poisoned"
        );

        let refreshed = acquire_notes_connection(&vault_path).expect("reacquire after poisoning");
        assert!(
            !Arc::ptr_eq(&poisoned, &refreshed),
            "a poisoned connection must be evicted and replaced"
        );
        assert!(
            !refreshed.is_poisoned(),
            "the replacement connection must be healthy"
        );
        schema_is_usable(&refreshed);
    }

    #[cfg(unix)]
    #[test]
    fn cached_connection_mutation_targets_a_replaced_database_set() {
        let (_live_dir, vault_path) = temp_vault();
        let (_replacement_dir, replacement_vault_path) = temp_vault();
        let shared = acquire_notes_connection(&vault_path).expect("open cached connection");
        insert_identity_probe(&shared, "before-replacement").expect("seed live WAL");

        replace_database_set(&vault_path, &replacement_vault_path);

        let result = insert_identity_probe(&shared, "after-replacement");
        assert_mutation_was_not_hidden(&vault_path, "after-replacement", result);
        drop(shared);

        let refreshed = acquire_notes_connection(&vault_path).expect("reopen installed database");
        insert_identity_probe(&refreshed, "after-recovery")
            .expect("a later mutation must recover against the installed database");
        assert!(live_database_contains(&vault_path, "after-recovery"));
    }

    #[cfg(unix)]
    #[test]
    fn cached_connection_rejects_replaced_wal_and_shm_with_unchanged_main() {
        let (_dir, vault_path) = temp_vault();
        let shared = acquire_notes_connection(&vault_path).expect("open cached connection");
        insert_identity_probe(&shared, "before-sidecar-replacement").expect("seed live WAL");
        let main_identity = notes_database_file_identity(
            &fs::symlink_metadata(notes_db_path(&vault_path)).expect("inspect live main database"),
        );

        replace_database_sidecars_in_place(&vault_path);

        assert_eq!(
            notes_database_file_identity(
                &fs::symlink_metadata(notes_db_path(&vault_path))
                    .expect("inspect unchanged main database"),
            ),
            main_identity,
            "the reproduction must leave the main database inode unchanged"
        );
        let result = insert_identity_probe(&shared, "after-sidecar-replacement");
        assert_mutation_was_not_hidden(&vault_path, "after-sidecar-replacement", result);
    }

    #[cfg(unix)]
    #[test]
    fn identity_error_appends_swap_forensics() {
        let (_live_dir, vault_path) = temp_vault();
        let (_replacement_dir, replacement_vault_path) = temp_vault();
        let shared = acquire_notes_connection(&vault_path).expect("open cached connection");
        insert_identity_probe(&shared, "before-swap").expect("seed live WAL");
        let bound_inode = notes_database_file_identity(
            &fs::symlink_metadata(notes_db_path(&vault_path)).expect("inspect bound database"),
        )
        .inode;
        let connection = lock_notes_connection(&shared).expect("lock connection");

        replace_database_set(&vault_path, &replacement_vault_path);
        let installed_inode = notes_database_file_identity(
            &fs::symlink_metadata(notes_db_path(&vault_path)).expect("inspect installed database"),
        )
        .inode;

        let error =
            validate_notes_connection(&connection).expect_err("a swapped set must be reported");
        assert!(
            error.starts_with("The Notes database identity changed during the database operation."),
            "the leading identity sentence must survive byte-for-byte: {error}"
        );
        assert!(
            error.contains("Swap detail:"),
            "swap forensics must be appended: {error}"
        );
        assert_ne!(
            bound_inode, installed_inode,
            "the swap must change the inode"
        );
        assert!(
            error.contains(&format!("file id {bound_inode}->{installed_inode}")),
            "the inode change must be reported: {error}"
        );
        assert!(
            error.contains("changed at "),
            "the swap time must be reported: {error}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn identity_error_notes_a_missing_current_file() {
        let (_dir, vault_path) = temp_vault();
        let shared = acquire_notes_connection(&vault_path).expect("open cached connection");
        insert_identity_probe(&shared, "before-removal").expect("seed live WAL");
        let connection = lock_notes_connection(&shared).expect("lock connection");

        // Remove the whole set without installing a replacement so the pathname
        // has no current file to stat.
        for path in sqlite_set_paths(&notes_db_path(&vault_path)) {
            if path.exists() {
                fs::remove_file(path).expect("remove live SQLite set member");
            }
        }

        let error =
            validate_notes_connection(&connection).expect_err("a removed set must be reported");
        assert!(
            error.contains("Swap detail:"),
            "swap forensics must be appended: {error}"
        );
        assert!(
            error.contains("current file is missing"),
            "a missing current file must be described: {error}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn initial_connection_rejects_sidecars_replaced_before_identity_guard_installation() {
        let (_dir, vault_path) = temp_vault();
        drop(connect_notes_db(&vault_path).expect("seed Notes database"));
        let raced_vault_path = vault_path.clone();
        inject_open_and_cache_before_identity_guard_once(move || {
            replace_database_sidecars_in_place(&raced_vault_path);
        });

        let result = acquire_notes_connection(&vault_path);

        assert!(
            result.is_err(),
            "an initial connection must reject replaced active WAL/SHM handles"
        );
    }

    #[cfg(unix)]
    #[test]
    fn connection_revalidates_after_waiting_for_its_mutex() {
        let (_live_dir, vault_path) = temp_vault();
        let (_replacement_dir, replacement_vault_path) = temp_vault();
        let shared = acquire_notes_connection(&vault_path).expect("open cached connection");
        insert_identity_probe(&shared, "before-wait").expect("seed live WAL");
        let held_connection =
            lock_notes_connection(&shared).expect("hold managed connection mutex");
        let (waiting_sender, waiting_receiver) = std::sync::mpsc::channel();
        let (result_sender, result_receiver) = std::sync::mpsc::channel();

        std::thread::scope(|scope| {
            let worker_shared = Arc::clone(&shared);
            scope.spawn(move || {
                waiting_sender.send(()).expect("announce lock attempt");
                let result = insert_identity_probe(&worker_shared, "after-wait");
                result_sender.send(result).expect("send mutation result");
            });
            waiting_receiver.recv().expect("writer started waiting");

            replace_database_set(&vault_path, &replacement_vault_path);
            drop(held_connection);

            assert_mutation_was_not_hidden(
                &vault_path,
                "after-wait",
                result_receiver.recv().expect("receive mutation result"),
            );
        });
    }

    #[cfg(unix)]
    #[test]
    fn transaction_commit_rejects_replacement_after_lock_validation() {
        let (_live_dir, vault_path) = temp_vault();
        let (_replacement_dir, replacement_vault_path) = temp_vault();
        let shared = acquire_notes_connection(&vault_path).expect("open cached connection");
        insert_identity_probe(&shared, "before-commit-race").expect("seed live WAL");
        let mut connection = lock_notes_connection(&shared).expect("lock raced connection");

        replace_database_set(&vault_path, &replacement_vault_path);

        let transaction = connection.transaction().expect("start raced transaction");
        transaction
            .execute(
                "INSERT INTO notes_nodes (id, parent_id, sort_key, title, created_at, updated_at) \
                 VALUES ('commit-race', NULL, 1024, 'Commit race', \
                         '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z')",
                [],
            )
            .expect("write raced transaction");
        let commit_result = transaction.commit();

        assert!(
            commit_result.is_err(),
            "a transaction must not acknowledge a commit into the moved database set"
        );
        let hidden_row: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes_nodes WHERE id = 'commit-race')",
                [],
                |row| row.get(0),
            )
            .expect("inspect moved database after rollback");
        assert!(!hidden_row, "the rejected transaction must be rolled back");
        assert!(
            !live_database_contains(&vault_path, "commit-race"),
            "the rejected transaction must not alter the installed database"
        );
    }

    #[cfg(unix)]
    #[test]
    fn transaction_commit_does_not_acknowledge_replacement_after_commit_hook_check() {
        let (_live_dir, vault_path) = temp_vault();
        let (_replacement_dir, replacement_vault_path) = temp_vault();
        let shared = acquire_notes_connection(&vault_path).expect("open cached connection");
        insert_identity_probe(&shared, "before-post-hook-race").expect("seed live WAL");
        let mut connection = lock_notes_connection(&shared).expect("lock raced connection");
        let transaction = connection.transaction().expect("start raced transaction");
        transaction
            .execute(
                "INSERT INTO notes_nodes (id, parent_id, sort_key, title, created_at, updated_at) \
                 VALUES ('post-hook-race', NULL, 1024, 'Post-hook race', \
                         '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z')",
                [],
            )
            .expect("write raced transaction");
        let raced_vault_path = vault_path.clone();
        inject_commit_after_identity_check_once(move || {
            replace_database_set(&raced_vault_path, &replacement_vault_path);
        });

        let commit_result = transaction
            .commit()
            .map_err(|error| error.to_string())
            .and_then(|()| validate_notes_connection(&connection).map(|()| 1));

        assert_mutation_was_not_hidden(&vault_path, "post-hook-race", commit_result);
    }

    #[cfg(unix)]
    #[test]
    fn mutation_wrapper_rejects_a_commit_hidden_after_the_commit_hook_check() {
        let (_live_dir, vault_path) = temp_vault();
        let (_replacement_dir, replacement_vault_path) = temp_vault();
        drop(acquire_notes_connection(&vault_path).expect("open cached connection"));
        let raced_vault_path = vault_path.clone();
        inject_commit_after_identity_check_once(move || {
            replace_database_set(&raced_vault_path, &replacement_vault_path);
        });

        let result =
            crate::notes::commands::notes_create_node_with_optional_history_context_for_test(
                vault_path.clone(),
                crate::notes::types::CreateNodeInput {
                    marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
                    parent_id: None,
                    after_id: None,
                    title: "Post-commit validation".to_string(),
                    note: String::new(),
                },
                None,
            );

        assert!(
            result.is_err(),
            "a command must not acknowledge a mutation hidden from the installed database"
        );
        assert!(!live_database_contains(
            &vault_path,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn failed_reopen_does_not_return_a_stale_read_connection() {
        let (_dir, vault_path) = temp_vault();
        let shared = acquire_notes_connection(&vault_path).expect("open cached connection");
        insert_identity_probe(&shared, "stale-read-probe").expect("seed stale row");
        replace_database_with_invalid_file(&vault_path);

        let result = lock_notes_connection(&shared);
        assert!(
            result.is_err(),
            "a failed pathname reopen must be returned to the caller"
        );
    }

    #[test]
    fn delete_racing_into_the_open_window_is_not_cached() {
        let (_dir, vault_path) = temp_vault();

        // Seed the vault so its file and schema exist on disk, then drop our handle
        // (the registry keeps its own cached clone).
        drop(acquire_notes_connection(&vault_path).expect("seed acquisition"));

        // A delete begins by evicting the cache before it unlinks the file (the
        // pre-delete evict).
        evict_notes_connection(&vault_path);

        // Arm the hook so that, while the raced reader below is inside
        // `open_and_cache` — file opened, registry insert not yet reached — the
        // delete completes: it unlinks the file and evicts again (the post-delete
        // evict). This is the wider window the pre-delete evict alone cannot close.
        let hook_path = vault_path.clone();
        inject_open_and_cache_after_connect_once(move || {
            crate::notes::repository::delete_database(&hook_path)
                .expect("delete database inside the open window");
            evict_notes_connection(&hook_path);
        });

        // The raced reader opens the soon-to-be-unlinked file. The eviction-epoch
        // guard must refuse to cache its connection.
        let raced = acquire_notes_connection(&vault_path).expect("raced acquisition");

        // The delete unlinked the file and the raced connection was not cached, so
        // nothing has recreated it yet.
        assert!(
            !notes_db_path(&vault_path).exists(),
            "the delete must have unlinked the database file"
        );

        // A later acquisition must reconnect against the current on-disk state
        // rather than hand back the stale connection to the unlinked inode. This
        // assertion fails if the epoch guard is removed (the raced connection stays
        // cached and is handed straight back).
        let reacquired = acquire_notes_connection(&vault_path).expect("post-delete acquisition");
        assert!(
            !Arc::ptr_eq(&raced, &reacquired),
            "the connection opened against the unlinked inode must not be cached"
        );

        // A write through the fresh connection must land in a real on-disk file and
        // be readable through yet another acquisition — proving the fresh
        // connection is bound to the live database, not the unlinked inode. (File
        // existence alone is insufficient: reconnecting recreates the file.)
        {
            let connection =
                lock_notes_connection(&reacquired).expect("lock reconnected connection");
            connection
                .execute(
                    "INSERT INTO notes_nodes (id, parent_id, sort_key, title, created_at, updated_at) \
                     VALUES ('reborn', NULL, 0, 'Reborn', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z')",
                    [],
                )
                .expect("write through the reconnected connection");
        }
        assert!(
            notes_db_path(&vault_path).exists(),
            "the write must land in a real on-disk database file"
        );

        let verification = acquire_notes_connection(&vault_path).expect("verification acquisition");
        let connection =
            lock_notes_connection(&verification).expect("lock verification connection");
        let title: String = connection
            .query_row(
                "SELECT title FROM notes_nodes WHERE id = 'reborn'",
                [],
                |row| row.get(0),
            )
            .expect("the written row must be readable through a fresh acquisition");
        assert_eq!(title, "Reborn", "the written row must persist to disk");
    }
}
