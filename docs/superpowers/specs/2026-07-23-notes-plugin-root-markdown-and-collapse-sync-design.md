# Notes 플러그인 루트 Markdown과 접힘 동기화 설계

**상태:** 사용자 검토 대기

**날짜:** 2026-07-23

**대체 범위:**

- `2026-07-22-notes-external-notifications-plugin-design.md`의 “완전히 가상인 최상위 페이지” 결정
- `2026-07-23-notes-github-notifications-presentation-design.md`의 “All에서 항상 첫 번째” 및 “날짜 그룹은 항상 펼침” 결정

이 문서와 앞선 문서가 충돌하면 이 문서가 우선한다. 외부 알림 내용은 저장하지 않고 GitHub 읽음 상태를 완료 상태의 원본으로 삼는 기존 원칙은 유지한다.

## 1. 한눈에 보는 결론

`Github Notifications`(이하 GN)를 일반 최상위 Notes 블릿과 같은 정렬 흐름에 들어가는 **저장된 플러그인 루트**로 바꾼다.

- GN 루트는 고정 UUID를 가진 실제 최상위 `notes_nodes` 행이다.
- GN 루트마다 독립 Markdown 파일이 반드시 존재한다.
- 파일에는 플러그인임을 나타내는 표식, 루트 순서와 접힘 상태, 접어 둔 날짜 키만 기록한다.
- 날짜 그룹과 GitHub 알림 자식은 API/캐시에서 매번 투영하며 SQLite나 Markdown에 저장하지 않는다.
- GN은 Notes `All`에서 다른 루트와 같은 순서·모양으로 표시되고 최상위끼리만 순서를 바꿀 수 있다.
- GN 루트와 날짜 그룹은 기본 펼침이다. 사용자가 접은 상태는 Markdown을 통해 다른 기기에도 복원된다.
- 구현의 마지막 단계에서 일반 Notes의 모든 블릿 접힘 상태도 각 루트 Markdown에 기록한다.

별도 플러그인 정렬 파일, 플러그인 전용 트리 데이터베이스, 범용 설치형 플러그인 SDK는 만들지 않는다. 기존 Notes 정렬·HLC·Markdown 동기화 경로를 재사용한다.

## 2. 사용자에게 보이는 결과

### 2.1 Notes 목록과 All

GN은 좌측 Notes 페이지 목록과 우측 `All` outline 양쪽에서 같은 최상위 루트 순서에 놓인다. 별도로 목록 앞에 덧붙이지 않는다.

예를 들어 저장된 루트 순서가 다음과 같다면 두 화면 모두 같은 순서를 표시한다.

```text
업무
Github Notifications
Daily
개인
```

우측 outline의 GN은 일반 루트와 같은 행 높이, 화살표, 블릿, 제목 정렬, 들여쓰기 선과 hover/focus 모양을 사용한다. 좌측 목록은 기존 일반 페이지 행의 `.notes-library-page` 구조를 따른다. 읽기 전용이라는 이유로 별도 페이지처럼 보이는 카드나 전용 레이아웃을 만들지 않는다.

GN은 다음 위치에만 표시한다.

- 좌측 Notes 페이지 목록
- 우측 `All`
- GN을 선택해 연 줌 화면

`Starred`, `Recent`, `Tags`, `Archive`, `Trash`, Notes 검색 결과에는 표시하지 않는다.

### 2.2 GN 루트 동작

GN 루트에서 허용되는 동작은 다음뿐이다.

- 최상위 루트 사이 순서 변경
- `All`에서 접기와 펼치기
- 선택하고 GN 페이지 열기

다음 동작은 노출하지 않고 저장소 명령 경계에서도 거부한다.

- 제목·노트 편집
- 완료, 별표, 보관, 삭제, 복제, 내보내기
- 로컬 자식 생성, 붙여넣기, 들여쓰기와 내어쓰기
- GN을 다른 블릿의 자식으로 이동
- 일반 블릿을 GN의 자식으로 이동
- 다중 선택 및 일반 Notes 일괄 동작

새 GN 루트는 기본 펼침이다. 사용자가 `All`에서 접으면 투영된 날짜/알림 행을 숨기고 그 상태를 저장한다. 일반 Notes와 마찬가지로 GN을 직접 연 줌 화면에서는 루트 자체의 접힘과 무관하게 페이지 내용을 보여 준다.

### 2.3 날짜 그룹

GitHub 알림은 기존 Notifications와 같은 로컬 날짜 규칙으로 묶는다.

