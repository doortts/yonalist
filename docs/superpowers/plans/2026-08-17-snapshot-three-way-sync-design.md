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
{"format":2,"document":"Df4qM9_wK2Ls","snapshot":"sha256:4e6f...64-hex...91a2","parents":["sha256:18c7...64-hex...72d0"],"state":{"Xm3_aP9kT2Ws":{"collapsed":true},"Hm4sK8_qW2Pd":{"completed":true}}}
-->
```

실제 `snapshot`과 `parents` 값은 생략 없는 소문자 SHA-256 hex 64자다. 예시만 폭을 줄여 표시했다.

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

manifest는 파일의 마지막 비공백 요소이며 하나만 허용한다. JSON은 UTF-8 한 줄로 쓰고 키 순서를 `format`, `document`, `snapshot`, `parents`, `state`로 고정한다.

| 필드 | 의미 |
|---|---|
| `format` | 정수 `2` |
| `document` | 문서 루트의 12자 공개 ID |
| `snapshot` | 이 파일을 마지막으로 앱이 썼을 때의 canonical snapshot hash |
| `parents` | 그 snapshot의 부모 0~2개. 일반 변경은 1개, 병합 결과는 2개 |
| `state` | Markdown 본문으로 보존할 수 없는 상태만 담는 `yid → object` map |

`state`에 허용하는 v2 키는 `collapsed`, `completed`, `starred`, `marker`, `ordered_start`, `note`다. 기본값은 생략한다. 본문 문법으로 명백히 표현된 값과 manifest 값이 다르면 본문을 우선하고 다음 방출에서 manifest를 고친다.

이미지의 pixel·byte 크기와 MIME은 파일 바이트에서 다시 계산한다. 화면 폭처럼 사용자 선택인 값만 추후 `state[yid].width`로 추가할 수 있다. 알 수 없는 상태 키는 해당 객체 안에서 그대로 round-trip한다.

### 4.5 stale manifest의 의미

일반 편집기는 본문만 고치므로 `snapshot`은 이전 값으로 남는다. 이것은 오류가 아니라 3-way 병합의 base 표식이다.

- 계산한 현재 hash가 선언된 `snapshot`과 같음: 앱이 완성해 쓴 snapshot이다.
- 다름: 현재 파일은 선언 snapshot에서 갈라진 외부 편집 자식이다.
- 선언 snapshot이 SQLite에 있음: 그것을 base로 병합한다.
- 선언 snapshot이 없고 로컬 변경도 없음: 현재 파일을 새 기준으로 채택한다.
- 선언 snapshot이 없고 로컬 변경도 있음: 삭제·이동을 추측하지 않고 문서 단위 충돌로 보류한다.

## 5. canonical snapshot

### 5.1 데이터 모델

snapshot은 원본 Markdown 바이트가 아니라 파싱된 의미를 저장한다.

```rust
struct DocumentSnapshot {
    format: u8,                 // 2
    document_yid: PublicId,
    title: String,
    root_note: String,
    nodes: BTreeMap<PublicId, SnapshotNode>,
}

struct SnapshotNode {
    kind: NodeKind,
    text: String,
    note: String,
    marker: Marker,
    ordered_start: u32,
    collapsed: bool,
    completed: bool,
    starred: bool,
    parent: PublicId,
    predecessor: Option<PublicId>,
    image: Option<SnapshotImage>,
}
```

위 구조는 설계 표기다. 이 타입을 새 public API로 만들 필요는 없고 `notes-sync` 내부 타입이면 충분하다.

위치는 `sort_key`가 아니라 `(parent, predecessor)`로 저장한다. `sort_key`는 로컬 DB의 구현 세부이며 같은 트리도 기기마다 값이 다를 수 있다.

### 5.2 정규화와 hash

hash 입력은 다음 순서로 만든다.

1. 문자열을 Unicode NFC와 LF로 정규화한다.
2. node를 `yid` 바이트 오름차순으로 순회한다.
3. 각 필드를 고정된 tag와 길이-prefix 바이트로 기록한다.
4. 알 수 없는 manifest state는 JSON key 오름차순으로 정규화해 포함한다.
5. `snapshot`, `parents`, mtime, 파일 경로, 내부 UUID, HLC, `sort_key`는 제외한다.
6. 전체 바이트의 SHA-256을 snapshot hash로 쓴다.

JSON 문자열을 이어 붙여 hash하지 않는다. whitespace와 map 순서가 의미 없는 차이를 만들기 때문이다. 기존 `LineState::fingerprint()`의 SHA-256 도우미를 재사용하되 위 직렬화 계약을 한 함수에 둔다.

## 6. SQLite 변경

### 6.1 스키마

```sql
ALTER TABLE notes_nodes ADD COLUMN public_id TEXT;
CREATE UNIQUE INDEX notes_nodes_public_id ON notes_nodes(public_id);

