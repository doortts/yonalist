# 상위 완료가 하위를 데려가고, 곧바로 되돌리면 이전 상태로

작성 2026-08-19, 3차 개정(구현 반영). 설계는 Fable 5가 맡는 체제지만 한도 초과로
붙지 못해 Opus 5가 썼다.

구현하면서 계획이 두 군데 바뀌었다.
- 새 도메인 명령 `RestoreCompleted`는 필요 없었다. 세션이 이미 갖고 있는 undo
  항목의 inverse가 곧 "완료 직전 값"이라, 그걸 앞으로 가는 패치로 다시 커밋하면
  된다. 명령도, 저장 창(working set) 처리도, 새 IPC도 늘지 않았다.
- 조상 자동 완료가 페이지 행까지 올라가는 문제를 막았다. 페이지 행은 kind가
  Bullet이라 마커 조건을 없애자 그대로 걸렸고, 페이지 제목과 사이드바 이름에
  취소선이 그려지고 완료 숨김 필터에서 페이지가 사라질 수 있었다.

## 지금 코드가 이미 하는 일

- 하위 전파는 이미 있다. `crates/notes-core/src/tree/command_execution.rs:548`
  `cascade_completed`가 클릭한 행 아래를 같은 상태로 만들고, 아래가 전부 끝나면
  조상까지 따라 완료된다.
- 단 두 곳이 마커를 본다. `todo_subtree_ids`는 마커가 Todo가 아닌 자식에서
  가지를 끊고, `live_todo_parent`는 조상이 Todo일 때만 올라간다. 그래서 일반
  bullet은 전파를 주지도 받지도 못하고, 일반 bullet 아래의 Todo 손자까지 끊긴다.
- 완료 해제는 아래를 전부 `false`로 밀어버린다. 전파 직전에 이미 완료였던 자식도
  같이 풀린다. 이게 두 번째 문제다.
- 완료 진입점은 세 곳이고 모두 `setCompleted`/`setCompletedMany`로 모인다:
  체크박스(Todo 행만, `OutlineRow.tsx:331`), ⌘↩ 메뉴·단축키
  (`outlineMenuCommands.ts:199`, `outlineSupport.ts:525`), 선택 액션 바
  (`NotesOutline.tsx:389`). 전파 규칙은 서버가 갖고 있어 진입점은 손대지 않는다.
- 브라우저 프리뷰는 `apps/desktop/src/preview/previewTree.ts:15`에서 같은 규칙을
  베껴 갖고 있다. 규칙이 바뀌면 이쪽도 같이 바뀐다.
- 도메인 트리는 명령 하나마다 SQLite에서 필요한 창만 읽어 만든다
  (`crates/notes-sqlite/src/repository.rs:113` `collect_todo_chain`). 그래서
  "직전 상태 기억"은 트리에 둘 수 없고, undo 스택을 들고 있는 세션
  (`crates/notes-application/src/service.rs:40`)에 둔다.

## 계약

| 항목 | 내용 |
| --- | --- |
| 목표 | 마커와 무관하게, 상위 행을 완료하면 그 아래 모든 행이 완료되고, 곧바로 같은 행을 완료 해제하면 아래 행들이 완료 직전 상태로 돌아온다 |
| 완료 조건 | 아래 인수 조건 표 |
| 비대상 | 일반 bullet에 체크박스 노출(완료는 ⌘↩·메뉴·선택 바로), 완료 해제를 자식에서 시작할 때의 규칙 변경, 되돌림 창을 앱 재시작 뒤까지 보존, 스키마 변경 |
| 영향 범위 | Rust `notes-core`(전파 규칙, 새 명령), `notes-application`(세션 기억), `notes-sqlite`(명령이 읽을 창), 프리뷰 미러(TS). IPC 명령 모양과 React 클라이언트는 변경 없음 |
| 데이터·Undo/Redo | 기억은 세션 메모리에만 둔다(스키마 v1 고정, 마이그레이션 없음). 되돌림도 앞으로 가는 변경 하나로 처리해 자기 undo 항목을 남긴다. 되돌린 뒤 undo를 누르면 다시 완료 상태로 간다 |
| 직접 확인할 사용자 시나리오 | 새 페이지에 상위 일반 bullet 하나와 자식 셋(일반 bullet, 미리 완료해 둔 Todo, 일반 bullet 아래의 Todo 손자)을 만들고 상위 행에서 ⌘↩ → 손자까지 전부 완료. 다시 ⌘↩ → 미리 완료였던 Todo만 완료로 남는다. 같은 순서에서 중간에 다른 행을 편집한 뒤 ⌘↩ → 아래가 전부 해제된다 |

