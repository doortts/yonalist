# Notes Github Notifications 네이티브 읽기 전용 블릿 설계

**상태:** 사용자 승인 완료, 구현 계획으로 전환

**날짜:** 2026-07-24

**대체 범위:**

- `2026-07-23-notes-github-notifications-presentation-design.md`의 가상 날짜·알림 projection
- `2026-07-23-notes-plugin-root-markdown-and-collapse-sync-design.md`의 projection-only/materialized hybrid child 합성
- GN 전용 outline row, focus 순서, drop target과 날짜 그룹 렌더링
- GN 소유 행에 일반 `isReadonly`를 사용하지 않는다는 기존 결정

이 문서와 위 문서가 충돌하면 이 문서가 우선한다. GitHub가 알림 제목·설명·URL·Type·원격 읽음 상태의 권위라는 원칙과, 사용자 하위 블릿은 Notes가 소유한다는 원칙은 유지한다.

## 1. 한눈에 보는 결론

`Github Notifications`(이하 GN)를 별도 projection outline이 아니라 **일반 Notes 블릿으로만 구성된 하나의 네이티브 트리**로 바꾼다.

```text
Github Notifications                  readonly NoteNode
  07.24                               readonly NoteNode
    [PR] Add keyboard navigation      readonly NoteNode
      확인할 파일                      일반 NoteNode
      후속 작업                        일반 NoteNode
    [Issue] Fix notification badge    readonly NoteNode
```

- GN root, 날짜와 GitHub 알림을 모두 실제 `NoteNode`로 저장한다.
- GitHub가 관리하는 모든 노드는 기존 일반 블릿의 `isReadonly: true`를 사용한다.
- GitHub 연결 정보는 `pluginMeta`로 식별하지만 편집 보호, focus, zoom, collapse, child 생성과 키보드 동작은 기존 readonly 블릿 규칙을 재사용한다.
- 사용자 하위 블릿은 `pluginMeta`가 없는 일반 `NoteNode`이며 기존 편집·이동·완료·첨부·Undo/Redo·Markdown 동기화를 그대로 사용한다.
- GitHub 알림이 원격 snapshot에서 사라져도 사용자 descendant가 있으면 마지막 snapshot과 subtree를 보존한다. 사용자 descendant가 없을 때만 제거한다.
- GitHub 읽음은 블릿을 먼저 낙관적으로 완료한 뒤 durable Outbox에서 백그라운드로 전송한다.
- 일반 블릿 행에 선택적인 공용 **선행 아이콘 슬롯**을 추가하고 GitHub Type 아이콘을 블릿 마크와 제목 사이에 표시한다.
- GN 전용 projection row, editor, focus adapter, drag/drop target, 날짜 group CSS와 materialization adapter는 제거한다. 검증된 “한 번에 하나, 최신 snapshot만 유지, 동일 snapshot no-op” 직렬 pump 알고리즘은 native source sync에 재사용한다.

목표는 “외부 항목을 Notes처럼 보이게 하기”가 아니라 “외부에서 내용이 갱신되는 readonly Notes 블릿” 하나만 남기는 것이다.

## 2. 현재 설계의 문제와 원인

2026-07-23 설계는 모든 원격 알림을 Notes 데이터와 Markdown에 저장하지 않기 위해 다음 hybrid 구조를 선택했다.

1. GN root만 일반 저장 노드다.
2. 아직 사용자가 구조를 만들지 않은 날짜와 알림은 `ExternalBullet` projection이다.
3. 사용자 sibling이나 child가 필요할 때만 날짜와 알림을 `NoteNode`로 materialize한다.
4. 저장 노드와 projection row를 `githubNotificationsOutline`에서 합성한다.

그 결과 화면에는 하나의 트리처럼 보이지만 실제로는 다음 경로가 병렬로 존재한다.

- 일반 `OutlineNodeRow`와 Notes keyboard/focus/selection/sort 경로
- `NotesExternalOutlinePane`·`NotesExternalBulletRow`와 외부 row 전용 경로

날짜는 일반 `<li>` 재귀 계층이 아니라 전용 group `<section>`으로 렌더링되고, 원격 알림은 일반 node map·selection·sortable 목록에 포함되지 않는다. 따라서 들여쓰기, guide, 행 간격, zoom, 제목·note·이미지 focus, 키보드 이동과 drag/drop이 일반 블릿과 달라지는 것은 CSS 한두 줄의 문제가 아니라 데이터·렌더링 구조의 결과다.

이 설계에서는 외형을 맞추더라도 기능을 추가할 때마다 일반 블릿 경로와 projection 경로를 각각 수정해야 한다. 이번 변경은 두 경로를 유지한 채 스타일만 수정하지 않고 GN을 일반 노드 체계로 합친다.

## 3. 목표와 비대상

### 목표

