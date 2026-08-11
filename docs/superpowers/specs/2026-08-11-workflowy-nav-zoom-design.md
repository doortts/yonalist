# Workflowy식 네비게이션·줌 개편 설계 (2026-08-11)

시안: https://claude.ai/code/artifact/f1914f02-9012-4f8a-9d9c-48f4a66fecaa
대상: `apps/desktop` (React 아웃라인 표면)

## 계약

| 항목 | 내용 |
| --- | --- |
| 목표 | 사이드바 선택·우측 pane 표시·줌 레이아웃·커서를 Workflowy 개념에 맞춘다 |
| 비대상 | Starred/Recent/Tags/Archive/Trash의 검색 동작 변경, split pane 리사이즈, 데이터 모델·IPC, `src/` 구 표면 |
| 경계 | React 프론트엔드만. Rust/IPC/SQLite 변경 없음 |
| 수동 증명 | 브라우저 프리뷰(`previewApi`)에서 홈 뷰 진입 → 페이지 열기 → 두 단계 줌 → breadcrumb 복귀 → 블릿 드래그 커서 확인 |

## 완료 조건 (acceptance)

1. 블릿 hover 커서가 `pointer`, 포인터를 4px 이상 끌기 시작한 순간부터 놓을 때까지 `grabbing`. 클릭만 했을 때는 `grabbing`이 나타나지 않는다.
2. 줌 뷰에서 자식 행의 본문 텍스트 왼쪽 선이 제목 텍스트 왼쪽 선과 일치한다(기존 24px 추가 오프셋 제거). 제목 위에 여백이 생겨 상단 바에 붙지 않는다.
3. 사이드바에서 All을 누르면 우측 pane이 홈 아웃라인(모든 페이지가 최상위 블릿)으로 바뀌고, 페이지 강조가 풀린다. 페이지를 열면 All 강조가 풀린다. 두 강조가 동시에 켜지는 상태는 존재하지 않는다.
4. 홈 아웃라인의 페이지 블릿을 클릭하면 그 페이지가 열린다.
5. 우측 pane 상단 툴바에 breadcrumb(`⌂ › 페이지 › … › 현재 위치`)이 표시된다. 마지막 조각은 비활성, 나머지는 클릭으로 해당 단계 이동. ⌂ 클릭은 홈 아웃라인으로 이동.
6. 홈 ↔ 페이지 ↔ 줌 이동이 전부 undo/redo 히스토리에 기록되고 복원된다.
7. 게이트: `npm run test:v2:frontend`, `npm run lint:v2`, `npm run v2:build`, `git diff --check` 통과.

## 항목별 설계 (커밋 순서)

### ① 블릿 커서 — `fix(outline)`

- `notes.css` 1978행 `.notes-node-bullet[data-sortable-activator="true"]`의 `cursor: grab`을 `cursor: pointer`로, 이어지는 `:active { cursor: grabbing }` 규칙은 삭제.
- `useOutlineDrag.ts`: `gesture.dragging`이 처음 `true`가 되는 지점(`move`, 122행 근처)에서 `document.body.classList.add("is-outline-dragging")`, `finish`/`cancelActive`/`clearVisuals` 경로에서 제거. 기존 `body.is-resizing-pane` 패턴(styles.css 654행)을 따라 `notes.css`에 `body.is-outline-dragging, body.is-outline-dragging * { cursor: grabbing !important; }` 추가. 키보드 이동 gesture는 커서와 무관하므로 건드리지 않는다.
- 테스트: useOutlineDrag 소유 테스트에 pointerdown→4px 이동 시 body 클래스 부착, pointerup/pointercancel/blur 시 제거를 검증하는 케이스 추가. 클릭(이동 없음)만으로는 클래스가 붙지 않는 것도 검증.

### ② 줌 레이아웃 — `fix(outline)`

- `notes.css` 1200–1203행: `data-zoomed-page` 자식 오프셋 규칙 삭제, 452행 `--notes-page-child-offset` 변수도 사용처가 없어지면 삭제.
- 제목 위 여백: `.notes-outline-content`에 `padding-block-start: 32px` 추가(페이지 뷰·줌 뷰 공통 — 같은 렌더 경로).
- 정렬 검증 근거: 제목 행 grid 첫 컬럼 `--notes-content-offset: 74px` = 행 grid `--notes-menu-width(24)+20+18+gap(4×3)` = 74px. 오프셋 제거만으로 텍스트-텍스트 정렬이 맞는다.
- 테스트: CSS 전용이라 단위 테스트는 생략, 브라우저 프리뷰 캡처로 증명. `notes-page-child-offset` 잔여 참조가 없는지 grep으로 확인.

### ③ 홈 아웃라인 + 선택 상호 배타 — `feat(desktop)`

- `App.tsx`:
  - 상태 `const [homeOpen, setHomeOpen] = useState(false)` 추가.
  - `LibraryViewButtons`의 `active`에 `homeOpen ? libraryView : null` 전달 (`active` 타입을 `LibraryView | null`로 확장).
  - 라이브러리 뷰 클릭 → `setLibraryView(view); setHomeOpen(true)` + 네비게이션 기록(아래).
  - `openPage` 성공 경로에서 `setHomeOpen(false)`.
  - `LibraryPageRow`의 `active`는 `!homeOpen && page.id === state.activePageId`.
  - 네비게이션 인코딩: `AppNavigationLocation.pageId === null` = 홈. `captureNavigation`이 `homeOpen ? null : state.activePageId`를 기록하고, `applyNavigation`은 `location.pageId === null`이면 `setHomeOpen(true)`, 아니면 `setHomeOpen(false)` 후 기존 로직. 홈 진입은 `recordNavigation(before, emptyPaneLocation(null))`.
  - 렌더: `homeOpen && !settingsOpen`이면 `NotesDetailPanes` 대신 `HomeOutline` 렌더.
