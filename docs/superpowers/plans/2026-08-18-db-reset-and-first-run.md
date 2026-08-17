# 데이터베이스만 초기화하고 vault에서 다시 세우기 + 첫 실행 판정 한 곳으로

- 작성: 2026-08-18
- 기준: `main@ca0657df`, 작업 worktree `claude/three-way-sync-handoff-7b9f01`
- 전제: vault가 정본이고 데이터베이스는 캐시다. 이 기능 전체가 그 전제 위에 서 있다
- 사용자가 이미 정한 것: (1) 초기화는 한 번의 조작으로 끝내고 앱을 다시 켜지 않는다, (2) 읽은 문서 수와 읽지 못한 문서 수를 보고한다, (3) "첫 실행"은 **데이터베이스가 아직 설정되지 않았다**는 뜻이다. 기록된 vault 경로도 `localStorage`도 판정에 쓰지 않는다

## 0. 지배 제약

`format_version`은 1, `PRAGMA user_version`은 1, `MIGRATIONS`는 빈 채로 둔다. `schema.sql`은 한 글자도 고치지 않는다. 이 작업이 필요한 것은 새 테이블도 새 열도 아니고 `DELETE` 다섯 문장이다.

**재색인은 그 자체로 초기화가 아니다.** `reindex_vault`(`crates/notes-sqlite/src/sync_merge.rs:367`)는 vault의 모든 `.md`를 다시 읽어 *병합*한다. 병합은 HLC 비교이므로 이미 있는 행은 살아남아 판정에 참여한다. 파일이 더 이상 언급하지 않는 노드는 그대로 남는다. "파일에서 다시 세운다"고 적힌 버튼이 낡은 행을 남긴다면 그 버튼은 거짓말이다. 그래서 지우기가 먼저다.

**vault가 정본이라는 전제가 성립하지 않는 자리 하나.** home 행(`root`)은 vault가 서술하지 않는다. `merge_page`는 `root_id != "root"`일 때만 문서 root를 incoming에 넣으므로 `README.md`의 frontmatter 제목은 `root` 행에 적용되지 않는다. 따라서 `root`는 파일에서 다시 세울 수 없는 유일한 행이고 지우기는 그 행을 건드리지 않는다(`crates/notes-sqlite/src/fixtures.rs:19`가 같은 이유로 같은 조건을 쓴다).

## 1. 제공 계약

| 항목 | 내용 |
|---|---|
| 목표 | 설정 화면의 버튼 하나로 데이터베이스를 비우고 vault의 파일에서 다시 세운다. 앱은 그대로 떠 있고 화면은 즉시 갱신되며 읽은 문서 수와 읽지 못한 수가 보인다. 그리고 그 초기화 뒤 앱은 다시 첫 실행이 된다 |
| 비대상 | 앱 재시작. vault 파일 삭제·수정. 이 앱의 이미지 저장소(`<data>/images`) 삭제. 스키마 변경·마이그레이션·버전 승급. 진행률 표시와 취소. 읽지 못한 파일의 목록 UI(이미 `SyncStatusBadge`가 `sync_quarantine`으로 보여준다). onboarding 카드의 문구·레이아웃 재설계. `notes_delete_all_data`의 동작 변경 |
| 영향 경계 | React(`SettingsView.tsx`, `VaultSetupCard.tsx`, `App.tsx`), IPC(새 명령 둘, 기존 명령 하나에 한 줄), Rust(`notes-sqlite`의 `sync_merge.rs`·`seed.rs`·`worker.rs`, `notes-application`의 `service.rs`·`contracts.rs`, `apps/desktop/src-tauri/src/lib.rs`), SQLite(`DELETE`만, DDL 없음), 파일 시스템(vault 읽기 전용. 쓰기는 기존 방출 경로가 하던 것뿐) |
| 직접 확인할 사용자 시나리오 | 아래 §7 |

### 완료 조건

