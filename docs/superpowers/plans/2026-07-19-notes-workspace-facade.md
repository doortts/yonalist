# Notes Workspace Facade 축소 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Yonalist workflow:** REQUIRED PROJECT SKILL: Read and apply `.agents/skills/delivering-yonalist-changes/SKILL.md` before implementation.

**Goal:** `useNotesWorkspace.ts`를 공개 facade와 조합 책임만 남긴 1,500줄 이하로 줄이고, 기능별 controller 테스트로 13,591줄 통합 테스트와 mock 호출 순서 의존성을 축소한다.

**Architecture:** 기존 public hook과 세 context slice 계약은 유지한다. 먼저 공유 타입과 순수 projection을 옮겨 순환 import를 끊고, 현재 hook closure의 연속된 책임을 session/history/library/attachment/selection hook으로 추출한다. controller는 새로운 전역 store나 event bus를 만들지 않고 기존 ref·reducer·coordinator를 조합한다. 테스트는 repository 호출 번호 대신 상태 전이와 의미가 붙은 repository event를 관찰한다.

**Tech Stack:** React 19 hooks, TypeScript 6, Vitest 4, Testing Library, 기존 Notes coordinator/draft/history modules

## 현재 진행 상태 (2026-07-19)

- 공개 `useNotesWorkspace.ts`: `6,184 → 7`줄
- 내부 runtime: `6,051 → 5,148`줄 — controller 분해 목표는 아직 미달
- 추출 모듈: types `373`, projection `125`, command support `452`, deletion registry `122`줄
- `toHaveBeenNthCalledWith`: `14 → 0`, `invocationCallOrder`: `10 → 0`
- indexed `mock.calls[...]`: `155 → 140` — 목표 `≤25` 미달
- 통합 테스트: `21,395`줄 — 목표 `≤5,500` 미달
- 기존 `1.20x` frontend 성능 gate: 8개 실패 — 구현 직전 기준 tree도 같은 8개 실패

따라서 공개 facade와 값 레벨 command 순환 제거는 완료했지만, 내부 runtime/controller와
통합 테스트 분산은 후속 작업이다. 아래 checkbox도 이 구분을 그대로 반영한다.

## Delivery Contract

| Field | Contract |
| --- | --- |
| Goal | `useNotesWorkspace.ts`를 공개 facade 1,500줄 이하로 만들고 테스트의 mock ordinal 결합을 줄인다. |
| Acceptance | facade/controller/test line 예산, mock-order 예산, context identity, Notes 기능 테스트, frontend `1.20x` 성능 gate가 모두 통과한다. |
| Non-goals | Notes 동작·저장 형식·Undo/Redo 의미 변경, 새 상태 프레임워크, oversized class로의 단순 이동은 하지 않는다. |
| Boundaries | React hook/controller, 기존 NotesStore TypeScript API, draft/history/coordinator. IPC payload, Rust, SQLite schema는 바꾸지 않는다. |
| Manual proof | fresh desktop 앱에서 Notes draft 작성 후 Inbox 왕복, Undo/Redo, 이미지 재시도를 한 번씩 수행해 상태 보존을 확인한다. |

## Global Constraints

- `useNotesWorkspace(options)`의 이름, options, `UseNotesWorkspaceResult` 공개 필드는 바꾸지 않는다.
- `stateSlice`, `draftsSlice`, `actionsSlice`의 memo identity 보장과 context 분리 테스트를 유지한다.
- 저장 순서, history entry 경계, vault 전환, stale async 결과 무시, attachment retry/recovery 의미를 바꾸지 않는다.
- `useNotesWorkspace.ts`는 최종 `≤1,500`줄이어야 한다.
- 새 production 파일은 각각 `≤1,500`줄이어야 한다.
- `useNotesWorkspace.test.tsx`는 최종 `≤5,500`줄이어야 한다.
- 위 테스트 파일의 `toHaveBeenNthCalledWith`와 `invocationCallOrder`는 각각 `0`이어야 한다.
- 위 테스트 파일의 indexed `mock.calls[...]` 관찰은 `≤25`이고, 특정 n번째 발생 자체가 제품 의미일 때만 허용한다.
- 전체 test suite의 ordinal/mock-order 관찰 합계는 현재 `283`줄을 넘지 않는다.
- 순서가 제품 동작인 테스트는 삭제하지 않고 semantic event sequence로 옮긴다.
- 기존 Notes frontend 성능 gate `1.20x`를 완화하지 않는다.

---

### Task 1: 공유 타입과 순수 계산을 hook 파일 밖으로 옮긴다

**Files:**

