# Notes Stable Caret and Note Spacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 고정 표시 Notes 필드의 커서를 글자 줄 상자에 맞추고 일반 블릿 제목과 설명 사이의 상단 간격을 2px 줄인다.

**Architecture:** 기존 `NoteTextField`의 표시/입력 이중 레이어와 이벤트 경로는 유지한다. CSS에서 고정 표시 컨테이너의 textarea transform만 해제하고 일반 블릿 설명 컨테이너의 상단 margin만 줄인다.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Testing Library, Vite, Tauri 2

## Global Constraints

- `data-stable-presentation="true"`인 필드에서만 textarea transform을 해제한다.
- 일반 블릿 제목의 기존 `--notes-text-edit-offset` 및 `--notes-node-title-edit-offset` 보정은 유지한다.
- 일반 블릿 설명 margin은 `0 0 8px calc(var(--notes-indent) + var(--notes-content-offset))`로 고정한다.
- 글자 크기 14px, 줄 높이 20px, 색상, 포커스 밑줄 정책과 왼쪽 들여쓰기는 변경하지 않는다.
- 저장 데이터, Undo/Redo, Enter/Shift+Enter, React 이벤트, IPC, Rust, SQLite 및 native configuration은 변경하지 않는다.

---

### Task 1: 고정 표시 필드의 커서 줄 상자 정렬

**Files:**
- Modify: `src/features/notes/NotesWorkspace.test.tsx:9440-9470`
- Modify: `src/features/notes/notes.css:874-880`

**Interfaces:**
- Consumes: `NoteTextField`가 출력하는 `data-stable-presentation="true"` 컨테이너와 직접 자식 textarea
- Produces: 고정 표시 필드에서만 기존 textarea transform을 무효화하는 CSS 계약

- [ ] **Step 1: 고정 표시 커서 transform 해제 계약을 추가한다**

`NotesWorkspace.test.tsx`의 Notes 스타일 계약 테스트에 다음 assertion을 추가한다.

```tsx
expect(notesStyles).toMatch(
  /\.notes-text-field\[data-stable-presentation="true"\]\s*>\s*textarea\s*{[^}]*transform:\s*none;/s
);
```

- [ ] **Step 2: 테스트가 올바른 이유로 실패하는지 확인한다**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "uses stable Workflowy row geometry without action overlap"
```

Expected: FAIL. 기존 공통 `translateY(var(--notes-text-edit-offset))` 규칙은 있지만 고정 표시 필드의 `transform: none` 예외가 없다는 assertion 실패가 출력된다.

- [ ] **Step 3: 고정 표시 필드에만 최소 CSS 예외를 추가한다**

`notes.css`에서 일반 필드와 node title 보정 규칙 다음에 추가해 cascade 우선순위를 명확히 한다.

```css
.notes-text-field[data-stable-presentation="true"] > textarea {
  transform: none;
}
```

- [ ] **Step 4: 소유 테스트가 통과하는지 확인한다**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "uses stable Workflowy row geometry without action overlap"
```

Expected: PASS, 0 failures.

- [ ] **Step 5: 첫 변경을 커밋한다**

```bash
git add src/features/notes/NotesWorkspace.test.tsx src/features/notes/notes.css
git commit -m "fix(notes): align stable field carets"
```

### Task 2: 일반 블릿 제목과 설명 간격 축소

**Files:**
- Modify: `src/features/notes/NotesWorkspace.test.tsx:9525-9545`
- Modify: `src/features/notes/notes.css:1736-1742`

**Interfaces:**
- Consumes: `.notes-node-main` 뒤에 렌더링되는 `.notes-node-note-field`
- Produces: 왼쪽 들여쓰기와 8px 아래 여백은 유지하면서 상단 여백을 제거한 설명 레이아웃

- [ ] **Step 1: 일반 블릿 설명 margin 계약을 0px 상단 여백으로 변경한다**

기존 `.notes-node-note-field` assertion을 다음과 같이 바꾼다.

