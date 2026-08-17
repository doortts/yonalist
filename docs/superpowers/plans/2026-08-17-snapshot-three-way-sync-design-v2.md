# 읽기 좋은 Markdown과 스냅샷 3-way 동기화 설계 v2

- 작성: 2026-08-17
- 상태: 구현 전 설계안. [v1](2026-08-17-snapshot-three-way-sync-design.md)을 대체한다. v1은 리뷰 대상 기록으로 남긴다
- 대상 정본: [`docs/v2/sync-spec.md`](../../v2/sync-spec.md)의 현재 개발 포맷
- 포맷 버전: 파일 `format_version: 1`, SQLite `user_version = 1` 유지

## 0. 결론

방향은 v1과 같다. Markdown은 사람이 읽고 고칠 수 있는 본문이 되고 각 블릿에는 12자 base64url `yid` 하나만 남으며 동기화는 노드별 HLC 최종 쓰기 승리에서 기준(base)·로컬(local)·파일(remote) 3-way 병합으로 바뀐다.

달라진 것은 크기다. v1은 commit DAG, 문서 간 이동 프로토콜, publish journal, draft 세대 상태 기계, LIS 기반 순서 병합을 각각 만들었다. 이 개정판은 다섯을 걷어내고 그 자리에 이미 있는 것 — 내용 해시 하나, watcher의 안정화 구간, 파일 자체, 쓰기 순서, `similar`의 slice diff — 을 놓는다. 대가는 §13에 이름을 붙여 둔다.

## 1. v1에서 잘라낸 것

### 1.1 commit DAG → `base` 해시 하나

footer key는 일곱에서 셋으로 줄어든다: `{"state_hash": …, "base": …, "state": {…}}`.

| 잘라낸 것 | 이유 |
|---|---|
| `commit` | 3-way 병합은 내용으로 한다. 계보가 달라도 `state_hash`가 같으면 결과가 같다. `state_hash`가 곧 정체성이다 |
| `history` | v1 §7.1.4가 이미 "본문 snapshot이 없는 조상은 base로 쓰지 않는다"로 못박았고 `history` envelope은 본문을 싣지 않는다. 조상 hash를 여덟 개 늘어놓아도 쓸 수 있는 base가 하나도 늘지 않는다 |
| `parents` | 하는 일이 fast-forward 판정 하나였고 그것은 `base`와 로컬 head만으로 정해진다 |

같이 사라지는 것: v1 §5.2 전체, §3.6의 commit 재계산, `sync_snapshots`의 `merge_base_commit`·`parent1_commit`·`parent2_commit`, §6.3의 parent chain 보존 규칙.

### 1.2 `transfers` 프로토콜 → 안정화 구간 안의 claim 짝짓기

`sync_transfers` table, `transfers` footer key, `transfers_hash`, 30일 envelope 보존, v1 §8.4의 다섯 가지 이동 충돌 규칙을 지운다. v1 스스로 외부 편집기의 잘라내기·붙여넣기에는 envelope이 없어 안정화 구간의 claim 짝짓기로 떨어진다고 적었다. 그 경로는 어차피 맞아야 하므로 그것만 만든다. 짝짓기의 증거는 파일 자체이고 파일은 이미 영속 저장소다. `watch_queue.rs`를 늘려 쓴다.

### 1.3 `RENAME_SWAP`은 남기고 publish journal은 지운다

`renameatx_np(RENAME_SWAP)`은 맞는 원시 연산이고 `file_io.rs:150`의 `RENAME_EXCL` 코드를 그대로 닮았다. journal은 지운다. swap 뒤 검증 전에 죽어도 다음 시작 scan이 파일 hash와 `exported_hash`가 다른 것을 보고 병합한다. 평범한 경로다. journal에 남던 마지막 일은 밀려난 원본이 담긴 임시 파일을 찾는 것이었고 고정 이름 `<문서>.publish-tmp`와 시작 시 한 번 훑기로 끝난다.

### 1.4 draft 세대 상태 기계 → 먼저 저장하고 나중에 반영

v1 §9의 deletion epoch, 필드별 세대, 세대 기반 idempotent upsert, 순서 무관 lock 해제를 지운다. 막으려던 위험은 진짜다. 다만 고칠 곳은 프로토콜이 아니라 순서다. draft를 든 노드의 원격 삭제를 받으면 draft를 충돌 복구 저장소에 **먼저** 쓰고 그다음에 삭제를 반영한다. 쓰기가 실패하면 삭제를 반영하지 않는다. 세대 비교는 "삭제가 먼저 도착할 수 있다"를 견디려고 있었고 그 전제를 없애는 쪽이 방어하는 쪽보다 싸다.

v1에서 남기는 것: 이미 동작하는 삭제→복원 합치기(`syncChanged.ts:80-97`), 그리고 UI-draft 후보를 command 응답으로 자동 해결하지 않는 규칙.

### 1.5 형제 순서 병합 → ID 배열 위의 diff3

v1 §8.3의 LIS, anchor 표현, cycle 검사를 지운다. 형제 ID 배열에 표준 diff3을 돌리면 같은 답이 나온다. "앞 형제가 움직이면 손대지 않은 뒤 형제까지 이동으로 보인다"는 위험은 predecessor 비교 방식 — 지금 `merger.rs:714`의 `SiblingOrder`가 하는 그것 — 에만 있고 배열 diff에는 없다. `similar::capture_diff_slices`를 base→local, base→remote로 두 번 돌려 op 배열을 합친다. 대략 60줄이고 복구 UI가 그대로 쓰는 구조화된 충돌이 나온다.

### 1.6 라이브러리

| 쓰임 | 크레이트 | 지워지는 코드 |
|---|---|---|
| slice diff | `similar` (`capture_diff_slices`) | LIS·anchor·cycle 장치 전부 |
| JSON | `serde_json` (+ `serde`), `notes-sync`에 추가 | `merger.rs:1796-1856`의 `json_object`/`json_string`/`Value`, `export.rs:536`의 `json_list`. footer parse·render는 derive로 |
| `yid` 생성 | `getrandom` + `base64`(`URL_SAFE_NO_PAD`) | 9바이트는 3의 배수라 인코딩이 전단사다. padding도 modulo 편향도 없어 두 줄이다 |

`base64` 0.22와 `getrandom` 0.3·0.4는 이미 `Cargo.lock`에 있다. `similar`만 새로 들어온다. `unicode-normalization`은 `notes-sync`가 `layout.rs`에서 이미 쓴다. 버전은 고정하지 않는다.

거절한 것은 다시 올라오지 않게 이유를 한 줄씩 적어 둔다.

| 거절 | 이유 |
|---|---|
| `nanoid` | 필요 없는 rejection sampling을 한다 |
| `diffy`, `diffy-imara` | conflict marker 텍스트를 돌려준다. 블릿별 복구 UI가 쓸 모양이 아니다 |
| `gray_matter`, `serde_yaml` | `parse.rs:103`의 20줄짜리 reader가 더 엄격하고 `serde_yaml`은 폐기됐다 |
| `pulldown-cmark` | CommonMark parser는 이 줄 문법이 허용하는 것보다 훨씬 많이 받아들여 격리 판정을 어렵게 만든다 |

`state_hash`는 v1 §5.1의 tag·길이 prefix 직렬화기를 쓰지 않는다. §5.1의 정규 snapshot 구조체를 `serde_json`으로 직렬화하고 그 바이트를 해시한다. `BTreeMap`은 key 순으로 순회하고 serde는 필드 선언 순서를 지키므로 이미 결정적이다.

### 1.7 바꾸지 않는 것

`format_version`은 `1`로 둔다. 개발 데이터에 파일 포맷 버전을 더하지 말라는 `delivering-yonalist-changes` §1과 릴리즈 전 마이그레이션 금지 규칙에 따른 사용자 결정이다.

따르는 결과가 있다. v1 §3.3의 예약 token 격리가 그대로 남는다. parser는 본문의 `t:`, `prev:`, `from:`, `star`, `todo`, `ordered:`, `done`, `split`, `collapsed`, `<!-- ya:`를 무시하지 않고 개발 포맷 불일치로 격리한다. frontmatter의 `max_hlc`, `root_hlc`, `root_*`도 같다. 같은 `format_version: 1`을 단 예전 파일이 조용히 섞이는 것을 막는 유일한 장치다. 남는 위험도 적어 둔다. 옛 빌드가 새 vault를 읽으면 버전이 같아 격리하지 않고 파싱한 뒤 새 HLC를 찍어 되쓴다. 파일은 망가진다. 막을 코드는 없고 개발자 규율과 vault 백업이 대책이다.

SQLite도 같다. `user_version`은 `1`, `MIGRATIONS`는 빈 배열, `schema.sql`은 제자리에서 고치고 debug 빌드의 `remake_if_an_older_build_made_it`이 모양이 달라진 개발 DB를 다시 만든다.

