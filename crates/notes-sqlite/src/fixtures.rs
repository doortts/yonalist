use notes_application::StorageError;
use notes_core::SORT_KEY_STEP;
use rusqlite::{Connection, TransactionBehavior, params};

use crate::repository::internal;
use crate::schema::ROOT_ID;

pub(crate) fn load_performance_fixture(
    connection: &mut Connection,
    node_count: usize,
) -> Result<(), StorageError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(internal)?;
    // The root row survives: `schema::ensure_root` created it at open and
    // `bootstrap` walks the outline down from it, so wiping it would leave the
    // fixture unreachable and the measurement empty.
    transaction
        .execute("DELETE FROM notes_nodes WHERE id <> ?1", [ROOT_ID])
        .map_err(internal)?;
    transaction
        .execute("DELETE FROM notes_ui_state", [])
        .map_err(internal)?;
    // A page is a root child, so the fixture page is a 'bullet' like any other.
    transaction
        .execute(
            "INSERT INTO notes_nodes(
                id, parent_id, sort_key, kind, text, completed, starred, deleted
             ) VALUES ('fixture-page', ?1, ?2, 'bullet', 'Performance fixture', 0, 0, 0)",
            params![ROOT_ID, SORT_KEY_STEP],
        )
        .map_err(internal)?;
    transaction
        .execute(
            "INSERT INTO notes_ui_state(key, value)
             VALUES ('active_page_id', 'fixture-page')",
            [],
        )
        .map_err(internal)?;
    for index in 0..node_count {
        let sort_key = i64::try_from(index + 1)
            .ok()
            .and_then(|ordinal| ordinal.checked_mul(SORT_KEY_STEP))
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
