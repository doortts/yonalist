use crate::file_io::{hold_regular_file_bounded_nofollow, read_regular_file_bounded_nofollow};
use crate::notes::connection::{acquire_notes_connection, lock_notes_connection};
use crate::notes::markdown_import::MAX_MARKDOWN_BYTES;
use crate::notes::sync::bootstrap::{
    cleanup_staging_path, clear_virtual_quarantine, reconcile_file_bytes,
    reconcile_staged_file_bytes, record_quarantine, BootstrapReport,
};
use crate::notes::sync::exporter::{sha256_hex, TRASH_FILE_NAME, TRASH_TOPIC_ID};
use rusqlite::OptionalExtension;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const WATCH_COALESCE_DELAY: Duration = Duration::from_millis(500);
const WATCH_SCAN_INTERVAL: Duration = Duration::from_secs(60);
const WATCHER_LOOP_TICK: Duration = Duration::from_millis(50);

// R7 test seam: force the watcher loop of one specific (canonicalized) vault to
// panic once. Keyed by path so parallel tests never trip each other's runtimes.
#[cfg(test)]
static WATCHER_PANIC_VAULT: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[cfg(test)]
pub(crate) fn arm_watcher_panic(vault_root: &Path) {
    *WATCHER_PANIC_VAULT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some(vault_root.to_string_lossy().into_owned());
}

#[cfg(test)]
fn maybe_panic_watcher_loop(vault_root: &Path) {
    let mut guard = WATCHER_PANIC_VAULT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if guard.as_deref() == Some(vault_root.to_string_lossy().as_ref()) {
        *guard = None;
        panic!("injected Notes watcher panic for test");
    }
}

#[cfg(not(test))]
fn maybe_panic_watcher_loop(_vault_root: &Path) {}

