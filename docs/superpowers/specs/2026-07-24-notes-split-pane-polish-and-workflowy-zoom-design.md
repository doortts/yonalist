# Notes Split Pane Polish와 Workflowy Zoom 단축키 설계

**날짜:** 2026-07-24
**상태:** 승인됨

## 계약

| 항목 | 내용 |
| --- | --- |
| 목표 | Notes split view의 분리선과 열기·닫기 동작 및 Show completed 아이콘을 간결하게 다듬고, zoom된 서브 블릿 제목 편집 회귀를 복구하며, Workflowy와 같은 zoom-in/out 단축키를 모든 블릿 편집 표면에 제공한다. |
| 완료 조건 | 분리선은 시각적으로 1px이다. split이 닫혀 있으면 왼쪽 toolbar에 기존 `Columns2` 열기 버튼이 보인다. split이 열려 있으면 왼쪽에는 split 버튼이 없고 오른쪽 pane에만 `PanelRightClose` 닫기 버튼이 보인다. split을 닫으면 왼쪽 pane의 블릿 편집기로 포커스가 돌아간다. Show completed는 간결한 `Check` 아이콘을 사용한다. zoom된 서브 블릿 페이지 제목을 다시 수정할 수 있다. 제목·설명·이미지에서 macOS `⌘ + .`/`⌘ + ,`, Windows·Linux `Alt + .`/`Alt + ,`가 Workflowy 방식으로 동작한다. |
| 비대상 | 3개 이상 pane, split 상태의 Notes Undo 기록, 단축키 사용자 설정, 새 아이콘 dependency, Notes 저장 포맷·SQLite·IPC·Rust 변경은 포함하지 않는다. |
| 경계 | React Notes feature의 split host, pane toolbar, page header editing lease, outline keyboard command resolution과 Notes CSS만 바뀐다. 데이터와 history timeline은 기존 계약을 유지한다. |
| 직접 확인 | 격리한 Vault의 freshly built/restarted Tauri 앱에서 닫힘·열림 상태의 split 버튼 배치와 Show completed의 `Check` 아이콘을 확인한다. split을 열고 두 pane에서 편집권을 이동한 뒤 왼쪽 zoom page 제목을 수정한다. 제목·설명·이미지에서 zoom 단축키를 확인하고, 오른쪽 닫기 버튼을 눌러 왼쪽 편집기 포커스와 1px divider를 확인한다. |

## 확인된 회귀 원인

회귀는 2026-07-24 04:47(KST)의
`2d29fad feat(notes): coordinate pane editing ownership`에서 시작됐다.
이 변경은 두 pane이 공유 draft를 동시에 수정하지 않도록 전역 editing lease와
pane-bound `updateNodeDraft` guard를 추가했다.

일반 블릿의 `OutlineNodeRow`에는 focus 시 `claimEditingFocus()`가 연결됐지만,
zoom된 블릿을 렌더링하는 `NotesPageHeader`의 페이지 제목과 설명에는 같은 연결이
빠졌다. 다른 node나 pane이 lease를 가진 상태에서 page header가 포커스를 받아도
draft update가 guard에서 거부되므로 커서는 보이지만 입력이 저장되지 않는다.
기존 테스트는 lease controller와 일반 row의 소유권만 확인하고, 실제 zoom page
header에서 편집권을 되찾아 입력하는 경로를 검증하지 않아 회귀를 잡지 못했다.

## 선택한 접근

기존 두-pane 구조를 유지하고 각 책임의 소유 위치만 보강한다.

1. `NotesDetailSplitHost`는 split 표시, 닫힌 primary의 열기 진입점, 열린
   secondary의 닫기 진입점과 포커스 복원을 계속 소유한다.
2. `NotesPageHeader`는 자신이 렌더링하는 제목과 설명 focus에서 editing lease를
   요청한다.
3. `outlineKeyboard`는 플랫폼별 Workflowy zoom chord를 판정하는 순수 resolver를
   제공한다.
4. `NotesOutlinePane`은 pane 내부의 제목·설명·이미지에서 발생한 zoom chord를
   한 번만 받아 현재 pane의 `zoomTo()`로 전달한다.
