use crate::notes::date_index::{LocalTodayProvider, SystemLocalTodayProvider};
use crate::notes::types::{
    validate_note_id, ApplyImageAtomEditInput, ImageAtomEdit, ImageAtomFocusResult,
    ImageAtomMutationResult, ImageAtomOperationLookup, ImageAtomOperationReceiptResult,
    ImageTargetAuthority, LogicalSelection, NoteNodeKind, NotesHistoryContext, NotesMutationResult,
    NotesWorkspaceScope,
};
use crate::notes::{history, repository};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const MAX_HISTORY_EPOCH_BYTES: usize = 128;
const MAX_RECEIPT_RESULT_BYTES: usize = 32 * 1024;
const MAX_RECEIPT_AFFECTED_ROOT_IDS: usize = 128;
const MAX_SAFE_UTF16_OFFSET: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone)]
pub(crate) enum ImageAtomAttachmentMutation {
    Remove,
    MoveTo(String),
    Keep,
}

#[derive(Debug, Clone)]
pub(crate) struct ImageAtomSiblingPlan {
    pub(crate) id: String,
    pub(crate) node_kind: NoteNodeKind,
    pub(crate) title: String,
    pub(crate) image_offset_utf16: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct ImageAtomEditPlan {
    pub(crate) source_node_kind: NoteNodeKind,
    pub(crate) source_title: String,
    pub(crate) source_image_offset_utf16: i64,
    pub(crate) attachment_mutation: ImageAtomAttachmentMutation,
    pub(crate) sibling: Option<ImageAtomSiblingPlan>,
    pub(crate) focus: ImageAtomFocusResult,
    normalized_selection: (i64, i64),
}

pub(crate) struct ImageAtomEditApplyResult {
    pub(crate) result: ImageAtomMutationResult,
    pub(crate) pruned_attachment_paths: Vec<String>,
}

fn sha256_hex(bytes: impl AsRef<[u8]>) -> String {
    Sha256::digest(bytes.as_ref())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn utf16_len(value: &str) -> Result<i64, String> {
    i64::try_from(value.encode_utf16().count())
        .map_err(|_| "The Notes image atom title is too long.".to_string())
}

fn raw_byte_offset(
    title: &str,
    image_offset_utf16: i64,
    logical_offset: i64,
) -> Result<usize, String> {
    let raw_offset = if logical_offset <= image_offset_utf16 {
        logical_offset
    } else {
        logical_offset
            .checked_sub(1)
            .ok_or_else(|| "The Notes image atom selection is invalid.".to_string())?
    };
    crate::notes::schema::validate_image_offset_utf16(title, NoteNodeKind::Image, raw_offset)
}

fn normalized_selection(
    title: &str,
    image_offset_utf16: i64,
    selection: &LogicalSelection,
) -> Result<(i64, i64), String> {
    crate::notes::schema::validate_image_offset_utf16(
        title,
        NoteNodeKind::Image,
        image_offset_utf16,
    )?;
    let logical_length = utf16_len(title)?
        .checked_add(1)
        .ok_or_else(|| "The Notes image atom title is too long.".to_string())?;
    let anchor = selection.anchor_utf16.clamp(0, logical_length);
    let focus = selection.focus_utf16.clamp(0, logical_length);
    let (start, end) = if anchor <= focus {
        (anchor, focus)
    } else {
        (focus, anchor)
    };
    raw_byte_offset(title, image_offset_utf16, start)?;
    raw_byte_offset(title, image_offset_utf16, end)?;
    Ok((start, end))
}

fn replace_raw_range(title: &str, start: usize, end: usize, replacement: &str) -> String {
    let mut result = String::with_capacity(
        start
            .saturating_add(replacement.len())
            .saturating_add(title.len().saturating_sub(end)),
    );
    result.push_str(&title[..start]);
    result.push_str(replacement);
    result.push_str(&title[end..]);
    result
}

fn validate_target_authority(target: &ImageTargetAuthority) -> Result<(), String> {
    validate_note_id(&target.node_id)?;
    validate_note_id(&target.expected_primary_attachment_id).map_err(|_| {
        "The expected Notes image primary attachment ID must be a canonical UUID v4 string."
            .to_string()
    })?;
    if target.expected_updated_at.trim().is_empty() || target.expected_updated_at.contains('\0') {
        return Err("The expected Notes image update timestamp is invalid.".to_string());
    }
    crate::notes::schema::validate_image_offset_utf16(
        &target.expected_title,
        NoteNodeKind::Image,
        target.expected_image_offset_utf16,
    )
    .map(|_| ())
}

fn edit_plan(input: &ApplyImageAtomEditInput) -> Result<ImageAtomEditPlan, String> {
    validate_target_authority(&input.target)?;
    let title = &input.target.expected_title;
    let image_offset = input.target.expected_image_offset_utf16;
    let (start, end) = normalized_selection(title, image_offset, &input.selection)?;
    let atom_selected = start <= image_offset && end >= image_offset + 1;
    let atom_only = start == image_offset && end == image_offset + 1;
    let collapsed = start == end;
    let adjacent_caret = collapsed && (start == image_offset || start == image_offset + 1);
    let byte_offset = raw_byte_offset(title, image_offset, image_offset)?;

    match &input.edit {
        ImageAtomEdit::Remove { replacement_text } => {
            if !atom_selected && !adjacent_caret {
                return Err(
                    "The Notes image edit must select the image atom or an adjacent caret."
                        .to_string(),
                );
            }
            let start_byte = if adjacent_caret {
                byte_offset
            } else {
                raw_byte_offset(title, image_offset, start)?
            };
            let end_byte = if adjacent_caret {
                byte_offset
            } else {
                raw_byte_offset(title, image_offset, end)?
            };
            let focus = utf16_len(&title[..start_byte])?
                .checked_add(utf16_len(replacement_text)?)
                .ok_or_else(|| "The Notes image atom selection is too large.".to_string())?;
            Ok(ImageAtomEditPlan {
                source_node_kind: NoteNodeKind::Text,
                source_title: replace_raw_range(title, start_byte, end_byte, replacement_text),
                source_image_offset_utf16: 0,
                attachment_mutation: ImageAtomAttachmentMutation::Remove,
                sibling: None,
                focus: ImageAtomFocusResult {
                    node_id: input.target.node_id.clone(),
                    anchor_utf16: focus,
                    focus_utf16: focus,
                },
                normalized_selection: (start, end),
            })
        }
        ImageAtomEdit::Enter { sibling_id } => {
            validate_note_id(sibling_id)?;
            if sibling_id == &input.target.node_id {
                return Err("An image atom split requires a fresh sibling Note ID.".to_string());
            }
            let (
                source_node_kind,
                source_title,
                source_image_offset_utf16,
                attachment_mutation,
                sibling,
            ) = if atom_only {
                (
                    NoteNodeKind::Image,
                    title.to_string(),
                    image_offset,
                    ImageAtomAttachmentMutation::Keep,
                    ImageAtomSiblingPlan {
                        id: sibling_id.clone(),
                        node_kind: NoteNodeKind::Text,
                        title: String::new(),
                        image_offset_utf16: 0,
                    },
                )
            } else if !collapsed && end <= image_offset {
                let start_byte = raw_byte_offset(title, image_offset, start)?;
                let end_byte = raw_byte_offset(title, image_offset, end)?;
                let text = replace_raw_range(title, start_byte, end_byte, "");
                let remaining_image_offset = image_offset
                    .checked_sub(end - start)
                    .ok_or_else(|| "The Notes image atom selection is invalid.".to_string())?;
                let sibling_offset = remaining_image_offset
                    .checked_sub(start)
                    .ok_or_else(|| "The Notes image atom selection is invalid.".to_string())?;
                (
                    NoteNodeKind::Text,
                    text[..start_byte].to_string(),
                    0,
                    ImageAtomAttachmentMutation::MoveTo(sibling_id.clone()),
                    ImageAtomSiblingPlan {
                        id: sibling_id.clone(),
                        node_kind: NoteNodeKind::Image,
                        title: text[start_byte..].to_string(),
                        image_offset_utf16: sibling_offset,
                    },
                )
            } else if !collapsed && start >= image_offset + 1 {
                let start_byte = raw_byte_offset(title, image_offset, start)?;
                let end_byte = raw_byte_offset(title, image_offset, end)?;
                let text = replace_raw_range(title, start_byte, end_byte, "");
                (
                    NoteNodeKind::Image,
                    text[..start_byte].to_string(),
                    image_offset,
                    ImageAtomAttachmentMutation::Keep,
                    ImageAtomSiblingPlan {
                        id: sibling_id.clone(),
                        node_kind: NoteNodeKind::Text,
                        title: text[start_byte..].to_string(),
                        image_offset_utf16: 0,
                    },
                )
            } else if collapsed && start <= image_offset {
                let caret_byte = raw_byte_offset(title, image_offset, start)?;
                let sibling_offset = image_offset
                    .checked_sub(start)
                    .ok_or_else(|| "The Notes image atom selection is invalid.".to_string())?;
                (
                    NoteNodeKind::Text,
                    title[..caret_byte].to_string(),
                    0,
                    ImageAtomAttachmentMutation::MoveTo(sibling_id.clone()),
                    ImageAtomSiblingPlan {
                        id: sibling_id.clone(),
                        node_kind: NoteNodeKind::Image,
                        title: title[caret_byte..].to_string(),
                        image_offset_utf16: sibling_offset,
                    },
                )
            } else if collapsed && start >= image_offset + 1 {
                let caret_byte = raw_byte_offset(title, image_offset, start)?;
                (
                    NoteNodeKind::Image,
                    title[..caret_byte].to_string(),
                    image_offset,
                    ImageAtomAttachmentMutation::Keep,
                    ImageAtomSiblingPlan {
                        id: sibling_id.clone(),
                        node_kind: NoteNodeKind::Text,
                        title: title[caret_byte..].to_string(),
                        image_offset_utf16: 0,
                    },
                )
            } else if atom_selected {
                let start_byte = raw_byte_offset(title, image_offset, start)?;
                let end_byte = raw_byte_offset(title, image_offset, end)?;
                let text = replace_raw_range(title, start_byte, end_byte, "");
                let split_byte = crate::notes::schema::validate_image_offset_utf16(
                    &text,
                    NoteNodeKind::Image,
                    utf16_len(&text[..start_byte])?,
                )?;
                (
                    NoteNodeKind::Text,
                    text[..split_byte].to_string(),
                    0,
                    ImageAtomAttachmentMutation::Remove,
                    ImageAtomSiblingPlan {
                        id: sibling_id.clone(),
                        node_kind: NoteNodeKind::Text,
                        title: text[split_byte..].to_string(),
                        image_offset_utf16: 0,
                    },
                )
            } else {
                return Err(
                    "The Notes image edit must select the image atom or an adjacent caret."
                        .to_string(),
                );
            };
            Ok(ImageAtomEditPlan {
                source_node_kind,
                source_title,
                source_image_offset_utf16,
                attachment_mutation,
                sibling: Some(sibling.clone()),
                focus: ImageAtomFocusResult {
                    node_id: sibling.id,
                    anchor_utf16: 0,
                    focus_utf16: 0,
                },
                normalized_selection: (start, end),
            })
        }
    }
}

fn validate_history_epoch(value: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.len() > MAX_HISTORY_EPOCH_BYTES
        || value.as_bytes().contains(&0)
    {
        return Err("Notes image operation history epoch is invalid.".to_string());
    }
    Ok(())
}

fn validate_hex_digest(label: &str, value: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!(
            "Notes image operation {label} must be a lowercase SHA-256 digest."
        ));
    }
    Ok(())
}

