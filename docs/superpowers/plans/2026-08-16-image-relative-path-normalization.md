# 이미지 relative_path 정규화 — 설계

2026-08-16 · Fable 5 설계 · 대상 브랜치 `fix/image-relative-path-normalization`

두 번째 랩탑이 같은 iCloud vault를 읽는 순간 양쪽 다 이렇게 죽는다(재현 완료,
재현 테스트는 되돌려서 트리는 깨끗함):

```
Conversion error from type Text at index: 11, image metadata is invalid:
relative image path must be derived from its content hash
```

원인은 `notes_images.relative_path`에 작성자가 둘이라는 것이다.

- `crates/notes-sqlite/src/mutations.rs:146`은 도메인 값 `{content_hash}.{ext}`를 쓴다.
  `crates/notes-core/src/image.rs:48`의 `NoteImage::try_new`가 그 형태만 받는다.
- `crates/notes-sync/src/merger.rs:1428`의 `write_image`는 vault 파일의 마크다운 링크
  (`assets/holiday-9f2c1b7a4e6d.png`)를 그대로 쓴다. `ON CONFLICT … DO UPDATE`라서
  건강하던 행도 자기 파일의 메아리를 받아들이는 순간 오염된다 — 원래 기기까지
  깨지는 이유다.
- `crates/notes-sqlite/src/sync_merge.rs:234`의 `resolve_asset`은 바이트가 도착하면
  해시만 채우고 경로는 그대로 둔다. 해시가 비어 있는 동안은 다른 문구로, 채워진
  뒤에는 보고된 문구로 `parse_node`(`row_mapping.rs:34`)가 터진다. `parse_node`는
  뷰포트·명령 적용·스냅샷 export가 전부 지나는 길이라 그 페이지는 읽기도 편집도
  export도 못 한다.

조사에서 하나 더 나왔다. **내용 비교가 이미지에서 비대칭이다.**
`content_of_file`(merger.rs:1521)은 파일의 링크로, `content_of_row`(:1569)는 행의
`relative_path`로 비교 문자열을 만든다. 원래 기기에서는 행이 도메인형이라 두 값이
절대 같아질 수 없고, 스탬프가 같은 재생에서 `decide`(:989)가 "손편집"으로 읽어
새 스탬프를 찍는다 — 유령 편집이 기기 사이를 오간다. 컬럼만 도메인형으로 통일하면
이 비대칭이 모든 기기로 번지므로 비교 수선은 선택이 아니라 이 수정의 동반 조건이다.

## 계약

| 필드 | 내용 |
| --- | --- |
| 목표 | 두 기기가 같은 vault를 공유해도 이미지 노드 때문에 페이지가 읽기 불능이 되지 않고, 같은 그림의 재생·메아리가 편집으로 읽히지 않는다 |
| 비대상 | 아래 별도 절 |
| 경계 | Rust(`notes-sqlite`: `row_mapping.rs`·`mutations.rs`·`sync_merge.rs` / `notes-sync`: `merger.rs`·`export.rs`·`parse.rs` / `src-tauri`: `vault_watch.rs`) · SQLite(스키마 불변, `relative_path` 의미 주석만 갱신) · IPC 없음(`NoteView.image`는 이미 nullable) · React 없음(`ImageNodeContent`의 "Image unavailable" 자리표시가 이미 있다) |
| 수동 확인 | ① 랩탑 B에서 랩탑 A의 vault를 지정 → 페이지가 열리고 이미지는 자리표시로 나왔다가 바이트 도착 후 재시작 없이 그림이 된다. ② 이미 깨진 랩탑 A는 앱 업데이트만으로 페이지가 다시 읽힌다. ③ 몇 분 두고 양쪽 `sync_conflict_log`가 더 자라지 않는다 |

### 완료 조건(acceptance)

