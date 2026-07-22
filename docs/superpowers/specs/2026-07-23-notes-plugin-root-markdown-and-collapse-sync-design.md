# Notes 플러그인 루트 Markdown과 알림 트리 동기화 설계

**상태:** 사용자 검토 반영

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

GN 루트는 최상위 루트 사이 순서 변경, `All`에서 접기·펼치기, 선택 및 GN 줌 열기만 허용한다. GN 루트 자체의 제목·note·완료·별표·보관·삭제·복제·내보내기·일반 자식 생성은 허용하지 않는다. 루트 직속 자식은 plugin-owned 날짜 anchor뿐이다.

날짜 anchor는 로컬 달력 날짜 `YYYY.MM.DD`를 안정된 key로 삼고 화면에서는 기존 규칙대로 `Today`, `Yesterday`, `MM.DD`, `YYYY.MM.DD`로 표시한다. anchor의 저장 title은 안정된 날짜 key이며, 표시명은 런타임에서 계산하므로 날짜 경계가 지나도 사용자 데이터를 다시 쓰지 않는다.

- 처음 보는 날짜 key는 펼침이다.
- 접힌 날짜 key만 GN root의 상태와 Markdown frontmatter에 기록한다.
- anchor가 이미 materialize되어도 날짜 접힘의 단일 원본은 GN root의 접힌 날짜 key 집합이다. anchor의 일반 node 접힘 값은 사용하지 않는다.
- 같은 날짜에는 저장된 anchor가 최대 하나다. 아직 저장된 anchor가 없는 날짜 그룹은 projection-only다.
- GN 루트가 접힌 `All`에서는 모든 날짜와 알림을 숨긴다. GN 줌에서는 root 접힘과 무관하게 보여 준다.

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
- 알림 title에서 `Enter`를 누르면 임시 title 수정은 먼저 버린다. 대상 날짜 anchor와 알림이 없으면 즉시 materialize하고, 알림 바로 다음에 빈 **일반 sibling**을 생성하여 그 입력으로 포커스를 옮긴다.
- 새 sibling에서 `Tab`을 누르면 기존 Notes 들여쓰기 명령으로 알림의 자식이 된다. `Shift+Tab`, drag, 붙여넣기 등 일반 Notes 구조 명령도 materialize된 트리 안에서는 같은 경계를 따른다.
- GN 전용 inline child composer는 만들지 않는다. 사용자는 title의 `Enter`로 일반 sibling을 만든 뒤 `Tab`으로 들여쓰거나, 기존 Notes의 paste·drag 같은 구조 명령으로 자식을 만든다. projection-only 알림을 대상으로 한 최초 구조 명령은 같은 on-demand materialization을 먼저 수행한다.

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
- 아이콘은 알림 행 hover 또는 `:focus-within`일 때만 표시한다. 키보드로 아이콘 자체에 포커스가 오면 먼저 표시되어야 한다.
- `@media (pointer: coarse)`에서는 hover가 없으므로 항상 표시한다.
- 열기는 시스템 브라우저에서 대상 URL을 열고 해당 URL의 로컬 `viewedAt`만 기록한다. GitHub mark-read 요청은 보내지 않는다.

## 3. 목표와 비대상

### 목표

1. GN을 일반 최상위 Notes 블릿과 동일한 순서 및 시각 구조로 표시한다.
2. GN 루트 순서·루트 접힘·날짜 접힘을 Markdown으로 기기 간 동기화한다.
3. 필요한 알림만 날짜 anchor와 함께 저장해 그 아래의 일반 Notes 트리를 동기화한다.
4. 저장된 알림의 provider snapshot을 GitHub 갱신으로 유지하고, 원본이 사라져도 저장된 snapshot과 자식을 보존한다.
5. GitHub 읽음 상태를 일반 Notes 완료 UX와 `showCompleted` 필터에 일관되게 연결한다.
6. 앞으로 추가되는 모든 내장 플러그인에 독립 루트 Markdown 파일을 요구한다.
7. 마지막 단계에서 일반 Notes 블릿의 접힘 상태도 각 루트 Markdown에 기록한다.

