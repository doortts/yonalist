use rusqlite::Transaction;

const CURRENT_SCHEMA_SQL: &str = r#"
CREATE TABLE notes_nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES notes_nodes(id),
  sort_key INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  layout_mode TEXT NOT NULL DEFAULT 'bullets',
  is_collapsed INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_batch_id TEXT,
  archived_at TEXT,
  archive_root_id TEXT REFERENCES notes_nodes(id)
);

CREATE INDEX notes_nodes_active_parent_order
  ON notes_nodes(parent_id, deleted_at, sort_key);
CREATE INDEX notes_nodes_deleted_batch
  ON notes_nodes(deleted_batch_id, parent_id);
CREATE INDEX notes_nodes_archive_parent_order
  ON notes_nodes(archived_at, parent_id, sort_key);
CREATE INDEX notes_nodes_archive_root_order
  ON notes_nodes(archive_root_id, parent_id, sort_key);

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

CREATE TABLE notes_history_entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  is_undone INTEGER NOT NULL DEFAULT 0,
  estimated_bytes INTEGER NOT NULL DEFAULT 0,
  command_kind TEXT NOT NULL
);
CREATE UNIQUE INDEX notes_history_session_sequence
  ON notes_history_entries(session_id, sequence);

CREATE TABLE notes_history_changes (
  entry_id TEXT NOT NULL REFERENCES notes_history_entries(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  before_json TEXT,
  after_json TEXT,
  PRIMARY KEY (entry_id, table_name, row_id)
);

CREATE VIRTUAL TABLE notes_search USING fts5(
  node_id UNINDEXED,
  title,
  note,
  tokenize = 'unicode61'
);
CREATE TRIGGER notes_nodes_search_insert
AFTER INSERT ON notes_nodes
WHEN NEW.deleted_at IS NULL AND NEW.archived_at IS NULL
BEGIN
  INSERT INTO notes_search (node_id, title, note)
  VALUES (NEW.id, NEW.title, NEW.note);
END;
CREATE TRIGGER notes_nodes_search_update
AFTER UPDATE OF title, note, deleted_at, archived_at ON notes_nodes
BEGIN
  DELETE FROM notes_search WHERE node_id = OLD.id;
  INSERT INTO notes_search (node_id, title, note)
  SELECT NEW.id, NEW.title, NEW.note
  WHERE NEW.deleted_at IS NULL AND NEW.archived_at IS NULL;
END;
CREATE TRIGGER notes_nodes_search_delete
AFTER DELETE ON notes_nodes
BEGIN
  DELETE FROM notes_search WHERE node_id = OLD.id;
END;

CREATE VIRTUAL TABLE notes_search_lifecycle USING fts5(
  node_id UNINDEXED,
  title,
  note,
  tokenize = 'unicode61'
);
CREATE TRIGGER notes_nodes_lifecycle_search_insert
AFTER INSERT ON notes_nodes
BEGIN
  INSERT INTO notes_search_lifecycle (node_id, title, note)
  VALUES (NEW.id, NEW.title, NEW.note);
END;
CREATE TRIGGER notes_nodes_lifecycle_search_update
AFTER UPDATE OF title, note ON notes_nodes
BEGIN
  DELETE FROM notes_search_lifecycle WHERE node_id = OLD.id;
  INSERT INTO notes_search_lifecycle (node_id, title, note)
  VALUES (NEW.id, NEW.title, NEW.note);
END;
CREATE TRIGGER notes_nodes_lifecycle_search_delete
AFTER DELETE ON notes_nodes
BEGIN
  DELETE FROM notes_search_lifecycle WHERE node_id = OLD.id;
END;
"#;

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
    Ok(true)
}
