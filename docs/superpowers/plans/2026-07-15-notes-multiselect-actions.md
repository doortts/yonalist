<!-- reconciliation: auditedHead=ec8a9ff3d016449255992adf70e128ea5e222e9a status=complete -->
> **증거 대조 상태 (2026-07-19): 완료.** commit·artifact 근거는 [감사 보고서](../reports/2026-07-19-historical-plan-reconciliation.md)에 기록했다.

# Notes Multi-Select Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved first-release multi-select actions and atomic batch tag editing to the Notes outline, with one consistent behavior across keyboard, toolbar, row menus, drag, and Move To.

**Architecture:** Extend the existing typed `notes_apply_batch` boundary for duplicate and tag mutations, keeping each mutation in one SQLite transaction and one undoable history entry. On the frontend, derive an immutable selection snapshot with pure helpers, route every selected-range entry point through one pane-owned semantic command router, and render a contextual action bar plus focused move/tag choosers. Clipboard formatting and environment access remain isolated pure/adapted units so Cut can prove clipboard success before issuing one atomic delete.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Tauri 2, Rust, rusqlite/SQLite, existing Notes workspace coordinator and history system.

## Global Constraints

- Follow the approved design in `docs/superpowers/specs/2026-07-15-notes-multiselect-actions-design.md`; do not add Archive, star, date editing, formatting, mirrors, node types, boards, calendars, or selected-range export.
- Use strict RED/GREEN/REFACTOR for every behavior change: add a focused failing test, run it and record the expected failure, implement the minimum behavior, then run the focused test and nearby regressions.
- Keyboard, contextual toolbar, a menu opened on a selected row, drag, and Move To must resolve the same frozen target IDs through the semantic selection router. Never issue repeated single-node mutations for one selected-range action.
- Every successful backend mutation must be one transaction, one history entry, and one Undo. No-op batches create no history entry. Any validation, attachment-capacity, index-rebuild, or history-size failure rolls the entire mutation back.
- Flush pending title/supporting-note drafts before reading clipboard content, computing current completion direction, or submitting a mutation.
- Preserve the original selection while a command is pending and on failure. Preserve it after complete, tag, indent, outdent, reorder, drag, Move To, and Copy; replace it with the copied forest after Duplicate; clear it after Delete/Cut and focus the next survivor, falling back to the previous survivor.
- A frozen chooser/clipboard snapshot becomes a safe no-op when vault, scope, workspace generation, or target ownership changes. It must never retarget the current selection.
- Structural actions operate on normalized selected forest roots. Complete and tag operations affect every explicitly selected visible row, not implicit descendants.
- Copy is non-destructive and title-only. Cut remains disabled for any selected subtree containing a non-empty supporting note, attachment, or embedded title newline.
- Keep native non-collapsed textarea copy/cut behavior ahead of outline clipboard shortcuts. Ignore relevant structural and clipboard shortcuts during IME composition and key repeat.
- Keep existing image-paste precedence, row memoization guarantees, zoom/hidden-target guards, and Archive/Trash/loading/data-deletion mutation guards.
- Do not change the database schema or introduce a new Tauri command.
- Keep production modules focused; place selection algebra, clipboard serialization, clipboard environment access, move chooser, tag chooser, action bar, and router in the dedicated files named by the design.
- Commit each completed task separately only after its task review passes. Do not merge the feature branch without explicit user direction.

---

### Task 1: Typed batch contract, input limits, and undo-size safety

