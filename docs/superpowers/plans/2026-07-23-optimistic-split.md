# Enter 지연 근본 개선 — 낙관적 split (설계)

- 작성: 2026-07-23 (Fable). 구현: Opus 4.8 xHigh, TDD, 단계별 커밋. 선행 작업(sync-swap-recovery) 병합 후 착수.
- 문제: Enter → 새 블릿에 커서가 앉기까지 웹 Workflowy 대비 뚜렷이 느림. 원인은 이미 전수 추적됨(2026-07-22 조사): **커서가 1~2회의 Tauri IPC(선행 draft flush + split) + 전체 workspace 정규화 + React 커밋을 기다린 뒤에야 이동**. Workflowy는 순수 로컬 삽입이라 구조적 격차. A(진입 애니 생략)로 "멈칫"은 제거됐으나 대기 자체는 남음.
- 유리한 기반: 새 노드 id가 keydown 시점에 **클라이언트에서 생성**됨(`createNoteId()`, OutlineNodeRow.tsx:938) → 낙관 행과 권위 결과가 같은 id → reconcile이 id 충돌 없이 성립.

## Phase L0 — 계측 (판단 근거 확보, 1커밋)
`perf(notes): instrument the enter-to-caret latency chain`

- dev 전용 플래그(`import.meta.env.DEV` 또는 localStorage 스위치) 뒤에 `performance.now()` 마크: keydown → barrier flush 완료 → split IPC 완료 → normalize 완료 → settle dispatch → React 커밋(useLayoutEffect) → focus 실행. 한 split당 콘솔 1줄 요약.
- 산출물: dev/release 각각에서 대표 측정치(소형 vault·대형 vault). 지배 항이 예상(IPC 직렬 대기)과 다르면 L1 설계를 재검토하고 중단·보고.

## Phase L1 — 공통 케이스 낙관 경로 (핵심, 1커밋)
`feat(notes): optimistic empty split for end-of-line enter`

**범위 제한(의도적)**: 캐럿이 줄 끝(suffix가 빈 문자열)이고 대상이 텍스트 노드인 경우만 — Enter 연타로 목록을 쏟아내는 지배적 사용 패턴. 그 외(중간 분할, 이미지, 특수 배치)는 기존 경로 그대로.

동작:
1. keydown에서 기존 split 명령 발행 **직전에** 낙관 액션 dispatch: `optimisticSplitInsert { sourceId, newNodeId }` — 로컬 상태에 빈 형제 노드(제목 "", source 바로 아래, **Rust split의 배치 규칙과 동일하게** — commands.rs의 split 배치 로직을 읽고 미러링; 자식 보유/접힘 등으로 규칙이 갈리면 그 케이스는 낙관 제외) 삽입 + `pendingFocusId = newNodeId`.
2. 같은 커밋에서 새 행 렌더 → 기존 포커스 effect가 즉시 caret 안착. **IPC와 무관하게 다음 페인트에 커서 이동.**
3. 권위 결과 settle: 같은 id의 노드가 이미 있으므로 upsert로 수렴. 리듀서의 dev delta 검증이 낙관 상태를 오검출하지 않도록 낙관 노드를 검증 예외로 마킹(또는 settle 시 낙관 플래그 해제 후 검증).
4. **실패 롤백**: split IPC 실패 시 낙관 노드 제거 + 포커스를 원 노드로 복귀 + 기존 오류 표출 경로. 사용자가 그 사이 낙관 행에 타이핑한 텍스트는 draft 복구 원장(recovery ledger)으로 보존 — 유실 금지(불변 규칙).
5. **낙관 행 위 타이핑**: draft는 nodeId 키라 그대로 쌓임. 단 **flush는 노드가 DB에 존재하기 전 실패**하므로, newNodeId를 "권위 대기" 상태로 마킹하고 draft 엔진이 해당 노드의 쓰기를 settle까지 유예(기존 deferredFieldAttempts/structural cutoff 인프라 재사용 우선 — 새 메커니즘 신설 금지).
6. **Enter 연타**: 낙관 경로에선 재진입 게이트로 드롭하지 않고 각 Enter가 순서대로 낙관 삽입+명령 큐잉(coordinator가 IPC를 직렬화). 낙관 행에 대한 split은 그 행의 권위 settle 이후로 큐잉되거나, 동일하게 낙관 처리 — 구현 중 단순한 쪽을 택하되 **드롭은 금지**(현행의 "씹힘" 제거).
7. undo: 권위 히스토리 그대로(낙관 층은 히스토리 미기록) — split undo 의미론 무변경.

TDD 필수 케이스:
- 줄끝 Enter → IPC resolve 전에 새 행 존재+pendingFocus 설정(리듀서 단위) / 통합: mock repository의 지연된 splitNode에도 caret이 즉시 새 행에.
- settle 후 상태 = 비낙관 경로와 동일(수렴).
- 실패 롤백 + 타이핑 보존.
- Enter 2연타 → 노드 2개, 드롭 0.
- 중간 분할(suffix 비어있지 않음) → 기존 경로 사용(낙관 액션 미발행).

## 게이트·규율
- 표준 체제: Fable 설계·적대 리뷰·재작업 지시 / Opus 구현. TDD red 증거 기록. 항목당 1커밋.
- 전체 게이트 + `NotesWorkspace.test.tsx` 기존 split/포커스 시나리오 무손상. order-observation 금지 패턴 사용 금지. budget 파일 라인 캡 준수(리듀서·runtime은 캡 여유 확인 후 필요시 별도 모듈).
- 수용 기준: L0 계측으로 keydown→caret이 로컬 프레임 수준(≈1 frame)임을 확인, 대형 vault에서도 IPC 시간과 무관.
