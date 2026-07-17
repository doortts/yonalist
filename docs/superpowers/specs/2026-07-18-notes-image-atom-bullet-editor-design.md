# Notes Image-Atom Bullet Editor Design

**Date:** 2026-07-18

**Status:** Approved by the user

## Goal

Treat the single image owned by an image bullet as one selectable character
inside that bullet's primary content while keeping the image visually block
level.

Users can place the caret before or after the image, type above or below it,
select the image with Shift+Arrow, copy/cut/paste/delete it, and exchange image
content with other applications. The image, its surrounding primary text, the
existing supporting note, and all child bullets remain one outline item.

An `image` node owns exactly one primary attachment. Removing that atom converts
the node to `text`; an image node never remains with zero primary images during
normal operation. The feature does not introduce a general rich-text document
or allow multiple primary images inside one bullet.

## Confirmed User Contract

- Primary text before the image renders above it.
- Primary text after the image renders below it.
- The caret has a legal position on either side of the image.
- The image is one atomic logical character for Arrow, Shift+Arrow, clipboard,
  and deletion.
- An image bullet retains a separate supporting `note` edited through the
  existing Shift+Enter flow.
- Existing image bullets begin with empty primary before/after text; their
  supporting notes are unchanged.
- Primary before/after text receives ordinary title behavior for tags, dates,
  inline Markdown, search, and export.
- While `nodeKind = image`, exactly one image remains mandatory; removing it
  changes the node to `text`.
- Image deletion and replacement are fully Undo/Redo-able.
- Copy and paste work both inside Yonalist and with other applications.

## Selected Data Model

### Persistent fields

Reuse `notes_nodes.title` for all user-visible primary text and add one required
image-position field:

```text
title = beforeText + afterText
imageOffsetUtf16 = UTF-16 length of beforeText
note = independent supporting note
```

For example:

```text
title:              "AboveBelow"
imageOffsetUtf16:   5
logical content:    "Above" + U+FFFC + "Below"
note:               "Supporting note"
```

The object replacement character is a logical/editor representation only. It
is not inserted into the persisted `title`.

SQLite adds `notes_nodes.image_offset_utf16 INTEGER NOT NULL DEFAULT 0` with a
non-negative check. Frontend and Rust `NoteNode`, import/export DTOs, mutation
inputs, audit snapshots, clipboard structures, and replay models expose
`imageOffsetUtf16`.

Text nodes require offset zero and ignore it. Image nodes require:

- `0 <= imageOffsetUtf16 <= title.length` in UTF-16 units;
- the offset is not between the two UTF-16 code units of a surrogate pair; and
- exactly one owned primary attachment for normal writable operations.

An image row damaged by external corruption with a missing or ambiguous
attachment set remains visible through the existing recovery presentation but
does not expose the primary editor. Normal mutations never create that state.

### Pre-release current-schema policy

The product is not released, so this feature does not introduce a schema
version, upgrade path, or compatibility migration. The authoritative current
schema directly defines `image_offset_utf16`, the attachment-aware FTS columns,
and their triggers. Existing development databases may be deleted once before
running the new build; the app does not automatically delete them at runtime.

The existing schema-version guard remains untouched infrastructure, but this
work neither increments it nor dispatches a migration. New image imports create
`title = ''`, `imageOffsetUtf16 = 0`, and `note = ''`. The attachment's
`original_name` remains the filename authority for menus, accessibility,
recovery labels, downloads, filename search, and the fallback label used by
breadcrumbs/search/navigation when primary text is empty.

### Filename and user text

The generic image-title mutation ban is removed because `title` is now user
content. Code that previously read the hidden filename from `node.title` reads
the owned attachment's `originalName` instead.

Search continues to match both primary user text and attachment filenames. The
active and lifecycle FTS schemas add an `attachment_name` field maintained by
node and attachment triggers for valid image nodes. Their indexed `title` value
is a derived search-only string: text nodes use raw title; image nodes use
`beforeText + U+0020 + afterText`. The separator is not persisted or rendered,
but prevents `foo[atom]bar` from becoming a false `foobar` token and keeps
`foo`/`bar` independently searchable. Search queries return raw
`notes_nodes.title`, not the derived FTS title.