1. GN root·날짜·알림을 일반 Notes 계층과 같은 `NoteNode` 트리로 표현한다.
2. 모든 GN 행이 일반 outline row, indentation guide, focus, zoom, collapse, keyboard와 child 생성 경로를 사용한다.
3. GitHub 소유 노드는 기존 `isReadonly` 기능으로 내용을 보호한다.
4. 알림 아래의 사용자 블릿은 완전한 일반 Notes 블릿으로 저장·동기화한다.
5. 원격 snapshot 갱신이 사용자 subtree를 이동할 때 보존하고, 임의로 수정·재정렬·삭제하지 않는다.
6. GitHub 읽음을 낙관적으로 표시하고 오프라인·일시 오류를 Outbox에서 자동 재시도한다.
7. 일반 블릿이 기능별 선행 아이콘을 표시할 수 있는 공용 presentation contract를 제공한다.
8. 변경 없는 polling이 DB, Markdown, workspace revision과 React render를 만들지 않게 한다.

### 비대상

- GitHub 알림 제목·설명을 사용자가 영구 편집하는 기능
- GitHub 알림을 unread로 되돌리는 원격 API
- 사용자가 자유롭게 고르는 custom bullet icon
- 범용 설치형 plugin SDK나 provider capability framework
- 기존 전역 Notifications pane의 검색·필터·상세 UI 변경
- GitHub 알림 외의 외부 source 구현
- 읽음 Outbox를 위한 별도 두 번째 queue 시스템
- 기존 hybrid GN DB·Markdown·Outbox 데이터의 migration이나 호환성 유지
- 개발 중인 DB schema와 파일 형식의 versioning

## 4. 네이티브 트리와 저장 모델

### 4.1 계층

GN의 저장 계층은 다음 하나다.

```text
GN root
  날짜
    GitHub 알림
      사용자 블릿
```

- GN root, 날짜와 GitHub 알림은 `isReadonly: true`다.
- 사용자 블릿은 기본 `isReadonly: false`이며 사용자가 기존 메뉴로 readonly를 켤 수 있다.
- GitHub 소유 노드에는 `pluginMeta`가 있고 사용자 노드에는 없다.
- 일반 readonly와 마찬가지로 GitHub 소유 노드 아래에도 일반 child를 생성할 수 있다.
- 사용자가 root, 날짜 또는 알림 어느 위치에 일반 child를 만들더라도 일반 Notes 노드로 취급한다.
- provider refresh는 `pluginMeta`가 있는 노드만 갱신하고 일반 노드에는 content mutation을 보내지 않는다.

GN 소유 노드의 readonly 해제는 노출하지 않는다. 내용의 권위가 GitHub에 있으므로 메뉴에는 토글 대신 `GitHub에서 관리됨` 상태를 표시한다. 이 한 가지 소유권 표시는 일반 readonly의 편집·focus·child 동작을 갈라놓는 새 mode가 아니다.

### 4.2 결정적 ID

- GN root는 기존 고정 UUID를 유지한다.
- 날짜 ID는 GN root UUID와 canonical `YYYY.MM.DD` date key로 결정한다.
- 알림 ID는 GN root UUID와 serialized external notification key로 결정한다.
- 기존 UUID validator가 요구하는 canonical v4 bit 정규화를 유지한다.
- 같은 GitHub host·account·thread는 모든 기기에서 같은 ID를 얻고, 다른 host나 account는 충돌하지 않는다.

결정적 ID 덕분에 재시작, polling과 다른 기기의 Markdown merge에서 같은 알림을 새 노드로 중복 생성하지 않는다.

### 4.3 plugin metadata

`pluginMeta`는 source identity와 마지막 원격 snapshot만 표현한다.

```ts
type GithubNotificationsPluginMeta =
  | {
      kind: "github-notifications-root";
      connectionId: string;
    }
  | {
      kind: "github-notifications-date";
      dateKey: string;
      sourcePresent: boolean;
    }
  | {
      kind: "github-notification";
      notificationKey: string;
      notificationType:
        | "issue"
        | "pull-request"
        | "discussion"
        | "release"
        | "notification";
      url: string;
      updatedAt: string;
      unread: boolean;
      sourcePresent: boolean;
    };
```

- root·날짜·알림의 일반 `isReadonly` 값은 항상 `true`다.
- `pluginMeta`가 capability table이나 별도 readonly origin으로 동작하지 않는다.
- 알림 title과 supporting note는 마지막 GitHub snapshot이다.
- supporting note는 `저장소명, Jun 4, 2026`처럼 `updatedAt`에서 만든 안정적인 절대 날짜를 사용한다. 현재 시각에 따라 바뀌는 `10d ago` 문자열은 저장하지 않아 동일 snapshot polling이 DB·Markdown write를 만들지 않는다.
- `sourcePresent: false`는 원격 목록에서 사라졌지만 사용자 descendant 때문에 보존된 노드를 뜻한다.
- Outbox의 pending·blocked 상태는 queue가 권위이며 `pluginMeta`에 중복 저장하지 않는다.
- 날짜 접힘은 일반 `NoteNode.isCollapsed`를 사용한다. GN root의 `collapsedGroups`는 제거한다.

### 4.4 완료 상태

