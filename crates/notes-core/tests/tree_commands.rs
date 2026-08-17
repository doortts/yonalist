use notes_core::{
    DomainError, ImportImageNode, ImportNode, NodeDuplicate, NodeId, NodeMove, NoteImage,
    NoteMarkerKind, NoteNode, NoteNodeKind, NotesCommand, NotesTree, Position, TreeMutation,
};
use proptest::prelude::*;

fn id(value: &str) -> NodeId {
    NodeId::try_from(value).unwrap()
}

/// The single root page every outline hangs from; a "page" is one of its
/// children.
fn root_tree() -> NotesTree {
    let mut tree = NotesTree::default();
    tree.apply(&[TreeMutation::upsert(NoteNode::page(id("root"), "Home"))])
        .unwrap();
    tree
}

fn create_page(tree: &mut NotesTree, page_id: &NodeId) {
    plan_and_apply(
        tree,
        NotesCommand::CreateNode {
            id: page_id.clone(),
            parent_id: id("root"),
            position: Position::at_end(),
            text: "Page".into(),
        },
    );
}

/// A text-only import, the shape a plain paste sends.
fn imported(node_id: &str, parent_id: &str, text: &str) -> ImportNode {
    ImportNode {
        id: id(node_id),
        parent_id: id(parent_id),
        text: text.into(),
        note: String::new(),
        marker: NoteMarkerKind::Bullet,
        completed: false,
        collapsed: false,
        starred: false,
        image: None,
    }
}

fn pasted_image() -> NoteImage {
    NoteImage::try_referenced("a".repeat(64), "sample.png", "image/png", 3, 1, 1, 320)
        .expect("valid image reference")
}

fn plan_and_apply(tree: &mut NotesTree, command: NotesCommand) {
    let patch = tree.plan(command).unwrap();
    tree.apply(&patch.forward).unwrap();
}

#[test]
fn editor_batch_plans_against_one_candidate_tree() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("first"), id("page"), 1_024, "alpha")),
    ])
    .unwrap();

    let patch = tree
        .plan(NotesCommand::Batch {
            commands: vec![
                NotesCommand::CreateNode {
                    id: id("second"),
                    parent_id: id("page"),
                    position: Position::at_end(),
                    text: "beta".into(),
                },
                NotesCommand::UpdateText {
                    id: id("second"),
                    text: "beta edited".into(),
                },
            ],
        })
        .expect("batch");

    tree.apply(&patch.forward).expect("apply batch");
    assert_eq!(
        tree.node(&id("second")).expect("created node").text(),
        "beta edited"
    );
}

#[test]
fn invalid_editor_batch_does_not_mutate_the_source_tree() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("first"), id("page"), 1_024, "alpha")),
    ])
    .unwrap();
    let before = tree.clone();

    let result = tree.plan(NotesCommand::Batch {
        commands: vec![
            NotesCommand::UpdateText {
                id: id("first"),
                text: "changed".into(),
            },
            NotesCommand::UpdateText {
                id: id("missing"),
                text: "invalid".into(),
            },
        ],
    });

    assert_eq!(result, Err(DomainError::NodeNotFound(id("missing"))));
    assert_eq!(tree, before);
}

#[test]
fn empty_editor_batch_is_rejected() {
    let tree = NotesTree::default();

    let result = tree.plan(NotesCommand::Batch { commands: vec![] });

    assert_eq!(
        result,
        Err(DomainError::Invariant(
            "an editor batch must contain at least one command".into()
        ))
    );
}

#[test]
fn nested_editor_batch_is_rejected() {
    let tree = NotesTree::default();

    let result = tree.plan(NotesCommand::Batch {
        commands: vec![NotesCommand::Batch {
            commands: vec![NotesCommand::UpdateText {
                id: id("page"),
                text: "Page".into(),
            }],
        }],
    });

    assert_eq!(
        result,
        Err(DomainError::Invariant(
            "nested editor batches are not allowed".into()
        ))
    );
}

#[test]
fn page_and_bullet_commands_produce_reversible_patches() {
    let mut tree = root_tree();

    let create_page = tree
        .plan(NotesCommand::CreateNode {
            id: id("page"),
            parent_id: id("root"),
            position: Position::at_end(),
            text: "Inbox".into(),
        })
        .unwrap();
    tree.apply(&create_page.forward).unwrap();

    let create_bullet = tree
        .plan(NotesCommand::CreateNode {
            id: id("bullet"),
            parent_id: id("page"),
            position: Position::at_end(),
            text: "first".into(),
        })
        .unwrap();
    tree.apply(&create_bullet.forward).unwrap();
    assert_eq!(tree.node(&id("bullet")).unwrap().text(), "first");

    tree.apply(&create_bullet.inverse).unwrap();
    assert!(tree.node(&id("bullet")).is_none());
    tree.apply(&create_bullet.forward).unwrap();
    assert_eq!(tree.children_of(&id("page")), vec![id("bullet")]);
}

#[test]
fn creating_an_orphan_is_rejected_without_mutating_the_tree() {
    let tree = NotesTree::default();

    let result = tree.plan(NotesCommand::CreateNode {
        id: id("orphan"),
        parent_id: id("missing"),
        position: Position::at_end(),
        text: String::new(),
    });

    assert_eq!(result, Err(DomainError::ParentNotFound(id("missing"))));
    assert!(tree.is_empty());
}

#[test]
fn moving_a_parent_below_its_descendant_is_rejected() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("parent"), id("page"), 1_024, "Parent")),
        TreeMutation::upsert(NoteNode::child(id("child"), id("parent"), 1_024, "Child")),
    ])
    .unwrap();

    let result = tree.plan(NotesCommand::MoveNode {
        id: id("parent"),
        parent_id: id("child"),
        position: Position::at_end(),
    });

    assert_eq!(
        result,
        Err(DomainError::Cycle {
            node_id: id("parent"),
            parent_id: id("child"),
        })
    );
}

