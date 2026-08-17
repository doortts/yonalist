# 사람이 읽는 vault 포맷 — 병합은 그대로

- 작성: 2026-08-18
- 기준: `main@9868bae3`, 작업 worktree `claude/three-way-sync-handoff-7b9f01`
- 대상 정본: [`docs/v2/sync-spec.md`](../../v2/sync-spec.md)
- 대체하는 것: [2026-08-17 v2 설계](2026-08-17-snapshot-three-way-sync-design-v2.md)의 A1 하나. 그 문서의 §5~§9(정규 snapshot, `state_hash`, base 결정표, 3-way 병합)는 근거로 쓰지 않는다

## 0. 지배 제약

이 작업의 전부는 **표기 변경**이다. `merger.rs`가 읽는 값은 하나도 달라지지 않고 파일 안에서 그 값이 적힌 자리만 옮긴다.

앞선 시도(M1, `19a6dcf3`·`c2334c12`, 어제 revert)는 스탬프를 파일에서 **지웠다**. `decide`는 파일 스탬프와 행 스탬프를 비교하므로 빈 스탬프는 기존 모든 행에 `LocalWins`를 답했고 다른 기기가 쓴 것은 영원히 도착하지 못했다. 이번 설계가 그 실패를 피하는 방법은 규칙 하나다.

**`document.rs`의 `DocumentNode`와 `PageDocument`는 필드도 의미도 그대로 둔다.** `hlc`, `place`, `from`, `marker`, `collapsed`, `completed`, `starred`, `unknown_tokens`, 그리고 frontmatter의 `max_hlc`·`root_*`가 전부 남는다. renderer가 그 값을 어디에 쓰는지, parser가 어디서 읽는지만 바뀐다. 그러면 `decide`·`decide_place`·`content_of_file`·`content_of_row`·`SiblingOrder`는 같은 입력에 같은 답을 낸다.

따라서 이 설계에서 `merger.rs`가 얻는 수정은 두 종류뿐이다. id 모양(`Uuid::new_v4` → `new_yid`, `recovery_sort_key`, `recovery_page`의 파생)과, 더 이상 발화할 수 없게 된 분기 하나의 삭제. 승패 판정에는 손대지 않는다.

문서 단위 정보는 frontmatter에 남는다. 사용자가 이미 정한 것이고 이 문서는 그 결정을 따른다.

## 1. 제공 계약

| 항목 | 내용 |
|---|---|
| 목표 | vault의 `README.md`를 평범한 Markdown 편집기에서 열면 본문이 사람이 쓴 글처럼 읽히고, 그 상태로도 두 기기 병합이 지금과 똑같이 동작한다 |
| 비대상 | 3-way 병합, `state_hash`, 정규 snapshot, `sync_snapshots`, base 결정표, 충돌 복구 UI. `format_version`·`user_version` 승급, 마이그레이션 코드, 호환 reader. `notes-export`의 자체 escape 정리. 자동 문서 분할. 주석을 잃은 손편집의 재결합 |
| 영향 경계 | Rust(`notes-core`, `notes-sync`, `notes-sqlite`, `apps/desktop/src-tauri`), 파일 시스템(vault 읽기·쓰기와 폴더 이름), 프런트엔드(`storeSupport.ts`의 id 생성). SQLite는 `schema.sql`을 포함해 한 글자도 고치지 않는다. IPC payload 계약도 그대로다 |
| 직접 확인할 사용자 시나리오 | 앱에서 노트 몇 줄과 번호 목록·체크박스·이미지를 만들고 vault를 방출한다. `README.md`를 텍스트 편집기로 열어 (1) 마침표가 `\.`이 아니고 (2) 줄 끝 주석이 `<!-- yid: XXXXXXXXXXXX -->` 하나뿐이고 (3) 파일 끝에 footer 한 덩이가 있는지 본다. 본문 한 줄을 고치고 저장한 뒤 앱으로 돌아와 같은 줄이 고쳐진 채 남아 있는지, 새 줄로 갈라지지 않는지 확인한다 |

### 완료 조건

| ID | 사용자에게 보이는 결과 | 기계적 완료 조건 |
|---|---|---|
| A1 | 문장부호가 백슬래시를 달고 나오지 않는다 | `fixtures/page.md`의 note가 `이번 분기에 손대는 것만.`이고 이미지 alt가 `아키텍처.png`다. 네 fixture 본문에 `\.`·`\+`·`\/`·`\,`가 없다 |
| A2 | 줄 끝에는 그 줄의 정체성 하나만 붙는다 | 네 fixture 본문의 모든 주석이 `<!-- yid: XXXXXXXXXXXX -->`와 정확히 같다. 본문에 `t:`·`prev:`·`star`·`done`·`collapsed`·`ordered:`·`from:`·`<!-- ya:`가 없다 |
| A3 | id가 짧다 | vault의 모든 `yid:` 값과 frontmatter `id`·`parent`, 페이지 폴더 접미사가 `^[A-Za-z0-9_-]{12}$`를 만족한다. home의 리터럴 `root`만 예외다 |
| A4 | 다른 기기의 변경이 지금처럼 도착한다 | 항목마다 `crates/notes-sqlite/tests/two_devices.rs` 28개, `crates/notes-sync/tests/merge_ingest.rs`, `crates/notes-sqlite/tests/sync_merge_seam.rs`가 `#[ignore]` 없이 전부 통과한다 |
| A5 | 손으로 고친 파일이 정규형으로 돌아온다 | 네 fixture와 `parse_leniency.rs`의 모든 모양 문서가 parse → render → parse에서 같은 바이트를 낸다. `export.rs::write_checked`의 자가 검증이 통과한다 |

A1은 항목 1, A2는 항목 2, A3은 항목 3·4, A4는 모든 항목의 통과 조건, A5는 항목 1·2가 각자의 골든으로 잠근다.

## 2. 목표 포맷

지어낸 값은 아래로 고정한다. `sync-spec.md` §11의 표를 이 값으로 바꿔 적는다.

| 자리 | 값 |
|---|---|
| 페이지 id (Projects) | `PrJects00001` |
| 페이지 id (회의록) | `Mnutes000001` |
| 분할 문서 id | `Archive00001` |
| 노드 id | `Nd00000000NN` |
| device | `a3f2` |
| HLC | `0swkd7qz4-00-a3f2`부터 counter 증가 |

