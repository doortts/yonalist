# Notes Independent Image Nodes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create every newly inserted image as an independent Notes outline node with an editable description and Workflowy-style image actions, while preserving existing attached images without migration.

**Architecture:** Add an additive `text | image` discriminator to the existing node table and create new image nodes plus their single attachments in one atomic batch command. Reuse the existing outline, history, attachment storage, lazy image loading, and export systems; branch rendering and deletion behavior by node kind. Add a typed app-navigation context for the image Settings action.

**Tech Stack:** React 18, TypeScript 5.7, Vitest 4, Tauri 2.8, Rust 1.77+, rusqlite 0.31, cap-std, image 0.25, SHA-256.

## Global Constraints

- Existing attached images are not migrated, converted, renamed, or moved.
- New picker, Finder drop, and clipboard images create independent `image` nodes only.
- Each new image node owns exactly one attachment and stores its original filename in `title`; `note` is the visible description.
- Multiple images preserve source order, commit all-or-nothing, and share one Undo/Redo history entry.
- Supported formats remain PNG, JPEG, WebP, and GIF; SVG remains rejected.
- Limits remain 20 MiB per image, 64 MiB per batch, 128 images per batch, and 512 active attachments per Vault.
- Text nodes keep their legacy zero-to-many attachment behavior and rendering.
- Image rows reuse standard outline selection, move, indent, outdent, completion, star, trash, restore, duplicate, and zoom behavior.
- `Shift+Enter` on an image row focuses its supporting description.
- The image menu contains Show full-screen, View original, Download, Delete, and Settings.
- Image-node Delete soft-deletes the whole node; legacy image Delete removes only the attachment.
- Settings navigates to and outlines `Notes > Images`; no image preference is added in this phase.
- Keep the existing maximum of eight resident image object URLs and do not load bytes merely to open the menu.
- View-original and download paths are resolved and validated by the Rust backend, never trusted from the frontend.
- Use failing tests before production changes and review each task before continuing.

## File Structure

- `src/domain/notes.ts`: public `NoteNodeKind` and image-node import contracts plus strict validators.
- `src/services/notesAttachmentRawIpc.ts`: versioned raw image-node batch envelope.
- `src/services/notesStore.ts`: Tauri invocation and response validation for image-node import/open/download.
- `src-tauri/src/notes/types.rs`: Rust node-kind and image-node batch wire types.
- `src-tauri/src/notes/repository.rs`: schema v5 migration, row mapping, and kind-aware persistence.
- `src-tauri/src/notes/attachments.rs`: shared image preparation/publication used by legacy and image-node imports.
- `src-tauri/src/notes/history.rs`: audit/replay coverage for node kind and batched image-node creation.
- `src-tauri/src/notes/commands.rs`: path/raw image-node import, open-original, and download commands.
- `src-tauri/src/lib.rs`: Tauri command registration.
- `src/features/notes/imageNodeInsertion.ts`: pure target-to-anchor and ordered-ID construction helpers.
- `src/features/notes/useNotesWorkspace.ts`: picker/drop/paste image-node attempts and retry projection.
- `src/features/notes/NotesImageAttachment.tsx`: reusable image frame, hover menu, full-screen trigger, and resize behavior.
- `src/features/notes/NotesImageMenu.tsx`: accessible image action menu.
- `src/features/notes/NotesImageLightbox.tsx`: in-app full-screen viewer.
- `src/features/notes/NotesAttachmentList.tsx`: legacy attachment compatibility and attachment-only deletion.
- `src/features/notes/OutlineNodeRow.tsx`: kind-aware primary content and image description editing.
- `src/features/notes/NotesPageHeader.tsx`: kind-aware zoomed image rendering.
- `src/features/notes/NotesOutlinePane.tsx`: insertion-target routing without changing drop feedback.
- `src/AppNavigationContext.ts`: typed navigation from Notes to Settings.
- `src/components/SettingsCategoryPane.tsx`: Notes category.
- `src/components/SettingsPage.tsx`: Images target and focus outline.
- `src/App.tsx`: navigation provider and target state.
- `src-tauri/src/notes/export.rs`: kind-aware Markdown/PDF rendering.