5. `notes.css`는 divider의 시각선과 pointer hit area를 분리한다.
6. Show completed toggle은 상태와 동작을 유지한 채 glyph만 `Check`로 바꾼다.

검토했지만 선택하지 않은 접근은 다음과 같다.

- 제목, 설명, 이미지 컴포넌트마다 zoom 단축키를 따로 연결하면 동일한 modifier,
  IME, repeat guard가 여러 파일에 중복되고 page header 누락과 같은 회귀가 다시
  생기기 쉽다.
- 범용 pane command bus와 N-pane toolbar registry를 만들면 이번 두-pane
  요구보다 상태와 추상화가 커진다.
- divider의 실제 hit area까지 1px로 줄이면 마우스와 트랙패드 resize가 지나치게
  어려워진다.

## Split divider

grid의 resize track과 separator hit area는 현재 6px를 유지한다. separator 배경은
투명하게 만들고 중앙 pseudo-element만 1px `var(--border)`로 렌더링한다.
hover와 keyboard focus에서는 이 1px 선만 accent 색으로 바뀐다.

따라서 스크린샷에서 보이는 굵은 띠는 1px 선으로 바뀌지만 pointer capture,
좌우 화살표 resize, 25–75% ratio clamp와 접근성 separator 계약은 유지된다.

## Split 아이콘과 닫기

split이 닫힌 primary toolbar는 현재 사용 중인 Lucide `Columns2`와
`Open split view` label을 유지한다. split이 열리면 primary toolbar에서는 split
버튼을 렌더링하지 않는다. 열린 secondary toolbar에만 `PanelRightClose`와
`Close split view` label을 렌더링한다.

secondary의 닫기 버튼은 `closeSplit()` 경로를 호출한다.

1. 모든 admitted draft를 flush한다.
2. flush가 실패하면 split을 열린 채 유지하고 현재 focus도 강제로 옮기지 않는다.
3. secondary editing lease를 해제하고 active pane을 primary로 바꾼다.
4. secondary pane을 unmount한다.
5. 다음 animation frame에 primary editor focus를 복원한다.

## 왼쪽 편집기 포커스 복원

primary pane은 focus capture로 마지막으로 사용한 editable Notes surface를
기억한다. 대상은 블릿/page 제목 textarea, supporting note textarea 또는 편집
가능한 image surface다. toolbar, breadcrumb와 read-only surface는 기록하지 않는다.

split을 닫은 뒤 다음 우선순위로 focus한다.

1. 아직 DOM에 연결되어 있고 enabled/editable인 마지막 primary editor
2. 현재 primary `zoomRootId`의 page title editor
3. primary pane에서 첫 번째로 보이는 editable 블릿 title
4. 편집 가능한 블릿이 전혀 없을 때만 primary의 `Open split view` 버튼

첫 번째 경로는 기존 DOM selection과 caret을 그대로 보존한다. fallback으로
다른 editor를 선택하면 기존 focus action을 사용하여 해당 node의 editing lease를
정상적으로 claim한다. 오른쪽 toolbar의 `PanelRightClose`에서 닫을 때 이 규칙을
적용한다.

## Show completed 아이콘

`NotesOutlinePane`의 Show completed toggle은 Lucide `ListChecks` 대신
`Check`를 16px로 렌더링한다. `Show completed`/`Hide completed` tooltip,
`Completed items` accessible label, `aria-pressed`, disabled 조건과 기존
hover·pressed·focus 스타일은 그대로 유지한다. 따라서 이 변경은 아이콘 모양만
간결하게 만들며 완료 항목의 projection이나 상태 저장에는 영향을 주지 않는다.

## Zoom된 서브 블릿 편집권

`NotesPageHeader`의 page title과 supporting note는 직접 focus할 때
`claimEditingFocus(nodeId, field)`를 호출한다. claim이 성공한 뒤에만 해당
pane이 draft를 수정한다. 기존 owner의 draft flush가 실패하거나 다른 pane이
한글 조합 중이면 claim이 거부되고 현재 동작처럼 새 editor를 blur하여 두 DOM이
동시에 shared draft를 쓰지 못하게 한다.

pending focus/Undo replay가 사용하는 `acknowledgeFocus()` 경로도 기존처럼 lease를
claim한다. 직접 pointer focus와 프로그램 focus가 같은 ownership 계약을 갖도록
실제 page header 입력 테스트를 남긴다.

