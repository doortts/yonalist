# Notes 설명 커서 및 Shift+Enter 이동·생성 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notes 설명 편집 커서를 표시 글자의 줄에 맞추고, `Shift+Enter`로 다음 블릿으로 이동하거나 마지막 위치에서 새 블릿을 만들어 연속 입력할 수 있게 한다.

**Architecture:** `outlineKeyboard.ts`가 설명 전용 `Shift+Enter` 의도를 순수 함수로 판정하고, 페이지 헤더와 일반 행은 기존 visible-node 탐색 및 구조 생성 명령을 재사용한다. 고정 표시 이중 레이어는 유지하되 설명 필드의 투명 textarea 커서층에만 3px 수직 보정을 적용한다.

**Tech Stack:** React 19, TypeScript 6, CSS, Vitest 4, Testing Library, Vite 8, Tauri 2

## Global Constraints

- 일반 `Enter`는 설명 textarea의 기본 줄바꿈으로 유지한다.
- `Shift+Enter`는 다음에 보이는 블릿 제목으로 이동한다.
- 마지막 일반 블릿에서는 같은 부모 아래 현재 블릿 다음에 빈 텍스트 블릿을 만든다.
- 하위 블릿이 없는 서브 페이지에서는 첫 하위 블릿을 만든다.
- 구조 명령 전에 최신 설명 draft를 반영하고 기존 structural draft barrier를 통과시킨다.
- IME 조합 중이거나 키 반복 이벤트인 `Shift+Enter`는 구조 명령으로 해석하지 않는다.
- 기존 `Escape`, `ArrowUp`, `ArrowDown`, 제목 키보드 동작과 Undo/Redo 경로는 유지한다.
- 설명 글자는 14px/20px를 유지하고 커서층만 3px 아래로 보정한다.
- IPC, Rust, SQLite, filesystem, persistence schema 및 native configuration은 변경하지 않는다.

---

### Task 1: 설명 Shift+Enter 의도를 순수 키 해석기에 추가

**Files:**
- Modify: `src/features/notes/outlineKeyboard.ts:23-67`
- Test: `src/features/notes/outlineKeyboard.test.ts:92-174`

**Interfaces:**
- Consumes: `ResolveSupportingNoteKeyInput`의 키, 수정자, composition, repeat, selection 상태
- Produces: `SupportingNoteKeyResolution`의 새 값 `"nextTitleOrCreate"`; 기존 `supportingNoteFocusTarget`은 이 값을 다음 visible ID 탐색에 사용

- [ ] **Step 1: Shift+Enter 계약을 나타내는 실패 테스트를 작성한다**

`supportingNoteInput` 기본값에 `isComposing`과 `repeat`을 추가하고 다음 테스트를 `resolveSupportingNoteKey` describe 안에 넣는다.

```ts
function supportingNoteInput(
  overrides: Partial<ResolveSupportingNoteKeyInput> = {}
): ResolveSupportingNoteKeyInput {
  return {
    key: "Escape",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    repeat: false,
    selectionStart: 2,
    selectionEnd: 2,
    value: "note",
    ...overrides
  };
}

it("moves or creates from supporting-note Shift+Enter only once outside IME", () => {
  expect(
    resolveSupportingNoteKey(
      supportingNoteInput({ key: "Enter", shiftKey: true })
    )
  ).toBe("nextTitleOrCreate");
  expect(
    resolveSupportingNoteKey(
      supportingNoteInput({
        key: "Enter",
        shiftKey: true,
        isComposing: true
      })
    )
  ).toBeNull();
  expect(
    resolveSupportingNoteKey(
      supportingNoteInput({ key: "Enter", shiftKey: true, repeat: true })
    )
  ).toBeNull();
  expect(resolveSupportingNoteKey(supportingNoteInput({ key: "Enter" }))).toBeNull();
});
```

`supportingNoteFocusTarget` 테스트에는 새 의도가 다음 visible ID를 찾고 마지막에는 현재 ID를 반환하는 계약을 추가한다.

```ts
expect(
  supportingNoteFocusTarget("nextTitleOrCreate", "b", ["a", "b", "c"])
).toBe("c");
expect(
  supportingNoteFocusTarget("nextTitleOrCreate", "c", ["a", "b", "c"])
).toBe("c");
```

