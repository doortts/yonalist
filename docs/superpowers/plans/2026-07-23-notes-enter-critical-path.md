# Notes Enter Critical Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 권위 없는 임시 행을 만들지 않으면서 clean split, dirty split, dirty first-child Enter의 IPC 완료 후 포커스까지를 16ms p95 이내로 줄이고, Enter가 만든 행 이동에는 레이아웃 측정과 애니메이션을 발생시키지 않는다.

**Architecture:** 기존 저장·Undo 권위는 유지한다. 키 입력 시 예상 노드 ID와 세션/Pane/상호작용 소유권만 등록하고, coordinator가 workspace와 history를 수용한 뒤 정확한 settlement를 발행한다. exact 또는 ownership-proven mixed settlement는 FLIP 측정을 건너뛰고, 안정된 노드/행 참조와 분리된 sortable shell 덕분에 변경되지 않은 heavy editor는 커밋하지 않는다. invoke 이후 결과가 불확실하면 mutation을 재실행하지 않고 한 번의 권위 복구를 수행한다.

**Tech Stack:** React 19, TypeScript 6, Vitest, Testing Library, Tauri IPC client, Web Animations API, `requestIdleCallback`.

## Global Constraints

- 승인된 계약은 `docs/superpowers/specs/2026-07-23-notes-enter-critical-path-design.md`이다. 구현 중 편의를 위해 계약을 축소하지 않는다.
- 구현은 `c7c253b`에서 만든 격리 worktree에서 수행한다. 현재 main worktree의 사용자 소유 변경인 `outlineLayoutMotion.ts`, `outlineLayoutMotion.test.ts`, `useOutlineLayoutMotion.test.tsx`, `docs/superpowers/plans/2026-07-23-contextual-enter-child.md`를 수정·스테이징·덮어쓰지 않는다.
- Task 5에서 main worktree의 motion 변경과 새 구현을 비교하되, 사용자 변경을 그대로 복사하지 않는다. 현재 변경은 단일 entering row만 건너뛰므로 shifted row 측정/애니메이션 문제의 완전한 해법이 아니다.
- 현재 contextual Enter 규칙, IME/repeat/read-only/in-flight guard, draft-first barrier, Undo granularity를 유지한다.
- optimistic/provisional row, 일반 query/render cache, virtualization, dirty save와 structure를 한 IPC로 합치는 변경은 금지한다.
- `notesWorkspaceRuntime.ts`와 `useNotesHistoryController.ts`는 이미 각각 1,500줄 상한이다. 새 로직은 전용 모듈로 만들고 기존 파일에서는 import와 연결만 한다.
- 모든 동작 변경은 실패하는 집중 테스트를 먼저 확인한다. jsdom 절대 시간은 CI 기준으로 사용하지 않고, 커밋 수·rect read 수·animation 수·상태 전이만 단정한다.
- 새 테스트에서 `toHaveBeenNthCalledWith`, `invocationCallOrder`, 불필요한 `mock.calls[index]`를 추가하지 않는다.
- 각 Task의 커밋에는 해당 Task 파일만 포함한다. Phase A는 Rust 파일을 변경하거나 Rust gate를 실행하지 않는다.

---

## Execution Preflight

- [ ] `superpowers:using-git-worktrees`를 사용해 `c7c253b` 기준 격리 worktree와 `codex/notes-enter-critical-path` 브랜치를 만든다.

- [ ] 격리 worktree에서 기준 상태를 확인한다.

  Run:

  ```bash
  git status --short
  git rev-parse HEAD
  npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useOutlineLayoutMotion.test.tsx src/features/notes/outlineRowMemo.test.tsx
  ```

  Expected: worktree는 clean, HEAD는 `c7c253b`, 집중 테스트는 PASS.

- [ ] main worktree의 네 사용자 소유 경로를 기록하고 격리 worktree 작업 중에는 접근하지 않는다.

---

### Task 1: 낙관적 split 제거와 first-child 예상 ID 선할당

**Files:**

- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/notesWorkspaceTypes.ts`
- Modify: `src/features/notes/useNotesCommandActions.ts`
- Modify: `src/features/notes/notesCommands.ts`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts`
- Modify: `src/features/notes/notesWorkspaceReducer.ts`
- Modify: `src/features/notes/notesWorkspaceReducer.test.ts`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src/features/notes/useNotesWorkspace.operations.test.tsx`

**Interfaces:**

- Consumes: existing `splitNode`, `createNode`, structural history, and
  contextual Enter guards.
- Produces: `NotesCreateChildOptions` and
  `createChild(nodeId, placement?, options?)`; removes
  `optimisticSplitInsert`/`optimisticSplitRollback`.

- [ ] **Step 1: 권위 결과 전에는 새 행과 포커스가 없다는 실패 테스트 작성**

  기존 optimistic describe를 제거하고 delayed split/child 응답을 사용해 다음 계약을 작성한다.

  ```ts
  fireEvent.keyDown(title, { key: "Enter" });

  await waitFor(() => expect(notesStoreMock.splitNode).toHaveBeenCalledOnce());
  expect(
    document.querySelectorAll('textarea[aria-label="Edit node title"]')
  ).toHaveLength(1);
  expect(title).toHaveFocus();

  await act(async () => split.resolve(authoritativeWorkspace));
  expect(await findTitleInput("")).toHaveFocus();
  ```

  first-child 테스트는 `createNode`가 받은 `input.id`가 keydown에서 선할당한 UUID인지 단정한다.

- [ ] **Step 2: RED 확인**

  Run:

  ```bash
  npm test -- src/features/notes/notesWorkspaceReducer.test.ts src/features/notes/NotesWorkspace.test.tsx src/features/notes/useNotesWorkspace.operations.test.tsx
  ```

  Expected: end-of-line split이 IPC 전에 빈 행을 렌더하므로 새 테스트 FAIL.

- [ ] **Step 3: optimistic action/type/reducer/runtime 제거**

  다음 surface를 완전히 삭제한다.

  ```ts
  optimisticSplitInsert?(sourceId: NoteId, newNodeId: NoteId): void;
  optimisticSplitRollback?(sourceId: NoteId, newNodeId: NoteId): void;
  ```

  `OutlineNodeRow.tsx`의 sibling-last 검사, optimistic dispatch, promise rollback을 제거하고 split은 항상 기존 권위 명령만 실행한다.

- [ ] **Step 4: child 생성 API에 선택적 예상 ID 추가**

  `notesWorkspaceTypes.ts`에 다음 옵션을 추가한다.

  ```ts
  export interface NotesCreateChildOptions {
    readonly newNodeId?: NoteId;
  }

  createChild(
    nodeId: NoteId,
    placement?: NotesChildPlacement,
    options?: NotesCreateChildOptions
  ): Promise<NotesWorkspaceCommandOutcome>;
  ```

  `createChildCommand`는 호출자가 준 ID를 우선 사용한다.

  ```ts
  // First statements inside createChildCommand:
  const id = options.newNodeId ?? createNoteId();
  const transitionToAll = ctx.libraryViewRef.current !== "all";
  ```

  현재 `runStructuralCommand` 본문 안의 `const id = createNoteId()`는
  삭제하고, 함수 시작에서 만든 `id`만 `createNode`, UI update, history
  location에 사용한다. 별도 helper나 두 번째 ID 생성 지점은 만들지
  않는다. `createFirstChild` keydown은 split과 동일하게 먼저 UUID를
  만든 뒤 전달한다. UUID 생성 실패 시 명령을 발행하지 않고 현재
  draft/caret를 유지한다.

- [ ] **Step 5: GREEN 및 잔여 surface 확인**

  Run:

  ```bash
  npm test -- src/features/notes/notesWorkspaceReducer.test.ts src/features/notes/NotesWorkspace.test.tsx src/features/notes/useNotesWorkspace.operations.test.tsx
  rg -n "optimisticSplitInsert|optimisticSplitRollback|optimistic end-of-line" src/features/notes
  ```

  Expected: 테스트 PASS, `rg` 결과 없음.

- [ ] **Step 6: 커밋**

  ```bash
  git add src/features/notes/OutlineNodeRow.tsx src/features/notes/notesWorkspaceTypes.ts src/features/notes/useNotesCommandActions.ts src/features/notes/notesCommands.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/notesWorkspaceReducer.ts src/features/notes/notesWorkspaceReducer.test.ts src/features/notes/NotesWorkspace.test.tsx src/features/notes/useNotesWorkspace.operations.test.tsx
  git commit -m "fix(notes): remove optimistic enter rows"
  ```

---

### Task 2: 삽입 소유권, 허용 visible diff, 상호작용 epoch를 순수 모듈로 고정

**Files:**

- Create: `src/features/notes/notesKeyboardInsertion.ts`
- Create: `src/features/notes/notesKeyboardInsertion.test.ts`
- Create: `src/features/notes/outlineInteractionEpoch.ts`
- Create: `src/features/notes/outlineInteractionEpoch.test.ts`
- Modify: `scripts/checkNotesWorkspaceBudgets.mjs`

**Interfaces:**

- Consumes: `NoteId`, `FlattenedOutlineRow`, `NotesWorkspaceScope`, and the
  existing history/session identifiers.
- Produces: `KeyboardInsertionIntent`, `PendingKeyboardInsertion`,
  `KeyboardInsertionSettlement`, `KeyboardInsertionDisposition`,
  `NotesProjectionPublicationOwner`, `OutlinePanePublicationSnapshot`,
  `classifyKeyboardInsertionPublication()`, and `OutlineInteractionEpoch`.

- [ ] **Step 1: registry와 분류기의 실패 테스트 작성**

  다음 경우를 표 기반으로 고정한다.

  - exact split과 exact first-child
  - 같은 intent가 소유한 text publication 뒤 structural publication
  - 다른 세션, Pane, generation, token, expected ID
  - ownership/history가 증명된 moved target은 `mixed`이면서
    `focusEligible: false`
  - 증명되지 않은 wrong relationship은 `mismatch`
  - expected target postcondition은 맞지만 그 밖의 허용 범위를 벗어난
    membership/parent/depth/collapse/order/geometry diff는 `mixed`
  - 다른 session이 old first-child 앞에 먼저 child를 넣었어도 expected
    node가 backend commit의 index 0이면 first-child identity는 current
  - 다른 session이 source를 먼저 move했어도 expected node가 source의
    current direct next sibling이면 split identity는 current
  - active drag 또는 다른 owner publication interleave는 `mixed`
  - 성공 promise만으로 registry가 제거되지 않음
  - terminal failure/unmount/Vault replacement에서 정확한 항목만 제거
  - accepted projection의 첫 React commit 전에 exact/mixed/mismatch가
    이미 publication에 들어 있고, 판정을 위한 추가 React commit은 0

- [ ] **Step 2: RED 확인**

  Run:

  ```bash
  npm test -- src/features/notes/notesKeyboardInsertion.test.ts src/features/notes/outlineInteractionEpoch.test.ts
  ```

  Expected: 모듈이 없으므로 FAIL.

- [ ] **Step 3: 고정된 소유권 타입과 keyed registry 구현**

  `historyEpoch`는 현재 도메인과 동일한 `string`이다.

  ```ts
  export type KeyboardInsertionKind = "split" | "first-child";

  export type KeyboardInsertionPostcondition =
    | {
        readonly kind: "split";
        readonly expectedSourceTitle: string;
        readonly expectedInsertedTitle: string;
      }
    | {
        readonly kind: "first-child";
        readonly expectedParentId: NoteId;
        readonly expectedIndex: 0;
        readonly expectedInsertedTitle: "";
      };

  export interface KeyboardInsertionIntent {
    readonly token: number;
    readonly ownerSessionGeneration: number;
    readonly sourceId: NoteId;
    readonly expectedNodeId: NoteId;
    readonly postcondition: KeyboardInsertionPostcondition;
  }

  export interface PendingKeyboardInsertion {
    readonly intent: KeyboardInsertionIntent;
    readonly ownerSessionId: string;
    readonly ownerPaneId: string;
    readonly interactionEpochAtDispatch: number;
    readonly expectedStructuralHistoryEpoch: string;
    readonly expectedStructuralHistoryEntryId: string;
    readonly projectionGenerationAtDispatch: number;
    readonly layoutGenerationAtDispatch: number;
  }
  ```

  Registry는 `Map<NoteId, PendingKeyboardInsertion>`으로 구현하고 `(expectedNodeId, intentToken)` 쌍이 일치할 때만 consume/cancel/transfer한다.

- [ ] **Step 4: settlement와 owner ledger 기반 분류 구현**

  ```ts
  export interface KeyboardInsertionSettlement {
    readonly intentToken: number;
    readonly expectedNodeId: NoteId;
    readonly ownerSessionId: string;
    readonly ownerPaneId: string;
    readonly ownerSessionGeneration: number;
    readonly interactionEpochAtDispatch: number;
    readonly baseProjectionGeneration: number;
    readonly acceptedProjectionGeneration: number;
    readonly baseLayoutGeneration: number;
    readonly acceptedLayoutGeneration: number;
    readonly authorityOutcome:
      | "postconditionAccepted"
      | "ownedButSuperseded"
      | "mismatch";
    readonly focusEligible: boolean;
  }

  export type KeyboardInsertionDisposition =
    | {
        readonly kind: "exact";
        readonly pending: PendingKeyboardInsertion;
        readonly settlement: KeyboardInsertionSettlement;
      }
    | {
        readonly kind: "mixed";
        readonly pending: PendingKeyboardInsertion;
        readonly settlement: KeyboardInsertionSettlement;
      }
    | {
        readonly kind: "mismatch";
        readonly pending: PendingKeyboardInsertion;
        readonly settlement: KeyboardInsertionSettlement;
      }
    | { readonly kind: "unrelated" };

  export type NotesProjectionPublicationOwner =
    | { readonly kind: "keyboard-insertion"; readonly intentToken: number }
    | { readonly kind: "keyboard-draft"; readonly intentToken: number }
    | { readonly kind: "other" };

  export interface OutlinePanePublicationSnapshot {
    readonly paneId: string;
    readonly sessionId: string;
    readonly scope: NotesWorkspaceScope;
    readonly zoomedNodeId: NoteId | null;
    readonly showCompleted: boolean;
    readonly collapsedNodeIds: ReadonlySet<NoteId>;
    readonly locallyExpandedNodeIds: ReadonlySet<NoteId>;
    readonly interactionEpoch: number;
    readonly visibleSignature: string;
    readonly geometryGeneration: number;
    readonly activeDrag: boolean;
  }

  export function classifyKeyboardInsertionPublication(input: {
    readonly pending: PendingKeyboardInsertion;
    readonly settlement: KeyboardInsertionSettlement;
    readonly previousPane: OutlinePanePublicationSnapshot;
    readonly acceptedVisibleRows: readonly FlattenedOutlineRow[];
    readonly publicationOwners: readonly NotesProjectionPublicationOwner[];
  }): KeyboardInsertionDisposition;
  ```

  exact 여부는 generation 차이를 산술 비교하지 않고, base 이후
  publication owner ledger와 허용 visible diff를 모두 검사한다.
  `authorityOutcome === "ownedButSuperseded"`는 항상 mixed/no-focus,
  `"mismatch"`는 normal-motion mismatch다. `postconditionAccepted`일 때만
  이전 Pane snapshot과 coordinator가 순수 projection으로 미리 계산한
  accepted rows를 비교해 exact/mixed를 정한다. 이 함수는 React
  layout/effect나 DOM 측정에 의존하지 않는다.
  First-child operation identity는 dispatch 때 보였던 old first-child ID를
  고정하지 않는다. Expected node가 authoritative parent의 index 0이고
  empty text인지로 판정한다. 동시 session이 먼저 다른 child를 삽입한 뒤
  backend가 lock 시점의 current first 위치에 expected node를 넣은 경우도
  current first-child로 인정한다. Old/new neighbor anchors는 compact delta
  base 검증용이며 insertion recovery identity가 아니다.
  Split도 dispatch 당시 parent를 고정하지 않는다. Candidate authority에서
  expected node와 source가 같은 current parent에 있고 expected node가
  source의 direct next sibling이며 prefix/suffix가 맞는지가 identity다.
  다른 session이 source를 먼저 move한 뒤 backend가 그 current parent에서
  split을 commit해도 current split으로 인정한다. Returned-base parent/index/
  neighbor anchors는 delta apply 검증에만 사용한다.

- [ ] **Step 5: Pane-local interaction epoch 구현**

  ```ts
  export type OutlineInteractionReason =
    | "keydown"
    | "beforeinput"
    | "input"
    | "compositionstart"
    | "pointerdown"
    | "selection-command"
    | "focus-command"
    | "pane-switch"
    | "unmount";

  export interface OutlineInteractionEpoch {
    current(): number;
    advance(reason: OutlineInteractionReason): number;
    isCurrent(epoch: number): boolean;
    runCommandFocus<T>(operation: () => T): T;
    commandFocusInProgress(): boolean;
    dispose(): void;
  }
  ```

  `dispose()`는 epoch를 한 번 증가시키고 이후 모든 `isCurrent`를 false로 만든다.

- [ ] **Step 6: GREEN 및 architecture inventory**

  두 새 production helper를 `notesWorkspaceProductionFiles`에 추가한다.

  Run:

  ```bash
  npm test -- src/features/notes/notesKeyboardInsertion.test.ts src/features/notes/outlineInteractionEpoch.test.ts
  npm run test:architecture
  ```

  Expected: PASS.

- [ ] **Step 7: 커밋**

  ```bash
  git add src/features/notes/notesKeyboardInsertion.ts src/features/notes/notesKeyboardInsertion.test.ts src/features/notes/outlineInteractionEpoch.ts src/features/notes/outlineInteractionEpoch.test.ts scripts/checkNotesWorkspaceBudgets.mjs
  git commit -m "feat(notes): define authoritative enter ownership"
  ```

---

### Task 3: coordinator publication과 expected-ID 명령을 연결

**Files:**

- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Modify: `src/features/notes/notesWorkspaceTypes.ts`
- Modify: `src/features/notes/useNotesHistoryController.ts`
- Modify: `src/features/notes/useNotesCommandActions.ts`
- Modify: `src/features/notes/notesCommands.ts`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/useNotesWorkspace.operations.test.tsx`
- Modify: `src/features/notes/useNotesWorkspace.sharedSession.test.tsx`

**Interfaces:**

- Consumes: Task 2의 pending insertion/Pane snapshot/classifier, normalized
  workspace, structural history settlement, and the existing pure outline
  projection.
- Produces: `NotesProjectionPublication`,
  `NotesKeyboardInsertionRequest`,
  `NotesKeyboardInsertionPreparation`,
  `prepareKeyboardInsertion()`, `publishOutlinePaneState()`, and an atomic
  projection + insertion-disposition + focus-request publication.

- [ ] **Step 1: coordinator 소유권 실패 테스트 작성**

  `notesWorkspaceCoordinator.test.ts`에 다음을 단정한다.

  - structural history context가 생성된 뒤 pending entry가 session ID, history epoch/entry, base generations에 bind됨
  - command promise가 resolve되어도 accepted projection 전에는 consume하지 않음
  - accepted workspace와 history가 모두 맞을 때만 `keyboardInsertionSettlement` 발행
  - 다른 세션 publication, active drag, unrelated layout owner가 interleave하면 mixed
  - ownership/history가 expected ID 생성을 증명하지만 현재 relationship이
    move/supersede된 경우는 mixed zero-motion/no-focus로 terminal settle
  - exact proof가 없는 wrong ID/relationship/history는 mismatch로
    terminal cancel하고 normal motion 유지
  - shared Vault의 두 session은 서로의 intent를 소비하지 않음
  - 첫 accepted projection publication에 disposition과 focus request가
    이미 포함되며 classification-only React commit은 0
  - collapsed parent의 contextual first-child는 prospective local expansion
    을 포함해 첫 commit부터 exact/focus-eligible
  - show-completed on/off Pane은 같은 authority에서 각각 실제 render와
    동일한 prospective signature를 계산
  - drag start가 Pane render보다 먼저 발생하고 command가 그 사이
    settle해도 cached active-drag가 즉시 true여서 mixed

- [ ] **Step 2: RED 확인**

  Run:

  ```bash
  npm test -- src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx
  ```

  Expected: queue result에 publication/settlement 정보가 없어 FAIL.

- [ ] **Step 3: queue와 projection publication 타입 확장**

  ```ts
  export interface NotesProjectionPublication {
    readonly projectionGeneration: number;
    readonly layoutGeneration: number;
    readonly owner: NotesProjectionPublicationOwner;
    readonly keyboardInsertionDisposition?: KeyboardInsertionDisposition;
  }
  ```

  authoritative queue result와 `synchronized` event가 이 publication을
  전달하게 한다. Coordinator entry가 projection generation과 Pane별
  layout generation/owner ledger를 소유한다. Coordinator는 terminal
  settle 때 history/operation ownership을 먼저 증명하고, 아래 Step 6의
  cached Pane descriptor와 pure projection을 사용해 disposition을
  publication 전에 동기 계산한다. React가 projection을 먼저 publish한 뒤
  Pane 보고를 기다리는 2단계 protocol은 금지한다.