## 2. 제공 계약

**목표.** 두 기기가 클라우드 폴더 하나를 공유할 때, 서로 다른 곳을 고친 변경은 사람이 읽을 수 있는 Markdown을 유지한 채 자동으로 합쳐지고, 합칠 수 없는 변경은 어느 쪽도 버리지 않는다.

**완료 조건.**

| ID | 사용자에게 보이는 결과 | 기계적 완료 조건 |
|---|---|---|
| A1 | 일반 Markdown 편집기에서 본문을 자연스럽게 읽고 고칠 수 있다 | 각 블릿에 `yid` 주석 하나뿐이고 `\/`·`\+`·`\.` 같은 과잉 escape가 없다. 대표 문서가 parse → render → parse에서 같은 바이트로 돌아온다 |
| A2 | 다른 기기에서 독립적으로 고친 내용이 가능한 한 자동으로 합쳐진다 | 공통 base가 있는 B/L/R 비충돌 사례가 파일 도착 순서와 무관하게 같은 `state_hash`로 수렴한다 |
| A3 | 자동 병합이 확신할 수 없는 변경과 입력 중인 내용은 사라지지 않는다 | 충돌이면 문서를 pending으로 두고 base·local·remote 세 snapshot을 남긴다. 원격 삭제된 줄의 미저장 draft는 복구 기록에 저장된 뒤에만 화면에서 사라진다 |
| A4 | 개발 DB를 지워도 현재 Markdown과 앱 상태를 복구할 수 있다 | 빈 DB에서 포맷 1 vault를 읽으면 본문·계층·순서·상태·`yid`·이미지 표시 폭이 같게 돌아온다. 하위 page에만 Yonalist 증거가 있는 기존 vault를 골라도 guide를 심지 않는다 |
| A5 | 이후 mirror와 블록 참조를 붙일 때 블록 ID를 다시 바꾸지 않는다 | 폴더 이름 변경과 DB 재생성 뒤에도 모든 `yid`와 문서 `state_hash`가 같고 블릿을 다른 부모로 옮기면 snapshot의 placement만 달라지고 block은 그대로다 |

**비대상.** 파일·DB 버전 증가와 변환 코드, 호환 reader. commit ID·DAG·`parents`·`history`(§1.1). `sync_transfers`와 이동 envelope, 그 30일 보존(§1.2). publish journal table과 복구 코드(§1.3). deletion epoch·필드별 draft 세대·세대 upsert(§1.4). LIS·anchor·순서 병합의 cycle 검사(§1.5). 자체 동기화 서버, 계정, CRDT 프로토콜. Git 실행 파일 또는 저장소 의존. 영구 content-addressed object store, block별 Merkle node, 분산 GC. mirror UI와 블록 참조 UI. 자동 문서 분할 승격.

**영향 경계.** React(`notesStore.ts`, `VaultSetupCard.tsx`, `SettingsView.tsx`), IPC(`vault_inspect`/`vault_set`, 충돌 복구 command, ts-rs contract), Rust(`notes-core`, `notes-sync`, `notes-sqlite`, `apps/desktop/src-tauri`), SQLite(`schema.sql` 제자리 수정), 파일 시스템(vault 읽기·쓰기, 조건부 publish), macOS(`renameatx_np`).

**직접 확인할 사용자 시나리오.** 한 클라우드 폴더를 vault로 쓰는 앱 인스턴스 둘을 띄운다. (1) 각각 다른 블릿을 고치면 잠시 뒤 양쪽 화면이 같아진다. (2) 같은 블릿을 양쪽에서 다르게 고치면 그 문서만 멈추고 Settings 복구 화면에 기준·이 기기·파일 세 후보가 뜬다. (3) 한쪽에서 줄을 지우는 사이 다른 쪽에서 그 줄에 글을 치고 있으면 친 글이 복구 화면에 남는다.

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
- [ ] ⌘/Ctrl+Enter — 완료 표시 <!-- yid: Hm4sK8_qW2Pd -->
- [2024 아카이브](2024-아카이브-Ry2mN8_pQ4Kd/README.md) <!-- yid: Ry2mN8_pQ4Kd -->
- ↑/↓ — 항목 사이 이동 <!-- yid: Tn7_bC3xP9La -->

<!-- yonalist
{"state_hash":"sha256:9ac1…07d4","base":"sha256:18c7…72d0","state":{"Df4qM9_wK2Ls":{"collapsed":true},"Qw6Jm2_zR8Ka":{"width":268,"pixel_width":870,"pixel_height":602,"byte_size":38471,"asset_hash":"sha256:7af3…104c"},"Hm4sK8_qW2Pd":{"starred":true},"Ry2mN8_pQ4Kd":{"child_kind":"split"}}}
-->
```

예시 hash는 폭을 줄였다. 실제 값은 `sha256:` 뒤에 소문자 hex 64자를 모두 쓴다.

### 3.2 frontmatter

문서 자체의 기본 정보만 둔다. `kind`(`yonalist-notes` 또는 `yonalist-trash`), `format_version`(항상 `1`), `id`(12자 `yid`, home만 예약값 `root`, trash는 생략), `parent`(분할 문서에만, 매달린 부모 노드의 `yid`), `sort_key`(분할 문서에만, 부모 파일이 아직 없을 때의 배치 fallback).

`max_hlc`, `root_hlc`, `root_marker_kind`, `root_ordered_start`, `root_collapsed`, `root_completed`, `root_starred`는 제거하고 예약 key로 격리한다. root 상태는 footer의 `state[id]`에 둔다. 그 밖의 알 수 없는 key는 지금 동작대로 round-trip한다.

형제 순서는 부모 파일의 boundary 줄 순서가 정본이다. `sort_key`는 부모 파일이 없을 때의 임시 배치에만 쓰고 `state_hash`에 넣지 않는다. 사용자가 기존 문서의 `id`를 바꿔도 자동 rename으로 추측하지 않는다. 같은 경로의 알려진 문서라면 격리하고 새 파일이면서 vault 전체에서 고유할 때만 새 문서로 가져온다.

### 3.3 본문

- UTF-8, 방출 개행은 LF. 입력 CRLF와 CR은 LF로 정규화한다.
- 문서 제목은 첫 H1이고 제목 뒤 인용문이 문서 root note다.
- 각 블릿 마지막에 공백 하나와 `<!-- yid: XXXXXXXXXXXX -->`가 정확히 하나 있다.
- §1.7의 예약 token은 본문에 쓰지 않고 만나면 격리한다.
- `yid` 없는 블릿은 외부 편집기가 만든 신규 노드다. import에서 ID를 발급하고 다음 방출에서 주석을 보충한다. 주석을 지운 블릿도 새 노드로 본다. 본문 유사도로 ID를 추정하지 않는다.
- 한 줄에 관리 주석이 둘 이상 있으면 격리한다.
- 같은 `yid`가 두 파일에 보이면 먼저 boundary 관계와 §7.4의 이동 후보를 대조한다. 부모 boundary 줄과 자식 문서 root 한 쌍은 같은 block의 두 표현으로 허용한다. 어느 관계로도 설명되지 않는 중복만 격리한다.
- fenced code, 제목, 인용문 안의 목록은 문법이 지정한 자리가 아니면 블릿으로 읽지 않는다.

본문이 직접 표현하는 값이 footer의 오래된 상태와 다르면 본문이 이긴다. 체크박스 완료 여부, 번호 목록의 번호, 제목, note가 그렇다.

순서 목록은 `1. `, `2. `로 그린다. 사용자가 앱에서 보는 것과 일반 편집기에서 보는 것이 같아야 하기 때문이다. 번호는 한 행의 속성이 아니라 **run**의 속성이다. run은 한 부모 아래 나란히 선 번호 행들이고 첫 행이 입력된 번호부터 세어 올라가며 그 사이에 다른 marker가 끼면 끊긴다. `outlineOrdered.ts`의 `orderedNumbers`와 `notes-export`가 이미 같게 세므로 파일도 같은 답을 쓴다.

parser는 각 행을 그려진 번호 그대로 읽는다. run의 두 번째 행 이후는 저장된 시작값 대신 세어 올라간 값을 갖게 되는데, 화면에 한 번도 보인 적 없는 값이 정규화되는 것이라 잃는 것이 없다. 오히려 run의 첫 행을 지웠을 때 다음 행이 이어지는 번호를 유지한다.

따라서 `marker`와 `ordered_start`는 문서 root에만 쓴다. 제목 줄은 체크박스도 번호도 그릴 수 없기 때문이다. 블릿의 marker는 전부 본문이 그린다.

### 3.4 문맥별 escape

ASCII 문장부호 전체를 escape하지 않는다. renderer는 Markdown 문법을 실제로 여는 경우만 처리한다.

| 위치 | 처리 | 그대로 두는 예 |
|---|---|---|
| 일반 텍스트 | `\`, `&`, 실제 줄바꿈, 주석 시작 `<!--` | `/`, `.`, `+`, 괄호, 문장 안 `-` |
| 줄 시작 | 목록·번호·heading·quote로 오인될 접두사만 | `Shift+Enter`, `음.` |
| 링크 label | `]`, `\` | 파일명의 `.`, `-` |
| 링크 target | Markdown URL 문법에 필요한 문자만 percent-encode | `/`, `.`, `-`, `_` |
| note | 실제 개행을 blockquote 줄로 렌더 | 일반 문장부호 |

renderer는 사용자 본문의 모든 `&`를 `&amp;`로 방출하고 그다음 사용자 본문의 `<!-- yid:` 또는 `<!-- yonalist`에서 `<`를 `&lt;`로 방출한다. parser는 `&amp;`와 `&lt;`를 왼쪽부터 정확히 한 번만 해석하고 결과를 다시 decode하지 않는다. 그래서 원문의 `&lt;!-- yid:`와 `&amp;lt;!-- yid:`가 한 번의 render/parse 뒤 그대로 남는다.

### 3.5 footer `yonalist`

파일의 마지막 비공백 요소이며 하나만 허용한다. JSON은 한 줄이고 key 순서는 `state_hash`, `base`, `state`로 고정한다. 구조체 필드 선언 순서가 그 고정이다.

```rust
#[derive(Serialize, Deserialize)]
struct Footer {
    state_hash: String,
    base: String,
    state: BTreeMap<BlockId, BlockState>,
}
```

| 필드 | 의미 |
|---|---|
| `state_hash` | 이 파일이 담은 정규 snapshot의 SHA-256 (§5.2) |
| `base` | 이 기기가 마지막으로 파일과 합의한 상태의 `state_hash`. 최초 문서는 빈 문자열 |
| `state` | Markdown이 직접 보존하지 못하는 `yid → 상태` map |

`BlockState`는 전부 `Option`인 평범한 derive 구조체이고 필드는 `collapsed`, `starred`, `completed`, `marker`, `ordered_start`, `width`, `pixel_width`, `pixel_height`, `byte_size`, `asset_hash`, `child_kind`, `restore_parent`, `restore_after`다. 기본값은 `skip_serializing_if`로 생략하고 마지막 `#[serde(flatten)] BTreeMap<String, serde_json::Value>`가 알 수 없는 key를 객체 안에서 round-trip한다. 본문이 marker를 전부 그리므로(§3.3) `marker`와 `ordered_start`는 문서 root에만 나오고, `completed`는 todo가 아닌 노드에만 나온다. 이미지의 `pixel_width`·`pixel_height`·`byte_size`는 asset이 아직 도착하지 않은 기기에서도 placeholder와 DB 행을 같게 복원하는 데 필요하므로 보존한다. asset이 없을 때 MIME은 지금 merger처럼 검증된 링크 확장자로 임시 복원하고 bytes가 도착하면 decode 결과로 다시 검증한다.