- 알림의 `completedAt`은 화면에서 보이는 Notes 완료 상태다.
- 마지막 원격 snapshot의 `unread`는 `pluginMeta.unread`에 유지한다.
- pending 또는 blocked mark-read Outbox 작업이 있으면 `completedAt`의 낙관적 값이 원격 `unread: true`보다 우선한다.
- Outbox 작업이 없을 때 `unread: false`는 완료 상태로 반영한다.
- 더 오래된 snapshot이나 같은 timestamp의 stale unread 값은 성공한 읽음 상태를 되돌리지 못한다.
- root와 날짜의 완료는 원격 counterpart가 없으므로 일반 readonly Notes 완료 동작이다.

## 5. GitHub snapshot 동기화

### 5.1 한 번의 batch

완전히 성공한 GitHub snapshot 하나를 한 번의 저장소 transaction으로 적용한다.

1. snapshot을 canonical notification key로 dedupe한다.
2. 날짜와 알림의 결정적 ID를 계산한다.
3. 기존 `pluginMeta` node와 비교해 생성·content 변경·날짜 이동·source presence 변경만 계산한다.
4. source-owned mutation을 하나의 SQLite transaction으로 commit한다.
5. 변경이 있을 때만 workspace revision과 Markdown dirty marker를 한 번 갱신한다.
6. frontend는 최종 workspace patch 또는 한 번의 workspace snapshot만 반영한다.

부분 결과, loading 상태와 실패한 refresh는 부재 판단에 사용하지 않는다. 이 상태에서는 기존 트리를 유지하고 생성·갱신 가능한 항목만 단조롭게 합칠 수 있지만 어떤 노드도 삭제하거나 `sourcePresent: false`로 바꾸지 않는다.

### 5.2 변경과 날짜 이동

- title, note, Type, URL과 `updatedAt`은 더 새로운 source snapshot만 적용한다.
- 알림의 날짜가 바뀌면 알림 노드와 전체 descendants를 새 날짜 노드 아래로 함께 옮긴다.
- descendants의 UUID, content, completion, readonly, collapse와 내부 순서는 유지한다.
- 날짜 수준에 따로 만든 일반 sibling은 알림 subtree가 아니므로 기존 날짜에 남는다.
- 새 날짜가 없으면 같은 transaction에서 만든다.
- 이전 날짜가 비었을 때는 사용자 descendant가 없는 경우에만 정리한다.

GitHub가 관리하는 날짜와 알림끼리는 최신순을 유지한다. provider는 `pluginMeta` node의 sort key만 바꾸며 일반 사용자 node의 sort key나 상대 순서를 쓰지 않는다. 일반 node가 source-owned sibling 사이에 있더라도 provider refresh가 그 일반 node 자체를 이동시키지 않는다.

### 5.3 원격에서 사라진 알림

성공한 authoritative snapshot에서 기존 알림이 빠졌을 때 다음 규칙을 적용한다.

- 일반 사용자 descendant가 없으면 notification node를 제거한다.
- 일반 사용자 descendant가 있으면 마지막 title·note·URL·Type·날짜를 유지하고 `sourcePresent: false`로 바꾼다.
- 보존된 알림이 나중에 다시 나타나면 같은 ID를 갱신하고 `sourcePresent: true`로 복구한다.
- notification 정리 후 날짜 아래에 source-owned 알림과 일반 사용자 node가 모두 없을 때만 날짜를 제거한다.
- source failure, offline, pagination 중간 결과와 account 전환 중간 상태에서는 제거하지 않는다.

이 제거는 provider-owned 정리이며 사용자 Undo history에 넣지 않는다. 사용자 subtree가 포함된 노드는 자동 정리 대상이 아니다.

### 5.4 여러 기기와 Markdown

- GN root, 날짜, 알림과 사용자 subtree는 하나의 일반 Notes topic tree로 Markdown에 기록한다.
- provider metadata와 `isReadonly: true`를 round-trip한다.
- source refresh는 GitHub `updatedAt` 가드를 사용하고 사용자 rows는 기존 row HLC merge를 사용한다.
- 동일 notification key의 여러 기기 refresh는 결정적 ID 하나로 합쳐진다.
- source refresh는 사용자의 Undo/Redo stack을 만들지 않는다.
- 변경 없는 snapshot은 HLC, dirty marker와 Markdown 파일을 전혀 바꾸지 않는다.
- GN native note를 위해 별도 projection clock을 유지하지 않는다. 상대 시간 표시는 기존 전역 Notifications pane의 presentation에만 남긴다.

## 6. 낙관적 GitHub 읽음 Outbox

### 6.1 기존 Outbox 확장

현재 `.yonalist/outbox/`의 durable queue와 `useOutboxSync` lifecycle을 재사용한다. 별도 queue를 만들지 않고 다음 operation을 추가한다.

```ts
type OutboxOperationKind =
  | "create_issue"
  | "create_comment"
  | "mark_notification_read";
```

mark-read operation은 token을 저장하지 않고 다음 identity만 가진다.

