# Monaco 아웃라인 기능 패리티 구현 설계

> **상태(2026-08-12): 미착수로 종료.** Monaco 표면은 main에서 걷어냈고
> `apps/desktop/src/monaco-outline/`도 지금은 없다. 6개 단계 중 착수한 것은 없다.
> 아래 내용은 그때의 조사와 설계를 남긴 기록이다. 실행 계획으로 읽지 말 것.

작성일: 2026-08-05. 대상: 당시 main의 Monaco 기본 표면(`apps/desktop/src/monaco-outline/`).
근거 조사: 레거시 v1(`src/features/notes/`) 대비 기능 격차표(2026-08-05 조사),
[monaco-outline-spike-report.md](../../v2/monaco-outline-spike-report.md) 행동 매트릭스와 후속 우선순위.

## 1. 목적과 범위

레거시 v1 노트의 기본 블릿 동작을 Monaco 표면에서 동일하게 쓸 수 있게 한다.
이 문서는 6개 단계(Stage 1a–6)를 다룬다. 각 단계는 단독으로 실행·검증 가능한
수직 조각이며, 끝날 때마다 사용자가 앱을 켜서 눈으로 확인할 수 있는 결과를 남긴다.

범위 밖 (후속 설계 문서로 분리):

- Drag & drop 재배치(크로스 페인 포함) — 멀티 선택(Stage 4) 완료 후 별도 설계
- 노트(설명)·이미지 노드의 Monaco 인라인 렌더(view zone/overlay widget) — 그때까지
  rich 페이지의 React fallback은 설계 의도대로 유지
- v2 앱 자체에 없는 기능(날짜 피커, Quick jump, 읽기전용 노드, 플러그인 노드) —
  제품 결정 선행 필요

## 2. 작업 체제

### 2.1 역할

- **설계·리뷰: Fable.** 각 단계의 RED 테스트 목록 확정, 단계 종료 시 적대적 리뷰 수행.
- **구현: Opus 5.** RED 테스트를 통과시키는 최소 구현(GREEN)과 리팩터링 커밋.
- 작업은 worktree에서 격리한다: `git worktree add .worktrees/monaco-parity-stage<N> -b codex/monaco-parity-stage<N>`

### 2.2 단계별 사이클 (모든 단계 공통)

1. **RED** — 이 문서의 테스트 목록을 실패하는 테스트로 먼저 작성한다.
   테스트가 "옛 구현을 되돌리면 실패"하는지 확인할 수 없는 신규 기능이므로,
   대신 각 테스트가 구현 없이 실패하는 것을 커밋 전에 확인한다.
2. **GREEN** — 최소 구현. 항목당 1커밋 (`feat(monaco): …` / `test(monaco): …`).
3. **REFACTOR** — 아래 2.4 체크리스트. 동작 변경 없이 구조만. 별도 커밋
   (`refactor(monaco): …`). 리팩터링 후 전체 게이트 재실행.
4. **게이트** — 아래 명령이 전부 통과해야 단계 종료 후보:

   ```bash
   npm run test:v2:frontend
   npm run lint:v2
   npx tsc --noEmit -p apps/desktop/tsconfig.json
   cargo test --workspace        # Rust 변경이 있는 단계만
   npm run test:v2:bundle        # 데코/렌더 단계는 번들 예산 확인
   ```

   그리고 **수동 확인**: `npm run v2:tauri:dev`로 실행해 단계별 "수동 시나리오"를
   직접 조작해 확인한다. 브라우저 확인은 `npm run v2:dev` 후
   `http://127.0.0.1:1421/?outline=monaco`.
5. **적대적 리뷰** — Fable이 2.5의 공격 각도로 리뷰. 발견 사항은 심각도와 함께 기록.
6. **재작업** — 리뷰 발견이 있으면 2.6 템플릿으로 Opus 5에 지시. 재작업 후 4–5 반복.
   발견 0이 되면 다음 단계로.

### 2.3 단계 완결성의 정의

단계가 끝난 시점에 (a) 게이트 전부 통과, (b) 수동 시나리오 확인 완료,
(c) 미완성 코드 경로 없음(플래그로 숨긴 반쪽 기능 금지), (d) 문서의 해당 단계
섹션에 결과 기록. 이 넷을 채우지 못하면 병합하지 않는다.

