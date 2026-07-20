# Notes 이미지 atom 잘라내기·첫 한글 입력·붉은 Native caret 설계

## 계약

### 목표

이미지가 들어 있는 블릿을 일반 텍스트 블릿처럼 안정적으로 편집한다. 선택한 텍스트와
이미지는 `Cmd/Ctrl+X`로 클립보드에 기록된 뒤 정확히 제거되고, 처음 포커스를 둔 직후의
한글도 자소 분리나 누락 없이 한 번만 입력된다. 이미지 editor의 모든 접힌 caret은
브라우저 Native caret을 사용하며 붉은색으로 표시한다. 이미지 앞·뒤 Native caret은
이미지 경계에서 각각 바깥쪽으로 2px 떨어져 이미지와 겹치지 않는다. 이미지가 포함된
선택에는 별도의 파란 outline을 표시하지 않는다.

### 완료 조건

| 상황 | 관찰 가능한 결과 |
| --- | --- |
| 이미지 앞·뒤 텍스트만 선택하고 잘라내기 | 브라우저가 선택 내용을 클립보드에 기록하고 선택한 글자만 한 번 제거한다. |
| 이미지와 주변 글자를 정방향·역방향으로 선택하고 잘라내기 | 기존 image-atom clipboard 형식과 실제 이미지 bytes를 기록한 뒤 선택 범위 전체를 한 Notes history 작업으로 제거한다. |
| clipboard 기록 실패·bytes 부재·selection authority 변경 | 원본을 삭제하지 않는다. |
| 처음 비활성 상태의 이미지 블릿 텍스트나 빈 이미지 경계를 클릭하고 한글 입력 | 첫 조합부터 완성된 한글이 보이고 draft에 한 번만 반영된다. |
| 이미지가 포함된 펼쳐진 선택 | Native selection 표시는 유지하지만 별도의 2px 파란 outline은 없다. |
| 이미지 앞 접힌 caret | 붉은 Native caret이 실제 이미지 시작점보다 2px 앞에 표시된다. |
| 이미지 뒤 접힌 caret | 붉은 Native caret이 반응형 실제 이미지 끝점보다 2px 뒤에 표시된다. |
| 이미지 앞·뒤 일반 텍스트의 접힌 caret | 붉은 Native caret을 사용하고 폭·높이·깜박임은 브라우저 기본값을 따른다. |
| 펼쳐진 선택·blur·read-only·이미지 내부 컨트롤 포커스 | 이미지 경계 caret을 표시하지 않는다. |

### 비대상

- 일반 텍스트 블릿, supporting note, 검색 입력 등 `ImageAtomEditor` 밖의 caret 변경
- Native caret의 폭·높이·깜박임 주기 변경
- clipboard MIME, attachment 저장 형식, IPC, Rust, SQLite 변경
- 여러 이미지 atom을 한 제목 안에 두는 데이터 모델 변경
- Native selection의 반투명 선택 색상 변경
- 이미지 메뉴, resize, lightbox, drag-and-drop 동작 변경

### 영향 경계

React의 `ImageAtomEditor`, 기존 image-atom clipboard 유틸리티, row/page-header의
구조적 image edit 연결, Notes CSS와 frontend 테스트만 변경한다. IPC·Rust·SQLite·파일
시스템 계약은 그대로다.

### 직접 확인 경로

새로 빌드하고 다시 시작한 macOS Tauri 앱의 격리된 Vault에서 이미지 블릿을 만든다.
텍스트와 이미지를 함께 드래그해 `Cmd+X` 후 붙여넣기로 clipboard 내용을 확인하고,
Undo 한 번으로 원래 블릿이 복구되는지 확인한다. 이어 처음 포커스한 이미지 블릿의
이미지 앞·뒤에 한글을 입력한다. 일반 텍스트와 이미지 경계의 붉은 Native caret,
앞·뒤 2px 간격, 선택 시 파란 outline 제거를 밝은 테마와 어두운 테마에서 확인한다.

## 현재 원인

### 잘라내기가 삭제로 이어지지 않음

