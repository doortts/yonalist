use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, PoisonError};

use notes_core::{DomainPatch, TreeMutation};

use crate::{
    CommandEnvelope, HistoryRequest, HistoryState, MutationReceipt, NoteView, NotesError,
    StorageCommit, StoragePort,
};

const MAX_HISTORY_ENTRIES: usize = 1_000;
const MAX_HISTORY_MUTATIONS_PER_ENTRY: usize = 256;
const MAX_COMPLETED_REQUESTS: usize = 4_096;

#[derive(Clone)]
pub(crate) struct NotesServiceHistoryEntry {
    forward: Vec<TreeMutation>,
    inverse: Vec<TreeMutation>,
    group: Option<String>,
}

struct SessionState {
    session_id: String,
    revision: u64,
    undo: Vec<NotesServiceHistoryEntry>,
    redo: Vec<NotesServiceHistoryEntry>,
    completed_requests: HashMap<String, MutationReceipt>,
    completed_request_order: VecDeque<String>,
}

impl SessionState {
    fn new(session_id: String, revision: u64) -> Self {
        Self {
            session_id,
            revision,
            undo: Vec::new(),
            redo: Vec::new(),
            completed_requests: HashMap::new(),
            completed_request_order: VecDeque::new(),
        }
    }

    fn record_history(&mut self, entry: NotesServiceHistoryEntry) {
        if entry.group.is_some()
            && self.undo.last().is_some_and(|previous| {
                previous.group == entry.group
                    && previous.forward.len().saturating_add(entry.forward.len())
                        <= MAX_HISTORY_MUTATIONS_PER_ENTRY
                    && previous.inverse.len().saturating_add(entry.inverse.len())
                        <= MAX_HISTORY_MUTATIONS_PER_ENTRY
            })
        {
            let previous = self.undo.last_mut().expect("history entry exists");
            previous.forward.extend(entry.forward);
            let mut combined_inverse = entry.inverse;
            combined_inverse.extend(std::mem::take(&mut previous.inverse));
            previous.inverse = combined_inverse;
        } else {
            push_bounded_history(&mut self.undo, entry);
        }
        self.redo.clear();
    }

    fn record_completed(&mut self, request_id: String, receipt: MutationReceipt) {
        if self.completed_requests.contains_key(&request_id) {
            self.completed_requests.insert(request_id, receipt);
            return;
        }
        self.completed_request_order.push_back(request_id.clone());
        self.completed_requests.insert(request_id, receipt);
        while self.completed_request_order.len() > MAX_COMPLETED_REQUESTS {
            if let Some(expired) = self.completed_request_order.pop_front() {
                self.completed_requests.remove(&expired);
            }
        }
    }
}

fn push_bounded_history(
    history: &mut Vec<NotesServiceHistoryEntry>,
    entry: NotesServiceHistoryEntry,
) {
    history.push(entry);
    if history.len() > MAX_HISTORY_ENTRIES {
        history.remove(0);
    }
}

pub struct NotesService<S: StoragePort> {
    storage: S,
    session: Mutex<SessionState>,
}

impl<S: StoragePort> NotesService<S> {
    pub fn new(storage: S, session_id: impl Into<String>, revision: u64) -> Self {
        Self {
            storage,
            session: Mutex::new(SessionState::new(session_id.into(), revision)),
        }
    }

    pub fn execute(&self, envelope: CommandEnvelope) -> Result<MutationReceipt, NotesError> {
        let mut session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        self.ensure_session(&session, &envelope.session_id)?;
        if let Some(receipt) = session.completed_requests.get(&envelope.request_id) {
            return Ok(receipt.clone());
        }
        self.ensure_revision(&session, envelope.base_revision)?;
        let history_group = envelope.history_group;
        let request_id = envelope.request_id;
        let command = envelope.command.try_into()?;
        let tree = self.storage.load_command_tree(&command)?;
        let patch = tree.plan(command)?;
        let commit = self.storage.commit(session.revision, &patch)?;
        session.revision = commit.revision;
        let entry = NotesServiceHistoryEntry {
            forward: patch.forward,
            inverse: patch.inverse,
            group: history_group.clone(),
        };
        session.record_history(entry);
        let receipt = Self::receipt(&session, commit);
        session.record_completed(request_id, receipt.clone());
        Ok(receipt)
    }