fn validate_receipt(receipt: &ImageAtomOperationReceiptResult) -> Result<(), String> {
    validate_note_id(&receipt.operation_id)
        .map_err(|_| "Notes image operation ID must be a canonical UUID v4 string.".to_string())?;
    validate_history_epoch(&receipt.history_epoch)?;
    validate_hex_digest("postcondition digest", &receipt.postcondition_digest)?;
    if receipt.affected_root_ids.is_empty()
        || receipt.affected_root_ids.len() > MAX_RECEIPT_AFFECTED_ROOT_IDS
    {
        return Err("Notes image operation affected root IDs are invalid.".to_string());
    }
    let mut affected_ids = HashSet::with_capacity(receipt.affected_root_ids.len());
    for node_id in &receipt.affected_root_ids {
        validate_note_id(node_id)
            .map_err(|_| "Notes image operation affected root IDs are invalid.".to_string())?;
        if !affected_ids.insert(node_id) {
            return Err("Notes image operation affected root IDs must be unique.".to_string());
        }
    }
    validate_note_id(&receipt.focus.node_id).map_err(|_| {
        "Notes image operation focus node ID must be a canonical UUID v4 string.".to_string()
    })?;
    if receipt.focus.anchor_utf16 < 0
        || receipt.focus.focus_utf16 < 0
        || receipt.focus.anchor_utf16 > MAX_SAFE_UTF16_OFFSET
        || receipt.focus.focus_utf16 > MAX_SAFE_UTF16_OFFSET
    {
        return Err(
            "Notes image operation focus offsets must be safe nonnegative integers.".to_string(),
        );
    }
    Ok(())
}

fn validate_authority(
    session_id: &str,
    history_epoch: &str,
    operation_id: &str,
) -> Result<(), String> {
    validate_note_id(session_id).map_err(|_| {
        "Notes image operation session ID must be a canonical UUID v4 string.".to_string()
    })?;
    validate_history_epoch(history_epoch)?;
    validate_note_id(operation_id)
        .map_err(|_| "Notes image operation ID must be a canonical UUID v4 string.".to_string())
}

