# Notes 파일 기반 SSOT 동기화 — 상세 구현 계획 (핸드오프 스펙)

- 작성: 2026-07-21. 대상: 구현 담당 agent (Opus 4.8 기준, 이 문서만으로 구현 가능하도록 작성).
- 설계 배경 문서(다이어그램/적대적 리뷰): https://claude.ai/code/artifact/4aee2964-20f6-403a-8689-8f4233b2c3de
- 상태: 설계 v2 확정. 마이그레이션 불필요(개발 단계). 이 문서가 구현의 단일 진실 소스.

## 0. 목표 / 비목표

**목표**: 같은 사용자의 노트북 2대가 vault 폴더(iCloud/Dropbox/Syncthing/OneDrive 지정 가능)를 통해 Notes를 자동 동기화한다.
- Markdown 파일 = 장치 간 진실 소스. SQLite = 런타임 진실 + 인덱스/캐시(앱 로컬).
- 부트스트랩 1회 파일→SQLite 구축, 이후 SQLite 기반 동작 + 비동기 파일 방출(export).
- 파일 변경 감시 → 노드 단위 HLC LWW 병합 → UI 자동 반영.
- 이미지 자산: 해시 우선 dedup ingest + 진행율 이벤트 + 유예 GC.

**비목표 (v2에서 하지 않음)**:
- 깊이 분할(sub/ 파일), 문자 단위 텍스트 병합, P2P 전송, 다중 사용자 공동 편집, v1 스키마 DB 마이그레이션.

## 1. 절대 불변 규칙 (위반 = 버그. 리뷰에서 이 목록으로 검증한다)

1. **부재 ≠ 삭제.** 파일에 없는 노드는 절대 삭제하지 않는다. 삭제는 (a) trash.md로의 이동(LWW 대상), (b) purge tombstone 두 증거로만.
2. **병합은 멱등·교환적.** `yid`/HLC가 기록된 canonical 파일은 같은 파일을 두 번 병합하면 no-op이고, 병합 순서가 결과를 바꾸면 안 된다. 단, `yid` 없는 immutable external input은 최초 병합마다 UUIDv4/HLC를 신규 발급하므로 write-back 전 동일 bytes 재전달도 새 external input으로 처리한다. 멱등 계약은 발급값이 write-back된 canonical 문서부터 적용하며, 이후 watcher의 coalesce/echo 억제가 운영 중복을 줄인다. LWW 비교는 HLC 문자열 비교(§4의 고정폭 인코딩이 이를 보장).
3. **직렬화는 결정적.** 같은 SQLite 상태 → 바이트 동일한 파일. (키 순서·이스케이프·개행 고정, HashMap 순회 금지 — BTreeMap/정렬 사용.)
4. **export 자가 검증.** 쓴 바이트를 재파싱해 상태와 일치하지 않으면 파일을 덮지 않고 에러 로그 + dirty 유지.
5. **원자적 쓰기만.** 모든 vault 파일 쓰기는 `file_io::write_atomic_file` (temp+rename+fsync) 경유.
6. **병합이 적용하는 원격 노드의 hlc는 원격 값 그대로.** 로컬 클록으로 재스탬프 금지(§6 트리거 WHEN 가드가 이를 보장).
7. **asset 참조는 정규형만.** markdown의 이미지 링크는 `.yonalist/notes-assets/<sha256>.<ext>` 패턴만 파싱 허용. 경로 탈출(`..`, 절대경로) 즉시 거부.
8. **기존 캡 유지.** 파일 16MiB, `MAX_IMPORT_SUBTREE_DEPTH`, `MAX_IMPORT_SUBTREE_NODES`, 첨부 20MB 등 기존 상수 재사용.
9. **budget 준수.** 신규 프런트 모듈은 `scripts/checkNotesWorkspaceBudgets.mjs`의 `notesWorkspaceProductionFiles`에 넣지 않거나 1,500라인 이하. 테스트에서 `toHaveBeenNthCalledWith`/`invocationCallOrder` 사용 금지.
10. **undo 오염 금지.** 병합·부트스트랩은 history context 없이 실행 — 원격 변경이 로컬 undo 스택에 들어가면 안 된다.

## 2. 현재 코드 기준점 (탐사로 확인된 사실 — 그대로 신뢰하고 시작해도 됨)

| 사실 | 위치 |
|---|---|
| NoteNode 구조체 (id, parent_id, sort_key, title, note, …) | `src-tauri/src/notes/types.rs:51-70`, TS 미러 `src/domain/notes.ts:15-32` |
| DB 경로 `<vault>/.yonalist/notes.sqlite`, WAL | `repository.rs:177-179` (`notes_db_path`), 호출처: `connection.rs:176,199,207,239`, `repository.rs:575,667` |
| 스키마 DDL + FTS/tags/dates 트리거 | `schema.rs:79-310`, `CURRENT_NOTES_SCHEMA_VERSION=1` (`repository.rs:43`) |
| vault 경로는 프런트 설정(localStorage `yonalist.settings.v1`), 모든 명령에 `vault_path: String` 파라미터로 전달 | `src/appSettings.ts:3-21`, `src/App.tsx:355` |
| markdown export: frontmatter + `- [ ] title <!-- yonalist-node-id: id -->` + note는 depth+1 blockquote | `export.rs:541-575,716-846` |
| markdown import: 자기 export 전용 엄격 파서, **id 재생성** | `markdown_import.rs:376+`, id 재생성 `commands.rs:1171,1189` |
| 원자적 쓰기 헬퍼 | `src/file_io.rs:251` `write_atomic_file` (tempfile+rename+fsync) |
| 첨부: sha256 content-addressed `<vault>/.yonalist/notes-assets/<hash>.<ext>` | `attachments.rs:69-70,737-752,1505-1548`, lock `.yonalist/.notes-assets.lock` |
| 첨부 ingest 명령 | `notes_import_attachment_paths_batch` (`commands.rs:3134`), `notes_import_attachment_bytes` (`:3427`, raw IPC), `notes_import_image_node_paths_batch` (`:3585`), `notes_import_image_node_bytes` (`:3760`), `notes_apply_image_atom_paste` (`:3906`) |
| Tauri 이벤트: 현재 emit 0건. AppHandle 주입 선례 있음 | `lib.rs:1409` (`open_url(app: tauri::AppHandle, ...)`) |
| 프런트 워크스페이스 훅: `useNotesWorkspace` 실구현 | `notesWorkspaceRuntime.ts:277`, reload는 `repository.loadWorkspace` (`:774`) |
| Cargo deps: sha2/tempfile/uuid(v4)/rusqlite(bundled,functions,hooks) 있음. **notify·serde_yaml 없음** | `src-tauri/Cargo.toml` |
| Rust 테스트: 같은 파일 `#[cfg(test)] mod tests`. 프런트: co-located `*.test.ts(x)` | 관례 |