CREATE TABLE sync_snapshots (
    snapshot_hash TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL,
    parent1_hash TEXT,
    parent2_hash TEXT,
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
base_snapshot_hash TEXT NOT NULL DEFAULT '',
local_snapshot_hash TEXT NOT NULL DEFAULT '',
file_snapshot_hash TEXT NOT NULL DEFAULT '',
merge_status TEXT NOT NULL DEFAULT 'clean'
  CHECK (merge_status IN ('clean', 'pending', 'quarantined'))
```

- `base_snapshot_hash`: 로컬 DB와 파일이 마지막으로 합의한 head
- `local_snapshot_hash`: 현재 DB 상태에서 계산한 head
- `file_snapshot_hash`: 마지막으로 읽은 파일의 head
- `pending`: 해결되지 않은 충돌 때문에 이 문서의 자동 방출이 멈춘 상태

`sync_conflict_log`는 즉시 버리지 않는다. v2에서는 `loser_json`에 한 후보만 넣는 대신 별도 `sync_merge_conflicts`를 추가한다.

```sql
CREATE TABLE sync_merge_conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL,
    base_hash TEXT NOT NULL,
    local_hash TEXT NOT NULL,
    remote_hash TEXT NOT NULL,
    provisional_hash TEXT,
    conflicts_json BLOB NOT NULL,
    recorded_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolution_hash TEXT
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
  → 안정된 바이트 읽기 + parse + canonical hash
  → echo면 종료
  → DB의 local snapshot 계산
  → base 찾기
  → 3-way merge
      ├─ clean: 한 트랜잭션으로 DB 적용·snapshot/head 기록
      │         → 원자적 Markdown 방출 → echo hash 기록
      └─ conflict: 세 snapshot과 충돌 목록 저장
                  → 문서 status=pending, 원본 파일 유지
                  → 사용자 해결 후 새 merge snapshot 방출
```

### 7.1 echo 판정

mtime만으로 echo를 판정하지 않는다. 파일 바이트 SHA-256이 `exported_hash`와 같으면 종료한다. 다르면 parse와 canonical hash를 수행한다. canonical hash가 현재 `file_snapshot_hash`와 같아도 whitespace만 바뀐 것이므로 DB 내용은 바꾸지 않되, 사용자가 만든 표현을 다음 의미 변경 전까지 덮어쓰지 않는다.

### 7.2 쓰기 순서

1. 대상 디렉터리에 새 파일을 만들고 flush한다.
2. 같은 디렉터리에서 atomic rename으로 `README.md`를 교체한다.
3. 교체된 파일을 다시 읽어 byte hash를 기록한다.
4. 그 뒤에만 오래된 임시 파일을 정리한다.

DB commit 후 파일 교체 전에 죽으면 dirty/head 차이가 남아 다음 실행이 재방출한다. 파일 교체 후 hash 기록 전에 죽으면 watcher가 내용을 다시 읽지만 canonical snapshot이 같아 no-op이 된다. 어느 경우에도 이전 파일과 새 파일을 모두 잃지 않는다.

### 7.3 동기화 서비스가 만든 충돌 사본

iCloud Drive 같은 동기화 서비스는 같은 `README.md`의 두 갈래를 합치지 않고 이름이 다른 충돌 사본으로 남길 수 있다. watcher는 문서 폴더에서 정본 `README.md`와 OS가 충돌 사본으로 표시한 일반 파일을 함께 찾는다. 이름 패턴만으로 임의의 Markdown 파일을 충돌 사본으로 판단하지 않고, 파일 provider가 준 표식이나 동일한 `document` ID가 든 v2 manifest를 근거로 삼는다.

- 정본과 사본의 선언 snapshot에서 공통 base를 찾고 같은 3-way 병합기를 호출한다.
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

한 노드의 텍스트와 위치를 독립 필드로 비교한다. 따라서 L이 본문을 고치고 R이 같은 노드를 이동한 경우 두 변경을 합친다.

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

이동 값은 `(parent_yid, predecessor_yid)`다.

- 한쪽만 이동: 그 이동을 채택한다.
- 양쪽이 같은 곳으로 이동: 한 번 적용한다.
- 양쪽이 서로 다른 곳으로 이동: 위치 충돌이다.
- 한쪽은 이동, 다른 쪽은 본문 수정: 둘을 합친다.
- 부모가 삭제되고 자식이 다른 쪽에서 수정됨: 서브트리 삭제/수정 충돌이다.
- predecessor가 삭제됐지만 노드 자체는 이동하지 않음: 살아 있는 앞쪽 이웃 중 base에서 가장 가까운 노드 뒤에 붙인다. 없으면 첫 번째다.

같은 gap에 양쪽이 새 노드를 넣으면 모두 보존하고 `(side_rank, yid)`로 정렬한다. `side_rank`는 두 snapshot hash의 바이트 오름차순 순위다. 어느 기기에서 병합해도 같은 순서가 된다. 사용자가 순서를 다시 정할 수 있으므로 이 경우를 충돌로 만들지 않는다.

병합 후 다음 불변식을 검사한다.

- 모든 살아 있는 노드의 `yid`가 유일하다.
- 모든 부모와 predecessor가 같은 문서의 살아 있는 노드다.
- 부모 관계에 cycle이 없다.
- 한 부모 아래 predecessor 관계는 하나의 완전한 순서를 이룬다.
- 문서 루트는 다른 노드의 자식이 아니다.

하나라도 실패하면 부분 결과를 적용하지 않고 문서 전체를 `quarantined`로 둔다.

### 8.4 base가 없을 때

공통 base가 없으면 2-way diff로 삭제나 이동을 추정하지 않는다.

- DB에 로컬 변경이 없으면 파일을 현재 진실로 채택한다.
- 로컬과 파일이 canonical하게 같으면 새 합의 head만 만든다.
- 둘 다 다르면 문서 전체 충돌로 보류한다.

이는 자동 병합률보다 데이터 보존을 우선하는 의도적인 제한이다.

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

1. 선택 결과로 새 snapshot을 만든다.
2. local과 remote를 부모로 둔 merge snapshot을 저장한다.
3. 한 DB 트랜잭션으로 노드를 적용하고 conflict를 resolved 처리한다.
4. Markdown을 원자적으로 방출한다.
5. 방출 성공 후 문서를 `clean`으로 바꾼다.

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
- snapshot에는 논리적 asset identity인 전체 SHA-256, 사용자 파일명, 표시 폭만 포함한다.
- asset의 상대 경로는 renderer가 현재 문서 위치에서 파생하므로 snapshot identity에 넣지 않는다.
- 같은 논리 asset의 두 파일 바이트가 다르면 자동 덮어쓰지 않고 asset 충돌로 올린다.
- 문서 snapshot 또는 unresolved conflict가 참조하는 asset은 GC 대상이 아니다.

기존 파일 이름과 안전한 상대 경로, no-follow, “먼저 쓰고 나중에 지우기” 계약은 v1 명세를 그대로 유지한다.

## 12. mirror와 블록 참조를 위한 경계

### 12.1 정체성과 배치

`yid`는 블록 내용의 정체성이지 화면상의 한 자리 정체성이 아니다. mirror가 생기면 한 블록이 여러 부모 아래 나타난다. 현재 `notes_nodes.parent_id` 하나로는 이를 표현할 수 없으므로 미래 스키마는 다음처럼 분리한다.

```text
blocks(block_id, content, note, state, ...)
placements(placement_id, parent_placement_id, block_id, order, ...)
block_refs(source_block_id, target_block_id, kind)
```

이번 구현에서는 테이블을 미리 만들지 않는다. 대신 다음 규칙만 지금부터 지킨다.

- `public_id/yid`를 parent나 위치 자체의 ID라는 이름으로 부르지 않는다.
- snapshot의 내용 필드와 `(parent, predecessor)` 배치 필드를 분리한다.
- parser·renderer API가 한 block에 한 placement가 영원히 고정된다고 공개하지 않는다.
- block reference는 대상 `yid`를 저장하며 대상의 현재 문구를 복사하지 않는다.

### 12.2 미래 파일 문법

실제 문법은 기능 구현 때 별도 명세로 확정한다. 호환성 검증을 위한 예약 모양은 다음과 같다.

```markdown
- 원본 블릿 <!-- yid: N7dP2k_q4WmA -->
- {{mirror ((N7dP2k_q4WmA))}} <!-- yid: P3xR8m_aK6Td -->
- 관련 내용은 ((N7dP2k_q4WmA)) 참고 <!-- yid: W9cL2q_zF5Hs -->
```

mirror 줄의 `yid`는 occurrence/placement 식별자이고 괄호 안 ID는 공유 block ID다. 실제 구현 때 `placement_id`를 별도 12자 공간으로 둘 수 있다. 이 구분 덕분에 같은 내용을 여러 위치에 놓아도 이동 충돌과 내용 충돌을 따로 처리할 수 있다.

containment/mirror 배치 그래프에는 cycle을 허용하지 않는다. 일반 block reference 그래프는 cycle을 허용한다. reference의 hash에는 대상 ID만 넣고 대상 내용 hash를 재귀적으로 넣지 않는다.

Workflowy mirror는 한 bullet을 여러 위치에 동기화해 표시하는 개념이고, Logseq의 고전 문법은 page reference `[[...]]`와 block reference `((...))`를 구분한다. 이 문서는 특정 제품 문법을 복제하지 않고 필요한 정체성 분리만 채택한다.

- Workflowy: <https://workflowy.com/help/mirrors>
- Logseq tutorial: <https://github.com/logseq/docs/blob/master/pages/tutorial.md>

## 13. Merkle의 사용 범위

### 13.1 지금 하는 것

- 각 document snapshot에 SHA-256을 붙인다.
- 병합 중 각 node와 subtree hash를 메모리에서 계산해 같은 subtree를 건너뛸 수 있다.
- SQLite에 document snapshot만 영속한다.

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

전환은 파일별 lazy migration이 아니라 vault 단위 한 번의 작업이다. 두 기기가 서로 다른 포맷을 동시에 쓰는 기간을 만들지 않는다.

1. 동기화 watcher와 exporter를 멈춘다.
2. SQLite와 vault의 현재 파일 목록·hash를 읽어 변경 중인 파일이 없는지 확인한다.
3. vault와 DB의 복구용 snapshot을 만든다. 기존 파일은 덮어쓰기 전에 활성 vault 밖의 Application Support 백업 디렉터리에 보존한다.
4. 모든 UUID의 공개 `yid` 후보를 계산하고 중복·중복 줄 ID를 검사한다.
5. 기존 parser로 v1 파일을 읽어 canonical v2 snapshot을 만든다.
6. SQLite migration과 모든 `public_id` backfill을 한 트랜잭션으로 적용한다.
7. 모든 v2 Markdown을 임시 디렉터리에 렌더하고 다시 parse해 snapshot hash가 같은지 검증한다.
8. 파일을 하나씩 원자 교체하고 `sync_snapshots`·`sync_documents` head를 기록한다.
9. 전체 vault를 다시 읽어 DB와 hash가 모두 같은지 확인한 뒤 watcher를 재개한다.

중간 실패 시 watcher를 재개하지 않고 backup과 migration 상태를 보여 준다. v2 파일 일부를 v1 exporter가 다시 쓰게 해서는 안 된다. 교체 전 실패는 DB transaction rollback과 임시 파일 삭제로 복구한다. 교체 중 실패는 manifest format으로 완료 파일을 식별해 재개하거나 backup으로 전체 복원한다.

다른 기기가 v1 파일을 계속 쓰는 것을 막기 위해 vault 루트 `.yonalist/format.json`에 `{"format":2,"vault":"..."}`를 둔다. 포맷 전환 기능보다 먼저 배포하는 v1 호환 릴리스가 알 수 없는 vault format을 감지해 read-only로 열어야 한다. 이 보호 장치가 없는 구버전이 한 대라도 남아 있으면 자동 전환하지 않고, 사용자가 모든 기기를 업데이트했다고 확인한 뒤에만 진행한다.

## 15. 오류 처리

| 상황 | 동작 |
|---|---|
| 중복/잘못된 `yid` | 문서 격리, 자동 재발급 금지 |
| manifest JSON 손상 | 본문은 읽기 전용 preview, 동기화 적용·방출 금지 |
| 선언 base snapshot 없음 + 양쪽 변경 | 문서 단위 충돌 |
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
- `duplicate_public_id_quarantines_the_document`
- `legacy_uuid_mapping_is_deterministic`

완료: A1, A4의 codec 부분.

### M2. snapshot store와 head

수정 범위:

- `schema.sql`: `sync_snapshots`, head column, merge conflict table
- notes-sqlite repository: snapshot insert/get/pin/prune
- 기존 `LineState::fingerprint()`을 canonical snapshot hash로 일반화

먼저 실패할 테스트:

- `canonical_hash_ignores_markdown_whitespace_and_sort_key`
- `snapshot_round_trip_is_byte_stable`
- `prune_keeps_heads_ancestors_and_conflicts`

완료: A3의 보존 기반.

### M3. 순수 3-way 병합기

DB나 파일 I/O 없는 함수로 먼저 만든다. 기존 `merger.rs`의 타입·검증 도우미를 재사용하고 HLC 판정 사다리는 호출하지 않는다.

먼저 실패할 테스트:

- `disjoint_text_edits_merge`
- `move_and_text_edit_merge`
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
- exporter의 snapshot/head 기록과 atomic write
- watcher echo 판정
- `sync_node_exports` read 제거

먼저 실패할 테스트:

- `external_edit_uses_declared_snapshot_as_base`
- `missing_base_with_local_change_never_guesses`
- `crash_after_db_commit_reexports_safely`
- `export_echo_is_a_noop`
- `one_pending_document_does_not_block_others`

완료: A2, A3의 실제 동작.

### M5. 충돌 해결 UI

기존 Settings 복구 섹션과 application contract를 확장한다. 새 전역 상태 관리 계층을 만들지 않는다.

먼저 실패할 테스트:

- `conflict_view_shows_base_local_remote`
- `resolution_survives_restart`
- `accept_creates_two_parent_snapshot`
- `unresolved_conflict_never_overwrites_markdown`

완료: A3.

### M6. vault migration과 cutover

먼저 실패할 테스트:

- `v1_fixture_migrates_to_equivalent_v2_snapshot`
- `migration_collision_writes_nothing`
- `mixed_format_vault_resumes_or_rolls_back`
- `empty_db_rebuild_preserves_all_public_ids`
- `old_app_opens_format2_vault_read_only`

완료: A4와 안전한 전환.

### M7. mirror 호환성 검증

mirror 기능을 구현하지 않는다. 현재 타입과 codec이 미래 분리를 막지 않는지만 작은 설계 테스트로 잠근다.

- `public_id_does_not_change_when_node_moves`
- `snapshot_hashes_reference_target_id_without_target_content`
- `containment_cycle_is_rejected`

완료: A5.

## 17. 릴리스 gate

| Gate | 통과 기준 |
|---|---|
| G1 codec | 기존 대표 vault fixture 100개가 v1 → v2 → parse에서 의미 동일 |
| G2 merge | §8 표 전체, side 순서 교환, 재병합 idempotence 통과 |
| G3 failure | DB/파일 쓰기 각 단계 fault injection 후 원본 또는 후보 손실 0 |
| G4 performance | 20,000 노드 문서 parse+hash+clean merge p95 ≤ 200ms(배포 대상 Mac) |
| G5 manual | 두 기기 복사본에서 동시 편집·이동·삭제·충돌 해결 후 같은 snapshot hash |

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