fn current_epoch(connection: &Connection) -> Result<String, String> {
    connection
        .query_row("SELECT value FROM notes_history_epoch", [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("Could not read the Notes history epoch: {error}"))
}

fn parse_receipt(
    operation_id: String,
    history_epoch: String,
    postcondition_digest: String,
    result_json: String,
) -> Result<ImageAtomOperationReceiptResult, String> {
    if result_json.len() > MAX_RECEIPT_RESULT_BYTES {
        return Err("A Notes image operation receipt result is too large.".to_string());
    }
    let receipt = serde_json::from_str::<ImageAtomOperationReceiptResult>(&result_json)
        .map_err(|error| format!("Could not decode a Notes image operation receipt: {error}"))?;
    validate_receipt(&receipt)?;
    if receipt.operation_id != operation_id
        || receipt.history_epoch != history_epoch
        || receipt.postcondition_digest != postcondition_digest
    {
        return Err(
            "A Notes image operation receipt does not match its stored authority.".to_string(),
        );
    }
    Ok(receipt)
}

pub(crate) fn install_operation_receipts(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS notes_image_atom_operations (\
               operation_id TEXT PRIMARY KEY REFERENCES notes_history_entries(id) ON DELETE CASCADE, \
               session_id TEXT NOT NULL, \
               history_epoch TEXT NOT NULL, \
               fingerprint TEXT NOT NULL, \
               postcondition_digest TEXT NOT NULL, \
               result_json TEXT NOT NULL, \
               acknowledged INTEGER NOT NULL DEFAULT 0\
             );",
        )
        .map_err(|error| format!("Could not install TEMP Notes image operation receipts: {error}"))
}

