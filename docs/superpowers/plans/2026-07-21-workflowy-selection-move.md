# Workflowy Selection Movement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 부모의 보이는 하위 트리를 하나의 선택 단위로 취급하고, Workflowy 플랫폼별 단축키로 단일 커서 행 또는 선택된 여러 블릿을 이동하며, 노트 전체화면 아이콘을 툴바 중심선에 맞춘다.

**Architecture:** 기존 앵커/헤드 선택 상태는 유지하고 `selectionSubtreeIds`라는 순수 투영 함수에서만 보이는 자손 폐포를 계산한다. 기존 선택 명령 라우터와 구조 루트 정규화는 그대로 재사용하고, 단일 커서 행만 기존 `moveNode` 해석으로 처리한다. 전체화면 위치는 활성 기능 데이터 속성과 CSS만 사용한다.

**Tech Stack:** React 19, TypeScript 6, Vitest 4, Testing Library, Tauri 2, 기존 Yonalist Notes command router

## Global Constraints

- 새 런타임 의존성을 추가하지 않는다.
- Rust, IPC payload, SQLite, 파일 형식은 변경하지 않는다.
- Windows/Linux 이동 키는 `Alt+Shift+↑/↓`, macOS 이동 키는 `Ctrl+Shift+↑/↓`다.
- 부모가 선택되면 보이는 모든 자손을 선택 표시·집계·드래그 원본에 포함한다.
- 이동 명령은 선택 크기와 무관하게 저장 호출 한 번만 수행한다.
- 선택 계산은 정확히 `O(V)`, 보조 `Set` 항목 상한은 `2V`다.
- 각 동작은 실패 테스트 확인 후 최소 구현한다.

---

### Task 1: 보이는 하위 트리 선택 투영

**Files:**
- Modify: `src/features/notes/notesWorkspaceReducer.ts:132`
- Modify: `src/features/notes/notesWorkspaceReducer.test.ts:780`
- Modify: `src/features/notes/notesSelectionActions.ts:467`
- Modify: `src/features/notes/notesSelectionActions.test.ts:80`

**Interfaces:**
- Consumes: `NotesSelection`, `NormalizedNotesWorkspace`, 기존 `selectionRangeIds`
- Produces: `selectionSubtreeIds(selection, visibleNodeIds, workspace): NoteId[]`

- [x] **Step 1: 선택 폐포 실패 테스트 작성**

`notesWorkspaceReducer.test.ts`에 부모 단독 선택, 중첩 범위, 접힌 부모, 보이는 순서 보존을 추가한다.

```ts
expect(
  selectionSubtreeIds(
    { anchorId: "parent", headId: "parent" },
    ["parent", "child", "grandchild", "sibling"],
    state
  )
).toEqual(["parent", "child", "grandchild"]);

expect(
  selectionSubtreeIds(
    { anchorId: "collapsed", headId: "collapsed" },
    ["collapsed", "sibling"],
    collapsedState
  )
).toEqual(["collapsed"]);
```

- [x] **Step 2: 실패 확인**

Run: `npm test -- src/features/notes/notesWorkspaceReducer.test.ts`

Expected: FAIL — `selectionSubtreeIds`가 export되지 않았다는 오류.

- [x] **Step 3: 최소 선형 투영 구현**

`notesWorkspaceReducer.ts`에서 기존 범위 루트를 얻고 outline preorder를 한 번 훑으며 부모 선택을 자손에게 전파한다.

```ts
export function selectionSubtreeIds(
  selection: NotesSelection | null,
  visibleNodeIds: readonly NoteId[],
  workspace: NormalizedNotesWorkspace
): NoteId[] {
  const roots = selectionRangeIds(selection, visibleNodeIds);
  if (roots.length === 0) return [];
  const directlySelected = new Set(roots);
  const selected = new Set<NoteId>();
  const result: NoteId[] = [];
  for (const nodeId of visibleNodeIds) {
    const parentId = workspace.nodesById[nodeId]?.parentId ?? null;
    if (directlySelected.has(nodeId) || (parentId !== null && selected.has(parentId))) {
      selected.add(nodeId);
      result.push(nodeId);
    }
  }
  return result;
}
```

- [x] **Step 4: 선택 스냅샷에 같은 투영 사용**

`deriveNotesSelectionActionSnapshot`의 첫 선택 계산을 다음으로 바꾼다.

```ts
const selectedNodeIds = selectionSubtreeIds(
  input.selection,
  input.visibleNodeIds,
  input.workspace
);
```