| ID | 사용자에게 보이는 결과 | 기계적 완료 조건 |
|---|---|---|
| A1 | vault가 더 이상 언급하지 않는 노트는 초기화 뒤 사라지고 언급하는 노트는 그대로 돌아온다 | `sync_merge_seam.rs::a_rebuild_drops_what_the_vault_no_longer_states` |
| A2 | 아직 폴더에 나가지 않은 편집이 남아 있으면 초기화가 아무것도 지우지 않고 이유를 말한다 | `sync_merge_seam.rs::a_refused_rebuild_leaves_every_row_where_it_was` |
| A3 | 보고 문구의 숫자가 폴더의 파일 수와 맞는다 | `sync_merge_seam.rs::a_reindex_counts_the_documents_it_read` |
| A4 | 초기화 직후 편집을 계속해도 실패하지 않고 초기화 전의 Undo는 되살아나지 않는다 | `merge_barrier.rs::a_rebuilt_database_leaves_no_history_to_replay` |
| A5 | 보고가 창까지 온다 | `lib.rs::tests::the_rebuild_report_serializes_the_generated_typescript_wire_shape`, `npm run test:contracts` |
| A6 | 버튼은 확인 한 단계를 거치고 끝나면 두 숫자를 보여준다 | `SettingsView.test.tsx::"rebuilds from the sync folder only after a confirmation step, then reports both counts"` |
| A7 | 폴더를 정한 사용자는 두 번째 실행에서 카드를 다시 보지 않는다. "나중에"도 기억된다 | `onboarding_seed.rs::recording_the_folder_settles_the_first_run_question_without_a_guide`, `VaultSetupCard.test.tsx::"두 번째 실행에서는 카드가 뜨지 않는다"` |
| A8 | 데이터베이스를 초기화하면 카드가 다시 나오고 노트가 이미 있는 폴더에는 안내 노트를 쓰지 않는다 | `onboarding_seed.rs::a_rebuilt_database_asks_again_and_writes_no_guide_over_notes` |

A1은 항목 2, A2는 항목 3, A3은 항목 1, A4는 항목 4, A5는 항목 5, A6은 항목 6, A7은 항목 7·8, A8은 항목 9가 잠근다.

## 2. 초기화의 정확한 순서

`notes_rebuild_from_vault` 명령 하나가 아래를 순서대로 한다. 3~6은 worker 요청 하나(`Request::RebuildFromVault`) 안에서 일어난다. worker는 단일 스레드로 요청을 직렬 처리하므로 지우기와 다시 읽기 사이에 창의 편집이 끼어들 수 없다. 두 요청으로 쪼개면 빈 데이터베이스에 새 행이 들어간 뒤 병합이 그 행을 상대로 판정하게 된다.

1. **vault 경로를 읽는다.** `sync_settings::read_vault_path`가 `None`이면 여기서 끝낸다. 다시 세울 원본이 없으므로 지우기는 곧 전부 잃는 것이다. `InvalidDestination`, `retryable: false`, "먼저 동기화 폴더를 정하세요"에 해당하는 문장을 답한다. UI는 애초에 버튼을 누르지 못하게 한다(§6).
2. **밖으로 나가지 않은 편집을 먼저 내보낸다.** `runtime.sync.flush()`. `notes_sync_flush`가 이미 하는 그대로다. 실패하면 `status.set_write(Some(reason))`, `notes://sync-status` 발신, 그 이유를 그대로 답하고 아무것도 지우지 않는다. 이 단계가 `sync_dirty_nodes`를 비우므로 3의 검사가 통과한다.
3. **아직 밖으로 나가지 않은 편집이 있으면 거절한다.** `sync_dirty_nodes`의 개수가 0이 아니면 `reindex_vault`가 이미 쓰는 그 문장으로 거절한다. **검사는 지우기보다 앞이다.** 뒤에 두면 지우기가 그 큐를 비워버려 검사가 아예 발화하지 못하고 나가지 않은 편집은 이미 사라진 뒤다. `reindex_vault`의 기존 검사를 `refuse_if_unexported(connection)`로 빼내 두 곳이 같은 문장을 쓴다.
4. **지운다.** `TransactionBehavior::Immediate` 트랜잭션 하나, 이 순서로:
   1. `DELETE FROM notes_nodes WHERE id <> 'root'` — FK `ON DELETE CASCADE`가 `notes_images`·`notes_tags`·`notes_dates`를 따라 지우고 `notes_fts_delete` 트리거가 색인을 지운다. `root`를 남기는 이유는 §0에 있다.
   2. `DELETE FROM sync_documents` — `folder_path`·`exported_hash`·`applied_max_hlc`·`file_mtime_ms`가 여기 있다. 남기면 `document_was_applied`가 `first_arrival`을 거짓으로 답하고 방출기는 파일이 이미 최신이라고 판단한다.
   3. `DELETE FROM sync_node_exports` — 노드별 마지막 방출 해시. 남으면 다시 세운 행이 파일로 나가지 못한다.
   4. `DELETE FROM notes_ui_state` — `active_page_id`와 첫 실행 표식이 여기 있다. 이 한 문장이 두 반쪽을 잇는다(§4).
   5. `DELETE FROM sync_dirty_nodes` — **반드시 마지막.** 4-i의 `notes_nodes_hlc_ad` 트리거가 살아남은 부모(`root`)를 더러운 것으로 표시하므로 먼저 지우면 큐가 다시 채워지고 5의 재색인이 그 큐를 보고 거절한다.
   6. `bump_revision(&transaction)` — 행이 바뀌었으므로 revision이 움직인다(§3).
   7. `COMMIT`.
