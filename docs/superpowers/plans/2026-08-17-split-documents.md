# 문서 분할 — "문서로 분리" 명령과 자동 승격 설계

2026-08-17 · Fable 5 설계 · 대상 브랜치 main

포맷은 이미 있다. §4.5의 split 줄과 golden C, `parse.rs`·`render.rs`의 `split` 토큰,
`merger.rs`의 `parent:` 병합과 `is_page = 0` 기록, `export.rs`의 서브트리 절단과
retiring 기계, seam 테스트 두 건까지 전부 있다. 없는 것은 **만드는 길**이다:

- `pending_documents`는 root의 직계 자식(페이지)만 문서로 세우고, 분할 문서 행은
  오늘 `parent:`를 이미 선언한 파일을 병합해야만 생긴다. `command.rs`에 명령이 없다.
- 스펙 §7이 약속한 "사용자가 실행하는 '문서로 분리' 명령"이 그래서 비어 있고,
  §7이 꺼 둔 자동 승격은 사용자가 켜 달라고 했다(계획 §8 결정 14).
- 덤으로 찾은 결함 하나: 분할 자식을 품은 페이지를 export하면 지금은 링크 줄이
  아니라 **평범한 bullet**이 나간다. golden C의 "부모 문서에 남는 줄"과 어긋난다.
  오늘은 분할 문서를 만들 길이 없어 발화하지 않지만 이 작업의 첫 전제다.

## 계약

| 필드 | 내용 |
| --- | --- |
| 목표 | 사용자가 노드 하나를 자기 문서로 내보내고 도로 합칠 수 있으며, 임계를 넘긴 문서는 export가 스스로 같은 일을 한다. 몇 기기가 동시에 하든 vault는 같은 바이트로 수렴한다 |
| 비대상 | 아래 별도 절 |
| 경계 | Rust(`notes-sync`, `notes-sqlite`, `notes-application`, `src-tauri`) · IPC(명령 3개 `notes_split_document`·`notes_join_document`·`notes_document_roots`, 새 이벤트·ts-rs 타입 없음) · SQLite(스키마 변경 없음 — `sync_documents`의 기존 컬럼만 쓴다) · React(`OutlineRowMenu`, `api.ts`) · 파일시스템(폴더 생성·삭제, 전송이 지운 파일의 stat) |
| 수동 확인 | ① 행 메뉴에서 "문서로 분리" → vault에 `<제목>-<id12>/README.md`가 생기고 부모 README에 §4.5 링크 줄이 남는다. ② 같은 메뉴 "문서로 합치기" → 폴더가 사라지고 내용이 부모 README에 돌아온다 |

### 완료 조건(acceptance)

| # | 관찰 가능한 통과 조건 | 항목 |
| --- | --- | --- |
| B1 | export가 쓴 파일의 mtime·크기가 `sync_documents`에 남는다(자동 합치기 가드의 입력) | 1 |
| A1 | 분할 자식이 있는 문서의 export가 golden C 형태의 split 링크 줄을 쓴다 | 2 |
| A2 | "문서로 분리"가 자식 문서 파일과 부모의 링크 줄을 만들고 그 두 파일을 도로 병합하면 no-op이다(불변 규칙 2) | 3 |
| A3 | 분리·합치기는 어떤 노드의 HLC도 전진시키지 않는다 — 가짜 충돌이 없다 | 3 |
| A4 | "문서로 합치기"가 서브트리를 부모 문서로 되들이고 폴더를 지운다. 안에 다른 문서를 품었으면 거부한다 | 4 |
| A5 | 다른 기기가 합쳐서 child 파일 삭제가 전송으로 도착하면 이 기기도 같은 문서를 합친다 | 5 |
| A6 | 행 메뉴가 노드 상태에 맞는 항목(분리/합치기)을 보이고 실행 결과가 vault에 나타난다 | 6 |
| A7 | 노드 2,000 또는 256KB를 넘긴 문서의 export가 subtree `max_hlc`가 가장 작은 직계 자식을 내보낸다 | 7 |
| A8 | 문서의 15% 미만(노드 수 기준) 자식은 승격 후보가 아니다 | 7 |
| A9 | 서로 다른 자식을 승격한 두 기기가 서로의 파일을 병합한 뒤 같은 분할 집합, 같은 vault 바이트로 수렴한다 | 7 |
| A10 | 96KB·800개 밑으로 내려온 문서는 가장 최근에 손댄 분할 자식을 합치되 합쳐서 승격 임계를 다시 넘길 조합이면 기다린다 | 8 |

