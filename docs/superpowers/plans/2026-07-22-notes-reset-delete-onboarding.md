# Notes Reset, Full Delete, and Onboarding Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 개발용 Notes DB 초기화와 전체 Notes 삭제를 분리하고, 가져올 유효한 Notes 파일이 없을 때 기본 안내 노트를 자동 복구한다.

**Architecture:** `sync::maintenance`가 Notes 소유 파일 판별과 저장소 유지보수 순서를 한곳에서 담당한다. Tauri 명령은 실행 중인 sync runtime을 멈춘 뒤 DB deletion gate 안에서 선택 범위만 제거하고, 게이트를 놓은 후 기존 `reconcile_startup`을 재사용해 현재 스키마·파일 import·안내 노트 export를 복구한다. 프런트엔드는 session 비의존 DB 초기화 IPC와 기존 draft-aware 전체 삭제를 구분하며 성공 후 webview를 다시 불러 완전히 새 Notes session을 연다.

**Tech Stack:** React 19, TypeScript 6, Vitest, Tauri 2, Rust 2024, rusqlite/SQLite, capability-safe filesystem I/O

## Global Constraints

- 개발 단계에서는 Notes 스키마 마이그레이션을 지원하지 않는다.
- DB 초기화는 app-local 및 legacy vault-local SQLite만 제거하고 Notes Markdown과 첨부파일을 보존한다.
- 전체 삭제는 Yonalist가 식별한 Notes topic/trash Markdown, Notes SQLite, 첨부파일 및 Notes 전용 휴지통만 제거한다.
- 일반 vault Markdown과 앱 설정은 어떤 경로에서도 삭제하지 않는다.
- 유효한 Notes topic이 없을 때 기본 안내 페이지 한 개와 하위 블릿 여섯 개를 정확히 한 세트 생성한다.
- 유효한 Notes topic이 있으면 파일을 가져오고 기본 안내 노트 잔여물을 남기지 않는다.
- DB 초기화는 Notes session 초기화 실패 상태에서도 실행 가능해야 하며 release UI에서는 노출하지 않는다.
- 기존 vault 검증, app lock, DB deletion gate, no-follow 파일 규칙을 재사용한다.
- 성공 후 이전 history/session을 재사용하지 않고 webview를 다시 불러 새 session을 만든다.

---

### Task 1: 유효한 파일 기준으로 onboarding bootstrap을 보존한다

**Files:**
- Modify: `src-tauri/src/notes/sync/bootstrap.rs:174-215`
- Test: `src-tauri/src/notes/sync/bootstrap.rs:1040-1140`

**Interfaces:**
- Consumes: `has_parseable_topic_file(&[StartupMarkdownFile]) -> bool`
- Produces: parse 가능한 topic이 없으면 onboarding seed를 유지하는 `reconcile_startup(vault_path: &str)`

- [ ] **Step 1: 손상 파일만 있는 새 vault의 실패 테스트를 작성한다**

```rust
#[test]
fn new_database_with_only_unparseable_markdown_keeps_and_exports_onboarding() {
    let vault = tempfile::tempdir().expect("create vault");
    let vault_path = vault_string(&vault);
    fs::write(vault.path().join("ordinary.md"), b"not a Notes topic")
        .expect("write ordinary markdown");

    let report = reconcile_startup(&vault_path).expect("bootstrap onboarding");
    assert_eq!(report.merged_files, 0);
    let shared = acquire_notes_connection(&vault_path).expect("acquire database");
    let connection = lock_notes_connection(&shared).expect("lock database");
    assert_eq!(
        connection.query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row.get::<_, i64>(0)).unwrap(),
        7
    );
    assert_eq!(fs::read(vault.path().join("ordinary.md")).unwrap(), b"not a Notes topic");
    assert!(fs::read_dir(vault.path()).unwrap().filter_map(Result::ok).any(|entry| {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        name.ends_with(".md") && name != "ordinary.md"
    }));
    drop(connection);
    drop(shared);
    evict_notes_connection(&vault_path);
}
```