### 비대상

- 모든 원격 알림을 자동으로 Notes 데이터나 Markdown에 복사
- 사용자가 설치하는 실행형 플러그인, 마켓플레이스, 범용 플러그인 SDK
- Jira나 Linear 제공자의 실제 구현
- 날짜별 별도 HLC나 접힘 전용 CRDT
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
| 하위 블릿 | 만들기 전에 materialize | 허용 | 허용 |
| 원본이 source에서 사라질 때 | 화면에서 사라짐 | 마지막 snapshot과 children 유지 | 유지 |

source refresh는 materialize된 `notification_key`를 먼저 찾는다. 같은 canonical external key의 원격 알림을 projection으로 중복 렌더링하지 않고, 저장된 notification의 snapshot만 갱신한다. 원격 목록에 더 이상 없으면 이를 삭제·tombstone·비동기 정리하지 않는다.

### 4.2 구조 경계

- GN root의 직접 자식은 `github-notifications-date` metadata를 가진 날짜 anchor만 허용한다.
- 날짜 anchor의 직접 자식은 materialize된 GitHub notification 또는 일반 Notes sibling이다.
- materialize된 notification은 일반 Notes 자식을 가질 수 있다. 그 descendants에는 plugin metadata를 붙이지 않는다.
- 일반 user node를 GN root 바로 아래에 만들거나, GN root를 다른 node 아래로 옮기거나, GN root를 다른 node의 부모로 쓰는 요청은 저장소에서 거부한다.
- 날짜 anchor와 materialize된 notification의 식별 metadata를 일반 Notes importer·exporter가 보존해야 한다. metadata가 없는 일반 bullet은 사용자 node로 취급한다.

### 4.3 날짜 이동

source refresh에서 materialize된 알림의 `updatedAt`이 다른 로컬 날짜 key를 가리키면 다음을 하나의 plugin mutation으로 한다.

1. 새 날짜 key의 anchor를 찾고, 없으면 plugin-owned anchor를 만든다.
2. 해당 알림과 그 descendants만 새 anchor로 reparent한다.
3. 기존 날짜 anchor 아래의 들여쓰기하지 않은 일반 sibling은 그대로 남긴다.
4. 기존 anchor에 남은 child가 하나도 없으면 plugin-owned 빈 anchor만 제거한다. 일반 sibling이나 다른 저장 알림이 하나라도 있으면 보존한다.

이동은 사용자 descendants의 UUID, 순서, 완료·별표·접힘 상태를 바꾸지 않는다. 사용자 블릿을 원격 정렬로 다시 배치하거나 삭제하지 않는다.

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
collapsed_group: 2026.07.23
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
- `collapsed_group`은 접힌 날짜의 `YYYY.MM.DD` key다. 중복은 파싱 시 하나로 정규화하고, 내보낼 때 날짜 오름차순으로 정렬한다.
- `root_starred`, `root_completed_at`, `root_archived_at`은 GN root에서 항상 비활성이다.

### 5.2 날짜와 알림 metadata

