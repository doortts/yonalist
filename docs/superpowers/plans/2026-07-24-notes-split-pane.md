# Notes Split Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notes의 오른쪽 detail 영역을 두 pane으로 나누고, 각 pane에서 서로 다른 페이지를 독립적으로 열며, 단일 또는 다중 선택 블릿을 pane 사이에서 한 번의 원자적 변경과 한 개의 공용 Undo 항목으로 이동한다.

**Architecture:** `useNotesWorkspace`와 기존 coordinator, Draft Engine, command queue, history session은 Vault당 하나만 유지한다. 현재 workspace reducer에 섞인 화면 상태를 고정된 `primary | secondary` pane session 두 개로 분리하고, 각 `NotesOutlinePane`은 pane-scoped context를 받는다. `NotesDetailSplitHost`가 split UI, Vault별 localStorage, 두 viewport와 하나의 DnD context를 소유한다. 기존 Rust `moveNode`와 `applyBatch` 계약을 재사용한다.

**Tech Stack:** React 19, TypeScript 6, Vitest, Testing Library, DnD Kit 6/10, CSS Grid/Flex, browser `localStorage`, existing Tauri Notes IPC.

## Global Constraints

- 승인된 계약은 `docs/superpowers/specs/2026-07-24-notes-split-pane-design.md`이다. 구현 편의를 위해 독립 탐색, 공용 Undo, Vault별 복원, 양방향 단일·다중 이동 계약을 축소하지 않는다.
- 구현은 `5455471`에서 만든 격리 worktree와 `codex/notes-split-pane` 브랜치에서 수행한다.
- 현재 main worktree의 사용자 소유 변경인 아래 경로를 수정·복사·스테이징·덮어쓰지 않는다.
  - `src/features/notes/outlineLayoutMotion.ts`
  - `src/features/notes/outlineLayoutMotion.test.ts`
  - `src/features/notes/useOutlineLayoutMotion.test.tsx`
  - `docs/superpowers/plans/2026-07-23-contextual-enter-child.md`
  - `docs/superpowers/plans/2026-07-23-notes-compact-mutation-authority.md`
  - `docs/superpowers/plans/2026-07-23-notes-enter-critical-path.md`
- `NotesWorkspaceProvider`, coordinator session, Draft Engine, write queue와 history timeline은 Vault당 정확히 하나만 만든다. pane마다 `useNotesWorkspace`를 호출하지 않는다.
- 첫 구현은 정확히 `"primary" | "secondary"` 두 pane만 지원한다. 범용 N-pane manager, 새 상태관리 라이브러리, 새 resize dependency, 새 native 설정 저장소를 만들지 않는다.
- `NormalizedNotesWorkspace`의 tree/attachment/status 권위와 pane UI projection을 타입으로 구분한다. 기존 소비자를 한 번에 전부 바꾸지 않도록 `projectPaneWorkspace(data, pane)` 호환 projection을 제공한다.
- split 열기·닫기와 divider 이동은 Notes Undo 항목을 만들지 않는다. 데이터·navigation Undo만 기존 공용 timeline에 기록한다.
- cross-pane drop의 source/destination 화면 효과는 backend settlement가 수용되기 전에 적용하지 않는다. 실패 또는 stale authority이면 preview만 제거한다.
- Archive/Trash, cycle, 최대 깊이, stale target, no-op과 IME 조합 중 structural mutation은 backend 호출 전에 거부한다.
- 현재 Rust `moveNode`와 `applyBatch`가 한 transaction/한 history entry를 보장하지 않는다는 실패 테스트가 생기기 전에는 `src-tauri`, SQLite schema와 IPC 타입을 수정하지 않는다.
- `notesWorkspaceRuntime.ts`, `NotesOutlinePane.tsx`, `useNotesHistoryController.ts`에 새 독립 로직을 계속 누적하지 않는다. pane reducer, persistence, DnD ID/bridge, editing lease는 아래 전용 파일로 추출한다.
- 새 테스트는 wall-clock 성능을 단정하지 않는다. provider/session 생성 수, render 수, backend 호출 수, history entry 수와 상태 전이를 단정한다.
- 각 Task는 RED를 실제로 확인한 뒤 최소 구현으로 GREEN을 만들고, 해당 Task 경로만 커밋한다.

---

## Execution Preflight

- [ ] `superpowers:using-git-worktrees`를 사용해 `5455471` 기준 격리 worktree와 브랜치를 만든다.

  ```bash
  git worktree add ../yonalist-notes-split-pane -b codex/notes-split-pane 5455471
  cd ../yonalist-notes-split-pane
  ```

  Expected: 새 worktree가 clean이고 현재 브랜치는 `codex/notes-split-pane`.

- [ ] 기준 테스트와 파일 예산을 확인한다.

  ```bash
  git status --short
  npm test -- src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/NotesFeature.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/notesHistory.test.ts src/features/notes/outlineDrag.test.ts
  npm run test:architecture
  ```

  Expected: status 출력 없음, 집중 테스트와 architecture gate PASS.

---

### Task 1: 고정된 두 pane 상태와 Vault별 저장 포맷 추가

**Files:**

- Create: `src/features/notes/notesPaneSession.ts`
- Create: `src/features/notes/notesPaneSession.test.ts`
- Create: `src/features/notes/notesSplitLayoutStore.ts`
- Create: `src/features/notes/notesSplitLayoutStore.test.ts`

**Interfaces:**

- Produces: `NotesPaneId`, `NotesPaneSessionState`, `notesPaneSessionReducer()`, `reconcileNotesPaneSession()`.
- Produces: `NotesSplitLayoutStateV1`, `loadNotesSplitLayout()`, `saveNotesSplitLayout()`, `reconcilePersistedSplitLayout()`.
- Consumes: `NoteId`, `NotesHistoryFocusField`, `NotesSelection`, `NormalizedNotesWorkspace`.

- [ ] **Step 1: pane 독립성과 reconcile 실패 테스트 작성**

  `notesPaneSession.test.ts`에 다음 계약을 고정한다.

  ```ts
  const primary = createInitialNotesPaneSession("primary");
  const secondary = createInitialNotesPaneSession("secondary");

  const changedPrimary = notesPaneSessionReducer(primary, {
    type: "setNavigation",
    patch: { zoomRootId: "page-a", selectedId: "child-a" }
  });

  expect(changedPrimary.zoomRootId).toBe("page-a");
  expect(secondary.zoomRootId).toBeNull();
  expect(changedPrimary.navigationVersion).toBe(primary.navigationVersion + 1);
  ```

  추가 표 기반 테스트:

  - selection, expansion, pending focus와 scroll을 한 pane에서 바꿔도 다른 pane reference가 동일하다.
  - 삭제된 `zoomRootId`, selected/editing/focus ID, expansion과 scroll anchor가 reconcile에서 제거된다.
  - 삭제된 zoom page만 `null`로 돌아가고 유효한 다른 pane은 유지된다.
  - selection revision은 해당 pane selection 변경에만 증가한다.

