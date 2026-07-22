# Notes의 Github Notifications 표시 개선 설계

**상태:** 사용자 승인됨, 구현 계획 작성 전

**날짜:** 2026-07-23

**기준 설계:** `2026-07-22-notes-external-notifications-plugin-design.md`

## 1. 목적과 변경 범위

이 문서는 기존 외부 알림 블릿 설계의 데이터 소유권, 완료 처리, 캐시, 오류 격리 원칙을 유지하면서 Notes에서 GitHub 알림을 표시하는 방법만 변경한다.

다음 기존 결정을 대체한다.

- 가상 루트 이름 `Notifications`를 `Github Notifications`로 변경한다.
- 알림을 가상 루트의 직접 자식으로 나열하지 않고 날짜 블릿 아래에 묶는다.
- 알림 노트를 펼침으로 표시하지 않고 제목 아래의 읽기 전용 보조 줄로 항상 표시한다.
- `상세보기`로 내부 Notifications 화면에 이동하지 않고 웹 아이콘으로 대상 GitHub 페이지를 연다.
- 알림 시작 위치의 일반 점 대신 알림 Type 아이콘을 표시한다.

Notes 데이터베이스에 외부 항목을 저장하지 않고 GitHub `unread`만 완료 상태의 원본으로 사용하는 기존 원칙은 변경하지 않는다.

## 2. 사용자에게 보이는 결과

### All 목록의 가상 루트

Notes의 `All` 목록에서 `Github Notifications` 가상 루트를 로컬 최상위 노트보다 앞에 표시한다. GitHub가 연결되지 않았거나 알림이 비어 있어도 가상 루트는 표시하고, 루트를 연 화면에서 현재 연결·빈 상태를 안내한다.

`Starred`, `Recent`, `Tags`, `Archive`, `Trash`에는 가상 루트를 표시하지 않는다. 가상 루트에는 이름 변경, 별표, 보관, 휴지통, 복제, 내보내기 같은 로컬 Notes 동작을 제공하지 않는다.

### 날짜 상위 블릿

표시 대상 알림을 기존 Notifications 화면과 같은 로컬 날짜 규칙으로 묶는다.

- 오늘: `Today`
- 어제: `Yesterday`
- 같은 해의 이전 날짜: `MM.DD`
- 이전 연도: `YYYY.MM.DD`

날짜는 최신순이며 각 날짜 안의 알림도 `updated_at` 최신순이다. 날짜 블릿은 그룹 제목이고 그 아래 알림은 실제 자식 블릿으로 투영한다. 날짜 그룹은 항상 펼쳐지며 접기 버튼을 두지 않는다.

### 알림 블릿

각 알림은 다음 두 줄로 표시한다.

1. Type 아이콘, 제목, 번호, 웹 아이콘, 완료 버튼
2. `저장소 이름, 상대 활동 시각, seen 상대 시각` 형식의 읽기 전용 노트

예시는 다음과 같다.

```text
[PR 아이콘] [#45] 메뉴얼 검색 및 RAG 응답 구현 #121       [웹] [완료]
            arc-agent, 9h ago, seen 6h ago
```

두 번째 줄은 기존 Notifications 행과 같은 규칙을 사용한다.

- 저장소는 `repository.name`을 사용한다.
- `updated_at`을 기존 `timeAgo` 형식으로 표시한다.
- `seen`은 기존 Notifications 화면처럼 로컬 `viewedAt`을 우선하고, 없으면 `last_read_at`을 사용한다.
- 확인 시각이 없으면 `seen` 조각을 생략한다.

알림 노트는 하위 블릿이 아니므로 별도의 펼침 화살표를 표시하지 않는다. 제목과 노트는 읽기 전용이며 Notes 편집 명령으로 전달하지 않는다.

### Type 아이콘

제공자 투영은 Notes가 GitHub 원본 객체를 해석하지 않아도 되도록 최소한의 아이콘 종류를 함께 전달한다.

| GitHub `subject.type` | 표시 아이콘 |
| --- | --- |
| `Issue` | Issue 원형 아이콘 |
| `PullRequest` | Pull Request 아이콘 |
| `Discussion` | Discussion 아이콘 |
| `Release` | Release 태그 아이콘 |
| 그 외 | 기본 알림 아이콘 |