### 2.4 리팩터링 체크리스트

- 새 코드가 기존 패턴과 중복되면 통합: 키바인딩은 `plugin.ts`의
  `runOutlineCommand` 게이트 하나로, 클릭 라우팅은 `attachedData` 패턴 하나로.
- 세션 명령이 3개 이상 같은 꼴이면 공통 헬퍼로 추출 (`session.ts`).
- 데코레이션 종류가 늘면 `decorations.ts`의 빌더로 합치고
  `decorationWindow.ts`의 윈도잉을 반드시 경유.
- 테스트 픽스처 중복은 테스트 헬퍼로 이동 (기존 `nativeEditing.test.ts` 픽스처 참조).
- 죽은 분기·미사용 export 제거. 주석은 코드가 말할 수 없는 제약만.

### 2.5 적대적 리뷰 프로토콜

리뷰어는 "이 단계는 잘못됐다"를 증명하려는 자세로 다음 각도를 전부 공격한다:

1. **세션 정합**: 새 명령이 `executeSessionOwned` 배치 밖에서 노드를 바꾸는가?
   바꾼다면 Monaco 모델과 SQLite가 어긋나는 재현 시나리오를 만들어라.
   (세션에는 외부 변경 reconciliation이 없다 — line-count guard가 유일한 방어)
2. **Undo 일관성**: 새 동작이 Monaco native undo 스택과 메타데이터 undo
   (`pushMetadataUndo`) 중 어디에 실리는가? Cmd+Z 한 번으로 원상 복구되는가?
   텍스트+구조가 섞인 게스처의 undo 순서는?
3. **연타·레이스**: 키 반복(15ms 간격)으로 60회 연타 시 순서 꼬임·중복 실행·
   포커스 이탈이 없는가? (이전 벤치의 v2 core 빈 줄 버그와 같은 유형)
4. **경계 조건**: 줌 루트에서, 접힌 서브트리 안에서, 페이지 첫/마지막 행에서,
   빈 페이지에서, 5,000행 페이지에서 각각 동작하는가?
5. **성능 회귀**: 데코레이션이 `decorationWindow` 윈도잉을 우회하는가?
   keydown 핫패스에 O(n) 작업이 추가됐는가? 초기 번들 예산(90KB gzip)을 넘는가?
6. **접근성·IME**: 한글 조합 중 키바인딩이 오발하는가? (`isComposing` 가드)
   스크린리더 안내가 필요한 동작인가?
7. **fallback 경로**: 이 기능이 실패할 때 페이지가 React fallback으로 떨어지는가,
   조용히 무시되는가? 어느 쪽이 설계 의도인지 명시돼 있는가?

리뷰 산출물: 발견 목록(파일:라인, 재현 시나리오, 심각도 high/medium/low).
high가 하나라도 있으면 재작업 필수.

### 2.6 Opus 5 재작업 지시 템플릿

재작업 지시는 아래 형식으로 구체화한다. 모호한 지시("고쳐줘") 금지.

```
[재작업] Stage <N> — <발견 제목>

재현: <정확한 조작 순서 또는 실패 테스트>
원인: <리뷰에서 파악한 원인. 파일:라인>
수정 방향: <구체적 접근. 대안이 있으면 선택 기준까지>
금지: <이번 수정에서 건드리면 안 되는 것>
완료 기준: <추가/수정할 테스트 이름과 통과 조건, 재실행할 게이트>
커밋: fix(monaco): <메시지>
```

## 3. 공통 기술 기반

새 코드가 반드시 따라야 할 기존 패턴:

| 패턴 | 위치 | 요지 |
|---|---|---|
| 키바인딩 | `plugin.ts:71-85` | `editor.addCommand` + `yonalistOutlineEditor` 컨텍스트 키 + `runOutlineCommand`(활성 노드 없으면 native로 폴백, 큐 conflict/fatal이면 no-op) |
| 세션 명령 | `session.ts:307,381,340` (indent/outdent/toggleCompleted) | 메타데이터 타임라인에서 노드 확인 → `executeSessionOwned`로 IPC 배치 → receipt 적용 |
| 메타데이터 undo | `internalAdapter.ts:209-228`, `session.ts:465-513` | 텍스트가 안 변하는 구조 변경은 `pushMetadataUndo`로 Monaco undo 스택에 수동 등록 |
| 클릭 라우팅 | `plugin.ts:114-127` | injected text의 `attachedData`를 `onMouseDown`에서 판독, `preventDefault` 후 세션/페인으로 위임 |
| 데코레이션 | `decorations.ts` + `decorationWindow.ts:10-26` | 가시 범위 ±1 뷰포트만 생성. 신규 데코는 반드시 이 윈도우를 경유 |
| 구조 해석 | `structuralChanges.ts:35-124` | native 편집은 인터셉트하지 않고 모델 변경 후 해석 |
| 테스트 | `apps/desktop/src/monaco-outline/*.test.ts` | vitest + jsdom. 세션/해석기/플러그인 단위로 Monaco 실제 렌더 없이 검증. 통합은 `MonacoOutlineSurface.test.tsx` |

**IPC 제약 (중요)**: `IpcEditorCommand`에 현재 있는 것 — `createNode, indent,
mergeNodeBackward, moveNode, outdent, removeEmptyNode, setCollapsed, setCompleted,
splitNode, updateText`. `duplicate`와 `trash`(비어 있지 않은 노드 삭제)는 **없다**.
세션 밖 store 명령(`notes_execute` 일반 경로)을 쓰면 세션 모델이 어긋지므로 금지 —
Stage 2에서 Rust 명령을 추가한다.

## 4. 단계별 계획

### Stage 1a — 프론트 전용 키바인딩: 행 이동·줌·인라인 포맷

**목표**: Cmd+Shift+↑/↓ 행 이동, Cmd+. / Cmd+, 줌 인·아웃, Cmd+B / Cmd+I /
Cmd+Shift+X 인라인 포맷. 전부 기존 IPC·세션 능력만으로 구현 가능.

**사용자 가시 결과**: Monaco 페이지에서 키보드만으로 행 재배치와 줌이 됨.

**사전 확인** (구현 전 30분 한도):
- `moveNode` IPC가 세션 배치에서 동작하는지 계약 테스트로 확인
  (`packages/contracts/generated/IpcEditorCommand.ts`).
- v1의 이동 의미론 확인: 형제 간 스왑이 아니라 "이전/다음 가시 행 위치로 이동"인지
  `src/features/notes/outlineKeyboard.ts`의 `workflowyMoveDirection` 판독.
  **v1과 같은 의미론을 채택한다.**

**RED 테스트** (`session.moveNode.test.ts`, `plugin.test.ts` 확장):

1. `moveUp`: 두 번째 형제에서 호출 → `moveNode` IPC 1건, before_id가 첫 형제.
   메타데이터 타임라인의 라인 순서가 스왑됨.
2. `moveUp` 첫 형제에서 → 부모의 이전 형제의 마지막 자식으로 이동
   (v1 의미론 확인 결과에 따라 조정). 페이지 첫 행에서는 no-op.
3. `moveDown` 마지막 행에서 no-op. 접힌 서브트리를 통째로 넘어감(서브트리 분해 금지).
4. 이동 후 커서가 이동한 행을 따라감 (`setPosition` 검증).
5. 이동이 메타데이터 undo로 등록되어 Cmd+Z 한 번에 원위치.
6. 줌 단축키: `Cmd+.`가 활성 노드로 `zoomSamePane` 호출, `Cmd+,`가 zoomOut.
   활성 노드 없으면 native 폴백(false 반환).
7. 인라인 포맷: 선택 구간을 `**`로 감싸는 모델 편집 → `updateText`로 해석됨.
   이미 감싸져 있으면 토글 해제. 선택 없으면 no-op. IME 조합 중이면 no-op.
8. 큐 conflict 상태에서 세 동작 모두 차단 (`isBlockedStructuralGesture` 경유).