- [ ] **Step 4: keydown에서 history와 insertion 권위를 한 번 준비**

  actions surface를 다음과 같이 확장한다.

  ```ts
  export interface NotesKeyboardInsertionRequest {
    readonly ownerPaneId: string;
    readonly interactionEpochAtDispatch: number;
    readonly intent: Omit<
      KeyboardInsertionIntent,
      "ownerSessionGeneration"
    >;
  }

  export interface NotesKeyboardInsertionPreparation {
    readonly pending: PendingKeyboardInsertion;
    readonly historyContext: NotesHistoryContext;
  }

  prepareKeyboardInsertion(
    input: NotesKeyboardInsertionRequest
  ): NotesKeyboardInsertionPreparation | null;
  ```

  `prepareKeyboardInsertion`은 caller에게 노출하지 않은 owner session ID와
  session generation, history snapshot, projection/layout generation을
  coordinator entry에서 주입하고 structural history entry를 선할당한다.
  Pane은 session generation을 읽거나 만들어 전달하지 않는다. 실패하면
  registry/history owner를 남기지 않는다.

- [ ] **Step 5: split과 first-child가 준비된 권위를 사용**

  ```ts
  export interface NotesWorkspaceCompoundOptions {
    readonly draft?: NotesNodeDraft;
    readonly expandNodeId?: NoteId;
    readonly onSuccess?: () => void;
    readonly keyboardInsertion?: NotesKeyboardInsertionPreparation;
  }

  export interface NotesCreateChildOptions {
    readonly newNodeId?: NoteId;
    readonly keyboardInsertion?: NotesKeyboardInsertionPreparation;
  }
  ```

  split/createChild는 `runStructuralCommand`에 선할당한 `historyContext`와
  pending insertion을 전달한다. `enqueueStructural`은 queue item에 이를
  보관하고 terminal settle에서 authority outcome을 판정한 뒤, prospective
  Pane projection을 사용해 exact/mixed/mismatch를 결정한다.
  Contextual first-child caller는
  `createChild(parentId, placement, { newNodeId, keyboardInsertion })` 하나로
  두 값을 함께 넘긴다. `newNodeId`와
  `keyboardInsertion.pending.intent.expectedNodeId`가 다르면 dispatch 전에
  실패하고 어느 owner/history entry도 남기지 않는다.

- [ ] **Step 6: prospective Pane projection, clock, active drag 보고 연결**

  `NotesOutlinePane`은 stable Pane ID를 한 번 만들고 committed render의
  descriptor를 coordinator에 보고한다.

  ```ts
  actions.publishOutlinePaneState({
    paneId,
    scope,
    zoomedNodeId,
    showCompleted,
    collapsedNodeIds,
    locallyExpandedNodeIds,
    interactionEpoch: interactionEpoch.current(),
    visibleSignature: createOutlineVisibleSignature(visibleRows),
    geometryGeneration,
    activeDrag: activeDragId !== null
  });
  ```

  Action surface는 session-bound closure가 owner session을 주입하도록 다음
  exact signature를 사용한다. Pane에 raw session ID를 새로 노출하지 않는다.

  ```ts
  publishOutlinePaneState(
    input: Omit<OutlinePanePublicationSnapshot, "sessionId">
  ): void;

  publishOutlineInteractionEpoch(input: {
    readonly paneId: string;
    readonly interactionEpoch: number;
  }): void;

  publishOutlineDragState(input: {
    readonly paneId: string;
    readonly activeDrag: boolean;
  }): void;
  ```

  visible signature는 membership/order/parent/depth/collapse를 포함한다.
  ResizeObserver가 검증한 row geometry 변화만 geometry generation을
  증가시킨다. Key/input/composition/pointer/selection/focus 이벤트가 epoch를
  올릴 때는 React render를 기다리지 않고 coordinator의 cached
  `interactionEpoch`도 동기 갱신한다.
  DnD `onDragStart`, `onDragEnd`, `onDragCancel` entry도 local state update와
  같은 call stack에서 `publishOutlineDragState()`를 먼저 호출한다. 따라서
  drag state React commit과 command settlement 사이 race에서도 exact로
  잘못 분류하지 않는다.

  Terminal authority를 수용하기 직전 coordinator는 cached scope,
  zoom/show-completed/collapse/local-expansion descriptor와 새 normalized workspace에
  기존 pure outline projection을 실행하고 accepted visible
  rows/signature를 계산한다. First-child intent면 projection 전에
  `pending.postcondition.expectedParentId`를 prospective
  `locallyExpandedNodeIds`에 추가해 현재 `expandNodeId` 동작과 동일하게
  계산하고, accepted atomic publication에서 Pane의 local expansion에도
  같은 ID를 반영한다. 이전
  committed signature, owner ledger, geometry generation, active drag와 함께
  `classifyKeyboardInsertionPublication()`을 호출한 뒤 그 disposition을
  projection과 같은 notification에 넣는다. 따라서 첫 accepted React
  commit에서 `useOutlineLayoutMotion`이 이미 zero-read 여부를 안다.

  Pane render가 같은 pure helper로 만든 signature와 publication signature를
  즉시 비교해 불일치하면 exact를 mixed/no-focus로 보수적으로 낮추되
  zero-motion은 유지하고 development invariant를 기록한다. 이 검사는
  state를 쓰거나 두 번째 classification commit을 만들지 않는다.

- [ ] **Step 7: GREEN**

  Run:

  ```bash
  npm test -- src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx src/features/notes/NotesWorkspace.test.tsx
  ```

  Expected: PASS. first-child와 split 모두 expected ID가 authority 수용 전에는 보이지 않고, 수용 뒤 exact settlement를 가진다.

- [ ] **Step 8: 커밋**

  ```bash
  git add src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesWorkspaceTypes.ts src/features/notes/useNotesHistoryController.ts src/features/notes/useNotesCommandActions.ts src/features/notes/notesCommands.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx
  git commit -m "feat(notes): publish authoritative enter settlements"
  ```

---

### Task 4: invoke 이후 outcomeUnknown을 한 번의 reload로 복구

**Files:**

