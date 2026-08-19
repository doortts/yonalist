//! Reads a vault file back into a document. Two rules shape everything here.
//!
//! Where a hand edit is merely untidy the parser copes — odd indentation, a
//! missing stamp, a bullet nobody gave an id. Where it cannot say what a line
//! means, the whole file is refused: half a document applied is worse than none,
//! because nothing downstream can tell which half it received.

use crate::document::{
    DocumentId, DocumentNode, DocumentRoot, ImageReference, Marker, NodeBody, PageDocument,
    TrashDocument, VaultFile, Writer,
};
use crate::hlc::Hlc;
use std::collections::{BTreeMap, HashSet};

pub const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_DEPTH: usize = 128;
pub const MAX_NODES: usize = 20_000;
pub const MAX_FIELD_BYTES: usize = 100_000;
/// The narrowest an image may be drawn, and the largest asset this app writes.
/// Both are the domain's numbers; a file stating anything else is not one of
/// ours.
const MIN_DISPLAY_WIDTH: u32 = 120;
pub const MAX_ASSET_BYTES: u64 = 20 * 1024 * 1024;

/// Why a document was refused. The text goes to `notes://sync-status`, so it
/// names the line rather than the rule's number.
pub type Quarantine = String;

pub fn parse(bytes: &[u8]) -> Result<VaultFile, Quarantine> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!(
            "The file is {} bytes, over the {MAX_FILE_BYTES} byte cap.",
            bytes.len()
        ));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "The file is not UTF-8.".to_owned())?;
    let text = text.replace("\r\n", "\n").replace('\r', "\n");

    let mut lines = text.split('\n').peekable();
    if lines.next() != Some("---") {
        return Err("The file does not open with frontmatter.".to_owned());
    }
    let mut frontmatter = Vec::new();
    let mut closed = false;
    for line in lines.by_ref() {
        if line == "---" {
            closed = true;
            break;
        }
        frontmatter.push(line);
    }
    if !closed {
        return Err("The frontmatter is never closed.".to_owned());
    }
    let body: Vec<&str> = lines.collect();
    for line in frontmatter.iter().chain(body.iter()) {
        if line.starts_with("<<<<<<<") || line.starts_with(">>>>>>>") {
            return Err("The file still holds a git conflict marker.".to_owned());
        }
    }

    let keys = read_frontmatter(&frontmatter)?;
    let (body, footer) = split_footer(&body)?;
    match keys.get("kind").map(String::as_str) {
        Some("yonalist-notes") => parse_page(&keys, &body, footer),
        Some("yonalist-trash") => parse_trash(&keys, &body, footer),
        Some(other) => Err(format!("`{other}` is not a kind this app writes.")),
        None => Err("The frontmatter has no kind.".to_owned()),
    }
}

/// What a block states, keyed by the block. The body says which line is which
/// block and this says what that block holds.
type Footer = BTreeMap<String, Tokens>;

/// Cuts the footer out of the body, wherever it sits.
///
/// The renderer always writes it last. The reader deliberately does not insist on
/// that: appending a line to the end of a file is the most ordinary hand edit
/// there is, and a person doing it in a Markdown editor has no reason to know
/// that a comment down there is load-bearing. So whatever is left once the block
/// is cut out is the body, in the order it was written, and the next export puts
/// the footer back at the end. Refusing instead would quarantine a whole document
/// over one line somebody typed in the obvious place.
///
/// There is exactly one footer. A file with none is accepted — every node then
/// reads as unstamped, which is the rule a single line with its `t:` deleted
/// already gets, widened to a whole document: that file loses to the database and
/// the next export writes the canonical form back. What is malformed is refused
/// whole, because a footer half-read hands some blocks somebody else's state.
fn split_footer<'a>(body: &[&'a str]) -> Result<(Vec<&'a str>, Footer), Quarantine> {
    const OPEN: &str = "<!-- yonalist";
    // Trimmed, because a trailing space is an editor's and not the format's — the
    // same grounds `split_trailing_comment` already trims a body comment on. Left
    // exact, one invisible character refused the whole document and named
    // something nobody could see.
    let opens: Vec<usize> = body
        .iter()
        .enumerate()
        .filter(|(_, line)| line.trim() == OPEN)
        .map(|(index, _)| index)
        .collect();
    if opens.len() > 1 {
        return Err("The file holds more than one footer.".to_owned());
    }
    let Some(open) = opens.first().copied() else {
        return Ok((body.to_vec(), Footer::new()));
    };
    let close = body[open..]
        .iter()
        .position(|line| line.trim() == "-->")
        .map(|offset| open + offset)
        .ok_or_else(|| "The footer is never closed.".to_owned())?;

    let mut footer = Footer::new();
    for line in &body[open + 1..close] {
        if line.trim().is_empty() {
            continue;
        }
        let tokens = read_token_words(line)?;
        if tokens.id.is_empty() {
            return Err(format!(
                "A footer line does not say which block it is about: `{line}`"
            ));
        }
        if footer.insert(tokens.id.clone(), tokens).is_some() {
            return Err(format!("The footer states `{line}` twice."));
        }
    }
    let mut rest = body[..open].to_vec();
    rest.extend_from_slice(&body[close + 1..]);
    Ok((rest, footer))
}

