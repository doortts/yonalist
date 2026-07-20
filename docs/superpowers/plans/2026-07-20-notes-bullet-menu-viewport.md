# 블릿 메뉴 화면 경계 처리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 화면 공간이 부족한 위치에서 블릿 메뉴를 열어도 팝업이 화면 안에 유지되고 내부 스크롤로 모든 명령에 접근할 수 있게 한다.

**Architecture:** Base UI `Menu.Positioner`가 계산해 Popup에 상속하는 `--available-height`를 `.notes-bullet-menu`의 최대 높이에 사용한다. 기존 520px 상한과 `overflow-y: auto`는 유지하고 위치 계산, 메뉴 상태, 명령 구성은 변경하지 않는다.

**Tech Stack:** React 19, Base UI Menu, CSS, Vitest, Testing Library, Tauri 2

## Global Constraints

- 232px 기본 폭과 단축키가 있는 메뉴의 260px 폭을 유지한다.
- 메뉴 명령, 단축키 매핑, 키보드 동작을 변경하지 않는다.
- IPC, Rust, SQLite, Undo/Redo를 변경하지 않는다.
- 공간이 부족하면 마우스 휠과 트랙패드로 첫 명령부터 마지막 명령까지 접근할 수 있어야 한다.

---

### Task 1: 위치별 가용 높이를 사용하는 블릿 메뉴

**Files:**
- Modify: `src/features/notes/NotesBulletMenu.test.tsx:183-191`
- Modify: `src/features/notes/notes.css:1592-1605`

**Interfaces:**
- Consumes: Base UI `Menu.Positioner`가 제공하는 상속 CSS 변수 `--available-height`
- Produces: `.notes-bullet-menu`의 위치별 최대 높이와 기존 내부 스크롤 동작

- [ ] **Step 1: 가용 높이와 내부 스크롤을 요구하는 실패 테스트 작성**

`NotesBulletMenu.test.tsx`의 CSS 계약 테스트를 다음처럼 확장한다.

```tsx
it("fits the menu to the positioned space and scrolls overflow internally", () => {
  expect(notesStyles).toMatch(
    /\.notes-bullet-menu\s*\{[^}]*max-height:\s*min\(520px, var\(--available-height\)\);[^}]*overflow-y:\s*auto;/u
  );
});
```

- [ ] **Step 2: 테스트가 현재 뷰포트 기반 구현 때문에 실패하는지 확인**

Run: `npm test -- src/features/notes/NotesBulletMenu.test.tsx`

Expected: 새 테스트가 `calc(100vh - 16px)` 때문에 실패하며 기존 테스트는 통과한다.

- [ ] **Step 3: Base UI가 계산한 가용 높이를 사용하는 최소 CSS 수정**

`notes.css`의 `.notes-bullet-menu` 규칙을 다음처럼 변경한다.

```css
.notes-bullet-menu {
  max-height: min(520px, var(--available-height));
  overflow-y: auto;
}
```

나머지 기존 속성과 메뉴 폭 규칙은 그대로 둔다.

- [ ] **Step 4: 소유 테스트를 다시 실행해 통과 확인**

Run: `npm test -- src/features/notes/NotesBulletMenu.test.tsx`

Expected: 해당 파일의 모든 테스트가 통과한다.

- [ ] **Step 5: 격리된 실제 앱에서 잘림과 스크롤 확인**

별도 포트와 별도 HOME/Cargo target으로 Tauri 앱을 시작한다. 창 높이를 줄이고 화면 하단 블릿에서 메뉴를 연 뒤 다음을 확인한다.

```text
- 팝업 상단과 하단이 앱 화면 안에 있다.
- 메뉴 높이가 가용 공간에 맞게 줄어든다.
- 마우스 휠 또는 트랙패드로 Complete부터 Delete/타임스탬프까지 이동할 수 있다.
- 단축키 열과 260px 폭이 유지된다.
```

- [ ] **Step 6: 프런트엔드 최종 게이트 실행**

Run:

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: 모든 명령이 성공한다. Rust, IPC, 저장소, 네이티브 설정은 변경하지 않았으므로 Cargo 테스트와 Clippy는 실행하지 않는다.

- [ ] **Step 7: 구현 커밋**

```bash
git add src/features/notes/NotesBulletMenu.test.tsx src/features/notes/notes.css
git commit -m "fix(notes): keep bullet menu within viewport"
```
