# Notes 이미지 atom 문자형 caret·삭제·clipboard 수정 설계

## 목적

이미지 note에서 이미지를 논리적 길이 1인 글자처럼 다룬다. 텍스트가 없을 때는
블릿의 첫 줄에 이미지가 놓이고 caret은 이미지의 왼쪽 또는 오른쪽 경계에 위치한다.
이미지 앞뒤의 빈 텍스트 영역 때문에 이미지 위아래에 줄을 미리 만들지 않는다.

이미지 앞 caret에서 글자를 입력하기 시작하면 첫 줄에 텍스트가 생기고 이미지는
같은 블릿의 다음 줄로 내려간다. 앞 텍스트를 전부 지우면 이미지는 다시 블릿의 첫
줄로 올라온다. 이미지 뒤 caret에서 입력하면 이미지는 첫 줄에 남고 텍스트는 같은
블릿의 다음 줄에 생긴다. 새 블릿은 만들지 않는다. 줄은 실제 텍스트가 존재할 때만
레이아웃에 추가한다.

이미지 메뉴에서 `Remove image`를 선택하면 이미지 파일만 사라진 복구 화면을
노출하지 않는다. 명령이 성공하면 앞뒤 텍스트를 합친 텍스트 블릿으로 전환하고,
텍스트가 없으면 설명과 하위 항목을 보존한 빈 텍스트 블릿을 남긴다.

또한 이미지가 포함된 논리 선택을 `Shift+방향키`로 만든 뒤 복사하거나 잘라내고,
같은 행·다른 행·일반 텍스트 제목·확대된 페이지 제목의 현재 caret에 다시 붙여넣을
수 있게 한다. 선택에 이미지와 주변 글자가 함께 포함되면 선택한 순서를 그대로
보존한다.

## 현재 문제와 원인

### caret과 빈 줄

`ImageAtomEditor`는 `before`, `atom`, `after`를 하나의 grid 안에 항상 세 행으로
렌더링한다. 빈 `before`와 `after`에도 브라우저 caret을 둘 수 있도록 zero-width
caret aid가 존재하지만, 두 grid item에 제목과 같은 line-height와 padding이 적용돼
이미지 위아래에 빈 줄이 생긴다.

빈 행의 높이만 0으로 만드는 방식은 브라우저가 caret을 이미지 위·아래 경계에
그리게 하고 `contentEditable`의 selection geometry를 불안정하게 만든다. 사용자가
원하는 위치는 이미지 위·아래가 아니라 글자와 같은 이미지의 왼쪽·오른쪽 경계다.

### 이미지 메뉴 삭제 후 stale 화면

재현된 삭제에서는 저장소의 원자적 명령이 이미지 노드를 `text`로 바꾸고 첨부를
제거했다. 실제 SQLite 상태도 `node_kind=text`, 첨부 0개였다. 그러나 실행 중인
프런트엔드는 이전 `image` 표현을 유지해 `Image unavailable`을 렌더링했다. 백엔드
삭제가 아니라 명령 결과가 React의 권위 상태와 draft 표현에 함께 반영되는 경계가
문제다.

현재 통합 테스트는 메뉴가 `applyImageAtomEdit`를 한 번 호출하는지만 확인하고,
권위 결과가 도착한 뒤 이미지 editor가 텍스트 editor로 교체되는지는 확인하지 않는다.

### 잘라내기·붙여넣기

논리 선택 모델, DOM selection mapper, 이미지 bytes가 포함된 clipboard 직렬화,
붙여넣기 parser, 안전한 cut settlement와 backend image-atom paste 명령은 이미 있다.
그러나 `ImageAtomEditor`는 paste만 연결하고 copy/cut 이벤트를 연결하지 않는다.
일반 텍스트 제목의 paste 경로도 내부 image-atom payload를 구분하지 않고 일반 이미지
import로 먼저 보낸다. 따라서 선택된 atom을 native cut으로 안정적으로 옮길 수 없다.

## 범위

### 포함