/// Everything this version understands, in the order §4.2 fixes. Anything else
/// is carried through untouched so a newer device's file survives the trip.
const KNOWN_KEYS: &[&str] = &[
    "kind",
    "format_version",
    "id",
    "parent",
    "sort_key",
    "max_hlc",
    // Derived from `max_hlc`, and known so that it is not carried through as a
    // key this version has never heard of — which would have the renderer write
    // its own line and the stranger's copy of it, one file growing a duplicate
    // per round trip. Nothing reads the value: `max_hlc` is the fact and this is
    // a reading of it, so a hand-edited one is simply replaced.
    "updated",
    "root_hlc",
    "root_marker_kind",
    "root_ordered_start",
    "root_collapsed",
    "root_completed",
    "root_starred",
    "device_id",
    "device_name",
];

struct Frontmatter {
    known: Vec<(String, String)>,
    unknown: Vec<String>,
}

impl Frontmatter {
    fn get(&self, key: &str) -> Option<&String> {
        self.known
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }
}

fn read_frontmatter(lines: &[&str]) -> Result<Frontmatter, Quarantine> {
    let mut known: Vec<(String, String)> = Vec::new();
    let mut unknown = Vec::new();
    for line in lines {
        let Some((key, value)) = line
            .split_once(": ")
            .or_else(|| line.strip_suffix(':').map(|key| (key, "")))
        else {
            return Err(format!("`{line}` is not a frontmatter key."));
        };
        if KNOWN_KEYS.contains(&key) {
            if known.iter().any(|(name, _)| name == key) {
                return Err(format!("The frontmatter sets `{key}` twice."));
            }
            known.push((key.to_owned(), value.to_owned()));
        } else {
            unknown.push((*line).to_owned());
        }
    }
    Ok(Frontmatter { known, unknown })
}

fn parse_page(keys: &Frontmatter, body: &[&str], footer: Footer) -> Result<VaultFile, Quarantine> {
    require_format_version(keys)?;
    let id = match keys.get("id").map(String::as_str) {
        Some("root") => DocumentId::Home,
        Some(value) => DocumentId::Node(block_id(value)?),
        None => return Err("The document has no id.".to_owned()),
    };
    let parent = match keys.get("parent") {
        Some(value) => Some(block_id(value)?),
        None => None,
    };
    let sort_key = match keys.get("sort_key") {
        Some(value) => Some(
            value
                .parse::<i64>()
                .map_err(|_| format!("`{value}` is not a sort key."))?,
        ),
        None => None,
    };

    let mut body = body.iter().peekable();
    let heading = body
        .next()
        .ok_or_else(|| "The document has no heading.".to_owned())?;
    let title = heading
        .strip_prefix("# ")
        .or_else(|| heading.strip_prefix('#').filter(|rest| rest.is_empty()))
        .ok_or_else(|| "The line after the frontmatter is not a heading.".to_owned())?;
    if title.starts_with("![") {
        return Err("A document root cannot be an image.".to_owned());
    }
    let title = unescape_inline(title);
    field_fits(&title, "root title")?;

    let mut note = Vec::new();
    while let Some(line) = body.peek() {
        let Some(rest) = line.strip_prefix('>') else {
            break;
        };
        note.push(unescape(rest.strip_prefix(' ').unwrap_or(rest)));
        body.next();
    }
    let note = note.join("\n");
    field_fits(&note, "root note")?;

    let root = DocumentRoot {
        title,
        note,
        hlc: optional_hlc(keys.get("root_hlc")),
        marker: root_marker(keys)?,
        collapsed: flag(keys, "root_collapsed")?,
        completed: flag(keys, "root_completed")?,
        starred: flag(keys, "root_starred")?,
    };

    let mut reader = NodeReader::new(false, footer);
    let nodes = reader.read(body)?;
    if let DocumentId::Node(id) = &id
        && reader.ids.contains(id.as_str())
    {
        return Err("A node claims the document's own id.".to_owned());
    }

    // The content is the only evidence. A stated key that runs ahead of it is a
    // hand edit, and keeping it would push the boot clock into the future and
    // future-stamp every later local edit.
    let max_hlc = highest_hlc(&nodes).max(root.hlc.clone());
    // Kept apart from the value above on purpose. See `PageDocument`.
    let stated_max_hlc = optional_hlc(keys.get("max_hlc"));

    Ok(VaultFile::Page(PageDocument {
        id,
        parent,
        sort_key,
        max_hlc,
        stated_max_hlc,
        root,
        nodes,
        unknown_frontmatter: keys.unknown.clone(),
        writer: writer(keys),
    }))
}

