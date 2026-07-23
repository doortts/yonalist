# Notes Split Pane과 pane 간 블릿 이동 설계

**날짜:** 2026-07-24
**상태:** 설계 승인, 구현 계획 대기

## 계약

| 항목 | 내용 |
| --- | --- |
| 목표 | Notes의 오른쪽 detail 영역을 두 pane으로 나누고, 각 pane에서 서로 다른 서브 페이지를 독립적으로 탐색하며, 블릿과 선택한 블릿 묶음을 pane 사이에서 drag & drop으로 이동한다. |
| 완료 조건 | 상단 Split 버튼으로 secondary pane을 열고 닫는다. 처음 연 secondary에는 현재 library scope의 최상위 블릿이 보인다. 두 pane은 페이지·선택·편집·펼침·스크롤 상태가 독립적이다. Vault별 split 상태와 마지막 페이지는 앱 재실행 후 복원된다. pane 간 이동은 한 번의 원자적 Notes 변경과 한 개의 공용 Undo 항목으로 처리된다. |
| 비대상 | 3개 이상 pane, 별도 Tauri 창/WebView, 서로 다른 Vault 사이 이동, modifier 복사, 화면 가장자리 drag로 자동 split, 블릿 메뉴의 “옆 pane에서 열기”, split 열기·닫기의 Undo는 포함하지 않는다. |
| 경계 | React Notes feature, pane 탐색 상태, DnD Kit context와 projection, draft barrier, 공용 Undo/Redo, Vault별 localStorage 설정이 바뀐다. 기존 Rust 이동·batch 명령이 계약을 충족하는 동안 SQLite schema와 IPC는 바꾸지 않는다. |
| 데이터·Undo/Redo | Notes 데이터·draft·명령 큐·history timeline은 하나만 둔다. pane별 화면 상태만 분리한다. 단일 이동은 기존 `moveNode`, 다중 이동은 기존 prepared-selection batch reorder를 사용한다. |
| 직접 확인 | 격리된 Vault에서 split을 열고 서로 다른 페이지를 연 뒤 단일·다중 블릿을 양방향으로 이동한다. Undo/Redo, 같은 블릿의 편집권 이동과 한글 IME, split 닫기/재열기, 앱 재실행, Vault 간 설정 격리를 확인한다. |

## 선택한 접근

하나의 `NotesWorkspaceRuntime`이 authoritative Workspace, Draft Engine,
SQLite 명령 큐와 Undo/Redo를 계속 소유한다. 오른쪽 detail 영역만 고정된
`primary`와 `secondary` pane session으로 나눈다.

```text
NotesWorkspaceRuntime
├─ authoritative nodes/attachments
├─ Draft Engine
├─ command queue
├─ shared Undo/Redo timeline
└─ NotesDetailSplitHost
   ├─ primary pane session  ─ NotesOutlinePane
   ├─ secondary pane session ─ NotesOutlinePane
   └─ shared DndContext
```

검토했지만 선택하지 않은 접근은 다음과 같다.

- `NotesWorkspaceProvider`를 pane마다 만들면 draft buffer와 presentation
  owner가 중복되고 같은 블릿 편집 및 history 권한이 충돌한다.
- pane마다 Tauri WebView를 만들면 native selection, IME, drag preview와
  Undo/Redo를 IPC로 다시 연결해야 한다.
- 범용 N-pane 레지스트리는 현재 요구사항보다 크다. 첫 구현은
  `"primary" | "secondary"` 두 ID와 하나의 split host만 사용한다.

## 상태 소유권

공유 Workspace에는 다음 상태만 남긴다.

- `nodesById`, `rootIds`, `childIdsByParent`
- 첨부와 이미지 상태
- 현재 library scope, loading 및 저장 오류
- draft buffer와 attachment 작업
- 공용 history 상태

각 pane session은 다음 상태를 독립적으로 소유한다.

- `paneId`
- `zoomRootId`
- 단일 포커스와 다중 선택
- `editingNoteId`, `pendingFocusId`와 커서 복원 요청
- 로컬 펼침 집합
- navigation version
- scroll anchor와 offset

현재 `NormalizedNotesWorkspace`에 섞인 화면 상태는 pane session으로 옮긴다.
초기 분리 단계에서는 primary pane 하나만 렌더링하여 기존 화면과 명령이 그대로
동작함을 먼저 증명한다.

같은 블릿은 양쪽에 동시에 표시할 수 있지만 실제 텍스트 편집권은 전역 editing
lease 하나가 소유한다. 다른 pane이 같은 블릿 편집을 시작하면 기존 pane의 IME
조합 종료와 draft 저장을 먼저 완료한 뒤 lease와 포커스를 옮긴다. 저장 실패 시
편집권을 옮기지 않는다.

