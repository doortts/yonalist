# Notes Compact Mutation Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Active/All의 text split, first-child 생성, attachment-free text 저장이 전체 Notes workspace를 다시 읽고 직렬화하지 않게 만들면서, 권위 토큰·history receipt·단일 복구로 기존 저장/Undo 안전성을 유지하고 세 Enter 시나리오의 keydown-to-focus를 50ms p95 이내로 줄인다.

**Architecture:** SQLite connection이 connection-incarnated opaque workspace token을 소유하고, compact command는 기존 transaction/history를 정확히 한 번 실행한 뒤 같은 connection lock 안에서 base token, 새 token, 변경 노드, anchored order splice, history receipt를 동결한다. Frontend coordinator만 token을 비교하고 Map 기반 Active authority에 검증된 delta를 원자 적용한다. operation identity를 증명하지 못하면 outcomeUnknown, identity는 맞지만 base/delta가 맞지 않으면 knownCommittedMismatch로 분류하며, 둘 다 compact envelope 전체를 버리고 한 번의 versioned Active reload로 수렴한다.

**Tech Stack:** Rust, SQLite/rusqlite hooks, Tauri commands, serde, React 19, TypeScript 6, Vitest, Testing Library.

## Global Constraints

- 승인된 계약은 `docs/superpowers/specs/2026-07-23-notes-compact-mutation-authority-design.md`이다. 본 계획은 그 계약을 축소하거나 Phase C를 선행하지 않는다.
- 이 계획은 `2026-07-23-notes-enter-critical-path.md`의 Phase A가 전체 gate와 desktop proof를 통과한 커밋 위에서 시작한다. 실행자는 그 Phase A 최종 SHA를 기록하고 `superpowers:using-git-worktrees`로 별도 `codex/notes-compact-mutation-authority` worktree를 만든다.
- 현재 main worktree의 사용자 소유 변경인 `outlineLayoutMotion.ts`, `outlineLayoutMotion.test.ts`, `useOutlineLayoutMotion.test.tsx`, `docs/superpowers/plans/2026-07-23-contextual-enter-child.md`를 수정·스테이징·덮어쓰지 않는다.
- Frontend compact wrapper 대상은 Active scope의 `all`/active outline에서
  실행하는 text split, first-child text 생성, text update다. Compact Delta
  eligibility는 attachment-free text row/parent에 한정하고,
  attachment-bearing active operation은 같은 wrapper call 안에서 backend
  Full materialization을 사용한다. Starred, Recent, Tags, Archive, Trash,
  Undo, Redo는 기존 legacy full method를 유지한다.
- Compact ineligibility는 backend connection lock 안에서 판단한다. 같은 IPC 호출이 기존 full-result mutation을 정확히 한 번 실행하며, client가 legacy mutation을 재전송하지 않는다.
- Token은 문자열 equality 외에 parse, 정렬, 증가, 생성하지 않는다. Caller token을 compact request의 CAS 값으로 보내지 않는다.
- `kind: "rejected", commitDisposition: "notCommitted"`만 미커밋을 증명한다. Invoke rejection, decode failure, history identity failure, commit 경계 이후 오류는 `outcomeUnknown`이며 mutation을 자동 재호출하지 않는다.
- Compact envelope의 일부만 수용하지 않는다. History identity가 먼저 통과해야 workspace token/delta를 검사하며, 복구 시 envelope의 delta/token/history/receipt를 전부 버리고 reload bundle만 수용한다.
- Coordinator가 token 비교, delta 적용, Active authority 교체, recovery 시작의 유일한 소유자다. Hook, row, command helper는 자체 authority를 병합하지 않는다.
- Authority는 승인 설계대로 `ReadonlyMap`을 사용한다. 기존 UI 호환용 null-prototype Record index는 별도 presentation projection이며 권위 원본이 아니다. Compact settle에서 `Object.values`, full workspace reconstruction, `normalizeNotesWorkspace`를 호출하지 않는다.
- `notesWorkspaceRuntime.ts`와 `useNotesHistoryController.ts`는 이미 1,500줄 상한이다. 새 로직은 전용 모듈로 추출하고 `scripts/checkNotesWorkspaceBudgets.mjs` inventory에 production helper를 추가한다.
- 각 Task는 실패 테스트를 먼저 실행하고, 해당 Task 파일만 커밋한다. Payload/latency의 절대 시간은 desktop 또는 Rust benchmark gate에서만 판단하고 jsdom 시간은 CI assertion으로 사용하지 않는다.

---

## Execution Preflight

- [ ] Phase A 최종 커밋과 증거를 확인한다.

  Run:

  ```bash
  git log -1 --oneline
  test -f docs/superpowers/reports/2026-07-23-notes-enter-critical-path-phase-a.md
  npm test -- src/features/notes/notesEnterCriticalPath.test.tsx
  ```

  Expected: Phase A report가 존재하고 Enter critical-path 통합 테스트가 PASS.

- [ ] Phase A 최종 SHA에서 격리 worktree와 `codex/notes-compact-mutation-authority` 브랜치를 만든다.

- [ ] 격리 worktree 기준 상태를 확인한다.

  Run:

  ```bash
  git status --short
  npm run test:architecture
  cargo test --manifest-path src-tauri/Cargo.toml
  ```

  Expected: worktree clean, architecture gate와 기존 Rust suite PASS.

---

### Task 1: Compact/versioned wire contract와 strict decoder 추가

**Files:**

- Modify: `src/domain/notes.ts`
- Modify: `src/services/notesStore.ts`
- Modify: `src/services/notesStore.tauri.test.ts`
- Modify: `src-tauri/src/notes/types.rs`

**Interfaces:**

- Consumes: existing Notes domain validators, `NotesHistoryContext`, Tauri
  invoke/error branding, and Rust serde conventions.
- Produces: `NotesAuthorityDelta`, `NotesAuthoritativeResult`,
  `NotesCompactCommandResult`, versioned/recovery request/results, optional
  compact `NotesStore` methods, and matching Rust wire types.

- [ ] **Step 1: TypeScript decoder 실패 테스트 작성**

  `notesStore.tauri.test.ts`에 다음 payload를 표 기반으로 추가한다.

  - valid `full`, `delta`, `rejected`
  - valid versioned load와 recovery load
  - delta 안에 금지된 `workspace` 또는 `history`가 있는 payload
  - 누락/추가 key, 배열이 아닌 delta field, non-safe-integer splice 숫자
  - non-string token, malformed history receipt/recovery receipt/structured error
  - invoke rejection과 resolved-but-invalid payload가 서로 다른 cause를 유지함

  Duplicate ID, 음수 index, anchor/parent 불일치처럼 wire shape는 맞지만
  의미가 틀린 delta는 여기서 decode에 성공해야 한다. 그래야 Task 5의
  operation-identity gate 다음 workspace gate가
  `knownCommittedMismatch`로 분류할 수 있다.

- [ ] **Step 2: Rust serde 실패 테스트 작성**

  `types.rs`의 기존 `#[cfg(test)] mod tests`에서 camelCase
  discriminant와 exact field shape를 snapshot이 아닌
  `serde_json::Value` equality로 고정한다. 특히 `kind: "delta"`에
  `workspace`가 없고 history는 top-level에 한 번만 존재해야 한다.

- [ ] **Step 3: RED 확인**

  Run:

  ```bash
  npm test -- src/services/notesStore.tauri.test.ts
  cargo test --manifest-path src-tauri/Cargo.toml notes::types::tests::compact
  ```

  Expected: compact 타입과 decoder가 없어 FAIL.

- [ ] **Step 4: 공유 TypeScript wire 타입 추가**

  `src/domain/notes.ts`에 다음 계약을 추가한다.

  ```ts
  export interface NotesAuthorityOrderSplice {
    parentId: NoteId | null;
    index: number;
    deleteCount: number;
    expectedRemovedIds: NoteId[];
    insertedIds: NoteId[];
    beforeId: NoteId | null;
    afterId: NoteId | null;
  }

  export interface NotesAuthorityDelta {
    upsertedNodes: NoteNode[];
    removedNodeIds: NoteId[];
    orderSplices: NotesAuthorityOrderSplice[];
  }

  export type NotesMutationHistoryReceipt =
    | { kind: "none" }
    | { kind: "recorded"; entryId: string }
    | { kind: "coalescedAway"; requestedEntryId: string };

  export type NotesAuthoritativeResult =
    | {
        kind: "full";
        workspace: NotesWorkspace;
        workspaceToken: string;
        history: NotesHistoryState;
        historyReceipt: NotesMutationHistoryReceipt;
      }
    | {
        kind: "delta";
        baseToken: string;
        workspaceToken: string;
        delta: NotesAuthorityDelta;
        history: NotesHistoryState;
        historyReceipt: NotesMutationHistoryReceipt;
      };

  export type NotesCompactCommandResult =
    | NotesAuthoritativeResult
    | {
        kind: "rejected";
        commitDisposition: "notCommitted";
        reason:
          | "precommit"
          | "staleHistoryEpoch"
          | "authorityRefreshRequired";
        error: NotesStructuredError;
      };

  export interface NotesVersionedLoadRequest {
    sessionId: string;
  }

  export interface NotesRecoveryEvidenceRequest {
    sessionId: string;
    expectedHistoryEpoch: string;
    expectedEntryId: string;
    entryWasAlreadyAppliedAtDispatch: boolean;
  }

  export type NotesHistoryReceipt =
    | { status: "applied" }
    | { status: "undone" }
    | { status: "missing" }
    | { status: "epochMismatch"; currentEpoch: string };

  export interface NotesVersionedLoadResult {
    workspace: NotesWorkspace;
    workspaceToken: string;
    history: NotesHistoryState;
    historyReceipt: { kind: "none" };
  }

  export interface NotesRecoveryLoadResult {
    workspace: NotesWorkspace;
    workspaceToken: string;
    history: NotesHistoryState;
    historyReceipt: NotesHistoryReceipt;
  }
  ```

  `NotesStore`에는 staged capability detection을 위해 다음 optional methods를 추가한다.

  ```ts
  loadActiveWorkspaceVersioned?(
    vaultPath: string,
    request: NotesVersionedLoadRequest
  ): Promise<NotesVersionedLoadResult>;
  recoverActiveWorkspaceVersioned?(
    vaultPath: string,
    request: NotesRecoveryEvidenceRequest
  ): Promise<NotesRecoveryLoadResult>;
  splitNodeCompact?(
    vaultPath: string,
    input: SplitNoteNodeInput,
    historyContext: NotesHistoryContext
  ): Promise<NotesCompactCommandResult>;
  createFirstChildCompact?(
    vaultPath: string,
    input: CreateNoteNodeInput,
    historyContext: NotesHistoryContext
  ): Promise<NotesCompactCommandResult>;
  updateNodeCompact?(
    vaultPath: string,
    input: UpdateNoteNodeInput,
    historyContext: NotesHistoryContext
  ): Promise<NotesCompactCommandResult>;
  ```

- [ ] **Step 5: strict decoder와 Tauri adapters 구현**

  `notesStore.ts`에 exact-key validator를 작성해 discriminant별 허용 key를
  고정한다. Token은 이 transport 단계에서 `typeof value === "string"`만
  검사한다. Empty/NUL token은 operation identity를 먼저 검증한 뒤 Task
  5 workspace gate에서 `malformedToken`으로 분류해야 하므로 여기서
  decode failure로 만들지 않는다. `upsertedNodes`, history, structured
  error는 기존 도메인 shape validator를 재사용하고 splice 숫자는 safe
  integer인지만 검사한다. ID uniqueness, 음수/range, anchor/parent/scope
  의미 검사는 Task 5로 미룬다.

  Adapters는 각각 다음 command만 한 번 invoke한다.

  ```text
  notes_load_workspace_versioned
  notes_recover_workspace_versioned
  notes_split_node_compact
  notes_create_first_child_compact
  notes_update_node_compact
  ```

  Resolved payload decoding 실패는 `notesMutationOutcome: "unknown"` brand를 보존해 coordinator가 `outcomeUnknown`으로 처리하게 한다.

- [ ] **Step 6: 같은 shape의 Rust serde 타입 추가**

  `types.rs`의 structs에는 `#[serde(rename_all = "camelCase")]`, struct
  variants를 가진 결과 enum에는
  `#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields =
  "camelCase")]`를 사용한다. `NotesCompactCommandResult::Rejected`의
  error는 기존 `NotesError`의 wire shape를 재사용하고, delta에는
  attachment field를 만들지 않는다.

- [ ] **Step 7: GREEN**

  Run:

  ```bash
  npm test -- src/services/notesStore.tauri.test.ts
  cargo test --manifest-path src-tauri/Cargo.toml notes::types::tests::compact
  npm run build
  ```

  Expected: strict valid payload만 PASS하고 malformed payload는 decode failure.

- [ ] **Step 8: 커밋**

  ```bash
  git add src/domain/notes.ts src/services/notesStore.ts src/services/notesStore.tauri.test.ts src-tauri/src/notes/types.rs
  git commit -m "feat(notes): define compact authority wire contracts"
  ```

---

### Task 2: Connection-incarnated workspace token tracker 구현

**Files:**

- Create: `src-tauri/src/notes/authority.rs`
- Modify: `src-tauri/src/notes/mod.rs`
- Modify: `src-tauri/src/notes/connection.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/notes/history.rs`
- Modify: `src-tauri/src/notes/sync/integration_tests.rs`

**Interfaces:**

- Consumes: managed SQLite connection lifecycle, update/commit/WAL/rollback
  hooks, database identity validation, and the existing autocheckpoint setting.
- Produces: `WorkspaceTokenTracker`, per-physical-connection hook installation,
  `NotesConnectionGuard::workspace_token()`, and all-producer token guarantees.

- [ ] **Step 1: tracker와 hook 통합 실패 테스트 작성**

  `connection.rs` unit tests에 다음을 추가한다.

  - 새 connection은 non-empty token을 가진다.
  - 한 transaction에서 node 1개 또는 10,000개가 바뀌어도 token은 한 번만 바뀐다.
  - attachment 변경도 한 번만 바뀐다.
  - read-only transaction과 non-Notes table update는 바뀌지 않는다.
  - rollback은 관찰 가능한 token을 바꾸지 않는다.
  - commit candidate가 버려지면 내부 sequence gap은 허용된다.
  - implicit one-statement transaction도 WAL commit 뒤 token을 바꾼다.
  - legacy full mutation, sync merge, Undo, Redo가 각각 successful dirty
    commit당 token을 정확히 한 번 바꾸고 rollback은 바꾸지 않는다.
  - 여러 row를 바꾼 한 transaction은 WAL callback 한 번에 candidate
    하나만 publish한다.
  - connection eviction/reopen은 같은 sequence라도 incarnation이 달라진다.
  - external database replacement를 감지해 같은 managed entry 안에서
    physical connection을 reopen한 직전/직후 token은 같지 않다.
  - WAL/autocheckpoint threshold를 읽은 뒤 authority hook이 마지막에
    설치되고, threshold 도달 시 기존과 같은 passive checkpoint가 실행됨.
  - threshold를 넘는 반복 commit 뒤 WAL frame/file이 무한 증가하지 않음.
  - database identity guard가 교체를 감지해 commit을 거부하는 기존 테스트가 그대로 통과한다.

