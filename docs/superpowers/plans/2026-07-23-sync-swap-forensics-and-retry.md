# Notes DB 교체 오류 — 범인 표시 + 재시작 없는 복구 (설계)

- 작성: 2026-07-23 (Fable). 구현: Opus 4.8, TDD, 항목당 1커밋.
- 배경: 사용자가 배지 오류 "The active Notes connection and pathname database disagree before WAL validation." 조우. 원인 = 실행 중 DB 파일 외부 교체(연결 identity 검증이 차단). 현재 권고가 "앱 재시작"뿐이고, 무엇이 언제 바뀌었는지 정보가 없음.
- 대상: `src-tauri/src/notes/connection.rs`, `src-tauri/src/notes/sync/runtime.rs`, `src/features/notes/NotesSyncStatusBadge.tsx`(+test), 필요시 `NotesDataSettingsDialog.tsx` 문구.

## 항목 1 — 교체 포렌식을 오류에 동봉
`fix(notes): describe the database swap inside identity errors`

- connection.rs의 연결-identity/WAL-binding 검증 실패 문장들("…disagree before WAL validation.", "…not bound to the pathname shared-memory file.", "…not bound to the pathname WAL file.", notes_database_has_moved 계열) 뒤에 포렌식 한 줄 첨부:
  `" Swap detail: notes.sqlite changed at {로컬 HH:MM:SS} ({size} bytes, file id {old}->{new})."`
- 구현: `fn describe_notes_database_swap(path: &Path, bound: &NotesDatabaseFileIdentity) -> String` — 경로의 현재 stat(mtime·size·dev/inode)과 bound identity 비교, best-effort(stat 실패 시 "current file is missing"). 각 실패 지점에서 호출해 문자열에 append.
- **선두 문장은 바이트 그대로 유지** — 프런트 배지가 문장 매칭하고 기존 테스트가 단정함. 첨부는 뒤에만.
- TDD: identity 바인딩 후 파일 교체 → 오류 문자열에 `Swap detail:`·inode 변화·시각 포함 단정. stat 불가 케이스 1개.

## 항목 2 — "동기화 재시도"가 교체도 복구
`feat(notes): recover a swapped database through sync retry`

- 기존 `notes_sync_retry_quarantined`(R13) 확장 — 재시도 시 무조건적으로:
  1. `evict_notes_connection(vault_path)` — 낡은 연결 폐기(다음 접근이 경로의 현재 파일을 새로 엶),
  2. 기존 시작-조정(reconcile) 재실행(해시 비교 + 병합 — bootstrap의 기존 함수 재사용),
  3. dirty flush,
  4. 성공 시 status 갱신(running:true, lastError 클리어) emit.
  분기 없이 무조건 실행이 단순하고 안전(reconcile 멱등, 평시 수 ms). 의미론 = 앱 내 재시작. 교체로 유실될 수 있는 것은 재시작과 동일 범위(외부 교체가 이미 일어난 시점의 손실이며, vault 파일 재병합의 부재≠삭제가 노트를 보호).
- 프런트: `NotesSyncStatusBadge.tsx:32`의 권고 문구를 "Open Notes data settings and run Retry sync, or restart Yonalist. …" 로 갱신(+기존 테스트 갱신). 다이얼로그 버튼은 기존 그대로 이 명령 호출.
- TDD: (rust) 열린 연결 밑에서 파일 교체 → identity 오류 발생 확인 → `notes_sync_retry_quarantined` → status running:true + lastError 없음 + 이후 export가 새 파일에 성공. (ts) 배지 문구 테스트 갱신.

## 공통 규율
- 브랜치 `sync-swap-recovery` (전용 worktree — 메인 워킹트리에 모션 작업 미커밋분 있음, 접근 금지).
- 항목당 1커밋(위 제목 그대로), TDD red 증거 기록, 신규 테스트에 order-observation 금지 패턴 사용 금지.
- 게이트: `npx tsc --noEmit && npm run lint && npm run test:architecture && npx vitest run` + `cd src-tauri && cargo test`. 전부 green.
- 불변 규칙(선행 스펙 §1) 위반 금지 — 특히 부재≠삭제, 멱등 병합.
