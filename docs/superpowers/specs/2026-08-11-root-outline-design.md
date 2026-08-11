# 루트 아웃라인: 홈(All)을 진짜 아웃라인으로 (2026-08-11)

## 배경과 개념

사용자 요구: 홈(All)도 다른 서브 블릿 페이지와 **동일한 블릿 페이지**여야 한다. "페이지"는 최상위 블릿을 편의상 따로 보여주는 개념일 뿐이다(Workflowy와 동일). 현재 HomeOutline은 읽기 전용 목록으로, 편집·생성·이동·펼침이 없다.

Workflowy 실물 확인(2026-08-11, 사용자 계정): 홈 = parent 없는 루트 줌. 최상위 블릿과 그 하위 트리가 인라인으로 펼쳐지고, 모든 계층에서 동일한 편집·접기·드래그·줌이 동작한다. 사이드바는 같은 트리의 내비게이션 투영이다. 홈에는 큰 제목이 없다.

## 아키텍처 결정: 실제 루트 행 도입 (가상 루트 아님)

백엔드 조사 결과(요약): 페이지는 이미 `notes_nodes`의 행이다 — `kind='page' AND parent_id IS NULL`(schema CHECK, schema.rs:64-67). viewport CTE는 `id=?1 AND kind='page'`로 시드(queries.rs:112). moveNode의 parentId는 non-null이라 "루트로 이동"을 표현할 wire가 없고, kind 전환 커맨드도 없다.

**결정: id 고정 `"root"`, `kind='page'`, parent NULL인 루트 행 하나를 도입하고, 기존 페이지 행들을 전부 루트의 자식 `bullet`로 전환한다.** 이후 "페이지" = 루트의 자식 노드일 뿐이다.

이 선택이 대안(루트 포레스트 전용 쿼리 + nullable parentId + kind 전환 커맨드)을 이기는 이유:

| 필요 기능 | 실제 루트 행 | 가상 루트 |
| --- | --- | --- |
| 홈 viewport | `openPage("root")` — 기존 SQL 그대로 (루트가 kind='page'라 시드에 걸림) | 새 쿼리 |
| 루트로 이동(승격) | `moveNode(parent:"root")` — 이미 합법 | wire 타입 변경 + kind 전환 |
| 페이지 강등(다른 블릿 밑으로) | 일반 이동 — 페이지가 bullet이므로 | `CannotMovePage` 해제 + kind 전환 |
| 위치 지정 페이지 생성(Enter) | `createNode(parent:"root", before)` — 이미 존재 | createPage 확장 |
| depth-1 split/merge/removeEmpty | bullet이므로 기존 코드 | Page 가드 전부 해제 |
| 홈 selection 포레스트(queryForest) | roots가 bullet이라 기존 코드 | 페이지 루트 허용 개조 |
| 전체 포레스트 export | 루트 export = 전체 (export CTE에 kind 필터 없음) | 별도 작업 |
| SQL CHECK | **변경 불필요** — 루트=(page, NULL), 나머지=(bullet/image, NOT NULL)로 기존 CHECK를 그대로 만족 | CHECK 재작성(테이블 리빌드) |
| 도메인 Page 가드들(CannotMove/Split/Remove/Duplicate) | **그대로 두면 루트 보호 가드가 됨** | 전부 해제·재작성 |

기존 dev DB도 CHECK 변경이 없어 테이블 리빌드 없이 UPDATE로 전환된다.

## 계약

| 항목 | 내용 |
| --- | --- |
| 목표 | 홈(All)이 페이지와 동일한 NotesOutline 표면이 된다: 편집·Enter 생성·indent/outdent·드래그·접기·줌·노트·이미지·다중선택 전부 동작 |
| 비대상 | 페이지 뷰에서의 크로스 페이지 Move To 확장(후속), Starred/Tags/Trash 검색 뷰, 마크다운 SSOT, 레거시 `src-tauri/src/notes`(v1) |
| 경계 | Rust(notes-sqlite·notes-core·notes-application) + IPC 계약 재생성 + React 프론트엔드 |
| 데이터 | 스키마 v1 유지(CHECK 불변). `ensure_root` 초기화: 루트 행 생성 + 레거시 페이지 행을 루트 자식 bullet로 채택(멱등, 비파괴, 버전 플래그 없음 — 신규 DB 초기화 코드와 동일 경로). 마이그레이션·버전·호환 리더 금지 원칙 준수 |
| 수동 증명 | 브라우저 프리뷰: 홈에서 타이핑·Enter로 최상위 블릿 생성 → 사이드바 Pages에 즉시 반영 → indent로 다른 블릿 밑에 넣기(페이지 목록에서 사라짐) → outdent로 승격(목록에 나타남) → 접기/펼치기 → 줌 → breadcrumb 복귀 → undo 왕복 |

## 완료 조건 (acceptance)

