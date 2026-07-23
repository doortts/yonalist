# Notes 플러그인 루트 Markdown과 알림 트리 동기화 설계

**상태:** 사용자 최종 설계·적대적 리뷰 반영

**날짜:** 2026-07-23

**대체 범위:**

- `2026-07-22-notes-external-notifications-plugin-design.md`의 “완전히 가상인 최상위 페이지” 결정
- `2026-07-23-notes-github-notifications-presentation-design.md`의 “All에서 항상 첫 번째” 및 “날짜 그룹은 항상 펼침” 결정

이 문서와 앞선 문서가 충돌하면 이 문서가 우선한다. GitHub 읽음 상태는 완료 상태의 원본이며, 웹 열람 기록(`viewedAt`)은 완료·필터와 별개라는 원칙을 유지한다.

## 1. 한눈에 보는 결론

`Github Notifications`(이하 GN)를 일반 최상위 Notes 블릿과 같은 정렬 흐름에 들어가는 **저장된 플러그인 루트**로 바꾼다.

- GN 루트는 고정 UUID를 가진 실제 최상위 `notes_nodes` 행이고, 루트마다 독립 Markdown 파일이 있다.
- 아직 사용자가 구조를 만들지 않은 원격 알림은 API/캐시에서만 투영한다. 이 상태는 SQLite 자식이나 Markdown에 저장하지 않는다.
- 알림 제목에서 `Enter`를 누르거나 기존 Notes의 자식 생성 동작을 쓰려는 순간, 해당 날짜 anchor와 알림을 실제 Notes 블릿으로 materialize한다. 이어서 알림 바로 다음에 빈 일반 sibling을 만든다.
- materialize된 날짜 anchor, 알림, 그리고 사용자가 만든 하위 트리는 GN Markdown의 일반 bullet tree로 저장·동기화한다. 따라서 원격 알림이 사라져도 마지막 스냅샷과 사용자 트리는 남는다.
- 날짜 anchor와 저장된 알림은 plugin-owned metadata로 식별한다. 일반 사용자 블릿은 그 아래에서 기존 Notes 형식과 명령을 그대로 쓴다.
- 저장된 알림의 제목·note·Type·URL·`updatedAt`·읽음 스냅샷은 GitHub가 권위다. 제목과 note는 기존 입력 UI처럼 커서 이동·선택·임시 입력이 가능하지만, blur 또는 source refresh 때 원문 스냅샷으로 복원된다.
- 일반 Notes 블릿에는 사용자가 켜고 끌 수 있는 `readonly` 속성을 추가한다. 일반 readonly는 내용·직접 삭제·구조 이동을 막되 커서 이동, 선택, 복사, 임시 입력, 완료, 접힘, 일반 child 생성을 허용한다.
- GN 소유 root·날짜·notification에는 일반 `readonly` 값을 기록하거나 메뉴를 노출하지 않는다. 대신 plugin-owned 규칙으로 내용을 보호한다. 일반 readonly와 GN 소유 행은 모두 hover 또는 focus 때 같은 잠금 아이콘을 보여 준다.
- readonly 자체의 직접 삭제는 막는다. 일반 상위 tree의 descendant에 readonly가 있으면 경고 후 사용자가 명시적으로 전체 삭제를 선택할 수 있다. readonly를 포함한 **일반 user tree**의 구조 이동은 확인 예외 없이 막고, GN root reorder·provider refresh·동기화는 별도 권위 경로를 따른다.
- 알림 행에는 별도 완료 체크 버튼을 두지 않는다. 기존 Notes 메뉴와 `Cmd/Ctrl+Enter`를 재사용해 GitHub에 단방향 mark-read 요청을 보낸다.
- 상단 `showCompleted`는 GitHub `unread === false` 알림과 그 subtree를 표시할지 결정한다. `viewedAt`은 이 필터에 영향을 주지 않는다.
- GN 루트와 날짜 그룹은 기본 펼침이다. GN 루트와 날짜 그룹의 접힘 상태는 Markdown을 통해 다른 기기에도 복원된다.

별도 플러그인 정렬 파일, 플러그인 전용 트리 데이터베이스, 범용 설치형 플러그인 SDK는 만들지 않는다. 기존 Notes 정렬·HLC·Markdown 동기화 경로를 재사용한다.

## 2. 사용자에게 보이는 결과

### 2.1 Notes 목록과 All

GN은 좌측 Notes 페이지 목록과 우측 `All` outline 양쪽에서 같은 최상위 루트 순서에 놓인다. 별도로 목록 앞에 덧붙이지 않는다.

```text
업무
Github Notifications
Daily
개인
```

우측 outline의 GN은 일반 루트와 같은 행 높이, 화살표, 블릿, 제목 정렬, 들여쓰기 선과 hover/focus 모양을 사용한다. 좌측 목록은 기존 일반 페이지 행의 `.notes-library-page` 구조를 따른다. 읽기 전용이라는 이유로 별도 카드나 전용 레이아웃을 만들지 않는다.

플러그인이 소유하는 GN root·날짜 anchor·notification 행은 다음 위치에만 표시한다.

- 좌측 Notes 페이지 목록
- 우측 `All`
- GN을 선택해 연 줌 화면

플러그인 소유 행은 `Starred`, `Recent`, `Tags`, `Archive`, `Trash`, Notes 검색 결과에는 표시하지 않는다. 다만 notification 아래나 같은 날짜에 사용자가 만든 일반 Notes 블릿은 기존 인덱싱·검색·Recent 규칙을 그대로 따른다.

### 2.2 GN 루트와 날짜 anchor

GN 루트는 최상위 루트 사이 순서 변경, `All`에서 접기·펼치기, row focus·활성화 및 GN 줌 열기만 허용한다. 여기서 활성화는 Notes 다중 선택이나 일괄 mutation 대상이 된다는 뜻이 아니다. GN 루트 자체의 제목·note·완료·별표·보관·삭제·복제·내보내기·일반 자식 생성은 허용하지 않는다. 루트 직속 자식은 plugin-owned 날짜 anchor뿐이다.

날짜 anchor는 로컬 달력 날짜 `YYYY.MM.DD`를 안정된 key로 삼고 화면에서는 기존 규칙대로 `Today`, `Yesterday`, `MM.DD`, `YYYY.MM.DD`로 표시한다. anchor의 저장 title은 안정된 날짜 key이며, 표시명은 런타임에서 계산하므로 날짜 경계가 지나도 사용자 데이터를 다시 쓰지 않는다.

- 처음 보는 날짜 key는 펼침이다.
- 접힌 날짜 key만 GN root의 상태와 Markdown frontmatter에 기록한다.
- anchor가 이미 materialize되어도 날짜 접힘의 단일 원본은 GN root의 접힌 날짜 key 집합이다. anchor의 일반 node 접힘 값은 사용하지 않는다.
- 같은 날짜에는 저장된 anchor가 최대 하나다. 아직 저장된 anchor가 없는 날짜 그룹은 projection-only다.
- GN 루트가 접힌 `All`에서는 모든 날짜와 알림을 숨긴다. GN 줌에서는 root 접힘과 무관하게 보여 준다.
- 날짜 key는 로컬 달력 기준이다. 시간대가 다른 기기에는 같은 key의 그룹이 없을 수 있고, 그 기기에서는 해당 접힘 상태가 조용히 보류된다. 이는 동기화 고장이 아니라 의도된 동작이며, 저장된 key는 다시 나타날 때를 위해 유지된다.

### 2.3 알림 행, 편집 감각과 구조 만들기

알림은 기존 Notes 블릿의 제목과 supporting note 구조를 그대로 사용한다.

```text
[Type 아이콘] [#45] 메뉴얼 검색 및 RAG 응답 구현                 [↗]
              arc-agent, 9h ago, seen 6h ago
```

- 일반 점 위치에는 Issue, Pull Request, Discussion, Release 또는 기본 알림 아이콘을 표시한다.
- 두 번째 줄은 기존 Notifications 목록의 저장소·활동 시각·seen 부제 생성 함수를 그대로 재사용한다. 이 줄은 note이며 독립 자식 블릿이 아니다.
- 저장되었든 projection-only이든 제목과 note는 기존 Notes editor의 caret, 선택, 키보드 이동, 복사와 임시 입력 UI를 사용한다.
- provider notification의 title/note 입력은 로컬 mutation·HLC·Undo history·Markdown export를 만들지 않는다. blur, `Escape`, provider snapshot 변경 또는 행 unmount 때 현재 provider snapshot으로 복원한다. unrelated state re-render만으로 focus·caret·draft를 버리지 않는다.
- 저장된 알림은 normal bullet tree 안에 있지만 title/note의 권위만 provider에 남긴다. 따라서 일반 Notes와 같은 모양·포커스 감각을 유지하면서 사용자가 임시 편집을 저장한 것으로 오해하지 않는다.
- GN root·날짜·notification은 일반 `readonly` 값과 메뉴를 갖지 않지만, hover 또는 `:focus-within`일 때 일반 readonly와 같은 작은 잠금 아이콘을 표시한다. 아이콘은 버튼이나 별도 tab stop이 아니다.
- 알림 title에서 `Enter`를 누르면 임시 title 수정은 먼저 버린다. 대상 날짜 anchor와 알림이 없으면 즉시 materialize하고, 알림 바로 다음에 빈 **일반 sibling**을 생성하여 그 입력으로 포커스를 옮긴다.
- notification supporting note의 `Escape`와 시작점 `ArrowUp`은 현재 notification title로, 끝점 `ArrowDown`은 다음 화면 title로 이동한다. note의 `Shift+Enter`도 title `Enter`와 같은 materialize-and-create-sibling 명령을 사용한다. 기존 Notes와 마찬가지로 `Cmd/Ctrl+Enter` mark-read는 title과 메뉴에서만 제공하고 note 입력에서는 새 shortcut을 추가하지 않는다.
- provider title/note의 단일 줄 붙여넣기와 note의 모든 붙여넣기는 임시 입력이며 복원된다. title에 기존 Notes outline parser가 인식한 구조적 다중 행 붙여넣기만 on-demand materialization 뒤 일반 child import로 처리한다.
- 새 sibling에서 `Tab`을 누르면 기존 Notes 들여쓰기 명령으로 알림의 자식이 된다. 그 뒤 사용자 블릿의 `Shift+Tab`, drag, 붙여넣기 등 일반 Notes 구조 명령은 plugin 경계 안에서 기존 동작을 따른다.
- projection-only notification은 sortable node가 아니므로 직접 drag하지 않는다. 다만 normal user node를 그 notification에 drop하는 최소 non-sortable target은 제공하며, drop commit에서 날짜 anchor와 notification을 materialize한 뒤 user node를 child로 한 번 reparent한다.
- provider-owned 행에서 구조적 `Backspace`, 삭제, 잘라내기, 복제, 재정렬, `Tab`·`Shift+Tab` shortcut은 저장소 오류까지 흘리지 않고 UI에서 consume한다.
- GN 전용 inline child composer는 만들지 않는다. 사용자는 title의 `Enter`로 일반 sibling을 만든 뒤 `Tab`으로 들여쓰거나, 구조적 title paste 또는 user node drop으로 자식을 만든다.

