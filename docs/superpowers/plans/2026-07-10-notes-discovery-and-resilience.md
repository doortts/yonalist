<!-- reconciliation: auditedHead=ec8a9ff3d016449255992adf70e128ea5e222e9a status=complete -->
> **증거 대조 상태 (2026-07-19): 완료.** commit·artifact 근거는 [감사 ledger](../reports/2026-07-19-historical-plan-ledger.json)에 기록했다.

# Notes Discovery and Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local search, tags, starred/recent/trash navigation, serialized debounced writes, recoverable errors, and explicit Notes data lifecycle controls.

**Architecture:** SQLite remains the single authority. Native search and tag projection extend the Notes repository; the renderer keeps draft text and a per-vault write queue, then replaces confirmed state from command responses. The library pane queries explicit views rather than deriving long lists in React.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, rusqlite SQLite FTS5, Tauri commands, existing Base UI ConfirmDialog.

## Global Constraints

- Full-text search and tag extraction remain local and run against `notes.sqlite` only.
- Preserve all Phase 2 tree invariants while adding views and query paths.
- A failed write restores the last confirmed projection and leaves the unsaved draft visible with a retry action.
- The write queue serializes all mutations for one vault; title and supporting-note writes debounce for 300 ms and flush on blur/unmount.
- The global reset flow must keep Notes data untouched.
- "Delete all Notes data" requires a Notes-specific destructive confirmation and cannot share the cache-reset action.
- Search does not evaluate remote syntax, execute SQL, or interpret `#tag` as a cross-feature GitHub filter.

---

## Target File Structure

| File | Responsibility |
| --- | --- |
| `src-tauri/src/notes/repository.rs` | FTS queries, tags, stars, scoped workspace queries, database removal |
| `src-tauri/src/notes/commands.rs` | Search, star, tags, and delete-database command wrappers |
| `src/domain/notes.ts` | Views, tag/search result types, error type |
| `src/domain/notes.test.ts` | Type and query normalization tests |
| `src/services/notesStore.ts` | Extended typed Notes API |
| `src/services/notesWriteQueue.ts` | Serialized deferred mutation queue |
| `src/services/notesWriteQueue.test.ts` | Order, debounce, flush, and retry tests |
| `src/features/notes/NotesLibraryPane.tsx` | View selection, search results, tags, trash controls |
| `src/features/notes/OutlineNodeRow.tsx` | Star control and draft persistence hooks |
| `src/features/notes/NotesDataSettingsDialog.tsx` | Confirmed delete-all-data action |
| `src/features/notes/useNotesWorkspace.ts` | Draft retention, retry, scoped reloads |

## Stable Interfaces

```ts
export type NotesWorkspaceScope =
  | { kind: "active" }
  | { kind: "starred" }
  | { kind: "recent" }
  | { kind: "tag"; tag: string }
  | { kind: "trash" };

export interface NoteSearchResult {
  nodeId: NoteId;
  title: string;
  parentTrail: string[];
  matchedField: "title" | "note";
}

export interface NotesStoreError extends Error {
  operation: "load" | "write" | "search" | "deleteData";
  retryable: boolean;
}

export interface NotesWriteQueue {
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  enqueueDebounced<T>(key: string, operation: () => Promise<T>): Promise<T>;
  flush(key?: string): Promise<void>;
}
```

This phase extends the Phase 2 `NotesWorkspaceScope` union and `NotesStore`
interface with `starred`, `recent`, `tag`, `search`, `toggleStar`, `listTags`,
and `deleteDatabase`; it does not create a parallel service contract.

### Task 1: Add FTS Search, Tags, Stars, and Scoped Native Queries

**Files:**
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/notes/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/domain/notes.ts`
- Modify: `src/domain/notes.test.ts`
- Modify: `src/services/notesStore.ts`
- Modify: `src/services/notesStore.tauri.test.ts`

**Interfaces:**
- Consumes: version-one `notes_nodes`, `notes_tags`, and `notes_search` tables from Phase 2.
- Produces: `notes_load_workspace(vaultPath, scope)`, `notes_search(vaultPath, query)`, `notes_toggle_star(vaultPath, nodeId)`, `notes_list_tags(vaultPath)`, and `notes_delete_database(vaultPath)`.

- [x] **Step 1: Write failing native query tests**

```rust
#[test]
fn update_indexes_tags_and_fts_content_together() {
    let mut connection = test_connection();
    let node = create_node(&mut connection, create_input("#Roadmap search target")).expect("create");
    update_node(&mut connection, UpdateNodeInput { id: node.id, title: "#Roadmap search target".into(), note: "#Offline detail".into() })
        .expect("update");

    assert_eq!(list_tags(&connection).expect("tags"), vec!["offline", "roadmap"]);
    assert_eq!(search_nodes(&connection, "target").expect("search")[0].node_id, node.id);
}

