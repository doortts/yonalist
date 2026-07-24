# GitHub Inbox 백그라운드 Vault 인덱스 정합화 설계

## 문제

GitHub Inbox 활성화 2.5초 뒤 `App.tsx`가 `rebuildVaultStateFromMarkdown()`를 항상 실행한다. 이 경로는 동기 Tauri 명령 `list_markdown_files`를 통해 Vault의 모든 Markdown 내용을 Rust 메인 UI 스레드에서 읽는다.

2026-07-24 실제 멈춤에서 Yonalist PID의 5초 스택 샘플 4,156개 전부가 다음 경로에 있었다.

```text
list_markdown_files
→ collect_markdown_files
→ std::fs::read_to_string
→ read
```

당시 Vault에는 Markdown 164개, SQLite `item_index`에는 이미 66개 항목이 있었다. 기존 인덱스로 화면을 표시할 수 있는데도 iCloud 파일 전체를 다시 읽어 UI 이벤트 루프를 막은 것이 직접 원인이다.

## 목표

- 기존 SQLite `item_index`를 먼저 읽어 GitHub Inbox를 즉시 표시한다.
- 파일 탐색, 내용 읽기와 SQLite 정합화는 Rust blocking pool에서 수행한다.
- YAML 파싱은 새 Rust 의존성을 추가하지 않고, 기존 `yaml` 패키지를 사용하는 Web Worker에서 수행한다.
- 변경되지 않은 Markdown 내용은 읽지 않는다.
- 정합화가 느리거나 실패해도 현재 목록과 사용자 입력을 유지한다.
- 신규·변경·삭제 파일을 다음 정합화 완료 시 반영한다.
- 중복 item 문서의 기존 승자 선택 규칙을 보존한다.

## 비목표

- GitHub 원격 동기화 변경
- 새 파일 watcher 또는 주기적 polling 추가
- 결과 streaming 또는 행별 React 갱신
- 새 runtime dependency
- Markdown 본문 전체를 프런트엔드로 반환
- Cards, 알림, Notes 인덱스 변경

## 사용자 동작 계약

### 기존 인덱스가 있을 때

1. GitHub Inbox를 누르면 `item_index`를 읽어 현재 목록을 먼저 표시한다.
2. outbox는 별도 비동기 작업으로 읽어 나중에 합친다. outbox가 느려도 목록 표시를 기다리게 하지 않는다.
3. 목록을 비우거나 전체 화면 loading 상태로 되돌리지 않는다.
4. idle 시점에 백그라운드 정합화를 한 번 시작한다.
5. 실제 변경이 commit되면 같은 Vault가 계속 열려 있을 때만 인덱스를 한 번 다시 읽는다.
6. 신규·변경·삭제가 있으면 한 번의 목록 갱신으로 반영한다.

### 인덱스가 없을 때

1. UI 이벤트 루프를 막지 않고 빈 Inbox와 loading 상태를 표시한다.
2. 백그라운드 정합화가 끝나면 목록을 표시한다.
3. 오류가 나면 빈 상태와 non-blocking 오류를 유지하고, 다음 Inbox 활성화에서 다시 시도한다.

## 데이터 흐름

```text
GitHub Inbox 활성화
→ list_vault_item_index
→ 캐시된 항목 즉시 표시
→ outbox는 독립적으로 비동기 로드
→ scheduleIdleTask
→ scan_vault_item_index_changes
→ spawn_blocking
   → Markdown 경로 + size + modified_ns 열거
   → document_hashes manifest와 비교
   → 신규/변경 파일만 읽고 hash + frontmatter 추출
   → 삭제 경로 계산
→ 기존 yaml 패키지를 쓰는 Web Worker에서 frontmatter 파싱
→ commit_vault_item_index_changes
→ spawn_blocking
   → 변경 파일 metadata 재검증
   → 짧은 SQLite 트랜잭션으로 manifest/candidate/index 교체
→ compact report 반환
→ 실제 변경이 있고 현재 Vault가 같으면 list_vault_item_index 한 번 재호출
```

현재의 자동 `rebuildVaultStateFromMarkdown()` 호출은 이 흐름으로 교체한다. 명시적인 전체 복구 API가 필요해도 동일한 백그라운드 실행 경계를 사용한다.

