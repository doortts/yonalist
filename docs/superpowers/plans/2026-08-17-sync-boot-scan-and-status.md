# 시작 스캔과 sync-status — 설계

2026-08-17 · Fable 5 설계 · 대상 브랜치 main

두 항목 다 계약은 이미 있고 코드가 아직 없는 것들이다.

- 시작 스캔: 포트 계획 §M5.3(`docs/superpowers/plans/2026-08-15-notes-sync-port-implementation-plan.md`)이
  "시작 조정 + `file_mtime_ms`+`file_size` 게이트 통과분만 해시 확인 + StartupGate 뒤 비차단 편승"을
  약속했고 `crates/notes-sync/src/intake.rs`의 `scan_verdict`가 그 게이트인데 프로덕션 호출자가 없다.
  지금은 시작 시 아무것도 vault를 읽지 않는다. `vault_watch.rs`의 첫 스윕이 60초 뒤라서
  다른 기기에서 고친 노트가 실행 후 최대 1분간 낡아 보인다.
- `notes://sync-status`: 계획 §M5.4가 `sync-changed`와 함께 정의했고 `sync-changed`만 나갔다.
  격리된 파일, export 실패, watch 실패, flush 실패를 사용자가 알 길이 없다.
  `apps/desktop/src/notes.css`의 `.notes-sync-status-badge` CSS는 있고 컴포넌트가 없다.

사용자 결정(고정): **시작은 stat 게이트만 보고 싸게 지나가고 앱이 뜬 뒤
백그라운드에서 해시 검증 패스가 한 번 돈다.** 게이트는 큰 vault를 싸게 열고 검증
패스는 mtime과 크기가 그대로인 변경을 잡는다. Syncthing류 전송이 그런 파일을 만든다.

## 계약

| 필드 | 내용 |
| --- | --- |
| 목표 | 앱이 꺼진 사이의 vault 변경이 실행 직후 반영되고 sync가 거부하거나 실패한 것을 사용자가 화면에서 알 수 있다 |
| 비대상 | 아래 별도 절 |
| 경계 | Rust(`notes-sync`, `notes-sqlite`, `notes-application`, `src-tauri`) · IPC(명령 1개 `notes_sync_status`, 이벤트 1개 `notes://sync-status`, ts-rs 타입 2개) · SQLite(`sync_quarantine`에 컬럼 1개 제자리 추가, 마이그레이션 없음) · React(배지, listener, api) · 파일시스템(stat, 테스트에서 `File::set_modified`) |
| 수동 확인 | ① 앱을 끄고 외부 편집기로 vault의 md를 고친 뒤 실행 → 몇 초 안에 반영. ② vault에 깨진 md를 넣으면 사이드바에 배지가 뜨고 파일명과 이유가 보인다 |

### 완료 조건(acceptance)

| # | 관찰 가능한 통과 조건 | 항목 |
| --- | --- | --- |
| A1 | 앱이 꺼진 사이 바뀐 파일이 notify 이벤트 없이도, 60초를 기다리지 않고 실행 후 몇 초 안에 병합된다 | 3 |
| A2 | export가 쓴 파일의 mtime·크기가 `sync_documents`에 남는다(게이트가 맞춰 볼 기준값) | 1 |
| A3 | 손대지 않은 vault의 시작 스캔은 파일을 하나도 읽지 않고(stat만 본다) 아무 행도 쓰지 않는다 | 3 |
| A4 | mtime·크기가 그대로인 변경도 시작 후의 검증 패스가 읽어서 병합한다 | 4 |
| A5 | 검증 항목은 이벤트에 양보한다: 실시간 변경이 검증 뒤에 줄 서지 않는다 | 2 |
| A6 | 60초 스윕도 같은 stat 게이트를 써서 유휴 앱이 1분마다 vault 전체를 읽지 않는다 | 3 |
| A7 | 세션 중에 vault를 고르면 같은 시작 스캔·검증 패스가 그 자리에서 돈다 | 4 |
| B1 | 읽기를 거부한 파일이 이유와 함께 남는다 | 5 |
| B2 | `notes_sync_status`가 거부 목록과 마지막 오류를 답하고 생성된 TS 계약과 왕복된다 | 6 |
| B3 | 격리 발생·해소, export 실패·회복, watch 실패, flush 실패는 상태가 바뀔 때만 `notes://sync-status` ping을 낸다 | 7 |
| B4 | 사이드바 배지는 문제가 있을 때만 나타나고 파일 경로와 이유(또는 오류 문장)를 그대로 보여 준다 | 8 |

