# Yonalist v2 Image Nodes And Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class local image nodes with lazy display, resize, replace, deletion, persistence, and session Undo/Redo while preserving the current Yonalist design and text-editor performance.

**Architecture:** `NoteNode` owns optional bounded `NoteImage` metadata so the existing reversible node patch, SQLite Unit of Work, receipts, and frontend confirmed model remain the single state path. A new application `ImageAssetPort` owns validation and content-addressed bytes outside SQLite; Tauri exposes bounded raw/path adapters while the browser preview implements the same frontend API with in-memory Blobs.

**Tech Stack:** Rust 1.97, `notes-core`, `notes-application`, `notes-sqlite`, SQLite/FTS5, Tauri 2.11, `image` 0.25 with PNG/JPEG/GIF/WebP features, `sha2` 0.10, React 19, TypeScript 6, Vitest 4, `ts-rs` 12.

## Global Constraints

- Keep the current DOM geometry, CSS tokens, typography, image classes, menu placement, and macOS visual reference unchanged.
- The current pre-release SQLite schema stays at version 1 and is edited in place; add no migration or compatibility reader.
- New images are independent outline nodes. Do not add text-node attachment compatibility.
- Support PNG, JPEG, GIF, and WebP only: 20 MiB per image, 64 MiB per batch, 128 images per batch, and 40 million decoded pixels per image.
- Image editing in this plan means resize, replace, and Move to Trash. Crop, rotate, filters, annotation, OCR, export, Markdown sync, remote URLs, Vault sync, and GitHub Notifications remain excluded.
- Image bytes, absolute paths, and Blob/base64 payloads must never enter `DomainPatch`, session history, idempotency receipts, `BootSnapshot`, viewport results, forest results, or search results.
- Startup must not enumerate, read, hash, or decode image assets. Reconciliation runs only on idle/close.
- At most eight image object URLs may be resident across both split panes and all lightboxes.
- Text-only rows must not subscribe to image residency or load image feature modules.
- Resize paints locally during the gesture and creates one command/history entry when the gesture ends.
- Files remain below the repository advisory limits: 500 production lines and 800 test lines where practical; no reverse crate dependency or import cycle is allowed.

## File Structure

| Path | Responsibility |
| --- | --- |
| `crates/notes-core/src/image.rs` | Validated, byte-free `NoteImage` metadata |
| `crates/notes-core/src/node.rs` | Page/bullet/image discriminant and node ownership |
| `crates/notes-core/src/command.rs` | Import/resize/replace domain commands |
| `crates/notes-core/src/tree/command_execution.rs` | Reversible image-node command rules |
| `crates/notes-application/src/image.rs` | Image request types and `ImageAssetPort` |
| `crates/notes-application/src/service.rs` | Shared revision/idempotency/history execution |
| `crates/notes-application/src/contracts.rs` | `ImageView` and generated wire contracts |
| `crates/notes-sqlite/src/image_assets.rs` | Validation, hashing, atomic publication, verified reads |
| `crates/notes-sqlite/src/schema.rs` | Fresh `notes_images` table and image node constraint |
| `crates/notes-sqlite/src/row_mapping.rs` | Joined node/image row mapping |
| `crates/notes-sqlite/src/mutations.rs` | Atomic node plus image metadata persistence |
| `crates/notes-sqlite/src/worker.rs` | DB worker image-aware node queries and close GC |
| `apps/desktop/src-tauri/src/image_ipc.rs` | Raw envelope decoding and native path/image actions |
| `apps/desktop/src/imageApi.ts` | Browser/Tauri image input boundary and raw encoding |
| `apps/desktop/src/storeImages.ts` | Store-level stable IDs, receipts, and image commands |
| `apps/desktop/src/imageResidency.ts` | Eight-entry object-URL residency and subscriptions |
| `apps/desktop/src/ImageNodeContent.tsx` | Lazy image frame, recovery, resize, and image menu |
| `apps/desktop/src/ImageLightbox.tsx` | Existing-design full-screen presentation |
| `apps/desktop/src/useImageIngest.ts` | Picker, clipboard, and native file-drop routing |
| `apps/desktop/src/OutlineRow.tsx` | Primary-content branch only |
| `apps/desktop/src/OutlineHeader.tsx` | Zoomed image primary-content branch only |

---

### Task 1: Reversible Image Node Domain

**Files:**
- Create: `crates/notes-core/src/image.rs`
- Create: `crates/notes-core/tests/image_commands.rs`
- Modify: `crates/notes-core/src/lib.rs`
- Modify: `crates/notes-core/src/node.rs`
- Modify: `crates/notes-core/src/command.rs`
- Modify: `crates/notes-core/src/tree.rs`
- Modify: `crates/notes-core/src/tree/command_execution.rs`
- Modify: `crates/notes-core/tests/tree_commands.rs`

**Interfaces:**
- Produces: `NoteImage::try_new(...) -> Result<NoteImage, DomainError>`
- Produces: `NoteNodeKind::{Page, Bullet, Image}` and `NoteNode::image() -> Option<&NoteImage>`
- Produces: `NotesCommand::{ImportImages, ResizeImage, ReplaceImage}`
- Preserves: `DomainPatch { forward, inverse }` as the only history payload

