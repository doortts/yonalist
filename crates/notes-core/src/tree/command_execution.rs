use std::collections::BTreeSet;

use crate::node::SORT_KEY_STEP;
use crate::{
    DomainError, ImportImageNode, ImportNode, NodeId, NoteNode, NoteNodeKind, NotesCommand,
    Position,
};

use super::NotesTree;

impl NotesTree {
    pub(super) fn execute(&mut self, command: NotesCommand) -> Result<(), DomainError> {
        match command {
            NotesCommand::Batch { commands } => {
                if commands.is_empty() {
                    return Err(DomainError::Invariant(
                        "an editor batch must contain at least one command".into(),
                    ));
                }
                for command in commands {
                    if matches!(&command, NotesCommand::Batch { .. }) {
                        return Err(DomainError::Invariant(
                            "nested editor batches are not allowed".into(),
                        ));
                    }
                    self.execute(command)?;
                }
                Ok(())
            }
            NotesCommand::CreateNode {
                id,
                parent_id,
                position,
                text,
            } => self.create_node(id, parent_id, position, text),
            NotesCommand::ImportNodes {
                parent_id,
                position,
                nodes,
            } => self.import_nodes(parent_id, position, nodes),
            NotesCommand::ImportImages {
                parent_id,
                position,
                nodes,
            } => self.import_images(parent_id, position, nodes),
            NotesCommand::UpdateText { id, text } => {
                if self.node_mut(&id)?.kind() == NoteNodeKind::Image {
                    return Err(DomainError::Invariant(
                        "image filenames cannot be changed as bullet text".into(),
                    ));
                }
                self.node_mut(&id)?.set_text(text);
                Ok(())
            }
            NotesCommand::UpdateNote { id, note } => {
                self.node_mut(&id)?.set_note(note);
                Ok(())
            }
            NotesCommand::ResizeImage { id, display_width } => {
                let image = self
                    .node_mut(&id)?
                    .image_mut()
                    .ok_or_else(|| DomainError::InvalidImage("image metadata is missing".into()))?;
                image.set_display_width(display_width)
            }
            NotesCommand::ReplaceImage { id, mut image } => {
                let node = self.node_mut(&id)?;
                if node.kind() != NoteNodeKind::Image {
                    return Err(DomainError::InvalidImage(
                        "only image nodes can replace image content".into(),
                    ));
                }
                let display_width = node
                    .image()
                    .ok_or_else(|| DomainError::InvalidImage("image metadata is missing".into()))?
                    .display_width();
                image.set_display_width(display_width)?;
                node.set_image(image);
                Ok(())
            }
            NotesCommand::SplitNode {
                id,
                new_id,
                parent_id,
                position,
                prefix,
                suffix,
            } => self.split_node(id, new_id, parent_id, position, prefix, suffix),
            NotesCommand::MergeNodeBackward {
                id,
                previous_id,
                previous_text,
                current_text,
            } => self.merge_node_backward(id, previous_id, previous_text, current_text),
            NotesCommand::RemoveEmptyNode { id } => self.remove_empty_node(&id),
            NotesCommand::MoveNode {
                id,
                parent_id,
                position,
            } => self.move_node(id, parent_id, position),
            NotesCommand::MoveNodes { moves } => {
                for node_move in moves {
                    let parent_id = node_move.parent_id;
                    self.move_node(node_move.id, parent_id.clone(), node_move.position)?;
                    self.node_mut(&parent_id)?.set_collapsed(false);
                }
                Ok(())
            }
            NotesCommand::IndentNode { id, parent_id } => {
                self.node_mut(&parent_id)?.set_collapsed(false);
                self.move_node(id, parent_id, Position::at_end())
            }
            NotesCommand::DuplicateNode {
                source_id,
                new_id,
                parent_id,
                position,
            } => self.duplicate_node(source_id, new_id, parent_id, position),
            NotesCommand::DuplicateNodes { duplicates } => {
                for duplicate in duplicates {
                    self.duplicate_node(
                        duplicate.source_id,
                        duplicate.new_id,
                        duplicate.parent_id,
                        duplicate.position,
                    )?;
                }
                Ok(())
            }
            NotesCommand::SetCompleted { id, completed } => {
                self.node_mut(&id)?.set_completed(completed);
                Ok(())
            }
            NotesCommand::SetCompletedMany { ids, completed } => {
                for id in ids {
                    self.node_mut(&id)?.set_completed(completed);
                }
                Ok(())
            }
            NotesCommand::SetStarred { id, starred } => {
                self.node_mut(&id)?.set_starred(starred);
                Ok(())
            }
            NotesCommand::SetCollapsed { id, collapsed } => {
                self.node_mut(&id)?.set_collapsed(collapsed);
                Ok(())
            }
            NotesCommand::SetMarker { id, marker } => {
                self.node_mut(&id)?.set_marker(marker);
                Ok(())
            }
            NotesCommand::DeleteSubtree { id } => self.set_subtree_deleted(&id, true),
            NotesCommand::DeleteSubtrees { ids } => {
                for id in ids {
                    self.set_subtree_deleted(&id, true)?;
                }
                Ok(())
            }
            NotesCommand::RestoreSubtree { id } => self.set_subtree_deleted(&id, false),
        }
    }

