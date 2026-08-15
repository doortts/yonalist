use notes_application::StorageError;
use notes_core::SORT_KEY_STEP;
use rusqlite::{Connection, TransactionBehavior, params};

use crate::repository::internal;

const ONBOARDING_MARKER_KEY: &str = "onboarding_seeded";
/// Fixed uuids rather than readable strings: every id the vault carries is a
/// uuid, and the seed writes rows like any other producer. They are constants
/// so a reseeded database lands on the same ids it had before.
const ONBOARDING_PAGE_ID: &str = "f4556d3d-868c-5fab-914a-614c84331c53";
const ONBOARDING_TITLE: &str = "Yonalist 시작하기";
const ONBOARDING_NOTE: &str = "이 노트는 자유롭게 수정하거나 삭제할 수 있어요.";
const ONBOARDING_CHILDREN: [(&str, &str); 6] = [
    (
        "5c64635d-db37-5efc-b331-fd3687acbd5d",
        "Enter — 새 항목 만들기",
    ),
    (
        "a18820a4-633c-5bd2-abcf-91a98b9f775c",
        "Tab / Shift+Tab — 들여쓰기 / 내어쓰기",
    ),
    (
        "89c02706-d65d-5691-a17c-397339acdeff",
        "Shift+Enter — 설명 입력하기",
    ),
    (
        "5915228f-fbc6-5d8d-8206-e0eab04009f1",
        "⌘/Ctrl+Enter — 완료 표시",
    ),
    (
        "36c840c3-4964-5ea8-8a1e-2e94880821eb",
        "↑/↓ — 항목 사이 이동",
    ),
    (
        "8b425319-cfc2-5dac-b7a1-553473556311",
        "불릿을 드래그해 순서와 계층 바꾸기",
    ),
];

/// Seeds the first-run onboarding page exactly once per database. Existing
/// workspaces only receive the marker so their content is never touched.
pub(crate) fn seed_onboarding(connection: &mut Connection) -> Result<(), StorageError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(internal)?;
    let seeded: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_ui_state WHERE key = ?1)",
            [ONBOARDING_MARKER_KEY],
            |row| row.get(0),
        )
        .map_err(internal)?;
    let has_nodes: bool = transaction
        .query_row("SELECT EXISTS(SELECT 1 FROM notes_nodes)", [], |row| {
            row.get(0)
        })
        .map_err(internal)?;
    if !seeded && !has_nodes {
        transaction
            .execute(
                "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, note)
                 VALUES (?1, NULL, ?2, 'page', ?3, ?4)",
                params![
                    ONBOARDING_PAGE_ID,
                    SORT_KEY_STEP,
                    ONBOARDING_TITLE,
                    ONBOARDING_NOTE
                ],
            )
            .map_err(internal)?;
        for (index, (child_id, title)) in ONBOARDING_CHILDREN.iter().enumerate() {
            let ordinal = i64::try_from(index + 1)
                .map_err(|_| StorageError::Internal("onboarding ordinal overflowed".into()))?;
            transaction
                .execute(
                    "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text)
                     VALUES (?1, ?2, ?3, 'bullet', ?4)",
                    params![child_id, ONBOARDING_PAGE_ID, ordinal * SORT_KEY_STEP, title],
                )
                .map_err(internal)?;
        }
    }
    transaction
        .execute(
            "INSERT OR IGNORE INTO notes_ui_state(key, value) VALUES (?1, '1')",
            [ONBOARDING_MARKER_KEY],
        )
        .map_err(internal)?;
    transaction.commit().map_err(internal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    fn open() -> Connection {
        let mut connection = Connection::open_in_memory().expect("in-memory db");
        schema::initialize(&mut connection).expect("schema");
        connection
    }

    fn node_count(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row.get(0))
            .expect("count")
    }

    #[test]
    fn the_onboarding_seed_uses_uuids() {
        let mut connection = open();
        seed_onboarding(&mut connection).expect("seed");

        let ids: Vec<String> = connection
            .prepare("SELECT id FROM notes_nodes WHERE id <> 'root' ORDER BY id")
            .expect("prepare")
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows");
        assert_eq!(ids.len(), 7);
        for id in &ids {
            assert!(
                uuid::Uuid::try_parse(id).is_ok(),
                "the vault can only carry uuid ids, got {id}"
            );
        }
    }

    #[test]
    fn seeds_the_onboarding_page_once_into_an_empty_database() {
        let mut connection = open();
        seed_onboarding(&mut connection).expect("seed");

        assert_eq!(node_count(&connection), 7);
        let (title, note): (String, String) = connection
            .query_row(
                "SELECT text, note FROM notes_nodes WHERE kind = 'page'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("page");
        assert_eq!(title, ONBOARDING_TITLE);
        assert_eq!(note, ONBOARDING_NOTE);

        seed_onboarding(&mut connection).expect("reseed");
        assert_eq!(node_count(&connection), 7);
    }

    #[test]
    fn leaves_an_existing_workspace_untouched_even_without_a_marker() {
        let mut connection = open();
        connection
            .execute(
                "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text)
                 VALUES ('existing', NULL, 1024, 'page', 'Mine')",
                [],
            )
            .expect("existing page");

        seed_onboarding(&mut connection).expect("seed");
        assert_eq!(node_count(&connection), 1);

        connection
            .execute("DELETE FROM notes_nodes", [])
            .expect("clear");
        seed_onboarding(&mut connection).expect("seed after clear");
        assert_eq!(node_count(&connection), 0);
    }
}