#[test]
fn sibling_positions_are_rebalanced_without_changing_visible_order() {
    let mut tree = NotesTree::default();
    tree.apply(&[TreeMutation::upsert(NoteNode::page(id("page"), "Page"))])
        .unwrap();
    for value in ["one", "two", "three"] {
        let patch = tree
            .plan(NotesCommand::CreateNode {
                id: id(value),
                parent_id: id("page"),
                position: Position::at_end(),
                text: value.into(),
            })
            .unwrap();
        tree.apply(&patch.forward).unwrap();
    }

    let patch = tree
        .plan(NotesCommand::MoveNode {
            id: id("three"),
            parent_id: id("page"),
            position: Position::before(id("two")),
        })
        .unwrap();
    tree.apply(&patch.forward).unwrap();

    assert_eq!(
        tree.children_of(&id("page")),
        vec![id("one"), id("three"), id("two")]
    );
    assert!(
        tree.children_of(&id("page")).windows(2).all(|pair| tree
            .node(&pair[0])
            .unwrap()
            .sort_key()
            < tree.node(&pair[1]).unwrap().sort_key())
    );
}

#[test]
fn held_enter_insertions_keep_existing_sibling_keys_stable() {
    let mut tree = NotesTree::default();
    tree.apply(&[TreeMutation::upsert(NoteNode::page(id("page"), "Page"))])
        .unwrap();
    for value in ["source", "anchor"] {
        let patch = tree
            .plan(NotesCommand::CreateNode {
                id: id(value),
                parent_id: id("page"),
                position: Position::at_end(),
                text: value.into(),
            })
            .unwrap();
        tree.apply(&patch.forward).unwrap();
    }
    let anchor_sort_key = tree.node(&id("anchor")).unwrap().sort_key();

    for index in 0..24 {
        let patch = tree
            .plan(NotesCommand::CreateNode {
                id: id(&format!("inserted-{index}")),
                parent_id: id("page"),
                position: Position::before(id("anchor")),
                text: String::new(),
            })
            .unwrap();
        tree.apply(&patch.forward).unwrap();
        assert_eq!(
            tree.node(&id("anchor")).unwrap().sort_key(),
            anchor_sort_key
        );
    }
}

#[test]
fn duplicating_a_bullet_copies_content_and_flags_without_sharing_identity() {
    let page_id = id("page");
    let source_id = id("source");
    let copy_id = id("copy");
    let mut tree = root_tree();
    create_page(&mut tree, &page_id);
    plan_and_apply(
        &mut tree,
        NotesCommand::CreateNode {
            id: source_id.clone(),
            parent_id: page_id.clone(),
            position: Position::at_end(),
            text: "Copy me".into(),
        },
    );
    plan_and_apply(
        &mut tree,
        NotesCommand::SetStarred {
            id: source_id.clone(),
            starred: true,
        },
    );
    plan_and_apply(
        &mut tree,
        NotesCommand::UpdateNote {
            id: source_id.clone(),
            note: "Supporting context".into(),
        },
    );
    plan_and_apply(
        &mut tree,
        NotesCommand::SetCollapsed {
            id: source_id.clone(),
            collapsed: true,
        },
    );
    plan_and_apply(
        &mut tree,
        NotesCommand::SetMarker {
            id: source_id.clone(),
            marker: NoteMarkerKind::Todo,
        },
    );

    plan_and_apply(
        &mut tree,
        NotesCommand::DuplicateNode {
            source_id: source_id.clone(),
            new_id: copy_id.clone(),
            parent_id: page_id,
            position: Position::at_end(),
        },
    );

    let source = tree.node(&source_id).unwrap();
    let copy = tree.node(&copy_id).unwrap();
    assert_eq!(copy.text(), source.text());
    assert_eq!(copy.note(), source.note());
    assert_eq!(copy.marker(), NoteMarkerKind::Todo);
    assert!(copy.is_collapsed());
    assert_eq!(copy.is_starred(), source.is_starred());
    assert_ne!(copy.id(), source.id());
}

#[test]
fn duplicating_a_bullet_copies_its_descendants_with_fresh_ids() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("source"), id("page"), 1_024, "Source")),
        TreeMutation::upsert(NoteNode::child(id("child"), id("source"), 1_024, "Child")),
        TreeMutation::upsert(NoteNode::child(
            id("grandchild"),
            id("child"),
            1_024,
            "Grandchild",
        )),
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

    let child_copy_id = tree
        .children_of(&id("copy"))
        .first()
        .cloned()
        .expect("copied child");
    let grandchild_copy_id = tree
        .children_of(&child_copy_id)
        .first()
        .cloned()
        .expect("copied grandchild");
    let child_copy = tree.node(&child_copy_id).expect("copied child");
    let grandchild_copy = tree.node(&grandchild_copy_id).expect("copied grandchild");
    assert_eq!(child_copy.parent_id(), Some(&id("copy")));
    assert_eq!(grandchild_copy.parent_id(), Some(&child_copy_id));
    assert_eq!(child_copy.text(), "Child");
    assert_eq!(grandchild_copy.text(), "Grandchild");
}

#[test]
fn restoring_a_descendant_also_restores_its_deleted_ancestor_chain() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("parent"), id("page"), 1_024, "Parent")),
        TreeMutation::upsert(NoteNode::child(id("child"), id("parent"), 1_024, "Child")),
    ])
    .unwrap();
    plan_and_apply(&mut tree, NotesCommand::DeleteSubtree { id: id("parent") });

    plan_and_apply(&mut tree, NotesCommand::RestoreSubtree { id: id("child") });

    assert!(!tree.node(&id("parent")).unwrap().is_deleted());
    assert!(!tree.node(&id("child")).unwrap().is_deleted());
}