---

### Task 1: Node Kind Contract And Schema Migration

**Files:**
- Modify: `src/domain/notes.ts`
- Modify: `src/domain/notes.test.ts`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: Rust tests colocated in `src-tauri/src/notes/types.rs` and `repository.rs`

**Interfaces:**
- Produces: `export type NoteNodeKind = "text" | "image"`
- Produces: required `NoteNode.nodeKind: NoteNodeKind`
- Produces: Rust `NoteNodeKind::{Text, Image}` serialized as `text | image`
- Produces: SQLite schema version 5 with `notes_nodes.node_kind`

- [ ] **Step 1: Add failing TypeScript validator tests**

Add `nodeKind: "text"` to the canonical fixture, assert `image` is accepted,
and assert a missing, inherited, or unknown `nodeKind` is rejected.

- [ ] **Step 2: Run the domain tests and verify the expected failure**

Run: `npm test -- src/domain/notes.test.ts`

Expected: FAIL because `NoteNode` and `isNoteNode` do not know `nodeKind`.

- [ ] **Step 3: Add failing Rust migration and serialization tests**

Create an explicit v4 database containing a text node with two existing
attachments, initialize it, and assert:

```rust
assert_eq!(schema_version(&connection), 5);
assert_eq!(loaded.nodes[0].node_kind, NoteNodeKind::Text);
assert_eq!(loaded.attachments_by_node_id[&node_id], original_attachments);
```

Also assert that inserting a row with `node_kind = 'video'` fails the CHECK.

- [ ] **Step 4: Run the focused Rust tests and verify the expected failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests::schema_v5`

Expected: FAIL because schema version 5 and `node_kind` do not exist.

- [ ] **Step 5: Implement the smallest complete kind contract**

Add the enum/type, update `NOTE_NODE_KEYS`, row mapping, audit JSON mapping,
node INSERT/SELECT lists, history snapshots, and every canonical test fixture.
Use `DEFAULT 'text'`; do not inspect attachment rows during migration.

- [ ] **Step 6: Run focused and compatibility tests**

Run: `npm test -- src/domain/notes.test.ts src/features/notes/notesWorkspaceReducer.test.ts && cargo test --manifest-path src-tauri/Cargo.toml notes::repository notes::types notes::history`

Expected: PASS with existing attachment rows unchanged.

- [ ] **Step 7: Review Task 1**

Review the diff specifically for exact-key payload compatibility, every SQL
projection, history audit serialization, and accidental legacy migration.

---

### Task 2: Atomic Image-Node Batch Import

**Files:**
- Modify: `src/domain/notes.ts`
- Modify: `src/services/notesAttachmentRawIpc.ts`
- Modify: `src/services/notesAttachmentRawIpc.test.ts`
- Modify: `src/services/notesStore.ts`
- Modify: `src/services/notesStore.tauri.test.ts`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/attachment_ingest.rs`
- Modify: `src-tauri/src/notes/attachments.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `ImportImageNodePathsInput` and `ImportImageNodeBytesInput`
- Produces: `NotesStore.importImageNodePaths(...)`
- Produces: `NotesStore.importImageNodeBytes(...)`
- Produces: Tauri commands `notes_import_image_node_paths_batch` and `notes_import_image_node_bytes`
- Returns: `NotesMutationResult.importedRootIds` in source order

- [ ] **Step 1: Add failing domain and raw-envelope tests**

Define inputs with one shared `{ parentId, afterId, initialMaxDisplayWidth }`
and ordered items containing stable `nodeId` and `attachmentId`. Extend the raw
metadata version rather than silently reinterpreting the legacy envelope.
Assert zero items, duplicate IDs, invalid anchors, non-contiguous ordinals,
oversized batches, and metadata/body length mismatches are rejected.

- [ ] **Step 2: Verify raw and store tests fail for missing APIs**

Run: `npm test -- src/services/notesAttachmentRawIpc.test.ts src/services/notesStore.tauri.test.ts`

Expected: FAIL because image-node contracts and commands do not exist.

- [ ] **Step 3: Add failing Rust success, rollback, and history tests**

Cover path and raw input with two images. Assert both nodes are `Image`, each
owns one attachment, titles equal original filenames, notes are empty, order is
contiguous, and one `history_entry_id` is returned. Inject a bad second image,
asset-publication failure, and transaction failure; assert no partial nodes,
attachments, history, or owned orphan file remains. Undo and Redo must remove
and restore both nodes together.

- [ ] **Step 4: Run focused Rust tests and verify feature-missing failures**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests::image_node_batch`