- [ ] **Step 2: persistence 실패 테스트 작성**

  `notesSplitLayoutStore.test.ts`에서 메모리 `Storage`를 사용해 다음을 검증한다.

  ```ts
  saveNotesSplitLayout(storage, "/vault/a", stateA);
  saveNotesSplitLayout(storage, "/vault/b", stateB);

  expect(loadNotesSplitLayout(storage, "/vault/a")).toEqual(stateA);
  expect(loadNotesSplitLayout(storage, "/vault/b")).toEqual(stateB);
  ```

  추가 계약:

  - key는 `yonalist.notesSplitLayout.v1` 하나다.
  - `splitRatio`는 `0.25...0.75`로 clamp한다.
  - 손상된 JSON, 잘못된 version/type, 배열 대신 객체가 온 경우 기본값을 반환한다.
  - ephemeral selection/editing/pending focus는 저장 포맷에 포함하지 않는다.
  - valid workspace로 reconcile할 때 삭제된 페이지·expansion·anchor만 제거한다.

- [ ] **Step 3: RED 확인**

  ```bash
  npm test -- src/features/notes/notesPaneSession.test.ts src/features/notes/notesSplitLayoutStore.test.ts
  ```

  Expected: 새 모듈이 없으므로 FAIL.

- [ ] **Step 4: pane 타입과 reducer 구현**

  `notesPaneSession.ts`의 public shape를 다음으로 고정한다.

  ```ts
  export type NotesPaneId = "primary" | "secondary";

  export interface NotesPaneSessionState {
    readonly paneId: NotesPaneId;
    readonly selectedId: NoteId | null;
    readonly zoomRootId: NoteId | null;
    readonly editingNoteId: NoteId | null;
    readonly pendingFocusId: NoteId | null;
    readonly pendingFocusField: NotesHistoryFocusField | null;
    readonly pendingPrimarySelection: NotesPendingPrimarySelection | null;
    readonly locallyExpandedNodeIds: ReadonlySet<NoteId>;
    readonly selection: NotesSelection | null;
    readonly selectionRevision: number;
    readonly navigationVersion: number;
    readonly scrollAnchorId: NoteId | null;
    readonly scrollOffset: number;
  }

  export type NotesPaneSessionAction =
    | { type: "setNavigation"; patch: Partial<LiveNotesNavigation> }
    | { type: "setExpansion"; nodeIds: ReadonlySet<NoteId> }
    | { type: "setSelection"; selection: NotesSelection | null }
    | {
        type: "setScroll";
        anchorId: NoteId | null;
        offset: number;
      }
    | {
        type: "hydratePersisted";
        navigation: PersistedPaneNavigation;
      }
    | {
        type: "reconcileWorkspace";
        workspace: NormalizedNotesWorkspace;
      };
  ```

  reducer는 `Set`, selection과 patch를 새 값으로 clone하고 실제 변화가 없으면 기존 reference를 반환한다. `navigationVersion`은 navigation/focus/expansion 변화에만 증가시킨다.

- [ ] **Step 5: 최소 localStorage map 구현**

  `notesSplitLayoutStore.ts`는 브라우저 global을 내부에서 숨기지 않고 테스트 가능한 `Storage` 인자를 받는다.

  ```ts
  export const NOTES_SPLIT_LAYOUT_STORAGE_KEY =
    "yonalist.notesSplitLayout.v1";

  export interface NotesSplitLayoutStateV1 {
    readonly splitOpen: boolean;
    readonly splitRatio: number;
    readonly activePaneId: NotesPaneId;
    readonly panes: Record<NotesPaneId, PersistedPaneNavigation>;
  }

  export function loadNotesSplitLayout(
    storage: Pick<Storage, "getItem">,
    vaultRoot: string
  ): NotesSplitLayoutStateV1;

  export function saveNotesSplitLayout(
    storage: Pick<Storage, "getItem" | "setItem">,
    vaultRoot: string,
    state: NotesSplitLayoutStateV1
  ): void;
  ```

  저장 객체는 `{ version: 1, vaults: Record<string, NotesSplitLayoutStateV1> }`만 사용한다. read/write 예외는 Notes 실행을 막지 않고 기본값 또는 no-op으로 처리한다.

- [ ] **Step 6: GREEN과 포맷 확인**

  ```bash
  npm test -- src/features/notes/notesPaneSession.test.ts src/features/notes/notesSplitLayoutStore.test.ts
  npm run lint -- --quiet
  git diff --check
  ```

  Expected: PASS, whitespace 오류 없음.

- [ ] **Step 7: 커밋**

  ```bash
  git add src/features/notes/notesPaneSession.ts src/features/notes/notesPaneSession.test.ts src/features/notes/notesSplitLayoutStore.ts src/features/notes/notesSplitLayoutStore.test.ts
  git commit -m "feat(notes): add split pane state model"
  ```

---

### Task 2: workspace의 화면 상태를 pane session으로 분리하고 primary 동작 보존

**Files:**