### 비대상

- 자산(이미지) 스윕의 게이트화 — `asset_known`이 이미 이름으로 막고 있고 질의가 싸다.
- `notes_meta`에 "최근 검증" 스탬프를 두고 검증 패스를 건너뛰는 최적화 — 후속. 아래 위험 2 참고.
- 재색인 명령 노출 — `reindex_vault`는 있지만 명령이 아니고 이번에도 아니다.
- Settings 안의 거부 파일 목록·복구 UI — 배지가 경로와 이유를 직접 보여 주므로 지금은 없다.
- 배지의 재시도·열기 버튼 — 표시만 한다.
- `sync_quarantine`에 stat 컬럼 — 격리 파일은 지금도 스윕마다 다시 읽히고(해시가 거부 기록과 같아 skip), 드물다. 그대로 둔다.
- v1의 `SyncStatus { running, dirty_topics, … }` 전체 상태 모델 — 필요한 필드만 만든다.

## 설계 — 항목 1: 시작 스캔

### 어디서 도는가

`watch_vault`(`apps/desktop/src-tauri/src/lib.rs`)는 시작 스레드가 `StartupGate`를
연 다음에 부르고 `VaultWatch::start`는 자기 스레드를 띄운다. 시작 스캔은 그 스레드의
첫 행동이다: `run`의 루프에 들어가기 전에(또는 `swept`를 만료 상태로 초기화해서 첫
바퀴에) 스윕을 한 번 돌린다. 창은 게이트만 기다리므로 아무것도 막히지 않고 §M5.3의
"StartupGate 뒤 비차단 편승"이 그대로 성립한다. 세션 중 vault 선택(`notes_sync_vault_set`)도
`watch_vault`를 다시 부르니 같은 경로다. 지금은 vault를 골라도 기존 파일이 최대
60초 뒤에야 들어오는데 이 변경이 그 지연도 없앤다.

### 스윕이 게이트를 얻는다

스윕 하나가 세 가지 역할을 하게 된다. 시점만 다르고 코드는 하나다.

| 시점 | 게이트 | 하는 일 |
| --- | --- | --- |
| watch 시작 직후 | stat 게이트 | 시작 스캔. `scan_verdict`가 `Hash`라고 답한 md만 큐에 넣는다 |
| 시작 +60초 (첫 스윕 주기) | 없음 | 검증 패스. md 전량을 verify 차선에 넣는다(한 번만) |
| 그 뒤 매 60초 | stat 게이트 | 안전망. 지금처럼 `forget_missing_refusals`도 여기서 돈다 |

게이트 판정에 필요한 기준값은 워커 요청 하나로 통째로 가져온다:
`Request::VaultStatRecords` → `SqliteStorage::vault_stat_records() ->
Vec<(String, notes_sync::intake::Known)>` (`sync_documents`의 `folder_path`,
`exported_hash`, `file_mtime_ms`, `file_size`). 파일마다 워커에 물으면 스윕 한 번에
문서 수만큼 왕복이 생기니 벌크 한 번이 맞다. `notes-sqlite`는 이미 `notes_sync`
타입을 쓰므로(`worker.rs`의 `VaultFile`) `Known` 반환은 의존 방향을 어기지 않는다.

스윕 쪽 판정: 디스크의 md마다 `symlink_metadata`로 stat을 뜨고 `scan_verdict(known,
mtime_ms, size)`를 부른다. `Skip`이면 끝, `Hash`면 `queue.saw`. 그다음은 기존
이벤트 경로 그대로다(`consider`가 읽고 해시하고 echo면 버리고 아니면 병합).
stat을 못 뜬 파일은 보수적으로 `queue.saw`. 자산 파일은 게이트 없이 지금처럼
`queue.saw`. 기록에 없는 파일은 `Known`이 없으니 `Hash`가 되어 처음 고른
남의 vault는 전량이 이 가지로 들어가 곧장 임포트가 된다.

`sync_quarantine`에만 있는 파일은 `sync_documents`에 없어 게이트를 못 지나고
읽히지만 해시가 거부 기록과 같아 echo로 떨어진다. 오늘과 같은 동작이라 잃는 것이 없다.

### export가 기준값을 기록해야 게이트가 산다

