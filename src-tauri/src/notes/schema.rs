use crate::notes::types::NoteNodeKind;
use rusqlite::{functions::FunctionFlags, Connection, Error, Transaction};

pub(crate) const CURRENT_NOTES_SCHEMA_VERSION: i64 = 3;
#[cfg(test)]
pub(crate) const NOTES_SCHEMA_VERSION_V3: i64 = 3;
pub(crate) const SYNC_REMOVE_TOPIC_PREFIX: &str = "__yonalist_remove_topic__:";

pub(crate) fn validate_image_offset_utf16(
    title: &str,
    node_kind: NoteNodeKind,
    image_offset_utf16: i64,
) -> Result<usize, String> {
    if image_offset_utf16 < 0 {
        return Err("A Notes image offset must not be negative.".to_string());
    }
    if node_kind == NoteNodeKind::Text {
        return (image_offset_utf16 == 0)
            .then_some(0)
            .ok_or_else(|| "A text Notes node must use image offset zero.".to_string());
    }
    let target = usize::try_from(image_offset_utf16)
        .map_err(|_| "A Notes image offset is too large.".to_string())?;
    let mut utf16_offset = 0usize;
    for (byte_offset, character) in title.char_indices() {
        if utf16_offset == target {
            return Ok(byte_offset);
        }
        utf16_offset += character.len_utf16();
        if utf16_offset == target {
            return Ok(byte_offset + character.len_utf8());
        }
    }
    (utf16_offset == target)
        .then_some(title.len())
        .ok_or_else(|| {
            "A Notes image offset must be a UTF-16 scalar boundary in its title.".to_string()
        })
}

pub(crate) fn install_notes_sql_functions(connection: &Connection) -> Result<(), String> {
    connection
        .create_scalar_function(
            "notes_image_search_title",
            3,
            FunctionFlags::SQLITE_UTF8
                | FunctionFlags::SQLITE_DETERMINISTIC
                | FunctionFlags::SQLITE_INNOCUOUS,
            |context| {
                let title = context.get::<String>(0)?;
                let node_kind = match context.get::<String>(1)?.as_str() {
                    "text" => NoteNodeKind::Text,
                    "image" => NoteNodeKind::Image,
                    value => {
                        return Err(Error::UserFunctionError(Box::new(std::io::Error::new(
                            std::io::ErrorKind::InvalidInput,
                            format!("Unsupported Notes node kind: {value}"),
                        ))))
                    }
                };
                let image_offset_utf16 = context.get::<i64>(2)?;
                let byte_offset =
                    validate_image_offset_utf16(&title, node_kind, image_offset_utf16).map_err(
                        |message| {
                            Error::UserFunctionError(Box::new(std::io::Error::new(
                                std::io::ErrorKind::InvalidInput,
                                message,
                            )))
                        },
                    )?;
                if node_kind == NoteNodeKind::Text {
                    return Ok(title);
                }
                if byte_offset == 0 || byte_offset == title.len() {
                    return Ok(title);
                }
                let (before, after) = title.split_at(byte_offset);
                Ok(format!("{before} {after}"))
            },
        )
        .map_err(|error| format!("Could not configure Notes SQL functions: {error}"))?;
    crate::notes::hlc::register_placeholder_hlc_function(connection)
}