Expected: FAIL because image-node batch commands are absent.

- [ ] **Step 5: Implement shared preparation and one transaction**

Reuse the current decoded-image validation and content-addressed publication.
Prepare every item before opening the write transaction. Validate that
`afterId` is null or an active child of `parentId`. Insert the first node at the
anchor and each next node after the previous inserted node. Insert exactly one
attachment per new node, finalize one history entry, commit once, and reuse the
current reconciliation marker cleanup on failure.

- [ ] **Step 6: Implement TypeScript invocation and response validation**

Path input uses JSON IPC. Byte input uses the new versioned raw envelope. Both
must pass the same stable IDs and history context and validate
`importedRootIds.length === items.length` before projecting success.

- [ ] **Step 7: Run Task 2 suites**

Run: `npm test -- src/services/notesAttachmentRawIpc.test.ts src/services/notesStore.tauri.test.ts && cargo test --manifest-path src-tauri/Cargo.toml notes::commands notes::attachments notes::history`

Expected: PASS, including failure injection and Undo/Redo.

- [ ] **Step 8: Review Task 2**

Review transaction boundaries, retry identity, source order, dedup cleanup,
history grouping, depth/anchor validation, and absence of any legacy rewrite.

---

### Task 3: Route Picker, Finder Drop, And Clipboard To Image Nodes

**Files:**
- Create: `src/features/notes/imageNodeInsertion.ts`
- Create: `src/features/notes/imageNodeInsertion.test.ts`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/features/notes/useNotesWorkspace.test.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/NotesAttachmentIngest.test.tsx`
- Modify: `src/features/notes/notesAttachmentTargets.ts`
- Modify: `src/features/notes/notesAttachmentTargets.test.ts`

**Interfaces:**
- Produces: `imageNodeInsertionAnchor(state, targetId): ImageNodeInsertionAnchor`
- Produces: `actions.importDroppedImagePaths(targetId, paths)` backed by image-node import
- Produces: `actions.importClipboardImages(targetId, items)` backed by image-node import
- Changes: `actions.uploadImage(targetId)` creates image nodes

- [ ] **Step 1: Add failing pure placement tests**

Assert a normal row maps to `{ parentId: row.parentId, afterId: row.id }`, a
zoomed page header maps to `{ parentId: page.id, afterId: null }`, deleted or
archived targets are rejected, and generated node/attachment IDs preserve item
order across retries.

- [ ] **Step 2: Run placement tests and verify failure**

Run: `npm test -- src/features/notes/imageNodeInsertion.test.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Add failing hook and integration tests**

For picker, Finder drop, and clipboard, assert one call to the corresponding
image-node store API, a shared insertion anchor, one stable ID pair per item,
source order, one history context, retry reusing IDs/context, and first imported
node focus. Assert the old attachment import APIs are not called for new input.

- [ ] **Step 4: Verify the integration tests fail for old attachment calls**

Run: `npm test -- src/features/notes/useNotesWorkspace.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx`

Expected: FAIL because new input still attaches to the target text node.

- [ ] **Step 5: Implement routing without changing drag visuals**

Derive an insertion anchor at action start, create stable IDs once per attempt,
and reuse the existing retry attempt object. Keep the filename cursor badge and
thin outlined drop marker unchanged. Clear preview on leave, drop, success,
failure, unmount, and feature hide as before.

- [ ] **Step 6: Run Task 3 suites**