1. 신규 DB: 루트 행(id `root`, kind `page`) 자동 생성. 레거시 DB: 기존 페이지 행들이 루트의 자식 bullet로 전환(멱등; sort_key·deleted 보존; 두 번 실행해도 동일).
2. `openPage("root")`가 전체 포레스트 viewport를 반환(페이지네이션 동작 포함). 일반 노드 id로도 viewport가 열린다(시드의 kind 제한 제거).
3. bootstrap의 `pages` = 루트의 살아있는 자식 목록(sort_key 순, `sortKey` 포함). `activePageId` 기본값·검증에 `root` 포함.
4. 검색 히트의 owning page가 루트가 아닌 depth-1 조상으로 나온다.
5. 홈이 NotesOutline으로 렌더된다: HomeOutline 삭제. 루트에서는 페이지 제목 헤딩이 없다(Workflowy 홈과 동일). breadcrumb은 `⌂`(현재)만.
6. 홈에서: 최상위 블릿 제목 인라인 편집, Enter로 형제 생성(위치 지정), indent/outdent, 드래그, 접기(영속), 완료 토글, 노트, 다중선택이 페이지 뷰와 동일하게 동작.
7. 홈에서 indent로 다른 블릿 아래로 들어간 노드는 사이드바 Pages에서 사라지고, outdent·드래그로 depth-1이 된 노드는 나타난다(수동 새로고침 없이, receipt 반영).
8. New page 버튼 = 루트 끝에 자식 생성 후 열기(기존 UX 유지). IPC `createPage`는 제거되고 `createNode(parent:"root")`로 대체.
9. 페이지를 보다가 그 페이지를 삭제하면 홈으로 이동(기존: pages[0] 강제 열기).
10. 홈↔페이지↔줌 내비게이션이 undo/redo에 기록·복원(홈 인코딩 = pageId `"root"`; null 인코딩 제거).
11. 게이트: `cargo test --workspace`, `npm run test:v2:frontend`, `npm run lint:v2`, `npm run v2:build`, `npm run test:v2:contracts`, `git diff --check` 전부 통과. cargo fmt 준수.

## 항목별 설계 (커밋 순서)

### R1 `feat(notes-sqlite)`: ensure_root 초기화 + 레거시 채택

- 위치: notes-sqlite의 스키마 생성/오픈 경로(`create_schema` 직후 같은 커넥션 초기화 지점).
- 로직(트랜잭션):
  1. `SELECT 1 FROM notes_nodes WHERE id='root'` 없으면 `INSERT (id='root', parent_id=NULL, kind='page', text='Home', note='', marker='bullet', sort_key=0, collapsed=0, completed=0, starred=0, deleted=0)`.
  2. `UPDATE notes_nodes SET parent_id='root', kind='bullet', collapsed=1 WHERE parent_id IS NULL AND id<>'root'` — deleted 행 포함(휴지통 일관성), sort_key 보존(루트 자식 순서 유지). collapsed=1로 채택해 홈 초기 화면을 접힌 상태로.
  3. 사용자 노드 id가 `root`와 충돌할 가능성: nanoid 계열 생성 id라 실충돌 없음 — 단 1에서 기존 `root` 행이 kind='page'가 아니면 오류로 중단(방어).
- FTS 트리거: UPDATE가 트리거를 태우는지 확인, 태우면 그대로(본문 불변이라 무해).
- TDD: (a) 빈 DB → 루트 존재; (b) 페이지 2개+휴지통 페이지 1개 있는 DB → 전부 루트 자식 bullet·순서/삭제 플래그 보존; (c) 두 번 실행 멱등; (d) 기존 스키마 테스트 회귀 없음.

### R2 `feat(notes-app)`: 쿼리·계약 루트 인식 + createPage 제거

- queries.rs viewport 시드: `AND kind='page'` 제거(`WHERE id=?1 AND deleted=0`) — 어떤 노드든 서브트리 viewport 가능.
- queries.rs bootstrap: `pages` = `WHERE parent_id='root' AND deleted=0 ORDER BY sort_key, id`(kind 무관 — image도 목록에 옴). `PageSummary`에 `sortKey: number` 추가. `active_page_id` 검증: `'root'`이거나 pages에 있으면 유지, 아니면 `'root'`(홈 기본).
- 검색 owning-page(queries.rs:242-250): parent NULL까지 걷던 것을 **parent가 `root`인 조상에서 멈춤**. 루트 직속 히트는 자기 자신이 owning page.
- `createPage` 커맨드 제거: IpcNotesCommand·command_conversion·command_execution·tree.rs의 createPage 경로와 `next_root_sort_key` 삭제(다른 사용처 없음 확인 후). 프론트는 F1에서 createNode로 전환 — R2와 F1은 같이 게이트 통과해야 하므로 **R2 커밋에 프론트 api.ts·notesStore의 createPage 호출 전환을 포함**(커밋 경계는 "계약 변경 단위").
- ts-rs 계약 재생성(`npm run test:v2:contracts`가 쓰는 절차 확인 후 그대로) — PageSummary·IpcNotesCommand 갱신.
- TDD(Rust): openPage("root") 포레스트 반환; 일반 bullet id viewport; 검색 owning page depth-1; bootstrap pages 순서·sortKey. (TS) contracts 체크 통과.

