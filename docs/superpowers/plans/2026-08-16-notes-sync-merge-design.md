# Notes 동기화 병합(M3.1) 상세 설계

- 작성: 2026-08-16. 기준 브랜치 `feat/sync-m1-domain-repairs`, M1·M2 green.
- 상위 문서: [sync 스펙](../../v2/sync-spec.md) §6·§8·§9, [구현 계획](2026-08-15-notes-sync-port-implementation-plan.md) §M3, [테스트 설계](2026-08-15-notes-sync-port-test-design.md) §6.1.
- 지위: 이 문서는 M3.1의 스펙 조항을 코드가 따를 수 있는 결정으로 내린다. 스펙과 어긋나는 결정은 없다. 구현 계획 §4.2 한 곳(트랜잭션 소유)과 테스트 설계 §6.1 한 곳(테스트가 스키마를 얻는 방법)을 개정하고, 그 사유를 §1과 §9에 적는다.
- v1 `src-tauri/src/notes/sync/merger.rs`(6,766줄)는 동결 oracle이다. 계승·폐기 목록은 §11.

## 0. 결정 요약

| # | 결정 | 절 |
|---|---|---|
| 1 | 트레이트 없음. 병합은 `&Transaction`을 받는 notes-sync 함수이고, 트랜잭션·revision·path 재계산은 워커(notes-sqlite)가 소유한다 — 계획 §4.2 개정 | §1 |
| 2 | 같은 t에서 저작과 원격 충돌을 가르는 증거는 **스탬프의 device 필드 == `sync_meta.device_id`** 하나다 | §2.3 |
| 3 | 위치 증거는 sort_key 원값이 아니라 **(부모, 앞 형제 id)** 다. 채택도 이웃 사이 midpoint로 한다 | §2.1 |
| 4 | 원격이 이길 때 **dirty였던 로컬 상태를 패자로 기록**한다 — v1에 없던 규칙, 미방출 편집의 유일본 소실을 막는다 | §2.4 |
| 5 | 충돌 로그 중복 판정 키는 `(node_id, loser_hlc, loser_json)` — v1과 달리 winner를 뺀다 | §7 |
| 6 | 드리프트 재스탬프는 내용이 로컬과 다를 때만 발급한다. 같으면 기존 스탬프를 지킨다 | §5 |
| 7 | 분할 자식의 첫 상태 적용은 **`sync_documents`에 그 root_id 행이 없다는 것**을 증거로 같은 t에서도 무조건 적용한다 | §6 |
| 8 | property는 돌연변이 기반으로 판 두 개를 만들고, 덤프는 신규 발급 스탬프를 sentinel로 치환하며 sort_key 대신 형제 순위를 비교한다 | §8 |
| 9 | M3.1은 한 커밋에 담기지 않는다 — M3.1a~e 다섯 항목으로 나눈다 | §9 |
| 10 | 스키마 접촉 2건: `schema.sql` 추출(의미 불변), `notes_images.content_hash`에 빈 값 허용(자산 미도착 이미지의 메타 저장처) | §12 |

## 1. 자리와 시그니처 — 병합은 트랜잭션을 받는 라이브러리 함수다

**트레이트 포트는 만들지 않는다.** notes-sync는 이미 rusqlite 위의 라이브러리다 — `hlc::reseed`가 `sync_documents`를 직접 SELECT한다. 금지된 것은 notes-sqlite **크레이트** 의존(`scripts/checkV2Architecture.mjs:7-11`)이지 SQL이 아니다. 경계는 이렇게 갈린다: **DDL과 살림(revision·`notes_nodes.path`·트랜잭션 경계)은 notes-sqlite가, sync 의미론의 DML은 notes-sync가** 진다. 노드 상태를 트레이트로 주고받으면 문서당 수천 왕복이 생겨 §9.2의 질의 수 상한에 닿을 수 없다.

```rust
// crates/notes-sync/src/merger.rs
pub struct MergeInput {
    /// vault 루트 기준 문서 경로 — "README.md", "Projects-…/README.md", ".yonalist/trash.md"
    pub file_path: String,
    /// 병합 직전에 읽은 파일 바이트의 SHA-256 hex
    pub file_hash: String,
    pub file_mtime_ms: Option<i64>,
    pub file_size: Option<i64>,
}

pub struct MergeOutcome {
    /// 실제로 쓴 행 수. 0이면 no-op — 워커가 revision을 올리지 않는 근거
    pub applied: usize,
    pub changed_ids: BTreeSet<String>,
    /// 이번 병합으로 deleted = 1이 된 행
    pub deleted_ids: BTreeSet<String>,
    pub needs_write_back: bool,
    pub conflicts_recorded: usize,
    pub parked_ids: BTreeSet<String>,
}

pub fn merge_document(
    txn: &rusqlite::Transaction<'_>,
    clock: &crate::hlc::Clock,
    file: &crate::document::VaultFile,
    input: &MergeInput,
) -> Result<MergeOutcome, MergeError>;
```

**계획 §4.2 개정 — 트랜잭션은 워커가 연다.** 원안은 `merge_topic_doc(&mut Connection, …)`이 스스로 IMMEDIATE 트랜잭션을 열었다. 그런데 병합이 부모·순서를 바꾸면 파생 컬럼 `path`를 같은 트랜잭션 안에서 다시 세워야 하고(`node_paths::refresh`), revision 증가도 같은 트랜잭션이어야 한다. 둘 다 notes-sqlite의 살림이라 notes-sync가 할 수 없다. 그래서 M3.2의 워커 처리는 이 모양이 된다:

```text
Request::MergeDocument → begin IMMEDIATE
  → notes_sync::merger::merge_document(&txn, &clock, &file, &input)
  → crate::node_paths — outcome.changed_ids의 서브트리 path 재계산
  → outcome.applied > 0 이면 notes_meta.revision += 1
  → commit → outcome 반환
```

이 개정으로 M3.1의 단위 테스트도 자연스러워진다: 테스트가 트랜잭션을 직접 열고 병합을 부른 뒤 커밋 없이 검사할 수 있다.

