# Monaco 권위형 아웃라이너 실험 보고서

이 문서는 `codex/monaco-outline-spike` 브랜치에서 진행한 전체 블릿
페이지 Monaco 전환 결과를 기록한다. 비교 기준은 React 아웃라이너를
사용한 `codex/yonalist-v2-core@c693979`이다.

## 결론

텍스트 전용 페이지에서는 Monaco 모델을 편집 세션의 단일 권위로
사용하도록 전환했다. 한 블릿마다 에디터를 만들지 않으며, 한 페이지에
하나의 canonical `ITextModel`을 만들고 분할 뷰의 두 에디터가 이를
공유한다.

이 구조는 다음 문제를 제거한다.

- React store 갱신 뒤 Monaco 전체 텍스트를 다시 투영하지 않는다.
- Enter, Backspace, Delete, 좌우·상하 커서 이동, 같은 줄 편집과
  Undo/Redo는 Monaco의 기본 편집 경로를 사용한다.
- 블릿 문자는 모델 텍스트가 아니라 injected decoration이므로 검색,
  선택, 복사 결과에 섞이지 않는다.
- 모델 변경을 안정적인 node ID 메타데이터와 저장 명령으로 변환하고,
  SQLite에는 300ms coalescing 또는 구조 변경 직후 원자적으로 저장한다.
- 두 분할 뷰는 같은 모델을 공유하지만 줌, 접힘, 완료 항목 표시와
  scroll/view state는 pane-local로 유지한다.

이미지, 첨부 메모 등 Monaco 텍스트 모델로 안전하게 표현할 수 없는
페이지는 기존 React 아웃라이너로 명시적으로 fallback한다. 서로 다른
두 편집 권위가 같은 페이지를 동시에 수정하는 구조는 허용하지 않는다.

## 구현 구조

| 계층 | 책임 |
|---|---|
| `MonacoOutlineSession` | canonical 모델, node 메타데이터, 저장 큐, native Undo/Redo |
| `OutlineMetadataTimeline` | 모델 버전별 line↔node ID, depth, 상태 복원 |
| structural change interpreter | Monaco edit를 생성·텍스트 수정·삭제·이동 명령으로 변환 |
| persistence queue | 텍스트 coalescing, 구조 즉시 저장, 동일 request ID 재시도 |
| editor contribution | Tab/Shift+Tab과 구조 경계만 확장하고 나머지는 Monaco 기본 동작 유지 |
| pane adapter | 분할 뷰별 hidden area, 줌, 완료/접힘 표시, view state |
| session registry | 페이지당 한 모델, 참조 수명, 마지막 pane 종료 시 flush |

구형 projection/controller/reconciliation/caret/keyboard 계층은 삭제했다.
React 컴포넌트는 세션을 임대하고 Monaco editor 및 pane adapter 수명만
관리한다.

## 동작 검증

자동 테스트는 다음을 확인한다.

- 글자 중간 Enter가 앞/뒤 텍스트를 정확히 분리하고 새 node ID를 만든다.
- Enter 20회 후 Backspace 20회를 연속 적용해도 줄과 메타데이터가
  한 줄로 정확히 돌아온다.
- 연속 한글 텍스트 입력은 300ms 뒤 한 저장 명령으로 합쳐진다.
- 블릿 decoration은 모델 검색 및 복사 텍스트에 포함되지 않는다.
- Tab/Shift+Tab 메타데이터 변경도 Monaco native Undo/Redo로 복원된다.
- 분할 뷰는 같은 모델 URI를 공유하며 한 pane의 편집과 Undo가 같은
  turn에 다른 pane에 반영된다.
- 블릿 클릭은 같은 pane의 서브 페이지로 이동하고 Shift+클릭은
  secondary pane을 연다.
- 서브 페이지 제목으로 표시한 root 블릿은 본문에서 다시 중복 표시하지
  않는다.
- 줌된 제목도 React draft가 아니라 같은 canonical Monaco model을
  수정하므로 두 pane 사이에 별도 편집 권위가 생기지 않는다.
- 자식이 없는 서브 페이지의 제목에서 Enter를 누르면 session-owned
  첫 자식이 원자적으로 생성되고 Monaco caret이 그 빈 블릿으로 이동한다.

2026-07-31 실제 개발 미리보기에서도 다음을 확인했다.

