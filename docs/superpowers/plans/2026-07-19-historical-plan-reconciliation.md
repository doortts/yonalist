# 과거 계획 문서 증거 대조 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Yonalist workflow:** REQUIRED PROJECT SKILL: Read and apply `.agents/skills/delivering-yonalist-changes/SKILL.md` before implementation.

**Goal:** 2026-07-10부터 2026-07-16까지의 checkbox 보유 계획 23개, 684개 항목을 현재 main의 도달 가능한 commit과 실제 artifact/test 증거에 대조하고, checkbox와 문서 상태를 사실에 맞게 고친다.

**Architecture:** 감사 대상을 glob으로 추측하지 않고 고정 manifest로 선언한다. machine-readable ledger가 각 문서의 checkbox ordinal 범위를 `complete/partial/superseded/unimplemented` 중 하나로 분류하고 commit·artifact 증거를 연결한다. validator는 684개 항목의 누락/중복, checkbox 표시, commit 도달 가능성, artifact 존재, 문서 요약 상태를 검사한다. 사람이 읽는 한국어 보고서는 같은 ledger에서 요약한다.

**Tech Stack:** Markdown, JSON, Node 표준 라이브러리, Git CLI, Vitest 4

## Delivery Contract

| Field | Contract |
| --- | --- |
| Goal | 고정된 과거 계획 23개·684개 checkbox를 기준 commit의 도달 가능한 증거와 일치시킨다. |
| Acceptance | 684개 항목의 누락·중복 0, checkbox/ledger/header 불일치 0, unreachable commit과 missing artifact 0이다. |
| Non-goals | Git history rewrite, 과거 요구 문구 재작성, 이름이 비슷한 기능의 자동 완료 판정, production 코드 변경은 하지 않는다. |
| Boundaries | Markdown 계획, JSON ledger/manifest, Node validator, 기준 commit의 Git object graph만 다룬다. |
| Manual proof | N/A — 사용자 동작을 바꾸지 않는 문서·검증 도구 작업이며 machine validator와 Git evidence 전수 검사를 사용한다. |

## Global Constraints

- 감사 기준 commit은 `ec8a9ff3d016449255992adf70e128ea5e222e9a`다.
- 기준 commit 뒤에 생긴 구현은 이번 역사 감사의 완료 증거로 소급 사용하지 않는다.
- 대상은 아래 고정 23개 문서의 684개 checkbox뿐이다. 이 계획을 포함한 2026-07-19 계획은 대상에서 제외한다.
- 비슷한 이름의 기능, 계획 footer의 `Completed`, 현재 UI 존재만으로 완료 처리하지 않는다.
- `complete`는 기준 commit에서 도달 가능한 commit 1개 이상과 해당 commit의 결과를 현재 기준 commit에서 확인할 artifact/test path 1개 이상이 모두 있어야 한다.
- `partial`, `superseded`, `unimplemented`는 checkbox를 unchecked로 유지하고 한국어 근거를 기록한다.
- 이미 checked인 26개도 예외 없이 재검증하며, 증거가 부족하면 unchecked로 되돌린다.
- Git history나 기존 문서를 rewrite하지 않는다. 계획 문서의 checkbox와 reconciliation header만 수정한다.
- 자동 추론으로 disposition을 채우지 않는다. script는 누락과 불일치만 검사한다.

## 고정 감사 대상

