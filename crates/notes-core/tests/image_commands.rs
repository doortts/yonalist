use notes_core::{
    DomainError, ImportImageNode, NodeId, NoteImage, NoteNode, NoteNodeKind, NotesCommand,
    NotesTree, Position, TreeMutation,
};

fn id(value: &str) -> NodeId {
    NodeId::try_from(value).expect("valid test node id")
}

fn image(seed: char, original_name: &str, display_width: u32) -> NoteImage {
    let hash = seed.to_string().repeat(64);
    NoteImage::try_new(
        hash.clone(),
        format!("{hash}.png"),
        original_name,
        "image/png",
        67,
        1,
        1,
        display_width,
    )
    .expect("valid image metadata")
}

/// The shape the app actually holds: one root page, and the row images hang
/// below is a child of it. An image directly under the root would be a document
/// whose heading is an image, which the vault has no line for.
fn page_tree() -> NotesTree {
    let mut tree = NotesTree::default();
    tree.apply(&[
        TreeMutation::upsert(NoteNode::page(id("root"), "Home")),
        TreeMutation::upsert(NoteNode::child(id("page"), id("root"), 1_024, "Page")),
    ])
    .expect("page apply");
    tree
}

fn import_cat(tree: &mut NotesTree) {
    let patch = tree
        .plan(NotesCommand::ImportImages {
            parent_id: id("page"),
            position: Position::at_end(),
            nodes: vec![ImportImageNode {
                id: id("cat"),
                image: image('a', "cat.png", 320),
            }],
        })
        .expect("image patch");
    tree.apply(&patch.forward).expect("image apply");
}

#[test]
fn image_batch_is_ordered_and_reversible() {
    let mut tree = page_tree();
    let patch = tree
        .plan(NotesCommand::ImportImages {
            parent_id: id("page"),
            position: Position::at_end(),
            nodes: vec![
                ImportImageNode {
                    id: id("cat"),
                    image: image('a', "cat.png", 320),
                },
                ImportImageNode {
                    id: id("dog"),
                    image: image('b', "dog.png", 480),
                },
            ],
        })
        .expect("image batch");

    tree.apply(&patch.forward).expect("apply import");
    assert_eq!(tree.children_of(&id("page")), vec![id("cat"), id("dog")]);
    let cat = tree.node(&id("cat")).expect("cat node");
    assert_eq!(cat.kind(), NoteNodeKind::Image);
    assert_eq!(cat.text(), "cat.png");
    assert_eq!(cat.image().expect("cat image").display_width(), 320);

    tree.apply(&patch.inverse).expect("undo import");
    assert!(tree.node(&id("cat")).is_none());
    assert!(tree.node(&id("dog")).is_none());
}

#[test]
fn image_metadata_rejects_values_that_cannot_be_safely_persisted() {
    let valid = || {
        (
            "a".repeat(64),
            format!("{}.png", "a".repeat(64)),
            "cat.png".to_owned(),
            "image/png".to_owned(),
            67_u64,
            1_u32,
            1_u32,
            120_u32,
        )
    };
    let mut invalid = Vec::new();
    invalid.push({
        let mut value = valid();
        value.0 = "A".repeat(64);
        value
    });
    invalid.push({
        let mut value = valid();
        value.1 = "../cat.png".into();
        value
    });
    invalid.push({
        let mut value = valid();
        value.3 = "image/svg+xml".into();
        value
    });
    invalid.push({
        let mut value = valid();
        value.4 = 0;
        value
    });
    invalid.push({
        let mut value = valid();
        value.5 = 0;
        value
    });
    invalid.push({
        let mut value = valid();
        value.5 = 10_000;
        value.6 = 4_001;
        value
    });
    invalid.push({
        let mut value = valid();
        value.7 = 119;
        value
    });

    for (
        content_hash,
        relative_path,
        original_name,
        mime_type,
        byte_length,
        pixel_width,
        pixel_height,
        display_width,
    ) in invalid
    {
        assert!(
            NoteImage::try_new(
                content_hash,
                relative_path,
                original_name,
                mime_type,
                byte_length,
                pixel_width,
                pixel_height,
                display_width,
            )
            .is_err()
        );
    }
}

