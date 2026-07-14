# Notes 개선 작업 인수인계 (HANDOFF)

> **작성 시점:** 2026-07-13 18:xx KST, 계정 전환을 위해 작성.
> **목적:** 새 세션(다른 계정)이 이 문서만 읽고 중단 없이 이어받을 수 있게 한다.
> **마스터 계획:** [2026-07-13-notes-review-remediation-roadmap.md](2026-07-13-notes-review-remediation-roadmap.md) — Phase별 상세 태스크는 전부 여기에 있다. 이 문서는 "지금 어디까지 됐고, 다음에 뭘 하는가"만 담는다.

---

## 0. 새 세션이 가장 먼저 할 일

1. 작업 디렉터리를 `/Users/doortts/repos/yonalist/.worktrees/review-notes-workflowy` 로 열 것 (브랜치 `notes-remediation`).
2. 이 문서와 마스터 계획을 읽을 것.
3. 아래 "현재 상태"의 git 사실을 직접 확인할 것:
   ```
   git -C /Users/doortts/repos/yonalist worktree list
   git log --oneline -1                 # notes-remediation = 73b839c 여야 함
   ```
4. "다음 작업"의 Phase 2 잔여부터 재개.

**주의 — 세션 간 넘어가지 않는 것:** 이전 세션의 채팅 컨텍스트, TaskCreate 태스크 목록, 실행 중이던 워크플로우(`resumeFromRunId`는 동일 세션 전용). 이 문서 + git 상태 + 마스터 계획이 유일한 진실 소스다. 넘어가는 것: 모든 git 커밋/브랜치/worktree, 계획 문서, 워크플로우 스크립트 파일(디스크).

---

## 1. 현재 상태 (검증 완료)