### 비대상

- **Cmd+Z(undo 스택) 통합** — 분리는 `NotesCommand`가 아니다(아래 첫 절). 역연산은
  "문서로 합치기" 명령 자신이고 같은 메뉴에 있다.
- 아웃라인에 문서 표시 배지 — 메뉴 라벨("합치기"가 보이면 문서다)이 상태를 드러낸다.
- 분할 문서를 다른 페이지로 옮긴 뒤의 폴더 재배치 — "vault 이름 정리"의 몫(§3.1과
  같은 이유: 자동 rename은 동기화가 가장 못 다루는 연산). 링크는 위험 4처럼 합법으로 남는다.
- 중첩 문서를 품은 문서의 합치기 — 거부하고 이유를 답한다. 안쪽부터 합치면 된다.
- 자동 승격 on/off 설정 — 항상 켠다. 끌 이유였던 "되돌릴 수단 없음"을 항목 3·4가 없앤다.
- 오프라인 기기가 옛 child 파일을 되살려 합치기를 뒤집는 경우의 방지 — 분할로
  수렴하고(내용 무손실) 위험 2에 기록만 한다.
- `trash.md`의 크기 분할 — 휴지통은 문서 트리 밖이다.

## 왜 notes-core 명령이 아닌가 — undo 결정

과제는 "notes-core의 도메인 명령과 그 역(patch)"을 물었다. 답은 **아니다**이고 근거는
코드에 있다:

- 분리는 `notes_nodes`를 한 행도 바꾸지 않는다. 같은 트리, 같은 텍스트, 같은 HLC —
  바뀌는 것은 `sync_documents` 행 하나와 dirty 표시뿐이다. `NotesTree::plan`은
  전후 트리의 `diff`로 patch를 만드는데(`tree.rs:337`) 전후가 같으니 `forward`도
  `inverse`도 빈 목록이다. 빈 patch를 undo 스택에 쌓으면 Cmd+Z가 아무것도 안 하는
  항목을 하나 소비할 뿐이다. `NoteNode`에 문서 여부 필드를 더해 diff에 태우는 길은
  도메인이 한 번도 읽지 않는 상태를 트리 전체에 실어 나르는 것이라 버린다.
- 불변 규칙 B의 undo 배리어는 병합이 만진 **노드**와의 교차로 `undo_floor`를 올린다.
  경계 변화는 노드를 안 만지므로 배리어가 지킬 수 없고, 스택에 넣어도 원격 분할과
  교차 판정이 안 된다.
- 스펙 §9의 선례가 이미 있다: "첨부 위치는 노드 내용이 아니다. 승격·강등은 HLC를
  전진시키지 않고 가짜 충돌을 만들지 않는다." 문서 경계도 같은 부류다 — 내용이 아니라
  포장이다. A3이 이 계약의 기계 검사다.
- 분리를 되돌리는 유일하게 안전한 길은 retiring 기계다(§3.5의 "쓰고 나서 지운다").
  Cmd+Z가 동기적으로 폴더를 지울 수는 없다.

그래서 역연산은 별도 명령 "문서로 합치기"다. 수동 항목(1)에 두느냐 자동 항목(2)에
두느냐는 물을 것도 없이 **수동 쪽, 자동 승격보다 앞**이다 — 스펙 §7이 자동 승격을
꺼 둔 이유가 "앱이 정한 것을 사용자가 못 되돌린다"였으니 합치기가 서기 전에는
항목 7·8을 켤 근거가 없다.

## 설계 — 부모 문서가 링크 줄을 쓰게 한다 (항목 2)

`export.rs`의 `load_document`는 문서를 소유한 자식에서 하강을 멈추지만 그 자식
**자신의 줄**은 `NodeBody::Text`로 만든다. split 렌더는 `export_home`에만 있다.
고치는 곳은 둘이다:

- subtree 질의에 `LEFT JOIN sync_documents sd ON sd.root_id = n.id AND sd.retiring = 0`을
  더해 `sd.folder_path`를 싣는다.
- `build`에서 folder_path가 있고 문서 루트 자신이 아니면 `NodeBody::Split { title:
  text, path }`로 만든다. path는 `attachments::Placement::link_from`을 그대로 써서
  문서 폴더 기준 상대 경로로 만든다 — `Projects-x`에서 본
  `Projects-x/Deeper-y/README.md`는 `Deeper-y/README.md`가 되고, 다른 페이지 폴더에
  남은 문서면 `../`가 알아서 붙는다. 렌더러는 이미 split 줄에 상태 토큰을 안 쓰고
  `prev` 자리 주장을 §4.3 조건대로 싣는다(병합 설계 §7.5–7.6, 손댈 것 없음).

**§9(렌더 바이트 = 포맷 버전) 판정**: 이 변경은 같은 상태의 출력 바이트를 바꾼다 —
분할 자식이 있는 상태에 한해서다. 그 상태는 오늘 UI로 만들 수 없고(명령이 없다),
남의 vault를 병합해 만든 경우 지금 렌더러가 내는 바이트가 golden C **위반**이다.
릴리스 전이고 기기들이 같은 빌드이므로(§9 말미) 이것은 버전 승급이 아니라 명세
준수 수리다. golden 테스트에 C의 부모 줄 케이스를 이 항목이 추가해 이후로는 기계가 지킨다.

## 설계 — "문서로 분리" (항목 3)

`notes-sync/src/export.rs`에 `pub fn split_document(transaction, node_id) -> Result<(), ExportError>`.
notes-sync는 notes-sqlite를 모르는 채 `Transaction`만 받는 기존 결(`begin_retirement`와
같은 자리)이다. 하는 일 전부:

1. **자격 검사**: 노드가 있고, `deleted = 0`, 부모가 있고 `'root'`가 아니고(페이지는
   이미 문서다), `kind <> 'image'`(§4.4 — 헤딩에 이미지를 실을 자리가 없다),
   retiring 아닌 행이 아직 없다. retiring = 1인 행이 있으면(합치기가 아직 안 나간
   재분리) `retiring = 0`으로 되돌리고 folder_path를 그대로 둔 채 끝낸다 — 파일이
   아직 디스크에 있을 수 있으니 경로 재사용이 맞다.
2. **폴더 경로**: 조상을 올라가 문서를 소유한 가장 가까운 것(분할 문서 행 또는
   페이지)을 찾고, 그 문서 폴더 안에 `page_folder_name(제목, id)`(§3.1 그대로,
   id 접미사 덕에 결정적·유일)를 붙여 `.../README.md`를 만든다.
3. **행 삽입**: `sync_documents(root_id, folder_path, exported_hash = '',
   applied_max_hlc = '', is_page = 0, retiring = 0)`. 빈 해시는 "아직 아무 파일도
   안 썼다"이고 `recorded_hash`가 이미 빈 값을 None으로 거른다.
4. **dirty 두 건**: 노드 자신(climb이 자기 행에서 멈춰 자식 문서가 pending에 든다)과
   2에서 찾은 소유 문서 루트(부모 문서가 링크 줄로 다시 쓰인다). `begin_retirement`와
   달리 두 건인 이유: retiring 문서는 climb이 지나쳐 올라가지만 살아 있는 행은
   climb을 멈추기 때문이다.

그다음은 전부 기존 기계다. `export_pending` 한 트랜잭션 안에서 자식 문서가
`export_document`로 나가고(`document_path`가 기록된 경로를 쓰고, `load_document`가
`parent:`·`sort_key:`를 frontmatter에 싣는다) 부모 문서가 항목 2의 링크 줄을 쓴다.
HLC는 아무도 안 만진다 — `settle_readings`의 지문에 경계가 없으니 되돌릴 것도 없다(A3).

