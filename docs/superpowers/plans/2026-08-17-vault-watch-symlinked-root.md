# 심볼릭 링크로 지정한 vault를 watcher가 못 알아본다 — 설계

2026-08-17 · Fable 5 부재로 Opus 5가 설계 자리를 대신함 · 브랜치
`claude/kind-gould-d08758` (`fix/image-relative-path-normalization` 머지 직후)

`fix/image-relative-path-normalization` 적대적 리뷰에서 셋이 나왔다. 1번은 이미
들어와 있던 버그이고 2·3번은 다음 편집자를 막는 난간이다.

## 문제 — 1번

`notify`는 이벤트 경로를 커널이 아는 실제 경로로 준다. `watched_path`
(`apps/desktop/src-tauri/src/vault_watch.rs:344`)는 그 경로를 vault 상대 경로로
바꾸는데 `path.strip_prefix(vault_root).ok()?` 한 줄이 전부다. `vault_root`가
심볼릭 링크를 거쳐 들어온 경로면 — macOS의 `/tmp`·`/var`, 사용자가 직접 건 링크 —
`strip_prefix`가 매번 실패하고 `None`이 나온다. watcher는 이벤트를 전부 조용히
버리고 60초 sweep 하나로 주저앉는다. 어디에도 오류가 남지 않는다.

증거는 같은 파일 안에 있다. `an_arriving_picture_wakes_the_window`(:571)가
`std::fs::canonicalize`를 부르고 그 이유를 주석으로 달아 놨다. 그 한 줄이 없으면
테스트에 이벤트가 하나도 안 온다.

