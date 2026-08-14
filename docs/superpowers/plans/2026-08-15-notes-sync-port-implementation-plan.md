# Notes 파일 SSOT 동기화 v2 이식 — 구현 계획

- 작성: 2026-08-15. 기준: `main@d627d228`, 작업 트리 clean(미추적 `docs/architecture-report.html` 제외).
- 상위 결정 문서: [2026-08-14 파일 SSOT 포팅 계획](2026-08-14-file-ssot-multi-device-port.md) (WHAT의 진실 소스), [2026-08-14 구조 감사 로드맵](2026-08-14-yonalist-structure-audit-and-roadmap.md), [2026-07-21 v1 sync 스펙](2026-07-21-notes-file-ssot-sync-implementation.md).
- 짝 문서: [TDD 테스트 설계](2026-08-15-notes-sync-port-test-design.md). 이 계획의 모든 항목은 그 문서의 테스트와 1:1로 짝을 이룬다.
- 이 문서의 모든 `file:line`은 2026-08-15 코드에서 직접 확인한 값이다. 원본 계획의 주장과 코드가 어긋나는 지점은 §2에 모았다.

## 0. 확정 사항 (재론 금지)

원본 계획 §7의 결정 6건은 사용자가 권고안대로 확정했다.

| # | 결정 |
|---|---|
| 1 | transport: 클라우드 폴더 동기화(iCloud/Dropbox/Syncthing/OneDrive) 공식 지원. git은 "동작하지만 미보증"으로 문서화 |
| 2 | 같은 노드 동시 편집: LWW + conflict log. 3-way 텍스트 병합은 로그에 실충돌이 쌓이면 그때 |
| 3 | collapsed 상태: 파일에 기록, 기기 간 공유 |
| 4 | tombstone 창: 90일 유지 + 창을 넘긴 스냅샷은 격리 후 사용자 확인 |
| 5 | 충돌 노출: 설정 화면 목록 + 복구 버튼. 노드 인라인 배지 없음 |
| 6 | 포맷 버전: v5 재정의. 파서는 v1/v4 vault를 관대하게 읽고 미지 필드를 보존 |

범위 결정: **M0–M6 전부를 항목·의존·완료 조건 입도로 다루고, M0·M1은 추가로 실행 수준(커밋 단위 항목 + 항목별 red 테스트)까지 확정한다.** M2–M6의 실행 수준 분해는 선행 마일스톤의 코드가 생긴 뒤에 한다.

### 마이그레이션 결정 (사용자 확정)

**릴리즈 전 마이그레이션 금지가 이긴다.** 원본 계획 §6 M1의 "마이그레이션 사다리 골격 먼저" 항목은 삭제한다. 스키마는 `user_version = 1`(`crates/notes-sqlite/src/schema.rs:4`, `:213`)로 고정한 채 `schema.rs`를 직접 수정하고, 버전 승급·호환 리더·마이그레이션 경로를 만들지 않는다. 개발 DB는 아래 §5.2의 리셋 절차로 재생성한다. 스키마 창의 나머지 항목(`notes_nodes.hlc`, `sync_dirty_nodes`, `sync_topics`, `sync_purged_tombstones`, `sync_conflict_log`, `sync_meta`)은 그대로 M1에 싣는다. 사다리가 전제가 아니었으므로 M1의 순서만 바뀐다. 뷰포트 정렬 키 물질화는 스키마 창의 유효 항목으로 남지만 sync와 무관하므로 이 이식의 범위 밖이다(릴리즈 전에는 언제든 제자리 수정이 가능하니 순서 제약도 없다). 마이그레이션은 계약에 릴리즈나 하위 호환 요구가 명시로 들어올 때 다시 꺼낸다(§8 비대상에 기재).

## 1. 코드 실측

### 1.1 이식 원본 (v1, `src-tauri/src/notes/`)

| 모듈 | 줄 수 | `#[test]` |
|---|---:|---:|
| `sync/merger.rs` | 6,766 | 90 |
| `sync/asset_gc.rs` | 7,014 | 83 |
| `sync/exporter.rs` | 4,847 | 41 |
| `sync/bootstrap.rs` | 3,089 | 26 |
| `sync/topic_parser.rs` | 2,785 | 75 |
| `sync/watcher.rs` | 2,591 | 35 |
| `sync/runtime.rs` | 2,156 | 20 |
| `sync/integration_tests.rs` | 1,875 | 22 |
| `sync/maintenance.rs` | 1,682 | 26 |
| `sync/repair.rs` | 964 | 11 |
| `sync/topic_file.rs` | 910 | 16 |
| `sync/mod.rs` | 129 | 0 |
| `hlc.rs` | 437 | 8 |
| `file_io.rs` (루트) | 3,859 | 41 |
| **합계** | **39,104** | **494** |

golden fixture: `src-tauri/src/notes/sync/fixtures/topic_golden.md`(format_version 4), `github_notifications_golden.md`, 인라인 `TRASH_GOLDEN`(`topic_parser.rs:1325`).

### 1.2 이식 대상 (v2)