배선: `SqliteStorage`에 `split_document(id)`(worker `Request` 하나), notes-application
서비스 통과, Tauri 명령. 프런트는 명령 뒤 `notes_sync_flush`를 이어 불러 파일이
바로 나가게 한다.

**첨부는 확인만 하고 손대지 않는다.** `attachments.rs`의 `referenced_assets`는
climb을 **페이지까지**(`parent_id = 'root'`) 올린다 — 가장 가까운 문서가 아니다.
분리 전후로 참조 수도 소속 페이지도 변하지 않으니 `plan_placement`의 입력이 한 글자도
안 바뀌고 이동 0건이다. 자식 문서의 링크는 `link_from(문서 폴더)`가 `../assets/…`로
계산한다(§3.4의 "한 겹 깊은" 규칙 그대로). 항목 3의 테스트가 이동 0건을 함께 단언한다.

## 설계 — "문서로 합치기" (항목 4)

retiring 기계 재사용이 전부다: `join_document(transaction, node_id)`는

1. `is_page = 0`이고 retiring = 0인 행이 있는지 확인한다. 페이지는 거부 —
   페이지가 home으로 접히는 상태는 이 포맷에 없다(§3.2).
2. **중첩 거부**: 이 문서 폴더 아래에 다른 살아 있는 문서 행이 있으면 거부한다.
   `retire_missing_documents`는 남의 파일을 품은 폴더를 안 지우므로(inner_d 검사)
   허용하면 README만 디스크에 남고, 다른 기기가 그 파일을 계속 병합해 분할이 부활한다.
3. **캡 가드**: 부모 문서 노드 수 + 이 서브트리 노드 수가 20,000을 넘거나 file_size
   합이 16MiB에 닿으면 거부한다(불변 규칙 8 — 도메인에 있는데 파일로 못 나가는
   상태를 만들지 않는다).
4. `retiring = 1` + 노드 자신 dirty 한 건. 끝.

다음 export에서 `load_document`의 하강 조건(`retiring = 0`)이 이 문서를 지나치므로
부모 문서가 서브트리를 되들이고, `retire_missing_documents`가 이미 retiring 행을
페이지와 똑같이 처리해(폴더 삭제 → 행 삭제, 쓰고 나서 지운다) 마무리한다.
아직 export가 한 번도 안 나간 분할(빈 해시)을 합치면 지울 파일이 없을 뿐 같은 경로다 —
분리 직후의 "실수 취소"가 이 모양으로 성립한다.

## 설계 — 합치기의 전파: 반례가 규칙을 정했다 (항목 5)

**반례부터.** 합치기가 로컬에서만 일어나면 두 기기는 영원히 파일을 주고받는다:

1. A가 X를 합친다 — A의 부모 README는 인라인, X의 README는 삭제, A의 행은 없다.
2. B는 행을 그대로 들고 있다. B에서 아무 편집이 부모 문서를 dirty하게 만들면
   B는 split 링크 줄을 다시 쓴다.
3. B의 X README가 아직 살아 있으니 전송이 그것을 A에 준다. A가 병합하면
   `record_document`가 행을 **되만든다**. 합치기가 취소됐다.
4. 반대 순서면 A의 인라인 부모와 B의 링크 부모가 서로를 "남의 편집"으로 보고
   병합→재방출을 주고받는다. 같은 상태·다른 바이트 — 불변 규칙 3의 기기 간 위반이다.

근본 원인: 포맷 v1에는 "합쳤다@stamp"를 실을 자리가 없다. 인라인 줄의 `t:`는 내용
스탬프라 경계 주장을 싣지 못하고(내용만 고친 기기의 인라인 렌더와 구분 불가),
새 토큰을 파면 새 문법이다. **전송이 이미 나르는 삭제 신호가 딱 하나 있다 —
child 파일 자신의 삭제다.** 그래서 규칙은:

> **기록에 있던(`exported_hash <> ''`) `is_page = 0` 문서의 README가 디스크에서
> 사라지면(NotFound에 한한다) 그 문서를 합친다** — `retiring = 1` + dirty, 이후는
> 항목 4와 같은 길.

