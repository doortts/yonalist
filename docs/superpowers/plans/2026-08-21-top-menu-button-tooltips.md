# Instant Tooltips for Header & Action Buttons Design Doc

- 작성일: 2026-08-21
- 상위 규칙: `.agents/skills/fable-opus-loop/SKILL.md`, `.agents/skills/delivering-yonalist-changes/SKILL.md`

## 1. Goal & Acceptance

### Goal
1. 브라우저/OS의 기본 1초 hover 딜레이 없이 마우스 커서가 올라가면 즉시(0ms) 표시되는 CSS 기반 즉각 툴팁(`data-tooltip`) 시스템 구현
2. 스크린샷의 상단 Export 아이콘(`NotesExportBoundary.tsx`의 `ExportTrigger` 및 `NotesExportMenu.tsx`)에 `"Export as"` 툴팁 및 aria-label 적용
3. 상단 툴바 및 메뉴 버튼(Export as, Completed items, Maximize detail, Sidebar toggle, Home, Split close, Search, New page, Settings, Selection actions)에 즉각 툴팁 일괄 적용

### Acceptance Criteria

| ID | Acceptance Row | Test |
| :--- | :--- | :--- |
| **AC-1** | `NotesExportBoundary`의 `ExportTrigger` 및 `NotesExportMenu` 버튼에 `data-tooltip="Export as"`, `title="Export as"`, `aria-label="Export as"` 적용 | `src/NotesExportMenu.test.tsx`, `src/App.test.tsx` |
| **AC-2** | `OutlineHeader`의 완료 항목 토글 버튼에 상태별 `data-tooltip="Hide completed items"` / `data-tooltip="Show completed items"` 적용 | `src/App.test.tsx` |
| **AC-3** | `WindowChrome`의 detail 최대화 및 사이드바 토글 버튼에 `data-tooltip` 적용 (`data-tooltip-align="right"` 지원) | `src/WindowChrome.test.tsx` |
| **AC-4** | CSS `[data-tooltip]` 스타일을 추가하여 마우스 호버 시 딜레이 없이 즉시 툴팁 팝업이 표시되고, 팝업 메뉴 오픈 시 툴팁이 가려지도록 처리 | `src/styles.css` |

### Touched Files
- `apps/desktop/src/styles.css`
- `apps/desktop/src/NotesExportBoundary.tsx`
- `apps/desktop/src/NotesExportMenu.tsx`
- `apps/desktop/src/outline/OutlineHeader.tsx`
- `apps/desktop/src/WindowChrome.tsx`
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/SelectionActionBar.tsx`
- `apps/desktop/src/NotesExportMenu.test.tsx`
- `apps/desktop/src/WindowChrome.test.tsx`
- `apps/desktop/src/App.test.tsx`
- `apps/desktop/src/splitPaneIntegration.test.tsx`