- 워커: `crates/notes-sqlite/src/worker.rs` — 단일 스레드 `notes-v2-db`가 Connection을 소유(`:155` `mpsc::sync_channel(64)`, 요청 enum `:21-72`, 루프 `:186-263`). 모든 읽기·쓰기가 이 큐를 지난다.
- revision 낙관적 동시성: DB 쪽 검사 `crates/notes-sqlite/src/mutations.rs:18-30`(`notes_meta.revision` 불일치 → `StorageError::RevisionConflict`), 서비스 쪽 사본 `crates/notes-application/src/service.rs:30`·검사 `:372-382`.
- undo 스택: `crates/notes-application/src/service.rs:28-35` — `SessionState.undo/redo: Vec<NotesServiceHistoryEntry>`(메모리, `TreeMutation` forward/inverse 보관). SQLite에는 없다.
- DB 위치: `apps/desktop/src-tauri/src/lib.rs:399`(`notes-v2.sqlite` open), `:505-508`(`app_data_dir` + `YONALIST_V2_DATA_DIR` 오버라이드).
- 이미지: 앱 로컬 캐시 `app_data_dir/images/<hash>.<ext>`(`crates/notes-sqlite/src/image_assets.rs`). vault에는 아무것도 없다.
- 프런트 반영 경로: `apps/desktop/src/store/storeCommands.ts:94` `applyReceipt(receipt)` — 자기 명령의 영수증만 반영한다. Tauri 이벤트는 백엔드 emit 0건, 프런트 `@tauri-apps/api/event` 사용 0건.
- 아키텍처 검사: `scripts/checkV2Architecture.mjs` — 크레이트 의존 그래프 `:7-11`, Tauri 명령 화이트리스트 `:137-162`, 권한·build.rs 대조 `:175-189`.
- 게이트 스크립트(`package.json`): `test:v2` = `cargo test --workspace && test:v2:frontend && lint:v2 && test:v2:architecture && test:v2:contracts`. 그 밖에 `test:v2:bundle`, `test:v2:performance`(`--features bench-fixtures --release`).
- 계약 생성: ts-rs → `packages/contracts/generated/*.ts`, `scripts/checkV2Contracts.mjs`가 `cargo test -p notes-application export_bindings` 재생성본과 커밋본을 비교.
- proptest는 이미 워크스페이스에 있다: `crates/notes-core/Cargo.toml` dev-dependencies `proptest = "1.9.0"`.

## 2. 원본 계획 정정 (코드 대조 결과)

| # | 원본 주장 | 코드 사실 | 처분 |
|---|---|---|---|
| 1 | §3.2 "v2에는 이미 변경 통지 계약이 있다" | 반만 맞다. revision 계약은 있으나(`mutations.rs:18-30`, `service.rs:372-382`) **Rust→프런트 push 채널이 없다.** 어댑터에 이벤트 emit 0건, 프런트에 listen 0건. 프런트는 자기 명령의 `MutationReceipt`로만 변경을 안다 | `notes://sync-changed`는 이 앱 최초의 Tauri 이벤트로 M5에서 신설. 수신 후 반영은 기존 `applyReceipt` 모양을 재사용 |
| 2 | §3.1 의존 방향 `notes-sync → notes-sqlite → notes-application → notes-core` | 이 방향으로는 워커가 병합을 실행할 수 없다. 워커 루프가 `notes-sqlite`에 있고(`worker.rs:186-263`) 병합 명령을 처리하려면 notes-sqlite가 merger를 호출해야 한다. 원안 방향은 순환이거나 revision 규율을 우회하는 범용 Connection 탈출구를 요구한다 | **방향 역전 확정: `notes-sqlite → notes-sync → notes-application → notes-core`.** notes-sync는 `&mut Connection` 위의 순수 라이브러리(포맷·hlc·병합 SQL), notes-sqlite 워커가 호출자 |
| 3 | §3.4 "`lib.rs:271`" | 실제는 `apps/desktop/src-tauri/src/lib.rs:399`와 `:505-508`. `:271`은 삭제 파일 목록이다 | 사실 자체(`notes-v2.sqlite`는 `app_data_dir`)는 맞음. 좌표만 보정 |
| 4 | §4.1 "v1 `asset_gc.rs:34`의 24시간 하드코딩 — 수리 대상" | `asset_gc.rs:35` `MIN_UNREFERENCED_QUARANTINE_AGE`(24h)는 ingest 경합(자산 바이트가 DB 행보다 먼저 도착) 보호용 의도된 상수다. 주석이 근거를 명시한다. tombstone 창과 무관 | 수리 대상 아님. 이식 시에도 상수 유지 |
| 5 | exporter N+1 `exporter.rs:262` | `:262`는 단일 JOIN 질의(`load_pending_exports`)의 시작. N+1의 실체는 그 결과를 소비하는 `:287-330` 루프 — dirty 노드마다 `resolve_topic_id`(`:427` 재귀 CTE)와 `metadata_quarantined`(`:316-320`)를 2~3회 실행하고, `runtime.rs:777`의 1초 tick이 디바운스 만기까지 이를 재평가한다 | 주장 실질 유효. 수리 지점은 루프의 노드당 질의를 상수 개 질의로 바꾸는 것 |
| 6 | 1초 폴링 `runtime.rs:776` | `:776`은 `// ponytail: 1s poll` 주석, 실코드는 `:777` `recv_timeout(Duration::from_secs(1))` | 유효. v2에서는 커밋 훅 poke + 디바운스 만기 기반 `recv_timeout`으로 대체(§4.4) |
| 7 | conflict log 쓰기 전용 `merger.rs:2048` | insert `:2046-2056`. 유일한 SELECT는 `:3841`인데 `#[cfg(test)]` 안이다(테스트 모듈 시작 `:2394`). 제품 읽기·정리 경로 없음 | 유효. M3에서 읽기 IPC + 보존 상한 신설 |
| 8 | 마일스톤 M0–M6에 이미지 자산 파이프라인이 없다 | v2 이미지는 앱 로컬 캐시에만 있다. 멀티 디바이스로 가려면 vault로의 바이트 방출과 vault에서의 인입이 실작업인데 원본 §6 어디에도 항목이 없다. 크레이트 목록의 `asset_gc`도 마일스톤에 집이 없다 | 자산 방출은 M4, 인입은 M5에 항목 신설. vault 쪽 asset GC는 비대상(후속) — 없어서 생기는 손해는 디스크 낭비뿐이고 잘못 만들면 데이터 손실이다 |
| 9 | "v1 sync 실측 38,667줄" | 이번 측정 39,104줄(§1.1 — sync/ 34,808 + hlc 437 + file_io 3,859) | 기록만. 결론 불변 |
| 10 | §6 M1 "마이그레이션 사다리 골격 먼저" | 사용자 결정으로 삭제(§0) | — |