- Create: `src/features/notes/notesAuthorityRecovery.ts`
- Create: `src/features/notes/notesAuthorityRecovery.test.ts`
- Modify: `src/domain/notes.ts`
- Modify: `src/services/notesStore.ts`
- Modify: `src/services/notesStore.tauri.test.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Modify: `src/features/notes/notesWorkspaceCommandSupport.ts`
- Modify: `src/features/notes/useNotesDraftWorkflow.ts`
- Modify: `src/features/notes/notesDraftEngine.ts`
- Modify: `src/features/notes/notesDraftEngine.test.ts`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts`
- Modify: `src/features/notes/notesWorkspaceTypes.ts`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/useNotesWorkspace.operations.test.tsx`
- Modify: `src/features/notes/useNotesWorkspace.sharedSession.test.tsx`
- Modify: `scripts/checkNotesWorkspaceBudgets.mjs`

**Interfaces:**

- Consumes: Tauri invoke/decode boundary, pending operation postcondition,
  origin-session history status, queue generation, and draft attempts.
- Produces: `NotesMutationDispatchFailure`, `NotesUnknownOutcomeDecision`,
  `NotesWriteAuthority`, `recoverUnknownOutcome()`, and draft
  pause/resume/manual-retry controls.

- [ ] **Step 1: transport/decoding 경계 실패 테스트 작성**

  `notesStore.tauri.test.ts`에서 다음을 구분한다.

  - UUID/input 검증처럼 invoke 전 실패는 local preflight
  - `invoke` promise rejection은 `outcomeUnknown`
  - resolved payload decoding 실패도 `outcomeUnknown`
  - 어떤 unknown 경로도 mutation IPC를 두 번 호출하지 않음

- [ ] **Step 2: 복구 분류와 hard-lock 실패 테스트 작성**

  `notesAuthorityRecovery.test.ts`에서 구조 postcondition와 history epoch/entry/nextUndo가 모두 맞으면 `committedAndCurrent`, workspace만 맞으면 `committedWithoutHistoryProof`, postcondition이 없으면 `notProvenCommitted`, reload 실패면 `authorityUnknown`을 기대한다.

  Coordinator/draft tests는 reload single-flight, zero replay, dirty-save
  uncertainty 뒤 split 미발행, draft 보존, timer pause,
  save/structure/Undo/Redo 차단을 단정한다.
  `committedWithoutHistoryProof`는 workspace 수용 뒤 focus 0,
  `recoverHistoryMismatch` 1회, history recovery 완료 전 Undo/Redo false를
  별도로 단정한다.

- [ ] **Step 3: RED 확인**

  Run:

  ```bash
  npm test -- src/services/notesStore.tauri.test.ts src/features/notes/notesAuthorityRecovery.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx
  ```

  Expected: unknown-outcome 타입과 복구/lock이 없어 FAIL.

- [ ] **Step 4: invoke 경계를 타입으로 표시**

  ```ts
  export type NotesMutationDispatchFailure =
    | { readonly kind: "preflight"; readonly cause: unknown }
    | { readonly kind: "outcomeUnknown"; readonly cause: unknown };

  export function isNotesMutationOutcomeUnknown(
    cause: unknown
  ): cause is Error & { readonly notesMutationOutcome: "unknown" };
  ```

  Tauri `invoke()` 호출로 promise를 얻은 직후부터 rejection과 decode 오류를 unknown으로 brand한다. 오류 문자열이나 retryable code를 근거로 `notCommitted`를 추론하지 않는다.

- [ ] **Step 5: 순수 recovery classifier 구현**

  ```ts
  export type NotesUnknownOutcomeDecision =
    | {
        readonly kind: "committedAndCurrent";
        readonly workspace: NormalizedNotesWorkspace;
        readonly historyStatus: NotesHistoryStatus;
      }
    | {
        readonly kind: "committedWithoutHistoryProof";
        readonly workspace: NormalizedNotesWorkspace;
        readonly historyStatus?: NotesHistoryStatus;
      }
    | {
        readonly kind: "notProvenCommitted";
        readonly workspace: NormalizedNotesWorkspace;
        readonly historyStatus?: NotesHistoryStatus;
      }
    | { readonly kind: "authorityUnknown"; readonly error: string };
  ```

  structural expectation은 expected node relationship, split source prefix/suffix 또는 empty first-child, history epoch, entry ID, next Undo를 검사한다. Draft expectation은 persisted text와 별도 text history context를 검사한다.

- [ ] **Step 6: coordinator single-flight recovery와 write lock 구현**

  ```ts
  export type NotesWriteAuthority =
    | { readonly kind: "known" }
    | { readonly kind: "recovering"; readonly generation: number }
    | { readonly kind: "unknown"; readonly error: string };
  ```

  현재 running item 내부의 `recoverUnknownOutcome`만 `loadWorkspace(active)`와 origin-session `historyStatus`를 직접 호출한다. 같은 Vault/generation의 호출자는 하나의 promise를 공유한다. reload 결과는 workspace/history를 함께 수용하고, mutation은 재호출하지 않는다.

- [ ] **Step 7: draft barrier와 hard recovery UI 연결**

  `NotesDraftEngine`에 다음 명시적 제어를 추가한다.

  ```ts
  pauseForAuthorityRecovery(): void;
  resumeAfterAuthorityRecovery(): void;
  markDispatchedAttemptManualRetry(attemptId: string): void;
  ```

  Phase A에서는 모든 timer를 pause하고 draft Map을 유지한다. dirty draft가 unknown이면 classifier 결과와 관계없이 해당 Enter의 structural step을 중단한다.

  `committedWithoutHistoryProof`에서는 reloaded workspace를 authoritative
  projection으로 먼저 수용하되 insertion intent를 cancel하고 focus를
  발행하지 않는다. 이어서 기존
  `session.recoverHistoryMismatch(...)` 경로로 origin session history를
  reset/reload하고, 성공하기 전에는 Undo/Redo를 다시 열지 않는다. 이
  전이에서 expected entry를 Undo 가능하다고 표시하거나 새 history
  entry를 만들지 않는다. History recovery 자체가 실패하면 같은
  `authorityUnknown` hard lock으로 승격한다.

  `NotesStateSlice`에는 `authorityRecovery`와 `retryAuthorityRecovery`를 노출하고, `NotesOutlinePane`은 `aria-busy` 및 `role="alert"` retry banner를 표시한다.

- [ ] **Step 8: GREEN 및 architecture inventory**

  Run:

  ```bash
  npm test -- src/services/notesStore.tauri.test.ts src/features/notes/notesAuthorityRecovery.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx
  npm run test:architecture
  ```

  Expected: PASS.

- [ ] **Step 9: 커밋**

  ```bash
  git add src/domain/notes.ts src/services/notesStore.ts src/services/notesStore.tauri.test.ts src/features/notes/notesAuthorityRecovery.ts src/features/notes/notesAuthorityRecovery.test.ts src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesWorkspaceCommandSupport.ts src/features/notes/useNotesDraftWorkflow.ts src/features/notes/notesDraftEngine.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/notesWorkspaceTypes.ts src/features/notes/NotesOutlinePane.tsx src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx scripts/checkNotesWorkspaceBudgets.mjs
  git commit -m "fix(notes): recover uncertain mutations without replay"
  ```

---

### Task 5: exact/mixed Enter settlement의 zero-read·zero-motion 경로

**Files:**

- Modify: `src/features/notes/useOutlineLayoutMotion.ts`
- Modify: `src/features/notes/useOutlineLayoutMotion.test.tsx`
- Modify: `src/features/notes/outlineLayoutMotion.ts`
- Modify: `src/features/notes/outlineLayoutMotion.test.ts`
- Modify: `src/features/notes/NotesOutlinePane.tsx`

**Interfaces:**

- Consumes: same-publication `NotesProjectionPublication`,
  `KeyboardInsertionDisposition`, rows, and layout-motion refs.
- Produces: the expanded `UseOutlineLayoutMotionOptions` contract,
  exact/mixed zero-read consumption, and missing-baseline invalidation.

- [ ] **Step 1: rect read와 animation 수 실패 테스트 작성**

  exact split, exact first-child, ownership-proven mixed, reduced motion에 대해 root/row/`.notes-node-main` `getBoundingClientRect` 호출 합계와 `Element.animate` 호출이 모두 0인지 단정한다.

  mismatch/unrelated collapse/expand/drag는 기존 motion eligibility를 유지하는 테스트도 함께 둔다.

- [ ] **Step 2: RED 확인**

  Run:

  ```bash
  npm test -- src/features/notes/useOutlineLayoutMotion.test.tsx src/features/notes/outlineLayoutMotion.test.ts
  ```

  Expected: 현재 skip/reduced path도 baseline을 capture하므로 rect-read 단정 FAIL.

- [ ] **Step 3: hook 입력을 publication 단위로 확장**

  ```ts
  interface UseOutlineLayoutMotionOptions {
    readonly rootRef: RefObject<HTMLElement | null>;
    readonly rows: readonly OutlineLayoutMotionRow[];
    readonly activeDrag: boolean;
    readonly initialLoading: boolean;
    readonly isComposing: boolean;
    readonly publication: NotesProjectionPublication | null;
    readonly insertionDisposition: KeyboardInsertionDisposition;
    readonly onInsertionMotionConsumed: (intentToken: number) => void;
    readonly onSettledFirstPaint: (generation: number) => void;
  }
  ```

- [ ] **Step 4: structural signature 처리 전에 Enter fast path 실행**

  exact/mixed면 active animation을 cancel하고 intent를 한 번 consume한 뒤 signature/count만 갱신한다. rect capture와 target collection을 호출하지 않고 `hasMotionBaseline=false`로 만든다.

  pending IPC나 같은 intent의 non-layout draft publication에는 baseline 작업을 시작하지 않는다.

- [ ] **Step 5: stale baseline 안전 규칙 구현**

  baseline이 없는 상태의 첫 unrelated structural transition은 최종 layout을 capture만 하고 애니메이션을 만들지 않는다. 이후 non-overlap transition부터 기존 motion을 다시 허용한다.

- [ ] **Step 6: main 사용자 변경과 의미 비교**

  main worktree diff를 read-only로 확인한다.

  ```bash
  git -C /Users/doortts/repos/yonalist diff -- src/features/notes/outlineLayoutMotion.ts src/features/notes/outlineLayoutMotion.test.ts src/features/notes/useOutlineLayoutMotion.test.tsx
  ```

  Expected: 사용자 변경의 단일 entering-row skip 의도는 새 exact/mixed zero-motion 계약에 포함되고, shifted rows와 rect reads까지 새 테스트가 포괄한다. main 파일은 변경하지 않는다.

- [ ] **Step 7: GREEN**

  Run:

  ```bash
  npm test -- src/features/notes/useOutlineLayoutMotion.test.tsx src/features/notes/outlineLayoutMotion.test.ts
  ```

  Expected: PASS.

- [ ] **Step 8: 커밋**

  ```bash
  git add src/features/notes/useOutlineLayoutMotion.ts src/features/notes/useOutlineLayoutMotion.test.tsx src/features/notes/outlineLayoutMotion.ts src/features/notes/outlineLayoutMotion.test.ts src/features/notes/NotesOutlinePane.tsx
  git commit -m "perf(notes): skip enter layout measurement"
  ```

---

### Task 6: 첫 paint 이후 단 하나의 cancelable idle baseline

**Files:**

- Create: `src/features/notes/outlineIdleBaseline.ts`
- Create: `src/features/notes/outlineIdleBaseline.test.ts`
- Modify: `src/features/notes/useOutlineLayoutMotion.ts`
- Modify: `src/features/notes/useOutlineLayoutMotion.test.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `scripts/checkNotesWorkspaceBudgets.mjs`

**Interfaces:**

- Consumes: settled publication generation, input activity, nested animation
  frames, and the motion hook's synchronous-capture signal.
- Produces: `OutlineIdleBaselineScheduler`, `afterSettledFirstPaint()`,
  `suspendForPendingInsertion()`, `noteActivity()`,
  `completeFromSynchronousCapture()`, and `dispose()`.

- [ ] **Step 1: deterministic scheduler 실패 테스트 작성**

  fake timer와 가짜 idle callback으로 다음을 고정한다.

  - settled first paint 전에는 task/capture 0
  - 150ms quiet 뒤 idle callback 하나
  - idle API가 없으면 quiet 만료 시 즉시 한 번 capture
  - 입력마다 기존 timer/idle을 cancel하고 최신 generation 하나만 rearm
  - 총 pending task는 항상 0 또는 1
  - latest paint/last rearm 중 늦은 시점부터 650ms 이내 capture
  - 첫 rAF callback에서는 아직 scheduler가 시작되지 않고 두 번째
    generation-matched rAF에서만 settled first paint를 인정
  - baseline 없는 첫 unrelated transition이 synchronous capture를
    완료하면 같은/이전 generation idle task를 cancel하고 추가 capture 0
  - unmount와 다음 Enter가 두 rAF와 stale callback을 모두 무효화
  - 이전 settlement가 예약한 idle task가 있어도 새 insertion dispatch는
    즉시 cancel-only suspend하고, IPC가 650ms 이상 지연되는 동안
    timer/idle/rect capture 모두 0

- [ ] **Step 2: RED 확인**

  Run:

  ```bash
  npm test -- src/features/notes/outlineIdleBaseline.test.ts src/features/notes/useOutlineLayoutMotion.test.tsx
  ```

  Expected: scheduler가 없어 FAIL.

- [ ] **Step 3: scheduler 구현**

  ```ts
  export interface OutlineIdleBaselineScheduler {
    suspendForPendingInsertion(generation: number): void;
    afterSettledFirstPaint(generation: number): void;
    noteActivity(generation: number): void;
    completeFromSynchronousCapture(generation: number): void;
    dispose(): void;
    pendingCount(): 0 | 1;
  }

  export function createOutlineIdleBaselineScheduler(options: {
    readonly quietMs: 150;
    readonly idleTimeoutMs: 500;
    readonly requestIdle: (
      callback: IdleRequestCallback,
      timeoutMs: number
    ) => unknown;
    readonly cancelIdle: (handle: unknown) => void;
    readonly captureLatest: (generation: number) => void;
  }): OutlineIdleBaselineScheduler;
  ```

  quiet timer와 idle callback을 합쳐 logical task 하나로 계수한다.
  `suspendForPendingInsertion`은 기존 timer/idle을 cancel하고 pending
  insertion generation을 기록하지만 새 task를 arm하지 않는다. Suspended
  동안 `noteActivity`는 cancel/update만 하고 rearm하지 않는다.
  `afterSettledFirstPaint`가 같은/더 최신 generation을 받은 뒤에만 suspend를
  해제하고 quiet timer 하나를 arm한다. Callback은 captured generation이
  최신일 때만 baseline을 기록한다.