주의: `.yonalist/index.sqlite`는 **다른 기능의 DB**(`lib.rs:130`). 이 계획의 notes DB와 혼동 금지.

## 3. 신규/수정 파일 총람

**신규 (Rust)** — `src-tauri/src/notes/sync/`:
```
mod.rs          — pub 재수출, SyncRuntime(watcher+exporter 스레드), notes_sync_* 명령의 실구현
hlc.rs          — Hlc 타입/인코딩/클록, yona_hlc() SQL 함수 등록
topic_file.rs   — TopicDoc 렌더러 (결정적 직렬화)
topic_parser.rs — 관대한 파서 (id/hlc 보존)
merger.rs       — LWW 병합
bootstrap.rs    — 최초 구축 / 시작 시 조정 / 초기 export
watcher.rs      — notify 감시 + coalesce + 스캔
asset_gc.rs     — asset-trash 격리/유예 GC/즉시 purge
```

**수정 (Rust)**:
- `file_io.rs`: startup/watcher 공용 held-parent + no-follow/reparse-safe bounded reader와 identity-bound no-replace 이동.
- `Cargo.toml`: `notify = "8"` 추가, `uuid` features에 `v5` 추가.
- `schema.rs`: DDL v2 (§5), `repository.rs`: `CURRENT_NOTES_SCHEMA_VERSION = 2`, `notes_db_path` 이전 (§5.1).
- `connection.rs`: 연결 시 `yona_hlc()` 함수 등록 호출 1줄.
- `commands.rs`: 신규 명령 추가만(§9). **기존 명령 본문 무수정** (§6 트리거 방식 덕).
- `lib.rs`: 명령 등록, `SyncState` manage, `NOTES_DATA_ROOT` OnceLock 초기화(setup에서 `app.path().app_data_dir()`).
- `attachments.rs`: ingest에 dedup 단락 + 진행율 emit (§10).

**신규 (TS)**:
```
src/services/notesSyncListener.ts       — Tauri listen → coalesce → reload 트리거
src/services/notesSyncContract.ts       — command/event 공용 SyncStatus 타입·검증
src/services/assetIngestProgress.ts       — 진행율 이벤트 수신 훅
```
**수정 (TS)**: `notesWorkspaceRuntime.ts`(listener 연결 useEffect ~15줄), `appSettings.ts`(GC 설정 3필드×4곳), `NotesDataSettingsDialog.tsx`(purge 버튼), `notesStore.ts`(신규 invoke 4개).

## 4. 핵심 결정값 (전부 고정 — 임의 변경 금지)

### 4.1 HLC
```rust
// hlc.rs
pub struct Hlc { pub millis: u64, pub counter: u32, pub device: String } // device = device_id 앞 4 hex
```
- **인코딩(고정폭, 사전순=시간순)**: `{millis를 base36 9자리 zero-pad}-{counter를 base36 2자리 zero-pad}-{device 4자}` → 예 `0swkd7qz3-01-a3f2`. 총 17자. base36 소문자 `0-9a-z`.
- **now()**: `millis = max(system_millis, clock.millis)`; 같으면 `counter += 1`, 크면 `counter = 0`. counter > 1295(=zz) 시 `millis += 1; counter = 0`. 전역 `Mutex<(u64,u32)>`.
- **observe(remote: &Hlc)**: 병합 시 원격 hlc를 클록에 반영 — `clock = max(clock, remote)` (millis, counter 순 비교). 이후 now()가 항상 원격보다 큼을 보장.
- **영속**: 앱 시작 시 `max(sync_meta의 저장값, SELECT max(hlc) FROM notes_nodes)`로 복원. 종료/export 시 sync_meta에 기록.
- **비교는 항상 인코딩 문자열의 사전순 비교**. Rust/SQL/TS 어디서든 동일 결과 — 이것이 결정성의 근간.

### 4.2 device_id / vault_key / 파일명
- `device_id`: DB 생성 시 `uuid v4` 1회 발급, `sync_meta.device_id`. HLC의 device 4자 = 이 uuid 앞 4 hex.
- `vault_key`: `hex(sha256(정규화된 vault 절대경로))[..16]` — 앱 로컬 DB 디렉터리 키. 로컬 전용 값.
- **topic 파일명**: `{slug}.{topic_id 앞 8 hex}.md`. slug 규칙: NFC 정규화 → 제어문자 제거 → `/\:*?"<>|#%{}^~[]`와 공백 연속을 `-`로 → 앞뒤 `-`,`.` trim → 최대 40자 → 빈 문자열이면 `untitled`. 대소문자 보존. Phase 2 merger가 `sync_topics` 부재 상태를 처음 보면 병합 순서와 무관한 `untitled.{id8}.md` fallback만 넣는다. Phase 3 bootstrap/watcher가 실제 source 파일명 또는 최초 제목 기반 파일명을 병합 전에 seed한다. 어느 경로든 **생성 후 절대 rename하지 않는다**(제목 변경 무관). 파일명은 코스메틱, identity는 frontmatter `id`.
- 복구 topic(사이클/고아 수용): id = `uuid v5(namespace=vault의 sync_meta.vault_uuid, name="yonalist-recovery-topic")`, 제목 "복구됨". 필요 시 lazy 생성. (`vault_uuid`도 sync_meta에 v4로 1회 발급 — 단 recovery id 파생용이므로 **두 장치가 다른 recovery topic을 만들 수 있음은 허용**, LWW로 공존.)

