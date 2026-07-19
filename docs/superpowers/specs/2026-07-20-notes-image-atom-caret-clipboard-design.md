# Notes 이미지 atom 빈 caret·clipboard 수정 설계

## 목적

이미지 note에서 이미지는 하나의 독립된 블릿 본문 블록으로 보이게 한다. 이미지
앞뒤의 빈 텍스트 영역이 실제 한 줄 높이를 차지하는 문제는 없앤다. 빈 영역은
논리적 caret 위치로는 남지만 문서 흐름의 높이는 늘리지 않는다.

이미지 앞 caret에서 글자를 입력하기 시작하면 텍스트 줄이 이미지 위에 생기고
이미지는 다음 줄로 내려간다. 이미지 뒤 caret에서 입력하면 텍스트 줄이 이미지
아래에 생긴다. 즉 줄은 caret 때문에 미리 예약되지 않고 실제 글자가 생긴 시점에만
레이아웃에 추가된다.

또한 이미지가 포함된 논리 선택을 `Shift+방향키`로 만든 뒤 복사하거나 잘라내고,
같은 행·다른 행·일반 텍스트 제목·확대된 페이지 제목의 현재 caret에 다시 붙여넣을
수 있게 한다. 선택에 이미지와 주변 글자가 함께 포함되면 선택한 순서를 그대로
보존한다.

## 현재 문제와 원인

### 빈 줄

`ImageAtomEditor`는 `before`, `atom`, `after`를 하나의 grid 안에 세 영역으로
렌더링한다. 빈 `before`와 `after`에도 브라우저 caret을 둘 수 있도록 zero-width
caret aid가 존재한다. 현재 CSS는 이 두 빈 grid item에도 제목과 같은 line-height와
padding을 적용하므로 이미지 위아래에 빈 줄이 생긴다.

### 잘라내기·붙여넣기

논리 선택 모델, DOM selection mapper, 이미지 bytes가 포함된 clipboard 직렬화,
붙여넣기 parser, 안전한 cut settlement와 backend image-atom paste 명령은 이미 있다.
그러나 `ImageAtomEditor`는 paste만 연결하고 copy/cut 이벤트를 연결하지 않는다.
일반 텍스트 제목의 paste 경로도 내부 image-atom payload를 구분하지 않고 일반 이미지
import로 먼저 보낸다. 따라서 선택된 atom을 native cut으로 안정적으로 옮길 수 없다.

## 범위

### 포함

- 빈 `before`/`after` 영역의 zero-layout caret anchor
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

## 선택한 접근

기존 semantic image-atom 경계를 완성한다. 브라우저가 non-editable 이미지 subtree를
직렬화하도록 맡기지 않고, 논리 선택과 기존 clipboard primitive를 source of truth로
사용한다.

이미지만 선택했을 때만 특례를 두는 방식은 주변 글자까지 선택한 요구를 만족하지
못한다. native DOM cut/paste는 `contentEditable=false` atom과 React의 controlled
projection 사이에서 구조와 bytes를 보존하지 못하므로 사용하지 않는다.

## 레이아웃 설계

`ImageAtomEditor`는 `before → atom → after`의 세 논리 행을 유지한다. `atom`은 항상
독립된 블록 행이다. 각 텍스트 region에는 명시적인 empty marker를 출력한다. 빈
region은 DOM과 selection mapper에는 남기되 block size가 0인 caret anchor로
렌더링한다. caret과 zero-width aid는 이미지의 인접 경계에서 보이지만 grid track
높이는 만들지 않는다.

- 빈 `before`: 이미지의 위쪽 경계에 caret을 두되 빈 줄은 만들지 않는다.
- 빈 `after`: 이미지의 아래쪽 경계에 caret을 두되 빈 줄은 만들지 않는다.
- `before`에 글자 하나가 입력되면 해당 region이 정상 텍스트 줄로 확장되고 atom
  행은 그 다음 줄로 내려간다.
- `after`에 글자 하나가 입력되면 atom 행은 그대로 유지되고 해당 region이 이미지
  다음 줄의 정상 텍스트 줄로 확장된다.
- 글자를 다시 모두 지우면 region은 zero-layout anchor로 되돌아간다.
- page header와 outline row는 같은 editor/CSS 계약을 사용한다.

레이아웃 상태는 다음과 같다.

```text
앞뒤 글자 없음       이미지 앞에 입력       이미지 뒤에 입력

[이미지]             [앞 글자]              [이미지]
                     [이미지]               [뒤 글자]
```

빈 영역을 DOM에서 제거하거나 `display:none`으로 숨기지 않는다. 그렇게 하면 현재의
논리 offset `imageOffsetUtf16`과 방향키 selection 경계를 잃는다.

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

- 빈 두 region은 caret aid와 selection mapping을 유지하면서 zero-layout marker를 가짐
- 입력 후 marker 해제, 전부 삭제 후 marker 복귀
- `Shift+Left/Right/Up/Down`으로 atom 포함 selection 생성
- atom 미포함 text selection은 native copy/cut에 위임
- copy/cut이 기존 clipboard serializer를 사용
- clipboard 실패·stale selection에서 `onAtomDelete` 미호출

### row/header 통합

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

## 완료 기준

1. 텍스트가 없는 이미지 위아래에 고정 빈 줄이 보이지 않고 이미지만 독립 블록으로
   보인다.
2. 이미지 앞뒤 caret 위치와 방향키 selection은 그대로 동작한다.
3. 앞 caret에 입력하면 글자 줄 아래로 이미지가 이동한다.
4. 뒤 caret에 입력하면 이미지 다음 줄에 글자가 표시된다.
5. 이미지와 함께 선택한 글자를 잘라내면 선택 전체가 사라진다.
6. 현재 caret이 있는 다른 지원 위치에 붙여넣으면 글자와 이미지 순서가 복원된다.
7. clipboard 실패나 stale 상태에서는 원본이 삭제되지 않는다.
8. 외부 이미지 paste, 이미지 메뉴·resize·lightbox, Undo/Redo에 회귀가 없다.
