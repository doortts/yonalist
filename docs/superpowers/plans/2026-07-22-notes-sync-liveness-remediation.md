# Notes 파일 SSOT 동기화 — Liveness/유실 결함 해소 계획 (독립 계획)

- 작성: 2026-07-22. 선행: `2026-07-21-notes-file-ssot-sync-implementation.md` (구현 완료, 적대 리뷰 통과 결함 목록이 본 계획의 입력).
- 원칙: 기존 스펙의 불변 규칙 10개 전부 유지. 본 계획은 규칙을 바꾸지 않고 "조용히 멈춤/조용히 지움" 경로를 제거한다.
- 실행 체제: 설계·리뷰 Fable xHigh, 코드 Opus 4.8 xHigh. 3개 병렬 트랙(파일 소유권 분리) → 통합 → 적대 리뷰 → 재작업.
- 공통 신규 규칙 (불변 규칙 11로 추가): **영구 재시도 금지.** 동일 대상 export/merge가 연속 3회 같은 오류로 실패하면 해당 topic을 격리(quarantined=1)하고 `notes://sync-status`로 통지한다. wedge는 반드시 가시화된다.

## Track A — 포맷/병합 코어 (파일: topic_parser.rs, topic_file.rs, merger.rs, exporter.rs의 스냅샷/렌더부, repository.rs 가드 1개, fixtures, 스펙 문서)

### A1. 공백 왕복 보존 (P0-1)
- 문제: 파서가 title/before의 trailing whitespace, image after의 leading whitespace를 버림 → render≠parse → 자가 검증 영구 실패.
- 설계: **파서가 공백을 보존한다** (렌더러는 무변경).
  - bullet 라인: 주석 분리를 `rfind(" <!-- ")` 정확 경계로 — title = 그 경계 앞 전체(구분자 공백 1개만 제거, `trim_end()` 금지). `topic_parser.rs:407` `split_trailing_comment` 수정.
  - image after 연속 라인: 들여쓰기 접두사(depth×2 스페이스)만 정확히 제거하고 나머지 보존 (`split_indentation` 사용처 분기).
  - note blockquote는 기존 그대로(`> ` 뒤 보존 이미 확인됨).
- 테스트: 공백 코퍼스 property test — title/before/after 각각에 `"x "`, `" x"`, `"x  "`, `" "`, `"\u{3000}x "` 를 넣고 render→parse→render 바이트 동일. exporter 자가 검증 통과 통합 테스트 1개.
- 수용: `"milk "` 제목으로 export가 성공하고 dirty가 해소된다.

### A2. 캡 정렬 + 병합측 repair (P0-2)
- 문제: 파서 캡(2,000노드/depth 64/16MiB)이 DB 상태보다 작아 자기 export를 자기 파서가 거부 → 영구 wedge. depth는 병합으로도 초과 가능.
- 설계:
  1. 파서 캡을 기존 export 상수에 정렬: 노드 `MAX_NOTES_EXPORT_NODES(20_000)`, depth `MAX_NOTES_EXPORT_DEPTH(128)`. 16MiB 유지.
  2. repository에 depth 가드 1개: create/move/indent가 depth 128 초과를 만들면 명령 에러 (모든 호출이 지나는 공통 지점에 — `next_sort_key`류가 아니라 parent 결정 지점).
  3. 병합으로 depth 128 초과 발생 시: 초과 서브트리 루트를 복구 topic으로 park (기존 cycle-park 인프라 재사용, fresh HLC, 결정적 tie-break 동일).
  4. exporter pre-render 검사: 렌더 대상이 캡 초과면 그 target을 **격리+status 이벤트** (silent 재시도 루프 금지 — 공통 규칙 11).
  5. trash.md: 노드 수가 20,000 초과 시 초과분(HLC 오래된 순)을 `trash-archive-<seq>.md` write-once 세그먼트로 이관. 파서는 `trash-archive-*.md`를 trash와 동일 문법으로 수용(병합 입력). 세그먼트는 재작성하지 않는다.
- 테스트: depth 129 명령 거부, 두 유효 파일 병합→depth 초과→park 결정성(양 장치 동일), trash 20k+1 세그먼트 이관 후 export 성공, 캡 초과 격리 이벤트.

### A3. topic 루트 note 슬롯 + 루트 kind 고정 (P0-5)
- 문제: 포맷에 루트 note 슬롯 없음 → 원격 루트 승리가 note를 `""`로 덮어씀. 이미지 노드가 루트가 되면 병합이 kind/attachment 파괴.
- 설계:
  1. 포맷: `# title` 직후, 첫 bullet 전에 depth-0 blockquote(`> …`)를 루트 note로 렌더/파스. format_version 2 유지(additive).
  2. merger 루트 RemoteNode에 파싱된 note 사용 (`merger.rs:253` `String::new()` 제거).
  3. repository 가드: 이미지 노드의 root 승격(move to parent NULL) 금지 — 루트는 항상 Text. (기존 데이터엔 해당 케이스 없음 — 개발 단계.)
- 테스트: 루트 note 왕복, 원격 루트 star 토글이 로컬 루트 note를 보존, 이미지 루트 승격 거부.

