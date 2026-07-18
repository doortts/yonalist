use crate::notes::types::NoteNodeKind;
use rusqlite::{functions::FunctionFlags, Connection, Error, Transaction};

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
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
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
        .map_err(|error| format!("Could not configure Notes SQL functions: {error}"))
}

const CURRENT_SCHEMA_SQL: &str = r#"
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
    CHECK (node_kind IN ('text', 'image'))
);

CREATE INDEX notes_nodes_active_parent_order
  ON notes_nodes(parent_id, deleted_at, sort_key);
CREATE INDEX notes_nodes_deleted_batch
  ON notes_nodes(deleted_batch_id, parent_id);
CREATE INDEX notes_nodes_archive_parent_order
  ON notes_nodes(archived_at, parent_id, sort_key);
CREATE INDEX notes_nodes_archive_root_order
  ON notes_nodes(archive_root_id, parent_id, sort_key);

CREATE TABLE notes_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  vault_generation TEXT NOT NULL
);

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

CREATE VIRTUAL TABLE notes_search USING fts5(
  node_id UNINDEXED,
  title,
  note,
  attachment_name,
  tokenize = 'unicode61'
);
CREATE TRIGGER notes_nodes_search_insert
AFTER INSERT ON notes_nodes
WHEN NEW.deleted_at IS NULL AND NEW.archived_at IS NULL
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
AFTER UPDATE OF title, note, image_offset_utf16, node_kind, deleted_at, archived_at ON notes_nodes
BEGIN
  DELETE FROM notes_search WHERE node_id = OLD.id;
  INSERT INTO notes_search (node_id, title, note, attachment_name)
  SELECT NEW.id, notes_image_search_title(NEW.title, NEW.node_kind, NEW.image_offset_utf16),
         NEW.note, COALESCE((SELECT group_concat(original_name, ' ') FROM notes_attachments
                              WHERE node_id = NEW.id), '')
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
  attachment_name,
  tokenize = 'unicode61'
);
CREATE TRIGGER notes_nodes_lifecycle_search_insert
AFTER INSERT ON notes_nodes
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
AFTER UPDATE OF title, note, image_offset_utf16, node_kind ON notes_nodes
BEGIN
  DELETE FROM notes_search_lifecycle WHERE node_id = OLD.id;
  INSERT INTO notes_search_lifecycle (node_id, title, note, attachment_name)
  SELECT NEW.id, notes_image_search_title(NEW.title, NEW.node_kind, NEW.image_offset_utf16),
         NEW.note, COALESCE((SELECT group_concat(original_name, ' ') FROM notes_attachments
                              WHERE node_id = NEW.id), '');
END;
CREATE TRIGGER notes_nodes_lifecycle_search_delete
AFTER DELETE ON notes_nodes
BEGIN
  DELETE FROM notes_search_lifecycle WHERE node_id = OLD.id;
END;

CREATE TRIGGER notes_attachments_search_insert
AFTER INSERT ON notes_attachments
BEGIN
  DELETE FROM notes_search WHERE node_id = NEW.node_id;
  INSERT INTO notes_search (node_id, title, note, attachment_name)
  SELECT node.id, notes_image_search_title(node.title, node.node_kind, node.image_offset_utf16),
         node.note, COALESCE((SELECT group_concat(original_name, ' ') FROM notes_attachments
                              WHERE node_id = node.id), '')
  FROM notes_nodes node
  WHERE node.id = NEW.node_id AND node.deleted_at IS NULL AND node.archived_at IS NULL;
  DELETE FROM notes_search_lifecycle WHERE node_id = NEW.node_id;
  INSERT INTO notes_search_lifecycle (node_id, title, note, attachment_name)
  SELECT node.id, notes_image_search_title(node.title, node.node_kind, node.image_offset_utf16),
         node.note, COALESCE((SELECT group_concat(original_name, ' ') FROM notes_attachments
                              WHERE node_id = node.id), '')
  FROM notes_nodes node WHERE node.id = NEW.node_id;
END;
CREATE TRIGGER notes_attachments_search_update
AFTER UPDATE OF node_id, original_name ON notes_attachments
BEGIN
  DELETE FROM notes_search WHERE node_id IN (OLD.node_id, NEW.node_id);
  INSERT INTO notes_search (node_id, title, note, attachment_name)
  SELECT node.id, notes_image_search_title(node.title, node.node_kind, node.image_offset_utf16),
         node.note, COALESCE((SELECT group_concat(original_name, ' ') FROM notes_attachments
                              WHERE node_id = node.id), '')
  FROM notes_nodes node
  WHERE node.id IN (OLD.node_id, NEW.node_id)
    AND node.deleted_at IS NULL AND node.archived_at IS NULL;
  DELETE FROM notes_search_lifecycle WHERE node_id IN (OLD.node_id, NEW.node_id);
  INSERT INTO notes_search_lifecycle (node_id, title, note, attachment_name)
  SELECT node.id, notes_image_search_title(node.title, node.node_kind, node.image_offset_utf16),
         node.note, COALESCE((SELECT group_concat(original_name, ' ') FROM notes_attachments
                              WHERE node_id = node.id), '')
  FROM notes_nodes node WHERE node.id IN (OLD.node_id, NEW.node_id);
END;
CREATE TRIGGER notes_attachments_search_delete
AFTER DELETE ON notes_attachments
BEGIN
  DELETE FROM notes_search WHERE node_id = OLD.node_id;
  INSERT INTO notes_search (node_id, title, note, attachment_name)
  SELECT node.id, notes_image_search_title(node.title, node.node_kind, node.image_offset_utf16),
         node.note, COALESCE((SELECT group_concat(original_name, ' ') FROM notes_attachments
                              WHERE node_id = node.id), '')
  FROM notes_nodes node
  WHERE node.id = OLD.node_id AND node.deleted_at IS NULL AND node.archived_at IS NULL;
  DELETE FROM notes_search_lifecycle WHERE node_id = OLD.node_id;
  INSERT INTO notes_search_lifecycle (node_id, title, note, attachment_name)
  SELECT node.id, notes_image_search_title(node.title, node.node_kind, node.image_offset_utf16),
         node.note, COALESCE((SELECT group_concat(original_name, ' ') FROM notes_attachments
                              WHERE node_id = node.id), '')
  FROM notes_nodes node WHERE node.id = OLD.node_id;
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
