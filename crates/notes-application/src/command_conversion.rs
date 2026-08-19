use std::collections::BTreeMap;

use notes_core::{ImportNode, NodeDuplicate, NodeId, NodeMove, NoteImage, NotesCommand, Position};

use crate::{IpcImportImage, IpcMarkerKind, IpcNotesCommand, NotesError, NotesErrorCode};

const MAX_BATCH_NODE_IDS: usize = 10_000;
const MAX_IMPORT_NODES: usize = 2_000;
const MAX_IMPORT_DEPTH: usize = 64;
/// The domain refuses anything past this too, so the two cannot drift into a
/// state where an import is admitted here and rejected there.
const MAX_IMPORT_TEXT_BYTES: usize = notes_core::MAX_FIELD_BYTES;

fn invalid_command(message: impl Into<String>) -> NotesError {
    NotesError {
        code: NotesErrorCode::InvalidCommand,
        message: message.into(),
        retryable: false,
    }
}

/// A paste carries an image's metadata, not its bytes. Every field still goes
/// through the checks a fresh upload gets, including the hash shape.
fn import_image(image: IpcImportImage) -> Result<NoteImage, NotesError> {
    NoteImage::try_referenced(
        image.content_hash,
        image.original_name,
        image.mime_type,
        image.byte_length,
        image.pixel_width,
        image.pixel_height,
        image.display_width,
    )
    .map_err(NotesError::from)
}

impl TryFrom<IpcNotesCommand> for NotesCommand {
    type Error = NotesError;

