# Notes 블릿 Markdown 렌더링 설계

## 목표

Notes의 블릿 제목에 제한된 Markdown 문법을 지원한다. 사용자가 편집할
때는 저장된 원문을 그대로 볼 수 있어야 하고, 포커스가 없을 때는 Markdown
표시 기호를 숨긴 렌더링 결과를 보여줘야 한다. 기존 textarea, 한글 IME,
커서·선택, 태그·날짜 토큰, Undo/Redo 및 Notes 파일 동기화 계약은
유지한다.

## 완료 조건

| 입력 | 포커스가 없을 때 | 편집 중 |
| --- | --- | --- |
| `# 제목` | 기호가 없는 H1 제목 | `# 제목` 원문을 H1 스타일로 편집 |
| `## 제목` | 기호가 없는 H2 제목 | `## 제목` 원문을 H2 스타일로 편집 |
| `### 제목` | 기호가 없는 H3 제목 | `### 제목` 원문을 H3 스타일로 편집 |
| `--` | 가로 구분선 | `--` 원문 |
| `> 인용문` | 기호 없는 인용문과 왼쪽 인용선 | `> 인용문` 원문 |
| `[문서](https://example.com)` | 클릭 가능한 `문서` | Markdown 원문 |
| `**굵게**` | 기호 없는 굵은 글자 | 기호와 굵은 스타일 |
| `~~취소선~~` | 기호 없는 취소선 | 기호와 취소선 스타일 |
| `![설명](https://example.com/image.png)` | 크기를 바꿀 수 있는 이미지 블록 | Markdown 원문 |

추가 완료 조건은 다음과 같다.

- `#태그`처럼 `#` 뒤에 공백이 없는 기존 태그는 Header로 해석하지 않는다.
- 기존 `http://` 및 `https://` 원문 URL 자동 링크는 유지한다.
- 렌더링 결과를 클릭하면 대응하는 Markdown 원문 위치에 커서가 놓인다.
- Header는 편집 전후에 동일한 Header 단계와 텍스트 높이를 유지한다.
- Markdown 이미지 resize는 기존 이미지 블록과 같은 포인터·키보드 조작,
  화면 폭 제한 및 Undo/Redo 동작을 제공한다.
- 블릿 메타데이터와 이미지 메타데이터는 별도 구조로 유지한다.
- 같은 Markdown 줄에 콘텐츠와 메타데이터가 함께 있으면 정규 순서는 항상
  `사용자 콘텐츠 → 이미지 메타데이터 → 블릿 메타데이터`이다.
- 블릿 메타데이터 주석은 해당 블릿의 주 Markdown 줄에서 항상 마지막
  요소이다.

## 범위

### 지원 대상

- 일반 아웃라인 블릿 제목
- 확대된 서브 페이지의 루트 제목
- 일반 텍스트 블릿
- 제목 전체가 원격 Markdown 이미지 하나인 블릿

### 비대상

- 설명 노트의 블록 Markdown
- 글자와 Markdown 이미지가 섞인 제목
- 제목 하나에 여러 Markdown 이미지
- 원격 이미지 다운로드 또는 Notes 첨부파일 변환
- `http://` 원격 이미지
- Markdown 표, 목록, 코드 블록 및 임의 HTML
- 중첩 Markdown의 완전한 CommonMark 호환
- 기존 로컬 이미지 첨부 메타데이터의 통합 또는 제거
- 편집기 전체를 `contenteditable`이나 외부 리치 텍스트 편집기로 교체

기존 italic 및 inline code 동작은 회귀시키지 않지만 이번 기능의 표시
정책 확장 대상은 Header, 구분선, 인용문, Markdown 링크, 굵게, 취소선 및
단독 Markdown 이미지로 한정한다.

## 문법 계약

### 블록 문법

블록 문법은 제목의 첫 UTF-16 위치에서만 인식한다.

- H1: `# `로 시작하고 뒤에 한 글자 이상의 내용이 있음
- H2: `## `로 시작하고 뒤에 한 글자 이상의 내용이 있음
- H3: `### `로 시작하고 뒤에 한 글자 이상의 내용이 있음
- 인용문: `> `로 시작하고 뒤에 한 글자 이상의 내용이 있음
- 구분선: 제목이 정확히 `--`

