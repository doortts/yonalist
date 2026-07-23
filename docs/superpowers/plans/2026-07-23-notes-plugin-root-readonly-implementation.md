# Notes Plugin Root, GitHub Notifications, and Readonly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Github Notifications`를 저장·정렬·동기화되는 고정 Notes 루트로 통합하고, 필요한 알림만 materialize하며, 일반 블릿의 접힘과 readonly 상태를 Markdown v3로 동기화한다.

**Architecture:** SQLite의 기존 `notes_nodes`와 루트별 Markdown을 단일 저장 경로로 유지한다. GN root/date/notification은 nullable plugin metadata로 식별하고, 아직 구조가 필요 없는 알림은 기존 GitHub source snapshot에서만 투영한다. 기존 outline tree에는 저장 블릿과 projection row를 합성하되 selection, focus, sort 순서를 분리한다. 일반 readonly와 provider-owned content는 같은 `NoteTextField`를 사용하고 저장소 mutation만 권한 경계에서 차단한다.

**Tech Stack:** React 19, TypeScript 6, Vitest 4, Testing Library, Rust, rusqlite, Tauri 2, Markdown frontmatter, HLC LWW, Vite 8

## Global Constraints

- 승인 기준 문서는 `docs/superpowers/specs/2026-07-23-notes-plugin-root-markdown-and-collapse-sync-design.md`다. 앞선 external notification/presentation 계획과 충돌하면 이 계획이 우선한다.
- 플러그인 ID는 `github-notifications`, 외부 key provider는 `github`, 표시 제목은 정확히 `Github Notifications`로 고정한다.
- GN 루트 UUID는 plugin ID `github-notifications`의 SHA-256 앞 16 bytes에 RFC 4122 v4/variant bits를 적용한 `6983f947-c134-44fc-bf46-db19f68125bf`, 표준 파일명은 `Github-Notifications.6983f947.md`로 고정한다. Rust와 TypeScript는 런타임에 따로 계산하지 않고 동일 literal을 테스트한다.
- GN-owned root/date/notification의 `is_readonly`는 SQLite `NULL`, frontend 필드는 누락이다. 일반 블릿만 `false` 또는 `true`를 가진다.
- projection-only 알림은 SQLite, Markdown, Notes 검색, selection, sortable ID에 넣지 않는다.
- GN root/date/notification과 일반 readonly는 기존 Notes row/editor markup을 재사용한다. 정적 카드나 별도 페이지 스타일을 만들지 않는다.
- 일반 readonly 임시 편집과 provider 임시 편집은 draft engine, HLC, Undo/Redo, export를 호출하지 않는다.
- GitHub `unread`만 알림 완료의 원본이다. `viewedAt`은 웹 열람 표시일 뿐 필터와 mark-read에 사용하지 않는다.
- `showCompleted === false`는 읽은 알림과 그 subtree를 숨기고, 일반 user node의 `completedAt` 필터도 별도로 유지한다.
- GN root는 같은 parent의 top-level reorder만 허용한다. date/notification 구조 mutation은 전용 provider-authoritative transaction만 허용한다.
- 일반 readonly target 직접 삭제는 확인 flag로도 허용하지 않는다. readonly descendant를 포함한 일반 ancestor 삭제만 exact descendant ID set 확인 후 허용한다.
- v2 Markdown과 이전 SQLite schema migration은 만들지 않는다. parser read support를 먼저 넣고, writer/seed/schema/IPC registration을 마지막 cutover에서 함께 v3로 전환한다.
- Tasks 2-9는 `V3_SCHEMA_SQL`, explicit v3 renderer, unregistered command functions와 disabled seed hook을 테스트 전용으로 준비한다. `CURRENT_NOTES_SCHEMA_VERSION`, production `CURRENT_SCHEMA_SQL`, `TOPIC_FORMAT_VERSION`, invoke handler, ACL과 production seed는 Task 10 전까지 바꾸지 않는다.
- `yonalist-notes`와 `yonalist-trash`는 함께 `format_version: 3`만 허용한다.
- full-row HLC LWW 충돌 정책을 유지한다. 필드 단위 HLC, CRDT, readonly origin enum, capability matrix, 범용 플러그인 SDK는 만들지 않는다.
- `src/features/notes/notesWorkspaceRuntime.ts`는 현재 1500/1500줄이다. GN 구현을 넣지 않고 새 focused helper/component와 기존 command 모듈에 둔다.
- architecture의 all-test order observation budget도 282/283이므로 indexed mock-order assertion을 새로 추가하지 않는다.
- 기존 `.superpowers/sdd/*.md` 변경은 사용자 소유다. 수정하거나 stage하지 않는다.
- 새 패키지는 추가하지 않는다. 현재 GitHub polling/cache/completion dedupe, `NoteTextField`, Notes CSS, Lucide, `ConfirmDialog`, DnD helper를 재사용한다.

## Frozen Data Contract

```rust
pub(crate) const GITHUB_NOTIFICATIONS_PLUGIN_ID: &str = "github-notifications";
pub(crate) const GITHUB_EXTERNAL_KEY_PROVIDER: &str = "github";
pub(crate) const GITHUB_NOTIFICATIONS_ROOT_ID: &str =
    "6983f947-c134-44fc-bf46-db19f68125bf";
pub(crate) const GITHUB_NOTIFICATIONS_TITLE: &str = "Github Notifications";
pub(crate) const GITHUB_NOTIFICATIONS_FILENAME: &str =
    "Github-Notifications.6983f947.md";
pub(crate) const SEED_HLC: &str = "000000000-00-0000";
```

```ts
export const GITHUB_NOTIFICATIONS_ROOT_ID =
  "6983f947-c134-44fc-bf46-db19f68125bf" as NoteId;
```

SQLite row contract:

```sql
plugin_state TEXT,
plugin_meta TEXT,
is_readonly INTEGER
  DEFAULT 0
  CHECK (is_readonly IN (0, 1) OR is_readonly IS NULL)
```

Frontend node contract:

```ts
interface NoteNode {
  // existing fields
  isReadonly?: boolean;
  pluginState?: GithubNotificationsPluginState;
  pluginMeta?: GithubNotificationsPluginMeta;
}
```

`plugin_meta IS NOT NULL` is the single plugin-owned child predicate. The fixed GN root is also excluded by its UUID because its root metadata lives in `plugin_state`.

---

### Task 1: Freeze Constants and Accept Markdown v3 on Read

**Files:**

- Create: `src-tauri/src/notes/github_notifications.rs`
- Modify: `src-tauri/src/notes/mod.rs`
- Modify: `src-tauri/src/notes/sync/topic_file.rs`
- Modify: `src-tauri/src/notes/sync/topic_parser.rs`
- Modify: `src-tauri/src/notes/sync/fixtures/topic_golden.md`
- Create: `src-tauri/src/notes/sync/fixtures/github_notifications_golden.md`
- Modify: `src/services/githubNotificationsProvider.ts`
- Modify: `src/services/githubNotificationsProvider.test.ts`

**Interfaces:**

- `GithubNotificationsPluginState { collapsed_groups: Vec<String> }`
- `GithubNotificationsPluginMeta::{Date { date_key }, Notification { notification_key, notification_type, url, updated_at, unread }}`
- `TopicRoot.root_collapsed`, `TopicRoot.root_readonly`, `TopicRoot.plugin`, `TopicRoot.plugin_children`, `TopicRoot.collapsed_groups`
- `TopicNode.collapsed`, `TopicNode.readonly`, `TopicNode.plugin_meta`

