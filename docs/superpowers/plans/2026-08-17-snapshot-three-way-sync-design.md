# 읽기 좋은 Markdown과 스냅샷 3-way 동기화 설계

- 작성: 2026-08-17
- 상태: 구현 전 설계 확정안
- 현재 정본: [`docs/v2/sync-spec.md`](../../v2/sync-spec.md)의 포맷 v1
- 전환 조건: 이 문서의 G1~G5를 모두 통과한 뒤 포맷 v2를 정본으로 승격한다.

## 0. 결론

Markdown은 다시 **사람이 읽고 고칠 수 있는 본문**으로 만든다. 각 블릿에는 영구 식별자인 12자 base64url `yid`만 남긴다. 현재 줄마다 붙는 `t`, `prev`, 상태 토큰과 이미지 측정값은 제거한다. 문서 상태 중 Markdown으로 표현할 수 없는 값만 파일 맨 아래의 단일 `yonalist` 주석에 모은다.

동기화는 노드별 HLC 최종 쓰기 승리 방식에서 **기준 스냅샷(base), 로컬(local), 파일(remote)의 3-way 병합**으로 바꾼다. 서로 다른 블릿을 수정했거나 한쪽이 이동하고 다른 쪽이 본문을 수정한 경우 자동 병합한다. 같은 블릿의 같은 필드를 다르게 수정한 경우에는 어느 쪽도 버리지 않고 충돌 해결 화면에서 사용자가 선택한다.

첫 구현에서는 영구 Merkle 객체 저장소나 자체 동기화 서버를 만들지 않는다. 문서 스냅샷과 SHA-256 해시를 기존 SQLite에 저장하고 트리는 매번 선형 시간에 비교한다. 현재 문서 상한에서는 이 방식이 가장 단순하고 충분하다. Merkle은 측정 결과가 필요성을 입증할 때만 추가한다.

## 1. 제공 계약

| ID | 사용자에게 보이는 결과 | 기계적 완료 조건 |
|---|---|---|
| A1 | 일반 Markdown 편집기에서 본문을 자연스럽게 읽고 수정할 수 있다. | 렌더 결과의 각 블릿에는 `yid` 주석 하나만 있고 불필요한 `\\/`, `\\+`, `\\.`가 없다. |
| A2 | 서로 다른 기기에서 독립적으로 고친 내용이 가능한 한 자동으로 합쳐진다. | 공통 base가 있는 B/L/R 조합에서 §8의 비충돌 사례가 모두 같은 결과로 수렴한다. |
| A3 | 자동 병합이 확신할 수 없는 변경은 사라지지 않는다. | 충돌 시 base/local/remote가 모두 보존되며 명시적 해결 전에는 해당 문서를 덮어쓰지 않는다. |
| A4 | DB를 잃어도 현재 Markdown 내용과 블릿 식별자는 복구할 수 있다. | 빈 DB에서 v2 vault를 가져오면 본문·계층·순서·상태·`yid`가 동일하게 복원된다. |
| A5 | 이후 mirror와 블록 참조를 붙일 때 식별 체계를 다시 바꾸지 않는다. | 편집·이동·파일명 변경·DB 재생성 후에도 공개 `yid`가 유지되고, 하나의 블록과 여러 배치를 구분할 수 있다. |

### 1.1 범위

이 설계가 정하는 것은 다음과 같다.

- 포맷 v2의 정확한 파일 모양과 이스케이프 규칙
- 12자 공개 `yid`의 생성·검증·마이그레이션
- SQLite 스냅샷 저장 구조
- 문서 트리 3-way 병합 규칙
- 충돌 보존과 해결 흐름
- 파일 watcher, 원자적 쓰기, 실패 복구 계약
- 미래 mirror·블록 참조가 요구하는 데이터 경계
- Merkle을 지금 쓰는 범위와 나중에 승격하는 조건

### 1.2 하지 않는 것

- 자체 동기화 서버, 계정 시스템, CRDT 네트워크 프로토콜
- Git 저장소나 Git 실행 파일 의존
- 영구 content-addressed object store와 분산 GC
- 포맷 v2와 v1을 무기한 함께 쓰는 이중 쓰기
- mirror UI와 블록 참조 UI의 실제 구현
- 문서 일부만 별도 파일로 쪼개는 새 레이아웃

## 2. 현재 구현에서 바꿀 지점

현재 코드는 이미 필요한 경로의 대부분을 갖고 있다. 새 동기화 시스템을 병렬로 만들지 않고 아래 경로를 교체하거나 확장한다.

| 현재 경로 | 현재 책임 | v2에서의 처리 |
|---|---|---|
| `crates/notes-sync/src/render.rs` | 줄별 `yid`, `t`, `prev`, 상태·이미지 토큰 출력 | v2 renderer와 문맥별 escape로 교체 |
| `crates/notes-sync/src/parse.rs` | 줄 끝 메타데이터 해석 | `yid` 하나와 하단 manifest 해석으로 축소 |
| `crates/notes-sync/src/merger.rs` | HLC LWW와 위치 주장 병합 | 순수 B/L/R 스냅샷 병합기로 교체 |
| `sync_documents` | 파일 hash·mtime·격리 상태 | 현재 head, 마지막 합의 head, 보류 상태를 추가 |
| `sync_node_exports` | 노드별 마지막 방출 fingerprint | v2 전환 후 삭제; 문서 스냅샷이 역할을 대신함 |
| `sync_conflict_log` | 패배한 노드 JSON 보존 | 구조화된 문서 충돌과 세 후보 보존으로 확장 |
| `SettingsView.tsx`의 복구 화면 | 덮인 노트 복구 | 블릿/서브트리 충돌 해결 화면으로 확장 |

현재 `LineState::fingerprint()`와 SHA-256 구현은 canonical node hash의 출발점으로 재사용한다. 단, v1의 HLC와 위치 주장 필드는 새 hash에 포함하지 않는다.

## 3. 식별자

### 3.1 공개 `yid`

`yid`는 Markdown, snapshot, mirror, 블록 참조에서 쓰는 영구 Block ID다.

```text
길이       12자
문자 집합  A-Z a-z 0-9 _ -
정규식     ^[A-Za-z0-9_-]{12}$
엔트로피   72 bit
생성       OS CSPRNG 9바이트를 padding 없는 base64url로 인코딩
범위       vault 전체에서 UNIQUE
```

72 bit 공간에서 개인 vault의 충돌 가능성은 충분히 작지만 확률을 신뢰 경계로 삼지는 않는다. 새 ID를 만들 때 SQLite UNIQUE 제약에 넣고 충돌하면 다시 생성한다. 파일을 가져올 때 중복 `yid`를 발견하면 임의로 고치지 않고 문서를 격리한다.

`yid`는 다음 작업에서 바뀌지 않는다.

- 본문·노트·완료 상태 수정
- 부모·순서·페이지 이동
- 페이지 또는 폴더 이름 변경
- Markdown으로부터 DB 재생성
- mirror 배치 추가·삭제

### 3.2 내부 UUID와 분리

현재 `notes_nodes.id`는 여러 테이블과 명령 경로가 참조하는 내부 UUID다. 이를 한 번에 12자로 바꾸는 것은 사용자 가치를 만들지 않으면서 마이그레이션 범위만 키운다. 따라서 `notes_nodes.public_id TEXT UNIQUE`를 추가하고 파일에는 `public_id`만 `yid`로 쓴다.

- 기존 내부 FK와 IPC는 당분간 UUID를 계속 쓴다.
- parser는 `yid → notes_nodes.id`를 한 번 조회한 뒤 기존 경로로 들어간다.
- snapshot과 향후 사용자 입력 블록 참조는 공개 `yid`만 쓴다.
- 장기적으로 내부 UUID를 없앨 수는 있으나 별도 성능·복잡도 근거가 생기기 전에는 하지 않는다.

### 3.3 기존 UUID의 12자 변환

마이그레이션은 결정적이어야 여러 기기가 같은 v1 vault에서 같은 `yid`를 만든다.

