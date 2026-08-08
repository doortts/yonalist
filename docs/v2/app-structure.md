# Yonalist v2 앱 구조 (Monaco 아웃라인 기준)

2026-08-08 기준. Monaco 아웃라인이 기본 표면이고, 노트·이미지까지 그 위에서
그리게 된 시점의 구조 문서다.
계층별 의존 방향과 데이터베이스 상세는 [architecture.md](architecture.md)가
원본이고, 이 문서는 프런트엔드 구성과 Monaco 서브시스템의 설계 불변식을
설명한다.

## 전체 계층

```
notes-core (Rust)          트리 불변식, 가역 커맨드/패치. 플랫폼 의존성 없음
  ↑
notes-application (Rust)   IPC 계약(DTO), 세션·리비전·히스토리 권한, 스토리지 포트
  ↑
notes-sqlite (Rust)        스키마, DB 워커 스레드, FTS, 이미지 자산, 온보딩 시드
  ↑
apps/desktop/src-tauri     고정 커맨드 API, 앱 수명주기, 데이터 삭제 마커
  ↑ (ts-rs 생성 계약: packages/contracts/generated)
apps/desktop/src           React 셸 + 두 개의 아웃라인 표면
```

TypeScript 계약은 전부 `cargo test -p notes-application export_bindings`로
생성한다. `packages/contracts/generated`는 손으로 고치지 않는다.

## 프런트엔드 셸

- `App.tsx` — 부트스트랩, 사이드바(라이브러리·검색·Settings), 테마 적용
  (`useTheme` → `:root[data-theme]`), 디테일 영역 전환(Settings ↔ 노트 페인).
- `NotesDetailPanes` → `NotesOutline` — 페이지 하나를 그리는 진입점.
- 아웃라인 표면 선택은 `outlineSurface.ts` 한 곳에서 한다. 기본은 Monaco,
  `?outline=react`로만 React 표면을 강제한다. 페이지 내용은 더 이상 표면을
  가르지 않는다. 노트도 이미지도 Monaco가 그린다. 남은 자동 폴백은
  뷰포트 쿼리 한 번으로 다 못 읽는 페이지 하나뿐이다(아래 알려진 제약).
  이 폴백이 살아 있는 동안 React 아웃라인 계열 코드는 삭제하면 안 된다.

## Monaco 아웃라인 서브시스템 (apps/desktop/src/monaco-outline)

한 페이지 = Monaco 모델 하나. 설계의 핵심은 **한 줄의 화면 표시가 세
레이어의 합성**이라는 점이다.

1. **모델 텍스트** — 각 줄은 불릿의 본문 텍스트만 담는다. 들여쓰기도
   마커도 텍스트에 넣지 않는다.
2. **메타데이터** — `OutlineLineMetadata[]`가 줄 번호와 1:1로 대응하며
   nodeId·parentId·depth·kind·collapsed·completed를 담는다.
   `OutlineMetadataTimeline`이 Monaco의 `alternativeVersionId`별 스냅샷을
   보관해서 네이티브 undo/redo와 같이 되감긴다.
3. **주입 렌더링** — `decorations.ts`가 줄마다 decoration 하나를 만들고,
   `before` 주입 텍스트에 인덴트+셰브론, `after`에 불릿을 넣는다(같은
   위치에서 before가 after보다 먼저 그려지는 Monaco 정렬 규칙에 의존).
   글리프 문자는 투명 처리하고 CSS 가상요소가 실제 점·아이콘을 그린다.

### 줄 kind — 한 노드가 여러 줄일 수 있다

`kind`는 `"text" | "note" | "image"`다. 노트는 줄바꿈을 담을 수 있으므로
`note.split("\n")` 개수만큼 연속된 note 줄로 펼치고, 그 줄들은 제목 줄의
nodeId·parentId·depth를 그대로 복제한다. 저장할 때 run 전체를 다시 합쳐
`updateNote` 하나로 보낸다. 이미지 노드는 캡션이 모델 텍스트인 image 줄
하나이고 그림 자체는 캡션 줄 위의 view zone이 그린다. 그래서
`lineByNodeId`는 `titleLineByNodeId`(제목 줄)로 의미를 좁혔고 note 줄
조회는 `noteRangeByNodeId`가 맡는다. "한 줄 = 한 노드"를 가정한 코드가
남아 있으면 여기서 깨진다.