이 비대칭은 코드베이스에서 여기 하나뿐이다. 다른 경로는 전부 `vault_root`에 상대
경로를 join하거나(`documents_on_disk`·`take`·`take_asset`), 양쪽을 다 정규화해서
비교한다(`notes_sync::file_io::resolve_inside` — 도리어 "vault 자체가 링크 뒤에
있는 게 흔하다"고 주석에 적혀 있다). 남의 손에서 온 경로를 맨 `strip_prefix`로
재는 곳이 `watched_path` 하나라서 고칠 자리도 하나다.

## 계약

| 필드 | 내용 |
| --- | --- |
| 목표 | 심볼릭 링크를 거쳐 지정한 vault에서도 파일 도착이 sweep을 기다리지 않고 창에 닿는다 |
| 비대상 | 아래 별도 절 |
| 경계 | Rust(`apps/desktop/src-tauri`: `vault_watch.rs`) · SQLite(`crates/notes-sqlite/src/schema.sql` 주석만, SQL 의미 불변) · 파일시스템(watch 루트 정규화) · IPC 없음 · React 없음 · 설정 파일 형식 불변 |
| 수동 확인 | 홈에 실제 vault 폴더를 하나 만들고 `ln -s`로 링크를 건 뒤, 앱에서 **링크 경로**를 vault로 지정한다. 다른 편집기로 그 폴더의 페이지를 고치면 1초 안에 창이 따라 바뀐다(고치기 전에는 최대 60초를 기다리거나 아예 안 바뀐다) |

### 완료 조건(acceptance)

| # | 관찰 가능한 통과 조건 | 항목 |
| --- | --- | --- |
| A1 | 심볼릭 링크로 지정한 vault에 첨부 파일이 도착하면 sweep이 오기 전에 changed 콜백이 온다 | 1 |
| A2 | 설정 파일에 저장된 vault 문자열은 사용자가 고른 그대로다 — Settings가 고른 경로를 되돌려주고 `sync_settings.rs`의 왕복 테스트 셋이 손대지 않은 채 통과한다 | 1 |
| A3 | `SWEEP`을 quiet 창(500 ms) 이하로 바꾸면 빌드가 그 자리에서 깨진다 | 2 |
| A4 | 스키마의 mime `CHECK` 옆에 같은 매핑을 든 네 곳이 적혀 있어, 다섯 번째 mime을 `CHECK`에만 넣고 지나칠 수 없다 | 3 |

### 비대상

- `sync_settings`가 저장하는 경로를 정규화하기 — 결정 1에서 기각한다.
- 네 벌의 mime→확장자 매핑을 하나로 합치기 — SQL이 Rust 함수를 못 부른다. 주석
  하나로 끝낸다.
- `start_with`가 받는 `sweep` 인자에 런타임 검사 넣기 — 결정 3에서 기각한다.
- watcher가 이벤트를 못 알아봤을 때 화면에 알리기 — 정규화하면 못 알아볼 일이
  없어진다. 없는 상태를 위한 UI다.
- 스키마 버전·마이그레이션 — 없다. `user_version`도 1 그대로다.
- 링크가 앱이 도는 중에 다른 폴더로 다시 걸리는 경우 — watch는 시작할 때 푼 실제
  폴더를 계속 본다. `notify`도 그렇게 동작하고 폴더를 바꾸는 길은
  `notes_sync_vault_set`뿐이며 거기서 watch를 다시 시작한다.

## 설계

### 결정 1 — 정규화는 watcher 안에서만 한다

`VaultWatch::start_with`가 `vault_root`를 저장하고 watch 걸기 전에 한 번
정규화한다. `sync_settings::set_vault_path`가 저장하는 문자열은 건드리지 않는다.

`sync_settings`도 `validate`/`resolve_or_create` 안에서 `fs::canonicalize`를 쓰지만
그건 "앱 저장소와 겹치지 않는가"를 판정하려고 쓰는 임시 값이다. 파일에 쓰는 건
사용자가 고른 원본 그대로다(`path_bytes(vault)`). 여기를 정규화형으로 바꾸면
이렇게 된다.

- Settings 화면이 사용자가 고르지 않은 경로를 보여준다. `notes_sync_vault_get`
  (`lib.rs:351`)이 저장된 문자열을 그대로 화면에 올린다. `~/Notes`를 골랐는데
  `/private/var/…`가 뜨는 건 고친 게 아니라 새로 만든 문제다.
- 기존 테스트 셋이 깨진다. `vault_path_round_trips_through_the_settings_file`,
  `a_folder_name_keeps_its_trailing_space`,
  `a_folder_that_does_not_exist_yet_is_created_and_empty` 셋 다
  `read_vault_path == 고른 경로`를 단언한다. tempdir가 macOS에서 `/var/folders/…`라
  셋 다 즉시 red가 된다.
- 얻는 게 없다. 결함은 비교 한 곳에만 있다.

반대로 watcher 안 정규화는 비교가 실제로 일어나는 자리를 고친다. `start_with`에
두는 이유는 둘이다. `start`가 `start_with`에 위임하므로 한 줄이 두 진입점을 다
덮고 `watcher.watch(&vault_root, …)` 자체도 실제 경로를 받는다. 이벤트마다
`watched_path` 안에서 정규화하는 방법도 있지만 그건 이벤트당 syscall이고 루트는
watch가 사는 동안 안 바뀐다.

```rust
// notify는 폴더의 실제 경로로 알려준다. 링크를 거쳐 들어온 루트 — macOS의
// /tmp·/var, 사용자가 직접 건 링크 — 로는 이벤트 경로에서 루트를 떼어낼 수
// 없어, 폴더에 일어난 일이 전부 조용히 사라진다.
let vault_root = std::fs::canonicalize(&vault_root)
    .map_err(|error| format!("Could not watch the vault: {error}"))?;
```

(주석 문구는 구현자가 다듬어도 된다. 설명해야 하는 건 "왜 여기서 푸는가"다.)

### `read_vault_path`를 읽는 곳 전수 — 저장형과 watcher형을 맞대는 곳은 없다

grep 결과(`apps/desktop/src-tauri/src/lib.rs`)와 각각이 경로로 하는 일:

| 자리 | 하는 일 | 정규화형이 섞이면 |
| --- | --- | --- |
| `:329` `delete_attachment(&hash, vault.as_deref())` | `sync_assets.location`(vault 상대)을 vault에 join한다. `attachment_list.rs:196`이 `inside_vault(vault_root, vault_root.join(location))`으로 양쪽을 다 정규화해서 비교한다 | 무해 |
| `:351` `notes_sync_vault_get` | 저장된 문자열을 그대로 화면에 올린다 | 사용자가 고른 경로가 화면에서 바뀐다(결정 1이 기각한 이유) |
| `:569` `export_pending(&vault, &store_root)` | vault에 상대 경로를 join해서 쓴다 | 무해 |
| `:613` `watch_vault` | `VaultWatch::start`에 넘긴다 | 여기가 고치는 자리 |

DB에 절대 경로를 앉히는 컬럼은 없다. 확인한 둘:

- `sync_assets.location` — vault 상대다. `delete_attachment`가
  `vault_root.join(&location)`으로 쓰고(`attachment_list.rs:196`), `worker.rs:582`의
  `AssetKnown`은 `vault_watch::take_asset`이 만든 상대 문자열과 맞춘다.
- `notes_images.relative_path` — `{hash}.{ext}` 아니면 vault 파일이 쓴 링크다. 둘 다
  상대다(`schema.sql:74` 주석).

그리고 정규화 전후로 **상대 문자열 자체가 안 바뀐다**. sweep 쪽은 `vault_root`에서
파생한 경로를 다시 `vault_root`로 떼어내므로(`documents_on_disk` → `watched_path`)
루트가 어느 형태든 같은 상대 문자열이 나온다. 이벤트 쪽은 고치고 나면 정규화된
루트로 정규화된 경로를 떼어내니 역시 같다. 이미 쌓인 행과 새로 쌓일 행이 같은
모양이고 데이터 리셋도 필요 없다.

### 결정 2 — canonicalize가 실패하면 watch 시작이 실패한다

폴더가 사라졌으면 `canonicalize`가 `NotFound`로 떨어진다. 바로 뒤의
`watcher.watch()`가 어차피 같은 상황에서 실패하므로 같은 문구
(`"Could not watch the vault: {error}"`)로 같은 `Err`를 돌려주면 호출자가 보는
결과가 달라지지 않는다. `watch_vault`(`lib.rs:656`)는 `Err`를 치명적으로 다루지
않는다. `eprintln!`으로 남기고 앱은 계속 돈다. export도 계속 된다. 실패 처리를
새로 만들 필요가 없다는 뜻이고 만들지 않는다.

### 결정 3 — `SWEEP` 불변은 const 단언 하나

`sweep_into`(`vault_watch.rs:239`)는 sweep마다 첨부 전부를 조건 없이
`queue.saw(relative, now)`로 다시 신고한다. `WatchQueue::saw`
(`crates/notes-sync/src/watch_queue.rs:42`)는 마지막으로 본 시각을 갱신하고
`next_in_flight`(:63)는 quiet 창만큼 조용했던 것만 꺼낸다. sweep 간격이 quiet 창보다
짧으면 첨부는 조용해질 틈을 영영 못 얻는다. 지금은 60초 대 500 ms라 안전하다. 다음
편집자만 밟는 함정이라는 뜻이다.

런타임 `assert!`/`debug_assert!`를 `start_with`에 넣을 수는 없다.
`a_change_that_kept_mtime_and_size_is_caught_by_the_verification_pass`(:466)가
`Duration::from_millis(200)`을 넘긴다. 그 테스트가 통과하는 건 `sweeps == 2` 검증
패스를 타기 때문이다. 검증 패스에는 quiet 창이 없다(`WatchQueue::verify` :52).
정당한 사용이라 막으면 안 된다.

그래서 상수 자신에게만 건다. 두 상수 바로 아래 한 줄이다.

```rust
const _: () = assert!(SWEEP.as_millis() > QUIET_MILLIS as u128);
```

`Duration::as_millis`가 이 툴체인에서 const로 불린다. 직접 확인했다. rustc
1.97.0, edition 2024로 위 단언만 담은 파일이 컴파일된다. `as_secs`로 후퇴할 필요가
없다.

주석은 `SWEEP` 문서 주석에 이어 붙이거나 단언 위에 둔다. 담을 내용 둘: sweep이
quiet 창보다 짧으면 첨부가 큐에서 영영 안 나온다는 것, 그리고 검사가 인자가 아니라
상수에 걸린 이유(테스트가 검증 패스에 닿으려고 짧은 sweep을 부탁할 수 있고 검증
패스에는 quiet 창이 없다).

문서 주석만 다는 안은 기각한다. 요청은 다음 편집이 시끄럽게 깨지게 하는 것이다.
주석은 안 깨진다.

### 결정 4 — mime 교차 참조는 `sync_merge.rs`가 아니라 스키마 `CHECK` 옆에 둔다

**요청 문구와 다른 결정이라 이유를 적는다.** 요청은
`crates/notes-sqlite/src/sync_merge.rs`의 인라인 `CASE`(:262) 옆에 나머지 셋을
가리키는 주석을 달라고 했다. 막으려는 사고는 "다섯 번째 mime이 `CHECK`에만
추가되는 것"이다. 그 편집을 하는 사람은 `crates/notes-sqlite/src/schema.sql`을 열지
`sync_merge.rs`를 열지 않는다. `sync_merge.rs`에만 붙인 주석은 이미 그 매핑을 보고
있는 사람만 읽는다.

그래서 주석 한 개를 `schema.sql:76`의 `mime_type … CHECK` 바로 위에 두고 네 곳을
전부 이름으로 적는다(`sync_merge.rs`의 `CASE`도 포함). 같은 한 줄짜리 비용으로
편집이 시작되는 자리를 덮는다. 파일 안의 다른 컬럼 주석이 이미 `--` 스타일이라
모양도 그대로 맞는다.

가리킬 네 곳:

- `crates/notes-core/src/image.rs` `extension_for_mime` (:157)
- `crates/notes-sync/src/layout.rs` `extension` (:62)
- `crates/notes-sqlite/src/image_assets.rs` `format_details` (:320)
- `crates/notes-sqlite/src/sync_merge.rs` `resolve_asset`의 `CASE mime_type` (:262)

주석이 담아야 할 위험은 "네 벌이 있다"가 아니라 **넷 중 둘이 모르는 mime을 조용히
png로 부른다**는 것이다. 아래 표가 근거다.

`sync_merge.rs`의 `CASE` 옆에는 아무것도 달지 않는다. 그 자리만 따로 고치는
편집자를 잡고 싶어지면 한 줄 후속으로 넣으면 된다. 지금 넣을 근거가 없다.

### 네 벌이 실제로 일치하는가 — 일치한다, 단 모르는 mime에서 갈린다

| 자리 | png | jpeg | gif | webp | 목록 밖 |
| --- | --- | --- | --- | --- | --- |
| `notes-core` `extension_for_mime` | png | jpg | gif | webp | `None` |
| `notes-sync` `extension` | png(fallback) | jpg | gif | webp | **`"png"`** |
| `notes-sqlite` `format_details` | png | jpg | gif | webp | `None` |
| `notes-sqlite` `CASE mime_type` | png(`ELSE`) | jpg | gif | webp | **`'png'`** |

`schema.sql:76`의 `CHECK`가 `image/png`·`image/jpeg`·`image/gif`·`image/webp` 넷으로
못 박고 있으니 오늘 들어올 수 있는 모든 값에서 네 벌이 같은 답을 낸다. 결함으로
올릴 불일치는 없다.

갈리는 건 다섯 번째가 생기는 순간이다. 앞의 둘은 `None`으로 떨어져 호출자가
거절하고 뒤의 둘은 아무 소리 없이 `png`라고 부른다. vault에 앉는 파일 이름
(`layout.rs`)과 `notes_images.relative_path`(`sync_merge.rs`)가 둘 다 틀린 확장자를
달고 오류는 한 줄도 안 난다. 주석에 적을 문장은 이거다.

**전수 중에 다섯 번째 자리를 찾았다.** `crates/notes-export/src/markdown.rs:207`이
같은 넷을 확장자로 옮긴다. 교차 참조 목록에서는 뺀다. 목록 밖 mime을
`ExportError::Failed`로 거절하므로, 잊고 지나가면 조용히 틀리는 게 아니라 export가
시끄럽게 실패한다. 주석은 조용히 틀리는 자리를 막으려고 있고 저기는 조용하지 않다.
(참고로 저장소 루트의 `src-tauri/`는 워크스페이스에서 `exclude`된 옛 트리라 전수에서
뺐다.)

## 위험 — 고른 모양의 함정을 그대로 적는다

1. **항목 1 테스트의 sleep 1.5초가 시간에 기댄다.** 부팅 스캔이 끝난 걸 sleep으로
   판정하고 큐를 비운 뒤 그림을 쓴다. 스캔이 1.5초보다 늦어지면 늦게 온 부팅
   콜백이 가짜 green을 만든다. 이 모양은 바로 옆
   `an_arriving_picture_wakes_the_window`가 이미 쓰는 것과 같고, 이웃을 그대로
   따르는 게 이 저장소의 규칙이라 그대로 간다. 흔들리면 그때
   `storage.asset_known("assets/…")`을 단언하는 쪽으로 바꾼다. 지금 만들지 않는다.
2. **`#[cfg(unix)]` 테스트다.** `std::os::unix::fs::symlink`를 쓴다. 같은 크레이트의
   `image_file_actions.rs:204`가 이미 `#[cfg(windows)]`/`#[cfg(unix)]`로 갈라 놓은
   전례가 있으니 헬퍼를 새로 만들지 말고 테스트 함수에 `#[cfg(unix)]`만 붙인다.
   Windows에서는 이 회귀 테스트가 안 돈다. 앱은 macOS로 나간다.
3. **항목 2·3은 실행 가능한 테스트가 없다.** 항목 2는 컴파일이 곧 검사고 항목 3은
   주석이라 아무것도 실행하지 않는다. 아래 항목 목록에 red를 만드는 정확한 절차를
   적어 두었고 없는 테스트를 지어내지 않는다.

## 작업 항목 (순서 고정, 항목당 커밋 1개)

항목 1·2가 `vault_watch.rs`를 공유하므로 한 에이전트가 순서대로 진행한다. 항목마다
빨간 테스트(또는 빨간 빌드)를 먼저 만들고 출력을 그대로 기록한 뒤 구현한다.

**1. watch 루트를 정규화한다 — 링크 뒤의 vault도 이벤트를 듣는다** (A1·A2)

`apps/desktop/src-tauri/src/vault_watch.rs` — `start_with`에서 `vault_root`를
`std::fs::canonicalize`로 풀고 실패는 `"Could not watch the vault: {error}"`로
`Err`. 저장·watch·스레드가 전부 푼 경로를 쓴다. `sync_settings.rs`는 손대지
않는다(A2는 기존 셋이 그대로 통과하는 것으로 관찰한다).

같은 커밋에서 `an_arriving_picture_wakes_the_window`(:584)의
`std::fs::canonicalize` 한 줄과 그 위 주석 셋을 지운다. 그 줄은 이 버그를 피해
가려고 있던 것이다. 남겨 두면 이제 사실이 아닌 주석이 남는다. 지우면 그 테스트가
같은 결함의 두 번째 회귀 테스트가 된다.

실패 테스트: `apps/desktop/src-tauri/src/vault_watch.rs`의 `tests` 모듈,
`#[cfg(unix)] fn a_vault_reached_through_a_symlink_still_notices_a_change`.

- `tempfile::tempdir()`를 잡고 그 경로를 먼저 `canonicalize`한다. 테스트가 거는 링크
  하나만 남기려는 것이다. macOS tempdir 자체가 링크라 안 풀면 무엇이 red를
  만들었는지 흐려진다.
- `home/vault`를 실제로 만들고 `std::os::unix::fs::symlink`로 `home/vault-link` →
  `home/vault`를 건다.
- 사용자가 설정에 넣는 경로는 링크 쪽이므로 **링크 경로로** 씨앗을 심는다:
  `storage.export_pending(&linked, &home.join("images"))` 후
  `storage.merge_document(&waiting_picture(), &picture_input())` — 같은 모듈의 기존
  헬퍼를 그대로 쓴다. `assets/{SHOT_NAME}`을 기다리는 노트가 생긴다.
- `VaultWatch::start_with(storage, assets, linked.clone(), Duration::from_secs(60), told)`.
  **sweep은 진짜 값으로 둔다.** sweep이 바로 이 버그를 가리는 그물이라 짧게 주면
  테스트가 링크가 아니라 sweep을 재게 된다. 부팅 sweep은 어차피 t≈0에 돌고 다음
  sweep은 t≈60초다. 아래 10초 대기 안에 끼어들 수 없다.
- 1,500 ms 자고 `while changes.try_recv().is_ok() {}`로 부팅 스캔의 콜백을 비운다.
- `linked.join("assets")`를 만들고 `SHOT` 바이트를 `SHOT_NAME`으로 쓴다.
- `assert!(changes.recv_timeout(Duration::from_secs(10)).is_ok(), …)`.

red(현재 코드): `notify`가 `<home>/vault/assets/shot-….png`로 알려주는데
`watched_path`가 `<home>/vault-link`를 떼어내려다 실패해 `None`을 낸다. 큐에
아무것도 안 들어가고 다음 sweep은 60초 뒤라 10초 대기가 그냥 만료된다.
`recv_timeout`이 `Err(Timeout)`이고 `assertion failed`가 뜬다. green: 루트가 풀려
`strip_prefix`가 맞아떨어진다. 첨부가 큐를 타고 `take_asset`이 해석하면서 changed
콜백이 온다.

**2. `SWEEP > QUIET_MILLIS`를 컴파일러가 지키게 한다** (A3)

`apps/desktop/src-tauri/src/vault_watch.rs:25-29` — 두 상수 아래
`const _: () = assert!(SWEEP.as_millis() > QUIET_MILLIS as u128);` 한 줄과, 왜 이
검사가 인자가 아니라 상수에 걸리는지 적은 주석. `start_with`는 손대지 않는다.
`a_change_that_kept_mtime_and_size_is_caught_by_the_verification_pass`가 넘기는
200 ms는 검증 패스를 타는 정당한 요청이다.

실행 가능한 테스트 없음. 단언 자체가 검사이고 빌드마다 돈다. red 증거는 절차로
남긴다: `SWEEP`을 `Duration::from_millis(400)`으로 잠깐 바꾸고
`cargo test -p yonalist-v2-desktop`을 돌리면 `evaluation of constant value failed`
계열로 컴파일이 멈춘다. 그 출력을 그대로 기록하고 `SWEEP`을 되돌린 뒤 커밋한다.
커밋에는 되돌린 60초가 들어간다.

**3. mime 목록 옆에 같은 매핑을 든 네 곳을 적는다** (A4)

`crates/notes-sqlite/src/schema.sql` — `mime_type … CHECK`(:76) 바로 위에 `--` 주석.
담을 것: 확장자로 옮기는 자리가 여기 말고 넷 있다는 것, 네 곳의 경로와 이름, 그리고
넷 중 `layout.rs`와 `sync_merge.rs`가 모르는 mime을 조용히 png로 부른다는 것. 목록에
다섯 번째를 넣고 지나가면 vault 파일 이름과 `notes_images.relative_path`가 오류 한
줄 없이 틀린 확장자를 단다.

SQL은 Rust 함수를 못 부르므로 합치지 않는다. 요청이 정한 그대로다.
`sync_merge.rs`에는 아무것도 넣지 않는다(결정 4).

**실행 가능한 테스트가 없다.** SQL 주석이라 실행되는 게 없고 red로 만들 것도 없다.
지어내지 않는다. 검증은 리뷰에서 한다: 위 "네 벌이 실제로 일치하는가" 표가 주석에
적히는 사실과 맞는지 확인하면 된다. 이 커밋은 `schema.sql` 한 파일이다.

## 게이트 (diff 확정 후 1회)

Rust·persistence 경계다. 프런트엔드는 코드도 IPC 계약도 안 바뀌므로 `npm test`·
`npm run lint`·`npm run build`는 명시적으로 건너뛴다.

```
cargo test --workspace
cargo fmt --check
git diff --check
```

편집 루프 안에서는 `cargo test -p yonalist-v2-desktop`만 돌린다. Clippy는 이 diff가
새 갈래를 하나도 만들지 않으므로 기준선 비교를 요구하지 않는다.

수동 확인은 계약 표의 링크 시나리오 하나다. 항목 1이 사용자에게 보이는 런타임
경계를 건드리므로 새로 빌드해 띄운 앱에서 한 번 밟는다.