| # | 계획 파일 | Checkbox |
| ---: | --- | ---: |
| 1 | `2026-07-10-notes-discovery-and-resilience.md` | 20 |
| 2 | `2026-07-10-notes-export.md` | 20 |
| 3 | `2026-07-10-notes-feature-host-foundation.md` | 20 |
| 4 | `2026-07-10-notes-outliner-mvp.md` | 20 |
| 5 | `2026-07-10-notes-sqlite-core.md` | 20 |
| 6 | `2026-07-10-workflowy-outline-ui-parity.md` | 28 |
| 7 | `2026-07-11-notes-interaction-roadmap.md` | 20 |
| 8 | `2026-07-11-workflowy-notes-interaction-expansion.md` | 58 |
| 9 | `2026-07-12-notes-inline-caret.md` | 18 |
| 10 | `2026-07-12-notes-multi-image-ingest.md` | 46 |
| 11 | `2026-07-12-notes-trash-history-and-library-rename.md` | 17 |
| 12 | `2026-07-13-notes-review-remediation-roadmap.md` | 94 |
| 13 | `2026-07-14-detail-snapshot-readiness-loop.md` | 19 |
| 14 | `2026-07-14-full-runtime-and-dependency-upgrade.md` | 20 |
| 15 | `2026-07-14-independent-image-nodes.md` | 52 |
| 16 | `2026-07-14-notes-current-schema-reset.md` | 29 |
| 17 | `2026-07-14-notes-editor-alignment-navigation.md` | 17 |
| 18 | `2026-07-14-notes-onboarding-and-supporting-note-navigation.md` | 23 |
| 19 | `2026-07-14-notes-single-menu-trigger.md` | 7 |
| 20 | `2026-07-15-notes-batch-indent-selection-preservation.md` | 7 |
| 21 | `2026-07-15-notes-multiselect-actions.md` | 65 |
| 22 | `2026-07-15-notes-multiselect-drag-and-indent-feedback.md` | 14 |
| 23 | `2026-07-16-graphite-mist-whole-app-redesign.md` | 50 |
| | **합계** | **684** |

---

### Task 1: 고정 manifest와 실패하는 validator를 만든다

**Files:**

- Create: `docs/superpowers/reports/2026-07-19-historical-plan-manifest.json`
- Create: `docs/superpowers/reports/2026-07-19-historical-plan-ledger.json`
- Create: `scripts/checkHistoricalPlanReconciliation.mjs`
- Create: `scripts/checkHistoricalPlanReconciliation.test.ts`
- Modify: `package.json`

- [ ] **Step 1: manifest schema와 기준값을 기록한다**

```json
{
  "auditedHead": "ec8a9ff3d016449255992adf70e128ea5e222e9a",
  "totalPlans": 23,
  "totalCheckboxes": 684,
  "plans": [
    {
      "path": "docs/superpowers/plans/2026-07-10-notes-discovery-and-resilience.md",
      "checkboxes": 20,
      "checkboxDigest": "33ae9d31fbe3d6821ab705db852d534550882aaf217f4ad01ada7a73ebc9ead8"
    }
  ]
}
```

`checkboxDigest`는 각 checkbox line에서 indentation과 `[ ]`/`[x]` marker를 제거하고 본문 text만 newline으로 연결한 SHA-256이다. 이 값은 다음 명령을 실행하는 script의 `--print-manifest` 출력으로 채운다. digest는 실제 23개 문서를 읽어 생성하며 임의 값을 입력하지 않는다.

- [ ] **Step 2: 잘못된 ledger fixture가 거부되는 테스트를 작성한다**

각 fixture는 다음 하나를 위반하고 해당 오류 메시지를 확인한다.

- plan 22개
- checkbox 총합 683개
- 같은 ordinal을 두 group이 중복 소유
- 한 ordinal 누락
- 문서 digest 불일치
- `complete`인데 commit 또는 artifact 없음
- audited head에 도달 불가능한 commit
- audited head에 존재하지 않는 artifact path
- `complete`인데 `[ ]`, 미완료 disposition인데 `[x]`
- 문서 reconciliation status와 ledger 요약 불일치

- [ ] **Step 3: 테스트가 검사기 부재로 실패하는지 확인한다**

Run: `npx vitest run scripts/checkHistoricalPlanReconciliation.test.ts`

Expected: module 부재로 FAIL.

- [ ] **Step 4: ledger schema와 validator를 최소 구현한다**

ledger의 group은 다음 형태만 허용한다.

```json
{
  "plan": "docs/superpowers/plans/2026-07-10-notes-discovery-and-resilience.md",
  "documentStatus": "partial",
  "groups": [
    {
      "from": 1,
      "to": 4,
      "disposition": "complete",
      "commits": ["40-character-sha"],
      "artifacts": ["src/path/to/artifact.ts"],
      "rationaleKo": "구현과 회귀 테스트가 기준 commit에 남아 있다."
    }
  ]
}
```

