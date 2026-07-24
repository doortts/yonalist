# Notes GitHub Notifications Native Readonly Bullets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Github Notifications`를 projection 전용 UI가 아닌 일반 Notes 트리의 readonly `NoteNode`로 저장·표시하고, GitHub 읽음을 기존 완료 상태와 durable Outbox에 연결하면서 일반 블릿 편집 성능을 유지한다.

**Architecture:** 완전한 GitHub snapshot만 기존 직렬 sync pump를 통해 Notes의 단일 transaction에 전달한다. Rust 저장소가 결정적 ID로 root/date/notification readonly 노드를 upsert하고 사용자 subtree를 보존하며, React는 모든 노드를 기존 `OutlineNodeRow` 하나로 렌더링한다. 읽음 요청은 화면을 낙관적으로 완료한 뒤 현재 `.yonalist/outbox/`에 intent를 durable하게 기록하고, Notes 완료 commit이 끝난 다음 기존 sync loop에서 전송한다. 새 provider framework, 별도 queue, schema/file version, migration, polling loop는 만들지 않는다.

**Tech Stack:** React 19, TypeScript 6, Vitest 4, Testing Library, Lucide React, Tauri 2, Rust, rusqlite, Markdown topic sync

## Global Constraints

- 기준 설계는 `docs/superpowers/specs/2026-07-24-notes-github-notifications-native-readonly-bullets-design.md`다.
- GN root/date/notification은 일반 `NoteNode`이며 모두 `isReadonly: true`다. 사용자 descendant는 일반 editable `NoteNode`다.
- GitHub 소유 node만 source refresh가 갱신한다. 일반 사용자 node의 content, 상대 순서, completion, attachments와 Undo history는 건드리지 않는다.
- 완전한 authoritative snapshot만 부재 판단에 사용한다. partial/loading/error/offline 상태로 node를 삭제하거나 `sourcePresent: false`로 바꾸지 않는다.
- `TOPIC_FORMAT_VERSION`과 `CURRENT_NOTES_SCHEMA_VERSION`을 올리지 않는다. migration, compatibility reader, dual-read/write를 추가하지 않는다.
- 기존 개발 데이터는 지원 대상이 아니다. 테스트는 새 임시 vault를 사용하고, 필요한 로컬 확인은 GN topic/Notes DB만 명시적으로 재생성한다.
- SQLite의 기존 nullable `plugin_state` column은 이번 작업에서 물리적으로 제거하지 않는다. 런타임과 Markdown에서는 더 이상 쓰지 않고 항상 `NULL`로 두어, unrelated SQL projection을 대량 변경하는 schema rewrite를 피한다.
- 기존 `githubMaterializedBridge`의 “한 번에 하나, 최신 snapshot만 유지, 동일 token no-op” 동작은 source sync pump로 이름과 책임만 정리해 재사용한다.
- 기존 Outbox queue와 reconnect lifecycle만 사용한다. mark-read만 확인 없이 자동 재시도하고, create issue/comment의 reconnect 확인 UX는 유지한다.
- 404/410 mark-read는 성공, 401/403은 blocked, network/DNS/timeout/429/5xx는 retryable이다.
- 일반 row의 선행 아이콘은 표시 전용이며 `NoteNode`나 Markdown에 icon 이름을 별도 저장하지 않는다.
- 새 npm/cargo dependency를 추가하지 않는다.
- 각 task는 RED test → 최소 구현 → GREEN → commit 순서로 수행한다.

## Contract

| Field | Required content |
| --- | --- |
| Goal | GN root/date/notification과 사용자 descendants가 하나의 native Notes tree에서 동작한다. |
| Acceptance | Native indentation/focus/zoom/collapse; source-owned readonly protection; preserved user subtree; optimistic durable mark-read retry/cancel; Type leading icons; identical snapshot zero writes/renders; unrelated typing zero GN row churn. |
| Non-goals | Editable GitHub content, unread remote API, custom icons, provider SDK, second queue/poller, legacy-data migration or compatibility. |
| Boundaries | React outline and shared actions, external source host, Outbox Markdown, Tauri IPC, Rust repository/SQLite, Notes Markdown sync, macOS desktop runtime. |
| Data/Undo | Provider refresh is one non-history transaction; user child edits keep normal history; pending Outbox intent is durable before Notes completion commit. |
| Manual proof | Fresh isolated vault에서 online/offline/blocked completion, reconnect retry, source removal preservation, zoom/focus and sustained unrelated typing을 확인한다. |

---

## File Map