`Enter`가 만든 sibling을 들여쓰기하지 않으면 날짜 anchor 아래의 일반 sibling으로 남는다. 알림이 나중에 다른 날짜로 이동해도 이 sibling은 기존 날짜 anchor에 남는다.

### 2.4 완료, 읽음 및 표시 필터

알림 행 우측의 전용 완료 체크 버튼은 제거한다. 대신 기존 Notes의 완료 메뉴 항목과 `Cmd/Ctrl+Enter`를 notification context에서 그대로 제공한다.

- 아직 읽지 않은 알림에서 이 동작은 GitHub mark-read 요청을 한 번 보낸다.
- 성공할 때만 source snapshot의 `unread`를 `false`로 갱신한다. 일반 Notes `completed_at`을 쓰지 않는다.
- 실패하면 읽지 않은 상태를 유지한다. 읽음을 다시 unread로 되돌리는 경로는 만들지 않는다.
- 이 동작은 projection-only와 저장된 알림 모두에서 같은 provider action adapter를 거친다.

상단 `showCompleted`는 provider 완료 상태에도 적용한다.

- `showCompleted === false`이면 `unread === false`인 알림과 그 모든 하위 트리를 숨긴다.
- `showCompleted === true`이면 읽은 알림과 subtree도 보인다.
- projection-only 알림과 materialize된 알림에 동일하게 적용한다. 날짜 anchor는 현재 필터에서 보이는 저장 알림, 남아 있는 projection 알림 또는 일반 사용자 sibling이 있을 때만 보인다.
- 보이는 알림 subtree와 날짜 아래의 일반 사용자 블릿에는 기존 Notes `completed_at` 필터도 그대로 적용한다. 따라서 `showCompleted === false`에서는 읽지 않은 알림 아래라도 완료된 사용자 블릿은 숨고, 완료되지 않은 사용자 블릿은 보인다.
- `viewedAt`은 웹 페이지를 연 로컬 기록일 뿐이다. 읽음 상태를 바꾸지 않고, `showCompleted`와 어떤 subtree도 숨기지 않는다.

### 2.5 외부 웹 열기

웹 열기는 Lucide `ExternalLink`(우상향 화살표) 아이콘으로 표시한다. 기존 GitHub Inbox 상세 화면과 같은 tooltip·접근성 이름·`openNotification` 경로를 사용한다.

- `.notes-row-icon-button` 크기를 재사용하여 Notes 행 높이를 바꾸지 않는다.
- 잠금 아이콘과 `ExternalLink`는 pane 오른쪽 끝에 고정하지 않고 title 바로 뒤의 inline trailing cluster에 잠금 → `ExternalLink` 순서로 둔다. cluster 간격은 0px이며, title이 길면 title만 남은 폭에서 말줄임되고 cluster는 그 표시 끝에 이어진다.
- 버튼은 DOM Tab 순서에 항상 남기고 `display: none`이나 `visibility: hidden`을 쓰지 않는다. 아이콘은 알림 행 hover 또는 `:focus-within`일 때만 시각적으로 표시하므로, 키보드로 투명한 버튼에 focus가 오면 같은 `:focus-within` 규칙으로 즉시 나타난다.
- `@media (pointer: coarse)`에서는 hover가 없으므로 항상 표시한다.
- 열기는 시스템 브라우저에서 대상 URL을 열고 해당 URL의 로컬 `viewedAt`만 기록한다. GitHub mark-read 요청은 보내지 않는다.

### 2.6 일반 readonly 블릿

일반 root와 모든 깊이의 일반 user node는 블릿 메뉴에서 `읽기 전용으로 설정` 또는 `읽기 전용 해제`를 선택할 수 있다. GN root·날짜·notification에는 이 메뉴를 노출하지 않지만, GN 아래에서 사용자가 만든 일반 블릿에는 그대로 제공한다.

- readonly는 표시된 node 하나에만 적용하고 descendants에 상속하지 않는다. 일반 descendants는 개별적으로 readonly를 켜지 않는 한 평소처럼 편집·이동·삭제할 수 있다.
- 보호하는 content는 title, supporting note와 attachment다. caret 이동, 선택, 복사와 임시 입력은 허용하지만 blur, `Escape`, 화면 이동 또는 unmount 때 저장된 snapshot으로 복원한다. focus된 동안 Markdown·동기화·Undo/Redo가 backing row를 바꾸면 새 persisted snapshot으로 draft를 즉시 교체하고, row가 남아 있으면 focus를 유지하며 caret을 새 문자열 범위 안으로 보정한다.
- 임시 입력은 저장 mutation, HLC, Markdown export와 Undo history를 만들지 않는다. 단일·다중 행 paste도 임시 content일 뿐 새 구조를 만들지 않는다.
- readonly title의 `Enter`는 IME 조합 중이 아닐 때 임시 title을 버리고 같은 parent에서 바로 다음 `is_readonly: false` 일반 sibling을 만든다. 새 sibling은 평소처럼 `Tab`으로 readonly node의 child가 될 수 있다.
- readonly title의 `Shift+Enter`는 저장하지 않는 supporting-note draft로 focus를 옮긴다. title의 `ArrowUp/Down`과 시작·끝 경계 `ArrowLeft/Right`는 기존 visible editor 순서를 사용한다.
- readonly supporting note의 `Escape`와 시작점 `ArrowUp`은 현재 title로, 끝점 `ArrowDown`은 다음 visible title로 이동한다. note의 `Shift+Enter`는 임시 note를 버리고 다음 `is_readonly: false` 일반 sibling을 만든다. 기존 Notes와 같이 `Cmd/Ctrl+Enter` 완료 shortcut은 title에서만 처리한다.
- IME composition 중 Enter·방향키·Backspace는 구조 명령으로 바꾸지 않는다. 선택 텍스트의 cut/delete는 임시 draft만 바꿔 blur/복원 대상이지만 node cut/delete shortcut과 empty-title `Backspace`는 구조 동작으로 차단한다.
- readonly node 자체의 `Tab`·`Shift+Tab`, drag, keyboard reorder와 `Move To`는 consume하거나 거부한다. readonly descendant를 포함한 일반 상위 tree의 사용자 이동도 거부한다.
- readonly는 node의 현재 순서 칸을 고정하는 기능이 아니다. 다른 sibling을 readonly 앞뒤로 옮기거나 일반 node를 readonly의 child로 옮기는 것은 허용한다. 금지 대상은 readonly node 자체 또는 readonly를 포함한 subtree가 이동 대상인 경우다.
- GN root의 같은-parent 최상위 순서 변경은 그 아래 readonly user node가 있어도 허용한다. 이는 GN의 내부 parent 관계를 바꾸지 않는 명시적 plugin 예외다. provider 날짜 이동과 승인된 원격 merge도 readonly flag를 보존한 채 적용한다.
- readonly node의 직접 삭제·잘라내기·Trash 이동과 empty-title `Backspace` 삭제는 거부한다. 일반 ancestor를 삭제하려는데 descendant에 readonly가 있으면 `읽기 전용 블릿이 포함되어 있습니다. 함께 삭제할까요?` 경고를 띄우고 `취소`를 기본값으로 둔다. 사용자가 `삭제`를 선택한 경우에만 전체 tree를 원자적으로 삭제한다.
- attachment add/remove/resize UI는 비활성화하고 저장 mutation도 거부한다. 완료·완료 해제, 별표, 보관, 접기·펼치기와 일반 child 생성은 허용한다. 보관은 parent·sort를 바꾸는 구조 이동으로 보지 않는다. 일반 readonly node를 복제하면 복제본과 그 tree의 readonly 값도 그대로 복사한다.
- 일반 readonly와 GN 소유 행 모두 hover 또는 `:focus-within`에서 같은 비대화형 잠금 아이콘을 표시한다. 포커스된 일반 행에는 `읽기 전용`, GN 소유 행에는 `GitHub에서 관리됨`이라는 접근 가능한 상태 이름을 제공한다. 같은 아이콘은 content 보호를 뜻하며, GN root의 허용된 최상위 순서 변경까지 막는다는 뜻은 아니다.

## 3. 목표와 비대상

### 목표

