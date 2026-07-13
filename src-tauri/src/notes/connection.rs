//! Process-wide manager that keeps a single SQLite connection open per vault.
//!
//! Every Notes command used to call [`connect_notes_db`], which re-ran the full
//! initialization pipeline (header preflight, WAL pragma, and an `IMMEDIATE`
//! write transaction that re-checks the schema) on *every* invocation — even for
//! read-only search keystrokes. This module caches one
//! `Arc<Mutex<Connection>>` per vault so that expensive pipeline runs exactly
//! once, on the first acquisition, and later acquisitions hand back the cached
//! connection with no schema or migration work.
//!
//! The manager is a module-level `OnceLock` rather than Tauri managed
//! [`State`](tauri::State) on purpose: the command bodies stay plain functions
//! (no signature churn) and the synchronous `_inner` functions remain directly
//! callable from tests. Commands run inside `spawn_blocking` (see task 1.1), and
//! the per-connection `Mutex` serializes database access per vault; callers must
//! hold that lock only around the actual database work.

use crate::notes::attachments::acquire_vault_app_lock_file;
use crate::notes::repository::{connect_notes_db, notes_db_path};
use rusqlite::Connection;
use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

/// A vault's SQLite connection, shared across commands and guarded by a `Mutex`
/// that serializes database access for that vault.
pub(crate) type SharedNotesConnection = Arc<Mutex<Connection>>;

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
    epochs: HashMap<PathBuf, u64>,
}

impl VaultRegistry {
    fn epoch(&self, key: &Path) -> u64 {
        self.epochs.get(key).copied().unwrap_or(0)
    }

    fn bump_epoch(&mut self, key: PathBuf) {
        *self.epochs.entry(key).or_insert(0) += 1;
    }
}

fn connection_registry() -> &'static Mutex<VaultRegistry> {
    static REGISTRY: OnceLock<Mutex<VaultRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(VaultRegistry::default()))
}

fn registry_lock() -> MutexGuard<'static, VaultRegistry> {
    // The registry only ever holds `Arc` clones, `PathBuf` keys, and epoch
    // counters, so recover a poisoned guard rather than propagating: a panic
    // elsewhere can never leave the maps themselves inconsistent.
    connection_registry()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
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
/// schema/migration pipeline exactly once, regardless of whether an earlier
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

/// Locks a shared connection for the duration of a database operation.
///
/// Recovers a poisoned guard so a prior panic does not cascade into every later
/// command; the poisoned entry is evicted and reconnected by the next
/// [`acquire_notes_connection`].
pub(crate) fn lock_notes_connection(shared: &SharedNotesConnection) -> MutexGuard<'_, Connection> {
    shared.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Process-wide table of held vault application locks, keyed by the vault's
/// `.yonalist` directory. Each entry owns an `flock`ed file handle whose lock is
/// released only when the handle is dropped; because entries are never removed,
/// the lock is held for the connection manager's (process) lifetime.
fn app_lock_registry() -> &'static Mutex<HashMap<PathBuf, File>> {
    static APP_LOCKS: OnceLock<Mutex<HashMap<PathBuf, File>>> = OnceLock::new();
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
pub(crate) fn acquire_vault_app_lock(vault_path: &str) -> Result<(), String> {
    let key = crate::metadata_dir(vault_path);
    let mut locks = app_lock_registry()
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if locks.contains_key(&key) {
        return Ok(());
    }
    let lock_file = acquire_vault_app_lock_file(vault_path)?;
    locks.insert(key, lock_file);
    Ok(())
}

// One-shot test hook fired inside `open_and_cache` *after* `connect_notes_db`
// opens the file but *before* the registry insert. Tests arm it to run a delete
// (unlink + evict) in that exact window, exercising the eviction-epoch guard
// that must refuse to cache a connection to the just-unlinked inode.
#[cfg(test)]
thread_local! {
    static OPEN_AND_CACHE_AFTER_CONNECT: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
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
    // Snapshot the key's eviction epoch under the registry lock BEFORE opening the
    // file. If an evict bumps it while we open (e.g. a delete unlinks the file
    // mid-open), the re-check below refuses to cache our now-stale connection.
    let epoch_at_open = registry_lock().epoch(&key);

    // Open + migrate without holding the registry lock so unrelated vaults can be
    // acquired concurrently and a slow migration never blocks the whole map.
    let connection = connect_notes_db(vault_path)?;
    #[cfg(test)]
    run_open_and_cache_after_connect_hook();
    let shared: SharedNotesConnection = Arc::new(Mutex::new(connection));

    let mut registry = registry_lock();
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

    fn temp_vault() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().to_string_lossy().into_owned();
        (dir, path)
    }

    fn schema_is_usable(shared: &SharedNotesConnection) {
        let connection = lock_notes_connection(shared);
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
    fn poisoned_connection_is_evicted_and_recreated() {
        let (_dir, vault_path) = temp_vault();
        let poisoned = acquire_notes_connection(&vault_path).expect("initial acquisition");

        // Simulate an unusable connection by poisoning its mutex: panic while
        // holding the lock. Silence the panic hook so the deliberate panic does
        // not pollute test output, then restore it.
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let poison_result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _guard = poisoned.lock().expect("lock before poisoning");
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
            let connection = lock_notes_connection(&reacquired);
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
        let connection = lock_notes_connection(&verification);
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