**Files:**
- Modify: `src/domain/notes.ts`
- Modify: `src/domain/notes.test.ts`
- Modify: `src/services/notesStore.ts`
- Modify: `src/services/notesStore.tauri.test.ts`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/history.rs`
- Modify: `src-tauri/src/notes/repository.rs` (temporary exhaustive rejection only)

**Interfaces:**
- Consumes: existing `ApplyNotesBatchInput`, `ApplyBatchWire`, `NotesMutationResult`, history finalization, and canonical `NoteSearchTag` / `NoteTagFilter` wire types.
- Produces: `duplicate`, `addTag`, and `removeTag` batch variants; optional `duplicatedRootIds`; a 10,000-ID limit; and transaction failure when a newly-created single history entry exceeds 50 MiB.
- Does not yet implement repository behavior for the new variants; later tasks provide that behavior. Add explicit temporary match arms that reject each new operation before mutation so the intermediate commit compiles and cannot silently perform a partial action.

- [x] **Step 1: Add failing TypeScript wire-contract tests**

Add focused tests proving the three new discriminated union shapes serialize without key drift, `duplicatedRootIds` is optional and preserved by the mutation-result boundary, and 10,001 IDs are rejected before invoke while exactly 10,000 remain valid.

- [x] **Step 2: Run the TypeScript contract tests and verify RED**

Run:

```bash
npm test -- src/domain/notes.test.ts src/services/notesStore.tauri.test.ts
```

Expected: failures show the new operations/result field and batch-size validation are absent.

- [x] **Step 3: Add failing Rust wire and oversized-history tests**

In `types.rs`, cover exact camelCase JSON for all variants, canonical tag validation, empty/duplicate/invalid IDs, the 10,000 boundary, and unknown-field rejection. In `history.rs`, create a mutation whose one new history payload exceeds 50 MiB and assert that finalization returns an error while nodes, derived rows, and history remain unchanged.

- [x] **Step 4: Run the focused Rust tests and verify RED**

Run:

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml notes::types::tests::apply_batch
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests::notes_history_rejects_oversized_single_entry
```

Expected: the wire variants/limit do not compile or deserialize yet, and the history test demonstrates the oversized entry is pruned instead of rejecting the transaction.

- [x] **Step 5: Implement the shared typed contract and boundary validation**

Extend both TypeScript and Rust unions using the existing canonical tag types. Deduplicate IDs without reordering, reject zero or more than 10,000 submitted IDs, keep strict unknown-field validation, and add optional `duplicatedRootIds` to every mapping/unwrapping layer without fabricating an empty array.

- [x] **Step 6: Make history finalization reject an oversized new entry atomically**

Before ordinary retention pruning can remove the just-created entry, measure that entry with the existing payload accounting. Return a typed mutation error when it alone exceeds 50 MiB so the surrounding transaction rolls back. Preserve the existing global entry-count and aggregate-size pruning behavior for older entries.

- [x] **Step 7: Run focused GREEN and nearby regressions**

Run:

```bash
npm test -- src/domain/notes.test.ts src/services/notesStore.tauri.test.ts
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml notes::types::tests
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests
git diff --check
```

Expected: all focused tests pass, existing batch shapes remain byte-compatible, and ordinary history eviction tests remain green.

---

### Task 2: Atomic batch subtree duplication

**Files:**
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/notes/history.rs` (tests only unless a shared replay fix is required)
- Modify: `src-tauri/src/notes/types.rs` (result plumbing only if needed)

**Interfaces:**
- Consumes: `BatchOp::Duplicate`, existing single-subtree duplicate logic, selection-root normalization, dated mutation execution, attachment limits, and history replay.
- Produces: one atomic duplicate of normalized same-parent roots, contiguous placement after the final original, fresh node/attachment IDs, and `duplicatedRootIds` in source order.

- [x] **Step 1: Add failing repository duplicate tests**

Cover parent+selected-child normalization, multiple same-parent roots, source-order preservation, exact placement `A,B,C -> A,B,A',B',C`, deep subtree state/content copying, mixed-parent rejection, deleted/archived/cross-vault rejection, and rollback after an injected later-root/index failure.

- [x] **Step 2: Add failing attachment-capacity tests for single and batch duplicate**

Build fixtures at the 512 persisted-attachment boundary. Assert duplicate preflights the total metadata rows before any insert, shares content paths/hashes without copying bytes, assigns fresh attachment IDs, and leaves nodes/attachments/history unchanged on overflow.

- [x] **Step 3: Run the repository tests and verify RED**

Run:

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests::batch_duplicate
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests::duplicate_node_rejects_attachment_vault_overflow
```

Expected: batch duplicate is unimplemented and the single duplicate path lacks the vault-wide preflight.

- [x] **Step 4: Extract one transaction-level forest-copy helper**

Refactor the existing single duplicate implementation so single and batch paths share validation, iterative subtree copying, derived-index rebuild, attachment metadata copying, and capacity preflight. Normalize submitted roots, require one parent, compute capacity for the full copied forest, and reserve a contiguous root block after the last selected original.

- [x] **Step 5: Add failing command/history tests**

