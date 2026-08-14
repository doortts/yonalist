use std::collections::BTreeSet;

use notes_application::{StorageCommit, StorageError};
use notes_core::{DomainError, DomainPatch, NodeId, NoteNode, NoteNodeKind, TreeMutation};
use rusqlite::{Connection, TransactionBehavior, params};
use unicode_normalization::{UnicodeNormalization, char::canonical_combining_class};

use crate::repository::{internal, kind_name, parse_revision};

pub(crate) fn commit(
    connection: &mut Connection,
    expected_revision: u64,
    patch: &DomainPatch,
) -> Result<StorageCommit, StorageError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(internal)?;
    let actual_revision: u64 = transaction
        .query_row(
            "SELECT revision FROM notes_meta WHERE singleton = 1",
            [],
            parse_revision,
        )
        .map_err(internal)?;
    if actual_revision != expected_revision {
        return Err(StorageError::RevisionConflict {
            expected: expected_revision,
            actual: actual_revision,
        });
    }

    // A node the inverse deletes is one this patch creates. The set is
    // consumed: a coalesced history group can carry several upserts of the
    // same id (undoing blank-then-remove replays the row twice), so only the
    // first one inserts and the rest update the row it just put back.
    let mut inserted_ids = patch
        .inverse
        .iter()
        .filter_map(|mutation| match mutation {
            TreeMutation::Delete { id } => Some(id),
            TreeMutation::Upsert(_) => None,
        })
        .collect::<BTreeSet<_>>();
    for mutation in &patch.forward {
        match mutation {
            TreeMutation::Upsert(node) => {
                validate_image_ownership(node)?;
                if inserted_ids.remove(node.id()) {
                    insert_node(&transaction, node)?;
                } else {
                    update_node(&transaction, node)?;
                }
                sync_image(&transaction, node)?;
                refresh_derived_data(&transaction, node)?;
            }
            TreeMutation::Delete { id } => {
                transaction
                    .execute("DELETE FROM notes_nodes WHERE id = ?1", [id.as_str()])
                    .map_err(internal)?;
            }
        }
    }
    // After the whole patch: a row's path reads its ancestors, which an earlier
    // mutation in this same loop may not have written yet.
    crate::node_paths::refresh(&transaction, patch)?;
    let next_revision = actual_revision
        .checked_add(1)
        .ok_or_else(|| StorageError::Internal("revision overflowed".into()))?;
    transaction
        .execute(
            "UPDATE notes_meta SET revision = ?1 WHERE singleton = 1",
            [i64::try_from(next_revision)
                .map_err(|_| StorageError::Internal("revision exceeded SQLite INTEGER".into()))?],
        )
        .map_err(internal)?;
    transaction.commit().map_err(internal)?;

    Ok(StorageCommit {
        revision: next_revision,
        changed_nodes: patch
            .forward
            .iter()
            .filter_map(|mutation| match mutation {
                TreeMutation::Upsert(node) => Some(node.as_ref().clone()),
                TreeMutation::Delete { .. } => None,
            })
            .collect(),
        deleted_ids: patch
            .forward
            .iter()
            .filter_map(|mutation| match mutation {
                TreeMutation::Delete { id } => Some(id.clone()),
                TreeMutation::Upsert(_) => None,
            })
            .collect(),
    })
}

fn validate_image_ownership(node: &NoteNode) -> Result<(), StorageError> {
    match (node.kind(), node.image()) {
        (NoteNodeKind::Page | NoteNodeKind::Bullet, Some(_)) => {
            Err(StorageError::Domain(DomainError::Invariant(format!(
                "non-image node {} cannot own image metadata",
                node.id()
            ))))
        }
        _ => Ok(()),
    }
}