    fn create_node(
        &mut self,
        id: NodeId,
        parent_id: NodeId,
        position: Position,
        text: String,
    ) -> Result<(), DomainError> {
        self.ensure_new_id(&id)?;
        self.ensure_parent(&parent_id)?;
        self.nodes.insert(
            id.clone(),
            NoteNode::child(id.clone(), parent_id.clone(), SORT_KEY_STEP, text),
        );
        self.place_child(&id, &parent_id, position)
    }

    fn import_nodes(
        &mut self,
        parent_id: NodeId,
        position: Position,
        nodes: Vec<ImportNode>,
    ) -> Result<(), DomainError> {
        self.ensure_parent(&parent_id)?;
        if nodes.is_empty() {
            return Err(DomainError::Invariant(
                "an imported outline must contain at least one node".into(),
            ));
        }
        let mut imported_ids = BTreeSet::new();
        let mut root_count = 0;
        for node in nodes {
            let is_root = node.parent_id == parent_id;
            if !is_root && !imported_ids.contains(&node.parent_id) {
                return Err(DomainError::Invariant(format!(
                    "import parent must precede its child: {}",
                    node.parent_id
                )));
            }
            if is_root {
                root_count += 1;
            }
            let node_id = node.id.clone();
            self.create_node(
                node.id,
                node.parent_id,
                if is_root {
                    position.clone()
                } else {
                    Position::at_end()
                },
                node.text,
            )?;
            imported_ids.insert(node_id);
        }
        if root_count == 0 {
            return Err(DomainError::Invariant(
                "an imported outline must contain a root".into(),
            ));
        }
        Ok(())
    }

    fn import_images(
        &mut self,
        parent_id: NodeId,
        position: Position,
        nodes: Vec<ImportImageNode>,
    ) -> Result<(), DomainError> {
        self.ensure_parent(&parent_id)?;
        if nodes.is_empty() {
            return Err(DomainError::Invariant(
                "an imported image batch must contain at least one node".into(),
            ));
        }
        for node in nodes {
            self.ensure_new_id(&node.id)?;
            let id = node.id;
            self.nodes.insert(
                id.clone(),
                NoteNode::image_child(id.clone(), parent_id.clone(), SORT_KEY_STEP, node.image),
            );
            self.place_child(&id, &parent_id, position.clone())?;
        }
        Ok(())
    }

    fn split_node(
        &mut self,
        id: NodeId,
        new_id: NodeId,
        parent_id: NodeId,
        position: Position,
        prefix: String,
        suffix: String,
    ) -> Result<(), DomainError> {
        let source = self
            .nodes
            .get(&id)
            .ok_or_else(|| DomainError::NodeNotFound(id.clone()))?;
        if source.kind() != NoteNodeKind::Bullet {
            return Err(DomainError::CannotSplitPage);
        }
        // `parent_id` names where the half after the caret lands, and a split may
        // only put it beside the source or inside it: either the source's own
        // parent, or the source itself. Nothing else, so a split can never re-home
        // the source or reach a node it does not already touch.
        // A checklist stays a checklist across Enter: the new half takes the
        // source's marker, never its tick.
        let marker = source.marker();
        let nested = parent_id == id;
        if !nested && source.parent_id() != Some(&parent_id) {
            return Err(DomainError::Invariant(format!(
                "split source {id} is neither a child of {parent_id} nor {parent_id} itself"
            )));
        }
        self.ensure_new_id(&new_id)?;
        self.ensure_parent(&parent_id)?;
        self.node_mut(&id)?.set_text(prefix);
        // A collapsed source would hide the half that just landed inside it, so
        // the nested split expands it, the way MoveNodes and IndentNode expand
        // the destination they move into. Same command, so it is one undo step.
        if nested {
            self.node_mut(&id)?.set_collapsed(false);
        }
        let mut created =
            NoteNode::child(new_id.clone(), parent_id.clone(), SORT_KEY_STEP, suffix);
        created.set_marker(marker);
        self.nodes.insert(new_id.clone(), created);
        self.place_child(&new_id, &parent_id, position)
    }