외부 편집으로 블릿이 지워져 `state[yid]`가 남는 것은 정상이다. 정규 snapshot을 만들 때 현재 본문에 없는 `yid`의 상태는 버린다. 앱이 쓴 파일에는 애초에 그런 항목이 없으므로 재계산과 선언값이 언제나 같다.

footer가 없으면 일반 Markdown으로 가져올 수 있다. `base`가 없는 것이므로 §5.3의 6·7번을 그대로 탄다. footer가 있는데 JSON을 읽을 수 없거나 `state_hash`가 `sha256:` + hex 64자가 아니거나 footer가 둘 이상이면 부분 적용하지 않고 격리한다.

### 3.6 stale metadata

일반 편집기는 본문만 고치므로 footer의 `state_hash`가 이전 값을 가리키는 것이 정상이다. commit이 없으니 재계산할 것은 하나뿐이다.

1. parser가 현재 본문과 `state`로 정규 snapshot을 만들고 `state_hash`를 다시 계산한다.
2. 재계산값이 선언 `state_hash`와 같으면 앱이 쓴 뒤 아무도 건드리지 않은 파일이다. 이 파일의 조상은 footer의 `base`다.
3. 다르면 선언 상태에서 갈라진 외부 편집이다. 이 파일의 조상은 선언 `state_hash`다.

이 한 번의 비교가 v1 §3.6의 무결성 검증과 변경 판정을 함께 한다. 손상 판정은 §3.5의 문법 검사가 맡는다.

## 4. 식별자와 온보딩

### 4.1 `yid`

```text
길이       12자
문자 집합  A-Z a-z 0-9 _ -
정규식     ^[A-Za-z0-9_-]{12}$
엔트로피   72 bit
생성       getrandom으로 OS CSPRNG 9바이트 → base64 URL_SAFE_NO_PAD
범위       vault 전체에서 UNIQUE
```

9바이트는 3의 배수라 인코딩이 전단사다. padding도 modulo 편향도 없고 두 줄이면 된다. 파일 입력은 신뢰 경계이므로 정규식과 vault 전체 중복을 모두 검사하되, boundary 관계와 이동의 일시적 중복을 §3.3의 순서로 먼저 분류한다.

`notes_nodes.id` 자체가 `yid`다. 내부 UUID와 공개 ID를 이중으로 두지 않는다. home root만 예약값 `root`를 유지한다. 폴더 suffix는 UUID 앞 12자리 대신 문서 `yid` 전체를 쓴다.

파생 ID는 난수를 쓰지 않는다. duplicate 명령의 자식과 누락된 부모의 recovery page는 지금 코드(`notes-core/src/tree.rs:22`, `merger.rs:578`)의 UUID v5 파생을 그대로 두고 결과 16바이트의 앞 9바이트를 같은 base64url로 인코딩한다. namespace와 이름 형식이 그대로이므로 결정성은 이미 있는 것을 다시 쓴다. 새 해시 helper도 새 의존성도 필요 없다.

### 4.2 onboarding seed와 vault 분류

onboarding seed는 source에 고정된 12자 `yid` 집합을 쓴다. 각 상수는 서로 고유하고 §4.1의 정규식을 만족해야 한다. 고정 집합이라 guide fixture와 새 vault가 언제나 같은 block identity를 쓰고 재호출이 idempotent하다.

| 분류 | 조건 | 결과 |
|---|---|---|
| `empty` | 보이는 항목이 없거나 사용자가 "나중에"를 골랐다 | seed |
| `existingYonalist` | `.yonalist/`나 root·하위 `README.md`에서 Yonalist frontmatter를 찾았다 | seed하지 않고 import |
| `nonEmptyUnknown` | 비어 있지 않은데 Yonalist 여부를 확정할 수 없다 | 자동 seed 금지. 사용자의 "새 노트로 사용" 확인을 기다린다 |

하위 문서 감지는 symlink를 따라가지 않고 directory entry 10,000개, 깊이 32까지만 훑는다. `README.md`의 `kind`와 `format_version` frontmatter만 읽어 판정한다. 한도에 닿으면 "없음"이 아니라 `nonEmptyUnknown`이다. 이 보수적 분류가 클라우드에서 page 폴더가 root `README.md`보다 먼저 내려온 경우 새 guide가 기존 ID의 최신 주장으로 올라서는 일을 막는다.

지금 `sync_settings.rs`의 `classify`는 root `README.md`와 `.yonalist/`만 보고 `set_vault_path`는 경로를 먼저 저장한 뒤 분류한다. 확인과 활성화 사이의 경쟁을 막으려면 계약을 둘로 나눠야 한다.

1. `notes_sync_vault_inspect(path)`는 경로를 저장하지도 watcher를 시작하지도 않고 위 분류만 돌려준다.
2. first-run과 Settings가 결과를 보여 주고 `nonEmptyUnknown`이면 명시적 확인을 받는다.
3. `notes_sync_vault_set(path, intent)`가 backend에서 같은 분류를 다시 돌린다. 현재 분류와 `intent`가 맞을 때만 경로 저장과 watcher 시작을 한 번에 진행한다.
4. inspect 뒤 파일 상태가 달라졌거나 확인이 없으면 아무 side effect 없이 `confirmation_required`를 돌려준다.

기존 로컬 노트가 있는 Settings 경로도 이 계약을 거친다. 그래야 미확정 폴더를 활성화한 직후 기존 로컬 노트를 먼저 방출하는 일을 막는다.

## 5. 정규 snapshot, `state_hash`, base

### 5.1 정규 snapshot

snapshot은 원본 Markdown 바이트가 아니라 파싱된 의미다. `notes-sync` 내부 구현이고 새 public API나 범용 저장소 abstraction을 만들지 않는다.