fn sync_image(
    transaction: &rusqlite::Transaction<'_>,
    node: &NoteNode,
) -> Result<(), StorageError> {
    let Some(image) = node.image() else {
        transaction
            .execute(
                "DELETE FROM notes_images WHERE node_id = ?1",
                [node.id().as_str()],
            )
            .map_err(internal)?;
        return Ok(());
    };
    transaction
        .execute(
            "INSERT INTO notes_images(
                node_id, content_hash, relative_path, original_name, mime_type,
                byte_length, pixel_width, pixel_height, display_width
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(node_id) DO UPDATE SET
                content_hash = excluded.content_hash,
                relative_path = excluded.relative_path,
                original_name = excluded.original_name,
                mime_type = excluded.mime_type,
                byte_length = excluded.byte_length,
                pixel_width = excluded.pixel_width,
                pixel_height = excluded.pixel_height,
                display_width = excluded.display_width",
            params![
                node.id().as_str(),
                image.content_hash(),
                image.relative_path(),
                image.original_name(),
                image.mime_type(),
                i64::try_from(image.byte_length()).map_err(|_| {
                    StorageError::Internal("image byte length exceeded SQLite INTEGER".into())
                })?,
                image.pixel_width(),
                image.pixel_height(),
                image.display_width(),
            ],
        )
        .map_err(internal)?;
    Ok(())
}

fn insert_node(
    transaction: &rusqlite::Transaction<'_>,
    node: &NoteNode,
) -> Result<(), StorageError> {
    let exists = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_nodes WHERE id = ?1)",
            [node.id().as_str()],
            |row| row.get::<_, bool>(0),
        )
        .map_err(internal)?;
    if exists {
        return Err(StorageError::Domain(DomainError::DuplicateNode(
            node.id().clone(),
        )));
    }
    transaction
        .execute(
            "INSERT INTO notes_nodes(
                id, parent_id, sort_key, kind, text, note, marker, collapsed,
                completed, starred, deleted, ordered_start
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                node.id().as_str(),
                node.parent_id().map(NodeId::as_str),
                node.sort_key(),
                kind_name(node.kind()),
                node.text(),
                node.note(),
                marker_name(node.marker()),
                node.is_collapsed(),
                node.is_completed(),
                node.is_starred(),
                node.is_deleted(),
                marker_start(node.marker()),
            ],
        )
        .map_err(internal)?;
    Ok(())
}

fn update_node(
    transaction: &rusqlite::Transaction<'_>,
    node: &NoteNode,
) -> Result<(), StorageError> {
    let changed = transaction
        .execute(
            "UPDATE notes_nodes SET
                parent_id = ?2,
                sort_key = ?3,
                kind = ?4,
                text = ?5,
                note = ?6,
                marker = ?7,
                collapsed = ?8,
                completed = ?9,
                starred = ?10,
                deleted = ?11,
                ordered_start = ?12
             WHERE id = ?1",
            params![
                node.id().as_str(),
                node.parent_id().map(NodeId::as_str),
                node.sort_key(),
                kind_name(node.kind()),
                node.text(),
                node.note(),
                marker_name(node.marker()),
                node.is_collapsed(),
                node.is_completed(),
                node.is_starred(),
                node.is_deleted(),
                marker_start(node.marker()),
            ],
        )
        .map_err(internal)?;
    if changed == 0 {
        return Err(StorageError::Domain(DomainError::NodeNotFound(
            node.id().clone(),
        )));
    }
    Ok(())
}

fn refresh_derived_data(
    transaction: &rusqlite::Transaction<'_>,
    node: &NoteNode,
) -> Result<(), StorageError> {
    transaction
        .execute(
            "DELETE FROM notes_tags WHERE node_id = ?1",
            [node.id().as_str()],
        )
        .map_err(internal)?;
    transaction
        .execute(
            "DELETE FROM notes_dates WHERE node_id = ?1",
            [node.id().as_str()],
        )
        .map_err(internal)?;
    let indexed_content = if node.kind() == NoteNodeKind::Image {
        vec![node.note()]
    } else {
        vec![node.text(), node.note()]
    };
    for content in indexed_content {
        for (token, display) in derived_tags(content) {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO notes_tags(node_id, token, display_tag)
                     VALUES (?1, ?2, ?3)",
                    params![node.id().as_str(), token, display],
                )
                .map_err(internal)?;
        }
        for date in derived_dates(content) {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO notes_dates(node_id, date_key) VALUES (?1, ?2)",
                    params![node.id().as_str(), date],
                )
                .map_err(internal)?;
        }
    }
    Ok(())
}

