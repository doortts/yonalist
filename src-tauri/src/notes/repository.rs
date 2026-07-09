use crate::notes::types::{
    validate_note_id, CreateNodeInput, MoveNodeInput, NoteLayoutMode, NoteNode, NotesWorkspace,
    NotesWorkspaceScope, SplitNodeInput, UpdateNodeInput,
};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

const NOTES_SCHEMA_VERSION: i64 = 1;
const SORT_KEY_STEP: i64 = 1024;

pub(crate) fn notes_db_path(vault_path: &str) -> PathBuf {
    crate::metadata_dir(vault_path).join("notes.sqlite")
}

pub(crate) fn connect_notes_db(vault_path: &str) -> Result<Connection, String> {
    if vault_path.trim().is_empty() {
        return Err("Vault path must not be empty.".to_string());
    }

    let metadata = crate::metadata_dir(vault_path);
    fs::create_dir_all(&metadata)
        .map_err(|error| format!("Could not prepare Notes storage: {error}"))?;
    let mut connection = Connection::open(notes_db_path(vault_path))
        .map_err(|error| format!("Could not open Notes storage: {error}"))?;
    initialize_notes_db(&mut connection)?;
    Ok(connection)
}

fn initialize_notes_db(connection: &mut Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
            "#,
        )
        .map_err(|error| format!("Could not configure Notes storage: {error}"))?;

    let user_version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| format!("Could not read the Notes schema version: {error}"))?;

    match user_version {
        0 => migrate_to_version_one(connection),
        NOTES_SCHEMA_VERSION => Ok(()),
        version => Err(format!(
            "This Notes database uses unsupported schema version {version}."
        )),
    }
}

fn migrate_to_version_one(connection: &mut Connection) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not start the Notes database migration: {error}"))?;

    create_version_one_schema(&transaction)?;
    transaction
        .pragma_update(None, "user_version", NOTES_SCHEMA_VERSION)
        .map_err(|error| format!("Could not record the Notes schema version: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not finish the Notes database migration: {error}"))
}

fn create_version_one_schema(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            r#"
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
              deleted_at TEXT
            );

            CREATE INDEX notes_nodes_active_parent_order
              ON notes_nodes(parent_id, deleted_at, sort_key);

            CREATE TABLE notes_tags (
              node_id TEXT NOT NULL REFERENCES notes_nodes(id) ON DELETE CASCADE,
              tag TEXT NOT NULL,
              normalized_tag TEXT NOT NULL,
              PRIMARY KEY (node_id, normalized_tag)
            );

            CREATE INDEX notes_tags_normalized_tag ON notes_tags(normalized_tag);

            CREATE TABLE notes_preferences (
              key TEXT PRIMARY KEY,
              value_json TEXT NOT NULL
            );

            CREATE VIRTUAL TABLE notes_search USING fts5(
              node_id UNINDEXED,
              title,
              note,
              tokenize = 'unicode61'
            );

            CREATE TRIGGER notes_nodes_search_insert
            AFTER INSERT ON notes_nodes
            WHEN NEW.deleted_at IS NULL
            BEGIN
              INSERT INTO notes_search (node_id, title, note)
              VALUES (NEW.id, NEW.title, NEW.note);
            END;

            CREATE TRIGGER notes_nodes_search_update
            AFTER UPDATE OF title, note, deleted_at ON notes_nodes
            BEGIN
              DELETE FROM notes_search WHERE node_id = OLD.id;
              INSERT INTO notes_search (node_id, title, note)
              SELECT NEW.id, NEW.title, NEW.note
              WHERE NEW.deleted_at IS NULL;
            END;

            CREATE TRIGGER notes_nodes_search_delete
            AFTER DELETE ON notes_nodes
            BEGIN
              DELETE FROM notes_search WHERE node_id = OLD.id;
            END;
            "#,
        )
        .map_err(|error| format!("Could not migrate Notes storage to version one: {error}"))
}

#[derive(Clone)]
struct StoredNode {
    id: String,
    parent_id: Option<String>,
    sort_key: i64,
    title: String,
    note: String,
    layout_mode: String,
    is_collapsed: bool,
    is_starred: bool,
    completed_at: Option<String>,
    deleted_at: Option<String>,
}

fn stored_node_from_row(row: &Row<'_>) -> rusqlite::Result<StoredNode> {
    Ok(StoredNode {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        sort_key: row.get(2)?,
        title: row.get(3)?,
        note: row.get(4)?,
        layout_mode: row.get(5)?,
        is_collapsed: row.get::<_, i64>(6)? != 0,
        is_starred: row.get::<_, i64>(7)? != 0,
        completed_at: row.get(8)?,
        deleted_at: row.get(9)?,
    })
}

fn note_node_from_row(row: &Row<'_>) -> rusqlite::Result<NoteNode> {
    let layout_mode: String = row.get(5)?;
    let layout_mode = match layout_mode.as_str() {
        "bullets" => NoteLayoutMode::Bullets,
        value => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("Unsupported Notes layout mode: {value}"),
                )),
            ))
        }
    };

    Ok(NoteNode {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        sort_key: row.get(2)?,
        title: row.get(3)?,
        note: row.get(4)?,
        layout_mode,
        is_collapsed: row.get::<_, i64>(6)? != 0,
        is_starred: row.get::<_, i64>(7)? != 0,
        completed_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        deleted_at: row.get(11)?,
    })
}

pub(crate) fn load_workspace(
    connection: &Connection,
    scope: NotesWorkspaceScope,
) -> Result<NotesWorkspace, String> {
    let deleted_filter = match scope {
        NotesWorkspaceScope::Active => "deleted_at IS NULL",
        NotesWorkspaceScope::Trash => "deleted_at IS NOT NULL",
    };
    let mut statement = connection
        .prepare(&format!(
            "SELECT id, parent_id, sort_key, title, note, layout_mode, is_collapsed, \
                    is_starred, completed_at, created_at, updated_at, deleted_at \
             FROM notes_nodes WHERE {deleted_filter} \
             ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, parent_id, sort_key, id"
        ))
        .map_err(|error| format!("Could not prepare the Notes workspace: {error}"))?;
    let nodes = statement
        .query_map([], note_node_from_row)
        .map_err(|error| format!("Could not load the Notes workspace: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read the Notes workspace: {error}"))?;
    Ok(NotesWorkspace { nodes })
}