### F1 `feat(desktop)`: 스토어 루트 인식

- `ROOT_ID = "root"` 상수(storeSupport 근처).
- storeState: outline 노드 필터 — 루트 행만 제외(kind==='page' 필터가 자연히 그 역할; 유지). `pages` 유지보수: receipt의 changedNodes 중 `parentId===ROOT_ID`(또는 루트 자식에서 벗어난 기존 항목)로 upsert/제거하고 **sortKey로 재정렬**(PageSummary.sortKey 사용). 루트 자식이 아니게 된 노드는 목록에서 제거.
- `orderOutline(nodes, 'root')` 홈 경로 확인(루트 자식들의 parentId==='root'라 기존 로직 그대로).
- notesStore.createPage → `createNode(ROOT_ID)` + openPage(신규 id). deleteSubtree의 페이지 특수 경로: 현재 보던 페이지 삭제 시 `openPage(ROOT_ID)`.
- TDD: receipt로 루트 자식 추가/이탈/재정렬 시 pages 반영; createPage가 createNode 커맨드를 보냄; 삭제 후 홈 이동.

### F2 `feat(desktop)`: 홈 = NotesOutline

- App: `homeOpen` state 삭제. 홈 = `activePageId === ROOT_ID`. `openHome()` = `openPage(ROOT_ID)`. 내비게이션 인코딩: pageId `"root"`(null 인코딩 제거 — applyNavigation·captureNavigation·emptyPaneLocation 호출부 정리).
- HomeOutline.tsx 삭제. NotesDetailPanes 항상 렌더. `page` prop: 루트일 때 `{id:'root', title:''}`.
- NotesOutline/OutlinePageHeading: `page.id === ROOT_ID`면 헤딩(제목 행) 렌더 생략. NotesChildComposer는 유지(루트 자식 = 새 페이지 추가 수단).
- OutlineHeader breadcrumb: 루트일 때 `⌂`만(현재·비활성). 페이지일 때 기존 `⌂ › 제목`. `onHome`은 `openPage(ROOT_ID)`.
- 사이드바: LibraryPageRow active = `page.id === activePageId && activePageId !== ROOT_ID`; All active = `activePageId === ROOT_ID`. 상호 배타 유지. kind==='image'인 루트 자식은 제목 폴백 "(image)".
- 페이지 헤딩 Enter/Backspace(handlePageKeyDown)의 루트 부재 경로 확인.
- TDD: 기존 홈 테스트들을 새 구조로 갱신 — All 클릭 → NotesOutline(헤딩 없음, 루트 자식 행); 행 제목 인라인 편집이 사이드바에 반영; Enter로 형제 생성; indent 후 사이드바에서 사라짐; undo 왕복; breadcrumb ⌂.

### F3 `fix(desktop)`: 마무리 정리

- F2까지 하고 남는 죽은 코드 제거(HomeOutline 스타일, null-홈 인코딩 잔재, LibraryViewButtons null 처리 재검토).
- 홈에서 줌: 최상위 블릿 줌 = zoomRootId(페이지 열기와 별개) — breadcrumb 체인이 루트에서 끝나는지 확인. 사이드바 페이지 클릭 = openPage(그 노드) 유지(성능: 서브트리 단위 viewport).
- 스모크 후 발견 항목 처리.

## 실행 체제

Fable 5 xHigh: 조사·요구사항·설계·TDD 설계·항목별 적대 리뷰·재작업 지시(이 문서). Opus 5 xHigh 단일 에이전트가 R1→R2→F1→F2→F3 순차 구현(공유 파일 다수), 항목당 1커밋, 항목마다 red 증거 → 구현 → green. 게이트는 최종 diff 동결 후 1회(계약 변경이 있으므로 Rust·프론트·contracts 전부). 마지막에 브라우저 프리뷰 스모크는 Fable이 직접.

## 위험과 완화

- **사용자 dev DB 실데이터**: ensure_root는 INSERT+UPDATE만(비파괴·멱등). 실행 전 DB 파일 백업 1회(cp)를 스모크 절차에 포함.
- **계약 재생성 파급**: PageSummary.sortKey 추가는 additive; createPage 제거는 프론트 전환과 같은 커밋으로 원자화.
- **viewport 시드 완화**: 임의 노드 viewport가 열리므로 `active_page_id`에 비루트 심층 노드가 저장될 수 있음 — openPage 호출부가 루트/depth-1로 제한되어 실경로 없음. bootstrap 검증이 걸러줌.
- **undo로 부활하는 페이지**: receipt 경로가 pages를 재구성하므로 F1 로직이 처리. 테스트에 포함.
