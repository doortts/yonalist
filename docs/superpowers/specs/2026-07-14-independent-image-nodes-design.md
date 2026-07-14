# Notes Independent Image Nodes Design

## Purpose

Make every newly inserted image a first-class outline item in Notes. An image
item participates in the same tree, selection, move, indent, trash, and history
operations as a text item. Its image is the primary content and the existing
supporting-note field is its editable description.

This change is additive. Existing images already attached beneath text items
remain in their current representation and are not migrated.

## Confirmed Scope

- New images from the picker, Finder drag and drop, and clipboard paste create
  independent image nodes.
- A multi-image input creates one image node per image, in source order.
- The complete multi-image input succeeds or fails as one operation and is one
  Undo/Redo history entry.
- Image nodes support normal outline selection, drag, move, indent, outdent,
  completion, star, trash, restore, duplicate, and zoom behavior.
- `Shift+Enter` on a focused image item opens and focuses its description.
- An image hover/focus menu provides Show full-screen, View original,
  Download, Delete, and Settings.
- Settings opens the new `Notes > Images` settings target. This phase adds the
  target and visual focus only; it does not add image preferences.
- Legacy attached images keep rendering, resizing, export, and removal
  behavior. They receive the same image menu where the action is meaningful.

## Explicitly Out Of Scope

- Automatic conversion or relocation of existing attachments
- Image editing, crop, rotate, annotation, OCR, or captions separate from the
  node description
- General non-image file nodes
- Remote URL import or network storage
- Turn Into and collaboration features
- Configurable image defaults beyond the empty Settings target

## Chosen Architecture

Add a discriminated node kind to the existing Notes tree:

```text
notes_nodes.node_kind = "text" | "image"
```

An image node owns exactly one active image attachment when it is created. The
attachment remains in `notes_attachments`; the node stores outline identity and
description while the attachment stores file metadata and display width.

The alternatives were rejected for this phase:

1. A generic content-block table would support more future block types, but it
   would replace too much of the stable outline and history model.
2. Inferring an image node from an empty title plus one attachment is ambiguous,
   breaks legacy data, and cannot be validated reliably.
3. Keeping an image as content under a text node does not satisfy first-class
   outline movement, selection, or description semantics.

## Data Model

### Node Kind

Frontend and Rust expose `NoteNodeKind = "text" | "image"`. Every loaded node
has a required `nodeKind` field. SQLite schema version 5 adds:

```sql
ALTER TABLE notes_nodes
ADD COLUMN node_kind TEXT NOT NULL DEFAULT 'text'
CHECK (node_kind IN ('text', 'image'));
```

The default marks every existing node as text without inspecting or changing
its attachments. This is a schema compatibility migration, not an attachment
migration.

Version 4 node history snapshots are normalized to add
`nodeKind: "text"`, and their stored byte accounting is recomputed. This is
required because history replay compares exact canonical node states. Only node
snapshot JSON changes; attachment history rows and asset files remain intact.

### Image Node Invariants

- New image nodes are created only through the image-node batch import command.
- Each new image node owns exactly one attachment from the same batch.
- `title` stores the original filename for search, breadcrumbs, accessibility,
  export metadata, and recovery, but the outline body does not render it as a
  text title.
- `note` stores the visible image description.
- Existing text nodes may continue to own zero, one, or many legacy
  attachments.
- The database does not add a global one-attachment constraint because that
  would invalidate legacy text-node attachments and retained history rows.
- Generic create, split, and subtree-import commands always produce text nodes.
- Duplicate preserves node kind and attachment ownership.
- Generic title updates cannot change an image node's hidden filename, split is
  rejected for image nodes, and generic attachment add/remove is rejected for
  image-node owners. Resize remains valid.
- A loaded image node with zero attachments is treated as a recoverable damaged
  state and stays actionable; newly created image nodes must have exactly one.

## Image Insertion Contract

Path and byte inputs share one logical contract. The caller supplies stable
node and attachment IDs so a retry reuses the same operation identity.