```text
public_id = base64url_no_pad(SHA-256("yonalist-yid-v2\0" || canonical_uuid)[0..9])
```

마이그레이션은 vault 전체 후보를 메모리에서 먼저 계산하고 중복이 없는지 확인한 뒤 한 트랜잭션으로 저장한다. 중복이면 쓰기를 시작하지 않고 사용자에게 두 UUID를 보여 준다. 자동 재시도 salt는 기기마다 다른 결과를 낼 수 있으므로 금지한다.

내부 리터럴 `root` 행도 `public_id`가 필요하다. 로컬 `sync_meta.vault_uuid`는 기기마다 새로 생기므로 ID 재료로 쓰지 않는다. v1 bridge가 vault에 처음 만드는 `.yonalist/format.json`은 `{"format":1,"vault":"<동기화 UUID>","home_root":"<12자>"}`다. CSPRNG로 두 값을 한 번만 만들며 모든 기기가 그 값을 채택한다. 생성 전에는 `home_root`가 v1 UUID 변환 후보와 충돌하지 않는지 검사한다. 파일 생성은 `RENAME_EXCL`로 먼저 성공한 한 기기만 확정한다. `.yonalist/trash.md`는 `notes_nodes` 행이 아닌 문서 모음이라 root block과 `public_id`가 없다.

## 4. 포맷 v2

### 4.1 예시

```markdown
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
{"format":2,"kind":"page","document":"Df4qM9_wK2Ls","root":"Df4qM9_wK2Ls","commit":"sha256:4e6f...64-hex...91a2","state_hash":"sha256:9ac1...64-hex...07d4","merge_base":"sha256:18c7...64-hex...72d0","parents":["sha256:18c7...64-hex...72d0"],"history":[],"transfers":[],"state":{"Xm3_aP9kT2Ws":{"collapsed":true},"Qw6Jm2_zR8Ka":{"width":268,"asset_hash":"sha256:7af3...64-hex...104c"},"Hm4sK8_qW2Pd":{"completed":true}}}
-->
```

실제 hash 값은 생략 없는 소문자 SHA-256 hex 64자다. 예시만 폭을 줄여 표시했다.

### 4.2 본문 규칙

- UTF-8, 방출 개행 LF. 입력 CRLF와 CR은 LF로 정규화한다.
- 문서 제목은 첫 H1이다. 앞의 설명·인용문은 문서 루트의 note로 취급한다.
- 각 Yonalist 블릿의 마지막에는 공백 하나와 `<!-- yid: XXXXXXXXXXXX -->`가 정확히 하나 있다.
- `yid`가 없는 새 블릿은 외부 편집으로 만든 신규 노드다. import할 때 ID를 발급하고 다음 방출에서 주석을 보충한다.
- `yid` 주석이 블릿 중간에 있거나 한 줄에 둘이면 격리한다.
- 일반 사용자가 주석을 삭제한 경우에는 새 블릿으로 본다. 기존 블릿과 본문 유사도로 ID를 추정하지 않는다.
- Markdown heading, 인용문, fenced code block 안의 목록은 포맷이 명시한 위치가 아니면 Yonalist 블릿으로 해석하지 않는다.

### 4.3 문맥별 이스케이프

현재처럼 ASCII 문장부호를 모두 escape하지 않는다. renderer는 Markdown 문법을 실제로 열 수 있는 경우만 처리한다.

| 위치 | escape하는 경우 | 그대로 두는 예 |
|---|---|---|
| 일반 텍스트 | `\\`, 줄바꿈, HTML 주석 시작 `<!--` | `/`, `.`, `+`, 괄호, 문장 안 `-` |
| 줄 시작 | 블릿·번호·heading·quote로 오인될 접두사 | `Shift+Enter`, `음.` |
| 링크 label | `]`, `\\` | 파일명의 `.`, `-` |
| 링크 target | 공백·괄호 등 Markdown URL 문법에 필요한 percent encoding | `/`, `.`, `-`, `_` |
| note | 실제 개행을 blockquote 줄로 렌더 | 일반 문장부호 |

사용자 본문에 `<!-- yid:` 또는 `<!-- yonalist`가 그대로 들어오면 주석 시작의 `<`를 `&lt;`로 렌더해 관리 주석과 구분한다. parser는 이 한 가지 entity를 본문으로 되돌린다.

### 4.4 하단 manifest

manifest는 파일의 마지막 비공백 요소이며 하나만 허용한다. JSON은 UTF-8 한 줄로 쓰고 키 순서를 `format`, `kind`, `document`, `root`, `commit`, `state_hash`, `merge_base`, `parents`, `history`, `transfers`, `state`로 고정한다.

| 필드 | 의미 |
|---|---|
| `format` | 정수 `2` |
| `kind` | `home`, `page`, `split`, `trash` 중 하나 |
| `document` | page/split은 문서 루트의 12자 공개 ID, home/trash는 예약값 `home`/`trash` |
| `root` | 문서 루트 block의 12자 ID. page/split은 `document`와 같고 trash만 생략 |
| `commit` | 앱이 마지막으로 완성해 쓴 commit ID |
| `state_hash` | 그때 본문과 manifest 상태를 정규화해 계산한 의미 hash |
| `merge_base` | 이 commit을 만든 로컬 변경 갈래가 시작된 합의 commit. 최초 commit은 빈 문자열 |
| `parents` | commit의 부모 0~2개. 일반 변경은 1개, 병합 결과는 2개 |
| `history` | 현재 commit에서 가까운 검증 가능한 조상 envelope 최대 8개 |
| `transfers` | 아직 양쪽 도착을 확인하지 못한 문서 간 placement 이동 증거 |
| `state` | Markdown 본문으로 보존할 수 없는 상태만 담는 `yid → object` map |

`state`에 허용하는 v2 키는 `collapsed`, `completed`, `starred`, `marker`, `ordered_start`, `note`, `width`, `asset_hash`, `child_document`, `restore_parent`, `restore_after`다. 기본값은 생략한다. `width`는 이미지의 표시 폭이고 `asset_hash`는 이미지 바이트의 전체 SHA-256이다. `child_document`는 일반 링크와 자식 page/split 문서를 구분한다. `restore_parent`와 `restore_after`는 trash root에서만 허용하며 원래 자리를 복구할 때 쓴다. 본문 문법으로 명백히 표현된 값과 manifest 값이 다르면 본문을 우선하고 다음 방출에서 manifest를 고친다.

이미지의 pixel·byte 크기와 MIME은 파일 바이트에서 다시 계산한다. 사용자 선택인 표시 폭은 v2부터 `state[yid].width`에 반드시 보존한다. 알 수 없는 상태 키는 해당 객체 안에서 그대로 round-trip한다.

home의 page 링크는 해당 줄의 `state[yid].child_document = "page"`를, 분할 링크는 `"split"`을 갖는다. 링크 대상이 자식 문서의 경로다. 자식 파일의 `document`는 부모 링크 줄의 `yid`와 같아야 한다. 빈 DB는 home부터 링크를 따라 문서 경계를 복원하며 부모에서 가리키지 않는 page/split 파일은 삭제하지 않고 고아 문서로 격리한다. 분할 루트의 본문과 상태는 자식 파일이 맡는다. 부모와 형제 순서는 부모 파일의 링크 줄이 맡는다. home/page/split 루트 자체의 상태는 `state[root]`에 둔다.

`history`의 각 envelope는 `{commit, kind, root, state_hash, merge_base, parents, transfers_hash}`만 가지며 snapshot 본문은 넣지 않는다. 현재 parent를 먼저 넣고 parent들의 기존 `history`를 가까운 순서로 합쳐 commit ID가 겹치지 않게 최대 8개만 남긴다. parser는 현재 `document`와 envelope 필드로 commit ID를 다시 계산하고 잘못된 항목이 하나라도 있으면 manifest를 격리한다. 8개 안에서 공통 조상을 찾지 못하면 병합을 추측하지 않고 §8.4로 간다.

