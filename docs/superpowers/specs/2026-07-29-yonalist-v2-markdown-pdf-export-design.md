# Yonalist v2 Markdown And PDF Export Design

**Date:** 2026-07-29
**Status:** Pending written-spec review
**Baseline:** `codex/yonalist-v2-core@1c08714`

## Contract

| Field | Decision |
| --- | --- |
| Goal | Export the active pane's current page or one selected outline subtree as deterministic Markdown or a Korean-capable PDF without changing the current product design. |
| Acceptance | Export first flushes drafts, captures one revision-consistent immutable snapshot, includes the complete active text/image subtree, saves through the native dialog, performs no work after cancellation, asks before replacing an existing destination, and never publishes a partially written document or asset directory. |
| Non-goals | Generic file attachments, Vault Markdown synchronization, import from an export, batch export, background/automatic export, sharing, cloud destinations, HTML/OPML export, database compatibility, GitHub Notifications, and visual redesign. |
| Boundaries | Existing React toolbar/menu, generated IPC contracts, a small application export use case and ports, one SQLite snapshot query, the local image asset port, pure Markdown/PDF renderers, and a hardened native publication adapter. |
| Manual proof | In a fresh desktop process, edit Korean text without waiting for debounce, export the active page and a selected nested image subtree to Markdown and PDF, cancel a save, reject and then confirm an overwrite, inspect both outputs, and confirm the outline revision and Undo/Redo state did not change. |

## User-Visible Behavior

### Targets

- The existing Export trigger and v1 menu layout, labels, icon, feedback,
  confirmation dialog, spacing, and styling are reused without redesign.
- `Current page` means the active pane's current Zoom root, matching the v1
  observable behavior. Without Zoom, it is the page root.
- `Selected node` is enabled only when the active pane has exactly one selected
  outline node. Its complete subtree is exported.
- A multi-selection does not guess a target. The selected-node items are
  disabled while the current-page items remain available.
- A selected image node is a valid subtree root.
- A split pane that is not active never supplies the target implicitly.

The menu keeps these four actions:

```text
Selected node as Markdown
Selected node as PDF
Current page as Markdown
Current page as PDF
```

### Save flow

1. The user selects a target and format.
2. Every pending title and supporting-note draft is flushed.
3. A failed flush stops the operation and shows the existing retry feedback.
4. A native save dialog opens with a sanitized target title and `.md` or
   `.pdf` extension.
5. Cancelling the dialog performs no export IPC, changes no feedback, and
   leaves no temporary files.
6. Accepting it executes one export request. A busy controller ignores
   duplicate clicks.
7. If the document or the Markdown asset directory already exists, the backend
   returns a structured destination conflict.
8. The existing `Replace existing export?` confirmation retries the exact
   request with `overwrite: true`.
9. Success shows the existing `Exported Markdown.` or `Exported PDF.`
   feedback. Other failures remain retryable only when their structured error
   says so.

Export is a read-only use case. It does not increment the Notes revision,
create history, clear Redo, change selection, move focus, or navigate either
pane.

## Supported Content

- Page, bullet, and image nodes in stored sibling order.
- The full subtree, including descendants hidden by collapse.
- Title, supporting note, marker, completion state, and node identity.
- Local PNG, JPEG, GIF, and WebP image nodes already supported by v2.
- Image description, intrinsic dimensions, display width, original filename,
  MIME type, content hash, and validated immutable bytes.
- Soft-deleted and archived descendants are excluded. A missing, deleted, or
  archived root is rejected.

Generic attachments are not represented by the current v2 schema and are
therefore excluded. The export model leaves no empty attachment stub or legacy
Vault field.

## Considered Architectures

### A. Rust-owned snapshot, renderers, and native publication

The application layer validates the session and expected revision, asks a
dedicated query port for one immutable subtree, hydrates unique local image
payloads, selects a pure renderer, and publishes through a native output port.

This is the selected approach. It keeps authoritative content and path safety
outside the WebView, avoids a large snapshot IPC payload, shares one model
between Markdown and PDF, and preserves the v2 dependency direction.

### B. WebView serialization and client-side PDF

React could serialize the visible store and use a JavaScript PDF library. This
would miss unloaded descendants, duplicate query authority in the renderer,
increase the editable bundle, and weaken native path and atomic-overwrite
guarantees. It is rejected.