- [ ] **Step 2: RED 확인**

  Run:

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml notes::connection::tests::workspace_token
  cargo test --manifest-path src-tauri/Cargo.toml notes::connection::tests::transaction_commit_does_not_acknowledge_replacement
  ```

  Expected: token tracker가 없어 첫 그룹 FAIL, 기존 identity test PASS.

- [ ] **Step 3: 순수 tracker 구현**

  `authority.rs`에 frontend가 해석할 수 없는 문자열을 발급하는 tracker를 추가한다.

  ```rust
  #[derive(Debug)]
  pub(crate) struct WorkspaceTokenTracker {
      incarnation: uuid::Uuid,
      visible_sequence: u64,
      next_candidate: u64,
      pending_candidate: Option<u64>,
  }

  impl WorkspaceTokenTracker {
      pub(crate) fn new() -> Self;
      pub(crate) fn note_notes_write(&mut self);
      pub(crate) fn after_wal_commit(&mut self);
      pub(crate) fn after_rollback(&mut self);
      pub(crate) fn current_token(&self) -> String;
  }
  ```

  첫 Notes row update가 transaction-local candidate를 하나만 선점한다.
  WAL commit callback만 그 candidate를 visible sequence로 publish하고,
  rollback은 candidate를 버린다. `current_token()`의 formatting은
  backend-private다. Frontend contract에 separator나 sequence 의미를
  노출하지 않는다.

- [ ] **Step 4: 기존 identity guard를 보존하고 post-commit hook 연결**

  `ManagedNotesConnection`에 `Arc<Mutex<WorkspaceTokenTracker>>`를 둔다.
  현재 Unix-only `install_commit_identity_guard` rename에 authority
  설치까지 가두지 않는다. `install_notes_connection_hooks` 자체와
  update/WAL/rollback/token lifecycle은 모든 platform에서 compile/install
  하고, commit callback 안의 pathname/inode identity 비교만
  `#[cfg(unix)]` helper로 호출한다. Non-Unix callback은 identity-specific
  branch 없이 pending authority transaction의 commit을 허용한다.

  - `update_hook`: database가 `main`이고 table이 `notes_nodes` 또는 `notes_attachments`일 때만 `note_notes_write()`.
  - `commit_hook`: token을 publish하지 않는다. Identity 변경이면 기존처럼 commit을 거부하고, 아니면 기존 test injection 뒤 commit을 허용한다.
  - `wal_hook`: SQLite가 WAL commit을 성공시킨 뒤에만 `after_wal_commit()`으로 pending candidate 하나를 publish한다.
  - `rollback_hook`: pending candidate를 버리고 visible sequence는 건드리지 않는다.

  rusqlite 0.40의 `wal_hook`은 capturing closure가 아닌 function pointer를
  받고 SQLite connection당 하나뿐이다. 따라서 custom hook을 단순히
  마지막에 설치해 기존 autocheckpoint를 잃으면 안 된다.
  Connection setup에서 현재 `PRAGMA wal_autocheckpoint` page threshold를
  먼저 읽는다. `lock_notes_connection`이 guard lifetime 동안 tracker
  `Weak`와 threshold를 thread-local stack에 push하고
  `NotesConnectionGuard::drop`이 exact entry를 pop하는
  `WorkspaceAuthorityHookScope`를 둔다. WAL callback은 같은 SQLite 호출
  thread에서 stack top을 upgrade해 token을 publish한 뒤, `pages >=
  threshold && threshold > 0`이면
  `wal.checkpoint_v2(CheckpointMode::PASSIVE)`를 호출해
  rusqlite가 교체한 기본 autocheckpoint 정책을 보존한다. Busy checkpoint는
  commit rollback으로 해석하지 않고, genuine SQLite error만 callback
  error로 반환한다. Nested guard와 WAL growth tests가 stack 복원과
  checkpoint 동작을 검증한다.

  이 post-commit 경계 때문에 commit hook이 실행된 뒤 실제 commit이
  실패해도 token이 publish되지 않으며, implicit transaction과 sync/Undo
  경로도 같은 update/WAL/rollback tracker를 통과한다.

  `install_notes_connection_hooks()`는 physical `Connection`마다 새
  `WorkspaceTokenTracker::new()`를 만들고 그 `Arc`를 반환한다. 최초 open
  에서는 schema/migration/WAL pragma setup이 끝난 뒤, managed connection을
  caller에게 노출하기 전에 설치해 setup writes가 pending candidate로
  남지 않게 한다. `revalidate_notes_connection`의 in-place reopen branch도 새
  connection에 hooks를 설치한 뒤 `ManagedNotesConnection`의 connection,
  identity, tracker를 같은 managed-entry lock 안에서 함께 교체한다.
  이전 tracker/incarnation을 재사용하거나 sequence를 복사하지 않는다.

- [ ] **Step 5: guard 전용 token accessor 추가**

  ```rust
  impl NotesConnectionGuard<'_> {
      pub(crate) fn workspace_token(&self) -> Result<String, String>;
  }
  ```

  Accessor는 connection lock을 가진 guard에서만 호출할 수 있고 identity validation 뒤 current token을 복제한다.

- [ ] **Step 6: GREEN**

  Run:

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml notes::connection
  cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests::workspace_token_all_producers
  cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests::workspace_token
  cargo test --manifest-path src-tauri/Cargo.toml notes::sync::integration_tests::workspace_token
  cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
  cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
  ```

  Expected: token/rollback/reconnect/in-place replacement와
  legacy/sync/Undo/Redo producer test, 기존 WAL/path identity test 모두 PASS.
  Windows target compile에서도 authority hooks/tracker가 cfg로 사라지지
  않는다. Target toolchain이 CI image에 없다면 먼저
  `rustup target add x86_64-pc-windows-msvc`로 설치하고 생략하지 않는다.

- [ ] **Step 7: 커밋**

  ```bash
  git add src-tauri/src/notes/authority.rs src-tauri/src/notes/mod.rs src-tauri/src/notes/connection.rs src-tauri/src/notes/commands.rs src-tauri/src/notes/history.rs src-tauri/src/notes/sync/integration_tests.rs
  git commit -m "feat(notes): track connection workspace authority"
  ```

---

### Task 3: Exact history receipt와 recovery evidence 구현

**Files:**

- Modify: `src-tauri/src/notes/history.rs`
- Modify: `src-tauri/src/notes/types.rs`

**Interfaces:**

- Consumes: existing history transaction/finalization, session lineage,
  `NotesHistoryContext`, and compact wire types.
- Produces: `HistoryFinalizeResult`, `NotesMutationHistoryReceipt`,
  `history_receipt()`, and `CompactMutationFailure`.

- [ ] **Step 1: history receipt 실패 테스트 작성**

  `history.rs` tests에 다음을 고정한다.

  - 새 split/child entry는 `recorded`와 exact caller entry ID.
  - ordinary text update는 `recorded`.
  - 기존 entry를 재사용한 `X → Y → X`는 `coalescedAway`와 requested ID이며 `nextUndoEntryId`는 삭제된 entry의 predecessor.
  - mutation 없는 versioned load receipt는 `none`.
  - structural entry가 사라진 결과를 success receipt로 만들지 않음.
  - recovery evidence가 같은 epoch에서 applied/undone/missing을 구분함.
  - 다른 epoch는 `epochMismatch { currentEpoch }`.
  - 두 session이 같은 Vault를 써도 request session의 lineage만 조회함.

- [ ] **Step 2: RED 확인**

  Run:

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests::mutation_receipt
  cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests::recovery_receipt
  ```

  Expected: receipt 타입과 lineage query가 없어 FAIL.

- [ ] **Step 3: finalize 결과에 receipt 추가**

  `finalize_transaction`은 entry 존재 여부와 coalescing 전 predecessor를 기록해 다음 타입을 반환한다.

  ```rust
  pub(crate) struct HistoryFinalizeResult {
      pub(crate) receipt: NotesMutationHistoryReceipt,
  }
  ```

  `HistoryTransactionResult`에도 동일 receipt를 추가한다. `record_mutation_result`가 저장한 `history_entry_id`와 receipt가 모순되면 transaction을 commit하지 않고 오류로 끝낸다.

  - 새/남은 entry: `Recorded { entry_id }`
  - 이미 존재한 entry가 net-zero로 삭제됨: `CoalescedAway { requested_entry_id }`
  - mutation audit가 비었고 entry가 없음: `None`

  Structural compact command는 `None`/`CoalescedAway`를 success로
  반환하지 않는다. Text compact command는 `Recorded` 또는 기존 entry를
  실제로 상쇄한 `CoalescedAway`만 success로 반환한다. Mutation result의
  `None`은 invalid identity이며, `None` receipt를 정상 사용하는 경로는
  mutation 없는 versioned load뿐이다.

- [ ] **Step 4: recovery lineage query 구현**

  ```rust
  pub(crate) fn history_receipt(
      connection: &Connection,
      request: &NotesRecoveryEvidenceRequest,
  ) -> Result<(NotesHistoryReceipt, NotesHistoryState), String>;
  ```

  먼저 `history_status`의 current epoch를 비교한다. Epoch가 같으면 exact session/entry row의 `is_undone`을 조회해 `Applied`, `Undone`, `Missing`을 반환한다. Epoch가 다르면 이전 entry 존재 여부를 추측하지 않고 `EpochMismatch`를 반환한다.

- [ ] **Step 5: stale epoch와 rollback-proven rejection 경계 타입 추가**

  Compact wrapper가 사용할 내부 오류를 만든다.

  ```rust
  pub(crate) enum CompactMutationFailure {
      NotCommitted {
          reason: NotesCompactRejectionReason,
          error: NotesError,
      },
      OutcomeUnknown(NotesError),
  }
  ```

  Input/context validation, transaction 시작 전 stale epoch, 명시적으로 rollback이 확인된 transaction error만 `NotCommitted`가 될 수 있다. Commit을 시도한 뒤의 오류는 `OutcomeUnknown`으로 유지한다.

- [ ] **Step 6: GREEN**

  Run:

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml notes::history
  cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
  ```

  Expected: receipt, predecessor, session isolation, epoch mismatch test PASS.

- [ ] **Step 7: 커밋**

  ```bash
  git add src-tauri/src/notes/history.rs src-tauri/src/notes/types.rs
  git commit -m "feat(notes): return exact mutation history receipts"
  ```

---

### Task 4: Same-lock versioned Active load와 recovery command 추가

**Files:**

- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/build.rs`
- Modify: `src-tauri/permissions/main-window.toml`
- Create: `src-tauri/permissions/autogenerated/notes_load_workspace_versioned.toml`
- Create: `src-tauri/permissions/autogenerated/notes_recover_workspace_versioned.toml`
- Modify: `src-tauri/gen/schemas/acl-manifests.json`
- Modify: `src-tauri/gen/schemas/desktop-schema.json`
- Modify: `src-tauri/gen/schemas/macOS-schema.json`

**Interfaces:**

- Consumes: `NotesConnectionGuard::workspace_token()`, Active workspace loader,
  existing coordinator history session ID, history recovery evidence, and
  Tauri command registration.
- Produces: `notes_load_workspace_versioned_inner()`,
  `notes_recover_workspace_versioned_inner()`, two public commands, and their
  generated permissions/schema entries.

- [ ] **Step 1: versioned load/recovery 실패 테스트 작성**

  `commands.rs` tests에서 barrier hook으로 competing writer를 준비해 다음을 단정한다.

  - Active workspace, workspace token, request session history가 하나의 connection lock 시점과 일치.
  - load는 `historyReceipt: none`.
  - recovery는 workspace/token/history/lineage receipt가 같은 lock 안에서 수집됨.
  - lock을 놓은 뒤 writer가 실행돼도 이미 반환용으로 동결한 bundle은 섞이지 않음.
  - snapshot read와 final validation 사이 database/WAL replacement는
    bundle을 반환하지 않고 error.
  - 다른 session ID를 주면 그 session history만 반환.
  - reconnect 뒤 이전 request는 epochMismatch와 새 incarnation token을 반환.

- [ ] **Step 2: RED 확인**

  Run:

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests::versioned_active_load
  cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests::versioned_recovery_load
  ```

  Expected: command가 없어 FAIL.

- [ ] **Step 3: inner functions 구현**

  ```rust
  pub(crate) fn notes_load_workspace_versioned_inner(
      vault_path: String,
      request: NotesVersionedLoadRequest,
  ) -> Result<NotesVersionedLoadResult, String>;

  pub(crate) fn notes_recover_workspace_versioned_inner(
      vault_path: String,
      request: NotesRecoveryEvidenceRequest,
  ) -> Result<NotesRecoveryLoadResult, String>;
  ```

  두 함수는 `acquire_notes_connection`과 `lock_notes_connection`을 한 번만
  호출한다. Guard를 유지한 상태에서 identity validate → Active
  `load_workspace` → token → 해당 session history/receipt → final identity
  validate 순으로 읽는다. 마지막 validation이 통과한 owned result를 만든
  뒤에만 guard를 drop한다. Snapshot 뒤 pathname/WAL identity가 바뀌면
  섞인 bundle을 반환하지 않고 load error로 끝낸다.

- [ ] **Step 4: Tauri command 등록**

  `commands.rs`에 `#[tauri::command(rename_all = "camelCase")]` wrappers를
  추가하고 `lib.rs` import/invoke handler와 `build.rs`의 `APP_COMMANDS`,
  `permissions/main-window.toml`에 정확히 다음 두 이름/allow identifier를
  각각 한 번 등록한다.

  ```text
  notes_load_workspace_versioned
  notes_recover_workspace_versioned
  allow-notes-load-workspace-versioned
  allow-notes-recover-workspace-versioned
  ```

  Run:

  ```bash
  cargo build --manifest-path src-tauri/Cargo.toml
  ```

  Expected: 두 autogenerated permission TOML이 생성되고
  `acl-manifests.json`, `desktop-schema.json`, `macOS-schema.json`이 새 allow
  permissions를 포함한다. Generated 파일을 수동 작성하지 않는다.

