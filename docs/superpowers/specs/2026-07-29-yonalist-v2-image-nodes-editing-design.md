# Yonalist v2 Image Nodes And Editing Design

**Date:** 2026-07-29  
**Status:** Pending written-spec review  
**Baseline:** `codex/yonalist-v2-core@9b2c3c2`

## Contract

| Field | Decision |
| --- | --- |
| Goal | Insert local images as first-class outline nodes and resize, replace, or delete them without changing the current product design. |
| Acceptance | Picker, file drop, and clipboard input create ordered image nodes; image bytes and metadata survive restart; resize and replace persist; structural operations and Undo/Redo treat an image node as one outline item; image loading stays outside startup and text-row render paths. |
| Non-goals | Crop, rotate, filters, annotation, OCR, remote-URL import, general file attachments, export, Markdown sync, Vault compatibility/sync, GitHub Notifications, and new visual design. |
| Boundaries | React editor, generated IPC contracts, Tauri raw/path adapters, `notes-application`, `notes-core`, `notes-sqlite`, and an app-local content-addressed image store. |
| Manual proof | In a fresh desktop process, paste two images between two bullets, resize and replace one, move the other across split panes, Undo/Redo each action, restart, and confirm order, dimensions, bytes, and unchanged text-editor behavior. |

## User-Visible Behavior

### Image nodes

- Every newly inserted image is an independent outline node.
- An image node participates in the existing selection, multi-selection, drag,
  cross-split drop, indent, outdent, move, duplicate, complete, star, collapse,
  zoom, Trash, restore, and session history behavior.
- The image is the node's primary visible content. Its original filename is
  available to search and accessibility APIs but is not rendered as a title.
- The existing supporting-note field is the image description. `Shift+Enter`
  opens and focuses it.
- `Enter` creates the next text bullet. `Tab`, `Shift+Tab`, arrow navigation,
  keyboard selection, and repeated-key behavior use the existing outline
  command paths.
- A missing or corrupt image renders the existing neutral
  `Image unavailable` recovery presentation. It remains selectable, movable,
  replaceable, and deletable.

### Insertion

- The file picker, external file drop, and clipboard paste accept PNG, JPEG,
  GIF, and WebP.
- Multiple images create one contiguous sibling block in source order.
- Targeting a normal row inserts the block after that row. Targeting an empty
  page or page header inserts it as the first child.
- One multi-image input is all-or-nothing and creates one Undo/Redo entry.
- The first inserted image receives focus.
- Limits are 20 MiB per image, 64 MiB per batch, 128 images per batch, and
  40 million decoded pixels per image. SVG and remote URLs are rejected.

### Editing

- A resize handle changes only the rendered width. Height follows the decoded
  aspect ratio. Width is clamped to 120 pixels through the current content
  width and commits once at pointer/keyboard gesture end.
- Replace opens the same image picker for one image. It keeps the node ID,
  hierarchy, description, children, flags, selection, and display width while
  replacing the owned bytes, filename, MIME type, dimensions, and content hash.
- Delete uses the existing soft-delete subtree command for the whole image
  node. Undo restores the node and its image.
- Duplicate creates a new node and image metadata row but reuses the immutable
  content-addressed asset bytes.
- Crop, rotate, filters, annotations, and destructive pixel editing are
  intentionally deferred.

### Presentation

- Reuse the current macOS visual contract and the existing image classes,
  dimensions, hover controls, selection styling, lightbox geometry, and menu
  placement from the current app.
- Do not introduce placeholders, captions, cards, borders, theme changes, or
  new toolbar chrome.
- The image menu contains Show full-screen, Replace, View original, Download,
  and Move to Trash. This work does not add a Settings destination.

## Considered Architectures

### A. First-class node plus app-local content-addressed asset

An image is represented by an ordinary tree node plus one image metadata row.
Immutable bytes live in an app-local content-addressed directory. The database
worker commits the tree, image metadata, revision, and history patch together.

This is the selected approach. It preserves the existing tree command model,
keeps large bytes out of startup snapshots and history, supports deduplication,
and ports the already verified v1 behavior without importing the v1 runtime.

### B. Image attachment under a text bullet

This is smaller initially but fails the requested node semantics: selection,
indentation, cross-split movement, Zoom, and deletion would need a second
parallel hierarchy. It is rejected.

### C. Generic block/content table

A generic block table would make future media types easier, but it replaces the
stable outline model before any second content type is approved. It increases
query, history, and rendering complexity and is rejected for this slice.

### D. Image bytes stored as SQLite BLOBs

SQLite BLOBs simplify row/file atomicity but increase WAL amplification and
database backup cost for large animated images. They also make original-view
and download paths more expensive. Separate immutable assets with explicit
publication and reconciliation are selected instead.