**병합이 쓰는 표**: `notes_nodes`(+`sync_extras`), `notes_images`, `sync_documents`, `sync_dirty_nodes`, `sync_conflict_log`. `sync_node_exports`는 만지지 않는다 — 그 표는 방출(M4)의 것이다. `sync_documents` upsert는 root_id 기준이고 trash 문서의 키는 스펙 §4.6의 리터럴 `yonalist-trash`다. `folder_path`는 `input.file_path`로 갱신한다 — 폴더 이름이 바뀌어도 `id`가 같으면 같은 문서라는 §6 규칙이 여기서 실현된다. write-back이 필요 없는 병합은 `exported_hash = input.file_hash`를 기록해 watcher의 에코 skip을 준비하고, 필요한 병합은 낡은 해시를 남겨 exporter가 다시 쓰게 둔다. 병합 성공은 `quarantined = 0`을 놓는다.

**질의 예산.** 적재는 문서 크기와 무관하게 상수 개다: sync_meta 1문, sync_documents 1문, 파일이 실은 id 전체의 행을 `json_each` 한 문으로, 그 부모들의 형제 목록 한 문, dirty 여부 한 문 — 5문 이하. 적용도 상수 개다: 신규 행 일괄 INSERT 1문, 승자 행 일괄 UPDATE 1문, 같은-t 채택 행의 스탬프 복원 UPDATE 1문, dirty 정리 1~2문, 충돌 로그·sync_documents·복구 페이지 각 1문 안팎 — 8문 안쪽. v1은 노드마다 `node_exists`·`topic_parent_is_viable`을 물어 N+1이었다. §9.2의 `a_merge_loads_the_document_nodes_in_one_query`가 이 예산의 기계 검사다(게이트는 M6.3, M3.1은 예비 실행).

**스탬핑 트리거와의 계약** (불변 규칙 6). INSERT는 명시 hlc를 실으므로 `WHEN NEW.hlc = ''`에 걸리지 않는다. UPDATE에서 hlc가 바뀌는 경로도 `WHEN NEW.hlc = OLD.hlc`에 걸리지 않는다. 유일한 예외가 §2.3의 "t를 지키는 채택"이다 — 내용만 바꾸고 hlc를 그대로 두면 트리거가 fresh 스탬프를 덮는다. v1이 이미 같은 문제를 3단계로 풀었다(`merger.rs:2077-2097`): 쓰고 → 의도한 hlc로 복원하고(UPDATE OF 목록에 hlc가 없어 트리거 미발화) → 트리거가 남긴 dirty를 지운다. 이 패턴을 json_each 일괄문으로 이식한다. 관찰면: `a_merged_stamp_survives_the_stamping_triggers`.

**테스트가 스키마를 얻는 방법** (테스트 설계 §6.1 개정). 병합 테스트는 `crates/notes-sync/src/merger.rs`의 테스트 모듈에 두되 진짜 스키마가 필요하다. notes-sqlite를 dev-dependency로 넣으면 아키텍처 검사가 죽고, DDL을 복사하면 표류한다. 대신 `create_schema`의 SQL 리터럴을 `crates/notes-sqlite/src/schema.sql`로 빼고 `schema.rs`는 `include_str!`로 되읽는다(의미 불변, notes-sqlite 기존 테스트가 회귀 그물). notes-sync 테스트는 `include_str!("../../notes-sqlite/src/schema.sql")`로 같은 DDL을 실행한다. 진실 소스가 하나라 표류가 없다.

## 1.5 구현이 되돌린 것 — 설계 개정 5건 (2026-08-16, M3.1a·b 리뷰)

구현이 설계의 빈틈을 드러낸 자리다. 아래가 정본이다.

1. **문서 루트는 위치를 주장하지 않는다.** §2.1·§2.2는 루트 항목이 사다리에 어떻게 들어가는지 말하지 않았고, 구현은 없는 위치를 "root의 첫 자식"이라는 적극적 주장으로 바꿨다. 결과: 두 번째 페이지가 목록 맨 앞에 꽂히고, 그 페이지의 README를 다시 읽으면 같은 t 저작 갈래에 걸려 **페이지가 앞으로 끌려가며 재스탬프**되고 그 스탬프가 fleet 전체로 퍼진다. 페이지 문서(와 분할 문서)의 루트는 **상태만** 싣는다 — 정규화 내용에서 부모·predecessor를 빼고, 자리는 행이 이미 가진 것을 지키며, 신규는 목록 끝에 붙인다. 진짜 자리는 home의 줄이 준다.
2. **위치 증거는 적용 시점 순서로 판정한다.** 병합 시작 시점의 스냅샷으로 비교하면 형제 하나가 앞으로 가는 순간 그 뒤 형제들이 전부 "이동한 것"으로 보여 같은 t 기계를 타고, 아무도 지지 않은 패배가 로그에 쌓인다. §1이 이미 예산에 넣어 둔 "부모들의 형제 목록 한 문"을 메모리에 들고 쓰기마다 갱신한다.
3. **드리프트가 덮은 것도 §2.4를 지난다.** §5는 재스탬프와 기록만 말했고 구현은 **이긴 쪽(파일)의 내용**을 패자로 남겼다. 로컬 행이 있으면 그 행이 패자다 — dirty였다면 그 내용은 어디에도 사본이 없다.
4. **적용 예산 ≤8문은 성립하지 않는다.** 자리 계산이 앞선 쓰기에 의존해 일괄문으로 묶이지 않는다. 실제 모양은 **에코·재생 경로는 상수문**(변경 0이면 적재 3문 + 문서 기록 1문), **변경분에는 노드당 상수문**이다. M6.3의 게이트는 이 형태로 잡는다. `prepare_cached`로 준비 비용은 상수다.
5. **이미지 인입은 M3.1a 소유다.** §12.2의 CHECK 완화와 `notes_images` 기록이 a~e 어느 행에도 없었다. 행이 없으면 정규화 내용이 영원히 어긋나 **같은 파일을 읽을 때마다 편집으로 보이고**, 내 스탬프면 재스탬프가 끝없이 돈다. `mime_type`은 링크 경로의 확장자에서 온다 — 파일 안에 다른 출처가 없다.