| Area | Files | Responsibility |
| --- | --- | --- |
| Domain contract | `src/domain/externalSources.ts`, `src/domain/notes.ts`, `src-tauri/src/notes/github_notifications.rs`, `src-tauri/src/notes/types.rs` | Native GN metadata, snapshot input and read-state input |
| Native repository | `src-tauri/src/notes/repository.rs`, `commands.rs`, `src-tauri/src/lib.rs`, `src/services/notesStore.ts` | Authoritative batch upsert/removal, readonly ownership and read acknowledgement |
| Topic sync | `src-tauri/src/notes/sync/{topic_file,topic_parser,exporter,merger,bootstrap}.rs`, GN golden fixture | Current-format readonly metadata round-trip without versioning |
| Source bridge | `src/services/githubNotificationsProvider.ts`, `githubMaterializedBridge.ts`, `src/ExternalSourcesContext.ts`, `src/App.tsx` | Complete snapshot delivery and native notification actions |
| Outbox | `src/domain/{types,outbox}.ts`, `src/services/{vaultStore,sync,notifications}.ts`, `src/hooks/useOutboxSync.ts`, `src/components/OutboxModal.tsx` | Durable mark-read intent, retry/block/cancel |
| Outline | `src/features/notes/NotesOutlinePane.tsx`, `OutlineNodeRow.tsx`, `notes.css` | One native tree, leading icon, external-link/status actions |
| Delete | `NotesExternalBulletRow.*`, `NotesExternalOutlinePane.*`, `githubNotificationsOutline.*` | Remove parallel projection row/tree/focus/DnD implementation |
| Verification | Existing adjacent `*.test.*`, `outlineRowMemo.test.tsx`, new focused native-sync performance cases | Functional, no-op and editor-drain proof |

---

### Task 1: Replace the Hybrid Domain Contract In Place

Tasks 1–3 are one persistence compile unit: write all RED tests first, then carry the Rust/domain changes through repository and topic sync before creating a commit. Do not add temporary legacy variants, dual readers or compatibility branches merely to make an intermediate commit compile.

**Files:**
- Modify: `src/domain/externalSources.ts`
- Modify: `src/domain/externalSources.test.ts`
- Modify: `src/domain/notes.ts`
- Modify: `src/domain/notes.test.ts`
- Modify: `src-tauri/src/notes/github_notifications.rs`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/github_notifications.rs` inline `tests` module
- Modify: `src-tauri/src/notes/types.rs` inline `tests` module

**Interfaces:**

```ts
type GithubNotificationsPluginMeta =
  | {
      kind: "github-notifications-root";
      connectionId: string;
    }
  | {
      kind: "github-notifications-date";
      dateKey: string;
      sourcePresent: boolean;
    }
  | {
      kind: "github-notification";
      notificationKey: string;
      notificationType:
        | "issue"
        | "pull-request"
        | "discussion"
        | "release"
        | "notification";
      url: string;
      updatedAt: string;
      unread: boolean;
      sourcePresent: boolean;
    };

interface GithubNotificationSnapshotInput {
  dateKey: string;
  notificationKey: string;
  title: string;
  note: string;
  notificationType: GithubNotificationType;
  url: string;
  updatedAt: string;
  unread: boolean;
}

type GithubNotificationReadState = "pending" | "acknowledged" | "cancelled";
```

- [ ] **Step 1: Write RED TypeScript validator tests**

Add exact-key tests proving:

- root/date/notification metadata round-trip;
- `sourcePresent` is required for date/notification;
- raw GitHub `"PullRequest"` normalizes to `"pull-request"`;
- malformed connection IDs, dates, timestamps, URLs and unknown keys fail;
- `pluginMeta` and `isReadonly: true` may coexist;
- the new metadata carries no collapsed-group state.

Run:

```bash
npx vitest run src/domain/externalSources.test.ts src/domain/notes.test.ts
```

Expected: FAIL on the old `date | notification` union and the old readonly/plugin exclusivity rule.

- [ ] **Step 2: Implement the minimal TypeScript contract**

- Replace the old metadata union with the three native kinds.
- Keep `ExternalBullet`/projection declarations until their production call sites are deleted in Task 5; do not add any new use.
- Remove `pluginState` from the public `NoteNode` shape and validator; do not add a replacement state bag.
- Keep external key serialize/parse helpers because native metadata and Outbox still need the canonical identity.
- Normalize notification Type once in `githubNotificationSnapshot`; repository inputs never receive raw GitHub spelling.

- [ ] **Step 3: Write RED Rust serialization and validation tests**

Cover exact JSON for all three metadata variants, deterministic date/notification UUIDs, `is_readonly = true`, `source_present`, safe URLs and normalized Type.

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml github_notifications
```

Expected: FAIL because Rust still exposes date/notification-only metadata and collapsed group state.

- [ ] **Step 4: Implement the mirrored Rust contract**

- Replace `GithubNotificationsPluginMeta::{Date, Notification}` with root/date/notification variants matching camelCase JSON.
- Remove the runtime `GithubNotificationsPluginState` behavior.
- Retain UUID v4 bit normalization; it is ID canonicalization, not persisted-format versioning.
- Do not change `TOPIC_FORMAT_VERSION` or `CURRENT_NOTES_SCHEMA_VERSION`.

- [ ] **Step 5: Verify the TypeScript boundary and continue without an intermediate commit**

```bash
npx vitest run src/domain/externalSources.test.ts src/domain/notes.test.ts
git diff --check
```

Expected: targeted TypeScript tests PASS. Rust crate-wide GREEN and the first persistence commit are intentionally deferred until Task 3, after every exhaustive enum/parser match is updated. Versions are unchanged.

---

### Task 2: Make Authoritative Refresh the Only GN Tree Mutation