### 외부 undo 스텝 — 에디터 배치가 표현 못 하는 되돌리기

이미지 생성의 역연산은 서브트리 삭제다. `IpcEditorCommand`에는 그런
커맨드가 없으므로 세션 전이가 **external step**을 함께 들고 있다: Monaco의
Undo가 줄을 되돌리고 그 스텝이 `deleteSubtrees`를 스토어로 보낸다. Redo는
`restoreSubtree`로 휴지통에서 꺼낸다(바이트가 살아 있는 경로가 이것이라
계약 I6이 성립한다). 이미지 IPC는 세션 배치와 별개 기록자이므로 제스처마다
`flush` → IPC → 영수증으로 줄 삽입 순서를 지킨다. 페이지의 기록자는 항상
하나여야 해서 드롭도 픽커도 붙여넣기도 전부 이 경로로 들어온다.

### 파일 책임

| 파일 | 책임 |
|---|---|
| `session.ts` | 세션 소유자. 하이드레이션, 콘텐츠 이벤트 해석, indent/outdent/접기/완료 같은 메타데이터 편집, undo 전이 기록, 영속화 큐 공급 |
| `metadata.ts` | 줄 메타데이터 스냅샷/타임라인 + **preorder 검증**(부모는 항상 화면상 앞에, depth는 한 번에 1만 증가) |
| `structuralChanges.ts` | Monaco 콘텐츠 변경 이벤트 → 텍스트/구조 편집 해석, 경계 편집 허용 판정 |
| `structuralReplacement.ts` | 분할·병합·치환 계획. 자식 있는 노드의 Enter/Backspace 의미론(자식 입양, 형제 승격)이 여기 있다 |
| `paneAdapter.ts` | 페인(뷰) 소유자. hidden areas(줌·접기·완료 숨김), decoration 윈도, **동기화 지점**(아래) |
| `plugin.ts` | 에디터 바인딩: Tab/Shift+Tab/⌘Enter 커맨드, 차단 게이트, 불릿·셰브론 클릭 라우팅 |
| `decorations.ts` + `decorationWindow.ts` | 주입 텍스트 생성(가시 범위 ± 한 화면 윈도잉) |
| `internalAdapter.ts` | 핀 고정된 Monaco 내부 API의 유일한 통로(hidden areas, 메타데이터 undo, 커서 뷰 상태 재작성). Monaco 업그레이드 시 여기만 본다 |
| `persistenceQueue.ts` | 에디터 배치 직렬화, 충돌/치명 상태 관리 |
| `sessionRegistry.ts` / `lazyRegistry.ts` / `runtimeLoader.ts` | 페이지별 세션 공유(1페이지 1세션), Monaco 번들 지연 로딩 |

### 편집 흐름

```
키 입력 → Monaco 네이티브 편집 → onDidChangeContent
  → interpretModelChanges: 텍스트 전용이면 updateText, 구조면 분할/병합 계획
  → 메타데이터 스냅샷 기록(preorder 검증) + forward/inverse 커맨드 생성
  → persistenceQueue가 IpcEditorCommand 배치로 세션 소유 실행
```

메타데이터 전용 편집(indent/outdent/접기/완료)은 모델 텍스트를 건드리지
않고 `applyMetadataEdit`로 간다: 타임라인 재기록 + Monaco undo 스택에
메타데이터 undo 요소 등록 + 커맨드 배치 큐잉이 한 단위다.

### 설계 불변식 — 어긋남 버그의 재발 방지

이 서브시스템에서 반복됐던 버그(커서가 불릿 앞에 그려짐, 글리프 겹침)는
전부 "세 레이어 중 하나만 갱신되는 경로"에서 나왔다. 지금 강제되는 규칙:

1. **preorder 검증이 최후 방어선.** 모든 구조 편집 계획은 스냅샷 기록
   시점에 `validateOutlineMetadata`를 통과해야 한다. 통과 못 하면 그
   제스처는 기획이 잘못된 것이다 — 검증을 느슨하게 풀지 말 것.