- `HomeOutline.tsx` (신규, 소형):
  - 상단 툴바(`.notes-outline-toolbar`)에 breadcrumb 슬롯 — ⌂ 하나, 비활성.
  - 본문: `state.pages`를 `.notes-node-main-readonly` + `.notes-node-readonly-title` 패턴(외부 아웃라인 재사용)으로 블릿 행 렌더. 블릿·행 클릭 → `openPage(page.id)`. 블릿 커서는 ①의 pointer 규칙을 그대로 따른다.
  - 편집·드래그·컴포저 없음(홈에서 페이지 생성은 사이드바 New page가 담당). 빈 상태 문구 “No pages yet.”.
- 테스트(App.test.tsx): (a) All 클릭 → 홈 아웃라인에 모든 페이지 타이틀 표시 + 페이지 행 `aria-pressed`/`data-active` 해제, (b) 홈에서 페이지 블릿 클릭 → 해당 아웃라인 표시 + All 강조 해제, (c) 홈 진입 후 undo → 이전 페이지 복귀, redo → 홈 복귀.

### ④ breadcrumb 툴바 — `feat(desktop)`

- `OutlineHeader.tsx`: 툴바 좌측 슬롯(“Notes” eyebrow / 뒤로가기 버튼)을 breadcrumb으로 교체.
  - 조각: `⌂` → `pageTitle` → 중간 조상들 → 현재 줌 노드. 줌 아닐 때는 `⌂ › pageTitle(비활성)`.
  - 조상 체인: `index`에서 `zoomRoot.parentId`를 따라 페이지 루트까지 역추적. 로드되지 않은 조상을 만나면 그 자리에서 끊고 비활성 `…` 조각을 삽입(뷰포트 페이지네이션 대비).
  - 새 props: `onHome: () => void`, `onZoomTo: (nodeId: string) => void`. `NotesOutline` → `NotesDetailPanes` → `App`으로 스레드. `onHome`은 ③의 홈 진입 함수(네비게이션 기록 포함), `onZoomTo`는 `onZoomRootChange`.
  - 선택 툴바(`selectionToolbar`)가 있을 때 breadcrumb 대신 선택 바가 뜨는 기존 동작 유지. Completed 토글·export·split 닫기 버튼은 우측 유지.
  - 각 조각은 `max-width` + ellipsis. 마지막 조각 `data-current="true"` 비활성.
- CSS: `notes.css`에 `.notes-breadcrumb`(flex, gap 4px), `.notes-breadcrumb-crumb`(text-button 변형, ellipsis), `.notes-breadcrumb-sep` 추가.
- 테스트: 두 단계 줌 후 breadcrumb 조각 순서·라벨, 중간 조각 클릭 시 `onZoomTo` 호출, ⌂ 클릭 시 `onHome` 호출, 줌 없을 때 페이지 조각 비활성.

### ⑤ 페이지 헤더를 본문 컬럼 안으로 — `fix(outline)` (스모크에서 발견된 보완)

②의 오프셋 제거만으로는 부족했다. 실측(dev 프리뷰, getBoundingClientRect) 결과 제목 텍스트는 본문 컬럼 기준 −34px, 행 텍스트는 +74px — 108px 어긋남. 원인: `<header class="notes-page-header">`가 `.notes-outline-rows > .notes-outline-content`(가운데 정렬 700px 컬럼, 스크롤 컨테이너) **밖**에서 pane 전폭으로 렌더되기 때문. 제목이 스크롤을 따라오지 않는 "상단에 붙어 동떨어진" 증상도 같은 원인.

- `OutlineHeader.tsx`: 툴바(+error)와 페이지 헤더를 분리. 페이지 헤더 블록을 별도 export 컴포넌트(예: `OutlinePageHeading`)로 추출 — props는 헤더가 쓰던 것만(store/target/nodes/visibleNodes/index/visibleIndex/onBack/onTagClick/imageDropTarget/onPickImage + menu).
- `NotesOutline.tsx`: 툴바는 지금 자리 유지(스크롤 밖, breadcrumb 바). `OutlinePageHeading`을 `.notes-outline-content`의 첫 자식으로 이동 — 제목이 본문과 같은 컬럼에서 함께 스크롤된다. `useOutlineWindow`의 `listOffset`은 스크롤러 기준 상대 좌표라 리스트 위 콘텐츠 추가에 안전함(확인 완료).
- 완료 조건: 본문 컬럼 기준 제목 텍스트 left == 행(depth 0) 텍스트 left == 74px. 스크롤 시 제목은 본문과 함께 올라가고 breadcrumb 툴바만 남는다. 페이지 헤더 메뉴 버튼은 행 메뉴 컬럼(0–24px)과 정렬.
- 회귀 가드: 소유 테스트에 `.notes-outline-content`가 `.notes-page-header`를 포함한다는 DOM 포함 관계 assertion 1건.

## 실행 체제

Opus 4.8 xHigh 단일 에이전트가 ①→④ 순차 구현(공유 파일 다수), 항목당 1커밋. 각 항목 TDD: 실패 테스트 먼저(red 증거) → 구현 → green. 항목 완료마다 Fable이 diff 적대 리뷰 후 다음 항목 진행. 마지막에 게이트 일괄 1회 + 브라우저 프리뷰 스모크.