### 4.3 topic 소속
- topic = `parent_id IS NULL`인 노드. 모든 노드의 topic = 최상위 조상. 루트 자체도 topic 노드.
- trash.md는 가상 topic: 파서/렌더러에서 `kind: yonalist-trash`로 구분, 루트 노드 없음.

## 5. SQLite 변경 (schema.rs — DDL 그대로 사용)

`CURRENT_NOTES_SCHEMA_VERSION = 2`. **v1 DB를 열면 명확한 에러로 거부**("개발 단계 DB — .yonalist/notes.sqlite 삭제 후 재실행" 메시지). 마이그레이션 없음.

```sql
-- notes_nodes에 컬럼 추가 (CURRENT_SCHEMA_SQL의 CREATE TABLE에 직접 추가)
--   hlc TEXT NOT NULL DEFAULT ''

CREATE TABLE IF NOT EXISTS sync_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  device_id TEXT NOT NULL,
  vault_uuid TEXT NOT NULL,
  hlc_millis INTEGER NOT NULL DEFAULT 0,
  hlc_counter INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_topics (
  topic_id TEXT PRIMARY KEY,            -- 최상위 노드 id
  file_name TEXT NOT NULL UNIQUE,       -- 예: groceries.1f2a3b4c.md
  applied_max_hlc TEXT NOT NULL DEFAULT '',
  exported_hash TEXT NOT NULL DEFAULT '', -- 마지막 자기 쓰기의 sha256 (에코 스킵용)
  quarantined INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_dirty_nodes (   -- §6 트리거가 채움, exporter가 비움
  node_id TEXT PRIMARY KEY,
  marked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sync_conflict_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  loser_json TEXT NOT NULL,             -- 패자 노드 전체 스냅샷(JSON)
  loser_hlc TEXT NOT NULL,
  winner_hlc TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sync_purged_tombstones (
  node_id TEXT PRIMARY KEY,
  purged_hlc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_trash (
  content_hash TEXT PRIMARY KEY,
  extension TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  quarantined_at TEXT NOT NULL,
  delete_after TEXT NOT NULL
);
```

### 5.1 DB 위치 이전 (라이브 DB가 클라우드에 동기화되는 것 차단)
- `lib.rs` setup에서 `static NOTES_DATA_ROOT: OnceLock<PathBuf>`에 `app.path().app_data_dir()?.join("notes")` 저장.
- `repository.rs::notes_db_path(vault_path)` 구현 교체: `NOTES_DATA_ROOT.get().join(vault_key(vault_path)).join("notes.sqlite")` (디렉터리 create_dir_all). **함수 시그니처 유지 → 호출처 6곳 무수정.**
- 테스트에서는 OnceLock 미초기화 시 기존 경로(`.yonalist/notes.sqlite`)로 폴백(기존 테스트 보존). 폴백 분기에 `// ponytail:` 주석으로 명시.
- asset-trash 디렉터리: `NOTES_DATA_ROOT/<vault_key>/asset-trash/`.

## 6. HLC 스탬핑 + dirty 추적 — 트리거 방식 (기존 명령 무수정의 핵심)

`connection.rs`의 연결 초기화에서 Rust 스칼라 함수 등록:
```rust
// hlc.rs — rusqlite "functions" feature (이미 활성)
pub fn register_hlc_function(conn: &Connection) -> rusqlite::Result<()> {
    conn.create_scalar_function("yona_hlc", 0, FunctionFlags::SQLITE_UTF8, |_| {
        Ok(global_clock_now_encoded()) // §4.1 now()의 인코딩 문자열
    })
}
```
스키마에 트리거 추가 (recursive_triggers는 SQLite 기본 OFF — 자기 UPDATE 재발화 없음):
```sql
CREATE TRIGGER IF NOT EXISTS notes_nodes_hlc_ai AFTER INSERT ON notes_nodes
WHEN NEW.hlc = ''                        -- 병합이 명시한 hlc는 보존 (불변 규칙 6)
BEGIN
  UPDATE notes_nodes SET hlc = yona_hlc() WHERE id = NEW.id;
  INSERT OR REPLACE INTO sync_dirty_nodes(node_id) VALUES (NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS notes_nodes_hlc_au AFTER UPDATE ON notes_nodes
WHEN NEW.hlc = OLD.hlc                   -- 명령 경로: hlc 안 건드림 → 스탬프+dirty
BEGIN
  UPDATE notes_nodes SET hlc = yona_hlc() WHERE id = NEW.id;
  INSERT OR REPLACE INTO sync_dirty_nodes(node_id) VALUES (NEW.id);
END;
```
- **병합/부트스트랩 경로**는 항상 `hlc = <원격값>`을 명시 SET → `NEW.hlc <> OLD.hlc` → 트리거 미발화 → 재스탬프·dirty 오염 없음. 단 병합이 hlc 외 컬럼만 바꾸는 경우는 없다(항상 노드 전체 upsert).
- `notes_attachments`에도 동일 패턴 AI/AU/AD 트리거 — dirty에는 **소유 노드 id**를 넣는다 (`INSERT OR REPLACE INTO sync_dirty_nodes SELECT NEW.node_id ...`). 첨부 자체는 hlc를 갖지 않고 소유 노드의 hlc 갱신으로 LWW에 편승: 첨부 트리거가 `UPDATE notes_nodes SET hlc='' WHERE id = NEW.node_id`로 소유 노드 재스탬프를 유발한다(AU 트리거의 WHEN과 체인됨 — `hlc=''` SET는 `NEW.hlc <> OLD.hlc`라 AU 미발화, 하지만 AI 조건 `hlc=''`용이 아니므로: **명시적으로 `UPDATE notes_nodes SET hlc = yona_hlc() WHERE id = NEW.node_id` 직접 실행으로 단순화**).
- DELETE 트리거(`AFTER DELETE ON notes_nodes`)는 dirty만 기록(export 시 파일에서 사라짐).

## 7. 파일 포맷 명세 (format_version 2)