`transfers`의 각 항목은 `{id, root_pid, from_document, to_document, subtree_state_hash, confirmed_at}`다. 앱에서 문서 경계를 넘겨 옮길 때 source와 destination manifest에 같은 항목을 쓴다. 목록의 canonical SHA-256인 `transfers_hash`를 commit ID에 포함한다. 두 문서에서 도착을 확인해도 전체 transfer 항목을 `confirmed_at`부터 최소 30일 동안 두 manifest에 계속 싣는다. 30일 뒤 다음 의미 변경 방출에서 제거한다. 그전에는 history의 hash만을 근거로 줄이지 않는다. 30일 넘게 오프라인이었던 기기가 공통 증거를 찾지 못하면 §8.4의 문서 간 충돌로 안전하게 물러난다.

### 4.5 stale manifest의 의미

일반 편집기는 본문만 고치므로 `commit`과 `state_hash`는 이전 값으로 남는다. 이것은 오류가 아니라 3-way 병합의 부모 표식이다.

parser는 먼저 manifest의 `kind`, `document`, `root`, `state_hash`, `merge_base`, `parents`, `transfers_hash`로 선언 `commit`을 다시 계산한다. 맞지 않으면 관리 metadata가 일부만 바뀐 상태이므로 격리한다. 이 검증은 현재 본문 hash와 별개라서 정상적인 외부 본문 편집을 막지 않는다.

- 계산한 현재 의미 hash가 `state_hash`와 같음: 선언 `commit`이 가리키는 완성된 상태다.
- 다름: 현재 파일은 선언 `commit`에서 갈라진 외부 편집 자식이다. importer가 새 의미 hash와 부모 `commit`으로 후보 commit ID를 계산한다.
- local과 remote의 `merge_base`가 같고 SQLite에 그 commit이 있음: 그것을 base로 병합한다.
- 앱이 여러 번 연속 저장해도 그 갈래의 `merge_base`는 바꾸지 않는다. 파일을 import하거나 병합하면 SQLite의 base를 그 결과 commit으로 전진시키고, 그 뒤 처음 만드는 commit부터 새 값을 쓴다. base 표식만 갱신하려고 내용이 같은 파일을 다시 쓰지는 않는다.
- base commit이 없고 로컬 변경도 없음: 현재 파일을 새 기준으로 채택한다.
- base commit이 없고 로컬 변경도 있음: 삭제·이동을 추측하지 않고 문서 단위 충돌로 보류한다.

base 선택 순서는 결정적이다. local commit과 remote 선언 commit/직접 parent가 같으면 먼저 fast-forward한다. 아니라면 remote의 `merge_base`, `parents`, `history`와 local의 SQLite parent graph가 함께 증명하는 공통 조상 중 거리가 가장 짧은 commit을 고른다. 거리까지 같으면 commit ID 바이트가 작은 쪽을 택한다. 연속 로컬 저장의 합의점은 `merge_base`가, 놓친 merge commit의 부모 관계는 `history`가 운반한다. 확인 가능한 후보가 없으면 §8.4로 간다.

## 5. canonical snapshot

### 5.1 데이터 모델

snapshot은 원본 Markdown 바이트가 아니라 파싱된 의미를 저장한다.

```rust
struct DocumentSnapshot {
    format: u8,                 // 2
    kind: DocumentKind,
    document_id: DocumentId,
    root_block: Option<BlockId>, // trash만 None
    blocks: BTreeMap<BlockId, SnapshotBlock>,
    placements: BTreeMap<PlacementId, SnapshotPlacement>,
    children: BTreeMap<ParentPlacement, Vec<PlacementId>>,
}

struct SnapshotBlock {
    kind: NodeKind,
    text: String,
    note: String,
    marker: Marker,
    ordered_start: u32,
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

위 구조는 설계 표기다. 이 타입을 새 public API로 만들 필요는 없고 `notes-sync` 내부 타입이면 충분하다.

v2에서 각 block은 primary placement 하나를 가지며 그 ID는 `primary:<block_id>`로 결정적으로 파생한다. `primary`와 `mirror`는 tag가 다른 namespace다. mirror가 생기면 별도 12자 placement ID를 추가한다. 형제 순서는 `children[parent]`의 stable-ID 배열이다. `sort_key`와 노드별 `predecessor`는 snapshot에 넣지 않는다. 둘 다 배열을 SQLite 행으로 펼칠 때만 계산하는 구현 세부다.

parent 문서의 page/split 링크는 `Boundary` placement이며 local `blocks`에 같은 block을 복제하지 않는다. child 문서의 `root_block`과 `blocks[root]`가 제목·note·상태의 유일한 진실 소스다. parent 링크의 label은 child 제목을 보여 주는 투영이라 의미 hash에서 제외한다. 링크 target은 vault를 읽을 때 child 파일을 찾는 데만 쓴다. target 파일의 manifest가 `Boundary.child_document`와 다르면 격리한다.

### 5.2 정규화와 hash

hash 입력은 다음 순서로 만든다.

1. 문자열을 Unicode NFC와 LF로 정규화한다.
2. block과 placement를 ID 바이트 오름차순으로 순회하고 각 `children` 배열은 표시 순서대로 기록한다.
3. 각 필드를 고정된 tag와 길이-prefix 바이트로 기록한다.
4. 알 수 없는 manifest state는 JSON key 오름차순으로 정규화해 포함한다.
5. `commit`, `merge_base`, `parents`, `history`, `transfers`, mtime, 파일 경로, 내부 UUID, HLC, `sort_key`는 제외한다.
6. 전체 바이트의 SHA-256을 `state_hash`로 쓴다.

JSON 문자열을 이어 붙여 hash하지 않는다. whitespace와 map 순서가 의미 없는 차이를 만들기 때문이다. 기존 `LineState::fingerprint()`의 SHA-256 도우미를 재사용하되 위 직렬화 계약을 한 함수에 둔다.

commit ID는 상태와 이력을 분리한다.

```text
commit_id = SHA-256("yonalist-commit-v2\0" || document_kind || document_id
                   || root_block_id || state_hash || transfers_hash
                   || merge_base_commit || parent_count
                   || sorted(parent_commit_ids))
```

따라서 내용을 예전 상태로 되돌려도 새 commit이 생기고, 결과 내용이 한 parent와 같아도 두 parent를 가진 merge commit을 표현할 수 있다. `merge_base`도 commit에 묶이므로 manifest 일부만 우연히 바뀌어 잘못된 base를 가리키는 일을 검출한다. 부모 순서는 hash 계산 전에 바이트 오름차순으로 정렬한다.

## 6. SQLite 변경

### 6.1 스키마

```sql
ALTER TABLE notes_nodes ADD COLUMN public_id TEXT;
CREATE UNIQUE INDEX notes_nodes_public_id ON notes_nodes(public_id);

CREATE TABLE sync_snapshots (
    commit_id TEXT PRIMARY KEY NOT NULL,
    state_hash TEXT NOT NULL,
    document_id TEXT NOT NULL,
    merge_base_commit TEXT NOT NULL,
    parent1_commit TEXT,
    parent2_commit TEXT,
    snapshot_json BLOB NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('local', 'file', 'merge', 'migration')),
    created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sync_snapshots_document_time
    ON sync_snapshots(document_id, created_at);
```

`notes_nodes.public_id`는 마이그레이션 중에만 NULL일 수 있다. 새 DB의 최종 `schema.sql`에서는 `NOT NULL UNIQUE CHECK(length(public_id) = 12)`로 만든다. SQLite migration의 `ALTER TABLE` 제약 때문에 기존 DB는 backfill과 검증 뒤 동일한 보장을 UNIQUE index와 write path validation으로 유지한다.

기존 `sync_documents`에는 다음 필드를 더한다.

```sql
base_commit_id TEXT NOT NULL DEFAULT '',
local_commit_id TEXT NOT NULL DEFAULT '',
file_commit_id TEXT NOT NULL DEFAULT '',
merge_status TEXT NOT NULL DEFAULT 'clean'
  CHECK (merge_status IN ('clean', 'pending', 'quarantined'))
