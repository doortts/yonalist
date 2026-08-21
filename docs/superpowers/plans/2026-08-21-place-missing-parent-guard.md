# place_missing_parent 삽입 결과 가드 Design Doc

- 작성일: 2026-08-21
- 상위 규칙: `.agents/skills/fable-opus-loop/SKILL.md`, `.agents/skills/delivering-yonalist-changes/SKILL.md`
- 대상 브랜치/워크트리: `claude/eloquent-kalam-107ff1`

## 1. Contract

| 항목 | 내용 |
| :--- | :--- |
| Goal | `place_missing_parent`의 후속 두 문장(hlc 비우기, dirty 마크 삭제)이 이 함수의 stand-in INSERT가 만든 행에만 닿는다. 관찰 가능한 결과: 복구 페이지 id를 `parent:`로 적은 자식 문서를 병합해도, 그 병합이 방금 만든 복구 페이지의 `sync_dirty_nodes` 마크가 남는다. |
| Acceptance | 아래 AC 표 |
| Non-goals | 아래 3절 |
| Boundaries | Rust(`crates/notes-sync`) + SQLite(`notes_nodes`, `sync_dirty_nodes`). React/IPC/macOS 없음. |
| Manual proof | N/A — 사용자 표면과 런타임 경계가 바뀌지 않는다. 결과는 DB 행 수준이고 회귀 테스트가 그대로 잠근다. |

| ID | Acceptance Row | Test |
| :--- | :--- | :--- |
| **AC-1** | 복구 페이지 id를 `parent:`로 적은 자식 문서를 병합하면 병합이 끝난 뒤에도 복구 페이지 행의 `sync_dirty_nodes` 마크가 남아 있고, 행의 text(`복구됨`)와 스탬프도 그대로다 | `merge_ingest.rs` 신규: `naming_the_recovery_page_as_a_parent_does_not_take_back_its_write` (red→green) |
| **AC-2** | 이미 살아 있는 빈 텍스트 노드를 `parent:`로 적은 자식 문서를 병합해도 그 노드의 hlc와 `sync_dirty_nodes` 행이 병합 전과 같다 | `merge_ingest.rs` 신규: `a_child_document_does_not_stand_in_for_a_parent_that_is_already_here` (green-on-arrival, 6절 참조) |

### Touched Files

- `crates/notes-sync/src/merger.rs` — `place_missing_parent`에 3줄 가드
- `crates/notes-sync/tests/merge_ingest.rs` — 테스트 2개 추가
- `crates/notes-sync/tests/zz_probe.rs` — 삭제 (untracked 임시 probe, AC-2 테스트가 대체)

## 2. 도달 가능성 판정

요청서가 말한 경로 — "이미 있던 빈 텍스트 노드의 hlc가 비워지고 dirty 마크가 사라진다" — 는 **도달 불가**다. 대신 요청서가 못 본 더 좁은 실제 결함이 하나 있고, 요청서가 제안한 가드가 그 결함의 근본 수정이다.

### 2a. 요청서의 경로가 막혀 있는 근거