- [ ] **Step 1: Add RED parser and constant tests**

Add focused tests that assert:

```rust
#[test]
fn github_notifications_contract_has_a_canonical_v4_root_and_filename() {
    validate_note_id(GITHUB_NOTIFICATIONS_ROOT_ID).unwrap();
    assert_eq!(
        derive_topic_filename(GITHUB_NOTIFICATIONS_TITLE, GITHUB_NOTIFICATIONS_ROOT_ID).unwrap(),
        GITHUB_NOTIFICATIONS_FILENAME
    );
}

#[test]
fn parses_v3_general_collapse_readonly_and_github_hybrid_metadata() {
    let parsed = parse_topic_file(include_bytes!("fixtures/github_notifications_golden.md")).unwrap();
    let topic = parsed.into_topic().unwrap();
    assert_eq!(topic.root.plugin.as_deref(), Some("github-notifications"));
    assert_eq!(topic.root.collapsed_groups, vec!["2026.07.21"]);
    assert!(topic.nodes.iter().any(|node| node.readonly == Some(true)));
}
```

Also add quarantine tests for:

- duplicate `collapsed_groups`
- malformed/duplicate date key
- incomplete notification metadata
- plugin-owned `readonly: false` and root `root_readonly: false`

Record the final v2/missing-version rejection cases in Task 10 rather than enabling them here; this task must temporarily read both explicit v2 and v3.

- [ ] **Step 2: Verify RED**

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::topic_parser::tests -- --nocapture
```

Expected: FAIL because v3 fields and plugin metadata are unknown.

- [ ] **Step 3: Implement v3 read structures without enabling v3 writes**

Extend `Frontmatter`, `NodeComment`, `parse_frontmatter`, `parse_node_comment`, and `is_known_node_metadata_token`. Keep duplicate recognized scalar rejection. Normalize `collapsed_groups` by deduplicating and sorting stable date keys.

Use explicit enums rather than untyped JSON inside the parser:

```rust
pub(crate) enum TopicPluginMeta {
    GithubDate { date_key: String },
    GithubNotification {
        notification_key: String,
        notification_type: String,
        url: String,
        updated_at: String,
        unread: bool,
    },
}
```

Add a temporary read ceiling separate from the writer version:

```rust
pub(crate) const TOPIC_FORMAT_VERSION: u32 = 2;
pub(crate) const MAX_READ_TOPIC_FORMAT_VERSION: u32 = 3;
```

`parse_topic_file` accepts explicit v2 or v3 through `MAX_READ_TOPIC_FORMAT_VERSION`; rendering still uses `TOPIC_FORMAT_VERSION`. Task 10 removes the temporary ceiling and requires exactly v3. This makes the parser commit green without producing v3 files.

- [ ] **Step 4: Verify GREEN**

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::topic_parser::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::topic_file::tests -- --nocapture
npm test -- src/services/githubNotificationsProvider.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/notes/github_notifications.rs src-tauri/src/notes/mod.rs src-tauri/src/notes/sync/topic_file.rs src-tauri/src/notes/sync/topic_parser.rs src-tauri/src/notes/sync/fixtures/topic_golden.md src-tauri/src/notes/sync/fixtures/github_notifications_golden.md src/services/githubNotificationsProvider.ts src/services/githubNotificationsProvider.test.ts
git commit -m "feat(notes): accept plugin topic markdown v3"
```

---

### Task 2: Prepare SQLite v3 and Wire Types Without Activating Them

**Files:**

- Modify: `src-tauri/src/notes/schema.rs`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src/domain/notes.ts`
- Modify: `src/domain/notes.test.ts`
- Modify: `src/domain/externalSources.ts`
- Create: `src/domain/externalSources.test.ts`
- Modify: `src/services/notesStore.ts`
- Modify: `src/services/notesStore.test.ts`
- Modify: `src/services/notesStore.tauri.test.ts`

**Interfaces:**

```rust
pub(crate) struct NoteNode {
    // existing fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) is_readonly: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) plugin_state: Option<GithubNotificationsPluginState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) plugin_meta: Option<GithubNotificationsPluginMeta>,
}
```

```ts
type DeleteReadonlyPreflight = {
  readonlyDescendantIds: NoteId[];
};

type ConfirmReadonlyDescendants = {
  expectedReadonlyDescendantIds: NoteId[];
};
```

- [ ] **Step 1: Add RED schema, strict wire, and query tests**

Cover:

- explicit `V3_SCHEMA_SQL` creates a version-3 test database with all new columns
- ordinary rows decode 0/1; GN-owned rows decode `NULL` and omit `isReadonly`
- unknown/malformed plugin JSON fails normalization
- Active/All include GN-owned rows
- Recent/Starred/Tags/Archive/Trash/Search/FTS omit GN-owned rows
- user rows under omitted plugin ancestors remain visible as projected scope roots

Frontend validator assertion:

```ts
expect(isNoteNode({
  ...validNode,
  isReadonly: true,
  pluginState: undefined,
  pluginMeta: undefined
})).toBe(true);

expect(isNoteNode({
  ...validNode,
  isReadonly: true,
  pluginMeta: githubNotificationMeta
})).toBe(false);
```

- [ ] **Step 2: Verify RED**

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests -- --nocapture
npm test -- src/domain/notes.test.ts src/domain/externalSources.test.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
```

Expected: FAIL on absent v3 schema definition, fields, and command wire types.

- [ ] **Step 3: Implement dormant v3 schema and row decoding**

Add `NOTES_SCHEMA_VERSION_V3 = 3` and `V3_SCHEMA_SQL`, but keep `CURRENT_NOTES_SCHEMA_VERSION = 2` and the production `CURRENT_SCHEMA_SQL` unchanged until Task 10. Focused repository tests create their in-memory connection explicitly from `V3_SCHEMA_SQL`.

Prepare v3 forms of:

- `V3_SCHEMA_SQL`
- all FTS/lifecycle/attachment reindex triggers
- `StoredNode`, `AuditNodeRow`, `stored_node_from_row`, `note_node_from_row`, `note_node_from_audit_json`
- history JSON select lists
- workspace, tag, date, FTS, structured search queries

Use one repository helper:

```rust
const EXCLUDE_PLUGIN_OWNED_SQL: &str =
    "(plugin_meta IS NULL AND id <> ?1)";
```

For user-only scopes, return user descendants at the plugin boundary with `parent_id = NULL`; do not leave an orphaned parent ID that `normalizeNotesWorkspace` will hide.

Do not point `initialize_notes_db` or production load queries at these v3 definitions yet. Task 10 performs that switch and proves that an existing v2 database is rejected before any file or schema mutation.

- [ ] **Step 4: Implement exact TS/Rust wire validators**

Update `NOTE_NODE_KEYS`, `isNoteNode`, `canonicalNodeEquals`, mutation validators, and Tauri wrappers. Do not make validators permissive with index signatures.

