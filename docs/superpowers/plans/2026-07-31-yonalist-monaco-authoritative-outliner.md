# Yonalist Monaco-Authoritative Outliner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the store-authoritative Monaco projection experiment with one page-scoped Monaco model that owns native editing, cursor behavior, and session Undo/Redo while Yonalist persists stable tree metadata asynchronously.

**Architecture:** A page-scoped `MonacoOutlineSession` owns one pure-text Monaco model and a versioned line-to-node metadata timeline shared by both pane editors. A pinned internal Monaco adapter supplies injected-text affinity, hidden ranges, mouse targets, and metadata-only Undo elements; an ordered persistence queue commits atomic editor batches through the existing Rust application and SQLite transaction boundary without echoing model content back into Monaco.

**Tech Stack:** TypeScript 6, React 19, Monaco Editor 0.53.x, Vitest 4, Rust, Tauri 2, ts-rs, SQLite, Cargo test, Rustfmt, Clippy.

## Global Constraints

- Keep `monaco-editor` pinned to 0.53.x while internal ESM APIs are used.
- The Monaco model contains only user title text and newline separators.
- One model line maps to one stable node ID; line number is never identity.
- Bullets and indentation are injected rendering, never persisted prefix text.
- Monaco owns typing, IME, Enter, Backspace, cursor movement, selection, and session Undo/Redo.
- Rust records no duplicate Undo entry for `applyEditorBatch`; a successful editor batch clears incompatible Rust undo and redo stacks.
- Primary and secondary panes share one page model while retaining independent selection, scroll, focus, zoom, and hidden ranges.
- Text edits coalesce for 300 ms; structural edits, blur, navigation, and close flush immediately.
- Retryable persistence failure preserves editable model content; revision conflict preserves content and pauses the queue; fatal failure preserves copy access and blocks structural edits.
- A page session is bounded to 50,000 active text nodes. A page containing image nodes, supporting-note text, or more than 50,000 active nodes uses the React control surface for this slice.
- The existing React outline remains the default without `?outline=monaco`.
- Keep current Yonalist layout, typography, colors, spacing, and interaction visuals unchanged.
- Images, product multi-bullet selection, and drag/drop are excluded from this slice.
- For a 5,000-node page, sampled input-to-paint p95 must be at most 20 ms and sampled core interactions must produce no task over 50 ms.
- Use TDD for every new behavior and commit after each independently passing task.
- Preserve all user changes and stage only the files named by each task.

## Frozen Delivery Contract

| Field | Contract |
| --- | --- |
| Goal | Middle Enter, repeated Enter/Backspace, IME, cursor movement, and Undo/Redo run through Monaco's native model without a store reprojection or visible caret correction. |
| Acceptance | Native middle split caret; empty-line caret beside bullet; stable held keys; stable IDs through Undo/Redo; shared split model; click/Shift+click zoom; durable restart; preserved content on save failure; 5,000-node p95 at most 20 ms. |
| Non-goals | Image editing, Yonalist multi-bullet actions, drag/drop, cross-pane drag/drop, a Monaco fork, new visual design, removal of the React control before acceptance. |
| Boundaries | React host and navigation, Monaco plugin/adapter/session, `NotesStore` persistence bridge, generated IPC contract, `notes-core`, `notes-application`, `notes-sqlite`, Tauri close lifecycle. |
| Manual proof | Fresh isolated Tauri data directory; type Korean; split at start/middle/end; hold Enter and Backspace; Undo/Redo; open split by Shift+bullet; edit both panes; restart and confirm SQLite state; sample 5,000-node input and scroll. |

## File Structure

### New frontend files

| File | Responsibility |
| --- | --- |
| `apps/desktop/src/monaco-outline/internalAdapter.ts` | The only importer of Monaco internal ESM modules; capability probes, hidden ranges, affinity, injected mouse detail, metadata Undo. |
| `apps/desktop/src/monaco-outline/monacoInternal.d.ts` | Narrow declarations for the pinned internal modules used by `internalAdapter.ts`. |
| `apps/desktop/src/monaco-outline/metadata.ts` | Ordered line metadata, node lookup, alternative-version snapshots, depth transitions. |
| `apps/desktop/src/monaco-outline/structuralChanges.ts` | Convert native Monaco content changes into deterministic metadata and IPC editor batches. |
| `apps/desktop/src/monaco-outline/persistenceQueue.ts` | 300 ms text coalescing, immediate structural ordering, retry/conflict/fatal/flush states. |
| `apps/desktop/src/monaco-outline/session.ts` | Canonical model lifecycle, native change listener, metadata timeline, decorations, persistence, Undo restoration. |
| `apps/desktop/src/monaco-outline/sessionRegistry.ts` | Page-keyed session acquisition, reference counting, flush and disposal. |
| `apps/desktop/src/monaco-outline/decorations.ts` | Incremental model decorations for bullets and depth. |
| `apps/desktop/src/monaco-outline/paneAdapter.ts` | Per-editor focus, selection, scroll, zoom, hidden ranges, bullet navigation. |
| `apps/desktop/src/monaco-outline/plugin.ts` | One-time contribution registration, context key, Tab commands, bullet mouse routing, affinity hooks. |
| `apps/desktop/src/monaco-outline/runtimeProbe.ts` | Development-only interaction timing and internal capability evidence. |
| Matching `*.test.ts` files | Focused tests beside each new module. |

### Modified frontend files

| File | Change |
| --- | --- |
| `apps/desktop/src/MonacoOutlineSurface.tsx` | Reduce to a thin React editor host that acquires a shared session and pane adapter. |
| `apps/desktop/src/NotesOutline.tsx` | Pass page/session/pane navigation data and use React fallback for unsupported pages. |
| `apps/desktop/src/NotesDetailPanes.tsx` | Pass the app-owned Monaco session registry to both panes. |
| `apps/desktop/src/App.tsx` | Create the registry, route Undo to focused Monaco, flush sessions on navigation and close. |
| `apps/desktop/src/notesStore.ts` | Expose full editor-page loading and the editor-batch persistence port. |
| `apps/desktop/src/storeCommands.ts` | Serialize session-owned batches without frontend or Rust duplicate history. |
| `apps/desktop/src/storeHistory.ts` | Publish mutation-history reset after a session-owned editor commit. |
| `apps/desktop/src/notesInteractionHistory.ts` | Drop invalid mutation entries while retaining navigation history. |
| `apps/desktop/src/previewApi.ts` | Execute atomic editor batches and honor omitted Rust-style history in browser preview. |
| `apps/desktop/src/previewValidation.ts` | Validate bounded, non-recursive editor batches. |
| `apps/desktop/src/notes.css` | Retain current geometry and replace hybrid caret-normalization CSS with plugin decoration classes. |
| Existing store/API/preview tests | Add generated batch shapes, retry behavior, and history clearing assertions. |

### Modified Rust and generated contract files

| File | Change |
| --- | --- |
| `crates/notes-core/src/command.rs` | Add atomic `Batch { commands }` domain command. |
| `crates/notes-core/src/tree/command_execution.rs` | Execute batch commands against one candidate tree. |
| `crates/notes-core/tests/tree_commands.rs` | Prove batch atomicity, ordering, and rollback. |
| `crates/notes-application/src/contracts.rs` | Add bounded `IpcEditorCommand` and `ApplyEditorBatch`. |
| `crates/notes-application/src/command_conversion.rs` | Convert the editor-only IPC subset into one domain batch. |
| `crates/notes-application/src/service.rs` | Commit a batch once, preserve idempotency, and clear server history only after success. |
| `crates/notes-application/tests/session_service.rs` | Prove revision, idempotency, history isolation, and failed-batch behavior. |
| `crates/notes-sqlite/src/repository.rs` | Recursively collect one command tree for all batch operations. |
| `crates/notes-sqlite/src/queries.rs` | Permit a bounded 50,000-node editor-page viewport request while boot stays small. |
| `crates/notes-sqlite/tests/vertical_slice.rs` | Persist split/Undo-style inverse batches and restore stable IDs. |
| `crates/notes-sqlite/tests/viewport_queries.rs` | Return one complete 5,000-node editor page. |
| `packages/contracts/generated/IpcEditorCommand.ts` | Generated editor command subset. |
| `packages/contracts/generated/IpcNotesCommand.ts` | Generated `applyEditorBatch` variant. |

### Removed after the new slice passes

- `apps/desktop/src/monacoOutlineCaret.ts`
- `apps/desktop/src/monacoOutlineCaret.test.ts`
- `apps/desktop/src/monacoOutlineCommands.ts`
- `apps/desktop/src/monacoOutlineCommands.test.ts`
- `apps/desktop/src/monacoOutlineController.ts`
- `apps/desktop/src/monacoOutlineController.test.ts`
- `apps/desktop/src/monacoOutlineFocus.ts`
- `apps/desktop/src/monacoOutlineFocus.test.ts`
- `apps/desktop/src/monacoOutlineKeyboard.ts`
- `apps/desktop/src/monacoOutlineKeyboard.test.ts`
- `apps/desktop/src/monacoOutlineProjection.ts`
- `apps/desktop/src/monacoOutlineProjection.test.ts`
- `apps/desktop/src/monacoOutlineReconciliation.ts`
- `apps/desktop/src/monacoOutlineReconciliation.test.ts`
- `apps/desktop/src/monacoOutlineSeed.ts`
- `apps/desktop/src/monacoOutlineSeed.test.ts`
- `apps/desktop/src/monacoOutlinePerformance.test.ts`

---

### Task 1: Checkpoint the Current Caret-Fix Baseline

**Files:**
- Existing modified: `apps/desktop/src/MonacoOutlineSurface.tsx`
- Existing modified: `apps/desktop/src/monacoOutlineCommands.ts`
- Existing modified: `apps/desktop/src/monacoOutlineKeyboard.ts`
- Existing modified: `apps/desktop/src/monacoOutlineKeyboard.test.ts`
- Existing modified: `apps/desktop/src/notes.css`
- Existing untracked: `apps/desktop/src/monacoOutlineCaret.ts`
- Existing untracked: `apps/desktop/src/monacoOutlineCaret.test.ts`

