# Notes 안정적 편집 표시 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 서브 페이지 제목과 항목 노트가 비편집 표시층을 편집 중에도 그대로 사용해 위치와 글자 모양을 유지하고, 항목 노트의 모든 하단 포커스선을 제거한다.

**Architecture:** 공용 `NoteTextField`에 선택적 `stablePresentation` 모드를 추가한다. 이 모드에서는 `NoteTokenText`가 계속 실제 글자를 표시하고 textarea는 투명한 입력·커서·선택·IME 계층으로 남는다. Notes 페이지 제목·페이지 설명·행 항목 노트만 이 모드를 사용하며 저장 및 키보드 명령 경로는 변경하지 않는다.

**Tech Stack:** React, TypeScript, Vitest, Testing Library, CSS, Tauri desktop runtime

## 전역 제약 조건

- 비편집 표시 상태를 서브 페이지 제목과 항목 노트의 시각적 기준으로 사용한다.
- 서브 페이지 제목의 수직 위치, 글자 크기, 굵기는 포커스 전환 전후에 달라지지 않아야 한다.
- 페이지 설명과 행 항목 노트는 편집 및 비편집 포커스 상태 모두 밑줄, 테두리, 내부 그림자 또는 대체 외곽선을 표시하지 않아야 한다.
- 항목 노트의 표시 글자는 편집 중과 비편집 상태 모두 14px/20px를 유지해야 한다.
- textarea가 포커스, 커서, 선택, clipboard, 키보드 이벤트, 한글 IME 조합을 계속 소유해야 한다.
- Enter, Shift+Enter, Undo/Redo, 저장, IPC, Rust, SQLite, filesystem 동작을 변경하지 않는다.
- 실제 화면 검증에는 새로 빌드하고 재시작한 Tauri 앱과 격리된 테스트 데이터를 사용한다.

---

### Task 1: `NoteTextField` 고정 표시 모드

**Files:**
- Modify: `src/features/notes/NoteTextField.tsx:17-388`
- Test: `src/features/notes/NoteTextField.test.tsx:75-220`

**Interfaces:**
- Consumes: 기존 `NoteTextFieldProps`, `editing` 상태, `NoteTokenText`, textarea `placeholder`.
- Produces: 선택적 prop `stablePresentation?: boolean`; wrapper의 `data-stable-presentation="true"`; 편집 중에도 보이는 표시층; `--notes-stable-caret-color`를 사용하는 투명 textarea 입력층.

- [ ] **Step 1: 고정 표시층의 편집 동작을 나타내는 실패 테스트 작성**

`NoteTextField.test.tsx`의 기존 모드 전환 테스트 옆에 다음 테스트를 추가한다.

```tsx
it("keeps an opted-in stable presentation visible while the textarea edits", () => {
  const { container, rerender } = render(
    <NoteTextField
      stablePresentation
      value="같은 글자"
      aria-label="Edit stable field"
      onChange={vi.fn()}
      onTagClick={vi.fn()}
    />
  );
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  const presentation = container.querySelector(
    ".notes-token-text"
  ) as HTMLElement;
  const field = textarea.closest(".notes-text-field");

  expect(field).toHaveAttribute("data-stable-presentation", "true");
  expect(presentation).toHaveStyle({ visibility: "visible" });

  act(() => textarea.focus());

  expect(presentation).toHaveStyle({
    pointerEvents: "none",
    visibility: "visible"
  });
  expect(presentation).toHaveAttribute("aria-hidden", "true");
  expect(textarea.style.color).toBe("transparent");
  expect(textarea.style.getPropertyValue("-webkit-text-fill-color")).toBe(
    "transparent"
  );
  expect(textarea.style.caretColor).toBe(
    "var(--notes-stable-caret-color)"
  );

  rerender(
    <NoteTextField
      stablePresentation
      value="같은 글자 한"
      aria-label="Edit stable field"
      onChange={vi.fn()}
      onTagClick={vi.fn()}
    />
  );
  expect(presentation).toHaveTextContent("같은 글자 한");
  expect(textarea).toHaveFocus();
});
```

- [ ] **Step 2: 빈 필드 placeholder의 실패 테스트 작성**