- [ ] **Step 4: hook/Panes 이벤트 연결**

  Exact/mixed settlement의 React commit 뒤 중첩
  `requestAnimationFrame(() => requestAnimationFrame(...))`을 사용한다.
  첫 callback과 둘째 callback 사이의 paint가 완료되고 두 callback 모두
  최신 publication generation일 때만 `afterSettledFirstPaint`를 호출한다.
  Unmount/새 settlement는 저장한 두 frame handle을 cancel한다. Keydown,
  beforeinput, input, compositionstart, pointerdown, focus/selection command를
  `noteActivity`에 연결한다.

  `prepareKeyboardInsertion`이 성공한 exact keydown call stack에서는
  먼저 `suspendForPendingInsertion(baseLayoutGeneration)`을 호출한다.
  일반 activity와 달리 이 path는 quiet task를 재예약하지 않는다. Typed
  failure/mismatch도 terminal publication 또는 cancel path가 명시적으로
  최신 committed generation을 넘긴 뒤에만 baseline 재구축을 허용한다.

  Task 5의 stale-baseline 안전 규칙이 첫 unrelated transition의 최종
  layout을 즉시 capture하면
  `completeFromSynchronousCapture(capturedGeneration)`을 호출한다. Scheduler는
  pending generation 이하의 quiet/idle callback을 cancel하고 completed
  generation을 기록해 뒤늦은 callback이 두 번째 rect capture를 만들지
  못하게 한다.

- [ ] **Step 5: GREEN 및 architecture inventory**

  Run:

  ```bash
  npm test -- src/features/notes/outlineIdleBaseline.test.ts src/features/notes/useOutlineLayoutMotion.test.tsx
  npm run test:architecture
  ```

  Expected: PASS.

- [ ] **Step 6: 커밋**

  ```bash
  git add src/features/notes/outlineIdleBaseline.ts src/features/notes/outlineIdleBaseline.test.ts src/features/notes/useOutlineLayoutMotion.ts src/features/notes/useOutlineLayoutMotion.test.tsx src/features/notes/NotesOutlinePane.tsx scripts/checkNotesWorkspaceBudgets.mjs
  git commit -m "perf(notes): rebuild one idle outline baseline"
  ```

---

### Task 7: full result에서도 변경되지 않은 노드와 visible row 참조 유지

**Files:**

- Create: `src/features/notes/notesWorkspaceIdentity.ts`
- Create: `src/features/notes/notesWorkspaceIdentity.test.ts`
- Create: `src/features/notes/outlineRowProjection.ts`
- Create: `src/features/notes/outlineRowProjection.test.ts`
- Modify: `src/features/notes/notesWorkspaceReducer.ts`
- Modify: `src/features/notes/notesWorkspaceReducer.test.ts`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `scripts/checkNotesWorkspaceBudgets.mjs`

**Interfaces:**

- Consumes: previous/next `NormalizedNotesWorkspace` and
  `FlattenedOutlineRow[]`.
- Produces: `retainNormalizedWorkspaceIdentity()` and
  `retainOutlineRowProjection()` with exhaustive structural equality.

- [ ] **Step 1: identity retention 실패 테스트 작성**

  full workspace payload가 모든 객체를 새로 만들더라도 다음을 기대한다.

  - 값이 같은 49개 `NoteNode`는 이전 객체와 `===`
  - 바뀐 source와 새 expected node만 새 객체
  - 값이 같은 attachment arrays와 untouched child/root arrays는 이전 참조
  - 순서만 밀린 row도 depth/guides/descendant metadata가 같으면 이전 row 객체
  - 실제 parent/depth/collapse/guide 변화는 새 row 객체

- [ ] **Step 2: RED 확인**

  Run:

  ```bash
  npm test -- src/features/notes/notesWorkspaceIdentity.test.ts src/features/notes/outlineRowProjection.test.ts src/features/notes/notesWorkspaceReducer.test.ts
  ```

  Expected: full normalize가 모든 참조를 교체해 FAIL.

- [ ] **Step 3: exhaustive structural sharing 구현**

  ```ts
  export function retainNormalizedWorkspaceIdentity(
    previous: NormalizedNotesWorkspace,
    next: NormalizedNotesWorkspace
  ): NormalizedNotesWorkspace;
  ```

  `NoteNode`와 `NoteAttachment`의 모든 도메인 필드를 비교한다. 동일 ID 배열은 길이와 각 원소가 같을 때만 이전 배열을 재사용한다. mutable cache나 시간 기반 eviction은 추가하지 않는다.

- [ ] **Step 4: full settle에만 identity retention 적용**

  ```ts
  if (!delta) {
    return retainNormalizedWorkspaceIdentity(
      state,
      normalizeWorkspace(workspace)
    );
  }
  ```

  기존 delta copy-on-write 경로는 그대로 유지한다.

- [ ] **Step 5: visible row projection retention 구현**

  ```ts
  export function retainOutlineRowProjection(
    previous: readonly FlattenedOutlineRow[],
    next: readonly FlattenedOutlineRow[]
  ): readonly FlattenedOutlineRow[];
  ```

  Generic placeholder type은 만들지 않는다. `FlattenedOutlineRow`의
  `id`, `parentId`, `depth`, `isCollapsed`, `ancestorIds`,
  `ancestorGuideDepths`, `visibleDescendantEndId`를 모두 비교한다.
  `NotesOutlinePane`은 flatten 결과를 ref와 이 helper를 통해 안정화한다.
  Order 변경 자체는 배열 순서로 표현하고, row metadata가 같으면 row
  객체를 재사용한다.

- [ ] **Step 6: GREEN 및 architecture inventory**

  Run:

  ```bash
  npm test -- src/features/notes/notesWorkspaceIdentity.test.ts src/features/notes/outlineRowProjection.test.ts src/features/notes/notesWorkspaceReducer.test.ts
  npm run test:architecture
  ```

  Expected: PASS.

- [ ] **Step 7: 커밋**

  ```bash
  git add src/features/notes/notesWorkspaceIdentity.ts src/features/notes/notesWorkspaceIdentity.test.ts src/features/notes/outlineRowProjection.ts src/features/notes/outlineRowProjection.test.ts src/features/notes/notesWorkspaceReducer.ts src/features/notes/notesWorkspaceReducer.test.ts src/features/notes/NotesOutlinePane.tsx scripts/checkNotesWorkspaceBudgets.mjs
  git commit -m "perf(notes): retain unchanged outline identities"
  ```

---

### Task 8: sortable shell과 heavy editor 분리

**Files:**

- Create: `src/features/notes/OutlineSortableShell.tsx`
- Create: `src/features/notes/OutlineSortableShell.test.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/outlineRowMemo.test.tsx`
- Modify: `scripts/checkNotesWorkspaceBudgets.mjs`

**Interfaces:**

- Consumes: retained `FlattenedOutlineRow`/`NoteNode` identities, primitive
  presentation flags, target-only focus request, and a stable
  `getStateSnapshot()`.
- Produces: `OutlineSortableShellProps`, `OutlineSortableHandleValue`,
  `useOutlineSortableHandle()`, `OutlineSortableHandle`, and
  `OutlineNodeEditorProps` whose comparator is stable for unchanged rows.

- [ ] **Step 1: 실제 shell/editor Profiler 실패 테스트 작성**

  `OutlineNodeRow` 전체 mock을 제거하고 50 visible rows fixture에서 clean split, dirty split, dirty first-child를 각각 실행한다.

  ```ts
  expect(unchangedEditorCommitIds).toEqual([]);
  expect(existingShellCommitCounts.every((count) => count <= 1)).toBe(true);
  expect(newEditorMountCount).toBe(1);
  expect(newShellMountCount).toBe(1);
  ```

  stable snapshot getter가 shared-session sibling update를 읽지만 unchanged editor commit 수는 0인 테스트도 추가한다.
  Authoritative insert render 다음 focus acknowledgement가 Pane을 다시
  render해도 새 `ReactElement`/data props allocation 때문에 49개 unchanged
  shell이 두 번째 commit하지 않는지 별도로 단정한다.

- [ ] **Step 2: RED 확인**

  Run:

  ```bash
  npm test -- src/features/notes/outlineRowMemo.test.tsx
  ```

  Expected: broad `useNotesState`와 `useSortable` identity 때문에 unchanged editor가 commit해 FAIL.