**Interfaces:**
- Consumes: current branch working tree exactly as recorded on 2026-07-31.
- Produces: a clean, revertible baseline commit before authority changes begin.

- [x] **Step 1: Confirm only the recorded seven files are dirty**

Run:

```powershell
git status --short
```

Expected: the seven paths above plus this plan file only. Stop if any other
path is modified because it is outside the recorded baseline.

- [x] **Step 2: Run the focused hybrid-caret tests**

Run:

```powershell
npm test --prefix apps/desktop -- src/monacoOutlineKeyboard.test.ts src/monacoOutlineCommands.test.ts src/monacoOutlineCaret.test.ts
```

Expected: all selected tests pass.

- [x] **Step 3: Check the baseline diff**

Run:

```powershell
git diff --check -- apps/desktop/src/MonacoOutlineSurface.tsx apps/desktop/src/monacoOutlineCommands.ts apps/desktop/src/monacoOutlineKeyboard.ts apps/desktop/src/monacoOutlineKeyboard.test.ts apps/desktop/src/notes.css
```

Expected: no output.

- [x] **Step 4: Commit only the current baseline files**

```powershell
git add -- apps/desktop/src/MonacoOutlineSurface.tsx apps/desktop/src/monacoOutlineCommands.ts apps/desktop/src/monacoOutlineKeyboard.ts apps/desktop/src/monacoOutlineKeyboard.test.ts apps/desktop/src/monacoOutlineCaret.ts apps/desktop/src/monacoOutlineCaret.test.ts apps/desktop/src/notes.css
git commit -m "fix(monaco): stabilize injected bullet caret"
```

---

### Task 2: Add an Atomic Domain Batch

**Files:**
- Modify: `crates/notes-core/src/command.rs`
- Modify: `crates/notes-core/src/tree/command_execution.rs`
- Test: `crates/notes-core/tests/tree_commands.rs`

**Interfaces:**
- Consumes: existing `NotesTree::plan`, `NotesTree::apply`, and ordinary `NotesCommand` variants.
- Produces: `NotesCommand::Batch { commands: Vec<NotesCommand> }`, planned as one `DomainPatch`.

- [x] **Step 1: Write failing atomicity tests**

Add tests that prove the second command sees the first command's candidate
state and that a failing second command leaves the source tree unchanged:

```rust
#[test]
fn editor_batch_plans_against_one_candidate_tree() {
    let tree = page_with_bullet("page", "first", "alpha");
    let patch = tree.plan(NotesCommand::Batch {
        commands: vec![
            NotesCommand::CreateNode {
                id: id("second"),
                parent_id: id("page"),
                position: Position::at_end(),
                text: "beta".into(),
            },
            NotesCommand::UpdateText {
                id: id("second"),
                text: "beta edited".into(),
            },
        ],
    }).expect("batch");
    let mut applied = tree.clone();
    applied.apply(&patch.forward).expect("apply batch");
    assert_eq!(applied.node(&id("second")).unwrap().text(), "beta edited");
}

#[test]
fn invalid_editor_batch_does_not_mutate_the_source_tree() {
    let tree = page_with_bullet("page", "first", "alpha");
    let before = tree.clone();
    let result = tree.plan(NotesCommand::Batch {
        commands: vec![
            NotesCommand::UpdateText { id: id("first"), text: "changed".into() },
            NotesCommand::UpdateText { id: id("missing"), text: "invalid".into() },
        ],
    });
    assert!(result.is_err());
    assert_eq!(tree, before);
}
```

- [x] **Step 2: Run the focused tests and observe failure**

Run:

```powershell
cargo test -p notes-core editor_batch
```

Expected: compile failure because `NotesCommand::Batch` does not exist.

- [x] **Step 3: Add the batch command and candidate execution**

Add the variant:

```rust
pub enum NotesCommand {
    Batch {
        commands: Vec<NotesCommand>,
    },
}
```

Insert `Batch` before `CreatePage`; retain every existing variant after it.

Handle it inside `NotesTree::execute` before the ordinary variants:

```rust
NotesCommand::Batch { commands } => {
    if commands.is_empty() {
        return Err(DomainError::Invariant(
            "an editor batch must contain at least one command".into(),
        ));
    }
    for command in commands {
        if matches!(command, NotesCommand::Batch { .. }) {
            return Err(DomainError::Invariant(
                "nested editor batches are not allowed".into(),
            ));
        }
        self.execute(command)?;
    }
    Ok(())
}
```

`NotesTree::plan` already clones the source, executes on the clone, validates,
and diffs once, so no storage commit occurs until every nested command passes.

- [x] **Step 4: Run focused and owning tests**

Run:

```powershell
cargo test -p notes-core editor_batch
cargo test -p notes-core --test tree_commands
```

Expected: both commands pass.

- [x] **Step 5: Commit**

```powershell
git add -- crates/notes-core/src/command.rs crates/notes-core/src/tree/command_execution.rs crates/notes-core/tests/tree_commands.rs
git commit -m "feat(core): add atomic note command batch"
```

---

### Task 3: Expose Session-Owned Editor Batches Through SQLite

**Files:**
- Modify: `crates/notes-application/src/contracts.rs`
- Modify: `crates/notes-application/src/command_conversion.rs`
- Modify: `crates/notes-application/src/service.rs`
- Modify: `crates/notes-application/tests/session_service.rs`
- Modify: `crates/notes-sqlite/src/repository.rs`
- Modify: `crates/notes-sqlite/src/queries.rs`
- Modify: `crates/notes-sqlite/tests/vertical_slice.rs`
- Modify: `crates/notes-sqlite/tests/viewport_queries.rs`
- Generate: `packages/contracts/generated/IpcEditorCommand.ts`
- Modify generated: `packages/contracts/generated/IpcNotesCommand.ts`

**Interfaces:**
- Consumes: `NotesCommand::Batch`.
- Produces: `IpcEditorCommand`, `IpcNotesCommand::ApplyEditorBatch`, one-revision SQLite commit, stable request idempotency, and a complete editor viewport up to 50,000 nodes.

- [x] **Step 1: Write failing application and SQLite tests**

Add an application test using an existing service fixture:

```rust
#[test]
fn editor_batch_commits_once_and_uses_no_rust_history() {
    let service = service_with_page_and_two_bullets();
    let receipt = service.execute(command(
        "editor-1",
        current_revision(&service),
        IpcNotesCommand::ApplyEditorBatch {
            commands: vec![
                IpcEditorCommand::UpdateText {
                    id: "first".into(),
                    text: "alpha edited".into(),
                },
                IpcEditorCommand::SplitNode {
                    id: "first".into(),
                    new_id: "inserted".into(),
                    parent_id: "page".into(),
                    before_id: Some("second".into()),
                    prefix: "alpha".into(),
                    suffix: " edited".into(),
                },
            ],
        },
    )).expect("editor batch");
    assert_eq!(receipt.history.undo_depth, 0);
    assert_eq!(receipt.history.redo_depth, 0);
}
```

Add a SQLite vertical-slice test that restarts storage and asserts both
`first` and `inserted` IDs and texts. Add a viewport test that creates 5,000
nodes, requests `limit: 50_000`, and asserts `after_cursor == None`.

- [x] **Step 2: Run the tests and observe missing contract variants**

Run:

```powershell
cargo test -p notes-application editor_batch_commits_once
cargo test -p notes-sqlite --test vertical_slice editor_batch
cargo test -p notes-sqlite --test viewport_queries editor_page_returns_5000
```

Expected: compile failures for `IpcEditorCommand` and `ApplyEditorBatch`.

- [x] **Step 3: Define the bounded editor IPC subset**

Add:

```rust
pub const MAX_EDITOR_BATCH_COMMANDS: usize = 256;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(export)]
pub enum IpcEditorCommand {
    CreateNode {
        id: String,
        parent_id: String,
        before_id: Option<String>,
        text: String,
    },
    UpdateText {
        id: String,
        text: String,
    },
    SplitNode {
        id: String,
        new_id: String,
        parent_id: String,
        before_id: Option<String>,
        prefix: String,
        suffix: String,
    },
    MergeNodeBackward {
        id: String,
        previous_id: String,
        previous_text: String,
        current_text: String,
    },
    RemoveEmptyNode {
        id: String,
    },
    MoveNode {
        id: String,
        parent_id: String,
        before_id: Option<String>,
    },
    Indent {
        id: String,
        new_parent_id: String,
    },
    Outdent {
        id: String,
        new_parent_id: String,
        before_id: Option<String>,
    },
}
```

Add this top-level IPC variant:

```rust
ApplyEditorBatch {
    commands: Vec<IpcEditorCommand>,
},
```

Conversion must reject an empty batch and batches above
`MAX_EDITOR_BATCH_COMMANDS`, map every entry to `NotesCommand`, and wrap the
result in `NotesCommand::Batch`.

- [x] **Step 4: Clear duplicate service history only after a successful commit**

Introduce an internal policy:

```rust
enum HistoryPolicy {
    Record(Option<String>),
    SessionOwned,
}
```

In `execute`, choose `SessionOwned` only for `ApplyEditorBatch`. In
`execute_checked`, commit first, then:

```rust
match history_policy {
    HistoryPolicy::Record(group) => session.record_history(
        NotesServiceHistoryEntry {
            forward: patch.forward,
            inverse: patch.inverse,
            group,
        },
    ),
    HistoryPolicy::SessionOwned => {
        session.undo.clear();
        session.redo.clear();
    }
}
```

Keep the existing completed-request lookup before revision validation so a
lost response can retry the same request ID safely. Reject a non-null
`history_group` on `ApplyEditorBatch` to prevent two history authorities.

- [x] **Step 5: Load all batch context and raise only the explicit request cap**

