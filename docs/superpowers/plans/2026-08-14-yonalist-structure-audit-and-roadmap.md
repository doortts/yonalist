# Yonalist 구조 진단과 리팩터링 로드맵 (핸드오프)

- 작성: 2026-08-14. 기준: `main@711996b7` + 당시 작업 트리(커밋 전 변경 16파일 포함).
- 이 문서 하나가 재개 지점의 진실 소스다. 세션 채팅과 실행 중 태스크는 기기 전환 시 소실된다.
- 시각 보고서(같은 내용의 읽기용 판): https://claude.ai/code/artifact/ef144116-bd59-40ea-9b0a-23e693075515
- 근거: 코드 감사 3건(프런트엔드 / Rust·Tauri 백엔드 / 문서-실제 대조, 전부 file:line 인용) + 제품 조사 2건(Workflowy 2025–26 기능·성능, Logseq DB 전환 사후 분석).
- 실행 체제는 기존 규칙을 유지한다: 설계·리뷰 Fable xHigh, 코드 Opus xHigh, 항목당 1커밋, worktree 격리.

## 0. 재개 지점 (여기부터 읽으면 된다)

**완료된 것: P0-1 게이트 수리.** `scripts/checkV2Architecture.mjs:192`에 `core:window:allow-start-dragging`을 추가했다. 작업 트리의 macOS 창 크롬 변경이 이 권한을 `apps/desktop/src-tauri/capabilities/default.json`에 넣었는데 검사 스크립트의 하드코딩 목록에는 빠져 있어 `npm run test:v2` 전체가 실패하던 상태였다.

수리 후 게이트 전 단계 초록:

| 단계 | 결과 |
|---|---|
| `cargo test --workspace` | 전부 ok, 0 failed |
| vitest (`apps/desktop`) | 72 파일 / 733 테스트 통과 |
| `eslint apps/desktop/src` | 통과 |
| 아키텍처 경계 | PASS |
| 생성 계약 | PASS (37 파일) |

이 한 줄은 커밋하지 않았다. 권한을 추가한 창 크롬 작업과 같은 묶음이라 그쪽과 함께 나가는 게 맞다.

**다음 항목: P0-2 (CI를 v2로 전환).**

**작업 트리에 커밋 안 된 변경 두 갈래** — 재개할 때 먼저 확인할 것:
1. macOS 네이티브 창 크롬: 창 생성이 `tauri.conf.json`에서 Rust `WebviewWindowBuilder`로 이동(`apps/desktop/src-tauri/src/lib.rs`), 신호등 인셋을 macOS 버전별로 선택(Tahoe 26은 22/20, 이전은 20/15), `decorations(true)` + `TitleBarStyle::Overlay`.
2. 사이드바 재편 + 링크 렌더링: 검색이 헤더 아이콘 뒤로 접힘(`App.tsx`), Pages에 "All" 행 추가, 링크가 `<button>`에서 `<span role="button">`으로 교체(긴 URL 줄바꿈이 깨지던 문제, `OutlineTextField.tsx`).

## 1. 핵심 판정

**v2 코드베이스는 방향이 옳고 품질도 평균을 크게 웃돈다. 대규모 재작성은 필요 없다.** 순수 도메인 크레이트, 타입화된 에러, 의존 방향 자동 검사를 갖춘 구조라 리팩터링은 국소 수술로 끝난다.

급한 것은 코드가 아니라 결정 3건이다.

1. 지향점인 "텍스트 파일 = 진실 소스"가 정작 출하되는 v2에는 없다. 완성된 파일 동기화 파이프라인은 동결된 v1 안에 잠들어 있고, parity matrix에서는 "승인된 제외" 항목이다.
2. 저장소 Rust의 89%, 프런트엔드의 84%가 그 동결된 v1이다.
3. CI는 레거시 트리만 검사한다. v2 게이트는 전부 수동이다.

### 저장소 지도 — 한 저장소, 두 개의 앱

