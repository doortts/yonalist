# Notes Library Structural Loading Visual Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 오른쪽 작성 pane에서 Tab/Shift+Tab 구조 이동을 실행해도 왼쪽 Notes 라이브러리 pane의 밝기와 표시가 깜박이지 않게 한다.

**Architecture:** 기존 구조 명령의 loading 및 disabled 소유권은 유지한다. `NotesLibraryPane`이 root 데이터가 있는 transient loading을 data attribute로 표시하고, Notes CSS가 그 짧은 구간의 컨트롤 밝기만 ready 상태와 동일하게 유지한다.

**Tech Stack:** React 19, TypeScript 6, Vitest 4, Testing Library, CSS, Vite 8, Tauri 2

## Global Constraints

- 구조 명령 큐, 저장 순서, Undo/Redo, 포커스 및 들여쓰기 규칙을 변경하지 않는다.
- transient loading 중에도 왼쪽 구조 명령 컨트롤의 기존 `disabled`와 `aria-busy`를 유지한다.
- 최초 workspace 로딩과 데이터 삭제 중의 기존 loading/disabled 표시는 유지한다.
- React 표시와 Notes CSS만 변경하고 IPC, Rust, SQLite 및 native configuration은 변경하지 않는다.
- 구현 전에 회귀 테스트의 RED를 확인한다.

---

### Task 1: transient 구조 변경 중 라이브러리 표시를 안정화

**Files:**
- Modify: `src/features/notes/NotesLibraryPane.tsx`
- Modify: `src/features/notes/notes.css`
- Test: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: `state.status`, `state.rootIds`, `deletingNotesData`와 기존 구조 명령의 pending/settled 전환
- Produces: `data-transient-workspace-busy="true"` 표시와 disabled 상태에서도 ready 밝기를 유지하는 CSS

- [ ] **Step 1: pending Tab 이동의 실패 통합 테스트를 작성한다**

`NotesWorkspace.test.tsx`에서 root `project` 아래의 `first`, `second`를 렌더링하고
`notesStoreMock.moveNode`를 deferred promise로 유지한다. `second` 제목에서 Tab을
누른 뒤 다음 계약을 검증한다.

```tsx
const library = screen.getByRole("region", { name: "Notes library" });
expect(library).toHaveAttribute("data-transient-workspace-busy", "true");
expect(within(library).getByRole("button", { name: "New page" })).toBeDisabled();
expect(within(library).getByRole("button", { name: "Project" })).toBeDisabled();
expect(
  within(library).getByRole("button", { name: "Page actions for Project" })
).toBeDisabled();
```

move 응답을 resolve한 뒤 attribute가 제거되고 구조가 이동하며 왼쪽 컨트롤이 다시
활성화되는지도 검증한다.

- [ ] **Step 2: 시각 계약의 실패 CSS 테스트를 작성한다**

같은 테스트 파일의 `notesStyles` 계약에 transient 상태 아래의 세 컨트롤이 다음
값을 갖는 규칙을 기대한다.

```tsx
expect(notesStyles).toMatch(
  /\.notes-library-pane\[data-transient-workspace-busy="true"\][\s\S]*\.notes-new-page:disabled[^{]*\{[^}]*opacity:\s*1;/s
);
expect(notesStyles).toMatch(
  /\.notes-library-pane\[data-transient-workspace-busy="true"\][\s\S]*\.notes-library-page:disabled[^{]*\{[^}]*opacity:\s*1;/s
);
expect(notesStyles).toMatch(
  /\.notes-library-pane\[data-transient-workspace-busy="true"\][\s\S]*\.notes-library-page-menu-trigger:disabled[^{]*\{[^}]*opacity:\s*0\.68;/s
);
```

- [ ] **Step 3: 새 테스트가 실제 원인 때문에 실패하는지 확인한다**

Run:

```bash
npx vitest run src/features/notes/NotesWorkspace.test.tsx -t "Notes library visually stable|library controls visually stable"
```

Expected: DOM 테스트는 transient data attribute 부재로 FAIL하고 CSS 테스트는 안정화
규칙 부재로 FAIL한다.

- [ ] **Step 4: transient 상태와 최소 CSS 규칙을 구현한다**

`NotesLibraryPaneContent`에서 다음 값을 계산해 section에 표시한다.