At the command boundary, assert the dated batch path returns ordered `duplicatedRootIds`, produces one history entry, Undo removes the entire copied forest, Redo restores the identical IDs/content/placement, a zero-change case creates no entry, and any later-root failure leaves no partial copies.

- [x] **Step 6: Run the command tests and verify RED**

Run:

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests::batch_duplicate
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests::notes_history_replays_batch_duplicate
```

Expected: the command either rejects the new operation or omits copied-root IDs/atomic replay.

- [x] **Step 7: Wire duplicate through the dated batch command path**

Execute the repository helper inside the same transaction/history context used by other batch operations, capture copied root IDs for the result, and retain authoritative backend revalidation even when the frontend previously deemed the selection eligible.

- [x] **Step 8: Run focused GREEN and all existing duplicate regressions**

Run:

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml duplicate
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml batch_
git diff --check
```

Expected: all new and existing single/batch duplicate, attachment, rollback, and history tests pass.

---

### Task 3: Atomic exact-token batch tag add/remove

**Files:**
- Modify: `src-tauri/src/notes/tags.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/notes/types.rs` (validation plumbing only if needed)

**Interfaces:**
- Consumes: `BatchOp::AddTag` / `BatchOp::RemoveTag`, canonical tokenizer, title/note update and derived tag/date/search rebuild paths.
- Produces: idempotent exact normalized tag add/remove across explicitly submitted nodes in one dated transaction and one undo entry.

- [x] **Step 1: Add failing byte-safe tag span/removal tests**

Cover `#` versus `@`, case folding, NFC/decomposed identity, Korean/Unicode, punctuation, multiple occurrences, other-prefix and substring non-matches, URL-fragment exclusion, adjacent ASCII-space cleanup, tabs/newlines preservation, and UTF-8 byte safety. Assert every exact occurrence is removed from both title and note.

- [x] **Step 2: Run tokenizer/helper tests and verify RED**

Run:

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml notes::tags::tests::batch_tag
```

Expected: no public byte-span mutation helper implements the approved cleanup rules.

- [x] **Step 3: Implement canonical tag mutation helpers**

Use tokenizer-produced semantic identity but compute safe Rust byte ranges; never apply UTF-16 offsets as UTF-8 indexes. Add appends exactly one display token to the title with one ASCII separator only when neither title nor note contains the normalized exact token. Remove deletes every exact occurrence, preferring one preceding ASCII space and otherwise one following ASCII space.

- [x] **Step 4: Add failing repository/command/history tests**

Cover multi-node add/remove, explicitly selected rows only, duplicate-input deduplication, idempotent no-op behavior, title and supporting-note changes, derived tag/date/FTS rebuild, one undo/redo entry, and all-or-nothing rollback after a later-node failure.

- [x] **Step 5: Run repository/command tests and verify RED**

Run:

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests::batch_tag
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests::batch_tag
```

Expected: the new batch variants do not mutate content or rebuild all indexes yet.

- [x] **Step 6: Implement dated atomic tag batches**

Validate every target before writes, mutate title/note through the repository's shared content/index path, return no history delta when all rows are already in the requested state, and execute through the local-date-aware command path. Preserve exact submitted display spelling for Add while using normalized identity for matching.

- [x] **Step 7: Run focused GREEN and tag/date/search regressions**

