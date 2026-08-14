use std::time::{Duration, Instant};

use notes_core::{
    DomainError, NodeId, NoteMarkerKind, NoteNode, NoteNodeKind, NotesCommand, NotesTree,
    SORT_KEY_STEP, TreeMutation,
};

fn id(value: &str) -> NodeId {
    NodeId::try_from(value).unwrap()
}

fn page() -> TreeMutation {
    TreeMutation::upsert(NoteNode::page(id("page"), "Page"))
}

/// A persisted sibling, so a test can hand `apply` a tree the command layer
/// would never build: a duplicate sort key, or a deleted row out of order.
fn sibling(node_id: &str, parent_id: &str, sort_key: i64, deleted: bool) -> TreeMutation {
    TreeMutation::upsert(NoteNode::from_persisted(
        id(node_id),
        Some(id(parent_id)),
        sort_key,
        NoteNodeKind::Bullet,
        node_id.to_owned(),
        String::new(),
        NoteMarkerKind::Bullet,
        false,
        false,
        false,
        deleted,
    ))
}

#[test]
fn siblings_sharing_a_sort_key_are_rejected() {
    let mut tree = NotesTree::default();

    let result = tree.apply(&[
        page(),
        sibling("one", "page", SORT_KEY_STEP, false),
        sibling("two", "page", SORT_KEY_STEP, false),
    ]);

    assert_eq!(
        result,
        Err(DomainError::Invariant(
            "siblings below page are not strictly ordered".into()
        ))
    );
    assert!(tree.is_empty());
}

#[test]
fn a_deleted_sibling_breaking_the_order_is_rejected() {
    let mut tree = NotesTree::default();

    let result = tree.apply(&[
        page(),
        sibling("live", "page", SORT_KEY_STEP, false),
        sibling("gone", "page", SORT_KEY_STEP, true),
    ]);

    assert_eq!(
        result,
        Err(DomainError::Invariant(
            "siblings below page are not strictly ordered".into()
        ))
    );
}

#[test]
fn a_missing_parent_outranks_unordered_siblings() {
    let mut tree = NotesTree::default();

    let result = tree.apply(&[
        page(),
        sibling("one", "page", SORT_KEY_STEP, false),
        sibling("two", "page", SORT_KEY_STEP, false),
        sibling("orphan", "ghost", SORT_KEY_STEP, false),
    ]);

    assert_eq!(result, Err(DomainError::ParentNotFound(id("ghost"))));
}

#[test]
fn many_ordered_siblings_under_one_parent_validate() {
    let mut tree = NotesTree::default();
    let mut mutations = vec![page()];
    for index in 1..=200_i64 {
        mutations.push(sibling(
            &format!("node-{index}"),
            "page",
            index * SORT_KEY_STEP,
            index % 3 == 0,
        ));
    }

    tree.apply(&mutations).expect("ordered siblings validate");

    assert_eq!(tree.children_of(&id("page")).len(), 200 - 200 / 3);
}

#[test]
fn planning_over_five_thousand_siblings_stays_bounded() {
    let mut tree = NotesTree::default();
    let mut mutations = vec![page()];
    for index in 1..=5_000_i64 {
        mutations.push(sibling(
            &format!("node-{index}"),
            "page",
            index * SORT_KEY_STEP,
            false,
        ));
    }
    tree.apply(&mutations).expect("fixture validates");

    let started = Instant::now();
    let patch = tree
        .plan(NotesCommand::UpdateText {
            id: id("node-2500"),
            text: "edited".into(),
        })
        .expect("plan over a wide parent");
    let elapsed = started.elapsed();

    eprintln!("5,000-sibling plan: {elapsed:?}");
    assert_eq!(patch.forward.len(), 1);
    assert!(elapsed < Duration::from_millis(500));
}