```rust
#[derive(Serialize)]
struct CanonicalSnapshot {
    kind: DocumentKind,                              // "notes" | "trash"
    document_id: String,                             // "root" | yid | "yonalist-trash"
    parent: Option<BlockId>,                         // 분할 문서만
    root_block: Option<BlockId>,
    blocks: BTreeMap<BlockId, SnapshotBlock>,
    placements: BTreeMap<PlacementId, SnapshotPlacement>,
    children: BTreeMap<PlacementId, Vec<PlacementId>>,
    extras: BTreeMap<String, String>,                // 알 수 없는 frontmatter key
}

#[derive(Serialize)]
enum SnapshotPlacement {
    Local { block_id: BlockId, parent: PlacementId },
    Boundary { child_document: String, child_kind: PageOrSplit, parent: PlacementId },
}
```

`SnapshotBlock`은 `kind`, `text`, `note`, `marker`, `collapsed`, `completed`, `starred`, `image: Option<SnapshotImage>`를 든다. `SnapshotImage`는 `original_name`, `asset_hash`, `display_width`, `pixel_width`, `pixel_height`, `byte_size`를 든다. **상대 경로는 넣지 않는다.** 경로는 운송 위치이고 정체성은 `asset_hash`다. 승격·강등으로 경로가 바뀌어도 `state_hash`가 움직이지 않아야 가짜 충돌이 생기지 않는다.

지금 각 block은 primary placement 하나만 가진다. primary placement ID는 `primary:<block_id>`로 파생해 파일에 별도 ID를 쓰지 않는다. 형제 순서는 `children[parent]` 배열이 정본이다. `sort_key`와 predecessor는 DB 행을 만드는 구현 세부일 뿐 snapshot의 순서 모델이 아니다. 부모 문서의 page/split 링크는 `Boundary` placement다. 자식 문서 root 내용을 부모 snapshot에 복제하지 않는다. 자식 파일의 `id`와 링크 줄의 `yid`가 같아야 한다. 링크 label은 자식 제목의 투영이므로 자식 root의 정본은 자식 파일이다.

### 5.2 `state_hash`

1. 모든 문자열을 Unicode NFC로, 개행을 LF로 정규화한다.
2. `CanonicalSnapshot`을 `serde_json::to_vec`으로 직렬화한다. `BTreeMap`은 key 순으로, `Vec`은 표시 순서로, 구조체는 선언 순서로 나가므로 결정적이다.
3. SHA-256을 소문자 hex로 쓰고 앞에 `sha256:`을 붙인다.

계산에서 빠지는 것: `base`, `state_hash` 자신, frontmatter `sort_key`, 파일 경로, mtime, 파일 크기, `exported_hash`, 이미지 상대 경로. HLC는 이 설계에서 아예 사라진다.

### 5.3 base 선택과 결정표

기호를 셋만 쓴다. `L`은 현재 DB 트리의 `state_hash`, `agreed`는 `sync_documents.base_state_hash`, `R`은 파일에서 재계산한 `state_hash`다. `Rd`는 footer의 선언 `state_hash`, `Rb`는 footer의 `base`이고 파일의 조상은 §3.6이 정한다: `Ra = if R == Rd { Rb } else { Rd }`.

**`agreed`는 병합·fast-forward·최초 채택에서만 전진한다.** 곧 아래 표의 3·6번과 5번의 병합 성공뿐이고 그때 상대편이 들고 있던 `R`로 옮겨 간다. **2·4·7번은 `agreed`를 건드리지 않는다.** 로컬 편집도 그 편집의 발행도 마찬가지다. 이 규칙이 §1.1을 성립하게 하는 전부다. 오프라인에서 X→1→2→3을 발행하는 기기가 세 파일 모두에 `base: X`를 찍는 것이 이 규칙의 결과다.

| # | 조건 | 결정 |
|---|---|---|
| 1 | 파일 byte hash == `exported_hash` | echo. parse 전에 끝난다 |
| 2 | `R == L` | 의미가 같다. DB도 `agreed`도 그대로 두고 파일도 덮지 않는다 |
| 3 | `L == Ra` | fast-forward. 파일을 그대로 적용하고 `agreed := R` |
| 4 | `R == agreed` | 파일이 뒤처졌다. 병합하지 않고 다음 export가 `L`을 쓴다 |
| 5 | `sync_snapshots`에 `Ra`의 본문이 있다 | base = `Ra`로 3-way 병합 |
| 6 | base 없음이고 로컬 변경 없음 | 파일을 새 기준으로 채택하고 `agreed := R` |
| 7 | base 없음이고 양쪽 변경 | 문서 전체 충돌. pending, 원본 파일 유지 |

"로컬 변경 없음"은 `L == agreed`이거나 이 문서 아래에 `sync_dirty_nodes` 행이 없는 것이다. 빈 DB에서 `agreed`가 빈 문자열인 경우를 두 번째 조건이 받는다.

2번이 `agreed`를 건드리면 안 되는 이유가 있다. 이 행은 상대가 보낸 파일에만 걸리지 않는다. 외부 도구가 우리가 방금 쓴 파일의 공백만 손보면 byte echo가 빗나가는데 의미는 그대로여서 `R == L`이 성립한다. 거기서 `agreed`를 옮기면 그것이 바로 위 규칙이 금지하는 로컬 발행 전진이다(§12 반박 5).

그래서 잃는 것도 없다. 파일이 진짜로 상대편에서 수렴해 온 경우라면 그 수렴을 만든 3·5·6번이 이미 `agreed`를 옮겨 놓았다. 두 기기가 우연히 같은 상태에 닿은 경우에도 상대의 다음 발행이 그 수렴 상태를 `Ra`로 선언하고 `L`이 이미 그 값이므로 3번이 받는다.

`Ra`의 본문이 없으면 `agreed`로 대신하지 않는다. 조상이 아닌 상태를 base로 쓰면 상대의 진짜 편집이 조용히 버려질 수 있고 6·7번이 이미 그 경우를 사용자에게 묻는 쪽으로 돌린다. 병합이 충돌로 끝나면 `agreed`는 움직이지 않는다. 합의가 이루어지지 않았다.

## 6. SQLite

### 6.1 개발 스키마 변경 원칙

`PRAGMA user_version = 1`과 `SCHEMA_VERSION = 1`을 유지하고 `MIGRATIONS`는 계속 비워 두고 `schema.sql`의 최종 모양을 직접 고친다. debug 빌드는 기존 `remake_if_an_older_build_made_it`으로 모양이 다른 개발 DB를 다시 만든다. 기존 개발 vault와 fixture는 변환하지 않는다. release build에 이 포맷을 내기 전에 릴리스 마이그레이션 정책을 다시 정한다. 이번 설계에는 없다.

### 6.2 최종 스키마

`notes_nodes.id`는 `root` 또는 유효한 12자 `yid`만 받는다.

지우는 것: `sync_node_exports` table, `notes_nodes.hlc`, `notes_nodes.sync_prev`, `notes_nodes.sync_prev_hlc`, `sync_documents.applied_max_hlc`. 세 stamping trigger는 `UPDATE … SET hlc = yona_hlc()` 본문을 잃고 `sync_dirty_nodes` 표시만 남는다. `notes_nodes_place_au` trigger는 감시하던 두 열이 사라지므로 통째로 없어진다. `hlc.rs`의 `Clock`, `register`, `reseed`, `yona_hlc()` 등록도 함께 사라진다. 변경 감지는 `sync_dirty_nodes`와 `notes_meta.revision`이 맡는다. 이미 그렇게 하고 있다.

```sql
CREATE TABLE sync_snapshots (
    state_hash TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('local', 'file', 'merge')),
    created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX sync_snapshots_document_time
ON sync_snapshots(document_id, created_at);
```

`state_hash`가 primary key다. 내용이 정체성이므로 중복 제거가 공짜다. `snapshot_json`은 TEXT다. 이 crate의 다른 JSON 열이 TEXT이고 `sync_merge.rs`가 이미 `serde_json::from_str`로 읽는다.

`sync_documents`의 최종 `CREATE TABLE`에 넣는다. `pending`이면 이 문서의 자동 방출만 멈추고 다른 문서와 asset 동기화는 계속한다.

```sql
base_state_hash TEXT NOT NULL DEFAULT '',
local_state_hash TEXT NOT NULL DEFAULT '',
file_state_hash TEXT NOT NULL DEFAULT '',
merge_status TEXT NOT NULL DEFAULT 'clean'
  CHECK (merge_status IN ('clean', 'pending', 'quarantined'))
```

`sync_conflict_log`를 제자리에서 아래 모양으로 바꾼다. 병렬로 별도 table과 복구 시스템을 두지 않는다. `kind` 하나로 문서 충돌과 UI-draft 후보가 한 화면·한 repository를 쓴다.

```sql
CREATE TABLE sync_conflict_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('document', 'draft')),
    document_id TEXT NOT NULL,
    node_id TEXT NOT NULL DEFAULT '',
    base_state_hash TEXT NOT NULL DEFAULT '',
    local_state_hash TEXT NOT NULL DEFAULT '',
    remote_state_hash TEXT NOT NULL DEFAULT '',
    provisional_state_hash TEXT,
    expected_local_state_hash TEXT NOT NULL DEFAULT '',
    expected_file_byte_hash TEXT NOT NULL DEFAULT '',
    conflicts_json TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolution_state_hash TEXT
) STRICT;
```

