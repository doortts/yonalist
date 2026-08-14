# 파일 SSOT 포팅 계획 — 멀티 디바이스 first-class (v2)

- 작성: 2026-08-14. 기준: `refactor/p1-structure-surgery@bd0eb2ad`.
- 목표 재정의: **파일 기반으로 멀티 디바이스에서 잘 동작하는 앱.** 구조 감사 로드맵 §4는 "단일 기기 데스크톱이 기본이라 동시 쓰기 문제가 없다"를 해자 논거로 썼는데, 이 문서가 그 전제를 교체한다.
- 근거: v1 sync 코드 실측(38,667줄), v1 핸드오프 스펙([2026-07-21](2026-07-21-notes-file-ssot-sync-implementation.md)) 재독, 업계 사례 조사(Obsidian Sync·Syncthing·iCloud 실측 보고, Actual Budget, Logseq 사후 분석, CRDT 2026 현황).

## 0. 가장 중요한 사실 — v1은 처음부터 멀티 디바이스용이었다

v1 스펙 §0 첫 줄: "같은 사용자의 노트북 2대가 vault 폴더(iCloud/Dropbox/Syncthing/OneDrive 지정 가능)를 통해 Notes를 자동 동기화한다." 감사 로드맵이 "동시 쓰기 문제가 없다"고 쓴 것은 v2의 현 상태 설명이었지 v1 설계의 한계가 아니다. 멀티 디바이스에 필요한 장치가 전부 이미 구현돼 있고 테스트까지 있다:

| 장치 | 구현 | 확인 |
|---|---|---|
| 기기 간 인과 순서 | HLC 17자 고정폭 base36 인코딩 — 사전순 = 시간순, Rust/SQL/TS 어디서든 같은 비교 (`hlc.rs`) | 스펙 §4.1 |
| 원격 시계 관찰 | `observe(remote)` — 병합 후 로컬 발급 HLC가 항상 원격보다 큼 | 스펙 §4.1 |
| 노드 정체성 | `<!-- yid: uuid t: hlc -->` 주석, 파일명은 코스메틱 | `topic_parser.rs` |
| 삭제 전파 | trash.md 이동(LWW) + purge tombstone 이중 증거, **부재 ≠ 삭제** 불변 규칙 | 스펙 §1-1 |
| 오프라인 기기 보호 | tombstone 90일 보존 — "평소 꺼져 있는 기기가 증거를 받을 시간" | `mod.rs:62` |
| 병합 수학 | 멱등·교환적 노드 LWW — 같은 파일 두 번 병합 no-op, 순서 무관 | 스펙 §1-2 |
| 동시 편집 손실 방어 | 진 쪽을 loser JSON으로 `sync_conflict_log`에 중복 없이 기록 | `merger.rs:2048` |
| 손편집 수용 | 같은 HLC인데 내용이 다르면(외부 편집기가 yid/t를 보존한 채 수정) 파일 내용을 fresh HLC로 채택 | `merger.rs:2024` (A4) |
| yid 없는 신규 bullet | UUIDv4/HLC 신규 발급 + write-back | 스펙 §8 |
| 사이클/고아 | 결정적 파킹 — 같은 입력이면 같은 노드가 복구 topic으로 | 스펙 §8-3 |
| transport 쓰레기 | conflicted copy 격리 보존, iCloud placeholder 재시도 | `watcher.rs:519`, `:2109` 테스트 |

따라서 이 작업의 실체는 "멀티 디바이스 동기화를 새로 설계"가 아니라 **검증된 설계를 v2 육각형에 재배치하고, 알려진 결함을 수리하고, 멀티 디바이스를 명시 목표로 승격하면서 생기는 새 리스크를 닫는 것**이다.

## 1. 업계 조사 — 각 진영에서 취할 것

### Obsidian — 파일 SSOT의 상업적 증명, 그리고 그 한계

파일이 진실이고 앱은 뷰라는 모델("file over app")로 가장 성공한 제품. Obsidian Sync는 markdown 동시 편집을 Google diff-match-patch 3-way 병합으로 합치고, 비텍스트는 mtime LWW, 1.9.7부터는 자동 병합 대신 충돌 파일 생성 옵션을 준다. 한계이자 교훈 두 가지.

