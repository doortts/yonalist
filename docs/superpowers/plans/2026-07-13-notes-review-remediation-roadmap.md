<!-- reconciliation: auditedHead=ec8a9ff3d016449255992adf70e128ea5e222e9a status=complete -->
> **증거 대조 상태 (2026-07-19): 완료.** commit·artifact 근거는 [감사 ledger](../reports/2026-07-19-historical-plan-ledger.json)에 기록했다.

# Notes 리뷰 개선 실행 계획 (Remediation Roadmap)

> **작성 근거:** 2026-07-13 `codex/notes-workflowy` 적대적 리뷰 (FE 아키텍처 / FE 코어 로직 / Rust 백엔드 / 영속성·IPC 4개 트랙).
> 각 태스크는 체크박스로 추적하며, 태스크 하나 = 커밋 하나를 원칙으로 한다.

**목표:** 리뷰에서 확인된 Critical/Major/정확성 이슈를 전부 해소하고, Workflowy parity 다음 단계 기능을 착수 가능한 상태로 만든다.

**전체 일정 (1인 기준): 11~13주**

| Phase | 내용 | 공수 | 선행 조건 |
| --- | --- | --- | --- |
| R | main 통합 + 안전망 (ESLint, 베이스라인) | 2~3일 | — |
| 0 | Critical 핫픽스 (데이터 유실·정확성 버그) | 1주 | R |
| 1 | 백엔드 실행 모델 (async, 연결 재사용, 트랜잭션 위생) | 1.5주 | 0.7 (flock) |
| 2 | 프론트 렌더 성능 (컨텍스트 분할, 메모이제이션) | 1.5주 | R (Phase 1과 병렬 가능) |
| 3 | 구조 리팩토링 (엔진 추출, 단일 소유권, 에러 체계) | 3주 | 1, 2 |
| 4 | Workflowy parity (다중 선택, 서식, 임포트 등) | 4~6주 | 3 |

---

## Phase R: 준비 (2~3일)

### R1. main 통합
- [x] `git merge main` 실행 (205커밋 rebase 대신 merge 1회 — 충돌 반복 회피).
- [x] `src/App.tsx` 충돌 해결 전략: **main의 구조를 채택** (main은 `useOutboxSync`/`useDraftIssue`/`useSettingsReset`이 추출된 상태, 이 브랜치는 구버전 App 기반). 그 위에 Notes 통합 지점만 재적용:
  - featureRegistry 기반 렌더 분기 (`activeFeature.renderPanes`)
  - `NotesWorkspaceProvider` 마운트
  - Sidebar의 Notes 항목
- [x] 검증: `npm test` 전체 + `cargo test --manifest-path src-tauri/Cargo.toml` green.

### R2. ESLint 도입 (리뷰 F6)
- [x] `eslint` + `typescript-eslint` + `eslint-plugin-react-hooks` 설치, `react-hooks/exhaustive-deps`를 **error**로.
- [x] 기존 위반 ~10건 수정: `useNotesWorkspace.ts` 내 `replayHistory` deps(≈2837), `createRoot` deps(≈3298), `createChild` deps(≈3346), `flushAllDraftsBeforeStructural` deps(≈2567)의 유령/미사용 항목.
- [x] `package.json`에 `lint` 스크립트 추가.
- 커밋: `chore: add eslint with react-hooks rules`

### R3. 성능 베이스라인 기록
- [x] 5,000노드 시드 vault 생성 스크립트 작성 (scratch, 커밋 불필요).
- [x] 현재 상태 측정 기록: 키 입력→commit 렌더 컴포넌트 수(React Profiler), `notes_load_workspace` 왕복 시간, 20MB 이미지 표시 시간. Phase 1·2의 성공 판정 기준으로 사용.

---

## Phase 0: Critical 핫픽스 (1주)