Run: `npm test -- src/features/notes/imageNodeInsertion.test.ts src/features/notes/notesAttachmentTargets.test.ts src/features/notes/useNotesWorkspace.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx`

Expected: PASS for picker, Finder, clipboard, retry, and cleanup paths.

- [ ] **Step 7: Review Task 3**

Review row/header anchor semantics, stable retry IDs, no double paste import,
read-only modes, drop-preview cleanup, and first-node focus.

---

### Task 4: Render First-Class Image Rows And Descriptions

**Files:**
- Modify: `src/features/notes/NotesImageAttachment.tsx`
- Modify: `src/features/notes/NotesImageAttachment.test.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPageHeader.tsx`
- Modify: `src/features/notes/OutlineNodeRow.test.tsx` if present, otherwise `NotesWorkspace.test.tsx`
- Modify: `src/features/notes/NotesPageHeader.test.tsx`
- Modify: `src/features/notes/outlineKeyboard.ts`
- Modify: `src/features/notes/outlineKeyboard.test.ts`
- Modify: Notes styles in the existing Notes stylesheet

**Interfaces:**
- Adds: `NotesImageAttachment.embedded` rendering for image-node primary content
- Adds: image-content focus callback that invokes the row's existing `openAndFocusNote`

- [ ] **Step 1: Add failing row and page-header rendering tests**

Assert an image node renders its single image in the title/content slot, does
not render the filename as visible title text, retains standard bullet/menu and
child controls, and renders `Image unavailable` if the attachment is absent.
Assert a text node with legacy attachments renders exactly as before.

- [ ] **Step 2: Add failing keyboard tests**

Focus image primary content, send `Shift+Enter`, and assert the description
textarea appears and receives focus. Assert Enter creates a text sibling and
Tab/Shift+Tab use existing structural commands without editing the hidden
filename.

- [ ] **Step 3: Run focused tests and verify old rendering fails**

Run: `npm test -- src/features/notes/NotesImageAttachment.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/outlineKeyboard.test.ts src/features/notes/NotesWorkspace.test.tsx`

Expected: FAIL because every node currently renders a title editor first.

- [ ] **Step 4: Implement kind-aware primary content**

Branch only at the primary-content boundary. Keep selection, drag handles,
guides, menu slot, draft persistence, date/tag note behavior, and row memo
inputs shared. Render `NotesAttachmentList` only for text nodes; render the
single owned attachment through `NotesImageAttachment` for image nodes.

- [ ] **Step 5: Implement image description focus**

Make the image content keyboard focusable with an accessible filename label.
Route `Shift+Enter` to the existing note-opening method and preserve history
shortcut handling. Do not make hover or focus load bytes beyond the current
residency behavior.

- [ ] **Step 6: Run Task 4 suites and memoization tests**

Run: `npm test -- src/features/notes/NotesImageAttachment.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/outlineKeyboard.test.ts src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesAttachmentList.test.tsx src/features/notes/notesExpansion.performance.test.ts`

Expected: PASS with legacy and image-node rendering covered.

- [ ] **Step 7: Review Task 4**

Review keyboard parity, missing-attachment recovery, zoom behavior, visible
filename duplication, memoization, and legacy attachment layout.

---

### Task 5: Image Hover Menu, Full-Screen, Original, Download, And Delete