기존에 설치된 Lucide 아이콘만 사용하며 새 의존성은 추가하지 않는다. 아이콘에는 접근 가능한 Type 이름을 제공한다.

## 3. 투영 데이터와 계층

기존 `ExternalBullet` 계약과 `parentKey`를 그대로 사용한다. Type 표시를 위해 선택적이고 중립적인 `icon` 값만 추가한다.

```ts
type ExternalBulletIcon =
  | "issue"
  | "pull-request"
  | "discussion"
  | "release"
  | "notification";

type ExternalBullet = {
  // 기존 필드
  icon?: ExternalBulletIcon;
};
```

GitHub 제공자는 기간 필터를 적용한 뒤 기존 `groupNotificationsByDate` 결과를 다음 순서로 평탄화한다.

```text
Today 날짜 블릿 (parentKey: null)
  첫 번째 알림 (parentKey: Today 키)
  두 번째 알림 (parentKey: Today 키)
Yesterday 날짜 블릿 (parentKey: null)
  세 번째 알림 (parentKey: Yesterday 키)
```

날짜 키는 같은 계정과 제공자 안에서 충돌하지 않는 `date:<local-date-key>` remote ID를 사용한다. 날짜 블릿은 원격 알림을 가장하지 않으며 모든 쓰기 capability가 `false`다. 자식 알림만 GitHub thread ID를 remote ID로 사용한다.

알림 자식의 `expand` capability는 `false`다. `note`에는 기존 Notifications 부제 규칙으로 만든 한 줄만 담는다. 날짜 블릿의 `note`는 비어 있다.

## 4. 렌더링

Notes 외부 outline은 `parentKey`로 최상위 날짜 블릿과 직접 자식을 연결한다. 요구 범위는 날짜와 알림의 2단계이므로 범용 재귀 트리나 새 트리 라이브러리를 만들지 않는다.

- 날짜 블릿은 일반 점과 날짜 이름만 표시한다.
- 날짜 블릿의 자식 목록은 항상 DOM에 렌더링한다.
- 알림 자식은 한 단계 들여쓰기한다.
- 알림의 `icon`이 있으면 일반 점 대신 해당 아이콘을 표시한다.
- 알림 `note`는 제목 아래에 항상 표시한다.
- 선택, 완료 처리 중 상태, 실패 후 재시도 표시는 기존 행 상태를 유지한다.

제공자 입력 순서를 그대로 렌더링하고 React key는 기존 직렬화된 외부 키를 유지하여 폴링 후에도 행 상태와 완료 요청 방어가 흔들리지 않게 한다.

## 5. 웹 열기

기존 `openDetails` 경계를 새 범용 명령으로 확장하지 않는다. 첫 번째 제공자에 이미 있는 이 동작의 GitHub 처리기만 변경한다.

1. 웹 아이콘을 누르면 알림 키를 외부 소스 경계로 전달한다.
2. GitHub 제공자는 같은 계정의 알림인지 확인한다.
3. 기존 `notificationWebUrl`로 Issue, Pull Request, Discussion, Release 대상 URL을 만든다.
4. 기존 `openExternal` 경로로 시스템 기본 브라우저에서 연다.
5. 기존 Notifications 화면과 동일하게 해당 URL의 로컬 `viewedAt`을 기록한다.

버튼에는 화면 텍스트를 두지 않고 `웹에서 열기: <알림 제목>` 접근성 이름과 툴팁을 제공한다. 웹 열기는 GitHub 읽음 PATCH나 Notes 완료를 발생시키지 않는다.

이 변경으로 내부 Notifications 화면으로 갔다가 Notes 선택·스크롤을 복원하던 전용 왕복 경로는 더 이상 사용하지 않으므로 제거한다.

## 6. 이름의 단일 기준

가상 루트, outline 제목, 접근성 이름, 내부 제공자 레지스트리에서 모두 정확히 `Github Notifications`를 사용한다. 이름이 다시 어긋나지 않도록 제공자 제목 상수를 한 곳에서 재사용한다.