fn with_transaction<T>(
    connection: &mut Connection,
    operation: impl FnOnce(&Transaction<'_>) -> Result<T, String>,
) -> Result<T, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not start the Notes transaction: {error}"))?;
    let result = operation(&transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit the Notes transaction: {error}"))?;
    Ok(result)
}

fn node_by_id(transaction: &Transaction<'_>, node_id: &str) -> Result<Option<StoredNode>, String> {
    transaction
        .query_row(
            "SELECT id, parent_id, sort_key, title, note, layout_mode, is_collapsed, \
                    is_starred, completed_at, deleted_at \
             FROM notes_nodes WHERE id = ?1",
            [node_id],
            stored_node_from_row,
        )
        .optional()
        .map_err(|error| format!("Could not read Note node {node_id}: {error}"))
}

fn require_live_node(transaction: &Transaction<'_>, node_id: &str) -> Result<StoredNode, String> {
    match node_by_id(transaction, node_id)? {
        Some(node) if node.deleted_at.is_none() => Ok(node),
        Some(_) => Err(format!("Note node {node_id} is in the trash.")),
        None => Err(format!("Note node {node_id} does not exist.")),
    }
}

fn require_deleted_node(
    transaction: &Transaction<'_>,
    node_id: &str,
) -> Result<StoredNode, String> {
    match node_by_id(transaction, node_id)? {
        Some(node) if node.deleted_at.is_some() => Ok(node),
        Some(_) => Err(format!("Note node {node_id} is not in the trash.")),
        None => Err(format!("Note node {node_id} does not exist.")),
    }
}

fn ensure_fresh_id(transaction: &Transaction<'_>, node_id: &str) -> Result<(), String> {
    let exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_nodes WHERE id = ?1)",
            [node_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not validate the new Note ID: {error}"))?;
    if exists {
        Err(format!("Note ID {node_id} is already in use."))
    } else {
        Ok(())
    }
}

fn ensure_live_parent(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
) -> Result<(), String> {
    if let Some(parent_id) = parent_id {
        require_live_node(transaction, parent_id)?;
    }
    Ok(())
}

fn sibling_keys(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
    excluded_id: Option<&str>,
) -> Result<Vec<(String, i64)>, String> {
    let mut statement = transaction
        .prepare(
            "SELECT id, sort_key FROM notes_nodes \
             WHERE parent_id IS ?1 AND deleted_at IS NULL \
               AND (?2 IS NULL OR id <> ?2) \
             ORDER BY sort_key, id",
        )
        .map_err(|error| format!("Could not prepare sibling ordering: {error}"))?;
    let siblings = statement
        .query_map(params![parent_id, excluded_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|error| format!("Could not read sibling ordering: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not collect sibling ordering: {error}"))?;
    Ok(siblings)
}

fn rebalance_siblings(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
    excluded_id: Option<&str>,
) -> Result<(), String> {
    let siblings = sibling_keys(transaction, parent_id, excluded_id)?;
    for (index, (node_id, _)) in siblings.iter().enumerate() {
        let sort_key = i64::try_from(index + 1)
            .ok()
            .and_then(|position| position.checked_mul(SORT_KEY_STEP))
            .ok_or_else(|| "The Notes sibling ordering is too large to rebalance.".to_string())?;
        transaction
            .execute(
                "UPDATE notes_nodes \
                 SET sort_key = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?2",
                params![sort_key, node_id],
            )
            .map_err(|error| format!("Could not rebalance Note siblings: {error}"))?;
    }
    Ok(())
}

fn next_sort_key(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
    after_id: Option<&str>,
) -> Result<i64, String> {
    next_sort_key_excluding(transaction, parent_id, after_id, None)
}

fn next_sort_key_excluding(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
    after_id: Option<&str>,
    excluded_id: Option<&str>,
) -> Result<i64, String> {
    let siblings = sibling_keys(transaction, parent_id, excluded_id)?;
    let calculate = |siblings: &[(String, i64)]| -> Result<Option<i64>, String> {
        let Some(after_id) = after_id else {
            return match siblings.last() {
                Some((_, sort_key)) => Ok(sort_key.checked_add(SORT_KEY_STEP)),
                None => Ok(Some(SORT_KEY_STEP)),
            };
        };
        let index = siblings
            .iter()
            .position(|(node_id, _)| node_id == after_id)
            .ok_or_else(|| {
                "The requested afterId must identify a live sibling under the target parent."
                    .to_string()
            })?;
        let left = siblings[index].1;
        match siblings.get(index + 1) {
            Some((_, right)) => {
                let gap = i128::from(*right) - i128::from(left);
                if gap > 1 {
                    Ok(Some((i128::from(left) + gap / 2) as i64))
                } else {
                    Ok(None)
                }
            }
            None => Ok(left.checked_add(SORT_KEY_STEP)),
        }
    };

    if let Some(sort_key) = calculate(&siblings)? {
        return Ok(sort_key);
    }

    rebalance_siblings(transaction, parent_id, excluded_id)?;
    let rebalanced = sibling_keys(transaction, parent_id, excluded_id)?;
    calculate(&rebalanced)?.ok_or_else(|| {
        "Could not allocate a sparse Note sort key after rebalancing siblings.".to_string()
    })
}

fn extract_tags(title: &str, note: &str) -> BTreeMap<String, String> {
    let mut tags = BTreeMap::new();
    for text in [title, note] {
        let characters: Vec<char> = text.chars().collect();
        let mut index = 0;
        while index < characters.len() {
            if characters[index] != '#' {
                index += 1;
                continue;
            }
            let start = index + 1;
            let mut end = start;
            while end < characters.len()
                && (characters[end].is_alphanumeric()
                    || characters[end] == '_'
                    || characters[end] == '-')
            {
                end += 1;
            }
            if end > start {
                let tag: String = characters[start..end].iter().collect();
                tags.entry(tag.to_lowercase()).or_insert(tag);
            }
            index = end.max(index + 1);
        }
    }
    tags
}

fn replace_tags(
    transaction: &Transaction<'_>,
    node_id: &str,
    title: &str,
    note: &str,
) -> Result<(), String> {
    transaction
        .execute("DELETE FROM notes_tags WHERE node_id = ?1", [node_id])
        .map_err(|error| format!("Could not clear Note tags: {error}"))?;
    for (normalized_tag, tag) in extract_tags(title, note) {
        transaction
            .execute(
                "INSERT INTO notes_tags (node_id, tag, normalized_tag) VALUES (?1, ?2, ?3)",
                params![node_id, tag, normalized_tag],
            )
            .map_err(|error| format!("Could not store Note tags: {error}"))?;
    }
    Ok(())
}

pub(crate) fn create_node(
    connection: &mut Connection,
    input: CreateNodeInput,
) -> Result<(), String> {
    input.validate()?;
    with_transaction(connection, |transaction| {
        ensure_fresh_id(transaction, &input.id)?;
        ensure_live_parent(transaction, input.parent_id.as_deref())?;
        let sort_key = next_sort_key(
            transaction,
            input.parent_id.as_deref(),
            input.after_id.as_deref(),
        )?;
        transaction
            .execute(
                "INSERT INTO notes_nodes (\
                   id, parent_id, sort_key, title, note, created_at, updated_at\
                 ) VALUES (\
                   ?1, ?2, ?3, ?4, ?5, \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
                 )",
                params![input.id, input.parent_id, sort_key, input.title, input.note],
            )
            .map_err(|error| format!("Could not create the Note node: {error}"))?;
        replace_tags(transaction, &input.id, &input.title, &input.note)
    })
}

pub(crate) fn update_node(
    connection: &mut Connection,
    input: UpdateNodeInput,
) -> Result<(), String> {
    input.validate()?;
    with_transaction(connection, |transaction| {
        require_live_node(transaction, &input.id)?;
        transaction
            .execute(
                "UPDATE notes_nodes SET title = ?1, note = ?2, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?3 AND deleted_at IS NULL",
                params![input.title, input.note, input.id],
            )
            .map_err(|error| format!("Could not update the Note node: {error}"))?;
        replace_tags(transaction, &input.id, &input.title, &input.note)
    })
}

pub(crate) fn split_node(
    connection: &mut Connection,
    input: SplitNodeInput,
) -> Result<String, String> {
    input.validate()?;
    with_transaction(connection, |transaction| {
        let source = require_live_node(transaction, &input.id)?;
        ensure_fresh_id(transaction, &input.new_node_id)?;
        let sort_key = next_sort_key(
            transaction,
            source.parent_id.as_deref(),
            Some(source.id.as_str()),
        )?;
        transaction
            .execute(
                "UPDATE notes_nodes SET title = ?1, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?2 AND deleted_at IS NULL",
                params![input.prefix, source.id],
            )
            .map_err(|error| format!("Could not update the split Note node: {error}"))?;
        replace_tags(transaction, &source.id, &input.prefix, &source.note)?;
        transaction
            .execute(
                "INSERT INTO notes_nodes (\
                   id, parent_id, sort_key, title, created_at, updated_at\
                 ) VALUES (\
                   ?1, ?2, ?3, ?4, \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
                 )",
                params![input.new_node_id, source.parent_id, sort_key, input.suffix],
            )
            .map_err(|error| format!("Could not create the split Note node: {error}"))?;
        replace_tags(transaction, &input.new_node_id, &input.suffix, "")?;
        Ok(input.new_node_id.clone())
    })
}