- operation ID
- GitHub host와 connection/account identity
- thread ID와 canonical notification key
- local NoteNode ID
- 생성 시각, status와 마지막 오류

`local_file_path`와 body가 필요한 기존 create operation과 mark-read operation의 payload를 discriminated union으로 분리한다. 모든 operation에 의미 없는 빈 local path를 강제하지 않는다.

같은 connection과 thread에는 unresolved mark-read operation을 최대 하나만 둔다. 반복 완료 shortcut이나 재시도는 같은 intent를 재사용한다.

### 6.2 사용자 동작

알림에서 기존 완료 메뉴나 `Cmd/Ctrl+Enter`를 누르면 다음 순서로 처리한다.

1. frontend에서 해당 readonly 알림을 즉시 완료 상태로 표시한다.
2. mark-read intent를 Outbox에 durable하게 기록한다.
3. 해당 node의 `completedAt`을 저장하고 optimistic 상태를 확정한다.
4. 온라인이고 실제 GitHub endpoint에 도달할 수 있으면 background 요청을 시작한다.

사용자가 보는 완료 표시는 어떤 network 요청보다 먼저 바뀐다. 다만 local durability에서는 Outbox intent를 node 완료 commit보다 먼저 기록해 “완료는 남았지만 보낼 작업은 없는” crash window를 막는다. Outbox 기록이 실패하면 durable intent가 없으므로 완료 commit을 확정하지 않고 저장 오류를 알린다. 화면에 먼저 적용한 optimistic state가 있다면 즉시 원상 복구한다.

Outbox는 intent의 권위다. 앱이 2단계 뒤 종료되고 3단계 전에 중단되어도 시작 reconciliation이 pending operation을 찾아 node의 낙관적 완료 상태를 복원한 뒤 전송한다.

### 6.3 성공·실패·재시도

- 성공하면 `pluginMeta.unread`를 false로 갱신하고 Outbox document를 제거한다.
- 즉시 성공한 정상 요청은 별도 성공 Snackbar를 반복해서 띄우지 않는다.
- 이미 실패 알림을 보였던 operation이 나중에 성공하면 복구 완료를 한 번만 알린다.
- network, DNS, timeout, 429와 5xx는 retryable이다.
- 서버의 `Retry-After`가 있으면 우선하고, 없으면 jitter가 포함된 짧은 exponential backoff를 적용한다.
- 제한된 in-session 재시도 후에는 polling loop를 만들지 않고 다음 실제 endpoint reachability 회복을 기다린다.
- 연결이 복구되면 mark-read operation은 별도 확인 없이 자동 재시도한다.
- 기존 create issue/comment Outbox의 reconnect 확인 정책은 변경하지 않는다.
- 401·403과 검증 불가능한 identity는 `blocked`다. 완료 상태는 유지하고 Outbox에서 재시도 또는 취소를 기다린다.
- 이미 사라진 알림의 404·410은 더 이상 unread 대상이 없으므로 idempotent success로 처리한다.

최초 retryable 실패 때 `GitHub 읽음 처리가 대기 중입니다. 연결되면 다시 시도합니다.` Snackbar와 Outbox badge를 표시한다. 같은 operation의 자동 재시도마다 알림을 반복하지 않는다. blocked 전환은 원인과 다음 행동을 한 번 알린다.

### 6.4 refresh overlay와 취소

- pending·failed·blocked mark-read operation이 있는 알림은 원격 snapshot이 `unread: true`여도 로컬 완료 상태를 유지한다.
- source refresh는 snapshot metadata는 갱신할 수 있지만 unresolved local intent를 제거하거나 완료를 되돌리지 않는다.
- 사용자가 Outbox에서 재시도를 선택하면 같은 operation을 다시 보낸다.
- 사용자가 취소하면 operation을 제거하고, 아직 성공 acknowledgement가 없으며 최신 source snapshot이 unread이면 `completedAt`을 해제한다.
- mark-read operation은 편집할 payload가 없으므로 Outbox에서 `편집`을 제공하지 않는다. 대상 열기, 재시도와 취소만 제공한다.

## 7. 일반 outline UI

### 7.1 하나의 row와 하나의 tree

GN root·날짜·알림·사용자 node를 모두 일반 recursive outline과 `OutlineNodeRow`로 렌더링한다.

- 날짜는 전용 `<section>` group이 아니라 GN root의 실제 child `<li>`다.
- 알림은 날짜의 실제 child다.
- 사용자 child는 알림 아래의 동일한 recursive list에 나타난다.
- 일반 depth 계산, 1px guide, row height, hover, focus와 drop geometry를 그대로 사용한다.
- GN 전용 `.notes-external-group`, `.notes-external-children`과 외부 row 간격은 사용하지 않는다.

GN 소유 node는 일반 readonly와 같은 content protection을 사용한다.

- caret 이동, 선택, 복사, 임시 입력과 child 생성 허용
- title·note·attachment 영구 수정, 직접 삭제와 구조 이동 차단
- collapse, zoom과 일반 완료 UX 허용
- provider-owned readonly 해제만 `GitHub에서 관리됨` 상태로 대체