- [ ] **Step 2: 새 타입 필드와 resolution이 없어서 실패하는지 확인한다**

Run:

```bash
npx vitest run src/features/notes/outlineKeyboard.test.ts
```

Expected: TypeScript 또는 assertion FAIL. `isComposing`, `repeat`, `nextTitleOrCreate`가 아직 키 해석 계약에 없다.

- [ ] **Step 3: 최소 키 해석을 구현한다**

`outlineKeyboard.ts`의 설명 입력과 결과 타입을 다음처럼 확장한다.

```ts
export interface ResolveSupportingNoteKeyInput {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  repeat: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
  value: string;
}

export type SupportingNoteKeyResolution =
  | "currentTitle"
  | "nextTitle"
  | "nextTitleOrCreate";
```

`resolveSupportingNoteKey`의 기존 modifier guard 앞에 다음 분기를 추가한다. 조합·반복 `Shift+Enter`는 이어지는 modifier guard에서 `null`이 된다.

```ts
if (
  input.key === "Enter" &&
  input.shiftKey &&
  !input.altKey &&
  !input.ctrlKey &&
  !input.metaKey &&
  !input.isComposing &&
  !input.repeat
) {
  return "nextTitleOrCreate";
}
```

`supportingNoteFocusTarget`은 `currentTitle`만 현재 ID로 바로 반환하는 현재 구조를 유지한다. 따라서 새 값은 `nextTitle`과 똑같이 visible ID의 다음 항목을 찾고 마지막이면 현재 ID를 반환한다.

- [ ] **Step 4: 키 해석 소유 테스트가 통과하는지 확인한다**

Run:

```bash
npx vitest run src/features/notes/outlineKeyboard.test.ts
```

Expected: PASS, 0 failures. 기존 화살표, selection, 제목 키 테스트도 함께 통과한다.

- [ ] **Step 5: 키 계약을 커밋한다**

```bash
git add src/features/notes/outlineKeyboard.ts src/features/notes/outlineKeyboard.test.ts
git commit -m "feat(notes): resolve note shift-enter intent"
```

### Task 2: 페이지와 일반 블릿 설명을 이동·생성 명령에 연결

**Files:**
- Modify: `src/features/notes/NotesPageHeader.tsx:929-974`
- Modify: `src/features/notes/OutlineNodeRow.tsx:1632-1674`
- Test: `src/features/notes/NotesPageHeader.test.tsx:139-210,1413-1442`
- Test: `src/features/notes/NotesWorkspace.test.tsx:8284-8336`

**Interfaces:**
- Consumes: Task 1의 `"nextTitleOrCreate"`, `supportingNoteFocusTarget`, 기존 `createChild(nodeId, "first")`, `createNextTextSibling(nodeId)`
- Produces: 페이지/행 설명의 동일한 `Shift+Enter` 사용자 흐름; 생성 명령은 기존 pending title focus를 생산

- [ ] **Step 1: 페이지 설명 이동·생성 실패 테스트를 작성한다**

`workspaceValue` 옵션에 `includeChild?: boolean`을 추가하고 nodes 배열의 child/detail 부분을 조건부로 바꾼다.

```ts
includeChild?: boolean;
```

```ts
...(options.includeChild === false
  ? []
  : [
      node({
        id: "child",
        parentId: "project",
        nodeKind: options.childNodeKind ?? "text",
        title: options.childTitle ?? "First child",
        note: options.childNote ?? "",
        imageOffsetUtf16: options.childImageOffsetUtf16 ?? 0
      }),
      node({ id: "detail", parentId: "child", title: "Detail" })
    ]),
```

기존 page-note ArrowDown 테스트 옆에 다음 두 테스트를 추가한다.

