# Notes Workspace facade 리팩터링 검증

## 범위와 기준

- 구현 직전 기준 commit: `ddb965c87688d65e578f46ea9962ff691b33e52e`
- 구조 분해 commit: `db5117b`
- 테스트 예산·분산 commit: `bab1651`
- 최종 bundle 분할 commit: `5d10b23`
- 변경 범위: React/TypeScript Notes runtime, 테스트, frontend bundle gate
- 제외 범위: Rust, Tauri IPC payload, SQLite schema, native 설정

## 구조·테스트 예산

수치는 `wc -l`, `npm run test:architecture`의 실제 출력이다.

| 지표 | 구현 직전 | 최종 | 예산 | 판정 |
| --- | ---: | ---: | ---: | --- |
| `useNotesWorkspace.ts` | 6,184 | 7 | ≤1,500 | PASS |
| 내부 `notesWorkspaceRuntime.ts` | 단일 hook 내부 | 1,425 | ≤1,500 | PASS |
| 가장 큰 추출 production 모듈 | 해당 없음 | 1,490 | ≤1,500 | PASS |
| `useNotesWorkspace.test.tsx` | 21,349 | 4,404 | ≤5,500 | PASS |
| `toHaveBeenNthCalledWith` | 14 | 0 | 0 | PASS |
| `invocationCallOrder` | 10 | 0 | 0 | PASS |
| indexed `mock.calls[...]` | 155 | 21 | ≤25 | PASS |
| 전체 test 순서 관찰 | 283 | 282 | ≤283 | PASS |

runtime은 history, draft, command actions, library, attachment, selection,
navigation, image-recovery 경계로 나눴다. 새 전역 store나 event bus는 추가하지 않았고
기존 reducer/coordinator/ref 계약을 그대로 조합한다. 통합 테스트 본문은 삭제하지
않고 image import, operations, selection/projection, shared session, navigation 경계의
6개 파일로 분산했다.

## 기능 검증

| 명령 | 결과 |
| --- | --- |
| `npm test` | 182 files PASS, 1 file skipped; 3,748 tests PASS, 27 skipped |
| Notes facade/context/selection 집중 묶음 | 368/368 PASS |
| 분산된 workspace 테스트 6개 파일 | 363/363 PASS |
| 날짜 선택기·integration·bundle checker | 50/50 PASS |
| lazy picker를 사용하는 page/row UI | 139/139 PASS |
| `npx tsc --noEmit` | PASS |
| `npm run lint -- --quiet` | PASS |
| `npm run test:plans` | 23/23 문서, 684/684 checkbox PASS |

Rust/IPC/schema/native 설정 변경이 없으므로 프로젝트 전달 규칙에 따라 Cargo 검증은
실행하지 않았다.

## bundle 수치

`npm run build:analyze`는 manifest, 실제 byte, Node `gzipSync`, sourcemap source를
읽는다. controller 분해 직후 Notes entry raw는 `504,663`으로 `<500,000` 예산을
`4,664` 초과했다. 예산을 바꾸지 않고 날짜 선택기를 최초 사용 시점으로 분리했다.

| 지표 | 최종 | 예산 | 판정 |
| --- | ---: | ---: | --- |
| 초기 정적 JS raw | 744,596 | 917,136 | PASS |
| 초기 정적 JS gzip | 232,611 | 276,839 | PASS |
| App raw | 289,191 | <500,000 | PASS |
| App gzip | 84,859 | 150,000 | PASS |
| Notes entry raw | 442,144 | <500,000 | PASS |
| 첫 Notes 정적 route raw | 566,748 | 574,719 | PASS |
| 첫 Notes 정적 route gzip | 162,060 | 165,751 | PASS |
| App map Notes / dnd-kit | 0 / 0 | 0 / 0 | PASS |
| Notes map dnd-kit / date-picker | 0 / 0 | 0 / 0 | PASS |

날짜 선택기 on-demand chunk는 raw `13,927`, gzip `4,204` bytes다. 직전 동일
route 기준 raw `574,719`, gzip `165,751`보다 최초 Notes route는 raw `7,971`
(`1.39%`), gzip `3,691` bytes(`2.23%`) 작다. 실행 시간으로 환산하지 않았다.

## 미완료·차단 항목

기존 `NOTES_PERF=1` gate는 27개 중 19개 통과, 8개 실패다. 같은 8개는 구현 직전
commit에서도 실패했으며 기록 baseline/`1.20x` 한계를 완화하지 않았다. 따라서 이
gate는 PASS가 아니다.

fresh release 앱은 Tauri mount와 Vault load를 기록했지만 macOS native window가
0개여서 첫 Notes 클릭, Inbox 왕복, Undo/Redo, 이미지 재시도의 수동 증거를 만들 수
없었다. 통합 테스트 결과로 이 항목을 대신 PASS 처리하지 않는다.
