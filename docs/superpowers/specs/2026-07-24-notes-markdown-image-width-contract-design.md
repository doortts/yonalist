# Notes Markdown 이미지 너비 계약 설계

**날짜:** 2026-07-24

**상태:** 승인됨 — 현재 구현 변경 불필요

## 계약

| 항목 | 내용 |
| --- | --- |
| 목표 | `markdownImageWidth`가 실제로는 선택 값이라는 의미를 유지하면서, 정규화된 Notes 내부 상태에서는 `undefined`가 섞이지 않는 명확한 계약을 정의한다. |
| 완료 조건 | 저장·파일·변경 입력에서는 너비를 생략할 수 있다. 프런트엔드의 정규화된 `NoteNode`에서는 `number \| null` 키가 항상 존재한다. 명시하지 않은 너비는 일관되게 `null`이다. |
| 비대상 | SQLite migration, Notes 파일 포맷 변경, 기존 이미지 resize 동작 변경, 공통 `NoteNode` 팩토리 도입, `markdownImageWidth`를 모든 입력에서 강제로 전송하는 변경은 포함하지 않는다. |
| 경계 | Notes Markdown 파일, SQLite, Rust command 입력과 응답, Tauri IPC, 프런트엔드 payload 검증과 정규화 상태를 구분한다. |
| 데이터·Undo/Redo | 너비의 저장 의미와 기존 resize history 동작은 바꾸지 않는다. 값의 존재 여부를 정규화하는 일은 별도 Undo 항목을 만들지 않는다. |
| 직접 확인 | 현재 `main`에서 `npm run build`가 성공하고, 너비가 없는 블릿은 기존 자동 크기로 표시되며 resize한 Markdown 이미지는 저장된 폭을 복원한다. |

## 결정

`markdownImageWidth`는 사용자 데이터 관점에서는 선택 값이다. 사용자가
Markdown 이미지의 폭을 직접 조절했을 때만 양의 정수 값이 의미를 가진다.
그렇지 않으면 저장 계층에서는 값 또는 메타데이터를 생략할 수 있다.

프런트엔드의 정규화된 `NoteNode`에서는 키를 필수로 유지한다.

```ts
interface NoteNode {
  // ...
  markdownImageWidth: number | null;
}
```

- 양의 정수: 사용자가 명시한 Markdown 이미지 표시 폭
- `null`: 명시적인 폭 없음
- `undefined`: 정규화된 내부 상태에서는 허용하지 않음

즉, “값이 선택 사항”인 것과 “정규화된 객체에서 키가 선택 사항”인 것을
분리한다.

```text
Notes 파일 / SQLite / command 입력
       width 생략 가능
                │
                ▼
       IPC 검증 또는 정규화
     생략된 값은 null로 확정
                │
                ▼
  프런트엔드 Normalized NoteNode
 markdownImageWidth: number | null
```

## 계층별 표현

### Notes Markdown 파일

일반 블릿의 `miw:`와 루트의 `root_markdown_image_width`는 너비가 있을 때만
의미가 있다. 메타데이터가 없으면 `None`으로 읽는다. 과거 포맷을 읽을 때도
너비 없음으로 정규화한다.

파일에 값이 없다는 것은 “손상”이 아니라 “사용자가 폭을 지정하지 않음”이다.
canonical writer는 불필요한 `null` 메타데이터를 새로 기록하지 않는다.

### SQLite

`notes_nodes.markdown_image_width`는 nullable 열로 유지한다.

- `NULL`: 명시적인 폭 없음
- `1..=16384`: 유효한 명시적 폭
- 0, 음수, 상한 초과: 저장 전에 거부

새 migration이나 기본값 열은 추가하지 않는다.

### Rust와 command 입력

Rust의 저장·응답 모델은 `Option<i64>`를 유지한다. 변경 입력은
`#[serde(default)]`를 사용하므로 필드가 생략되어도 `None`으로 해석한다.

따라서 프런트엔드는 일반 제목 변경처럼 너비를 수정하지 않는 요청에서 해당
필드를 생략할 수 있다. 너비를 제거하는 명시적 변경은 현재 command 계약에 따라
`null`을 전달한다.

