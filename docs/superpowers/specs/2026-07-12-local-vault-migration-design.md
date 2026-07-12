# Local Vault Migration Design

## 목적

사용자가 Yonalist 설정에서 내장 디스크의 로컬 폴더를 선택하고, 현재 Vault의 모든 영속 데이터를 새 위치로 안전하게 이전할 수 있게 한다. 이전은 검증된 복사 후 전환 방식으로 수행하며, 성공한 뒤에도 기존 Vault를 이전 백업으로 보존한다.

이 설계는 Notes 이미지 입력 설계인 `2026-07-12-notes-multi-image-ingest-design.md`와 함께 동작한다. 기존 이미지와 메뉴 선택, 드래그 앤 드롭, 클립보드 붙여넣기로 추가할 단일·다중 이미지를 모두 이전 범위에 포함한다.

## 현재 동작과 문제

- 기본 Vault 경로는 `~/Yonalist`이다.
- `Settings > Vault folder`에서 경로를 문자열로 직접 수정할 수 있다.
- 저장된 경로는 즉시 새로운 Vault root로 사용되며 기존 데이터는 이동하지 않는다.
- 사용자가 경로를 잘못 입력하면 기존 데이터가 사라진 것처럼 빈 Vault가 표시될 수 있다.
- 폴더 선택, 대상 분류, 쓰기 권한, 여유 공간 및 경로 충돌 검사가 없다.
- 이전 도중의 동시 저장 차단, 진행 상태, 취소, rollback 및 crash recovery가 없다.
- 이전 백업을 등록하고 검증한 뒤 삭제하는 기능이 없다.

## 범위

- 운영체제 폴더 선택기
- 내장 디스크의 로컬 폴더 판별
- 비어 있는 대상 폴더, 권한, 여유 공간 및 경로 관계 검사
- 모든 Vault 영속 데이터의 검증된 복사
- SQLite 일관성 snapshot과 무결성 검사
- 이전 중 모든 Vault 쓰기 일시 정지
- 진행률, 취소, 오류 및 복구 화면
- crash-safe migration journal과 활성 Vault registry
- 검증 성공 후에만 새 경로로 전환
- 기존 Vault를 이전 백업으로 등록
- 현재 Vault 재검증 후 이전 백업 삭제
- 누락되거나 접근할 수 없는 활성 Vault의 복구 화면
- 기능, 적대적 오류 주입 및 성능 테스트

## 범위 제외

- 외장 SSD/HDD 또는 이동식 저장 장치
- iCloud Drive, Dropbox, OneDrive 등 동기화 폴더
- NAS, SMB, NFS 및 기타 네트워크 파일시스템
- 기존 Yonalist Vault 두 개의 병합
- 비어 있지 않은 일반 폴더로의 이전
- Notifications 목록과 상세 캐시 이전
- Vault 밖으로 내보낸 Markdown 및 PDF 이동
- 여러 기기에서 같은 SQLite Vault를 동시에 여는 기능

지원 대상이 아니거나 판별할 수 없는 volume은 fail closed 방식으로 거부한다. 경로 문자열을 직접 입력하여 검사를 우회하는 기능은 제공하지 않는다.

## 저장 데이터 범위

### GitHub 문서

- Issues, Pull Requests 및 Discussions의 frontmatter Markdown
- 댓글 Markdown
- 로컬 draft
- Issue 및 대화 첨부 파일
- `.yonalist/outbox`의 대기 작업
- `.yonalist/cache`의 Vault 연계 캐시
- `.yonalist/index.sqlite`의 검색 및 문서 hash 인덱스

### Notes

- `.yonalist/notes.sqlite`
- 페이지와 블릿 구조
- 제목, supporting note, 태그 및 날짜
- 완료, star, 접기, archive 및 trash 상태
- Notes history와 Undo/Redo 상태
- 이미지 연결, 입력 순서, 원본 크기 및 표시 너비
- `.yonalist/notes-assets`의 모든 이미지 원본

### 이전하지 않는 앱 데이터

- Notifications 목록, 상세 내용, 확인 시각 및 숨김 상태
- 인증 token
- 화면 theme 및 일반 UI 환경설정
- 외부 export 파일

이 데이터는 Vault가 아니라 운영체제 keychain 또는 WebView 앱 데이터에 남는다.

## 저장 위치 선택 UI

`Settings > Vault`의 자유 입력란을 다음 컨트롤로 교체한다.

- 읽기 전용 현재 저장소 경로
- 폴더 선택 아이콘 버튼
- 현재 저장소 상태
- 이전 백업 목록