- [ ] **Step 5: Verify GREEN and architecture**

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests -- --nocapture
npm test -- src/domain/notes.test.ts src/domain/externalSources.test.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
npm run test:architecture
```

Expected: selected v3 fixture/wire tests and architecture budget PASS while the production schema constant remains 2.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/notes/schema.rs src-tauri/src/notes/types.rs src-tauri/src/notes/repository.rs src/domain/notes.ts src/domain/notes.test.ts src/domain/externalSources.ts src/domain/externalSources.test.ts src/services/notesStore.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
git commit -m "feat(notes): add plugin and readonly storage fields"
```

---

### Task 3: Enforce General Readonly at the Repository Boundary

**Files:**

- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/history.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src/services/notesStore.ts`
- Modify: `src/services/notesStore.test.ts`
- Modify: `src/features/notes/notesWorkspaceTypes.ts`
- Modify: `src/features/notes/useNotesCommandActions.ts`
- Modify: `src/features/notes/notesCommands.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Modify: `src/features/notes/useNotesWorkspace.operations.test.tsx`

**Interfaces:**

```rust
pub(crate) struct SetReadonlyInput {
    pub(crate) node_id: NoteId,
    pub(crate) is_readonly: bool,
}

pub(crate) struct DeleteNodesInput {
    pub(crate) node_ids: Vec<NoteId>,
    pub(crate) expected_readonly_descendant_ids: Option<Vec<NoteId>>,
}
```

Repository result:

```rust
enum DeleteNodesOutcome {
    Deleted(NotesMutationResult),
    NeedsReadonlyConfirmation { readonly_descendant_ids: Vec<NoteId> },
}
```

- [ ] **Step 1: Add RED authorization tests**

Add table-driven repository tests for:

| Mutation | readonly target | readonly descendant in moved/deleted tree | Expected |
| --- | --- | --- | --- |
| title/note/attachment add/remove/resize | block | n/a | no write/history/HLC |
| direct delete/cut/Trash/empty Backspace | block | n/a | no write |
| move/Tab/ShiftTab/reorder/Move To | block | block | no write |
| move another sibling before/after/under readonly | allow | n/a | one mutation |
| Enter child/sibling creation | allow | n/a | new node readonly=false |
| complete/star/archive/collapse | allow | n/a | existing behavior |
| duplicate readonly tree | allow | n/a | flags preserved |

Add setter tests for an ordinary root, ordinary child, GN root and GN-owned child:

```rust
#[test]
fn setting_readonly_updates_hlc_dirty_export_and_one_history_entry() {
    let before = load_node(&connection, &ordinary_id);
    let result =
        set_readonly_at(&mut connection, ordinary_id.clone(), true, fixed_now()).unwrap();
    let after = load_node(&connection, &ordinary_id);
    assert_eq!(after.is_readonly, Some(true));
    assert_ne!(after.hlc, before.hlc);
    assert!(result.changed);
    assert_one_history_entry(&connection);
    assert_topic_dirty(&connection, &ordinary_root_id);
}

#[test]
fn setting_readonly_rejects_plugin_owned_rows_without_writes() {
    assert_no_mutation(|| set_readonly(&mut connection, GITHUB_NOTIFICATIONS_ROOT_ID, true));
    assert_no_mutation(|| set_readonly(&mut connection, &materialized_notification_id, true));
}
```

Deletion confirmation tests must assert:

```rust
let first = delete_nodes(&connection, input_without_confirmation).unwrap();
let DeleteNodesOutcome::NeedsReadonlyConfirmation {
    readonly_descendant_ids,
} = first else {
    panic!("expected readonly confirmation");
};
assert_eq!(readonly_descendant_ids, vec![locked_child.clone()]);
assert_workspace_unchanged(&connection, &before);

let stale = delete_nodes(
    &connection,
    confirmed_input(vec![locked_child.clone()])
);
assert!(matches!(stale, Err(NotesError::ReadonlyConfirmationStale)));
```

The stale case adds another readonly descendant or changes the target itself to readonly between requests.

- [ ] **Step 2: Verify RED**

```bash
cargo test --manifest-path src-tauri/Cargo.toml readonly -- --nocapture
```

Expected: FAIL because mutations currently ignore readonly.

- [ ] **Step 3: Add centralized guards**

Build narrow helpers around existing `node_by_id`, `require_live_node`, `require_active_node`, `ensure_live_parent`, and `ensure_reparent_target`:

```rust
fn require_content_mutable(node: &StoredNode) -> NotesResult<()> { /* ordinary unlocked only */ }
fn require_subtree_movable(tx: &Transaction, node_id: &str) -> NotesResult<()> { /* no readonly */ }
fn readonly_descendants(tx: &Transaction, roots: &[NoteId]) -> NotesResult<Vec<NoteId>> { /* sorted */ }
```

Call them from create/split/update/move, batch helpers, import, duplicate, lifecycle, delete/restore, image/Markdown import, and every attachment mutation. UI guards are convenience only; repository checks remain authoritative.

- [ ] **Step 4: Implement set/unset readonly through normal mutation/history**

`set_readonly_at` validates an ordinary row, updates the root HLC or node HLC, records one normal history entry, marks the owning topic dirty, and returns the normal mutation delta. `is_readonly=false` is an explicit ordinary DB value. GN root/date/notification return the same protected-node error used by the other generic mutation guards.

Prepare the Tauri command function and TypeScript wrapper, but do not add it to `generate_handler!`, `APP_COMMANDS` or ACL until the Task 10 atomic cutover.

- [ ] **Step 5: Implement atomic delete preflight and stale recheck**

The first call returns the exact sorted readonly descendant IDs and performs no write. The confirmed call opens the same `IMMEDIATE` transaction as delete, recomputes the set, compares exact equality, rejects a readonly target, and then runs the existing atomic delete path.

Do not use a server token table or a bare `allowReadonlyDescendants: true` boolean.

- [ ] **Step 6: Preserve history and duplicate/restore fields**

Extend `NODE_JSON_NEW`, `NODE_JSON_OLD`, `NodeSnapshot`, replay upsert, Trash and duplicate copy paths so readonly/plugin fields survive Undo/Redo, duplicate, confirmed delete, and restore.

- [ ] **Step 7: Verify GREEN**

```bash
cargo test --manifest-path src-tauri/Cargo.toml readonly -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests -- --nocapture
npm test -- src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/services/notesStore.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/notes/types.rs src-tauri/src/notes/repository.rs src-tauri/src/notes/history.rs src-tauri/src/notes/commands.rs src/services/notesStore.ts src/services/notesStore.test.ts src/features/notes/notesWorkspaceTypes.ts src/features/notes/useNotesCommandActions.ts src/features/notes/notesCommands.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx
git commit -m "feat(notes): protect readonly content and structure"
```

---

### Task 4: Prepare v3 Rendering and Full-row LWW Without Activating the Writer

**Files:**

- Modify: `src-tauri/src/notes/sync/topic_file.rs`
- Modify: `src-tauri/src/notes/sync/topic_parser.rs`
- Modify: `src-tauri/src/notes/sync/exporter.rs`
- Modify: `src-tauri/src/notes/sync/merger.rs`
- Modify: `src-tauri/src/notes/history.rs`
- Modify: `src-tauri/src/notes/sync/fixtures/topic_golden.md`
- Modify: `src-tauri/src/notes/sync/fixtures/github_notifications_golden.md`

- [ ] **Step 1: Add RED round-trip and conflict tests**

Cover:

- normal root `root_collapsed` and `root_readonly`
- all-depth user node `collapsed` and `readonly`
- GN root collapse, sorted `collapsed_groups`, hybrid plugin marker
- date/notification plugin metadata and provider snapshot
- GN-owned `root_readonly`/`readonly`, even false, quarantines
- GN DB rows with non-NULL readonly fail export
- user readonly descendants beneath GN round-trip
- explicit v3 topic/trash renderers emit exactly v3; production writer remains v2
- source disappearance preserves stored notification and descendants
- source snapshot advances for newer `notification_updated_at`
- equal-timestamp accepted mark-read may change `unread` true to false
- equal-timestamp stale source/cache data may not change `unread` false back to true

Replace the current merger assertion:

```rust
#[test]
fn winning_remote_update_applies_full_row_collapse_and_readonly_state() {
    // Higher remote HLC wins title, parent/order, completion, collapse,
    // readonly and plugin fields together.
}
```

- [ ] **Step 2: Verify RED**

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::topic_file::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::exporter::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::merger::tests -- --nocapture
```

Expected: FAIL because explicit v3 render paths and full-row merge fields do not exist.

- [ ] **Step 3: Implement render/export**

Add explicit v3 render/build functions and fixtures, but keep production `TOPIC_FORMAT_VERSION = 2` and the production render dispatch unchanged until Task 10. Update `render_topic_doc_v3`, `render_trash_doc_v3`, `render_node_comment_v3`, v3 `StoredNode` loading/building, assigned filename, snapshot and validated render paths. Focused tests invoke the v3 functions directly.

Canonical rules:

- ordinary root always emits `root_readonly: true|false`
- ordinary child false collapse/readonly omits the token and parses as false
- GN root omits root readonly entirely
- GN-owned date/notification comments omit readonly entirely
- user children under GN serialize normal collapse/readonly tokens
- `collapsed_groups` is a stable sorted JSON array

- [ ] **Step 4: Implement full-row merge and history**

Extend `RemoteNode`, `remote_topic_node`, `local_content_differs`, `apply_remote_node`, insert/update, conflict JSON, and history snapshots. Remove the special local-collapse preservation branch.

- [ ] **Step 5: Verify GREEN**

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::topic_file::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::topic_parser::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::exporter::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::merger::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests -- --nocapture
```

Expected: all selected explicit-v3 and merge tests PASS while production still renders v2.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/notes/sync/topic_file.rs src-tauri/src/notes/sync/topic_parser.rs src-tauri/src/notes/sync/exporter.rs src-tauri/src/notes/sync/merger.rs src-tauri/src/notes/history.rs src-tauri/src/notes/sync/fixtures/topic_golden.md src-tauri/src/notes/sync/fixtures/github_notifications_golden.md
git commit -m "feat(notes): prepare collapse and readonly markdown v3"
```

---

### Task 5: Seed the Fixed GN Root and Add Authoritative Materialization

**Files:**

- Modify: `src-tauri/src/notes/github_notifications.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/notes/sync/bootstrap.rs`
- Modify: `src-tauri/src/notes/sync/exporter.rs`
- Modify: `src-tauri/src/notes/sync/integration_tests.rs`
- Modify: `src/services/notesStore.ts`

**Commands:**

```rust
materialize_github_notification_and_create_sibling(input)
materialize_github_notification_and_reparent(input)
refresh_materialized_github_notifications(input)
set_github_group_collapsed(input)
mark_materialized_github_notification_read(input)
```

- [ ] **Step 1: Add RED bootstrap tests**

Assert:

- file reconciliation and quarantine inspection happen before seed
- an existing valid GN file wins over seed
- canonical GN file quarantine blocks seed/recovery
- fresh DB creates exactly one fixed root with epoch HLC
- later arrival of an older real remote row beats the epoch seed
- root-only DB recovery re-publishes the canonical file
- first publication atomically creates if absent, records identical bytes, and never overwrites differing bytes

- [ ] **Step 2: Add RED materialization/refresh tests**

Assert:

- title Enter materializes one date anchor + one notification and creates one unlocked sibling
- date and notification IDs are deterministic across devices, validate as canonical v4, and differ for distinct serialized connection keys
- retry deduplicates by canonical external key
- drop/import materializes then reparents once
- GN direct generic create/import/reparent is rejected
- notification/date/root generic content/lifecycle mutations are rejected
- root same-parent top-level reorder and root collapse are allowed
- notification refresh updates newer snapshots
- accepted mark-read persists `unread=false` at equal `updatedAt`
- an equal-timestamp stale source snapshot with `unread=true` cannot revert saved `unread=false`
- `{rootId, groupKey, collapsed}` sets the date group to the explicit boolean and a retry with the same value is a no-op
- a changed date-group collapse updates the GN root HLC, dirty/export state and one history entry; Undo/Redo restores the set
- date change moves notification + descendants atomically, leaves unindented date sibling behind, and removes only an empty old anchor
- provider date move is allowed with readonly user descendants
- failure at any refresh/date-move step rolls back snapshot, anchor, subtree and cleanup

- [ ] **Step 3: Verify RED**

```bash
cargo test --manifest-path src-tauri/Cargo.toml github -- --nocapture
```

Expected: FAIL because seed and authoritative commands do not exist.

- [ ] **Step 4: Prepare a disabled seed hook after startup reconciliation**

Implement `seed_github_notifications_root_v3` so focused tests can call it after `reconcile_files` and before pending export flush. Reuse `sync_topics`, dirty/export flow, quarantine recording, and missing-topic recovery. Do not call it from the production reconciliation sequence until Task 10.

GN first-publication branch:

1. `write_atomic_file(..., false)` if absent.
2. If present and bytes match, record published snapshot.
3. If present and bytes differ, do not overwrite; leave dirty and wait for watcher merge.

Use the canonical filename as the blocker for a malformed canonical file. Extend quarantine metadata with a safe claimed plugin/root hint only if conflict-copy blocking cannot otherwise be proven.

- [ ] **Step 5: Implement narrow provider-authoritative transactions**

Keep generic repository guards strict. Put GN exceptions only in focused commands that validate:

- fixed root
- canonical date key
- provider `github`
- canonical serialized notification key; parse provider/connection identity from this command input value but persist only the key
- stable metadata ownership
- expected source timestamp

Do not expose a generic `force` or plugin-capability bypass.

Derive child IDs in one Rust helper:

```rust
fn normalized_v4_from_v5(namespace: Uuid, key: &str) -> Uuid {
    let mut bytes = *Uuid::new_v5(&namespace, key.as_bytes()).as_bytes();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x0f) | 0x80;
    Uuid::from_bytes(bytes)
}
```

Use `date_key` for date anchors and the exact `serializeExternalBulletKey` result for notifications. Test repeatability, v4 validation, and distinct IDs for the same thread on two connection keys.

Prepare command functions and TypeScript wrappers without registering them in Tauri. The metadata row is `{kind, notification_key, type, url, updated_at, unread}`; do not persist redundant provider or connection fields.

`set_github_group_collapsed` must validate the fixed root and real local date key, update the sorted/deduplicated `plugin_state` set to the requested boolean, and reuse the existing root mutation/history path. Return an unchanged result without a new HLC/history/export entry when the set already has the requested state. Add command tests that toggle, retry, Undo and Redo.

- [ ] **Step 6: Verify GREEN**

```bash
cargo test --manifest-path src-tauri/Cargo.toml github -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::integration_tests -- --nocapture
```

Expected: all selected explicit v3/disabled-seed tests PASS while production seed remains off.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/notes/github_notifications.rs src-tauri/src/notes/repository.rs src-tauri/src/notes/types.rs src-tauri/src/notes/commands.rs src-tauri/src/notes/sync/bootstrap.rs src-tauri/src/notes/sync/exporter.rs src-tauri/src/notes/sync/integration_tests.rs src/services/notesStore.ts
git commit -m "feat(notes): materialize github notification trees"
```