부수 결정 둘: 재간격(renumber)은 `sort_key`가 스탬핑 트리거의 컬럼 목록에 있어 **형제 전부를 재스탬프한다** — 3단계 패턴으로 스탬프를 되돌리고, 원래 dirty였던 행의 표시는 건드리지 않는다(그 표시는 로컬 편집의 것이다). 그리고 타이브레이크 비교는 §2.1대로 **SHA-256 digest**다 — 원문 문자열 순서와 digest 순서는 다른 승자를 뽑고, M4가 같은 함수를 해시로 쓰는 순간 갈라진다.

### 1.5.1 2차 리뷰가 되돌린 것 (M3.1a·b rework 재리뷰)

1. **id 발급은 flatten에서 한다.** 뒤 형제가 "누구를 따른다"는 증거를 잡는 시점이 발급보다 앞서면, 손으로 친 줄 하나가 뒤 형제를 "첫 번째"로 만들어 **문서 전체가 그 줄을 중심으로 재배열되고 이웃들이 로컬 스탬프로 다시 찍힌다.**
2. **`SiblingOrder`는 위치 없는 항목이 떨어질 부모(`root`)도 적재한다.** 안 하면 신규 페이지가 전부 같은 키를 받아 순서가 id에 맡겨진다 — §1.5-1의 "신규는 목록 끝에 붙인다"가 지켜지지 않는다.
3. **드리프트 에코도 write-back을 요구한다.** §5 둘째 분기의 "write-back만 표시한다"가 구현에서 빠져, 재생이 방출보다 먼저 오면 `exported_hash`가 고장 난 파일을 정상으로 기록하고 미래 스탬프가 vault에 영원히 남는다.
4. **`loser_json`은 손으로 만든 JSON이다 — 제어문자를 이스케이프해야 한다.** 줄바꿈 하나로 파싱 불가가 되고, M3.4가 읽지도 복구하지도 못한다. 값은 문자열이 아니라 제 타입으로 싣고 `predecessor_id`·`image`를 포함한다(§7이 요구한 자족성).
5. **파일이 지는 같은-t는 `same_t`다.** 호출 자리에서 `lww`로 굳어 있었다.
6. **`document_is_missing_nodes`는 재귀 CTE 한 문이다.** 노드당 한 문이면 §1.5-4의 "에코 경로는 상수문"을 같은 커밋에서 어긴다. 빈 스탬프(자리표시)는 "오래된 것"이 아니라 **아직 없는 것**이라 누락으로 세지 않는다 — 안 그러면 영구 write-back이다.
7. **이미지 경계는 파서가 본다.** `w:` 하한·픽셀·바이트 상한·확장자는 포맷의 사실이라 격리 사유로 답해야 한다. 병합까지 흘러가면 DB 제약이 읽을 수 없는 문자열로 죽인다.

## 2. 판정 사다리 — 노드 하나가 지나는 순서

HLC 비교는 17자 문자열 비교이고 동률 해소 순서는 인코딩이 강제한다: **millis → counter → device**. 문자열까지 같아야 "같은 t"다. 빈 스탬프는 모든 비교에서 진다.

### 2.1 정규화 내용과 위치 증거

같은-t 판정과 타이브레이크가 쓰는 **정규화 내용**은 노드 하나를 고정 순서 필드로 이어붙인 바이트열이다:

```text
v1 \0 kind \0 본문 \0 note \0 marker \0 ordered_start \0 collapsed \0 completed
   \0 starred \0 deleted \0 parent_id \0 predecessor_id \0 extras(만난 순서 join)
```

- 본문: 텍스트 노드는 text, 이미지 노드는 `원본명 \0 디스크 이름 \0 w \0 px \0 bytes`. 디스크 **이름**(경로의 basename)은 정체성이지만 `../` 깊이는 넣지 않는다 — 첨부 위치는 노드 내용이 아니다(스펙 §9).
- split 노드는 존재·부모·predecessor만 — 상태 필드는 자식 문서가 권위라 비교 대상이 아니다(§6).
- 해시는 SHA-256, 비교는 digest 바이트 사전순. M4의 `sync_node_exports.content_hash`도 이 함수를 그대로 쓴다 — 정의는 한 곳이다.

**위치 증거는 `(parent_id, predecessor_id)`다** — predecessor는 파일에서는 바로 앞 형제 줄의 id, DB에서는 `(sort_key, id)` 오름차순의 바로 앞 live 형제 id, 첫 형제는 빈 값. sort_key 원값을 증거로 쓰면 파서의 `ordinal * SORT_KEY_STEP` 양자화와 DB의 midpoint 키가 항상 어긋나 모든 에코가 이동으로 보인다. **채택도 상대적이다**: 승자 노드는 "이 부모 아래, 이 형제 뒤"로 자리 잡고 sort_key는 로컬 이웃 사이 midpoint로 계산한다(notes-core `tree.rs:226-246`과 같은 계산 — 그 메서드는 비공개라 notes-sync에 10줄 재구현, 두 구현은 §8의 수렴 property가 함께 검증한다). 이 방식이라야 형제 하나를 맨 앞으로 옮긴 파일이 손대지 않은 나머지 형제들을 건드리지 않는다.

### 2.2 세 경우

문서의 노드를 파일 순서(부모 먼저)로 돈다. 노드마다:

0. **드리프트 가드** — §5. 이후 단계는 가드를 지난 유효 스탬프로 본다.
1. **로컬 행이 없다** → INSERT. 파일이 실은 t·상태·위치 그대로. `yid`가 없거나, 있어도 로컬에 없으면서 t까지 없는 줄은 손으로 만든 입력이다 — fresh UUID와 fresh 스탬프를 발급하고 write-back을 표시한다(v1 A5 그대로. 손이 지어낸 yid는 버린다 — id 선점을 막는다).
2. **파일 t > 로컬 t** → 원격 승. 상태·위치·스탬프 전부 채택. 로컬 행이 dirty였고 내용이 다르면 §2.4로 로컬 상태를 패자 기록. 채택한 노드의 dirty는 지운다.
3. **파일 t < 로컬 t** → 로컬 승. 행은 그대로, 파일의 노드를 §7 규칙으로 한 번 기록, write-back 표시(파일이 낡았으니 다시 써서 승자를 알린다).
4. **파일 t == 로컬 t** → 정규화 내용 비교. 같으면 skip(멱등의 바탕). 다르면 §2.3.

관찰 정책: 사다리를 돌며 만나는 모든 유효 스탬프를 `clock.observe`한다 — 병합 뒤 로컬 발급분이 항상 원격을 이긴다(스펙 §4.1). 드리프트 초과분만 제외한다(§5).

