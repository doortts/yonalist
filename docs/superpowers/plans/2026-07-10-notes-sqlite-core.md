# Notes SQLite Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a separate Notes SQLite database and typed Tauri command boundary that safely persists an ordered, nested, recoverable outline tree.

**Architecture:** Native Notes code lives under `src-tauri/src/notes/`, separate from the existing vault index in `src-tauri/src/lib.rs`. Each structural operation uses one SQLite transaction and returns an authoritative workspace projection; the TypeScript `notesStore` is the only renderer code allowed to invoke `notes_*` commands.

**Tech Stack:** Rust 2021, rusqlite 0.31 with bundled SQLite/FTS5, serde, Tauri 2 commands, TypeScript, Vitest, tempfile.

## Global Constraints

- Store Notes only in `<vault>/.yonalist/notes.sqlite`.
- Do not change the schema or behavior of `<vault>/.yonalist/index.sqlite`.
- Use WAL, foreign keys, busy timeout, transactional `PRAGMA user_version` migrations, and SQLite-generated UTC timestamps.
- Use opaque UUID text IDs supplied by the renderer and validate their canonical UUID shape in Rust.
- Every create, move, duplicate, delete, restore, and ordering rebalance runs in a single transaction.
- Deleting a node soft-deletes its live subtree; permanent deletion is limited to emptying trash.
- Browser-only code must not replace SQLite with localStorage. Renderer tests mock the typed store.
- `clear_vault_cache` must leave `notes.sqlite` unchanged.

---

## Target File Structure

| File | Responsibility |
| --- | --- |
| `src-tauri/src/notes/mod.rs` | Public Notes module surface and command re-exports |
| `src-tauri/src/notes/types.rs` | Serde DTOs, command inputs, result types, ID validation |
| `src-tauri/src/notes/repository.rs` | Connection, migrations, queries, transactional tree mutations |
| `src-tauri/src/notes/commands.rs` | Thin `#[tauri::command]` wrappers |
| `src-tauri/src/lib.rs` | Module declaration, command registration, and shared vault metadata-path visibility |
| `src/domain/notes.ts` | TypeScript mirror of DTOs and pure node helpers |
| `src/domain/notes.test.ts` | Type guard and normalized-tree helper tests |
| `src/services/notesStore.ts` | Typed renderer command adapter |
| `src/services/notesStore.tauri.test.ts` | Tauri payload and response mapping tests |

## Stable Data Contracts

```ts
// src/domain/notes.ts
export type NoteId = string;
export type NoteLayoutMode = "bullets";

export interface NoteNode {
  id: NoteId;
  parentId: NoteId | null;
  sortKey: number;
  title: string;
  note: string;
  layoutMode: NoteLayoutMode;
  isCollapsed: boolean;
  isStarred: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface NotesWorkspace {
  nodes: NoteNode[];
}

export type NotesWorkspaceScope =
  | { kind: "active" }
  | { kind: "trash" };

export interface CreateNoteNodeInput {
  id: NoteId;
  parentId: NoteId | null;
  afterId: NoteId | null;
  title: string;
  note: string;
}

export interface UpdateNoteNodeInput {
  id: NoteId;
  title: string;
  note: string;
}

export interface MoveNoteNodeInput {
  id: NoteId;
  parentId: NoteId | null;
  afterId: NoteId | null;
}

export interface SplitNoteNodeInput {
  id: NoteId;
  newNodeId: NoteId;
  prefix: string;
  suffix: string;
}

export interface NotesStore {
  initialize(vaultPath: string): Promise<void>;
  loadWorkspace(vaultPath: string, scope: NotesWorkspaceScope): Promise<NotesWorkspace>;
  createNode(vaultPath: string, input: CreateNoteNodeInput): Promise<NotesWorkspace>;
  updateNode(vaultPath: string, input: UpdateNoteNodeInput): Promise<NotesWorkspace>;
  splitNode(vaultPath: string, input: SplitNoteNodeInput): Promise<NotesWorkspace>;
  moveNode(vaultPath: string, input: MoveNoteNodeInput): Promise<NotesWorkspace>;
  toggleComplete(vaultPath: string, nodeId: NoteId): Promise<NotesWorkspace>;
  toggleCollapsed(vaultPath: string, nodeId: NoteId): Promise<NotesWorkspace>;
  duplicateNode(vaultPath: string, nodeId: NoteId): Promise<NotesWorkspace>;
  removeEmptyNode(vaultPath: string, nodeId: NoteId): Promise<NotesWorkspace>;
  softDeleteNode(vaultPath: string, nodeId: NoteId): Promise<NotesWorkspace>;
  restoreNode(vaultPath: string, nodeId: NoteId): Promise<NotesWorkspace>;
  emptyTrash(vaultPath: string): Promise<NotesWorkspace>;
}

export function createNoteId(): NoteId;
```