#[test]
fn deleted_siblings_keep_their_ordering_slot_until_restore() {
    let mut tree = root_tree();
    create_page(&mut tree, &id("page"));
    for value in ["one", "two"] {
        plan_and_apply(
            &mut tree,
            NotesCommand::CreateNode {
                id: id(value),
                parent_id: id("page"),
                position: Position::at_end(),
                text: value.into(),
            },
        );
    }
    plan_and_apply(&mut tree, NotesCommand::DeleteSubtree { id: id("one") });
    plan_and_apply(
        &mut tree,
        NotesCommand::CreateNode {
            id: id("three"),
            parent_id: id("page"),
            position: Position::at_end(),
            text: "three".into(),
        },
    );

    plan_and_apply(&mut tree, NotesCommand::RestoreSubtree { id: id("one") });

    assert_eq!(
        tree.children_of(&id("page")),
        vec![id("one"), id("two"), id("three")]
    );
}

#[test]
fn completing_many_nodes_is_one_atomic_reversible_patch() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("one"), id("page"), 1_024, "One")),
        TreeMutation::upsert(NoteNode::child(id("two"), id("page"), 2_048, "Two")),
    ])
    .unwrap();
    let original = tree.clone();

    let patch = tree
        .plan(NotesCommand::SetCompletedMany {
            ids: vec![id("one"), id("two")],
            completed: true,
        })
        .unwrap();
    tree.apply(&patch.forward).unwrap();

    assert!(tree.node(&id("one")).unwrap().is_completed());
    assert!(tree.node(&id("two")).unwrap().is_completed());
    tree.apply(&patch.inverse).unwrap();
    assert_eq!(tree, original);
}

#[test]
fn importing_an_outline_forest_is_one_atomic_reversible_patch() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("after"), id("page"), 1_024, "After")),
    ])
    .unwrap();
    let original = tree.clone();

    let patch = tree
        .plan(NotesCommand::ImportNodes {
            parent_id: id("page"),
            position: Position::before(id("after")),
            nodes: vec![
                imported("parent", "page", "Parent"),
                imported("child", "parent", "Child"),
                imported("sibling", "page", "Sibling"),
            ],
        })
        .unwrap();
    tree.apply(&patch.forward).unwrap();

    assert_eq!(
        tree.children_of(&id("page")),
        vec![id("parent"), id("sibling"), id("after")]
    );
    assert_eq!(tree.children_of(&id("parent")), vec![id("child")]);
    tree.apply(&patch.inverse).unwrap();
    assert_eq!(tree, original);
}

#[test]
fn importing_carries_marker_note_tick_and_an_image_reference_in_one_patch() {
    // A page hangs below the root here because one of the imported rows is an
    // image, and an image directly below the root has no heading to live on.
    let mut tree = root_tree();
    create_page(&mut tree, &id("page"));
    let original = tree.clone();

    let patch = tree
        .plan(NotesCommand::ImportNodes {
            parent_id: id("page"),
            position: Position::at_end(),
            nodes: vec![
                ImportNode {
                    note: "Two litres".into(),
                    marker: NoteMarkerKind::Todo,
                    completed: true,
                    collapsed: true,
                    starred: true,
                    ..imported("todo", "page", "Buy milk")
                },
                ImportNode {
                    image: Some(pasted_image()),
                    ..imported("picture", "page", "")
                },
            ],
        })
        .unwrap();
    tree.apply(&patch.forward).unwrap();

    let todo = tree.node(&id("todo")).unwrap();
    assert_eq!(todo.note(), "Two litres");
    assert_eq!(todo.marker(), NoteMarkerKind::Todo);
    assert!(todo.is_completed());
    // A collapsed subtree pastes back collapsed, and a starred row starred.
    assert!(todo.is_collapsed());
    assert!(todo.is_starred());
    let picture = tree.node(&id("picture")).unwrap();
    assert_eq!(picture.kind(), NoteNodeKind::Image);
    assert_eq!(picture.text(), "sample.png");
    assert_eq!(
        picture.image().map(NoteImage::content_hash),
        Some("a".repeat(64).as_str())
    );
    tree.apply(&patch.inverse).unwrap();
    assert_eq!(tree, original);
}

#[test]
fn an_imported_image_node_cannot_be_titled_anything_but_its_file_name() {
    let mut tree = NotesTree::default();
    tree.apply(&[TreeMutation::upsert(NoteNode::page(id("page"), "Page"))])
        .unwrap();

    let error = tree
        .plan(NotesCommand::ImportNodes {
            parent_id: id("page"),
            position: Position::at_end(),
            nodes: vec![ImportNode {
                image: Some(pasted_image()),
                ..imported("picture", "page", "Renamed")
            }],
        })
        .unwrap_err();

    assert!(matches!(error, DomainError::InvalidImage(_)));
    assert!(tree.node(&id("picture")).is_none());
}

#[test]
fn moving_many_nodes_is_one_atomic_reversible_patch() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("a"), id("page"), 1_024, "A")),
        TreeMutation::upsert(NoteNode::child(id("b"), id("page"), 2_048, "B")),
        TreeMutation::upsert(NoteNode::child(id("c"), id("page"), 3_072, "C")),
    ])
    .unwrap();
    let original = tree.clone();

    let patch = tree
        .plan(NotesCommand::MoveNodes {
            moves: vec![
                NodeMove {
                    id: id("b"),
                    parent_id: id("a"),
                    position: Position::at_end(),
                },
                NodeMove {
                    id: id("c"),
                    parent_id: id("a"),
                    position: Position::at_end(),
                },
            ],
        })
        .unwrap();
    tree.apply(&patch.forward).unwrap();

    assert_eq!(tree.children_of(&id("page")), vec![id("a")]);
    assert_eq!(tree.children_of(&id("a")), vec![id("b"), id("c")]);
    tree.apply(&patch.inverse).unwrap();
    assert_eq!(tree, original);
}

