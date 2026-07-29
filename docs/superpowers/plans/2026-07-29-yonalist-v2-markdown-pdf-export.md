# Yonalist v2 Markdown And PDF Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export the active pane's current page or one selected subtree as deterministic Markdown or a Korean-capable PDF through one revision-consistent Rust snapshot and an atomic native save path.

**Architecture:** `notes-application` owns generated requests, the immutable export model, focused ports, and a read-only service method. `notes-sqlite` builds the bounded snapshot on the existing DB worker; a new outer `notes-export` crate renders Markdown/PDF and publishes staged artifacts; Tauri stays a thin IPC adapter while React lazy-loads the unchanged v1 menu interaction.

**Tech Stack:** Rust 1.97, `notes-core`, `notes-application`, `notes-sqlite`, SQLite, Tauri 2.11, `printpdf` 0.11.1, `lopdf` 0.44, `image` 0.25.10, React 19, TypeScript 6, Vitest 4, `ts-rs` 12.

## Global Constraints

- Preserve the current DOM geometry, CSS tokens, typography, icon sizing, menu placement, feedback, confirmation copy, split layout, and macOS visual reference.
- Export only active page/bullet/image subtrees. Generic attachments, Vault sync, import, GitHub Notifications, and new design remain excluded.
- Flush drafts before opening the native save dialog. Cancellation performs no export IPC and produces no feedback.
- Export is read-only: no revision increment, history entry, Redo clearing, selection/focus change, or pane navigation.
- Use one immutable snapshot model for Markdown and PDF. Do not send it or image bytes through IPC.
- Keep schema version 1 and add no migration, compatibility reader, export table, or cached export column.
- Limits are exactly 20,000 nodes, 128 levels, 512 image nodes, and 256 MiB conservative PDF image working memory.
- Image bytes are read once per unique content hash after the SQLite transaction and verified through the existing `ImageAssetPort`.
- Initial editable JavaScript remains at or below 300 KiB raw and 90 KiB gzip; Export UI/dialog code must be a lazy chunk.
- The bundled Nanum Gothic font is a Tauri resource read only during PDF export.
- New production files target 500 lines or fewer and tests 800 lines or fewer.
- Every production behavior begins with a focused failing test and an observed RED result.

## File Structure

| Path | Responsibility |
| --- | --- |
| `crates/notes-application/src/export.rs` | Export DTOs, immutable model, limits, focused ports |
| `crates/notes-application/src/service/export.rs` | Session/revision validation, image hydration, render/publish orchestration |
| `crates/notes-application/tests/export_service.rs` | Read-only service, deduplication, errors, history invariants |
| `crates/notes-sqlite/src/export_snapshot.rs` | One-transaction bounded subtree assembly |
| `crates/notes-sqlite/tests/export_snapshot.rs` | Ordering, coherence, limits, invalid state |
| `crates/notes-export/src/markdown.rs` | Deterministic frontmatter/tree/assets renderer |
| `crates/notes-export/src/pdf.rs` | Korean A4 text/image renderer and structural validation |
| `crates/notes-export/src/publication.rs` | Staging, overwrite ownership, rollback, path safety |
| `crates/notes-export/tests/markdown.rs` | Markdown byte and image-asset goldens |
| `crates/notes-export/tests/pdf.rs` | Korean/font/wrap/pagination/image PDF behavior |
| `crates/notes-export/tests/publication.rs` | Conflict, rollback, link/path safety |
| `apps/desktop/src-tauri/src/export_ipc.rs` | Thin `notes_export` command and native adapters |
| `apps/desktop/src/exportApi.ts` | Generated request/result usage and filename rules |
| `apps/desktop/src/exportPicker.ts` | Lazy native save dialog and preview download |
| `apps/desktop/src/NotesExportMenu.tsx` | Existing-design menu, busy feedback, overwrite dialog |
| `apps/desktop/src/notesExport.css` | Only v1-equivalent Export classes not already present |
| `apps/desktop/src/NotesExportMenu.test.tsx` | Target, flush, cancel, conflict, retry, lazy behavior |

---

### Task 1: Export Contracts And Read-Only Application Use Case

