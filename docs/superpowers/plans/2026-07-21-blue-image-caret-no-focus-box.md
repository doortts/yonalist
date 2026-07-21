# Blue Image Caret And Borderless Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이미지 원자 경계 카렛을 파란 강조색으로 바꾸고 이미지 블릿 본체의 포커스 외곽선을 제거하되 메뉴 버튼의 포커스 링은 유지한다.

**Architecture:** 기존 DOM과 React 상태는 그대로 두고 `notes.css`의 세 선언만 조정한다. 기존 CSS 계약 테스트를 먼저 기대 상태로 바꿔 실패를 확인한 뒤 최소 스타일 변경으로 통과시킨다.

**Tech Stack:** React 19, TypeScript, CSS, Vitest

## Global Constraints

- 이미지 원자 앞·뒤 카렛은 `var(--accent)`를 사용한다.
- 이미지 블릿 본체는 포커스 외곽선을 표시하지 않는다.
- 이미지 메뉴 버튼의 `2px solid var(--accent)` 포커스 링은 유지한다.
- Rust, Tauri IPC, SQLite, 파일시스템, Undo/Redo는 변경하지 않는다.

---

### Task 1: 이미지 원자 카렛을 파란색으로 변경

**Files:**
- Modify: `src/features/notes/NotesWorkspace.test.tsx:9866`
- Modify: `src/features/notes/notes.css:1871-1947`

**Interfaces:**
- Consumes: 기존 `.notes-image-atom-editor` 및 빈 경계 카렛 선택자
- Produces: 이미지 원자 편집기의 `caret-color: var(--accent)` CSS 계약

- [x] **Step 1: 실패하는 스타일 계약 테스트 작성**

`NotesWorkspace.test.tsx`의 카렛 테스트를 다음 기대값으로 바꾼다.

```tsx
it("positions native blue carets at image atom boundaries", () => {
  expect(notesStyles).toMatch(/caret-color:\\s*var\\(--accent\\)/);
  expect(notesStyles).not.toMatch(/caret-color:\\s*var\\(--danger\\)/);
  expect(notesStyles).toMatch(/inset-inline-start:\\s*-2px/);
  expect(notesStyles).toMatch(
    /inset-inline-start:\\s*calc\\(var\\(--notes-image-atom-frame-inline-size\\) \\+ 2px\\)/
  );
  expect(notesStyles).not.toMatch(/notes-image-attachment-frame::before/);
  expect(notesStyles).not.toMatch(/notes-image-attachment-frame::after/);
});
```

- [x] **Step 2: 테스트가 올바른 이유로 실패하는지 확인**

Run: `npm test -- src/features/notes/NotesWorkspace.test.tsx`

Expected: `positions native blue carets at image atom boundaries`가 현재 `var(--danger)` 선언 때문에 FAIL한다.

- [x] **Step 3: 최소 CSS 변경**

`notes.css`의 이미지 원자 편집기와 활성 빈 경계 선언을 다음처럼 바꾼다.

```css
.notes-image-atom-editor {
  caret-color: var(--accent);
}

.notes-image-atom-editor:focus[data-image-atom-caret-side="before"]
  [data-image-atom-region="before"][data-image-atom-empty="true"],
.notes-image-atom-editor:focus[data-image-atom-caret-side="after"]
  [data-image-atom-region="after"][data-image-atom-empty="true"] {
  caret-color: var(--accent);
}
```

- [x] **Step 4: 관련 테스트 통과 확인**

Run: `npm test -- src/features/notes/NotesWorkspace.test.tsx`

Expected: 해당 파일의 모든 테스트 PASS.

- [x] **Step 5: 카렛 변경 커밋**

```bash
git add src/features/notes/NotesWorkspace.test.tsx src/features/notes/notes.css
git commit -m "fix(notes): use blue image atom carets"
```

### Task 2: 이미지 본체 포커스 외곽선 제거

**Files:**
- Modify: `src/features/notes/NotesWorkspace.test.tsx:9850-9864`
- Modify: `src/features/notes/NotesImageAttachment.test.tsx:190-218`
- Modify: `src/features/notes/notes.css:2018-2038,2323-2336`

**Interfaces:**
- Consumes: `.notes-node :focus-visible`, `.notes-image-atom-editor:focus-visible`, `.notes-image-node-content:focus-visible`, `.notes-image-menu-trigger:focus-visible`
- Produces: 외부 편집기와 내부 이미지 본체는 `outline: 0`, 메뉴 버튼은 기존 강조색 포커스 링 유지

- [x] **Step 1: 실패하는 포커스 스타일 계약 테스트 작성**

두 테스트 파일에서 외부 편집기와 내부 이미지 본체는 `outline: 0`을 사용하고 메뉴 버튼은 강조색 포커스 링을 유지한다고 검증한다. 외부 편집기 오버라이드는 공통 행 포커스 규칙보다 뒤에 있어야 한다.

```tsx
const genericNodeFocusRuleIndex = notesStyles.indexOf(
  ".notes-node :focus-visible"
);
const imageAtomFocusRuleIndex = notesStyles.indexOf(
  ".notes-image-atom-editor:focus-visible"
);
expect(imageAtomFocusRuleIndex).toBeGreaterThan(genericNodeFocusRuleIndex);
expect(notesStyles).toMatch(
  /\\.notes-image-atom-editor:focus-visible\\s*\\{[^}]*outline:\\s*0;/s
);
expect(notesStyles).toMatch(
  /\\.notes-image-node-content:focus-visible\\s*\\{[^}]*outline:\\s*0;/s
);
expect(notesStyles).not.toMatch(
  /\\.notes-image-node-content:focus-visible\\s*\\{[^}]*outline:\\s*2px solid var\\(--accent\\);/s
);
expect(notesStyles).toMatch(
  /\\.notes-image-menu-trigger:focus-visible\\s*\\{[^}]*outline:\\s*2px solid var\\(--accent\\);/s
);
```

- [x] **Step 2: 테스트가 올바른 이유로 실패하는지 확인**

Run: `npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesImageAttachment.test.tsx`

Expected: 공통 `.notes-node :focus-visible`과 내부 이미지 본체의 기존 `2px solid var(--accent)` 외곽선 때문에 관련 테스트가 FAIL한다.

- [x] **Step 3: 이미지 본체 외곽선만 제거**

공통 행 포커스 규칙 뒤에 외부 편집기 오버라이드를 둔다.

```css
.notes-image-atom-editor:focus-visible {
  outline: 0;
}

.notes-image-node-content:focus-visible {
  outline: 0;
}
```

메뉴 버튼의 다음 규칙은 변경하지 않는다.

```css
.notes-image-menu-trigger:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}
```

- [x] **Step 4: 관련 테스트 통과 확인**

Run: `npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesImageAttachment.test.tsx`

Expected: 두 파일의 모든 테스트 PASS.

- [x] **Step 5: 전체 프런트엔드 게이트 실행**

Run: `npm test && npm run lint && npm run build && git diff --check`

Expected: 모든 명령 exit 0. Rust·IPC·저장소 변경이 없으므로 Cargo 테스트와 Clippy는 실행하지 않는다.

- [x] **Step 6: 포커스 스타일 변경 커밋**

```bash
git add src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesImageAttachment.test.tsx src/features/notes/notes.css
git commit -m "fix(notes): remove image bullet focus box"
```
