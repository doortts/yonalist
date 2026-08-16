# 해석된 첨부가 자기 노드를 이름으로 말한다 — 설계

2026-08-17 · 설계 단계(Fable 5 대신 Opus 5가 수행) · 대상 브랜치
`fix/resolve-asset-changed-ids`, `fix/image-relative-path-normalization`의
cf6956b4 기반

`fix/image-relative-path-normalization`의 적대적 리뷰에서 비차단으로 받아들인
후속 건이다. 지금 `apps/desktop/src-tauri/src/vault_watch.rs:184`는 첨부가
도착해 행이 해석되면 창을 깨우기는 한다. 다만 깨우는 통보에 이름이 없다.

```rust
let resolved = take_asset(storage, assets, vault_root, &relative);
if resolved > 0 {
    changed(MergeOutcome { applied: resolved, ..MergeOutcome::default() })
}
```

`resolve_asset`이 수만 답하니 `changed_ids`가 빈 채로 나가고,
`apps/desktop/src/notesStore.ts:189`의 `patchFromVault`는 `named === 0`을
"이름을 붙이기엔 너무 넓은 변경"으로 읽어 `viewport.reload() + refreshPages()`로
간다. 틀린 답은 아니지만 비싸고, 같은 함수의 주석이 말하듯 그 길은 캐럿과
스크롤이 제자리에 남는다고 약속하지 못한다. 사용자가 타이핑하는 동안 그림 하나가
내려받기를 마치면 화면이 튈 수 있다.

## 조사에서 확인한 것

설계 질문 다섯 개를 코드 근거로 답한다. 요청의 전제 중 틀린 것도 여기에 적는다.

### 1. `prepare_cached` + `RETURNING`

`crates/` 아래에 `RETURNING`을 쓰는 곳은 아직 없다. 이게 첫 사용이다. 쓸 수는
있다 — 워크스페이스가 고정한 rusqlite 0.40.1이 libsqlite3-sys 0.38.1을 bundled로
끌고 오므로 SQLite는 `RETURNING`이 들어온 3.35보다 한참 위다.

주의할 점이 둘이다.

- `execute`는 행이 하나라도 나오면 `Error::ExecuteReturnedResults`로 끝난다
  (rusqlite 0.40.1 `src/statement.rs:682`). 지금 코드의
  `.and_then(|mut statement| statement.execute(...))`를 그대로 두고 SQL에만
  `RETURNING`을 붙이면 첨부는 런타임에서 영영 해석되지 않는다. `query_map`으로
  바꾸고 행을 전부 읽어야 한다.
- `prepare_cached`가 주는 `CachedStatement`는 Drop을 가진다. 지역 변수로 받으면
  트랜잭션 빌림이 스코프 끝까지 살아남아 `transaction.commit()`이 값을 옮기지
  못한다.

두 조건을 다 만족하는 모양이 이 저장소에 이미 있다 —
`crates/notes-sqlite/src/worker.rs:548`의 `VaultStatRecords`다.

```rust
connection
    .prepare_cached("SELECT …")
    .and_then(|mut statement| {
        let rows = statement.query_map([], |row| …)?;
        rows.collect::<Result<Vec<_>, _>>()
    })
    .map_err(…)
```

statement가 클로저 안에서만 살다 죽으니 커밋 전에 빌림이 끝난다. 항목 1은 이
모양을 그대로 가져다 쓴다. 대안(UPDATE 앞에 같은 WHERE의 SELECT를 한 번 더)은
같은 트랜잭션 안이라 정확성은 같지만 문장이 하나 늘고 WHERE가 두 곳에 복제된다.
선택하지 않는다.

### 2. `MergeOutcome::applied`

남긴다. 값은 `ids.len()`으로 채운다. `applied`를 읽는 곳 전부:

| 읽는 곳 | 하는 일 | 첨부 갈래에서 |
| --- | --- | --- |
| `apps/desktop/src-tauri/src/lib.rs:632` | `applied == 0`이면 창에 알리지 않고 돌아간다 | `ids.len()`이 오늘의 수와 같아 판정이 바뀌지 않는다 |
| `apps/desktop/src-tauri/src/vault_watch.rs:213` | md 병합의 통보 여부 | 첨부 갈래는 지나지 않는다 |
| `crates/notes-sqlite/src/sync_merge.rs:34` | 0이면 path 재구축과 revision을 건너뛴다 | md 병합 전용. 첨부는 `resolve_asset`이 스스로 revision을 올린다 |
| `crates/notes-sqlite/src/sync_merge.rs:383` | reindex의 집계 | 위와 같다 |