1. GN을 일반 최상위 Notes 블릿과 동일한 순서 및 시각 구조로 표시한다.
2. GN 루트 순서·루트 접힘·날짜 접힘을 Markdown으로 기기 간 동기화한다.
3. 필요한 알림만 날짜 anchor와 함께 저장해 그 아래의 일반 Notes 트리를 동기화한다.
4. 저장된 알림의 provider snapshot을 GitHub 갱신으로 유지하고, 원본이 사라져도 저장된 snapshot과 자식을 보존한다.
5. GitHub 읽음 상태를 일반 Notes 완료 UX와 `showCompleted` 필터에 일관되게 연결한다.
6. 앞으로 추가되는 모든 내장 플러그인에 독립 루트 Markdown 파일을 요구한다.
7. 마지막 단계에서 일반 Notes 블릿의 접힘 상태도 각 루트 Markdown에 기록한다.
8. 일반 Notes 블릿에 동기화되는 readonly를 추가하고, 기존 outline editor·focus·child tree를 그대로 재사용한다.

### 비대상

- 모든 원격 알림을 자동으로 Notes 데이터나 Markdown에 복사
- 사용자가 설치하는 실행형 플러그인, 마켓플레이스, 범용 플러그인 SDK
- Jira나 Linear 제공자의 실제 구현
- 날짜별 별도 HLC나 접힘 전용 CRDT
- readonly origin enum, 권한별 capability matrix 또는 플러그인용 readonly 값
- 기존 v2 Markdown 또는 이전 개발 데이터의 마이그레이션
- 기존 전역 Notifications pane의 UI·검색·상세 동작 변경

## 4. 플러그인 루트와 materialized tree 계약

Notes에 최상위 블릿을 제공하는 모든 내장 플러그인은 다음을 가진다.

1. 앱 코드에 등록된 고정 `plugin` ID
2. 플러그인 ID로부터 결정되는 고정 루트 UUID
3. 하나의 실제 최상위 Notes 루트 행
4. 그 루트와 같은 UUID를 가진 독립 Markdown 파일
5. 파일의 플러그인 표식, materialized child metadata 및 저장소 경계
6. 허용·금지 동작을 검사하는 저장소 경계

첫 구현은 `github-notifications` 하나만 등록한다. 두 번째 플러그인이 생기기 전에는 동적 등록, 설정 스키마, 범용 명령 디스패처를 만들지 않는다.

GN의 루트 UUID와 제목은 코드 상수다. 모든 기기가 같은 UUID와 표준 파일명을 만들므로 iCloud conflict copy가 생겨도 동일 루트로 병합할 수 있다.

### 4.1 Projection과 materialization의 경계

| 항목 | projection-only 원격 알림 | materialize된 날짜/알림 | 사용자 블릿 |
| --- | --- | --- | --- |
| `notes_nodes` | 없음 | 있음 | 있음 |
| GN Markdown | 없음 | 일반 bullet + plugin metadata | 일반 bullet |
| 제목·note 권위 | GitHub/캐시 | GitHub snapshot | 사용자 |
| content·직접 삭제 보호 | plugin-owned 규칙 | plugin-owned 규칙 | 개별 `is_readonly`가 true일 때 |
| 하위 블릿 | 만들기 전에 materialize | 허용 | 허용 |
| 원본이 source에서 사라질 때 | 화면에서 사라짐 | 마지막 snapshot과 children 유지 | 유지 |

source refresh는 materialize된 `notification_key`를 먼저 찾는다. 같은 canonical external key의 원격 알림을 projection으로 중복 렌더링하지 않고, 저장된 notification의 snapshot만 갱신한다. 원격 목록에 더 이상 없으면 이를 삭제·tombstone·비동기 정리하지 않는다.

### 4.2 구조 경계

- GN root의 직접 자식은 `github-notifications-date` metadata를 가진 날짜 anchor만 허용한다.
- 날짜 anchor의 직접 자식은 materialize된 GitHub notification 또는 일반 Notes sibling이다.
- materialize된 notification은 일반 Notes 자식을 가질 수 있다. 그 descendants에는 plugin metadata를 붙이지 않는다.
- 일반 user node를 GN root 바로 아래에 만들거나, GN root를 다른 node 아래로 옮기거나, GN root를 다른 node의 부모로 쓰는 요청은 저장소에서 거부한다.
- 날짜 anchor와 materialize된 notification의 식별 metadata를 일반 Notes importer·exporter가 보존해야 한다. metadata가 없는 일반 bullet은 사용자 node로 취급한다.

GN 소유 행의 허용·금지 동작은 일반 readonly와 별도인 다음 고정 계약을 저장소에서도 검사한다.

| GN 소유 행 | 사용자에게 허용 | 일반 Notes mutation으로 거부 | 권위 있는 내부 mutation |
| --- | --- | --- | --- |
| root | 같은-parent 최상위 순서 변경, root 접힘, focus·줌 | title·note·attachment, 완료·별표·보관·Trash·삭제·복제, 일반 child 생성, reparent | seed·merge·export |
| date anchor | 날짜 접힘, focus, 승인된 user child 배치 | title·note·attachment, `completed_at`·별표·보관·Trash·삭제·복제·reparent·reorder | materialization, 빈 anchor 정리 |
| notification | caret·임시 입력·복사, 웹 열기, mark-read, 일반 child 생성 | persisted title·note·attachment, `completed_at`·별표·보관·Trash·삭제·복제·reparent·reorder | provider snapshot 갱신, 날짜 이동 |

repository 직접 호출도 이 계약을 통과해야 한다. UI에서 메뉴를 숨기거나 shortcut을 consume하는 것은 오류 피드백과 일관성을 위한 첫 방어선일 뿐 권한 경계가 아니다. GN root의 최상위 reorder는 subtree 안에 readonly 일반 node가 있어도 허용하고, date·notification의 provider mutation은 그 readonly 값을 보존한다.

### 4.3 날짜 이동

source refresh에서 받은 `updatedAt`이 저장된 `notification_updated_at`과 **다르고** 그 새 값이 다른 날짜 key를 가리킬 때만 다음을 하나의 plugin transaction으로 한다. 값이 같으면 로컬 시간대 차이로 key 계산이 달라져도 이동하지 않는다 — 이 가드가 없으면 시간대가 다른 두 기기가 같은 알림을 각자의 로컬 날짜 anchor로 반복 reparent하는 ping-pong이 생긴다. 이동 결정은 새 `updatedAt`을 처음 수신한 기기가 자신의 로컬 달력으로 한 번 내리고, 나머지 기기는 동기화된 parent를 그대로 받아들인다.

1. 새 날짜 key의 anchor를 찾고, 없으면 plugin-owned anchor를 만든다.
2. 해당 알림과 그 descendants만 새 anchor로 reparent한다.
3. 기존 날짜 anchor 아래의 들여쓰기하지 않은 일반 sibling은 그대로 남긴다.
4. 기존 anchor에 남은 child가 하나도 없으면 plugin-owned 빈 anchor만 제거한다. 일반 sibling이나 다른 저장 알림이 하나라도 있으면 보존한다.

새 provider title·note·metadata와 `notification_updated_at` 저장, 새 anchor 생성, notification subtree reparent와 빈 이전 anchor 정리는 모두 같은 transaction에서 commit하거나 함께 rollback한다.

이동은 사용자 descendants의 UUID, 순서, 완료·별표·접힘·readonly 상태를 바꾸지 않는다. 사용자 블릿을 원격 정렬로 다시 배치하거나 삭제하지 않는다.

## 5. GN Markdown 형식

Notes topic 형식을 v3으로 올리고 GN 파일은 다음처럼 기록한다.

```md
---
kind: yonalist-notes
format_version: 3
id: <고정 GN 루트 UUID>
sort_key: 2048
max_hlc: <HLC>
root_hlc: <HLC>
root_collapsed: false
root_starred: false
root_completed_at: -
root_archived_at: -
plugin: github-notifications
plugin_children: hybrid
collapsed_groups: ["2026.07.23"]
---
# Github Notifications

- [ ] 2026.07.23 <!-- yid: <date-anchor UUID> t: <HLC> plugin: github-notifications-date date_key: 2026.07.23 -->
  - [ ] [#45] 메뉴얼 검색 및 RAG 응답 구현 #121 <!-- yid: <notification UUID> t: <HLC> plugin: github-notification notification_key: <serialized-external-key> notification_type: issue notification_url: <URL> notification_updated_at: <RFC3339> notification_unread: true -->
    arc-agent, 9h ago, seen 6h ago
    - [ ] 사용자 하위 블릿 <!-- yid: <UUID> t: <HLC> -->
  - [ ] 알림에서 Enter로 만든 일반 sibling <!-- yid: <UUID> t: <HLC> -->
```

### 5.1 공통 루트 정보

- `id`, `sort_key`, `root_hlc`, `root_collapsed`, `plugin`은 기존 GN root 계약과 같다.
- `plugin_children: hybrid`는 projection-only 원격 행과 Markdown에 materialize된 plugin tree가 함께 존재한다는 뜻이다.
- `collapsed_groups`는 접힌 날짜 `YYYY.MM.DD` key의 JSON 배열 **한 줄**이다. `plugin_state`와 같은 표현이라 저장과 파일 사이에서 문자 그대로 round-trip한다. 배열 안의 중복 key는 파싱 시 하나로 정규화하고, 내보낼 때 날짜 오름차순으로 정렬한다.
- 같은 frontmatter key를 여러 줄 반복하는 표현은 쓰지 않는다. 기존 파서의 “중복 인식 필드는 격리” 불변식(`quarantines_duplicate_recognized_frontmatter_fields`)을 필드별 예외 없이 유지하기 위해서다. `collapsed_groups` 줄이 두 번 나오면 다른 필드와 똑같이 격리한다.
- `root_starred`, `root_completed_at`, `root_archived_at`은 GN root에서 항상 비활성이다.