**Files:**
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/services/notesStore.ts`
- Modify: `src/services/notesStore.tauri.test.ts`
- Modify: `src/domain/notes.ts`
- Modify: `src/features/notes/notesCommands.ts`
- Modify: `src/features/notes/useNotesCommandActions.ts`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts`
- Modify: `src/features/notes/notesWorkspaceTypes.ts`
- Delete: `src-tauri/permissions/autogenerated/notes_mark_materialized_github_notification_read.toml`
- Delete: `src-tauri/permissions/autogenerated/notes_materialize_github_notification_and_create_sibling.toml`
- Delete: `src-tauri/permissions/autogenerated/notes_materialize_github_notification_and_reparent.toml`
- Delete: `src-tauri/permissions/autogenerated/notes_refresh_materialized_github_notifications.toml`
- Delete: `src-tauri/permissions/autogenerated/notes_set_github_group_collapsed.toml`
- Add: `src-tauri/permissions/autogenerated/notes_refresh_github_notifications.toml`
- Add: `src-tauri/permissions/autogenerated/notes_set_github_notification_read_state.toml`
- Modify: `src-tauri/permissions/main-window.toml`

**Store interface after this task:**

```ts
refreshGithubNotifications(
  vaultPath: string,
  input: {
    rootId: NoteId;
    connectionId: string;
    notifications: GithubNotificationSnapshotInput[];
  }
): Promise<NotesMutationResult>;

setGithubNotificationReadState(
  vaultPath: string,
  input: {
    nodeId: NoteId;
    state: "pending" | "acknowledged" | "cancelled";
  }
): Promise<NotesMutationResult>;
```

- [ ] **Step 1: Add RED repository tests for native creation**

In `repository.rs`, add focused tests that start with only the seeded root and assert one authoritative batch:

- creates date and notification rows even when no user child exists;
- gives root/date/notification `is_readonly = 1`;
- uses the canonical root → date → notification parent chain;
- stores normalized metadata and ordinary `is_collapsed`;
- returns one workspace mutation;
- repeats the identical batch with no row HLC, dirty topic or workspace revision change.

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml refresh_github_notifications
```

Expected: FAIL because current refresh only updates already-materialized rows.

- [ ] **Step 2: Extend the existing refresh transaction**

Rename `refresh_materialized_github_notifications` to `refresh_github_notifications` and reuse:

- `github_date_node_id`;
- `github_notification_node_id`;
- `insert_github_date_anchor_if_missing`;
- `insert_github_notification_if_missing`;
- current chunk-bounded lookups;
- current timestamp/unread stale guards;
- current single workspace transaction and dirty-topic batching.

The command must canonicalize/dedupe/sort before mutation and return the existing skipped/no-op outcome when the computed tree is unchanged.

- [ ] **Step 3: Add RED preservation/removal tests**

Cover:

1. a newer snapshot moves the notification and all descendants to a new date;
2. a user sibling at the old date stays there;
3. an absent notification without user descendants is deleted;
4. an absent notification with any non-plugin descendant remains with `sourcePresent: false`;
5. a later matching notification restores the same ID with `sourcePresent: true`;
6. an empty source date is deleted only if it has neither source rows nor user rows;
7. provider ordering never rewrites a user row's `sort_key`;
8. refresh creates no Undo/Redo history entry.

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml github_notification
```

Expected: the new absence and native-tree cases FAIL.

- [ ] **Step 4: Implement source-owned reconciliation**

- Compare only rows carrying GN `plugin_meta`.
- Move a notification subtree by updating only its root parent/sort key.
- Detect user descendants with a recursive query bounded to the GN subtree.
- Preserve the last source title/note/URL/Type/date when marking absent.
- Allocate provider sort keys around, not through, user rows; never normalize the whole sibling list during refresh.
- Remove `ensure_generic_parent_allowed`'s GN-root exception so ordinary child creation uses existing readonly behavior.
- Keep generic delete/move/readonly-toggle guards for provider-owned rows.

- [ ] **Step 5: Add RED read-state tests**

Assert:

- `pending` sets `completed_at` without changing `pluginMeta.unread`;
- `acknowledged` keeps completion and sets `unread: false`;
- `cancelled` clears completion only when the latest metadata is still unread;
- duplicate state applications are no-ops;
- root/date/non-GN IDs are rejected.

- [ ] **Step 6: Implement one read-state command and remove hybrid commands**

Add one `set_github_notification_read_state` transaction. Delete:

- materialize-and-create-sibling;
- materialize-and-reparent/import;
- set-GitHub-group-collapsed;
- old mark-materialized-read;
- their frontend store methods, workspace actions, IPC registrations and permission entries.

Use ordinary `createChild`, `createNextTextSibling`, `importSubtree`, `toggleCollapsed` and drag/move for all user rows.

- [ ] **Step 7: Inspect the repository boundary and continue the compile unit**

```bash
rg -n "materialize_github|set_github_group_collapsed|refresh_materialized_github" src-tauri/src src
git diff --check
```

Expected: removed hybrid command names have no production matches. Repository/store GREEN is deferred to Task 3 because Rust exhaustive topic-sync matches are still being replaced. Do not commit a crate that still contains hybrid topic matches.

---

### Task 3: Round-Trip Native Readonly GN Nodes in the Current Topic Format