```tsx
it("keeps an opted-in placeholder visible while an empty field edits", () => {
  const { container } = render(
    <NoteTextField
      stablePresentation
      value=""
      placeholder="Add a supporting note"
      aria-label="Edit empty stable field"
      onChange={vi.fn()}
      onTagClick={vi.fn()}
    />
  );
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  const presentation = container.querySelector(
    ".notes-token-text"
  ) as HTMLElement;

  expect(presentation).toHaveAttribute("data-placeholder", "true");
  expect(presentation).toHaveTextContent("Add a supporting note");
  act(() => textarea.focus());
  expect(presentation).toHaveStyle({ visibility: "visible" });
  expect(textarea).toHaveAttribute("placeholder", "Add a supporting note");
});
```

- [ ] **Step 3: 집중 테스트를 실행해 RED 확인**

Run:

```bash
npm test -- src/features/notes/NoteTextField.test.tsx -t "opted-in stable presentation|opted-in placeholder"
```

Expected: FAIL. `stablePresentation` prop과 관련 data/style 동작이 아직 없어 테스트가 실패해야 한다.

- [ ] **Step 4: `NoteTextField`에 최소 고정 표시 구현 추가**

`NoteTextFieldProps`와 prop 분해에 다음 선택적 값을 추가한다.

```tsx
export interface NoteTextFieldProps
  extends Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "children" | "value" | "onDateClick"
  > {
  value: string;
  stablePresentation?: boolean;
  // 기존 props 유지
}
```

```tsx
stablePresentation = false,
placeholder,
```

레이아웃 style을 다음 계약으로 확장한다.

```tsx
const stableEditing = stablePresentation && editing;
const presentationText =
  stablePresentation && value.length === 0 && placeholder
    ? placeholder
    : value;
const showingPlaceholder = presentationText !== value;
const presentationLayout: CSSProperties = {
  ...style,
  position: "absolute",
  inset: 0,
  zIndex: 1,
  pointerEvents: editing ? "none" : "auto",
  visibility: editing && !stablePresentation ? "hidden" : "visible"
};
const textareaLayout: CSSProperties = {
  ...style,
  opacity: editing ? style?.opacity ?? 1 : 0,
  caretColor: editing
    ? stablePresentation
      ? "var(--notes-stable-caret-color)"
      : style?.caretColor
    : "transparent",
  pointerEvents: editing ? style?.pointerEvents : "none",
  ...(stableEditing
    ? {
        color: "transparent",
        WebkitTextFillColor: "transparent"
      }
    : {})
};
```

wrapper, 표시층, textarea에 다음 값을 연결한다.

```tsx
<span
  className={fieldClassName}
  data-editing={editing ? "true" : "false"}
  data-stable-presentation={stablePresentation ? "true" : undefined}
  style={{ display: "block", minWidth: 0, position: "relative" }}
>
  <NoteTokenText
    // 기존 props 유지
    text={presentationText}
    data-placeholder={showingPlaceholder ? "true" : undefined}
    style={presentationLayout}
  />
  <textarea
    {...textareaProps}
    // 기존 props 유지
    placeholder={placeholder}
    style={textareaLayout}
  />
</span>
```

- [ ] **Step 5: 집중 및 소유 테스트를 실행해 GREEN 확인**

Run:

```bash
npm test -- src/features/notes/NoteTextField.test.tsx -t "opted-in stable presentation|opted-in placeholder"
npm test -- src/features/notes/NoteTextField.test.tsx
```

Expected: 새 테스트 2개와 기존 `NoteTextField` 테스트 전체가 실패 없이 통과한다.

- [ ] **Step 6: 공용 컴포넌트 변경 커밋**

```bash
git add src/features/notes/NoteTextField.tsx src/features/notes/NoteTextField.test.tsx
git commit -m "fix(notes): keep stable field presentation while editing"
```

### Task 2: Notes 필드 적용과 항목 노트 포커스선 제거

**Files:**
- Modify: `src/features/notes/NotesPageHeader.tsx:819-930`
- Modify: `src/features/notes/OutlineNodeRow.tsx:1596-1665`
- Modify: `src/features/notes/notes.css:835-870, 1021-1031, 1464-1474, 1725-1750, 1954-1962`
- Test: `src/features/notes/NotesWorkspace.test.tsx:2750-2830, 9628-9665`

