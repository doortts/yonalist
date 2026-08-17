//! Reads a vault file back into a document. Two rules shape everything here.
//!
//! Where a hand edit is merely untidy the parser copes — odd indentation, a
//! missing stamp, a bullet nobody gave an id. Where it cannot say what a line
//! means, the whole file is refused: half a document applied is worse than none,
//! because nothing downstream can tell which half it received.

use crate::document::{
    BlockState, ChildKind, DocumentId, DocumentNode, DocumentRoot, Footer, ImageReference, Marker,
    NodeBody, PageDocument, TrashDocument, VaultFile,
};
use std::collections::HashSet;

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
    let (body, footer) = split_footer(&body)?;

    let keys = read_frontmatter(&frontmatter)?;
    match keys.get("kind").map(String::as_str) {
        Some("yonalist-notes") => parse_page(&keys, body, footer),
        Some("yonalist-trash") => parse_trash(&keys, body, footer),
        Some(other) => Err(format!("`{other}` is not a kind this app writes.")),
        None => Err("The frontmatter has no kind.".to_owned()),
    }
}

/// The footer is the file's last non-blank element and there is exactly one of
/// it. A file with no footer is a plain markdown file somebody wrote by hand,
/// which is a state this format expects; a file with two is one nobody can say
/// the meaning of, so it is refused rather than half-read.
fn split_footer<'a>(body: &'a [&'a str]) -> Result<(&'a [&'a str], Footer), Quarantine> {
    let opens: Vec<usize> = body
        .iter()
        .enumerate()
        .filter(|(_, line)| line.trim_end() == "<!-- yonalist")
        .map(|(at, _)| at)
        .collect();
    let Some(&open) = opens.first() else {
        return Ok((body, Footer::default()));
    };
    if opens.len() > 1 {
        return Err("The file holds more than one yonalist footer.".to_owned());
    }
    let close = open + 2;
    if body.get(close).map(|line| line.trim_end()) != Some("-->") {
        return Err("The yonalist footer is not one line of JSON between its markers.".to_owned());
    }
    if body[close + 1..].iter().any(|line| !line.trim().is_empty()) {
        return Err("The yonalist footer is not the last thing in the file.".to_owned());
    }
    let footer: Footer = serde_json::from_str(body[open + 1])
        .map_err(|error| format!("The yonalist footer is not readable: {error}"))?;
    // Empty is a legitimate answer for either: a document that has never
    // reconciled with anything has no base, and a file written before its
    // snapshot was taken has no state hash yet. Both mean "no ancestor to
    // prove", which §5.3 already routes to asking rather than guessing. A
    // malformed hash is different — it would look like a base that exists.
    if !footer.state_hash.is_empty() {
        check_hash(&footer.state_hash, "state_hash")?;
    }
    if !footer.base.is_empty() {
        check_hash(&footer.base, "base")?;
    }
    Ok((&body[..open], footer))
}

/// Lowercase hex behind a named algorithm, or nothing. A hash this reader
/// cannot compare is worse than no hash: it would look like a base that exists.
fn check_hash(value: &str, field: &str) -> Result<(), Quarantine> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(format!("`{field}` is not a sha256 hash."));
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("`{field}` is not a sha256 hash."));
    }
    if hex.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Err(format!("`{field}` is not lowercase hex."));
    }
    Ok(())
}

/// Everything this version understands, in the order §4.2 fixes. Anything else
/// is carried through untouched so a newer device's file survives the trip.
const KNOWN_KEYS: &[&str] = &["kind", "format_version", "id", "parent", "sort_key"];

/// Keys an earlier development format wrote. The format version did not move,
/// so a file carrying one of these is not a newer device's file to round-trip —
/// it is an older one, and reading it would mint fresh ids for every line.
const RESERVED_KEYS: &[&str] = &[
    "max_hlc",
    "root_hlc",
    "root_marker_kind",
    "root_ordered_start",
    "root_collapsed",
    "root_completed",
    "root_starred",
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
        if RESERVED_KEYS.contains(&key) {
            return Err(format!(
                "`{key}` belongs to an older development format. Rebuild this vault."
            ));
        }
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

    let mut root = DocumentRoot {
        title,
        note,
        ..DocumentRoot::default()
    };
    apply_root_state(&mut root, footer.state.get(id.as_str()));

    let mut reader = NodeReader::new(false);
    let mut nodes = reader.read(body)?;
    if let DocumentId::Node(id) = &id
        && reader.ids.contains(id)
    {
        return Err("A node claims the document's own id.".to_owned());
    }
    for node in &mut nodes {
        apply_node_state(node, &footer)?;
    }

    Ok(VaultFile::Page(PageDocument {
        id,
        parent,
        sort_key,
        max_hlc: String::new(),
        state_hash: footer.state_hash,
        base: footer.base,
        root,
        nodes,
        unknown_frontmatter: keys.unknown.clone(),
    }))
}