### C. Direct port of the v1 export module

The v1 implementation contains useful behavioral oracles, but it also combines
SQLite queries, Vault guards, attachment compatibility, rendering, file
publication, platform races, and thousands of tests in one module. Porting it
wholesale would recreate the architecture being replaced. Only the supported
output contract, limits, PDF geometry, and security invariants are retained.

## Architecture

### Dependency direction

```text
notes-core
  -> notes-application export model, use case, and ports
       -> notes-sqlite export snapshot adapter
       -> notes-export Markdown/PDF and publication adapters
            -> desktop Tauri IPC and save-dialog adapter

desktop React lazy Export feature
  -> generated export request/result contracts
       -> desktop Tauri IPC
```

`notes-export` is a focused outer adapter crate. It may depend on
`notes-application` export types; neither `notes-core` nor
`notes-application` imports it. It contains no Tauri state, React behavior, or
SQLite query.

The design intentionally does not add export methods to the mutation-focused
`StoragePort`, rendering branches to `NotesService`, or export DTOs to
`NoteView`.

### Application model and ports

The application layer owns these internal concepts:

```text
ExportTarget
  root_node_id

ExportSnapshot
  revision
  root_node_id
  title
  exported_at
  root: ExportNode

ExportNode
  id
  kind
  marker
  text
  note
  completed
  image: ExportImage?
  children: ordered ExportNode[]

ExportImage
  content_hash
  original_name
  mime_type
  byte_length
  pixel_width
  pixel_height
  display_width
  bytes: shared immutable payload
```

The snapshot is separate from the interactive `NoteView`. It contains no pane,
selection, cursor, history, absolute asset path, or mutable application
reference.

Focused ports keep responsibilities small:

```text
ExportSnapshotPort
  load_export_snapshot(expected_revision, root_node_id)

ExportImagePort
  read_verified_image(export_image_reference)

ExportRendererPort
  render(snapshot, format)

ExportPublicationPort
  publish(destination, rendered_export, overwrite)
```

Image hydration reads each unique content hash once and shares its immutable
payload between duplicate image nodes. Both renderers consume the same fully
validated `ExportSnapshot` shape.

### IPC

The WebView never receives the export snapshot or image bytes. Generated
contracts add:

```text
ExportFormat
  markdown | pdf

NotesExportRequest
  session_id
  base_revision
  root_node_id
  format
  destination_path
  overwrite

NotesExportResult
  revision
  root_node_id
  format
  destination_path
```

The only production command is:

```text
notes_export(NotesExportRequest) -> NotesExportResult
```

`base_revision` is captured only after draft flush. The DB worker compares it
with the authoritative revision inside the snapshot operation. A conflict
returns the existing retryable revision error rather than silently exporting a
newer or older tree.

The result revision equals the requested and captured revision. No
`MutationReceipt` is returned because export is not a mutation.

### SQLite snapshot

`notes-sqlite` implements `ExportSnapshotPort` on the existing DB worker:

- one read transaction checks the revision and loads the root plus active
  descendants;
- tree order is `sort_key`, then node ID as a stable tie breaker;
- image metadata is loaded in the same transaction;
- recursive traversal rejects cycles, missing parents, duplicate identities,
  invalid node/image ownership, and depth or count overflow;
- no image file is read while the SQLite transaction is held;
- the assembled value is detached from the connection before rendering.

The retained v1 safety limits are:

- at most 20,000 exported nodes;
- at most 128 nesting levels;
- at most 512 image nodes;
- at most 256 MiB PDF image working memory after conservative decode
  accounting.

The query is invoked only by Export. Bootstrap, viewport, search, mutations,
and startup do not join or precompute export data.

## Rendering Contract

### Deterministic Markdown

For the same immutable snapshot and asset directory name, output document
bytes and asset filenames are identical. The snapshot captures one
`exported_at` value, so rendering itself never reads a clock.

The frontmatter preserves the supported v1 byte contract:

```yaml
---
kind: yonalist-notes-export
format_version: 1
source: notes.sqlite
root_node_id: "<uuid>"
exported_at: "<snapshot UTC timestamp>"
---
```

- The page/selected root title is rendered using the existing v1 root-heading
  rule.