- Create: `src/features/notes/notesWorkspaceTypes.ts`
- Create: `src/features/notes/notesWorkspaceProjection.ts`
- Create: `src/features/notes/notesWorkspaceProjection.test.ts`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/features/notes/notesCommands.ts`
- Modify: imports under `src/features/notes/**/*.test.ts*`

- [x] **Step 1: 새 모듈의 공개 계약을 요구하는 실패 테스트를 작성한다**

```ts
import {
  authoritative,
  scopedActiveDelta,
  unwrapNotesMutation
} from "./notesWorkspaceProjection";
import type {
  NotesWorkspaceActions,
  UseNotesWorkspaceResult
} from "./notesWorkspaceTypes";

it("기존 mutation projection 의미를 보존한다", () => {
  expect(authoritative(workspace, { selectedId: "root" })).toMatchObject({
    workspace,
    uiUpdate: { selectedId: "root" }
  });
});
```

- [x] **Step 2: 새 모듈 부재로 실패하는지 확인한다**

Run: `npx vitest run src/features/notes/notesWorkspaceProjection.test.ts`

Expected: module 부재로 FAIL.

- [x] **Step 3: 공개 타입을 `notesWorkspaceTypes.ts`로 이동한다**

다음 선언을 동작 변경 없이 이동한다.

- `NotesDeleteAllOptions`, `NotesDeleteAllResult`
- `NotesWorkspaceActions`, `NotesLibraryView`
- `NotesWorkspaceCompoundOptions`, `UseNotesWorkspaceOptions`
- prepared move/selection 관련 interface와 result type
- `NotesStateSlice`, `NotesDraftsSlice`, `NotesActionsSlice`
- `UseNotesWorkspaceResult`, `UseNotesWorkspaceHookResult`
- `NotesNodeDraft`, `StructuralCommandOptions`
- queue/navigation/tag origin 관련 공유 interface

`useNotesWorkspace.ts`는 기존 import 경로 호환을 위해 이 타입들을 re-export한다.

```ts
export type {
  NotesWorkspaceActions,
  UseNotesWorkspaceOptions,
  UseNotesWorkspaceResult
} from "./notesWorkspaceTypes";
```

- [x] **Step 4: 순수 helper를 `notesWorkspaceProjection.ts`로 이동한다**

mutation unwrap/projection, scope 계산, history argument, expansion 계산, lifecycle navigation, prepared move 비교처럼 React state를 읽지 않는 함수들을 이동한다. 전역 recovery registry와 React hook 내부 state는 이동하지 않는다. `notesCommands.ts`는 더 이상 `useNotesWorkspace.ts`에서 type/value를 import하지 않고 새 두 모듈만 import한다.

- [ ] **Step 5: 순환 import가 없는지 검사한다**

Run: `rg -n 'from "\./useNotesWorkspace"' src/features/notes --glob '!useNotesWorkspace.test.tsx'`

Expected: production 파일 출력 0줄.

- [x] **Step 6: 관련 테스트와 타입 검사를 실행한다**

Run: `npx vitest run src/features/notes/notesWorkspaceProjection.test.ts src/features/notes/useNotesWorkspace.test.tsx && npx tsc --noEmit`

Expected: PASS, public re-export를 사용하는 기존 테스트 compile PASS.

- [x] **Step 7: 순수 계약 추출을 커밋한다**

```bash
git add \
  src/features/notes/notesWorkspaceTypes.ts \
  src/features/notes/notesWorkspaceProjection.ts \
  src/features/notes/notesWorkspaceProjection.test.ts \
  src/features/notes/useNotesWorkspace.ts \
  src/features/notes/notesCommands.ts \
  src/features/notes/useNotesWorkspace.test.tsx
git commit -m "refactor(notes): extract workspace contracts and projections"
```

### Task 2: mock 번호 대신 의미를 기록하는 test harness를 만든다

**Files:**

- Create: `src/features/notes/testing/notesWorkspaceTestHarness.tsx`
- Create: `src/features/notes/testing/notesWorkspaceTestHarness.test.tsx`
- Modify: `src/features/notes/useNotesWorkspace.test.tsx`

- [x] **Step 1: repository event journal의 실패 테스트를 작성한다**

```ts
const base = createNotesTestRepository();
const { repository, events } = journalNotesRepository(base);

await repository.updateNode("/vault", "root", { title: "A", note: "" }, history);

