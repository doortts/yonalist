# Zoom Status Bar Stepper Controller (Option D) Design Doc

- 작성일: 2026-08-21
- 상위 규칙: `.agents/skills/fable-opus-loop/SKILL.md`, `.agents/skills/delivering-yonalist-changes/SKILL.md`

## 1. Goal & Acceptance

### Goal
하단 상태바(`app-statusbar`)에 현재 페이지의 Zoom 레벨(`100%`, `110%` 등)을 항상(상시) 표시하고, `[-]` `[ 100% ]` `[+]` 스텝 컨트롤러(Option D)를 통해 직관적으로 줌을 조절 및 리셋할 수 있도록 구현합니다.

### Acceptance Criteria

| ID | Acceptance Row | Test |
| :--- | :--- | :--- |
| **AC-1** | `pageZoom.ts`에서 상태 변경 리스너 구독(`subscribePageZoom`, `getPageZoom`, `resetPageZoom`, `usePageZoom`) 지원 | `src/pageZoom.test.ts` |
| **AC-2** | 상태바 우측 `statusbar-actions`에 `[-]` `[ {zoom}% ]` `[+]` 상시 표시 | `src/App.test.tsx` |
| **AC-3** | `[-]` 클릭 시 5% 축소, `[+]` 클릭 시 5% 확대, 범위(50%~300%) 도달 시 disabled 처리 | `src/App.test.tsx`, `src/pageZoom.test.ts` |
| **AC-4** | 100%가 아닐 때 중앙 `{zoom}%` 버튼 호버 시 `Reset zoom to 100%` 툴팁 노출 및 클릭 시 100% 리셋 | `src/App.test.tsx` |
| **AC-5** | `Cmd+=` / `Cmd+-` 키보드 단축키로 조절 시에도 상태바 수치가 실시간 동기화 | `src/App.test.tsx` |

### Touched Files
- `apps/desktop/src/pageZoom.ts`
- `apps/desktop/src/pageZoom.test.ts`
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/App.test.tsx`
- `apps/desktop/src/styles.css`
