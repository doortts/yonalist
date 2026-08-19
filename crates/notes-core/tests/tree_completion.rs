use notes_core::{
    ImportNode, NodeId, NoteMarkerKind, NoteNode, NoteNodeKind, NotesCommand, NotesTree, Position,
    TreeMutation,
};

fn id(value: &str) -> NodeId {
    NodeId::try_from(value).expect("valid node id")
}

fn plan_and_apply(tree: &mut NotesTree, command: NotesCommand) {
    let patch = tree.plan(command).unwrap();
    tree.apply(&patch.forward).unwrap();
}

/// root (the one page)
/// └ diary (a page row)
///   └ top (Todo)
///     ├ first (Todo)
///     ├ second (Todo)
///     └ divider (bullet)
///       └ beyond (Todo)
fn todo_branch() -> NotesTree {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("root"), "Home")),
        TreeMutation::upsert(NoteNode::child(id("diary"), id("root"), 1_024, "Diary")),
        TreeMutation::upsert(todo("top", "diary", 1_024, false)),
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
fn ticking_a_row_leaves_its_children_as_they_are() {
    let mut tree = todo_branch();

    set_completed(&mut tree, "top", true);

    // A completed row is that row's own statement about itself. What is left
    // open under it is left open -- it may be work nobody can do any more.
    assert!(is_completed(&tree, "top"));
    for row in ["first", "second", "divider", "beyond"] {
        assert!(!is_completed(&tree, row), "{row} was touched");
    }
}

#[test]
fn a_finished_child_stands_for_the_rows_under_it() {
    let mut tree = todo_branch();
    // `divider` says it is done; the open row under it is its own business.
    set_completed(&mut tree, "divider", true);
    set_completed(&mut tree, "first", true);

    set_completed(&mut tree, "second", true);

    assert!(is_completed(&tree, "top"));
    assert!(!is_completed(&tree, "beyond"));
}

#[test]
fn an_ancestor_waits_for_its_own_children() {
    let mut tree = todo_branch();

    set_completed(&mut tree, "first", true);
    set_completed(&mut tree, "second", true);
    // `divider` is still open, so its parent is not finished.
    assert!(!is_completed(&tree, "top"));

    set_completed(&mut tree, "divider", true);
    assert!(is_completed(&tree, "top"));
}

#[test]
fn an_ancestor_bullet_follows_the_rows_below_it_too() {
    let mut tree = page_with_rows();

    set_completed(&mut tree, "boxed", true);
    assert!(!is_completed(&tree, "plain"));

    set_completed(&mut tree, "bare", true);
    assert!(is_completed(&tree, "plain"));
}

#[test]
fn reopening_a_row_clears_an_ancestor_bullet_too() {
    let mut tree = page_with_rows();
    set_completed(&mut tree, "boxed", true);
    set_completed(&mut tree, "bare", true);
    assert!(is_completed(&tree, "plain"));

    set_completed(&mut tree, "bare", false);

    assert!(!is_completed(&tree, "plain"));
    assert!(is_completed(&tree, "boxed"));
}

#[test]
fn a_new_row_under_a_finished_branch_opens_it_again() {
    let mut tree = page_with_rows();
    set_completed(&mut tree, "boxed", true);
    set_completed(&mut tree, "bare", true);
    assert!(is_completed(&tree, "plain"));

    plan_and_apply(
        &mut tree,
        NotesCommand::CreateNode {
            id: id("fresh"),
            parent_id: id("plain"),
            position: Position::at_end(),
            text: "one more thing".into(),
        },
    );

    // The branch is no longer finished, so the row heading it cannot say it is.
    assert!(!is_completed(&tree, "plain"));
    assert!(is_completed(&tree, "boxed"));
}

/// root (the one page)
/// └ diary (a page row)
///   └ granny (finished on its own say-so)
///     ├ mother (open, because `sister` is)
///     │ ├ boxed (finished)
///     │ └ sister (open)
///     └ aunt (finished)
fn declared_branch() -> NotesTree {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("root"), "Home")),
        TreeMutation::upsert(NoteNode::child(id("diary"), id("root"), 1_024, "Diary")),
        TreeMutation::upsert(NoteNode::child(id("granny"), id("diary"), 1_024, "Granny")),
        TreeMutation::upsert(NoteNode::child(id("mother"), id("granny"), 1_024, "Mother")),
        TreeMutation::upsert(todo("boxed", "mother", 1_024, false)),
        TreeMutation::upsert(NoteNode::child(id("sister"), id("mother"), 2_048, "Sister")),
        TreeMutation::upsert(NoteNode::child(id("aunt"), id("granny"), 2_048, "Aunt")),
    ])
    .unwrap();
    tree
}