루트 `src/` + `src-tauri/`(v1)와 `apps/desktop/` + `crates/`(v2)는 계층 관계가 아니라 코드를 한 줄도 공유하지 않는 별개 애플리케이션이다. `apps/desktop/src-tauri/Cargo.toml`에 `yonalist` 의존이 없고, `checkV2Architecture.mjs`는 v2가 레거시 프런트엔드를 import하면 오류를 낸다.

| | v1 (루트) | v2 (apps/desktop + crates) |
|---|---|---|
| 역할 | 동결. parity matrix의 행동 기준으로만 참조 | 출하 제품 (`com.doortts.yonalist.v2`) |
| 규모 | TS 197k LOC / Rust 121,606 LOC | TS 37k LOC / Rust 1,578 + 9,180 LOC |
| IPC 명령 | 79개 | 20개 |
| 저장 모델 | markdown vault SSOT + SQLite 캐시 (HLC 동기화 완비) | **SQLite 단독** (`notes-v2.sqlite`) |
| Cargo | 워크스페이스에서 `exclude` (`Cargo.toml:9`) | 워크스페이스 멤버 4크레이트 + 어댑터 |
| CI | `ci.yml`이 검사하는 유일한 대상 | 어떤 검사도 CI에 없음 |
| 마지막 커밋 | 2026-07-29 | 2026-08-14 |

기본 실행 명령(`npm run tauri:dev`)은 v2를 띄우지만 기본 `npm test` / `build` / `lint`는 여전히 v1을 가리킨다.

### v2 구조 요약

백엔드는 육각형 계층이다. `apps/desktop/src-tauri`(어댑터, IPC 20개, `StartupGate`로 비차단 부팅) → `notes-application`(포트·계약, ts-rs로 TS 타입 생성, `NotesError` 12종) → `notes-core`(순수 도메인, 의존성은 serde/thiserror뿐) → `notes-sqlite`·`notes-export`(단일 워커 스레드 + mpsc, STRICT 테이블, revision 낙관적 동시성).

프런트엔드는 라이브러리 없이 만든 저장소 클래스 + `useSyncExternalStore` 조합이다. 노드는 트리가 아니라 평탄 배열(`NoteView[]`, 부모 포인터 + `sortKey` 정수)로 두고 트리 구조는 `OutlineIndex`가 필요할 때 파생시킨다. 구독은 셸 / 아웃라인 / 노드별 3단계로 나눠 행 단위 리렌더를 막는다. 되돌리기는 Rust가 실제 스택을 소유하고 프런트는 그룹 경계와 커서 복원만 맡는다.

## 2. 지킬 것 (리팩터링에서 건드리지 말 것)

- **순환 의존 0건.** `checkV2Architecture.mjs`가 Rust·프런트 양쪽 그래프를 기계 검사한다. 죽은 모듈도 0건.
- **TODO/FIXME 0건** (13만 줄 전체). `ponytail:` 한계 표시 8건은 전부 실제 상한을 정확히 기록한다.
- **테스트 밀도.** 프런트 1.17 : 1(테스트 LOC : 제품 LOC), v2 Rust는 통합 테스트 18파일 + 성능 계약 테스트.
- **v1의 원자적 파일 계층** — `src-tauri/src/file_io.rs`: fsync + 부모 디렉터리 sync + `renameat2(NOREPLACE)` + cap-std 샌드박스, 제품 코드 unwrap 0. 포팅 1순위 자산.
- **v1 exporter의 자가 검증** — `exporter.rs:2164`가 쓸 바이트를 다시 파싱해 불일치면 거부하고, 느린 클라우드 FS가 DB를 막지 않도록 잠금을 풀고 쓴다.
- **모범 모듈** — `apps/desktop/src/api.ts`(87줄, 메서드당 invoke 하나), `outlineKeyboard.ts`(React도 DOM도 모르는 순수 키 해석기), `outlineClipboard`/`outlinePaste`(왕복 대칭 문서화), `outlineMenuCommands.ts`(선언적 명령 테이블).
- **일관된 용어 체계** — band·head·anchor·station·forest가 전 파일에서 같은 뜻으로 쓰인다. 주석은 재서술이 아니라 근거(WebKit 특성, 타이밍 제약)를 남긴다.