5. **다시 읽는다.** `reindex_vault(connection, clock, vault_root)`를 그대로 호출한다. 문서 하나가 트랜잭션 하나이고 각 병합이 `node_paths::rebuild_all`과 `bump_revision`을 자기 트랜잭션 안에서 한다. 심볼릭 링크는 따라가지 않고 읽지 못한 파일은 세기만 한다. 이미 `sync_merge_seam.rs`가 잠근 계약이다.
6. **보고를 만든다.** `ReindexReport { read, merged, skipped }`. `read`는 parse가 성공한 파일 수, `skipped`는 읽지 못한 파일 수다. 사용자가 요청한 두 숫자는 `read`와 `skipped`다.
7. **세션에 알린다.** 명령이 `runtime.storage.revision()`으로 최종 번호를 읽어 `runtime.service.reset_session(revision)`에 넘긴다(§3).
8. **방출기를 깨운다.** `runtime.changed(Ok(report))`. 병합은 정규형이 파일과 다를 때 되쓰기를 표시할 수 있고 그 되쓰기를 깨우는 것은 이 한 줄뿐이다.
9. **창을 다시 세운다.** 명령의 답을 받은 프런트엔드가 `store.bootstrap()`을 부른다. `writeGuide`(`App.tsx:74`)가 쓰는 그 방법이다. 이벤트를 새로 만들지 않는다. `notes://sync-changed`는 500ms 합치기를 거치고 노드 id 목록을 전제로 하는데 여기서 바뀐 것은 전부이므로 목록으로 말할 수 없다.

### 트랜잭션 경계와 중간 실패

**지우기는 원자적이고 다시 읽기는 문서 단위로 원자적이다.** 전체를 한 트랜잭션에 넣으려면 `merge()`가 `&Transaction`을 받도록 서명을 바꿔야 하고 그러면 vault 전체를 읽는 동안 쓰기 잠금을 붙들게 된다. 값이 없다.

그래서 5의 도중에 실패하면 데이터베이스는 **지우기가 끝나고 그때까지 읽은 문서만 든 상태**로 남는다. 노트가 사라진 것으로 보인다. 복구는 버튼을 다시 누르는 것이고 그것으로 충분하다. vault는 그동안 한 글자도 바뀌지 않았고 정본은 여전히 거기 있다. 실패 문장은 그 사실을 말한다: 폴더를 다시 읽지 못했고 파일은 그대로이며 다시 시도하면 이어서 읽는다.

### 실행 중 사용자가 보는 것

버튼이 비활성이 되고 라벨이 "Rebuilding..."으로 바뀐다. `runDelete`가 쓰는 `deleting` 패턴 그대로다. 진행률은 없다. 명령은 `async` + `run_blocking`이라 창은 살아 있지만 worker 스레드가 이 요청에 잡혀 있으므로 그 사이 아웃라인의 질의는 뒤에 줄을 선다. 큰 vault에서는 몇 초 멈춘 것처럼 보인다(§8).

### 첨부 파일

이 앱의 이미지 저장소(`<data>/images`)는 **지우지 않는다.** vault의 markdown은 그림을 `<content_hash>.<ext>` 링크로 서술하므로 다시 세운 이미지 노드가 같은 해시를 가리키고 바이트는 저장소와 vault 양쪽에 그대로 있다. `sync_assets`도 남긴다. 그 행은 "이 바이트가 어디 있고 얼마나 큰가"라는 파일에 관한 진술이지 노드 상태의 사본이 아니다.

바이트가 저장소에만 있는 그림은 어떻게 되나. 그 그림의 노드가 아직 vault에 나가지 않았다는 뜻이고 그 상태는 2와 3이 막는다: 방출이 성공하면 vault에 사본이 생기고 실패하면 3이 거절한다. 방출이 성공했는데도 그 문서를 이 빌드가 읽지 못하면(§8) 노드는 돌아오지 않고 저장소의 바이트는 참조를 잃는다. 자동 삭제는 없지만 `notes_close_session`의 `assets.reconcile(&live_hashes)`가 앱을 닫을 때 그 바이트를 지운다. vault의 사본은 남는다.