브라우저는 Native `cut` 이벤트에서 clipboard를 기록한 뒤 `beforeinput`의
`deleteByCut`으로 DOM 삭제를 요청한다. `ImageAtomEditor`는 지원하지 않는 모든
`beforeinput` mutation을 차단하며 `deleteByCut`도 막지만 대응하는 논리 편집을 실행하지
않는다. 그래서 clipboard 동작이 시작되어도 controlled draft는 남는다.

이미지가 포함된 범위에는 Native DOM 직렬화만 사용할 수 없다. 이미지 subtree는
`contentEditable=false`이고 실제 attachment bytes 및 Yonalist 내부 metadata가
controlled DOM 밖의 권위 상태에 있기 때문이다. 저장소에는 byte-safe serializer와
stale-selection settlement가 있지만 현재 editor의 `copy/cut` 이벤트에 연결되지 않았다.

### 최초 한글 조합이 축소된 빈 경계에서 시작됨

비활성 token overlay를 클릭할 때 실제 raw text focus와 논리 selection 복원이 뒤로
미뤄진다. 텍스트가 없는 이미지 경계는 `1px × 1px`, `line-height: 1px`, 투명 caret의
영역이며 현재 구현은 `compositionstart`가 발생한 뒤 React state를 바꿔 해당 경계를
materialize한다. WebKit의 첫 조합 mutation이 그 갱신보다 먼저 시작되면 조합 carrier가
숨거나 다른 위치로 밀려 첫 한글이 분리·누락된다.

### 합성 caret과 선택 outline

빈 경계의 Native caret을 숨기고 attachment frame의 `::before`·`::after`로 합성 caret을
그린다. 이 방식은 이미지와의 간격을 제어하기 쉽지만 WebKit 실제 조합 지점과 화면의
caret이 서로 다른 DOM에 놓인다. atom 포함 selection에는 별도 2px accent outline도
적용돼 사용자가 요청하지 않은 파란 테두리가 표시된다.

## 선택한 접근

기존 논리 image-atom selection을 유지하되, 빈 `before`와 `after` region 자체를 이미지
행에 배치해 Native caret host로 사용한다. 일반 텍스트와 이미지 경계 모두
`caret-color: var(--danger)`를 사용하며 frame pseudo-element 합성 caret은 제거한다.

이미지 경계 host는 document flow에서 높이를 예약하지 않는 absolute region으로
유지한다. 선택된 쪽만 정상 line-height, 보이는 overflow와 Native caret color를 갖는다.
앞 region의 inline 위치는 실제 이미지 시작점 `- 2px`, 뒤 region은 반응형 실제 이미지
끝점 `+ 2px`로 둔다. attachment의 저장 display width와 host의 사용 가능 width 중 작은
값을 CSS 계산에 사용해 좁은 화면에서도 실제 frame 경계를 따른다.

검토한 대안은 다음과 같다.

- 현재 합성 caret의 색상만 바꾸는 방식은 가장 작지만 Native caret 요청과 첫 IME 조합
  안정성 목표를 만족하지 못한다.
- 모든 caret을 별도 위치 측정 레이어로 그리는 방식은 정확한 크기 제어가 가능하지만
  `selectionchange` 레이아웃 측정, IME 동기화, 접근성 위험이 생긴다.
- editor를 textarea와 이미지 컨트롤로 분리하면 연속 atom selection과 clipboard 순서를
  다시 설계해야 한다.

선택한 방식은 실제 DOM selection과 표시 caret이 같은 region에 있어 IME와 접근성이
브라우저 동작을 그대로 따르고, 프레임별 위치 측정도 필요하지 않다.

## 상세 설계

### 이미지 경계 Native caret

- host는 attachment `displayWidth`를 CSS custom property로 제공한다.
- empty before/after region은 평소 `1px × 1px`, 투명 caret으로 레이아웃에서 숨긴다.
- host가 focus되고 접힌 selection이 빈 before 경계이면 before region만 정상
  line-height와 `overflow: visible`, `caret-color: var(--danger)`를 갖는다.
- before region은 image frame 시작점보다 2px 바깥쪽에 위치한다.
- after region은 `min(displayWidth, host inline size)`로 계산한 실제 frame 끝점보다 2px
  바깥쪽에 위치한다.
