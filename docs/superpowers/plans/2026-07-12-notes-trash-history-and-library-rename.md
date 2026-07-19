<!-- reconciliation: auditedHead=ec8a9ff3d016449255992adf70e128ea5e222e9a status=complete -->
> **증거 대조 상태 (2026-07-19): 완료.** commit·artifact 근거는 [감사 ledger](../reports/2026-07-19-historical-plan-ledger.json)에 기록했다.

# Notes Trash History And Library Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair `Move to Trash` for version-three databases that require history command kinds and add undoable inline renaming to selected active pages in the Notes library.

**Architecture:** Canonicalize the session-only history entry schema during the existing transactional version-three initialization and persist the already-validated command kind during journal finalization. Keep rename edit state inside `NotesLibraryPageRow`, while `NotesLibraryPane` adapts the existing draft/flush API into an asynchronous `onRename` callback so save failures retain the draft and successful saves use the authoritative Undo/Redo path.

**Tech Stack:** React 18, TypeScript, Base UI, Vitest/Testing Library, Tauri 2, Rust, rusqlite, SQLite.

## Global Constraints

- Work only in `/Users/doortts/repos/yonalist/.worktrees/notes-workflowy` on branch `codex/notes-workflowy`.
- Write each regression test first and observe it fail for the intended missing behavior.
- Preserve all Notes nodes, attachments, Archive/Trash state, and existing history rows during schema repair.
- Keep the first click on an inactive library row as Open; only a second title click on the selected active row starts rename.
- Enter and blur commit once, Escape cancels, and Archive/Trash rows remain read-only.
- Rename uses the existing draft/write queue and authoritative Notes Undo/Redo journal.
- Do not modify the user's unrelated `src/components/ui/composer-dock.css` change in the main worktree.

---

### Task 1: Canonical History Command Kind And Trash Regression

**Files:**
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/history.rs`

**Interfaces:**
- Consumes: `NotesHistoryContext { session_id, entry_id, command_kind }` and the transaction-local `notes_history_context` table.
- Produces: canonical `notes_history_entries.command_kind TEXT NOT NULL` and journal rows that persist `context.command_kind`.

- [x] **Step 1: Add failing schema and Trash-history tests**

In `repository.rs`, change the fresh-schema column expectation to include `command_kind`, and add a version-three repair test that builds the current five-column history table, inserts a row, initializes the database, then asserts both the row and a `legacy` command kind remain:

```rust
assert_eq!(
    table_columns(&connection, "notes_history_entries"),
    vec![
        "id", "session_id", "sequence", "is_undone",
        "estimated_bytes", "command_kind"
    ]
);
```

In `history.rs`, add a regression that makes `command_kind` required, journals a root Trash mutation, and verifies both the deletion and persisted command kind:

```rust
let context = history_context(1, "trash");
let result = journal(&mut connection, &context, |connection| {
    delete_node(connection, NODE_ID)
}).expect("trash with history command kind");
assert_eq!(result.history_entry_id.as_deref(), Some(context.entry_id.as_str()));
let stored: String = connection.query_row(
    "SELECT command_kind FROM notes_history_entries WHERE id = ?1",
    [&context.entry_id],
    |row| row.get(0),
).expect("stored command kind");
assert_eq!(stored, "trash");
```

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml fresh_database_creates_the_complete_version_three_schema
cargo test --manifest-path src-tauri/Cargo.toml version_three_initialization_repairs_history_command_kind
cargo test --manifest-path src-tauri/Cargo.toml notes_history_trash_persists_command_kind
```

Expected: failures show the missing persistent column and the `NOT NULL constraint failed: notes_history_entries.command_kind` reproduction.

- [x] **Step 3: Implement transactional same-version repair**

Add this focused helper in `repository.rs` and call it after the version match but before derived-index repairs:

```rust
fn ensure_history_command_kind(transaction: &Transaction<'_>) -> Result<(), String> {
    let has_column = transaction
        .prepare("PRAGMA table_info(notes_history_entries)")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| format!(
            "Could not inspect Notes history command kinds: {error}"
        ))?
        .iter()
        .any(|column| column == "command_kind");
    if has_column {
        return Ok(());
    }
    transaction
        .execute_batch(
            "ALTER TABLE notes_history_entries \
             ADD COLUMN command_kind TEXT NOT NULL DEFAULT 'legacy';",
        )
        .map_err(|error| format!(
            "Could not repair Notes history command kinds: {error}"
        ))
}
```

Add `command_kind TEXT NOT NULL` to fresh version-three table creation. Existing v1/v2 upgrade paths receive it through the same version-three migration.

- [x] **Step 4: Persist the command kind during finalization**

Read all three context values and insert the fourth history field in `history.rs`:

```rust
let context = transaction.query_row(
    "SELECT session_id, entry_id, command_kind FROM notes_history_context LIMIT 1",
    [],
    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
)?;

transaction.execute(
    "INSERT INTO notes_history_entries(id, session_id, sequence, command_kind) \
     VALUES (?1, ?2, ?3, ?4)",
    params![context.1, context.0, sequence, context.2],
)?;
```

Retain the current atomic transaction so a history error still rolls back the Trash mutation.

- [x] **Step 5: Run focused and complete Rust verification**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes_history
cargo test --manifest-path src-tauri/Cargo.toml notes::repository
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Expected: all tests pass, schema repair preserves rows, and Trash Undo succeeds.

- [x] **Step 6: Review and commit Task 1**

Review the Task 1 diff for fresh/v1/v2/current-v3 convergence and mutation rollback. Fix every validated Important issue, rerun the commands above, then commit:

```bash
git add src-tauri/src/notes/repository.rs src-tauri/src/notes/history.rs
git commit -m "fix(notes): persist history command kinds"
```

---

### Task 2: Selected-Row Inline Rename

**Files:**
- Modify: `src/features/notes/NotesLibraryPageRow.tsx`
- Modify: `src/features/notes/NotesLibraryPageRow.test.tsx`
- Modify: `src/features/notes/NotesLibraryPane.tsx`
- Modify: `src/features/notes/NotesLibraryPane.test.tsx`
- Modify: `src/features/notes/notes.css`

**Interfaces:**
- Consumes: `actions.updateNodeDraft(nodeId, { title, note }, "title")` and `actions.flushNodeDraft(nodeId): Promise<boolean>`.
- Produces: `NotesLibraryPageRowProps.onRename(title: string): Promise<boolean>` and active-row display/edit state.

- [x] **Step 1: Add failing row interaction tests**

Extend the row test renderer with `onRename`. Add tests with these exact assertions:

```tsx
await user.click(screen.getByRole("button", { name: "Project" }));
expect(onOpen).toHaveBeenCalledOnce();
expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

rerender(<NotesLibraryPageRow {...props} active />);
await user.click(screen.getByRole("button", { name: "Project" }));
const input = screen.getByRole("textbox", { name: "Rename Project" });
expect(input).toHaveFocus();
expect(input).toHaveValue("Project");
```

Add independent tests for Enter, blur, Escape, failed saves, whitespace titles, menu isolation, and Archive/Trash read-only behavior. Enter and blur must call `onRename` exactly once.

- [x] **Step 2: Run row tests and verify RED**

Run:

```bash
npm test -- src/features/notes/NotesLibraryPageRow.test.tsx --maxWorkers=1
```

Expected: TypeScript/test failures show that `onRename` and rename mode do not exist.

- [x] **Step 3: Implement the row state machine**

Add local state and refs:

```tsx
const [editing, setEditing] = useState(false);
const [editTitle, setEditTitle] = useState(node.title);
const [saving, setSaving] = useState(false);
const skipBlurCommitRef = useRef(false);
const renameInputRef = useRef<HTMLInputElement>(null);
```

On an active-mode selected row title click, prevent Open and enter edit mode. Focus and select the input in a layout effect. Implement one guarded commit:

```tsx
const commitRename = async () => {
  if (saving) return;
  if (editTitle === node.title) {
    setEditing(false);
    return;
  }
  setSaving(true);
  const saved = await onRename(editTitle);
  setSaving(false);
  if (saved) setEditing(false);
};
```

Escape suppresses blur commit, restores `node.title`, exits edit mode, and does not save. Enter prevents default and calls the same commit. Blur calls the same commit unless Escape suppressed it. While IME composition is active, Enter must not commit.

- [x] **Step 4: Add the Notes library adapter tests**

In `NotesLibraryPane.test.tsx`, render an active root, enter rename, commit `Renamed`, and assert:

```tsx
expect(workspace.actions.updateNodeDraft).toHaveBeenCalledWith(
  root.id,
  { title: "Renamed", note: root.note },
  "title",
);
expect(workspace.actions.flushNodeDraft).toHaveBeenCalledWith(root.id);
```

Mock `flushNodeDraft` to return `false` and assert the input remains with `Renamed`; return `true` and assert it closes. Render Archive and Trash views and assert no rename input can be opened.

- [x] **Step 5: Implement the library adapter**

Pass this callback only for active rows:

```tsx
onRename={async (title) => {
  if (libraryView === "archive" || libraryView === "trash") return false;
  actions.updateNodeDraft(nodeId, { title, note: node.note }, "title");
  return actions.flushNodeDraft(nodeId);
}}
```

Build the row's visible node from `draftsByNodeId[nodeId]` when present, using both
its title and supporting note. This prevents a library rename from overwriting an
open supporting-note draft and keeps a failed rename visible after rerender. Add a
stable single-line input style inside the existing 38px row without changing row or
menu column dimensions.

- [x] **Step 6: Run focused frontend verification**

Run:

```bash
npm test -- src/features/notes/NotesLibraryPageRow.test.tsx src/features/notes/NotesLibraryPane.test.tsx src/features/notes/useNotesWorkspace.test.tsx --maxWorkers=1
```

Expected: all tests pass with Enter/blur deduplicated and save failure retained.

- [x] **Step 7: Review and commit Task 2**

Review focus/blur races, menu isolation, Archive/Trash read-only behavior, Korean IME safety, and accessible naming. Fix every validated Important issue, rerun focused tests, then commit:

```bash
git add src/features/notes/NotesLibraryPageRow.tsx \
  src/features/notes/NotesLibraryPageRow.test.tsx \
  src/features/notes/NotesLibraryPane.tsx \
  src/features/notes/NotesLibraryPane.test.tsx \
  src/features/notes/notes.css
git commit -m "feat(notes): rename pages from the library"
```

---

### Task 3: Integrated Regression And Visual Verification

**Files:**
- Modify only if a validated integration finding requires a correction.

**Interfaces:**
- Consumes: canonical command-kind history and `NotesLibraryPageRow.onRename`.
- Produces: reviewed, runnable Notes behavior with a clean worktree.

- [x] **Step 1: Run full automated verification**

Run:

```bash
npm test -- --maxWorkers=1
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
git diff --check
```

Expected: all functional tests and the production build pass.

- [x] **Step 2: Run the native app and verify the user workflows**

Start `npm run tauri:dev`, then verify in the native window:

1. Select an active root, click its title again, rename it, and press Enter.
2. Undo and Redo restore both names.
3. Open the row menu, choose Move to Trash, confirm, and observe no history error.
4. Undo restores the page and its title.
5. Escape cancels a second rename and the action menu still opens independently.

- [x] **Step 3: Dispatch final adversarial review**

Ask a fresh reviewer to attack schema convergence, existing required-column databases, history atomicity, rename blur/Enter duplication, stale row props, failed flush retention, IME, Archive/Trash policy, and Undo focus. Correct every validated Critical or Important finding and rerun the relevant tests.

- [x] **Step 4: Record final status**

Confirm `git status --short --branch` is clean, keep the Tauri app running for user inspection, and report test counts, commits, review outcome, and residual risk.