### 2.1 `Projects-PrJects00001/README.md`

```markdown
---
kind: yonalist-notes
format_version: 1
id: PrJects00001
max_hlc: 0swkd7qz9-00-a3f2
updated: 2041-10-11T06:19:09Z
root_hlc: 0swkd7qz5-00-a3f2
root_starred: true
---
# Projects
> 이번 분기에 손대는 것만.

- 아키텍처 다시 그리기 <!-- yid: Nd0000000001 -->
  - [ ] 크레이트 경계 정리 <!-- yid: Nd0000000002 -->
  - ![아키텍처.png](assets/아키텍처-9f3a1c8e2044.png) <!-- yid: Nd0000000003 -->
- 정리한 것 <!-- yid: Nd0000000004 -->

<!-- yonalist
yid: Nd0000000001 t: 0swkd7qz6-00-a3f2
yid: Nd0000000002 t: 0swkd7qz7-00-a3f2
yid: Nd0000000003 t: 0swkd7qz8-00-a3f2 w: 320 px: 1280x720 bytes: 421904
yid: Nd0000000004 t: 0swkd7qz9-00-a3f2 done collapsed
-->
```

`root_starred`가 frontmatter에 남는 것이 문서 root의 상태 처리 전부다. 문서 root는 footer에 줄을 갖지 않는다. 미완료 todo는 `- [ ] `가 전부이고 footer에 `todo`를 다시 쓰지 않는다.

### 2.2 vault 루트 `README.md` (home)

```markdown
---
kind: yonalist-notes
format_version: 1
id: root
max_hlc: 0swkd7qz6-00-a3f2
updated: 2041-10-11T06:19:09Z
root_hlc: 0swkd7qz4-00-a3f2
---
# Home

- [Projects](Projects-PrJects00001/README.md) <!-- yid: PrJects00001 -->
- [회의록](회의록-Mnutes000001/README.md) <!-- yid: Mnutes000001 -->

<!-- yonalist
yid: PrJects00001 t: 0swkd7qz5-00-a3f2 split
yid: Mnutes000001 t: 0swkd7qz6-00-a3f2 split
-->
```

### 2.3 `Projects-PrJects00001/2024-아카이브-Archive00001/README.md`

```markdown
---
kind: yonalist-notes
format_version: 1
id: Archive00001
parent: PrJects00001
sort_key: 4294967296
max_hlc: 0swkd7qze-00-a3f2
updated: 2041-10-11T06:19:09Z
root_hlc: 0swkd7qzd-00-a3f2
---
# 2024 아카이브

- 3월 회고 <!-- yid: Nd0000000008 -->

<!-- yonalist
yid: Nd0000000008 t: 0swkd7qze-00-a3f2
-->
```

부모 문서에 남는 줄과 그 footer 항목은 §2.2의 두 줄과 같은 모양이다.

### 2.4 `.yonalist/trash.md`

```markdown
---
kind: yonalist-trash
format_version: 1
max_hlc: 0swkd7qzc-00-a3f2
updated: 2041-10-11T06:19:09Z
---
- Old page <!-- yid: Nd0000000005 -->
- Deleted <!-- yid: Nd0000000006 -->
  - Child <!-- yid: Nd0000000007 -->

<!-- yonalist
yid: Nd0000000005 t: 0swkd7qza-00-a3f2 from: root@4294967296
yid: Nd0000000006 t: 0swkd7qzb-00-a3f2 from: PrJects00001@8589934592
yid: Nd0000000007 t: 0swkd7qzc-00-a3f2 done
-->
```

### 2.5 네 fixture가 덮지 못하는 모양

fixture 파일을 다섯째로 늘리지 않는다. 아래 모양은 이미 있는
`parse_leniency.rs::a_document_holding_every_shape_survives_two_round_trips`가
인라인으로 만드는 문서이고 이 절은 그 문서가 어떤 바이트가 되는지를 보인다.

```markdown
---
kind: yonalist-notes
format_version: 1
id: Shapes000001
max_hlc: 0swkd7qzl-00-a3f2
updated: 2041-10-11T06:19:09Z
root_hlc: 0swkd7qzf-00-a3f2
root_marker_kind: ordered
root_ordered_start: 3
root_collapsed: true
---
# 모양 모음
> 첫 줄
>
> 셋째 줄

- [x] 끝낸 할 일 <!-- yid: Nd0000000011 -->
- [ ] 남은 할 일 <!-- yid: Nd0000000012 -->
- 별표와 접힘 <!-- yid: Nd0000000013 -->
  > 이 줄의 노트
- 번호 첫 줄 <!-- yid: Nd0000000014 -->
- 번호 둘째 줄 <!-- yid: Nd0000000015 -->
- 옮겨 온 줄 <!-- yid: Nd0000000016 -->

<!-- yonalist
yid: Nd0000000011 t: 0swkd7qzg-00-a3f2
yid: Nd0000000012 t: 0swkd7qzh-00-a3f2
yid: Nd0000000013 t: 0swkd7qzi-00-a3f2 star collapsed
yid: Nd0000000014 t: 0swkd7qzj-00-a3f2 ordered: 3
yid: Nd0000000015 t: 0swkd7qzk-00-a3f2 ordered: 4
yid: Nd0000000016 t: 0swkd7qzl-00-a3f2 prev: Nd0000000012@0swkd7qzm-00-a3f2 future: 1
-->
```

체크한 할 일은 `- [x] `가 그리고 footer는 아무 말도 하지 않는다. 별표·접힘·번호는 Markdown이 그릴 자리가 없어 footer가 진다. `prev:`를 실은 줄은 줄 순서가 말하는 자리(바로 앞이 `Nd0000000015`)와 실제 주장(`Nd0000000012` 뒤)이 갈라진 줄이고 지금 renderer의 생략 조건이 그대로 적용된다. `future: 1`은 이 빌드가 모르는 token이 알려진 token 전부 뒤에 붙어 나가는 모습이다.

### 2.6 escape 규칙

`escape_markdown`이 ASCII 문장부호 전부에 백슬래시를 붙이는 것을 그만둔다. 위치에 따라 세 갈래다.

