# Bullet Fold / Expand Shortcuts Design Doc

- 작성일: 2026-08-21
- 상위 규칙: `.agents/skills/fable-opus-loop/SKILL.md`, `.agents/skills/delivering-yonalist-changes/SKILL.md`

## 1. Goal & Acceptance

### Goal
블릿 접기(Collapse/Fold) 및 펼치기(Expand/Unfold) 단축키를 Workflowy/Logseq 표준(`Cmd + ↑` / `Cmd + ↓`) 및 에디터 표준 별칭(`Cmd + Option + [` / `]`)으로 구현하고, 단일 노드 및 다중 선택 밴드에서 일관되게 동작하도록 한다.

### Acceptance Criteria

| ID | Acceptance Row | Test |
| :--- | :--- | :--- |
| **AC-1** | `Cmd + ArrowUp` (Mac) 및 `Ctrl + ArrowUp` (Other)가 노드에서 `{ kind: "setCollapsed", collapsed: true }`로 해석된다. | `src/outline/outlineKeyboard.test.ts` |
| **AC-2** | `Cmd + ArrowDown` (Mac) 및 `Ctrl + ArrowDown` (Other)가 노드에서 `{ kind: "setCollapsed", collapsed: false }`로 해석된다. | `src/outline/outlineKeyboard.test.ts` |
| **AC-3** | 별칭 단축키 `Cmd + Option + [` (Mac) / `Ctrl + Alt + [` (Other)는 `{ kind: "setCollapsed", collapsed: true }`로, `Cmd + Option + ]` (Mac) / `Ctrl + Alt + ]` (Other)는 `{ kind: "setCollapsed", collapsed: false }`로 해석된다. | `src/outline/outlineKeyboard.test.ts` |
| **AC-4** | 키 반복(repeat) 시 `{ kind: "consume" }`을 반환하여 과도한 중복 실행을 막고, 페이지 제목 대상일 때는 접기/펼치기가 무시된다. | `src/outline/outlineKeyboard.test.ts` |
| **AC-5** | 단일 노드에서 `setCollapsed` 인텐트 발생 시 `store.setCollapsed(node.id, collapsed)`를 호출하여 상태를 변경한다. | `src/outline/outlineSupport.test.tsx` |
| **AC-6** | 다중 선택(Selection Band) 상태에서 `setCollapsed` 인텐트 발생 시 `store.setCollapsedMany`를 통해 선택된 모든 노드의 접힘 상태를 일괄 변경한다. | `src/outline/outlineSupport.test.tsx`, `src/App.test.tsx` |

### Non-Goals
- 사용자 지정 커스텀 단축키 설정 UI
- 아웃라인 외 영역(검색창, 설정 등)에서의 폴딩 동작

### Touched Boundaries
- Frontend UI / Keyboard Event Pipeline:
  - `apps/desktop/src/outline/outlineKeyboard.ts`
  - `apps/desktop/src/outline/outlineSupport.ts`
  - `apps/desktop/src/NotesOutline.tsx`
- Store:
  - `apps/desktop/src/notesStore.ts` (`setCollapsed`, `setCollapsedMany` 기존 API 활용)

---

## 2. Item List & TDD Test Design

### Item 1: Keyboard Resolver & Intent (`outlineKeyboard.ts`)
- **담당 Acceptance**: AC-1, AC-2, AC-3, AC-4
- **테스트**: `src/outline/outlineKeyboard.test.ts`
  - Mac / Non-Mac 환경에서의 `Cmd/Ctrl + ArrowUp/ArrowDown` 해석 검증
  - Mac / Non-Mac 환경에서의 `Cmd/Ctrl + Alt + [/]` 해석 검증
  - `repeat` 시 `{ kind: "consume" }` 검증
  - `target === "page"` 일 때 무시 또는 no-op 검증
  - 기존 `Cmd + ArrowUp/ArrowDown` 문서 점프 관련 기존 테스트 업데이트
- **구현**:
  - `OutlineKeyIntent`에 `{ readonly kind: "setCollapsed"; readonly collapsed: boolean }` 추가
  - `resolveOutlineKey`에서 접기/펼치기 조합 해석 로직 추가

### Item 2: Execution Wiring for Single & Multi-Selection (`outlineSupport.ts`, `NotesOutline.tsx`)
- **담당 Acceptance**: AC-5, AC-6
- **테스트**: `src/outline/outlineSupport.test.tsx`, `src/App.test.tsx`
  - `handleOutlineKeyDown`에서 단일 노드일 때 `store.setCollapsed` 호출 검증
  - `handleOutlineKeyDown`에서 다중 선택 밴드 활성 시 `selectionActions.setCollapsed` 및 `store.setCollapsedMany` 호출 검증
  - `handleImagePrimaryKeyDown`에서도 동일하게 동작 검증
- **구현**:
  - `SelectionKeyboardActions`에 `setCollapsed: (collapsed: boolean) => void` 추가
  - `handleOutlineKeyDown`, `handleImagePrimaryKeyDown`에서 `intent.kind === "setCollapsed"` 라우팅
  - `executeRowIntent`에 `case "setCollapsed"` 추가
  - `NotesOutline.tsx`의 `selectionActions`에 `setCollapsed` 구현
