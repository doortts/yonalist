# Monaco 아웃라인 노트·이미지 지원 개발 계획

- 작성: 2026-08-06, Fable 5 (설계·리뷰 담당)
- 실행 체제: 설계 문서·TDD 테스트 설계·적대적 리뷰·재작업 지시는 Fable 5,
  코드 작성과 위임 작업은 Opus 5
- 기준 스펙: 레거시 제품 동작
  ([2026-07-11 interactions design](../specs/2026-07-11-workflowy-notes-interactions-design.md),
  [parity matrix](../../v2/feature-parity-matrix.md))와 v2 React 표면의
  기존 구현(oracle 테스트)

## 1. 목표

설명(노트)과 이미지를 **Monaco 표면에서 직접** 지원해서, 이 두 기능 때문에
발생하던 React 폴백을 없앤다. 완료 판정: 노트·이미지가 섞인 페이지가
Monaco로 열리고, 레거시 계약(아래 인벤토리)이 Monaco 위에서 전부 성립한다.

**비목표(이번 범위 아님):**

- 50,000노드 초과 페이지의 partial-viewport 폴백. 이건 점진 로딩 설계가
  필요한 별개 작업이라 이번 범위에서 제외하고 폴백을 유지한다.
- 이미지 백엔드 재작업. v2 백엔드(서명·MIME·바이트·픽셀 검증, 내용 주소
  자산 저장, resize/replace IPC)는 이미 완성돼 있고 그대로 재사용한다.
- 태그·날짜·슬래시 명령(별도 계획), 드래그/다중 선택(별도 계획).

## 2. 요구사항 인벤토리 (레거시 계약)

### 2a. 설명(노트)

| # | 계약 | 근거 |
|---|---|---|
| N1 | 제목에서 `Shift+Enter` → 노트가 나타나고 포커스 이동 | interactions spec §Supporting note, `outlineKeyboard.ts` focusNote |
| N2 | 노트는 노드가 소유한 평문. 제목 아래에 흐린 스타일로 렌더, 내용에 따라 높이 증가 | spec §Supporting note |
| N3 | 노트 안 `ArrowUp`(첫 줄) → 제목으로, 제목 `ArrowDown`(마지막 줄) → 노트로 | parity matrix "Shift+Enter and arrow navigation" |
| N4 | 빈 노트에서 Backspace → 노트 제거, 제목 끝으로 캐럿 복귀 | v2 React 동작 |
| N5 | 노트 텍스트 변경은 draft coalescing(300ms/blur) 후 저장, undo 가능 | spec §Persistence·Undo |
| N6 | 부모 접기 시 노트도 함께 숨김. 완료 숨김도 동일 | v2 React 동작 |
| N7 | 노트에는 불릿·셰브론 없음. 인덴트는 제목 본문에 정렬 | v2 CSS `notes-node-note-field` |

### 2b. 이미지

| # | 계약 | 근거 |
|---|---|---|
| I1 | PNG/JPEG/WebP/GIF를 픽커·클립보드·파일 드롭으로 삽입. SVG 제외 | spec §Images |
| I2 | 다중 이미지 원자적 임포트(검증 통과분 전체가 한 커밋) | matrix "Image nodes" |
| I3 | 이미지는 독립 노드 행. 기본 폭 = min(원본 폭, 콘텐츠 폭, 뷰포트), 작은 이미지 확대 금지 | spec §Images |
| I4 | hover/focus 시 리사이즈 핸들. 폭만 변경, 비율 유지, 커밋은 포인터 릴리스 시 1회 = undo 1단계. 폭 영속화 | spec §Images |
| I5 | 클릭 시 라이트박스 확대 | v2 `ImageLightbox` |
| I6 | 노드 삭제 후에도 undo/휴지통 복원이 가능한 동안 바이트 보존. 정리는 close 시 reconcile | spec §Images |
| I7 | 캡션(대체 텍스트) 편집 — 이미지 행의 텍스트 편집 | matrix "Image atom editor" (v2에서 partial) |
| I8 | Blob URL 수명 제한(가시 행만 로드, v2 기준 최대 8개) | performance.md 이미지 항목 |

주의: I7의 레거시 "image atom editor"(본문 중간 원자 삽입, IME 보호,
원자 잘라내기)는 레거시에서도 가장 복잡한 계층이고 v2 React도 partial이다.
이번 계획은 **v2 React가 이미 지원하는 수준**(독립 이미지 행 + 캡션 편집)을
기준으로 하고, 원자 수준 계약의 초과분은 명시적으로 이월한다.

## 3. 아키텍처 설계 개요