§0 표의 나머지 인용은 검증 결과 정확하다: tombstone 90일 `sync/mod.rs:62`, A4 손편집 수용 `merger.rs:2023-2041`, conflicted copy 보존 `watcher.rs:511-519`, placeholder 재시도 테스트 `watcher.rs:2104`.

## 3. 전체 계약

| 필드 | 내용 |
|---|---|
| Goal | 두 대 이상의 기기가 하나의 vault 폴더(클라우드 폴더 동기화)로 Notes를 자동 수렴시킨다. markdown 파일이 기기 간 진실 소스, `notes-v2.sqlite`는 앱 로컬 런타임 진실이다 |
| Acceptance | 아래 7행. 각 행은 마일스톤 하나에 대응한다 |
| Non-goals | §8 |
| Boundaries | Rust(신규 크레이트 notes-sync + notes-sqlite + notes-application + adapter), SQLite 스키마(제자리 수정), 파일시스템(vault), IPC(신규 명령·최초 이벤트), React(설정 화면·listener), macOS 런타임 |
| Manual proof | 마일스톤별 표에 기재. 공통 격리: `YONALIST_V2_DATA_DIR=<임시 디렉터리> npm run tauri:dev` + 임시 vault 폴더 |

| 행 | 관찰 가능한 합격 조건 | 항목 |
|---|---|---|
| A1 | v5 스펙 문서가 존재하고 결정 6건·불변 규칙·golden 초안을 담는다 | M0 |
| A2 | 기존 mutation 명령이 무수정으로 HLC 스탬프·dirty 기록을 남기고 vault 위치를 설정에서 지정·유지할 수 있다 | M1 |
| A3 | 같은 DB 상태는 바이트 동일한 v5 파일로 렌더되고 v5·v4 파일이 손실 없이 왕복한다 | M2 |
| A4 | 파일 병합이 워커 큐를 지나 revision을 올리고 undo가 병합된 노드를 넘어 내려가지 않으며 충돌이 설정 화면에서 복구된다 | M3 |
| A5 | 편집 후 디바운스 안에 vault 파일과 자산이 자가 검증을 거쳐 원자적으로 방출된다 | M4 |
| A6 | 외부 파일 변경이 감시·병합·이벤트로 UI에 반영되고 재시작 시 변경분만 재색인된다 | M5 |
| A7 | 두 DB 인스턴스가 한 vault로 v1 §12 매트릭스 + 신규 4시나리오를 수렴시키고 성능 계약을 지킨다 | M6 |

## 4. 아키텍처 확정

### 4.1 크레이트 배치와 의존 방향

```
apps/desktop/src-tauri        SyncRuntime 수명주기(스레드 시작/정지, 이벤트 emit), vault 설정, StartupGate 편승
crates/notes-sqlite           워커(Request::MergeTopic 등 신규 요청), 스키마 창, yona_hlc 등록   ── depends on ──▶
crates/notes-sync (신규)      file_io · hlc · topic_file/parser(v5) · merger · exporter 코어 · watcher 코어 · bootstrap 코어
crates/notes-application      SyncStatus/SyncConflict 계약(ts-rs), absorb_external + undo 배리어
crates/notes-core             무수정. sync를 모른다
```

의존 방향(§2-2에서 역전 확정): `notes-sqlite → notes-sync → notes-application → notes-core`. `scripts/checkV2Architecture.mjs:7-11`의 `expectedDependencies`에 `["notes-sync", ["notes-application", "notes-core"]]`를 넣고 M1.4에서 `notes-sqlite` 행에 `notes-sync`를 추가해 기계로 강제한다.

역할 분담: notes-sync는 Connection을 받아 일하는 라이브러리다(스레드·Tauri·이벤트를 모른다). 스레드와 수명주기는 어댑터의 SyncRuntime이, SQL 실행 시점은 notes-sqlite 워커가 소유한다.

### 4.2 워커 접합 — 병합

- `crates/notes-sqlite/src/worker.rs:21-72`의 `Request` enum에 `MergeTopic { input, reply }`를 추가하고 루프(`:186-263`)에서 `notes_sync::merger::merge_topic_doc(&mut connection, &input)`을 호출한다.
- 병합 전체가 하나의 IMMEDIATE 트랜잭션이고 **적용된 변경이 있을 때만 `notes_meta.revision`을 1 올린다**(`mutations.rs:63-72`와 같은 규약). no-op 병합은 revision을 올리지 않는다(멱등 테스트의 근거).
- 우회 금지: 같은 DB 파일에 별도 Connection을 열어 병합하면 revision이 오르지 않아 이후 프런트 커밋이 낡은 상태를 덮는다. 테스트 설계 §6이 이 경로를 잡는다.

### 4.3 서비스 접합 — revision 사본과 undo 배리어

병합이 DB revision만 올리면 `NotesService`의 메모리 사본(`service.rs:30`)이 낡아서 이후 모든 프런트 명령이 `mutations.rs:25`에서 `RevisionConflict`로 죽는다. 따라서 병합은 반드시 서비스를 지난다.