Run:

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml notes::tags::tests
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml batch_tag
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml notes_date_and_tag
git diff --check
```

Expected: all exact-token, transaction, derived-index, no-op, and history cases pass.

---

### Task 4: Pure selection snapshot, eligibility, and keyboard resolution

**Files:**
- Create: `src/features/notes/notesSelectionActions.ts`
- Create: `src/features/notes/notesSelectionActions.test.ts`
- Modify: `src/features/notes/outlineKeyboard.ts`
- Modify: `src/features/notes/outlineKeyboard.test.ts`
- Modify: `src/features/notes/notesMoveTargets.ts`
- Create or modify: `src/features/notes/notesMoveTargets.test.ts`

**Interfaces:**
- Consumes: visible outline rows, `NotesSelection { anchorId, headId }`, confirmed workspace nodes, sibling order, current zoom/scope, and keyboard event facts.
- Produces: immutable selection snapshots, normalized forest roots, completion aggregate, delete focus candidate, cut/duplicate/indent/outdent/reorder eligibility with reasons, excluded move targets, and semantic keyboard intents.

- [x] **Step 1: Add failing table-driven selection-model tests**

Cover forward and reverse anchor/head ranges, missing endpoints, selected ancestor suppression, collapsed descendants, mixed parents, contiguous/non-contiguous sibling roots, `none`/`mixed`/`all` completion, delete next/previous fallback, rich-content Cut rejection, first/last reorder boundaries, and stable source ordering.

- [x] **Step 2: Run selection-model tests and verify RED**

Run:

```bash
npm test -- src/features/notes/notesSelectionActions.test.ts
```

Expected: the new model is absent.

- [x] **Step 3: Implement the pure immutable model**

Return explicit eligibility objects with disabled reasons rather than scattered booleans. Treat completion/tag IDs as every visible selected row, structural IDs as normalized roots, and compute one-step reorder as an existing batch-move target that crosses exactly one unselected sibling.

- [x] **Step 4: Add failing keyboard and move-target tests**

Cover aggregate completion independent of focused-row state, existing duplicate shortcut routing, Cmd/Ctrl+Shift+Up/Down, selection copy/cut intent, native non-collapsed textarea selection precedence, IME/repeat suppression, and exclusion of every selected subtree from Move To/drag destinations.

- [x] **Step 5: Run keyboard/move tests and verify RED**

Run:

```bash
npm test -- src/features/notes/outlineKeyboard.test.ts src/features/notes/notesMoveTargets.test.ts
```

Expected: completion follows the focused row, new shortcuts are absent, or only one subtree is excluded.

- [x] **Step 6: Route keyboard facts to semantic intents**

Keep DOM/environment side effects out of the resolver. Add only intent resolution and target calculation here; later integration invokes the shared router. Preserve existing Shift+Arrow, Escape, Tab/Shift+Tab, delete, editor navigation, and image-paste rules.

- [x] **Step 7: Run focused GREEN and pure outline regressions**

Run:

```bash
npm test -- src/features/notes/notesSelectionActions.test.ts src/features/notes/outlineKeyboard.test.ts src/features/notes/notesMoveTargets.test.ts src/features/notes/outlineDrag.test.ts src/features/notes/outlineTree.test.ts
npm run lint
git diff --check
```

Expected: selection algebra and keyboard/move intent tests pass without React rendering.

---

### Task 5: Deterministic outline clipboard format and safe environment adapter

**Files:**
- Create: `src/features/notes/notesClipboardOutline.ts`
- Create: `src/features/notes/notesClipboardOutline.test.ts`
- Create: `src/features/notes/notesClipboard.ts`
- Create: `src/features/notes/notesClipboard.test.ts`
- Modify: `src/features/notes/notesPasteImport.ts`
- Modify: `src/features/notes/notesPasteImport.test.ts`

**Interfaces:**
- Consumes: frozen selected forest with flushed title overlays and injected clipboard APIs.
- Produces: deterministic Markdown-compatible outline text, native-event and toolbar clipboard writes for `text/plain` plus `text/markdown`, and a paste parser accepting both Markdown list and legacy indented text.

- [x] **Step 1: Add failing serializer and round-trip tests**

Cover multiple roots, full collapsed subtrees, source ordering, two-space depth indentation, empty titles (`-`), Unicode, title newlines according to the approved copy contract, large but bounded forests, and the absence of IDs, timestamps, vault paths, notes, or attachment paths. Assert serialize -> paste parse preserves titles and hierarchy.

- [x] **Step 2: Run format tests and verify RED**

Run:

```bash
npm test -- src/features/notes/notesClipboardOutline.test.ts src/features/notes/notesPasteImport.test.ts
```

Expected: the serializer is absent and the parser rejects Markdown bullets/empty `-` items.

- [x] **Step 3: Implement the pure outline format and parser extension**

Serialize iteratively in deterministic preorder. Extend the current parser without breaking legacy tab/space indentation or image-paste dispatch. Reject malformed mixed indentation consistently and keep parser limits already used for paste imports.

- [x] **Step 4: Add failing clipboard adapter tests**

For native copy/cut events, assert identical text is written to both MIME types. For toolbar actions, assert `ClipboardItem` + `navigator.clipboard.write` is preferred, `writeText` is the fallback, and failure is reported only after both supported paths fail. Verify adapters do not mutate Notes state.

- [x] **Step 5: Run adapter tests and verify RED**

Run:

```bash
npm test -- src/features/notes/notesClipboard.test.ts
```

Expected: no shared environment adapter exists.

- [x] **Step 6: Implement injected clipboard adapters**

Avoid direct global reads in pure format code. Make capability selection explicit and testable, preserve the clipboard event's synchronous `preventDefault`/`setData` requirements, and return typed success/failure for the router's Cut ordering.

- [x] **Step 7: Run focused GREEN and paste/image regressions**

Run:

```bash
npm test -- src/features/notes/notesClipboardOutline.test.ts src/features/notes/notesClipboard.test.ts src/features/notes/notesPasteImport.test.ts src/features/notes/notesClipboardImages.test.ts
npm run lint
git diff --check
```

Expected: text round-trip and both clipboard paths pass while image paste behavior remains unchanged.

---

### Task 6: Shared selected-range command router and selection lifecycle

**Files:**
- Create: `src/features/notes/useNotesSelectionCommandRouter.ts`
- Create: `src/features/notes/useNotesSelectionCommandRouter.test.tsx`
- Modify: `src/features/notes/notesCommands.ts`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/features/notes/useNotesWorkspace.test.tsx`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Modify: `src/features/notes/notesWorkspaceReducer.ts`
- Modify: `src/features/notes/notesWorkspaceReducer.test.ts`