### 남기는 테이블과 그 이유

| 테이블 | 지움 | 이유 |
|---|---|---|
| `notes_nodes`(`root` 제외)·`notes_images`·`notes_tags`·`notes_dates`·`notes_fts` | 예 | vault 문서에서 파생된 것 전부 |
| `sync_documents`·`sync_node_exports`·`sync_dirty_nodes`·`notes_ui_state` | 예 | 파생된 부기. 남으면 다시 읽기와 다시 쓰기를 억제한다 |
| `notes_meta` | 아니오 | revision은 앞으로만 간다. 0으로 되돌리면 열린 세션의 번호가 뒤로 간다 |
| `sync_meta` | 아니오 | `device_id`와 `vault_uuid`. 지우면 이 기기가 다른 기기로 바뀌고 스탬프의 출처가 갈라진다 |
| `sync_quarantine` | 아니오 | 디스크의 파일에 관한 진술이다. 파일이 그대로이므로 진술도 그대로 참이고 지우면 "읽지 못한 파일" 목록이 다음 순회까지 비어 보인다 |
| `sync_conflict_log` | 아니오 | 다른 기기가 덮어쓴 텍스트의 유일한 사본이다. 지우면 그 텍스트가 사라진다 |
| `sync_assets` | 아니오 | 위 첨부 파일 항목 |

## 3. revision이 하는 일

`notes_meta.revision`은 열린 세션의 다음 명령이 검사받는 번호다. `mutations::commit`이 `expected_revision`과 저장된 값을 비교해 다르면 `RevisionConflict`를 답하고(`mutations.rs:25`), `NotesService::ensure_revision`이 세션 자신의 사본으로 같은 검사를 한 번 더 한다(`service.rs:485`).

초기화는 `root` 하나를 빼고 모든 행을 다시 쓴다. 그러므로 revision은 움직여야 한다. 움직이지 않으면 창은 사라진 행을 상대로 계획한 편집을 예전 번호로 계속 보내고 데이터베이스는 그것을 받아준다. **틀린 성공이 조용히 쌓이는 쪽이 실패보다 나쁘다.**

세션이 예전 번호를 그대로 들고 있어서도 안 된다. `NotesService`의 `SessionState`는 프로세스 안의 메모리이고 프런트엔드가 `bootstrap`을 다시 불러도 그것은 바뀌지 않는다. 창은 새 번호를 배우고 세션은 옛 번호를 든 상태가 된다. 그 상태에서 첫 편집은 무조건 `RevisionConflict`다. 그래서 명령이 `reset_session(revision)`을 부른다.

`absorb_external`로는 이것을 말할 수 없다. 그 함수는 "이 id들을 다른 기기가 만졌다"를 받아 해당 항목만 손댈 수 없게 만드는데 여기서 만져진 것은 전부이고 전부를 id 목록으로 넘기는 것은 더 많은 코드에 더 약한 의미다. 그래서 `NotesService`에 여섯 줄을 더한다:

```rust
/// 초기화가 데이터베이스 전체를 vault에서 다시 세웠다. 되돌릴 대상이 하나도
/// 남아 있지 않으므로 층을 올리는 대신 스택을 비운다 — 초기화 전에 기록한
/// 역연산은 지금 없는 행을 상대로 쓰인 것이고 재생하면 vault가 말하지
/// 않는 내용을 되살린다.
pub fn reset_session(&self, revision: u64) {
    let mut session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
    session.revision = revision;
    session.undo.clear();
    session.redo.clear();
    session.undo_floor = 0;
}
```

## 4. 첫 실행 판정

**한 문장으로: `notes_ui_state`에 `onboarding_answered` 키가 없으면 첫 실행이다.**

값 하나, 데이터베이스 안, 그리고 그 키는 이미 있는 것을 이름만 고친 것이다(`seed.rs:7`의 `ONBOARDING_MARKER_KEY = "onboarding_seeded"`). 이름을 바꾸는 이유는 뜻이 바뀌기 때문이다. 지금은 "안내 노트를 이 데이터베이스에 제안한 적이 있다"이고 앞으로는 "이 노트가 어디 사는지 사용자가 답했다"다. 개발 데이터베이스는 다시 만드는 것이 규칙이므로 키 문자열 변경에 비용이 없다.