### 5.2 날짜와 알림 metadata

- `github-notifications-date`는 GN root 직속 날짜 anchor만 식별한다. `date_key`는 실제 `YYYY.MM.DD` 날짜여야 한다.
- `github-notification`은 `notification_key`로 source record와 연결한다. 값은 기존 `serializeExternalBulletKey({ providerId: "github", connectionId: githubSourceConnectionId(apiBaseUrl, accountId), remoteId: threadId })`의 정확한 결과다. 따라서 같은 thread ID라도 GitHub 서버나 계정이 다르면 충돌하지 않는다.
- date anchor UUID는 `Uuid::new_v5(&GN_UUID, date_key.as_bytes())`, notification UUID는 `Uuid::new_v5(&GN_UUID, notification_key.as_bytes())`로 유도한 뒤 **version nibble을 `4`, variant nibble을 `8`로 정규화**한다. `validate_note_id`(`types.rs`)는 canonical UUID v4 형태만 통과시키므로 v5 비트를 그대로 쓰면 모든 anchor·notification 행이 검증에서 거부된다. 정규화는 결정성을 유지하고(같은 입력은 항상 같은 출력) 충돌 확률 변화는 무시할 수 있다. 같은 날짜와 같은 연결의 같은 알림은 모든 기기에서 같은 UUID를 얻고 다른 연결은 다른 UUID를 얻는다.
- `notification_type`, `notification_url`, `notification_updated_at`, `notification_unread`는 마지막 provider snapshot metadata다.
- notification bullet의 일반 title과 supporting note가 마지막 provider title과 note snapshot이다. source refresh가 이 두 값과 metadata를 갱신한다.
- metadata 값은 Markdown comment parser가 안정적으로 escape·unescape할 수 있는 기존 scalar encoding만 사용한다. URL·timestamp처럼 공백 없는 값은 token으로, title/note처럼 공백 또는 줄바꿈이 가능한 값은 일반 bullet content로 저장한다.
- `notification_unread`는 provider filter와 mark-read의 상태이며 Notes `completed_at`과 교환하지 않는다.

### 5.3 허용되는 body와 검증

GN Markdown body는 빈 projection 전용 파일일 수도 있고, 위와 같은 **제한된 materialized Notes tree**일 수도 있다. 일반 bullet body 전체를 금지하지 않는다.

- root note와 GN root의 일반 direct child는 허용하지 않는다.
- 날짜 anchor는 note를 갖지 않고, 일반 title 편집 대상도 아니다.
- notification metadata가 붙은 bullet은 title/note의 provider-authoritative snapshot과 표준 Notes descendants를 가질 수 있다.
- GN root·날짜 anchor·notification은 `root_readonly`나 `readonly` metadata를 기록하지 않는다. 값이 false여도 필드나 token의 **존재 자체가 invalid**다. parser·merger는 해당 GN 파일을 격리하고, exporter는 plugin-owned DB 행의 `is_readonly`가 `NULL`이 아니면 조용히 생략하지 않고 invariant 오류를 반환한다. 이들의 보호 원본은 plugin 표식이다. GN 아래의 일반 user node에는 일반 readonly metadata를 허용한다.
- 날짜 anchor가 아닌 direct child, 잘못된 date key, 중복·파싱 불가능·provider 불일치 `notification_key`, 잘못된 root UUID·제목·plugin 표식, 또는 GN root 금지 상태는 동기화 오류로 격리한다. 저장된 사용자 descendants를 조용히 삭제하거나 덮어쓰지 않는다.

## 6. 저장 모델과 단일 기준

GN root, materialize된 날짜 anchor, materialize된 notification, 그리고 그 아래 사용자 tree만 `notes_nodes`에 저장한다.

| 데이터 | 저장 위치 | 원본 |
| --- | --- | --- |
| GN root UUID·순서·root 접힘 | `notes_nodes`와 GN Markdown | 기존 Notes HLC 병합 |
| 접힌 날짜 key 집합 | GN root `plugin_state`와 frontmatter | 기존 root HLC 병합 |
| projection-only 날짜·알림 | 현재 GitHub snapshot/캐시 | GitHub |
| 저장 알림 title·note·type·URL·`updatedAt`·읽음 snapshot | materialized `notes_nodes`와 GN Markdown | GitHub refresh |
| 저장 알림의 사용자 descendants | `notes_nodes`와 GN Markdown | 기존 Notes HLC 병합 |
| 저장 알림의 날짜 부모 | date anchor parent 관계 | GitHub `updatedAt`에서 계산 |
| 일반 Notes readonly | `notes_nodes.is_readonly`와 일반 Markdown metadata | 기존 node HLC 병합 |

`notes_nodes`에는 nullable `plugin_state TEXT`를 추가한다.

- 일반 Notes 행은 `NULL`이다.
- GN root는 접힌 날짜 key의 정렬·중복 제거 JSON 배열을 사용한다. 빈 상태는 `[]`이고, 예시는 `["2026.07.22","2026.07.23"]`다.
- 이 값은 일반 note, 검색, 태그·날짜 추출, Markdown body, title/note 편집 payload에 포함하지 않는다.
- 고정 GN root만 validator를 통과한 값을 쓸 수 있다.

materialize된 날짜 anchor와 notification은 `notes_nodes`에 nullable `plugin_meta TEXT`를 추가해 식별한다.

- 일반 사용자 행은 항상 `NULL`이다. 날짜 anchor는 `{kind, date_key}`, notification은 `{kind, notification_key, type, url, updated_at, unread}` JSON을 담고, Markdown comment metadata와 이 값이 round-trip한다.
- **`plugin_meta IS NOT NULL`(또는 GN root의 고정 UUID)이 plugin-owned 행의 단일 판별 술어다.** FTS 트리거(`notes_nodes_search_insert/update`)의 WHEN 절, Recent·Starred·Tags·Archive·Trash 쿼리, Notes 검색, 다중 선택·일괄 mutation이 전부 이 술어 하나로 제외한다. 쿼리마다 고정 UUID나 제목을 나열하는 ad-hoc 제외를 만들지 않는다. §2.1의 노출 제한은 이 술어의 결과이지 화면별 분기가 아니다.
- 현재 FTS 트리거는 무조건 색인하므로(schema의 `notes_nodes_search_insert`) 이 술어를 넣지 않으면 GN root 제목과 저장 알림 제목이 Notes 검색에 노출되고, 접힘 갱신마다 `updated_at`이 올라 GN root가 Recent 상단에 상주한다. 두 회귀 모두 테스트로 고정한다.

일반 Notes readonly는 `notes_nodes`에 `is_readonly INTEGER DEFAULT 0 CHECK (is_readonly IN (0, 1) OR is_readonly IS NULL)`을 추가하고 frontend의 optional `NoteNode.isReadonly?: boolean`으로 노출한다.

- 일반 root와 모든 깊이의 일반 user node는 항상 `0` 또는 `1`을 가지며 메뉴에서 이 값을 변경한다. GN 고정 root와 `plugin_meta IS NOT NULL`인 행은 `NULL`이고 frontend에서도 `isReadonly`를 제공하지 않는다. plugin-owned 보호는 이 필드를 읽지 않으며 Markdown에도 내보내지 않는다.
- readonly 변경은 일반 root에서는 기존 root HLC, 하위 node에서는 기존 행 HLC와 dirty/export·Undo/Redo 경로를 사용한다. 별도 readonly HLC, origin enum이나 capability table은 만들지 않는다.
- readonly는 descendants에 상속하지 않는다. 다만 사용자 구조 mutation의 대상 node 자체 또는 함께 이동되는 subtree 안에 readonly node가 있으면 구조 이동 전체를 거부한다.
- content·attachment mutation, 직접 삭제·잘라내기·Trash 이동은 target이 readonly인지 저장소에서 다시 검사한다. UI의 disabled 상태나 shortcut consume만 신뢰하지 않는다.
- 일반 ancestor 삭제의 preflight는 readonly descendant 존재 여부를 반환한다. 확인 전에는 아무것도 쓰지 않고, 사용자가 경고에서 `삭제`를 선택한 두 번째 요청만 명시적 `allowReadonlyDescendants: true`를 보낸다. 저장소는 같은 transaction에서 다시 검사한 뒤 전체 tree를 원자적으로 삭제한다. 이 flag는 target 자체가 readonly인 직접 삭제를 허용하지 않는다. 다중 선택은 삭제 대상들을 한 번 검사해 경고를 하나만 띄우고 승인 또는 취소를 전체 batch에 원자적으로 적용한다.
- 확인된 표준 삭제 mutation과 tombstone은 다른 기기에서 다시 묻지 않고 기존 동기화 규칙으로 적용한다. 그렇지 않으면 replica마다 다른 선택으로 tree가 갈라진다.
- 일반 readonly 복제는 원본 tree의 `is_readonly` 값을 보존한다. plugin-owned 행 복제는 기존 plugin 경계에서 거부한다.
- 이 보호는 사용자 content·delete·move mutation의 경계다. 기존 Markdown merge, 동기화 tombstone, Undo/Redo와 provider-authoritative GN refresh는 각자의 검증된 저장 경로를 따른다. 따라서 notification이 날짜를 바꿀 때 그 subtree의 일반 child가 readonly여도 §4.3의 plugin mutation은 전체 subtree를 보존한 채 이동할 수 있다.

날짜 접힘 명령은 `{rootId, groupKey, collapsed}`를 받아 트랜잭션에서 집합을 수정한다. 재시도해도 같은 결과가 나며 `groupKey`는 실제 날짜여야 한다. 이 변경은 기존 Notes mutation/history 경로를 사용해 Undo/Redo에 포함한다.