`NoteSearchMatchedField` adds `attachment`; when more than one column matches,
classification priority is `title`, then `note`, then `attachment`. Search
results add `imageOffsetUtf16`, nullable `attachmentName`, and a server-computed
`displayLabel`. For an image node the shared label trims the two primary
segments and joins the non-empty parts with one boundary space; it falls back to
the owned attachment name only when both are empty. Breadcrumbs, parent trails,
quick jump, and search results all use this same rule instead of reading a
hidden filename from `node.title`. A filename match may show
`attachmentName` as secondary match context even when primary text supplies the
display label.

Structured tags and dates derive only from primary `title` and supporting
`note`, never from the filename. Tag/date parsing treats the image position as
a boundary so a token cannot be formed by joining text from opposite sides of
the image. Stored title token ranges remain raw-title UTF-16 offsets; the image
editor adds one logical unit to presentation offsets after the atom.

Inline Markdown is parsed independently for the before and after segments. A
Markdown delimiter does not span the image atom.

## Backend Mutation Boundary

The new behavior is not composed from several existing commands. Each user
gesture reaches one explicit backend mutation so node kind, text, offset,
attachments, sibling creation, history, and owned-file reconciliation remain
one coordinated logical operation.

### Primary text drafts

`UpdateNodeInput` adds `imageOffsetUtf16`. Updating an image node writes
`title`, `image_offset_utf16`, and the independently supplied `note` in one
existing update transaction. The draft engine always sends the latest complete
triple; Rust validates the title/offset pair before updating either field.

### Image-atom structural edits

A typed `notes_apply_image_atom_edit` command owns byte-free operations:

- remove the atom and convert the node to text;
- split before or after the atom; and
- create the empty text sibling for Enter on an atom-only selection.

Its input contains the source node ID, expected `updatedAt`, title, offset and
primary attachment ID, normalized logical selection, stable caller-generated
sibling ID when required, and one history context. Removing the atom may also
carry replacement plain text, so paste-over-atom is one operation rather than a
delete followed by an update. The history entry ID is also the operation ID.
The command stores a fingerprinted receipt in connection-local TEMP memory in
the same transaction as the edit. Its canonical fingerprint covers command
kind, complete expected target authority, normalized selection/replacement,
stable IDs, and history session.
Repeating the same entry ID and fingerprint returns the committed result;
reusing it for different input is rejected before mutation. Its result contains
the authoritative workspace delta plus the node ID and logical selection to
focus.

### Image byte paste and replacement

A typed `notes_apply_image_atom_paste` command owns every clipboard operation
that publishes image bytes. Its input contains:

- the target node and normalized logical selection;
- the expected target `updatedAt`, node kind, raw title, offset, and primary
  attachment ID (or explicit absence for a text node);
- a versioned ordered text/image fragment;
- stable caller-generated node and attachment IDs for every new object;
- original names, MIME types, byte lengths, and blobs; and
- one history context/operation ID for the complete paste.

The command reuses the current byte-ingest preparation, decoded-image checks,
content-addressed publication markers, and unknown-outcome retry discipline. A
retry reuses the same operation, history-entry, node, and attachment IDs. After
byte validation, the backend computes each blob's actual SHA-256, length, and
sniffed MIME. The canonical operation fingerprint hashes command kind, normalized
selection/text, complete expected target authority, stable IDs, original names,
and those validated byte descriptors. It never trusts a caller-supplied hash.
The command uses the same fingerprinted TEMP receipt rule as the byte-free edit.
If an identical operation already committed, the backend returns its
authoritative result; conflicting reuse is rejected. No response-loss retry can
publish duplicate nodes or files.

The backend prepares and validates every byte before its immediate transaction,
then applies conversion/replacement/sibling creation and attachment metadata in
one commit. Publication failure, row failure, history failure, or stale target
authority leaves no partial live node or attachment metadata. A newly published
file that becomes unreferenced is deleted best effort; deletion failure leaves
the existing reconciliation marker for later cleanup and does not turn a rolled
back database edit into success. The result returns all affected/root IDs in
display order for deterministic focus and testing.

The existing image-node import command remains the fallback when a paste has no
active inline editor target. Generic attachment removal and generic text-node
split remain unchanged and do not gain image special cases.