### 2.3 같은 t의 두 갈래 — 증거는 스탬프의 device 필드

같은 t에 내용이 다르면 누군가 스탬프를 안 바꾸고 내용을 바꿨다 — 손편집이다. 문제는 "내 vault의 손편집"과 "원격에서 흘러온 손편집"을 가르는 것인데, watcher는 도움이 안 된다: iCloud가 쓴 파일과 vim이 쓴 파일은 파일시스템 이벤트로 구분되지 않고, `exported_hash` 불일치는 두 경우에 다 성립한다. **병합 시점에 남는 유일한 결정적 증거는 스탬프 안의 device 필드다.**

- **`t.device == sync_meta.device_id`(내 스탬프)** → **저작**. 이 스탬프는 내가 발급했고, 다른 기기는 내용을 바꿀 때 자기 device로 재스탬프하므로 내 스탬프 밑의 다른 내용은 손편집뿐이다. 파일의 내용·위치를 채택하고 **fresh HLC**를 찍고 write-back한다(v1 A4 계승, `merger.rs:2023-2041`). 충돌 로그는 안 남긴다 — 편집이지 충돌이 아니다.
- **`t.device != 내 device`(남의 스탬프)** → **내용 타이브레이크**. fresh HLC를 발급하면 병합 순서가 결과를 바꾼다(스펙 §6). 정규화 내용 해시가 큰 쪽이 이긴다: 파일이 이기면 **t를 지킨 채** 내용·위치를 채택하고(트리거 우회는 §1), 로컬이 이기면 행을 지키고 write-back한다. 진 쪽은 §7로 기록한다.

이 배정이 수렴을 만든다: 어떤 스탬프든 fleet 전체에서 소유 기기는 하나뿐이라 저작 재스탬프는 정확히 한 곳에서만 일어나고, 나머지 전 기기는 교환적인 타이브레이크로 같은 답을 낸다. 소유 기기의 재스탬프가 도착하면 정상 LWW로 정리된다. device 4-hex 충돌(1/65,536)은 양쪽이 저작으로 갈려 잠시 스탬프가 겨루지만 LWW로 수습된다 — 스펙이 이미 안고 가는 구석이다.

### 2.4 dirty 패자 기록 — v1에 없던 규칙

v1은 원격이 질 때만 기록했다. 그러면 이 시나리오가 소리 없이 내용을 잃는다: 내가 방금 편집해서 아직 방출하지 못한 노드(= `sync_dirty_nodes`에 있음)를 더 새 스탬프의 원격이 덮으면, 그 내용은 어느 파일에도 어느 로그에도 없다. 그래서 **원격 승 채택 직전, 로컬 행이 dirty이고 내용이 다르면 로컬 상태를 패자로 기록**한다. dirty가 아니면 기록하지 않는다 — 이미 방출된 상태는 다른 기기의 충돌 로그나 vault 어딘가에 살아 있고, 다 기록하면 따라잡기 병합마다 로그가 수천 줄 쌓인다. M6의 `same_node_concurrent_edits_keep_the_loser_recoverable`이 요구하는 "패자가 복구 가능"이 이 규칙 없이는 이 경우에 성립하지 않는다.

## 3. 삭제 — trash.md만 증거다

**부재는 아무 일도 하지 않는다.** 페이지 문서 병합은 파일에 없는 로컬 노드를 지우지도 휴지통에 넣지도 않는다. 문서에 남았어야 할 노드가 로컬에 더 있으면(문서의 `applied_max_hlc`보다 오래된 로컬 노드가 파일에 없음) write-back만 표시한다 — 다음 방출이 파일을 완성한다(v1 `topic_has_missing_older_nodes` 계승).

**trash.md 병합은 "deleted = 1인 상태"의 LWW다.** 삭제는 노드의 한 상태라 §2의 사다리를 그대로 탄다:

- trash 루트는 `from: <parent>@<sort_key>`가 실은 값으로 `parent_id`·`sort_key`를 잡고 `deleted = 1`로 upsert한다. 자식은 부모가 같이 왔으니 줄 위치로 잡는다. **행이 자리를 기억하는 것**이 복원의 전부다: 어느 기기든 복원 명령은 `deleted = 0`만 뒤집으면 행에 남은 parent·sort_key가 제자리를 준다 — `restoring_from_trash_puts_the_node_back_where_it_was`가 잠그는 계약이다.
- **삭제 대 편집**: 같은 행을 두고 t가 겨룬다. 삭제 t가 더 새면 편집은 지고(§7 기록) 노드는 휴지통으로 간다. 편집 t가 더 새면 노드는 살아 있고 trash 줄이 진다 — 기록하고 trash 문서의 write-back을 표시하면 다음 trash.md 방출에서 그 줄이 사라진다. 같은 t는 §2.3 그대로다(deleted 플래그가 정규화 내용에 들어 있다).
- `from:`의 부모가 로컬에 없으면(문서 도착 순서) **deleted 자리표시 행**을 만든다: id = 그 부모, `parent_id = 'root'`, `deleted = 1`, `hlc = ''`, 빈 텍스트. 빈 스탬프라 진짜 문서가 도착하는 순간 전부 진다. 렌더러가 빈 t를 거부하므로 exporter는 `hlc = ''` 행을 방출 대상에서 건너뛰어야 한다 — M4.1에 메모로 넘긴다(§12).
- topic 문서가 로컬 deleted 행을 더 새 t로 싣고 오면 복원이다: `deleted = 0`, 파일 위치로 되돌린다. 별도 규칙이 아니라 사다리의 원격 승 경로다.

## 4. 사이클 파킹과 복구 페이지

이동 병합이 고리를 만들 수 있다: A 기기가 n1을 n2 밑으로, B 기기가 n2를 n1 밑으로 옮긴 파일이 교차 도착하면 어느 한쪽을 적용한 DB에 다른 쪽이 겹치며 부모 사슬이 닫힌다.

결정성은 세 가지가 만든다(v1 `park_cycles` 계승).

