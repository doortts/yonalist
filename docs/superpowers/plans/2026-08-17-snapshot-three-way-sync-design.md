# 읽기 좋은 Markdown과 스냅샷 3-way 동기화 설계

> **폐기 (2026-08-18).** 이 방향은 중단됐다. M1(포맷·yid)이 파일에서 HLC를 없애자
> `merger.rs`의 `decide`가 기존 모든 행에 `LocalWins`를 답해 원격 변경이 들어오지
> 못했고, 그 구멍을 메우려던 M3(3-way 병합)의 규모가 실제 이득에 비해 컸다. M1 두
> 커밋은 main에서 revert했고 main은 green이다.
>
> **살아 있는 요구는 A1 하나뿐이다** — 일반 Markdown 편집기에서 본문을 자연스럽게
> 읽고 고칠 수 있어야 한다. 후속 방향은 동작하는 HLC 최종 쓰기 승리 merge를 그대로
> 두고, merge가 파일에서 읽는 셋(줄마다 `t:`, 줄마다 `prev:`, frontmatter
> `max_hlc`/`root_*`)을 footer JSON의 `state[yid]`로 옮기는 것이다. 본문에는
> `<!-- yid: X -->` 하나만 남는다.
>
> 이 문서의 §5~§9(정규 snapshot, `state_hash`, base 결정표, 3-way 병합, 충돌 보존)는
> **구현 근거로 쓰지 않는다.** 3-way 구현은 브랜치 `claude/three-way-sync-handoff-7b9f01`에
> 남아 있고 main에 병합하지 않는다.

- 작성: 2026-08-17
- 상태: 구현 전 설계안, 최신 코드 재검증 완료
- 대상 정본: [`docs/v2/sync-spec.md`](../../v2/sync-spec.md)의 현재 개발 포맷
- 포맷 버전: 파일 `format_version: 1`, SQLite `user_version = 1` 유지

## 0. 결론

현재 개발 포맷을 제자리에서 바꾼다. 포맷 버전을 올리지 않고 파일·DB 마이그레이션도 만들지 않는다.

Markdown은 다시 사람이 읽고 고칠 수 있는 본문이 된다. 문서 자체를 식별하고 배치하는 기본 정보는 frontmatter에 둔다. 각 블릿에는 영구 식별자인 12자 base64url `yid`만 남긴다. 현재 줄마다 붙는 `t`, `prev`, 상태 토큰과 이미지 측정값은 제거한다. 접힘, 별표, 이미지 표시 폭, 자식 문서 표식, 동기화 계보처럼 Markdown 본문만으로 보존할 수 없는 값은 파일 맨 아래의 단일 `yonalist` 주석에 모은다.

동기화는 노드별 HLC 최종 쓰기 승리 방식에서 기준 스냅샷(base), 로컬(local), 파일(remote)의 3-way 병합으로 바꾼다. 서로 다른 블릿을 수정했거나 한쪽이 이동하고 다른 쪽이 본문을 수정한 경우 자동 병합한다. 같은 블릿의 같은 필드를 양쪽이 다르게 수정한 경우에는 어느 쪽도 버리지 않고 기존 복구 화면을 확장해 사용자가 해결한다.

첫 구현에서는 자체 서버, CRDT, Git 의존, 영구 Merkle 객체 저장소를 만들지 않는다. 문서 스냅샷과 SHA-256 해시는 기존 SQLite 경로에 저장하고 트리는 선형 시간으로 비교한다.

## 1. 최신 코드 재검증 결과

2026-08-17의 현재 `main`을 다시 따라가며 parser → merge → SQLite transaction → export → watcher 흐름을 확인했다. 설계의 핵심 방향은 여전히 유효하지만, 이전 문서의 포맷 v2 전환·마이그레이션 설계와 일부 병렬 장치는 제거해야 한다.

| 현재 코드 | 확인한 동작 | 이 설계의 결론 |
|---|---|---|
| `crates/notes-sync/src/render.rs` | `FORMAT_VERSION = 1`; frontmatter와 줄별 `yid/t/prev`·상태 토큰을 방출하고 문장부호를 과도하게 escape함 | 버전은 1로 두고 renderer를 새 문법으로 교체 |
| `crates/notes-sync/src/parse.rs` | 포맷 1만 허용하고 알려지지 않은 frontmatter를 보존함 | 기존 frontmatter 경계와 passthrough를 재사용하고 하단 metadata parser만 추가 |
| `crates/notes-sync/src/document.rs` | page/split/trash와 root 상태를 이미 구조화함 | 문서 기본 정보는 frontmatter, 나머지 상태는 하단 metadata로 직렬화 |
| `crates/notes-sqlite/src/schema.rs` | 개발 빌드는 스키마 모양이 다르면 DB·WAL·SHM을 자동 재생성하고, migration 배열은 비어 있음 | `schema.sql`을 제자리에서 고친다. DB migration과 버전 증가는 금지 |
| `crates/notes-sync/src/export.rs` | 마지막 방출 hash와 현재 파일 hash가 다르면 덮지 않고 merge를 요청함 | 이 사전 검사를 유지하되 검사와 rename 사이의 경쟁까지 막는 조건부 publish로 강화 |
| `crates/notes-sync/src/file_io.rs` | atomic write와 macOS `RENAME_EXCL` 기반 no-replace 이동이 있음 | 신규 파일에는 기존 `RENAME_EXCL`을 재사용하고, 기존 파일 교체에만 swap을 최소 추가 |
| `crates/notes-sync/src/watcher.rs` | byte hash echo 판정과 충돌 사본 이름 감지가 이미 있음 | 새 감지기를 만들지 않고 같은 판정 뒤 3-way merge로 연결 |
| `apps/desktop/src-tauri/src/vault_watch.rs` | 시작 시 vault 전체를 스캔하고 이후 파일 이벤트를 처리함 | 별도 초기 동기화 서비스 없이 기존 startup scan을 사용 |
| `crates/notes-sync/src/merger.rs` | HLC LWW, 위치 주장, 충돌 기록과 복구가 구현돼 있음 | 입출력 경계는 유지하고 핵심 판정만 B/L/R snapshot merge로 교체 |
| `crates/notes-sqlite/src/sync_merge.rs` | import transaction, 경로 재구축, revision bump, 충돌 보존을 한곳에서 담당함 | 새 transaction coordinator를 만들지 않고 이 경로를 확장 |
| onboarding seed와 vault setup | 사용자가 vault를 먼저 고른 뒤 guide 여부를 정하지만 현재 분류는 root `README.md`와 `.yonalist`만 확인함 | 하위 page가 먼저 도착한 기존 vault도 찾도록 분류를 보강하고 seed ID를 고정 yid로 교체 |
| `syncChanged.ts`, `notesStore.ts` | 삭제→복원을 changed로 합치고 원격 삭제된 줄의 draft를 reload 전에 취소하지만, 미저장 입력 자체는 버림 | event coalescing은 유지하고 draft를 충돌 복구 저장소에 영속한 뒤에만 취소 |
| `notes_images`, attachment 처리 | 자산은 전체 content hash로 식별하고, bytes가 늦게 와도 이미지 row를 먼저 적용함 | `asset_hash`, 표시 폭, pixel·byte 크기를 하단에 보존해 placeholder도 복구 |
| trash export | 복원된 노드가 있으면 trash도 재방출하고, 앱이 쓴 hash와 같을 때만 빈 trash 파일을 지움 | 이 삭제 안전 규칙을 그대로 유지 |
| Settings 복구 화면 | 덮인 노트 후보를 보고 복원할 수 있음 | 별도 충돌 앱을 만들지 않고 같은 화면과 repository를 확장 |