| # | 관찰 가능한 통과 조건 | 항목 |
| --- | --- | --- |
| A1 | md가 png보다 먼저 도착해도 뷰포트 질의가 Err 없이 답하고 그 이미지 노드는 `image: None`(자리표시)으로 나온다 | 1 |
| A2 | 옛 병합이 오염시킨 행(해시 있음 + vault 링크 경로)이 코드 업데이트만으로 다시 읽히고 그림 메타데이터가 온전하다 — 데이터 리셋 없이 | 1 |
| A3 | 바이트를 기다리는 이미지 노드를 별표/이동해도 `notes_images` 행이 지워지지 않는다 | 2 |
| A4 | 해석이 끝난 이미지 노드의 재생·메아리 병합이 `applied == 0`으로 끝난다 — 재스탬프도 conflict 기록도 없다 | 3 |
| A5 | 바이트의 해시를 아는 병합이 쓴 행은 컬럼이 `{hash}.{ext}`다 — 원문 링크가 해시 있는 행에 남지 않는다 | 4 |
| A6 | 바이트가 나중에 도착하면 행이 규범형이 되고 revision이 움직여 열린 창이 재시작 없이 그림을 그린다 | 5 |
| A7 | alt가 빈 이미지 라인도 파일명을 이름으로 얻어 자리표시가 아니라 그림으로 그려진다 | 6 |

### 비대상