### 누가 그 값을 쓰는가

카드를 닫는 두 가지 답이 각자 쓴다. 카드 코드가 표식을 잊을 수 없게 하려면 답을 받는 명령이 쓰는 것이 맞다.

| 사용자의 답 | 지금 부르는 명령 | 표식을 쓰는 곳 |
|---|---|---|
| 폴더를 골랐다 (`empty`/`nonEmpty`/`existingVault` 전부) | `notes_sync_vault_set` | 그 명령에 한 줄. `gate.wait()?.storage.mark_onboarding_answered()` |
| "나중에" | `notes_onboarding_write_guide` → `seed_onboarding` | 이미 마지막에 `INSERT OR IGNORE`로 쓴다 |

`existingVault`가 지금 새는 자리다. 카드는 그 경우 `writeGuide`를 부르지 않으므로(`VaultSetupCard.tsx:99`) 표식이 남지 않고 카드가 다음 실행에 돌아온다. 폴더 기록 쪽으로 표식을 옮기면 그 구멍이 닫힌다. `existingVault`에 안내 노트를 쓰지 않는 규칙은 그대로 남는다. 두 사실을 한 호출이 담당하던 것을 갈라놓는 것이 이 절의 전부다.

`mark_onboarding_answered`는 IPC 명령이 아니다. `seed.rs`의 함수 하나와 worker 요청 하나이고 기존 명령이 부른다.

### 읽는 쪽

새 명령 `notes_onboarding_first_run() -> Result<bool, NotesError>`. `SELECT NOT EXISTS(SELECT 1 FROM notes_ui_state WHERE key = 'onboarding_answered')` 하나다. 새 타입이 없으므로 `packages/contracts/generated/`는 이 명령 때문에는 바뀌지 않는다.

`BootSnapshot`에 필드를 더하는 길도 있었다. 명령이 하나 줄지만 생성 계약이 바뀌고 `notesStore`의 shell 상태까지 배선해야 하며 초기화 뒤 카드가 다시 물어볼 때 bootstrap 왕복이 필요해진다. 명령 쪽이 작다.

### 은퇴하는 두 신호

- **`localStorage`의 `yonalist.vaultPromptDismissed.v1`** — `dismissedStorageKey`, `wasDismissed`, `rememberDismissal`을 지운다. 백엔드를 어떻게 초기화해도 살아남는 값이라 "한 번 나중에라고 답한 사람은 다시는 카드를 못 본다"가 되어 있었다. `VaultSetupCard.test.tsx`의 `localStorage` 스텁 두 덩이도 함께 사라진다.
- **`syncVaultGet() === null`** — 카드는 vault 경로를 더 이상 읽지 않는다. `readVaultPath` prop이 카드에서 빠지고 `isFirstRun: () => Promise<boolean>`이 들어온다. `SettingsView`의 `readVaultPath`는 그대로 남는다(폴더를 보여주는 것이 그쪽 일이다).

### "나중에"는 어디에 기억되는가

데이터베이스, 같은 키다. 카드는 매 실행 돌아오지 않는다. 사용자가 답했으면 답한 것이다. 그리고 데이터베이스 초기화는 그 기억을 정당하게 잊는다. 그것이 §5다.

## 5. 두 반쪽이 만나는 곳

초기화가 `notes_ui_state`를 지우므로 앱은 다시 첫 실행이 된다. 의도한 것이다: 데이터베이스가 설정되지 않았다는 것이 첫 실행의 뜻이고 방금 그것을 비웠다.

**사용자가 보는 순서.** 버튼 → 확인 → "Rebuilding..." → 같은 자리에 `role="status"`로 "12 documents read, 1 could not be read"가 나온다. 아웃라인은 그전에 이미 다시 세워져 있다(§2의 9). 설정을 닫으면 vault 설정 카드가 떠 있다. 카드는 `{!settingsOpen && <VaultSetupCard .../>}`로 렌더되므로 설정을 열 때 unmount되고 닫을 때 다시 mount되며 그때 effect가 첫 실행을 다시 묻는다. 배선을 더할 것이 없다.

**노트가 이미 있는 폴더에 안내 노트를 덮어쓰지 않는 이유.** 초기화 직후 데이터베이스는 비어 있지 않다. 재색인이 vault의 문서로 채웠다. `seed_onboarding`의 조건은 `!seeded && !has_notes`이고 `has_notes`는 `root` 아닌 행이 하나라도 있으면 참이다(`seed.rs:42`). 그러므로 카드에 어떻게 답해도 `seed_onboarding`은 안내 노트를 쓰지 않는다. 이미 있는 방어이고 새로 만들 것이 없다. vault가 비어 있었다면 데이터베이스도 비어 있고 그때는 안내 노트를 받는다. 그것이 맞다.