```tsx
it("moves page-note Shift+Enter to the next visible title with its live value", () => {
  const workspace = renderZoomedOutline();
  const note = editTextareaByName("Supporting note: Project");
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set?.call(note, "Revised context");

  expect(
    fireEvent.keyDown(note, { key: "Enter", shiftKey: true })
  ).toBe(false);
  expect(workspace.actions.updateNodeDraft).toHaveBeenLastCalledWith(
    "project",
    { title: "Project", note: "Revised context", imageOffsetUtf16: 0 },
    "note"
  );
  expect(workspace.actions.focusNode).toHaveBeenCalledWith("child");
  expect(workspace.actions.createChild).not.toHaveBeenCalled();
});

it("creates the first child from Shift+Enter in a childless page note", () => {
  const workspace = renderZoomedOutline(
    workspaceValue({ includeChild: false })
  );
  const note = editTextareaByName("Supporting note: Project");

  expect(
    fireEvent.keyDown(note, { key: "Enter", shiftKey: true })
  ).toBe(false);
  expect(workspace.actions.createChild).toHaveBeenCalledWith(
    "project",
    "first"
  );
  expect(
    vi.mocked(workspace.actions.updateNodeDraft).mock.invocationCallOrder[0]
  ).toBeLessThan(
    vi.mocked(workspace.actions.createChild).mock.invocationCallOrder[0]
  );
});
```

- [ ] **Step 2: 일반 블릿의 이동·마지막 생성 실패 테스트를 작성한다**

`NotesWorkspace.test.tsx`의 supporting-note 키 테스트 옆에 다음을 추가한다.

```tsx
it("moves supporting-note Shift+Enter to the next visible bullet", async () => {
  renderNotesWorkspace();
  await findTitleInput("Project");
  const note = getTextareaByName("Supporting note: Project");
  fireEvent.change(note, { target: { value: "Project note revised" } });

  expect(
    fireEvent.keyDown(note, { key: "Enter", shiftKey: true })
  ).toBe(false);
  await waitFor(() => expect(queryTitleInput("Plan")).toHaveFocus());
  expect(notesStoreMock.createNode).not.toHaveBeenCalled();
});

it("creates and focuses a sibling from Shift+Enter in the last bullet note", async () => {
  configureRepository(
    initialNodes().map((current) =>
      current.id === "outside" ? { ...current, note: "Last note" } : current
    )
  );
  renderNotesWorkspace();
  const note = await findTextareaByName("Supporting note: Outside branch");
  fireEvent.change(note, { target: { value: "Last note revised" } });

  expect(
    fireEvent.keyDown(note, { key: "Enter", shiftKey: true })
  ).toBe(false);
  await waitFor(() => expect(queryTitleInput("")).toHaveFocus());
  expect(notesStoreMock.createNode).toHaveBeenCalledWith(
    "/vault",
    expect.objectContaining({
      parentId: null,
      afterId: "outside",
      title: "",
      note: ""
    }),
    historyContextMatcher()
  );
  expect(notesStoreMock.updateNode.mock.invocationCallOrder[0]).toBeLessThan(
    notesStoreMock.createNode.mock.invocationCallOrder[0]
  );
});
```

- [ ] **Step 3: 소비자가 새 입력 필드와 resolution을 처리하지 못해 실패하는지 확인한다**

Run:

```bash
npx vitest run src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesWorkspace.test.tsx -t "Shift.Enter|supporting-note"
```

Expected: FAIL. page/row handler가 `isComposing`, `repeat`을 전달하지 않고 `Shift+Enter`를 이동·생성 명령으로 연결하지 않는다.

- [ ] **Step 4: 페이지 설명 핸들러를 연결한다**

`NotesPageHeader.tsx`의 `resolveSupportingNoteKey` 입력에 다음을 추가한다.

```tsx
isComposing: event.nativeEvent.isComposing,
repeat: event.repeat,
```

resolution을 얻은 뒤 visible IDs와 focus target을 한 번 계산하고 최신 draft를 반영한다.

```tsx
event.preventDefault();
const visibleNodeIds = getVisibleNodeIds();
const focusTarget = supportingNoteFocusTarget(
  resolution,
  nodeId,
  visibleNodeIds
);
actions.updateNodeDraft(
  nodeId,
  { title: titleValue, note: event.currentTarget.value, imageOffsetUtf16 },
  "note"
);
if (resolution === "nextTitleOrCreate" && focusTarget === nodeId) {
  runCommand(() => actions.createChild(nodeId, "first"));
  return;
}
void actions.flushNodeDraft(nodeId);
void actions.focusNode(focusTarget);
```

- [ ] **Step 5: 일반 블릿 설명 핸들러를 연결한다**

`OutlineNodeRow.tsx`에도 `isComposing`과 `repeat`을 전달하고 같은 focus target 계산을 사용한다. 마지막 블릿 분기만 행 전용 구조 명령으로 둔다.