- 두 경계의 `<br data-image-atom-caret-aid>`는 Native selection anchor로 계속 사용한다.
- frame의 `::before`·`::after` 합성 caret 규칙은 삭제한다.
- text가 존재하는 region은 absolute empty 규칙을 벗어나 기존 줄 배치를 유지하고
  `caret-color: var(--danger)`만 적용한다.
- read-only/disabled이거나 selection이 펼쳐진 경우 활성 caret-side가 없으므로 경계
  caret도 보이지 않는다.

`restoreSelection`은 DOM selection을 쓴 직후 같은 논리 selection으로 caret-side UI를
동기화한다. 따라서 pointer/focus와 다음 keyboard composition 사이에 해당 Native caret
host가 준비된다. `compositionstart`에서는 mutation observer만 끊고 React state로 빈
region 구조를 바꾸지 않는다. 조합 DOM은 composition 종료까지 WebKit이 소유한다.

### 텍스트-only cut

선택이 atom을 포함하지 않으면 `cut` 이벤트를 브라우저에 위임해 기본 clipboard 기록을
유지한다. 뒤따르는 `deleteByCut`은 preventDefault한 뒤 현재 논리 selection에
`applyLogicalEdit("")`를 적용한다. selection이 접혔거나 editor가 unavailable이거나 조합
중이면 삭제하지 않는다.

### atom 포함 copy/cut

atom을 포함한 정방향·역방향 selection은 editor가 clipboard 이벤트를 소유한다.

1. 논리 selection, editor authority, attachment identity와 현재 draft를 동결한다.
2. 기존 image byte lease와 `writeNotesImageAtomClipboard`로 plain text, HTML, private MIME
   및 가능한 image MIME를 기록한다.
3. cut에서는 `settleNotesImageAtomCut`이 clipboard 성공, 실제 bytes, 현재 authority와
   동일한 attachment/draft를 확인한다.
4. 조건이 모두 맞을 때만 row/page header의 `applyImageAtomEdit`에 원래 selection과 빈
   replacement를 전달한다.
5. 구조적 명령의 committed 결과만 삭제 성공으로 취급한다. 실패나 stale 상태에서는
   원본을 유지한다.

copy는 같은 serializer를 사용하지만 제거 settlement는 실행하지 않는다. atom을
포함하지 않은 copy/cut은 기존 browser selection을 사용한다.

### 선택 outline

`data-atom-selected`는 keyboard와 selection 상태 판별에 유지한다. 해당 attribute에
연결된 별도 outline CSS만 제거하고 Native selection highlight는 유지한다.

## 테스트 전략

### editor DOM

- image-only before/after 경계가 실제 Native caret aid를 유지
- before는 frame 시작 `-2px`, after는 반응형 frame 끝 `+2px` CSS 계약 사용
- 경계 selection 복원 직후 해당 region이 정상 line-height, visible overflow, 붉은
  Native caret으로 활성화
- frame pseudo-element 합성 caret 규칙 부재
- resting overlay 최초 pointer focus 뒤 첫 `한`이 한 번만 commit
- text region의 Native caret도 `var(--danger)` 사용
- 펼쳐진 selection, blur, unavailable에서 경계 caret 비활성
- selected atom outline 규칙 부재

### clipboard와 통합

- text-only 정방향·역방향 selection의 `deleteByCut`이 선택 글자만 제거
- atom-only, 앞 글자+atom, atom+뒤 글자, 전체 mixed selection의 copy/cut
- clipboard 실패, bytes 부재, stale selection, structural command 실패 시 원본 유지
- outline row와 page header가 attachment bytes 및 committed structural cut을 연결
- 기존 paste 우선순위, image removal, Undo/Redo selection 복원 유지

## 검증 범위

구현 중에는 새 회귀 테스트와 `ImageAtomEditor`, row/page-header의 owning 테스트만
실행한다. diff가 고정된 뒤 frontend 전체 테스트, lint, build, `git diff --check`를 한 번
실행하고 새 Tauri bundle/process와 격리된 Vault로 직접 확인한다. Rust·IPC·저장 계약을
바꾸지 않으므로 Cargo test, rustfmt, Clippy는 실행하지 않는다.