사용자 child는 일반 node이므로 기존 title·note 편집, attachment, completion, Tab/Shift+Tab, drag, paste, delete와 Undo/Redo를 그대로 사용한다.

### 7.2 공용 선행 아이콘 슬롯

모든 일반 outline row에 선택적인 presentation slot을 추가한다.

```text
[접기] [블릿 마크/체크박스] [기능 아이콘] [블릿 내용] [후행 액션]
```

- slot 이름은 `leadingIcon`으로 한다.
- row view/presentation adapter가 semantic icon kind와 label을 제공한다.
- `NoteNode`나 Markdown에 순수 표시용 icon 이름을 새로 저장하지 않는다.
- 기능 metadata로부터 icon을 파생한다. 향후 다른 Notes 기능도 같은 slot을 사용할 수 있다.
- 아이콘이 없으면 column과 gap을 만들지 않아 기존 일반 블릿의 title 시작 위치를 바꾸지 않는다.
- 아이콘이 있으면 effective marker 뒤, title 바로 앞에 4px gap으로 표시한다.
- Todo row에서는 checkbox 뒤, title 앞에 표시한다.
- 크기는 16px이며 비대화형이다. button, tab stop, drag handle이나 별도 selection target이 아니다.
- indentation와 guide는 계속 bullet center를 기준으로 한다.
- completed row에서는 title과 같은 muted color를 사용하되 아이콘 자체에 취소선을 긋지 않는다.
- semantic label을 보조기술에 제공하고 unknown kind는 안전한 fallback을 사용한다.

GitHub 알림 Type mapping은 다음과 같다.

| GitHub Type | Lucide icon | 접근성 이름 |
| --- | --- | --- |
| Issue | `CircleDot` | `Issue` |
| Pull Request | `GitPullRequest` | `Pull request` |
| Discussion | `MessageCircle` | `Discussion` |
| Release | `Tag` | `Release` |
| 그 외 | `Bell` | `GitHub notification` |

GN root와 날짜는 선행 Type 아이콘을 표시하지 않는다. 알림 node만 `pluginMeta.notificationType`에서 `leadingIcon`을 얻는다.

### 7.3 후행 상태와 외부 열기

- GitHub 대상 열기는 title 뒤의 기존 크기 `ExternalLink` trailing action으로 제공한다.
- pending/failed/blocked 읽음 상태는 title 내용을 밀어내는 별도 layout이 아니라 작은 비대화형 sync status와 Outbox badge로 나타낸다.
- sync status에는 `읽음 처리 대기 중` 또는 `읽음 처리 실패` 접근성 이름을 제공한다.
- 즉시 성공한 상태에는 지속적인 sync icon을 남기지 않는다.
- 외부 열기는 completion이나 Outbox mutation을 만들지 않는다.

### 7.4 focus, keyboard와 zoom

- GN row를 별도 합성 focus 순서에 넣지 않는다. 일반 visible node/editor 순서 하나만 사용한다.
- 제목, supporting note 또는 이미지 editor에 focus가 있으면 가장 가까운 owning `data-outline-id`를 기준으로 zoom-in한다.
- zoom-out은 일반 breadcrumb/history와 Workflowy-compatible shortcut 경로를 그대로 사용한다.
- readonly 알림에서 Enter, Shift+Enter, Tab/Shift+Tab, Arrow, Backspace와 clipboard는 기존 readonly resolver를 사용한다.
- 사용자 child는 일반 resolver를 사용한다.
- collapse나 `showCompleted`로 focused row가 사라질 때는 기존 outline focus 복구 규칙을 적용한다.
- readonly node 자체의 drag가 금지되고 사용자 child의 drag는 일반 sortable context에서 동작한다.

### 7.5 완료 필터

- 낙관적 또는 원격 완료된 알림은 일반 `completedAt` 필터를 사용한다.
- `showCompleted === false`이면 완료된 알림과 subtree를 일반 Notes 규칙대로 숨긴다.
- root·날짜와 사용자 node도 기존 Notes 완료 필터를 따른다.
- pending·blocked Outbox operation은 완료 표시를 유지하므로 같은 필터 결과를 유지한다.
- `viewedAt`은 웹 열람 기록이며 완료나 Outbox 상태에 영향을 주지 않는다.

## 8. 제거되는 병렬 경로

GN 표시에서 다음 책임을 제거하거나 일반 경로로 흡수한다.

- `ExternalBullet` 날짜·알림 projection
- `projectGithubNotificationsOutline`의 stored/projected row union
- `NotesExternalOutlinePane`의 날짜 group renderer
- `NotesExternalBulletRow`의 임시 editor와 별도 completion
- projection 전용 editor focus key와 DOM query
- `github-notification-projection` drop target
- projection-only materialize-and-reparent adapter
- `githubMaterializedBridge`의 partial/materialized 합성 갱신
- `collapsedGroups` 날짜 접힘 source
- `.notes-external-group`, `.notes-external-children`, `.notes-external-row` GN layout