`from..to`는 inclusive다. 모든 ordinal은 정확히 한 group에 속해야 한다. disposition enum은 `complete`, `partial`, `superseded`, `unimplemented` 네 개다. 모든 group은 비어 있지 않은 `rationaleKo`를 가져야 한다.

- [ ] **Step 5: Git과 artifact 검증을 구현한다**

commit마다 다음과 동등한 검사를 수행한다. 아래 값은 validator fixture에도 쓰는
실제 reachable commit과 artifact 예시다.

```bash
git cat-file -e 7320060953d2c2e510c658dfcef583cc1cf26b20^{commit}
git merge-base --is-ancestor 7320060953d2c2e510c658dfcef583cc1cf26b20 ec8a9ff3d016449255992adf70e128ea5e222e9a
git cat-file -e ec8a9ff3d016449255992adf70e128ea5e222e9a:src/features/notes/useNotesWorkspace.ts
```

`complete` group만 commit과 artifact가 필수다. 나머지 disposition의 증거는 허용하지만 rationale은 필수다.

- [ ] **Step 6: 비어 있는 ledger가 의도대로 실패하는지 확인한다**

초기 ledger는 `plans: []`로 둔다.

Run: `node scripts/checkHistoricalPlanReconciliation.mjs`

Expected: `0/23 plans, 0/684 checkboxes reconciled`로 FAIL.

- [ ] **Step 7: package script를 연결한다**

```json
"test:plans": "node scripts/checkHistoricalPlanReconciliation.mjs"
```

- [ ] **Step 8: 감사 도구를 커밋한다**

```bash
git add docs/superpowers/reports/2026-07-19-historical-plan-manifest.json docs/superpowers/reports/2026-07-19-historical-plan-ledger.json scripts/checkHistoricalPlanReconciliation.mjs scripts/checkHistoricalPlanReconciliation.test.ts package.json
git commit -m "test(docs): add historical plan evidence validator"
```

### Task 2: commit과 artifact 후보를 수집하되 자동 완료 판정은 하지 않는다

**Files:**

- Create: `docs/superpowers/reports/2026-07-19-historical-plan-evidence-inventory.md`

- [ ] **Step 1: 기준 commit까지의 날짜·subject·변경 경로를 수집한다**

Run:

```bash
git log --reverse --date=short --format='%H%x09%ad%x09%s' ec8a9ff3d016449255992adf70e128ea5e222e9a -- src src-tauri docs/superpowers/reports
```

inventory에는 commit SHA, subject, 핵심 변경 경로, 연결 가능한 계획 문서를 기록한다. subject만 보고 checkbox를 변경하지 않는다.

- [ ] **Step 2: 각 계획이 도입·수정한 경로의 history를 확인한다**

각 문서의 `Files:` section과 명시된 commit subject를 기준으로 같은 검사를 반복한다.
첫 검사는 실제 대표 artifact와 candidate commit으로 시작한다.

```bash
git log --follow --format='%H%x09%s' ec8a9ff3d016449255992adf70e128ea5e222e9a -- src/features/notes/useNotesWorkspace.ts
git show --stat --oneline 7320060953d2c2e510c658dfcef583cc1cf26b20
git show --format=fuller --no-ext-diff 7320060953d2c2e510c658dfcef583cc1cf26b20 -- src/features/notes/useNotesWorkspace.ts
```

inventory에 “이름만 일치”, “artifact 확인”, “test 확인”, “후속 commit에서 대체”를 구분한다.

- [ ] **Step 3: verification report와 실제 test 파일을 교차 확인한다**

report가 PASS를 주장해도 연결된 test/artifact가 기준 commit에 있는지 확인한다. `independent-image-nodes.md`처럼 footer는 Completed지만 checkbox 52개가 unchecked인 문서는 report와 각 task 산출물을 별도로 대조한다.

- [ ] **Step 4: 후보 inventory를 커밋한다**

```bash
git add docs/superpowers/reports/2026-07-19-historical-plan-evidence-inventory.md
git commit -m "docs: inventory historical plan evidence"
```