`sync_dirty_nodes`, `sync_assets`, `sync_quarantine`, `notes_ui_state`, revision 경로는 그대로 쓴다.

### 6.3 보존

정리는 도달 가능성 하나로 정한다. 남기는 것은 셋이다.

1. `sync_documents`의 세 head 열 `base_state_hash`·`local_state_hash`·`file_state_hash`가 이름을 대는 본문.
2. 해결되지 않은 `sync_conflict_log` 행이 참조하는 base·local·remote·provisional.
3. **마지막 reconciliation 이후 이 기기가 vault에 발행한 상태.** `source`가 `local` 또는 `merge`이고 `created_at`이 현재 `base_state_hash` 행의 `created_at`보다 뒤인 행이며 문서당 최근 16개까지 센다.

3번이 이 규칙의 무게를 다 진다. 상대가 선언하는 `Ra`는 이 기기가 발행한 상태 중 아무것이나 될 수 있는데 그중 지금 head인 것은 하나뿐이다. 3번이 없으면 두 기기의 평범한 교대 편집이 매번 문서 전체 충돌이 된다(§12 반박 6). 1번의 나머지 두 열은 그 자체로 병합을 구해 주지 않는다. `Ra`가 현재 로컬 head면 §5.3의 3번이 본문을 찾기 전에 fast-forward로 끝나고 현재 file head면 `agreed`가 이미 같은 값이다. 그래도 셋을 함께 적는 이유는 GC 술어를 "어느 head 열도 이름을 대지 않으면 지운다" 한 줄로 두기 위해서다.

`agreed`가 전진하는 순간 그 이전 발행분은 한꺼번에 수거된다. 그래서 3번의 집합은 스스로 비워지고 v1의 30일·50개 window처럼 쌓이지 않는다. 상한 16을 넘도록 reconciliation 없이 발행만 이어지면 가장 오래된 것부터 버리고 §13의 한계를 받는다.

`source`는 3번의 판정에만 쓴다. DB 트리에서 만든 snapshot이 `local`, 파일에서 파싱한 것이 `file`, 3-way 병합 결과가 `merge`다.

이 snapshot들이 참조하는 asset도 함께 pin한다. 정리는 성공한 export 뒤 짧은 별도 transaction에서 하고 정리 실패는 저장 공간만 늘릴 뿐 동기화를 실패시키지 않는다.

## 7. 3-way 병합

### 7.1 필드

각 block 필드와 placement 위치를 B(base), L(local), R(remote)로 비교한다. `L == B`이고 `R != B`면 R, `R == B`이고 `L != B`면 L, `L == R`이면 그 값, 셋이 모두 다르면 그 필드 충돌이다. 내용과 위치를 따로 비교한다. 한쪽이 본문을 고치고 다른 쪽이 같은 block을 옮겼다면 둘을 합친다.

### 7.2 생성·삭제

- 한쪽만 만든 새 `yid`는 더한다. 양쪽이 같은 `yid`를 같은 내용으로 만들었으면 한 번만 더한다.
- 같은 `yid`를 서로 다른 내용으로 만들었으면 ID 충돌로 격리한다.
- 한쪽 삭제, 다른 쪽 무변경이면 삭제한다. 양쪽 삭제면 삭제한다.
- 한쪽 삭제, 다른 쪽 편집·이동이면 삭제/수정 충돌이다.

### 7.3 diff3 순서 병합

부모마다 `children[parent]`의 placement ID 배열 셋을 놓는다. `similar::capture_diff_slices`를 base→local, base→remote로 두 번 돌리고 두 op 배열을 base index 위에서 겹쳐 읽는다.

| 겹침 | 결과 |
|---|---|
| 한쪽만 바꾼 구간 | 그쪽 결과 |
| 양쪽이 같게 바꾼 구간 | 한 번 적용 |
| 양쪽이 다르게 바꾼 구간 | 순서 충돌. 잠정 결과는 base 순서를 쓰고 `{parent, base_slice, local_slice, remote_slice}`를 기록한다 |
| 같은 base 위치에 양쪽이 다른 것을 끼워 넣음 | 둘 다 보존 |

같은 자리에 끼워 넣은 두 덩어리의 앞뒤는 각 덩어리의 placement ID 최솟값을 바이트 비교해 정하고 덩어리 안의 순서는 각자 그대로 둔다. 어느 기기가 계산해도 같은 답이고 여러 줄을 붙여 넣은 덩어리가 흩어지지 않는다. 앞 형제의 이동이 뒤 형제를 이동으로 만들지 않는다. 배열 diff에는 predecessor 개념이 없어서 그렇다.

병합 뒤 ID 유일성, placement 1회 소유, 자식 문서 boundary 일치를 검사한다. 실패하면 부분 결과를 적용하지 않고 문서를 격리한다. 부모 cycle은 이미 있는 `repair_structure`의 recovery page 파킹이 그대로 처리한다. 새 cycle 검사를 만들지 않는다.

### 7.4 문서 경계를 넘는 이동

한 block의 primary placement는 vault 전체에서 한 문서만 소유한다. 문서별 병합 결과를 곧바로 적용하지 않고 한 안정화 묶음 안에서 `yid → document_id` claim을 모은다. 묶음은 queue에 대기·검증·처리 중인 경로가 하나도 없을 때 닫히고 늦어도 quiet window의 정해진 배수에서 닫힌다.

| 묶음 안에서 본 것 | 결과 |
|---|---|
| B에 추가 + A에서 제거 | 한 transaction에서 소유권을 B로 옮긴다 |
| B에 추가만. DB는 아직 A가 소유한다고 말하고 A의 파일은 이 묶음에서 다시 읽히지 않았다 | 보류. 삭제하지도 복제하지도 않고 B 문서를 `pending`으로 두어 자동 방출을 막는다 |
| B에 추가만. DB에 A 소유 기록이 없다 | 평범한 이동으로 적용한다 |
| A에서 제거만 | 아무것도 하지 않는다. 부재는 삭제가 아니고 다음 방출이 줄을 다시 쓴다 |
| 묶음이 닫힌 뒤에도 A와 B가 모두 그 `yid`를 싣는다 | 중복으로 격리한다 (§3.3) |

두 번째 줄의 `pending`이 필요한 이유가 있다. 보류한 추가를 반영하지 않은 채 B 문서를 다시 방출하면 상대 기기가 남긴 이동 증거를 우리가 지운다.

영속 저장은 필요 없다. 짝짓기의 증거는 파일 자체이고 앱이 묶음 중간에 죽어도 다음 시작 scan이 두 파일을 다시 읽어 같은 묶음에서 다시 짝짓는다.

### 7.5 조건부 publish

`write_checked`의 render 자가검증과 사전 hash 비교는 그대로 둔다. 비교 뒤 target을 덮는 사이의 창만 닫는다.

1. target이 없으면 기존 `RENAME_EXCL` 경로를 쓴다. `EEXIST`면 새 target을 읽어 병합한다.
2. target이 있으면 같은 디렉터리의 `<문서>.publish-tmp`에 쓰고 flush한다.
3. `renameatx_np(RENAME_SWAP)`으로 tmp와 target을 맞바꾼다. 이제 tmp에 밀려난 원본이 있다.
4. tmp의 hash가 `exported_hash`와 같으면 tmp를 지우고 새 hash를 기록한다.
5. 다르면 그 사이에 누군가 고친 것이다. tmp를 `move_no_replace`로 `<이름>.conflict.md`로 옮기고(이름이 차 있으면 뒤에 번호) 문서를 dirty로 둔다. 다음 scan이 `is_conflicted_copy`로 알아보고 §7.6 경로로 병합한다.
6. 시작 시 vault에 남은 `*.publish-tmp`를 같은 방식으로 충돌 사본 이름으로 옮긴다.

되돌리는 swap을 하지 않는다. 두 후보가 각각 target과 충돌 사본으로 살아 있고 병합이 그것을 처리한다. 다시 맞바꾸면 경쟁 창이 하나 더 생길 뿐 남는 것이 같다. DB commit 뒤 publish 전에 죽으면 dirty와 head 차이로 다시 방출한다. swap 뒤 기록 전에 죽으면 파일 hash와 `exported_hash`가 달라 다음 scan이 병합한다. journal이 하던 일이 둘 다 이미 있는 경로다.

### 7.6 충돌 사본

기존 `is_conflicted_copy`와 시작 scan을 쓴다. 이름이 비슷해도 문서 `id`가 다르거나 알아볼 수 없으면 사용자 파일로 보고 손대지 않는다. 같은 문서 `id`를 가진 정본과 사본은 순서대로 병합한다. 정본을 먼저 읽고 그다음 사본을 그 결과에 대해 병합한다. 사본도 자기 `Ra`를 선언하므로 §5.3의 표를 그대로 탄다. 자동 병합되면 정본만 새 snapshot으로 쓰고 사본은 `move_no_replace`로 `.yonalist/resolved-conflicts/`에 옮겨 30일 보존한다. 충돌하면 두 원본을 그대로 두고 pending으로 기록한다.

