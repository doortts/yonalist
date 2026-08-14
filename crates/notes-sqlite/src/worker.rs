use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, SyncSender};
use std::thread::{self, JoinHandle};

use notes_application::{
    BootSnapshot, ExportError, ExportSnapshot, ExportSnapshotPort, ForestRequest, ForestSnapshot,
    SearchPage, SearchQuery, StorageCommit, StorageError, StoragePort, ViewportPage,
    ViewportRequest,
};
use notes_core::{DomainPatch, NoteNode, NotesCommand, NotesTree};
use rusqlite::Connection;

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
    Revision {
        reply: SyncSender<Result<u64, StorageError>>,
    },
    Node {
        id: String,
        reply: SyncSender<Result<Option<NoteNode>, StorageError>>,
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

impl SqliteStorage {
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        Self::start(DatabaseLocation::File(path.to_path_buf()))
    }

    pub fn open_in_memory() -> Result<Self, StorageError> {
        Self::start(DatabaseLocation::Memory)
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
                    if seed_onboarding {
                        crate::seed::seed_onboarding(&mut connection)?;
                    }
                    // After the seed so the onboarding page is adopted like any
                    // other legacy top-level page.
                    schema::ensure_root(&mut connection)?;
                    Ok(connection)
                });
                let mut connection = match connection {
                    Ok(connection) => {
                        let _ = ready_sender.send(Ok(()));
                        connection
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
                        Request::Revision { reply } => {
                            let _ = reply.send(repository::revision(&connection));
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