Operation receipts contain IDs, the canonical fingerprint, a compact
postcondition digest, focus/result metadata, and an acknowledged flag—never
image bytes or a workspace copy. They share the history session/epoch. A
committed receipt and its history entry are pinned against pruning until the
frontend applies the authoritative result and calls
`notes_ack_image_atom_operation`. Acknowledged receipts may be removed with
their history entry; acknowledgement is itself idempotent. All receipts
disappear when the Vault connection closes.
If the hard history limits cannot be satisfied without pruning an unresolved
receipt, the new operation is rejected before changing live data.

While one operation outcome is unknown, the Vault coordinator holds its
structural turn and blocks later mutations, history replay/reset, navigation
recording, and capacity cleanup. Read-only rendering remains available. Retry
first performs an epoch-bound receipt lookup, then resends the exact operation
only when no receipt exists in the same generation. The turn is released only
after a matching result is applied and acknowledged, or after generation-loss
reconciliation.

If the connection epoch changes before acknowledgement, the coordinator clears
the old mixed history and reloads authoritative live rows. Stable generated IDs,
the expected precondition, attachment hashes, and the deterministic
postcondition digest classify the result: exact post-state means the command
committed but its Undo entry was lost; exact pre-state means it did not commit
and may be offered again with a new operation ID; any other state is an
ambiguous conflict that is never retried automatically. Final Vault close makes
one best-effort lookup/reconciliation pass, then discards the runtime retry; a
later app start always treats persistent live state as authoritative.

## Logical Editor Model

### ImageAtomEditor

Introduce one image-node-only `ImageAtomEditor`. Ordinary text nodes keep the
existing `NoteTextField`; supporting notes keep their existing editor.

The editor is one controlled `contenteditable` host whose DOM projection has
three stable regions:

```text
editable before-text region
contenteditable=false image atom using the existing image component
editable after-text region
```

CSS renders the three regions as vertical blocks, even though the logical
selection order is text -> one atom -> text. Empty before/after regions retain
a legal caret target without persisting placeholder characters.

The same component is used by an ordinary outline row and a zoomed image page
header. Existing image lazy loading, resize, menu, lightbox, view-original,
download, drag-source presentation, and failure UI are composed inside the
non-editable atom rather than reimplemented.

### DOM/model mapping

A focused mapping module owns all conversions between DOM `Selection`/`Range`
positions and logical UTF-16 offsets:

```text
0 .. imageOffsetUtf16          before title text
imageOffsetUtf16               caret before atom
imageOffsetUtf16 + 1           caret after atom
remaining logical offsets      after title text
```

It also converts logical mutations back to persisted `title` plus
`imageOffsetUtf16`. DOM nodes, zero-width caret aids, and image descendants are
never treated as authoritative data.

The mapper covers empty segments, emoji/surrogate pairs, combining characters,
selection in either direction, rerendered DOM, and a selection that contains
the atom. Invalid DOM positions resolve to the nearest legal logical boundary
without committing unexpected text.

### IME composition

During `compositionstart` through `compositionend`, the browser owns the live
composition DOM. Intermediate Korean states such as `ㅎ -> 하 -> 한` remain
visible but do not trigger a controlled rerender or persistent draft write.

At composition end—or on blur/flush when no composition is active—the final
text and caret are mapped once into the title draft. This prevents duplicated
characters, separated jamo, and caret jumps across the image.

The editor registers a flush adapter with the existing draft engine. A
structural command waits for `compositionend`; it does not force an active OS
composition. Once composition is inactive, the adapter reads the stable DOM
projection, updates the title/offset draft, and participates in the same
`flushAllDrafts` barrier as `NoteTextField`.

Blur during composition records a pending flush and relies on the browser's
subsequent `compositionend`; event ordering cannot publish an intermediate
jamo. If an unmount or OS interruption never delivers composition end, the
waiting structural action is cancelled and reports through the bottom bar
rather than scraping partial composition DOM.

### Input-event ownership

`beforeinput` is the normalization boundary. The editor maps `insertText`,
`insertReplacementText`, selection deletion, and supported history-neutral
replacement into logical edits. It prevents browser-created paragraphs,
line-break elements, arbitrary HTML insertion, and native browser Undo/Redo:

- `insertParagraph` routes to the approved Enter split command;
- Shift+Enter routes to the supporting-note focus command;
- paste routes to the editor clipboard controller;
- drop routes to the existing Notes image/text target logic; and
- browser `historyUndo`/`historyRedo` routes to Notes session history.

Spellcheck replacement follows `insertReplacementText` and cannot replace the
atom unless its DOM range explicitly contains it. Unexpected mutation-observer
changes reset the DOM from the latest authoritative draft and normalize the
selection instead of being persisted.

The mutation observer is suspended for browser-owned changes while
`isComposing` is true. `compositionend` first maps the final DOM once, then
reenables the observer and validates the stable projection. Only unexpected
non-composition mutations take the reset path above.

The before-text node, atom wrapper, and after-text node keep stable keys while
focused. Image residency, loading, menu, and resize rerenders update descendants
inside the non-editable wrapper and never replace the composing text regions.

## Caret, Selection, and Text Input

- Left/Right crosses the image in one step.
- Shift+Left/Right selects or deselects the complete atom in one step.
- Shift+Up/Down can extend a continuous selection across the visual image
  block.
- Clicking the empty area immediately above or below the image places the caret
  on that side.
- Typing before the atom inserts into the before segment and advances the
  offset.
- Typing after the atom inserts into the after segment and leaves the offset
  unchanged.
- Replacing a text-only selection updates title and offset according to whether
  the replaced range is before or after the atom.
- A native pointer text selection that crosses into another row hands off to
  the existing multi-row selection behavior under the explicit surface rules
  below.

The image atom has a visible selected state distinct from whole-row selection.
It retains an accessible filename label. The editing host uses `role="textbox"`
and exposes its multiline and read-only state.

### Pointer selection and row-selection handoff

The editable regions and non-control image body are marked as native selection
surfaces rather than generic interactive targets. Image menu buttons, resize
handles, links, and lightbox gestures keep their existing interactive exclusion.

- Dragging from before/after text uses the native DOM range and may cross the
  atom.
- Clicking the non-control image body selects exactly the atom; Shift-click
  extends the current logical range to it.
- Dragging from the image body anchors at the nearest before/after atom boundary
  and extends a logical range.
- Once the pointer range enters another row, the pane maps the anchor/head rows
  into its existing node-ID range selection, includes every crossed row, and
  clears the native range exactly once.
- The bullet drag activator remains the only row-move drag source. Selecting
  text or the atom never starts structural drag.

The pane's interactive-target predicate therefore gains a narrow
`data-notes-native-selection-surface` exception; it does not broadly make
nested image controls selectable.

## Deletion and Conversion to Text

The atom is removed when:

- a Delete or Backspace range contains it;
- Delete is pressed from the caret immediately before it; or
- Backspace is pressed from the caret immediately after it.

Deletion performs one structural mutation:

1. remove the primary attachment row;
2. change `nodeKind` from `image` to `text`;
3. delete every selected primary-text code unit and join the unselected prefix
   and suffix around the former atom (an atom-only delete therefore keeps
   `beforeText + afterText`);
4. reset `imageOffsetUtf16` to zero;
5. retain the supporting `note`, children, flags, and outline position; and
6. place the caret at the former image boundary.

An empty result remains one empty text bullet. The attachment file is retained
by session history while Undo/Redo can reference it. One Undo restores the
image node, attachment, offset, text, note, children, and selection. One Redo
performs the same conversion again.

To make that selection restoration real, `NotesHistoryFocus` gains an optional
primary selection `{ anchorUtf16, focusUtf16 }`. Every structural image-atom
command captures it in both before and after snapshots, including a text
textarea selection before text-to-image conversion and the resulting text caret
after image removal. Text-node offsets are raw title UTF-16 positions;
image-node offsets are logical positions in which the atom occupies one unit,
so an atom-only range needs no separate boolean. Replay restores the range after
the appropriate textarea/contenteditable DOM commits; missing nodes and stale
offsets normalize to the nearest legal collapsed caret. Ordinary text bursts do
not start storing ranges merely because this optional field exists.

The image frame menu's content action is renamed to **Remove image** and invokes
this same conversion. Deleting or moving the complete outline item remains in
the ordinary row menu (`Move to Trash`) and whole-row keyboard/selection
commands. Damaged recovery rows stay non-editable rather than
attempting an unsafe replay through an invalid attachment state.

