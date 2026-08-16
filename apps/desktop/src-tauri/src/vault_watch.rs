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
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::time::{Duration, Instant};

/// Long enough that an editor writing a file three times is one thing to read.
const QUIET_MILLIS: u64 = 500;
/// The net under the watcher. Events are dropped by every platform under load,
/// and a note that never arrives is worse than a folder read once a minute.
const SWEEP: Duration = Duration::from_secs(60);

pub(crate) struct VaultWatch {
    /// Dropped first, which is what ends the loop. The thread cannot end
    /// itself: the events it waits on come from a sender the subscription
    /// holds, and the subscription lives as long as the thread.
    stop: Sender<()>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for VaultWatch {
    /// Waits for the thread to go. A watch left running after the folder it
    /// watches has been replaced keeps merging that folder's documents into
    /// this database — two vaults, one set of notes.
    fn drop(&mut self) {
        drop(std::mem::replace(&mut self.stop, channel().0));
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl VaultWatch {
    pub(crate) fn start(
        storage: Arc<SqliteStorage>,
        assets: Arc<LocalImageAssets>,
        vault_root: PathBuf,
        changed: impl Fn(MergeOutcome) + Send + 'static,
    ) -> Result<Self, String> {
        Self::start_with(storage, assets, vault_root, SWEEP, changed)
    }

    /// The sweep interval is an argument so a test can ask for the behaviour
    /// without waiting a minute for it.
    pub(crate) fn start_with(
        storage: Arc<SqliteStorage>,
        assets: Arc<LocalImageAssets>,
        vault_root: PathBuf,
        sweep: Duration,
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
        let (stop, stopped) = channel();
        let thread = std::thread::Builder::new()
            .name("yonalist-vault-watch".to_owned())
            .spawn(move || {
                // Moved in so the subscription lives exactly as long as the
                // loop that reads from it.
                let _watcher = watcher;
                run(
                    &storage,
                    &assets,
                    &vault_root,
                    sweep,
                    &inbox,
                    &stopped,
                    &changed,
                );
            })
            .map_err(|error| format!("Could not watch the vault: {error}"))?;
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}

fn run(
    storage: &SqliteStorage,
    assets: &LocalImageAssets,
    vault_root: &Path,
    sweep: Duration,
    inbox: &Receiver<Vec<PathBuf>>,
    stopped: &Receiver<()>,
    changed: &impl Fn(MergeOutcome),
) {
    let started = Instant::now();
    let now = || started.elapsed().as_millis() as u64;
    let mut queue = WatchQueue::new(QUIET_MILLIS);
    // Expired, so the first round sweeps: a change made while the app was
    // closed reaches nobody by event — it already happened — and waiting a
    // minute to look means a minute of showing notes that are not current.
    let mut swept = Instant::now()
        .checked_sub(sweep)
        .unwrap_or_else(Instant::now);
    // The stat gate is a shortcut, and a shortcut is a thing that can be
    // wrong. Once, after the app is up and the folder has been read the cheap
    // way, every document is read for real — a transport that preserves the
    // reading and the size, which Syncthing does, hides an edit from the gate
    // and from nothing else.
    let mut sweeps = 0_u32;
    loop {
        // Asked before every round rather than only when an event arrives: a
        // folder nobody is touching still has to let go when it is replaced.
        if matches!(
            stopped.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Disconnected)
        ) {
            return;
        }
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
        if swept.elapsed() >= sweep {
            swept = Instant::now();
            sweeps += 1;
            let present = documents_on_disk(vault_root);
            // A refusal is about a file. Once the file is gone so is what it
            // was about, and one that comes back is read rather than skipped.
            let _ = storage.forget_missing_refusals(&present);
            // The first sweep is the boot scan and the third onwards are the
            // safety net — both take the gate. The second is the verification
            // pass, and it is the one that does not.
            if sweeps == 2 {
                for relative in present.iter().filter(|path| path.ends_with(".md")) {
                    queue.verify(relative);
                }
            } else {
                sweep_into(&mut queue, storage, vault_root, &present, now());
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
        // A merge that changed no row can still leave the file owing a
        // rewrite — it said something this device did not accept. Nothing
        // else would wake the exporter for that.
        Ok(Verdict::Merge(file, input)) => {
            let outcome = storage.merge_document(&file, &input).ok()?;
            if outcome.retire_file {
                // A copy some sync client wrote. Its notes are in the document
                // they belong to now; left there, every device reads it again
                // for ever and each one writes it back out.
                let _ = std::fs::remove_file(vault_root.join(relative));
            }
            Some(outcome).filter(|outcome| outcome.applied > 0 || outcome.needs_write_back)
        }
        // Written down so the sweep does not read and refuse it again every
        // minute, and so the user can be shown which file it was.
        Ok(Verdict::Unreadable(reason)) => {
            if let Ok(bytes) = notes_sync::file_io::read_regular_bounded(
                vault_root,
                &vault_root.join(relative),
                notes_sync::parse::MAX_FILE_BYTES,
            ) {
                let _ =
                    storage.quarantine(relative, &notes_sync::export::hash_bytes(&bytes), &reason);
            }
            None
        }
        // Nothing to do, nothing wrong. A placeholder comes back on the sweep
        // once its bytes arrive; an echo is this app's own writing.
        Ok(_) => None,
        Err(_) => None,
    }
}

/// Everything the folder holds, weighed against what this app last dealt with
/// there. The stat answers for most of it — a file whose reading and size are
/// what they were when this app wrote it has nothing to say — which is what
/// makes opening a large vault cheap. What the stat cannot answer, the read
/// does: a change that kept both is what the verification pass is for.
fn sweep_into(
    queue: &mut WatchQueue,
    storage: &SqliteStorage,
    vault_root: &Path,
    present: &[String],
    now: u64,
) {
    let records: std::collections::BTreeMap<String, notes_sync::intake::Known> = storage
        .vault_stat_records()
        .unwrap_or_default()
        .into_iter()
        .collect();
    for relative in present {
        // An attachment is not a document and has no record of this shape;
        // the bytes gate already keeps it from being read twice.
        if !relative.ends_with(".md") {
            queue.saw(relative, now);
            continue;
        }
        let stat = std::fs::symlink_metadata(vault_root.join(relative)).ok();
        let verdict = match stat {
            Some(facts) => notes_sync::intake::scan_verdict(
                records.get(relative),
                modified_millis(&facts).unwrap_or_default(),
                i64::try_from(facts.len()).unwrap_or_default(),
            ),
            // No answer from the folder is not an answer that nothing changed.
            None => notes_sync::intake::Verdict::Hash,
        };
        if verdict != notes_sync::intake::Verdict::Skip {
            queue.saw(relative, now);
        }
    }
}

fn modified_millis(facts: &std::fs::Metadata) -> Option<i64> {
    facts
        .modified()
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|since| i64::try_from(since.as_millis()).ok())
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
    // The same echo gate the documents get. Without it the sweep decodes every
    // picture in the vault once a minute, for ever — including the ones this
    // app wrote there itself.
    if storage.asset_known(relative).unwrap_or(false) {
        return;
    }
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
        .resolve_asset(&disk_name, first.image.content_hash(), relative)
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
    // A folder called exactly `assets`, not a name that ends in one: an image
    // under `MyPassets/` is the user's own file, and importing it into this
    // app's store would be helping itself to their pictures.
    if is_asset
        && !relative
            .split('/')
            .any(|segment| segment.eq_ignore_ascii_case("assets"))
    {
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

#[cfg(test)]
mod tests {
    use super::{VaultWatch, watched_path};
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;

    fn seen(relative: &str) -> Option<String> {
        watched_path(Path::new("/vault"), &Path::new("/vault").join(relative))
    }

    #[test]
    fn documents_and_the_attachments_beside_them_are_watched() {
        assert_eq!(
            seen("Projects-4f1c8e20a3b7/README.md").as_deref(),
            Some("Projects-4f1c8e20a3b7/README.md")
        );
        assert_eq!(
            seen("Projects-4f1c8e20a3b7/assets/shot-9f3a1c8e2044.png").as_deref(),
            Some("Projects-4f1c8e20a3b7/assets/shot-9f3a1c8e2044.png")
        );
        assert!(seen("assets/shot-9f3a1c8e2044.png").is_some());
    }

    /// The user's own files are theirs. A folder whose name merely ends in
    /// "assets" is not this app's attachment store, and importing what is in
    /// it would be helping itself to their pictures.
    #[test]
    fn images_outside_an_assets_folder_are_left_alone() {
        assert_eq!(seen("MyPassets/photo.png"), None);
        assert_eq!(seen("Holiday/photo.png"), None);
        assert_eq!(seen("Projects-4f1c8e20a3b7/notes.txt"), None);
    }

    /// A change made while the app was closed reaches nobody by event — it
    /// already happened. Waiting a minute to look means a minute of showing
    /// notes that are not current, on every launch.
    #[test]
    fn a_change_made_while_the_app_was_closed_is_merged_at_start() {
        let home = tempfile::tempdir().expect("home");
        let storage = Arc::new(
            notes_sqlite::SqliteStorage::open(&home.path().join("notes.sqlite")).expect("open"),
        );
        let assets = Arc::new(
            notes_sqlite::LocalImageAssets::open(&home.path().join("images")).expect("store"),
        );
        let vault = home.path().join("vault");
        let store = home.path().join("images");
        std::fs::create_dir_all(&vault).expect("vault");
        storage.export_pending(&vault, &store).expect("export");

        // Somebody else's edit, landed while this app was not running.
        let page = super::documents_on_disk(&vault)
            .into_iter()
            .find(|relative| relative != "README.md")
            .expect("a page");
        let document = std::fs::read_to_string(vault.join(&page)).expect("read");
        std::fs::write(
            vault.join(&page),
            document.replace("Yonalist", "Somebody else's word"),
        )
        .expect("their edit");

        let (told, changes) = std::sync::mpsc::channel();
        let _watch = VaultWatch::start(storage, assets, vault, move |_| {
            let _ = told.send(());
        })
        .expect("watch");

        assert!(
            changes.recv_timeout(Duration::from_secs(10)).is_ok(),
            "nothing read the folder at start, so the window shows what the \
             file no longer says"
        );
    }

    /// The stat gate is a shortcut and a shortcut can be wrong. A transport
    /// that preserves the reading and the size — Syncthing does — hands over
    /// an edit the gate cannot see, and only reading the file finds it.
    #[test]
    fn a_change_that_kept_mtime_and_size_is_caught_by_the_verification_pass() {
        let home = tempfile::tempdir().expect("home");
        let storage = Arc::new(
            notes_sqlite::SqliteStorage::open(&home.path().join("notes.sqlite")).expect("open"),
        );
        let assets = Arc::new(
            notes_sqlite::LocalImageAssets::open(&home.path().join("images")).expect("store"),
        );
        let vault = home.path().join("vault");
        std::fs::create_dir_all(&vault).expect("vault");
        storage
            .export_pending(&vault, &home.path().join("images"))
            .expect("export");
        let page = super::documents_on_disk(&vault)
            .into_iter()
            .find(|relative| relative != "README.md")
            .expect("a page");
        let path = vault.join(&page);
        let was = std::fs::metadata(&path).expect("stat");
        // The same length, different words, and the reading put back: every
        // one of those is what the transport does.
        let document = std::fs::read_to_string(&path).expect("read");
        std::fs::write(&path, document.replacen("Enter", "Enter", 1)).expect("rewrite");
        let document = std::fs::read_to_string(&path).expect("read");
        std::fs::write(&path, document.replacen("항목 만들기", "항목 만들기", 1)).expect("same");
        let edited = document.replacen("Enter — 새 항목", "Enter — 헌 항목", 1);
        assert_eq!(edited.len(), document.len(), "the same size on disk");
        std::fs::write(&path, &edited).expect("their edit");
        std::fs::File::options()
            .write(true)
            .open(&path)
            .expect("open")
            .set_times(
                std::fs::FileTimes::new()
                    .set_modified(was.modified().expect("mtime"))
                    .set_accessed(
                        was.accessed()
                            .unwrap_or_else(|_| std::time::SystemTime::now()),
                    ),
            )
            .expect("put the reading back");

        let (told, changes) = std::sync::mpsc::channel();
        let _watch = VaultWatch::start_with(
            storage,
            assets,
            vault,
            Duration::from_millis(200),
            move |_| {
                let _ = told.send(());
            },
        )
        .expect("watch");

        assert!(
            changes.recv_timeout(Duration::from_secs(10)).is_ok(),
            "the gate answered `nothing changed` and nothing looked again"
        );
    }

    /// The folder can be changed while the app is running. A watch that
    /// outlives its folder keeps merging that folder's documents into this
    /// database — two vaults, one set of notes.
    #[test]
    fn a_watch_lets_go_of_its_folder_when_it_is_dropped() {
        let home = tempfile::tempdir().expect("home");
        let storage = Arc::new(
            notes_sqlite::SqliteStorage::open(&home.path().join("notes.sqlite")).expect("open"),
        );
        let assets = Arc::new(
            notes_sqlite::LocalImageAssets::open(&home.path().join("images")).expect("store"),
        );
        let vault = home.path().join("vault");
        std::fs::create_dir_all(&vault).expect("vault");
        let watch = VaultWatch::start(storage, assets, vault, |_| {}).expect("watch");

        let (done, waiting) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            drop(watch);
            let _ = done.send(());
        });

        assert!(
            waiting.recv_timeout(Duration::from_secs(5)).is_ok(),
            "the thread cannot end itself: the events it waits on come from a \
             sender its own subscription holds"
        );
    }
}