**GREEN 구현 지점**:
- `session.ts`: `moveNode(nodeId, direction)` — 타임라인에서 대상 위치 계산,
  `executeSessionOwned([{kind:"moveNode", …}])`, 모델 라인 이동은
  `structuralReplacement.ts` 패턴으로 최소 edit, `pushMetadataUndo` 등록.
- `plugin.ts`: 키바인딩 3쌍 추가 (기존 `addCommand` 블록에 나란히).
- 인라인 포맷은 세션 불필요 — `plugin.ts`에서 `editor.executeEdits`로 모델만 수정
  (해석기가 updateText로 처리). 토글 판정 헬퍼는 새 파일 `inlineFormat.ts`
  (v1 `src/features/notes/inlineFormat.ts`의 판정 로직 이식, UI 의존 제거).
- 줌: `plugin.ts` → `pane.zoomSamePane(activeNodeId)` / `navigation.zoomOut` 라우팅.
  (zoomOut 콜백이 pane adapter에 없으면 `MonacoOutlineSurface` navigation에 추가.)

**수동 시나리오**: 600노드 시드 페이지에서 ① 자식 있는 행을 Cmd+Shift+↓로 접힌
서브트리 너머까지 이동 ② Cmd+.로 줌 인 후 Cmd+,로 복귀 ③ 텍스트 선택 후 Cmd+B
토글 왕복 ④ 각 동작 뒤 Cmd+Z로 복원 ⑤ 재시작 후 SQLite에 반영 확인.

**리팩터링 포인트**: `addCommand` 블록이 6개를 넘으므로 키바인딩 테이블
(배열 + 루프)로 정리. `runOutlineCommand` 게이트 공유 확인.

**적대적 리뷰 중점**: 연타 이동(60회)에서 순서 보존, 접힌 서브트리 경계, 이동과
native 텍스트 편집이 섞인 undo 순서, 줌 상태에서 줌 루트 밖으로 이동 시도.

---

### Stage 1b — Rust 명령 추가: 복제·삭제 + 키바인딩

**목표**: Cmd+Shift+D 서브트리 복제, Cmd+Shift+Backspace 서브트리 삭제(trash).

**사용자 가시 결과**: Monaco 페이지에서 행 복제·삭제가 키보드로 됨.

**사전 결정**: IPC에 `duplicateNode`, `trashNode`를 추가한다(세션 소유 배치 유지).
`removeEmptyNode`는 빈 노드 전용이라 부족. 일반 store 경로 사용은 세션 어긋남
때문에 금지(3장). Rust 쪽 트랜잭션·undo 패치는 기존 `splitNode` 구현을 본뜬다.

**RED 테스트**:

1. Rust (`crates/notes-application` 또는 상응 위치): `duplicateNode`가 서브트리
   전체를 새 id로 복제하고 원본 다음 형제로 삽입, receipt에 생성 노드 전부 포함.
   `trashNode`가 서브트리를 deleted=1로 마크. 각각 undo 패치 왕복.
2. 계약: `IpcEditorCommand` 재생성 후 TS 타입에 두 명령 존재
   (`npm run test:v2:contracts`).
3. 세션: `duplicate(nodeId)` 후 모델에 복제 라인들이 원본 아래 삽입, 접힘 상태 복제,
   커서는 복제본 첫 행. `trash(nodeId)` 후 라인 제거, 커서는 이전 가시 행.
4. 마지막 남은 행 trash → 빈 페이지 가드(`ensureEditableLine` 경유로 빈 행 유지).
5. 5,000노드 페이지에서 1,000노드 서브트리 복제가 단일 배치·단일 undo 스텝.
6. 연타 가드: `input.repeat`는 v1과 동일하게 consume (복제 폭주 방지).

**GREEN 구현 지점**: Rust 명령 2개(스키마 변경 없음, notes_execute 핸들러 확장) →
계약 재생성 → `session.ts` 명령 2개 → `plugin.ts` 키바인딩 2개.

**수동 시나리오**: 복제 후 재시작해 SQLite 확인, 삭제 후 Trash 뷰(React 사이드바)에
나타나는지 확인, 각각 Cmd+Z 복원.

**리팩터링 포인트**: Stage 1a의 키바인딩 테이블에 합류. 세션의 "타임라인 조회 →
배치 실행 → 모델 최소 edit → undo 등록" 4단 구조가 5번째 반복되므로 공통 헬퍼 추출.