### 7.1 topic 파일 문법 (렌더러·파서 공통 계약)
```
---
kind: yonalist-notes
format_version: 2
id: <uuid 소문자>
sort_key: <i64 10진>
max_hlc: <hlc 17자>
root_hlc: <hlc>
root_starred: true|false
root_completed_at: <ISO8601>|null
root_archived_at: <ISO8601>|null
---
# <루트 title, escape_inline 적용>
> 루트 note 본문 (depth-0 blockquote, 헤딩 직후·첫 bullet 전. note 없으면 이 블록 생략)

- [ ] Milk <!-- yid: <uuid> t: <hlc> -->
  > note 본문 1행 (depth+1 blockquote, 기존 export와 동일)
  > 2행
- [x] Cheese <!-- yid: <uuid> t: <hlc> star -->
- [ ] 앞텍스트 <!-- yid: <uuid> t: <hlc> -->
  ![Image](.yonalist/notes-assets/<sha256>.<ext>) <!-- ya: name: <pct-encoded> w: <displayWidth|-> -->
  뒤텍스트
```
- 루트 note: `# <title>` 직후, 첫 bullet 전에 depth-0 blockquote(`> …`)로 렌더/파스한다(remediation A3). note가 비면 블록 자체를 생략하고, 헤딩과 첫 bullet 사이 빈 줄 1개만 남긴다. 노드 note와 동일 escape(`escape_markdown`) 규칙.
- frontmatter는 **hand-rolled** (serde_yaml 도입 금지 — 기존 export.rs/markdown_import.rs 방식 유지). 키 순서 위 명세로 고정.
- bullet 라인 = 기존 `render_node` 형식에서 주석만 교체: `<!-- yonalist-node-id: id -->` → `<!-- yid: <id> t: <hlc>[ star] -->`. 완료 `[x]`, 제목 escape는 기존 `escape_inline`(`export.rs:274`) 재사용.
- 이미지 노드: 기존 `render_node_with_assets`(`export.rs:716-828`)의 before/after 분할 표현 유지. 링크는 연번(`0001.png`)이 아니라 **정규 해시 경로**. 첨부 메타 주석 `<!-- ya: name: <원본명 pct> w: <displayWidth 정수 또는 -> -->`.
- 정렬: 파일 내 줄 순서 = 형제 순서. `sort_key` 값은 파일에 쓰지 않으며(루트 제외) import 시 1024 간격 재부여(`SORT_KEY_STEP` 재사용).
- collapsed / createdAt / updatedAt / archiveRootId는 파일에 쓰지 않는다 (로컬 전용 또는 재계산).

### 7.2 trash.md
```
---
kind: yonalist-trash
format_version: 2
max_hlc: <hlc>
purged: <uuid> <hlc>          ← 0개 이상 반복. 휴지통 비우기 tombstone
---
- [ ] 삭제된 서브트리 루트 <!-- yid: … t: … from: <원부모 uuid>@<sort_key> -->
  - [ ] 자식들 그대로 <!-- yid: … t: … -->
```
- 삭제 = 노드를 topic 파일에서 제거하고 trash.md에 기록 (SQLite에선 기존 soft-delete 그대로 — `deleted_at` 세팅. exporter가 deleted 노드를 trash.md로 렌더).
- restore = `from:` 메타로 복원(기존 `notes_restore_node` 로직 재사용).
- 휴지통 비우기(`notes_*` 기존 hard-purge 경로) → `sync_purged_tombstones` insert → trash.md frontmatter `purged:` 라인으로 방출. 병합 시 purge tombstone을 만난 장치는 해당 노드(hlc가 tombstone hlc보다 작을 때만)를 완전 삭제. tombstone은 90일 후 GC.

### 7.3 파서 관대함 규칙 (markdown_import.rs와 별개의 신규 topic_parser.rs)
| 입력 상황 | 처리 |
|---|---|
| 주석에 yid 없음 (외부 편집기로 추가된 bullet) | 노드로 수용, id/hlc는 병합 단계에서 매 전달마다 신규 발급 → write-back으로 파일에 역기록. immutable input이라 write-back 전 동일 bytes 재전달은 새 external input이며, write-back된 canonical 문서부터 repeat=no-op. watcher coalesce/echo 억제가 운영 중복을 줄임 |
| hlc 파싱 불가 | `''`로 간주 → 병합에서 항상 패배(로컬 우선) |
| 들여쓰기 홀수 칸/탭 | 2칸 단위로 내림 정규화, 탭=2칸 |
| checkbox 없음 (`- text`) | `[ ]`로 간주 |
| frontmatter 키 누락 | 기본값 (starred=false 등). `id` 누락 시에만 파일 격리 |
| 알 수 없는 frontmatter 키/주석 토큰 | 무시 (전방 호환) |
| `format_version > 2` | 파일 격리 (미래 버전 보호) |
| CRLF | LF로 정규화 |
| 16MiB 초과, depth/노드 수 캡 초과 | 파일 격리 |
| 격리(quarantine) | `sync_topics.quarantined=1`, 병합 skip, `notes://sync-status` 이벤트로 통지. **절대 부분 적용하지 않는다** |

### 7.4 결정성·왕복 테스트 계약 (Phase 1 수용 기준)
- `render(parse(render(state))) == render(state)` (바이트 동일).
- golden fixture: `src-tauri/src/notes/sync/fixtures/topic_golden.md` 1개 이상 커밋, 테스트에서 바이트 비교.

## 8. LWW 병합 명세 (merger.rs)