#[test]
fn resize_and_replace_are_reversible_and_replace_preserves_display_width() {
    let mut tree = page_tree();
    import_cat(&mut tree);

    let resize = tree
        .plan(NotesCommand::ResizeImage {
            id: id("cat"),
            display_width: 420,
        })
        .expect("resize patch");
    tree.apply(&resize.forward).expect("apply resize");
    assert_eq!(
        tree.node(&id("cat"))
            .and_then(|node| node.image())
            .map(NoteImage::display_width),
        Some(420)
    );
    tree.apply(&resize.inverse).expect("undo resize");
    assert_eq!(
        tree.node(&id("cat"))
            .and_then(|node| node.image())
            .map(NoteImage::display_width),
        Some(320)
    );

    let replacement = image('b', "replacement.png", 900);
    let replace = tree
        .plan(NotesCommand::ReplaceImage {
            id: id("cat"),
            image: replacement,
        })
        .expect("replace patch");
    tree.apply(&replace.forward).expect("apply replace");
    let replaced = tree.node(&id("cat")).expect("replaced node");
    assert_eq!(replaced.text(), "replacement.png");
    assert_eq!(replaced.image().expect("replacement").display_width(), 320);
    tree.apply(&replace.inverse).expect("undo replace");
    assert_eq!(tree.node(&id("cat")).expect("restored").text(), "cat.png");
}

#[test]
fn generic_text_gestures_do_not_mutate_image_primary_content() {
    let mut tree = page_tree();
    import_cat(&mut tree);
    let before = tree.clone();

    for command in [
        NotesCommand::UpdateText {
            id: id("cat"),
            text: "not a filename".into(),
        },
        NotesCommand::SplitNode {
            id: id("cat"),
            new_id: id("split"),
            parent_id: id("page"),
            position: Position::at_end(),
            prefix: String::new(),
            suffix: String::new(),
        },
        NotesCommand::RemoveEmptyNode { id: id("cat") },
    ] {
        assert!(tree.plan(command).is_err());
        assert_eq!(tree, before);
    }
}

#[test]
fn duplicate_delete_and_restore_preserve_image_identity_and_metadata() {
    let mut tree = page_tree();
    import_cat(&mut tree);

    let duplicate = tree
        .plan(NotesCommand::DuplicateNode {
            source_id: id("cat"),
            new_id: id("copy"),
            parent_id: id("page"),
            position: Position::at_end(),
        })
        .expect("duplicate image");
    tree.apply(&duplicate.forward).expect("apply duplicate");
    let copy = tree.node(&id("copy")).expect("copy node");
    assert_eq!(copy.kind(), NoteNodeKind::Image);
    assert_eq!(
        copy.image(),
        tree.node(&id("cat")).and_then(|node| node.image())
    );

    let deleted = tree
        .plan(NotesCommand::DeleteSubtree { id: id("copy") })
        .expect("delete image");
    tree.apply(&deleted.forward).expect("apply delete");
    assert!(tree.node(&id("copy")).expect("deleted copy").is_deleted());
    tree.apply(&deleted.inverse).expect("undo delete");
    assert!(!tree.node(&id("copy")).expect("restored copy").is_deleted());
}

#[test]
fn an_empty_image_batch_is_rejected_without_mutating_the_tree() {
    let tree = page_tree();
    assert!(matches!(
        tree.plan(NotesCommand::ImportImages {
            parent_id: id("page"),
            position: Position::at_end(),
            nodes: Vec::new(),
        }),
        Err(DomainError::Invariant(_))
    ));
    assert!(tree.node(&id("cat")).is_none());
}