### 0.1 디바운스 max-wait 상한 — 리뷰 C1a
- [x] `src/services/notesWriteQueue.ts`: `DebouncedEntry`에 `firstEnqueuedAt` 추가. `enqueueDebounced` 재무장 시 `MAX_DEBOUNCE_LATENCY_MS`(2,000ms) 초과분은 즉시 `startDebounced` 실행, 미만이면 남은 시간만큼만 타이머 설정.
- [x] 테스트(`notesWriteQueue.test.ts`): fake timers로 250ms 간격 연속 enqueue → 2초 내 최소 1회 flush 검증. 기존 FIFO/coalescing 테스트 유지.
- 커밋: `fix(notes): cap draft debounce latency`

### 0.2 flush-on-quit — 리뷰 C1b
- [x] `NotesFeature.tsx`(또는 워크스페이스 활성화 시점)에서 `getCurrentWindow().onCloseRequested` 등록:
  1. `event.preventDefault()`
  2. 전체 드래프트 flush (coordinator 경유), **3초 타임아웃**
  3. `getCurrentWindow().destroy()` — flush 실패/타임아웃 시에도 닫되 경고 로그 (영구 잠금 방지)
  4. 재진입 가드 (이미 종료 절차 중이면 통과)
- [x] 개발 모드/웹뷰 새로고침 대비 `beforeunload`에서 best-effort flush 보조.
- [x] 테스트: `@tauri-apps/api/window` mock으로 close 시퀀스 검증.
- 커밋: `fix(notes): flush drafts before window close`

### 0.3 키보드 정확성 버그 2건 — 정확성 리뷰 1·2
- [x] **줌 탈출:** `src/features/notes/outlineKeyboard.ts` Shift+Tab 분기(≈182-198) — `node.parentId === workspace.zoomRootId`이면 `null` 반환 (드래그 경로 `outlineDrag.ts:316-337`의 줌 격리와 일치시킴).
- [x] **숨김 완료 밑 증발:** Tab 분기(≈201-223) — prior sibling 선택 시 raw `childIdsByParent` 순서 대신 `visibleNodeIds` 기준으로 직전 *보이는* 형제를 선택. 해당 형제가 접혀 있으면 `expandNodeId` 동반. 화살표 키들과 동일한 규칙으로 통일.
- [x] 테스트: `outlineKeyboard.test.ts`에 줌 하 outdent, hide-completed 하 indent 케이스 추가 (현재 둘 다 미커버).
- 커밋: `fix(notes): confine indent and outdent to visible zoomed rows`

### 0.4 Backspace 첨부 가드 + 이미지 경로 판정 — 정확성 리뷰 4·5
- [x] `outlineKeyboard.ts`(≈272-291) bail 조건에 `(workspace.attachmentsByNodeId[nodeId]?.length ?? 0) > 0` 추가 — 백엔드 거부 에러 배너 대신 no-op.
- [x] `notesAttachmentController.ts:42-45` `isSupportedImagePath` — 파일명에 `.` 포함을 요구 (`/tmp/png` 같은 확장자-없는 이름 오탐 제거).
- 커밋: `fix(notes): guard attachment removals and pathless image names`

### 0.5 클립보드 이미지 paste 배선 — 정확성 리뷰 3 (죽은 코드 활성화)
- [x] `NoteTextField.tsx`에 `onPaste` 핸들러: `extractClipboardImages(event.clipboardData)` → 이미지 존재 시 `event.preventDefault()` + `importClipboardImages(nodeId, images)` 호출.
- [x] `NotesAttachmentIngest.test.tsx`에 paste 시나리오 추가 (기존 native drop 테스트 패턴 재사용).
- 커밋: `feat(notes): wire clipboard image paste`

### 0.6 export overwrite 안전장치 — Rust 리뷰 7
- [x] `src-tauri/src/notes/export.rs`: assets 디렉터리 publish 시 매니페스트 마커(`.yonalist-notes-export.json`: export id + 생성 파일 목록) 기록.
- [x] overwrite 경로(≈1013-1046): 기존 `{stem}_assets`에 마커가 없으면 **에러 반환** ("directory was not created by a previous export"); 마커가 있으면 기존 rename-롤백 절차 유지.
- [x] 테스트: 마커 없는 기존 dir → 거부 / 마커 있는 dir → 교체.
- 커밋: `fix(notes): refuse to overwrite foreign export asset directories`