- [ ] **Step 3: sortable shell/handle 구현**

  ```tsx
  type OutlineSortableHandleValue = Pick<
    ReturnType<typeof useSortable>,
    "attributes" | "listeners" | "setActivatorNodeRef"
  >;

  const OutlineSortableHandleContext =
    createContext<OutlineSortableHandleValue | null>(null);

  export function useOutlineSortableHandle(): OutlineSortableHandleValue {
    const value = useContext(OutlineSortableHandleContext);
    if (!value) {
      throw new Error("OutlineSortableHandle requires OutlineSortableShell.");
    }
    return value;
  }

  export interface OutlineSortableShellProps {
    readonly nodeId: NoteId;
    readonly disabled: boolean;
    readonly depth: number;
    readonly suppressDragPresentation: boolean;
    readonly className: string;
    readonly completed: boolean;
    readonly markerKind: NoteMarkerKind;
    readonly emptyBullet: boolean;
    readonly guideEndId: NoteId | null;
    readonly selected: boolean;
    readonly rangeSelected: boolean;
    readonly attachmentTargetId: NoteId | null;
    readonly imageDropActive: boolean;
    readonly editor: ReactElement;
  }

  const OUTLINE_SHELL_PRIMITIVE_KEYS = [
    "nodeId",
    "disabled",
    "depth",
    "suppressDragPresentation",
    "className",
    "completed",
    "markerKind",
    "emptyBullet",
    "guideEndId",
    "selected",
    "rangeSelected",
    "attachmentTargetId",
    "imageDropActive"
  ] as const satisfies readonly (keyof OutlineSortableShellProps)[];

  function shallowObjectIs(
    previous: Readonly<Record<string, unknown>>,
    next: Readonly<Record<string, unknown>>
  ): boolean {
    const previousKeys = Object.keys(previous);
    const nextKeys = Object.keys(next);
    return (
      previousKeys.length === nextKeys.length &&
      previousKeys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(next, key) &&
          Object.is(previous[key], next[key])
      )
    );
  }

  function areOutlineSortableShellPropsEqual(
    previous: OutlineSortableShellProps,
    next: OutlineSortableShellProps
  ): boolean {
    return (
      OUTLINE_SHELL_PRIMITIVE_KEYS.every((key) =>
        Object.is(previous[key], next[key])
      ) &&
      previous.editor.type === next.editor.type &&
      previous.editor.key === next.editor.key &&
      shallowObjectIs(
        previous.editor.props as Readonly<Record<string, unknown>>,
        next.editor.props as Readonly<Record<string, unknown>>
      )
    );
  }

  export const OutlineSortableShell = memo(
    function OutlineSortableShell(props: OutlineSortableShellProps) {
      const sortable = useSortable({
        id: props.nodeId,
        disabled: props.disabled
      });
      return (
        <OutlineSortableHandleContext.Provider
          value={{
            attributes: sortable.attributes,
            listeners: sortable.listeners,
            setActivatorNodeRef: sortable.setActivatorNodeRef
          }}
        >
          <div
            ref={sortable.setNodeRef}
            className={props.className}
            data-outline-id={props.nodeId}
            data-completed={props.completed ? "true" : undefined}
            data-marker-kind={props.markerKind}
            data-empty-bullet={props.emptyBullet ? "true" : undefined}
            data-dragging={
              !props.suppressDragPresentation && sortable.isDragging
                ? "true"
                : undefined
            }
            data-guide-end-id={props.guideEndId ?? undefined}
            data-selected={props.selected ? "true" : undefined}
            data-range-selected={props.rangeSelected ? "true" : undefined}
            data-notes-attachment-target={
              props.attachmentTargetId ?? undefined
            }
            data-image-drop-active={
              props.imageDropActive ? "true" : undefined
            }
            style={{
              "--notes-depth": props.depth,
              transform:
                !props.suppressDragPresentation && sortable.transform
                  ? `translate3d(${sortable.transform.x}px, ${sortable.transform.y}px, 0) scaleX(${sortable.transform.scaleX}) scaleY(${sortable.transform.scaleY})`
                  : undefined,
              transition: props.suppressDragPresentation
                ? undefined
                : sortable.transition
            } as CSSProperties}
          >
            {props.editor}
          </div>
        </OutlineSortableHandleContext.Provider>
      );
    },
    areOutlineSortableShellPropsEqual
  );

  export interface OutlineSortableHandleProps
    extends Omit<ComponentPropsWithoutRef<"button">, "ref"> {
    readonly enabled: boolean;
  }

  export const OutlineSortableHandle = memo(function OutlineSortableHandle({
    enabled,
    onKeyDown,
    ...buttonProps
  }: OutlineSortableHandleProps) {
    const sortable = useOutlineSortableHandle();
    const {
      onKeyDown: onSortableKeyDown,
      ...listenerProps
    } = enabled ? (sortable.listeners ?? {}) : {};
    return (
      <button
        {...(enabled ? sortable.attributes : {})}
        {...listenerProps}
        {...buttonProps}
        ref={sortable.setActivatorNodeRef}
        onKeyDown={(event) => {
          onSortableKeyDown?.(event);
          onKeyDown?.(event);
        }}
      />
    );
  });
  ```

  `ComponentPropsWithoutRef`, `ReactElement`, `CSSProperties`,
  `createContext`, `useContext`를 React에서 import한다.
  `OutlineSortableHandleContext`의 default는 `null`이고
  provider value는 위 `OutlineSortableHandleValue` 세 field만 가진다.
  Export한 `useOutlineSortableHandle()`은 provider 밖이면 throw한다.
  `areOutlineSortableShellPropsEqual`은 위 primitive fields를 `Object.is`
  로 비교하고, `editor`는 element type/key와
  `OutlineNodeEditorProps`의 각 prop을 shallow `Object.is` 비교한다.
  Generic `children`/`rootProps` object를 비교 입력으로 사용하지 않는다.
  Root에 있던 selection pointer-capture handler는 editor의
  `.notes-node-main` capture handler로 이동한다. Unstable
  attributes/listeners는 작은 `OutlineSortableHandle` component만
  구독한다. `isDragging`, transform, transition, node ref는 shell에만
  남고 heavy editor props로 전달하지 않는다.

- [ ] **Step 4: heavy editor의 broad state 구독 제거**

  `OutlineNodeRow.tsx`의 heavy component를 `MemoizedOutlineNodeEditor`로 export하고 다음 stable inputs를 Pane에서 전달한다.

  ```ts
  export interface OutlineEditorFocusRequest {
    readonly requestId: number;
    readonly field: NotesHistoryFocusField;
    readonly selection?: NotesHistoryPrimarySelection;
  }

  export interface OutlineNodeEditorProps {
    readonly node: NoteNode;
    readonly attachments: readonly NoteAttachment[];
    readonly childCount: number;
    readonly todoCompleted: number | null;
    readonly todoTotal: number | null;
    readonly selected: boolean;
    readonly rangeSelected: boolean;
    readonly draft?: NotesNodeDraft;
    readonly focusRequest: OutlineEditorFocusRequest | null;
    readonly getStateSnapshot: () => NotesStateSlice;
  }
  ```

  move destination, sibling IDs, shared-session authority처럼 event 시점
  값은 `getStateSnapshot()`에서 읽는다. Pane은 최신 `NotesStateSlice`를
  ref에 기록하고 getter 함수 identity는 고정한다. editor는
  `useNotesState()`를 호출하지 않는다. Pane은
  `state.pendingFocusId === node.id`인 row에만
  `OutlineEditorFocusRequest`를 만들고 나머지 49개 row에는 `null`을
  전달한다. 기존 `directTodoProgress()`가 매 호출 새 객체를 반환하므로
  그 객체 자체를 prop으로 전달하지 않는다. Pane에서 한 번 계산한 뒤
  `completed`/`total` primitive만 분해해 전달하며 comparator는 두 숫자를
  각각 `Object.is`로 비교한다.

- [ ] **Step 5: Pane composition 변경**

  각 `<li>` 안에서 `OutlineSortableShell`이 `MemoizedOutlineNodeEditor`를 감싼다. DnD root ref/transform/transition/drag handle은 shell에만 남긴다.

- [ ] **Step 6: GREEN**

  Run:

  ```bash
  npm test -- src/features/notes/OutlineSortableShell.test.tsx src/features/notes/outlineRowMemo.test.tsx src/features/notes/NotesWorkspace.test.tsx
  npm run test:architecture
  ```

  Expected: 세 Enter 시나리오 모두 unchanged heavy editor 49개 commit 0,
  기존 shell 각각 1 이하, 새 shell/editor mount 1, production inventory와
  line budget PASS.

- [ ] **Step 7: 커밋**

  ```bash
  git add src/features/notes/OutlineSortableShell.tsx src/features/notes/OutlineSortableShell.test.tsx src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/outlineRowMemo.test.tsx scripts/checkNotesWorkspaceBudgets.mjs
  git commit -m "perf(notes): isolate sortable row shells"
  ```

---

### Task 9: target-only focus request와 마지막 순간 epoch 재검사

**Files:**

- Modify: `src/features/notes/notesWorkspaceTypes.ts`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts`
- Modify: `src/features/notes/notesWorkspaceReducer.ts`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPageHeader.tsx`
- Modify: `src/features/notes/outlineRowMemo.test.tsx`
- Modify: `src/features/notes/NotesPageHeader.test.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src/features/notes/useNotesWorkspace.navigation.test.tsx`
- Modify: `src/features/notes/useNotesWorkspace.operations.test.tsx`
- Modify: `src/features/notes/useNotesWorkspace.selectionAndProjection.test.tsx`
- Modify: `src/features/notes/useNotesWorkspace.sharedSession.test.tsx`

**Interfaces:**

- Consumes: same-publication `KeyboardInsertionDisposition`, Pane-local
  `OutlineInteractionEpoch`, target editor refs, and existing pending-focus
  state.
- Produces: `NotesPendingFocusRequest`, `acknowledgeFocus()`,
  `dismissFocus()`, and `focusNotesRequestTarget()`.

- [ ] **Step 1: focus request ordering 실패 테스트 작성**

  다음을 고정한다.

  - target editor만 non-null request prop을 받음
  - accepted node DOM commit 뒤 focus
  - exact requestId는 DOM focus 성공 뒤 한 번만 acknowledgement
  - key/input/composition/pointer/focus/pane-switch가 intervening하면 authority는 수용하지만 focus하지 않음
  - `focus()` 직전과 acknowledgement 직전 epoch가 바뀌면 중단
  - focus 직전/직후 stale epoch는 exact request를 epoch와 무관하게
    dismiss해 pending focus가 0이 되고, 다음 request가 정상 처리됨
  - 닫힌 note field 요청은 field-open commit까지 request를 유지한 뒤
    focus/ack 1회, unsupported target만 dismiss
  - Outline row와 page header의 모든 acknowledgement caller가 exact object
    contract를 사용
  - typed failure만 current epoch에서 source caret를 복원
  - unmount/Vault replacement/recovery는 stale focus를 폐기

- [ ] **Step 2: RED 확인**

  Run:

  ```bash
  npm test -- src/features/notes/outlineRowMemo.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx
  ```

  Expected: 일반 pending focus에 exact requestId/epoch가 없어 FAIL.

- [ ] **Step 3: 모든 pending focus를 request 객체로 통합**

  ```ts
  export interface NotesPendingFocusRequest {
    readonly requestId: number;
    readonly nodeId: NoteId;
    readonly field: NotesHistoryFocusField;
    readonly selection?: NotesHistoryPrimarySelection;
    readonly insertionIntentToken?: number;
    readonly interactionEpochAtDispatch?: number;
  }
  ```

  Runtime이 monotonic request ID를 발급한다. `NotesStateSlice`는 global
  request를 제공하되 Pane이 node ID를 비교해 target editor 한 곳에만
  전달한다. Task 8의 임시 view-only `OutlineEditorFocusRequest`는
  삭제하고 이 authoritative request 타입으로 교체한다.

- [ ] **Step 4: acknowledgement 계약 강화**

  ```ts
  acknowledgeFocus(input: {
    readonly nodeId: NoteId;
    readonly requestId: number;
    readonly interactionEpoch?: number;
  }): Promise<boolean>;

  dismissFocus(input: {
    readonly nodeId: NoteId;
    readonly requestId: number;
    readonly reason:
      | "staleInteraction"
      | "targetUnavailable"
      | "paneDisposed";
  }): Promise<boolean>;
  ```

  request ID, node, pending field, insertion token, current epoch가 모두
  맞을 때만 reducer pending focus를 지우고 true를 반환한다.
  `dismissFocus`는 epoch를 조건으로 삼지 않고 exact node/request ID가
  아직 pending일 때만 지운다. 따라서 오래된 effect가 더 최신 request를
  지울 수 없다.