- [ ] **Step 5: GREEN**

  Run:

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests::versioned
  cargo test --manifest-path src-tauri/Cargo.toml application_manifest_covers_every_registered_command_exactly_once
  cargo test --manifest-path src-tauri/Cargo.toml application_commands_are_granted_only_to_local_main_window
  cargo test --manifest-path src-tauri/Cargo.toml notes::connection
  cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
  ```

  Expected: same-lock snapshot과 registration test PASS.

- [ ] **Step 6: 커밋**

  ```bash
  git add src-tauri/src/notes/commands.rs src-tauri/src/lib.rs src-tauri/build.rs src-tauri/permissions/main-window.toml src-tauri/permissions/autogenerated/notes_load_workspace_versioned.toml src-tauri/permissions/autogenerated/notes_recover_workspace_versioned.toml src-tauri/gen/schemas/acl-manifests.json src-tauri/gen/schemas/desktop-schema.json src-tauri/gen/schemas/macOS-schema.json
  git commit -m "feat(notes): load versioned active authority"
  ```

---

### Task 5: Map 기반 Active authority와 anchored delta validator 구현

**Files:**

- Create: `src/features/notes/notesAuthorityStore.ts`
- Create: `src/features/notes/notesAuthorityStore.test.ts`
- Create: `src/features/notes/notesCompactMutationAuthority.ts`
- Create: `src/features/notes/notesCompactMutationAuthority.test.ts`
- Modify: `scripts/checkNotesWorkspaceBudgets.mjs`

**Interfaces:**

- Consumes: versioned/full `NotesWorkspace`, compact result/delta/history
  expectations, and command postconditions.
- Produces: `NotesAuthorityStore`, `NotesAuthorityState`,
  `validateNotesAuthorityToken()`, `validateNotesMutationPostcondition()`,
  `applyNotesAuthorityDelta()`, and the operation-identity gate.

- [ ] **Step 1: authority store 실패 테스트 작성**

  1,000-node fixture에 대해 다음을 단정한다.

  - full build가 nodes/root/children/attachments Map을 정확히 생성.
  - one-row update는 해당 node Map과 presentation record만 copy-on-write.
  - one-row insertion은 대상 parent order array만 교체.
  - untouched node, child array, attachment array identity 유지.
  - result 적용 중 `Object.values`와 `normalizeNotesWorkspace` 호출 0.

- [ ] **Step 2: splice/semantic validator 실패 테스트 작성**

  다음 invalid delta는 전체 reject되어 base authority identity가 그대로여야 한다.

  - base token mismatch
  - empty/NUL base token 또는 workspace token
  - versioned/full fallback의 empty/NUL workspace token
  - dirty full fallback token이 dispatch token과 동일
  - index 범위 초과, wrong expectedRemovedIds, wrong before/after anchor
  - duplicate upsert/remove/insert ID
  - 존재하지 않는 inserted node
  - inserted node의 parent와 splice parent 불일치
  - remove됐지만 order에서 빠지지 않은 ID
  - parent membership이 바뀌었지만 old/new splice가 없는 upsert
  - source/new/target role의 archived/deleted/image/attachment-bearing node
    (단, field whitelist를 만족하는 existing rebalance sibling은 kind/
    attachment 보유와 무관하게 허용)
  - attachment mutation을 암시하는 node kind 또는 기존 attachment ownership 변경
  - NaN/unsafe sort key와 inconsistent order
  - correct receipt/token이지만 expected split/child/text postcondition 대신
    unrelated, otherwise-semantic-valid node를 바꾸는 delta/full candidate
  - expected postcondition도 만족하면서 unrelated node semantic
    update/remove/다른 parent splice를 추가한 delta
  - expected target/source upsert 안에 `isStarred`, completion, collapse,
    lifecycle, note/marker/layout/createdAt 등 command가 소유하지 않은 field
    change를 섞은 delta
  - full fallback이 expected postcondition과 함께 command 전 다른 session의
    unrelated current state를 포함하는 경우는 false breaker 없이 PASS

  Valid root/child insertion, text update, sort-key rebalance는 PASS해야 한다.

- [ ] **Step 3: RED 확인**

  Run:

  ```bash
  npm test -- src/features/notes/notesAuthorityStore.test.ts src/features/notes/notesCompactMutationAuthority.test.ts
  ```

  Expected: 모듈이 없어 FAIL.

- [ ] **Step 4: authority와 presentation 타입 구현**

  ```ts
  export interface NotesAuthorityStore {
    readonly nodesById: ReadonlyMap<NoteId, NoteNode>;
    readonly rootIds: readonly NoteId[];
    readonly childIdsByParent: ReadonlyMap<NoteId, readonly NoteId[]>;
    readonly attachmentsByNodeId: ReadonlyMap<
      NoteId,
      readonly NoteAttachment[]
    >;
  }

  export interface NotesActiveAuthority {
    readonly workspaceToken: string | null;
    readonly normalizedActiveStore: NotesAuthorityStore;
  }

  export interface NotesAuthorityPresentation {
    readonly nodesById: NormalizedNotesWorkspace["nodesById"];
    readonly rootIds: NormalizedNotesWorkspace["rootIds"];
    readonly childIdsByParent:
      NormalizedNotesWorkspace["childIdsByParent"];
    readonly attachmentsByNodeId:
      NormalizedNotesWorkspace["attachmentsByNodeId"];
  }

  export interface NotesAuthorityState {
    readonly authority: NotesActiveAuthority;
    readonly presentation: NotesAuthorityPresentation;
  }
  ```

  Full versioned load에서 Map과 null-prototype presentation records를 한 번 함께 만든다.

- [ ] **Step 5: atomic delta application 구현**

  ```ts
  export type NotesCompactCommandKind =
    | "split"
    | "first-child"
    | "text-update";

  export type NotesAuthorityDeltaInvalidReason =
    | "malformedToken"
    | "duplicateNodeId"
    | "invalidOrderSplice"
    | "missingNode"
    | "parentMismatch"
    | "scopeViolation"
    | "attachmentViolation"
    | "tokenDidNotAdvance"
    | "incompleteMembershipChange"
    | "invalidSortKey"
    | "postconditionMismatch"
    | "footprintMismatch";

  export type NotesMutationPostcondition =
    | {
        readonly kind: "split";
        readonly sourceId: NoteId;
        readonly expectedNodeId: NoteId;
        readonly expectedPrefix: string;
        readonly expectedSuffix: string;
      }
    | {
        readonly kind: "first-child";
        readonly expectedNodeId: NoteId;
        readonly parentId: NoteId;
        readonly expectedIndex: 0;
        readonly expectedTitle: "";
        readonly expectedNote: "";
      }
    | {
        readonly kind: "text-update";
        readonly nodeId: NoteId;
        readonly title: string;
        readonly note: string;
        readonly imageOffsetUtf16: number;
        readonly markerKind: NoteMarkerKind;
        readonly markdownImageWidth: number | null;
      };

  export type NotesAuthorityTokenDecision =
    | { readonly kind: "valid" }
    | { readonly kind: "malformedToken" }
    | { readonly kind: "tokenDidNotAdvance" };

  export function validateNotesAuthorityToken(input: {
    readonly workspaceToken: string;
    readonly expectedDifferentFrom?: string;
  }): NotesAuthorityTokenDecision;

  export type ApplyNotesAuthorityDeltaResult =
    | { readonly kind: "applied"; readonly state: NotesAuthorityState }
    | { readonly kind: "baseMismatch" }
    | {
        readonly kind: "invalid";
        readonly reason: NotesAuthorityDeltaInvalidReason;
      };

  export function applyNotesAuthorityDelta(input: {
    readonly current: NotesAuthorityState;
    readonly baseToken: string;
    readonly workspaceToken: string;
    readonly delta: NotesAuthorityDelta;
    readonly commandKind: NotesCompactCommandKind;
    readonly postcondition: NotesMutationPostcondition;
  }): ApplyNotesAuthorityDeltaResult;

  export function validateNotesMutationPostcondition(input: {
    readonly candidate: NotesAuthorityStore;
    readonly postcondition: NotesMutationPostcondition;
  }): boolean;

  export function validateNotesCompactDeltaFootprint(input: {
    readonly base: NotesAuthorityStore;
    readonly delta: NotesAuthorityDelta;
    readonly postcondition: NotesMutationPostcondition;
  }): boolean;
  ```

  `validateNotesAuthorityToken`은 full/delta/versioned load가 함께 쓰는
  공통 gate다. 먼저 returned token이 non-empty이고 NUL을 포함하지 않는지
  검사하고, dirty result의 `expectedDifferentFrom`이 있으면 equality가
  달라야 한다. Delta apply는 두 returned token을 이 gate로 검사해
  아니면 `invalid/malformedToken`을 반환한다. 그 다음 current token과
  `baseToken`을 equality 비교해 다르면 `baseMismatch`를 반환한다. 이는
  invalid delta나 breaker 사유가 아니다. 일치하면 모든 splice와 node
  semantic을 base에 대해 먼저 검증한 뒤 local copies에 적용한다.
  Delta를 적용하기 전에 `validateNotesCompactDeltaFootprint`가 command별
  exact changed set도 고정한다. Text update는 target upsert 하나,
  remove/order splice 0만 허용하고 base diff는 requested title/note/
  imageOffset/marker/markdownWidth와 backend-owned `updatedAt`뿐이다. Split
  source는 expected prefix와 `updatedAt`만 바뀌며 note/marker/layout/
  completion/star/collapse/lifecycle/createdAt/parent는 base와 같아야 한다.
  Split new node는 same-current-parent/direct-after, expected suffix/empty
  note, base source marker와 canonical create defaults만 허용한다.
  First-child new node도 expected input marker/canonical defaults와
  parent/index 0만 허용한다.

  Existing rebalance sibling은 node kind나 attachment 보유 여부와 무관하게
  touched parent 안에서 `sortKey`와 repository가 함께 쓰는 `updatedAt`만
  달라질 수 있고 attachments는 unchanged여야 한다. 따라서 image 또는
  attachment-bearing sibling이 rebalance에 포함돼도 valid지만 source/new
  compact eligibility는 여전히 active attachment-free text로 제한한다.
  Remove, 다른 semantic field, 다른 parent domain은 모두 거부한다.

  Local copies로 완성한 candidate에 `validateNotesMutationPostcondition`을
  마지막으로 실행해 source/new ID, exact text, parent/neighbor
  relationship을 확인한다. 하나라도 실패하면 어떤 copy도 반환하지
  않는다. Dirty compact
  success의 `workspaceToken`이 `baseToken`과 같으면 invalid로 처리하고,
  성공 시 backend `workspaceToken`을 그대로 저장한다.

  `kind: "full"`도 full workspace를 새 candidate store로 만든 직후
  postcondition validator를 거쳐야 한다. 다만 full variant에는 base token
  이 없어 command 전 다른 session의 legitimate unrelated state가 포함될
  수 있으므로 delta-only footprint validator를 적용하지 않는다. 이 공통
  postcondition이 성공하기 전에는 delta/full 어느 쪽도 authority/history를
  publish하지 않는다.

- [ ] **Step 6: operation identity gate 구현**

  ```ts
  export interface NotesHistoryExpectation {
    readonly historyEpoch: string;
    readonly requestedEntryId: string;
    readonly predecessorUndoEntryId: string | null;
    readonly allowCoalescedAway: boolean;
  }

  export interface NotesStructuralHistoryExpectation
    extends NotesHistoryExpectation {
    readonly allowCoalescedAway: false;
  }

  export interface NotesTextHistoryExpectation
    extends NotesHistoryExpectation {
    readonly allowCoalescedAway: true;
    readonly entryWasAlreadyAppliedAtDispatch: boolean;
  }

  export type NotesCompactHistoryExpectation =
    | NotesStructuralHistoryExpectation
    | NotesTextHistoryExpectation;

  export type NotesOperationIdentityDecision =
    | { readonly kind: "proven" }
    | { readonly kind: "outcomeUnknown"; readonly reason: string };
  ```

  `recorded`는 expected entry ID, history epoch, `nextUndoEntryId`가 모두 같아야 한다. `coalescedAway`는 expected requested ID와 dispatch 때 기록한 predecessor가 returned `nextUndoEntryId`와 같아야 한다. 이 gate는 token/delta validator보다 먼저 호출하도록 API를 분리한다.

- [ ] **Step 7: GREEN 및 architecture inventory**

  Run:

  ```bash
  npm test -- src/features/notes/notesAuthorityStore.test.ts src/features/notes/notesCompactMutationAuthority.test.ts
  npm run test:architecture
  ```

  Expected: valid delta만 atomic apply, unchanged identity 유지, production helpers budget PASS.

- [ ] **Step 8: 커밋**

  ```bash
  git add src/features/notes/notesAuthorityStore.ts src/features/notes/notesAuthorityStore.test.ts src/features/notes/notesCompactMutationAuthority.ts src/features/notes/notesCompactMutationAuthority.test.ts scripts/checkNotesWorkspaceBudgets.mjs
  git commit -m "feat(notes): validate normalized compact authority"
  ```

---

### Task 6: Coordinator가 versioned Active authority와 session projection을 소유

**Files:**

- Create: `src/features/notes/notesSessionProjection.ts`
- Create: `src/features/notes/notesSessionProjection.test.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Modify: `src/features/notes/notesWorkspaceTypes.ts`
- Modify: `src/features/notes/notesWorkspaceReducer.ts`
- Modify: `src/features/notes/notesWorkspaceReducer.test.ts`
- Modify: `src/features/notes/notesCommands.ts`
- Modify: `src/features/notes/notesWorkspaceCommandSupport.ts`
- Modify: `src/features/notes/notesWorkspaceCommandSupport.test.ts`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts`
- Modify: `src/features/notes/useNotesHistoryController.ts`
- Modify: `src/features/notes/useNotesWorkspace.operations.test.tsx`
- Modify: `src/features/notes/useNotesWorkspace.sharedSession.test.tsx`
- Modify: `scripts/checkNotesWorkspaceBudgets.mjs`

**Interfaces:**

- Consumes: Task 5 authority builders, existing coordinator history session,
  open scope projections, versioned load, and Phase A publication generations.
- Produces: `NotesCoordinatorVaultAuthority`, `NotesSessionProjection`,
  `NotesCoordinatorConsumerId`, `NotesCoordinatorConsumerState`,
  `versionedLoadFlight`, synchronized Active/All projection publication, and
  direct full/delta settlement surfaces.

- [ ] **Step 1: versioned coordinator bootstrap 실패 테스트 작성**

  다음을 단정한다.

  - 첫 Active/All session은 versioned load 한 번으로 authority와 그 session history를 함께 설치.
  - versioned load/recovery capability가 없는 existing repository/test mock은
    기존 initialize/full activation으로 정상 열리고 token null/compact
    disabled이며 optional method 호출 0.
  - 같은 Vault의 두 open UI consumer는 Active authority와 기존
    coordinator history session 하나를 공유하고 scope projection만 각각
    보유.
  - 같은 history session ID를 쓰는 두 consumer도 서로 다른 scope,
    selection/zoom overlay를 유지하고 한 consumer close가 다른 쪽을
    삭제하지 않음.
  - compact authority 전이는 모든 matching Active/All projection을 같은
    atomic transition에서 갱신하고 두 window가 동시에 새 row/text를 봄.
  - Archive/Trash/Tags/Recent result는 matching session projection만 바꾸고 Active authority를 덮지 않음.
  - 어느 scope에서 왔든 unversioned full mutation result는 matching
    projection을 수용하되 Active token을 `null`로 만듦.
  - versioned load/full authoritative result의 malformed token은
    authority로 설치되지 않음.
  - token `null`에서 compact 준비는 먼저 versioned load를 single-flight로 수행.
  - 같은 coordinator history session/generation의 동시 versioned load는
    promise 하나를 공유함.
  - Vault/session generation이 바뀐 old load는 새 view에 적용되지 않음.
  - queue는 Vault마다 dispatched-but-unsettled mutation이 최대 하나.

- [ ] **Step 2: RED 확인**

  Run:

  ```bash
  npm test -- src/features/notes/notesSessionProjection.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.sharedSession.test.tsx
  ```

  Expected: coordinator가 raw full workspace 하나만 소유해 FAIL.

- [ ] **Step 3: coordinator entry 모델 확장**

  ```ts
  interface NotesCoordinatorVaultAuthority {
    active: NotesAuthorityState | null;
    versionedLoadFlight: Promise<NotesVersionedLoadResult> | null;
    dispatchedMutationId: string | null;
    nextConsumerId: number;
    consumers: Map<NotesCoordinatorConsumerId, NotesCoordinatorConsumerState>;
  }

  export type NotesCoordinatorConsumerId =
    number & { readonly __notesCoordinatorConsumerId: unique symbol };

  export interface NotesCoordinatorConsumerState {
    readonly consumerId: NotesCoordinatorConsumerId;
    readonly projection: NotesSessionProjection;
    readonly presentation: NotesAuthorityPresentation;
    readonly ui: NotesSessionUiOverlay;
  }

  export interface NotesSessionProjection {
    readonly scope: NotesWorkspaceScope;
    readonly normalizedStore: NotesAuthorityStore;
  }

  export type NotesSessionUiOverlay = Pick<
    NormalizedNotesWorkspace,
    | "selectedId"
    | "zoomRootId"
    | "editingNoteId"
    | "pendingFocusId"
    | "pendingFocusField"
    | "status"
    | "error"
  >;

  export function composeNotesWorkspaceState(input: {
    readonly presentation: NotesAuthorityPresentation;
    readonly ui: NotesSessionUiOverlay;
  }): NormalizedNotesWorkspace;

  export interface NotesWorkspaceQueueContext {
    readonly repository: NotesStore;
    readonly vaultRoot: string;
    readonly confirmedState: NormalizedNotesWorkspace;
    readonly sourceScope: NotesWorkspaceScope;
    readonly sourceLibraryView: NotesLibraryView;
    readonly history?: NotesHistorySession;
  }
  ```

  `notesWorkspaceCoordinator.ts`에는 entry field와 orchestration만 두고 full build/projection 변환은 새 모듈로 보낸다.
  `openSession()`은 history session ID와 별개인 monotonic
  `NotesCoordinatorConsumerId`를 발급하고 handle closure가 그 ID를
  캡처한다. Projection/presentation/UI overlay maps를 history session
  string으로 keying하지 않는다. `closeSession()`은 exact consumer ID만
  제거하고 마지막 consumer가 닫힐 때 기존 coordinator entry lifecycle을
  따른다.

- [ ] **Step 4: versioned load publication 구현**

  기존 `initialize(vault, { sessionId })`가 만든
  `entry.history.sessionId`/epoch를 그대로 유지한다. 이 계획은 UI
  consumer별 history session을 새로 만들지 않는다. Initialize 반환
  workspace를 versioned authority와 조합하지 않고, 이어서
  `loadActiveWorkspaceVersioned(vault, {
    sessionId: entry.history.sessionId
  })`를 호출한다. Versioned workspace/token과 그 기존 coordinator history
  session의 state만 한 transition에서 수용하고 기존 Phase A
  projection/layout generation을 한 번만 증가시킨다. 설치 전
  `validateNotesAuthorityToken`을 통과해야 하며, malformed versioned-load
  token은 load failure로 처리한다.

  Staged capability는 additive로 유지한다. 최소 authority capability는
  `loadActiveWorkspaceVersioned`와 `recoverActiveWorkspaceVersioned`가 둘 다
  존재해야 한다. 둘 중 하나라도 없으면 initialize가 반환한 기존 full
  workspace/history로 presentation을 만들고 Active token은 `null`, 모든
  compact command capability는 false로 둔다. 이 branch는 activation
  error가 아니며 versioned/recovery optional method를 호출하지 않는다.
  각 command route는 이 authority pair와 해당 optional compact command
  method까지 모두 있을 때만 enabled다.

  `versionedLoadFlight`는 같은 Vault coordinator generation에서 동시
  요청을 하나만 dedupe한다. 다른 history session을 만들어 bundle을
  섞는 로직은 추가하지 않는다. Vault/generation이 바뀌면 old flight를
  폐기하고 새 entry의 history session ID로 새 load를 시작한다.

  Full filtered load는 해당 scope session projection만 교체한다. Legacy
  Active full mutation result를 수용할 때 Map authority를 재구성하되
  token은 반드시 `null`로 설정한다. Filtered/unversioned mutation result는
  Active Map을 그 filtered payload로 교체하지 않고 기존 Map을 유지한 채
  token만 `null`로 만들어 다음 compact 시 versioned Active reload를
  강제한다.

  Valid Active authority transition은 shared Map을 먼저 patch한 뒤 모든
  open `scope.kind === "active"`/All projection과 presentation을 structural
  sharing으로 파생해 같은 coordinator notification batch에서 교체한다.
  기존 coordinator history는 command origin의 single history session
  state로 한 번만 갱신한다. 두 window test는 origin과 sibling consumer가
  중간 token/projection 조합을 관찰하지 않고 동일 transition에서 새
  authority를 받는지 단정한다.

  `NotesStateSlice.state`와 existing row/header consumers에는 계속 완전한
  `NormalizedNotesWorkspace`를 제공한다. Shared authority/presentation을
  reducer UI state로 대체하지 않는다. 각 consumer의 selection/zoom/edit/
  pending-focus/status/error는 `NotesSessionUiOverlay`에 남기고,
  `composeNotesWorkspaceState()`가 four authority indexes와 overlay를 얕게
  합성한다. Authority transition은 unchanged UI overlay identity를
  재사용하고, UI-only reducer action은 shared authority indexes를
  재구축하지 않는다. Existing reducer tests는 mutable-compatible
  `Record`/array field types와 all UI fields가 보존되는지 고정한다.

  Queue command read boundary도 같은 task에서 migration한다.
  `NotesWorkspaceQueueContext.confirmedWorkspace` raw array를 제거하고 exact
  consumer의 composed `confirmedState`를 전달한다. `confirmedState(context)`
  는 normalize를 호출하지 않고 `context.confirmedState`를 그대로
  반환한다. `sourceScope`와 `sourceLibraryView`는 queue item을 enqueue할
  때 함께 snapshot하고 callback 실행 중 pane navigation으로 다시 읽거나
  바꾸지 않는다. `notesCommands.ts`, `useNotesHistoryController.ts`, draft/
  compound helpers의 authority/precondition reads는 모두 이 normalized
  field를 사용한다.

  `runCompoundQueueWork`는 첫 repository mutation 전에는 raw workspace를
  만들지 않는다. 첫 returned legacy full mutation 뒤에만 그 returned
  workspace를 후속 full steps에 사용하고, 그 전 실패는 workspace field가
  없는 failure를 반환해 coordinator가 confirmed authority를 유지한다.
  Compact delta 뒤 새 node를 대상으로 legacy toggle/rename/move를 실행한
  test는 absent로 skip되지 않고 `confirmedState.nodesById`에서 찾은 뒤
  legacy IPC를 정확히 한 번 호출해야 한다. GREEN 전에 production command
  layer의 `normalizeWorkspace(context.confirmedWorkspace)`와 raw base reads가
  0인지 `rg`로 확인한다.

- [ ] **Step 5: direct full/delta settlement surface 추가**

  Coordinator 내부 queue result를 다음으로 확장하되 아직 compact command를 UI에서 enable하지 않는다.

  ```ts
  export type NotesCoordinatorAuthoritativeSettlement =
    | {
        readonly kind: "full";
        readonly result: Extract<NotesAuthoritativeResult, { kind: "full" }>;
      }
    | {
        readonly kind: "delta";
        readonly result: Extract<NotesAuthoritativeResult, { kind: "delta" }>;
      };
  ```

  Hook/history controller는 coordinator가 제공한 presentation과 history를 소비하고 raw workspace를 다시 normalize하지 않는다.

- [ ] **Step 6: GREEN 및 line budget 확인**

  Run:

  ```bash
  npm test -- src/features/notes/notesSessionProjection.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesWorkspaceCommandSupport.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx
  npm run test:architecture
  npm run build
  rg -n 'normalizeWorkspace\\(context\\.confirmedWorkspace\\)|context\\.confirmedWorkspace' src/features/notes/notesCommands.ts src/features/notes/notesWorkspaceCommandSupport.ts src/features/notes/useNotesHistoryController.ts
  wc -l src/features/notes/notesWorkspaceRuntime.ts src/features/notes/useNotesHistoryController.ts
  ```

  Expected: tests/build PASS, `rg` 결과 없음, 두 기존 파일 각각 1,500줄
  이하.

- [ ] **Step 7: 커밋**

  ```bash
  git add src/features/notes/notesSessionProjection.ts src/features/notes/notesSessionProjection.test.ts src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesWorkspaceTypes.ts src/features/notes/notesWorkspaceReducer.ts src/features/notes/notesWorkspaceReducer.test.ts src/features/notes/notesCommands.ts src/features/notes/notesWorkspaceCommandSupport.ts src/features/notes/notesWorkspaceCommandSupport.test.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/useNotesHistoryController.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx scripts/checkNotesWorkspaceBudgets.mjs
  git commit -m "refactor(notes): centralize active workspace authority"
  ```

---

### Task 7: Identity-first settlement, single-flight recovery, hard authority lock

**Files:**

- Modify: `src/features/notes/notesAuthorityRecovery.ts`
- Modify: `src/features/notes/notesAuthorityRecovery.test.ts`
- Modify: `src/features/notes/notesCompactMutationAuthority.test.ts`
- Create: `src/features/notes/notesCompactCircuitBreaker.ts`
- Create: `src/features/notes/notesCompactCircuitBreaker.test.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Modify: `src/services/notesWriteQueue.ts`
- Modify: `src/services/notesWriteQueue.test.ts`
- Modify: `src/features/notes/notesDraftEngine.ts`
- Modify: `src/features/notes/notesDraftEngine.test.ts`
- Modify: `src/features/notes/useNotesDraftWorkflow.ts`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/useNotesWorkspace.operations.test.tsx`
- Modify: `src/features/notes/useNotesWorkspace.sharedSession.test.tsx`
- Modify: `scripts/checkNotesWorkspaceBudgets.mjs`

**Interfaces:**

- Consumes: Task 5 ordered identity/workspace/postcondition gates, versioned
  recovery load, queue head recovery record, draft attempts, and Phase A
  authority lock UI.
- Produces: `NotesMutationRecoveryRecord`, recovered outcome classifier,
  retained `NotesLocalHistoryReconciliationLease`, generation-scoped
  `recoveryFlight`, hard queue/draft lock, and `NotesCompactCircuitBreaker`.

- [ ] **Step 1: ordered gates와 recovery matrix 실패 테스트 작성**

  `notesCompactMutationAuthority.test.ts`와 `notesAuthorityRecovery.test.ts`에 다음을 고정한다.

  - history receipt/epoch/coherence 실패는 token이 맞아도 `outcomeUnknown`.
  - identity-proven base mismatch/invalid delta는 `knownCommittedMismatch`.
  - identity/workspace/postcondition은 proven이고 local history finalization만
    false인 경우도 `knownCommittedMismatch` + breaker keepEnabled.
  - 두 경우 모두 compact envelope의 history/token/delta를 전혀 수용하지 않음.
  - typed precommit은 reload 없이 종료.
  - typed staleHistoryEpoch/authorityRefreshRequired는 mutation retry 0, versioned reload 1.
  - invoke rejection/decode failure는 mutation retry 0, recovery evidence reload 1.
  - applied + current postcondition, applied + superseded, undone, missing, epochMismatch의 exact 분류.
  - `entryWasAlreadyAppliedAtDispatch: true`인 ambiguous text는 matching applied receipt여도 `indeterminate`.
  - decoded `coalescedAway(E)` identity 뒤 invalid delta로 recovery하면
    reload의 `nextUndoEntryId === predecessor`를 local timeline에도
    반영한 뒤에만 authority publish/unlock.
  - transport outcomeUnknown + recovery `missing(E)`은 frozen predecessor와
    local lease로 E를 제거/보존할 수 있을 때만 reconcile; otherwise
    history/recovery blocked.
  - epochMismatch + reset-shaped returned history는 old snapshots release,
    new epoch bind, lost-lineage disclosure 뒤 authority accept; non-reset
    shape는 recoveryBlocked.
  - epochMismatch `currentEpoch !== history.historyEpoch`, non-null next ID,
    canUndo/canRedo true, non-empty pruned IDs를 각각 table test로 거부하고
    local reset/authority publish 0.
  - stale UI interaction은 authority와 zero-motion identity를 수용하지만 focus eligibility false.
  - bad split patch 뒤 good text patch를 같은 full baseline 위에 적용하고
    same-token reload parity가 실패하면 split/text producer 둘 다 disable.
  - token-different full reload는 old producer provenance를 rebase/clear하고,
    그 뒤 새 text patch와 same-token parity mismatch는 text만 disable.

- [ ] **Step 2: hard recovery와 queue 실패 테스트 작성**

  Coordinator/write queue/draft tests에 다음을 추가한다.

  - reload 실패 시 running command는 `recoveryBlocked`.
  - queued-but-undispatched save/structure/Undo/Redo는 `skipped/retryable`.
  - confirmed authority와 drafts는 유지되고 busy state는 해제.
  - write/history는 잠기고 read/recovery만 허용.
  - draft timers는 pause.
  - 사용자 retry 성공 뒤 never-dispatched draft는 deduplicated timer 하나만 rearm.
  - dispatched ambiguous draft는 `manualRetryRequired`; 새 edit 또는 explicit retry 전 timer 재전송 0.
  - navigation 뒤 old recovery가 끝나도 새 Vault/view에 적용/focus하지 않음.
  - baseMismatch recovery 실패→explicit retry 성공은 breaker enabled 유지.
  - malformed token/invalid delta/postcondition recovery 실패→retry 성공은
    저장된 exact command/reason breaker를 write unlock 전에 disable.
  - running queue head가 `recoveryBlocked`로 settle/제거된 뒤에도
    writeAuthority가 full recovery record를 보유하고 explicit retry는 그
    evidence로 recovery load만 재실행; Vault generation 변경은 record 폐기.
  - recoveryBlocked 뒤 explicit retry success도 original local-history
    lease/expectation을 사용하며, 실패 attempt는 pure false, 최종 accepted
    transition은 한 번뿐이고 새 lease를 만들지 않음.
  - 첫 recovery reload의 reconcile false는 lease active/local mutation
    0인 채 recoveryBlocked; explicit retry의 새 reload가 same lease를 다시
    호출해 accepted true 후 release 1.
  - recovery load await 중 Vault/session generation dispose는 old lease를
    disposed로 만들고 reload result의 reconcile/publish/unlock/breaker
    mutation 0.

- [ ] **Step 3: RED 확인**

  Run:

  ```bash
  npm test -- src/features/notes/notesCompactMutationAuthority.test.ts src/features/notes/notesAuthorityRecovery.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/services/notesWriteQueue.test.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx
  ```

  Expected: receipt evidence와 Phase B recovery states가 없어 FAIL.

- [ ] **Step 4: recovery record와 classifier 구현**

  ```ts
  export type NotesAuthorityRecoveryCause =
    | "knownCommittedMismatch"
    | "outcomeUnknown";

  export type NotesRecoveredMutationOutcome =
    | "committedAndCurrent"
    | "committedButSuperseded"
    | "notProvenCommitted"
    | "indeterminate";

  export interface NotesDirectLocalHistoryCandidate {
    readonly candidateState: NormalizedNotesWorkspace;
    readonly history: NotesHistoryState;
    readonly receipt: Exclude<
      NotesMutationHistoryReceipt,
      { kind: "none" }
    >;
  }

  export interface NotesRecoveredLocalHistoryCandidate {
    readonly candidateState: NormalizedNotesWorkspace;
    readonly history: NotesHistoryState;
    readonly evidenceReceipt: NotesHistoryReceipt;
    readonly outcome: NotesRecoveredMutationOutcome;
  }

  export type NotesLocalHistoryFinalization =
    | {
        readonly accepted: true;
        readonly unreachableEntryIds: readonly string[];
      }
    | { readonly accepted: false; readonly reason: string };

  export interface NotesLocalHistoryReconciliationLease {
    readonly expectation: NotesCompactHistoryExpectation;
    readonly coordinatorGeneration: number;
    isActive(): boolean;
    finalizeDirect(
      input: NotesDirectLocalHistoryCandidate
    ): NotesLocalHistoryFinalization;
    reconcileRecovery(
      input: NotesRecoveredLocalHistoryCandidate
    ): NotesLocalHistoryFinalization;
    release(): void;
  }

  export interface NotesMutationRecoveryRecord {
    readonly cause: NotesAuthorityRecoveryCause;
    readonly commandKind: NotesCompactCommandKind;
    readonly coordinatorGeneration: number;
    readonly sessionId: string;
    readonly expectedHistoryEpoch: string;
    readonly expectedEntryId: string;
    readonly entryWasAlreadyAppliedAtDispatch: boolean;
    readonly historyExpectation: NotesCompactHistoryExpectation;
    readonly localHistoryLease: NotesLocalHistoryReconciliationLease;
    readonly operationExpectation: NotesMutationPostcondition;
    readonly breakerDisposition:
      | { readonly kind: "keepEnabled" }
      | {
          readonly kind: "disableAfterRecovery";
          readonly reason:
            | "malformedToken"
            | "invalidDelta"
            | "parityMismatch";
        };
    readonly paneId?: string;
    readonly insertionIntentToken?: number;
    readonly interactionEpochAtDispatch?: number;
  }

  export type NotesWriteAuthority =
    | { readonly kind: "known" }
    | {
        readonly kind: "recovering";
        readonly generation: number;
        readonly record: NotesMutationRecoveryRecord;
      }
    | {
        readonly kind: "recoveryBlocked";
        readonly generation: number;
        readonly record: NotesMutationRecoveryRecord;
        readonly error: string;
      };
  ```

  known-committed는 compact receipt를 recovery commit 증명에 재사용하지 않고
  current/superseded만 판정한다. outcome-unknown은 승인된
  receipt/postcondition matrix를 그대로 적용한다. Normal base mismatch와
  local-history mismatch, transport outcomeUnknown은 `keepEnabled`,
  malformed token/invalid
  footprint·delta·postcondition은 해당 reason의 `disableAfterRecovery`를
  기록한다. Recovery가 hard-fail해도 이 field를 operation record와 함께
  보존한다.

  Recovery record는 generic entry ID만 저장하지 않고 full specialized
  history expectation(특히 text predecessor)과 one-shot local-history lease를
  소유한다. Compact envelope의 receipt/history/token/delta는 recovery
  record에 복사하지 않고 승인 계약대로 전부 폐기한다. Lease는 exact
  history owner, original before/after snapshot builder, pin, exact coordinator
  generation을 캡처하되 React component/live ref callback을 보존하지 않는
  coordinator-owned object다. Lease state는
  `active | accepted | disposed`다. `finalizeDirect(false)`와
  `reconcileRecovery(false)`는 local state/snapshot ownership을 전혀 바꾸지
  않고 `active`를 유지한다. 따라서 recoveryBlocked 뒤 explicit retry가
  같은 lease를 다시 사용할 수 있다. Accepted true만 `accepted`로,
  generation disposal만 `disposed`로 전환한다. `release()`는 idempotent며
  accepted/disposed lease의 finalize/reconcile 호출은 거부한다. Hard
  recovery failure와 queue-head 제거만으로는 lease를 release하지 않는다.

- [ ] **Step 5: coordinator recovery와 queue lock 구현**

  Vault entry에 generation-scoped `recoveryFlight` 하나와 위 concrete
  `writeAuthority`를 둔다. Queue head 하나만 dispatch할 수 있고 recovery
  request는 그 head record 하나에서만 만든다. Recovery를 시작할 때 full
  record를 queue item에서 `writeAuthority.recovering`으로 먼저 transfer한
  뒤 head를 settle할 수 있다. 대기 caller는 reload promise를 공유하지만
  receipt request를 추가하지 않는다.

  Recovery success candidate를 만든 뒤 classifier와 postcondition을 먼저
  통과시키고, authority publication/write unlock 전에
  current Vault/session coordinator generation이
  `record.coordinatorGeneration`과 같고 lease가 active인지 reload await
  직후와 reconciliation 직전에 각각 검사한다. 다르거나 disposed면 old
  reload를 버리고 reconcile/publish/unlock/breaker mutation을 0으로 둔다.
  유효한 각 reload attempt는
  `record.localHistoryLease.reconcileRecovery()`를 최대 한 번 호출한다.
  False는 pure failure로 lease를 active 상태에 둔 채 recoveryBlocked가
  되며 explicit retry가 same lease에 새 reload candidate를 전달한다.
  Reconciliation은 reload bundle의 history/evidence만 사용한다. Recovery
  evidence가 `applied`면 exact E를 recorded로, `missing`이면
  returned `nextUndoEntryId`가 frozen predecessor와 일치할 때만 E 없는
  projection으로 reconcile한다. `undone`은 lease가 E의 exact before/after와
  cursor를 backend state에 맞출 수 있을 때만 수용한다. `epochMismatch`는
  receipt의 `currentEpoch === history.historyEpoch`,
  `canUndo === false`, `canRedo === false`,
  `nextUndoEntryId === null`, `nextRedoEntryId === null`,
  `prunedEntryIds.length === 0`을 모두 만족해야 한다. Exact predicate가
  통과하면 approved reconnect contract대로 old local timeline/snapshots를
  release하고 returned current epoch에 bind한 뒤 lost Undo lineage를
  사용자에게 disclose한다. Epoch cross-field mismatch, non-reset shape, 다른
  nextUndo/nextRedo처럼 snapshot을 정확히 만들 수 없는 결과만
  authority/history를 부분 publish하거나 write lock을 풀지 않고
  `recoveryBlocked`로 남겨 reopen/reset을 요구한다.

  Reconciliation success 뒤에만 reload workspace/token/history,
  local timeline, breaker disposition을 한 transition에서 publish하고
  unreachable cleanup을 queueing한 뒤 writes를 unlock한다. Recovery
  failure는 queue의 undispatched mutation을 drain해 retryable skip으로
  settle하고 신규 write/history enqueue를 거절한다.
  Initial recovery나 explicit retry가 성공하면 saved
  `breakerDisposition`을 같은 transition에서 적용한 뒤에만 writes/history
  lock을 해제한다. Retry UI는 새 broad cause를 만들어 원래 disposition을
  잃지 않는다.
  Reload 실패는 같은 record/generation을
  `writeAuthority.recoveryBlocked`에 남긴 뒤 running head를 제거하고 queue를
  drain한다. Explicit retry는 blocked record로
  `recoverActiveWorkspaceVersioned`만 재실행하며 mutation/history command를
  enqueue하지 않는다. Vault/session generation 교체는 old blocked record와
  flight를 폐기하고 retained local-history lease를 release해 새 view에
  적용하지 않는다.

- [ ] **Step 6: per-command circuit breaker 구현**

  ```ts
  export interface NotesCompactCircuitBreaker {
    isEnabled(kind: NotesCompactCommandKind): boolean;
    disable(
      kind: NotesCompactCommandKind,
      reason: "malformedToken" | "invalidDelta" | "parityMismatch"
    ): void;
  }
  ```

  Breaker는 application session memory에만 존재한다. 정상 base token mismatch는 disable하지 않는다. Malformed token/invalid delta는 reload 후 해당 command만 disable하며 다른 compact command에는 전파하지 않는다.

  Coordinator는 마지막 parity-proven full baseline 이후 authority에
  적용된 producer command kind를 최대 세 원소의
  `Set<NotesCompactCommandKind>`로 기록한다. 이후 다른 이유로 versioned
  full reload가 발생했을 때 returned token이 current token과
  exact-equal이면, 이미 reload에서 만든 Map authority와 현재 patched
  authority를 비교한다. 값이 다르면 reload authority를 수용하고 원인을
  한 command로 특정할 수 없으므로 Set 안의 producer를 모두
  `parityMismatch`로 disable한다. 값이 같으면 parity가 증명되므로 Set을
  비운다. Token이 달라진 reload는 중간 commit 가능성이 있으므로 old
  patches의 parity 성공/실패 증거로 사용하지 않지만, 그 full authority가
  새 baseline을 교체했으므로 Set은 반드시 clear/rebase한다. 이후 direct
  patch producer만 새 Set에 기록한다. 이 검사는 이미 필요한 reload
  payload만 사용하며 compact success마다 별도 full IPC를 추가하지 않는다.

- [ ] **Step 7: draft/UI recovery 상태 연결**

  Phase A draft pause API에 `skipped/retryable`과 `manualRetryRequired`를 구분하는 attempt metadata를 추가한다. `NotesOutlinePane`은 recovery 중 `aria-busy`, hard failure에서 `role="alert"`와 explicit retry button을 제공한다. Retry는 recovery load만 실행하며 mutation을 재실행하지 않는다.

- [ ] **Step 8: GREEN 및 architecture inventory**

  Run:

  ```bash
  npm test -- src/features/notes/notesCompactMutationAuthority.test.ts src/features/notes/notesAuthorityRecovery.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/services/notesWriteQueue.test.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx
  npm run test:architecture
  ```

  Expected: 모든 recovery branch에서 mutation 자동 retry 0, hard lock/draft 보존 PASS.

- [ ] **Step 9: 커밋**

  ```bash
  git add src/features/notes/notesAuthorityRecovery.ts src/features/notes/notesAuthorityRecovery.test.ts src/features/notes/notesCompactMutationAuthority.test.ts src/features/notes/notesCompactCircuitBreaker.ts src/features/notes/notesCompactCircuitBreaker.test.ts src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/services/notesWriteQueue.ts src/services/notesWriteQueue.test.ts src/features/notes/notesDraftEngine.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/useNotesDraftWorkflow.ts src/features/notes/NotesOutlinePane.tsx src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx scripts/checkNotesWorkspaceBudgets.mjs
  git commit -m "fix(notes): recover compact authority without replay"
  ```

---

### Task 8: Backend compact transaction core와 split command 구현

**Files:**

- Modify: `src-tauri/src/notes/authority.rs`
- Modify: `src-tauri/src/notes/history.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/notes/performance.rs`
- Modify: `src-tauri/build.rs`
- Modify: `src-tauri/permissions/main-window.toml`
- Create: `src-tauri/permissions/autogenerated/notes_split_node_compact.toml`
- Modify: `src-tauri/gen/schemas/acl-manifests.json`
- Modify: `src-tauri/gen/schemas/desktop-schema.json`
- Modify: `src-tauri/gen/schemas/macOS-schema.json`

**Interfaces:**

- Consumes: token tracker, exact history finalization, legacy split mutation,
  attachment cleanup lease/reconciliation, and Tauri registration.
- Produces: `WorkspaceMutationMaterialization`, `CompactMutationCapture`,
  `MaterializedWorkspaceMutation`,
  `with_workspace_transaction_materialized()`, same-call full fallback,
  `notes_split_node_compact`, and split payload benchmark evidence.

- [ ] **Step 1: compact core/split 실패 테스트 작성**

  Rust tests에서 다음을 단정한다.

  - eligible split은 mutator 1회, full `load_workspace` 0회.
  - result는 source/new node upsert와 anchored order splice 하나.
  - 다른 session이 source를 dispatch 뒤 move해도 backend는 lock 시점
    source current parent에서 direct-next split을 만들며 recovery identity는
    current same-parent/direct-after 관계로 판정.
  - `full(base) + delta`가 fresh Active reload와 값/순서/attachment까지 동일.
  - history receipt는 exact caller entry ID이고 returned history의 `nextUndoEntryId`와 일치.
  - base token은 mutation 직전 token, workspace token은 commit 뒤 token.
  - active text source가 attachment-bearing이면 같은 compact wrapper
    call의 Full materialization이 mutation 1회와 versioned
    full/token/history/receipt를 반환.
  - image source와 archived/deleted/missing source는 기존 split semantics
    그대로 rollback-proven `rejected/notCommitted/precommit`, mutation 0,
    success envelope 0.
  - sort-key rebalance가 발생하면 audit `before_json IS NOT after_json`인
    모든 touched node(sortKey 또는 updatedAt 변화)를 upsert하지만 order는
    한 splice로 표현.
  - rebalance sibling이 image/attachment-bearing이어도 그 existing node의
    sortKey+updatedAt만 바뀌고 attachment는 그대로면 valid compact delta.
  - precommit/stale epoch는 typed rejected, commit 이후 injected failure는 outer error.
  - history prune가 반환한 attachment cleanup candidates는 기존
    reconciliation을 정확히 한 번 통과.
  - commit 뒤 첫/final identity validation 사이 database replacement는
    success envelope가 아니라 outer error.

- [ ] **Step 2: payload scaling 실패 benchmark 작성**

  같은 위치의 split을 1,000-node와 10,000-node fixture에서 실행해 serialized delta bytes 차이가 10% 이하인지 검사한다. 10,000 root siblings에 sort-key gap이 있으면 `orderSplices.len() == 1`, `insertedIds.len() == 1`, full root ID vector가 payload에 없어야 한다.

- [ ] **Step 3: RED 확인**

  Run:

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests::compact_split
  cargo test --manifest-path src-tauri/Cargo.toml notes::performance::compact_split_payload
  ```

  Expected: compact transaction core/command가 없어 FAIL.

