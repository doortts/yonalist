use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{self, SyncSender};
use std::thread::{self, JoinHandle};

use notes_application::{
    BootSnapshot, ExportError, ExportSnapshot, ExportSnapshotPort, ForestRequest, ForestSnapshot,
    SearchPage, SearchQuery, StorageCommit, StorageError, StoragePort, ViewportPage,
    ViewportRequest,
};
use notes_core::{DomainPatch, NoteNode, NotesCommand, NotesTree};
use notes_sync::hlc::{self, Clock};
use rusqlite::{Connection, OptionalExtension};

use crate::{forest_queries, queries, repository, schema};

enum DatabaseLocation {
    File(PathBuf),
    Memory,
}

enum Request {
    Load {
        command: NotesCommand,
        reply: SyncSender<Result<NotesTree, StorageError>>,
    },
    Commit {
        expected_revision: u64,
        patch: DomainPatch,
        reply: SyncSender<Result<StorageCommit, StorageError>>,
    },
    /// A vault file landing on the rows. It goes through the worker for the
    /// same reason every other write does: the revision is what open sessions
    /// hold, and a write that skipped it would leave them committing against a
    /// state that had already moved.
    MergeDocument {
        file: Box<notes_sync::document::VaultFile>,
        input: Box<notes_sync::merger::MergeInput>,
        reply: SyncSender<Result<notes_sync::merger::MergeOutcome, StorageError>>,
    },
    /// What this device is called, for the files it writes and for the settings
    /// screen to tell this device's edits from another's. Set at every startup:
    /// a machine renamed in System Settings says so without a reset.
    SetDeviceName {
        name: String,
        reply: SyncSender<Result<(), StorageError>>,
    },
    Conflicts {
        limit: u32,
        reply: SyncSender<Result<Vec<notes_application::SyncConflict>, StorageError>>,
    },
    Attachments {
        limit: u32,
        reply: SyncSender<Result<Vec<notes_application::SyncAttachment>, StorageError>>,
    },
    DeleteAttachment {
        content_hash: String,
        vault_root: Option<std::path::PathBuf>,
        reply: SyncSender<Result<bool, StorageError>>,
    },
    RefusedFiles {
        reply: SyncSender<Result<Vec<notes_application::RefusedFile>, StorageError>>,
    },
    VaultStatRecords {
        reply: SyncSender<Result<Vec<(String, notes_sync::intake::Known)>, StorageError>>,
    },
    ForgetMissingRefusals {
        present: Vec<String>,
        reply: SyncSender<Result<usize, StorageError>>,
    },
    AssetKnown {
        location: String,
        reply: SyncSender<Result<bool, StorageError>>,
    },
    /// A file this app could not read, recorded so it is not read again on
    /// every sweep, and so the user can be shown which one.
    Quarantine {
        relative: String,
        file_hash: String,
        reason: String,
        reply: SyncSender<Result<(), StorageError>>,
    },
    ResolveAsset {
        disk_name: String,
        content_hash: String,
        location: String,
        reply: SyncSender<Result<BTreeSet<String>, StorageError>>,
    },
    ImageHash {
        node_id: String,
        reply: SyncSender<Result<Option<String>, StorageError>>,
    },
    VaultFileHash {
        relative: String,
        reply: SyncSender<Result<Option<String>, StorageError>>,
    },
    PendingCount {
        reply: SyncSender<Result<i64, StorageError>>,
    },
    ReindexVault {
        vault_root: std::path::PathBuf,
        reply: SyncSender<Result<crate::sync_merge::ReindexReport, StorageError>>,
    },
    RebuildFromVault {
        vault_root: std::path::PathBuf,
        reply: SyncSender<Result<crate::sync_merge::ReindexReport, StorageError>>,
    },
    ExportPending {
        vault_root: std::path::PathBuf,
        store_root: std::path::PathBuf,
        reply: SyncSender<Result<usize, StorageError>>,
    },
    PlaceClaim {
        id: String,
        reply: SyncSender<Result<Option<(String, String)>, StorageError>>,
    },
    ConflictLoser {
        seq: i64,
        reply: SyncSender<Result<Option<(String, String)>, StorageError>>,
    },
    ForgetConflict {
        seq: i64,
        reply: SyncSender<Result<bool, StorageError>>,
    },
    Revision {
        reply: SyncSender<Result<u64, StorageError>>,
    },
    /// The guide notes, once somebody has decided what folder these notes live
    /// in. Deliberately not part of opening the database: a device joining a
    /// folder that already holds notes must not be given a fresh reading for
    /// every line the guide occupies.
    SeedOnboarding {
        reply: SyncSender<Result<(), StorageError>>,
    },
    /// That the user has said where these notes live. Written when a folder is
    /// chosen, which is an answer the guide never sees: a device joining a folder
    /// that already holds notes is given no guide at all.
    MarkOnboardingAnswered {
        reply: SyncSender<Result<(), StorageError>>,
    },
    OnboardingFirstRun {
        reply: SyncSender<Result<bool, StorageError>>,
    },
    Node {
        id: String,
        reply: SyncSender<Result<Option<NoteNode>, StorageError>>,
    },
    NodePath {
        id: String,
        reply: SyncSender<Result<Option<String>, StorageError>>,
    },
    LiveImageHashes {
        reply: SyncSender<Result<BTreeSet<String>, StorageError>>,
    },
    Bootstrap {
        session_id: String,
        viewport_limit: u32,
        reply: SyncSender<Result<BootSnapshot, StorageError>>,
    },
    Viewport {
        request: ViewportRequest,
        reply: SyncSender<Result<ViewportPage, StorageError>>,
    },
    Forest {
        request: ForestRequest,
        reply: SyncSender<Result<ForestSnapshot, StorageError>>,
    },
    Search {
        request: SearchQuery,
        reply: SyncSender<Result<SearchPage, StorageError>>,
    },
    ExportSnapshot {
        expected_revision: u64,
        root_id: String,
        reply: SyncSender<Result<ExportSnapshot, ExportError>>,
    },
    Optimize {
        reply: SyncSender<Result<(), StorageError>>,
    },
    #[cfg(feature = "bench-fixtures")]
    LoadFixture {
        node_count: usize,
        reply: SyncSender<Result<(), StorageError>>,
    },
    Shutdown,
}

