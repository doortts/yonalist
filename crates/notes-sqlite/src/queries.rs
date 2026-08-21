use notes_application::{
    BootSnapshot, HistoryState, NoteView, PageSummary, SearchHit, SearchPage, SearchQuery,
    StorageError, ViewportPage, ViewportRequest,
};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};

use crate::mutations::valid_date;
use crate::repository;
use crate::schema::ROOT_ID;

const MAX_VIEWPORT_LIMIT: u32 = 200;
const MAX_SEARCH_LIMIT: u32 = 100;

/// The rows under page `?1` are the ones whose stored path extends the page's
/// own path by a separator, and '0' is the byte after '/', so the pair is a
/// half-open range the path index seeks straight to. The page's own row sorts
/// below it, and a trashed branch carries a NULL path no comparison can be true
/// for, which is what leaves the window with no `deleted` predicate to run.
///
/// `viewport` and `anchor_offset` are the same ordering read two ways; they
/// share this text so a window and a jump into it cannot bound differently.
const PAGE_RANGE: &str = "body.path >= (SELECT path FROM notes_nodes WHERE id = ?1) || '/'
     AND body.path < (SELECT path FROM notes_nodes WHERE id = ?1) || '0'";

/// `?1` page, `?2` row count, `?3` offset.
fn window_sql() -> String {
    format!(
        "SELECT node.*
         FROM notes_nodes body
         JOIN notes_node_records node ON node.id = body.id
         WHERE {PAGE_RANGE}
         ORDER BY body.path
         LIMIT ?2 OFFSET ?3"
    )
}

/// `?1` page, `?2` anchor. The range leaves the page's own row out, so the
/// first row it carries is offset zero.
fn anchor_sql() -> String {
    format!(
        "WITH ordered AS (
            SELECT body.id, row_number() OVER (ORDER BY body.path) - 1 AS offset
            FROM notes_nodes body
            WHERE {PAGE_RANGE}
         )
         SELECT offset FROM ordered WHERE id = ?2"
    )
}

/// A page is a live child of the root, or of the Journals node -- a journal day
/// hangs from that rather than from the root, and it is still the page its date
/// names. This asks the parent index rather than reading the root's window:
/// that window carries the whole forest depth first and stops at a row limit,
/// so a page with enough children of its own would push the pages after it out
/// of the answer.
pub(crate) fn pages(connection: &Connection) -> Result<Vec<PageSummary>, StorageError> {
    let mut statement = connection
        .prepare(
            "SELECT id, text, sort_key
             FROM notes_nodes
             WHERE parent_id IN (?1, ?2) AND deleted = 0
             ORDER BY sort_key, id",
        )
        .map_err(internal)?;
    let pages = statement
        .query_map([ROOT_ID, notes_core::JOURNALS_ID], |row| {
            Ok(PageSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                sort_key: row.get(2)?,
            })
        })
        .map_err(internal)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;
    Ok(pages)
}

pub(crate) fn bootstrap(
    connection: &Connection,
    session_id: String,
    viewport_limit: u32,
) -> Result<BootSnapshot, StorageError> {
    let revision = repository::revision(connection)?;
    let pages = pages(connection)?;
    let preferred_page = active_page(connection)?;
    // Home is a page like any other, so it is both the fallback and a legal
    // stored value; anything else has to still name a live page.
    let active_page_id = preferred_page
        .filter(|preferred| preferred == ROOT_ID || pages.iter().any(|page| page.id == *preferred))
        .or_else(|| Some(ROOT_ID.to_owned()));
    let viewport = active_page_id
        .as_ref()
        .map(|page_id| {
            viewport(
                connection,
                ViewportRequest {
                    page_id: page_id.clone(),
                    anchor_id: None,
                    before_cursor: None,
                    after_cursor: None,
                    limit: viewport_limit,
                },
            )
        })
        .transpose()?;
    Ok(BootSnapshot {
        session_id,
        revision,
        active_page_id,
        pages,
        viewport,
        history: HistoryState {
            can_undo: false,
            can_redo: false,
            undo_depth: 0,
            redo_depth: 0,
        },
    })
}