#[test]
fn starred_recent_tag_and_trash_scopes_are_disjoint() {
    let connection = seeded_scope_connection();
    assert_eq!(load_workspace(&connection, NotesWorkspaceScope::Starred).expect("starred").nodes.len(), 1);
    assert_eq!(load_workspace(&connection, NotesWorkspaceScope::Trash).expect("trash").nodes.len(), 1);
}
```

- [x] **Step 2: Run native query tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests::update_indexes_tags_and_fts_content_together notes::repository::tests::starred_recent_tag_and_trash_scopes_are_disjoint`

Expected: FAIL because the query API and tag synchronization are absent.

- [x] **Step 3: Implement FTS and scoped query behavior**

```sql
CREATE TRIGGER notes_nodes_after_insert_search
AFTER INSERT ON notes_nodes WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO notes_search(node_id, title, note) VALUES (NEW.id, NEW.title, NEW.note);
END;

CREATE TRIGGER notes_nodes_after_update_search
AFTER UPDATE OF title, note, deleted_at ON notes_nodes
BEGIN
  DELETE FROM notes_search WHERE node_id = OLD.id;
  INSERT INTO notes_search(node_id, title, note)
    SELECT NEW.id, NEW.title, NEW.note WHERE NEW.deleted_at IS NULL;
END;
```

The Phase 2 version-one migration installs these triggers. Add a transactional
version-two migration only for development databases created by a branch before
the trigger definition was finalized. `update_node` scans both title and note for `#` tokens,
normalizes Unicode case, strips a leading `#`, removes duplicates, and replaces
the node's `notes_tags` rows in the same transaction.

`search_nodes` trims whitespace, returns an empty list for an empty query,
passes escaped tokens to FTS5 `MATCH`, limits to 100 results, and returns a
parent trail assembled from live ancestors. It never concatenates a raw SQL
query string.

- [x] **Step 4: Run native and Tauri adapter tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests && npm test -- src/domain/notes.test.ts src/services/notesStore.tauri.test.ts`

Expected: PASS.

- [x] **Step 5: Commit discovery commands**

```bash
git add src-tauri/src/notes src-tauri/src/lib.rs src/domain/notes.ts src/domain/notes.test.ts src/services/notesStore.ts src/services/notesStore.tauri.test.ts
git commit -m "feat(notes): add local search tags and library views"
```

### Task 2: Implement Serialized Debounced Writes and Retryable State

**Files:**
- Create: `src/services/notesWriteQueue.ts`
- Create: `src/services/notesWriteQueue.test.ts`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/features/notes/NotesWorkspaceContext.ts`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: `NotesStore` mutation methods and normalized state from Phase 3.
- Produces: `createNotesWriteQueue`, `retryLastFailedWrite`, and `draftsByNodeId` behavior.

- [x] **Step 1: Write failing queue and recovery tests**

```ts
it("serializes writes even when the first command resolves last", async () => {
  const first = deferred<NotesWorkspace>();
  const second = deferred<NotesWorkspace>();
  repository.updateNode.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

  const queue = createNotesWriteQueue();
  const one = queue.enqueue(() => repository.updateNode("/vault", firstPatch));
  const two = queue.enqueue(() => repository.updateNode("/vault", secondPatch));
  expect(repository.updateNode).toHaveBeenCalledTimes(1);
  first.resolve(workspaceAfterFirst());
  await one;
  expect(repository.updateNode).toHaveBeenCalledTimes(2);
  second.resolve(workspaceAfterSecond());
  await two;
});

function renderNotesWorkspace() {
  return render(
    <NotesWorkspaceProvider>
      <NotesLibraryPane />
      <NotesOutlinePane />
    </NotesWorkspaceProvider>
  );
}

it("keeps a failed title draft visible and retries it", async () => {
  repository.updateNode.mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(workspaceAfterTitle());
  renderNotesWorkspace();
  await user.type(screen.getByRole("textbox", { name: "Edit node title: Page" }), " next");
  await user.tab();
  expect(await screen.findByRole("button", { name: "Retry save" })).toBeInTheDocument();
});
```

- [x] **Step 2: Run queue tests to verify they fail**

Run: `npm test -- src/services/notesWriteQueue.test.ts src/features/notes/NotesWorkspace.test.tsx`

Expected: FAIL because mutations currently issue independently and discard failed drafts.

- [x] **Step 3: Implement queue, drafts, and recovery rules**

```ts
export function createNotesWriteQueue(): NotesWriteQueue {
  let tail = Promise.resolve();
  const debounced = new Map<string, ReturnType<typeof setTimeout>>();

  const enqueue = <T>(operation: () => Promise<T>) => {
    const next = tail.then(operation, operation);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };

  return { enqueue, enqueueDebounced, flush };
}
```

Use 300 ms debounce for title/note changes. On blur, Enter structural action,
feature switch, or provider unmount, call `flush(nodeId)`. On a write failure,
reload the last confirmed workspace, preserve the local draft map, set a
`NotesStoreError` with operation `"write"`, and expose a `Retry save` command
that enqueues the exact failed patch.