- [ ] **Step 4: transaction result mode를 분리**

  `repository.rs`의 현재 full-only `with_workspace_transaction`을 다음 두
  내부 mode가 공유하도록 분해한다.

  ```rust
  pub(crate) enum WorkspaceMutationMaterialization {
      Full,
      Compact,
  }

  pub(crate) struct CompactMutationCapture {
      pub(crate) upserted_nodes: Vec<NoteNode>,
      pub(crate) removed_node_ids: Vec<NoteId>,
      pub(crate) order_splices: Vec<NotesAuthorityOrderSplice>,
  }

  pub(crate) enum WorkspaceMutationPayload {
      Full(NotesWorkspace),
      Compact(CompactMutationCapture),
  }

  pub(crate) struct MaterializedWorkspaceMutation {
      pub(crate) payload: WorkspaceMutationPayload,
      pub(crate) history: NotesHistoryState,
      pub(crate) history_receipt: NotesMutationHistoryReceipt,
      pub(crate) pruned_attachment_paths: Vec<PathBuf>,
  }

  pub(crate) fn with_workspace_transaction_materialized<F>(
      connection: &mut Connection,
      history_context: &NotesHistoryContext,
      mode: WorkspaceMutationMaterialization,
      operation: F,
  ) -> Result<MaterializedWorkspaceMutation, CompactMutationFailure>
  where
      F: FnOnce(&Transaction<'_>) -> Result<CompactMutationCapture, String>;
  ```

  두 mode 모두 IMMEDIATE transaction, 기존 operation,
  `history::finalize_transaction`, commit을 한 번만 수행한다. Full mode만
  operation이 반환한 capture를 버리고 transaction 안에서
  `load_workspace`를 호출한다. Compact mode는 같은 capture와 audit
  changed IDs와 affected parent/order domain을 사용해 필요한 committed
  rows와 anchors만 query한다.

