use std::collections::{BTreeMap, BTreeSet};

mod command_execution;

use crate::node::SORT_KEY_STEP;
use crate::{
    DomainError, DomainPatch, NodeId, NoteNode, NoteNodeKind, NotesCommand, Position, TreeMutation,
};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct NotesTree {
    nodes: BTreeMap<NodeId, NoteNode>,
}

impl NotesTree {
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn node(&self, id: &NodeId) -> Option<&NoteNode> {
        self.nodes.get(id)
    }

    pub fn children_of(&self, parent_id: &NodeId) -> Vec<NodeId> {
        self.ordered_children(parent_id, false)
    }

    fn ordered_children(&self, parent_id: &NodeId, include_deleted: bool) -> Vec<NodeId> {
        let mut children = self
            .nodes
            .values()
            .filter(|node| {
                node.parent_id() == Some(parent_id) && (include_deleted || !node.is_deleted())
            })
            .collect::<Vec<_>>();
        children.sort_by_key(|node| (node.sort_key(), node.id()));
        children.into_iter().map(|node| node.id().clone()).collect()
    }

    pub fn plan(&self, command: NotesCommand) -> Result<DomainPatch, DomainError> {
        let mut candidate = self.clone();
        candidate.execute(command)?;
        candidate.validate()?;
        Ok(self.diff(&candidate))
    }

    pub fn apply(&mut self, mutations: &[TreeMutation]) -> Result<(), DomainError> {
        let mut candidate = self.clone();
        for mutation in mutations {
            match mutation {
                TreeMutation::Upsert(node) => {
                    candidate
                        .nodes
                        .insert(node.id().clone(), node.as_ref().clone());
                }
                TreeMutation::Delete { id } => {
                    candidate.nodes.remove(id);
                }
            }
        }
        candidate.validate()?;
        *self = candidate;
        Ok(())
    }

    fn move_node(
        &mut self,
        id: NodeId,
        parent_id: NodeId,
        position: Position,
    ) -> Result<(), DomainError> {
        let node = self
            .nodes
            .get(&id)
            .ok_or_else(|| DomainError::NodeNotFound(id.clone()))?;
        if node.kind() == NoteNodeKind::Page {
            return Err(DomainError::CannotMovePage);
        }
        self.ensure_parent(&parent_id)?;
        if id == parent_id || self.is_descendant_of(&parent_id, &id) {
            return Err(DomainError::Cycle {
                node_id: id,
                parent_id,
            });
        }
        self.node_mut(&id)?.set_parent_id(parent_id.clone());
        self.place_child(&id, &parent_id, position)
    }

    fn duplicate_node(
        &mut self,
        source_id: NodeId,
        new_id: NodeId,
        parent_id: NodeId,
        position: Position,
    ) -> Result<(), DomainError> {
        self.ensure_new_id(&new_id)?;
        self.ensure_parent(&parent_id)?;
        let source = self
            .nodes
            .get(&source_id)
            .ok_or_else(|| DomainError::NodeNotFound(source_id.clone()))?;
        if source.kind() == NoteNodeKind::Page {
            return Err(DomainError::CannotDuplicatePage);
        }
        let source_ids = self.visible_subtree_ids(&source_id);
        let source = source.clone();
        let copy = NoteNode::from_persisted_with_image(
            new_id.clone(),
            Some(parent_id.clone()),
            SORT_KEY_STEP,
            source.kind(),
            source.image().cloned(),
            source.text().to_owned(),
            source.note().to_owned(),
            source.marker(),
            source.is_collapsed(),
            source.is_completed(),
            source.is_starred(),
            false,
        );
        self.nodes.insert(new_id.clone(), copy);
        let mut copied_ids = BTreeMap::from([(source_id, new_id.clone())]);
        for (index, source_child_id) in source_ids.into_iter().skip(1).enumerate() {
            let copied_id = NodeId::try_from(format!("{new_id}/{}", index + 1))?;
            self.ensure_new_id(&copied_id)?;
            let source_child = self
                .nodes
                .get(&source_child_id)
                .cloned()
                .ok_or_else(|| DomainError::NodeNotFound(source_child_id.clone()))?;
            let source_parent_id = source_child
                .parent_id()
                .ok_or_else(|| DomainError::ParentNotFound(source_child_id.clone()))?;
            let copied_parent_id = copied_ids
                .get(source_parent_id)
                .cloned()
                .ok_or_else(|| DomainError::ParentNotFound(source_parent_id.clone()))?;
            self.nodes.insert(
                copied_id.clone(),
                NoteNode::from_persisted_with_image(
                    copied_id.clone(),
                    Some(copied_parent_id),
                    source_child.sort_key(),
                    source_child.kind(),
                    source_child.image().cloned(),
                    source_child.text().to_owned(),
                    source_child.note().to_owned(),
                    source_child.marker(),
                    source_child.is_collapsed(),
                    source_child.is_completed(),
                    source_child.is_starred(),
                    false,
                ),
            );
            copied_ids.insert(source_child_id, copied_id);
        }
        self.place_child(&new_id, &parent_id, position)
    }