materialization, source snapshot 갱신, 날짜 이동은 plugin metadata를 검증하는 전용 저장소 mutation을 사용한다. source refresh는 현재 snapshot보다 오래된 `notification_updated_at`으로 title/note·type·URL을 되돌리지 않고, 더 최신 snapshot만 반영한 뒤 기존 dirty/export 경로를 탄다. 성공한 mark-read는 같은 `updatedAt`이어도 `notification_unread: false`를 기록하며, 같은 시각의 오래된 캐시가 이를 다시 true로 바꾸지 못하게 한다. GitHub에서 record가 빠진 경우에는 mutation을 만들지 않는다.

날짜 접힘, root 접힘, root 순서가 서로 다른 기기에서 동시에 바뀌면 기존 Notes와 같은 root 행 HLC last-write-wins를 적용한다. materialize된 일반 트리는 기존 node HLC 병합을 따른다. 별도 CRDT나 플러그인 전용 정렬 테이블은 만들지 않는다.

## 7. 생성, 시작 및 iCloud 합류

앱 시작 순서는 다음과 같다.

1. Vault의 기존 Markdown 파일을 먼저 스캔하고 병합한다.
2. 고정 GN UUID의 정상 플러그인 파일 또는 root 행이 있는지 확인한다.
3. 정상 파일이 있으면 GN root와 materialized tree를 병합한다.
4. root 행만 있고 표준 파일이 없으면 root와 materialized tree를 dirty로 표시하여 파일을 다시 발행한다.
5. 둘 다 없을 때만 기본 펼침 상태의 GN root를 한 번 생성한다.
6. GN root가 새로 생성되면 일반 root dirty/export 경로로 Markdown을 발행한다.
7. 그 뒤 기존 pending export를 처리하고 watcher를 계속 실행한다.

최초 seed의 기본 `sort_key`는 새 일반 최상위 Notes root와 같은 기존 위치 할당 함수를 사용한다. 사용자가 이후 일반 drag 정렬로 위치를 정하며 고정된 “항상 첫 번째” 규칙은 적용하지 않는다.

**seed는 epoch(최소) HLC로 기록한다.** `notes_nodes_hlc_ai` 트리거는 `WHEN NEW.hlc = ''`일 때만 현재 시각 HLC를 발급하므로, seed INSERT는 명시적 epoch HLC를 넣어 트리거를 우회한다. 이 규칙이 없으면 다음 역전파가 생긴다: iCloud dataless 창 때문에 파일을 보지 못한 기기가 5단계로 seed를 만들고, 그 seed는 시계상 최신 HLC를 가지므로 §8의 행 단위 LWW에서 늦게 도착한 원격 순서·접힘을 거부할 뿐 아니라, export를 타고 vault를 공유하는 **모든 기기의 GN root 상태를 pristine으로 되돌린다**. 고정 UUID는 중복을 없애는 대신 잘못된 seed를 자기증식시키므로, 행 레벨 no-clobber는 epoch HLC로만 보장된다. 파일 레벨 no-clobber(아래 목록)와 행 레벨 epoch HLC는 서로 다른 층을 지키며 둘 다 필요하다.

Notes 데이터 초기화 등으로 GN root가 삭제된 뒤 재시드되는 모든 경로에도 같은 epoch HLC 규칙을 적용한다. 그렇지 않으면 한 기기의 초기화가 다른 기기의 GN 상태를 덮는다.

격리된 GN 파일이 있으면 “파일 없음”으로 간주해 새 seed나 재발행으로 덮지 않는다. 사용자가 오류를 확인하고 개발 데이터를 초기화하거나 파일을 바로잡을 때까지 플러그인 동기화 오류를 유지한다.

첫 발행 직전에 iCloud가 같은 표준 파일을 전달할 수 있다. 최초 GN 파일 생성은 기존 파일을 덮어쓰지 않는 방식으로 수행한다.

- 목적지 파일이 없으면 원자적으로 생성한다.
- 같은 내용이 이미 있으면 발행 완료로 기록한다.
- 다른 내용이 먼저 도착했으면 덮어쓰지 않고 watcher 병합을 기다린다.

## 8. Markdown 병합 규칙

GN root는 일반 Notes의 root HLC 흐름을 그대로 사용한다.

- 더 높은 `root_hlc`의 `sort_key`, `root_collapsed`, 접힌 날짜 key 집합이 함께 이긴다.
- epoch HLC의 seed 상태는 도착하는 모든 원격 GN root 상태에 진다(§7). seed가 원격 상태를 이기는 유일한 경로는 사용자가 seed 이후 실제로 조작해 새 HLC를 얻는 것이다.
- materialize된 date anchor·notification·사용자 node는 표준 node HLC 병합과 parent 검증을 따른다.
- 일반 node의 `is_readonly`는 title·note·parent·sort·완료·접힘과 같은 행 HLC로 병합한다. 더 최신 행 전체가 이기며 readonly만을 위한 별도 conflict resolution은 만들지 않는다.
- source refresh로 갱신되는 notification content snapshot은 metadata의 `notification_updated_at`보다 최신인 GitHub source만 적용한다. 성공한 mark-read의 `notification_unread: false`는 같은 timestamp의 오래된 캐시보다 우선한다. 임시 UI 입력은 이 snapshot을 이길 수 없다.
- 동일 UUID의 conflict copy는 별도 GN root를 만들지 않고 하나의 topic으로 병합한다.
- 원격 source가 사라져도 저장된 notification의 metadata, title/note snapshot, user tree를 tombstone 처리하지 않는다.
- 사람이 metadata를 손상시키면 자동 정리로 children을 지우지 않고 파일을 격리한다.

## 9. UI 합성

### 9.1 한 번만 순회하는 루트 목록

좌측 목록과 `All`은 모두 저장된 `rootIds`를 한 번만 순회한다.

- ID가 고정 GN UUID면 동작이 제한된 plugin root 행을 렌더링한다.
- 그 외에는 기존 일반 Notes root 행을 렌더링한다.

좌측 GN은 기존 `NotesExternalLibraryPageRow`의 액션 없는 구조를 `rootIds` 순회 안에서 재사용한다. 우측 GN root, 날짜 anchor, notification, user node는 기존 `notes-node-*` outline 구조와 CSS를 재사용한다. GN root만 editor와 더보기 메뉴를 렌더링하지 않는다.

### 9.2 혼합 child 합성

GN root의 화면 child는 다음 세 종류를 날짜 key마다 하나의 그룹으로 합성한다.

1. materialize된 날짜 anchor와 그 저장 tree
2. 같은 날짜의 projection-only 원격 notification
3. 연결·로딩·빈 결과·오류/retry 같은 비저장 상태 행

저장된 `notification_key`와 같은 원격 record는 2에서 제외한다. materialize된 date anchor가 있으면 그 anchor를 group container로 쓰고, 없으면 runtime 날짜 행을 쓴다. 이 방식은 저장된 user sibling과 saved notification의 subtree를 표준 Notes node로 유지하면서도 아직 저장하지 않은 원격 알림을 계속 표시한다.

합성 순서는 다음 하나로 고정한다.

1. 날짜 그룹은 `date_key` 내림차순으로 표시한다.
2. 각 날짜 안에서는 materialize된 notification과 일반 user sibling을 저장된 `sort_key` 순서로 먼저 표시한다.
3. 이어서 projection-only notification을 `updatedAt` 내림차순, canonical `notification_key` 오름차순 tie-break로 표시한다.
4. 연결·로딩·오류/retry 상태 행은 날짜 그룹 앞에 한 번, empty 상태는 보이는 날짜 그룹이 없을 때만 표시한다.

이 순서는 provider 정렬보다 저장된 user tree 안정성을 우선한다. projection notification을 처음 materialize하면 destination 날짜의 저장 block 끝에 notification을 넣고, title/note `Enter`가 만든 sibling을 그 바로 다음에 둔다. 같은 날짜의 source refresh는 저장 block을 재정렬하지 않는다. 다른 날짜로 이동하면 notification subtree만 새 날짜 저장 block 끝으로 옮기며 descendants의 내부 순서는 유지한다. 따라서 materialization 직후 projection block에서 저장 block 끝으로 한 번 위치가 바뀔 수 있지만, 이후 Markdown reload와 refresh에서는 사용자 sibling을 원격 정렬로 흔들지 않는다.

- `All`: GN sortable root 행 다음에 합성 child 영역을 두고, `root.isCollapsed === false`일 때만 표시한다.
- GN 줌: root collapse를 무시하고 header 다음에 같은 합성 child 영역을 표시한다.
- root 정렬용 `sortableIds`에는 일반 root와 GN root만 넣는다. `selectionVisibleIds`에는 GN 안의 일반 사용자 Notes 블릿만 포함하고, plugin-owned GN root·materialize된 날짜 anchor·materialize된 notification·projection-only 행은 제외한다.
- projection-only 날짜·알림·상태 행은 `nodesById`, `childIdsByParent`, `sortableIds`, `selectionVisibleIds` 어느 곳에도 넣지 않는다. materialize된 날짜와 notification은 저장 node map에는 있지만 사용자 선택·일괄 mutation 대상에는 넣지 않는다.
- 키보드 Arrow 이동은 별도의 합성된 editor 화면 순서를 사용해 plugin-owned title/note와 사용자 title/note를 건너뛰지 않는다. `ExternalLink`는 기존 버튼처럼 DOM Tab 순서로 접근한다. 이 두 focus 순서는 Notes 다중 선택 목록과 분리한다.
- GN sortable DOM 범위에는 GN root 행만 넣어 projection 영역의 높이가 root drag/drop 사각형을 키우지 않게 한다.

