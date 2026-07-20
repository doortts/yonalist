# Empty Bullet Without Untitled Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 빈 일반 텍스트 블릿에서 `Untitled` placeholder를 제거한다.

**Architecture:** 일반 블릿을 렌더링하는 `OutlineNodeRow`에서만 placeholder 전달을 중단한다. 공통 `NoteTextField`, 페이지 제목, 탐색·메뉴용 빈 제목 label은 그대로 둔다.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library

## Global Constraints

- 편집 전과 편집 중 모두 빈 일반 블릿에 `Untitled`이 보이지 않아야 한다.
- textarea의 값은 빈 문자열이고 접근성 이름은 `Edit node title`이어야 한다.
- 페이지 제목·페이지 목록·breadcrumb·검색·이동 대상·드래그 미리보기의 빈 제목 fallback은 변경하지 않는다.
- IPC, Rust, SQLite, 파일시스템, 네이티브 설정은 변경하지 않는다.

---

### Task 1: 일반 블릿 placeholder 제거

**Files:**
- Modify: `src/features/notes/OutlineNodeRow.tsx:1521-1530`
- Test: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: `OutlineNodeRow`의 일반 텍스트 블릿용 `NoteTextField`와 기존 `configureRepository`, `renderNotesWorkspace`, `findTitleInput` 테스트 helper
- Produces: 빈 일반 블릿의 placeholder 없는 제목 편집기

- [ ] **Step 1: 실패하는 workspace 렌더 테스트 작성**

```tsx
it("renders an empty bullet without an Untitled placeholder", async () => {
  configureRepository([
    node({ id: "project", title: "Project" }),
    node({ id: "empty", parentId: "project", sortKey: 1, title: "" })
  ]);
  renderNotesWorkspace();

  const input = await findTitleInput("");
  const row = input.closest<HTMLElement>(".notes-node");
  expect(row).not.toBeNull();
  expect(within(row!).queryByText("Untitled")).not.toBeInTheDocument();
  expect(input).not.toHaveAttribute("placeholder");
  expect(input).toHaveValue("");
  expect(input).toHaveAccessibleName("Edit node title");
});
```

- [ ] **Step 2: 테스트가 올바른 이유로 실패하는지 확인**

Run:

```bash
npx vitest run src/features/notes/NotesWorkspace.test.tsx -t "renders an empty bullet without an Untitled placeholder"
```

Expected: `placeholder="Untitled"` 때문에 `not.toHaveAttribute("placeholder")`가 실패한다.

- [ ] **Step 3: 일반 블릿의 placeholder 전달만 제거**

`src/features/notes/OutlineNodeRow.tsx`의 일반 텍스트 블릿 `NoteTextField`에서 다음 prop을 삭제한다.

```tsx
placeholder="Untitled"
```

- [ ] **Step 4: focused 및 owning 테스트 확인**

Run:

```bash
npx vitest run src/features/notes/NotesWorkspace.test.tsx -t "renders an empty bullet without an Untitled placeholder"
npx vitest run src/features/notes/NotesWorkspace.test.tsx src/features/notes/NoteTextField.test.tsx
```

Expected: focused 테스트 1개와 두 소유 테스트 파일이 모두 통과한다.

- [ ] **Step 5: 사용자 화면과 최종 게이트 확인**

격리된 임시 HOME과 고유 개발 포트로 Tauri 앱을 실행한다. 기존 루트 아래 새 빈
블릿을 만들고 `Untitled`이 나타나지 않으며 제목 입력 커서가 유지되는지 확인한다.

Run:

```bash
npm test
npm run lint
npm run build
git diff --check main...HEAD
```

Expected: 모든 프론트엔드 게이트가 통과한다. Rust, IPC, persistence, native config가
변경되지 않았으므로 Cargo test, rustfmt, Clippy는 실행하지 않는다.

- [ ] **Step 6: 구현 커밋**

```bash
git add src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "fix(notes): hide placeholder for empty bullets"
```