```tsx
event.preventDefault();
const visibleNodeIds = getVisibleNodeIds();
const focusTarget = supportingNoteFocusTarget(
  resolution,
  nodeId,
  visibleNodeIds
);
actions.updateNodeDraft(
  nodeId,
  { title: titleValue, note: event.currentTarget.value, imageOffsetUtf16 },
  "note"
);
if (resolution === "nextTitleOrCreate" && focusTarget === nodeId) {
  runStructuralCommand(() => actions.createNextTextSibling(nodeId));
  return;
}
void actions.flushNodeDraft(nodeId);
void actions.focusNode(focusTarget);
```

- [ ] **Step 6: 페이지와 일반 행 소유 테스트를 통과시킨다**

Run:

```bash
npx vitest run src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesWorkspace.test.tsx
```

Expected: 두 파일 모두 PASS, 0 failures. 일반 `Enter`, composition, 기존 화살표 이동, 제목 `Shift+Enter` 테스트도 유지된다.

- [ ] **Step 7: 사용자 동작 연결을 커밋한다**

```bash
git add src/features/notes/NotesPageHeader.tsx src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "feat(notes): continue bullets from note shift-enter"
```

### Task 3: 설명 필드의 기본 커서층을 글자 줄에 맞춤

**Files:**
- Modify: `src/features/notes/notes.css:848-884,1740-1746`
- Test: `src/features/notes/NotesWorkspace.test.tsx:9677-9699`

**Interfaces:**
- Consumes: `NoteTextField`의 `data-stable-presentation="true"` 직접 자식 textarea와 설명 필드 CSS 변수
- Produces: 제목은 0px, 페이지/행 설명은 3px인 `--notes-stable-caret-offset`

- [ ] **Step 1: 설명 전용 3px 커서 보정 스타일 계약을 작성한다**

`keeps supporting-note visuals stable and line-free across focus` 테스트에 다음 assertion을 추가한다.

```ts
expect(notesStyles).toMatch(
  /\.notes-text-field\[data-stable-presentation="true"\]\s*>\s*textarea\s*{[^}]*transform:\s*translateY\(var\(--notes-stable-caret-offset,\s*0\)\);/s
);
expect(notesStyles).toMatch(
  /\.notes-page-note-field\s*{[^}]*--notes-stable-caret-offset:\s*3px;/s
);
expect(notesStyles).toMatch(
  /\.notes-node-note-field\s*{[^}]*--notes-stable-caret-offset:\s*3px;/s
);
const pageTitleRule = notesStyles.match(
  /\.notes-page-title-field\s*{([^}]*)}/s
)?.[1];
expect(pageTitleRule).toBeDefined();
expect(pageTitleRule).not.toMatch(/--notes-stable-caret-offset:\s*3px/);
```

- [ ] **Step 2: 기존 `transform: none` 때문에 실패하는지 확인한다**

Run:

```bash
npx vitest run src/features/notes/NotesWorkspace.test.tsx -t "supporting-note visuals stable"
```

Expected: FAIL. 고정 표시 textarea가 offset 변수 대신 `transform: none`을 사용하고 설명 필드에 3px 값이 없다.

- [ ] **Step 3: 설명 필드에만 커서 offset을 적용한다**

`notes.css`의 고정 표시 규칙을 다음처럼 바꾼다.

```css
.notes-text-field[data-stable-presentation="true"] > textarea {
  transform: translateY(var(--notes-stable-caret-offset, 0));
}
```

페이지와 행 설명 필드에 동일한 변수를 추가한다.

```css
.notes-page-note-field {
  font-size: 14px;
  line-height: 20px;
  --notes-stable-caret-color: var(--text-3);
  --notes-stable-caret-offset: 3px;
}
```

```css
.notes-node-note-field {
  width: calc(100% - var(--notes-indent) - var(--notes-content-offset));
  margin: 0 0 8px calc(var(--notes-indent) + var(--notes-content-offset));
  font-size: 14px;
  line-height: 20px;
  --notes-stable-caret-color: var(--text-3);
  --notes-stable-caret-offset: 3px;
}
```

- [ ] **Step 4: 전체 NotesWorkspace 소유 테스트를 통과시킨다**

Run:

```bash
npx vitest run src/features/notes/NotesWorkspace.test.tsx
```