Rust 응답의 `None`은 기본적으로 IPC JSON에서 `null`로 직렬화된다. 현재 정상
응답에는 키가 존재하므로 프런트엔드가 정규화된 `NoteNode` 키를 필수로 유지해도
호환된다.

### 프런트엔드 입력과 정규화 상태

현재 Tauri IPC 응답은 `markdownImageWidth` 키를 항상 제공하므로
`isNoteNode`는 완전한 응답 객체를 엄격하게 검증한다. 이 검사는 내부 생성 코드가
필드를 빠뜨렸을 때 TypeScript 빌드에서 즉시 발견되도록 돕는다.

과거 IPC 응답이나 외부 JSON처럼 키가 실제로 빠질 수 있는 입력을 지원해야 한다면
그때 별도의 원시 타입을 도입한다.

```ts
interface RawNoteNode {
  // ...
  markdownImageWidth?: number | null;
}

function normalizeNoteNode(raw: RawNoteNode): NoteNode {
  return {
    // ...
    markdownImageWidth: raw.markdownImageWidth ?? null
  };
}
```

`RawNoteNode`는 ingress 경계에서만 사용하고 reducer, draft, projection,
history에는 노출하지 않는다. 내부 `NoteNode`를 optional로 바꾸지는 않는다.

## 검증과 오류 처리

경계별 정책은 다음과 같다.

| 입력 | 처리 |
| --- | --- |
| 필드 또는 파일 메타데이터 생략 | ingress에서 `null`로 정규화 |
| `null` | 명시적인 폭 없음으로 수용 |
| `1..=16384` 정수 | 명시적 폭으로 수용 |
| 0, 음수, 소수, 상한 초과 | 잘못된 입력으로 거부 |
| 정규화 이후 `undefined` | 프로그래밍 오류로 간주 |

기존 검증을 유지한다.

- TypeScript의 필수 `NoteNode` 필드가 불완전한 내부 생성 코드를 차단한다.
- `isNoteNode`가 IPC payload의 키와 값 범위를 검사한다.
- Rust command validation과 SQLite `CHECK`가 잘못된 저장을 차단한다.
- CI의 TypeScript 검사와 production build가 누락을 병합 전에 발견한다.

향후 `RawNoteNode` 호환 경계를 실제로 추가할 때만 다음 회귀 테스트를 추가한다.

1. 키가 없는 원시 payload가 `markdownImageWidth: null`로 정규화된다.
2. `null`과 유효한 정수는 그대로 보존된다.
3. 잘못된 수치와 잘못된 타입은 거부된다.
4. 정규화 결과가 history, projection과 reducer에 들어갈 때
   `markdownImageWidth` 키를 항상 가진다.

현재 `main`에서는 문제를 만들었던 낙관적 임시 `NoteNode` 생성 경로가 제거되어
빌드가 성공한다. 따라서 이 설계를 반영하기 위한 즉시 코드 변경이나 추가
migration은 없다.

## 검토한 대안

### `NoteNode.markdownImageWidth?`로 변경

코드 작성 시 필드 누락은 쉬워지지만 모든 소비자가 `undefined`, `null`, 숫자 세
상태를 처리해야 한다. 누락된 내부 생성 코드를 타입 검사가 잡지 못하므로 선택하지
않는다.

### 모든 `NoteNode`를 공통 팩토리로 생성

기본값 누락을 줄일 수 있지만 native 응답, 테스트 fixture, reducer projection 등
서로 다른 수명의 객체를 하나의 팩토리에 결합한다. 현재는 TypeScript와 ingress
검증으로 충분하므로 도입하지 않는다.

### 파일과 IPC에서 항상 숫자 또는 `null`을 기록

내부 형태는 단순해지지만 사용자 파일에 의미 없는 메타데이터가 늘고 기존의
선택적 메타데이터 계약을 깨뜨린다. 저장 표현과 내부 정규화 표현을 분리하는 현재
설계를 유지한다.