폴더 선택기는 단일 directory만 반환한다. `dialog:allow-open` capability를 사용하며, 같은 권한은 Notes 이미지 파일 선택 오류 수정에도 사용한다.

사용자가 폴더를 선택하면 즉시 이전하지 않고 사전 검사 결과를 보여준다.

- 원본 및 대상 경로
- 이전 대상 파일 수와 총 크기
- 대상 volume 및 사용 가능한 공간
- 대상 폴더 상태
- 원본 백업 보존 정책

모든 검사를 통과해야 `저장소 이전` 명령을 활성화한다.

## 지원 대상 판별

Rust의 `VolumeClassifier`가 canonical destination path를 기준으로 다음 결과를 반환한다.

- `SupportedInternalLocal`
- `ExternalOrRemovable`
- `CloudSynchronized`
- `Network`
- `Unknown`

`SupportedInternalLocal`만 허용한다. 운영체제별 판별 구현은 공통 interface 뒤에 둔다.

- macOS: local 및 internal volume resource 속성을 모두 확인한다.
- Windows: fixed local drive이며 remote drive가 아닌지 확인한다.
- Linux: mount 정보에서 local fixed filesystem임을 확인하고 removable 및 network filesystem을 제외한다.

판별에 필요한 운영체제 정보가 없거나 서로 모순되면 `Unknown`으로 처리한다. 테스트에서는 classifier를 주입하여 플랫폼과 무관하게 각 분기를 검증한다.

## 대상 폴더 검사

대상은 다음 조건을 모두 만족해야 한다.

- canonical path를 만들 수 있다.
- 폴더 자체가 symlink가 아니다.
- source와 destination이 같지 않다.
- 어느 한쪽이 다른 쪽의 상위 또는 하위 경로가 아니다.
- 일반 사용자 데이터가 없는 빈 폴더이다.
- `.DS_Store` 또는 `Thumbs.db` 같은 알려진 운영체제 metadata만 있으면 논리적으로 빈 폴더로 취급한다.
- 임시 파일 생성, sync, rename 및 삭제 검사를 통과한다.
- source 예상 복사 크기에 `max(10%, 256 MiB)`의 안전 여유를 더한 공간이 있다.
- `VolumeClassifier`가 `SupportedInternalLocal`을 반환한다.

검사 이후 경로가 교체되는 TOCTOU 공격을 막기 위해 migration 시작 시 directory identity를 다시 확인하고 no-follow 방식으로 연다.

## 주요 구성요소

### `VaultLocationRegistry`

Tauri의 앱 설정 directory에 활성 Vault와 migration 상태를 원자적 JSON으로 저장한다.

- 활성 Vault canonical path
- 이전 migration ID와 상태
- source 및 destination identity
- 등록된 이전 백업
- 마지막 검증 시각

기존 `yonalist.settings.v1`의 `vaultFolder`는 최초 실행 시 한 번 import한다. 이후 활성 Vault의 source of truth는 native registry이며, WebView localStorage는 경로 결정에 사용하지 않는다.

registry 쓰기는 임시 파일 작성, file sync, atomic rename 및 parent directory sync 순서로 수행한다. registry를 읽기 전에는 Inbox, Notes 및 background sync를 시작하지 않는다.

### `VaultOperationGate`

모든 Vault 읽기·쓰기와 migration 사이의 접근을 조정한다.

- 일반 읽기 및 쓰기는 shared lease를 사용한다.
- migration은 exclusive lease를 사용한다.
- frontend는 migration 중 편집, 이미지 입력, GitHub sync 및 outbox 전송을 중지한다.
- Rust command도 gate를 확인하므로 background 요청이나 오래된 UI 요청이 우회할 수 없다.

migration 시작 전에 진행 중인 shared operation이 끝날 때까지 기다린다. 대기 중에는 아직 취소할 수 있다.

### `StorageMigrationService`

사전 검사, migration plan, 복사, 검증, commit, rollback 및 recovery를 담당한다. UI나 Notes 내부 구조에 직접 의존하지 않으며 다음 경계를 사용한다.

- `VolumeClassifier`
- `VaultOperationGate`
- `VaultLocationRegistry`
- `SqliteSnapshotter`
- `FileCopier`
- `VaultIntegrityVerifier`

### `MigrationJournal`

앱 설정 directory와 destination staging directory에 같은 migration ID의 journal을 기록한다.

- source 및 destination path와 directory identity
- 계획된 파일 목록과 예상 크기
- 단계와 완료된 파일
- 일반 파일의 source hash와 destination hash
- SQLite snapshot의 destination hash와 logical database fingerprint
- SQLite snapshot 상태
- commit 여부
- 오류 및 정리 상태