1. **후보 집합** — 이번 병합에서 부모가 실제로 바뀐 노드(moved 집합)에서 출발해 부모 사슬을 걷다 고리를 찾는다.
2. **선택** — 고리 안에서 `(행에 저장된 이동 HLC, id)` 오름차순 최소인 노드 하나. 이동 HLC는 파일이 실어 온 값이라 같은 파일·같은 사전 상태를 병합하는 어느 기기든 같은 노드를 고른다.
3. **목적지** — 복구 페이지 아래, sort_key는 노드 id에서 파생한 결정적 값(v1 `safe_recovery_sort_key` 이식 — JS 안전 정수 안).

고리가 없어질 때까지 반복한다. 파킹은 fresh 스탬프를 찍고 dirty를 표시한다 — 계약은 "같은 입력이면 같은 노드가 파킹된다"이지 스탬프 바이트가 아니다(스펙 §9). **복구 페이지**는 id = `uuid v5(sync_meta.vault_uuid, "yonalist-recovery-page")`, root의 직계 자식(bullet), 제목 "복구됨", 필요할 때 lazy 생성. vault_uuid가 기기마다 달라 둘이 생길 수 있고 LWW로 공존한다.

같은 기계를 **고아 수리**가 쓴다(v1 `repair_affected_tree_integrity`의 v2 축소판 — archive·purge 분기가 없어 한 규칙만 남는다): 병합이 만진 서브트리에서 live 노드의 부모가 deleted이거나 없으면 그 노드를 복구 페이지로 파킹한다. 삭제가 이긴 부모 밑에 더 새 편집이 이긴 자식이 남는 경우가 여기로 온다. 깊이 캡(128) 초과 서브트리도 같은 자리에서 파킹한다(v1 `park_overdeep_subtrees`의 한 패스 방식).

## 5. 24시간 미래 스탬프

파일 스탬프가 로컬 벽시계보다 24시간 넘게 앞서면(`Clock::is_beyond_drift`) 그 스탬프는 고장 난 시계의 산물이다.

- **내용이 로컬과 다르면** fresh HLC로 재스탬프해 채택하고 §7에 기록한다(loser_json에 `"reason": "clock_drift"`). write-back으로 파일의 스탬프도 고친다.
- **내용이 로컬과 같으면** 발급도 기록도 하지 않고 write-back만 표시한다. 이 분기가 없으면 write-back이 닿기 전의 재병합마다 새 스탬프와 새 로그가 쌓인다 — 재생이 수렴하는 근거다.
- **절대 observe하지 않는다.** 두 가지가 무너지기 때문이다. 첫째, 흡수하면 이후 모든 로컬 발급이 그 미래 시각을 물려받아 재스탬프 정책 자체가 무력해진다 — 온 vault가 미래 스탬프로 오염된다. 둘째, 인코딩 상한 근처의 폭주 값을 흡수하면 `now()`가 영영 실패한다 — 그 행을 지울 삭제조차 발급하지 못하는 쐐기다(`hlc.rs`의 `a_reading_from_the_far_future_is_left_behind`가 이미 재시드 쪽에서 증명한 유형).

## 6. 분할 문서 — 권위 분리와 도착 순서

한 노드가 두 파일에 실린다: 부모 문서의 split 줄과 자식 문서의 frontmatter. 권위를 몰아 두었으므로(스펙 §4.5) 병합도 두 쪽을 다르게 읽는다.

**split 줄이 주는 것** — 존재·부모·형제 사이 위치, 그리고 스탬프 사본. 줄의 t ≥ 노드 hlc면 위치를 적용하고 t를 채택한다. t < 노드 hlc면 낡은 사본이라 건너뛴다. 같은 t에 위치가 다르면 §2.3의 기계가 위치만으로 돈다(split의 정규화 내용이 존재·부모·predecessor뿐이라 자동으로 그렇게 된다). **상태 필드(제목·marker·star·done·collapsed)는 어떤 경우에도 줄에서 읽지 않는다** — 파서가 이미 지운다(`parse.rs`의 split 분기).

**노드가 처음 보이는 split 줄** — 자식 문서가 아직 안 왔다. 노드를 만들되 상태는 기본값, 제목은 링크 텍스트(표시용 잠정값), hlc는 줄의 t. `sync_documents`에 그 root_id 행은 만들지 않는다 — 이 부재가 "자식 문서를 아직 적용한 적 없음"의 증거다.

**자식 문서 병합** — frontmatter의 `parent`·`sort_key`로 자리를 주장하지만 부모 문서 줄 순서가 이기므로(스펙 §4.2) 로컬에 이미 위치가 있으면 frontmatter 위치는 참고만 한다. 상태는 root_* 키가 권위다. 적용 판정:

- `root_hlc > 노드 hlc` → 정상 원격 승.
- `root_hlc == 노드 hlc`이고 상태가 다른데 **`sync_documents`에 이 root_id 행이 없다** → 첫 도착이다. 타이브레이크 없이 무조건 적용하고 행을 만든다. 부모-먼저 도착에서 split 줄이 심은 잠정 상태와 자식의 진짜 상태가 같은 t를 들고 만나는 것은 두 파일 형식의 정상 모습이지 충돌이 아니기 때문이다.
- 행이 이미 있으면 §2.3 그대로 — 두 번째 이후의 같은 t 불일치는 진짜 손편집이다.

**자식-먼저 도착에서 frontmatter의 `parent`가 로컬에 없으면** live 자리표시 노드를 만든다: id = 그 부모, 복구 페이지 아래, `hlc = ''`, 빈 텍스트. 빈 스탬프라 부모의 진짜 문서가 오는 순간 내용과 위치를 전부 내준다. 파킹처럼 fresh 스탬프를 찍으면 안 된다 — 잠정 위치가 진짜 문서의 위치 증거를 이겨 버린다.

두 방향(부모 먼저 / 자식 먼저)이 같은 상태에 닿는 것을 `a_child_document_converges_in_either_arrival_order`가 잠근다.

## 7. 충돌 로그 행

`sync_conflict_log(seq, node_id, loser_json, loser_hlc, winner_hlc, recorded_at)` 스키마 그대로, 컬럼 추가 없음.

**loser_json**은 진 상태의 자족적 JSON이다 — M3.4가 이것만으로 목록을 그리고 복구를 만든다:

```json
{ "v": 1, "id": "…", "parent_id": "…", "predecessor_id": "…", "kind": "bullet",
  "text": "…", "note": "…", "marker": "todo", "ordered_start": 1,
  "collapsed": false, "completed": false, "starred": false, "deleted": false,
  "image": null, "extras": [], "reason": "lww" }
```

`reason`은 `"lww"` | `"same_t"` | `"clock_drift"` | `"dirty_overwrite"`. 복구(M3.4)는 이 JSON을 새 편집으로 재적용한다 — fresh 스탬프를 받아 정상 LWW로 전파되는 것이 "복구 = 새 편집" 계약이다. 렌더에는 `text`(이미지면 원본명)와 `recorded_at`·`reason`이면 충분하다.

**한 번만 기록**: INSERT를 `WHERE NOT EXISTS (같은 node_id, loser_hlc, loser_json)`로 가드한다. v1은 winner_hlc까지 키에 넣었는데, 그러면 같은 낡은 파일이 로컬이 전진할 때마다 다시 기록된다 — winner는 정보용 컬럼으로 남기고 중복 판정에서 뺀다. 관찰면: `a_loser_is_recorded_once_in_the_conflict_log`(같은 문서 2회 병합 = 1행)에 "로컬이 한 번 더 전진한 뒤 3회째 병합도 여전히 1행" 단언을 더한다.

보존 상한(1,000건·180일)과 읽기·복구 IPC는 M3.4 소유다.

## 7.5 미해결 — 순서 수렴 (M3.1e가 property로 반증함)

**상태 수렴은 성립한다. 순서 수렴은 성립하지 않는다.** §8의 생성기가 반례를
줄여서 내놓았고, 그 자리에 지금 설계에는 규칙이 없다.

```
base:   [n1, n2, n3], 세 스탬프 모두 같음
파일 A: n2를 맨 앞으로 옮기고 재스탬프
파일 B: n1을 제자리에서 재스탬프(이동 없음)

A→B: n3의 주장이 "n1 뒤"
B→A: n3의 주장이 "n2 뒤"
```

n3는 **한 번도 움직이지 않았는데** 처음 보인 파일의 줄 순서로 자기 주장이 정해진다.
두 vault가 같은 노트를 다른 순서로 들게 된다.

지금까지 넣은 것(그리고 그 한계):

1. 주장을 행에 남긴다 — `notes_nodes.sync_prev`. 없으면 이웃 스탬프가 **언제**
   바뀌었는지에 답이 걸린다.
2. 스탬프가 나아간 노드만 자리를 주장한다. 타이브레이크는 스탬프를 유지하므로
   주장도 그대로다.
3. 순서는 주장에서 매번 재구성한다 — 오래된 주장부터 깔고 새 주장이 덮는다.

이 셋으로 **한 번이라도 움직인 노드**는 가환이 됐다. 남은 구멍은 **첫 도착 때
기록되는 주장**이다 — 비교할 이전 주장이 없어 파일의 줄 순서가 그대로 굳는다.

풀이 후보(설계가 골라야 한다):
- **(a)** 첫 도착 주장에 노드 자신의 스탬프가 아니라 **문서의 `max_hlc`**를 실어,
  더 새 문서의 줄 순서가 이긴다.
- **(b)** 주장을 파일에 싣는다 — 노드 주석에 `prev:` 토큰. 포맷 변경이고
  `format_version`이 걸린다.
- **(c)** 형제 순서를 노드 스탬프만으로 정한다. 완전 가환이지만 화면 순서가
  편집 최신순이 되어 아웃라이너로선 틀렸다.

`prop_merge_order_of_two_docs_does_not_change_the_state`와
`prop_two_dbs_converge_by_exchanging_exports`는 **약화해서 통과시키지 않고**
이 결정이 날 때까지 쓰지 않는다. 멱등 property는 지금 초록이다.

## 8. 병합 대수 property 전략 (테스트 설계 §6.1 구체화)

**생성기 — 돌연변이 기반.** 독립 문서 두 개를 뽑으면 id가 겹치지 않아 충돌이 영영 없다. 대신 **기준 문서 하나**(깊이 ≤ 4, 노드 ≤ 30, 전 노드 yid·hlc 보유 — canonical)를 뽑고, 두 "기기"가 각자 0~8개의 돌연변이를 얹어 판 A·판 B를 만든다:

- 돌연변이 종류: 필드 수정+재스탬프, 문서 안 이동+재스탬프, 서브트리를 trash 판으로 이동, **재스탬프 없는 내용 수정**(손편집 모사).
- 스탬프: millis를 0~15의 좁은 폭에서 뽑아 순서 역전과 근접 충돌 밀도를 올린다. 판 A의 재스탬프는 device `aaa1`, 판 B는 `bbb2`, **병합받는 DB의 device는 `cccc`** — 기준 문서 스탬프에도 `cccc`를 쓰지 않는다.
- 재스탬프 없는 수정은 **`cccc` 소유가 아닌 스탬프의 노드에만** 허용한다. 같은 t·다른 내용이 언제나 §2.3의 타이브레이크 갈래(교환적)로 가고, 저작 갈래(의도적으로 순서 의존 — 편집이니까)는 property 밖에 머문다. 저작 갈래는 단위 테스트 `a_local_hand_edit_is_restamped_as_authoring`이 잠근다.

**정규화 덤프.** `notes_nodes`(+`sync_extras`)를 id 순으로 뽑되:

- `path` 제외(notes-sqlite 파생 컬럼, seam 밖), `sort_key`는 원값 대신 **형제 순위**로 치환(midpoint 값은 이력 의존, 계약은 순서다),
- hlc는 **입력이 실어 온 스탬프 집합에 없으면 sentinel `fresh`로 치환**. 파킹·발급이 찍는 스탬프는 순서·기기마다 바이트가 다른 게 정상이고, 계약은 "같은 노드가 fresh를 받았다"이므로 fresh 노드 id 집합의 일치를 별도 단언한다.
- `sync_conflict_log`는 덤프에서 뺀다. 패자 기록은 기기별 감사 장부라 어느 쪽 순서로 만났느냐에 따라 남는 기기가 달라지는 것이 설계다(§2.4).

**세 property.**