/// Who the file says wrote it. Half a pair names nobody, and neither does an
/// empty value, so both have to be there for this to be an answer.
fn writer(keys: &Frontmatter) -> Option<Writer> {
    let device_id = keys.get("device_id").filter(|value| !value.is_empty())?;
    let device_name = keys.get("device_name").filter(|value| !value.is_empty())?;
    Some(Writer {
        device_id: device_id.clone(),
        device_name: device_name.clone(),
    })
}

fn parse_trash(keys: &Frontmatter, body: &[&str], footer: Footer) -> Result<VaultFile, Quarantine> {
    require_format_version(keys)?;
    if keys.get("id").is_some() {
        return Err("The trash does not have an id.".to_owned());
    }
    let mut reader = NodeReader::new(true, footer);
    let nodes = reader.read(body.iter().peekable())?;
    let max_hlc = highest_hlc(&nodes);
    Ok(VaultFile::Trash(TrashDocument { max_hlc, nodes }))
}

fn require_format_version(keys: &Frontmatter) -> Result<(), Quarantine> {
    match keys.get("format_version").map(String::as_str) {
        Some("1") => Ok(()),
        Some(other) => Err(format!("Format version {other} is not one this app reads.")),
        None => Err("The document does not state its format version.".to_owned()),
    }
}

fn root_marker(keys: &Frontmatter) -> Result<Marker, Quarantine> {
    let start = match keys.get("root_ordered_start") {
        Some(value) => value
            .parse::<i64>()
            .map_err(|_| format!("`{value}` is not an ordered start."))?,
        None => 1,
    };
    match keys.get("root_marker_kind").map(String::as_str) {
        None | Some("bullet") => Ok(Marker::Bullet),
        Some("todo") => Ok(Marker::Todo),
        Some("ordered") => Ok(Marker::Ordered(start)),
        Some(other) => Err(format!("`{other}` is not a marker kind.")),
    }
}

fn flag(keys: &Frontmatter, key: &str) -> Result<bool, Quarantine> {
    match keys.get(key).map(String::as_str) {
        None | Some("false") => Ok(false),
        Some("true") => Ok(true),
        Some(other) => Err(format!("`{key}` is `{other}` rather than true or false.")),
    }
}

struct NodeReader {
    trash: bool,
    footer: Footer,
    ids: HashSet<String>,
    count: usize,
}

impl NodeReader {
    fn new(trash: bool, footer: Footer) -> Self {
        Self {
            trash,
            footer,
            ids: HashSet::new(),
            count: 0,
        }
    }