| 자리 | 처리 | 그대로 두는 예 |
|---|---|---|
| 어디서나 | `\` → `\\`, `&` → `&amp;`, `<` → `&lt;` | `/`, `.`, `+`, `,`, 괄호, 문장 안의 `-`, `*`, `_`, 백틱 |
| 줄 첫 글자 | `>` → `&gt;`. 그리고 블록을 여는 접두사에만 백슬래시 — 선두 `-`·`*`·`+`·`#`, `[`가 뒤따르는 선두 `!`, 선두 숫자열을 닫는 `.`이나 `)` | `Shift+Enter`, `음.`, 문장 중간의 `a > b` |
| 링크 label | 위에 더해 `[` → `\[`, `]` → `\]` | 파일명의 `.`, `-` |

`&`와 `<`는 어디서나 엔티티가 된다. `<`를 좁히면 renderer가 두 글자 앞을 내다봐야 하고 parser의 경계 찾기(`rfind(" <!--")`)는 자리로만 판단하므로 서로 맞아야 할 규칙이 둘이 된다. 규칙 하나로 두고 `a < b`가 `a &lt; b`로 보이는 것은 §7에 한계로 적는다. `&`를 그대로 두면 사용자가 친 `&lt;`가 왕복에서 `<`로 무너진다.

`parse.rs`의 `unescape_scan`은 한 글자도 고치지 않는다. 이미 `\` + ASCII 문장부호 전부를 되돌리므로 renderer가 백슬래시를 덜 쓰는 방향은 그 상위집합 안에 있다. `escape(unescape(s)) == s`도 유지된다. `\`가 언제나 `\\`가 되기 때문이다.

## 3. 지금 줄에 있는 것이 어디로 가는가

| 지금 | 어디로 | 본문과 footer가 어긋나면 |
|---|---|---|
| `yid: <id>` | **줄에 남는다.** 본문의 유일한 주석이다 | footer의 `yid:`는 join key다. 본문에 없는 yid의 footer 항목은 버린다(§4) |
| `t: <hlc>` | footer | Markdown이 표현할 수 없어 어긋날 일이 없다. footer 항목이 없으면 빈 스탬프이고 LWW에서 언제나 진다 — `t:`를 지운 줄에 지금 적용되는 규칙 그대로다 |
| `prev: <id>@<hlc>` | footer | 같다. footer에 없으면 (앞 줄의 id, 이 노드의 `t:`)로 채우는 지금 규칙이 그대로 남는다 |
| `star` | footer | 어긋날 수 없다. Markdown에 별표를 그릴 자리가 없다 |
| `todo` | **사라진다.** 본문의 `- [ ] `/`- [x] `가 유일한 권위다 | footer가 다시 말하지 않으므로 어긋날 수 없다. parser는 이미 `prefix_marker.unwrap_or(tokens.marker)`로 접두사를 앞세우므로 token을 빼는 것이 병합에 중립이다 |
| `done` | footer, 지금처럼 marker가 todo가 **아닐** 때만 | 체크박스가 있으면 본문이 이긴다. `read_node_line`의 `prefix_completed \|\| tokens.completed`가 이미 그렇게 읽는다 |
| `split` | footer | 본문의 링크 모양만으로는 평범한 링크 블릿과 구별되지 않는다. footer에 `split`이 없는 줄은 링크 텍스트를 가진 평범한 블릿이고 그것이 맞는 읽기다 |
| `collapsed` | footer | 어긋날 수 없다 |
| `ordered: <i64>` | footer. 본문은 번호를 그리지 않는다 | §3.1이 이유다 |
| `from: <parent>@<key>` | footer, `trash.md` 전용 | 어긋날 수 없다. page 문서의 footer에 나오면 격리 — 지금 `read_node_line`의 규칙이 옮겨 온 것이다 |
| `<!-- ya: w: px: bytes: -->` | footer의 그 블록 줄에 `w:`·`px:`·`bytes:`로 | 본문은 링크와 alt만 진다. footer 항목이 없는 이미지 줄은 격리한다 — 지금 ya 주석 없는 이미지 줄이 받는 답과 같다(§7) |
| 알 수 없는 token | footer, 알려진 token 전부 뒤, 만난 순서 | 지금과 같이 `sync_extras`에 실려 그대로 돌아 나간다 |
| frontmatter의 `kind`·`format_version`·`id`·`parent`·`sort_key`·`max_hlc`·`updated`·`root_hlc`·`root_*` | **frontmatter에 남는다** | 사용자 결정이다. footer로 옮기지 않는다 |

파생되는 것은 하나뿐이고 이미 있다. `updated`는 `max_hlc`를 읽은 값이고 손으로 고쳐도 다음 방출에서 교체된다.

### 3.1 번호는 왜 본문이 그리지 않는가

체크박스와 번호는 Markdown이 그릴 수 있고 별표는 그릴 수 없다. 체크박스는 이미 본문이 그리고 있으니 그대로 두면 되지만 번호는 갈림길이다.

`ordered_start`는 **그 줄이 입력된 번호**이고 화면에 그려지는 번호가 아니다. 그려지는 번호는 run 전체의 함수다 — `outlineOrdered.ts::orderedNumbers`가 run의 첫 줄부터 세어 올리고 `notes-export`도 같게 센다. 그래서 세어 올린 번호를 본문에 그리고 그대로 읽어 들이면 run의 둘째 줄 이후는 저장된 `ordered_start`가 바뀐다. `content_of_file`이 `ordered_start`를 비교에 넣으므로 그 변화는 병합이 보는 내용 변화이고, 모든 기기가 서로의 파일을 편집으로 읽어 끝없이 되쓴다. §0이 금지한 그것이다.

저장된 `ordered_start`를 그대로 그리면 병합에는 중립이다. 그런데 Markdown은 음수나 열 자리를 넘는 번호를 표기할 수 없고 `parse_leniency.rs::a_document_holding_every_shape_survives_two_round_trips`는 이미 `-3`부터 시작하는 start를 문서에 싣는다. `IpcNotesCommand::SetMarker`의 `start: i64`에 검증이 없어 도메인이 그런 값을 실제로 만들 수 있다.

그래서 번호는 footer에 둔다. 권위가 하나이고 분기가 없고 잃는 값도 없다. 대가는 Markdown 서버에서 번호 행이 블릿으로 보이는 것이고 §7에 적는다. 나중에 본문이 번호를 그려야 하면 `ordered_start >= 0`을 도메인에서 먼저 정하는 것이 순서다 — A1이 요구하는 것은 아니다.

## 4. footer 문법

**JSON이 아니다.** 지금 본문 주석이 쓰는 token 문법을 그대로 옮긴다.

이유는 두 가지다. 첫째, `read_tokens`를 손대지 않고 재사용하므로 새 parser가 없다. 둘째가 더 중요하다. 알 수 없는 token은 `notes_nodes.sync_extras`에 공백으로 이어 붙인 문자열로 저장되고 `extras_of`가 그 문자열을 `content_of_file`의 비교 항목으로 넣는다. token을 JSON key로 바꾸면 그 문자열이 달라지고 그것은 병합이 보는 내용 변화다 — 다시 §0이다. 그리고 `serde` + `serde_json`을 `notes-sync`에 넣고 `Option` 열세 개짜리 구조체와 `#[serde(flatten)]`을 만들 필요도 없어진다. 대안으로 검토한 JSON footer는 새 의존성 둘, 새 모델 하나, `sync_extras` 인코딩 변경을 요구하고 얻는 것은 없다.