| property | 실행 모양 | 단언 |
|---|---|---|
| `prop_merging_the_same_canonical_doc_twice_is_a_noop` | 판 A를 같은 DB에 2회 | 2회째 `outcome.applied == 0`, 덤프 불변. revision 판은 seam(§6.2)이 잠근다 |
| `prop_merge_order_of_two_docs_does_not_change_the_state` | DB₁에 A→B, DB₂에 B→A | 정규화 덤프 동일 + fresh 집합 동일 |
| `prop_two_dbs_converge_by_exchanging_exports` | DB₁←A, DB₂←B 후 서로의 render를 병합(write-back 반영분 포함 2라운드) | 두 DB 덤프 동일 — M2 렌더러를 그대로 물려 render∘parse∘merge 전체 고리를 덮는다 |

split 문서는 생성기에서 뺀다 — 두 파일 권위 분리는 §6의 단위 테스트가 소유하고, 생성기에 넣으면 실패 축소가 읽을 수 없어진다. 멱등 계약이 canonical 문서부터라는 스펙 §8-2의 단서(발급값 write-back 전 재생은 엄밀한 no-op이 아님)는 생성기가 canonical만 만들므로 property와 충돌하지 않는다.

## 9. 커밋 분해 — M3.1a ~ M3.1e

M3.1은 한 커밋에 담기지 않는다. v1 원본이 6,766줄이고 규칙 군이 다섯 개라, 항목당 1커밋 규율에 맞춰 다섯으로 나눈다. 각 행이 합격 조건과 첫 red 테스트를 소유한다. 의존은 a→b→c→d→e 직렬.

| 항목 | 내용 | 합격 조건 (acceptance) | 첫 red 테스트 |
|---|---|---|---|
| **M3.1a** 인입과 LWW 3분기 | `schema.sql` 추출, `MergeInput/MergeOutcome`, 상수 질의 적재, 세 경우 사다리(같은 t·내용 다름은 보수적 skip으로 두고 b가 연다), yid 발급, extras upsert, observe 정책+드리프트 가드, 충돌 로그(원격 패배·dirty 패자·중복 가드), `sync_documents` upsert, 트리거 3단계 패턴 | 파일의 노드가 LWW로 행에 착지하고, 부재가 아무것도 지우지 않으며, 패자·드리프트가 한 번씩만 기록된다 | `a_canonical_document_merges_into_an_empty_database` (컴파일 red) |
| **M3.1b** 같은 t 규칙 | 정규화 내용 함수(§2.1), 저작 갈래(device 증거), 내용 타이브레이크(t 유지 채택) | 같은 t·다른 내용이 내 스탬프면 fresh HLC 저작, 남의 스탬프면 내용 해시 승자 — 양방향 병합이 같은 답 | `a_local_hand_edit_is_restamped_as_authoring` |
| **M3.1c** trash 병합 | 삭제 상태 LWW, `from:` 자리 보존, deleted 자리표시 부모, trash 문서 write-back | 삭제가 trash.md 증거로만 전파되고 삭제·편집이 t로 겨루며 복원이 제자리로 돌아간다 | `deletion_needs_trash_evidence` |
| **M3.1d** 구조 수리 | 사이클 파킹, 복구 페이지 lazy 생성, 고아·깊이 파킹(repair.rs 흡수) | 이동 병합이 만든 고리·고아·초과 깊이가 같은 입력이면 같은 노드로 복구 페이지에 파킹된다 | `a_cycle_parks_the_same_node_for_the_same_input` |
| **M3.1e** 분할 권위와 대수 | split 줄 처리, 자식 첫 도착 규칙, live 자리표시 부모, proptest 생성기+정규화 덤프+property 3종 | 분할 문서가 도착 순서와 무관하게 수렴하고 property 3종이 green | `a_split_line_grants_existence_and_position_only` |

커밋 제목(저장소 관례):

- a: `feat(sync): merge vault documents into rows under LWW`
- b: `feat(sync): resolve equal-stamp conflicts by authorship and content hash`
- c: `feat(sync): propagate deletions through trash evidence`
- d: `feat(sync): park cycles and orphans on the recovery page deterministically`
- e: `feat(sync): give split lines position-only authority and lock the merge algebra`

러너는 전부 `cargo test -p notes-sync merger`. 테스트 설계 §6.1의 이름은 전원 위 다섯 항목 중 하나에 속한다: a — `a_node_missing_from_the_file_is_never_deleted`, `a_future_hlc_beyond_drift_is_restamped_and_logged`, `a_drifted_hlc_is_not_observed`, `a_loser_is_recorded_once_in_the_conflict_log`, `unknown_extras_are_upserted_with_the_node` / b — `a_local_hand_edit_is_restamped_as_authoring`, `a_remote_same_hlc_conflict_breaks_ties_by_content_hash` / c — `deletion_needs_trash_evidence`, `a_deletion_and_an_edit_compete_by_hlc`, `restoring_from_trash_puts_the_node_back_where_it_was` / d — `a_cycle_parks_the_same_node_for_the_same_input` / e — property 3종(HLC property는 M1.2가 이미 소유).

## 10. 규칙 ↔ red 테스트 대응 (삭제 검증)

규칙을 지우면 red가 되는 테스트. 그 방식으로 관찰되지 않는 규칙은 대신 무엇이 관찰되는지 적는다.