**Files:**
- Create: `crates/notes-application/src/export.rs`
- Create: `crates/notes-application/src/service/export.rs`
- Create: `crates/notes-application/tests/export_service.rs`
- Modify: `crates/notes-application/src/lib.rs`
- Modify: `crates/notes-application/src/service.rs`
- Modify: `crates/notes-application/src/error.rs`
- Modify: `crates/notes-application/src/contracts.rs`
- Generate: `packages/contracts/generated/ExportFormat.ts`
- Generate: `packages/contracts/generated/NotesExportRequest.ts`
- Generate: `packages/contracts/generated/NotesExportResult.ts`
- Modify: `packages/contracts/generated/NotesErrorCode.ts`

**Interfaces:**
- Produces: `ExportSnapshotPort::load_export_snapshot(expected_revision, root_id)`
- Produces: `ExportRendererPort::render(&ExportSnapshot, ExportFormat)`
- Produces: `ExportPublicationPort::publish(path, &RenderedExport, overwrite)`
- Produces: `NotesService::export(request, assets, renderer, publisher)`

- [ ] **Step 1: Write the failing service test**

Create a literal three-node snapshot fixture and fake ports. The first test
asserts that a successful export validates session/revision, reads two image
nodes with one shared hash once, invokes one renderer and one publisher, and
leaves `HistoryState` and storage revision unchanged:

```rust
#[test]
fn export_hydrates_unique_images_once_without_mutating_history() {
    let fixture = ExportFixture::with_duplicate_images();
    let before = fixture.service.history_state();
    let result = fixture.service.export(
        request("markdown", "C:/Exports/Page.md"),
        &fixture.assets,
        &fixture.renderer,
        &fixture.publisher,
    ).unwrap();

    assert_eq!(result.revision, 7);
    assert_eq!(fixture.assets.read_count(), 1);
    assert_eq!(fixture.renderer.snapshots(), 1);
    assert_eq!(fixture.publisher.calls(), 1);
    assert_eq!(fixture.service.history_state(), before);
    assert_eq!(fixture.storage.revision(), 7);
}
```

Add separate tests for session mismatch, stale revision, missing image bytes,
renderer failure, publisher failure, and `destination_exists` code mapping.

- [ ] **Step 2: Run RED**

Run:

```powershell
cargo test -p notes-application --test export_service
```

Expected: compilation fails because export types, ports, and service method do
not exist.

- [ ] **Step 3: Add exact generated contracts and errors**

Add `ExportFormat::{Markdown, Pdf}`, camelCase `NotesExportRequest` with
`session_id`, `base_revision`, `root_node_id`, `format`,
`destination_path`, and `overwrite`, plus `NotesExportResult` with revision,
root, format, and destination. Add error codes:

```rust
DestinationExists
InvalidDestination
ExportTooLarge
ExportFailed
```

UI decisions use codes, never messages. `destination_exists` is not retryable;
storage/revision errors retain their current retry flags.

- [ ] **Step 4: Add the immutable model and focused ports**

Define ordered `ExportNode` values containing ID, kind, marker, text, note,
completed state, optional `ExportImage`, and children. `ExportImage` owns
validated `NoteImage` metadata and an optional shared `Arc<[u8]>` populated
only by the service. Define `RenderedExport::{Markdown { document, assets },
Pdf { document }}` and the four focused ports from the design.

- [ ] **Step 5: Implement the read-only service method**

Under the session mutex, validate `session_id` and `base_revision`, then drop
the mutex. Load one snapshot through `ExportSnapshotPort`, collect images by
content hash, call `ImageAssetPort::read` once per unique hash, assign shared
payloads, render, and publish. Do not call `commit`, `record_history`, or
`record_completed`.

- [ ] **Step 6: Generate contracts and run GREEN**

Run:

```powershell
$env:TS_RS_EXPORT_DIR=(Resolve-Path 'packages/contracts/generated')
cargo test -p notes-application export_bindings
Remove-Item Env:TS_RS_EXPORT_DIR
cargo test -p notes-application --test export_service
npm run test:v2:contracts
```

Expected: all export service and generated-contract checks pass.

- [ ] **Step 7: Commit the application checkpoint**

