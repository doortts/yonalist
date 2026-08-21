# 아이콘 세트

2026-08-21 확정. 이 문서가 아이콘 출처의 단일 기준이고,
`docs/superpowers/specs/2026-07-16-graphite-mist-whole-app-redesign-design.md`의
"all icons continue to come from `lucide-react`"를 대체한다.

## 순서

1. **Tabler Icons** — 1순위. 새 아이콘은 여기서 고른다.
2. **lucide-react** — Tabler에 맞는 글리프가 없을 때만. 이미 lucide를 쓰고 있는
   기존 화면은 그대로 두고, 손대는 김에 굳이 바꾸지 않는다.

세 번째 세트는 없다. 둘 다 24×24 그리드에 stroke 2, round cap/join이라 한 화면에
섞여도 획 굵기가 어긋나지 않는다. 다른 그리드나 다른 획 규칙을 쓰는 세트를 넣으면
그 정렬이 깨지므로 추가하지 않는다.

## 라이선스

| 세트 | 라이선스 | 저작권 |
|---|---|---|
| Tabler Icons | MIT | Copyright (c) 2020-2026 Paweł Kuna |
| lucide-react | ISC | Lucide Contributors |

둘 다 상업적 사용에 제약이 없고 별도 표기 의무 문구도 없다. 다만 MIT와 ISC 모두
배포물에 저작권 고지와 라이선스 전문을 남기라고 요구한다.

**아직 안 지키고 있다.** 저장소에 서드파티 고지 파일이 하나도 없어서 lucide(ISC)
쪽도 이미 같은 상태다. Tabler가 새로 만든 문제가 아니라 원래 있던 구멍이고,
스토어에 올리기 전에 닫아야 한다 — 앱 번들에 들어가는 고지 화면이든 파일이든
한 곳이면 된다. 이건 별도 항목으로 잡는다.

## 패키지

React에서는 `@tabler/icons-react`를 쓴다(`<IconCalendarEvent size={16} />`).
아이콘 이름은 Tabler 웹사이트의 kebab-case 이름을 파스칼로 바꾼 것이다:
`calendar-event` → `IconCalendarEvent`.

## 데스크톱 개념 ↔ 아이콘

지금 데스크톱이 lucide로 쓰고 있는 자리와, 같은 개념을 iOS에서 Tabler로 그릴 때
고른 이름이다. 두 앱이 같은 개념에 다른 그림을 쓰지 않게 여기서 맞춘다.

| 개념 | 데스크톱 (lucide, 현행) | Tabler (신규·iOS) |
|---|---|---|
| Today | `CalendarDays` | `calendar-event` |
| Journals | `NotebookText` | `notebook` |
| 페이지 | `FileText` | `file-text` |
| 모든 페이지 | `House` | `home` |
| 검색 | `Search` | `search` |
| 즐겨찾기 | `Star` | `star` |
| 행 메뉴 | `MoreHorizontal` | `dots` |
| 이어받기 | `ArrowDownToLine` | `arrow-bar-to-down` |
| 앞뒤 날짜 | `ChevronLeft` / `ChevronRight` | `chevron-left` / `chevron-right` |
| 완료 표시 | `Check` | `check` |
| 동기화 경고 | `TriangleAlert` | `alert-triangle` |
| 새로 만들기 | `Plus` | `plus` |
| To-do 전환 | `SquareCheckBig` | `square-check` |
| 태그 | `Tags` | `tag` |
| 들여쓰기 / 내어쓰기 | (단축키만, 아이콘 없음) | `indent-increase` / `indent-decrease` |
| 키보드 내리기 | (해당 없음) | `keyboard-hide` |
| iCloud | (해당 없음) | `cloud` |