| 규칙 | 지우면 red가 되는 테스트 |
|---|---|
| 부재 ≠ 삭제 | `a_node_missing_from_the_file_is_never_deleted` |
| 삭제는 trash 증거만 | `deletion_needs_trash_evidence` |
| 삭제·편집 LWW | `a_deletion_and_an_edit_compete_by_hlc` |
| `from:` 자리 보존 | `restoring_from_trash_puts_the_node_back_where_it_was` |
| 드리프트 재스탬프+기록 | `a_future_hlc_beyond_drift_is_restamped_and_logged` |
| 드리프트 observe 제외 | `a_drifted_hlc_is_not_observed` — 병합 직후 로컬 발급 스탬프가 24h 창 안임을 단언 |
| 내용 같으면 재스탬프 없음(§5 두 번째 분기) | `a_drift_replay_before_write_back_is_quiet` (신규, a) — 같은 드리프트 파일 2회 병합 후 스탬프·로그 불변 |
| 저작 갈래 | `a_local_hand_edit_is_restamped_as_authoring` |
| 내용 타이브레이크·양방향 동일 | `a_remote_same_hlc_conflict_breaks_ties_by_content_hash` |
| dirty 패자 기록 | `a_dirty_local_loser_is_logged_before_it_is_overwritten` (신규, a) |
| 중복 없는 기록(winner 제외 키) | `a_loser_is_recorded_once_in_the_conflict_log` — 로컬 전진 후 3회째 병합 단언 포함 |
| yid 발급·write-back | `an_unstamped_bullet_gets_a_fresh_uuid_and_stamp` (신규, a — M6 §10.1-9의 선행) |
| extras 보존 | `unknown_extras_are_upserted_with_the_node` |
| 명시 스탬프가 트리거를 이긴다(불변 6) | `a_merged_stamp_survives_the_stamping_triggers` (신규, a) — t 유지 채택 후 행의 hlc == 파일 t |
| 위치 증거·상대 채택 | `a_reorder_touches_only_the_moved_sibling` (신규, b) — 형제 하나만 옮긴 파일 병합 후 나머지 형제의 hlc·sort_key 불변 |
| 파킹 결정성 | `a_cycle_parks_the_same_node_for_the_same_input` |
| 고아·깊이 파킹 | `an_orphaned_live_child_parks_on_the_recovery_page`, `a_merge_past_the_depth_cap_parks_the_shallowest_subtree` (신규, d) |
| split 줄 권위 | `a_split_line_grants_existence_and_position_only` (신규, e) |
| 자식 첫 도착 무조건 적용 | `a_child_document_converges_in_either_arrival_order` (신규, e) |
| 멱등·교환·수렴 | property 3종 |
| no-op은 applied 0 | 멱등 property의 `applied == 0` 단언 (revision 판은 §6.2 seam) |

삭제 검증이 안 되는 것들: **질의 예산**은 규칙이 아니라 구조라 M6.3의 카운터 테스트(`a_merge_loads_the_document_nodes_in_one_query`)가 관찰면이고 M3.1에서는 예비 실행만 한다. **BTreeMap-only·명시 정렬**은 지워도 우연히 green일 수 있다 — 관찰면은 property의 반복 실행(proptest 시드가 순회 순서 의존을 드러낸다)과 결정성 golden(M2)이다. **loser_json의 필드 구성**은 M3.4의 복구 테스트(`restoring_a_conflict_reapplies_the_loser_as_a_new_edit`)가 소비자 쪽에서 잠근다.

## 11. v1에서 가져오지 않는 것

6,766줄 중 다음 기계는 v2에 대응물이 없어 두고 온다. 항목마다 근거 하나.

| v1 기계 | 처분 |
|---|---|
| purge tombstone 전부(`apply_purge_evidence`, `sync_purged_tombstones` 참조, 자리표시 부모의 purge 검사) | 결정 7 — 삭제 증거는 trash.md뿐 |
| archive 수명(`archived_at`·`archive_root_id` 분기, `recover_archived_survivor`, `activate_archived_parked_descendants`) | v2 스키마에 archive가 없다 |
| GitHub·plugin 소유권(`validate_sync_ownership`, `notification_update_is_stale`, plugin_meta/plugin_state/readonly/collapsed_groups) | v2에 플러그인이 없다 |
| `layout_mode`, `image_offset_utf16`, deletion batch id | v2 도메인에 없는 필드 |
| `timestamp_for_hlc`의 updated_at 파생 | v2 `notes_nodes`에 타임스탬프 컬럼이 없다 |
| 클록 영속(`hlc::persist_clock`) | 스펙 §4.1 — 클록은 파생 상태, 부팅 재시드 |
| v3/v4 포맷 수용 창 | 결정 6 취소 — `format_version` 1만 |

계승하는 것: A4 저작(§2.3에서 절반으로 좁혀), A5 발급, 사이클 파킹의 선택 규칙, `safe_recovery_sort_key`, 충돌 로그 NOT EXISTS 가드(키 개정), 트리거 3단계 쓰기 패턴, `topic_has_missing_older_nodes`의 write-back 판정.

## 12. 스키마 접촉과 후속 메모

**스키마 접촉 2건** — 둘 다 제자리 수정이고 `user_version`은 1 그대로다(결정 15).

1. `create_schema`의 SQL 리터럴을 `crates/notes-sqlite/src/schema.sql`로 빼고 `include_str!`로 되읽는다. 바이트 이동뿐이라 의미가 안 변하고, notes-sync 테스트가 의존 방향을 깨지 않고 진짜 DDL을 얻는 유일한 길이다(§1).
2. `notes_images.content_hash`의 CHECK를 `content_hash = '' OR (length = 64 …)`로 완화한다. 근거: 스펙 §4.4가 "메타가 완전하면 자산 바이트 없이 노드를 적용"을 요구하는데, w·px·bytes 메타가 살 곳은 `notes_images`뿐이고 파일에는 해시 12자(디스크 이름)만 있어 64자 해시를 채울 수 없다. 빈 해시가 "바이트 미도착"의 표시이고 M5.2의 자산 인입이 채운다. 병합은 디스크 이름으로 `sync_assets`를 먼저 뒤져 이미 도착한 자산이면 완전한 행을 쓴다. 새 테이블·새 컬럼·버전 승급 없음. 개발 DB는 §5.2 절차로 재생성.

**후속 항목에 넘기는 메모** (이 설계가 만든 의무):

- M3.2 — 워커가 트랜잭션을 열고 `merge_document` → path 재계산 → 조건부 revision 증가 → commit 순서로 감싼다(§1). `MergeOutcome`의 changed ∪ deleted가 absorb_external의 affected다.
- M3.4 — loser_json `v: 1` 스키마(§7)가 읽기·복구의 wire 계약이다. `reason`을 목록에 노출한다.
- M4.1 — exporter는 `hlc = ''` 행(자리표시)을 방출에서 건너뛴다(§3·§6). 정규화 내용 함수(§2.1)를 `sync_node_exports.content_hash`에 재사용한다.
- M5.1 — watcher는 파싱까지 하고 `MergeInput`(경로·해시·stat)을 만들어 넘긴다. 격리 표시는 loader가, 해제는 병합이 한다.
- M6.3 — 질의 카운터 게이트에 §1의 예산(적재 ≤ 5문, 적용 ≤ 8문)을 상수로 쓴다.