    fn try_from(command: IpcNotesCommand) -> Result<Self, Self::Error> {
        let id = |value: String| NodeId::try_from(value).map_err(NotesError::from);
        let position = |before_id: Option<String>| {
            before_id
                .map(id)
                .transpose()
                .map(|before_id| before_id.map_or_else(Position::at_end, Position::before))
        };
        let ids = |values: Vec<String>| {
            if values.is_empty() || values.len() > MAX_BATCH_NODE_IDS {
                return Err(invalid_command(format!(
                    "A batch command requires 1 to {MAX_BATCH_NODE_IDS} node IDs."
                )));
            }
            values.into_iter().map(id).collect()
        };
        match command {
            IpcNotesCommand::CreateNode {
                id: value,
                parent_id,
                before_id,
                text,
            } => Ok(Self::CreateNode {
                id: id(value)?,
                parent_id: id(parent_id)?,
                position: position(before_id)?,
                text,
            }),
            IpcNotesCommand::ImportNodes {
                parent_id,
                before_id,
                nodes,
            } => {
                if nodes.is_empty() || nodes.len() > MAX_IMPORT_NODES {
                    return Err(invalid_command(format!(
                        "An outline import requires 1 to {MAX_IMPORT_NODES} nodes."
                    )));
                }
                let parent_id = id(parent_id)?;
                let mut depths = BTreeMap::new();
                let mut imported = Vec::with_capacity(nodes.len());
                let mut roots = 0;
                for node in nodes {
                    if node.text.len() > MAX_IMPORT_TEXT_BYTES {
                        return Err(invalid_command("An imported title is too large."));
                    }
                    let note = node.note.unwrap_or_default();
                    if note.len() > MAX_IMPORT_TEXT_BYTES {
                        return Err(invalid_command("An imported note is too large."));
                    }
                    let image = node.image.map(import_image).transpose()?;
                    let node_id = id(node.id)?;
                    let node_parent_id = id(node.parent_id)?;
                    let depth = if node_parent_id == parent_id {
                        roots += 1;
                        1
                    } else {
                        depths
                            .get(&node_parent_id)
                            .copied()
                            .map(|depth: usize| depth + 1)
                            .ok_or_else(|| {
                                invalid_command("Each imported parent must precede its children.")
                            })?
                    };
                    if depth > MAX_IMPORT_DEPTH || depths.insert(node_id.clone(), depth).is_some() {
                        return Err(invalid_command(
                            "The imported outline is too deep or contains duplicate IDs.",
                        ));
                    }
                    imported.push(ImportNode {
                        id: node_id,
                        parent_id: node_parent_id,
                        text: node.text,
                        note,
                        marker: node.marker.unwrap_or(IpcMarkerKind::Bullet).into(),
                        completed: node.completed.unwrap_or_default(),
                        collapsed: node.collapsed.unwrap_or_default(),
                        starred: node.starred.unwrap_or_default(),
                        image,
                    });
                }
                if roots == 0 {
                    return Err(invalid_command("The imported outline has no root."));
                }
                Ok(Self::ImportNodes {
                    parent_id,
                    position: position(before_id)?,
                    nodes: imported,
                })
            }
            IpcNotesCommand::UpdateText { id: value, text } => Ok(Self::UpdateText {
                id: id(value)?,
                text,
            }),
            IpcNotesCommand::UpdateNote { id: value, note } => Ok(Self::UpdateNote {
                id: id(value)?,
                note,
            }),
            IpcNotesCommand::SplitNode {
                id: value,
                new_id,
                parent_id,
                before_id,
                prefix,
                suffix,
            } => Ok(Self::SplitNode {
                id: id(value)?,
                new_id: id(new_id)?,
                parent_id: id(parent_id)?,
                position: position(before_id)?,
                prefix,
                suffix,
            }),
            IpcNotesCommand::MergeNodeBackward {
                id: value,
                previous_id,
                previous_text,
                current_text,
            } => Ok(Self::MergeNodeBackward {
                id: id(value)?,
                previous_id: id(previous_id)?,
                previous_text,
                current_text,
            }),
            IpcNotesCommand::MergeNodeIntoParent {
                id: value,
                parent_id,
                parent_text,
                current_text,
            } => Ok(Self::MergeNodeIntoParent {
                id: id(value)?,
                parent_id: id(parent_id)?,
                parent_text,
                current_text,
            }),
            IpcNotesCommand::RemoveEmptyNode { id: value } => {
                Ok(Self::RemoveEmptyNode { id: id(value)? })
            }
            IpcNotesCommand::MoveNode {
                id: value,
                parent_id,
                before_id,
            }
            | IpcNotesCommand::Outdent {
                id: value,
                new_parent_id: parent_id,
                before_id,
            } => Ok(Self::MoveNode {
                id: id(value)?,
                parent_id: id(parent_id)?,
                position: position(before_id)?,
            }),
            IpcNotesCommand::MoveNodes { moves } => {
                if moves.is_empty() || moves.len() > MAX_IMPORT_NODES {
                    return Err(invalid_command(format!(
                        "A batch move requires 1 to {MAX_IMPORT_NODES} nodes."
                    )));
                }
                Ok(Self::MoveNodes {
                    moves: moves
                        .into_iter()
                        .map(|node_move| {
                            Ok(NodeMove {
                                id: id(node_move.id)?,
                                parent_id: id(node_move.parent_id)?,
                                position: position(node_move.before_id)?,
                            })
                        })
                        .collect::<Result<_, NotesError>>()?,
                })
            }
            IpcNotesCommand::Indent {
                id: value,
                new_parent_id,
            } => Ok(Self::IndentNode {
                id: id(value)?,
                parent_id: id(new_parent_id)?,
            }),
            IpcNotesCommand::SetCompleted {
                id: value,
                completed,
            } => Ok(Self::SetCompleted {
                id: id(value)?,
                completed,
            }),
            IpcNotesCommand::SetCompletedMany {
                ids: values,
                completed,
            } => Ok(Self::SetCompletedMany {
                ids: ids(values)?,
                completed,
            }),
            // The rows to hand back are the session's to know, so the command
            // leaves here empty and the service fills it in.
            IpcNotesCommand::CycleCompleted { id: value } => Ok(Self::CycleCompleted {
                id: id(value)?,
                restore: Vec::new(),
            }),
            IpcNotesCommand::SetStarred { id: value, starred } => Ok(Self::SetStarred {
                id: id(value)?,
                starred,
            }),
            IpcNotesCommand::SetCollapsed {
                id: value,
                collapsed,
            } => Ok(Self::SetCollapsed {
                id: id(value)?,
                collapsed,
            }),
            IpcNotesCommand::SetMarker { id: value, marker } => Ok(Self::SetMarker {
                id: id(value)?,
                marker: marker.into(),
            }),
            IpcNotesCommand::ResizeImage {
                id: value,
                display_width,
            } => Ok(Self::ResizeImage {
                id: id(value)?,
                display_width,
            }),
            IpcNotesCommand::DeleteSubtree { id: value } => {
                Ok(Self::DeleteSubtree { id: id(value)? })
            }
            IpcNotesCommand::DeleteSubtrees { ids: values } => {
                Ok(Self::DeleteSubtrees { ids: ids(values)? })
            }
            IpcNotesCommand::RestoreSubtree { id: value } => {
                Ok(Self::RestoreSubtree { id: id(value)? })
            }
            IpcNotesCommand::Duplicate {
                id: source_id,
                new_id,
                parent_id,
                before_id,
            } => Ok(Self::DuplicateNode {
                source_id: id(source_id)?,
                new_id: id(new_id)?,
                parent_id: id(parent_id)?,
                position: position(before_id)?,
            }),
            IpcNotesCommand::DuplicateNodes { duplicates } => {
                if duplicates.is_empty() || duplicates.len() > MAX_IMPORT_NODES {
                    return Err(invalid_command(format!(
                        "A batch duplicate requires 1 to {MAX_IMPORT_NODES} nodes."
                    )));
                }
                Ok(Self::DuplicateNodes {
                    duplicates: duplicates
                        .into_iter()
                        .map(|duplicate| {
                            Ok(NodeDuplicate {
                                source_id: id(duplicate.id)?,
                                new_id: id(duplicate.new_id)?,
                                parent_id: id(duplicate.parent_id)?,
                                position: position(duplicate.before_id)?,
                            })
                        })
                        .collect::<Result<_, NotesError>>()?,
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use notes_core::{NoteMarkerKind, NotesCommand};

    use super::MAX_IMPORT_TEXT_BYTES;
    use crate::{IpcImportImage, IpcImportNode, IpcMarkerKind, IpcNotesCommand, NotesErrorCode};

    fn import(nodes: Vec<IpcImportNode>) -> Result<NotesCommand, crate::NotesError> {
        IpcNotesCommand::ImportNodes {
            parent_id: "page".into(),
            before_id: None,
            nodes,
        }
        .try_into()
    }

    fn node(text: &str) -> IpcImportNode {
        IpcImportNode {
            id: "pasted".into(),
            parent_id: "page".into(),
            text: text.into(),
            ..IpcImportNode::default()
        }
    }

    fn image(content_hash: &str) -> IpcImportImage {
        IpcImportImage {
            content_hash: content_hash.into(),
            original_name: "sample.png".into(),
            mime_type: "image/png".into(),
            byte_length: 3,
            pixel_width: 1,
            pixel_height: 1,
            display_width: 320,
        }
    }

    #[test]
    fn a_text_only_import_carries_the_defaults_a_plain_paste_relies_on() {
        let command = import(vec![node("Buy milk")]).expect("convert text-only import");

        let NotesCommand::ImportNodes { nodes, .. } = command else {
            panic!("import must convert to an import command");
        };
        assert_eq!(nodes[0].note, "");
        assert_eq!(nodes[0].marker, NoteMarkerKind::Bullet);
        assert!(!nodes[0].completed);
        assert!(nodes[0].image.is_none());
    }

    #[test]
    fn a_rich_import_carries_marker_note_tick_and_a_derived_image_path() {
        let command = import(vec![IpcImportNode {
            note: Some("Two litres".into()),
            marker: Some(IpcMarkerKind::Todo),
            completed: Some(true),
            image: Some(image(&"a".repeat(64))),
            ..node("sample.png")
        }])
        .expect("convert rich import");

        let NotesCommand::ImportNodes { nodes, .. } = command else {
            panic!("import must convert to an import command");
        };
        assert_eq!(nodes[0].note, "Two litres");
        assert_eq!(nodes[0].marker, NoteMarkerKind::Todo);
        assert!(nodes[0].completed);
        let image = nodes[0].image.as_ref().expect("image reference");
        assert_eq!(image.relative_path(), format!("{}.png", "a".repeat(64)));
    }

    #[test]
    fn an_oversized_imported_note_is_rejected_like_an_oversized_title() {
        let oversized = "n".repeat(MAX_IMPORT_TEXT_BYTES + 1);

        let error = import(vec![IpcImportNode {
            note: Some(oversized),
            ..node("Buy milk")
        }])
        .expect_err("an oversized note must be rejected");

        assert_eq!(error.code, NotesErrorCode::InvalidCommand);
    }

    #[test]
    fn an_image_reference_is_rejected_unless_its_hash_and_type_are_usable() {
        for unusable in [
            image("not-a-hash"),
            image(&"A".repeat(64)),
            IpcImportImage {
                mime_type: "image/svg+xml".into(),
                ..image(&"a".repeat(64))
            },
        ] {
            let error = import(vec![IpcImportNode {
                image: Some(unusable),
                ..node("sample.png")
            }])
            .expect_err("an unusable image reference must be rejected");
            assert_eq!(error.code, NotesErrorCode::InvalidCommand);
        }
    }
}