- `github-notifications-date`는 GN root 직속 날짜 anchor만 식별한다. `date_key`는 실제 `YYYY.MM.DD` 날짜여야 한다.
- `github-notification`은 `notification_key`로 source record와 연결한다. 값은 기존 `serializeExternalBulletKey({ providerId: "github", connectionId: githubSourceConnectionId(apiBaseUrl, accountId), remoteId: threadId })`의 정확한 결과다. 따라서 같은 thread ID라도 GitHub 서버나 계정이 다르면 충돌하지 않는다.
- date anchor UUID는 `Uuid::new_v5(&GN_UUID, date_key.as_bytes())`, notification UUID는 `Uuid::new_v5(&GN_UUID, notification_key.as_bytes())`로 만든다. 같은 날짜와 같은 연결의 같은 알림은 모든 기기에서 같은 UUID를 얻고 다른 연결은 다른 UUID를 얻는다.
- `notification_type`, `notification_url`, `notification_updated_at`, `notification_unread`는 마지막 provider snapshot metadata다.
- notification bullet의 일반 title과 supporting note가 마지막 provider title과 note snapshot이다. source refresh가 이 두 값과 metadata를 갱신한다.
- metadata 값은 Markdown comment parser가 안정적으로 escape·unescape할 수 있는 기존 scalar encoding만 사용한다. URL·timestamp처럼 공백 없는 값은 token으로, title/note처럼 공백 또는 줄바꿈이 가능한 값은 일반 bullet content로 저장한다.
- `notification_unread`는 provider filter와 mark-read의 상태이며 Notes `completed_at`과 교환하지 않는다.

### 5.3 허용되는 body와 검증

GN Markdown body는 빈 projection 전용 파일일 수도 있고, 위와 같은 **제한된 materialized Notes tree**일 수도 있다. 일반 bullet body 전체를 금지하지 않는다.

- root note와 GN root의 일반 direct child는 허용하지 않는다.
- 날짜 anchor는 note를 갖지 않고, 일반 title 편집 대상도 아니다.
- notification metadata가 붙은 bullet은 title/note의 provider-authoritative snapshot과 표준 Notes descendants를 가질 수 있다.
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

`notes_nodes`에는 nullable `plugin_state TEXT`를 추가한다.

- 일반 Notes 행은 `NULL`이다.
- GN root는 접힌 날짜 key의 정렬·중복 제거 JSON 배열을 사용한다. 빈 상태는 `[]`이고, 예시는 `["2026.07.22","2026.07.23"]`다.
- 이 값은 일반 note, 검색, 태그·날짜 추출, Markdown body, title/note 편집 payload에 포함하지 않는다.
- 고정 GN root만 validator를 통과한 값을 쓸 수 있다.

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

격리된 GN 파일이 있으면 “파일 없음”으로 간주해 새 seed나 재발행으로 덮지 않는다. 사용자가 오류를 확인하고 개발 데이터를 초기화하거나 파일을 바로잡을 때까지 플러그인 동기화 오류를 유지한다.

첫 발행 직전에 iCloud가 같은 표준 파일을 전달할 수 있다. 최초 GN 파일 생성은 기존 파일을 덮어쓰지 않는 방식으로 수행한다.

- 목적지 파일이 없으면 원자적으로 생성한다.
- 같은 내용이 이미 있으면 발행 완료로 기록한다.
- 다른 내용이 먼저 도착했으면 덮어쓰지 않고 watcher 병합을 기다린다.

## 8. Markdown 병합 규칙

GN root는 일반 Notes의 root HLC 흐름을 그대로 사용한다.

- 더 높은 `root_hlc`의 `sort_key`, `root_collapsed`, 접힌 날짜 key 집합이 함께 이긴다.
- materialize된 date anchor·notification·사용자 node는 표준 node HLC 병합과 parent 검증을 따른다.
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

