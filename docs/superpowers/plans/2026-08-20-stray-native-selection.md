# 빈 곳에서 시작한 드래그가 네이티브 선택을 남기지 않는다

작성 2026-08-20. Fable 5 설계. 사용자가 재현하고 스크린샷으로 확인한 버그다.

## 무슨 일이 일어나는가

마지막 불릿 아래 빈 공간에서 마우스 드래그를 시작하면 WKWebView의 문서 텍스트
선택이 그대로 시작된다. 앵커와 포인터 사이의 DOM 전체가 선택되어 아웃라인 행이
통째로 파란 띠로 칠해지고, 사이드바(워드마크, New page, 페이지 목록, Settings)까지
같이 칠해진다. 이 range는 pointerup 뒤에도 살아남는다. 나중에 행을 클릭해 편집에
들어가면 그 행의 textarea는 글리프를 투명하게 그리므로, 뒤에 남아 있던 range가
행 전체 폭의 유령 배경으로 비쳐 보인다.

## 지금 코드가 이미 하는 일 (원인 확인)

- `apps/desktop/src/outline/useOutlinePointerSelection.ts:86` —
  `onPointerDownCapture`는 pointerdown 대상이 `[data-outline-id]` 행 안의
  `isTextSurface(...)`(`.notes-node-title-field, .notes-node-note-field,
  .notes-image-node-content`)가 아니면 즉시 반환한다. 빈 공간과 사이드바는 둘 다
  아니므로 gesture가 만들어지지 않고 `preventDefault()`도 불리지 않는다.
- 네이티브 선택을 억제하는 장치는 전부 gesture가 있어야 작동한다. CSS 쪽은
  `[data-row-selecting]`/`[data-band]`에 걸린 `user-select: none`과 투명
  `::selection`(`apps/desktop/src/notes.css:1187`, `:1198`)이고, JS 쪽은
  `useOutlinePointerSelection.ts:67`·`:132`와 `NotesOutline.tsx:267`의
  `removeAllRanges()`다.
- `retire`(`useOutlinePointerSelection.ts:58`)는 gesture가 없으면 첫 줄에서
  반환한다. 그래서 잔류 range를 지울 기회가 없다.
- 유령 배경이 행 전체 폭인 이유: 필드의 presentation span이
  `display: block; width: 100%`이고(`notes.css:2255` `.notes-node-title`,
  `notes.css:2636` `.notes-node-note`), 편집 중 textarea는 글리프를 투명하게
  그린다(`OutlineTextField.tsx:349` `color: transparent` /
  `WebkitTextFillColor: transparent`).
- a44de1f9("the band drag leaves no text selection painted")는 행 텍스트에서
  시작해 행을 가로지르는 밴드 드래그 경로만 닫았다. 이번 버그는 그 형제 경로다.

## 계약

| 항목 | 내용 |
| --- | --- |
| 목표 | 아웃라인 빈 영역이나 사이드바에서 시작한 드래그가 네이티브 텍스트 선택을 만들지 않는다 |
| 완료 조건 | 아래 인수 조건 표 |
| 비대상 | 잔류 range를 사후에 지우는 로직 추가, 웹뷰 잔상 강제 리페인트, Rust/IPC/persistence/스키마, 사이드바 외 다른 화면(설정/검색/모달)의 선택 정책 변경 |
| 영향 범위 | 프론트엔드만: CSS 두 파일(`notes.css`, `styles.css`)과 선언을 고정하는 vitest 한 파일. JS·Rust·IPC·SQLite 변경 없음 |
| 데이터·Undo/Redo | 해당 없음 |
| 직접 확인할 사용자 시나리오 | 아래 수동 확인 절 |

인수 조건 6과 7은 원 계약에 없던 추가다. 사이드바에 `user-select: none`을 깔면
검색 필드와 동기화 배지 안의 선택이 같이 죽어서, 이 수정이 새로 깨뜨릴 수 있는
기존 동작을 고정하는 행이다. 목표를 넓힌 것이 아니다. 7은 아이템 2의 리뷰가
잡아 뒤늦게 더했다.

### 인수 조건