```ts
interface ImageNodeInsertionAnchor {
  parentId: NoteId | null;
  afterId: NoteId | null;
}

interface ImportImageNodePathItem {
  nodeId: NoteId;
  attachmentId: string;
  sourcePath: string;
}

interface ImportImageNodeByteItem {
  nodeId: NoteId;
  attachmentId: string;
  originalName: string;
  mimeType: string;
  blob: Blob;
}
```

All items share one insertion anchor and initial display width. The first node
is inserted at the anchor; each later node is inserted immediately after the
previous imported node.

### Placement

- Dropping, pasting, or choosing an image while a normal row is targeted
  inserts the image node immediately after that row as a sibling.
- Targeting the zoomed page header inserts the first image as the first child
  of that page (`parentId = pageId`, `afterId = null`).
- Multiple images form a contiguous sibling block in input order.
- The existing thin outlined drop marker remains layout-neutral and indicates
  this insertion point.
- The pointer-following filename badge remains unchanged.

## Atomic Storage And History

The backend prepares and validates every file before mutating the tree. It then
creates all nodes and attachment rows inside one SQLite immediate transaction,
publishes content-addressed asset files with the existing reconciliation
marker discipline, records one history entry, and commits once.

Failure at any point leaves no new node, attachment row, history entry, or
unreferenced asset owned by the failed batch. Existing deduplicated asset files
remain untouched. The limits remain 20 MiB per image, 64 MiB per batch, 128
images per batch, and 512 active attachments per Vault.

One Undo soft-replays the complete batch out of the active workspace and one
Redo restores every node and attachment in the original order. The mutation
result returns `importedRootIds` in source order so the frontend can focus the
first image node.

## Rendering And Editing

### Outline Row

An image row keeps the standard left-side outline controls: menu trigger,
collapse indicator, bullet, guides, and selection state. The image frame takes
the place of the title editor in the content column. The filename is exposed to
assistive technology and search but is not duplicated as visible title text.

The row description uses the existing supporting-note editor beneath the
image. It supports tags, dates, paste, draft persistence, and inline links in
the same way as a text node note.

Keyboard behavior:

- `Shift+Enter`: open and focus description
- `Enter`: create the next text sibling through the existing outline command
- `Tab` / `Shift+Tab`: indent / outdent through the existing command
- Arrow navigation and selection shortcuts: unchanged
- `Cmd+Z` / `Ctrl+Z`: undo image insertion or later structural changes

If an image attachment cannot be loaded, the row renders `Image unavailable`
without deleting the node, so its menu, description, and recovery actions stay
available.

### Zoomed Page Header

Zooming an image node renders the image as the page's primary content and its
description below it. Breadcrumbs use the stored filename. Child text or image
nodes can still be added beneath it.

### Legacy Attachments

Text nodes continue to render `NotesAttachmentList` below title and note. Their
resize and lazy-residency behavior remains unchanged. Deleting a legacy image
removes only that attachment; deleting an image node deletes the whole node.

## Image Menu

The image frame shows a vertical-ellipsis icon at the upper-right while the
frame is hovered or contains keyboard focus. On coarse pointers the control is
always reachable. The menu is keyboard navigable, closes on Escape/outside
click, and does not start row dragging or image resizing.

- **Show full-screen** opens an in-app modal with the image contained within
  the viewport. Escape and the close icon dismiss it. Double-clicking the image
  performs the same action.
- **View original** asks a backend command to validate the attachment-owned
  path and open the original local file with the operating system.
- **Download** opens the native Save dialog with the original filename and
  asks a backend command to copy the validated attachment to the chosen path.
- **Delete** confirms the action. For an image node it soft-deletes the node;
  for a legacy attachment it removes only the attachment.
- **Settings** opens app Settings at `Notes > Images` and moves focus to the
  outlined Images settings section.

## App Navigation

A small typed `AppNavigationContext` exposes:

```ts
openSettings(section: SettingsSection, target?: SettingsTarget): void
```

Notes consumes this context instead of emitting a window event. `SettingsSection`
adds `notes`; `SettingsTarget` adds `images`. `SettingsPage` scrolls and focuses
the Images section when requested, applies a temporary outline, then clears the
target after it has been consumed.

## Search And Export

- Filename search works through the hidden `title` value.
- Tags and dates in the image description work through the existing `note`
  index and structured search parser.