**Files:**
- Modify: `src-tauri/src/notes/sync/topic_file.rs`
- Modify: `src-tauri/src/notes/sync/topic_parser.rs`
- Modify: `src-tauri/src/notes/sync/exporter.rs`
- Modify: `src-tauri/src/notes/sync/merger.rs`
- Modify: `src-tauri/src/notes/sync/bootstrap.rs`
- Modify: `src-tauri/src/notes/sync/integration_tests.rs`
- Modify: `src-tauri/src/notes/sync/fixtures/github_notifications_golden.md`
- Modify only where public `pluginState` removal requires it: `src-tauri/src/notes/{attachments,history}.rs`

**Current-format fixture shape:**

```yaml
---
kind: yonalist-notes
format_version: 4
id: 6983f947-c134-44fc-bf46-db19f68125bf
sort_key: 2048
max_hlc: 0swkd7qz6-00-a3f2
root_hlc: 0swkd7qz2-00-a3f2
root_marker_kind: bullet
root_collapsed: false
root_readonly: true
root_starred: false
root_completed_at: null
root_archived_at: null
root_markdown_image_width: null
plugin: github-notifications
plugin_connection_id: "[\"https://api.github.com\",\"account-7\"]"
---
# Github Notifications
```

Each date/notification row carries its ordinary `readonly`, `collapsed`, `completed`, HLC and `plugin_meta`; there is no `plugin_children` or `collapsed_groups`.

- [ ] **Step 1: Replace the golden fixture and write RED parser tests**

The new fixture must include:

- readonly root/date/notification;
- one collapsed date;
- one completed notification;
- root/date/notification metadata;
- one editable user child below a notification;
- `sourcePresent: false` on one retained notification.

Assert that legacy `plugin_children` and `collapsed_groups` are unknown/invalid in the current development format rather than migrated.

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml topic_parser
```

Expected: FAIL while the parser still requires `plugin_children: hybrid` and `collapsed_groups`.

- [ ] **Step 2: Simplify parser and renderer**

- Remove `plugin_children` and `collapsed_groups` from root frontmatter structures, accepted keys and renderer output.
- Add only `plugin_connection_id` beside the existing root `plugin` marker so the root metadata round-trips without a generic state bag.
- Require normal readonly semantics for GN source rows.
- Validate root/date/notification canonical chains and metadata without forbidding ordinary collapse/completion.
- Keep the `plugin: github-notifications` root marker.
- Do not add a `native` replacement field because no alternate child mode remains.

- [ ] **Step 3: Write RED exporter/merger/bootstrap tests**

Assert:

- DB → Markdown → parser preserves readonly/collapse/completion/plugin metadata and user child;
- remote Markdown merge preserves local user descendants;
- source rows may legally have `is_readonly = 1`;
- root seed is readonly, has `plugin_state IS NULL`, and is idempotent;
- identical export writes no new file content/HLC;
- old hybrid fixture is not migrated.

- [ ] **Step 4: Implement in-place sync behavior**

- Remove root collapsed-state packing/unpacking.
- Export each source node like a normal readonly row plus its metadata.
- Merge source metadata by its existing HLC/source freshness rules while user rows keep normal row HLC authority.
- Seed the canonical root with `is_readonly = 1` and `plugin_state = NULL`.
- Leave the physical nullable `plugin_state` column untouched and unused.
- Do not change either schema/file version constant.

- [ ] **Step 5: Verify and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml github_notification
cargo test --manifest-path src-tauri/Cargo.toml notes::sync
npx vitest run src/services/notesStore.tauri.test.ts src/services/notesStore.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx
npm run test:architecture
rg -n "TOPIC_FORMAT_VERSION|CURRENT_NOTES_SCHEMA_VERSION" src-tauri/src/notes
git diff --check
git add src/domain/externalSources.ts src/domain/externalSources.test.ts src/domain/notes.ts src/domain/notes.test.ts src-tauri/src/notes/github_notifications.rs src-tauri/src/notes/types.rs src-tauri/src/notes/repository.rs src-tauri/src/notes/commands.rs src-tauri/src/lib.rs src-tauri/permissions/autogenerated/notes_mark_materialized_github_notification_read.toml src-tauri/permissions/autogenerated/notes_materialize_github_notification_and_create_sibling.toml src-tauri/permissions/autogenerated/notes_materialize_github_notification_and_reparent.toml src-tauri/permissions/autogenerated/notes_refresh_materialized_github_notifications.toml src-tauri/permissions/autogenerated/notes_set_github_group_collapsed.toml src-tauri/permissions/autogenerated/notes_refresh_github_notifications.toml src-tauri/permissions/autogenerated/notes_set_github_notification_read_state.toml src-tauri/permissions/main-window.toml src/services/notesStore.ts src/services/notesStore.tauri.test.ts src/features/notes/notesCommands.ts src/features/notes/useNotesCommandActions.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/notesWorkspaceTypes.ts src-tauri/src/notes/sync/topic_file.rs src-tauri/src/notes/sync/topic_parser.rs src-tauri/src/notes/sync/exporter.rs src-tauri/src/notes/sync/merger.rs src-tauri/src/notes/sync/bootstrap.rs src-tauri/src/notes/sync/integration_tests.rs src-tauri/src/notes/sync/fixtures/github_notifications_golden.md src-tauri/src/notes/attachments.rs src-tauri/src/notes/history.rs
git commit -m "feat(notes): persist native github bullets"
```