- [ ] **Step 1: Write failing metadata and import tests**

Add literal fixtures to `crates/notes-core/tests/image_commands.rs`:

```rust
#[test]
fn image_batch_is_ordered_and_reversible() {
    let mut tree = page_tree();
    let patch = tree.plan(NotesCommand::ImportImages {
        parent_id: id("page"),
        position: Position::at_end(),
        nodes: vec![
            ImportImageNode { id: id("cat"), image: png("cat.png", 320) },
            ImportImageNode { id: id("dog"), image: png("dog.png", 480) },
        ],
    }).unwrap();
    tree.apply(&patch.forward).unwrap();
    assert_eq!(tree.children_of(&id("page")), vec![id("cat"), id("dog")]);
    assert_eq!(tree.node(&id("cat")).unwrap().kind(), NoteNodeKind::Image);
    assert_eq!(tree.node(&id("cat")).unwrap().text(), "cat.png");
    tree.apply(&patch.inverse).unwrap();
    assert!(tree.node(&id("cat")).is_none());
    assert!(tree.node(&id("dog")).is_none());
}
```

Add tests proving invalid hash/path/MIME/dimensions/width are rejected, generic
`UpdateText`, split, merge, and empty-node removal reject image nodes, and an
empty image batch changes nothing.

- [ ] **Step 2: Run RED**

Run:

```powershell
cargo test -p notes-core --test image_commands
```

Expected: compilation fails because `NoteImage`, `ImportImageNode`,
`ImportImages`, `ResizeImage`, and `ReplaceImage` do not exist.

- [ ] **Step 3: Implement bounded byte-free metadata**

Create `image.rs` with the exact public shape:

```rust
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct NoteImage {
    content_hash: String,
    relative_path: String,
    original_name: String,
    mime_type: String,
    byte_length: u64,
    pixel_width: u32,
    pixel_height: u32,
    display_width: u32,
}
```

`try_new` accepts only a 64-character lowercase hexadecimal hash, a single
relative filename with no separator, one approved MIME, byte length
`1..=20_971_520`, positive dimensions whose checked product is at most
`40_000_000`, and display width at least 120. Add getters and one crate-private
`set_display_width`.

- [ ] **Step 4: Add the image discriminant without a parallel hierarchy**

Add `Image` to `NoteNodeKind`, add `image: Option<NoteImage>` to `NoteNode`,
and update constructors so pages/bullets use `None` and
`NoteNode::image_child` requires `Some(image)`. `from_persisted` accepts
`Option<NoteImage>` so a damaged database row can still render recovery UI.

Tree validation accepts `(Image, Some(parent))`; page/bullet nodes carrying
image metadata are invalid. A missing metadata row on an image node remains a
readable damaged state, but image creation and replacement never produce it.

- [ ] **Step 5: Implement image commands and exact inverse patches**

Define:

```rust
pub struct ImportImageNode {
    pub id: NodeId,
    pub image: NoteImage,
}

NotesCommand::ImportImages {
    parent_id: NodeId,
    position: Position,
    nodes: Vec<ImportImageNode>,
}
NotesCommand::ResizeImage { id: NodeId, display_width: u32 }
NotesCommand::ReplaceImage { id: NodeId, image: NoteImage }
```

Import each node contiguously at the supplied position. Replace copies the
old display width into the new metadata and updates the hidden filename.
Resize validates through `NoteImage`. Reject commands on the wrong kind.

Update subtree duplication to preserve each source node's kind and image
metadata. Keep generated descendant IDs and existing sort-key behavior.

- [ ] **Step 6: Expand edge and property coverage**

Add tests for resize/replace forward and inverse values, duplicate metadata
without identity sharing, image child movement, soft delete/restore, damaged
image deletion, and a property sequence asserting pages never own images and
bullet nodes never become images through generic commands.

- [ ] **Step 7: Run GREEN and core regression**

Run:

```powershell
cargo test -p notes-core --test image_commands
cargo test -p notes-core
```

Expected: all image tests and existing tree tests pass.

- [ ] **Step 8: Commit the domain checkpoint**

```powershell
git add crates/notes-core
git commit -m "feat(v2): add reversible image nodes"
```

---

### Task 2: SQLite Image Metadata And Generated Views

**Files:**
- Create: `crates/notes-sqlite/tests/image_persistence.rs`
- Modify: `crates/notes-application/src/contracts.rs`
- Modify: `crates/notes-sqlite/src/schema.rs`
- Modify: `crates/notes-sqlite/src/row_mapping.rs`
- Modify: `crates/notes-sqlite/src/repository.rs`
- Modify: `crates/notes-sqlite/src/queries.rs`
- Modify: `crates/notes-sqlite/src/forest_queries.rs`
- Modify: `crates/notes-sqlite/src/mutations.rs`
- Modify: `crates/notes-sqlite/src/fixtures.rs`
- Modify: `packages/contracts/generated/IpcNodeKind.ts`
- Create: `packages/contracts/generated/ImageView.ts`
- Modify: `packages/contracts/generated/NoteView.ts`
- Modify: TypeScript fixtures that construct `NoteView`

