# 빈 블릿 `Untitled` 제거 설계

## 목표

일반 텍스트 블릿의 제목이 비어 있을 때 편집 전과 편집 중 모두 화면에
`Untitled` placeholder를 표시하지 않는다.

## 완료 조건

- 빈 일반 블릿의 고정 표시층에 `Untitled` 문자열이 렌더링되지 않는다.
- 빈 일반 블릿의 제목 textarea에 `placeholder="Untitled"` 속성이 없다.
- 빈 블릿은 기존과 동일하게 포커스를 받고 바로 입력할 수 있다.
- 제목 편집기의 접근성 이름 `Edit node title`은 유지된다.
- 저장되는 제목은 기존과 동일한 빈 문자열이며 생성·삭제·Undo/Redo 동작은 바뀌지 않는다.

## 비대상

- 서브 페이지와 루트 페이지 제목의 `Untitled page` 대체 문구
- 왼쪽 페이지 목록, breadcrumb, 검색, 이동 대상, 메뉴의 빈 제목 식별 문구
- 다중 선택 드래그 미리보기의 `Untitled` 대체 문구
- 이미지 블릿의 파일명·접근성 대체 문구

## 설계

`OutlineNodeRow`가 일반 텍스트 블릿 제목용 `NoteTextField`에 전달하는
`placeholder="Untitled"`만 제거한다. `NoteTextField` 공통 구현과 빈 제목의
접근성·탐색용 presentation helper는 변경하지 않는다.

이 방식은 CSS로 문자열을 숨기는 것과 달리 DOM에서 placeholder 자체를 제거하고,
공통 빈 제목 label을 바꾸는 방식과 달리 페이지 목록과 보조 UI의 식별 가능성을
보존한다.

## 영향 범위

- React: `OutlineNodeRow`와 실제 Notes workspace 렌더 테스트
- IPC, Rust, SQLite, 파일시스템, macOS 네이티브 설정: 변경 없음

## 검증

1. 빈 텍스트 블릿을 포함한 workspace를 렌더한다.
2. 고정 표시층에 `Untitled`이 없고 textarea placeholder가 없음을 확인한다.
3. textarea의 값과 접근성 이름, 포커스 가능성을 확인한다.
4. 실제 격리 앱에서 새 빈 블릿을 만들고 `Untitled`이 나타나지 않는지 확인한다.
5. 프론트엔드 전체 테스트, lint, build, diff 검사를 실행한다.