## Enter and Shift+Enter

### Caret before the image

At a caret in the before segment, Enter splits as follows:

- text to the caret's left remains in the current node, which becomes or stays
  a text bullet;
- text to the caret's right, the image, and all after text move to one new image
  sibling; and
- the new image offset equals the UTF-16 length of the moved before-image text.

As with the existing text split, the current source ID retains its supporting
note, children, completion/star/collapse state, and outline position. The new
image sibling receives default flags, an empty supporting note, and no children.

### Caret after the image

At a caret in the after segment:

- the image and text through the caret remain in the current image bullet; and
- text to the caret's right becomes a new text sibling.

The current image node keeps its ID, supporting note, children, flags, and
position. The new text sibling has the same default state as an ordinary Enter
split.

### Selected atom

Enter with exactly the image atom selected leaves the image bullet unchanged
and creates one empty default-state text sibling immediately after it; the
image node retains its note, children, flags, and ID.

For a mixed text-and-image selection, the command logically deletes the range
first. If that removes the atom, the resulting text then follows the ordinary
Enter split rule inside the same backend transaction and history entry.

Shift+Enter never inserts primary inline text. It retains the current Notes
contract of opening or focusing the independent supporting-note editor.

Every Enter variant is one Undo/Redo entry.

## Clipboard Formats

### Editor-selection routing

Atom and mixed selections are native DOM ranges inside `ImageAtomEditor`, not
outline node-ID selections. A dedicated editor clipboard controller owns them.
Clipboard precedence is:

1. an active image editor selection containing the atom;
2. an ordinary native text selection inside an editor;
3. the existing whole-row/multi-row selection controller; and
4. the pane's existing targetless image-ingest fallback.

The pane capture handler asks the active editor registry before importing image
File items. An editor-owned paste is stopped at that boundary, so the global
image ingest cannot create a sibling before replacement/conversion logic runs.
Whole-row selection serialization remains unchanged.

### Versioned internal fragment

The internal payload is version 1 and contains no Vault path or reusable
database ID:

```ts
interface NotesImageAtomClipboardV1 {
  version: 1;
  kind: "notes-image-atom";
  beforeText: string;
  afterText: string;
  image: {
    originalName: string;
    mimeType: string;
    byteSize: number;
    contentHash: string;
  };
}
```

`beforeText` and `afterText` are only the selected text on each side of the
selected atom. Supporting-note text is never folded into this fragment. Paste
always allocates new node/attachment IDs outside the source Vault; image bytes
come from the clipboard image flavor or the sanitized HTML data URL, never from
the source attachment path.

The JSON is written to a custom event flavor when supported and is also encoded
as escaped versioned data on the `text/html` wrapper. HTML therefore remains an
internal round-trip fallback on platforms that reject custom async formats.

### Copy serialization and settlement

Text-only selections retain their native/plain handling. A selection containing
the atom prepares one `ClipboardItem` with:

- `text/plain`: selected before text + `[Image: originalName]` + selected after
  text;
- `text/html`: escaped before text, one data-URL `<img>` carrying the versioned
  marker, and escaped after text;
- the original supported image MIME Blob when the platform reports support; and
- the custom version-1 payload when that custom flavor is supported.

The async `navigator.clipboard.write` path is authoritative because a native
`ClipboardEvent.setData` call cannot write image bytes. The copy/cut event is
prevented, the current selection/attachment authority is frozen, and the async
write starts under that user activation. If rich async writing is unavailable,
the synchronous event fallback writes plain text, HTML, and the custom string;
it does not claim native image-MIME interoperability. If the bounded HTML cannot
carry image bytes either, it reports that the atom was copied only as text/
metadata, and a Cut does not delete the source.

The editor prewarms visible attachment bytes on atom selection and reuses the
residency cache. One image is at most the existing 20-MiB input limit; the
transient base64 HTML representation has a separate 32-MiB bound. If HTML
encoding would exceed it, the write omits HTML image bytes but retains native
image MIME and plain text. No base64, Blob, or duplicate byte array remains in
application state after settlement.

