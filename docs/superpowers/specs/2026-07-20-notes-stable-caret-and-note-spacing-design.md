# Notes 고정 표시 커서 및 설명 간격 설계

**작성일:** 2026-07-20

## 목표

고정 표시 모드를 사용하는 서브 페이지 설명과 항목 설명에서 커서를 실제
글자 줄 상자에 맞추고, 일반 블릿 제목과 설명 사이의 세로 간격을 현재보다
조금 줄인다.

## 완료 조건

| 상황 | 기대 결과 |
| --- | --- |
| 서브 페이지 설명을 편집한다 | 커서의 위아래 위치가 고정 표시 글자의 14px/20px 줄 상자와 일치한다. |
| 일반 블릿의 설명을 편집한다 | 커서가 고정 표시 글자와 같은 줄 상자에 있고 포커스 밑줄은 나타나지 않는다. |
| 일반 블릿에 설명이 표시된다 | 제목줄과 설명 사이의 상단 간격이 기존 2px보다 2px 가까워진다. |
| 일반 블릿 제목을 편집한다 | 기존 native textarea 기준선 보정과 포커스 동작이 그대로 유지된다. |

## 원인

`NoteTextField`의 고정 표시 모드는 편집 중에도 `NoteTokenText` 표시층으로
글자를 그린다. 입력용 textarea의 글자는 투명하지만 커서는 계속 표시된다.
그런데 textarea에는 표시층과 편집층을 교체하던 이전 구조를 위한
`--notes-text-edit-offset: -1px` 보정이 여전히 적용된다. 따라서 표시층의
글자는 제자리에 있고 커서만 1px 위로 이동한다.

일반 블릿 설명의 컨테이너인 `.notes-node-note-field`에는 제목줄 다음에
`2px` 상단 margin이 지정되어 있어 사용자가 원하는 것보다 설명이 더
떨어져 보인다.

## 접근 비교

1. **고정 표시 필드에만 textarea transform을 해제한다 — 채택.** 기존 보정이
   필요한 일반 편집 필드는 유지하면서, 표시층과 커서를 같은 줄 상자에 둔다.
2. 모든 Notes textarea의 보정을 제거한다. 일반 블릿 제목에서 이전 기준선
   회귀가 발생할 수 있어 제외한다.
3. 서브 페이지 설명에만 별도 보정을 둔다. 같은 고정 표시 구조를 사용하는
   항목 설명에 문제가 남을 수 있어 제외한다.

## 설계

- `data-stable-presentation="true"`인 `.notes-text-field`의 직접 textarea에는
  `transform: none`을 적용한다.
- 일반 `.notes-text-field > textarea` 및 `.notes-node-title-field > textarea`의
  기존 보정은 유지한다.
- `.notes-node-note-field`의 상단 margin을 `2px`에서 `0`으로 줄이고 아래쪽
  `8px`과 왼쪽 들여쓰기는 유지한다.
- 컴포넌트 이벤트, 입력값, IME, selection, 저장, Undo/Redo 경로는 변경하지
  않는다.

## 테스트 전략

production CSS를 변경하기 전에 스타일 계약 테스트를 먼저 수정해 다음 두
조건이 RED인지 확인한다.

1. 고정 표시 필드의 textarea가 기존 transform을 명시적으로 해제한다.
2. 일반 블릿 설명의 margin은 `0 0 8px ...`이다.

최소 CSS 변경 후 소유 테스트를 GREEN으로 만들고, 새 Tauri 앱에서 서브
페이지 설명과 일반 블릿 설명의 커서 위치 및 제목-설명 간격을 확인한다.
프런트엔드만 변경하므로 최종 게이트는 `npm test`, `npm run lint`,
`npm run build`, `git diff --check`다. Rust, IPC, persistence 및 native
configuration 검증은 범위에서 제외한다.

## 비대상

- 글자 크기, 줄 높이, 색상 또는 포커스 밑줄 정책 변경
- 일반 블릿 제목의 textarea 보정 변경
- 페이지 제목과 페이지 설명 사이의 간격 변경
- 저장 데이터, Undo/Redo, Enter 또는 Shift+Enter 동작 변경
- React, IPC, Rust, SQLite, filesystem 또는 native configuration 변경

## 직접 확인

새로 빌드한 Tauri 앱에서 다음을 확인한다.

1. 서브 페이지 설명 끝과 중간에 커서를 놓아 글자 줄 상자와 맞는지 본다.
2. 일반 블릿 설명을 편집하고 포커스를 해제해 커서 외의 글자 위치가 유지되는지 본다.
3. 일반 블릿 제목과 설명 사이의 간격이 이전보다 2px 가까운지 본다.
4. 일반 블릿 제목 편집의 기존 기준선과 한글 입력이 유지되는지 확인한다.