```

- `base_commit_id`: 로컬 DB와 파일이 마지막 import/merge에서 합의한 head
- `local_commit_id`: 현재 DB 상태의 head
- `file_commit_id`: 마지막으로 읽은 파일의 head
- `pending`: 해결되지 않은 충돌 때문에 이 문서의 자동 방출이 멈춘 상태

`sync_conflict_log`는 즉시 버리지 않는다. v2에서는 `loser_json`에 한 후보만 넣는 대신 별도 `sync_merge_conflicts`를 추가한다.

```sql
CREATE TABLE sync_merge_conflicts (
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
    source_commit TEXT,
    destination_commit TEXT,
    subtree_state_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('one-sided', 'confirmed', 'conflict')),
    recorded_at INTEGER NOT NULL
) STRICT;
```

후보 본문을 `conflicts_json`에 중복 저장하지 않는다. hash로 `sync_snapshots.snapshot_json`을 참조한다. 이 테이블은 기존 복구 UI가 읽는 repository 함수를 확장해 노출한다.

### 6.2 보존과 정리

다음 snapshot은 삭제하지 않는다.

- 모든 `sync_documents`의 base/local/file head
- 해결되지 않은 충돌이 참조하는 base/local/remote/provisional
- 위 head에서 부모를 따라가 처음 만나는 공통 조상까지
- 최근 30일 또는 문서별 최근 50개 중 더 넓은 집합

정리는 성공한 export 이후 별도 짧은 트랜잭션에서 한다. snapshot이 참조한 asset은 함께 pin한다. 정리 실패는 동기화를 실패시키지 않으며, 저장 공간 증가만 허용한다.

## 7. 동기화 상태 기계

```text
파일 변경 감지
  → 안정된 바이트 읽기 + parse + state/commit 계산
  → echo면 종료
  → DB의 local commit 계산
  → 양쪽 merge_base에 해당하는 snapshot 찾기
  → 3-way merge
      ├─ clean: 한 트랜잭션으로 DB 적용·snapshot/head 기록
      │         → 원자적 Markdown 방출 → echo hash 기록
      └─ conflict: 세 snapshot과 충돌 목록 저장
                  → 문서 status=pending, 원본 파일 유지
                  → 사용자 해결 후 새 merge snapshot 방출