## Domain And Persistence

### Node kind

`NoteNodeKind` becomes:

```text
page | bullet | image
```

Pages have no parent. Bullet and image nodes require a parent. Generic create,
split, merge, and text import commands create bullet nodes. Image nodes are
created only through image import or image-node duplication.

An image node retains `text` as the original filename for search,
accessibility, breadcrumbs, and recovery. The ordinary title editor does not
render it. `note` remains the editable description.

### Image metadata

The current pre-release schema is edited in place and remains schema version 1.
Development databases using the old shape are reset explicitly; there is no
migration or compatibility reader.

```sql
CREATE TABLE notes_images (
    node_id TEXT PRIMARY KEY NOT NULL,
    content_hash TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL
        CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
    byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 20971520),
    pixel_width INTEGER NOT NULL CHECK (pixel_width > 0),
    pixel_height INTEGER NOT NULL CHECK (pixel_height > 0),
    display_width INTEGER NOT NULL CHECK (display_width >= 120),
    FOREIGN KEY(node_id) REFERENCES notes_nodes(id) ON DELETE CASCADE
) STRICT;
```

Normal writable state requires exactly one `notes_images` row for every active
image node and no row for page or bullet nodes. Read paths tolerate a missing
row and expose a recoverable unavailable state.

`notes-core` owns `NoteImage` metadata and reversible image mutations, but
never imports filesystem, SQLite, image-decoder, or Tauri APIs.
`DomainPatch` carries node and image upserts/deletes so import, replace,
resize, duplicate, Undo, and Redo remain one revisioned transaction.

`NoteView` adds one required `image: ImageView | null` field. Page and bullet
views return `null`; a healthy image view contains its bounded metadata. A
damaged image node also returns `null`, which selects the recovery
presentation. Returning metadata through the existing view keeps the
confirmed-store patch model one-to-one and avoids a second frontend entity
cache.

### Asset layout and lifetime

- Asset identity is the lowercase SHA-256 hash of validated source bytes.
- The relative filename is derived from that hash and the decoded MIME type,
  never from user input.
- Assets are published through a temporary sibling file, flushed, and renamed
  atomically before the SQLite commit.
- A failed database commit removes only an asset that was newly published by
  that attempt and has no committed reference.
- Replace and history replay never delete old bytes during the session because
  inverse history may still reference them.
- Close/idle reconciliation deletes assets unreferenced by the current
  database after session history has been discarded. Startup does not scan the
  asset directory.

## Application And IPC Boundaries

The existing small command/query API remains authoritative for tree operations.
Image byte transfer uses focused adapters so large payloads never enter
`CommandEnvelope`, mutation receipts, idempotency receipts, or history.

New application operations:

```text
notes_import_image_paths(ImagePathImportRequest) -> MutationReceipt
notes_import_image_bytes(raw ImageByteImportEnvelope) -> MutationReceipt
notes_replace_image_path(ImagePathReplaceRequest) -> MutationReceipt
notes_replace_image_bytes(raw ImageByteReplaceEnvelope) -> MutationReceipt
notes_read_image(ImageReadRequest) -> raw bytes
notes_view_image_original(ImageActionRequest) -> ()
notes_download_image(ImageDownloadRequest) -> ()
```

`ResizeImage` remains a small `NotesCommand` executed through
`notes_execute`. Move to Trash continues to use `DeleteSubtree`.

Path requests are accepted only from the native picker or Tauri file-drop
adapter. Clipboard bytes use a versioned, bounded binary envelope with stable
request, node, and operation IDs. The application layer validates session and
base revision before publication, and retries reuse the same IDs.

`MutationReceipt` keeps its current shape: an import, replace, or resize returns
the affected node in `changedNodes`, whose `NoteView.image` contains the new
metadata. `BootSnapshot`, viewport, forest, and search results use the same
bounded `NoteView`; image bytes are fetched lazily.

The browser preview implements the same TypeScript boundary with in-memory
Blob URLs. Production code does not branch inside row presentation beyond the
adapter implementation.

## Data Flow

### Import

1. React derives one stable insertion anchor and stable IDs.
2. Tauri receives native paths or one bounded raw byte envelope.
3. The image-ingest adapter validates filename, signature/MIME, byte limits,
   decoded dimensions, pixel count, and batch limits before mutation.
4. The asset store hashes and atomically publishes immutable bytes.
5. `notes-application` asks `notes-core` for one reversible node/image patch.
6. The DB worker commits patch, derived search data, revision, and history in
   one Unit of Work.
7. The receipt patches the confirmed model and focuses the first inserted node.

### Lazy display