- [ ] **Step 5: Pane capture events와 focus effect 연결**

  Content capture에 `beforeinput`, `input`, `compositionstart`,
  `pointerdown`, `keydown`을 연결한다. Pane의 selection action entry
  points는 state 변경 전에 `advance("selection-command")`, user-driven
  keyboard/navigation focus commands는 focus 발행 전에
  `advance("focus-command")`를 호출한다. Pane ID, owning session generation,
  Vault 또는 library pane가 바뀌는 effect는
  `advance("pane-switch")` 후 stale insertion/focus request를 cancel한다.
  Cleanup은 `interactionEpoch.dispose()`를 호출한다. Command-owned target
  focus는 `runCommandFocus` 안에서 실행하고 focus capture가
  `commandFocusInProgress()`일 때 epoch를 올리지 않는다.

  닫힌 note field는 한 render에서 열고 같은 render의 null ref를 failure로
  취급하지 않는다.

  ```ts
  export type NotesFocusAttempt =
    | { readonly kind: "focused" }
    | { readonly kind: "waitingForFieldCommit" }
    | { readonly kind: "unavailable" };
  ```

  `focusNotesRequestTarget`은 먼저 `ensureFieldOpen(request.field)`을
  호출한다. 이 함수가 local state를 열었으면
  `waitingForFieldCommit`을 반환해 exact request를 pending으로 유지한다.
  다음 editor commit에서 동일 request effect가 다시 실행되고 그때 DOM
  ref에 focus한다. Focus effect dependency에는 request ID와 field-open
  boolean을 모두 넣어 이 retry가 보장된다. Field가 열린 상태인데도 해당
  node kind가 field를 지원하지 않을 때만 `unavailable`이다.

  Target effect 순서는 다음으로 고정한다.

  ```ts
  const expectedEpoch = request.interactionEpochAtDispatch;
  if (
    expectedEpoch !== undefined &&
    !interactionEpoch.isCurrent(expectedEpoch)
  ) {
    void actions.dismissFocus({
      nodeId,
      requestId: request.requestId,
      reason: "staleInteraction"
    });
    return;
  }
  const focusAttempt = interactionEpoch.runCommandFocus(() =>
    focusNotesRequestTarget({
      request,
      node,
      ensureFieldOpen,
      title: titleRef.current,
      note: noteRef.current,
      image: imageRef.current,
      imageEditor: imageEditorRef.current
    })
  );
  if (focusAttempt.kind === "waitingForFieldCommit") {
    return;
  }
  if (focusAttempt.kind === "unavailable") {
    void actions.dismissFocus({
      nodeId,
      requestId: request.requestId,
      reason: "targetUnavailable"
    });
    return;
  }
  if (expectedEpoch !== undefined && !interactionEpoch.isCurrent(expectedEpoch)) {
    void actions.dismissFocus({
      nodeId,
      requestId: request.requestId,
      reason: "staleInteraction"
    });
    return;
  }
  await actions.acknowledgeFocus({
    nodeId,
    requestId: request.requestId,
    ...(expectedEpoch === undefined ? {} : { interactionEpoch: expectedEpoch })
  });
  ```

  `focusNotesRequestTarget`은 requested field를 연 뒤, image node의 logical
  selection은 `ImageAtomEditorHandle.focus(selection)`으로, textarea
  selection은 `restoreTextareaPrimarySelection`으로 복원하고 위
  `NotesFocusAttempt`를 반환한다. Selection이 없는 ordinary request도 해당
  field의 기존 caret 정책을 유지한다.

  Pane switch/unmount cleanup도 exact pending request가 있으면
  `dismissFocus(..., reason: "paneDisposed")`를 호출한다. 이 cleanup과
  stale path는 acknowledgement counter를 올리지 않으며, reducer test는
  pending=0과 이후 더 큰 requestId의 정상 focus/ack를 함께 검증한다.
  `NotesPageHeader`의 page-level focus effect와 direct workspace tests도
  object argument로 migration한다. GREEN 전에 다음 search가 declaration,
  implementation 외 positional call을 반환하지 않는지 확인한다.

  ```bash
  rg -n 'acknowledgeFocus\\([^\\{]' src/features/notes
  ```

- [ ] **Step 6: GREEN**

  Run:

  ```bash
  npm test -- src/features/notes/outlineInteractionEpoch.test.ts src/features/notes/outlineRowMemo.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/useNotesWorkspace.navigation.test.tsx src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.selectionAndProjection.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx
  ```

  Expected: PASS.

- [ ] **Step 7: 커밋**

  ```bash
  git add src/features/notes/notesWorkspaceTypes.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/notesWorkspaceReducer.ts src/features/notes/NotesOutlinePane.tsx src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesPageHeader.tsx src/features/notes/outlineRowMemo.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/useNotesWorkspace.navigation.test.tsx src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.selectionAndProjection.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx
  git commit -m "fix(notes): focus only the current enter target"
  ```

---

### Task 10: Enter 전 구간 계측과 재현 가능한 측정 도구

**Files:**

- Modify: `package.json`
- Delete: `src/features/notes/notesSplitLatencyProbe.ts`
- Delete: `src/features/notes/notesSplitLatencyProbe.test.ts`
- Create: `src/features/notes/notesEnterCriticalPathProbe.ts`
- Create: `src/features/notes/notesEnterCriticalPathProbe.test.ts`
- Create: `src/features/notes/notesEnterCriticalPath.test.tsx`
- Create: `scripts/generateNotesEnterFixture.mjs`
- Create: `scripts/generateNotesEnterFixture.test.ts`
- Create: `scripts/summarizeNotesEnterProbe.mjs`
- Create: `scripts/summarizeNotesEnterProbe.test.ts`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/notesCommands.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Modify: `src/features/notes/useOutlineLayoutMotion.ts`
- Modify: `scripts/checkNotesWorkspaceBudgets.mjs`

**Interfaces:**

- Consumes: intent-token phase marks, motion/focus/baseline counters, the
  existing canonical Markdown import format, and an instrumentation-enabled
  desktop build.
- Produces: `NotesEnterCriticalPathProbe`,
  `window.__YONALIST_NOTES_ENTER_PROBE__`, a deterministic 5,000/50 fixture
  manifest, raw JSON export, and a strict p50/p95 summary command.

- [ ] **Step 1: generic Enter probe 실패 테스트 작성**

  ```ts
  export type NotesEnterScenario =
    | "clean-split"
    | "dirty-split"
    | "dirty-first-child";

  export type NotesEnterSampleKind = "latency" | "backlog";

  export type NotesEnterPhase =
    | "keydown"
    | "draft-barrier-start"
    | "draft-barrier-end"
    | "ipc-start"
    | "ipc-end"
    | "coordinator-accept"
    | "target-dom-commit"
    | "focus"
    | "next-paint";

  export interface NotesEnterProbeBridge {
    reset(): void;
    beginBatch(input: {
      readonly batchId: string;
      readonly sampleKind: NotesEnterSampleKind;
    }): void;
    prepareNextRun(): NotesEnterRunFixtureState;
    snapshot(): NotesEnterProbeSnapshot;
    exportJson(): string;
  }

  export interface NotesEnterRunFixtureState {
    readonly activeTextNodeCount: number;
    readonly visibleRowCount: number;
    readonly targetNodeId: NoteId;
    readonly targetTitle: string;
    readonly targetChildCount: number;
  }
  ```

  Probe snapshot은 최대 512개 run과 pending
  insertion/focus/animation/baseline counts, total/visible node counts,
  build SHA, user agent, hardware concurrency를 반환한다. 일반 production
  build에서는 no-op이고 `window` bridge도 존재하지 않는다.

  Test는 `VITE_NOTES_ENTER_PROBE !== "1"`일 때 mark 저장과 bridge 0,
  `"1"`일 때 reset/beginBatch/prepareNextRun/snapshot/export, 512-run bounded ring,
  run별 batch ID/sample kind와 측정 구간 밖에서 arm한
  `runStartFixtureState`, terminal cleanup을 단정한다.
  `prepareNextRun()`은 current workspace/visible rows를 읽어 fixture state를
  계산하고 다음 run slot 하나에 저장한다. Keydown path는 그 immutable
  slot을 O(1) consume할 뿐 full Record/Map/array를 iterate하지 않는다.
  Test는 keydown→focus 동안 `Object.keys`, `Object.values`, Map iteration과
  fixture recount가 0인지 단정한다.

- [ ] **Step 2: 결정적 50-row 통합 테스트 작성**

  세 시나리오마다 다음을 단정한다.

  - Enter critical window의 application-owned rect reads 0
  - Enter-started animations 0
  - unchanged heavy editor 49개 commits 0
  - 기존 shell commits 각각 1 이하
  - target shell/editor mount 1
  - focus와 caret가 expected node에 위치
  - acknowledgement는 focus 뒤 exact requestId로 한 번
  - non-repeat keydown/keyup 한 쌍을 보낸 뒤 authoritative target
    focus/acknowledgement를 기다리고 그 target에 다음 쌍을 보내는 순차
    20회 protocol 후
    insertion/focus/animation pending 0, baseline task 1 이하
  - 650ms quiet 뒤 baseline task 0

- [ ] **Step 3: RED 확인**

  Run:

  ```bash
  npm test -- src/features/notes/notesEnterCriticalPathProbe.test.ts src/features/notes/notesEnterCriticalPath.test.tsx
  ```

  Expected: generic marks/counters가 완성되기 전 FAIL.

- [ ] **Step 4: 기존 split probe를 generic probe와 명시적 측정 bridge로 교체**

  동일 renderer `performance.now()` clock만 사용한다. keydown, barrier, IPC, coordinator, DOM commit, focus, next paint에서 intent token별 mark를 기록하고 terminal cleanup에서 pending counter를 감소시킨다.

  다음 build-time gate만 probe를 활성화한다.

  ```ts
  const NOTES_ENTER_PROBE_ENABLED =
    import.meta.env.VITE_NOTES_ENTER_PROBE === "1";

  declare global {
    interface Window {
      __YONALIST_NOTES_ENTER_PROBE__?: NotesEnterProbeBridge;
    }
  }
  ```

  `VITE_NOTES_ENTER_BUILD_SHA`를 raw metadata에 기록한다. Bridge는
  `reset()`, run에 measurement metadata만 붙이는 `beginBatch()`, 측정
  바깥에서 read-only fixture state를 arm하는 `prepareNextRun()`, immutable
  `snapshot()`, JSON string을 반환하는 `exportJson()`만 제공하고 Notes
  mutation/IPC 실행 기능은 갖지 않는다.