Refactor `load_command_tree` into a recursive collector:

```rust
fn collect_command_context(
    connection: &Connection,
    command: &NotesCommand,
    nodes: &mut BTreeMap<NodeId, NoteNode>,
) -> Result<(), StorageError> {
    match command {
        NotesCommand::Batch { commands } => {
            for command in commands {
                collect_command_context(connection, command, nodes)?;
            }
            Ok(())
        }
        NotesCommand::CreatePage { .. }
        | NotesCommand::CreateNode { .. }
        | NotesCommand::ImportNodes { .. }
        | NotesCommand::ImportImages { .. }
        | NotesCommand::UpdateText { .. }
        | NotesCommand::UpdateNote { .. }
        | NotesCommand::ResizeImage { .. }
        | NotesCommand::ReplaceImage { .. }
        | NotesCommand::SplitNode { .. }
        | NotesCommand::MergeNodeBackward { .. }
        | NotesCommand::RemoveEmptyNode { .. }
        | NotesCommand::MoveNode { .. }
        | NotesCommand::MoveNodes { .. }
        | NotesCommand::IndentNode { .. }
        | NotesCommand::DuplicateNode { .. }
        | NotesCommand::DuplicateNodes { .. }
        | NotesCommand::SetCompleted { .. }
        | NotesCommand::SetCompletedMany { .. }
        | NotesCommand::SetStarred { .. }
        | NotesCommand::SetCollapsed { .. }
        | NotesCommand::SetMarker { .. }
        | NotesCommand::DeleteSubtree { .. }
        | NotesCommand::DeleteSubtrees { .. }
        | NotesCommand::RestoreSubtree { .. } => {
            collect_single_command_context(connection, command, nodes)
        }
    }
}
```

Rename the current non-batch match body to
`collect_single_command_context`; its existing arms and SQL collectors remain
byte-for-byte equivalent.

Set `MAX_VIEWPORT_LIMIT` to `50_000`. Do not change the bootstrap limit passed
by the worker; only an explicit editor-page request can receive the larger
page.

- [x] **Step 6: Generate and verify TypeScript contracts**

Run:

```powershell
$env:TS_RS_EXPORT_DIR = (Resolve-Path 'packages/contracts/generated').Path
cargo test -p notes-application export_bindings --quiet
Remove-Item Env:TS_RS_EXPORT_DIR
npm run test:v2:contracts
```

Expected: `IpcEditorCommand.ts` is generated, `IpcNotesCommand.ts` contains
`applyEditorBatch`, and the contract check passes.

- [x] **Step 7: Run owning Rust tests**

Run:

```powershell
cargo test -p notes-application
cargo test -p notes-sqlite --test vertical_slice
cargo test -p notes-sqlite --test viewport_queries
```

Expected: all pass, including atomic rollback, one revision, history depth
zero, request idempotency, restart restoration, and 5,000-node viewport.

- [x] **Step 8: Commit**

```powershell
git add -- crates/notes-application/src/contracts.rs crates/notes-application/src/command_conversion.rs crates/notes-application/src/service.rs crates/notes-application/tests/session_service.rs crates/notes-sqlite/src/repository.rs crates/notes-sqlite/src/queries.rs crates/notes-sqlite/tests/vertical_slice.rs crates/notes-sqlite/tests/viewport_queries.rs packages/contracts/generated/IpcEditorCommand.ts packages/contracts/generated/IpcNotesCommand.ts
git commit -m "feat(notes): persist session-owned editor batches"
```

---

### Task 4: Isolate Monaco Internal APIs

**Files:**
- Create: `apps/desktop/src/monaco-outline/monacoInternal.d.ts`
- Create: `apps/desktop/src/monaco-outline/internalAdapter.ts`
- Test: `apps/desktop/src/monaco-outline/internalAdapter.test.ts`
- Modify: `apps/desktop/package.json`
- Modify: `package-lock.json`
- Modify: `scripts/checkV2Architecture.mjs`

**Interfaces:**
- Consumes: pinned `monaco-editor@0.53.x`.
- Produces: `assertMonacoInternalCapabilities`, `setEditorHiddenAreas`, `readInjectedTextAttachment`, `registerOutlineContribution`, `moveWithInjectedTextAffinity`, and `pushMetadataUndo`.

- [x] **Step 1: Pin Monaco and write capability tests**

Change the dependency from a range to an exact version:

```json
"monaco-editor": "0.53.0"
```

Test the public facade rather than importing internal modules in tests:

```ts
it("reports every pinned Monaco capability", () => {
  expect(readMonacoInternalCapabilities()).toEqual({
    editorContribution: true,
    editorCommand: true,
    cursorAffinity: true,
    hiddenAreas: true,
    injectedMouseTarget: true,
    metadataUndo: true
  });
});

it("reads only Yonalist injected bullet attachments", () => {
  expect(readInjectedTextAttachment({
    target: {
      detail: {
        injectedText: {
          options: {
            attachedData: {
              kind: "yonalist-bullet",
              nodeId: "node-1"
            }
          }
        }
      }
    }
  })).toEqual({ kind: "yonalist-bullet", nodeId: "node-1" });
});
```

- [x] **Step 2: Run the test and observe the missing module**

Run:

```powershell
npm test --prefix apps/desktop -- src/monaco-outline/internalAdapter.test.ts
```

Expected: failure because `internalAdapter.ts` does not exist.

- [x] **Step 3: Declare and implement the narrow facade**

Declare only the imports used from:

```text
monaco-editor/esm/vs/editor/browser/editorExtensions.js
monaco-editor/esm/vs/editor/common/cursor/cursorMoveOperations.js
monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js
monaco-editor/esm/vs/platform/undoRedo/common/undoRedo.js
```

Export this stable Yonalist interface:

```ts
export interface MonacoInternalCapabilities {
  readonly editorContribution: boolean;
  readonly editorCommand: boolean;
  readonly cursorAffinity: boolean;
  readonly hiddenAreas: boolean;
  readonly injectedMouseTarget: boolean;
  readonly metadataUndo: boolean;
}

export interface MetadataUndoElement {
  readonly resource: monaco.Uri;
  readonly label: string;
  readonly code: string;
  undo(): void | Promise<void>;
  redo(): void | Promise<void>;
}
```

Use `unknown` plus runtime guards at the private editor boundary. No other
production file may import `monaco-editor/esm/vs/**` internals.

- [x] **Step 4: Add an architecture guard**

Extend `scripts/checkV2Architecture.mjs` so any Monaco import other than the
public `monaco-editor/esm/vs/editor/editor.api` specifier fails outside
`monaco-outline/internalAdapter.ts` and `monacoInternal.d.ts`:

```js
const monacoImports = [...source.matchAll(
  /["'](monaco-editor\/esm\/vs\/[^"']+)["']/gu
)].map((match) => match[1]);
for (const specifier of monacoImports) {
  const publicApi = specifier ===
    "monaco-editor/esm/vs/editor/editor.api";
  const adapter = path.endsWith(
    join("monaco-outline", "internalAdapter.ts")
  );
  if (!publicApi && !adapter) {
    throw new Error(
      `Monaco internal import escaped adapter: ${relative(root, path)}`
    );
  }
}
```

- [x] **Step 5: Run focused tests and architecture check**

Run:

```powershell
npm test --prefix apps/desktop -- src/monaco-outline/internalAdapter.test.ts
npm run test:v2:architecture
npm run build --prefix apps/desktop
```

Expected: all pass with Monaco exactly pinned.

- [x] **Step 6: Commit**

```powershell
git add -- apps/desktop/src/monaco-outline/internalAdapter.ts apps/desktop/src/monaco-outline/internalAdapter.test.ts apps/desktop/src/monaco-outline/monacoInternal.d.ts apps/desktop/package.json package-lock.json scripts/checkV2Architecture.mjs
git commit -m "refactor(monaco): isolate internal editor APIs"
```

---

### Task 5: Build Stable Line Metadata and Version Snapshots

**Files:**
- Create: `apps/desktop/src/monaco-outline/metadata.ts`
- Test: `apps/desktop/src/monaco-outline/metadata.test.ts`

**Interfaces:**
- Consumes: ordered text-only `NoteView` records and Monaco alternative version IDs.
- Produces: `OutlineLineMetadata`, `OutlineMetadataSnapshot`, and `OutlineMetadataTimeline`.

- [x] **Step 1: Write failing metadata tests**

Use stable IDs rather than line numbers:

```ts
it("restores the same identities for an earlier alternative version", () => {
  const timeline = OutlineMetadataTimeline.hydrate(1, [
    line("first", "page", 0),
    line("second", "page", 0)
  ]);
  timeline.record(2, [
    line("first", "page", 0),
    line("inserted", "page", 0),
    line("second", "page", 0)
  ]);
  expect(timeline.restore(1).lines.map(({ nodeId }) => nodeId))
    .toEqual(["first", "second"]);
  expect(timeline.restore(2).lines.map(({ nodeId }) => nodeId))
    .toEqual(["first", "inserted", "second"]);
});

it("rejects cycles and depth jumps", () => {
  expect(() => validateOutlineMetadata([
    line("first", "page", 0),
    line("child", "first", 2)
  ])).toThrow("depth may increase by at most one");
});
```

- [x] **Step 2: Run the test and observe failure**

Run:

```powershell
npm test --prefix apps/desktop -- src/monaco-outline/metadata.test.ts
```

Expected: missing module failure.

- [x] **Step 3: Implement the metadata timeline**

Use these exact public types:

```ts
export interface OutlineLineMetadata {
  readonly nodeId: string;
  readonly parentId: string;
  readonly depth: number;
  readonly kind: "text";
  readonly collapsed: boolean;
  readonly completed: boolean;
}

export interface OutlineMetadataSnapshot {
  readonly alternativeVersionId: number;
  readonly lines: readonly OutlineLineMetadata[];
  readonly lineByNodeId: ReadonlyMap<string, number>;
}

export class OutlineMetadataTimeline {
  static hydrate(
    alternativeVersionId: number,
    lines: readonly OutlineLineMetadata[]
  ): OutlineMetadataTimeline;
  current(): OutlineMetadataSnapshot;
  record(
    alternativeVersionId: number,
    lines: readonly OutlineLineMetadata[]
  ): OutlineMetadataSnapshot;
  restore(alternativeVersionId: number): OutlineMetadataSnapshot;
  replaceCurrent(snapshot: OutlineMetadataSnapshot): void;
}
```

Create a new immutable line array only for structural or depth changes.
Text-only alternative versions point to the existing metadata snapshot rather
than copying every line. Retain the lightweight alternative-version-to-
snapshot mapping for the session lifetime and release all snapshots when the
session is disposed.

- [x] **Step 4: Run focused tests**

Run:

```powershell
npm test --prefix apps/desktop -- src/monaco-outline/metadata.test.ts
```

Expected: pass.

- [x] **Step 5: Commit**

```powershell
git add -- apps/desktop/src/monaco-outline/metadata.ts apps/desktop/src/monaco-outline/metadata.test.ts
git commit -m "feat(monaco): track versioned outline metadata"
```

---

### Task 6: Interpret Native Monaco Structural Changes

**Files:**
- Create: `apps/desktop/src/monaco-outline/structuralChanges.ts`
- Test: `apps/desktop/src/monaco-outline/structuralChanges.test.ts`

**Interfaces:**
- Consumes: prior metadata snapshot, prior line-text index, Monaco `IModelContentChangedEvent`, post-edit line text, and `freshId`.
- Produces: `OutlineStructuralTransition` with next metadata, bounded line-text patches, forward/inverse `IpcEditorCommand` lists, and native boundary preflight.

- [x] **Step 1: Write real-model failing tests**

Create a real Monaco text model and call `pushEditOperations`:

```ts
it("keeps the source id on the prefix and allocates the suffix id", () => {
  const model = monaco.editor.createModel(
    "Changes appear instantly.",
    "plaintext"
  );
  const before = snapshot(1, [line("first", "page", 0)]);
  let event!: monaco.editor.IModelContentChangedEvent;
  const listener = model.onDidChangeContent((value) => { event = value; });
  model.pushEditOperations(
    [],
    [{
      range: new monaco.Range(1, 9, 1, 9),
      text: "\n"
    }],
    () => null
  );
  const transition = interpretModelChanges({
    before,
    beforeTexts: ["Changes appear instantly."],
    event,
    model,
    allocateId: () => "inserted"
  });
  expect(transition.after.lines.map(({ nodeId }) => nodeId))
    .toEqual(["first", "inserted"]);
  expect(model.getValue()).toBe("Changes \nappear instantly.");
  listener.dispose();
  model.dispose();
});

it("keeps the current id when nonempty Backspace deletes the previous newline", () => {
  const transition = applyModelEditFixture({
    value: "alpha\nbeta",
    lines: [line("first", "page", 0), line("second", "page", 0)],
    range: new monaco.Range(1, 6, 2, 1),
    text: "",
    allocatedIds: []
  });
  expect(transition.after.lines.map(({ nodeId }) => nodeId))
    .toEqual(["second"]);
  expect(transition.forward).toContainEqual({
    kind: "mergeNodeBackward",
    id: "second",
    previous_id: "first",
    previous_text: "alpha",
    current_text: "beta"
  });
});

it("keeps the previous id when an empty line is removed backward", () => {
  const transition = applyModelEditFixture({
    value: "alpha\n",
    lines: [line("first", "page", 0), line("second", "page", 0)],
    range: new monaco.Range(1, 6, 2, 1),
    text: "",
    allocatedIds: []
  });
  expect(transition.after.lines.map(({ nodeId }) => nodeId))
    .toEqual(["first"]);
  expect(transition.forward.at(-1)).toEqual({
    kind: "removeEmptyNode",
    id: "second"
  });
});

it("normalizes simultaneous changes in descending source order", () => {
  const transition = applyBatchedEditFixture({
    value: "alpha\nbeta",
    lines: [line("first", "page", 0), line("second", "page", 0)],
    edits: [
      { range: new monaco.Range(1, 6, 1, 6), text: "\n" },
      { range: new monaco.Range(2, 5, 2, 5), text: "\n" }
    ],
    allocatedIds: ["inserted-1", "inserted-2"]
  });
  expect(transition.after.lines.map(({ nodeId }) => nodeId)).toEqual([
    "first", "inserted-1", "second", "inserted-2"
  ]);
  expect(transition.forward.filter(({ kind }) => kind === "splitNode"))
    .toHaveLength(2);
});
```

Also cover start/end split, multi-line replacement, ordinary title edits, and
the 256-command bound. Define `applyModelEditFixture` and
`applyBatchedEditFixture` in the test file; each creates a real Monaco model,
captures its `onDidChangeContent` event, calls `interpretModelChanges`, and
disposes the model.

- [x] **Step 2: Run the test and observe failure**

Run:

```powershell
npm test --prefix apps/desktop -- src/monaco-outline/structuralChanges.test.ts
```

Expected: missing module failure.

- [x] **Step 3: Implement deterministic transition output**

Expose:

```ts
export interface OutlineStructuralTransition {
  readonly before: OutlineMetadataSnapshot;
  readonly after: OutlineMetadataSnapshot;
  readonly textPatch: OutlineLineTextPatch;
  readonly inverseTextPatch: OutlineLineTextPatch;
  readonly forward: readonly IpcEditorCommand[];
  readonly inverse: readonly IpcEditorCommand[];
  readonly affectedLineNumbers: readonly number[];
  readonly structural: boolean;
}

export interface OutlineLineTextPatch {
  readonly startIndex: number;
  readonly deleteCount: number;
  readonly insertedTexts: readonly string[];
}

export function interpretModelChanges(input: {
  readonly before: OutlineMetadataSnapshot;
  readonly beforeTexts: readonly string[];
  readonly event: monaco.editor.IModelContentChangedEvent;
  readonly model: monaco.editor.ITextModel;
  readonly allocateId: () => string;
}): OutlineStructuralTransition;

export function canApplyNativeBoundaryEdit(input: {
  readonly snapshot: OutlineMetadataSnapshot;
  readonly texts: readonly string[];
  readonly selection: monaco.Selection;
  readonly command: "backspace" | "delete";
}): boolean;
```

Rules:

```text
same-line text edit           -> same ID, updateText
single-line newline           -> prefix keeps source ID, suffix gets new ID
nonempty backward merge       -> trailing/current ID survives, previous ID removed
empty-line backward removal   -> previous ID survives, empty current ID removed
multi-line replacement        -> retain eligible boundary IDs; allocate inserted interior IDs
multiple changes              -> descending old range order, one ordered batch
undo/redo event               -> restore recorded transition; do not reinterpret
```

Maintain `beforeTexts` by applying `textPatch` with one `Array.splice` over the
affected line range rather than calling `model.getValue()` or copying the full
page after every key. Store `inverseTextPatch` for Undo. Build exact inverse
commands:

```text
updateText      -> updateText with the prior line text
splitNode       -> update new ID to empty, removeEmptyNode(new ID), restore source text
mergeBackward   -> create previous ID before current, restore current text
removeEmptyNode -> create the removed ID at its original position
indent/outdent  -> move the same ID to its prior parent and position
```

`canApplyNativeBoundaryEdit` returns false before Monaco deletes a newline if
the affected operation would remove a node with children or cross an invalid
parent boundary. The plugin consumes only that structural boundary key; text
Backspace/Delete inside a line remains native.

- [x] **Step 4: Run focused tests**

Run:

```powershell
npm test --prefix apps/desktop -- src/monaco-outline/structuralChanges.test.ts
```

Expected: all structural, multi-cursor, and inverse-ID tests pass.

- [x] **Step 5: Commit**

```powershell
git add -- apps/desktop/src/monaco-outline/structuralChanges.ts apps/desktop/src/monaco-outline/structuralChanges.test.ts
git commit -m "feat(monaco): derive tree changes from model edits"
```

---

### Task 7: Add the Ordered Persistence Queue and Store Bridge

**Files:**
- Create: `apps/desktop/src/monaco-outline/persistenceQueue.ts`
- Test: `apps/desktop/src/monaco-outline/persistenceQueue.test.ts`
- Modify: `apps/desktop/src/storeCommands.ts`
- Modify: `apps/desktop/src/storeCommands.test.ts`
- Modify: `apps/desktop/src/storeHistory.ts`
- Modify: `apps/desktop/src/notesInteractionHistory.ts`
- Modify: `apps/desktop/src/notesInteractionHistory.test.ts`
- Modify: `apps/desktop/src/notesStore.ts`
- Modify: `apps/desktop/src/previewApi.ts`
- Modify: `apps/desktop/src/previewValidation.ts`
- Modify: `apps/desktop/src/previewApi.test.ts`

**Interfaces:**
- Consumes: generated `IpcEditorCommand`, `MutationReceipt`, current store revision, and stable request IDs.
- Produces: `MonacoPersistencePort`, `MonacoOutlinePersistenceQueue`, `NotesStore.loadMonacoPage`, and `NotesStore.executeEditorBatch`.

- [x] **Step 1: Write failing queue tests with fake timers**