Expected: sync tests PASS; constants remain `4` and `5`; no migration code exists.

---

### Task 4: Add Durable `mark_notification_read` to the Existing Outbox

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/outbox.ts`
- Modify: `src/domain/outbox.test.ts`
- Modify: `src/services/vaultStore.ts`
- Modify: `src/services/vaultStore.test.ts`
- Modify: `src/services/sync.ts`
- Modify: `src/services/sync.test.ts`
- Modify: `src/services/notifications.ts`
- Modify: `src/services/notifications.test.ts`
- Modify: `src/hooks/useOutboxSync.ts`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/components/OutboxModal.tsx`
- Modify: `src/components/OutboxModal.test.tsx`

**Discriminated contract:**

```ts
type OutboxOperationFrontMatter =
  | CreateIssueOutboxFrontMatter
  | CreateCommentOutboxFrontMatter
  | {
      kind: "outbox_operation";
      operation: "mark_notification_read";
      id: string;
      host: string;
      connection_id: string;
      account_id: string;
      thread_id: string;
      notification_key: string;
      note_node_id: NoteId;
      created_at: string;
      status: OutboxStatus;
      last_error?: string;
      failure_notified?: boolean;
    };
```

- [ ] **Step 1: Write RED construction and persistence tests**

Assert:

- mark-read has no `local_file_path`, `target` or meaningful body;
- serialize/parse round-trips exact fields;
- operation ID/dedupe identity is connection + thread;
- a second unresolved request returns/reuses the existing document;
- token is never persisted.

Run:

```bash
npx vitest run src/domain/outbox.test.ts src/services/vaultStore.test.ts
```

Expected: FAIL on the single-shape outbox contract.

- [ ] **Step 2: Implement the discriminated union**

- Split create issue/comment frontmatter without changing their serialized keys.
- Add `createMarkNotificationReadOutboxOperation`.
- Narrow every `local_file_path`, `target`, body, edit and conflict use by `operation`.
- Display mark-read rows as “Mark GitHub notification read”; provide open target, retry and cancel, but no edit action.

- [ ] **Step 3: Write RED sync classification tests**

Test exact outcomes:

| Result | Expected |
| --- | --- |
| 204/205 | success |
| 404/410 | idempotent success |
| 401/403 | blocked |
| 429/5xx | retryable |
| network/DNS/timeout | retryable |
| `Retry-After` | preferred delay |
| same failed op retried | no duplicate failure notification |

Use zero retry delays/fake timers; do not make wall-clock tests sleep.

- [ ] **Step 4: Extend the existing sync loop**

- Let `syncOutboxOperations` accept a bound mark-read sender using existing `markNotificationRead`; do not add a second GitHub client or queue.
- Add optional `retryAfterMs` to `GitHubRequestError`, parse both delta-seconds and HTTP-date `Retry-After` values in `markNotificationRead`, and let the retry helper prefer that delay.
- Use bounded exponential backoff with jitter when the header is absent.
- Treat 401 as permanent globally; special-case 404/410 as success only for mark-read.
- Return a `notification-read` remote result so the hook can acknowledge the Note node before removing the outbox file.

- [ ] **Step 5: Write RED lifecycle tests**

Assert:

- Outbox loads for the active vault even when Notes, not Inbox, is active;
- app startup reconciles every unresolved mark-read to `pending` Notes state;
- online creation starts background sync without opening the Outbox;
- retryable failure stays queued and shows one waiting Snackbar;
- a real offline→online reachability recovery auto-flushes mark-read without confirmation;
- create issue/comment operations still use the existing reconnect confirmation;
- blocked completion remains visually complete;
- cancel invokes `cancelled`, removes only the operation document and clears completion only if source is still unread;
- later recovery shows one recovery Snackbar only when an earlier failure was surfaced.

- [ ] **Step 6: Implement lifecycle callbacks in `useOutboxSync`**

Add narrow callbacks rather than a second state machine:

```ts
onNotificationReadState(
  nodeId: NoteId,
  state: "pending" | "acknowledged" | "cancelled"
): Promise<void>;
onOpenNotification?(notificationKey: string): void;
```

Partition reconnect work:

- auto-flush retryable mark-read operations after endpoint reachability succeeds;
- pass retryable create operations to the existing confirmation prompt;
- keep blocked operations manual.

On success, call `acknowledged`, delete only the outbox Markdown, refresh the existing source, and avoid a normal-success Snackbar.

- [ ] **Step 7: Verify and commit**

```bash
npx vitest run src/domain/outbox.test.ts src/services/vaultStore.test.ts src/services/sync.test.ts src/services/notifications.test.ts src/components/OutboxModal.test.tsx src/App.test.tsx
git diff --check
git add src/domain/types.ts src/domain/outbox.ts src/domain/outbox.test.ts src/services/vaultStore.ts src/services/vaultStore.test.ts src/services/sync.ts src/services/sync.test.ts src/services/notifications.ts src/services/notifications.test.ts src/hooks/useOutboxSync.ts src/components/OutboxModal.tsx src/components/OutboxModal.test.tsx src/App.tsx src/App.test.tsx
git commit -m "feat(outbox): queue github notification reads"
```

Expected: Outbox tests PASS and create issue/comment behavior remains unchanged.

---