**Interfaces:**
- Consumes: Task 1의 `stablePresentation?: boolean`과 `data-stable-presentation="true"` 계약.
- Produces: 페이지 제목·페이지 설명·행 항목 노트의 고정 표시 opt-in; 페이지 설명 및 행 항목 노트의 14px/20px 부모 타이포그래피; 항목 노트의 line-free 포커스 규칙.

- [ ] **Step 1: Notes 필드 opt-in 실패 테스트 작성**

`NotesWorkspace.test.tsx`의 zoom 테스트 옆에 다음 검증을 추가한다.

```tsx
it("uses stable presentation for page fields and row supporting notes", async () => {
  const user = userEvent.setup();
  renderNotesWorkspace();
  await findTitleInput("Project");

  const rowNote = getTextareaByName("Supporting note: Project");
  expect(rowNote.closest(".notes-text-field")).toHaveAttribute(
    "data-stable-presentation",
    "true"
  );

  await user.click(screen.getByRole("button", { name: "Zoom into Project" }));
  await screen.findByRole("heading", { name: "Project", level: 1 });

  const pageTitle = document.querySelector(
    "textarea.notes-page-title"
  ) as HTMLTextAreaElement;
  const pageNote = getTextareaByName("Supporting note: Project");
  expect(pageTitle.closest(".notes-text-field")).toHaveAttribute(
    "data-stable-presentation",
    "true"
  );
  expect(pageNote.closest(".notes-text-field")).toHaveAttribute(
    "data-stable-presentation",
    "true"
  );
});
```

- [ ] **Step 2: 항목 노트의 line-free CSS 계약으로 기존 테스트 교체**

기존 `keeps row supporting-note typography stable after blur` 테스트를 다음으로 교체한다.

```tsx
it("keeps supporting-note visuals stable and line-free across focus", () => {
  expect(notesStyles).toMatch(
    /\.notes-page-note-field\s*{[^}]*font-size:\s*14px;[^}]*line-height:\s*20px;[^}]*--notes-stable-caret-color:\s*var\(--text-3\);/s
  );
  expect(notesStyles).toMatch(
    /\.notes-node-note-field\s*{[^}]*font-size:\s*14px;[^}]*line-height:\s*20px;[^}]*--notes-stable-caret-color:\s*var\(--text-3\);/s
  );

  const editorRule = notesStyles.match(
    /\.notes-node-note:focus-visible\s*{([^}]*)}/s
  )?.[1];
  const presentationRule = notesStyles.match(
    /\.notes-node-note-field > \.notes-token-text:focus-visible\s*{([^}]*)}/s
  )?.[1];
  for (const rule of [editorRule, presentationRule]) {
    expect(rule).toBeDefined();
    expect(rule).toMatch(/outline:\s*0;/);
    expect(rule).toMatch(/box-shadow:\s*none;/);
    expect(rule).not.toMatch(/border-bottom|text-decoration|inset\s+0\s+-\d+px/);
  }
});
```

- [ ] **Step 3: 집중 테스트를 실행해 RED 확인**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "uses stable presentation for page fields and row supporting notes|keeps supporting-note visuals stable and line-free across focus"
```

Expected: FAIL. Notes 필드가 아직 opt-in하지 않았고 행 항목 노트의 두 포커스 규칙에 내부 그림자가 남아 있어야 한다.

- [ ] **Step 4: 페이지와 행 필드에 고정 표시 모드 적용**

`NotesPageHeader.tsx`의 페이지 제목과 페이지 설명 `NoteTextField`에 다음 prop을 추가한다.

```tsx
stablePresentation
```

`OutlineNodeRow.tsx`의 `notes-node-note` `NoteTextField`에도 같은 prop을 추가한다. 기존 callback과 keyboard handler는 변경하지 않는다.

- [ ] **Step 5: 필드 소유 타이포그래피와 커서 색상 추가**

`notes.css`에 다음 계약을 적용한다.

```css
.notes-page-title-field {
  --notes-stable-caret-color: var(--text-1);
  font-size: 27px;
  font-weight: 700;
  line-height: 34px;
}

.notes-page-note-field {
  font-size: 14px;
  line-height: 20px;
  --notes-stable-caret-color: var(--text-3);
}

