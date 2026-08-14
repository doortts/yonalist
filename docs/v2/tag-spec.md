# `#` 태그 스펙 — Workflowy 기준

2026-08-14 · 기준 코드 `main@711996b7`

## 1. 지금 있는 것

태그는 엔티티가 아니라 제목·노트 본문 안의 `#tag` / `@person` 토큰이다. 쓰기가 일어날 때마다
SQLite가 본문에서 다시 뽑아 `notes_tags`를 채운다. 태그를 고치는 일은 곧 텍스트를 고치는
일이고 태그 전용 커맨드도 스키마도 없다.

| 조각 | 자리 |
|---|---|
| 프론트 토크나이저 | [outlinePresentation.ts:170](../../apps/desktop/src/outlinePresentation.ts#L170) `matchTag` |
| Rust 토크나이저 | [mutations.rs:285](../../crates/notes-sqlite/src/mutations.rs#L285) `derived_tags` |
| 인덱스 | [schema.rs:166](../../crates/notes-sqlite/src/schema.rs#L166) `notes_tags(node_id, token, display_tag)` |
| 검색 필터 | [queries.rs:206](../../crates/notes-sqlite/src/queries.rs#L206) `is:tagged`, [:213](../../crates/notes-sqlite/src/queries.rs#L213) `tag:` |
| 토큰 렌더 | [OutlineTextField.tsx:133](../../apps/desktop/src/OutlineTextField.tsx#L133) |
| 클릭 처리 | [App.tsx:337](../../apps/desktop/src/App.tsx#L337) `handleTagClick` |
| 일괄 추가·제거 | [OutlineTagChooser.tsx](../../apps/desktop/src/OutlineTagChooser.tsx), [outlineTagEdits.ts](../../apps/desktop/src/outlineTagEdits.ts) |

토크나이저 두 벌은 같은 규칙을 따른다. 경계 문자 뒤에서는 시작하지 않는다. 첫 글자는
문자·숫자·`_`여야 하고 몸통은 문자·숫자·`_`·`-`와 결합 문자까지 받는다. 저장 키는 NFC 후
소문자, 표시는 입력한 철자 그대로다. `#ada`와 `@ada`는 서로 다른 태그다.

## 2. Workflowy가 하는 것

1. **`#`을 치면 그 자리에서 자동완성이 뜬다.** 문서에 이미 있는 태그를 좁혀 보여주고,
   Enter나 Tab이 기존 철자를 그대로 넣는다. 철자가 갈라지지 않는 가장 큰 이유다.
2. **태그는 알약 모양으로 그려지고, 누르면 검색이 된다.** 검색창에 태그가 들어가고 아웃라인이
   제자리에서 걸러진다. 결과 목록으로 화면이 바뀌지 않는다.
3. **거른 화면은 맞은 행과 조상을 함께 보여준다.** 조상은 문맥으로 남고 맞은 행의 자식은
   펼쳐진 채 따라온다.
4. **태그를 하나 더 누르면 AND로 쌓인다.** 검색 문법은 공백이 AND, `OR`가 선택, 앞의 `-`가
   제외다.
5. **`@`도 같은 태그다.** 사람을 가리키는 관례가 있을 뿐 동작은 `#`과 같다.
6. **대소문자는 구분하지 않고, 표시는 처음 쓴 철자를 따른다.**
7. **노트 줄의 태그도 똑같이 걸린다.**

이름 일괄 변경은 Workflowy에 없다. 색 지정은 유료 기능으로 있다.

## 3. 차이

| 항목 | Workflowy | 지금 v2 |
|---|---|---|
| 입력 자동완성 | `#` 즉시 | 없음. `/`만 [SlashCommandMenu](../../apps/desktop/src/SlashCommandMenu.tsx)를 띄운다 |
| 클릭 결과 | 제자리 필터 | 사이드바 검색창에 `tag:#x`를 넣고 평평한 결과 목록을 띄운다. 결과를 누르면 페이지로 떠난다 |
| 여러 태그 | 공백 AND, `OR`, `-` 제외 | 토큰 하나뿐. `tag:` 필터는 정확히 한 개만 받는다 |
| 활성 표시 | 누른 태그가 켜져 보인다 | `aria-pressed="false"` 고정 ([OutlineTextField.tsx:139](../../apps/desktop/src/OutlineTextField.tsx#L139)) |
| 태그 목록 | 검색창이 대신한다 | Library의 `Tags`는 `is:tagged`, 곧 태그 달린 행 전부다 ([LibraryViewButtons.tsx:10](../../apps/desktop/src/LibraryViewButtons.tsx#L10)) |
| 후보 출처 | 문서 전체 | 클라이언트가 이미 들고 있는 노드뿐. 아직 안 읽은 곳의 태그는 목록에서 빠진다 |
| 개수 | — | 없음. 구 앱에는 `NoteTagSummary.count`가 있었다 ([notes.ts:282](../../src/domain/notes.ts#L282)) |

## 4. 확정 규칙

### 4.1 태그란 무엇인가 — 그대로 둔다

토크나이저 두 벌, 경계 규칙, NFC + 소문자 키, `#`과 `@`의 분리. 손대지 않는다. 인덱스가 이미
이 규칙으로 채워져 있고, 파서를 하나 더 만들면 검색이 못 찾는 태그가 생긴다.

### 4.2 `#`을 치면 자동완성이 뜬다

- **뜨는 조건**: 방금 넣은 글자가 `#`이나 `@`이고, 바로 앞 글자가 경계 문자가 아니다.
  `matchTag`가 토큰의 시작으로 인정할 자리에서만 뜬다는 뜻이다.
- **좁히기**: `#` 뒤에 이어 친 글자를 정규화해 앞자리 일치를 먼저, 부분 일치를 그다음에 놓는다.
  같은 순위에서는 쓰인 횟수가 많은 쪽이 위다.
- **넣기**: Enter와 Tab이 후보의 저장된 철자를 넣고 뒤에 공백 하나를 붙인다. 새 태그를 만드는
  중이라면 목록이 비고 그대로 계속 치면 된다.
- **닫기**: Esc, 공백, 태그로 쓸 수 없는 글자, 캐럿이 토큰 밖으로 나가는 이동.
- **한글 입력**: `event.nativeEvent.isComposing`과 `key === "Process"`를 [OutlineTagChooser.tsx:90](../../apps/desktop/src/OutlineTagChooser.tsx#L90)과 같은 자리에서 막는다.
  조합 중의 Enter는 후보를 고르지 않는다.
- **자리**: 슬래시 메뉴와 같은 앵커 규칙을 쓰고 첫 페인트 번들에서 빠지도록 첫 열림에 로드한다.

### 4.3 태그를 누르면 아웃라인이 제자리에서 걸린다

지금처럼 사이드바 검색으로 넘어가는 대신 보고 있던 아웃라인이 그대로 걸러진다.

- 맞은 행, 그 조상, 맞은 행의 자식이 남는다. 조상은 문맥이라 접기·편집 상태를 그대로 지킨다.
- 페이지는 바뀌지 않는다. 필터는 현재 페이지(또는 줌 루트) 아래에 걸린다.
- 필터가 걸린 동안 헤더에 걸린 태그 칩이 뜨고, 칩의 `×`나 Esc가 필터를 푼다.
- 필터는 pane마다 따로다. 분할 화면의 한쪽만 거를 수 있다.
- 필터를 걸고 푸는 일은 탐색이다. `appNavigation`의 위치에 담고 undo/redo가 되짚는다.

### 4.4 여러 태그는 AND로 쌓인다

- 이미 걸린 상태에서 다른 태그를 누르면 더해진다. 같은 태그를 다시 누르면 빠진다.
- 켜진 태그의 토큰은 `aria-pressed="true"`로 그린다. 지금 고정값인 자리다.
- 검색창은 `#tag` / `@person`을 그대로 받는다. `tag:` 접두사는 별칭으로 남긴다.
- 앞의 `-`가 제외다. `OR`는 4.8로 미룬다.
- 정렬과 중복 제거는 구 앱의 `canonicalizeTagFilters`가 이미 정한 규칙을 따른다
  ([notesWorkspaceScope.ts:52](../../src/features/notes/notesWorkspaceScope.ts#L52)). `#`이 `@`보다
  앞서고 같은 접두사 안에서는 정규화된 몸통 순이다.

### 4.5 후보와 개수는 워크스페이스 전체에서 온다

새 질의 하나를 낸다.

```sql
SELECT token, display_tag, COUNT(*) AS count
FROM notes_tags
JOIN notes_nodes node ON node.id = notes_tags.node_id
WHERE node.deleted = 0
GROUP BY token
ORDER BY count DESC, token
```

- **표시 철자**: 한 토큰에 철자가 여럿이면 가장 많이 쓰인 쪽을 고르고 같으면 먼저 만난 쪽을
  쓴다. 자동완성이 넣는 철자가 곧 이 값이다.
- **캐시**: 결과는 revision 단위로 캐시한다. 쓰기가 일어나 revision이 오르면 버린다.
- **스키마는 그대로다.** `notes_tags`와 `notes_tags_token` 인덱스로 답이 나오므로 마이그레이션이
  필요 없다. 릴리즈 전 스키마 v1 고정 원칙과 부딪히지 않는다.

### 4.6 Library의 `Tags`

`is:tagged`(태그 달린 행 전부) 대신 태그 목록을 놓는다. 4.5의 질의를 그대로 쓴다.

- 태그마다 철자와 개수를 한 줄로 보여준다. 개수 내림차순이 기본이고 가나다순으로 바꿀 수 있다.
- 줄을 누르면 4.3의 제자리 필터가 걸린다. 한 번 더 누르면 풀린다.
- 목록이 비면 "아직 태그가 없습니다"를 놓는다.

### 4.7 일괄 편집기는 남는다

[OutlineTagChooser](../../apps/desktop/src/OutlineTagChooser.tsx)의 Add/Remove는 여러 행에 한 번에
거는 도구라 자동완성과 겹치지 않는다. 후보 출처만 4.5의 워크스페이스 목록으로 바꾼다. 한 번에
128행이라는 상한은 undo 한 칸을 지키는 값이라 그대로 둔다
([outlineTagEdits.ts:39](../../apps/desktop/src/outlineTagEdits.ts#L39)).

### 4.8 뒤로 미루는 것

`OR`, 저장된 검색, 태그별 색.

## 5. 시각 변경은 따로 정해야 한다

Workflowy는 태그를 알약으로 그리지만 v2는 밑줄만 긋는다
([notes.css:1348](../../apps/desktop/src/notes.css#L1348)). 여기서 알약으로 바꾸는 일은
[current-app-differences.md](current-app-differences.md)가 세운 원칙 — v2는 현행 앱의
`styles.css` / `notes.css` / 클래스 이름 / 색 토큰을 그대로 복사하고 겉모습은 차이로 두지
않는다 — 과 정면으로 부딪힌다.

그래서 이 스펙은 **겉모습을 바꾸지 않는다**. 켜진 태그의 `aria-pressed="true"`가 굵기와 밑줄
두께를 이미 바꾸고 있으니 활성 표시는 그것으로 충분하다. 알약이 필요하다면 parity 원칙을 어디까지
풀지 먼저 정하고 별도 건으로 다룬다.

## 6. 하지 않는 것

- 태그를 엔티티로 승격하기. 본문이 계속 유일한 출처다.
- 이름 일괄 변경. Workflowy에도 없고 텍스트 치환으로 하면 태그 아닌 문자열까지 건드린다.
- 태그 계층(`#a/b`). 토크나이저가 `/`를 몸통으로 받지 않는다.
- 자동완성이 태그를 새로 만들어 주기. 목록에 없으면 치던 대로 친다.
- 휴지통에 있는 행의 태그를 후보에 넣기.

## 7. 단계

각 단계는 그 자체로 쓸 만한 상태에서 끝난다.

1. **워크스페이스 태그 질의** (4.5) — IPC 하나, 계약 타입 하나, revision 캐시. 화면 변화 없음.
2. **자동완성** (4.2) — 1단계의 목록을 먹는다. 여기까지만 해도 철자 갈라짐이 멈춘다.
3. **제자리 필터** (4.3) — 가장 큰 조각이다. 클릭 처리를 사이드바 검색에서 떼어낸다.
4. **AND 결합과 활성 표시** (4.4).
5. **Library `Tags` 목록** (4.6) — 1단계 질의의 두 번째 소비처.
6. **일괄 편집기 후보 교체** (4.7).

## 8. 열린 질문

- 제자리 필터의 범위는 현재 페이지인가 워크스페이스 전체인가. Workflowy는 보고 있는 자리
  아래를 거른다. 전체를 걸려면 페이지를 넘나드는 결과 화면이 따로 필요하다.
- 필터가 걸린 채로 행을 편집해 태그가 빠지면 그 행은 즉시 사라지는가, 아니면 편집이 끝날 때까지
  남는가. 사라지면 캐럿을 잃는다.
- 개수는 행 기준인가 하위 트리 기준인가. 위 질의는 행 기준이다.