## Split 열기·닫기와 Vault별 복원

오른쪽 detail 상단의 Split 버튼 하나가 secondary pane을 toggle한다. 블릿 메뉴
진입점은 추가하지 않는다.

- 처음 여는 Vault의 secondary는 `zoomRootId: null`로 시작하여 현재 library
  scope의 최상위 블릿을 표시한다.
- 열린 상태에서 버튼을 누르면 활성 draft를 저장하고 secondary를 숨긴다.
- 닫기는 session을 폐기하지 않고 마지막 탐색 상태를 보존한다.
- secondary가 활성 pane이었다면 primary로 키보드 포커스를 옮긴다.
- 다시 열면 마지막 secondary 페이지를 복원한다.
- split divider 비율은 25%에서 75% 사이로 제한한다.

기존 Vault별 localStorage 맵 패턴을 재사용하여
`yonalist.notesSplitLayout.v1` 하나에 Vault root별 상태를 저장한다. 새 native
저장소나 설정 abstraction은 만들지 않는다.

```ts
interface NotesSplitLayoutStateV1 {
  splitOpen: boolean;
  splitRatio: number;
  activePaneId: "primary" | "secondary";
  panes: {
    primary: PersistedPaneNavigation;
    secondary: PersistedPaneNavigation;
  };
}

interface PersistedPaneNavigation {
  zoomRootId: NoteId | null;
  expandedNodeIds: NoteId[];
  scrollAnchorId: NoteId | null;
  scrollOffset: number;
}
```

authoritative Workspace가 준비된 뒤 저장 상태를 검증한다. 현재 scope에서 열 수 없는
`zoomRootId`, 삭제된 expansion ID와 scroll anchor는 제거한다. 페이지가 유효하지
않으면 해당 pane만 최상위 화면으로 되돌린다. 손상된 JSON도
최상위 기본값으로 복구하며 Notes 데이터에는 영향을 주지 않는다.

## 공용 DnD 경계

현재 각 `NotesOutlinePane` 안의 `DndContext`를 `NotesDetailSplitHost`로 올려
두 pane을 함께 감싼다. 이미 설치된 DnD Kit과 기존 projection helper를 재사용한다.

같은 블릿이 양쪽 DOM에 동시에 존재할 수 있으므로 draggable과 droppable ID에는
pane ID와 drop zone을 포함한다.

```text
primary:<node-id>:row
secondary:<node-id>:before
secondary:<node-id>:inside
```

각 pane은 scroll container, 현재 `zoomRootId`, visible structural rows, row rect와
쓰기 가능 여부를 공용 drag coordinator에 제공한다. 별도의 범용 registry 대신
split host가 두 고정 pane의 adapter를 직접 가진다.

drag 시작 시 다음 authority를 변경 불가능한 snapshot으로 고정한다.

- source pane ID와 source `zoomRootId`
- 드래그한 블릿 또는 선택된 structural root ID
- selection revision
- Workspace generation과 scope
- existing prepared-selection authority

drag 도중 selection이나 generation이 바뀌면 session을 무효화한다. destination
pane으로 포인터가 넘어가면 그 pane의 row와 들여쓰기 기준으로 parent, `afterId`,
depth를 다시 계산한다. destination pane만 자동 스크롤하며 공용 DragOverlay는
하나만 렌더링한다.

## Drop 규칙과 원자적 이동

- row 사이 drop은 계산된 `parentId`와 `afterId`를 사용한다.
- child 위치 drop은 해당 row 아래로 이동한다.
- zoom된 pane의 빈 tail은 그 페이지의 마지막 자식 위치다.
- 최상위 pane의 빈 tail은 마지막 root 위치다.
- same-pane drop은 기존 정렬 동작을 유지한다.
- Archive와 Trash처럼 읽기 전용인 destination은 거부한다.
- 필터 화면은 기존 prepared authority 검증을 통과한 경우만 허용한다.

명령 큐 실행 직전에 source 존재, destination 존재, selection authority,
Workspace generation, cycle, 최대 깊이와 기존 이미지 노드 제한을 다시 검증한다.
자신이나 자손 아래 이동, stale target과 no-op은 저장하지 않는다.

구조 변경 전 공유 Draft Engine barrier가 양쪽 pane의 admitted draft를 모두
flush한다. 단일 structural root는 기존 `moveNode`, 다중 structural root는 기존
prepared-selection batch reorder를 호출한다. 둘 다 backend transaction과 history
entry가 정확히 하나여야 한다.

성공 결과는 한 authoritative Workspace로 두 pane에 반영한다. source 선택은
해제하고 destination에서 이동한 블릿을 선택·포커스한다. pane별 UI 효과는 공유
저장 결과와 분리하여 split host가 source와 destination session에 적용한다. 실패
시 preview만 제거하고 두 pane의 탐색 상태와 마지막 확정 Workspace를 유지한다.