Rust가 변경 파일을 읽을 때 기존 `document_hashes.content_hash`와의 호환성을 위해 전체 파일 hash는 계산하지만, 프런트엔드에는 본문을 반환하지 않고 닫는 `---`까지의 frontmatter 문자열만 반환한다.

## SQLite manifest

기존 `document_hashes`는 경로별 캐시 행을 이미 보유한다. 새 테이블을 만들지 않고 다음 열만 추가한다.

```sql
ALTER TABLE document_hashes
ADD COLUMN modified_ns INTEGER NOT NULL DEFAULT -1;

ALTER TABLE document_hashes
ADD COLUMN item_candidate_json TEXT;
```

- `modified_ns`: 파일시스템 수정 시각의 Unix nanoseconds
- `item_candidate_json`: 본문을 제외한 canonical item metadata 또는 `NULL`
- 기존 `content_hash`, `size`, `relative_path`는 그대로 사용
- 기존 행은 `modified_ns = -1`이므로 배포 후 첫 정합화에서 한 번만 다시 읽는다.

`item_candidate_json`을 경로별로 보존해야 삭제된 승자 뒤에 남아 있는 중복 후보를 파일 재독 없이 다시 승자로 선택할 수 있다. `item_index`는 transaction 안에서 candidate 전체의 기존 dedupe 규칙을 적용해 재투영한다.

일반 변경 감지는 `(relative_path, size, modified_ns)` 비교로 한다. 크기와 nanosecond 수정 시각을 모두 보존하는 외부 도구의 변경은 자동 감지 범위 밖이다. 명시적 복구는 모든 `modified_ns`를 무효화한 뒤 같은 백그라운드 정합화 경로를 사용한다.

## 비동기 명령 경계

정합화용 파일 탐색과 SQLite 접근을 하는 두 명령은 async Tauri command이며, 실제 blocking 작업은 코드베이스에서 이미 쓰는 `tauri::async_runtime::spawn_blocking` 안에서 실행한다.

```rust
#[tauri::command]
async fn scan_vault_item_index_changes(
    vault_path: String,
) -> Result<VaultIndexScan, String>

#[tauri::command]
async fn commit_vault_item_index_changes(
    vault_path: String,
    changes: Vec<VaultParsedIndexChange>,
    removed_paths: Vec<String>,
) -> Result<VaultIndexCommitReport, String>
```

scan 응답의 변경 항목은 `relative_path`, `size`, `modified_ns`, `content_hash`, `frontmatter`만 포함한다. Markdown 본문과 전체 item 목록은 포함하지 않는다. commit 입력의 candidate는 기존 `VaultItemIndexRecord` 형태를 재사용한다.

```rust
// scan 응답과 commit 응답의 count를 프런트엔드 서비스가 합친다.
struct VaultReconcileReport {
    scanned: u32,
    read: u32,
    unchanged: u32,
    upserted: u32,
    removed: u32,
    deferred: u32,
}
```

처리 순서는 다음과 같다.

1. SQLite manifest snapshot을 읽고 transaction을 닫는다.
2. DB transaction 밖에서 파일 metadata를 열거한다.
3. 신규·변경 파일만 읽고 전체 hash와 frontmatter를 추출한다.
4. 읽기 전후 `(size, modified_ns)`가 달라진 파일은 이번 결과에서 제외하고 `deferred`로 센다.
5. Web Worker가 각 frontmatter를 독립적으로 파싱해 item candidate 또는 valid non-item으로 분류한다.
6. commit 직전에 변경 파일과 삭제 경로의 metadata를 다시 확인한다. 달라진 경로는 commit에서 제외하고 `deferred`로 센다.
7. scan 당시 manifest 값이 transaction 시작 시점에도 같은지 경로별로 비교한다. 앱의 저장 경로가 먼저 갱신한 행은 덮어쓰지 않고 `deferred`로 센다.
8. 짧은 `IMMEDIATE` transaction에서 manifest 변경, 삭제, `item_index` 재투영을 함께 commit한다.
9. 오류 시 transaction을 rollback하고 기존 인덱스를 유지한다.
10. upsert/delete가 0건이면 `item_index` 재투영과 프런트엔드 reload를 생략한다.