## 3. 리팩터링 항목

### P0 — 게이트와 죽은 무게

| # | 항목 | 근거 | 크기 |
|---|---|---|---|
| 1 | ~~권한 목록 1줄 수리~~ **완료** | `checkV2Architecture.mjs:192` | 1줄 |
| 2 | **CI를 v2로 전환.** `.github/workflows/ci.yml`이 지금 레거시만 빌드·테스트한다. `test:v2`(cargo workspace + vitest + lint + 아키텍처 + 계약)를 CI로 올린다. | v2 관련 검사 0건 | S |
| 3 | **v1 처분 결정.** 권고: 태그를 남기고 브랜치로 아카이브한 뒤 main에서 삭제. parity matrix가 참조하는 oracle 경로는 태그로 고정하면 된다. 루트 `npm test`/`build`/`lint`가 v1을 가리키는 문제도 같이 해소된다. | Rust 89% · TS 84%가 동결 코드 | 결정 + S |

### P1 — 코드 수술 (다음 기능 작업 전에)

| # | 항목 | 근거 | 크기 |
|---|---|---|---|
| 4 | **`NotesOutline.tsx` 갓 컴포넌트 분해.** 626줄 함수 하나에 훅 19개. 1차로 클립보드 정책(~125줄 순수 로직)을 `useOutlineClipboard(store, selection, index)`로, 커서 인계를 `useOutlineCaretHandoff()`로 추출한다. 둘 다 클로저 의존이 얕아 그대로 떼어진다. | `NotesOutline.tsx:55-680`, 클립보드 블록 `:293-416`. 단독 테스트 불가, 모든 아웃라인 기능이 이 파일에 착지 | M |
| 5 | **위치 인자 18~19개를 옵션 객체로.** `handleOutlineKeyDown`(18개)과 `handleImagePrimaryKeyDown`(19개)은 같은 타입 콜백이 6개라 둘이 뒤바뀌어도 컴파일이 통과한다. 코드베이스가 2개 인자 사례에는 경고 주석을 달아 놓고 19개를 커밋한 상태다. | `outlineSupport.ts:54-72`, `:163-181`; 호출부 `OutlineRow.tsx:420`, `:331` | S |
| 6 | **뷰포트 CTE 개선.** 80행 창 하나를 계산할 때마다 페이지 전체 서브트리를 재귀 CTE로 걷는다(문서 끝까지 스크롤하면 O(N²/80)). `collapsed` 가지도 내려간다. 접힌 가지 가지치기 + 정렬 키 물질화가 답이다. `anchor_offset`은 같은 CTE를 한 번 더 돈다. | `crates/notes-sqlite/src/queries.rs:103-137`, `:359` — 출하 앱의 핵심 읽기 경로 | M |
| 7 | **읽기 경로의 쓰기 제거.** 뷰포트 조회마다 `notes_ui_state` upsert가 실행돼 스크롤이 단일 워커의 쓰기 트랜잭션 뒤에 줄을 선다. 디바운스하거나 세션 종료로 옮긴다. | `queries.rs:161-168` | S |
| 8 | **`validate()`에 자식 인덱스 도입.** 노드마다 전체 스캔 + 정렬(O(n² log n))을 명령당 두 번 수행하고 트리 전체를 깊은 복사한다. 5k 노드 서브트리 삭제면 약 2,500만 비교. `parent_id`로 한 번 인덱싱하면 끝난다. | `crates/notes-core/src/tree.rs:326`, `:28`; 호출 `:41`, `:61` | S |
| 9 | **폴더 구조 도입.** 179개 파일이 한 디렉터리에 평탄하게 있다. 이미 지켜지는 접두사(`store*` `outline*` `preview*` `image*`)가 그대로 폴더 이름이다. 기계적 이동이고, 옮기면 계층을 import 규칙으로 강제할 수 있다. | `apps/desktop/src` 평탄 구조; lint가 사실상 꺼져 있음(`eslint.config.js:4-6`) | M |