expect(events.for("updateNode")).toEqual([
  expect.objectContaining({
    operation: "updateNode",
    vaultRoot: "/vault",
    nodeId: "root",
    historyEntryId: history.entryId
  })
]);
```

- [x] **Step 2: 구현 전 실패를 확인한다**

Run: `npx vitest run src/features/notes/testing/notesWorkspaceTestHarness.test.tsx`

Expected: module 부재로 FAIL.

- [x] **Step 3: 테스트 전용 fixture와 journal을 구현한다**

```ts
export interface NotesRepositoryEvent {
  operation: keyof NotesStore;
  vaultRoot: string | null;
  nodeId: NoteId | null;
  historyEntryId: string | null;
  input: unknown;
}

export interface NotesRepositoryEvents {
  readonly all: readonly NotesRepositoryEvent[];
  for(operation: keyof NotesStore): readonly NotesRepositoryEvent[];
  clear(): void;
}
```

기존 `node`, `workspace`, `attachment`, `deferred`, `repository`, hook render 준비 코드를 test helper로 이동한다. journal은 method 호출 시점에 operation과 의미 필드를 기록하고 원래 mock을 호출한다. wrapper는 method별로 한 번만 만들어 같은 함수 identity를 유지한다.

- [x] **Step 4: 제품 순서와 mock 내부 순서를 구분하는 규칙을 test helper 주석에 고정한다**

- 독립 호출의 존재/입력: `events.for("operation")`과 상태 결과를 사용
- history grouping: `historyEntryId`의 같음/다름을 비교
- 실제 저장 선후관계: `events.all`의 의미 operation sequence를 사용
- Vitest `invocationCallOrder`, `toHaveBeenNthCalledWith`: 사용 금지
- indexed `mock.calls`: Blob identity나 deferred resolver처럼 journal로 표현할 수 없고 n번째 발생이 제품 계약인 경우만 허용

- [x] **Step 5: 통합 테스트의 대표 10개 ordinal assertion을 journal로 바꾼다**

history text→split, text→toggle, update→undo, archive ordering, multi-import retry 사례를 먼저 바꾼다. assertion 수나 stale-result coverage는 줄이지 않는다.

- [x] **Step 6: helper 테스트와 통합 테스트를 실행한다**

Run: `npx vitest run src/features/notes/testing/notesWorkspaceTestHarness.test.tsx src/features/notes/useNotesWorkspace.test.tsx`

Expected: PASS.

- [x] **Step 7: harness를 커밋한다**

```bash
git add src/features/notes/testing src/features/notes/useNotesWorkspace.test.tsx
git commit -m "test(notes): add semantic workspace event journal"
```

### Task 3: history 책임을 독립 controller로 추출한다

**Files:**

- Create: `src/features/notes/useNotesHistoryController.ts`
- Create: `src/features/notes/useNotesHistoryController.test.tsx`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/features/notes/useNotesWorkspace.test.tsx`

- [ ] **Step 1: history controller 경계의 실패 테스트를 먼저 옮겨 작성한다**

다음 동작을 focused test로 만든다.

- 연속 title draft는 한 history entry로 묶임
- title과 note field 전환은 entry를 나눔
- structural command 전에 text burst를 닫음
- undo/redo 후 workspace, focus, expansion을 함께 복원
- stale vault/session의 history 결과를 현재 화면에 적용하지 않음

assertion은 state와 semantic journal의 `historyEntryId`만 사용한다.

- [ ] **Step 2: controller 부재로 실패하는지 확인한다**

Run: `npx vitest run src/features/notes/useNotesHistoryController.test.tsx`

Expected: module 부재로 FAIL.

- [ ] **Step 3: history 전용 입력과 반환 계약을 구현한다**

```ts
export interface NotesHistoryController {
  beginTextEntry: NotesCommandContext["beginTextEntry"];
  settleInlineTextEntry: NotesCommandContext["settleInlineTextEntry"];
  runStructuralCommand: NotesCommandContext["runStructuralCommand"];
  rememberHistoryAfter: NotesCommandContext["rememberHistoryAfter"];
  closeTextBurst(): void;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

export function useNotesHistoryController(
  deps: NotesHistoryControllerDependencies
): NotesHistoryController;
```

dependencies에는 기존 block이 실제로 읽는 session record/ref, navigation snapshot, workspace state ref, reducer dispatch, expansion ref, repository만 둔다. controller가 library나 attachment API 전체를 받지 않게 한다.

- [ ] **Step 4: 기존 history callback block을 그대로 이동한 뒤 facade에서 조합한다**

이동 대상은 snapshot capture, owner register/complete/discard, text/structural entry, history replay, `undo`, `redo`다. 먼저 이름과 dependency array를 보존하고, 통과 후에만 중복 helper를 합친다.

- [ ] **Step 5: 기존 통합 history test를 focused test로 이동한다**