#[test]
fn moving_many_into_a_collapsed_parent_expands_it_in_the_same_patch() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("parent"), id("page"), 1_024, "Parent")),
        TreeMutation::upsert(NoteNode::child(id("moving"), id("page"), 2_048, "Moving")),
    ])
    .unwrap();
    plan_and_apply(
        &mut tree,
        NotesCommand::SetCollapsed {
            id: id("parent"),
            collapsed: true,
        },
    );
    let original = tree.clone();

    let patch = tree
        .plan(NotesCommand::MoveNodes {
            moves: vec![NodeMove {
                id: id("moving"),
                parent_id: id("parent"),
                position: Position::at_end(),
            }],
        })
        .unwrap();
    tree.apply(&patch.forward).unwrap();

    assert!(!tree.node(&id("parent")).unwrap().is_collapsed());
    assert_eq!(
        tree.node(&id("moving")).unwrap().parent_id(),
        Some(&id("parent"))
    );
    tree.apply(&patch.inverse).unwrap();
    assert_eq!(tree, original);
}

#[test]
fn duplicating_many_subtrees_is_one_atomic_reversible_patch() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("a"), id("page"), 1_024, "A")),
        TreeMutation::upsert(NoteNode::child(id("b"), id("page"), 2_048, "B")),
        TreeMutation::upsert(NoteNode::child(id("child"), id("b"), 1_024, "Child")),
        TreeMutation::upsert(NoteNode::child(id("c"), id("page"), 3_072, "C")),
        TreeMutation::upsert(NoteNode::child(id("after"), id("page"), 4_096, "After")),
    ])
    .unwrap();
    let original = tree.clone();

    let patch = tree
        .plan(NotesCommand::DuplicateNodes {
            duplicates: vec![
                NodeDuplicate {
                    source_id: id("b"),
                    new_id: id("b-copy"),
                    parent_id: id("page"),
                    position: Position::before(id("after")),
                },
                NodeDuplicate {
                    source_id: id("c"),
                    new_id: id("c-copy"),
                    parent_id: id("page"),
                    position: Position::before(id("after")),
                },
            ],
        })
        .unwrap();
    tree.apply(&patch.forward).unwrap();

    assert_eq!(
        tree.children_of(&id("page")),
        vec![
            id("a"),
            id("b"),
            id("c"),
            id("b-copy"),
            id("c-copy"),
            id("after")
        ]
    );
    let copied_child_id = tree
        .children_of(&id("b-copy"))
        .first()
        .cloned()
        .expect("copied child");
    assert_eq!(tree.node(&copied_child_id).unwrap().text(), "Child");
    tree.apply(&patch.inverse).unwrap();
    assert_eq!(tree, original);
}

#[test]
fn deleting_many_subtrees_is_one_atomic_reversible_patch() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("one"), id("page"), 1_024, "One")),
        TreeMutation::upsert(NoteNode::child(id("child"), id("one"), 1_024, "Child")),
        TreeMutation::upsert(NoteNode::child(id("two"), id("page"), 2_048, "Two")),
    ])
    .unwrap();
    let original = tree.clone();

    let patch = tree
        .plan(NotesCommand::DeleteSubtrees {
            ids: vec![id("one"), id("two")],
        })
        .unwrap();
    tree.apply(&patch.forward).unwrap();

    assert!(tree.node(&id("one")).unwrap().is_deleted());
    assert!(tree.node(&id("child")).unwrap().is_deleted());
    assert!(tree.node(&id("two")).unwrap().is_deleted());
    tree.apply(&patch.inverse).unwrap();
    assert_eq!(tree, original);
}

#[test]
fn split_node_is_atomic_reversible_and_preserves_the_requested_sibling_slot() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(
            id("current"),
            id("page"),
            1_024,
            "alphaXYZomega",
        )),
        TreeMutation::upsert(NoteNode::child(id("next"), id("page"), 2_048, "Next")),
    ])
    .unwrap();
    let original = tree.clone();

    let patch = tree
        .plan(NotesCommand::SplitNode {
            id: id("current"),
            new_id: id("new"),
            parent_id: id("page"),
            position: Position::before(id("next")),
            prefix: "alpha".into(),
            suffix: "omega".into(),
        })
        .unwrap();
    tree.apply(&patch.forward).unwrap();

    assert_eq!(tree.node(&id("current")).unwrap().text(), "alpha");
    assert_eq!(tree.node(&id("new")).unwrap().text(), "omega");
    assert_eq!(
        tree.children_of(&id("page")),
        vec![id("current"), id("new"), id("next")]
    );

    tree.apply(&patch.inverse).unwrap();
    assert_eq!(tree, original);
}

/// A checklist stays a checklist: Enter on a todo row gives the next row its
/// own box rather than dropping back to a plain bullet.
#[test]
fn split_node_carries_the_source_marker_onto_the_new_half() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("current"), id("page"), 1_024, "Task")),
    ])
    .unwrap();
    let marked = tree
        .plan(NotesCommand::SetMarker {
            id: id("current"),
            marker: NoteMarkerKind::Todo,
        })
        .unwrap();
    tree.apply(&marked.forward).unwrap();
    let original = tree.clone();

    let patch = tree
        .plan(NotesCommand::SplitNode {
            id: id("current"),
            new_id: id("new"),
            parent_id: id("page"),
            position: Position::at_end(),
            prefix: "Task".into(),
            suffix: "".into(),
        })
        .unwrap();
    tree.apply(&patch.forward).unwrap();

    assert_eq!(
        tree.node(&id("new")).unwrap().marker(),
        NoteMarkerKind::Todo
    );
    // Inheriting the box must not inherit the tick.
    assert!(!tree.node(&id("new")).unwrap().is_completed());

    tree.apply(&patch.inverse).unwrap();
    assert_eq!(tree, original);
}