각 상태 변경은 원자적으로 기록한다. source Vault에는 journal을 쓰지 않아 이전 백업의 내용을 변경하지 않는다.

## Migration 단계

### 1. 사전 검사

1. source와 destination을 canonicalize한다.
2. volume, path 관계, 대상 비어 있음, 권한 및 공간을 확인한다.
3. source directory identity와 destination identity를 기록한다.
4. regular file을 순회해 migration plan을 만든다.
5. 사용자에게 요약을 보여주고 명시적 실행을 받는다.

source 안의 symlink, socket, device 및 알 수 없는 entry는 자동으로 따라가지 않는다. app-owned 경로에 이런 entry가 있으면 이전을 중단하고 위치를 안내한다.

### 2. 쓰기 정지 및 정합성 준비

1. frontend background 작업과 편집 명령을 중지한다.
2. `VaultOperationGate` exclusive lease를 획득한다.
3. Notes attachment 상태를 read-only audit하여 누락, 고아 및 pending reconciliation marker가 없는지 확인한다.
4. SQLite connection이 남아 있지 않은지 확인한다.
5. source identity가 사전 검사 때와 같은지 다시 확인한다.

### 3. Staging 복사

destination 내부의 앱 소유 staging directory에 복사한다. 일반 파일은 제한된 buffer로 읽고 쓰면서 source SHA-256을 계산한다.

다음 일시 파일은 plan에서 제외한다.

- `.notes-assets.lock`
- SQLite `-wal` 및 `-shm`
- 이번 migration의 임시 파일

`notes.sqlite`와 `index.sqlite`는 `SqliteSnapshotter`가 SQLite backup API로 staging에 생성한다. DB snapshot도 일반 파일과 동일하게 sync하고 hash를 기록한다.

### 4. 검증

staging에서 다음 검증을 수행한다.

- 계획된 regular file 수
- 파일별 byte 크기
- source와 destination SHA-256
- SQLite `PRAGMA integrity_check`
- 지원 schema version
- Notes node와 attachment foreign key
- attachment `relative_path`, MIME 및 content hash
- `notes-assets/<sha256>.<extension>` 규칙
- 참조 누락 이미지와 참조되지 않은 고아 이미지 부재
- Notes per-node 및 per-vault attachment 제한
- GitHub Markdown frontmatter parse 가능 여부
- outbox document parse 가능 여부

일반 파일은 source와 destination의 byte 크기와 hash를 직접 비교한다. SQLite snapshot은 backup API가 page layout을 바꿀 수 있으므로 source DB와 바이너리 hash를 비교하지 않는다. 대신 table별 row count, schema version, logical content fingerprint와 integrity 결과를 비교하고 destination snapshot 자체의 hash를 journal에 기록한다. 하나라도 실패하면 commit하지 않는다.

### 5. Promote 및 전환

1. destination identity를 다시 확인한다.
2. staging 내용을 destination root로 promote한다.
3. destination Vault를 read-only 검증 모드로 초기화한다.
4. destination에서 Inbox index, Notes workspace 및 이미지 byte를 표본이 아닌 전체 규칙으로 검증한다.
5. `VaultLocationRegistry`의 active path를 destination으로 원자적으로 commit한다.
6. source를 이전 백업으로 registry에 등록한다.
7. frontend store를 destination 기준으로 다시 초기화한다.
8. exclusive lease를 해제하고 background 작업을 재개한다.

registry commit 이전에는 source가 계속 활성 Vault다. registry commit 이후 앱이 종료되어도 다음 실행은 destination을 사용한다.

### 6. 완료

성공 화면에는 새 저장소와 이전 백업 경로를 표시한다. 이전 백업은 자동 삭제하지 않는다.

## Notes 이미지 첨부 통합

### 저장 구조

모든 Notes 이미지는 다음 위치를 사용한다.

```text
<vault>/.yonalist/notes-assets/<sha256>.<canonical-extension>
```

SQLite에는 node ID, 정렬 순서, 상대 경로, content hash, 원본 이름, MIME, 원본 크기와 표시 너비를 저장한다. 같은 image content는 같은 asset 파일을 공유한다.

### 입력 경로

다음 입력으로 생성된 이미지를 모두 동일하게 처리한다.

- 블릿 메뉴 파일 선택
- 한 개 또는 여러 이미지 drag and drop
- 한 개 또는 여러 clipboard 이미지 붙여넣기

다중 입력은 모두 성공하거나 모두 취소되며 history entry 하나와 Undo/Redo 단위 하나를 사용한다. 이 동작의 상세 사양은 `2026-07-12-notes-multi-image-ingest-design.md`를 따른다.

