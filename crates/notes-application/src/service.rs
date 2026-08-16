use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, PoisonError};

use notes_core::{
    DomainError, DomainPatch, ImportImageNode, NodeId, NoteImage, NoteNodeKind, NotesCommand,
    Position, TreeMutation,
};

use crate::{
    CommandEnvelope, HistoryRequest, HistoryState, ImageAssetPort, ImageImportContext,
    ImageImportSource, ImageReadRequest, ImageReplaceContext, ImageSource, MutationReceipt,
    NoteView, NotesError, PublishedImage, StorageCommit, StoragePort,
};

mod export;

const MAX_HISTORY_ENTRIES: usize = 1_000;
const MAX_HISTORY_MUTATIONS_PER_ENTRY: usize = 256;
const MAX_COMPLETED_REQUESTS: usize = 4_096;

#[derive(Clone)]
pub(crate) struct NotesServiceHistoryEntry {
    forward: Vec<TreeMutation>,
    inverse: Vec<TreeMutation>,
    /// Only a redo replays these. The mutations alone cannot put a duplicated
    /// picture back: the copy's node carries no picture, which is why the
    /// duplication had to name one in the first place.
    carried_pictures: Vec<(NodeId, NodeId)>,
    group: Option<String>,
}

struct SessionState {
    session_id: String,
    revision: u64,
    /// How far down the undo stack this session may still go. A merge that
    /// landed on a node an entry touches raises this above that entry: undoing
    /// it would replay an inverse recorded against a state that has since
    /// moved, throwing the other device's change away without saying so.
    undo_floor: usize,
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
            undo_floor: 0,
            undo: Vec::new(),
            redo: Vec::new(),
            completed_requests: HashMap::new(),
            completed_request_order: VecDeque::new(),
        }
    }

    fn record_history(&mut self, entry: NotesServiceHistoryEntry) {
        // Never into an entry the barrier has already blocked: what the user
        // types after a merge is theirs to take back, and folding it into an
        // unreachable entry would take that away with nothing said.
        if entry.group.is_some()
            && self.undo.len() > self.undo_floor
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
            previous.carried_pictures.extend(entry.carried_pictures);
        } else {
            // The floor is a position in this stack, so it moves down with it
            // when the oldest entry is dropped.
            if push_bounded_history(&mut self.undo, entry) {
                self.undo_floor = self.undo_floor.saturating_sub(1);
            }
        }
        self.redo.clear();
    }

    fn record_completed(&mut self, request_id: String, receipt: MutationReceipt) {
        if let Some(previous) = self.completed_requests.get_mut(&request_id) {
            *previous = receipt;
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

fn entry_touches(entry: &NotesServiceHistoryEntry, affected: &HashSet<&str>) -> bool {
    entry
        .forward
        .iter()
        .chain(entry.inverse.iter())
        .any(|mutation| match mutation {
            TreeMutation::Upsert(node) => affected.contains(node.id().as_str()),
            TreeMutation::Delete { id } => affected.contains(id.as_str()),
        })
}

/// Answers whether the oldest entry was dropped to make room.
fn push_bounded_history(
    history: &mut Vec<NotesServiceHistoryEntry>,
    entry: NotesServiceHistoryEntry,
) -> bool {
    history.push(entry);
    if history.len() > MAX_HISTORY_ENTRIES {
        history.remove(0);
        return true;
    }
    false
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

    /// No asset store: production goes through `execute_with_assets`.
    pub fn execute(&self, envelope: CommandEnvelope) -> Result<MutationReceipt, NotesError> {
        self.execute_envelope(envelope, |command| {
            // With no asset store there is nothing to weigh a referenced image
            // hash against, so this entry point takes only commands without one.
            if referenced_images(command).next().is_some() {
                return Err(invalid_image_request(
                    "An imported image reference needs the asset-aware command path.",
                ));
            }
            Ok(())
        })
    }

    pub fn execute_with_assets<A: ImageAssetPort>(
        &self,
        envelope: CommandEnvelope,
        assets: &A,
    ) -> Result<MutationReceipt, NotesError> {
        self.execute_envelope(envelope, |command| {
            // One stale hash rejects the whole paste: half an outline is worse
            // than a clear failure.
            for image in referenced_images(command) {
                if !assets.contains(image) {
                    return Err(invalid_image_request(
                        "A pasted image is no longer in the image store.",
                    ));
                }
            }
            Ok(())
        })
    }

    fn execute_envelope(
        &self,
        envelope: CommandEnvelope,
        validate: impl FnOnce(&NotesCommand) -> Result<(), NotesError>,
    ) -> Result<MutationReceipt, NotesError> {
        let mut session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        self.ensure_session(&session, &envelope.session_id)?;
        if let Some(receipt) = session.completed_requests.get(&envelope.request_id) {
            return Ok(receipt.clone());
        }
        self.ensure_revision(&session, envelope.base_revision)?;
        let command = envelope.command.try_into()?;
        validate(&command)?;
        self.execute_checked(
            &mut session,
            envelope.request_id,
            envelope.history_group,
            command,
        )
    }

    pub fn import_images<A: ImageAssetPort>(
        &self,
        context: ImageImportContext,
        sources: Vec<ImageImportSource>,
        assets: &A,
    ) -> Result<MutationReceipt, NotesError> {
        let mut session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        self.ensure_session(&session, &context.session_id)?;
        if let Some(receipt) = session.completed_requests.get(&context.request_id) {
            return Ok(receipt.clone());
        }
        self.ensure_revision(&session, context.base_revision)?;
        validate_image_sources(&context, &sources)?;

        let published = assets.prepare(&sources)?;
        let command = match image_import_command(&context, &sources, &published) {
            Ok(command) => command,
            Err(error) => {
                rollback_new_assets(assets, &published);
                return Err(error);
            }
        };
        match self.execute_checked(
            &mut session,
            context.request_id,
            context.history_group,
            command,
        ) {
            Ok(receipt) => Ok(receipt),
            Err(error) => {
                rollback_new_assets(assets, &published);
                Err(error)
            }
        }
    }

    pub fn read_image<A: ImageAssetPort>(
        &self,
        request: ImageReadRequest,
        assets: &A,
    ) -> Result<Vec<u8>, NotesError> {
        self.read_image_asset(request, assets)
            .map(|(_, bytes)| bytes)
    }

    pub fn read_image_asset<A: ImageAssetPort>(
        &self,
        request: ImageReadRequest,
        assets: &A,
    ) -> Result<(NoteImage, Vec<u8>), NotesError> {
        let session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        self.ensure_session(&session, &request.session_id)?;
        drop(session);

        let id = NodeId::try_from(request.node_id)?;
        let node = self
            .storage
            .load_node(&id)?
            .ok_or_else(|| DomainError::NodeNotFound(id.clone()))?;
        if node.kind() != NoteNodeKind::Image || node.is_deleted() {
            return Err(DomainError::InvalidImage(
                "The requested Notes node is not an active image.".into(),
            )
            .into());
        }
        let image = node.image().ok_or_else(|| {
            DomainError::InvalidImage("The requested image metadata is unavailable.".into())
        })?;
        let bytes = assets.read(image).map_err(NotesError::from)?;
        Ok((image.clone(), bytes))
    }

    pub fn replace_image<A: ImageAssetPort>(
        &self,
        context: ImageReplaceContext,
        source: ImageImportSource,
        assets: &A,
    ) -> Result<MutationReceipt, NotesError> {
        let mut session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        self.ensure_session(&session, &context.session_id)?;
        if let Some(receipt) = session.completed_requests.get(&context.request_id) {
            return Ok(receipt.clone());
        }
        self.ensure_revision(&session, context.base_revision)?;
        let import_context = ImageImportContext {
            session_id: context.session_id.clone(),
            request_id: context.request_id.clone(),
            base_revision: context.base_revision,
            history_group: context.history_group.clone(),
            parent_id: context.target_id.clone(),
            before_id: None,
            items: vec![context.item.clone()],
        };
        validate_image_sources(&import_context, std::slice::from_ref(&source))?;
        let target_id = NodeId::try_from(context.target_id.as_str())?;
        if source.node_id != target_id {
            return Err(invalid_image_request(
                "The replacement image identity does not match its target.",
            ));
        }
        let published = assets.prepare(std::slice::from_ref(&source))?;
        let Some(replacement) = published.first() else {
            return Err(invalid_image_request(
                "The image asset store returned an incomplete replacement.",
            ));
        };
        if published.len() != 1
            || replacement.image.original_name() != source.original_name
            || replacement.image.byte_length() != context.item.byte_length
            || source
                .declared_mime_type
                .as_deref()
                .is_some_and(|mime| mime != replacement.image.mime_type())
        {
            rollback_new_assets(assets, &published);
            return Err(invalid_image_request(
                "The image asset store returned mismatched replacement metadata.",
            ));
        }
        match self.execute_checked(
            &mut session,
            context.request_id,
            context.history_group,
            NotesCommand::ReplaceImage {
                id: target_id,
                image: replacement.image.clone(),
            },
        ) {
            Ok(receipt) => Ok(receipt),
            Err(error) => {
                rollback_new_assets(assets, &published);
                Err(error)
            }
        }
    }

    fn execute_checked(
        &self,
        session: &mut SessionState,
        request_id: String,
        history_group: Option<String>,
        command: NotesCommand,
    ) -> Result<MutationReceipt, NotesError> {
        let tree = self.storage.load_command_tree(&command)?;
        let patch = tree.plan(command)?;
        let commit = self.storage.commit(session.revision, &patch)?;
        session.revision = commit.revision;
        let entry = NotesServiceHistoryEntry {
            forward: patch.forward,
            inverse: patch.inverse,
            carried_pictures: patch.carried_pictures,
            group: history_group.clone(),
        };
        session.record_history(entry);
        let receipt = Self::receipt(session, commit);
        session.record_completed(request_id, receipt.clone());
        Ok(receipt)
    }

    /// Puts a defeated note's text back. It is an ordinary edit and takes the
    /// ordinary path: a write that moved the stored revision without telling
    /// this session would leave every later edit, undo and redo failing until
    /// the app was restarted.
    pub fn restore_conflict(
        &self,
        node_id: &str,
        text: &str,
    ) -> Result<MutationReceipt, NotesError> {
        let mut session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        let id = NodeId::try_from(node_id.to_owned())?;
        let request_id = format!("restore-{node_id}-{}", session.revision);
        self.execute_checked(
            &mut session,
            request_id,
            None,
            NotesCommand::UpdateText {
                id,
                text: text.to_owned(),
            },
        )
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
        // An empty stack is "nothing to undo"; a stack whose remaining entries
        // all sit under the barrier is a different answer, and the reader
        // deserves the difference.
        if session.undo.len() <= session.undo_floor {
            return Err(NotesError::history_blocked_by_merge());
        }
        let commit = self.storage.commit(
            session.revision,
            &DomainPatch {
                forward: entry.inverse.clone(),
                inverse: entry.forward.clone(),
                // Never on the way back: an undo deletes the copy, and handing
                // a picture to a node that is going away is at best undone a
                // statement later by the cascade.
                carried_pictures: Vec::new(),
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
                carried_pictures: entry.carried_pictures.clone(),
            },
        )?;
        session.redo.pop();
        push_bounded_history(&mut session.undo, entry);
        session.revision = commit.revision;
        Ok(Self::receipt(&session, commit))
    }

    /// Takes in what a merge changed. Everything this session could still
    /// reverse that touches one of those nodes stops being reversible — an
    /// undo replays an inverse recorded against a state that has since moved,
    /// and a redo replays a forward onto one. Entries that touch nothing the
    /// merge touched are untouched themselves: cutting the whole history
    /// instead would throw away work nobody is in doubt about.
    pub fn absorb_external(&self, revision: u64, affected: &[String]) -> Result<u64, NotesError> {
        let mut session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        session.revision = revision;
        let affected: HashSet<&str> = affected.iter().map(String::as_str).collect();
        // The deepest entry still in question, counted from the bottom: every
        // entry at or below it is now unreachable.
        if let Some(deepest) = session
            .undo
            .iter()
            .rposition(|entry| entry_touches(entry, &affected))
        {
            session.undo_floor = session.undo_floor.max(deepest + 1);
        }
        if session
            .redo
            .iter()
            .any(|entry| entry_touches(entry, &affected))
        {
            session.redo.clear();
        }
        Ok(revision)
    }

    /// How many entries this session can still undo.
    pub fn history_depth(&self) -> usize {
        let session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        session.undo.len().saturating_sub(session.undo_floor)
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
                can_undo: session.undo.len() > session.undo_floor,
                can_redo: !session.redo.is_empty(),
                undo_depth: session.undo.len().saturating_sub(session.undo_floor) as u32,
                redo_depth: session.redo.len() as u32,
            },
        }
    }
}