### Task 3: 2026-07-10~11 계획 8개, 206개 항목을 감사한다

**Files:**

- Modify: `docs/superpowers/reports/2026-07-19-historical-plan-ledger.json`
- Modify: the first 8 plan files in the fixed audit table

- [ ] **Step 1: 각 checkbox를 task 단위로 commit diff와 artifact에 대조한다**

감사 범위는 ordinal 합계 206개다. 하나의 group으로 묶으려면 같은 disposition, 같은 commit 집합, 같은 artifact 근거가 모두 적용되어야 한다. 부분 구현 항목을 완료 group에 섞지 않는다.

- [ ] **Step 2: ledger group을 작성한다**

완료된 항목은 구현 commit과 현재 artifact/test를 모두 기록한다. 설계만 존재하면 `unimplemented`, 일부 단계만 있으면 `partial`, 후속 계획이 의도적으로 대체했으면 `superseded`로 기록한다.

- [ ] **Step 3: 각 문서 상단에 사용자용 현재 상태를 추가한다**

```md
<!-- reconciliation: auditedHead=ec8a9ff3d016449255992adf70e128ea5e222e9a status=partial -->
> **증거 대조 상태 (2026-07-19): 부분 완료.** 기준 commit과 상세 근거는 [감사 보고서](../reports/2026-07-19-historical-plan-reconciliation.md)를 참고한다.
```

표시는 `완료`, `부분 완료`, `대체됨`, `미구현` 중 ledger의 `documentStatus`와 일치시킨다.

- [ ] **Step 4: disposition에 맞게 checkbox를 수정한다**

`complete`만 `[x]`, 나머지는 `[ ]`로 둔다. 문구와 task 순서는 수정하지 않는다.

- [ ] **Step 5: 부분 검증을 실행한다**

Run: `node scripts/checkHistoricalPlanReconciliation.mjs --allow-incomplete --expect-plans=8 --expect-checkboxes=206`

Expected: 첫 8개 문서 누락/중복/digest/checkbox/evidence 오류 0.

- [ ] **Step 6: 첫 감사 묶음을 커밋한다**

```bash
git add docs/superpowers/plans/2026-07-10-*.md docs/superpowers/plans/2026-07-11-*.md docs/superpowers/reports/2026-07-19-historical-plan-ledger.json
git commit -m "docs: reconcile 2026-07-10 and 2026-07-11 plans"
```

### Task 4: 2026-07-12~14 계획 11개, 342개 항목을 감사한다

**Files:**

- Modify: `docs/superpowers/reports/2026-07-19-historical-plan-ledger.json`
- Modify: plan files #9 through #19 in the fixed audit table

- [ ] **Step 1: 342개 ordinal을 같은 증거 규칙으로 대조한다**

특히 다음 모순을 명시적으로 해소한다.

- `2026-07-13-notes-review-remediation-roadmap.md`의 단계별 목표와 후속 handoff/실제 파일 크기
- `2026-07-14-independent-image-nodes.md`의 unchecked 52개와 Completed footer
- dependency/runtime upgrade 계획의 package lock과 실제 version
- current schema reset 계획의 migration 삭제 여부와 현재 Rust schema

- [ ] **Step 2: 대체된 작업과 완료된 작업을 분리한다**

후속 architecture가 같은 목표를 다른 방식으로 달성했더라도 원래 checkbox의 구체적 산출물이 없으면 자동 `complete`로 보지 않는다. 원래 요구가 폐기되었으면 `superseded`, 결과가 동등하고 commit/test가 확인되면 근거를 적어 `complete`로 판정한다.

- [ ] **Step 3: ledger, header, checkbox를 함께 갱신한다**

Task 3과 같은 형식을 사용한다. 기존 verification footer는 삭제하지 않고, 상단의 현재 상태가 최신 감사 결과임을 명확히 한다.

- [ ] **Step 4: 부분 검증을 실행한다**

Run: `node scripts/checkHistoricalPlanReconciliation.mjs --allow-incomplete --expect-plans=19 --expect-checkboxes=548`

Expected: 누적 19개 문서, 548개 항목 오류 0.