macro_rules! notes_schema_sql {
    (
        $node_columns:literal,
        $search_insert_when:literal,
        $search_update_columns:literal,
        $search_update_where:literal,
        $search_delete_when:literal,
        $lifecycle_insert_when:literal,
        $lifecycle_update_columns:literal,
        $lifecycle_update_where:literal,
        $lifecycle_delete_when:literal,
        $attachment_node_filter:literal,
        $plugin_indexes:literal,
        $version:literal
    ) => {
        concat!(
            r#"
CREATE TABLE notes_nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES notes_nodes(id),
  sort_key INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  image_offset_utf16 INTEGER NOT NULL DEFAULT 0
    CHECK (image_offset_utf16 >= 0),
  layout_mode TEXT NOT NULL DEFAULT 'bullets',
  is_collapsed INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_batch_id TEXT,
  archived_at TEXT,
  archive_root_id TEXT REFERENCES notes_nodes(id),
  node_kind TEXT NOT NULL DEFAULT 'text'
    CHECK (node_kind IN ('text', 'image')),
  hlc TEXT NOT NULL DEFAULT ''"#,
            $node_columns,
            r#"
);

CREATE INDEX notes_nodes_active_parent_order
  ON notes_nodes(parent_id, deleted_at, sort_key);
CREATE INDEX notes_nodes_deleted_batch
  ON notes_nodes(deleted_batch_id, parent_id);
CREATE INDEX notes_nodes_archive_parent_order
  ON notes_nodes(archived_at, parent_id, sort_key);
CREATE INDEX notes_nodes_archive_root_order
  ON notes_nodes(archive_root_id, parent_id, sort_key);
"#,
            $plugin_indexes,
            r#"

CREATE TABLE notes_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  vault_generation TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  device_id TEXT NOT NULL,
  vault_uuid TEXT NOT NULL,
  hlc_millis INTEGER NOT NULL DEFAULT 0,
  hlc_counter INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_topics (
  topic_id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL UNIQUE,
  applied_max_hlc TEXT NOT NULL DEFAULT '',
  exported_hash TEXT NOT NULL DEFAULT '',
  quarantined INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_dirty_nodes (
  node_id TEXT PRIMARY KEY,
  marked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sync_conflict_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  loser_json TEXT NOT NULL,
  loser_hlc TEXT NOT NULL,
  winner_hlc TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sync_purged_tombstones (
  node_id TEXT PRIMARY KEY,
  purged_hlc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_trash_archive (
  node_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_trash (
  content_hash TEXT PRIMARY KEY,
  extension TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  quarantined_at TEXT NOT NULL,
  delete_after TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS notes_nodes_hlc_ai AFTER INSERT ON notes_nodes
WHEN NEW.hlc = ''
BEGIN
  UPDATE notes_nodes SET hlc = yona_hlc() WHERE id = NEW.id;
  INSERT INTO sync_dirty_nodes(node_id) VALUES (NEW.id)
  ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at;
END;

CREATE TRIGGER IF NOT EXISTS notes_nodes_hlc_au AFTER UPDATE ON notes_nodes
WHEN NEW.hlc = OLD.hlc
BEGIN
  UPDATE notes_nodes SET hlc = yona_hlc() WHERE id = NEW.id;
  INSERT INTO sync_dirty_nodes(node_id) VALUES (NEW.id)
  ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at;
END;

CREATE TRIGGER IF NOT EXISTS notes_nodes_hlc_ad AFTER DELETE ON notes_nodes
BEGIN
  INSERT INTO sync_dirty_nodes(node_id) VALUES (OLD.id)
  ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at;
END;

-- R1a: trash-archive membership must end the moment a node leaves trash. A
-- registration that outlives the deletion would exclude the node from every
-- future trash.md export (see load_trash_nodes), so a restore-then-redelete
-- would never propagate the new deletion to other devices (absence ≠ deletion,
-- rule 1). These two triggers are the single shared point that covers every
-- exit path — restore (deleted_at → NULL), hard-purge (empty_trash DELETE), and
-- any merge that un-deletes or purges a node, all route through notes_nodes.
CREATE TRIGGER IF NOT EXISTS notes_trash_archive_restore
AFTER UPDATE OF deleted_at ON notes_nodes
WHEN NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL
BEGIN
  DELETE FROM sync_trash_archive WHERE node_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS notes_trash_archive_purge
AFTER DELETE ON notes_nodes
BEGIN
  DELETE FROM sync_trash_archive WHERE node_id = OLD.id;
END;

CREATE TABLE notes_tags (
  node_id TEXT NOT NULL REFERENCES notes_nodes(id) ON DELETE CASCADE,
  prefix TEXT NOT NULL CHECK (prefix IN ('#', '@')),
  tag TEXT NOT NULL,
  normalized_tag TEXT NOT NULL,
  PRIMARY KEY (node_id, prefix, normalized_tag)
);
CREATE INDEX notes_tags_normalized_tag ON notes_tags(normalized_tag);
CREATE INDEX notes_tags_prefix_normalized_tag
  ON notes_tags(prefix, normalized_tag, node_id);

CREATE TABLE notes_dates (
  node_id TEXT NOT NULL REFERENCES notes_nodes(id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK (field IN ('title', 'note')),
  start_utf16 INTEGER NOT NULL,
  end_utf16 INTEGER NOT NULL,
  normalized_start TEXT NOT NULL,
  normalized_end TEXT NOT NULL,
  token_text TEXT NOT NULL,
  PRIMARY KEY (node_id, field, start_utf16, end_utf16)
);
CREATE INDEX notes_dates_range
  ON notes_dates(normalized_start, normalized_end, node_id);

CREATE TABLE notes_attachments (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES notes_nodes(id) ON DELETE CASCADE,
  sort_key INTEGER NOT NULL,
  relative_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  intrinsic_width INTEGER NOT NULL,
  intrinsic_height INTEGER NOT NULL,
  display_width INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX notes_attachments_node_order
  ON notes_attachments(node_id, sort_key, id);

CREATE TRIGGER IF NOT EXISTS notes_attachments_hlc_ai AFTER INSERT ON notes_attachments
BEGIN
  UPDATE notes_nodes SET hlc = yona_hlc() WHERE id = NEW.node_id;
  INSERT INTO sync_dirty_nodes(node_id) VALUES (NEW.node_id)
  ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at;
END;

CREATE TRIGGER IF NOT EXISTS notes_attachments_hlc_au AFTER UPDATE ON notes_attachments
BEGIN
  UPDATE notes_nodes SET hlc = yona_hlc() WHERE id IN (OLD.node_id, NEW.node_id);
  INSERT INTO sync_dirty_nodes(node_id) VALUES (OLD.node_id)
  ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at;
  INSERT INTO sync_dirty_nodes(node_id) VALUES (NEW.node_id)
  ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at;
END;

CREATE TRIGGER IF NOT EXISTS notes_attachments_hlc_ad AFTER DELETE ON notes_attachments
BEGIN
  UPDATE notes_nodes SET hlc = yona_hlc() WHERE id = OLD.node_id;
  INSERT INTO sync_dirty_nodes(node_id) VALUES (OLD.node_id)
  ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at;
END;

CREATE VIRTUAL TABLE notes_search USING fts5(
  node_id UNINDEXED,
  title,
  note,
  attachment_name,
  tokenize = 'unicode61'
);
CREATE TRIGGER notes_nodes_search_insert
AFTER INSERT ON notes_nodes "#,
            $search_insert_when,
            r#"
BEGIN
  INSERT INTO notes_search (node_id, title, note, attachment_name)
  VALUES (
    NEW.id,
    notes_image_search_title(NEW.title, NEW.node_kind, NEW.image_offset_utf16),
    NEW.note,
    ''
  );
END;
CREATE TRIGGER notes_nodes_search_update
AFTER UPDATE OF "#,
            $search_update_columns,
            r#" ON notes_nodes
BEGIN
  DELETE FROM notes_search WHERE node_id = OLD.id;
  INSERT INTO notes_search (node_id, title, note, attachment_name)
  SELECT NEW.id, notes_image_search_title(NEW.title, NEW.node_kind, NEW.image_offset_utf16),
         NEW.note, CASE WHEN NEW.node_kind = 'image'
                              AND 1 = (SELECT COUNT(*) FROM notes_attachments
                                       WHERE node_id = NEW.id)
                         THEN (SELECT original_name FROM notes_attachments
                               WHERE node_id = NEW.id)
                         ELSE '' END
  WHERE NEW.deleted_at IS NULL AND NEW.archived_at IS NULL"#,
            $search_update_where,
            r#";
END;
CREATE TRIGGER notes_nodes_search_delete
AFTER DELETE ON notes_nodes "#,
            $search_delete_when,
            r#"
BEGIN
  DELETE FROM notes_search WHERE node_id = OLD.id;
END;

CREATE VIRTUAL TABLE notes_search_lifecycle USING fts5(
  node_id UNINDEXED,
  title,
  note,
  attachment_name,
  tokenize = 'unicode61'
);
CREATE TRIGGER notes_nodes_lifecycle_search_insert
AFTER INSERT ON notes_nodes "#,
            $lifecycle_insert_when,
            r#"
BEGIN
  INSERT INTO notes_search_lifecycle (node_id, title, note, attachment_name)
  VALUES (
    NEW.id,
    notes_image_search_title(NEW.title, NEW.node_kind, NEW.image_offset_utf16),
    NEW.note,
    ''
  );
END;
CREATE TRIGGER notes_nodes_lifecycle_search_update
AFTER UPDATE OF "#,
            $lifecycle_update_columns,
            r#" ON notes_nodes
BEGIN
  DELETE FROM notes_search_lifecycle WHERE node_id = OLD.id;
  INSERT INTO notes_search_lifecycle (node_id, title, note, attachment_name)
  SELECT NEW.id, notes_image_search_title(NEW.title, NEW.node_kind, NEW.image_offset_utf16),
         NEW.note, CASE WHEN NEW.node_kind = 'image'
                              AND 1 = (SELECT COUNT(*) FROM notes_attachments
                                       WHERE node_id = NEW.id)
                         THEN (SELECT original_name FROM notes_attachments
                               WHERE node_id = NEW.id)
                         ELSE '' END "#,
            $lifecycle_update_where,
            r#";
END;
CREATE TRIGGER notes_nodes_lifecycle_search_delete
AFTER DELETE ON notes_nodes "#,
            $lifecycle_delete_when,
            r#"
BEGIN
  DELETE FROM notes_search_lifecycle WHERE node_id = OLD.id;
END;

CREATE TRIGGER notes_attachments_search_insert
AFTER INSERT ON notes_attachments
BEGIN
  DELETE FROM notes_search WHERE node_id = NEW.node_id;
  INSERT INTO notes_search (node_id, title, note, attachment_name)
  SELECT node.id, notes_image_search_title(node.title, node.node_kind, node.image_offset_utf16),
         node.note, CASE WHEN node.node_kind = 'image'
                              AND 1 = (SELECT COUNT(*) FROM notes_attachments
                                       WHERE node_id = node.id)
                         THEN (SELECT original_name FROM notes_attachments
                               WHERE node_id = node.id)
                         ELSE '' END
  FROM notes_nodes node
  WHERE node.id = NEW.node_id AND node.deleted_at IS NULL AND node.archived_at IS NULL"#,
            $attachment_node_filter,
            r#";
  DELETE FROM notes_search_lifecycle WHERE node_id = NEW.node_id;
  INSERT INTO notes_search_lifecycle (node_id, title, note, attachment_name)
  SELECT node.id, notes_image_search_title(node.title, node.node_kind, node.image_offset_utf16),
         node.note, CASE WHEN node.node_kind = 'image'
                              AND 1 = (SELECT COUNT(*) FROM notes_attachments
                                       WHERE node_id = node.id)
                         THEN (SELECT original_name FROM notes_attachments
                               WHERE node_id = node.id)
                         ELSE '' END
  FROM notes_nodes node WHERE node.id = NEW.node_id"#,
            $attachment_node_filter,
            r#";
END;
CREATE TRIGGER notes_attachments_search_update
AFTER UPDATE OF node_id, original_name ON notes_attachments
BEGIN
  DELETE FROM notes_search WHERE node_id IN (OLD.node_id, NEW.node_id);
  INSERT INTO notes_search (node_id, title, note, attachment_name)
  SELECT node.id, notes_image_search_title(node.title, node.node_kind, node.image_offset_utf16),
         node.note, CASE WHEN node.node_kind = 'image'
                              AND 1 = (SELECT COUNT(*) FROM notes_attachments
                                       WHERE node_id = node.id)
                         THEN (SELECT original_name FROM notes_attachments
                               WHERE node_id = node.id)
                         ELSE '' END
  FROM notes_nodes node
  WHERE node.id IN (OLD.node_id, NEW.node_id)
    AND node.deleted_at IS NULL AND node.archived_at IS NULL"#,
            $attachment_node_filter,
            r#";
  DELETE FROM notes_search_lifecycle WHERE node_id IN (OLD.node_id, NEW.node_id);
  INSERT INTO notes_search_lifecycle (node_id, title, note, attachment_name)
  SELECT node.id, notes_image_search_title(node.title, node.node_kind, node.image_offset_utf16),
         node.note, CASE WHEN node.node_kind = 'image'
                              AND 1 = (SELECT COUNT(*) FROM notes_attachments
                                       WHERE node_id = node.id)
                         THEN (SELECT original_name FROM notes_attachments
                               WHERE node_id = node.id)
                         ELSE '' END
  FROM notes_nodes node WHERE node.id IN (OLD.node_id, NEW.node_id)"#,
            $attachment_node_filter,
            r#";
END;
CREATE TRIGGER notes_attachments_search_delete
AFTER DELETE ON notes_attachments
BEGIN
  DELETE FROM notes_search WHERE node_id = OLD.node_id;
  INSERT INTO notes_search (node_id, title, note, attachment_name)
  SELECT node.id, notes_image_search_title(node.title, node.node_kind, node.image_offset_utf16),
         node.note, CASE WHEN node.node_kind = 'image'
                              AND 1 = (SELECT COUNT(*) FROM notes_attachments
                                       WHERE node_id = node.id)
                         THEN (SELECT original_name FROM notes_attachments
                               WHERE node_id = node.id)
                         ELSE '' END
  FROM notes_nodes node
  WHERE node.id = OLD.node_id AND node.deleted_at IS NULL AND node.archived_at IS NULL"#,
            $attachment_node_filter,
            r#";
  DELETE FROM notes_search_lifecycle WHERE node_id = OLD.node_id;
  INSERT INTO notes_search_lifecycle (node_id, title, note, attachment_name)
  SELECT node.id, notes_image_search_title(node.title, node.node_kind, node.image_offset_utf16),
         node.note, CASE WHEN node.node_kind = 'image'
                              AND 1 = (SELECT COUNT(*) FROM notes_attachments
                                       WHERE node_id = node.id)
                         THEN (SELECT original_name FROM notes_attachments
                               WHERE node_id = node.id)
                         ELSE '' END
  FROM notes_nodes node WHERE node.id = OLD.node_id"#,
            $attachment_node_filter,
            r#";
END;
"#,
            $version
        )
    };
}

pub(crate) const V3_SCHEMA_SQL: &str = notes_schema_sql!(
    ",\n  plugin_state TEXT,\n  plugin_meta TEXT,\n  is_readonly INTEGER DEFAULT 0\n    CHECK (is_readonly IN (0, 1) OR is_readonly IS NULL)",
    "WHEN NEW.deleted_at IS NULL AND NEW.archived_at IS NULL\n  AND NEW.plugin_meta IS NULL\n  AND NEW.id <> '6983f947-c134-44fc-bf46-db19f68125bf'",
    "title, note, image_offset_utf16, node_kind, deleted_at, archived_at, plugin_meta",
    "\n    AND NEW.plugin_meta IS NULL\n    AND NEW.id <> '6983f947-c134-44fc-bf46-db19f68125bf'",
    "WHEN OLD.plugin_meta IS NULL\n  AND OLD.id <> '6983f947-c134-44fc-bf46-db19f68125bf'",
    "WHEN NEW.plugin_meta IS NULL\n  AND NEW.id <> '6983f947-c134-44fc-bf46-db19f68125bf'",
    "title, note, image_offset_utf16, node_kind, plugin_meta",
    "WHERE NEW.plugin_meta IS NULL\n  AND NEW.id <> '6983f947-c134-44fc-bf46-db19f68125bf'",
    "WHEN OLD.plugin_meta IS NULL\n  AND OLD.id <> '6983f947-c134-44fc-bf46-db19f68125bf'",
    "\n    AND node.plugin_meta IS NULL\n    AND node.id <> '6983f947-c134-44fc-bf46-db19f68125bf'",
    "\nCREATE UNIQUE INDEX notes_nodes_github_date_key\n  ON notes_nodes(\n    CASE WHEN json_valid(plugin_meta) THEN\n      CASE WHEN json_extract(plugin_meta, '$.kind') = 'date'\n        THEN json_extract(plugin_meta, '$.date_key')\n      END\n    END\n  )\n  WHERE plugin_meta IS NOT NULL;\nCREATE UNIQUE INDEX notes_nodes_github_notification_key\n  ON notes_nodes(\n    CASE WHEN json_valid(plugin_meta) THEN\n      CASE WHEN json_extract(plugin_meta, '$.kind') = 'notification'\n        THEN json_extract(plugin_meta, '$.notification_key')\n      END\n    END\n  )\n  WHERE plugin_meta IS NOT NULL;\n",
    "\nPRAGMA user_version = 3;\n"
);

const CURRENT_SCHEMA_SQL: &str = V3_SCHEMA_SQL;

fn exists(transaction: &Transaction<'_>) -> Result<bool, String> {
    transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema \
             WHERE type = 'table' AND name = 'notes_nodes')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect Notes storage: {error}"))
}

pub(crate) fn create_if_missing(transaction: &Transaction<'_>) -> Result<bool, String> {
    if exists(transaction)? {
        return Ok(false);
    }
    transaction
        .execute_batch(CURRENT_SCHEMA_SQL)
        .map_err(|error| format!("Could not create Notes storage: {error}"))?;
    install_current_sync_triggers(transaction)?;
    Ok(true)
}

pub(crate) fn install_current_sync_triggers(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            "CREATE TRIGGER IF NOT EXISTS notes_nodes_trash_dirty_au \
             AFTER UPDATE ON notes_nodes \
             WHEN NEW.hlc = OLD.hlc AND NEW.deleted_at IS NOT OLD.deleted_at \
             BEGIN \
               INSERT INTO sync_dirty_nodes(node_id) VALUES ('__yonalist_trash__') \
               ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at; \
             END;",
        )
        .map_err(|error| format!("Could not install current Notes sync triggers: {error}"))
}