## 8. 충돌 보존과 해결

충돌을 찾으면 기존 `sync_merge` transaction 안에서 base·local·remote snapshot, 자동 병합 가능한 잠정 snapshot, 충돌 목록, 예상 local head와 현재 파일 byte hash를 저장한다. 문서를 pending으로 바꾸고 자동 export만 멈춘다. 원본 Markdown에 Git conflict marker를 쓰지 않는다.

기존 Settings 복구 화면을 늘려 블릿별로 기준·이 기기·파일을 보여 주고 고르게 한다. 본문·상태는 이 기기/파일/둘 다 유지/직접 수정, 위치는 이 부모/파일의 부모/직접 선택, 삭제/수정은 삭제/복원/직접 수정이다.

해결을 적용하기 직전에 저장된 `expected_local_state_hash`와 `expected_file_byte_hash`를 다시 확인한다. 하나라도 달라졌으면 오래된 결과를 쓰지 않고 최신 세 후보로 다시 병합한다. 같을 때만 새 결과를 만들고 §7.5로 발행한다.

### 8.1 원격 삭제와 미저장 draft

순서가 전부다.

1. 삭제 알림에서 draft를 든 ID를 추려 recording set에 넣는다. set에 있는 동안 `setDraft`/`setNoteDraft`는 메모리 값만 갱신하고 debounce timer나 command를 만들지 않는다.
2. 이미 걸린 timer를 동기적으로 취소한다.
3. 현재 text와 note를 `kind = 'draft'` 복구 항목으로 저장하고 끝나기를 기다린다.
4. 응답 뒤 메모리 값이 그사이 달라졌으면 3번을 한 번 더 한다. 정해진 횟수 안에 따라잡지 못하면 draft를 화면에 그대로 두고 sync error를 표시한다.
5. 따라잡았으면 set에서 빼고 화면의 draft를 지운 다음 삭제를 반영한다.
6. 저장이 실패하면 삭제를 반영하지 않고 draft와 pending을 그대로 둔다.

세대값도 epoch도 없다. 4번의 재확인이 "쓰기가 도는 동안 들어온 마지막 입력"을 받는 유일한 장치이고 recording set은 "사라질 노드에 command를 보내지 않는다"는 지금 코드의 약속을 지키는 최소치다. 삭제→복원 합치기는 `syncChanged.ts`가 지금 하는 그대로 둔다. 한 묶음 안에서 지워졌다가 돌아온 ID는 changed로만 전달되므로 위 순서가 시작조차 하지 않는다.

UI-draft 후보는 command 응답으로 자동 resolve하지 않는다. 복원 뒤 새 입력과 정상 저장이 이어져도 삭제 시점까지 보존한 후보는 복구 기록으로 남는다. 사용자가 복구 화면에서 삭제 유지, draft로 복원, 직접 수정, 닫기 중 하나를 명시적으로 고를 때만 resolved가 된다. 그래서 응답과 새 draft의 도착 순서를 맞추는 상태 기계가 필요 없다. 해결되지 않은 복구 행과 그 행이 참조하는 asset pin은 함께 보존한다.

## 9. 휴지통, asset, 미래 경계

삭제는 snapshot에서 block과 placement를 빼는 것이다. 한쪽 삭제와 다른 쪽 수정은 언제나 충돌이다. trash는 `restore_parent`와 `restore_after`를 footer `state`에 보존한다. 지금 구현의 안전 규칙을 그대로 유지한다.

- 복원으로 trash의 소유 항목이 바뀌면 trash 문서도 dirty가 된다.
- 빈 trash 파일은 현재 byte hash가 마지막 앱 방출 hash와 같을 때만 지운다.
- 외부가 바꾼 trash는 지우지 않고 병합한다.
- hard delete와 snapshot 정리는 해결되지 않은 충돌이 참조하는 subtree를 건드리지 않는다.

asset의 정체성은 상대 경로가 아니라 전체 SHA-256이다. footer에는 `width`, `pixel_width`, `pixel_height`, `byte_size`, `asset_hash`를 둔다. 상대 경로는 운송 위치이므로 `state_hash`에 들어가지 않는다(§5.1). 도착하지 않은 asset은 이 정보로 placeholder와 waiting row를 복원하고 그 asset을 참조하는 snapshot이나 충돌이 있는 동안 정리하지 않는다.

`yid`는 block identity다. block은 본문·note·의미 상태를 한 번 소유하고 placement는 어느 부모의 어느 순서에 보이는지를 소유한다. mirror가 생겨도 mirror 줄마다 새 `yid`를 주어 같은 내용을 복제하지 않고 placement ID만 더한다. 미래 문법은 `<!-- yid: BLOCK pid: PLACEMENT mirror -->`처럼 늘릴 수 있으나 지금 parser는 그것을 미리 만들지 않는다. 알 수 없는 관리 token을 보존할 수 있는 경계와 snapshot의 block/placement 분리만 유지한다. `[[…]]` 블록 참조는 `yid`를 대상으로 하고 참조 해석기·backlink index·mirror UI는 실제 요구가 생길 때 만든다.

## 10. 구현 항목

각 항목은 기존 경로를 세로로 완성하고 병렬 시스템을 만들지 않는다. 순서대로 하나씩, 항목마다 한 커밋이고 항목이 명시한 파일 밖은 건드리지 않는다.

### M1. 포맷 1 codec과 `yid` — A1

**여는 실패 test**: `crates/notes-sync/tests/render_goldens.rs::the_representative_page_renders_and_reads_back_unchanged`
대표 문서를 render하면 블릿마다 `yid` 주석 하나뿐이고 frontmatter에 `max_hlc`·`root_*`가 없고 footer가 세 key뿐이고 parse → render가 같은 바이트를 낸다. 지금은 `render_page`가 `max_hlc`/`root_hlc`를, `render_comment`가 `t:`를 쓰므로 빨갛다.

**만지는 파일**: `crates/notes-core/{Cargo.toml, src/id.rs, src/tree.rs}`, `crates/notes-sync/{Cargo.toml, src/document.rs, src/parse.rs, src/render.rs, src/layout.rs}`, `crates/notes-sqlite/src/seed.rs`(고정 yid 상수만), `apps/desktop/src/store/storeSupport.ts`, `crates/notes-sync/tests/{parse_leniency.rs, render_goldens.rs}`, fixture.

`notes-core`: `getrandom`+`base64`로 12자 `yid` 생성·검증, 파생 ID는 UUID v5 결과의 앞 9바이트를 같은 인코딩으로. `notes-sync`: `serde`+`serde_json` 추가, `document.rs`에서 HLC 필드 제거하고 footer 모델 도입, parser의 UUID 검증을 yid 검증으로 바꾸고 예약 token 격리, `render.rs`를 새 문법과 문맥별 escape로, `layout.rs`의 폴더 suffix를 문서 `yid`로.

### M2. snapshot 저장과 `state_hash` — A5

**여는 실패 test**: `crates/notes-sqlite/tests/sync_merge_seam.rs::a_rebuild_reproduces_the_state_hash_and_a_move_touches_only_the_placement`
문서를 만들고 `state_hash`를 잰다. page 폴더 이름을 바꾸고 DB를 지운 뒤 vault를 다시 읽으면 모든 `yid`와 `state_hash`가 같다. 블릿 하나를 다른 부모로 옮기면 snapshot JSON의 `blocks`는 그대로이고 `children`과 `state_hash`만 달라진다. 지금은 `state_hash`가 없으므로 빨갛다.

**만지는 파일**: `crates/notes-sqlite/src/{schema.sql, schema.rs, mutations.rs, worker.rs, sync_merge.rs}`, `crates/notes-sync/src/{lib.rs, snapshot.rs(신규), merger.rs, export.rs, hlc.rs(삭제)}`, `apps/desktop/src-tauri/src/sync_runtime.rs`, `crates/notes-sqlite/tests/{sync_stamping.rs, schema_drift.rs, sync_merge_seam.rs}`.

`schema.sql`에서 §6.2의 열·table·trigger를 빼고 `sync_snapshots`·document head 열·새 `sync_conflict_log`를 넣는다. `snapshot.rs`가 현재 트리 ↔ `CanonicalSnapshot` 변환과 `state_hash`를 소유한다. `Clock`을 지우면서 `merge_document`·worker·runtime의 서명에서 함께 뺀다. debug DB 자동 재생성을 확인한다. 이 항목이 가장 넓다.

### M3. 순수 3-way 병합 — A2