따라서 이전 설계에서 다음은 폐기한다.

- `format_version: 2`, `format.json`, bridge release, 기기별 cutover ack
- UUID → 공개 ID backfill과 결정적 변환
- `ALTER TABLE` migration, follower DB 변환, 분산 rollback
- 기존 충돌 감지·복구·startup scan과 나란히 도는 새 서비스

## 2. 제공 계약

| ID | 사용자에게 보이는 결과 | 기계적 완료 조건 |
|---|---|---|
| A1 | 일반 Markdown 편집기에서 본문을 자연스럽게 읽고 수정할 수 있다. | 각 블릿에는 `yid` 주석 하나만 있고 불필요한 `\\/`, `\\+`, `\\.`가 없다. |
| A2 | 서로 다른 기기에서 독립적으로 고친 내용이 가능한 한 자동으로 합쳐진다. | 공통 base가 있는 B/L/R 비충돌 사례가 같은 결과로 수렴한다. |
| A3 | 자동 병합이 확신할 수 없는 변경과 입력 중인 내용은 사라지지 않는다. | 충돌 시 base/local/remote와 원격 삭제된 줄의 미저장 draft를 보존하고 명시적 해결 전에는 버리지 않는다. |
| A4 | 개발 DB를 지워도 현재 Markdown과 앱 상태를 복구할 수 있다. | 빈 DB에서 포맷 1 vault를 읽으면 본문·계층·순서·상태·`yid`·이미지 표시 폭이 동일하게 복원된다. |
| A5 | 이후 mirror와 블록 참조를 붙일 때 블록 ID를 다시 바꾸지 않는다. | 편집·이동·파일명 변경·DB 재생성 후에도 `yid`가 유지되고 블록과 배치를 구분할 수 있다. |

### 2.1 범위

- 현재 포맷 1의 정확한 frontmatter, 본문, 하단 metadata 문법
- 12자 `yid` 생성·검증
- SQLite snapshot/head/conflict 저장 구조
- 문서 트리 3-way 병합과 충돌 해결
- watcher, 조건부 파일 쓰기, 휴지통과 asset 안전 계약
- mirror와 블록 참조를 막지 않는 최소 데이터 경계

### 2.2 하지 않는 것

- 파일 포맷 또는 DB 버전 증가
- 기존 개발 파일·DB 변환 코드와 호환 reader
- 자체 동기화 서버, 계정 시스템, CRDT 네트워크 프로토콜
- Git 실행 파일 또는 Git 저장소 의존
- 영구 content-addressed object store와 분산 GC
- mirror UI와 블록 참조 UI의 실제 구현

## 3. 포맷 1

### 3.1 대표 파일

```markdown
---
kind: yonalist-notes
format_version: 1
id: Df4qM9_wK2Ls
---
# Yonalist 시작하기
> 이 노트는 자유롭게 수정하거나 삭제할 수 있어요.

- Enter — 새 항목 만들기 <!-- yid: N7dP2k_q4WmA -->
- Tab / Shift+Tab — 들여쓰기 / 내어쓰기 <!-- yid: Bf8xL2mQ0_Ke -->
- Shift+Enter — 설명 입력하기 <!-- yid: Xm3_aP9kT2Ws -->
  - 지금까지 한 걸로는 크게 차이를 모르겠는데 <!-- yid: Gp0vL7_cN4Ya -->
  - ![SCR-20251116-tljz.png](assets/SCR-20251116-tljz-5f47a32a8480.png) <!-- yid: Qw6Jm2_zR8Ka -->
  - 음. <!-- yid: Vc9_nL5pT1Xe -->
- ⌘/Ctrl+Enter — 완료 표시 <!-- yid: Hm4sK8_qW2Pd -->
- ↑/↓ — 항목 사이 이동 <!-- yid: Tn7_bC3xP9La -->

<!-- yonalist
{"commit":"sha256:4e6f...91a2","state_hash":"sha256:9ac1...07d4","merge_base":"sha256:18c7...72d0","parents":["sha256:18c7...72d0"],"history":[],"transfers":[],"state":{"Df4qM9_wK2Ls":{"collapsed":true},"Qw6Jm2_zR8Ka":{"width":268,"pixel_width":870,"pixel_height":602,"byte_size":38471,"asset_hash":"sha256:7af3...104c"},"Hm4sK8_qW2Pd":{"starred":true}}}
-->
```

예시 hash는 폭을 줄였지만 실제 값은 `sha256:` 뒤에 소문자 hex 64자를 모두 쓴다.

### 3.2 frontmatter

frontmatter에는 문서 자체의 기본 정보만 둔다.

| 필드 | 규칙 |
|---|---|
| `kind` | 일반 문서는 `yonalist-notes`, 휴지통은 `yonalist-trash` |
| `format_version` | 항상 정수 `1` |
| `id` | 일반 문서의 12자 `yid`; home만 예약값 `root`. trash는 생략 |
| `parent` | 분할 문서에만 사용. 이 split boundary가 매달린 직계 부모 노드의 `yid` |
| `sort_key` | 분할 문서에만 사용. child 파일만 먼저 도착했을 때의 배치 fallback |

`max_hlc`, `root_hlc`, `root_marker_kind`, `root_ordered_start`, `root_collapsed`, `root_completed`, `root_starred`는 제거한다. root 상태는 하단 `state[id]`에 둔다. 이 이름들은 예전 개발 포맷의 예약 key이므로 새 parser가 알 수 없는 key처럼 보존하지 않고 “개발 vault를 다시 만들어야 함”으로 격리한다. 그 밖의 알 수 없는 frontmatter key는 현재 동작처럼 그대로 round-trip한다.

문서의 실제 형제 순서는 부모 파일의 page/split boundary 줄 순서가 정본이다. `sort_key`는 부모 파일이 아직 도착하지 않았을 때만 임시 배치에 쓰고 `state_hash`에는 넣지 않는다. 부모 파일이 도착하면 boundary 순서로 다시 계산한다.

사용자가 기존 문서의 `id`를 바꾼 경우 자동 rename으로 추측하지 않는다. 같은 경로의 알려진 문서라면 격리하고, 새 파일이며 vault 전체에서 고유할 때만 새 문서로 가져온다.

### 3.3 본문