- Create: `src/features/notes/useNotesPaneSessions.ts`
- Create: `src/features/notes/NotesPaneScope.tsx`
- Create: `src/features/notes/NotesPaneScope.test.tsx`
- Modify: `src/features/notes/notesWorkspaceReducer.ts`
- Modify: `src/features/notes/notesWorkspaceTypes.ts`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts`
- Modify: `src/features/notes/NotesWorkspaceContext.ts`
- Modify: `src/features/notes/NotesFeature.tsx`
- Modify: `src/features/notes/notesWorkspaceContextSplit.test.tsx`
- Modify: `src/features/notes/useNotesWorkspace.selectionAndProjection.test.tsx`
- Modify: `src/features/notes/outlineRowMemo.test.tsx`
- Modify: `scripts/checkNotesWorkspaceBudgets.mjs`

**Interfaces:**

- Produces: one shared normalized data state, two `NotesPaneRuntimeSlice`s, one `NotesPaneRegistrySlice`.
- Preserves: existing `result.current.state`, `stateSlice`, `draftsSlice`, `actionsSlice` as the primary compatibility projection.
- Preserves: Notes Library reads primary navigation/actions and must not re-render for secondary-only changes.

- [ ] **Step 1: single runtime/two pane 실패 테스트 작성**

  `NotesPaneScope.test.tsx` harness는 `useNotesWorkspace`를 정확히 한 번 호출하고 두 scope probe를 렌더한다.

  ```tsx
  <NotesPaneScope paneId="primary">
    <PaneProbe label="primary" />
  </NotesPaneScope>
  <NotesPaneScope paneId="secondary">
    <PaneProbe label="secondary" />
  </NotesPaneScope>
  ```

  다음을 단정한다.

  - `actions.zoomTo("page-a")`를 primary scope에서 호출하면 primary만 바뀐다.
  - secondary에서 `zoomTo("page-b")`를 호출하면 secondary만 바뀐다.
  - 두 scope의 `state.nodesById`와 `draftsByNodeId`는 같은 authoritative 변경을 본다.
  - secondary selection 변경은 primary selection revision과 Library probe render 수를 바꾸지 않는다.
  - provider/session/repository `initialize`는 한 번만 호출된다.

- [ ] **Step 2: RED 확인**

  ```bash
  npm test -- src/features/notes/NotesPaneScope.test.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx
  ```

  Expected: pane registry/scope가 없으므로 FAIL.

- [ ] **Step 3: data state와 pane projection 타입 분리**

  `notesWorkspaceReducer.ts`에 tree 권위 타입과 호환 projection을 추가한다.

  ```ts
  export type NormalizedNotesWorkspaceData = Omit<
    NormalizedNotesWorkspace,
    | "selectedId"
    | "zoomRootId"
    | "editingNoteId"
    | "pendingFocusId"
    | "pendingFocusField"
  >;

  export function projectPaneWorkspace(
    data: NormalizedNotesWorkspaceData,
    pane: NotesPaneSessionState
  ): NormalizedNotesWorkspace {
    return {
      ...data,
      selectedId: pane.selectedId,
      zoomRootId: pane.zoomRootId,
      editingNoteId: pane.editingNoteId,
      pendingFocusId: pane.pendingFocusId,
      pendingFocusField: pane.pendingFocusField
    };
  }
  ```

  `settleQueueWork`는 data state를 한 번 갱신한 뒤 `useNotesPaneSessions`가 두 pane에 `reconcileWorkspace`를 보낸다. 기존 `reconcileUiState()`는 `NotesPaneSessionState`를 받아 새 pane navigation을 반환하도록 이동한다.

- [ ] **Step 4: fixed pane controller와 bound actions 구현**

  `notesWorkspaceTypes.ts`에 다음 surface를 추가한다.

  ```ts
  export interface NotesPaneRuntimeSlice {
    readonly paneId: NotesPaneId;
    readonly stateSlice: NotesStateSlice;
    readonly draftsSlice: NotesDraftsSlice;
    readonly actionsSlice: NotesActionsSlice;
  }

  export interface NotesPaneRegistrySlice {
    readonly activePaneId: NotesPaneId;
    readonly panes: Readonly<Record<NotesPaneId, NotesPaneRuntimeSlice>>;
    setActivePaneId(paneId: NotesPaneId): void;
    getPaneSession(paneId: NotesPaneId): NotesPaneSessionState;
    dispatchPane(
      paneId: NotesPaneId,
      action: NotesPaneSessionAction
    ): void;
  }
  ```

  `useNotesPaneSessions.ts`는 두 `useReducer`와 live ref를 명시적으로 만든다. `useNotesWorkspace`는 shared command dependencies를 한 번 만들고, navigation/selection/focus action만 `bindPaneActions(paneId, sharedActions, paneController)`로 감싼다. `UseNotesWorkspaceHookResult`는 `paneRegistrySlice`를 추가하되 기존 merged surface는 primary slice를 spread한다.

  다음 action은 반드시 호출 pane controller를 사용한다.

  - `focusNode`, `acknowledgeFocus`, `markEditingFocus`
  - `zoomTo`, `openSearchResult`
  - selection 5종
  - `getNavigationVersion`
  - structural command의 focus/expand/pending focus settlement

  scope/library/data/draft/attachment/Undo action은 shared implementation을 그대로 가리킨다.

- [ ] **Step 5: pane-scoped narrow context 연결**

  `NotesPaneScope.tsx`는 registry의 고정 slice로 기존 narrow context를 override한다.

  ```tsx
  export function NotesPaneScope({
    paneId,
    children
  }: PropsWithChildren<{ paneId: NotesPaneId }>) {
    const registry = useNotesPaneRegistry();
    const pane = registry.panes[paneId];
    return (
      <NotesActionsContext.Provider value={pane.actionsSlice}>
        <NotesStateContext.Provider value={pane.stateSlice}>
          <NotesDraftsContext.Provider value={pane.draftsSlice}>
            {children}
          </NotesDraftsContext.Provider>
        </NotesStateContext.Provider>
      </NotesActionsContext.Provider>
    );
  }
  ```

  `NotesWorkspaceProvider`는 바깥 narrow contexts에 primary를 계속 제공하고 `NotesPaneRegistryContext`를 추가한다. `NotesFeature.tsx`의 detail은 이 Task에서 아직 primary 하나만 scope로 감싸 렌더한다.

- [ ] **Step 6: primary 회귀와 render isolation GREEN**

  ```bash
  npm test -- src/features/notes/NotesPaneScope.test.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/useNotesWorkspace.selectionAndProjection.test.tsx src/features/notes/outlineRowMemo.test.tsx src/features/notes/NotesWorkspace.test.tsx
  npm run test:architecture
  ```

  Expected: 기존 한-pane 동작 PASS, secondary-only navigation에서 Library/actions-only probe render 수 불변, architecture gate PASS.

- [ ] **Step 7: 커밋**

  ```bash
  git add src/features/notes/useNotesPaneSessions.ts src/features/notes/NotesPaneScope.tsx src/features/notes/NotesPaneScope.test.tsx src/features/notes/notesWorkspaceReducer.ts src/features/notes/notesWorkspaceTypes.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/NotesWorkspaceContext.ts src/features/notes/NotesFeature.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/useNotesWorkspace.selectionAndProjection.test.tsx src/features/notes/outlineRowMemo.test.tsx scripts/checkNotesWorkspaceBudgets.mjs
  git commit -m "refactor(notes): isolate pane navigation state"
  ```

---

### Task 3: Split host, 버튼, divider와 재실행 복원 추가

**Files:**

- Create: `src/features/notes/NotesDetailSplitHost.tsx`
- Create: `src/features/notes/NotesDetailSplitHost.test.tsx`
- Modify: `src/features/notes/NotesFeature.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/NotesFeature.test.tsx`
- Modify: `src/features/notes/notes.css`

**Interfaces:**

- Consumes: `NotesPaneRegistrySlice`, `VaultRootContext`, `notesSplitLayoutStore`.
- Produces: primary/secondary pane DOM, primary toolbar Split toggle, pointer/keyboard divider, viewport snapshots.

- [ ] **Step 1: split lifecycle 실패 테스트 작성**

  `NotesDetailSplitHost.test.tsx`에 다음 사용자 흐름을 작성한다.

  ```ts
  expect(screen.getAllByLabelText("Notes outline")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Split view" }));
  expect(screen.getAllByLabelText("Notes outline")).toHaveLength(2);
  expect(secondaryProbe()).toHaveAttribute("data-zoom-root", "");
  ```

  추가 계약:

  - secondary 최초 open은 top-level(`zoomRootId: null`)이다.
  - secondary에서 page를 연 뒤 close/reopen하면 같은 page다.
  - secondary가 active일 때 close하면 primary가 active/focused다.
  - close 전 `flushAllDrafts()`가 false이면 close하지 않고 오류 feedback을 유지한다.
  - divider pointer와 `ArrowLeft`/`ArrowRight`가 25–75% 범위에서 ratio를 바꾼다.
  - 저장된 split/page/ratio가 remount 후 복원된다.
  - Vault A와 B가 서로 다른 layout을 복원한다.
  - 저장된 page가 삭제됐으면 해당 pane만 top-level로 fallback한다.

- [ ] **Step 2: RED 확인**

  ```bash
  npm test -- src/features/notes/NotesDetailSplitHost.test.tsx src/features/notes/NotesFeature.test.tsx
  ```

  Expected: split host와 button이 없어 FAIL.

- [ ] **Step 3: host와 toolbar slot 구현**

  `NotesOutlinePane`은 layout ownership 없이 다음 props만 받는다.

  ```ts
  interface NotesOutlinePaneProps {
    readonly paneId: NotesPaneId;
    readonly toolbarTrailing?: ReactNode;
    readonly onViewportSnapshot?: (
      snapshot: Pick<
        NotesPaneSessionState,
        "scrollAnchorId" | "scrollOffset"
      >
    ) => void;
    readonly restoreViewport?: PersistedPaneNavigation;
  }
  ```

  `NotesDetailSplitHost`는 fixed panes만 렌더한다.

  ```tsx
  <div
    className="notes-detail-split"
    data-split-open={layout.splitOpen ? "true" : undefined}
    style={{ "--notes-split-ratio": `${layout.splitRatio * 100}%` }}
  >
    <NotesPaneScope paneId="primary">
      <NotesOutlinePane paneId="primary" toolbarTrailing={<SplitToggle />} />
    </NotesPaneScope>
    {layout.splitOpen && <SplitDivider />}
    {layout.splitOpen && (
      <NotesPaneScope paneId="secondary">
        <NotesOutlinePane paneId="secondary" />
      </NotesPaneScope>
    )}
  </div>
  ```

  primary toolbar의 Split 버튼은 `aria-label="Split view"`, `aria-pressed`를 사용한다. 닫힌 secondary session은 unmount되어도 reducer state를 폐기하지 않는다.

- [ ] **Step 4: viewport와 Vault persistence 연결**

  - workspace status가 `ready`가 된 뒤 한 번만 persisted pane navigation을 hydrate/reconcile한다.
  - scroll event는 가장 가까운 visible row의 `data-outline-id`와 container 상대 offset을 저장한다.
  - restore는 anchor가 있으면 anchor 기준, 없으면 numeric offset 기준으로 한 번 수행한다.
  - navigation/expansion/split/ratio 변경은 즉시 작은 JSON을 저장한다. draft keystroke와 data settlement는 layout save를 발생시키지 않는다.

- [ ] **Step 5: 최소 CSS와 접근성 구현**

  ```css
  .notes-detail-split {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
  }

  .notes-detail-split[data-split-open="true"] {
    grid-template-columns:
      minmax(0, var(--notes-split-ratio))
      6px
      minmax(0, calc(100% - var(--notes-split-ratio) - 6px));
  }
  ```

  divider는 `role="separator"`, `aria-orientation="vertical"`, `aria-valuemin="25"`, `aria-valuemax="75"`, 현재 값을 제공한다. 720px 미만 detail 폭에서는 두 pane 최소 폭을 지키기 위해 ratio clamp만 적용하고 자동 close나 세 번째 responsive mode는 만들지 않는다.

- [ ] **Step 6: GREEN**

  ```bash
  npm test -- src/features/notes/NotesDetailSplitHost.test.tsx src/features/notes/NotesFeature.test.tsx src/features/notes/NotesWorkspace.test.tsx
  npm run lint -- --quiet
  git diff --check
  ```

  Expected: split open/close/restore 테스트 PASS, 기존 Notes 화면 테스트 PASS.

- [ ] **Step 7: 커밋**

  ```bash
  git add src/features/notes/NotesDetailSplitHost.tsx src/features/notes/NotesDetailSplitHost.test.tsx src/features/notes/NotesFeature.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesFeature.test.tsx src/features/notes/notes.css
  git commit -m "feat(notes): add persistent split detail panes"
  ```

---

### Task 4: history snapshot을 두 pane 위치로 확장

**Files:**

- Modify: `src/features/notes/notesHistory.ts`
- Modify: `src/features/notes/notesHistory.test.ts`
- Modify: `src/features/notes/notesWorkspaceNavigationSupport.ts`
- Modify: `src/features/notes/useNotesHistoryController.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Modify: `src/features/notes/useNotesWorkspace.navigation.test.tsx`
- Modify: `src/features/notes/useNotesWorkspace.sharedSession.test.tsx`

**Interfaces:**

- Changes: history location contains both pane snapshots and `activePaneId`.
- Changes: navigation entry records `originPaneId`.
- Preserves: one backend mutation entry and one mixed frontend timeline.

- [ ] **Step 1: pane-aware history 실패 테스트 작성**

  `notesHistory.test.ts`에 다음 shape와 replay를 고정한다.

  ```ts
  history.appendNavigation("secondary", before, after);
  expect(history.next("undo")).toMatchObject({
    kind: "navigation",
    originPaneId: "secondary",
    before
  });
  ```

  navigation/runtime 테스트는 다음을 단정한다.

  - secondary zoom Undo는 primary page를 변경하지 않는다.
  - primary zoom Undo는 secondary page를 변경하지 않는다.
  - mutation Undo/Redo는 두 pane snapshot과 active pane을 복원한다.
  - secondary가 닫힌 상태에서 Undo는 `splitOpen`을 true로 만들지 않고 숨겨진 secondary snapshot만 갱신한다.
  - 삭제된 replay page는 그 pane만 top-level로 resolve한다.
  - expansion pool retain/release가 pane 두 개와 tag filter origin에 대해 leak 없이 균형을 이룬다.

- [ ] **Step 2: RED 확인**

  ```bash
  npm test -- src/features/notes/notesHistory.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.navigation.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx
  ```

  Expected: 현재 snapshot이 한 pane location만 가지므로 FAIL.

- [ ] **Step 3: snapshot과 entry 타입 변경**

  ```ts
  export interface NotesPaneHistoryLocation {
    readonly selectedId: NoteId | null;
    readonly zoomRootId: NoteId | null;
    readonly expansion: NotesExpansionRevision;
    readonly focus: NotesHistoryFocus | null;
  }

  export interface NotesHistoryLocationSnapshot {
    readonly scope: NotesWorkspaceScope;
    readonly libraryView: NotesLibraryView;
    readonly activeTagFilters: readonly NoteTagFilter[];
    readonly activePaneId: NotesPaneId;
    readonly panes: Readonly<Record<NotesPaneId, NotesPaneHistoryLocation>>;
  }

  export type NotesSessionHistoryEntry =
    | {
        kind: "mutation";
        entryId: string;
        before: NotesHistorySnapshot;
        after: NotesHistorySnapshot;
      }
    | {
        kind: "navigation";
        originPaneId: NotesPaneId;
        before: NotesHistorySnapshot;
        after: NotesHistorySnapshot;
      };
  ```

  `appendNavigation(originPaneId, before, after)`로 signature를 바꾼다. clone/equality/release는 `primary`, `secondary`, `tagFilterOrigin`의 expansion을 모두 처리한다.

- [ ] **Step 4: capture/resolve/apply를 pane registry 기준으로 변경**

  - mutation before/after는 두 pane을 모두 capture한다.
  - navigation entry는 action을 호출한 bound pane ID를 coordinator에 전달한다.
  - navigation replay는 `originPaneId` pane만 적용하고 다른 pane의 live session을 유지한다.
  - mutation replay는 두 pane을 적용한다.
  - `activePaneId === "secondary"`이지만 split이 닫혀 있으면 layout을 열지 않고 active UI는 primary로 두되 snapshot의 secondary navigation은 보존한다.
  - tag filter origin도 두 pane location을 보유한다.
  - authoritative data replay 성공이 pane 위치 복원보다 우선한다.

- [ ] **Step 5: GREEN과 history entry 수 확인**

  ```bash
  npm test -- src/features/notes/notesHistory.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.navigation.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx
  ```

  Expected: pane navigation/structural replay PASS, 기존 epoch mismatch recovery PASS.

- [ ] **Step 6: 커밋**

  ```bash
  git add src/features/notes/notesHistory.ts src/features/notes/notesHistory.test.ts src/features/notes/notesWorkspaceNavigationSupport.ts src/features/notes/useNotesHistoryController.ts src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.navigation.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx
  git commit -m "feat(notes): track both panes in history"
  ```

---

### Task 5: 전역 editing lease와 pane별 IME guard 추가

**Files:**

- Create: `src/features/notes/useNotesEditingLease.ts`
- Create: `src/features/notes/useNotesEditingLease.test.tsx`
- Modify: `src/features/notes/notesWorkspaceTypes.ts`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**

- Produces: one lease `{ paneId, nodeId, field } | null`.
- Changes: composition state is `Record<NotesPaneId, boolean>`.
- Changes: focus handler claims lease before moving edit ownership.

- [ ] **Step 1: editing lease 실패 테스트 작성**

  다음 경우를 `useNotesEditingLease.test.tsx`와 owning integration에 추가한다.

  - 다른 node 편집권 요청은 기존 node draft flush 성공 뒤 이전된다.
  - flush false이면 새 pane이 editing/focus를 얻지 않는다.
  - 같은 node가 양쪽에 보일 때 마지막으로 성공한 claimant만 textarea 편집권을 가진다.
  - source pane이 한글 composition 중이면 lease transfer와 structural command를 보류한다.
  - `compositionend` 뒤 재요청하면 완성된 한글 draft를 flush하고 이전한다.
  - pane unmount/close는 조합 중이 아니면 lease를 해제하지만 draft를 버리지 않는다.

- [ ] **Step 2: RED 확인**

  ```bash
  npm test -- src/features/notes/useNotesEditingLease.test.tsx src/features/notes/NotesWorkspace.test.tsx
  ```

  Expected: 현재 editing focus와 composition boolean이 전역 한 개라 pane ownership 테스트 FAIL.

- [ ] **Step 3: lease controller 구현**

  ```ts
  export interface NotesEditingLease {
    readonly paneId: NotesPaneId;
    readonly nodeId: NoteId;
    readonly field: NotesHistoryFocusField;
  }

  export interface NotesEditingLeaseController {
    readonly lease: NotesEditingLease | null;
    readonly composing: Readonly<Record<NotesPaneId, boolean>>;
    setCompositionActive(paneId: NotesPaneId, active: boolean): void;
    claim(
      request: NotesEditingLease,
      flushNodeDraft: (nodeId: NoteId) => Promise<boolean>
    ): Promise<boolean>;
    release(paneId: NotesPaneId, nodeId?: NoteId): void;
    structuralCommandsAllowed(): boolean;
  }
  ```

  `claim()`은 동일 lease면 true, 기존 pane이 composing이면 false, 기존 node가 다르면 flush 성공 후에만 교체한다. 같은 node의 다른 pane claim도 lease owner를 교체하여 두 DOM editor가 동시에 쓰지 못하게 한다.

- [ ] **Step 4: row와 structural guard 연결**

  pane-bound actions에 아래 API를 노출한다.

  ```ts
  claimEditingFocus(
    nodeId: NoteId,
    field: NotesHistoryFocusField
  ): Promise<boolean>;
  releaseEditingFocus(nodeId: NoteId): void;
  setOutlineCompositionActive(active: boolean): void;
  ```

  `OutlineNodeRow` focus는 claim 성공 후에만 `markEditingFocus`와 draft edit mode를 적용한다. `NotesOutlinePane` composition capture는 자신의 pane ID를 bound action에 전달한다. existing structural barrier는 `structuralCommandsAllowed()`가 false면 backend를 호출하지 않는다.

- [ ] **Step 5: GREEN**

  ```bash
  npm test -- src/features/notes/useNotesEditingLease.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/useNotesWorkspace.navigation.test.tsx
  ```

  Expected: lease/IME 계약과 기존 Korean composition 회귀 테스트 PASS.

- [ ] **Step 6: 커밋**

  ```bash
  git add src/features/notes/useNotesEditingLease.ts src/features/notes/useNotesEditingLease.test.tsx src/features/notes/notesWorkspaceTypes.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesWorkspace.test.tsx
  git commit -m "feat(notes): coordinate pane editing ownership"
  ```

---

### Task 6: DnD ID를 pane namespace로 바꾸고 context를 split host로 승격

**Files:**

- Create: `src/features/notes/notesPaneDndId.ts`
- Create: `src/features/notes/notesPaneDndId.test.ts`
- Create: `src/features/notes/NotesSplitDndContext.tsx`
- Create: `src/features/notes/NotesSplitDndContext.test.tsx`
- Modify: `src/features/notes/NotesDetailSplitHost.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/outlineDrag.test.ts`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**

- Produces: collision-free pane DnD IDs and fixed two-pane adapter bridge.
- Preserves: same-pane pointer/keyboard drag, selection drag, overlay, announcements and filtered preflight.
- Does not enable cross-pane commit yet; cross-pane hover is preview-disabled until Task 7.

- [ ] **Step 1: ID와 single-context 실패 테스트 작성**

  ```ts
  const primary = notesPaneDndId("primary", "same-node", "row");
  const secondary = notesPaneDndId("secondary", "same-node", "row");
  expect(primary).not.toBe(secondary);
  expect(parseNotesPaneDndId(primary)).toEqual({
    paneId: "primary",
    nodeId: "same-node",
    zone: "row"
  });
  ```

  integration은 split이 열린 상태에서 다음을 단정한다.

  - DOM에 같은 node가 양쪽에 있어도 sortable/droppable ID가 중복되지 않는다.
  - `DndContext` sensors/overlay는 host에서 한 번만 생성된다.
  - primary same-pane drag와 secondary same-pane drag가 각각 기존 `moveNode` input을 한 번 호출한다.
  - keyboard drag announcements는 raw namespace가 아니라 node label을 읽는다.

- [ ] **Step 2: RED 확인**

  ```bash
  npm test -- src/features/notes/notesPaneDndId.test.ts src/features/notes/NotesSplitDndContext.test.tsx src/features/notes/outlineDrag.test.ts src/features/notes/NotesWorkspace.test.tsx
  ```

  Expected: 같은 node가 raw `NoteId`를 사용하고 pane마다 DndContext가 생겨 FAIL.

- [ ] **Step 3: ID codec 구현**

  ```ts
  export type NotesPaneDropZone = "row" | "before" | "inside" | "tail";

  export function notesPaneDndId(
    paneId: NotesPaneId,
    nodeId: NoteId | null,
    zone: NotesPaneDropZone
  ): string {
    return `${paneId}:${encodeURIComponent(nodeId ?? "")}:${zone}`;
  }
  ```

  parser는 pane/zone whitelist와 `decodeURIComponent` 실패를 거부하고 `null`을 반환한다. event handler 진입 시 namespace를 decode한 뒤 기존 projection helper에는 raw `NoteId`만 전달한다.

- [ ] **Step 4: 고정 adapter bridge와 한 DndContext 구현**

  ```ts
  export interface NotesPaneDragAdapter {
    readonly paneId: NotesPaneId;
    getSnapshot(): NotesPaneDragSnapshot;
    project(event: NotesPaneDragEvent): NotesPaneDragProjection | null;
    clearPreview(): void;
  }

  export interface NotesSplitDragBridge {
    register(
      paneId: NotesPaneId,
      adapter: NotesPaneDragAdapter
    ): () => void;
  }
  ```

  `NotesOutlinePane`은 기존 drag 계산/refs를 adapter로 등록하고 `<SortableContext>`와 rows만 렌더한다. `NotesDetailSplitHost`의 `NotesSplitDndContext`가 `<DndContext>`와 하나의 `<DragOverlay>`를 렌더하고 event를 source adapter에 전달한다. `OutlineNodeRow`의 `useSortable` ID와 `SortableContext.items`는 namespaced row ID를 사용한다.

- [ ] **Step 5: same-pane GREEN**

  ```bash
  npm test -- src/features/notes/notesPaneDndId.test.ts src/features/notes/NotesSplitDndContext.test.tsx src/features/notes/outlineDrag.test.ts src/features/notes/NotesWorkspace.test.tsx
  ```

  Expected: 기존 same-pane drag input/preview/selection/keyboard assertions PASS, 하나의 DndContext PASS.

- [ ] **Step 6: 커밋**

  ```bash
  git add src/features/notes/notesPaneDndId.ts src/features/notes/notesPaneDndId.test.ts src/features/notes/NotesSplitDndContext.tsx src/features/notes/NotesSplitDndContext.test.tsx src/features/notes/NotesDetailSplitHost.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/OutlineNodeRow.tsx src/features/notes/outlineDrag.test.ts src/features/notes/NotesWorkspace.test.tsx
  git commit -m "refactor(notes): share split pane drag context"
  ```

---

### Task 7: 단일 블릿 cross-pane 이동 연결

**Files:**

- Create: `src/features/notes/notesCrossPaneDrag.ts`
- Create: `src/features/notes/notesCrossPaneDrag.test.ts`
- Modify: `src/features/notes/NotesSplitDndContext.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/notesWorkspaceTypes.ts`
- Modify: `src/features/notes/useNotesSelectionController.ts`
- Modify: `src/features/notes/notesCommands.ts`
- Modify: `src/features/notes/useNotesWorkspace.operations.test.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**

- Produces: immutable drag authority with source pane/zoom/generation/scope.
- Produces: destination-pane projection and `commitPreparedDragMove()`.
- Uses: existing backend `moveNode`; no batch or new IPC for one node.

- [ ] **Step 1: pure destination projection 실패 테스트 작성**

  `notesCrossPaneDrag.test.ts` 표:

  - secondary row 사이 drop은 secondary rows/depth로 `parentId`/`afterId`를 계산한다.
  - secondary child zone은 target을 parent로 사용한다.
  - zoomed empty tail은 `parentId = secondary.zoomRootId`, `afterId = lastChild`.
  - root empty tail은 `parentId = null`, `afterId = lastRoot`.
  - source pane의 indent/scroll/row rect를 destination 계산에 사용하지 않는다.
  - self/descendant, depth overflow, read-only, stale generation, missing destination, no-op을 invalid로 반환한다.

- [ ] **Step 2: owning integration 실패 테스트 작성**

  - primary node를 secondary page tail로 drop하면 `repository.moveNode`가 정확히 한 번 호출된다.
  - returned history state에는 entry가 하나다.
  - 성공 전 두 pane selection/focus는 바뀌지 않는다.
  - 성공 후 source selection은 clear되고 destination pane이 moved node를 focus한다.
  - 실패/stale이면 backend 호출 또는 pane effect가 없다.
  - Undo/Redo가 source/destination 위치와 pane focus를 복원한다.

- [ ] **Step 3: RED 확인**

  ```bash
  npm test -- src/features/notes/notesCrossPaneDrag.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/NotesWorkspace.test.tsx
  ```

  Expected: cross-pane projection/commit이 없어 FAIL.

- [ ] **Step 4: authority와 pane settlement 타입 구현**

  ```ts
  export interface NotesPreparedDragMove extends NotesPreparedMove {
    readonly sourcePaneId: NotesPaneId;
    readonly sourceZoomRootId: NoteId | null;
  }

  export interface NotesPaneSettlement {
    readonly sourcePaneId: NotesPaneId;
    readonly destinationPaneId: NotesPaneId;
    readonly focusNodeId: NoteId;
    readonly expandNodeId?: NoteId;
  }

  commitPreparedDragMove?(
    prepared: NotesPreparedDragMove,
    input: Omit<MoveNoteNodeInput, "id">,
    settlement: NotesPaneSettlement
  ): Promise<NotesPreparedMoveCommitResult>;
  ```

  prepare는 existing `prepareMoveNode`의 active workspace/generation proof를 재사용한다. queue turn에서 source와 destination dependency node의 identity, scope, generation, cycle/depth/no-op을 다시 검사한다.

- [ ] **Step 5: moveNode settlement 안에서 pane effects 적용**

  `commitPreparedDragMoveCommand()`는 다음 순서만 허용한다.

  1. shared draft structural barrier
  2. prepared authority 재검증
  3. `repository.moveNode(vaultRoot, { id, parentId, afterId, beforeId }, history...)`
  4. authoritative projection과 backend history 수용
  5. source selection clear, destination focus/expansion을 pane sessions에 적용
  6. 두 pane을 포함한 history after capture

  pane effect는 `onSuccess` callback으로 뒤늦게 적용하지 않는다. history after를 만들기 전에 controller가 적용하도록 `settleAtomicMutation` option으로 전달한다.

- [ ] **Step 6: host에서 cross-pane ordinary session 활성화**

  drag start snapshot:

  ```ts
  export interface NotesCrossPaneDragSnapshot {
    readonly sourcePaneId: NotesPaneId;
    readonly sourceZoomRootId: NoteId | null;
    readonly sourceNodeIds: readonly NoteId[];
    readonly selectionRevision: number;
    readonly workspaceGeneration: number;
    readonly scope: NotesWorkspaceScope;
  }
  ```

  destination adapter만 preview와 auto-scroll을 갱신한다. pointer가 원래 pane으로 돌아오면 existing same-pane path를 사용한다.

- [ ] **Step 7: GREEN**

  ```bash
  npm test -- src/features/notes/notesCrossPaneDrag.test.ts src/features/notes/NotesSplitDndContext.test.tsx src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.navigation.test.tsx src/features/notes/NotesWorkspace.test.tsx
  ```

  Expected: 단일 cross-pane 이동 한 backend call/한 history entry, Undo/Redo와 same-pane 회귀 PASS.

- [ ] **Step 8: 커밋**

  ```bash
  git add src/features/notes/notesCrossPaneDrag.ts src/features/notes/notesCrossPaneDrag.test.ts src/features/notes/NotesSplitDndContext.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/notesWorkspaceTypes.ts src/features/notes/useNotesSelectionController.ts src/features/notes/notesCommands.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/NotesWorkspace.test.tsx
  git commit -m "feat(notes): move bullets across panes"
  ```

---

### Task 8: 다중 선택 cross-pane batch와 실패 복구 연결

**Files:**

- Modify: `src/features/notes/notesCrossPaneDrag.ts`
- Modify: `src/features/notes/notesCrossPaneDrag.test.ts`
- Modify: `src/features/notes/NotesSplitDndContext.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/notesWorkspaceTypes.ts`
- Modify: `src/features/notes/useNotesSelectionController.ts`
- Modify: `src/features/notes/notesCommands.ts`
- Modify: `src/features/notes/useNotesWorkspace.selectionAndProjection.test.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**

- Reuses: `NotesPreparedSelectionAuthority`, structural root derivation, `applyPreparedSelectionBatch`.
- Extends: `NotesPreparedSelectionBatchOptions` with accepted `paneSettlement`.
- Preserves: selection order and one backend batch/history entry.

- [ ] **Step 1: multi-selection 실패 테스트 작성**

  다음 계약을 추가한다.

  - 부모와 자식이 함께 선택되면 structural root인 부모만 batch node ID가 된다.
  - 여러 sibling root는 source visible order를 유지한다.
  - destination projection은 전체 묶음의 cycle/depth/no-op을 검사한다.
  - cross-pane drop은 `applyBatch` 한 번, backend history entry 한 개다.
  - selection revision 또는 prepared generation이 drag 중 바뀌면 drop을 거부한다.
  - draft flush 실패, backend failure, projection mismatch이면 양쪽 selection/focus와 last authoritative workspace를 유지한다.
  - filtered view는 prepared authority가 current일 때만 허용한다.
  - image node가 포함된 selection은 기존 image move 제한을 그대로 적용한다.

- [ ] **Step 2: RED 확인**

  ```bash
  npm test -- src/features/notes/notesCrossPaneDrag.test.ts src/features/notes/useNotesWorkspace.selectionAndProjection.test.tsx src/features/notes/NotesWorkspace.test.tsx
  ```

  Expected: selected drag가 source pane 내부 projection만 사용하므로 FAIL.

- [ ] **Step 3: prepared selection과 destination target 결합**

  `NotesPreparedSelectionBatchOptions`를 확장한다.

  ```ts
  export interface NotesPreparedSelectionBatchOptions {
    readonly focusNodeId?: NoteId | null;
    readonly expandNodeId?: NoteId;
    readonly expectedNavigationVersion?: number;
    readonly paneSettlement?: NotesPaneSettlement;
  }
  ```

  destination adapter는 prepared authority의 active workspace를 사용해 `{ type: "move", parentId, afterId, beforeId }`를 만든다. queue turn에서 `isPreparedSelectionAuthorityCurrent()`를 다시 확인하고 기존 `applyPreparedSelectionBatchCommand()`를 정확히 한 번 호출한다.

- [ ] **Step 4: 성공/실패 pane effect 통일**

  단일과 다중 경로 모두 같은 `applyAcceptedPaneSettlement()`를 사용한다.

  ```ts
  export function applyAcceptedPaneSettlement(
    registry: NotesPaneRegistryController,
    settlement: NotesPaneSettlement
  ): void {
    registry.dispatchPane(settlement.sourcePaneId, {
      type: "setSelection",
      selection: null
    });
    registry.focusAcceptedMove(
      settlement.destinationPaneId,
      settlement.focusNodeId,
      settlement.expandNodeId
    );
  }
  ```

  이 함수는 history acceptance 전에는 호출하지 않는다. 실패 path는 preview/session만 clear하고 pane reducer를 dispatch하지 않는다.

- [ ] **Step 5: GREEN**

  ```bash
  npm test -- src/features/notes/notesCrossPaneDrag.test.ts src/features/notes/NotesSplitDndContext.test.tsx src/features/notes/useNotesWorkspace.selectionAndProjection.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx src/features/notes/NotesWorkspace.test.tsx
  ```

  Expected: single/multi 양방향 이동, stale/filtered/failure/Undo 계약 PASS.

- [ ] **Step 6: 커밋**

  ```bash
  git add src/features/notes/notesCrossPaneDrag.ts src/features/notes/notesCrossPaneDrag.test.ts src/features/notes/NotesSplitDndContext.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/notesWorkspaceTypes.ts src/features/notes/useNotesSelectionController.ts src/features/notes/notesCommands.ts src/features/notes/useNotesWorkspace.selectionAndProjection.test.tsx src/features/notes/NotesWorkspace.test.tsx
  git commit -m "feat(notes): move selections across panes"
  ```

---

### Task 9: render 격리, 전체 검증과 데스크톱 확인

**Files:**

- Modify: `src/features/notes/notesWorkspaceContextSplit.test.tsx`
- Modify: `src/features/notes/NotesDetailSplitHost.test.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `docs/superpowers/specs/2026-07-24-notes-split-pane-design.md`

- [ ] **Step 1: render/session 회귀 테스트 보강**

  계측 probe로 다음을 단정한다.

  - secondary navigation/selection/scroll 변경은 Notes Library를 re-render하지 않는다.
  - primary draft keystroke는 secondary의 변경되지 않은 row를 re-render하지 않는다.
  - split open/close는 repository initialize, coordinator session, Draft Engine을 추가 생성하지 않는다.
  - authoritative move settlement는 두 pane의 필요한 row만 새 data를 받는다.
  - closed secondary는 hidden DOM을 유지하지 않지만 session state는 유지한다.

- [ ] **Step 2: 집중 회귀 suite 실행**

  ```bash
  npm test -- \
    src/features/notes/notesPaneSession.test.ts \
    src/features/notes/notesSplitLayoutStore.test.ts \
    src/features/notes/NotesPaneScope.test.tsx \
    src/features/notes/NotesDetailSplitHost.test.tsx \
    src/features/notes/NotesSplitDndContext.test.tsx \
    src/features/notes/notesCrossPaneDrag.test.ts \
    src/features/notes/notesHistory.test.ts \
    src/features/notes/notesWorkspaceContextSplit.test.tsx \
    src/features/notes/outlineDrag.test.ts \
    src/features/notes/useNotesWorkspace.navigation.test.tsx \
    src/features/notes/useNotesWorkspace.selectionAndProjection.test.tsx \
    src/features/notes/useNotesWorkspace.sharedSession.test.tsx \
    src/features/notes/NotesWorkspace.test.tsx
  ```

  Expected: 모두 PASS.

- [ ] **Step 3: 전체 frontend gate 실행**

  ```bash
  npm test
  npm run lint
  npm run build
  npm run test:architecture
  npm run test:plans
  git diff --check
  ```

  Expected: 모두 exit 0. 최종 diff에 Rust/IPC/schema 변경이 없으므로 Cargo gate는 명시적으로 생략한다.

- [ ] **Step 4: freshly built desktop 수동 확인**

  격리한 테스트 Vault에서 다음 한 흐름을 수행하고 각 항목을 기록한다.

  1. Split 버튼으로 secondary를 열고 top-level이 표시되는지 확인.
  2. primary/secondary에서 서로 다른 서브 페이지 열기.
  3. 단일 블릿을 양방향으로 이동하고 `Cmd+Z`, `Cmd+Shift+Z` 확인.
  4. 마우스로 여러 블릿을 선택해 양방향 이동하고 Undo/Redo 확인.
  5. 같은 블릿을 양쪽에서 표시하고 한글 입력 후 편집권 이동 확인.
  6. split close/reopen, 앱 restart 후 secondary page/ratio 복원 확인.
  7. 다른 Vault 전환 후 설정 격리 확인.
  8. Archive/Trash, 자신/자손 target과 stale selection이 drop을 거부하는지 확인.

- [ ] **Step 5: 설계 문서 상태 갱신**

  `docs/superpowers/specs/2026-07-24-notes-split-pane-design.md`의 상태를 `구현 및 검증 완료`로 바꾸고 실제 변경 파일과 수동 확인 결과를 짧게 덧붙인다. 완료되지 않은 항목이 있으면 완료로 표시하지 않고 정확한 제한을 적는다.

- [ ] **Step 6: 최종 커밋**

  ```bash
  git add src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/NotesDetailSplitHost.test.tsx src/features/notes/NotesWorkspace.test.tsx docs/superpowers/specs/2026-07-24-notes-split-pane-design.md
  git commit -m "test(notes): verify split pane workflow"
  ```

- [ ] **Step 7: final review**

  ```bash
  git status --short
  git log --oneline 5455471..HEAD
  git diff --stat 5455471..HEAD
  git diff --name-only 5455471..HEAD | rg '^(src-tauri|.*Cargo\\.|.*\\.sql$)' || true
  rg -n "TODO|FIXME|temporary split|generic pane manager" src/features/notes docs/superpowers/specs/2026-07-24-notes-split-pane-design.md
  ```

  Expected: worktree clean, Task별 커밋이 보이고, native/schema 경로와 미해결 placeholder 없음.

---

## Plan Self-Review

- [ ] 설계 계약의 완료 조건이 Task 1–9의 테스트 또는 수동 확인에 각각 매핑됐는지 확인한다.
- [ ] 단일 provider/coordinator/Draft Engine/history timeline 원칙을 Task 2와 Task 9에서 자동 검증하는지 확인한다.
- [ ] same-pane drag 회귀를 Task 6에서 cross-pane commit보다 먼저 증명하는지 확인한다.
- [ ] 단일 이동은 `moveNode`, 다중 이동은 `applyBatch`를 사용하며 각각 한 backend history entry인지 확인한다.
- [ ] split layout이 history가 아니라 Vault별 localStorage에만 저장되는지 확인한다.
- [ ] 닫힌 secondary를 Undo가 자동으로 열지 않는 테스트가 있는지 확인한다.
- [ ] IME 조합, draft flush 실패, stale generation/selection, read-only/cycle/depth/no-op guard가 누락되지 않았는지 확인한다.
- [ ] 새 dependency, generic N-pane abstraction, native/schema 변경이 계획에 포함되지 않았는지 확인한다.
- [ ] 모든 Task에 RED 명령, GREEN 명령, 정확한 staging 경로와 commit message가 있는지 확인한다.

## Execution Choice

계획이 승인되면 아래 중 하나로 실행한다.

1. **Subagent-Driven (recommended)** — 현재 세션에서 Task별 구현과 독립 review를 반복한다.
2. **Inline Execution** — 현재 agent가 Task를 순서대로 직접 구현하고 각 checkpoint에서 검증한다.