지금 `file_mtime_ms`·`file_size`를 기록하는 곳은 병합뿐이다(`merger.rs`의 upsert).
export(`export.rs`의 `record_document`)는 해시만 남긴다. 그런데 보통의 vault는
이 앱 자신이 export한 파일이 대부분이고 그 행들의 stat은 전부 NULL이다. 그대로면
게이트는 매번 `Hash`라고 답하고 시작 스캔은 조용히 전량 해시로 퇴화한다. 카운트
테스트가 없으면 아무도 모른다.

고치는 곳은 하나다: `write_checked`의 두 `record_document` 호출부에서 방금 쓴(또는
이미 같은 바이트임을 확인한) 파일을 stat 떠서 함께 기록한다. `record_document`가
mtime·크기 두 인자를 더 받고 upsert가 두 컬럼을 더 쓴다. 쓰기 직후와 stat 사이에
전송이 파일을 갈아치우는 좁은 레이스는 검증 패스가 닫는다(아래 위험 4).

### 검증 패스와 그 속도 조절

검증 패스는 새 기계가 아니라 "md 전량을 큐에 넣는 것"이다. 읽기와 해시는 watch
스레드에서 돌고(워커 규칙 그대로) 병합은 문서당 워커 요청 하나씩 FIFO로 나간다.
키 입력이 기다리는 최대치는 병합 1건이다. `WatchQueue`가 이미 들고 있는 규칙이라
새 속도 조절 장치는 만들지 않는다.

하나만 더한다: **verify 차선**. `WatchQueue`에 낮은 우선순위 집합
(`verify: BTreeSet<String>`)을 두고 `next_in_flight`는 `pending`(이벤트·게이트
불일치)을 다 비운 뒤에만 verify에서 꺼낸다. `saw`가 온 경로는 verify에서 지운다
(어차피 pending 쪽이 해시한다). 이게 없으면 검증 중에 도착한 실시간 변경이
BTreeMap 경로 순서에 밀려 큰 vault에서 몇 분씩 기다릴 수 있다. verify 항목은
쓰는 중인 파일이 아니므로 quiet 창을 적용하지 않는다.

시작 시점: 첫 스윕 주기(60초) 뒤, watch당 한 번. 시작 직후의 I/O(부트스트랩 질의,
색인)와 겹치지 않게 한 박자 늦추는 것이다. 상수 하나라 테스트에서는
`pub(crate) start_with(quiet, sweep)`로 줄여서 돌린다.

### 비용 계약

`crates/notes-sqlite/tests/sync_cost.rs`가 세는 것에 더한다.

- 손대지 않은 vault의 시작 스캔: 파일 읽기 0, 행 쓰기 0, 워커 요청 1(`vault_stat_records`).
- 기존 `opening_an_untouched_vault_reads_nothing_as_news` / `_writes_nothing`은 그대로
  검증 패스의 계약이 된다: 전량을 읽되 병합 0, 쓰기 0.

## 설계 — 항목 2: `notes://sync-status`

### 페이로드가 아니라 ping

이벤트는 페이로드 없이 "상태가 바뀌었다"만 알리고 프런트가 새 명령
`notes_sync_status`로 현재 상태를 다시 묻는다. 이유가 둘이다. 시작 시 watch 실패는
webview가 listener를 달기 전에 일어나므로 이벤트만으로는 반드시 놓친다. 어차피
mount 시 질의가 필요하다. 그리고 emit 지점이 백그라운드 스레드 셋에 흩어져 있어서
페이로드를 emit마다 조립하면 워커 질의가 따라붙는다. 질의는 항상 현재 진실을 답하니
늦게 도착한 이벤트도 해가 없다. vault 전환 중 지연 이벤트를 걱정한 원계획
(2026-07-21 §이벤트 표)의 답이 이 모양이다.

계약(`crates/notes-application/src/contracts.rs`, ts-rs `#[ts(export)]`,
`packages/contracts/generated` 재생성):

```rust
pub struct SyncStatus {
    pub refused: Vec<RefusedFile>,
    /// export 또는 flush가 마지막으로 실패한 이유. 성공한 export가 지운다.
    pub write_error: Option<String>,
    /// 폴더를 감시하지 못한 이유. watch가 다시 성공하면 지워진다.
    pub watch_error: Option<String>,
}
pub struct RefusedFile { pub path: String, pub reason: String }
```

두 오류를 한 필드에 합치지 않는다. export가 성공했다고 watch 실패가 지워지면 거짓말이 된다.