**Files:**
- Create: `src/features/notes/NotesImageMenu.tsx`
- Create: `src/features/notes/NotesImageMenu.test.tsx`
- Create: `src/features/notes/NotesImageLightbox.tsx`
- Create: `src/features/notes/NotesImageLightbox.test.tsx`
- Modify: `src/features/notes/NotesImageAttachment.tsx`
- Modify: `src/features/notes/NotesImageAttachment.test.tsx`
- Modify: `src/features/notes/NotesAttachmentList.tsx`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/domain/notes.ts`
- Modify: `src/services/notesStore.ts`
- Modify: `src/services/notesStore.tauri.test.ts`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: Notes styles in the existing Notes stylesheet

**Interfaces:**
- Adds: `NotesStore.openAttachmentOriginal(vaultPath, attachmentId)`
- Adds: `NotesStore.downloadAttachment(vaultPath, attachmentId, destinationPath)`
- Adds: image action callbacks to `NotesImageAttachment`

- [ ] **Step 1: Add failing menu and lightbox tests**

Assert the ellipsis is exposed on hover/focus, coarse-pointer reachability,
keyboard navigation, Escape/outside close, and labels for all five commands.
Assert Show full-screen and double-click open a contained modal that closes by
Escape and button without creating an additional byte read.

- [ ] **Step 2: Add failing delete-semantics tests**

For an image node, confirm Delete and assert `softDeleteNode(nodeId)`. For a
legacy attachment, confirm Delete and assert `removeAttachment(attachmentId)`.
Cancel must call neither action.

- [ ] **Step 3: Add failing backend path-security tests**

Assert open/download succeeds for a current owned attachment and rejects an
unknown ID, removed attachment, another Vault's attachment, symlink escape,
tampered relative path, and non-file destination. Assert save cancellation in
the frontend is a no-op.

- [ ] **Step 4: Run focused tests and verify missing-action failures**

Run: `npm test -- src/features/notes/NotesImageMenu.test.tsx src/features/notes/NotesImageLightbox.test.tsx src/features/notes/NotesImageAttachment.test.tsx src/services/notesStore.tauri.test.ts && cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests::attachment_open_download`

Expected: FAIL because the menu, modal, and backend commands do not exist.

- [ ] **Step 5: Implement menu and lightbox**

Use existing menu/dialog primitives and lucide icons. Position the menu trigger
at the image frame's upper-right and reserve resize-handle hit space. Stop
pointer events from starting row drag. Reuse the loaded object URL in the modal
and release modal-owned resources on close.

- [ ] **Step 6: Implement validated original and download commands**

Resolve the attachment through the existing repository and asset-root lease,
canonicalize and verify the owned path, then call `open::that` for original.
Download copies through a destination sibling temp file, fsyncs, and atomically
renames after the Save dialog's overwrite confirmation.

- [ ] **Step 7: Run Task 5 suites**

Run: `npm test -- src/features/notes/NotesImageMenu.test.tsx src/features/notes/NotesImageLightbox.test.tsx src/features/notes/NotesImageAttachment.test.tsx src/features/notes/NotesAttachmentList.test.tsx src/services/notesStore.tauri.test.ts && cargo test --manifest-path src-tauri/Cargo.toml notes::commands notes::attachments`

Expected: PASS including security and delete branching.

- [ ] **Step 8: Review Task 5**

Review focus trapping, object-URL ownership, menu/resize hit targets, delete
branching, path traversal/symlink defenses, overwrite behavior, and read-only
mode.

---

### Task 6: Settings Navigation To Notes Images

**Files:**
- Create: `src/AppNavigationContext.ts`
- Create: `src/AppNavigationContext.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/SettingsCategoryPane.tsx`
- Modify: `src/components/SettingsCategoryPane.test.tsx`
- Modify: `src/components/SettingsPage.tsx`
- Modify: `src/components/SettingsPage.test.tsx`
- Modify: `src/features/notes/NotesFeature.tsx`
- Modify: image menu integration tests
- Modify: settings styles in the existing stylesheet

**Interfaces:**
- Produces: `SettingsSection` value `notes`
- Produces: `SettingsTarget` value `images`
- Produces: `AppNavigation.openSettings("notes", "images")`

- [ ] **Step 1: Add failing navigation and settings tests**

Assert the Settings category includes Notes, the Notes page contains a
focusable Images section, and `openSettings("notes", "images")` activates
Settings, scrolls/focuses that section, and applies the target outline. Assert
ordinary manual Notes-category navigation does not leave a stale outline.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- src/AppNavigationContext.test.tsx src/components/SettingsCategoryPane.test.tsx src/components/SettingsPage.test.tsx src/features/notes/NotesImageMenu.test.tsx`

Expected: FAIL because Notes settings and app navigation context do not exist.

- [ ] **Step 3: Implement typed navigation and one-shot target consumption**