    /// Lines arrive flat and carry their depth in their indentation, so the tree
    /// is rebuilt with an explicit stack of open ancestors.
    fn read(
        &mut self,
        lines: std::iter::Peekable<std::slice::Iter<'_, &str>>,
    ) -> Result<Vec<DocumentNode>, Quarantine> {
        let mut roots: Vec<DocumentNode> = Vec::new();
        // The bool is "this node has had a note line". An empty note cannot stand
        // in for that: a note whose own first line is blank is written as a bare
        // `>`, and reading emptiness as "nothing yet" made the next line replace
        // it instead of following it — so the blank line the person typed was
        // gone, and a note of nothing but blank lines came back as no note.
        let mut stack: Vec<(usize, DocumentNode, bool)> = Vec::new();

        for line in lines {
            if line.trim().is_empty() {
                continue;
            }
            let (indent, rest) = split_indentation(line);
            // A note belongs to the line above it, whatever its own indentation
            // says. The renderer only ever writes a note directly under its own
            // bullet, so a note indented at some ancestor's level is a hand
            // edit — and reading it as the ancestor's would move text the
            // person meant to leave where they typed it.
            if let Some(text) = rest.strip_prefix('>') {
                let Some((_, open, has_note)) = stack.last_mut() else {
                    return Err(format!("A note has no line to belong to: `{line}`"));
                };
                let text = unescape(text.strip_prefix(' ').unwrap_or(text));
                if *has_note {
                    open.note.push('\n');
                    open.note.push_str(&text);
                } else {
                    open.note = text;
                    *has_note = true;
                }
                field_fits(&open.note, "note")?;
                continue;
            }
            let Some(node_line) = read_node_line(rest, self.trash, &self.footer)? else {
                return Err(format!("This line is not part of the grammar: `{line}`"));
            };
            // Deeper than the line above allows is a hand edit, not a hierarchy:
            // the node joins at the deepest place that does exist.
            let depth = indent.min(stack.len());
            if depth >= MAX_DEPTH {
                return Err(format!("The document nests past {MAX_DEPTH} levels."));
            }
            self.count += 1;
            if self.count > MAX_NODES {
                return Err(format!("The document holds more than {MAX_NODES} nodes."));
            }
            // As written, never folded. Two ids differing only in case are two
            // blocks: `derived_child_id` hashes the id as it stands and
            // `folder_suffix` gives two such ids two folders, so folding here
            // would refuse a legal document — and refuse it as a duplicate.
            if !node_line.id.is_empty() && !self.ids.insert(node_line.id.clone()) {
                return Err(format!("The id {} appears twice.", node_line.id));
            }
            while stack.len() > depth {
                let (_, finished, _) = stack.pop().expect("the stack is not empty");
                match stack.last_mut() {
                    Some((_, parent, _)) => parent.children.push(finished),
                    None => roots.push(finished),
                }
            }
            stack.push((depth, node_line, false));
        }
        while let Some((_, finished, _)) = stack.pop() {
            match stack.last_mut() {
                Some((_, parent, _)) => parent.children.push(finished),
                None => roots.push(finished),
            }
        }
        Ok(roots)
    }
}

/// A tab is one level and an odd count rounds down: both are what a hand editor
/// leaves behind, and neither says anything about intent that two spaces do not.
fn split_indentation(line: &str) -> (usize, &str) {
    let mut columns = 0;
    let mut rest = line;
    loop {
        if let Some(next) = rest.strip_prefix('\t') {
            columns += 2;
            rest = next;
        } else if let Some(next) = rest.strip_prefix(' ') {
            columns += 1;
            rest = next;
        } else {
            break;
        }
    }
    (columns / 2, rest)
}

fn read_node_line(
    rest: &str,
    trash: bool,
    footer: &Footer,
) -> Result<Option<DocumentNode>, Quarantine> {
    let (prefix_marker, prefix_completed, body) = if let Some(body) = rest.strip_prefix("- [ ] ") {
        (Some(Marker::Todo), false, body)
    } else if let Some(body) = rest.strip_prefix("- [x] ") {
        (Some(Marker::Todo), true, body)
    } else if let Some(body) = rest.strip_prefix("- ") {
        (None, false, body)
    } else {
        return Ok(None);
    };

    let (body, comment) = split_trailing_comment(body);
    // The line names the block and the footer says what it holds. A line whose
    // block the footer never mentions reads as unstamped with everything at its
    // default, which is what a hand editor leaves behind and what the next
    // export writes back into shape.
    let line = read_tokens(comment)?;
    let tokens = footer.get(&line.id).cloned().unwrap_or_default();

    let mut node = DocumentNode {
        id: line.id,
        hlc: tokens.hlc.clone(),
        body: NodeBody::Text(String::new()),
        note: String::new(),
        marker: prefix_marker.unwrap_or(tokens.marker),
        collapsed: tokens.collapsed,
        completed: prefix_completed || tokens.completed,
        starred: tokens.starred,
        from: tokens.from.clone(),
        place: tokens.place.clone(),
        unknown_tokens: tokens.unknown.clone(),
        children: Vec::new(),
    };
    if node.from.is_some() && !trash {
        return Err("A page has no place a node was deleted from.".to_owned());
    }

    node.body = if tokens.split {
        let (title, path) =
            read_link(body).ok_or_else(|| format!("A split line is not a link: `{body}`"))?;
        // The child document's frontmatter owns this node's state, so whatever
        // the parent's line said about it is not evidence.
        node.marker = Marker::Bullet;
        node.starred = false;
        node.completed = false;
        node.collapsed = false;
        NodeBody::Split { title, path }
    } else if body.starts_with("![") {
        NodeBody::Image(read_image(body, &tokens)?)
    } else {
        let text = unescape_inline(body);
        field_fits(&text, "text")?;
        NodeBody::Text(text)
    };
    Ok(Some(node))
}