- 이미지 왼쪽·오른쪽 경계의 문자형 caret anchor
- 텍스트 존재 여부에 따른 같은 블릿 내부의 조건부 라인 배치
- `Remove image` 완료 후 이미지 노드에서 텍스트 노드로의 권위 상태 전환
- 이미지가 없는 경우 빈 텍스트 블릿과 설명·하위 항목 보존
- 이미지가 포함된 정방향·역방향 논리 선택의 copy/cut
- 선택된 앞 글자, 이미지, 뒤 글자의 순서 보존
- 같은 이미지 editor 및 다른 이미지 editor에 paste
- 일반 텍스트 행 제목과 확대된 페이지 제목의 textarea selection에 paste
- clipboard 기록 실패, stale selection, bytes 부재 시 원본 보존
- 한 번의 cut 또는 paste를 한 번의 Notes history 작업으로 유지
- macOS `Cmd+C/X/V`와 다른 플랫폼 `Ctrl+C/X/V`

### 제외

- supporting note 안에 이미지 atom을 삽입하는 기능
- 새로운 clipboard 포맷 또는 backend schema
- 이미지 저장 형식, Tauri IPC envelope, attachment 제한 변경
- 여러 이미지 atom을 한 editor 안에 두는 데이터 모델 변경
- 이미지 제거 성공 경로의 추가 전체 workspace 재조회
- 이미지 앞뒤 텍스트를 별도 note node로 분할하는 구조

## 선택한 접근

기존 semantic image-atom 경계를 완성한다. 이미지의 논리 offset은 그대로 유지하고
레이아웃만 `beforeText`와 `afterText`의 존재 여부로 결정한다. 빈 텍스트 영역을
zero-height 블록으로 만들거나 앞뒤를 별도 입력창으로 분리하지 않는다. 브라우저가
non-editable 이미지 subtree를 직렬화하도록 맡기지 않고, 논리 선택과 기존 clipboard
primitive를 source of truth로 사용한다.

검토한 대안은 다음과 같다.

- 빈 앞뒤 행의 높이만 0으로 만드는 방식은 수정량이 작지만 caret이 이미지의
  위·아래에 놓이고 WebKit selection geometry가 불안정해 제외한다.
- 앞뒤 텍스트를 별도 textarea로 분리하는 방식은 화면 배치는 단순하지만 이미지가
  글자 하나처럼 포함되는 연속 방향키 선택과 clipboard 순서를 깨므로 제외한다.
- 선택한 방식은 하나의 논리 editor와 하나의 이미지 atom을 유지하고, 비어 있지 않은
  segment만 실제 줄로 배치한다.

이미지만 선택했을 때만 특례를 두는 방식은 주변 글자까지 선택한 요구를 만족하지
못한다. native DOM cut/paste는 `contentEditable=false` atom과 React의 controlled
projection 사이에서 구조와 bytes를 보존하지 못하므로 사용하지 않는다.

## 레이아웃 설계

`ImageAtomEditor`는 DOM과 selection mapper에서 `before → atom → after` 순서를
유지한다. `atom`은 논리적 길이 1이고 경계 offset은 각각
`imageOffsetUtf16`, `imageOffsetUtf16 + 1`이다. 빈 `before`와 `after`는 selection
anchor로 남지만 독립된 block/grid 행을 만들지 않는다. 빈 상태의 caret은 이미지의
왼쪽 또는 오른쪽에 그려진다.

화면의 줄은 저장된 개행이 아니라 segment의 비어 있음으로 계산한다.

| 상태 | 같은 블릿 안의 표시 |
| --- | --- |
| 앞뒤 모두 비어 있음 | 첫 줄: `[앞 caret][이미지][뒤 caret]` |
| 앞 텍스트만 있음 | 첫 줄: 앞 텍스트, 둘째 줄: `[이미지][뒤 caret]` |
| 뒤 텍스트만 있음 | 첫 줄: `[앞 caret][이미지]`, 둘째 줄: 뒤 텍스트 |
| 앞뒤 텍스트 모두 있음 | 첫 줄: 앞 텍스트, 둘째 줄: 이미지, 셋째 줄: 뒤 텍스트 |

- 앞 caret에서 첫 글자를 입력하면 `before`가 실제 줄이 되고 이미지가 다음 줄로
  내려간다.