**Interfaces:**
- Consumes: a frozen `NotesSelectionActionSnapshot`, workspace ownership token, draft flush, typed repository batch operations, clipboard adapter, and authoritative mutation projection.
- Produces: one busy-guarded semantic `execute(intent)` path, status/error feedback, duplicate-result selection replacement, deletion focus resolution, and policy-driven pending/success/failure selection behavior.

- [x] **Step 1: Add failing workspace command-contract tests**

Cover `duplicate`, `addTag`, and `removeTag` payload construction/unwrapping; aggregate completion recomputed from confirmed state immediately before execution; structural operations using normalized roots; no command when targets vanished; and all successful calls using one `applyBatch` invocation.

- [x] **Step 2: Run command tests and verify RED**

Run:

```bash
npm test -- src/features/notes/useNotesWorkspace.test.tsx -t "batch|selection"
npm test -- src/features/notes/useNotesSelectionCommandRouter.test.tsx
```

Expected: new operations/router are absent and existing completion direction or selection clearing is inconsistent.

- [x] **Step 3: Add failing selection-lifecycle tests**

Parameterize pending, success, and failure for complete/tag/indent/outdent/reorder/move, Duplicate, Delete, and Cut. Assert preserved anchor/head IDs, copied-forest replacement through the last copied root's final visible descendant, and next/previous survivor focus. Assert invisible endpoints close the range rather than selecting unrelated rows.

- [x] **Step 4: Extend coordinator/workspace policy plumbing**

Generalize the existing indent/outdent `preserveSelection` path into explicit command postconditions without restoring stale selections after settlement. Keep selection live while pending/failing, apply duplicate/delete postconditions only after authoritative projection, and keep default invalidation behavior for unrelated single-row structural commands.

- [x] **Step 5: Add failing frozen-ownership and Cut ordering tests**

Prove chooser/clipboard snapshots no-op after vault/scope/generation change; double activation submits once; draft-flush failure causes no clipboard/database effect; clipboard failure never deletes; successful clipboard write precedes exactly one delete; stale revalidation never deletes; delete failure reports `Copied, but couldn't remove` and keeps selection.

- [x] **Step 6: Implement the pane-owned semantic router**

Centralize target resolution, eligibility recheck, busy state, draft flushing, ownership validation, clipboard sequencing, status/error messages, and invocation of existing workspace commands. Expose narrow callbacks/derived state suitable for the toolbar, row menu, keyboard, drag, and chooser integration; do not place rendering in the hook.

- [x] **Step 7: Run focused GREEN and coordinator regressions**

Run:

```bash
npm test -- src/features/notes/useNotesSelectionCommandRouter.test.tsx src/features/notes/useNotesWorkspace.test.tsx src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesWorkspaceReducer.test.ts
npm run lint
git diff --check
```

Expected: every lifecycle/ordering/ownership case passes and existing queue behavior remains green.

---

### Task 7: Contextual action bar, Move To chooser, and tag chooser

