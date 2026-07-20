# 블릿 메뉴 단축키 표시 설계

## 목표

블릿의 더보기 메뉴에서 실제 키보드 단축키가 있는 명령은 메뉴 이름 오른쪽에
단축키를 함께 표시한다. 사용자는 메뉴를 열어 현재 환경에서 사용할 수 있는
단축키를 바로 학습할 수 있어야 한다.

## 완료 조건

- 일반 블릿 메뉴에는 다음 단축키를 표시한다.
  - Complete / Uncomplete: macOS `⌘↵`, 그 외 `Ctrl+Enter`
  - Add note / Edit note: macOS `⇧↵`, 그 외 `Shift+Enter`
  - Duplicate: macOS `⌘⇧D`, 그 외 `Alt+Shift+D`
  - Delete: macOS `⌘⇧⌫`, 그 외 `Ctrl+Shift+Backspace`
- 다중 선택 메뉴에는 다음 단축키를 표시한다.
  - Complete / Uncomplete: macOS `⌘↵`, 그 외 `Ctrl+Enter`
  - Move up / Move down: macOS `⌘⇧↑` / `⌘⇧↓`, 그 외
    `Ctrl+Shift+ArrowUp` / `Ctrl+Shift+ArrowDown`
  - Indent / Outdent: `Tab` / macOS `⇧Tab`, 그 외 `Shift+Tab`
  - Duplicate: macOS `⌘⇧D`, 그 외 `Alt+Shift+D`
  - Copy / Cut: macOS `⌘C` / `⌘X`, 그 외 `Ctrl+C` / `Ctrl+X`
  - Delete: macOS `⌘⇧⌫`, 그 외 `Ctrl+Shift+Backspace`
- 단축키는 메뉴의 세 번째 열에 오른쪽 정렬하고, 메뉴 이름과 겹치지 않는다.
- 비활성 명령도 사용자가 단축키를 학습할 수 있도록 단축키를 계속 표시한다.
- 기존 메뉴 이름은 보조기기에서 그대로 읽히며, 메뉴 항목에는 표준
  `aria-keyshortcuts` 정보가 제공된다.
- 실제 단축키가 없는 명령에는 단축키를 표시하지 않는다.

## 비대상

- 새로운 키보드 단축키를 추가하거나 기존 단축키 동작을 변경하는 일
- Move To, Tags, Star, Add date, Upload image, 정렬, 펼치기, 내보내기 등
  단축키가 없는 명령에 임의의 키를 할당하는 일
- Trash, Archive, Export 하위 메뉴의 동작이나 표시 변경
- IPC, Rust, SQLite, 파일시스템, macOS 네이티브 설정 변경

## 설계

`outlineKeyboard`가 이미 사용하는 플랫폼 판별 함수를 재사용해 macOS와 그 외
환경의 표시 문자열 및 `aria-keyshortcuts` 값을 한 곳에서 만든다. 메뉴 항목
공통 컴포넌트인 `CommandItem`은 선택적인 단축키 정보를 받아 세 번째 열에
별도 요소로 렌더링한다.

화면용 단축키 문자열은 macOS에서 익숙한 기호를 사용하고, 다른 플랫폼에서는
`Ctrl`, `Alt`, `Shift` 이름을 사용한다. 보조기기용 값은 `Meta+Enter`,
`Control+Shift+Backspace`처럼 표준 키 이름을 사용한다. 화면용 문자열은
`aria-hidden="true"`로 두어 `Complete` 같은 기존 메뉴 접근성 이름에 단축키가
중복으로 붙지 않게 한다.

CSS 가상 요소나 메뉴 이름 문자열에 단축키를 직접 합치는 방식은 사용하지
않는다. 전자는 접근성 정보와 테스트가 약하고, 후자는 메뉴 이름 자체를 바꿔
기존 탐색과 테스트를 깨뜨리기 때문이다.

## 영향 범위

- React: `NotesBulletMenu`의 플랫폼별 단축키 매핑과 `CommandItem` 표시
- CSS: 단축키 열의 크기, 색상, 정렬
- Tests: 일반 블릿 및 다중 선택 메뉴의 macOS/비-macOS 표시와 접근성
- IPC, Rust, SQLite, 파일시스템, 네이티브 설정: 변경 없음

## 검증

1. macOS 플랫폼에서 일반 메뉴의 Complete, Add/Edit note, Duplicate, Delete에
   기호형 단축키와 올바른 `aria-keyshortcuts`가 있는지 확인한다.
2. 다중 선택 메뉴에서 이동, 들여쓰기, 복사/잘라내기를 포함한 실제 단축키가
   모두 표시되는지 확인한다.
3. 비-macOS 플랫폼에서 `Ctrl`/`Alt` 기반 표기가 나오는지 확인한다.
4. 단축키가 없는 메뉴 항목에는 단축키 속성이나 표시 요소가 없는지 확인한다.
5. 실제 격리 앱에서 단축키가 오른쪽에 정렬되고 이름과 겹치지 않는지 확인한다.
6. 프론트엔드 전체 테스트, lint, build, diff 검사를 실행한다.