- Structured tag/date indexing ignores an image node's filename title, so a
  filename such as `#urgent 2026-07-14.png` is searchable text but does not
  create a tag or date match. Add Date edits the description for image nodes.
- Markdown export emits the image at the node's outline position and emits the
  description as supporting text without duplicating the hidden filename as a
  visible bullet title.
- PDF export embeds the image at the node's position and renders the
  description below it.
- Legacy attachment exports retain their current filename-caption behavior.

## Security And Error Handling

- View original and Download resolve paths from attachment metadata inside the
  Notes asset root; caller-provided filesystem paths are never opened.
- View original verifies bytes and hash through the owned-file reader, writes a
  read-only temporary copy outside the Vault, and opens that copy. It never
  passes the content-addressed Vault asset to another application. Stale view
  copies are reconciled on a later Notes startup/open.
- Existing canonical-path, symlink, hash, MIME, decoded-pixel, and byte-size
  checks remain authoritative.
- Save cancellation is a quiet no-op. Existing destinations require the native
  dialog's explicit overwrite confirmation.
- A failed batch reports the first failing filename and reason while leaving
  selection, drafts, and the drop marker clean.
- A missing image does not make the node undeletable or prevent navigation to
  Settings.

## Performance Constraints

- Introduce one workspace-level image residency coordinator shared by primary
  image nodes and legacy attachment lists. At most eight decoded image object
  URLs may be live across the complete Notes workspace, not eight per row.
- The hover menu must not load image bytes by itself.
- Full-screen reuses the resident object URL while mounted and releases any
  modal-owned URL on close.
- Adding `nodeKind` must not add per-row subscriptions or defeat row memoization.
- A 10,000-node text-only outline must retain current projection complexity;
  image-specific work runs only for image nodes.

## Test Strategy

### Data And Backend

- v4-to-v5 migration marks all existing nodes as text and leaves attachment
  rows byte-for-byte unchanged.
- Invalid node-kind payloads and rows are rejected.
- Multi-image path and raw-byte imports create contiguous image nodes with one
  attachment each and preserve source order.
- A bad item or injected publication/transaction failure leaves no partial
  nodes, rows, assets, or history.
- Undo/Redo replays the whole batch as one history entry.
- Trash/restore/duplicate retain image-node kind and attachment ownership.
- Open-original and download reject unknown, removed, cross-Vault, symlinked,
  or tampered attachments.

### Frontend

- Domain validators require `nodeKind` and accept only text/image.
- Picker, Finder drop, and clipboard paste derive the expected insertion
  anchor and invoke one image-node batch command.
- Multiple inputs preserve order and focus the first imported image node.
- Text rows still render legacy attachments unchanged.
- Image rows render image primary content, hide filename text, and focus the
  description on `Shift+Enter`.
- Image-node Delete calls node deletion; legacy Delete calls attachment
  removal.
- The menu is hover/focus accessible and every action has the expected side
  effect.
- Settings opens `Notes > Images`, scrolls, focuses, and outlines the target.
- Image residency remains capped and menu interaction does not trigger extra
  byte reads.
- A 512-image mixed legacy/new fixture never exceeds eight live object URLs and
  revokes URLs on eviction, scope change, and unmount.

### Manual And Visual

- Drag one and multiple Finder images between outline rows and into a zoomed
  page; verify marker, order, and resulting hierarchy.
- Paste multiple clipboard images and select multiple files in the picker.
- Add a description with `Shift+Enter`, move/indent the image node, then undo
  and redo each structural change.
- Exercise all menu actions in light and dark themes and narrow/wide layouts.
- Verify full-screen containment for very wide, very tall, and animated images.

## Acceptance Criteria

- No existing attachment is converted or moved.
- Every newly inserted image is a first-class image node with one attachment.
- Multi-image input is ordered, all-or-nothing, and one Undo/Redo unit.
- Image descriptions are editable through `Shift+Enter` and persist in `note`.
- Hover/focus menu actions work with correct image-node versus legacy delete
  semantics.
- Settings reaches and highlights `Notes > Images`.
- Search, export, trash, history, and large-outline performance remain valid.