/// The renderer writes exactly one space before the node comment, so the
/// boundary is the last ` <!--`. One shape deliberately keeps the tail in the body
/// instead: a comment this reader cannot close, which is still the user's bytes.
/// Dropping it would delete text, and dropping a broken `yid:` would hand the node
/// a new identity.
///
/// There used to be a second exemption for an image line carrying its own `ya:`
/// comment, from when that was where a picture stated its size. Nothing writes one
/// now, and its only remaining effect was to keep such a tail in the body — so the
/// line stopped parsing as a link and the reader refused it by saying it was not
/// one, about a line that plainly was.
fn split_trailing_comment(line: &str) -> (&str, &str) {
    let Some(separator) = line.rfind(" <!--") else {
        return (line, "");
    };
    // Whitespace after the comment is an editor's, not the format's, so it does
    // not cost the node the identity the comment carries. Whitespace *before*
    // the comment belongs to the text and stays where it is.
    let candidate = line[separator + 1..].trim_end();
    // Only that it closes. What is inside is the token reader's business, and it
    // is handed the comment whole.
    if candidate
        .strip_prefix("<!--")
        .and_then(|rest| rest.strip_suffix("-->"))
        .is_none()
    {
        return (line, "");
    }
    (&line[..separator], candidate)
}

#[derive(Clone, Default)]
struct Tokens {
    id: String,
    hlc: String,
    marker: Marker,
    starred: bool,
    completed: bool,
    collapsed: bool,
    split: bool,
    from: Option<(String, i64)>,
    place: Option<(String, String)>,
    /// A picture's own facts. They used to sit in a second comment on the line;
    /// now they are three more tokens on the block's footer line.
    display_width: Option<u32>,
    pixels: Option<(u32, u32)>,
    byte_size: Option<u64>,
    unknown: Vec<String>,
}

/// A token ending in `:` takes the next word as its value whether or not this
/// version knows the token. Without that rule an unknown `foo: collapsed` would
/// read its own value as a state.
fn read_tokens(comment: &str) -> Result<Tokens, Quarantine> {
    let Some(inner) = comment
        .strip_prefix("<!--")
        .and_then(|rest| rest.strip_suffix("-->"))
    else {
        return Ok(Tokens::default());
    };
    read_token_words(inner)
}

