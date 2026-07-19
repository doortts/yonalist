<!-- reconciliation: auditedHead=ec8a9ff3d016449255992adf70e128ea5e222e9a status=complete -->
> **증거 대조 상태 (2026-07-19): 완료.** commit·artifact 근거는 [감사 보고서](../reports/2026-07-19-historical-plan-reconciliation.md)에 기록했다.

# Notes Multi-Image Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the native image picker, add Workflowy-style native drop targeting and clipboard paste, and import every image in one ordered, all-or-nothing Notes history command.

**Architecture:** A Tauri UI boundary normalizes multi-select and native drag events, while `NotesOutlinePane` owns target preview and paste routing. Path batches use JSON IPC; clipboard batches use a versioned raw binary envelope. Rust validates the complete batch under one import-budget guard, publishes content-addressed assets inside one coordinated SQLite history transaction, and reconciles any files published before a failed commit.

**Tech Stack:** React 18, TypeScript 5.7, Vitest 4, Tauri 2.8, Rust 1.77+, rusqlite 0.31, cap-std, image 0.25, SHA-256.

## Global Constraints

- Supported formats are PNG, JPEG, WebP, and GIF; SVG remains rejected.
- Each image is limited to 20 MiB and 40,000,000 decoded pixels.
- One batch is limited to 64 MiB of image bytes, 128 images, 128 attachments per node, and 512 attachments per Vault.
- Batch order is the picker, native drop, or clipboard item order received by the app.
- One invalid item rejects the whole batch; no attachment row from that action may remain.
- A crash after any asset publication but before metadata commit is recovered on next Notes open: an fsynced reconciliation marker causes orphan cleanup while preserving hashes referenced by live or retained-history rows.
- Validation errors identify each failed filename and its reason; infrastructure failures identify the batch operation.
- One successful batch creates one Notes history entry; one Undo/Redo replays the whole batch.
- Existing content-hash deduplication, resize, remove, export, Trash, purge, and history retention behavior must remain intact.
- Native drop coordinates must be converted from physical pixels to logical client coordinates.
- A drop preview appears after existing attachments and is removed on leave, drop, success, failure, or unmount.
- Text-only paste keeps the browser's normal paste behavior.
- Do not edit or stage `docs/superpowers/specs/2026-07-12-notes-trash-history-and-library-rename-design.md`.

## File Structure

- `src/features/notes/notesAttachmentController.ts`: native picker and native drag event boundary only.
- `src/features/notes/NotesAttachmentUiContext.ts`: provides one injectable boundary to the hook and pane.
- `src/features/notes/notesAttachmentTargets.ts`: pure DOM target resolution.
- `src/features/notes/notesClipboardImages.ts`: ordered clipboard image extraction and safe generated names.
- `src/services/notesAttachmentRawIpc.ts`: versioned raw envelope encoding only.
- `src/test-fixtures/notes-attachment-batch-v1.hex`: one cross-language wire fixture consumed by TypeScript and Rust tests.
- `src/domain/notes.ts`: public Notes batch contracts and limits.
- `src/services/notesStore.ts`: strict input validation and Tauri invocation.
- `src/features/notes/useNotesWorkspace.ts`: batch attempts, retries, one structural command, and projection.
- `src/features/notes/NotesOutlinePane.tsx`: drag listener lifecycle, preview state, and paste routing.
- `src/features/notes/OutlineNodeRow.tsx`, `NotesPageHeader.tsx`, `NotesAttachmentList.tsx`: target attributes and visual state only.
- `src-tauri/src/notes/attachment_ingest.rs`: raw envelope decode and batch preparation helpers.
- `src-tauri/src/notes/attachments.rs`: import memory budget and content-addressed publication.
- `src-tauri/src/notes/repository.rs`: ordered batch metadata transaction.
- `src-tauri/src/notes/commands.rs`: path/raw commands and shared import orchestration.

---

### Task 1: Native Picker Permission And Drag Boundary

**Files:**
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src/features/notes/notesAttachmentController.ts`
- Modify: `src/features/notes/notesAttachmentController.test.ts`
- Create: `src/features/notes/notesAttachmentCapabilities.test.ts`
- Create: `src/features/notes/NotesAttachmentUiContext.ts`
- Modify: `src/features/notes/NotesFeature.tsx`

**Interfaces:**
- Produces: `NotesAttachmentUiBoundary.openImageFiles(): Promise<readonly string[] | null>`
- Produces: `NotesAttachmentUiBoundary.subscribeToImageDrop(listener): Promise<() => void>`
- Produces: `useNotesAttachmentUi(): NotesAttachmentUiBoundary`

- [x] **Step 1: Write failing permission and native-boundary tests**

```ts
expect(capabilities.permissions).toEqual(
  expect.arrayContaining(["dialog:allow-open", "dialog:allow-save"])
);

open.mockResolvedValue(["/incoming/one.png", "/incoming/two.webp"]);
await expect(nativeNotesAttachmentUi.openImageFiles()).resolves.toEqual([
  "/incoming/one.png",
  "/incoming/two.webp"
]);
expect(open).toHaveBeenCalledWith(expect.objectContaining({ multiple: true }));