`####`, `#제목`, `>인용`, 앞에 공백이 있는 ` # 제목`은 일반 텍스트로
남는다. 구분선은 `--` 두 글자만 인정하며 주변 공백이 있으면 일반
텍스트이다.

### Inline 문법

- Markdown 링크: `[표시 문구](URL)`
- 굵게: `**내용**`
- 취소선: `~~내용~~`

링크 URL은 `http://` 또는 `https://`만 허용한다. 다른 scheme, 빈 표시
문구, 빈 URL, 닫히지 않은 문법은 일반 텍스트로 남긴다. 첫 버전 파서는
서로 겹치거나 중첩된 토큰을 재귀적으로 해석하지 않는다.

### 이미지 문법

제목 전체가 다음 형식과 정확히 일치할 때만 원격 이미지 블릿으로
해석한다.

```markdown
![대체 문구](https://example.com/image.png)
```

- URL은 `https://`만 허용한다.
- 대체 문구는 비어 있을 수 있지만 접근성 이름은 URL host를 fallback으로
  사용한다.
- URL 뒤의 Markdown title, 상대 경로, `data:`, `blob:`, `file:` 및
  `javascript:` scheme은 지원하지 않는다.
- 로딩 전에는 안정적인 placeholder를 표시한다.
- 로드 실패 시 깨진 이미지 아이콘 대신 대체 문구와 편집 가능한 URL
  안내를 표시한다.
- 이미지를 클릭하면 기존 이미지 블록과 같은 선택·resize UI가 열린다.
- 제목이 이미지 문법에서 벗어나면 원격 이미지 표시를 즉시 중단하고
  저장된 원격 이미지 너비를 `null`로 정리한다.

## 아키텍처

### 경량 Notes Markdown 파서

전체 `markdown-it` HTML을 삽입하지 않는다. 새 순수 파서는 제목을 다음
구조로 분석한다.

```ts
type NoteMarkdownBlock =
  | { kind: "text"; inline: readonly NoteMarkdownInline[] }
  | { kind: "heading"; level: 1 | 2 | 3; markerEndUtf16: number; inline: readonly NoteMarkdownInline[] }
  | { kind: "quote"; markerEndUtf16: number; inline: readonly NoteMarkdownInline[] }
  | { kind: "divider" }
  | { kind: "remoteImage"; alt: string; url: string };
```

Inline 토큰은 화면에 표시할 문자열뿐 아니라 원문의
`startUtf16`/`endUtf16`와 내부 표시 범위를 보존한다. 이 정보는 다음
두 가지 표현을 모두 만든다.

1. 편집 표현: 원문과 문자 수가 동일하며 Markdown 기호를 표시한다.
2. 휴식 표현: Markdown 기호를 숨기고 의미가 적용된 내용만 표시한다.

기존 태그, 날짜, 원문 URL 및 inline format 토큰화와 충돌하지 않도록
블록 문법을 먼저 판별하고, 남은 내용에 겹치지 않는 inline 토큰을
적용한다.

### 커서 위치 매핑

휴식 표현은 원문보다 짧으므로 단순 DOM 문자 offset을 textarea offset으로
사용하지 않는다. 표시 span마다 대응하는 원문 범위를 기록하고 포인터
위치가 속한 span의 표시 offset을 원문 offset으로 변환한다.

- 일반 글자: 1:1 매핑
- Header와 인용문: 숨겨진 앞쪽 기호 길이를 더함
- 굵게·취소선: 숨겨진 여는 기호와 앞선 닫는 기호를 반영
- Markdown 링크: 표시 문구는 label 원문 범위에 매핑
- 링크 클릭: 편집 모드로 전환하지 않고 외부 브라우저를 엶
- 빈 공간 클릭: 가장 가까운 안전한 원문 경계로 clamp

네이티브 textarea는 항상 같은 컴포넌트 인스턴스로 유지한다. 한글 조합
중에는 기존과 동일하게 토큰 메뉴, 문법 전환 또는 선택 복원을 실행하지
않는다.

### 스타일

Header 단계는 CSS data attribute 또는 modifier class로 표현한다.
일반 아웃라인과 확대 페이지는 각 문맥의 기본 typography를 유지하면서
`H1 > H2 > H3 > 일반 제목` 순서를 보장한다. 같은 Header는 편집·휴식
상태에서 font size, font weight, line height 및 줄바꿈 폭이 동일해야 한다.