/// The same grammar without the comment around it, because a footer line is the
/// same tokens with nothing wrapping them. One reader, so the two can never
/// disagree about what a token means.
fn read_token_words(inner: &str) -> Result<Tokens, Quarantine> {
    let mut tokens = Tokens::default();
    let mut seen: Vec<&str> = Vec::new();
    let mut words = inner.split_whitespace().peekable();
    while let Some(word) = words.next() {
        let mut once = |name: &'static str| -> Result<(), Quarantine> {
            if seen.contains(&name) {
                return Err(format!("The comment sets `{name}` twice."));
            }
            seen.push(name);
            Ok(())
        };
        match word {
            "yid:" => {
                once("yid")?;
                let value = words.next().unwrap_or_default();
                tokens.id = block_id(value)?;
            }
            "t:" => {
                once("t")?;
                tokens.hlc = optional_hlc(words.next().map(str::to_owned).as_ref());
            }
            "star" => {
                once("star")?;
                tokens.starred = true;
            }
            "todo" => {
                once("marker")?;
                tokens.marker = Marker::Todo;
            }
            "ordered:" => {
                once("marker")?;
                let value = words.next().unwrap_or_default();
                tokens.marker = Marker::Ordered(
                    value
                        .parse()
                        .map_err(|_| format!("`{value}` is not an ordered start."))?,
                );
            }
            "done" => {
                once("done")?;
                tokens.completed = true;
            }
            "split" => {
                once("split")?;
                tokens.split = true;
            }
            "prev:" => {
                once("prev")?;
                let value = words.next().unwrap_or_default();
                // Split at the last `@`, the same shape `from:` uses. An empty
                // value means "first among siblings", which is why the split
                // has to tolerate an empty left half.
                let (previous, stamp) = value
                    .rsplit_once('@')
                    .ok_or_else(|| format!("`{value}` is not a place claim."))?;
                let previous = if previous.is_empty() {
                    String::new()
                } else {
                    block_id(previous)?
                };
                tokens.place = Some((previous, optional_hlc(Some(&stamp.to_owned()))));
            }
            "collapsed" => {
                once("collapsed")?;
                tokens.collapsed = true;
            }
            "w:" => {
                once("w")?;
                tokens.display_width = words.next().and_then(|value| value.parse().ok());
            }
            "px:" => {
                once("px")?;
                tokens.pixels = words.next().and_then(|value| {
                    let (width, height) = value.split_once('x')?;
                    Some((width.parse().ok()?, height.parse().ok()?))
                });
            }
            "bytes:" => {
                once("bytes")?;
                tokens.byte_size = words.next().and_then(|value| value.parse().ok());
            }
            "from:" => {
                once("from")?;
                let value = words.next().unwrap_or_default();
                let (parent, sort_key) = value
                    .rsplit_once('@')
                    .ok_or_else(|| format!("`{value}` is not a deletion origin."))?;
                let parent = if parent == "root" {
                    "root".to_owned()
                } else {
                    block_id(parent)?
                };
                let sort_key = sort_key
                    .parse()
                    .map_err(|_| format!("`{sort_key}` is not a sort key."))?;
                tokens.from = Some((parent, sort_key));
            }
            other => {
                tokens.unknown.push(other.to_owned());
                if other.ends_with(':')
                    && let Some(value) = words.next()
                {
                    tokens.unknown.push(value.to_owned());
                }
            }
        }
    }
    Ok(tokens)
}

fn read_link(body: &str) -> Option<(String, String)> {
    let rest = body.strip_prefix('[')?;
    let close = rest.rfind("](")?;
    let title = unescape_inline(&rest[..close]);
    let path = rest[close + 2..].strip_suffix(')')?;
    Some((title, path.to_owned()))
}

/// A picture's link, and its own facts taken from the block's footer line.
///
/// The line used to carry a second comment of its own. It does not any more, so
/// a picture whose footer entry is missing has nothing a row could be built
/// from — and this refuses rather than inventing a size. It is the same answer
/// the reader has always given a picture line with no metadata on it.
fn read_image(body: &str, tokens: &Tokens) -> Result<ImageReference, Quarantine> {
    let (name, path) = read_link(body.strip_prefix('!').unwrap_or(body))
        .ok_or_else(|| format!("An image line is not a link: `{body}`"))?;
    check_asset_path(&path)?;

    let (pixel_width, pixel_height) = tokens
        .pixels
        .ok_or_else(|| format!("The footer states no pixel size for the picture at `{path}`."))?;
    // The bounds are facts about the format, so they are answered here, where a
    // refusal is a quarantine with a reason — not later, where the same file
    // would die on a database constraint with nothing to tell the user.
    if pixel_width == 0 || pixel_height == 0 {
        return Err(format!("`{path}` states no pixels."));
    }
    let display_width = tokens
        .display_width
        .ok_or_else(|| format!("The footer states no width for the picture at `{path}`."))?;
    if display_width < MIN_DISPLAY_WIDTH {
        return Err(format!(
            "A display width of {display_width} is under the {MIN_DISPLAY_WIDTH} minimum."
        ));
    }
    let byte_size = tokens
        .byte_size
        .ok_or_else(|| format!("The footer states no byte size for the picture at `{path}`."))?;
    if byte_size == 0 || byte_size > MAX_ASSET_BYTES {
        return Err(format!(
            "An asset of {byte_size} bytes is not one this app writes."
        ));
    }
    if !matches!(
        extension_of(&path).as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp"
    ) {
        return Err(format!("`{path}` is not an image type this format writes."));
    }
    // Every markdown editor writes `![](…)`, and a picture with no name has no
    // metadata a row can be built from — the note would draw a placeholder
    // over bytes it has. What the file is called is the answer the file
    // already gave, and this is the boundary that answers for the format.
    let name = if name.is_empty() {
        path.rsplit('/').next().unwrap_or_default().to_owned()
    } else {
        name
    };
    Ok(ImageReference {
        original_name: name,
        path,
        display_width,
        pixel_width,
        pixel_height,
        byte_size,
    })
}