**Interfaces:**
- Consumes: `NoteNode::image()`
- Produces: `ImageView` and `NoteView.image: ImageView | null`
- Preserves: `MutationReceipt` shape; image-only changes return their owner in `changedNodes`

- [ ] **Step 1: Write failing fresh-schema and restart tests**

In `image_persistence.rs`, open a temporary file database, commit a page plus
an image node patch, close, reopen, and assert every literal metadata field.
Add a rollback test with an invalid second image row and assert revision and
both tables stay unchanged.

Add a schema test that explicitly queries:

```sql
SELECT kind, original_name, display_width
FROM notes_nodes
JOIN notes_images ON notes_images.node_id = notes_nodes.id
WHERE notes_nodes.id = 'image'
```

Expected row: `("image", "cat.png", 320)`.

- [ ] **Step 2: Run RED**

Run:

```powershell
cargo test -p notes-sqlite --test image_persistence
```

Expected: FAIL because `kind = image` and `notes_images` are not in schema v1.

- [ ] **Step 3: Edit the fresh schema in place**

Extend the `notes_nodes.kind` check to `('page', 'bullet', 'image')` and its
parent check so image nodes require a parent. Add the exact `notes_images`
table from the approved design with `node_id` primary key and cascading
foreign key. Keep `PRAGMA user_version = 1`; add no `ALTER TABLE` or migration.

- [ ] **Step 4: Map joined rows through one function**

Append nullable image columns after the existing eleven node columns in every
node-returning query. Update `parse_node` to construct `NoteImage` when
`content_hash` is non-null and to return a clear conversion error when a
partial or invalid metadata tuple is read.

Keep the page summary query metadata-free. Viewport, forest, search, node
lookup, command context, descendants, and sibling queries all return the same
joined `NoteNode` shape.

- [ ] **Step 5: Persist node and image state in one transaction**

After each `TreeMutation::Upsert`, upsert `notes_images` when
`node.image().is_some()` and delete an existing metadata row otherwise.
`TreeMutation::Delete` continues deleting `notes_nodes`; the foreign key
cascades the image row. Build `StorageCommit.changed_nodes` from the forward
patch exactly as today.

- [ ] **Step 6: Generate and verify the TypeScript contract**

Add:

```rust
pub struct ImageView {
    pub content_hash: String,
    pub original_name: String,
    pub mime_type: String,
    pub byte_length: u64,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub display_width: u32,
}
```

Do not expose `relative_path`. Add `image: Option<ImageView>` to `NoteView` and
map `NoteNodeKind::Image`. Run the binding export test into the repository
generated directory using the established `TS_RS_EXPORT_DIR` mechanism, then
update every literal frontend `NoteView` with `image: null`.

- [ ] **Step 7: Run GREEN and contract/query regressions**

Run:

```powershell
cargo test -p notes-sqlite --test image_persistence
cargo test -p notes-sqlite
cargo test -p notes-application export_bindings
npm run test:v2:contracts
npm run test:v2:frontend
```

Expected: all existing frontend tests compile and pass with explicit
`image: null`.

- [ ] **Step 8: Commit the persistence checkpoint**

```powershell
git add crates/notes-application/src/contracts.rs crates/notes-sqlite packages/contracts/generated apps/desktop/src
git commit -m "feat(v2): persist image metadata"
```

---

### Task 3: Asset Port And One Raw Clipboard Vertical Slice

**Files:**
- Create: `crates/notes-application/src/image.rs`
- Create: `crates/notes-application/tests/image_service.rs`
- Modify: `crates/notes-application/src/lib.rs`
- Modify: `crates/notes-application/src/contracts.rs`
- Modify: `crates/notes-application/src/service.rs`
- Modify: `crates/notes-application/src/storage.rs`
- Create: `crates/notes-sqlite/src/image_assets.rs`
- Create: `crates/notes-sqlite/tests/image_assets.rs`
- Modify: `crates/notes-sqlite/src/lib.rs`
- Modify: `crates/notes-sqlite/Cargo.toml`
- Create: `apps/desktop/src-tauri/src/image_ipc.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/build.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/permissions/main-window.toml`
- Generate: `apps/desktop/src-tauri/permissions/autogenerated/notes_import_image_bytes.toml`
- Generate: `apps/desktop/src-tauri/permissions/autogenerated/notes_read_image.toml`
- Create: `packages/contracts/generated/ImageImportContext.ts`
- Create: `packages/contracts/generated/ImageImportItem.ts`
- Create: `packages/contracts/generated/ImageReadRequest.ts`

**Interfaces:**
- Produces: `ImageAssetPort::prepare`, `read`, `rollback`, `reconcile`
- Produces: `NotesService::import_images` sharing the current session/history/idempotency state
- Produces: raw `notes_import_image_bytes` and raw-response `notes_read_image`

- [ ] **Step 1: Write failing asset validation tests**

Use literal 1x1 PNG/JPEG/GIF/WebP byte fixtures. Assert the returned metadata
uses decoded MIME/dimensions, SHA-256 lowercase hash, and a hash-derived
relative path. Add rejection tests for extension/MIME spoofing, empty or
truncated data, SVG, over 20 MiB, batch over 64 MiB, over 128 items, zero or
over 40 million pixels, and a path source that is a directory or changes while
read.