파일 탐색 중 iCloud가 수십 초 대기해도 Tauri 메인 스레드와 WebKit 이벤트 루프는 계속 동작해야 한다.

## YAML 파싱 경계

Rust용 YAML 파서를 새로 추가하거나 부분 YAML 파서를 직접 만들지 않는다. 둘 다 기존 TypeScript 파서와 해석이 달라질 수 있다. Vite의 기본 module worker를 사용해 현재 설치된 `yaml` 패키지로 변경된 frontmatter만 파싱한다.

- 파일별 parse 오류는 worker 전체 실패로 전파하지 않는다.
- parse 오류가 난 경로는 `deferred`로 남기고 기존 manifest/candidate/index를 보존한다.
- 유효하지만 item이 아닌 문서는 candidate를 `NULL`로 저장한다.
- candidate JSON은 Rust에서 기존 record type으로 다시 deserialize하고 필수 필드를 검증한다.
- 중복 winner 계산은 모든 저장 candidate를 대상으로 transaction 안에서 수행한다.
- 중복 winner는 현재 규칙과 동일하게 최신 `updated_at`을 선택하고, 누락된 comment count와 로컬 favorite는 다른 후보에서 보완한다.

현재 Vault의 frontmatter 56,232 bytes, Markdown 164개를 기존 `yaml` 패키지로 warmup 5회 후 31회 파싱한 사전 측정은 median 15.07ms, p95 15.94ms, max 16.27ms였다. React 적용 예산 16ms와 겹치므로 최초 정합화까지 UI thread에서 파싱하지 않고 worker로 격리한다.

## 기존 저장 경로와의 호환

`document_hashes`는 정합화 전용 테이블이 아니라 현재 파일 저장 중복 방지에도 사용된다. 따라서 새 candidate가 다른 저장 경로와 별도 진실 공급원이 되지 않게 다음 규칙을 적용한다.

- 파일 write/move가 hash 행을 바꾸면 `modified_ns = -1`로 무효화한다. item index upsert까지 완료되기 전에 앱이 종료돼도 다음 정합화가 파일을 다시 읽는다.
- 기존 `upsert_vault_item_index` transaction은 해당 source 행의 `item_candidate_json`도 함께 갱신하고, 파일의 현재 `size/modified_ns`를 기록한다.
- scan payload에는 비교 당시 manifest 값도 들어간다. commit은 SQLite 행이 그 값과 같은 경우에만 scan 결과를 적용한다.
- 기존 앱 저장과 reconcile commit은 SQLite transaction 순서로 직렬화한다. 먼저 끝난 쓰기를 나중 작업이 stale 값으로 되돌리지 않는다.
- 외부 파일 변경은 commit 직전 metadata 재검증으로 막고, 이후 발생한 변경은 저장된 fingerprint와 달라 다음 정합화에서 감지한다.

## 프런트엔드 통합

- `loadVaultState()`는 네이티브 인덱스가 비어 있어도 동기 전체 Markdown scan으로 fallback하지 않는다.
- cached item 표시가 outbox 파일 읽기를 기다리지 않게 item과 outbox 로드를 분리한다.
- `list_outbox_markdown_files`도 async command + `spawn_blocking`으로 옮겨 iCloud read가 UI 이벤트 루프를 막지 않게 한다.
- 기존 `rebuiltVaultRoot` guard를 재사용하되 Inbox가 비활성화되면 해제해, 활성화당 Vault 정합화를 한 번만 예약한다.
- 정합화 중에도 `drafts`, selection, filter, scroll을 유지한다.
- 실제 변경 완료 후 현재 `vaultRoot`가 요청 시작 시점과 같을 때만 item index를 한 번 다시 읽는다.
- 정합화 실패는 기존 목록을 지우지 않고 non-blocking 오류 상태와 performance trace만 갱신한다.
- 전체 Markdown 배열을 React state에 올리거나 행별 갱신하지 않는다.

## 동시성 및 정합성