### Task 5: Feed Only Complete Snapshots into the Native Notes Tree

**Files:**
- Modify/Move: `src/services/githubMaterializedBridge.ts` → `src/services/githubNotificationsSyncPump.ts`
- Move: `src/services/githubMaterializedBridge.test.ts` → `src/services/githubNotificationsSyncPump.test.ts`
- Modify: `src/services/githubNotificationsProvider.ts`
- Modify: `src/services/githubNotificationsProvider.test.ts`
- Modify: `src/services/externalSourceHost.ts`
- Modify: `src/services/externalSourceHost.test.ts`
- Modify: `src/ExternalSourcesContext.ts`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify/Move: `src/features/notes/githubProjectionLease.ts` → `githubNotificationsLease.ts`
- Move: `src/features/notes/githubProjectionLease.test.ts` → `githubNotificationsLease.test.ts`

**Boundary after simplification:**

```ts
interface ExternalSourcesBoundary {
  githubNotificationsRequested: boolean;
  requestGithubNotifications(requested: boolean): void;
  registerGithubNotificationsSync(
    handler: GithubNotificationsSyncHandler
  ): () => void;
  refreshGithubNotifications(): Promise<void>;
  enqueueGithubNotificationRead(input: {
    key: ExternalBulletKey;
    nodeId: NoteId;
  }): Promise<{ operationId: string }>;
  releaseGithubNotificationRead(operationId: string): void;
  optimisticCompletedNodeIds: ReadonlySet<NoteId>;
  openGithubNotification(key: ExternalBulletKey, fallbackUrl?: string): void;
}
```

- [ ] **Step 1: Write RED pump/source tests**

Assert:

- loading/partial/error states never emit an authoritative refresh;
- a complete snapshot emits once;
- the same complete snapshot identity emits zero more repository calls;
- while one batch is running, only the newest complete snapshot remains queued;
- invalidation on account/host/vault switch prevents stale settlement;
- completing an Outbox operation does not fabricate a partial snapshot token.

- [ ] **Step 2: Simplify the provider and host**

- Keep raw notification decode, dedupe, monotonic reconciliation, cache, polling lease and `githubNotificationSnapshot`.
- Remove `projectGithubNotifications`, `ExternalBullet`/`ExternalSourcePageSnapshot` production, provider projection settings, `provider.project`, host completion state and direct `markComplete`.
- Normalize Type in `githubNotificationSnapshot`.
- Replace the clock-relative stored subtitle with a stable `repository name, MMM D, YYYY` UTC note and delete `useProjectionClock`/`projectionNowMs`; relative age remains presentation-only in the global Notifications pane.
- Rename materialization terms to native sync terms without changing the proven pump algorithm.
- Submit only `loaded && isComplete && !loading && syncedAt !== null` states.

- [ ] **Step 3: Wire App to the existing Notes mutation action**

- Keep registration with the active Notes workspace so source refresh participates in its compact mutation authority.
- Include `connectionId` in the refresh input and map the full raw list once.
- Move Outbox loading to vault scope so Notes can queue/reconcile operations.
- Make `enqueueGithubNotificationRead` set the transient optimistic ID synchronously, then persist/dedupe without sending.
- After the shared Notes action commits `pending`, call `releaseGithubNotificationRead`; offline release is a no-op and reconnect owns the later retry.
- Keep the current source refresh/polling lease; add no polling or timer.
- Preserve account/host isolation and safe external URL opening.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/services/githubNotificationsSyncPump.test.ts src/services/githubNotificationsProvider.test.ts src/services/externalSourceHost.test.ts src/features/notes/githubNotificationsLease.test.ts src/App.test.tsx
git diff --check
git add src/services/githubNotificationsSyncPump.ts src/services/githubNotificationsSyncPump.test.ts src/services/githubNotificationsProvider.ts src/services/githubNotificationsProvider.test.ts src/services/externalSourceHost.ts src/services/externalSourceHost.test.ts src/services/githubMaterializedBridge.ts src/services/githubMaterializedBridge.test.ts src/ExternalSourcesContext.ts src/App.tsx src/App.test.tsx src/features/notes/githubNotificationsLease.ts src/features/notes/githubNotificationsLease.test.ts src/features/notes/githubProjectionLease.ts src/features/notes/githubProjectionLease.test.ts
git commit -m "refactor(notes): bridge complete github snapshots"
```

Expected: only complete snapshots reach Notes and unchanged snapshots make one initial call followed by no calls.

---

### Task 6: Render GN with `OutlineNodeRow` and Add the Common Leading Icon

**Files:**
- Modify: `src/features/notes/NotesFeature.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/notes.css`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src/features/notes/outlineRowMemo.test.tsx`
- Modify: `src/features/notes/outlineKeyboard.test.ts`
- Delete: `src/features/notes/NotesExternalBulletRow.tsx`
- Delete: `src/features/notes/NotesExternalBulletRow.test.tsx`
- Delete: `src/features/notes/NotesExternalOutlinePane.tsx`
- Delete: `src/features/notes/NotesExternalOutlinePane.test.tsx`
- Delete: `src/features/notes/githubNotificationsOutline.ts`
- Delete: `src/features/notes/githubNotificationsOutline.test.ts`

**Presentation contract:**

