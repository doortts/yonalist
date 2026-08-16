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
    let document = load_document(transaction, root_id)?;
    let bytes = render(&VaultFile::Page(document))?;

    // Invariant 4, before anything touches the disk: a document that cannot be
    // read back is one every device would quarantine.
    let read_back = parse(&bytes).map_err(|reason| {
        format!("The document this app just rendered could not be read back: {reason}")
    })?;
    let again = render(&read_back)?;
    if again != bytes {
        return Err("The document this app just rendered did not survive a read back.".to_owned());
    }

    let relative = document_path(transaction, root_id)?;
    let path = vault_root.join(&relative);
    let hash = hash_bytes(&bytes);
    let recorded = recorded_hash(transaction, root_id)?;

    if let Ok(existing) = std::fs::read(&path) {
        let existing_hash = hash_bytes(&existing);
        if existing_hash == hash {
            // The same bytes going out again would look like an edit to every
            // other device.
            clear_dirty(transaction, root_id)?;
            record_document(transaction, root_id, &relative, &hash)?;
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
    clear_dirty(transaction, root_id)?;
    record_document(transaction, root_id, &relative, &hash)?;
    Ok(ExportOutcome {
        written: true,
        needs_merge: false,
        path: relative,
    })
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
    let nodes = load_trash(transaction)?;
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
    let bytes = render(&VaultFile::Trash(crate::document::TrashDocument {
        max_hlc,
        nodes,
    }))?;
    let read_back = parse(&bytes).map_err(|reason| {
        format!("The trash this app just rendered could not be read back: {reason}")
    })?;
    if render(&read_back)? != bytes {
        return Err("The trash this app just rendered did not survive a read back.".to_owned());
    }
    let hash = hash_bytes(&bytes);
    let recorded = recorded_hash(transaction, "yonalist-trash")?;
    if let Ok(existing) = std::fs::read(&path) {
        let existing_hash = hash_bytes(&existing);
        if existing_hash == hash {
            return Ok(ExportOutcome {
                written: false,
                needs_merge: false,
                path: relative,
            });
        }
        if recorded.as_deref() != Some(existing_hash.as_str()) {
            return Ok(ExportOutcome {
                written: false,
                needs_merge: true,
                path: relative,
            });
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not make the vault's own folder: {error}"))?;
    }
    write_atomic(vault_root, &path, &bytes)?;
    record_document(transaction, "yonalist-trash", &relative, &hash)?;
    Ok(ExportOutcome {
        written: true,
        needs_merge: false,
        path: relative,
    })
}

/// What the trash holds: every deleted node whose parent is still alive, with
/// the children that went down with it.
fn load_trash(transaction: &Transaction<'_>) -> Result<Vec<DocumentNode>, ExportError> {
    let mut statement = transaction
        .prepare_cached(
            "SELECT n.id, n.parent_id, n.sort_key, n.text, n.note, n.marker, n.ordered_start,
                    n.collapsed, n.completed, n.starred, n.hlc, n.sync_extras,
                    p.deleted IS NOT 1
             FROM notes_nodes n
             LEFT JOIN notes_nodes p ON p.id = n.parent_id
             WHERE n.deleted = 1
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
                    body: NodeBody::Text(row.get(3)?),
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
fn load_document(
    transaction: &Transaction<'_>,
    root_id: &str,
) -> Result<PageDocument, ExportError> {
    let mut statement = transaction
        .prepare_cached(
            "WITH RECURSIVE subtree(id) AS (
                 SELECT ?1
                 UNION ALL
                 SELECT n.id FROM notes_nodes n JOIN subtree s ON n.parent_id = s.id
                 WHERE n.deleted = 0
             )
             SELECT n.id, n.parent_id, n.sort_key, n.kind, n.text, n.note, n.marker,
                    n.ordered_start, n.collapsed, n.completed, n.starred, n.hlc,
                    n.sync_extras, n.sync_prev, n.sync_prev_hlc,
                    i.relative_path, i.original_name, i.display_width,
                    i.pixel_width, i.pixel_height, i.byte_length
             FROM notes_nodes n
             LEFT JOIN notes_images i ON i.node_id = n.id
             WHERE n.id IN (SELECT id FROM subtree) AND n.deleted = 0
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
                image: row
                    .get::<_, Option<String>>(15)?
                    .map(|path| ImageReference {
                        path,
                        original_name: row.get(16).unwrap_or_default(),
                        display_width: row.get::<_, i64>(17).unwrap_or_default() as u32,
                        pixel_width: row.get::<_, i64>(18).unwrap_or_default() as u32,
                        pixel_height: row.get::<_, i64>(19).unwrap_or_default() as u32,
                        byte_size: row.get::<_, i64>(20).unwrap_or_default() as u64,
                        unknown_tokens: Vec::new(),
                    }),
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
        parent: None,
        sort_key: None,
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
                 )
                 SELECT id FROM subtree
             )",
        )
        .and_then(|mut statement| statement.execute([root_id]))
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn record_document(
    transaction: &Transaction<'_>,
    root_id: &str,
    relative: &str,
    hash: &str,
) -> Result<(), ExportError> {
    transaction
        .prepare_cached(
            "INSERT INTO sync_documents(root_id, folder_path, exported_hash, quarantined)
             VALUES (?1, ?2, ?3, 0)
             ON CONFLICT(root_id) DO UPDATE SET
                 folder_path = excluded.folder_path,
                 exported_hash = excluded.exported_hash",
        )
        .and_then(|mut statement| statement.execute(rusqlite::params![root_id, relative, hash]))
        .map_err(|error| error.to_string())?;
    Ok(())
}