### 자리와 개수

- 파일의 마지막 비공백 덩이다. 앞에 빈 줄 하나가 온다.
- 문서마다 정확히 하나. renderer는 노드가 없는 문서에도 빈 footer를 쓴다 — 모양을 하나로 두면 renderer와 parser 양쪽에서 분기가 없어진다.
- 빈 줄은 renderer가 이미 쓴 것이 있으면 다시 쓰지 않는다(`out.ends_with("\n\n")`). 노드 없는 페이지가 빈 줄 둘로 끝나는 것을 막는 조건 하나다.

### 문법

```text
<!-- yonalist
yid: <yid> <token>*
yid: <yid> <token>*
-->
```

- 여는 줄은 `<!-- yonalist`와 정확히 같다. 들여쓰기도 후행 공백도 없다.
- 항목 줄은 들여쓰지 않는다. 첫 token은 반드시 `yid:`이고 그다음이 그 블록의 상태다.
- token 순서는 지금 `render_comment`가 쓰는 순서를 그대로 잇고 이미지 셋이 끝에 붙는다: `yid:`, `t:`, `star`, `ordered: <i64>`, `done`, `split`, `prev: <id>@<hlc>`, `from: <id>@<i64>`, `collapsed`, `w: <u32>`, `px: <u32>x<u32>`, `bytes: <u64>`, 알 수 없는 token.
- `:`로 끝나는 token은 알려진 것이든 아니든 다음 단어 하나를 값으로 삼는다. 지금 §4.3의 분해 규칙 그대로다.
- 항목 줄의 순서는 본문 줄 순서다. renderer가 트리를 훑는 순서가 그것이고 `BTreeMap`도 정렬도 필요 없다.
- 닫는 줄은 `-->`와 정확히 같고 그 뒤에는 빈 줄만 올 수 있다.

### 무엇이 malformed이고 parser는 어떻게 하는가

| 입력 | 처리 |
|---|---|
| footer가 없다 | **수용.** 모든 노드가 빈 스탬프와 기본 상태를 갖는다. `t:`를 지운 줄 하나에 지금 적용되는 규칙을 문서 전체로 늘린 것이고, 그 파일은 DB에 지고 다음 방출이 정규형을 되쓴다 |
| footer가 비어 있다 | 수용. 위와 같다 |
| 본문에 없는 yid의 항목 | **버린다.** 손편집으로 블릿이 지워지면 남는 정상 상태다. 담아 둘 자리가 `DocumentNode`에 없고 버리는 쪽이 왕복에서 안정적이다 — parse가 버리고 render가 쓰지 않으므로 두 번째 왕복이 같은 바이트다 |
| footer 항목이 없는 본문 블릿 | 수용. 빈 스탬프와 기본 상태. 이미지 줄만 예외로 격리한다(§7) |
| `yid:`로 시작하지 않는 항목 줄 | **격리.** 붙일 블록이 없고 추측하면 남의 상태를 남의 줄에 붙인다 |
| 같은 `yid:`가 두 번 | **격리.** 인정 key 중복은 격리라는 §5.2 규칙 그대로다 |
| 같은 항목 줄 안에서 인정 token 중복 | **격리.** `read_tokens`의 `once` 가드가 이미 그렇게 답한다 |
| `<!-- yonalist`가 있고 `-->`가 없다 | **격리** |
| footer가 둘 이상 | **격리** |
| `-->` 뒤에 빈 줄이 아닌 것 | **격리** |
| page 문서 footer의 `from:` | **격리.** kind 비호환 key라는 지금 규칙이 자리만 옮긴 것이다 |
| 알 수 없는 token | 보존해 `unknown_tokens`로 싣고 재방출한다 |

격리는 지금과 같이 문서 전체 거부이고 이유 문장이 `notes://sync-status`로 간다.

### 구현이 닿는 자리

`parse()`가 frontmatter를 가른 직후 body에서 여는 줄을 찾아 한 번 더 가른다. footer는 `BTreeMap<String, Tokens>`로 읽고 `NodeReader`가 그 map을 들고 다니다가 줄의 `yid:`로 자기 항목을 찾아 노드에 합친다. `read_node_line`의 접두사 판정은 그대로이고 합침 순서도 그대로다 — 접두사가 marker와 completed를 앞선다.

`split_trailing_comment`의 `ya:` 특례는 죽는다. 줄에 `ya:` 주석이 더는 오지 않으므로 지운다. `read_image`는 주석 파싱을 잃고 링크와 alt만 읽는다.

`document.rs`에서 `ImageReference::unknown_tokens`를 지운다. footer 한 줄에 모인 알 수 없는 token은 전부 `DocumentNode::unknown_tokens`에 순서대로 들어가고, 그 결과 `extras_of`가 만드는 문자열은 지금 노드 token 뒤에 이미지 token을 이어 붙인 것과 같다. `merger.rs`에서 지우는 것은 발화할 수 없게 된 이미지 분기 세 줄이고 승패 판정은 건드리지 않는다.