- Enter, 텍스트 편집, native Undo, reload 복원
- 블릿 클릭 줌 및 뒤로가기
- Shift+블릿 클릭으로 분할 뷰 열기
- 두 pane의 즉시 동기화와 공유 Undo
- 빈 서브 페이지에서 제목과 root 블릿의 중복 제거
- `Press Enter to add another thought.` placeholder가 표시되지 않음

## 빠른 성능 표본

### 5,000개 노드 모델

실제 `ITextModel`과 메타데이터 timeline을 사용하는 deterministic
테스트에서 5,000개 노드에 다음 작업을 수행했다.

| 작업 | 결과 |
|---|---:|
| 같은 줄 텍스트 수정 | 200회 |
| 중간 줄 분할 | 100회 |
| 최종 모델 줄 수 | 5,100 |
| 전체 모델 교체 | 0회 |
| 한 edit에서 decoration 재계산한 최대 줄 | 3줄 |
| 해당 테스트 실행 시간 | 약 1.7초 |

이 테스트는 300번의 편집에 대해 전체 텍스트 재생성이나 `setValue`가
없음을 보장한다. 다만 standalone editor, keyboard pipeline, layout,
paint를 거치지 않고 `ITextModel`에 직접 edit를 적용하는 core 회귀
테스트다. 테스트 시간에는 Windows 개발 환경의 Monaco 모듈 로딩과
renderer 비용이 포함되지 않는다.

### 실제 미리보기 입력

개발 전용 probe로 Monaco의 50회 연속 좌측 커서 이동을 표본 추출했다.
측정값은 키 이벤트부터 다음 animation frame까지의 시간이다.

| 지표 | 결과 |
|---|---:|
| p50 | 약 0.6ms |
| p95 | 약 15.3ms |
| 50ms 이상 long task | 0회 |
| 전체 모델 교체 | 0회 |

이 값은 현재 Windows 개발 장비의 빠른 표본이며 정식 장비군 벤치마크나
콜드 스타트 수치는 아니다. 1개 노드 페이지에서 cursor pipeline을
표본 추출한 값이며, 5,000개 노드 renderer·scroll·memory·secondary
pane p95 승인 근거는 아직 아니다. 반복 가능한 deterministic core
테스트와 실제 renderer 표본을 함께 사용해 퇴행을 감시한다. 계측
모듈은 개발 서버의 virtual module에서만 연결되며 production asset과
loader graph에는 포함되지 않는다.

## 번들 비교

Production Vite build 기준이다.

| Asset | React 기준 | 권위형 Monaco |
|---|---:|---:|
| query-free 초기 editable JS | 295.93KB raw / 89.99KB gzip | 295,983B raw / 90,313B gzip |
| Monaco lazy JS | 없음 | 2,543,329B raw / 647,103B gzip |
| Monaco CSS | 없음 | 74,223B raw / 11,695B gzip |
| editor worker | 없음 | 281,292B raw |
| 개발 성능 probe | 없음 | production graph에 없음 |

초기 editable graph는 300KB raw / 90KB gzip 예산 검사를 통과한다.
Monaco와 worker는 텍스트 아웃라이너를 실제로 열 때만 로드된다.
React fallback row와 내보내기 UI도 실제 사용 시점에 지연 로드된다.
따라서 shell 초기 실행 비용은 거의 유지되지만, 첫 Monaco 진입에는
큰 lazy chunk의 다운로드·parse·메모리 비용이 추가된다.

## 현재 React 아웃라이너와의 차이

| 영역 | React 아웃라이너 | Monaco 권위형 텍스트 페이지 |
|---|---|---|
| 편집 권위 | store draft와 row textarea | 한 페이지의 canonical Monaco model |
| 렌더링 | visible node별 React row | Monaco 가상화 line renderer |
| Enter/Backspace/커서 | 제품 key handler | Monaco native 편집 |
| Undo/Redo | Yonalist interaction history | 텍스트·구조는 Monaco native stack |
| 분할 뷰 | pane별 row tree | 두 editor가 같은 모델을 공유 |
| 줌 | zoom root 아래 React row만 표시 | hidden area로 같은 모델의 subtree만 표시 |
| 블릿 | 제품 DOM | 모델 밖 injected decoration |
| 이미지·첨부 메모 | 지원 | 해당 페이지 전체를 React로 fallback |
| 멀티 블릿 선택·이동 | 지원 | 아직 React fallback 경로에서만 지원 |
| cross-pane drag/drop | 지원 | 아직 React fallback 경로에서만 지원 |
| 접근성 DOM | list/row semantics | Monaco code editor semantics |
| 초기 번들 | 작은 custom editor | shell은 유사, 첫 편집 때 Monaco lazy 비용 |

