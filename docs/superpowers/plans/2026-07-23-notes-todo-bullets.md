# Notes To-do Bullets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notes 블릿에 영속적인 To-do 타입, 직접 자식 기준 완료 게이지, 빈 일반 블릿 마커 숨김을 추가한다.

**Architecture:** `markerKind: "bullet" | "todo"`를 완료 상태 및 텍스트/이미지 노드 종류와 독립된 도메인 필드로 추가한다. SQLite와 Topic/Trash 파일을 SSOT로 유지하고, 프런트엔드 초안 저장 경로가 제목과 `markerKind`를 한 번에 기록하게 하여 `/To-do` 변환을 단일 Undo 항목으로 만든다. 진행률은 저장하지 않고 기존 `childIdsByParent` 인덱스에서 직접 자식 To-do만 계산한다.

**Tech Stack:** React 19, TypeScript 6, Vitest/Testing Library, Rust, rusqlite, Tauri 2, Markdown Topic sync.

## Implementation Record (2026-07-23)

- Tasks 1–5 구현 완료.
- Task 6 자동 검증 완료: Rust 전체 테스트, 프런트엔드 전체 테스트, lint, build, architecture, format, diff 검사 통과.
- 실제 사용자 데이터가 연결된 Tauri 앱은 안전을 위해 임의 실행하지 않았다. 대신 임시 vault를 생성하는 Rust 통합 테스트로 DB 재시작/Topic 동기화를, Testing Library 통합 테스트로 빈 블릿·To-do·직계 진행률 레이아웃을 검증했다.
- 구현 파일명은 `TodoProgressIndicator.tsx`/`.test.tsx`이며 컴포넌트 export 이름은 `NotesTodoProgress`를 유지한다.

## Global Constraints

- 승인된 설계 문서 `docs/superpowers/specs/2026-07-23-notes-todo-bullets-design.md`를 계약으로 사용한다.
- 개발 단계 DB 마이그레이션은 추가하지 않는다. 스키마 v2 DB는 기존 정책대로 명시적으로 거부하고 초기화 안내를 유지한다.
- 기존 format v2 Topic/Trash 파일은 읽되 `markerKind`를 `bullet`로 해석한다. 기존 `[ ]` 텍스트만으로 To-do로 추론하지 않는다.
- To-do 진행률은 직계 자식만 집계하며 파생 UI로만 존재한다. 자동 설명 문구는 생성하지 않는다.
- 이미지 노드도 To-do로 변환 가능해야 한다.
- 기존 사용자 소유 미추적 파일 `docs/superpowers/plans/2026-07-22-outline-motion-refinement.md`를 수정하거나 스테이징하지 않는다.
- 각 작업은 실패하는 집중 테스트를 먼저 확인한 후 최소 구현으로 통과시킨다.

---

## Task 1: 도메인 및 SQLite 영속성에 `markerKind` 추가

**Files:**

- Modify: `src/domain/notes.ts`
- Modify: `src/services/notesStore.ts`
- Modify: `src/services/notesStore.tauri.test.ts`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/schema.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/history.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify as required by Rust compile errors: `src-tauri/src/notes/attachments.rs`, `src-tauri/src/notes/markdown_import.rs`, `src-tauri/src/notes/bootstrap.rs`

- [ ] **Step 1: TypeScript 전송 계약 실패 테스트 작성**

  `src/services/notesStore.tauri.test.ts`의 create/update IPC 테스트에 `markerKind`를 추가하고, 응답 노드 검증이 `markerKind` 누락 및 잘못된 값을 거부하는 테스트를 `src/domain/notes.test.ts`에 추가한다.

- [ ] **Step 2: 프런트엔드 도메인 타입 최소 구현**

  `NoteMarkerKind = "bullet" | "todo"`를 추가하고 `NoteNode`, `CreateNoteNodeInput`, `UpdateNoteNodeInput`, `NoteImportNode`, `NOTE_NODE_KEYS`, `isNoteNode`에 반영한다. import 입력의 누락 값은 기존 일반 블릿 호환을 위해 호출 경계에서 `bullet`로 정규화한다.

- [ ] **Step 3: Rust 스키마/serde 실패 테스트 작성**

  `src-tauri/src/notes/schema.rs` 테스트에서 schema version 3과 `marker_kind TEXT NOT NULL DEFAULT 'bullet' CHECK(...)`를 기대한다. `commands.rs` IPC serde 테스트에서 camelCase `markerKind`를 기대하고 잘못된 값을 거부한다.