**vault 경로 파일은 지우지 않는다.** 초기화는 데이터베이스만 다루고 폴더는 사용자의 것이다(`notes_delete_all_data`는 다르다. 그쪽은 전부 지우는 것이므로 경로도 잊는다).

**그리고 그렇기 때문에 초기화는 `onboarding_answered`도 지우지 않는다 — §7.1의 판정이다.**

## 6. 항목 목록

각 항목은 커밋 하나, 빨강을 본 테스트 하나, 단독 revert 가능. 위험이 높은 것부터 내려간다.

| # | 하는 일 | 실패 테스트 | 만지는 파일 | 중간 상태가 컴파일되는 이유 |
|---|---|---|---|---|
| 1 | `ReindexReport`에 `read` 추가. parse 성공 직후 증가 | `crates/notes-sqlite/tests/sync_merge_seam.rs::a_reindex_counts_the_documents_it_read` | `crates/notes-sqlite/src/sync_merge.rs`, 같은 테스트 파일 | `Default` 파생 구조체에 `pub` 필드 추가. 읽는 곳이 아직 없다 |
| 2 | `rebuild_from_vault`(지우기 → `reindex_vault`) + `Request::RebuildFromVault` + `SqliteStorage::rebuild_from_vault`. **거절 검사는 아직 `reindex_vault` 안, 즉 지우기 뒤에 있다** | `sync_merge_seam.rs::a_rebuild_drops_what_the_vault_no_longer_states` | `crates/notes-sqlite/src/sync_merge.rs`, `crates/notes-sqlite/src/worker.rs`, 테스트 | 새 pub 메서드 하나. 부르는 곳이 아직 없다 |
| 3 | `refuse_if_unexported` 추출, `rebuild_from_vault`가 지우기 **전에** 부른다 | `sync_merge_seam.rs::a_refused_rebuild_leaves_every_row_where_it_was` | `crates/notes-sqlite/src/sync_merge.rs`, 테스트 | 함수 추출과 호출 위치 이동뿐. 항목 2의 순서에서 이 테스트는 진짜로 빨강이다(지우기가 이미 커밋된 뒤 재색인이 거절하므로 행이 사라진다) |
| 4 | `NotesService::reset_session(revision)` | `crates/notes-application/tests/merge_barrier.rs::a_rebuilt_database_leaves_no_history_to_replay` | `crates/notes-application/src/service.rs`, 테스트 | 새 pub 메서드 하나 |
| 5 | `VaultRebuildReport { documents, unreadable }` 계약 타입 + `notes_rebuild_from_vault` 명령(§2의 1~8) + `api.ts` + 계약 재생성 | `apps/desktop/src-tauri/src/lib.rs::tests::the_rebuild_report_serializes_the_generated_typescript_wire_shape` | `crates/notes-application/src/contracts.rs`, `packages/contracts/generated/VaultRebuildReport.ts`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src/api.ts`, `apps/desktop/src/test/appApiFixture.ts` | `#[ts(export)]` 타입 추가 + `invoke_handler`에 이름 하나. **새 타입이므로 `TS_RS_EXPORT_DIR` 재생성이 필요하고 `npm run test:contracts`가 이 항목을 막는다** |
| 6 | 설정 화면의 세 번째 필드: 확인 단계, 실행 중 라벨, `role="status"` 보고. 폴더가 없으면 비활성 | `apps/desktop/src/SettingsView.test.tsx::"rebuilds from the sync folder only after a confirmation step, then reports both counts"` | `apps/desktop/src/SettingsView.tsx`, `SettingsView.test.tsx`, `apps/desktop/src/App.tsx` | 기존 `NotesDataSection`에 prop 하나와 필드 하나 |
| 7 | 키를 `onboarding_answered`로, `mark_onboarding_answered`와 `onboarding_first_run`을 `seed.rs`·worker에, `notes_sync_vault_set`에 한 줄, `notes_onboarding_first_run` 명령 | `crates/notes-sqlite/tests/onboarding_seed.rs::recording_the_folder_settles_the_first_run_question_without_a_guide` | `crates/notes-sqlite/src/seed.rs`, `worker.rs`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src/api.ts`, `appApiFixture.ts`, 테스트 | 새 메서드 둘 + 기존 명령에 한 줄. 새 타입 없음 |
| 8 | 카드가 `isFirstRun`을 읽는다. `localStorage` 세 함수와 `readVaultPath` prop 삭제 | `apps/desktop/src/VaultSetupCard.test.tsx::"두 번째 실행에서는 카드가 뜨지 않는다"` | `apps/desktop/src/VaultSetupCard.tsx`, `VaultSetupCard.test.tsx`, `apps/desktop/src/App.tsx` | prop 교체. 항목 7이 명령을 이미 깔아 두었다 |
| 9 | 두 반쪽의 접합: 초기화 뒤 첫 실행 답이 다시 `true`이고 `seed_onboarding`은 안내 노트를 쓰지 않는다 | `crates/notes-sqlite/tests/onboarding_seed.rs::a_rebuilt_database_asks_again_and_writes_no_guide_over_notes` | `crates/notes-sqlite/tests/onboarding_seed.rs`만(코드가 이미 옳다면 항목 2·7의 계약을 잠그는 테스트) | 테스트만 추가. 빨강이 안 나오면 항목 2의 `DELETE FROM notes_ui_state`가 빠진 것이고 이 항목이 잡는 결함은 바로 그 누락이다 |

새 의존성은 없다. `Cargo.lock`에 추가되는 것도 없다.

### 게이트

Rust·IPC·영속성이 모두 바뀌므로 `delivering-yonalist-changes` §5의 두 번째 행이다: `npm test`, `npm run lint`, `npm run build`, `git diff --check`, `cargo test --manifest-path src-tauri/Cargo.toml`, Rust 서식, 그리고 `npm run test:contracts`. 워크스페이스 테스트는 `--no-fail-fast`로 돌린다. `crates/notes-sqlite/tests/two_devices.rs`는 28개 전부 `#[ignore]` 없이 통과해야 한다.