부모와 자손이 모두 선택돼도 `structuralRootIds`가 부모 하나인지 테스트한다.

```ts
expect(result?.selectedNodeIds).toEqual(["parent", "child", "grandchild"]);
expect(result?.structuralRootIds).toEqual(["parent"]);
```

- [x] **Step 5: 소유 테스트 통과 확인**

Run: `npm test -- src/features/notes/notesWorkspaceReducer.test.ts src/features/notes/notesSelectionActions.test.ts`

Expected: PASS.

- [x] **Step 6: 커밋**

```bash
git add src/features/notes/notesWorkspaceReducer.ts src/features/notes/notesWorkspaceReducer.test.ts src/features/notes/notesSelectionActions.ts src/features/notes/notesSelectionActions.test.ts
git commit -m "feat(notes): include visible descendants in selection"
```

### Task 2: 행 표시·마우스·드래그·명령 준비를 같은 선택으로 통일

**Files:**
- Modify: `src/features/notes/NotesOutlinePane.tsx:1208`
- Modify: `src/features/notes/NotesWorkspace.test.tsx:4159`

**Interfaces:**
- Consumes: Task 1의 `selectionSubtreeIds`
- Produces: 모든 선택 UI/명령 소비자가 공유하는 `materializedSelectionIds`

- [x] **Step 1: 키보드와 마우스 계층 선택 통합 실패 테스트 작성**

부모-자식-손자-다음 형제 fixture에서 다음을 검증한다.

```ts
fireEvent.keyDown(parentTitle, { key: "ArrowDown", shiftKey: true });
expect(selectedOutlineIds()).toEqual(["parent", "child", "grandchild"]);

fireEvent.pointerDown(parentTitle, { button: 0, pointerId: 31 });
fireEvent.pointerMove(childTitle, { buttons: 1, pointerId: 31 });
expect(selectedOutlineIds()).toEqual(["parent", "child", "grandchild"]);
```

선택 이동 뒤 배치 payload가 자손을 중복 전달하지 않는지도 검증한다.

```ts
expect(notesStoreMock.applyBatch).toHaveBeenCalledWith("/vault", {
  op: "move",
  nodeIds: ["parent"],
  parentId: null,
  afterId: "sibling",
  beforeId: null
}, historyContextMatcher());
```

- [x] **Step 2: 통합 테스트 실패 확인**

Run: `npm test -- src/features/notes/NotesWorkspace.test.tsx -t "includes visible descendants"`

Expected: FAIL — 실제 선택 ID가 부모와 첫 자식까지만 포함됨.

- [x] **Step 3: Pane의 선택 물질화 교체**

`NotesOutlinePane.tsx`에서 UI와 권한 검증에 쓰는 선택 계산을 모두 같은 함수로 통일한다.

```ts
const materializedSelectionIds = useMemo(
  () => selectionSubtreeIds(selection ?? null, bodyVisibleIds, state),
  [bodyVisibleIds, selection, state]
);
```

keydown/clipboard/drag 중 live selection 검증에서도 `selectionRangeIds` 대신 현재 workspace와 함께 `selectionSubtreeIds`를 사용한다. 일반 caret 탐색용 `bodyVisibleIds`와 reducer 내부 토글 로직은 바꾸지 않는다.

- [x] **Step 4: 통합 테스트 통과 확인**

Run: `npm test -- src/features/notes/NotesWorkspace.test.tsx -t "includes visible descendants"`

Expected: PASS.

- [x] **Step 5: 선택 소유 테스트 회귀 확인**

Run: `npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/outlineSelectionDragSession.test.ts src/features/notes/useNotesSelectionCommandRouter.test.tsx`

Expected: PASS.

- [x] **Step 6: 커밋**

```bash
git add src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "fix(notes): keep selected bullet subtrees together"
```

### Task 3: Workflowy 이동 단축키와 단일 커서 행 이동

**Files:**
- Modify: `src/features/notes/outlineKeyboard.ts:190`
- Modify: `src/features/notes/outlineKeyboard.test.ts:1190`
- Modify: `src/features/notes/NotesWorkspace.test.tsx:5200`

**Interfaces:**
- Consumes: `ResolveOutlineKeyInput.platform`, `authoritativeWorkspace`, 기존 `OutlineKeyResolution.move`와 `selectionAction`
- Produces: `workflowyMoveDirection(input): "up" | "down" | null`

- [x] **Step 1: 플랫폼별 키 실패 테스트 작성**

