# Notes Tab 경계 포커스 유지 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 구조적으로 들여쓰기 또는 내어쓰기를 할 수 없는 제목에서 Tab/Shift+Tab을 눌러도 현재 포커스를 유지한다.

**Architecture:** `outlineKeyboard.ts`가 인식된 Tab no-op을 `consumeTabShortcut`으로 반환한다. 일반 행과 페이지 헤더는 이 결과의 기본 이벤트만 취소하고 구조 명령은 실행하지 않는다.

**Tech Stack:** React 19, TypeScript 6, Vitest 4, Testing Library, Vite 8, Tauri 2

## Global Constraints

- 유효한 Tab/Shift+Tab 구조 이동은 유지한다.
- 설명 textarea와 이미지 내부 컨트롤의 native Tab 이동은 유지한다.
- 선택 범위 명령, Undo/Redo, IPC, Rust, SQLite 및 native configuration은 변경하지 않는다.
- 구현 전에 회귀 테스트의 RED를 확인한다.

---

### Task 1: 인식된 Tab no-op을 키 해석 계약에 추가

**Files:**
- Modify: `src/features/notes/outlineKeyboard.ts`
- Test: `src/features/notes/outlineKeyboard.test.ts`

**Interfaces:**
- Consumes: `ResolveOutlineKeyInput`의 target, key, modifier, repeat, node 및 zoom 상태
- Produces: `OutlineKeyResolution`의 `{ type: "consumeTabShortcut" }`

- [ ] **Step 1: 경계와 반복 Tab의 실패 테스트를 작성한다**

첫 형제의 `Tab`, 루트와 줌 경계의 `Shift+Tab`, 반복 `Tab`이
`{ type: "consumeTabShortcut" }`을 반환한다고 기대한다. Alt+Arrow 경계와
IME 입력은 계속 `null`이어야 한다.

- [ ] **Step 2: 키 해석 테스트가 기존 `null` 결과 때문에 실패하는지 확인한다**

Run: `npx vitest run src/features/notes/outlineKeyboard.test.ts`

Expected: 새 경계 assertion이 `null`을 받아 FAIL.

- [ ] **Step 3: 최소 키 해석을 구현한다**

`OutlineKeyResolution`에 consume 결과를 추가하고, 실제 `Tab`인 경우에만 반복
및 구조 경계에서 이 결과를 반환한다. 이미지 전용 Alt+Arrow 경계는 기존처럼
`null`을 유지한다.

- [ ] **Step 4: 키 해석 소유 테스트를 통과시킨다**

Run: `npx vitest run src/features/notes/outlineKeyboard.test.ts`

Expected: PASS, 0 failures.

### Task 2: 일반 행과 페이지 헤더가 no-op Tab을 소비

**Files:**
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPageHeader.tsx`
- Test: `src/features/notes/NotesWorkspace.test.tsx`
- Test: `src/features/notes/NotesPageHeader.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `{ type: "consumeTabShortcut" }`
- Produces: 취소된 DOM keydown과 유지된 제목 포커스

- [ ] **Step 1: 일반 행과 페이지 헤더의 실패 테스트를 작성한다**

경계 제목에 포커스를 둔 뒤 `fireEvent.keyDown` 반환값이 `false`이고,
`moveNode`가 호출되지 않으며 같은 제목에 포커스가 남는다고 검증한다. 설명
textarea의 Tab이 native로 남는 기존 계약도 함께 실행한다.

- [ ] **Step 2: 컴포넌트 테스트가 이벤트 미취소로 실패하는지 확인한다**

Run: `npx vitest run src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesWorkspace.test.tsx -t "Tab boundary"`

Expected: `fireEvent.keyDown(...)`이 `true`여서 FAIL.

- [ ] **Step 3: 두 제목 핸들러에 consume 분기를 연결한다**

일반 행 switch와 페이지 헤더 허용 목록/switch에 `consumeTabShortcut`을 추가해
`preventDefault()` 이후 명령 없이 반환한다. 이미지 핸들러의 exhaustive switch도
no-op 분기를 추가한다.

- [ ] **Step 4: 소유 테스트와 Notes 키보드 테스트를 통과시킨다**

Run: `npx vitest run src/features/notes/outlineKeyboard.test.ts src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesWorkspace.test.tsx`

Expected: PASS, 0 failures.

### Task 3: 사용자 흐름 및 최종 게이트 검증

**Files:**
- Verify only

**Interfaces:**
- Consumes: 완성된 프런트엔드 변경
- Produces: 새 앱 직접 확인과 최종 게이트 증거

- [ ] **Step 1: 격리된 새 Tauri 앱에서 경계와 유효 이동을 확인한다**

첫 형제 Tab, 루트/줌 경계 Shift+Tab에서 포커스가 유지되고, 가능한 형제의
Tab/Shift+Tab은 기존처럼 구조를 이동하는지 확인한다.

검증 앱은 `mktemp -d /tmp/yonalist-tab-boundary.XXXXXX`로 만든 임시 HOME과
별도 product name, bundle identifier, 개발 포트(1425)를 사용한다. 실행 후 새
프로세스와 포트가 기존 앱과 분리되어 있고, 새 프로세스가 연 데이터베이스 파일이
임시 HOME 아래의 `Yonalist/.yonalist`에만 있는지 확인한 다음 조작한다. 검증이
끝나면 새 개발 스택만 종료하고 임시 Vault와 캡처를 휴지통으로 옮긴다.

- [ ] **Step 2: 최종 프런트엔드 게이트를 한 번 실행한다**

Run: `npm test && npm run lint && npm run build && git diff --check`

Expected: 모두 exit 0. Rust, IPC, persistence 및 native configuration이 바뀌지
않으므로 Cargo 테스트, rustfmt, Clippy는 생략한다.

- [ ] **Step 3: 최종 diff를 검토하고 main에 안전하게 병합한다**

작업 브랜치를 로컬 `main`에 fast-forward 병합하고 병합 결과 테스트를 확인한
뒤 이 작업에서 만든 워크트리와 브랜치만 정리한다. 원격 push는 하지 않는다.