### 인수 조건

| # | 조건 | 아이템 |
| --- | --- | --- |
| A1 | 상위 행을 완료하면 마커와 무관하게 하위 전체가 완료된다(일반 bullet 아래의 Todo 손자까지) | 1 |
| A2 | 아래가 전부 완료되면 조상도 마커와 무관하게 따라 완료된다 | 1 |
| A3 | 하위 행 하나를 다시 열면 조상도 마커와 무관하게 따라 열린다 | 1 |
| A4 | 명령이 읽는 창이 전파 대상 전체를 담는다 — 저장된 트리에서도 A1~A3이 성립한다 | 2 |
| A5 | 프리뷰가 A1~A3과 같은 결과를 낸다 | 3 |
| A6 | 조상 자동 완료는 페이지 행 아래에서 멈춘다 | 1b |
| A7 | 완료 직후 같은 행을 해제하면 하위는 완료 직전 값으로 돌아간다 | 5 |
| A8 | 사이에 다른 변경이 하나라도 끼면 되돌림 창이 닫히고 해제는 아래를 전부 해제한다 | 5 |
| A9 | 되돌림은 undo 항목 하나를 남긴다 — undo하면 다시 전부 완료 상태로 간다 | 5 |
| A10 | 프리뷰가 A7·A8과 같은 결과를 낸다 | 6 |

## 아이템

각 항목은 커밋 하나, 먼저 빨간 테스트부터.

1. **전파에서 마커 조건을 없앤다** — `command_execution.rs`의 `todo_subtree_ids`가
   하위 전체를 돌고, `live_todo_parent`가 마커를 보지 않는다. 결과적으로 규칙이
   하나로 줄어 진짜 트리 규칙이 된다. 마커 조건이 사라지므로 두 함수 이름도
   체인이 아니라 트리를 말하는 이름으로 바꾼다.
   테스트: `crates/notes-core/tests/tree_commands.rs`
   `completing_a_row_settles_every_descendant_whatever_its_marker`,
   `an_ancestor_bullet_follows_once_nothing_below_it_is_open`
   기존 경계를 잠근 테스트는 새 규칙으로 고친다:
   `ticking_a_todo_settles_the_chain_below_it_and_stops_at_a_bullet`(:1358).
2. **명령이 읽는 창을 넓힌다** — `repository.rs`의 `SetCompleted`/
   `SetCompletedMany`가 Todo 체인 대신 조상 + 조상 아래 전체를 읽는다. 조상이
   따라 완료될지 판단하려면 그 조상 아래 형제 가지도 창에 있어야 한다.
   테스트: `crates/notes-sqlite/tests/todo_cascade.rs`
   `a_bullet_child_outside_the_todo_chain_still_settles`
   기존 테스트 두 개의 "bullet에서 끊긴다" 단정을 고친다(:148, :169).
3. **프리뷰 미러를 맞춘다** — `previewTree.ts`의 `completionCascade`가 같은
   규칙을 쓴다.
   테스트: `apps/desktop/src/preview/previewTree.test.ts`
   `settles every descendant whatever its marker`
   기존 `ticks every Todo under the one clicked, stopping at a bullet`(:35)을
   새 규칙으로 고친다.