- 동일 프런트 세션에서는 in-flight guard로 중복 정합화를 시작하지 않는다.
- 실패하거나 `deferred`가 남은 정합화는 polling하지 않고 다음 Inbox 활성화에서 다시 시도한다.
- 파일 scan 동안 SQLite write transaction을 열지 않는다.
- commit은 manifest와 `item_index`가 함께 성공하거나 함께 rollback한다.
- 파일이 읽는 도중 바뀌면 stale 내용을 기록하지 않고 다음 정합화로 미룬다.
- scan과 commit 사이 파일이 바뀌거나 삭제 파일이 다시 생기면 해당 경로만 `deferred`로 남긴다.
- malformed Markdown은 해당 경로의 이전 manifest/candidate를 유지한다. 다른 유효 변경은 commit할 수 있다.
- scan snapshot과 현재 manifest가 다르면 앱 저장이 우선이며 해당 scan 결과를 적용하지 않는다.
- Vault 전환 또는 컴포넌트 unmount 뒤 도착한 결과는 화면에 적용하지 않는다.
- GitHub fetch가 같은 item을 갱신하면 기존 item upsert 규칙과 SQLite transaction ordering을 따른다.

## 수치 기반 완료 조건

측정은 현재 규모 fixture(Markdown 164개, index 66개)에서 warmup 5회 후 31회 기록한다.

| 항목 | 기준 |
|---|---:|
| 기존 인덱스 Inbox 표시 p95 | 100ms 이하 |
| reconcile로 인한 메인 스레드 50ms 이상 long task | 0회 |
| reconcile 완료 후 React 적용 p95 | 16ms 이하 |
| main thread YAML parse 시간 | 0ms |
| 변경 없는 두 번째 reconcile의 Markdown 내용 read | 0회 |
| 신규/변경/삭제 결과 누락 | 0건 |
| 중복 item winner 불일치 | 0건 |

추가 지연 fixture에서 파일 read를 30초 멈춰도 클릭, 스크롤, Notes 전환이 계속 동작해야 한다. 백그라운드 전체 소요 시간에는 상한을 두지 않고 UI 응답성을 gate로 삼는다.

## 테스트 계약

### Rust

- 기존 manifest와 metadata가 같으면 내용 read 0회
- 신규, 내용 변경, rename, 삭제를 정확히 반영
- 같은 크기의 최신 `modified_ns` 변경을 감지
- 읽는 도중 metadata가 바뀐 파일은 `deferred`
- scan과 commit 사이 metadata가 바뀐 파일은 `deferred`
- malformed Markdown은 기존 인덱스를 손상시키지 않음
- transaction 실패 시 manifest와 `item_index` 모두 rollback
- scan 뒤 앱이 같은 문서를 저장하면 stale candidate가 최신 index를 덮어쓰지 않음
- 중복 문서의 승자 삭제 후 저장된 후보가 승자로 복구
- 인위적으로 느린 reader에서도 다른 Tauri UI 명령이 응답

### TypeScript/React

- cached item이 reconcile Promise보다 먼저 화면에 표시
- cached item 표시가 outbox Promise를 기다리지 않음
- index가 비어도 `list_markdown_files`를 호출하지 않음
- reconcile 중 목록, selection, filter, scroll 유지
- 실패 시 기존 목록 유지
- 실제 변경 완료 후 같은 Vault만 한 번 reload하고, 변경이 없으면 reload하지 않음
- Vault 전환 후 이전 결과 무시
- 한 세션에서 중복 reconcile 0회

### Web Worker

- 유효 item frontmatter를 기존 native record 형식으로 변환
- 유효 non-item을 candidate `NULL`로 분류
- 한 파일의 YAML 오류가 다른 파일 결과를 버리지 않음
- worker 응답 전 UI 이벤트 처리가 계속됨

### 수동 Tauri

1. iCloud Vault에서 Notes로 시작한다.
2. GitHub Inbox를 누른다.
3. background read를 의도적으로 지연한다.
4. Inbox 스크롤, 다른 sidebar 이동, 창 이동을 확인한다.
5. reconcile 완료 후 변경 파일이 한 번 반영되는지 확인한다.

## 배포 및 관찰

기존 performance trace에 다음 수치만 추가한다.

- cache load duration
- reconcile duration
- scanned/read/upserted/removed/deferred 수
- final index reload duration

파일 경로나 본문은 로그에 남기지 않는다. 저장 기준값을 올려 회귀를 숨기지 않으며, 메인 스레드 long task가 한 번이라도 발생하면 배포 gate를 실패시킨다.