focused test로 완전히 대체된 `describe` block은 원본에서 삭제한다. App 수준 context identity와 history+attachment 같이 경계를 넘는 사례만 통합 파일에 남긴다.

- [ ] **Step 6: history 및 전체 hook 테스트를 실행한다**

Run: `npx vitest run src/features/notes/useNotesHistoryController.test.tsx src/features/notes/useNotesWorkspace.test.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx`

Expected: PASS.

- [ ] **Step 7: 첫 controller slice를 fresh desktop 앱에서 확인한다**

실행 중인 앱을 UI에서 완전히 종료하고 격리 Vault로 새 release bundle을 실행한다.

```bash
HISTORY_SMOKE_VAULT=$(mktemp -d /tmp/yonalist-history-smoke.XXXXXX)
npm run tauri:build
shasum -a 256 src-tauri/target/release/bundle/macos/Yonalist.app/Contents/MacOS/Yonalist
open -n src-tauri/target/release/bundle/macos/Yonalist.app
```

`HISTORY_SMOKE_VAULT` 출력 경로를 Vault로 설정하고 새 note의 title/body를 편집한 뒤
Undo/Redo를 수행한다. text burst grouping과 focus 복원이 정상인지 확인한다. 기존
Vault 설정을 복원하고 test Vault는 Finder의 휴지통으로 이동한다. 첫 unexplained
runtime 실패는 Web Inspector/Tauri log를 확인하며, 같은 증상의 두 번째 실패 뒤에는
추가 patch 대신 새 증거를 수집한다.

- [ ] **Step 8: history 추출을 커밋한다**

```bash
git add src/features/notes/useNotesHistoryController.ts src/features/notes/useNotesHistoryController.test.tsx src/features/notes/useNotesWorkspace.ts src/features/notes/useNotesWorkspace.test.tsx
git commit -m "refactor(notes): extract history controller"
```

### Task 4: library scope와 검색 navigation을 독립 controller로 추출한다

**Files:**

- Create: `src/features/notes/useNotesLibraryController.ts`
- Create: `src/features/notes/useNotesLibraryController.test.tsx`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/features/notes/useNotesWorkspace.test.tsx`

- [ ] **Step 1: library controller focused test를 작성한다**

필수 상태 전이는 `all/starred/archive/trash`, tag filter toggle, search 결과 open, 빠른 scope 전환에서 이전 응답 무시, zoom root 제거 후 fallback이다. repository 호출 ordinal이 아니라 최종 scope/view/filter/selection과 event의 입력 scope를 검증한다.

- [ ] **Step 2: 구현 전 실패를 확인한다**

Run: `npx vitest run src/features/notes/useNotesLibraryController.test.tsx`

Expected: module 부재로 FAIL.

- [ ] **Step 3: controller 계약을 구현한다**

```ts
export interface NotesLibraryController {
  libraryView: NotesLibraryView;
  activeTagFilters: readonly NoteTagFilter[];
  searchResults: readonly NoteSearchResult[];
  selectLibraryView(view: NotesLibraryView): Promise<void>;
  toggleTagFilter(filter: NoteTagFilter): Promise<void>;
  searchNotes(query: string): Promise<void>;
  openSearchResult(result: NoteSearchResult): Promise<void>;
  zoomTo(nodeId: NoteId | null): void;
  requestTagSummaryRefresh(): void;
}
```

scope와 request generation ref는 이 controller가 소유한다. session/command에서 필요한 live scope는 반환한 ref 하나로 공유한다. view, requested filters, origin을 서로 다른 소유자에 중복 저장하지 않는다.

- [ ] **Step 4: 기존 library callback block과 test를 이동한다**

`loadLibraryScope`, `selectLibraryView`, `toggleTagFilter`, `searchNotes`, `openSearchResult`, tag-summary refresh pump, zoom transition을 이동한다. public actions 이름은 그대로 facade에 연결한다.

- [ ] **Step 5: focused 및 통합 테스트를 실행한다**

Run: `npx vitest run src/features/notes/useNotesLibraryController.test.tsx src/features/notes/useNotesWorkspace.test.tsx`

Expected: PASS.

- [ ] **Step 6: library 추출을 커밋한다**

```bash
git add src/features/notes/useNotesLibraryController.ts src/features/notes/useNotesLibraryController.test.tsx src/features/notes/useNotesWorkspace.ts src/features/notes/useNotesWorkspace.test.tsx
git commit -m "refactor(notes): extract library controller"
```

### Task 5: attachment import/retry/recovery를 독립 workflow hook으로 추출한다

**Files:**

- Create: `src/features/notes/useNotesAttachmentWorkflow.ts`
- Create: `src/features/notes/useNotesAttachmentWorkflow.test.tsx`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/features/notes/useNotesWorkspace.test.tsx`