```rust
pub struct MergeReport { pub applied: usize, pub conflicts: usize, pub parked_cycles: usize,
                         pub new_ids_assigned: usize, pub needs_write_back: bool }

/// 전제: doc은 topic_parser 통과본. 전체가 하나의 IMMEDIATE 트랜잭션.
pub fn merge_topic_doc(conn: &mut Connection, doc: &TopicDoc) -> Result<MergeReport, NotesError>
```
의사코드 (이 순서 그대로 구현):
```
1. 모든 유효 HLC 증거를 먼저 observe한다: topic은 max/root/전체 중첩 node,
   trash는 max/purged/전체 중첩 node. 이 선관찰이 끝난 뒤에만 UUID·repair·recovery HLC를 발급한다.
2. for parsed in doc.nodes (파일 순서대로):
     if parsed.id is None:                      # 외부 편집기 신규 bullet
         id = uuid_v4(); hlc = hlc::now(); needs_write_back = true
     local = SELECT * FROM notes_nodes WHERE id = parsed.id
     if tombstone(parsed.id) exists AND parsed.hlc < tombstone.hlc: skip   # purge가 이김
     remote_node = to_note_node(parsed)          # sort_key = 파일 내 위치 기준 (idx+1)*1024
     if local is None:            INSERT (hlc = parsed.hlc 명시)   # 트리거 미발화
     elif parsed.hlc > local.hlc: UPDATE 전체 컬럼 (hlc 명시); 첨부 행 동기화
     elif parsed.hlc < local.hlc: conflict_log에 remote 기록(로컬 승); needs_write_back = true
     else: skip                                  # 동일 hlc = 동일 내용 (같은 장치 발급)
3. 사이클 검사: 2에서 parent_id가 바뀐 각 노드에 대해 조상 걷기(최대 depth 캡).
   사이클 발견 → 그 사이클 안에서 hlc가 가장 작은 move의 노드를 복구 topic 아래로 이동
   (parent=recovery, hlc = hlc::now()) → 결정적: 같은 입력이면 같은 노드가 이동.
   archived cycle이면 parked live subtree의 archive lifecycle을 fresh HLC로 active 정규화하고,
   trash cycle이면 parked node와 deleted subtree의 trash lifecycle을 보존한다.
4. trash doc이면: purged 라인 → sync_purged_tombstones upsert 후,
   해당 id의 노드가 존재하고 node.hlc < purged_hlc면 행 삭제(첨부 포함).
5. incoming/purged id를 seed로 한 affected descendant closure에서 lifecycle integrity를 검사한다.
   seed는 bounded chunk로 조회하되 모든 violation을 수집한 뒤에만 repair를 시작한다.
   parent가 missing/deleted/archived이면 remote 적용 여부와 무관하게 recovery 아래로 fresh-restamp한다.
   non-deleted archived node는 archive_root_id와 parent chain이 모두 intact archived tree를 이루어야 한다.
   깨진 archive boundary는 recovery 아래로 이동하고, 그 archived descendant는 parent chain을 보존한 채
   active로 fresh-restamp한다. 기존 valid root/intact archive와 모든 deleted node는 보존한다.
6. topic 소속 정리: 이 topic 파일에 없지만 SQLite상 이 topic 소속인 노드
   → 아무 것도 하지 않는다 (불변 규칙 1). 단 그 노드의 hlc가 doc.max_hlc보다 작고
     다른 topic에도 없으면 needs_write_back = true (다음 export가 되살려 씀).
7. sync_topics.applied_max_hlc = max(기존, doc.max_hlc)
```
- `parsed.id is None` 입력에는 아직 안정 identity가 없으므로 immutable 문서의 write-back 전 재전달을 원래 bullet의 replay와 구분할 수 없다. 따라서 매 전달을 신규 external input으로 처리하고, UUIDv4/HLC가 write-back된 canonical 문서 재적용부터 멱등(no-op)이어야 한다. watcher의 coalesce/echo 억제는 이후 단계의 운영 중복 완화 수단이다.
- 첨부 행 동기화: 이미지 라인의 `<hash, name, w>`로 `notes_attachments` upsert. 바이트 파일(`notes-assets/<hash>`)이 아직 없으면 **플레이스홀더 상태로 두고** 노드는 정상 적용(바이트는 클라우드 동기화로 도착 — watcher가 notes-assets 생성 감지 시 `notes://sync-changed` 재발화).
- 병합 완료 후 반환된 report로 이벤트 emit + needs_write_back이면 해당 topic dirty 마킹.

## 9. SyncRuntime · 명령 · 이벤트 인터페이스

### 9.1 Rust 쪽 수명주기
```rust
pub struct SyncState(pub Mutex<Option<SyncRuntime>>);   // lib.rs에서 .manage()

#[tauri::command] async fn notes_sync_start(app: tauri::AppHandle,
    state: tauri::State<'_, SyncState>, vault_path: String) -> Result<SyncStatus, NotesError>
#[tauri::command] async fn notes_sync_stop(state: ...) -> Result<(), NotesError>
#[tauri::command] async fn notes_sync_flush(vault_path: String) -> Result<(), NotesError>   // 디바운스 무시 즉시 export
#[tauri::command] async fn notes_sync_status(vault_path: String) -> Result<SyncStatus, NotesError>
#[tauri::command] async fn notes_purge_unused_assets(vault_path: String, confirm: bool)
    -> Result<PurgeReport, NotesError>   // confirm=false → dry-run 집계만
```
```rust
#[derive(Serialize)] #[serde(rename_all="camelCase")]
pub struct SyncStatus { pub running: bool, pub dirty_topics: u32, pub quarantined: Vec<String>,
                        pub last_export_at: Option<String>, pub last_merge_at: Option<String> }
#[derive(Serialize)] #[serde(rename_all="camelCase")]
pub struct PurgeReport { pub count: u32, pub total_bytes: u64 }
```
- `notes_sync_start`: 멱등. vault가 바뀌면 기존 runtime 정지 후 재시작. 내부에서 (a) 부트스트랩/시작 조정(§9.3) 실행, (b) watcher 스레드, (c) exporter 스레드 기동.
- **스레딩**: std::thread 2개 + `std::sync::mpsc`. exporter는 1초 tick으로 `sync_dirty_nodes` 폴링(명령 시그니처 무수정을 위한 의도된 폴링 — `// ponytail: 1s poll, 이벤트 채널로 교체 가능`).

### 9.2 Tauri 이벤트 (이 앱 최초의 커스텀 이벤트 — 이름·페이로드 고정)
| 이벤트 | 페이로드 (camelCase JSON) | 발화 시점 |
|---|---|---|
| `notes://sync-changed` | `{ vaultPath: string, topicIds: string[] }` | 병합이 SQLite를 바꿨을 때 |
| `notes://sync-status` | `{ vaultPath: string, status: SyncStatus }` | 상태 전이(격리 발생, export 완료 등). vault 전환 중 지연 이벤트를 구분하도록 명시적 wrapper를 사용한다. |
| `notes://asset-ingest-progress` | `{ requestId: string, phase: "hashing"\|"copying"\|"done", bytesDone: number, bytesTotal: number, contentHash?: string }` | ingest 진행 중 |