- UTF-8, 방출 개행은 LF다. 입력 CRLF와 CR은 LF로 정규화한다.
- 문서 제목은 첫 H1이다. 제목 뒤의 인용문은 문서 root note다.
- 각 Yonalist 블릿 마지막에는 공백 하나와 `<!-- yid: XXXXXXXXXXXX -->`가 정확히 하나 있다.
- `t:`, `prev:`, `from:`, `star`, `todo`, `ordered:`, `done`, `split`, `collapsed`, `<!-- ya: ... -->`는 본문에 쓰지 않는다. 같은 `format_version: 1`의 예전 개발 파일이 조용히 섞이지 않도록 parser는 이 예약 token을 무시하지 않고 개발 포맷 불일치로 격리한다.
- `yid` 없는 새 블릿은 외부 편집기가 만든 신규 노드다. import 시 ID를 발급하고 다음 방출에서 주석을 보충한다.
- 사용자가 기존 주석을 지운 블릿도 새 노드로 본다. 본문 유사도로 ID를 추정하지 않는다.
- 한 줄에 관리 주석이 둘 이상 있으면 격리한다. vault에서 같은 block identity가 두 파일에 보이면 먼저 boundary 관계와 §8.4의 transfer/cut-paste 후보를 대조한다. 부모 boundary와 자식 root 한 쌍은 동일 block의 두 표현으로 허용하고, 이동 선도착이면 destination snapshot과 one-sided transfer만 저장한다. 안정화 구간 뒤에도 어느 관계로도 설명되지 않는 중복만 격리한다.
- 일반 Markdown fenced code, 제목, 인용문 안의 목록은 문서 문법이 지정한 위치가 아니면 Yonalist 블릿으로 해석하지 않는다.

본문이 직접 표현하는 값이 하단의 오래된 상태와 다르면 본문을 우선한다. 예를 들어 체크박스 완료 여부, 번호 목록 시작값, 제목과 note는 본문이 정본이다.

### 3.4 문맥별 escape

ASCII 문장부호 전체를 escape하지 않는다. renderer는 Markdown 문법을 실제로 여는 경우만 처리한다.

| 위치 | 처리 | 그대로 두는 예 |
|---|---|---|
| 일반 텍스트 | `\\`, `&`, 실제 줄바꿈, 관리 주석 시작 `<!--` | `/`, `.`, `+`, 괄호, 문장 안 `-` |
| 줄 시작 | 목록·번호·heading·quote로 오인될 접두사만 escape | `Shift+Enter`, `음.` |
| 링크 label | `]`, `\\` | 파일명의 `.`, `-` |
| 링크 target | Markdown URL 문법에 필요한 문자만 percent-encode | `/`, `.`, `-`, `_` |
| note | 실제 개행을 blockquote 줄로 렌더 | 일반 문장부호 |

renderer는 사용자 본문의 모든 `&`를 `&amp;`로 방출한다. 그다음 사용자 본문의 `<!-- yid:` 또는 `<!-- yonalist`에서 주석 시작 `<`를 `&lt;`로 방출한다. parser는 `&amp;`와 `&lt;`를 왼쪽부터 정확히 한 번만 해석하고, 그 결과를 다시 entity decode하지 않는다. 따라서 원문의 `&lt;!-- yid:`, `&amp;lt;!-- yid:`처럼 `&amp;` 단계가 몇 번 이어져도 한 번의 render/parse 뒤 원문이 그대로 남는다.

### 3.5 하단 `yonalist` metadata

하단 주석은 파일의 마지막 비공백 요소이며 하나만 허용한다. JSON은 한 줄로 쓰고 key 순서를 `commit`, `state_hash`, `merge_base`, `parents`, `history`, `transfers`, `state`로 고정한다.

| 필드 | 의미 |
|---|---|
| `commit` | 앱이 마지막으로 완성해 쓴 commit ID |
| `state_hash` | 그때의 frontmatter 기본 정보, 본문 의미, 앱 상태를 정규화한 hash |
| `merge_base` | 현재 변경 갈래가 시작된 마지막 합의 commit. 최초 문서는 빈 문자열 |
| `parents` | commit 부모 0~2개. 일반 변경은 1개, 병합은 2개 |
| `history` | 검증 가능한 가까운 조상 envelope 최대 8개 |
| `transfers` | 아직 모든 관련 파일에서 확인하지 못한 문서 간 이동 증거 |
| `state` | Markdown이 직접 보존하지 못하는 `yid → object` map |

`state`에는 다음 값만 먼저 구현한다.

| 상태 | 용도 |
|---|---|
| `collapsed`, `starred` | 블릿과 문서 root의 앱 상태 |
| `marker`, `completed` | 현재 본문 문법으로 구분할 수 없는 경우에만 사용 |
| `width`, `pixel_width`, `pixel_height`, `byte_size`, `asset_hash` | 이미지 표시·placeholder 복구 정보와 바이트 정체성 |
| `child_kind` | 부모 링크가 `page`인지 `split`인지 구분 |
| `restore_parent`, `restore_after` | trash에서 원래 위치 복원 |

기본값은 생략한다. 이미지의 `pixel_width`, `pixel_height`, `byte_size`는 asset이 아직 도착하지 않은 기기에서도 placeholder와 DB 행을 동일하게 복원하는 데 필요하므로 보존한다. asset이 없을 때 MIME은 현재 merger처럼 검증된 링크 확장자로 임시 복원하고, bytes가 도착하면 decode 결과로 다시 검증·교정한다. 알 수 없는 state key는 해당 객체 안에서 round-trip한다.

외부 편집으로 블릿이 삭제돼 오래된 `state[yid]`가 남을 수 있다. 이는 정상적인 stale metadata다. side snapshot을 만들 때 현재 본문에 없는 상태는 적용하지 않되, 선언 commit을 검증할 때는 원래 JSON을 그대로 사용한다.

하단 주석이 없으면 일반 Markdown으로 가져올 수 있다. 알려진 문서에서 로컬 변경이 없으면 본문을 채택하고 표현되지 않은 상태는 기존 DB 값을 유지한다. 빈 DB에서는 기본값으로 복구한다. 로컬도 변경됐다면 공통 base를 증명할 수 없으므로 문서 충돌로 보류한다. 주석이 존재하지만 JSON이나 commit 계보가 깨졌다면 부분 적용하지 않고 격리한다.

### 3.6 stale metadata

일반 편집기는 본문만 고치므로 하단 `commit`과 `state_hash`가 이전 값을 가리키는 것이 정상이다.

1. parser는 frontmatter의 문서 정보와 하단의 선언 `state_hash`, `merge_base`, `parents`, `transfers`로 `commit`을 다시 계산한다.
2. 계산값이 다르면 metadata 일부만 바뀌었거나 손상된 것이므로 격리한다.
3. 현재 본문과 상태의 의미 hash가 선언 `state_hash`와 같으면 완성된 선언 commit이다.
4. 다르면 선언 commit에서 갈라진 외부 편집 자식이다. importer가 현재 의미 hash와 선언 commit을 부모로 삼아 후보 commit을 만든다.