```ts
it.each([
  ["other", { altKey: true }, "moveUp"],
  ["mac", { ctrlKey: true }, "moveDown"]
] as const)("uses the Workflowy move chord on %s", (platform, modifiers, action) => {
  expect(resolveOutlineKey(batchInput({
    key: action === "moveUp" ? "ArrowUp" : "ArrowDown",
    shiftKey: true,
    platform,
    ...modifiers
  }))).toEqual({ type: "selectionAction", action });
});
```

일반 플랫폼 `Ctrl`, macOS `Cmd`, IME, `Process`, repeat가 이동하지 않거나 소비만 하는 테스트도 추가한다.

- [x] **Step 2: 실패 확인**

Run: `npm test -- src/features/notes/outlineKeyboard.test.ts`

Expected: FAIL — 현재 일반 플랫폼은 `Ctrl`, macOS는 `Cmd`를 요구함.

- [x] **Step 3: 공통 키 해석 구현**

```ts
function workflowyMoveDirection(
  input: Pick<ResolveOutlineKeyInput,
    "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "platform">
): "up" | "down" | null {
  const modifier = input.platform === "mac"
    ? input.ctrlKey && !input.altKey && !input.metaKey
    : input.altKey && !input.ctrlKey && !input.metaKey;
  if (!modifier || !input.shiftKey) return null;
  return input.key === "ArrowUp"
    ? "up"
    : input.key === "ArrowDown"
      ? "down"
      : null;
}
```

선택이 있으면 기존 semantic action을 반환한다.

```ts
if (input.selection && moveDirection) {
  return selectionShortcut(moveDirection === "up" ? "moveUp" : "moveDown");
}
```

- [x] **Step 4: 단일 커서 행 실패 테스트 작성**

완전한 All workspace에서 중간 형제를 한 칸 위/아래로 옮기는 `move` resolution과 첫/마지막 경계 소비를 검증한다.

```ts
expect(resolveOutlineKey(input({
  key: "ArrowUp",
  altKey: true,
  shiftKey: true,
  nodeId: "root-b",
  platform: "other"
}))).toEqual({
  type: "move",
  input: { id: "root-b", parentId: null, afterId: null, beforeId: "root-a" },
  focusNodeId: "root-b"
});
```

- [x] **Step 5: 단일 이동 최소 구현**

선택이 없고 `authoritativeWorkspace`가 있을 때만 형제 순서에서 목적지를 계산한다. 경계, repeat, 불완전 투영은 `consumeSelectionShortcut`으로 기본 동작을 막고 저장은 하지 않는다.

```ts
if (moveDirection) {
  if (input.repeat || !input.authoritativeWorkspace) {
    return { type: "consumeSelectionShortcut" };
  }
  const workspace = input.authoritativeWorkspace;
  const node = workspace.nodesById[input.nodeId];
  if (!node) return { type: "consumeSelectionShortcut" };
  const siblings = node.parentId === null
    ? workspace.rootIds
    : workspace.childIdsByParent[node.parentId] ?? [];
  const index = siblings.indexOf(node.id);
  if (moveDirection === "up") {
    if (index <= 0) return { type: "consumeSelectionShortcut" };
    const beforeId = index === 1 ? siblings[0] : undefined;
    return {
      type: "move",
      input: {
        id: node.id,
        parentId: node.parentId,
        afterId: beforeId ? null : (siblings[index - 2] ?? null),
        ...(beforeId ? { beforeId } : {})
      },
      focusNodeId: node.id
    };
  }
  if (index < 0 || index >= siblings.length - 1) {
    return { type: "consumeSelectionShortcut" };
  }
  return {
    type: "move",
    input: {
      id: node.id,
      parentId: node.parentId,
      afterId: siblings[index + 1]!
    },
    focusNodeId: node.id
  };
}
```

- [x] **Step 6: resolver와 UI 통합 통과 확인**

Run: `npm test -- src/features/notes/outlineKeyboard.test.ts src/features/notes/NotesWorkspace.test.tsx -t "Workflowy move"`

Expected: PASS; 한 키 입력당 `moveNode` 또는 `applyBatch`가 정확히 한 번 호출됨.

- [x] **Step 7: 커밋**

```bash
git add src/features/notes/outlineKeyboard.ts src/features/notes/outlineKeyboard.test.ts src/features/notes/NotesWorkspace.test.tsx
git commit -m "feat(notes): add Workflowy keyboard movement"
```

### Task 4: 노트 전체화면 아이콘을 툴바에 정렬