1. **블록 정체성이 없다.** 파일 정체성 = 경로라서 구조 편집(항목 이동·재배치)의 병합은 텍스트 diff 운에 맡긴다. 우리는 노드마다 yid가 있으므로 구조 병합에서 원리적으로 더 강하다.
2. **transport를 신뢰하면 안 된다는 것을 공식 문서가 인정한다.** "Obsidian Sync를 쓰면 같은 vault를 클라우드 드라이브 폴더에 두지 마라"가 공식 권고다. 2026년 커뮤니티 실측: iCloud는 작은 파일의 잦은 재작성에 최악(설정 JSON 손상, placeholder 미다운로드), Windows iCloud는 전파 지연으로 충돌 창이 넓어지고, Syncthing은 `.sync-conflict-*` 파일을 수십 개 만든다. **결론: transport가 무엇이든 그것이 만드는 쓰레기(conflicted copy, placeholder, 부분 전파)를 앱이 삼킬 수 있어야 한다.** v1 watcher가 이미 이 방향이다.

### Actual Budget — HLC LWW의 프로덕션 증명

로컬 SQLite + 필드 단위 LWW 메시지 + HLC + merkle trie diff로 다년간 멀티 디바이스 동기화를 운영한다. 개인용(단일 사용자, 기기 여러 대) 구조화 데이터에는 **문자 단위 CRDT 없이 HLC LWW로 충분하다**는 실증. v1의 노드 LWW는 같은 계열이다(메시지 로그 대신 상태 병합이라는 차이만 있다).

### Logseq — 반면교사 (감사 로드맵 §4에 상세)

정체성을 본문에만 두고, 키 입력을 파일에 직결하고, 시작 시 전체 재파싱한 것이 사인. 2.0에서 DB 정본 + 단방향 markdown mirror로 후퇴했고 mirror는 구조적으로 손실이 있다고 스스로 문서화했다. 우리 설계는 세 실수를 전부 비켜 간다(캐시가 입도 흡수, yid+재대응, 증분 재색인 원칙).

### CRDT 진영 2026 — Automerge 3 · Loro · Yjs

Automerge 3(2025 말, columnar 저장, 문서 크기 40-60% 감소)와 Loro 1.0(Rust, rich-text + movable tree CRDT)로 성숙기에 들어섰다. 문자 단위 텍스트 병합과 트리 이동 병합까지 라이브러리가 해 준다. 그러나 **CRDT 상태는 바이너리 파일이고, 그걸 정본으로 삼는 순간 markdown은 export가 된다** — Logseq 2.0이 서 있는 바로 그 자리다. grep·git·"LLM에게 폴더를 보여 준다"는 해자를 버리는 대가라 정본 채택은 기각. 단, 아래 §3의 충돌 정책에서 국소 참고안으로 남긴다.

### 종합 좌표

병합 입도 스펙트럼에서 우리 위치: **파일 단위(Obsidian) < 노드 단위(v1, 우리) < 문자 단위(CRDT)**. 단일 사용자 멀티 디바이스에서 충돌의 대부분은 서로 다른 노드에 떨어지므로 노드 LWW가 거의 전부를 조용히 흡수하고, 같은 노드 동시 편집만 conflict log가 받는다. Actual이 이 지점의 증거다. 문자 병합이 필요해지면 그때 노드 텍스트에 한해 diff-match-patch 3-way(Obsidian 방식, 의존성 하나)를 얹는 확장 경로가 열려 있다.

## 2. 아키텍처 선택지와 판정

| | A. 파일 SSOT + 노드 HLC LWW (v1 이식) | B. DB 정본 + md mirror (Logseq 2.0, Bear) | C. CRDT 정본 + md export |
|---|---|---|---|
| markdown 지위 | 진실 소스 | 손실 있는 사본 | 손실 있는 사본 |
| 멀티 디바이스 | transport 불가지론(아무 폴더 동기화) | 자체 서버/프로토콜 필요 | 자체 동기화 필요(any-sync류) |
| 같은 노드 동시 편집 | LWW + 충돌 로그 | 서버 중재 | 문자 단위 자동 병합 |
| grep/git/LLM 해자 | 유지 | 상실 | 상실 |
| 구현 비용 | v1 자산 이식 | 신규 서버 | 포맷 전면 교체 + 의존성 |
| 판정 | **채택** | 기각 — 목표와 정면 충돌 | 기각 — 해자 상실. 텍스트 병합만 국소 참고 |

## 3. v2 구조 — 파일이 first-class가 되는 배치

### 3.1 크레이트 배치 (육각형 유지)