### 0.7 flock 데드라인 — Rust 리뷰 3
- [x] `src-tauri/src/notes/attachments.rs` `AttachmentStorageLease::acquire`(≈1060-1077): 블로킹 `lock()` → `try_lock_exclusive` + 재시도 루프(총 5초 데드라인) → 초과 시 "vault is busy" 에러.
- 커밋: `fix(notes): bound attachment lease acquisition`

### 0.8 쓰기 실패 가시화 (최소분) — 영속성 리뷰 M1·M2
- [x] 워크스페이스 상단 배너: `writeError` 렌더 + `retryLastFailedWrite` 버튼 (현재 두 API 모두 **소비자 0**).
- [x] `flushAllDraftsBeforeStructural`가 false로 구조 커맨드가 드롭될 때 배너에 사유 표시 ("저장 실패로 차단됨 — 재시도").
- [x] `deleteAllNotesData`(`useNotesWorkspace.ts` ≈4360-4368): flush 실패 시 "드래프트를 버리고 삭제" 확인 경로 추가 — DB 고장 시 복구 수단이 막히는 문제 해소.
- [x] Rust `notes_delete_database`(commands.rs ≈1030): 첨부 파일 삭제 실패를 무시하지 말고 결과에 부분 실패 표시.
- 커밋: `fix(notes): surface write failures and unblock data deletion`

### Gate 0 (수동 검증 시나리오)
- 연속 타이핑 중 강제 종료 → 재시작 시 유실 ≤ 2초.
- hide-completed 상태에서 Tab → 행이 화면에 남음.
- 줌 상태에서 줌 루트 직계 자식 Shift+Tab → no-op.
- 스크린샷 클립보드 붙여넣기 → 이미지 첨부 생성.

---

## Phase 1: 백엔드 실행 모델 (1.5주) — Phase 2와 병렬 가능

### 1.1 커맨드 async화 — Rust 리뷰 1
- [x] `src-tauri/src/notes/commands.rs`의 40개 커맨드를 `async fn`으로 전환, 본문을 `tauri::async_runtime::spawn_blocking`으로 감싼다. 파라미터가 전부 owned(String/구조체)라 기계적 변환.
- [x] 중복 제거용 헬퍼 `run_blocking<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String>` 도입.
- [x] 순서 보장 확인: 프론트 coordinator가 vault별 직렬화하므로 동작 불변. flock 데드라인(0.7)이 선행되어야 함.
- [x] 검증: `cargo test` green + 대형 PDF export 중 UI 스크롤/입력 반응 수동 확인.
- 커밋: `perf(notes): run note commands off the main thread`

### 1.2 SQLite 연결 재사용 — Rust 리뷰 2
- [x] `NotesDbManager` managed state 도입: vault path → `Mutex<Connection>` 맵. 커맨드는 매니저에서 연결 획득 (짧은 임계영역, spawn_blocking 내부라 blocking mutex 허용).
- [x] `initialize_notes_db`(헤더 preflight + 마이그레이션 + 스키마 검사)는 `notes_initialize`에서 **1회만**. 이후 커맨드의 per-call 마이그레이션 파이프라인 제거 (`repository.rs:132, 222` 경로).
- [x] 읽기 커맨드가 IMMEDIATE(쓰기) 트랜잭션으로 스키마 검사하던 문제 자동 해소 — 검색 키 입력이 더 이상 쓰기 락을 잡지 않음.
- [x] 연결 헬스체크(에러 시 재연결), `notes_delete_database` 시 연결 evict.
- [x] `performance.rs` 재측정 — 이제 측정 경로와 프로덕션 경로가 일치.
- 커밋: `perf(notes): reuse a managed sqlite connection per vault`

### 1.3 트랜잭션 위생 — Rust 리뷰 4·10
- [x] 모든 쓰기 트랜잭션을 IMMEDIATE로 통일 (`repository.rs:2392-2397`의 deferred 분기 제거 — WAL의 `SQLITE_BUSY_SNAPSHOT` 승급 실패 방지).
- [x] `create_attachment_coordinated_inner`(≈3863-3936): `publish()`(temp-write+fsync+rename)를 트랜잭션 **밖**으로. 순서: stage 파일 준비 → txn(메타 insert+commit) → publish 확정, 실패 시 stage 롤백. 기존 마커 기반 reconcile이 잔존물 청소 담당.
- [x] history replay(≈history.rs:1026-1037): 첨부 해시·디코딩 검증을 txn 시작 **전**에 수행 (`PreparedAttachmentBatch` 선례 재사용).
- 커밋: `fix(notes): keep file io outside write transactions`

