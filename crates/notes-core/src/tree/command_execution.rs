use std::collections::BTreeSet;

use crate::node::SORT_KEY_STEP;
use crate::{
    CompletionStage, DomainError, ImportImageNode, ImportNode, NodeId, NoteNode, NoteNodeKind,
    NotesCommand, Position,
};

use super::NotesTree;

impl NotesTree {
    /// `carried_pictures` collects what a duplicated node could not bring with
    /// it; every command but a duplication leaves it alone.
    pub(super) fn execute(
        &mut self,
        command: NotesCommand,
        carried_pictures: &mut Vec<(NodeId, NodeId)>,
    ) -> Result<(), DomainError> {
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
                    self.execute(command, carried_pictures)?;
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
            NotesCommand::MergeNodeIntoParent {
                id,
                parent_id,
                parent_text,
                current_text,
            } => self.merge_node_into_parent(id, parent_id, parent_text, current_text),
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
            } => self.duplicate_node(source_id, new_id, parent_id, position, carried_pictures),
            NotesCommand::DuplicateNodes { duplicates } => {
                for duplicate in duplicates {
                    self.duplicate_node(
                        duplicate.source_id,
                        duplicate.new_id,
                        duplicate.parent_id,
                        duplicate.position,
                        carried_pictures,
                    )?;
                }
                Ok(())
            }
            NotesCommand::SetCompleted { id, completed } => self.set_completed(&id, completed),
            // The selection bulk-complete settles each listed row exactly as
            // ticking its own box would. In order, and against the tree the
            // earlier ids already left: a later id's ancestor check has to see
            // the sibling branch an earlier id just closed.
            NotesCommand::SetCompletedMany { ids, completed } => {
                for id in ids {
                    self.set_completed(&id, completed)?;
                }
                Ok(())
            }
            NotesCommand::CycleCompleted { id, restore } => self.cycle_completed(&id, restore),
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
        // The one id every device already agrees on (`crate::JOURNALS_ID`), so
        // the same creation arrives from whoever writes their first journal
        // day. Refusing it wedges journaling for good: the day right behind it
        // names this id as its parent, and no day can be written while the id
        // cannot be asked for.
        let journals = id.as_str() == crate::JOURNALS_ID;
        match self.nodes.get(&id) {
            // Here already, which is all the day behind this needs. Where the
            // node sits is the user's -- a bullet dragged off Home stays where
            // they put it -- so nothing is written and nothing is undone.
            Some(node) if journals && !node.is_deleted() => return Ok(()),
            // Thrown away, and the day needs it back: the write below takes the
            // row over, and its inverse throws it away again. The days already
            // in the trash went there on purpose and stay there.
            Some(_) if journals => {}
            _ => self.ensure_new_id(&id)?,
        }
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
            self.import_node(
                node,
                if is_root {
                    position.clone()
                } else {
                    Position::at_end()
                },
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

    /// One imported node arrives complete: marker, note, tick, and any image
    /// reference land in the same patch as the row itself, so a paste stays one
    /// undo step.
    fn import_node(&mut self, node: ImportNode, position: Position) -> Result<(), DomainError> {
        self.ensure_new_id(&node.id)?;
        self.ensure_parent(&node.parent_id)?;
        let id = node.id.clone();
        let parent_id = node.parent_id.clone();
        let mut created = match node.image {
            // An image node carries its file name as text, the way `set_image`
            // keeps it, so an import may not name it anything else.
            Some(image) => {
                if !node.text.is_empty() && node.text != image.original_name() {
                    return Err(DomainError::InvalidImage(
                        "an imported image node's text must be its file name".into(),
                    ));
                }
                NoteNode::image_child(id.clone(), parent_id.clone(), SORT_KEY_STEP, image)
            }
            None => NoteNode::child(id.clone(), parent_id.clone(), SORT_KEY_STEP, node.text),
        };
        created.set_note(node.note);
        created.set_marker(node.marker);
        created.set_completed(node.completed);
        created.set_collapsed(node.collapsed);
        created.set_starred(node.starred);
        self.nodes.insert(id.clone(), created);
        self.place_child(&id, &parent_id, position)
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
        let mut created = NoteNode::child(new_id.clone(), parent_id.clone(), SORT_KEY_STEP, suffix);
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

    /// The row above a first child is its own parent, so Backspace at the head
    /// folds the text up rather than no-opping. The row goes away and its
    /// children take its place under the parent, which is what `remove_empty_node`
    /// already does for a blank row -- the lifting is shared.
    fn merge_node_into_parent(
        &mut self,
        id: NodeId,
        parent_id: NodeId,
        parent_text: String,
        current_text: String,
    ) -> Result<(), DomainError> {
        let current = self
            .nodes
            .get(&id)
            .cloned()
            .ok_or_else(|| DomainError::NodeNotFound(id.clone()))?;
        if current.kind() != NoteNodeKind::Bullet {
            return Err(DomainError::Invariant(
                "only bullet titles can be merged".into(),
            ));
        }
        if current.parent_id() != Some(&parent_id) {
            return Err(DomainError::Invariant(
                "a merged bullet must name the parent it sits under".into(),
            ));
        }
        let parent = self
            .nodes
            .get(&parent_id)
            .cloned()
            .ok_or_else(|| DomainError::NodeNotFound(parent_id.clone()))?;
        if parent.kind() != NoteNodeKind::Bullet {
            return Err(DomainError::Invariant(
                "only bullet titles can be merged".into(),
            ));
        }
        // The row above has to be the parent itself, and it only is for the
        // first child: anything later would jump its own siblings on the way up.
        if self.ordered_children(&parent_id, false).first() != Some(&id) {
            return Err(DomainError::Invariant(
                "only the first child merges into its parent".into(),
            ));
        }
        // The row is going, and a note on it would go with it unsaid.
        if !current.note().trim().is_empty() {
            return Err(DomainError::Invariant(
                "a bullet carrying a note cannot be merged into its parent".into(),
            ));
        }
        self.node_mut(&parent_id)?
            .set_text(parent_text + &current_text);
        self.lift_children_then_remove(&id, &parent_id)
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
        self.lift_children_then_remove(id, &parent_id)
    }

    /// Drops a row and puts its children where it stood, under `parent_id`.
    /// Shared by the blank-row removal and the merge into a parent: both take
    /// one row out of the middle of a list and leave its branch behind.
    fn lift_children_then_remove(
        &mut self,
        id: &NodeId,
        parent_id: &NodeId,
    ) -> Result<(), DomainError> {
        let node = self
            .nodes
            .get(id)
            .cloned()
            .ok_or_else(|| DomainError::NodeNotFound(id.clone()))?;
        let siblings = self.ordered_children(parent_id, true);
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

    /// A completed row is that row's own statement, not a claim about the rows
    /// under it: work that can no longer be done is left open and the row above
    /// it still closes. So a tick writes one row, and what follows are the two
    /// transitions that ripple upward -- a parent whose own children are now all
    /// done follows them, and a parent over a row that just came open cannot go
    /// on saying it is finished.
    ///
    /// Reading only the children is what makes this cheap: a completed child
    /// stands for its own branch, so no command has to load a page to answer
    /// whether a row is finished. It lives here rather than in the client because
    /// a client only ever holds a window of the page.
    fn set_completed(&mut self, id: &NodeId, completed: bool) -> Result<(), DomainError> {
        self.node_mut(id)?.set_completed(completed);
        let Some(parent_id) = self.live_parent_row(id) else {
            return Ok(());
        };
        if completed {
            self.settle_ancestors(&parent_id)
        } else {
            self.clear_ancestors(&parent_id)
        }
    }

    /// The three presses of the completion chord, read off the tree rather than
    /// remembered: a row that is not done finishes itself, a finished row with
    /// something open under it finishes its children, and a finished row with
    /// nothing open under it comes back open. `restore` carries what those
    /// children held before the second press, which only the session knows; an
    /// empty list means that memory is gone and the children stay as they are.
    fn cycle_completed(
        &mut self,
        id: &NodeId,
        restore: Vec<(NodeId, bool)>,
    ) -> Result<(), DomainError> {
        match self.completion_stage(id)? {
            CompletionStage::Row => self.set_completed(id, true),
            CompletionStage::Children => {
                for child_id in self.children_of(id) {
                    self.node_mut(&child_id)?.set_completed(true);
                }
                Ok(())
            }
            CompletionStage::Back => {
                for (child_id, was_completed) in restore {
                    // A remembered row can have gone since; the press is still
                    // the press.
                    if let Some(child) = self.nodes.get_mut(&child_id) {
                        child.set_completed(was_completed);
                    }
                }
                self.set_completed(id, false)
            }
        }
    }

    /// Ticks the rows above once their own children are all done, and keeps
    /// climbing while that holds. A row with no children of its own is not a
    /// finished branch, it is an empty one.
    fn settle_ancestors(&mut self, from_id: &NodeId) -> Result<(), DomainError> {
        let mut current = Some(from_id.clone());
        // Seeded empty; a parent cycle ends the walk instead of climbing forever.
        let mut visited = BTreeSet::new();
        while let Some(row_id) = current {
            if !visited.insert(row_id.clone()) {
                break;
            }
            let Some(node) = self.node(&row_id) else {
                break;
            };
            if node.is_deleted() || self.is_page_row(node) || !self.children_are_done(&row_id) {
                break;
            }
            self.node_mut(&row_id)?.set_completed(true);
            current = self.live_parent_row(&row_id);
        }
        Ok(())
    }

    /// Opens the finished rows above a row that just came open. Stops at the
    /// first row that was already open: everything above it is open too.
    fn clear_ancestors(&mut self, from_id: &NodeId) -> Result<(), DomainError> {
        let mut current = Some(from_id.clone());
        let mut visited = BTreeSet::new();
        while let Some(row_id) = current {
            if !visited.insert(row_id.clone()) {
                break;
            }
            match self.node(&row_id) {
                Some(node) if node.is_completed() && !node.is_deleted() => {}
                _ => break,
            }
            self.node_mut(&row_id)?.set_completed(false);
            current = self.live_parent_row(&row_id);
        }
        Ok(())
    }

    fn children_are_done(&self, id: &NodeId) -> bool {
        let children = self.children_of(id);
        !children.is_empty()
            && children
                .iter()
                .all(|child_id| self.node(child_id).is_some_and(NoteNode::is_completed))
    }

    /// A row this command took away -- trashed, or moved under some other row --
    /// is one thing less left to do where it was. If nothing under that row is
    /// left open, the row is finished and says so. A branch left with no rows at
    /// all is not finished, it is empty, and keeps whatever it held.
    ///
    /// Only rows that left count here. A row blanked in place does not settle the
    /// branch above it: the working set a text edit loads is the row and its
    /// ancestors, so the rows that would have to be read to know the branch is
    /// finished are not there to read.
    pub(super) fn settle_over_rows_this_command_took_away(
        &mut self,
        before: &Self,
    ) -> Result<(), DomainError> {
        let mut orphaned_parents = BTreeSet::new();
        for (id, previous) in &before.nodes {
            // Whatever held the branch open, which is any live row that was not
            // done -- a blank row among them. A blank counts for nothing when a
            // row arrives, and for everything when it leaves: while it sat there
            // the branch was not finished, so its leaving is what finishes it.
            if previous.is_deleted() || previous.is_completed() {
                continue;
            }
            let left = match self.nodes.get(id) {
                None => true,
                Some(current) => {
                    current.is_deleted() || current.parent_id() != previous.parent_id()
                }
            };
            if !left {
                continue;
            }
            if let Some(parent_id) = previous.parent_id() {
                orphaned_parents.insert(parent_id.clone());
            }
        }
        for parent_id in orphaned_parents {
            self.settle_ancestors(&parent_id)?;
        }
        Ok(())
    }

    /// Work that *arrives* somewhere -- a row created there with something in it,
    /// written into where it was blank, moved in, brought back from the trash --
    /// is news to the rows above it, which cannot go on saying they are finished.
    /// It sits here, after the command rather than inside each one, because every
    /// command that puts a row somewhere would otherwise need the same
    /// afterthought of its own.
    ///
    /// A row that merely came open where it stood is not an arrival: nothing new
    /// turned up, one row changed its mind. That is the completion write's own
    /// business, and it opens the rows above it one at a time, stopping at the
    /// first that was already open -- which is what leaves a declaration made
    /// further up alone.
    pub(super) fn reopen_over_rows_this_command_placed(
        &mut self,
        before: &Self,
    ) -> Result<(), DomainError> {
        let arrived = self
            .nodes
            .values()
            .filter(|node| counts_as_open(node))
            .filter(|node| match before.nodes.get(node.id()) {
                None => true,
                Some(previous) => {
                    previous.is_deleted()
                        || previous.parent_id() != node.parent_id()
                        || !holds_something(previous)
                }
            })
            .map(|node| node.id().clone())
            .collect::<Vec<_>>();
        for id in arrived {
            self.reopen_ancestors(&id, before)?;
        }
        Ok(())
    }

    /// Opens the run of finished rows above arrived work, and stops as soon as it
    /// reaches a row the arrival is no news to:
    ///
    /// - a finished row this same command brought along -- a pasted subtree, or one
    ///   out of the trash, says what it said when it was cut, and it speaks for
    ///   everything inside it, so the walk ends there and the rows above it never
    ///   hear about the arrival;
    /// - a row that was already open before the command, because whatever sits
    ///   above it had already accepted an open row underneath.
    ///
    /// Everything in between is a finished row that was there before and now has
    /// work under it that was not, so it opens.
    fn reopen_ancestors(&mut self, id: &NodeId, before: &Self) -> Result<(), DomainError> {
        let mut current = id.clone();
        // Seeded with the arrived row so a parent cycle ends the walk instead of
        // climbing forever.
        let mut visited = BTreeSet::from([id.clone()]);
        while let Some(parent_id) = self.live_parent_row(&current) {
            if !visited.insert(parent_id.clone()) {
                break;
            }
            // A row out of the trash arrives as surely as one that was never
            // there: before this command it was a tombstone, not a row.
            let arrived = before
                .nodes
                .get(&parent_id)
                .is_none_or(NoteNode::is_deleted);
            let finished = self.node(&parent_id).is_some_and(NoteNode::is_completed);
            match (finished, arrived) {
                (true, true) => break,
                (true, false) => self.node_mut(&parent_id)?.set_completed(false),
                (false, false) => break,
                (false, true) => {}
            }
            current = parent_id;
        }
        Ok(())
    }

    /// The row a tick climbs to next. It stops below the page row -- the row an
    /// outline hangs under, which is the page's own title and its name in the
    /// sidebar. Finishing everything written on a page says the rows are done,
    /// not that the page is.
    fn live_parent_row(&self, id: &NodeId) -> Option<NodeId> {
        let parent_id = self.node(id)?.parent_id()?;
        let parent = self.node(parent_id)?;
        (!parent.is_deleted() && !self.is_page_row(parent)).then(|| parent_id.clone())
    }

    /// The one page and the rows directly under it, which the client draws as
    /// pages of their own rather than as rows of an outline.
    fn is_page_row(&self, node: &NoteNode) -> bool {
        node.kind() == NoteNodeKind::Page
            || node
                .parent_id()
                .and_then(|parent_id| self.node(parent_id))
                .is_some_and(|parent| parent.kind() == NoteNodeKind::Page)
    }
}

/// Whether a row is something left to do, as far as the rows above it are
/// concerned. An empty row is not: Enter makes blanks all the time, and a branch
/// does not come open because someone made room to type in it.
fn counts_as_open(node: &NoteNode) -> bool {
    !node.is_deleted() && !node.is_completed() && holds_something(node)
}

fn holds_something(node: &NoteNode) -> bool {
    !node.text().trim().is_empty() || !node.note().trim().is_empty() || node.image().is_some()
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use super::NotesTree;
    use crate::{NodeId, NoteMarkerKind, NoteNode, NoteNodeKind};

    /// `validate` refuses a parent cycle, so one can only be planted by
    /// reaching past the public API — which is the only way to prove the walk
    /// ends rather than climbing forever. The walk runs on a thread of its own
    /// so a lost guard fails here by name instead of stalling the whole suite
    /// until the job's own timeout ends it.
    #[test]
    fn a_parent_cycle_ends_the_climb_instead_of_looping() {
        let mut tree = NotesTree::default();
        for (id, parent_id) in [("left", "right"), ("right", "left")] {
            let node = NoteNode::from_persisted(
                NodeId::try_from(id).unwrap(),
                Some(NodeId::try_from(parent_id).unwrap()),
                1_024,
                NoteNodeKind::Bullet,
                id.into(),
                String::new(),
                NoteMarkerKind::Todo,
                false,
                false,
                false,
                false,
            );
            tree.nodes.insert(node.id().clone(), node);
        }

        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let id = NodeId::try_from("left").unwrap();
            tree.set_completed(&id, true).unwrap();
            sender.send(tree.node(&id).unwrap().is_completed()).ok();
        });

        assert!(
            receiver
                .recv_timeout(Duration::from_secs(5))
                .expect("the climb never came back off the cycle")
        );
    }
}