Wrap the feature host with `AppNavigationContext`. Store section and optional
target in `App`, pass the target to `SettingsPage`, consume it after focus and
scroll, and clear it when another section is selected. The Images section is a
plain outlined settings section with a heading and no controls.

- [ ] **Step 4: Wire the image menu Settings action**

Call `openSettings("notes", "images")`; do not emit a custom window event and
do not couple Notes to App state setters.

- [ ] **Step 5: Run Task 6 suites**

Run: `npm test -- src/AppNavigationContext.test.tsx src/components/SettingsCategoryPane.test.tsx src/components/SettingsPage.test.tsx src/features/notes/NotesImageMenu.test.tsx`

Expected: PASS with focus and stale-target cleanup assertions.

- [ ] **Step 6: Review Task 6**

Review provider placement, plugin isolation, focus timing, stale targets,
accessibility, and absence of unrelated Settings state changes.

---

### Task 7: Search, Export, Lifecycle, And Performance Compatibility

**Files:**
- Modify: `src-tauri/src/notes/export.rs`
- Modify: export tests colocated in `src-tauri/src/notes/export.rs`
- Modify: search/repository/history tests as required
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src/features/notes/notesExpansion.performance.test.ts`
- Create: `docs/superpowers/reports/2026-07-14-independent-image-nodes-verification.md`

**Interfaces:**
- Consumes: `NoteNode.nodeKind`, one image-node attachment, and existing export snapshot structures
- Produces: kind-aware Markdown/PDF output without duplicate visible filename

- [ ] **Step 1: Add failing export and search tests**

Assert Markdown and PDF place an image-node image at the node position and its
description beneath it without a duplicate visible filename title. Assert
legacy text-node attachments retain existing filename captions. Assert filename
search matches `title` and tag/date search matches image-node `note`.

- [ ] **Step 2: Add failing lifecycle and performance tests**

Assert duplicate/trash/restore preserve node kind and attachment ownership,
purge cleans image-node assets only when history permits, and a menu open does
not increase attachment byte reads. Run a 10,000-node text outline projection
and a mixed image outline residency test capped at eight object URLs.

- [ ] **Step 3: Run focused suites and verify kind-aware failures**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes::export notes::repository notes::history && npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/notesExpansion.performance.test.ts src/features/notes/NotesAttachmentList.test.tsx`

Expected: FAIL only where export/lifecycle output is not yet kind-aware.

- [ ] **Step 4: Implement minimal kind-aware export and lifecycle fixes**

Branch export presentation by node kind while retaining the same attachment
hydration, validation, and budgets. Do not introduce a second asset loader or
change search indexing; use the stored filename title and description note.

- [ ] **Step 5: Run complete automated verification**

Run: `npm test && npm run lint && npm run build && cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all tests pass, lint reports zero errors, TypeScript/Vite build exits
zero, and the full Rust suite exits zero.

- [ ] **Step 6: Run functional and visual verification**

Start the Tauri app. Exercise single/multiple picker, Finder drop, clipboard,
description, move/indent, Undo/Redo, menu actions, Settings target, text legacy
attachments, zoomed image pages, light/dark themes, and narrow/wide viewports.
Capture screenshots for normal, hover-menu, full-screen, and Settings states.

- [ ] **Step 7: Run performance verification**

Record the 10,000-node projection test duration, mixed-image residency count,
menu byte-read count, and multi-image batch import timing in the verification
report. Compare against the existing performance thresholds; investigate any
regression before completion.

- [ ] **Step 8: Perform adversarial whole-change review**

Review the complete diff against the design spec with emphasis on no migration,
atomicity, history, path security, legacy rendering, keyboard focus, resource
cleanup, export parity, and performance. Fix every Critical or Important
finding, rerun covering tests, and request a second review.

- [ ] **Step 9: Final verification report**

Write exact commands, pass counts, manual scenarios, screenshots, performance
measurements, remaining deferred items, and any residual risk to
`docs/superpowers/reports/2026-07-14-independent-image-nodes-verification.md`.