### 1.4 첨부 읽기 raw IPC — Rust 리뷰 5 / 영속성 H2
- [x] `notes_read_attachment_bytes`(commands.rs ≈904) 반환을 `tauri::ipc::Response::new(bytes)`로 — JSON 숫자 배열 제거.
- [x] 읽기 시 풀 이미지 디코딩(attachments.rs ≈1394-1428) 제거, SHA-256 해시 검증만 유지 (풀 검증은 ingest에서 이미 수행).
- [x] `notesStore.ts`: `Uint8Array`/`ArrayBuffer` 경로만 유지, 숫자 배열 요소별 검증 루프(≈684-722) 삭제.
- [x] 테스트: `notesStore.tauri.test.ts` 갱신 + 대용량 fixture 왕복.
- 커밋: `perf(notes): stream attachment reads as raw bytes`

### 1.5 mutation delta (1단계: 백엔드만) — Rust 리뷰 6
- [x] `NotesMutationResult`에 delta 필드 추가: `changedNodes` / `removedNodeIds` / `changedAttachments` (히스토리 TEMP audit rows에서 도출 — 데이터는 이미 존재). 기존 전체-workspace 필드는 **유지** (프론트 소비는 Phase 3.4 이후).
- [x] `search_parent_map`(repository.rs ≈2058)의 전체 노드 적재 → 결과 집합 한정 recursive CTE.
- 커밋: `perf(notes): return mutation deltas`, `perf(notes): scope search parent trails`

### 1.6 백엔드 소소한 정리 — Rust 리뷰 11·12·16 / 영속성 M4
- [x] resize/remove의 이중 reconcile(commands.rs ≈929-957) → candidates-only (run_mutation과 동일하게).
- [x] `duplicate_node`(repository.rs ≈3292-3371): 첨부 메타 행 복사 추가 (파일은 content-addressed라 바이트 복사 불필요) + 의도 고정 테스트.
- [x] `empty_trash`가 전 세션 undo 히스토리를 지운다는 사실을 확인 다이얼로그 문구에 노출.
- [x] **단일 인스턴스 vault 락**: `.yonalist/notes.app.lock` try_lock — 실패 시 "다른 창에서 사용 중" 에러. 이것으로 `notes_initialize`의 `clear_all_history`(commands.rs ≈110-117)가 다른 인스턴스의 히스토리를 파괴하는 경로 차단.
- 커밋: 항목별 개별 커밋

### Gate 1
- `cargo test` green. 64MB 이미지 배치 import 중 UI 반응 유지. 검색 연타 중 mutation 정상. R3 베이스라인 대비 `notes_load_workspace` 왕복 개선 수치 기록.

---

## Phase 2: 프론트 렌더 성능 (1.5주) — Phase 1과 병렬 가능

### 2.1 컨텍스트 분할 — FE 리뷰 2
- [x] `NotesWorkspaceContext` → 3개로 분할:
  - `NotesStateContext`: workspace projection + navigation
  - `NotesDraftsContext`: draftsByNodeId + writeError
  - `NotesActionsContext`: 액션만 (안정 참조)
- [x] `useNotesWorkspace` 반환을 slice별 `useMemo`로. `actions` identity churn 원인 제거 — `createRoot`의 `libraryView` 의존을 ref 읽기로 전환.
- [x] 소비자 7개 컴포넌트가 필요한 컨텍스트만 구독하도록 수정.
- 커밋: `perf(notes): split workspace context by volatility`

