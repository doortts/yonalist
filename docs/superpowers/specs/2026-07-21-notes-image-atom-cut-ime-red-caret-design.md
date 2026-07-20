# Notes 이미지 atom 잘라내기·첫 한글 입력·붉은 caret 설계

## 계약

### 목표

이미지가 들어 있는 블릿을 일반 텍스트 블릿처럼 안정적으로 편집한다. 선택한 텍스트와
이미지는 `Cmd/Ctrl+X`로 클립보드에 기록된 뒤 정확히 제거되고, 처음 포커스를 둔 직후의
한글도 자소 분리나 누락 없이 한 번만 입력된다. 이미지 editor의 접힌 caret은 이미지
경계와 일반 텍스트 위치 모두 붉은색이며, 기존 폭을 유지한 채 위·아래로 각각 1px 더
길게 표시한다. 이미지가 포함된 선택에는 별도의 파란 outline을 표시하지 않는다.

### 완료 조건

| 상황 | 관찰 가능한 결과 |
| --- | --- |
| 이미지 앞·뒤 텍스트만 선택하고 잘라내기 | 브라우저가 선택 내용을 클립보드에 기록하고 선택한 글자만 한 번 제거한다. |
| 이미지와 주변 글자를 함께 정방향·역방향으로 선택하고 잘라내기 | 기존 image-atom clipboard 형식과 실제 이미지 bytes를 기록한 뒤 선택 범위 전체를 한 Notes history 작업으로 제거한다. |
| clipboard 기록 실패·bytes 부재·선택 authority 변경 | 원본을 삭제하지 않는다. |
| 처음 비활성 상태의 이미지 블릿 텍스트나 빈 이미지 경계를 클릭하고 한글 입력 | 첫 조합부터 완성된 한글이 보이고 draft에 한 번만 반영된다. |
| 이미지가 포함된 펼쳐진 선택 | native selection 표시는 유지하지만 별도의 2px 파란 outline은 없다. |
| 이미지 왼쪽·오른쪽 접힌 caret | 폭 1px, 기존보다 위·아래 각 1px 긴 붉은 caret이 표시된다. |
| 이미지 앞·뒤 일반 텍스트의 접힌 caret | native caret 대신 같은 폭과 색의 붉은 시각 caret이 실제 글자 위치보다 위·아래 각 1px 길게 표시된다. |
| 펼쳐진 선택·blur·read-only·이미지 내부 컨트롤 포커스 | 붉은 접힌 caret을 표시하지 않는다. |

### 비대상

- 일반 텍스트 블릿, supporting note, 검색 입력 등 `ImageAtomEditor` 밖의 caret 변경
- clipboard MIME, attachment 저장 형식, IPC, Rust, SQLite 변경
- 여러 이미지 atom을 한 제목 안에 두는 데이터 모델 변경
- native selection의 반투명 선택 색상 변경
- 이미지 메뉴, resize, lightbox, drag-and-drop 동작 변경

### 영향 경계

React의 `ImageAtomEditor`, 기존 image-atom clipboard 유틸리티, row/page-header의
구조적 image edit 연결, Notes CSS와 frontend 테스트만 변경한다. IPC·Rust·SQLite·파일
시스템 계약은 그대로다.

### 직접 확인 경로

새로 빌드하고 다시 시작한 macOS Tauri 앱의 격리된 Vault에서 이미지 블릿을 만든다.
텍스트와 이미지를 함께 드래그해 `Cmd+X` 후 붙여넣기로 clipboard 내용을 확인하고,
Undo 한 번으로 원래 블릿이 복구되는지 확인한다. 이어 처음 포커스한 이미지 블릿의
이미지 앞·뒤에 한글을 입력하고, 텍스트 caret과 이미지 경계 caret의 붉은색·높이 및
선택 시 파란 outline 제거를 밝은 테마와 어두운 테마에서 확인한다.

## 현재 원인

### 잘라내기가 삭제로 이어지지 않음

브라우저는 native `cut` 이벤트에서 clipboard를 기록한 뒤 `beforeinput`의
`deleteByCut`으로 DOM 삭제를 요청한다. `ImageAtomEditor`는 지원하지 않는 모든
`beforeinput` mutation을 차단하며 `deleteByCut`도 막지만, 대응하는 논리 편집을
실행하지 않는다. 그래서 선택 표시와 clipboard 동작이 시작되어도 controlled draft는
남는다.