All mutation commands return `NotesWorkspace` containing the current active
tree. `notesLoadWorkspace(vaultPath, { kind: "active" })` returns active nodes
and `{ kind: "trash" }` returns soft-deleted nodes. Returning an authoritative
projection avoids renderer-side ordering divergence during the first release.

### Task 1: Define the Domain Contract and Failing Native Migration Tests

**Files:**
- Create: `src-tauri/src/notes/mod.rs`
- Create: `src-tauri/src/notes/types.rs`
- Create: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/domain/notes.ts`
- Create: `src/domain/notes.test.ts`

**Interfaces:**
- Consumes: `rusqlite::{Connection, Transaction}`, `serde::{Deserialize, Serialize}`, and the current vault metadata path convention in `src-tauri/src/lib.rs`.
- Produces: `NoteNode`, `NotesWorkspace`, input DTOs, `NotesStore`, `createNoteId`, and `connect_notes_db` for command wrappers.

- [ ] **Step 1: Write failing Rust and TypeScript tests for a new independent database**

```rust
#[test]
fn notes_database_uses_its_own_schema_and_fts_table() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let connection = connect_notes_db(temp_dir.path().to_str().expect("path"))
        .expect("connect notes");

    let node_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row.get(0))
        .expect("nodes table");
    assert_eq!(node_count, 0);
}
```

```ts
it("recognizes a complete Notes node payload", () => {
  expect(isNoteNode(makeNoteNode())).toBe(true);
  expect(isNoteNode({ ...makeNoteNode(), parentId: 42 })).toBe(false);
});