`export.rs`는 한 줄도 고치지 않는다. `load_document`는 `PageDocument`를 만들 뿐 파일 문법을 모른다.

## 5. 항목 목록

항목마다 한 커밋이고 항목이 적은 파일 밖은 건드리지 않는다. 위험이 쌓이지 않게, 이 작업에서 유일하게 확인되지 않은 것 — 스탬프가 footer로 가도 병합이 그대로인가 — 을 항목 2에서 먼저 답하고 나머지를 그 위에 얹는다.

### 항목 1. 문장부호가 백슬래시를 잃는다 — A1

**여는 실패 test**: `crates/notes-sync/tests/render_goldens.rs::ordinary_punctuation_reaches_the_file_unescaped`
note와 이미지 alt에 마침표·쉼표·더하기·슬래시를 담은 문서를 render하면 백슬래시가 없다. 지금 `escape_markdown`이 ASCII 문장부호 전부에 붙이므로 빨갛다.

**만지는 파일**: `crates/notes-sync/src/render.rs`, `crates/notes-sync/fixtures/page.md`, `crates/notes-sync/tests/{render_goldens.rs, parse_leniency.rs}`, `crates/notes-sqlite/tests/sync_merge_seam.rs`.

`escape_markdown`이 자리를 인자로 받고 §2.6의 세 갈래를 구현한다. 호출부는 같은 파일 안의 `escape_inline`·`render_note`·`render_image`·`render_page`뿐이라 중간 상태가 컴파일된다. `parse.rs`는 손대지 않는다.

`sync_merge_seam.rs:532`의 `r"- Thought\, typed here <!-- yid:"`가 `- Thought, typed here <!-- yid:`가 된다. `parse_leniency.rs:638`의 `escaped()` 도우미도 renderer를 따라간다. **둘 다 단정을 약화하는 것이 아니라 A1 그 자체다** — 기대값이 바뀐 것이고 같은 강도로 남는다.

**`two_devices.rs`**: 파일을 건드리지 않고 통과한다. 텍스트 값은 그대로이고 파일 인코딩만 바뀌므로 `content_of_file`의 digest도 그대로다. 첫 방출이 모든 파일을 다시 쓰는 것이 유일한 관측 가능한 결과다.

**혼자 revert 가능**: 그렇다.

### 항목 2. 줄 끝 살림살이가 footer로 간다 — A2, A4

**여는 실패 test**: `crates/notes-sync/tests/render_goldens.rs::a_body_line_carries_its_block_id_and_nothing_else`
네 fixture를 render하고 본문의 모든 주석이 `<!-- yid: … -->` 정규식과 맞는지, 본문에 `t:`·`prev:`·`star`·`done`·`collapsed`·`ordered:`·`from:`·`<!-- ya:`가 없는지 본다. 지금 `render_comment`가 `t:`를 쓰므로 빨갛다.

**같이 두는 test**: `crates/notes-sync/tests/parse_leniency.rs::{a_second_footer_quarantines, a_footer_line_without_a_block_id_quarantines, a_footer_entry_for_a_line_that_is_gone_is_dropped, a_document_without_a_footer_reads_as_unstamped, a_footer_token_this_build_does_not_know_survives_a_round_trip}`.

**만지는 파일**: `crates/notes-sync/src/{render.rs, parse.rs, document.rs, merger.rs}`, `crates/notes-sync/fixtures/{page.md, home.md, split.md, trash.md}`, `crates/notes-sync/tests/{render_goldens.rs, parse_leniency.rs, watcher.rs}`, `apps/desktop/src-tauri/src/vault_watch.rs`(test가 만드는 `ImageReference`의 필드 하나).

중간 상태가 컴파일되는 이유: `document.rs`에서 지우는 것은 `ImageReference::unknown_tokens` 하나이고 그것을 읽는 자리는 `render_image`와 `extras_of` 둘, 쓰는 자리는 `read_image`와 세 test 파일의 생성자다. 같은 커밋 안에서 전부 닫힌다.

**`two_devices.rs`**: 파일을 건드리지 않고 통과한다. 이 항목이 그 통과를 증거로 삼는 항목이다 — `merger.rs`에서 바뀌는 것이 죽은 분기 셋뿐이고 `DocumentNode`가 나르는 값이 그대로이므로 `decide`가 보는 입력이 같다. 통과하지 않으면 설계가 틀린 것이고 그때는 보고할 사실이지 우회할 대상이 아니다.

**혼자 revert 가능**: 그렇다. 항목 1과 파일이 겹치지만 함수가 다르다.

### 항목 3. `notes-core`가 12자 id를 만든다 — A3

**여는 실패 test**: `crates/notes-core/src/id.rs::a_new_id_is_twelve_url_safe_characters`
같이 두는 것: `nine_bytes_encode_without_padding_or_loss`, `the_shape_check_refuses_what_the_vault_cannot_carry`. 함수가 없으므로 컴파일되지 않는다.

**만지는 파일**: `crates/notes-core/{Cargo.toml, src/id.rs, src/lib.rs}`, `Cargo.lock`.

`19a6dcf3`의 `id.rs`를 그대로 들여온다. `new_yid`, `encode_yid`, `is_yid`, `is_block_id`, `YID_LENGTH`, `HOME_ID`. 부르는 곳이 없는 순수 추가라 아무것도 깨지지 않는다.

의존성 둘이 늘어난다.

| 크레이트 | 이유 | `Cargo.lock` |
|---|---|---|
| `getrandom = "0.3"` | OS CSPRNG 9바이트. 난수원은 손으로 만들 것이 아니고, `uuid`의 v4를 재사용하면 version·variant 6비트가 고정돼 72비트가 66비트가 된다 | 있다 (0.2.17·0.3.4·0.4.3) |
| `base64 = "0.22"` | 9바이트 → 12자 `URL_SAFE_NO_PAD`. 9는 3의 배수라 인코딩이 전단사이고 padding도 modulo 편향도 없다 | 있다 (0.21.7·0.22.1) |

둘 다 lock에 있어 새로 내려받는 것이 없다. `notes-core`의 직접 의존성이 셋에서 다섯이 되고 `checkV2Architecture.mjs`의 예산 20 안이며 그 검사는 workspace 의존성만 본다. `base64`를 손으로 대신하면 열두 줄이 늘고 lock에 이미 있는 것을 다시 쓰는 편이 짧다.