`export_pending`이 `begin_retirement` 앞에서 `retire_vanished_documents(transaction,
vault_root)`로 검사한다. 분할 문서는 적으니 행당 stat 한 번이면 되고 watch 이벤트에
기대지 않아 앱이 꺼진 사이의 삭제도 잡는다. 안전 논증:

- **불변 규칙 1과 충돌하지 않는다.** "파일에 없는 노드는 지우지 않는다"는 노드
  얘기다. 이 규칙은 노드를 하나도 지우지 않는다 — 포장만 바꾸고 서브트리는 다음
  방출에서 부모 파일에 전부 실린다. 잃는 내용이 0바이트라서 오판(전송 글리치, 손삭제)의
  비용도 "잠깐 합쳐짐"이 전부다. 파일이 돌아오면 병합이 행을 되만들어 분할로 복귀한다 —
  이를 위해 merger `record_document`의 upsert에 `retiring = 0`을 더한다(페이지 쪽은
  `begin_retirement`가 다음 패스에 되마킹하므로 무해하다).
- 갓 만든 분할(빈 해시, 파일이 아직 없음)은 조건이 걸러 준다.
- 스펙 §6 표의 "파일을 지움 → 다음 방출이 다시 쓴다" 행이 좁아진다: 분할 문서
  README에 한해 "지움 = 합치겠다는 뜻"이 된다. 손편집 관점에서도 자연스럽다 —
  에디터에서 그 파일을 지운 사용자에게 내용은 부모로 돌아온다. 이 항목이 스펙
  §6 표를 함께 고친다.

폴더 이름 변경(§6: 이름은 꾸밈)은 삭제+생성으로 보이므로 삭제가 먼저 처리되면
합쳤다가 새 경로의 병합이 행을 되만든다 — 한 패스짜리 소음이고 수렴은 그대로다.

## 설계 — 자동 승격과 자동 합치기 (항목 7·8)

수동 명령이 서 있으니 스펙 §7의 규칙을 켠다. 상수는 notes-sync에 둔다:
`SPLIT_BYTES = 262_144`, `SPLIT_NODES = 2_000`, `JOIN_BYTES = 98_304`,
`JOIN_NODES = 800`, `CANDIDATE_FLOOR_PERCENT = 15`.

**언제 도는가 — export 트랜잭션 안이다.** `write_checked`가 어차피 바이트를 손에
쥐므로 `ExportOutcome`에 `bytes_len`·`node_count`를 더하고, `export_pending`이
문서 하나를 성공적으로 쓴 직후(home·trash 제외, `needs_merge`면 건너뜀 — 디스크에
남의 편집이 있는 문서를 놓고 결정하지 않는다) 판정한다. 병합과 싸우지 않는 이유가
이 자리에 있다: 병합도 export도 같은 워커 큐의 트랜잭션이라 교차 실행이 없고,
결정의 입력은 전부 커밋된 로컬 상태다.

**승격(문서가 `SPLIT_BYTES` 초과 또는 `SPLIT_NODES` 초과)**: 직계 자식 중 문서 행이
없고 `kind <> 'image'`이고 서브트리 노드 수가 문서의 15% 이상인 것들에서 서브트리
`max_hlc`가 가장 작은 것(동률이면 id 오름차순 — 동률 규칙이 없으면 기기마다 답이
갈린다)을 골라 항목 3의 `split_document`를 부른다. 문서당 한 번, 한 단계만(§7). 15%를 노드 수로
재는 것은 해석이다 — 스펙이 단위를 안 정했고, 자식별 렌더 바이트는 한 번 더 렌더해야
나오지만 노드 수는 질의 하나다. 바이트로 튄 문서에서 노드 기준 후보가 작게 잘리면
임계가 그대로 남아 다음 패스가 다음 자식을 내보낸다. 여러 패스에 걸친 수렴이지
진동이 아니다(위험 3).