> **2026-07-14 갱신:** Phase 2 전체 완료·병합됨 — `notes-remediation` @ `3d617c4`.
> **범위 변경:** Phase 4.4의 OPML import/export는 사용자 지시로 제외.
>
> **2026-07-14 갱신 2 (Phase 3 완료):** `notes-remediation` @ `b4269cb`.
> - Phase 3 전 태스크 완료·병합: 3.1 드래프트 엔진 추출, 3.2 커맨드 레이어,
>   3.3 내비게이션/scope 단일 소유권, 3.4 delta 프론트 소비, 3.5 settlement 타입,
>   3.6 에러 taxonomy, 3.7 registry 정직화, 3.8 정리(dead_code·perf게이트·NFC v4).
>   (3.1~3.4/3.8은 이전 계정 세션이 커밋 → 새 세션이 적대 리뷰 전원 승인 후 병합.)
> - 게이트: tsc/eslint clean, **vitest 2280 pass / 21 skip, cargo 361 pass / 1 ignored.**
> - **Gate 3 정량 목표 2개 이월(비블로킹):** (1) `useNotesWorkspace.ts` 5194→3491줄로
>   감소했으나 목표 ≤1500 미달 — 추가 추출은 명세 불명확+회귀 위험으로 보류.
>   (2) 훅 테스트의 mock 호출순서 assertion 66곳 잔존(목표 "소멸"). Phase 4 이후 정리.
> - **Phase 3 리뷰가 남긴 이월 정리(비블로킹):** ① 3.3의 `Scope` 값객체 클래스가
>   프로덕션 미사용(free fn `scopeKey`/`sameScope`만 씀) → 제거 또는 배선. ② 3.3 scope
>   3중화가 완전 단일소스 아님(reset 헬퍼 중앙화로 완화). ③ 3.4 프로덕션에 delta 검증
>   fallback 없음(백엔드 delta 계약 의존). ④ 3.5 NotesChildComposer는 skipped 피드백
>   미반영(OutlineNodeRow만). ⑤ 3.6 commands.rs import 알파벳순 아님(cargo fmt로 정리).
> - 다음: **Phase 4 Workflowy Parity (사용자 최우선)** — 4.1 다중선택 → 4.2 서식 +
>   4.3 URL링크(동일 트랙) → 4.4 붙여넣기 임포트(OPML 제외) → 4.5 Cmd+K.
>
> **2026-07-14 갱신 3 (Phase 4.1 완료):** `notes-remediation` @ `92ab457` (ff).
> - 4.1 다중 노드 선택 완료·병합: 4.1a `notes_apply_batch`(한 트랜잭션+한 히스토리
>   엔트리, 자손이동 거부, 부분실패 롤백, 트래시배치 스코프) · 4.1b 선택모델(anchor/head,
>   Shift+↑↓/Shift+Click/Esc, isSelected 원자 prop) · 4.1c 배치 라우팅(선택 시 Complete/
>   Delete(Cmd+Shift+Backspace)/Tab/Shift+Tab/MoveTo/Drag를 batch로, undo 1단위).
> - 4.1a/4.1b는 자동 리뷰 승인; 4.1c는 자동 리뷰가 스키마 출력 이슈로 실패 → 오케스트레이터가
>   직접 적대 검토 후 승인(코드 무결). 게이트: tsc/eslint clean, **vitest 2325 pass/21 skip,
>   cargo 371 pass/1 ignored.**
> - 4.1c minor 이월(비블로킹): 배치삭제가 Cmd+Shift+Backspace(plan "Backspace"에 안전장치
>   추가), 이동 후 선택이 블록을 따라가지 않고 해제, complete 토글방향이 포커스노드 기준.
> - 다음: **4.2 인라인 서식 + 4.3 URL 링크(동일 트랙, noteTokens 확장) → 4.4 붙여넣기 임포트
>   → 4.5 Cmd+K.**
>
> **2026-07-14 갱신 4 (Phase 4.2+4.3 완료):** `notes-remediation` @ `20b174e` (ff).
> - 4.2 인라인 서식(마크다운 서브셋 **b**/*i*/~~s~~/`code`, 플레인텍스트 저장, 오버레이만
>   스타일, 캐럿매핑 불변식 유지, Cmd+B/I 토글) + 4.3 URL 링크(http/https 토큰 → openExternal).
>   둘 다 fable 적대 리뷰 승인(재작업 0). 게이트: tsc/eslint clean, **vitest 2389 pass/21 skip.**
> - 4.2/4.3 minor 이월(비블로킹): ① 같은문자 중첩 강조 토글 비가역(**+Cmd+I 반복 시 * 누적,
>   무손실) ② 빈 **** 쌍 Cmd+I 엣지 ③ 서식 span 내 태그가 오버레이엔 안 보이나 Rust FTS는
>   색인(UX 불일치, 데이터 무결) ④ markdown export가 서식 마커를 백슬래시 이스케이프(리치 export는
>   후속) ⑤ URL 경계 인접 태그 엣지. 전부 정확성 버그 아님.
> - **속도 방침(2026-07-14 사용자 지시):** 저위험 태스크는 코더를 sonnet+medium으로 (복잡·
>   위험한 것만 opus xHigh). 4.4/4.5/이월 정리에 적용.
> - 다음: **4.4 붙여넣기 임포트(OPML 제외) → 4.5 Cmd+K 팔레트.**
>
> **2026-07-14 갱신 5 (Phase 4 전체 완료):** `notes-remediation` @ `0b6e44a`.
> - 4.4 붙여넣기 임포트: 4.4a `notes_import_subtree`(한 트랜잭션+한 히스토리, duplicate_node
>   패턴, depth/count 상한) [opus] + 4.4b 들여쓰기 파서+붙여넣기 배선 [sonnet]. 병합 전
>   후속 수정(sonnet): depth 상한 백엔드와 정합(treeDepth>=64 거부), **서브트리 임포트는
>   제목 필드에서만**(노트 본문은 일반 여러 줄 텍스트, 이미지 붙여넣기는 양쪽 유지).
> - 4.5 Cmd+K 빠른 이동 팔레트(기존 FTS 재사용, Enter→zoomTo) [sonnet].
> - 전부 fable 적대 리뷰 승인(재작업 0). 게이트: tsc/eslint clean, **vitest 2429 pass/21 skip,
>   cargo 378 pass/1 ignored.**
> - 4.4/4.5 minor 이월(비블로킹): 임포트 검증 실패가 generic 'internal' 코드로 표면화(전용
>   validation 코드 없음); 4.5 Enter가 zoomTo만 호출(아카이브/트래시 스코프로 점프 시
>   scope 전환 없음 — openSearchResult 대비 얕음). 둘 다 후속.
>
> ## Phase 4 (Workflowy Parity) 전체 완료 — 사용자 최우선 요청 충족
> 다중선택 · 인라인서식 · URL링크 · 붙여넣기 임포트 · Cmd+K 팔레트 모두 병합됨.
> (4.6 미러/백링크·보드·타임라인은 로드맵 방침대로 별도 승인 대기.)
>
> ## 남은 선택적 이월 정리 (블로킹 아님, 원하면 진행)
> - Gate 3 정량 목표: useNotesWorkspace.ts ≤1500줄(현 ~3500) 추가 분해, 훅 테스트의
>   mock 호출순서 assertion(~66곳) 정리.
> - Phase 3 이월: 3.3 `Scope` 값객체 클래스 미사용 정리, scope 3중화 완전 단일소스화,
>   3.4 delta 프로덕션 검증 fallback.
> - Phase 4 이월: 위 4.2~4.5 minor 항목들(리치 export, 서식 span 내 태그 FTS 정합,
>   임포트 validation 에러 코드, Cmd+K openSearchResult 정합).
> - 전역: `cargo fmt`, Phase 0 후속(Cmd+Shift+Backspace delete 첨부 가드 확인).