pub(crate) fn viewport(
    connection: &Connection,
    request: ViewportRequest,
) -> Result<ViewportPage, StorageError> {
    if request.before_cursor.is_some() && request.after_cursor.is_some() {
        return Err(StorageError::Internal(
            "a viewport request cannot use both cursors".into(),
        ));
    }
    let revision = repository::revision(connection)?;
    let limit = request.limit.clamp(1, MAX_VIEWPORT_LIMIT) as usize;
    let offset = if let Some(cursor) = request.after_cursor.as_deref() {
        parse_cursor(cursor, revision)?
    } else if let Some(cursor) = request.before_cursor.as_deref() {
        parse_cursor(cursor, revision)?.saturating_sub(limit)
    } else if let Some(anchor_id) = request.anchor_id.as_deref() {
        anchor_offset(connection, &request.page_id, anchor_id)?
            .saturating_sub(limit.saturating_div(2))
    } else {
        0
    };
    let mut statement = connection.prepare(&window_sql()).map_err(internal)?;
    let rows = statement
        .query_map(
            params![
                request.page_id,
                i64::from(request.limit.clamp(1, MAX_VIEWPORT_LIMIT)) + 1,
                i64::try_from(offset).map_err(|_| {
                    StorageError::Internal("viewport offset exceeded SQLite INTEGER".into())
                })?
            ],
            repository::parse_node,
        )
        .map_err(internal)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;
    let has_more = rows.len() > limit;
    let nodes = rows
        .into_iter()
        .take(limit)
        .map(NoteView::from)
        .collect::<Vec<_>>();
    let consumed = offset + nodes.len();
    // Scrolling is a stream of viewport calls on one page, and every write
    // queues a transaction behind the single database worker; the read keeps
    // the restart-restore guarantee without paying for it per scroll step.
    if active_page(connection)?.as_deref() != Some(request.page_id.as_str()) {
        connection
            .execute(
                "INSERT INTO notes_ui_state(key, value)
                 VALUES ('active_page_id', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [&request.page_id],
            )
            .map_err(internal)?;
    }
    let page_node = repository::node(connection, &request.page_id)?
        .map(NoteView::from)
        .filter(|node| !node.deleted);
    Ok(ViewportPage {
        page_id: request.page_id,
        anchor_id: request.anchor_id,
        before_cursor: (offset > 0).then(|| cursor(revision, offset)),
        after_cursor: has_more.then(|| cursor(revision, consumed)),
        page_node,
        nodes,
    })
}

pub(crate) fn search(
    connection: &Connection,
    request: SearchQuery,
) -> Result<SearchPage, StorageError> {
    let text = request.text.trim();
    if text.is_empty() {
        return Ok(SearchPage {
            hits: Vec::new(),
            next_cursor: None,
        });
    }
    let revision = repository::revision(connection)?;
    let offset = request
        .cursor
        .as_deref()
        .map(|cursor| parse_cursor(cursor, revision))
        .transpose()?
        .unwrap_or(0);
    let limit = request.limit.clamp(1, MAX_SEARCH_LIMIT) as usize;
    let normalized = text.to_ascii_lowercase();
    let filter = if normalized == "is:starred" {
        Some((
            "node.starred = ?4 AND node.deleted = 0",
            vec![Value::Integer(1)],
        ))
    } else if normalized == "is:trash" {
        Some(("node.deleted = ?4", vec![Value::Integer(1)]))
    } else if normalized == "is:tagged" {
        Some((
            "?4 = 1 AND EXISTS (
                SELECT 1 FROM notes_tags WHERE notes_tags.node_id = node.id
             ) AND node.deleted = 0",
            vec![Value::Integer(1)],
        ))
    } else if let Some(tag) = text.strip_prefix("tag:").filter(|tag| !tag.is_empty()) {
        Some((
            "EXISTS (
                SELECT 1 FROM notes_tags
                WHERE notes_tags.node_id = node.id AND notes_tags.token = ?4
             ) AND node.deleted = 0",
            vec![Value::Text(tag.to_lowercase())],
        ))
    } else if let Some((from, to)) = text.strip_prefix("date:").and_then(date_range) {
        Some((
            "EXISTS (
                SELECT 1 FROM notes_dates
                WHERE notes_dates.node_id = node.id
                  AND notes_dates.date_key BETWEEN ?4 AND ?5
             ) AND node.deleted = 0",
            vec![Value::Text(from), Value::Text(to)],
        ))
    } else {
        text.strip_prefix("date:")
            .filter(|date| !date.is_empty())
            .map(|date| {
                (
                    "EXISTS (
                        SELECT 1 FROM notes_dates
                        WHERE notes_dates.node_id = node.id AND notes_dates.date_key = ?4
                     ) AND node.deleted = 0",
                    vec![Value::Text(date.to_owned())],
                )
            })
    };
    if let Some((clause, values)) = filter {
        return filtered_search(
            connection,
            clause,
            values,
            revision,
            offset,
            limit,
            request.limit,
        );
    }
    let expression = format!("\"{}\"", text.replace('"', "\"\""));
    let mut statement = connection
        .prepare(
            "SELECT node.*,
                    (
                        WITH RECURSIVE ancestors(id, parent_id) AS (
                            SELECT node.id, node.parent_id
                            UNION ALL
                            SELECT parent.id, parent.parent_id
                            FROM notes_nodes parent
                            JOIN ancestors child ON child.parent_id = parent.id
                        )
                        SELECT id FROM ancestors WHERE parent_id = ?4 LIMIT 1
                    ) AS page_id,
                    snippet(notes_fts, -1, '', '', '…', 12)
             FROM notes_fts
             JOIN notes_node_records node ON node.id = notes_fts.node_id
             WHERE notes_fts MATCH ?1 AND node.deleted = 0 AND node.id <> ?4
             ORDER BY rank, node.id
             LIMIT ?2 OFFSET ?3",
        )
        .map_err(internal)?;
    let rows = statement
        .query_map(
            params![
                expression,
                i64::from(request.limit.clamp(1, MAX_SEARCH_LIMIT)) + 1,
                i64::try_from(offset).map_err(|_| {
                    StorageError::Internal("search offset exceeded SQLite INTEGER".into())
                })?,
                ROOT_ID
            ],
            |row| {
                Ok(SearchHit {
                    node: repository::parse_node(row)?.into(),
                    page_id: row.get(20)?,
                    snippet: row.get(21)?,
                })
            },
        )
        .map_err(internal)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;
    let has_more = rows.len() > limit;
    let hits = rows.into_iter().take(limit).collect::<Vec<_>>();
    let consumed = offset + hits.len();
    Ok(SearchPage {
        hits,
        next_cursor: has_more.then(|| cursor(revision, consumed)),
    })
}

