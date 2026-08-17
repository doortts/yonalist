//! The shape a vault file has, independent of where the state came from. The
//! renderer writes this and the parser produces it, so neither one needs the
//! database or the outliner's own tree.

/// Every vault file is one of these two. Nothing else is written into a vault.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VaultFile {
    Page(PageDocument),
    Trash(TrashDocument),
}

/// One page, or one subtree that grew big enough to move into its own folder.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PageDocument {
    /// The document root's UUID — or the literal `root` for the home document,
    /// the one id in the whole format that is not a UUID.
    pub id: DocumentId,
    /// Set only on a split document: which node it hangs under, and where.
    pub parent: Option<String>,
    /// Written only on a split document; a page's place is its line in home.
    pub sort_key: Option<i64>,
    pub max_hlc: String,
    pub root: DocumentRoot,
    pub nodes: Vec<DocumentNode>,
    /// Frontmatter keys this version does not know, kept verbatim so a newer
    /// device's file survives a round trip through an older one.
    pub unknown_frontmatter: Vec<String>,
}

/// The home document is the one place a literal, non-UUID id is legal.
#[derive(Clone, Debug, Eq, PartialEq)]
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
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DocumentRoot {
    pub title: String,
    pub note: String,
    pub hlc: String,
    pub marker: Marker,
    pub collapsed: bool,
    pub completed: bool,
    pub starred: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Marker {
    #[default]
    Bullet,
    Todo,
    /// Carries the number the list starts counting from.
    Ordered(i64),
}

#[derive(Clone, Debug, Eq, PartialEq)]
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
    pub children: Vec<DocumentNode>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NodeBody {
    Text(String),
    Image(ImageReference),
    /// A child that lives in its own document. The line keeps only the node's
    /// existence and its place among siblings; the child document's
    /// frontmatter is the authority on everything else.
    Split {
        title: String,
        path: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImageReference {
    /// What the user called the file. The link text carries it, so a markdown
    /// viewer shows it as the alt text.
    pub original_name: String,
    /// Relative to the document, so moving a vault never rewrites a link.
    pub path: String,
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
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrashDocument {
    pub max_hlc: String,
    pub nodes: Vec<DocumentNode>,
}