**Files:**
- Create: `src/features/notes/NotesSelectionActionBar.tsx`
- Create: `src/features/notes/NotesSelectionActionBar.test.tsx`
- Create: `src/features/notes/NotesMoveChooser.tsx`
- Create: `src/features/notes/NotesMoveChooser.test.tsx`
- Create: `src/features/notes/NotesTagChooser.tsx`
- Create: `src/features/notes/NotesTagChooser.test.tsx`
- Modify: `src/features/notes/notes.css`

**Interfaces:**
- Consumes: selection count/aggregate/eligibility, router callbacks/status, full-workspace move targets, current selected tag union, and frozen chooser ownership.
- Produces: an accessible responsive `role="toolbar"`, roving focus, F6 focus target, explicit Add/Remove tag flows, and searchable destination/tag choices.

- [x] **Step 1: Add failing action-bar accessibility/behavior tests**

Cover accessible selected-count naming, Complete/Uncomplete label from aggregate, Clear, Move To, Tags, Delete ordering, disabled reasons, busy single-submit guard, one polite status/error region, roving Left/Right/Home/End, Escape, and Shift+F6 return callback.

- [x] **Step 2: Add failing responsive overflow tests**

At widths above 720 px assert Up/Down/Indent/Outdent/Duplicate are direct and More contains Copy/Cut. At or below 720 px assert those structural actions move into More. Keep actions present and accessible rather than conditionally unreachable.

- [x] **Step 3: Run action-bar tests and verify RED**

Run:

```bash
npm test -- src/features/notes/NotesSelectionActionBar.test.tsx
```

Expected: the contextual toolbar is absent.

- [x] **Step 4: Implement the action bar and responsive styles**

Use semantic buttons/menu controls, one roving tab stop, CSS media rules at 720 px, and explicit disabled explanations. Keep layout stable and avoid coupling action availability to component-local selection calculations.

- [x] **Step 5: Add failing Move To and tag chooser tests**

Move To: exclude all selected subtrees, search full workspace, support Enter/Escape/loading/focus return, and freeze targets. Tags: explicit Add/Remove modes; Add accepts exactly one canonical `#`/`@` token with suggestions; Remove lists/searches the selected rows' exact tag union; both freeze IDs and report validation errors without closing.

- [x] **Step 6: Run chooser tests and verify RED**

Run:

```bash
npm test -- src/features/notes/NotesMoveChooser.test.tsx src/features/notes/NotesTagChooser.test.tsx
```

Expected: reusable choosers with the approved frozen-selection behavior do not exist.

- [x] **Step 7: Implement both focused choosers**

Keep mutation submission in the router. Choosers own only search/mode/focus presentation and return the frozen semantic choice. Reuse existing canonical tag parsing and move-target data rather than duplicating token/tree rules.

- [x] **Step 8: Run focused GREEN, accessibility, and style checks**

Run:

```bash
npm test -- src/features/notes/NotesSelectionActionBar.test.tsx src/features/notes/NotesMoveChooser.test.tsx src/features/notes/NotesTagChooser.test.tsx
npm run lint
git diff --check
```

Expected: desktop/narrow action placement, focus, chooser validation, and status behavior all pass.

---

### Task 8: Integrate every multi-select entry point and close parity regressions

**Files:**
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesBulletMenu.tsx`
- Modify: `src/features/notes/NotesBulletMenu.test.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src/features/notes/NotesFeature.test.tsx` (only if the sticky-toolbar swap is covered here)
- Modify: `src/features/notes/outlineRowMemo.test.tsx`
- Modify: `src/features/notes/outlineDrag.ts`
- Modify: `src/features/notes/outlineDrag.test.ts`
- Modify: `src/features/notes/notes.css` (integration selectors only)

**Interfaces:**
- Consumes: selection model, shared router, action bar/choosers, row menu, keyboard resolver, drag resolver, and existing normal sticky toolbar.
- Produces: identical target IDs and postconditions from keyboard, action bar, selected-row menu, drag, and Move To in the rendered Notes workspace.

- [x] **Step 1: Add failing parameterized entry-point parity tests**

For Complete, Delete, Duplicate, Indent/Outdent, Up/Down, Move To, and tags where applicable, activate keyboard/bar/selected-row menu/drag paths and assert the same one `applyBatch` payload and target ordering. Assert a menu on an unselected row clears the range and targets only that row.

- [x] **Step 2: Add failing drag and move safety regressions**

Prove dragging a selected row moves the whole normalized range, a destination inside any selected subtree is announced as an invalid no-op, and an invalid selected drop never falls back to moving only the dragged row. Verify Move To excludes the same targets.

- [x] **Step 3: Run rendered parity tests and verify RED**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "multi-select action parity|selected drag|selected row menu"
npm test -- src/features/notes/outlineDrag.test.ts
```