GN 줌은 일반 breadcrumb/back/history를 유지한다. GN root header에는 page menu와 root-level create를 노출하지 않는다. notification title의 `Enter`와 사용자 블릿의 일반 구조 명령만으로 트리를 만든다.

### 9.3 source 활성화와 상태 행

GitHub source lease, polling과 날짜 label을 다시 계산하는 1분 projection clock은 다음 중 하나가 참인 동안 활성화한다.

- `All`에서 GN root가 펼쳐져 합성 child 영역이 보임
- `zoomRootId === GN_UUID`

GN이 접힌 `All`에만 있고 줌 중이 아니면 마지막 정상 캐시를 유지하되 화면에 보이지 않는 projection을 위해 새 lease를 잡지 않는다.

Notes outline이 위 조건에서 최소 boolean `githubProjectionRequested`를 올리고 App은 이 신호로만 lease와 projection clock을 제어한다. `NotesDetailPane`은 이 신호가 아니라 `zoomRootId`로만 All/일반 줌/GN 줌을 결정한다.

상태 행은 GN 줌에서는 header 아래, `All`에서는 펼친 GN의 합성 child 영역에 나타난다. 상태 행은 Notes 저장·선택·정렬 대상이 아니다.

### 9.4 이동 경계와 접근성

- GN을 drag하면 결과 `parentId`는 항상 `null`이어야 한다.
- GN을 drop parent나 `Move To` 대상으로 사용할 수 없다.
- Tab/Shift+Tab으로 GN 안팎에 계층을 만들 수 없다.
- materialize된 date anchor와 notification 자체는 사용자 delete·reparent·outdent·일괄 mutation을 거부하고 해당 구조 shortcut을 UI에서 consume한다. 그 안의 사용자 블릿은 일반 Notes의 Tab/Shift+Tab, drag, paste, restore/reparent 검증을 사용하되 plugin 경계 밖으로 provider-owned parent를 끌어내지 않는다.
- 날짜 수준의 일반 user node는 notification 아래로 들여쓰고 다시 날짜 수준으로 한 번 내어쓸 수 있다. 그 상태에서 두 번째 `Shift+Tab`은 GN root 아래의 잘못된 일반 direct child를 만들지 않고 기존 outline boundary처럼 shortcut을 consume한다.
- projection-only notification은 sortable context에 넣지 않는다. user node drop을 받는 별도 non-sortable target만 등록하고, drop commit 한 번에서 materialization과 reparent를 수행한다.
- notification의 `Cmd/Ctrl+Enter`와 Notes 완료 메뉴는 mark-read adapter를 호출한다. 일반 checkbox toggle과 undo-to-unread를 노출하지 않는다.
- GN root와 날짜 그룹의 접힘 버튼은 `aria-expanded`를 저장 상태와 일치시킨다. 날짜 그룹은 키보드로 접기·펼치기가 가능하다.
- notification title/note editor는 일반 editor와 동일하게 caret·selection을 지원한다. blur/refresh 복원을 보조기술에도 변경 알림으로 전달한다.
- pane은 저장 여부와 무관한 **합성 editor focus 순서**를 한 번 만들고 provider title/note와 일반 user title/note를 연결한다. ArrowUp/Down과 title 시작·끝의 ArrowLeft/Right는 provider 행과 일반 행 모두 pane adapter를 거쳐 이동한다. 저장 node 전용 `nodesById` focus/selection action에 projection ID를 억지로 넣지 않는다. `ExternalLink`는 이 Arrow 순서가 아니라 기존 DOM Tab 순서에 남긴다.
- mark-read filter, root/date collapse 또는 refresh로 focus된 row가 unmount되면 pane adapter는 직전의 visible title, 없으면 다음 visible title, 둘 다 없으면 GN root/header로 focus를 복구한다.
- provider title/note handler는 구조적 Backspace, 삭제·잘라내기·복제·재정렬 shortcut과 `Tab`·`Shift+Tab`을 Notes mutation handler보다 먼저 consume한다. 일반 user descendants는 기존 resolver를 그대로 사용한다.
- 일반 readonly도 archive/trash용 별도 `readOnlyMode` 표시 branch를 쓰지 않고 normal `OutlineNodeRow` title/note markup과 focus resolver를 사용한다. 차이는 draft flush, content·delete·move mutation만 보호된다는 점이다.
- 일반 readonly node의 `Tab`·`Shift+Tab`, drag/reorder와 `Move To`는 consume하거나 저장소에서 거부한다. 그 아래의 일반 child는 기존 resolver를 사용한다.
- 일반 readonly와 GN 소유 row의 잠금 아이콘은 title 바로 뒤의 같은 inline trailing cluster에서 hover 또는 `:focus-within`일 때만 보인다. pane 오른쪽 끝에 별도 action rail을 만들지 않는다. 아이콘은 장식성이라 tab stop을 추가하지 않고, Type과 `ExternalLink` 버튼은 텍스트 대체 이름과 tooltip을 유지한다.

## 10. 일반 Notes 블릿 접힘·readonly Markdown 동기화

이 변경은 GN root·hybrid child tree·날짜 접힘·UI 통합이 끝난 뒤 마지막 구현 단계로 진행한다. 접힘과 readonly 모두 기존 root/node HLC와 metadata parser를 재사용한다.

### 10.1 파일 표현

일반 최상위 root는 frontmatter에 접힘 상태를 기록한다.

```yaml
root_collapsed: true
root_readonly: true
```

일반 root exporter는 `root_readonly: true|false`를 항상 한 줄 기록한다. 일반 하위 블릿은 기존 metadata comment에 값이 true일 때만 `collapsed`와 `readonly` token을 추가한다.

```md
- [ ] 접어 둔 읽기 전용 블릿 <!-- yid: <UUID> t: <HLC> collapsed readonly -->
```

- `collapsed` token이 없으면 펼침이다.
- `readonly` token이 없으면 편집 가능하다. child의 false 값은 별도 token으로 기록하지 않는다.
- 별표 `star`, 이동 출처 `from:`, GN plugin metadata와 같은 comment parser를 재사용한다.
- root와 모든 깊이의 일반 하위 블릿에 같은 의미를 적용한다. readonly는 descendants에 상속하지 않는다.
- GN root frontmatter에는 `root_readonly`를 쓰지 않고 plugin-owned date·notification comment에도 `readonly`를 쓰지 않는다. GN 안의 일반 user node는 `readonly`를 쓸 수 있다.
- GN date anchor의 접힘은 예외적으로 `collapsed_groups`가 권위다.

### 10.2 동기화 의미와 형식 호환성

- 일반 Notes의 접기·펼치기 명령은 이미 해당 node HLC를 갱신하므로 별도 `collapse_hlc`를 추가하지 않는다.
- 일반 root의 `root_readonly`는 `sort_key`·`root_collapsed`와 같은 `root_hlc`로 병합하고, 하위 node의 `readonly`는 `is_collapsed`·content·parent·sort와 같은 node HLC로 병합한다. exporter는 현재 값을 파일에 기록하고 parser·merger는 더 최신 root/row 전체를 적용한다.
- readonly는 보안 권한이 아니라 동기화되는 로컬 편집 보호다. Markdown watcher·원격 merge·Undo/Redo처럼 이미 승인된 저장 경로는 행 LWW에 따라 readonly node의 content와 readonly 값 자체를 갱신할 수 있다. UI 임시 입력만 보호를 우회하지 못한다.
- **알려진 트레이드오프**: 접힘이나 readonly 토글은 행 HLC를 올리므로 다른 기기의 동시 title·note, parent·order, completion 또는 상대 flag 변경과 충돌하면 더 최신 **행 전체**가 이긴다. 예를 들어 한 기기의 오프라인 제목 편집보다 다른 기기의 나중 접힘 토글이 이기면 편집 텍스트가 사라질 수 있고, 반대로 나중 content/move 행이 readonly 토글을 되돌릴 수도 있다. 필드 단위 HLC와 CRDT는 비대상이므로 이 full-row LWW 손실을 수용하고 대표 content·parent/order·completion 충돌 테스트로 고정한다.
- **Undo 정책**: GN 날짜 접힘은 §6대로 Undo/Redo에 포함한다. 일반 블릿 접힘의 Undo 포함 여부는 기존 동작을 바꾸지 않고 유지하며 회귀 테스트로 고정한다. 접힘 계열 동작의 history 정책이 화면마다 달라지지 않게 한다.
- `format_version: 3`은 일반 접힘·readonly와 GN hybrid tree를 포함하는 새 개발 형식이다. `plugin_state`, `plugin_meta`, `is_readonly` 추가에 맞춰 Notes SQLite schema version도 올린다.
- GN만 먼저 v3로 쓰는 혼합 기간을 두지 않고, GN bootstrap·모든 일반 topic 접힘·format 상수·SQLite schema를 마지막 통합 단계에서 한 번에 전환한다. 다만 회귀 이등분이 가능하도록 v3 **파서 수용**(read)은 writer·seed 전환보다 한 커밋 앞서 넣는다. 그 사이 v3 파일은 아직 생성되지 않으므로 혼합 형식 기간은 생기지 않는다.
- `yonalist-notes`와 `yonalist-trash`가 같은 format version 상수를 사용하므로 `trash.md` envelope도 v3로 올라간다. 최종 parser는 두 kind 모두 정확히 v3만 받는다.
- 사용자가 마이그레이션을 원하지 않았으므로 v2 파일이나 이전 SQLite schema를 자동 변환하는 코드와 호환 분기를 만들지 않는다.

## 11. 오류와 데이터 안전