/// The two ends of `date:2026-08-01..2026-08-07`, or nothing. Both ends have to
/// be real dates: a half-written range is a search for text that happens to
/// start with `date:`, and answering it with every row in a month would be a
/// worse answer than none.
fn date_range(value: &str) -> Option<(String, String)> {
    let (from, to) = value.split_once("..")?;
    if !valid_date(from) || !valid_date(to) {
        return None;
    }
    // Written back to front is still a range with two ends. Reading it as
    // written would answer with nothing at all, which reads as "no rows in
    // those days" rather than "you typed it backwards".
    Some(if from <= to {
        (from.to_owned(), to.to_owned())
    } else {
        (to.to_owned(), from.to_owned())
    })
}

#[allow(clippy::too_many_arguments)]
fn filtered_search(
    connection: &Connection,
    clause: &str,
    values: Vec<Value>,
    revision: u64,
    offset: usize,
    limit: usize,
    requested_limit: u32,
) -> Result<SearchPage, StorageError> {
    let sql = format!(
        "SELECT node.*,
                (
                    WITH RECURSIVE ancestors(id, parent_id) AS (
                        SELECT node.id, node.parent_id
                        UNION ALL
                        SELECT parent.id, parent.parent_id
                        FROM notes_nodes parent
                        JOIN ancestors child ON child.parent_id = parent.id
                    )
                    SELECT id FROM ancestors WHERE parent_id = ?3 LIMIT 1
                ) AS page_id,
                CASE
                    WHEN node.note = '' THEN node.text
                    ELSE node.text || ' ' || node.note
                END
         FROM notes_node_records node
         WHERE ({clause}) AND node.id <> ?3
         ORDER BY node.sort_key, node.id
         LIMIT ?1 OFFSET ?2"
    );
    let mut statement = connection.prepare(&sql).map_err(internal)?;
    let mut binds =
        vec![
            Value::Integer(i64::from(requested_limit.clamp(1, MAX_SEARCH_LIMIT)) + 1),
            Value::Integer(i64::try_from(offset).map_err(|_| {
                StorageError::Internal("search offset exceeded SQLite INTEGER".into())
            })?),
            Value::Text(ROOT_ID.to_owned()),
        ];
    binds.extend(values);
    let rows = statement
        .query_map(params_from_iter(binds), |row| {
            Ok(SearchHit {
                node: repository::parse_node(row)?.into(),
                page_id: row.get(20)?,
                snippet: row.get(21)?,
            })
        })
        .map_err(internal)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;
    let has_more = rows.len() > limit;
    let hits = rows.into_iter().take(limit).collect::<Vec<_>>();
    let consumed = offset + hits.len();
    Ok(SearchPage {
        hits,
        next_cursor: has_more.then(|| cursor(revision, consumed)),
    })
}