- `NotesService`에 `absorb_external(operation)`을 신설한다. session lock 안에서 operation(워커 병합 호출)을 실행하고 반환된 `{ revision, changed_node_ids }`로 `session.revision`을 갱신한다. lock을 잡은 채 워커 왕복을 기다리는 것은 기존 명령 경로(`service.rs:146→307`)와 같은 모양이다.
- undo 배리어: `SessionState`에 `undo_floor: usize` 하나. absorb 시 undo 스택 위에서부터 changed set과 교차하는 최상위 항목 인덱스 i를 찾아 `undo_floor = max(undo_floor, i + 1)`. `can_undo = undo.len() > undo_floor`. `push_bounded_history`의 `remove(0)`(`service.rs:91`) 때 floor를 `saturating_sub(1)`. 교차 판정은 `TreeMutation`의 Upsert 노드 id·Delete id로.
- redo: changed set과 교차하는 항목이 있으면 redo 스택 전체를 비운다(병합 뒤 forward 재적용은 병합 결과를 되돌릴 수 있다).
- `HistoryState`(can_undo/undo_depth)가 이미 영수증에 실려 나가므로 배리어에 프런트 수정은 필요 없다.

### 4.4 워커 접합 — exporter와 watcher

- exporter 읽기 스냅샷은 워커 경유: 신규 요청 하나가 dirty 대상 해석과 대상별 렌더 입력을 **상수 개 질의**로 만들어 반환한다(§2-5 수리). 렌더·자가 검증·`write_atomic_file`은 exporter 스레드, 즉 워커 밖에서 한다. 느린 클라우드 FS가 DB 큐를 막지 않게 하는 v1 원칙이다(자가 검증은 `exporter.rs:2159-2164` 유지).
- 1초 폴링 제거: exporter 스레드는 채널로 (a) 커밋 poke(어댑터가 `notes_execute`/`notes_undo`/`notes_redo` 성공 후 전송), (b) flush, (c) stop을 받고, `recv_timeout`은 다음 디바운스 만기(3s idle / 30s max)까지로 계산한다. 주기적 wakeup 없음.
- watcher 콜백은 파일 읽기(notes-sync file_io의 guarded read)와 파싱까지만 하고 병합은 `absorb_external`로 넘긴다. 콜백에서 SQLite를 직접 열지 않는다.

### 4.5 이벤트 — 이 앱 최초의 Tauri 이벤트

M5에서 `notes://sync-changed { revision, changedNodeIds, deletedNodeIds }`를 신설한다(v1 스펙 §9.2의 이름 계승, 페이로드는 v2 영수증 모양). 프런트 listener는 500ms coalesce 후 기존 `applyReceipt` 경로 모양으로 반영하고 페이로드가 크면 뷰포트 재조회로 폴백한다. `notes://sync-status`는 격리·오류 통지용으로 같이 정의한다.

## 5. 스키마 창 (M1.4에서 한 번에)

### 5.1 DDL — `crates/notes-sqlite/src/schema.rs` `create_schema`에 직접 추가

- `notes_nodes`에 컬럼 2개: `hlc TEXT NOT NULL DEFAULT ''`, `sync_extras TEXT NOT NULL DEFAULT ''`(미지 필드 보존용, 결정 6).
- 신규 테이블(전부 STRICT, 기존 관례): `sync_meta`(singleton, device_id, vault_uuid, hlc_millis, hlc_counter), `sync_topics`(topic_id PK, file_name UNIQUE, applied_max_hlc, exported_hash, file_mtime_ms, file_size, quarantined), `sync_dirty_nodes`(node_id PK, marked_at), `sync_conflict_log`(seq INTEGER PK AUTOINCREMENT, node_id, loser_json, loser_hlc, winner_hlc, recorded_at), `sync_purged_tombstones`(node_id PK, purged_hlc). `file_mtime_ms`/`file_size`는 M5 증분 재색인 게이트다.
- 트리거 3개: v1 `src-tauri/src/notes/schema.rs:208-228`의 `notes_nodes_hlc_ai / _au / _ad`를 그대로 가져온다. INSERT는 `WHEN NEW.hlc = ''`, UPDATE는 `WHEN NEW.hlc = OLD.hlc`일 때만 `yona_hlc()`로 스탬프하고 dirty에 upsert. 병합이 hlc를 명시하면 미발화(불변 규칙 6). `PRAGMA recursive_triggers`는 기본 OFF 전제 — 어디서도 켜지 않는다. hlc UPDATE는 `text, note`를 건드리지 않아 FTS 트리거(`schema.rs:199`)와 간섭 없다.
- `yona_hlc()` 등록: 워커 스레드가 Connection을 만든 직후(`worker.rs:160-175`) `notes_sync::hlc::register(&connection)` 호출. rusqlite `functions` feature는 이미 켜져 있다(루트 `Cargo.toml:22`).
- `user_version`은 1 그대로. 버전 분기 없음.

### 5.2 개발 DB 리셋 (마이그레이션 대신 — 정확한 절차)

1. 앱 내: 설정 → 데이터 전체 삭제(`notes_delete_all_data`, `apps/desktop/src-tauri/src/lib.rs:245`). 마커를 쓰고 재시작하면 `lib.rs:265-287`이 `notes-v2.sqlite`(+`-wal`, `-shm`), `images/`, `original-views/`를 지운다.
2. 수동: `rm -f ~/Library/Application\ Support/com.doortts.yonalist.v2/notes-v2.sqlite*` (identifier는 `apps/desktop/src-tauri/tauri.conf.json:5`).
3. 개발·테스트 격리: `YONALIST_V2_DATA_DIR=<임시 디렉터리> npm run tauri:dev` — 리셋할 필요 없이 디렉터리를 버린다.

테스트는 전부 `tempfile::tempdir` 또는 `SqliteStorage::open_in_memory`를 쓰므로 리셋과 무관하다.

## 6. 마일스톤

의존은 M0→M1→M2→M3→M4→M5→M6 직렬. 커밋 제목은 저장소 관례(영어, `feat(sync):`/`fix(sync):`)를 따른다. red 테스트의 정확한 이름·경로는 테스트 설계 문서가 소유한다 — 아래 표의 테스트 열은 그 문서의 절 번호를 가리킨다.

### M0 — 스펙 개정 (1항목)