- GN API 새로고침 실패는 root 파일, 날짜 접힘, 저장 알림 snapshot, user tree를 바꾸지 않는다.
- 웹 열기 실패는 GitHub 읽음 상태를 바꾸지 않는다. `viewedAt` 기록은 기존 `openNotification` 동작을 따른다.
- mark-read 실패는 `unread` snapshot을 유지한다.
- source refresh가 저장 알림을 찾지 못하면 마지막 snapshot과 children을 유지한다.
- 손상된 GN frontmatter, 날짜/notification metadata, 또는 제한된 tree 경계 위반은 격리하고 자동 덮어쓰지 않는다.
- GN root 아래의 metadata 없는 child, 일반 root note, 잘못된 date parent 같은 불변식 오류는 exporter가 숨기지 않고 반환한다.
- 고정 GN UUID를 일반 note로 가져오거나 다른 UUID가 `plugin: github-notifications`를 주장하면 거부한다.
- 일반 readonly content·attachment·직접 삭제·구조 이동 요청은 저장 전에 거부하고 현재 화면 상태를 유지한다. readonly descendant가 있는 ancestor 삭제는 경고 확인 전까지 mutation을 만들지 않는다.
- ancestor 삭제 확인과 실제 commit 사이에 tree가 바뀌면 저장소가 readonly descendant를 다시 검사한다. 새 readonly가 생겼거나 target 자체가 readonly가 되었으면 stale confirmation을 거부하고 최신 상태로 다시 안내한다.
- 사용자가 경고에서 취소하면 HLC·history·Trash·export를 전혀 바꾸지 않는다. 확인 flag로 readonly target 자체를 직접 삭제할 수는 없으며, confirmed ancestor delete transaction이 실패하면 전체 tree와 Trash 상태를 rollback한다.
- 확인된 ancestor 삭제가 성공하면 기존 Trash/tombstone/export를 한 번만 만들고 다른 기기는 이를 재확인 없이 적용한다. 복구 가능한 Trash에서 ancestor를 restore하면 descendant의 readonly도 원래 값으로 복원한다.
- token, API 응답 전문 또는 로컬 민감 경로를 오류에 포함하지 않는다.

## 12. 테스트 전략

모든 구현은 실패하는 테스트를 먼저 추가하는 순서로 진행한다.

### 12.1 형식과 병합

- 일반 v3 root와 모든 깊이의 node `collapsed` round-trip
- 일반 root `root_readonly`와 모든 깊이의 user node `readonly` round-trip, false/누락 기본값, 비상속
- GN root의 plugin 표식, 고정 UUID, 제목, root collapse, `plugin_children: hybrid`, 접힌 날짜 key round-trip
- GN root·date·notification에 `root_readonly`·`readonly`가 존재하면 false 값도 격리하고, plugin-owned DB `is_readonly` non-NULL은 exporter 오류가 되며 GN 아래 일반 user node의 `readonly`는 보존
- materialize된 date anchor와 notification metadata, provider title/note snapshot, user descendants의 Markdown round-trip
- `collapsed_groups` JSON 배열 round-trip, 배열 내 중복 정규화, 안정된 출력 순서, 같은 key 줄 반복 시 격리
- 유도 UUID의 v4 정규화가 결정적이며 `validate_note_id`를 통과
- 접힘·readonly 토글과 원격 title/note·parent/order·completion 변경 충돌에서 문서화된 full-row LWW 결과 고정
- 잘못된 date key, 중복·파싱 불가능·provider 불일치 notification key, 잘못된 UUID, metadata 없는 GN direct child, root note, 불완전 plugin 표식 격리
- 저장 notification source snapshot은 더 새 `notification_updated_at`만 덮어쓰며, source에서 사라져도 snapshot과 descendants를 유지
- `yonalist-notes`와 `yonalist-trash`가 함께 v3로 출력되고 v2·누락된 format version을 거부

### 12.2 생성과 저장소 경계

- 기존 GN 파일과 materialized tree를 seed보다 먼저 병합
- 파일과 행이 없을 때 고정 UUID root를 정확히 한 개 생성
- seed가 epoch HLC를 가지며, seed 뒤에 도착한 더 오래된 원격 GN root 상태가 seed를 이김(행 레벨 no-clobber)
- 데이터 초기화 후 재시드도 epoch HLC를 사용해 다른 기기 상태를 덮지 않음
- 같은 `updatedAt`에서 시간대만 다른 기기의 refresh가 날짜 이동을 만들지 않음
- 정상 GN 행만 남고 표준 파일이 삭제되면 missing-topic recovery가 tree를 포함해 다시 발행
- 손상되어 격리된 GN 표준 파일은 seed/recovery가 덮어쓰지 않음
- GN은 최상위 순서 변경과 root collapse만 일반 root 명령으로 허용
- GN root의 같은-parent 최상위 reorder는 readonly user descendant가 있어도 허용
- repository 직접 호출에서 GN root·date·notification의 persisted title·note·attachment, `completed_at`·별표·보관·Trash·삭제·복제와 금지된 reparent/reorder를 거부하고, root reorder·접힘·mark-read·provider snapshot/date mutation만 고정 계약대로 허용
- 날짜 접힘의 명시적 boolean 명령이 재시도에 안전하고 Undo/Redo에서 복원
- title Enter가 projection notification의 date anchor와 notification을 한 번 materialize한 뒤 빈 일반 sibling을 생성
- 그 sibling의 Tab이 notification child를 만들고, materialized notification 아래 일반 create/paste/restore/reparent가 허용
- GN root 아래 일반 create/paste/import/duplicate/reparent와 GN root의 편집·삭제·보관은 거부
- 일반 root/node readonly 설정·해제가 각각 root/node HLC, dirty/export와 Undo/Redo를 갱신하고 plugin-owned row에서는 거부
- 일반 node의 `is_readonly`는 0/1이고 GN root·date·notification은 DB `NULL` 및 frontend field 없음
- readonly content·attachment·직접 삭제·empty-title Backspace·잘라내기·Trash·직접 이동과 readonly descendant를 포함한 사용자 tree 이동은 거부
- 다른 sibling을 readonly 앞뒤로 옮기거나 일반 node를 readonly parent 아래로 이동하는 것은 허용
- readonly descendant가 있는 일반 ancestor 또는 batch 삭제는 첫 요청에서 아무것도 쓰지 않고 경고를 하나만 반환하며, 명시적 확인 후에만 원자적으로 삭제
- 삭제 경고의 기본 취소는 HLC·history·Trash·export를 바꾸지 않고, confirmation flag는 readonly target 직접 삭제를 허용하지 않으며, transaction 실패는 전체 rollback
- stale ancestor 삭제 확인은 최신 tree에 readonly가 추가되거나 target 자체가 readonly이면 거부
- 일반 readonly tree 복제는 각 node의 flag를 보존하고 readonly 아래 일반 child mutation은 허용
- confirmed ancestor delete의 `yonalist-trash` v3 round-trip과 restore가 descendant readonly를 보존
- source refresh가 저장 notification을 최신 snapshot으로 갱신하고 projection 중복 없이 렌더링
- 날짜 이동에서 notification+descendants만 새 anchor로 이동하고 unindented sibling은 기존 anchor에 남음
- 날짜 이동은 notification의 일반 child가 readonly여도 검증된 plugin mutation으로 subtree를 보존해 이동
- provider snapshot·`notification_updated_at`·새 anchor·subtree reparent·이전 빈 anchor 정리 중 하나가 실패하면 날짜 이동 transaction 전체가 rollback

### 12.3 UI