/// A row left open by hand under a finished row is the whole point of the
/// declaration: work nobody can do any more stays open and the row above it stays
/// closed. Opening some leaf under it is not news to that row -- the row it
/// reaches is the first one that was already open, and no further.
#[test]
fn opening_a_row_does_not_reach_past_the_first_open_row_above_it() {
    let mut tree = declared_branch();
    set_completed(&mut tree, "boxed", true);
    set_completed(&mut tree, "granny", true);
    assert!(is_completed(&tree, "granny"));
    // `mother` is open because `sister` is, which is exactly the state a
    // declaration leaves behind.
    assert!(!is_completed(&tree, "mother"));

    set_completed(&mut tree, "boxed", false);

    assert!(!is_completed(&tree, "boxed"));
    // `mother` was already open, so nothing above it hears about this.
    assert!(is_completed(&tree, "granny"));
}

/// A pasted row arrives saying it is finished, and that statement covers the rows
/// it brought with it. So the open row inside a pasted subtree is news to nobody
/// above the row that pasted it -- least of all to a declaration made further up.
#[test]
fn work_inside_a_finished_arrival_is_that_arrival_s_own_business() {
    let mut tree = declared_branch();
    set_completed(&mut tree, "granny", true);
    assert!(is_completed(&tree, "granny"));

    plan_and_apply(
        &mut tree,
        NotesCommand::ImportNodes {
            parent_id: id("aunt"),
            position: Position::at_end(),
            nodes: vec![
                ImportNode {
                    id: id("pasted"),
                    parent_id: id("aunt"),
                    text: "Pasted".into(),
                    note: String::new(),
                    marker: NoteMarkerKind::Bullet,
                    completed: true,
                    collapsed: false,
                    starred: false,
                    image: None,
                },
                ImportNode {
                    id: id("pasted-child"),
                    parent_id: id("pasted"),
                    text: "Pasted child".into(),
                    note: String::new(),
                    marker: NoteMarkerKind::Bullet,
                    completed: false,
                    collapsed: false,
                    starred: false,
                    image: None,
                },
            ],
        },
    );

    assert!(is_completed(&tree, "pasted"));
    assert!(is_completed(&tree, "granny"));
}

/// A branch out of the trash comes back as it went in, tick and all, and that tick
/// speaks for the rows it brought back with it -- exactly as a pasted one does.
#[test]
fn a_branch_out_of_the_trash_keeps_the_tick_it_went_in_with() {
    let mut tree = declared_branch();
    plan_and_apply(
        &mut tree,
        NotesCommand::CreateNode {
            id: id("kept"),
            parent_id: id("aunt"),
            position: Position::at_end(),
            text: "Kept".into(),
        },
    );
    plan_and_apply(
        &mut tree,
        NotesCommand::CreateNode {
            id: id("kept-child"),
            parent_id: id("kept"),
            position: Position::at_end(),
            text: "Kept child".into(),
        },
    );
    set_completed(&mut tree, "kept", true);
    plan_and_apply(&mut tree, NotesCommand::DeleteSubtree { id: id("kept") });
    set_completed(&mut tree, "granny", true);
    assert!(is_completed(&tree, "granny"));

    plan_and_apply(&mut tree, NotesCommand::RestoreSubtree { id: id("kept") });

    // The row says what it said when it was trashed, and it speaks for the open
    // row it brought back.
    assert!(is_completed(&tree, "kept"));
    assert!(is_completed(&tree, "granny"));
}

/// And the other way: work that arrives where nothing speaks for it opens every
/// finished row above it, up to the first that was already open.
#[test]
fn work_arriving_under_a_finished_row_opens_the_run_above_it() {
    let mut tree = declared_branch();
    set_completed(&mut tree, "aunt", true);
    set_completed(&mut tree, "granny", true);

    plan_and_apply(
        &mut tree,
        NotesCommand::CreateNode {
            id: id("fresh"),
            parent_id: id("aunt"),
            position: Position::at_end(),
            text: "One more thing".into(),
        },
    );

    assert!(!is_completed(&tree, "aunt"));
    assert!(!is_completed(&tree, "granny"));
}

#[test]
fn taking_the_press_back_leaves_a_finished_row_above_it_alone() {
    let mut tree = declared_branch();
    set_completed(&mut tree, "boxed", true);
    set_completed(&mut tree, "sister", true);
    // `mother` followed its children; open it again by hand.
    assert!(is_completed(&tree, "mother"));
    set_completed(&mut tree, "granny", true);

    plan_and_apply(
        &mut tree,
        NotesCommand::CycleCompleted {
            id: id("mother"),
            restore: vec![(id("boxed"), true), (id("sister"), false)],
        },
    );

    assert!(!is_completed(&tree, "mother"));
    assert!(!is_completed(&tree, "sister"));
    // `mother` coming open is news to `granny`, which sits directly above it.
    assert!(!is_completed(&tree, "granny"));
}