### P2 — 기회 있을 때

| # | 항목 | 근거 |
|---|---|---|
| 10 | 서브트리 판정 5중 구현 통합 (`OutlineIndex`로 수렴). `subtreeIds`가 반환 타입이 다른 채 두 번 export된다. | `storeState.ts:17-31`, `outlineDragEngine.ts:134-143`, `outlineIndex.ts:96-108`, `useOutlineSelection.ts:109-122`, `outlineClipboard.ts:15-34` |
| 11 | 수제 롤백 5종을 역패치 공유로. 범용 역패치가 `previewPatchHistory.ts`에 이미 있다. | `storeOutlineMutations.ts:96-341`, `ponytail:` 표시 `:276` |
| 12 | preview 백엔드 유지 정책 결정. 브라우저 개발용으로 Rust 백엔드를 TS로 1,500줄 재구현(+테스트 955줄)했고 Rust 명령이 바뀔 때마다 두 벌을 수정한다. 유지한다면 두 구현의 드리프트를 잡는 계약 테스트가 필요하다. | `previewApi.ts` + `preview*` 8모듈 |
| 13 | 렌더 중 변이 3곳 정리. 앞의 둘은 지금도 제거 가능하고 `rowRuntime`은 성능 부하를 지는 축이라 문서화 후 유지한다. | `App.tsx:216`, `NotesOutline.tsx:140`, `:437` |
| 14 | 문서 드리프트 정리. parity matrix가 Export·Appearance를 "missing"이라 하지만 둘 다 출하됐다. README는 v1을 제품이라 설명하고 존재하지 않는 Monaco 표면을 언급한다. 계약 파일 수(32→37)와 번들 예산(300→312KB)도 낡았다. `architecture.md`에는 `crates/notes-export`가 빠져 있다. | 문서 9곳 대조 |
| 15 | 저장소 위생. `.superpowers/sdd/` 추적 파일 24개를 `git rm --cached`(ignore가 소급 적용되지 않은 상태), `.claude/launch.json`의 죽은 절대 경로 제거, `packages/contracts`를 상대 경로 대신 패키지 이름으로 import. | 워크스페이스 별칭이 장식으로만 존재 |
| 16 | 이미지 중복 검사의 재독 제거. sha256이 이미 같음을 증명했는데 기존 파일 전체를 다시 읽어 byte 비교한다. 20MB 중복 붙여넣기마다 20MB 재독. | `crates/notes-sqlite/src/image_assets.rs:76-118` |

### 결함이 아닌 것 (기록용)

`user_version != 1`이면 하드 에러를 내는 무마이그레이션 구조(`crates/notes-sqlite/src/schema.rs:78-82`)는 릴리즈 전 스키마 동결이라는 기존 결정과 일치한다. 다만 **첫 릴리즈 직전에** 빈 마이그레이션 사다리 골격을 넣는 일은 그 시점의 필수 항목으로 잡아 둔다. 사다리 없이 릴리즈하면 다음 스키마 변경이 기존 설치를 전부 벽돌로 만든다.

`checkV2Architecture.mjs`가 내는 500/800줄 초과 경고 15건은 advisory여서 아무도 실패시키지 않는다. 목록이 곧 P1-4/P1-9 대상이다(`NotesOutline.tsx` 727줄, `outlineKeyboard.ts` 746줄, `App.tsx` 594줄, `outlineSupport.ts` 579줄, `notesStore.ts` 517줄).

## 4. 파일 SSOT 정합성 — Logseq 교훈과 포팅 계획

parity matrix에서 "Vault Markdown 동기화"는 승인된 제외 항목이었다. 그 이월이 이제 만기다. 지향점을 유지하는 한 v2에 동기화 파이프라인이 없는 현 상태는 제품이 지향과 다른 저장 모델로 굳어 가는 중이라는 뜻이고, 데이터가 쌓일수록 전환 비용이 커진다.