**`two_devices.rs`**: 파일을 건드리지 않고 통과한다.

**혼자 revert 가능**: 그렇다.

### 항목 4. vault의 모든 id가 `yid`가 된다 — A3

**여는 실패 test**: `crates/notes-sync/tests/vault_layout.rs::a_page_folder_carries_the_whole_block_id`
`page_folder_name("Projects", "PrJects00001")`이 `Projects-PrJects00001`이다. 지금 `folder_suffix`가 UUID를 파싱하므로 빨갛다.

**만지는 파일**: `crates/notes-core/src/tree.rs`; `crates/notes-sync/src/{layout.rs, parse.rs, render.rs, merger.rs}`; `crates/notes-sqlite/src/seed.rs`; `apps/desktop/src-tauri/src/vault_watch.rs`; `apps/desktop/src/store/storeSupport.ts`; fixture 넷; test는 `crates/notes-core/tests/{tree_commands.rs, tree_subtree.rs}`, `crates/notes-sync/tests/{render_goldens.rs, parse_leniency.rs, vault_layout.rs, merge_ingest.rs, merge_algebra.rs, export_core.rs, attachment_export.rs, attachment_plan.rs, watcher.rs}`, `crates/notes-sqlite/tests/{two_devices.rs, sync_merge_seam.rs, sync_stamping.rs, sync_cost.rs, attachment_list.rs}`, `crates/notes-application/tests/merge_barrier.rs`, `apps/desktop/src/{store/storeSupport.test.ts, AttachmentsSection.test.tsx, SettingsView.test.tsx}`.

**이 항목이 가장 넓고 나눌 수 없다.** id 생산자와 검증자가 한 커밋에서 같이 뒤집혀야 한다. `parse.rs`의 `canonical_uuid`가 `is_block_id`로 바뀌는 순간 UUID를 만드는 생산자가 하나라도 남아 있으면 그 문서는 격리되고, `render.rs`가 먼저 바뀌면 UUID를 든 행이 있는 문서가 전부 방출을 거부한다. `export_pending`은 문서마다 오류를 삼키므로 그 거부는 조용하다. `c2334c12`가 고친 것이 정확히 그것이다 — `flatten`의 `Uuid::new_v4()`가 UUID를 발급하고 renderer가 그 페이지를 거절해서, 되쓰기가 필요한 유일한 문서가 되쓸 수 없는 유일한 문서였다. **`flatten`을 이 커밋에 반드시 넣는다.**

바뀌는 것:

- `merger.rs::flatten`의 `Uuid::new_v4().hyphenated()` → `notes_core::new_yid()`.
- `merger.rs::recovery_sort_key`가 UUID 파싱을 잃는다. `sha2::Sha256::digest(id)`의 앞 6바이트를 big-endian u64로 읽어 48비트를 쓴다. `sha2`는 이미 `notes-sync`의 의존성이고 JavaScript가 정확히 담는 범위 안이며 같은 입력에 같은 답이라는 계약도 유지된다.
- `merger.rs::recovery_page`는 `Uuid::new_v5(vault_uuid, b"yonalist-recovery-page")`를 그대로 두고 결과 16바이트의 앞 9바이트를 `encode_yid`한다. `sync_meta.vault_uuid`는 노드 id가 아니므로 UUID로 남는다.
- `notes-core/src/tree.rs::derived_child_id`도 v5를 그대로 두고 앞 9바이트를 인코딩한다. namespace `7f9c2b14-…`와 이름 형식 `<부모 새 id>/<순번>`이 그대로라 결정성은 이미 있는 것을 다시 쓴다. 부모 id를 소문자화하던 것은 **없앤다** — UUID는 대소문자 무관이었지만 `yid`는 아니고, 소문자화하면 서로 다른 두 `yid`가 같은 자식 집합을 파생한다.
- `layout.rs::folder_suffix`가 `is_block_id`를 통과한 id를 그대로 접미사로 쓴다. 이미 12자다.
- `seed.rs`의 상수 일곱 개가 고정 `yid`가 된다. 고정이라 재시드가 idempotent하고 guide fixture와 새 vault가 같은 블록 정체성을 쓴다.
- `storeSupport.ts::freshId`가 `crypto.getRandomValues(new Uint8Array(9))`를 `btoa`한 뒤 `+`·`/`를 `-`·`_`로 바꾼다. 9바이트는 padding이 없어 그대로 12자다.
- `vault_watch.rs::PLACEHOLDER_NODE`가 12자 리터럴이 된다.
- `parse_leniency.rs::a_non_uuid_id_quarantines`는 계약이 뒤집혔으므로 `a_non_block_id_quarantines`로 다시 쓴다. UUID가 이제 거절되는 쪽이다.

**`two_devices.rs`**: `add_bullet`의 id 생성기와 복제 넷의 `new_id`가 `notes_core::new_yid()`로 바뀐다. 다섯 곳 다 **입력**이고 단정이 아니다. `two_devices.rs:419`의 `line.contains("yid:")`도 그대로 참이다. 28개가 `#[ignore]` 없이 통과한다.

**혼자 revert 가능**: 그렇다. 다만 항목 1·2를 되돌리지 않고 이것만 되돌리면 vault가 다시 UUID를 쓴다 — 개발 데이터 재설정이 다시 필요하다.

### 항목 5. 스펙이 코드를 따라간다

**여는 실패 test**: 없다. 이 항목만 예외다 — 동작을 바꾸지 않으므로 실패할 test가 없고, 검사는 사람이 §11의 골든 초안과 fixture 넷을 대조하는 것이다. 그 fixture는 항목 1·2·4가 이미 바이트로 잠갔다.

**만지는 파일**: `docs/v2/sync-spec.md`.

고쳐야 하는 절: §3.1 7단계(접미사는 문서 `yid` 전체), §4.1(id 규칙이 `yid`로, escape 규칙이 §2.6으로), §4.2(frontmatter 표에 `updated` 행을 더한다 — `9868bae3`이 이미 심었는데 스펙에 없다), §4.3(노드 주석은 `yid:` 하나이고 token 표가 footer 표로 옮겨 간다), §4.4(이미지 줄이 ya 주석을 잃는다), §4.5(split 줄), §4.6(trash), §5.1·§5.2·§5.3(footer 수용·격리·보존), §11(골든 넷과 §2의 id 표).

