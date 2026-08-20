# Top Menu Buttons Tooltips Design Doc

- 작성일: 2026-08-21
- 상위 규칙: `.agents/skills/fable-opus-loop/SKILL.md`, `.agents/skills/delivering-yonalist-changes/SKILL.md`

## 1. Goal & Acceptance

### Goal
상단 툴바 및 메뉴 버튼(Export, Completed items 토글, Detail 최대화/복원, 사이드바 토글, 분할 창 닫기, 홈 브레드크럼 등)에 직관적인 툴팁(`title` 속성)을 제공하여 버튼 기능과 현재 상태를 명확히 안내한다.

### Acceptance Criteria

| ID | Acceptance Row | Test |
| :--- | :--- | :--- |
| **AC-1** | `NotesExportMenu` 트리거 버튼에 `title="Export"` 속성이 렌더링된다. | `src/NotesExportMenu.test.tsx` |
| **AC-2** | `OutlineHeader`의 완료 항목 토글 버튼에 상태에 따라 `title="Hide completed items"` 또는 `title="Show completed items"` 속성이 렌더링된다. | `src/App.test.tsx` |
| **AC-3** | `WindowChrome`의 detail 최대화 버튼에 상태에 따라 `title="Restore detail"` 또는 `title="Maximize detail"` 속성이 렌더링된다. | `src/WindowChrome.test.tsx` |
| **AC-4** | `WindowChrome`의 사이드바 토글 버튼에 상태에 따라 `title="Expand sidebar"` 또는 `title="Collapse sidebar"` 속성이 렌더링된다. | `src/WindowChrome.test.tsx` |
| **AC-5** | `OutlineHeader`의 스플릿 닫기 버튼에 `title="Close split"`, 브레드크럼 홈 버튼에 `title="All pages"` 속성이 렌더링된다. | `src/App.test.tsx` |

### Touched Files
- `apps/desktop/src/WindowChrome.tsx`
- `apps/desktop/src/NotesExportMenu.tsx`
- `apps/desktop/src/outline/OutlineHeader.tsx`
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/WindowChrome.test.tsx`
- `apps/desktop/src/NotesExportMenu.test.tsx`
- `apps/desktop/src/App.test.tsx`

---

## 2. Item List & TDD Test Design

### Item 1: Top Navigation & WindowChrome Tooltips
- **담당 Acceptance**: AC-3, AC-4
- **테스트**: `src/WindowChrome.test.tsx`
- **구현**: `WindowChrome.tsx`

### Item 2: Outline Header & Export Menu Tooltips
- **담당 Acceptance**: AC-1, AC-2, AC-5
- **테스트**: `src/NotesExportMenu.test.tsx`, `src/App.test.tsx`
- **구현**: `NotesExportMenu.tsx`, `OutlineHeader.tsx`, `App.tsx`