`ExternalBullet` abstraction이 다른 기능에서 사용되면 범용 코드를 즉시 삭제하지 않는다. GN production 경로의 참조를 제거한 뒤 dead-code 검증 결과에 따라 별도 정리한다.

GN은 기존 Notifications source snapshot을 구독한다. GN을 위해 두 번째 fetch interval이나 독립 polling lease를 만들지 않는다.

## 9. 개발 데이터와 형식 정책

Yonalist가 active development 단계인 동안에는 DB schema와 persisted file format에 versioning이나 migration을 추가하지 않는다.

### 9.1 현재 형식을 제자리에서 변경

- Notes SQLite schema, Markdown parser·writer와 Outbox payload contract를 현재 형식에서 직접 수정한다.
- 이번 변경을 위해 `format_version: 4`, 새 SQLite schema version 또는 migration table을 추가하지 않는다.
- 기존 `format_version` 필드나 schema 상수가 이미 있더라도 이번 변경에서 값을 올리지 않는다.
- dual reader, old/new writer, compatibility branch와 일회성 data converter를 만들지 않는다.
- GN frontmatter의 `plugin_children`은 alternate child mode가 더 이상 없으므로 제거하고 대체 필드를 만들지 않는다.
- `collapsed_groups`는 현재 contract에서 제거하고 날짜 node의 일반 `isCollapsed`만 사용한다.
- GN root·date·notification metadata에는 현재 형식에서 `isReadonly: true`를 기록한다.
- parser, exporter, fixture와 schema 테스트는 새 native invariant를 현재 기준으로 함께 갱신한다.

버전과 migration은 배포된 데이터의 backward compatibility가 명시적으로 요구되는 시점에 별도 설계한다. 그 요구가 없는 개발 단계에서는 과거 개발 데이터 보존을 위해 production code를 복잡하게 만들지 않는다.

### 9.2 개발 데이터 초기화

- 구현과 검증은 변경 전 Notes SQLite, 생성된 Notes Markdown과 GN 관련 pending Outbox가 없는 깨끗한 개발 데이터에서 시작한다.
- 기존 hybrid GN 데이터, materialized user subtree와 과거 형식 파일을 읽거나 변환하는 동작은 지원하지 않는다.
- 앱이 기존 개발 데이터를 자동 추측·삭제하는 migration을 만들지 않는다.
- 초기화 대상은 테스트 Vault 또는 사용자가 명시한 개발 Notes 데이터로 좁히고, 다른 Vault 파일·GitHub 인증·앱 설정은 건드리지 않는다.
- 필요한 개발 데이터 초기화 절차와 대상 경로는 구현 계획과 수동 검증 단계에 명시한다.
- 초기화 뒤 GN root를 seed하고 현재 GitHub cache 또는 다음 정상 snapshot에서 native readonly tree를 새로 만든다.

### 9.3 Outbox 현재 계약

- 기존 create issue/comment operation은 현재 기능이므로 계속 읽고 동기화한다.
- 새 `mark_notification_read` payload를 현재 discriminated union에 직접 추가한다.
- 변경 전에 존재하지 않았던 GN mark-read operation을 위한 migration은 만들지 않는다.
- 알 수 없는 operation은 자동 삭제하거나 전송하지 않고 기존 안전한 오류 경로로 보낸다.
- token과 전체 API response는 Outbox 파일이나 오류에 기록하지 않는다.

## 10. 오류와 데이터 안전

- GitHub refresh 실패는 Notes tree, source presence, completion과 user subtree를 바꾸지 않는다.
- authoritative snapshot transaction 중 하나라도 실패하면 생성·갱신·이동·정리를 모두 rollback한다.
- provider refresh는 `pluginMeta` node만 쓸 수 있고 일반 node content mutation은 저장소에서 거부한다.
- readonly user mutation은 기존 repository guard가 거부한다.
- user descendant가 있는 source-missing notification은 자동 삭제할 수 없다.
- mark-read Outbox persist 실패는 optimistic completion을 확정하지 않는다.
- mark-read 성공 뒤 queue cleanup이 실패하면 재시도는 idempotent하며 GitHub read를 다시 unread로 만들지 않는다.
- stale unread refresh는 unresolved Outbox intent나 acknowledged read를 되돌리지 않는다.
- blocked operation은 자동 retry loop에 남지 않는다.
- 사용자 Outbox 취소는 remote acknowledgement가 없는 unread snapshot에서만 local completion을 해제한다.
- 계정이나 connection이 바뀌어도 다른 connection의 pending operation을 새 token으로 보내지 않는다.
- token, Authorization header, API body 전문과 민감한 로컬 경로를 사용자 오류·로그·Markdown에 포함하지 않는다.

## 11. 성능 불변식

이번 통합은 GN 기능뿐 아니라 일반 블릿 editor의 입력 성능을 보호해야 한다.

### 저장과 네트워크