- [ ] **Step 5: anchored insertion/rebalance capture 구현**

  Split은 source의 authoritative current parent와 sort order를 mutation
  전에 capture한다. Commit 결과에서 source/new node와 rebalance audit의
  `before_json IS NOT after_json`인 모든 touched node를 query한다. 이는
  sortKey가 같아도 UPDATE로 updatedAt이 바뀐 sibling을 포함한다. Splice는
  returned backend base의 exact
  parent/index, expected removed IDs, inserted ID, before/after neighbor를
  가진다. Dispatch-time parent는 operation recovery identity로 사용하지
  않는다. Available gap insertion은 sibling 전체를 result에 넣지 않는다.

  Compact shape만 부적격이지만 legacy operation은 유효한
  attachment-bearing active text source면 mutation 전에 Full mode를
  선택한다. Legacy operation 자체가 금지하는 image/inactive/missing
  source는 transaction 안의 기존 validation을 실행하고 rollback을 확인한
  뒤 typed `rejected/notCommitted/precommit`으로 반환하며 full mutation이나
  workspace load를 실행하지 않는다.
  Eligibility는 통과했지만 commit 결과 capture가 모든 membership/order
  변화를 완전하게 표현하지 못하면 mutation을 재실행하지 않는다. 같은
  connection guard를 유지한 채 committed Active workspace를 한 번 읽어
  `kind: "full"`을 만들고, 이미 얻은 token/history/receipt와 함께
  반환한다.

- [ ] **Step 6: under-lock eligibility와 response freeze 구현**

  `notes_split_node_compact_inner`는 기존 mutation runners처럼
  `AttachmentStorageLease`를 먼저 획득하고 connection guard를 한 번 잡아
  다음 순서를 지킨다.

  ```text
  validate identity/history context
  read base token
  inspect authoritative source kind/active-state/attachment eligibility
  choose compact or full materialization
  execute split transaction once
  validate connection identity after commit
  reconcile pruned attachment cleanup candidates once
  validate connection identity again
  read committed token and exact history receipt/state
  build owned full or delta result
  release connection guard
  ```

  Client token은 입력에 없다. Eligibility가 바뀌어도 client resend를 요구하지 않는다.
  Commit 뒤 validation/reconciliation/response build 오류는 typed
  `notCommitted`로 낮추지 않고 outer error로 반환해 frontend가
  `outcomeUnknown`으로 복구한다.

- [ ] **Step 7: command 등록**

  `notes_split_node_compact` wrapper를 `commands.rs`, `lib.rs` invoke
  handler, `build.rs` `APP_COMMANDS`,
  `permissions/main-window.toml`의
  `allow-notes-split-node-compact`에 각각 한 번 등록한다.

  Run:

  ```bash
  cargo build --manifest-path src-tauri/Cargo.toml
  ```

  Expected: `notes_split_node_compact.toml`과 세 generated schema가
  갱신된다.