### Logseq가 파일을 버린 이유가 우리에게 유리한 이유

Logseq는 2026-07 "Logseq 2.0"에서 파일 기반(OG)을 유지보수 모드로 내리고 SQLite를 정본으로 삼았다. 그런데 그들이 밝힌 실패 원인을 뜯어 보면 파일 자체가 아니라 설계 실수 쪽이다.

- 정체성이 본문 텍스트 안에만 있었다. `id::` 속성이 사용자 파일을 오염시키면서도 외부 편집 한 번에 블록 정체성이 깨졌다.
- 다중 기기 동시 쓰기가 데이터 손실의 실제 진원지였다. 여러 클라이언트가 같은 파일을 통째로 재작성했다.
- 블록 단위 편집을 파일에 직결해 키 입력마다 파일을 재작성했고, 시작할 때 전체를 재파싱해서 2천 페이지에 4~10분이 걸렸다.
- 그 결과 grep·git·"LLM에게 노트 폴더를 보여 주는" 워크플로를 잃었고, Markdown Mirror(단방향)와 CLI라는 별도 기능으로 재건축해야 했다. DB에서 내보낸 markdown은 구조적으로 손실이 있다고 스스로 문서화했다.

우리 설계는 이 함정을 대부분 비켜 간다. 단일 기기 데스크톱이 기본이라 동시 쓰기 문제가 없고, SQLite 캐시가 편집 입도를 흡수해 디바운스된 원자적 쓰기만 파일에 닿으며, 파일이 정본이므로 충실도는 구성상 보장된다(캐시는 언제든 버리고 재구축). Logseq가 기능으로 되사야 했던 것들 — grep, git, 파일시스템이 곧 API — 을 우리는 공짜로 갖는다. 이게 이 앱의 해자다.

**설계 리스크 1건 — 정체성 주석.** v1 파일 포맷은 노드 정체성을 `<!-- yid: uuid t: hlc -->` 주석으로 파일 안에 둔다. Logseq의 `id::`와 같은 지점이다. 외부 편집기가 이 주석을 지우거나 망가뜨릴 때의 관용적 재대응(텍스트 유사도나 위치로 기존 id에 다시 잇는 경로)을 포팅 시 명시적 요구사항으로 넣는다. Logseq는 이게 없어서 정체성이 깨졌다.

### 포팅 자산과 순서

v1 파이프라인은 스텁이 아니라 완성돼 있고 이례적으로 엄격하다. SQL 트리거 기반 HLC 스탬핑·dirty 추적(`src-tauri/src/notes/schema.rs:208-228`), 3초/30초 디바운스, 렌더→재파싱 자가 검증, fsync + NOREPLACE 원자적 쓰기, notify 감시자 + 60초 전체 재스캔 안전망, 노드 단위 HLC LWW 병합(고아·순환 파킹 포함), 90일 tombstone GC, sha256 자산 GC를 모두 갖췄다. v2의 육각형 구조에 맞춰 `notes-sync` 크레이트로 옮긴다.

1. `file_io.rs` 원자적 쓰기 계층. 그대로 이식 가능한 최상급 자산이다.
2. exporter + 자가 검증. 이식하면서 알려진 결함을 함께 고친다 — `exporter.rs:262`의 dirty 노드당 N+1 조회(1,000노드 편집이면 약 3,000 추가 질의, 디바운스 만료까지 1Hz로 반복 평가)와 `runtime.rs:776`의 1초 폴링(`ponytail:` 표시가 이미 위치를 알려 준다).
3. watcher + 부트스트랩 조정. 단 **시작 시 전체 재파싱 금지** — mtime/hash 기반 증분 재색인을 원칙으로 삼는다. Logseq 최대 성능 실패 지점이다.
4. HLC LWW merger. 이번에는 충돌 로그에 읽기 경로를 함께 만든다. v1은 `merger.rs:2048`에서 로그를 쓰기만 하고 IPC로도 UI로도 노출하지 않아, 사용자가 덮어쓰인 편집을 복구할 데이터가 묻혀 있었다. 게다가 정리 경로가 없어 무한히 쌓인다. "신경 안 써도 잘 동작하는 앱"이라면 충돌은 조용히 기록하되 필요할 때 꺼내 볼 수 있어야 한다.

