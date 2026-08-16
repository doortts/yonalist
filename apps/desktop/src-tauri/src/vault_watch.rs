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

use notes_application::{ImageAssetPort, ImageImportSource, ImageSource};
use notes_sqlite::{LocalImageAssets, SqliteStorage};
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
        assets: Arc<LocalImageAssets>,
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
                run(&storage, &assets, &vault_root, &inbox, &changed);
            })
            .map_err(|error| format!("Could not watch the vault: {error}"))?;
        Ok(Self { _thread: thread })
    }
}

fn run(
    storage: &SqliteStorage,
    assets: &LocalImageAssets,
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
                    if let Some(relative) = watched_path(vault_root, &path) {
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
            if relative.ends_with(".md") {
                if let Some(outcome) = take(storage, vault_root, &relative) {
                    changed(outcome);
                }
            } else {
                // An attachment. Nothing in the outline moved, so the window is
                // not told: what changed is that a picture it already knows
                // about can be shown.
                take_asset(storage, assets, vault_root, &relative);
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

/// The bytes for a picture a note is waiting on. Copied into this app's own
/// store, which is where every reader of an image looks — the vault's copy is
/// the one the user can take away, not the one the app reads.
fn take_asset(
    storage: &SqliteStorage,
    assets: &LocalImageAssets,
    vault_root: &Path,
    relative: &str,
) {
    let Some(disk_name) = relative.rsplit('/').next().map(str::to_owned) else {
        return;
    };
    let Ok(bytes) = notes_sync::file_io::read_regular_bounded(
        vault_root,
        &vault_root.join(relative),
        notes_sync::parse::MAX_ASSET_BYTES as usize,
    ) else {
        return;
    };
    // Through the store's own import, so the bytes are decoded and checked
    // rather than trusted: what is written here is read back as an image.
    let Ok(published) = assets.prepare(&[ImageImportSource {
        node_id: notes_core::NodeId::try_from(PLACEHOLDER_NODE.to_owned()).expect("a fixed id"),
        original_name: disk_name.clone(),
        declared_mime_type: None,
        source: ImageSource::Bytes(bytes),
    }]) else {
        return;
    };
    let Some(first) = published.first() else {
        return;
    };
    if storage
        .resolve_asset(&disk_name, first.image.content_hash())
        .is_err()
    {
        // The bytes are in the store either way; the rows waiting for them are
        // tried again on the next sweep.
        assets.rollback(&published);
    }
}

/// The import wants a node id and this import belongs to no single node — the
/// rows that were waiting are found by name once the bytes are in.
const PLACEHOLDER_NODE: &str = "00000000-0000-4000-8000-000000000000";

/// The path this app knows a file by: relative to the vault, and only if it is
/// a file this app has something to do with.
fn watched_path(vault_root: &Path, path: &Path) -> Option<String> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let is_asset = matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp");
    if extension != "md" && !is_asset {
        return None;
    }
    let relative = path.strip_prefix(vault_root).ok()?;
    let relative = relative.to_string_lossy().into_owned();
    // An image anywhere else in the folder is the user's own file, not an
    // attachment this app put there.
    if is_asset && !relative.contains("assets/") {
        return None;
    }
    Some(relative)
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
            } else if let Some(relative) = watched_path(vault_root, &path) {
                found.push(relative);
            }
        }
    }
    found
}