metadata 무결성 검증과 현재 본문 변경 판정을 분리해야 정상적인 외부 편집을 손상으로 오인하지 않는다.

## 4. 식별자

`yid`는 Markdown, snapshot, 미래 block reference에서 쓰는 영구 Block ID다.

```text
길이       12자
문자 집합  A-Z a-z 0-9 _ -
정규식     ^[A-Za-z0-9_-]{12}$
엔트로피   72 bit
생성       OS CSPRNG 9바이트를 padding 없는 base64url로 인코딩
범위       vault 전체에서 UNIQUE
```

새 ID는 DB의 primary key/UNIQUE 제약에 넣고 충돌하면 다시 생성한다. 파일 입력은 trust boundary이므로 정규식과 vault 전체 중복을 모두 검사하되, boundary와 문서 간 이동의 일시적 중복을 먼저 분류한다. one-sided destination은 `notes_nodes`에 중복 적용하지 않고 snapshot과 `sync_transfers`에 영속한 뒤 source 도착을 기다린다.

개발 중인 현재 스키마를 제자리에서 바꿀 수 있으므로 내부 UUID와 공개 ID를 이중으로 유지하지 않는다. `notes_nodes.id` 자체가 `yid`다. home root만 기존 예약값 `root`를 유지한다. 폴더 suffix는 UUID 앞 12자리 대신 문서 `yid` 전체를 쓴다.

이 선택으로 다음 설계가 사라진다.

- `public_id` 보조 열과 매 요청의 `public_id → id` 조회
- UUID → yid 변환, backfill, 충돌 salt
- 두 ID namespace를 영구히 함께 유지하는 비용

일반 create, split, duplicate root, Markdown import는 한 CSPRNG helper를 사용한다. 한 duplicate 명령의 자식은 현재 명령 모양을 유지하기 위해 새 root `yid`와 preorder ordinal의 domain-separated SHA-256 앞 9바이트로 결정적으로 파생한다. 누락된 부모의 recovery page도 `"yonalist-recovery-1\0" || missing_parent_yid`의 SHA-256 앞 9바이트로 만든다. 둘 다 base64url 12자로 인코딩하고 기존 ID와 충돌하면 부분 적용하지 않고 격리한다. UUID parser와 UUID v5 namespace는 남기지 않는다.

onboarding seed는 예외적으로 source에 고정된 12자 yid 집합을 쓴다. vault를 먼저 고른 뒤 다음 규칙으로 guide 여부를 정한다.

- 빈 새 vault 또는 “나중에”: seed
- root marker나 하위 `README.md`의 Yonalist frontmatter를 찾은 기존 vault: seed하지 않고 import
- 비어 있지 않지만 Yonalist 여부를 확정할 수 없는 폴더: 자동 seed하지 않고 사용자의 명시적 “새 노트로 사용” 확인을 기다림

하위 문서 감지는 symlink를 따라가지 않고 최대 10,000개 directory entry, 깊이 32까지만 훑는다. `README.md`의 `kind`와 `format_version` frontmatter만 읽어 판정한다. 한도에 닿으면 “없음”이 아니라 `nonEmptyUnknown`이다. 이 보수적 분류는 클라우드가 page 폴더를 root `README.md`보다 먼저 내려보낸 경우 새 guide가 기존 ID에 대한 최신 주장이 되는 일을 막는다. 고정 seed 집합은 guide fixture와 새 vault가 언제나 같은 block identity를 쓰게 하고 재호출을 idempotent하게 만든다. 각 상수는 서로 고유하고 일반 생성 정규식을 만족해야 한다.

UI 확인과 vault 활성화 사이의 경쟁을 막기 위해 backend 계약을 둘로 나눈다.

1. `notes_sync_vault_inspect(path)`는 경로를 저장하거나 watcher를 시작하지 않고 위 분류만 반환한다.
2. first-run과 Settings는 결과를 보여 주고 `nonEmptyUnknown`이면 명시적 “새 노트로 사용”을 받는다.
3. `notes_sync_vault_set(path, intent)`는 backend에서 같은 분류를 다시 실행한다. 현재 분류와 `intent`가 맞을 때만 경로 저장과 watcher 시작을 한 번에 진행한다.
4. inspect 뒤 파일 상태가 달라졌거나 확인이 없으면 아무 side effect 없이 `confirmation_required`를 반환한다.

기존 로컬 DB에 노트가 있는 Settings 경로도 이 계약을 반드시 거친다. 그래야 미확정 폴더를 활성화한 직후 기존 로컬 노트를 먼저 방출하는 일을 막을 수 있다.

## 5. canonical snapshot과 hash

snapshot은 원본 Markdown bytes가 아니라 파싱된 의미다.

```rust
struct DocumentSnapshot {
    kind: DocumentKind,
    document_id: DocumentId,
    root_block: Option<BlockId>,
    blocks: BTreeMap<BlockId, SnapshotBlock>,
    placements: BTreeMap<PlacementId, SnapshotPlacement>,
    children: BTreeMap<ParentPlacement, Vec<PlacementId>>,
}

struct SnapshotBlock {
    kind: NodeKind,
    text: String,
    note: String,
    marker: Marker,
    collapsed: bool,
    completed: bool,
    starred: bool,
    image: Option<SnapshotImage>,
}

enum SnapshotPlacement {
    Local {
        block_id: BlockId,
        parent: ParentPlacement,
    },
    Boundary {
        child_document: DocumentId,
        child_kind: PageOrSplit,
        parent: ParentPlacement,
    },
}
```

이 타입은 `notes-sync` 내부 구현이다. 새 public API나 범용 저장소 abstraction을 만들지 않는다.

현재 각 block은 primary placement 하나만 가진다. primary placement ID는 `primary:<block_id>`로 결정적으로 파생해 파일에 별도 ID를 쓰지 않는다. 형제 순서는 `children[parent]`의 stable-ID 배열이 정본이다. `sort_key`와 `predecessor`는 DB 행이나 호환 frontmatter를 만드는 구현 세부일 뿐 snapshot 순서 모델이 아니다.

parent 문서의 page/split 링크는 `Boundary` placement다. child 문서 root 내용을 parent snapshot에 복제하지 않는다. child 파일의 `id`와 링크 줄의 `yid`가 같아야 한다. parent link label은 child title의 투영이므로 child root의 정본은 child 파일이다.

### 5.1 `state_hash`

1. 문자열을 Unicode NFC와 LF로 정규화한다.
2. block과 placement는 ID byte 순으로 기록하고, 각 `children` 배열은 표시 순서대로 기록한다.
3. 각 값은 고정 tag와 길이-prefix byte로 직렬화한다.
4. 알 수 없는 frontmatter와 state key는 JSON key 순으로 정규화해 포함한다.
5. `commit`, `merge_base`, `parents`, `history`, `transfers`, mtime, 파일 경로, HLC, `sort_key`는 제외한다.
6. SHA-256 결과를 `state_hash`로 쓴다.