await nativeNotesAttachmentUi.subscribeToImageDrop(listener);
nativeDropHandler({
  payload: {
    type: "enter",
    paths: ["/incoming/one.png"],
    position: { toLogical: () => ({ x: 120, y: 80 }) }
  }
});
expect(listener).toHaveBeenCalledWith({
  type: "enter",
  paths: ["/incoming/one.png"],
  position: { x: 120, y: 80 }
});
```

- [x] **Step 2: Run the focused tests and confirm the old single-file API fails**

Run: `npm test -- src/features/notes/notesAttachmentCapabilities.test.ts src/features/notes/notesAttachmentController.test.ts`

Expected: FAIL because `dialog:allow-open`, `openImageFiles`, and `subscribeToImageDrop` do not exist.

- [x] **Step 3: Implement the permission, normalized picker, logical drag events, and context**

```ts
export interface NotesLogicalPoint {
  readonly x: number;
  readonly y: number;
}

export type NotesNativeImageDropEvent =
  | { readonly type: "enter" | "drop"; readonly paths: readonly string[]; readonly position: NotesLogicalPoint }
  | { readonly type: "over"; readonly position: NotesLogicalPoint }
  | { readonly type: "leave" };

export interface NotesAttachmentUiBoundary {
  /** Temporary compatibility seam removed in Task 6 after all callers switch. */
  openImageFile(): Promise<string | null>;
  /** Temporary browser-test seam removed with the old DOM drop path in Task 7. */
  pathForDroppedFile(file: File): string | null;
  openImageFiles(): Promise<readonly string[] | null>;
  subscribeToImageDrop?(
    listener: (event: NotesNativeImageDropEvent) => void
  ): Promise<() => void>;
}
```

Implement `openImageFiles` with `multiple: true`, normalizing a legacy string result to a one-element array and cancellation to `null`. Keep `openImageFile` as a temporary one-result delegate and keep `pathForDroppedFile` unchanged so this commit remains type-safe before Tasks 6 and 7. Implement optional `subscribeToImageDrop` with `getCurrentWebview().onDragDropEvent`; read `getCurrentWindow().scaleFactor()` for each positioned event before calling `toLogical(scaleFactor)` so moving the window between mixed-DPI displays cannot reuse a stale scale. Test a changed scale factor between two events. `NotesFeatureProvider` must provide the same boundary to both `useNotesWorkspace` and `NotesOutlinePane` through `NotesAttachmentUiContext`.

- [x] **Step 4: Run focused tests and type checking**

Run: `npm test -- src/features/notes/notesAttachmentCapabilities.test.ts src/features/notes/notesAttachmentController.test.ts && npm run build`

Expected: PASS; the temporary compatibility methods keep existing callers type-safe until Tasks 6 and 7.

- [x] **Step 5: Commit the boundary**

```bash
git add src-tauri/capabilities/default.json src/features/notes/notesAttachmentCapabilities.test.ts src/features/notes/notesAttachmentController.ts src/features/notes/notesAttachmentController.test.ts src/features/notes/NotesAttachmentUiContext.ts src/features/notes/NotesFeature.tsx
git commit -m "fix(notes): enable native multi-image selection"
```

---

### Task 2: Batch Contracts And Raw Envelope Codec

**Files:**
- Modify: `src/domain/notes.ts`
- Modify: `src/domain/notes.test.ts`
- Create: `src/services/notesAttachmentRawIpc.ts`
- Create: `src/services/notesAttachmentRawIpc.test.ts`
- Create: `src/test-fixtures/notes-attachment-batch-v1.hex`

**Interfaces:**
- Produces: `ImportNoteAttachmentPathBatchInput`
- Produces: `ImportNoteAttachmentBytesBatchInput`
- Produces: `encodeNotesAttachmentRawEnvelope(vaultPath, input, historyContext): Promise<Uint8Array>`
- Adds temporary optional `NotesStore.importAttachmentPaths` and `NotesStore.importAttachmentBytes` signatures; Task 5 makes them required after both implementations exist.
- Consumed later by: `notesStore.ts`, `attachment_ingest.rs`, and `useNotesWorkspace.ts`

- [x] **Step 1: Write failing envelope fixture tests**

Define one checked-in hexadecimal fixture with two Unicode filenames and assert this byte layout:

```text
0..4   ASCII "YNAB"
4      version 1
5..9   little-endian u32 metadata byte length
9..N   UTF-8 JSON metadata
N..    image bytes concatenated in metadata order
```

```ts
const envelope = await encodeNotesAttachmentRawEnvelope(
  "/vault",
  {
    nodeId,
    initialMaxDisplayWidth: 480,
    attachments: [
      { id: firstId, originalName: "첫째.png", mimeType: "image/png", blob: new Blob([new Uint8Array([1, 2])], { type: "image/png" }) },
      { id: secondId, originalName: "둘째.webp", mimeType: "image/webp", blob: new Blob([new Uint8Array([3, 4, 5])], { type: "image/webp" }) }
    ]
  },
  historyContext
);
expect([...envelope.slice(-5)]).toEqual([1, 2, 3, 4, 5]);
```

Metadata items contain a zero-based `ordinal`; array index is the transport order, and every ordinal must equal that index. Also assert rejection for zero items, 129 items, an empty blob, one item over 20 MiB, aggregate bytes over 64 MiB, metadata over 256 KiB, duplicate IDs, invalid IDs, non-contiguous ordinals in the decoded fixture, and non-positive display width. The TypeScript encoder output must exactly match `src/test-fixtures/notes-attachment-batch-v1.hex`; Task 3 decodes the same bytes in Rust.

- [x] **Step 2: Run the codec test and confirm it fails**

Run: `npm test -- src/services/notesAttachmentRawIpc.test.ts`

Expected: FAIL because the batch types, constants, and encoder do not exist.

- [x] **Step 3: Add exact domain contracts and implement bounded sequential encoding**

```ts
export const MAX_NOTE_ATTACHMENT_BATCH_BYTES = 64 * 1024 * 1024;
export const MAX_NOTE_ATTACHMENT_BATCH_METADATA_BYTES = 256 * 1024;

