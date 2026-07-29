use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, PoisonError};

use notes_core::{
    DomainError, DomainPatch, ImportImageNode, NodeId, NoteNodeKind, NotesCommand, Position,
    TreeMutation,
};

use crate::{
    CommandEnvelope, HistoryRequest, HistoryState, ImageAssetPort, ImageImportContext,
    ImageImportSource, ImageReadRequest, ImageReplaceContext, ImageSource, MutationReceipt,
    NoteView, NotesError, PublishedImage, StorageCommit, StoragePort,
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
        let command = envelope.command.try_into()?;
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
    ) -> Result<(notes_core::NoteImage, Vec<u8>), NotesError> {
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
            group: history_group.clone(),
        };
        session.record_history(entry);
        let receipt = Self::receipt(session, commit);
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
