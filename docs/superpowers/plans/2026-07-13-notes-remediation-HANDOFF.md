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

**통합 브랜치 `notes-remediation` @ `73b839c`** 에 다음이 모두 병합·인증됨:
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
4. **4.4 붙여넣기 임포트 + OPML** — 들여쓰기 텍스트→서브트리, OPML import/export.
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