- [ ] **Step 1: attachment workflow focused test를 작성한다**

다음 경계값과 레이스를 포함한다.

- 단일 파일·batch bytes 제한
- 동일 anchor import ordering
- path/clipboard/drop 입력의 동일한 node insertion 의미
- 일부 실패 후 retry가 원래 Blob/history context를 보존
- vault 전환 중 완료된 import가 이전 vault에만 반영
- teardown recovery와 성공 후 reservation 해제
- view/download/resize/remove의 stale attachment 방어

batch n번째 호출 내부 구조 대신 event의 node ids, anchor, history entry와 최종 workspace를 검증한다.

- [ ] **Step 2: 구현 전 실패를 확인한다**

Run: `npx vitest run src/features/notes/useNotesAttachmentWorkflow.test.tsx`

Expected: module 부재로 FAIL.

- [ ] **Step 3: workflow 공개 계약을 구현한다**

```ts
export interface NotesAttachmentWorkflow {
  attachmentUploadError: string | null;
  importImagePaths(paths: readonly string[], anchor: ImageNodeInsertionAnchor): Promise<void>;
  importClipboardImages(items: readonly PendingImageNodeByteItem[], anchor: ImageNodeInsertionAnchor): Promise<void>;
  importDroppedImagePaths(paths: readonly string[], anchor: ImageNodeInsertionAnchor): Promise<void>;
  uploadImage(nodeId: NoteId): Promise<void>;
  retryImageUpload(attemptId: string): Promise<void>;
  loadAttachmentBytes(attachmentId: string): Promise<Uint8Array | null>;
  viewImageOriginal(attachmentId: string): Promise<void>;
  downloadImage(attachmentId: string): Promise<void>;
  resizeImage(attachmentId: string, displayWidth: number): Promise<void>;
  removeImage(attachmentId: string): Promise<void>;
  discardPendingAttempts(): void;
}
```

기존 process-wide recovery registry helper는 이 파일로 이동하되 API surface는 `resetImageImportRecoveryForTests` 하나만 re-export한다. `notesAttachmentController.ts`의 native UI boundary와 이름/책임을 섞지 않는다.

- [ ] **Step 4: 기존 attachment callback과 recovery helper를 이동한다**

`attachmentUploadError`부터 `removeImage`까지의 연속 block, image import reservation/recovery helper를 이동한다. retry의 원본 `Blob`, history entry, insertion anchor identity를 복사하거나 재생성하지 않는다.

- [ ] **Step 5: 원본 통합 테스트에서 focused 사례를 제거한다**

vault/session/history와 함께 검증해야 하는 최소 end-to-end 사례는 남긴다. path/bytes/drop의 반복 조합과 경계값은 workflow test로 옮긴다.

- [ ] **Step 6: attachment test와 관련 UI test를 실행한다**

Run: `npx vitest run src/features/notes/useNotesAttachmentWorkflow.test.tsx src/features/notes/useNotesWorkspace.test.tsx src/features/notes/NotesImageAttachment.test.tsx src/features/notes/NotesAttachmentList.test.tsx`

Expected: PASS.

- [ ] **Step 7: attachment 추출을 커밋한다**

```bash
git add src/features/notes/useNotesAttachmentWorkflow.ts src/features/notes/useNotesAttachmentWorkflow.test.tsx src/features/notes/useNotesWorkspace.ts src/features/notes/useNotesWorkspace.test.tsx
git commit -m "refactor(notes): extract attachment workflow"
```

### Task 6: workspace session 수명주기를 독립 controller로 추출한다

**Files:**

