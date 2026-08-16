//! Writing the rows back out as files.
//!
//! Two rules carry this one.
//!
//! What was just rendered has to read back as the same document before any of
//! it reaches disk. A file the parser would refuse stops that document
//! travelling at all — every device quarantines it — which is far worse than a
//! file that is briefly out of date.
//!
//! And a file that changed since this app last wrote it is never overwritten.
//! That is somebody's edit, made in another editor or arrived through the sync
//! folder, and replacing it would take it without a word. The merge sees it
//! first; the next export writes what the merge decided.

use crate::document::{
    DocumentId, DocumentNode, DocumentRoot, ImageReference, Marker, NodeBody, PageDocument,
    VaultFile,
};
use crate::file_io::write_atomic;
use crate::layout::page_folder_name;
use crate::parse::parse;
use crate::render::render;
use rusqlite::{OptionalExtension, Transaction};
use std::collections::BTreeMap;
use std::path::Path;

pub type ExportError = String;

#[derive(Clone, Debug, Default)]
pub struct ExportOutcome {
    /// False when the bytes already on disk are the bytes this would write, and
    /// false when somebody else's edit is sitting there.
    pub written: bool,
    /// The file on disk is not what this app last wrote, so it holds an edit
    /// nobody has merged yet.
    pub needs_merge: bool,
    pub path: String,
}

/// SHA-256 in hex — the same shape `sync_documents.exported_hash` holds, so the
/// watcher can tell this app's own write from anybody else's.
pub fn hash_bytes(bytes: &[u8]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn export_document(
    transaction: &Transaction<'_>,
    vault_root: &Path,
    root_id: &str,
) -> Result<ExportOutcome, ExportError> {
    let relative = document_path(transaction, root_id)?;
    // Before the rows are read, because it can put a reading back.
    settle_readings(transaction, root_id)?;
    let document = load_document(transaction, root_id, folder_of(&relative))?;
    let outcome = write_checked(
        transaction,
        vault_root,
        root_id,
        &relative,
        &VaultFile::Page(document),
    )?;
    if outcome.written || !outcome.needs_merge {
        clear_dirty(transaction, root_id)?;
        // Only now, and only for a file that was actually written or already
        // said the same thing. Recording a reading no file carries would have
        // this device put that reading back later — onto rows every other
        // device holds at a different one.
        record_readings(transaction, root_id)?;
    }
    Ok(outcome)
}

/// Render, prove it reads back, and only then decide whether the bytes may
/// replace what is on disk. Every document goes through here.
fn write_checked(
    transaction: &Transaction<'_>,
    vault_root: &Path,
    root_id: &str,
    relative: &str,
    file: &VaultFile,
) -> Result<ExportOutcome, ExportError> {
    // The root the guarded read checks against has to be the resolved one:
    // a temporary directory reached through a symlink would otherwise read as
    // outside its own vault.
    let vault_root = &std::fs::canonicalize(vault_root)
        .map_err(|error| format!("Could not resolve the vault: {error}"))?;
    let bytes = render(file)?;

    // Invariant 4, before anything touches the disk: a document that cannot be
    // read back is one every device would quarantine.
    let read_back = parse(&bytes).map_err(|reason| {
        format!("The document this app just rendered could not be read back: {reason}")
    })?;
    let again = render(&read_back)?;
    if again != bytes {
        return Err("The document this app just rendered did not survive a read back.".to_owned());
    }

    let relative = relative.to_owned();
    let path = vault_root.join(&relative);
    let hash = hash_bytes(&bytes);
    let recorded = recorded_hash(transaction, root_id)?;

    if let Ok(existing) =
        crate::file_io::read_regular_bounded(vault_root, &path, crate::parse::MAX_FILE_BYTES)
    {
        let existing_hash = hash_bytes(&existing);
        if existing_hash == hash {
            // The same bytes going out again would look like an edit to every
            // other device.
            record_document(transaction, root_id, &relative, &hash, stat_of(&path))?;
            return Ok(ExportOutcome {
                written: false,
                needs_merge: false,
                path: relative,
            });
        }
        if recorded.as_deref() != Some(existing_hash.as_str()) {
            // Somebody edited it. Not ours to replace.
            return Ok(ExportOutcome {
                written: false,
                needs_merge: true,
                path: relative,
            });
        }
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not make the page's folder: {error}"))?;
    }
    write_atomic(vault_root, &path, &bytes)?;
    // Read back after the write, not guessed from the bytes: the size on disk
    // is the size the scan will stat, and the reading is the filesystem's to
    // give. A gate comparing this app's guess with the disk's answer would
    // report a change on every launch.
    record_document(transaction, root_id, &relative, &hash, stat_of(&path))?;
    Ok(ExportOutcome {
        written: true,
        needs_merge: false,
        path: relative,
    })
}

/// Which documents the waiting rows belong to.
///
/// One statement, not one per row: a vault where every edit costs a walk up the
/// tree is a vault that stops keeping up with typing. A row belongs to the
/// nearest ancestor that owns a document — a page root, or home — and a deleted
/// row belongs to the trash whatever page it used to sit in.
pub fn pending_documents(transaction: &Transaction<'_>) -> Result<Vec<String>, ExportError> {
    let mut statement = transaction
        .prepare_cached(
            "WITH RECURSIVE climb(node_id, at, deleted) AS (
                 SELECT d.node_id, n.id, n.deleted
                 FROM sync_dirty_nodes d JOIN notes_nodes n ON n.id = d.node_id
                 UNION ALL
                 SELECT climb.node_id, p.id, climb.deleted
                 FROM climb JOIN notes_nodes n ON n.id = climb.at
                 JOIN notes_nodes p ON p.id = n.parent_id
                 WHERE n.parent_id IS NOT NULL AND n.parent_id <> 'root'
                   -- A node that owns a document of its own is where the climb
                   -- ends: its subtree is that document's, not its parent's.
                   AND NOT EXISTS (
                       SELECT 1 FROM sync_documents d
                       WHERE d.root_id = climb.at AND d.retiring = 0
                   )
             )
             -- A deleted row belongs to the trash *and* to the page it left:
             -- that page's file still carries its line until it is rewritten.
             SELECT DISTINCT at FROM climb
             WHERE at = 'root'
                OR EXISTS (SELECT 1 FROM sync_documents d
                           WHERE d.root_id = at AND d.retiring = 0)
                OR (SELECT parent_id FROM notes_nodes WHERE id = at) = 'root'
             UNION
             SELECT 'yonalist-trash' FROM climb WHERE deleted = 1
             ORDER BY 1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|error| error.to_string())?);
    }
    Ok(out)
}