```powershell
git add crates/notes-application packages/contracts/generated
git commit -m "feat(v2): define export application boundary"
```

---

### Task 2: Revision-Consistent SQLite Export Snapshot

**Files:**
- Create: `crates/notes-sqlite/src/export_snapshot.rs`
- Create: `crates/notes-sqlite/tests/export_snapshot.rs`
- Modify: `crates/notes-sqlite/src/lib.rs`
- Modify: `crates/notes-sqlite/src/worker.rs`

**Interfaces:**
- Consumes: Task 1 `ExportSnapshotPort`, `ExportSnapshot`, `ExportNode`
- Produces: one DB-worker request returning a detached, byte-free snapshot

- [ ] **Step 1: Write failing ordering and coherence tests**

Insert a page, nested bullets, completed Todo, collapsed parent, image node,
deleted child, and siblings with equal sort keys into an in-memory
`SqliteStorage`. Assert the snapshot:

```rust
assert_eq!(snapshot.revision, 7);
assert_eq!(snapshot.root.children.iter().map(|node| node.id.as_str())
    .collect::<Vec<_>>(), ["alpha", "beta", "collapsed"]);
assert_eq!(snapshot.root.children[2].children[0].id.as_str(), "hidden-child");
assert!(snapshot.find("deleted-child").is_none());
assert!(snapshot.find("image").unwrap().image.as_ref().unwrap().bytes.is_none());
```

Add a queued-writer coherence test and exact limit tests for 20,001 nodes,
depth 129, and 513 images.

- [ ] **Step 2: Run RED**

Run:

```powershell
cargo test -p notes-sqlite --test export_snapshot
```

Expected: compilation fails because `SqliteStorage` does not implement
`ExportSnapshotPort`.

- [ ] **Step 3: Implement one worker request and read transaction**

Add `Request::ExportSnapshot`. Inside one transaction:

1. compare `notes_meta.revision` with `expected_revision`;
2. recursively load the active root and descendants;
3. enforce count/depth limits while rejecting cycles and missing parents;
4. load image metadata through the existing node record mapping;
5. order children by `sort_key`, then ID;
6. capture one UTC `exported_at` value from SQLite; and
7. commit the read transaction and return the detached tree.

Do not read image files, call `query_forest` repeatedly, or hold the
transaction during rendering.

- [ ] **Step 4: Run GREEN and query regressions**

Run:

```powershell
cargo test -p notes-sqlite --test export_snapshot
cargo test -p notes-sqlite --test image_persistence
cargo test -p notes-sqlite --test viewport_queries
```

Expected: snapshot, image, and viewport suites pass.

- [ ] **Step 5: Commit the storage checkpoint**

```powershell
git add crates/notes-sqlite
git commit -m "feat(v2): load immutable export snapshots"
```

---

### Task 3: Deterministic Markdown And Atomic Publication

**Files:**
- Create: `crates/notes-export/Cargo.toml`
- Create: `crates/notes-export/src/lib.rs`
- Create: `crates/notes-export/src/markdown.rs`
- Create: `crates/notes-export/src/publication.rs`
- Create: `crates/notes-export/tests/markdown.rs`
- Create: `crates/notes-export/tests/publication.rs`
- Modify: `Cargo.toml`

**Interfaces:**
- Consumes: Task 1 renderer/publication ports and hydrated snapshot
- Produces: `NativeExportRenderer` and `NativeExportPublisher`

- [ ] **Step 1: Write failing Markdown byte goldens**

Create a Korean page fixture with empty text, Todo completion, escaped
Markdown, multiline note, nesting, and two images sharing bytes. Assert the
complete UTF-8 output including:

```text
---
kind: yonalist-notes-export
format_version: 1
source: notes.sqlite
root_node_id: "page"
exported_at: "2026-07-29T00:00:00.000Z"
---

# 프로젝트

- [x] 한국어 \[완료\] <!-- yonalist-node-id: done -->
  > 첫 줄
  >
  > 둘째 줄
```

Assert `0001.png` is emitted once and both image links use
`Page_assets/0001.png`.

- [ ] **Step 2: Run Markdown RED**

Run:

```powershell
cargo test -p notes-export --test markdown
```

Expected: Cargo cannot find the `notes-export` package.

- [ ] **Step 3: Implement deterministic rendering**

Render frontmatter from snapshot fields without reading a clock. Use
two-space nesting, `- [ ]`/`- [x]`, escaped inline text, nested block quotes,
stable node-ID comments, percent-encoded image metadata, traversal ordinals,
and hash deduplication. Normalize all line endings to LF. Reject any image
without validated bytes.

- [ ] **Step 4: Write failing publication tests**

Use temporary directories to assert:

- a new PDF file is staged then renamed;
- no-overwrite returns `DestinationExists`;
- Markdown publishes document, `_assets`, and ownership marker together;
- an unmarked asset directory is never deleted even with overwrite;
- injected write/rename failures restore an old owned export; and
- symlink/reparse destinations and paths inside forbidden roots are rejected.

- [ ] **Step 5: Implement staged publication**

Create unpredictable sibling stage/backup names. Require absolute paths and
the expected extension; reject non-regular/link/reparse/forbidden targets.
Flush staged files before same-volume rename. Markdown assets contain
`.yonalist-notes-export.json` with `created_by =
"yonalist-notes-export"` and version 1. Replace only a valid owned asset
directory and roll back in-process failures.

- [ ] **Step 6: Run GREEN**

Run:

```powershell
cargo test -p notes-export --test markdown
cargo test -p notes-export --test publication
```

Expected: deterministic Markdown and publication security tests pass.

- [ ] **Step 7: Commit the Markdown checkpoint**

```powershell
git add Cargo.toml Cargo.lock crates/notes-export
git commit -m "feat(v2): render and publish Markdown exports"
```

---

### Task 4: Tauri IPC And Existing-Design Lazy Export Menu