JSON 문자열을 그대로 이어 붙여 hash하지 않는다. 기존 SHA-256 helper를 재사용하되 canonical serialization은 한 함수에 둔다.

### 5.2 `commit`

```text
commit_id = SHA-256(
  "yonalist-commit-1\0"
  || document_kind
  || document_id
  || state_hash
  || transfers_hash
  || merge_base_commit
  || sorted(parent_commit_ids)
)
```

`state_hash`와 commit ID를 분리한다. 내용이 예전 상태로 돌아오거나 merge 결과가 한 parent와 같아도 다른 계보를 가진 commit을 표현할 수 있다.

`history` envelope은 `{commit,state_hash,merge_base,parents,transfers_hash}`만 담고 snapshot 본문은 넣지 않는다. 가까운 조상부터 중복 없이 최대 8개를 유지한다. SQLite에 해당 조상 snapshot이 있을 때만 merge base로 사용한다. hash만 있고 본문 snapshot이 없으면 병합을 추측하지 않는다.

## 6. SQLite

### 6.1 개발 스키마 변경 원칙

- `PRAGMA user_version = 1`과 `SCHEMA_VERSION = 1`을 유지한다.
- `MIGRATIONS`는 계속 비워 둔다.
- `schema.sql`의 최종 모양을 직접 수정한다.
- debug 빌드는 기존 `remake_if_an_older_build_made_it`로 모양이 다른 개발 DB를 다시 만든다.
- 기존 개발 vault와 fixture는 변환하지 않는다. 새 포맷 fixture로 교체하고 필요한 개발 vault는 사용자가 별도로 백업한 뒤 다시 만든다.
- release build에 이 포맷을 내기 전에는 별도 릴리스 마이그레이션 정책을 다시 결정한다. 이번 설계에는 포함하지 않는다.

### 6.2 최종 스키마

`notes_nodes.id`는 `root` 또는 유효한 12자 `yid`만 받는다. `notes_nodes.hlc`, `sync_prev`, `sync_prev_hlc`, `sync_documents.applied_max_hlc`와 stamp/place 승자 판정은 최종 schema와 mutation 경로에서 제거한다. 변경 감지는 기존 `sync_dirty_nodes`와 revision만으로 처리한다.

`sync_snapshots`를 추가한다.

```sql
CREATE TABLE sync_snapshots (
    commit_id TEXT PRIMARY KEY NOT NULL,
    state_hash TEXT NOT NULL,
    document_id TEXT NOT NULL,
    merge_base_commit TEXT NOT NULL,
    parent1_commit TEXT,
    parent2_commit TEXT,
    snapshot_json BLOB NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('local', 'file', 'merge')),
    created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX sync_snapshots_document_time
ON sync_snapshots(document_id, created_at);
```

`sync_documents`의 최종 `CREATE TABLE`에 다음 상태를 포함한다.

```sql
base_commit_id TEXT NOT NULL DEFAULT '',
local_commit_id TEXT NOT NULL DEFAULT '',
file_commit_id TEXT NOT NULL DEFAULT '',
merge_status TEXT NOT NULL DEFAULT 'clean'
  CHECK (merge_status IN ('clean', 'pending', 'quarantined'))
```

- `base_commit_id`: DB와 파일이 마지막으로 합의한 head
- `local_commit_id`: 현재 DB 상태의 head
- `file_commit_id`: 마지막으로 읽은 파일의 head
- `pending`: 해결되지 않은 충돌 때문에 이 문서의 자동 방출이 멈춤

기존 `sync_conflict_log`를 다음 최종 모양으로 제자리에서 바꾼다. 별도 table과 복구 시스템을 병렬로 두지 않는다.

```sql
CREATE TABLE sync_conflict_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    local_commit TEXT NOT NULL,
    remote_commit TEXT NOT NULL,
    provisional_commit TEXT,
    expected_local_commit TEXT NOT NULL,
    expected_file_byte_hash TEXT NOT NULL,
    conflicts_json BLOB NOT NULL,
    recorded_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolution_commit TEXT
) STRICT;

CREATE TABLE sync_transfers (
    transfer_id TEXT PRIMARY KEY NOT NULL,
    root_placement_id TEXT NOT NULL,
    from_document TEXT NOT NULL,
    to_document TEXT NOT NULL,
    subtree_state_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('one-sided', 'confirmed', 'conflict')),
    recorded_at INTEGER NOT NULL,
    confirmed_at INTEGER
) STRICT;
```

`sync_node_exports`는 최종 schema에서 제거한다. `sync_dirty_nodes`, `sync_assets`, `sync_quarantine`, `notes_ui_state`와 기존 revision 경로는 재사용한다.

### 6.3 보존

다음 snapshot은 지우지 않는다.

- 모든 문서의 base/local/file head
- 해결되지 않은 충돌이 참조하는 base/local/remote/provisional
- 위 head에서 공통 조상까지 필요한 parent chain
- 최근 30일 또는 문서별 최근 50개 중 더 넓은 집합

snapshot이 참조하는 asset도 함께 pin한다. 정리는 성공한 export 뒤 짧은 별도 transaction에서 수행한다. 정리 실패는 저장 공간 증가만 허용하고 동기화를 실패시키지 않는다.

## 7. 동기화 흐름

```text
startup scan 또는 파일 변경
  → 안정된 bytes 읽기
  → frontmatter/body/footer parse
  → byte echo면 종료
  → local snapshot과 공통 base 탐색
  → B/L/R 3-way merge
      ├─ clean: 기존 sync_merge transaction으로 DB·snapshot·head 적용
      │         → 조건부 Markdown publish
      └─ conflict: 세 snapshot과 충돌 목록 저장
                  → 문서 pending, 원본 파일 유지
```

mtime만으로 echo를 판정하지 않는다. 현재처럼 byte SHA-256이 `exported_hash`와 같을 때만 echo다. 의미 hash가 같고 공백 표현만 달라진 파일은 DB 의미를 바꾸지 않으며, 다음 의미 변경 전까지 사용자의 표현을 덮지 않는다.

### 7.1 base 선택

1. local commit과 remote 선언 commit 또는 직접 parent가 같으면 fast-forward한다.
2. 아니면 remote의 `merge_base`, `parents`, `history`와 SQLite parent graph가 함께 증명하는 공통 조상 중 거리가 가장 짧은 것을 고른다.
3. 거리도 같으면 commit ID byte가 작은 것을 고른다.
4. 공통 조상의 snapshot 본문이 SQLite에 없으면 base가 없는 것으로 처리한다.
5. base가 없고 로컬 변경이 없으면 파일을 새 기준으로 채택한다.
6. base가 없고 양쪽이 다르면 문서 전체 충돌로 보류한다.

### 7.2 조건부 publish

현재 `write_checked`의 사전 hash 비교는 유지한다. 다만 비교 뒤 `write_atomic`이 target을 덮는 사이에 외부 편집이 들어올 수 있으므로 기존 파일 교체만 강화한다.