Add a dedup test: publishing the same bytes twice yields one asset file and two
prepared results with the same hash.

- [ ] **Step 2: Run asset RED**

Run:

```powershell
cargo test -p notes-sqlite --test image_assets
```

Expected: compilation fails because `LocalImageAssets` does not exist.

- [ ] **Step 3: Define the application image port**

Add owned source/request types:

```rust
pub enum ImageSource {
    Bytes(Vec<u8>),
    Path(PathBuf),
}

pub struct ImageImportSource {
    pub node_id: NodeId,
    pub original_name: String,
    pub declared_mime_type: Option<String>,
    pub source: ImageSource,
}

pub struct PublishedImage {
    pub image: NoteImage,
    pub newly_created: bool,
}

pub trait ImageAssetPort: Send + Sync {
    fn prepare(&self, sources: &[ImageImportSource])
        -> Result<Vec<PublishedImage>, StorageError>;
    fn read(&self, image: &NoteImage) -> Result<Vec<u8>, StorageError>;
    fn rollback(&self, images: &[PublishedImage]);
    fn reconcile(&self, live_hashes: &BTreeSet<String>) -> Result<(), StorageError>;
}
```

Add `StoragePort::load_node` and `StoragePort::live_image_hashes` so reads and
close reconciliation use database authority.

Add generated wire metadata with exact camelCase fields:

```rust
pub struct ImageImportItem {
    pub node_id: String,
    pub original_name: String,
    pub declared_mime_type: Option<String>,
    pub byte_length: u64,
}

pub struct ImageImportContext {
    pub session_id: String,
    pub request_id: String,
    pub base_revision: u64,
    pub history_group: Option<String>,
    pub parent_id: String,
    pub before_id: Option<String>,
    pub items: Vec<ImageImportItem>,
}

pub struct ImageReadRequest {
    pub session_id: String,
    pub node_id: String,
}
```

- [ ] **Step 4: Implement validation and atomic publication**

Add `image = { version = "0.25", default-features = false, features =
["png", "jpeg", "gif", "webp"] }` and `sha2 = "0.10"` to
`notes-sqlite`. Validate signature/decoder results, checked dimensions, and
budgets before publishing any item. Publish to a temporary sibling, flush,
and atomically rename to `<sha256>.<decoded extension>`.

On Windows use the existing repository file-I/O safety patterns as the
behavioral reference: reject reparse points and non-regular handles. Do not
import the legacy crate or expose the canonical path.

- [ ] **Step 5: Write failing service tests for atomic history**

Use real `NotesTree` plus fake storage/assets. Import two images and assert one
commit, one Undo entry, source order, idempotent repeated request ID, and exact
restart-safe metadata. Inject prepare and commit failures and assert rollback
receives only newly published assets and no receipt/history entry is recorded.

- [ ] **Step 6: Refactor service execution through one private path**

Extract the current checked execution body into a private method that accepts a
validated `NotesCommand`. `execute` continues converting `IpcNotesCommand`;
`import_images` prepares sources, builds `ImportImages`, and uses the same
session lock, request cache, revision check, history bounds, commit, receipt,
and completed-request recording. Do not create a second history stack.

Add `read_image(session_id, node_id, assets)` which loads the database-owned
node, requires `kind == Image` and metadata, and passes only that metadata to
the asset port.

- [ ] **Step 7: Write failing raw IPC envelope tests**

Use this exact envelope:

```text
magic "YV2I" (4 bytes)
version 1 little-endian u16
reserved zero u16
metadata JSON byte length u32
item count u32
UTF-8 metadata JSON
concatenated item payloads; each metadata item carries byteLength
```

Test wrong magic/version/reserved bits, malformed JSON, count mismatch,
overflowing lengths, trailing bytes, and aggregate over 64 MiB. Assert decoded
payload slices are copied once into owned sources before `spawn_blocking`.

- [ ] **Step 8: Register the two Tauri commands**

`notes_import_image_bytes` accepts only `InvokeBody::Raw` and returns the
ordinary `MutationReceipt`. `notes_read_image` accepts a generated JSON
request and returns `tauri::ipc::Response::new(bytes)`. Add exact build
manifest, permission, handler, and wire-shape tests.

- [ ] **Step 9: Run GREEN across the first backend vertical slice**

Run:

```powershell
cargo test -p notes-sqlite --test image_assets
cargo test -p notes-application --test image_service
cargo test -p yonalist-v2-desktop
cargo test -p notes-sqlite --test image_persistence
```

Expected: all validation, atomicity, raw-envelope, receipt, Undo/Redo, and
restart tests pass.

- [ ] **Step 10: Commit the backend vertical slice**

```powershell
git add Cargo.toml Cargo.lock crates/notes-application crates/notes-sqlite apps/desktop/src-tauri
git commit -m "feat(v2): add local image storage"
```

---

### Task 4: Frontend Clipboard Import And Lazy Image Rendering