- `All`: GN sortable root 행 다음에 합성 child 영역을 두고, `root.isCollapsed === false`일 때만 표시한다.
- GN 줌: root collapse를 무시하고 header 다음에 같은 합성 child 영역을 표시한다.
- root 정렬용 `sortableIds`에는 일반 root와 GN root만 넣는다. `selectionVisibleIds`에는 GN 안의 일반 사용자 Notes 블릿만 포함하고, plugin-owned GN root·materialize된 날짜 anchor·materialize된 notification·projection-only 행은 제외한다.
- projection-only 날짜·알림·상태 행은 `nodesById`, `childIdsByParent`, `sortableIds`, `selectionVisibleIds` 어느 곳에도 넣지 않는다. materialize된 날짜와 notification은 저장 node map에는 있지만 사용자 선택·일괄 mutation 대상에는 넣지 않는다.
- 키보드 focus 이동은 별도의 합성된 화면 순서를 사용해 plugin-owned title/note editor, 사용자 블릿, `ExternalLink`를 건너뛰지 않는다. 이는 Notes 다중 선택 목록과 분리한다.
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
- materialize된 date anchor와 notification 자체는 사용자 delete·reparent·outdent·일괄 mutation을 거부한다. 그 안의 사용자 블릿은 일반 Notes의 Tab/Shift+Tab, drag, paste, restore/reparent 검증을 사용하되 plugin 경계 밖으로 provider-owned parent를 끌어내지 않는다.
- notification의 `Cmd/Ctrl+Enter`와 Notes 완료 메뉴는 mark-read adapter를 호출한다. 일반 checkbox toggle과 undo-to-unread를 노출하지 않는다.
- GN root와 날짜 그룹의 접힘 버튼은 `aria-expanded`를 저장 상태와 일치시킨다. 날짜 그룹은 키보드로 접기·펼치기가 가능하다.
- notification title/note editor는 일반 editor와 동일하게 caret·selection을 지원한다. blur/refresh 복원을 보조기술에도 변경 알림으로 전달한다.
- Type과 `ExternalLink` 버튼은 텍스트 대체 이름과 tooltip을 유지한다.

## 10. 일반 Notes 블릿 접힘 Markdown 동기화

이 변경은 GN root·hybrid child tree·날짜 접힘·UI 통합이 끝난 뒤 마지막 구현 단계로 진행한다.

### 10.1 파일 표현

일반 최상위 root는 frontmatter에 접힘 상태를 기록한다.

```yaml
root_collapsed: true
```

일반 하위 블릿은 기존 metadata comment에 값이 true일 때만 `collapsed` token을 추가한다.

```md
- [ ] 접어 둔 블릿 <!-- yid: <UUID> t: <HLC> collapsed -->
```

- `collapsed` token이 없으면 펼침이다.
- false 값을 별도 token으로 기록하지 않는다.
- 별표 `star`, 이동 출처 `from:`, GN plugin metadata와 같은 comment parser를 재사용한다.
- root와 모든 깊이의 일반 하위 블릿에 같은 의미를 적용한다. GN date anchor의 접힘은 예외적으로 `collapsed_group`이 권위다.

### 10.2 동기화 의미와 형식 호환성

- 일반 Notes의 접기·펼치기 명령은 이미 해당 node HLC를 갱신하므로 별도 `collapse_hlc`를 추가하지 않는다.
- exporter는 현재 `is_collapsed`를 파일에 기록하고, parser·merger는 더 새로운 행의 값만 적용한다.
- `format_version: 3`은 일반 접힘과 GN hybrid tree를 포함하는 새 개발 형식이다. `plugin_state` 추가에 맞춰 Notes SQLite schema version도 올린다.
- GN만 먼저 v3로 쓰는 혼합 기간을 두지 않고, GN bootstrap·모든 일반 topic 접힘·format 상수·SQLite schema를 마지막 통합 단계에서 한 번에 전환한다.
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
- token, API 응답 전문 또는 로컬 민감 경로를 오류에 포함하지 않는다.

## 12. 테스트 전략

모든 구현은 실패하는 테스트를 먼저 추가하는 순서로 진행한다.

### 12.1 형식과 병합