- [ ] **Step 8: GREEN**

  Run:

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests::compact_split
  cargo test --manifest-path src-tauri/Cargo.toml notes::performance::compact_split_payload
  cargo test --manifest-path src-tauri/Cargo.toml notes::history
  cargo test --manifest-path src-tauri/Cargo.toml application_manifest_covers_every_registered_command_exactly_once
  cargo test --manifest-path src-tauri/Cargo.toml application_commands_are_granted_only_to_local_main_window
  cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
  ```

  Expected: delta/full parity, single mutation, payload scaling, history tests PASS.

- [ ] **Step 9: 커밋**

  ```bash
  git add src-tauri/src/notes/authority.rs src-tauri/src/notes/history.rs src-tauri/src/notes/repository.rs src-tauri/src/notes/commands.rs src-tauri/src/lib.rs src-tauri/src/notes/performance.rs src-tauri/build.rs src-tauri/permissions/main-window.toml src-tauri/permissions/autogenerated/notes_split_node_compact.toml src-tauri/gen/schemas/acl-manifests.json src-tauri/gen/schemas/desktop-schema.json src-tauri/gen/schemas/macOS-schema.json
  git commit -m "feat(notes): return compact split authority"
  ```

---

### Task 9: Compact split을 coordinator와 Phase A Enter settlement에 연결

**Files:**

- Modify: `src/features/notes/notesCommands.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Modify: `src/features/notes/notesCompactMutationAuthority.ts`
- Modify: `src/features/notes/notesCompactMutationAuthority.test.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Modify: `src/features/notes/useNotesHistoryController.ts`
- Modify: `src/features/notes/useNotesWorkspace.operations.test.tsx`
- Modify: `src/features/notes/useNotesWorkspace.sharedSession.test.tsx`
- Modify: `src/features/notes/notesEnterCriticalPath.test.tsx`

**Interfaces:**

- Consumes: optional `NotesStore.splitNodeCompact`, Task 5 validation gates,
  Task 7 recovery/breaker, shared Active authority, and Phase A pending
  insertion.
- Produces: queue-head `settleCompactMutation()` for split, Active/All route
  selection, required all-command local-history lease, typed mutation
  settlement, atomic authority/history/projection publication, and Enter
  settlement.

- [ ] **Step 1: split settlement 실패 테스트 작성**

  다음 frontend paths를 고정한다.

  - Active/All + capability + enabled breaker는 compact IPC 한 번, legacy split 0.
  - filtered view, missing capability, disabled breaker는 legacy full path.
  - token null이면 versioned load 후 compact dispatch.
  - valid identity + exact base/delta는 direct Map patch, full normalization/reconstruction 0.
  - valid identity + base mismatch는 compact mutation retry 0, recovery load 1, breaker 유지.
  - valid identity + invalid delta는 recovery load 1, split breaker disable.
  - valid identity/token delta가 expected split과 unrelated extra footprint를
    함께 보내거나, delta/full candidate가 expected split postcondition을
    만족하지 않으면 publication 0, recovery load 1, split breaker disable.
  - full fallback이 expected split과 command 전 concurrent unrelated state를
    함께 담으면 postcondition만 검증해 정상 수용.
  - identity failure는 outcomeUnknown recovery이며 compact history를 수용하지 않음.
  - typed precommit/staleHistoryEpoch/authorityRefreshRequired는 settlement의
    exact rejection reason을 보존. Precommit reload 0, stale/refresh
    versioned reload 1, 세 branch 모두 structural mutation replay/focus 0.
  - backend full fallback은 바로 authority/history를 수용하고 compact mutation을 재전송하지 않음.
  - backend full fallback의 malformed/non-advancing token은 바로 수용하지
    않고 knownCommittedMismatch reload 뒤 split breaker disable.
  - expected preallocated split ID가 current이고 interaction epoch가 같을 때만 target focus.
  - clean split direct success 직후 local `canUndo()` true, Undo가 source/new
    row와 focus snapshot을 복원하고 Redo가 같은 exact ID를 재적용.
  - split local-history finalizer false면 authority/history/presentation
    publish 0, knownCommittedMismatch recovery 1, breaker 유지.
  - request expectation, lease expectation, supplied `historyContext`의
    session/epoch/entry가 하나라도 다르면 IPC 0.
  - deferred compact IPC 중 Vault/session generation dispose 후 old success가
    도착하면 old lease finalize/recovery/authority/history/focus publish 0;
    new generation initialization은 old queue turn 종료 뒤 versioned load
    1로 committed DB state를 관찰.

- [ ] **Step 2: RED 확인**

  Run:

  ```bash
  npm test -- src/features/notes/notesCompactMutationAuthority.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx src/features/notes/notesEnterCriticalPath.test.tsx
  ```

  Expected: split command가 legacy full path를 사용해 FAIL.

- [ ] **Step 3: coordinator `runCompactMutation` 구현**

  ```ts
  interface NotesCompactMutationRequestBase {
    readonly sessionId: string;
    readonly coordinatorGeneration: number;
    readonly invoke: () => Promise<NotesCompactCommandResult>;
    readonly localHistoryLease: NotesLocalHistoryReconciliationLease;
  }

  export type NotesCompactMutationRequest =
    | (NotesCompactMutationRequestBase & {
        readonly kind: "split";
        readonly historyExpectation: NotesStructuralHistoryExpectation;
        readonly postcondition: Extract<
          NotesMutationPostcondition,
          { kind: "split" }
        >;
        readonly insertion?: PendingKeyboardInsertion;
      })
    | (NotesCompactMutationRequestBase & {
        readonly kind: "first-child";
        readonly historyExpectation: NotesStructuralHistoryExpectation;
        readonly postcondition: Extract<
          NotesMutationPostcondition,
          { kind: "first-child" }
        >;
        readonly insertion?: PendingKeyboardInsertion;
      })
    | (NotesCompactMutationRequestBase & {
        readonly kind: "text-update";
        readonly historyExpectation: NotesTextHistoryExpectation;
        readonly postcondition: Extract<
          NotesMutationPostcondition,
          { kind: "text-update" }
        >;
        readonly insertion?: never;
      });

  export type NotesCompactMutationCommitDisposition =
    | "committedAndCurrent"
    | "committedButSuperseded"
    | "notCommitted"
    | "notProvenCommitted"
    | "indeterminate"
    | "recoveryBlocked";

  export type NotesCompactMutationSettlement =
    | {
        readonly queueResult: NotesWorkspaceQueueResult;
        readonly commitDisposition: "notCommitted";
        readonly rejectionReason:
          | "precommit"
          | "staleHistoryEpoch"
          | "authorityRefreshRequired";
        readonly historyReceiptKind?: never;
      }
    | {
        readonly queueResult: NotesWorkspaceQueueResult;
        readonly commitDisposition: Exclude<
          NotesCompactMutationCommitDisposition,
          "notCommitted"
        >;
        readonly rejectionReason?: never;
        readonly historyReceiptKind?: "recorded" | "coalescedAway";
      };

  export function settleCompactMutation(input: {
    readonly request: NotesCompactMutationRequest;
    readonly context: NotesWorkspaceQueueContext;
    readonly historyContext: NotesHistoryContext;
    readonly record: NotesWorkspaceSessionRecord;
  }): Promise<NotesCompactMutationSettlement>;
  ```

  이 함수는 이미 실행 중인 structural 또는 draft queue head의 work
  callback 전용이다. Coordinator `enqueue`/`enqueueStructural`을 내부에서
  다시 호출하지 않으며, public command outcome으로 변환하지 않는다.
  Public split/createChild command와 draft text callback은 기존
  structural/draft queue를 정확히 한 번 호출하고 그 callback에서
  `settleCompactMutation()`을 호출한다. Structural wrapper는
  `queueResult`를 반환하고 Task 11 draft wrapper는 typed
  `commitDisposition`을 보존한다. 이 layering을 queue test에서 nested
  enqueue 0과 following command deadlock 0으로 고정한다.

  순서는 request/record/lease coordinator generation, lease active,
  request history expectation, lease expectation, `historyContext`
  session/epoch/entry exact equality를 포함한 dispatch invariant → invoke →
  generation/lease-active 재검사 → typed rejected 처리 → operation
  identity gate → token/delta 또는 full candidate workspace gate →
  delta-only exact footprint gate →
  `validateNotesMutationPostcondition(candidate, input.postcondition)` →
  generation/lease-active 마지막 재검사 →
  all-command `localHistoryLease.finalizeDirect(candidate/history/receipt)` →
  atomic authority/history publication이다. Split/first-child/text 모두
  candidate snapshot을 대상으로 local history projection을 먼저 전부
  검증하고 성공 때만 commit한다. False이면 compact envelope의
  token/history/authority/
  presentation을 하나도 publish하지 않고 identity-proven
  `knownCommittedMismatch`/keepEnabled recovery로 간다. 이때 compact
  receipt/history/token/delta는 버리고 same lease와 full history
  expectation만 recovery record로 transfer한다. Accepted finalizer의 unreachable IDs도 authority
  transition이 성공한 뒤에만 cleanup queue에 넣는다. Settlement가 반환된
  뒤 별도 receipt acceptance를 수행하는 경로는 금지한다.
  Direct publication 성공은 transition 뒤 reconciliation lease를 release한다.
  Typed precommit/request invariant failure는 structural pending entry를
  discard하고, text는 `"history-reconciliation"` pin을 소유한
  reconciliation lease만 release하되 Task 11의 별도
  `"draft-attempt"` pin/provenance를 유지한다. Known
  mismatch/outcomeUnknown/recoveryBlocked는 release하지 않고 Task 7 record로
  ownership을 transfer한다.
  Invoke 이후 어느 guard에서든 generation이 달라졌거나 lease가 disposed면
  old response를 stale로 settle하고 authority/history/focus/recovery/breaker
  mutation을 전혀 만들지 않는다. Same-Vault new generation initialization
  barrier는 outstanding old queue turn이 끝나기 전에 authority-ready가 되지
  않으며, 그 뒤 자체 versioned load로 committed database state를 관찰한다.
  Known mismatch/outcomeUnknown은 Task 7
  recovery로 위임한다. Footprint/postcondition mismatch는
  `knownCommittedMismatch`이며 compact envelope 전체를 버리고 reload한
  뒤 해당 command breaker를 disable한다.
  Direct valid delta/full은 `committedAndCurrent`다. Typed rejection은
  `notCommitted`와 exact `rejectionReason`을 함께 보존한다. `precommit`은
  reload 없이 끝나고, `staleHistoryEpoch`/`authorityRefreshRequired`는
  mutation replay 없이 versioned Active reload를 완료한 뒤 rejected
  command/UI intent를 종료한다. Recovery는 Task 7 classifier의 exact outcome을
  `commitDisposition`에 보존하고 hard recovery failure는
  `recoveryBlocked`로 반환한다. 따라서 queue result의 broad
  `authoritative`/`scopeAgnostic` shape가 draft barrier 판정을 대신하지
  않는다.
  Discriminated union 때문에 command kind와 postcondition kind가
  compile-time으로 결합되고 text update에 insertion을 cast로 전달할 수
  없다. Task 10/11은 이 same union의 existing branches를 그대로 enable한다.

  `kind: "full"`도 workspace gate를 생략하지 않는다. Dispatch 때의
  Active token을 `expectedDifferentFrom`으로 공통 token validator에
  전달하고, 통과한 뒤에만 full workspace/history/token을 함께 수용한다.

- [ ] **Step 4: split route enable**

  `notesCommands.ts`는 queue item에 동결된
  `context.sourceScope.kind === "active"`와
  `context.sourceLibraryView === "all"`에서만 compact split을 선택한다.
  Callback 실행 시점의 mutable pane/view ref는 다시 읽지 않는다.
  Existing `runStructuralCommand("split", work, options)` 안에서 받은 queue
  context/history owner를
  `settleCompactMutation()`에 전달하고, history context와 preallocated
  `newNodeId`를 그대로 보내며 caller token은 보내지 않는다.
  `useNotesHistoryController`는 same owner/context와 candidate workspace에서
  focus/selection/expansion을 순수 계산하는 builder를
  `NotesLocalHistoryReconciliationLease`로 감싼다. Direct path는 기존
  `acceptMutationResult(entryId, after, state)`를 lease 안에서 호출하고,
  recovery path도 같은 owner/builder/expectation을 재사용한다.

  Valid delta 수용 뒤 Phase A `KeyboardInsertionSettlement`을 발행한다. Recovery가 current지만 UI epoch가 stale하면 zero-motion settlement만 발행하고 focus는 false로 둔다.

  Direct full/delta 수용은 shared Active authority와 모든 open Active/All
  session projections/presentations를 한 atomic coordinator transition에서
  교체한다. Origin의 기존 coordinator history session state만 result
  history로 갱신하고, 같은 Vault의 두 window 모두 동일 notification
  batch에서 새 node를 관찰한다.

- [ ] **Step 5: tag summary invalidation 유지**

  Source prefix/new suffix가 tag를 바꿀 수 있으므로 기존 full split과 같은 tag-summary refresh를 한 번 schedule한다. Refresh는 authority transition과 별도이며 compact settle을 block하지 않는다.

- [ ] **Step 6: GREEN**

  Run:

  ```bash
  npm test -- src/features/notes/notesCompactMutationAuthority.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx src/features/notes/notesEnterCriticalPath.test.tsx
  npm run test:architecture
  ```

  Expected: eligible split direct delta, fallback/recovery zero replay, Enter focus/motion 계약 PASS.

- [ ] **Step 7: 커밋**

  ```bash
  git add src/features/notes/notesCommands.ts src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesCompactMutationAuthority.ts src/features/notes/notesCompactMutationAuthority.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesHistoryController.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx src/features/notes/notesEnterCriticalPath.test.tsx
  git commit -m "feat(notes): enable compact text split"
  ```

---

### Task 10: Compact first-child backend와 frontend enable

**Files:**

- Modify: `src-tauri/src/notes/authority.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/notes/performance.rs`
- Modify: `src/features/notes/notesCommands.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Modify: `src/features/notes/notesCompactMutationAuthority.ts`
- Modify: `src/features/notes/notesCompactMutationAuthority.test.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Modify: `src/features/notes/useNotesWorkspace.operations.test.tsx`
- Modify: `src/features/notes/notesEnterCriticalPath.test.tsx`
- Modify: `src-tauri/build.rs`
- Modify: `src-tauri/permissions/main-window.toml`
- Create: `src-tauri/permissions/autogenerated/notes_create_first_child_compact.toml`
- Modify: `src-tauri/gen/schemas/acl-manifests.json`
- Modify: `src-tauri/gen/schemas/desktop-schema.json`
- Modify: `src-tauri/gen/schemas/macOS-schema.json`

**Interfaces:**

- Consumes: Task 8 compact core, preallocated first-child ID, Task 9 frontend
  coordinator flow, and Tauri registration.
- Produces: `notes_create_first_child_compact`, its permission/schema entries,
  payload benchmark, and first-child compact route.

- [ ] **Step 1: backend first-child 실패 테스트 작성**

  - parent가 active text node이고 insertion이 attachment-free일 때 compact delta.
  - frontend `newNodeId`를 그대로 사용.
  - authoritative first child 앞에 anchored splice 하나.
  - no child면 index 0, before/after null.
  - concurrent child/order 변화는 connection lock 안의 현재 order 기준.
  - dispatch 때 old first child가 A였어도 다른 session이 X를 먼저 넣고
    command가 N을 lock 시점 index 0에 commit하면 `[N, X, A]`를 current
    first-child로 인정; `expectedBeforeId: A` 같은 stale identity는 사용하지
    않음.
  - active image parent 또는 attachment-bearing active text parent는 기존
    create semantics가 유효하므로 same-call full success, mutation 1회.
  - archived/deleted/missing parent, duplicate ID, invalid placement/depth는
    기존 create semantics 그대로 rollback-proven
    `rejected/notCommitted/precommit`, mutation 0.
  - compact delta는 mutator 1회/full load 0회, Full fallback은 mutator
    1회/full load 1회.
  - base token은 mutation 직전, workspace token은 commit 직후 값이며
    receipt는 exact caller entry ID의 recorded, returned
    `nextUndoEntryId`도 그 ID.
  - 1,000/10,000 fixture payload 차이 10% 이하.

- [ ] **Step 2: frontend first-child 실패 테스트 작성**

  다음 `first-child` frontend 계약을 고정한다.

  - frozen Active/All origin + capability + enabled child breaker는 compact
    IPC 1, legacy create 0.
  - valid identity/token/delta 또는 valid same-call Full은 exact preallocated
    ID를 한 atomic authority/history transition으로 publish.
  - base mismatch는 mutation retry 0 + reload 1 + child breaker 유지.
  - invalid token/delta/postcondition은 reload 뒤 child breaker만 disable하고
    split breaker는 enabled 유지.
  - pane/insertion/interaction epoch가 current일 때만 exact child ID focus;
    stale이면 authority만 수용하고 focus 0.
  - Direct success 직후 local `canUndo()`가 true이고 Undo/Redo가 parent
    expansion/focus/selection snapshot과 exact child ID를 왕복.
  - Required local-history lease가 false를 반환하면 publication 0 +
    knownCommittedMismatch recovery 1.

- [ ] **Step 3: RED 확인**

  Run:

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests::compact_first_child
  npm test -- src/features/notes/notesCompactMutationAuthority.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/notesEnterCriticalPath.test.tsx
  ```

  Expected: first-child compact command가 없어 FAIL.

- [ ] **Step 4: backend command 구현/등록**

  `notes_create_first_child_compact`는 다음 exact shared transaction
  boundary를 호출한다.

  ```rust
  with_workspace_transaction_materialized(
      &mut connection,
      &history_context,
      materialization,
      |transaction| capture_first_child_mutation(transaction, &input, today),
  )
  ```

  Input의
  `parentId`와 preallocated `id`는 유지하되 lock 안의 authoritative
  current order에서 새 node가 index 0이 되도록 placement/anchors를
  계산한다. Recovery postcondition은 expected node의 parent/index
  0/empty content이며 dispatch 당시 old neighbor를 포함하지 않는다.
  Active image,
  attachment-bearing active text, compact capture로 표현할 수 없는 유효
  placement는 mutation을 재호출하지 않고 full materialization을
  선택한다. Inactive/missing parent, duplicate ID, invalid depth/placement는
  기존 transaction을 rollback한 뒤 typed precommit rejection을 반환한다.

  Command를 `lib.rs`, `build.rs` `APP_COMMANDS`,
  `permissions/main-window.toml`의
  `allow-notes-create-first-child-compact`에 등록하고 다음을 실행한다.

  ```bash
  cargo build --manifest-path src-tauri/Cargo.toml
  ```

  Expected: command permission TOML과 세 generated schema가 갱신된다.

- [ ] **Step 5: frontend route enable**

  Active/All + capability + command breaker enabled일 때 `createFirstChildCompact`를 호출한다. Coordinator가 valid delta/full/recovery를 처리하며 Phase A insertion token과 exact ID를 유지한다.
  Existing `runStructuralCommand("create", work, options)`의 work callback이
  Task 9 union의 `kind: "first-child"` request로
  same history owner/after-snapshot builder의 required
  `NotesLocalHistoryReconciliationLease`와 함께
  `settleCompactMutation()`을 호출한다. Nested enqueue나 cast는 없다.

  Frontend route는 enqueue 때 `NotesWorkspaceQueueContext`에 동결한
  `sourceScope.kind === "active"` + `sourceLibraryView === "all"` origin,
  capability, command breaker만 본다. Parent kind/attachment eligibility는
  stale할 수 있으므로 frontend에서 분기하지 않는다. Active/All origin이면
  attachment-bearing parent도 compact wrapper를 호출하고 backend가
  connection lock 안의 current row로 same-call Full mode를 선택한다.
  Starred/Recent/Tags/Archive/Trash origin, missing capability, disabled breaker만
  기존 full method를 한 번 호출한다. View/scope는 compact backend request에
  추가하지 않는다.

- [ ] **Step 6: GREEN**

  Run:

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests::compact_first_child
  cargo test --manifest-path src-tauri/Cargo.toml notes::performance::compact_first_child_payload
  cargo test --manifest-path src-tauri/Cargo.toml application_manifest_covers_every_registered_command_exactly_once
  cargo test --manifest-path src-tauri/Cargo.toml application_commands_are_granted_only_to_local_main_window
  npm test -- src/features/notes/notesCompactMutationAuthority.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/notesEnterCriticalPath.test.tsx
  ```

  Expected: compact first-child parity/payload/focus test PASS.

- [ ] **Step 7: 커밋**

  ```bash
  git add src-tauri/src/notes/authority.rs src-tauri/src/notes/repository.rs src-tauri/src/notes/commands.rs src-tauri/src/lib.rs src-tauri/src/notes/performance.rs src-tauri/build.rs src-tauri/permissions/main-window.toml src-tauri/permissions/autogenerated/notes_create_first_child_compact.toml src-tauri/gen/schemas/acl-manifests.json src-tauri/gen/schemas/desktop-schema.json src-tauri/gen/schemas/macOS-schema.json src/features/notes/notesCommands.ts src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesCompactMutationAuthority.ts src/features/notes/notesCompactMutationAuthority.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/notesEnterCriticalPath.test.tsx
  git commit -m "feat(notes): enable compact first child"
  ```

---

### Task 11: Compact attachment-free text update와 dirty Enter history barrier

**Files:**

- Modify: `src-tauri/src/notes/authority.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/notes/history.rs`
- Modify: `src-tauri/src/notes/performance.rs`
- Modify: `src/features/notes/notesCommands.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Modify: `src/features/notes/notesCompactMutationAuthority.ts`
- Modify: `src/features/notes/notesAuthorityRecovery.ts`
- Modify: `src/features/notes/notesDraftEngine.ts`
- Modify: `src/features/notes/notesDraftEngine.test.ts`
- Modify: `src/features/notes/notesHistory.ts`
- Modify: `src/features/notes/notesHistory.test.ts`
- Modify: `src/features/notes/useNotesHistoryController.ts`
- Modify: `src/features/notes/useNotesDraftWorkflow.ts`
- Modify: `src/features/notes/useNotesWorkspace.operations.test.tsx`
- Modify: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Modify: `src/features/notes/notesEnterCriticalPath.test.tsx`
- Modify: `src-tauri/build.rs`
- Modify: `src-tauri/permissions/main-window.toml`
- Create: `src-tauri/permissions/autogenerated/notes_update_node_compact.toml`
- Modify: `src-tauri/gen/schemas/acl-manifests.json`
- Modify: `src-tauri/gen/schemas/desktop-schema.json`
- Modify: `src-tauri/gen/schemas/macOS-schema.json`

**Interfaces:**

- Consumes: Task 8 compact core, Task 9 specialized text expectation/typed
  settlement, text coalescing history, draft attempts, dirty Enter barrier,
  Task 7 recovery, and Tauri registration.
- Produces: `notes_update_node_compact`,
  `captureTextMutationDispatchEvidence()`,
  `acceptCompactMutationResult()`, `NotesDraftPersistenceResult`,
  receipt-aware draft persistence, and the dirty text→structure barrier.