**통합 브랜치 `notes-remediation` @ `73b839c`** (이하 계정 전환 시점 기록) 에 다음이 모두 병합·인증됨:
- Phase R: main 병합(`5b3d65b`) + ESLint 도입(`8c83a4b`)
- Phase 0: 핫픽스 8건 (디바운스 상한, flush-on-quit, 키보드 버그 2건, 클립보드 paste, export 안전장치, flock 데드라인, 쓰기 실패 가시화)
- Phase 1: 백엔드 실행 모델 **전체 6태스크 10커밋** (커맨드 async화, SQLite 연결 재사용, 트랜잭션 밖 파일 I/O, 첨부 raw IPC 읽기, mutation delta, 검색 CTE, reconcile 정리, 복제 시 첨부 복사, 단일 인스턴스 락, export 테스트 강화)

**인증 결과 (`73b839c`에서 직접 실행):**
- `npx tsc --noEmit` → clean
- `npx eslint src` → 0 problems
- `npx vitest run` → **2201 passed / 21 skipped**
- `cargo test --manifest-path src-tauri/Cargo.toml` → **354 passed / 1 ignored**

**worktree 지도:**
| worktree | 브랜치 | HEAD | 상태 |
| --- | --- | --- | --- |
| `.worktrees/review-notes-workflowy` | `notes-remediation` | `73b839c` | 통합 브랜치 (여기서 작업) |
| `.worktrees/rem-p1-backend` | `rem/p1-backend` | `73b839c` | **병합 완료 — 제거 가능** |
| `.worktrees/rem-p2-frontend` | `rem/p2-frontend` | `fe8eaa5` | Phase 2.1만 완료, 2.2~2.4 미완 |

`rem-p1-backend`는 이미 병합됐으니 정리해도 된다:
```
git -C /Users/doortts/repos/yonalist worktree remove .worktrees/rem-p1-backend
git -C /Users/doortts/repos/yonalist branch -d rem/p1-backend
```

---

## 2. 다음 작업 (순서대로)

### 2-A. Phase 2 렌더 성능 잔여 — `rem/p2-frontend` 에서 이어서
`rem-p2-frontend` worktree는 `fe8eaa5`(2.1 컨텍스트 분할 완료)에 있다. 남은 것:
- **2.2 행 메모이제이션** — 마스터 계획 "Phase 2.2". `NotesOutlinePane` 파생값 useMemo, `visibleNodeIds` 값 전달 제거, `OutlineNodeRow`를 React.memo+원자 props로, `NoteTokenText` 토큰화 useMemo. **필수 테스트: 50노드에서 한 행 타이핑 시 그 행만 리렌더(형제 리렌더 0) 하는 렌더 카운트 테스트.**
- **2.3 autosave loading 격리** — 마스터 계획 "Phase 2.3". 드래프트(비구조) 저장이 전역 loading/aria-busy를 토글하지 않도록. 구조 커맨드만 pending 사용.
- **2.4 App 커밋 간 패널 메모** — 마스터 계획 "Phase 2.4". main의 `0c19b5d` 패턴을 Notes 패널에 적용.

2.2~2.4 완료 후 `notes-remediation`으로 병합하고 전체 테스트 재확인.

### 2-B. Phase 2.1 병합 시 반드시 처리할 후속 2건 (리뷰어가 남긴 minor)
`rem/p2-frontend`의 2.1 커밋(`fe8eaa5`)에 다음 미결이 있다:
1. `src/features/notes/NotesWorkspaceContext.ts` 의 `useNotesWorkspaceContext` 호환 훅이 **호출처 0** (죽은 코드). 병합 시 제거. (단, 5개 테스트가 fallback으로 제공하는 병합된 컨텍스트 객체 자체는 유지해야 함.)
2. `libraryView` 변경 시 actions identity가 안정적인지 고정하는 테스트가 없음 — createRoot의 libraryView 의존을 ref로 뺀 수정이 회귀해도 잡지 못함. `selectLibraryView('archive')` 후 actions/actionsSlice identity 불변 + createRoot가 'all'로 복귀하는 ~15줄 테스트 추가.

### 2-C. Phase 3 구조 리팩토링 (마스터 계획 "Phase 3", 7태스크)
순서 엄수: **3.1 드래프트 엔진 추출 → 3.2 커맨드 레이어 추출**(여기까지가 테스트 안전망) **→ 3.3 내비게이션/scope 단일 소유권**(리스크 최고, 반드시 3.1/3.2 뒤) → 3.4 delta 프론트 소비 → 3.5 settlement 결과 타입 → 3.6 에러 taxonomy → 3.7 registry 정직화 → 3.8 잔여(mod.rs dead_code 제거, performance.rs 머신고정 완화, **NFC 태그 정규화+스키마 v4 마이그레이션**).