- [ ] **Step 5: 둘째 감사 묶음을 커밋한다**

```bash
git add docs/superpowers/plans/2026-07-12-*.md docs/superpowers/plans/2026-07-13-*.md docs/superpowers/plans/2026-07-14-*.md docs/superpowers/reports/2026-07-19-historical-plan-ledger.json
git commit -m "docs: reconcile 2026-07-12 through 2026-07-14 plans"
```

### Task 5: 2026-07-15~16 계획 4개, 136개 항목을 감사한다

**Files:**

- Modify: `docs/superpowers/reports/2026-07-19-historical-plan-ledger.json`
- Modify: plan files #20 through #23 in the fixed audit table

- [ ] **Step 1: multiselect와 whole-app redesign 증거를 세부 항목별로 대조한다**

UI 존재만 보지 않고 keyboard/focus, responsive, undo grouping, disabled reason, test, screenshot/verification 같은 각 checkbox 산출물을 개별 판정한다.

- [ ] **Step 2: 기존 checked 7+19 항목도 commit과 artifact를 재검증한다**

`notes-batch-indent-selection-preservation.md`의 7개와 `detail-snapshot-readiness-loop.md`의 기존 checked 항목은 처음부터 감사한다. 체크되어 있다는 사실은 증거가 아니다.

- [ ] **Step 3: ledger, header, checkbox를 함께 갱신한다**

완료 증거가 없는 manual verification/screenshot 항목은 구현 코드가 있어도 unchecked 상태로 둔다.

- [ ] **Step 4: 전체 validator를 실행한다**

Run: `npm run test:plans`

Expected:

```text
historical plans: 23/23
checkboxes reconciled: 684/684
missing=0 duplicate=0 digestMismatch=0
checkboxMismatch=0 unreachableCommit=0 missingArtifact=0
historical plan reconciliation PASS
```

- [ ] **Step 5: 마지막 감사 묶음을 커밋한다**

```bash
git add docs/superpowers/plans/2026-07-15-*.md docs/superpowers/plans/2026-07-16-*.md docs/superpowers/reports/2026-07-19-historical-plan-ledger.json
git commit -m "docs: reconcile 2026-07-15 and 2026-07-16 plans"
```

### Task 6: 한국어 감사 보고서를 완성한다

**Files:**

- Create: `docs/superpowers/reports/2026-07-19-historical-plan-reconciliation.md`
- Modify: `scripts/checkHistoricalPlanReconciliation.mjs`

- [ ] **Step 1: ledger에서 disposition 합계를 출력하는 기능을 추가한다**

Run: `node scripts/checkHistoricalPlanReconciliation.mjs --summary-json`

Expected: 전체 및 문서별 `complete/partial/superseded/unimplemented` checkbox 수의 JSON 출력.

- [ ] **Step 2: 한국어 보고서에 기준과 전체 결과를 기록한다**

보고서에는 다음을 포함한다.

- 감사 기준 SHA와 날짜
- 대상 23개/684개, 감사 제외 규칙
- disposition별 총 checkbox 수
- 감사 전 checked 26개와 감사 후 checked 실제 수
- 문서별 현재 상태와 disposition 수
- 증거가 부족해 unchecked로 되돌린 항목
- 구현은 있으나 원 계획 요구와 달라 partial/superseded로 둔 항목
- 향후 실행 계획으로 이관된 항목

- [ ] **Step 3: 각 문서의 report link와 ledger 상태를 검사한다**

validator가 23개 문서 모두에서 동일 report link, exact audited head, computed document status를 확인하도록 한다.

- [ ] **Step 4: checkbox 통계가 일반 glob 통계와도 일치하는지 확인한다**

고정 manifest 대상만 합산하고 2026-07-19 새 계획 checkbox는 제외한다. 보고서에 “전체 plans directory glob 합계”를 사용하지 않았음을 적는다.

- [ ] **Step 5: 문서 lint 성격의 전체 검증을 실행한다**

Run: `npx vitest run scripts/checkHistoricalPlanReconciliation.test.ts && npm run test:plans && git diff --check`

Expected: fixture tests PASS, 23/684 validator PASS, whitespace 오류 0.

