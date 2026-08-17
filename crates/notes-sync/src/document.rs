//! The shape a vault file has, independent of where the state came from. The
//! renderer writes this and the parser produces it, so neither one needs the
//! database or the outliner's own tree.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The single comment at the bottom of a file: everything the markdown body
/// cannot hold, and the two hashes that say which state this is and which one
/// it descends from.
///
/// Field order here is the key order in the file. Serde writes a struct in
/// declaration order, so the two agree by construction rather than by a rule
/// someone has to remember.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct Footer {
    pub state_hash: String,
    pub base: String,
    #[serde(default)]
    pub state: BTreeMap<String, BlockState>,
}

/// What one block owns that its line cannot say. Everything is optional and
/// a default is left out entirely: a file full of keys nobody set is harder to
/// read by hand and gives every merge more to compare over nothing.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct BlockState {
    #[serde(default, skip_serializing_if = "is_unset")]
    pub collapsed: bool,
    #[serde(default, skip_serializing_if = "is_unset")]
    pub starred: bool,
    /// Only on a node whose marker is not `todo` — a todo says so with its own
    /// checkbox, and two authorities for one fact is one too many.
    #[serde(default, skip_serializing_if = "is_unset")]
    pub completed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ordered_start: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pixel_width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pixel_height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_parent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_after: Option<i64>,
    /// Keys this version has no meaning for, kept inside their own object so a
    /// newer device's file survives a round trip through an older one.
    #[serde(flatten)]
    pub unknown: BTreeMap<String, serde_json::Value>,
}

fn is_unset(value: &bool) -> bool {
    !*value
}

/// Every vault file is one of these two. Nothing else is written into a vault.
#[derive(Clone, Debug, PartialEq)]
pub enum VaultFile {
    Page(PageDocument),
    Trash(TrashDocument),
}

/// One page, or one subtree that grew big enough to move into its own folder.
#[derive(Clone, Debug, PartialEq)]
pub struct PageDocument {
    /// The document root's UUID — or the literal `root` for the home document,
    /// the one id in the whole format that is not a UUID.
    pub id: DocumentId,
    /// Set only on a split document: which node it hangs under, and where.
    pub parent: Option<String>,
    /// Written only on a split document; a page's place is its line in home.
    pub sort_key: Option<i64>,
    pub max_hlc: String,
    /// The `state_hash` of the canonical snapshot this file carries. The
    /// renderer writes what it is handed; computing it belongs to the exporter,
    /// which is the only caller that has seen the whole document.
    pub state_hash: String,
    /// The `state_hash` of the last state this device and the file agreed on.
    /// Empty on a document that has never reconciled with anything.
    pub base: String,
    pub root: DocumentRoot,
    pub nodes: Vec<DocumentNode>,
    /// Frontmatter keys this version does not know, kept verbatim so a newer
    /// device's file survives a round trip through an older one.
    pub unknown_frontmatter: Vec<String>,
}

/// The home document is the one place a literal, non-UUID id is legal.
#[derive(Clone, Debug, PartialEq)]
pub enum DocumentId {
    Home,
    Node(String),
}

impl DocumentId {
    pub fn as_str(&self) -> &str {
        match self {
            DocumentId::Home => "root",
            DocumentId::Node(id) => id,
        }
    }
}

/// The document root carries the heading and the state a bullet would carry in
/// its comment, since a heading has nowhere to put one.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DocumentRoot {
    pub title: String,
    pub note: String,
    pub hlc: String,
    pub marker: Marker,
    pub collapsed: bool,
    pub completed: bool,
    pub starred: bool,
    pub unknown_state: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Marker {
    #[default]
    Bullet,
    Todo,
    /// Carries the number the list starts counting from.
    Ordered(i64),
}

#[derive(Clone, Debug, PartialEq)]
pub struct DocumentNode {
    pub id: String,
    pub hlc: String,
    pub body: NodeBody,
    pub note: String,
    pub marker: Marker,
    pub collapsed: bool,
    pub completed: bool,
    pub starred: bool,
    /// Set on trash roots only: where the node was deleted from.
    pub from: Option<(String, i64)>,
    /// Which sibling this node says it follows, and when it said so. Empty
    /// value means first among siblings. The claim carries its own stamp
    /// because a text edit restamps the node — sharing one reading between
    /// them would turn every edit into a move.
    pub place: Option<(String, String)>,
    /// Comment tokens this version does not know, kept in the order they were
    /// read and re-emitted after the known ones.
    pub unknown_tokens: Vec<String>,
    /// Footer state keys this version has no meaning for. A newer device's file
    /// has to survive a trip through this one, and dropping what it knew that
    /// this build does not would be a silent edit.
    pub unknown_state: BTreeMap<String, serde_json::Value>,
    pub children: Vec<DocumentNode>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum NodeBody {
    Text(String),
    Image(ImageReference),
    /// A child that lives in its own document. The line keeps only the node's
    /// existence and its place among siblings; the child document's
    /// frontmatter is the authority on everything else.
    Split {
        title: String,
        path: String,
        /// A page and a split document read the same on the line. Which one
        /// this is lives in the footer, because the line has nowhere to say it
        /// without becoming metadata again.
        child_kind: ChildKind,
    },
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ChildKind {
    #[default]
    Page,
    Split,
}

impl ChildKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ChildKind::Page => "page",
            ChildKind::Split => "split",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ImageReference {
    /// What the user called the file. The link text carries it, so a markdown
    /// viewer shows it as the alt text.
    pub original_name: String,
    /// Relative to the document, so moving a vault never rewrites a link.
    pub path: String,
    /// The whole content hash. The path says where the bytes are sitting right
    /// now; this says which picture it is, and it is what survives a move.
    pub asset_hash: String,
    pub display_width: u32,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub byte_size: u64,
    /// `ya:` tokens this version has no meaning for, kept in the order they
    /// were read and re-emitted after the known ones — same contract as a node
    /// comment's, since the same reader rule cuts them.
    pub unknown_tokens: Vec<String>,
}

/// Deletions are evidence, not absence: a node is gone because it is written
/// here, which is what lets one device's delete beat another's edit.
#[derive(Clone, Debug, PartialEq)]
pub struct TrashDocument {
    pub max_hlc: String,
    pub state_hash: String,
    pub base: String,
    pub nodes: Vec<DocumentNode>,
}