| # | 조건 | 아이템 |
| --- | --- | --- |
| A1 | 마지막 불릿 아래 빈 공간에서 시작한 드래그는 어떤 행도, 사이드바도 파랗게 칠하지 않는다 — 이어서 행을 클릭해도 유령 밴드가 없다 | 1 |
| A2 | 사이드바 자체를 드래그해도 선택되지 않는다 | 2 |
| A3 | 편집 중인 행의 textarea 안에서 드래그·더블클릭·Cmd+A로 만든 선택은 그대로 보이고 복사된다. 행 메뉴의 태그·이동 chooser 입력 필드도 같다 | 1 |
| A4 | 비편집 행의 글자 위 드래그가 textarea 선택으로 매핑되는 기존 동작이 유지된다 | 1 |
| A5 | 행을 가로지르는 드래그가 만드는 다중 선택 밴드가 유지되고, 끝난 뒤 잔상이 없다 | 1 |
| A6 | 사이드바 검색 필드 안의 텍스트 선택은 유지된다 | 2 |
| A7 | 사이드바 동기화 배지가 알려 주는 파일 경로와 오류 문구는 선택·복사할 수 있다 | 2 |

## 아이템

각 항목은 커밋 하나, 먼저 빨간 테스트부터. 테스트 파일은 둘이 같이 쓰는
`apps/desktop/src/outline/outlineSelectionStyles.test.ts`(신규)이고,
`outlineGuideStyles.test.ts`처럼 `src/test/cssRules.ts`의 `rule(css, selector)`로
선언을 고정한다.

1. **아웃라인 행 컨테이너가 네이티브 선택을 끈다** — `notes.css`에서 세 가지를
   바꾼다.
   - 기존 `.notes-outline-rows` 블록(`notes.css:1177`)에 `user-select: none;`을
     더한다. 마지막 불릿 아래 빈 공간은 이 스크롤 컨테이너 자신의 영역이라,
     여기서 선택 앵커 자체가 생기지 않는다.
   - `.notes-outline-rows :is(textarea, input) { user-select: text; }`를 새로
     쓴다. WebKit은 조상의 `none`을 폼 컨트롤 안까지 끌고 들어가므로 행 편집
     textarea와 chooser 입력 필드를 명시적으로 되돌린다.
   - 기존 `[data-row-selecting="true"] { user-select: none; }`(`notes.css:1187`)은
     상시 `none`에 덮여 죽은 rule이 되므로,
     `[data-row-selecting="true"] :is(textarea, input) { user-select: none; }`으로
     좁혀 바꾼다. 위 재개방 rule이 열어 둔 컨트롤을 밴드 드래그 동안만 다시
     닫는 것으로, a44de1f9가 손으로 검증한 드래그 중 상태가 그대로 남는다.
     주석도 이 소유 구도(상시 상태는 컨테이너, 드래그 중 상태는 attribute)로
     고친다. `::selection` 투명 rule(`notes.css:1198`)과 JS 억제(3곳의
     `removeAllRanges`, blur, attribute 수명)는 손대지 않는다.

   실패 테스트와 예상 빨간 출력:
   - `turns native selection off across the rows pane`:
     `expect(rule(notesStyles, ".notes-outline-rows")).toContain("user-select: none;")`
     → `AssertionError: expected 'flex: 1;\nmin-height: 0;\noverflow-x: auto;\npadding: 24px 28px 44px;\n' to contain 'user-select: none;'`
   - `hands selection back to the editors and chooser fields`:
     `rule(notesStyles, ".notes-outline-rows :is(textarea, input)")`
     → `Error: missing rule: .notes-outline-rows :is(textarea, input)`
   - `keeps the band drag suppression on the reopened controls`:
     `rule(notesStyles, '[data-row-selecting="true"] :is(textarea, input)')`
     → `Error: missing rule: [data-row-selecting="true"] :is(textarea, input)`

   A4·A5는 이 아이템이 깨뜨릴 수 있는 회귀라 기존 테스트가 지킨다:
   `OutlineTextField.dragSelect.test.tsx`(presentation 드래그 매핑)와
   `outlineClipboardIntegration.test.tsx:446`(밴드 드래그와 `data-row-selecting`
   수명)이 그대로 green이어야 하고, 나머지 절반은 수동 확인 5·6이 맡는다.