Cut waits for a successful async write or byte-carrying synchronous HTML write,
then revalidates Vault, history epoch, node/attachment identity, draft
generation, and logical selection before calling the one structural delete
command. A write failure, metadata-only fallback, or stale authority never
deletes content. A successful write followed by stale selection leaves the
clipboard updated but the document unchanged and reports no false Cut success.

### Paste precedence and validation

Paste inspects formats in this order:

1. valid internal Yonalist payload;
2. clipboard-provided image File/Blob items;
3. sanitized HTML containing supported embedded image data; and
4. ordinary text handling.

An internal custom payload or HTML marker is valid only when at least one
clipboard byte carrier (native image Blob/File or embedded data URL) exactly
matches its declared `contentHash`, `byteSize`, and MIME after backend-equivalent
SHA-256, length, and MIME-sniff validation. The controller may ignore an
OS-transcoded native flavor when the exact HTML data URL still matches. If no
carrier matches, the marked internal paste is rejected atomically and does not
fall through to a looser external-image interpretation. This prevents metadata
from one Vault fragment from being paired with unrelated bytes.

Internal payloads preserve the exact atom position. External HTML accepts text
plus supported clipboard-provided file/blob/data-URL images. It discards
scripts, styles, event attributes, unsupported MIME data, and all remote
network URLs. Paste never fetches an HTTP(S) image implicitly.

Existing per-image, batch-byte, decoded-pixel, MIME, and batch-count limits
apply before any mutation. A multi-item paste is atomic: any invalid image
rejects the whole paste.

### Paste placement

#### Target text bullet

One pasted image replaces the current text selection, if any, and converts the
target node into an image node. Unselected target prefix plus pasted leading
text becomes the image's before text; pasted trailing text plus the unselected
target suffix becomes its after text. The supporting note and children remain.
When the paste contains additional images, the first image uses the target node
and each remaining image becomes a following sibling under the distribution
rule below.

This in-place conversion is allowed only when the text node owns no legacy
attachments. A text node that already owns one or more legacy attachments stays
text; the complete pasted image block is inserted as following image siblings,
and the bottom bar explains why inline conversion was not possible. Existing
legacy attachments are never reclassified or silently moved.

#### Target image bullet with selected atom

The pasted ordered fragment replaces the complete logical selection. With one
image, unselected target prefix plus pasted leading text becomes the new before
segment, and pasted trailing text plus unselected target suffix becomes the new
after segment. An image-only replacement therefore leaves the existing outer
primary text and offset unchanged. Supporting note, children, flags, and outline
position remain unchanged. The old attachment file stays retained while Undo
can restore it. When multiple images are pasted, the first replaces the selected
atom and each remaining image becomes a following sibling under the distribution
rule below.

#### Target image bullet without selected atom

The pasted image content becomes a new image sibling immediately after the
target. The current image bullet is not modified. Multiple images create a
contiguous following-sibling block.

#### Multiple images or mixed HTML

Each image becomes exactly one image bullet. The bullets are contiguous and
preserve source order. Leading text belongs before the first image, text between
images follows the preceding image, and trailing text follows the final image.
Unselected target text around a conversion or replacement remains at the outer
beginning/end of that ordered sequence; a sibling-only insertion leaves the
target node entirely unchanged.

When the target node is converted or its atom replaced, that first affected
node keeps its ID, supporting note, children, completion/star/collapse state,
and outline position. Additional image siblings receive new IDs, default flags,
empty supporting notes, and no children. When conversion is disallowed or an
existing image atom is not selected, the target remains entirely unchanged and
all pasted image nodes are new siblings. After success, the first affected atom
has the image-primary focus and an atom-only logical selection.

The complete paste, including every created node and attachment, is one
structural Undo/Redo entry.

Plain text pasted over a selection containing the image atom replaces the whole
selected logical range with that text, converts the node to text, places the
caret after the inserted text, and retains the supporting note, children,
flags, and ID. Plain text pasted at a caret before or after the atom edits only
that primary text segment.

## Search, Tags, Dates, and Export

- FTS indexes primary title text and attachment filename metadata without
  presenting the filename as visible primary text.
- Structured tags and dates parse before and after segments independently and
  map resulting ranges through the logical atom offset.
