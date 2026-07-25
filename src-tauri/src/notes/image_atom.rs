use crate::notes::attachments::PreparedAttachmentBatch;
use crate::notes::date_index::{LocalTodayProvider, SystemLocalTodayProvider};
use crate::notes::types::{
    validate_note_id, ApplyImageAtomEditInput, ApplyImageAtomPasteInput, ImageAtomEdit,
    ImageAtomFocusResult, ImageAtomMutationResult, ImageAtomOperationLookup,
    ImageAtomOperationReceiptResult, ImageAtomPasteFragmentItem, ImageTargetAuthority,
    LogicalSelection, NoteAttachment, NoteNodeKind, NotesHistoryContext, NotesMutationResult,
    NotesWorkspace, NotesWorkspaceScope,
};
use crate::notes::{history, repository};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const MAX_HISTORY_EPOCH_BYTES: usize = 128;
const MAX_RECEIPT_RESULT_BYTES: usize = 32 * 1024;
const MAX_RECEIPT_AFFECTED_ROOT_IDS: usize = 128;
const MAX_SAFE_UTF16_OFFSET: i64 = 9_007_199_254_740_991;
const IMAGE_ATOM_POSTCONDITION_DIGEST_DOMAIN: &str = "notes-image-atom-postcondition-v1";
const IMAGE_ATOM_PASTE_POSTCONDITION_DIGEST_DOMAIN: &str =
    "notes-image-atom-paste-postcondition-v1";

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

pub(crate) struct PreparedImageAtomPaste {
    pub(crate) attachments: Vec<repository::NewAttachment>,
    fingerprint: String,
}