이미지가 포함된 범위에는 native DOM 직렬화만 사용할 수도 없다. 이미지 subtree는
`contentEditable=false`이고 실제 attachment bytes 및 Yonalist 내부 metadata가
controlled DOM 밖의 권위 상태에 있기 때문이다. 저장소에는 byte-safe serializer와
stale-selection settlement가 있지만 현재 editor의 `copy/cut` 이벤트에 연결되지 않았다.

### 최초 한글 조합이 숨겨진 caret host에서 시작됨

비활성 token overlay를 클릭할 때 실제 raw text 포커스와 논리 selection 복원은 뒤로
미뤄진다. 텍스트가 없는 이미지 경계는 1px, `line-height: 1px`, 투명 caret의 숨은
영역이며, 현재 구현은 `compositionstart`가 발생한 뒤에야 해당 경계를 materialize한다.
WebKit의 첫 조합 mutation이 React 갱신보다 먼저 시작되면 조합 carrier가 숨거나 다른
위치로 밀려 첫 한글이 분리·누락된다. 삭제 후 재입력은 이미 editor와 carrier가
활성화된 상태라 정상 동작한다.

### 선택 outline과 caret 크기

atom 포함 selection의 `data-atom-selected=true`에 별도 2px accent outline을 적용하는
CSS가 파란 테두리의 직접 원인이다. 이미지 경계 caret은 pseudo-element라 크기와 색을
직접 조절할 수 있지만, 일반 텍스트의 native caret은 표준 CSS로 색상만 바꿀 수 있고
높이를 독립적으로 조절할 수 없다.

## 검토한 접근

### 1. native cut과 native caret에만 의존

텍스트-only `deleteByCut`은 작은 수정으로 고칠 수 있고 `caret-color`로 붉은색도 만들 수
있다. 그러나 이미지 bytes가 포함된 안전한 clipboard와 일반 caret 높이 변경을 만족하지
못한다.

### 2. editor 전체를 textarea와 별도 이미지 컨트롤로 분리

caret 표현은 단순해지지만 이미지가 논리적 글자 하나로 포함되는 연속 selection,
방향키 이동, clipboard 순서를 다시 설계해야 한다. 회귀 위험과 작업량이 가장 크다.

### 3. 기존 논리 editor와 clipboard primitive를 완성하고 시각 caret만 겹쳐 그리기

기존 selection/Undo/attachment 계약을 유지한다. 텍스트-only cut은 native clipboard 뒤
논리 삭제로 연결하고, atom 포함 cut만 기존 byte-safe 경로가 소유한다. raw selection은
브라우저에 남겨 IME를 보존하면서 caret paint만 CSS pseudo-element로 대체한다.

이 방식을 선택한다. 변경 경계가 frontend에 한정되고, 이미 검증된 논리 offset과
clipboard settlement를 재사용하면서 모든 완료 조건을 만족한다.

## 상세 설계

### 텍스트-only cut

선택이 atom을 포함하지 않으면 `cut` 이벤트를 브라우저에 위임해 `text/plain` 등의
기본 clipboard 기록을 유지한다. 뒤따르는 `deleteByCut`은 preventDefault한 뒤 현재
논리 selection에 `applyLogicalEdit("")`를 적용한다. selection이 접혔거나 editor가
read-only/disabled이거나 조합 중이면 아무것도 삭제하지 않는다.

### atom 포함 cut

atom을 포함한 정방향·역방향 selection은 editor가 `cut` 이벤트를 소유한다.

1. 논리 selection, editor authority, attachment identity와 현재 draft를 동결한다.
2. 기존 image byte lease를 통해 준비된 attachment bytes와
   `writeNotesImageAtomClipboard`로 plain text, HTML, private MIME 및 가능한 image MIME를
   기록한다.
3. `settleNotesImageAtomCut`이 clipboard 성공, 실제 bytes, 현재 authority와 동일한
   attachment/draft를 확인한다.
4. 조건이 모두 맞을 때만 row/page header의 `applyImageAtomEdit`에 원래 논리 selection과
   빈 replacement를 전달한다.
5. 구조적 명령의 committed 결과만 삭제 성공으로 취급한다. 실패나 stale 상태에서는
   원본을 유지한다.

copy도 같은 serializer를 사용하지만 원본 제거 settlement는 실행하지 않는다. atom을
포함하지 않은 copy/cut은 기존 browser selection을 그대로 사용한다.