fn anchor_offset(
    connection: &Connection,
    page_id: &str,
    anchor_id: &str,
) -> Result<usize, StorageError> {
    let offset = connection
        .query_row(&anchor_sql(), params![page_id, anchor_id], |row| {
            row.get::<_, i64>(0)
        })
        .optional()
        .map_err(internal)?
        .ok_or_else(|| StorageError::Internal("viewport anchor was not found".into()))?;
    usize::try_from(offset)
        .map_err(|_| StorageError::Internal("viewport anchor offset was invalid".into()))
}

fn active_page(connection: &Connection) -> Result<Option<String>, StorageError> {
    connection
        .query_row(
            "SELECT value FROM notes_ui_state WHERE key = 'active_page_id'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(internal)
}

fn cursor(revision: u64, offset: usize) -> String {
    format!("r:{revision}:o:{offset}")
}

fn parse_cursor(value: &str, actual_revision: u64) -> Result<usize, StorageError> {
    let mut parts = value.split(':');
    let parsed = match (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) {
        (Some("r"), Some(revision), Some("o"), Some(offset), None) => {
            Some((revision.parse::<u64>(), offset.parse::<usize>()))
        }
        _ => None,
    }
    .ok_or_else(|| StorageError::Internal("viewport cursor is malformed".into()))?;
    let revision = parsed
        .0
        .map_err(|_| StorageError::Internal("cursor revision is invalid".into()))?;
    let offset = parsed
        .1
        .map_err(|_| StorageError::Internal("cursor offset is invalid".into()))?;
    if revision != actual_revision {
        return Err(StorageError::RevisionConflict {
            expected: revision,
            actual: actual_revision,
        });
    }
    Ok(offset)
}

fn internal(error: rusqlite::Error) -> StorageError {
    StorageError::Internal(error.to_string())
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
        schema::ensure_root(&mut connection).expect("root");
        connection
    }

    /// Through the same path maintenance a commit runs, since the window reads
    /// the stored column now.
    fn insert_child(connection: &mut Connection, id: &str, parent_id: &str, sort_key: i64) {
        let transaction = connection.transaction().expect("transaction");
        transaction
            .execute(
                "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text)
                 VALUES (?1, ?2, ?3, 'bullet', ?1)",
                params![id, parent_id, sort_key],
            )
            .expect("node");
        crate::node_paths::rebuild_all(&transaction).expect("paths");
        transaction.commit().expect("commit");
    }

    fn open_page(id: &str) -> ViewportRequest {
        ViewportRequest {
            page_id: id.into(),
            anchor_id: None,
            before_cursor: None,
            after_cursor: None,
            limit: 10,
        }
    }

    fn plan(connection: &Connection, sql: &str) -> String {
        let mut statement = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .expect("plan");
        let bindings = statement.parameter_count();
        statement
            .query_map(&params!["page", 10, 0][..bindings], |row| {
                row.get::<_, String>(3)
            })
            .expect("plan rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("plan rows")
            .join(" | ")
    }

    /// The point of the stored path: both readers seek into the index rather
    /// than sorting the page. A predicate that stops being sargable turns these
    /// into SCAN and takes the deep-scroll bound with it.
    #[test]
    fn both_readers_seek_the_path_index() {
        let mut connection = open();
        insert_child(&mut connection, "page", ROOT_ID, 1024);
        insert_child(&mut connection, "node", "page", 1024);

        for sql in [window_sql(), anchor_sql()] {
            let plan = plan(&connection, &sql);
            assert!(
                plan.contains("SEARCH body USING INDEX notes_nodes_path (path>? AND path<?)"),
                "{plan}"
            );
            assert!(!plan.contains("TEMP B-TREE"), "{plan}");
        }
    }

    #[test]
    fn scrolling_one_page_never_touches_a_row() {
        let mut connection = open();
        insert_child(&mut connection, "page", ROOT_ID, 1024);
        for index in 0..40 {
            insert_child(
                &mut connection,
                &format!("node-{index}"),
                "page",
                1024 * (index + 1),
            );
        }
        let opened = viewport(&connection, open_page("page")).expect("open the page");

        let before = connection.total_changes();
        let down = viewport(
            &connection,
            ViewportRequest {
                after_cursor: opened.after_cursor,
                ..open_page("page")
            },
        )
        .expect("scroll down");
        viewport(
            &connection,
            ViewportRequest {
                before_cursor: down.before_cursor,
                ..open_page("page")
            },
        )
        .expect("scroll up");
        viewport(
            &connection,
            ViewportRequest {
                anchor_id: Some("node-30".into()),
                ..open_page("page")
            },
        )
        .expect("jump to an anchor");
        viewport(&connection, open_page("page")).expect("reopen the same page");

        assert_eq!(connection.total_changes(), before, "a read path wrote rows");
    }

    #[test]
    fn switching_pages_writes_once_and_then_settles() {
        let mut connection = open();
        insert_child(&mut connection, "page-a", ROOT_ID, 1024);
        insert_child(&mut connection, "page-b", ROOT_ID, 2048);
        viewport(&connection, open_page("page-a")).expect("open a");

        let before = connection.total_changes();
        viewport(&connection, open_page("page-b")).expect("switch to b");
        let switched = connection.total_changes();
        viewport(&connection, open_page("page-b")).expect("stay on b");

        assert_eq!(switched - before, 1);
        assert_eq!(connection.total_changes(), switched);
        assert_eq!(
            active_page(&connection).expect("ui state").as_deref(),
            Some("page-b")
        );
    }

    #[test]
    fn a_boot_after_opening_a_page_lands_back_on_it() {
        let mut connection = open();
        insert_child(&mut connection, "first-page", ROOT_ID, 1024);
        insert_child(&mut connection, "second-page", ROOT_ID, 2048);

        let first = bootstrap(&connection, "session-a".into(), 20).expect("first boot");
        assert_eq!(first.active_page_id.as_deref(), Some(ROOT_ID));
        viewport(&connection, open_page("second-page")).expect("open the second page");

        let second = bootstrap(&connection, "session-b".into(), 20).expect("second boot");
        assert_eq!(second.active_page_id.as_deref(), Some("second-page"));
    }

    #[test]
    fn booting_past_a_dead_stored_page_repairs_the_stored_row() {
        let connection = open();
        connection
            .execute(
                "INSERT INTO notes_ui_state(key, value) VALUES ('active_page_id', 'ghost-page')",
                [],
            )
            .expect("stale row");

        let boot = bootstrap(&connection, "session-a".into(), 20).expect("boot");

        assert_eq!(boot.active_page_id.as_deref(), Some(ROOT_ID));
        assert_eq!(
            active_page(&connection).expect("ui state").as_deref(),
            Some(ROOT_ID)
        );
    }
}