### 9.3 exporter/watcher 동작 (수치 고정)
- **exporter tick 1s**: dirty 노드 → topic id resolve(재귀 CTE로 최상위 조상) → topic별 최초 dirty 시각 기준 **idle 3s 경과 or 총 30s 경과** 시 export. export = 렌더 → 자가 검증(파스백 비교) → `write_atomic_file` → `sync_topics.exported_hash = sha256(bytes)` 기록 → dirty 해소. deleted 노드 변화가 있으면 trash.md도 동일 절차.
- **flush 트리거**: `notes_sync_flush` 명령(프런트가 window close/blur 시 호출 — 기존 `useFlushDraftsOnWindowClose.ts:147` 패턴에 추가), runtime stop 시.
- **watcher**: `notify` recommended watcher, vault 루트 + `.yonalist/notes-assets` 감시. 필터: 루트 직하 `*.md` + notes-assets 내 파일 생성. 이벤트 coalesce 500ms. startup 열거와 watcher/scan Markdown 읽기는 요청된 parent 자체를 final-component no-follow/reparse 검사한 뒤 그 identity와 일치하는 held parent capability + basename에 대해 no-follow로 한 번만 bounded read하고 symlink/Windows reparse/non-regular 및 handle/path identity 변화를 거부한다(OS의 안정적인 상위 path alias는 허용). Windows metadata의 volume serial/file index가 없으면 panic하지 않고 해당 target을 retryable failure로 보존한다. startup의 parseable 판단·canonical/bounce ranking·parse/merge/hash는 이때 소유한 동일 bytes를 재사용한다. 콜백: 파일 sha256 == exported_hash → skip(에코). 아니면 parse→merge→emit. `* (conflicted copy)*.md`, `* 2.md` 등 bounced 사본 glob도 병합 입력으로 소화한다. 소비된 사본은 검증 뒤 pathname unlink하지 않고, held identity를 유지한 no-replace 이동으로 app-private `.yonalist/sync-cleanup/consumed/`에 logical retirement하여 root 감시 namespace에서 제거한다. `consumed` basename은 held cleanup parent 아래에서 이동 직전/직후 동일 directory identity로 재검증한다. 이동된 entry/directory identity가 다르거나 이동 후 parent 검증이 실패하면 현재 bytes를 원래 경로에 no-replace 복구하거나 private recovery 위치에 보존한다.
- **주기 스캔**: watcher 유실 대비 60s마다 전체 `*.md` mtime+hash 비교 (수 ms).

### 9.4 시작 시 조정 (bootstrap.rs — notes_sync_start 안에서 1회)
```
1. DB 없음(신규) → 스키마 생성 + vault *.md 전체 parse→merge (= 부트스트랩)
2. DB 있음 + vault에 topic 파일 없음 + 노드 존재 → 전 topic export (초기 vault 생성)
3. 그 외 → 각 *.md: hash == exported_hash면 skip; 다르면 parse→merge
4. sync_dirty_nodes 잔여 있으면 export (크래시 잔여 방출)
```

### 9.5 프런트 인터페이스 (notesSyncListener.ts)
```ts
import { listen, UnlistenFn } from "@tauri-apps/api/event";
export interface SyncChangedPayload { vaultPath: string; topicIds: string[] }
export function startNotesSyncListener(opts: {
  vaultRoot: string;
  onWorkspaceChanged: () => void;      // coalesce 500ms 후 loadWorkspace 재호출
  onStatus?: (s: SyncStatus) => void;
}): Promise<UnlistenFn>
```
- 연결 지점: `notesWorkspaceRuntime.ts:277+`의 세션 useEffect(`[repository, vaultRoot]` 키)에 ~15줄 추가: mount 시 `notes_sync_start` invoke + listener 시작, unmount 시 unlisten(+`notes_sync_stop`은 앱 종료시에만). reload는 기존 `repository.loadWorkspace` 경로 그대로(리듀서 full re-normalize 지원 확인됨 `notesWorkspaceReducer.ts:600-608`).
- StrictMode 이중 mount 대비: listener는 idempotent 등록/해제 (cleanup 반환 필수).

## 10. Asset ingest dedup + 진행율 + GC

### 10.1 ingest (attachments.rs 내부 수정 — 명령 시그니처 불변)
기존 5개 ingest 명령의 공통 내부 경로에:
1. **해시 우선**: 바이트/파일을 스트리밍 sha256 (paths_batch는 파일에서 1MB 청크로 읽으며 hashing 진행율 emit; bytes 계열은 이미 메모리에 있으므로 hashing phase 생략 가능 — `phase:"hashing"` 1회 emit 후 즉시).
2. `notes-assets/<hash>.<ext>` 존재 → **복사 생략**, attachment 행만 insert, `phase:"done"` 즉시 emit.
3. 미존재 → 기존 쓰기 경로(lock/lease 그대로)로 기록하며 1MB 단위 `phase:"copying"` emit.
4. `requestId`는 프런트가 생성해 명령 input에 추가(각 Import*Input에 `request_id: Option<String>` 필드 추가 — 하위호환 Option).
- 진행율 emit을 위해 해당 명령들에 `app: tauri::AppHandle` 파라미터 추가(Tauri가 자동 주입 — 프런트 invoke 무변경).

### 10.2 GC (asset_gc.rs — exporter tick에 60s마다 편승)
```
refcount(hash) = SELECT COUNT(*) FROM notes_attachments WHERE content_hash = ?  (별도 카운터 금지)
refcount 0 && asset_trash에 없음 → notes-assets/에서 NOTES_DATA_ROOT/<vault_key>/asset-trash/로 이동 + 행 기록
  delete_after = quarantined_at + (byte_size >= threshold ? 2일 : 7일)
asset_trash 항목이 재참조됨(refcount > 0) → 파일 원위치 복원 + 행 삭제
now > delete_after → 파일·행 완전 삭제
```
- 기본값: `threshold = 5MB`. 설정 3필드(§10.3)로 조정 가능.
- `notes_purge_unused_assets(confirm=false)` → refcount 0 전체(격리분 포함) 개수/바이트 집계 반환. `confirm=true` → 유예 무시 즉시 삭제.