```
apps/desktop/src-tauri  (어댑터)
  ├─ SyncRuntime 수명주기: watcher 스레드 시작/정지, Tauri 이벤트 emit
  └─ StartupGate: 증분 재색인이 여기 편승 (비차단 부팅 유지)
crates/notes-application  (포트·계약)
  ├─ SyncPort: status / conflicts(read!) / flush / vault 지정
  └─ SyncStatus·SyncConflict 계약 → ts-rs로 TS 타입 생성 (기존 37파일 관례)
crates/notes-core  (순수 도메인 — 무수정)
  └─ sync를 모른다. HLC는 도메인 개념이 아니라 저장·동기화 관심사다.
crates/notes-sqlite  (스키마 창 §5)
  └─ hlc 컬럼 + sync_* 테이블 + 스탬핑 트리거
crates/notes-sync  (신규 — v1 이식의 본체)
  ├─ file_io   (원자적 쓰기 계층, 그대로)
  ├─ hlc       (인코딩·클록·observe, 그대로)
  ├─ topic_file / topic_parser  (렌더러·파서, v2 필드로 개정 → 포맷 v5)
  ├─ merger    (LWW + conflict log + 파킹, 골격 그대로)
  ├─ exporter  (자가 검증 유지, N+1 수리)
  ├─ watcher   (conflicted copy 병합 승격, 폴링 제거)
  ├─ bootstrap (증분 재색인)
  └─ asset_gc
```

의존 방향: `notes-sync → notes-sqlite → notes-application → notes-core`. `checkV2Architecture.mjs`의 그래프 검사에 이 방향을 추가해 기계로 강제한다.

### 3.2 워커 접합 — 이 항목이 이식 난이도의 핵심이다

v2는 단일 워커 스레드(`worker.rs`, `mpsc::sync_channel(64)`)가 SQLite를 소유하고 revision 낙관적 동시성으로 프런트와 계약한다. **병합·export가 이 워커를 우회해 별도 연결로 쓰면 프런트가 든 revision이 조용히 낡는다.** 따라서:

- merger는 워커 큐에 들어가는 또 하나의 명령이다. 병합 트랜잭션이 revision을 올리고, 기존 구독 경로로 프런트에 변경을 알린다. v1의 "connection 캐시 경유 + reload 이벤트"보다 접합점이 오히려 좋아진다 — v2에는 이미 변경 통지 계약이 있기 때문이다.
- exporter의 읽기 스냅샷도 워커 경유. 단 파일 쓰기 자체는 v1 원칙대로 잠금 밖에서 한다(느린 클라우드 FS가 DB를 막지 않게).
- watcher 콜백은 파일 이벤트를 coalesce해서 워커 큐에 병합 요청만 넣는다. 콜백에서 SQLite를 직접 열지 않는다(v1 함정 목록 그대로).

### 3.3 undo × 원격 병합 — 감사 로드맵의 미해결 1번, 여기서 결정

v1 불변 규칙 10이 절반을 이미 답했다: **병합·부트스트랩은 history context 없이 실행 — 원격 변경은 undo 스택에 들어가지 않는다.** 남은 절반은 "병합 후 기존 스택 항목의 inverse가 낡은 상태를 가리키는" 문제다.

권고: **병합 배리어.** 병합이 노드 집합 S를 바꾸면, S와 교차하는 스택 항목까지 undo가 내려가지 못하게 배리어를 놓는다. 대안 대비:

- (a) 병합마다 스택 전체 절단 — 안전하지만 다른 노드를 고치던 undo까지 죽어 UX 손실이 크다.
- (b) **배리어(권고)** — 교차하는 역사만 잠근다. 사용자가 손대지 않은 편집을 undo가 지우는 경로가 구조적으로 사라진다. 구현도 스택에 마커 하나.
- (c) rebase — 병합 결과 위에 inverse를 재계산. 복잡도 대비 이득 없음. YAGNI.

### 3.4 vault 위치와 DB 위치

- v2 `notes-v2.sqlite`는 이미 `app_data_dir`에 있다(`lib.rs:271`). v1 스펙 §5.1이 요구한 "라이브 DB를 클라우드 동기화 폴더 밖으로"가 v2에서는 이미 달성돼 있다. vault 폴더에는 md와 `assets/`만 들어간다.
- v2에는 vault 개념이 아직 없다 — 위치 선택 UX와 저장처(설정)가 M1의 신규 작업이다. v1처럼 명령마다 `vault_path`를 끌고 다니지 말고 어댑터가 시작 시 한 번 해석해 SyncRuntime에 준다.

## 4. 멀티 디바이스 명시화로 새로 생기는 리스크