Expected: PASS, 0 failures. 제목 정렬, 설명 typography, focus line 제거 및 margin 계약도 함께 유지된다.

- [ ] **Step 5: 커서 보정을 커밋한다**

```bash
git add src/features/notes/NotesWorkspace.test.tsx src/features/notes/notes.css
git commit -m "fix(notes): align supporting note carets"
```

### Task 4: 새 앱 사용자 경로와 최종 프런트엔드 게이트 검증

**Files:**
- Verify: `src/features/notes/outlineKeyboard.ts`
- Verify: `src/features/notes/NotesPageHeader.tsx`
- Verify: `src/features/notes/OutlineNodeRow.tsx`
- Verify: `src/features/notes/notes.css`
- Verify: 해당 테스트 파일과 최종 diff

**Interfaces:**
- Consumes: Task 1~3의 동결된 구현 커밋
- Produces: 새 Tauri 프로세스의 사용자 화면 증거와 프런트엔드 전체 게이트 결과

- [ ] **Step 1: 구현 관련 소유 테스트를 한 번 묶어 실행한다**

Run:

```bash
npx vitest run src/features/notes/outlineKeyboard.test.ts src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesWorkspace.test.tsx
```

Expected: 세 파일 모두 PASS, 0 failures.

- [ ] **Step 2: 공유 Rust 캐시와 별도 앱 식별자·포트로 새 Tauri 앱을 실행한다**

Run:

```bash
CARGO_TARGET_DIR=/Users/doortts/repos/yonalist/src-tauri/target npm run tauri:dev -- --config '{"productName":"Yonalist Codex Note Flow","identifier":"com.doortts.yonalist.codex-note-flow","build":{"beforeDevCommand":"npm run dev -- --port 1424","devUrl":"http://127.0.0.1:1424"}}'
```

Expected: 기존 사용자 Yonalist 프로세스와 별개의 새 프로세스가 port 1424의 현재 bundle을 표시한다.

- [ ] **Step 3: 승인된 사용자 경로를 직접 확인한다**

새 앱에서 다음을 순서대로 확인한다.

1. 서브 페이지 설명 첫째·둘째 줄의 처음, 중간, 끝에서 커서가 표시 글자와 같은 줄에 보인다.
2. 설명의 일반 `Enter`는 줄바꿈을 만든다.
3. 다음 블릿이 있는 설명의 `Shift+Enter`는 다음에 보이는 제목으로 이동한다.
4. 마지막 일반 블릿 설명의 `Shift+Enter`는 같은 깊이에 빈 블릿을 만들고 제목에 커서를 둔다.
5. 하위 블릿이 없는 서브 페이지 설명의 `Shift+Enter`는 첫 하위 블릿을 만들고 제목에 커서를 둔다.
6. 한글 조합과 기존 `Escape`, 위·아래 화살표 이동은 회귀하지 않는다.

- [ ] **Step 4: 새 Tauri 프로세스만 종료하고 임시 화면·Vault 데이터를 정리한다**

Expected: 별도 식별자의 개발 프로세스와 이 검증에서 만든 임시 데이터만 제거되며 기존 사용자 프로세스와 Vault는 유지된다.

- [ ] **Step 5: 프런트엔드 최종 게이트를 한 번 실행한다**

Run:

```bash
npm test
npm run lint
npm run build
git diff --check 7021f7a..HEAD
```

Expected: 모든 명령 exit 0. Rust, IPC, persistence 및 native configuration을 변경하지 않았으므로 Cargo test, Rust format, Clippy는 실행하지 않는다.

- [ ] **Step 6: 최종 diff와 작업공간 상태를 검토한다**

Run:

```bash
git status --short --branch
git log --oneline --decorate -6
git diff --stat 7021f7a..HEAD
git diff 7021f7a..HEAD -- src/features/notes/outlineKeyboard.ts src/features/notes/NotesPageHeader.tsx src/features/notes/OutlineNodeRow.tsx src/features/notes/notes.css
```

Expected: 계획한 production 네 파일과 관련 테스트만 변경되고 작업 트리는 깨끗하다. 최종 보고에는 RED/GREEN, 소유 테스트, 새 앱 관찰, 전체 게이트, Cargo 생략 사유 및 구현 커밋 hash를 포함한다.