| 필드 | 내용 |
|---|---|
| Goal | 이후 모든 단계의 진실 소스가 될 v2 sync 스펙 확정 |
| Acceptance | 스펙 문서가 v5 문법 전체·결정 6건·불변 규칙·리스크 정책 4건·golden 초안을 담고 적대적 리뷰를 통과한다 |
| Non-goals | 코드 변경 없음 |
| Boundaries | 문서만 |
| Manual proof | N/A |

**M0.1** — `docs/v2/sync-spec.md` 신규 작성. 내용:
- 포맷 v5 문법 전체: frontmatter 키 셋(v2 도메인 정합: kind/text/note/marker/ordered_start/collapsed/completed/starred), 노드 주석 토큰(`yid`/`t`/star/collapsed/ordered_start), 이미지 라인(정규형 `.yonalist/notes-assets/<sha256>.<ext>` + `ya:` 메타), trash.md(v2는 `deleted` boolean이고 삭제 행이 parent_id·sort_key를 유지하므로 `from:` 메타는 행 자체에서 파생), purge 이중 증거의 v2 대응(어느 명령 경로가 purge인지: `NotesCommand::Delete`가 후보, §9 미해결 1).
- v4 대비 삭제 필드(readonly, plugin, plugin_children, collapsed_groups, miw)와 보존 규칙: 파서는 미지 frontmatter 키·주석 토큰을 원문 그대로 `sync_extras`에 실어 왕복시킨다(결정 6). 재방출 위치·순서 규칙을 결정적으로 고정.
- 관대함 표(v1 §7.3 계승 + `format_version <= 5` 수용), 불변 규칙 10건 계승 선언 + v2 개정 3건(병합은 워커 큐 경유·revision 규약, undo 배리어, 이벤트 계약).
- 신규 리스크 정책 4건: 90일 창 초과 스냅샷 격리, 24h 초과 미래 HLC fresh 재스탬프 + 로그, transport 겹침 문서 경고, conflicted copy 병합 승격(병합·재작성 성공 시 `sync-cleanup` 은퇴 이동, v1 메커니즘 유지).
- v5 golden 초안 3종(topic/이미지 포함 topic/trash)을 v1 golden(§1.1)에서 파생해 부록으로 싣는다.
- git 미보증 문구(결정 1)의 게재 위치 지정.

커밋: `docs(sync): rewrite the sync spec for v2 (format v5)`. red 테스트 없음 — 문서 항목의 게이트는 적대적 리뷰다. 이 스펙의 계약들은 M1·M2에서 red 테스트로 물화된다(테스트 설계 §1).

### M1 — 골격 (6항목, 실행 수준)

| 필드 | 내용 |
|---|---|
| Goal | notes-sync 크레이트·HLC·원자적 파일 계층·스키마 창·vault 설정이 착지하고 기존 명령은 무수정 |
| Acceptance | 아래 6행. 각 행 = 항목 하나 |
| Non-goals | 렌더러·파서·병합·export 없음. notify 미도입 |
| Boundaries | Rust(신규 크레이트, notes-sqlite, adapter), SQLite(제자리), IPC(명령 2개), React(설정 화면 한 절) |
| Manual proof | 격리 실행 → 설정에서 vault 폴더 지정 → 재시작 후 유지 확인 (M1.5·M1.6 이후) |

| 행 | 합격 조건 | 항목 |
|---|---|---|
| M1-1 | 워크스페이스에 notes-sync가 있고 의존 그래프 검사가 방향을 강제한다 | M1.1 |
| M1-2 | HLC 17자 인코딩이 왕복하고 사전순 = 시간순이며 observe 후 now()가 원격을 이긴다 | M1.2 |
| M1-3 | 원자적 쓰기·guarded read·no-replace 이동이 notes-sync에서 v1과 같은 계약으로 동작한다 | M1.3 |
| M1-4 | 기존 mutation 명령이 무수정으로 hlc 스탬프 + dirty 기록을 남기고 명시 hlc는 보존된다 | M1.4 |
| M1-5 | vault 경로가 IPC로 지정·조회되고 재시작을 견딘다 | M1.5 |
| M1-6 | 설정 화면에서 vault 폴더를 고르고 현재 값을 본다 | M1.6 |

**M1.1 — notes-sync 크레이트 골격.**
- 바뀌는 것: `crates/notes-sync/{Cargo.toml, src/lib.rs}` 신규(빈 모듈 트리), 루트 `Cargo.toml` members·workspace.dependencies에 notes-sync 추가, `scripts/checkV2Architecture.mjs:7-11`에 `["notes-sync", ["notes-application", "notes-core"]]` 추가. 의존: notes-application, notes-core, rusqlite(workspace), uuid, sha2. dev: tempfile, proptest.
- 무수정: notes-sqlite(아직 의존 안 함), 기존 크레이트 전부.
- 커밋: `feat(sync): add the notes-sync crate and enforce its dependency edges`
- 테스트 명령: `npm run test:v2:architecture`. red: 스크립트를 먼저 고치면 "missing v2 workspace package: notes-sync"로 실패(테스트 설계 §2.1). 의존: 없음.

**M1.2 — hlc 이식.**
- 바뀌는 것: `crates/notes-sync/src/hlc.rs` — `src-tauri/src/notes/hlc.rs`(437줄, 테스트 8) 이식. `Hlc` encode/decode(9-2-4 base36, 총 17자), 전역 클록 now/observe, `sync_meta` 영속 helper, `register(&Connection)`(`yona_hlc` 스칼라 함수).
- 무수정: v1 원본(복사이지 이동이 아니다. v1은 동결 oracle로 남는다).
- 커밋: `feat(sync): port the HLC clock and its fixed-width encoding`
- 테스트: `cargo test -p notes-sync hlc` (테스트 설계 §2.2). 의존: M1.1.