1. **tombstone 90일 창과 부활.** 90일 넘게 꺼져 있던 기기의 vault 스냅샷이 동기화되면 purge 증거가 이미 GC된 뒤라 삭제된 노드가 되살아난다(Cassandra `gc_grace_seconds`와 같은 문제 계열). 대응: 기기별 마지막 병합 HLC를 sync_meta에 기록하고, 창을 넘긴 스냅샷을 감지하면 자동 병합 대신 격리 + 사용자 확인. 90일 값 자체는 유지(v1 `asset_gc.rs:34`의 24시간 하드코딩과는 별개 — 그건 수리 대상).
2. **시계가 미래로 튄 기기.** HLC는 역행을 흡수하지만, 크게 미래로 간 시계가 발급한 HLC는 이후 모든 정상 편집을 이긴다. v1 파서에 `t: too-new` 관용 테스트가 있으나 정책이 없다 — 병합 시 로컬 시계 대비 최대 허용 드리프트(예: 24h)를 넘는 HLC는 fresh HLC로 재스탬프하고 로그.
3. **transport 겹침.** 같은 vault를 두 동기화 클라이언트가 만지는 구성(Obsidian 사용자들의 단골 사고)은 문서로 금지하고, 감지 가능하면 경고.
4. **conflicted copy는 위협이 아니라 입력이다.** 병합이 멱등·교환적이므로 Syncthing의 `.sync-conflict-*`나 Dropbox의 "conflicted copy"는 **그냥 병합하고 canonical 파일 하나로 다시 쓰면 끝**이다. v1 watcher는 격리 보존까지만 한다 — 이식하면서 "우리 포맷이 맞으면 병합 후 삭제"로 승격한다. 이게 노드 정체성 + 교환적 병합 설계가 주는 가장 실질적인 배당이다.
5. **yid를 잃은 손편집의 중복 생성.** 외부 편집기가 주석을 지우면 신규 노드로 발급되고 원본은 남는다(스펙 §8). Logseq처럼 정체성이 깨지진 않지만 중복이 생긴다. 개선(P2): 직전 스냅샷에서 사라진 노드와 텍스트·위치가 근접하면 재결합 시도. M0 스펙에 요구사항으로만 명시하고 첫 이식에서는 구현하지 않는다.

## 5. v1 → v2 갭 목록 (포팅 시 결정·수리 항목)

| 갭 | 내용 | 처분 |
|---|---|---|
| HLC 스탬핑 방식 | v1은 SQL 트리거로 기존 명령 무수정 스탬핑 | 같은 방식 채택 — notes-sqlite `mutations.rs` 무수정이 유지된다 |
| 포맷 필드 셋 | v4에는 v2에 없는 개념(plugin meta, archived_at, readonly, collapsed_groups)이 있다 | M0에서 v5 재정의. 파서는 미지 필드 보존(관대함 규칙 유지) — v1 vault를 읽을 수 있게 |
| 이미지 자산 | v1 `notes-assets/<sha256>.<ext>` ↔ v2 `images/` content-hash. 모델은 사실상 동일 | vault 쪽 경로는 v1 규칙 유지(정규형 링크만 파싱), 앱 로컬 캐시는 v2 유지 |
| exporter N+1 | dirty 노드당 3천 추가 질의(`exporter.rs:262`) | 이식하면서 수리 (감사 §4 그대로) |
| 1초 폴링 | `runtime.rs:776` | 이식하면서 제거 — 디바운스 타이머 + notify로 대체 |
| 충돌 로그 | 쓰기만 있고 읽기·정리 없음(`merger.rs:2048`) | SyncPort에 읽기 추가, 보존 상한(개수/기간) 신설, 설정 화면에 목록 + 복구 |
| 시작 시 재파싱 | v1 bootstrap 전체 파싱 | mtime+size 게이트 통과분만 해시 확인 — Logseq 붕괴 지점, 성능 계약으로 고정 |
| collapsed 동기화 | v1은 파일에 기록(기기 간 공유됨) | 유지 — 단순하고, 소음은 디바운스가 흡수. 기기별 분리는 필요가 증명되면 |
| 왕복 golden 테스트 | v1에 TRASH_GOLDEN 등 존재 | v5 포맷으로 갱신해 재사용 + 병합 교환성 property 테스트 신설 |

## 6. 마일스톤

각 단계 완료 조건: `test:v2` 초록 + 해당 단계의 왕복·결정성·교환성 테스트. 실행 체제는 기존 규칙(항목당 1커밋, 구현 후 적대적 리뷰).