    fn place_child(
        &mut self,
        id: &NodeId,
        parent_id: &NodeId,
        position: Position,
    ) -> Result<(), DomainError> {
        let mut ordered = self
            .ordered_children(parent_id, true)
            .into_iter()
            .filter(|child_id| child_id != id)
            .collect::<Vec<_>>();
        let index = match position {
            Position::AtEnd => ordered.len(),
            Position::Before { sibling_id } => ordered
                .iter()
                .position(|candidate| candidate == &sibling_id)
                .ok_or(DomainError::SiblingNotFound(sibling_id))?,
        };
        ordered.insert(index, id.clone());
        let previous_key = index
            .checked_sub(1)
            .and_then(|previous| ordered.get(previous))
            .and_then(|child_id| self.nodes.get(child_id))
            .map(NoteNode::sort_key);
        let next_key = ordered
            .get(index + 1)
            .and_then(|child_id| self.nodes.get(child_id))
            .map(NoteNode::sort_key);
        let sparse_key = match (previous_key, next_key) {
            (None, None) => Some(SORT_KEY_STEP),
            (Some(previous), None) => previous.checked_add(SORT_KEY_STEP),
            (None, Some(next)) => next.checked_sub(SORT_KEY_STEP),
            (Some(previous), Some(next)) => next
                .checked_sub(previous)
                .filter(|gap| *gap > 1)
                .and_then(|gap| previous.checked_add(gap / 2)),
        };
        if let Some(sort_key) = sparse_key {
            self.node_mut(id)?.set_sort_key(sort_key);
            return Ok(());
        }
        for (index, child_id) in ordered.into_iter().enumerate() {
            let ordinal = i64::try_from(index + 1).map_err(|_| DomainError::SortKeyOverflow)?;
            let sort_key = ordinal
                .checked_mul(SORT_KEY_STEP)
                .ok_or(DomainError::SortKeyOverflow)?;
            self.node_mut(&child_id)?.set_sort_key(sort_key);
        }
        Ok(())
    }

    fn set_subtree_deleted(&mut self, root_id: &NodeId, deleted: bool) -> Result<(), DomainError> {
        if !self.nodes.contains_key(root_id) {
            return Err(DomainError::NodeNotFound(root_id.clone()));
        }
        let subtree = self.subtree_ids(root_id);
        for id in subtree {
            self.node_mut(&id)?.set_deleted(deleted);
        }
        if !deleted {
            let mut ancestor_id = self
                .nodes
                .get(root_id)
                .and_then(NoteNode::parent_id)
                .cloned();
            while let Some(id) = ancestor_id {
                ancestor_id = self.nodes.get(&id).and_then(NoteNode::parent_id).cloned();
                self.node_mut(&id)?.set_deleted(false);
            }
        }
        Ok(())
    }

    fn subtree_ids(&self, root_id: &NodeId) -> Vec<NodeId> {
        let mut result = Vec::new();
        let mut pending = vec![root_id.clone()];
        while let Some(id) = pending.pop() {
            pending.extend(
                self.nodes
                    .values()
                    .filter(|node| node.parent_id() == Some(&id))
                    .map(|node| node.id().clone()),
            );
            result.push(id);
        }
        result
    }

    fn visible_subtree_ids(&self, root_id: &NodeId) -> Vec<NodeId> {
        let mut result = Vec::new();
        let mut pending = vec![root_id.clone()];
        while let Some(id) = pending.pop() {
            let mut children = self.ordered_children(&id, false);
            children.reverse();
            pending.extend(children);
            result.push(id);
        }
        result
    }