pub(crate) struct ImageAtomPasteRetryCandidate {
    pub(crate) result: ImageAtomMutationResult,
    pub(crate) attachments: Vec<NoteAttachment>,
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
    let atom_selected = start <= image_offset && end > image_offset;
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
            } else if !collapsed && start > image_offset {
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
            } else if collapsed && start > image_offset {
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

fn normalized_paste_selection(input: &ApplyImageAtomPasteInput) -> Result<(i64, i64), String> {
    crate::notes::schema::validate_image_offset_utf16(
        &input.target.expected_title,
        input.target.expected_node_kind,
        input.target.expected_image_offset_utf16,
    )?;
    let raw_length = utf16_len(&input.target.expected_title)?;
    let logical_length = if input.target.expected_node_kind == NoteNodeKind::Image {
        raw_length
            .checked_add(1)
            .ok_or_else(|| "The Notes image atom paste title is too long.".to_string())?
    } else {
        raw_length
    };
    let anchor = input.selection.anchor_utf16.clamp(0, logical_length);
    let focus = input.selection.focus_utf16.clamp(0, logical_length);
    let (start, end) = if anchor <= focus {
        (anchor, focus)
    } else {
        (focus, anchor)
    };
    let raw_offset = |logical: i64| -> Result<usize, String> {
        let offset = if input.target.expected_node_kind == NoteNodeKind::Image
            && logical > input.target.expected_image_offset_utf16
        {
            logical
                .checked_sub(1)
                .ok_or_else(|| "The Notes image atom paste selection is invalid.".to_string())?
        } else {
            logical
        };
        crate::notes::schema::validate_image_offset_utf16(
            &input.target.expected_title,
            if input.target.expected_node_kind == NoteNodeKind::Text {
                NoteNodeKind::Image
            } else {
                input.target.expected_node_kind
            },
            offset,
        )
    };
    raw_offset(start)?;
    raw_offset(end)?;
    Ok((start, end))
}

pub(crate) fn prepare_image_atom_paste(
    input: &ApplyImageAtomPasteInput,
    history_context: &NotesHistoryContext,
    prepared_batch: &PreparedAttachmentBatch,
) -> Result<PreparedImageAtomPaste, String> {
    history::validate_context(history_context)?;
    if history_context.command_kind.trim() != "imageAtomPaste" {
        return Err(
            "Notes image atom pastes require the imageAtomPaste history command kind.".to_string(),
        );
    }
    if input.version != 1 || input.initial_max_display_width <= 0 {
        return Err("The Notes image atom paste input is invalid.".to_string());
    }
    let normalized_selection = normalized_paste_selection(input)?;
    let image_fragment_items = input
        .fragment
        .iter()
        .filter_map(|item| match item {
            ImageAtomPasteFragmentItem::Image {
                node_id,
                attachment_id,
                ordinal,
                original_name,
                mime_type,
                byte_length,
            } => Some((
                node_id,
                attachment_id,
                *ordinal,
                original_name,
                mime_type,
                *byte_length,
            )),
            ImageAtomPasteFragmentItem::Text { .. } => None,
        })
        .collect::<Vec<_>>();
    if image_fragment_items.is_empty()
        || image_fragment_items.len() != prepared_batch.attachments().len()
    {
        return Err(
            "Notes image atom paste metadata does not match its validated images.".to_string(),
        );
    }
    let mut attachment_ids = HashSet::new();
    let mut node_ids = HashSet::new();
    let mut all_ids = HashSet::new();
    let mut descriptors = Vec::with_capacity(image_fragment_items.len());
    let mut attachments = Vec::with_capacity(image_fragment_items.len());
    for (
        index,
        ((node_id, attachment_id, ordinal, original_name, mime_type, byte_length), prepared),
    ) in image_fragment_items
        .into_iter()
        .zip(prepared_batch.attachments())
        .enumerate()
    {
        if usize::try_from(ordinal).ok() != Some(index)
            || !node_ids.insert(node_id.as_str())
            || !attachment_ids.insert(attachment_id.as_str())
            || !all_ids.insert(node_id.as_str())
            || !all_ids.insert(attachment_id.as_str())
            || node_id == attachment_id
            || original_name != &prepared.original_name
            || mime_type != prepared.image.mime_type
            || byte_length != prepared.image.byte_size
        {
            return Err("Notes image atom paste image metadata is invalid.".to_string());
        }
        let byte_size = i64::try_from(prepared.image.byte_size)
            .map_err(|_| "The Notes image atom paste byte size is too large.".to_string())?;
        let display_width = input
            .initial_max_display_width
            .min(i64::from(prepared.image.width));
        descriptors.push((
            node_id,
            attachment_id,
            original_name,
            prepared.image.mime_type,
            prepared.image.byte_size,
            &prepared.image.content_hash,
        ));
        attachments.push(repository::NewAttachment {
            id: attachment_id.clone(),
            node_id: node_id.clone(),
            relative_path: format!(
                "notes-assets/{}.{}",
                prepared.image.content_hash, prepared.image.extension
            ),
            content_hash: prepared.image.content_hash.clone(),
            original_name: prepared.original_name.clone(),
            mime_type: prepared.image.mime_type.to_string(),
            byte_size,
            intrinsic_width: i64::from(prepared.image.width),
            intrinsic_height: i64::from(prepared.image.height),
            display_width,
        });
    }
    let fingerprint = serde_json::to_vec(&(
        "notes_apply_image_atom_paste",
        &history_context.session_id,
        &history_context.history_epoch,
        &history_context.entry_id,
        history_context.command_kind.trim(),
        &input.target,
        normalized_selection,
        &input.fragment,
        input.initial_max_display_width,
        descriptors,
    ))
    .map(sha256_hex)
    .map_err(|error| format!("Could not fingerprint the Notes image atom paste: {error}"))?;
    Ok(PreparedImageAtomPaste {
        attachments,
        fingerprint,
    })
}

fn mutation_from_receipt(
    connection: &Connection,
    history_context: &NotesHistoryContext,
    workspace: NotesWorkspace,
    operation: ImageAtomOperationReceiptResult,
) -> Result<ImageAtomMutationResult, String> {
    Ok(ImageAtomMutationResult {
        mutation: NotesMutationResult {
            workspace,
            serialize_workspace: true,
            history_entry_id: Some(history_context.entry_id.clone()),
            state: history::history_state(connection, &history_context.session_id, Vec::new())?,
            changed_nodes: None,
            removed_node_ids: None,
            changed_attachments: None,
            imported_root_ids: None,
            duplicated_root_ids: None,
        },
        operation,
    })
}

fn inconsistent_image_atom_paste_retry() -> String {
    "The requested Notes image atom paste conflicts with inconsistent committed state.".to_string()
}

fn validate_image_atom_paste_retry_history(
    connection: &Connection,
    history_context: &NotesHistoryContext,
) -> Result<(), String> {
    let entry = connection
        .query_row(
            "SELECT session_id, command_kind, is_undone FROM notes_history_entries WHERE id = ?1",
            [&history_context.entry_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not inspect retry Notes image paste history: {error}"))?;
    if entry.as_ref()
        != Some(&(
            history_context.session_id.clone(),
            history_context.command_kind.trim().to_string(),
            false,
        ))
    {
        return Err(inconsistent_image_atom_paste_retry());
    }
    Ok(())
}

fn validate_image_atom_paste_retry_attachments(
    workspace: &NotesWorkspace,
    prepared: &PreparedImageAtomPaste,
) -> Result<Vec<NoteAttachment>, String> {
    prepared
        .attachments
        .iter()
        .map(|expected| {
            let node = workspace
                .nodes
                .iter()
                .find(|node| node.id == expected.node_id)
                .ok_or_else(inconsistent_image_atom_paste_retry)?;
            let owned = workspace
                .attachments_by_node_id
                .get(&expected.node_id)
                .map(Vec::as_slice)
                .unwrap_or_default();
            let actual = owned
                .iter()
                .find(|attachment| attachment.id == expected.id)
                .ok_or_else(inconsistent_image_atom_paste_retry)?;
            if node.node_kind != NoteNodeKind::Image
                || owned.len() != 1
                || actual.sort_key != repository::SORT_KEY_STEP
                || !repository::attachment_matches_new_attachment(actual, expected)
            {
                return Err(inconsistent_image_atom_paste_retry());
            }
            Ok(actual.clone())
        })
        .collect()
}

pub(crate) fn retry_image_atom_paste(
    connection: &Connection,
    history_context: &NotesHistoryContext,
    prepared: &PreparedImageAtomPaste,
) -> Result<Option<ImageAtomPasteRetryCandidate>, String> {
    matching_operation_receipt(
        connection,
        &history_context.session_id,
        &history_context.history_epoch,
        &history_context.entry_id,
        &prepared.fingerprint,
    )?
    .map(|receipt| {
        validate_image_atom_paste_retry_history(connection, history_context)?;
        let workspace = repository::load_workspace(connection, NotesWorkspaceScope::Active)?;
        if paste_postcondition_digest(&workspace, &receipt.affected_root_ids)?
            != receipt.postcondition_digest
        {
            return Err(
                "The Notes image atom paste retry postcondition does not match current state."
                    .to_string(),
            );
        }
        let attachments = validate_image_atom_paste_retry_attachments(&workspace, prepared)?;
        Ok(ImageAtomPasteRetryCandidate {
            result: mutation_from_receipt(connection, history_context, workspace, receipt)?,
            attachments,
        })
    })
    .transpose()
}

#[derive(Serialize)]
struct ImageAtomPostconditionAttachment<'a> {
    id: &'a str,
    node_id: &'a str,
    sort_key: i64,
    relative_path: &'a str,
    content_hash: &'a str,
    original_name: &'a str,
    mime_type: &'a str,
    byte_size: i64,
    intrinsic_width: i64,
    intrinsic_height: i64,
    display_width: i64,
}

#[derive(Serialize)]
struct ImageAtomPostconditionNode<'a> {
    id: &'a str,
    parent_id: Option<&'a str>,
    sort_key: i64,
    node_kind: &'static str,
    title: &'a str,
    note: &'a str,
    image_offset_utf16: i64,
    layout_mode: crate::notes::types::NoteLayoutMode,
    is_collapsed: bool,
    is_starred: bool,
    completed_at: Option<&'a str>,
    attachments: Vec<ImageAtomPostconditionAttachment<'a>>,
}

/// Builds the Task 10 parity projection from authoritative active rows only.
/// The payload begins with a stable domain/version string and then a flat
/// preorder of the source/sibling subtrees. Roots and descendants are ordered
/// by their displayed sibling `(sort_key, id)` order; attachments use the same
/// ordering. Each node keeps its `parent_id`, so Task 10 can reproduce the
/// exact tree without recursive serialization. The projection includes semantic
/// node state, ownership, and attachment metadata (including the relative asset
/// path), while intentionally excluding timestamps, Vault roots, and image
/// bytes. Focus remains receipt metadata and is never part of this digest.
fn postcondition_node<'a>(
    workspace: &'a NotesWorkspace,
    node: &'a crate::notes::types::NoteNode,
) -> ImageAtomPostconditionNode<'a> {
    let mut attachments = workspace
        .attachments_by_node_id
        .get(&node.id)
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    attachments.sort_by(|left, right| {
        (left.sort_key, left.id.as_str()).cmp(&(right.sort_key, right.id.as_str()))
    });
    let attachments = attachments
        .into_iter()
        .map(|attachment| ImageAtomPostconditionAttachment {
            id: &attachment.id,
            node_id: &attachment.node_id,
            sort_key: attachment.sort_key,
            relative_path: &attachment.relative_path,
            content_hash: &attachment.content_hash,
            original_name: &attachment.original_name,
            mime_type: &attachment.mime_type,
            byte_size: attachment.byte_size,
            intrinsic_width: attachment.intrinsic_width,
            intrinsic_height: attachment.intrinsic_height,
            display_width: attachment.display_width,
        })
        .collect();
    ImageAtomPostconditionNode {
        id: &node.id,
        parent_id: node.parent_id.as_deref(),
        sort_key: node.sort_key,
        node_kind: node.node_kind.as_str(),
        title: &node.title,
        note: &node.note,
        image_offset_utf16: node.image_offset_utf16,
        layout_mode: node.layout_mode,
        is_collapsed: node.is_collapsed,
        is_starred: node.is_starred,
        completed_at: node.completed_at.as_deref(),
        attachments,
    }
}