```ts
it("coalesces title edits for one node for 300 ms", async () => {
  vi.useFakeTimers();
  const port = fakePort();
  const queue = new MonacoOutlinePersistenceQueue(port);
  queue.enqueue([{ kind: "updateText", id: "first", text: "a" }], "text");
  queue.enqueue([{ kind: "updateText", id: "first", text: "ab" }], "text");
  await vi.advanceTimersByTimeAsync(299);
  expect(port.executeEditorBatch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(port.executeEditorBatch).toHaveBeenCalledWith(
    expect.any(String),
    [{ kind: "updateText", id: "first", text: "ab" }]
  );
});

it("flushes pending text before an immediate structural batch", async () => {
  vi.useFakeTimers();
  const port = fakePort();
  const queue = new MonacoOutlinePersistenceQueue(port);
  queue.enqueue(
    [{ kind: "updateText", id: "first", text: "alpha" }],
    "text"
  );
  queue.enqueue(
    [{
      kind: "splitNode",
      id: "first",
      new_id: "second",
      parent_id: "page",
      before_id: null,
      prefix: "alpha",
      suffix: ""
    }],
    "structural"
  );
  await queue.flush("navigation");
  expect(port.executeEditorBatch).toHaveBeenCalledWith(
    expect.any(String),
    expect.arrayContaining([
      { kind: "updateText", id: "first", text: "alpha" },
      expect.objectContaining({ kind: "splitNode", new_id: "second" })
    ])
  );
});

it("keeps content unsaved and pauses on revision conflict", async () => {
  const port = fakePort({
    rejectWith: {
      code: "revision_conflict",
      message: "stale",
      retryable: true
    }
  });
  const queue = new MonacoOutlinePersistenceQueue(port);
  queue.enqueue(
    [{ kind: "updateText", id: "first", text: "local" }],
    "structural"
  );
  await expect(queue.flush("navigation")).rejects.toMatchObject({
    code: "revision_conflict"
  });
  expect(queue.getSnapshot()).toMatchObject({
    kind: "conflict",
    pending: 1
  });
});
```

Cover same-request retry, fatal error, bounded queue overflow, blur flush, and
close flush.

- [x] **Step 2: Run the queue test and observe failure**

Run:

```powershell
npm test --prefix apps/desktop -- src/monaco-outline/persistenceQueue.test.ts
```

Expected: missing module failure.

- [x] **Step 3: Define and implement queue state**

Use:

```ts
export type EditorPersistenceState =
  | { readonly kind: "saved"; readonly pending: 0 }
  | { readonly kind: "unsaved"; readonly pending: number }
  | { readonly kind: "saving"; readonly pending: number }
  | { readonly kind: "conflict"; readonly pending: number; readonly message: string }
  | { readonly kind: "fatal"; readonly pending: number; readonly message: string }
  | { readonly kind: "closed"; readonly pending: 0 };

export interface MonacoPersistencePort {
  executeEditorBatch(
    requestId: string,
    commands: readonly IpcEditorCommand[]
  ): Promise<MutationReceipt>;
}

export class MonacoOutlinePersistenceQueue {
  enqueue(
    commands: readonly IpcEditorCommand[],
    urgency: "text" | "structural"
  ): void;
  flush(reason: "blur" | "navigation" | "close"): Promise<void>;
  retry(): Promise<void>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): EditorPersistenceState;
}
```

Use `DRAFT_DEBOUNCE_MS` from `storeSupport.ts`, a maximum of 1,024 retained
transitions, and one promise chain. Retry the identical request ID until a
receipt is accepted.

- [x] **Step 4: Add the store persistence port without editor history**

Add:

```ts
StoreCommands.executeSessionOwned(
  commands: readonly IpcEditorCommand[],
  requestId: string
): Promise<MutationReceipt>
```

It must enqueue:

```ts
{
  sessionId: state.sessionId,
  requestId,
  baseRevision: state.revision,
  historyGroup: null,
  command: {
    kind: "applyEditorBatch",
    commands: [...commands]
  }
}
```

Apply the receipt to confirmed store snapshots, do not call
`StoreHistoryEvents.record`, and call `StoreHistoryEvents.resetMutations()`
after success.

Extend the event union:

```ts
export type NotesMutationHistoryEvent =
  | {
      readonly kind: "recordMutation";
      readonly undoDepth: number;
      readonly redoDepth: number;
    }
  | { readonly kind: "resetMutations" };
```

When `NotesInteractionHistory` receives `resetMutations`, filter mutation
entries from both `past` and `future` while retaining navigation entries in
their original order. Add a test that records
mutation → navigation → mutation, emits reset, then proves Undo applies the
navigation and never calls `store.undo()`.

Expose through `NotesStore.executeEditorBatch`. Add
`NotesStore.loadMonacoPage(pageId)` that:

1. waits for the existing command queue to settle;
2. requests `queryViewport` with `limit: 50_000`;
3. requires `beforeCursor` and `afterCursor` to be null;
4. requires all returned nodes to be text bullets;
5. retries once if the store revision changed during the request;
6. otherwise throws a typed unsupported-page error so React remains active.

- [x] **Step 5: Make browser preview execute editor batches atomically**

Refactor the existing switch into:

```ts
function applyPreviewCommand(command: IpcEditorCommand): void {
  switch (command.kind) {
    case "createNode":
    case "updateText":
    case "splitNode":
    case "mergeNodeBackward":
    case "removeEmptyNode":
    case "moveNode":
    case "indent":
    case "outdent":
      applyPreviewEditorMutation(command);
  }
}
```

For `applyEditorBatch`, clone `nodes`, apply every command to the clone, commit
the clone only after all commands pass, increment revision once, clear both
preview history stacks, and cache the receipt by request ID.
Extract the matching bodies from the existing top-level preview switch into
`applyPreviewEditorMutation`; ordinary non-editor commands keep their current
paths.

- [x] **Step 6: Run focused frontend tests**

Run:

```powershell
npm test --prefix apps/desktop -- src/monaco-outline/persistenceQueue.test.ts src/storeCommands.test.ts src/notesInteractionHistory.test.ts src/previewApi.test.ts
```

Expected: all pass.

- [x] **Step 7: Commit**

```powershell
git add -- apps/desktop/src/monaco-outline/persistenceQueue.ts apps/desktop/src/monaco-outline/persistenceQueue.test.ts apps/desktop/src/storeCommands.ts apps/desktop/src/storeCommands.test.ts apps/desktop/src/storeHistory.ts apps/desktop/src/notesInteractionHistory.ts apps/desktop/src/notesInteractionHistory.test.ts apps/desktop/src/notesStore.ts apps/desktop/src/previewApi.ts apps/desktop/src/previewValidation.ts apps/desktop/src/previewApi.test.ts
git commit -m "feat(monaco): queue session-owned persistence"
```

---

### Task 8: Create the Canonical Session and Registry

**Files:**
- Create: `apps/desktop/src/monaco-outline/session.ts`
- Test: `apps/desktop/src/monaco-outline/session.test.ts`
- Create: `apps/desktop/src/monaco-outline/sessionRegistry.ts`
- Test: `apps/desktop/src/monaco-outline/sessionRegistry.test.ts`

**Interfaces:**
- Consumes: complete text-only page nodes, metadata timeline, structural interpreter, persistence queue, Monaco model.
- Produces: one `MonacoOutlineSession` per page and a reference-counted `MonacoOutlineSessionRegistry`.

- [x] **Step 1: Write failing real-model session tests**

```ts
it("uses Monaco as text authority and never rehydrates after local edit", async () => {
  const persistence = fakePersistencePort();
  const session = MonacoOutlineSession.create({
    pageId: "page",
    nodes: [node("first", "page", "Changes appear instantly.")],
    persistence
  });
  session.model.pushEditOperations(
    [],
    [{
      range: new monaco.Range(1, 9, 1, 9),
      text: "\n"
    }],
    () => null
  );
  expect(session.model.getValue()).toBe("Changes \nappear instantly.");
  expect(session.metadata.current().lines).toHaveLength(2);
  expect(persistence.executeEditorBatch).not.toHaveBeenCalled();
  await session.flush("navigation");
  expect(persistence.executeEditorBatch).toHaveBeenCalledTimes(1);
});

it("restores exact line identities through native undo and redo", async () => {
  const session = sessionWithOneLine("first", "alpha");
  applyModelEdit(
    session.model,
    new monaco.Range(1, 3, 1, 3),
    "\n"
  );
  const insertedId = session.metadata.current().lines[1]?.nodeId;
  await session.model.undo();
  expect(session.metadata.current().lines.map(({ nodeId }) => nodeId))
    .toEqual(["first"]);
  await session.model.redo();
  expect(session.metadata.current().lines.map(({ nodeId }) => nodeId))
    .toEqual(["first", insertedId]);
});

it("registry shares one model and disposes only after the last pane", async () => {
  const registry = registryWithPage("page");
  const first = await registry.acquire("page");
  const second = await registry.acquire("page");
  expect(first.session.model).toBe(second.session.model);
  await first.release();
  expect(second.session.model.isDisposed()).toBe(false);
  await second.release();
  expect(second.session.model.isDisposed()).toBe(true);
});
```

- [x] **Step 2: Run the tests and observe failure**

Run:

```powershell
npm test --prefix apps/desktop -- src/monaco-outline/session.test.ts src/monaco-outline/sessionRegistry.test.ts
```

Expected: missing modules.

- [x] **Step 3: Implement the session lifecycle**

Expose:

```ts
export class MonacoOutlineSession {
  readonly pageId: string;
  readonly model: monaco.editor.ITextModel;
  readonly metadata: OutlineMetadataTimeline;
  static create(input: MonacoOutlineSessionInput): MonacoOutlineSession;
  ensureEditableLine(): void;
  canAcceptStructuralEdit(): boolean;
  indent(nodeId: string): void;
  outdent(nodeId: string): void;
  flush(reason: "blur" | "navigation" | "close"): Promise<void>;
  persistenceState(): EditorPersistenceState;
  dispose(): Promise<void>;
}
```

Hydrate once with URI
`inmemory://yonalist/page/<encoded-page-id>`. In the model listener:

```ts
if (event.isUndoing || event.isRedoing) {
  applyRecordedUndoRedo(event, model.getAlternativeVersionId());
  return;
}
const transition = interpretModelChanges({
  before: metadata.current(),
  beforeTexts: lineTexts,
  event,
  model,
  allocateId: freshId
});
metadata.record(model.getAlternativeVersionId(), transition.after.lines);
applyLineTextPatch(lineTexts, transition.textPatch);
recordVersionTransition(transition);
persistenceQueue.enqueue(
  transition.forward,
  transition.structural ? "structural" : "text"
);
```