## Workflowy zoom 단축키

공식 Workflowy chord를 그대로 사용한다.

| 플랫폼 | Zoom in | Zoom out |
| --- | --- | --- |
| macOS | `⌘ + .` | `⌘ + ,` |
| Windows·Linux | `Alt + .` | `Alt + ,` |

pane-level keydown capture는 event target이 editable title, supporting note 또는
image surface 안에 있을 때만 단축키를 소유한다.

- zoom-in은 target이 속한 블릿의 `nodeId`로 `actions.zoomTo(nodeId)`를 호출한다.
- zoom-out은 현재 pane `zoomRootId`의 parent로 이동한다. 최상위 page면
  `actions.zoomTo(null)`을 호출한다.
- page header에서 zoom-in은 이미 같은 node에 zoom된 상태이므로 chord를
  소비하되 새 history entry를 만들지 않는다.
- root view에서 zoom-out도 chord를 소비하되 navigation을 만들지 않는다.
- `isComposing`, `Process`, 추가 modifier와 key repeat에서는 새 navigation을
  실행하지 않는다.
- toolbar, breadcrumb, 검색 field 등 블릿 편집 표면 밖에서는 chord를 가로채지
  않는다.

각 pane은 자신의 pane-bound `zoomTo()`를 호출하므로 primary와 secondary 탐색
상태 및 navigation history origin은 기존처럼 독립적이다.

## 테스트와 검증

### 집중 RED/GREEN

- split divider의 보이는 선이 1px이고 hit area와 keyboard resize 계약은
  유지된다.
- 닫힘 primary에는 기존 `Columns2`가 렌더링되고, 열린 primary에는 split
  버튼이 없으며 열린 secondary에만 `PanelRightClose`가 렌더링된다.
- secondary 닫기 버튼이 split을 닫고 마지막 primary editor와 caret을 복원한다.
- 마지막 primary editor가 사라졌을 때 page title, 첫 visible title, open button
  fallback 순서를 지킨다.
- Show completed toggle은 `Check`를 렌더링하면서 기존 tooltip,
  `aria-pressed`, disabled와 toggle 동작을 유지한다.
- 다른 pane이 lease를 가진 뒤 zoom page title을 focus하고 입력하면 draft와
  repository update가 새 제목을 받는다.
- page supporting note도 동일한 ownership transfer를 거친다.
- platform별 zoom chord와 잘못된 modifier, IME, repeat, root/page no-op을 순수
  resolver에서 검증한다.
- row title, supporting note, image와 page header에서 현재 pane의 올바른
  `zoomTo()` target을 호출한다.

### owning frontend

- 기존 split open/close, divider arrow resize, Vault별 layout persistence와
  primary/secondary active pane 테스트가 통과한다.
- 기존 outline keyboard, navigation Undo/Redo, Korean IME, image atom 편집과
  Notes page-title focus 테스트가 통과한다.

### 데스크톱 직접 확인

1. split을 열고 divider가 1px로 보이면서 drag resize가 쉬운지 확인한다.
2. 닫힘 primary의 `Columns2`, 열린 secondary의 `PanelRightClose`, 열린
   primary에 split 버튼이 없는지 확인한다.
3. Show completed가 `Check`를 사용하고 기존 tooltip/active/disabled 상태가
   유지되는지 확인한다.
4. 오른쪽에서 블릿을 편집한 뒤 왼쪽 zoom page 제목과 설명을 바로 수정한다.
5. 왼쪽의 제목·설명·이미지에서 `⌘ + .`/`⌘ + ,`를 확인한다.
6. 오른쪽에서도 같은 shortcut이 오른쪽 pane만 이동시키는지 확인한다.
7. 오른쪽 닫기 버튼을 누른 뒤 왼쪽의 마지막 editor와 caret으로 돌아가는지
   확인한다.

최종 변경이 frontend에만 머무르면 `npm test`, `npm run lint`,
`npm run build`, `git diff --check`를 한 번씩 실행한다. Rust, IPC payload,
persistence schema와 native configuration을 바꾸지 않으므로 Cargo test,
Rust formatting과 Clippy는 실행하지 않는다.