```

### 7.1 echo 판정

mtime만으로 echo를 판정하지 않는다. 파일 바이트 SHA-256이 `exported_hash`와 같으면 종료한다. 다르면 parse와 state hash 계산을 수행한다. state hash가 현재 file commit의 값과 같아도 whitespace만 바뀐 것이므로 DB 내용은 바꾸지 않되 사용자가 만든 표현을 다음 의미 변경 전까지 덮어쓰지 않는다.

### 7.2 쓰기 순서

단순한 hash 확인 뒤 `persist`하면 확인과 rename 사이에 들어온 외부 편집을 덮을 수 있다. v2 writer는 `write_atomic` 대신 `publish_if_unchanged(expected_byte_hash, bytes)`를 쓴다.

1. 같은 디렉터리에 이름이 고정된 publish 임시 파일을 만들고 bytes와 디렉터리를 flush한다.
2. 임시 경로, target, expected hash, 새 hash, phase=`prepared`를 Application Support의 publish journal에 원자적으로 기록한다.
3. macOS `renameatx_np(RENAME_SWAP)`으로 target과 임시 파일을 한 번에 맞바꾼 뒤 phase=`swapped`를 기록한다. target에 있던 어떤 바이트도 임시 경로에 그대로 남는다.
4. 밀려난 임시 파일의 hash가 expected와 같으면 target을 다시 읽는다. read-back hash도 journal의 새 hash와 정확히 같을 때만 publish 성공과 `exported_hash`를 기록한다. 다르면 외부 편집이 swap 뒤에 들어온 것이므로 `exported_hash`를 바꾸지 않고 밀려난 파일도 보존한 채 최신 target을 다시 병합한다.
5. 밀려난 hash가 다르면 외부 쓰기가 먼저 이긴 것이다. 두 경로를 다시 atomic swap해 외부 파일을 target으로 돌려놓는다. swap 사이에 target이 또 바뀌었거나 되돌리기에 실패하면 두 파일을 모두 `.yonalist/unresolved-publishes/<journal-id>/`에 보존하고 문서를 `pending`으로 둔다.

`RENAME_SWAP`은 덮어쓴 원본을 동시에 다른 이름으로 돌려주므로 hash 확인과 교체 사이의 TOCTOU 창에서도 후보를 잃지 않는다. 이 primitive가 없는 플랫폼에서는 기존 파일을 자동 교체하지 않고 `needs_merge`로 반환한다. 두 단계 rename으로 흉내 내지 않는다.

target이 없는 신규 문서는 swap하지 않는다. expected 상태가 `absent`임을 journal에 적고 `RENAME_EXCL`로 임시 파일을 target에 옮긴다. 그사이 다른 파일이 생겨 `EEXIST`가 나면 어느 파일도 덮지 않고 새 target을 읽어 병합한다. 따라서 기존 문서와 신규 문서 모두 조건부 publish가 된다.

DB commit 후 swap 전에 죽으면 dirty/head 차이가 남아 다음 실행이 재방출한다. swap 뒤 검증 전에 죽으면 시작할 때 journal을 읽어 성공을 확정하거나 되돌린다. journal이 가리키는 파일은 일반 임시 파일 정리에서 제외한다.

### 7.3 동기화 서비스가 만든 충돌 사본

iCloud Drive 같은 동기화 서비스는 같은 `README.md`의 두 갈래를 합치지 않고 이름이 다른 충돌 사본으로 남길 수 있다. watcher는 문서 폴더에서 정본 `README.md`와 OS가 충돌 사본으로 표시한 일반 파일을 함께 찾는다. 이름 패턴만으로 임의의 Markdown 파일을 충돌 사본으로 판단하지 않고, 파일 provider가 준 표식이나 동일한 `document` ID가 든 v2 manifest를 근거로 삼는다.

- 정본과 사본의 `merge_base`에서 공통 base를 찾고 같은 3-way 병합기를 호출한다.
- 자동 병합되면 정본만 새 snapshot으로 쓴다. 사본은 즉시 지우지 않고 `.yonalist/resolved-conflicts/`로 옮긴 뒤 30일 보존한다.
- 충돌하면 두 원본 파일을 그대로 두고 `pending`으로 기록한다.
- 이름이 다르더라도 `document` ID가 다르면 별도 문서이며 병합하지 않는다.
- provider 표식도 manifest도 없으면 사용자 파일로 보고 손대지 않는다.

## 8. 3-way 병합

### 8.1 기본 판정

각 필드와 위치에 대해 B(base), L(local), R(remote)을 비교한다.

| 조건 | 결과 |
|---|---|
| `L == B`, `R != B` | R 채택 |
| `R == B`, `L != B` | L 채택 |
| `L == R` | 그 값 채택 |
| 셋이 모두 다름 | 해당 필드 충돌 |

block의 내용과 placement의 위치를 독립적으로 비교한다. 따라서 L이 본문을 고치고 R이 같은 block을 이동한 경우 두 변경을 합친다.

### 8.2 노드 단위 규칙

| base | local | remote | 결과 |
|---|---|---|---|
| 있음 | unchanged | edit/move | remote 변경 |
| 있음 | edit/move | unchanged | local 변경 |
| 있음 | 동일한 변경 | 동일한 변경 | 한 번만 적용 |
| 있음 | 서로 다른 text/note 변경 | 서로 다른 변경 | 필드 충돌 |
| 있음 | delete | unchanged | delete |
| 있음 | unchanged | delete | delete |
| 있음 | delete | edit 또는 move | 삭제/수정 충돌 |
| 있음 | delete | delete | delete |
| 없음 | 신규 yid A | 없음 | A 추가 |
| 없음 | 없음 | 신규 yid A | A 추가 |
| 없음 | 같은 yid·같은 내용 | 같은 내용 | 한 번 추가 |
| 없음 | 같은 yid·다른 내용 | 다른 내용 | ID 충돌, 문서 격리 |

`yid` 없는 신규 줄은 side snapshot을 만들기 전에 ID를 발급한다. 두 기기가 같은 위치에 서로 다른 새 블릿을 넣으면 둘 다 보존한다.

### 8.3 이동과 순서

노드별 `predecessor` 세 값을 직접 비교하지 않는다. 앞 형제 하나를 옮기면 손대지 않은 뒤 형제의 predecessor도 바뀌어 거짓 이동이 되기 때문이다. 각 부모의 stable placement ID 배열을 다음 순서로 비교한다.

1. base와 각 side에 모두 있는 ID만 남겨 base 순번 배열을 만든다.
2. side 순서에 놓인 base 순번의 최장 증가 부분수열(LIS)을 O(n log n)에 구한다.
3. LIS 안의 ID는 그대로 있던 항목, 밖의 ID는 실제 이동 후보로 본다. tie는 placement ID 바이트 순으로 고정한다.
4. 신규 ID는 insert, 사라진 ID는 delete로 따로 기록한다.
5. 이동·삽입 위치는 해당 side에서 가장 가까운 unchanged 앞/뒤 anchor 한 쌍으로 표현한다.

이 edit script를 parent별로 3-way 병합한다.

- 한쪽만 이동: 그 이동을 채택한다.
- 양쪽이 같은 placement를 같은 anchor gap으로 이동: 한 번 적용한다.
- 양쪽이 같은 placement를 서로 다른 gap으로 이동: 위치 충돌이다.
- 서로 다른 placement의 이동: anchor 제약을 함께 적용하고 cycle이 없으면 합친다. cycle이면 해당 순서 구간이 충돌이다.
- 한쪽은 이동, 다른 쪽은 block 본문 수정: 둘을 합친다.
- 부모 placement가 삭제되고 자식이 다른 쪽에서 수정됨: 서브트리 삭제/수정 충돌이다.

같은 gap에 양쪽이 새 placement를 넣으면 모두 보존하고 `(origin_commit_id, placement_id)`로 정렬한다. 어느 기기에서 병합해도 같은 순서가 된다. 사용자가 순서를 다시 정할 수 있으므로 이 경우를 충돌로 만들지 않는다.

병합 후 다음 불변식을 검사한다.

- 모든 block의 `yid`와 모든 명시적 placement ID가 각 namespace에서 유일하다.
- 모든 `Local` placement의 block과 부모가 같은 snapshot에 있다.
- 모든 `Boundary` placement가 가리키는 child manifest의 `document`, `kind`, `root`가 일치한다. child가 아직 도착하지 않았으면 삭제하지 않고 pending import로 둔다.
- 부모 관계에 cycle이 없다.
- 각 placement가 정확히 한 부모의 `children` 배열에 한 번만 나온다.
- 문서 루트는 다른 노드의 자식이 아니다.

하나라도 실패하면 부분 결과를 적용하지 않고 문서 전체를 `quarantined`로 둔다.

### 8.4 base가 없을 때

공통 base가 없으면 2-way diff로 삭제나 이동을 추정하지 않는다.

- DB에 로컬 변경이 없으면 파일을 현재 진실로 채택한다.
- 로컬과 파일이 canonical하게 같으면 새 합의 head만 만든다.
- 둘 다 다르면 문서 전체 충돌로 보류한다.

이는 자동 병합률보다 데이터 보존을 우선하는 의도적인 제한이다.

### 8.5 문서 경계를 넘는 이동

한 block의 primary placement는 vault 전체에서 한 문서만 소유한다. document별 merge 결과를 바로 적용하지 않고, 같은 watcher batch에서 읽은 모든 문서의 `placement_id → document_id` claim을 먼저 만든다.

앱이 만든 이동은 §4.4의 같은 transfer를 source와 destination에 쓴다.

- destination이 먼저 오면 `sync_transfers`를 `one-sided`로 기록하고 새 위치를 후보로 보여 주되, source의 낡은 파일을 다시 import해 되돌리지 않는다.
- source가 먼저 오면 block과 subtree snapshot을 지우지 않고 unplaced 상태로 보류한다.
- 양쪽 commit과 `subtree_state_hash`가 맞으면 한 DB 트랜잭션에서 placement 소유권을 destination으로 옮기고 `confirmed`로 바꾼다.
- 반대 방향 transfer, 다른 destination, subtree hash 불일치는 문서 간 이동 충돌이다.

`unplaced`는 `notes_nodes.parent_id = NULL`을 뜻하지 않는다. 기존 행과 마지막 부모는 그대로 두고 `sync_transfers.status`와 화면 표시에서만 보류 상태로 다뤄 현재 FK/CHECK를 깨지 않는다.

외부 Markdown 편집기의 잘라내기/붙여넣기는 transfer를 만들지 못한다. 이 경우 watcher는 provider event가 안정될 때까지 최대 30초 동안 vault-wide claim을 모은다. 같은 `yid`가 source에서 사라지고 destination에 나타나면 이동으로 짝짓는다. destination이 먼저 와 두 문서에 동시에 보이면 중복 ID 후보로 보류한다. source 제거가 도착하면 이동으로 확정한다. source 제거만 도착하면 일반 삭제로 처리하되 snapshot과 삭제 행을 보존한다. 나중에 destination이 도착하면 같은 `yid`와 base 내용을 확인해 복원 이동으로 바꾼다. 내용도 다르면 사용자에게 삭제/복원 충돌을 보여 준다.

따라서 A→B와 B→A 어느 파일이 먼저 도착해도 block 행을 hard delete하지 않는다. 문서별 snapshot은 내용 병합을 담당하고 `sync_transfers`가 vault-wide placement 소유권을 담당한다.

## 9. 충돌 보존과 해결 UI

### 9.1 저장 계약

충돌을 발견하면 같은 트랜잭션에서 다음을 수행한다.

1. base/local/remote snapshot을 `sync_snapshots`에 넣는다.
2. 자동으로 합쳐진 부분이 있으면 provisional snapshot도 넣는다.
3. `sync_merge_conflicts`에 필드·위치·삭제 충돌 목록을 기록한다.
4. `sync_documents.merge_status = 'pending'`으로 바꾼다.
5. 해당 문서의 자동 export를 중지한다.

원본 Markdown에 Git conflict marker를 쓰지 않는다. 다른 문서와 asset 감지는 계속 동작한다. pending 문서가 참조하는 asset은 해결 전까지 삭제하지 않는다.

### 9.2 화면

기존 “덮어쓴 노트” 복구 화면을 다음 구조로 확장한다.

```text
[블릿 경로 / 부모 제목]
기준        ...
이 기기     ...
파일        ...

