use crate::notes::types::{
    validate_note_id, ImageAtomOperationLookup, ImageAtomOperationReceiptResult,
};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;

const MAX_HISTORY_EPOCH_BYTES: usize = 128;
const MAX_RECEIPT_RESULT_BYTES: usize = 32 * 1024;
const MAX_RECEIPT_AFFECTED_ROOT_IDS: usize = 128;
const MAX_SAFE_UTF16_OFFSET: i64 = 9_007_199_254_740_991;

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
    use super::{ack_operation_receipt, lookup_operation_receipt, record_operation_receipt};
    use crate::notes::history::history_epoch;
    use crate::notes::repository::connect_notes_db;
    use crate::notes::types::{
        ImageAtomFocusResult, ImageAtomOperationLookup, ImageAtomOperationReceiptResult,
    };
    use rusqlite::params;

    const SESSION_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const FOREIGN_SESSION_ID: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const OPERATION_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const SECOND_OPERATION_ID: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const NODE_ID: &str = "11111111-1111-4111-8111-111111111111";

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