**합치기(문서가 `JOIN_BYTES` 미만이고 `JOIN_NODES` 미만)**: `is_page = 0`이고
retiring = 0이고 해시가 빈 값이 아닌 직계 자식 문서 중 서브트리 `max_hlc`가 가장
큰 것(동률 id 오름차순)을 고르되, **진동 가드**: 부모 바이트 + 자식 `file_size`가
`SPLIT_BYTES`를 넘거나 노드 합이 `SPLIT_NODES`를 넘으면 합치지 않는다. 가드가 없으면
"합치자마자 다시 넘어서 승격"이 돈다. 가드가 있으면 합친 결과는 [96KB, 256KB) 띠 안에
떨어지고 그 띠에서는 어느 쪽 조건도 안 켜진다 — 이력 띠(hysteresis)가 진동을 막는
첫 장치다. 두 번째 장치는 스펙의 비대칭 선택(내보낼 땐 가장 오래된 것, 들일 땐 가장
새것)이다: 합쳐 들인 자식은 정의상 가장 최근 것이라 이후 실제 성장으로 다시 임계를
넘어도 승격은 **다른** 자식을 고른다. 자식 `file_size`는 항목 1이 기록한다.

**같은 패스에 마무리**: 승격·합치기는 dirty만 남기므로 `export_pending`이 문서 루프와
`retire_missing_documents` 뒤에 `pending_documents`를 다시 묻고 남았으면 같은
트랜잭션에서 한 바퀴 더 돈다(최대 4바퀴 — 넘긴 자식이 자기도 임계를 넘는 연쇄만큼만
돌고, 남는 dirty는 다음 flush가 이어받으니 바퀴 상한은 안전하다). 이렇게 해야 부모의
링크 줄과 자식 파일이 한 커밋으로 디스크에 나가고, 링크가 없는 파일이나 파일 없는
링크가 로컬에서조차 안 생긴다(다른 기기에는 §4.5의 "아직 못 받음"이 어차피 있다).

### 가장 어려운 경우 — 두 기기가 서로 다른 자식을 승격하면

수렴한다. 분할 주장의 증거는 **더해지기만 하기** 때문이다:

1. A가 X를, B가 Y를 승격한다(로컬 상태가 달라야만 결정이 갈린다 — 같은 상태면
   같은 규칙이 같은 자식을 고르고 §3.1의 이름 규칙 덕에 폴더 경로와 파일 바이트까지
   같아서 전송 충돌 자체가 없다).
2. 서로의 자식 문서가 도착한다. `merge_page`가 `parent:`를 보고 `record_document`가
   행을 만든다 — A도 Y를, B도 X를 문서로 안다. 부모 파일의 병합은 어느 방향이든
   노드 no-op이다(split 줄은 존재·위치만 주장하고 상태는 자식 frontmatter가 권위,
   §4.5).
3. 다음 export에서 두 기기 다 X·Y 둘 다 링크 줄로 렌더한다. 같은 상태 → 같은
   바이트(불변 규칙 3). 고정점은 **승격의 합집합**이다.
4. 합집합이 부모를 `JOIN_BYTES` 밑으로 끌어내리면 자동 합치기가 켜지는데 그 결정은
   동기화된 같은 상태에서 도는 같은 순수 함수라 모든 기기가 **같은 자식**을 고른다.
   합치기의 전파는 항목 5가 못 받은 기기까지 마저 데려간다.

멱등·교환(불변 규칙 2)은 split 줄과 자식 문서가 어느 순서로 와도 성립한다: 줄은
행을 만들지 않고(존재 증거는 자식 파일뿐이다. 줄에서 행을 만들면 합치기 반례 3번이
유령 행으로 되살아난다) 자식 문서는 몇 번을 와도 같은 upsert다. 항목 7의 2-기기
테스트가 이 절 전체의 기계 검사다.

## 위험 — 선택된 모양의 함정을 그대로 적는다

1. **합치기 신호가 파일 삭제라서** 전송 글리치(삭제 후 재생성)가 일시 합치기를
   만든다. 파일이 돌아오면 분할로 복귀하고 내용 손실은 0이다 — 오판 비용이 포장
   왕복뿐이라 이 신호를 골랐다.
2. **오프라인 기기의 부활**: 합치기의 삭제 신호를 영영 못 받은 기기(백업 복원,
   반쪽 복사)가 옛 child README를 들고 돌아오면 병합이 행을 되만들어 전체가 분할로
   수렴한다. 방향이 결정적이고 무손실이라 받아들인다. §6의 손편집 철학과도 같다 —
   파일을 들고 온 것이 곧 주장이다.
