use std::collections::BTreeSet;

use notes_application::{StorageCommit, StorageError};
use notes_core::{DomainError, DomainPatch, NodeId, NoteNode, NoteNodeKind, TreeMutation};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
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
                remove_node(&transaction, id.as_str())?;
            }
        }
    }
    // After the loop, because the copy's own node row has to exist first. Read
    // from the source as it stands right now rather than from anything the
    // duplication remembered: if the bytes landed in between — an undo, the
    // picture arriving, then a redo — the copy is handed a picture that is
    // already settled instead of a wait that would never end.
    for (source_id, copy_id) in &patch.carried_pictures {
        transaction
            .execute(
                "INSERT INTO notes_images(
                    node_id, content_hash, relative_path, original_name, mime_type,
                    byte_length, pixel_width, pixel_height, display_width
                 )
                 SELECT ?2, content_hash, relative_path, original_name, mime_type,
                    byte_length, pixel_width, pixel_height, display_width
                 FROM notes_images WHERE node_id = ?1
                 -- Running after the forward loop and yielding to what is
                 -- already there is what lets a coalesced group keep a settled
                 -- row its own mutations wrote for the copy.
                 ON CONFLICT(node_id) DO NOTHING",
                [source_id.as_str(), copy_id.as_str()],
            )
            .map_err(internal)?;
    }
    // After the whole patch: a row's path reads its ancestors, which an earlier
    // mutation in this same loop may not have written yet.
    crate::node_paths::refresh(&transaction, patch)?;
    // A move made here has to leave a claim behind. The merge rebuilds sibling
    // order from those claims, so without one it would put the node back where
    // the last merge had it — undoing the move on screen.
    record_place_claims(&transaction, patch)?;
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
        // An image node without a picture is one whose bytes have not landed
        // yet, and the row is where everything the file said about that
        // picture is being kept until they do. Only a node that stopped being
        // a picture has a row to clear.
        if node.kind() != NoteNodeKind::Image {
            transaction
                .execute(
                    "DELETE FROM notes_images WHERE node_id = ?1",
                    [node.id().as_str()],
                )
                .map_err(internal)?;
        }
        return Ok(());
    };
    let byte_length = i64::try_from(image.byte_length())
        .map_err(|_| StorageError::Internal("image byte length exceeded SQLite INTEGER".into()))?;
    let values = params![
        node.id().as_str(),
        image.content_hash(),
        image.relative_path(),
        image.original_name(),
        image.mime_type(),
        byte_length,
        image.pixel_width(),
        image.pixel_height(),
        image.display_width(),
    ];
    // Update first, and only where something actually differs, so the answer
    // says whether this was an edit. An upsert cannot say: it reports a row
    // written either way, and a picture resized to the width it already had
    // would then be stamped as an edit it never was.
    let edited = transaction
        .execute(
            "UPDATE notes_images SET
                content_hash = ?2,
                relative_path = ?3,
                original_name = ?4,
                mime_type = ?5,
                byte_length = ?6,
                pixel_width = ?7,
                pixel_height = ?8,
                display_width = ?9
             WHERE node_id = ?1 AND (
                    content_hash IS NOT ?2
                 OR relative_path IS NOT ?3
                 OR original_name IS NOT ?4
                 OR mime_type IS NOT ?5
                 OR byte_length IS NOT ?6
                 OR pixel_width IS NOT ?7
                 OR pixel_height IS NOT ?8
                 OR display_width IS NOT ?9
             )",
            values,
        )
        .map_err(internal)?;
    if edited == 0 {
        // Either there was no row, or there was nothing to change. A row that
        // arrives here for the first time belongs to a node that was just
        // written too, and that write did the stamping.
        transaction
            .execute(
                "INSERT INTO notes_images(
                    node_id, content_hash, relative_path, original_name, mime_type,
                    byte_length, pixel_width, pixel_height, display_width
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(node_id) DO NOTHING",
                values,
            )
            .map_err(internal)?;
        return Ok(());
    }
    stamp_for_its_picture(transaction, node.id().as_str())
}