- [x] **Step 4: Run queue and UI recovery tests to verify they pass**

Run: `npm test -- src/services/notesWriteQueue.test.ts src/features/notes/NotesWorkspace.test.tsx`

Expected: PASS.

- [x] **Step 5: Commit write resilience**

```bash
git add src/services/notesWriteQueue.ts src/services/notesWriteQueue.test.ts src/features/notes/useNotesWorkspace.ts src/features/notes/NotesWorkspaceContext.ts src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "feat(notes): serialize writes and recover failed drafts"
```

### Task 3: Add Library Views, Search Navigation, and Data Lifecycle UI

**Files:**
- Modify: `src/features/notes/NotesLibraryPane.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Create: `src/features/notes/NotesDataSettingsDialog.tsx`
- Create: `src/features/notes/NotesDataSettingsDialog.test.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src/services/appReset.test.ts`

**Interfaces:**
- Consumes: scoped load/search/star/tag/delete-data methods from Task 1 and queue/retry state from Task 2.
- Produces: active library view, search result selection, star control, trash restore/empty behavior, and confirmed database deletion.

- [x] **Step 1: Write failing interaction tests**

```tsx
it("opens a search result in its zoom context", async () => {
  repository.search.mockResolvedValue([{ nodeId: "child", title: "Target", parentTrail: ["Page"], matchedField: "title" }]);
  renderNotesWorkspace();
  await user.type(screen.getByRole("searchbox", { name: "Search notes" }), "Target");
  await user.click(await screen.findByRole("option", { name: /Target/ }));
  expect(screen.getByLabelText("Notes breadcrumb")).toHaveTextContent("Page");
  expect(screen.getByRole("textbox", { name: "Edit node title: Target" })).toHaveFocus();
});

it("requires confirmation before deleting the Notes database", async () => {
  render(<NotesDataSettingsDialog open onOpenChange={vi.fn()} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Delete all Notes data" }));
  expect(repository.deleteDatabase).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole("button", { name: "Delete Notes data" }));
  expect(repository.deleteDatabase).toHaveBeenCalledWith("/vault");
});
```

- [x] **Step 2: Run interaction tests to verify they fail**

Run: `npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesDataSettingsDialog.test.tsx src/services/appReset.test.ts`

Expected: FAIL because scoped views and the data dialog do not exist.

- [x] **Step 3: Implement the user-facing discovery controls**

Use an accessible `searchbox` in the Notes library, a compact list of
All/Starred/Recent/Tags/Trash views, and a standard icon button for star
toggling. Results select the node, set `zoomRootId` to the nearest root page,
expand each ancestor in the local projection, then focus the target title.

`NotesDataSettingsDialog` wraps the existing `ConfirmDialog`; its confirm
handler flushes pending writes, calls `notesDeleteDatabase`, clears Notes
context state, and returns the UI to an empty Notes workspace. It is separate
from `SettingsPage` reset controls. The existing reset test gains a native
fixture assertion that `.yonalist/notes.sqlite` remains present.

- [x] **Step 4: Run discovery and lifecycle tests to verify they pass**

Run: `npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesDataSettingsDialog.test.tsx src/services/appReset.test.ts && cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests`

Expected: PASS.

- [x] **Step 5: Commit Notes discovery UI**

```bash
git add src/features/notes src/services/appReset.test.ts
git commit -m "feat(notes): add search library views and data controls"
```

### Task 4: Verify the V1 Local-Only Reliability Contract

**Files:**
- Modify: `src/App.test.tsx`
- Modify: `README.md`

**Interfaces:**
- Consumes: all Notes V1 persistence, editor, discovery, and reset boundaries.
- Produces: a documented, test-enforced offline/auth isolation guarantee.

- [x] **Step 1: Add an auth/network isolation test**

```tsx
it("continues to edit Notes while offline and unsigned in", async () => {
  window.localStorage.removeItem("yonalist.auth.skipLogin.v1");
  render(<App initialOnline={false} />);
  await userEvent.setup().click(await screen.findByRole("button", { name: "Notes" }));
  expect(screen.getByLabelText("Notes outline")).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});
```

- [x] **Step 2: Run isolation test to verify it passes**

Run: `npm test -- src/App.test.tsx`

Expected: PASS.

- [x] **Step 3: Document local-only behavior**

Add a README bullet that Notes has no remote sync path and stores user data in
the selected vault's `.yonalist/notes.sqlite` file. State that cache reset does
not delete Notes and that users can use export for portability.

- [x] **Step 4: Run complete verification**

Run: `npm test && npm run build && cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all commands exit with status 0.

- [x] **Step 5: Commit the V1 reliability gate**

```bash
git add src/App.test.tsx README.md
git commit -m "test(notes): verify offline local workspace contract"
```