- GN을 위해 Notifications와 별도의 network polling을 만들지 않는다.
- 같은 canonical snapshot을 반복 적용하면 DB write 0회, dirty marker 0회, Markdown publish 0회, workspace revision 0회다.
- 한 snapshot의 변경은 한 SQLite transaction과 최대 한 번의 GN topic publish로 끝난다.
- source comparison은 notification key 기반 map으로 수행하고 중첩 전체 검색을 피한다.
- pending mark-read는 connection+thread key로 O(1) dedupe한다.
- retry timer는 unresolved operation 수만큼 만들지 않고 Outbox scheduler 하나에서 관리한다.

### React와 editor

- GN snapshot identity가 같으면 Notes tree state object를 교체하지 않는다.
- 변경된 node ID와 ancestor visibility에 필요한 최소 row만 새 revision을 얻는다.
- 일반 블릿 입력은 unrelated GN row를 다시 렌더링하지 않는다.
- 접힌 GN subtree는 DOM에 mount하지 않는다.
- leading icon은 row 안의 단순 presentation이고 별도 state/effect를 만들지 않는다.
- idle 상태에는 기존 shared polling 외의 GN timer나 render loop가 없어야 한다.

### 측정

고정 fixture에서 다음을 변경 전 baseline과 비교한다.

- GN이 닫힌 상태와 열린 상태의 일반 블릿 key-to-paint p50/p95
- 1,000개 알림 initial batch와 동일 snapshot 재적용
- 한 알림 content 변경, 날짜 이동과 source-missing 전환
- 1,000개 알림이 열린 상태에서 관계없는 일반 블릿 100회 입력의 row render count
- 5분 idle 동안 workspace revision, DB write와 Markdown publish count

일반 블릿 입력 p95가 고정 환경 baseline보다 10% 넘게 악화되거나, 동일 snapshot에서 write/render가 발생하면 완료로 보지 않는다. 시간 기반 결과는 render/write count 같은 결정적 지표와 함께 기록한다.

## 12. 테스트 전략

모든 구현은 실패하는 테스트를 먼저 추가한다.

### 12.1 형식·저장소

- 현재 형식의 일반 topic, GN native tree와 Trash round-trip
- GN root·date·notification의 mandatory `isReadonly: true`
- GN user descendants의 일반 readonly true/false 보존
- `plugin_children` 없이 plugin metadata와 source presence round-trip
- 날짜 node의 일반 `isCollapsed` round-trip과 `collapsed_groups` 제거
- 깨끗한 개발 데이터에서 GN root와 native readonly tree seed
- 이전 hybrid fixture·compatibility reader·migration 경로가 production에 없음
- 결정적 root/date/notification ID와 duplicate key 거부
- 일반 child가 있는 source-missing notification 보존
- 일반 child가 없는 source-missing notification과 빈 date 정리
- partial/error snapshot이 어떤 node도 제거하지 않음
- newer snapshot만 content와 날짜를 갱신
- 날짜 이동이 notification descendants만 보존해 이동
- provider mutation이 일반 user node content·sort를 변경하지 않음
- unchanged snapshot이 transaction 결과와 revision을 no-op으로 반환

### 12.2 readonly와 일반 tree

- GN 모든 행이 `OutlineNodeRow`와 일반 recursive `<li>` 구조를 사용
- root → date → notification → user child의 depth와 1px guide
- GN source node의 generic readonly content/delete/move 보호
- readonly node 아래 일반 child 생성·편집·이동·완료·attachment
- 일반 child의 Tab/Shift+Tab과 drag가 기존 규칙을 사용
- title·note·image focus에서 owning node zoom-in
- Workflowy-compatible zoom-out과 breadcrumb/history
- 일반 focus order가 GN과 user rows를 한 번만 순회
- 전용 projection focus/drop query가 production path에 없음

### 12.3 선행 아이콘

- icon 없는 일반 row의 기존 column과 title offset 불변
- standard marker와 Todo checkbox 뒤에 optional icon 표시
- Issue, Pull Request, Discussion, Release와 fallback mapping
- GN root·date에는 Type icon이 없고 notification에만 있음
- icon이 tab stop, button, drag handle이나 selection target을 만들지 않음
- 접근성 이름, completed muted color와 coarse pointer layout
- leading icon이 indentation guide와 drop preview offset을 바꾸지 않음

### 12.4 낙관적 읽음과 Outbox

- 사용자 동작 즉시 completed 표시, Outbox persist 실패 시 rollback
- offline completion이 restart 뒤 queue와 completion을 복원
- stale unread snapshot이 pending·failed·blocked intent를 되돌리지 않음
- 같은 notification 완료 반복이 operation 하나와 request 하나로 합쳐짐
- 성공이 metadata를 unread false로 만들고 queue를 제거
- network/timeout/429/5xx가 retryable로 남음
- reconnect endpoint reachability 뒤 mark-read만 묻지 않고 자동 retry
- create issue/comment reconnect 확인은 유지
- 401/403은 blocked, 완료 유지와 알림 한 번
- 404/410은 idempotent success
- retry마다 Snackbar를 반복하지 않고 회복 성공을 한 번만 알림
- blocked retry와 cancel
- cancel이 acknowledgement 없는 unread source에서 completion을 복원
- 다른 connection/account operation 격리
- Outbox persist 실패가 optimistic completion을 rollback