앱의 좌측 전역 기능인 기존 `Notifications` pane 이름은 변경하지 않는다. 이름 변경은 Notes의 가상 외부 루트에만 적용한다.

## 7. 유지되는 동작

- GitHub 연결, 계정 격리, 기간 필터, 폴링 및 오프라인 캐시
- 읽지 않은 알림은 기간과 관계없이 유지하는 규칙
- 명시적 완료에서만 `PATCH /notifications/threads/{threadId}`를 한 번 보내는 규칙
- 성공 전에는 완료 모양을 표시하지 않는 규칙
- 완료 실패 시 미완료 유지와 다시 시도
- 외부 항목을 Notes 검색, 태그, Undo/Redo, 휴지통, 저장 및 내보내기에서 제외하는 경계
- 기존 좌측 전역 Notifications pane의 검색, Only new, 날짜 그룹 및 상세 화면

## 8. 오류와 경계 조건

- 알 수 없는 날짜는 기존 날짜 도우미의 `unknown` 그룹에 둔다.
- 알 수 없는 Type은 기본 알림 아이콘으로 표시한다.
- 대상 URL에 번호가 없으면 기존 `notificationWebUrl`의 저장소별 목록 URL을 사용한다.
- URL 열기 실패는 거짓 완료 상태를 만들지 않는다.
- 날짜 블릿에는 완료, 웹 열기, 선택에 따른 원격 동작을 노출하지 않는다.
- 새로고침 실패 시 기존 캐시와 날짜 계층을 유지한다.

## 9. 테스트

구현은 기존 테스트를 수정하는 테스트 우선 방식으로 진행한다.

### 제공자 투영

- 기간 필터 뒤 날짜 블릿과 자식 알림이 최신순으로 생성된다.
- 날짜 블릿은 안정된 합성 키, 빈 note, 쓰기 capability 없음 상태다.
- 자식 `parentKey`, Type 아이콘, 제목과 번호가 정확하다.
- 자식 note가 기존 Notifications 부제와 같은 저장소·상대시간·seen 형식이다.
- 자식에는 펼침 capability가 없다.

### Notes UI

- All에서 `Github Notifications`가 로컬 루트보다 앞에 나타난다.
- 다른 Notes 필터에는 가상 루트가 나타나지 않는다.
- 날짜 블릿과 자식 목록이 항상 펼쳐져 있다.
- 알림 행에는 펼침 버튼이 없고 note는 즉시 보인다.
- Type 아이콘의 접근성 이름과 한 단계 들여쓰기가 적용된다.
- 웹 아이콘은 외부 열기 경계를 한 번 호출하며 완료 요청을 보내지 않는다.
- 완료 중복 방어, 실패와 재시도 테스트는 유지한다.

### 앱 연결과 회귀

- 웹 아이콘은 내부 Notifications pane으로 전환하지 않고 계산된 외부 URL을 연다.
- 웹 열기는 로컬 `viewedAt`만 갱신하고 GitHub PATCH를 보내지 않는다.
- 기존 Notifications pane의 행과 부제, 검색, 날짜 그룹 동작은 그대로다.
- 외부 블릿 동작이 Notes 저장·검색·내보내기 명령을 호출하지 않는다.

## 10. 완료 기준

1. Notes `All`에 `Github Notifications`가 표시된다.
2. 알림이 기존 Notifications pane과 같은 날짜 이름 아래 항상 펼쳐져 있다.
3. 각 알림은 Type 아이콘과 기존 Notifications 부제 형식의 한 줄 note를 표시한다.
4. 알림에는 잘못된 펼침 화살표가 없다.
5. 웹 아이콘으로 정확한 GitHub 대상 페이지가 시스템 브라우저에서 열린다.
6. 완료, 캐시, 계정 격리, 오류 처리 및 일반 Notes 데이터 경계가 회귀하지 않는다.
7. 집중 테스트, 전체 프런트엔드 테스트, lint와 production build가 통과한다.
8. 개발 빌드에서 All 목록, 날짜 그룹, 아이콘, note, 웹 열기와 완료를 직접 확인할 수 있다.