- 오늘: `Today`
- 어제: `Yesterday`
- 같은 해의 이전 날짜: `MM.DD`
- 이전 연도: `YYYY.MM.DD`

날짜 그룹의 안정된 키는 표시명이 아닌 기존 날짜 그룹 도우미가 만드는 로컬 달력 날짜 `YYYY.MM.DD`다. 예를 들어 `Today`가 다음 날 `Yesterday`로 바뀌어도 날짜 키가 같으므로 접힘 상태는 유지된다.

- 처음 보는 날짜 키는 펼침이다.
- 사용자가 접은 날짜 키만 GN Markdown에 기록한다.
- 다시 펼치면 해당 키를 파일에서 제거한다.
- 현재 스냅샷에 없는 저장된 날짜 키는 화면에 아무 영향 없이 유지한다.
- 다른 시간대 기기에서는 그 기기의 로컬 날짜 그룹에 같은 키가 존재할 때만 상태를 적용한다.

날짜 그룹 아래 알림의 소속과 순서는 저장하지 않는다. 자동 폴링, 수동 새로고침, 완료 후 갱신, 날짜 경계 변화 등으로 정상 스냅샷이 바뀔 때마다 다시 계산한다.

- `updated_at`이 바뀐 알림은 알맞은 날짜 그룹으로 이동한다.
- 빈 날짜 그룹은 화면에서 제거한다.
- 새 날짜 그룹은 기본 펼침으로 나타난다.
- 이미 접어 둔 날짜 키가 다시 나타나면 접힌 상태로 나타난다.
- 갱신 실패 시 마지막 정상 투영과 접힘 상태를 유지한다.

### 2.4 알림 행

각 알림은 일반 Notes 블릿의 제목과 supporting note 구조를 그대로 사용한다.

```text
[Type 아이콘] [#45] 메뉴얼 검색 및 RAG 응답 구현 #121       [웹] [완료]
              arc-agent, 9h ago, seen 6h ago
```

- 일반 점 위치에는 Issue, Pull Request, Discussion, Release 또는 기본 알림 아이콘을 표시한다.
- 두 번째 줄은 기존 Notifications 목록의 저장소·활동 시각·seen 부제 생성 함수를 그대로 재사용한다.
- 두 번째 줄은 note이지 자식 블릿이 아니므로 펼침 화살표를 만들지 않는다.
- 웹 버튼은 기존 GitHub Inbox 상세 화면과 동일한 Lucide `Globe`, tooltip과 브라우저 열기 동작을 사용한다. 다만 34px 공용 `.icon-button`으로 Notes 행 높이를 키우지 않고 기존 `.notes-row-icon-button` 스타일을 사용한다. 제목 콘텐츠 열 안에 `title + trailing actions` 컨테이너를 두어 Globe와 완료 버튼이 다음 행으로 밀리지 않게 한다.
- 웹 버튼은 기존 `openNotification` 경로로 대상 GitHub 페이지를 시스템 브라우저에서 열고 해당 URL의 로컬 `viewedAt`을 기록한다. GitHub 완료 요청은 보내지 않는다.
- 완료 버튼은 기존 승인된 규칙대로 GitHub 읽음 요청이 성공한 뒤에만 완료 모양을 표시한다.

## 3. 목표와 비대상

### 목표

1. GN을 일반 최상위 Notes 블릿과 동일한 순서 및 시각 구조로 표시한다.
2. GN 루트의 순서와 접힘 상태를 Markdown으로 기기 간 동기화한다.
3. GN 날짜 그룹의 접힘 상태를 절대 날짜 키로 동기화한다.
4. 알림 갱신 때 날짜 소속을 다시 계산하면서 사용자가 접어 둔 날짜는 기억한다.
5. 앞으로 추가되는 모든 내장 플러그인에 독립 루트 Markdown 파일을 요구한다.
6. 마지막 단계에서 일반 Notes 블릿의 접힘 상태도 Markdown 원본에 포함한다.

### 비대상

- 알림 제목, note, 날짜 그룹 또는 알림 순서를 Notes 데이터로 복사
- 사용자가 설치하는 실행형 플러그인, 마켓플레이스, 범용 플러그인 SDK
- Jira나 Linear 제공자의 실제 구현
- 날짜별 별도 HLC나 접힘 전용 CRDT
- 기존 v2 Markdown 또는 이전 개발 데이터의 마이그레이션
- 기존 전역 Notifications pane의 UI·검색·상세 동작 변경

## 4. 모든 플러그인의 루트 파일 계약

Notes에 최상위 블릿을 제공하는 모든 내장 플러그인은 다음을 가져야 한다.

