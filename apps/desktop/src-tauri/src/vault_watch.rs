//! The thread that watches the vault folder.
//!
//! Everything about *what* an event means lives in `notes_sync::watcher`; this
//! is the part that cannot be tested without a filesystem — the notify
//! subscription, the timer, and the loop that turns a stream of events into one
//! merge at a time.
//!
//! One merge at a time is the rule that matters. The worker's queue is shared
//! with everything the user does, so handing it a folder's worth of merges
//! would put the next keystroke behind all of them. `WatchQueue` holds that
//! rule; this thread asks it for work and does not ask again until the answer
//! comes back.

use notes_sqlite::SqliteStorage;
use notes_sync::merger::MergeOutcome;
use notes_sync::watch_queue::WatchQueue;
use notes_sync::watcher::{Verdict, consider};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

/// Long enough that an editor writing a file three times is one thing to read.
const QUIET_MILLIS: u64 = 500;
/// The net under the watcher. Events are dropped by every platform under load,
/// and a note that never arrives is worse than a folder read once a minute.
const SWEEP: Duration = Duration::from_secs(60);

pub(crate) struct VaultWatch {
    /// Dropping it ends the subscription, which ends the thread.
    _thread: std::thread::JoinHandle<()>,
}

impl VaultWatch {
    pub(crate) fn start(
        storage: Arc<SqliteStorage>,
        vault_root: PathBuf,
        changed: impl Fn(MergeOutcome) + Send + 'static,
    ) -> Result<Self, String> {
        let (events, inbox) = channel();
        let mut watcher = RecommendedWatcher::new(
            move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event {
                    let _ = events.send(event.paths);
                }
            },
            notify::Config::default(),
        )
        .map_err(|error| format!("Could not watch the vault: {error}"))?;
        watcher
            .watch(&vault_root, RecursiveMode::Recursive)
            .map_err(|error| format!("Could not watch the vault: {error}"))?;
        let thread = std::thread::Builder::new()
            .name("yonalist-vault-watch".to_owned())
            .spawn(move || {
                // Moved in so the subscription lives exactly as long as the
                // loop that reads from it.
                let _watcher = watcher;
                run(&storage, &vault_root, &inbox, &changed);
            })
            .map_err(|error| format!("Could not watch the vault: {error}"))?;
        Ok(Self { _thread: thread })
    }
}

fn run(
    storage: &SqliteStorage,
    vault_root: &Path,
    inbox: &Receiver<Vec<PathBuf>>,
    changed: &impl Fn(MergeOutcome),
) {
    let started = Instant::now();
    let now = || started.elapsed().as_millis() as u64;
    let mut queue = WatchQueue::new(QUIET_MILLIS);
    let mut swept = Instant::now();
    loop {
        // Short enough that a file going quiet is noticed promptly, long
        // enough that an idle app is not doing this a hundred times a second.
        match inbox.recv_timeout(Duration::from_millis(QUIET_MILLIS / 2)) {
            Ok(paths) => {
                for path in paths {
                    if let Some(relative) = document_path(vault_root, &path) {
                        queue.saw(&relative, now());
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            // The subscription is gone, so nothing else will arrive.
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if swept.elapsed() >= SWEEP {
            swept = Instant::now();
            for relative in documents_on_disk(vault_root) {
                queue.saw(&relative, now());
            }
        }
        // One, and only after the last one came back: the queue's own rule.
        while let Some(relative) = queue.next_in_flight(now()) {
            if let Some(outcome) = take(storage, vault_root, &relative) {
                changed(outcome);
            }
            queue.finished(&relative);
        }
    }
}

/// What the merge changed, when it changed anything — which is what the window
/// has to be told about, and nothing else is.
fn take(storage: &SqliteStorage, vault_root: &Path, relative: &str) -> Option<MergeOutcome> {
    let recorded = storage.vault_file_hash(relative).ok().flatten();
    match consider(vault_root, relative, recorded.as_deref()) {
        Ok(Verdict::Merge(file, input)) => storage
            .merge_document(&file, &input)
            .ok()
            .filter(|outcome| outcome.applied > 0),
        // Nothing to do, nothing wrong. A placeholder comes back on the sweep
        // once its bytes arrive; an echo is this app's own writing.
        Ok(_) => None,
        Err(_) => None,
    }
}

/// The path a document is known by: relative to the vault, and only if it is
/// one of ours to read.
fn document_path(vault_root: &Path, path: &Path) -> Option<String> {
    if path.extension()? != "md" {
        return None;
    }
    let relative = path.strip_prefix(vault_root).ok()?;
    Some(relative.to_string_lossy().into_owned())
}

fn documents_on_disk(vault_root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut stack = vec![vault_root.to_path_buf()];
    while let Some(at) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&at) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // The link itself: following one walks out of the vault, and a
            // link to a folder above itself walks for ever.
            let Ok(kind) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                stack.push(path);
            } else if let Some(relative) = document_path(vault_root, &path) {
                found.push(relative);
            }
        }
    }
    found
}