**Files:**
- Create: `apps/desktop/src-tauri/src/export_ipc.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/build.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `apps/desktop/src-tauri/permissions/main-window.toml`
- Create: `apps/desktop/src/exportApi.ts`
- Create: `apps/desktop/src/exportPicker.ts`
- Create: `apps/desktop/src/NotesExportMenu.tsx`
- Create: `apps/desktop/src/NotesExportMenu.test.tsx`
- Create: `apps/desktop/src/notesExport.css`
- Modify: `apps/desktop/src/api.ts`
- Modify: `apps/desktop/src/notesStore.ts`
- Modify: `apps/desktop/src/NotesOutline.tsx`
- Modify: `apps/desktop/src/OutlineHeader.tsx`
- Modify: `apps/desktop/src/OutlineSelectionActionBar.tsx`
- Modify: `apps/desktop/src/previewApi.ts`
- Modify: `apps/desktop/src/test/appApiFixture.ts`

**Interfaces:**
- Consumes: Tasks 1-3 production services/adapters
- Produces: one `notes_export` IPC method and a lazy per-pane menu

- [ ] **Step 1: Write failing menu behavior tests**

Render the real `NotesOutline` with an API fixture. Assert the exact four
labels, one selected-node target only when exactly one row is selected,
current target equal to the pane Zoom root, and multi-selection disabling only
selected-node actions.

Add focused controller tests:

```ts
it("flushes before opening the save dialog and does no IPC after cancel", async () => {
  const events: string[] = [];
  store.flushAllDrafts = vi.fn(async () => { events.push("flush"); });
  pickExportPath.mockImplementation(async () => {
    events.push("dialog");
    return null;
  });

  await startExport(target, "markdown");

  expect(events).toEqual(["flush", "dialog"]);
  expect(api.exportNotes).not.toHaveBeenCalled();
});
```

Add destination-conflict confirmation, retry with fresh flush/revision, busy
duplicate suppression, success/error feedback, and preview download tests.

- [ ] **Step 2: Run frontend RED**

Run:

```powershell
npm run test --prefix apps/desktop -- src/NotesExportMenu.test.tsx
```

Expected: FAIL because `NotesExportMenu` and `NotesApi.exportNotes` do not
exist.

- [ ] **Step 3: Add thin Tauri IPC**

Store `NativeExportRenderer` and `NativeExportPublisher` in `DesktopRuntime`.
Resolve the Nanum font resource and forbidden data/image/original roots during
setup. `notes_export` executes `NotesService::export` through
`run_blocking`. Register the command in the handler, build manifest,
permission, Cargo dependency, and generated command permission.

- [ ] **Step 4: Add the lazy frontend boundary**

Extend `NotesApi` with `exportNotes(request)`. Add store methods exposing the
current session/revision and `flushAllDrafts`. `NotesExportMenu` is imported
through `lazy()` from `OutlineHeader`; it uses existing toolbar button/menu
classes and the v1 labels/confirmation copy. The save-dialog module imports
`@tauri-apps/plugin-dialog` only inside the action.

The menu receives `currentRootId`, title, and `selectedNodeId` from its own
pane. The ordinary toolbar shows the Export trigger where the v1 control
appeared. When exactly one row is selected and the existing selection
actionbar replaces that toolbar, the same compact Export trigger is rendered
at the actionbar's trailing edge; two or more selected rows omit it. No second
controller or menu state is created.

- [ ] **Step 5: Add preview behavior**

The preview API builds the same generated request and returns a logical result.
`exportPicker` uses a Blob download outside Tauri. Browser preview never
pretends to validate native overwrite races.

- [ ] **Step 6: Run GREEN and bundle boundary checks**

Run:

```powershell
npm run test --prefix apps/desktop -- src/NotesExportMenu.test.tsx src/App.test.tsx
cargo test -p yonalist-v2-desktop
npm run test:v2:contracts
npm run v2:build
```

Expected: menu/controller/IPC tests pass and Vite reports Export as a separate
chunk.

- [ ] **Step 7: Commit the UI/IPC checkpoint**

```powershell
git add apps/desktop packages/contracts/generated
git commit -m "feat(v2): connect lazy export workflow"
```

---

### Task 5: Korean PDF, Images, Wrapping, And Pagination

**Files:**
- Create: `crates/notes-export/src/pdf.rs`
- Create: `crates/notes-export/tests/pdf.rs`
- Modify: `crates/notes-export/src/lib.rs`
- Modify: `crates/notes-export/Cargo.toml`
- Copy as repository assets: `apps/desktop/src-tauri/resources/NanumGothic-Regular.ttf`
- Copy as repository assets: `apps/desktop/src-tauri/resources/NanumGothic-OFL.txt`
- Copy as repository assets: `apps/desktop/src-tauri/resources/FONT_SOURCE.md`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: hydrated `ExportSnapshot`, font resource path
- Produces: validated `RenderedExport::Pdf`

- [ ] **Step 1: Write failing Korean PDF tests**

Create fixtures for Korean title/note, 300-character wrapped row, enough rows
for three pages, nested PNG/JPEG/GIF/WebP images, duplicate bytes, very tall
and wide images, and one unsupported emoji. Assert:

```rust
let bytes = renderer.render(&snapshot, ExportFormat::Pdf).unwrap().document();
assert!(bytes.starts_with(b"%PDF-"));
let parsed = lopdf::Document::load_mem(bytes).unwrap();
assert_eq!(parsed.get_pages().len(), 3);
assert_eq!(embedded_unicode_font_count(&parsed), 1);
assert_eq!(image_xobject_count(&parsed), unique_image_payloads);
```

Assert unsupported glyphs and the 256 MiB working budget return
`ExportFailed` and `ExportTooLarge`, respectively.

- [ ] **Step 2: Run PDF RED**

Run:

```powershell
cargo test -p notes-export --test pdf
```

Expected: compilation fails because the PDF renderer module is absent.

- [ ] **Step 3: Implement pinned A4 layout**

Use the v1 verified geometry: A4 210×297 mm, 18 mm horizontal margin, 20 mm
top, 18 mm bottom, 10 mm footer reserve, 20 pt title, 10.8 pt rows, 9 pt
notes, 14 pt depth indent, and stable footer/page numbering. Parse Nanum
Gothic on invocation, validate every glyph, wrap by measured advances, and
keep a row together when it fits.

Decode supported images deterministically, use the first animation frame,
preserve aspect ratio and stored display width, fit page bounds, and reuse one
XObject per content hash. Validate conservative encoded/decoded/retained
working memory before decode.

- [ ] **Step 4: Validate serialized output before publication**

Reparse the output with `lopdf`; require a catalog, page tree, expected page
count, embedded font, bounded streams, and no trailing parser error. Rendering
failure returns no `RenderedExport`.

- [ ] **Step 5: Run GREEN**

Run:

```powershell
cargo test -p notes-export --test pdf
cargo test -p notes-export
cargo test -p yonalist-v2-desktop
```

Expected: all Markdown, publication, Korean PDF, and desktop integration tests
pass.

- [ ] **Step 6: Commit the PDF checkpoint**

```powershell
git add crates/notes-export apps/desktop/src-tauri/resources apps/desktop/src-tauri/tauri.conf.json Cargo.lock
git commit -m "feat(v2): render Korean PDF exports"
```

---

### Task 6: Security, Performance, And Fresh Runtime Completion

**Files:**
- Modify: `docs/v2/feature-parity-matrix.md`
- Modify: `docs/v2/performance.md`
- Modify: `docs/v2/verification.md`
- Modify owning tests only when a gate exposes a real missing assertion

**Interfaces:**
- Consumes: frozen Tasks 1-5 diff
- Produces: complete automated and fresh desktop evidence

- [ ] **Step 1: Run focused adversarial tests**

Run:

```powershell
cargo test -p notes-application --test export_service
cargo test -p notes-sqlite --test export_snapshot
cargo test -p notes-export
npm run test --prefix apps/desktop -- src/NotesExportMenu.test.tsx
```

Expected: all export-owned suites pass with no warnings.

- [ ] **Step 2: Run Rust formatting and Clippy**

Run:

```powershell
cargo fmt --all
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