바깥 shell, 레이아웃 수치, 글꼴, 색, 제목과 블릿 간격은 기존 CSS
토큰을 유지했고 본문 font/line-height도 React row와 같은 16px/25px로
맞췄다. 다만 caret, selection, IME 보조 DOM과 줄 wrapping은 Monaco
renderer가 소유하므로 내부 DOM까지 React 버전과 동일하지는 않다.

## 2026-07-31 계층형 성능 최적화 증거

### 측정 대상과 환경

- 동작 후보: `fdea5bf` (`perf(monaco): window pane bullet decorations`)
- 동일 working tree의 계측 브리지: `7cdf32f`
- 전체 frontend gate 기준: `ff2b3d3`
- 비교 v2 core: `codex/yonalist-v2-core@c6873a5`
- 운영체제: Windows 11 Enterprise 10.0.26200, 64-bit
- CPU / 메모리: AMD Ryzen 9 9950X, 125.6 GiB
- Node / npm: v24.18.0 / 11.16.0
- 브라우저: 같은 장비의 Chromium 기반 앱 미리보기와 로그인된 Chrome

새 계측기는 `benchmark=monaco`인 개발 서버에서만 연결된다. 최초 세
프레임을 버리고 정확히 31개 표본을 한 번 발행한 뒤 key/model/cursor
listener와 long-task observer를 해제한다. production build에서는 계측
global, DOM marker, 구현 심벌이 모두 검색되지 않았다.

### 키 입력에서 다음 프레임까지

| 작업 | 1차 median / p95 | 2차 median / p95 | long task | `setValue` | 표본 source |
|---|---:|---:|---:|---:|---|
| Enter | 10.6 / 14.0ms | 4.5 / 11.4ms | 0 / 0 | 0 / 0 | model 31 / 31 |
| Backspace | 7.5 / 14.9ms | 6.7 / 14.9ms | 0 / 0 | 0 / 0 | keydown 31 / 31 |
| ArrowDown | 7.5 / 15.0ms | 8.2 / 15.2ms | 0 / 0 | 0 / 0 | keydown 31 / 31 |

모든 p95가 20ms 기준 안이고 50ms 이상 long task와 전체 모델 교체는
없었다. 2차 p95 변화는 Enter -18.6%, Backspace 0%, ArrowDown +1.3%다.

Chrome 제어기의 EditContext 텍스트 입력은 Enter를 Monaco keydown으로
전달하지 않고 model change를 직접 발생시킨다. 따라서 Enter 수치는
명시적으로 model-change-to-frame이며, 사용자가 누른 실제 Enter의
keydown-to-frame 수치라고 과장하지 않는다. Backspace와 ArrowDown은
keydown-to-frame이다. 두 차수는 같은 Vite 프로세스의 warm cache를
썼지만 editor를 reload해 새로 만들었다. 그러므로 동일 editor 수명에서
31개 표본을 재무장해 비교한다는 계획 항목은 아직 충족하지 않았다.

원시 표본은 다음과 같다.

```text
Enter 1: [11.2,10.7,10.6,10.6,11.3,9.7,4.2,4.3,6,6.3,7.5,8.6,8.9,9.8,11.1,10,10.4,11.3,10.8,10.4,9.6,10.2,11.2,13.7,14.1,12.9,12.8,13.4,14,13.9,6.9]
Enter 2: [11.6,11.4,11,11.4,11.1,9.8,4.1,4.5,4.2,4.7,4.4,4.3,4.3,4.2,4.1,4.2,4.2,4.5,4.1,4.2,4.1,4.3,4.1,3.8,4.6,4.9,5.5,7,8.4,9.2,10.3]
Backspace 1: [1.5,3.5,8.1,10.7,14.5,3.3,5.7,8.4,13.3,2.8,1.3,4,7.5,11.1,14.9,3.6,7.2,11.1,14.5,3.3,6.3,9.7,14.3,2.9,6.2,10.9,14.9,4.4,8.4,13.5,2.3]
Backspace 2: [2.6,7.3,12.4,2.1,3.6,6.7,10.9,14.9,3,5.6,9.3,15,4.4,8.2,12.9,2.5,5.6,10.6,14.7,4.1,8,13,1.9,3.1,7.3,13,1.9,2.8,6.6,11.7,1.7]
ArrowDown 1: [10.4,11.8,1.3,3.8,8.3,13.8,3.5,8,13.1,2.3,6.5,11.7,2.4,7.5,14.1,5,10.6,15.1,5.4,11.4,1.8,5.7,12,1.7,6.2,11.9,1.8,4.7,10.7,15,4.7]
ArrowDown 2: [15.1,3.2,1.8,5.3,9,13.3,2.1,5,10.5,1.1,4.7,10.2,15.1,3.5,6.9,12.8,3,7.7,13.1,3.3,9.1,15.2,5.8,11.1,15.1,5,10.5,15.2,4.2,8.2,13.5]
```