### 2.2 행 메모이제이션 — FE 리뷰 2
- [x] `NotesOutlinePane.tsx`(≈357-374): `flattenVisibleOutlineRows` + `hideCompletedSubtrees` + `deriveOutlineBodyRows`를 `useMemo`로 (deps: nodesById, childIdsByParent, zoomRootId, showCompleted, 확장 상태).
- [x] `visibleNodeIds` 배열의 값 전달 제거 — prev/next 행 해석을 pane 레벨 콜백 또는 ref accessor로 이동 (이걸 안 하면 행 memo가 무효).
- [x] `OutlineNodeRow`를 `React.memo`로 전환, props를 원자 값(node, draft, isSelected, isEditing…)으로 축소. 컨텍스트 직접 구독은 actions만.
- [x] `NoteTokenText.tsx:62`: `tokenizeNoteText`를 `useMemo(text)`로.
- [x] 검증: 렌더 카운트 테스트 — 키 입력 1회당 commit 컴포넌트 수가 상수(해당 행 + pane 1회 이하)임을 assert.
- 커밋: `perf(notes): memoize outline rows`

### 2.3 autosave의 loading 상태 격리 — FE 리뷰 2
- [x] `useNotesWorkspace.ts`(≈1550-1552): draft(비구조) 쓰기의 `setLoading` dispatch 제거 — 백그라운드 자동저장이 `aria-busy`/전체 리렌더를 유발하지 않도록. 구조 커맨드만 pending 상태 사용.
- [x] 관련 테스트 갱신.
- 커밋: `perf(notes): keep autosave out of the loading state`

### 2.4 App 통합 렌더 차단
- [x] main merge 이후 기준: `activeFeature.renderPanes(...)` 결과 메모이제이션 (main의 `0c19b5d` 패턴을 Notes 패널에 적용) — App의 알림 폴링/상태 지표 churn이 Notes 서브트리를 리렌더하지 않도록.
- 커밋: `perf(notes): memoize feature panes across app commits`

### Gate 2
- 5,000노드 시드로 타이핑: keystroke당 commit < 16ms, Profiler 캡처를 R3 베이스라인과 비교해 기록. `notesExpansion.performance.test.ts`에 렌더 카운트 회귀 테스트 추가.

---

## Phase 3: 구조 리팩토링 (3주) — 순서 엄수: 3.1→3.2가 3.3의 테스트 안전망

### 3.1 NotesDraftEngine 추출 — FE 리뷰 1·5
- [x] `useNotesWorkspace.ts`에서 framework-free 클래스로 추출 → `notesDraftEngine.ts`:
  - 세션 레코드 기계장치 (≈439-463)
  - 드래프트 파이프라인: 리비전/디바운스/재시도/실패 원장 (≈2085-2693)
  - 복구 레지스트리 (≈536-1023) — WeakMap을 엔진 필드로
- [x] 구독 인터페이스(`onDraftsChanged`, `onWriteError`) 노출, 훅은 `useSyncExternalStore` 어댑터로.
- [x] 렌더 중 ref 재할당 패턴(`persistDraftRef.current = ...` ≈2271 등) 제거 — 엔진 내부 메서드 호출로 대체 (concurrent React 안전).
- [x] **테스트 이관:** `useNotesWorkspace.test.tsx`(7,520줄)의 드래프트/큐/복구/StrictMode 계열 → `notesDraftEngine.test.ts` (React 없이 fake timers). 목표: 훅 테스트 60~70% 감축.
- 커밋: `refactor(notes): extract draft engine`, `test(notes): port draft tests off react`

### 3.2 구조 커맨드 레이어 추출 — FE 리뷰 1
- [x] 구조 커맨드 ~20개(createRoot ≈3212, splitNode ≈3355, moveNode ≈3495, runRootLifecycle ≈3861-4090 등)를 `notesCommands.ts`의 순수 함수 `(ctx: CommandContext) => QueueResult`로. 훅은 ctx 조립만 담당.
- [x] 세션 staleness 가드 39회 반복 → ctx 생성 시점 1회 검증으로 축소.
- 커밋: `refactor(notes): extract structural command layer`