상세 설계는 Phase 0 산출물에서 확정한다. 계획 수립 시점의 방향:

### 3a. 모델 매핑 — line kind 확장

현재 불변식 "모델 한 줄 = 텍스트 불릿 하나"를
`OutlineLineMetadata.kind: "text" | "note" | "image"`로 확장한다.

```
· 제목 텍스트          ← kind "text"   (기존)
  노트 내용이 이 줄에   ← kind "note"   (같은 nodeId, 제목 줄 바로 다음)
· [이미지]  캡션 텍스트 ← kind "image"  (이미지 노드의 캡션이 모델 텍스트)
```

- 노트 줄: 같은 nodeId의 두 번째 줄. 모델 텍스트 = note 내용(줄바꿈은
  Monaco wrapping으로 표현, 저장은 단일 문자열). preorder 검증 확장:
  "note 줄은 자신의 text 줄 바로 뒤에만 온다".
- 이미지 줄: 모델 텍스트 = 캡션. 실제 이미지는 그 줄 위의 **view zone**
  (공개 API `changeViewZones`)으로 렌더 — internalAdapter 추가 불필요.
- 기존 3층 합성 불변식(문서 app-structure.md §설계 불변식)은 그대로 유지:
  kind가 늘어나도 동기화 지점은 `handleMetadataChange` 하나다.

### 3b. 영속화

- `IpcEditorCommand`에 `updateNote { id, note }` 추가(레시피는 setCollapsed와
  동일: contracts.rs → conversion → ts-rs 재생성). 노트 텍스트도 세션 소유
  배치로 coalescing.
- 이미지 ingest/replace/resize는 **기존 이미지 IPC 재사용**. 단, 세션 소유
  배치와 별개 쓰기 경로이므로 **단일 기록자 규칙**을 설계로 강제한다:
  이미지 IPC 호출 전 세션 큐 flush → 완료 후 리비전 동기화 → 세션 메타데이터
  재하이드레이션(변경 노드만). Phase 0에서 이 시퀀스를 확정하고 실패
  케이스(충돌·중복 요청)를 테이블로 명세한다.

### 3c. 편집 규칙 (kind 인지)

| 입력 | text 줄 | note 줄 | image 줄 |
|---|---|---|---|
| Enter | 기존 분할 규칙 | 저지 또는 노트 내 줄바꿈(Phase 0에서 레거시 확인 후 확정) | 아래에 새 형제 불릿 |
| Shift+Enter | 노트 줄 생성/포커스 | — | 캡션에서도 동일 여부 Phase 0 확정 |
| Tab/Shift+Tab | 기존 | 저지(노트는 구조 없음) | 노드 단위로 동작 |
| Backspace(빈 줄, 1열) | 기존 병합 | 노트 제거 → 제목 끝 | 노드 삭제 확인 흐름 |
| 분할/병합 계획 | 기존 | text↔note 경계 병합 금지 | image 줄은 병합·분할 금지 |

### 3d. 게이팅 축소

- `storeMonaco.assertPageSupported`: rich-node 거부 삭제, partial-viewport만
  유지.
- `NotesOutline` useMonaco 술어: note/image 검사 삭제.
- 폴백 안내 문서·parity matrix 갱신.

## 4. 단계별 계획

각 Phase는 worktree 격리, 항목당 1커밋, 게이트(tsc 0 · eslint 0 · vitest
전체 green · cargo test · 계약 동기화 PASS) 통과 후 다음 단계로 간다.
구현 커밋은 Opus 5, 설계·테스트 설계·리뷰는 Fable 5.

### Phase 0 — 상세 설계 문서 (Fable 5)

산출물: `docs/superpowers/specs/2026-08-06-monaco-notes-images-design.md`

- 노트 줄바꿈 정책 확정(레거시 노트의 Enter 동작 실측 후)
- metadata 불변식 전체 표(“note는 text 바로 뒤” 포함), 분할·병합 규칙
  케이스 표(§3c의 미정 항목 확정)
- 이미지 IPC↔세션 큐 직렬화 시퀀스 다이어그램 + 실패 케이스 표
- view zone 수명 규칙(스크롤 윈도잉, blob 8개 상한을 Monaco에서 지키는 방법)
- 성능 예산: 5,000노드 + 노트/이미지 혼합 픽스처에서 기존 게이트 유지
  (전체 모델 교체 0회, 편집당 데코레이션 ≤ 3줄, view zone 재계산은 가시
  범위 한정)

### Phase 1 — 노트 데이터 계층 (Opus 5 구현)

테스트 먼저(TDD), Fable 5가 테스트 목록을 리뷰 후 구현 착수:

- `metadata.test`: note kind 스냅샷 검증 — note가 text 바로 뒤가 아니면
  throw / note 줄은 preorder 부모 체인에 불참
- `structuralChanges.test`: note 줄 텍스트 편집 → `updateNote` 커맨드 /
  text↔note 경계 Backspace 저지 / note 줄 Enter 정책(Phase 0 확정안)
- `session.test`: 노트 있는 페이지 하이드레이션(줄 수·kind 배열) /
  노트 생성·제거가 undo 1단계
- Rust: `updateNote` variant 추가 + conversion 단위 테스트, 계약 재생성

### Phase 2 — 노트 UI (Opus 5 구현)

- `plugin.test`: Shift+Enter 라우팅(노트 생성/포커스), 노트 첫 줄 ↑ →
  제목, 제목 마지막 줄 ↓ → 노트
- `decorations.test`: note 줄에 불릿·셰브론 없음, note 스타일 클래스
- `paneAdapter.test`: 접기/완료 숨김 범위에 note 줄 포함, 캐럿 재정렬이
  note 줄에서도 동작
- CSS: `notes-node-note-field`와 동일 토큰(흐린 색, 제목 본문 정렬)

### Phase 3 — 이미지 노드 표시 (Opus 5 구현)

- image kind 하이드레이션 + view zone 생성/폐기(가시 윈도 연동) 테스트
- 폭 규칙(I3) 계산 단위 테스트, blob 수명(I8) 테스트
- 리사이즈: 기존 resize IPC 재사용, 릴리스 시 1커밋=1 undo 테스트
- 라이트박스: 기존 `ImageLightbox` 재사용 배선

### Phase 4 — 이미지 편집 흐름 (Opus 5 구현)

- 캡션 편집 → 기존 updateText 경로(이미지 노드 텍스트) 테스트
- ingest 3경로(픽커·클립보드·드롭) → flush→IPC→재하이드레이션 시퀀스
  테스트(성공/리비전 충돌/검증 실패)
- 삭제·undo·휴지통 복원 시 view zone 정합 테스트

### Phase 5 — 게이팅 제거 + 통합 (Opus 5 구현)

- `storeMonaco.test`: rich-node 페이지 허용, partial-viewport만 거부
- 통합 테스트: 노트+이미지 혼합 페이지가 Monaco로 열리고 N1~N7·I1~I8
  계약 시나리오 통과
- 성능: 혼합 5,000노드 픽스처로 기존 perf 게이트 재실행
- 문서: parity matrix, app-structure.md, 폴백 안내 갱신

### Phase 6 — 적대적 리뷰 및 재작업 (Fable 5)

- Phase 1~5 결과물에 대해 계약 표(N·I) 기준 반례 탐색 리뷰: IME 조합 중
  Shift+Enter, 접힌 부모 안의 노트, 이미지 줄에서의 전체 선택 삭제,
  분할 페인 동시 편집, ingest 중 세션 충돌
- 발견 항목은 재작업 지시서로 Opus 5에 위임, 게이트 재통과까지 반복

## 5. 리스크와 완화

| 리스크 | 완화 |
|---|---|
| 노트 다중 줄 표현이 "한 줄=한 노드" 가정을 곳곳에서 깨뜨림 | Phase 1에서 `lineByNodeId`를 `titleLineByNodeId`로 의미 명확화하고 전 사용처 스윕. 테스트로 고정 |
| 이미지 IPC와 세션 배치의 리비전 경합 | Phase 0 직렬화 설계 + Phase 4 충돌 주입 테스트. 원칙: 페이지당 기록자는 항상 하나 |
| view zone 높이와 hidden area 상호작용(접기 시 이미지 잔상) | paneAdapter 동기화 지점에서 zone 재계산. Phase 3 테스트에 접기 케이스 포함 |
| 성능 퇴행(줄 수 증가: 노트·이미지로 5k 노드 > 5k 줄) | 기존 perf 게이트를 혼합 픽스처로 확장, 편집당 O(전체 줄) 작업 추가 금지 |
| 캐럿 재정렬·stickiness 계열 회귀 | app-structure.md 불변식 4종을 리뷰 체크리스트로 사용 |

## 6. 진행 규칙

- 브랜치: `feature/monaco-notes-images`, Phase별 worktree 격리 병렬화는
  파일 충돌이 없는 Phase 3(이미지 표시)과 Phase 2(노트 UI)에만 허용.
  Phase 1은 공유 기반이라 단독 선행.
- 커밋 규약: conventional commits, 항목당 1커밋.
- 각 Phase 종료 시 이 문서의 해당 절에 결과(커밋 해시, 게이트 수치)를
  기록한다.