fn referenced_images(command: &NotesCommand) -> impl Iterator<Item = &NoteImage> {
    let nodes = match command {
        NotesCommand::ImportNodes { nodes, .. } => nodes.as_slice(),
        _ => &[],
    };
    nodes.iter().filter_map(|node| node.image.as_ref())
}

fn validate_image_sources(
    context: &ImageImportContext,
    sources: &[ImageImportSource],
) -> Result<(), NotesError> {
    if context.items.len() != sources.len() || sources.is_empty() {
        return Err(invalid_image_request(
            "Image metadata and payload counts do not match.",
        ));
    }
    for (item, source) in context.items.iter().zip(sources) {
        let item_id = NodeId::try_from(item.node_id.as_str())?;
        if item_id != source.node_id
            || item.original_name != source.original_name
            || item.declared_mime_type != source.declared_mime_type
        {
            return Err(invalid_image_request(
                "Image metadata does not match its payload.",
            ));
        }
        if let ImageSource::Bytes(bytes) = &source.source {
            let length = u64::try_from(bytes.len()).map_err(|_| {
                invalid_image_request("The image payload byte length is too large.")
            })?;
            if length != item.byte_length {
                return Err(invalid_image_request(
                    "Image metadata byte length does not match its payload.",
                ));
            }
        }
    }
    Ok(())
}