### 거부에 이유를 남긴다

`Verdict::Unreadable(reason)`의 문장은 지금 버려진다(`vault_watch.rs` `take`).
`sync_quarantine`에 `reason TEXT NOT NULL DEFAULT ''`를 제자리 추가하고(스키마 편집,
마이그레이션 없음. 디버그 빌드가 개발 DB를 새로 만든다), `storage.quarantine`이
이유를 받아 저장한다. `parse.rs:26` 주석이 애초에 이 용도를 못박아 뒀다.
조회는 워커 요청 `Request::RefusedFiles` → `Vec<RefusedFile>` (경로 순).

### emit 지점과 오류 슬롯

오류는 DB가 아니라 메모리에 산다: `DesktopRuntime`에 `SyncErrors { write:
Mutex<Option<String>>, watch: Mutex<Option<String>> }` (Arc). setter는 값이 실제로
바뀌었는지를 답하고 **바뀌었을 때만** ping을 낸다. 실패하는 export는 30초마다
도니 매번 ping을 내면 프런트가 매번 다시 묻는다.

| 지점 | 무엇을 | 어떻게 |
| --- | --- | --- |
| `vault_watch.rs` `take`의 `Unreadable` 가지 | 격리 기록 직후 | `VaultWatch::start`가 새로 받는 `status_changed: impl Fn() + Send` 콜백 호출 |
| `vault_watch.rs` 스윕의 `forget_missing_refusals` | 지운 건수 > 0이면 | 같은 콜백(배지가 꺼지는 경로) |
| `lib.rs` exporter 클로저 | `export_pending` 실패 → `write_error` 기록, 성공 → 지움 | `initialize`가 새로 받는 ping 클로저(AppHandle emit), 전이 시에만 |
| `lib.rs` `watch_vault` | `Err` → `watch_error` 기록, `Ok` → 지움 | 갖고 있는 `app`으로 전이 시 emit |
| `lib.rs` `notes_sync_flush` | 실패 시 `write_error` 기록 | 전이 시 emit (닫기 경로는 창이 닫히는 중이라 제외) |

`initialize`에는 Tauri 타입 대신 `Fn() + Send + Sync` 클로저를 넘긴다. 시작
스레드가 이미 `AppHandle`을 들고 있으니 조립은 `run()`의 setup에서 한다.

명령 리플: `lib.rs`의 `generate_handler!` + `scripts/checkV2Architecture.mjs`의
`expectedCommands` + `permissions/main-window.toml` + `build.rs`. 넷 중 하나라도
빠지면 아키텍처 게이트가 잡는다.

### 표면: 사이드바 배지 (Settings 아님)

배지는 outline chrome에 둔다: `App.tsx`의 `<nav>` 안, `yonalist-navigation-footer`
바로 위다. 이유는 셋이다.

- 이 기능의 존재 이유가 **묻지 않은 사용자에게 알리는 것**이다. Settings의 섹션은
  사용자가 열어야 보이는데 파일이 거부된 사용자는 열 이유를 모른다. 노트가 안
  보이는 이유 자체를 모르는 상태이기 때문이다. "Overwritten notes"는 조건부
  표시라도 이미 열어 본 화면 안에 있지만 이건 첫 통지다.
- CSS가 그렇게 그려져 있다: 12px 컴팩트 카드, `margin: 6px 12px`, 아이콘·메시지·
  detail·advice 구조는 내비게이션 컬럼용 인라인 경고의 형태다. v1도 같은 자리였다
  (`NotesSyncStatusBadge`, 2026-07-23 계획).
- 배지가 경로와 이유를 직접 보여 주면 Settings 목록이 지금 당장은 필요 없다.
  복구 액션이 생기는 날 Settings로 자라면 된다(비대상).