포팅 시 함께 확인할 v1 `ponytail:` 표시 7건: `exporter.rs:1713`(잠금 아래 세그먼트 쓰기), `repository.rs:308`(테스트가 레거시 vault 경로 유지), `watcher.rs:574`(병합과 회수 I/O 미분리), `runtime.rs:776`(폴링), `asset_gc.rs:34`(24시간 하드코딩), `asset_gc.rs:3146`(해시 불일치가 치명적), `merger.rs:1665`(병합 topic 서브트리만 재스캔).

또 하나: `src-tauri/src/notes/mod.rs:17-19`의 `#[allow(dead_code)]`가 30k줄 `sync` 모듈 전체를 덮고 있고 주석은 "아직 미연결"이라 주장하지만 실제로는 명령 6개가 등록돼 있다. v1에서 진짜 죽은 코드를 찾는 유일한 lint를 막고 있으므로, P0-3 판단 전에 이 속성만 떼고 경고를 확인하는 편이 좋다.

## 5. Workflowy · Logseq DB 비교 — 기능 보강 우선순위

철학이 "간결한 화면, 필요할 때만 등장, 알아서 잘 동작"이므로 기준은 기능 수 경쟁이 아니라 감각 재현이다.

| Workflowy를 정의하는 것 (중요 순) | v2 상태 | 비고 |
|---|---|---|
| 1. 줌 + 브레드크럼 + 하나의 무한 트리 | 있음 | 완성. 분할 창은 Workflowy에 없는 우리 쪽 우위 |
| 2. 입력 즉시 필터되는 검색, **조상 사슬 보존** | 부분 | 사이드바 검색 패널은 있으나 아웃라인 제자리 필터가 아니다. **최대 격차** |
| 3. 키보드 모델 (Tab/Shift+Tab, 이동, 완료, 복제) | 있음 | 순수 해석기 + 테스트 1,234줄로 탄탄 |
| 4. 안 보이는 크롬 — 호버에만 나타나는 조작부 | 있음 | 앱 철학과 정확히 일치. 유지 |
| 5. 키 입력 단위 저장 + 깊은 undo | 있음 | Rust 소유 undo 스택. 파일 SSOT + git이 붙으면 Workflowy가 못 하는 세션 간 이력까지 가능 — 차별화 기회 |
| 6. 태그 — `#` 자동완성 + 클릭 즉시 필터 | 진행 중 | `docs/v2/tag-spec.md`(2026-08-14)가 정확히 이 둘을 설계. 태그를 엔티티로 승격하지 않는 절제 포함 — 방향 타당 |
| Cmd+K 퍼지 점프 팔레트 | 없음 | "감춰 놓되 필요하면 등장" 철학의 정수. 검색 다음 순위 권고 |
| 날짜 객체 · 캘린더 뷰 | 부분 | `notes_dates` 테이블은 이미 있고 UI만 없다. 후순위 |
| 미러 · 보드 뷰 · 표 | 없음 | **보류.** 미러는 파일 SSOT 포맷과 충돌하는 난제다(한 노드가 두 파일에?). SSOT 안착 전 착수 금지 |
| 전역 빠른 캡처 (핫키 → 인박스) | 없음 | 철학에 잘 맞는 후보. 작고 효과 크다 |

### Logseq DB에서 가져올 것과 버릴 것