fn marker_name(marker: notes_core::NoteMarkerKind) -> &'static str {
    match marker {
        notes_core::NoteMarkerKind::Bullet => "bullet",
        notes_core::NoteMarkerKind::Todo => "todo",
        notes_core::NoteMarkerKind::Ordered { .. } => "ordered",
    }
}

/// The number an `ordered` row starts its run at. Every other marker stores the
/// column's default, which no reader of that row ever looks at.
fn marker_start(marker: notes_core::NoteMarkerKind) -> i64 {
    match marker {
        notes_core::NoteMarkerKind::Ordered { start } => start,
        _ => 1,
    }
}

fn derived_tags(text: &str) -> Vec<(String, String)> {
    let characters = text.char_indices().collect::<Vec<_>>();
    let mut tags = Vec::new();
    let mut index = 0;
    while index < characters.len() {
        let (start, prefix) = characters[index];
        if prefix != '#' && prefix != '@' {
            index += 1;
            continue;
        }
        let previous = index
            .checked_sub(1)
            .and_then(|previous| characters.get(previous))
            .map(|(_, character)| *character);
        if previous.is_some_and(is_tag_boundary_character) {
            index += 1;
            continue;
        }
        let Some((_, first)) = characters.get(index + 1) else {
            break;
        };
        if !first.is_alphanumeric() && *first != '_' {
            index += 1;
            continue;
        }

        let mut end_index = index + 2;
        while let Some((_, character)) = characters.get(end_index) {
            if !is_tag_character(*character) {
                break;
            }
            end_index += 1;
        }
        let end = characters
            .get(end_index)
            .map(|(offset, _)| *offset)
            .unwrap_or(text.len());
        let display = text[start..end].nfc().collect::<String>();
        tags.push((display.to_lowercase(), display));
        index = end_index;
    }
    tags
}

fn is_tag_character(character: char) -> bool {
    character.is_alphanumeric()
        || character == '_'
        || character == '-'
        || canonical_combining_class(character) != 0
}

fn is_tag_boundary_character(character: char) -> bool {
    is_tag_character(character) || character == '#' || character == '@'
}

fn derived_dates(text: &str) -> Vec<String> {
    text.split(|character: char| !character.is_ascii_digit() && character != '-')
        .filter(|token| valid_date(token))
        .map(str::to_owned)
        .collect()
}

fn valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let Ok(year) = value[0..4].parse::<u16>() else {
        return false;
    };
    let Ok(month) = value[5..7].parse::<u8>() else {
        return false;
    };
    let Ok(day) = value[8..10].parse::<u8>() else {
        return false;
    };
    if year == 0 {
        return false;
    }
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap_year => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days_in_month).contains(&day)
}

#[cfg(test)]
mod derived_data_tests {
    use super::{derived_dates, derived_tags};

    #[test]
    fn tags_support_unicode_combining_marks_and_punctuation_boundaries() {
        assert_eq!(
            derived_tags("Plan (#프로젝트), @Person_1 cafe#hidden #Cafe\u{301}"),
            vec![
                ("#프로젝트".into(), "#프로젝트".into()),
                ("@person_1".into(), "@Person_1".into()),
                ("#café".into(), "#Café".into()),
            ]
        );
    }

    #[test]
    fn dates_keep_only_valid_gregorian_iso_tokens() {
        assert_eq!(
            derived_dates("(2024-02-29), 2026-02-30 and 2026-07-28"),
            vec!["2024-02-29".to_owned(), "2026-07-28".to_owned()]
        );
    }
}