#[allow(dead_code)]
pub(crate) fn record_operation_receipt(
    connection: &Connection,
    session_id: &str,
    fingerprint: String,
    receipt: &ImageAtomOperationReceiptResult,
) -> Result<ImageAtomOperationReceiptResult, String> {
    validate_authority(session_id, &receipt.history_epoch, &receipt.operation_id)?;
    validate_hex_digest("fingerprint", &fingerprint)?;
    validate_receipt(receipt)?;
    if current_epoch(connection)? != receipt.history_epoch {
        return Err("The Notes history epoch is stale.".to_string());
    }
    let history_entry_session = connection
        .query_row(
            "SELECT session_id FROM notes_history_entries WHERE id = ?1",
            [&receipt.operation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| {
            format!("Could not inspect a Notes image operation history entry: {error}")
        })?;
    if history_entry_session.as_deref() != Some(session_id) {
        return Err(
            "A Notes image operation receipt must belong to its history session.".to_string(),
        );
    }
    let result_json = serde_json::to_string(receipt)
        .map_err(|error| format!("Could not encode a Notes image operation receipt: {error}"))?;
    if result_json.len() > MAX_RECEIPT_RESULT_BYTES {
        return Err("A Notes image operation receipt result is too large.".to_string());
    }

    let existing = connection
        .query_row(
            "SELECT session_id, history_epoch, fingerprint, postcondition_digest, result_json \
             FROM notes_image_atom_operations WHERE operation_id = ?1",
            [&receipt.operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not inspect a Notes image operation receipt: {error}"))?;
    if let Some((stored_session_id, stored_epoch, stored_fingerprint, stored_digest, stored_json)) =
        existing
    {
        if stored_session_id != session_id || stored_epoch != receipt.history_epoch {
            return Err(
                "A Notes image operation ID belongs to another session or epoch.".to_string(),
            );
        }
        if stored_fingerprint != fingerprint {
            return Err(
                "A Notes image operation ID cannot be reused with a different fingerprint."
                    .to_string(),
            );
        }
        let stored = parse_receipt(
            receipt.operation_id.clone(),
            stored_epoch,
            stored_digest,
            stored_json,
        )?;
        if stored != *receipt {
            return Err(
                "A Notes image operation ID cannot be reused with a different result.".to_string(),
            );
        }
        return Ok(stored);
    }

    let unresolved_operation_id = connection
        .query_row(
            "SELECT operation_id FROM notes_image_atom_operations \
             WHERE acknowledged = 0 ORDER BY operation_id LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not inspect unresolved Notes image operations: {error}"))?;
    if unresolved_operation_id.is_some() {
        return Err("Only one Notes image operation may remain unacknowledged.".to_string());
    }

    let inserted = connection
        .execute(
            "INSERT INTO notes_image_atom_operations(\
               operation_id, session_id, history_epoch, fingerprint, postcondition_digest, result_json\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                &receipt.operation_id,
                session_id,
                &receipt.history_epoch,
                fingerprint,
                &receipt.postcondition_digest,
                result_json,
            ],
        )
        .map_err(|error| format!("Could not store a Notes image operation receipt: {error}"))?;
    if inserted != 1 {
        return Err("Could not store a Notes image operation receipt.".to_string());
    }
    Ok(receipt.clone())
}

fn matching_operation_receipt(
    connection: &Connection,
    session_id: &str,
    history_epoch: &str,
    operation_id: &str,
    fingerprint: &str,
) -> Result<Option<ImageAtomOperationReceiptResult>, String> {
    validate_authority(session_id, history_epoch, operation_id)?;
    validate_hex_digest("fingerprint", fingerprint)?;
    if current_epoch(connection)? != history_epoch {
        return Err("The Notes history epoch is stale.".to_string());
    }
    let existing = connection
        .query_row(
            "SELECT session_id, history_epoch, fingerprint, postcondition_digest, result_json \
             FROM notes_image_atom_operations WHERE operation_id = ?1",
            [operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not inspect a Notes image operation receipt: {error}"))?;
    let Some((stored_session_id, stored_epoch, stored_fingerprint, digest, result_json)) = existing
    else {
        return Ok(None);
    };
    if stored_session_id != session_id || stored_epoch != history_epoch {
        return Err("A Notes image operation ID belongs to another session or epoch.".to_string());
    }
    if stored_fingerprint != fingerprint {
        return Err(
            "A Notes image operation ID cannot be reused with a different fingerprint.".to_string(),
        );
    }
    Ok(Some(parse_receipt(
        operation_id.to_string(),
        stored_epoch,
        digest,
        result_json,
    )?))
}

fn fingerprint(
    input: &ApplyImageAtomEditInput,
    history_context: &NotesHistoryContext,
    plan: &ImageAtomEditPlan,
) -> Result<String, String> {
    serde_json::to_vec(&(
        "notes_apply_image_atom_edit",
        &history_context.session_id,
        &history_context.history_epoch,
        &history_context.entry_id,
        history_context.command_kind.trim(),
        &input.target,
        plan.normalized_selection,
        &input.edit,
    ))
    .map(sha256_hex)
    .map_err(|error| format!("Could not fingerprint the Notes image atom edit: {error}"))
}

fn postcondition_digest(plan: &ImageAtomEditPlan) -> Result<String, String> {
    let attachment = match &plan.attachment_mutation {
        ImageAtomAttachmentMutation::Remove => ("remove", None),
        ImageAtomAttachmentMutation::MoveTo(node_id) => ("move", Some(node_id.as_str())),
        ImageAtomAttachmentMutation::Keep => ("keep", None),
    };
    let sibling = plan.sibling.as_ref().map(|sibling| {
        (
            sibling.id.as_str(),
            sibling.node_kind.as_str(),
            sibling.title.as_str(),
            sibling.image_offset_utf16,
        )
    });
    serde_json::to_vec(&(
        plan.source_node_kind.as_str(),
        plan.source_title.as_str(),
        plan.source_image_offset_utf16,
        attachment,
        sibling,
        &plan.focus,
    ))
    .map(sha256_hex)
    .map_err(|error| format!("Could not digest the Notes image atom edit: {error}"))
}

fn operation_receipt(
    history_context: &NotesHistoryContext,
    source_node_id: &str,
    plan: &ImageAtomEditPlan,
) -> Result<ImageAtomOperationReceiptResult, String> {
    let mut affected_root_ids = vec![source_node_id.to_string()];
    if let Some(sibling) = &plan.sibling {
        if !affected_root_ids.iter().any(|id| id == &sibling.id) {
            affected_root_ids.push(sibling.id.clone());
        }
    }
    Ok(ImageAtomOperationReceiptResult {
        operation_id: history_context.entry_id.clone(),
        history_epoch: history_context.history_epoch.clone(),
        postcondition_digest: postcondition_digest(plan)?,
        affected_root_ids,
        focus: plan.focus.clone(),
    })
}

pub(crate) fn apply_image_atom_edit_with_prunes(
    connection: &mut Connection,
    input: ApplyImageAtomEditInput,
    history_context: NotesHistoryContext,
) -> Result<ImageAtomEditApplyResult, String> {
    history::validate_context(&history_context)?;
    if history_context.command_kind.trim() != "imageAtomEdit" {
        return Err(
            "Notes image atom edits require the imageAtomEdit history command kind.".to_string(),
        );
    }
    let plan = edit_plan(&input)?;
    let fingerprint = fingerprint(&input, &history_context, &plan)?;
    if let Some(operation) = matching_operation_receipt(
        connection,
        &history_context.session_id,
        &history_context.history_epoch,
        &history_context.entry_id,
        &fingerprint,
    )? {
        return Ok(ImageAtomEditApplyResult {
            result: ImageAtomMutationResult {
                mutation: NotesMutationResult {
                    workspace: repository::load_workspace(connection, NotesWorkspaceScope::Active)?,
                    history_entry_id: Some(history_context.entry_id),
                    state: history::history_state(
                        connection,
                        &history_context.session_id,
                        Vec::new(),
                    )?,
                    changed_nodes: None,
                    removed_node_ids: None,
                    changed_attachments: None,
                    imported_root_ids: None,
                    duplicated_root_ids: None,
                },
                operation,
            },
            pruned_attachment_paths: Vec::new(),
        });
    }

    let receipt = operation_receipt(&history_context, &input.target.node_id, &plan)?;
    let today = SystemLocalTodayProvider.local_today(connection)?;
    let result = history::with_history_transaction_and_prunes(
        connection,
        Some(&history_context),
        |connection| {
            repository::apply_image_atom_edit_plan(
                connection,
                &input.target,
                &plan,
                today,
                |transaction, _workspace| {
                    record_operation_receipt(
                        transaction,
                        &history_context.session_id,
                        fingerprint,
                        &receipt,
                    )
                    .map(|_| ())
                },
            )
        },
    )?;
    let pruned_attachment_paths = result.pruned_attachment_paths.clone();
    let mutation = result.into_mutation_result();
    if mutation.history_entry_id.as_deref() != Some(history_context.entry_id.as_str()) {
        return Err(
            "The Notes image atom edit did not create its required history entry.".to_string(),
        );
    }
    Ok(ImageAtomEditApplyResult {
        result: ImageAtomMutationResult {
            mutation,
            operation: receipt,
        },
        pruned_attachment_paths,
    })
}

#[cfg(test)]
pub(crate) fn apply_image_atom_edit(
    connection: &mut Connection,
    input: ApplyImageAtomEditInput,
    history_context: NotesHistoryContext,
) -> Result<ImageAtomMutationResult, String> {
    apply_image_atom_edit_with_prunes(connection, input, history_context)
        .map(|result| result.result)
}

pub(crate) fn lookup_operation_receipt(
    connection: &Connection,
    session_id: &str,
    history_epoch: &str,
    operation_id: &str,
) -> Result<ImageAtomOperationLookup, String> {
    validate_authority(session_id, history_epoch, operation_id)?;
    let current_epoch = current_epoch(connection)?;
    if current_epoch != history_epoch {
        return Ok(ImageAtomOperationLookup::EpochMismatch {
            history_epoch: current_epoch,
        });
    }
    let receipt = connection
        .query_row(
            "SELECT session_id, history_epoch, postcondition_digest, result_json \
             FROM notes_image_atom_operations WHERE operation_id = ?1",
            [operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not load a Notes image operation receipt: {error}"))?;
    let Some((stored_session_id, stored_epoch, postcondition_digest, result_json)) = receipt else {
        return Ok(ImageAtomOperationLookup::Missing {
            history_epoch: current_epoch,
        });
    };
    if stored_session_id != session_id || stored_epoch != history_epoch {
        return Err(
            "A Notes image operation receipt belongs to another session or epoch.".to_string(),
        );
    }
    Ok(ImageAtomOperationLookup::Found {
        receipt: parse_receipt(
            operation_id.to_string(),
            stored_epoch,
            postcondition_digest,
            result_json,
        )?,
    })
}

pub(crate) fn ack_operation_receipt(
    connection: &Connection,
    session_id: &str,
    history_epoch: &str,
    operation_id: &str,
) -> Result<(), String> {
    validate_authority(session_id, history_epoch, operation_id)?;
    if current_epoch(connection)? != history_epoch {
        return Err("The Notes history epoch is stale.".to_string());
    }
    let changed = connection
        .execute(
            "UPDATE notes_image_atom_operations SET acknowledged = 1 \
             WHERE operation_id = ?1 AND session_id = ?2 AND history_epoch = ?3",
            params![operation_id, session_id, history_epoch],
        )
        .map_err(|error| {
            format!("Could not acknowledge a Notes image operation receipt: {error}")
        })?;
    if changed == 1 {
        return Ok(());
    }
    let exists = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_image_atom_operations WHERE operation_id = ?1)",
            [operation_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("Could not inspect a Notes image operation receipt: {error}"))?;
    if exists {
        Err("A Notes image operation receipt belongs to another session or epoch.".to_string())
    } else {
        Err("The Notes image operation receipt does not exist.".to_string())
    }
}

pub(crate) fn clear_operation_receipts(connection: &Connection) -> Result<(), String> {
    connection
        .execute("DELETE FROM notes_image_atom_operations", [])
        .map(|_| ())
        .map_err(|error| format!("Could not clear Notes image operation receipts: {error}"))
}

#[cfg(test)]
pub(crate) fn clear_operation_receipts_for_session(
    connection: &Connection,
    session_id: &str,
) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM notes_image_atom_operations WHERE session_id = ?1",
            [session_id],
        )
        .map(|_| ())
        .map_err(|error| format!("Could not clear Notes image operation receipts: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{
        ack_operation_receipt, apply_image_atom_edit, lookup_operation_receipt,
        record_operation_receipt,
    };
    use crate::notes::history::{history_epoch, redo, undo};
    use crate::notes::repository::connect_notes_db;
    use crate::notes::types::{
        ApplyImageAtomEditInput, ImageAtomEdit, ImageAtomFocusResult, ImageAtomOperationLookup,
        ImageAtomOperationReceiptResult, ImageTargetAuthority, LogicalSelection, NoteNodeKind,
        NotesHistoryContext, NotesWorkspaceScope,
    };
    use rusqlite::params;

    const SESSION_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const FOREIGN_SESSION_ID: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const OPERATION_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const SECOND_OPERATION_ID: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const NODE_ID: &str = "11111111-1111-4111-8111-111111111111";
    const CHILD_ID: &str = "22222222-2222-4222-8222-222222222222";
    const ATTACHMENT_ID: &str = "33333333-3333-4333-8333-333333333333";
    const SIBLING_ID: &str = "44444444-4444-4444-8444-444444444444";

    fn insert_history_entry(connection: &rusqlite::Connection, operation_id: &str) {
        connection
            .execute(
                "INSERT INTO notes_history_entries(id, session_id, sequence, command_kind) \
                 VALUES (?1, ?2, (SELECT COALESCE(MAX(sequence), 0) + 1 \
                                  FROM notes_history_entries WHERE session_id = ?2), 'imageAtomEdit')",
                [operation_id, SESSION_ID],
            )
            .expect("insert history entry");
    }

    fn receipt(epoch: String, operation_id: &str) -> ImageAtomOperationReceiptResult {
        ImageAtomOperationReceiptResult {
            operation_id: operation_id.to_string(),
            history_epoch: epoch,
            postcondition_digest: "b".repeat(64),
            affected_root_ids: vec![NODE_ID.to_string()],
            focus: ImageAtomFocusResult {
                node_id: NODE_ID.to_string(),
                anchor_utf16: 0,
                focus_utf16: 1,
            },
        }
    }

    fn receipt_count(connection: &rusqlite::Connection) -> i64 {
        connection
            .query_row(
                "SELECT COUNT(*) FROM notes_image_atom_operations",
                [],
                |row| row.get(0),
            )
            .expect("count receipts")
    }

    fn seed_image(connection: &rusqlite::Connection) {
        connection
            .execute("DELETE FROM notes_nodes", [])
            .expect("remove onboarding fixture");
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id, sort_key, title, note, node_kind, image_offset_utf16, is_collapsed, \
                   is_starred, completed_at, created_at, updated_at\
                 ) VALUES (\
                   ?1, 1024, 'AB', 'Supporting note', 'image', 1, 1, 1, \
                   '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z', \
                   '2026-07-10T00:00:00.000Z'\
                 )",
                [NODE_ID],
            )
            .expect("seed image node");
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, note, node_kind, created_at, updated_at\
                 ) VALUES (\
                   ?1, ?2, 1024, 'Child', '', 'text', \
                   '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'\
                 )",
                params![CHILD_ID, NODE_ID],
            )
            .expect("seed image child");
        connection
            .execute(
                "INSERT INTO notes_attachments(\
                   id, node_id, sort_key, relative_path, content_hash, original_name, mime_type, \
                   byte_size, intrinsic_width, intrinsic_height, display_width, created_at, updated_at\
                 ) VALUES (\
                   ?1, ?2, 1024, 'notes-assets/atom.png', ?3, 'atom.png', 'image/png', \
                   1, 160, 160, 160, '2026-07-10T00:00:00.000Z', \
                   '2026-07-10T00:00:00.000Z'\
                 )",
                params![ATTACHMENT_ID, NODE_ID, "a".repeat(64)],
            )
            .expect("seed image attachment");
    }

    fn history_context(connection: &rusqlite::Connection, entry_id: &str) -> NotesHistoryContext {
        NotesHistoryContext {
            session_id: SESSION_ID.to_string(),
            history_epoch: history_epoch(connection).expect("history epoch"),
            entry_id: entry_id.to_string(),
            command_kind: "imageAtomEdit".to_string(),
        }
    }

    fn edit_input(selection: (i64, i64), edit: ImageAtomEdit) -> ApplyImageAtomEditInput {
        ApplyImageAtomEditInput {
            target: ImageTargetAuthority {
                node_id: NODE_ID.to_string(),
                expected_updated_at: "2026-07-10T00:00:00.000Z".to_string(),
                expected_title: "AB".to_string(),
                expected_image_offset_utf16: 1,
                expected_primary_attachment_id: ATTACHMENT_ID.to_string(),
            },
            selection: LogicalSelection {
                anchor_utf16: selection.0,
                focus_utf16: selection.1,
            },
            edit,
        }
    }

    fn node<'a>(
        workspace: &'a crate::notes::types::NotesWorkspace,
        id: &str,
    ) -> &'a crate::notes::types::NoteNode {
        workspace
            .nodes
            .iter()
            .find(|node| node.id == id)
            .expect("expected node")
    }

    #[test]
    fn remove_atom_converts_image_to_text_in_one_history_entry() {
        for (entry_id, selection, replacement, expected_title) in [
            (OPERATION_ID, (1, 1), "", "AB"),
            (SECOND_OPERATION_ID, (2, 2), "", "AB"),
            ("dddddddd-dddd-4ddd-8ddd-dddddddddddd", (1, 2), "", "AB"),
            (
                "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                (0, 3),
                "paste",
                "paste",
            ),
        ] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let mut connection =
                connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
            seed_image(&connection);
            let context = history_context(&connection, entry_id);

            let result = apply_image_atom_edit(
                &mut connection,
                edit_input(
                    selection,
                    ImageAtomEdit::Remove {
                        replacement_text: replacement.to_string(),
                    },
                ),
                context.clone(),
            )
            .expect("remove image atom");

            let source = node(&result.mutation.workspace, NODE_ID);
            assert_eq!(source.node_kind, NoteNodeKind::Text);
            assert_eq!(source.title, expected_title);
            assert_eq!(source.note, "Supporting note");
            assert_eq!(source.image_offset_utf16, 0);
            assert!(result
                .mutation
                .workspace
                .attachments_by_node_id
                .get(NODE_ID)
                .is_none_or(Vec::is_empty));
            assert_eq!(result.mutation.history_entry_id.as_deref(), Some(entry_id));
            assert_eq!(result.operation.operation_id, entry_id);
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM notes_history_entries WHERE id = ?1",
                        [entry_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .expect("history entry count"),
                1
            );

            if selection == (1, 2) {
                let undone = undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
                    .expect("undo atom removal");
                assert_eq!(
                    node(&undone.workspace, NODE_ID).node_kind,
                    NoteNodeKind::Image
                );
                assert!(undone
                    .workspace
                    .attachments_by_node_id
                    .get(NODE_ID)
                    .is_some_and(|attachments| {
                        attachments
                            .iter()
                            .any(|attachment| attachment.id == ATTACHMENT_ID)
                    }));
                let redone = redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
                    .expect("redo atom removal");
                assert_eq!(node(&redone.workspace, NODE_ID).title, "AB");
                assert!(redone
                    .workspace
                    .attachments_by_node_id
                    .get(NODE_ID)
                    .is_none_or(Vec::is_empty));
            }
        }
    }

    #[test]
    fn enter_obeys_every_image_atom_split_rule() {
        for (
            entry_id,
            selection,
            expected_source_kind,
            expected_source_title,
            expected_source_offset,
            expected_sibling_kind,
            expected_sibling_title,
            expected_sibling_offset,
        ) in [
            (
                OPERATION_ID,
                (0, 0),
                NoteNodeKind::Text,
                "",
                0,
                NoteNodeKind::Image,
                "AB",
                1,
            ),
            (
                SECOND_OPERATION_ID,
                (1, 1),
                NoteNodeKind::Text,
                "A",
                0,
                NoteNodeKind::Image,
                "B",
                0,
            ),
            (
                "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                (2, 2),
                NoteNodeKind::Image,
                "A",
                1,
                NoteNodeKind::Text,
                "B",
                0,
            ),
            (
                "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                (3, 3),
                NoteNodeKind::Image,
                "AB",
                1,
                NoteNodeKind::Text,
                "",
                0,
            ),
            (
                "ffffffff-ffff-4fff-8fff-ffffffffffff",
                (1, 2),
                NoteNodeKind::Image,
                "AB",
                1,
                NoteNodeKind::Text,
                "",
                0,
            ),
            (
                "99999999-9999-4999-8999-999999999999",
                (0, 2),
                NoteNodeKind::Text,
                "",
                0,
                NoteNodeKind::Text,
                "B",
                0,
            ),
            (
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
                (0, 1),
                NoteNodeKind::Text,
                "",
                0,
                NoteNodeKind::Image,
                "B",
                0,
            ),
            (
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbba",
                (1, 0),
                NoteNodeKind::Text,
                "",
                0,
                NoteNodeKind::Image,
                "B",
                0,
            ),
            (
                "cccccccc-cccc-4ccc-8ccc-ccccccccccca",
                (2, 3),
                NoteNodeKind::Image,
                "A",
                1,
                NoteNodeKind::Text,
                "",
                0,
            ),
            (
                "dddddddd-dddd-4ddd-8ddd-ddddddddddda",
                (3, 2),
                NoteNodeKind::Image,
                "A",
                1,
                NoteNodeKind::Text,
                "",
                0,
            ),
        ] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let mut connection =
                connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
            seed_image(&connection);
            let context = history_context(&connection, entry_id);
            let result = apply_image_atom_edit(
                &mut connection,
                edit_input(
                    selection,
                    ImageAtomEdit::Enter {
                        sibling_id: SIBLING_ID.to_string(),
                    },
                ),
                context,
            )
            .expect("split image atom");

            let source = node(&result.mutation.workspace, NODE_ID);
            let sibling = node(&result.mutation.workspace, SIBLING_ID);
            assert_eq!(source.node_kind, expected_source_kind);
            assert_eq!(source.title, expected_source_title);
            assert_eq!(source.image_offset_utf16, expected_source_offset);
            assert_eq!(source.note, "Supporting note");
            assert!(source.is_collapsed);
            assert!(source.is_starred);
            if selection == (1, 2) || selection == (3, 3) {
                assert_eq!(source.updated_at, "2026-07-10T00:00:00.000Z");
            }
            assert_eq!(sibling.node_kind, expected_sibling_kind);
            assert_eq!(sibling.title, expected_sibling_title);
            assert_eq!(sibling.note, "");
            assert!(!sibling.is_collapsed);
            assert!(!sibling.is_starred);
            assert_eq!(sibling.completed_at, None);
            assert_eq!(sibling.image_offset_utf16, expected_sibling_offset);
            assert_eq!(
                node(&result.mutation.workspace, CHILD_ID)
                    .parent_id
                    .as_deref(),
                Some(NODE_ID)
            );
            assert_eq!(result.mutation.history_entry_id.as_deref(), Some(entry_id));
            if selection == (1, 2) {
                assert!(result
                    .mutation
                    .workspace
                    .attachments_by_node_id
                    .get(NODE_ID)
                    .is_some_and(|attachments| {
                        attachments
                            .iter()
                            .any(|attachment| attachment.id == ATTACHMENT_ID)
                    }));
                assert!(result
                    .mutation
                    .workspace
                    .attachments_by_node_id
                    .get(SIBLING_ID)
                    .is_none_or(Vec::is_empty));
            }
        }
    }

    #[test]
    fn enter_before_atom_moves_attachment_and_replays_as_one_history_entry() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        seed_image(&connection);
        let context = history_context(&connection, OPERATION_ID);
        let split = apply_image_atom_edit(
            &mut connection,
            edit_input(
                (1, 1),
                ImageAtomEdit::Enter {
                    sibling_id: SIBLING_ID.to_string(),
                },
            ),
            context,
        )
        .expect("split before image atom");

        let source = node(&split.mutation.workspace, NODE_ID);
        let sibling = node(&split.mutation.workspace, SIBLING_ID);
        let source_index = split
            .mutation
            .workspace
            .nodes
            .iter()
            .position(|node| node.id == NODE_ID)
            .expect("source order");
        let sibling_index = split
            .mutation
            .workspace
            .nodes
            .iter()
            .position(|node| node.id == SIBLING_ID)
            .expect("sibling order");
        assert_eq!(source.node_kind, NoteNodeKind::Text);
        assert_eq!(source.title, "A");
        assert_eq!(source.note, "Supporting note");
        assert!(source.is_collapsed);
        assert!(source.is_starred);
        assert_eq!(
            source.completed_at.as_deref(),
            Some("2026-07-10T00:00:00.000Z")
        );
        assert_eq!(
            node(&split.mutation.workspace, CHILD_ID)
                .parent_id
                .as_deref(),
            Some(NODE_ID)
        );
        assert!(source_index < sibling_index);
        assert!(source.sort_key < sibling.sort_key);
        assert_eq!(sibling.node_kind, NoteNodeKind::Image);
        assert_eq!(sibling.title, "B");
        assert_eq!(sibling.note, "");
        assert!(!sibling.is_collapsed);
        assert!(!sibling.is_starred);
        assert_eq!(sibling.completed_at, None);
        assert_eq!(sibling.image_offset_utf16, 0);
        assert!(split
            .mutation
            .workspace
            .attachments_by_node_id
            .get(NODE_ID)
            .is_none_or(Vec::is_empty));
        assert!(split
            .mutation
            .workspace
            .attachments_by_node_id
            .get(SIBLING_ID)
            .is_some_and(|attachments| {
                attachments
                    .iter()
                    .any(|attachment| attachment.id == ATTACHMENT_ID)
            }));

        let undone = undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect("undo before image split");
        let restored = node(&undone.workspace, NODE_ID);
        assert_eq!(restored.node_kind, NoteNodeKind::Image);
        assert_eq!(restored.title, "AB");
        assert_eq!(restored.image_offset_utf16, 1);
        assert!(undone
            .workspace
            .nodes
            .iter()
            .all(|node| node.id != SIBLING_ID));
        assert!(undone
            .workspace
            .attachments_by_node_id
            .get(NODE_ID)
            .is_some_and(|attachments| {
                attachments
                    .iter()
                    .any(|attachment| attachment.id == ATTACHMENT_ID)
            }));

        let redone = redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect("redo before image split");
        assert_eq!(
            node(&redone.workspace, NODE_ID).node_kind,
            NoteNodeKind::Text
        );
        assert_eq!(node(&redone.workspace, NODE_ID).title, "A");
        assert_eq!(
            node(&redone.workspace, SIBLING_ID).node_kind,
            NoteNodeKind::Image
        );
        assert_eq!(node(&redone.workspace, SIBLING_ID).title, "B");
        assert!(redone
            .workspace
            .attachments_by_node_id
            .get(SIBLING_ID)
            .is_some_and(|attachments| {
                attachments
                    .iter()
                    .any(|attachment| attachment.id == ATTACHMENT_ID)
            }));
    }

    #[test]
    fn enter_deletes_surrogate_safe_text_only_selections_before_or_after_the_atom() {
        for (entry_id, selection, expected_source_title, expected_sibling_title) in [
            (OPERATION_ID, (1, 3), "A", "B"),
            (SECOND_OPERATION_ID, (5, 4), "A😀", ""),
        ] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let mut connection =
                connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
            seed_image(&connection);
            connection
                .execute(
                    "UPDATE notes_nodes SET title = 'A😀B', image_offset_utf16 = 3 WHERE id = ?1",
                    [NODE_ID],
                )
                .expect("seed surrogate image title");
            let mut input = edit_input(
                selection,
                ImageAtomEdit::Enter {
                    sibling_id: SIBLING_ID.to_string(),
                },
            );
            input.target.expected_title = "A😀B".to_string();
            input.target.expected_image_offset_utf16 = 3;
            let context = history_context(&connection, entry_id);
            let result = apply_image_atom_edit(&mut connection, input, context)
                .expect("split after deleting selected text");

            let source = node(&result.mutation.workspace, NODE_ID);
            let sibling = node(&result.mutation.workspace, SIBLING_ID);
            assert_eq!(source.title, expected_source_title);
            assert_eq!(sibling.title, expected_sibling_title);
            if selection.0 < 3 {
                assert_eq!(source.node_kind, NoteNodeKind::Text);
                assert_eq!(sibling.node_kind, NoteNodeKind::Image);
                assert_eq!(sibling.image_offset_utf16, 0);
            } else {
                assert_eq!(source.node_kind, NoteNodeKind::Image);
                assert_eq!(source.image_offset_utf16, 3);
                assert_eq!(sibling.node_kind, NoteNodeKind::Text);
            }
        }
    }

    #[test]
    fn edit_retries_precede_stale_revalidation_and_conflicts_leave_rows_unchanged() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        seed_image(&connection);
        let context = history_context(&connection, OPERATION_ID);
        let input = edit_input(
            (1, 2),
            ImageAtomEdit::Remove {
                replacement_text: "replacement".to_string(),
            },
        );
        let committed = apply_image_atom_edit(&mut connection, input.clone(), context.clone())
            .expect("commit image edit");
        let retried = apply_image_atom_edit(&mut connection, input.clone(), context.clone())
            .expect("retry committed image edit");
        assert_eq!(retried.operation, committed.operation);
        assert_eq!(
            node(&retried.mutation.workspace, NODE_ID).title,
            "AreplacementB"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM notes_history_entries", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("history entry count"),
            1
        );

        let conflicting = ApplyImageAtomEditInput {
            edit: ImageAtomEdit::Remove {
                replacement_text: "conflict".to_string(),
            },
            ..input.clone()
        };
        assert!(apply_image_atom_edit(&mut connection, conflicting, context)
            .expect_err("conflicting retry")
            .contains("fingerprint"));
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM notes_history_entries", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("history entry count"),
            1
        );

        let authority_dir = tempfile::tempdir().expect("authority temp dir");
        let mut authority_connection =
            connect_notes_db(authority_dir.path().to_str().expect("path")).expect("connect");
        seed_image(&authority_connection);
        let stale_context = history_context(
            &authority_connection,
            "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        );
        let stale = ApplyImageAtomEditInput {
            target: ImageTargetAuthority {
                expected_title: "stale".to_string(),
                ..input.target.clone()
            },
            ..input.clone()
        };
        assert!(
            apply_image_atom_edit(&mut authority_connection, stale, stale_context)
                .expect_err("stale target")
                .contains("stale")
        );

        let wrong_attachment = ApplyImageAtomEditInput {
            target: ImageTargetAuthority {
                expected_primary_attachment_id: SIBLING_ID.to_string(),
                ..input.target.clone()
            },
            ..input.clone()
        };
        let wrong_attachment_context = history_context(
            &authority_connection,
            "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        );
        assert!(apply_image_atom_edit(
            &mut authority_connection,
            wrong_attachment,
            wrong_attachment_context,
        )
        .expect_err("mismatched attachment")
        .contains("attachment"));

        authority_connection
            .execute(
                "UPDATE notes_nodes SET title = ?1, image_offset_utf16 = 3, \
                    updated_at = '2026-07-10T00:00:00.000Z' WHERE id = ?2",
                params!["A😀B", NODE_ID],
            )
            .expect("seed surrogate title");
        let invalid_boundary = ApplyImageAtomEditInput {
            target: ImageTargetAuthority {
                node_id: NODE_ID.to_string(),
                expected_updated_at: "2026-07-10T00:00:00.000Z".to_string(),
                expected_title: "A😀B".to_string(),
                expected_image_offset_utf16: 3,
                expected_primary_attachment_id: ATTACHMENT_ID.to_string(),
            },
            selection: LogicalSelection {
                anchor_utf16: 2,
                focus_utf16: 2,
            },
            edit: ImageAtomEdit::Remove {
                replacement_text: String::new(),
            },
        };
        let invalid_boundary_context = history_context(
            &authority_connection,
            "ffffffff-ffff-4fff-8fff-ffffffffffff",
        );
        assert!(apply_image_atom_edit(
            &mut authority_connection,
            invalid_boundary,
            invalid_boundary_context,
        )
        .expect_err("surrogate-splitting selection")
        .contains("boundary"));
    }

    #[test]
    fn receipt_table_is_connection_local_temp_state() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        let temp_exists: bool = connection
            .query_row(
                "SELECT EXISTS(\
                   SELECT 1 FROM sqlite_temp_master \
                   WHERE type = 'table' AND name = 'notes_image_atom_operations'\
                 )",
                [],
                |row| row.get(0),
            )
            .expect("inspect TEMP receipt table");

        let main_exists: bool = connection
            .query_row(
                "SELECT EXISTS(\
                   SELECT 1 FROM sqlite_master \
                   WHERE type = 'table' AND name = 'notes_image_atom_operations'\
                 )",
                [],
                |row| row.get(0),
            )
            .expect("inspect main schema");

        assert!(temp_exists);
        assert!(!main_exists, "receipt state must never enter main schema");
    }

    #[test]
    fn receipt_foreign_key_cascades_with_its_history_entry() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        let epoch = history_epoch(&connection).expect("epoch");
        insert_history_entry(&connection, OPERATION_ID);
        record_operation_receipt(
            &connection,
            SESSION_ID,
            "a".repeat(64),
            &receipt(epoch, OPERATION_ID),
        )
        .expect("record receipt");

        connection
            .execute(
                "DELETE FROM notes_history_entries WHERE id = ?1",
                [OPERATION_ID],
            )
            .expect("delete history entry");
        assert_eq!(receipt_count(&connection), 0);
    }

    #[test]
    fn record_rejects_stale_or_path_like_epoch_without_a_receipt() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        insert_history_entry(&connection, OPERATION_ID);
        insert_history_entry(&connection, SECOND_OPERATION_ID);

        for (operation_id, epoch) in [
            (OPERATION_ID, "stale-epoch".to_string()),
            (SECOND_OPERATION_ID, "/vault/path-like-epoch".to_string()),
        ] {
            assert!(record_operation_receipt(
                &connection,
                SESSION_ID,
                "a".repeat(64),
                &receipt(epoch, operation_id),
            )
            .expect_err("stale receipt authority")
            .contains("stale"));
        }
        assert_eq!(receipt_count(&connection), 0);
    }

    #[test]
    fn record_rejects_focus_offsets_beyond_javascript_safe_integers() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        let epoch = history_epoch(&connection).expect("epoch");
        insert_history_entry(&connection, OPERATION_ID);
        insert_history_entry(&connection, SECOND_OPERATION_ID);
        let mut invalid = receipt(epoch, OPERATION_ID);
        invalid.focus.focus_utf16 = 9_007_199_254_740_992;

        assert!(
            record_operation_receipt(&connection, SESSION_ID, "a".repeat(64), &invalid)
                .expect_err("unsafe focus offset")
                .contains("safe")
        );
        assert_eq!(receipt_count(&connection), 0);

        let mut maximum_safe = receipt(
            history_epoch(&connection).expect("current epoch"),
            SECOND_OPERATION_ID,
        );
        maximum_safe.focus.anchor_utf16 = 9_007_199_254_740_991;
        record_operation_receipt(&connection, SESSION_ID, "b".repeat(64), &maximum_safe)
            .expect("maximum JavaScript-safe focus offset");
    }

    #[test]
    fn identical_receipt_lookup_is_epoch_bound_and_acknowledgement_is_idempotent() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        let epoch = history_epoch(&connection).expect("epoch");
        insert_history_entry(&connection, OPERATION_ID);
        let expected = receipt(epoch.clone(), OPERATION_ID);
        record_operation_receipt(&connection, SESSION_ID, "a".repeat(64), &expected)
            .expect("record receipt");

        assert_eq!(
            lookup_operation_receipt(&connection, SESSION_ID, &epoch, OPERATION_ID)
                .expect("lookup receipt"),
            ImageAtomOperationLookup::Found {
                receipt: expected.clone()
            }
        );
        ack_operation_receipt(&connection, SESSION_ID, &epoch, OPERATION_ID)
            .expect("acknowledge receipt");
        ack_operation_receipt(&connection, SESSION_ID, &epoch, OPERATION_ID)
            .expect("repeat acknowledgement");
        assert!(matches!(
            lookup_operation_receipt(&connection, SESSION_ID, "stale", OPERATION_ID)
                .expect("epoch mismatch lookup"),
            ImageAtomOperationLookup::EpochMismatch { .. }
        ));
    }

    #[test]
    fn lookup_returns_missing_and_foreign_acknowledgement_preserves_the_receipt() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        let epoch = history_epoch(&connection).expect("epoch");
        assert_eq!(
            lookup_operation_receipt(&connection, SESSION_ID, &epoch, OPERATION_ID)
                .expect("missing lookup"),
            ImageAtomOperationLookup::Missing {
                history_epoch: epoch.clone(),
            }
        );
        insert_history_entry(&connection, OPERATION_ID);
        record_operation_receipt(
            &connection,
            SESSION_ID,
            "a".repeat(64),
            &receipt(epoch.clone(), OPERATION_ID),
        )
        .expect("record receipt");

        assert!(
            ack_operation_receipt(&connection, FOREIGN_SESSION_ID, &epoch, OPERATION_ID)
                .expect_err("foreign acknowledgement")
                .contains("another session")
        );
        let acknowledged: bool = connection
            .query_row(
                "SELECT acknowledged FROM notes_image_atom_operations WHERE operation_id = ?1",
                [OPERATION_ID],
                |row| row.get(0),
            )
            .expect("inspect acknowledgement");
        assert!(!acknowledged);
    }

    #[test]
    fn lookup_rejects_noncompact_receipt_payload_fields() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        let epoch = history_epoch(&connection).expect("epoch");
        insert_history_entry(&connection, OPERATION_ID);

        for (field, value) in [
            ("workspace", serde_json::json!({"nodes": []})),
            ("vaultPath", serde_json::json!("/vault")),
            ("bytes", serde_json::json!([1, 2, 3])),
            ("base64", serde_json::json!("AA==")),
        ] {
            let mut result = serde_json::to_value(receipt(epoch.clone(), OPERATION_ID))
                .expect("encode compact receipt");
            result
                .as_object_mut()
                .expect("receipt object")
                .insert(field.to_string(), value);
            connection
                .execute(
                    "INSERT INTO notes_image_atom_operations(\
                       operation_id, session_id, history_epoch, fingerprint, postcondition_digest, result_json\
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        OPERATION_ID,
                        SESSION_ID,
                        &epoch,
                        "a".repeat(64),
                        "b".repeat(64),
                        result.to_string(),
                    ],
                )
                .expect("insert noncompact receipt");
            assert!(
                lookup_operation_receipt(&connection, SESSION_ID, &epoch, OPERATION_ID)
                    .expect_err("noncompact receipt payload")
                    .contains("decode")
            );
            connection
                .execute(
                    "DELETE FROM notes_image_atom_operations WHERE operation_id = ?1",
                    [OPERATION_ID],
                )
                .expect("remove noncompact receipt");
        }
    }

    #[test]
    fn operation_id_reuse_rejects_conflicting_fingerprints_and_parallel_unacknowledged_receipts() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        let epoch = history_epoch(&connection).expect("epoch");
        insert_history_entry(&connection, OPERATION_ID);
        insert_history_entry(&connection, SECOND_OPERATION_ID);
        let first = receipt(epoch.clone(), OPERATION_ID);
        record_operation_receipt(&connection, SESSION_ID, "a".repeat(64), &first)
            .expect("record first receipt");

        assert!(
            record_operation_receipt(&connection, SESSION_ID, "c".repeat(64), &first)
                .expect_err("conflicting fingerprint")
                .contains("fingerprint")
        );
        assert!(record_operation_receipt(
            &connection,
            SESSION_ID,
            "d".repeat(64),
            &receipt(epoch, SECOND_OPERATION_ID),
        )
        .expect_err("second unresolved receipt")
        .contains("unacknowledged"));
    }
}
