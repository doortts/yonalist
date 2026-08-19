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
            carried_pictures: Vec::new(),
            group: Some(index.to_string()),
            completed_rows: None,
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

/// A coalesced entry covers more than one gesture, so its inverse is no longer
/// what a single tick found: the rows it named must stop reading as a tick that
/// can be taken back.
#[test]
fn coalescing_into_an_entry_forgets_the_rows_a_tick_named() {
    let mut session = SessionState::new("session-1".into(), 0);
    let row = NodeId::try_from("row").expect("valid node id");
    session.record_history(NotesServiceHistoryEntry {
        forward: Vec::new(),
        inverse: Vec::new(),
        carried_pictures: Vec::new(),
        group: Some("gesture".into()),
        completed_rows: Some(vec![row.clone()]),
    });
    assert_eq!(
        session
            .undo
            .last()
            .and_then(|entry| entry.completed_rows.clone()),
        Some(vec![row])
    );

    session.record_history(NotesServiceHistoryEntry {
        forward: Vec::new(),
        inverse: Vec::new(),
        carried_pictures: Vec::new(),
        group: Some("gesture".into()),
        completed_rows: None,
    });

    assert_eq!(session.undo.len(), 1);
    assert!(
        session
            .undo
            .last()
            .is_some_and(|entry| entry.completed_rows.is_none())
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
            carried_pictures: Vec::new(),
            group: Some("typing:node".into()),
            completed_rows: None,
        });
    }

    assert_eq!(session.undo.len(), 2);
    assert!(session.undo.iter().all(|entry| {
        entry.forward.len() <= MAX_HISTORY_MUTATIONS_PER_ENTRY
            && entry.inverse.len() <= MAX_HISTORY_MUTATIONS_PER_ENTRY
    }));
}