#[test]
fn split_node_rejects_page_sources_and_duplicate_new_ids() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("current"), id("page"), 1_024, "Current")),
    ])
    .unwrap();

    assert_eq!(
        tree.plan(NotesCommand::SplitNode {
            id: id("page"),
            new_id: id("new"),
            parent_id: id("page"),
            position: Position::at_end(),
            prefix: "Page".into(),
            suffix: String::new(),
        }),
        Err(DomainError::CannotSplitPage)
    );
    assert_eq!(
        tree.plan(NotesCommand::SplitNode {
            id: id("current"),
            new_id: id("page"),
            parent_id: id("page"),
            position: Position::at_end(),
            prefix: "Current".into(),
            suffix: String::new(),
        }),
        Err(DomainError::DuplicateNode(id("page")))
    );
}

#[test]
fn split_node_rejects_a_parent_that_is_neither_the_source_nor_its_parent() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("current"), id("page"), 1_024, "Current")),
        TreeMutation::upsert(NoteNode::child(id("other"), id("page"), 2_048, "Other")),
    ])
    .unwrap();

    assert!(matches!(
        tree.plan(NotesCommand::SplitNode {
            id: id("current"),
            new_id: id("new"),
            parent_id: id("other"),
            position: Position::at_end(),
            prefix: "Curr".into(),
            suffix: "ent".into(),
        }),
        Err(DomainError::Invariant(_))
    ));
}

#[test]
fn split_node_can_place_the_new_half_inside_the_source_and_opens_it() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("one"), id("page"), 1_024, "alphaomega")),
        TreeMutation::upsert(NoteNode::child(id("child-1"), id("one"), 1_024, "child1")),
        TreeMutation::upsert(NoteNode::child(id("child-2"), id("one"), 2_048, "child2")),
        TreeMutation::upsert(NoteNode::child(id("next"), id("page"), 2_048, "Next")),
    ])
    .unwrap();
    plan_and_apply(
        &mut tree,
        NotesCommand::SetCollapsed {
            id: id("one"),
            collapsed: true,
        },
    );
    let original = tree.clone();

    let patch = tree
        .plan(NotesCommand::SplitNode {
            id: id("one"),
            new_id: id("new"),
            parent_id: id("one"),
            position: Position::before(id("child-1")),
            prefix: "alpha".into(),
            suffix: "omega".into(),
        })
        .unwrap();
    tree.apply(&patch.forward).unwrap();

    assert_eq!(tree.node(&id("one")).unwrap().text(), "alpha");
    assert_eq!(tree.node(&id("new")).unwrap().text(), "omega");
    assert_eq!(
        tree.children_of(&id("one")),
        vec![id("new"), id("child-1"), id("child-2")]
    );
    assert_eq!(tree.children_of(&id("page")), vec![id("one"), id("next")]);
    // The half landed inside a collapsed row, so the same command opens it.
    assert!(!tree.node(&id("one")).unwrap().is_collapsed());

    tree.apply(&patch.inverse).unwrap();
    assert_eq!(tree, original);
}

#[test]
fn merge_backward_keeps_the_current_node_and_round_trips_all_preserved_state() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("previous"), id("page"), 1_024, "alpha")),
        TreeMutation::upsert(NoteNode::from_persisted(
            id("current"),
            Some(id("page")),
            2_048,
            notes_core::NoteNodeKind::Bullet,
            "beta".into(),
            "current note".into(),
            NoteMarkerKind::Todo,
            true,
            true,
            true,
            false,
        )),
        TreeMutation::upsert(NoteNode::child(id("child"), id("current"), 1_024, "Child")),
        TreeMutation::upsert(NoteNode::child(id("next"), id("page"), 3_072, "Next")),
    ])
    .unwrap();
    let original = tree.clone();

    let patch = tree
        .plan(NotesCommand::MergeNodeBackward {
            id: id("current"),
            previous_id: id("previous"),
            previous_text: "draft alpha".into(),
            current_text: "draft beta".into(),
        })
        .unwrap();
    tree.apply(&patch.forward).unwrap();

    assert!(tree.node(&id("previous")).is_none());
    let current = tree.node(&id("current")).unwrap();
    assert_eq!(current.text(), "draft alphadraft beta");
    assert_eq!(current.note(), "current note");
    assert_eq!(current.marker(), NoteMarkerKind::Todo);
    assert!(current.is_collapsed());
    assert!(current.is_completed());
    assert!(current.is_starred());
    assert_eq!(
        tree.children_of(&id("page")),
        vec![id("current"), id("next")]
    );
    assert_eq!(tree.children_of(&id("current")), vec![id("child")]);

    tree.apply(&patch.inverse).unwrap();
    assert_eq!(tree, original);
}