### 10.3 설정 (appSettings.ts — 4곳 모두 수정: interface/defaults/normalize/needsNormalization)
```ts
assetTrashRetentionDays: number;   // default 7, 정수 0–365
assetTrashLargeFileDays: number;   // default 2
assetLargeFileThresholdMb: number; // default 5
```
- `NotesDataSettingsDialog.tsx`에 "미사용 자산 즉시 삭제" 버튼: dry-run 집계 표시 → 확인 → confirm 호출. 설정값은 `notes_sync_start` input으로 백엔드에 전달(런타임 재시작 시 반영이면 충분).

## 11. 단계별 구현 계획

각 Phase 완료 게이트(공통): `npx tsc --noEmit` 0에러 · `npm run lint` 0 · `npm test` 전체 green · `cargo test` 전체 green · `npm run test:architecture` 통과. **Phase 순서 준수, 병렬 진행 금지.**

| Phase | 내용 | 산출물 | 수용 기준(테스트) |
|---|---|---|---|
| **0** | `hlc.rs` + 스키마 v2 + 트리거 + `yona_hlc` 등록 + DB 위치 이전 + sync_meta 시딩 | hlc.rs, schema.rs/repository.rs/connection.rs 수정 | HLC: 인코딩 왕복, 단조성, 사전순=시간순 property test. 트리거: 기존 mutation 명령 실행 후 hlc 스탬프·dirty 기록 확인, 명시 hlc INSERT는 미스탬프 확인. v1 DB 거부 에러. 기존 cargo 테스트 전부 green(폴백 경로) |
| **1** | `topic_file.rs` + `topic_parser.rs` | 렌더러/파서 + golden fixture | §7.4 왕복 바이트 동일성, 관대함 규칙 표 전 행 케이스별 테스트, 격리 조건 테스트, 이미지 라인 왕복 |
| **2** | `merger.rs` | LWW 병합 | 멱등(`yid`/HLC write-back된 canonical doc 2회=no-op), 교환(A·B 파일 병합 순서 무관 동일 상태), 수렴(두 DB가 서로의 export를 병합→ 동일 상태), tombstone, cycle park 결정성, 외부 신규 bullet id 발급, 부재≠삭제 |
| **3** | `bootstrap.rs` + `exporter` (SyncRuntime 절반) + `notes_sync_flush` | 시작 조정 4분기, dirty→export, 자가 검증 | 신규 DB 부트스트랩, 초기 vault export, 크래시 잔여 export, 자가 검증 실패 시 파일 미변경, trash.md 방출 |
| **4** | `watcher.rs` + 이벤트 emit + `notesSyncListener.ts` + runtime 연결 | notify dep, 최초 커스텀 이벤트, 프런트 reload | 파일 수정→(테스트: watcher 우회, 콜백 직접 호출) 병합→이벤트 페이로드 검증. 프런트: 이벤트 수신→coalesce→loadWorkspace 호출 vitest. 에코 skip, bounced 사본 소화 |
| **5** | asset dedup/진행율/GC/설정/purge | attachments.rs 수정, asset_gc.rs, appSettings 4곳, dialog 버튼 | dedup 시 복사 0회+즉시 done, 진행율 이벤트 순서(hashing→copying→done), refcount 파생 GC 7d/2d 분기, 재참조 복원, dry-run/confirm |
| **6** | 통합·장애 주입·성능 | E2E-급 rust 테스트(임시 vault 2개로 장치 A/B 시뮬레이션) | 시나리오: 동시 편집 수렴, 잘린 파일 격리 후 재export 복원, purge 전파. 개인 노트북 수용 게이트는 10k 노드 부트스트랩 < 15s, 병합 tick < 1s/topic(1k 노드). 기존 20k 부트스트랩과 100ms 목표는 비차단 참고 측정으로 기록 |

## 12. 테스트 매트릭스 (Phase 6 시나리오 — 전부 자동화)

성능 수용 기준은 일반적인 개인 노트북의 저장장치·전원·백그라운드 부하 편차를
고려해 다음처럼 적용한다. 기능 회귀를 판정하는 자동 게이트는 10,000개 노드의
초기 부트스트랩 15초 이내와 1,000개 노드 단일 topic 병합 1초 이내다. 두 작업은
UI 스레드 밖에서 실행되므로 이 상한은 실제 사용 흐름을 막지 않으면서 비정상적인
성능 퇴행을 검출한다. 20,000개 노드 부트스트랩 시간과 1,000개 노드 병합의 100ms
달성 여부는 같은 실행에서 참고값으로 출력하되 환경 의존 실패로 전체 기능 게이트를
막지 않는다. 성능 테스트는 동일 프로세스에서 1회 준비 실행 후 측정하고, 디스크
동기화와 파싱·SQLite 반영을 포함한 끝단 시간을 잰다.

임시 디렉터리 2개(vaultA=vaultB 내용 복사로 클라우드 동기화 모사) + DB 2개로:
1. A 편집→export→B로 파일 복사→B 병합 = A 상태와 동일 (기본 전파)
2. A·B 같은 노드 동시 편집 → 교차 병합 → 두 DB 동일 + 패자 conflict_log 존재
3. A·B 서로 다른 노드/topic 편집 → 무충돌 병합
4. A: X를 topic P→Q 이동, B: X 제목 수정 → 교차 병합 → X는 Q에 1개, 제목은 hlc 승자
5. A 삭제(trash)→B 병합 → B에서도 trash. B 복원 → A 병합 → 복원 전파
6. A purge → tombstone 전파 → B에서 행 삭제. 90일 GC 후 도착한 구버전 노드는 trash로 부활(허용 동작 문서화)
7. 파일 뒷부분 truncate → 격리 + 알림 + 노드 무손실, dirty export가 파일 복원
8. bounced 사본(`x 2.md`) 생성 → 병합 소화 + 사본 삭제
9. hlc 없는 손편집 bullet → id 발급 + write-back
10. 동시 이동 cycle → 양쪽 모두 같은 노드가 복구 topic으로

## 13. 함정 목록 (구현 중 반드시 회피)