1b. **조상 자동 완료는 페이지 행 아래에서 멈춘다** — `live_parent_row`가
   `is_page_row`(루트 Page이거나 그 직계 자식)에서 멈춘다.
   테스트: `crates/notes-core/tests/tree_commands.rs`
   `the_climb_stops_below_the_page_row`
5. **세션이 직전 상태를 기억한다** — 기억은 undo 스택이다. 완료 명령이 만든 history
   항목에 그 명령이 지목한 행 목록(`completed_rows`)을 달아 두고, 바로 다음 명령이
   같은 행들의 완료 해제이면 그 항목의 inverse를 앞으로 가는 패치로 커밋한다.
   history group으로 합쳐진 항목은 더 이상 한 제스처가 아니므로 표시를 지운다.
   단일 토글(`SetCompleted`)과 선택 일괄(`SetCompletedMany`) 둘 다 같은 경로다.
   테스트: `crates/notes-sqlite/tests/completion_restore.rs`
   `an_uncomplete_right_after_the_tick_hands_the_rows_back_their_own_states`,
   `taking_back_the_restore_puts_the_whole_branch_back`,
   `an_edit_in_between_closes_the_window`,
   `a_later_tick_of_another_row_closes_the_window`
6. **프리뷰도 같은 기억을 갖는다** — `previewApi`의 세션 상태에 같은 규칙.
   테스트: `apps/desktop/src/preview/previewApi.test.ts`
   `an uncomplete right after the cascade restores the rows`

## 결정과 이유

1. **전파 소유자는 도메인(Rust)** — 이미 거기 있고, 클라이언트는 페이지의 창만
   들고 있어 트리 전체를 모른다. 클라이언트 낙관적 갱신은 완료를 미리 뒤집지
   않으므로(`optimisticOutline.ts`는 새 행 기본값만 다룬다) 손댈 곳이 없다.
2. **마커 조건은 양방향 모두 없앤다** — 요청이 "체크리스트가 아닌 블릿도
   동일하게"다. 아래로 내려가는 전파만 풀고 조상 규칙에 Todo 조건을 남기면 규칙이
   둘로 갈라지고, 일반 bullet 부모는 아래를 다 끝내도 열린 채 남아 "동일하게"가
   아니게 된다. 두 조건을 같이 없애는 쪽이 코드도 더 줄어든다.
   눈에 보이는 결과 하나는 미리 말해 둔다. 일반 bullet 부모도 아래를 전부
   완료하면 따라 완료되어 취소선이 생긴다. 이게 싫으면 조상 규칙만 Todo로 남기면
   되고, 아이템 1의 절반과 A2·A3만 빠진다.
   페이지 행은 예외다(아이템 1b). 페이지는 아웃라인의 행이 아니라 그 행들이 적힌
   면이고, 완료 숨김 필터가 페이지째로 감출 수 있다.
3. **되돌림 창 = 바로 다음 변경 하나** — 완료 전파 뒤 같은 행의 완료 해제가 그
   세션의 다음 변경으로 들어오면 되돌린다. 그 사이 어떤 변경이든(다른 행 편집,
   다른 행 완료, undo, redo) 들어오면 창은 닫힌다. 화면 이동이나 선택 변경처럼
   저장을 건드리지 않는 동작은 창을 닫지 않는다. 세션 메모리라 앱을 다시 켜면
   사라진다. 사람이 "방금 취소"로 이해하는 범위와 같고 새 저장 필드도 필요 없다.
4. **하위 범위는 모든 깊이, 이미지 행도 포함** — 이미지 행도 같은 하위다.
   완료 표시가 이미 마커와 무관하게 그려진다(`notes.css:2304`).
5. **창이 닫힌 뒤의 완료 해제는 지금 그대로** — 아래를 전부 해제한다. 기억이
   없으면 되돌릴 값도 없고, 아무 것도 안 하면 완료 해제가 절반만 듣는다.
6. **체크박스는 여전히 Todo 행만** — 일반 bullet의 완료는 ⌘↩·메뉴·선택 바로
   한다. 요청에 없고, 모든 행에 상자를 달면 아웃라인이 체크리스트가 된다.
