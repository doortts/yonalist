<!-- reconciliation: auditedHead=ec8a9ff3d016449255992adf70e128ea5e222e9a status=complete -->
> **증거 대조 상태 (2026-07-19): 완료.** commit·artifact 근거는 [감사 보고서](../reports/2026-07-19-historical-plan-reconciliation.md)에 기록했다.

# Notes Onboarding and Supporting-Note Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed one editable Korean help note in a genuinely new Notes database, prevent raw object errors, and let users leave one-row supporting-note fields with Escape or boundary vertical arrows.

**Architecture:** Keep the durable one-time onboarding decision inside the existing Rust database initialization transaction, using `notes_preferences` as the completion marker. Normalize every initialization rejection at the TypeScript service boundary and add a pure supporting-note key resolver that both page and row components use before committing the live DOM value and handing focus to the existing workspace focus path.

**Tech Stack:** Rust 2021, rusqlite, uuid, Tauri 2, React 18, TypeScript 5.7, Vitest 4, React Testing Library.

## Global Constraints

- The onboarding content is ordinary Notes data that users can edit, move, archive, trash, restore, export, or delete.
- A database containing any node row, including a deleted or archived row, is not genuinely empty.
- Deleting onboarding content must not recreate it; deleting the whole Notes database may restore first-use behavior.
- The onboarding nodes and `notes.onboarding.v1` marker must commit atomically and must not create undo history.
- Existing Notes databases must never receive unsolicited onboarding content.
- No Notes initialization failure may render `[object Object]`.
- Supporting-note textareas start with `rows=1` and retain existing auto-grow behavior.
- Unmodified `Escape`, start-boundary `ArrowUp`, and end-boundary `ArrowDown` exit supporting notes; modifier-arrow chords remain native.
- Boundary navigation remains enabled during Korean IME composition and when the selected range touches the relevant boundary.
- The live DOM value must be committed before focus moves.

---

## File structure

- `src/domain/notes.ts`: supplies the stable fallback for malformed rejection payloads.
- `src/domain/notes.test.ts`: proves malformed objects never stringify into UI text.
- `src/services/notesStore.ts`: normalizes `notes_initialize` rejections into `NotesStoreError`.
- `src/services/notesStore.test.ts`: verifies typed and malformed initialization failures.
- `src/features/notes/notesWorkspaceCoordinator.ts`: uses the shared parser as the final UI-facing error guard.
- `src/features/notes/notesWorkspaceCoordinator.test.ts`: verifies a non-service repository cannot leak raw object coercion.
- `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`: expose UUID v4 generation to onboarding bootstrap code.
- `src-tauri/src/notes/repository.rs`: owns the one-time seed transaction and repository coverage.
- `src/features/notes/outlineKeyboard.ts`: owns pure supporting-note exit and target resolution.
- `src/features/notes/outlineKeyboard.test.ts`: covers boundary, selection, composition-independent, and modifier rules.
- `src/features/notes/OutlineNodeRow.tsx`: applies the shared resolver to row supporting notes and changes their initial row count.
- `src/features/notes/NotesPageHeader.tsx`: applies the same behavior to page supporting notes.
- `src/features/notes/NotesOutlinePane.tsx`: passes the stable current visible-order accessor into the page header.
- `src/features/notes/NotesWorkspace.test.tsx`: verifies row focus and persistence behavior through the workspace.
- `src/features/notes/NotesPageHeader.test.tsx`: verifies page-level focus, persistence, and one-row auto-grow behavior.

---

### Task 1: Normalize Notes initialization errors