3. **15%의 노드 수 해석**: 바이트로 임계를 넘긴 문서에서 승격 한 번이 바이트를 충분히
   못 덜 수 있다. 다음 패스가 다음으로 오래된 자식을 내보내며 계단식으로 내려간다.
   패스당 한 단계라는 §7의 규칙이 상한이다.
4. **분할 문서 루트를 다른 페이지로 옮기면** 폴더는 옛 페이지 폴더에 남는다. 링크는
   `link_from`이 `../`로 이어 주고 첨부는 소속 페이지의 `assets/`를 가리키므로 §3.4
   해석으로 합법이다. 보기 싫은 배치는 "vault 이름 정리"의 몫으로 미룬다(비대상).
5. **합친 결과 크기 추정(부모 바이트 + 자식 file_size)은 과소평가일 수 있다** —
   되들인 줄들의 들여쓰기가 깊어져 바이트가 는다. 넘치면 다음 export가 가장 오래된
   자식을 내보내 자가 수정하고, 그 자식은 방금 들인 자식(가장 새것)이 아니다.
6. **부모 문서가 격리·미병합 상태면** 분리·승격의 링크 줄 방출이 미뤄진다. dirty가
   남아 있으므로 잃지 않고, 자식 문서만 먼저 나간 상태는 §4.5가 이미 합법으로 정의한다.

## 작업 항목 (순서 고정, 항목당 커밋 1개)

각 항목은 먼저 빨간 테스트를 적고 그 출력을 기록한 뒤 구현한다. 새 API가 없어
컴파일부터 실패하는 테스트는 그 오류가 red 증거다.

**1. export가 쓴 파일의 stat을 기록한다**
`2026-08-17-sync-boot-scan-and-status.md` 항목 1과 **같은 변경**이다(그 계획이 먼저
랜딩했으면 건너뛴다). `export.rs` `record_document`가 mtime·크기를 받고
`write_checked`의 두 호출부가 stat을 떠서 넘긴다. 실패 테스트:
`crates/notes-sqlite/tests/sync_cost.rs` `the_export_records_the_stat_of_what_it_wrote`
— export 후 `file_mtime_ms`·`file_size`가 실제 파일과 같다. red: 지금은 둘 다 NULL.

**2. 분할 자식이 링크 줄로 나간다**
`export.rs` `load_document` — sync_documents JOIN, `build`에서 `NodeBody::Split`,
경로는 `Placement::link_from` 재사용. 실패 테스트:
`crates/notes-sqlite/tests/sync_merge_seam.rs`
`a_page_renders_its_split_child_as_a_link_line` — seam의 기존 fixture처럼 행을 심고
export한 부모 README에 golden C의 `- [제목](폴더/README.md) <!-- yid: … t: … split -->`
줄이 있다. red: 지금은 평범한 bullet 줄이 나간다. golden 테스트에 같은 케이스 추가.

**3. `split_document` — 분리의 전부**
`export.rs`에 `split_document`(자격 검사·경로·행·dirty 2건), `notes-sqlite` 워커
`Request::SplitDocument` + `SqliteStorage::split_document`. 실패 테스트: seam
`splitting_a_node_gives_it_its_own_document` — 분리 후 `export_pending` 한 번에
자식 README(frontmatter `parent:`·`sort_key:`)와 부모의 링크 줄이 같이 생긴다.
그 두 파일을 도로 병합하면 변경 0건이고 분리 전후 전 노드의 hlc가 같고 첨부 이동이
0건이다. red: API가 없어 컴파일 실패.

**4. `join_document` — retiring 재사용**
`export.rs`에 `join_document`(is_page = 0 확인, 중첩 거부, 캡 가드, retiring = 1 +
dirty), 워커 배선. 실패 테스트 둘: seam `joining_a_split_document_folds_it_back_into_its_page` —
합치기 후 export에서 부모 README가 서브트리를 되들이고 폴더·행이 사라진다;
`a_document_holding_another_document_refuses_to_join` — 중첩 시 Err이고 행이 그대로다.
red: API가 없어 컴파일 실패.