```tsx
expect(notesStyles).toMatch(
  /\.notes-node-note-field\s*{[^}]*width:\s*calc\(100% - var\(--notes-indent\) - var\(--notes-content-offset\)\);[^}]*margin:\s*0 0 8px calc\(var\(--notes-indent\) \+ var\(--notes-content-offset\)\);/s
);
```

- [ ] **Step 2: 테스트가 기존 2px 상단 margin 때문에 실패하는지 확인한다**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "uses stable Workflowy row geometry without action overlap"
```

Expected: FAIL. 실제 margin이 `2px 0 8px ...`라 새 계약과 일치하지 않는다.

- [ ] **Step 3: 설명 필드 상단 margin을 제거한다**

```css
.notes-node-note-field {
  width: calc(100% - var(--notes-indent) - var(--notes-content-offset));
  margin: 0 0 8px calc(var(--notes-indent) + var(--notes-content-offset));
  font-size: 14px;
  line-height: 20px;
  --notes-stable-caret-color: var(--text-3);
}
```

- [ ] **Step 4: 관련 Notes 스타일 계약 전체가 통과하는지 확인한다**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx
```

Expected: 해당 파일의 모든 테스트 PASS, 0 failures.

- [ ] **Step 5: 두 번째 변경을 커밋한다**

```bash
git add src/features/notes/NotesWorkspace.test.tsx src/features/notes/notes.css
git commit -m "fix(notes): tighten supporting note spacing"
```

### Task 3: 실제 화면과 최종 프런트엔드 게이트 검증

**Files:**
- Verify: `src/features/notes/notes.css`
- Verify: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: Task 1과 Task 2의 고정된 CSS diff
- Produces: 새 Tauri 프로세스의 사용자 화면 증거와 프런트엔드 전체 게이트 결과

- [ ] **Step 1: 공유 Rust 캐시를 사용하되 별도 앱 식별자와 포트로 새 Tauri 앱을 실행한다**

Run:

```bash
CARGO_TARGET_DIR=/Users/doortts/repos/yonalist/src-tauri/target npm run tauri:dev -- --config '{"productName":"Yonalist Codex Caret","identifier":"com.doortts.yonalist.codex-caret","build":{"beforeDevCommand":"npm run dev -- --port 1423","devUrl":"http://127.0.0.1:1423"}}'
```

Expected: 기존 Yonalist 프로세스와 별개의 새 프로세스가 port 1423의 새 Vite bundle을 표시한다.

- [ ] **Step 2: 직접 사용자 경로를 확인한다**

새 앱의 Notes 샘플 데이터에서 다음을 확인한다.

1. 서브 페이지 설명 끝과 글자 중간의 커서가 표시 글자의 20px 줄 상자와 맞는다.
2. 일반 블릿 설명의 커서도 표시 글자와 맞고 밑줄이 없다.
3. 포커스를 해제해도 설명 글자의 위치가 바뀌지 않는다.
4. 제목과 설명의 간격이 이전보다 2px 가까우며 들여쓰기는 유지된다.
5. 일반 블릿 제목 편집과 한글 입력은 기존대로 동작한다.

- [ ] **Step 3: 새 Tauri 프로세스만 종료하고 임시 화면 파일을 휴지통으로 이동한다**

Expected: 기존 사용자 Yonalist 프로세스는 계속 실행 중이고 별도 식별자의 개발 프로세스만 종료된다.

- [ ] **Step 4: 프런트엔드 최종 게이트를 한 번 실행한다**

Run:

```bash
npm test
npm run lint
npm run build
git diff --check HEAD~2..HEAD
```

Expected: 모든 명령 exit 0. Rust, IPC, persistence 및 native configuration은 변경하지 않았으므로 Cargo test, Rust format, Clippy는 실행하지 않는다.

- [ ] **Step 5: 최종 diff와 브랜치 상태를 확인한다**

Run:

```bash
git status --short --branch
git log --oneline --decorate -5
git diff --stat HEAD~2..HEAD
```

Expected: 작업 트리가 깨끗하고 Task 1과 Task 2의 두 구현 커밋만 설계 기준점 위에 존재한다.