```ts
type NoteLeadingIcon =
  | "issue"
  | "pull-request"
  | "discussion"
  | "release"
  | "notification";

interface OutlineNodeEditorProps {
  leadingIcon?: NoteLeadingIcon;
  externalUrl?: string;
  syncStatus?: "pending" | "blocked";
  completedOverride?: boolean;
}
```

The props are primitive/stable values so `MemoizedOutlineNodeEditor` keeps its existing bailout.

- [ ] **Step 1: Write RED native-tree integration tests**

In `NotesWorkspace.test.tsx`, build a real native root/date/notification/user-child workspace and assert:

- exactly one regular `[data-outline-id]` per node;
- root/date/notification indentation and guide depth come from `flattenVisibleOutlineRows`;
- title, note and image focus use the owning row for Workflowy zoom-in;
- zoom-out uses the already-shared shortcut;
- collapse uses ordinary `toggleCollapsed`;
- Enter/Shift+Enter/Tab/Shift+Tab under readonly provider rows creates/moves only user nodes;
- provider rows cannot persist content edits, move, delete or unlock;
- user children retain normal edit, attachment, drag, complete and Undo/Redo behavior;
- `showCompleted` hides a completed notification subtree through the normal path.

Run:

```bash
npx vitest run src/features/notes/NotesWorkspace.test.tsx src/features/notes/outlineKeyboard.test.ts
```

Expected: FAIL because the pane still inserts a projection outline.

- [ ] **Step 2: Remove the parallel outline path**

Delete from `NotesOutlinePane`:

- projected row construction and composition;
- special editor focus lookup/fallback;
- synthetic selectable/sortable IDs;
- projection-only drop targets and materialization callbacks;
- date collapsed intent map;
- `NotesExternalOutlinePane` insertions;
- `pluginRoot` special title renderer.

Render GN nodes through `ordinaryBodyRows` and `renderOutlineNodeItem` only. Keep the fixed GN root and metadata-owned date/notification rows movement/content protected, but allow ordinary child creation and zoom/collapse/focus.

- [ ] **Step 3: Write RED leading-icon tests**

Assert:

- Issue → `CircleDot`/“Issue”;
- Pull Request → `GitPullRequest`/“Pull request”;
- Discussion → `MessageCircle`/“Discussion”;
- Release → `Tag`/“Release”;
- unknown → `Bell`/“GitHub notification”;
- root/date have no leading icon;
- icon is after effective bullet/checkbox and before title;
- icon is 16px, non-button, non-tab-stop;
- a normal row without an icon has no empty column/gap;
- completed color is muted without line-through on the SVG.

- [ ] **Step 4: Implement one optional row slot**

- Derive `leadingIcon` from notification metadata in `NotesOutlinePane`; do not persist it.
- Move the existing Lucide mapping from the deleted external row into a small switch inside `OutlineNodeRow`.
- Use a conditional inline/flex slot so iconless rows retain their current title start position.
- Add the existing-sized `ExternalLink` trailing action for notification URLs.
- Add noninteractive pending/blocked status with an accessible name; do not make it a layout column.

- [ ] **Step 5: Intercept every completion entry point at the shared Notes action boundary**

In `NotesWorkspaceProvider`, wrap `toggleComplete`, `applyBatch` and `applyPreparedSelectionBatch` so row shortcuts, menus and multi-selection all use the same provider path. For every unread GN notification:

1. call the external boundary, which synchronously adds the node to `optimisticCompletedNodeIds`;
2. durably enqueue/dedupe the mark-read operation without starting the network request;
3. apply Notes `pending` state through the registered workspace action;
4. release that queued operation to the existing background sync loop;
5. clear the transient override once the workspace reflects completion;
6. roll back the override and show a save error if Outbox persistence fails.

Completed notifications do not offer uncomplete. Root/date continue to use ordinary Notes completion because they have no remote read state.

- [ ] **Step 6: Prove row memo stability**

Extend `outlineRowMemo.test.tsx` with a 1,000-notification native tree and assert:

- typing 200 edits in an unrelated ordinary bullet causes zero GN row rerenders and no editor/shell remounts;
- an unchanged source snapshot causes zero row prop/render deltas;
- one changed notification rerenders only that notification and affected parent shell;
- icon props are stable primitives, not fresh React elements/objects.

Run:

```bash
npx vitest run src/features/notes/outlineRowMemo.test.tsx src/features/notes/NotesWorkspace.test.tsx
```

Expected: all cases PASS with no projection files imported.

- [ ] **Step 7: Verify deletion and commit**

```bash
rg -n "NotesExternalBulletRow|NotesExternalOutlinePane|githubNotificationsOutline|notes-external-group|notes-external-children" src
npx vitest run src/features/notes/NotesWorkspace.test.tsx src/features/notes/outlineRowMemo.test.tsx src/features/notes/outlineKeyboard.test.ts
npm run test:architecture
git diff --check
git add src/features/notes/NotesFeature.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/OutlineNodeRow.tsx src/features/notes/notes.css src/features/notes/NotesWorkspace.test.tsx src/features/notes/outlineRowMemo.test.tsx src/features/notes/outlineKeyboard.test.ts src/features/notes/NotesExternalBulletRow.tsx src/features/notes/NotesExternalBulletRow.test.tsx src/features/notes/NotesExternalOutlinePane.tsx src/features/notes/NotesExternalOutlinePane.test.tsx src/features/notes/githubNotificationsOutline.ts src/features/notes/githubNotificationsOutline.test.ts
git commit -m "refactor(notes): render github nodes in native outline"
```