- 일반 v3 root와 모든 깊이의 node `collapsed` round-trip
- GN root의 plugin 표식, 고정 UUID, 제목, root collapse, `plugin_children: hybrid`, 접힌 날짜 key round-trip
- materialize된 date anchor와 notification metadata, provider title/note snapshot, user descendants의 Markdown round-trip
- 중복 `collapsed_group` 정규화 및 안정된 출력 순서
- 잘못된 date key, 중복·파싱 불가능·provider 불일치 notification key, 잘못된 UUID, metadata 없는 GN direct child, root note, 불완전 plugin 표식 격리
- 저장 notification source snapshot은 더 새 `notification_updated_at`만 덮어쓰며, source에서 사라져도 snapshot과 descendants를 유지
- `yonalist-notes`와 `yonalist-trash`가 함께 v3로 출력되고 v2·누락된 format version을 거부

### 12.2 생성과 저장소 경계

- 기존 GN 파일과 materialized tree를 seed보다 먼저 병합
- 파일과 행이 없을 때 고정 UUID root를 정확히 한 개 생성
- 정상 GN 행만 남고 표준 파일이 삭제되면 missing-topic recovery가 tree를 포함해 다시 발행
- 손상되어 격리된 GN 표준 파일은 seed/recovery가 덮어쓰지 않음
- GN은 최상위 순서 변경과 root collapse만 일반 root 명령으로 허용
- 날짜 접힘의 명시적 boolean 명령이 재시도에 안전하고 Undo/Redo에서 복원
- title Enter가 projection notification의 date anchor와 notification을 한 번 materialize한 뒤 빈 일반 sibling을 생성
- 그 sibling의 Tab이 notification child를 만들고, materialized notification 아래 일반 create/paste/restore/reparent가 허용
- GN root 아래 일반 create/paste/import/duplicate/reparent와 GN root의 편집·삭제·보관은 거부
- source refresh가 저장 notification을 최신 snapshot으로 갱신하고 projection 중복 없이 렌더링
- 날짜 이동에서 notification+descendants만 새 anchor로 이동하고 unindented sibling은 기존 anchor에 남음

### 12.3 UI

- 저장 순서 `[일반 A, GN, 일반 B]`가 좌측 목록과 `All`에 동일하게 표시
- GN이 일반 root와 같은 CSS 구조를 쓰고 root editor·더보기 메뉴·root-level create는 없음
- GN 줌에서 notification title Enter와 뒤이은 사용자 sibling의 Tab 들여쓰기가 동작함
- `All`의 root collapse가 합성 child를 숨기고 재로딩 후 복원하며 GN 줌은 root collapse와 무관하게 내용을 표시
- 펼친 `All` GN과 GN 줌이 source lease·polling·1분 projection clock을 활성화하고, 닫히면 해제
- `sortableIds`에는 GN이 있고 projection-only 행은 sortable/selection/node map에 없으며 GN root drag 범위가 합성 child 높이로 커지지 않음
- GN은 일반 root의 child가 될 수 없고 일반 root도 GN의 child가 될 수 없지만, materialized tree 안의 기존 구조 명령은 동작
- 날짜 그룹은 기본 펼침이고 접힌 날짜 key만 숨기며, `All`과 GN 줌에서 즉시 같은 상태가 반영
- 알림 note에 잘못된 자식 화살표가 없고 Type·기존 Notifications 부제가 표시
- 저장 notification title/note에서 caret·selection·임시 입력이 가능하고 blur, Escape, refresh 때 provider snapshot으로 복원되며 Markdown/HLC/history는 바뀌지 않음
- title Enter는 임시 입력을 버리고 바로 다음 일반 sibling으로 focus를 옮김
- 전용 완료 버튼은 없고 Notes 메뉴와 `Cmd/Ctrl+Enter`가 mark-read를 한 번 요청하며 성공·실패 상태를 올바르게 반영
- `showCompleted=false`가 `unread=false` notification과 descendants만 숨기고, `viewedAt`만 있는 notification은 계속 표시
- 보이는 notification subtree와 날짜 아래 사용자 블릿에는 기존 `completed_at` 필터가 함께 적용됨
- `ExternalLink`가 올바른 URL을 한 번 열고 `viewedAt`만 기록하며 hover/focus-within에서만 보이고 coarse pointer에서는 항상 보임
- 연결·로딩·빈 결과·오류/retry 상태 행이 Notes 저장·선택·정렬에 들어가지 않음
- GN과 날짜 접힘 버튼의 키보드 동작 및 `aria-expanded`가 정확하고, notification editor와 `ExternalLink`의 키보드 focus가 보임