- [ ] **Step 2: 집중 테스트가 RED인지 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml new_database_with_only_unparseable_markdown_keeps_and_exports_onboarding`

Expected: node count가 `0`이라 FAIL.

- [ ] **Step 3: fresh DB reset 조건을 유효한 topic 기준으로 좁힌다**

```rust
if !database_existed && has_topic_file {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start Notes file bootstrap reset: {error}"))?;
    transaction
        .execute("DELETE FROM notes_nodes", [])
        .map_err(|error| format!("Could not remove fresh Notes onboarding rows: {error}"))?;
    transaction
        .execute("DELETE FROM sync_dirty_nodes", [])
        .map_err(|error| format!("Could not clear fresh Notes bootstrap dirtiness: {error}"))?;
    transaction.commit()
        .map_err(|error| format!("Could not finish Notes file bootstrap reset: {error}"))?;
}
```

- [ ] **Step 4: 신규·기존 bootstrap 테스트를 GREEN으로 확인한다**

Run:
```bash
cargo test --manifest-path src-tauri/Cargo.toml new_database_with_only_unparseable_markdown_keeps_and_exports_onboarding
cargo test --manifest-path src-tauri/Cargo.toml new_database_bootstraps_existing_vault_files_without_onboarding_residue
```

Expected: 두 테스트 PASS.

- [ ] **Step 5: 커밋한다**

```bash
git add src-tauri/src/notes/sync/bootstrap.rs
git commit -m "fix(notes): preserve onboarding without sync topics"
```

---

### Task 2: reset과 full delete를 Rust 유지보수 경계로 분리한다

**Files:**
- Create: `src-tauri/src/notes/sync/maintenance.rs`
- Modify: `src-tauri/src/notes/sync/mod.rs`
- Modify: `src-tauri/src/notes/repository.rs:890-930`
- Test: `src-tauri/src/notes/sync/maintenance.rs`

**Interfaces:**
- Consumes: `repository::delete_database`, `sync::bootstrap::reconcile_startup`, `commands::begin_notes_database_deletion`, `AttachmentStorageLease`
- Produces: `NotesMaintenanceMode::{ResetDatabase, DeleteAll}`
- Produces: `rebuild_notes_storage(vault_path: &str, mode: NotesMaintenanceMode) -> Result<NotesMaintenanceOutcome, String>`

- [ ] **Step 1: 두 범위의 실패 테스트를 작성한다**

`database_reset_preserves_sync_files_and_reimports_them`은 유효한 Notes topic과 일반 `ordinary.md`를 만든 뒤 reset하고, 두 파일이 byte-for-byte 유지되며 topic이 SQLite에 다시 들어왔음을 확인한다.

`full_delete_removes_owned_notes_files_but_recreates_onboarding`은 같은 fixture를 full delete한 뒤 Notes topic이 없어지고 `ordinary.md`는 유지되며 SQLite에 onboarding 7개 node와 root 제목 `Yonalist Notes 시작하기`가 정확히 하나 존재함을 확인한다.

`database_reset_without_topic_recreates_one_onboarding_set`은 SQLite만 존재하는 vault를 reset한 뒤 onboarding node가 정확히 7개인지 확인한다. `database_reset_preserves_attachment_storage`는 `.yonalist/notes-assets`의 유효한 hash 파일 bytes가 reset 전후 동일한지 확인한다. `full_delete_removes_sync_cleanup_storage`는 `.yonalist/sync-cleanup`의 앱 전용 staging 파일이 full delete 뒤 없어지는지 확인한다.

기존 repository의 격리 subprocess 패턴을 재사용하는 `database_reset_removes_blocking_legacy_v1_without_attachment_initialization`은 `NOTES_DATA_ROOT`가 설정된 실제 production 경계에서 legacy `user_version = 1`을 만들고 reset한 뒤 legacy DB가 제거되고 app-local 현재 DB와 onboarding이 생성되는지 확인한다. 이 테스트는 reset이 `AttachmentStorageLease::acquire`를 호출하지 않아야만 통과한다.

두 테스트의 공통 결과 검사는 다음 helper를 사용한다.

```rust
fn node_count(vault_path: &str, predicate: &str) -> i64 {
    let shared = crate::notes::connection::acquire_notes_connection(vault_path).unwrap();
    let connection = crate::notes::connection::lock_notes_connection(&shared).unwrap();
    connection
        .query_row(&format!("SELECT COUNT(*) FROM notes_nodes WHERE {predicate}"), [], |row| row.get(0))
        .unwrap()
}
```

- [ ] **Step 2: 유지보수 API 부재로 RED인지 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes::sync::maintenance::tests --no-fail-fast`

Expected: `maintenance` module/API 부재로 컴파일 FAIL.

- [ ] **Step 3: legacy SQLite 세트 제거 helper를 추가한다**