#[test]
fn a_blank_row_waits_until_something_is_written_in_it() {
    let mut tree = page_with_rows();
    set_completed(&mut tree, "boxed", true);
    set_completed(&mut tree, "bare", true);
    assert!(is_completed(&tree, "plain"));

    plan_and_apply(
        &mut tree,
        NotesCommand::CreateNode {
            id: id("fresh"),
            parent_id: id("plain"),
            position: Position::at_end(),
            text: String::new(),
        },
    );

    // Enter makes blanks all the time; an empty row is nothing left to do.
    assert!(is_completed(&tree, "plain"));

    plan_and_apply(
        &mut tree,
        NotesCommand::UpdateText {
            id: id("fresh"),
            text: "something to do".into(),
        },
    );

    assert!(!is_completed(&tree, "plain"));
}

#[test]
fn a_row_moved_under_a_finished_branch_opens_it_again() {
    let mut tree = page_with_rows();
    plan_and_apply(
        &mut tree,
        NotesCommand::CreateNode {
            id: id("elsewhere"),
            parent_id: id("diary"),
            position: Position::at_end(),
            text: "Elsewhere".into(),
        },
    );
    set_completed(&mut tree, "boxed", true);
    set_completed(&mut tree, "bare", true);
    assert!(is_completed(&tree, "plain"));

    plan_and_apply(
        &mut tree,
        NotesCommand::MoveNode {
            id: id("elsewhere"),
            parent_id: id("plain"),
            position: Position::at_end(),
        },
    );

    assert!(!is_completed(&tree, "plain"));
}

#[test]
fn a_finished_row_placed_under_a_finished_branch_leaves_it_finished() {
    let mut tree = page_with_rows();
    plan_and_apply(
        &mut tree,
        NotesCommand::CreateNode {
            id: id("elsewhere"),
            parent_id: id("diary"),
            position: Position::at_end(),
            text: "Elsewhere".into(),
        },
    );
    set_completed(&mut tree, "elsewhere", true);
    set_completed(&mut tree, "boxed", true);
    set_completed(&mut tree, "bare", true);

    plan_and_apply(
        &mut tree,
        NotesCommand::MoveNode {
            id: id("elsewhere"),
            parent_id: id("plain"),
            position: Position::at_end(),
        },
    );

    assert!(is_completed(&tree, "plain"));
}

#[test]
fn trashing_the_last_open_row_finishes_the_branch_above_it() {
    let mut tree = page_with_rows();
    set_completed(&mut tree, "boxed", true);
    assert!(!is_completed(&tree, "plain"));

    plan_and_apply(&mut tree, NotesCommand::DeleteSubtree { id: id("bare") });

    // Nothing open is left under it, so the row heading the branch is done.
    assert!(is_completed(&tree, "plain"));
}

#[test]
fn trashing_the_last_blank_row_finishes_the_branch_above_it() {
    let mut tree = page_with_rows();
    set_completed(&mut tree, "boxed", true);
    plan_and_apply(
        &mut tree,
        NotesCommand::UpdateText {
            id: id("bare"),
            text: String::new(),
        },
    );
    // A blank row is not something left to do, but it is not done either, so
    // while it is there the branch above it is not finished.
    assert!(!is_completed(&tree, "plain"));

    plan_and_apply(&mut tree, NotesCommand::DeleteSubtree { id: id("bare") });

    assert!(is_completed(&tree, "plain"));
}

#[test]
fn trashing_the_last_row_of_all_leaves_the_branch_alone() {
    let mut tree = page_with_rows();

    for row in ["boxed", "bare"] {
        plan_and_apply(&mut tree, NotesCommand::DeleteSubtree { id: id(row) });
    }

    // A row with nothing under it is not a finished branch, it is an empty one.
    assert!(!is_completed(&tree, "plain"));
}

#[test]
fn trashing_one_of_two_open_rows_leaves_the_branch_open() {
    let mut tree = page_with_rows();

    plan_and_apply(&mut tree, NotesCommand::DeleteSubtree { id: id("bare") });

    assert!(!is_completed(&tree, "plain"));
}

#[test]
fn moving_the_last_open_row_away_finishes_the_branch_it_left() {
    let mut tree = page_with_rows();
    set_completed(&mut tree, "boxed", true);

    plan_and_apply(
        &mut tree,
        NotesCommand::MoveNode {
            id: id("bare"),
            parent_id: id("diary"),
            position: Position::at_end(),
        },
    );

    assert!(is_completed(&tree, "plain"));
}