1. An `IntersectionObserver` marks image frames near the viewport.
2. One workspace image-residency store grants at most eight active byte leases.
3. `notes_read_image` verifies the metadata-owned path, size, and content hash.
4. React creates an object URL, reuses it for the row/lightbox, and revokes it
   on eviction, replacement, page change, or unmount.
5. Hovering a menu or rendering an offscreen row never reads bytes.

### Resize and replace

- During resize, width is a local visual overlay. Pointer/key repetition does
  not issue database commands. Gesture end sends one `ResizeImage` command and
  creates one history entry.
- Replace prepares new bytes first, then commits one metadata replacement.
  The visible old image remains until the receipt succeeds. Failure preserves
  the old node and image without a partial flash.

## Error And Security Rules

- Validate decoded content rather than trusting extensions or caller MIME.
- Reject empty files, unsupported formats, over-budget input, malformed
  animations, invalid dimensions, path traversal, symlink/reparse-point
  escapes, directories, devices, FIFOs, and files that change while read.
- Resolve every read/open/download from database metadata under the held asset
  root. Never open a caller-supplied stored path.
- View original uses a verified read-only temporary copy; another application
  never receives the canonical asset path.
- Download publishes through a sibling temporary file and atomic rename after
  native overwrite confirmation.
- A batch reports the first invalid filename and reason and commits nothing.
- A stale revision returns the existing retryable conflict without republishing
  duplicate bytes.
- Broken metadata or missing bytes produces `Image unavailable`; it does not
  crash outline projection or make the node undeletable.

## Performance Contract

- Startup and `BootSnapshot` never read or decode image bytes.
- Text-only rows do not subscribe to image metadata or residency state.
- Each image row subscribes only to its own metadata and lease state.
- At most eight object URLs are live across both split panes and lightboxes.
- Offscreen assets are loaded only within a small viewport margin and are
  evicted least-recently-visible.
- Resizing paints locally and commits once per gesture.
- Duplicate reuses immutable bytes and performs no byte copy.
- A 50,000-node text fixture must stay within the existing startup and input
  budgets after image support is linked.
- An image menu open must produce zero image-byte reads.

## Test Strategy

### `notes-core`

- Page/bullet/image parent and ownership invariants.
- Import, resize, replace, duplicate, delete, restore, and inverse patches.
- Generic split/merge rejection for image nodes.
- Property tests keep tree/image ownership valid across command sequences.

### `notes-application` and contracts

- Stable raw/path request IDs and stale-revision behavior.
- Multi-image import is one patch and one history entry.
- Image metadata appears in exact camelCase generated payloads.
- Receipts and history never contain bytes or absolute paths.

### `notes-sqlite` and asset store

- Fresh schema invariants and no compatibility path.
- Transaction rollback and publication cleanup under injected failures.
- Restart persistence, deduplication, replacement, and close/idle GC.
- Signature/MIME, byte, decoded-pixel, path identity, and hash verification.
- View/download never expose or trust an unvalidated path.

### React

- Picker, drop, and clipboard create one ordered image-node batch.
- Image rows hide filenames visually and preserve text-row DOM geometry.
- `Enter`, held Enter, Backspace boundaries, Tab/Shift+Tab, arrows, selection,
  split drag, Zoom, and supporting notes match ordinary node behavior.
- Resize has a local overlay and one final mutation.
- Replace preserves node identity and shows the old image until success.
- Undo/Redo restores image metadata, focus, selection, and display width.
- Residency never exceeds eight object URLs and revokes every abandoned URL.
- Browser preview and Tauri adapters satisfy the same UI tests.

### Fresh desktop proof

- Use a disposable `YONALIST_V2_DATA_DIR` and a newly built process.
- Paste and drop multiple images between known bullets.
- Exercise resize, replace, multi-select move/indent, cross-split drag,
  lightbox, original view, download, Trash, Undo/Redo, and restart.
- Confirm Korean IME and held Enter/Backspace behavior on adjacent text bullets
  remains unchanged.
- Confirm no console errors, no startup image reads, and no object-URL leaks.

## Delivery Order

1. Domain metadata and reversible image patch.
2. Fresh SQLite schema, atomic metadata persistence, and asset-store port.
3. Generated contracts plus one raw-byte clipboard import vertical slice.
4. Lazy image row rendering and workspace residency cap.
5. Native picker and file-drop path import.
6. Resize, replace, menu, lightbox, original view, and download.
7. Structural parity, Undo/Redo, restart, performance, and desktop gates.

The first production checkpoint is deliberately thin: paste one PNG after a
text bullet, commit bytes and metadata, render it lazily, restart successfully,
and Undo/Redo it as one action. Later rows expand from that proven boundary.