Expected: existing row actions still target one node and invalid selected drag falls back to a single move.

- [x] **Step 4: Integrate the shared router and contextual UI**

Mount one router in `NotesOutlinePane`, replace the normal sticky toolbar only while a materializable range exists, pass semantic callbacks to rows/menus/drag/keyboard, and keep row props/memo comparisons stable. Remove direct selected-range mutation paths that bypass the router.

- [x] **Step 5: Add failing rendered clipboard/lifecycle/focus tests**

Cover native text-selection precedence, keyboard copy/cut MIME data, toolbar clipboard fallback, Cut rich-content disabled reason, clipboard-before-delete, Duplicate copied-forest selection, Delete/Cut survivor focus, selection retention for non-destructive mutations, failure preservation, F6/Shift+F6, Escape, and active-filter endpoint disappearance.

- [x] **Step 6: Run the rendered tests and verify RED**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "multi-select clipboard|selection action bar|batch tag|batch duplicate|surviving focus"
```

Expected: at least one integration contract is still unwired.

- [x] **Step 7: Complete integration without duplicating semantics**

Wire clipboard events, chooser open/close/focus return, row-menu targeting, responsive toolbar, aggregate completion, and post-settlement focus through the router. Keep ordinary caret navigation, zoom, library/vault changes, editor paste, attachments, and loading guards at their existing boundaries.

- [x] **Step 8: Run focused GREEN and high-risk regressions**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesBulletMenu.test.tsx src/features/notes/outlineDrag.test.ts src/features/notes/outlineKeyboard.test.ts src/features/notes/outlineRowMemo.test.tsx src/features/notes/notesClipboardImages.test.ts
npm run lint
npm run build
git diff --check
```

Expected: all entry points agree, row memo/image paste regressions remain green, and the production build succeeds.

---

### Task 9: Whole-feature verification and release-facing checks

**Files:**
- Modify only focused tests or implementation files required by issues found during review.
- Modify documentation only if shortcut/help text already has an established Notes section that must stay accurate.

**Interfaces:**
- Consumes: the complete branch diff against `426b4bb` and every approved design invariant.
- Produces: a reviewed branch with fresh full-suite evidence and no unresolved Critical or Important findings.

- [x] **Step 1: Generate a whole-branch review package**

Compare the feature branch with the design commit. Have a fresh reviewer check spec coverage, atomicity, history guarantees, attachment limits, exact tag behavior, frozen ownership, selection lifecycle, accessibility, responsive placement, shortcut precedence, drag safety, memoization, and test quality.

- [x] **Step 2: Fix every Critical and Important review finding with RED/GREEN evidence**

For each accepted finding, first add or identify a reproducing failing test, implement the smallest correction, rerun the focused test and nearby regression set, and request a fresh re-review. Do not waive a finding without concrete code/test evidence.

- [x] **Step 3: Run the complete frontend verification from a clean command invocation**

Run:

```bash
npm run lint
npm test
npm run build
```

Expected: lint exits zero, all frontend tests pass with only documented skips, and the production bundle builds successfully.

- [x] **Step 4: Run the complete Rust and repository verification**

Run:

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
git status --short
```

Expected: all Rust tests pass with only documented ignored performance/capacity probes, no whitespace errors exist, and only intended feature commits/files are present.

- [x] **Step 5: Perform the desktop and narrow manual contract pass when the app can be launched**

Verify forward/reverse selection, all direct/overflow actions, action-bar and row-menu parity, Move To exclusions, tag Add/Remove, duplicate placement/selection, clipboard round-trip, safe Cut, invalid drag, Undo/Redo grouping, disabled reasons, F6 focus, Escape, and the 720 px responsive transition. Record any environment limitation explicitly rather than claiming an unperformed manual check.

- [x] **Step 6: Present branch-integration choices without merging automatically**

After all automated gates and review pass, report the branch/worktree and offer exactly these choices: merge locally, push/create a PR, keep the branch, or discard it. Wait for explicit user direction.