Expected: `rg` returns no production references; targeted tests and architecture gate PASS.

---

### Task 7: Add Native Snapshot Scale and No-Op Performance Proof

**Files:**
- Modify: `src-tauri/src/notes/repository.rs`
- Add: `src/features/notes/githubNotifications.performance.test.ts`
- Modify: `src/features/notes/outlineRowMemo.test.tsx`
- Verify: `src/features/notes/notesDraftEngine.test.ts`
- Verify: `src/services/notesWriteQueue.test.ts`

- [ ] **Step 1: Add deterministic Rust scale tests**

Create 1,000 canonical notifications under realistic date groups and instrument transaction-visible results:

- first snapshot creates expected nodes in one mutation;
- identical second snapshot returns skipped and changes zero HLC/dirty/revision counters;
- one-notification update changes only that notification plus required topic/workspace metadata;
- one date move preserves its user subtree;
- query batches remain within SQLite parameter limits.

Keep wall-clock assertions out of normal CI.

- [ ] **Step 2: Add an opt-in paired performance case**

`githubNotifications.performance.test.ts` runs only with `NOTES_PERF=1` and compares:

- native 1,000-notification flatten/no-op projection work;
- the same operation on a 1,000-node ordinary Notes tree as calibration.

Use the repository's paired alternating-order method and a recorded median. Gate normalized p95/median regression at 1.10 for this feature-specific comparison; print raw measurements only as diagnostics.

Run serially:

```bash
NOTES_PERF=1 npx vitest run src/features/notes/githubNotifications.performance.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
```

Expected: PASS with normalized regression ≤ 1.10.

- [ ] **Step 3: Re-run sustained editor drain tests**

```bash
npx vitest run src/features/notes/outlineRowMemo.test.tsx src/features/notes/notesDraftEngine.test.ts src/services/notesWriteQueue.test.ts
```

Expected:

- 200 edits produce zero sibling/GN row churn;
- editor/shell mount counts do not increase;
- final draft is `edit-199`;
- `flush()` leaves no pending keys or timers and no duplicate write.

- [ ] **Step 4: Commit**

```bash
git diff --check
git add src-tauri/src/notes/repository.rs src/features/notes/githubNotifications.performance.test.ts src/features/notes/outlineRowMemo.test.tsx
git commit -m "test(notes): guard github sync and editor drain"
```

---

### Task 8: Full Verification, Fresh-Data Smoke Test and Cleanup

**Files:**
- Verify: all changed frontend, Rust, IPC, permission and Markdown files
- Modify: this plan's checkboxes with the commands and observed results

- [ ] **Step 1: Run frontend gates**

```bash
npm test
npm run lint
npm run build
npm run test:architecture
git diff --check
```

Expected: every command exits 0. `npm run test:plans` is diagnostic until the pre-existing unreachable historical commit in `2026-07-10-notes-discovery-and-resilience.md` is repaired; do not weaken that checker in this feature.

- [ ] **Step 2: Run native gates**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: formatting and all Rust tests PASS.

- [ ] **Step 3: Check that no hybrid/versioning residue remains**

```bash
rg -n "plugin_children|collapsed_groups|materializeGithubNotification|refreshMaterializedGithub|NotesExternalOutlinePane|githubNotificationsOutline" src src-tauri/src
rg -n "TOPIC_FORMAT_VERSION|CURRENT_NOTES_SCHEMA_VERSION" src-tauri/src/notes
git status --short
```

Expected:

- no production hybrid/projection symbols;
- versions remain `4` and `5`;
- no migration/compatibility code or new dependency manifests;
- only intended files are changed.

- [ ] **Step 4: Build and smoke-test a fresh desktop app**

Use a fresh isolated vault or explicitly recreate only the development Notes DB/GN topic. Do not delete a broad user directory.

```bash
npm run tauri:build -- --debug --bundles app
```

Manual acceptance:

1. GN root/date/notifications appear as ordinary indented rows.
2. root/date/notification titles are readonly; user children edit normally.
3. zoom-in works from title, note and image focus; zoom-out matches Workflowy.
4. collapse, show completed, selection focus recovery and split pane remain correct.
5. Type icons appear between marker and title; iconless rows do not shift.
6. completing online is immediate and silently clears the Outbox operation.
7. completing offline stays complete, shows one waiting notice, and auto-retries after actual endpoint recovery.
8. blocked auth failure remains complete and offers retry/cancel.
9. authoritative removal preserves user subtrees and removes empty source-only rows.
10. five minutes of unrelated bullet editing/polling produces no visible lag, repeated writes or row churn.

- [ ] **Step 5: Final review and commit**

Run:

```bash
git diff --stat
git diff --check
git status --short
git log --oneline --decorate -12
```

Review against every design invariant. No verification-only commit is expected; if review finds a defect, return to its owning task, add a failing regression, make the smallest fix and commit that task's exact files.

Expected: clean worktree, all gates green, no schema/file version bump, and no second GN tree or queue implementation.