**Files:**
- Modify: `src/domain/notes.ts:184-199`
- Modify: `src/domain/notes.test.ts:659-694`
- Modify: `src/services/notesStore.ts:318-320`
- Modify: `src/services/notesStore.test.ts:1-145`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts:1-7,192-194`
- Modify: `src/features/notes/notesWorkspaceCoordinator.test.ts`

**Interfaces:**
- Consumes: `parseNotesError(cause: unknown): NotesStructuredError` and `notesStoreError("load", cause)`.
- Produces: `notesInitialize(vaultPath: string): Promise<void>` that always rejects with a normal `NotesStoreError`; UI error extraction that never calls `String` on an arbitrary object.

- [x] **Step 1: Add failing domain and service tests**

Add this assertion to the `notes error taxonomy` suite:

```ts
it("uses a stable fallback for malformed object causes", () => {
  expect(parseNotesError({ detail: "opaque transport payload" })).toEqual({
    code: "internal",
    message: "Notes request failed."
  });
  expect(parseNotesError(null)).toEqual({
    code: "internal",
    message: "Notes request failed."
  });
});
```

Import `notesInitialize` in `notesStore.test.ts`, then add:

```ts
it("normalizes structured initialization failures", async () => {
  Reflect.set(window, "__TAURI_INTERNALS__", {});
  invokeMock.mockRejectedValue({
    code: "vaultBusy",
    message: "Notes vault is already open in another window."
  });

  await expect(notesInitialize("/vault")).rejects.toMatchObject({
    operation: "load",
    code: "vaultBusy",
    retryable: true,
    message: "Notes vault is already open in another window."
  });
});

it("never stringifies malformed initialization objects", async () => {
  Reflect.set(window, "__TAURI_INTERNALS__", {});
  invokeMock.mockRejectedValue({ detail: "opaque" });

  await expect(notesInitialize("/vault")).rejects.toMatchObject({
    operation: "load",
    code: "internal",
    message: "Notes request failed."
  });
});
```

Add this coordinator registry test:

```ts
it("normalizes malformed activation failures before notifying the UI", async () => {
  const store = repository({
    initialize: vi.fn().mockRejectedValue({ detail: "opaque" })
  });
  const registry = createNotesWorkspaceCoordinatorRegistry();
  const events = vi.fn();
  const session = registry.openSession({
    repository: store,
    vaultRoot: "/malformed-activation",
    onEvent: events
  });

  await session.activation;

  expect(events).toHaveBeenCalledWith({
    type: "settled",
    result: { kind: "failure", error: "Notes request failed." },
    hasPendingWork: false
  });
  expect(JSON.stringify(events.mock.calls)).not.toContain("[object Object]");
  session.close();
});
```

- [x] **Step 2: Run the focused tests and verify failure**

Run:

```bash
npx vitest run src/domain/notes.test.ts src/services/notesStore.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts
```

Expected: FAIL because malformed objects still become `[object Object]`, `notesInitialize` returns the raw rejection, and the coordinator still stringifies non-`Error` causes.

- [x] **Step 3: Implement stable parsing and initialization normalization**

Replace the fallback at the end of `parseNotesError` with:

```ts
  if (typeof cause === "string") {
    return { code: "internal", message: cause };
  }
  return { code: "internal", message: "Notes request failed." };
```

Change initialization to:

```ts
export async function notesInitialize(vaultPath: string): Promise<void> {
  try {
    await invokeNotes<void>("notes_initialize", { vaultPath });
  } catch (cause) {
    throw notesStoreError("load", cause);
  }
}
```

Import `parseNotesError` as a value in `notesWorkspaceCoordinator.ts` and replace its guard with:

```ts
function errorMessage(cause: unknown): string {
  return parseNotesError(cause).message;
}
```

- [x] **Step 4: Run the focused tests and verify success**

Run the same Vitest command.

Expected: all selected tests PASS and no assertion output contains `[object Object]` except the explicit negative expectation.

- [x] **Step 5: Commit the error boundary change**

```bash
git add src/domain/notes.ts src/domain/notes.test.ts src/services/notesStore.ts src/services/notesStore.test.ts src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceCoordinator.test.ts
git commit -m "fix(notes): normalize initialization errors"
```

---

### Task 2: Seed editable onboarding Notes exactly once

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/notes/repository.rs:1-35,223-310,6720-6775`