fn image_import_command(
    context: &ImageImportContext,
    sources: &[ImageImportSource],
    published: &[PublishedImage],
) -> Result<NotesCommand, NotesError> {
    if sources.len() != published.len() {
        return Err(invalid_image_request(
            "The image asset store returned an incomplete batch.",
        ));
    }
    let mut nodes = Vec::with_capacity(sources.len());
    for ((item, source), published) in context.items.iter().zip(sources).zip(published) {
        if published.image.original_name() != source.original_name
            || published.image.byte_length() != item.byte_length
            || source
                .declared_mime_type
                .as_deref()
                .is_some_and(|mime| mime != published.image.mime_type())
        {
            return Err(invalid_image_request(
                "The image asset store returned mismatched metadata.",
            ));
        }
        nodes.push(ImportImageNode {
            id: source.node_id.clone(),
            image: published.image.clone(),
        });
    }
    let position = match &context.before_id {
        Some(before_id) => Position::before(NodeId::try_from(before_id.as_str())?),
        None => Position::at_end(),
    };
    Ok(NotesCommand::ImportImages {
        parent_id: NodeId::try_from(context.parent_id.as_str())?,
        position,
        nodes,
    })
}

fn rollback_new_assets<A: ImageAssetPort>(assets: &A, published: &[PublishedImage]) {
    let newly_created = published
        .iter()
        .filter(|image| image.newly_created)
        .cloned()
        .collect::<Vec<_>>();
    assets.rollback(&newly_created);
}

fn invalid_image_request(message: impl Into<String>) -> NotesError {
    DomainError::InvalidImage(message.into()).into()
}

#[cfg(test)]
mod tests;
