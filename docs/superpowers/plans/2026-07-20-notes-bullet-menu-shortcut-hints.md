# Notes Bullet Menu Shortcut Hints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 블릿 메뉴에서 실제 지원되는 키보드 단축키를 메뉴 이름 오른쪽에 플랫폼별로 표시한다.

**Architecture:** `NotesBulletMenu`가 기존 `detectOutlineShortcutPlatform`을 사용해 화면용 문자열과 접근성용 키 조합을 생성한다. 공통 `CommandItem`이 선택적인 단축키를 세 번째 grid 열에 렌더링하되 화면 문자열은 접근성 이름에서 제외하고 `aria-keyshortcuts`로 의미를 제공한다.

**Tech Stack:** React 19, TypeScript, Base UI Menu, CSS Grid, Vitest, Testing Library

## Global Constraints

- 기존 키보드 처리와 정확히 일치하는 명령에만 단축키를 표시한다.
- macOS에서는 `⌘`, `⇧`, `⌫`, `↵`, `↑`, `↓` 기호를 사용하고 그 외 플랫폼에서는 `Ctrl`, `Alt`, `Shift`, `Enter`, `Backspace`, `ArrowUp`, `ArrowDown` 이름을 사용한다.
- 기존 메뉴 접근성 이름은 바꾸지 않고 각 단축키 명령에 표준 `aria-keyshortcuts`를 제공한다.
- 비활성 명령에도 단축키를 표시한다.
- 새로운 단축키를 만들거나 기존 키보드 동작을 변경하지 않는다.
- IPC, Rust, SQLite, 파일시스템, 네이티브 설정은 변경하지 않는다.

---

### Task 1: 플랫폼별 블릿 메뉴 단축키 표시

**Files:**
- Modify: `src/features/notes/NotesBulletMenu.tsx:1-190,540-960`
- Modify: `src/features/notes/notes.css:1607-1640`
- Test: `src/features/notes/NotesBulletMenu.test.tsx`

**Interfaces:**
- Consumes: `detectOutlineShortcutPlatform(): "mac" | "other"`, 기존 `CommandItem`, 일반 메뉴와 다중 선택 메뉴의 실제 명령 목록
- Produces: `MenuShortcut { visible: string; aria: string }`, 플랫폼별 단축키 map, 선택적인 `CommandItemProps.shortcut`

- [ ] **Step 1: 실패하는 메뉴 표시 테스트 작성**

`NotesBulletMenu.test.tsx`에 테스트 종료 후 플랫폼 mock을 복구하는
`afterEach(() => vi.restoreAllMocks())`를 추가한다. macOS 일반 메뉴 테스트에서
`navigator.platform`을 `MacIntel`로 mock하고 다음 계약을 검증한다.

```tsx
const complete = within(menu).getByRole("menuitem", { name: "Complete" });
expect(complete).toHaveAttribute("aria-keyshortcuts", "Meta+Enter");
expect(within(complete).getByText("⌘↵")).toHaveAttribute("aria-hidden", "true");

const addNote = within(menu).getByRole("menuitem", { name: "Add note" });
expect(addNote).toHaveAttribute("aria-keyshortcuts", "Shift+Enter");
expect(within(addNote).getByText("⇧↵")).toBeVisible();

expect(within(menu).getByRole("menuitem", { name: "Duplicate" }))
  .toHaveAttribute("aria-keyshortcuts", "Meta+Shift+D");
expect(within(menu).getByRole("menuitem", { name: "Delete" }))
  .toHaveAttribute("aria-keyshortcuts", "Meta+Shift+Backspace");
expect(within(menu).getByRole("menuitem", { name: "Star" }))
  .not.toHaveAttribute("aria-keyshortcuts");
```

다중 선택 메뉴에서는 Move up/down, Indent/Outdent, Copy/Cut을 포함한 모든
지원 단축키를 같은 방식으로 검증한다. 비-macOS 테스트에서는 `Win32`로 mock해
Complete가 `Ctrl+Enter` / `Control+Enter`, Duplicate가
`Alt+Shift+D`로 표시되는지 확인한다.