**Interfaces:**
- Consumes: the existing migration `Transaction`, `notes_preferences`, `notes_nodes`, search triggers, `SORT_KEY_STEP`, and UUID v4 validation conventions.
- Produces: `ensure_notes_onboarding(transaction: &Transaction<'_>) -> Result<(), String>` and the durable `notes.onboarding.v1` marker.

- [x] **Step 1: Add failing repository tests**

Add these repository test helpers:

```rust
fn node_count(connection: &Connection) -> i64 {
    connection
        .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row.get(0))
        .expect("node count")
}

fn preference_value(connection: &Connection, key: &str) -> Option<String> {
    connection
        .query_row(
            "SELECT value_json FROM notes_preferences WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .expect("preference value")
}

fn remove_onboarding_for_test(connection: &Connection) {
    connection
        .execute("DELETE FROM notes_nodes", [])
        .expect("delete onboarding nodes");
    connection
        .execute(
            "DELETE FROM notes_preferences WHERE key = ?1",
            [NOTES_ONBOARDING_VERSION_KEY],
        )
        .expect("delete onboarding marker");
}
```

Then add these tests:

```rust
#[test]
fn onboarding_seeds_a_fresh_database_once() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let vault_path = temp_dir.path().to_str().expect("path");
    let mut connection = connect_notes_db(vault_path).expect("connect notes");

    let nodes: Vec<(String, Option<String>, i64, String, String)> = connection
        .prepare(
            "SELECT id, parent_id, sort_key, title, note \
             FROM notes_nodes ORDER BY parent_id IS NOT NULL, sort_key",
        )
        .expect("prepare onboarding query")
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        })
        .expect("query onboarding")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect onboarding");

    assert_eq!(nodes.len(), 7);
    assert_eq!(nodes[0].3, "Yonalist Notes 시작하기");
    assert_eq!(nodes[0].4, "이 노트는 자유롭게 수정하거나 삭제할 수 있어요.");
    assert!(
        nodes[1..]
            .iter()
            .all(|node| node.1.as_deref() == Some(nodes[0].0.as_str()))
    );
    assert_eq!(
        nodes[1..].iter().map(|node| node.3.as_str()).collect::<Vec<_>>(),
        vec![
            "Enter — 새 항목 만들기",
            "Tab / Shift+Tab — 들여쓰기 / 내어쓰기",
            "Shift+Enter — 설명 입력하기",
            "⌘/Ctrl+Enter — 완료 표시",
            "↑/↓ — 항목 사이 이동",
            "불릿을 드래그해 순서와 계층 바꾸기",
        ]
    );
    assert_eq!(preference_value(&connection, NOTES_ONBOARDING_VERSION_KEY), Some("1".into()));

    initialize_notes_db(&mut connection).expect("reinitialize notes");
    assert_eq!(node_count(&connection), 7);
}
```

Add three more focused tests:

```rust
#[test]
fn onboarding_marks_but_does_not_modify_an_existing_workspace() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let vault_path = temp_dir.path().to_str().expect("path");
    let mut connection = connect_notes_db(vault_path).expect("connect notes");
    remove_onboarding_for_test(&connection);
    insert_node(&connection, NODE_ID, None, SORT_KEY_STEP, "Existing note");

    initialize_notes_db(&mut connection).expect("reinitialize notes");

    assert_eq!(node_count(&connection), 1);
    assert_eq!(
        connection
            .query_row("SELECT title FROM notes_nodes", [], |row| row.get::<_, String>(0))
            .expect("existing title"),
        "Existing note"
    );
    assert_eq!(
        preference_value(&connection, NOTES_ONBOARDING_VERSION_KEY),
        Some("1".to_string())
    );
}

#[test]
fn onboarding_does_not_return_after_its_nodes_are_deleted() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let vault_path = temp_dir.path().to_str().expect("path");
    let mut connection = connect_notes_db(vault_path).expect("connect notes");
    connection
        .execute("DELETE FROM notes_nodes", [])
        .expect("delete onboarding nodes");

    initialize_notes_db(&mut connection).expect("reinitialize notes");

    assert_eq!(node_count(&connection), 0);
    assert_eq!(
        preference_value(&connection, NOTES_ONBOARDING_VERSION_KEY),
        Some("1".to_string())
    );
}

#[test]
fn onboarding_nodes_and_marker_roll_back_together() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let vault_path = temp_dir.path().to_str().expect("path");
    let mut connection = connect_notes_db(vault_path).expect("connect notes");
    remove_onboarding_for_test(&connection);
    connection
        .execute_batch(
            "CREATE TRIGGER reject_onboarding_child \
             BEFORE INSERT ON notes_nodes \
             WHEN NEW.parent_id IS NOT NULL \
             BEGIN SELECT RAISE(ABORT, 'reject onboarding child'); END;",
        )
        .expect("create rejecting trigger");

    let error = initialize_notes_db(&mut connection).expect_err("seed must fail");

    assert!(error.contains("Could not create Notes onboarding guidance"));
    assert_eq!(node_count(&connection), 0);
    assert_eq!(
        preference_value(&connection, NOTES_ONBOARDING_VERSION_KEY),
        None
    );
}
```