Expected: formatting and Clippy pass with zero warnings.

- [ ] **Step 3: Freeze the diff and run complete gates once**

Run:

```powershell
cargo test --workspace
npm run test:v2:frontend
npm run lint:v2
npm run test:v2:architecture
npm run test:v2:contracts
npm run test:v2:bundle
npm run test:v2:performance
git diff --check
```

Expected: Rust/frontend/contracts/architecture pass; initial editable bundle
remains at or below 300 KiB raw and 90 KiB gzip; SQLite performance thresholds
remain green.

- [ ] **Step 4: Prove a fresh isolated desktop process**

Build and launch with a disposable directory:

```powershell
$env:YONALIST_V2_DATA_DIR = Join-Path $env:TEMP ("yonalist-v2-export-" + [guid]::NewGuid())
npm run v2:tauri:build
```

Launch the new binary, create Korean text and an image, then verify current
page and selected subtree Markdown/PDF exports, cancellation, conflict,
confirmed overwrite, split-pane targeting, restart, and unchanged Undo/Redo.
Inspect Markdown/assets and parse both PDFs. Remove only the disposable data
directory after the process exits and its resolved absolute path is confirmed
under `$env:TEMP`.

- [ ] **Step 5: Record exact evidence**

Mark only the Markdown/PDF rows complete in the parity matrix. Record test
counts, bundle bytes, performance sample, fresh process path, outputs
inspected, and any platform limitation. Do not claim macOS proof from a
Windows run.

- [ ] **Step 6: Commit verification**

```powershell
git add docs/v2
git commit -m "docs(v2): verify export delivery"
```

## Completion Checklist

- [ ] Current pane page/Zoom root and exactly one selected node export correctly.
- [ ] Draft flush precedes dialog and snapshot; cancellation is a no-op.
- [ ] Markdown is deterministic and image assets are deduplicated.
- [ ] PDF is parseable, Korean-capable, paginated, and image-aware.
- [ ] Existing destinations require structured confirmation.
- [ ] Foreign asset directories and link/reparse destinations are never deleted.
- [ ] Export changes no revision, history, focus, selection, or pane navigation.
- [ ] Export code is absent from the initial editable JavaScript graph.
- [ ] Clippy, formatting, Rust/frontend/contracts/architecture/bundle/performance gates pass.
- [ ] Fresh Windows desktop evidence is recorded without claiming unavailable macOS proof.