- [ ] **Step 1: backend text update/coalescing 실패 테스트 작성**

  - attachment-free active text update는 one-node upsert, order splice 0, full load 0.
  - attachment-bearing active text 또는 active image update는 기존 update
    semantics가 유효하므로 same-call full success, mutation 1회.
  - archived/deleted/missing node나 invalid image offset/input은 기존
    update semantics 그대로 rollback-proven
    `rejected/notCommitted/precommit`, mutation 0.
  - ordinary update receipt는 recorded.
  - reused entry `X → Y → X`는 두 저장의 `updatedAt`이 명시적으로
    달라도 coalescedAway와 predecessor nextUndo.
  - text audit semantic net-zero는 `notes_nodes.updated_at`만 제외하고
    node의 다른 모든 field와 다른 audit table before/after가 exact-equal일
    때만 성립. `updatedAt` 외 field 하나라도 다르면 recorded 유지.
  - coalescedAway가 history row를 제거해도 DB node의 최신 `updatedAt`은
    되돌리지 않고 workspace token도 해당 committed write를 반영.
  - token은 dirty commit마다 한 번, net-zero transaction도 실제 node commit이 있었다면 한 번.
  - payload 1,000/10,000 fixture 차이 10% 이하.
  - frontend history session은 첫 `X → Y` dispatch 전에
    `entryWasAlreadyAppliedAtDispatch: false`, 같은 burst의 queued
    `Y → X` dispatch 직전에는 `true`를 산출.
  - `coalescedAway(E)` 수용 뒤 local timeline에서는 E가 사라지고
    cursor/next Undo가 burst 시작 때 동결한 predecessor P로 복귀하지만,
    open/pinned burst provenance는 `notApplied` tombstone으로 유지.
  - first dispatch → queued same-entry reuse → `X → Y → X` 전체에서
    expansion snapshot reference leak 0, 다음 structural entry의
    predecessor도 P.
  - `X → Y` recorded → `Y → X` coalescedAway가 running일 때 `X → Z`가
    같은 E로 queued되면 다음 queue-head evidence는 false이고 E가
    recorded로 다시 timeline에 들어감.
  - E가 previously recorded인 상태에서 재편집 후 dirty Enter가
    `closeTextBurst()`를 먼저 호출해도 pinned attempt의 queue-head
    evidence는 true이며, 마지막 attempt/structural intent settle 뒤 pending
    provenance와 snapshot reference가 0으로 정리됨.

- [ ] **Step 2: dirty Enter/history 실패 테스트 작성**

  - ordinary dirty split/first-child는 text recorded + structural recorded 두 entry.
  - 첫 Undo는 inserted row 제거, 둘째 Undo는 이전 text 복원, Redo는 같은 순서.
  - valid coalescedAway text flush 뒤 structural entry 하나만 남음.
  - text recovery가 committedAndCurrent일 때만 structural barrier 해제.
  - precommit/staleHistoryEpoch/authorityRefreshRequired/superseded/notProven/
    indeterminate/recoveryBlocked는 structural IPC 0.
  - precommit draft만 retryable timer 대상. Stale/refresh는 versioned reload
    1 뒤에도 timer resend 0, dispatched notProven/indeterminate도 timer
    resend 0 + explicit save/new edit 전 `manualRetryRequired`.
  - stale/refresh reload success는 old text context/pins를 모두 retire하고
    draft content만 historyContext null/manual 상태로 유지. Explicit save나
    새 edit는 returned current epoch에서 새 entry ID/context를 만들며 old
    entry를 재사용하지 않음.
  - reused already-applied ambiguous text는 manualRetryRequired이고 structure IPC 0.
  - direct recorded/coalescedAway와 recovered committedAndCurrent만
    draft barrier disposition이 `eligible`.
  - broad queue result가 `authoritative`이거나 failure가
    `scopeAgnostic`이어도 recovered superseded/indeterminate이면
    `flushDraftBarrier()` false, structural IPC 0.
  - valid backend receipt/token/delta라도 local receipt-aware finalizer가
    false면 authority/history/presentation publish 0, persisted revision
    advance 0, knownCommittedMismatch/keepEnabled recovery 1.
  - queue-head text evidence가 missing/epoch-mismatch면 compact와 legacy
    mutation 모두 0, predispatch refresh 1.
  - E가 현재 applied prefix에 없고 latest draft가 queue-head confirmed
    node와 semantic-equal이면 text IPC/history entry 0, pending provenance
    정리, barrier eligible, structural command만 실행.
  - 같은 semantic equality라도 evidence가 already-applied true이면
    frontend no-op으로 축약하지 않고 backend coalescing/receipt를 거침.
  - not-currently-applied E가 redo side에 있으면 no-write cleanup이 그
    timeline entry/snapshots/cursor/nextRedo를 변경하거나 release하지 않음;
    coalesced tombstone이면 pending-owned before만 마지막 pin과 함께 정리.
  - public `flushNodeDraft(): Promise<boolean>` compatibility는 유지하되
    내부 typed disposition을 boolean으로 축약하는 지점은 public boundary
    하나뿐.
  - compact text success가 tag-summary refresh를 schedule.

- [ ] **Step 3: RED 확인**

  Run:

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests::compact_text_update
  cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests::compact_dirty_enter
  npm test -- src/features/notes/notesHistory.test.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesEnterCriticalPath.test.tsx
  ```

  Expected: text update compact route와 receipt-aware barrier가 없어 FAIL.

- [ ] **Step 4: backend command 구현/등록**

  `notes_update_node_compact`는 다음 exact shared transaction boundary를
  호출해 active text node와
  attachment count 0을 lock 안에서 확인한다. Delta에는 committed node
  하나와 rebalance가 없으므로 order splice가 없다. Attachment-bearing
  active text와 active image는 same-call Full mode를 사용하고,
  inactive/missing/invalid input은 기존 validation transaction의 rollback
  뒤 typed precommit rejection으로 반환한다. Receipt/state/token을 guard
  release 전에 동결하고 command를 `lib.rs`에 등록한다.

  Existing `before_json IS after_json`만으로는 node audit JSON의
  `updated_at` 때문에 `X → Y → X`를 안정적으로 coalesce할 수 없다.
  `history.rs`에 text command 전용 semantic net-zero helper를 추가한다.
  `context.command_kind === "text"`인 `notes_nodes` audit row만 typed JSON으로
  decode해 `updated_at`을 제외한 모든 field를 exact 비교하고, 다른 table은
  기존 byte/SQL equality를 유지한다. Internal audit JSON decode 실패는
  empty history로 오인하지 않고 transaction error로 rollback한다.
  Entry의 모든 audit row가 이 기준으로 net-zero일 때만 history change와
  entry를 삭제하고 `coalescedAway` receipt/predecessor state를 만든다.
  이는 history metadata만 compact하며 current `notes_nodes.updated_at`이나
  token row를 rewrite하지 않는다.

  Rust unit test는 sleep/same-millisecond 우연을 사용하지 않는다. Before와
  after JSON에 서로 다른 고정 `updated_at`을 주입해 semantic net-zero를
  증명하고, 각 non-timestamp field를 하나씩 바꾼 table-driven case가
  coalesce되지 않는지 검증한다. Command integration test는 returned node의
  latest `updatedAt`, advanced token, `coalescedAway` receipt, predecessor
  `nextUndoEntryId`를 함께 단정한다.

  ```rust
  with_workspace_transaction_materialized(
      &mut connection,
      &history_context,
      materialization,
      |transaction| capture_text_update_mutation(transaction, &input, today),
  )
  ```

  `build.rs` `APP_COMMANDS`, `permissions/main-window.toml`의
  `allow-notes-update-node-compact`도 함께 등록하고 다음을 실행한다.

  ```bash
  cargo build --manifest-path src-tauri/Cargo.toml
  ```

  Expected: command permission TOML과 세 generated schema가 갱신된다.

- [ ] **Step 5: text burst provenance와 receipt-aware local history 구현**

  `PendingMutation`에 새 text burst를 만들 때의 predecessor를 한 번만
  저장한다. 값은 `beginTextBurst()` 시점 applied prefix에서
  `nearestMutationIds(timeline, cursor).undo`로 계산하며 같은 node/field
  burst가 queued save에서 재사용돼도 다시 계산하지 않는다.

  ```ts
  export interface NotesTextMutationDispatchEvidence {
    readonly historyEpoch: string;
    readonly requestedEntryId: string;
    readonly predecessorUndoEntryId: string | null;
    readonly entryWasAlreadyAppliedAtDispatch: boolean;
  }

  export interface NotesCompactHistoryAcceptanceInput {
    readonly entryId: string;
    readonly after: NotesHistorySnapshot;
    readonly state: NotesHistoryState;
    readonly receipt: Exclude<NotesMutationHistoryReceipt, { kind: "none" }>;
    readonly dispatchEvidence: NotesTextMutationDispatchEvidence;
  }

  export type NotesTextMutationPinOwner =
    | "draft-attempt"
    | "structural-intent"
    | "history-reconciliation";

  export interface NotesTextMutationPin {
    readonly owner: NotesTextMutationPinOwner;
    release(): void;
  }

  interface NotesHistorySession {
    pinTextMutation(
      entryId: string,
      owner: NotesTextMutationPinOwner
    ): NotesTextMutationPin | null;
    captureTextMutationDispatchEvidence(
      entryId: string
    ): NotesTextMutationDispatchEvidence | null;
    acceptCompactMutationResult(
      input: NotesCompactHistoryAcceptanceInput
    ): { accepted: boolean; unreachableEntryIds: readonly string[] };
  }
  ```

  Pending text state는 boolean `committed` 대신
  `applicationState: "notApplied" | "applied"`, burst 생성 때의 immutable
  `predecessorUndoEntryId`, idempotent lease count를 가진다. Open text burst도
  provenance owner다. `pinTextMutation()`의 호출마다 refcount를 1 올리는
  서로 다른 idempotent handle을 반환한다. 각 immutable
  `DraftWriteAttempt`는 context 캡처 때 `"draft-attempt"` pin 하나를 얻어
  terminal settle/cancel/dedup에서 그 handle만 release한다.
  `captureDraftCutoff()`은 structural intent가 참조할 각 context에
  `"structural-intent"` pin을 먼저 얻은 뒤 burst를 닫고, intent
  complete/cancel 때 그 handle만 release한다.
  `NotesLocalHistoryReconciliationLease` 생성은 별도의
  `"history-reconciliation"` pin을 새로 획득하며 attempt/intent handle과
  공유하거나 alias하지 않는다. 따라서 `closeTextBurst()`는 keyboard
  reuse만 끝내며 pin된 provenance를 삭제하지 않는다.

  `captureTextMutationDispatchEvidence()`는 side effect 없이 현재 epoch/entry를
  검증하고, `entryWasAlreadyAppliedAtDispatch`를 단순 `committed` flag가
  아니라 E가 현재 applied timeline prefix에 실제로 존재하는지로
  동기 계산한다. `useNotesDraftWorkflow.persistDraftMutation()`의 queue-head
  callback은 compact IPC를 호출하기 **직전** 이 evidence를 캡처한다.
  예약/타이머 생성 때 미리 캡처하지 않는다. Evidence가 없거나
  history context와 epoch/entry가 다르면 compact/legacy mutation을 모두
  보내지 않고 local predispatch history failure로 authority/history
  refresh를 요청한다. Identity evidence가 없는 상태를 legacy write로
  우회하지 않는다.

  Task 9 `NotesTextHistoryExpectation`은 이 evidence에
  `allowCoalescedAway: true`를 더한 exact text branch다. Structural branch는
  `allowCoalescedAway: false`이고
  `entryWasAlreadyAppliedAtDispatch` field를 가질 수 없다.

  `acceptCompactMutationResult()`의 `recorded` branch는 기존
  `acceptMutationResult()` projection/state coherence를 그대로 재사용한다.
  `coalescedAway`는 다음을 모두 만족할 때만 수용한다.

  - receipt requested ID, pending text E, dispatch evidence의 epoch/ID가 일치.
  - dispatch evidence가 `entryWasAlreadyAppliedAtDispatch: true`.
  - pending E에 burst 생성 때 동결한 predecessor와 evidence가 일치.
  - E가 applied prefix에 정확히 한 번 존재.
  - E를 제거하고 backend `prunedEntryIds`를 적용한 projected
    timeline/cursor가 returned `nextUndoEntryId === predecessor`를 포함해
    full `stateMatches()`를 통과.

  성공하면 E를 local timeline/accepted-state에서 제거하고 cursor를
  predecessor 다음 위치로 옮긴다. E의 old `after`와 이번 candidate
  `after` snapshot은 release하지만 최초 `before`와 predecessor/context는
  pending tombstone에 유지하고 `applicationState`를 `notApplied`로
  바꾼다. Open burst 또는 lease가 남아 있으면 같은 E를 재사용하며, 이후
  recorded receipt는 최초 before를 사용해 E를 timeline에 다시 넣고
  `applied`로 전환한다. Open burst와 lease가 모두 0이면 applied metadata는
  timeline ownership만 남기고 pending에서 지우며, notApplied tombstone은
  before snapshot을 release한 뒤 지운다. `discard/reset`도 같은 ownership
  규칙을 따른다. 하나라도 어긋나면 local history를 변경하지 않고
  acceptance false로 Task 7 recovery를 시작한다.

  `notesHistory.test.ts`는
  `P → E(X→Y) → queued E(Y→X) → queued E(X→Z)`, dirty Enter가 burst를
  먼저 닫는 경우, 마지막 lease release까지를 fake snapshot pool로
  검증한다. 어느 중간 상태에서도 before를 double-release하지 않고 최종
  reference count가 0이어야 한다.

- [ ] **Step 6: draft save route와 typed dirty Enter barrier 연결**

  Active/All에서 eligible draft save는 `updateNodeCompact`를 사용한다.
  Existing queued draft work callback이 Task 9 union의
  `kind: "text-update"` request로 `settleCompactMutation()`을 직접 호출한다.
  단, queue-head evidence가
  `entryWasAlreadyAppliedAtDispatch: false`이고 draft의 title/note/
  imageOffset/marker/markdownWidth가 `context.confirmedState` target과
  semantic-equal이면 not-currently-applied/already-current local no-op이다.
  이 경우 repository IPC를 호출하지 않고 pending provenance/lease를
  ownership에 맞게 정리하며 persisted revision을 advance하고 barrier를
  `eligible`로 만든다. E가 redo side에 있으면 timeline entry, before/after,
  cursor, `nextRedoEntryId`는 그대로 두고 pending pin만 release한다.
  Coalesced tombstone이면 timeline owner가 없으므로 마지막 pin과 함께
  pending-owned before를 release한다. `updatedAt`은 비교나 mutation 이유가
  아니다. Currently-applied E는 이 fast path를 절대 사용하지 않아
  `X → Y → X`가 backend receipt로 정리되게 한다.

  Request의 required `localHistoryLease.finalizeDirect()`는 candidate
  workspace로 after snapshot을 순수 계산한 뒤, raw authoritative
  history/receipt와 queue-head dispatch evidence를
  `useNotesHistoryController`의 `acceptCompactMutationResult()`에 전달한다.
  Coordinator는 이 lease를 모든 identity/token/delta/postcondition
  validation 뒤, 어떤 authority/history publication보다 먼저 실행한다.
  `recorded`/`coalescedAway` identity와 local acceptance가 모두 성공한
  뒤에만 atomic publication과 persisted revision advance를 허용한다.
  Settlement 반환 뒤 receipt를 다시 accept하는 두 번째 경로는 만들지
  않는다. Compact delta는
  authority/presentation의 target record만 patch하고 tag-summary refresh를
  한 번 schedule한다. Text branch에는 `insertion` field가 없고 nested
  queue enqueue도 없다.

  ```ts
  export type NotesDraftBarrierDisposition =
    | { readonly kind: "eligible" }
    | {
        readonly kind: "blocked";
        readonly reason:
          | "committedButSuperseded"
          | "precommit"
          | "staleHistoryEpoch"
          | "authorityRefreshRequired"
          | "notProvenCommitted"
          | "indeterminate"
          | "recoveryBlocked";
        readonly retry: "none" | "automatic" | "manual" | "afterRecovery";
      };

  export interface NotesDraftPersistenceResult {
    readonly queueResult: NotesWorkspaceQueueResult;
    readonly barrier: NotesDraftBarrierDisposition;
  }
  ```

  `NotesDraftEngineHost.persistDraftMutation()`과
  `persistDraft() → settleDraftWrite() → flushDraftsThroughCutoff() →
  flushDraftBarrier()`는 이 type을 끝까지 보존한다. Direct
  recorded/coalescedAway success, not-currently-applied already-current local
  no-write, recovered `committedAndCurrent`만 `eligible`이다. Mapping은
  다음으로 고정한다.

  - `committedButSuperseded`: blocked/none; 저장은 완료됐지만 현재 Enter 취소.
  - typed `precommit`: blocked/automatic; backend가 mutation 0을
    증명했으므로 draft는 유지하되 현재 Enter는 재개하지 않음.
  - typed `staleHistoryEpoch`/`authorityRefreshRequired`: blocked/manual.
    Versioned Active reload 뒤에도 rejected draft/Enter intent를 종료하고
    timer 자동 재전송 0; old reconciliation/attempt/intent pins와 pending
    history context를 retire한다. Draft content는 historyContext 없는 manual
    상태로 남기고 새 edit 또는 explicit save가 current returned epoch에서
    새 text entry/context를 얻은 뒤에만 전송한다.
  - dispatched `notProvenCommitted`: blocked/manual. Commit 부재의 증거가
    아니므로 timer가 재전송하지 않고 새 edit 또는 explicit save만 허용.
  - `indeterminate`, 특히 reused already-applied text: blocked/manual 및
    `manualRetryRequired`.
  - `recoveryBlocked`: blocked/afterRecovery; authority unlock 전 timer pause.

  Text request의 `NotesLocalHistoryReconciliationLease`는 생성 시 별도
  `"history-reconciliation"` pin handle을 소유한다. Draft attempt의
  `"draft-attempt"` pin과 절대 같은 handle을 공유하지 않는다. Direct
  validation/acceptance가 끝나기 전이나 Task 7 recovery record로
  transfer된 동안에는 reconciliation pin을 release하지 않는다.
  RecoveryBlocked로 queue head/attempt가 terminal settle되면 attempt pin만
  release되어 refcount 1(reconciliation pin)이 남아야 한다. Explicit retry
  accept 또는 generation disposal이 reconciliation pin을 release해
  refcount 0으로 만든다.

  `coalescedAway` identity 뒤 invalid delta, outcomeUnknown + missing E,
  hard recovery failure→head removal→explicit retry success를 각각 test해
  reconcile success 전 structural barrier/write unlock 0, head removal 직후
  pin count 1, success/disposal 뒤 pin count 0, local `nextUndo`와 backend
  state exact match를 단정한다.

  기존 `result.kind === "authoritative"` 또는
  `failure.scopeAgnostic === true` 검사는 barrier eligibility에서 제거한다.
  Public `flushNodeDraft(): Promise<boolean>`만 `eligible`을 true로
  호환 변환한다. `flushDraftBarrier()`가 blocked를 하나라도 만나면 현재
  Enter sequence를 종료하고 preallocated insertion intent를 cancel하며,
  timer/caller/authority recovery가 structural mutation을 자동 재시도하지
  않는다.

  Route는 callback 시점의 `activeScopeRef.current`가 아니라 enqueue 때
  동결한 `context.sourceScope`와 `context.sourceLibraryView`를 사용한다.
  Active/All origin + capability + enabled text breaker면 frontend가 본
  node kind/attachment 상태와 무관하게 `updateNodeCompact`를 호출하고,
  backend가 connection lock 안의 current row로 Delta/Full을 선택한다.
  Starred/Recent/Tags/Archive/Trash origin, missing capability, disabled breaker만
  legacy full update를 한 번 호출한다. Scope/view는 compact request에
  추가하지 않는다. Legacy success는 기존 history acceptance가 성공했을
  때만 `eligible`로 mapping한다.

  Queue 대기 중 pane이 전환되는 두 TOCTOU case를 test로 고정한다.
  Filtered-origin draft는 callback 전에 Active/All로 이동해도 compact로
  승격되지 않고, Active/All-origin draft는 callback 전에 filtered view로
  이동해도 legacy로 강등되지 않는다. 두 경우 모두 enqueue origin route를
  한 번만 실행하고 mutable ref read는 0이다.

- [ ] **Step 7: GREEN**

  Run:

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests::compact_text_update
  cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests::compact_dirty_enter
  cargo test --manifest-path src-tauri/Cargo.toml notes::performance::compact_text_update_payload
  cargo test --manifest-path src-tauri/Cargo.toml application_manifest_covers_every_registered_command_exactly_once
  cargo test --manifest-path src-tauri/Cargo.toml application_commands_are_granted_only_to_local_main_window
  npm test -- src/features/notes/notesHistory.test.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesEnterCriticalPath.test.tsx
  ```

  Expected: text/coalescing/dirty Enter Undo barrier와 payload gate PASS.