### 12.5 성능

- unchanged 1,000 notification snapshot의 DB/Markdown/revision/render 0회
- one-node update가 unrelated GN rows와 일반 editor를 rerender하지 않음
- collapsed GN subtree가 mount되지 않음
- 일반 블릿 100회 입력 render-count 회귀 없음
- snapshot batch가 transaction·workspace publish 한 번만 사용
- idle fixture에 추가 timer·revision·write가 없음
- 고정 환경 key-to-paint p50/p95 baseline 비교

### 12.6 회귀와 수동 확인

- 기존 일반 Notes edit, readonly, Todo, drag, clipboard, image, Undo/Redo
- 기존 Notifications pane의 검색·Only new·날짜·상세·웹 열기
- 기존 Outbox create issue/comment sync·reconnect·blocked 동작
- Notes Markdown watcher, iCloud merge와 quarantine
- 전체 frontend 테스트와 Rust 테스트
- lint, architecture 검사와 production build
- Tauri 개발 빌드에서 hierarchy, leading icon, zoom, optimistic read, offline reconnect, blocked/cancel, restart와 performance trace 확인

## 13. 구현 경계와 순서

1. 현재 parser·schema가 native GN readonly tree와 새 Outbox union을 읽도록 실패 테스트를 추가한다.
2. 공용 `leadingIcon` presentation slot과 일반 row 테스트를 먼저 추가한다.
3. provider snapshot을 결정적 readonly `NoteNode` batch로 upsert하는 저장소 경계를 구현한다.
4. source-missing 조건부 보존·삭제와 날짜 이동을 구현한다.
5. 현재 Markdown·SQLite contract와 fixture를 native invariant로 제자리에서 갱신하고 깨끗한 개발 데이터 seed를 검증한다.
6. `mark_notification_read` Outbox, optimistic completion, overlay, retry·blocked·cancel을 연결한다.
7. GN을 일반 outline tree에 연결하고 Type icon·ExternalLink·sync 상태를 표시한다.
8. 일반 zoom, focus, keyboard, drag와 completion filter 회귀를 고정한다.
9. GN projection/materialization/focus/drop/CSS production 경로와 과거 compatibility code를 제거한다.
10. 좁은 개발 데이터 초기화 뒤 performance fixture, 전체 자동 검증과 Tauri 수동 검증을 수행한다.

각 단계는 데이터 형식과 UI를 동시에 뒤섞지 않고 독립적인 실패 테스트와 검증 가능한 commit 경계를 갖는다.

## 14. 완료 기준

1. GN root·날짜·알림·사용자 child가 하나의 일반 `NoteNode` tree다.
2. 날짜와 알림이 일반 블릿 아래 실제 들여쓰기와 1px guide로 표시된다.
3. GitHub 소유 행은 기존 `isReadonly` 동작을 사용하고 user child는 일반 Notes 동작을 사용한다.
4. 제목·note·이미지 어디에 focus가 있어도 같은 node 기준 zoom-in/out이 동작한다.
5. 일반 블릿의 공용 선행 아이콘 slot에 GitHub Type 아이콘이 표시된다.
6. 원격에서 사라진 알림은 user descendant가 있을 때만 마지막 snapshot과 함께 보존된다.
7. 알림 날짜 이동이 전체 user subtree를 손실 없이 옮긴다.
8. 완료가 즉시 표시되고 durable Outbox가 background mark-read를 전송한다.
9. network 오류는 알림 한 번 뒤 reconnect에서 자동 재시도하고, 영구 오류는 완료를 유지한 blocked 상태가 된다.
10. pending/blocked intent는 stale GitHub unread snapshot에 의해 되돌아가지 않는다.
11. unchanged polling은 DB·Markdown·workspace revision·React render를 만들지 않는다.
12. 기존 hybrid row, 별도 focus/drop 경로와 날짜 group CSS가 GN production path에서 사라진다.
13. DB·파일 format version bump나 기존 hybrid data migration 없이 깨끗한 개발 데이터에서 native tree가 생성된다.
14. 전체 자동 검증, performance 기준과 Tauri 사용자 시나리오가 통과한다.

## 15. 시각 자료 결정

별도 목업이나 interactive visual companion은 만들지 않는다. 이번 설계에서 남아 있던 시각적 선택은 사용자가 승인한 다음 한 줄 구조로 충분히 고정된다.

```text
[접기] [블릿 마크/체크박스] [선행 Type 아이콘] [제목·note] [ExternalLink·sync 상태]
```

복잡한 공간 배치보다 데이터 소유권, 일반 readonly 재사용과 Outbox 상태 전이가 핵심이므로 별도 시각 artifact는 구현 판단을 더 명확하게 만들지 않는다. 실제 구현 단계에서는 Tauri screenshot과 DOM 계층 검증으로 일반 블릿과의 시각 일치를 확인한다.