export interface ImportNoteAttachmentPathBatchInput {
  readonly nodeId: NoteId;
  readonly attachments: readonly {
    readonly id: string;
    readonly sourcePath: string;
  }[];
  readonly initialMaxDisplayWidth: number;
}

export interface ImportNoteAttachmentByteItem {
  readonly id: string;
  readonly originalName: string;
  readonly mimeType: string;
  readonly blob: Blob;
}

export type PendingNoteAttachmentByteItem = Omit<ImportNoteAttachmentByteItem, "id">;

export interface ImportNoteAttachmentBytesBatchInput {
  readonly nodeId: NoteId;
  readonly attachments: readonly ImportNoteAttachmentByteItem[];
  readonly initialMaxDisplayWidth: number;
}

export interface NotesStore {
  importAttachmentPaths?(
    vaultPath: string,
    input: ImportNoteAttachmentPathBatchInput,
    historyContext?: NotesHistoryContext | null
  ): Promise<NotesMutationResponse>;
  importAttachmentBytes?(
    vaultPath: string,
    input: ImportNoteAttachmentBytesBatchInput,
    historyContext?: NotesHistoryContext | null
  ): Promise<NotesMutationResponse>;
}
```

Preflight every `Blob.size` before allocation. Allocate the final envelope once, then await and copy one `blob.arrayBuffer()` at a time so live JS memory is bounded by the envelope plus one image. Metadata records only `id`, `ordinal`, `originalName`, `mimeType`, and `byteLength`; it also carries `vaultPath`, `nodeId`, `initialMaxDisplayWidth`, and `historyContext`. The decoded image format is authoritative. Declared MIME must match it, while the original filename extension is display metadata and may be absent or mismatched; canonical storage extension always comes from decoded bytes.

- [x] **Step 4: Run codec tests and build**

Run: `npm test -- src/services/notesAttachmentRawIpc.test.ts && npm run build`

Expected: PASS.

- [x] **Step 5: Commit the versioned contract**

```bash
git add src/domain/notes.ts src/domain/notes.test.ts src/services/notesAttachmentRawIpc.ts src/services/notesAttachmentRawIpc.test.ts src/test-fixtures/notes-attachment-batch-v1.hex
git commit -m "feat(notes): define atomic image batch transport"
```

---

### Task 3: Rust Envelope Decoder And Batch Preparation Budget

**Files:**
- Create: `src-tauri/src/notes/attachment_ingest.rs`
- Modify: `src-tauri/src/notes/mod.rs`
- Modify: `src-tauri/src/notes/attachments.rs`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/commands.rs`

**Interfaces:**
- Consumes: the `YNAB` v1 envelope from Task 2.
- Produces: `decode_raw_attachment_envelope(body)` and one guard-owning `PreparedAttachmentBatch`.
- Produces: `ImportAttachmentPathBatchInput` Rust deserialization contract.

- [x] **Step 1: Add failing Rust decoder and budget tests**

```rust
#[test]
fn raw_envelope_preserves_unicode_names_and_source_order() {
    let decoded = decode_raw_attachment_envelope(&two_image_fixture()).unwrap();
    assert_eq!(decoded.sources[0].original_name, "첫째.png");
    assert_eq!(decoded.sources[0].bytes, &[1, 2]);
    assert_eq!(decoded.sources[1].bytes, &[3, 4, 5]);
}

#[test]
fn one_batch_budget_can_prepare_multiple_images_without_deadlock() {
    let batch = PreparedAttachmentBatch::from_bytes(vec![first_source(), second_source()]).unwrap();
    assert_eq!(batch.attachments()[0].image.mime_type, "image/png");
    assert_eq!(batch.attachments()[1].image.mime_type, "image/png");
}
```

Add malformed magic, version, metadata length, trailing bytes, unknown JSON fields, wrong JSON types, MIME mismatch, non-contiguous or duplicate ordinal, per-image cap, aggregate cap, item cap, duplicate ID, invalid UUID, and canonical-extension-from-decoded-format cases. Decode the exact Task 2 fixture. Add a concurrency test proving a second batch cannot acquire the budget until the first `PreparedAttachmentBatch` is dropped.