- [ ] **Step 4: Rust 도메인 및 저장소 최소 구현**

  `NoteMarkerKind` enum을 `#[serde(rename_all = "camelCase")]` 필드와 호환되도록 직렬화하고 기본값을 `Bullet`로 둔다. `NoteNode`, `StoredNode`, create/update/import/export 구조체와 모든 SELECT/INSERT/UPDATE/row decoder에 `marker_kind`를 추가한다. 스키마 버전을 3으로 올리되 v2→v3 ALTER/MIGRATION은 만들지 않는다.

- [ ] **Step 5: 생성/분할/복제/이미지 편집 상속 규칙 테스트 및 구현**

  다음을 저장소 테스트로 고정한다.

  - 새 루트/새 자식/붙여넣기에서 생략된 종류는 `bullet`.
  - 동일 레벨 Enter 생성 및 마지막 설명에서 Shift+Enter 생성은 원본이 `todo`이면 `todo`.
  - split, duplicate, 이미지 원자 Enter가 만든 동일 레벨 노드는 원본 `markerKind`를 상속.
  - `completedAt`은 marker 변환 때 유지.

- [ ] **Step 6: Undo/Redo 스냅샷에 marker 포함**

  `history.rs`의 old/new node JSON, replay row, upsert SQL에 `markerKind`를 넣고 bullet↔todo 변환이 단일 Undo/Redo로 왕복하는 Rust 테스트를 추가한다.

- [ ] **Step 7: 집중 검증**

  Run: `npm test -- src/domain/notes.test.ts src/services/notesStore.tauri.test.ts`

  Run: `cargo test --manifest-path src-tauri/Cargo.toml notes::schema notes::repository notes::history notes::commands`

  Expected: PASS.

---

## Task 2: Topic/Trash 파일 format v3 왕복

**Files:**

- Modify: `src-tauri/src/notes/sync/topic_file.rs`
- Modify: `src-tauri/src/notes/sync/topic_parser.rs`
- Modify: `src-tauri/src/notes/sync/merger.rs`
- Modify: `src-tauri/src/notes/sync/exporter.rs`
- Modify: `src-tauri/src/notes/sync/integration_tests.rs`
- Modify as required by compile errors: `src-tauri/src/notes/sync/bootstrap.rs`, `src-tauri/src/notes/sync/watcher.rs`, `src-tauri/src/notes/sync/runtime.rs`
- Modify: `src-tauri/src/notes/sync/fixtures/topic_golden.md`

- [ ] **Step 1: parser/renderer 실패 테스트 작성**

  format v3에서 다음 문자열 계약을 테스트한다.

  - 루트 frontmatter: `root_marker_kind: bullet | todo`.
  - 일반 미완료: `- title`.
  - 일반 완료: `- [x] title`, metadata에 `todo` 없음.
  - To-do 미완료/완료: `- [ ] title` / `- [x] title`, node metadata에 `todo` 토큰 있음.
  - format v2 또는 marker metadata 누락은 항상 `bullet`.
  - 알 수 없거나 중복된 marker metadata는 parser error.

- [ ] **Step 2: format v3 renderer/parser 최소 구현**

  `TOPIC_FORMAT_VERSION`을 3으로 올리고 `TopicRoot`/`TopicNode`에 marker를 추가한다. checkbox 문법은 완료 여부로, `todo` metadata는 marker 종류로 독립 해석한다.

- [ ] **Step 3: merger/exporter 전파 구현**

  DB→Topic snapshot, Topic→DB insert/update, root merge에 marker를 포함한다. 기존 HLC whole-row 승자 규칙을 그대로 적용한다.

- [ ] **Step 4: Golden 및 통합 테스트 갱신**

  `topic_golden.md`를 format 3으로 갱신하고 bullet/todo와 완료 상태의 네 조합이 내보내기→파싱→병합에서 보존되는 통합 테스트를 추가한다.

- [ ] **Step 5: 집중 검증**

  Run: `cargo test --manifest-path src-tauri/Cargo.toml notes::sync::topic_file notes::sync::topic_parser notes::sync::merger notes::sync::integration_tests`

  Expected: PASS.

---

## Task 3: 프런트엔드 명령과 초안 저장 규칙

**Files:**

- Modify: `src/features/notes/notesWorkspaceTypes.ts`
- Modify: `src/features/notes/notesDraftEngine.ts`
- Modify: `src/features/notes/useNotesDraftWorkflow.ts`
- Modify: `src/features/notes/notesCommands.ts`
- Modify: `src/features/notes/useNotesCommandActions.ts`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify tests: `src/features/notes/notesDraftEngine.test.ts`, `src/features/notes/notesCommands.test.ts`, `src/features/notes/useNotesWorkspace.test.tsx`, `src/features/notes/useNotesWorkspace.sharedSession.test.tsx`