1. 같은 디렉터리에 임시 파일을 쓰고 flush한다.
2. 임시 경로, target, expected hash, 새 hash를 작은 publish journal에 기록한다.
3. target이 있으면 macOS `renameatx_np(RENAME_SWAP)`으로 맞바꾼다.
4. 밀려난 원본 hash가 expected와 같고 target read-back hash가 새 hash와 같을 때만 성공으로 기록한다.
5. 원본 hash가 다르면 다시 swap해 외부 파일을 복원한다. 복원 경쟁이나 실패가 있으면 두 후보를 보존하고 문서를 pending으로 둔다.
6. target이 없으면 기존 `RENAME_EXCL` 경로를 사용한다. `EEXIST`면 새 target을 읽어 merge한다.

DB commit 뒤 publish 전에 죽으면 dirty/head 차이로 재방출한다. swap 뒤 검증 전에 죽으면 시작 시 journal로 성공 확정 또는 복구를 한다. 이 journal은 파일 포맷이나 migration marker가 아니라 한 번의 로컬 쓰기 복구 기록이다.

### 7.3 충돌 사본

기존 `is_conflicted_copy`와 startup scan을 사용한다.

- 같은 문서 `id`를 가진 정본과 충돌 사본은 같은 3-way merge에 넣는다.
- 자동 병합되면 정본만 새 snapshot으로 쓴다. 사본은 기존 `move_no_replace`로 `.yonalist/resolved-conflicts/`에 옮겨 30일 보존한다.
- 충돌하면 두 원본을 그대로 두고 pending으로 기록한다.
- 이름이 비슷해도 문서 `id`가 다르거나 식별할 수 없으면 사용자 파일로 보고 손대지 않는다.

## 8. 3-way 병합

### 8.1 필드

각 block 필드와 placement 위치를 B(base), L(local), R(remote)로 비교한다.

| 조건 | 결과 |
|---|---|
| `L == B`, `R != B` | R |
| `R == B`, `L != B` | L |
| `L == R` | 그 값 |
| 셋이 모두 다름 | 해당 필드 충돌 |

내용과 위치를 독립적으로 비교한다. 한쪽이 본문을 고치고 다른 쪽이 같은 block을 이동했다면 둘을 합친다.

### 8.2 생성·삭제

- 한쪽만 만든 새 `yid`는 추가한다.
- 양쪽이 같은 `yid`와 같은 내용으로 만들었으면 한 번만 추가한다.
- 같은 `yid`를 서로 다른 내용으로 만들었으면 ID 충돌로 격리한다.
- 한쪽 삭제, 다른 쪽 unchanged면 삭제한다.
- 한쪽 삭제, 다른 쪽 edit/move면 삭제/수정 충돌이다.
- 양쪽 삭제면 삭제한다.

같은 위치에 양쪽이 서로 다른 새 블릿을 넣으면 둘 다 보존하고 `(origin_commit_id, placement_id)`로 정렬한다.

### 8.3 이동과 순서

노드별 `prev` 값을 비교하지 않는다. 앞 형제 이동만으로 뒤 형제의 predecessor가 바뀌어 거짓 충돌이 생기기 때문이다.

각 부모의 stable placement ID 배열에서 base와 side에 공통인 ID의 최장 증가 부분수열(LIS)을 구한다. LIS 밖의 ID만 실제 이동 후보로 보고, 신규 ID는 insert, 사라진 ID는 delete로 분리한다. 이동 위치는 가장 가까운 unchanged 앞·뒤 anchor로 표현한다.

- 한쪽만 이동: 채택
- 양쪽이 같은 placement를 같은 gap으로 이동: 한 번 적용
- 같은 placement를 다른 gap으로 이동: 위치 충돌
- 서로 다른 placement 이동: anchor 제약에 cycle이 없으면 합침
- cycle: 해당 순서 구간 충돌

병합 뒤 ID 유일성, 부모 cycle 없음, placement 1회 소유, child document boundary 일치를 검사한다. 실패하면 부분 결과를 적용하지 않고 문서를 격리한다.

### 8.4 문서 경계를 넘는 이동

한 block의 primary placement는 vault 전체에서 한 문서만 소유한다. 문서별 merge 결과를 곧바로 적용하지 않고 watcher batch의 `placement_id → document_id` claim을 먼저 모은다.

앱이 문서 A에서 B로 옮기면 source와 destination footer에 같은 transfer를 쓴다.

```json
{"id":"...","root_placement":"primary:...","from":"A","to":"B","subtree_state_hash":"sha256:...","confirmed_at":null}
```

- destination이 먼저 오면 새 위치를 후보로 기록하고 source의 오래된 파일로 되돌리지 않는다.
- source가 먼저 오면 subtree를 hard delete하지 않고 마지막 위치에서 보류한다.
- 두 파일의 transfer와 subtree hash가 맞으면 한 DB transaction에서 소유권을 B로 옮긴다.
- 반대 방향, 다른 destination, hash 불일치는 문서 간 이동 충돌이다.
- 확인된 transfer도 최소 30일 동안 두 footer에 full envelope로 유지한다. hash만 남겨 원격 기기가 내용을 복원하지 못하는 상태를 만들지 않는다.

외부 편집기의 cut/paste에는 transfer가 없다. watcher는 짧은 안정화 구간 동안 vault 전체 claim을 모아 같은 `yid`의 source 제거와 destination 추가를 짝짓는다. 도착 순서가 어긋나면 삭제하거나 중복 생성하지 않고 보류한다.

## 9. 충돌 보존과 해결

충돌을 발견하면 기존 `sync_merge` transaction 안에서 base/local/remote snapshot, 자동 병합 가능한 provisional snapshot, 충돌 목록, 예상 local head와 현재 file byte hash를 저장한다. 문서를 pending으로 바꾸고 자동 export만 멈춘다. 원본 Markdown에 Git conflict marker를 쓰지 않는다.

기존 Settings 복구 화면을 확장해 블릿별로 기준/이 기기/파일을 보여 주고 다음 선택을 제공한다.

- 본문·상태: 이 기기, 파일, 둘 다 유지, 직접 수정
- 위치: 이 부모, 파일의 부모, 직접 위치 선택
- 삭제/수정: 삭제, 복원, 직접 수정

해결 적용 직전에 저장된 `expected_local_commit`과 `expected_file_byte_hash`를 다시 확인한다. 둘 중 하나라도 달라졌으면 오래된 해결 결과를 쓰지 않고 최신 세 후보로 재병합한다. 같을 때만 새 merge commit을 만들고 조건부 publish한다.