- `before`의 마지막 글자를 지우면 해당 줄이 사라지고 이미지가 블릿의 첫 줄로
  올라온다.
- 뒤 caret에서 첫 글자를 입력하면 `after`가 이미지 다음 줄에 생긴다. node split이나
  새 블릿 생성은 일어나지 않는다.
- `after`의 마지막 글자를 지우면 해당 줄만 사라진다.
- 앞뒤가 모두 비어 있어도 두 논리 caret 경계와 방향키 selection은 유지한다.
- page header와 outline row는 같은 editor와 레이아웃 상태 계약을 사용한다.

빈 영역을 DOM에서 제거하거나 `display:none`으로 숨기지 않는다. 반대로 높이 0인
독립 행으로도 만들지 않는다. 두 방식 모두 현재의 논리 offset과 브라우저 caret
geometry 중 하나를 잃는다.

## 이미지 메뉴 삭제 흐름

1. 메뉴 확인 시 현재 editor draft를 먼저 flush한다.
2. flush된 `imageOffsetUtf16`의 atom 범위만 선택해 기존
   `applyImageAtomEdit(..., { kind: "remove", replacementText: "" })`를 한 번 호출한다.
3. 명령 처리 중에는 마지막으로 일관된 이미지 표현을 유지한다. 첨부만 먼저 제거한
   것처럼 보이는 낙관적 UI는 만들지 않는다.
4. 권위 결과의 `nodeKind`, `title`, `imageOffsetUtf16`, attachment 집합을 한 세대로
   반영하고 해당 node의 오래된 image draft를 폐기한다. 이 조기 화면 반영은
   image-atom 명령만 명시적으로 요청하며, 일반 restore·replay·복합 mutation의 기존
   queue settlement 순서는 바꾸지 않는다.
5. 결과가 `text`이면 같은 React 갱신에서 `ImageAtomEditor`를 제거하고 일반
   `NoteTextField`를 렌더링한다.
6. 앞뒤 텍스트는 문서 순서대로 합친다. 둘 다 비어 있으면 title이 빈 텍스트 블릿을
   남긴다. supporting note, children, 완료·접기 등 node metadata는 유지한다.

정상 성공 경로에서 전체 workspace를 다시 조회하지 않는다. 이미 backend 응답에 든
권위 workspace/delta를 reducer가 직접 적용한다. 원래부터 image node와 attachment가
불일치한 복구 데이터에만 기존 `Image unavailable` 표현을 유지한다.

## clipboard 선택 모델

선택 범위를 정규화해 `[start, end)`로 해석한다.

- 범위가 atom을 포함하지 않으면 브라우저의 기존 text copy/cut을 그대로 둔다.
- 범위가 atom을 포함하면 앱이 이벤트를 소유한다.
- `beforeText`는 선택 시작부터 atom 앞까지의 선택된 글자만 포함한다.
- `afterText`는 atom 뒤부터 선택 끝까지의 선택된 글자만 포함한다.
- 역방향 selection도 clipboard 내용은 문서 순서인
  `beforeText → image → afterText`로 기록한다.
- selection 방향은 cut history의 focus snapshot에는 유지한다.

clipboard에는 기존 포맷을 그대로 사용한다.

1. `text/plain`: 외부 앱용 이미지 이름 포함 표현
2. `text/html`: 크기 제한 안에서 data URL을 포함한 순서 보존 표현
3. private MIME: Yonalist 내부 exact metadata
4. 지원되는 경우 native image MIME

## bytes 준비와 copy 흐름

이미지 selection이 생기면 기존 `NotesImageByteLease`에 attachment ID를 등록하고
`actions.loadAttachmentBytes`를 통해 prewarm한다. 화면에 표시된 이미지는 같은 residency
coordinator의 bytes를 재사용하므로 중복 읽기를 만들지 않는다.

copy 이벤트에서 atom selection, attachment identity, selection authority와 현재 draft를
동결한다. bytes가 준비되어 있으면 `writeNotesImageAtomClipboard`를 이벤트 처리 중 바로
시작한다. 이미지 bytes를 안전하게 실을 수 없으면 이벤트를 native DOM 직렬화로
넘기지 않고 실패로 종료하며 원본을 변경하지 않는다.