#[test]
fn merge_backward_rejects_nonadjacent_or_structurally_occupied_predecessors() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(
            id("previous"),
            id("page"),
            1_024,
            "Previous",
        )),
        TreeMutation::upsert(NoteNode::child(id("middle"), id("page"), 2_048, "Middle")),
        TreeMutation::upsert(NoteNode::child(id("current"), id("page"), 3_072, "Current")),
    ])
    .unwrap();

    assert!(
        tree.plan(NotesCommand::MergeNodeBackward {
            id: id("current"),
            previous_id: id("previous"),
            previous_text: "Previous".into(),
            current_text: "Current".into(),
        })
        .is_err()
    );

    plan_and_apply(
        &mut tree,
        NotesCommand::UpdateNote {
            id: id("middle"),
            note: "supporting note".into(),
        },
    );
    assert!(
        tree.plan(NotesCommand::MergeNodeBackward {
            id: id("current"),
            previous_id: id("middle"),
            previous_text: "Middle".into(),
            current_text: "Current".into(),
        })
        .is_err()
    );

    plan_and_apply(
        &mut tree,
        NotesCommand::UpdateNote {
            id: id("middle"),
            note: String::new(),
        },
    );
    plan_and_apply(
        &mut tree,
        NotesCommand::CreateNode {
            id: id("middle-child"),
            parent_id: id("middle"),
            position: Position::at_end(),
            text: "Child".into(),
        },
    );
    assert!(
        tree.plan(NotesCommand::MergeNodeBackward {
            id: id("current"),
            previous_id: id("middle"),
            previous_text: "Middle".into(),
            current_text: "Current".into(),
        })
        .is_err()
    );
}

#[test]
fn remove_empty_node_lifts_children_into_its_exact_slot_and_round_trips() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("before"), id("page"), 1_024, "Before")),
        TreeMutation::upsert(NoteNode::child(id("empty"), id("page"), 2_048, " \t")),
        TreeMutation::upsert(NoteNode::child(id("after"), id("page"), 3_072, "After")),
        TreeMutation::upsert(NoteNode::child(
            id("child-a"),
            id("empty"),
            1_024,
            "Child A",
        )),
        TreeMutation::upsert(NoteNode::child(
            id("child-b"),
            id("empty"),
            2_048,
            "Child B",
        )),
    ])
    .unwrap();
    let original = tree.clone();

    let patch = tree
        .plan(NotesCommand::RemoveEmptyNode { id: id("empty") })
        .unwrap();
    tree.apply(&patch.forward).unwrap();

    assert!(tree.node(&id("empty")).is_none());
    assert_eq!(
        tree.children_of(&id("page")),
        vec![id("before"), id("child-a"), id("child-b"), id("after")]
    );
    assert_eq!(
        tree.node(&id("child-a")).unwrap().parent_id(),
        Some(&id("page"))
    );
    assert_eq!(
        tree.node(&id("child-b")).unwrap().parent_id(),
        Some(&id("page"))
    );

    tree.apply(&patch.inverse).unwrap();
    assert_eq!(tree, original);
}

#[test]
fn remove_empty_node_rejects_nonempty_bullets_and_pages() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "")),
        TreeMutation::upsert(NoteNode::child(
            id("nonempty"),
            id("page"),
            1_024,
            "Keep me",
        )),
    ])
    .unwrap();

    assert_eq!(
        tree.plan(NotesCommand::RemoveEmptyNode { id: id("nonempty") }),
        Err(DomainError::NodeNotEmpty(id("nonempty")))
    );
    assert_eq!(
        tree.plan(NotesCommand::RemoveEmptyNode { id: id("page") }),
        Err(DomainError::CannotRemovePage)
    );

    plan_and_apply(
        &mut tree,
        NotesCommand::CreateNode {
            id: id("note-only"),
            parent_id: id("page"),
            position: Position::at_end(),
            text: String::new(),
        },
    );
    plan_and_apply(
        &mut tree,
        NotesCommand::UpdateNote {
            id: id("note-only"),
            note: "Keep this context".into(),
        },
    );
    assert_eq!(
        tree.plan(NotesCommand::RemoveEmptyNode {
            id: id("note-only")
        }),
        Err(DomainError::NodeNotEmpty(id("note-only")))
    );
}

#[test]
fn node_editor_fields_are_reversible_without_crossing_domain_boundaries() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("row"), id("page"), 1_024, "Row")),
    ])
    .unwrap();
    let original = tree.clone();

    let mut inverses = Vec::new();
    for command in [
        NotesCommand::UpdateNote {
            id: id("row"),
            note: "Details #context 2026-07-28".into(),
        },
        NotesCommand::SetCollapsed {
            id: id("row"),
            collapsed: true,
        },
        NotesCommand::SetMarker {
            id: id("row"),
            marker: NoteMarkerKind::Todo,
        },
    ] {
        let patch = tree.plan(command).unwrap();
        tree.apply(&patch.forward).unwrap();
        inverses.push(patch.inverse);
    }

    let row = tree.node(&id("row")).unwrap();
    assert_eq!(row.note(), "Details #context 2026-07-28");
    assert!(row.is_collapsed());
    assert_eq!(row.marker(), NoteMarkerKind::Todo);
    for inverse in inverses.into_iter().rev() {
        tree.apply(&inverse).unwrap();
    }
    assert_eq!(tree, original);
}

#[test]
fn indenting_under_a_collapsed_sibling_expands_it_atomically() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("parent"), id("page"), 1_024, "Parent")),
        TreeMutation::upsert(NoteNode::child(id("current"), id("page"), 2_048, "Current")),
    ])
    .unwrap();
    plan_and_apply(
        &mut tree,
        NotesCommand::SetCollapsed {
            id: id("parent"),
            collapsed: true,
        },
    );
    let original = tree.clone();

    let patch = tree
        .plan(NotesCommand::IndentNode {
            id: id("current"),
            parent_id: id("parent"),
        })
        .unwrap();
    tree.apply(&patch.forward).unwrap();

    assert_eq!(
        tree.node(&id("current")).unwrap().parent_id(),
        Some(&id("parent"))
    );
    assert!(!tree.node(&id("parent")).unwrap().is_collapsed());
    tree.apply(&patch.inverse).unwrap();
    assert_eq!(tree, original);
}