- `place_missing_parent`의 유일한 호출자는 `merge_page`다 (`merger.rs:181`). `parent`는 파일 frontmatter의 `parent:` 값이다.
- 함수 첫 줄이 `parent == "root" || document_row_exists(...)`로 먼저 돌아간다 (`merger.rs:742-744`). `document_row_exists`는 `SELECT 1 FROM notes_nodes WHERE id = ?1` — deleted/text 필터가 없다 (`merger.rs:774-780`). 같은 트랜잭션 안이라 자기 쓰기를 전부 본다. 그러니 `ON CONFLICT(id)`가 부딪힐 수 있는 기존 행은 이 SELECT도 반드시 본다. 살아 있든 지워졌든, 텍스트가 비었든 아니든 행이 있으면 INSERT 앞에서 돌아간다.
- 경험적 확인: 메인 스레드가 남긴 untracked probe(`crates/notes-sync/tests/zz_probe.rs`)가 정확히 요청서의 시나리오 — 빈 텍스트 + dirty 마크를 가진 기존 노드를 parent로 적은 자식 문서 병합 — 를 재현하는데, 현재 코드에서 **통과한다** (`cargo test --test zz_probe` → ok). hlc도 마크도 그대로다.
- 검토한 다른 벡터들:
  - 한 트랜잭션에서 문서 여러 개 병합: 각 `merge_page`가 존재 검사를 다시 하고, 앞선 병합이 만든 행은 같은 트랜잭션이라 보인다. 구멍 없음.
  - trash 경로: `merge_trash`는 단수형을 부르지 않는다. 복수형 `place_missing_parents`(`merger.rs:322`)만 부르고, 그쪽은 이미 `inserted == 0 { continue }` 가드가 있다 (`merger.rs:809-811`).
  - 검사와 INSERT 사이의 행 삭제: 이 구간에서 `notes_nodes`를 쓰는 것은 `recovery_page` 호출(`merger.rs:746`) 하나뿐이고, 삭제가 아니라 삽입이다. → 이게 아래 2b다.

### 2b. 실재하는 결함: 복구 페이지 id 충돌

검사(742)와 stand-in INSERT(747-760) 사이에 `recovery_page()`가 행 하나를 만든다. 그 행의 id는 vault uuid에서 유도된다 — `Uuid::new_v5(vault_uuid, b"yonalist-recovery-page")`의 앞 9바이트를 yid로 인코딩 (`merger.rs:697-705`). **`parent`가 바로 그 id면** stand-in INSERT는 방금 만든 복구 페이지 행과 충돌해 0행을 삽입하고, 후속 두 문장은 그 행 위에서 돈다:

- UPDATE `SET hlc = '' WHERE id = ?1 AND text = ''`(`merger.rs:763-766`)는 **불발**한다 — 복구 페이지의 text는 `'복구됨'`이라 `AND text = ''`가 막는다. 요청서가 말한 "hlc가 비워진다" 절반은 이 경로에서도 일어나지 않는다.
- DELETE `FROM sync_dirty_nodes WHERE node_id = ?1`(`merger.rs:767-770`)은 **발화**한다 — `recovery_page`가 방금 찍은 마크(`merger.rs:717`)를 지운다.

이 시나리오는 실제로 도달한다:

1. 기기 A에서 고아가 된 페이지 루트를 `park`가 복구 페이지 밑으로 옮긴다 — `parent_id`가 복구 페이지 id가 된다 (`merger.rs:633-658`).
2. A의 exporter가 그 페이지 파일의 frontmatter에 `parent: <복구 페이지 id>`를 적는다 (`export.rs:1112-1113`, `render.rs:46`).
3. 기기 B가 그 파일을, 복구 페이지를 언급하는 다른 파일(home 등)보다 먼저 읽는다. 파일 도착 순서는 보장되지 않는다. B는 아직 복구 페이지 행이 없고, vault uuid는 공유라 같은 id를 유도한다 (`merger.rs:693-697` 주석이 명시하는 설계 목표).
4. `place_missing_parent(복구 id)`: 존재 검사 false → `recovery_page()`가 행을 만들고 마크를 찍음 → stand-in INSERT 충돌(0행) → DELETE가 마크를 지움.

지워진 마크를 되찍는 것은 아무것도 없다. 근거:

- 자식 페이지 루트의 INSERT는 스탬프를 갖고 들어가서(`merger.rs:1313-1319`) 삽입 트리거가 침묵한다 — 트리거는 `WHEN NEW.hlc = ''`에서만 돈다 (`notes-sqlite/src/schema.sql:153-165`). 부모 마크도 안 찍힌다.
- `order.flush` → `respace_sibling`(`merger.rs:996-1004`, `1477-1501`)은 sort_key가 같은 값으로 다시 쓰여 갱신 트리거 WHEN 절이 false이고, 설령 돌아도 `undirty_holder`가 "마크 없던 부모"로 잡아 `unmark_holder`가 도로 지운다 (`merger.rs:1515-1528`). 수정 후에는 반대로 `undirty_holder`가 "이미 기다리던 부모"라 None을 돌려주고 마크가 산다 — 양쪽 다 일관된다.
- `repair_structure`: 고아도 사이클도 없다. `document_is_missing_nodes`/`record_document`(`merger.rs:2073-2199`)는 `sync_dirty_nodes`를 건드리지 않는다.