### Migration 동작

- migration guard가 활성화된 동안 새 이미지 import, resize 및 remove를 비활성화한다.
- read-only attachment audit가 현재 row와 retained history에서 도달 가능한 asset을 계산한다.
- 모든 asset file을 streaming copy하고 content hash를 양쪽에서 검증한다.
- 같은 hash를 참조하는 여러 attachment row의 dedup 관계를 유지한다.
- attachment 입력 순서, original dimensions 및 display width를 유지한다.
- Notes history snapshot도 옮기므로 이미지 추가·resize·remove의 Undo/Redo를 유지한다.
- 전환 후 frontend의 기존 object URL을 해제하고 destination에서 byte를 다시 읽어 생성한다.
- live attachment와 retained history 어디에서도 참조하지 않는 고아 asset 또는 누락 asset이 발견되면 자동 수정하지 않고 이전을 중단한다.

## 진행률과 취소

UI는 다음 단계를 순서대로 표시한다.

1. 저장 작업 정지
2. 데이터 준비
3. 파일 및 이미지 복사
4. 데이터베이스 검증
5. 첨부 참조 검증
6. 새 저장소 전환

복사 진행률은 완료 byte와 전체 예정 byte를 기준으로 계산한다. 진행 이벤트는 초당 최대 10회로 제한한다.

취소는 exclusive lease 대기, plan, copy 및 verify 단계에서 허용한다. promote 또는 registry commit이 시작되면 취소를 비활성화한다. 취소 요청은 현재 buffer 작업을 마친 뒤 2초 이내 반영하는 것을 목표로 한다.

## 오류와 Rollback

### Commit 전 실패

- source active path를 유지한다.
- frontend operation을 source 기준으로 재개한다.
- destination의 이번 migration staging과 promote된 앱 소유 파일만 제거한다.
- 사용자가 migration 전에 만든 entry는 삭제하지 않는다.
- 정리가 실패하면 journal에 남기고 `다시 정리` 명령과 정확한 경로를 제공한다.

### Commit 직후 초기화 실패

frontend store 재초기화가 실패하면 registry를 source로 되돌리고 source를 다시 연다. destination은 검증 가능한 실패 결과로 보존하며 사용자가 재시도하거나 정리할 수 있다.

### 앱 종료 또는 crash

시작 시 `VaultLocationRegistry`와 journal을 먼저 읽는다.

- commit 전 journal: source로 시작하고 `이전 계속` 또는 `대상 정리` 제공
- commit 완료 journal: destination으로 시작하고 frontend 초기화 재시도
- registry와 journal 불일치: 두 경로 identity와 무결성을 검사한 뒤 자동으로 더 진행하지 않고 복구 화면 표시

### 활성 Vault 접근 실패

설정된 경로가 없어지거나 권한을 잃어도 빈 Vault를 자동 생성하지 않는다. 다음 명령을 제공한다.

- 다시 시도
- 다른 저장소 선택
- 등록된 이전 백업으로 복귀

## 이전 백업

성공한 source를 `VaultLocationRegistry`에 immutable backup record로 등록한다.

- canonical path 및 directory identity
- migration ID
- 생성 시각
- 마지막 검증 결과
- destination path

백업 삭제 전에 다음을 다시 확인한다.

- 현재 active Vault가 건강하다.
- 삭제 대상이 active Vault가 아니다.
- registry의 path 및 identity와 일치한다.
- active와 상하위 경로 관계가 없다.
- 다른 진행 중 migration이 없다.

삭제는 별도 확인을 받은 뒤 no-follow recursive delete로 실행한다. 삭제는 Undo할 수 없으며 부분 실패 시 남은 경로를 보고한다.

백업 복귀는 현재 active Vault에 쓰기를 중지하고 backup 무결성을 검사한 뒤 registry path를 전환한다. 현재 active Vault는 새 backup record로 등록하여 왕복 복구 가능성을 유지한다.

## 테스트

### 단위 테스트

- 운영체제별 local/internal, external, cloud, network 및 unknown 분류
- canonical path 및 상하위 관계
- logical empty folder와 거부 entry
- symlink 및 directory identity 교체 차단
- 권한 및 여유 공간 검사
- migration plan의 포함 및 일시 파일 제외 규칙
- registry와 journal 원자적 상태 전이
- 진행률 제한과 취소 상태
- backup 삭제 guard

### 통합 테스트

fixture Vault에는 다음을 포함한다.

- 3종 GitHub item과 comments
- draft와 outbox
- `index.sqlite`
- Notes tree, archive, trash 및 history
- PNG, JPEG, WebP 및 GIF Notes 이미지
- 같은 hash를 공유하는 중복 attachment
- 서로 다른 display width