### 최초 포커스와 IME

resting overlay의 pointer down에서 raw editor를 활성화하고 host focus와 논리 selection을
첫 입력 전에 확정한다. `restoreSelection`은 DOM selection을 쓴 직후 selection UI를 같은
논리 값으로 동기화한다. 접힌 selection이 빈 이미지 경계라면 focus된 동안 그 한쪽만
미리 materialize해 `compositionstart` 전에 정상 line-height와 caret anchor를 갖게 한다.

조합이 시작된 뒤에는 기존처럼 mutation observer를 끊고 composition DOM을 브라우저가
소유한다. 시각 caret 갱신은 React state나 projection rerender를 만들지 않고 host의 CSS
custom property만 명령형으로 바꾼다. `compositionend`에서 최종 DOM을 한 번 읽고 기존
projection 복구와 draft commit을 수행한다.

### 붉은 시각 caret

일반 텍스트 위치에서는 host의 native caret을 투명하게 만들고 host pseudo-element를
시각 caret으로 사용한다. 새 DOM child를 넣지 않아 `before → atom → after`의 controlled
host 구조와 selection mapper를 바꾸지 않는다.

- 접힌 Range의 viewport rect와 host rect를 비교해 local inline/block 위치를 계산한다.
- 시각 caret 폭은 1px로 유지한다.
- 높이는 browser Range rect 높이 + 2px이며 top은 1px 위로 이동한다.
- 색은 테마별 붉은색 token인 `var(--danger)`를 사용한다.
- host의 CSS custom property와 data attribute를 selectionchange, focus, pointer selection,
  composition selection 변화, editor projection 복구, resize/scroll 때 갱신한다.
- 갱신은 DOM style/attribute만 바꾸며 React render를 발생시키지 않는다.
- selection이 펼쳐졌거나 rect가 유효하지 않거나 editor가 비활성인 경우 숨긴다.

이미지 양옆의 빈 경계는 Range rect가 안정적이지 않으므로 기존 attachment-frame의
before/after pseudo-element를 유지한다. 폭은 1px, top은 기존보다 1px 위, 높이는 기존
값보다 2px 크게 하고 같은 `var(--danger)`를 쓴다. 일반 시각 caret은 이때 숨겨 중복
표시하지 않는다.

atom 포함 펼쳐진 선택의 `data-atom-selected`는 keyboard/selection 상태 판별에 계속
사용하되, 해당 attribute에 연결된 별도 outline CSS만 제거한다. browser의 native
selection highlight는 유지한다.

## 테스트 전략

### `ImageAtomEditor` 회귀 테스트

- text-only 정방향·역방향 selection의 `deleteByCut`이 선택 글자만 제거
- atom-only, 앞 글자+atom, atom+뒤 글자, 전체 mixed selection의 copy/cut
- clipboard 실패, bytes 부재, stale selection, structural command 실패 시 원본 유지
- read-only/disabled와 composition 중 cut 차단
- resting overlay 최초 pointer focus 직후 raw selection과 빈 경계가 조합 전에 준비됨
- 준비된 첫 `compositionstart`에서 `한`이 한 번만 commit됨
- 접힌 일반 selection에서 CSS caret geometry가 Range보다 위·아래 각 1px 확장됨
- 펼쳐진 selection, blur, atom 내부 focus에서 시각 caret 숨김
- 빈 before/after에서는 일반 caret 대신 image-edge caret side만 활성화

### 통합·스타일 회귀 테스트

- outline row와 page header가 attachment bytes 및 committed structural cut을 연결
- 기존 paste 우선순위, image removal, Undo/Redo selection 복원 유지
- selected atom outline 규칙 부재
- native caret 투명화, 일반 caret pseudo-element와 image-edge pseudo-element가
  `var(--danger)`, 1px 폭, 위·아래 1px 확장 계약 사용
- page header와 outline row 모두 같은 editor 계약 사용

## 검증 범위

구현 중에는 새 회귀 테스트와 `ImageAtomEditor`, row/page-header의 owning 테스트만
실행한다. diff가 고정된 뒤 frontend 전체 테스트, lint, build, `git diff --check`를 한 번
실행하고 새 Tauri bundle/process와 격리된 Vault로 직접 확인한다. Rust·IPC·저장 계약을
바꾸지 않으므로 Cargo test, rustfmt, Clippy는 실행하지 않는다.