/// page
/// └ top (Todo)
///   ├ first (Todo)
///   ├ second (Todo)
///   └ divider (bullet)
///     └ beyond (Todo)
fn todo_branch() -> NotesTree {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(todo("top", "page", 1_024, false)),
        TreeMutation::upsert(todo("first", "top", 1_024, false)),
        TreeMutation::upsert(todo("second", "top", 2_048, false)),
        TreeMutation::upsert(NoteNode::child(id("divider"), id("top"), 3_072, "Divider")),
        TreeMutation::upsert(todo("beyond", "divider", 1_024, false)),
    ])
    .unwrap();
    tree
}

fn todo(node_id: &str, parent_id: &str, sort_key: i64, completed: bool) -> NoteNode {
    NoteNode::from_persisted(
        id(node_id),
        Some(id(parent_id)),
        sort_key,
        NoteNodeKind::Bullet,
        node_id.into(),
        String::new(),
        NoteMarkerKind::Todo,
        false,
        completed,
        false,
        false,
    )
}

fn set_completed(tree: &mut NotesTree, node_id: &str, completed: bool) {
    plan_and_apply(
        tree,
        NotesCommand::SetCompleted {
            id: id(node_id),
            completed,
        },
    );
}

fn is_completed(tree: &NotesTree, node_id: &str) -> bool {
    tree.node(&id(node_id)).unwrap().is_completed()
}

#[test]
fn ticking_a_todo_settles_the_chain_below_it_and_stops_at_a_bullet() {
    let mut tree = todo_branch();

    set_completed(&mut tree, "top", true);

    assert!(is_completed(&tree, "top"));
    assert!(is_completed(&tree, "first"));
    assert!(is_completed(&tree, "second"));
    // The bullet ends that branch, so nothing under it is touched.
    assert!(!is_completed(&tree, "beyond"));
}

#[test]
fn an_ancestor_todo_waits_for_the_whole_branch_below_it() {
    let mut tree = todo_branch();

    set_completed(&mut tree, "first", true);
    assert!(!is_completed(&tree, "top"));

    set_completed(&mut tree, "second", true);
    assert!(is_completed(&tree, "top"));
}

#[test]
fn an_ancestor_todo_stays_open_while_a_todo_further_down_is_open() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(todo("top", "page", 1_024, false)),
        TreeMutation::upsert(todo("done", "top", 1_024, true)),
        // The ticked sibling's own box is done, so a direct-children-only test
        // reads the branch as settled while this row is still open.
        TreeMutation::upsert(todo("nested", "done", 1_024, false)),
        TreeMutation::upsert(todo("last", "top", 2_048, false)),
    ])
    .unwrap();

    set_completed(&mut tree, "last", true);

    assert!(!is_completed(&tree, "top"));
}

#[test]
fn reopening_a_nested_todo_clears_every_ancestor_todo() {
    let mut tree = todo_branch();
    set_completed(&mut tree, "top", true);

    set_completed(&mut tree, "first", false);

    assert!(!is_completed(&tree, "first"));
    assert!(!is_completed(&tree, "top"));
    assert!(is_completed(&tree, "second"));
}

#[test]
fn completing_one_row_stays_one_reversible_patch() {
    let mut tree = todo_branch();
    let original = tree.clone();

    let patch = tree
        .plan(NotesCommand::SetCompleted {
            id: id("top"),
            completed: true,
        })
        .unwrap();
    tree.apply(&patch.forward).unwrap();
    tree.apply(&patch.inverse).unwrap();

    assert_eq!(tree, original);
}

fn set_completed_many(tree: &mut NotesTree, node_ids: &[&str], completed: bool) {
    plan_and_apply(
        tree,
        NotesCommand::SetCompletedMany {
            ids: node_ids.iter().map(|value| id(value)).collect(),
            completed,
        },
    );
}

#[test]
fn completing_a_selection_settles_each_listed_row_s_own_chain() {
    let mut tree = todo_branch();

    // `first` already sits under `top`, so the two chains overlap.
    set_completed_many(&mut tree, &["top", "first"], true);

    for row in ["top", "first", "second"] {
        assert!(is_completed(&tree, row), "{row} was left open");
    }
    // The bullet ends that branch here exactly as it does for a single tick.
    assert!(!is_completed(&tree, "beyond"));
}

#[test]
fn an_overlapping_selection_lands_the_same_way_in_either_order() {
    let mut ancestor_first = todo_branch();
    let mut descendant_first = todo_branch();

    set_completed_many(&mut ancestor_first, &["top", "first"], true);
    set_completed_many(&mut descendant_first, &["first", "top"], true);

    assert_eq!(ancestor_first, descendant_first);
}

#[test]
fn a_selection_settles_an_ancestor_no_single_row_in_it_could_close() {
    let mut tree = todo_branch();

    // Neither row closes `top` on its own -- `first` leaves `second` open and
    // the other way round. Applying them in order is what settles it.
    set_completed_many(&mut tree, &["first", "second"], true);

    assert!(is_completed(&tree, "top"));
}