피해: 이 vault의 복구 페이지가 자기 파일 내보내기를 잃는다. root 마크는 남아서 행 자체는 home으로 퍼지지만, 복구 페이지 자신의 파일 쓰기는 다른 무언가가 그 행을 다시 dirty로 만들 때까지 밀린다. 좁지만 실재하고, 큐가 조용히 일을 잃는 부류라 테스트 없이는 다시 새기 쉽다.

### 판정

요청서의 데이터 손실 경로는 없다. `inserted == 0`으로 후속 문장에 닿는 경로는 정확히 하나 — parent가 유도된 복구 페이지 id와 같고 그 행이 검사 시점엔 없다가 `recovery_page()`가 만드는 경우 — 있고, 거기서 DELETE가 남의 마크를 지운다. 요청서가 제안한 가드가 이 경로를 뿌리에서 막는다. **가드는 죽은 방어가 아니라 도달 가능한 결함의 수정이다** — ponytail 규범과 충돌하지 않는다.

## 3. Non-goals

- 단수형·복수형 통합 없음. stand-in의 의미가 다르다: 단수형은 복구 페이지 밑의 살아 있는 행, 복수형은 root 밑의 deleted 행. 억지 추상화다.
- `merger.rs:742`의 조기 존재 검사 제거 없음. 가드와 중복이 아니다 — 부모가 이미 있을 때 복구 페이지를 쓸데없이 만드는 것을 막는 건 이 검사뿐이다.
- `recovery_page()` 자체의 사소한 버릇(행이 이미 있어도 무조건 `mark_dirty`를 다시 찍어 재내보내기를 잡는 것) 수정 없음. 무해하고 별건이다.
- 스키마·마이그레이션·exporter 변경 없음.

## 4. Items (구현 순서, 항목당 1커밋)

### Item 1 — 충돌 가드 + red 테스트 (AC-1)

**테스트 먼저**: `crates/notes-sync/tests/merge_ingest.rs`에 `naming_the_recovery_page_as_a_parent_does_not_take_back_its_write` 추가. 기존 스캐폴딩만 쓴다.

- 1단계 (복구 페이지 id 얻기): 새 `database()` 연결에서, 어떤 행도 없는 id(`"Absent000001"`)를 `parent`로 적은 페이지 문서 하나를 병합한다 — `page(...)`에 `id`/`parent`/`sort_key`를 덮어쓰는 probe와 같은 방식. `place_missing_parent`가 복구 페이지를 만들고, 기존 헬퍼 `recovery_page(&transaction)`(`merge_ingest.rs:1628`)로 그 id를 읽는다. 연결을 버린다. `database()`의 vault_uuid가 고정 리터럴(`merge_ingest.rs:28`)이라 유도되는 id는 결정적이다 — 유도식이 바뀌어도 테스트가 따라간다.
- 2단계 (충돌 재현): 새 `database()`에서 `child_document` 꼴(`merge_ingest.rs:2705` 참조)의 페이지를 `parent = Some(<복구 id>)`로 만들어 `child_input()`으로 병합한다.
- 단정:
  1. `SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = <복구 id>` == 1 — **적재 단정. 현재 코드에서 0이라 red.**
  2. 복구 페이지 행이 존재하고 text가 `'복구됨'`, hlc가 비어 있지 않다 — UPDATE의 `AND text = ''`가 지켜온 불변식을 잠근다 (수정 전후 모두 green).
  3. 자식 페이지의 `parent_id`가 복구 id다 — 시나리오 배선 확인 (모두 green).