/// What a picture's own columns say is part of the note, but none of it lives
/// on the node's row, so the stamping trigger there never sees it. Without
/// this a resize is invisible to the folder: nothing is owed a write, the
/// file keeps stating the old size, and the next read of that file meets a
/// node whose stamp has not moved — an equal-stamp comparison the stale line
/// can win, undoing the resize on the device that made it.
///
/// Deliberately here and not in a trigger on `notes_images`: a merge writes
/// that table too, carrying another device's reading, and a trigger could not
/// tell the two apart. This runs only on the path a command takes.
fn stamp_for_its_picture(
    transaction: &rusqlite::Transaction<'_>,
    node_id: &str,
) -> Result<(), StorageError> {
    transaction
        .execute(
            "UPDATE notes_nodes SET hlc = yona_hlc() WHERE id = ?1",
            [node_id],
        )
        .map_err(internal)?;
    transaction
        .execute(
            // The node, and the file that states its line — the same two the
            // stamping trigger marks when a node's own column changes.
            "INSERT INTO sync_dirty_nodes(node_id, marked_at)
             SELECT id, unixepoch() FROM (
                 SELECT ?1 AS id
                 UNION
                 SELECT parent_id FROM notes_nodes WHERE id = ?1
             ) WHERE id IS NOT NULL
             ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
            [node_id],
        )
        .map_err(internal)?;
    Ok(())
}

/// Taking a row off the page, which is two different writes depending on
/// whether anything outside this device has ever heard of it.
///
/// A row the vault has stated cannot simply vanish. A file says which lines a
/// document holds and nothing about the ones it does not mention, so a device
/// still holding its own copy reads the shorter file as a truncation and writes
/// the line straight back — the row returns minutes later under a caret that has
/// moved on. The trash is where this format states a deletion, so a row that has
/// been out there is trashed: the stamping trigger gives it a reading of its own,
/// which beats the copy every other device holds.
///
/// A row that has never left this device has nothing to state. Trashing it would
/// fill the trash — and `trash.md`, which every device reads — with the blank
/// lines a person opens and closes while typing.
fn remove_node(transaction: &rusqlite::Transaction<'_>, id: &str) -> Result<(), StorageError> {
    let stated = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_node_exports WHERE node_id = ?1)",
            [id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(internal)?;
    if stated {
        transaction
            .execute("UPDATE notes_nodes SET deleted = 1 WHERE id = ?1", [id])
            .map_err(internal)?;
        // The window that draws a page has no `deleted` predicate — a trashed
        // branch leaves it by carrying no path — so a row that kept its path
        // would still be on the page, which is the one thing the gesture was
        // asked to change.
        crate::node_paths::rebuild(transaction, id)?;
        return Ok(());
    }
    transaction
        .execute("DELETE FROM notes_nodes WHERE id = ?1", [id])
        .map_err(internal)?;
    Ok(())
}

