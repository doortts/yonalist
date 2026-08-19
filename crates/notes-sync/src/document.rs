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
    /// The high-water mark this document's own content adds up to. Recomputed
    /// from the nodes rather than believed, because it seeds the boot clock: a
    /// hand edit that pushed the stated key into the future would future-stamp
    /// every later local edit on this device.
    pub max_hlc: String,
    /// What the file *said* its high-water mark was, believed for exactly one
    /// question — how much this file ought to have held.
    ///
    /// Every node's stamp lives in the footer now, so a truncation that takes the
    /// bullets takes the evidence with it and the document adds up to almost
    /// nothing. The frontmatter survives a truncation, and this is the only thing
    /// left that says the file is short. Trusted here and nowhere else: inflating
    /// it only asks for more rewrites, and a rewrite is safe.
    pub stated_max_hlc: String,
    pub root: DocumentRoot,
    pub nodes: Vec<DocumentNode>,
    /// Frontmatter keys this version does not know, kept verbatim so a newer
    /// device's file survives a round trip through an older one.
    pub unknown_frontmatter: Vec<String>,
    /// Which device wrote this file, and what that device is called. Stated so
    /// another device can put a name to the four hex characters its stamps
    /// carry — nothing else in the format says what a device id belongs to.
    ///
    /// `None` where the file came from a device that does not state it, or
    /// stated only half of it: a name with no id names nobody.
    pub writer: Option<Writer>,
}

/// A device as it names itself in the files it writes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Writer {
    /// The same four lowercase hex characters its HLCs carry.
    pub device_id: String,
    pub device_name: String,
}

impl PageDocument {
    /// How much this file ought to have held, for the one reader that asks.
    ///
    /// The higher of what the content adds up to and what the frontmatter stated.
    /// A full file agrees with itself and the two are equal; a truncated one has
    /// lost its content and only the stated key is left to say so.
    pub fn completeness_bound(&self) -> String {
        self.max_hlc.clone().max(self.stated_max_hlc.clone())
    }
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
}

/// Deletions are evidence, not absence: a node is gone because it is written
/// here, which is what lets one device's delete beat another's edit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrashDocument {
    pub max_hlc: String,
    pub nodes: Vec<DocumentNode>,
}
