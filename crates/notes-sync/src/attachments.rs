//! Where an attachment's bytes belong.
//!
//! One reference and they sit in that page's own folder. Two or more and they
//! move to the vault's root store, because a folder the user opens should not
//! hold a file another page depends on. None and they stay exactly where they
//! are — deleting is something the user does from the attachments list, not
//! something a sync pass does behind them.
//!
//! `plan_placement` is a calculation, not an action: it says where the bytes should be and
//! what to move, and whoever calls it does the moving. That way the rule can be
//! read and tested without a filesystem, and the caller can always write the new
//! copy before removing the old one.

use rusqlite::{OptionalExtension, Transaction};
use std::collections::BTreeMap;
use std::path::Path;

/// One node pointing at these bytes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reference {
    /// The folder of the document holding the node, relative to the vault root.
    pub document_folder: String,
    /// What the file is called on disk — `<name>-<hash12>.<ext>`.
    pub disk_name: String,
    /// A deleted node still counts. Its line lives in the trash, which sits at
    /// the vault root, so the bytes have to be reachable from there.
    pub trashed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Move {
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Placement {
    /// Where the bytes belong, relative to the vault root. Empty when nothing
    /// points at them any more.
    pub location: String,
    /// Written to the new place first, then removed from the old one. An
    /// interruption leaves the same bytes in two places, which is harmless;
    /// the other order can leave them in none.
    pub moves: Vec<Move>,
}

impl Placement {
    /// How a document in this folder writes the link. The path is always
    /// relative, so moving the whole vault never rewrites a single line.
    pub fn link_from(&self, document_folder: &str) -> String {
        let Some((folder, name)) = self.location.rsplit_once('/') else {
            return self.location.clone();
        };
        if folder == format!("{document_folder}/assets") {
            return format!("assets/{name}");
        }
        if folder == "assets" {
            // One `../` for each folder between this document and the root.
            let depth = document_folder
                .split('/')
                .filter(|part| !part.is_empty())
                .count();
            return format!("{}assets/{name}", "../".repeat(depth));
        }
        self.location.clone()
    }
}

/// `current` is where the bytes are now, as the asset record remembers it.
/// Without it this could only guess, and a guess would either move a file that
/// was never there or leave one behind.
pub fn plan_placement(current: &str, references: &[Reference]) -> Placement {
    if references.is_empty() {
        // Nobody points at it. It stays exactly where it is — deleting is
        // something the user does from the attachments list, not something a
        // sync pass does behind them.
        return Placement {
            location: current.to_owned(),
            moves: Vec::new(),
        };
    }
    // Two pages that each added the same bytes under their own name have to
    // agree on one, whichever device works it out — so the smallest name wins.
    let name = references
        .iter()
        .map(|reference| reference.disk_name.as_str())
        .min()
        .unwrap_or_default()
        .to_owned();

    // A deleted note counts too, and its line lives in the trash at the vault
    // root — so the bytes have to be reachable from there.
    let shared = references.len() > 1 || references.iter().any(|reference| reference.trashed);
    let location = if shared {
        format!("assets/{name}")
    } else {
        format!("{}/assets/{name}", references[0].document_folder)
    };

    let moves = if current.is_empty() || current == location {
        Vec::new()
    } else {
        vec![Move {
            from: current.to_owned(),
            to: location.clone(),
        }]
    };
    Placement { location, moves }
}

/// Puts every attachment where `plan_placement` says it belongs, and records
/// where that is. Runs before the documents are written, because a document's
/// link states the answer this pass works out.
///
/// `store_root` is this app's own image store — where the bytes are before a
/// vault ever sees them, and where they stay: a vault is a copy the user can
/// take away, not the only copy.
pub fn place_attachments(
    transaction: &Transaction<'_>,
    vault_root: &Path,
    store_root: &Path,
) -> Result<(), String> {
    let vault_root = &std::fs::canonicalize(vault_root)
        .map_err(|error| format!("Could not resolve the vault: {error}"))?;
    let mut placed = Vec::new();
    for (hash, holders) in referenced_assets(transaction)? {
        let references: Vec<Reference> = holders
            .iter()
            .map(|holder| holder.reference.clone())
            .collect();
        let current = recorded_location(transaction, &hash)?;
        let placement = plan_placement(&current, &references);
        carry_bytes(
            vault_root,
            &store_root.join(&holders[0].store_name),
            &placement,
        )?;
        let disk_name = references
            .iter()
            .map(|reference| reference.disk_name.as_str())
            .min()
            .unwrap_or_default();
        transaction
            .prepare_cached(
                "INSERT INTO sync_assets(content_hash, disk_name, location, unreferenced_at)
                 VALUES (?1, ?2, ?3, NULL)
                 ON CONFLICT(content_hash) DO UPDATE SET
                     disk_name = excluded.disk_name,
                     location = excluded.location,
                     -- Something points at it again: whatever it was counting
                     -- down to is off.
                     unreferenced_at = NULL",
            )
            .and_then(|mut statement| {
                statement.execute(rusqlite::params![&hash, disk_name, &placement.location])
            })
            .map_err(|error| error.to_string())?;
        placed.push(hash);
    }
    // Everything else: the bytes stay exactly where they are and only the
    // reading is written down, because deleting an attachment is something the
    // user does from the list.
    transaction
        .prepare_cached(
            "UPDATE sync_assets SET unreferenced_at = unixepoch()
             WHERE unreferenced_at IS NULL
               AND content_hash NOT IN (SELECT content_hash FROM notes_images)",
        )
        .and_then(|mut statement| statement.execute([]))
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// A reference together with what the bytes are called in this app's own store,
/// which is how the pass finds them when no copy is in the vault yet.
struct Holder {
    reference: Reference,
    store_name: String,
}

fn referenced_assets(
    transaction: &Transaction<'_>,
) -> Result<BTreeMap<String, Vec<Holder>>, String> {
    let mut statement = transaction
        .prepare_cached(
            "WITH RECURSIVE climb(node_id, at) AS (
                 SELECT i.node_id, i.node_id FROM notes_images i
                 UNION ALL
                 SELECT climb.node_id, p.id
                 FROM climb
                 JOIN notes_nodes n ON n.id = climb.at
                 JOIN notes_nodes p ON p.id = n.parent_id
                 WHERE n.parent_id IS NOT NULL AND n.parent_id <> 'root'
                   AND NOT EXISTS (
                       SELECT 1 FROM sync_documents d WHERE d.root_id = climb.at
                   )
             )
             SELECT i.content_hash, i.original_name, i.mime_type, i.relative_path,
                    (SELECT deleted FROM notes_nodes WHERE id = i.node_id),
                    d.folder_path, c.at,
                    (SELECT text FROM notes_nodes WHERE id = c.at)
             FROM climb c
             JOIN notes_images i ON i.node_id = c.node_id
             LEFT JOIN sync_documents d ON d.root_id = c.at
             WHERE i.content_hash <> ''
               AND (c.at = 'root'
                    OR d.root_id IS NOT NULL
                    OR (SELECT parent_id FROM notes_nodes WHERE id = c.at) = 'root')",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)? == 1,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut assets: BTreeMap<String, Vec<Holder>> = BTreeMap::new();
    for row in rows {
        let (hash, name, mime, store_name, trashed, folder_path, document, title) =
            row.map_err(|error| error.to_string())?;
        let document_folder = match folder_path {
            Some(path) => path
                .rsplit_once('/')
                .map(|(folder, _)| folder.to_owned())
                .unwrap_or_default(),
            None if document == "root" => String::new(),
            None => crate::layout::page_folder_name(&title, &document)?,
        };
        assets.entry(hash.clone()).or_default().push(Holder {
            reference: Reference {
                document_folder,
                disk_name: crate::layout::asset_disk_name(&name, &hash, &mime),
                trashed,
            },
            store_name,
        });
    }
    Ok(assets)
}

fn recorded_location(transaction: &Transaction<'_>, hash: &str) -> Result<String, String> {
    transaction
        .prepare_cached("SELECT location FROM sync_assets WHERE content_hash = ?1")
        .and_then(|mut statement| {
            statement
                .query_row([hash], |row| row.get::<_, String>(0))
                .optional()
        })
        .map(Option::unwrap_or_default)
        .map_err(|error| error.to_string())
}

/// Written to the new place first, then removed from the old one — an
/// interruption leaves the same bytes in two places, which is harmless, where
/// the other order can leave them in none.
fn carry_bytes(vault_root: &Path, in_store: &Path, placement: &Placement) -> Result<(), String> {
    let target = vault_root.join(&placement.location);
    if !target.exists() {
        let bytes = placement
            .moves
            .iter()
            .find_map(|move_| {
                crate::file_io::read_regular_bounded(
                    vault_root,
                    &vault_root.join(&move_.from),
                    crate::parse::MAX_ASSET_BYTES as usize,
                )
                .ok()
            })
            .map_or_else(
                || {
                    std::fs::read(in_store)
                        .map_err(|error| format!("Could not read the attachment: {error}"))
                },
                Ok,
            )?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("Could not make the attachment folder: {error}"))?;
        }
        crate::file_io::write_atomic(vault_root, &target, &bytes)?;
    }
    for move_ in &placement.moves {
        let from = vault_root.join(&move_.from);
        if from != target && from.is_file() {
            std::fs::remove_file(&from)
                .map_err(|error| format!("Could not tidy the old copy: {error}"))?;
        }
    }
    Ok(())
}