fn parse_trash(keys: &Frontmatter, body: &[&str], footer: Footer) -> Result<VaultFile, Quarantine> {
    require_format_version(keys)?;
    if keys.get("id").is_some() {
        return Err("The trash does not have an id.".to_owned());
    }
    let mut reader = NodeReader::new(true);
    let mut nodes = reader.read(body.iter().peekable())?;
    for node in &mut nodes {
        apply_node_state(node, &footer)?;
    }
    Ok(VaultFile::Trash(TrashDocument {
        max_hlc: String::new(),
        state_hash: footer.state_hash,
        base: footer.base,
        nodes,
    }))
}

/// The heading has no comment of its own, so everything a bullet would say on
/// its line the root says in the footer instead.
fn apply_root_state(root: &mut DocumentRoot, state: Option<&BlockState>) {
    let Some(state) = state else {
        return;
    };
    root.collapsed = state.collapsed;
    root.starred = state.starred;
    root.completed = state.completed;
    root.marker = marker_of(state);
    root.unknown_state = state.unknown.clone();
}

/// The body is the authority on what it can express — the checkbox, the title,
/// the note. This fills in only what the body has nowhere to say, and a state
/// entry naming a block the body does not hold is stale metadata, not an error.
fn apply_node_state(node: &mut DocumentNode, footer: &Footer) -> Result<(), Quarantine> {
    if let Some(state) = footer.state.get(&node.id) {
        node.collapsed = state.collapsed;
        node.starred = state.starred;
        node.unknown_state = state.unknown.clone();
        // The line drew what it is. Only a row that drew nothing — a plain
        // bullet — has a marker left for the footer to state, and that is the
        // document root's case rather than a bullet's.
        if node.marker == Marker::Bullet {
            node.marker = marker_of(state);
        }
        // A todo already said so with its checkbox; anything else takes the
        // footer's word for it.
        if node.marker != Marker::Todo {
            node.completed = state.completed;
        }
        if let Some(child_kind) = state.child_kind.as_deref() {
            let child_kind = match child_kind {
                "page" => ChildKind::Page,
                "split" => ChildKind::Split,
                other => return Err(format!("`{other}` is not a child kind.")),
            };
            let NodeBody::Text(body) = &node.body else {
                return Err("A picture cannot also be a child document.".to_owned());
            };
            let (title, path) = read_link(body)
                .ok_or_else(|| format!("A child document line is not a link: `{body}`"))?;
            // The child document's frontmatter owns this node's state, so
            // whatever the parent's line said about it is not evidence.
            node.marker = Marker::Bullet;
            node.starred = false;
            node.completed = false;
            node.collapsed = false;
            node.body = NodeBody::Split {
                title,
                path,
                child_kind,
            };
        }
        if let NodeBody::Image(image) = &mut node.body {
            // A width below the minimum is drawn at the minimum: it is a
            // display choice, and clamping keeps the picture visible. A size
            // outside the format's bounds is different — it would break a DB
            // constraint further in, where the answer is no longer a
            // quarantine with a reason.
            image.display_width = state
                .width
                .unwrap_or(MIN_DISPLAY_WIDTH)
                .max(MIN_DISPLAY_WIDTH);
            image.pixel_width = state.pixel_width.unwrap_or(0);
            image.pixel_height = state.pixel_height.unwrap_or(0);
            image.byte_size = state.byte_size.unwrap_or(0);
            image.asset_hash = state.asset_hash.clone().unwrap_or_default();
            if image.byte_size > MAX_ASSET_BYTES {
                return Err(format!(
                    "A picture of {} bytes is over the {MAX_ASSET_BYTES} byte cap.",
                    image.byte_size
                ));
            }
            if (image.pixel_width == 0) != (image.pixel_height == 0) {
                return Err("A picture states one pixel dimension without the other.".to_owned());
            }
        }
        node.from = match (&state.restore_parent, state.restore_after) {
            (Some(parent), Some(after)) => Some((parent.clone(), after)),
            _ => None,
        };
    }
    for child in &mut node.children {
        apply_node_state(child, footer)?;
    }
    Ok(())
}