인용문은 왼쪽 border와 안쪽 여백을 사용한다. 구분선은 기존 블릿의
선택·포커스 hit area를 유지한 채 콘텐츠 열 안에 수평선을 그린다.

## 원격 Markdown 이미지

### 렌더링과 resize

기존 이미지 프레임의 resize 로직을 재사용 가능한 표시 프레임으로
분리하거나 동일 계약의 원격 이미지 프레임을 만든다. 다음 동작을
공유한다.

- 포인터 resize
- 키보드 resize
- 컨테이너 너비에 따른 비영속 clamp
- persisted target width 복원
- 최소 너비와 로드된 이미지의 intrinsic width 제한
- resize 완료 시 한 번만 영속화
- 취소 시 이전 persisted width 복원

원격 이미지는 브라우저가 `https:` URL에서 직접 로드하며 Notes assets로
다운로드하지 않는다. 현재 Tauri CSP의 `img-src ... https:` 범위 안에서만
동작한다.

### 데이터 모델

`NoteNode`에 nullable 정수 필드를 추가한다.

```ts
markdownImageWidth: number | null;
```

Rust와 SQLite에는 대응하는 `markdown_image_width`를 둔다. 값은 단독
원격 Markdown 이미지 제목에만 의미가 있다. backend는 안전한 절대
상한과 양의 정수를 검증하고, frontend는 로드된 intrinsic width와 현재
컨테이너 폭을 추가로 clamp한다.

Resize는 전용 Notes 명령으로 저장하며 기존 history epoch, operation
serialization, Undo/Redo 및 HLC 갱신 규칙을 따른다. 제목 변경으로
단독 이미지 문법이 사라질 때의 너비 초기화는 제목 변경과 같은 history
entry 안에서 원자적으로 처리한다.

## Notes Markdown 파일 메타데이터

기존 로컬 이미지 첨부는 현재 구조를 유지한다.

```markdown
![Image](.yonalist/notes-assets/<hash>.<ext>) <!-- ya: name: <encoded-name> w: 320 -->
```

원격 Markdown 이미지는 첨부파일이 아니므로 `ya` 메타데이터를 만들지
않는다. 일반 블릿의 표시 너비는 블릿 메타데이터에 `miw:`로 저장한다.

```markdown
- !\[차트\]\(https\://example.com/chart.png\) <!-- yid: <uuid> t: <hlc> miw: 320 -->
```

`miw:`가 없으면 명시적인 사용자 너비가 없는 상태이다. 로컬 이미지
첨부의 `w:`와 원격 Markdown 이미지의 `miw:`는 서로 다른 수명과 대상을
가진다.

루트 블릿은 inline 블릿 메타데이터가 없으므로 front matter에 nullable
`root_markdown_image_width`를 저장한다.

### 메타데이터 정규 순서

메타데이터 구조는 통합하지 않는다.

- 이미지 메타데이터: `<!-- ya: ... -->`
- 블릿 메타데이터: `<!-- yid: ... -->`

같은 주 Markdown 줄에 두 주석이 모두 존재할 때 canonical writer는
다음 순서만 출력한다.

```markdown
<사용자 콘텐츠> <!-- ya: ... --> <!-- yid: ... -->
```

따라서 블릿 메타데이터는 항상 그 줄의 마지막 요소이다. 텍스트가 먼저
나오고 로컬 이미지가 continuation line에 놓이는 기존 image atom에서는
각 줄의 메타데이터가 해당 줄의 콘텐츠 뒤에 위치한다. 블릿의 `yid`
메타데이터는 블릿을 여는 주 Markdown 줄의 마지막 요소이고, continuation
이미지의 `ya` 메타데이터는 이미지 줄의 마지막 요소이다.

파서는 기존 형식 버전 3 파일을 계속 읽고 canonical writer가 쓰는 순서를
검증한다. `miw:`는 알려진 단일값 토큰으로 취급해 중복, 값 누락, 0 이하,
비정규 정수 및 상한 초과를 거부한다. 형식 확장에 맞춰 topic format
version을 올리고 구버전 입력 호환 범위를 테스트로 고정한다.