**M1.3 — file_io 이식.**
- 바뀌는 것: `crates/notes-sync/src/file_io.rs` — 루트 `src-tauri/src/file_io.rs`(3,859줄, 테스트 41)에서 sync가 쓰는 표면만: `write_atomic_file`(temp+rename+fsync+부모 sync), held-parent guarded bounded read(no-follow/reparse 거부), identity-bound no-replace 이동. v1의 다른 기능 전용 표면은 두고 온다.
- 커밋: `feat(sync): port the atomic file layer`
- 테스트: `cargo test -p notes-sync file_io` (테스트 설계 §2.3). 의존: M1.1.

**M1.4 — 스키마 창 + 스탬핑 트리거 + yona_hlc 등록.**
- 바뀌는 것: `crates/notes-sqlite/src/schema.rs`(§5.1 DDL 전체), `crates/notes-sqlite/src/worker.rs:160-175`(연결 직후 `notes_sync::hlc::register` + `sync_meta` 시딩 — device_id/vault_uuid uuid v4 1회), `crates/notes-sqlite/Cargo.toml`에 notes-sync 의존, `scripts/checkV2Architecture.mjs:10`의 notes-sqlite 행에 "notes-sync" 추가.
- 무수정: `crates/notes-sqlite/src/mutations.rs` — 트리거 방식의 존재 이유. `user_version = 1` 유지.
- 커밋: `feat(sync): open the schema window with HLC stamping triggers`
- 테스트: `cargo test -p notes-sqlite --test sync_stamping` (테스트 설계 §3). 기존 notes-sqlite 테스트 전체 green 유지 확인. 의존: M1.2.

**M1.5 — vault 위치 IPC와 영속.**
- 바뀌는 것: `apps/desktop/src-tauri/src/sync_settings.rs` 신규 — `notes_sync_vault_get` / `notes_sync_vault_set(path)` 명령, 검증(절대 경로·생성 가능 디렉터리·`app_data_dir` 내부 금지), `app_data_dir/vault-path` 한 줄 텍스트 파일에 영속. `lib.rs` generate_handler 등록. 명령 추가 리플: `scripts/checkV2Architecture.mjs:137-149` expectedCommands, `apps/desktop/src-tauri/permissions/main-window.toml`, `apps/desktop/src-tauri/build.rs`. 계약: notes-application `contracts.rs`에 `SyncVaultStatus` ts-rs 타입 + `packages/contracts/generated` 재생성 커밋.
- 무수정: 워커·notes_ui_state(vault 경로는 어댑터 소유다. DB보다 먼저 필요하고 워커 표면을 늘리지 않는다).
- 커밋: `feat(sync): persist the vault location behind new IPC commands`
- 테스트: `cargo test -p yonalist-v2-desktop sync_settings` + `npm run test:v2:architecture` + `npm run test:v2:contracts` (테스트 설계 §2.4). 의존: M1.1.

**M1.6 — 설정 화면 vault 절.**
- 바뀌는 것: `apps/desktop/src/SettingsView.tsx` — vault 폴더 표시 + 선택 버튼(`@tauri-apps/plugin-dialog` 폴더 picker, `dialog:allow-open` 권한 기존 보유), `apps/desktop/src/api.ts`에 invoke 2개.
- 커밋: `feat(sync): let the settings screen choose the vault folder`
- 테스트: `npm run test:v2:frontend` — `SettingsView.test.tsx` (테스트 설계 §2.5). 의존: M1.5.

### M2 — 포맷 (3항목)

| 필드 | 내용 |
|---|---|
| Goal | v5 렌더러·파서가 결정성·왕복·관대함 계약을 만족한다 |
| Acceptance | M2-1 같은 상태 = 같은 바이트 + golden 일치 / M2-2 관대함 표 전 행 + v4/v1 수용 + 격리 판정 / M2-3 미지 필드가 파일 왕복에서 보존 |
| Non-goals | DB 접촉 없음(순수 문서 구조 대상). 병합·export 없음 |
| Boundaries | Rust(notes-sync만) |
| Manual proof | N/A |

| 항목 | 내용 | 완료 조건 | 의존 |
|---|---|---|---|
| M2.1 | `topic_file.rs` v5 렌더러 이식·개정(910줄 원본). BTreeMap/명시 정렬만, hand-rolled frontmatter | 결정성 + M0 golden 3종 바이트 일치 (테스트 설계 §4.1) | M0, M1.2 |
| M2.2 | `topic_parser.rs` v5 파서 이식·개정(2,785줄 원본). `format_version <= 5` 수용, 격리 판정, CRLF·들여쓰기 정규화 | 관대함 표 전 행 + `render(parse(render(s))) == render(s)` fixpoint + v4 golden 파싱 (테스트 설계 §4.2·§5) | M2.1 |
| M2.3 | 미지 필드 파일층 보존 — 파서가 미지 키·토큰을 구조체에 실어 렌더러가 결정적 위치에 재방출 | v4 golden(plugin/readonly 포함) parse→render에서 미지 필드 무손실 (테스트 설계 §5.3) | M2.2 |

### M3 — 병합 (5항목)

| 필드 | 내용 |
|---|---|
| Goal | 파일 병합이 워커·서비스·undo·충돌 노출까지 한 경로로 통한다 |
| Acceptance | M3-1 병합 대수(멱등·교환·수렴·부재≠삭제·이중 증거) / M3-2 워커 경유 병합이 revision을 정확히 한 번 올린다 / M3-3 undo 배리어 / M3-4 충돌 읽기·복구·보존 상한 IPC / M3-5 설정 화면 충돌 목록 |
| Non-goals | watcher·이벤트 없음(병합 호출자는 테스트와 M5) |
| Boundaries | Rust(notes-sync, notes-sqlite, notes-application, adapter), IPC(명령 2개 + 계약 2타입), React(설정 화면) |
| Manual proof | 설정 화면에서 충돌 목록·복구 버튼 확인(M3.5 이후, 테스트로 심은 충돌) |