fn marker_of(state: &BlockState) -> Marker {
    match state.marker.as_deref() {
        Some("todo") => Marker::Todo,
        Some("ordered") => Marker::Ordered(state.ordered_start.unwrap_or(1)),
        _ => Marker::Bullet,
    }
}

fn require_format_version(keys: &Frontmatter) -> Result<(), Quarantine> {
    match keys.get("format_version").map(String::as_str) {
        Some("1") => Ok(()),
        Some(other) => Err(format!("Format version {other} is not one this app reads.")),
        None => Err("The document does not state its format version.".to_owned()),
    }
}

struct NodeReader {
    trash: bool,
    ids: HashSet<String>,
    count: usize,
}

impl NodeReader {
    fn new(trash: bool) -> Self {
        Self {
            trash,
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
        let mut stack: Vec<(usize, DocumentNode)> = Vec::new();

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
                let Some((_, open)) = stack.last_mut() else {
                    return Err(format!("A note has no line to belong to: `{line}`"));
                };
                let text = unescape(text.strip_prefix(' ').unwrap_or(text));
                if open.note.is_empty() {
                    open.note = text;
                } else {
                    open.note.push('\n');
                    open.note.push_str(&text);
                }
                field_fits(&open.note, "note")?;
                continue;
            }
            let Some(node_line) = read_node_line(rest, self.trash)? else {
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
            if !node_line.id.is_empty() && !self.ids.insert(node_line.id.clone()) {
                return Err(format!("The id {} appears twice.", node_line.id));
            }
            while stack.len() > depth {
                let (_, finished) = stack.pop().expect("the stack is not empty");
                match stack.last_mut() {
                    Some((_, parent)) => parent.children.push(finished),
                    None => roots.push(finished),
                }
            }
            stack.push((depth, node_line));
        }
        while let Some((_, finished)) = stack.pop() {
            match stack.last_mut() {
                Some((_, parent)) => parent.children.push(finished),
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

fn read_node_line(rest: &str, trash: bool) -> Result<Option<DocumentNode>, Quarantine> {
    let (prefix_marker, prefix_completed, body) = if let Some(body) = rest.strip_prefix("- [ ] ") {
        (Marker::Todo, false, body)
    } else if let Some(body) = rest.strip_prefix("- [x] ") {
        (Marker::Todo, true, body)
    } else if let Some(body) = rest.strip_prefix("- ") {
        (Marker::Bullet, false, body)
    } else if let Some((number, body)) = read_number(rest) {
        // Only the first row of a run keeps its number as the start; the rest
        // are counting, and reading each one as its own start says the same
        // thing. What the row was drawn as is what it goes back as.
        (Marker::Ordered(number), false, body)
    } else {
        return Ok(None);
    };

    let (body, comment) = split_trailing_comment(body);
    let id = read_id(comment)?;

    let mut node = DocumentNode {
        id,
        hlc: String::new(),
        body: NodeBody::Text(String::new()),
        note: String::new(),
        marker: prefix_marker,
        collapsed: false,
        completed: prefix_completed,
        starred: false,
        from: None,
        place: None,
        unknown_tokens: Vec::new(),
        unknown_state: std::collections::BTreeMap::new(),
        children: Vec::new(),
    };
    let _ = trash;

    node.body = if body.starts_with("![") {
        NodeBody::Image(read_image(body)?)
    } else {
        let text = unescape_inline(body);
        field_fits(&text, "text")?;
        NodeBody::Text(text)
    };
    Ok(Some(node))
}

/// The renderer writes exactly one space before the node comment, so the
/// boundary is the last ` <!--`. Two shapes deliberately keep the tail in the
/// body instead: a comment this reader cannot close, which is still the user's
/// bytes, and an image line whose only comment is its own `ya:` — a person
/// added it by hand and the merge issues the id. Dropping either would delete
/// text, and dropping a broken `yid:` would hand the node a new identity.
fn split_trailing_comment(line: &str) -> (&str, &str) {
    let Some(separator) = line.rfind(" <!--") else {
        return (line, "");
    };
    // Whitespace after the comment is an editor's, not the format's, so it does
    // not cost the node the identity the comment carries. Whitespace *before*
    // the comment belongs to the text and stays where it is.
    let candidate = line[separator + 1..].trim_end();
    if !candidate.starts_with("<!--") || !candidate.ends_with("-->") {
        return (line, "");
    }
    (&line[..separator], candidate)
}

/// Reserved words an earlier development format wrote on the line. The format
/// version did not move, so meeting one means an older file, not a newer one:
/// ignoring it would read the line as a brand new node and issue it a new id.
const RESERVED_TOKENS: &[&str] = &[
    "t:",
    "prev:",
    "from:",
    "star",
    "todo",
    "ordered:",
    "done",
    "split",
    "collapsed",
];

/// One token, one value. A bullet says which block it is and nothing else —
/// everything that used to ride along here lives in the footer now.
fn read_id(comment: &str) -> Result<String, Quarantine> {
    let Some(inner) = comment
        .strip_prefix("<!--")
        .and_then(|rest| rest.strip_suffix("-->"))
    else {
        return Ok(String::new());
    };
    let mut words = inner.split_whitespace();
    let Some(first) = words.next() else {
        return Ok(String::new());
    };
    if first != "yid:" {
        return Err(format!("`{first}` is not a token this format writes."));
    }
    let value = words.next().unwrap_or_default();
    let id = block_id(value)?;
    if let Some(extra) = words.next() {
        if RESERVED_TOKENS.contains(&extra) {
            return Err(format!(
                "`{extra}` belongs to an older development format. Rebuild this vault."
            ));
        }
        return Err(format!(
            "A node comment carries more than its id: `{extra}`"
        ));
    }
    Ok(id)
}

/// A numbered row, as markdown draws one. The number is the row's own: a run
/// counts up, so reading each row at the number it shows puts the run back
/// exactly as it was drawn.
fn read_number(rest: &str) -> Option<(i64, &str)> {
    let end = rest.find(|character: char| !character.is_ascii_digit())?;
    if end == 0 || end > 9 {
        return None;
    }
    let body = rest[end..].strip_prefix(". ")?;
    Some((rest[..end].parse().ok()?, body))
}

fn read_link(body: &str) -> Option<(String, String)> {
    let rest = body.strip_prefix('[')?;
    let close = rest.rfind("](")?;
    let title = unescape_inline(&rest[..close]);
    let path = rest[close + 2..].strip_suffix(')')?;
    Some((title, path.to_owned()))
}

/// A picture is an ordinary markdown image. How wide it is drawn, how big it
/// is and which bytes it is are all in the footer: none of them are things a
/// person editing the line would want to see, or could keep correct by hand.
fn read_image(body: &str) -> Result<ImageReference, Quarantine> {
    let (name, path) = read_link(body.strip_prefix('!').unwrap_or(body))
        .ok_or_else(|| format!("An image line is not a link: `{body}`"))?;
    check_asset_path(&path)?;
    check_asset_extension(&path)?;
    // Every markdown editor writes `![](…)`, and a picture with no name has no
    // metadata a row can be built from. What the file is called is the answer
    // the file already gave.
    let name = if name.is_empty() {
        path.rsplit('/').next().unwrap_or_default().to_owned()
    } else {
        name
    };
    Ok(ImageReference {
        original_name: name,
        path,
        asset_hash: String::new(),
        display_width: MIN_DISPLAY_WIDTH,
        pixel_width: 0,
        pixel_height: 0,
        byte_size: 0,
        unknown_tokens: Vec::new(),
    })
}

/// The link is the only thing that says what kind of picture this is until the
/// bytes turn up. An extension this app never writes is one it could not have
/// written, so the line is not one of ours.
fn check_asset_extension(path: &str) -> Result<(), Quarantine> {
    let extension = path.rsplit_once('.').map(|(_, tail)| tail).unwrap_or("");
    if !matches!(extension, "png" | "jpg" | "jpeg" | "gif" | "webp") {
        return Err(format!("`{path}` is not a picture this app writes."));
    }
    Ok(())
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

/// File input is a trust boundary. Whether the vault already holds this id is
/// a separate question, asked where the whole vault is in view.
fn block_id(value: &str) -> Result<String, Quarantine> {
    if notes_core::is_block_id(value) {
        return Ok(value.to_owned());
    }
    Err(format!("`{value}` is not a block id."))
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