## 7. 직접 확인할 사용자 시나리오

`YONALIST_V2_DATA_DIR`를 임시 폴더로 두고 새로 빌드해 띄운다.

1. 첫 실행에 카드가 뜬다. 빈 폴더를 골라 안내 노트가 생기는 것을 본다.
2. 새 줄 하나를 쓰고 설정에서 폴더로 내보낸 뒤 폴더에 `.md` 파일이 생긴 것을 Finder에서 확인한다.
3. 텍스트 편집기로 그 파일의 한 줄을 고치고 다른 `.md` 파일 하나는 폴더에서 지운다.
4. 설정 → Yonalist data → 재구성 버튼 → 확인. 보고 숫자가 남은 파일 수와 맞는지, 3에서 고친 줄이 아웃라인에 반영되고 지운 파일의 페이지가 사라졌는지, **앱을 다시 켜지 않고** 그렇게 되는지 본다.
5. 설정을 닫는다. vault 설정 카드가 떠 있다. "나중에"를 누른다. 아웃라인의 노트는 그대로다(`seed_onboarding`이 안내 노트를 다시 쓰지 않는다).
6. 앱을 다시 켠다. 카드가 뜨지 않는다.
7. 폴더에 이 앱이 읽지 못하는 `.md`를 하나 두고 다시 재구성한다. 보고의 두 번째 숫자가 1이다.
8. 앱에서 한 줄을 쓴 직후(방출 전) 재구성을 누른다. 방출이 먼저 돌아 그 줄이 살아남는다. 폴더를 읽기 전용으로 만들고 같은 것을 하면 거절 문장이 나오고 노트는 그대로다.

## 8. 위험과 열린 질문

