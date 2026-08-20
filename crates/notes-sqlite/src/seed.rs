use notes_application::StorageError;
use notes_core::SORT_KEY_STEP;
use rusqlite::{Connection, TransactionBehavior, params};

use crate::repository::internal;

/// Whether the user has said where these notes live. Renamed from
/// `onboarding_seeded` because the meaning moved: it used to record that a guide
/// had been offered to this database, and it now records that the question the
/// first-run card asks has an answer. A rebuild deliberately keeps this one row
/// and clears the rest of `notes_ui_state` — the answer is still on disk, so
/// forgetting it would have the card ask a question it already holds the answer
/// to. That statement spells the key out (`sync_merge.rs`); a rename here has to
/// go there too, and `onboarding_seed.rs` fails if it does not.
const ONBOARDING_ANSWERED_KEY: &str = "onboarding_answered";
/// Written down rather than generated. Fixed is what makes a second seed a no-op
/// and what lets the guide fixture and a freshly seeded vault hold the same block
/// identities — generate them and the two would never agree again. Readable, too:
/// these are the one set of ids a person reads in a file they did not create, so
/// they say which guide line they are.
const ONBOARDING_PAGE_ID: &str = "GuideP000001";
const ONBOARDING_TITLE: &str = "Yonalist 시작하기";
const ONBOARDING_NOTE: &str = "이 노트는 자유롭게 수정하거나 삭제할 수 있어요.";
const ONBOARDING_CHILDREN: [(&str, &str); 6] = [
    ("GuideL000001", "Enter — 새 항목 만들기"),
    ("GuideL000002", "Tab / Shift+Tab — 들여쓰기 / 내어쓰기"),
    ("GuideL000003", "Shift+Enter — 설명 입력하기"),
    ("GuideL000004", "⌘/Ctrl+Enter — 완료 표시"),
    ("GuideL000005", "↑/↓ — 항목 사이 이동"),
    ("GuideL000006", "불릿을 드래그해 순서와 계층 바꾸기"),
];

/// Seeds the first-run onboarding page exactly once per database. Existing
/// workspaces only receive the marker so their content is never touched.
pub(crate) fn seed_onboarding(connection: &mut Connection) -> Result<(), StorageError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(internal)?;
    let answered: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_ui_state WHERE key = ?1)",
            [ONBOARDING_ANSWERED_KEY],
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
    if !answered && !has_notes {
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
    // Answering "Later" is an answer too — these notes start here — so the
    // question is settled either way.
    transaction
        .execute(
            "INSERT OR IGNORE INTO notes_ui_state(key, value) VALUES (?1, '1')",
            [ONBOARDING_ANSWERED_KEY],
        )
        .map_err(internal)?;
    transaction.commit().map_err(internal)
}

/// Records that the user has said where these notes live, without writing a
/// guide. Called when a folder is chosen: that is the answer the first-run card
/// exists to get, and a device joining a folder that already holds notes is
/// given no guide — so leaving the mark to the guide left that device asked
/// again on every launch.
pub(crate) fn mark_onboarding_answered(connection: &Connection) -> Result<(), StorageError> {
    connection
        .execute(
            "INSERT OR IGNORE INTO notes_ui_state(key, value) VALUES (?1, '1')",
            [ONBOARDING_ANSWERED_KEY],
        )
        .map(|_| ())
        .map_err(internal)
}

/// Whether this is a first run: the user has not said yet where these notes
/// live. One value in this database, and nothing else — not the recorded folder,
/// which a data reset clears and a rebuild keeps, and not the window's own
/// storage, which survives every reset the app can do.
pub(crate) fn onboarding_first_run(connection: &Connection) -> Result<bool, StorageError> {
    connection
        .query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM notes_ui_state WHERE key = ?1)",
            [ONBOARDING_ANSWERED_KEY],
            |row| row.get(0),
        )
        .map_err(internal)
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
        let clock = std::sync::Arc::new(notes_sync::hlc::Clock::new("c0dec0de").expect("clock"));
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

    /// Two claims, and the second one is what changed. Reseeding still has to land
    /// on the ids it had before, and each id still has to be a shape the vault can
    /// carry — but that shape used to be a lowercase hyphenated UUID and is a
    /// `yid` now, so the check is `is_yid` rather than a spelling comparison.
    #[test]
    fn the_onboarding_seed_ids_are_fixed_and_the_vault_can_carry_them() {
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
                "the renderer only writes ids of this shape, got {id}"
            );
        }
    }

    #[test]
    fn the_onboarding_seed_uses_block_ids() {
        let mut connection = open();
        seed_onboarding(&mut connection).expect("seed");

        let ids = seeded_ids(&connection);
        assert_eq!(ids.len(), 7);
        for id in &ids {
            assert!(
                notes_core::is_block_id(id),
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