- [ ] **Step 6: 보고서를 커밋한다**

```bash
git add docs/superpowers/reports/2026-07-19-historical-plan-reconciliation.md scripts/checkHistoricalPlanReconciliation.mjs
git commit -m "docs: publish historical plan reconciliation"
```

### Task 7: 독립 재검산과 최종 회귀를 수행한다

**Files:**

- Modify only if evidence mismatch is found: fixed historical plan files, ledger, reconciliation report

- [ ] **Step 1: 684개 coverage를 validator와 별도 one-off 집계로 재검산한다**

Run:

```bash
node scripts/checkHistoricalPlanReconciliation.mjs --summary-json
rg -n '^\s*- \[[ xX]\]' \
  docs/superpowers/plans/2026-07-10-*.md \
  docs/superpowers/plans/2026-07-11-*.md \
  docs/superpowers/plans/2026-07-12-*.md \
  docs/superpowers/plans/2026-07-13-*.md \
  docs/superpowers/plans/2026-07-14-*.md \
  docs/superpowers/plans/2026-07-15-*.md \
  docs/superpowers/plans/2026-07-16-*.md | wc -l
```

Expected: 두 방식 모두 684.

- [ ] **Step 2: complete group의 commit과 artifact를 무작위가 아닌 전수 재검증한다**

validator의 Git 검사를 cache 없이 다시 실행하는 `--no-cache` option을 사용한다.

Run: `node scripts/checkHistoricalPlanReconciliation.mjs --no-cache`

Expected: unreachable commit 0, missing artifact 0.

- [ ] **Step 3: 문서·validator 경계에 비례한 최종 gate만 실행한다**

Run: `npx vitest run scripts/checkHistoricalPlanReconciliation.test.ts && npm run test:plans && git diff --check`

Expected: validator fixture와 23/684 evidence 검사가 PASS하고 whitespace 오류가 0이다.
Production frontend, Rust, IPC, persistence, native configuration은 변경하지 않으므로
frontend 전체 lint/test/build와 Cargo test/formatting/Clippy는 실행하지 않는다.

- [ ] **Step 4: 기준 commit 이후 감사 commit만 변경한 경로를 확인한다**

Run: `git diff --name-only ec8a9ff3d016449255992adf70e128ea5e222e9a..HEAD`

Expected: 이 계획의 구현 단계에서는 historical plan, reports, validator, package script만 추가/수정됨. 다른 production 변경이 있으면 별도 작업의 commit임을 보고서에 구분한다.

- [ ] **Step 5: 불일치 수정이 있으면 최종 교정 commit을 만든다**

```bash
git add -u -- \
  docs/superpowers/plans/2026-07-10-*.md \
  docs/superpowers/plans/2026-07-11-*.md \
  docs/superpowers/plans/2026-07-12-*.md \
  docs/superpowers/plans/2026-07-13-*.md \
  docs/superpowers/plans/2026-07-14-*.md \
  docs/superpowers/plans/2026-07-15-*.md \
  docs/superpowers/plans/2026-07-16-*.md \
  docs/superpowers/reports/2026-07-19-historical-plan-ledger.json \
  docs/superpowers/reports/2026-07-19-historical-plan-reconciliation.md
git commit -m "docs: correct historical plan evidence mappings"
```

불일치가 없으면 빈 commit을 만들지 않는다.

## 완료 판정

- [ ] 고정 manifest가 정확히 23개 문서와 684개 checkbox를 가리킨다.
- [ ] 684개 ordinal이 ledger에서 누락·중복 없이 정확히 한 번 분류된다.
- [ ] 모든 checked box는 도달 가능한 commit과 기준 commit의 artifact/test 증거가 있다.
- [ ] partial/superseded/unimplemented 항목은 unchecked이고 한국어 근거가 있다.
- [ ] 23개 문서의 상단 상태, checkbox, ledger, 한국어 보고서가 서로 일치한다.
- [ ] 새 2026-07-19 계획 checkbox는 역사 통계에서 제외된다.
- [ ] validator test, Git evidence 검사, diff 검사가 통과하고 제외한 gate 이유가 기록된다.