proptest! {
    #[test]
    fn every_planned_move_round_trips_through_its_inverse(
        child_count in 2_usize..32,
        moving_index in 0_usize..64,
        before_index in 0_usize..64,
    ) {
        let mut tree = NotesTree::default();
        tree.apply(&[TreeMutation::upsert(NoteNode::page(id("page"), "Page"))])
            .unwrap();
        let child_ids = (0..child_count)
            .map(|index| id(&format!("node-{index}")))
            .collect::<Vec<_>>();
        for child_id in &child_ids {
            let patch = tree
                .plan(NotesCommand::CreateNode {
                    id: child_id.clone(),
                    parent_id: id("page"),
                    position: Position::at_end(),
                    text: child_id.to_string(),
                })
                .unwrap();
            tree.apply(&patch.forward).unwrap();
        }
        let original = tree.clone();
        let moving = child_ids[moving_index % child_count].clone();
        let mut before = child_ids[before_index % child_count].clone();
        if before == moving {
            before = child_ids[(before_index + 1) % child_count].clone();
        }

        let patch = tree
            .plan(NotesCommand::MoveNode {
                id: moving,
                parent_id: id("page"),
                position: Position::before(before),
            })
            .unwrap();
        tree.apply(&patch.forward).unwrap();
        tree.apply(&patch.inverse).unwrap();

        prop_assert_eq!(tree, original);
    }
}

#[test]
fn duplicated_children_get_yid_ids() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("page"), "Page")),
        TreeMutation::upsert(NoteNode::child(id("b"), id("page"), 1_024, "B")),
        TreeMutation::upsert(NoteNode::child(id("child"), id("b"), 1_024, "Child")),
    ])
    .unwrap();
    let copy_id = id("7Cn-irynP6fn");

    let duplicate = |tree: &mut NotesTree| {
        let patch = tree
            .plan(NotesCommand::DuplicateNode {
                source_id: id("b"),
                new_id: copy_id.clone(),
                parent_id: id("page"),
                position: Position::at_end(),
            })
            .unwrap();
        tree.apply(&patch.forward).unwrap();
        tree.children_of(&copy_id)
    };

    let copied = duplicate(&mut tree.clone());

    assert_eq!(copied.len(), 1, "the copy keeps its one child");
    let child_id = copied[0].as_str();
    assert!(
        notes_core::is_yid(child_id),
        "a derived child id has to be a yid the file format can carry, got {child_id}"
    );
    assert_eq!(
        duplicate(&mut tree.clone()),
        copied,
        "the same duplication has to derive the same ids on every device"
    );
}

#[test]
fn a_field_over_the_cap_is_rejected_before_commit() {
    let mut tree = root_tree();
    create_page(&mut tree, &id("page"));
    plan_and_apply(
        &mut tree,
        NotesCommand::CreateNode {
            id: id("row"),
            parent_id: id("page"),
            position: Position::at_end(),
            text: "Row".into(),
        },
    );
    let oversized = "a".repeat(notes_core::MAX_FIELD_BYTES + 1);

    for command in [
        NotesCommand::UpdateText {
            id: id("row"),
            text: oversized.clone(),
        },
        NotesCommand::UpdateNote {
            id: id("row"),
            note: oversized.clone(),
        },
    ] {
        let label = format!("{command:?}");
        assert!(
            tree.plan(command).is_err(),
            "a field the vault would quarantine has to be refused here: {label}"
        );
    }
}

#[test]
fn an_image_cannot_become_a_root_child() {
    let mut tree = root_tree();
    create_page(&mut tree, &id("page"));
    plan_and_apply(
        &mut tree,
        NotesCommand::ImportImages {
            parent_id: id("page"),
            position: Position::at_end(),
            nodes: vec![ImportImageNode {
                id: id("picture"),
                image: pasted_image(),
            }],
        },
    );

    assert!(
        tree.plan(NotesCommand::MoveNode {
            id: id("picture"),
            parent_id: id("root"),
            position: Position::at_end(),
        })
        .is_err(),
        "an image directly under root has no heading to live on, so the vault cannot carry it"
    );
    assert!(
        tree.plan(NotesCommand::ImportImages {
            parent_id: id("root"),
            position: Position::at_end(),
            nodes: vec![ImportImageNode {
                id: id("second-picture"),
                image: pasted_image(),
            }],
        })
        .is_err(),
        "and it cannot be created there either"
    );
}

#[test]
fn a_field_at_the_cap_is_accepted_and_counted_in_bytes() {
    let mut tree = root_tree();
    create_page(&mut tree, &id("page"));
    plan_and_apply(
        &mut tree,
        NotesCommand::CreateNode {
            id: id("row"),
            parent_id: id("page"),
            position: Position::at_end(),
            text: "Row".into(),
        },
    );
    // Three bytes each, so the cap lands mid-character if it counted chars.
    let at_cap = "가".repeat(notes_core::MAX_FIELD_BYTES / 3);
    assert_eq!(at_cap.len(), notes_core::MAX_FIELD_BYTES - 1);

    plan_and_apply(
        &mut tree,
        NotesCommand::UpdateText {
            id: id("row"),
            text: at_cap.clone(),
        },
    );

    assert_eq!(tree.node(&id("row")).unwrap().text(), at_cap);
    assert!(
        tree.plan(NotesCommand::UpdateText {
            id: id("row"),
            text: format!("{at_cap}가"),
        })
        .is_err(),
        "the cap counts bytes, and two more of them pass it"
    );
}

#[test]
fn a_row_deeper_than_the_cap_is_rejected() {
    let mut tree = root_tree();
    create_page(&mut tree, &id("page"));
    let mut parent = id("page");
    // The page already sits below the root, so the cap is reached inside this
    // walk rather than after it.
    for depth in 0..notes_core::MAX_TREE_DEPTH {
        let child = id(&format!("row-{depth}"));
        let command = NotesCommand::CreateNode {
            id: child.clone(),
            parent_id: parent.clone(),
            position: Position::at_end(),
            text: "Row".into(),
        };
        if tree.plan(command.clone()).is_err() {
            assert!(depth > 100, "the cap fired far too early, at {depth}");
            return;
        }
        plan_and_apply(&mut tree, command);
        parent = child;
    }
    panic!(
        "an outline deeper than {} was accepted",
        notes_core::MAX_TREE_DEPTH
    );
}