원격 삭제 알림을 받으면 해당 ID의 deletion epoch를 증가시키고 `deletion-pending`으로 잠근 뒤 debounce timer를 동기적으로 취소하되 draft 값은 메모리에 유지한다. pending ID의 `setDraft`/`setNoteDraft`는 세대값과 메모리 값만 갱신하고 새 timer나 command를 만들지 않는다. 그다음 reload 전에 기존 충돌 repository의 UI-draft 후보로 마지막 node snapshot, draft text/note, 삭제 commit, deletion epoch와 draft 세대를 idempotent upsert한다. backend는 같은 후보의 필드별 세대가 더 클 때만 값을 교체해 늦은 구세대 요청이 최신 값을 덮지 못하게 한다. 응답 뒤 epoch가 여전히 같고 현재 세대가 더 새로우면 최신 값을 다시 upsert한다. epoch와 세대가 모두 같을 때만 frontend draft를 제거한다.

영속화 중 같은 ID의 changed/복원 알림이 오면 deletion epoch를 즉시 무효화한다. patch/reload로 node가 실제로 돌아온 것을 확인한 뒤에도 pending lock을 바로 풀지 않는다. 현재 메모리의 text/note와 필드별 세대를 후보에 upsert하고, 대기 중 세대가 다시 바뀌면 후보가 최신 세대를 따라잡을 때까지 반복한다. 그 뒤에만 pending lock을 풀고 기존 draft를 그대로 둔 채 debounce를 다시 연결한다. 이전 epoch나 낮은 세대의 upsert 응답은 draft, 후보의 최신 값, lock을 건드리지 못한다.

UI-draft 후보는 command receipt로 자동 resolve하지 않는다. 복원 뒤 새 입력과 정상 저장이 이어져도 삭제 시점까지 보존한 후보는 복구 기록으로 남는다. 사용자가 복구 화면에서 삭제 유지, draft로 복원, 직접 수정 또는 닫기를 명시적으로 선택할 때만 resolved로 바꾼다. 따라서 receipt와 새 draft의 도착 순서를 맞추는 별도 상태 기계가 필요 없다. 저장이 실패하면 pending과 draft를 그대로 보존하고 sync error를 표시한다. draft를 버리거나 존재하지 않는 node에 재전송하지 않는다.

정상 실행 중에는 unresolved 복구 행과 그 행이 참조하는 asset pin을 함께 보존한다. 개발 빌드의 schema 변경으로 일어나는 DB 재생성은 의도적인 개발 데이터 초기화이며, 이전 schema의 pending 후보를 변환하지 않는다.

## 10. 휴지통과 asset

삭제는 snapshot의 block·placement 제거다. 한쪽 삭제와 다른 쪽 수정은 항상 충돌이다. trash는 `restore_parent`와 `restore_after`를 하단 state에 보존한다.

현재 구현의 다음 안전 규칙을 유지한다.

- 복원으로 trash의 소유 항목이 바뀌면 trash 문서도 dirty가 된다.
- 빈 trash 파일은 현재 byte hash가 마지막 앱 방출 hash와 같을 때만 삭제한다.
- 외부가 바꾼 trash는 삭제하지 않고 merge한다.
- hard delete와 snapshot GC는 해결되지 않은 충돌·transfer가 참조하는 subtree를 건드리지 않는다.

asset의 정체성은 상대 경로가 아니라 전체 SHA-256이다. 하단에는 `width`, `pixel_width`, `pixel_height`, `byte_size`, `asset_hash`를 둔다. 상대 경로는 운송 위치이며 의미 hash의 정체성이 아니다. 도착하지 않은 asset은 이 정보로 placeholder와 waiting row를 복원하고, 해당 asset을 참조하는 snapshot/conflict가 있는 동안 정리하지 않는다.

## 11. mirror와 블록 참조

`yid`는 block identity다. mirror가 생겨도 mirror 줄마다 새 `yid`를 주어 같은 내용을 복제하지 않는다.

- block: 본문, note, 의미 상태를 한 번 소유
- placement: 어느 부모의 어느 순서에 보이는지 소유
- primary placement: 현재는 `primary:<yid>`로 파생
- mirror placement: 기능을 구현할 때 별도 placement ID 추가

미래 문법은 예를 들어 `<!-- yid: BLOCK pid: PLACEMENT mirror -->`처럼 확장할 수 있다. 현재 parser는 이를 미리 구현하지 않는다. 다만 알 수 없는 관리 token을 보존할 수 있는 경계와 snapshot의 block/placement 분리만 유지한다.

`[[...]]` 블록 참조는 `yid`를 대상으로 한다. 표시 문자열이나 현재 파일 경로를 identity로 쓰지 않는다. 참조 해석기, backlink index, mirror UI는 실제 기능 요구가 생길 때 만든다.

## 12. Merkle

지금 필요한 것은 문서 단위 `state_hash`, commit DAG, block hash다. 이는 변경 판정, snapshot dedup, 충돌 UI 비교에 충분하다.

다음은 만들지 않는다.

- block마다 영구 저장되는 Merkle node table
- content-addressed Markdown chunk
- 파일 간 전역 Merkle root와 분산 GC
- 자체 sync transport

한 문서의 비교·직렬화가 실제로 지연 예산을 넘거나, 매우 큰 mirror graph에서 매번 전체 hash가 병목이라는 측정이 생기면 `children` subtree hash cache를 추가한다. 파일 문법과 `yid`는 바꾸지 않아도 된다.

## 13. 구현 순서

각 단계는 기존 경로를 세로로 완성하며, 병렬 시스템을 만들지 않는다.

### M1. 포맷 1 codec과 ID

- `notes-core`: 12자 `yid` 생성·검증 helper, create/split/duplicate root 발급, duplicate 자식의 domain-separated 파생
- `apps/desktop/src/store/storeSupport.ts`: 화면의 신규 ID 생성기를 같은 12자 계약으로 교체
- `notes-sync/document.rs`: HLC 파일 필드 제거, footer 상태와 계보 모델
- `notes-sync/parse.rs`: UUID 검증을 yid 검증으로 교체하고 frontmatter + 본문 `yid` + footer parse
- `notes-sync/render.rs`: 새 포맷 1과 문맥별 escape
- `notes-sync/merger.rs`: 외부 무ID 줄 발급, UUID 기반 recovery sort key, recovery page UUID v5를 yid 규칙으로 교체
- `notes-sync/layout.rs`: UUID parsing을 제거하고 폴더 suffix를 문서 `yid`로 변경
- `notes-sqlite/seed.rs`: onboarding seed를 compile-time 고정 yid 집합으로 교체하고 재호출 idempotence 유지
- fixture와 parser/render round-trip test를 새 포맷으로 교체

### M2. snapshot 저장

- `schema.sql`을 제자리에서 수정하고 버전은 1로 유지
- `notes-sqlite/mutations.rs`, `worker.rs`: HLC stamp/place 결합을 제거하고 dirty/revision 경로만 유지
- `sync_snapshots`, document head, conflict, transfer 최종 table 추가
- current tree ↔ canonical snapshot 변환과 hash
- debug DB 자동 재생성 확인

### M3. 순수 3-way merge

- `merger.rs`의 HLC 승자 판정을 B/L/R 필드·sequence merge로 교체
- 생성, 삭제, 수정, 이동, 순서, boundary 불변식 검사
- 결과가 입력 순서와 기기에 관계없이 수렴하는 property test