- [x] **Step 2: Run focused Rust tests and confirm failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml attachment_ingest::tests -- --nocapture`

Expected: FAIL because the module and budget API do not exist.

- [x] **Step 3: Implement strict borrowed decoding and refactor the import guard**

```rust
pub(crate) const MAX_ATTACHMENT_BATCH_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const MAX_ATTACHMENT_BATCH_METADATA_BYTES: usize = 256 * 1024;

struct AttachmentImportBudget {
    _guard: MutexGuard<'static, ()>,
}

pub(crate) struct PreparedAttachmentBatch {
    _budget: AttachmentImportBudget,
    attachments: Vec<PreparedAttachment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportAttachmentPathBatchInput {
    pub(crate) node_id: String,
    pub(crate) attachments: Vec<ImportAttachmentPathItem>,
    pub(crate) initial_max_display_width: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportAttachmentPathItem {
    pub(crate) id: String,
    pub(crate) source_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportAttachmentBytesMetadata {
    pub(crate) vault_path: String,
    pub(crate) node_id: String,
    pub(crate) attachments: Vec<ImportAttachmentBytesMetadataItem>,
    pub(crate) initial_max_display_width: i64,
    pub(crate) history_context: Option<NotesHistoryContext>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportAttachmentBytesMetadataItem {
    pub(crate) id: String,
    pub(crate) ordinal: u32,
    pub(crate) original_name: String,
    pub(crate) mime_type: String,
    pub(crate) byte_length: u64,
}

pub(crate) struct RawAttachmentSource<'a> {
    pub(crate) original_name: String,
    pub(crate) declared_mime_type: String,
    pub(crate) bytes: &'a [u8],
}

pub(crate) struct DecodedAttachmentBatch<'a> {
    pub(crate) metadata: ImportAttachmentBytesMetadata,
    pub(crate) sources: Vec<RawAttachmentSource<'a>>,
}
```

Remove `MutexGuard` from `PreparedAttachment`; make `PreparedAttachmentBatch` fields private so prepared bytes cannot outlive their one budget guard. Update the existing single-image command in this task to prepare a one-item batch and hold it through publication, preserving the old command API and crate-wide compilation until Task 5. Decode metadata with checked integer arithmetic, require exact body consumption, validate `ordinal == array index`, and compare declared MIME with fully decoded MIME. Do not copy raw body slices in the decoder.

- [x] **Step 4: Run attachment decoder and existing security tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml attachment_ingest::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml notes_attachment_import_budget -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml notes_attachment_source_open_rejects -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml notes_attachment_validation_rejects -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml notes_attachment_owned_paths -- --nocapture
```

Expected: PASS without deadlock or weakened symlink/FIFO protections.

- [x] **Step 5: Commit preparation support**

```bash
git add src-tauri/src/notes/attachment_ingest.rs src-tauri/src/notes/mod.rs src-tauri/src/notes/attachments.rs src-tauri/src/notes/types.rs src-tauri/src/notes/commands.rs
git commit -m "feat(notes): prepare bounded image batches"
```

---

### Task 4: Ordered Batch Metadata Transaction And History

**Files:**
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/history.rs`

**Interfaces:**
- Consumes: `Vec<NewAttachment>` prepared in source order.
- Produces: `create_attachments_coordinated_for_node` with count-aware capacity inside its caller-owned history transaction.

- [x] **Step 1: Write failing transaction, ordering, and rollback tests**

```rust
#[test]
fn coordinated_attachment_batch_inserts_in_order_inside_one_transaction() {
    let result = create_attachments_coordinated_for_node(
        &mut connection,
        NODE_ID,
        vec![new_attachment(FIRST_ID), new_attachment(SECOND_ID)],
        || Ok(()),
        || Ok(()),
    ).unwrap();
    let ids = result.attachments_by_node_id[NODE_ID]
        .iter().map(|item| item.id.as_str()).collect::<Vec<_>>();
    assert_eq!(ids, [FIRST_ID, SECOND_ID]);
}
```

Add cases for node/vault capacity rejected before `publish`, duplicate IDs rejected before `publish`, publication failure leaving zero rows, `before_commit` failure leaving zero rows, and sort-key overflow. Command-level Task 5 tests own the active history context and verify exactly one history row plus complete Undo/Redo.

- [x] **Step 2: Run repository tests and confirm failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml coordinated_attachment_batch -- --nocapture`

Expected: FAIL because only the single-attachment coordinated seam exists.

- [x] **Step 3: Implement one immediate SQLite transaction**

```rust
pub(crate) fn create_attachments_coordinated_for_node(
    connection: &mut Connection,
    node_id: &str,
    attachments: Vec<NewAttachment>,
    publish: impl FnOnce() -> Result<(), String>,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<NotesWorkspace, String>
```

Inside the caller-owned transaction: require an active target node, validate `existing_node_count + batch_len <= 128` and `vault_count + batch_len <= 512`, validate every ID and metadata row, reject duplicates, compute all sort keys with checked arithmetic, call `publish`, insert every row in vector order, load workspace, and revalidate storage identity. The command's existing `with_history_transaction_and_prunes` wrapper finalizes and commits once when an active history context exists. Keep the old single helper as a one-item delegate for existing direct tests.

- [x] **Step 4: Run repository and history tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml coordinated_attachment_batch -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml attachment_history -- --nocapture
```

Expected: PASS; injected failures leave no metadata rows or history entry.

- [x] **Step 5: Commit the atomic transaction**

```bash
git add src-tauri/src/notes/repository.rs src-tauri/src/notes/history.rs
git commit -m "feat(notes): commit image batches in one history entry"
```

---

### Task 5: Rust Commands And TypeScript Store Integration

**Files:**
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/domain/notes.ts`
- Modify: `src/domain/notes.test.ts`
- Modify: `src/services/notesStore.ts`
- Modify: `src/services/notesStore.tauri.test.ts`
- Modify: `src/services/notesStore.test.ts`

**Interfaces:**
- Produces Rust commands: `notes_import_attachment_paths_batch` and `notes_import_attachment_bytes`.
- Produces store methods: `importAttachmentPaths` and `importAttachmentBytes`.
- Preserves: `notes_import_attachment` and `notesImportAttachment` as one-item delegates.

- [x] **Step 1: Write failing command and store tests**

Assert one exact JSON invocation for two paths and one exact raw invocation for two blobs:

```ts
await notesImportAttachmentPaths(vaultPath, pathBatch, historyContext);
expect(invokeMock).toHaveBeenCalledOnce();
expect(invokeMock).toHaveBeenCalledWith("notes_import_attachment_paths_batch", {
  vaultPath,
  input: pathBatch,
  historyContext
});

await notesImportAttachmentBytes(vaultPath, byteBatch, historyContext);
expect(invokeMock).toHaveBeenCalledWith(
  "notes_import_attachment_bytes",
  expect.any(Uint8Array)
);
```

Rust command tests must cover path order, raw order, one history entry, full Undo/Redo, mixed invalid path rejection, malformed raw body, 64 MiB aggregate rejection, publication failure cleanup, crash injection after each published item and immediately before metadata commit, restart reconciliation, shared-hash preservation, a lost-success-response retry, and rejection of partial/mismatched duplicate IDs.

- [x] **Step 2: Run focused tests and confirm missing commands**

Run: `npm test -- src/services/notesAttachmentRawIpc.test.ts src/services/notesStore.tauri.test.ts && cargo test --manifest-path src-tauri/Cargo.toml notes_attachment_batch -- --nocapture`

Expected: FAIL because the batch commands and store methods are not registered.

- [x] **Step 3: Implement shared command orchestration and strict store normalization**

```rust
#[tauri::command(rename_all = "camelCase")]
pub(crate) fn notes_import_attachment_paths_batch(
    vault_path: String,
    input: ImportAttachmentPathBatchInput,
    history_context: Option<NotesHistoryContext>,
) -> Result<NotesMutationResult, String>;

#[tauri::command]
pub(crate) fn notes_import_attachment_bytes(
    request: tauri::ipc::Request<'_>,
) -> Result<NotesMutationResult, String>;
```

Both commands must call one internal `import_prepared_attachment_batch`. Acquire one storage lease and guard-owning prepared batch, prepare and validate all inputs before publication, collect filename-specific validation failures, capture the database identity, and durably create the existing attachment-reconciliation marker before the first possible publication. If a marker already exists, complete full reconciliation before beginning a new batch. Execute Task 4's coordinated transaction and reconcile candidate paths after every returned failure. After commit, reconcile against live plus retained-history references and clear the marker only after cleanup and directory sync succeed. On process restart, the marker forces the same full reconciliation, preserving pre-existing/shared hashes while deleting only unreferenced batch assets.

Before treating duplicate IDs as an error, compare all requested IDs, node, source order, prepared content hashes, names, MIME, dimensions, display width, and the supplied history entry with committed rows. If every item and the one history entry match, return the current mutation result without publishing or adding history; this makes a retry converge after a committed response is lost. A partial set or any mismatch fails closed as inconsistent state. Register both commands in `generate_handler!` and its registration regression test.

```ts
export function notesImportAttachmentPaths(
  vaultPath: string,
  input: ImportNoteAttachmentPathBatchInput,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesMutationResult>;

export function notesImportAttachmentBytes(
  vaultPath: string,
  input: ImportNoteAttachmentBytesBatchInput,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesMutationResult>;
```

Promote both batch methods from optional to required on `NotesStore` in this task. Validate exact keys, canonical UUIDs, non-empty path strings without NUL, item count, aggregate `Blob.size`, unique IDs, and positive display width before invoking Tauri. Do not parse platform path syntax, filename extensions, or image formats in TypeScript; Rust performs canonical no-follow open and decoded-format validation for both supported and unsupported native paths.

- [x] **Step 4: Run store, command, and existing single-image tests**

Run: `npm test -- src/services/notesAttachmentRawIpc.test.ts src/services/notesStore.tauri.test.ts src/services/notesStore.test.ts && cargo test --manifest-path src-tauri/Cargo.toml notes_attachment -- --nocapture`

Expected: PASS; the legacy one-item call remains valid.

- [x] **Step 5: Commit IPC integration**

```bash
git add src-tauri/src/notes/commands.rs src-tauri/src/lib.rs src/domain/notes.ts src/domain/notes.test.ts src/services/notesStore.ts src/services/notesStore.tauri.test.ts src/services/notesStore.test.ts
git commit -m "feat(notes): import path and clipboard image batches"
```

---

### Task 6: Workspace Batch Attempts, Retry, And One Structural Command

**Files:**
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/features/notes/useNotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: `NotesStore.importAttachmentPaths` and `importAttachmentBytes`.
- Produces actions: `importDroppedImagePaths(nodeId, paths)` and `importClipboardImages(nodeId, items: readonly PendingNoteAttachmentByteItem[])`.
- Preserves action: `uploadImage(nodeId)` with multi-select behavior.

- [x] **Step 1: Replace single-image expectations with failing atomic batch tests**

Cover picker order, drop order, clipboard order, one repository call, one generated history context, picker cancellation, all IDs allocated before invocation, stale session rejection, batch retry with the same IDs and sources, committed-response-loss convergence, invalid width, unsupported paths delegated to Rust, and atomic error publication. Run two same-node batches concurrently with inverse completion/failure order and prove each batch preserves its internal order, stale results do not overwrite newer workspace state, and retry state is isolated per attempt.

```ts
expect(store.importAttachmentPaths).toHaveBeenCalledWith(
  "/vault",
  {
    nodeId: root.id,
    attachments: [
      { id: firstId, sourcePath: "/incoming/one.png" },
      { id: secondId, sourcePath: "/incoming/two.webp" }
    ],
    initialMaxDisplayWidth: 480
  },
  historyContext("attachment-import")
);
expect(store.importAttachmentPaths).toHaveBeenCalledTimes(1);
```

- [x] **Step 2: Run the hook tests and confirm old one-at-a-time logic fails**

Run: `npm test -- src/features/notes/useNotesWorkspace.test.tsx`

Expected: FAIL on `openImageFiles`, multi-item order, and new actions.

- [x] **Step 3: Implement one reusable batch request state machine**

```ts
type AttachmentImportRequest =
  | { readonly kind: "paths"; readonly items: readonly { id: string; sourcePath: string }[] }
  | { readonly kind: "bytes"; readonly items: readonly ImportNoteAttachmentByteItem[] };

interface AttachmentUploadAttempt {
  readonly attemptId: string;
  readonly nodeId: NoteId;
  readonly request: AttachmentImportRequest;
  readonly initialMaxDisplayWidth: number;
  status: "pending" | "failed";
  error: string | null;
}
```

Generate every attachment ID and one stable history context before `runStructuralCommand`. Store one retry attempt per batch, invoke one repository method, project one returned workspace only when its operation generation is current, and call `rememberHistoryAfter` once. Retry reuses IDs, history context, order, and sources so Task 5's idempotency rule can resolve a lost success response. A failed byte batch may retain its `Blob` objects only until success, explicit retry replacement, Vault change, or provider unmount. `uploadImage` captures measured width before opening the picker. Remove the temporary `openImageFile` call path and switch all picker mocks to `openImageFiles`; Task 7 removes `pathForDroppedFile` after native drop integration.

For picker, drop, and paste failures, assert that the target row's `activeElement`, text selection/caret offsets, `selectedId`, and collapsed state equal their pre-attempt values. Image ingestion must not move a Workflowy-style editing caret or expand a subtree as a side effect.

- [x] **Step 4: Run hook tests and the existing history tests**

Run: `npm test -- src/features/notes/useNotesWorkspace.test.tsx src/features/notes/notesHistory.test.ts`

Expected: PASS with no separate history entry per image.

- [x] **Step 5: Commit workspace orchestration**

```bash
git add src/features/notes/useNotesWorkspace.ts src/features/notes/useNotesWorkspace.test.tsx
git commit -m "feat(notes): orchestrate atomic image batches"
```

---

### Task 7: Native Drop Target And Placeholder Preview

**Files:**
- Create: `src/features/notes/notesAttachmentTargets.ts`
- Create: `src/features/notes/notesAttachmentTargets.test.ts`
- Create: `src/features/notes/NotesAttachmentIngest.test.tsx`
- Modify: `src/features/notes/notesAttachmentController.ts`
- Modify: `src/features/notes/notesAttachmentController.test.ts`
- Modify: `src/features/notes/useNotesWorkspace.test.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPageHeader.tsx`
- Modify: `src/features/notes/NotesAttachmentList.tsx`
- Modify: `src/features/notes/NotesAttachmentList.test.tsx`
- Modify: `src/features/notes/NotesPageHeader.test.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src/features/notes/notes.css`

**Interfaces:**
- Consumes: `NotesNativeImageDropEvent` and `importDroppedImagePaths`.
- Produces: `attachmentTargetFromPoint(root, point): NoteId | null`.
- Produces visual props: `imageDropActive` and `showDropPlaceholder`.

- [x] **Step 1: Write failing target, lifecycle, and visual tests**

Test a row, zoomed page header, outside point, nested control, enter/over/leave/drop, target movement, mixed-DPI event coordinates, subscription rejection, late async unlisten, import success/failure cleanup, and unmount cleanup. Cover active outline versus Archive, Trash, loading, deleting, and migration-write-blocked states; only an active writable node may expose a target. Unsupported-only and mixed native path batches still reach Rust once and fail atomically with one pane error and no structural/caret change. A subscription failure must show a pane-level drop error while picker and paste remain available.

```ts
elementFromPoint.mockReturnValue(titleInsideSecondRow);
nativeDrop({ type: "over", position: { x: 220, y: 180 } });
expect(secondRow).toHaveAttribute("data-image-drop-active", "true");
expect(within(secondRow).getByTestId("notes-image-drop-placeholder")).toBeVisible();

nativeDrop({
  type: "drop",
  paths: ["/incoming/one.png", "/incoming/two.png"],
  position: { x: 220, y: 180 }
});
expect(actions.importDroppedImagePaths).toHaveBeenCalledWith(secondId, [
  "/incoming/one.png",
  "/incoming/two.png"
]);
```

- [x] **Step 2: Run focused component tests and confirm no preview exists**

Run: `npm test -- src/features/notes/notesAttachmentTargets.test.ts src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/NotesAttachmentList.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesWorkspace.test.tsx`

Expected: FAIL because rows and headers do not expose image targets or placeholders.

- [x] **Step 3: Implement pane-owned native drop state and presentation-only children**

```ts
export function attachmentTargetFromPoint(
  root: HTMLElement,
  point: NotesLogicalPoint
): NoteId | null {
  const hit = document.elementFromPoint(point.x, point.y);
  const target = hit?.closest<HTMLElement>("[data-notes-attachment-target]");
  return target && root.contains(target)
    ? target.dataset.notesAttachmentTarget ?? null
    : null;
}
```

Subscribe once in `NotesOutlinePane`, protect the async setup with a disposed flag, and immediately call a late unlisten callback after unmount. Keep paths from `enter`; use paths from `drop` as authoritative. Add `data-notes-attachment-target={nodeId}` only to active writable rows and page headers. Remove the old DOM `File.path` drop handlers and delete the temporary `pathForDroppedFile` member from `NotesAttachmentUiBoundary`, its native implementation, tests, and all mocks. Make `subscribeToImageDrop` required in the final boundary; the non-Tauri/browser fallback returns an async no-op unlisten instead of silently omitting the capability. Render a fixed-height, dashed, `aria-hidden` placeholder with Lucide `ImagePlus` after existing attachments. Highlight only the current target and preserve selection/collapse/caret state.

- [x] **Step 4: Run component tests and build**

Run: `npm test -- src/features/notes/notesAttachmentTargets.test.ts src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/NotesAttachmentList.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesWorkspace.test.tsx && npm run build`

Expected: PASS at desktop and narrow test widths with no text overflow or layout shift.

- [x] **Step 5: Commit native drop UX**

```bash
git add src/features/notes/notesAttachmentTargets.ts src/features/notes/notesAttachmentTargets.test.ts src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/notesAttachmentController.ts src/features/notes/notesAttachmentController.test.ts src/features/notes/useNotesWorkspace.test.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesPageHeader.tsx src/features/notes/NotesAttachmentList.tsx src/features/notes/NotesAttachmentList.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/notes.css
git commit -m "feat(notes): preview native image drop targets"
```

---

### Task 8: Ordered Clipboard Image Paste

**Files:**
- Create: `src/features/notes/notesClipboardImages.ts`
- Create: `src/features/notes/notesClipboardImages.test.ts`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/NotesAttachmentIngest.test.tsx`

**Interfaces:**
- Produces: `extractClipboardImages(items): ClipboardImageExtraction` with all-or-nothing null-item handling.
- Produces: `attachmentTargetFromPaste(root, eventTarget, selectedId): NoteId | null`.
- Consumes: `actions.importClipboardImages(nodeId, descriptors)`.

- [x] **Step 1: Write failing paste routing tests**

Cover title focus, supporting-note focus, page-title focus, selected-row fallback, all clipboard image items in source order, an `image/*` item whose `getAsFile()` returns null, unsupported `image/*` reaching backend validation, empty generated names, text-only paste, mixed text/image clipboard flavors, and image paste with no target.

```ts
const pasteEvent = createEvent.paste(focusedTitle, { clipboardData: twoImageClipboard });
fireEvent(focusedTitle, pasteEvent);
expect(actions.importClipboardImages).toHaveBeenCalledWith(nodeId, [first, second]);
expect(pasteEvent.defaultPrevented).toBe(true);

const textPasteEvent = createEvent.paste(focusedTitle, { clipboardData: textClipboard });
fireEvent(focusedTitle, textPasteEvent);
expect(actions.importClipboardImages).not.toHaveBeenCalled();
expect(textPasteEvent.defaultPrevented).toBe(false);
```

- [x] **Step 2: Run helper and ingest tests and confirm failure**

Run: `npm test -- src/features/notes/notesClipboardImages.test.ts src/features/notes/NotesAttachmentIngest.test.tsx`

Expected: FAIL because paste is not intercepted.

- [x] **Step 3: Implement ordered image extraction and pane capture**

```ts
export type ClipboardImageDescriptor = PendingNoteAttachmentByteItem;

export type ClipboardImageExtraction =
  | { readonly kind: "none" }
  | { readonly kind: "images"; readonly items: readonly ClipboardImageDescriptor[] }
  | { readonly kind: "error"; readonly message: string };

export function extractClipboardImages(
  items: DataTransferItemList
): ClipboardImageExtraction;
```

Scan every `image/*` item in source order. If none exists, return `none`; if any such item returns null from `getAsFile`, return one error and no descriptors. Otherwise return every image as `{ blob: file, originalName, mimeType }`. Generate `clipboard-image-<ordinal>.<canonical-extension>` for unnamed supported MIME values and `clipboard-image-<ordinal>` for an unsupported MIME so Rust remains the format authority.

Use `onPasteCapture` on the outline content. On `none`, return without `preventDefault`. On images or extraction error, prevent default before any async work. Resolve the closest writable target attribute, falling back to an active writable `state.selectedId`. An extraction error or missing target stores one pane-level error and saves nothing; missing target displays `Select a note before pasting images.` without changing selection, caret, or structure.

- [x] **Step 4: Run paste, workspace, and keyboard regression tests**

Run: `npm test -- src/features/notes/notesClipboardImages.test.ts src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/outlineKeyboard.test.ts`

Expected: PASS; ordinary title and note text paste remains browser-owned.

- [x] **Step 5: Commit clipboard paste**

```bash
git add src/features/notes/notesClipboardImages.ts src/features/notes/notesClipboardImages.test.ts src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesAttachmentIngest.test.tsx
git commit -m "feat(notes): paste ordered image batches"
```

---

### Task 9: Adversarial Review, Performance, And Native Verification

**Files:**
- Modify as required by validated review findings only.
- Create: `docs/superpowers/reports/2026-07-12-notes-multi-image-ingest-verification.md`

**Interfaces:**
- Consumes all prior tasks.
- Produces a reproducible verification report with command output summaries and native observations.

- [x] **Step 1: Run focused and complete automated verification**

Run:

```bash
npm test -- src/services/notesAttachmentRawIpc.test.ts src/services/notesStore.tauri.test.ts src/features/notes/useNotesWorkspace.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml notes_attachment -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml
```

Before focused Rust commands, run `cargo test --manifest-path src-tauri/Cargo.toml -- --list` and assert the report contains every named new test, including `raw_envelope_preserves_unicode_names_and_source_order`, `one_batch_budget_can_prepare_multiple_images_without_deadlock`, `coordinated_attachment_batch_inserts_in_order_inside_one_transaction`, and `notes_attachment_batch_committed_response_retry_is_idempotent`. Expected: every command exits 0 and every filter runs a nonzero test count. Record exact test counts and elapsed time.

- [x] **Step 2: Run batch boundary and performance measurements**

Add and run a release-mode Rust measurement that imports 128 small valid images in one batch, verifies one history entry, Undo/Redo, and reports prepare/publish/commit time. Also run exact 64 MiB acceptance and 64 MiB + 1 byte rejection without leaving rows or files.

Run: `cargo test --release --manifest-path src-tauri/Cargo.toml notes_attachment_batch_performance -- --ignored --nocapture`

Expected: valid batches remain bounded by the one 64 MiB budget and complete without deadlock; over-limit input fails before publication.

- [x] **Step 3: Dispatch an adversarial requirements reviewer and a code-quality reviewer**

The requirements reviewer must inspect all success criteria, all-or-nothing filesystem/DB behavior, one history entry, native drag lifecycle, clipboard fallback, and permission scope. The code-quality reviewer must inspect raw envelope arithmetic, memory lifetime, symlink/path checks, cleanup of shared hashes, listener races, object URL lifecycle, and test blind spots. Do not apply a finding until it is reproduced or confirmed against the approved spec.

- [x] **Step 4: Fix valid findings and rerun the affected review and tests**

For every accepted finding: add a failing regression test, confirm it fails, implement the smallest fix, run focused tests, then rerun the reviewer that raised it. Record rejected findings with a short technical reason.

- [x] **Step 5: Verify the real Tauri app and document evidence**

Run: `npm run tauri:dev`

In the real macOS window verify: picker opens without a capability error; multiple selected images retain returned order; Finder drag shows target highlight and dashed placeholder on rows and zoomed page headers; leaving clears preview; dropping several images shows all; copying several images and pressing `Cmd+V` shows all; one `Cmd+Z` removes the batch and `Cmd+Shift+Z` restores it; text paste, resize, delete, export, Trash, and existing bullet drag still work. Capture desktop and narrow-window screenshots and record the paths in the report.

- [x] **Step 6: Commit verified fixes and report**

```bash
git add docs/superpowers/reports/2026-07-12-notes-multi-image-ingest-verification.md
git commit -m "test(notes): verify atomic multi-image ingest"
```

Before the commands above, stage each accepted source fix by its exact path as recorded in the report. Do not use a broad `git add -u`. Before committing, compare `git diff --cached --name-only` with the report's accepted-fix allowlist and confirm it does not contain `docs/superpowers/specs/2026-07-12-notes-trash-history-and-library-rename-design.md`.