**Files:**
- Create: `apps/desktop/src/imageApi.ts`
- Create: `apps/desktop/src/imageApi.test.ts`
- Create: `apps/desktop/src/storeImages.ts`
- Create: `apps/desktop/src/storeImages.test.ts`
- Create: `apps/desktop/src/imageResidency.ts`
- Create: `apps/desktop/src/imageResidency.test.ts`
- Create: `apps/desktop/src/ImageNodeContent.tsx`
- Create: `apps/desktop/src/ImageNodeContent.test.tsx`
- Create: `apps/desktop/src/imageClipboard.ts`
- Create: `apps/desktop/src/imageClipboard.test.ts`
- Modify: `apps/desktop/src/api.ts`
- Modify: `apps/desktop/src/notesStore.ts`
- Modify: `apps/desktop/src/previewApi.ts`
- Modify: `apps/desktop/src/OutlineRow.tsx`
- Modify: `apps/desktop/src/OutlineHeader.tsx`
- Modify: `apps/desktop/src/outlineKeyboard.ts`
- Modify: `apps/desktop/src/outlineKeyboard.test.ts`
- Modify: `apps/desktop/src/test/appApiFixture.ts`
- Modify: `apps/desktop/src/test/notesStoreFixture.ts`

**Interfaces:**
- Produces: high-level `NotesApi.importImageBytes`, `readImage`, and `replaceImageBytes`
- Produces: `StoreImages.importAfter`, `read`, `resize`, and `replace`
- Produces: one workspace `ImageResidency` with eight leases
- Produces: lazy `ImageNodeContent`

- [ ] **Step 1: Write failing raw encoder tests**

Encode two literal Blobs and assert every header offset, the exact hand-written
metadata JSON values after decoding, payload byte order, and no base64
conversion. Assert preflight rejects empty batches and every configured limit
before calling `blob.arrayBuffer()`.

- [ ] **Step 2: Run encoder RED**

Run:

```powershell
npm run test:v2:frontend -- imageApi.test.ts
```

Expected: FAIL because `encodeImageEnvelope` does not exist.

- [ ] **Step 3: Implement the high-level frontend API**

Keep raw encoding inside `imageApi.ts`; callers pass:

```ts
export interface ImageInput {
  readonly nodeId: string;
  readonly originalName: string;
  readonly declaredMimeType: string | null;
  readonly blob: Blob;
}
```

`tauriNotesApi.importImageBytes` invokes the raw endpoint with the `Uint8Array`
as the body. Convert raw read responses to `Uint8Array`. The `NotesApi`
interface exposes high-level values so preview and Tauri implementations share
all store/component tests.

- [ ] **Step 4: Write failing store and preview tests**

Import two images after `bullet-1`; assert stable generated IDs, one API call,
receipt application, source order, one history event, and first imported ID.
Retry the same operation after a simulated lost response and assert IDs and
request ID are reused.

In preview, store cloned Blob bytes outside `NoteView`, return image metadata
only, and make Undo/Redo restore nodes and metadata without putting bytes in
the preview history object.

- [ ] **Step 5: Implement `StoreImages` without growing `NotesStore`**

Construct `StoreImages` beside `StoreDrafts` and delegate public image methods
from `NotesStore`. Use `StoreCommands`' request/session/revision ownership by
adding one `executeExternal` method that accepts the API operation and applies
its `MutationReceipt`; do not reproduce pending-write or error handling.

- [ ] **Step 6: Write failing residency tests**

Create nine image metadata entries, mark them visible in order, resolve reads,
and assert only the newest eight object URLs remain and the first is revoked.
Assert duplicate subscribers share one read/URL, menu hover causes no read,
replacement revokes the old URL, late abandoned reads are ignored, and
`dispose` revokes all URLs.

- [ ] **Step 7: Implement keyed residency**

`ImageResidency` owns a per-node state machine:

```ts
type ImageLease =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "error"; readonly message: string };
```

Use one `IntersectionObserver` per rendered frame only to request/release the
workspace lease. Text rows never import or subscribe to this module. Keep a
generation token so replacement/unmount invalidates late reads.

- [ ] **Step 8: Write failing row/header and keyboard tests**

Render an image node and assert filename text is absent, the accessible image
name is `cat.png`, width is 320, and `Image unavailable` appears on read
failure. Assert the existing text row DOM/geometry test is unchanged.

Focus image primary content and verify:

- `Enter` creates the next text sibling and focuses it;
- held Enter produces ordered siblings with caret on the newest;
- `Shift+Enter` focuses the description;
- Tab/Shift+Tab use existing structural commands;
- ArrowUp/ArrowDown cross text/image boundaries;
- selection shortcuts select the image node;
- Zoomed header renders the same image component.

- [ ] **Step 9: Implement the lazy primary-content branch**

Load `ImageNodeContent` with `React.lazy` only when `node.kind === "image"`.
Keep the row handle, bullet, menu slot, selection attributes, guide geometry,
note editor, children, and todo progress outside the branch. The text branch
retains the exact existing `OutlineTextField`.

Add `handleImageNodeKeyDown` to `outlineKeyboard.ts`; reuse existing focus and
selection helpers rather than simulating textarea selection.

- [ ] **Step 10: Route clipboard image files before text paste**