- [ ] **Step 1: draft marker 단일 저장 실패 테스트 작성**

  `NotesNodeDraft`가 선택적으로 `markerKind` 변경을 보유하고, 제목 `/todo` 제거와 `markerKind: "todo"`가 repository `updateNode` 한 번 및 동일 history entry 한 번으로 저장되는 테스트를 추가한다. 일반 타이핑은 확인된 노드 marker를 보존해야 한다.

- [ ] **Step 2: draft 모델 최소 확장**

  `NotesNodeDraft`와 failed-write snapshot에 marker를 포함한다. 기존 모든 호출자가 marker를 넘기도록 강제하지 않고, draft patch의 marker가 없으면 확인된 노드의 marker를 `persistDraftMutation`에서 사용한다. marker 변환 호출은 새 marker를 명시한다.

- [ ] **Step 3: 명령 생성 규칙 실패 테스트 작성**

  `createNextTextSiblingCommand`, `splitNodeCommand`, 이미지 Enter edit 결과가 source marker를 상속하고, 일반 `createRoot`/`createChild`는 bullet인 테스트를 추가한다.

- [ ] **Step 4: 명령 및 action 구현**

  create/update 요청에 marker를 전파하고 `NotesWorkspaceActions.updateNodeDraft` patch가 marker 변경을 받을 수 있게 한다. 기존 구조 명령의 draft barrier와 focus 복구 계약은 유지한다.

- [ ] **Step 5: 집중 검증**

  Run: `npm test -- src/features/notes/notesDraftEngine.test.ts src/features/notes/notesCommands.test.ts src/features/notes/useNotesWorkspace.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx`

  Expected: PASS.

---

## Task 4: 메뉴와 `/To-do` 변환

**Files:**

- Modify: `src/features/notes/notesSlashCommands.ts`
- Modify: `src/features/notes/NotesSlashCommandMenu.tsx`
- Modify: `src/features/notes/NoteTextField.tsx`
- Modify: `src/features/notes/NotesBulletMenu.tsx`
- Modify tests: `src/features/notes/notesSlashCommands.test.ts`, `src/features/notes/NoteTextField.test.tsx`, `src/features/notes/NotesBulletMenu.test.tsx`

- [ ] **Step 1: slash command 실패 테스트 작성**

  `To-do`가 `/`, `/t`, `/to` 검색에 나타나고 선택 시 명령 토큰만 지운 값, caret 위치, `markerKind: "todo"` action을 반환하는 테스트를 추가한다. Today는 기존 텍스트 삽입 결과를 유지한다.

- [ ] **Step 2: slash 결과 타입 및 메뉴 구현**

  slash 결과를 텍스트 편집과 marker 편집의 discriminated union으로 바꾼다. `NotesSlashCommandMenu`는 Today에 calendar, To-do에 checkbox 아이콘을 표시한다. `NoteTextField`는 marker 결과를 native input 변경으로 반영한 직후 `onSlashMarkerCommand`로 marker patch를 같은 draft revision에 합치고 focus/caret을 유지한다.

- [ ] **Step 3: bullet menu 실패 테스트 작성**

  일반 블릿은 `To-do`, To-do는 `Change to bullet`을 표시하며 action 후 메뉴가 닫히는 테스트를 추가한다. selection/archive/trash 메뉴에는 표시하지 않는다.

- [ ] **Step 4: bullet menu 구현**

  `NotesBulletMenuProps`에 `markerKind`와 `onChangeMarkerKind`를 추가하고 표준 단일 행 메뉴에 변환 항목을 배치한다.

- [ ] **Step 5: 집중 검증**

  Run: `npm test -- src/features/notes/notesSlashCommands.test.ts src/features/notes/NoteTextField.test.tsx src/features/notes/NotesBulletMenu.test.tsx`

  Expected: PASS.

---

## Task 5: 행/페이지 To-do UI, 빈 블릿, 직접 자식 진행률

**Files:**

- Create: `src/features/notes/notesTodoProgress.ts`
- Create: `src/features/notes/TodoProgressIndicator.tsx`
- Create: `src/features/notes/notesTodoProgress.test.ts`
- Create: `src/features/notes/TodoProgressIndicator.test.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPageHeader.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/notes.css`
- Modify tests: `src/features/notes/NotesWorkspace.test.tsx`, `src/features/notes/NotesPageHeader.test.tsx`, `src/features/notes/outlineRowMemo.test.tsx`

- [ ] **Step 1: 진행률 계산 실패 테스트 작성**

  `directTodoProgress(parentId, nodesById, childIdsByParent)`가 직접 자식의 `markerKind === "todo"`만 집계하고 손자 및 일반 완료 블릿을 제외하며, `0/0`이면 `null`인 테스트를 추가한다.