md 병합에서 `applied`는 쓴 행 수라 `changed_ids.len()`과 원래 다르다
(`merger.rs:539`의 삭제 갈래도 센다). 그래서 필드를 `ids.len()`으로 대체하거나
없애는 건 이 변경의 몫이 아니다. 첨부 갈래에서만 둘이 같아질 뿐이다.

### 3. 프런트엔드 — 변경 없다

`lib.rs:650`이 `changed_node_ids`를 담아 보내는 `SyncChanged`는
`packages/contracts/generated/SyncChanged`로 이미 생성되어 있고,
`apps/desktop/src/syncChanged.ts:24`가 `changedNodeIds`로 받아 모은다. 중간에
필드를 떨구는 층은 없다. `changed_ids`를 채우는 순간 `patchFromVault`는 그대로
싼 길로 간다.

그 길은 이미 잠겨 있다 — `apps/desktop/src/notesStore.test.ts`의
"다른 기기의 변경 흡수 — 이름이 온 경우"가 이름이 온 경우의 부분 갱신,
넓은 변경의 재읽기, 잘린 답의 재읽기를 모두 단언한다. 요청이 물은 "프런트엔드에
변경이 필요한가"의 답은 **아니오**다.

### 4. 이미지 노드는 forest 루트로 유효하다

`crates/notes-sqlite/src/forest_queries.rs:30`의 재귀 CTE가 시작 행을
`WHERE id = ?1 AND kind IN ('bullet', 'image') AND deleted = 0`으로 고른다.
이미지 노드는 이름이 그 목록에 있고, 잎이라 자기 한 행만 돌아온다. 행이 비지
않으니 `complete`도 참이다. 돌아오는 `NoteView`는 `notes_node_records` 뷰로
`notes_images`를 JOIN하므로 방금 채워진 해시를 달고 나온다.

창 쪽도 맞는다. `apps/desktop/src/store/storeState.ts:63`의 `receiptState`는
id로 기존 노드를 갈아끼우고, 지금 열린 페이지에 속하지 않는 노드는 조용히
버린다(:69-85의 부착 루프가 한 바퀴에 아무것도 붙이지 못하고 끝난다) — 다른
페이지를 보고 있으면 아무 일도 일어나지 않는 게 옳은 동작이다. 그림은
`apps/desktop/src/image/ImageNodeContent.tsx:123`이 `node.image?.contentHash`를
의존성으로 잡고 있어 해시가 바뀌면 다시 그려진다.

이 사실에는 작업 항목을 만들지 않는다. 새 테스트를 적어도 처음부터 초록이라
`fable-opus-loop`의 "빨강을 본 적 없는 테스트는 받아들이지 않는다"에 걸린다.
근거는 위 두 문단으로 남긴다. 나중에 저 SQL에서 `'image'`가 빠지면 창은 전체
재읽기로 되돌아갈 뿐 깨지지는 않는다 — 안전한 저하다.

### 5. 런타임 경계

IPC 페이로드의 모양도, 스키마도, 프런트엔드 코드도 바뀌지 않는다. 그래도
"캐럿과 스크롤이 제자리에 남는다"는 이 변경이 사는 유일한 이유이고 그건 실행
중인 앱에서만 보인다. 수동 확인 한 개를 계약에 넣는다.

### 전제 정정

- **`crates/notes-sqlite/tests/two_devices.rs:106`은 고칠 게 없다.** 반환값을
  버리는 구문이라 반환형이 `BTreeSet<String>`이 되어도 그대로 컴파일된다.
  워크스페이스 `Cargo.toml`에 `[lints]` 절이 없어 `unused_results`는 꺼져 있고,
  `BTreeSet`은 `must_use`가 아니다. 요청의 "둘 다 고쳐야 한다"는 절반만 맞다.
- **`sync_merge_seam.rs`의 호출은 여섯 곳이다**(711·737·767·816·1233·1258).
  그중 반환값을 단언하는 곳이 네 곳(718·745·1240·1265)이고, 나머지 둘은 버리는
  구문이라 손대지 않는다.