When a title or focused image receives a paste event containing image
`DataTransferItem`s, prevent the text paste, derive the sibling anchor once,
and call `StoreImages.importAfter`. If no image file exists, leave the current
multiline/text paste path untouched. Never fetch `<img src>` remote URLs.

- [ ] **Step 11: Run the visible vertical slice GREEN**

Run:

```powershell
npm run test:v2:frontend -- imageApi.test.ts storeImages.test.ts imageResidency.test.ts ImageNodeContent.test.tsx imageClipboard.test.ts outlineKeyboard.test.ts
npm run test:v2:frontend -- outlinePresentationIntegration.test.tsx splitPaneIntegration.test.tsx
```

Expected: paste, receipt, render, held Enter, arrows, note focus, and cleanup
tests pass without changing text-row behavior.

- [ ] **Step 12: Commit the first user-visible slice**

```powershell
git add apps/desktop/src packages/contracts/generated
git commit -m "feat(v2): render pasted image nodes"
```

---

### Task 5: Picker, Native File Drop, And Cross-Split Structural Parity

**Files:**
- Create: `apps/desktop/src/useImageIngest.ts`
- Create: `apps/desktop/src/useImageIngest.test.tsx`
- Create: `apps/desktop/src/imageInsertion.ts`
- Create: `apps/desktop/src/imageInsertion.test.ts`
- Modify: `apps/desktop/src/NotesOutline.tsx`
- Modify: `apps/desktop/src/OutlineRow.tsx`
- Modify: `apps/desktop/src/OutlineHeader.tsx`
- Modify: `apps/desktop/src/useOutlineDrag.ts`
- Modify: `apps/desktop/src/previewApi.ts`
- Modify: `apps/desktop/package.json`
- Modify: `package-lock.json`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/capabilities/default.json`

**Interfaces:**
- Produces: `imageInsertionAnchor(target, pageId, index)`
- Produces: `useImageIngest({ store, outlineRootId, paneId })`
- Consumes: existing row handles and cross-pane drag projection unchanged

- [ ] **Step 1: Write failing placement tests**

Assert a normal row maps to its parent and next sibling, a page/header maps to
the first child, a zoomed image maps beneath the image node, and a deleted or
stale target is rejected. Assert multi-image input receives one shared anchor
and source order.

- [ ] **Step 2: Write failing picker/drop tests**

Mock only the native dialog/window boundary. Assert picker cancellation is a
no-op, multiple paths make one `importImagePaths` call, a pointer file drop
uses browser `File` bytes, and a Tauri drag-drop event uses native paths.
Assert the drop marker clears on leave, success, failure, pane unmount, and
split close.

- [ ] **Step 3: Run RED**

Run:

```powershell
npm run test:v2:frontend -- imageInsertion.test.ts useImageIngest.test.tsx
```

Expected: FAIL because insertion and ingest adapters do not exist.

- [ ] **Step 4: Register native dialog support lazily**

Add direct app dependencies for `@tauri-apps/plugin-dialog` and the matching
Rust plugin. Initialize it in Tauri and add only the open/save permissions
used by image actions. Dynamically import the JS plugin on picker activation so
the initial editable bundle does not include it.

In browser preview, create a temporary hidden
`<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple>`
and convert selected files to byte inputs.

- [ ] **Step 5: Add path import through the existing asset service**

Add generated `ImagePathImportRequest` metadata and
`notes_import_image_paths`. Convert native paths to owned `ImageSource::Path`
inside `spawn_blocking`; reuse `NotesService::import_images` and every raw
import validation/history rule. Do not add a path-specific domain command.

- [ ] **Step 6: Integrate drop targets without changing outline drag**

Mount `useImageIngest` once per `NotesOutline`. Native file events and browser
file events use a layout-neutral existing `.notes-image-drop-position`.
Internal node drag continues exclusively through `useOutlineDrag`.

Image rows retain the standard bullet drag handle, so existing multi-selection
and cross-split `MoveNodes` behavior applies without image-specific movement
code.

- [ ] **Step 7: Add structural parity tests**

Import image nodes, then use real preview/store operations to verify
multi-select indent/outdent, move up/down, duplicate, complete, star, Trash,
restore, Zoom, and drag from primary to secondary split. Assert duplicate
metadata shares the content hash and does not call the byte import API.

- [ ] **Step 8: Run GREEN and split regressions**

Run:

```powershell
npm run test:v2:frontend -- imageInsertion.test.ts useImageIngest.test.tsx splitPaneIntegration.test.tsx outlineDragPlan.test.ts
cargo test -p yonalist-v2-desktop
cargo test -p notes-application --test image_service
```

Expected: picker/drop placement and all existing structural tests pass.

- [ ] **Step 9: Commit the ingest checkpoint**

```powershell
git add apps/desktop apps/desktop/src-tauri package-lock.json
git commit -m "feat(v2): import image files"
```

---

### Task 6: Resize, Replace, Lightbox, Original View, And Download

**Files:**
- Create: `apps/desktop/src/ImageLightbox.tsx`
- Create: `apps/desktop/src/ImageLightbox.test.tsx`
- Create: `apps/desktop/src/imageResize.ts`
- Create: `apps/desktop/src/imageResize.test.ts`
- Modify: `apps/desktop/src/ImageNodeContent.tsx`
- Modify: `apps/desktop/src/ImageNodeContent.test.tsx`
- Modify: `apps/desktop/src/storeImages.ts`
- Modify: `apps/desktop/src/storeImages.test.ts`
- Modify: `apps/desktop/src/imageApi.ts`
- Modify: `apps/desktop/src/api.ts`
- Modify: `apps/desktop/src/previewApi.ts`
- Modify: `apps/desktop/src-tauri/src/image_ipc.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/build.rs`
- Modify: `apps/desktop/src-tauri/permissions/main-window.toml`

**Interfaces:**
- Consumes: `ResizeImage`, `ReplaceImage`, `ImageResidency`
- Produces: image menu actions and one-gesture resize
- Produces: verified original-view and atomic download commands

- [ ] **Step 1: Write failing pure resize tests**

Assert pointer movement clamps to `120..contentWidth`, preserves aspect ratio
in presentation, and returns one final integer width. Assert ArrowLeft/Right
changes by 10 and Shift+Arrow changes by 50 while key repeat remains local
until keyup/blur commits once.

- [ ] **Step 2: Write failing component action tests**

Assert hover/focus exposes the existing ellipsis control; menu keyboard
navigation and Escape work; double-click and Show full-screen reuse the
resident URL; Replace keeps the old image until success; Move to Trash calls
`deleteSubtree`; and resize emits one store call at gesture end.

Assert replacement preserves node ID, hierarchy, description, children,
flags, selection, and display width while accessible filename/dimensions/hash
change after the receipt.

- [ ] **Step 3: Run frontend RED**

Run:

```powershell
npm run test:v2:frontend -- imageResize.test.ts ImageNodeContent.test.tsx ImageLightbox.test.tsx storeImages.test.ts
```

Expected: FAIL because the edit and menu actions are absent.

- [ ] **Step 4: Implement resize as overlay then command**

Keep `previewWidth` component-local. On pointer/key gesture end call
`store.images.resize(node.id, previewWidth)` once. On failure return to
confirmed `node.image.displayWidth` and expose the existing inline error style.
Do not publish width on pointermove.

- [ ] **Step 5: Implement replace through the shared import machinery**

Add raw/path replace envelopes carrying target node ID instead of insertion
anchor. `NotesService::replace_image` prepares the candidate, constructs
`ReplaceImage`, and uses the same checked execution/idempotency/history path.
Rollback newly published bytes on failure. Preview mirrors the same receipt
semantics.

- [ ] **Step 6: Implement lightbox and menu with existing classes**

Use the existing `.notes-image-menu-*` and `.notes-image-lightbox-*` CSS. The
lightbox receives the resident URL and creates no second read or object URL.
Trap focus inside the modal, close on Escape/backdrop/close button, and restore
focus to the menu trigger.

- [ ] **Step 7: Write failing native path-security tests**

Assert read/original/download succeed only for a database-owned active image.
Reject unknown/text/deleted nodes, missing files, hash mismatch, relative-path
tampering, symlink/reparse escape, directory/device destination, and source
mutation. Assert save cancellation calls no backend operation.

- [ ] **Step 8: Implement original view and atomic download**

Resolve only from database metadata. For View original, verified-read the
asset, write a read-only temporary copy outside the canonical asset directory,
and open that copy. For Download, write a sibling temporary file, flush it,
and atomically rename after native overwrite confirmation. Never return the
canonical asset path to JavaScript.

- [ ] **Step 9: Run GREEN and history verification**

Run:

```powershell
npm run test:v2:frontend -- imageResize.test.ts ImageNodeContent.test.tsx ImageLightbox.test.tsx storeImages.test.ts
cargo test -p yonalist-v2-desktop image
cargo test -p notes-application --test image_service
cargo test -p notes-sqlite --test image_assets
```

Expected: resize/replace/menu/history/security tests pass with no extra read on
lightbox open.

- [ ] **Step 10: Commit the editing checkpoint**

```powershell
git add apps/desktop/src apps/desktop/src-tauri crates
git commit -m "feat(v2): edit local image nodes"
```

---

### Task 7: Performance, Desktop Proof, Documentation, And Final Gate

**Files:**
- Modify: `crates/notes-sqlite/tests/performance.rs`
- Create: `apps/desktop/src/imagePerformance.test.tsx`
- Modify: `apps/desktop/src/App.test.tsx`
- Modify: `docs/v2/architecture.md`
- Modify: `docs/v2/current-app-differences.md`
- Modify: `docs/v2/feature-parity-matrix.md`
- Modify: `docs/v2/performance.md`
- Modify: `docs/v2/verification.md`

**Interfaces:**
- Verifies all approved requirements; introduces no new production interface

- [ ] **Step 1: Add focused performance regressions**

Add a 50,000-node text fixture with image support linked and assert existing
bootstrap/query limits remain unchanged. Render 512 mixed image/text nodes,
intersect all frames in sequence, and assert at most eight object URLs and at
most eight completed byte buffers remain resident. Open 100 image menus and
assert zero read calls.

- [ ] **Step 2: Run the performance tests before optimization**

Run:

```powershell
npm run test:v2:frontend -- imagePerformance.test.tsx
npm run test:v2:performance
```

Record the first measurements. If a threshold fails, profile the failing
boundary and change only the image subscription/residency/query responsible
for the regression; do not weaken the existing threshold.

- [ ] **Step 3: Verify clean close reconciliation**

In a temporary data directory import A, replace with B, Undo/Redo, close, and
assert only hashes reachable from the final database remain. Kill a process
after publication but before commit, restart without startup scanning, invoke
close, and assert the orphan is removed then. Confirm Undo history is empty
after restart.

- [ ] **Step 4: Run the full automated gate once**

Run:

```powershell
cargo fmt --all -- --check
cargo test --workspace
npm run test:v2:frontend
npm run lint:v2
npm run v2:build
npm run test:v2:architecture
npm run test:v2:contracts
npm run test:v2:bundle
npm run test:v2:performance
git diff --check
```

Expected: every command exits zero. The initial editable bundle remains at or
below 300 KiB raw / 90 KiB gzip, with image UI and dialog code outside the
text-only initial graph.

- [ ] **Step 5: Build and launch a fresh isolated desktop**

Use a new explicit directory:

```powershell
$env:YONALIST_V2_DATA_DIR = Join-Path $env:TEMP 'yonalist-v2-image-proof'
npm run v2:tauri:dev
```

Confirm the process and bundle were rebuilt after the final commit. Do not use
the ordinary app-data database.

- [ ] **Step 6: Exercise the complete manual path**

1. Paste two images between two known bullets and confirm contiguous order.
2. Hold Enter on adjacent text bullets and verify no empty rows outrun focus.
3. Resize, replace, add a description, move/indent, multi-select, and drag an
   image across split panes.
4. Undo/Redo every image and structural action and verify focus/selection.
5. Open lightbox, original view, and download; verify one resident read.
6. Move an image to Trash, restore it, close, restart, and verify bytes,
   metadata, order, dimensions, description, and children.
7. Confirm Korean IME, held Backspace, arrows, and text clipboard behavior are
   unchanged next to image nodes.
8. Confirm console warnings/errors are zero.

- [ ] **Step 7: Update active documentation with measured evidence**

Document the new image boundary, exact automated counts, bundle size,
50,000-node timings, residency maximum, menu read count, fresh desktop
scenario, and remaining exclusions. Move images from pending to implemented
in the parity/differences documents; leave export, settings, Recent/Archive,
date picker, Vault sync, and GitHub Notifications pending/excluded as already
defined.

- [ ] **Step 8: Review the frozen diff**

Inspect:

```powershell
git diff --stat c436e1f..HEAD
git diff --check c436e1f..HEAD
git status --short
```

Review specifically for bytes/paths in history or DTOs, startup asset I/O,
per-text-row image subscriptions, duplicate state authority, object-URL leaks,
schema migrations, legacy imports, and unintended CSS/DOM changes.

- [ ] **Step 9: Commit documentation and final corrections**

```powershell
git add docs/v2 crates/notes-sqlite/tests/performance.rs apps/desktop/src/imagePerformance.test.tsx apps/desktop/src/App.test.tsx
git commit -m "docs(v2): verify image node delivery"
```

- [ ] **Step 10: Request final code review and finish the branch**

Apply `superpowers:requesting-code-review`, correct every Critical or Important
finding with a focused RED/GREEN cycle, rerun the affected owner test and the
complete gate once, then apply `superpowers:finishing-a-development-branch`.

---

## Dependency Order

```text
Task 1 domain
  -> Task 2 SQLite + generated views
       -> Task 3 asset port + raw native vertical slice
            -> Task 4 clipboard + lazy renderer
                 -> Task 5 picker/drop + structural parity
                      -> Task 6 editing and native actions
                           -> Task 7 performance + desktop proof
```

## Plan Self-Review

- **Spec coverage:** Tasks 1-6 cover independent nodes, byte/path ingestion,
  lazy display, resize, replace, deletion, structural parity, Undo/Redo,
  restart, lightbox, original view, download, recovery, security, and unchanged
  visual presentation. Task 7 covers startup, residency, text performance,
  fresh desktop proof, and active docs.
- **Non-goals:** No task adds crop/rotate/filter/annotation/OCR, export,
  Markdown sync, remote image fetch, generic files, Vault sync, GitHub
  Notifications, migration, or new theme/design.
- **Type consistency:** `NoteNode.image: Option<NoteImage>` maps only to
  `NoteView.image: ImageView | null`; `relative_path` stays Rust-only;
  `MutationReceipt` remains unchanged; every byte transfer uses the image API,
  never `IpcNotesCommand`.
- **History consistency:** Import/replace/resize produce ordinary
  `DomainPatch` entries in the one existing session stack. Delete, duplicate,
  move, indent, split-pane drag, Undo, and Redo reuse current commands.
- **Performance consistency:** The renderer is lazy by node kind, residency is
  workspace-global and capped at eight, dialog/image UI is event-loaded, and
  startup never reconciles or reads assets.