- **버릴 것: 타입 속성·온톨로지·질의 언어.** Logseq DB의 간판 기능이지만 전부 "화면은 간결하게, 사용자는 신경 끄게"와 반대 방향이다. Workflowy가 이걸 전부 안 하고도 제품인 이유가 우리 철학의 근거다.
- **가져올 것: 태그를 본문 텍스트 밖에 렌더링하는 절충.** 의미는 부여하되 문법 소음은 없앤다. 현 tag-spec이 픽셀 불변 원칙 때문에 pill 렌더링을 보류한 결정과 공존 가능한 장기 참고안이다.
- **가져올 것: 정체성과 undo는 DB 계층에서.** undo를 파일 diff로 만들지 않는다(Logseq가 실명한 실패 지점). 우리 구조는 이미 이렇게 돼 있으니 유지한다.
- **기록해 둘 것: 파일 접근성은 이제 시장의 기본 기대치다.** Logseq 사용자 이탈 사유 1위가 "일반 텍스트 포기"였고 "LLM에게 노트 폴더를 보여 준다"가 표준 워크플로가 됐다. 파일 SSOT 완성은 기능이 아니라 포지셔닝이다.

## 6. 성능 기준선

경쟁 제품의 실측 약점이 목표선을 정해 준다. Workflowy는 Electron 데스크톱이 대형 계정에서 버벅이는 것이 가장 약한 고리고(5만+ 항목대 불만 다수), Logseq 파일판은 시작 시 전체 재파싱으로 무너졌다.

| 지표 | 현재 계약 (`crates/notes-sqlite/tests/performance.rs`) | 권고 목표 | 근거 |
|---|---|---|---|
| 부트스트랩 50k 노드 | < 2s | 유지 | Logseq 파일판은 2k 페이지에 4~10분. 증분 재색인이면 도달 가능한 수치 |
| 5k 뷰포트 p95 | < 100ms | 유지 + 대형 문서 심부 스크롤 추가 | 현 CTE는 창마다 전체를 걷기 때문에 문서 끝 스크롤이 취약하다(P1-6). 계약에 없는 사각지대 |
| 검색 (10만 노드) | 계약 없음 | < 100ms | Workflowy 데스크톱의 최약점. FTS5는 이미 있으므로 계약 테스트만 추가 |
| 키 입력 → 화면 반영 | 낙관적 반영으로 즉시 | 유지 | draft 오버레이 구조가 이미 보장. 회귀 감시만 |
| 시작 시 파일 재파싱 (SSOT 포팅 후) | — | 변경분만 | mtime/hash 증분. Logseq 붕괴 지점의 직접 교훈 |

성능 계약은 `--features bench-fixtures`로 옵트인이라 평시 `cargo test --workspace`가 건너뛴다. CI 전환(P0-2) 때 별도 잡으로 넣을지 결정한다.

## 7. 권고 로드맵

1. **게이트 복구.** 권한 목록 1줄(P0-1, 완료) → CI를 v2로(P0-2). 이후 모든 작업이 이 안전망 위에서 진행돼야 한다.
2. **v1 아카이브 결정** (P0-3). 태그 + 브랜치 보존 후 main에서 제거. 이 결정 하나로 저장소 부피의 8할이 사라진다.
3. **진행 중인 태그 작업 완주.** tag-spec의 자동완성 + 제자리 필터가 Workflowy 격차를 직접 메운다. 스펙 품질이 좋으니 그대로 진행한다.
4. **구조 수술 1라운드** (P1-4·5·6·7·8·9). 태그 작업과 SSOT 포팅 사이가 적기다.
5. **파일 SSOT 포팅 마일스톤.** `notes-sync` 크레이트로 v1 파이프라인 이식(§4 순서). 이 앱의 정체성이 걸린 항목이라 태그 이후 최우선 대형 작업으로 권고한다. 릴리즈 전은 마이그레이션 부담 없는 마지막 기회이기도 하다.
6. **감각 보강.** 검색 제자리 필터(조상 보존) → Cmd+K 점프 팔레트 → 전역 빠른 캡처. 셋 다 "감춰 놓되 필요할 때 등장" 철학의 직계 후손이다.
7. **보류 목록 유지.** 미러·보드·표·타입 속성은 SSOT 안착과 위 감각 보강이 끝날 때까지 착수하지 않는다.