- Create: `src/features/notes/useNotesWorkspaceSession.ts`
- Create: `src/features/notes/useNotesWorkspaceSession.test.tsx`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/features/notes/useNotesWorkspace.test.tsx`

- [ ] **Step 1: session 수명주기 focused test를 작성한다**

초기화 성공/실패, StrictMode 이중 effect, vault 전환, buffered startup command, pending draft flush, teardown 중 stale settlement, delete-all participant 조정을 검증한다. assertion은 active vault state와 semantic events를 사용한다.

- [ ] **Step 2: 구현 전 실패를 확인한다**

Run: `npx vitest run src/features/notes/useNotesWorkspaceSession.test.tsx`

Expected: module 부재로 FAIL.

- [ ] **Step 3: session controller가 소유할 값을 명시한다**

```ts
export interface NotesWorkspaceSessionController {
  state: NormalizedNotesWorkspace;
  stateRef: MutableRefObject<NormalizedNotesWorkspace>;
  sessionRef: MutableRefObject<NotesWorkspaceCoordinatorSession | null>;
  sessionRecordRef: MutableRefObject<NotesWorkspaceSessionRecord | null>;
  draftEngine: NotesDraftEngine;
  runCommand: RunNotesWorkspaceCommand;
  deleteAllNotesData(options?: NotesDeleteAllOptions): Promise<NotesDeleteAllResult>;
  loading: boolean;
  error: NotesStoreError | null;
}
```

repository initialize/load, coordinator session open/close, draft subscriptions, delete-database process coordination을 이 controller가 소유한다. library/history/attachment의 사용자 action은 소유하지 않는다.

- [ ] **Step 4: effect와 subscription block을 이동한다**

hook 시작부의 session refs/reducer, data deletion subscription, draft engine listeners, initialize/open/cleanup effects, `runCommand`, delete-all을 옮긴다. cleanup ordering과 generation check를 그대로 유지한다.

- [ ] **Step 5: session test와 통합 test를 실행한다**

Run: `npx vitest run src/features/notes/useNotesWorkspaceSession.test.tsx src/features/notes/useNotesWorkspace.test.tsx`

Expected: PASS under normal mode and StrictMode.

- [ ] **Step 6: session 추출을 커밋한다**

```bash
git add src/features/notes/useNotesWorkspaceSession.ts src/features/notes/useNotesWorkspaceSession.test.tsx src/features/notes/useNotesWorkspace.ts src/features/notes/useNotesWorkspace.test.tsx
git commit -m "refactor(notes): extract workspace session controller"
```

### Task 7: selection authority를 추출하고 facade를 1,500줄 이하로 완성한다

**Files:**

- Create: `src/features/notes/useNotesSelectionController.ts`
- Create: `src/features/notes/useNotesSelectionController.test.tsx`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/features/notes/notesCommands.ts`
- Modify: `src/features/notes/useNotesWorkspace.test.tsx`
- Modify: `src/features/notes/notesWorkspaceContextSplit.test.tsx`

- [ ] **Step 1: selection authority의 focused test를 작성한다**

anchor/head range, selection revision, prepare 후 외부 mutation, move dependency load, stale prepared move commit, batch selection preservation/clear를 검증한다.

- [ ] **Step 2: 구현 전 실패를 확인한다**

Run: `npx vitest run src/features/notes/useNotesSelectionController.test.tsx`

Expected: module 부재로 FAIL.

- [ ] **Step 3: selection controller 계약을 구현한다**

```ts
export interface NotesSelectionController {
  selection: NotesSelection;
  setSelectionAnchor(nodeId: NoteId): void;
  extendSelectionTo(nodeId: NoteId): void;
  clearSelection(): void;
  replaceSelection(nodeIds: readonly NoteId[]): void;
  getSelectionSnapshot(): NotesSelection;
  prepareSelectionAuthority(): Promise<NotesPreparedSelectionAuthority>;
  applyPreparedSelectionBatch(
    authority: NotesPreparedSelectionAuthority,
    options: NotesPreparedSelectionBatchOptions
  ): Promise<NotesWorkspaceCommandOutcome>;
  prepareMoveNode(nodeId: NoteId): Promise<NotesPreparedMove | null>;
  commitPreparedMove(move: NotesPreparedMove): Promise<NotesPreparedMoveCommitResult>;
}
```

- [ ] **Step 4: facade에는 조합과 public slice memo만 남긴다**

`useNotesWorkspace`의 본문은 controller 호출, 기존 `notesCommands` delegate, public action 조합, 세 slice `useMemo`, merged result 반환만 수행한다. 새로운 class/factory/service locator를 추가하지 않는다.

```ts
export function useNotesWorkspace(
  options: UseNotesWorkspaceOptions
): UseNotesWorkspaceHookResult {
  const session = useNotesWorkspaceSession(options);
  const history = useNotesHistoryController(session.historyDependencies);
  const library = useNotesLibraryController(session.libraryDependencies);
  const attachments = useNotesAttachmentWorkflow({
    ...session.attachmentDependencies,
    runStructuralCommand: history.runStructuralCommand
  });
  const selection = useNotesSelectionController({
    ...session.selectionDependencies,
    runStructuralCommand: history.runStructuralCommand
  });
  return result;
}
```