## 공용 Undo/Redo

두 pane은 기존 Notes history session 하나를 공유한다. 어느 pane에서 단축키를
눌러도 전체 Notes timeline의 가장 최근 작업을 되돌린다.

history location은 두 pane snapshot과 `activePaneId`를 담는다. navigation
entry에는 `originPaneId`를 기록하여 한 pane의 페이지 이동 Undo가 그 pane만
복원하도록 한다. cross-pane 이동 한 번은 데이터 이동과 before/after pane 위치를
가진 하나의 structural entry다.

- Undo는 블릿을 source 위치로 돌리고 두 pane이 열려 있으면 source에 포커스한다.
- Redo는 destination 위치와 포커스를 복원한다.
- split 열기·닫기는 history entry를 만들지 않는다.
- secondary가 닫힌 상태의 Undo는 데이터를 복원하고 숨겨진 session snapshot만
  갱신한다. pane을 자동으로 다시 열지 않는다.
- 화면 snapshot 복원 실패 시 authoritative 데이터 결과를 우선하고 해당 pane을
  최상위로 복구한다.
- history epoch mismatch는 공용 timeline을 기존 방식으로 reset한 뒤 두 pane을
  authoritative Workspace에서 다시 투영한다.

## 구현 경계

1. **Pane state 추출:** primary 한 개로 기존 탐색·선택·편집·Undo 동작을 유지한다.
2. **Split host와 저장:** secondary, divider, Split 버튼과 Vault별 복원을 추가한다.
3. **DnD context 승격:** ID namespace와 pane adapter를 적용하되 same-pane 이동을
   먼저 기존과 동일하게 만든다.
4. **Cross-pane 이동:** 단일 이동을 먼저 연결하고, 그 수직 경로가 확인된 뒤 기존
   prepared-selection batch를 연결한다.
5. **History와 편집권:** 두 pane location, global editing lease와 IME 경계를
   마무리한다.

새 dependency, generic pane manager, Rust command와 SQLite migration은 추가하지
않는다. 기존 계약이 실제로 단일 batch history를 보장하지 못한다는 failing
regression이 발견될 때만 native 경계를 별도 설계한다.

## 검증

### 집중 테스트

- pane reducer에서 primary와 secondary 탐색·선택·펼침이 서로 독립적이다.
- Vault별 저장, 재실행 복원과 삭제된 페이지의 최상위 fallback이 동작한다.
- 같은 node가 두 pane에 있어도 DnD ID와 drop rect가 충돌하지 않는다.
- destination pane 기준으로 parent, `afterId`와 depth를 계산한다.
- 자신·자손·read-only·stale target을 저장 전에 거부한다.
- 단일·다중 cross-pane 이동이 정확히 한 mutation과 한 history entry를 만든다.
- draft flush 실패 시 이동·Undo/Redo와 editing lease 이전을 하지 않는다.
- Undo/Redo가 pane 위치를 복원하고 닫힌 secondary를 자동으로 열지 않는다.
- 한글 조합 중 구조 변경과 편집권 이전을 차단한다.

### owning integration

- 하나의 WorkspaceProvider 아래 두 pane이 같은 authoritative 변경을 받는다.
- same-pane drag의 기존 projection, selection drag와 keyboard drag가 회귀하지
  않는다.
- navigation Undo, filtered authority, attachment와 image row 이동이 회귀하지
  않는다.
- split toggle이나 cross-pane settle이 Notes Library pane을 다시 렌더링하거나
  깜박이게 하지 않는다.

### 데스크톱 직접 확인

격리한 Vault와 freshly built/restarted Tauri 앱에서 다음 한 경로를 확인한다.

1. Split을 열고 secondary가 최상위에서 시작하는지 확인한다.
2. 서로 다른 서브 페이지를 연 뒤 단일·다중 블릿을 양방향으로 이동한다.
3. `Cmd+Z`와 `Cmd+Shift+Z`로 위치와 포커스를 복원한다.
4. 같은 블릿을 양쪽에서 열고 한글 입력 후 편집권을 옮긴다.
5. split을 닫고 다시 열어 페이지가 유지되는지 확인한다.
6. 앱 재실행과 다른 Vault 전환 후 각 Vault의 상태가 독립적으로 복원되는지
   확인한다.
7. Archive·Trash와 cycle target이 drop을 거부하는지 확인한다.

첫 구현은 frontend 경계로 유지한다. 따라서 최종 diff가 Rust, IPC, persistence
schema나 native 설정을 건드리지 않으면 `npm test`, `npm run lint`,
`npm run build`, `git diff --check`만 실행하고 Cargo gate는 명시적으로
건너뛴다.