### A4. equal-HLC 내용 상이 = 손편집으로 채택 (P1)
- 문제: yid/t 유지한 채 텍스트만 고친 손편집이 조용히 버려지고 그 바이트가 echo hash로 축복됨.
- 설계: merger equal-HLC 분기에서 내용 비교 — 다르면 **파일 내용을 fresh HLC로 채택**(사용자가 보는 진실은 파일) + write-back. 같으면 기존대로 skip.
- 테스트: 손편집 채택·전파, 동일 내용 skip 유지, 멱등(채택 후 재병합 no-op).

### A5. unseen yid + empty/불량 hlc = 신규 입력으로 채택 (P1)
- 문제: 주석 형식을 흉내 낸 손작성 bullet이 write-back으로 디스크에서 삭제됨. 손작성 topic 파일(root_hlc 없음)은 RemoveTopic 영구 실패 루프.
- 설계: 로컬 행이 없고 hlc가 비어 있으면 **no-yid 경로와 동일하게 fresh UUID+HLC 발급**(내용 보존). 손작성 root(id 있음, root_hlc 없음)도 fresh HLC로 root 채택 — RemoveTopic 경로 도달 불가로.
- 테스트: 형식 흉내 bullet 보존, root_hlc 없는 손작성 파일이 정상 topic으로 편입, RemoveTopic 루프 재현 테스트가 통과로 전환.

### A6. 정리 (P2)
- golden fixture 재생성: off-spec `from:` 제거(topic), 현실적 max_hlc(파일 내 최대와 일치), 루트 note 예시 포함.
- 선행 스펙 문서 §7.1 `16자` → `17자` 수정, §7.1에 루트 note blockquote 추가, `assetIngestProgress.ts` 경로를 실제(`src/services/`)로 수정.

## Track B — 런타임/수명주기 (파일: runtime.rs, watcher.rs, exporter.rs의 루프/publish부, bootstrap.rs, lib.rs, useFlushDraftsOnWindowClose.ts, .github/workflows/ci.yml)

### B1. flush-on-close 배선 (P0-3)
- TS: `useFlushDraftsOnWindowClose`의 기존 flush 완료 후 `notesSyncFlush(vaultRoot)` 호출(실패 무시하되 console.warn).
- Rust: `lib.rs` builder에 `on_window_event`/`RunEvent::ExitRequested` 훅 — `SyncState`의 runtime `stop()`(최종 강제 export 포함) 호출 후 종료 진행. tao `process::exit` 경로에서도 실행되는 위치에.
- 테스트: Rust — stop이 dirty를 flush하는 기존 테스트에 exit-hook 경유 케이스 추가. TS — window close 시 notesSyncFlush 호출 vitest.

### B2. 스레드 panic 가시화 + 재시작 (P1)
- exporter/watcher 루프를 `catch_unwind`로 감싸고 panic 시: 내부 health 플래그 설정, `notes://sync-status`에 `running:false` + `lastError` 방출.
- `SyncStatus`에 `lastError: Option<String>` 필드 추가 (TS contract 동기 — Track C와 필드명 사전 합의: `lastError`).
- `notes_sync_start`: 기존 runtime의 JoinHandle `is_finished()` 헬스체크 — 죽어 있으면 정지·재기동(멱등 유지).
- 테스트: 강제 panic 주입(테스트 훅) 후 status가 running:false, start 재호출로 복구.

### B3. Finder 파일 삭제 대응 (P1)
- watcher가 Remove 이벤트/주기 스캔 소실 감지 시: 해당 topic dirty 마킹 → 다음 export가 파일 재생성(부재≠삭제 일관) + `notes://sync-status`로 "파일 소실 감지, 복원함" 통지.
- `// ponytail:` 주석: 사용자 확인 다이얼로그는 생략 — 앱 내 삭제가 정식 경로, 필요 시 추가.
- 테스트: 파일 삭제 → 재export 복원 + 이벤트.

### B4. 연결 락 밖으로 파일 I/O 이동 (P1)
- export: 락 안에서 스냅샷 렌더+dirty 마커 캡처 → **락 해제** → write_atomic_file → 재획득 후 exported_hash 기록+캡처 마커 삭제(기존 정확 일치 삭제 로직 재사용). 에코 창: 쓰기~해시기록 사이 watcher가 자기 파일을 읽을 수 있으나 병합 멱등으로 무해(기존 crash 경로와 동일) — 주석으로 명시.
- watcher의 staged-file retirement도 동일 패턴.
- 테스트: 기존 에코/정확-삭제 테스트 유지 통과 + 쓰기 중 병합 진입 통합 테스트.

### B5. 시작 watch 공백 제거 (P1)
- 순서 변경: watcher 등록·이벤트 버퍼링 시작 → reconcile 실행 → 버퍼 처리. reconcile 중 도착 이벤트 유실 불가.
- 테스트: reconcile 중 파일 변경 주입 → 병합됨.

### B6. 자가 검증 실패 = 격리+통지 (공통 규칙 11 구현)
- `publish_export_snapshot` 실패 3회 연속 → 대상 topic 격리 + status 이벤트 + dirty 유지(격리 해제 시 재시도). merge 하드 에러도 동일.
- 테스트: 검증 실패 주입 3회 → 격리 이벤트, 격리 해제 후 재개.