### 3.3 내비게이션/scope 단일 소유권 — FE 리뷰 3 (리스크 최고, 안전망 이후)
- [x] `liveNavigationRef` 삭제 — reducer 상태가 내비게이션의 유일 소유자. `reconcileLiveNavigation`(≈498-534) 제거, `settledUiState` 한 벌만 유지.
- [x] `Scope` 값 객체 도입: canonical `key` 문자열 포함 — coordinator의 `JSON.stringify` 비교(coordinator ≈341)와 훅의 `sameScope`(≈586-591) 모두 대체 (키 순서 의존 제거).
- [x] `historyStatus` 소유권을 coordinator로 일원화 (버전 비교 이중화 제거).
- [x] scope 3중화(`activeScopeRef`/`libraryView`/tag filter refs) → 단일 소스 + 파생.
- 커밋: `refactor(notes): single ownership for navigation and scope`

### 3.4 mutation delta 프론트 소비 — Rust 리뷰 6 (2단계)
- [x] `settleQueueWork`가 1.5의 delta를 normalized store에 적용 — 전체 re-normalize는 scope 전환 시에만. `notesWorkspaceReducer.ts`의 wholesale 교체(≈152-192) 개편.
- 커밋: `perf(notes): apply mutation deltas incrementally`

### 3.5 settlement 결과 타입 — FE 리뷰 7
- [x] coordinator `enqueue`/`enqueueStructural` 반환을 `Promise<"committed" | "skipped" | "failed">`로.
- [x] `commitPreparedMove`의 outcome 클로저 밀수(≈5065-5166) 제거 — 정식 반환값 사용.
- [x] `OutlineNodeRow.runStructuralCommand`(≈292-310): skipped 시 포커스 복원 + 사유 토스트 (Enter가 조용히 무시되는 UX 제거).
- 커밋: `fix(notes): report command settlement outcomes`

### 3.6 에러 taxonomy — 영속성 리뷰 M3
- [x] Rust: `NotesError { code: NotesErrorCode, message: String }` (serde) — 전 커맨드 `Result<T, NotesError>`로.
- [x] TS: 판별 유니언 + code 기반 `retryable` 도출. 죽은 `retryable: true` 하드코딩(notesStore.ts 5곳) 정리.
- [x] `"Destination already exists."` 문자열 완전일치(notesExport.ts:24,118-120 ↔ export.rs 5곳) → `ExportDestinationExists` 코드로.
- 커밋: `refactor(notes): typed error codes across ipc`

### 3.7 feature registry 정직화 — FE 리뷰 4
- [x] feature provider **상시 마운트** + 비활성 패널 hidden — Notes↔Inbox 전환 시 워크스페이스 세션 teardown 제거. 이로써 복구 WeakMap이 일반 필드로 축소되고 StrictMode 셧다운 댄스(≈1752-1776) 단순화.
- [x] `renderInboxPanes` 백채널 제거 — features가 자기 패널을 소유, App은 일반 slot props만 제공.
- [x] App의 `activeFeatureId === "..."` 분기 20곳 정리.
- 커밋: `refactor: keep feature providers mounted`

### 3.8 잔여 정리
- [x] `notes/mod.rs`의 일괄 `#[allow(dead_code)]` 제거 → 죽은 코드 청소.
- [x] `performance.rs` 머신 고정 게이트(M1 Pro 하드코딩) → 상대 회귀 기준으로.
- [x] **NFC 태그 정규화** (정확성 리뷰 6, 한국어 사용자 직격): `noteTokens.ts`에 `.normalize("NFC")`, Rust `tags.rs`에 `unicode-normalization` — 스키마 v4 마이그레이션으로 기존 태그 re-derive + FTS 재색인, 양측 parity fixture 갱신.
- 커밋: 항목별 개별 커밋

### Gate 3
- 전체 테스트 green. `useNotesWorkspace.ts` ≤ 1,500줄. 훅 테스트에서 mock 호출 순서 assertion 소멸. ESLint 위반 0.

---

## Phase 4: Workflowy Parity (4~6주, 기능별 독립 브랜치 권장)

> **2026-07-13 확정:** Phase 4의 4.1~4.5 전체 실행이 승인되었다. 미러/백링크·보드·
> 타임라인(4.6)은 기존 로드맵의 "별도 product/design 승인" 방침을 유지한다.
> 실행 체제: 오케스트레이터가 태스크별 실행계획·테스트 설계를 작성하고, 코더
> 에이전트가 구현, 적대적 리뷰 후 재작업 루프를 거쳐 머지한다. 파일 겹침 때문에
> 4.2와 4.3은 한 트랙으로 묶는다(둘 다 noteTokens.ts 확장).

