//! Where an attachment's bytes belong.
//!
//! One reference and they sit in that page's own folder. Two or more and they
//! move to the vault's root store, because a folder the user opens should not
//! hold a file another page depends on. None and they stay exactly where they
//! are — deleting is something the user does from the attachments list, not
//! something a sync pass does behind them.
//!
//! This is a calculation, not an action: it says where the bytes should be and
//! what to move, and whoever calls it does the moving. That way the rule can be
//! read and tested without a filesystem, and the caller can always write the new
//! copy before removing the old one.

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