Replace the old fresh-schema assertion `assert_eq!(node_count, 0)` with `assert_eq!(node_count, 7)`.

- [x] **Step 2: Run repository tests and verify failure**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests::onboarding -- --nocapture
```

Expected: FAIL because no onboarding helper, marker, or nodes exist.

- [x] **Step 3: Add UUID support and implement the transactional seed**

Add the direct dependency:

```toml
uuid = { version = "1", features = ["v4"] }
```

Add constants and the helper in `repository.rs`:

```rust
use uuid::Uuid;

const NOTES_ONBOARDING_VERSION_KEY: &str = "notes.onboarding.v1";
const NOTES_ONBOARDING_TITLE: &str = "Yonalist Notes 시작하기";
const NOTES_ONBOARDING_NOTE: &str = "이 노트는 자유롭게 수정하거나 삭제할 수 있어요.";
const NOTES_ONBOARDING_CHILDREN: [&str; 6] = [
    "Enter — 새 항목 만들기",
    "Tab / Shift+Tab — 들여쓰기 / 내어쓰기",
    "Shift+Enter — 설명 입력하기",
    "⌘/Ctrl+Enter — 완료 표시",
    "↑/↓ — 항목 사이 이동",
    "불릿을 드래그해 순서와 계층 바꾸기",
];

fn ensure_notes_onboarding(transaction: &Transaction<'_>) -> Result<(), String> {
    let marker_exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_preferences WHERE key = ?1)",
            [NOTES_ONBOARDING_VERSION_KEY],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not read the Notes onboarding state: {error}"))?;
    if marker_exists {
        return Ok(());
    }

    let node_count: i64 = transaction
        .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row.get(0))
        .map_err(|error| format!("Could not inspect Notes onboarding content: {error}"))?;
    if node_count == 0 {
        let root_id = Uuid::new_v4().to_string();
        transaction
            .execute(
                "INSERT INTO notes_nodes (id, parent_id, sort_key, title, note, created_at, updated_at) \
                 VALUES (?1, NULL, ?2, ?3, ?4, \
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                params![&root_id, SORT_KEY_STEP, NOTES_ONBOARDING_TITLE, NOTES_ONBOARDING_NOTE],
            )
            .map_err(|error| format!("Could not create the Notes onboarding page: {error}"))?;

        for (index, title) in NOTES_ONBOARDING_CHILDREN.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO notes_nodes (id, parent_id, sort_key, title, created_at, updated_at) \
                     VALUES (?1, ?2, ?3, ?4, \
                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                    params![
                        Uuid::new_v4().to_string(),
                        &root_id,
                        (index as i64 + 1) * SORT_KEY_STEP,
                        title
                    ],
                )
                .map_err(|error| format!("Could not create Notes onboarding guidance: {error}"))?;
        }
    }

    transaction
        .execute(
            "INSERT INTO notes_preferences (key, value_json) VALUES (?1, '1')",
            [NOTES_ONBOARDING_VERSION_KEY],
        )
        .map_err(|error| format!("Could not record the Notes onboarding state: {error}"))?;
    Ok(())
}
```

Call `ensure_notes_onboarding(&transaction)?` after schema and required indexes exist but before the derived-version ensure functions and before the transaction commits. Do not call any history-writing mutation helper.

- [x] **Step 4: Run repository tests and verify success**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests::onboarding -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests::fresh_database_creates_the_complete_version_three_schema -- --nocapture
```