---

### Task 6: Build One Deterministic Hybrid Outline

**Files:**

- Create: `src/features/notes/githubNotificationsOutline.ts`
- Create: `src/features/notes/githubNotificationsOutline.test.ts`
- Modify: `src/features/notes/NotesLibraryPane.tsx`
- Modify: `src/features/notes/NotesLibraryPane.test.tsx`
- Modify: `src/features/notes/NotesExternalLibraryPageRow.tsx`
- Modify: `src/features/notes/NotesDetailPane.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/NotesExternalOutlinePane.tsx`
- Modify: `src/features/notes/NotesExternalOutlinePane.test.tsx`
- Modify: `src/features/notes/NotesFeature.test.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`

**Pure presentation contract:**

```ts
type GithubOutlineProjection = {
  rows: readonly GithubOutlineRow[];
  sortableIds: readonly NoteId[];
  selectableUserNodeIds: readonly NoteId[];
  editorFocusKeys: readonly GithubEditorFocusKey[];
};
```

- [ ] **Step 1: Add RED pure helper tests**

Test:

- stored root order `[ordinary A, GN, ordinary B]` is identical in sidebar and All
- dates sort descending
- within a date: stored block by `sortKey`, then projection block by `updatedAt` descending and serialized key ascending
- stored notification deduplicates its projection copy
- materialization appends to stored block without moving user siblings
- disappeared remote item retains stored snapshot/children
- `showCompleted=false` hides read notification subtree but not `viewedAt`-only item
- ordinary `completedAt` filtering remains active for user children
- empty/loading/error rows never become selectable/sortable

- [ ] **Step 2: Verify RED**

```bash
npm test -- src/features/notes/githubNotificationsOutline.test.ts src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesExternalOutlinePane.test.tsx src/features/notes/NotesFeature.test.tsx
```

Expected: FAIL because stored and provider trees are still separate.

- [ ] **Step 3: Traverse roots once**

Remove the virtual `externalPages` prepend and provider selection branch. Render `state.rootIds` exactly once. For the fixed GN root, reuse the action-free external library row shape but pass the stored root.

`NotesDetailPane` always renders `NotesOutlinePane`; GN zoom becomes a mode of the same outline, not a separate page.

- [ ] **Step 4: Compose rows without polluting normalized storage**

Keep `outlineTree.ts`, `nodesById`, and `childIdsByParent` stored-only. `githubNotificationsOutline.ts` returns separate render, selection, sortable, and focus orders. Never cast provider keys to `NoteId`.

In All, keep the GN sortable root `<li>` separate from the hybrid child region so its drag rectangle is one row high. In GN zoom, omit root editor/menu/export/composer but preserve breadcrumb/history/maximize behavior.

- [ ] **Step 5: Verify GREEN and budget**

```bash
npm test -- src/features/notes/githubNotificationsOutline.test.ts src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesExternalOutlinePane.test.tsx src/features/notes/NotesFeature.test.tsx src/features/notes/NotesWorkspace.test.tsx
npm run test:architecture
```

Expected: all selected tests and architecture budget PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/notes/githubNotificationsOutline.ts src/features/notes/githubNotificationsOutline.test.ts src/features/notes/NotesLibraryPane.tsx src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesExternalLibraryPageRow.tsx src/features/notes/NotesDetailPane.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesExternalOutlinePane.tsx src/features/notes/NotesExternalOutlinePane.test.tsx src/features/notes/NotesFeature.test.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "feat(notes): compose github notifications in the outline"
```

---

### Task 7: Reuse Native Editors, Keyboard Navigation, and Provider Actions

**Files:**

- Modify: `src/features/notes/NotesExternalBulletRow.tsx`
- Modify: `src/features/notes/NotesExternalBulletRow.test.tsx`
- Modify: `src/features/notes/NoteTextField.tsx`
- Modify: `src/features/notes/NoteTextField.test.tsx`
- Modify: `src/features/notes/outlineKeyboard.ts`
- Modify: `src/features/notes/outlineKeyboard.test.ts`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/NotesBulletMenu.tsx`
- Modify: `src/features/notes/NotesBulletMenu.test.tsx`
- Modify: `src/features/notes/notesPasteImport.ts`
- Modify: `src/features/notes/notesPasteImport.test.ts`
- Modify: `src/features/notes/notes.css`

- [ ] **Step 1: Add RED interaction tests**

Provider notification title/note must:

- use `NoteTextField` and existing `.notes-node-*` markup
- permit caret, selection, copy, and temporary typing
- restore on blur, Escape, source refresh and unmount
- preserve focus and clamp caret on source refresh
- avoid notes draft mutation/HLC/history/export
- make title Enter and note Shift+Enter materialize + create unlocked sibling
- allow the new sibling Tab to indent under notification
- render `ExternalLink` then the non-interactive lock in a 6px inline cluster immediately after the displayed title; a long title shrinks/ellipsizes before the cluster, and the cluster never pins to the pane edge
- consume destructive Backspace/delete/cut/duplicate/reorder/Tab/ShiftTab on provider row
- materialize only structural multi-line title paste
- leave single-line title paste and all note paste temporary

Composite focus tests cover saved notification, projection notification, and ordinary user nodes for ArrowUp/Down and boundary ArrowLeft/Right. IME composition must not emit structural commands.

- [ ] **Step 2: Verify RED**

```bash
npm test -- src/features/notes/NotesExternalBulletRow.test.tsx src/features/notes/outlineKeyboard.test.ts src/features/notes/NoteTextField.test.tsx src/features/notes/notesPasteImport.test.ts
```

Expected: FAIL because provider rows are static/button-based.

- [ ] **Step 3: Implement ephemeral provider editors**

Keep `NoteTextField` editable. Do not pass its `readOnly` prop because that prevents the required caret behavior. Store temporary text locally and restore from a provider snapshot ref.

```tsx
<NoteTextField
  value={temporaryTitle}
  onChange={(event) => setTemporaryTitle(event.currentTarget.value)}
  onBlur={restoreProviderSnapshot}
  onKeyDown={handleProtectedTitleKeyDown}
/>
```

Provider drafts must bypass `notesDraftEngine.ts` and `useNotesDraftWorkflow.ts`.

- [ ] **Step 4: Add the composite focus adapter**

Use DOM editor keys, not fake NoteIds:

```ts
type GithubEditorFocusKey =
  | { kind: "stored"; nodeId: NoteId; field: "title" | "note" }
  | { kind: "provider"; key: string; field: "title" | "note" };
```

When filter/collapse/refresh removes the focused row, move focus to the previous visible title, then next, then GN root/header.

- [ ] **Step 5: Complete row actions and accessibility**