```rust
pub(crate) fn delete_legacy_database(vault_path: &str) -> Result<(), String> {
    validate_vault_path(vault_path)?;
    let app_lock = crate::notes::connection::acquire_vault_app_lock(vault_path)?;
    let metadata = app_lock.try_clone_metadata()?;
    delete_database_from_metadata(&metadata)
}
```

- [ ] **Step 4: Notes 소유 파일 판별과 유지보수 순서를 구현한다**

`sync/mod.rs`에 `pub(crate) mod maintenance;`를 추가한다. 새 모듈의 공개 계약은 다음과 같다.

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NotesMaintenanceMode {
    ResetDatabase,
    DeleteAll,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct NotesMaintenanceOutcome {
    pub(crate) attachment_cleanup_failed: bool,
}

pub(crate) fn rebuild_notes_storage(
    vault_path: &str,
    mode: NotesMaintenanceMode,
) -> Result<NotesMaintenanceOutcome, String> {
    crate::validate_vault_path(vault_path)?;
    let owned_files = match mode {
        NotesMaintenanceMode::ResetDatabase => Vec::new(),
        NotesMaintenanceMode::DeleteAll => collect_owned_sync_files(vault_path)?,
    };
    // Reset must remain callable while legacy v1 blocks attachment storage.
    let storage = match mode {
        NotesMaintenanceMode::ResetDatabase => None,
        NotesMaintenanceMode::DeleteAll => Some(
            crate::notes::attachments::AttachmentStorageLease::acquire(vault_path)?,
        ),
    };
    let deletion_guard = crate::notes::commands::begin_notes_database_deletion(vault_path)?;
    crate::notes::repository::delete_database(vault_path)?;
    crate::notes::repository::delete_legacy_database(vault_path)?;
    if mode == NotesMaintenanceMode::DeleteAll {
        remove_owned_sync_files(vault_path, &owned_files)?;
        remove_owned_sync_cleanup_files(vault_path)?;
    }
    let attachment_cleanup_failed = storage
        .is_some_and(|storage| storage.delete_attachment_files().is_err());
    drop(deletion_guard);
    crate::notes::sync::bootstrap::reconcile_startup(vault_path)?;
    Ok(NotesMaintenanceOutcome { attachment_cleanup_failed })
}
```

`collect_owned_sync_files`는 vault root의 regular `.md`만 bounded no-follow로 읽고 `parse_topic_file`이 parsed topic/trash를 반환한 파일만 root-relative basename으로 보관한다. `remove_owned_sync_files`는 수집 당시 identity를 재검증하고 symlink·교체 파일을 거부한다. `remove_owned_sync_cleanup_files`는 앱 전용 `.yonalist/sync-cleanup` 안의 regular staging 파일만 no-follow로 제거한다. 일반·미식별 파일은 보존한다.

- [ ] **Step 5: reset/delete/일반 파일 보존 테스트를 GREEN으로 확인한다**

Run:
```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::maintenance::tests --no-fail-fast
cargo test --manifest-path src-tauri/Cargo.toml app_local_storage_uses_the_vault_key_and_tests_keep_the_legacy_fallback
```

Expected: 모두 PASS.

- [ ] **Step 6: 커밋한다**

```bash
git add src-tauri/src/notes/repository.rs src-tauri/src/notes/sync/mod.rs src-tauri/src/notes/sync/maintenance.rs
git commit -m "feat(notes): add scoped storage maintenance"
```

---

### Task 3: session 비의존 reset IPC와 재구축되는 delete IPC를 연결한다

**Files:**
- Modify: `src-tauri/src/notes/commands.rs:7210-7260`
- Modify: `src-tauri/src/lib.rs:15-35,1550-1650`
- Modify: `src/services/notesStore.ts:2140-2230`
- Modify: `src/services/notesStore.tauri.test.ts:2400-2470`
- Test: `src-tauri/src/notes/commands.rs`

**Interfaces:**
- Consumes: `sync::runtime::stop_sync`, `sync::maintenance::rebuild_notes_storage`
- Produces: Tauri `notes_reset_database(vault_path)`
- Produces: TypeScript `notesResetDatabase(vaultPath: string): Promise<void>`
- Keeps: `NotesStore.deleteDatabase(vaultPath): Promise<NotesDeleteDatabaseResult>`

- [ ] **Step 1: reset IPC wire 실패 테스트를 작성한다**

```ts
it("uses the session-independent database reset command", async () => {
  invokeMock.mockResolvedValue(undefined);
  await expect(notesResetDatabase(vaultPath)).resolves.toBeUndefined();
  expect(invokeMock).toHaveBeenCalledWith("notes_reset_database", { vaultPath });
});
```

- [ ] **Step 2: export 부재로 RED인지 확인한다**

Run: `npx vitest run src/services/notesStore.tauri.test.ts -t "session-independent database reset command"`

Expected: `notesResetDatabase` 부재로 FAIL.

- [ ] **Step 3: Rust command wrapper를 구현한다**

```rust
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_reset_database(
    state: tauri::State<'_, crate::notes::sync::runtime::SyncState>,
    vault_path: String,
) -> Result<(), NotesError> {
    let state = state.inner().clone();
    run_blocking(move || {
        if !cfg!(debug_assertions) {
            return Err("Notes DB reset is available only in development builds.".to_string());
        }
        crate::notes::sync::runtime::stop_sync(&state)?;
        crate::notes::sync::maintenance::rebuild_notes_storage(
            &vault_path,
            crate::notes::sync::maintenance::NotesMaintenanceMode::ResetDatabase,
        )?;
        Ok(())
    }).await
}
```

`notes_delete_database`도 `SyncState`를 받은 뒤 `stop_sync`하고 `DeleteAll` mode를 실행해 기존 `DeleteDatabaseOutcome`으로 변환한다. `lib.rs` import와 `generate_handler!`에 reset command를 등록한다.

- [ ] **Step 4: TypeScript service를 추가한다**

```ts
export async function notesResetDatabase(vaultPath: string): Promise<void> {
  try {
    await invokeNotes<void>("notes_reset_database", { vaultPath });
  } catch (cause) {
    throw notesStoreError("deleteData", cause);
  }
}
```

- [ ] **Step 5: command·wire·handler 테스트를 GREEN으로 확인한다**

Run:
```bash
npx vitest run src/services/notesStore.tauri.test.ts -t "database reset|database deletion"
cargo test --manifest-path src-tauri/Cargo.toml notes_reset_database
cargo test --manifest-path src-tauri/Cargo.toml registered_tauri_commands
```

Expected: 관련 테스트 PASS.

- [ ] **Step 6: 커밋한다**

```bash
git add src-tauri/src/notes/commands.rs src-tauri/src/lib.rs src/services/notesStore.ts src/services/notesStore.tauri.test.ts
git commit -m "feat(notes): expose database reset maintenance"
```

---

### Task 4: 설정 UI에서 두 작업을 구분하고 성공 후 새 session을 연다

**Files:**
- Modify: `src/features/notes/NotesDataSettingsDialog.tsx`
- Modify: `src/features/notes/NotesDataSettingsDialog.test.tsx`

**Interfaces:**
- Consumes: `notesResetDatabase(vaultRoot)`, `actions.deleteAllNotesData(options)`
- Produces: development-only `Reset Notes database` UI와 기존 `Delete all Notes data` UI
- Produces: 성공 후 주입 가능한 `reloadApplication()` 기본 구현으로 webview를 다시 여는 경계

- [ ] **Step 1: reset과 full delete UI 실패 테스트를 작성한다**

```ts
it("resets the development database without requiring a workspace action", async () => {
  const user = userEvent.setup();
  render(
    <VaultRootContext.Provider value="/vault">
      <NotesDataSettingsDialog open onOpenChange={vi.fn()} reloadApplication={reloadMock} />
    </VaultRootContext.Provider>
  );
  await user.click(screen.getByRole("button", { name: "Reset Notes database" }));
  const confirm = screen.getByRole("alertdialog", { name: "Reset the Notes database?" });
  expect(confirm).toHaveTextContent("Synced Notes files and attachments are kept");
  await user.click(within(confirm).getByRole("button", { name: "Reset database" }));
  await waitFor(() => expect(notesResetDatabaseMock).toHaveBeenCalledWith("/vault"));
  expect(reloadMock).toHaveBeenCalledOnce();
});

it("describes complete Notes-owned deletion and reloads", async () => {
  const user = userEvent.setup();
  render(<NotesDataSettingsDialog open onOpenChange={vi.fn()} reloadApplication={reloadMock} />);
  await user.click(screen.getByRole("button", { name: "Delete all Notes data" }));
  const confirm = screen.getByRole("alertdialog", { name: "Delete all Notes data?" });
  expect(confirm).toHaveTextContent("synced Notes files and attachments");
  await user.click(within(confirm).getByRole("button", { name: "Delete Notes data" }));
  await waitFor(() => expect(deleteAllNotesDataMock).toHaveBeenCalledOnce());
  expect(reloadMock).toHaveBeenCalledOnce();
});
```

테스트는 `reloadApplication={reloadMock}`을 전달해 webview 재시작 요청을 관찰한다.

- [ ] **Step 2: 버튼·문구·reload 부재로 RED인지 확인한다**

Run: `npx vitest run src/features/notes/NotesDataSettingsDialog.test.tsx -t "development database|complete Notes-owned deletion"`

Expected: reset 버튼 또는 reload 호출이 없어 FAIL.

- [ ] **Step 3: 개발용 reset 상태와 확인 대화상자를 구현한다**

```ts
const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
const [resetPending, setResetPending] = useState(false);
const busy = deleting || purgePending || resetPending;

const resetNotesDatabase = async () => {
  if (busy) return;
  const requestVaultRoot = currentVaultRootRef.current;
  setResetPending(true);
  setError(null);
  try {
    await notesResetDatabase(requestVaultRoot);
    reloadApplication();
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : "The Notes database could not be reset.");
  } finally {
    setResetPending(false);
  }
};
```

`import.meta.env.DEV`일 때만 버튼을 렌더한다. 확인 설명은 `Synced Notes files and attachments are kept. Notes that exist only in SQLite will be permanently discarded.`로 고정한다.

- [ ] **Step 4: full delete 설명과 성공 경로를 파일 SSoT에 맞춘다**

```tsx
<p>
  This removes the Notes database, synced Notes files, attachments, and Trash
  data from this vault. Other vault files and application settings are kept.