Expected: all selected tests PASS; Cargo updates only the root package dependency entry in `src-tauri/Cargo.lock` because `uuid` is already transitively locked.

- [x] **Step 5: Commit the onboarding seed**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/notes/repository.rs
git commit -m "feat(notes): seed editable onboarding note"
```

---

### Task 3: Resolve supporting-note exits as pure keyboard behavior

**Files:**
- Modify: `src/features/notes/outlineKeyboard.ts`
- Modify: `src/features/notes/outlineKeyboard.test.ts`

**Interfaces:**
- Produces: `resolveSupportingNoteKey(input): SupportingNoteKeyResolution | null` and `supportingNoteFocusTarget(resolution, nodeId, visibleNodeIds): NoteId`.
- Consumers: `OutlineNodeRow` and `NotesPageHeader` in Task 4.

- [x] **Step 1: Add failing resolver tests**

Add tests covering the following concrete table:

```ts
describe("resolveSupportingNoteKey", () => {
  const input = (overrides: Partial<ResolveSupportingNoteKeyInput> = {}) => ({
    key: "Escape",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    selectionStart: 2,
    selectionEnd: 2,
    value: "note",
    ...overrides
  });

  it("exits to the current title with Escape", () => {
    expect(resolveSupportingNoteKey(input())).toBe("currentTitle");
  });

  it("uses selections touching vertical boundaries", () => {
    expect(resolveSupportingNoteKey(input({ key: "ArrowUp", selectionStart: 0, selectionEnd: 3 }))).toBe("currentTitle");
    expect(resolveSupportingNoteKey(input({ key: "ArrowDown", selectionStart: 1, selectionEnd: 4 }))).toBe("nextTitle");
  });

  it("keeps mid-text and modifier arrows native", () => {
    expect(resolveSupportingNoteKey(input({ key: "ArrowUp" }))).toBeNull();
    expect(resolveSupportingNoteKey(input({ key: "ArrowDown", ctrlKey: true, selectionEnd: 4 }))).toBeNull();
    expect(resolveSupportingNoteKey(input({ key: "ArrowUp", shiftKey: true, selectionStart: 0 }))).toBeNull();
  });

  it("resolves the following visible title with current fallback", () => {
    expect(supportingNoteFocusTarget("nextTitle", "b", ["a", "b", "c"])).toBe("c");
    expect(supportingNoteFocusTarget("nextTitle", "c", ["a", "b", "c"])).toBe("c");
    expect(supportingNoteFocusTarget("currentTitle", "b", ["a", "b", "c"])).toBe("b");
  });
});
```

Do not add `isComposing` to the input: composition state intentionally has no power to disable these exit rules.

- [x] **Step 2: Run the resolver test and verify failure**

Run:

```bash
npx vitest run src/features/notes/outlineKeyboard.test.ts
```

Expected: FAIL because the new interfaces and functions do not exist.

- [x] **Step 3: Implement the pure resolver**

Add:

```ts
export interface ResolveSupportingNoteKeyInput {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
  value: string;
}

export type SupportingNoteKeyResolution = "currentTitle" | "nextTitle";

export function resolveSupportingNoteKey(
  input: ResolveSupportingNoteKeyInput
): SupportingNoteKeyResolution | null {
  if (input.altKey || input.ctrlKey || input.metaKey || input.shiftKey) {
    return null;
  }
  if (input.key === "Escape") {
    return "currentTitle";
  }
  if (input.key === "ArrowUp" && input.selectionStart === 0) {
    return "currentTitle";
  }
  if (
    input.key === "ArrowDown" &&
    input.selectionEnd === input.value.length
  ) {
    return "nextTitle";
  }
  return null;
}