- **부수 효과 하나를 기록해 둔다.** `changed_ids`가 차면
  `lib.rs:645`의 `service.absorb_external(revision, &affected)`가 그 노드를 만지는
  undo 항목을 잘라낸다(`crates/notes-application/src/service.rs:436`). 지금은
  이름이 없어 아무것도 잘리지 않는다. 방향은 맞다 — 그 그림의 행이 밑에서
  바뀌었으니 그걸 되돌리는 undo는 더 이상 안전하지 않고, md 병합이 이미 같은
  규칙으로 산다. 실제로 잘릴 항목은 드물다(그 이미지 노드를 이 창이 직접 편집한
  경우뿐이고, 그런 행을 만든 병합이 이미 한 번 잘랐다).

## 계약

| 필드 | 내용 |
| --- | --- |
| 목표 | 첨부 바이트가 도착해 자리표시가 그림이 될 때, 열린 창이 페이지를 다시 읽지 않고 그 노드만 갈아끼운다 — 캐럿과 스크롤이 제자리에 남는다 |
| 비대상 | 아래 절 |
| 경계 | Rust(`notes-sqlite`: `sync_merge.rs`·`worker.rs` / `src-tauri`: `vault_watch.rs`) · SQLite(스키마 불변, UPDATE에 `RETURNING node_id` 절만 추가) · IPC 무변경(`SyncChanged`의 필드도 생성 계약도 그대로) · React 무변경 |
| 수동 확인 | 아래 절 |

### 완료 조건(acceptance)

| # | 관찰 가능한 통과 조건 | 항목 |
| --- | --- | --- |
| A1 | 첨부 도착이 부르는 변경 통보가 해석된 이미지 노드의 id를 담고 `applied`가 그 개수와 같다 | 1 |
| A2 | 아무 행도 해석하지 못한 첨부는 이름을 하나도 만들지 않는다 — 창은 오늘처럼 깨어나지 않는다 | 1 |

### 비대상

- md 병합 갈래의 `changed_ids` — 이미 병합이 채우고 있고 손대지 않는다.
- `MergeOutcome::applied`의 의미 변경이나 제거 — 위 조사 2번.
- 이미지 노드가 forest 루트로 유효하다는 사실의 새 테스트 — 위 조사 4번.
- 대기 중 자리표시 UI, 첨부 진행 표시 — 이 변경과 무관하다.
- 스키마 변경·마이그레이션 — 없다.

### 수동 확인

한 번, 새로 빌드한 앱에서. `YONALIST_V2_DATA_DIR`로 데이터 디렉터리를 갈라
한 대의 기계에서 두 기기를 흉내 낸다(`lib.rs:739`).

1. 데이터 디렉터리 A로 앱을 띄우고 vault V를 지정한 뒤, 그림 한 장이 든 페이지를
   만든다. V에 `…/README.md`와 `…/assets/shot-<해시12>.png`가 생긴다.
2. 앱을 끄고 그 png를 V 밖으로 옮긴다.
3. 데이터 디렉터리 B(빈 DB)로 같은 vault V를 지정해 띄운다. 페이지가 열리고 그
   줄은 자리표시다.
4. 그 페이지에서 아무 줄에나 캐럿을 두고 타이핑하는 중에 png를 원래 자리로
   되돌린다.
5. 자리표시가 그림이 되고 캐럿과 스크롤이 그대로다. 변경 전에는 같은 자리에서
   페이지 전체가 다시 읽힌다.

## 작업 항목 (항목당 커밋 1개)

항목은 하나다. 네 층이 한 서명을 공유하므로 나누면 중간 커밋에서 트리가
컴파일되지 않는다.

**1. `resolve_asset`이 수 대신 이름을 답한다** (A1·A2)

- `crates/notes-sqlite/src/sync_merge.rs:241` — 반환형을
  `Result<BTreeSet<String>, StorageError>`로. 이름이 해시와 맞지 않는 이른
  반환 두 곳(:248·:252)은 빈 집합. UPDATE 끝에 `RETURNING node_id`를 붙이고
  조사 1번의 `and_then` + `query_map` + `collect` 모양으로 행을 전부 읽는다.
  revision 조건은 `if !resolved.is_empty()`. 함수 위 주석에 무엇을 답하는지 한
  줄 — 한 그림을 두 노드가 나눠 쓰면 이름도 둘이라 집합이다.