- Text rows use two-space nesting and task-list markers: `- [ ]` or `- [x]`.
- Every row retains its `yonalist-node-id` comment.
- Supporting-note lines are nested block quotes.
- Markdown syntax, comment metadata, alt text, and line endings are escaped
  deterministically.
- Empty text remains an empty task-list item; no placeholder is introduced.
- Collapsed descendants are included.

When images exist, the output uses a sibling directory named
`<document-stem>_assets`. Files are assigned deterministic traversal ordinals
such as `0001.png`. Equal content hashes reuse one asset file. Links are
relative, URL encoded, and never contain original path components. Original
filenames are preserved only as escaped metadata.

The asset directory includes the v1 ownership marker
`.yonalist-notes-export.json`. Yonalist may replace an existing asset directory
only when a valid marker identifies it as an owned export.

### Korean-capable PDF

- Output is a valid A4 PDF using the verified v1 margins, hierarchy indents,
  bullet/task markers, line heights, image sizing, wrapping, pagination, and
  footer/page-number behavior.
- The bundled Nanum Gothic font is read and parsed only when PDF export is
  invoked. It is embedded/subsetted so Korean text survives on a system without
  that font installed.
- Unsupported glyphs produce a stable export error rather than missing-glyph
  boxes or a crash.
- Rows are kept together when they fit on a page; long content wraps without
  truncation.
- Images preserve aspect ratio, respect the stored display width, fit inside
  page bounds, and reuse one PDF image object for duplicate payloads.
- GIF and WebP animations use their first decoded frame deterministically.
- The serialized PDF is reparsed and structurally validated before
  publication.

PDF bytes do not need to be byte-identical across future renderer-library
updates. The logical text, ordering, page geometry, font coverage, and image
placement are deterministic within the pinned implementation.

## Native Publication And Security

The native publication adapter accepts only the destination chosen by the save
dialog and treats it as untrusted:

- require an absolute regular-file destination with the requested extension;
- reject directories, devices, FIFOs, symlinks, Windows reparse-point escapes,
  invalid UTF-8 file stems where an asset directory is needed, and paths under
  the live database, image asset, or temporary-original roots;
- never follow a destination or asset-directory link during preflight,
  staging, displacement, rollback, or cleanup;
- create stage and backup entries with unpredictable names in the destination
  parent;
- write, flush, and close every staged file before publication;
- publish by same-volume rename and never write an existing destination in
  place;
- fail closed when destination identity changes during a publish operation.

PDF publication is one staged-file replacement. Markdown publication stages
the document, all deduplicated assets, and the ownership marker before changing
either final destination. An in-process failure restores the previous owned
document/assets and removes only stage entries created by that operation.
Individual final files are never partially written.

Without `overwrite`, any existing document or asset destination returns
`destination_exists`. With `overwrite`, an unmarked or malformed existing
asset directory is still refused; explicit confirmation does not authorize
deleting an unrelated directory.

Stable export-specific error codes are added:

```text
destination_exists
invalid_destination
export_too_large
export_failed
```

Storage unavailability and revision/session errors keep their existing codes.
Messages may provide detail, but UI decisions never compare message text.

## Frontend And Lazy Loading

- The app shell contains only a small Export trigger boundary.
- Menu/controller, save-dialog adapter, filename sanitization, feedback, and
  preview download support are dynamically imported on first trigger.
- Opening or closing unrelated menus does not load Export.
- Tauri's native renderer is linked as an outer adapter but performs no query,
  file access, image decode, font read, font parse, or allocation on startup.
- PDF font bytes are packaged as a resource and opened only for PDF export,
  rather than included in a startup snapshot.
- Export progress is controller-local and does not publish a shell or outline
  snapshot.
- The browser preview uses the same target selection and renderer request
  surface, then downloads a Blob. Native overwrite and path-security behavior
  is proven only in Tauri tests and the fresh desktop path.

The initial editable JavaScript remains at or below 300 KiB raw and 90 KiB
gzip. The export chunk and dialog dependency are reported separately.

## Failure And Concurrency Rules

- Draft flush failure produces no dialog request or export.
- Save cancellation produces no IPC.
- Session mismatch, stale revision, deleted root, damaged hierarchy, missing
  image bytes, hash mismatch, unsupported image/font data, budget overflow,
  render failure, and publish failure produce no new final artifact.