컴포넌트 `SyncStatusBadge.tsx`: `refused`가 비고 오류가 둘 다 없으면 `null`.
내용은 메시지 한 줄(예: "2 files could not be read" / "The vault could not be
written"), detail에 첫 경로와 이유(또는 오류 문장), advice에 고정 안내 한 줄.
데이터는 `App.tsx`가 mount 시 `api.syncStatus()`로 한 번 읽고
`notes://sync-status` ping마다(500ms coalesce) 다시 읽어 내려 준다.
listener는 `syncChanged.ts`의 coalesce 로직을 이벤트 이름을 받는 형태로 일반화해
재사용하고 `SYNC_CHANGED` 특수화는 기존 시그니처 그대로 남긴다.

## 위험 — 선택된 모양의 함정을 그대로 적는다

1. **export가 stat을 기록하지 않으면 게이트는 죽은 무게다.** 자기 vault의 행은 전부
   stat이 NULL이라 시작 스캔이 조용히 전량 해시로 퇴화한다. 항목 1이 이 설계의
   전제이고 A3의 카운트 테스트가 퇴화를 잡는 장치다.
2. **검증 패스는 매 실행마다 vault 전체를 한 번 읽는다.** 게이트가 아낀 비용이
   백그라운드로 돌아오는 셈이다. 자주 껐다 켜는 사용자에겐 실행당 전량 읽기가
   그대로 남는다. `notes_meta`에 "마지막 검증" 스탬프를 두면 건너뛸 수 있지만
   상태가 하나 늘고 무효화 규칙이 따라오므로 후속으로 미룬다. 지금은 비용을
   알고 받아들이는 것이고 이 문장이 그 기록이다.
3. **스윕 게이트화의 트레이드**: notify 이벤트가 유실되고 그 변경이 mtime·크기까지
   보존한 경우, 오늘은 60초 안에 잡히지만 바뀐 뒤에는 다음 실행의 검증 패스까지
   못 본다. 이중 실패 조건이라 받아들인다. 대신 유휴 앱이 1분마다 vault 전체를
   읽던 상시 비용이 사라진다. 이벤트 경로는 계속 무조건 해시라서(§M5.1 규칙 유지)
   단일 실패로는 못 놓친다.
4. **write→stat 레이스**: export가 파일을 쓰고 stat을 뜨는 사이에 전송이 파일을
   갈아치우면 남의 바이트의 stat이 우리 해시 옆에 기록된다. 그 파일 자체의 이벤트가
   해시로 잡고 놓쳐도 검증 패스가 잡는다. 게이트가 틀리는 방향이 "한 번 더
   해시"이지 "건너뜀"이 아니도록, 기록은 항상 우리가 쓴 직후의 stat이어야 한다.
5. **verify 차선이 없으면** 실시간 변경이 검증 행렬 뒤에 줄 선다. 항목 2가 설계에
   들어간 이유이고 우선순위 테스트가 계약이다.
6. mtime 해상도가 거친 파일시스템(exFAT 등)에서는 게이트 불일치가 늘어 해시가
   잦아질 뿐, 잘못 건너뛰는 방향으로는 못 틀린다. 위험한 방향(일치인데 내용이 다름)만
   검증 패스가 닫는다.

## 작업 항목 (순서 고정, 항목당 커밋 1개)

각 항목은 먼저 빨간 테스트를 적고 그 출력을 기록한 뒤 구현한다. 새 API가 없어서
컴파일부터 실패하는 테스트는 그 컴파일 오류가 red 증거다.

**1. export가 쓴 파일의 stat을 기록한다**
`crates/notes-sync/src/export.rs` — `record_document`가 mtime·크기를 받고,
`write_checked`의 두 호출부(같은 바이트 확인 가지 포함)가 디스크를 stat 떠서 넘긴다.
실패 테스트: `crates/notes-sqlite/tests/sync_cost.rs`
`the_export_records_the_stat_of_what_it_wrote` — export 후 `sync_documents`의
`file_mtime_ms`·`file_size`가 실제 파일의 stat과 같다. red: 지금은 둘 다 NULL.

**2. `WatchQueue`에 verify 차선**
`crates/notes-sync/src/watch_queue.rs` — `verify` 집합, `pub fn verify(&mut self,
path)`, `next_in_flight`는 pending 우선, `saw`는 verify에서 제거, verify에는 quiet
없음. 실패 테스트: `crates/notes-sync/tests/watch_queue.rs`
`verification_yields_to_events` — verify 여럿과 이벤트 하나를 넣으면 이벤트 경로가
먼저 나온다. red: `verify` 메서드가 없어 컴파일 실패.

**3. 스윕이 stat 게이트를 얻고 시작 즉시 돈다**
`crates/notes-sqlite/src/worker.rs` — `Request::VaultStatRecords` +
`vault_stat_records()`. `apps/desktop/src-tauri/src/vault_watch.rs` — 첫 루프에서
스윕, 스윕은 md에 `scan_verdict` 적용(자산은 기존대로), `scan_verdict`가 프로덕션
호출자를 얻는다. 실패 테스트 둘:
`vault_watch.rs` 테스트 `a_change_made_while_the_app_was_closed_is_merged_at_start`
— export된 vault의 파일 하나를 고치고 watch를 시작하면 changed 콜백이 10초 안에
온다. red: 지금은 첫 스윕이 60초 뒤라 timeout. 이 항목의 대표 증거다.
`sync_cost.rs` `opening_an_untouched_vault_stats_every_file_and_reads_none` —
게이트 판정에서 `Hash`가 0건. red: `vault_stat_records` 부재로 컴파일 실패.

**4. 검증 패스**
`vault_watch.rs` — 두 번째 스윕 주기가 md 전량을 `queue.verify`로 넣는다, watch당
한 번. 테스트용 `pub(crate) start_with(quiet_millis, sweep)`. 실패 테스트:
`vault_watch.rs` `a_change_that_kept_mtime_and_size_is_caught_by_the_verification_pass`
— export 후 같은 길이의 다른 바이트로 파일을 바꾸고 `File::set_modified`로 mtime을
되돌린 뒤 짧은 sweep으로 watch를 시작하면 changed 콜백이 온다. red: 게이트가
`Skip`이라 영영 병합되지 않아 timeout. A7은 이 항목까지의 배선으로 성립한다
(vault 선택도 같은 `watch_vault` 경로를 탄다).

**5. 거부에 이유를 남긴다**
`crates/notes-sqlite/src/schema.sql` — `sync_quarantine.reason` 제자리 추가.
`storage.quarantine(relative, hash, reason)`, `vault_watch.rs`가
`Unreadable(reason)`을 넘긴다. 실패 테스트:
`crates/notes-sqlite/tests/sync_merge_seam.rs` `a_refusal_records_why` — 격리 후
reason이 저장한 문장으로 읽힌다. red: 컬럼과 인자가 없어 컴파일 실패.

**6. `notes_sync_status` 명령 + 계약**
`contracts.rs`에 `SyncStatus`·`RefusedFile`(ts-rs), 워커 `Request::RefusedFiles`,
`lib.rs`에 `SyncErrors` 슬롯(전이 여부를 답하는 순수 구조체)과 명령, 명령 리플
4곳(`generate_handler!`, `checkV2Architecture.mjs`, `main-window.toml`, `build.rs`),
`packages/contracts/generated` 재생성. 실패 테스트: `lib.rs`
`sync_status_serializes_the_generated_typescript_wire_shape` — 생성된 TS 모양의
JSON과 왕복. red: 타입이 없어 컴파일 실패. 보조:
notes-sqlite `refused_files_lists_path_and_reason`, `lib.rs`
`a_repeated_error_reports_the_transition_once`(같은 오류 재기록은 false).

**7. emit 지점 배선**
`VaultWatch::start`에 `status_changed` 콜백(격리 기록 후, 거부 해소 건수>0 후),
`initialize`에 ping 클로저(export 전이), `watch_vault` 성패 전이,
`notes_sync_flush` 실패. 실패 테스트: `vault_watch.rs`
`an_unreadable_file_reports_itself` — 깨진 md가 있는 vault에서 watch를 시작하면
(시작 스캔이 즉시 도니) status 콜백이 10초 안에 온다. red: 콜백 파라미터가 없어
컴파일 실패.

**8. 프런트: 배지 + listener + api**
`syncChanged.ts` 일반화(이벤트 이름 인자, `SYNC_STATUS` 상수, 기존 특수화 유지),
`api.ts`에 `syncStatus()`, `SyncStatusBadge.tsx`, `App.tsx` 마운트(nav footer 위) +
mount 질의 + ping 재질의. 실패 테스트: `SyncStatusBadge.test.tsx`
`shows_nothing_when_sync_is_healthy`와 `names_the_refused_file_and_why`. red:
컴포넌트가 없어 import 실패. 보조: `syncChanged.test.ts`에 이벤트 이름 인자 케이스.

## 게이트 (diff 확정 후 1회)

```
cargo test --workspace
cargo fmt --all -- --check
npm run test:v2:frontend
npm run lint:v2
npm run test:v2:architecture
npm run test:v2:contracts
git diff --check
```

Rust·IPC·persistence·프런트가 모두 바뀌므로 양쪽 게이트를 다 돌린다. Clippy는 이번
경계에 새 baseline 요구가 없어 비교하지 않는다. 수동 확인 두 줄(계약 표)은 fresh
빌드에서 한다.