- Use existing Type icon mapping and `notificationSubtitle`.
- Remove the dedicated completion checkbox.
- Notification menu has one-way Complete only while unread.
- Cmd/Ctrl+Enter on notification title calls existing `externalSourceHost.complete` path once.
- `ExternalLink` calls the existing `openNotification` bridge and records only `viewedAt`.
- Keep the link button in DOM Tab order; reveal with row hover/`:focus-within`; show always for coarse pointer.
- Show non-interactive `Lock` with accessible name `GitHub에서 관리됨`.
- Render those two controls as `<span className="notes-node-inline-actions">` directly after the title field, in `ExternalLink` → `Lock` order. Use CSS inline flex with `flex: none` and `gap: 6px`; let only the title field shrink and ellipsize. Do not use `margin-inline-start: auto`, a pane-wide action grid column, absolute positioning, or JavaScript text measurement.

- [ ] **Step 6: Verify GREEN**

```bash
npm test -- src/features/notes/NotesExternalBulletRow.test.tsx src/features/notes/outlineKeyboard.test.ts src/features/notes/NoteTextField.test.tsx src/features/notes/NotesBulletMenu.test.tsx src/features/notes/notesPasteImport.test.ts src/features/notes/NotesWorkspace.test.tsx
```

Expected: all selected tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/notes/NotesExternalBulletRow.tsx src/features/notes/NotesExternalBulletRow.test.tsx src/features/notes/NoteTextField.tsx src/features/notes/NoteTextField.test.tsx src/features/notes/outlineKeyboard.ts src/features/notes/outlineKeyboard.test.ts src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesBulletMenu.tsx src/features/notes/NotesBulletMenu.test.tsx src/features/notes/notesPasteImport.ts src/features/notes/notesPasteImport.test.ts src/features/notes/notes.css
git commit -m "feat(notes): reuse native interactions for github alerts"
```

---

### Task 8: Add General Readonly UI, DnD Guards, and Delete Confirmation

**Files:**

- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPageHeader.tsx`
- Modify: `src/features/notes/NotesLibraryPageRow.tsx`
- Modify: `src/features/notes/NotesBulletMenu.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/notesMoveTargets.ts`
- Modify: `src/features/notes/outlineDrag.ts`
- Modify: `src/features/notes/outlinePointerDrop.ts`
- Modify: `src/features/notes/notesSelectionActions.ts`
- Modify: `src/features/notes/useNotesSelectionCommandRouter.ts`
- Modify: `src/features/notes/useNotesAttachmentWorkflow.ts`
- Modify: `src/features/notes/NotesAttachmentList.tsx`
- Modify: `src/features/notes/NotesImageAttachment.tsx`
- Modify: `src/features/notes/ImageAtomEditor.tsx`
- Modify: `src/features/notes/NotesPageHeader.test.tsx`
- Modify: `src/features/notes/NotesLibraryPageRow.test.tsx`
- Modify: `src/features/notes/NotesBulletMenu.test.tsx`
- Modify: `src/features/notes/outlineDrag.test.ts`
- Modify: `src/features/notes/outlinePointerDrop.test.ts`
- Modify: `src/features/notes/notesMoveTargets.test.ts`
- Modify: `src/features/notes/notesSelectionActions.test.ts`
- Modify: `src/features/notes/useNotesSelectionCommandRouter.test.tsx`
- Modify: `src/features/notes/NotesAttachmentIngest.test.tsx`
- Modify: `src/features/notes/NotesAttachmentList.test.tsx`
- Modify: `src/features/notes/NotesImageAttachment.test.tsx`
- Modify: `src/features/notes/ImageAtomEditor.test.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`

- [ ] **Step 1: Add RED readonly editor/menu tests**

Test ordinary root/node and GN user child:

- menu toggles readonly and shows no toggle for GN-owned rows
- same native title/note editor permits temporary typing then restores on blur/Escape/navigation/unmount
- backing sync/Undo update replaces the temporary draft, preserves focus, and clamps caret
- title Enter and note Shift+Enter create an unlocked sibling
- completed/star/archive/collapse and general child creation remain available
- content, direct delete, Move To, Tab/ShiftTab, drag/reorder, cut and attachment mutations are unavailable
- other nodes can move before/after/under readonly
- duplicate preserves readonly
- common lock icon appears only hover/focus-within, has no tab stop, and announces `읽기 전용`

Keep existing archive/trash lifecycle `readOnlyMode` tests unchanged. General `isReadonly` must use the normal editor branch.

- [ ] **Step 2: Add RED DnD and delete-dialog tests**

Cover:

- readonly target/subtree move blocked
- GN root same-parent top-level reorder allowed even with readonly descendant
- projection notification is droppable but not sortable
- drop materializes and reparents once
- plugin-owned rows excluded from selection/batch/move destinations
- direct readonly delete never opens override
- ancestor/batch delete opens one `ConfirmDialog`
- dialog defaults focus to Cancel
- cancel performs no mutation
- confirm retries with exact expected readonly descendant IDs
- stale response reopens with latest state
- cut remains unavailable when confirmation would be required

- [ ] **Step 3: Verify RED**

```bash
npm test -- src/features/notes/outlineDrag.test.ts src/features/notes/outlinePointerDrop.test.ts src/features/notes/notesMoveTargets.test.ts src/features/notes/notesSelectionActions.test.ts src/features/notes/useNotesSelectionCommandRouter.test.tsx
npm test -- src/features/notes/NotesBulletMenu.test.tsx src/features/notes/NotesLibraryPageRow.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/NotesWorkspace.test.tsx
```

Expected: FAIL because general readonly UI and warning flow do not exist.

- [ ] **Step 4: Implement readonly editor without lifecycle static mode**

Use controlled local values only when `node.isReadonly === true`; route normal nodes through the existing draft workflow. Block persistence before enqueue, then rely on repository checks as final authority.

For image nodes, allow temporary surrounding text editing but block atom remove/cut/paste/resize and attachment ingest.

- [ ] **Step 5: Implement movement and delete contracts**

- DnD/keyboard Move To checks the moved target subtree, not destination readonly state.
- Register provider projection notification with `useDroppable`, never `useSortable`.
- Keep GN root sortable only at top level and reject reparent.
- First delete call may return exact readonly IDs; render one shared dialog and retry with that exact set.

Dialog copy:

```text
읽기 전용 블릿이 포함되어 있습니다. 함께 삭제할까요?
```

Buttons: `취소` first/default, `삭제` destructive.

- [ ] **Step 6: Verify GREEN**

```bash
npm test -- src/features/notes/outlineDrag.test.ts src/features/notes/outlinePointerDrop.test.ts src/features/notes/notesMoveTargets.test.ts src/features/notes/notesSelectionActions.test.ts src/features/notes/useNotesSelectionCommandRouter.test.tsx
npm test -- src/features/notes/NotesBulletMenu.test.tsx src/features/notes/NotesLibraryPageRow.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/NotesAttachmentList.test.tsx src/features/notes/NotesImageAttachment.test.tsx src/features/notes/ImageAtomEditor.test.tsx src/features/notes/NotesWorkspace.test.tsx
npm run test:architecture
```