    fn is_descendant_of(&self, candidate: &NodeId, ancestor: &NodeId) -> bool {
        let mut current = Some(candidate);
        let mut visited = BTreeSet::new();
        while let Some(id) = current {
            if id == ancestor {
                return true;
            }
            if !visited.insert(id.clone()) {
                return true;
            }
            current = self.nodes.get(id).and_then(NoteNode::parent_id);
        }
        false
    }

    fn ensure_new_id(&self, id: &NodeId) -> Result<(), DomainError> {
        if self.nodes.contains_key(id) {
            Err(DomainError::DuplicateNode(id.clone()))
        } else {
            Ok(())
        }
    }

    fn ensure_parent(&self, parent_id: &NodeId) -> Result<(), DomainError> {
        match self.nodes.get(parent_id) {
            Some(parent) if !parent.is_deleted() => Ok(()),
            _ => Err(DomainError::ParentNotFound(parent_id.clone())),
        }
    }

    fn node_mut(&mut self, id: &NodeId) -> Result<&mut NoteNode, DomainError> {
        self.nodes
            .get_mut(id)
            .ok_or_else(|| DomainError::NodeNotFound(id.clone()))
    }

    fn diff(&self, candidate: &Self) -> DomainPatch {
        let ids = self
            .nodes
            .keys()
            .chain(candidate.nodes.keys())
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut forward = Vec::new();
        let mut inverse = Vec::new();
        for id in ids {
            match (self.nodes.get(&id), candidate.nodes.get(&id)) {
                (None, Some(after)) => {
                    forward.push(TreeMutation::upsert(after.clone()));
                    inverse.push(TreeMutation::Delete { id });
                }
                (Some(before), None) => {
                    forward.push(TreeMutation::Delete { id: id.clone() });
                    inverse.push(TreeMutation::upsert(before.clone()));
                }
                (Some(before), Some(after)) if before != after => {
                    forward.push(TreeMutation::upsert(after.clone()));
                    inverse.push(TreeMutation::upsert(before.clone()));
                }
                _ => {}
            }
        }
        DomainPatch { forward, inverse }
    }

    fn validate(&self) -> Result<(), DomainError> {
        for node in self.nodes.values() {
            match (node.kind(), node.parent_id()) {
                (NoteNodeKind::Page, None) if node.image().is_none() => {}
                (NoteNodeKind::Bullet, Some(parent_id))
                    if self.nodes.contains_key(parent_id) && node.image().is_none() => {}
                (NoteNodeKind::Image, Some(parent_id)) if self.nodes.contains_key(parent_id) => {}
                (NoteNodeKind::Bullet | NoteNodeKind::Image, Some(parent_id)) => {
                    return Err(DomainError::ParentNotFound(parent_id.clone()));
                }
                _ => {
                    return Err(DomainError::Invariant(format!(
                        "node {} has an invalid kind/parent combination",
                        node.id()
                    )));
                }
            }
            let mut visited = BTreeSet::new();
            let mut current = node.parent_id();
            while let Some(parent_id) = current {
                if !visited.insert(parent_id.clone()) || parent_id == node.id() {
                    return Err(DomainError::Cycle {
                        node_id: node.id().clone(),
                        parent_id: parent_id.clone(),
                    });
                }
                current = self.nodes.get(parent_id).and_then(NoteNode::parent_id);
            }
        }
        // Every remaining parent id exists as a node: the loop above rejects any
        // node whose parent is absent, so grouping by `parent_id` reaches the
        // same parents as scanning the node ids, deleted children included.
        let mut siblings: BTreeMap<&NodeId, Vec<&NoteNode>> = BTreeMap::new();
        for node in self.nodes.values() {
            if let Some(parent_id) = node.parent_id() {
                siblings.entry(parent_id).or_default().push(node);
            }
        }
        for (parent_id, mut children) in siblings {
            children.sort_by_key(|node| (node.sort_key(), node.id()));
            for pair in children.windows(2) {
                if pair[0].sort_key() >= pair[1].sort_key() {
                    return Err(DomainError::Invariant(format!(
                        "siblings below {parent_id} are not strictly ordered"
                    )));
                }
            }
        }
        Ok(())
    }
}