- `crates/notes-sqlite/src/worker.rs:77`·`:309` — `reply` 채널과 공개 래퍼의
  반환형만 따라간다. `:617`의 처리부는 그대로다. `BTreeSet`은 이 파일이 이미
  가져다 쓰고 있다(`:1`).
- `apps/desktop/src-tauri/src/vault_watch.rs:286` — `take_asset`이
  `BTreeSet<String>`을 답한다. 실패 갈래는 빈 집합, 주석의 "몇 개"는 "어느
  것"으로. `:184`의 호출부는 비어 있지 않을 때
  `MergeOutcome { applied: resolved.len(), changed_ids: resolved, ..default() }`.
  `use std::collections::BTreeSet;` 한 줄이 는다.
- `crates/notes-sqlite/tests/sync_merge_seam.rs`의 단언 네 곳
  (718·745·1240·1265)이 집합 단언으로 바뀐다. `two_devices.rs`는 그대로다.

실패 테스트 — 대표 증거는 첫 번째다. 서명이 바뀌는 변경이라 sqlite 층에서는
컴파일 오류 말고 다른 빨강이 나올 수 없고, 진짜 단언 실패는 창에 닿는 층에서만
나온다.

`apps/desktop/src-tauri/src/vault_watch.rs`의
`an_arriving_picture_wakes_the_window`(:571) — 이미 있는 테스트를 고친다. 채널이
`()` 대신 `MergeOutcome`을 나르게 하고, 도착한 통보의 `changed_ids`가 대기 중이던
이미지 노드(`8a201f33-0000-4c91-8d02-00000000000f`, `waiting_picture()`가 심는
그 id) 하나를 담고 `applied == 1`임을 단언한다. red: `left: {}`,
`right: {"8a201f33-0000-4c91-8d02-00000000000f"}` — 창은 깨어나지만 무엇이
바뀌었는지는 말하지 못한다. 나머지 준비(1x1 PNG, 부팅 스캔을 흘려보내는 대기)는
그 테스트가 이미 갖고 있다.

`crates/notes-sqlite/tests/sync_merge_seam.rs`의
`an_arriving_attachment_resolves_the_rows_waiting_for_it`(:699) — `resolved == 1`
자리에 `resolved`가 `IMAGE_NODE_ID` 하나를 담은 집합임을 단언한다. 그 테스트의
주석("바이트를 기다리던 행은 링크가 그 파일을 가리키는 행이다")이 말하던 것을
비로소 단언하는 셈이다. red: `expected usize, found BTreeSet<String>`.

A2는 같은 커밋의 `bytes_that_do_not_match_the_name_resolve_nothing`(:730)과
`an_attachment_no_row_wanted_leaves_the_revision_alone`(:1250)이 맡는다. 둘 다
`resolved == 0`을 `resolved.is_empty()`로 바꾼다. red는 위와 같은 타입 불일치다.

## 게이트 (diff 확정 후 1회)

Rust 경계만 바뀐다. `cargo test --workspace`(`src-tauri`도 워크스페이스 멤버라
`vault_watch`의 테스트가 여기 포함된다), Rust 포매팅, `git diff --check`.
프런트엔드는 코드도 계약도 바뀌지 않으므로 `npm test`류는 명시적으로 건너뛴다.

편집 중에는 좁게: `cargo test -p yonalist-v2-desktop --lib vault_watch`와
`cargo test -p notes-sqlite --test sync_merge_seam`.

## 위험

1. `execute`를 남겨 둔 채 `RETURNING`만 붙이면 컴파일은 되고 런타임에서
   `ExecuteReturnedResults`로 죽는다 — 첨부가 영영 해석되지 않는 조용한 고장이다.
   `query_map`으로 바꾸고 행을 전부 소진해야 한다(조사 1번).
2. `CachedStatement`를 지역 변수로 받으면 `transaction.commit()`이 컴파일되지
   않는다. `worker.rs:548`의 모양을 그대로 쓴다.
3. undo floor가 그 노드를 만지는 항목을 자르기 시작한다 — 의도된 방향이고 md
   병합과 같은 규칙이다(전제 정정 3번).
4. 창이 잎 노드 하나만 받는다. forest가 그 잎을 못 찾으면(그 사이 삭제 등)
   `complete = false`로 돌아와 오늘의 전체 재읽기로 폴백한다 — 안전한 저하다.