Expected: all selected tests and architecture budget PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesPageHeader.tsx src/features/notes/NotesLibraryPageRow.tsx src/features/notes/NotesBulletMenu.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/notesMoveTargets.ts src/features/notes/outlineDrag.ts src/features/notes/outlinePointerDrop.ts src/features/notes/notesSelectionActions.ts src/features/notes/useNotesSelectionCommandRouter.ts src/features/notes/useNotesAttachmentWorkflow.ts src/features/notes/NotesAttachmentList.tsx src/features/notes/NotesImageAttachment.tsx src/features/notes/ImageAtomEditor.tsx
git add src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesLibraryPageRow.test.tsx src/features/notes/NotesBulletMenu.test.tsx src/features/notes/outlineDrag.test.ts src/features/notes/outlinePointerDrop.test.ts src/features/notes/notesMoveTargets.test.ts src/features/notes/notesSelectionActions.test.ts src/features/notes/useNotesSelectionCommandRouter.test.tsx
git add src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/NotesAttachmentList.test.tsx src/features/notes/NotesImageAttachment.test.tsx src/features/notes/ImageAtomEditor.test.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "feat(notes): expose readonly as a native bullet state"
```

---

### Task 9: Connect Source Lease, Refresh, Read Filter, and Date Collapse

**Files:**

- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/ExternalSourcesContext.ts`
- Modify: `src/hooks/useExternalSource.ts`
- Modify: `src/hooks/useExternalSource.test.tsx`
- Modify: `src/services/githubNotificationsProvider.ts`
- Modify: `src/services/githubNotificationsProvider.test.ts`
- Modify: `src/services/externalSourceHost.test.ts`
- Modify: `src/services/externalSourceSnapshotStore.test.ts`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/NotesExternalOutlinePane.tsx`

- [ ] **Step 1: Add RED integration tests**

Assert:

- source lease is active only while expanded GN is visible in All or GN zoom is open
- closed All GN releases lease
- the same projection-request boolean starts/stops the existing 60-second projection clock
- successful completed refresh or mark-read advances persisted materialized snapshots once
- partial/loading/error refresh does not write saved state
- failure preserves cache and saved snapshot
- source disappearance preserves materialized rows
- same `updatedAt` with another timezone representation does not move date
- date groups default expanded, store only collapsed keys, and update All/GN zoom immediately
- root collapse hides hybrid children in All but not GN zoom
- `showCompleted=false` hides read notification subtree; `viewedAt` has no effect
- mark-read failure keeps unread and visible

- [ ] **Step 2: Verify RED**

```bash
npm test -- src/App.test.tsx src/hooks/useExternalSource.test.tsx src/services/githubNotificationsProvider.test.ts src/services/externalSourceHost.test.ts src/services/externalSourceSnapshotStore.test.ts src/features/notes/NotesExternalOutlinePane.test.tsx
```

Expected: FAIL on missing stored-root lease and backend refresh bridge.

- [ ] **Step 3: Keep the existing source host API**

Do not add a generic host callback. In `App.tsx`, use a narrow effect keyed by connection identity and `notificationSourceState.syncedAt`; that value advances only after completed loads or successful mark-read cache updates.

```ts
useEffect(() => {
  if (!connectionId || !notificationSourceState.syncedAt) return;
  void notesStore.refreshMaterializedGithubNotifications({
    connectionId,
    items: notificationSourceState.items
  });
}, [
  connectionId,
  notificationSourceState.items,
  notificationSourceState.syncedAt
]);
```

Backend timestamps remain authoritative and make repeated equivalent refreshes no-ops. If `items` identity is not stable across unrelated renders, memoize the provider snapshot at its source rather than suppressing `react-hooks/exhaustive-deps`.

- [ ] **Step 4: Replace active provider routing with a projection request boolean**

`NotesOutlinePane` requests GitHub projection only for:

- All visible and GN expanded
- GN zoom visible

Remove `activeProviderId/selectProvider`. Retain minimal provider refresh, complete, open and projection data actions in context.

Drive both the existing source lease and `useProjectionClock(..., 60_000)` from this boolean. Add a fake-timer test that proves the minute clock advances while requested, stops after collapse/navigation, and does not restart from unrelated Notes renders.

- [ ] **Step 5: Verify GREEN**

```bash
npm test -- src/App.test.tsx src/hooks/useExternalSource.test.tsx src/services/githubNotificationsProvider.test.ts src/services/externalSourceHost.test.ts src/services/externalSourceSnapshotStore.test.ts src/features/notes/NotesExternalOutlinePane.test.tsx
```

Expected: all selected tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/App.test.tsx src/ExternalSourcesContext.ts src/hooks/useExternalSource.ts src/hooks/useExternalSource.test.tsx src/services/githubNotificationsProvider.ts src/services/githubNotificationsProvider.test.ts src/services/externalSourceHost.test.ts src/services/externalSourceSnapshotStore.test.ts src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesExternalOutlinePane.tsx
git commit -m "feat(notes): refresh materialized github notifications"
```

---

### Task 10: Final Cutover, Cross-device Tests, and Fresh Tauri Proof

**Files:**

- Modify: `src-tauri/src/notes/schema.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/sync/topic_file.rs`
- Modify: `src-tauri/src/notes/sync/topic_parser.rs`
- Modify: `src-tauri/src/notes/sync/exporter.rs`
- Modify: `src-tauri/src/notes/sync/bootstrap.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/build.rs`
- Modify: `src-tauri/permissions/main-window.toml`
- Create: `src-tauri/permissions/autogenerated/notes_set_readonly.toml`
- Create: `src-tauri/permissions/autogenerated/notes_materialize_github_notification_and_create_sibling.toml`
- Create: `src-tauri/permissions/autogenerated/notes_materialize_github_notification_and_reparent.toml`
- Create: `src-tauri/permissions/autogenerated/notes_refresh_materialized_github_notifications.toml`
- Create: `src-tauri/permissions/autogenerated/notes_set_github_group_collapsed.toml`
- Create: `src-tauri/permissions/autogenerated/notes_mark_materialized_github_notification_read.toml`
- Modify: `src-tauri/gen/schemas/acl-manifests.json`
- Modify: `src-tauri/gen/schemas/capabilities.json`
- Modify: `src-tauri/gen/schemas/desktop-schema.json`
- Modify: `src-tauri/gen/schemas/macOS-schema.json`

- [ ] **Step 1: Add RED cutover and registration tests**

Add tests that prove:

- an existing v2 DB is rejected during preflight before `CREATE TABLE`, `user_version`, file, quarantine or dirty state changes
- a fresh database uses v3 columns and constraints
- production topic/trash render dispatch emits v3
- final parser rejects v2 and missing format version
- production startup invokes the already-tested GN seed only after reconciliation
- every new command appears exactly once in `generate_handler!`, `APP_COMMANDS`, generated allow manifests, the main-window permission set and generated capability schemas

```bash
cargo test --manifest-path src-tauri/Cargo.toml application_manifest_covers_every_registered_command_exactly_once -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml application_commands_are_granted_only_to_local_main_window -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml v2 -- --nocapture
```

Expected: FAIL until the constants, invoke handler and generated ACL artifacts switch together.

- [ ] **Step 2: Activate exact v3 cutover in one commit**

Switch these constants and hooks together:

```text
CURRENT_NOTES_SCHEMA_VERSION = 3
CURRENT_SCHEMA_SQL = V3_SCHEMA_SQL
TOPIC_FORMAT_VERSION = 3
GN production seed enabled
topic parser requires exactly v3
trash parser requires exactly v3
all prepared Notes/GN commands registered
main-window ACL regenerated for the same exact command set
```