| 항목 | 내용 | 완료 조건 | 의존 |
|---|---|---|---|
| M3.1 | `merger.rs` 이식(6,766줄 원본): LWW, A4 손편집 수용, purge tombstone, 결정적 cycle 파킹, lifecycle repair(`repair.rs` 흡수), conflict log 중복 없는 기록, needs_write_back 판단, `sync_extras` upsert, 24h 초과 미래 HLC 재스탬프(신규 정책) | 병합 대수 property + 단위 테스트 (테스트 설계 §5·§6.1) | M2 |
| M3.2 | 워커 접합: `Request::MergeTopic` + `SqliteStorage::merge_topic` + 변경 시에만 revision +1 | 워커 seam 통합 테스트 (테스트 설계 §6.2) | M3.1, M1.4 |
| M3.3 | `NotesService::absorb_external` + `undo_floor` 배리어 + redo 교차 정리(§4.3) | 배리어 테스트 3종, Rust 단독 (테스트 설계 §7) | M3.2 |
| M3.4 | conflict log 읽기·복구·정리: `notes_sync_conflicts` / `notes_sync_restore_conflict` 명령, 보존 상한(개수+기간, `maintenance.rs` 계승), `SyncConflict` ts-rs 계약, 명령 리플 3파일 | IPC 페이로드 왕복 + 상한 테스트 (테스트 설계 §6.3) | M3.1 |
| M3.5 | `SettingsView.tsx` 충돌 목록 + 복구 버튼(결정 5 — 인라인 배지 없음) | 프런트 테스트 (테스트 설계 §6.4) | M3.4 |

### M4 — 방출 (3항목)

| 필드 | 내용 |
|---|---|
| Goal | 편집이 디바운스 안에 자가 검증된 원자적 파일·자산 방출로 이어진다 |
| Acceptance | M4-1 dirty→export가 상수 개 질의로 해석되고 자가 검증 실패 시 파일을 덮지 않는다 + trash.md·tombstone 방출 / M4-2 이미지 바이트가 vault 정규 경로로 복사된다 / M4-3 디바운스 3s/30s·flush·종료 flush가 폴링 없이 동작한다 |
| Non-goals | watcher 없음. vault 쪽 asset GC 없음(§8) |
| Boundaries | Rust(notes-sync exporter 코어, notes-sqlite 워커 요청, adapter SyncRuntime 절반), IPC(flush 명령), 파일시스템 |
| Manual proof | 격리 실행 → 편집 → 5초 내 vault에 `*.md` 생성·내용 확인 |

| 항목 | 내용 | 완료 조건 | 의존 |
|---|---|---|---|
| M4.1 | exporter 코어 이식(4,847줄 원본): dirty→대상 해석을 노드당 질의(§2-5) 대신 상수 개 질의로, 렌더→파스백 자가 검증→`write_atomic_file`→`exported_hash` 기록, trash.md + purge tombstone 방출, 실패 격리·재시도 | 방출 단위 테스트 + 질의 수 상한 (테스트 설계 §8.1·§9.2) | M2, M3.1 |
| M4.2 | 자산 방출: dirty 이미지 노드의 바이트를 로컬 `images/`에서 vault `.yonalist/notes-assets/<sha256>.<ext>`로 복사(존재 시 생략). 경로 탈출 거부(불변 규칙 7) | 자산 방출 테스트 (테스트 설계 §8.2) | M4.1 |
| M4.3 | SyncRuntime 절반(adapter): exporter 스레드 + 커밋 poke + 디바운스 만기 `recv_timeout`(§4.4) + `notes_sync_flush` 명령(명령 리플 3파일) + 종료 시 flush | 디바운스·flush 테스트 (테스트 설계 §8.3) | M4.1, M1.5 |

### M5 — 감시와 부팅 (4항목)

| 필드 | 내용 |
|---|---|
| Goal | 외부 파일 변경이 UI까지 흐르고 재시작은 변경분만 만진다 |
| Acceptance | M5-1 파일 변경→coalesce→병합, 에코 skip, conflicted copy 승격, placeholder 재시도 / M5-2 vault 자산 도착이 로컬 캐시를 채운다 / M5-3 시작 조정 4분기 + mtime+size 게이트 증분 재색인 + StartupGate 편승 / M5-4 sync-changed 이벤트가 프런트를 갱신한다 |
| Non-goals | 성능 계약 게이트화(M6) |
| Boundaries | Rust(notes-sync watcher·bootstrap 코어, adapter), 신규 의존 notify(v1과 같은 8 계열), IPC(최초 이벤트 2종), React(listener) |
| Manual proof | 격리 실행 → vault의 md를 외부 편집기로 수정 → 앱 반영 확인. 재시작 → 즉시 부팅(전체 재파싱 없음) 확인 |

| 항목 | 내용 | 완료 조건 | 의존 |
|---|---|---|---|
| M5.1 | watcher 이식(2,591줄 원본): notify 감시 + 500ms coalesce + `exported_hash` 에코 skip + guarded read + conflicted copy 병합 승격(성공 시 `sync-cleanup` 은퇴) + placeholder 재시도 + 60s 안전망 스캔 | watcher 콜백 직접 호출 테스트 (테스트 설계 §8.4) | M3.3, M4 |
| M5.2 | 자산 인입: notes-assets 도착 감지 → 로컬 `images/`로 복사 → placeholder 이미지 행 해소 알림 | 자산 인입 테스트 (테스트 설계 §8.5) | M5.1 |
| M5.3 | bootstrap 이식(3,089줄 원본): 시작 조정 4분기(v1 §9.4), `file_mtime_ms`+`file_size` 게이트 통과분만 해시 확인, StartupGate(`apps/desktop/src-tauri/src/startup.rs`) 뒤에 비차단 편승 | 증분 재색인 테스트 (테스트 설계 §9.1) | M5.1 |
| M5.4 | `notes://sync-changed`·`notes://sync-status` emit(어댑터) + 프런트 listener(신규 파일, 500ms coalesce, StrictMode 멱등 등록/해제) + `applyReceipt` 모양 반영 | 이벤트 페이로드·listener 테스트 (테스트 설계 §8.6) | M3.3, M5.1 |