</p>
```

`NotesDataSettingsDialogProps`에 테스트용 선택 인자 `reloadApplication?: () => void`를 추가하고 기본값은 `() => window.location.reload()`로 둔다. `deleteNotesData` 성공 시 기존 draft flush/discard 계약을 보존한 채 같은 `reloadApplication()`을 호출한다.

- [ ] **Step 5: UI owning tests를 GREEN으로 확인한다**

Run:
```bash
npx vitest run src/features/notes/NotesDataSettingsDialog.test.tsx
npx vitest run src/features/notes/useNotesWorkspace.test.tsx -t "Notes data deletion"
```

Expected: 관련 테스트 PASS.

- [ ] **Step 6: 커밋한다**

```bash
git add src/features/notes/NotesDataSettingsDialog.tsx src/features/notes/NotesDataSettingsDialog.test.tsx
git commit -m "feat(notes): restore reset and onboarding recovery UI"
```

---

### Task 5: 격리 데스크톱과 최종 게이트로 완료한다

**Files:**
- Modify only if verification exposes a regression in files already named above

**Interfaces:**
- Consumes: completed reset/delete paths
- Produces: fresh-process desktop evidence and final repository gate

- [ ] **Step 1: 집중 owning suites를 실행한다**

Run:
```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npx vitest run src/features/notes/NotesDataSettingsDialog.test.tsx src/services/notesStore.tauri.test.ts
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::bootstrap::tests --no-fail-fast
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::maintenance::tests --no-fail-fast
```

Expected: 모두 exit 0.

- [ ] **Step 2: 격리 vault에서 새 Tauri 개발 프로세스로 증명한다**

임시 vault에 `user_version = 1`인 legacy `.yonalist/notes.sqlite`와 일반 Markdown sentinel을 만든다. DB reset으로 오류가 사라지고 sentinel은 유지되며 onboarding 7개 node가 표시되는지 확인한다. 새 topic과 첨부파일을 만든 뒤 reset하면 둘이 보존되는지, full delete하면 Notes 소유 topic/attachment는 사라지고 onboarding이 다시 나타나며 sentinel은 유지되는지 확인한다.

- [ ] **Step 3: 최종 프로젝트 게이트를 한 번 실행한다**

Run:
```bash
npm run lint
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml --no-fail-fast
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
git diff --check
```

Expected: 모두 exit 0. pre-existing failure는 정확한 test name/output과 함께 현재 변경과 분리한다.

- [ ] **Step 4: diff와 사용자 데이터 비접촉을 확인한다**

Run:
```bash
git status --short
git diff HEAD~4 --stat
git diff HEAD~4 --check
```

격리 test data가 저장소나 사용자 vault에 남지 않았는지 확인한다. 검증 수정이 있을 때만 해당 파일을 추가 커밋한다.