## cut 흐름

cut은 copy와 같은 clipboard 기록을 먼저 시작한다. 이후
`settleNotesImageAtomCut`이 다음 조건을 모두 확인한 경우에만 기존
`applyImageAtomEdit(..., { kind: "remove" })`를 호출한다.

1. clipboard 기록 성공
2. 실제 이미지 bytes 포함
3. editor와 attachment identity 유지
4. 동결한 selection authority 유지
5. 현재 node/draft가 structural command의 precondition과 일치

실패하거나 stale이면 clipboard에 복사본이 남을 수는 있지만 원본은 삭제하지 않는다.
삭제 성공 시 선택된 글자와 atom을 한 history command로 제거한다.

## paste 흐름과 우선순위

### 이미지 editor

현재 registry authority, selection snapshot, draft flush를 유지한 기존 paste 경로를
사용한다. 내부 payload의 `beforeText → image → afterText` fragment를 현재 논리
selection에 삽입한다.

### 일반 텍스트 제목

outline row와 page header의 title paste에서 private marker 또는 marked HTML을 일반
clipboard 이미지 import보다 먼저 검사한다. 내부 image-atom payload이면 textarea의
`selectionStart/selectionEnd`를 UTF-16 selection으로 동결하고 기존
`actions.applyImageAtomPaste`를 호출한다. backend 명령은 이미 text node를 image node로
변환할 수 있으므로 새 IPC나 schema는 추가하지 않는다.

supporting note는 이미지 atom을 지원하지 않으므로 기존 일반 이미지 import 동작을
유지한다.

우선순위는 다음과 같다.

1. active image editor의 atom paste
2. title textarea의 내부 image-atom paste
3. 기존 외부 clipboard 이미지 import
4. 기존 outline text/subtree paste
5. 브라우저 기본 text paste

## 오류와 동시성

- 이미지 메뉴 삭제 명령 처리 중: 마지막 일관된 이미지 표현 유지, 중복 삭제 차단
- 삭제 명령 실패: 이미지와 attachment 표현 유지, 오류 상태 표시
- 삭제가 backend에 적용된 뒤 응답 정리가 실패: 응답에 포함된 권위 workspace를
  적용해 텍스트 블릿으로 전환하고 오류를 함께 표시
- 원래부터 image node의 attachment가 없거나 잘못된 경우: 복구를 위해 기존
  `Image unavailable` 표시 유지
- clipboard API 거부 또는 bytes 부재: 원본 유지, cut command 미실행
- selection 또는 editor authority 변경: cut/paste 취소
- node draft flush 실패: backend 명령 미실행
- private metadata·hash·MIME·크기 불일치: 외부 이미지로 재해석하지 않고 전체 거부
- paste command 실패: 현재 focus/selection과 원본 유지
- read-only·disabled editor: 앱이 copy 내용을 제공할 수는 있지만 cut/paste mutation은
  실행하지 않는다.

## 테스트 전략

### 순수 모델

- exact atom, 앞 글자+atom, atom+뒤 글자, 전체 mixed selection
- 정방향·역방향 selection의 동일한 clipboard 문서 순서
- surrogate pair 경계를 나누지 않음

### editor DOM

- 이미지-only 상태에서 앞뒤 caret은 이미지의 왼쪽·오른쪽 경계에 있고 예약된
  위아래 행은 없음
- 앞 첫 글자 입력 시 이미지가 둘째 줄로 내려가고, 마지막 글자 삭제 시 첫 줄로 복귀
- 뒤 첫 글자 입력 시 같은 블릿의 둘째 줄이 생기고 새 note node는 생성되지 않음
- 앞뒤 텍스트가 모두 있으면 `앞 텍스트 → 이미지 → 뒤 텍스트`의 세 줄 순서
- `Shift+Left/Right/Up/Down`으로 atom 포함 selection 생성
- atom 미포함 text selection은 native copy/cut에 위임
- copy/cut이 기존 clipboard serializer를 사용
- clipboard 실패·stale selection에서 `onAtomDelete` 미호출