#[cfg(test)]
thread_local! {
    static INJECT_AFTER_STAGED_READ: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static INJECT_AFTER_EQUAL_RECOVERY_MATCH: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn inject_after_staged_read_once(action: impl FnOnce() + 'static) {
    INJECT_AFTER_STAGED_READ.with(|hook| *hook.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn maybe_inject_after_staged_read() {
    INJECT_AFTER_STAGED_READ.with(|hook| {
        if let Some(action) = hook.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_after_staged_read() {}

#[cfg(test)]
fn inject_after_equal_recovery_match_once(action: impl FnOnce() + 'static) {
    INJECT_AFTER_EQUAL_RECOVERY_MATCH.with(|hook| *hook.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn maybe_inject_after_equal_recovery_match() {
    INJECT_AFTER_EQUAL_RECOVERY_MATCH.with(|hook| {
        if let Some(action) = hook.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_after_equal_recovery_match() {}

#[derive(Debug, Default)]
pub(crate) struct WatchSchedule {
    pending: BTreeSet<PathBuf>,
    last_event_at: Option<Duration>,
}

impl WatchSchedule {
    pub(crate) fn push(&mut self, path: PathBuf, now: Duration) {
        self.pending.insert(path);
        self.last_event_at = Some(now);
    }

    pub(crate) fn take_due(&mut self, now: Duration) -> Vec<PathBuf> {
        if !self
            .last_event_at
            .is_some_and(|last| now.saturating_sub(last) >= WATCH_COALESCE_DELAY)
        {
            return Vec::new();
        }
        self.last_event_at = None;
        std::mem::take(&mut self.pending).into_iter().collect()
    }

    fn take_all(&mut self) -> Vec<PathBuf> {
        self.last_event_at = None;
        std::mem::take(&mut self.pending).into_iter().collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileStamp {
    modified: Option<std::time::SystemTime>,
    hash: String,
}

#[derive(Debug)]
pub(crate) struct PeriodicScan {
    files: std::collections::BTreeMap<PathBuf, FileStamp>,
    retry_paths: BTreeSet<PathBuf>,
    pending_stamps: std::collections::BTreeMap<PathBuf, FileStamp>,
    next_scan_at: Duration,
}

impl PeriodicScan {
    pub(crate) fn new(vault_root: &Path, now: Duration) -> Result<Self, String> {
        let snapshot = scan_root_markdown(vault_root)?;
        Ok(Self {
            files: snapshot.files,
            retry_paths: snapshot.retry_paths,
            pending_stamps: std::collections::BTreeMap::new(),
            next_scan_at: now + WATCH_SCAN_INTERVAL,
        })
    }

    /// B5: closes the startup watch gap. Dropping the baseline and making the
    /// next scan due now forces the first tick to reconcile every current file,
    /// so an external edit that landed during the startup reconcile — which a
    /// post-reconcile baseline would have silently absorbed — is still merged.
    /// notify is already registered before this, so ongoing edits are covered
    /// too. Unchanged files echo-skip cheaply.
    pub(crate) fn arm_immediate_full_scan(&mut self) {
        self.files.clear();
        self.pending_stamps.clear();
        self.retry_paths.clear();
        self.next_scan_at = Duration::ZERO;
    }

    pub(crate) fn take_due(
        &mut self,
        vault_root: &Path,
        now: Duration,
    ) -> Result<Vec<PathBuf>, String> {
        if now < self.next_scan_at {
            return Ok(Vec::new());
        }
        self.next_scan_at = now + WATCH_SCAN_INTERVAL;
        let current = scan_root_markdown(vault_root)?;
        let mut changed = current
            .iter()
            .filter_map(|(path, stamp)| (self.files.get(path) != Some(stamp)).then(|| path.clone()))
            .collect::<BTreeSet<_>>();
        changed.extend(current.retry_paths.iter().cloned());
        changed.extend(self.retry_paths.iter().cloned());
        // B3: a file in the baseline but gone now was deleted outside the app.
        // Surface it once so the processor can recreate a still-live topic; the
        // retain below then drops it from the baseline.
        for path in self.files.keys() {
            if !current.files.contains_key(path) && !current.retry_paths.contains(path) {
                changed.insert(path.clone());
            }
        }
        self.files.retain(|path, _| {
            current.files.contains_key(path) || current.retry_paths.contains(path)
        });
        self.retry_paths.extend(current.retry_paths);
        for path in &changed {
            if let Some(stamp) = current.files.get(path) {
                self.pending_stamps.insert(path.clone(), stamp.clone());
            }
        }
        Ok(changed.into_iter().collect())
    }

    pub(crate) fn acknowledge(&mut self, paths: &[PathBuf], retry_paths: &[PathBuf]) {
        let retry_paths = retry_paths.iter().collect::<BTreeSet<_>>();
        for path in paths {
            if retry_paths.contains(path) {
                self.retry_paths.insert(path.clone());
                self.pending_stamps.remove(path);
                continue;
            }
            self.retry_paths.remove(path);
            if let Some(stamp) = self.pending_stamps.remove(path) {
                self.files.insert(path.clone(), stamp);
            }
        }
    }
}

#[derive(Debug, Default)]
struct ScanSnapshot {
    files: std::collections::BTreeMap<PathBuf, FileStamp>,
    retry_paths: BTreeSet<PathBuf>,
}

impl ScanSnapshot {
    fn iter(&self) -> impl Iterator<Item = (&PathBuf, &FileStamp)> {
        self.files.iter()
    }
}

fn scan_root_markdown(vault_root: &Path) -> Result<ScanSnapshot, String> {
    let entries = fs::read_dir(vault_root)
        .map_err(|error| format!("Could not scan watched Notes files: {error}"))?;
    let mut snapshot = ScanSnapshot::default();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not inspect watched Notes file: {error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect watched Notes file type: {error}"))?;
        if !file_type.is_file()
            || path.extension().and_then(|extension| extension.to_str()) != Some("md")
        {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                snapshot.retry_paths.insert(path);
                continue;
            }
        };
        let bytes = match read_regular_file_bounded_nofollow(&path, MAX_MARKDOWN_BYTES) {
            Ok(bytes) => bytes,
            Err(_) => {
                snapshot.retry_paths.insert(path);
                continue;
            }
        };
        snapshot.files.insert(
            path,
            FileStamp {
                modified: metadata.modified().ok(),
                hash: sha256_hex(&bytes),
            },
        );
    }
    Ok(snapshot)
}

enum WatcherMessage {
    Filesystem(notify::Result<notify::Event>),
    Stop(mpsc::Sender<()>),
}

pub(crate) struct WatcherRuntime {
    control: mpsc::Sender<WatcherMessage>,
    worker: Option<JoinHandle<()>>,
}

impl WatcherRuntime {
    pub(crate) fn spawn(
        vault_root: PathBuf,
        initial_paths: Vec<PathBuf>,
        handler: Arc<dyn Fn(Vec<PathBuf>) -> Vec<PathBuf> + Send + Sync>,
        on_panic: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<Self, String> {
        let (control, receiver) = mpsc::channel();
        let event_sender = control.clone();
        let (started, startup) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("notes-sync-watcher".to_string())
            .spawn(move || {
                // R7: a panic in the watcher loop itself (not just a batch
                // handler) used to kill the thread silently. Catch it, report it
                // for visibility, and let is_healthy drive a restart.
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    watcher_loop(
                        vault_root,
                        initial_paths,
                        receiver,
                        event_sender,
                        handler,
                        started,
                    )
                }));
                if let Err(panic) = outcome {
                    on_panic(format!(
                        "Notes watcher thread panicked: {}",
                        describe_watcher_panic(&panic)
                    ));
                }
            })
            .map_err(|error| format!("Could not start the Notes watcher thread: {error}"))?;
        match startup.recv() {
            Ok(Ok(())) => Ok(Self {
                control,
                worker: Some(worker),
            }),
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(error)
            }
            Err(_) => {
                let _ = worker.join();
                Err("The Notes watcher stopped during startup.".to_string())
            }
        }
    }

    pub(crate) fn stop(&mut self) -> Result<(), String> {
        if self.worker.is_none() {
            return Ok(());
        }
        let (reply, response) = mpsc::channel();
        self.control
            .send(WatcherMessage::Stop(reply))
            .map_err(|_| "The Notes watcher is not running.".to_string())?;
        response
            .recv()
            .map_err(|_| "The Notes watcher stopped before cleanup completed.".to_string())?;
        if let Some(worker) = self.worker.take() {
            worker
                .join()
                .map_err(|_| "The Notes watcher thread panicked.".to_string())?;
        }
        Ok(())
    }

    pub(crate) fn is_running(&self) -> bool {
        self.worker.is_some()
    }

    /// R7: the watcher thread only ends on Stop, so a finished handle while the
    /// runtime is still live means the loop panicked — report it unhealthy so
    /// notes_sync_start restarts it.
    pub(crate) fn is_healthy(&self) -> bool {
        self.worker
            .as_ref()
            .is_some_and(|worker| !worker.is_finished())
    }
}

fn describe_watcher_panic(panic: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = panic.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = panic.downcast_ref::<String>() {
        message.clone()
    } else {
        "unknown panic".to_string()
    }
}

impl Drop for WatcherRuntime {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn watcher_loop(
    vault_root: PathBuf,
    initial_paths: Vec<PathBuf>,
    receiver: mpsc::Receiver<WatcherMessage>,
    event_sender: mpsc::Sender<WatcherMessage>,
    handler: Arc<dyn Fn(Vec<PathBuf>) -> Vec<PathBuf> + Send + Sync>,
    started: mpsc::Sender<Result<(), String>>,
) {
    use notify::Watcher;

    let sync_root = vault_root.join(".yonalist");
    let asset_root = sync_root.join("notes-assets");
    if let Err(error) = ensure_watch_directory(&sync_root, "Notes sync directory")
        .and_then(|_| ensure_watch_directory(&asset_root, "Notes asset directory"))
    {
        let _ = started.send(Err(error));
        return;
    }
    let vault_root = match fs::canonicalize(&vault_root) {
        Ok(vault_root) => vault_root,
        Err(error) => {
            let _ = started.send(Err(format!(
                "Could not resolve the watched Notes vault: {error}"
            )));
            return;
        }
    };
    let asset_root = vault_root.join(".yonalist/notes-assets");
    let mut watcher = match notify::recommended_watcher(move |event| {
        let _ = event_sender.send(WatcherMessage::Filesystem(event));
    }) {
        Ok(watcher) => watcher,
        Err(error) => {
            let _ = started.send(Err(format!("Could not create the Notes watcher: {error}")));
            return;
        }
    };
    if let Err(error) = watcher.watch(&vault_root, notify::RecursiveMode::NonRecursive) {
        let _ = started.send(Err(format!("Could not watch the Notes vault: {error}")));
        return;
    }
    if let Err(error) = watcher.watch(&asset_root, notify::RecursiveMode::NonRecursive) {
        let _ = started.send(Err(format!("Could not watch Notes assets: {error}")));
        return;
    }
    let began = Instant::now();
    let mut schedule = WatchSchedule::default();
    for path in initial_paths {
        schedule.push(path, Duration::ZERO);
    }
    let mut scan = match PeriodicScan::new(&vault_root, Duration::ZERO) {
        Ok(scan) => scan,
        Err(error) => {
            let _ = started.send(Err(error));
            return;
        }
    };
    // B5: notify is registered above; now force the first scan to reconcile
    // every file so nothing changed during the startup reconcile is lost.
    scan.arm_immediate_full_scan();
    if started.send(Ok(())).is_err() {
        return;
    }

    loop {
        maybe_panic_watcher_loop(&vault_root);
        match receiver.recv_timeout(WATCHER_LOOP_TICK) {
            Ok(WatcherMessage::Filesystem(Ok(event))) => {
                for path in relevant_event_paths(&event, &vault_root, &asset_root) {
                    schedule.push(path, began.elapsed());
                }
            }
            Ok(WatcherMessage::Filesystem(Err(error))) => {
                eprintln!("Notes watcher notification failed: {error}");
            }
            Ok(WatcherMessage::Stop(reply)) => {
                let pending = schedule.take_all();
                if !pending.is_empty() {
                    let _ = handler(pending);
                }
                let _ = reply.send(());
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        let now = began.elapsed();
        let mut due = schedule.take_due(now).into_iter().collect::<BTreeSet<_>>();
        match scan.take_due(&vault_root, now) {
            Ok(paths) => due.extend(paths),
            Err(error) => eprintln!("Notes watcher scan failed and will retry: {error}"),
        }
        if !due.is_empty() {
            let paths = due.into_iter().collect::<Vec<_>>();
            let retry_paths = handler(paths.clone());
            scan.acknowledge(&paths, &retry_paths);
        }
    }
}

fn ensure_watch_directory(path: &Path, label: &str) -> Result<(), String> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(format!("Could not create the {label}: {error}")),
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not validate the {label}: {error}"))?;
    if !metadata.file_type().is_dir() {
        return Err(format!("The {label} must be a real directory."));
    }
    Ok(())
}

fn relevant_event_paths(
    event: &notify::Event,
    vault_root: &Path,
    asset_root: &Path,
) -> Vec<PathBuf> {
    // B3: Remove is a first-class markdown event now — a topic file vanishing
    // from disk must reach the processor so a still-live topic gets recreated
    // (absence != delete). Assets still only react to creation.
    let markdown_change = matches!(
        event.kind,
        notify::EventKind::Create(_) | notify::EventKind::Modify(_) | notify::EventKind::Remove(_)
    );
    let asset_creation = matches!(event.kind, notify::EventKind::Create(_));
    event
        .paths
        .iter()
        .filter(|path| {
            (markdown_change
                && path.parent() == Some(vault_root)
                && path.extension().and_then(|extension| extension.to_str()) == Some("md"))
                || (asset_creation && path.parent() == Some(asset_root))
        })
        .cloned()
        .collect()
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct WatchBatchOutcome {
    pub(crate) changed_topic_ids: Vec<String>,
    pub(crate) asset_changed: bool,
    pub(crate) skipped_paths: usize,
    pub(crate) errors: Vec<String>,
    pub(crate) status_changed: bool,
    pub(crate) retry_paths: Vec<PathBuf>,
}

#[derive(Debug, Default)]
pub(crate) struct WatchProcessor {
    pending_cleanup: BTreeMap<PathBuf, String>,
}

enum CleanupAttempt {
    Consumed,
    ReplacementRestored,
    StagedReplacement(Vec<u8>),
    Retry(String),
}

impl WatchProcessor {
    pub(crate) fn with_pending_cleanup(pending_cleanup: BTreeMap<PathBuf, String>) -> Self {
        Self { pending_cleanup }
    }

    pub(crate) fn process<I, P>(
        &mut self,
        vault_path: &str,
        paths: I,
    ) -> Result<WatchBatchOutcome, String>
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        let shared = acquire_notes_connection(vault_path)?;
        let mut connection = lock_notes_connection(&shared)?;
        let mut report = BootstrapReport::default();
        let mut changed_topic_ids = BTreeSet::new();
        let mut asset_changed = false;
        let mut status_changed = false;
        let mut retry_paths = BTreeSet::new();
        let configured_asset_root =
            crate::expand_vault_path(vault_path).join(".yonalist/notes-assets");
        let asset_root = fs::canonicalize(&configured_asset_root).unwrap_or(configured_asset_root);
        let configured_vault_root = crate::expand_vault_path(vault_path);
        let vault_root = fs::canonicalize(&configured_vault_root).unwrap_or(configured_vault_root);
        for path in paths {
            let path = path.as_ref();
            let normalized_path = normalize_watch_path(path);
            let file_name = path.file_name().and_then(|name| name.to_str());
            let was_quarantined = file_name
                .map(|file_name| file_is_quarantined(&connection, file_name))
                .transpose()?
                .unwrap_or(false);

            let mut cleanup_only_handled = false;
            if let Some(expected_hash) = self.pending_cleanup.get(&normalized_path).cloned() {
                match retire_consumed_path(&normalized_path, &expected_hash) {
                    CleanupAttempt::Consumed => {
                        cleanup_only_handled = matches!(
                            fs::symlink_metadata(&normalized_path),
                            Err(error) if error.kind() == io::ErrorKind::NotFound
                        );
                        self.pending_cleanup.remove(&normalized_path);
                        if let Some(file_name) = file_name {
                            clear_virtual_quarantine(&connection, file_name)?;
                        }
                    }
                    CleanupAttempt::ReplacementRestored => {
                        self.pending_cleanup.remove(&normalized_path);
                        if let Some(file_name) = file_name {
                            clear_virtual_quarantine(&connection, file_name)?;
                        }
                    }
                    CleanupAttempt::StagedReplacement(bytes) => {
                        let errors_before = report.errors.len();
                        let mut preserve_separately = false;
                        match reconcile_staged_file_bytes(
                            &mut connection,
                            &normalized_path,
                            &bytes,
                            &mut report,
                        ) {
                            Ok(reconcile)
                                if reconcile.cleanup_pending
                                    && report.errors.len() == errors_before =>
                            {
                                if reconcile.sqlite_changed {
                                    if let Some(topic_id) = reconcile.topic_id {
                                        changed_topic_ids.insert(topic_id);
                                    }
                                }
                                let replacement_hash = reconcile.source_hash.ok_or_else(|| {
                                    "A staged Notes replacement must retain its consumed hash."
                                        .to_string()
                                })?;
                                self.pending_cleanup
                                    .insert(normalized_path.clone(), replacement_hash.clone());
                                match retire_consumed_path(&normalized_path, &replacement_hash) {
                                    CleanupAttempt::Consumed => {
                                        self.pending_cleanup.remove(&normalized_path);
                                        if let Some(file_name) = file_name {
                                            clear_virtual_quarantine(&connection, file_name)?;
                                        }
                                    }
                                    _ => {
                                        cleanup_only_handled = true;
                                        retry_paths.insert(normalized_path.clone());
                                        push_report_error(
                                            &mut report,
                                            format!(
                                                "Could not finish staged Notes replacement cleanup: {}",
                                                normalized_path.display()
                                            ),
                                        );
                                    }
                                }
                            }
                            Ok(_) => {
                                preserve_separately = true;
                            }
                            Err(error) => {
                                push_report_error(&mut report, error);
                                preserve_separately = true;
                            }
                        }
                        if preserve_separately {
                            match preserve_staged_replacement(&normalized_path, &bytes) {
                                Ok(_recovery_path) => {
                                    // B7: the `.recovered.txt` drop-file lives
                                    // outside the `*.md` namespace, so it is
                                    // never rescanned, re-parsed, or quarantined
                                    // — do not retry or record it, just leave it
                                    // on disk for the user to inspect.
                                    self.pending_cleanup.remove(&normalized_path);
                                    if let Some(file_name) = file_name {
                                        clear_virtual_quarantine(&connection, file_name)?;
                                    }
                                    status_changed = true;
                                }
                                Err(error) => {
                                    cleanup_only_handled = true;
                                    retry_paths.insert(normalized_path.clone());
                                    push_report_error(&mut report, error);
                                }
                            }
                        }
                    }
                    CleanupAttempt::Retry(error) => {
                        cleanup_only_handled = true;
                        retry_paths.insert(normalized_path.clone());
                        push_report_error(
                            &mut report,
                            format!(
                                "Could not retry Notes bounced-copy cleanup {}: {error}",
                                normalized_path.display()
                            ),
                        );
                    }
                }
            }

            if !cleanup_only_handled {
                let metadata = match fs::symlink_metadata(path) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        if let Some(file_name) = file_name {
                            clear_virtual_quarantine(&connection, file_name)?;
                            // B3: recreate a still-live topic the user deleted in
                            // Finder; the next export writes the file back.
                            if schedule_missing_topic_recreation(&connection, file_name)? {
                                status_changed = true;
                            }
                        }
                        let is_quarantined = file_name
                            .map(|file_name| file_is_quarantined(&connection, file_name))
                            .transpose()?
                            .unwrap_or(false);
                        status_changed |= was_quarantined != is_quarantined;
                        continue;
                    }
                    Err(error) => {
                        retry_paths.insert(normalized_path.clone());
                        record_path_quarantine(&connection, path)?;
                        push_report_error(
                            &mut report,
                            format!(
                                "Could not inspect watched Notes path {}: {error}",
                                path.display()
                            ),
                        );
                        let is_quarantined = file_name
                            .map(|file_name| file_is_quarantined(&connection, file_name))
                            .transpose()?
                            .unwrap_or(false);
                        status_changed |= was_quarantined != is_quarantined;
                        continue;
                    }
                };
                if !metadata.file_type().is_file() {
                    if !metadata.file_type().is_symlink() {
                        retry_paths.insert(normalized_path.clone());
                    }
                    record_path_quarantine(&connection, path)?;
                    push_report_error(
                        &mut report,
                        format!(
                            "Watched Notes path must be a regular file inside the vault: {}",
                            path.display()
                        ),
                    );
                    let is_quarantined = file_name
                        .map(|file_name| file_is_quarantined(&connection, file_name))
                        .transpose()?
                        .unwrap_or(false);
                    status_changed |= was_quarantined != is_quarantined;
                    continue;
                }
                if normalized_path.parent() == Some(asset_root.as_path()) {
                    asset_changed = true;
                    continue;
                }
                if normalized_path.parent() != Some(vault_root.as_path())
                    || normalized_path
                        .extension()
                        .and_then(|extension| extension.to_str())
                        != Some("md")
                {
                    record_path_quarantine(&connection, path)?;
                    push_report_error(
                        &mut report,
                        format!(
                            "Watched Notes path escaped its configured vault directory: {}",
                            path.display()
                        ),
                    );
                    let is_quarantined = file_name
                        .map(|file_name| file_is_quarantined(&connection, file_name))
                        .transpose()?
                        .unwrap_or(false);
                    status_changed |= was_quarantined != is_quarantined;
                    continue;
                }
                let errors_before = report.errors.len();
                match self.process_path(
                    &mut connection,
                    &normalized_path,
                    &mut report,
                    &mut retry_paths,
                ) {
                    Ok(Some(topic_id)) => {
                        changed_topic_ids.insert(topic_id);
                    }
                    Ok(None) => {}
                    Err(error) => {
                        retry_paths.insert(normalized_path.clone());
                        if let Some(file_name) = file_name {
                            record_quarantine(&connection, file_name)?;
                        }
                        push_report_error(&mut report, error);
                    }
                }
                if report.errors.len() != errors_before {
                    retry_paths.insert(normalized_path.clone());
                }
            }

            let is_quarantined = file_name
                .map(|file_name| file_is_quarantined(&connection, file_name))
                .transpose()?
                .unwrap_or(false);
            status_changed |= was_quarantined != is_quarantined;
        }
        Ok(WatchBatchOutcome {
            changed_topic_ids: changed_topic_ids.into_iter().collect(),
            asset_changed,
            skipped_paths: report.skipped_files,
            errors: report.errors,
            status_changed,
            retry_paths: retry_paths.into_iter().collect(),
        })
    }

    fn process_path(
        &mut self,
        connection: &mut rusqlite::Connection,
        path: &Path,
        report: &mut BootstrapReport,
        retry_paths: &mut BTreeSet<PathBuf>,
    ) -> Result<Option<String>, String> {
        let bytes = read_regular_file_bounded_nofollow(path, MAX_MARKDOWN_BYTES)
            .map_err(|error| format!("Could not securely read watched Notes file: {error}"))?;
        let reconcile = reconcile_file_bytes(connection, path, &bytes, report)?;
        let changed_topic_id = reconcile
            .sqlite_changed
            .then(|| reconcile.topic_id.clone())
            .flatten();
        if reconcile.cleanup_pending {
            let expected_hash = reconcile
                .source_hash
                .ok_or_else(|| "A merged Notes file must retain its consumed hash.".to_string())?;
            self.pending_cleanup
                .insert(path.to_path_buf(), expected_hash.clone());
            match retire_consumed_path(path, &expected_hash) {
                CleanupAttempt::Consumed => {
                    self.pending_cleanup.remove(path);
                    if let Some(file_name) = path.file_name().and_then(|name| name.to_str()) {
                        clear_virtual_quarantine(connection, file_name)?;
                    }
                }
                CleanupAttempt::ReplacementRestored => {
                    self.pending_cleanup.remove(path);
                    if let Some(file_name) = path.file_name().and_then(|name| name.to_str()) {
                        clear_virtual_quarantine(connection, file_name)?;
                    }
                    retry_paths.insert(path.to_path_buf());
                    push_report_error(
                        report,
                        format!(
                            "Notes bounced copy changed while it was being merged: {}",
                            path.display()
                        ),
                    );
                }
                CleanupAttempt::StagedReplacement(_) => {
                    retry_paths.insert(path.to_path_buf());
                    push_report_error(
                        report,
                        format!(
                            "A second changed Notes replacement was retained in cleanup staging: {}",
                            path.display()
                        ),
                    );
                }
                CleanupAttempt::Retry(error) => {
                    retry_paths.insert(path.to_path_buf());
                    push_report_error(
                        report,
                        format!(
                            "Could not verify merged Notes bounced copy {}: {error}",
                            path.display()
                        ),
                    );
                }
            }
        }
        Ok(changed_topic_id)
    }
}

fn retire_consumed_path(path: &Path, expected_hash: &str) -> CleanupAttempt {
    let staging = match cleanup_staging_path(path) {
        Ok(staging) => staging,
        Err(error) => return CleanupAttempt::Retry(error),
    };
    let Some(sync_root) = staging.parent().and_then(Path::parent) else {
        return CleanupAttempt::Retry("A Notes cleanup staging path is invalid.".to_string());
    };
    let Some(staging_root) = staging.parent() else {
        return CleanupAttempt::Retry("A Notes cleanup staging path is invalid.".to_string());
    };
    if let Err(error) = ensure_watch_directory(sync_root, "Notes sync directory")
        .and_then(|_| ensure_watch_directory(staging_root, "Notes cleanup staging directory"))
    {
        return CleanupAttempt::Retry(error);
    }
    match fs::symlink_metadata(&staging) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return CleanupAttempt::Retry(format!(
                "Notes cleanup staging target is not a regular file: {}",
                staging.display()
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let source = match hold_regular_file_bounded_nofollow(path, MAX_MARKDOWN_BYTES) {
                Ok(source) => source,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    return CleanupAttempt::Consumed;
                }
                Err(error) => {
                    return CleanupAttempt::Retry(format!(
                        "Could not hold merged Notes bounced copy {}: {error}",
                        path.display()
                    ));
                }
            };
            if let Err(error) = source.move_noreplace_to(&staging) {
                return CleanupAttempt::Retry(format!(
                    "Could not stage merged Notes bounced copy {}: {error}",
                    path.display()
                ));
            }
        }
        Err(error) => {
            return CleanupAttempt::Retry(format!(
                "Could not inspect Notes cleanup staging {}: {error}",
                staging.display()
            ));
        }
    }
    let staged = match hold_regular_file_bounded_nofollow(&staging, MAX_MARKDOWN_BYTES) {
        Ok(staged) => staged,
        Err(error) => {
            return CleanupAttempt::Retry(format!(
                "Could not verify staged Notes bounced copy {}: {error}",
                staging.display()
            ));
        }
    };
    maybe_inject_after_staged_read();
    if sha256_hex(staged.bytes()) == expected_hash {
        return match staged.logically_retire(Path::new("consumed"), ".yonalist-consumed-") {
            Ok(_) => CleanupAttempt::Consumed,
            Err(error) => CleanupAttempt::Retry(format!(
                "Could not logically retire staged Notes bounced copy {}: {error}",
                staging.display()
            )),
        };
    }
    match staged.move_noreplace_to(path) {
        Ok(()) => CleanupAttempt::ReplacementRestored,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            CleanupAttempt::StagedReplacement(staged.into_bytes())
        }
        Err(error) => CleanupAttempt::Retry(format!(
            "Could not restore a changed Notes bounced copy {}: {error}",
            path.display()
        )),
    }
}

fn preserve_staged_replacement(path: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    let staging = cleanup_staging_path(path)?;
    let staged = hold_regular_file_bounded_nofollow(&staging, MAX_MARKDOWN_BYTES)
        .map_err(|error| format!("Could not hold staged Notes replacement: {error}"))?;
    if staged.bytes() != bytes {
        return Err(format!(
            "Staged Notes replacement changed before recovery: {}.",
            staging.display()
        ));
    }
    let vault_root = path
        .parent()
        .ok_or_else(|| "A Notes recovery path must have a vault parent.".to_string())?;
    let hash = sha256_hex(bytes);
    for ordinal in 0..1024_u16 {
        let suffix = (ordinal != 0)
            .then(|| format!("-{ordinal}"))
            .unwrap_or_default();
        // B7: `.recovered.txt`, not `.md`, so the drop-file is outside the
        // watched/reconciled `*.md` namespace — no reparse loop, no rescan.
        let candidate = vault_root.join(format!(".yonalist-recovered-{hash}{suffix}.recovered.txt"));
        match staged.move_noreplace_to(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if read_regular_file_bounded_nofollow(&candidate, MAX_MARKDOWN_BYTES)
                    .is_ok_and(|existing| existing == bytes)
                {
                    maybe_inject_after_equal_recovery_match();
                    staged
                        .logically_retire(Path::new("consumed"), ".yonalist-consumed-duplicate-")
                        .map_err(|error| {
                            format!(
                                "Could not logically retire duplicate staged Notes recovery: {error}"
                            )
                        })?;
                    return Ok(candidate);
                }
            }
            Err(error) => {
                return Err(format!(
                    "Could not preserve a staged Notes replacement {}: {error}",
                    staging.display()
                ));
            }
        }
    }
    Err(format!(
        "Could not allocate a collision-free Notes recovery path for {}.",
        path.display()
    ))
}

fn normalize_watch_path(path: &Path) -> PathBuf {
    path.parent()
        .and_then(|parent| fs::canonicalize(parent).ok())
        .and_then(|parent| path.file_name().map(|file_name| parent.join(file_name)))
        .unwrap_or_else(|| path.to_path_buf())
}

pub(crate) fn process_watch_paths<I, P>(
    vault_path: &str,
    paths: I,
) -> Result<WatchBatchOutcome, String>
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    WatchProcessor::default().process(vault_path, paths)
}

fn push_report_error(report: &mut BootstrapReport, error: String) {
    if !report.errors.contains(&error) {
        report.errors.push(error);
    }
}

fn record_path_quarantine(connection: &rusqlite::Connection, path: &Path) -> Result<(), String> {
    if path.extension().and_then(|extension| extension.to_str()) == Some("md") {
        if let Some(file_name) = path.file_name().and_then(|name| name.to_str()) {
            record_quarantine(connection, file_name)?;
        }
    }
    Ok(())
}

/// B3: a topic/trash file that vanished from disk is not a deletion (invariant
/// 1: absence != delete). If SQLite still holds a live root for that filename
/// (or live trash content for trash.md), mark it dirty so the next export
/// recreates the file. Files the app itself removed — a deleted/rerooted root,
/// emptied trash — do not match, so they stay gone. Returns true when a
/// recreation was scheduled.
fn schedule_missing_topic_recreation(
    connection: &rusqlite::Connection,
    file_name: &str,
) -> Result<bool, String> {
    if file_name == TRASH_FILE_NAME {
        let has_trash: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes_nodes WHERE deleted_at IS NOT NULL) \
                 OR EXISTS(SELECT 1 FROM sync_purged_tombstones)",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not inspect a missing Notes trash file: {error}"))?;
        if !has_trash {
            return Ok(false);
        }
        connection
            .execute(
                "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) \
                 ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
                [TRASH_TOPIC_ID],
            )
            .map_err(|error| format!("Could not schedule a missing Notes trash rewrite: {error}"))?;
        return Ok(true);
    }
    let topic_id: Option<String> = connection
        .query_row(
            "SELECT topic_id FROM sync_topics WHERE file_name = ?1",
            [file_name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not resolve a missing Notes topic file: {error}"))?;
    let Some(topic_id) = topic_id else {
        return Ok(false);
    };
    let is_live_root: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_nodes \
             WHERE id = ?1 AND parent_id IS NULL AND deleted_at IS NULL)",
            [&topic_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect a missing Notes topic root: {error}"))?;
    if !is_live_root {
        return Ok(false);
    }
    connection
        .execute(
            "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) \
             ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
            [&topic_id],
        )
        .map_err(|error| format!("Could not schedule a missing Notes topic rewrite: {error}"))?;
    Ok(true)
}

fn file_is_quarantined(connection: &rusqlite::Connection, file_name: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_topics WHERE file_name = ?1 AND quarantined <> 0)",
            [file_name],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect watched Notes quarantine state: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{
        inject_after_equal_recovery_match_once, inject_after_staged_read_once,
        preserve_staged_replacement, process_watch_paths, retire_consumed_path, CleanupAttempt,
        PeriodicScan, WatchProcessor, WatchSchedule, WatcherRuntime,
    };
    use crate::file_io::read_regular_file_bounded_nofollow;
    use crate::notes::connection::{
        acquire_notes_connection, evict_notes_connection, lock_notes_connection,
    };
    use crate::notes::markdown_import::MAX_MARKDOWN_BYTES;
    use crate::notes::sync::bootstrap::{cleanup_staging_path, reconcile_startup};
    use crate::notes::sync::exporter::sha256_hex;
    use crate::notes::sync::topic_file::{
        render_topic_doc, render_trash_doc, TopicDoc, TopicRoot, TrashDoc,
    };
    use std::fs::{self, File, FileTimes};
    use std::path::PathBuf;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    const TOPIC_ID: &str = "11111111-1111-4111-8111-111111111111";
    const SECOND_TOPIC_ID: &str = "22222222-2222-4222-8222-222222222222";
    const HLC_1: &str = "000000001-00-a3f2";
    const HLC_2: &str = "000000002-00-a3f2";

    #[test]
    fn cleanup_never_deletes_a_stage_replacement_after_the_expected_snapshot() {
        let vault = tempfile::tempdir().unwrap();
        let source = vault.path().join("bounce.md");
        let staging = cleanup_staging_path(&source).unwrap();
        fs::create_dir_all(staging.parent().unwrap()).unwrap();
        let expected = b"expected stage";
        let replacement = b"replacement stage";
        let displaced = staging.with_extension("expected-preserved");
        fs::write(&staging, expected).unwrap();
        let staging_for_hook = staging.clone();
        let displaced_for_hook = displaced.clone();
        inject_after_staged_read_once(move || {
            fs::rename(&staging_for_hook, &displaced_for_hook).unwrap();
            fs::write(&staging_for_hook, replacement).unwrap();
        });

        let result = retire_consumed_path(&source, &sha256_hex(expected));

        assert!(matches!(result, CleanupAttempt::Retry(_)));
        assert_eq!(fs::read(&displaced).unwrap(), expected);
        assert_eq!(fs::read(&staging).unwrap(), replacement);
    }

    #[test]
    fn equal_recovery_dedupe_never_deletes_a_changed_stage_path() {
        let vault = tempfile::tempdir().unwrap();
        let source = vault.path().join("bounce.md");
        let staging = cleanup_staging_path(&source).unwrap();
        fs::create_dir_all(staging.parent().unwrap()).unwrap();
        let expected = b"expected stage";
        let replacement = b"replacement stage";
        let hash = sha256_hex(expected);
        let candidate = vault
            .path()
            .join(format!(".yonalist-recovered-{hash}.recovered.txt"));
        let displaced = staging.with_extension("expected-preserved");
        fs::write(&staging, expected).unwrap();
        fs::write(&candidate, expected).unwrap();
        let staging_for_hook = staging.clone();
        let displaced_for_hook = displaced.clone();
        inject_after_equal_recovery_match_once(move || {
            fs::rename(&staging_for_hook, &displaced_for_hook).unwrap();
            fs::write(&staging_for_hook, replacement).unwrap();
        });

        let result = preserve_staged_replacement(&source, expected);

        assert!(
            result.is_err(),
            "changed stage must remain retryable: {result:?}"
        );
        assert_eq!(fs::read(&candidate).unwrap(), expected);
        assert_eq!(fs::read(&displaced).unwrap(), expected);
        assert_eq!(fs::read(&staging).unwrap(), replacement);
    }

    fn topic(title: &str, hlc: &str) -> TopicDoc {
        TopicDoc {
            id: TOPIC_ID.to_string(),
            sort_key: 1024,
            max_hlc: hlc.to_string(),
            root: TopicRoot {
                title: title.to_string(),
                note: String::new(),
                starred: false,
                completed_at: None,
                archived_at: None,
                hlc: hlc.to_string(),
            },
            nodes: Vec::new(),
        }
    }

    #[test]
    fn direct_changed_topic_path_merges_and_reports_the_exact_topic() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let source = vault.path().join("topic.11111111.md");
        fs::write(&source, render_topic_doc(&topic("Before", HLC_1)).unwrap()).unwrap();
        reconcile_startup(&vault_path).unwrap();
        fs::write(&source, render_topic_doc(&topic("After", HLC_2)).unwrap()).unwrap();

        let outcome = process_watch_paths(&vault_path, [&source]).unwrap();

        assert_eq!(
            outcome.changed_topic_ids,
            vec![TOPIC_ID.to_string()],
            "{outcome:?}"
        );
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        let title: String = connection
            .query_row(
                "SELECT title FROM notes_nodes WHERE id = ?1",
                [TOPIC_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "After");
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn exported_topic_and_trash_hashes_are_reported_as_echo_skips() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let topic_source = vault.path().join("topic.11111111.md");
        let trash_source = vault.path().join("trash.md");
        fs::write(
            &topic_source,
            render_topic_doc(&topic("Before", HLC_1)).unwrap(),
        )
        .unwrap();
        fs::write(
            &trash_source,
            render_trash_doc(&TrashDoc {
                max_hlc: HLC_1.to_string(),
                purged: Vec::new(),
                nodes: Vec::new(),
            })
            .unwrap(),
        )
        .unwrap();
        reconcile_startup(&vault_path).unwrap();

        let outcome = process_watch_paths(&vault_path, [&topic_source, &trash_source]).unwrap();

        assert_eq!(outcome.skipped_paths, 2);
        assert!(outcome.changed_topic_ids.is_empty());
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn successful_bounced_copy_merge_removes_only_the_copy() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let canonical = vault.path().join("topic.11111111.md");
        let bounced = vault.path().join("topic 2.md");
        fs::write(
            &canonical,
            render_topic_doc(&topic("Before", HLC_1)).unwrap(),
        )
        .unwrap();
        reconcile_startup(&vault_path).unwrap();
        fs::write(
            &bounced,
            render_topic_doc(&topic("From copy", HLC_2)).unwrap(),
        )
        .unwrap();

        let outcome = process_watch_paths(&vault_path, [&bounced]).unwrap();

        assert_eq!(outcome.changed_topic_ids, vec![TOPIC_ID.to_string()]);
        assert!(canonical.is_file());
        assert!(
            !bounced.exists(),
            "durably merged bounced input must be removed"
        );
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT title FROM notes_nodes WHERE id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "From copy"
        );
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[cfg(unix)]
    #[test]
    fn bounced_cleanup_failure_preserves_the_committed_change_and_retries_cleanup_only() {
        use std::os::unix::fs::PermissionsExt;

        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let canonical = vault.path().join("topic.11111111.md");
        let bounced = vault.path().join("topic 2.md");
        fs::write(
            &canonical,
            render_topic_doc(&topic("Before", HLC_1)).unwrap(),
        )
        .unwrap();
        reconcile_startup(&vault_path).unwrap();
        fs::write(
            &bounced,
            render_topic_doc(&topic("Committed", HLC_2)).unwrap(),
        )
        .unwrap();
        fs::set_permissions(vault.path(), fs::Permissions::from_mode(0o500)).unwrap();

        let mut processor = WatchProcessor::default();
        let outcome = processor.process(&vault_path, [&bounced]).unwrap();

        assert_eq!(outcome.changed_topic_ids, vec![TOPIC_ID.to_string()]);
        assert!(
            bounced.is_file(),
            "failed cleanup must retain the source copy"
        );
        assert_eq!(outcome.errors.len(), 1);
        assert_eq!(
            outcome.retry_paths,
            vec![fs::canonicalize(&bounced).unwrap()]
        );
        assert_eq!(processor.pending_cleanup.len(), 1);
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        let durable_cleanup: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sync_topics WHERE file_name = ?1 \
                 AND topic_id LIKE '__yonalist_cleanup__:%' AND exported_hash <> ''",
                ["topic 2.md"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(durable_cleanup, 1);
        drop(connection);
        drop(shared);

        fs::set_permissions(vault.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let mut restarted_processor = WatchProcessor::default();
        let cleanup = restarted_processor
            .process(&vault_path, [&bounced])
            .unwrap();
        assert!(cleanup.changed_topic_ids.is_empty());
        assert!(cleanup.retry_paths.is_empty());
        assert!(cleanup.errors.is_empty());
        assert!(!bounced.exists());
        assert!(restarted_processor.pending_cleanup.is_empty());
        evict_notes_connection(&vault_path);
    }

    #[cfg(unix)]
    #[test]
    fn bounced_cleanup_retry_treats_an_already_absent_copy_as_success() {
        use std::os::unix::fs::PermissionsExt;

        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let canonical = vault.path().join("topic.11111111.md");
        let bounced = vault.path().join("topic 2.md");
        fs::write(
            &canonical,
            render_topic_doc(&topic("Before", HLC_1)).unwrap(),
        )
        .unwrap();
        reconcile_startup(&vault_path).unwrap();
        fs::write(
            &bounced,
            render_topic_doc(&topic("Committed", HLC_2)).unwrap(),
        )
        .unwrap();
        fs::set_permissions(vault.path(), fs::Permissions::from_mode(0o500)).unwrap();
        let mut processor = WatchProcessor::default();
        processor.process(&vault_path, [&bounced]).unwrap();
        fs::set_permissions(vault.path(), fs::Permissions::from_mode(0o700)).unwrap();
        fs::remove_file(&bounced).unwrap();

        let startup = reconcile_startup(&vault_path).unwrap();

        assert!(startup.pending_cleanup.is_empty());
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        let cleanup_rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sync_topics WHERE file_name = ?1",
                ["topic 2.md"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cleanup_rows, 0);
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn cleanup_recovers_a_replacement_moved_to_staging_before_verification() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let canonical = vault.path().join("topic.11111111.md");
        let bounced = vault.path().join("topic 2.md");
        fs::write(
            &canonical,
            render_topic_doc(&topic("Before", HLC_1)).unwrap(),
        )
        .unwrap();
        reconcile_startup(&vault_path).unwrap();
        fs::write(
            &bounced,
            render_topic_doc(&topic("Consumed", HLC_2)).unwrap(),
        )
        .unwrap();
        let bootstrap = reconcile_startup(&vault_path).unwrap();
        assert_eq!(bootstrap.pending_cleanup.len(), 1);
        let staging = cleanup_staging_path(&bounced).unwrap();
        fs::create_dir_all(staging.parent().unwrap()).unwrap();
        fs::write(
            &staging,
            render_topic_doc(&topic("Replacement", "000000003-00-a3f2")).unwrap(),
        )
        .unwrap();
        fs::remove_file(&bounced).unwrap();
        let restarted = reconcile_startup(&vault_path).unwrap();
        let mut processor = WatchProcessor::with_pending_cleanup(restarted.pending_cleanup);

        let outcome = processor.process(&vault_path, [&bounced]).unwrap();

        assert_eq!(outcome.changed_topic_ids, vec![TOPIC_ID.to_string()]);
        assert!(canonical.is_file());
        assert!(!bounced.exists());
        assert!(!staging.exists());
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        let title: String = connection
            .query_row(
                "SELECT title FROM notes_nodes WHERE id = ?1",
                [TOPIC_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "Replacement");
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn staged_consumed_copy_is_retired_from_its_durable_marker_after_restart() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let canonical = vault.path().join("topic.11111111.md");
        let bounced = vault.path().join("topic 2.md");
        fs::write(
            &canonical,
            render_topic_doc(&topic("Before", HLC_1)).unwrap(),
        )
        .unwrap();
        reconcile_startup(&vault_path).unwrap();
        fs::write(
            &bounced,
            render_topic_doc(&topic("Consumed", HLC_2)).unwrap(),
        )
        .unwrap();
        let bootstrap = reconcile_startup(&vault_path).unwrap();
        assert_eq!(bootstrap.pending_cleanup.len(), 1);
        let staging = cleanup_staging_path(&bounced).unwrap();
        fs::create_dir_all(staging.parent().unwrap()).unwrap();
        fs::rename(&bounced, &staging).unwrap();
        let restarted = reconcile_startup(&vault_path).unwrap();
        assert_eq!(restarted.pending_cleanup.len(), 1);
        let mut processor = WatchProcessor::with_pending_cleanup(restarted.pending_cleanup);

        let outcome = processor.process(&vault_path, [&bounced]).unwrap();

        assert!(outcome.changed_topic_ids.is_empty());
        assert!(outcome.errors.is_empty());
        assert!(canonical.is_file());
        assert!(!bounced.exists());
        assert!(!staging.exists());
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        let cleanup_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sync_topics WHERE topic_id GLOB '__yonalist_cleanup__:*'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cleanup_count, 0);
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn cleanup_restart_consumes_the_stage_before_processing_a_new_replacement() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let canonical = vault.path().join("topic.11111111.md");
        let bounced = vault.path().join("topic 2.md");
        fs::write(
            &canonical,
            render_topic_doc(&topic("Before", HLC_1)).unwrap(),
        )
        .unwrap();
        reconcile_startup(&vault_path).unwrap();
        fs::write(
            &bounced,
            render_topic_doc(&topic("Consumed", HLC_2)).unwrap(),
        )
        .unwrap();
        let bootstrap = reconcile_startup(&vault_path).unwrap();
        assert_eq!(bootstrap.pending_cleanup.len(), 1);
        let staging = cleanup_staging_path(&bounced).unwrap();
        fs::create_dir_all(staging.parent().unwrap()).unwrap();
        fs::rename(&bounced, &staging).unwrap();
        fs::write(
            &bounced,
            render_topic_doc(&topic("Replacement", "000000003-00-a3f2")).unwrap(),
        )
        .unwrap();
        let restarted = reconcile_startup(&vault_path).unwrap();
        let mut processor = WatchProcessor::with_pending_cleanup(restarted.pending_cleanup);

        let outcome = processor.process(&vault_path, [&bounced]).unwrap();

        assert_eq!(
            outcome.changed_topic_ids,
            vec![TOPIC_ID.to_string()],
            "{outcome:?}"
        );
        assert!(outcome.errors.is_empty(), "{outcome:?}");
        assert!(canonical.is_file());
        assert!(!bounced.exists());
        assert!(!staging.exists());
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        let title: String = connection
            .query_row(
                "SELECT title FROM notes_nodes WHERE id = ?1",
                [TOPIC_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "Replacement");
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn cleanup_restart_merges_a_mismatched_stage_before_the_occupied_original() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let canonical = vault.path().join("topic.11111111.md");
        let bounced = vault.path().join("topic 2.md");
        fs::write(
            &canonical,
            render_topic_doc(&topic("Before", HLC_1)).unwrap(),
        )
        .unwrap();
        reconcile_startup(&vault_path).unwrap();
        fs::write(
            &bounced,
            render_topic_doc(&topic("Consumed", HLC_2)).unwrap(),
        )
        .unwrap();
        let bootstrap = reconcile_startup(&vault_path).unwrap();
        assert_eq!(bootstrap.pending_cleanup.len(), 1);
        let staging = cleanup_staging_path(&bounced).unwrap();
        fs::create_dir_all(staging.parent().unwrap()).unwrap();
        fs::rename(&bounced, &staging).unwrap();
        fs::write(
            &staging,
            render_topic_doc(&topic("Staged replacement", "000000003-00-a3f2")).unwrap(),
        )
        .unwrap();
        fs::write(
            &bounced,
            render_topic_doc(&topic("Path replacement", "000000004-00-a3f2")).unwrap(),
        )
        .unwrap();
        let restarted = reconcile_startup(&vault_path).unwrap();
        let shared = acquire_notes_connection(&vault_path).unwrap();
        {
            let connection = lock_notes_connection(&shared).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE watched_merge_audit(title TEXT NOT NULL); \
                     CREATE TRIGGER audit_watched_merge \
                     AFTER UPDATE OF title ON notes_nodes \
                     WHEN NEW.id = '11111111-1111-4111-8111-111111111111' \
                     BEGIN INSERT INTO watched_merge_audit(title) VALUES (NEW.title); END;",
                )
                .unwrap();
        }
        drop(shared);
        let mut processor = WatchProcessor::with_pending_cleanup(restarted.pending_cleanup);

        let outcome = processor.process(&vault_path, [&bounced]).unwrap();

        assert_eq!(
            outcome.changed_topic_ids,
            vec![TOPIC_ID.to_string()],
            "{outcome:?}"
        );
        assert!(outcome.errors.is_empty(), "{outcome:?}");
        assert!(canonical.is_file());
        assert!(!bounced.exists());
        assert!(!staging.exists());
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        let applied = connection
            .prepare("SELECT title FROM watched_merge_audit ORDER BY rowid")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(applied, vec!["Staged replacement", "Path replacement"]);
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn malformed_stage_is_quarantined_without_starving_the_occupied_original() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let canonical = vault.path().join("topic.11111111.md");
        let bounced = vault.path().join("topic 2.md");
        fs::write(
            &canonical,
            render_topic_doc(&topic("Before", HLC_1)).unwrap(),
        )
        .unwrap();
        reconcile_startup(&vault_path).unwrap();
        fs::write(
            &bounced,
            render_topic_doc(&topic("Consumed", HLC_2)).unwrap(),
        )
        .unwrap();
        let bootstrap = reconcile_startup(&vault_path).unwrap();
        assert_eq!(bootstrap.pending_cleanup.len(), 1);
        let staging = cleanup_staging_path(&bounced).unwrap();
        fs::create_dir_all(staging.parent().unwrap()).unwrap();
        fs::rename(&bounced, &staging).unwrap();
        let malformed = b"malformed staged replacement";
        fs::write(&staging, malformed).unwrap();
        let occupied_recovery = vault.path().join(format!(
            ".yonalist-recovered-{}.recovered.txt",
            sha256_hex(malformed)
        ));
        fs::create_dir(&occupied_recovery).unwrap();
        fs::write(
            &bounced,
            render_topic_doc(&topic("Healthy path", "000000004-00-a3f2")).unwrap(),
        )
        .unwrap();
        let restarted = reconcile_startup(&vault_path).unwrap();
        let mut processor = WatchProcessor::with_pending_cleanup(restarted.pending_cleanup);

        let outcome = processor.process(&vault_path, [&bounced]).unwrap();

        assert_eq!(outcome.changed_topic_ids, vec![TOPIC_ID.to_string()]);
        assert_eq!(outcome.errors.len(), 1);
        assert!(canonical.is_file());
        assert!(!bounced.exists());
        assert!(!staging.exists());
        let recovered = fs::read_dir(vault.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.is_file()
                    && path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| {
                            name.starts_with(".yonalist-recovered-")
                                && name.ends_with(".recovered.txt")
                        })
            })
            .collect::<Vec<_>>();
        assert_eq!(recovered.len(), 1);
        assert!(recovered[0]
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with("-1.recovered.txt")));
        assert_eq!(fs::read(&recovered[0]).unwrap(), malformed);
        assert!(occupied_recovery.is_dir());
        // B7: the recovery drop-file is out of the watched namespace, so it is
        // never retried or quarantined — only the consumed bounce work happened.
        assert!(outcome.retry_paths.is_empty());
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        let title: String = connection
            .query_row(
                "SELECT title FROM notes_nodes WHERE id = ?1",
                [TOPIC_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "Healthy path");
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn malformed_bounced_copy_is_preserved_and_does_not_starve_a_healthy_path() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let canonical = vault.path().join("topic.11111111.md");
        let malformed = vault.path().join("topic (conflicted copy).md");
        fs::write(
            &canonical,
            render_topic_doc(&topic("Before", HLC_1)).unwrap(),
        )
        .unwrap();
        reconcile_startup(&vault_path).unwrap();
        fs::write(&malformed, b"not a topic file").unwrap();
        fs::write(
            &canonical,
            render_topic_doc(&topic("Healthy", HLC_2)).unwrap(),
        )
        .unwrap();

        let outcome = process_watch_paths(&vault_path, [&malformed, &canonical]).unwrap();

        assert!(malformed.is_file(), "failed bounced input must be retained");
        assert_eq!(outcome.changed_topic_ids, vec![TOPIC_ID.to_string()]);
        assert_eq!(outcome.errors.len(), 1);
        assert!(outcome.status_changed);
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        let quarantined: bool = connection
            .query_row(
                "SELECT quarantined FROM sync_topics WHERE file_name = ?1",
                ["topic (conflicted copy).md"],
                |row| row.get(0),
            )
            .unwrap();
        assert!(quarantined);
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn a_bounced_document_cannot_claim_another_topics_assigned_filename() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let first = vault.path().join("first.11111111.md");
        let second = vault.path().join("second.22222222.md");
        fs::write(&first, render_topic_doc(&topic("First", HLC_1)).unwrap()).unwrap();
        fs::write(
            &second,
            render_topic_doc(&TopicDoc {
                id: SECOND_TOPIC_ID.to_string(),
                sort_key: 2048,
                max_hlc: HLC_1.to_string(),
                root: TopicRoot {
                    title: "Second".to_string(),
                    note: String::new(),
                    starred: false,
                    completed_at: None,
                    archived_at: None,
                    hlc: HLC_1.to_string(),
                },
                nodes: Vec::new(),
            })
            .unwrap(),
        )
        .unwrap();
        reconcile_startup(&vault_path).unwrap();
        fs::write(&second, render_topic_doc(&topic("Hijack", HLC_2)).unwrap()).unwrap();

        let outcome = process_watch_paths(&vault_path, [&second]).unwrap();

        assert!(outcome.changed_topic_ids.is_empty());
        assert_eq!(outcome.errors.len(), 1);
        assert!(second.is_file());
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        let title: String = connection
            .query_row(
                "SELECT title FROM notes_nodes WHERE id = ?1",
                [TOPIC_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "First");
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn cleanup_intent_failure_rolls_back_the_bounced_merge() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let canonical = vault.path().join("topic.11111111.md");
        let bounced = vault.path().join("topic 2.md");
        fs::write(
            &canonical,
            render_topic_doc(&topic("Before", HLC_1)).unwrap(),
        )
        .unwrap();
        reconcile_startup(&vault_path).unwrap();
        let shared = acquire_notes_connection(&vault_path).unwrap();
        {
            let connection = lock_notes_connection(&shared).unwrap();
            connection
                .execute_batch(
                    "CREATE TRIGGER reject_cleanup_intent \
                     BEFORE INSERT ON sync_topics \
                     WHEN NEW.topic_id GLOB '__yonalist_cleanup__:*' \
                     BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END;",
                )
                .unwrap();
        }
        drop(shared);
        fs::write(
            &bounced,
            render_topic_doc(&topic("Must roll back", HLC_2)).unwrap(),
        )
        .unwrap();

        let outcome = process_watch_paths(&vault_path, [&bounced]).unwrap();

        assert!(outcome.changed_topic_ids.is_empty());
        assert_eq!(outcome.errors.len(), 1);
        assert!(bounced.is_file());
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        let title: String = connection
            .query_row(
                "SELECT title FROM notes_nodes WHERE id = ?1",
                [TOPIC_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "Before");
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn synchronized_hash_failure_rolls_back_the_canonical_merge() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let canonical = vault.path().join("topic.11111111.md");
        fs::write(
            &canonical,
            render_topic_doc(&topic("Before", HLC_1)).unwrap(),
        )
        .unwrap();
        reconcile_startup(&vault_path).unwrap();
        let shared = acquire_notes_connection(&vault_path).unwrap();
        {
            let connection = lock_notes_connection(&shared).unwrap();
            connection
                .execute_batch(
                    "CREATE TRIGGER reject_synchronized_hash \
                     BEFORE UPDATE OF exported_hash ON sync_topics \
                     WHEN NEW.topic_id = '11111111-1111-4111-8111-111111111111' \
                      AND NEW.exported_hash <> OLD.exported_hash \
                     BEGIN SELECT RAISE(ABORT, 'injected hash failure'); END;",
                )
                .unwrap();
        }
        drop(shared);
        fs::write(
            &canonical,
            render_topic_doc(&topic("Must roll back", HLC_2)).unwrap(),
        )
        .unwrap();

        let outcome = process_watch_paths(&vault_path, [&canonical]).unwrap();

        assert!(outcome.changed_topic_ids.is_empty());
        assert_eq!(outcome.errors.len(), 1);
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        let title: String = connection
            .query_row(
                "SELECT title FROM notes_nodes WHERE id = ?1",
                [TOPIC_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "Before");
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn unreadable_path_is_retained_for_retry_without_stopping_the_batch() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let canonical = vault.path().join("topic.11111111.md");
        let unavailable = vault.path().join("icloud-placeholder.md");
        fs::write(
            &canonical,
            render_topic_doc(&topic("Before", HLC_1)).unwrap(),
        )
        .unwrap();
        reconcile_startup(&vault_path).unwrap();
        fs::create_dir(&unavailable).unwrap();
        fs::write(
            &canonical,
            render_topic_doc(&topic("Healthy", HLC_2)).unwrap(),
        )
        .unwrap();

        let outcome = process_watch_paths(&vault_path, [&unavailable, &canonical])
            .expect("one unreadable target must not stop watcher processing");

        assert!(
            unavailable.is_dir(),
            "unreadable input must remain retryable"
        );
        assert_eq!(outcome.changed_topic_ids, vec![TOPIC_ID.to_string()]);
        assert_eq!(outcome.errors.len(), 1);
        assert!(outcome.status_changed);
        assert_eq!(
            outcome.retry_paths,
            vec![fs::canonicalize(&unavailable).unwrap()]
        );
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn a_watcher_target_that_already_vanished_is_acknowledged_without_quarantine() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        reconcile_startup(&vault_path).unwrap();
        let vanished = vault.path().join("vanished.md");

        let outcome = process_watch_paths(&vault_path, [&vanished]).unwrap();

        assert!(outcome.errors.is_empty());
        assert!(outcome.retry_paths.is_empty());
        assert!(!outcome.status_changed);
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        let rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sync_topics WHERE file_name = 'vanished.md'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0);
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn successful_retry_clears_quarantine_and_reports_status_recovery() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        reconcile_startup(&vault_path).unwrap();
        let source = vault.path().join("recovered.md");
        fs::write(&source, b"not a topic file").unwrap();
        let quarantined = process_watch_paths(&vault_path, [&source]).unwrap();
        assert!(quarantined.status_changed);
        fs::write(
            &source,
            render_topic_doc(&topic("Recovered", HLC_1)).unwrap(),
        )
        .unwrap();

        let recovered = process_watch_paths(&vault_path, [&source]).unwrap();

        assert!(
            recovered.status_changed,
            "quarantine recovery must emit status"
        );
        assert_eq!(recovered.changed_topic_ids, vec![TOPIC_ID.to_string()]);
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        let still_quarantined: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sync_topics WHERE file_name = ?1 AND quarantined <> 0",
                ["recovered.md"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(still_quarantined, 0);
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn watcher_paths_coalesce_for_five_hundred_milliseconds_after_the_last_event() {
        let first = PathBuf::from("/vault/first.md");
        let second = PathBuf::from("/vault/second.md");
        let mut schedule = WatchSchedule::default();
        schedule.push(first.clone(), Duration::ZERO);
        schedule.push(first.clone(), Duration::from_millis(100));
        schedule.push(second.clone(), Duration::from_millis(250));

        assert!(schedule.take_due(Duration::from_millis(749)).is_empty());
        assert_eq!(
            schedule.take_due(Duration::from_millis(750)),
            vec![first, second]
        );
        assert!(schedule.take_due(Duration::from_secs(1)).is_empty());
    }

    #[test]
    fn sixty_second_scan_recovers_changes_using_mtime_and_hash() {
        let vault = tempfile::tempdir().unwrap();
        let source = vault.path().join("topic.11111111.md");
        fs::write(&source, render_topic_doc(&topic("Before", HLC_1)).unwrap()).unwrap();
        let mut scan = PeriodicScan::new(vault.path(), Duration::ZERO).unwrap();
        fs::write(&source, render_topic_doc(&topic("After", HLC_2)).unwrap()).unwrap();

        assert!(scan
            .take_due(vault.path(), Duration::from_secs(59))
            .unwrap()
            .is_empty());
        assert_eq!(
            scan.take_due(vault.path(), Duration::from_secs(60))
                .unwrap(),
            vec![source.clone()]
        );

        let prior_modified = fs::metadata(&source).unwrap().modified().unwrap();
        fs::write(
            &source,
            render_topic_doc(&topic("Hash wins", "000000003-00-a3f2")).unwrap(),
        )
        .unwrap();
        File::options()
            .write(true)
            .open(&source)
            .unwrap()
            .set_times(FileTimes::new().set_modified(prior_modified))
            .unwrap();
        assert_eq!(
            scan.take_due(vault.path(), Duration::from_secs(120))
                .unwrap(),
            vec![source]
        );
    }

    #[test]
    fn scan_processing_failure_remains_due_until_acknowledged() {
        let vault = tempfile::tempdir().unwrap();
        let source = vault.path().join("retry.md");
        fs::write(&source, b"before").unwrap();
        let mut scan = PeriodicScan::new(vault.path(), Duration::ZERO).unwrap();
        fs::write(&source, b"after").unwrap();

        let first = scan
            .take_due(vault.path(), Duration::from_secs(60))
            .unwrap();
        assert_eq!(first, vec![source.clone()]);
        scan.acknowledge(&first, &first);

        let retry = scan
            .take_due(vault.path(), Duration::from_secs(120))
            .unwrap();
        assert_eq!(retry, vec![source.clone()]);
        scan.acknowledge(&retry, &[]);

        assert!(scan
            .take_due(vault.path(), Duration::from_secs(180))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn notes_asset_creation_requests_reload_without_markdown_merge() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        reconcile_startup(&vault_path).unwrap();
        let assets = vault.path().join(".yonalist/notes-assets");
        fs::create_dir_all(&assets).unwrap();
        let asset = assets.join(format!("{}.png", "a".repeat(64)));
        fs::write(&asset, b"png").unwrap();

        let outcome = process_watch_paths(&vault_path, [&asset]).unwrap();

        assert!(outcome.asset_changed);
        assert!(outcome.changed_topic_ids.is_empty());
        assert!(outcome.errors.is_empty());
        evict_notes_connection(&vault_path);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_markdown_and_assets_cannot_escape_the_vault() {
        use std::os::unix::fs::symlink;

        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let canonical = vault.path().join("topic.11111111.md");
        fs::write(
            &canonical,
            render_topic_doc(&topic("Before", HLC_1)).unwrap(),
        )
        .unwrap();
        reconcile_startup(&vault_path).unwrap();
        let outside_markdown = outside.path().join("outside.md");
        fs::write(
            &outside_markdown,
            render_topic_doc(&topic("Outside", HLC_2)).unwrap(),
        )
        .unwrap();
        let markdown_link = vault.path().join("linked.md");
        symlink(&outside_markdown, &markdown_link).unwrap();
        let asset_root = vault.path().join(".yonalist/notes-assets");
        fs::create_dir_all(&asset_root).unwrap();
        let outside_asset = outside.path().join("outside.png");
        fs::write(&outside_asset, b"png").unwrap();
        let asset_link = asset_root.join(format!("{}.png", "c".repeat(64)));
        symlink(&outside_asset, &asset_link).unwrap();

        let outcome = process_watch_paths(&vault_path, [&markdown_link, &asset_link]).unwrap();

        assert!(outcome.changed_topic_ids.is_empty());
        assert!(!outcome.asset_changed);
        assert_eq!(outcome.errors.len(), 2);
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        let title: String = connection
            .query_row(
                "SELECT title FROM notes_nodes WHERE id = ?1",
                [TOPIC_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "Before");
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[cfg(unix)]
    #[test]
    fn secure_reader_refuses_a_symlink_swap_after_prior_validation() {
        use std::os::unix::fs::symlink;

        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let source = vault.path().join("topic.md");
        let outside_source = outside.path().join("outside.md");
        fs::write(&source, b"inside").unwrap();
        fs::write(&outside_source, b"outside").unwrap();

        assert!(fs::symlink_metadata(&source).unwrap().file_type().is_file());
        fs::remove_file(&source).unwrap();
        symlink(&outside_source, &source).unwrap();

        assert!(read_regular_file_bounded_nofollow(&source, MAX_MARKDOWN_BYTES).is_err());
    }

    #[test]
    fn watcher_reader_uses_the_cross_platform_capability_nofollow_contract() {
        let watcher_source = include_str!("watcher.rs");
        let file_io_source = include_str!("../../file_io.rs");
        let helper_name = ["read_regular_file_bounded", "_nofollow"].concat();
        let legacy_fallback = ["#[cfg(not(unix))]\nfn ", "read_regular_file_in_parent"].concat();
        let ambient_read = ["fs::", "read(&path)"].concat();
        let opener_name = ["fn open_capability_read_file_", "nofollow"].concat();

        assert!(watcher_source.contains(&helper_name));
        assert!(!watcher_source.contains(&legacy_fallback));
        assert!(!watcher_source.contains(&ambient_read));
        assert!(file_io_source.contains(&format!("pub(crate) fn {helper_name}")));
        let contract_start = file_io_source.find(&opener_name).unwrap();
        let contract_end = file_io_source[contract_start..]
            .find("impl HeldCapabilityFile")
            .map(|offset| contract_start + offset)
            .unwrap();
        let reader_contract = &file_io_source[contract_start..contract_end];
        assert!(reader_contract.contains("FollowSymlinks::No"));
        assert!(reader_contract.contains("capability_metadata_is_reparse_point"));
        assert!(reader_contract.contains("!metadata.is_file()"));
        assert!(reader_contract.contains("verify_capability_read_file_at"));
        assert!(reader_contract.contains(".take(max_bytes_u64.saturating_add(1))"));
        assert!(file_io_source.contains("struct HeldCapabilityDirectory"));
        assert!(file_io_source.contains("inspect_ambient_read_parent"));
        assert!(file_io_source.contains("ambient_metadata_is_reparse_point"));
        assert!(file_io_source.contains("verify_ambient"));
        assert!(file_io_source.contains("WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT"));
        assert!(file_io_source.contains("try_capability_file_identity"));
        assert!(file_io_source.contains("windows_file_identity_from_optional_fields"));
        assert!(file_io_source.contains("volume_serial_number()"));
        assert!(file_io_source.contains("file_index()"));
    }

    #[test]
    fn watcher_creates_and_observes_an_asset_directory_absent_at_startup() {
        let vault = tempfile::tempdir().unwrap();
        let asset_root = vault.path().join(".yonalist/notes-assets");
        let (sender, receiver) = mpsc::channel();
        let mut runtime = WatcherRuntime::spawn(
            vault.path().to_path_buf(),
            Vec::new(),
            Arc::new(move |paths| {
                let _ = sender.send(paths);
                Vec::new()
            }),
            Arc::new(|_message| {}),
        )
        .unwrap();

        assert!(
            asset_root.is_dir(),
            "the asset directory must exist before watcher registration"
        );
        let asset = asset_root.join(format!("{}.png", "b".repeat(64)));
        fs::write(&asset, b"png").unwrap();

        let paths = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("asset creation must reach the watcher handler");
        assert_eq!(paths, vec![fs::canonicalize(asset).unwrap()]);
        runtime.stop().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn scan_retries_one_unreadable_file_without_starving_a_healthy_change() {
        use std::os::unix::fs::PermissionsExt;

        let vault = tempfile::tempdir().unwrap();
        let unavailable = vault.path().join("unavailable.md");
        let healthy = vault.path().join("healthy.md");
        fs::write(&unavailable, b"before").unwrap();
        fs::write(&healthy, b"before").unwrap();
        let mut scan = PeriodicScan::new(vault.path(), Duration::ZERO).unwrap();
        fs::set_permissions(&unavailable, fs::Permissions::from_mode(0o000)).unwrap();
        fs::write(&healthy, b"after").unwrap();

        let due = scan
            .take_due(vault.path(), Duration::from_secs(60))
            .expect("one unreadable target must not abort the scan");

        assert_eq!(due, vec![healthy, unavailable.clone()]);
        fs::set_permissions(&unavailable, fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[test]
    fn different_bytes_with_no_applied_state_emit_no_changed_topic() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let source = vault.path().join("topic.11111111.md");
        let canonical =
            String::from_utf8(render_topic_doc(&topic("Same", HLC_1)).unwrap()).unwrap();
        fs::write(&source, &canonical).unwrap();
        reconcile_startup(&vault_path).unwrap();
        fs::write(
            &source,
            canonical.replace(
                "format_version: 2\n",
                "format_version: 2\nexternal: ignored\n",
            ),
        )
        .unwrap();

        let outcome = process_watch_paths(&vault_path, [&source]).unwrap();

        assert!(outcome.changed_topic_ids.is_empty());
        assert_eq!(outcome.skipped_paths, 0, "bytes were not an exported echo");
        evict_notes_connection(&vault_path);
    }

    // B3: a topic file the user deletes in Finder is not a deletion — the next
    // export recreates it, and the loss is surfaced as a status change.
    #[test]
    fn deleting_a_live_topic_file_reschedules_its_recreation() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let source = vault.path().join("topic.11111111.md");
        fs::write(&source, render_topic_doc(&topic("Kept", HLC_1)).unwrap()).unwrap();
        reconcile_startup(&vault_path).unwrap();
        assert!(source.is_file());
        fs::remove_file(&source).unwrap();

        let outcome = process_watch_paths(&vault_path, [&source]).unwrap();

        assert!(outcome.status_changed, "a vanished topic file is surfaced");
        {
            let shared = acquire_notes_connection(&vault_path).unwrap();
            let connection = lock_notes_connection(&shared).unwrap();
            let scheduled: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
                    [TOPIC_ID],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(scheduled, 1, "the live topic is scheduled for rewrite");
        }
        // The next export restores the file (absence != delete).
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let mut connection = lock_notes_connection(&shared).unwrap();
        crate::notes::sync::bootstrap::flush_pending(
            &mut connection,
            &crate::expand_vault_path(&vault_path),
        )
        .unwrap();
        drop(connection);
        drop(shared);
        assert!(source.is_file(), "the deleted topic file was recreated");
        evict_notes_connection(&vault_path);
    }

    // B3: a file the app itself removed (a rerooted/deleted root) is not
    // recreated — only still-live roots come back.
    #[test]
    fn deleting_a_file_with_no_live_root_is_not_recreated() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let orphan = vault.path().join("gone.abcdef01.md");
        // A metadata row whose topic id is not a live node (app already removed it).
        {
            let shared = acquire_notes_connection(&vault_path).unwrap();
            let connection = lock_notes_connection(&shared).unwrap();
            connection.execute("DELETE FROM notes_nodes", []).unwrap();
            connection
                .execute("DELETE FROM sync_dirty_nodes", [])
                .unwrap();
            connection
                .execute(
                    "INSERT INTO sync_topics(topic_id, file_name, exported_hash) \
                     VALUES ('99999999-9999-4999-8999-999999999999', 'gone.abcdef01.md', '')",
                    [],
                )
                .unwrap();
        }

        let outcome = process_watch_paths(&vault_path, [&orphan]).unwrap();

        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        let scheduled: i64 = connection
            .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(scheduled, 0, "a removed root is never resurrected");
        assert!(!outcome.status_changed);
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    // B5: the startup scan reconciles every current file, so a change that
    // landed during the startup reconcile window is never lost.
    #[test]
    fn immediate_full_scan_reconciles_every_file_at_startup() {
        let vault = tempfile::tempdir().unwrap();
        let first = vault.path().join("one.11111111.md");
        let second = vault.path().join("two.22222222.md");
        fs::write(&first, render_topic_doc(&topic("One", HLC_1)).unwrap()).unwrap();
        fs::write(&second, b"anything").unwrap();
        let mut scan = PeriodicScan::new(vault.path(), Duration::ZERO).unwrap();
        // A normal scan right after construction sees no change (baseline is now).
        assert!(scan
            .take_due(vault.path(), Duration::from_millis(1))
            .unwrap()
            .is_empty());
        // Arming for startup forces the very next scan to surface every file.
        scan.arm_immediate_full_scan();
        let mut due = scan
            .take_due(vault.path(), Duration::from_millis(2))
            .unwrap();
        due.sort();
        let mut expected = vec![first, second];
        expected.sort();
        assert_eq!(due, expected);
    }
}