Remove `MAX_READ_TOPIC_FORMAT_VERSION`, production v2 fallback writer, and all dormant dispatch branches. Change `initialize_notes_db` preflight to reject schema v2 before any mutation; do not run `CREATE TABLE IF NOT EXISTS` and then relabel it v3. No compatibility migration or mixed format branch may remain.

Regenerate the Tauri permission artifacts with the repository's existing generation workflow, then inspect the generated diff. Do not hand-edit JSON unless the existing workflow is unavailable.

- [ ] **Step 3: Verify the atomic cutover**

```bash
cargo test --manifest-path src-tauri/Cargo.toml application_manifest_covers_every_registered_command_exactly_once -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml application_commands_are_granted_only_to_local_main_window -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml v2 -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::topic_parser::tests -- --nocapture
```

Expected: all selected tests PASS.

- [ ] **Step 4: Commit the cutover alone**

```bash
git add src-tauri/src/notes/schema.rs src-tauri/src/notes/repository.rs src-tauri/src/notes/sync/topic_file.rs src-tauri/src/notes/sync/topic_parser.rs src-tauri/src/notes/sync/exporter.rs src-tauri/src/notes/sync/bootstrap.rs src-tauri/src/lib.rs src-tauri/build.rs src-tauri/permissions/main-window.toml
git add src-tauri/permissions/autogenerated/notes_set_readonly.toml src-tauri/permissions/autogenerated/notes_materialize_github_notification_and_create_sibling.toml src-tauri/permissions/autogenerated/notes_materialize_github_notification_and_reparent.toml src-tauri/permissions/autogenerated/notes_refresh_materialized_github_notifications.toml src-tauri/permissions/autogenerated/notes_set_github_group_collapsed.toml src-tauri/permissions/autogenerated/notes_mark_materialized_github_notification_read.toml
git add src-tauri/gen/schemas/acl-manifests.json src-tauri/gen/schemas/capabilities.json src-tauri/gen/schemas/desktop-schema.json src-tauri/gen/schemas/macOS-schema.json
git commit -m "feat(notes): activate markdown and sqlite v3"
```

- [ ] **Step 5: Run focused cross-device integration scenarios**

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::integration_tests -- --nocapture
```

Required scenarios:

1. A materializes notification, creates sibling, Tabs it under notification.
2. A folds GN root/date and sets a user child readonly.
3. Markdown-only sync into empty B restores order, collapse, snapshot, tree and readonly.
4. B refresh moves notification + child to a new date, leaving date sibling behind.
5. Source removal keeps saved snapshot/tree.
6. B confirms ancestor delete; A merges tombstone without a second warning.
7. corrupt canonical GN file is quarantined and never auto-overwritten.

Expected: all integration tests PASS.

- [ ] **Step 6: Run all automated gates**

```bash
npm test
npm run lint
npm run test:architecture
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
git diff --check
```

Expected: every command exits 0. Record exact test counts in the task report.

- [ ] **Step 7: Review the final diff before desktop launch**

```bash
git status --short
git diff --stat
git diff --check
```

Confirm:

- only planned files are changed
- `.superpowers/sdd/*.md` remain untouched/un-staged
- no secret, token, API payload, local vault path or generated database is present
- no new dependency or plugin framework was added

- [ ] **Step 8: Start a fresh isolated Tauri development build**

Use a fresh temporary vault/database through the app's development reset flow. Do not reuse a running web-only Vite tab as desktop proof.

```bash
npm run tauri:dev
```

Expected: the Tauri window launches with the current frontend and Rust backend.

Manual proof checklist:

1. GN appears in the stored root order in sidebar and All.
2. GN root can reorder only at top level; sidebar and All update together.
3. GN root/date default expanded, collapse persists after restart, and GN zoom ignores root collapse.
4. notification title/note temporary edits restore on blur/Escape/refresh.
5. title Enter creates sibling; Tab makes it a notification child.
6. Arrow navigation, Shift+Tab, structural paste, and user-node drop match normal Notes behavior.
7. Complete menu/Cmd+Enter marks read once; no row checkbox exists.
8. `showCompleted` filters read notification subtree; web `viewedAt` does not.
9. ExternalLink is visible only hover/focus, keyboard reachable, opens the target web page, and sits with the lock in a 6px inline cluster immediately after the displayed title rather than at the pane edge.
10. ordinary readonly root/node/GN user child shows the shared lock, restores edits, blocks direct delete/move/attachment, and still permits complete/star/archive/collapse/child.
11. deleting an ancestor with readonly descendant defaults to Cancel; explicit Delete removes atomically.
12. sync/restart restores normal collapse, readonly, GN collapse, materialized trees, and provider snapshots.

- [ ] **Step 9: Request final code review**

Use `superpowers:requesting-code-review` against the complete branch. Fix only evidence-backed findings, then rerun every affected focused test and the full gates.

- [ ] **Step 10: Commit verification fixes separately**

If review fixes altered files, inspect `git status --short`, stage only those exact reviewed paths one by one, and commit them as `test(notes): verify plugin root and readonly flows`. Do not create an empty commit when no fixes were needed.

---

## Spec Coverage Audit

| Approved requirement | Planned task |
| --- | --- |
| fixed stored GN root, independent Markdown, shared root order | 1, 5, 6 |
| projection-only until structure is needed | 5, 6 |
| Enter sibling then normal Tab indent | 5, 7 |
| materialized snapshot + user subtree sync | 4, 5, 10 |
| provider-authoritative temporary title/note | 7 |
| Type icon, native note row, ExternalLink | 7 |
| no row completion checkbox, one-way mark-read | 7, 9 |
| `showCompleted` based on GitHub unread | 6, 9 |
| root/date collapse default and cross-device persistence | 4, 5, 9, 10 |
| date regroup on notification refresh | 5, 9 |
| ordinary collapse in Markdown | 4 |
| ordinary readonly content/delete/move protection | 3, 8 |
| ordinary readonly non-inheritance and allowed child/actions | 3, 8 |
| common lock, no GN readonly value/menu | 2, 7, 8 |
| ancestor delete warning with stale confirmation safety | 3, 8 |
| readonly-aware duplicate/trash/restore/sync | 3, 4, 10 |
| hybrid selection/sort/focus separation | 6, 7, 8 |
| plugin-owned search/Recent/etc. exclusion, user child inclusion | 2 |
| existing source polling/cache/open behavior reused | 9 |
| v3 no-migration atomic cutover | 1, 2, 4, 10 |
| fresh Tauri development proof | 10 |

## Execution Notes

- Recommended execution is `superpowers:subagent-driven-development`: one implementation subagent per task, followed by a separate review subagent before the next task.
- Backend Tasks 1-5 are sequential because they share schema/format/storage contracts.
- After Task 5, Task 6 pure projection tests and Task 8 UI test preparation can be delegated in parallel only if they do not edit the same files.
- Tasks 7-9 touch `NotesOutlinePane.tsx` and must be serialized or assigned with explicit non-overlapping file ownership.
- Run `npm run test:architecture` after every frontend task because two architecture budgets are at their limits.
- Use `superpowers:verification-before-completion` before any completion claim and `superpowers:finishing-a-development-branch` only after the user chooses integration.