### row/header 통합

- 이미지 메뉴 삭제 성공 시 `Image unavailable`을 거치지 않고 일반 텍스트 editor로
  전환
- 이미지-only 삭제는 빈 텍스트 블릿, supporting note와 children을 보존
- 앞뒤 텍스트가 있는 이미지 삭제는 두 segment를 문서 순서대로 합침
- 삭제 실패 시 기존 이미지 표현 유지
- exact image와 mixed selection의 cut
- 같은 editor의 다른 caret에 paste
- 다른 image row/header에 paste
- 일반 text row와 page title caret에 paste하며 선택 text 교체
- 외부 이미지 paste와 multi-line outline paste 회귀 없음
- cut/paste 각각 한 번의 Undo/Redo로 원상 복구
- row와 page header의 동일 동작

### 검증

- 관련 image editor, row, page header, ingest, command 테스트
- 전체 `npm test`
- `npm run lint`
- `npm run build`
- `git diff --check`
- Rust/IPC/schema를 변경하지 않으면 Cargo gate는 실행하지 않고 그 이유를 기록

### native smoke

- Tauri/WebKit에서 이미지-only caret을 왼쪽·오른쪽으로 각각 배치
- 앞 입력, 앞 전체 삭제, 뒤 입력의 실제 줄 위치를 화면 좌표로 확인
- 메뉴 삭제 직전부터 텍스트 editor 전환까지 `Image unavailable`이 한 프레임도
  노출되지 않는지 확인
- 삭제 후 앱을 새로고침하지 않아도 빈 텍스트 블릿이 즉시 편집 가능한지 확인

## 성능 예산과 측정

정상 경로의 구조를 먼저 수치로 제한하고 구현 전후를 같은 명령과 같은 표본으로
비교한다.

| 항목 | 목표 |
| --- | --- |
| 이미지 메뉴 삭제 backend mutation | 정확히 1회 |
| 정상 삭제의 추가 `loadWorkspace` | 0회 |
| 별도 attachment 삭제 명령 | 0회 |
| 일반 키 입력당 새 비동기 작업 | 0회 |
| 일반 키 입력당 새 JS layout 측정 | 0회 |
| 새 runtime 의존성 | 0개 |
| 프로덕션 gzip route bundle 증가 | 2 KiB 이하 |
| 정상 삭제 중 `Image unavailable` 노출 | 0 frame |

번들은 변경 전후 `npm run build:analyze`의 Notes route gzip 값을 비교한다. 삭제 호출
수와 workspace 재조회 수는 통합 테스트에서 실제 mock 호출을 계수한다. native
표시는 Tauri smoke에서 삭제 전부터 text editor가 나타날 때까지 프레임 단위 화면을
관찰한다. 수치가 예산을 넘으면 기능 완료로 판정하지 않는다.

## 완료 기준

1. 텍스트가 없는 이미지는 블릿의 첫 줄에 있고 caret은 이미지 왼쪽·오른쪽에 있다.
2. 앞 caret에 입력하면 이미지가 같은 블릿의 다음 줄로 내려가고, 앞 글자를 전부
   지우면 첫 줄로 돌아온다.
3. 뒤 caret에 입력하면 새 블릿이 아니라 같은 블릿의 이미지 다음 줄에 표시된다.
4. 메뉴 삭제 성공 시 `Image unavailable`을 노출하지 않고 앞뒤 글자를 합친 텍스트
   블릿으로 전환한다.
5. 이미지-only 삭제는 빈 텍스트 블릿과 supporting note·children을 보존한다.
6. 이미지 앞뒤 caret 위치와 방향키 selection은 그대로 동작한다.
7. 이미지와 함께 선택한 글자를 잘라내면 선택 전체가 사라진다.
8. 현재 caret이 있는 다른 지원 위치에 붙여넣으면 글자와 이미지 순서가 복원된다.
9. clipboard 실패나 stale 상태에서는 원본이 삭제되지 않는다.
10. 외부 이미지 paste, 이미지 메뉴·resize·lightbox, Undo/Redo에 회귀가 없다.
11. 모든 성능 예산을 충족한다.