/// A cut subtree comes back the way it was cut: the rows inside it arrive with
/// their own states, and their arrival is not news to the row they arrived under.
#[test]
fn a_pasted_row_keeps_the_tick_it_was_cut_with() {
    let mut tree = page_with_rows();

    plan_and_apply(
        &mut tree,
        NotesCommand::ImportNodes {
            parent_id: id("plain"),
            position: Position::at_end(),
            nodes: vec![
                ImportNode {
                    id: id("pasted"),
                    parent_id: id("plain"),
                    text: "Pasted".into(),
                    note: String::new(),
                    marker: NoteMarkerKind::Todo,
                    completed: true,
                    collapsed: false,
                    starred: false,
                    image: None,
                },
                ImportNode {
                    id: id("pasted-child"),
                    parent_id: id("pasted"),
                    text: "Pasted child".into(),
                    note: String::new(),
                    marker: NoteMarkerKind::Bullet,
                    completed: false,
                    collapsed: false,
                    starred: false,
                    image: None,
                },
            ],
        },
    );

    assert!(is_completed(&tree, "pasted"));
}

#[test]
fn reordering_rows_inside_a_finished_branch_leaves_it_finished() {
    let mut tree = page_with_rows();
    set_completed(&mut tree, "boxed", true);
    set_completed(&mut tree, "bare", true);

    plan_and_apply(
        &mut tree,
        NotesCommand::MoveNode {
            id: id("bare"),
            parent_id: id("plain"),
            position: Position::before(id("boxed")),
        },
    );

    assert!(is_completed(&tree, "plain"));
}

/// A page row is not a row of the outline it holds: it is the page's title and
/// the name in the sidebar, and the filter that hides finished rows would hide
/// the whole page with it. Finishing everything written on a page says the rows
/// are done, not that the page is.
#[test]
fn the_climb_stops_below_the_page_row() {
    let mut tree = page_with_rows();

    set_completed(&mut tree, "boxed", true);
    set_completed(&mut tree, "bare", true);

    assert!(is_completed(&tree, "plain"));
    assert!(!is_completed(&tree, "diary"));
    assert!(!is_completed(&tree, "root"));
}

/// root (the one page)
/// └ diary (a page row, which every outline hangs under)
///   └ plain (bullet)
///     ├ boxed (Todo)
///     └ bare (bullet)
fn page_with_rows() -> NotesTree {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("root"), "Home")),
        TreeMutation::upsert(NoteNode::child(id("diary"), id("root"), 1_024, "Diary")),
        TreeMutation::upsert(NoteNode::child(id("plain"), id("diary"), 1_024, "Plain")),
        TreeMutation::upsert(todo("boxed", "plain", 1_024, false)),
        TreeMutation::upsert(NoteNode::child(id("bare"), id("plain"), 2_048, "Bare")),
    ])
    .unwrap();
    tree
}

#[test]
fn an_ancestor_reads_its_children_and_stops_there() {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("root"), "Home")),
        TreeMutation::upsert(NoteNode::child(id("diary"), id("root"), 1_024, "Diary")),
        TreeMutation::upsert(todo("top", "diary", 1_024, false)),
        TreeMutation::upsert(todo("done", "top", 1_024, true)),
        // `done` says it is done, so the row under it is `done`'s own business.
        TreeMutation::upsert(todo("nested", "done", 1_024, false)),
        TreeMutation::upsert(todo("last", "top", 2_048, false)),
    ])
    .unwrap();

    set_completed(&mut tree, "last", true);

    assert!(is_completed(&tree, "top"));
    assert!(!is_completed(&tree, "nested"));
}

#[test]
fn reopening_a_row_clears_every_ancestor() {
    let mut tree = todo_branch();
    for row in ["first", "second", "divider"] {
        set_completed(&mut tree, row, true);
    }
    assert!(is_completed(&tree, "top"));

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
fn completing_a_selection_finishes_the_rows_it_names_and_no_others() {
    let mut tree = todo_branch();

    // `first` already sits under `top`, so the two overlap.
    set_completed_many(&mut tree, &["top", "first"], true);

    for row in ["top", "first"] {
        assert!(is_completed(&tree, row), "{row} was left open");
    }
    for row in ["second", "divider", "beyond"] {
        assert!(!is_completed(&tree, row), "{row} was not in the selection");
    }
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

    // No row in the list closes `top` on its own -- each of the others is left
    // open. Applying them in order is what settles it.
    set_completed_many(&mut tree, &["first", "second", "divider"], true);

    assert!(is_completed(&tree, "top"));
}