**적대적 리뷰 중점**: 복제 중 다른 편집이 끼어드는 레이스(300ms coalescing 경계),
receipt의 노드 수와 모델 라인 수 불일치 시 line-count guard 발동 여부, Trash와
세션 모델의 정합.

---

### Stage 2 — 투두 체크박스 렌더 + 클릭 토글

**목표**: `marker=todo` 행에 체크박스를 렌더하고 클릭으로 완료 토글.
현재 이 데이터는 Monaco 페이지에서 **조용히 안 보이는 상태**라 사실상 표시 버그 수정.

**사용자 가시 결과**: v1에서 만든 투두가 Monaco 페이지에서 보이고 클릭 토글 가능.

**RED 테스트** (`decorations.test.ts`, `plugin.test.ts` 확장):

1. marker=todo 노드의 데코레이션에 체크박스 injected text(`attachedData
   {kind:"yonalist-todo", nodeId}`)가 붙음. bullet 데코와 공존.
2. completed=true면 체크된 변형 클래스.
3. 체크박스 클릭 → `session.toggleCompleted(nodeId)` 라우팅, `preventDefault`.
4. 데코 윈도잉 준수: 가시 범위 밖 todo 행에는 데코 없음
   (`decorationWindow.test.ts` 확장).
5. 체크박스 문자가 모델 텍스트·검색·복사에 포함되지 않음
   (`nativeEditing.test.ts` 패턴 재사용).

**GREEN 구현 지점**: `decorations.ts`에 todo 변형 추가(기존 bullet 빌더 확장),
`plugin.ts` onMouseDown 라우팅에 `yonalist-todo` 분기, `notes.css`에 체크박스 스타일
(React 쪽 `outlineTodo.tsx` 스타일과 시각 일치).

**후속 분리**: 부모 행 진행 카운터(N/M)는 별도 항목 — 이 단계에 포함하지 않음.

**수동 시나리오**: React 표면(?outline=react)에서 /todo로 투두 생성 → Monaco로
전환 → 체크박스 표시·클릭 토글·strikethrough 연동 확인.

**적대적 리뷰 중점**: bullet·chevron·checkbox 세 injected text의 순서와 커서
affinity(`internalAdapter.ts:144-184` cursorStateRewrite가 체크박스를 고려하는가),
column 1 타이핑 시 앵커 고정(기존 41fb751e 수정과의 상호작용).

---

### Stage 3 — 텍스트 렌더 계층: 태그 → 링크 → 마크다운

**목표**: 행 텍스트 안 `#tag`/`@tag` 렌더+클릭 검색, URL·마크다운 링크 클릭 외부
열기, 마크다운 인라인(볼드/이탤릭/코드/취소선)과 블록(헤딩/인용/구분선) 스타일.

세 하위 단계로 나누되 공통 파이프라인을 먼저 세운다. **v2에 이미 있는 파서**
(`outlinePresentation.ts`의 `parseOutlinePresentation`)를 재사용한다 — 새 파서 금지.

**하위 단계 3a (태그)**:
- RED: ① 파서 토큰 → 라인별 태그 데코(inlineClassName + attachedData
  `{kind:"yonalist-tag", token}`) 매핑 ② 클릭 → `onTagClick` 라우팅(React와 동일한
  검색 진입) ③ 편집 중(커서가 해당 라인)에는 데코 유지하되 클릭만 동작 ④ 윈도잉 준수
  ⑤ NFC 정규화 동일성(한글 태그).
- GREEN: 새 파일 `monaco-outline/textDecorations.ts` — 라인 텍스트 →
  `parseOutlinePresentation` → 데코 배열. `decorationWindow`에 두 번째 공급자로 연결.
  `MonacoOutlineSurface`에 `onTagClick` prop 전달.

**하위 단계 3b (링크)**: Monaco `links:false` 유지한 채(자체 링크 프로바이더 대신)
3a와 같은 데코+클릭 라우팅으로 URL·`[text](href)` 처리 → `openExternal` 경유.
RED에 "클릭이 캐럿 이동을 막지 않는 일반 텍스트 클릭과 구분됨" 포함.

