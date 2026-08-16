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
    Conflicts {
        limit: u32,
        reply: SyncSender<Result<Vec<notes_application::SyncConflict>, StorageError>>,
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
    Revision {
        reply: SyncSender<Result<u64, StorageError>>,
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
    let device_id = uuid::Uuid::new_v4().simple().to_string()[..4].to_owned();
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

    /// The defeats this vault has recorded, newest first.
    pub fn sync_conflicts(
        &self,
        limit: u32,
    ) -> Result<Vec<notes_application::SyncConflict>, StorageError> {
        self.request(|reply| Request::Conflicts { limit, reply })
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
    pub fn conflict_loser(&self, seq: i64) -> Result<Option<(String, String)>, StorageError> {
        self.request(|reply| Request::ConflictLoser { seq, reply })
    }

    pub fn revision(&self) -> Result<u64, StorageError> {
        self.request(|reply| Request::Revision { reply })
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
                let seed_onboarding = matches!(location, DatabaseLocation::File(_));
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
                    if seed_onboarding {
                        crate::seed::seed_onboarding(&mut connection)?;
                    }
                    // After the seed so the onboarding page is adopted like any
                    // other legacy top-level page.
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
                        Request::Conflicts { limit, reply } => {
                            let _ = reply.send(crate::sync_merge::conflicts(&connection, limit));
                        }
                        Request::VaultFileHash { relative, reply } => {
                            let _ = reply.send(
                                connection
                                    .query_row(
                                        "SELECT exported_hash FROM sync_documents
                                         WHERE folder_path = ?1",
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
                        Request::Revision { reply } => {
                            let _ = reply.send(repository::revision(&connection));
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