### 2-D. Phase 4 Workflowy Parity (마스터 계획 "Phase 4") — **사용자 최우선 요청**
사용자가 "Workflowy에 있는데 없는 것"을 우선순위 순으로 추가할 것을 명시적으로 요청함. 순서:
1. **4.1 다중 노드 선택** — Shift+Click/Shift+↑↓, 일괄 Complete/Delete/Move/Indent/Outdent, 백엔드 `notes_apply_batch`(한 트랜잭션+한 히스토리 엔트리, undo 1단위).
2. **4.2 인라인 텍스트 서식** — 마크다운 서브셋 토큰(`**b**`/`*i*`/`~~s~~`/`` `code` ``), 저장은 플레인 텍스트 유지, 표시 오버레이만 서식. **4.3과 같은 트랙(둘 다 noteTokens.ts 확장).**
3. **4.3 URL 자동 링크** — noteTokens에 url 토큰, 외부 브라우저 오픈.
4. **4.4 붙여넣기 임포트** — 들여쓰기 텍스트→서브트리. (OPML import/export는 2026-07-14 사용자 지시로 범위 제외.)
5. **4.5 빠른 이동 팔레트 (Cmd+K)** — FTS 재사용, Enter→zoomTo.
- **4.6 미러/백링크·보드·타임라인은 범위 제외** (로드맵의 별도 승인 방침 유지). 사용자가 명시 요청하면 별도 설계 선행.

---

## 3. 실행 체제 (사용자 지정 — 반드시 유지)

사용자 지시: **"실행계획·점검·테스트 설계·적대적 리뷰·재작업 지시는 Fable 5 xHigh(오케스트레이터)로, 구체적 코드 작업은 Opus 4.8 xHigh(코더)로."**

- 오케스트레이터(메인 루프)가 태스크별 실행계획 + 필수 테스트 케이스를 설계.
- `Workflow` 도구로 트랙을 fan-out: 각 태스크 = `agent(..., {model:'opus', effort:'xhigh'})` 코더 → `agent(..., {effort:'xhigh'})` fable 리뷰어(세션 모델 상속) → 불승인 시 재작업 루프(최대 2회).
- 파일이 겹치는 태스크는 **격리된 git worktree**에서 병렬, 겹치지 않으면 순차 체인.
- 리뷰 불승인 시 체인은 그 지점에서 정지(결함 위에 쌓기 방지).
- 코더는 자기 worktree에서 커밋(메시지 규칙: 마스터 계획의 커밋 프리픽스, 끝에 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`).
- 오케스트레이터가 승인된 브랜치를 `notes-remediation`으로 순차 병합, 병합마다 `tsc`/`eslint`/`vitest`/`cargo test` 확인.

**기존 워크플로우 스크립트(참고/재사용):**
- Phase 1+2: `/Users/doortts/.claude/projects/-Users-doortts-repos-yonalist/a6829484-617f-46a8-bfbf-b0acb975ffdd/workflows/scripts/phase1-2-parallel-chains-wf_395cff9d-10b.js`
- 이전 세션 run id들은 새 세션에서 resume 불가(동일 세션 전용). 새 워크플로우를 새로 launch 할 것.

---

## 4. 검증 명령 (게이트)

병합/커밋 전 항상:
```
cd /Users/doortts/repos/yonalist/.worktrees/review-notes-workflowy
npx tsc --noEmit
npx eslint src            # 0 problems 유지, 새 react-hooks disable은 사유 주석 필수
npx vitest run            # 현재 baseline: 2201 passed / 21 skipped
cargo test --manifest-path src-tauri/Cargo.toml   # 354 passed / 1 ignored
```
Rust 첫 빌드는 10분 넘을 수 있음 — 백그라운드로 돌리거나 타임아웃 시 재실행(증분).

---

## 5. 이월된 잔여 확인 사항 (블로킹 아님)

- **Phase 0 리뷰 후속:** Cmd/Ctrl+Shift+Backspace "delete" 경로도 첨부 가드가 필요한지 — Phase 1.6에서 "verify soft-delete legality"로 확인 지시했으니 해당 커밋 메시지/주석 확인. 미처리면 outlineKeyboard.ts:126-133에 가드+테스트.
- **1.2 minor:** VaultRegistry epoch/connection 맵이 vault 경로별로 단조 증가(프로세스 수명 한정, 무시 가능). 경로 정규화 없음(같은 vault 두 철자 → 두 연결, WAL-safe).
- **1.3 minor:** history replay의 에러 우선순위가 미세하게 바뀜(첨부 바이트 에러가 상태검증보다 먼저) — 원자적 거부라 무해, 고정 테스트 없음.