`historyDependencies`, `libraryDependencies`, `attachmentDependencies`,
`selectionDependencies`는 controller가 실제로 소비하는 ref/callback만 포함한 memoized
object다. facade가 임의로 다시 조립하지 않도록 session controller의 반환 interface에
필드와 타입을 명시한다. `result`는 바로 아래에서 기존 command delegate와 세 memoized
slice를 조합해 선언한다.

- [ ] **Step 5: context identity 회귀 test를 먼저 통과시킨다**

Run: `npx vitest run src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/useNotesWorkspace.test.tsx src/features/notes/useNotesSelectionController.test.tsx`

Expected: draft 변경 시 actions/state context의 불필요한 render 증가 없음, PASS.

- [ ] **Step 6: production 파일 line budget을 확인한다**

Run:

```bash
wc -l \
  src/features/notes/useNotesWorkspace.ts \
  src/features/notes/notesWorkspaceTypes.ts \
  src/features/notes/notesWorkspaceProjection.ts \
  src/features/notes/useNotesHistoryController.ts \
  src/features/notes/useNotesLibraryController.ts \
  src/features/notes/useNotesAttachmentWorkflow.ts \
  src/features/notes/useNotesWorkspaceSession.ts \
  src/features/notes/useNotesSelectionController.ts
```

Expected: 모든 행의 count `≤1500`.

- [ ] **Step 7: facade 완성을 커밋한다**

```bash
git add \
  src/features/notes/useNotesSelectionController.ts \
  src/features/notes/useNotesSelectionController.test.tsx \
  src/features/notes/useNotesWorkspaceSession.ts \
  src/features/notes/useNotesWorkspace.ts \
  src/features/notes/notesCommands.ts \
  src/features/notes/useNotesWorkspace.test.tsx \
  src/features/notes/notesWorkspaceContextSplit.test.tsx
git commit -m "refactor(notes): reduce workspace hook to facade"
```

### Task 8: 통합 테스트를 경계 테스트로 분산하고 순서 결합을 예산 안으로 줄인다

**Files:**

- Modify: `src/features/notes/useNotesWorkspace.test.tsx`
- Modify: `src/features/notes/useNotesHistoryController.test.tsx`
- Modify: `src/features/notes/useNotesLibraryController.test.tsx`
- Modify: `src/features/notes/useNotesAttachmentWorkflow.test.tsx`
- Modify: `src/features/notes/useNotesWorkspaceSession.test.tsx`
- Modify: `src/features/notes/useNotesSelectionController.test.tsx`
- Create: `scripts/checkNotesWorkspaceBudgets.mjs`
- Create: `scripts/checkNotesWorkspaceBudgets.test.ts`
- Modify: `package.json`

- [ ] **Step 1: 현재 목표를 위반하는 fixture test를 작성한다**

검사기는 전달받은 파일 text에서 line 수와 다음 정규식 일치 line 수를 센다.

```js
/toHaveBeenNthCalledWith/g
/invocationCallOrder/g
/mock\.calls\s*\[/g
```

fixture별로 `1501`줄 production, `5501`줄 integration test, nth 1개, invocation 1개, indexed call 26개가 각각 실패하는지 검증한다.

- [ ] **Step 2: 검사기 부재로 실패하는지 확인한다**

Run: `npx vitest run scripts/checkNotesWorkspaceBudgets.test.ts`

Expected: module 부재로 FAIL.

- [ ] **Step 3: 표준 라이브러리만 사용하는 검사기를 구현한다**

실제 검사 대상과 예산은 코드에 명시한다.

```text
useNotesWorkspace.ts                         lines <= 1500
new production modules                      each lines <= 1500
useNotesWorkspace.test.tsx                  lines <= 5500
useNotesWorkspace.test.tsx nth              = 0
useNotesWorkspace.test.tsx invocation       = 0
useNotesWorkspace.test.tsx indexed calls    <= 25
all test ordinal/mock-order observation     <= 283
```

전체 suite 합계는 `toHaveBeenNthCalledWith`, `invocationCallOrder`, indexed `mock.calls[`가 나타나는 line의 합이다.

- [ ] **Step 4: 남은 controller 전용 describe block을 focused test로 이동한다**

통합 파일에는 다음만 남긴다.

- controller 사이를 가로지르는 end-to-end command settlement
- public merged result와 세 slice identity
- vault 전환 중 history/draft/attachment 동시 레이스
- delete-all의 여러 participant 조정
- 실제 n번째 발생이 의미인 최대 25개 indexed observation

- [x] **Step 5: 남은 nth/invocation assertion을 semantic journal로 교체한다**

Run: `node scripts/checkNotesWorkspaceBudgets.mjs`

Expected:

```text
useNotesWorkspace.ts lines<=1500 PASS
useNotesWorkspace.test.tsx lines<=5500 PASS
nth=0 invocation=0 indexed<=25 PASS
all-test-order-observations<=283 PASS
```

- [ ] **Step 6: architecture script를 package script로 연결한다**

```json
"test:architecture": "node scripts/checkNotesWorkspaceBudgets.mjs"
```

- [ ] **Step 7: 테스트 구조 정리를 커밋한다**

```bash
git add \
  src/features/notes/useNotesWorkspace.test.tsx \
  src/features/notes/useNotesHistoryController.test.tsx \
  src/features/notes/useNotesLibraryController.test.tsx \
  src/features/notes/useNotesAttachmentWorkflow.test.tsx \
  src/features/notes/useNotesWorkspaceSession.test.tsx \
  src/features/notes/useNotesSelectionController.test.tsx \
  scripts/checkNotesWorkspaceBudgets.mjs \
  scripts/checkNotesWorkspaceBudgets.test.ts \
  package.json
git commit -m "test(notes): replace mock ordinals with semantic events"
```

### Task 9: 기능·구조·성능 회귀를 최종 검증한다

**Files:**

- Create: `docs/superpowers/reports/2026-07-19-notes-workspace-facade-verification.md`

- [ ] **Step 1: 구조 예산과 TypeScript 검사를 실행한다**

Run: `npm run test:architecture && npx tsc --noEmit`

Expected: 모든 line/mock budget PASS, typecheck PASS.

- [x] **Step 2: Notes 전체 기능 테스트를 실행한다**

Run: `npx vitest run src/features/notes`

Expected: 기존 documented skip 외 실패 0.

- [ ] **Step 3: frontend Notes 성능 gate를 단일 worker로 실행한다**

Run: `NOTES_PERF=1 npx vitest run src/features/notes/notesExpansion.performance.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism`

Expected: 27/27 checks PASS, 최고 normalized ratio `≤1.20x`.

- [ ] **Step 4: 동결된 diff를 fresh desktop 앱에서 최종 확인한다**

실행 중인 앱을 완전히 종료하고 다음 명령으로 격리 Vault와 새 bundle을 만든다.

```bash
FINAL_SMOKE_VAULT=$(mktemp -d /tmp/yonalist-facade-smoke.XXXXXX)
npm run tauri:build
shasum -a 256 src-tauri/target/release/bundle/macos/Yonalist.app/Contents/MacOS/Yonalist
open -n src-tauri/target/release/bundle/macos/Yonalist.app
```

`FINAL_SMOKE_VAULT` 출력 경로를 사용해 draft 작성 후 Inbox 왕복, Undo/Redo, 실패한
이미지 import 재시도를 각각 한 번 수행한다. 상태 보존과 recovery를 확인한 뒤 원래
Vault 설정을 복원하고 test Vault는 Finder의 휴지통으로 이동한다.

- [x] **Step 5: frontend 최종 gate를 한 번 실행한다**

Run: `npm test && npm run lint && npm run build && git diff --check`

Expected: frontend 실패 0, 기존 documented skip만 남고 whitespace 오류 0. Rust, IPC
payload, persistence, native configuration은 바뀌지 않으므로 Cargo test, Rust
formatting, Clippy는 실행하지 않고 검증 보고서에 제외 이유를 기록한다.

- [x] **Step 6: 검증 보고서에 정확한 before/after를 기록한다**

보고서 표에는 `useNotesWorkspace.ts` 4,959줄, 통합 테스트 13,591줄, nth 14줄,
invocation order 10줄, indexed call 125줄, 전체 순서 관찰 283줄의 baseline과 각
검증 명령이 출력한 최종 정수를 나란히 기록한다. 최종값은 command output을 그대로
옮기며 추정값을 쓰지 않는다. 각 gate는 위 Global Constraints의 값을 사용한다.

- [x] **Step 7: 최종 검증을 커밋한다**

```bash
git add docs/superpowers/reports/2026-07-19-notes-workspace-facade-verification.md
git commit -m "docs: verify notes workspace facade refactor"
```

## 완료 판정

- [ ] facade와 모든 새 production 파일이 각각 1,500줄 이하다.
- [ ] 통합 테스트가 5,500줄 이하이고 nth/invocation 관찰은 0이다.
- [ ] indexed `mock.calls`는 25개 이하이며 허용 이유가 각 test 이름에 드러난다.
- [x] 전체 test suite 순서 관찰 합계가 283을 넘지 않는다.
- [x] 세 context slice의 값과 memo identity 계약이 유지된다.
- [ ] Notes 기능 테스트와 `1.20x` 성능 gate가 통과한다.