2. **사이드바가 네이티브 선택을 끈다** — `styles.css`에서 두 가지를 바꾼다.
   - 기존 `.yonalist-navigation-pane` 블록(`styles.css:680`)에
     `user-select: none;`을 더한다.
   - `.yonalist-navigation-pane input { user-select: text; }`를 새로 쓴다.
     사이드바에서 사용자가 글자를 치는 곳은 검색 필드(`App.tsx:648`
     `<input type="search">`) 하나뿐이다. 페이지 제목은 아웃라인의 페이지 제목
     필드로 고치므로 사이드바 목록 자체엔 선택할 이유가 없다.
   - `.yonalist-navigation-pane .notes-sync-status-badge { user-select: text; }`를
     새로 쓴다. 리뷰가 잡은 회귀다(A7). 동기화 배지(`SyncStatusBadge.tsx:71`,
     `App.tsx:778`)는 읽지 못한 파일의 경로와 이유를 알려 주는 유일한 화면이고,
     경로는 다른 데로 가져가라고 적어 둔 글자다. 상시 `none`이 그걸 같이
     죽였는데 `input` 재개방은 이 배지를 덮지 않는다.

   실패 테스트와 예상 빨간 출력(같은 테스트 파일에 추가):
   - `turns native selection off across the sidebar`:
     `expect(rule(appStyles, ".yonalist-navigation-pane")).toContain("user-select: none;")`
     → `AssertionError: expected 'display: flex;\nflex-direction: column;\n…\nbox-shadow: none;\n' to contain 'user-select: none;'`
   - `keeps the search field selectable`:
     `rule(appStyles, ".yonalist-navigation-pane input")`
     → `Error: missing rule: .yonalist-navigation-pane input`
   - `keeps the sync trouble text selectable`:
     `rule(appStyles, ".yonalist-navigation-pane .notes-sync-status-badge")`
     → `Error: missing rule: .yonalist-navigation-pane .notes-sync-status-badge`

## 결정과 이유

1. **지우는 게 아니라 아예 못 만들게 한다** — 계약 비대상이 사후 클리너 추가를
   금지하고 있고, CSS `user-select`가 정확히 이 일을 하는 플랫폼 기능이다.
   앵커가 `user-select: none` 영역에 놓일 수 없으니 range가 태어나지 않고,
   잔류·잔상 문제가 통째로 사라진다.

2. **범위 소유자는 `.notes-outline-rows`와 `.yonalist-navigation-pane` 둘이다** —
   앱 셸 전체에 깔면 설정 화면(입력 필드, 첨부 목록 — `AttachmentsSection`은
   `SettingsView.tsx` 소속이라 이번 범위 밖이다)과 모달의 선택 정책까지
   바뀌어 계약 비대상을 침범한다. 반대로 `.notes-outline-rows`보다 좁힐 수는
   없다. 빈 공간이 이 컨테이너 자신의 padding과 남는 높이이기 때문이다. 행
   메뉴와 chooser도 이 컨테이너 안에 마운트되므로(`useMenuDismiss.ts:137`)
   재개방 rule의 범위와도 맞는다. `section.notes-outline`의 헤더 영역은 남는데,
   행이 전부 `none`이라 헤더에서 시작한 드래그가 행 위에 유령 밴드를 만들
   수는 없다. 헤더 자신의 글자 선택 정책은 계약 밖이라 두지 않는다.

3. **네이티브 문서 range에 기대는 기능이 없음을 확인했다** — 행 글자 위
   드래그는 원래부터 문서 range를 만들지 않는다.
   `handlePresentationPointerDown`(`OutlineTextField.tsx:248`)이
   `preventDefault()`하고 선택을 textarea 안으로 합성한다. 복사는 DOM 선택을
   읽지 않는다. 밴드 복사는 `useOutlineSelection.writeToEvent`가
   ClipboardEvent에 포맷을 직접 싣고, copy 이벤트가 `section.notes-outline`에
   닿는 것은 `retire`가 밴드 드래그 뒤 head 행 textarea에 focus를
   돌려주기 때문이지(`useOutlinePointerSelection.ts:69`) range 덕분이 아니다
   — a44de1f9가 이미 range 없는 밴드 복사를 실증했다. 이미지 복사는
   `putImageOnClipboard`로 프로그램이 하고, guide toggle은
   `elementFromPoint`와 geometry만 쓰며 `dataset.rowSelecting`을 읽을 뿐이고,
   행 드래그 엔진(`useOutlineDrag.ts`)은 pointer 기반이라 `dragstart`도
   selection도 안 쓴다. `getSelection` 호출처는 range를 지우는 두 파일뿐이다.

