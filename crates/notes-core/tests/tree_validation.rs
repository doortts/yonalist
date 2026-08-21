use std::time::{Duration, Instant};

use notes_core::{
    DomainError, NodeId, NoteMarkerKind, NoteNode, NoteNodeKind, NotesCommand, NotesTree, Position,
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

// A trashed row's key says where it was deleted from, and the vault's trash
// document keeps writing it back while the page document respaces the rows that
// are still live. A live row on that key is what that arrangement produces, so
// refusing it here would refuse every command over the page instead.
#[test]
fn a_deleted_sibling_on_a_live_row_s_key_is_accepted() {
    let mut tree = NotesTree::default();

    let result = tree.apply(&[
        page(),
        sibling("live", "page", SORT_KEY_STEP, false),
        sibling("gone", "page", SORT_KEY_STEP, true),
    ]);

    assert_eq!(result, Ok(()));
    assert_eq!(tree.children_of(&id("page")), vec![id("live")]);
}

// What the bug looked like from the app: home held a trashed page on the same
// key as a live one, so every command planned over home was refused -- Enter at
// the head of the first row among them.
#[test]
fn a_row_opens_above_a_live_sibling_a_trashed_row_shares_a_key_with() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        page(),
        sibling("live", "page", SORT_KEY_STEP, false),
        sibling("gone", "page", SORT_KEY_STEP, true),
    ])
    .unwrap();

    let patch = tree
        .plan(NotesCommand::CreateNode {
            id: id("blank"),
            parent_id: id("page"),
            position: Position::before(id("live")),
            text: String::new(),
        })
        .unwrap();
    tree.apply(&patch.forward).unwrap();

    assert_eq!(tree.children_of(&id("page")), vec![id("blank"), id("live")]);
}

// The slot has to be real again on the way back: the row lands beside the
// sibling that took it rather than on top of it.
#[test]
fn restoring_a_row_onto_a_taken_slot_spaces_it_back_in() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        page(),
        sibling("live", "page", SORT_KEY_STEP, false),
        sibling("gone", "page", SORT_KEY_STEP, true),
        sibling("after", "page", SORT_KEY_STEP * 2, false),
    ])
    .unwrap();

    let patch = tree
        .plan(NotesCommand::RestoreSubtree { id: id("gone") })
        .unwrap();
    tree.apply(&patch.forward).unwrap();

    let keys = ["gone", "live", "after"].map(|node| {
        tree.node(&id(node))
            .expect("the row is in the tree")
            .sort_key()
    });
    assert!(keys[0] < keys[1], "gone keeps the place its key gave it");
    assert!(keys[1] < keys[2]);
    assert_eq!(
        tree.children_of(&id("page")),
        vec![id("gone"), id("live"), id("after")]
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

/// The Journals node's id is written into every journal day's file as its
/// `parent:`, and a parent that is not a block id quarantines the file that
/// states it. A readable name like `yonalist-journals` cannot be this id.
#[test]
fn the_journals_id_is_a_block_id_the_vault_can_carry() {
    assert!(
        notes_core::is_block_id(notes_core::JOURNALS_ID),
        "got {}",
        notes_core::JOURNALS_ID
    );
}