fn live_descendant_exists(
    transaction: &Transaction<'_>,
    node_id: &str,
    candidate_id: &str,
) -> Result<bool, String> {
    transaction
        .query_row(
            "WITH RECURSIVE descendants(id) AS (\
               SELECT id FROM notes_nodes WHERE parent_id = ?1 AND deleted_at IS NULL \
               UNION ALL \
               SELECT child.id FROM notes_nodes child \
               JOIN descendants parent ON child.parent_id = parent.id \
               WHERE child.deleted_at IS NULL\
             ) \
             SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)",
            params![node_id, candidate_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not validate the Note move: {error}"))
}

pub(crate) fn move_node(connection: &mut Connection, input: MoveNodeInput) -> Result<(), String> {
    input.validate()?;
    with_transaction(connection, |transaction| {
        require_live_node(transaction, &input.id)?;
        ensure_live_parent(transaction, input.parent_id.as_deref())?;
        if let Some(parent_id) = input.parent_id.as_deref() {
            if live_descendant_exists(transaction, &input.id, parent_id)? {
                return Err("A Note node cannot be moved under a live descendant.".to_string());
            }
        }
        let sort_key = next_sort_key_excluding(
            transaction,
            input.parent_id.as_deref(),
            input.after_id.as_deref(),
            Some(&input.id),
        )?;
        transaction
            .execute(
                "UPDATE notes_nodes SET parent_id = ?1, sort_key = ?2, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?3 AND deleted_at IS NULL",
                params![input.parent_id, sort_key, input.id],
            )
            .map_err(|error| format!("Could not move the Note node: {error}"))?;
        Ok(())
    })
}

pub(crate) fn toggle_complete(connection: &mut Connection, node_id: &str) -> Result<(), String> {
    validate_note_id(node_id)?;
    with_transaction(connection, |transaction| {
        require_live_node(transaction, node_id)?;
        transaction
            .execute(
                "UPDATE notes_nodes SET \
                   completed_at = CASE WHEN completed_at IS NULL \
                     THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END, \
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?1 AND deleted_at IS NULL",
                [node_id],
            )
            .map_err(|error| format!("Could not toggle Note completion: {error}"))?;
        Ok(())
    })
}

pub(crate) fn toggle_collapsed(connection: &mut Connection, node_id: &str) -> Result<(), String> {
    validate_note_id(node_id)?;
    with_transaction(connection, |transaction| {
        require_live_node(transaction, node_id)?;
        transaction
            .execute(
                "UPDATE notes_nodes SET is_collapsed = CASE is_collapsed WHEN 0 THEN 1 ELSE 0 END, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?1 AND deleted_at IS NULL",
                [node_id],
            )
            .map_err(|error| format!("Could not toggle Note collapse: {error}"))?;
        Ok(())
    })
}

fn active_subtree(transaction: &Transaction<'_>, root_id: &str) -> Result<Vec<StoredNode>, String> {
    let mut statement = transaction
        .prepare(
            "WITH RECURSIVE subtree(id) AS (\
               SELECT id FROM notes_nodes WHERE id = ?1 AND deleted_at IS NULL \
               UNION ALL \
               SELECT child.id FROM notes_nodes child \
               JOIN subtree parent ON child.parent_id = parent.id \
               WHERE child.deleted_at IS NULL\
             ) \
             SELECT id, parent_id, sort_key, title, note, layout_mode, is_collapsed, \
                    is_starred, completed_at, deleted_at \
             FROM notes_nodes WHERE id IN subtree",
        )
        .map_err(|error| format!("Could not prepare the Note subtree: {error}"))?;
    let nodes = statement
        .query_map([root_id], stored_node_from_row)
        .map_err(|error| format!("Could not load the Note subtree: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read the Note subtree: {error}"))?;

    let mut by_id = nodes
        .into_iter()
        .map(|node| (node.id.clone(), node))
        .collect::<HashMap<_, _>>();
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for node in by_id.values() {
        if node.id != root_id {
            if let Some(parent_id) = &node.parent_id {
                children
                    .entry(parent_id.clone())
                    .or_default()
                    .push(node.id.clone());
            }
        }
    }
    for child_ids in children.values_mut() {
        child_ids.sort_by(|left, right| {
            let left_node = &by_id[left];
            let right_node = &by_id[right];
            left_node
                .sort_key
                .cmp(&right_node.sort_key)
                .then_with(|| left.cmp(right))
        });
    }

    fn visit(
        node_id: &str,
        by_id: &mut HashMap<String, StoredNode>,
        children: &HashMap<String, Vec<String>>,
        visited: &mut HashSet<String>,
        ordered: &mut Vec<StoredNode>,
    ) -> Result<(), String> {
        if !visited.insert(node_id.to_string()) {
            return Err("The Notes tree contains a cycle and cannot be duplicated.".to_string());
        }
        let node = by_id
            .remove(node_id)
            .ok_or_else(|| format!("Note node {node_id} disappeared while duplicating."))?;
        ordered.push(node);
        if let Some(child_ids) = children.get(node_id) {
            for child_id in child_ids {
                visit(child_id, by_id, children, visited, ordered)?;
            }
        }
        Ok(())
    }

    let mut ordered = Vec::new();
    visit(
        root_id,
        &mut by_id,
        &children,
        &mut HashSet::new(),
        &mut ordered,
    )?;
    Ok(ordered)
}

fn fresh_uuid_v4(
    transaction: &Transaction<'_>,
    reserved: &HashSet<String>,
) -> Result<String, String> {
    for _ in 0..16 {
        let id: String = transaction
            .query_row(
                "SELECT lower(\
                   hex(randomblob(4)) || '-' || hex(randomblob(2)) || \
                   '-4' || substr(hex(randomblob(2)), 2) || '-' || \
                   substr('89ab', (random() & 3) + 1, 1) || \
                   substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))\
                 )",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not generate a Note ID: {error}"))?;
        validate_note_id(&id)?;
        if !reserved.contains(&id) && node_by_id(transaction, &id)?.is_none() {
            return Ok(id);
        }
    }
    Err("Could not generate a unique Note ID.".to_string())
}

pub(crate) fn duplicate_node(connection: &mut Connection, node_id: &str) -> Result<String, String> {
    validate_note_id(node_id)?;
    with_transaction(connection, |transaction| {
        let source = require_live_node(transaction, node_id)?;
        let subtree = active_subtree(transaction, node_id)?;
        let root_sort_key = next_sort_key(
            transaction,
            source.parent_id.as_deref(),
            Some(source.id.as_str()),
        )?;

        let mut reserved = HashSet::new();
        let mut copied_ids = HashMap::new();
        for original in &subtree {
            let copied_id = fresh_uuid_v4(transaction, &reserved)?;
            reserved.insert(copied_id.clone());
            copied_ids.insert(original.id.clone(), copied_id);
        }

        for original in &subtree {
            let copied_id = copied_ids
                .get(&original.id)
                .expect("every duplicated node has a generated ID");
            let copied_parent_id = if original.id == source.id {
                source.parent_id.as_deref()
            } else {
                original
                    .parent_id
                    .as_ref()
                    .and_then(|parent_id| copied_ids.get(parent_id))
                    .map(String::as_str)
            };
            let sort_key = if original.id == source.id {
                root_sort_key
            } else {
                original.sort_key
            };
            transaction
                .execute(
                    "INSERT INTO notes_nodes (\
                       id, parent_id, sort_key, title, note, layout_mode, is_collapsed, \
                       is_starred, completed_at, created_at, updated_at\
                     ) VALUES (\
                       ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, \
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
                     )",
                    params![
                        copied_id,
                        copied_parent_id,
                        sort_key,
                        original.title,
                        original.note,
                        original.layout_mode,
                        original.is_collapsed,
                        original.is_starred,
                        original.completed_at
                    ],
                )
                .map_err(|error| format!("Could not duplicate the Note subtree: {error}"))?;
            replace_tags(transaction, copied_id, &original.title, &original.note)?;
        }

        copied_ids
            .get(node_id)
            .cloned()
            .ok_or_else(|| "Could not identify the duplicated Note root.".to_string())
    })
}

pub(crate) fn remove_empty_node(connection: &mut Connection, node_id: &str) -> Result<(), String> {
    validate_note_id(node_id)?;
    with_transaction(connection, |transaction| {
        let source = require_live_node(transaction, node_id)?;
        let children = sibling_keys(transaction, Some(node_id), None)?;
        if !children.is_empty() {
            let siblings = sibling_keys(transaction, source.parent_id.as_deref(), None)?;
            let mut desired_order = Vec::with_capacity(siblings.len() - 1 + children.len());
            for (sibling_id, _) in siblings {
                if sibling_id == node_id {
                    desired_order.extend(children.iter().map(|(child_id, _)| child_id.clone()));
                } else {
                    desired_order.push(sibling_id);
                }
            }
            for (index, sibling_id) in desired_order.iter().enumerate() {
                let sort_key = i64::try_from(index + 1)
                    .ok()
                    .and_then(|position| position.checked_mul(SORT_KEY_STEP))
                    .ok_or_else(|| {
                        "The Notes sibling ordering is too large to rewrite.".to_string()
                    })?;
                transaction
                    .execute(
                        "UPDATE notes_nodes SET parent_id = ?1, sort_key = ?2, \
                            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                         WHERE id = ?3 AND deleted_at IS NULL",
                        params![source.parent_id, sort_key, sibling_id],
                    )
                    .map_err(|error| {
                        format!("Could not reparent children of the empty Note node: {error}")
                    })?;
            }
        }
        transaction
            .execute(
                "UPDATE notes_nodes SET \
                   deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?1 AND deleted_at IS NULL",
                [node_id],
            )
            .map_err(|error| format!("Could not remove the empty Note node: {error}"))?;
        Ok(())
    })
}

pub(crate) fn soft_delete_node(connection: &mut Connection, node_id: &str) -> Result<(), String> {
    validate_note_id(node_id)?;
    with_transaction(connection, |transaction| {
        require_live_node(transaction, node_id)?;
        transaction
            .execute(
                "WITH RECURSIVE subtree(id) AS (\
                   SELECT id FROM notes_nodes WHERE id = ?1 AND deleted_at IS NULL \
                   UNION ALL \
                   SELECT child.id FROM notes_nodes child \
                   JOIN subtree parent ON child.parent_id = parent.id \
                   WHERE child.deleted_at IS NULL\
                 ) \
                 UPDATE notes_nodes SET \
                   deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id IN subtree",
                [node_id],
            )
            .map_err(|error| format!("Could not move the Note subtree to trash: {error}"))?;
        Ok(())
    })
}

fn resolve_restore_sort_collision(
    transaction: &Transaction<'_>,
    source: &StoredNode,
) -> Result<(), String> {
    let siblings = sibling_keys(transaction, source.parent_id.as_deref(), None)?;
    if !siblings
        .iter()
        .any(|(_, sort_key)| *sort_key == source.sort_key)
    {
        return Ok(());
    }

    let insert_at = siblings
        .iter()
        .position(|(_, sort_key)| *sort_key >= source.sort_key)
        .unwrap_or(siblings.len());
    let mut ordered_ids = siblings
        .into_iter()
        .map(|(node_id, _)| node_id)
        .collect::<Vec<_>>();
    ordered_ids.insert(insert_at, source.id.clone());
    for (index, node_id) in ordered_ids.iter().enumerate() {
        let sort_key = i64::try_from(index + 1)
            .ok()
            .and_then(|position| position.checked_mul(SORT_KEY_STEP))
            .ok_or_else(|| "The Notes sibling ordering is too large to restore.".to_string())?;
        transaction
            .execute(
                "UPDATE notes_nodes SET sort_key = ?1, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?2",
                params![sort_key, node_id],
            )
            .map_err(|error| format!("Could not reorder restored Note siblings: {error}"))?;
    }
    Ok(())
}

pub(crate) fn restore_node(connection: &mut Connection, node_id: &str) -> Result<(), String> {
    validate_note_id(node_id)?;
    with_transaction(connection, |transaction| {
        let source = require_deleted_node(transaction, node_id)?;
        let parent_is_live = match source.parent_id.as_deref() {
            Some(parent_id) => node_by_id(transaction, parent_id)?
                .is_some_and(|parent| parent.deleted_at.is_none()),
            None => true,
        };
        if !parent_is_live {
            let sort_key = next_sort_key(transaction, None, None)?;
            transaction
                .execute(
                    "UPDATE notes_nodes SET parent_id = NULL, sort_key = ?1 \
                     WHERE id = ?2 AND deleted_at IS NOT NULL",
                    params![sort_key, node_id],
                )
                .map_err(|error| {
                    format!("Could not restore the Note subtree at the root: {error}")
                })?;
        } else {
            resolve_restore_sort_collision(transaction, &source)?;
        }
        transaction
            .execute(
                "WITH RECURSIVE subtree(id) AS (\
                   SELECT id FROM notes_nodes WHERE id = ?1 \
                   UNION ALL \
                   SELECT child.id FROM notes_nodes child \
                   JOIN subtree parent ON child.parent_id = parent.id\
                 ) \
                 UPDATE notes_nodes SET deleted_at = NULL, \
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id IN subtree AND deleted_at IS NOT NULL",
                [node_id],
            )
            .map_err(|error| format!("Could not restore the Note subtree: {error}"))?;
        Ok(())
    })
}

pub(crate) fn empty_trash(connection: &mut Connection) -> Result<(), String> {
    with_transaction(connection, |transaction| {
        transaction
            .execute("DELETE FROM notes_nodes WHERE deleted_at IS NOT NULL", [])
            .map_err(|error| format!("Could not permanently empty Notes trash: {error}"))?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::{
        connect_notes_db, create_node, duplicate_node, empty_trash, initialize_notes_db,
        load_workspace, move_node, notes_db_path, remove_empty_node, restore_node,
        soft_delete_node, split_node, toggle_collapsed, toggle_complete, update_node,
    };
    use crate::notes::types::{
        validate_note_id, CreateNodeInput, MoveNodeInput, NotesWorkspaceScope, SplitNodeInput,
        UpdateNodeInput,
    };
    use rusqlite::{params, Connection};

    const NODE_ID: &str = "11111111-1111-4111-8111-111111111111";
    const CHILD_ID: &str = "22222222-2222-4222-8222-222222222222";
    const THIRD_ID: &str = "33333333-3333-4333-8333-333333333333";
    const FOURTH_ID: &str = "44444444-4444-4444-8444-444444444444";
    const FIFTH_ID: &str = "55555555-5555-4555-8555-555555555555";
    const SIXTH_ID: &str = "66666666-6666-4666-8666-666666666666";

    fn object_exists(connection: &Connection, object_type: &str, name: &str) -> bool {
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2)",
                params![object_type, name],
                |row| row.get(0),
            )
            .expect("schema object query")
    }

    fn test_connection() -> Connection {
        let mut connection = Connection::open_in_memory().expect("in-memory notes database");
        initialize_notes_db(&mut connection).expect("initialize notes database");
        connection
    }

    fn insert_node(
        connection: &Connection,
        id: &str,
        parent_id: Option<&str>,
        sort_key: i64,
        title: &str,
    ) -> String {
        connection
            .execute(
                "INSERT INTO notes_nodes (id, parent_id, sort_key, title, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')",
                params![id, parent_id, sort_key, title],
            )
            .expect("insert test node");
        id.to_string()
    }

    fn insert_tree(connection: &Connection) -> String {
        let root = insert_node(connection, NODE_ID, None, 1024, "root");
        insert_node(connection, CHILD_ID, Some(&root), 1024, "child");
        root
    }

    fn active_children(connection: &Connection, parent_id: Option<&str>) -> Vec<(String, i64)> {
        let mut statement = connection
            .prepare(
                "SELECT id, sort_key FROM notes_nodes \
                 WHERE parent_id IS ?1 AND deleted_at IS NULL \
                 ORDER BY sort_key, id",
            )
            .expect("prepare active children");
        statement
            .query_map([parent_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query active children")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect active children")
    }

    fn assert_tree_invariants(connection: &Connection) {
        let orphan_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_nodes child \
                 LEFT JOIN notes_nodes parent ON parent.id = child.parent_id \
                 WHERE child.deleted_at IS NULL AND child.parent_id IS NOT NULL \
                   AND (parent.id IS NULL OR parent.deleted_at IS NOT NULL)",
                [],
                |row| row.get(0),
            )
            .expect("live orphan count");
        assert_eq!(orphan_count, 0, "live nodes must have live parents");

        let duplicate_sort_keys: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM (\
                   SELECT parent_id, sort_key FROM notes_nodes \
                   WHERE deleted_at IS NULL GROUP BY parent_id, sort_key HAVING COUNT(*) > 1\
                 )",
                [],
                |row| row.get(0),
            )
            .expect("duplicate sibling sort keys");
        assert_eq!(duplicate_sort_keys, 0, "live sibling keys must be unique");
    }

    #[test]
    fn notes_database_uses_its_own_schema_and_fts_table() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_str().expect("path");
        let connection = connect_notes_db(vault_path).expect("connect notes");

        let node_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row.get(0))
            .expect("nodes table");
        assert_eq!(node_count, 0);
        assert_eq!(
            notes_db_path(vault_path),
            temp_dir.path().join(".yonalist/notes.sqlite")
        );
        assert!(notes_db_path(vault_path).exists());
        assert!(!temp_dir.path().join(".yonalist/index.sqlite").exists());

        for table in [
            "notes_nodes",
            "notes_tags",
            "notes_preferences",
            "notes_search",
        ] {
            assert!(
                object_exists(&connection, "table", table),
                "missing table {table}"
            );
        }
        for index in [
            "notes_nodes_active_parent_order",
            "notes_tags_normalized_tag",
        ] {
            assert!(
                object_exists(&connection, "index", index),
                "missing index {index}"
            );
        }
    }

    #[test]
    fn notes_connection_is_configured_and_migrated_to_version_one() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect notes");

        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal mode");
        let foreign_keys: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("foreign keys");
        let busy_timeout: i64 = connection
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .expect("busy timeout");
        let user_version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("user version");

        assert_eq!(journal_mode, "wal");
        assert_eq!(foreign_keys, 1);
        assert_eq!(busy_timeout, 5_000);
        assert_eq!(user_version, 1);
    }

    #[test]
    fn notes_connection_rejects_a_future_schema_version() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let path = notes_db_path(temp_dir.path().to_str().expect("path"));
        std::fs::create_dir_all(path.parent().expect("metadata dir")).expect("metadata dir");
        let connection = Connection::open(&path).expect("open future database");
        connection
            .pragma_update(None, "user_version", 2)
            .expect("future user version");
        drop(connection);

        let error = connect_notes_db(temp_dir.path().to_str().expect("path"))
            .expect_err("future schema must be rejected");
        assert!(error.contains("unsupported schema version 2"));
    }

    #[test]
    fn notes_search_tracks_active_node_content() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect notes");

        connection
            .execute(
                "INSERT INTO notes_nodes (id, sort_key, title, note, created_at, updated_at) \
                 VALUES (?1, 1024, 'Alpha', 'First note', '2026-07-10T00:00:00Z', '2026-07-10T00:00:00Z')",
                [NODE_ID],
            )
            .expect("insert node");
        let indexed_title: String = connection
            .query_row(
                "SELECT title FROM notes_search WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("indexed node");
        assert_eq!(indexed_title, "Alpha");

        connection
            .execute(
                "UPDATE notes_nodes SET title = 'Beta', deleted_at = '2026-07-10T01:00:00Z' WHERE id = ?1",
                [NODE_ID],
            )
            .expect("soft delete node");
        let deleted_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_search WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("deleted search count");
        assert_eq!(deleted_count, 0);

        connection
            .execute(
                "UPDATE notes_nodes SET deleted_at = NULL WHERE id = ?1",
                [NODE_ID],
            )
            .expect("restore node");
        let restored_title: String = connection
            .query_row(
                "SELECT title FROM notes_search WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("restored search node");
        assert_eq!(restored_title, "Beta");

        connection
            .execute("DELETE FROM notes_nodes WHERE id = ?1", [NODE_ID])
            .expect("delete node");
        let removed_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_search WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("removed search count");
        assert_eq!(removed_count, 0);
    }

    #[test]
    fn create_appends_or_inserts_after_a_sibling_and_rebalances_exhausted_gaps() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "first");
        insert_node(&connection, CHILD_ID, None, 1025, "second");

        create_node(
            &mut connection,
            CreateNodeInput {
                id: THIRD_ID.to_string(),
                parent_id: None,
                after_id: Some(NODE_ID.to_string()),
                title: "between".to_string(),
                note: String::new(),
            },
        )
        .expect("insert between roots");
        create_node(
            &mut connection,
            CreateNodeInput {
                id: FOURTH_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "last".to_string(),
                note: String::new(),
            },
        )
        .expect("append root");

        assert_eq!(
            active_children(&connection, None),
            vec![
                (NODE_ID.to_string(), 1024),
                (THIRD_ID.to_string(), 1536),
                (CHILD_ID.to_string(), 2048),
                (FOURTH_ID.to_string(), 3072),
            ]
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn invalid_create_input_does_not_mutate_the_tree() {
        let mut connection = test_connection();
        let error = create_node(
            &mut connection,
            CreateNodeInput {
                id: "not-a-uuid".to_string(),
                parent_id: None,
                after_id: None,
                title: "invalid".to_string(),
                note: String::new(),
            },
        )
        .expect_err("invalid ID");

        assert!(error.contains("UUID v4"));
        assert!(load_workspace(&connection, NotesWorkspaceScope::Active)
            .expect("active workspace")
            .nodes
            .is_empty());
    }

    #[test]
    fn move_rejects_a_descendant_as_the_new_parent() {
        let mut connection = test_connection();
        let root = insert_tree(&connection);

        let error = move_node(
            &mut connection,
            MoveNodeInput {
                id: root,
                parent_id: Some(CHILD_ID.to_string()),
                after_id: None,
            },
        )
        .expect_err("cycle");

        assert!(error.contains("descendant"));
        assert_tree_invariants(&connection);
    }

    #[test]
    fn move_rejects_the_node_itself_as_the_new_parent() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");

        let error = move_node(
            &mut connection,
            MoveNodeInput {
                id: NODE_ID.to_string(),
                parent_id: Some(NODE_ID.to_string()),
                after_id: None,
            },
        )
        .expect_err("self-parent cycle");

        assert!(error.contains("itself"));
        assert_eq!(active_children(&connection, None).len(), 1);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn move_can_reorder_siblings_and_promote_a_node_to_a_root() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root one");
        insert_node(&connection, CHILD_ID, None, 2048, "root two");
        insert_node(&connection, THIRD_ID, Some(NODE_ID), 1024, "child");

        move_node(
            &mut connection,
            MoveNodeInput {
                id: THIRD_ID.to_string(),
                parent_id: None,
                after_id: Some(NODE_ID.to_string()),
            },
        )
        .expect("promote child");
        move_node(
            &mut connection,
            MoveNodeInput {
                id: CHILD_ID.to_string(),
                parent_id: None,
                after_id: Some(NODE_ID.to_string()),
            },
        )
        .expect("reorder root");

        let roots = active_children(&connection, None);
        assert_eq!(
            roots.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec![NODE_ID, CHILD_ID, THIRD_ID]
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn split_is_atomic_and_places_the_suffix_immediately_after_the_source() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "original");
        insert_node(&connection, CHILD_ID, None, 2048, "following");

        let split_id = split_node(
            &mut connection,
            SplitNodeInput {
                id: NODE_ID.to_string(),
                new_node_id: THIRD_ID.to_string(),
                prefix: "alpha".to_string(),
                suffix: "beta".to_string(),
            },
        )
        .expect("split");

        assert_eq!(split_id, THIRD_ID);
        let roots = active_children(&connection, None);
        assert_eq!(
            roots.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec![NODE_ID, THIRD_ID, CHILD_ID]
        );
        let source_title: String = connection
            .query_row(
                "SELECT title FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("source title");
        assert_eq!(source_title, "alpha");

        connection
            .execute_batch(&format!(
                "CREATE TRIGGER reject_split_insert BEFORE INSERT ON notes_nodes \
                 WHEN NEW.id = '{FOURTH_ID}' BEGIN SELECT RAISE(ABORT, 'split rejected'); END;"
            ))
            .expect("rejecting trigger");
        let error = split_node(
            &mut connection,
            SplitNodeInput {
                id: NODE_ID.to_string(),
                new_node_id: FOURTH_ID.to_string(),
                prefix: "changed".to_string(),
                suffix: "rejected".to_string(),
            },
        )
        .expect_err("split must roll back");
        assert!(error.contains("split rejected"));
        let rolled_back_title: String = connection
            .query_row(
                "SELECT title FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("rolled back title");
        assert_eq!(rolled_back_title, "alpha");
    }

    #[test]
    fn remove_empty_node_reparents_children_at_the_removed_position() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "parent");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "before");
        insert_node(&connection, THIRD_ID, Some(NODE_ID), 2048, "");
        insert_node(&connection, FOURTH_ID, Some(THIRD_ID), 1024, "child one");
        insert_node(&connection, FIFTH_ID, Some(THIRD_ID), 2048, "child two");
        insert_node(&connection, SIXTH_ID, Some(NODE_ID), 3072, "after");

        remove_empty_node(&mut connection, THIRD_ID).expect("remove empty node");

        let children = active_children(&connection, Some(NODE_ID));
        assert_eq!(
            children
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>(),
            vec![CHILD_ID, FOURTH_ID, FIFTH_ID, SIXTH_ID]
        );
        let removed_deleted_at: Option<String> = connection
            .query_row(
                "SELECT deleted_at FROM notes_nodes WHERE id = ?1",
                [THIRD_ID],
                |row| row.get(0),
            )
            .expect("removed node");
        assert!(removed_deleted_at.is_some());
        assert_tree_invariants(&connection);
    }

    #[test]
    fn duplicate_node_deep_copies_with_fresh_ids_after_the_source_root() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "child");
        insert_node(&connection, THIRD_ID, Some(CHILD_ID), 1024, "grandchild");
        insert_node(&connection, FOURTH_ID, None, 2048, "following root");

        let copied_root = duplicate_node(&mut connection, NODE_ID).expect("duplicate subtree");

        assert_ne!(copied_root, NODE_ID);
        validate_note_id(&copied_root).expect("copied root UUID");
        let roots = active_children(&connection, None);
        assert_eq!(roots[0].0, NODE_ID);
        assert_eq!(roots[1].0, copied_root);
        assert_eq!(roots[2].0, FOURTH_ID);

        let copied_children = active_children(&connection, Some(&copied_root));
        assert_eq!(copied_children.len(), 1);
        assert_ne!(copied_children[0].0, CHILD_ID);
        validate_note_id(&copied_children[0].0).expect("copied child UUID");
        let copied_grandchildren = active_children(&connection, Some(&copied_children[0].0));
        assert_eq!(copied_grandchildren.len(), 1);
        assert_ne!(copied_grandchildren[0].0, THIRD_ID);
        validate_note_id(&copied_grandchildren[0].0).expect("copied grandchild UUID");
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Active)
                .expect("active workspace")
                .nodes
                .len(),
            7
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn deleting_a_node_hides_the_live_subtree_from_workspace_and_search_then_restores_it() {
        let mut connection = test_connection();
        let root = insert_tree(&connection);

        soft_delete_node(&mut connection, &root).expect("delete");
        assert!(load_workspace(&connection, NotesWorkspaceScope::Active)
            .expect("active")
            .nodes
            .is_empty());
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Trash)
                .expect("trash")
                .nodes
                .len(),
            2
        );
        let search_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_search", [], |row| row.get(0))
            .expect("search count after delete");
        assert_eq!(search_count, 0);

        restore_node(&mut connection, &root).expect("restore");
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Active)
                .expect("active")
                .nodes
                .len(),
            2
        );
        let restored_search_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_search", [], |row| row.get(0))
            .expect("search count after restore");
        assert_eq!(restored_search_count, 2);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn restoring_a_subtree_uses_the_root_when_its_parent_remains_deleted() {
        let mut connection = test_connection();
        let root = insert_tree(&connection);
        insert_node(&connection, THIRD_ID, Some(CHILD_ID), 1024, "grandchild");
        soft_delete_node(&mut connection, &root).expect("delete tree");

        restore_node(&mut connection, CHILD_ID).expect("restore child subtree");

        let child_parent: Option<String> = connection
            .query_row(
                "SELECT parent_id FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| row.get(0),
            )
            .expect("restored child parent");
        assert_eq!(child_parent, None);
        assert_eq!(active_children(&connection, Some(CHILD_ID)).len(), 1);
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Trash)
                .expect("trash")
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![NODE_ID]
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn restore_rebalances_when_a_live_sibling_occupies_the_original_sort_key() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "parent");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "trashed child");
        soft_delete_node(&mut connection, CHILD_ID).expect("delete child");
        create_node(
            &mut connection,
            CreateNodeInput {
                id: THIRD_ID.to_string(),
                parent_id: Some(NODE_ID.to_string()),
                after_id: None,
                title: "replacement child".to_string(),
                note: String::new(),
            },
        )
        .expect("occupy old sort key");

        restore_node(&mut connection, CHILD_ID).expect("restore child");

        assert_eq!(
            active_children(&connection, Some(NODE_ID)),
            vec![(CHILD_ID.to_string(), 1024), (THIRD_ID.to_string(), 2048)]
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn empty_trash_permanently_removes_only_deleted_rows() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "active");
        insert_node(&connection, CHILD_ID, None, 2048, "trash root");
        insert_node(&connection, THIRD_ID, Some(CHILD_ID), 1024, "trash child");
        soft_delete_node(&mut connection, CHILD_ID).expect("delete subtree");

        empty_trash(&mut connection).expect("empty trash");

        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Active)
                .expect("active")
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![NODE_ID]
        );
        assert!(load_workspace(&connection, NotesWorkspaceScope::Trash)
            .expect("trash")
            .nodes
            .is_empty());
        let row_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row.get(0))
            .expect("remaining rows");
        assert_eq!(row_count, 1);
    }

    #[test]
    fn update_and_toggles_refresh_content_search_tags_and_flags() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "before");

        update_node(
            &mut connection,
            UpdateNodeInput {
                id: NODE_ID.to_string(),
                title: "After #Project".to_string(),
                note: "Details #project #Next-Step".to_string(),
            },
        )
        .expect("update node");
        toggle_complete(&mut connection, NODE_ID).expect("complete node");
        toggle_collapsed(&mut connection, NODE_ID).expect("collapse node");

        let node = load_workspace(&connection, NotesWorkspaceScope::Active)
            .expect("active workspace")
            .nodes
            .pop()
            .expect("updated node");
        assert_eq!(node.title, "After #Project");
        assert!(node.completed_at.is_some());
        assert!(node.is_collapsed);
        let indexed_note: String = connection
            .query_row(
                "SELECT note FROM notes_search WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("indexed note");
        assert_eq!(indexed_note, "Details #project #Next-Step");
        let tags = connection
            .prepare(
                "SELECT normalized_tag FROM notes_tags WHERE node_id = ?1 ORDER BY normalized_tag",
            )
            .expect("prepare tags")
            .query_map([NODE_ID], |row| row.get::<_, String>(0))
            .expect("query tags")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect tags");
        assert_eq!(tags, vec!["next-step", "project"]);
    }
}