- [ ] **Step 5: 재현 가능한 5,000/50 fixture generator와 summary tool 작성**

  `generateNotesEnterFixture.mjs --out <empty-directory>`는 canonical Notes
  Markdown 네 파일과 manifest를 만든다.

  ```text
  base-visible-50.md       root 1 + direct children 49
  hidden-a-1650.md         nodes 1,650
  hidden-b-1650.md         nodes 1,650
  hidden-c-1650.md         nodes 1,650
  manifest.json            totalNodes 5,000, visibleRows 50
  ```

  각 문서는 deterministic UUID, canonical frontmatter와
  `yonalist-node-id` marker를 사용하고 import 한도 2,000 미만이다.
  Generator는 output directory가 없거나 비어 있을 때만 쓰고 기존
  파일을 덮어쓰지 않는다. Test는 네 문서를 parser fixture 규칙으로
  세어 5,000개인지, 각 subtree가 2,000 미만인지, ID가 중복되지 않는지
  검증한다.

  격리된 빈 Vault에서 `base-visible-50.md`를 root로 import하고, 세 hidden
  문서를 base의 `Storage A/B/C` child 아래에 각각 import한 뒤 그 세
  parent를 collapse한다. Probe snapshot의 `totalNodeCount === 5_000`과
  `visibleRowCount === 50`이 아니면 측정을 시작하지 않는다.

  `summarizeNotesEnterProbe.mjs <raw.json>`은 schema/build SHA/count를
  검증하고 `sampleKind: "latency"`만 골라 scenario별 정확히 50개
  measured run에서 phase duration p50/p95와 pending maxima를 계산한다.
  모든 latency run의 `runStartFixtureState`는 active text 5,000개,
  visible 50개와 scenario별 target title/child precondition에 일치해야
  한다.
  별도로 유일한 `"backlog"` batch가 정확히 20개 run을 가지며 마지막
  deadline 뒤 insertion/focus/animation pending 0, baseline pending 1
  이하인지 검증한다. Backlog는 clean-split만 사용하고 첫 run은
  5,000/50, 이후 index `i`의 run start는 `5_000 + i`/`50 + i`여야 한다.
  빠진 mark, 중복 batch ID, 다른 clock, non-finite 값, fixture/run 수
  불일치는 non-zero exit다. `package.json`에 다음 scripts를 추가한다.

  ```json
  {
    "notes:enter-fixture": "node scripts/generateNotesEnterFixture.mjs",
    "notes:enter-summary": "node scripts/summarizeNotesEnterProbe.mjs"
  }
  ```

- [ ] **Step 6: GREEN 및 owning frontend/tool suites**

  Run:

  ```bash
  npm test -- src/features/notes/notesEnterCriticalPathProbe.test.ts src/features/notes/notesEnterCriticalPath.test.tsx scripts/generateNotesEnterFixture.test.ts scripts/summarizeNotesEnterProbe.test.ts
  npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/useOutlineLayoutMotion.test.tsx src/features/notes/outlineRowMemo.test.tsx
  ```

  Expected: PASS.

- [ ] **Step 7: 전체 frontend/tool gate**

  Run:

  ```bash
  npm test
  npm run lint
  npm run build
  npm run test:architecture
  git diff --check
  ```

  Expected: 모두 PASS. Rust source/gate는 변경하거나 실행하지 않는다.

- [ ] **Step 8: 측정 소스 커밋**

  ```bash
  git add package.json src/features/notes/notesEnterCriticalPathProbe.ts src/features/notes/notesEnterCriticalPathProbe.test.ts src/features/notes/notesEnterCriticalPath.test.tsx src/features/notes/OutlineNodeRow.tsx src/features/notes/notesCommands.ts src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/useOutlineLayoutMotion.ts scripts/generateNotesEnterFixture.mjs scripts/generateNotesEnterFixture.test.ts scripts/summarizeNotesEnterProbe.mjs scripts/summarizeNotesEnterProbe.test.ts scripts/checkNotesWorkspaceBudgets.mjs
  git rm src/features/notes/notesSplitLatencyProbe.ts src/features/notes/notesSplitLatencyProbe.test.ts
  git commit -m "test(notes): instrument enter critical path"
  ```

---

### Task 11: Clean-HEAD desktop 측정과 Phase A 증거 확정

**Files:**

- Create: `docs/superpowers/reports/data/2026-07-23-notes-enter-critical-path-phase-a.json`
- Create: `docs/superpowers/reports/2026-07-23-notes-enter-critical-path-phase-a.md`

**Interfaces:**

- Consumes: Task 10의 clean committed probe/fixture/summary commands and the
  exact `VITE_NOTES_ENTER_BUILD_SHA`.
- Produces: immutable raw measurement JSON and the Phase A acceptance/manual
  verification report tied to the measured source SHA.

- [ ] **Step 1: clean measured source와 instrumented build 고정**

  다음 exact protocol을 사용한다.

  ```bash
  test -z "$(git status --porcelain)"
  NOTES_ENTER_MEASURED_SHA="$(git rev-parse HEAD)"
  NOTES_ENTER_FIXTURE_DIR="$(mktemp -d /tmp/yonalist-enter-fixture.XXXXXX)"
  npm run notes:enter-fixture -- --out "$NOTES_ENTER_FIXTURE_DIR"
  VITE_NOTES_ENTER_PROBE=1 \
  VITE_NOTES_ENTER_BUILD_SHA="$NOTES_ENTER_MEASURED_SHA" \
  npm run tauri:build
  ```

  `NOTES_ENTER_FIXTURE_DIR`는 이번 run의 generator 전용 empty directory다.
  Build 직전 status가 비어 있지 않으면 측정을 중단한다. Raw export의
  `buildSha`가 `NOTES_ENTER_MEASURED_SHA`와 exact-equal이어야 한다.
  Built desktop을 완전히 종료/재시작하고 위
  protocol로 만든 격리 Vault만 연다. DevTools에서 bridge 존재와 fixture
  count를 확인한다.

- [ ] **Step 2: warm-up, latency, backlog batch 수집**

  각 warm-up과 latency sample 뒤 다음 reset protocol을 완료하고 다음
  keydown 전에 `activeTextNodeCount === 5_000`,
  `visibleRowCount === 50`, target title/child/collapse/caret가 manifest
  baseline과 같은지 확인한다.

  - clean split: structural Undo 한 번
  - dirty split/dirty first-child: structural Undo 뒤 text Undo, 총 두 번
  - 각 Undo의 authoritative projection/focus acknowledgement를 기다림
  - first-child parent의 local expansion을 원래 collapsed 상태로 복원
  - scenario target과 caret/scroll을 baseline 위치로 복원
  - 복원 검증 뒤, Enter keydown 전에 bridge `prepareNextRun()`을 호출해
    반환된 5,000/50/precondition state를 arm

  Warm-up도 매 회 같은 reset을 수행한다. 각 시나리오를 10회씩 warm-up한
  뒤 bridge를 정확히 한 번 reset한다. 각 scenario 앞에서 고유 batch
  ID와 `sampleKind: "latency"`로 `beginBatch()`하고 50회씩 측정한다.
  Run-start metadata가 하나라도 5,000/50/precondition과 다르면 그 run을
  버리는 대신 batch 전체를 무효화하고 fixture를 다시 만든다.

  마지막 latency sample도 위 protocol로 pristine 5,000/50 상태로 되돌린
  뒤 `beginBatch({ batchId: "backlog-20", sampleKind: "backlog" })`를
  호출하고 clean-split 20-key 순차 protocol을 한 번 실행한다. Backlog
  batch 안에서는 Undo하지 않지만 각 pair 전에 `prepareNextRun()`을
  호출해 expected incremented counts를 arm한다. 그 후 한 번만
  `exportJson()`하고 결과를
  `docs/superpowers/reports/data/2026-07-23-notes-enter-critical-path-phase-a.json`
  에 저장한다.

- [ ] **Step 3: raw schema와 16ms gate 검증**

  ```bash
  npm run notes:enter-summary -- docs/superpowers/reports/data/2026-07-23-notes-enter-critical-path-phase-a.json
  ```

  보고서에 p50/p95를 다음 phase별로 기록한다.

  ```text
  keydown
  draft barrier start/end
  IPC start/end
  coordinator acceptance
  target DOM commit
  focus
  next paint
  ```

  Acceptance: 같은 renderer clock에서 `p95(focus - ipcEnd) <= 16 ms`. 전체 keydown-to-focus p95는 Phase B 비교 기준으로만 기록한다.

  20-key backlog 측정도 keydown을 연속 발사하지 않는다. 매 iteration은
  keydown/keyup 한 쌍을 보낸 뒤 그 결과인 authoritative target의 focus와
  exact request acknowledgement를 확인하고, 그 target에서 다음 pair를
  시작한다.

- [ ] **Step 4: manual proof**

  contextual first-child, leaf sibling, middle-title split, dirty Enter, rapid Enter, exact caret, Undo/Redo, drag/collapse/expand motion, reduced motion, VoiceOver focus/announcement를 확인해 보고서에 결과를 남긴다.

- [ ] **Step 5: evidence commit 전 전체 Phase A gate**

  Run:

  ```bash
  npm test
  npm run lint
  npm run build
  npm run test:architecture
  git diff --check
  ```

  Expected: 모두 PASS. Rust gate는 실행하지 않는다. Report에는 각 command
  결과와 measured source SHA를 기록한다.

- [ ] **Step 6: 측정 증거만 별도 커밋**

  ```bash
  git add docs/superpowers/reports/data/2026-07-23-notes-enter-critical-path-phase-a.json docs/superpowers/reports/2026-07-23-notes-enter-critical-path-phase-a.md
  git commit -m "docs(notes): record enter critical path evidence"
  ```

---

## Phase A Completion Evidence

- `p95(focusMark - ipcEndMark) <= 16 ms`인 fresh desktop raw summary와 환경 정보
- 세 시나리오 각각 10 warm-ups + 50 measured runs
- 20개 discrete Enter의 backlog-free proof
- Enter FLIP reads 0, animations 0, unchanged heavy editor commits 0
- exact request acknowledgement와 stale interaction focus suppression
- outcomeUnknown zero replay와 authorityUnknown write lock proof
- contextual behavior, Undo/Redo, retained non-overlap motion, reduced motion, VoiceOver 수동 확인
- `npm test`, lint, build, architecture, diff check 결과