### 12.4 기기 간 시나리오

1. 기기 A에서 projection notification의 title에 `Enter`를 눌러 date anchor·notification·일반 sibling을 만들고 sibling을 notification 아래로 들여쓴다.
2. A가 notification title/note에 임시 입력 후 blur하여 source snapshot 복원을 확인한다.
3. A에서 GN root와 날짜 그룹을 접고, Markdown 파일만 새 기기 B의 빈 Vault로 동기화한다.
4. B가 같은 root UUID, 순서, 접힘, 저장 notification snapshot과 사용자 child를 복원하는지 확인한다.
5. B가 source refresh에서 notification의 날짜를 바꾸면 notification+child만 새 date anchor로 이동하고 A에서 만든 unindented sibling은 기존 anchor에 남는지 확인한다.
6. GitHub가 해당 notification을 더 이상 반환하지 않아도 B가 저장 snapshot과 사용자 child를 유지하는지 확인한다.

### 12.5 회귀 검증

- 외부 알림 mark-read 성공·실패, snapshot rollback 방지, `showCompleted` filter 테스트
- 기존 Notifications pane 검색·Only new·날짜 그룹·상세·웹 열기
- plugin-owned GN root·날짜·notification은 Recent·Starred·Tags·Archive·Trash·Notes 검색 결과에서 제외되고 사용자 블릿은 기존 규칙을 따름
- Notes 전체 frontend 및 Rust 테스트
- lint, architecture 검사, production build
- Tauri 개발 빌드에서 직접 순서·materialization·들여쓰기·필터·접힘·재시작·웹 열기 확인

## 13. 구현 순서

1. 고정 GN root, v3 frontmatter, `plugin_children: hybrid`, date/notification metadata parser·validator·fixture를 추가한다.
2. `plugin_state` 날짜 접힘과 GN 제한 tree의 SQLite/schema·parser·exporter·merger 경로를 준비한다.
3. GN bootstrap의 기존 파일 우선 병합과 root 단일 seed/no-clobber 발행을 구현하되 format cutover 전에는 production seed를 활성화하지 않는다.
4. 날짜 anchor와 notification의 on-demand materialization, canonical external key 중복 방지, 일반 child 허용, 날짜 이동, source snapshot 갱신·보존을 저장소 경계에 구현한다.
5. 기존 Notes 완료 메뉴와 `Cmd/Ctrl+Enter`를 notification mark-read adapter에 연결하고, provider 읽음 기반 `showCompleted` subtree filter를 추가한다.
6. 좌측 목록과 `All`을 `rootIds` 단일 순회로 통합하고 GN hybrid child 영역을 기존 outline 구조로 렌더링한다.
7. provider-authoritative 임시 editor 복원, title Enter sibling 생성, Type·`ExternalLink` hover/focus/coarse-pointer UI를 완성한다.
8. 날짜 그룹 접힘, projection/materialized 합성, 갱신 시 reparent, source lease·상태 행·접근성을 완성한다.
9. 마지막으로 일반 Notes topic의 root/node 접힘 자료구조, parser, exporter와 merger를 연결하고 GN production seed·topic/trash v3·SQLite schema를 원자적으로 활성화한다.
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
9. 웹 열기는 `ExternalLink`로 hover/focus-within에서만 표시되고 coarse pointer에서는 항상 표시된다.
10. GN root·날짜 접힘·materialized tree와 일반 Notes 접힘이 v3 Markdown으로 round-trip하고, 전체 자동 검증과 Tauri 사용자 시나리오가 통과한다.