**여는 실패 test**: `crates/notes-sync/tests/merge_algebra.rs::prop_three_way_merge_converges_whichever_file_arrives_first`
공통 base에서 갈라진 두 문서를 만들고 두 DB가 서로의 파일을 어느 순서로 읽어도 같은 `state_hash`에 닿는지를 property로 확인한다. 지금은 3-way 병합이 없으므로 빨갛다.

이 항목이 v1 M6을 흡수한다. 같은 block에 placement 둘을 만든 fixture test 하나를 함께 둔다: 병합이 block 내용을 복제하지 않고 placement만 둘로 유지하는지 본다. acceptance 증명은 아니고 미래 mirror의 경계 확인이다.

**만지는 파일**: `crates/notes-sync/{Cargo.toml(+similar), src/merger.rs, src/diff3.rs(신규)}`, `crates/notes-sync/tests/{merge_algebra.rs, merge_ingest.rs}`.

`merger.rs`의 HLC 승자 판정과 `SiblingOrder`를 §7의 필드 병합과 diff3 순서 병합으로 갈아 끼운다. `json_object`/`json_string`/`Value`와 `export.rs`의 `json_list`를 `serde_json`으로 대체한다. 병합 뒤 불변식 검사를 붙인다.

### M4. watcher·transaction·export·vault 설정 연결 — A4

**여는 실패 test**: `crates/notes-sqlite/tests/two_devices.rs::a_wiped_database_comes_back_from_the_vault_alone`
vault를 만든 뒤 DB 파일을 지우고 다시 열어 vault를 읽으면 본문·계층·순서·상태·`yid`·이미지 표시 폭이 모두 같다. 지금은 포맷과 스키마가 달라 빨갛다.

**함께 두는 test**(acceptance 증명은 아니지만 A4의 두 번째 절과 §7.4·§7.5를 잠근다):
`crates/notes-sqlite/tests/onboarding_seed.rs::a_vault_whose_only_evidence_is_a_sub_page_is_imported_rather_than_seeded`,
`…::a_non_empty_unknown_folder_seeds_nothing_before_the_user_says_so`,
`…::choosing_a_folder_stores_no_path_and_starts_no_watcher_before_confirmation`,
`crates/notes-sync/tests/watch_queue.rs::a_block_added_in_one_document_and_removed_from_another_moves_once`,
`crates/notes-sync/tests/export_core.rs::an_edit_that_lands_between_the_check_and_the_swap_survives_as_a_conflicted_copy`,
그리고 통과 상태를 유지해야 하는 기존 trash 회귀 test `export_core.rs::{a_trash_that_empties_takes_its_file_with_it, an_unread_trash_from_elsewhere_is_not_removed, an_emptied_trash_stops_putting_itself_in_the_queue}`와 `sync_merge_seam.rs::a_restored_node_takes_the_trash_file_with_it`.

**만지는 파일**: `crates/notes-sync/src/{watch_queue.rs, watcher.rs, export.rs, file_io.rs}`, `crates/notes-sqlite/src/{seed.rs, sync_merge.rs}`, `crates/notes-application/src/contracts.rs`, `apps/desktop/src-tauri/src/{vault_watch.rs, sync_settings.rs, lib.rs}`, `apps/desktop/src/{VaultSetupCard.tsx, SettingsView.tsx}`, `packages/contracts/generated/*`, 해당 test 파일들.

`file_io.rs`에 `RENAME_SWAP`을 더하고 `export.rs`의 `write_checked` 뒤에 §7.5를 붙인다. `watch_queue.rs`에 §7.4의 claim 짝짓기를 더한다. `sync_settings.rs`의 분류를 세 갈래로 넓히고 `vault_inspect`/`vault_set(path, intent)` 두 command로 나눈다.

### M5. 충돌 보존과 해결 — A3

**여는 실패 test**: `apps/desktop/src/notesStore.test.ts::원격 삭제된 줄의 미저장 draft는 복구 기록에 저장된 뒤에만 사라진다`
draft를 든 노드의 삭제 알림을 흘려보내면 복구 기록 저장 command가 먼저 나가고 그 응답 전에는 화면의 draft가 남아 있으며 저장이 실패하면 삭제가 반영되지 않는다. 지금 `absorbVaultChange`는 저장 없이 draft를 버리므로 빨갛다.