| 질문 | 권하는 안전한 기본값 |
|---|---|
| 이 빌드가 읽지 못하는 파일이 vault에 있으면 초기화가 그것을 어떻게 하나 | **아무것도 하지 않는다.** `reindex_vault`가 이미 그렇게 한다. 읽지 못한 파일은 건드리지 않고 세기만 한다. 위험은 그 문서의 노트가 데이터베이스에서 사라지는 것이고 보고의 두 번째 숫자가 그것을 말하는 유일한 신호다. 그래서 그 숫자를 0으로 접어 넣지 않는다. `sync_quarantine`을 남기는 결정도 여기 걸려 있다(그 목록이 어느 파일인지 말해 준다) |
| vault 폴더를 아직 고르지 않은 상태에서 버튼에 닿을 수 있어야 하나 | **아니오.** 원본 없는 초기화는 전부 잃는 것이다. UI는 폴더가 없으면 버튼을 비활성으로 두고 "먼저 동기화 폴더를 정하세요"를 적는다. 백엔드도 같은 답을 하므로 UI를 우회해도 안전하다 |
| 지우기가 끝나고 다시 읽기 도중에 실패하면 | 데이터베이스는 그때까지 읽은 문서만 든다. 버튼을 다시 누르면 이어진다. vault는 바뀌지 않았다. 실패 문장이 그 사실을 말한다. 자동 재시도는 넣지 않는다(반복 실패를 무한히 감추는 쪽이 나쁘다) |
| 큰 vault에서 worker가 몇 초 잡힌다 | 진행률도 취소도 넣지 않는다. 버튼의 비활성 라벨이 전부다. 재구성은 드문 조작이고 진행률 배선은 worker 요청 하나를 스트림으로 바꾸는 일이다. 측정해서 정말 문제가 되면 그때 만든다 |
| 초기화 뒤 카드가 이미 정한 폴더를 다시 묻는다 | §7.1이 판정한다. 초기화는 그 키를 지우지 않으므로 이 위험은 성립하지 않는다 |
| 읽지 못한 문서의 그림 바이트가 앱을 닫을 때 저장소에서 지워진다 | `reconcile`의 기존 동작이고 vault의 사본은 남으므로 잃는 것이 없다. 손대지 않는다 |
| `read` + `skipped`가 폴더의 `.md` 수와 정확히 같은가 | 같다. parse가 성공하면 `read`, 실패하거나 읽지 못하면 `skipped`, 심볼릭 링크는 애초에 파일로 세지 않는다. 노드를 하나도 만들지 않는 문서(빈 home)는 `read`에 들어가고 `merged`에는 안 들어간다. 사용자에게 보이는 숫자를 `merged`가 아니라 `read`로 정한 이유다 |
| `merged`를 읽는 곳이 없다 | 이미 그렇다(기존 결함이 아니라 기존 상태다). 이 작업에서 지우지 않는다. "무언가 바뀌었나"의 자연스러운 답이고 §2의 8이 방출기를 깨울지 판단할 여지를 남긴다 |

## 7.1 판정 — 초기화는 답을 거짓으로 만들지 않는다

설계가 §5의 마지막에 남긴 결과, 곧 "초기화 뒤 카드가 이미 정한 폴더를 다시 묻는다"는 그대로 두지 않는다.

근거는 사용자 결정을 뒤집는 것이 아니라 그 결정을 일관되게 읽는 것이다. 판정 기준은 사용자가 고른 그대로 남는다 — **첫 실행은 `notes_ui_state`에 `onboarding_answered`가 없는 것이고, vault 경로 파일도 `localStorage`도 보지 않는다.** 사용자가 물린 대안은 그 *기준*이었다.

그런데 `onboarding_answered`가 뜻하는 것은 "노트를 어디 둘지 사용자가 답했다"이고, 이 초기화는 `vault-path`를 **일부러 남긴다**. 답이 디스크에 그대로 있다. 답을 남긴 채 답했다는 표식만 지우면, 카드는 자기가 이미 답을 들고 있는 질문을 묻는다. 그것은 기준의 결과가 아니라 기준을 자기 자신과 어긋나게 적용한 결과다.

따라서 지우는 목록에서 `notes_ui_state`를 통째로 비우는 것을 뺀다. `DELETE FROM notes_ui_state WHERE key <> 'onboarding_answered'`가 되고, 캐시인 나머지(`active_page_id` 등)는 계속 사라진다.

**바뀌지 않는 것.** 새로 설치한 기기, 또는 개발자가 DB 파일을 손으로 지운 경우에는 키가 없으므로 첫 실행이고 카드가 뜬다 — 사용자가 원한 동작 그대로다. 초기화 버튼만 첫 실행을 흉내내지 않는다.

**항목 9의 계약이 이렇게 바뀐다.** `a_rebuilt_database_asks_again_and_writes_no_guide_over_notes`는 두 가지를 잠그던 test였다. "다시 묻는다"는 절이 뒤집히므로 이름과 본문을 `a_rebuilt_database_keeps_the_answer_and_writes_no_guide_over_notes`로 바꾼다. 잠그는 것은 초기화 뒤에도 `onboarding_first_run()`이 `false`이고 안내 노트가 사용자 노트 위에 쓰이지 않는다는 것이다. 안내 노트를 쓰지 않는다는 절은 그대로다.