    fn merge_node_backward(
        &mut self,
        id: NodeId,
        previous_id: NodeId,
        previous_text: String,
        current_text: String,
    ) -> Result<(), DomainError> {
        let current = self
            .nodes
            .get(&id)
            .cloned()
            .ok_or_else(|| DomainError::NodeNotFound(id.clone()))?;
        let previous = self
            .nodes
            .get(&previous_id)
            .cloned()
            .ok_or_else(|| DomainError::NodeNotFound(previous_id.clone()))?;
        if current.kind() != NoteNodeKind::Bullet || previous.kind() != NoteNodeKind::Bullet {
            return Err(DomainError::Invariant(
                "only bullet titles can be merged".into(),
            ));
        }
        let parent_id = current
            .parent_id()
            .cloned()
            .ok_or_else(|| DomainError::ParentNotFound(id.clone()))?;
        if previous.parent_id() != Some(&parent_id) {
            return Err(DomainError::Invariant(
                "merged bullet titles must share a parent".into(),
            ));
        }
        if !previous.note().trim().is_empty()
            || !self.ordered_children(&previous_id, false).is_empty()
        {
            return Err(DomainError::Invariant(
                "the previous bullet must not have a note or children".into(),
            ));
        }
        let siblings = self.ordered_children(&parent_id, false);
        let is_adjacent = siblings
            .windows(2)
            .any(|pair| pair[0] == previous_id && pair[1] == id);
        if !is_adjacent {
            return Err(DomainError::Invariant(
                "the previous bullet must be the adjacent sibling".into(),
            ));
        }

        let previous_sort_key = previous.sort_key();
        let current = self.node_mut(&id)?;
        current.set_text(previous_text + &current_text);
        current.set_sort_key(previous_sort_key);
        self.nodes.remove(&previous_id);
        Ok(())
    }

    fn remove_empty_node(&mut self, id: &NodeId) -> Result<(), DomainError> {
        let node = self
            .nodes
            .get(id)
            .cloned()
            .ok_or_else(|| DomainError::NodeNotFound(id.clone()))?;
        if node.kind() == NoteNodeKind::Page {
            return Err(DomainError::CannotRemovePage);
        }
        if node.kind() == NoteNodeKind::Image {
            return Err(DomainError::Invariant(
                "image nodes cannot be removed by the empty-bullet gesture".into(),
            ));
        }
        if !node.text().trim().is_empty() || !node.note().trim().is_empty() {
            return Err(DomainError::NodeNotEmpty(id.clone()));
        }
        let parent_id = node
            .parent_id()
            .cloned()
            .ok_or_else(|| DomainError::ParentNotFound(id.clone()))?;
        let siblings = self.ordered_children(&parent_id, true);
        let index = siblings
            .iter()
            .position(|candidate| candidate == id)
            .ok_or_else(|| DomainError::NodeNotFound(id.clone()))?;
        let children = self.ordered_children(id, true);
        if children.is_empty() {
            self.nodes.remove(id);
            return Ok(());
        }
        let source_key = node.sort_key();
        let next_key = siblings
            .get(index + 1)
            .and_then(|sibling_id| self.nodes.get(sibling_id))
            .map(NoteNode::sort_key);
        let child_count =
            i64::try_from(children.len()).map_err(|_| DomainError::SortKeyOverflow)?;
        let local_keys = match next_key {
            Some(next_key) => next_key
                .checked_sub(source_key)
                .filter(|gap| *gap > child_count)
                .map(|gap| {
                    let step = gap / (child_count + 1);
                    (1..=child_count)
                        .map(|ordinal| source_key + step * ordinal)
                        .collect::<Vec<_>>()
                }),
            None => (1..=child_count)
                .map(|ordinal| {
                    ordinal
                        .checked_mul(SORT_KEY_STEP)
                        .and_then(|offset| source_key.checked_add(offset))
                })
                .collect::<Option<Vec<_>>>(),
        };
        if let Some(keys) = local_keys {
            for (child_id, sort_key) in children.into_iter().zip(keys) {
                let child = self.node_mut(&child_id)?;
                child.set_parent_id(parent_id.clone());
                child.set_sort_key(sort_key);
            }
            self.nodes.remove(id);
            return Ok(());
        }

        let mut reordered = siblings;
        reordered.splice(index..=index, children.iter().cloned());
        for child_id in &children {
            self.node_mut(child_id)?.set_parent_id(parent_id.clone());
        }
        self.nodes.remove(id);
        for (index, child_id) in reordered.into_iter().enumerate() {
            let ordinal = i64::try_from(index + 1).map_err(|_| DomainError::SortKeyOverflow)?;
            let sort_key = ordinal
                .checked_mul(SORT_KEY_STEP)
                .ok_or(DomainError::SortKeyOverflow)?;
            self.node_mut(&child_id)?.set_sort_key(sort_key);
        }
        Ok(())
    }
}