- If content changes after the snapshot is detached, the running export still
  represents its captured revision. A later export captures the later
  revision.
- Export never holds the session-history mutex while rendering PDF or writing
  files.
- Only one export operation runs per frontend controller. Native publication
  also uses exclusive destination stage names and identity revalidation so
  separate windows cannot write through each other's destination.
- Retrying a non-conflict failure opens no new dialog and reuses the chosen
  target, format, and destination after a fresh draft flush and snapshot.
- Confirming overwrite also performs a fresh draft flush and revision check;
  it never publishes stale content merely because the earlier attempt found a
  destination conflict.

## Test Strategy

### Application

- Session and revision validation.
- One immutable snapshot is passed to either renderer.
- Missing/deleted/archived roots and damaged ownership fail closed.
- Image payloads are read once per unique hash and never enter IPC types.
- Export changes no revision or history state.
- Node, depth, image-count, and image-working-memory limits.

### SQLite

- One read transaction observes a coherent revision while a queued writer
  changes node text or image metadata.
- Stable sibling ordering, full collapsed subtrees, and active-only filtering.
- Cycle, orphan, duplicate, invalid image ownership, missing metadata, and
  over-budget rejection.
- Query-count assertions prevent one query per node or image.

### Markdown

- Golden byte fixture for frontmatter, Korean text, escaping, task markers,
  notes, empty rows, IDs, ordering, and line endings.
- Selected page, bullet, and image roots.
- Deterministic asset names, relative links, duplicate-image reuse, original
  filename escaping, and owned marker contents.
- Same snapshot renders identical bytes twice.

### PDF

- Output begins with `%PDF-`, reparses, has the expected page count, and embeds
  a Unicode font.
- Korean strings remain extractable/encoded, long rows wrap, and rows paginate
  without truncation.
- Nested images align with their hierarchy, preserve aspect ratio/display
  width, fit page bounds, and deduplicate payload objects.
- Unsupported glyph, corrupt image, and working-memory budget failures.

### Publication and security

- Cancellation and no-overwrite leave the filesystem unchanged.
- New export and confirmed replacement publish complete files.
- Markdown rollback restores both prior document and owned assets.
- Unmarked asset directories, link/reparse destinations, database/assets
  roots, destination swaps, backup-slot races, and injected write/flush/rename
  failures fail closed without deleting foreign files.
- Windows and macOS same-volume rename and destination identity behavior.

### React

- The exact four v1 menu actions and existing confirmation copy/styles.
- Active-pane current root and exactly-one-selected-node targeting.
- Multi-selection disables only selected-node actions.
- Draft flush occurs before dialog/export and failure stops the flow.
- Cancellation is a no-op, duplicate clicks are ignored, overwrite uses the
  structured code, retry refreshes the snapshot, and success/error feedback is
  stable.
- Export modules are absent from the initial editable chunk.

### Fresh desktop proof

- Use a disposable `YONALIST_V2_DATA_DIR` and a newly built process.
- Export Korean text, completion markers, deep nesting, supporting notes,
  collapsed children, one unique image, and two nodes sharing image bytes.
- Exercise selected/current targets, both split panes, cancellation, conflict,
  confirmed overwrite, retry, and restart.
- Inspect the Markdown/asset directory and parse the PDF.
- Confirm revision, Undo/Redo, selection, pane focus, and startup metrics are
  unchanged and no console/native error is emitted.

## Delivery Order

1. Application export model, ports, limits, generated IPC types, and failing
   vertical-slice tests.
2. Revision-consistent SQLite subtree snapshot without image byte reads.
3. Deterministic Markdown renderer for text-only output.
4. Verified image hydration plus Markdown asset staging/publication.
5. Lazy existing-design React menu, save flow, conflict confirmation, and
   browser preview adapter.
6. Korean PDF renderer, font resource, images, pagination, and structural
   validation.
7. Native overwrite/rollback race hardening, Windows/macOS proof, Clippy,
   architecture, bundle, and fresh desktop gates.

The first production checkpoint is deliberately narrow: flush one edited
Korean page, choose a new `.md` destination, capture one revision, write a
deterministic text-only export atomically, and leave revision/history
unchanged. Images and PDF expand from that proven boundary without adding a
second snapshot model.