/// The vault's index. Home is not a page: every top-level page is one link
/// line, and their contents live in their own folders. What the line grants is
/// existence and order — a page's own file owns everything else about it.
pub fn export_home(
    transaction: &Transaction<'_>,
    vault_root: &Path,
) -> Result<ExportOutcome, ExportError> {
    let mut statement = transaction
        .prepare_cached(
            "SELECT n.id, n.text, n.hlc, d.folder_path, n.sync_prev, n.sync_prev_hlc
             FROM notes_nodes n
             LEFT JOIN sync_documents d ON d.root_id = n.id
             WHERE n.parent_id = 'root' AND n.deleted = 0
             ORDER BY n.sort_key, n.id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut nodes = Vec::new();
    for row in rows {
        let (id, title, hlc, folder, prev, prev_hlc) = row.map_err(|error| error.to_string())?;
        let path = match folder {
            Some(folder) => folder,
            None => format!("{}/README.md", page_folder_name(&title, &id)?),
        };
        nodes.push(DocumentNode {
            id,
            hlc,
            body: NodeBody::Split { title, path },
            note: String::new(),
            marker: Marker::Bullet,
            collapsed: false,
            completed: false,
            starred: false,
            from: None,
            // Where a page sits is stated on this line, so the claim travels
            // with it — home is the file that owns page order.
            place: Some((prev, prev_hlc)),
            unknown_tokens: Vec::new(),
            children: Vec::new(),
        });
    }
    let root_hlc: String = transaction
        .prepare_cached("SELECT hlc FROM notes_nodes WHERE id = 'root'")
        .and_then(|mut statement| statement.query_row([], |row| row.get(0)))
        .map_err(|error| error.to_string())?;
    let title: String = transaction
        .prepare_cached("SELECT text FROM notes_nodes WHERE id = 'root'")
        .and_then(|mut statement| statement.query_row([], |row| row.get(0)))
        .map_err(|error| error.to_string())?;
    let max_hlc = nodes
        .iter()
        .map(|node| node.hlc.clone())
        .max()
        .unwrap_or_default()
        .max(root_hlc.clone());
    let document = PageDocument {
        id: DocumentId::Home,
        parent: None,
        sort_key: None,
        max_hlc,
        root: DocumentRoot {
            title,
            hlc: root_hlc,
            ..DocumentRoot::default()
        },
        nodes,
        unknown_frontmatter: Vec::new(),
    };
    let outcome = write_checked(
        transaction,
        vault_root,
        "root",
        "README.md",
        &VaultFile::Page(document),
    )?;
    if !outcome.needs_merge {
        // Its own row only. Home's children each own a file of their own, and
        // clearing those here would drop marks nothing has written out yet.
        transaction
            .prepare_cached("DELETE FROM sync_dirty_nodes WHERE node_id = 'root'")
            .and_then(|mut statement| statement.execute([]))
            .map_err(|error| error.to_string())?;
    }
    Ok(outcome)
}

/// Folders for pages that no longer exist. A vault folder is something the user
/// opens, so one standing for a page that is gone tells them they still have it.
pub fn retire_missing_documents(
    transaction: &Transaction<'_>,
    vault_root: &Path,
) -> Result<Vec<String>, ExportError> {
    let vault_root = &std::fs::canonicalize(vault_root)
        .map_err(|error| format!("Could not resolve the vault: {error}"))?;
    let mut statement = transaction
        .prepare_cached(
            "SELECT d.root_id, d.folder_path FROM sync_documents d
             LEFT JOIN notes_nodes n ON n.id = d.root_id
             WHERE d.root_id NOT IN ('root', 'yonalist-trash')
               -- Gone, deleted, or on its way out: a folder standing for
               -- something that is not a page any more tells the user they
               -- still have one. A document marked as leaving has just had its
               -- subtree written into the page it joined, which is what makes
               -- this the moment its folder can go.
               AND (n.id IS NULL OR n.deleted = 1
                    OR (d.retiring = 1
                        -- Its notes have actually landed: the page that took
                        -- them in was written, which is what clears the mark.
                        -- A page somebody had open in an editor is not written
                        -- that pass, and the folder waits for the one that is.
                        AND NOT EXISTS (
                            SELECT 1 FROM sync_dirty_nodes q WHERE q.node_id = d.root_id
                        )))
               -- A folder holding another document's file is not this one's to
               -- remove. Split documents live inside their page's folder, and
               -- taking the folder would take their files with it.
               AND NOT EXISTS (
                   SELECT 1 FROM sync_documents inner_d
                   WHERE inner_d.root_id <> d.root_id
                     AND inner_d.retiring = 0
                     AND inner_d.folder_path LIKE rtrim(d.folder_path, replace(
                         d.folder_path, '/', '')) || '%'
               )",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut found = Vec::new();
    for row in rows {
        found.push(row.map_err(|error| error.to_string())?);
    }

    let mut retired = Vec::new();
    for (root_id, folder_path) in found {
        // Resolved, not merely prefixed: a recorded path is a value the watcher
        // supplied, and `..` in it would walk a plain prefix check straight out
        // of the vault with a recursive delete behind it.
        let folder = std::path::Path::new(&folder_path)
            .parent()
            .map(|parent| vault_root.join(parent));
        if let Some(folder) = folder
            && folder.is_dir()
            && let Ok(resolved) = crate::file_io::resolve_inside(vault_root, &folder)
            && &resolved != vault_root
        {
            std::fs::remove_dir_all(&resolved)
                .map_err(|error| format!("Could not clear a retired folder: {error}"))?;
        }
        retired.push(root_id);
    }
    for root_id in &retired {
        transaction
            .prepare_cached("DELETE FROM sync_documents WHERE root_id = ?1")
            .and_then(|mut statement| statement.execute([root_id]))
            .map_err(|error| error.to_string())?;
    }
    Ok(retired)
}

/// A page dragged under another page is not gone: its notes belong to the page
/// it joined, and that page has not said so yet. Taking the folder now would
/// leave the whole subtree in no file at all, so the document is marked as
/// leaving instead — nothing reads it as a document from here on, which is
/// what makes the next render put its subtree inside its new home — and it is
/// queued so that render happens in this same pass.
///
/// Called before the documents are written; `retire_missing_documents`
/// finishes the job after them.
pub fn begin_retirement(transaction: &Transaction<'_>) -> Result<usize, ExportError> {
    // A node that became a page again — dragged back out, or an undo — is a
    // document once more. Left marked, its file would never be written again.
    transaction
        .prepare_cached(
            "UPDATE sync_documents SET retiring = 0
             WHERE retiring = 1
               AND root_id IN (SELECT id FROM notes_nodes
                               WHERE parent_id = 'root' AND deleted = 0)",
        )
        .and_then(|mut statement| statement.execute([]))
        .map_err(|error| error.to_string())?;
    let mut statement = transaction
        .prepare_cached(
            "SELECT d.root_id FROM sync_documents d
             JOIN notes_nodes n ON n.id = d.root_id
             WHERE d.root_id NOT IN ('root', 'yonalist-trash')
               -- Pages only. A split document is *supposed* to sit under a
               -- node that is not root; it never was a page and cannot stop
               -- being one.
               AND d.is_page = 1
               AND d.retiring = 0 AND n.deleted = 0 AND n.parent_id IS NOT 'root'",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut leaving = Vec::new();
    for row in rows {
        leaving.push(row.map_err(|error| error.to_string())?);
    }
    for root_id in &leaving {
        transaction
            .prepare_cached("UPDATE sync_documents SET retiring = 1 WHERE root_id = ?1")
            .and_then(|mut statement| statement.execute([root_id]))
            .map_err(|error| error.to_string())?;
        transaction
            .prepare_cached(
                "INSERT INTO sync_dirty_nodes(node_id, marked_at) VALUES (?1, unixepoch())
                 ON CONFLICT(node_id) DO NOTHING",
            )
            .and_then(|mut statement| statement.execute([root_id]))
            .map_err(|error| error.to_string())?;
    }
    Ok(leaving.len())
}

/// The trash, which is the only evidence a deletion ever gets: a node simply
/// missing from a page's file says nothing at all.
///
/// No entries means no file. Absence is what "nothing was deleted" looks like,
/// and a file that still said something was deleted would keep deleting it.
pub fn export_trash(
    transaction: &Transaction<'_>,
    vault_root: &Path,
) -> Result<ExportOutcome, ExportError> {
    let relative = ".yonalist/trash.md".to_owned();
    let path = vault_root.join(&relative);
    let nodes = load_trash(transaction, folder_of(&relative))?;
    if nodes.is_empty() {
        let existed = path.exists();
        if existed {
            std::fs::remove_file(&path)
                .map_err(|error| format!("Could not clear the trash file: {error}"))?;
        }
        return Ok(ExportOutcome {
            written: false,
            needs_merge: false,
            path: relative,
        });
    }
    let max_hlc = nodes.iter().map(highest).max().unwrap_or_default();
    let ids: Vec<String> = nodes.iter().flat_map(collect_ids).collect();
    let outcome = write_checked(
        transaction,
        vault_root,
        "yonalist-trash",
        &relative,
        &VaultFile::Trash(crate::document::TrashDocument { max_hlc, nodes }),
    )?;
    if !outcome.needs_merge {
        // The deleted rows this file just stated. No page clears them: their
        // lines live here, and losing the marks would lose the evidence.
        let list = json_list(&ids);
        transaction
            .prepare_cached(
                "DELETE FROM sync_dirty_nodes
                 WHERE node_id IN (SELECT value FROM json_each(?1))",
            )
            .and_then(|mut statement| statement.execute([list]))
            .map_err(|error| error.to_string())?;
    }
    Ok(outcome)
}

fn collect_ids(node: &DocumentNode) -> Vec<String> {
    let mut ids = vec![node.id.clone()];
    for child in &node.children {
        ids.extend(collect_ids(child));
    }
    ids
}

/// SQLite has no array parameter, so a list of ids travels as JSON and comes
/// back apart through `json_each`.
pub fn json_list(ids: &[String]) -> String {
    let mut json = String::from("[");
    for (index, id) in ids.iter().enumerate() {
        if index > 0 {
            json.push(',');
        }
        json.push('"');
        json.push_str(&id.replace('\\', "\\\\").replace('"', "\\\""));
        json.push('"');
    }
    json.push(']');
    json
}

/// What the trash holds: every deleted node whose parent is still alive, with
/// the children that went down with it.
fn load_trash(
    transaction: &Transaction<'_>,
    document_folder: &str,
) -> Result<Vec<DocumentNode>, ExportError> {
    let mut statement = transaction
        .prepare_cached(
            "SELECT n.id, n.parent_id, n.sort_key, n.text, n.note, n.marker, n.ordered_start,
                    n.collapsed, n.completed, n.starred, n.hlc, n.sync_extras,
                    p.deleted IS NOT 1, n.kind, NULLIF(a.location, '') AS location,
                    i.content_hash, i.mime_type, i.relative_path, i.original_name,
                    i.display_width, i.pixel_width, i.pixel_height, i.byte_length
             FROM notes_nodes n
             LEFT JOIN notes_nodes p ON p.id = n.parent_id
             LEFT JOIN notes_images i ON i.node_id = n.id
             LEFT JOIN sync_assets a ON a.content_hash = i.content_hash
             -- A row waiting for the document that will describe it carries no
             -- stamp, and nothing can render that. It has nothing to say yet.
             WHERE n.deleted = 1 AND n.hlc <> ''
             ORDER BY n.sort_key, n.id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, bool>(12)?,
                DocumentNode {
                    id: row.get(0)?,
                    hlc: row.get(10)?,
                    body: match trash_asset(row)? {
                        Some(location) if row.get::<_, String>("kind")? == "image" => {
                            NodeBody::Image(image_of(row, location, document_folder)?)
                        }
                        _ => NodeBody::Text(row.get(3)?),
                    },
                    note: row.get(4)?,
                    marker: marker_of(&row.get::<_, String>(5)?, row.get(6)?),
                    collapsed: row.get::<_, i64>(7)? == 1,
                    completed: row.get::<_, i64>(8)? == 1,
                    starred: row.get::<_, i64>(9)? == 1,
                    from: None,
                    place: None,
                    unknown_tokens: {
                        let extras: String = row.get(11)?;
                        if extras.is_empty() {
                            Vec::new()
                        } else {
                            extras.split(' ').map(str::to_owned).collect()
                        }
                    },
                    children: Vec::new(),
                },
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut roots = Vec::new();
    let mut children: BTreeMap<String, Vec<DocumentNode>> = BTreeMap::new();
    for row in rows {
        let (parent, sort_key, parent_alive, mut node) = row.map_err(|error| error.to_string())?;
        if parent_alive {
            // A trash root says where it was taken from; its children came with
            // it and their line says where they sit.
            node.from = Some((parent.clone(), sort_key));
            roots.push(node);
        } else {
            children.entry(parent).or_default().push(node);
        }
    }
    for root in &mut roots {
        attach(&mut children, root);
    }
    Ok(roots)
}

/// Where a trashed picture's bytes are to be linked from, or `None` when the
/// row is not a picture at all.
///
/// A trashed picture's bytes belong in the vault's own store whatever page the
/// note came from — `plan_placement` sends them there for any holder that is
/// deleted — so every answer here names that store. Which name is the question,
/// and there are three rows to tell apart:
///
/// - placed: the placement pass has said where the file is, and that is the
///   answer;
/// - bytes but no placement, because carrying them failed: the name is the rule
///   the placement would have applied, not the app store's own hash name, which
///   no other device could ever match to these bytes;
/// - still waiting: the row holds the link some *other* document wrote, which
///   is not a place in this vault — read as one it would climb out of it, a
///   folder further each round. Only its file name means anything, and that is
///   the part every device agrees on.
fn trash_asset(row: &rusqlite::Row<'_>) -> rusqlite::Result<Option<String>> {
    if let Some(location) = row.get::<_, Option<String>>("location")? {
        return Ok(Some(location));
    }
    let Some(content_hash) = row.get::<_, Option<String>>("content_hash")? else {
        return Ok(None);
    };
    let name = if content_hash.is_empty() {
        let waiting: String = row.get("relative_path")?;
        waiting.rsplit('/').next().unwrap_or_default().to_owned()
    } else {
        crate::layout::asset_disk_name(
            &row.get::<_, String>("original_name")?,
            &content_hash,
            &row.get::<_, String>("mime_type")?,
        )
    };
    Ok(Some(format!("assets/{name}")))
}

/// The picture a line states, linked from the folder its document sits in. The
/// columns are read by name so that the two callers' different SELECTs — which
/// share these columns and nothing else — cannot drift out from under it.
fn image_of(
    row: &rusqlite::Row<'_>,
    location: String,
    document_folder: &str,
) -> rusqlite::Result<ImageReference> {
    Ok(ImageReference {
        path: crate::attachments::Placement {
            location,
            moves: Vec::new(),
        }
        .link_from(document_folder),
        original_name: row.get("original_name")?,
        display_width: row.get::<_, i64>("display_width")? as u32,
        pixel_width: row.get::<_, i64>("pixel_width")? as u32,
        pixel_height: row.get::<_, i64>("pixel_height")? as u32,
        byte_size: row.get::<_, i64>("byte_length")? as u64,
        unknown_tokens: Vec::new(),
    })
}

fn attach(children: &mut BTreeMap<String, Vec<DocumentNode>>, node: &mut DocumentNode) {
    let mut mine = children.remove(&node.id).unwrap_or_default();
    for child in &mut mine {
        attach(children, child);
    }
    node.children = mine;
}

/// Where the document sits under the vault root. A page keeps the folder it was
/// first given: renaming on a title change is the operation file sync handles
/// worst, so the recorded path wins over a freshly derived one.
fn document_path(transaction: &Transaction<'_>, root_id: &str) -> Result<String, ExportError> {
    if root_id == "root" {
        return Ok("README.md".to_owned());
    }
    if let Some(recorded) = transaction
        .prepare_cached("SELECT folder_path FROM sync_documents WHERE root_id = ?1")
        .and_then(|mut statement| {
            statement
                .query_row([root_id], |row| row.get::<_, String>(0))
                .optional()
        })
        .map_err(|error| error.to_string())?
    {
        return Ok(recorded);
    }
    let title: String = transaction
        .prepare_cached("SELECT text FROM notes_nodes WHERE id = ?1")
        .and_then(|mut statement| statement.query_row([root_id], |row| row.get(0)))
        .map_err(|error| error.to_string())?;
    Ok(format!("{}/README.md", page_folder_name(&title, root_id)?))
}

fn recorded_hash(
    transaction: &Transaction<'_>,
    root_id: &str,
) -> Result<Option<String>, ExportError> {
    transaction
        .prepare_cached("SELECT exported_hash FROM sync_documents WHERE root_id = ?1")
        .and_then(|mut statement| {
            statement
                .query_row([root_id], |row| row.get::<_, String>(0))
                .optional()
        })
        .map_err(|error| error.to_string())
        .map(|hash| hash.filter(|hash| !hash.is_empty()))
}

/// One statement for the whole document rather than one per node: the cost of
/// an export has to follow what changed, not how large the page grew.
/// Spec §9: a reading moves when the content moves, and not otherwise.
///
/// An edit and an undo are two real changes to what was there a moment before,
/// so the row is stamped twice and ends where it started. Writing that reading
/// out would hand every other device an edit that changes nothing — and beat a
/// real edit somebody made in the meantime. So each node's state is compared
/// with what was last written for it: unchanged, and the reading that was
/// written with it is put back; changed, and the new pair is recorded.
///
/// The record is per node rather than per file because a file is rewritten
/// whenever any line in it moves, and the lines that did not move must not be
/// dragged forward with it. What counts as unchanged includes where the line
/// sits: a node that moved says the same words, and the reading is what
/// decides whose move wins.
fn settle_readings(transaction: &Transaction<'_>, root_id: &str) -> Result<(), ExportError> {
    for (id, fingerprint, hlc, recorded_hash, recorded_hlc) in readings(transaction, root_id)? {
        let (Some(recorded_hash), Some(recorded_hlc)) = (recorded_hash, recorded_hlc) else {
            continue;
        };
        if recorded_hash == fingerprint && recorded_hlc != hlc {
            // `hlc` alone, which the stamping trigger deliberately ignores —
            // putting a reading back is not an edit.
            transaction
                .prepare_cached("UPDATE notes_nodes SET hlc = ?2 WHERE id = ?1")
                .and_then(|mut statement| statement.execute(rusqlite::params![&id, &recorded_hlc]))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// What each node said when the file that was just written said it. Read back
/// by `settle_readings` on a later pass.
fn record_readings(transaction: &Transaction<'_>, root_id: &str) -> Result<(), ExportError> {
    for (id, fingerprint, hlc, recorded_hash, _) in readings(transaction, root_id)? {
        if recorded_hash.as_deref() == Some(fingerprint.as_str()) {
            continue;
        }
        transaction
            .prepare_cached(
                "INSERT INTO sync_node_exports(node_id, content_hash, exported_hlc)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(node_id) DO UPDATE SET
                     content_hash = excluded.content_hash,
                     exported_hlc = excluded.exported_hlc",
            )
            .and_then(|mut statement| statement.execute(rusqlite::params![&id, &fingerprint, &hlc]))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

type Reading = (String, String, String, Option<String>, Option<String>);

fn readings(transaction: &Transaction<'_>, root_id: &str) -> Result<Vec<Reading>, ExportError> {
    let mut statement = transaction
        .prepare_cached(
            "WITH RECURSIVE subtree(id) AS (
                 SELECT ?1
                 UNION ALL
                 SELECT n.id FROM notes_nodes n JOIN subtree s ON n.parent_id = s.id
                 WHERE s.id = ?1
                    OR NOT EXISTS (SELECT 1 FROM sync_documents d
                                    WHERE d.root_id = s.id AND d.retiring = 0)
             )
             SELECT n.id, n.kind, n.text, n.note, n.marker, n.ordered_start,
                    n.collapsed, n.completed, n.starred, n.deleted, n.sync_extras, n.hlc,
                    i.relative_path, i.content_hash, i.display_width, i.pixel_width,
                    i.pixel_height, i.byte_length,
                    e.content_hash, e.exported_hlc,
                    -- Where the line sits is not its content, but it is
                    -- something the reading arbitrates: a node that moved has
                    -- earned its new reading even though it says the same
                    -- words.
                    n.parent_id, n.sync_prev, n.sync_prev_hlc
             FROM notes_nodes n
             LEFT JOIN notes_images i ON i.node_id = n.id
             LEFT JOIN sync_node_exports e ON e.node_id = n.id
             WHERE n.id IN (SELECT id FROM subtree) AND n.hlc <> ''",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([root_id], |row| {
            let text = match row.get::<_, Option<String>>(12)? {
                Some(path) => crate::merger::image_state(
                    &row.get::<_, String>(2)?,
                    &row.get::<_, String>(13)?,
                    &path,
                    row.get(14)?,
                    row.get(15)?,
                    row.get(16)?,
                    row.get(17)?,
                ),
                None => row.get::<_, String>(2)?,
            };
            let fingerprint = crate::merger::LineState {
                kind: &row.get::<_, String>(1)?,
                text: &text,
                note: &row.get::<_, String>(3)?,
                marker: &row.get::<_, String>(4)?,
                ordered_start: row.get(5)?,
                collapsed: row.get::<_, i64>(6)? == 1,
                completed: row.get::<_, i64>(7)? == 1,
                starred: row.get::<_, i64>(8)? == 1,
                deleted: row.get::<_, i64>(9)? == 1,
                extras: &row.get::<_, String>(10)?,
            }
            .fingerprint();
            // The claim's own stamp too: a node moved away and back holds its
            // old neighbour at a fresh reading, and that reading is what
            // decides whose move wins. Putting the old one back would have
            // this device quietly keep an order nobody else has.
            let fingerprint = format!(
                "{fingerprint}:{}:{}:{}",
                row.get::<_, Option<String>>(20)?.unwrap_or_default(),
                row.get::<_, String>(21)?,
                row.get::<_, String>(22)?
            );
            Ok((
                row.get::<_, String>(0)?,
                fingerprint,
                row.get::<_, String>(11)?,
                row.get::<_, Option<String>>(18)?,
                row.get::<_, Option<String>>(19)?,
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut settled = Vec::new();
    for row in rows {
        settled.push(row.map_err(|error| error.to_string())?);
    }
    Ok(settled)
}

/// The folder a document sits in, which is what its links are relative to.
/// Home's is the vault root itself, and that is the empty string.
fn folder_of(relative: &str) -> &str {
    relative.rsplit_once('/').map_or("", |(folder, _)| folder)
}

fn load_document(
    transaction: &Transaction<'_>,
    root_id: &str,
    document_folder: &str,
) -> Result<PageDocument, ExportError> {
    let mut statement = transaction
        .prepare_cached(
            "WITH RECURSIVE subtree(id) AS (
                 SELECT ?1
                 UNION ALL
                 -- Stops where another document begins: a split child's nodes
                 -- belong to its own file, and inlining them here would make
                 -- two files authoritative for one node.
                 SELECT n.id FROM notes_nodes n JOIN subtree s ON n.parent_id = s.id
                 WHERE n.deleted = 0
                   AND (s.id = ?1
                        OR NOT EXISTS (
                            SELECT 1 FROM sync_documents d
                            WHERE d.root_id = s.id AND d.retiring = 0
                        ))
             )
             SELECT n.id, n.parent_id, n.sort_key, n.kind, n.text, n.note, n.marker,
                    n.ordered_start, n.collapsed, n.completed, n.starred, n.hlc,
                    n.sync_extras, n.sync_prev, n.sync_prev_hlc,
                    -- Where the attachment pass put the bytes. Only that pass
                    -- knows: the answer depends on how many nodes point at
                    -- them, which is not a fact about this document.
                    -- `NULLIF` because a record can be there without knowing
                    -- where the bytes are yet: the row is written when they
                    -- resolve, and the placement pass fills the location in.
                    -- Empty is not an answer, and rendering one is refused.
                    COALESCE(NULLIF(a.location, ''), i.relative_path) AS location,
                    i.original_name, i.display_width,
                    i.pixel_width, i.pixel_height, i.byte_length
             FROM notes_nodes n
             LEFT JOIN notes_images i ON i.node_id = n.id
             LEFT JOIN sync_assets a ON a.content_hash = i.content_hash
             WHERE n.id IN (SELECT id FROM subtree) AND n.deleted = 0
               AND (n.hlc <> '' OR n.id = ?1)
             ORDER BY n.parent_id, n.sort_key, n.id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([root_id], |row| {
            Ok(Loaded {
                id: row.get(0)?,
                parent_id: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                kind: row.get(3)?,
                text: row.get(4)?,
                note: row.get(5)?,
                marker: row.get(6)?,
                ordered_start: row.get(7)?,
                collapsed: row.get::<_, i64>(8)? == 1,
                completed: row.get::<_, i64>(9)? == 1,
                starred: row.get::<_, i64>(10)? == 1,
                hlc: row.get(11)?,
                extras: row.get(12)?,
                prev: row.get(13)?,
                prev_hlc: row.get(14)?,
                sort_key: row.get(2)?,
                image: row
                    .get::<_, Option<String>>("location")?
                    .map(|location| image_of(row, location, document_folder))
                    .transpose()?,
            })
        })
        .map_err(|error| error.to_string())?;

    let mut loaded = Vec::new();
    for row in rows {
        loaded.push(row.map_err(|error| error.to_string())?);
    }
    let root = loaded
        .iter()
        .find(|row| row.id == root_id)
        .ok_or_else(|| format!("`{root_id}` is not a document root here."))?
        .clone();

    let mut children: BTreeMap<String, Vec<Loaded>> = BTreeMap::new();
    for row in loaded.into_iter().filter(|row| row.id != root_id) {
        children.entry(row.parent_id.clone()).or_default().push(row);
    }
    let nodes = build(&mut children, root_id);
    let max_hlc = nodes
        .iter()
        .map(highest)
        .max()
        .unwrap_or_default()
        .max(root.hlc.clone());

    Ok(PageDocument {
        id: if root_id == "root" {
            DocumentId::Home
        } else {
            DocumentId::Node(root_id.to_owned())
        },
        // Where this document hangs. Home has no parent and a page's parent is
        // home, which the format leaves unsaid; a split document has to say
        // it, or a device reading the vault fresh makes it a page of its own.
        parent: Some(root.parent_id.clone())
            .filter(|parent| parent != "root" && !parent.is_empty()),
        sort_key: root.sort_key,
        max_hlc,
        root: DocumentRoot {
            title: root.text,
            note: root.note,
            hlc: root.hlc,
            marker: marker_of(&root.marker, root.ordered_start),
            collapsed: root.collapsed,
            completed: root.completed,
            starred: root.starred,
        },
        nodes,
        unknown_frontmatter: Vec::new(),
    })
}

#[derive(Clone)]
struct Loaded {
    id: String,
    parent_id: String,
    kind: String,
    text: String,
    note: String,
    marker: String,
    ordered_start: i64,
    collapsed: bool,
    completed: bool,
    starred: bool,
    hlc: String,
    extras: String,
    prev: String,
    prev_hlc: String,
    sort_key: Option<i64>,
    image: Option<ImageReference>,
}

fn marker_of(marker: &str, ordered_start: i64) -> Marker {
    match marker {
        "todo" => Marker::Todo,
        "ordered" => Marker::Ordered(ordered_start),
        _ => Marker::Bullet,
    }
}

fn build(children: &mut BTreeMap<String, Vec<Loaded>>, parent: &str) -> Vec<DocumentNode> {
    let Some(rows) = children.remove(parent) else {
        return Vec::new();
    };
    rows.into_iter()
        .map(|row| {
            let id = row.id.clone();
            DocumentNode {
                hlc: row.hlc,
                body: match row.image {
                    Some(image) if row.kind == "image" => NodeBody::Image(image),
                    _ => NodeBody::Text(row.text),
                },
                note: row.note,
                marker: marker_of(&row.marker, row.ordered_start),
                collapsed: row.collapsed,
                completed: row.completed,
                starred: row.starred,
                from: None,
                // Written only where it differs from what the line order says,
                // which the renderer decides.
                place: Some((row.prev, row.prev_hlc)),
                unknown_tokens: if row.extras.is_empty() {
                    Vec::new()
                } else {
                    row.extras.split(' ').map(str::to_owned).collect()
                },
                children: build(children, &id),
                id,
            }
        })
        .collect()
}

fn highest(node: &DocumentNode) -> String {
    node.children
        .iter()
        .map(highest)
        .max()
        .unwrap_or_default()
        .max(node.hlc.clone())
}

/// Only the rows this document just wrote. A document's export says nothing
/// about anybody else's.
fn clear_dirty(transaction: &Transaction<'_>, root_id: &str) -> Result<(), ExportError> {
    transaction
        .prepare_cached(
            "DELETE FROM sync_dirty_nodes WHERE node_id IN (
                 WITH RECURSIVE subtree(id) AS (
                     SELECT ?1
                     UNION ALL
                     SELECT n.id FROM notes_nodes n JOIN subtree s ON n.parent_id = s.id
                     WHERE s.id = ?1
                        OR NOT EXISTS (
                            SELECT 1 FROM sync_documents d
                            WHERE d.root_id = s.id AND d.retiring = 0
                        )
                 )
                 -- Only what this document actually wrote. A deleted row's line
                 -- is the trash's to clear, and clearing it here would lose the
                 -- one piece of evidence a deletion gets.
                 SELECT id FROM subtree WHERE (SELECT deleted FROM notes_nodes
                     WHERE notes_nodes.id = subtree.id) = 0
             )",
        )
        .and_then(|mut statement| statement.execute([root_id]))
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// What the folder now says about a file, for the scan gate to compare with.
/// Nothing here fails on a stat that cannot be taken — an unreadable reading
/// means the gate has nothing to skip on, which costs a hash and no more.
fn stat_of(path: &Path) -> (Option<i64>, Option<i64>) {
    let Ok(facts) = std::fs::metadata(path) else {
        return (None, None);
    };
    let modified = facts
        .modified()
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|since| i64::try_from(since.as_millis()).ok());
    (modified, i64::try_from(facts.len()).ok())
}

fn record_document(
    transaction: &Transaction<'_>,
    root_id: &str,
    relative: &str,
    hash: &str,
    (file_mtime_ms, file_size): (Option<i64>, Option<i64>),
) -> Result<(), ExportError> {
    transaction
        .prepare_cached(
            // Which it is, from the node itself: home and the children of root
            // are pages, and anything else this writes is a split document
            // inside one. Stated every time because it can change — a subtree
            // that arrived as a split document and has become a page of its
            // own has to be noticed if it is ever demoted, and a page that
            // became a split document must stop being retired for it.
            "INSERT INTO sync_documents(
                 root_id, folder_path, exported_hash, quarantined, is_page,
                 file_mtime_ms, file_size)
             VALUES (?1, ?2, ?3, 0,
                 ?1 = 'root' OR EXISTS (
                     SELECT 1 FROM notes_nodes WHERE id = ?1 AND parent_id = 'root'),
                 ?4, ?5)
             ON CONFLICT(root_id) DO UPDATE SET
                 folder_path = excluded.folder_path,
                 exported_hash = excluded.exported_hash,
                 is_page = excluded.is_page,
                 file_mtime_ms = excluded.file_mtime_ms,
                 file_size = excluded.file_size",
        )
        .and_then(|mut statement| {
            statement.execute(rusqlite::params![
                root_id,
                relative,
                hash,
                file_mtime_ms,
                file_size
            ])
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}