- [ ] **Step 8: 커밋**

  ```bash
  git add src-tauri/src/notes/authority.rs src-tauri/src/notes/repository.rs src-tauri/src/notes/commands.rs src-tauri/src/lib.rs src-tauri/src/notes/history.rs src-tauri/src/notes/performance.rs src-tauri/build.rs src-tauri/permissions/main-window.toml src-tauri/permissions/autogenerated/notes_update_node_compact.toml src-tauri/gen/schemas/acl-manifests.json src-tauri/gen/schemas/desktop-schema.json src-tauri/gen/schemas/macOS-schema.json src/features/notes/notesCommands.ts src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesCompactMutationAuthority.ts src/features/notes/notesAuthorityRecovery.ts src/features/notes/notesDraftEngine.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/notesHistory.ts src/features/notes/notesHistory.test.ts src/features/notes/useNotesHistoryController.ts src/features/notes/useNotesDraftWorkflow.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesEnterCriticalPath.test.tsx
  git commit -m "feat(notes): enable compact text updates"
  ```

---

### Task 12: Token/parity/failure 통합 gate와 Phase B probe 완성

**Files:**

- Modify: `src-tauri/src/notes/connection.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/notes/history.rs`
- Modify: `src-tauri/src/notes/performance.rs`
- Modify: `src/features/notes/notesCompactMutationAuthority.test.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Modify: `src/features/notes/useNotesWorkspace.sharedSession.test.tsx`
- Modify: `src/features/notes/notesEnterCriticalPathProbe.ts`
- Modify: `src/features/notes/notesEnterCriticalPathProbe.test.ts`
- Modify: `src/features/notes/notesEnterCriticalPath.test.tsx`
- Modify: `scripts/summarizeNotesEnterProbe.mjs`
- Modify: `scripts/summarizeNotesEnterProbe.test.ts`

**Interfaces:**

- Consumes: all three enabled compact commands, Task 2 token producers,
  parity/recovery/breaker paths, and Phase A probe fixture/export/summary.
- Produces: expanded payload/fallback/recovery probe fields, full regression
  matrix, and a Phase B-aware strict summary command.

- [ ] **Step 1: Task 2의 모든 token producer 계약을 통합 회귀로 재실행**

  Node mutation, attachment mutation, sync merge, Undo, Redo 각각에서 successful dirty commit당 token이 정확히 한 번 바뀌는지 확인한다. Rollback은 token 불변, reconnect는 incarnation 변경이어야 한다.

  Legacy Undo/Redo/full mutation을 frontend가 수용하면 Active token이 null이 되고, 다음 compact mutation 전에 versioned load가 한 번 실행되는지도 확인한다.
  Producer hook 구현이나 최초 증명은 Task 2에 속한다. 여기서 실패하면
  Task 12에 우회 코드를 넣지 않고 Task 2 owning files/tests로 돌아간다.

- [ ] **Step 2: shared-session/parity/failure test matrix 완성**

  다음을 한 matrix로 실행한다.

  - split/first-child/text 각각 full(base)+delta와 fresh reload parity.
  - 1,000/10,000 payload 차이 10% 이하.
  - 10,000 root insertion의 anchored splice 한 개.
  - shared-session base mismatch의 reload 한 번과 mutation retry 0.
  - known commit 뒤 다른 session이 move/delete/Undo한 current/superseded 판정.
  - malformed token, invalid delta, parity mismatch가 해당 command breaker만 disable.
  - 정상 base mismatch는 breaker 유지.
  - filtered/attachment-bearing path는 full.
  - compact direct success는 full normalization/reconstruction 0.
  - recovery는 history entry를 새로 만들지 않음.
  - two-window shared coordinator history session과 reconnect epochMismatch
    reset/disclosure.

- [ ] **Step 3: generic Enter probe의 새 실패 테스트 작성**

  Phase A probe test와 통합 test에 intent별 `requestBytes`,
  `responseBytes`, `resultKind`, `fullFallbackCount`, `recoveryCount`
  assertion을 먼저 추가한다. Production build에서는 기록이 없어야 하고,
  terminal settle 뒤 모든 pending counter가 0이어야 한다.

  Instrumented bridge를 다음 read-only preparation으로 확장한다.

  ```ts
  prepareCompactAuthority(): Promise<{
    readonly workspaceTokenReady: true;
    readonly completeCapability: true;
    readonly fullFallbackCountAtStart: number;
    readonly recoveryCountAtStart: number;
  }>;
  ```

  Undo/full reset으로 token이 null이면 existing coordinator
  `ensureVersionedActiveAuthority`를 측정 구간 밖에서 한 번 실행한다.
  Mutation은 호출하지 않는다. Complete load+recovery+scenario command
  capability와 non-null token을 확인한 뒤에만 다음 `prepareNextRun()`을
  허용한다.

- [ ] **Step 4: RED 확인**

  Run:

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests::workspace_token_all_producers
  cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests::compact_cross_session_matrix
  npm test -- src/features/notes/notesEnterCriticalPathProbe.test.ts src/features/notes/notesEnterCriticalPath.test.tsx src/features/notes/notesWorkspaceCoordinator.test.ts
  ```

  Expected: 새 probe fields/counters assertion은 FAIL. Producer와
  cross-session matrix는 앞선 implementation으로 PASS해야 하며, 실패하면
  Task 12에서 우회 수정하지 말고 해당 owning Task로 돌아가 그 Task
  범위에서 수정·검증한다.

- [ ] **Step 5: probe와 통합 결함 수정**

  Phase A probe에 새 payload/fallback/recovery fields를 구현하고 terminal
  cleanup에 포함한다. `summarizeNotesEnterProbe.mjs --phase b`는 latency
  sample 세 scenario 각 50개와 backlog batch 20개를 Phase A와 같은
  schema로 검증하고, payload/fallback/recovery field 누락을 거부한다.
  새 mutation path나 compact scope는 추가하지 않는다.
  Test는 `prepareCompactAuthority()`가 token-null reset 뒤 versioned read
  한 번, mutation 0을 수행하고 keydown 전 완료되는지, token-ready면 IPC
  0인지 고정한다. 각 Phase B latency run의 armed fixture metadata에는
  `workspaceTokenReady: true`, `completeCapability: true`, start fallback/
  recovery counters 0이 들어가야 한다.

- [ ] **Step 6: 집중 GREEN gate 실행**

  Run:

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml notes::connection
  cargo test --manifest-path src-tauri/Cargo.toml notes::history
  cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests::compact
  cargo test --manifest-path src-tauri/Cargo.toml notes::performance::compact
  npm test -- src/services/notesStore.tauri.test.ts src/features/notes/notesAuthorityStore.test.ts src/features/notes/notesCompactMutationAuthority.test.ts src/features/notes/notesAuthorityRecovery.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx src/features/notes/notesEnterCriticalPathProbe.test.ts src/features/notes/notesEnterCriticalPath.test.tsx
  ```

  Expected: 모두 PASS.

- [ ] **Step 7: 전체 Phase B gate**

  ```bash
  npm test
  npm run lint
  npm run build
  npm run test:architecture
  cargo test --manifest-path src-tauri/Cargo.toml
  cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
  git diff --check
  ```

  Expected: 모두 PASS.

- [ ] **Step 8: 측정 소스 커밋**

  ```bash
  git add src-tauri/src/notes/connection.rs src-tauri/src/notes/commands.rs src-tauri/src/notes/history.rs src-tauri/src/notes/performance.rs src/features/notes/notesCompactMutationAuthority.test.ts src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.sharedSession.test.tsx src/features/notes/notesEnterCriticalPathProbe.ts src/features/notes/notesEnterCriticalPathProbe.test.ts src/features/notes/notesEnterCriticalPath.test.tsx scripts/summarizeNotesEnterProbe.mjs scripts/summarizeNotesEnterProbe.test.ts
  git commit -m "test(notes): verify compact authority matrix"
  ```

---

### Task 13: Clean-HEAD desktop 측정과 Phase B rollout 판단

**Files:**

- Create: `docs/superpowers/reports/data/2026-07-23-notes-compact-mutation-authority-phase-b.json`
- Create: `docs/superpowers/reports/2026-07-23-notes-compact-mutation-authority-phase-b.md`

**Interfaces:**

- Consumes: Task 12의 clean committed Phase B probe/summary, Phase A fixture
  generator, and exact measured build SHA.
- Produces: immutable Phase B raw JSON, p50/p95/payload/fallback/recovery
  evidence, manual verification, and the 50ms rollout decision.

- [ ] **Step 1: clean measured source와 instrumented build 고정**

  ```bash
  test -z "$(git status --porcelain)"
  NOTES_COMPACT_MEASURED_SHA="$(git rev-parse HEAD)"
  NOTES_COMPACT_FIXTURE_DIR="$(mktemp -d /tmp/yonalist-compact-fixture.XXXXXX)"
  npm run notes:enter-fixture -- --out "$NOTES_COMPACT_FIXTURE_DIR"
  VITE_NOTES_ENTER_PROBE=1 \
  VITE_NOTES_ENTER_BUILD_SHA="$NOTES_COMPACT_MEASURED_SHA" \
  npm run tauri:build
  ```

  Status가 비어 있지 않으면 측정을 중단한다. Freshly built desktop을
  완전히 종료/재시작하고 Phase A와 같은 isolated 5,000-total-node,
  50-visible-row fixture를 연다. Probe count와 raw `buildSha`가 manifest와
  `NOTES_COMPACT_MEASURED_SHA`에 exact-match해야 한다.

- [ ] **Step 2: latency와 backlog raw batch 수집**

  Warm-up과 latency run 모두에서 각 sample 직전에 Undo로 이전 mutation을
  되돌리고 selection, zoom, expansion, focus/caret를 scenario baseline으로
  복원한다. 각 reset 뒤 다음 순서를 측정 시작 전에 완료한다.

  1. Active text 5,000개, visible 50개, target title/child/collapse/caret를
     baseline으로 복원한다.
  2. `await bridge.prepareCompactAuthority()`로 Undo가 null로 만든 token을
     untimed versioned read로 rebootstrap한다.
  3. 반환값의 non-null token/complete capability와 start fallback/recovery
     counter 0을 확인한다.
  4. `bridge.prepareNextRun()`으로 fixture/authority state를 arm한다.

  하나라도 실패하면 run을 버려 sample 수만 채우지 않고 batch 전체를
  무효화한다. Clean split, dirty split, dirty first-child를 각각 10회
  warm-up하고 매 회 reset한 뒤 bridge를 정확히 한 번 reset한다.
  Scenario별 고유 latency batch에서 위 precondition을 갖춘 50회씩
  측정한다.

  마지막 latency run도 pristine 5,000/50 + versioned authority ready로
  되돌린 뒤 `sampleKind: "backlog"`/`batchId:
  "phase-b-backlog-20"`으로 20개 non-repeat keydown/keyup을 기록한다.
  Backlog 안에서는 Undo/rebootstrap하지 않고 각 pair 전
  `prepareNextRun()`만 호출한다. 각 pair는 preceding authoritative
  focus/ack 뒤 다음 target에 보낸다. 한 번의 `exportJson()` 결과를 다음
  파일로 저장한다.

  ```text
  docs/superpowers/reports/data/2026-07-23-notes-compact-mutation-authority-phase-b.json
  ```

- [ ] **Step 3: raw schema와 50ms gate 검증**

  ```bash
  npm run notes:enter-summary -- --phase b docs/superpowers/reports/data/2026-07-23-notes-compact-mutation-authority-phase-b.json
  ```

  보고서에 environment/build SHA, raw summary, phase p50/p95,
  request/response bytes, result kind, full fallback count, recovery count를
  기록한다. Acceptance는 세 scenario 모두 같은 renderer clock에서
  `p95(focus - keydown) <= 50 ms`, latency sample 50개씩, backlog sample
  20개, final command/focus/animation pending 0, baseline pending 1 이하다.
  Summary는 모든 latency run start가 5,000/50, token/capability ready,
  fallback/recovery start 0인지 확인하고, backlog run counts가
  5,000+i/50+i인지 별도로 확인한다.

- [ ] **Step 4: manual proof**

  Contextual child, leaf sibling, middle-title split, dirty Enter, rapid Enter,
  exact caret, two-step Undo/Redo, two window same Vault, sync race, injected
  IPC/recovery failure, hard recovery retry, VoiceOver announcement/focus
  order를 확인해 보고서에 기록한다.

- [ ] **Step 5: 전체 Phase B gate 재실행**

  ```bash
  npm test
  npm run lint
  npm run build
  npm run test:architecture
  cargo test --manifest-path src-tauri/Cargo.toml
  cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
  git diff --check
  ```

  Expected: 모두 PASS. 결과와 measured SHA를 report에 기록한다.

- [ ] **Step 6: 50ms gate 판단**

  세 시나리오가 모두 통과하면 Phase B를 완료한다. 하나라도 넘으면
  측정값과 가장 큰 phase를 보고서에 기록하되 dirty save+structure 결합을
  구현하지 않는다. 별도 승인된 Phase C spec/plan이 생기기 전에는 두
  history transaction을 한 IPC로 합치지 않는다.

- [ ] **Step 7: 측정 증거만 별도 커밋**

  ```bash
  git add docs/superpowers/reports/data/2026-07-23-notes-compact-mutation-authority-phase-b.json docs/superpowers/reports/2026-07-23-notes-compact-mutation-authority-phase-b.md
  git commit -m "docs(notes): record compact authority evidence"
  ```

---

## Phase B Completion Evidence

- Versioned Active workspace/token/session history same-lock proof
- Nodes, attachments, sync, Undo, Redo의 dirty commit당 token 1회와 rollback/reconnect proof
- Split, first-child, text update 각각 full/delta/history parity
- Compact direct path의 full workspace load/serialization/normalization/reconstruction 0
- 1,000/10,000 node payload 차이 10% 이하와 10,000 sibling insertion splice 1개
- Identity-first gate, typed rejection, knownCommittedMismatch, outcomeUnknown, hard recovery 전체 zero-replay proof
- One dispatched-unsettled mutation per Vault와 queued mutation drain/draft preservation proof
- Dirty Enter의 ordinary two-step Undo 및 coalescedAway one-step exception
- Per-command circuit breaker와 legacy full token invalidation proof
- 세 desktop 시나리오 각각 10 warm-ups + 50 measured runs, keydown-to-focus p95 50ms 이하
- 20-key backlog-free proof와 manual accessibility/shared-session/sync/failure 결과
- Frontend 전체 test/lint/build/architecture, Rust 전체 test/fmt, diff check 결과