**구현**: `merger.rs` `place_missing_parent`에서 stand-in INSERT의 반환값을 받고, 0이면 UPDATE/DELETE 전에 돌아간다:

```rust
let inserted = transaction
    .prepare_cached(/* 기존 INSERT 그대로 */)
    .and_then(...)
    .map_err(|error| error.to_string())?;
// 복수형(place_missing_parents)과 같은 이유: 이 아래는 전부 방금 이
// INSERT가 만든 행을 위한 것이다. 이미 있던 행 — 특히 위의
// recovery_page()가 방금 만든 복구 페이지 자신 — 의 마크를 지우면
// 그 행이 빚진 내보내기가 조용히 사라진다.
if inserted == 0 {
    return Ok(());
}
```

주석은 복수형의 것(`merger.rs:797-800`)과 톤을 맞추되 단수형의 실제 도달 경로(복구 페이지 충돌)를 적는다.

### Item 2 — 요청서가 요구한 회귀 테스트 (AC-2) + probe 정리

`merge_ingest.rs`의 trash 자매 테스트(`the_trash_does_not_stand_in_for_a_parent_that_is_already_here`, `merge_ingest.rs:1773`) 바로 옆에 페이지 문서판 `a_child_document_does_not_stand_in_for_a_parent_that_is_already_here`를 추가한다. 시드와 단정은 자매 테스트와 동형:

- 시드: 빈 텍스트 노드(`node(parent, &seeded, "")`)를 담은 페이지를 병합하고, hlc를 `before`로 읽고, `sync_dirty_nodes`를 비운 뒤 그 노드에 마크 하나를 직접 넣는다.
- 실행: `id`/`parent = Some(parent)`/`sort_key`를 덮어쓴 자식 페이지 문서를 병합한다 (probe의 2번째 병합과 동일).
- 단정: hlc == `before`; `COUNT(*) FROM sync_dirty_nodes WHERE node_id = parent` == 1.

같은 커밋에서 `crates/notes-sync/tests/zz_probe.rs`를 삭제한다 — 스스로 "throwaway probe"라 적힌 untracked 파일이고, 이 테스트가 같은 내용을 제 이름으로 대체한다.

## 5. Gates

- 편집 루프: `cargo test -p notes-sync --test merge_ingest` (필요하면 테스트 이름으로 좁혀서)
- 최종: `cargo test -p notes-sync` + 손댄 파일 `cargo fmt` 확인
- Clippy 기준선 비교·frontend 게이트·`test:architecture` 해당 없음 (커맨드 표면·IPC·frontend 무변경)

## 6. Red evidence 명시

- **AC-1 테스트는 현재 main에서 진짜로 red다.** 실패 원인은 실제 결함 — `merger.rs:767-770`의 무조건 DELETE가 `recovery_page`(`merger.rs:717`)가 찍은 마크를 지우는 것 — 이고, 약화 사본이 아니다. 2b의 정적 추적(트리거 WHEN 절, `write_row`의 스탬프 동반 INSERT, `undirty_holder` 부기)이 병합 후반부의 어떤 경로도 마크를 되찍지 않음을 보인다. Opus는 스킬대로 red 출력을 원문 그대로 기록한 뒤 가드를 넣고 green을 확인한다. red가 나오지 않으면 이 설계 문서로 되돌아온다.
- **AC-2 테스트는 현재 main에서 red가 될 수 없고, red를 주장하지 않는다.** `merger.rs:742`의 조기 반환이 기존 행 경로를 이미 막고 있음을 probe 실행으로 확인했다 (`cargo test --test zz_probe` → ok). 이 테스트의 역할은 그 조기 반환을 계약으로 잠그는 것이다 — 누가 단수형을 복수형 모양에 맞춘다며 검사를 걷어내면 이 테스트가 잡는다. 함수를 일부러 약화시킨 사본에 대한 red는 증거로 치지 않으므로 시도하지 않는다.