메뉴 목록 순서 테스트는 각 항목의 첫 번째 직접 자식 `span`에서 이름을 읽는
helper를 사용하도록 바꿔 단축키 표시 문자열을 명령 이름과 분리한다.

- [ ] **Step 2: 테스트가 올바른 이유로 실패하는지 확인**

Run:

```bash
npx vitest run src/features/notes/NotesBulletMenu.test.tsx
```

Expected: 단축키 표시 요소와 `aria-keyshortcuts`가 아직 없어 새 테스트가 실패한다.

- [ ] **Step 3: 최소 단축키 표시 구현**

`NotesBulletMenu.tsx`에서 `detectOutlineShortcutPlatform`을 import하고 다음 형태의
내부 자료 구조와 빌더를 추가한다.

```tsx
interface MenuShortcut {
  readonly visible: string;
  readonly aria: string;
}

interface NotesBulletMenuShortcuts {
  readonly toggleComplete: MenuShortcut;
  readonly focusNote: MenuShortcut;
  readonly duplicate: MenuShortcut;
  readonly delete: MenuShortcut;
  readonly moveUp: MenuShortcut;
  readonly moveDown: MenuShortcut;
  readonly indent: MenuShortcut;
  readonly outdent: MenuShortcut;
  readonly copy: MenuShortcut;
  readonly cut: MenuShortcut;
}
```

빌더는 완료 조건의 macOS/비-macOS 문자열과 다음 표준 접근성 값을 반환한다.

```text
Meta+Enter / Control+Enter
Shift+Enter
Meta+Shift+D / Alt+Shift+D
Meta+Shift+Backspace / Control+Shift+Backspace
Meta+Shift+ArrowUp / Control+Shift+ArrowUp
Meta+Shift+ArrowDown / Control+Shift+ArrowDown
Tab
Shift+Tab
Meta+C / Control+C
Meta+X / Control+X
```

`CommandItemProps`에 `shortcut?: MenuShortcut`을 추가하고 `Menu.Item`에는
`aria-keyshortcuts={shortcut?.aria}`를, 이름 뒤에는 다음 요소를 렌더링한다.

```tsx
{shortcut && (
  <span className="notes-bullet-menu-shortcut" aria-hidden="true">
    {shortcut.visible}
  </span>
)}
```

컴포넌트는 현재 플랫폼용 map을 한 번 계산해 일반 메뉴의 Complete/Uncomplete,
Add/Edit note, Duplicate, Delete와 다중 선택 메뉴의 Complete/Uncomplete,
Move up/down, Indent/Outdent, Duplicate, Copy/Cut, Delete에 전달한다.

- [ ] **Step 4: 단축키 열 스타일 추가**

`notes.css`에 다음 스타일을 추가한다.

```css
.notes-bullet-menu-shortcut {
  grid-column: 3;
  justify-self: end;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}

.notes-bullet-menu-item[data-highlighted] .notes-bullet-menu-shortcut {
  color: inherit;
}
```

- [ ] **Step 5: 소유 테스트 확인**

Run:

```bash
npx vitest run src/features/notes/NotesBulletMenu.test.tsx
```

Expected: 기존 메뉴 동작 테스트와 새 플랫폼별 단축키 테스트가 모두 통과한다.

- [ ] **Step 6: 사용자 화면과 최종 게이트 확인**

격리된 임시 HOME과 고유 개발 포트로 Tauri 앱을 실행한다. 일반 블릿 메뉴와
다중 선택 메뉴에서 단축키가 오른쪽에 정렬되고 항목 이름과 겹치지 않는지 확인한다.

Run:

```bash
npm test
npm run lint
npm run build
git diff --check main...HEAD
```

Expected: 모든 프론트엔드 게이트가 통과한다. Rust, IPC, persistence, native config가
변경되지 않았으므로 Cargo test, rustfmt, Clippy는 실행하지 않는다.

- [ ] **Step 7: 구현 커밋**

```bash
git add src/features/notes/NotesBulletMenu.tsx src/features/notes/NotesBulletMenu.test.tsx src/features/notes/notes.css
git commit -m "feat(notes): show bullet menu shortcuts"
```