- **M0 — 스펙 개정 (결정 문서).** v1 스펙을 v2 기준으로 재작성: 포맷 v5 필드 셋, §7 결정 6건 확정, 불변 규칙 10건 계승 선언. 이 문서가 이후 모든 단계의 진실 소스.
- **M1 — 골격.** `notes-sync` 크레이트 + `file_io`·`hlc` 이식 + 스키마 창(§8 로드맵과 통합: 마이그레이션 사다리 골격 먼저, 그 위에 sync 테이블·트리거) + vault 위치 설정.
- **M2 — 포맷.** topic_file 렌더러 + parser, 결정성(같은 상태 = 같은 바이트)·왕복 golden 테스트.
- **M3 — 병합.** merger 이식 + 워커 큐 접합 + revision 통지 + conflict log 읽기 IPC + undo 배리어. 교환성 property 테스트(두 문서를 양방향 순서로 병합 = 동일 상태).
- **M4 — 방출.** exporter(N+1 수리, 자가 검증 유지) + 디바운스 + trash/tombstone 방출.
- **M5 — 감시와 부팅.** watcher(폴링 제거, conflicted copy 병합 승격, placeholder 재시도) + bootstrap 증분 재색인 + StartupGate 편입.
- **M6 — 멀티 디바이스 검증.** 두 DB 인스턴스가 한 vault를 공유하는 통합 테스트로 v1 §12 매트릭스 재현 + 신규 시나리오(90일 창 격리, 시계 드리프트 재스탬프, conflicted copy 수렴, 동시 편집 conflict log). 성능 계약 갱신(부트스트랩 = 변경분만).

의존성: M0→M1→M2→M3→M4→M5→M6 직렬. M3의 undo 배리어만 프런트 협업이 필요하고 나머지는 Rust에 갇힌다.

## 7. 결정 필요 (M0에서 확정할 6건)

1. **transport 공식 지원 범위.** 클라우드 폴더 동기화(iCloud/Dropbox/Syncthing/OneDrive)는 기본. git은 "동작하지만 미보증"으로 시작할지(충돌 마커가 낀 파일은 파서가 거부 → 격리 경로로 이미 안전).
2. **같은 노드 동시 편집 정책.** LWW + 충돌 로그(v1)로 시작 권고. 3-way 텍스트 병합은 로그에 실충돌이 쌓이는 게 확인되면.
3. **collapsed 상태 동기화.** 유지 권고(§5 표).
4. **tombstone 창.** 90일 유지 + 초과 스냅샷 격리 정책 채택 여부.
5. **충돌 노출 수위.** "조용히 기록, 필요할 때 꺼내 봄" 철학대로 설정 화면 목록 + 복구 버튼 권고. 노드 인라인 배지는 하지 않는다.
6. **포맷 버전.** v5 재정의 권고 — v1 vault 호환은 "읽기는 관대하게"로 확보하고, v2가 쓰는 포맷은 v2 도메인에 정합하게.

## 8. 조사 출처

- Obsidian Sync 병합(diff-match-patch, 충돌 파일 옵션): [Obsidian Help — Sync 문서](https://deepwiki.com/obsidianmd/obsidian-help/2.3-synchronization-and-conflict-resolution), [Troubleshoot Obsidian Sync](https://retypeapp.github.io/obsidian/sync/troubleshoot/)
- transport 실측(iCloud 손상·지연, Syncthing 충돌 파일): [Obsidian sync conflicts 분석](https://synch.run/blog/obsidian-sync-conflicts/), [Obsidian iCloud Sync 2026](https://www.stephanmiller.com/obsidian-icloud-sync-windows/), [Syncthing 포럼 사례](https://forum.syncthing.net/t/obsidian-conflicts/19101)
- Actual Budget HLC+LWW+merkle: [Using CRDTs in the Wild — James Long](https://archive.jlongster.com/using-crdts-in-the-wild), [crdt-example-app](https://github.com/jlongster/crdt-example-app)
- CRDT 2026 현황(Automerge 3, Loro 1.0): [Yjs vs Automerge vs Loro 2026](https://www.pkgpulse.com/guides/yjs-vs-automerge-vs-loro-crdt-libraries-2026), [Local-First Software in 2026](https://verity.salient.community/research/local-first-software-in-2026.html), [local-first 원전 정리](https://wal.sh/research/local-first)
- Logseq 사후 분석: 구조 감사 로드맵 §4의 기존 조사(2026-08-14)