### 편집 준비와 방향성 비교

warm reload 31회는 navigation start에서 session/editor 생성 뒤 계측기가
연결된 시점까지 측정했다. median 397.4ms, p95 485.4ms로 목표
median 530ms 이하이며, 이전 Monaco median 665ms보다 40.2% 줄었다.
원시 표본은 다음과 같다.

```text
[392.3,406.3,397.8,406.8,398.1,385.6,396.6,395.3,399.2,398.5,399.2,394.1,391.6,385.7,383.8,399.5,400.5,385.4,400.4,395,395,419.6,407.8,503.5,485.4,397.4,393.5,388.8,400.5,394.2,394.1]
```

아래 값은 브라우저 제어 왕복까지 포함한 빠른 3회 표본의 중앙값이다.
정밀 key-to-frame 값이 아니라 같은 장비에서의 방향성 비교다.

| 대상 | Enter ×20 | ArrowDown ×40 |
|---|---:|---:|
| 최적화 Monaco | 522ms `[487,522,539]` | 615ms `[562,615,663]` |
| 최신 v2 core | 597ms `[661,577,597]` | 743ms `[563,743,778]` |
| 로그인된 Workflowy | 533ms `[633,533,481]` | 651ms `[684,618,651]` |

이 표본에서 Monaco는 최신 v2 core보다 Enter 12.6%, ArrowDown 17.2%
짧았다. Workflowy와는 각각 2.1%, 5.5% 짧았지만 원격 서비스 상태와
브라우저 제어 오버헤드가 섞인 값이므로 제품 우열 근거로 사용하지 않는다.

### 수명·렌더 범위·번들 검증

- session과 pane 진단 카운터는 반복 acquire/release 뒤 기준값으로
  돌아왔고, metadata timeline은 보존된 Undo 분기를 제외한 이전 버전을
  정리한다.
- 블릿 decoration은 pane의 visible range 전후 한 viewport만 소유한다.
  개발 미리보기에서 Enter 50회, Backspace 25회와 scroll 뒤에도 화면의
  블릿 21개와 native edit focus가 안정적으로 유지됐다.
- 초기 JS는 295,983B raw / 90,313B gzip으로 300KB / 90KB 예산 안이다.
- Monaco lazy JS는 2,543,329B raw / 647,103B gzip, CSS는
  74,223B raw / 11,695B gzip, worker는 281,292B raw다.
- Task 3의 교정된 기준보다 lazy JS 증가는 1,653B raw / 427B gzip,
  약 0.07%로 허용 범위다.

최종 frontend gate는 `npm test` 4,581건 통과(27건 skip),
`npm run lint:v2`, `npm run v2:build`, `git diff --check` 모두 통과했다.
Monaco upstream 패키지에 빠진 source map 경고 두 건은 남지만 테스트와
production build 실패는 아니다. 이 변경은 Rust, SQLite, IPC, native
설정을 바꾸지 않아 계획대로 Cargo, rustfmt, Clippy는 실행하지 않았다.

## 후속 판단

텍스트 편집의 지연과 상태 경합을 줄이는 목적에는 권위형 Monaco 구조가
유효하다. 다음 우선순위는 Monaco 안에 별도 가짜 편집 권위를 만들지
않는 조건으로 멀티 블릿 선택·이동과 cross-pane drag/drop을 editor
contribution으로 확장하는 것이다.

5,000개 노드 실제 renderer p95와 격리된 Tauri IME/close-failure 수동
증명은 이번 빠른 완료 범위에서 남은 승인 증거다. 위 수치만으로 해당
승인 조건을 충족했다고 해석하지 않는다.

이미지 노드는 Monaco model line으로 억지로 직렬화하지 않는다. overlay
widget과 view zone으로 제품 수준 편집 경험을 만들 수 있을 때까지는
페이지 단위 React fallback이 더 안전하다.