**5. 전송이 지운 child 파일이 합치기를 전파한다**
`export.rs` `retire_vanished_documents`(NotFound에 한함, 빈 해시 제외),
`export_pending`이 `begin_retirement` 앞에서 호출, merger `record_document` upsert에
`retiring = 0` 추가, 스펙 §6 표의 "파일을 지움" 행 개정. 실패 테스트: seam
`a_split_file_deleted_by_the_transport_joins_here_too` — 분리·export 후 자식 README를
지우고 `export_pending`을 다시 돌리면 행이 사라지고 부모가 인라인으로 돌아온다.
red: 항목 2 이후 행이 살아남아 링크 줄이 계속 나간다.

**6. IPC 명령 셋 + 행 메뉴**
`notes_split_document`·`notes_join_document`·`notes_document_roots`(분할 문서 루트
id 목록 — is_page = 0, retiring = 0). 명령 리플 4곳(`generate_handler!`,
`checkV2Architecture.mjs`의 `expectedCommands`, `permissions/main-window.toml`,
`build.rs`). 새 ts-rs 타입 없음(문자열과 문자열 배열뿐). `api.ts`에 세 함수(분리·
합치기는 `notes_sync_flush`를 이어 부른다), `OutlineRowMenu`에 항목 — 문서 루트면
"문서로 합치기", 아니면 "문서로 분리", 목록은 mount와 `notes://sync-changed`와 실행
직후에 재조회. 실패 테스트: `OutlineRowMenu.test.tsx`
`offers_split_or_join_by_document_state` — red: api 함수가 없어 import 실패. 보조:
아키텍처 게이트가 명령 누락을 잡는다.

**7. 자동 승격**
`ExportOutcome`에 `bytes_len`·`node_count`, `export_pending`의 판정 지점과 재순회
루프(최대 4바퀴), 후보 질의(min max_hlc, tie id, 15% 노드 수, image 제외).
실패 테스트 셋: seam `a_document_past_the_node_cap_sheds_its_least_recently_touched_child`
— 직계 자식 셋(서로 다른 subtree max_hlc)에 노드 2,001개를 심고 export하면 max_hlc가
가장 작은 자식의 폴더가 생기고 부모에 링크 줄이 남는다. red: 아무 일도 안 일어난다.
`a_child_under_fifteen_percent_is_not_a_candidate` — 15% 미만 자식만 있으면 분할이
없다. red: 후보 로직이 아예 없어 첫 테스트와 같은 시점에 함께 기록한다.
`two_devices_promoting_different_children_converge` —
저장소 두 개가 서로 다른 자식을 승격하고 파일을 교환·병합한 뒤 각자 export하면 두
vault의 md 바이트가 전부 같다. red: 승격이 없어 분할 자체가 안 생긴다.

**8. 자동 합치기와 진동 가드**
합치기 판정(max max_hlc, 가드: 바이트·노드 합이 승격 임계 미만), 스펙 §7의 "자동
승격은 켜지 않고" 문장 개정. 실패 테스트 둘: seam
`a_shrunken_document_takes_its_most_recently_touched_child_back` — 임계 밑 부모와
분할 자식 둘을 두고 export하면 max_hlc가 큰 쪽만 합쳐진다. red: 합치기가 안 돈다.
`a_join_that_would_recross_the_split_threshold_waits` — 합치면 2,000을 넘는 조합은
그대로 남는다. red: 합치기 판정을 먼저 넣은 시점에는 가드가 없어 합쳐져 버린다.

## 게이트 (diff 확정 후 1회)

```
cargo test --workspace
cargo fmt --all -- --check
npm run test:v2:frontend
npm run lint:v2
npm run test:v2:architecture
npm run test:v2:contracts
git diff --check
```

Rust·IPC·프런트가 모두 바뀌므로 양쪽 게이트를 다 돌린다. 스키마는 안 바뀌어
마이그레이션 이슈가 없고, Clippy는 이번 경계에 새 baseline 요구가 없어 비교하지
않는다. 수동 확인 두 줄(계약 표)은 fresh 빌드에서 한다.
