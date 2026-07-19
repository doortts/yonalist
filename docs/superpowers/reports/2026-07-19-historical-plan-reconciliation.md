# 과거 계획 문서 증거 대조 보고서

## 결과

- 감사 기준: `ec8a9ff3d016449255992adf70e128ea5e222e9a`
- 대상: 23개 계획, 684개 checkbox
- 구현 증거 확인 후 완료: 22개 계획, 634개 checkbox
- 되돌림으로 미완료 유지: 1개 계획, 50개 checkbox
- 누락·중복·본문 digest 변경·checkbox 불일치·도달 불가능 commit·누락 artifact: 0

## 판정

| 기간 | 계획 | Checkbox | 상태 | 대표 증거 |
| --- | ---: | ---: | --- | --- |
| 2026-07-10 | 6 | 128 | 완료 | feature host, SQLite, outliner, discovery, export, UI parity 구현·테스트 |
| 2026-07-11 | 2 | 78 | 완료 | interaction expansion 최종 검증 보고서 |
| 2026-07-12 | 3 | 81 | 완료 | caret, multi-image, trash/history/rename 구현·테스트 |
| 2026-07-13 | 1 | 94 | 완료 | remediation branch 통합과 handoff 증거 |
| 2026-07-14 | 7 | 167 | 완료 | runtime upgrade, current schema, independent image, navigation 등 |
| 2026-07-15 | 3 | 86 | 완료 | batch indent와 multi-select 구현·회귀 테스트 |
| 2026-07-16 | 1 | 50 | 대체됨 | Graphite 통합 뒤 `f6f1d5c`에서 전체 revert |

Graphite 계획은 구현 커밋이 존재하지만 감사 기준의 최종 tree에서는 명시적으로
되돌려졌다. 따라서 50개 checkbox를 완료로 소급하지 않았다. 항목별 commit과
artifact 경로는
[`2026-07-19-historical-plan-ledger.json`](./2026-07-19-historical-plan-ledger.json)에,
고정 문서 digest와 항목 수는
[`2026-07-19-historical-plan-manifest.json`](./2026-07-19-historical-plan-manifest.json)에
기록했다.

## 범위 밖 후속 문서

감사 기준 commit 뒤 생성된 다음 문서는 고정 23개 대상에 포함하지 않았다.

- `2026-07-16-notes-mouse-multiselect.md`: 구현 commit 없이 40개가 미체크라 현재 상태와 일치한다.
- `2026-07-16-notes-theme-editor-alignment.md`: 구현 commit 2개와 8개 체크가 이미 일치한다.

## 재검증

```bash
npm run test:plans
```

검사기는 684개 ordinal의 정확한 1회 소유, marker를 제외한 본문 SHA-256,
문서 header/ledger 상태, 기준 commit 도달 가능성, 기준 tree의 artifact 존재를
검증한다.