### M6 — 멀티 디바이스 검증 (3항목)

| 필드 | 내용 |
|---|---|
| Goal | 두 DB·한 vault 구성이 전 시나리오에서 수렴하고 성능 계약이 게이트가 된다 |
| Acceptance | M6-1 v1 §12 매트릭스 10시나리오 / M6-2 신규 4시나리오 / M6-3 성능 계약(증분 부트스트랩·질의 수 상한·기존 스위트 무회귀) |
| Non-goals | production 수정은 테스트가 드러낸 최소 결함에 한정 |
| Boundaries | Rust 테스트 + 성능 게이트 |
| Manual proof | 데이터 디렉터리 2개 + vault 1개로 앱 2회 기동 → 교차 편집 수렴 확인 |

| 항목 | 내용 | 완료 조건 | 의존 |
|---|---|---|---|
| M6.1 | v1 §12 매트릭스 재현: vault 2개 + 파일 복사로 transport 모사, DB 2개 (테스트 설계 §10.1) | 10시나리오 전부 green | M5 |
| M6.2 | 신규 시나리오: 90일 창 초과 스냅샷 격리, 24h 시계 드리프트 재스탬프, conflicted copy 수렴·승격, 동시 편집 conflict log (테스트 설계 §10.2) | 4시나리오 green | M6.1 |
| M6.3 | 성능 계약 게이트화: 부트스트랩 = 변경분만(카운터 단언), exporter 질의 수 상한, `test:v2:performance` 기존 7계약 무회귀, `docs/v2/performance.md`의 50k 부트스트랩 계약 문구 재정의 | 테스트 설계 §9 전부 green | M6.1 |

## 7. 최종 게이트 (마일스톤별, 실재하는 명령만)

diff 동결 후 1회. 편집 루프 중에는 소유 테스트만 돈다.

| 마일스톤 | 게이트 |
|---|---|
| M0 | 없음(문서). 적대적 리뷰 |
| M1 | `npm run test:v2` · `cargo fmt --all -- --check` · `git diff --check` (M1.6 프런트 접촉 → `npm run test:v2:bundle` 추가) |
| M2 | `cargo test --workspace` · `cargo fmt --all -- --check` · `npm run test:v2:architecture` (프런트 무접촉이라 vitest·lint·bundle은 명시 생략) |
| M3 | `npm run test:v2` · `cargo fmt --all -- --check` · `npm run test:v2:bundle` (M3.5 프런트 접촉) |
| M4 | `npm run test:v2` · `cargo fmt --all -- --check` + 수동 증거(§6 M4) |
| M5 | `npm run test:v2` · `cargo fmt --all -- --check` · `npm run test:v2:bundle` + 수동 증거(§6 M5) |
| M6 | `npm run test:v2` · `cargo fmt --all -- --check` · `npm run test:v2:performance` + 수동 증거(§6 M6) |

Clippy는 접촉 경계와 직접 관련될 때만 기준선 대비로 본다(스킬 규정). 알려진 advisory 경고(500/800줄 초과 15건)는 실패가 아니다.

## 8. 비대상

- **마이그레이션·스키마 버전·호환 리더.** 계약에 릴리즈 또는 하위 호환 요구가 명시로 들어올 때 다시 꺼낸다(사용자 확정, §0).
- **yid 재대응**(주석을 잃은 손편집을 텍스트·위치 근접으로 기존 id에 다시 잇기) — 원본 계획 §4-5가 P2로 미룸. M0 스펙에 요구사항으로만 기재.
- **3-way 텍스트 병합** — conflict log에 실충돌이 쌓이면 그때(결정 2).
- **CRDT 정본** — 원본 계획 §2에서 기각.
- **vault 쪽 asset GC**(refcount 0 격리·유예 삭제, v1 `asset_gc.rs` 7,014줄) — 후속. 로컬 캐시는 기존 `reconcile`(`image_assets.rs:205`)이 이미 정리한다.
- **뷰포트 정렬 키 물질화** — 스키마 창의 유효 항목이지만 sync와 무관(§0).
- **깊이 분할, P2P 전송, 다중 사용자 공동 편집** — v1 스펙 비목표 계승.
- **v1 트리 수정** — v1은 동결 oracle. 이식은 복사다.
- 기존 수동 `notes_export`(markdown/PDF, `crates/notes-export`)는 topic 포맷과 별개 기능으로 무수정.

## 9. 미해결 질문 (사용자 결정 필요)

1. **purge의 v2 사용자 경로.** 이중 증거 tombstone을 만드는 "휴지통 비우기"에 해당하는 v2 동작이 아직 없다(`NotesCommand::Delete`는 있으나 UI 연결 미확인). M0 스펙에서 (a) 기존 hard `Delete` 경로를 purge로 정의할지 (b) 휴지통 비우기 UI를 이 이식에 포함할지 결정이 필요하다. 전자는 코드가 작고 후자는 UX가 완결된다.
2. **conflict log 보존 상한의 기본값.** 개수·기간 상한 신설은 확정인데 값이 없다. 제안: 1,000건 또는 180일 중 먼저 닿는 쪽. M0 스펙에 박기 전에 확인.
3. **M6 수동 증거의 transport.** 실제 iCloud/Syncthing 폴더로 한 번 돌려볼지, 파일 복사 모사로 충분한지. 자동 테스트는 모사로 충분하지만 출하 전 실 transport 1회 확인을 M6 수동 증거에 넣을지 결정.