/// Shared attachments live in the vault's own root `assets/`, so a legal link
/// climbs: `../assets/…` from a page, `../../assets/…` from a split document.
/// The parser never learns how deep its file sits, so it checks the shape it
/// can own — any number of `../`, then `assets/`, then one file name — and the
/// loader resolves what that shape actually reaches.
fn extension_of(path: &str) -> String {
    path.rsplit('/')
        .next()
        .unwrap_or(path)
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default()
}

fn check_asset_path(path: &str) -> Result<(), Quarantine> {
    let mut rest = path;
    while let Some(next) = rest.strip_prefix("../") {
        rest = next;
    }
    let Some(name) = rest.strip_prefix("assets/") else {
        return Err(format!("`{path}` does not point into an assets folder."));
    };
    if name.is_empty() || name.contains('/') {
        return Err(format!("`{path}` is not one file in an assets folder."));
    }
    if name.contains("..") {
        return Err(format!("`{path}` is not a canonical asset path."));
    }
    Ok(())
}

fn highest_hlc(nodes: &[DocumentNode]) -> String {
    nodes.iter().fold(String::new(), |highest, node| {
        highest
            .max(node.hlc.clone())
            .max(highest_hlc(&node.children))
    })
}

/// A shape check at the trust boundary. Nothing is canonicalised any more: a
/// `yid` has one spelling, where a UUID had several and had to be folded onto
/// one — and folding is precisely what a `yid` must not have done to it, since
/// two ids differing only in case are two blocks.
fn block_id(value: &str) -> Result<String, Quarantine> {
    if !notes_core::is_block_id(value) {
        return Err(format!("`{value}` is not a block id."));
    }
    Ok(value.to_owned())
}

/// An unreadable stamp becomes no stamp. It then loses every comparison, which
/// is the safe direction: a garbled timestamp must never beat a real edit.
fn optional_hlc(value: Option<&String>) -> String {
    value
        .and_then(|value| Hlc::decode(value).ok())
        .map(|hlc| hlc.encode())
        .unwrap_or_default()
}

fn field_fits(value: &str, field: &str) -> Result<(), Quarantine> {
    if value.len() > MAX_FIELD_BYTES {
        return Err(format!(
            "A {field} of {} bytes is over the {MAX_FIELD_BYTES} byte cap.",
            value.len()
        ));
    }
    Ok(())
}

/// The inverse of the renderer's escaping, ported from the frozen v1 reader:
/// one left-to-right pass, so a backslash is consumed before what follows it
/// can match anything else. Splitting on `\n` first would turn a user's two
/// literal characters into a line break they never typed.
fn unescape_scan(value: &str, inline: bool) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while !rest.is_empty() {
        if let Some(next) = rest.strip_prefix("&amp;") {
            out.push('&');
            rest = next;
        } else if let Some(next) = rest.strip_prefix("&lt;") {
            out.push('<');
            rest = next;
        } else if let Some(next) = rest.strip_prefix("&gt;") {
            out.push('>');
            rest = next;
        } else if let Some(next) = rest.strip_prefix('\\') {
            match next.chars().next() {
                Some('n') if inline => {
                    out.push('\n');
                    rest = &next[1..];
                }
                Some(character) if character.is_ascii_punctuation() => {
                    out.push(character);
                    rest = &next[character.len_utf8()..];
                }
                // A backslash with nothing to escape is the user's backslash.
                _ => {
                    out.push('\\');
                    rest = next;
                }
            }
        } else {
            let character = rest.chars().next().expect("the rest is not empty");
            out.push(character);
            rest = &rest[character.len_utf8()..];
        }
    }
    out
}

fn unescape(value: &str) -> String {
    unescape_scan(value, false)
}

/// Inline text carries its newlines as the two characters `\n`, which only the
/// same scan can tell apart from an escaped backslash.
fn unescape_inline(value: &str) -> String {
    unescape_scan(value, true)
}