pub struct SqliteStorage {
    sender: SyncSender<Request>,
    worker: Option<JoinHandle<()>>,
}

/// The four hexadecimal characters an HLC carries to break ties between
/// devices, provisioning the row on first open along with the vault's own id.
/// Never changed after that: a device that renamed itself would look like a
/// different one to every merge.
///
/// The value is derived from the machine rather than drawn at random, so a
/// database rebuilt here is this device again rather than a new one arguing with
/// the stamps its own vault still holds.
fn ensure_device_id(connection: &Connection) -> Result<String, StorageError> {
    let existing: Option<String> = connection
        .query_row(
            "SELECT device_id FROM sync_meta WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| StorageError::Internal(error.to_string()))?;
    if let Some(device_id) = existing {
        return Ok(device_id);
    }
    let device_id = notes_sync::hlc::device_seed();
    let vault_uuid = uuid::Uuid::new_v4().to_string();
    // Two processes can both find it empty; the one that loses reads back what
    // the other wrote rather than failing the open on the singleton key.
    connection
        .execute(
            "INSERT INTO sync_meta(singleton, device_id, vault_uuid) VALUES (1, ?1, ?2)
             ON CONFLICT(singleton) DO NOTHING",
            rusqlite::params![device_id, vault_uuid],
        )
        .map_err(|error| StorageError::Internal(error.to_string()))?;
    connection
        .query_row(
            "SELECT device_id FROM sync_meta WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|error| StorageError::Internal(error.to_string()))
}

impl SqliteStorage {
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        Self::start(DatabaseLocation::File(path.to_path_buf()))
    }

    pub fn open_in_memory() -> Result<Self, StorageError> {
        Self::start(DatabaseLocation::Memory)
    }

    /// Lands a parsed vault file on the rows. The outcome says whether anything
    /// was written, which is what decides the revision.
    pub fn merge_document(
        &self,
        file: &notes_sync::document::VaultFile,
        input: &notes_sync::merger::MergeInput,
    ) -> Result<notes_sync::merger::MergeOutcome, StorageError> {
        self.request(|reply| Request::MergeDocument {
            file: Box::new(file.clone()),
            input: Box::new(input.clone()),
            reply,
        })
    }

    /// The materialised ancestor path of a node, which subtree queries read.
    pub fn node_path(&self, id: &str) -> Result<Option<String>, StorageError> {
        self.request(|reply| Request::NodePath {
            id: id.to_owned(),
            reply,
        })
    }

    /// Records what this device is called. The name reaches other devices in the
    /// files this one writes; they have no other way to name a stamp's device.
    pub fn set_device_name(&self, name: &str) -> Result<(), StorageError> {
        self.request(|reply| Request::SetDeviceName {
            name: name.to_owned(),
            reply,
        })
    }

    /// The defeats this vault has recorded, newest first.
    pub fn sync_conflicts(
        &self,
        limit: u32,
    ) -> Result<Vec<notes_application::SyncConflict>, StorageError> {
        self.request(|reply| Request::Conflicts { limit, reply })
    }

    /// Every attachment, biggest first — one row per bullet that shows one.
    pub fn attachments(
        &self,
        limit: u32,
    ) -> Result<Vec<notes_application::SyncAttachment>, StorageError> {
        self.request(|reply| Request::Attachments { limit, reply })
    }

    /// Removes an attachment nothing points at, and answers whether it went.
    /// `false` means something started pointing at it again since the list was
    /// drawn — the count is taken with the removal, not before it.
    pub fn delete_attachment(
        &self,
        content_hash: &str,
        vault_root: Option<&std::path::Path>,
    ) -> Result<bool, StorageError> {
        self.request(|reply| Request::DeleteAttachment {
            content_hash: content_hash.to_owned(),
            vault_root: vault_root.map(std::path::Path::to_path_buf),
            reply,
        })
    }

    /// The bytes for an attachment arrived. Every row whose link names it and
    /// which is still waiting learns its hash — which is what turns a note
    /// showing nothing into a note showing its picture.
    /// Every file this app looked at and could not read, in the order they
    /// sit in the folder.
    pub fn refused_files(&self) -> Result<Vec<notes_application::RefusedFile>, StorageError> {
        self.request(|reply| Request::RefusedFiles { reply })
    }

    /// What this app last dealt with at every path it knows, in one answer.
    /// The scan asks about every file in the folder, and a question per file
    /// would be a worker round trip per document — the queue that a keystroke
    /// waits in.
    pub fn vault_stat_records(
        &self,
    ) -> Result<Vec<(String, notes_sync::intake::Known)>, StorageError> {
        self.request(|reply| Request::VaultStatRecords { reply })
    }

    /// Files this app refused that are not in the folder any more. A refusal
    /// is about a file; once the file is gone, so is what it was about — and a
    /// file that comes back is read rather than skipped as already answered.
    pub fn forget_missing_refusals(&self, present: &[String]) -> Result<usize, StorageError> {
        self.request(|reply| Request::ForgetMissingRefusals {
            present: present.to_vec(),
            reply,
        })
    }

    /// Whether the bytes at this place in the vault have already been taken
    /// in. The name carries the content hash, so a file that is still called
    /// what it was called holds what it held.
    pub fn asset_known(&self, location: &str) -> Result<bool, StorageError> {
        self.request(|reply| Request::AssetKnown {
            location: location.to_owned(),
            reply,
        })
    }

    /// Writes down that this app could not make sense of a file. The hash is
    /// what keeps it from being read again on every sweep — a file that is
    /// still the same file has already been answered.
    pub fn quarantine(
        &self,
        relative: &str,
        file_hash: &str,
        reason: &str,
    ) -> Result<(), StorageError> {
        self.request(|reply| Request::Quarantine {
            relative: relative.to_owned(),
            file_hash: file_hash.to_owned(),
            reason: reason.to_owned(),
            reply,
        })
    }

    /// `location` is where the file sits in the vault, relative to its root:
    /// the arrival is the only thing that knows, and the export writes its
    /// links from it.
    ///
    /// Answers with the nodes that stopped waiting, so whoever asked can name
    /// them to the window instead of making it read the page again.
    pub fn resolve_asset(
        &self,
        disk_name: &str,
        content_hash: &str,
        location: &str,
    ) -> Result<BTreeSet<String>, StorageError> {
        self.request(|reply| Request::ResolveAsset {
            disk_name: disk_name.to_owned(),
            content_hash: content_hash.to_owned(),
            location: location.to_owned(),
            reply,
        })
    }

    /// Empty while the bytes have not arrived, `None` when the node has no
    /// picture at all.
    pub fn image_hash(&self, node_id: &str) -> Result<Option<String>, StorageError> {
        self.request(|reply| Request::ImageHash {
            node_id: node_id.to_owned(),
            reply,
        })
    }

    /// What this app last dealt with at that path — what it wrote, or what it
    /// refused. Either answer keeps a file from being read again on every
    /// event the transport delivers for it.
    pub fn vault_file_hash(&self, relative: &str) -> Result<Option<String>, StorageError> {
        self.request(|reply| Request::VaultFileHash {
            relative: relative.to_owned(),
            reply,
        })
    }

    /// How many rows are still waiting to be written out.
    pub fn pending_count(&self) -> Result<i64, StorageError> {
        self.request(|reply| Request::PendingCount { reply })
    }

    /// Reads every document in the vault back in, ignoring what the records say
    /// about them. Refused while this device is still holding edits.
    pub fn reindex_vault(
        &self,
        vault_root: &std::path::Path,
    ) -> Result<crate::sync_merge::ReindexReport, StorageError> {
        self.request(|reply| Request::ReindexVault {
            vault_root: vault_root.to_path_buf(),
            reply,
        })
    }

    /// Throws the cached notes away and fills them in again from the folder.
    /// Refused, before anything is cleared, while this device is still holding
    /// edits the folder has not been told about.
    pub fn rebuild_from_vault(
        &self,
        vault_root: &std::path::Path,
    ) -> Result<crate::sync_merge::ReindexReport, StorageError> {
        self.request(|reply| Request::RebuildFromVault {
            vault_root: vault_root.to_path_buf(),
            reply,
        })
    }

    /// Writes everything waiting into the vault, answering how many documents
    /// actually changed on disk.
    /// `store_root` is this app's own image store: the vault's copy of an
    /// attachment is made from it, and it is where the bytes stay.
    pub fn export_pending(
        &self,
        vault_root: &std::path::Path,
        store_root: &std::path::Path,
    ) -> Result<usize, StorageError> {
        self.request(|reply| Request::ExportPending {
            vault_root: vault_root.to_path_buf(),
            store_root: store_root.to_path_buf(),
            reply,
        })
    }

    /// Which sibling a node claims to follow, and when it said so.
    pub fn place_claim(&self, id: &str) -> Result<Option<(String, String)>, StorageError> {
        self.request(|reply| Request::PlaceClaim {
            id: id.to_owned(),
            reply,
        })
    }

    /// What one of them said, for whoever is putting it back.
    /// Drops one recorded defeat. Answers whether there was one to drop.
    pub fn forget_conflict(&self, seq: i64) -> Result<bool, StorageError> {
        self.request(|reply| Request::ForgetConflict { seq, reply })
    }

    pub fn conflict_loser(&self, seq: i64) -> Result<Option<(String, String)>, StorageError> {
        self.request(|reply| Request::ConflictLoser { seq, reply })
    }

    pub fn revision(&self) -> Result<u64, StorageError> {
        self.request(|reply| Request::Revision { reply })
    }

    /// Writes the guide notes, unless this database already holds notes or has
    /// been given them before. Called once the folder these notes live in has
    /// been settled — see `Request::SeedOnboarding`.
    pub fn seed_onboarding(&self) -> Result<(), StorageError> {
        self.request(|reply| Request::SeedOnboarding { reply })
    }

    /// Records that the user has said where these notes live. No guide is
    /// written — see `seed::mark_onboarding_answered`.
    pub fn mark_onboarding_answered(&self) -> Result<(), StorageError> {
        self.request(|reply| Request::MarkOnboardingAnswered { reply })
    }

    /// Whether the user has yet to say where these notes live.
    pub fn onboarding_first_run(&self) -> Result<bool, StorageError> {
        self.request(|reply| Request::OnboardingFirstRun { reply })
    }

    pub fn node(&self, id: &str) -> Result<Option<NoteNode>, StorageError> {
        self.request(|reply| Request::Node {
            id: id.to_owned(),
            reply,
        })
    }

    pub fn live_image_hashes(&self) -> Result<BTreeSet<String>, StorageError> {
        self.request(|reply| Request::LiveImageHashes { reply })
    }

    pub fn bootstrap(
        &self,
        session_id: impl Into<String>,
        viewport_limit: u32,
    ) -> Result<BootSnapshot, StorageError> {
        self.request(|reply| Request::Bootstrap {
            session_id: session_id.into(),
            viewport_limit,
            reply,
        })
    }

    pub fn query_viewport(&self, request: ViewportRequest) -> Result<ViewportPage, StorageError> {
        self.request(|reply| Request::Viewport { request, reply })
    }

    pub fn query_forest(&self, request: ForestRequest) -> Result<ForestSnapshot, StorageError> {
        self.request(|reply| Request::Forest { request, reply })
    }

    pub fn search(&self, request: SearchQuery) -> Result<SearchPage, StorageError> {
        self.request(|reply| Request::Search { request, reply })
    }

    pub fn optimize(&self) -> Result<(), StorageError> {
        self.request(|reply| Request::Optimize { reply })
    }

    fn export_snapshot(
        &self,
        expected_revision: u64,
        root_id: &notes_core::NodeId,
    ) -> Result<ExportSnapshot, ExportError> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.sender
            .send(Request::ExportSnapshot {
                expected_revision,
                root_id: root_id.to_string(),
                reply,
            })
            .map_err(|error| StorageError::Unavailable(error.to_string()))?;
        receiver
            .recv()
            .map_err(|error| StorageError::Unavailable(error.to_string()))?
    }

    #[cfg(feature = "bench-fixtures")]
    pub fn load_performance_fixture(&self, node_count: usize) -> Result<(), StorageError> {
        self.request(|reply| Request::LoadFixture { node_count, reply })
    }

    fn start(location: DatabaseLocation) -> Result<Self, StorageError> {
        let (sender, receiver) = mpsc::sync_channel(64);
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("notes-v2-db".into())
            .spawn(move || {
                if let DatabaseLocation::File(path) = &location {
                    schema::remake_if_an_older_build_made_it(path);
                }
                let connection = match location {
                    DatabaseLocation::File(path) => Connection::open(path),
                    DatabaseLocation::Memory => Connection::open_in_memory(),
                }
                .map_err(|error| StorageError::Unavailable(error.to_string()))
                .and_then(|mut connection| {
                    schema::initialize(&mut connection)?;
                    // Between the schema and the first row: the tables have to
                    // exist to read the device from, and the stamping triggers
                    // call `yona_hlc()` on every insert after this point.
                    let clock = Arc::new(
                        Clock::new(&ensure_device_id(&connection)?)
                            .map_err(StorageError::Internal)?,
                    );
                    hlc::register(&connection, Arc::clone(&clock))
                        .map_err(StorageError::Internal)?;
                    // Before anything writes. The seed and the root repair both
                    // stamp, and stamping from a clock that has not caught up to
                    // the stored readings is the non-monotonicity the reseed
                    // exists to prevent. It only reads, so on a first boot this
                    // is a no-op against empty tables.
                    hlc::reseed(&clock, &connection).map_err(StorageError::Internal)?;
                    // The guide is not written here. Opening the database
                    // happens before the app knows what folder these notes
                    // live in, and a device joining a folder that already holds
                    // notes must not be handed a fresh reading for every line
                    // the guide occupies — that reading beats whatever the
                    // other device said, deletions included. `seed_onboarding`
                    // is called once that folder has been settled.
                    schema::ensure_root(&mut connection)?;
                    Ok((connection, clock))
                });
                let (mut connection, clock) = match connection {
                    Ok(ready) => {
                        let _ = ready_sender.send(Ok(()));
                        ready
                    }
                    Err(error) => {
                        let _ = ready_sender.send(Err(error));
                        return;
                    }
                };
                while let Ok(request) = receiver.recv() {
                    match request {
                        Request::Load { command, reply } => {
                            let _ =
                                reply.send(repository::load_command_tree(&connection, &command));
                        }
                        Request::Commit {
                            expected_revision,
                            patch,
                            reply,
                        } => {
                            let _ = reply.send(crate::mutations::commit(
                                &mut connection,
                                expected_revision,
                                &patch,
                            ));
                        }
                        Request::MergeDocument { file, input, reply } => {
                            let _ = reply.send(crate::sync_merge::merge(
                                &mut connection,
                                &clock,
                                &file,
                                &input,
                            ));
                        }
                        Request::SetDeviceName { name, reply } => {
                            let _ =
                                reply.send(ensure_device_id(&connection).and_then(|device_id| {
                                    crate::sync_merge::set_device_name(
                                        &connection,
                                        &device_id,
                                        &name,
                                    )
                                }));
                        }
                        Request::Conflicts { limit, reply } => {
                            let _ = reply.send(crate::sync_merge::conflicts(&connection, limit));
                        }
                        Request::Attachments { limit, reply } => {
                            let _ =
                                reply.send(crate::attachment_list::attachments(&connection, limit));
                        }
                        Request::DeleteAttachment {
                            content_hash,
                            vault_root,
                            reply,
                        } => {
                            let _ = reply.send(crate::attachment_list::delete_attachment(
                                &mut connection,
                                &content_hash,
                                vault_root.as_deref(),
                            ));
                        }
                        Request::RefusedFiles { reply } => {
                            let _ = reply.send(
                                connection
                                    .prepare_cached(
                                        "SELECT relative_path, reason FROM sync_quarantine
                                         ORDER BY relative_path",
                                    )
                                    .and_then(|mut statement| {
                                        let rows = statement.query_map([], |row| {
                                            Ok(notes_application::RefusedFile {
                                                path: row.get(0)?,
                                                reason: row.get(1)?,
                                            })
                                        })?;
                                        rows.collect::<Result<Vec<_>, _>>()
                                    })
                                    .map_err(|error| StorageError::Internal(error.to_string())),
                            );
                        }
                        Request::VaultStatRecords { reply } => {
                            let _ = reply.send(
                                connection
                                    .prepare_cached(
                                        "SELECT folder_path, exported_hash,
                                                file_mtime_ms, file_size
                                         FROM sync_documents",
                                    )
                                    .and_then(|mut statement| {
                                        let rows = statement.query_map([], |row| {
                                            Ok((
                                                row.get::<_, String>(0)?,
                                                notes_sync::intake::Known {
                                                    recorded_hash: row.get(1)?,
                                                    file_mtime_ms: row.get(2)?,
                                                    file_size: row.get(3)?,
                                                },
                                            ))
                                        })?;
                                        rows.collect::<Result<Vec<_>, _>>()
                                    })
                                    .map_err(|error| StorageError::Internal(error.to_string())),
                            );
                        }
                        Request::ForgetMissingRefusals { present, reply } => {
                            let _ = reply.send(
                                connection
                                    .execute(
                                        "DELETE FROM sync_quarantine
                                         WHERE relative_path NOT IN
                                             (SELECT value FROM json_each(?1))",
                                        [notes_sync::export::json_list(&present)],
                                    )
                                    .map_err(|error| StorageError::Internal(error.to_string())),
                            );
                        }
                        Request::AssetKnown { location, reply } => {
                            let _ = reply.send(
                                connection
                                    .query_row(
                                        "SELECT 1 FROM sync_assets WHERE location = ?1",
                                        [&location],
                                        |_| Ok(()),
                                    )
                                    .optional()
                                    .map(|found| found.is_some())
                                    .map_err(|error| StorageError::Internal(error.to_string())),
                            );
                        }
                        Request::Quarantine {
                            relative,
                            file_hash,
                            reason,
                            reply,
                        } => {
                            let _ = reply.send(
                                connection
                                    .execute(
                                        "INSERT INTO sync_quarantine(
                                             relative_path, file_hash, reason, noticed_at)
                                         VALUES (?1, ?2, ?3, unixepoch())
                                         ON CONFLICT(relative_path) DO UPDATE SET
                                             file_hash = excluded.file_hash,
                                             reason = excluded.reason,
                                             noticed_at = excluded.noticed_at",
                                        rusqlite::params![&relative, &file_hash, &reason],
                                    )
                                    .map(|_| ())
                                    .map_err(|error| StorageError::Internal(error.to_string())),
                            );
                        }
                        Request::ResolveAsset {
                            disk_name,
                            content_hash,
                            location,
                            reply,
                        } => {
                            let _ = reply.send(crate::sync_merge::resolve_asset(
                                &mut connection,
                                &disk_name,
                                &content_hash,
                                &location,
                            ));
                        }
                        Request::ImageHash { node_id, reply } => {
                            let _ = reply.send(
                                connection
                                    .query_row(
                                        "SELECT content_hash FROM notes_images WHERE node_id = ?1",
                                        [&node_id],
                                        |row| row.get::<_, String>(0),
                                    )
                                    .optional()
                                    .map_err(|error| StorageError::Internal(error.to_string())),
                            );
                        }
                        Request::VaultFileHash { relative, reply } => {
                            let _ = reply.send(
                                connection
                                    .query_row(
                                        // Either answer keeps a file from being
                                        // read again: what this app wrote, and
                                        // what it looked at and could not read.
                                        // The refusal first: it records the
                                        // most recent look at that path, and a
                                        // merge that reads the file takes it
                                        // back. Answering with the document's
                                        // hash instead would have the sweep
                                        // re-read and re-refuse the same
                                        // unreadable bytes every minute.
                                        "SELECT file_hash FROM sync_quarantine
                                         WHERE relative_path = ?1
                                         UNION ALL
                                         SELECT exported_hash FROM sync_documents
                                         WHERE folder_path = ?1
                                         LIMIT 1",
                                        [&relative],
                                        |row| row.get::<_, String>(0),
                                    )
                                    .optional()
                                    .map(|hash| hash.filter(|hash| !hash.is_empty()))
                                    .map_err(|error| StorageError::Internal(error.to_string())),
                            );
                        }
                        Request::PendingCount { reply } => {
                            let _ = reply.send(
                                connection
                                    .query_row("SELECT count(*) FROM sync_dirty_nodes", [], |row| {
                                        row.get::<_, i64>(0)
                                    })
                                    .map_err(|error| StorageError::Internal(error.to_string())),
                            );
                        }
                        Request::RebuildFromVault { vault_root, reply } => {
                            let _ = reply.send(crate::sync_merge::rebuild_from_vault(
                                &mut connection,
                                &clock,
                                &vault_root,
                            ));
                        }
                        Request::ReindexVault { vault_root, reply } => {
                            let _ = reply.send(crate::sync_merge::reindex_vault(
                                &mut connection,
                                &clock,
                                &vault_root,
                            ));
                        }
                        Request::ExportPending {
                            vault_root,
                            store_root,
                            reply,
                        } => {
                            let _ = reply.send(crate::sync_merge::export_pending(
                                &mut connection,
                                &vault_root,
                                &store_root,
                            ));
                        }
                        Request::PlaceClaim { id, reply } => {
                            let _ = reply.send(
                                connection
                                    .query_row(
                                        "SELECT sync_prev, sync_prev_hlc FROM notes_nodes
                                         WHERE id = ?1",
                                        [&id],
                                        |row| Ok((row.get(0)?, row.get(1)?)),
                                    )
                                    .optional()
                                    .map_err(|error| StorageError::Internal(error.to_string())),
                            );
                        }
                        Request::ConflictLoser { seq, reply } => {
                            let _ = reply.send(crate::sync_merge::conflict_loser(&connection, seq));
                        }
                        Request::ForgetConflict { seq, reply } => {
                            let _ =
                                reply.send(crate::sync_merge::forget_conflict(&connection, seq));
                        }
                        Request::Revision { reply } => {
                            let _ = reply.send(repository::revision(&connection));
                        }
                        Request::SeedOnboarding { reply } => {
                            // Then the root repair, which is what adopts a
                            // top-level page as a child of home — the guide is
                            // written as a page like any other and needs the
                            // same adoption an imported one gets.
                            let _ = reply.send(
                                crate::seed::seed_onboarding(&mut connection)
                                    .and_then(|()| schema::ensure_root(&mut connection)),
                            );
                        }
                        Request::MarkOnboardingAnswered { reply } => {
                            let _ = reply.send(crate::seed::mark_onboarding_answered(&connection));
                        }
                        Request::OnboardingFirstRun { reply } => {
                            let _ = reply.send(crate::seed::onboarding_first_run(&connection));
                        }
                        Request::NodePath { id, reply } => {
                            let _ = reply.send(
                                connection
                                    .query_row(
                                        "SELECT path FROM notes_nodes WHERE id = ?1",
                                        [&id],
                                        |row| row.get::<_, Option<String>>(0),
                                    )
                                    .optional()
                                    .map(Option::flatten)
                                    .map_err(|error| StorageError::Internal(error.to_string())),
                            );
                        }
                        Request::Node { id, reply } => {
                            let _ = reply.send(repository::node(&connection, &id));
                        }
                        Request::LiveImageHashes { reply } => {
                            let _ = reply.send(repository::live_image_hashes(&connection));
                        }
                        Request::Bootstrap {
                            session_id,
                            viewport_limit,
                            reply,
                        } => {
                            let _ = reply.send(queries::bootstrap(
                                &connection,
                                session_id,
                                viewport_limit,
                            ));
                        }
                        Request::Viewport { request, reply } => {
                            let _ = reply.send(queries::viewport(&connection, request));
                        }
                        Request::Forest { request, reply } => {
                            let _ = reply.send(forest_queries::forest(&connection, request));
                        }
                        Request::Search { request, reply } => {
                            let _ = reply.send(queries::search(&connection, request));
                        }
                        Request::ExportSnapshot {
                            expected_revision,
                            root_id,
                            reply,
                        } => {
                            let result = notes_core::NodeId::try_from(root_id)
                                .map_err(|error| ExportError::Failed(error.to_string()))
                                .and_then(|root_id| {
                                    crate::export_snapshot::load(
                                        &mut connection,
                                        expected_revision,
                                        &root_id,
                                    )
                                });
                            let _ = reply.send(result);
                        }
                        Request::Optimize { reply } => {
                            let result = connection
                                .execute_batch("PRAGMA optimize;")
                                .map_err(|error| StorageError::Internal(error.to_string()));
                            let _ = reply.send(result);
                        }
                        #[cfg(feature = "bench-fixtures")]
                        Request::LoadFixture { node_count, reply } => {
                            let _ = reply.send(crate::fixtures::load_performance_fixture(
                                &mut connection,
                                node_count,
                            ));
                        }
                        Request::Shutdown => break,
                    }
                }
            })
            .map_err(|error| StorageError::Unavailable(error.to_string()))?;
        ready_receiver
            .recv()
            .map_err(|error| StorageError::Unavailable(error.to_string()))??;
        Ok(Self {
            sender,
            worker: Some(worker),
        })
    }

    fn request<T>(
        &self,
        request: impl FnOnce(SyncSender<Result<T, StorageError>>) -> Request,
    ) -> Result<T, StorageError> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.sender
            .send(request(reply))
            .map_err(|error| StorageError::Unavailable(error.to_string()))?;
        receiver
            .recv()
            .map_err(|error| StorageError::Unavailable(error.to_string()))?
    }
}

impl StoragePort for SqliteStorage {
    fn load_command_tree(&self, command: &NotesCommand) -> Result<NotesTree, StorageError> {
        self.request(|reply| Request::Load {
            command: command.clone(),
            reply,
        })
    }

    fn load_node(&self, id: &notes_core::NodeId) -> Result<Option<NoteNode>, StorageError> {
        self.node(id.as_str())
    }

    fn live_image_hashes(&self) -> Result<BTreeSet<String>, StorageError> {
        SqliteStorage::live_image_hashes(self)
    }

    fn commit(
        &self,
        expected_revision: u64,
        patch: &DomainPatch,
    ) -> Result<StorageCommit, StorageError> {
        self.request(|reply| Request::Commit {
            expected_revision,
            patch: patch.clone(),
            reply,
        })
    }
}

impl ExportSnapshotPort for SqliteStorage {
    fn load_export_snapshot(
        &self,
        expected_revision: u64,
        root_id: &notes_core::NodeId,
    ) -> Result<ExportSnapshot, ExportError> {
        self.export_snapshot(expected_revision, root_id)
    }
}

impl Drop for SqliteStorage {
    fn drop(&mut self) {
        let _ = self.sender.send(Request::Shutdown);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
