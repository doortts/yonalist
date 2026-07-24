# Notes 아웃라이너 입력 지연 근본 개선 계획

- 작성: 2026-07-24. 입력: 아웃라이너 입력 지연 진단(본 문서 §진단 요약).
- 목표: Enter·커서 이동이 블릿 수와 무관하게 한 프레임(<16ms) 안에 반응한다. split view에서 키 반복이 밀리지 않는다.
- 원칙: 키 결정 로직(`resolveOutlineKey`)과 명령 의미는 바꾸지 않는다. 실행 경로만 바꾼다. 각 트랙은 프로브 수치로 수용 기준을 판정한다.

## 진단 요약 (근거)

| 증상 | 원인 | 근거 |
| --- | --- | --- |
| 커서키 지연, keyup 후 수 초 관성 | 화살표 1회 = `focusNode` reducer 액션 → pane 전체 리렌더 ×2회(acknowledge까지) ×pane 수. 가상화 없음 → O(N) 순회. 키 반복(~30Hz)이 프레임 예산 초과 시 keydown 큐 적체 | `OutlineNodeRow.tsx:1320`, `notesWorkspaceRuntime.ts:1152`, `NotesOutlinePane.tsx:4331` |
| Enter 지연, 블릿 수 비례 악화 | mutation 응답이 delta를 채우면서도 전체 workspace를 항상 직렬화 — Rust 직렬화·IPC·JS 파싱이 O(N) | `types.rs:223` `NotesMutationResult`, `notesSplitLatencyProbe.ts` |
| split view에서 배가 | `NotesDetailSplitHost`가 pane 2개를 같은 상태에 구독 — 모든 변경이 두 pane 리렌더 | `NotesDetailSplitHost.tsx:206,238` |
| caret 이질감 | 블릿마다 textarea+프레젠테이션 span 이중 레이어. caret은 네이티브지만 표시 텍스트는 다른 요소(투명 처리) — 메트릭 보정 변수(`--notes-stable-caret-offset`) 존재 자체가 증거. 행 간 이동은 React 왕복 후 `setSelectionRange`라 리듬이 비네이티브 | `NoteTextField.tsx:595-622` |

## L0 — 측정 인프라 확장 (모든 트랙의 선행)

- `notesSplitLatencyProbe`를 일반화: caret-move 프로브 추가 — `keydown → dom-focus → sync → paint` 스팬, 가시 행 수 태그. 계측 지점: `OutlineNodeRow`의 `case "focus"`(keydown), focusRequest effect의 기존 split `caret` 마크 옆(dom-focus), `acknowledgeFocus` resolve(sync)와 그 직후 rAF(paint).
- 벤치 fixture: dev 전용 Tauri 커맨드 `notes_seed_bench_nodes`(roots × children × grandchildren 계층, 상한 20,000, HLC는 기존 INSERT 트리거에 위임) — devtools 콘솔에서 호출.
- 수용 기준 판정은 전부 이 프로브/벤치 수치로 한다. 트랙 착수 전 현재 수치를 기록해 개선 폭을 남긴다.

### 베이스라인 캡처 절차 (수동, 각 트랙 전후 반복)

1. `npm run tauri:dev` (dev 빌드 — 프로브 자동 활성. 프로덕션 빌드에서 보려면 webview 콘솔에서 `localStorage["notes:splitLatency"]="1"`).
2. devtools 콘솔에서 시딩: `window.__TAURI_INTERNALS__.invoke("notes_seed_bench_nodes", { vaultPath: "<vault>", roots: 50, childrenPerRoot: 20, grandchildrenPerChild: 4 })` → 약 5k. 1k/10k는 인자 조정.
3. `All` 화면에서 ①Enter 5회(split 체인 로그), ②화살표 단발 10회, ③화살표 2초 홀드 후 keyup(잔여 이동 관찰), ④split view 열고 ②③ 반복.
4. 콘솔의 `notes split-latency`/`notes caret-latency` 라인을 수집해 본 문서 부록 표에 기록 (중앙값·p95, keyup 후 잔여 caret 로그 개수).

### 부록 — 측정 기록

| 날짜 | 조건(노드/뷰) | Enter total p50/p95 | caret total p50/p95 | keyup 후 잔여 이동 | 비고 |
| --- | --- | --- | --- | --- | --- |
| (T0 이전 베이스라인 기록 예정) | | | | | |

## Track T1 — 화살표 이동을 직접 DOM focus로 (효과 최대, 규모 중)