- [ ] **Step 2: 진행률 컴포넌트 구현**

  저장 상태 없이 `{done,total}`을 받아 접근 가능한 `<progress>`/label을 렌더한다. 미완료는 `var(--danger)`, 완료는 `var(--success)`를 사용하고 `(done/total)`만 표시한다.

- [ ] **Step 3: outline row 실패 테스트 작성**

  다음 DOM/동작을 `NotesWorkspace.test.tsx`에 고정한다.

  - 진짜 빈 일반 블릿은 비포커스에서 dot이 숨겨지고 focus-within에서 나타난다.
  - title/note/attachment/child 중 하나라도 있으면 일반 dot은 유지된다.
  - To-do는 체크박스가 항상 보이고, 메뉴/zoom bullet은 동일한 고정 열을 차지한다.
  - 체크 클릭은 기존 `toggleComplete`를 사용한다.
  - To-do Enter 및 마지막 note Shift+Enter는 unchecked To-do sibling을 만든다.
  - 사용자 note가 있으면 progress가 note 다음, 없으면 title 다음에 위치한다.

- [ ] **Step 4: outline row 최소 구현**

  `data-marker-kind`, `data-empty-bullet`을 추가하고 To-do checkbox를 별도 grid column에 렌더한다. To-do grid는 menu/arrow/zoom/checkbox/title 열을 항상 예약해 hover/focus 때 제목이 이동하지 않게 한다. 빈 블릿 숨김은 dot opacity/pointer state만 바꿔 hit area와 레이아웃은 유지한다.

- [ ] **Step 5: page header 실패 테스트 및 구현**

  zoom root가 To-do이면 제목 앞 checkbox가 표시되고 완료 토글이 동작하며, 직계 자식 진행률과 사용자 note 순서가 body row와 같음을 테스트하고 구현한다.

- [ ] **Step 6: hover/focus 및 테마 CSS 구현**

  idle To-do는 checkbox만 보이며 `.notes-node-main:hover`, `:focus-within`, menu open 상태에서 기존 menu/zoom controls를 노출한다. 파란 outline을 새로 만들지 않고 기존 focus-visible 계약을 보존한다. light/dark 모두 `--danger`/`--success` 토큰을 사용한다.

- [ ] **Step 7: 메모/재렌더 경계 확인**

  진행률은 `childIdsByParent[nodeId]`와 해당 자식 노드만 읽도록 하고 별도 전역 구독을 추가하지 않는다. `outlineRowMemo.test.tsx`에서 관련 없는 노드 draft가 To-do 행을 재렌더링하지 않음을 확인한다.

- [ ] **Step 8: 집중 검증**

  Run: `npm test -- src/features/notes/notesTodoProgress.test.ts src/features/notes/NotesTodoProgress.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/outlineRowMemo.test.tsx`

  Expected: PASS.

---

## Task 6: 회귀 검증 및 사용자 환경 수준 데스크톱 스모크

**Files:**

- Modify only if failures reveal a scoped defect.

- [ ] **Step 1: 포맷**

  Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`

  If it fails only for changed Rust files, run `cargo fmt --manifest-path src-tauri/Cargo.toml` and re-check.

- [ ] **Step 2: 전체 자동 검증**

  Run: `cargo test --manifest-path src-tauri/Cargo.toml`

  Run: `npm test`

  Run: `npm run lint`

  Run: `npm run build`

  Run: `npm run test:architecture`

  Run: `git diff --check`

  Expected: all PASS.

- [ ] **Step 3: 합리적 데스크톱 스모크**

  격리된 임시 vault에서 개발 앱을 새로 실행하고 한 번씩만 확인한다.

  1. 빈 일반 블릿 dot이 blur/focus에서 숨김/표시된다.
  2. bullet menu와 `/To-do` 두 경로가 To-do로 변환되고 Undo 한 번으로 원복된다.
  3. To-do Enter와 마지막 note Shift+Enter가 unchecked To-do sibling을 만든다.
  4. idle/hover/focus에서 title 위치가 움직이지 않는다.
  5. 직접 자식 2/3은 붉은 bar, 3/3은 녹색 bar이며 손자 To-do는 분모에 포함되지 않는다.
  6. 앱 재실행과 Topic 재동기화 후 marker/완료 상태가 유지된다.

  고부하, 다중 장치, 장시간 soak는 개인 노트북 수동 검증 범위에서 제외하고 자동 테스트 계약으로 대체한다.

- [ ] **Step 4: 최종 자체 리뷰**

  `git diff --stat`, `git diff --name-only`, `git status --short`로 변경 범위와 사용자 파일 보존을 확인한다. 설계의 네 상태 조합, direct-only 집계, 무자동문구, 단일 Undo, image node 지원을 체크한다.
