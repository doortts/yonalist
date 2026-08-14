use notes_application::{
    BootSnapshot, HistoryState, NoteView, PageSummary, SearchHit, SearchPage, SearchQuery,
    StorageError, ViewportPage, ViewportRequest,
};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params};

use crate::repository;
use crate::schema::ROOT_ID;

const MAX_VIEWPORT_LIMIT: u32 = 200;
const MAX_SEARCH_LIMIT: u32 = 100;

pub(crate) fn bootstrap(
    connection: &Connection,
    session_id: String,
    viewport_limit: u32,
) -> Result<BootSnapshot, StorageError> {
    let revision = repository::revision(connection)?;
    let mut statement = connection
        .prepare(
            "SELECT id, text, sort_key
             FROM notes_nodes
             WHERE parent_id = ?1 AND deleted = 0
             ORDER BY sort_key, id",
        )
        .map_err(internal)?;
    let pages = statement
        .query_map([ROOT_ID], |row| {
            Ok(PageSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                sort_key: row.get(2)?,
            })
        })
        .map_err(internal)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;
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
    let mut statement = connection
        .prepare(
            "WITH RECURSIVE outline(id, path) AS (
                SELECT id,
                       CASE WHEN sort_key < 0
                           THEN printf(
                               '0%019lld:%s',
                               9223372036854775807 + sort_key + 1,
                               id
                           )
                           ELSE printf('1%019lld:%s', sort_key, id)
                       END
                FROM notes_nodes
                WHERE id = ?1 AND deleted = 0
                UNION ALL
                SELECT child.id,
                       outline.path || '/' ||
                           CASE WHEN child.sort_key < 0
                               THEN printf(
                                   '0%019lld:%s',
                                   9223372036854775807 + child.sort_key + 1,
                                   child.id
                               )
                               ELSE printf('1%019lld:%s', child.sort_key, child.id)
                           END
                FROM notes_nodes child
                JOIN outline ON child.parent_id = outline.id
                WHERE child.deleted = 0
             )
             SELECT node.*
             FROM outline
             JOIN notes_node_records node ON node.id = outline.id
             WHERE node.id <> ?1
             ORDER BY outline.path
             LIMIT ?2 OFFSET ?3",
        )
        .map_err(internal)?;
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
        Some(("node.starred = ?1 AND node.deleted = 0", Value::Integer(1)))
    } else if normalized == "is:trash" {
        Some(("node.deleted = ?1", Value::Integer(1)))
    } else if normalized == "is:tagged" {
        Some((
            "?1 = 1 AND EXISTS (
                SELECT 1 FROM notes_tags WHERE notes_tags.node_id = node.id
             ) AND node.deleted = 0",
            Value::Integer(1),
        ))
    } else if let Some(tag) = text.strip_prefix("tag:").filter(|tag| !tag.is_empty()) {
        Some((
            "EXISTS (
                SELECT 1 FROM notes_tags
                WHERE notes_tags.node_id = node.id AND notes_tags.token = ?1
             ) AND node.deleted = 0",
            Value::Text(tag.to_lowercase()),
        ))
    } else {
        text.strip_prefix("date:")
            .filter(|date| !date.is_empty())
            .map(|date| {
                (
                    "EXISTS (
                        SELECT 1 FROM notes_dates
                        WHERE notes_dates.node_id = node.id AND notes_dates.date_key = ?1
                     ) AND node.deleted = 0",
                    Value::Text(date.to_owned()),
                )
            })
    };
    if let Some((clause, value)) = filter {
        return filtered_search(
            connection,
            clause,
            value,
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
                    page_id: row.get(19)?,
                    snippet: row.get(20)?,
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

#[allow(clippy::too_many_arguments)]
fn filtered_search(
    connection: &Connection,
    clause: &str,
    value: Value,
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
                    SELECT id FROM ancestors WHERE parent_id = ?4 LIMIT 1
                ) AS page_id,
                CASE
                    WHEN node.note = '' THEN node.text
                    ELSE node.text || ' ' || node.note
                END
         FROM notes_node_records node
         WHERE ({clause}) AND node.id <> ?4
         ORDER BY node.sort_key, node.id
         LIMIT ?2 OFFSET ?3"
    );
    let mut statement = connection.prepare(&sql).map_err(internal)?;
    let rows = statement
        .query_map(
            params![
                value,
                i64::from(requested_limit.clamp(1, MAX_SEARCH_LIMIT)) + 1,
                i64::try_from(offset).map_err(|_| {
                    StorageError::Internal("search offset exceeded SQLite INTEGER".into())
                })?,
                ROOT_ID
            ],
            |row| {
                Ok(SearchHit {
                    node: repository::parse_node(row)?.into(),
                    page_id: row.get(19)?,
                    snippet: row.get(20)?,
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

fn anchor_offset(
    connection: &Connection,
    page_id: &str,
    anchor_id: &str,
) -> Result<usize, StorageError> {
    let offset = connection
        .query_row(
            "WITH RECURSIVE outline(id, path) AS (
                SELECT id,
                       CASE WHEN sort_key < 0
                           THEN printf(
                               '0%019lld:%s',
                               9223372036854775807 + sort_key + 1,
                               id
                           )
                           ELSE printf('1%019lld:%s', sort_key, id)
                       END
                FROM notes_nodes
                WHERE id = ?1 AND deleted = 0
                UNION ALL
                SELECT child.id,
                       outline.path || '/' ||
                           CASE WHEN child.sort_key < 0
                               THEN printf(
                                   '0%019lld:%s',
                                   9223372036854775807 + child.sort_key + 1,
                                   child.id
                               )
                               ELSE printf('1%019lld:%s', child.sort_key, child.id)
                           END
                FROM notes_nodes child
                JOIN outline ON child.parent_id = outline.id
                WHERE child.deleted = 0
             ),
             ordered AS (
                SELECT id, row_number() OVER (ORDER BY path) - 2 AS offset
                FROM outline
             )
             SELECT MAX(offset, 0) FROM ordered WHERE id = ?2",
            params![page_id, anchor_id],
            |row| row.get::<_, i64>(0),
        )
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
        schema::initialize(&connection).expect("schema");
        schema::ensure_root(&mut connection).expect("root");
        connection
    }

    fn insert_child(connection: &Connection, id: &str, parent_id: &str, sort_key: i64) {
        connection
            .execute(
                "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text)
                 VALUES (?1, ?2, ?3, 'bullet', ?1)",
                params![id, parent_id, sort_key],
            )
            .expect("node");
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

    #[test]
    fn scrolling_one_page_never_touches_a_row() {
        let connection = open();
        insert_child(&connection, "page", ROOT_ID, 1024);
        for index in 0..40 {
            insert_child(
                &connection,
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
        let connection = open();
        insert_child(&connection, "page-a", ROOT_ID, 1024);
        insert_child(&connection, "page-b", ROOT_ID, 2048);
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
        let connection = open();
        insert_child(&connection, "first-page", ROOT_ID, 1024);
        insert_child(&connection, "second-page", ROOT_ID, 2048);

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