- **budget**: `notesWorkspaceRuntime.ts`는 1,500라인 캡 — listener 로직은 반드시 별도 파일로, runtime에는 연결 코드만.
- **StrictMode**: useEffect 이중 실행 — listener/start 멱등 + cleanup 필수.
- **raw IPC 명령**(`notes_import_attachment_bytes` 등)은 JSON body 거부 구조 — input 필드 추가 시 `decode_raw_attachment_body` 쪽 헤더 파싱에 requestId 추가.
- **트리거 재귀**: `PRAGMA recursive_triggers` 기본 OFF 전제. 어디서도 이 PRAGMA를 켜지 말 것.
- **HashMap 순회로 직렬화 금지** — 결정성 파괴. BTreeMap 또는 명시 정렬.
- **파일명 비교는 case-insensitive FS 고려** — slug 충돌은 id8이 방지하지만, 존재 검사는 정확 일치로.
- **watcher 콜백에서 직접 SQLite 열지 말고** 기존 connection 캐시(`connection.rs`) 경유.
- **`.yonalist/` 안의 다른 자산(outbox, cache, index.sqlite)은 건드리지 않는다.**
- 기존 `notes_export_markdown`/`notes_import_markdown`(수동 export/import 기능)은 **그대로 유지** — topic 포맷과 별개 기능.
- iCloud dataless 파일: 읽기 실패/지연 시 재시도(다음 스캔), 블로킹 호출을 UI 스레드에 두지 않기(전부 백그라운드 스레드).

## 14. 검증 명령
```
npm run lint && npx tsc --noEmit && npm test && npm run test:architecture
cd src-tauri && cargo test
```
수동 확인(개발자): vault를 임시 폴더로 지정 → 편집 → 5초 내 `*.md` 생성 확인 → 파일을 외부 에디터로 수정 → 앱에 반영 확인.

## 15. 단계 실행 브리프

아래 `Task N` 제목은 §11의 Phase를 서브에이전트 실행 단위로 추출하기 위한 목차다.
구현 요구사항은 앞선 본문이 단일 진실 소스이며, 각 Task는 지정된 절과 §1 불변 규칙,
§13 함정 목록을 함께 적용한다. Phase 순서는 바꾸지 않는다.

### Task 0 — Phase 0: HLC, schema v2, trigger, 로컬 DB 위치

- 요구사항: §4, §5, §5.1, §6과 §11 Phase 0 행.
- 수용 기준: HLC 왕복·단조성·사전순 property, 명령 mutation stamp/dirty,
  명시 HLC 보존, v1 거부, 기존 테스트 폴백.
- 범위: `hlc.rs` 신규, `schema.rs`, `repository.rs`, `connection.rs`, `lib.rs`,
  Cargo uuid v5 feature. notify/watcher는 아직 추가하지 않는다.

### Task 1 — Phase 1: topic renderer/parser

- 요구사항: §4.2, §4.3, §7 전체와 §11 Phase 1 행.
- 수용 기준: 결정적 직렬화, golden fixture, byte-identical round trip, 관대함 표
  전 행, quarantine 조건, 정규 asset link와 이미지 line round trip.
- 범위: `topic_file.rs`, `topic_parser.rs`, fixture와 모듈 wiring. 병합/파일 쓰기는
  아직 구현하지 않는다.

### Task 2 — Phase 2: HLC LWW merger

- 요구사항: §1, §4, §7, §8과 §11 Phase 2 행.
- 수용 기준: `yid`/HLC write-back된 stamped canonical 문서 재적용의 멱등·교환·수렴,
  purge tombstone, 결정적 cycle park, 외부 bullet id/HLC 발급, 부재≠삭제,
  conflict log와 write-back dirty. `yid` 없는 동일 immutable input의 write-back 전 재전달은
  각기 새 external input으로 검증한다.
- 범위: `merger.rs`와 직접 필요한 sync 공용 타입. watcher/exporter는 아직 제외한다.

### Task 3 — Phase 3: bootstrap, exporter, flush

- 요구사항: §5.1, §7, §8, §9.1, §9.3의 exporter/flush, §9.4와 §11 Phase 3 행.
- 수용 기준: 시작 조정 4분기, dirty debounce(3s/30s), 결정적 render→재parse
  자가 검증→원자 쓰기, echo hash, crash dirty, trash.md, stop/flush.
- 범위: `bootstrap.rs`, exporter를 포함한 `SyncRuntime` 절반, 명령/상태 wiring.
  watcher와 프런트 listener는 다음 Task다.

### Task 4 — Phase 4: watcher, 이벤트, 프런트 reload

- 요구사항: §9.1, §9.2, §9.3의 watcher/scan/coalesce, §9.5와 §11 Phase 4 행.
- 수용 기준: watcher callback 병합→고정 이벤트 payload, vault-scoped status wrapper,
  echo skip, bounced copy, asset 도착 알림, 500ms 프런트 coalesce,
  StrictMode 멱등 cleanup/reload.
- 범위: `watcher.rs`, notify 8, Tauri 명령 등록/권한, `notesSyncListener.ts`,
  `notesStore.ts`, `notesWorkspaceRuntime.ts`의 얇은 연결.

### Task 5 — Phase 5: asset dedup, 진행률, GC, 설정, purge

- 요구사항: §9.2 asset 이벤트, §10 전체와 §11 Phase 5 행.
- 수용 기준: hash-first dedup, hashing→copying→done, raw IPC requestId,
  refcount GC 7d/2d와 재참조 복원, dry-run/confirm purge, 설정 4곳/UI.
- 범위: 기존 ingest 공용 내부 경로, `asset_gc.rs`, `assetIngestProgress.ts`,
  settings/dialog/store/runtime config. 기존 캡·lock·lease를 보존한다.

### Task 6 — Phase 6: 통합, 장애 주입, 성능

- 요구사항: §1, §8, §9, §10, §11 Phase 6, §12 전체.
- 수용 기준: §12의 10개 시나리오 자동화, 10k bootstrap <15s, 1k topic merge
  <1s, truncate quarantine/recovery, 두 장치 수렴과 purge 전파. 20k bootstrap과
  1k topic merge <100ms는 비차단 참고값으로 기록한다.
- 범위: production 수정은 테스트가 드러낸 최소 결함에 한정한다. 전체 프런트/Rust/
  architecture gate와 격리된 임시 vault desktop smoke까지 완료한다.