### M4. 기존 watcher/transaction/export 연결

- startup scan과 `is_conflicted_copy` 재사용. 이름 후보를 parse한 뒤 frontmatter `id`가 정본과 같을 때만 충돌 사본으로 확정
- `vault_watch.rs`, `watch_queue.rs`: 문서 간 이동의 짧은 vault-wide claim 수집을 기존 path queue 바깥에 추가
- `sync_settings.rs`, Tauri command/API contract: side effect 없는 `vault_inspect`와 활성화 직전 재검증하는 `vault_set(path, intent)` 구현
- `VaultSetupCard.tsx`, `SettingsView.tsx`: 같은 `empty`/`existingYonalist`/`nonEmptyUnknown` 확인 흐름 사용
- 하위 page가 root보다 먼저 도착한 vault와 비어 있지 않은 미확정 폴더에 자동 seed하지 않는 회귀 test
- 기존 로컬 노트가 있는 Settings 폴더 변경도 확인 전 경로 저장·watcher 시작·export를 하지 않는 회귀 test
- `syncChanged.ts`, `notesStore.ts`: 삭제→복원 coalescing 유지, 삭제 ID pending lock과 timer 즉시 취소, 세대별 draft를 backend 복구 항목에 저장한 뒤 제거
- `sync_merge.rs` transaction에서 snapshot/head/DB tree 동시 적용
- `export.rs`의 `write_checked` 뒤 조건부 publish
- current trash/asset dirty와 삭제 안전 규칙 회귀 test: `restored_node_queues_trash`, `empty_trash_removes_only_owned_bytes`, `empty_trash_clears_echo_record`
- 문서 간 transfer의 양쪽 도착 순서 test

### M5. 충돌 해결

- 기존 복구 repository를 구조화된 충돌 후보로 확장
- Settings 화면에 블릿·위치·삭제 해결 추가
- stale local head/file hash에서 해결 적용 거부 후 재병합
- pending 문서만 멈추고 다른 문서·asset 동기화는 계속

### M6. 미래 기능 경계 검증

- 같은 block에 두 placement를 만든 내부 fixture로 snapshot/hash가 content와 placement를 분리하는지 확인
- block reference가 파일 경로 변경 뒤에도 같은 `yid`를 가리키는지 확인
- 실제 mirror 문법, UI, backlink index는 구현하지 않음

## 14. 완료 gate

### 포맷

- `format_version: 1`과 `user_version = 1`이 유지된다.
- 대표 page/home/split/trash가 parse → render → parse에서 canonical state가 같다.
- 실제 `<!-- yid:`, 문자 그대로의 `&lt;!-- yid:`, `&amp;lt;!-- yid:`가 각각 가역적으로 round-trip한다.
- 본문에는 `yid` 외 줄별 metadata가 없다.
- frontmatter에는 문서 기본 정보만 있고 앱 상태·동기화 계보는 footer에 있다.
- 외부 편집으로 footer가 stale인 정상 파일과 손상된 footer를 구분한다.

### 데이터 보존

- DB를 지운 뒤 새 포맷 vault에서 본문, 계층, 순서, 상태, 이미지 폭을 복원한다.
- root 또는 하위 page에서 Yonalist frontmatter를 찾은 기존 vault를 선택하면 guide를 seed하지 않고 파일의 block identity를 그대로 가져온다.
- 비어 있지 않은 미확정 폴더는 명시적 사용자 확인 전 guide를 seed하지 않는다.
- first-run과 Settings 모두 확인 전에는 vault 경로를 저장하거나 watcher/export를 시작하지 않는다.
- 새·빈 vault의 onboarding seed는 고정 yid를 쓰며 두 번 호출해도 중복 문서를 만들지 않는다.
- 같은 블릿의 양쪽 수정, 삭제/수정, 상반된 이동은 pending이며 세 후보가 남는다.
- 충돌 해결 직전 파일 또는 DB가 바뀌면 오래된 결과를 쓰지 않는다.
- write hash 검사와 교체 사이에 외부 편집이 들어와도 두 후보 중 어느 것도 사라지지 않는다.
- 같은 알림 묶음에서 삭제 뒤 복원된 줄은 changed로 전달된다.
- 최종 삭제된 줄의 text/note timer는 영속화 대기 전에 멈추고, draft 값은 충돌 복구 항목 저장 전에는 버려지지 않는다.
- draft 영속화가 진행 중일 때 들어온 마지막 입력도 새 command를 만들지 않으며 최신 세대가 복구 항목에 저장된다.
- delete 영속화 중 같은 ID가 changed로 복원되면 오래된 epoch 응답이 draft를 제거하지 않고, node 확인 뒤 lock과 debounce가 정상 복구된다.
- 복원 뒤 command가 성공하거나 새 입력이 이어져도 UI-draft 후보는 자동 resolve되지 않고 사용자가 명시적으로 닫을 때까지 남는다.
- trash와 asset 회귀 test가 통과한다.

### 병합

- 서로 다른 블릿 수정, 본문/이동, 서로 다른 새 블릿은 자동 병합된다.
- 앞 형제 이동이 손대지 않은 뒤 형제의 거짓 이동을 만들지 않는다.
- 문서 A→B 이동에서 두 파일의 도착 순서를 바꿔도 block이 삭제·복제되지 않는다.
- base snapshot이 없으면 자동 2-way 삭제·이동 추정을 하지 않는다.

### 저장소 검증

```bash
cargo test -p notes-sync
cargo test -p notes-sqlite
cargo test -p notes-core
npm -C apps/desktop test
./scripts/check-notes-architecture.sh
```

## 15. 확정 선택

| 질문 | 선택 |
|---|---|
| 포맷 버전을 올릴까? | 아니오. 개발 포맷 1을 제자리에서 교체 |
| 파일·DB migration을 만들까? | 아니오. 호환 경로 없이 fixture/vault와 debug DB를 다시 만듦 |
| 문서 기본 정보는 어디에 둘까? | frontmatter |
| 앱 상태와 동기화 계보는 어디에 둘까? | 파일 마지막 단일 `yonalist` 주석 |
| 본문에 남길 metadata는? | 블릿별 12자 `yid` 하나 |
| UUID와 공개 ID를 둘 다 둘까? | 아니오. `notes_nodes.id` 자체를 `yid`로 사용 |
| `t`, `prev`, `max_hlc`를 파일에 둘까? | 아니오. HLC 승자 판정과 `prev` 계열을 DB에서도 제거하고 dirty table/revision을 사용 |
| 충돌 없는 변경은 어떻게 합칠까? | 문서 snapshot B/L/R 3-way merge |
| 충돌은 어떻게 처리할까? | 원본과 세 후보 보존, 기존 복구 화면 확장, 명시적 해결 |
| Merkle tree를 지금 만들까? | 아니오. SHA-256 snapshot/hash만 사용하고 측정 뒤 subtree cache 검토 |