fn postcondition_digest(
    workspace: &NotesWorkspace,
    source_node_id: &str,
    plan: &ImageAtomEditPlan,
) -> Result<String, String> {
    let mut nodes_by_id = HashMap::new();
    let mut node_indexes = HashMap::new();
    let mut children_by_parent = HashMap::<&str, Vec<&crate::notes::types::NoteNode>>::new();
    for (index, node) in workspace.nodes.iter().enumerate() {
        if nodes_by_id.insert(node.id.as_str(), node).is_some() {
            return Err("The Notes image atom postcondition has duplicate node IDs.".to_string());
        }
        node_indexes.insert(node.id.as_str(), index);
        if let Some(parent_id) = node.parent_id.as_deref() {
            children_by_parent.entry(parent_id).or_default().push(node);
        }
    }
    for children in children_by_parent.values_mut() {
        children.sort_by(|left, right| {
            (left.sort_key, left.id.as_str()).cmp(&(right.sort_key, right.id.as_str()))
        });
    }
    let mut root_ids = vec![source_node_id];
    if let Some(sibling) = &plan.sibling {
        root_ids.push(&sibling.id);
    }
    let mut indexed_roots = root_ids
        .into_iter()
        .map(|id| {
            node_indexes
                .get(id)
                .copied()
                .map(|index| (index, id))
                .ok_or_else(|| {
                    "Could not locate a Notes image atom postcondition root.".to_string()
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    indexed_roots.sort_by_key(|(index, _)| *index);
    let mut pending = indexed_roots
        .into_iter()
        .rev()
        .map(|(_, id)| id)
        .collect::<Vec<_>>();
    let mut seen = HashSet::new();
    let mut projection = Vec::new();
    while let Some(node_id) = pending.pop() {
        let node = nodes_by_id
            .get(node_id)
            .copied()
            .ok_or_else(|| "Could not locate a Notes image atom postcondition node.".to_string())?;
        if !seen.insert(node.id.as_str()) {
            return Err("The Notes image atom postcondition contains a cycle.".to_string());
        }
        projection.push(postcondition_node(workspace, node));
        if let Some(children) = children_by_parent.get(node.id.as_str()) {
            pending.extend(children.iter().rev().map(|child| child.id.as_str()));
        }
    }
    serde_json::to_vec(&(IMAGE_ATOM_POSTCONDITION_DIGEST_DOMAIN, projection))
        .map(sha256_hex)
        .map_err(|error| format!("Could not digest the Notes image atom postcondition: {error}"))
}

fn operation_receipt(
    history_context: &NotesHistoryContext,
    source_node_id: &str,
    plan: &ImageAtomEditPlan,
    workspace: &NotesWorkspace,
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
        postcondition_digest: postcondition_digest(workspace, source_node_id, plan)?,
        affected_root_ids,
        focus: plan.focus.clone(),
    })
}

fn paste_postcondition_digest(
    workspace: &NotesWorkspace,
    affected_root_ids: &[String],
) -> Result<String, String> {
    let mut nodes_by_id = HashMap::new();
    let mut children_by_parent = HashMap::<&str, Vec<&crate::notes::types::NoteNode>>::new();
    for node in &workspace.nodes {
        if nodes_by_id.insert(node.id.as_str(), node).is_some() {
            return Err(
                "The Notes image atom paste postcondition has duplicate node IDs.".to_string(),
            );
        }
        if let Some(parent_id) = node.parent_id.as_deref() {
            children_by_parent.entry(parent_id).or_default().push(node);
        }
    }
    for children in children_by_parent.values_mut() {
        children.sort_by(|left, right| {
            (left.sort_key, left.id.as_str()).cmp(&(right.sort_key, right.id.as_str()))
        });
    }
    let mut pending = affected_root_ids
        .iter()
        .rev()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let mut seen = HashSet::new();
    let mut projection = Vec::new();
    while let Some(node_id) = pending.pop() {
        let node = nodes_by_id.get(node_id).copied().ok_or_else(|| {
            "Could not locate a Notes image atom paste postcondition root.".to_string()
        })?;
        if !seen.insert(node.id.as_str()) {
            return Err("The Notes image atom paste postcondition contains a cycle.".to_string());
        }
        projection.push(postcondition_node(workspace, node));
        if let Some(children) = children_by_parent.get(node.id.as_str()) {
            pending.extend(children.iter().rev().map(|child| child.id.as_str()));
        }
    }
    serde_json::to_vec(&(IMAGE_ATOM_PASTE_POSTCONDITION_DIGEST_DOMAIN, projection))
        .map(sha256_hex)
        .map_err(|error| {
            format!("Could not digest the Notes image atom paste postcondition: {error}")
        })
}

fn paste_operation_receipt(
    history_context: &NotesHistoryContext,
    workspace: &NotesWorkspace,
    application: &repository::ImageAtomPasteApplication,
) -> Result<ImageAtomOperationReceiptResult, String> {
    Ok(ImageAtomOperationReceiptResult {
        operation_id: history_context.entry_id.clone(),
        history_epoch: history_context.history_epoch.clone(),
        postcondition_digest: paste_postcondition_digest(
            workspace,
            &application.affected_root_ids,
        )?,
        affected_root_ids: application.affected_root_ids.clone(),
        focus: application.focus.clone(),
    })
}

pub(crate) fn apply_image_atom_paste_with_prunes(
    connection: &mut Connection,
    input: ApplyImageAtomPasteInput,
    history_context: NotesHistoryContext,
    prepared: PreparedImageAtomPaste,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<ImageAtomEditApplyResult, String> {
    // The command settles a committed retry (including backing-asset reads)
    // before publishing candidate bytes. This path is fresh-only; its
    // IMMEDIATE transaction rejects an existing history entry again.
    let today = SystemLocalTodayProvider.local_today(connection)?;
    let mut application = None;
    let result = history::with_history_transaction_and_prunes(
        connection,
        Some(&history_context),
        |connection| {
            let applied = repository::apply_image_atom_paste_plan(
                connection,
                &history_context.entry_id,
                &input,
                prepared.attachments,
                today,
                |transaction, workspace, application| {
                    let receipt =
                        paste_operation_receipt(&history_context, workspace, application)?;
                    record_operation_receipt(
                        transaction,
                        &history_context.session_id,
                        prepared.fingerprint,
                        &receipt,
                    )
                    .map(|_| ())
                },
                before_commit,
            )?;
            let workspace = applied.workspace.clone();
            application = Some(applied);
            Ok(workspace)
        },
    )?;
    let pruned_attachment_paths = result.pruned_attachment_paths.clone();
    let mutation = result.into_mutation_result_with_workspace();
    if mutation.history_entry_id.as_deref() != Some(history_context.entry_id.as_str()) {
        return Err(
            "The Notes image atom paste did not create its required history entry.".to_string(),
        );
    }
    let application = application.ok_or_else(|| {
        "The Notes image atom paste did not produce an application result.".to_string()
    })?;
    let operation = paste_operation_receipt(&history_context, &mutation.workspace, &application)?;
    Ok(ImageAtomEditApplyResult {
        result: ImageAtomMutationResult {
            mutation,
            operation,
        },
        pruned_attachment_paths,
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
                    serialize_workspace: true,
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

    let today = SystemLocalTodayProvider.local_today(connection)?;
    let result = history::with_history_transaction_and_prunes(
        connection,
        Some(&history_context),
        |connection| {
            repository::apply_image_atom_edit_plan(
                connection,
                &history_context.entry_id,
                &input.target,
                &plan,
                today,
                |transaction, workspace| {
                    let receipt = operation_receipt(
                        &history_context,
                        &input.target.node_id,
                        &plan,
                        workspace,
                    )?;
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
    let mutation = result.into_mutation_result_with_workspace();
    if mutation.history_entry_id.as_deref() != Some(history_context.entry_id.as_str()) {
        return Err(
            "The Notes image atom edit did not create its required history entry.".to_string(),
        );
    }
    let receipt = operation_receipt(
        &history_context,
        &input.target.node_id,
        &plan,
        &mutation.workspace,
    )?;
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
        ack_operation_receipt, apply_image_atom_edit, apply_image_atom_paste_with_prunes,
        edit_plan, lookup_operation_receipt, postcondition_digest, prepare_image_atom_paste,
        record_operation_receipt, retry_image_atom_paste,
    };
    use crate::notes::attachment_ingest::RawAttachmentSource;
    use crate::notes::attachments::PreparedAttachmentBatch;
    use crate::notes::history::{history_epoch, redo, undo};
    use crate::notes::repository::{connect_notes_db, preflight_image_atom_paste_plan};
    use crate::notes::types::{
        ApplyImageAtomEditInput, ApplyImageAtomPasteInput, ImageAtomEdit, ImageAtomFocusResult,
        ImageAtomOperationLookup, ImageAtomOperationReceiptResult, ImageAtomPasteFragmentItem,
        ImageAtomPasteTargetAuthority, ImageTargetAuthority, LogicalSelection, NoteNodeKind,
        NotesHistoryContext, NotesWorkspaceScope,
    };
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
    use rusqlite::params;
    use std::io::Cursor;

    const SESSION_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const FOREIGN_SESSION_ID: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const OPERATION_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const SECOND_OPERATION_ID: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const NODE_ID: &str = "11111111-1111-4111-8111-111111111111";
    const CHILD_ID: &str = "22222222-2222-4222-8222-222222222222";
    const ATTACHMENT_ID: &str = "33333333-3333-4333-8333-333333333333";
    const SIBLING_ID: &str = "44444444-4444-4444-8444-444444444444";
    const REPLACEMENT_ATTACHMENT_ID: &str = "55555555-5555-4555-8555-555555555555";
    const PASTE_SIBLING_ATTACHMENT_ID: &str = "66666666-6666-4666-8666-666666666666";
    const FIRST_PASTE_SIBLING_ID: &str = "77777777-7777-4777-8777-777777777777";
    const FIRST_PASTE_SIBLING_ATTACHMENT_ID: &str = "88888888-8888-4888-8888-888888888888";

    fn insert_history_entry(connection: &rusqlite::Connection, operation_id: &str) {
        insert_history_entry_with_kind(connection, operation_id, "imageAtomEdit");
    }

    fn insert_history_entry_with_kind(
        connection: &rusqlite::Connection,
        operation_id: &str,
        command_kind: &str,
    ) {
        connection
            .execute(
                "INSERT INTO notes_history_entries(id, session_id, sequence, command_kind) \
                 VALUES (?1, ?2, (SELECT COALESCE(MAX(sequence), 0) + 1 \
                                  FROM notes_history_entries WHERE session_id = ?2), ?3)",
                params![operation_id, SESSION_ID, command_kind],
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

    fn paste_history_context(
        connection: &rusqlite::Connection,
        entry_id: &str,
    ) -> NotesHistoryContext {
        NotesHistoryContext {
            command_kind: "imageAtomPaste".to_string(),
            ..history_context(connection, entry_id)
        }
    }

    fn png_bytes() -> Vec<u8> {
        let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(2, 3, Rgb([32, 64, 96])));
        let mut bytes = Cursor::new(Vec::new());
        image
            .write_to(&mut bytes, ImageFormat::Png)
            .expect("encode png");
        bytes.into_inner()
    }

    fn paste_batch(bytes: &[u8]) -> PreparedAttachmentBatch {
        PreparedAttachmentBatch::from_bytes(vec![
            RawAttachmentSource {
                original_name: "replacement.png".to_string(),
                declared_mime_type: "image/png".to_string(),
                bytes,
            },
            RawAttachmentSource {
                original_name: "sibling.png".to_string(),
                declared_mime_type: "image/png".to_string(),
                bytes,
            },
        ])
        .expect("prepare paste images")
    }

    fn paste_input(initial_max_display_width: i64, byte_length: u64) -> ApplyImageAtomPasteInput {
        ApplyImageAtomPasteInput {
            target: ImageAtomPasteTargetAuthority {
                node_id: NODE_ID.to_string(),
                expected_updated_at: "2026-07-10T00:00:00.000Z".to_string(),
                expected_node_kind: NoteNodeKind::Image,
                expected_title: "AB".to_string(),
                expected_image_offset_utf16: 1,
                expected_primary_attachment_id: Some(ATTACHMENT_ID.to_string()),
            },
            selection: LogicalSelection {
                anchor_utf16: 1,
                focus_utf16: 2,
            },
            version: 1,
            fragment: vec![
                ImageAtomPasteFragmentItem::Text {
                    text: "L".to_string(),
                },
                ImageAtomPasteFragmentItem::Image {
                    node_id: NODE_ID.to_string(),
                    attachment_id: REPLACEMENT_ATTACHMENT_ID.to_string(),
                    ordinal: 0,
                    original_name: "replacement.png".to_string(),
                    mime_type: "image/png".to_string(),
                    byte_length,
                },
                ImageAtomPasteFragmentItem::Text {
                    text: "M".to_string(),
                },
                ImageAtomPasteFragmentItem::Image {
                    node_id: SIBLING_ID.to_string(),
                    attachment_id: PASTE_SIBLING_ATTACHMENT_ID.to_string(),
                    ordinal: 1,
                    original_name: "sibling.png".to_string(),
                    mime_type: "image/png".to_string(),
                    byte_length,
                },
                ImageAtomPasteFragmentItem::Text {
                    text: "R".to_string(),
                },
            ],
            initial_max_display_width,
        }
    }

    fn sibling_only_paste_input(byte_length: u64) -> ApplyImageAtomPasteInput {
        let mut input = paste_input(160, byte_length);
        input.fragment = vec![
            ImageAtomPasteFragmentItem::Text {
                text: "L".to_string(),
            },
            ImageAtomPasteFragmentItem::Image {
                node_id: FIRST_PASTE_SIBLING_ID.to_string(),
                attachment_id: FIRST_PASTE_SIBLING_ATTACHMENT_ID.to_string(),
                ordinal: 0,
                original_name: "replacement.png".to_string(),
                mime_type: "image/png".to_string(),
                byte_length,
            },
            ImageAtomPasteFragmentItem::Text {
                text: "M".to_string(),
            },
            ImageAtomPasteFragmentItem::Image {
                node_id: SIBLING_ID.to_string(),
                attachment_id: PASTE_SIBLING_ATTACHMENT_ID.to_string(),
                ordinal: 1,
                original_name: "sibling.png".to_string(),
                mime_type: "image/png".to_string(),
                byte_length,
            },
            ImageAtomPasteFragmentItem::Text {
                text: "R".to_string(),
            },
        ];
        input
    }

    #[test]
    fn image_atom_paste_distributes_ordered_fragment_atomically() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        seed_image(&connection);
        let bytes = png_bytes();
        let byte_length = u64::try_from(bytes.len()).expect("byte length");
        let input = paste_input(160, byte_length);
        let history = paste_history_context(&connection, OPERATION_ID);
        let prepared = prepare_image_atom_paste(&input, &history, &paste_batch(&bytes))
            .expect("prepare image atom paste");

        let applied = apply_image_atom_paste_with_prunes(
            &mut connection,
            input.clone(),
            history,
            prepared,
            || Ok(()),
        )
        .expect("apply image atom paste")
        .result;

        let target = node(&applied.mutation.workspace, NODE_ID);
        assert_eq!(target.node_kind, NoteNodeKind::Image);
        assert_eq!(target.title, "ALM");
        assert_eq!(target.image_offset_utf16, 2);
        assert_eq!(target.note, "Supporting note");
        assert!(applied
            .mutation
            .workspace
            .nodes
            .iter()
            .any(|candidate| candidate.parent_id.as_deref() == Some(NODE_ID)));
        let sibling = node(&applied.mutation.workspace, SIBLING_ID);
        assert_eq!(sibling.title, "RB");
        assert_eq!(sibling.image_offset_utf16, 0);
        assert_eq!(
            applied.operation.affected_root_ids,
            vec![NODE_ID.to_string(), SIBLING_ID.to_string()]
        );
        assert_eq!(applied.operation.focus.node_id, NODE_ID);
        assert_eq!(applied.operation.focus.anchor_utf16, 2);
        assert_eq!(applied.operation.focus.focus_utf16, 3);
        assert_eq!(
            applied.mutation.workspace.attachments_by_node_id[NODE_ID][0].id,
            REPLACEMENT_ATTACHMENT_ID
        );
        assert_eq!(
            applied.mutation.workspace.attachments_by_node_id[SIBLING_ID][0].id,
            PASTE_SIBLING_ATTACHMENT_ID
        );

        let retry_input = paste_input(160, byte_length);
        let retry_history = paste_history_context(&connection, OPERATION_ID);
        let retry_prepared =
            prepare_image_atom_paste(&retry_input, &retry_history, &paste_batch(&bytes))
                .expect("prepare retry");
        let retry = retry_image_atom_paste(&connection, &retry_history, &retry_prepared)
            .expect("retry image atom paste")
            .expect("committed retry")
            .result;
        assert_eq!(
            retry.operation.affected_root_ids,
            applied.operation.affected_root_ids
        );
        let attachment_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count attachments");
        assert_eq!(attachment_count, 2);

        let undone = undo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect("undo image replacement");
        assert_eq!(
            undone.workspace.attachments_by_node_id[NODE_ID][0].id,
            ATTACHMENT_ID
        );
        let redone = redo(&mut connection, SESSION_ID, NotesWorkspaceScope::Active)
            .expect("redo image replacement");
        assert_eq!(
            redone.workspace.attachments_by_node_id[NODE_ID][0].id,
            REPLACEMENT_ATTACHMENT_ID
        );

        let conflicting_history = paste_history_context(&connection, OPERATION_ID);
        let conflicting = prepare_image_atom_paste(
            &paste_input(2, byte_length),
            &conflicting_history,
            &paste_batch(&bytes),
        )
        .expect("prepare conflicting width retry");
        let error = match retry_image_atom_paste(&connection, &conflicting_history, &conflicting) {
            Ok(_) => panic!("different width must conflict with the stored receipt"),
            Err(error) => error,
        };
        assert!(error.contains("different fingerprint"), "{error}");
    }

    #[test]
    fn image_atom_paste_retry_rejects_postcondition_drift() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        seed_image(&connection);
        let bytes = png_bytes();
        let byte_length = u64::try_from(bytes.len()).expect("byte length");
        let input = paste_input(160, byte_length);
        let history = paste_history_context(&connection, OPERATION_ID);
        let prepared = prepare_image_atom_paste(&input, &history, &paste_batch(&bytes))
            .expect("prepare image atom paste");
        apply_image_atom_paste_with_prunes(
            &mut connection,
            input.clone(),
            history.clone(),
            prepared,
            || Ok(()),
        )
        .expect("apply image atom paste");
        connection
            .execute(
                "UPDATE notes_nodes SET title = 'drifted' WHERE id = ?1",
                [NODE_ID],
            )
            .expect("drift committed image paste node");

        let retry_history = paste_history_context(&connection, OPERATION_ID);
        let retry_prepared = prepare_image_atom_paste(&input, &retry_history, &paste_batch(&bytes))
            .expect("prepare retry");
        let retry = retry_image_atom_paste(&connection, &retry_history, &retry_prepared);

        let error = match retry {
            Ok(_) => panic!("postcondition drift must reject an exact retry"),
            Err(error) => error,
        };
        assert!(error.contains("postcondition"), "{error}");
    }

    #[test]
    fn image_atom_paste_retry_rejects_attachment_ownership_metadata_and_undone_drift() {
        for drift in ["metadata", "ownership", "undone history"] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let mut connection =
                connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
            seed_image(&connection);
            let bytes = png_bytes();
            let byte_length = u64::try_from(bytes.len()).expect("byte length");
            let input = paste_input(160, byte_length);
            let history = paste_history_context(&connection, OPERATION_ID);
            let prepared = prepare_image_atom_paste(&input, &history, &paste_batch(&bytes))
                .expect("prepare image atom paste");
            apply_image_atom_paste_with_prunes(
                &mut connection,
                input.clone(),
                history.clone(),
                prepared,
                || Ok(()),
            )
            .expect("apply image atom paste");

            match drift {
                "metadata" => {
                    connection
                        .execute(
                            "UPDATE notes_attachments SET original_name = 'drifted.png' WHERE id = ?1",
                            [REPLACEMENT_ATTACHMENT_ID],
                        )
                        .expect("drift committed attachment metadata");
                }
                "ownership" => {
                    connection
                        .execute(
                            "UPDATE notes_attachments SET node_id = ?1 WHERE id = ?2",
                            params![SIBLING_ID, REPLACEMENT_ATTACHMENT_ID],
                        )
                        .expect("drift committed attachment ownership");
                }
                "undone history" => {
                    connection
                        .execute(
                            "UPDATE notes_history_entries SET is_undone = 1 WHERE id = ?1",
                            [OPERATION_ID],
                        )
                        .expect("mark paste history undone");
                }
                _ => unreachable!(),
            }

            let retry_history = paste_history_context(&connection, OPERATION_ID);
            let retry_prepared =
                prepare_image_atom_paste(&input, &retry_history, &paste_batch(&bytes))
                    .expect("prepare retry");
            let error = match retry_image_atom_paste(&connection, &retry_history, &retry_prepared) {
                Err(error) => error,
                Ok(_) => panic!("committed retry must reject {drift}"),
            };
            if drift == "undone history" {
                assert!(error.contains("inconsistent"), "{drift}: {error}");
            } else {
                assert!(error.contains("postcondition"), "{drift}: {error}");
            }
        }
    }

    #[test]
    fn image_atom_paste_obeys_text_legacy_and_unselected_sibling_placement() {
        let bytes = png_bytes();
        let byte_length = u64::try_from(bytes.len()).expect("byte length");

        let clean_temp = tempfile::tempdir().expect("clean temp dir");
        let mut clean =
            connect_notes_db(clean_temp.path().to_str().expect("path")).expect("clean connect");
        seed_image(&clean);
        clean
            .execute(
                "UPDATE notes_nodes SET node_kind = 'text', title = 'ABC', image_offset_utf16 = 0 WHERE id = ?1",
                [NODE_ID],
            )
            .expect("make clean text target");
        clean
            .execute(
                "DELETE FROM notes_attachments WHERE node_id = ?1",
                [NODE_ID],
            )
            .expect("remove old attachment");
        let mut clean_input = paste_input(160, byte_length);
        clean_input.target = ImageAtomPasteTargetAuthority {
            node_id: NODE_ID.to_string(),
            expected_updated_at: "2026-07-10T00:00:00.000Z".to_string(),
            expected_node_kind: NoteNodeKind::Text,
            expected_title: "ABC".to_string(),
            expected_image_offset_utf16: 0,
            expected_primary_attachment_id: None,
        };
        clean_input.selection = LogicalSelection {
            anchor_utf16: 1,
            focus_utf16: 2,
        };
        let clean_history = paste_history_context(&clean, OPERATION_ID);
        let clean_result = apply_image_atom_paste_with_prunes(
            &mut clean,
            clean_input.clone(),
            clean_history.clone(),
            prepare_image_atom_paste(&clean_input, &clean_history, &paste_batch(&bytes))
                .expect("prepare clean text paste"),
            || Ok(()),
        )
        .expect("apply clean text paste")
        .result;
        let clean_target = node(&clean_result.mutation.workspace, NODE_ID);
        assert_eq!(clean_target.title, "ALM");
        assert_eq!(clean_target.image_offset_utf16, 2);
        assert_eq!(clean_target.note, "Supporting note");
        assert!(clean_target.is_collapsed && clean_target.is_starred);
        assert_eq!(
            node(&clean_result.mutation.workspace, SIBLING_ID).title,
            "RC"
        );
        assert_eq!(node(&clean_result.mutation.workspace, SIBLING_ID).note, "");
        assert!(!node(&clean_result.mutation.workspace, SIBLING_ID).is_collapsed);

        let legacy_temp = tempfile::tempdir().expect("legacy temp dir");
        let mut legacy =
            connect_notes_db(legacy_temp.path().to_str().expect("path")).expect("legacy connect");
        seed_image(&legacy);
        legacy
            .execute(
                "UPDATE notes_nodes SET node_kind = 'text', title = 'Legacy', image_offset_utf16 = 0 WHERE id = ?1",
                [NODE_ID],
            )
            .expect("make legacy text target");
        let mut legacy_input = sibling_only_paste_input(byte_length);
        legacy_input.target = ImageAtomPasteTargetAuthority {
            node_id: NODE_ID.to_string(),
            expected_updated_at: "2026-07-10T00:00:00.000Z".to_string(),
            expected_node_kind: NoteNodeKind::Text,
            expected_title: "Legacy".to_string(),
            expected_image_offset_utf16: 0,
            expected_primary_attachment_id: None,
        };
        let legacy_history = paste_history_context(&legacy, OPERATION_ID);
        let legacy_result = apply_image_atom_paste_with_prunes(
            &mut legacy,
            legacy_input.clone(),
            legacy_history.clone(),
            prepare_image_atom_paste(&legacy_input, &legacy_history, &paste_batch(&bytes))
                .expect("prepare legacy paste"),
            || Ok(()),
        )
        .expect("apply legacy paste")
        .result;
        assert_eq!(
            node(&legacy_result.mutation.workspace, NODE_ID).title,
            "Legacy"
        );
        assert_eq!(
            node(&legacy_result.mutation.workspace, NODE_ID).node_kind,
            NoteNodeKind::Text
        );
        assert_eq!(
            node(&legacy_result.mutation.workspace, FIRST_PASTE_SIBLING_ID).title,
            "LM"
        );
        assert_eq!(
            node(&legacy_result.mutation.workspace, SIBLING_ID).title,
            "R"
        );

        let image_temp = tempfile::tempdir().expect("image temp dir");
        let mut image =
            connect_notes_db(image_temp.path().to_str().expect("path")).expect("image connect");
        seed_image(&image);
        let mut image_input = sibling_only_paste_input(byte_length);
        image_input.selection = LogicalSelection {
            anchor_utf16: 0,
            focus_utf16: 0,
        };
        let image_history = paste_history_context(&image, OPERATION_ID);
        let image_result = apply_image_atom_paste_with_prunes(
            &mut image,
            image_input.clone(),
            image_history.clone(),
            prepare_image_atom_paste(&image_input, &image_history, &paste_batch(&bytes))
                .expect("prepare unselected image paste"),
            || Ok(()),
        )
        .expect("apply unselected image paste")
        .result;
        assert_eq!(node(&image_result.mutation.workspace, NODE_ID).title, "AB");
        assert_eq!(
            image_result.mutation.workspace.attachments_by_node_id[NODE_ID][0].id,
            ATTACHMENT_ID
        );
        assert_eq!(
            node(&image_result.mutation.workspace, FIRST_PASTE_SIBLING_ID).title,
            "LM"
        );
        assert_eq!(
            node(&image_result.mutation.workspace, SIBLING_ID).title,
            "R"
        );
    }

    #[test]
    fn image_atom_paste_preflight_rejects_stale_authority_before_publication() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        seed_image(&connection);
        let bytes = png_bytes();
        let byte_length = u64::try_from(bytes.len()).expect("byte length");
        let input = paste_input(160, byte_length);
        let history = paste_history_context(&connection, OPERATION_ID);
        let prepared = prepare_image_atom_paste(&input, &history, &paste_batch(&bytes))
            .expect("prepare stale paste");
        connection
            .execute(
                "UPDATE notes_nodes SET title = 'stale' WHERE id = ?1",
                [NODE_ID],
            )
            .expect("make target stale");

        let error = preflight_image_atom_paste_plan(
            &mut connection,
            &history.entry_id,
            &input,
            &prepared.attachments,
        )
        .expect_err("stale target must fail before publication");
        assert!(error.contains("stale"), "{error}");
        let node_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row.get(0))
            .expect("count nodes");
        let attachment_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count attachments");
        assert_eq!(node_count, 2);
        assert_eq!(attachment_count, 1);
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

    fn node_mut<'a>(
        workspace: &'a mut crate::notes::types::NotesWorkspace,
        id: &str,
    ) -> &'a mut crate::notes::types::NoteNode {
        workspace
            .nodes
            .iter_mut()
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
                "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeea",
                (0, 2),
                "prefix",
                "prefixB",
            ),
            (
                "ffffffff-ffff-4fff-8fff-fffffffffff0",
                (2, 0),
                "prefix",
                "prefixB",
            ),
            (
                "99999999-9999-4999-8999-999999999998",
                (1, 3),
                "suffix",
                "Asuffix",
            ),
            (
                "88888888-8888-4888-8888-888888888888",
                (3, 1),
                "suffix",
                "Asuffix",
            ),
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
            (
                "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeeb",
                (1, 3),
                NoteNodeKind::Text,
                "A",
                0,
                NoteNodeKind::Text,
                "",
                0,
            ),
            (
                "ffffffff-ffff-4fff-8fff-fffffffffff1",
                (3, 1),
                NoteNodeKind::Text,
                "A",
                0,
                NoteNodeKind::Text,
                "",
                0,
            ),
            (
                "99999999-9999-4999-8999-999999999997",
                (0, 3),
                NoteNodeKind::Text,
                "",
                0,
                NoteNodeKind::Text,
                "",
                0,
            ),
            (
                "88888888-8888-4888-8888-888888888887",
                (3, 0),
                NoteNodeKind::Text,
                "",
                0,
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
    fn enter_deletes_mixed_surrogate_ranges_on_either_side_of_the_atom() {
        for (entry_id, selection, expected_source_title, expected_sibling_title) in [
            (OPERATION_ID, (1, 4), "A", "B"),
            (SECOND_OPERATION_ID, (5, 3), "A😀", ""),
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
                .expect("split after deleting mixed surrogate range");

            let source = node(&result.mutation.workspace, NODE_ID);
            let sibling = node(&result.mutation.workspace, SIBLING_ID);
            assert_eq!(source.title, expected_source_title);
            assert_eq!(sibling.title, expected_sibling_title);
            assert_eq!(source.node_kind, NoteNodeKind::Text);
            assert_eq!(sibling.node_kind, NoteNodeKind::Text);
        }
    }

    #[test]
    fn fresh_operation_ids_cannot_coalesce_with_orphan_history_entries() {
        for (entry_id, command_kind) in [
            (OPERATION_ID, "updateText"),
            (SECOND_OPERATION_ID, "imageAtomEdit"),
        ] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let mut connection =
                connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
            seed_image(&connection);
            insert_history_entry_with_kind(&connection, entry_id, command_kind);
            let before_attachment_owner: String = connection
                .query_row(
                    "SELECT node_id FROM notes_attachments WHERE id = ?1",
                    [ATTACHMENT_ID],
                    |row| row.get(0),
                )
                .expect("attachment owner before rejection");
            let context = history_context(&connection, entry_id);

            assert!(apply_image_atom_edit(
                &mut connection,
                edit_input(
                    (1, 2),
                    ImageAtomEdit::Remove {
                        replacement_text: "replacement".to_string(),
                    },
                ),
                context,
            )
            .expect_err("orphaned history entry must reject")
            .contains("history entry"));

            assert_eq!(
                node(
                    &crate::notes::repository::load_workspace(
                        &connection,
                        NotesWorkspaceScope::Active,
                    )
                    .expect("workspace after rejection"),
                    NODE_ID
                )
                .title,
                "AB"
            );
            assert_eq!(
                connection
                    .query_row(
                        "SELECT node_id FROM notes_attachments WHERE id = ?1",
                        [ATTACHMENT_ID],
                        |row| row.get::<_, String>(0),
                    )
                    .expect("attachment owner after rejection"),
                before_attachment_owner
            );
            assert_eq!(
                connection
                    .query_row("SELECT COUNT(*) FROM notes_history_entries", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .expect("history count after rejection"),
                1
            );
            assert_eq!(
                connection
                    .query_row(
                        "SELECT command_kind FROM notes_history_entries WHERE id = ?1",
                        [entry_id],
                        |row| row.get::<_, String>(0),
                    )
                    .expect("preserved orphan command kind"),
                command_kind
            );
            assert_eq!(receipt_count(&connection), 0);
        }
    }

    #[test]
    fn postcondition_digest_reflects_authoritative_preserved_state_and_attachment_layout() {
        fn enter_digest(connection: &mut rusqlite::Connection, entry_id: &str) -> String {
            let context = history_context(connection, entry_id);
            apply_image_atom_edit(
                connection,
                edit_input(
                    (1, 1),
                    ImageAtomEdit::Enter {
                        sibling_id: SIBLING_ID.to_string(),
                    },
                ),
                context,
            )
            .expect("enter image atom")
            .operation
            .postcondition_digest
        }

        let baseline_dir = tempfile::tempdir().expect("baseline temp dir");
        let mut baseline =
            connect_notes_db(baseline_dir.path().to_str().expect("path")).expect("connect");
        seed_image(&baseline);
        let baseline_digest = enter_digest(&mut baseline, OPERATION_ID);

        let note_dir = tempfile::tempdir().expect("note temp dir");
        let mut note_connection =
            connect_notes_db(note_dir.path().to_str().expect("path")).expect("connect");
        seed_image(&note_connection);
        note_connection
            .execute(
                "UPDATE notes_nodes SET note = 'Changed note' WHERE id = ?1",
                [NODE_ID],
            )
            .expect("change preserved source note");
        assert_ne!(
            enter_digest(&mut note_connection, SECOND_OPERATION_ID),
            baseline_digest,
            "plan-equivalent edits must digest the authoritative preserved note"
        );

        let order_dir = tempfile::tempdir().expect("attachment order temp dir");
        let mut order_connection =
            connect_notes_db(order_dir.path().to_str().expect("path")).expect("connect");
        seed_image(&order_connection);
        order_connection
            .execute(
                "UPDATE notes_attachments SET sort_key = 2048 WHERE id = ?1",
                [ATTACHMENT_ID],
            )
            .expect("change retained attachment order");
        assert_ne!(
            enter_digest(
                &mut order_connection,
                "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            ),
            baseline_digest,
            "plan-equivalent edits must digest attachment placement"
        );

        let path_dir = tempfile::tempdir().expect("attachment path temp dir");
        let mut path_connection =
            connect_notes_db(path_dir.path().to_str().expect("path")).expect("connect");
        seed_image(&path_connection);
        path_connection
            .execute(
                "UPDATE notes_attachments SET relative_path = 'notes-assets/other.png' WHERE id = ?1",
                [ATTACHMENT_ID],
            )
            .expect("change retained attachment path metadata");
        assert_ne!(
            enter_digest(&mut path_connection, "ffffffff-ffff-4fff-8fff-ffffffffffff",),
            baseline_digest,
            "plan-equivalent edits must digest attachment path metadata"
        );

        let ownership_dir = tempfile::tempdir().expect("ownership temp dir");
        let mut ownership_connection =
            connect_notes_db(ownership_dir.path().to_str().expect("path")).expect("connect");
        seed_image(&ownership_connection);
        ownership_connection
            .execute(
                "INSERT INTO notes_attachments(\
                   id, node_id, sort_key, relative_path, content_hash, original_name, mime_type, \
                   byte_size, intrinsic_width, intrinsic_height, display_width, created_at, updated_at\
                 ) VALUES (\
                   ?1, ?2, 1024, 'notes-assets/child.png', ?3, 'child.png', 'image/png', \
                   1, 160, 160, 160, '2026-07-10T00:00:00.000Z', \
                   '2026-07-10T00:00:00.000Z'\
                 )",
                params!["55555555-5555-4555-8555-555555555555", CHILD_ID, "c".repeat(64)],
            )
            .expect("add source-subtree attachment");
        assert_ne!(
            enter_digest(
                &mut ownership_connection,
                "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            ),
            baseline_digest,
            "plan-equivalent edits must digest source-subtree attachment ownership"
        );
    }

    #[test]
    fn postcondition_digest_handles_deep_subtrees_without_recursion_and_rejects_cycles() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect");
        seed_image(&connection);
        let input = edit_input(
            (1, 1),
            ImageAtomEdit::Enter {
                sibling_id: SIBLING_ID.to_string(),
            },
        );
        let plan = edit_plan(&input).expect("image atom plan");
        let context = history_context(&connection, OPERATION_ID);
        let split =
            apply_image_atom_edit(&mut connection, input, context).expect("split image atom");

        let mut deep_workspace = split.mutation.workspace.clone();
        let template = node(&deep_workspace, CHILD_ID).clone();
        let mut parent_id = CHILD_ID.to_string();
        for index in 0..2_000 {
            let mut child = template.clone();
            child.id = format!("00000000-0000-4000-8000-{index:012x}");
            child.parent_id = Some(parent_id.clone());
            child.sort_key = 1024;
            parent_id = child.id.clone();
            deep_workspace.nodes.push(child);
        }
        assert!(postcondition_digest(&deep_workspace, NODE_ID, &plan).is_ok());

        let mut cyclic_workspace = split.mutation.workspace;
        node_mut(&mut cyclic_workspace, NODE_ID).parent_id = Some(CHILD_ID.to_string());
        assert!(postcondition_digest(&cyclic_workspace, NODE_ID, &plan)
            .expect_err("cyclic postcondition must not recurse")
            .contains("cycle"));
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