Do not subscribe to store node epochs and do not call `model.setValue` after
hydration.

Keep `lineTexts` as the current ordered line-text index and replace only the
affected slice after each event. Record:

```ts
interface VersionTransition {
  readonly fromAlternativeVersionId: number;
  readonly toAlternativeVersionId: number;
  readonly beforeMetadata: OutlineMetadataSnapshot;
  readonly afterMetadata: OutlineMetadataSnapshot;
  readonly textPatch: OutlineLineTextPatch;
  readonly inverseTextPatch: OutlineLineTextPatch;
  readonly forward: readonly IpcEditorCommand[];
  readonly inverse: readonly IpcEditorCommand[];
}
```

Index transitions by both `fromAlternativeVersionId` and
`toAlternativeVersionId`. Monaco may group several typing events into one Undo,
so traverse and apply inverse transitions from the version being left until
the event's target alternative version is reached. Redo traverses forward to
the target version. A new normal edit removes the abandoned redo branch.
Restore metadata and apply the corresponding text patch at each hop, but
enqueue the collected persistence commands as one editor batch. Never derive
an Undo identity from the current line number or retain a complete text-array
copy per keystroke.

`ensureEditableLine` allocates one stable ID for an empty page, associates the
model's existing empty line with it, and immediately enqueues `createNode`.
It renders no placeholder text.

`indent` and `outdent` apply metadata first, push a `MetadataUndoElement`
through `pushMetadataUndo`, and enqueue forward/inverse editor commands from
that element's redo/undo callbacks. This places metadata-only tree operations
in the same resource Undo order as native model edits.

- [x] **Step 4: Implement the registry**

Expose:

```ts
export interface MonacoSessionLease {
  readonly session: MonacoOutlineSession;
  release(): Promise<void>;
}

export class MonacoOutlineSessionRegistry {
  acquire(pageId: string): Promise<MonacoSessionLease>;
  flushPage(pageId: string, reason: "navigation" | "close"): Promise<void>;
  flushAll(reason: "close"): Promise<void>;
  hasFocusedEditor(target: EventTarget | null): boolean;
  dispose(): Promise<void>;
}
```

The registry receives `loadMonacoPage` and `executeEditorBatch` ports in its
constructor. Coalesce concurrent acquisitions for one page into one hydration
promise.

- [x] **Step 5: Run focused tests**

Run:

```powershell
npm test --prefix apps/desktop -- src/monaco-outline/session.test.ts src/monaco-outline/sessionRegistry.test.ts
```

Expected: pass, including Undo/Redo ID restoration and final-release flush.

- [x] **Step 6: Commit**

```powershell
git add -- apps/desktop/src/monaco-outline/session.ts apps/desktop/src/monaco-outline/session.test.ts apps/desktop/src/monaco-outline/sessionRegistry.ts apps/desktop/src/monaco-outline/sessionRegistry.test.ts
git commit -m "feat(monaco): add shared authoritative sessions"
```

---

### Task 9: Render Bullets and Register the Monaco Contribution

**Files:**
- Create: `apps/desktop/src/monaco-outline/decorations.ts`
- Test: `apps/desktop/src/monaco-outline/decorations.test.ts`
- Create: `apps/desktop/src/monaco-outline/plugin.ts`
- Test: `apps/desktop/src/monaco-outline/plugin.test.ts`
- Modify: `apps/desktop/src/monaco-outline/session.ts`
- Modify: `apps/desktop/src/notes.css`

**Interfaces:**
- Consumes: session metadata, internal adapter, pane binding.
- Produces: one model-level bullet decoration set and one registered Yonalist contribution with Tab and injected-text behavior.

- [x] **Step 1: Write failing decoration and plugin tests**

```ts
it("renders depth and bullet as injected text at model column one", () => {
  const decorations = buildOutlineDecorations([
    line("root", "page", 0),
    line("child", "root", 1)
  ], [1, 2]);
  expect(decorations[1]?.range).toEqual(new monaco.Range(2, 1, 2, 1));
  expect(decorations[1]?.options.before).toMatchObject({
    content: expect.stringContaining("•"),
    attachedData: {
      kind: "yonalist-bullet",
      nodeId: "child"
    }
  });
});

it("routes Tab only when the Yonalist outline context is active", () => {
  const binding = fakeBinding();
  runOutlineCommand("yonalist.outline.indent", binding);
  expect(binding.session.indent).toHaveBeenCalledWith("child");
});
```

- [x] **Step 2: Run the tests and observe failure**

Run:

```powershell
npm test --prefix apps/desktop -- src/monaco-outline/decorations.test.ts src/monaco-outline/plugin.test.ts
```

Expected: missing modules.

- [x] **Step 3: Implement one model-level decoration owner**

Use:

```ts
export class OutlineDecorationSet {
  constructor(
    model: monaco.editor.ITextModel,
    metadata: () => OutlineMetadataSnapshot
  );
  update(affectedLineNumbers: readonly number[]): void;
  dispose(): void;
}
```

Each zero-length decoration at column 1 uses
`before.content = "\u00a0".repeat(depth * 4) + "\u2022\u00a0\u00a0"`,
`InjectedTextCursorStops.Right`, and attached data
`{ kind: "yonalist-bullet", nodeId }`. Store decoration IDs by node ID and
replace only affected nodes. Create one `OutlineDecorationSet` per session,
not per pane, so shared editors do not duplicate bullets.

- [x] **Step 4: Register one generic contribution**

Expose:

```ts
export interface YonalistOutlineEditorBinding {
  readonly session: MonacoOutlineSession;
  readonly pane: MonacoOutlinePaneAdapter;
}

export function registerYonalistOutlinePlugin(): void;
export function bindYonalistOutlineEditor(
  editor: monaco.editor.IStandaloneCodeEditor,
  binding: YonalistOutlineEditorBinding
): monaco.IDisposable;
```

Registration is idempotent. The contribution uses a `WeakMap` from editor to
binding, a `yonalistOutlineEditor` context key, high-priority Tab/Shift+Tab
commands, injected bullet mouse routing, and the adapter's injected-text
affinity path. A high-priority Backspace/Delete preflight calls
`canApplyNativeBoundaryEdit` only when a selection crosses a model newline;
valid boundaries delegate to Monaco and invalid tree boundaries are consumed.
Enter, Tab, boundary deletion, and multi-line paste are consumed when
`session.canAcceptStructuralEdit()` is false because the queue is in Conflict,
Fatal, or overflow state. Otherwise Enter and valid newline edits delegate to
Monaco. Same-line Backspace/Delete, arrows, selection, clipboard, Find, and
composition always stay on Monaco's native path.

- [x] **Step 5: Replace hybrid normalization CSS**

Remove `[data-caret-normalizing]` cursor hiding. Add scoped classes:

```css
.notes-monaco-outline .yonalist-outline-injected-bullet {
  color: var(--text-2);
}
```

Copy existing font, line height, bullet color, and indent token values; do not
change numeric design values.

- [x] **Step 6: Run focused tests and build**

Run:

```powershell
npm test --prefix apps/desktop -- src/monaco-outline/decorations.test.ts src/monaco-outline/plugin.test.ts src/monaco-outline/internalAdapter.test.ts
npm run build --prefix apps/desktop
```

Expected: pass.

- [x] **Step 7: Commit**

```powershell
git add -- apps/desktop/src/monaco-outline/decorations.ts apps/desktop/src/monaco-outline/decorations.test.ts apps/desktop/src/monaco-outline/plugin.ts apps/desktop/src/monaco-outline/plugin.test.ts apps/desktop/src/monaco-outline/session.ts apps/desktop/src/notes.css
git commit -m "feat(monaco): add outline editor contribution"
```

---

### Task 10: Add Pane-Local Zoom and Shared Split Views

**Files:**
- Create: `apps/desktop/src/monaco-outline/paneAdapter.ts`
- Test: `apps/desktop/src/monaco-outline/paneAdapter.test.ts`
- Modify: `apps/desktop/src/monaco-outline/plugin.ts`

**Interfaces:**
- Consumes: shared session model, pane editor, metadata, injected bullet attachment.
- Produces: independent hidden ranges, focus, selection, scroll, zoom, normal-click navigation, and Shift+click split navigation.

- [x] **Step 1: Write failing pane tests**

```ts
it("computes hidden ranges for a zoomed subtree", () => {
  const metadata = snapshot(1, [
    line("a", "page", 0),
    line("a-child", "a", 1),
    line("b", "page", 0)
  ]);
  expect(visibleRangesForZoom(metadata, "a")).toEqual([
    new monaco.Range(1, 1, 2, 1)
  ]);
  expect(hiddenRangesForZoom(metadata, "a")).toEqual([
    new monaco.Range(3, 1, 3, 1)
  ]);
});

it("normal click zooms locally and Shift click opens secondary", () => {
  const navigation = fakeNavigation();
  routeBulletClick({ nodeId: "a", shiftKey: false }, navigation);
  expect(navigation.zoomSamePane).toHaveBeenCalledWith("a");
  routeBulletClick({ nodeId: "a", shiftKey: true }, navigation);
  expect(navigation.openSecondary).toHaveBeenCalledWith("a");
});
```

- [x] **Step 2: Run the test and observe failure**

Run:

```powershell
npm test --prefix apps/desktop -- src/monaco-outline/paneAdapter.test.ts
```

Expected: missing module.

- [x] **Step 3: Implement the pane adapter**

Expose:

```ts
export interface OutlinePaneNavigation {
  zoomSamePane(nodeId: string): void;
  openSecondary(nodeId: string): void;
}

export class MonacoOutlinePaneAdapter {
  constructor(input: {
    readonly paneId: "primary" | "secondary";
    readonly editor: monaco.editor.IStandaloneCodeEditor;
    readonly session: MonacoOutlineSession;
    readonly zoomRootId: string | null;
    readonly showCompleted: boolean;
    readonly navigation: OutlinePaneNavigation;
  });
  setZoomRoot(nodeId: string | null): void;
  setShowCompleted(value: boolean): void;
  handleBullet(nodeId: string, shiftKey: boolean): void;
  dispose(): void;
}
```

Use `setEditorHiddenAreas(editor, ranges, sourceToken)` from the internal
adapter. Do not edit model text for zoom. Save and restore each editor's view
state on pane-local zoom changes.

- [x] **Step 4: Prove two adapters do not share view state**

Extend the test with two fake editors over one model. Set different selections,
scroll positions, and zoom roots, edit the shared model, then assert only the
text is shared.

- [x] **Step 5: Run focused tests**

Run:

```powershell
npm test --prefix apps/desktop -- src/monaco-outline/paneAdapter.test.ts src/monaco-outline/plugin.test.ts
```

Expected: pass.

- [x] **Step 6: Commit**

```powershell
git add -- apps/desktop/src/monaco-outline/paneAdapter.ts apps/desktop/src/monaco-outline/paneAdapter.test.ts apps/desktop/src/monaco-outline/plugin.ts apps/desktop/src/monaco-outline/plugin.test.ts
git commit -m "feat(monaco): add pane-local outline views"
```

---

### Task 11: Wire the Thin React Surface and Application Lifecycle

**Files:**
- Modify: `apps/desktop/src/MonacoOutlineSurface.tsx`
- Test: `apps/desktop/src/MonacoOutlineSurface.test.tsx`
- Modify: `apps/desktop/src/NotesOutline.tsx`
- Modify: `apps/desktop/src/NotesDetailPanes.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Test: `apps/desktop/src/App.test.tsx`
- Test: `apps/desktop/src/splitPaneIntegration.test.tsx`
- Test: `apps/desktop/src/closeSession.test.ts`

**Interfaces:**
- Consumes: session registry, plugin, pane adapter, store full-page and persistence ports.
- Produces: query-gated authoritative Monaco surface, shared split model, correct Undo routing, navigation flush, and close flush.

- [x] **Step 1: Write failing React integration tests**

Add tests that mock only editor creation, not session behavior:

```tsx
it("leases the active page session and passes pane-local zoom", async () => {
  render(<MonacoOutlineSurface
    pageId="page"
    paneId="secondary"
    zoomRootId="child"
    showCompleted
    registry={registry}
    onZoomRootChange={onZoom}
    onOpenSplit={onOpenSplit}
  />);
  await waitFor(() => expect(registry.acquire).toHaveBeenCalledWith("page"));
  expect(createPaneAdapter).toHaveBeenCalledWith(expect.objectContaining({
    paneId: "secondary",
    zoomRootId: "child"
  }));
});

it("does not route Ctrl+Z from Monaco to NotesInteractionHistory", () => {
  const target = document.createElement("textarea");
  target.closest = vi.fn().mockReturnValue(
    document.createElement("div")
  );
  expect(shouldRouteUndoToApplication(target, true)).toBe(false);
});

it("falls back to the React outline when the Monaco adapter is incompatible", async () => {
  registry.acquire.mockRejectedValueOnce(
    new UnsupportedMonacoPageError("cursorAffinity")
  );
  renderMonacoBoundary();
  expect(await screen.findByRole("list")).toHaveAttribute(
    "data-outline-fallback",
    "monaco-unsupported"
  );
});

it("shows only the native empty Monaco line without placeholder copy", async () => {
  renderEmptyMonacoPage();
  expect(screen.queryByText("No outline yet.")).not.toBeInTheDocument();
  expect(screen.queryByText(
    "Press Enter to add another thought."
  )).not.toBeInTheDocument();
});
```

Extend split integration to assert primary and secondary surfaces receive the
same model object and keep separate active positions.

- [x] **Step 2: Run focused tests and observe failures**

Run:

```powershell
npm test --prefix apps/desktop -- src/MonacoOutlineSurface.test.tsx src/App.test.tsx src/splitPaneIntegration.test.tsx src/closeSession.test.ts
```

Expected: failures for the new registry and surface props.

- [x] **Step 3: Reduce `MonacoOutlineSurface` to lifecycle ownership**

The component body must follow this shape:

```tsx
useEffect(() => {
  let lease: MonacoSessionLease | null = null;
  let editor: monaco.editor.IStandaloneCodeEditor | null = null;
  let pane: MonacoOutlinePaneAdapter | null = null;
  let binding: monaco.IDisposable | null = null;
  void registry.acquire(pageId).then((nextLease) => {
    if (!hostRef.current) {
      void nextLease.release();
      return;
    }
    lease = nextLease;
    editor = monaco.editor.create(hostRef.current, editorOptions(nextLease.session.model));
    pane = new MonacoOutlinePaneAdapter({
      paneId,
      editor,
      session: nextLease.session,
      zoomRootId,
      showCompleted,
      navigation
    });
    binding = bindYonalistOutlineEditor(editor, {
      session: nextLease.session,
      pane
    });
  });
  return () => {
    binding?.dispose();
    pane?.dispose();
    editor?.dispose();
    void lease?.release();
  };
}, [pageId, paneId, registry]);
```

Update zoom and completed state through pane methods without recreating the
editor. Remove all projection, controller, keyboard, pending-caret, store
subscription, and reconciliation imports.

- [x] **Step 4: Create the registry in `App` and pass it to both panes**

Construct once:

```ts
const monacoSessions = useMemo(
  () => new MonacoOutlineSessionRegistry({
    loadPage: (pageId) => store.loadMonacoPage(pageId),
    executeEditorBatch: (requestId, commands) =>
      store.executeEditorBatch(requestId, commands)
  }),
  [store]
);
```

Pass it through `NotesDetailPanes` and `NotesOutline`. `NotesOutline`
initially selects Monaco only when:

```ts
outlineSurface === "monaco" &&
allBodyNodes.every((node) =>
  node.kind === "bullet" && node.note.trim().length === 0
)
```

`MonacoOutlineSurface` reports `UnsupportedMonacoPageError` through an
`onUnsupported` callback if the complete load discovers an image, supporting
note, incomplete cursor, more than 50,000 nodes, or a failed internal capability
probe. `NotesOutline` records that page ID locally, disposes the partial lease,
and renders the React outline. Include an accessible status explaining that
the Monaco text experiment is using the standard editor for this page.

Render `No outline yet.` only in the React branch. An empty Monaco session
uses `ensureEditableLine()` and displays only its injected bullet and caret;
do not render instructional placeholder copy.

After acquiring a session, subscribe to its coarse persistence state with
`useSyncExternalStore`. Render an adjacent `role="status"` message for Unsaved
and Saving, and a `role="alert"` message for Conflict and Fatal. Do not mirror
model text into React state.

- [x] **Step 5: Route Undo and flush lifecycle boundaries**

In the global key handler:

```ts
if (monacoSessions.hasFocusedEditor(event.target)) return;
```

Before page navigation:

```ts
await monacoSessions.flushPage(currentPageId, "navigation");
await store.flushAllDrafts();
```

Before window destruction:

```ts
await monacoSessions.flushAll("close");
await store.close();
```

If either flush rejects, keep the window open through the existing
`createCloseRequestHandler`.

- [x] **Step 6: Run focused integration tests**

Run:

```powershell
npm test --prefix apps/desktop -- src/MonacoOutlineSurface.test.tsx src/App.test.tsx src/splitPaneIntegration.test.tsx src/closeSession.test.ts
```

Expected: pass.

- [x] **Step 7: Commit**

```powershell
git add -- apps/desktop/src/MonacoOutlineSurface.tsx apps/desktop/src/MonacoOutlineSurface.test.tsx apps/desktop/src/NotesOutline.tsx apps/desktop/src/NotesDetailPanes.tsx apps/desktop/src/App.tsx apps/desktop/src/App.test.tsx apps/desktop/src/splitPaneIntegration.test.tsx apps/desktop/src/closeSession.test.ts
git commit -m "feat(monaco): wire authoritative outline surface"
```

---

### Task 12: Harden Native Editing and Measure the Real Renderer

**Files:**
- Create: `apps/desktop/src/monaco-outline/runtimeProbe.ts`
- Create: `apps/desktop/src/monaco-outline/nativeEditing.test.ts`
- Create: `apps/desktop/src/monaco-outline/performance.test.ts`
- Modify: `apps/desktop/src/MonacoOutlineSurface.tsx`
- Modify: `docs/v2/monaco-outline-spike-report.md`

**Interfaces:**
- Consumes: completed session, plugin, pane adapter, development browser runtime.
- Produces: regression coverage for native edits and real sampled browser timing evidence.

- [x] **Step 1: Add native editing characterization tests**

Use real Monaco models and the session:

```ts
it("middle Enter places the model selection before the suffix", () => {
  const { editor, session } = mountedTestEditor("Changes appear instantly.");
  editor.setPosition({ lineNumber: 1, column: 9 });
  editor.trigger("keyboard", "type", { text: "\n" });
  expect(session.model.getValue()).toBe("Changes \nappear instantly.");
  expect(editor.getPosition()).toEqual({ lineNumber: 2, column: 1 });
});

it("twenty Enter and twenty Backspace operations remain contiguous", () => {
  const { editor, session } = mountedTestEditor("alpha");
  editor.setPosition({ lineNumber: 1, column: 6 });
  for (let index = 0; index < 20; index += 1) {
    editor.trigger("keyboard", "type", { text: "\n" });
  }
  expect(session.model.getLineCount()).toBe(21);
  expect(session.metadata.current().lines).toHaveLength(21);
  for (let index = 0; index < 20; index += 1) {
    editor.trigger("keyboard", "deleteLeft", null);
  }
  expect(session.model.getLineCount()).toBe(1);
  expect(session.metadata.current().lines).toHaveLength(1);
});

