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

/// Same reason as `MAX_FIELD_BYTES`, for the shape of the outline itself. The
/// node count has no home here yet — see `validate`.
pub const MAX_TREE_DEPTH: usize = 128;

/// Namespace for ids the domain derives rather than receives. Fixed forever:
/// changing it would give the same duplication a different id on a later
/// release, and two devices on different releases would then disagree.
const DERIVED_ID_NAMESPACE: uuid::Uuid =
    uuid::Uuid::from_u128(0x7f9c_2b14_5d63_4a08_9e21_3c6f_0d8b_4a52);

/// The copy of a subtree needs an id per node, and only the top one arrives with
/// the command. The rest are derived from it, so every device that duplicates the
/// same subtree lands on the same ids and their files merge instead of doubling.
///
/// The namespace and the name format are unchanged, so determinism here is
/// something being reused rather than re-established: two devices duplicating the
/// same subtree still land on the same ids and their files merge instead of
/// doubling. Only the last step is new — the digest's first nine bytes become a
/// `yid`, because that is what the file can carry.
///
/// The parent's id is no longer lowercased. A UUID means the same thing in either
/// case and a `yid` does not: `Nd0000000001` and `nd0000000001` are two blocks,
/// and folding them had both derive the same children, so one subtree's copies
/// collided with the other's.
fn derived_child_id(new_id: &NodeId, ordinal: usize) -> Result<NodeId, DomainError> {
    let name = format!("{}/{ordinal}", new_id.as_str());
    let derived = uuid::Uuid::new_v5(&DERIVED_ID_NAMESPACE, name.as_bytes());
    let bytes = derived.as_bytes();
    NodeId::try_from(crate::encode_yid(
        bytes[..9].try_into().expect("a uuid is sixteen bytes"),
    ))
}

/// A picture the copy cannot carry itself, so the storage layer is told to hand
/// it over. Only a picture still waiting for its bytes: one that has them
/// travels on the node, the way everything else about it does.
fn carry_picture(
    carried_pictures: &mut Vec<(NodeId, NodeId)>,
    source: &NoteNode,
    copy_id: &NodeId,
) {
    if source.kind() == NoteNodeKind::Image && source.image().is_none() {
        carried_pictures.push((source.id().clone(), copy_id.clone()));
    }
}