[이 기기 사용] [파일 사용] [둘 다 유지] [직접 수정]
```

위치 충돌은 두 부모와 앞뒤 형제를 함께 보여 준다. 삭제/수정 충돌에는 `[삭제] [복원] [직접 수정]`을 제공한다. 서브트리는 접을 수 있지만 선택은 블릿 하나 또는 충돌 서브트리 단위다.

모든 충돌을 해결하고 `[적용]`을 누르면:

1. 현재 `local_commit_id`와 파일 byte hash를 충돌을 열었을 때 저장한 두 값과 비교한다.
2. 하나라도 다르면 선택 결과를 적용하지 않고 최신 head로 3-way 병합을 다시 실행한다. 기존 후보와 사용자의 선택은 감사 기록으로 남긴다.
3. 같으면 선택 결과로 새 snapshot을 만든다.
4. local과 remote를 부모로 둔 merge commit을 저장한다.
5. `WHERE local_commit_id = expected_local_commit` 조건이 붙은 한 DB 트랜잭션으로 노드를 적용하고 conflict를 resolved 처리한다. 영향 행이 0이면 stale로 보고 다시 병합한다.
6. §7.2의 파일 hash 비교 조건을 통과한 뒤 Markdown을 원자적으로 방출한다.
7. 방출 성공 후 문서를 `clean`으로 바꾼다.

창을 닫거나 앱이 종료돼도 pending 상태와 선택 전 후보는 남는다. 해결 취소는 아무 후보도 지우지 않는다.

## 10. 삭제와 휴지통

공통 base가 있을 때는 “base에 있었는데 한쪽 snapshot에 없다”가 삭제 증거다. v1의 HLC tombstone과 `prev`는 필요 없다.

앱의 사용자 휴지통 기능은 동기화 삭제 증거와 분리한다.

- 살아 있는 문서에서 빠진 노드는 삭제로 병합한다.
- 복구 가능한 최근 삭제 내용은 snapshot history와 기존 삭제 행이 보존한다.
- `.yonalist/trash.md`는 v2 전환 1차에서는 유지하되 같은 clean line 문법을 쓴다. 삭제 causal stamp는 넣지 않는다.
- trash와 살아 있는 문서에 같은 `yid`가 동시에 있으면 살아 있는 쪽을 복원 결과로 보고 trash 항목을 제거한다.
- trash 정리 기간이 지나도 unresolved conflict가 참조하는 노드와 asset은 purge하지 않는다.

추후 snapshot history가 휴지통 UI의 보존 기간과 복구 요구를 완전히 만족한다는 측정이 끝나면 `trash.md`를 제거할 수 있다. 이번 전환에서 함께 없애지 않는다.

## 11. asset

- 이미지 블릿도 일반 블릿과 같은 `yid` 하나만 inline으로 갖는다.
- content hash, MIME, pixel, byte 길이는 asset 파일에서 계산하고 SQLite에 cache한다.
- snapshot과 manifest에는 논리적 asset identity인 전체 SHA-256, 사용자 파일명, 표시 폭을 포함한다.
- asset의 상대 경로는 renderer가 현재 문서 위치에서 파생하므로 snapshot identity에 넣지 않는다.
- 같은 논리 asset의 두 파일 바이트가 다르면 자동 덮어쓰지 않고 asset 충돌로 올린다.
- 문서 snapshot 또는 unresolved conflict가 참조하는 asset은 GC 대상이 아니다.

기존 파일 이름과 안전한 상대 경로, no-follow, “먼저 쓰고 나중에 지우기” 계약은 v1 명세를 그대로 유지한다.

## 12. mirror와 블록 참조를 위한 경계

### 12.1 정체성과 배치

`yid`는 블록 내용의 정체성이지 화면상의 한 자리 정체성이 아니다. mirror가 생기면 한 블록이 여러 부모 아래 나타난다. §5 snapshot은 처음부터 block과 placement를 분리하지만 현재 SQLite `notes_nodes.parent_id`는 한 자리만 표현한다. mirror를 구현할 때만 다음 스키마로 옮긴다.

```text
blocks(block_id, content, note, state, ...)
placements(placement_id, parent_placement_id, block_id, order, ...)
block_refs(source_block_id, target_block_id, kind)
```

이번 구현에서는 테이블을 미리 만들지 않는다. v2의 primary placement ID는 block ID에서 파생하므로 별도 inline metadata도 필요 없다. 다음 규칙을 지금부터 지킨다.

- `public_id/yid`를 parent나 위치 자체의 ID라는 이름으로 부르지 않는다.
- snapshot의 `blocks`, `placements`, `children`을 분리한다.
- parser·renderer API가 한 block에 한 placement가 영원히 고정된다고 공개하지 않는다.
- block reference는 대상 `yid`를 저장하며 대상의 현재 문구를 복사하지 않는다.

### 12.2 미래 파일 문법

실제 문법은 기능 구현 때 별도 명세로 확정한다. 호환성 검증을 위한 예약 모양은 다음과 같다.

```markdown
- 원본 블릿 <!-- yid: N7dP2k_q4WmA -->
- {{mirror ((N7dP2k_q4WmA))}} <!-- pid: P3xR8m_aK6Td -->
- 관련 내용은 ((N7dP2k_q4WmA)) 참고 <!-- yid: W9cL2q_zF5Hs -->
```

`yid`와 참조 괄호 안 ID는 block ID다. mirror 줄의 `pid`는 별도 namespace의 placement ID다. primary placement에는 `pid`를 쓰지 않고 block ID로부터 파생한다. 이 구분 덕분에 같은 내용을 여러 위치에 놓아도 이동 충돌과 내용 충돌을 따로 처리할 수 있다. mirror가 없는 포맷 v2 본문은 계속 `yid` 하나만 갖는다.

containment/mirror 배치 그래프에는 cycle을 허용하지 않는다. 일반 block reference 그래프는 cycle을 허용한다. reference의 hash에는 대상 ID만 넣고 대상 내용 hash를 재귀적으로 넣지 않는다.

Workflowy mirror는 한 bullet을 여러 위치에 동기화해 표시하는 개념이고, Logseq의 고전 문법은 page reference `[[...]]`와 block reference `((...))`를 구분한다. 이 문서는 특정 제품 문법을 복제하지 않고 필요한 정체성 분리만 채택한다.

- Workflowy: <https://workflowy.com/help/mirrors>
- Logseq tutorial: <https://github.com/logseq/docs/blob/master/pages/tutorial.md>

## 13. Merkle의 사용 범위

### 13.1 지금 하는 것

- 각 document state와 commit에 서로 다른 SHA-256을 붙인다.
- 병합 중 각 node와 subtree hash를 메모리에서 계산해 같은 subtree를 건너뛸 수 있다.
- SQLite에 document snapshot만 영속한다.
- Markdown 하단에는 snapshot 본문 없이 최근 commit envelope 8개만 운반한다.

문서당 20,000 노드라 해도 O(n) parse와 hash는 이미 파일을 읽는 비용과 같은 차수다. 먼저 이 단순 경로를 측정한다.

### 13.2 지금 하지 않는 것

- node별 blob/object 파일
- subtree별 영구 object와 reference count
- 네트워크 간 hash negotiation
- 분산 mark-and-sweep GC

Merkle hash는 동일성 확인과 변경 구간 축소에는 유용하지만 `yid`를 대신하지 못하고 두 변경 중 어느 것이 옳은지도 결정하지 못한다.

### 13.3 승격 조건

다음 중 하나가 실제 계측에서 반복되면 별도 설계를 연다.

- 20,000 노드 문서의 병합 p95가 200ms를 넘는다.
- snapshot 보관이 vault DB 크기의 30%를 넘는다.
- mirror 때문에 동일 subtree snapshot 중복이 주요 저장 비용이 된다.
- 원격 서버가 subtree 단위 전송을 요구한다.

그때 `blocks`와 `placements`를 노드로 하는 Merkle DAG를 검토한다. containment edge만 DAG hash에 포함하고 일반 reference edge는 대상 ID 토큰으로만 포함한다.

## 14. v1 → v2 전환

전환은 파일별 lazy migration이 아니라 vault 단위 한 번의 작업이다. 두 기기가 서로 다른 포맷을 동시에 쓰는 기간을 만들지 않는다. 먼저 v1 bridge 릴리스를 배포한다. bridge는 §3.3의 `home_root`가 든 format 1 marker를 만들고 설치별 UUID를 `.yonalist/devices/<device-uuid>.json`에 등록하며 migration 준비·read-only marker를 이해한다. 등록됐고 사용자가 retired로 표시하지 않은 기기는 모두 전환에 참여해야 한다.

bridge 설치 전에 이 vault를 열었던 오프라인 기기는 registry만 보고 알아낼 수 없다. 전환 UI는 자동으로 “모든 기기 준비 완료”라고 판단하지 않는다. 사용자가 과거에 이 vault를 연 기기 목록을 확인하고 각 기기를 bridge로 업데이트하거나 retired 처리했다는 명시적 확인을 해야 1단계를 시작한다. 충분한 유예 기간은 안내에 도움이 되지만 이 확인을 대신하지 않는다.

`format.json`의 모든 phase는 최초 format 1 marker의 `vault`와 `home_root`를 그대로 포함한다. phase 갱신은 이 두 값을 인자로 받는 전용 함수만 수행하며 누락된 marker는 격리한다.

1. 시작 기기가 `.yonalist/format.json`을 `{"format":1,"target":2,"phase":"prepare","migration_id":"...","vault":"...","home_root":"..."}`로 쓴다.
2. 각 bridge 기기는 새 사용자 편집을 막고 기존 command queue와 `sync_dirty_nodes`를 v1 파일로 모두 방출한다. watcher import와 v1 자동 병합은 계속 수행한다. 해결되지 않은 충돌·격리·복구 작업이 있으면 clean ack를 쓰지 않고 사용자가 해결하거나 보존 방식을 선택할 때까지 전환을 막는다.
3. 기기는 vault content 파일의 `(relative_path, byte_hash)` 정렬 목록을 두 번 연속 같은 값으로 읽고 `.yonalist/migration-acks/<migration-id>/<device-uuid>.json`에 `clean=true`, tree hash, DB revision을 쓴다. control 파일과 mtime은 tree hash에서 뺀다.
4. ack 뒤 새 vault 변경을 보면 기존 ack를 무효화하고 import·병합·재방출한 뒤 다시 ack한다. 사용자 편집은 계속 막는다.
5. 시작 기기는 non-retired 등록 기기의 clean ack가 모두 있고 tree hash가 같을 때만 `phase="migrating"`으로 바꾼다. offline 기기는 자동으로 제외하지 않는다. 사용자가 retired 처리하거나 기기를 켜서 ack해야 한다.
6. 각 bridge 기기는 `migrating`을 보면 import/export도 멈추고 같은 ack 파일에 `frozen=true`와 정지 뒤 다시 읽은 final tree hash를 기록한다. 시작 기기도 watcher와 exporter를 멈추고 frozen ack를 쓴다.
7. 시작 기기는 모든 non-retired 기기의 frozen ack가 있고 final tree hash가 같을 때만 파일 교체를 시작한다. clean ack만 있거나 frozen hash가 다르면 기다린다.
8. 시작 기기는 SQLite와 vault의 hash를 다시 읽어 frozen tree와 같은지 확인한다.
9. vault와 DB의 복구용 snapshot을 만든다. 기존 파일은 활성 vault 밖의 Application Support 백업 디렉터리에 보존한다.
10. Application Support에 migration ID, 원본 hash 목록, backup 경로, 현재 phase를 담은 resume journal을 원자적으로 쓴다.
11. 모든 UUID와 marker의 home root 공개 `yid` 후보를 읽고 중복·중복 줄 ID를 검사한다.
12. 기존 parser로 v1 파일을 읽어 canonical v2 snapshot을 만든다.
13. SQLite migration과 모든 `public_id` backfill을 한 트랜잭션으로 적용하고 journal phase를 `db-ready`로 바꾼다.
14. 모든 v2 Markdown을 임시 디렉터리에 렌더하고 다시 parse해 state hash가 같은지 검증한다.
15. 파일을 하나씩 §7.2 방식으로 교체한다. 파일마다 원본·결과 byte hash를 journal에 기록해 재실행을 idempotent하게 만든다.
16. 전체 vault를 다시 읽어 시작 기기 DB의 commit/state hash와 모두 같은지 확인한다.
17. `format.json`을 `{"format":2,"target":2,"phase":"files-ready","migration_id":"...","vault":"...","home_root":"...","tree_hash":"..."}`로 바꾼다. 모든 기기는 계속 read-only다.
18. 각 follower는 로컬 v1 DB를 Application Support에 backup한 뒤 v2 스키마의 새 DB를 옆에 만든다. v2 vault를 처음부터 import해 notes/sync table과 모든 document head를 만들고 marker의 `vault`·`home_root`를 채택한다. 검색 index는 다시 만든다. `notes_ui_state`와 함께 기존 `sync_conflict_log`, 아직 보존 기간인 복구 후보, 관련 `sync_assets` pin을 내부 UUID→`public_id` 대응표로 검증해 복사한다. 해결되지 않은 행은 2단계에서 막혔어야 하며 여기서 새로 발견되면 교체하지 않는다.
19. follower는 새 DB로 빈 DB 복구와 복사한 복구 후보의 조회·asset 존재 검증을 통과한 뒤 원자적으로 교체한다. ack에는 `v2_db_ready=true`, schema version, tree hash, 복구 후보 개수를 기록한다. 실패하면 기존 DB와 read-only 상태를 유지한다. 시작 기기도 같은 값으로 ack한다.
20. 시작 기기는 모든 non-retired 기기의 `v2_db_ready` ack와 tree hash가 같을 때만 `format.json`을 `{"format":2,"phase":"ready","vault":"...","home_root":"..."}`로 바꾸고 watcher를 재개한다.

중간 실패 시 `migrating` marker를 유지하고 watcher를 재개하지 않는다. 앱은 journal과 각 파일 manifest를 대조해 남은 파일부터 재개하거나 backup으로 전체 복원한다. SQLite transaction과 여러 파일 rename을 하나의 원자 작업처럼 간주하지 않는다. marker가 혼합 상태를 다른 앱에서 숨기고 journal이 완료 지점을 기억한다.

사용자가 rollback을 고르면 시작 기기는 먼저 `format.json`을 `{"format":2,"target":2,"phase":"rolling-back","migration_id":"...","vault":"...","home_root":"..."}`로 바꾼 뒤 backup의 원본 hash를 확인해 v1 vault를 전부 복원한다. 각 참여 기기는 자기 Application Support backup에서 v1 DB를 복원하고 복원된 vault tree hash와 일치하는지 검사한 뒤 ack에 `v1_db_restored=true`를 쓴다. 아직 v2 DB로 바꾸지 않은 기기도 현재 v1 DB를 검사하고 같은 ack를 쓴다. 시작 기기는 모든 non-retired 기기의 복원 ack와 tree hash가 같을 때만 `{"format":1,"phase":"ready","vault":"...","home_root":"..."}`로 되돌린다. 한 기기라도 실패하면 `rolling-back`과 전체 read-only 상태를 유지한다. 일부 파일이나 한 기기 DB만 v1로 되돌리는 downgrade는 허용하지 않는다.

## 15. 오류 처리

| 상황 | 동작 |
|---|---|
| 중복/잘못된 `yid` | 문서 격리, 자동 재발급 금지 |
| manifest JSON 손상 | 본문은 읽기 전용 preview, 동기화 적용·방출 금지 |
| 선언 merge base 없음 + 양쪽 변경 | 문서 단위 충돌 |
| parser limit 초과 | 기존 quarantine 경로 사용 |
| 파일이 읽는 중 바뀜 | size/mtime 재확인 후 최대 3회 재읽기, 이후 다음 watcher event로 넘김 |
| DB commit 실패 | 파일을 쓰지 않음 |
| DB commit 뒤 파일 쓰기 실패 | dirty 상태 유지, 다음 실행에서 재시도 |
| 파일 쓰기 뒤 앱 종료 | canonical hash no-op으로 안전하게 재수렴 |
| snapshot DB 손상 | 파일 원본 보존, 자동 삭제·이동 병합 중지 |
| asset 미도착 | 문서 노드는 유지하고 placeholder, asset 도착 시 검증 |

어떤 오류도 “더 최신으로 보이는 쪽”을 추측해 다른 후보를 삭제하는 근거가 되지 않는다.

## 16. 구현 순서와 테스트

각 항목은 적힌 실패 테스트 하나로 시작한다. 기존 vertical slice를 유지하기 위해 parser만 먼저 배포하거나 새 renderer만 단독으로 켜지 않는다.

### M1. 공개 ID와 포맷 v2 codec

수정 범위:

- `crates/notes-sqlite/src/schema.sql`: `public_id` migration
- `crates/notes-sync/src/parse.rs`: v2 line·manifest parser
- `crates/notes-sync/src/render.rs`: clean Markdown renderer
- `crates/notes-sync/src/document.rs`: v2 manifest 타입과 canonicalization

먼저 실패할 테스트:

- `v2_render_keeps_only_yid_inline`
- `v2_escape_preserves_slash_plus_and_period`
- `v2_parse_render_parse_preserves_semantics`
- `home_root_public_id_and_state_survive_an_empty_db_rebuild`
- `two_devices_adopt_the_same_bridge_home_root_id`
- `split_boundary_does_not_duplicate_the_child_block`
- `duplicate_public_id_quarantines_the_document`
- `legacy_uuid_mapping_is_deterministic`

완료: A1, A4의 codec 부분.

### M2. snapshot store와 head

수정 범위:

- `schema.sql`: `sync_snapshots`, head column, merge conflict table
- notes-sqlite repository: snapshot insert/get/pin/prune
- 기존 `LineState::fingerprint()`을 canonical state/commit hash로 일반화

먼저 실패할 테스트:

- `canonical_hash_ignores_markdown_whitespace_and_sort_key`
- `snapshot_round_trip_is_byte_stable`
- `reverting_content_creates_a_new_commit_id`
- `merge_commit_can_have_the_same_state_hash_as_a_parent`
- `history_envelope_finds_a_parent_of_a_missed_merge`
- `prune_keeps_heads_ancestors_and_conflicts`

완료: A3의 보존 기반.

### M3. 순수 3-way 병합기

DB나 파일 I/O 없는 함수로 먼저 만든다. 기존 `merger.rs`의 타입·검증 도우미를 재사용하고 HLC 판정 사다리는 호출하지 않는다.

먼저 실패할 테스트:

- `disjoint_text_edits_merge`
- `move_and_text_edit_merge`
- `moving_one_sibling_does_not_mark_following_siblings_as_moved`
- `delete_and_edit_conflict`
- `different_moves_conflict`
- `concurrent_inserts_have_deterministic_order`
- `merge_is_commutative_for_side_order`
- `merge_result_satisfies_tree_invariants`

property test는 현재 저장소에 이미 설치된 도구가 있으면 재사용한다. 새 의존성은 추가하지 않는다.

완료: A2.

### M4. watcher·DB·export vertical slice

수정 범위:

- notes-sqlite worker의 merge transaction
- watcher batch의 vault-wide placement claim과 `sync_transfers`
- exporter의 snapshot/head 기록과 atomic write
- watcher echo 판정
- `sync_node_exports` read 제거

먼저 실패할 테스트:

- `external_edit_uses_declared_commit_as_parent`
- `missing_base_with_local_change_never_guesses`
- `crash_after_db_commit_reexports_safely`
- `publish_swap_preserves_a_file_changed_after_the_cas_check`
- `publish_readback_mismatch_is_never_recorded_as_an_echo`
- `new_document_publish_uses_no_replace`
- `publish_journal_recovers_a_crash_after_swap`
- `cross_document_move_converges_destination_first`
- `cross_document_move_converges_source_first`
- `confirmed_transfer_remains_in_both_manifests_for_30_days`
- `export_echo_is_a_noop`
- `one_pending_document_does_not_block_others`

완료: A2, A3의 실제 동작.

### M5. 충돌 해결 UI

기존 Settings 복구 섹션과 application contract를 확장한다. 새 전역 상태 관리 계층을 만들지 않는다.

먼저 실패할 테스트:

- `conflict_view_shows_base_local_remote`
- `resolution_survives_restart`
- `accept_creates_two_parent_snapshot`
- `stale_local_or_file_head_restarts_merge_instead_of_applying`
- `unresolved_conflict_never_overwrites_markdown`

완료: A3.

### M6. vault migration과 cutover

먼저 실패할 테스트:

- `v1_fixture_migrates_to_equivalent_v2_snapshot`
- `migration_collision_writes_nothing`
- `mixed_format_vault_resumes_or_rolls_back`
- `migrating_marker_makes_bridge_release_read_only`
- `every_migration_phase_preserves_vault_and_home_root`
- `migration_waits_for_every_non_retired_clean_device_ack`
- `migration_waits_for_every_frozen_ack_with_the_same_tree_hash`
- `pre_bridge_devices_require_explicit_user_confirmation`
- `a_pending_edit_is_exported_before_the_device_acks`
- `ready_waits_for_every_follower_v2_db_rebuild_ack`
- `follower_rebuild_preserves_local_recovery_rows_and_asset_pins`
- `rollback_waits_for_every_follower_v1_db_restore_ack`
- `empty_db_rebuild_preserves_all_public_ids`
- `old_app_opens_format2_vault_read_only`

완료: A4와 안전한 전환.

### M7. mirror 호환성 검증

mirror 기능을 구현하지 않는다. 현재 타입과 codec이 미래 분리를 막지 않는지만 작은 설계 테스트로 잠근다.

- `public_id_does_not_change_when_node_moves`
- `snapshot_separates_blocks_and_placements`
- `state_hashes_reference_target_id_without_target_content`
- `containment_cycle_is_rejected`

완료: A5.

## 17. 릴리스 gate

| Gate | 통과 기준 |
|---|---|
| G1 codec | 기존 대표 vault fixture 100개가 v1 → v2 → parse에서 의미 동일 |
| G2 merge | §8 표 전체, side 순서 교환, 재병합 idempotence 통과 |
| G3 failure | DB/파일 쓰기 각 단계 fault injection 후 원본 또는 후보 손실 0 |
| G4 performance | 20,000 노드 문서 parse+hash+clean merge p95 ≤ 200ms(배포 대상 Mac) |
| G5 manual | 두 기기 복사본에서 동시 편집·이동·삭제·충돌 해결 후 같은 state hash와 commit ID |

G1~G5 전에는 v1을 정본으로 유지한다. gate가 통과하면 한 릴리스에서 migration을 켜고 v2 writer로 전환한다. v1 writer로 되돌리는 자동 downgrade는 제공하지 않으며, 필요하면 migration backup으로 vault 전체를 복원한다.

## 18. 폐기되는 v1 규칙

v2 전환이 끝나면 [`docs/v2/sync-spec.md`](../../v2/sync-spec.md)에서 다음 계약은 더 이상 적용하지 않는다.

- 줄별 HLC `t`와 문서 `max_hlc`, `root_hlc`
- 줄별 위치 주장 `prev`와 `sync_prev_hlc`
- 같은-t device 소유권과 digest tie-break
- 모든 ASCII 문장부호 escape
- 노드별 `sync_node_exports` fingerprint
- HLC tombstone을 삭제의 유일한 증거로 삼는 규칙

파일 배치, 안전한 경로 해석, asset 이름, no-follow, 원자적 쓰기, 격리 상한은 v1 명세를 유지한다. 이 문서와 v1이 충돌하는 부분은 G1~G5 통과 전에는 v1이, 전환 이후에는 이 문서가 우선한다.

## 19. 최종 선택

이 설계의 핵심 선택은 세 가지다.

1. **본문에는 12자 `yid`만 남긴다.** 정체성까지 숨기면 외부 편집과 향후 블록 참조의 정확도가 무너진다.
2. **인과관계는 줄별 시계가 아니라 문서 snapshot 부모 관계로 보존한다.** 사용자가 읽는 파일과 병합 규칙을 동시에 단순하게 만든다.
3. **Merkle DAG와 서버는 지금 만들지 않는다.** SQLite snapshot + 선형 3-way 병합이 실제 한계를 보일 때만 확장한다.

이 경계면이면 Markdown은 다시 유용한 사용자 파일이 되고, 동기화는 조용히 자동 병합하되 확신할 수 없는 순간에는 멈춰서 모든 후보를 보존한다.