```tsx
const transientWorkspaceBusy =
  state.status === "loading" &&
  state.rootIds.length > 0 &&
  !deletingNotesData;

<section
  className="list-pane notes-library-pane"
  aria-label="Notes library"
  aria-busy={state.status === "loading" || deletingNotesData}
  data-transient-workspace-busy={
    transientWorkspaceBusy ? "true" : undefined
  }
>
```

`notes.css`에서 이 attribute 아래의 disabled 표시만 ready 밝기로 고정한다.

```css
.notes-library-pane[data-transient-workspace-busy="true"]
  .notes-new-page:disabled,
.notes-library-pane[data-transient-workspace-busy="true"]
  .notes-library-page:disabled {
  opacity: 1;
}

.notes-library-pane[data-transient-workspace-busy="true"]
  .notes-library-page-menu-trigger:disabled {
  opacity: 0.68;
}
```

기존 disabled 속성과 명령 처리 코드는 변경하지 않는다.

- [ ] **Step 5: focused 테스트를 통과시킨다**

Run:

```bash
npx vitest run src/features/notes/NotesWorkspace.test.tsx -t "Notes library visually stable|library controls visually stable"
```

Expected: PASS, 0 failures.

- [ ] **Step 6: Notes 라이브러리와 workspace 소유 테스트를 통과시킨다**

Run:

```bash
npx vitest run src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/useNotesWorkspace.test.tsx
```

Expected: PASS, 0 failures. 기존 structural loading 테스트도 계속 PASS해야 한다.

- [ ] **Step 7: 구현을 커밋한다**

```bash
git add src/features/notes/NotesLibraryPane.tsx src/features/notes/notes.css src/features/notes/NotesWorkspace.test.tsx
git commit -m "fix(notes): stabilize library during outline moves"
```

### Task 2: 실제 앱과 최종 게이트 검증

**Files:**
- Verify only

**Interfaces:**
- Consumes: Task 1의 transient 시각 안정화
- Produces: 격리된 새 앱 직접 확인과 병합 가능한 최종 증거

- [ ] **Step 1: 격리된 새 Tauri 앱에서 직접 확인한다**

`mktemp -d /tmp/yonalist-library-flicker.XXXXXX`로 임시 HOME을 만들고 기존 앱과
다른 product name, bundle identifier, 개발 포트(1426)를 사용한다.

```bash
env HOME="$TEMP_HOME" \
  RUSTUP_HOME=/Users/doortts/.rustup \
  CARGO_HOME=/Users/doortts/.cargo \
  CARGO_TARGET_DIR=/Users/doortts/repos/yonalist/src-tauri/target \
  npm run tauri:dev -- --config '{"productName":"Yonalist Codex Library Stability","identifier":"com.doortts.yonalist.codex-library-stability","build":{"beforeDevCommand":"npm run dev -- --port 1426","devUrl":"http://127.0.0.1:1426"}}'
```

새 PID/포트를 확인하고 `lsof -p <fresh-pid>`의 `notes.sqlite`, WAL, SHM, lock이
임시 HOME의 `Yonalist/.yonalist` 아래에만 있는지 확인한다. root 하위의 두 형제
사이에서 Tab/Shift+Tab을 반복하며 왼쪽 `New page`, 페이지 제목, 메뉴 아이콘의
밝기가 변하지 않고 오른쪽 구조 이동은 정상인지 확인한다. 종료 후 새 스택만 끄고
임시 Vault와 캡처를 휴지통으로 옮긴다.

- [ ] **Step 2: 프런트엔드 최종 게이트를 한 번 실행한다**

```bash
npm test
npm run lint
npm run build
git diff --check main...HEAD
```

Expected: 모두 exit 0. Rust, IPC, persistence 및 native configuration이 바뀌지
않으므로 Cargo 테스트, rustfmt, Clippy는 생략한다.

- [ ] **Step 3: 최종 diff를 검토하고 main에 안전하게 병합한다**

변경 파일이 설계 문서, 계획, `NotesLibraryPane.tsx`, `notes.css`, 관련 테스트로만
제한됐는지 확인한다. 로컬 `main`이 분기 기준에서 바뀌지 않았고 clean이면
fast-forward 병합한다. 병합 결과 전체 테스트를 다시 확인한 뒤 이번 작업에서 만든
worktree와 branch만 정리하며 원격 push는 하지 않는다.
