use notes_application::StorageError;
use rusqlite::{Connection, TransactionBehavior, params};

use crate::repository::internal;

pub(crate) fn load_performance_fixture(
    connection: &mut Connection,
    node_count: usize,
) -> Result<(), StorageError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(internal)?;
    transaction
        .execute("DELETE FROM notes_nodes", [])
        .map_err(internal)?;
    transaction
        .execute("DELETE FROM notes_ui_state", [])
        .map_err(internal)?;
    transaction
        .execute(
            "INSERT INTO notes_nodes(
                id, parent_id, sort_key, kind, text, completed, starred, deleted
             ) VALUES ('fixture-page', NULL, 1024, 'page', 'Performance fixture', 0, 0, 0)",
            [],
        )
        .map_err(internal)?;
    for index in 0..node_count {
        let sort_key = i64::try_from(index + 1)
            .ok()
            .and_then(|ordinal| ordinal.checked_mul(1_024))
            .ok_or_else(|| StorageError::Internal("fixture sort key overflowed".into()))?;
        let text = if index % 100 == 0 {
            format!("Fixture node {index} #benchmark 2026-07-27")
        } else {
            format!("Fixture node {index}")
        };
        transaction
            .execute(
                "INSERT INTO notes_nodes(
                    id, parent_id, sort_key, kind, text, completed, starred, deleted
                 ) VALUES (?1, 'fixture-page', ?2, 'bullet', ?3, 0, 0, 0)",
                params![format!("fixture-{index}"), sort_key, text],
            )
            .map_err(internal)?;
    }
    transaction
        .execute("UPDATE notes_meta SET revision = 1 WHERE singleton = 1", [])
        .map_err(internal)?;
    transaction.commit().map_err(internal)
}
