use std::collections::BTreeMap;

use notes_core::{
    ImportNode, NodeDuplicate, NodeId, NodeMove, NoteMarkerKind, NotesCommand, Position,
};

use crate::{
    IpcEditorCommand, IpcMarkerKind, IpcNotesCommand, MAX_EDITOR_BATCH_COMMANDS, NotesError,
    NotesErrorCode,
};

const MAX_BATCH_NODE_IDS: usize = 10_000;
const MAX_IMPORT_NODES: usize = 2_000;
const MAX_IMPORT_DEPTH: usize = 64;
const MAX_IMPORT_TEXT_BYTES: usize = 100_000;

fn invalid_command(message: impl Into<String>) -> NotesError {
    NotesError {
        code: NotesErrorCode::InvalidCommand,
        message: message.into(),
        retryable: false,
    }
}

impl TryFrom<IpcEditorCommand> for NotesCommand {
    type Error = NotesError;

    fn try_from(command: IpcEditorCommand) -> Result<Self, Self::Error> {
        let id = |value: String| NodeId::try_from(value).map_err(NotesError::from);
        let position = |before_id: Option<String>| {
            before_id
                .map(id)
                .transpose()
                .map(|before_id| before_id.map_or_else(Position::at_end, Position::before))
        };

        match command {
            IpcEditorCommand::CreateNode {
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
            IpcEditorCommand::UpdateText { id: value, text } => Ok(Self::UpdateText {
                id: id(value)?,
                text,
            }),
            IpcEditorCommand::SplitNode {
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
            IpcEditorCommand::MergeNodeBackward {
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
            IpcEditorCommand::RemoveEmptyNode { id: value } => {
                Ok(Self::RemoveEmptyNode { id: id(value)? })
            }
            IpcEditorCommand::MoveNode {
                id: value,
                parent_id,
                before_id,
            }
            | IpcEditorCommand::Outdent {
                id: value,
                new_parent_id: parent_id,
                before_id,
            } => Ok(Self::MoveNode {
                id: id(value)?,
                parent_id: id(parent_id)?,
                position: position(before_id)?,
            }),
            IpcEditorCommand::Indent {
                id: value,
                new_parent_id,
            } => Ok(Self::IndentNode {
                id: id(value)?,
                parent_id: id(new_parent_id)?,
            }),
            IpcEditorCommand::SetCollapsed {
                id: value,
                collapsed,
            } => Ok(Self::SetCollapsed {
                id: id(value)?,
                collapsed,
            }),
        }
    }
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
            IpcNotesCommand::ApplyEditorBatch { commands } => {
                if commands.is_empty() || commands.len() > MAX_EDITOR_BATCH_COMMANDS {
                    return Err(invalid_command(format!(
                        "An editor batch requires 1 to {MAX_EDITOR_BATCH_COMMANDS} commands."
                    )));
                }
                Ok(Self::Batch {
                    commands: commands
                        .into_iter()
                        .map(NotesCommand::try_from)
                        .collect::<Result<_, NotesError>>()?,
                })
            }
            IpcNotesCommand::CreatePage { id: value, text } => Ok(Self::CreatePage {
                id: id(value)?,
                text,
            }),
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
                marker: match marker {
                    IpcMarkerKind::Bullet => NoteMarkerKind::Bullet,
                    IpcMarkerKind::Todo => NoteMarkerKind::Todo,
                },
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