## 6. `yid` 변경의 파급 범위

### `notes_nodes.id`의 CHECK

**지금 없고 앞으로도 두지 않는다.** `schema.sql:9`는 `id TEXT PRIMARY KEY NOT NULL`이고 이 파일에서 id 모양을 검사하는 CHECK는 `notes_images.content_hash` 하나뿐이다.

두지 않는 이유가 셋이다. 모양 검사가 있어야 할 자리는 신뢰 경계인 `parse.rs`(파일 입력)와 `render.rs`(바이트가 vault로 나가기 전)이고 거기서 `is_block_id`가 답한다. CHECK는 그 답을 한 번 더 하면서 이름 있는 거절을 불투명한 제약 위반으로 바꾼다. 그리고 `seed.rs`의 test가 `'existing'`을, `merge_ingest.rs`가 UUID 리터럴을 직접 넣는다 — CHECK를 걸면 병합 규칙과 무관한 test가 줄줄이 깨진다.

따라서 **`schema.sql`은 한 글자도 고치지 않는다.** `MIGRATIONS`는 빈 배열, `user_version`은 1, `format_version`은 1이다.

### 개발자의 기존 vault와 DB

`matches_shipped_schema`는 `sqlite_master`의 `sql` 문자열을 비교한다. `schema.sql`을 고치지 않으므로 모양이 같고 `remake_if_an_older_build_made_it`은 발화하지 않는다. 기존 개발 DB는 UUID id를 든 채로 그대로 열린다.

그 상태의 증상은 이렇다. vault를 읽으면 `yid:`가 UUID라 `is_block_id`가 거절하고 모든 문서가 격리된다 — `notes://sync-status`에 이유가 뜬다. 방출하려면 `render`가 모든 문서를 거절하고 `export_pending`이 문서마다 오류를 삼키므로 아무것도 쓰이지 않는다. 읽는 쪽은 보이고 쓰는 쪽은 조용하다.

**재설정은 명시적이고 좁게 한다.** 앱을 닫고 개발 DB 세 파일(`notes-v2.sqlite`, `-wal`, `-shm`)과 vault 폴더를 지우고 다시 띄운다. 자동으로 해 주는 코드는 없고 넣지도 않는다 — 자동화하려면 `schema.sql`을 무의미하게 건드려 모양을 흐트러뜨려야 하고 그것은 없는 이유를 위한 변경이다. 항목 4의 커밋 메시지와 `sync-spec.md`가 이 절차를 적는다.

### UUID v5 파생은 남는다

남는다. namespace `7f9c2b14-5d63-4a08-9e21-3c6f0d8b4a52`, 이름 형식 `<부모 새 id>/<순번>`, 훑는 순서 전부 그대로다. 결과 16바이트의 앞 9바이트를 `encode_yid`하는 것이 유일한 변경이고 새 해시도 새 의존성도 필요 없다. `recovery_page`의 `Uuid::new_v5(vault_uuid, b"yonalist-recovery-page")`도 같다. `id.rs`는 `NodeId`의 기존 검증(빈 값·128바이트·제어문자)을 그대로 두고 `yid` 함수를 옆에 더한다 — `NodeId`를 좁히면 `root`와 test의 리터럴이 전부 걸린다.

### 폴더가 고아가 될 수 있는가

**그렇다.** 접미사가 "UUID 앞 12자 hex"에서 "yid 전체"로 바뀌므로 기존 vault의 `Projects-4f1c8e20a3b7`을 가리키는 것이 아무것도 없어진다. vault를 지우지 않고 남겨 두면 그 폴더의 `README.md`는 `id:`가 UUID라 격리되고, `retire_missing_documents`는 그것을 지우지 않는다 — `schema.sql:329-334`가 적은 대로 읽을 수 없는 파일은 이 앱의 문서가 아니고 그 폴더는 이 앱이 치울 것이 아니다. 그래서 고아 폴더는 손으로 지울 때까지 남는다. 대책은 위의 vault 삭제 하나다.

`home.md`의 split 링크 대상도 폴더 이름을 실으므로 재설정 뒤 첫 방출에서 새 이름으로 다시 쓰인다.

## 7. 위험과 미결 질문

| 위험 | 실패 모습 | 권하는 기본값 |
|---|---|---|
| **손으로 넣은 이미지 줄이 문서를 격리한다** | `- ![pic](assets/x.png)`을 사람이 타이핑하면 footer 항목이 없어 metadata가 없고 문서 전체가 거절된다 | 격리를 유지한다. 지금도 ya 주석 없는 이미지 줄은 같은 이유로 같은 답을 받는다(`read_image`의 "An image line has no metadata"). 관용을 지키는 유일한 방법은 `ya:`를 줄에 남기는 것이고 그것이 지우려는 소음이다. `notes_images`의 CHECK가 픽셀 0과 바이트 0을 거절하므로 기본값으로 받아들이는 길은 없다 |
| **`<`와 `&`가 여전히 엔티티다** | `a < b`가 `a &lt; b`로, `A&B`가 `A&amp;B`로 보인다 | 유지한다. `<`가 escape를 잃으면 사용자가 친 `<!--`가 주석 채널로 들어가고, `&`가 잃으면 사용자의 `&lt;`가 왕복에서 `<`로 무너진다. 규칙 하나 대 두 글자 앞 내다보기의 거래다 |
| **번호 행이 Markdown 서버에서 블릿으로 보인다** | 번호 목록이 `- `로 그려진다 | 유지한다(§3.1). 본문이 번호를 그리려면 `ordered_start >= 0`을 도메인에서 먼저 정해야 하고 A1이 요구하지 않는다 |
| **강조 문법을 담은 텍스트가 뷰어에서 꾸며진다** | 사용자가 친 `*강조*`가 Markdown 뷰어에서 기울어진다 | 받아들인다. 앱과 parser는 같은 바이트로 왕복하고 뷰어의 표시만 다르다. `*`·`_`·백틱까지 escape하면 `snake_case`와 곱셈 기호가 다시 백슬래시를 얻어 A1이 되돌아간다 |
| **`export_pending`이 render 오류를 문서마다 삼킨다** | 방출할 수 없는 문서가 조용히 방출되지 않는다 | 이 설계의 범위 밖이지만 항목 4의 실패 모드를 조용하게 만드는 기존 결함이다. 별 항목으로 올린다 |
| **`notes-export`가 자체 escape를 든다** | `crates/notes-export/src/markdown.rs:237`의 `escape_markdown`이 vault의 것과 갈라진다 | 그대로 둔다. 발행용 Markdown과 vault 포맷은 다른 계약이고 아무도 둘을 비교하지 않는다. 갈라짐을 문서로만 남긴다 |
| **footer가 잘려 나가면 원격 편집이 진다** | 전송 계층이 파일 끝을 자르면 모든 노드가 빈 스탬프가 되고 그 파일은 DB에 전부 진다 | 받아들인다. 줄마다 `t:`를 지웠을 때 지금 벌어지는 것과 같은 위험이고 방향도 안전한 쪽이다 — 잃는 것은 원격 변경의 도착이 아니라 한 번의 지연이고 다음 방출이 정규형을 되쓴다 |