**Files:**
- Modify: `src/App.tsx:1788`
- Modify: `src/styles.css:733`
- Modify: `src/App.test.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx:9580`

**Interfaces:**
- Consumes: 기존 `activeFeatureId`, `data-position="detail-end"`
- Produces: `data-active-feature` shell 상태와 notes 전용 수직 정렬 CSS

- [x] **Step 1: App/CSS 실패 테스트 작성**

활성 Notes shell이 기능 ID를 노출하고 CSS가 pane 테두리를 포함한 13px 시작점과 48px 높이를 사용하는지 검증한다.

```ts
expect(screen.getByRole("main", { name: "Yonalist layout" }))
  .toHaveAttribute("data-active-feature", "notes");

expect(appStyles).toMatch(
  /\.app-shell\[data-active-feature="notes"\][\s\S]*\.pane-toggle-group\[data-position="detail-end"\][^{]*\{[^}]*top:\s*calc\(var\(--pane-top\) \+ var\(--content-titlebar-gap\) \+ 1px\);[^}]*height:\s*48px;/s
);
```

- [x] **Step 2: 실패 확인**

Run: `npm test -- src/App.test.tsx src/features/notes/NotesWorkspace.test.tsx -t "aligns the notes detail toggle"`

Expected: FAIL — 속성과 notes 전용 CSS 규칙이 없음.

- [x] **Step 3: 최소 App/CSS 구현**

`App.tsx`의 shell에 다음 속성을 추가한다.

```tsx
data-active-feature={activeFeatureId}
```

`styles.css`에 다음 규칙을 추가한다.

```css
.app-shell[data-active-feature="notes"]
  .pane-toggle-group[data-position="detail-end"] {
  top: calc(var(--pane-top) + var(--content-titlebar-gap) + 1px);
  height: 48px;
}
```

- [x] **Step 4: 테스트 통과 확인**

Run: `npm test -- src/App.test.tsx src/features/notes/NotesWorkspace.test.tsx -t "aligns the notes detail toggle"`

Expected: PASS.

- [x] **Step 5: 커밋**

```bash
git add src/App.tsx src/styles.css src/App.test.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "fix(notes): align detail maximize with toolbar"
```

### Task 5: 최종 회귀·성능 계약·Tauri 직접 확인

**Files:**
- Modify if needed: `docs/superpowers/specs/2026-07-21-workflowy-selection-move-design.md`
- Modify if needed: `docs/superpowers/plans/2026-07-21-workflowy-selection-move.md`

**Interfaces:**
- Consumes: Tasks 1–4의 완성 diff
- Produces: 프론트엔드 최종 게이트와 새 Tauri 프로세스의 사용자 증거

- [ ] **Step 1: 집중 회귀 실행**

Run:

```bash
npm test -- src/features/notes/notesWorkspaceReducer.test.ts src/features/notes/notesSelectionActions.test.ts src/features/notes/outlineKeyboard.test.ts src/features/notes/outlineSelectionDragSession.test.ts src/features/notes/useNotesSelectionCommandRouter.test.tsx src/features/notes/NotesWorkspace.test.tsx src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 2: 새 Tauri 앱 직접 확인**

Run: `npm run tauri:dev`

새 프로세스에서 다음을 확인한다.

1. 부모에서 `Shift+↓` 또는 마우스 행 드래그 시 보이는 자손 모두 선택 강조.
2. macOS `Ctrl+Shift+↑/↓`로 단일 커서 행과 여러 선택을 각각 한 칸 이동.
3. 부모 이동 뒤 자손 구조 보존.
4. 선택 드래그 시 자손이 함께 미리보기/원본 표시.
5. 전체화면, 완료 표시, 내보내기 아이콘의 중심선 일치.

- [ ] **Step 3: 최종 프론트엔드 게이트 한 번 실행**

Run:

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: 테스트 실패 0, lint 오류 0, build 성공, whitespace 오류 0. Rust/IPC/SQLite/native configuration을 바꾸지 않았으므로 Cargo test, rustfmt, Clippy는 실행하지 않는다.

- [ ] **Step 4: 최종 diff 검토와 커밋**

```bash
git status --short
git diff --stat main...HEAD
git log --oneline main..HEAD
```

문서 체크박스를 실제 완료 상태와 맞추고 남은 문서 수정이 있으면 다음으로 커밋한다.

```bash
git add docs/superpowers/specs/2026-07-21-workflowy-selection-move-design.md docs/superpowers/plans/2026-07-21-workflowy-selection-move.md
git commit -m "docs(notes): record Workflowy movement verification"
```