## 보안과 오류 처리

- 일반 링크는 `http:`/`https:`만 외부 opener로 전달한다.
- 이미지는 `https:`만 DOM `src`로 사용한다.
- Markdown을 `dangerouslySetInnerHTML`로 렌더링하지 않는다.
- HTML 입력은 일반 텍스트로 남는다.
- URL parser와 scheme 검사는 렌더링 직전에도 다시 수행한다.
- 이미지 로드 오류는 앱 전체 오류나 동기화 오류로 승격하지 않는다.
- 잘못된 `miw:` 메타데이터는 조용히 잘못된 크기로 적용하지 않고 기존
  Notes 파일 검증·격리 규칙을 따른다.

## 테스트 전략

### 순수 파서

- H1/H2/H3의 정확한 접두사와 태그 충돌
- 정확한 `--` 구분선
- 인용문 접두사
- Markdown 링크와 scheme 제한
- 굵게·취소선의 원문 범위
- 단독 HTTPS 이미지와 혼합 콘텐츠 거부
- 미완성·겹침·악성 URL의 일반 텍스트 fallback
- 휴식 offset에서 원문 UTF-16 offset으로의 매핑
- 한글, emoji surrogate pair 및 결합 문자가 포함된 offset

### React

- 휴식 상태에서 기호가 숨겨짐
- 편집 상태에서 원문 기호가 나타남
- Header 편집 전후 typography가 동일함
- 태그·날짜·원문 URL의 기존 상호작용 유지
- Markdown 링크 클릭과 키보드 활성화
- 클릭 위치의 textarea selection 복원
- IME 조합 중 textarea와 composition 상태 유지
- 구분선과 인용문의 선택·포커스 hit area
- 원격 이미지 로드, 오류 fallback, 선택 및 resize
- resize pointer cancel, keyboard commit 및 container clamp

### 저장·Undo/Redo·동기화

- `markdown_image_width` validation과 직렬화
- resize 한 번당 history entry 한 개
- resize Undo/Redo
- 제목 변경과 stale width 초기화의 원자성
- 일반 블릿 `miw:` round trip
- 루트 `root_markdown_image_width` round trip
- 로컬 이미지 `ya` 메타데이터 회귀 방지
- 콘텐츠, `ya`, `yid` canonical 순서
- 블릿 메타데이터가 주 Markdown 줄의 마지막이라는 계약
- 기존 format version 3 파일 입력 호환

## 직접 확인 시나리오

1. 일반 블릿에 각 문법을 입력하고 포커스를 이동해 기호가 사라지는지
   확인한다.
2. 다시 클릭해 대응하는 원문 위치에 커서가 나타나는지 확인한다.
3. H1/H2/H3를 편집하면서 글자 크기와 줄 위치가 바뀌지 않는지 확인한다.
4. 링크를 클릭해 외부 브라우저가 열리고 악성 scheme은 링크가 되지 않는지
   확인한다.
5. 단독 HTTPS 이미지 문법을 입력하고 이미지가 로드되는지 확인한다.
6. 포인터와 키보드로 resize하고 Undo/Redo 및 앱 재시작 후 너비가
   복원되는지 확인한다.
7. Notes Markdown 파일에서 이미지 메타데이터와 블릿 메타데이터가
   분리되어 있고 블릿 메타데이터가 주 Markdown 줄의 마지막인지 확인한다.

## 위험과 완화

- **표시 문자열과 원문 길이 차이:** source span 기반 offset 매핑 테스트를
  먼저 작성한다.
- **Header 편집 중 geometry 이동:** 편집·휴식 레이어가 같은 typography
  modifier를 공유한다.
- **IME 회귀:** 네이티브 textarea를 유지하고 composition 중 파싱 결과로
  selection을 변경하지 않는다.
- **원격 이미지의 불안정성:** 다운로드하지 않는다는 계약을 명확히 하고
  로딩·오류 placeholder로 layout shift를 제한한다.
- **동기화 형식 회귀:** 기존 format version 3 golden 입력과 새 canonical
  출력 순서를 함께 검증한다.
- **범위 팽창:** 첫 버전은 단독 HTTPS 이미지와 비중첩 Markdown만
  지원한다.