it("creates a canonical UUID for a new node", () => {
  expect(createNoteId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes:: && npm test -- src/domain/notes.test.ts`

Expected: FAIL because the Notes module and TypeScript types do not exist.

- [ ] **Step 3: Implement types, database path, and version-one schema**

```rust
pub(crate) fn notes_db_path(vault_path: &str) -> PathBuf {
    crate::metadata_dir(vault_path).join("notes.sqlite")
}

pub(crate) fn connect_notes_db(vault_path: &str) -> Result<Connection, String> {
    let metadata = crate::metadata_dir(vault_path);
    fs::create_dir_all(&metadata).map_err(|error| error.to_string())?;
    let connection = Connection::open(notes_db_path(vault_path))
        .map_err(|error| error.to_string())?;
    initialize_notes_db(&connection)?;
    Ok(connection)
}
```

Version one creates `notes_nodes`, `notes_tags`, `notes_preferences`,
`notes_search`, its FTS synchronization triggers, and
`notes_nodes_active_parent_order` exactly as specified in the approved design.
Make the existing `metadata_dir` helper `pub(crate)` rather than duplicating
vault-path expansion. `initialize_notes_db` first runs `PRAGMA journal_mode =
WAL`, `PRAGMA foreign_keys = ON`, and `PRAGMA busy_timeout = 5000`; it then
uses one transaction to migrate `user_version` from 0 to 1.

`createNoteId` uses `crypto.randomUUID()` and throws a clear unsupported-runtime
error if it is unavailable; tests stub that browser API. Rust validates every
incoming ID against the canonical UUID v4 shape before any SQL mutation.

- [ ] **Step 4: Run focused migration tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests::notes_database_uses_its_own_schema_and_fts_table && npm test -- src/domain/notes.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the schema boundary**

```bash
git add src-tauri/src/notes src-tauri/src/lib.rs src/domain/notes.ts src/domain/notes.test.ts
git commit -m "feat(notes): add isolated sqlite schema"
```

### Task 2: Implement Transactional Tree Operations and Invariant Tests

**Files:**
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/types.rs`

**Interfaces:**
- Consumes: `CreateNoteNodeInput`, `MoveNoteNodeInput`, and `NotesWorkspace` from Task 1.
- Produces: `create_node`, `update_node`, `split_node`, `move_node`, `toggle_complete`, `toggle_collapsed`, `duplicate_node`, `remove_empty_node`, `soft_delete_node`, `restore_node`, and `empty_trash` repository functions.

- [ ] **Step 1: Write failing invariant tests before repository code**

```rust
#[test]
fn move_rejects_a_descendant_as_the_new_parent() {
    let mut connection = test_connection();
    let root = insert_node(&mut connection, "11111111-1111-4111-8111-111111111111", None, 1024);
    let child = insert_node(&mut connection, "22222222-2222-4222-8222-222222222222", Some(&root), 1024);

    let error = move_node(&mut connection, &root, Some(&child), None).expect_err("cycle");
    assert!(error.contains("descendant"));
}

#[test]
fn deleting_a_node_hides_the_entire_live_subtree_and_restore_returns_it() {
    let mut connection = test_connection();
    let root = insert_tree(&mut connection);

    soft_delete_node(&mut connection, &root).expect("delete");
    assert!(load_workspace(&connection, NotesWorkspaceScope::Active).expect("active").nodes.is_empty());
    restore_node(&mut connection, &root).expect("restore");
    assert_eq!(load_workspace(&connection, NotesWorkspaceScope::Active).expect("active").nodes.len(), 2);
}

#[test]
fn split_and_remove_empty_node_preserve_children_in_one_transaction() {
    let mut connection = test_connection();
    let parent = insert_tree(&mut connection);
    let split = split_node(
        &mut connection,
        SplitNodeInput::new(&parent, "33333333-3333-4333-8333-333333333333", "alpha", "beta")
    ).expect("split");
    remove_empty_node(&mut connection, &split).expect("remove empty");
    assert_tree_invariants(&connection);
}
```

- [ ] **Step 2: Run repository tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests`

Expected: FAIL because the mutation functions are absent.

- [ ] **Step 3: Implement the transaction helpers and operations**

```rust
fn with_transaction<T>(connection: &mut Connection, operation: impl FnOnce(&Transaction<'_>) -> Result<T, String>) -> Result<T, String> {
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let result = operation(&transaction)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(result)
}

fn next_sort_key(transaction: &Transaction<'_>, parent_id: Option<&str>, after_id: Option<&str>) -> Result<i64, String> {
    // Select adjacent live siblings, choose the midpoint, and rebalance this
    // sibling set in 1024 increments when no integer gap remains.
}
```

Implement the following fixed semantics:

- `create_node` inserts after `afterId` under `parentId`; a null `afterId`
  appends to that sibling set.
- `move_node` rejects self and descendant parents, removes the node from its
  source ordering, then inserts it at the requested target position.
- `split_node` changes the source title to `prefix`, creates `newNodeId` as
  the immediate next sibling with `suffix`, and commits both changes together.
- `duplicate_node` deep-copies the selected active subtree with fresh validated
  UUIDs and inserts the copied root after the source root.
- `remove_empty_node` moves a node's children to the removed node's parent at
  the removed node's position, then soft-deletes only the empty node. A leaf
  follows the same operation with no child moves.
- `soft_delete_node` timestamps the selected live subtree in one update.
- `restore_node` clears deletion timestamps for the subtree; if its original
  parent remains deleted, the restored root becomes a root page.
- `empty_trash` physically removes only rows whose subtree is already deleted.

- [ ] **Step 4: Run invariant and rebalance tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests`

Expected: PASS, including root moves, deep duplicates, restore fallback, and
sort-key rebalance fixtures.

- [ ] **Step 5: Commit the transactional repository**

```bash
git add src-tauri/src/notes/repository.rs src-tauri/src/notes/types.rs
git commit -m "feat(notes): persist transactional outline tree"
```

### Task 3: Expose the Typed Tauri Command Adapter

**Files:**
- Create: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/notes/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/services/notesStore.ts`
- Create: `src/services/notesStore.tauri.test.ts`

**Interfaces:**
- Consumes: native repository functions from Task 2 and TypeScript types from `src/domain/notes.ts`.
- Produces: `notesInitialize`, `notesLoadWorkspace`, `notesCreateNode`, `notesUpdateNode`, `notesSplitNode`, `notesMoveNode`, `notesToggleComplete`, `notesToggleCollapsed`, `notesDuplicateNode`, `notesRemoveEmptyNode`, `notesSoftDeleteNode`, `notesRestoreNode`, and `notesEmptyTrash`.

- [ ] **Step 1: Write failing command payload tests**

```ts
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

beforeEach(() => {
  invokeMock.mockReset();
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {}
  });
});

it("maps a create-node request to the native command contract", async () => {
  invokeMock.mockResolvedValue({ nodes: [] });
  await notesCreateNode("/vault", {
    id: "11111111-1111-4111-8111-111111111111",
    parentId: null,
    afterId: null,
    title: "Page",
    note: ""
  });

  expect(invokeMock).toHaveBeenCalledWith("notes_create_node", {
    vaultPath: "/vault",
    input: expect.objectContaining({ parentId: null, afterId: null })
  });
});
```

- [ ] **Step 2: Run store tests to verify they fail**

Run: `npm test -- src/services/notesStore.tauri.test.ts`

Expected: FAIL because `notesStore.ts` and command registration are absent.

- [ ] **Step 3: Implement thin commands and renderer adapter**

```rust
#[tauri::command]
pub fn notes_create_node(vault_path: String, input: CreateNodeInput) -> Result<NotesWorkspace, String> {
    let mut connection = connect_notes_db(&vault_path)?;
    create_node(&mut connection, input)?;
    load_workspace(&connection, NotesWorkspaceScope::Active)
}
```

```ts
export async function notesCreateNode(
  vaultPath: string,
  input: CreateNoteNodeInput
): Promise<NotesWorkspace> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NotesWorkspace>("notes_create_node", { vaultPath, input });
}
```

Register only explicit `notes_*` commands in `tauri::generate_handler![]`.
Register `notes_split_node` and `notes_remove_empty_node` alongside the core
create/update/move commands so the outliner never composes a structural edit
from multiple renderer-side transactions.
Use the existing Tauri test pattern: mock `@tauri-apps/api/core`, set
`window.__TAURI_INTERNALS__`, and assert camelCase request properties.

- [ ] **Step 4: Run command and native tests to verify they pass**

Run: `npm test -- src/services/notesStore.tauri.test.ts && cargo test --manifest-path src-tauri/Cargo.toml notes::commands`

Expected: PASS.

- [ ] **Step 5: Commit the command boundary**

```bash
git add src-tauri/src/notes src-tauri/src/lib.rs src/services/notesStore.ts src/services/notesStore.tauri.test.ts
git commit -m "feat(notes): expose typed native tree commands"
```

### Task 4: Lock Database and Cache Isolation

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/services/appReset.test.ts`
- Create: `src/services/notesStore.test.ts`

**Interfaces:**
- Consumes: `clear_vault_cache`, `connect_notes_db`, and `notesLoadWorkspace`.
- Produces: regression coverage proving cache reset cannot remove Notes user data and browser mode reports a clear desktop-only error.

- [ ] **Step 1: Add failing isolation tests**

```rust
#[test]
fn clear_vault_cache_keeps_notes_sqlite_and_its_nodes() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let vault_path = temp_dir.path().to_str().expect("path").to_string();
    let mut notes = connect_notes_db(&vault_path).expect("notes db");
    create_node(&mut notes, test_create_input()).expect("create");

    drop(notes);
    clear_vault_cache(vault_path.clone()).expect("clear cache");
    let notes = connect_notes_db(&vault_path).expect("reopen notes");
    assert_eq!(load_workspace(&notes, NotesWorkspaceScope::Active).expect("load").nodes.len(), 1);
}
```

```ts
it("rejects Notes access outside Tauri instead of writing localStorage", async () => {
  await expect(notesLoadWorkspace("/vault")).rejects.toThrow("Notes requires Tauri");
  expect(window.localStorage.getItem("yonalist.notes.v1")).toBeNull();
});
```

- [ ] **Step 2: Run isolation tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml clear_vault_cache_keeps_notes && npm test -- src/services/notesStore.test.ts src/services/appReset.test.ts`

Expected: FAIL until the separate database and non-Tauri guard are in place.

- [ ] **Step 3: Implement the narrow reset and renderer guards**

Keep `clear_vault_cache` scoped to `index.sqlite` tables and `.yonalist/cache`.
In `notesStore.ts`, centralize the desktop check and throw exactly
`new Error("Notes requires Tauri desktop storage.")` before importing or
calling `invoke` when `__TAURI_INTERNALS__` is absent.

- [ ] **Step 4: Run full persistence verification**

Run: `npm test -- src/domain/notes.test.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts src/services/appReset.test.ts && cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS.

- [ ] **Step 5: Commit the isolation guarantee**

```bash
git add src-tauri/src/lib.rs src/services/appReset.test.ts src/services/notesStore.test.ts
git commit -m "test(notes): preserve notes data during cache reset"
```