- Add/remove tag and Add Date actions modify the appropriate primary segment or
  supporting note without moving the image unexpectedly.
- Inline Markdown presentation is applied independently above and below the
  image.
- Markdown export keeps one list item and one checkbox/node ID. With `Above`,
  `Below`, and supporting note `Source`, its canonical shape is:

  ```markdown
  - [ ] Above <!-- yonalist-node-id: NODE_ID -->
    ![Image](assets/0001.png) <!-- yonalist-attachment-original-name: photo.png -->
    Below
    > Source
  ```

  Empty before text keeps the image on the checkbox line, matching the current
  image export. Empty after text omits its continuation line. Supporting-note
  newlines retain the existing indented quote format. All text and metadata use
  the current escaping and percent-encoding functions.
- Markdown import recognizes both the current image-on-marker form and the new
  continuation form above. It reconstructs one image node, `title`,
  `imageOffsetUtf16`, supporting note, and children without treating the image
  or after-text continuation as sibling/child bullets.
- PDF export renders the same visual order.
- Copy/export never substitutes supporting-note text for primary after-image
  text.

## Error Handling and Atomicity

- Backend inputs reject an invalid UTF-16 offset before opening a write
  transaction.
- Image-content mutations validate the one-owned-attachment invariant.
- All split, delete, replace, conversion, and multi-image paste operations use
  the explicit serialized mutation boundary defined above and one session
  history entry.
- Clipboard extraction or write failure performs no data mutation.
- A deferred clipboard or byte-load result is ignored if the Vault, scope,
  selection, attachment identity, or editor generation changed.
- A DOM/model mismatch restores the last authoritative draft and the nearest
  legal selection instead of persisting DOM artifacts.
- A missing or corrupt attachment renders the existing actionable error state;
  it is not silently deleted.
- User-visible failures use the Notes bottom bar.

## Performance

- Ordinary text rows keep their current textarea implementation and
  memoization.
- Image-specific mapping and selection listeners exist only while an image
  editor is rendered or focused.
- Editing title text never loads attachment bytes.
- Clipboard hydration reuses the current image residency cache and releases
  operation-owned Blob/data-URL memory after completion.
- History stores attachment metadata, not image bytes.
- The serialized Vault queue allows at most one unacknowledged receipt; compact
  acknowledged receipts are bounded by the same 100 retained mutation entries
  and disappear on prune/reset/close.
- Search and export operate on persisted text and metadata without decoding
  image pixels.

## Accessibility

- The combined primary editor is a named multiline textbox.
- The non-editable atom remains a named image `group` so its existing menu and
  resize controls stay valid interactive descendants; the rendered image keeps
  the attachment original filename as its alternative text.
- Atom selection has a visible non-color-only focus/selection indication.
- Existing image menu, resize handle, lightbox, download, and view-original
  controls remain keyboard reachable inside the non-editable atom.
- With an atom-only selection, `F6` moves focus into the image control group;
  Tab/Shift+Tab follow its existing nested control order, and Escape returns to
  the primary editor with the prior logical selection. Shift+F10/ContextMenu
  continues to open the image menu directly.
- Row selection, image-atom selection, and nested image controls retain distinct
  focus semantics.
- The regular row and zoomed page header expose identical keyboard and
  clipboard behavior.

## Testing

Follow strict RED/GREEN development.

### Model and current schema

1. Verify a fresh current database creates the offset column,
   attachment-aware FTS fields, and their triggers directly.
2. Reject negative, out-of-range, and surrogate-splitting offsets.
3. Preserve one-primary-attachment invariants through load, mutation, replay,
   duplicate, import, and export.
4. Verify new imports use empty title, empty note, and offset zero.
5. Keep filename search through the attachment FTS field/classification and use
   filename fallback in breadcrumbs, trails, quick jump, and search results.
6. Index `foo[atom]bar` as separate `foo`/`bar` terms, reject `foobar`, and
   verify matched-field priority plus raw-title/offset/display-label DTOs.
7. Verify tags/dates ignore filename metadata and cannot span the atom.

### Selection mapping and IME

1. Map forward/backward collapsed and range selections around empty and
   non-empty segments.