성공 이전 후 SQLite를 제외한 모든 regular file의 size와 hash를 비교한다. SQLite는 logical fingerprint, row count, schema와 integrity 결과를 비교하고 UI workspace도 확인한다. migration 각 단계에 오류를 주입하여 source 유지, destination rollback 및 journal recovery를 검증한다.

다음 실패를 각각 검사한다.

- 읽기 및 쓰기 오류
- disk full
- source 변경
- destination identity 교체
- hash mismatch
- SQLite snapshot 및 integrity 실패
- 누락 또는 고아 image
- registry commit 실패
- frontend 재초기화 실패
- cleanup 실패
- process 종료 후 resume

### 프론트엔드 테스트

- 폴더 선택 취소
- 사전 검사 성공 및 각 실패 메시지
- migration 중 모든 Vault write command 비활성화
- 진행 단계와 byte 진행률
- 취소 가능 및 불가능 단계
- 성공 후 새 Vault reload
- 복구 화면과 backup 복귀
- backup 삭제 확인
- image object URL 해제 및 재생성

### 이미지 입력 회귀 테스트

- 메뉴 picker의 단일 및 복수 선택
- native drop 대상 강조와 placeholder
- 여러 drop image의 순서 보존
- 여러 clipboard image의 순서 보존
- 전체 성공 또는 전체 취소
- batch 하나당 Undo/Redo 하나
- migration 중 import, resize 및 remove 차단
- migration 후 표시와 resize 유지

### 실제 앱 검증

- 기본 `~/Yonalist` fixture를 새 local folder로 이전
- Issues, comments, Notes와 모든 이미지 열기
- migration 중 종료 후 재개와 정리
- 실패 후 source가 계속 동작하는지 확인
- 성공 후 source backup 복귀
- backup 삭제 guard와 실제 정리

## 성능 검증

### CI fixture

- Markdown 5,000개
- 이미지 500개
- 총 약 256 MiB

### 로컬 stress fixture

- 문서 20,000개
- 이미지 2,000개
- 최대 5 GiB

### 기준

- 개별 파일 전체를 메모리에 올리지 않는다.
- migration 전 안정 상태 대비 추가 peak memory가 128 MiB를 넘으면 성능 테스트에 실패한다.
- progress event는 초당 최대 10회다.
- copy 및 verify 단계의 취소 반응은 2초 이내다.
- 전체 migration의 유효 처리량은 동일 장치에서 같은 fixture를 단순 복사한 기준 처리량의 50% 이상이어야 한다.
- 결과에 총 시간, copy 시간, verify 시간, 평균 처리량, peak memory 및 파일 수를 기록한다.

고정 MB/s는 하드웨어 차이 때문에 통과 기준으로 사용하지 않는다. 기준을 넘기지 못하면 병목 profile과 원인을 결과에 포함하고 수정 후 다시 측정한다.

## 단계별 개발과 리뷰

공유 interface를 먼저 고정한 뒤 다음 작업을 가능한 범위에서 병렬화한다.

- native registry, journal 및 volume 검사
- operation gate와 migration service
- 설정 UI, 진행 및 recovery 화면
- Notes 이미지 입력과 migration 연동
- fixture, 오류 주입 및 성능 harness

각 단계는 테스트 작성, 구현, 단계 리뷰, 수정 및 재검증 순서로 완료한다. 마지막에는 별도의 적대적 리뷰에서 경로 우회, TOCTOU, crash window, partial cleanup, SQLite 일관성, image 손실 및 기존 Yonalist 기능 회귀를 집중적으로 검사한다. 유효한 지적은 수정 후 같은 리뷰와 테스트를 반복한다.

## 성공 기준

- 사용자가 설정에서 비어 있는 내장 로컬 폴더를 선택할 수 있다.
- 지원하지 않는 volume과 위험한 경로를 이전 전에 차단한다.
- 기존 Issues, 댓글, outbox, Notes DB 및 모든 이미지가 검증된 상태로 복사된다.
- 모든 검증에 성공한 경우에만 active Vault가 바뀐다.
- 실패, 취소 또는 crash 시 기존 Vault에서 계속 작업할 수 있다.
- 기존 Vault는 이전 백업으로 보존되고 안전한 복귀와 삭제가 가능하다.
- 단일·다중 이미지 첨부, 표시, resize 및 Undo/Redo가 이전 전후 동일하다.
- Notifications 및 다른 Yonalist 기능에 회귀가 없다.
- 기능, 적대적 오류 및 성능 검증 결과가 모두 기록된다.