### B7. 정리 (P2)
- `.yonalist/sync-cleanup/consumed/` 30일 초과분 삭제(asset GC tick에 편승). 복구 파일 확장자 `.md` → `.recovered.txt`(재파싱 루프 제거, bootstrap 필터 무변경으로 자동 제외).
- ci.yml에 `cargo test -- --ignored` 성능 게이트 단계 추가.
- vault 스위치 시 최종 export 실패를 하드 에러 대신 경고+진행(`stop()` 결과 분리).

## Track C — 자산/프런트 (파일: asset_gc.rs, src/services/*, src/features/notes/* 프런트, appSettings.ts)

### C1. GC 최소 연령 + 격리 가드 (P0-4)
- 참조 이력이 전혀 없는 hash의 격리 조건에 `now - mtime >= 24h` 추가(설정 불필요, 상수).
- 격리된 topic이 하나라도 있으면 quarantine 단계 전체 skip (한 쿼리 가드) — 격리 topic의 미삽입 참조 보호.
- 테스트: 신선한 미참조 파일 보존, 24h 경과 후 격리, 격리 topic 존재 시 skip.

### C2. GC per-record 격리 (P1)
- 레코드 단위 오류는 수집 후 계속 진행(전체 pass 중단 금지). symlink/hardlink 파일은 skip+수집. 수집 결과는 status 이벤트 `lastError`에 요약.
- 테스트: 불량 레코드 1개 있어도 나머지 격리/복원/만료 진행.

### C3. 상태 가시화 (P1)
- `notesWorkspaceRuntime`의 listener 연결에 `onStatus` 배선 → 워크스페이스 상태에 `syncStatus` 보관(별도 파일, budget 준수).
- UI 최소치: Notes 상단에 격리/오류 시에만 나타나는 배지 1개 + `NotesDataSettingsDialog`에 상태 섹션(격리 topic 목록, lastError, 마지막 export/merge 시각). 신규 대형 UI 금지.
- `notes_sync_start` 실패: catch에서 삼키지 말고 status 콜백에 오류 전달(위 배지 경로 재사용) + 다음 워크스페이스 재활성 시 재시도 유지.
- 테스트: 격리 이벤트 → 배지 렌더, start 실패 → 오류 표시 vitest.

### C4. 진행율 UI 장착 (P1)
- `startAssetIngestProgressListener`를 `useNotesAttachmentWorkflow`(기존 ingest 오케스트레이션 지점)에 mount. 이미지 플레이스홀더에 % 오버레이(기존 residency placeholder 컴포넌트 확장, 최소 스타일). dedup 히트는 즉시 done — 오버레이 생략.
- batch: `bytesTotal` 증분 문제는 백엔드 무수정으로 프런트에서 "파일 i/N" 텍스트 병기로 회피. `// ponytail:` 주석.
- 테스트: 진행 이벤트 시퀀스 → 오버레이 상태 vitest.

### C5. 정리 (P2)
- `hasExactKeys` → 필수 키 존재+타입 검사로 완화(초과 키 허용, 전방 호환). `SyncStatus`에 `lastError` 추가 반영(Track B와 합의된 필드).
- `normalizeAssetSetting`: 비정수 입력 반올림 clamp(기본값 리셋 금지).
- `notesSyncContract` 부정 케이스 테스트 추가.
- 설정 변경이 재시작 시 적용됨을 설정 UI에 문구 1줄.

## 트랙 간 계약 (충돌 방지)
- `SyncStatus.lastError: Option<String>` — Track B가 Rust에 추가, Track C가 TS contract에 추가. 필드명 고정: `lastError`.
- exporter.rs: Track A는 `build_topic_doc`/렌더 입력부만, Track B는 publish/루프/락부만 수정. 같은 함수 동시 수정 금지.
- 격리+통지 헬퍼(공통 규칙 11)는 Track B가 만들고(A는 exporter pre-check에서 그 헬퍼 호출 — 시그니처: `quarantine_target(conn, target, reason) -> emit`), 통합 단계에서 연결.

## 게이트 (각 트랙 + 통합, 전부 필수)
```
npm run lint && npx tsc --noEmit && npm test && npm run test:architecture
cd src-tauri && cargo test
```
- 통합 후 추가: `cargo test -- --ignored` (성능 계약), 기존 §12 통합 시나리오 10개 회귀 무결.
- budget: `notesWorkspaceRuntime.ts` 현재 1500/1500 — 트랙 C는 runtime에 코드를 추가하지 말 것(새 파일로). 불가피하면 `scripts/checkNotesWorkspaceBudgets.mjs` 상수 1500→1600, order-obs 283→300 bump 허용(커밋 메시지에 명시).
- 알려진 무관 실패 1건: `NotesWorkspace.test.tsx > serializes rapid non-repeat collapse commands…` — main caret 회귀(별도 태스크). 이 테스트만 실패는 게이트 통과로 간주하되 다른 실패와 혼동 금지.
```