2. Cover emoji, combining marks, Korean composition, and DOM rerenders.
3. Cross the atom in one Arrow step and select it in one Shift+Arrow step.
4. Extend Shift+Up/Down selection across the rendered image block.
5. Cover normalized `beforeinput`, spellcheck replacement, blocked paragraphs,
   browser Undo routing, paste/drop ownership, and deferred flush during IME.
6. Ignore observer changes during composition and validate once after
   `compositionend` without resetting intermediate Korean DOM.
7. Cover atom click/drag and the explicit cross-row pointer handoff while nested
   controls remain interactive.

### Editing commands

1. Type before and after the atom and preserve its position.
2. Delete from both adjacent caret positions and from mixed selections.
3. Undo and Redo image deletion in exactly one action while preserving note and
   children, restoring logical caret/atom selection after render.
4. Cover every Enter split rule and Shift+Enter supporting-note focus.
5. Replace an image and Undo/Redo the old/new attachment exactly once.
6. Cover Remove image versus whole-row Move to Trash and non-editable damaged
   recovery rendering.
7. Verify structural command response-loss retries reuse stable operation/node/
   attachment IDs without duplicating data.
8. Reject a reused operation ID with a different fingerprint and prune compact
   TEMP receipts with their session-history entry.
9. Restore an ordinary textarea range after Undoing text-to-image conversion,
   and restore the image-editor result selection on Redo.
10. Pin an unknown outcome against queue/prune, acknowledge it explicitly, and
    classify exact pre-state, post-state, and ambiguous state after epoch loss.

### Clipboard

1. Serialize text-only, image-only, and mixed selections into the expected
   formats.
2. Exercise async ClipboardItem image-MIME writes, synchronous fallback, the
   32-MiB HTML bound, and Cut settlement/revalidation.
3. Copy an image to an external-capable clipboard flavor and paste an external
   image File/Blob back into Notes.
4. Round-trip the version-1 cross-Vault payload with fresh IDs and supporting
   note separation.
5. Prove editor selection precedes native text, row selection, and pane image
   ingest.
6. Sanitize mixed external HTML, reject remote URLs, and split multiple images
   into ordered sibling bullets.
7. Keep text nodes with legacy attachments unchanged and use sibling fallback.
8. Verify failed Copy/Cut/Paste and stale byte loads leave data and selection
   unchanged.
9. Treat every multi-image paste as one atomic Undo/Redo action and verify which
   node retains note, children, flags, and focus.
10. Accept an internal payload only when actual bytes match declared SHA-256,
    length, and sniffed MIME; reject missing/mismatched carriers without external
    fallback.

### Rendering and integration

1. Render primary text above and below a block-level image in both row and
   zoomed-header contexts.
2. Preserve resize, menu, lightbox, download, drag, row selection, and missing
   image recovery behavior.
3. Verify F6/Escape control-group focus and Shift+F10 menu access.
4. Verify tags, dates, attachment-name search, exact one-item Markdown, and PDF
   ordering.
5. Round-trip both image-on-marker and before/image/after Markdown forms into
   one image bullet with the exact offset, note, and child hierarchy.
6. Run complete frontend and Rust suites, lint, formatting, production build,
   and `git diff --check`.
7. In the running Tauri development app, directly verify Korean IME, mouse and
   keyboard caret placement, atom selection, image deletion Undo/Redo, and
   copy/paste with another macOS application.

## Rejected Alternatives

### Separate before and after textareas

Two fields render correctly but cannot provide one native continuous selection
through the image. Shift+Arrow, mixed copy, and accessibility would require a
second custom selection model layered over two controls.

### Use the supporting note as after-image text

The user requires an independent supporting note. Reusing it would lose the
semantic and keyboard distinction between primary content and explanation.

### General ordered content segments

A segment table or rich-text document would enable multiple images and future
block types, but it is unnecessary for the explicit one-image-per-bullet
contract and would replace too much stable Notes behavior.

### Store image bytes in Undo memory

Image binaries can be large and already live in verified Vault asset storage.
History needs only attachment identity and metadata while the owned file is
retained.

## Out of Scope

- More than one primary image inside a bullet.
- Arbitrary rich-text blocks or formatting spans across the image.
- Automatic download of remote clipboard URLs.
- Image crop, rotate, annotation, OCR, or format conversion.
- Changing legacy non-primary attachments owned by text nodes.