**하위 단계 3c (마크다운 스타일)**: 인라인 마커 구간 inlineClassName, 헤딩 라인
폰트 확대는 라인 데코 + CSS. **v1의 "편집 중 원문, 평소 렌더" 규칙은 이 단계에서
"항상 원문 문자 노출 + 스타일만"으로 단순화한다** (Monaco는 문자 숨김이 부자연,
마커 숨김은 후속 판단). 이 결정을 문서에 명시하고 사용자 확인을 받는다.

**수동 시나리오**: `## **제목** #태그 https://example.com` 행에서 스타일·태그
클릭 검색·링크 외부 열기, 5,000행 페이지에서 스크롤 프레임 확인
(`?benchmark=monaco` 프로브 활용).

**리팩터링 포인트**: 3a~3c 후 `decorations.ts`(구조)와
`textDecorations.ts`(텍스트)의 윈도잉 호출을 하나의 파이프라인으로 통합.

**적대적 리뷰 중점**: 성능(각 하위 단계마다 5,000행 스크롤 p95 측정 — 데코 수가
라인당 최대 몇 개까지 느는지), 파서 재실행 빈도(캐시 없이 스크롤마다 전 라인
파싱하면 안 됨 — 라인 텍스트 해시 캐시), 클릭과 드래그 선택의 충돌.

---

### Stage 4 — 멀티 블릿 선택 + 일괄 명령

스파이크 보고서 지정 후속 1순위. 두 하위 단계.

**하위 단계 4a (선택 모델 + 표시 + 해제)**:
- 선택 모델: 세션 밖 페인 상태 (`paneAdapter` 또는 새
  `outlineSelection.ts`) — nodeId 집합 + head. Monaco 텍스트 선택과 별개.
- RED: ① Shift+↓/↑가 현재 행에서 행 선택 시작·확장 (v1 의미론:
  가시 행 기준, 서브트리 자동 포함은 조사 후 v1과 동일하게) ② Shift+블릿클릭 확장
  ③ 선택 행 배경 데코 ④ Escape 해제 ⑤ 선택 중 일반 타이핑 → 선택 해제 후 native
  ⑥ 줌/접기 변경 시 선택 정리.
