use std::time::{Duration, Instant};

use notes_core::{
    NodeId, NoteMarkerKind, NoteNode, NoteNodeKind, NotesCommand, NotesTree, Position,
    SORT_KEY_STEP, TreeMutation,
};

fn id(value: &str) -> NodeId {
    NodeId::try_from(value).unwrap()
}

fn page() -> TreeMutation {
    TreeMutation::upsert(NoteNode::page(id("page"), "Page"))
}

/// A persisted row, so a fixture can open on a tree that already holds deleted
/// rows without replaying the commands that deleted them.
fn row(node_id: &str, parent_id: &str, sort_key: i64, deleted: bool) -> TreeMutation {
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

fn plan_and_apply(tree: &mut NotesTree, command: NotesCommand) {
    let patch = tree.plan(command).unwrap();
    tree.apply(&patch.forward).unwrap();
}

#[test]
fn duplicating_a_deep_subtree_copies_it_in_document_order_without_deleted_rows() {
    let mut tree = NotesTree::default();
    // Every sibling group is named against its sort keys, so a walk that reads
    // the rows in id order instead of sort order lands on different copy ids
    // rather than on the same ones in a different sequence.
    tree.apply(&[
        page(),
        row("source", "page", SORT_KEY_STEP, false),
        row("zeta", "source", SORT_KEY_STEP, false),
        row("yak", "zeta", SORT_KEY_STEP, false),
        row("xray", "zeta", 2 * SORT_KEY_STEP, true),
        row("beta", "zeta", 3 * SORT_KEY_STEP, false),
        row("mid", "source", 2 * SORT_KEY_STEP, true),
        row("mid-kid", "mid", SORT_KEY_STEP, false),
        row("alpha", "source", 3 * SORT_KEY_STEP, false),
        row("omega", "alpha", SORT_KEY_STEP, false),
    ])
    .unwrap();

    plan_and_apply(
        &mut tree,
        NotesCommand::DuplicateNode {
            source_id: id("source"),
            new_id: id("copy"),
            parent_id: id("page"),
            position: Position::at_end(),
        },
    );

    // Copied ids are derived from the order the walk reaches the source rows,
    // so reading the copy back in document order pins the traversal and not
    // just the shape. The deleted rows stay behind.
    let texts = |parent: &NodeId| {
        tree.children_of(parent)
            .into_iter()
            .map(|child| tree.node(&child).unwrap().text().to_owned())
            .collect::<Vec<_>>()
    };
    let copied = tree.children_of(&id("copy"));
    assert_eq!(texts(&id("copy")), vec!["zeta", "alpha"]);
    assert_eq!(texts(&copied[0]), vec!["yak", "beta"]);
    assert_eq!(texts(&copied[1]), vec!["omega"]);
    assert_eq!(
        tree.children_of(&copied[0])
            .iter()
            .map(|child| tree.children_of(child).len())
            .sum::<usize>(),
        0,
        "the copy is five rows deep and no deeper"
    );
}

#[test]
fn restoring_a_subtree_reaches_rows_that_were_already_deleted() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        page(),
        row("root", "page", SORT_KEY_STEP, false),
        row("branch", "root", SORT_KEY_STEP, false),
        row("leaf", "branch", SORT_KEY_STEP, false),
        row("sibling", "root", 2 * SORT_KEY_STEP, false),
    ])
    .unwrap();
    plan_and_apply(&mut tree, NotesCommand::DeleteSubtree { id: id("branch") });
    assert!(tree.node(&id("leaf")).unwrap().is_deleted());

    plan_and_apply(&mut tree, NotesCommand::RestoreSubtree { id: id("root") });

    for node_id in ["root", "branch", "leaf", "sibling"] {
        assert!(
            !tree.node(&id(node_id)).unwrap().is_deleted(),
            "{node_id} stayed deleted"
        );
    }
}

#[test]
fn deleting_a_five_thousand_node_subtree_stays_bounded() {
    let mut tree = NotesTree::default();
    let mut mutations = vec![page(), row("root", "page", SORT_KEY_STEP, false)];
    for index in 1..=5_000_i64 {
        mutations.push(row(
            &format!("node-{index}"),
            "root",
            index * SORT_KEY_STEP,
            false,
        ));
    }
    tree.apply(&mutations).expect("fixture validates");

    let started = Instant::now();
    let patch = tree
        .plan(NotesCommand::DeleteSubtree { id: id("root") })
        .expect("plan the delete");
    let elapsed = started.elapsed();

    eprintln!("5,000-node subtree delete: {elapsed:?}");
    assert_eq!(patch.forward.len(), 5_001);
    assert!(elapsed < Duration::from_millis(500));
}

#[test]
fn duplicating_a_five_thousand_node_subtree_stays_bounded() {
    let mut tree = NotesTree::default();
    let mut mutations = vec![page(), row("source", "page", SORT_KEY_STEP, false)];
    for index in 1..=5_000_i64 {
        mutations.push(row(
            &format!("node-{index}"),
            "source",
            index * SORT_KEY_STEP,
            false,
        ));
    }
    tree.apply(&mutations).expect("fixture validates");

    let started = Instant::now();
    let patch = tree
        .plan(NotesCommand::DuplicateNode {
            source_id: id("source"),
            new_id: id("copy"),
            parent_id: id("page"),
            position: Position::at_end(),
        })
        .expect("plan the duplicate");
    let elapsed = started.elapsed();

    eprintln!("5,000-node subtree duplicate: {elapsed:?}");
    assert_eq!(patch.forward.len(), 5_001);
    assert!(elapsed < Duration::from_millis(500));
}