/// Children go onto the stack reversed so popping hands them back in document
/// order: `duplicate_node` feeds that position to `derived_child_id`, so this
/// order is part of the copied ids and not just of the copied shape.
fn walk_subtree(index: &BTreeMap<&NodeId, Vec<&NoteNode>>, root_id: &NodeId) -> Vec<NodeId> {
    let mut result = Vec::new();
    let mut pending = vec![root_id.clone()];
    while let Some(id) = pending.pop() {
        if let Some(children) = index.get(&id) {
            pending.extend(children.iter().rev().map(|node| node.id().clone()));
        }
        result.push(id);
    }
    result
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
        let mut carried_pictures = Vec::new();
        candidate.execute(command, &mut carried_pictures)?;
        candidate.validate()?;
        // `diff` compares two trees, and a picture waiting for its bytes is in
        // neither of them — only the duplication itself knows which copy was
        // made from which node.
        Ok(DomainPatch {
            carried_pictures,
            ..self.diff(&candidate)
        })
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
        carried_pictures: &mut Vec<(NodeId, NodeId)>,
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
        carry_picture(carried_pictures, &source, &new_id);
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
            let copied_id = derived_child_id(&new_id, index + 1)?;
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
            carry_picture(carried_pictures, &source_child, &copied_id);
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

    /// Siblings under each parent, in the order `ordered_children` would return
    /// them. Both the subtree walks and `validate`'s ordering check read this,
    /// so the two cannot drift apart on what counts as a child.
    fn children_index(&self, include_deleted: bool) -> BTreeMap<&NodeId, Vec<&NoteNode>> {
        let mut index: BTreeMap<&NodeId, Vec<&NoteNode>> = BTreeMap::new();
        for node in self
            .nodes
            .values()
            .filter(|node| include_deleted || !node.is_deleted())
        {
            if let Some(parent_id) = node.parent_id() {
                index.entry(parent_id).or_default().push(node);
            }
        }
        for children in index.values_mut() {
            children.sort_by_key(|node| (node.sort_key(), node.id()));
        }
        index
    }

    /// Deleted rows stay in the walk: delete and restore both have to reach the
    /// rows already flagged, and a branch under a flagged parent hangs off them.
    fn subtree_ids(&self, root_id: &NodeId) -> Vec<NodeId> {
        walk_subtree(&self.children_index(true), root_id)
    }

    fn visible_subtree_ids(&self, root_id: &NodeId) -> Vec<NodeId> {
        walk_subtree(&self.children_index(false), root_id)
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
        DomainPatch {
            forward,
            inverse,
            carried_pictures: Vec::new(),
        }
    }

    fn validate(&self) -> Result<(), DomainError> {
        // The vault quarantines a whole document rather than half-applying it,
        // so a shape the file could not carry is refused here. Otherwise the
        // edit commits, the export rejects it, and that page silently stops
        // syncing.
        //
        // The node-count cap is not among these. A command plans against the
        // rows its context hydrated, not the whole outline, so a count taken
        // here never sees a growing page and would instead refuse the bulk
        // delete that repairs one. It belongs where a whole document is known.
        for node in self.nodes.values() {
            for (field, value) in [("text", node.text()), ("note", node.note())] {
                if value.len() > crate::MAX_FIELD_BYTES {
                    return Err(DomainError::Invariant(format!(
                        "node {} has a {field} past {} bytes",
                        node.id(),
                        crate::MAX_FIELD_BYTES
                    )));
                }
            }
            match (node.kind(), node.parent_id()) {
                (NoteNodeKind::Page, None) if node.image().is_none() => {}
                (NoteNodeKind::Bullet, Some(parent_id))
                    if self.nodes.contains_key(parent_id) && node.image().is_none() => {}
                // An image directly below the root has no heading line to live
                // on: the root's own document writes its title as the heading,
                // and an image cannot be a heading.
                (NoteNodeKind::Image, Some(parent_id))
                    if self
                        .nodes
                        .get(parent_id)
                        .is_some_and(|parent| parent.kind() == NoteNodeKind::Page) =>
                {
                    return Err(DomainError::Invariant(format!(
                        "image {} cannot hang directly below the root",
                        node.id()
                    )));
                }
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
            // Ancestors up to the vault root, where the file counts indent
            // from its own document root. That makes this the stricter of the
            // two, which is the safe direction: nothing the file would
            // quarantine survives, and a legal row is only ever refused within
            // a document's own depth of the limit.
            if visited.len() > crate::MAX_TREE_DEPTH {
                return Err(DomainError::Invariant(format!(
                    "node {} hangs deeper than {}",
                    node.id(),
                    crate::MAX_TREE_DEPTH
                )));
            }
        }
        // Every remaining parent id exists as a node: the loop above rejects any
        // node whose parent is absent, so grouping by `parent_id` reaches the
        // same parents as scanning the node ids. Deleted children are included
        // because a deleted row still holds its ordering slot until it is
        // purged, and two rows may not share one.
        for (parent_id, children) in self.children_index(true) {
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

#[cfg(test)]
mod derived_id_tests {
    use super::derived_child_id;
    use crate::NodeId;

    /// A duplicated subtree names its copies by deriving them, so that two devices
    /// duplicating the same subtree land on the same ids and their files merge
    /// instead of doubling. The derivation stays UUID v5 — the namespace and the
    /// name format are unchanged, so determinism is a thing being reused rather
    /// than re-established — and only the last step is new: the first nine bytes
    /// of the digest become the id.
    #[test]
    fn a_derived_child_id_is_a_yid_and_always_the_same_one() {
        let parent = NodeId::try_from("Nd0000000001").expect("a parent");

        let first = derived_child_id(&parent, 1).expect("derived");
        let again = derived_child_id(&parent, 1).expect("derived");

        assert_eq!(first, again, "the same input has to land on the same id");
        assert!(
            crate::is_yid(first.as_str()),
            "a derived id goes in the file like any other: {first}"
        );
        let second = derived_child_id(&parent, 2).expect("derived");
        assert_ne!(first, second, "two children of one parent are two blocks");
    }

    /// The parent's id used to be lowercased before it was hashed, because a UUID
    /// means the same thing in either case. A `yid` does not: `Nd0000000001` and
    /// `nd0000000001` are two different blocks, and folding them would have both
    /// derive the same children — so one subtree's copies would collide with the
    /// other's.
    #[test]
    fn two_parents_differing_only_in_case_derive_different_children() {
        let upper = NodeId::try_from("Nd0000000001").expect("a parent");
        let lower = NodeId::try_from("nd0000000001").expect("a parent");

        assert_ne!(
            derived_child_id(&upper, 1).expect("derived"),
            derived_child_id(&lower, 1).expect("derived")
        );
    }
}