export function supportingNoteFocusTarget(
  resolution: SupportingNoteKeyResolution,
  nodeId: NoteId,
  visibleIds: readonly NoteId[]
): NoteId {
  if (resolution === "currentTitle") {
    return nodeId;
  }
  const index = visibleIds.indexOf(nodeId);
  return index >= 0 ? visibleIds[index + 1] ?? nodeId : nodeId;
}
```

- [x] **Step 4: Run the resolver tests and verify success**

Run the same Vitest command.

Expected: all `outlineKeyboard` tests PASS.

- [x] **Step 5: Commit the pure keyboard behavior**

```bash
git add src/features/notes/outlineKeyboard.ts src/features/notes/outlineKeyboard.test.ts
git commit -m "feat(notes): resolve supporting-note exits"
```

---

### Task 4: Wire one-row supporting-note exits into both editors

**Files:**
- Modify: `src/features/notes/OutlineNodeRow.tsx:930-990`
- Modify: `src/features/notes/NotesPageHeader.tsx:32-50,452-521`
- Modify: `src/features/notes/NotesOutlinePane.tsx:941-950`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src/features/notes/NotesPageHeader.test.tsx`

**Interfaces:**
- Consumes: `resolveSupportingNoteKey`, `supportingNoteFocusTarget`, `getVisibleNodeIds(): readonly NoteId[]`, `actions.updateNodeDraft`, `actions.flushNodeDraft`, and `actions.focusNode`.
- Produces: identical page/row supporting-note exit behavior with current-value persistence.

- [x] **Step 1: Add failing row and page component tests**

In `NotesWorkspace.test.tsx`, add:

```ts
it("starts row notes at one line and exits from selection boundaries during composition", async () => {
  renderNotesWorkspace();
  const note = getTextareaByName("Supporting note: Project");
  expect(note).toHaveAttribute("rows", "1");

  note.setSelectionRange(0, 3);
  expect(
    fireEvent.keyDown(note, { key: "ArrowUp", isComposing: true })
  ).toBe(false);
  await waitFor(() => expect(queryTitleInput("Project")).toHaveFocus());

  fireEvent.focus(note);
  fireEvent.change(note, { target: { value: "Project note revised" } });
  note.setSelectionRange(note.value.length, note.value.length);
  expect(fireEvent.keyDown(note, { key: "ArrowDown" })).toBe(false);
  await waitFor(() => expect(queryTitleInput("Plan")).toHaveFocus());
  await waitFor(() =>
    expect(notesStoreMock.updateNode).toHaveBeenCalledWith("/vault", {
      id: "project",
      title: "Project",
      note: "Project note revised"
    })
  );
});

it("keeps modified supporting-note arrows native", () => {
  renderNotesWorkspace();
  const note = getTextareaByName("Supporting note: Project");
  note.setSelectionRange(note.value.length, note.value.length);

  expect(fireEvent.keyDown(note, { key: "ArrowDown", ctrlKey: true })).toBe(true);
  expect(note).toHaveFocus();
});
```

In `NotesPageHeader.test.tsx`, add:

```ts
it("exits the page note to the next visible title with its live value", () => {
  const workspace = renderZoomedOutline();
  const note = editTextareaByName("Supporting note: Project");
  expect(note).toHaveAttribute("rows", "1");
  fireEvent.change(note, { target: { value: "Revised context" } });
  note.setSelectionRange(note.value.length, note.value.length);

  expect(fireEvent.keyDown(note, { key: "ArrowDown" })).toBe(false);

  expect(workspace.actions.updateNodeDraft).toHaveBeenLastCalledWith(
    "project",
    { title: "Project", note: "Revised context" },
    "note"
  );
  expect(workspace.actions.flushNodeDraft).toHaveBeenCalledWith("project");
  expect(workspace.actions.focusNode).toHaveBeenCalledWith("child");
});

it("exits the page note to its own title with Escape", () => {
  const workspace = renderZoomedOutline();
  const note = editTextareaByName("Supporting note: Project");

  expect(fireEvent.keyDown(note, { key: "Escape" })).toBe(false);

  expect(workspace.actions.flushNodeDraft).toHaveBeenCalledWith("project");
  expect(workspace.actions.focusNode).toHaveBeenCalledWith("project");
});
```