.notes-text-field > .notes-token-text[data-placeholder="true"] {
  color: var(--text-3);
}

.notes-node-note-field {
  width: calc(100% - var(--notes-indent) - var(--notes-content-offset));
  margin: 2px 0 8px calc(var(--notes-indent) + var(--notes-content-offset));
  font-size: 14px;
  line-height: 20px;
  --notes-stable-caret-color: var(--text-3);
}
```

- [ ] **Step 6: 행 항목 노트의 두 포커스선 제거**

```css
.notes-node-note-field > .notes-token-text:focus-visible {
  outline: 0;
  box-shadow: none;
}

.notes-node-note:focus-visible {
  outline: 0;
  box-shadow: none;
}
```

- [ ] **Step 7: 집중 및 소유 테스트를 실행해 GREEN 확인**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "uses stable presentation for page fields and row supporting notes|keeps supporting-note visuals stable and line-free across focus"
npm test -- src/features/notes/NoteTextField.test.tsx src/features/notes/NotesWorkspace.test.tsx
git diff --check
```

Expected: 두 집중 테스트와 두 소유 테스트 파일이 실패 없이 통과하고 whitespace 오류가 없다.

- [ ] **Step 8: Notes 적용 변경 커밋**

```bash
git add src/features/notes/NotesPageHeader.tsx src/features/notes/OutlineNodeRow.tsx src/features/notes/notes.css src/features/notes/NotesWorkspace.test.tsx
git commit -m "fix(notes): stabilize focused note visuals"
```

### Task 3: 통합 데스크톱 동작 및 최종 검증

**Files:**
- Verify: `src/features/notes/NoteTextField.tsx`
- Verify: `src/features/notes/NotesPageHeader.tsx`
- Verify: `src/features/notes/OutlineNodeRow.tsx`
- Verify: `src/features/notes/notes.css`
- Verify: `src/features/notes/NoteTextField.test.tsx`
- Verify: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: Task 1과 Task 2의 고정 표시 및 line-free 포커스 계약.
- Produces: 새 Tauri 프로세스에서 확인한 실제 사용자 동작과 동결된 diff의 최종 프런트엔드 검증 결과.

- [ ] **Step 1: 새 Tauri 개발 앱을 격리해 실행**

기존 사용자의 Yonalist 프로세스와 Vault를 유지한다. 별도 port, app identifier, 임시 테스트 데이터 경로를 사용해 현재 브랜치의 Tauri 앱을 새로 빌드하고 실행한다.

Expected: 현재 작업 브랜치 bundle을 사용하는 별도 앱 창이 열린다.

- [ ] **Step 2: 실제 사용자 경로 확인**

다음 순서로 확인한다.

1. 서브 페이지에 들어가 제목의 비편집 위치를 기록한다.
2. 제목을 클릭해 커서가 보이면서 글자 기준선, 크기, 굵기가 움직이지 않는지 확인한다.
3. 제목에서 Enter를 눌러 새 하위 항목을 만들고 Shift+Enter로 항목 노트를 연다.
4. 빈 항목 노트의 커서가 보이고 하단선이 없는지 확인한다.
5. 한글 설명을 입력하면서 비편집 14px/20px 표시와 같은 크기인지 확인한다.
6. 다른 곳을 클릭해 글자 위치와 크기가 바뀌지 않고 하단선도 없는지 확인한다.
7. 기존 Enter/Shift+Enter 및 선택 동작이 계속 동작하는지 확인한다.

- [ ] **Step 3: 동결된 diff의 프런트엔드 최종 gate를 한 번 실행**

Run:

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: 의도된 skip만 남고 모든 프런트엔드 테스트, ESLint, TypeScript/Vite build, diff whitespace 검사가 성공한다. Rust, IPC, persistence, native configuration을 변경하지 않았으므로 Cargo test, Rust formatting, Clippy는 실행하지 않는다.

- [ ] **Step 4: 최종 저장소 상태 검토**

Run:

```bash
git status --short --branch
git log --oneline --decorate -7
```

Expected: 의도한 두 구현 커밋만 계획 기준 커밋 위에 있고, 작업 트리에 임시 Vault 또는 screenshot 파일이 없으며, worktree가 깨끗하다.