    pub fn undo(&self, request: HistoryRequest) -> Result<MutationReceipt, NotesError> {
        let mut session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        self.ensure_session(&session, &request.session_id)?;
        self.ensure_revision(&session, request.base_revision)?;
        let entry = session
            .undo
            .last()
            .cloned()
            .ok_or_else(NotesError::history_empty)?;
        let commit = self.storage.commit(
            session.revision,
            &DomainPatch {
                forward: entry.inverse.clone(),
                inverse: entry.forward.clone(),
            },
        )?;
        session.undo.pop();
        push_bounded_history(&mut session.redo, entry);
        session.revision = commit.revision;
        Ok(Self::receipt(&session, commit))
    }

    pub fn redo(&self, request: HistoryRequest) -> Result<MutationReceipt, NotesError> {
        let mut session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        self.ensure_session(&session, &request.session_id)?;
        self.ensure_revision(&session, request.base_revision)?;
        let entry = session
            .redo
            .last()
            .cloned()
            .ok_or_else(NotesError::history_empty)?;
        let commit = self.storage.commit(
            session.revision,
            &DomainPatch {
                forward: entry.forward.clone(),
                inverse: entry.inverse.clone(),
            },
        )?;
        session.redo.pop();
        push_bounded_history(&mut session.undo, entry);
        session.revision = commit.revision;
        Ok(Self::receipt(&session, commit))
    }

    fn ensure_session(&self, session: &SessionState, session_id: &str) -> Result<(), NotesError> {
        if session.session_id == session_id {
            Ok(())
        } else {
            Err(NotesError::session_mismatch())
        }
    }

    fn ensure_revision(&self, session: &SessionState, revision: u64) -> Result<(), NotesError> {
        if session.revision == revision {
            Ok(())
        } else {
            Err(crate::StorageError::RevisionConflict {
                expected: revision,
                actual: session.revision,
            }
            .into())
        }
    }

    fn receipt(session: &SessionState, commit: StorageCommit) -> MutationReceipt {
        MutationReceipt {
            revision: commit.revision,
            changed_nodes: commit
                .changed_nodes
                .into_iter()
                .map(NoteView::from)
                .collect(),
            deleted_ids: commit
                .deleted_ids
                .into_iter()
                .map(|id| id.to_string())
                .collect(),
            history: HistoryState {
                can_undo: !session.undo.is_empty(),
                can_redo: !session.redo.is_empty(),
                undo_depth: session.undo.len() as u32,
                redo_depth: session.redo.len() as u32,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_COMPLETED_REQUESTS, MAX_HISTORY_ENTRIES, MAX_HISTORY_MUTATIONS_PER_ENTRY,
        NotesServiceHistoryEntry, SessionState,
    };
    use crate::{HistoryState, MutationReceipt};
    use notes_core::{NodeId, TreeMutation};

    fn empty_receipt(revision: u64) -> MutationReceipt {
        MutationReceipt {
            revision,
            changed_nodes: Vec::new(),
            deleted_ids: Vec::new(),
            history: HistoryState {
                can_undo: false,
                can_redo: false,
                undo_depth: 0,
                redo_depth: 0,
            },
        }
    }

    #[test]
    fn session_history_and_idempotency_cache_are_bounded() {
        let mut session = SessionState::new("session-1".into(), 0);
        for index in 0..=MAX_HISTORY_ENTRIES {
            session.record_history(NotesServiceHistoryEntry {
                forward: Vec::new(),
                inverse: Vec::new(),
                group: Some(index.to_string()),
            });
        }
        for index in 0..=MAX_COMPLETED_REQUESTS {
            session.record_completed(index.to_string(), empty_receipt(index as u64));
        }

        assert_eq!(session.undo.len(), MAX_HISTORY_ENTRIES);
        assert_eq!(session.completed_requests.len(), MAX_COMPLETED_REQUESTS);
        assert!(!session.completed_requests.contains_key("0"));
        assert!(
            session
                .completed_requests
                .contains_key(&MAX_COMPLETED_REQUESTS.to_string())
        );
    }

    #[test]
    fn a_single_coalesced_history_group_cannot_grow_without_bound() {
        let mut session = SessionState::new("session-1".into(), 0);
        for index in 0..=MAX_HISTORY_MUTATIONS_PER_ENTRY {
            let mutation = TreeMutation::Delete {
                id: NodeId::try_from(format!("node-{index}")).expect("valid node id"),
            };
            session.record_history(NotesServiceHistoryEntry {
                forward: vec![mutation.clone()],
                inverse: vec![mutation],
                group: Some("typing:node".into()),
            });
        }

        assert_eq!(session.undo.len(), 2);
        assert!(session.undo.iter().all(|entry| {
            entry.forward.len() <= MAX_HISTORY_MUTATIONS_PER_ENTRY
                && entry.inverse.len() <= MAX_HISTORY_MUTATIONS_PER_ENTRY
        }));
    }
}