- 대기 이미지가 있는 페이지의 스냅샷(markdown/PDF) export 허용 — 지금도 거부이고
  변경 후에도 `export_snapshot.rs:125`의 기존 문구("Image node … has no exportable
  image metadata")로 거부한다. 오늘은 그보다 앞의 parse 단계에서 죽었으니 결과는
  같고 문구만 나아진다.
- 자리표시 UI를 "기다리는 중"과 "없음"으로 구분하는 것 — 기존 "Image unavailable"
  하나로 간다.
- 해시 꼬리가 없는 손제작 파일명(`assets/pic.png`)의 해석 — `resolve_asset`의 기존
  거부를 유지한다. 그런 행은 계속 기다리고, 비교 정체성도 양쪽 다 basename이라
  settle은 된다.
- `sync_node_exports`에 남은 옛 지문의 정리 — 다음 export가 새 지문을 다시 기록하고
  그걸로 끝이다(아래 위험 1).
- 스키마 변경·마이그레이션 — 없음. `user_version`도 그대로 1이다.

## 설계

### 결정 1 — 경로는 저장을 검증하지 않고 해시에서 유도한다

`parse_node`가 컬럼의 경로를 `try_new`로 검증하는 대신 버린다. 해시·이름·MIME·
크기만 읽어 `NoteImage::try_referenced`(image.rs:90, 이미 있다)로 만들면 경로는
정의상 `{hash}.{ext}`고 "경로가 해시에서 유도되지 않았다"는 상태 자체가 도메인에
들어올 수 없게 된다. 실패하면(`content_hash = ''`인 대기 행 포함) 그 노드는
`image: None`으로 나온다 — `NoteView.image`는 이미 nullable이고 프런트엔드는
`!image`에 자리표시를 그린다(`ImageNodeContent.tsx:256`). 페이지는 어떤 이미지
행으로도 죽지 않는다.

이 결정이 오염된 개발 DB의 리셋을 불필요하게 만든다. 오염 행은 해시가 멀쩡하므로
읽기가 그 자리에서 낫고 컬럼의 낡은 값은 아무도 읽지 않는 잉여가 된다(아래 독자
목록). `try_referenced`가 실패할 수 있는 나머지 입력은 DB CHECK가 이미 막고 있어
도달 가능한 `None`은 두 경우뿐이다: 대기 행(설계된 상태), alt 없는 손편집 라인
(항목 6이 좁힌다).

`read_image_asset`(notes-application/service.rs:255)은 `image: None`에
"The requested image metadata is unavailable."을 답하고, 프런트엔드 residency는
그걸 자리표시로 그린다 — 이 경로는 손대지 않는다.

### 결정 2 — 대기 창: 컬럼은 원문 링크를 그대로 들고 있는다

바이트가 안 온 행은 `{hash}.{ext}`를 만들 수 없다. 그 창에서 컬럼은 오늘처럼
**파일이 말한 링크 그대로**(`assets/x-….png`, `../assets/x-….png`)를 든다.
basename으로 깎지 않는 이유가 둘이다.

- `export.rs:781`의 `COALESCE(NULLIF(a.location,''), i.relative_path)` 폴백이 대기
  행에서만 실질적으로 도달하는데, 원문 링크가 그대로 있어야 write-back이 그 라인을
  바이트 동일하게 되돌려 쓴다. 해시 있는 행은 언제나 `sync_assets.location`이
  이긴다 — `write_image`가 해시를 아는 건 `sync_assets`에서 찾았을 때뿐이고
  `resolve_asset`·`place_attachments`도 각자 그 행을 만들기 때문이다. **폴백은
  변경하지 않는다.**
- `resolve_asset`의 대기 행 매칭(`relative_path = ?1 OR … LIKE '%/' || ?1`)이
  그대로 산다.

컬럼의 의미는 두 상태로 좁아진다: 해시가 비면 "파일이 말한 링크"(해석 매칭과
write-back용), 해시가 차면 `{hash}.{ext}`(mutations와 항목 4의 write_image가 쓰는
규범형). schema.sql의 컬럼 주석을 이 두 상태로 갱신한다(항목 4에 얹는다).

### 결정 3 — 내용 비교는 링크가 아니라 그림의 정체로

`image_content`의 path 자리에 링크 대신 **정체 문자열**을 넣는다. LineState의
주석("그림은 상태의 일부지 포인터가 아니다")이 말하는 그대로다.

- 파일 쪽: 링크의 basename에서 `-` 뒤 꼬리의 `.` 앞까지 — `asset_disk_name`
  (layout.rs:45)이 심는 해시 12자다. `-`가 없으면 basename 전체로 폴백.
- 행 쪽: `content_hash`가 차 있으면 그 앞 12자. 비어 있으면 저장된 링크에 파일 쪽과
  같은 함수를 적용 — 대기 행은 파일과 같은 링크를 들고 있으므로 자명하게 같다.

한 helper(`merger::image_identity(content_hash, link)`)를 세 곳이 쓴다:
`content_of_file`(:1531), `content_of_row`(:1574, `ImageRow`에 `content_hash` 추가·
`load_rows`의 SELECT에 `i.content_hash` 추가), export의 `readings()`(export.rs:693,
SELECT에 `i.content_hash` 추가). 이러면 "같은 그림"의 판단이 병합 tie-break·export
지문·settle에서 하나가 된다. 덤으로 attachment 재배치(페이지 assets ↔ 루트 assets,
더 작은 이름으로 개명)가 링크만 바꾸고 해시 12자는 못 바꾸므로 편집으로 오독되지
않게 된다.

이름·표시폭·픽셀·바이트 수는 지금처럼 비교에 남는다. 진짜 교체(다른 바이트)는
해시 12자가 바뀌어 편집으로 읽힌다 — 의도된 동작이다.

### 결정 4 — 쓰기 두 곳이 규범형을 지킨다

- `write_image`(merger.rs:1428): `sync_assets`에서 해시를 찾으면 컬럼에
  `{hash}.{ext}`(`ext`는 `layout::asset_extension(mime)`)를 쓴다. 못 찾으면 오늘처럼
  원문 링크(대기형). 읽기가 컬럼에 안 기대므로 정확성 요건은 아니지만, 컬럼의 두
  상태 의미를 쓰기 시점에 지켜 두면 오염형이 아예 생성 불가능해진다.
- `resolve_asset`(sync_merge.rs:234): 해시를 채우는 그 UPDATE가 경로도
  `?2 || '.' || CASE mime_type …`로 규범화한다. `resolved > 0`이면
  `notes_meta.revision`도 올린다 — 행이 바뀌면 revision이 움직인다는 이 파일 머리의
  계약 그대로다. `vault_watch.rs:183`의 attachment 갈래는 지금 창에 알리지 않는데
  ("outline에 아무것도 안 움직였다"는 그 주석의 전제가 자리표시 도입으로 깨진다),
  `take_asset`이 해석 수를 돌려주고 0보다 크면 md 병합과 같은 changed 콜백을 부른다.
  png이 md보다 늦게 오는 iCloud의 보통 순서에서 자리표시가 재시작 없이 그림이 되는
  건 이 두 줄이 만든다.

### `notes_images.relative_path`의 독자 전수

| 독자 | 지금 | 변경 후 |
| --- | --- | --- |
| `row_mapping.rs:39` parse_node | 검증(터지는 지점) | 읽지 않음 — 해시에서 유도 |
| `merger.rs:1039` load_rows → content_of_row | 비교 문자열 | 정체 계산의 폴백(해시 비었을 때만) |
| `export.rs:677` readings() 지문 | 비교 문자열 | 정체 계산의 폴백(위와 동일) |
| `export.rs:781` load_document 폴백 | 렌더 링크 | 유지 — 대기 행에서만 도달, 원문 링크 필요 |
| `sync_merge.rs:256` resolve_asset 매칭 | 대기 행 찾기 | 유지 — 대기형이 원문 링크라서 그대로 맞음 |
| `attachments.rs:251` referenced_assets | SELECT 후 미사용 | 그대로(미사용) |
| `mutations.rs:146` sync_image | 도메인형 쓰기 | 그대로 |
| `image_assets.rs` 앱 스토어 경로 | `NoteImage::relative_path()` | 그대로 — 유도값이라 항상 `{hash}.{ext}` |

`worker.rs`의 `relative_path`들은 `sync_quarantine` 컬럼이라 무관하다.

### 기존 테스트에 일어나는 일

- `crates/notes-sync/tests/merge_ingest.rs:709`
  `an_image_node_keeps_its_metadata_and_settles` — **단언 변경 없음, 그대로 green.**
  그 테스트는 `sync_assets`가 빈 채로 병합하므로 행이 대기형이고
  `relative_path == "assets/shot-9f3a1c8e2044.png"` 단언은 대기 창의 계약으로
  의미가 좁아진다. doc 주석에 "바이트가 오기 전의 행" 한 줄을 보태고, 해석 후의
  규범형은 항목 4의 새 테스트가 잠근다.
- `crates/notes-sqlite/tests/sync_merge_seam.rs`의
  `an_arriving_attachment_resolves_the_rows_waiting_for_it`(해시만 단언),
  `a_resolved_attachment_leaves_its_page_exportable`(링크는 `a.location`에서 렌더),
  `one_document_that_cannot_be_written_does_not_stop_the_others`(대기형 직접 삽입),
  `a_placeholder_row_does_not_stop_the_export` — 전부 단언 변경 없음.
- `crates/notes-sqlite/tests/two_devices.rs`
  `a_picture_two_pages_share_ends_up_in_the_vault_store` — 변경 없음(해시·location
  단언뿐).

### 개발 데이터 결정 (명시)

**리셋도 수리도 필요 없다.** 결정 1로 읽기가 컬럼에 기대지 않으므로 오염 행은
업데이트 직후부터 건강하게 읽히고, 항목 4·5가 새 오염 쓰기를 막는다. 낡은 값은
해시 있는 행에서 아무도 읽지 않는다. 컬럼을 눈으로 보고 싶은 사람을 위한 정돈
한 줄은 선택이다(필수 아님):

```sql
UPDATE notes_images SET relative_path = content_hash || '.' ||
  CASE mime_type WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/gif' THEN 'gif'
       WHEN 'image/webp' THEN 'webp' ELSE 'png' END
WHERE content_hash <> '';
```

단, 두 랩탑의 앱은 같이 업데이트한다 — 아래 위험 2.

## 위험 — 선택된 모양의 함정을 그대로 적는다

1. **정체 기반 비교로 이미지 노드의 export 지문이 한 번 바뀐다.** 기록된
   `sync_node_exports`와 어긋나 settle_readings가 한 번 무위로 지나가고
   record_readings가 새 지문을 다시 쓴다. 그걸로 끝이며 파일은 다시 쓰이지 않는다
   (지문 불일치는 기록 갱신이지 export 트리거가 아니다).
2. **버전이 섞인 두 기기는 tie-break에서 다른 답을 낼 수 있다.** 옛 코드는 링크로,
   새 코드는 정체로 digest를 만들기 때문이다. 개발 데이터 규칙과 같은 부류의
   제약으로 받아들이고 두 랩탑을 같이 올린다. `LineState`의 "v1"은 올리지 않는다 —
   올려도 교차 버전 불일치는 그대로라 사는 게 없다.
3. **`parse_node`의 None 삼킴이 진짜 손상을 가릴 수 있다.** 도달 가능한 경우를
   CHECK 제약이 두 가지(빈 해시, 빈 이름)로 좁혀 두었고 둘 다 이 설계가 다룬다.
   그 밖의 손상은 INSERT가 이미 거부한다.
4. **정체가 이름 꼬리 12자에 기댄다.** `asset_disk_name`과 `resolve_asset`이 이미
   같은 12자로 약속하고 있는 기존 계약이고, 손으로 바꾼 이름은 편집으로 읽히는
   쪽으로 틀린다 — 그 링크는 실제로 그 바이트를 더는 지칭하지 않으므로 옳은
   방향이다.
5. **대기 행의 write-back 링크는 원문 그대로다.** 그 사이 attachment가 재배치되면
   낡은 링크가 될 수 있으나, 바이트가 어디에도 없는 창의 이야기이고 오늘과 같은
   동작이다. 해석되는 순간부터는 `a.location`이 렌더를 소유한다.

## 작업 항목 (순서 고정, 항목당 커밋 1개)

각 항목은 먼저 빨간 테스트를 적고 그 출력을 기록한 뒤 구현한다. 항목 3·4가
`merger.rs`를 공유하므로 전체를 한 에이전트가 순서대로 진행한다.

**1. parse_node가 경로를 유도한다 — 페이지는 이미지 행으로 죽지 않는다** (A1·A2)
`crates/notes-sqlite/src/row_mapping.rs` — 열 11~18을 `NoteImage::try_referenced`로
접고 실패는 `image: None`. 실패 테스트 둘, 둘 다
`crates/notes-sqlite/tests/two_devices.rs`:
`a_page_arriving_before_its_picture_still_reads` — 기기 1에 `picture` 후 export,
md만 나르고(png 삭제) 기기 2가 absorb → `query_viewport`가 Ok, 그 노드는
`image()`가 None. red: `Err("… index: 11, image metadata is invalid: content hash
must be lowercase SHA-256")`.
`a_row_poisoned_by_an_old_merge_reads_healthy` — 재현과 같은 오염 행(해시 채움 +
`assets/holiday-9f2c1b7a4e6d.png`)을 SQL로 심고 뷰포트를 읽으면 Ok에
`relative_path() == "{HASH}.png"`. red: 보고된 문구 그대로
`Err("… relative image path must be derived from its content hash")`. 이 항목의
대표 증거다.

**2. 대기 행은 노드 편집에서 살아남는다** (A3)
`crates/notes-sqlite/src/mutations.rs` — `sync_image`의 DELETE 갈래를 kind가
Image가 아닐 때로 좁힌다(Image + `image: None`은 대기 행 보존, Page·Bullet의
None은 지금처럼 청소). 실패 테스트: `crates/notes-sqlite/tests/two_devices.rs`
`starring_a_waiting_picture_keeps_its_metadata` — 항목 1의 대기 상태에서 그 노드에
`IpcNotesCommand::SetStarred` 후 `SELECT count(*) FROM notes_images` == 1. red:
0 — 지금은 round-trip된 `image: None`이 행을 지운다.

**3. 비교가 그림의 정체로 통일된다** (A4)
`crates/notes-sync/src/merger.rs` — `image_identity` helper, `ImageRow.content_hash`,
`load_rows` SELECT 확장, `content_of_file`·`content_of_row`가 정체를 쓴다.
`crates/notes-sync/src/export.rs` — `readings()`가 `i.content_hash`를 더 읽어 같은
helper를 쓴다. 실패 테스트: `crates/notes-sync/tests/merge_ingest.rs`
`a_resolved_picture_replayed_is_not_an_edit` — 이미지 라인 병합 후 해석 완료 상태
(해시 + `{hash}.png` + `sync_assets` 행)를 SQL로 만들고 같은 파일을 같은 스탬프로
재생하면 `applied == 0`이고 hlc가 그대로다. red: `applied` left: 1, right: 0 —
같은 스탬프·다른 내용이 "내 기기의 손편집"으로 읽혀 재스탬프된다.

**4. write_image가 아는 해시는 규범형으로 앉힌다** (A5)
`crates/notes-sync/src/merger.rs` — 해시를 찾으면 `{hash}.{ext}`, 못 찾으면 원문
링크. `crates/notes-sqlite/src/schema.sql` — `relative_path` 주석을 두 상태 의미로
갱신(스키마 자체는 불변). 실패 테스트: `crates/notes-sqlite/tests/two_devices.rs`
`an_edited_echo_keeps_the_row_in_domain_form` — 기기 1의 자기 README에서 이미지
라인의 `t:`를 올리고 `w: 480`을 `w: 300`으로 바꾼 뒤 absorb하면 컬럼이
`{HASH}.png`. red: left: `"assets/holiday-9f2c1b7a4e6d.png"` — 메아리가 원문 링크를
앉힌다. 보조(같은 커밋): `crates/notes-sync/tests/merge_ingest.rs`
`a_picture_whose_bytes_are_known_lands_in_domain_form` — `sync_assets`를 미리 심고
첫 병합부터 규범형. red: 원문 링크.

이 항목의 red 조건은 구현하면서 한 번 고쳤다. 처음 적은 "재현 2 그대로: `t:`만
올린다"는 항목 3 이후로 red가 되지 않는다 — 스탬프만 다른 메아리는 정체 비교에서
같은 내용이라 `decide`가 적용하지 않고 `write_image`까지 가지 않는다. 그래서 표시
폭도 함께 바꿔 진짜 편집으로 만든다. 뒤집어 말하면 A5에 닿는 길은 이제 진짜 편집과
바이트를 이미 아는 첫 병합 둘뿐이고, 이 항목은 읽기의 정확성 요건이 아니라 컬럼의
두 상태 불변을 지키는 쪽이다(결정 4가 말한 그대로). 대기형과 규범형을 가르는 단언은
`merge_ingest.rs`의 `an_image_node_keeps_its_metadata_and_settles`와
`two_devices.rs`의 `starring_a_waiting_picture_keeps_its_metadata`가 맡는다.

**5. 바이트 도착이 행을 규범화하고 창을 깨운다** (A6)
`crates/notes-sqlite/src/sync_merge.rs` — `resolve_asset`의 UPDATE가 경로를
`?2 || '.' || CASE mime_type …`로 함께 쓰고, `resolved > 0`이면 revision을 올린다.
`apps/desktop/src-tauri/src/vault_watch.rs` — `take_asset`이 해석 수를 돌려주고
0보다 크면 changed 콜백을 부른다. 실패 테스트:
`crates/notes-sqlite/tests/sync_merge_seam.rs`
`resolving_an_attachment_normalizes_the_row_and_bumps_the_revision` — 대기 행 병합
후 `resolve_asset` → 컬럼 == `{hash}.png`이고 revision이 해석 전보다 크다. red:
컬럼은 원문 링크, revision은 그대로. 보조(같은 커밋): `vault_watch.rs` 테스트
`an_arriving_picture_wakes_the_window` — png 도착 처리 뒤 changed 콜백이 온다.
red: attachment 갈래가 아무도 부르지 않아 timeout.

**6. alt 없는 이미지 라인은 파일명을 이름으로 얻는다** (A7)
`crates/notes-sync/src/parse.rs` — `read_image`에서 이름이 비면 링크의 파일명으로
채운다(형식 경계에서 답한다는 이 파일의 기존 원칙 그대로). 실패 테스트:
`crates/notes-sync/tests/parse_leniency.rs`
`an_image_line_with_no_alt_takes_its_file_name` — `![](assets/x-….png) <!-- ya: … -->`
파싱 결과의 `original_name`이 파일명이다. red: `""` — 이대로면 `try_referenced`가
이름 검증에서 떨어져 그림이 영영 자리표시로 남는다.

## 게이트 (diff 확정 후 1회)

Rust·persistence 경계이므로 `cargo test --manifest-path src-tauri/Cargo.toml`(또는
워크스페이스 관례 경로)과 Rust 포매팅. 프런트엔드는 계약도 코드도 안 바뀌므로
`npm test`류는 명시적으로 건너뛴다. `git diff --check`.