### 4.1 다중 노드 선택 (1.5~2주) — 최우선 parity 공백
- [x] 선택 모델: reducer에 `selection: { anchorId, headId }` — visible rows 범위 기반. Shift+Click / Shift+↑↓ 확장, Esc 해제.
- [x] 렌더: `isSelected` prop (2.2의 memo 구조 유지).
- [x] 일괄 작업: Complete / Delete / Move To / Indent / Outdent / Drag를 선택 집합에 적용.
- [x] 백엔드: `notes_apply_batch` 커맨드 — **한 트랜잭션 + 한 히스토리 엔트리** (이미지 원자 배치의 transport 선례 재사용). undo 1단위.
- 커밋: `feat(notes): multi-node selection`, `feat(notes): batch structural command`

### 4.2 인라인 텍스트 서식 (2주)
- [x] **설계 결정: 마크다운 서브셋 토큰** (`**bold**`, `*italic*`, `~~strike~~`, `` `code` ``) — 저장 포맷은 플레인 텍스트 유지, `noteTokens.ts` 확장으로 표시 오버레이만 서식 렌더. 스키마 변경 없음, Markdown export와 자연 호환. (rich span 모델은 비권장 — 편집기 전면 교체 비용.)
- [x] Cmd+B / Cmd+I / Cmd+Shift+X: textarea 선택 범위를 마커로 감싸기/벗기기.
- [x] `NoteTokenText` 렌더 + export 렌더러(markdown은 통과, PDF는 스타일 적용) 갱신.
- 커밋: `feat(notes): inline formatting tokens`

### 4.3 URL 자동 링크 (2~3일)
- [x] `noteTokens.ts`에 `url` 토큰 종류 추가 (http/https만), `NoteTokenText`에서 앵커 렌더, 클릭 시 `tauri-plugin-opener`로 외부 브라우저.
- 커밋: `feat(notes): clickable urls`

### 4.4 붙여넣기 임포트 (3~4일)
- [x] 다중 행 + 들여쓰기 구조 텍스트 paste → 서브트리 생성 (`notes_apply_batch` 재사용, undo 1단위).
- ~~OPML 파서(import) + OPML export~~ — **2026-07-14 사용자 지시로 범위 제외.**
- 커밋: `feat(notes): paste import subtrees`

### 4.5 빠른 이동 팔레트 Cmd+K (3~4일)
- [x] 모달 팔레트: 기존 FTS 검색 재사용, Enter → `zoomTo`.
- 커밋: `feat(notes): quick jump palette`

### 4.6 연기 유지 (로드맵 승인 조건 그대로)
- 미러/백링크, 보드/칸반, 타임라인 뷰 — 별도 product/design 승인 후.

### Gate 4
- 각 기능을 실제 Workflowy와 나란히 놓고 수동 비교 세션 (키보드 흐름, 선택 동작, 임포트 왕복).

---

## 리스크 관리

| 리스크 | 완화 |
| --- | --- |
| R1 merge 충돌 규모 (App.tsx 1,425줄 diff) | main 구조 우선 채택 원칙 + merge 직후 전체 테스트로 회귀 즉시 검출 |
| 3.3 상태 단일화 회귀 | 3.1/3.2에서 엔진 테스트를 React 밖으로 이관한 뒤 착수 (안전망 순서 엄수) |
| 1.2 연결 재사용의 동시성 | vault당 단일 Mutex<Connection>, spawn_blocking 내부에서만 접근, 단일 인스턴스 락(1.6) 병행 |
| 3.4 delta 적용 불일치 | delta와 전체 workspace를 병행 반환하는 과도기 유지 — 개발 모드에서 delta 적용 결과와 전체 로드 결과 비교 assert |
| 4.2 서식 토큰과 기존 데이터 | 저장 포맷 불변(플레인 텍스트)이라 마이그레이션 불필요 — 렌더만 변경 |