### 이 빌드가 쓴 파일을 지금 main의 빌드가 읽을 수 있는가

**읽을 수 없다. 그리고 그것이 안전한 답이다.**

`format_version`이 1로 남으므로 버전으로는 걸러지지 않는다. 그런데 main의 `NodeReader::read`는 footer의 여는 줄 `<!-- yonalist`를 만나면 `read_node_line`이 `Ok(None)`을 답해 **"This line is not part of the grammar"**로 문서 전체를 격리한다. 항목 2 이후 모든 파일이 그렇다. 항목 4 이후에는 그 전에 `canonical_uuid`가 `` `Nd0000000001` is not a UUID. ``로 거절한다.

개발자가 보는 것은 vault 문서 전부가 이유 문장과 함께 격리된 상태이고 **격리는 파일을 덮지 않는다**. 즉 예전 빌드가 새 vault를 망가뜨리지는 않는다. 폐기된 v2 설계 §13이 걱정한 "예전 빌드가 파싱한 뒤 새 HLC를 찍어 되쓴다"는 이 포맷에서는 일어나지 않는다 — footer 여는 줄이 뜻하지 않게 버전 관문 노릇을 한다.

거꾸로도 사실이다. 이 빌드는 main이 쓴 파일을 읽지 못한다. 항목 2 이후 본문의 `t:`는 알 수 없는 token이 되어 `unknown_tokens`로 들어가고 스탬프가 비어 그 파일은 전부 DB에 진다. 항목 4 이후에는 UUID `yid:`가 거절된다. 개발 중 두 기기는 같은 빌드라는 전제가 이 설계의 전제이고 그 전제가 깨지는 자리의 대책은 개발자 규율과 vault 백업이다.

### 7.1 판정 — 계약이 바뀌는 test 둘

설계가 test 둘을 죽인다고 적었다. 판정은 M3에서 세운 것과 같은 경계다: **계약은 살리고 기제는 다시 쓴다.** 통과시키려고 단정을 무르게 하는 것만 금지고, 계약 자체가 뒤집힌 곳에서는 새 계약을 같은 강도로 잠근다. 지운 test는 돌아오지 않으므로 둘 다 지우지 않는다.

| test | 판정 | 새 본문이 잠그는 것 |
|---|---|---|
| `parse_leniency.rs::an_image_line_without_a_node_comment_is_accepted` | 이름과 본문을 다시 쓴다 | footer 항목이 없는 이미지 줄은 이유 문장과 함께 문서를 격리한다. 관용이 사라지는 것이 아니라 관용의 자리가 없어지는 것이다 — `read_image`가 지금도 `ya:` 없는 줄에 "An image line has no metadata"로 답하는 것을 직접 확인했고, `notes_images`의 CHECK가 픽셀 0과 바이트 0을 거절하므로 기본값으로 받을 길이 없다 |
| `parse_leniency.rs::a_non_uuid_id_quarantines` | `a_non_block_id_quarantines`로 다시 쓴다 | 이제 UUID가 거절되는 쪽이다. 거절한다는 계약은 그대로이고 무엇을 거절하는지가 뒤집혔다 |

두 커밋 메시지에 이름과 새 단정을 적는다.

항목 5는 여는 실패 test가 없는 유일한 항목이다. 문서만 고치므로 그것이 맞고, 검사는 fixture 넷과의 대조다 — 그 fixture는 항목 1·2·4가 바이트로 잠갔다.

### 남는 미결 질문

- **footer를 노드가 없는 문서에도 쓰는가.** 쓴다고 정했다(§4). 모양이 하나여서 분기가 없고, 빈 home 파일에 두 줄이 더 붙는 것이 대가다. 구현이 골든을 보고 다르게 판단하면 그때 정하면 되고 병합에는 무관하다.
- **`yid` 리터럴 값.** §2의 표는 이 문서가 정한 것이고 `19a6dcf3`의 fixture 값을 그대로 잇는다. 정규식만 만족하면 아무 값이나 되지만 골든이 그 값으로 잠기므로 한 번 정하면 바꾸지 않는다.
- **`recovery_sort_key`의 48비트.** `sha2` 앞 6바이트로 정했다. 계약은 결정성과 JavaScript 안전 범위 둘뿐이라 다른 결정적 함수도 맞지만 이미 있는 의존성을 다시 쓰는 것이 가장 짧다.
- **병합을 깨뜨리는 것을 찾았는가.** 찾지 못했다. `merger.rs`가 읽는 모든 값이 `DocumentNode`와 `PageDocument`에 그대로 남고 `content_of_file`·`content_of_row`·`LineState::content`의 필드와 구분자가 하나도 바뀌지 않으므로 digest도 그대로다. 유일하게 주의할 자리는 `extras_of`가 만드는 문자열이고, footer의 알 수 없는 token을 만난 순서대로 한 목록에 담으면 지금 값과 같다(§4). 이것이 어긋나면 같은 스탬프의 tie-break가 다르게 갈리므로 항목 2의 red 증거에 `extras`를 실은 문서 하나를 반드시 넣는다.