- GREEN: 키바인딩(Shift+화살표는 native 텍스트 선택과 공존해야 하므로 "행 끝에서
  Shift+↓" 같은 진입 규칙을 v1 코드에서 확인해 채택), 배경은 라인 데코.

**하위 단계 4b (일괄 명령)**: 선택 대상으로 완료/들여쓰기/내어쓰기/이동/복제/삭제.
- RED: 각 명령이 단일 IPC 배치·단일 undo 스텝, 선택 유지 규칙(v1: 완료 후 유지,
  삭제 후 해제), 부분 불가 시(줌 경계 등) 전체 거부 + 사유.
- GREEN: Stage 1a/1b 세션 명령의 다중 노드 버전. 배치 크기 상한은 v1 클립보드
  한도(2,000노드)와 동일.
- 액션바 UI는 React 오버레이(기존 `OutlineSelectionActionBar` 재사용)를 Monaco
  표면 위에 띄운다 — 새 UI 제작 금지.

**수동 시나리오**: 10행 선택 → Tab 일괄 들여쓰기 → Cmd+Z 한 번 복원 → 완료 토글
→ 삭제. 접힌 부모를 포함한 선택으로 반복.

**적대적 리뷰 중점**: Monaco 자체 멀티커서(Cmd+클릭)와의 상호작용 정의, 선택 중
구조 해석기(`interpretModelChanges`)가 발화하는 native 편집 차단 범위, receipt
적용 후 선택 집합의 stale nodeId.

---

### Stage 5 — 구조적 붙여넣기

**목표**: 들여쓰기 텍스트/마크다운 리스트 paste → 트리 임포트 (v1
`notesPasteImport.ts` 의미론).

- 현재 native paste는 개행 포함 텍스트가 그대로 라인들로 들어가 전부 형제가 됨
  (들여쓰기 정보 소실 — 데코 NBSP는 모델 텍스트가 아님).
- RED: ① 탭/스페이스 들여쓰기 paste → 부모-자식 구조로 임포트, 단일 undo
  ② 마크다운 `-` 리스트 paste 동일 ③ 단일 라인 paste는 native 유지 ④ 붙여넣기
  한도(v1: 2,000노드/깊이 64) 초과 시 알림 후 plain 텍스트로 폴백 ⑤ 복사 방향:
  Monaco에서 여러 행 복사 시 들여쓰기 재구성(депth만큼 탭) — Workflowy 왕복 호환.
- GREEN: `plugin.ts`의 paste 인터셉트(이미 `Cmd/Ctrl+V` 차단 게이트 존재:
  `plugin.ts:141-161` — 이 게이트를 파서 경유로 확장), 파서는 v1
  `notesPasteImport.ts` 로직 이식(새 파일 `monaco-outline/pasteImport.ts`),
  임포트는 `createNode` 배치.
- 복사 재구성은 `provideDocumentRangeFormatting`이 아니라 copy 이벤트에서 선택
  라인들의 depth를 타임라인에서 조회해 클립보드 텍스트 생성.

**적대적 리뷰 중점**: IME 조합 중 paste, 혼합 들여쓰기(탭+스페이스), CRLF,
Workflowy·Tana에서 복사한 실제 클립보드 페이로드 왕복 테스트.

---

### Stage 6 — 블릿 컨텍스트 메뉴 + 일괄 접기/펼치기 + 별표

**목표**: 블릿 우클릭(또는 hover ⋯) 메뉴 — v1 메뉴 중 Monaco에서 의미 있는 부분집합:
완료, 투두 전환, 별표, Move To(4b의 이동 재사용), Expand all / Collapse all,
정렬 A-Z/Z-A, 복제, 내보내기(기존 NotesExportMenu 재사용), 삭제, 타임스탬프.

- RED: ① 블릿 우클릭 → 메뉴 열림 + Monaco 기본 컨텍스트 메뉴 억제
  (`contextmenu` 옵션 끄기 — 현재 방치 상태) ② 각 항목이 대응 세션 명령 호출
  ③ Expand/Collapse all이 `setCollapsed` 배치 + 단일 undo ④ 정렬이 `moveNode`
  배치 ⑤ 키보드로 메뉴 열기(v1: 접근성) — Ctrl+Shift+M 등 지정.
- GREEN: 메뉴 UI는 React 포털(기존 v2 메뉴 컴포넌트 재사용), 위치는 블릿 데코의
  클라이언트 좌표.
- `marker` 전환(bullet↔todo)은 `updateText`가 아니라 marker 필드 —
  `IpcEditorCommand`에 `setMarker`가 없으면 Stage 1b처럼 Rust 명령 추가.

**적대적 리뷰 중점**: 메뉴 열린 동안 편집 차단 여부, 5,000노드 Expand all의 프레임
(hidden areas 재계산 1회여야 함), 정렬 undo의 원순서 복원.

## 5. 전체 검증 매트릭스 (모든 단계 병합 전)

- `npm run test:v2` (Rust + frontend + lint + architecture + contracts)
- 600노드 시드 페이지에서 Enter 연타 60회 keydown→frame p95 ≤ 15ms 유지
  (Stage 3 데코 추가 후 재측정 — 기존 벤치 스크립트 재사용)
- 초기 편집 JS ≤ 90KB gzip, Monaco lazy 청크 크기 기록
  (`npm run report:v2:monaco-bundle`)
- React fallback 페이지(이미지 포함)가 여전히 정상 폴백
- `?outline=react` 경로 무회귀 (`npm run test:v2:frontend` 전체)

## 6. 진행 기록

| Stage | 상태 | 브랜치 | 리뷰 발견 | 비고 |
|---|---|---|---|---|
| 1a | 미착수 | — | — | |
| 1b | 미착수 | — | — | Rust 명령 2개 추가 |
| 2 | 미착수 | — | — | |
| 3a/3b/3c | 미착수 | — | — | |
| 4a/4b | 미착수 | — | — | 스파이크 후속 1순위 |
| 5 | 미착수 | — | — | |
| 6 | 미착수 | — | — | setMarker IPC 여부 확인 |