it("composition edits never call setValue or session hydration", () => {
  vi.useFakeTimers();
  const { editor, session, persistence } = mountedTestEditor("");
  editor.trigger("keyboard", "type", { text: "ㅎ" });
  editor.trigger("keyboard", "type", { text: "하" });
  editor.trigger("keyboard", "type", { text: "한" });
  expect(session.metrics.fullModelReplacementCount).toBe(0);
  await vi.advanceTimersByTimeAsync(300);
  expect(persistence.executeEditorBatch).toHaveBeenCalledTimes(1);
  expect(persistence.executeEditorBatch).toHaveBeenCalledWith(
    expect.any(String),
    [{ kind: "updateText", id: expect.any(String), text: "한" }]
  );
});

it("keeps injected bullets out of model search and clipboard text", () => {
  const session = sessionWithLines(["alpha", "beta"]);
  expect(session.model.findMatches(
    "\u2022",
    false,
    false,
    false,
    null,
    true
  )).toHaveLength(0);
  expect(session.model.getValueInRange(
    session.model.getFullModelRange()
  )).toBe("alpha\nbeta");
});
```

Define `mountedTestEditor` in the test file to create a real standalone editor
bound through `bindYonalistOutlineEditor`; dispose its editor, session, and DOM
host after each test. Use Monaco's composition events in the browser runtime
proof because jsdom cannot reproduce the platform IME event stream.

Add an Undo/Redo sequence interleaving text, Enter, indent, outdent, and
Backspace. Assert text, node IDs, parent IDs, depths, and caret.

- [x] **Step 2: Run the characterization tests**

Run:

```powershell
npm test --prefix apps/desktop -- src/monaco-outline/nativeEditing.test.ts
```

Expected: pass before deleting hybrid code.

- [x] **Step 3: Add a development-only runtime probe**

Load only under:

```ts
if (
  import.meta.env.DEV &&
  new URLSearchParams(location.search).get("probe") === "monaco"
) {
  void import("./monaco-outline/runtimeProbe").then(({ attachRuntimeProbe }) =>
    attachRuntimeProbe(editor, session)
  );
}
```

Expose a frozen development object:

```ts
interface MonacoOutlineProbeResult {
  readonly samples: readonly number[];
  readonly p50: number;
  readonly p95: number;
  readonly longTasks: number;
  readonly lineCount: number;
  readonly modelSetValueCount: number;
}
```

Measure `keydown` to the next `requestAnimationFrame`, observe long tasks, and
count calls to the session's hydration-only model setter. The production build
must tree-shake this dynamic development branch.

- [x] **Step 4: Replace the projection microbenchmark**

The deterministic test creates a 5,000-line real Monaco model and applies 200
text edits plus 100 line splits through the session:

```ts
expect(session.model.getLineCount()).toBe(5_100);
expect(session.metrics.fullModelReplacementCount).toBe(0);
expect(session.metrics.maxDecorationLinesPerEdit).toBeLessThanOrEqual(3);
```

This test guards algorithmic boundedness; the runtime probe supplies paint
timing.

- [x] **Step 5: Run focused tests and a production bundle**

Run:

```powershell
npm test --prefix apps/desktop -- src/monaco-outline/nativeEditing.test.ts src/monaco-outline/performance.test.ts
npm run build --prefix apps/desktop
```

Expected: tests pass and the query-free initial graph remains free of Monaco.

- [x] **Step 6: Run a fresh browser sample**

Start a fresh preview:

```powershell
npm run dev --prefix apps/desktop -- --port 1422
```

Open:

```text
http://127.0.0.1:1422/?outline=monaco&probe=monaco
```

Load the 5,000-node fixture, run 200 sampled core edits, and record:

```text
p50 input-to-paint
p95 input-to-paint
long tasks over 50 ms
model line count
full model replacement count
secondary-pane same-turn reflection
```

Repeat the same input sample on the React v2 control. Add both results and the
lazy Monaco JS/CSS/worker sizes to `docs/v2/monaco-outline-spike-report.md`.
Acceptance requires Monaco p95 at most 20 ms and zero long tasks in the sampled
core interaction loop.

Capture React and Monaco screenshots for loaded, empty-line, split, zoomed,
focused, and selected states at the same viewport. Compare content origin,
line height, bullet position, wrap width, font metrics, colors, and pane
geometry. Any numeric CSS change from the React reference fails this slice;
record the comparison result in the report.

- [x] **Step 7: Commit**

```powershell
git add -- apps/desktop/src/monaco-outline/runtimeProbe.ts apps/desktop/src/monaco-outline/nativeEditing.test.ts apps/desktop/src/monaco-outline/performance.test.ts apps/desktop/src/MonacoOutlineSurface.tsx docs/v2/monaco-outline-spike-report.md
git commit -m "perf(monaco): verify native outline editing"
```

---

### Task 13: Remove the Hybrid Authority and Complete Verification

**Files:**
- Delete: all legacy hybrid Monaco files listed in “Removed after the new slice passes”.
- Modify: `apps/desktop/src/notes.css`
- Modify: `docs/superpowers/plans/2026-07-31-yonalist-monaco-authoritative-outliner.md`
- Verify: all frontend, Rust, architecture, contracts, bundle, Clippy, and fresh Tauri boundaries.

**Interfaces:**
- Consumes: passing authoritative vertical slice and runtime evidence.
- Produces: no store-authoritative Monaco path in the experimental production graph and a reconciled completed plan.

- [x] **Step 1: Prove no new module imports the hybrid path**

Run:

```powershell
rg -n "monacoOutline(Projection|Controller|Commands|Keyboard|Caret|Focus|Reconciliation|Seed)" apps/desktop/src
```

Expected: only the files scheduled for deletion and historical documentation
match.

- [x] **Step 2: Delete the hybrid modules and stale CSS**

Delete the exact files in the removal list. Remove:

```text
projection reconciliation
manual pending caret
cursorRight/cursorLeft correction
store-authoritative structural key interception
hybrid Undo dispatch
data-caret-normalizing styles
```

Keep `MonacoOutlineSurface.tsx`, the query flag, the React outline, and the new
`monaco-outline/` directory.

- [x] **Step 3: Run focused tests after deletion**

Run:

```powershell
npm test --prefix apps/desktop -- src/monaco-outline src/MonacoOutlineSurface.test.tsx src/splitPaneIntegration.test.tsx
```

Expected: pass with no deleted-module import.

- [x] **Step 4: Run the complete frontend gates once**

Run:

```powershell
npm test --prefix apps/desktop
npm run lint:v2
npm run v2:build
npm run test:v2:architecture
npm run test:v2:contracts
npm run test:v2:bundle
```

Expected: all pass. Record any pre-existing warning separately; do not rerun a
flaky failure solely to obtain a pass.

- [x] **Step 5: Run the complete Rust gates and Clippy once**

Run:

```powershell
cargo test --workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: all pass. Clippy is required because Rust, IPC, and persistence
boundaries changed.

- [x] **Step 6: Run repository and diff gates**

Run:

```powershell
npm run test:plans
git diff --check
git status --short
```

Expected: historical plan check and diff check pass; status contains only the
intended implementation and this reconciled plan.

- [ ] **Step 7: Perform fresh isolated Tauri proof**

Use a new explicit data directory:

```powershell
$proofRoot = Join-Path $env:TEMP ("yonalist-monaco-proof-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $proofRoot | Out-Null
$env:YONALIST_V2_DATA_DIR = $proofRoot
npm run v2:tauri:dev
```

In `?outline=monaco` verify:

1. create a bullet and type Korean IME text;
2. split at start, middle, and end;
3. hold Enter for 20 lines and Backspace back to one;
4. move with arrows, Home, End, Page Up, and Page Down;
5. Tab and Shift+Tab, then Undo/Redo through the full sequence;
6. normal bullet click zooms the same pane;
7. Shift+bullet opens the secondary pane;
8. edits appear immediately in both panes without moving the other pane's
   selection or scroll;
9. close and restart, confirming the acknowledged state;
10. simulate a rejected close flush and confirm the window remains open.

This isolated native-window proof was not run in this delivery. The existing
development browser preview covered native model editing, shared split panes,
zoom navigation, persistence reload, Undo, and the renderer latency sample;
the unchecked step above preserves the remaining Tauri-only evidence gap.

After the app exits, remove only the generated `$proofRoot` and clear the
environment variable:

```powershell
Remove-Item Env:YONALIST_V2_DATA_DIR
Remove-Item -LiteralPath $proofRoot -Recurse -Force
```

- [x] **Step 8: Reconcile the plan and commit**

Mark completed checkboxes in this plan only for commands and manual rows
actually exercised. Then:

```powershell
git add -u -- apps/desktop/src/monacoOutlineCaret.ts apps/desktop/src/monacoOutlineCaret.test.ts apps/desktop/src/monacoOutlineCommands.ts apps/desktop/src/monacoOutlineCommands.test.ts apps/desktop/src/monacoOutlineController.ts apps/desktop/src/monacoOutlineController.test.ts apps/desktop/src/monacoOutlineFocus.ts apps/desktop/src/monacoOutlineFocus.test.ts apps/desktop/src/monacoOutlineKeyboard.ts apps/desktop/src/monacoOutlineKeyboard.test.ts apps/desktop/src/monacoOutlineProjection.ts apps/desktop/src/monacoOutlineProjection.test.ts apps/desktop/src/monacoOutlineReconciliation.ts apps/desktop/src/monacoOutlineReconciliation.test.ts apps/desktop/src/monacoOutlineSeed.ts apps/desktop/src/monacoOutlineSeed.test.ts apps/desktop/src/monacoOutlinePerformance.test.ts apps/desktop/src/notes.css
git add -- docs/superpowers/plans/2026-07-31-yonalist-monaco-authoritative-outliner.md
git commit -m "refactor(monaco): make model the edit authority"
```

Do not include unrelated files.
