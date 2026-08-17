use notes_application::StorageError;
use notes_core::SORT_KEY_STEP;
use rusqlite::{Connection, TransactionBehavior, params};

use crate::repository::internal;

const ONBOARDING_MARKER_KEY: &str = "onboarding_seeded";
/// Fixed ids rather than readable strings: every id the vault carries is a
/// `yid`, and the seed writes rows like any other producer. They are constants
/// so a reseeded database lands on the same ids it had before, and so a guide
/// fixture and a fresh vault always use the same block identity. Each one is
/// unique and satisfies the ordinary generation rule.
const ONBOARDING_PAGE_ID: &str = "Ft6Ts_1ENGI-";
const ONBOARDING_TITLE: &str = "Yonalist 시작하기";
const ONBOARDING_NOTE: &str = "이 노트는 자유롭게 수정하거나 삭제할 수 있어요.";
const ONBOARDING_CHILDREN: [(&str, &str); 6] = [
    ("6mm6r7xRjEDW", "Enter — 새 항목 만들기"),
    ("Pd95nKBRgcDZ", "Tab / Shift+Tab — 들여쓰기 / 내어쓰기"),
    ("36QisBAraYs_", "Shift+Enter — 설명 입력하기"),
    ("9TokmOff9ZnA", "⌘/Ctrl+Enter — 완료 표시"),
    ("6cX4eqi-JFFW", "↑/↓ — 항목 사이 이동"),
    ("UvmuQAYzzdQI", "불릿을 드래그해 순서와 계층 바꾸기"),
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
    // Home does not count. It is made when the database is, so counting it
    // would mean this only ever ran on a database with no root — which is to
    // say, never, now that the guide is written after the folder is chosen
    // rather than before the root row exists.
    let has_notes: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_nodes WHERE id <> ?1)",
            [crate::schema::ROOT_ID],
            |row| row.get(0),
        )
        .map_err(internal)?;
    if !seeded && !has_notes {
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
        // The stamping triggers call `yona_hlc()`, which is registered per
        // connection; a writer without one cannot insert a row.
        let clock = std::sync::Arc::new(notes_sync::hlc::Clock::new("c0de").expect("clock"));
        notes_sync::hlc::register(&connection, clock).expect("register");
        connection
    }

    fn seeded_ids(connection: &Connection) -> Vec<String> {
        connection
            .prepare("SELECT id FROM notes_nodes WHERE id <> 'root' ORDER BY id")
            .expect("prepare")
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows")
    }

    fn node_count(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row.get(0))
            .expect("count")
    }

    #[test]
    fn the_onboarding_seed_ids_are_fixed_and_canonical() {
        let ids = |connection: &mut Connection| {
            seed_onboarding(connection).expect("seed");
            seeded_ids(connection)
        };

        let first = ids(&mut open());
        assert_eq!(
            first,
            ids(&mut open()),
            "a reseeded database has to land on the ids it had before"
        );
        for id in &first {
            assert!(
                notes_core::is_yid(id),
                "the renderer only writes twelve-character block ids, got {id}"
            );
        }
    }

    #[test]
    fn the_onboarding_seed_uses_yids() {
        let mut connection = open();
        seed_onboarding(&mut connection).expect("seed");

        let ids = seeded_ids(&connection);
        assert_eq!(ids.len(), 7);
        assert_eq!(
            ids.iter().collect::<std::collections::BTreeSet<_>>().len(),
            ids.len(),
            "two seeded rows sharing an id would be one row after a merge"
        );
        for id in &ids {
            assert!(
                notes_core::is_yid(id),
                "the vault can only carry block ids, got {id}"
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