1. 앱 코드에 등록된 고정 `plugin` ID
2. 플러그인 ID로부터 결정되는 고정 루트 UUID
3. 하나의 실제 최상위 Notes 루트 행
4. 그 루트와 같은 UUID를 가진 독립 Markdown 파일
5. 파일의 플러그인 표식과 자식 저장 방식
6. 허용 동작과 금지 동작을 검사하는 저장소 경계

첫 구현은 `github-notifications` 하나만 등록한다. 두 번째 플러그인이 생기기 전에는 동적 등록, 설정 스키마, 범용 명령 디스패처를 만들지 않는다.

GN의 루트 UUID와 제목은 코드 상수다. 모든 기기가 같은 UUID와 표준 파일명을 만들므로 iCloud conflict copy가 생겨도 동일 루트로 병합할 수 있다.

## 5. GN Markdown 형식

Notes topic 형식을 v3으로 올리고 GN 파일을 다음처럼 기록한다.

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
plugin_children: projected
collapsed_group: 2026.07.23
collapsed_group: 2026.07.22
---
# Github Notifications
```

### 공통 루트 정보

- `id`: 모든 기기에서 같은 고정 UUID
- `sort_key`: 일반 최상위 루트와 공유하는 표시 순서
- `root_hlc`: 순서, 루트 접힘, 플러그인 상태를 포함한 루트 승자 판정
- `root_collapsed`: `All`에서 GN 루트의 접힘 여부
- `plugin`: 내장 제공자 ID
- `plugin_children: projected`: 파일 body가 아니라 런타임 투영으로 자식을 만든다는 뜻

### GN 전용 상태

- `collapsed_group`은 접힌 날짜의 `YYYY.MM.DD` 키다.
- 같은 키의 중복은 파싱 시 하나로 정규화한다.
- Markdown으로 내보낼 때 키를 날짜 오름차순으로 정렬하여 파일 diff를 안정시킨다. 화면의 날짜 그룹과 알림 순서는 기존처럼 최신순이다.
- 펼친 날짜는 기록하지 않는다. 필드가 하나도 없으면 모든 날짜 그룹이 펼쳐진다.
- 현재 보이지 않는 과거 키를 별도 정리하는 작업은 만들지 않는다. 하루당 최대 한 키이며, 다시 나타났을 때 상태를 복원하는 편이 더 단순하다.

### 금지되는 내용

GN 파일에는 heading 아래의 root note, 일반 bullet body, 이미지 또는 알림 데이터가 없어야 한다. 다음 상태도 항상 비활성이다.

- `root_starred: false`
- `root_completed_at: -`
- `root_archived_at: -`

플러그인 표식 누락, 잘못된 고정 UUID, 변경된 고정 제목, body bullet, root note 또는 금지 상태가 발견되면 조용히 무시하거나 덮어쓰지 않고 해당 파일을 동기화 오류로 격리한다.

## 6. 저장 모델과 단일 기준

GN의 루트 행만 `notes_nodes`에 저장한다.

| 데이터 | 저장 위치 | 원본 |
| --- | --- | --- |
| GN 루트 UUID·순서·루트 접힘 | `notes_nodes`와 GN Markdown | 기존 Notes HLC 병합 |
| 접힌 날짜 키 집합 | GN 루트에 딸린 플러그인 상태와 GN Markdown | 기존 root HLC 병합 |
| 날짜 그룹 제목·순서 | 저장하지 않음 | 현재 알림 스냅샷 + 로컬 날짜 |
| 알림 제목·note·Type·완료 | 저장하지 않음 | GitHub/기존 알림 캐시 |
| 알림의 날짜 부모 | 저장하지 않음 | 매 갱신 시 `updated_at`으로 계산 |

`notes_nodes`에는 내부용 nullable `plugin_state TEXT` 필드를 하나 추가한다.

- 일반 Notes 행은 항상 `NULL`을 사용한다.
- GN 루트는 접힌 절대 날짜 키만 담은 정렬·중복 제거 JSON 배열을 사용한다. 빈 상태는 `[]`이고, 접힌 상태의 예는 `["2026.07.22","2026.07.23"]`이다.
- 이 필드는 일반 note, 검색, 태그·날짜 추출, Markdown body 및 제목/note 편집 payload에 포함하지 않는다.
- 고정 플러그인 루트만 자신의 validator를 통과한 값을 사용할 수 있다.

Notes workspace에는 이 값을 읽기 전용 `pluginState`로 함께 전달한다. 별도 상태 조회 API를 만들지 않아 초기 load, 동기화 reload와 Undo/Redo가 모두 기존 workspace 새로고침 경로를 따른다.

날짜 접힘 명령은 전체 배열이나 “현재 값을 뒤집어라”는 요청을 받지 않는다. `{rootId, groupKey, collapsed}`를 받아 트랜잭션 안에서 집합을 수정한다. 재시도해도 같은 결과가 나며, `groupKey`는 실제 `YYYY.MM.DD` 달력 날짜인지 검증한다. 날짜를 만들 수 없는 `unknown` 그룹은 상태 파일을 오염시키지 않도록 접힘 동작을 제공하지 않는다. 변경은 기존 Notes mutation/history 경로를 사용해 Undo/Redo에도 포함한다.

플러그인 전용 정렬 테이블이나 날짜 자식 행을 추가하지 않는다. 접힌 날짜 키 집합은 GN 루트 상태의 한 필드로 취급하고, 루트 행을 갱신할 때 기존 Notes trigger가 새 HLC와 dirty 표시를 만든다. 별도 테이블은 HLC, dirty trigger, history 및 tombstone 경로를 중복시키고, 일반 `note` 재사용은 검색과 파생 인덱스에 숨은 상태를 누출하므로 사용하지 않는다.

날짜 접힘, 루트 접힘, 루트 순서가 서로 다른 기기에서 동시에 바뀌면 별도 필드 병합을 하지 않는다. 기존 Notes와 같은 행 단위 HLC last-write-wins를 적용하여 더 새로운 GN 루트 상태 전체가 이긴다. 이 선택은 새 CRDT와 별도 시계가 만드는 복잡성을 피하고 현재 Notes 충돌 의미와 일치한다.

알림 스냅샷 갱신과 날짜 재그룹만으로는 `plugin_state`, root HLC 또는 Markdown 파일을 변경하지 않는다. 사용자가 루트나 날짜 그룹을 직접 접거나 펼치거나 루트 순서를 바꿀 때만 저장 상태가 바뀐다.

## 7. 생성, 시작 및 iCloud 합류

앱 시작 순서는 다음과 같다.

1. Vault의 기존 Markdown 파일을 먼저 스캔하고 병합한다.
2. 고정 GN UUID의 정상 플러그인 파일 또는 루트 행이 있는지 확인한다.
3. 정상 파일만 있으면 그 파일을 고정 GN 루트 행으로 병합한다.
4. 루트 행만 있고 표준 파일이 없으면 루트를 dirty로 표시하여 파일을 다시 발행한다.
5. 둘 다 없을 때만 기본 펼침 상태의 GN 루트를 한 번 생성한다.
6. GN 루트가 새로 생성되면 일반 root dirty/export 경로로 Markdown을 발행한다.
7. 그 뒤 기존 pending export를 처리하고 watcher를 계속 실행한다.

최초 seed의 기본 `sort_key`도 새 일반 최상위 Notes 루트와 같은 기존 위치 할당 함수를 사용한다. 사용자가 이후 일반 드래그 정렬로 위치를 정하며 고정된 “항상 첫 번째” 규칙은 적용하지 않는다.

격리된 GN 파일이 있으면 “파일 없음”으로 간주해 새 seed나 재발행으로 덮지 않는다. 사용자가 오류를 확인하고 개발 데이터를 초기화하거나 파일을 바로잡을 때까지 플러그인 동기화 오류를 유지한다.

첫 발행 직전에 iCloud가 같은 표준 파일을 전달할 수 있다. 최초 GN 파일 생성은 기존 파일을 덮어쓰지 않는 방식으로 수행한다.

- 목적지 파일이 없으면 원자적으로 생성한다.
- 같은 내용이 이미 있으면 발행 완료로 기록한다.
- 다른 내용이 먼저 도착했으면 덮어쓰지 않고 watcher 병합을 기다린다.

이 순서와 고정 UUID로 두 기기가 동시에 시작해도 GN 루트가 두 개 생기지 않고, 먼저 도착한 순서·접힘 상태를 초기 seed가 지우지 않는다.

## 8. Markdown 병합 규칙

GN 루트는 일반 Notes의 root HLC 흐름을 그대로 사용한다.

- 더 높은 `root_hlc`의 `sort_key`, `root_collapsed`, 접힌 날짜 키 집합이 함께 이긴다.
- 더 낮은 HLC는 현재 상태를 덮지 않고 기존 충돌 기록 규칙을 따른다.
- 같은 HLC와 같은 내용은 no-op이다.
- 사람이 같은 HLC의 파일 내용을 바꾼 경우 기존 hand-edit 경로가 새 로컬 HLC를 발급하고 표준 형식으로 다시 내보낸다.
- `max_hlc`는 자식이 없는 GN 파일에서 root HLC를 반영한다.
- 동일 UUID의 conflict copy는 별도 GN 루트를 만들지 않고 하나의 topic으로 병합한다.

`sort_key`, `root_collapsed`, `collapsed_group`은 모두 승자 비교에 포함한다. 그래야 Markdown에서 직접 바꾼 순서나 접힘 상태도 감지된다.

## 9. UI 합성

### 9.1 한 번만 순회하는 루트 목록

좌측 목록과 `All`은 모두 저장된 `rootIds`를 한 번만 순회한다.

- ID가 고정 GN UUID면 동작이 제한된 플러그인 루트 행을 렌더링한다.
- 그 외에는 기존 일반 Notes 루트 행을 렌더링한다.

좌측 GN은 기존 `NotesExternalLibraryPageRow`의 액션 없는 구조를 `rootIds` 순회 안에서 재사용한다. 우측 플러그인 루트, 날짜 그룹과 알림 행은 별도 시각 디자인을 만들지 않고 기존 `notes-node-*` outline 구조와 CSS를 재사용한다. 다만 GN 루트에는 편집기와 더보기 메뉴를 렌더링하지 않는다.

GN은 저장된 DB 자식이 없으므로 접힘 화살표 노출 여부를 `childIdsByParent`나 현재 알림 개수로 판단하지 않는다. 연결·로딩·빈 상태도 런타임 자식 영역에 표시할 수 있으므로 플러그인의 projected-children capability로 기존 화살표 슬롯을 활성화한다.

### 9.2 런타임 자식 삽입

날짜와 알림은 `NotesWorkspace.nodesById`나 `childIdsByParent`에 넣지 않는다. 다음 두 위치에 화면 전용 행으로만 삽입한다.

- `All`: GN sortable 루트 행의 다음 형제로 삽입하고 `root.isCollapsed === false`일 때만 표시
- GN 줌: 읽기 전용 페이지 header 다음에 항상 표시하고 저장된 root collapse는 무시

이 경계를 지켜야 일반 Notes의 선택, 편집, Undo/Redo, 이동, 검색, 휴지통 및 내보내기 명령이 외부 ID를 `NoteNode`로 오인하지 않는다.

GN 줌 화면도 같은 날짜/알림 행 renderer를 사용한다. `zoomRootId === GN_UUID`를 화면 권위로 삼아 일반 breadcrumb/back/history를 유지하되, 읽기 전용 header를 사용하고 제목 편집 focus 예약, page menu, export와 하단 child composer를 노출하지 않는다. 별도 카드형 페이지는 유지하지 않는다.

일반 outline이 선택과 정렬에 공유하던 ID 목록은 이 경로에서 분리한다.

- `sortableIds`: 저장된 일반 루트와 GN 루트를 포함
- `selectionVisibleIds`: 일반 Notes 행만 포함하고 GN·날짜·알림은 제외
- 날짜·알림 런타임 행: 두 목록 모두에서 제외

GN의 sortable DOM 범위에는 GN 루트 행만 넣는다. 투영 자식은 다음 형제로 두어 많은 알림 때문에 루트의 drag/drop 사각형이 커지지 않게 한다.

### 9.3 소스 활성화와 상태 행

GitHub source lease, 폴링과 날짜 라벨을 다시 계산하는 1분 projection clock은 다음 중 하나가 참인 동안 활성화한다.

- `All`에서 GN 루트가 펼쳐져 투영 영역이 보임
- `zoomRootId === GN_UUID`

GN이 접힌 `All`에만 있고 줌 중이 아니면 마지막 정상 캐시를 유지하되 화면에 보이지 않는 투영을 위해 새 lease를 잡지 않는다.

현재 `activeProviderId`처럼 화면 선택과 source 활성화를 한 값에 맡기지 않는다. Notes outline이 위 조건에서 별도 최소 boolean `githubProjectionRequested`를 올리고 App은 이 신호로만 lease와 projection clock을 제어한다. `NotesDetailPane`은 이 신호나 provider 선택 값을 보지 않고 `zoomRootId`로만 All/일반 줌/GN 줌 화면을 결정한다. 따라서 `All`에서 lease를 켜도 화면이 GN 전용 pane으로 바뀌지 않는다.

연결 필요, 최초 로딩, 빈 결과, 오프라인 캐시, 오류와 retry는 현재 외부 알림 화면의 상태를 유지한다. GN 줌에서는 읽기 전용 header 아래에, `All`에서는 펼친 GN의 런타임 자식 영역에 일반 Notes 스타일의 비저장 상태 행으로 표시한다. 이 상태 행도 Notes 선택·정렬·저장 대상이 아니다.

### 9.4 이동 경계

- GN을 드래그하면 결과 `parentId`는 항상 `null`이어야 한다.
- GN을 drop parent로 사용할 수 없다.
- Tab/Shift+Tab으로 GN 안팎에 계층을 만들 수 없다.
- `Move To`의 대상 목록에서 GN을 제외한다.
- 저장소는 UI를 우회한 create, paste, import, duplicate, restore/reparent 요청도 같은 규칙으로 거부한다.

### 9.5 키보드와 접근성

- GN 루트의 블릿은 일반 sortable 블릿과 같이 Enter/Space 키보드 drag를 유지하고 포인터 클릭으로 줌을 연다.
- GN의 읽기 전용 제목 버튼은 Enter/Space로 GN 줌을 연다.
- ArrowUp/ArrowDown 구조 탐색은 일반 제목 editor와 GN 제목 버튼 사이를 양방향으로 이동할 수 있어야 한다.
- GN 루트와 날짜 그룹의 접힘 버튼은 `aria-expanded`를 현재 저장 상태와 일치시킨다.
- 날짜 그룹은 키보드로 접기/펼치기가 가능하다.
- Type과 Globe 버튼은 텍스트 대체 이름과 기존 tooltip을 유지한다.

## 10. 일반 Notes 블릿 접힘 Markdown 동기화

이 변경은 GN 루트·날짜 접힘·UI 통합이 끝난 뒤 마지막 구현 단계로 진행한다.

### 10.1 파일 표현

일반 최상위 루트는 frontmatter에 접힘 상태를 기록한다.

```yaml
root_collapsed: true
```

일반 하위 블릿은 기존 metadata comment에 값이 true일 때만 `collapsed` 토큰을 추가한다.

```md
- [ ] 접어 둔 블릿 <!-- yid: <UUID> t: <HLC> collapsed -->
```

- `collapsed` 토큰이 없으면 펼침이다.
- false 값을 별도 토큰으로 기록하지 않는다.
- 별표 `star` 및 이동 출처 `from:` 토큰과 같은 comment parser를 재사용한다.
- root와 모든 깊이의 하위 블릿에 같은 의미를 적용한다.

### 10.2 동기화 의미

- 접기/펼치기 명령은 이미 해당 노드의 HLC를 갱신하므로 별도 `collapse_hlc`를 추가하지 않는다.
- exporter는 현재 `is_collapsed`를 파일에 기록한다.
- parser와 merger는 원격 접힘 상태를 읽고 더 새로운 행의 값으로 적용한다.
- 새 노트북에서 Markdown을 병합하면 root와 모든 하위 블릿의 접힘 상태가 복원된다.
- 기존의 “접힘은 기기 로컬 상태라 원격 갱신에서 보존한다” 규칙과 테스트는 제거한다.
- 제목 편집과 접힘이 서로 다른 기기에서 동시에 일어나면 기존 행 단위 HLC 승자가 둘 다 결정한다.

### 10.3 형식 호환성

`format_version: 3`은 접힘 필드를 포함하는 새 개발 형식이다. `plugin_state` 추가에 맞춰 Notes SQLite schema version도 올린다. GN 파일만 먼저 v3로 쓰는 혼합 기간을 두지 않고, GN bootstrap 활성화·모든 일반 topic 접힘 지원·format 상수·SQLite schema를 마지막 통합 단계에서 한 번에 전환한다.

현재 `yonalist-notes`와 `yonalist-trash`가 같은 format version 상수를 사용하므로 `trash.md` envelope도 이때 v3로 올라간다. trash의 field와 body 의미는 바뀌지 않는다. 최종 parser는 두 kind 모두 정확히 v3만 받는다.

사용자가 마이그레이션을 원하지 않았으므로 v2 파일이나 이전 SQLite schema를 자동 변환하는 코드와 호환 분기를 만들지 않는다.

개발 검증은 새 Vault 또는 Notes 데이터 초기화 후 수행한다. 이전 형식을 발견하면 지원하지 않는 형식으로 명확히 중단하고, 파일 내용을 부분적으로 추측해 가져오거나 조용히 삭제하지 않는다.

## 11. 오류와 데이터 안전

- GN API 새로고침 실패는 루트 파일이나 접힘 상태를 변경하지 않는다.
- 웹 열기 실패는 GitHub 완료 상태를 바꾸지 않는다. 로컬 `viewedAt` 기록은 기존 `openNotification` 동작을 그대로 따른다.
- GitHub 완료 요청 실패는 알림을 미완료로 유지한다.
- 손상된 plugin frontmatter나 GN body는 격리하고 자동 덮어쓰지 않는다.
- GN 루트 아래 저장된 DB 자식이 발견되면 exporter가 이를 숨기지 않고 불변식 오류를 반환한다.
- 고정 GN UUID를 일반 노트로 가져오거나, 다른 UUID가 `plugin: github-notifications`를 주장하면 거부한다.
- 토큰, API 응답 전문 또는 로컬 민감 경로를 오류에 포함하지 않는다.

## 12. 테스트 전략

모든 구현은 실패하는 테스트를 먼저 추가하는 순서로 진행한다.

### 12.1 형식과 병합

- 일반 v3 root의 `root_collapsed` round-trip
- 모든 깊이의 일반 node `collapsed` token round-trip
- 원격 최신 접힘 적용, 오래된 접힘 거부, equal-HLC hand edit 정규화
- GN plugin 표식, 고정 UUID, 제목, root collapse와 접힌 날짜 키 round-trip
- 중복 `collapsed_group` 정규화 및 안정된 출력 순서
- GN body, note, 금지 상태, 잘못된 UUID와 불완전 plugin 표식 격리
- `yonalist-notes`와 `yonalist-trash`가 함께 v3로 출력되며 v2 및 누락된 format version을 지원하지 않음

### 12.2 생성과 저장소 경계

- 기존 GN 파일을 seed보다 먼저 병합
- 파일과 행이 없을 때 고정 UUID 루트를 정확히 한 개 생성
- 정상 GN 행만 남고 표준 파일이 삭제되면 missing-topic recovery가 파일을 다시 발행
- 손상되어 격리된 GN 표준 파일은 seed/recovery가 덮어쓰지 않음
- 늦게 도착한 다른 GN 파일을 최초 발행이 덮어쓰지 않음
- GN은 최상위 순서 변경과 root collapse만 일반 node 명령으로 허용
- 날짜 접힘의 명시적 boolean 명령이 재시도에 안전하고 Undo/Redo에서 복원
- GN 아래 생성·붙여넣기·이동·복원과 GN의 편집·삭제·보관 등을 거부
- 투영된 날짜와 알림이 `notes_nodes`와 Markdown body에 없음

### 12.3 UI

- 저장 순서 `[일반 A, GN, 일반 B]`가 좌측 목록과 `All`에 동일하게 표시
- GN을 두 일반 루트 사이로 실제 drag한 뒤 Markdown, 재시작과 빈 기기 import에서도 같은 순서가 복원
- GN이 일반 루트와 같은 CSS 구조를 쓰고 편집기·더보기 메뉴는 없음
- 좌측 GN을 선택하면 멈춤 없이 같은 Notes 줌 renderer가 열림
- GN 줌에는 제목 focus, page menu, export와 child composer가 없음
- `All`의 root collapse가 투영 자식을 숨기고 다시 열며 재로딩 후 복원
- GN 줌 화면은 root collapse와 무관하게 내용을 표시
- 펼친 `All` GN과 GN 줌이 source lease·polling·1분 projection clock을 활성화
- `All`에서 lease를 활성화해도 GN 줌으로 화면이 전환되지 않음
- GN을 접거나 다른 Notes scope로 이동하고 GN 줌도 아니면 Notes의 source lease가 해제됨
- `sortableIds`에는 GN이 있고 `selectionVisibleIds`에는 없으며 런타임 행은 둘 다 제외
- GN sortable DOM 범위가 투영 자식 높이까지 커지지 않음
- GN을 수평 drag해 일반 루트의 자식으로 만들 수 없고 일반 루트도 GN의 자식으로 만들 수 없음
- 일반 루트가 GN 앞뒤를 통과하는 최상위 drag는 허용
- GN 직후 일반 루트의 Tab이 GN 아래 들여쓰기를 만들지 않고 `Move To` 대상에도 GN이 없음
- 날짜 그룹은 기본 펼침이고 접힌 날짜 키만 숨김
- `All`에서 접은 날짜가 GN 줌에서도 접혀 있고, 줌에서 펼친 상태가 `All`과 Markdown에 즉시 반영
- 새로고침 뒤 알림이 다른 날짜로 이동하며 기존 날짜 키 접힘을 재적용
- projection key와 Markdown `collapsed_group`이 같은 `YYYY.MM.DD` 값을 사용
- 알림 note에 잘못된 자식 화살표가 없음
- Type 아이콘과 기존 Notifications 부제 형식이 표시
- 기존 `Globe` 아이콘 버튼이 정확한 외부 URL을 한 번 열고 완료 요청은 보내지 않음
- Globe 경로가 기존 규칙대로 해당 URL의 로컬 `viewedAt`을 기록
- 연결·로딩·빈 결과·오류/retry 상태 행이 Notes 저장·선택·정렬에 들어가지 않음
- GN과 날짜 접힘 버튼의 키보드 동작 및 `aria-expanded`가 정확함
- GN sortable 블릿의 키보드 drag와 읽기 전용 제목의 Enter/Space 줌이 충돌하지 않으며 ArrowUp/Down focus가 일반 행 사이를 통과

### 12.4 기기 간 시나리오

1. 기기 A에서 일반 root, 일반 하위 블릿, GN root와 한 날짜 그룹을 접는다.
2. v3 Markdown 파일만 새 기기 B의 빈 Vault로 동기화한다.
3. B가 같은 루트 UUID와 순서를 만들고 모든 접힘 상태를 복원하는지 확인한다.
4. B에서 알림 스냅샷을 갱신해도 알림 자식은 파일에 추가되지 않고 접힌 날짜만 유지되는지 확인한다.

### 12.5 회귀 검증

- 외부 알림 완료 성공·실패와 스냅샷 rollback 테스트
- 기존 Notifications pane 검색·Only new·날짜 그룹·상세·웹 열기
- 저장된 GN 행이 Recent·Starred·Tags·Archive·Trash·Notes 검색 결과에서 제외
- Notes 전체 frontend 및 Rust 테스트
- lint, architecture 검사, production build
- Tauri 개발 빌드에서 직접 순서·접힘·재시작·웹 열기 확인

## 13. 구현 순서

1. 고정 GN 루트와 plugin frontmatter 계약, GN용 `root_collapsed` 형식을 격리된 fixture로 추가한다.
2. GN의 `plugin_state` 저장 필드와 parser/exporter/merger 경로를 준비한다.
3. bootstrap의 기존 파일 우선 병합과 GN 단일 seed/no-clobber 발행을 구현하되 format cutover 전에는 production seed를 활성화하지 않는다.
4. 저장소에서 GN의 허용·금지 명령 경계를 고정하고 root 순서 변경을 재사용한다.
5. GN 날짜 접힘 상태를 root HLC와 같은 저장·export·merge 흐름에 연결한다.
6. 좌측 목록과 `All`을 `rootIds` 단일 순회로 통합하고 GN을 일반 블릿 구조로 렌더링한다.
7. 날짜 그룹 접힘, 갱신 시 재그룹, 알림 note/Type/Globe UI를 완성한다.
8. 마지막으로 일반 Notes topic의 root/node 접힘 자료구조, parser, exporter와 merger를 연결하고, GN production seed·topic/trash v3·SQLite schema를 원자적으로 활성화한다.
9. 집중 테스트, 전체 검증, Tauri 개발 빌드 수동 검증을 수행한다.

사용자가 요청한 일반 블릿 접힘 Markdown 변경은 자료구조를 포함해 8단계에서 수행한다. GN에 먼저 필요한 plugin root 접힘 경로만 앞 단계에서 구현해 GN 통합 회귀를 분리해 확인한다.

## 14. 완료 기준

1. GN이 좌측 목록과 `All`에서 저장된 일반 루트 순서에 정확히 나타난다.
2. GN은 일반 블릿과 같은 모양이며 허용되지 않은 편집 동작이 없다.
3. GN 루트는 기본 펼침이고 사용자가 접은 상태가 재시작 및 다른 기기에서 복원된다.
4. 날짜 그룹은 기본 펼침이고 GN에 저장되는 플러그인 전용 상태는 접힌 절대 날짜 키뿐이며, 같은 값이 `plugin_state`와 GN Markdown frontmatter 사이에서 round-trip한다.
5. 알림 갱신 때 날짜 자식이 재배치되며 날짜 접힘 상태가 다시 적용된다.
6. 날짜 그룹과 알림 내용은 SQLite 자식이나 Markdown body로 저장되지 않는다.
7. 알림 행은 Type 아이콘, 기존 부제형 note, 기존 Globe 버튼을 사용한다.
8. 일반 Notes의 root와 모든 하위 블릿 접힘 상태가 v3 Markdown으로 round-trip한다.
9. 새 기기가 Markdown 파일만으로 순서와 접힘 상태를 복원한다.
10. 전체 자동 검증과 Tauri 개발 빌드의 사용자 시나리오가 통과한다.