4. **`-webkit-user-select`를 무프리픽스와 짝으로 쓴다** — 처음엔 저장소의
   기존 4곳을 따라 무프리픽스로만 썼고, 근거는 "`notes.css:1188`이 a44de1f9에서
   이 런타임에 듣는 것을 확인했다"였다. 그 근거가 틀렸다. 수동 확인에서 버그가
   그대로 재현됐고, 이 Mac의 WKWebView(AppleWebKit/605)로 직접 재 본 결과
   `CSS.supports('user-select', 'none')`이 false — 무프리픽스 선언은 통째로
   버려진다. a44de1f9가 동작한 것은 CSS가 아니라 JS 억제(pointermove
   `preventDefault` + `removeAllRanges` + blur) 덕분이었다. 프리픽스를 붙이면
   설계대로 동작하는 것도 같은 probe로 확인했다: `none`이 자식 깊이 상속되고,
   `textarea`/`input` 재개방이 듣고, none 영역 위 programmatic range는
   `toString()`이 빈 문자열이다. 그래서 이 계약의 rule 여섯 곳은 전부
   `-webkit-user-select`와 무프리픽스를 짝으로 선언하고, 테스트도 두 줄을 다
   고정한다(무프리픽스 줄은 프리픽스 줄의 부분 문자열이라 앵커드 매치로 본다).
   저장소의 기존 4곳도 같은 이유로 WKWebView에서 죽어 있으나 이 계약 밖이라
   두고, 별도 작업으로 넘긴다.

5. **textarea 재개방은 명시적으로 쓴다** — WebKit이 조상의 `none`을 폼 컨트롤
   안까지 상속시키는지는 버전에 따라 갈리는 것으로 알려져 있다. 상속되면 이
   rule이 A3을 살리고, 상속되지 않으면 아무 일도 안 하는 무해한 선언이다.
   어느 쪽이든 rule 하나로 의문이 사라지고, 수동 확인 4가 실제 런타임에서
   판정한다.

6. **기존 억제 장치는 attribute rule 하나만 좁히고 나머지는 그대로 둔다** —
   `[data-row-selecting="true"]`의 광역 `user-select: none`은 상시 rule에 덮여
   죽으므로 남겨 두면 죽은 코드다. 대신 재개방된 컨트롤만 드래그 동안 되닫는
   좁은 rule로 바꿔, 편집 textarea에서 시작해 행을 가로지르는 드래그의 상태를
   오늘과 똑같이 유지한다. WKWebView가 "이미 시작한 range는 억제해도 계속
   늘린다"는 실측이 있으므로 `::selection` 투명 rule과 JS 쪽 `removeAllRanges`·
   blur는 방어선으로 그대로 둔다. `data-row-selecting` attribute 자체는
   `useOutlineGuideToggle.ts`가 읽으므로 어차피 남는다.

7. **테스트는 선언 고정 + 수동 확인 조합이다** — jsdom은 레이아웃도
   `user-select` 계산도 하지 않고, pointer 이벤트로 네이티브 선택을 만들지도
   않는다. "빈 공간 pointerdown 뒤 `document.getSelection()`이 비어 있다"는
   행동 테스트는 수정 전에도 green이라 아무것도 증명하지 못한다. 이 수정은 JS를 한 줄도
   바꾸지 않으므로 잃을 행동은 기존 테스트(A4·A5)가 지키고, 새로 얻는 행동은
   `rule()` 선언 테스트가 리팩터링에서 지키며, 실제 페인트는 수동 확인이
   증명한다. `outlineGuideStyles.test.ts`가 같은 이유로 같은 조합을 쓴다.

## 수동 확인 (fresh Tauri app)

1. 마지막 불릿 아래 빈 공간에서 pointerdown 후 왼쪽 사이드바 안까지 드래그 —
   행도 사이드바도 칠해지지 않는다 (A1, A2).
2. 이어서 아무 행이나 클릭해 편집 진입 — 행 뒤에 유령 밴드가 없다 (A1).
3. 사이드바 페이지 목록 위에서 드래그 시작 — 아무것도 선택되지 않는다 (A2).
4. 행 편집 중 textarea 안 드래그·더블클릭·Cmd+A — 선택이 보이고 Cmd+C로
   복사된다 (A3).
5. 비편집 행의 글자 위 드래그 — textarea 선택으로 매핑된다 (A4).
6. 행을 가로지르는 드래그 — 밴드가 그려지고, pointerup 뒤 잔상이 없다 (A5).
7. 검색 필드를 열고 입력한 글자를 드래그로 선택 — 선택된다 (A6).
8. 동기화 배지가 떠 있을 때 파일 경로를 드래그로 선택 — 선택되고 Cmd+C로 복사된다 (A7).
9. 행 메뉴의 태그 chooser 입력 필드에서 글자 선택 — 선택된다 (A3).

## 게이트

프론트엔드 전용: `npm test`, `npm run lint`, `npm run build`,
`git diff --check`. Rust·IPC·persistence·네이티브 설정을 건드리지 않으므로
Cargo 테스트·포맷·Clippy는 건너뛴다.
