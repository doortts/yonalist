# Notes 파일 SSOT 동기화 스펙 — 포맷 v1

2026-08-15 · 기준 코드 `main@4b84719b` · [구현 계획](../superpowers/plans/2026-08-15-notes-sync-port-implementation-plan.md) M0.1의 산출물

## 1. 지위

- 이 문서가 M1–M6 구현의 진실 소스다. 마일스톤·항목·게이트는 [구현 계획 §6](../superpowers/plans/2026-08-15-notes-sync-port-implementation-plan.md)이, 테스트 이름·경로는 [테스트 설계](../superpowers/plans/2026-08-15-notes-sync-port-test-design.md)가 소유한다. 여기서는 그 둘이 잠그는 **계약**만 적는다.
- [v1 스펙(2026-07-21)](../superpowers/plans/2026-07-21-notes-file-ssot-sync-implementation.md)과 v1 코드(`src-tauri/src/notes/`)는 동결 oracle이다. v1 스펙과 v1 코드가 어긋나는 곳은 코드가 이기고 §10에 기록했다.
- 문법(§3)은 이 절만 읽고 렌더러·파서를 바이트 단위로 재작성할 수 있게 쓴다.

## 2. 용어와 v2 대응

| 용어 | v1 | v2 |
|---|---|---|
| topic | `parent_id IS NULL`인 노드 | **고정 루트 행 `root`의 직계 자식** ([schema.rs:5](../../crates/notes-sqlite/src/schema.rs#L5), [queries.rs:29](../../crates/notes-sqlite/src/queries.rs#L29)의 pages 질의와 같은 집합) |
| topic 파일 | topic 하나당 vault 루트의 `*.md` 1개 | 동일. 파일 내용 = topic 노드(= 문서 루트) + 그 아래 서브트리 |
| 루트 행 `root` (Home) | 없음 | 파일로 나가지 않는다. 각 기기가 [ensure_root](../../crates/notes-sqlite/src/schema.rs#L11)로 따로 만들고 text·note·collapsed는 기기 로컬로 남는다 (§9-1) |
| 삭제 | `deleted_at` timestamp | `deleted` boolean. 삭제 행도 parent_id·sort_key를 유지한다 ([tree.rs:226-246](../../crates/notes-core/src/tree.rs#L226)) — trash의 `from:`은 이 행 값에서 파생 (§3.4) |
| purge | 휴지통 비우기 hard delete | `TreeMutation::Delete` 적용 ([command.rs:169](../../crates/notes-core/src/command.rs#L169), 실행 [mutations.rs:56-58](../../crates/notes-sqlite/src/mutations.rs#L56)). 결정 7 — §8 |
| 완료 | `completed_at` timestamp | `completed` boolean |
| marker | bullet·todo | bullet·todo·**ordered{start}** ([node.rs:17-26](../../crates/notes-core/src/node.rs#L17), `ordered_start` 컬럼 [schema.rs:108](../../crates/notes-sqlite/src/schema.rs#L108)) |
| 이미지 | 텍스트 노드의 before/attachment/after 분할 | 독립 노드 `kind=image`, text = 원본 파일명, `notes_images` 행 1개 ([node.rs:79-94](../../crates/notes-core/src/node.rs#L79), [image.rs:12-21](../../crates/notes-core/src/image.rs#L12)) |
| 자산 | vault `.yonalist/notes-assets/<sha256>.<ext>` | vault 쪽 동일(불변 규칙 7). 앱 로컬 캐시는 `app_data_dir/images/` 그대로 |
| archive / readonly / plugin | 있음 | 없음. 이 포맷에 자리가 없다 |

`sync_topics.topic_id` = topic 노드 id. trash.md는 루트 노드 없는 가상 topic이다. 복구 topic(사이클·고아 수용처)은 v1 스펙 §4.2 규칙 그대로 — `uuid v5(namespace=vault_uuid, name="yonalist-recovery-topic")`인 topic을 lazy 생성하고 제목은 "복구됨"이다.

## 3. 포맷 v1 문법

### 3.1 공통 규칙

- 인코딩 UTF-8, 개행 LF. 파서는 CRLF·CR을 LF로 정규화한다 ([topic_parser.rs:54](../../src-tauri/src/notes/sync/topic_parser.rs#L54) 계승).
- **HLC**: 17자 고정폭 `mmmmmmmmm-cc-dddd` — millis base36 소문자 9자 zero-pad, counter base36 2자, device 소문자 hex 4자. decode는 재인코딩 일치까지 요구한다(비정규형 거부, [hlc.rs:43-65](../../src-tauri/src/notes/hlc.rs#L43)). 빈 문자열은 "없음"이며 사전순 비교에서 항상 진다.
- **UUID**: 파서는 대소문자 무관 수용, 파일 내 유일성 검사도 대소문자 무관 ([topic_parser.rs:455-460](../../src-tauri/src/notes/sync/topic_parser.rs#L455)). 렌더러는 소문자 hyphenated 정규형만 쓴다 ([topic_file.rs:515-519](../../src-tauri/src/notes/sync/topic_file.rs#L515)).
- **이스케이프** (v1 함수 그대로 이식):
  - `escape_markdown` ([export.rs:257-272](../../src-tauri/src/notes/export.rs#L257)): `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`, 그 밖의 ASCII 문장부호는 `\` 접두. 노트의 줄 단위 규칙.
  - `escape_inline` ([export.rs:274-280](../../src-tauri/src/notes/export.rs#L274)): 개행 정규화 후 줄마다 `escape_markdown`, 줄들을 리터럴 `\n`으로 join. 제목 규칙.
  - 복원은 [topic_parser.rs:1204-1244](../../src-tauri/src/notes/sync/topic_parser.rs#L1204): 엔티티 3종 복원, `\`+문장부호 복원, inline에서만 `\n`→개행, 고아 `\`는 그대로.
- **percent 인코딩**(이미지 원본명): raw 허용 바이트는 영숫자와 `. _ ~`, 그 밖은 `%XX` 대문자 hex. 재인코딩 일치 검사로 정규형만 수용 ([markdown_import.rs:886-923](../../src-tauri/src/notes/markdown_import.rs#L886)). 디코드 결과는 1..=1024바이트, 공백뿐이면 거부 ([markdown_import.rs:875-884](../../src-tauri/src/notes/markdown_import.rs#L875)).
- **캡** (불변 규칙 8): 파일 16MiB ([markdown_import.rs:15](../../src-tauri/src/notes/markdown_import.rs#L15)), depth 128·노드 20,000 ([repository.rs:74-76](../../src-tauri/src/notes/repository.rs#L74)), 필드 100,000바이트 ([types.rs:41](../../src-tauri/src/notes/types.rs#L41)).
- **결정성**: 같은 DB 상태는 같은 바이트다. BTreeMap 또는 명시 정렬만, HashMap 순회 금지 (불변 규칙 3).
- `sort_key`는 topic frontmatter 한 곳 외에는 파일에 쓰지 않는다. 형제 순서 = 파일 줄 순서. 파서는 형제 순번으로 sort_key를 `ordinal * SORT_KEY_STEP`(v2 값 4,294,967,296, [node.rs:5](../../crates/notes-core/src/node.rs#L5))으로 재구성하고 병합이 실제 키를 정한다.

### 3.2 topic 파일

전체 형태 (부록 A가 규범 바이트):

```
---
<frontmatter — 아래 표 순서 그대로>
---
# <escape_inline(topic.text)>
<루트 note — depth-0 blockquote, 비면 블록 생략>
<빈 줄 1개 — 항상>
<노드 라인들>
```

**frontmatter** — 키는 아래 순서로 전부, 무조건 렌더한다. `키: 값` 한 줄씩, 콜론 뒤 공백 1개.

| # | 키 | 값 | 파스 기본값 | v2 근원 |
|---|---|---|---|---|
| 1 | `kind` | `yonalist-notes` | topic | — |
| 2 | `format_version` | `1` | 없거나 다르면 격리 | — |
| 3 | `id` | topic 노드 UUID | 없으면 격리 | `notes_nodes.id` |
| 4 | `sort_key` | i64 10진 | `0` | topic 노드의 sort_key (페이지 순서) |
| 5 | `max_hlc` | HLC 또는 빈 값 | `''` | 문서에 실린 모든 HLC의 최댓값 |
| 6 | `root_hlc` | HLC 또는 빈 값 | `''` | topic 노드의 hlc |
| 7 | `root_marker_kind` | `bullet`\|`todo`\|`ordered` | `bullet` | `marker` |
| 8 | `root_ordered_start` | i64 10진 | `1` | `ordered_start` |
| 9 | `root_collapsed` | `true`\|`false` | `false` | `collapsed` |
| 10 | `root_completed` | `true`\|`false` | `false` | `completed` |
| 11 | `root_starred` | `true`\|`false` | `false` | `starred` |
| — | (미지 키 보존분) | 원문 라인 | — | §4.2 — `root_starred` 뒤, 닫는 `---` 앞 |

boolean은 `true`/`false` 소문자만. 인정 스칼라 키의 중복은 격리다 ([topic_parser.rs:252](../../src-tauri/src/notes/sync/topic_parser.rs#L252) 계승). 빈 HLC는 `max_hlc: ` 처럼 빈 값으로 렌더하고 파스에서 `''`가 된다.

**루트 note**: 헤딩 직후 depth-0 blockquote. 줄마다 `> {escape_markdown(줄)}`, 빈 줄은 `>` 단독. note가 비면 블록을 생략한다. 블록(또는 헤딩) 뒤에 빈 줄 1개를 항상 렌더하고 파서는 빈 줄 없이 바로 bullet이 와도 수용한다 ([topic_parser.rs:2505](../../src-tauri/src/notes/sync/topic_parser.rs#L2505) 테스트 계승).

**노드 라인**: depth d의 들여쓰기는 공백 `2*d`개.

```
{들여쓰기}{프리픽스}{본문} {노드 주석}
```

프리픽스 (렌더 규칙 — 파스는 더 관대, §5):

| marker | completed | 프리픽스 |
|---|---|---|
| todo | false | `- [ ] ` |
| todo | true | `- [x] ` |
| bullet·ordered | 무엇이든 | `- ` |

**체크박스는 todo marker의 표기다.** 사용자가 체크박스로 만들지 않은 블릿은 완료 상태와 무관하게 그냥 블릿 텍스트로 나간다. 파일을 읽는 사람이 `- [x]`를 봤다면 그것은 언제나 체크한 할 일이지, 어쩌다 완료 플래그가 선 일반 블릿이 아니다.

`completed`는 marker와 독립된 값이라(`SetCompleted`에 marker 가드가 없고 [command_execution.rs:467](../../crates/notes-core/src/tree/command_execution.rs#L467)이 클릭된 노드에 무조건 세운다) todo가 아닌 노드도 완료일 수 있다. 그 상태는 프리픽스 대신 §3.2 주석의 `done` 토큰이 싣는다.

본문: 텍스트 노드는 `escape_inline(text)`. 이미지 노드는 §3.3의 이미지 atom.

**노드 주석** — 본문 뒤 공백 1개, `<!--`와 `-->` 사이 토큰들을 공백 1개로 구분. 토큰 순서는 아래 고정이고 각 토큰은 조건이 맞을 때만 나온다.

| 순서 | 토큰 | 조건 | 값 |
|---|---|---|---|
| 1 | `yid: <uuid>` | 항상 | 노드 id 소문자 정규형 |
| 2 | `t: <hlc>` | 항상 | 노드 hlc. 렌더에는 비어 있으면 오류(스탬프 전 노드는 나가지 않는다) |
| 3 | `star` | starred | — |
| 4 | `todo` 또는 `ordered: <i64>` | marker가 todo / ordered | ordered 값 = ordered_start |
| 4.5 | `done` | completed이면서 marker가 todo가 아닐 때 | — (todo의 완료는 `- [x]` 프리픽스가 싣는다) |
| 5 | `from: <parent>@<i64>` | trash.md 전용 렌더 (§3.4) | parent = UUID 또는 리터럴 `root`, 값 = sort_key |
| 6 | `collapsed` | collapsed | — |
| 7 | (미지 토큰 보존분) | §4.2 | 원문 그대로 |

같은 인정 토큰의 중복은 격리 ([topic_parser.rs:612-763](../../src-tauri/src/notes/sync/topic_parser.rs#L612)의 seen 검사 계승). 파서는 `collapsed: true|false` 변형도 수용하되 렌더는 bare `collapsed`만 쓴다.

**노드 note**: bullet 라인 다음 줄부터 `{공백 2*(d+1)}> …` blockquote, 루트 note와 같은 줄 규칙.

### 3.3 이미지 라인

이미지 노드는 자기 bullet 한 줄이 전부다. v1의 before/after 분할은 이 포맷에 없다.

```
{들여쓰기}{프리픽스}![Image](.yonalist/notes-assets/<hash>.<ext>) <!-- ya: name: <pct> w: <u32> px: <u32>x<u32> bytes: <u64> --> <!-- yid: … t: … -->
```

- 링크 정규형: `.yonalist/notes-assets/` 접두 + 소문자 hex 64자 hash + `.` + 확장자 `png|jpg|webp|gif`. 경로에 `/ \ ? #` 추가 금지, 대문자 hash·`jpeg` 거부 ([topic_parser.rs:1165-1183](../../src-tauri/src/notes/sync/topic_parser.rs#L1165), [topic_file.rs:583-596](../../src-tauri/src/notes/sync/topic_file.rs#L583)). 확장자는 mime과 1:1이다 ([image.rs:157-165](../../crates/notes-core/src/image.rs#L157)).
- `ya:` 주석 토큰 — 순서 고정 `name`, `w`, `px`, `bytes`:

| 토큰 | 값 | v2 근원 |
|---|---|---|
| `name:` | percent 정규형 원본명 (§3.1) | `original_name` |
| `w:` | display_width, 정수 ≥ 120 ([image.rs:9](../../crates/notes-core/src/image.rs#L9)) | `display_width` |
| `px:` | `<pixel_width>x<pixel_height>`, 각각 > 0, 곱 ≤ 40,000,000 | `pixel_width`·`pixel_height` |
| `bytes:` | byte_length, 1..=20,971,520 | `byte_length` |

- `px:`·`bytes:`는 이 포맷의 신설 토큰이다. 자산 바이트가 아직 도착하지 않은 상태에서도 `NoteImage::try_referenced` ([image.rs:90-114](../../crates/notes-core/src/image.rs#L90))로 행을 만들 수 있게 한다. 정식 렌더는 네 토큰을 전부 쓴다.
- ya 주석 뒤 공백 1개, 그다음 노드 주석. ya 주석은 노드 주석으로 오인하지 않는다(`ya:` 접두 판별, [topic_parser.rs:585-587](../../src-tauri/src/notes/sync/topic_parser.rs#L585) 계승).
- **미해소 이미지 노드**: `w: -`(v4 파일)이거나 `px:`·`bytes:`가 없거나 자산이 아직 없으면 노드는 placeholder로 적용하고 다음 export는 파스한 이미지 라인을 **원문 그대로** 재방출한다. 자산이 도착하면 정식 `notes_images` 행으로 해소하고 그때부터 정규형으로 렌더한다. 해소 시 display_width가 없으면 `clamp(pixel_width, 120, 640)`으로 정한다 — v2 코드에 기존 기본값이 없어 이 스펙이 정한 값이다 (§9-5).
- 이미지 노드도 note와 자식을 가질 수 있다. 그 밖의 자리(`- ` 본문이 아닌 곳)의 `![`는 격리다.

### 3.4 trash.md와 purge tombstone

```
---
kind: yonalist-trash
format_version: 1
max_hlc: <hlc>
purged: <uuid> <hlc>        ← 0개 이상. (id, hlc) 튜플 정규화 후 오름차순 정렬
---
- Deleted <!-- yid: … t: … from: <parent>@<sort_key> -->
  - Child <!-- yid: … t: … done -->
```

- **trash 루트** = `deleted = 1`이고 부모가 살아 있거나 없는 노드. v2는 삭제 행이 parent_id·sort_key를 유지하므로 ([tree.rs:226-233](../../crates/notes-core/src/tree.rs#L226)) `from:`은 행 자체에서 파생한다 — v1이 exporter에서 하던 그대로다 ([exporter.rs:2018-2020](../../src-tauri/src/notes/sync/exporter.rs#L2018)). `from:`의 parent는 UUID이거나, 삭제된 노드가 topic이었으면 리터럴 `root`다.
- trash 루트 아래 자식들은 `from:` 없이 서브트리 그대로 나온다. 루트 정렬은 `(sort_key, id)` 오름차순, 자식은 형제 정렬 그대로.
- **purge tombstone**: `purged: <uuid> <hlc>` frontmatter 라인. 렌더는 정규화(uuid 소문자, hlc 정규형) 후 정렬한다 ([topic_file.rs:245-259](../../src-tauri/src/notes/sync/topic_file.rs#L245)). hlc 없는 tombstone은 렌더 오류다.
- **tombstone의 유일한 발생지 (결정 7)**: 워커가 명령 패치의 `TreeMutation::Delete`를 적용할 때다 — 오늘의 생산자는 `RemoveEmptyNode`의 forward와 노드 생성 명령들의 undo 역패치다 ([tree.rs:328-331](../../crates/notes-core/src/tree.rs#L328)). 적용 시 fresh HLC로 `sync_purged_tombstones`에 upsert하고 다음 trash.md export가 `purged:` 라인으로 내보낸다. **병합이 원격 tombstone을 적용할 때는 원격 hlc 그대로 기록하고 새 tombstone을 만들지 않는다.** 그 밖의 어떤 경로도 tombstone을 만들지 않는다.
- 병합 의미: tombstone hlc보다 오래된 노드만 지운다. 그보다 새 노드는 산다(부활 경로, 불변 규칙 1). undo-of-create가 남긴 tombstone도 같은 규칙 덕에 redo를 죽이지 못한다 — redo의 재삽입은 fresh HLC를 받는다.
- topic 자체가 삭제되면 trash.md가 먼저 그 서브트리를 실은 뒤에야 topic 파일을 지운다 (v1 순서 계승, [exporter.rs:3884](../../src-tauri/src/notes/sync/exporter.rs#L3884) 테스트).
- tombstone은 90일 뒤 GC한다 ([mod.rs:62](../../src-tauri/src/notes/sync/mod.rs#L62)). 창을 넘긴 스냅샷 정책은 §7-1.

### 3.5 파일명

`{slug}.{topic_id 앞 8 hex}.md`. slug 규칙과 40자 절단은 v1 [derive_topic_filename](../../src-tauri/src/notes/sync/topic_file.rs#L302) 그대로. 파일명은 코스메틱이고 identity는 frontmatter `id`다. 생성 후 rename하지 않는다 (v1 스펙 §4.2).

## 4. 미지 필드 보존 — 결정적 위치·순서

파서는 자기가 의미를 갖지 않는 조각을 원문 그대로 실어 나른다. 앞으로 포맷이 늘어날 때 먼저 만들어진 파일이 값을 잃지 않게 하는 장치다. 저장처는 `notes_nodes.sync_extras`(topic frontmatter 몫은 topic 노드 행)이고 정확한 컬럼 인코딩은 M2 구현 소유다. 파일 쪽 계약만 고정한다:

| 조각 | 보존 단위 | 재방출 위치 | 순서 |
|---|---|---|---|
| frontmatter 미지 키 | `키: 값` 라인 전체 | 마지막 인정 키(`root_starred`) 뒤, 닫는 `---` 앞 | 만난 순서 |
| 노드 주석 미지 토큰 | 인정 토큰이 아닌 연속 토큰 run 통째 (예: `plugin: github-notification notification_key: …` 전체) | 인정 토큰 전부 뒤, ` -->` 앞 | 만난 순서 |
| ya 주석 미지 토큰 | 동일 | 인정 토큰(`bytes:`) 뒤, ` -->` 앞 | 만난 순서 |

- 같은 상태를 두 번 렌더하면 보존분 포함 바이트가 같다. 보존은 바이트가 아니라 정보를 지키는 것이라, 재방출은 언제나 정규형이다 (테스트 설계 §5.3).
- trash.md frontmatter의 미지 키는 실을 노드 행이 없어 보존하지 않는다. 손으로 넣은 키는 다음 렌더에서 사라진다.

## 5. 관대함과 격리

v1 §7.3 계승 + 개정. **격리는 문서 전체 거부다. 절반만 적용된 결과가 존재하면 그 자체가 결함이다** (테스트 설계 §5.2).

**수용** (행마다 테스트 1개, 테스트 설계 §5.1):

| 입력 | 처리 |
|---|---|
| yid 없는 bullet | 수용. id/hlc 없음으로 통과 — 발급은 병합 몫, write-back으로 역기록 (불변 규칙 2 단서) |
| `t:` 없음 또는 hlc 파싱 불가 | `''` → LWW에서 항상 패배 ([topic_parser.rs:1722-1728](../../src-tauri/src/notes/sync/topic_parser.rs#L1722) 계승) |
| 홀수 칸·탭 들여쓰기 | 2칸 내림 정규화, 탭 = 2칸. 예상보다 깊은 bullet은 가장 가까운 depth로 clamp |
| checkbox 없는 `- text` | marker = bullet, completed = false. **체크박스가 없으면 할 일이 아니라 그냥 블릿이다** (§3.2) |
| `- [ ] text` · `- [x] text` | marker = todo, completed는 표시대로 |
| frontmatter 선택 키 누락 | §3.2 기본값. 격리는 `id`·`format_version`뿐 — v1 코드의 root_collapsed·root_readonly 필수화([topic_parser.rs:163-168](../../src-tauri/src/notes/sync/topic_parser.rs#L163))는 계승하지 않는다 (§10-3) |
| 미지 frontmatter 키·주석 토큰 | **보존** (§4.2 — v4의 "무시"에서 변경) |
| CRLF | LF 정규화 |
| 공백뿐인 본문 줄 | 빈 줄 취급 |

**격리** (통지는 `notes://sync-status`, `sync_topics.quarantined = 1`, 병합 skip):

| 입력 | 비고 |
|---|---|
| `format_version`이 `1`이 아니거나 없다 | 아는 포맷은 하나뿐이다. 미래 버전 보호를 겸한다 |
| topic의 `id` 누락·비 UUID | |
| UTF-8 아님 / 16MiB 초과 | |
| depth > 128 / 노드 > 20,000 / 필드 100,000바이트 초과 | |
| `<<<<<<<` 또는 `>>>>>>>`로 시작하는 라인 | git 충돌 마커 — 결정 1의 "git 미보증"이 안전한 이유 (테스트 설계 §5.2) |
| 인정 스칼라 키 중복, 인정 토큰 중복, 파일 내 yid 중복(대소문자 무관), topic id와 노드 id 충돌 | |
| 비정규 자산 링크 (경로 탈출·대문자 hash·`jpeg`·ya `name`/`w` 자체 누락) | 불변 규칙 7 |
| kind 비호환 키 (topic에 `purged:`, trash에 `id:` 등) | |
| 소화되지 않는 본문 줄 (bullet도 note도 연속행도 아님) | |
| `purged:` 구조 파손 (uuid 아님, 필드 수 불일치) | hlc만 malformed면 `''`로 수용 ([topic_parser.rs:2059-2075](../../src-tauri/src/notes/sync/topic_parser.rs#L2059) 계승) |

## 6. 불변 규칙

v1 스펙 §1의 10건을 그대로 계승한다. v2 좌표로 다시 적으면:

1. **부재 ≠ 삭제.** 파일에 없는 노드는 지우지 않는다. 삭제 증거는 (a) trash.md 이동(LWW), (b) purge tombstone 둘뿐이다.
2. **병합은 멱등·교환적.** canonical(yid/HLC 기록) 문서 기준. yid 없는 입력은 전달마다 신규 발급이고 write-back 후부터 멱등이 적용된다. LWW 비교는 HLC 문자열 사전순.
3. **직렬화는 결정적.** 같은 상태 → 같은 바이트. 보존분(§4.2)도 포함해서다.
4. **export 자가 검증.** 쓴 바이트를 재파싱해 상태와 다르면 파일을 덮지 않고 dirty 유지.
5. **원자적 쓰기만.** 모든 vault 쓰기는 notes-sync `file_io::write_atomic_file` 경유.
6. **병합이 적용하는 원격 hlc는 원격 값 그대로.** 스탬핑 트리거의 WHEN 가드가 보장한다 ([구현 계획 §5.1](../superpowers/plans/2026-08-15-notes-sync-port-implementation-plan.md)). 유일한 예외가 §7-2의 드리프트 재스탬프다.
7. **asset 링크는 정규형만.** 경로 탈출 즉시 거부.
8. **기존 캡 유지.** §3.1의 값들.
9. **budget·테스트 규칙 준수.** 저장소 관례(`toHaveBeenNthCalledWith` 금지 등) 그대로.
10. **undo 오염 금지.** 병합·부트스트랩은 history 없이 실행 — 원격 변경은 undo 스택에 들어가지 않는다.

시작 조정 4분기(v1 §9.4)와 §12 매트릭스도 그대로 계승한다 — 재색인은 `file_mtime_ms + file_size` 게이트 통과분만 해시 확인한다 ([구현 계획 §6 M5.3](../superpowers/plans/2026-08-15-notes-sync-port-implementation-plan.md), 테스트 설계 §9.1).

**v2 개정 3건**:

- **A. 병합은 워커 큐를 지난다.** `Request::MergeTopic` 하나가 IMMEDIATE 트랜잭션으로 병합 전체를 실행하고 **적용된 변경이 있을 때만** `notes_meta.revision`을 정확히 1 올린다. no-op 병합은 revision을 올리지 않는다(멱등의 관찰면). 같은 DB 파일에 딴 Connection을 여는 우회는 금지 — 낡은 revision의 commit이 성공해 버리는 것으로 탐지한다 ([구현 계획 §4.2](../superpowers/plans/2026-08-15-notes-sync-port-implementation-plan.md), 테스트 설계 §6.2).
- **B. undo 배리어.** 병합은 `NotesService::absorb_external`을 지나 서비스 revision 사본을 갱신한다. 병합이 바꾼 노드 집합과 교차하는 undo 항목 위로 `undo_floor`를 올린다 — 교차 지점 아래로 undo가 내려가지 못하고, 교차하지 않는 위쪽 항목은 전부 되돌아간다. redo 스택은 교차 발생 시 전체 비운다 ([구현 계획 §4.3](../superpowers/plans/2026-08-15-notes-sync-port-implementation-plan.md), 테스트 설계 §7).
- **C. 이벤트 계약.** 이 앱 최초의 Tauri 이벤트 2종, 페이로드는 camelCase wire다: `notes://sync-changed { revision, changedNodeIds, deletedNodeIds }` — 병합이 상태를 바꿨을 때. `notes://sync-status` — 격리·오류·상태 전이. 프런트 반영 방식은 [구현 계획 §4.5](../superpowers/plans/2026-08-15-notes-sync-port-implementation-plan.md)가 소유한다 (테스트 설계 §8.6).

## 7. 리스크 정책 4건

| # | 정책 | 계약 |
|---|---|---|
| 1 | **90일 창 초과 스냅샷 격리.** 기기별 마지막 병합 HLC를 `sync_meta`에 기록한다. 들어온 문서의 증거가 그보다 90일([mod.rs:62](../../src-tauri/src/notes/sync/mod.rs#L62)) 넘게 오래됐으면 자동 병합하지 않고 격리 후 `notes://sync-status`로 사용자 확인을 받는다. tombstone GC가 이미 지운 증거를 스냅샷이 되살리는 사고(결정 4)를 막는다 | 테스트 설계 §10.2 |
| 2 | **미래 HLC 재스탬프.** 로컬 시계보다 24시간 넘게 미래인 원격 HLC는 fresh HLC로 재스탬프해 적용하고 로그를 남긴다. 시계가 튄 기기의 편집이 이후 모든 정상 편집을 영구히 이기는 경로를 닫는다. 불변 규칙 6의 명시적 예외다 | 테스트 설계 §6.1·§10.2 |
| 3 | **transport 겹침 미지원.** 같은 vault를 두 동기화 클라이언트가 만지는 구성은 지원하지 않는다고 문서화하고(§8 결정 1의 사용자 문구와 같은 자리) 감지 가능할 때 — 예: 한 파일에 `.sync-conflict-*`와 `(conflicted copy)`가 함께 보일 때 — `notes://sync-status`로 경고한다 | — |
| 4 | **conflicted copy는 입력이다.** `* (conflicted copy)*.md`·`* 2.md`·`.sync-conflict-*` 사본이 우리 포맷으로 파싱되면 병합하고 canonical 파일을 다시 쓴 뒤 사본을 held-identity no-replace 이동으로 `.yonalist/sync-cleanup/consumed/`에 은퇴시킨다. v1의 격리 보존([watcher.rs:891](../../src-tauri/src/notes/sync/watcher.rs#L891)의 retire 메커니즘)을 병합 승격으로 올린 것이다 | 테스트 설계 §8.4·§10.2 |

## 8. 결정 기록 (1–9)

[구현 계획 §0](../superpowers/plans/2026-08-15-notes-sync-port-implementation-plan.md)에서 사용자가 확정했다. 재론 금지.

| # | 결정 | 이 스펙에서의 자리 |
|---|---|---|
| 1 | 클라우드 폴더 동기화 공식 지원, git은 "동작하지만 미보증" | 사용자 문구는 **설정 화면 vault 절(M1.6)의 보조 텍스트**에 넣는다. 고정 문안: "vault 폴더는 iCloud Drive, Dropbox, Syncthing, OneDrive 같은 폴더 동기화 서비스에 두는 것을 지원합니다. git 저장소에 둬도 동작하지만 보증하지 않으며 충돌 마커가 든 파일은 안전하게 격리됩니다." 격리 근거는 §5의 충돌 마커 행 |
| 2 | 같은 노드 동시 편집 = LWW + conflict log | §6 규칙 2, 복구는 결정 5 |
| 3 | collapsed는 파일에 기록, 기기 간 공유 | §3.2 `root_collapsed`·`collapsed` 토큰 |
| 4 | tombstone 90일 + 초과 스냅샷 격리 | §3.4, §7-1 |
| 5 | 충돌 노출 = 설정 화면 목록 + 복구 버튼, 인라인 배지 없음 | 복구 = 패자를 새 편집으로 재적용(LWW 전파). 보존 상한은 결정 8 |
| 6 | ~~v1/v4 vault 관대 수용~~ — 취소(결정 15). 포맷은 `1`에서 시작하고 아는 버전은 그것뿐이다. 미지 필드 보존은 앞으로를 위해 유지 | §3, §4, §5 |
| 7 | purge = v2의 hard delete 경로가 tombstone을 남기는 유일한 곳 | §3.4. 계획의 표기 `NotesCommand::Delete`는 코드에 없다 — 실체는 `TreeMutation::Delete` ([command.rs:169](../../crates/notes-core/src/command.rs#L169))이고 이 스펙은 그 이름으로 못 박는다. 휴지통 비우기 UI는 범위 밖 |
| 8 | conflict log 보존 상한 1,000건 또는 180일 중 먼저 | 테스트 설계 §6.3 |
| 9 | M6 수동 증거에 실 transport 1회 포함 | 구현 계획 §6 M6 |

## 9. 이 스펙이 새로 정한 것 — 사용자 확인 대상

계획이 정하지 않아 여기서 확정한 문법·의미 결정. M0 적대적 리뷰의 검토 목록이다.

1. **topic = `root`의 직계 자식** (§2). 루트 행(Home)의 text·note·collapsed는 동기화되지 않는다 — Home의 note를 쓰는 사용자는 기기 간 불일치를 본다. 필요해지면 예약 파일(home.md)로 후속.
3. **ya 메타 확장** `px:`·`bytes:` 신설, `w:`는 정수 필수(렌더) (§3.3).
5. **미해소 이미지 라인의 원문 재방출과 해소 기본값** (§3.3) — placeholder 상태에서도 결정성과 무손실을 지키고 display_width가 없는 이미지는 자산 도착 시 `clamp(pixel_width, 120, 640)`으로 정한다. 하한 120은 [image.rs:9](../../crates/notes-core/src/image.rs#L9), 상한 640은 지어낸 값이다.
6. **trash `from:`의 리터럴 `root` 허용** (§3.4) — v2에서 topic의 부모가 NULL이 아니라 `root`라서 생긴 자리.
8. **보존분 재방출 위치** — frontmatter는 인정 키 뒤·`---` 앞, 주석은 인정 토큰 뒤·` -->` 앞, 만난 순서 (§4.2). trash frontmatter 미지 키는 보존하지 않는다.
9. **이미지 topic 루트는 문법 밖** — `root` 직계의 `kind=image` 행은 topic 파일로 낼 수 없다. exporter는 그 topic을 export 격리하고 `notes://sync-status`로 알린다. 오늘 UI가 만들 수 없는 상태라 문법을 넓히지 않았다.
10. **trash 루트 정렬 (sort_key, id) 오름차순** (§3.4).
11. **프리픽스 규칙** — 체크박스는 todo marker 전용이다. todo가 아닌 노드는 완료여도 `- `로 나가고 완료 상태는 `done` 토큰이 싣는다 (§3.2). 번호 렌더는 UI 몫이라 ordered도 파일에서는 `- `다. 
12. **id는 UUID만** — [freshId()](../../apps/desktop/src/store/storeSupport.ts#L19)의 비 UUID 폴백(`note-<ts>-<rand>`)이 실제로 발급되면 그 노드는 export 불가다. 폴백 수리는 이 이식 밖의 결함으로 별도 처리한다.
13. **tombstone 생산자에 undo 역패치 포함** (§3.4) — `TreeMutation::Delete`는 전부 purge다. 생성 명령의 undo가 남긴 tombstone은 "새 노드가 이긴다" 규칙 덕에 무해하다.

**기재만 하는 요구사항 (이 이식이 구현하지 않음, [구현 계획 §8](../superpowers/plans/2026-08-15-notes-sync-port-implementation-plan.md))**: yid 재대응 — 주석을 잃은 손편집 bullet을 텍스트·위치 근접으로 기존 id에 다시 잇는 것. 지금은 신규 발급 + 원본 잔존(중복 발생)이 명세된 동작이다.

## 10. 문서 ↔ 코드 불일치 기록 (코드 우선)

| # | v1 스펙 | v1 코드 | 이 포맷의 처분 |
|---|---|---|---|
| 1 | §7.1 `format_version: 2` 키 셋 | `TOPIC_FORMAT_VERSION = 4` + root_marker_kind·root_collapsed·root_readonly·root_markdown_image_width·plugin 일가 ([topic_file.rs:11](../../src-tauri/src/notes/sync/topic_file.rs#L11), [:140-197](../../src-tauri/src/notes/sync/topic_file.rs#L140)) | v1 실물 문법을 참고했을 뿐, 호환은 목표가 아니다 |
| 2 | §7.3 "`format_version > 2` 격리" | 수용창 3..=4, 2와 누락도 격리 ([topic_parser.rs:98-103](../../src-tauri/src/notes/sync/topic_parser.rs#L98)) | 계승하지 않는다 — 아는 버전은 `1` 하나다 |
| 3 | §7.3 "키 누락 → 기본값, id만 격리" | 일반 topic에서 root_collapsed·root_readonly 누락을 격리 ([topic_parser.rs:163-168](../../src-tauri/src/notes/sync/topic_parser.rs#L163)) | 스펙 방향(기본값)으로 되돌린다 — 두 키가 사라지거나 선택이 됐다 |
| 4 | §7.1 "collapsed는 파일에 쓰지 않는다" | v3부터 collapsed 렌더 ([topic_file.rs:431-433](../../src-tauri/src/notes/sync/topic_file.rs#L431)) | 결정 3이 코드 손을 들었다 — 이 포맷도 기록한다 |
| 5 | 계획 §0 결정 7 "`NotesCommand::Delete`" | `NotesCommand`에 Delete 없음. hard delete는 `TreeMutation::Delete` ([command.rs:169](../../crates/notes-core/src/command.rs#L169), [mutations.rs:56-58](../../crates/notes-sqlite/src/mutations.rs#L56)) | §8 결정 7에 실명으로 고정 |

## 부록 — golden 초안

아래 세 블록이 M2가 `crates/notes-sync/fixtures/`로 커밋할 fixture의 규범 바이트다 (테스트 설계 §4). 코드 펜스 안 내용이 전부이고 각 파일은 마지막 줄 뒤 개행 1개로 끝난다. 값은 전부 지어냈으되 고정이다:

| 용도 | 값 |
|---|---|
| device (기기 1 / 기기 2) | `a3f2` / `b7c1` |
| HLC millis 접두 | `0swkd7qz2` … `0swkd7qzb` (base36 9자, 끝자리만 증가) |
| topic id (A / B) | `11111111-1111-4111-8111-111111111111` / `aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa` |
| 노드 id | 부록 본문의 yid 그대로 |
| 자산 hash | `a` 64개 (png) / `b` 64개 (webp) |
| sort_key | `4294967296`(STEP), `8589934592`(2×STEP) |

### A. `topic_golden.md`

```
---
kind: yonalist-notes
format_version: 1
id: 11111111-1111-4111-8111-111111111111
sort_key: 4294967296
max_hlc: 0swkd7qz7-00-a3f2
root_hlc: 0swkd7qz2-00-a3f2
root_marker_kind: bullet
root_ordered_start: 1
root_collapsed: false
root_completed: true
root_starred: true
---
# Groceries &amp; Supplies
> Weekly staples
>
> and &amp; treats

- Milk &amp; bread <!-- yid: 22222222-2222-4222-8222-222222222222 t: 0swkd7qz4-00-a3f2 star -->
  > first note
  >
  > second &gt; line
- [ ] Call Anna <!-- yid: 33333333-3333-4333-8333-333333333333 t: 0swkd7qz5-00-a3f2 todo -->
  - Child <!-- yid: 44444444-4444-4444-8444-444444444444 t: 0swkd7qz6-00-a3f2 done collapsed -->
- Steps <!-- yid: 55555555-5555-4555-8555-555555555555 t: 0swkd7qz7-00-a3f2 ordered: 3 -->
```

덮는 계약: 전 frontmatter 키, 루트 note 블록, star, 미완료 todo(`- [ ]` + `todo`), 완료된 일반 블릿(`- ` + `done`), collapsed, ordered, 자식 들여쓰기, 노트 이스케이프.

### B. `topic_images_golden.md`

```
---
kind: yonalist-notes
format_version: 1
id: aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa
sort_key: 8589934592
max_hlc: 0swkd7qz5-00-b7c1
root_hlc: 0swkd7qz2-00-b7c1
root_marker_kind: bullet
root_ordered_start: 1
root_collapsed: false
root_completed: false
root_starred: false
---
# Trip Photos

- Day one <!-- yid: bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb t: 0swkd7qz3-00-b7c1 -->
  - ![Image](.yonalist/notes-assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png) <!-- ya: name: photo%20one.png w: 320 px: 1280x960 bytes: 48213 --> <!-- yid: cccccccc-3333-4ccc-8ccc-cccccccccccc t: 0swkd7qz4-00-b7c1 -->
    > taken at the harbor
- ![Image](.yonalist/notes-assets/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp) <!-- ya: name: diagram.webp w: 480 px: 800x600 bytes: 10240 --> <!-- yid: dddddddd-4444-4ddd-8ddd-dddddddddddd t: 0swkd7qz5-00-b7c1 -->
```

덮는 계약: 빈 루트 note(헤딩 뒤 빈 줄 1개), 자식 이미지 노드, 이미지 노드의 note, 최상위 이미지 노드, ya 4토큰 순서, percent 인코딩, png·webp 확장자.

### C. `trash_golden.md`

```
---
kind: yonalist-trash
format_version: 1
max_hlc: 0swkd7qzb-00-a3f2
purged: 66666666-6666-4666-8666-666666666666 0swkd7qz7-00-a3f2
purged: 77777777-7777-4777-8777-777777777777 0swkd7qz8-00-a3f2
---
- Old page <!-- yid: eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee t: 0swkd7qz9-00-a3f2 from: root@4294967296 -->
- Deleted <!-- yid: 88888888-8888-4888-8888-888888888888 t: 0swkd7qza-00-a3f2 from: 99999999-9999-4999-8999-999999999999@8589934592 -->
  - Child <!-- yid: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa t: 0swkd7qzb-00-a3f2 done -->
```

덮는 계약: purged 정렬, 삭제된 topic의 `from: root@…`, 일반 trash 루트의 `from: <uuid>@<sort_key>`, from 없는 자식, trash 루트 (sort_key, id) 정렬(4294967296 < 8589934592).