- 문제: `case "focus"`가 `saveDrafts()` + `actions.focusNode()`로 React 상태 머신을 왕복한다.
- 설계:
  1. 공용 helper `focusOutlineEditor(paneRoot, nodeId, field, edge)` — `[data-outline-id]`로 대상 행을 찾아 title/note textarea에 `focus()` + `setSelectionRange()`. GitHub 외부 행 경로(`NotesOutlinePane.tsx:2745-2754`)의 직접 focus 방식을 일반 블릿으로 일반화.
  2. `OutlineNodeRow` `case "focus"`: 결정은 기존 `resolveOutlineKey` 결과(nodeId/field/edge/selection)를 그대로 쓰고, 실행만 helper 직행. 대상이 DOM에 없으면(향후 가상화 대비) 기존 `actions.focusNode` 폴백.
  3. 상태 동기화 국소화: `selectedId`/`editingNoteId` 갱신은 focus 완료 후 rAF/idle로 배치하고 키 반복 중에는 마지막 위치만 반영(coalesce). 하이라이트가 한두 프레임 늦는 것은 수용. focus 이벤트발 `acknowledgePendingFocus` 경로도 같은 배치에 편입 — 커서 이동이 동기 reducer 렌더를 만들지 않는 것이 불변 조건.
  4. 커서 이동 시 `saveDrafts()` 즉시 flush 제거 — draft는 기존 debounce 저장에 맡긴다(이동은 내용을 바꾸지 않는다). IME/composition 가드는 기존 그대로.
- 파일: `OutlineNodeRow.tsx`, `NotesOutlinePane.tsx`, `notesWorkspaceRuntime.ts`, helper 신규 1개.
- 테스트: 화살표 이동이 동기 reducer 액션을 발행하지 않음(액션 spy), 이동 후 idle에 `selectedId` 수렴, 연속 반복 coalesce(중간 위치 상태 미반영), DOM 부재 시 폴백, note↔title·collapsed 경계·zoom header·이미지 행 기존 키보드 테스트 전부 유지.
- 수용: caret-move 프로브 `keydown→dom-focus`가 1k/5k/10k 모두 <8ms. 5k 블릿 split view에서 키 반복 유지 시 keyup 후 잔여 이동 0회.
- 리스크: focus 이벤트 핸들러에 숨은 동기 상태 업데이트가 남는 것 — 액션 spy 테스트로 봉인.

## Track T2 — mutation 응답 delta-only (효과 큼, 규모 소, 독립)

- 문제: `NotesMutationResult.workspace`가 delta 존재 여부와 무관하게 항상 전체 직렬화.
- 설계:
  1. Rust: `workspace`를 `Option<NotesWorkspace>`(`skip_serializing_if`)로. history context로 실행되어 `changed_nodes`/`removed_node_ids`가 채워진 mutation은 `None`. delta를 만들 수 없는 명령(초기 load, undo/redo, import 등 전체 재구성 계열)만 full 유지 — 어느 명령이 어느 쪽인지 표를 계획 단계에서 확정.
  2. 프론트: `notesWorkspaceProjection`은 이미 delta 분기 보유. workspace optional 수용, delta 적용 불능(참조 노드 부재 등) 시 전체 reload 1회 폴백 후 오류 리포트.
  3. delta 경로에서 누락될 수 있는 파생(태그 요약, attachment 맵 등) 전수 목록화 — full workspace에 기대던 재계산 지점을 delta 기반으로 옮기거나 해당 명령만 full 유지.
  4. IPC 계약은 파일 포맷이 아니므로 개발 단계 원자 전환. v2/v3 마이그레이션 없음.
- 파일: `src-tauri/src/notes/types.rs`, `commands.rs`(응답 조립부), `notesWorkspaceProjection.ts`, `notesWorkspaceReducer.ts`, `notesCommands.ts` 타입.
- 테스트: Rust — delta 있는 mutation 응답에 workspace 부재+delta 정확성, full 계열은 종전 유지. TS — delta-only 적용, 불일치 시 reload 폴백 1회. 통합 — split 프로브 `ipc-done` 스팬이 노드 수와 무관.
- 수용: 5k 블릿에서 Enter의 `ipc-done` 스팬이 1k 대비 ±20% 이내(상수화).
- 리스크: delta가 놓치는 파생 상태. 전수 목록화+폴백으로 방어.

## Track T3 — 렌더 단가 절감·파생 메모화 (규모 소, T1과 병행 가능)