- 저장 순서 `[일반 A, GN, 일반 B]`가 좌측 목록과 `All`에 동일하게 표시
- GN이 일반 root와 같은 CSS 구조를 쓰고 root editor·더보기 메뉴·root-level create는 없음
- GN 줌에서 notification title Enter와 뒤이은 사용자 sibling의 Tab 들여쓰기가 동작함
- `All`의 root collapse가 합성 child를 숨기고 재로딩 후 복원하며 GN 줌은 root collapse와 무관하게 내용을 표시
- 펼친 `All` GN과 GN 줌이 source lease·polling·1분 projection clock을 활성화하고, 닫히면 해제
- `sortableIds`에는 GN이 있고 projection-only 행은 sortable/selection/node map에 없으며 GN root drag 범위가 합성 child 높이로 커지지 않음
- GN root·date·notification의 row focus·activation·zoom은 동작하지만 Notes 다중 선택과 일괄 mutation에는 들어가지 않음
- GN은 일반 root의 child가 될 수 없고 일반 root도 GN의 child가 될 수 없지만, materialized tree 안의 기존 구조 명령은 동작
- 날짜 그룹은 기본 펼침이고 접힌 날짜 key만 숨기며, `All`과 GN 줌에서 즉시 같은 상태가 반영
- 알림 note에 잘못된 자식 화살표가 없고 Type·기존 Notifications 부제가 표시
- 저장 notification title/note에서 caret·selection·임시 입력이 가능하고 blur, Escape, refresh 때 provider snapshot으로 복원되며 Markdown/HLC/history는 바뀌지 않음
- 일반 readonly도 normal `OutlineNodeRow` title/note markup을 사용하고 임시 title/note 입력이 blur, Escape, 화면 이동에서 저장 snapshot으로 복원되며 Markdown/HLC/history는 바뀌지 않음
- 일반 readonly draft 중 backing row가 Markdown·동기화·Undo/Redo로 바뀌면 최신 persisted snapshot으로 교체되고 row가 남아 있는 동안 focus와 유효한 caret을 유지
- title Enter는 임시 입력을 버리고 바로 다음 일반 sibling으로 focus를 옮김
- 일반 readonly title Shift+Enter, title 경계 ArrowLeft/Right·ArrowUp/Down, note Escape·경계 ArrowUp/Down·Shift+Enter가 기존 focus 규칙을 따르고 새 sibling은 `is_readonly=false`
- IME composition 중 Enter·방향키·Backspace는 구조 mutation을 만들지 않고, 선택 text cut/delete는 임시 draft만 바꾸며 node cut/delete와 empty-title Backspace는 차단
- 일반 readonly의 Tab/Shift+Tab·drag·reorder와 attachment add/remove/resize는 차단되지만 Enter로 만든 일반 sibling은 readonly child로 들여쓸 수 있고 완료·별표·보관·접힘·일반 child 생성은 동작
- provider note의 Escape·ArrowUp/Down·Shift+Enter와 합성 title 순서의 ArrowUp/Down·경계 ArrowLeft/Right가 저장·projection·일반 user 행 사이에서 기존 Notes 규칙대로 이동
- provider-owned 행의 destructive Backspace·delete·cut·duplicate·reorder·Tab/Shift+Tab이 mutation 전에 consume되고, 날짜 수준 user node의 두 번째 Shift+Tab도 boundary no-op
- 구조적 title paste만 notification을 materialize하고, 단일 줄 title paste와 모든 note paste는 임시 입력으로 복원
- projection notification의 non-sortable drop target이 user node drop을 한 번 materialize·reparent하고 projection 행 자체는 sortable 대상이 아님
- 날짜 그룹 내 저장 block(`sort_key`)과 projection block(`updatedAt`, `notification_key`) 순서가 materialization·reload·same-date refresh에서 결정적이고 user sibling을 재정렬하지 않음
- 전용 완료 버튼은 없고 Notes 메뉴와 `Cmd/Ctrl+Enter`가 mark-read를 한 번 요청하며 성공·실패 상태를 올바르게 반영
- `showCompleted=false`가 `unread=false` notification과 descendants만 숨기고, `viewedAt`만 있는 notification은 계속 표시
- 보이는 notification subtree와 날짜 아래 사용자 블릿에는 기존 `completed_at` 필터가 함께 적용됨
- `ExternalLink`가 올바른 URL을 한 번 열고 `viewedAt`만 기록하며 hover/focus-within에서만 보이고 coarse pointer에서는 항상 보임
- 잠금 아이콘과 `ExternalLink`가 0px 간격의 잠금 → `ExternalLink` 순서로 title 바로 뒤에 이어지고, 긴 title만 말줄임되며 pane 오른쪽 끝에는 고정되지 않음
- 숨겨진 `ExternalLink`가 DOM Tab 순서에서 focus되면 즉시 보이고, filter·collapse·refresh로 focus row가 사라지면 가장 가까운 visible title 또는 GN root/header로 focus가 복구됨
- 일반 readonly와 GN 소유 row의 같은 잠금 아이콘이 hover/focus-within에서만 보이고 별도 tab stop을 만들지 않으며 각각 `읽기 전용`·`GitHub에서 관리됨` 상태 이름을 제공
- 연결·로딩·빈 결과·오류/retry 상태 행이 Notes 저장·선택·정렬에 들어가지 않음
- GN과 날짜 접힘 버튼의 키보드 동작 및 `aria-expanded`가 정확하고, notification editor와 `ExternalLink`의 키보드 focus가 보임

### 12.4 기기 간 시나리오

1. 기기 A에서 projection notification의 title에 `Enter`를 눌러 date anchor·notification·일반 sibling을 만들고 sibling을 notification 아래로 들여쓴다.
2. A가 notification title/note에 임시 입력 후 blur하여 source snapshot 복원을 확인한다.
3. A에서 GN root와 날짜 그룹을 접고, Markdown 파일만 새 기기 B의 빈 Vault로 동기화한다.
4. B가 같은 root UUID, 순서, 접힘, 저장 notification snapshot과 사용자 child를 복원하는지 확인한다.
5. B가 source refresh에서 notification의 날짜를 바꾸면 notification+child만 새 date anchor로 이동하고 A에서 만든 unindented sibling은 기존 anchor에 남는지 확인한다.
6. GitHub가 해당 notification을 더 이상 반환하지 않아도 B가 저장 snapshot과 사용자 child를 유지하는지 확인한다.
7. A가 GN 아래 일반 user child를 readonly로 만들고 B에서 flag와 잠금 UI가 복원되는지 확인한다.
8. A가 그 readonly child를 임시 편집 중일 때 B의 Markdown watcher가 readonly를 유지한 새 persisted content를 병합하면 A의 draft가 새 snapshot으로 교체되고 focus가 유지되는지 확인한다.
9. B가 readonly descendant를 포함한 일반 ancestor 삭제를 확인하면 A가 별도 경고 없이 같은 tombstone과 tree 삭제를 병합하는지 확인한다.

### 12.5 회귀 검증

- 외부 알림 mark-read 성공·실패, snapshot rollback 방지, `showCompleted` filter 테스트
- 기존 Notifications pane 검색·Only new·날짜 그룹·상세·웹 열기
- plugin-owned GN root·날짜·notification은 `plugin_meta IS NOT NULL` 단일 술어(FTS 트리거 WHEN 절 포함)로 Recent·Starred·Tags·Archive·Trash·Notes 검색·다중 선택에서 제외되고 사용자 블릿은 기존 규칙을 따름
- 날짜 접힘을 반복해도 GN root가 Recent 상단에 나타나지 않음
- 기존 일반 Notes keyboard resolver와 사용자 descendant 편집·완료·접힘·child 생성 동작이 readonly·GN adapter 추가 뒤에도 유지
- Notes 전체 frontend 및 Rust 테스트
- lint, architecture 검사, production build
- Tauri 개발 빌드에서 직접 순서·materialization·들여쓰기·필터·접힘·readonly 임시 편집·이동 차단·삭제 경고·잠금 표시·재시작·웹 열기 확인

## 13. 구현 순서

1. 고정 GN root, v3 frontmatter, `plugin_children: hybrid`, date/notification metadata parser·validator·fixture를 추가한다.
2. `plugin_state` 날짜 접힘, `plugin_meta` 식별 필드와 단일 제외 술어(FTS 트리거 WHEN 절 포함), 일반 `is_readonly`, GN 제한 tree의 SQLite/schema·parser·exporter·merger 경로를 준비한다.
3. GN bootstrap의 기존 파일 우선 병합과 root 단일 seed/no-clobber 발행을 구현하되 format cutover 전에는 production seed를 활성화하지 않는다.
4. 날짜 anchor와 notification의 on-demand materialization, canonical external key 중복 방지, 일반 child 허용, 날짜 이동, source snapshot 갱신·보존을 저장소 경계에 구현한다.
5. 기존 Notes 완료 메뉴와 `Cmd/Ctrl+Enter`를 notification mark-read adapter에 연결하고, provider 읽음 기반 `showCompleted` subtree filter를 추가한다.
6. 좌측 목록과 `All`을 `rootIds` 단일 순회로 통합하고 GN hybrid child 영역을 기존 outline 구조로 렌더링한다.
7. 합성 focus adapter, provider-authoritative 임시 editor 복원, title/note Enter sibling 생성, 구조 shortcut guard, Type·`ExternalLink`·공통 잠금 아이콘 UI를 완성한다.
8. 날짜 그룹 접힘, projection/materialized 합성, 갱신 시 reparent, source lease·상태 행·접근성을 완성한다.
9. 마지막으로 일반 Notes topic의 root/node 접힘·readonly 자료구조, 메뉴·보호 mutation, 삭제 확인, parser, exporter와 merger를 연결하고 GN production seed·topic/trash v3·SQLite schema를 원자적으로 활성화한다.
10. 집중 테스트, 전체 검증, Tauri 개발 빌드 수동 검증을 수행한다.

## 14. 완료 기준

1. GN이 좌측 목록과 `All`에서 저장된 일반 root 순서에 정확히 나타난다.
2. GN root는 일반 root와 같은 모양이면서 root-level 편집·child 생성은 제한되고, materialize된 notification 아래에서는 일반 child tree를 만들 수 있다.
3. projection notification은 저장되지 않으며, 필요할 때만 date anchor·notification·user tree로 GN Markdown에 materialize된다.
4. 저장 notification은 GitHub 갱신을 계속 반영하고, 임시 title/note 입력은 blur·refresh에서 원문으로 돌아가며, 원본이 사라져도 마지막 snapshot과 children은 유지된다.
5. notification title Enter는 다음 일반 sibling을 만들고 Tab으로 기존 Notes 방식의 하위 블릿을 만들 수 있다.
6. 날짜 이동은 notification과 descendants만 옮기고 unindented sibling은 기존 날짜에 남긴다.
7. 전용 완료 버튼 없이 Notes 메뉴와 `Cmd/Ctrl+Enter`가 GitHub mark-read 단방향 요청을 수행한다.
8. `showCompleted`는 읽은 GitHub notification과 subtree만 필터하며 `viewedAt`은 필터에 영향을 주지 않는다.
9. 잠금과 웹 열기는 title 바로 뒤의 0px inline cluster에 잠금 → `ExternalLink` 순서로 표시한다. `ExternalLink`는 hover/focus-within에서만 표시되고 coarse pointer에서는 항상 표시된다.
10. GN root·날짜 접힘·materialized tree와 일반 Notes 접힘·readonly가 v3 Markdown으로 round-trip하고, 전체 자동 검증과 Tauri 사용자 시나리오가 통과한다.
11. 일반 readonly는 normal outline editor를 유지하면서 content·직접 삭제·구조 이동을 보호하고, non-readonly descendants의 기존 동작은 유지한다.
12. 일반 readonly가 DB·Markdown·iCloud에서 round-trip하고 GN 소유 행은 readonly 값을 쓰지 않지만 같은 hover/focus 잠금 표시를 사용한다.
13. readonly descendant를 포함한 일반 ancestor는 기본 취소 경고 후 명시적 확인으로만 전체 삭제되며, 직접 readonly 삭제는 계속 차단된다.