- [x] **Step 2: Run the focused component tests and verify failure**

Run:

```bash
npx vitest run src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesPageHeader.test.tsx
```

Expected: FAIL because row notes still use two rows and neither component resolves supporting-note exits.

- [x] **Step 3: Pass visible order to the page header**

Extend the page-header prop:

```ts
interface NotesPageHeaderProps {
  nodeId: NoteId;
  getVisibleNodeIds(): readonly NoteId[];
  disabled?: boolean;
  mode?: "standard" | "archive" | "trash";
  imageDropActive?: boolean;
  showDropPlaceholder?: boolean;
}
```

Destructure it in `NotesPageHeader`, and pass the already stable accessor from `NotesOutlinePane`:

```tsx
<NotesPageHeader
  key={state.zoomRootId}
  nodeId={state.zoomRootId}
  getVisibleNodeIds={getVisibleNodeIds}
  disabled={deletingNotesData}
  mode={lifecycleMode}
  imageDropActive={imageDropTargetId === state.zoomRootId}
  showDropPlaceholder={imageDropTargetId === state.zoomRootId}
/>
```

- [x] **Step 4: Implement the shared keydown flow in both editors**

After the existing history-shortcut check, resolve the exit from the live textarea:

```ts
const resolution = resolveSupportingNoteKey({
  key: event.key,
  altKey: event.altKey,
  ctrlKey: event.ctrlKey,
  metaKey: event.metaKey,
  shiftKey: event.shiftKey,
  selectionStart: event.currentTarget.selectionStart,
  selectionEnd: event.currentTarget.selectionEnd,
  value: event.currentTarget.value
});
if (!resolution) {
  return;
}
event.preventDefault();
actions.updateNodeDraft(
  nodeId,
  { title: titleValue, note: event.currentTarget.value },
  "note"
);
void actions.flushNodeDraft(nodeId);
void actions.focusNode(
  supportingNoteFocusTarget(resolution, nodeId, getVisibleNodeIds())
);
```

Use this flow in both `OutlineNodeRow` and `NotesPageHeader`. Keep history shortcut handling first, and return immediately after handling undo or redo. Do not check `event.nativeEvent.isComposing` in the supporting-note exit branch. Change the row supporting note from `rows={2}` to `rows={1}`; the page note already uses one row. Keep `resizeTextarea` and `useAutoGrowTextarea` unchanged.

- [x] **Step 5: Run the focused component tests and verify success**

Run the same component Vitest command.

Expected: all selected component tests PASS, including Korean composition and selection-boundary cases.

- [x] **Step 6: Run the full verification suite**

Run:

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all Vitest and Rust tests PASS, TypeScript compiles, and Vite production build completes.

- [x] **Step 7: Manually verify in the desktop app**

Run:

```bash
PATH="$HOME/.cargo/bin:$PATH" npm run tauri:dev
```

Expected: a fresh Notes database shows the Korean onboarding page once; it is editable and deletable; restart does not recreate it; supporting notes exit with the approved keys without losing text; no pane displays `[object Object]`.

- [x] **Step 8: Commit the UI wiring**

```bash
git add src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesPageHeader.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesPageHeader.test.tsx
git commit -m "feat(notes): streamline supporting-note editing"
```

---

## Completion check

- Compare the implementation against every acceptance criterion in `docs/superpowers/specs/2026-07-14-notes-onboarding-and-supporting-note-navigation-design.md`.
- Confirm `git status --short` contains no unintended files.
- Confirm the desktop process is running for the user after verification.