**만지는 파일**: `crates/notes-sqlite/src/sync_merge.rs`, `crates/notes-application/src/contracts.rs`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src/{notesStore.ts, store/storeDrafts.ts, SettingsView.tsx, notesStore.test.ts, SettingsView.test.tsx}`, `packages/contracts/generated/*`.

기존 복구 repository를 구조화된 충돌 후보로 넓히고 Settings 화면에 블릿·위치·삭제 해결을 더한다. stale local head 또는 파일 hash에서는 해결 적용을 거부하고 다시 병합한다. pending 문서만 멈추고 나머지 동기화는 계속한다.

### 완료 조건 대응

| Acceptance | 항목 | 여는 실패 test |
|---|---|---|
| A1 | M1 | `notes-sync/tests/render_goldens.rs::the_representative_page_renders_and_reads_back_unchanged` |
| A5 | M2 | `notes-sqlite/tests/sync_merge_seam.rs::a_rebuild_reproduces_the_state_hash_and_a_move_touches_only_the_placement` |
| A2 | M3 | `notes-sync/tests/merge_algebra.rs::prop_three_way_merge_converges_whichever_file_arrives_first` |
| A4 | M4 | `notes-sqlite/tests/two_devices.rs::a_wiped_database_comes_back_from_the_vault_alone` |
| A3 | M5 | `apps/desktop/src/notesStore.test.ts::원격 삭제된 줄의 미저장 draft는 복구 기록에 저장된 뒤에만 사라진다` |

## 11. 완료 gate

**포맷.** `format_version: 1`과 `user_version = 1`이 유지된다. 대표 page·home·split·trash가 parse → render → parse에서 같은 정규 snapshot을 낸다. 실제 `<!-- yid:`, 문자 그대로의 `&lt;!-- yid:`, `&amp;lt;!-- yid:`가 각각 가역적으로 round-trip한다. 본문에는 `yid` 외 줄별 metadata가 없고 frontmatter에는 문서 기본 정보만 있다. 예약 token이나 예약 frontmatter key를 실은 파일은 격리된다. footer가 stale인 정상 외부 편집과 손상된 footer를 구분한다.

**데이터 보존.**

- DB를 지운 뒤 새 포맷 vault에서 본문·계층·순서·상태·이미지 폭을 복원한다.
- root 또는 하위 page에서 Yonalist frontmatter를 찾은 기존 vault를 고르면 guide를 심지 않고 파일의 block identity를 그대로 가져온다.
- 비어 있지 않은 미확정 폴더는 명시적 확인 전에 guide를 심지 않는다.
- first-run과 Settings 모두 확인 전에는 vault 경로를 저장하지도 watcher/export를 시작하지도 않는다.
- onboarding seed는 고정 `yid`를 쓰고 두 번 호출해도 문서를 중복 생성하지 않는다.
- 같은 블릿의 양쪽 수정, 삭제/수정, 상반된 이동은 pending이고 세 후보가 남는다.
- 충돌 해결 직전 파일 또는 DB가 바뀌면 오래된 결과를 쓰지 않는다.
- 사전 hash 검사와 교체 사이에 외부 편집이 들어와도 두 후보 중 어느 것도 사라지지 않고 시작 시 남은 `*.publish-tmp`는 충돌 사본으로 살아남아 병합된다.
- 같은 알림 묶음에서 지워졌다가 돌아온 줄은 changed로 전달된다.
- 삭제된 줄의 timer는 영속화 대기 전에 멈추고 draft 값은 복구 항목 저장 전에 버려지지 않는다. 저장이 실패하면 삭제를 반영하지 않는다.
- draft 영속화가 도는 동안 들어온 마지막 입력도 새 command를 만들지 않고 복구 항목에 저장된다.
- 복원 뒤 command가 성공하거나 새 입력이 이어져도 UI-draft 후보는 자동 resolve되지 않는다.
- trash와 asset 회귀 test가 통과한다.

**병합.** 서로 다른 블릿 수정, 본문/이동, 서로 다른 새 블릿은 자동 병합된다. 앞 형제 이동이 손대지 않은 뒤 형제의 거짓 이동을 만들지 않는다. 문서 A→B 이동에서 두 파일의 도착 순서를 바꿔도 block이 삭제되지도 복제되지도 않는다. 짝을 못 찾은 추가를 든 문서는 자동 방출하지 않는다. base snapshot이 없으면 자동 2-way 삭제·이동 추정을 하지 않는다.

**저장소 검증.**

```bash
cargo test -p notes-core
cargo test -p notes-sync
cargo test -p notes-sqlite
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo fmt --all --check
npm -C apps/desktop test
npm run lint
npm run build
npm run test:architecture
npm run test:contracts
git diff --check
```

## 12. 리뷰 반박

잘라낸 것 중 완료 조건을 실제로 깨는 것은 찾지 못했다. 다만 잘라낸 결과를 규칙으로 옮기는 과정에서 A2를 깨는 구멍 둘이 남았고(반박 5·6) 그 둘은 본문에서 고쳤다. 여섯을 명시한다.

**반박 1 — cut 2는 규칙 하나가 모자란다.** "짝을 못 찾은 절반을 보류한다"만으로는 A3의 "복제도 삭제도 하지 않는다"가 깨진다. A→B 이동에서 B의 파일이 먼저 도착해 추가만 보인다고 하자. 추가를 보류한 채 B 문서의 다른 변경을 병합하고 B를 다시 방출하면 방출된 파일에는 그 줄이 없다. 상대 기기가 남긴 이동 증거를 우리가 지운 것이다. 짝을 못 찾은 추가를 든 문서는 `merge_status = 'pending'`으로 두어 자동 방출을 막아야 한다. §7.4의 두 번째 행과 §11 병합 gate의 네 번째 문장이 이 규칙이다.

**반박 2 — cut 1은 전제 하나 위에서만 성립한다.** `base`를 "직전 로컬 상태"로 읽으면 무너진다. 오프라인에서 X→1→2→3을 발행하는 기기가 세 파일에 각각 `base: X`를 찍는 것은 `agreed`가 로컬 발행으로 전진하지 않기 때문이다. `agreed`를 발행 때마다 전진시키면 상대는 `base: 2`를 받고 그 본문을 가진 적이 없어 base 없음으로 떨어지고 두 기기 사이의 평범한 교대 편집이 매번 문서 전체 충돌이 된다. §5.3에 규칙으로 못박았고 M2 구현에서 이것을 어기면 A2가 통과하지 않는다.

**반박 3 — v1 §14의 gate 명령이 저장소에 없다.** `./scripts/check-notes-architecture.sh`는 존재하지 않는 파일이다. 실제 gate는 `npm run test:architecture`이고 `scripts/checkV2Architecture.mjs`를 부른다. §11에서 바꿔 적었고 Rust·IPC contract·persistence를 모두 건드리므로 `delivering-yonalist-changes` §5의 두 번째 행에 따라 Rust test·formatting과 `test:contracts`를 더했다.

**반박 4 — v1 §13 M4가 지목한 trash 회귀 test 셋은 저장소에 없다.** `restored_node_queues_trash`, `empty_trash_removes_only_owned_bytes`, `empty_trash_clears_echo_record` 어느 것도 존재하지 않는다. 실제로 이 계약을 지키는 test는 `export_core.rs::{a_trash_that_empties_takes_its_file_with_it, an_unread_trash_from_elsewhere_is_not_removed, an_emptied_trash_stops_putting_itself_in_the_queue}`와 `sync_merge_seam.rs::a_restored_node_takes_the_trash_file_with_it`이다. §10 M4에서 바꿔 적었다.

**반박 5 — §5.3 2번은 우리 자신의 파일에서도 걸린다.** 처음 쓴 2번은 `R == L`일 때 `agreed := R`이었다. 이 행은 상대가 보낸 파일에만 걸리지 않는다. A와 B가 X에서 합의한다. A가 Y로 고쳐 `{Y, base: X}`를 발행하면 `agreed_A`는 X로 남는다. 여기까지는 맞다. 그런데 formatter나 클라우드 클라이언트가 그 파일의 공백을 다시 흘리면 byte echo가 빗나가고 다시 읽은 파일은 `R == L == Y`라서 2번이 걸려 `agreed_A := Y`가 된다. §6.3은 이제 Y만 pin하므로 X는 수거된다. X 이후로 오프라인이던 B가 `{Z, base: X}`를 발행하면 A는 `Ra = X`의 본문이 없어 7번, 곧 문서 전체 충돌로 떨어진다. 반박 2가 있어서는 안 된다고 적은 바로 그 실패다. 2번이 `agreed`를 건드리지 않도록 고쳤고 잃는 것이 없다는 확인은 §5.3에 적었다.

**반박 6 — §6.3이 `base` 하나만 pin해 평범한 교대 편집을 깬다. 다만 고침은 head 셋 pin이 아니다.** 처음 쓴 §6.3은 `base_state_hash`의 본문만 남겼다. 공백 장난도 GC 결함도 없이 규칙만으로 깨진다. A와 B가 X에서 합의한다. A가 Y로 고쳐 `{Y, base: X}`를 발행하고 `agreed_A`는 X로 남는다. B는 §5.3의 3번으로 fast-forward해 `agreed_B := Y`가 되는데 이 fast-forward는 파일을 새로 쓰지 않으므로 A는 아무것도 알지 못한다. 이제 둘이 동시에 고쳐 A는 Y→W를 `{W, base: X}`로, B는 Y→Z를 `{Z, base: Y}`로 발행한다. A가 B의 파일을 읽으면 `Ra = Y`, `L_A = W`, `agreed_A = X`다. 5번이 Y의 본문을 찾는데 A는 이미 W로 넘어가 Y를 버렸다. 7번, 문서 전체 충돌이다. A가 맞는 base를 손에 쥐고 있다가 버린 것이다.

리뷰가 처방한 "head 셋을 모두 pin한다"는 이 시나리오를 닫지 못한다. 4번 단계에서 A의 세 head는 base=X, local=W, file=W이고 Y는 어느 열도 이름을 대지 않는다. Y는 A의 **직전** 로컬 head이지 현재 head가 아니다. 두 열을 더 pin해도 구해 주는 경우가 따로 있지도 않다. `Ra`가 현재 로컬 head면 5번이 본문을 요구하기 전에 3번이 fast-forward로 끝내고 현재 file head면 그 값은 우리가 방금 발행한 것(곧 local head와 같음)이거나 우리가 병합해 들인 상대의 상태(곧 `agreed`와 같음)다.

실제로 필요한 것은 하나다. 상대가 `base`로 이름을 댈 수 있는 것은 이 기기가 **발행한** 상태뿐이므로, 마지막 reconciliation 이후 발행한 것을 다 들고 있으면 된다. §6.3의 3번이 그것이고 문서당 16개로 끊는다. `agreed`가 전진하면 통째로 비므로 v1의 30일·50개 window와 달리 쌓이지 않는다. head 셋 pin은 GC 술어를 한 줄로 두려고 함께 넣었을 뿐 이 구멍을 막는 값이 아니다. 리뷰가 준 "보존을 넓히지 말라"를 여기서만 넘었고 넘지 않으면 A2가 통과하지 않는다.

## 13. 알려진 한계

| 한계 | 실패 모습 | 왜 받아들이는가 |
|---|---|---|
| 기기 셋 이상의 criss-cross 병합 | 완전한 DAG라면 찾았을 공통 조상을 찾지 못해 "base 없음 → 문서 충돌"로 더 일찍 떨어진다 | 실패 모습이 사용자에게 묻는 것이지 데이터를 잃는 것이 아니다. 두 기기 교대 편집은 §5.3의 규칙으로 언제나 base를 찾는다 |
| 충돌 사본의 `Ra` 본문이 이미 정리됐을 때 | 사본이 문서 전체 충돌로 떨어진다 | 사본은 보통 정본과 같은 조상을 선언하므로 흔하지 않다. 떨어져도 두 원본이 남는다 |
| 삭제와 복원이 서로 다른 알림 묶음에 걸쳐 올 때 | 화면의 draft는 사라지고 복구 기록에만 남는다 | 한 묶음 안의 왕복은 `syncChanged.ts`가 이미 흡수한다. 걸쳐 오는 경우 값은 보존되고 화면 상태만 잃는다 |
| 옛 빌드가 새 vault를 읽는 경우 | `format_version`이 같아 격리하지 않고 파싱한 뒤 새 HLC를 찍어 되쓴다. 파일이 망가진다 | 개발 데이터에 포맷 버전을 더하지 않는다는 결정의 대가다. 대책은 개발자 규율과 vault 백업이다 |
| 보존이 `base` 하나에서 head 셋 + 마지막 reconciliation 이후 발행분 16개로 | 개발 DB가 문서마다 본문을 최대 열아홉과 미해결 충돌분까지 든다. 16개를 넘도록 reconciliation 없이 발행만 이어지면 가장 오래된 것부터 버리고 그 base를 대는 파일은 7번으로 떨어진다 | 반박 6을 막는 최소값이다. 본문 하나는 문서 하나 분량이고 `agreed`가 전진하면 통째로 비므로 v1의 30일·50개 window처럼 쌓이지 않는다. 16번 발행하는 동안 상대 파일을 한 번도 못 읽는 것은 장기 오프라인이고 그 경우의 실패는 사용자에게 묻는 것이다 |
| M2의 폭 | 스키마·snapshot 타입·Clock 제거가 한 커밋에 든다 | 셋이 같은 이음매라 나누면 중간 상태가 컴파일되지 않는다 |