2. **캐럿 재정렬은 단일 연산.** 모델 1열의 캐럿은 뷰에서 주입 텍스트
   앞/뒤 두 위치가 가능하고 Monaco 기본값은 '앞'이다.
   `realignCaretWithInjectedText`가 유일한 교정 수단이고, 커서 이벤트
   리스너와 `paneAdapter.handleMetadataChange`(구조 변경), 줌 전환이
   모두 이 함수를 호출한다. **주입 prefix 길이에 영향을 주는 새 기능은
   반드시 handleMetadataChange를 지나가게 만들면 자동으로 커버된다.**
3. **decoration 앵커는 `GrowsOnlyWhenTypingBefore`.** 1열의 빈 앵커가
   타이핑에 밀리지 않는 유일한 stickiness다. 바꾸면 불릿이 글자 뒤로
   밀리는 버그가 재발한다.
4. **CSS 층위 규칙.** Monaco 토큰 기본색은
   `.notes-monaco-outline .monaco-editor :where(.mtk1)` — `:where`로
   명시도를 낮춘 기본층이다. 주입 스팬(셰브론·불릿·완료줄)을 만지는
   규칙은 반드시 `.monaco-editor`를 포함해 (0,3,0) 이상으로 쓴다.
   동률이면 파일 순서가 승패를 갈라 재발한다.

## 영속화 경로 두 갈래

| 경로 | 커맨드 계약 | 쓰는 쪽 |
|---|---|---|
| 세션 소유 에디터 배치 | `IpcEditorCommand` (createNode, updateText, splitNode, mergeNodeBackward, removeEmptyNode, moveNode, indent, outdent, setCollapsed, setCompleted) | Monaco 세션. 히스토리는 프런트(Monaco undo)가 소유 |
| 일반 노트 커맨드 | `IpcNotesCommand` | React 표면, 라이브러리 작업(별표·보관·삭제 등). 히스토리는 Rust 세션이 소유 |

Monaco에 새 제스처를 붙일 때 백엔드 변경이 필요하면 순서는 항상:
`contracts.rs`에 variant 추가 → `command_conversion.rs` 매핑 →
`TS_RS_EXPORT_DIR=packages/contracts/generated cargo test -p notes-application export_bindings`
→ 프런트 사용. 실행 중인 앱과 계약이 어긋나면 invoke가 문자열로 거절되고
프런트에는 generic 오류("Notes could not complete the request.")만 보인다.

## 첫 실행과 설정

- **온보딩 시드**: `notes-sqlite/src/seed.rs`. 파일 DB가 비어 있고
  `notes_ui_state`에 마커가 없을 때만 "Yonalist 시작하기" 페이지를 심는다.
  인메모리 DB(테스트)는 시드하지 않는다.
- **Settings**: `SettingsView.tsx`. Appearance(테마 모드+변형,
  localStorage 저장)와 Yonalist data(미사용 자산 정리, 전체 삭제).
  전체 삭제는 데이터 디렉터리에 마커 파일을 쓰고 앱을 재시작하며, 다음
  부팅에서 스토리지를 열기 전에 `apply_pending_data_deletion`이 처리한다
  — WAL이 열린 채 DB 파일을 지우지 않기 위한 구조다.

## 알려진 제약 (다음 설계 대상)

- 노트와 이미지 노드는 Monaco에서 지원한다. 아직 없는 것은 Todo 마커,
  태그·날짜 하이라이트, 이미지 행 메뉴(교체·원본 보기·다운로드·삭제),
  키보드 리사이즈, 그리고 본문 중간 이미지 원자다. 앞의 둘은 별도 계획이고
  뒤의 셋은 Monaco 노트·이미지 계획이 명시적으로 이월했다.
- 휴지통/복제/행 이동 단축키와 불릿 드래그는 `IpcEditorCommand`에
  해당 커맨드(deleteSubtree, duplicate 계열)를 추가한 뒤 붙인다.
- **자동 폴백은 이제 partial-viewport 하나뿐이다.** Monaco 로드는 50,000노드
  단일 뷰포트 쿼리를 전제하므로(`storeMonaco.ts`) 그보다 큰 페이지는 React
  표면으로 내려간다. React 아웃라인을 지우려면 점진 로딩을 설계하거나 50k를
  제품 상한으로 못박아야 한다.