- 문제: pane 리렌더마다 전 행 `renderOutlineNodeItem` 재실행 — 행마다 `directTodoProgress`(자식 순회) 등 파생 재계산, 인라인 객체로 memo 무효화 위험.
- 설계:
  1. `directTodoProgress`를 렌더 루프 밖 일괄 계산 — `nodesById`/`childIdsByParent` 참조가 바뀔 때만 전체 progress Map 1회 재구성(O(N) 1회, 행당 O(children) ×N 제거).
  2. structuralRows·visibleIds·sortable id 배열의 참조 안정성 감사 — 의존 불변 시 동일 참조 유지.
  3. `renderOutlineNodeItem` 인라인 계산·객체 정리로 `MemoizedOutlineNodeEditor` 무효화 최소화.
  4. dev 전용 재렌더 카운터(프로브에 편입)로 “키 입력당 재렌더 행 수”를 상시 노출.
- 파일: `NotesOutlinePane.tsx` 위주.
- 테스트: 타이핑·화살표 1회당 재렌더 행 수 ≤3(카운터 assert), progress Map 캐시 무효화 정확성.
- 수용: 5k 블릿에서 mutation 1회 커밋 렌더 시간 50% 이상 감소(프로브).

## Track T4 — split 비활성 pane 적용 유예 (규모 소~중, T1 이후 권장)

- 문제: 비활성 pane이 모든 상태 변경에 동기 리렌더.
- 설계: pane registry가 입력 pane을 식별 — 비활성 pane의 구독 적용을 다음 frame/idle로 배치(`useDeferredValue` 또는 명시 rAF 큐, 연속 변경 coalesce·최종 상태만 반영). 비활성 pane에서 입력이 시작되면 그 pane을 즉시 승격·플러시. drag cross-pane 중에는 유예 해제.
- 파일: `notesWorkspaceRuntime.ts`(pane별 구독), `useNotesWorkspacePaneRegistry.ts`, `NotesDetailSplitHost.tsx`.
- 테스트: 비활성 pane 반영이 프레임 경계로 지연되되 최종 수렴 동일, pane 전환 즉시 플러시, drag 중 유예 해제.
- 수용: split 타이핑·Enter의 총 블로킹 시간이 단일 pane 대비 +10% 이내(프로브).

## Track T5 — 아웃라인 가상화 (규모 대, 마지막, 플래그 뒤 단계 도입)

- 전제: T1~T4 후에도 10k+ 블릿에서 목표 미달일 때 진행. 착수 전 별도 설계 문서(가상화 설계)를 만들고 적대 리뷰를 거친다.
- 설계 원칙: 행 높이 가변(노트·이미지) → 측정 캐시+ResizeObserver+overscan+anchor 스크롤 보정. 외부 lib(virtua 등 경량) 도입 여부는 설계 문서에서 1회 비교 후 사용자 결정.
- 불변 조건: 포커스·편집 중 행은 항상 mount, 선택 연산은 데이터 기반 유지(`selectionVisibleIds`), dnd-kit 측정 전략 재정의, 접근성(스크린리더 목록 의미) 보존.
- 단계: (a) 행 레이아웃 측정 인프라+피처 플래그 → (b) 읽기 스크롤 가상화 → (c) 편집·포커스·삽입 상호작용 → (d) dnd → (e) 플래그 기본 on.
- 테스트: 뷰포트 밖 행 미렌더, 포커스 행 pinned, 위쪽 삽입 시 스크롤 점프 없음, dnd 시나리오, 10k 벤치.
- 수용: 10k 블릿에서 화살표·Enter·타이핑 p95 프레임 <16ms.
- 리스크: 최대(dnd·측정·IME 상호작용). 그래서 마지막 배치, 플래그 뒤.

## caret 이질감 후속 (트랙 외 관찰 항목)

T1이 행 간 이동 리듬을 네이티브화한 뒤에도 남는 미세 어긋남은 이중 레이어 폰트 메트릭 문제로 별도 추적한다. `--notes-stable-caret-offset` 보정이 필요했던 근본 원인(레이어 간 line-height/letter-spacing 차이)을 수치로 확인한 뒤에만 손댄다. 본 계획에서는 범위 제외.

## 실행 순서와 의존성

```
L0 (측정)
 ├─ T2 delta-only IPC   (독립, 소) ─┐
 ├─ T1 직접 DOM focus   (독립, 중) ─┼─ T4 split 유예 (T1 이후)
 └─ T3 렌더 메모화      (T1과 병행) ┘
                                     └─ T5 가상화 (T1~T4 수치 확인 후 결정, 별도 설계)
```

- 각 트랙 완료 시 L0 수치 기록 → 다음 트랙 착수 판단. T5는 T1~T4 결과가 목표(5k에서 <16ms)를 이미 달성하면 보류한다.
- 검증 공통: 전체 frontend/Rust 테스트, lint, architecture 검사, production build, Tauri 개발 빌드에서 1k/5k 수동 체감 확인.