fn insert_node(
    transaction: &rusqlite::Transaction<'_>,
    node: &NoteNode,
) -> Result<(), StorageError> {
    let standing: Option<bool> = transaction
        .query_row(
            "SELECT deleted FROM notes_nodes WHERE id = ?1",
            [node.id().as_str()],
            |row| row.get::<_, i64>(0).map(|deleted| deleted == 1),
        )
        .optional()
        .map_err(internal)?;
    match standing {
        // Undoing a removal that `remove_node` stated in the trash. The row it
        // left is this row, waiting to be told it is back — inserting over it
        // would refuse an undo the person is entitled to.
        Some(true) => return update_node(transaction, node),
        Some(false) => {
            return Err(StorageError::Domain(DomainError::DuplicateNode(
                node.id().clone(),
            )));
        }
        None => {}
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

/// Records where a node now sits, for the rows this patch actually moved and
/// for the siblings its move re-linked.
///
/// Only those: a text edit leaves a node exactly where it was, and writing its
/// claim anyway would stamp it with the fresh reading the trigger just issued.
/// That promoted claim would then beat a move another device made a moment
/// earlier — and win everywhere, which is the one thing a claim's own stamp
/// exists to prevent.
fn record_place_claims(
    transaction: &rusqlite::Transaction<'_>,
    patch: &DomainPatch,
) -> Result<(), StorageError> {
    let previous: std::collections::BTreeMap<_, _> = patch
        .inverse
        .iter()
        .filter_map(|mutation| match mutation {
            TreeMutation::Upsert(node) => Some((node.id().as_str().to_owned(), node.as_ref())),
            TreeMutation::Delete { .. } => None,
        })
        .collect();
    // Where a node used to sit, so the sibling it is leaving behind is re-linked
    // too. Rule 9 of the merge design: a move touches three rows, not a family.
    let mut parents: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut moved: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    // The ones that changed *where they are*, as opposed to merely what number
    // they hold. Making room for a new line renumbers its neighbours, and a
    // neighbour that still follows whoever it followed has not moved — taking
    // the new reading there would beat somebody else's real move.
    let mut relocated: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for mutation in &patch.forward {
        match mutation {
            TreeMutation::Upsert(node) => {
                let id = node.id().as_str().to_owned();
                let before = previous.get(&id);
                let changed_place = before.is_none_or(|before| {
                    before.parent_id() != node.parent_id()
                        || before.sort_key() != node.sort_key()
                        || before.is_deleted() != node.is_deleted()
                });
                if !changed_place {
                    continue;
                }
                if before.is_none_or(|before| {
                    before.parent_id() != node.parent_id()
                        || before.is_deleted() != node.is_deleted()
                }) {
                    relocated.insert(id.clone());
                }
                moved.insert(id);
                if let Some(parent) = node.parent_id() {
                    parents.insert(parent.as_str().to_owned());
                }
                if let Some(parent) = before.and_then(|before| before.parent_id()) {
                    parents.insert(parent.as_str().to_owned());
                }
            }
            TreeMutation::Delete { id } => {
                moved.insert(id.as_str().to_owned());
                relocated.insert(id.as_str().to_owned());
                if let Some(parent) = previous
                    .get(id.as_str())
                    .and_then(|before| before.parent_id())
                {
                    parents.insert(parent.as_str().to_owned());
                }
            }
        }
    }
    if moved.is_empty() {
        return Ok(());
    }
    // The stamp a move states its claim at is the one the trigger just gave the
    // row that moved. Its followers claim at the same reading: they were
    // re-linked by that move, not by anything of their own.
    let at: String = transaction
        .query_row(
            "SELECT max(hlc) FROM notes_nodes WHERE id IN (SELECT value FROM json_each(?1))",
            [notes_sync::export::json_list(
                &moved.iter().cloned().collect::<Vec<_>>(),
            )],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(internal)?
        .unwrap_or_default();
    if at.is_empty() {
        return Ok(());
    }
    let relocated_list =
        notes_sync::export::json_list(&relocated.iter().cloned().collect::<Vec<_>>());
    for parent in parents {
        transaction
            .execute(
                // Only the rows whose claim actually changed — which for one
                // move is the row itself and whoever now follows it, not every
                // sibling it happens to have. Writing them all made an append
                // cost the length of the page, twice over: once for the write
                // and once for the lookup inside it.
                "WITH ordered AS (
                     SELECT id, coalesce(lag(id) OVER (ORDER BY sort_key, id), '') AS previous
                     FROM notes_nodes
                     WHERE parent_id = ?1 AND deleted = 0
                 )
                 UPDATE notes_nodes SET
                     sync_prev = ordered.previous,
                     sync_prev_hlc = ?2
                 FROM ordered
                 WHERE notes_nodes.id = ordered.id
                   AND (notes_nodes.sync_prev IS NOT ordered.previous
                        -- A node that moved to the front of another page
                        -- follows nobody in both places, so what it claims
                        -- does not change — but when it claims it has to, or
                        -- an older reorder somewhere else beats this move.
                        -- Only rows that changed parent, though: a renumbered
                        -- neighbour has not moved.
                        OR notes_nodes.id IN (SELECT value FROM json_each(?3)))",
                rusqlite::params![parent, at, &relocated_list],
            )
            .map_err(internal)?;
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

pub(crate) fn valid_date(value: &str) -> bool {
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
